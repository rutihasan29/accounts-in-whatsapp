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
  const namePart = customerName ? ` (${customerName})` : '';

  if (classification === 'VOICE_JOB') {
    // 1. Reply "ওকে" to customer
    if (chat && typeof chat.sendMessage === 'function') {
      try {
        await chat.sendMessage('ওকে');
      } catch (err) {
        console.warn('[DISPATCH] Error replying OK to customer:', err.message);
      }
    }

    // 2. Forward to VA2
    const va2Jid = `${config.VA2_PHONE}@c.us`;
    const scriptBody = extracted_script || latestMessageText;
    const forwardMsg = `[নতুন ভয়েস অর্ডার]\nগ্রাহক: +${customerPhone}${namePart}\n\nস্ক্রিপ্ট:\n${scriptBody}`;

    if (client && typeof client.sendMessage === 'function') {
      try {
        await client.sendMessage(va2Jid, forwardMsg);
        console.log(`[DISPATCH] Voice job forwarded to VA2 (+${config.VA2_PHONE}) for customer +${customerPhone}`);
      } catch (err) {
        console.error('[DISPATCH] Failed forwarding to VA2:', err.message);
      }
    }

    return { action: 'VOICE_JOB_DISPATCHED', details: { customerPhone, script: scriptBody } };
  }

  if (classification === 'SCRIPT_PENDING_CONFIRMATION') {
    if (chat && typeof chat.sendMessage === 'function') {
      try {
        await chat.sendMessage('শুধু ভয়েস? ');
        console.log(`[DISPATCH] Sent "শুধু ভয়েস? " to customer +${customerPhone}`);
      } catch (err) {
        console.warn('[DISPATCH] Error sending confirmation question:', err.message);
      }
    }
    return { action: 'SCRIPT_CONFIRMATION_ASKED', details: { customerPhone } };
  }

  if (classification === 'ESCALATE') {
    const ve3Jid = `${config.VE3_PHONE}@c.us`;
    const escalateMsg = `[সহায়তা প্রয়োজন / Customer Escalation]\nগ্রাহক: +${customerPhone}${namePart}\nমেসেজ: ${latestMessageText}\nকারণ: ${reason || 'Uncertain intent'}`;

    if (client && typeof client.sendMessage === 'function') {
      try {
        await client.sendMessage(ve3Jid, escalateMsg);
        console.log(`[DISPATCH] Escalation alert sent to VE3 (+${config.VE3_PHONE}) for customer +${customerPhone}`);
      } catch (err) {
        console.error('[DISPATCH] Failed sending escalation alert to VE3:', err.message);
      }
    }

    return { action: 'ESCALATED_TO_VE3', details: { customerPhone, reason } };
  }

  return { action: 'NO_ACTION_REQUIRED', details: { classification } };
}

module.exports = {
  handleClassificationAction
};
