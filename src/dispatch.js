const config = require('./config');
const { createVoiceJobOrder } = require('./db');
const { extractHeadline } = require('./audio');

const pendingConfirmations = new Map();

function cancelPendingConfirmation(customerPhone) {
  const cleanPhone = String(customerPhone || '').replace(/\D/g, '');
  if (!cleanPhone) return false;
  const existing = pendingConfirmations.get(cleanPhone);
  if (existing) {
    if (existing.timer) clearTimeout(existing.timer);
    pendingConfirmations.delete(cleanPhone);
    return true;
  }
  return false;
}

function schedulePendingConfirmation({
  client,
  customerPhone,
  customerName = '',
  script = '',
  customerScriptMsgId = null,
  timeoutMs = config.SCRIPT_TIMEOUT_MS || 5 * 60 * 1000
}) {
  const cleanPhone = String(customerPhone || '').replace(/\D/g, '');
  if (!cleanPhone) return null;

  cancelPendingConfirmation(cleanPhone);

  const cleanVe3 = String(config.VE3_PHONE || '8801831366604').replace(/\D/g, '');
  const ve3Jid = `${cleanVe3}@c.us`;
  const namePart = customerName ? ` (${customerName})` : '';
  const timeoutMinutes = Math.round(timeoutMs / 60000) || 5;

  const timer = setTimeout(async () => {
    if (!pendingConfirmations.has(cleanPhone)) return;
    pendingConfirmations.delete(cleanPhone);

    const alertMsg = `[অপেক্ষমান স্ক্রিপ্ট - উত্তর নেই / Unanswered Script Alert]\nগ্রাহক: +${cleanPhone}${namePart}\nস্ক্রিপ্ট:\n${script}\n\nঅবস্থা: গ্রাহককে 'শুধু ভয়েস?' জিজ্ঞেস করার ${timeoutMinutes} মিনিট পার হলেও কোনো উত্তর আসেনি।`;

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
    askedAt: Date.now()
  };
  pendingConfirmations.set(cleanPhone, record);
  return record;
}

function getPendingConfirmation(customerPhone) {
  const cleanPhone = String(customerPhone || '').replace(/\D/g, '');
  return pendingConfirmations.get(cleanPhone) || null;
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

  if (classification === 'VOICE_JOB') {
    cancelPendingConfirmation(cleanCustomerPhone);

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
    const scriptBody = extracted_script || latestMessageText;
    const forwardMsg = `[নতুন ভয়েস অর্ডার]\n\nস্ক্রিপ্ট:\n${scriptBody}`;

    let delivered = false;
    let sentMsg = null;
    if (client && typeof client.sendMessage === 'function') {
      try {
        sentMsg = await client.sendMessage(va2Jid, forwardMsg);
        delivered = true;
        console.log(`[DISPATCH] Voice job forwarded to VA2 (+${cleanVa2}) for customer +${cleanCustomerPhone}`);
      } catch (err) {
        console.error('[DISPATCH] Failed forwarding to VA2:', err.message);
      }
    }

    const va2ForwardMsgId = sentMsg?.id?._serialized || sentMsg?.id?.id || (typeof sentMsg?.id === 'string' ? sentMsg.id : null);
    const headline = typeof extractHeadline === 'function' ? extractHeadline(scriptBody) : 'ভয়েস স্ক্রিপ্ট';

    let order = null;
    if (db) {
      try {
        order = createVoiceJobOrder(db, {
          customerPhone: cleanCustomerPhone,
          customerName,
          customerScriptMsgId,
          va2ForwardMsgId,
          scriptText: scriptBody,
          headline
        });
      } catch (err) {
        console.warn('[DISPATCH] Failed creating voice job order in db:', err.message);
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
    let delivered = false;
    if (chat && typeof chat.sendMessage === 'function') {
      try {
        await chat.sendMessage('শুধু ভয়েস? ');
        delivered = true;
        console.log(`[DISPATCH] Sent "শুধু ভয়েস? " to customer +${cleanCustomerPhone}`);
      } catch (err) {
        console.warn('[DISPATCH] Error sending confirmation question:', err.message);
      }
    } else if (customerJid && client && typeof client.sendMessage === 'function') {
      try {
        await client.sendMessage(customerJid, 'শুধু ভয়েস? ');
        delivered = true;
        console.log(`[DISPATCH] Sent fallback "শুধু ভয়েস? " to customer +${cleanCustomerPhone}`);
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
      timeoutMs
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
    cancelPendingConfirmation(cleanCustomerPhone);

    const cleanVe3 = String(config.VE3_PHONE || '8801831366604').replace(/\D/g, '');
    const ve3Jid = `${cleanVe3}@c.us`;
    const messageBody = latestMessageText || extracted_script || '<মিডিয়া ফাইল / Media attached>';
    const scriptPart = (extracted_script && extracted_script !== messageBody)
      ? `\nস্ক্রিপ্ট:\n${extracted_script}`
      : '';
    const escalateMsg = `[ভিডিও গ্রাহকের বার্তা / Video Customer Message]\nগ্রাহক: +${cleanCustomerPhone}${namePart}\nবিভাগ: ভিডিও গ্রাহক (Video Customer)\nমেসেজ / স্ক্রিপ্ট:\n${messageBody}${scriptPart}\nকারণ: ${reason || 'ভিডিও গ্রাহক—কোনো প্রশ্ন ছাড়াই সরাসরি ভিডিও এডিটর (VE3) কে ফরোয়ার্ড করা হয়েছে।'}`;

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
        reason: reason || 'Video customer direct escalation'
      }
    };
  }

  // Any message other than VOICE_JOB, SCRIPT_PENDING_CONFIRMATION, or VIDEO_CUSTOMER
  // is escalated to VE3 (voice affirmation is the only non-escalated path besides new script).
  cancelPendingConfirmation(cleanCustomerPhone);

  const cleanVe3 = String(config.VE3_PHONE || '8801831366604').replace(/\D/g, '');
  const ve3Jid = `${cleanVe3}@c.us`;
  const header = classification === 'OTHER'
    ? '[গ্রাহকের বার্তা / Customer Message]'
    : '[সহায়তা প্রয়োজন / Customer Escalation]';
  const messageBody = latestMessageText || '<মিডিয়া ফাইল / Media attached>';
  const scriptPart = extracted_script ? `\nঅপেক্ষমান স্ক্রিপ্ট:\n${extracted_script}\n` : '';
  const escalateMsg = `${header}\nগ্রাহক: +${cleanCustomerPhone}${namePart}\nমেসেজ: ${messageBody}${scriptPart}\nকারণ: ${reason || (classification === 'OTHER' ? 'General inquiry/Other' : 'Non-voice message')}`;

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
  clearAllPendingConfirmations
};