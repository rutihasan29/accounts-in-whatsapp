const config = require('./config');

async function handleClassificationAction({
  client,
  chat,
  classificationResult,
  customerPhone,
  customerName = '',
  latestMessageText = ''
}) {
  const { classification, extracted_script, reason } = classificationResult || {};
  const cleanCustomerPhone = String(customerPhone || '').replace(/^\+/, '');
  const customerJid = cleanCustomerPhone ? `${cleanCustomerPhone.replace(/\D/g, '')}@c.us` : '';
  const namePart = customerName ? ` (${customerName})` : '';

  if (classification === 'VOICE_JOB') {
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

    // 2. Forward to VA2
    const cleanVa2 = String(config.VA2_PHONE || '8801307760509').replace(/\D/g, '');
    const va2Jid = `${cleanVa2}@c.us`;
    const scriptBody = extracted_script || latestMessageText;
    const forwardMsg = `[নতুন ভয়েস অর্ডার]\nগ্রাহক: +${cleanCustomerPhone}${namePart}\n\nস্ক্রিপ্ট:\n${scriptBody}`;

    let delivered = false;
    if (client && typeof client.sendMessage === 'function') {
      try {
        await client.sendMessage(va2Jid, forwardMsg);
        delivered = true;
        console.log(`[DISPATCH] Voice job forwarded to VA2 (+${cleanVa2}) for customer +${cleanCustomerPhone}`);
      } catch (err) {
        console.error('[DISPATCH] Failed forwarding to VA2:', err.message);
      }
    }

    return {
      action: 'VOICE_JOB_DISPATCHED',
      details: {
        customerPhone: cleanCustomerPhone,
        script: scriptBody,
        delivered
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

    return {
      action: 'SCRIPT_CONFIRMATION_ASKED',
      details: {
        customerPhone: cleanCustomerPhone,
        delivered
      }
    };
  }

  if (classification === 'ESCALATE') {
    const cleanVe3 = String(config.VE3_PHONE || '8801831366604').replace(/\D/g, '');
    const ve3Jid = `${cleanVe3}@c.us`;
    const escalateMsg = `[সহায়তা প্রয়োজন / Customer Escalation]\nগ্রাহক: +${cleanCustomerPhone}${namePart}\nমেসেজ: ${latestMessageText}\nকারণ: ${reason || 'Uncertain intent'}`;

    let delivered = false;
    if (client && typeof client.sendMessage === 'function') {
      try {
        await client.sendMessage(ve3Jid, escalateMsg);
        delivered = true;
        console.log(`[DISPATCH] Escalation alert sent to VE3 (+${cleanVe3}) for customer +${cleanCustomerPhone}`);
      } catch (err) {
        console.error('[DISPATCH] Failed sending escalation alert to VE3:', err.message);
      }
    }

    return {
      action: 'ESCALATED_TO_VE3',
      details: {
        customerPhone: cleanCustomerPhone,
        reason,
        delivered
      }
    };
  }

  return { action: 'NO_ACTION_REQUIRED', details: { classification, delivered: false } };
}

module.exports = {
  handleClassificationAction
};
