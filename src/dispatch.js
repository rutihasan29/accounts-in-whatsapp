const config = require('./config');
const {
  createVoiceJobOrder,
  updateVoiceJobVa2ForwardMsgId,
  getBotSetting,
  savePendingConfirmation,
  getPendingConfirmationFromDb,
  removePendingConfirmationFromDb,
  getAllPendingConfirmationsFromDb
} = require('./db');
const { extractHeadline } = require('./audio');
const { isServiceInquiryOnly } = require('./classifier');

const pendingConfirmations = new Map();

function cancelPendingConfirmation(customerPhone, db = null) {
  const cleanPhone = String(customerPhone || '').replace(/\D/g, '');
  if (!cleanPhone) return false;
  let deleted = false;
  const existing = pendingConfirmations.get(cleanPhone);
  if (existing) {
    if (existing.timer) clearTimeout(existing.timer);
    pendingConfirmations.delete(cleanPhone);
    deleted = true;
  }
  if (db) {
    const dbDeleted = removePendingConfirmationFromDb(db, cleanPhone);
    if (dbDeleted) deleted = true;
  }
  return deleted;
}

function schedulePendingConfirmation({
  client,
  customerPhone,
  customerName = '',
  script = '',
  customerScriptMsgId = null,
  timeoutMs = config.SCRIPT_TIMEOUT_MS || 5 * 60 * 1000,
  db = null
}) {
  const cleanPhone = String(customerPhone || '').replace(/\D/g, '');
  if (!cleanPhone) return null;

  cancelPendingConfirmation(cleanPhone, db);

  const askedAt = Date.now();
  if (db) {
    savePendingConfirmation(db, {
      customerPhone: cleanPhone,
      script,
      customerName,
      customerScriptMsgId,
      timeoutMs,
      askedAt
    });
  }

  const cleanVe3 = String(config.VE3_PHONE || '8801831366604').replace(/\D/g, '');
  const ve3Jid = `${cleanVe3}@c.us`;
  const namePart = customerName ? ` (${customerName})` : '';
  const timeoutMinutes = Math.round(timeoutMs / 60000) || 5;

  const timer = setTimeout(async () => {
    if (!pendingConfirmations.has(cleanPhone)) return;
    pendingConfirmations.delete(cleanPhone);
    if (db) {
      removePendingConfirmationFromDb(db, cleanPhone);
    }

    const ve3Enabled = getBotSetting(db, 've3_escalation_enabled', true);
    if (!ve3Enabled) {
      console.log(`[DISPATCH] VE3 escalation alerts disabled via bot settings. Skipping timeout alert for +${cleanPhone}.`);
      return;
    }

    const alertMsg = `${script}\n\n+${cleanPhone}${namePart}\nকারণ: 'ভয়েস?' এর কোনো উত্তর আসেনি (${timeoutMinutes} মিনিট)`;

    if (client && typeof client.sendMessage === 'function') {
      try {
        await client.sendMessage(ve3Jid, alertMsg);
        console.log(`[DISPATCH] ${timeoutMinutes}-minute timeout reached with no reply from +${cleanPhone}. Unanswered script alert sent to VE3 (+${cleanVe3}).`);
      } catch (err) {
        console.error('[DISPATCH] Failed sending unanswered script alert to VE3:', err.message);
      }
    }
  }, timeoutMs);

  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }

  const record = {
    timer,
    script,
    customerName,
    customerPhone: cleanPhone,
    customerScriptMsgId,
    timeoutMs,
    askedAt
  };
  pendingConfirmations.set(cleanPhone, record);
  return record;
}

function getPendingConfirmation(customerPhone, db = null) {
  const cleanPhone = String(customerPhone || '').replace(/\D/g, '');
  if (!cleanPhone) return null;
  let record = pendingConfirmations.get(cleanPhone) || null;
  if (!record && db) {
    const dbRecord = getPendingConfirmationFromDb(db, cleanPhone);
    if (dbRecord) {
      record = dbRecord;
      pendingConfirmations.set(cleanPhone, record);
    }
  }
  return record;
}

function restorePendingConfirmations({ client, db }) {
  if (!db) return 0;
  const activeRecords = getAllPendingConfirmationsFromDb(db);
  const now = Date.now();
  let count = 0;
  for (const item of activeRecords) {
    const elapsed = now - item.askedAt;
    const remainingMs = Math.max(1000, item.timeoutMs - elapsed);
    schedulePendingConfirmation({
      client,
      customerPhone: item.customerPhone,
      customerName: item.customerName,
      script: item.script,
      customerScriptMsgId: item.customerScriptMsgId,
      timeoutMs: remainingMs,
      db
    });
    count++;
  }
  return count;
}

function clearAllPendingConfirmations() {
  for (const record of pendingConfirmations.values()) {
    if (record.timer) clearTimeout(record.timer);
  }
  pendingConfirmations.clear();
}

async function handleClassificationAction({
  client,
  chat,
  classificationResult,
  customerPhone,
  customerName = '',
  latestMessageText = '',
  timeoutMs = undefined,
  db = null,
  customerScriptMsgId = null
}) {
  const { classification, extracted_script, reason } = classificationResult || {};
  const cleanCustomerPhone = String(customerPhone || '').replace(/\D/g, '');
  const customerJid = cleanCustomerPhone ? `${cleanCustomerPhone}@c.us` : '';
  const namePart = customerName ? ` (${customerName})` : '';

  // Never process, escalate, or reply to WhatsApp groups or broadcast lists
  if (
    !cleanCustomerPhone ||
    cleanCustomerPhone.startsWith('120363') ||
    String(customerPhone || '').includes('@g.us') ||
    chat?.isGroup === true
  ) {
    console.log(`[DISPATCH] Group detected (${customerPhone || cleanCustomerPhone}). Ignoring dispatch and suppressing escalation.`);
    return { action: 'IGNORED_GROUP' };
  }

  if (classification === 'VOICE_JOB') {
    if (classificationResult?.is_news_script === false) {
      console.log(`[DISPATCH] Ignoring voice job for customer +${cleanCustomerPhone} because text is not a news script.`);
      return { action: 'IGNORED_NON_NEWS_SCRIPT' };
    }
    cancelPendingConfirmation(cleanCustomerPhone, db);

    const scriptBody = (extracted_script || latestMessageText || '').trim();

    // Guard: A voice job MUST contain an actual script to record.
    // If the extracted text is only a service inquiry (e.g. "নিউজ ভয়েস লাগবে", "ভয়েস লাগবে", "নিউজ ভয়েস", "voice lagbe")
    // without any actual narration/content, do NOT forward a blank order to VA2!
    if (isServiceInquiryOnly(scriptBody)) {
      console.log(`[DISPATCH] Customer +${cleanCustomerPhone} requested voice service without an actual script ("${scriptBody}"). Prompting for script instead of forwarding to VA2.`);
      const promptText = 'জি, আপনার স্ক্রিপ্টটি এখানে লিখে বা পেস্ট করে পাঠিয়ে দিন।';
      if (chat && typeof chat.sendMessage === 'function') {
        try {
          await chat.sendMessage(promptText);
        } catch (err) {
          console.warn('[DISPATCH] Error asking customer for script:', err.message);
        }
      } else if (customerJid && client && typeof client.sendMessage === 'function') {
        try {
          await client.sendMessage(customerJid, promptText);
        } catch (err) {
          console.warn('[DISPATCH] Error asking customer for script fallback:', err.message);
        }
      }
      return {
        action: 'PROMPTED_FOR_SCRIPT',
        details: { customerPhone: cleanCustomerPhone, inquiryText: scriptBody }
      };
    }

    // Deduplication check: Has this exact script already been ordered/forwarded for this customer recently?
    if (db && cleanCustomerPhone && scriptBody) {
      try {
        const recentOrder = db.prepare(`
          SELECT order_id, status, created_at FROM voice_job_orders
          WHERE customer_phone = ? 
            AND status IN ('PENDING_VA2', 'RECORDING', 'DELIVERED')
            AND script_text = ?
            AND created_at >= datetime('now', '-30 minutes')
          ORDER BY id DESC LIMIT 1
        `).get(cleanCustomerPhone, scriptBody);

        if (recentOrder && recentOrder.order_id) {
          console.log(`[DISPATCH] Order ${recentOrder.order_id} already exists for customer +${cleanCustomerPhone} with this script. Skipping duplicate forwarding to VA2.`);
          cancelPendingConfirmation(cleanCustomerPhone, db);
          return {
            action: 'IGNORED_DUPLICATE_VOICE_JOB',
            details: {
              orderId: recentOrder.order_id,
              customerPhone: cleanCustomerPhone,
              script: scriptBody
            }
          };
        }
      } catch (dedupErr) {
        console.warn('[DISPATCH] Error checking duplicate order:', dedupErr.message);
      }
    }

    // 1. Reply "ওকে" to customer
    if (chat && typeof chat.sendMessage === 'function') {
      try {
        await chat.sendMessage('ওকে');
      } catch (err) {
        console.warn('[DISPATCH] Error replying OK to customer:', err.message);
      }
    } else if (customerJid && client && typeof client.sendMessage === 'function') {
      try {
        await client.sendMessage(customerJid, 'ওকে');
      } catch (err) {
        console.warn('[DISPATCH] Error replying OK to customer fallback:', err.message);
      }
    }

    // 2. Forward to VA2 (Strict rule: NEVER send customer phone number OR name to VA2; strictly script only)
    const cleanVa2 = String(config.VA2_PHONE || '8801307760509').replace(/\D/g, '');
    const va2Jid = `${cleanVa2}@c.us`;
    const headline = typeof extractHeadline === 'function' ? extractHeadline(scriptBody) : 'ভয়েস স্ক্রিপ্ট';
    const orderId = `VJO-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

    let order = null;
    if (db) {
      try {
        order = createVoiceJobOrder(db, {
          orderId,
          customerPhone: cleanCustomerPhone,
          customerName,
          customerScriptMsgId,
          va2ForwardMsgId: null,
          scriptText: scriptBody,
          headline
        });
      } catch (err) {
        console.warn('[DISPATCH] Failed creating voice job order in db:', err.message);
      }
    }

    const forwardMsg = `[নতুন ভয়েস অর্ডার #${order?.order_id || orderId}]\n\nস্ক্রিপ্ট:\n${scriptBody}`;

    let delivered = false;
    let sentMsg = null;
    if (client && typeof client.sendMessage === 'function') {
      try {
        sentMsg = await client.sendMessage(va2Jid, forwardMsg, { waitUntilMsgSent: true });
        delivered = true;
        console.log(`[DISPATCH] Voice job forwarded to VA2 (+${cleanVa2}) for customer +${cleanCustomerPhone}`);
      } catch (err) {
        console.error('[DISPATCH] Failed forwarding to VA2:', err.message);
      }
    }

    const va2ForwardMsgId = sentMsg?.id?._serialized || sentMsg?.id?.id || (typeof sentMsg?.id === 'string' ? sentMsg.id : null);
    if (db && va2ForwardMsgId && order) {
      try {
        updateVoiceJobVa2ForwardMsgId(db, order.order_id, va2ForwardMsgId);
      } catch (err) {
        console.warn('[DISPATCH] Failed updating va2_forward_msg_id in db:', err.message);
      }
    }

    return {
      action: 'VOICE_JOB_DISPATCHED',
      details: {
        customerPhone: cleanCustomerPhone,
        script: scriptBody,
        delivered,
        orderId: order?.order_id || null,
        va2ForwardMsgId,
        headline
      }
    };
  }

  if (classification === 'SCRIPT_PENDING_CONFIRMATION') {
    if (classificationResult?.is_news_script === false) {
      console.log(`[DISPATCH] Ignoring script confirmation for customer +${cleanCustomerPhone} because text is not a news script.`);
      return { action: 'IGNORED_NON_NEWS_SCRIPT' };
    }
    let delivered = false;
    if (chat && typeof chat.sendMessage === 'function') {
      try {
        await chat.sendMessage('ভয়েস?');
        delivered = true;
        console.log(`[DISPATCH] Sent "ভয়েস?" to customer +${cleanCustomerPhone}`);
      } catch (err) {
        console.warn('[DISPATCH] Error sending confirmation question:', err.message);
      }
    } else if (customerJid && client && typeof client.sendMessage === 'function') {
      try {
        await client.sendMessage(customerJid, 'ভয়েস?');
        delivered = true;
        console.log(`[DISPATCH] Sent fallback "ভয়েস?" to customer +${cleanCustomerPhone}`);
      } catch (err) {
        console.warn('[DISPATCH] Error sending confirmation question fallback:', err.message);
      }
    }

    // Schedule 5-minute unanswered timer to alert VE3 if no response
    const scriptBody = extracted_script || latestMessageText;
    schedulePendingConfirmation({
      client,
      customerPhone: cleanCustomerPhone,
      customerName,
      script: scriptBody,
      customerScriptMsgId,
      timeoutMs,
      db
    });

    return {
      action: 'SCRIPT_CONFIRMATION_ASKED',
      details: {
        customerPhone: cleanCustomerPhone,
        delivered
      }
    };
  }

  if (classification === 'VIDEO_CUSTOMER') {
    cancelPendingConfirmation(cleanCustomerPhone, db);

    const cleanVe3 = String(config.VE3_PHONE || '8801831366604').replace(/\D/g, '');
    const ve3Jid = `${cleanVe3}@c.us`;
    const messageBody = latestMessageText || extracted_script || '<মিডিয়া ফাইল>';
    const scriptPart = (extracted_script && extracted_script !== messageBody)
      ? `\n\n${extracted_script}`
      : '';
    const shortReason = reason ? String(reason).trim() : 'ভিডিও গ্রাহক';
    const escalateMsg = `${messageBody}${scriptPart}\n\n+${cleanCustomerPhone}${namePart}\nকারণ: ${shortReason}`;

    let delivered = false;
    if (client && typeof client.sendMessage === 'function') {
      try {
        await client.sendMessage(ve3Jid, escalateMsg);
        delivered = true;
        console.log(`[DISPATCH] Video customer message forwarded to VE3 (+${cleanVe3}) for customer +${cleanCustomerPhone}`);
      } catch (err) {
        console.error('[DISPATCH] Failed forwarding video customer message to VE3:', err.message);
      }
    }

    return {
      action: 'VIDEO_CUSTOMER_ESCALATED_TO_VE3',
      details: {
        customerPhone: cleanCustomerPhone,
        classification: 'VIDEO_CUSTOMER',
        delivered,
        reason: shortReason
      }
    };
  }

  // Any message other than VOICE_JOB, SCRIPT_PENDING_CONFIRMATION, or VIDEO_CUSTOMER
  // is escalated to VE3 (voice affirmation is the only non-escalated path besides new script).
  cancelPendingConfirmation(cleanCustomerPhone, db);

  const ve3Enabled = getBotSetting(db, 've3_escalation_enabled', true);
  if (!ve3Enabled) {
    console.log(`[DISPATCH] VE3 escalation alerts disabled via bot settings. Skipping alert for +${cleanCustomerPhone}.`);
    return { action: 'ESCALATION_DISABLED' };
  }

  const cleanVe3 = String(config.VE3_PHONE || '8801831366604').replace(/\D/g, '');
  const ve3Jid = `${cleanVe3}@c.us`;
  const messageBody = latestMessageText || extracted_script || '<মিডিয়া ফাইল>';
  const scriptPart = (extracted_script && extracted_script !== messageBody)
    ? `\n\n${extracted_script}`
    : '';
  const shortReason = reason ? String(reason).trim() : (classification === 'OTHER' ? 'সাধারণ বার্তা' : 'সহায়তা প্রয়োজন');
  const escalateMsg = `${messageBody}${scriptPart}\n\n+${cleanCustomerPhone}${namePart}\nকারণ: ${shortReason}`;

  let delivered = false;
  if (client && typeof client.sendMessage === 'function') {
    try {
      await client.sendMessage(ve3Jid, escalateMsg);
      delivered = true;
      console.log(`[DISPATCH] Escalation alert sent to VE3 (+${cleanVe3}) for customer +${cleanCustomerPhone} (classification: ${classification || 'ESCALATE'})`);
    } catch (err) {
      console.error('[DISPATCH] Failed sending escalation alert to VE3:', err.message);
    }
  }

  return {
    action: 'ESCALATED_TO_VE3',
    details: {
      customerPhone: cleanCustomerPhone,
      classification: classification || 'ESCALATE',
      reason,
      delivered
    }
  };
}

module.exports = {
  handleClassificationAction,
  cancelPendingConfirmation,
  schedulePendingConfirmation,
  getPendingConfirmation,
  restorePendingConfirmations,
  clearAllPendingConfirmations
};