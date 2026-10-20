const { parseMessage } = require('./parser');
const {
  recordTransaction,
  recordLead,
  updateTransactionMessageId,
  deleteTransactionByMessageId,
  getDueList,
  getCustomerSummary,
  migrateCustomerPhone
} = require('./db');
const {
  isAudioDocumentMessage,
  isVideoDocumentMessage,
  getAudioDurationFromBuffer,
  formatAudioDuration,
  calculateAudioBill,
  formatBillMessage,
  resolveAudioDuration
} = require('./audio');
const { sendWelcomeDemo } = require('./welcome');
const qrcode = require('qrcode-terminal');

// Track auto-sent bill messages to prevent duplicate ledger entries on message_create echo
const sentAutoBillMsgIds = new Set();
const pendingAutoBills = [];
const recentOutboundJobTypes = new Map();

const DIGITS_TO_BENGALI = {
  '0': '০', '1': '১', '2': '২', '3': '৩', '4': '৪',
  '5': '৫', '6': '৬', '7': '৭', '8': '৮', '9': '৯'
};

function toBengaliDigits(num) {
  return String(num).replace(/\d/g, (d) => DIGITS_TO_BENGALI[d] || d);
}

function formatDueReport(dueList) {
  if (!dueList || dueList.length === 0) {
    return '✅ বর্তমানে কোনো গ্রাহকের বকেয়া নেই!';
  }

  let totalDue = 0;
  const lines = dueList.map((item, index) => {
    totalDue += item.due_amount;
    const namePart = item.name ? ` (${item.name})` : '';
    const bengaliIdx = toBengaliDigits(index + 1);
    const bengaliAmount = toBengaliDigits(item.due_amount);
    return `${bengaliIdx}. ${item.phone_number}${namePart}: ${bengaliAmount} টাকা`;
  });

  totalDue = Math.round(totalDue * 100) / 100;

  const summary = [
    '📋 *বকেয়া তালিকা (Due List)*:',
    ...lines,
    '─────────────────────',
    `মোট বকেয়া: ${toBengaliDigits(totalDue)} টাকা (${toBengaliDigits(dueList.length)} জন গ্রাহক)`
  ];

  return summary.join('\n');
}

function extractUser(jid) {
  if (!jid || typeof jid !== 'string') return '';
  return jid.split('@')[0].split(':')[0].replace(/\D/g, '');
}

function getMyUser(client) {
  return (
    client?.info?.wid?.user ||
    extractUser(client?.info?.wid?._serialized) ||
    extractUser(client?.info?.me?._serialized) ||
    ''
  );
}

function isSelfChat(msg, client) {
  const myUser = getMyUser(client);
  if (!myUser) return false;

  const toUser = extractUser(msg.to);
  const remoteUser = extractUser(msg.id?.remote);
  const fromUser = extractUser(msg.from);

  // If the message is incoming (fromMe === false), it can only be a self-chat
  // if it originated from our own account (e.g. multi-device sync from phone where fromUser === myUser).
  if (msg.fromMe === false) {
    if (fromUser && fromUser !== myUser) {
      return false;
    }
    return (
      (remoteUser && remoteUser === myUser) ||
      (toUser && toUser === myUser)
    );
  }

  // When fromMe is true: it's self-chat if addressed to myself
  return (
    (remoteUser && remoteUser === myUser) ||
    (toUser && toUser === myUser)
  );
}

async function resolveCustomerPhone({ client, recipient, msg }) {
  if (!recipient || typeof recipient !== 'string') return '';

  // 1. If it's a standard @c.us or @s.whatsapp.net JID, extract phone digits directly
  if (recipient.endsWith('@c.us') || recipient.endsWith('@s.whatsapp.net')) {
    return recipient.split('@')[0].split(':')[0].replace(/\D/g, '');
  }

  // 2. Try client.getContactLidAndPhone
  if (client && typeof client.getContactLidAndPhone === 'function') {
    try {
      const res = await client.getContactLidAndPhone(recipient);
      if (Array.isArray(res) && res[0]?.pn) {
        const pn = res[0].pn.split('@')[0].split(':')[0].replace(/\D/g, '');
        if (pn) return pn;
      }
    } catch {}
  }

  // 3. Try Puppeteer in-page evaluation (direct from frontend internal stores)
  if (client?.pupPage && typeof client.pupPage.evaluate === 'function') {
    try {
      const pnFromPage = await client.pupPage.evaluate(async (targetId) => {
        try {
          const widFactory = window.require('WAWebWidFactory');
          const targetWid = widFactory.createWid(targetId);

          // Check WAWebApiContact
          const contactApi = window.require('WAWebApiContact');
          if (contactApi && typeof contactApi.getPhoneNumber === 'function') {
            const pWid = contactApi.getPhoneNumber(targetWid);
            if (pWid?.user) return pWid.user;
          }

          // Check WAWebCollections Contact
          const collections = window.require('WAWebCollections');
          if (collections?.Contact) {
            const c = collections.Contact.get(targetWid);
            if (c?.phoneNumber?.user) return c.phoneNumber.user;
          }

          // Check WAWebCollections Chat
          if (collections?.Chat) {
            const ch = collections.Chat.get(targetWid);
            if (ch?.contact?.phoneNumber?.user) return ch.contact.phoneNumber.user;
          }
        } catch {}
        return null;
      }, recipient);

      if (pnFromPage) {
        const clean = pnFromPage.replace(/\D/g, '');
        if (clean) return clean;
      }
    } catch {}
  }

  // 4. Try client.getContactById
  if (client && typeof client.getContactById === 'function') {
    try {
      const contact = await client.getContactById(recipient);
      if (contact) {
        if (contact.id?._serialized?.endsWith('@c.us')) {
          const num = contact.id._serialized.split('@')[0].split(':')[0].replace(/\D/g, '');
          if (num) return num;
        }
        if (contact.number && !contact.number.includes('@lid')) {
          const num = contact.number.replace(/\D/g, '');
          if (num) return num;
        }
      }
    } catch {}
  }

  // 5. Try msg.getContact()
  if (msg && typeof msg.getContact === 'function') {
    try {
      const contact = await msg.getContact();
      if (contact?.id?._serialized?.endsWith('@c.us')) {
        const num = contact.id._serialized.split('@')[0].split(':')[0].replace(/\D/g, '');
        if (num) return num;
      }
      if (contact?.number && !contact.number.includes('@lid')) {
        const num = contact.number.replace(/\D/g, '');
        if (num) return num;
      }
    } catch {}
  }

  // 6. Try msg.getChat()
  if (msg && typeof msg.getChat === 'function') {
    try {
      const chat = await msg.getChat();
      if (chat?.contact?.number && !chat.contact.number.includes('@lid')) {
        const num = chat.contact.number.replace(/\D/g, '');
        if (num) return num;
      }
      if (chat?.id?._serialized?.endsWith('@c.us')) {
        const num = chat.id._serialized.split('@')[0].split(':')[0].replace(/\D/g, '');
        if (num) return num;
      }
    } catch {}
  }

  // Fallback: stripped recipient digits
  return recipient.split('@')[0].split(':')[0].replace(/\D/g, '');
}

async function handleMessageCreate({ msg, client, db }) {
  const isSelf = isSelfChat(msg, client);

  if (!msg.fromMe && !isSelf) {
    const rawSender = msg.from || msg.id?.remote || '';
    if (rawSender.endsWith('@g.us')) {
      return { action: 'IGNORED_GROUP' };
    }

    try {
      const phone = await resolveCustomerPhone({ client, recipient: rawSender, msg });
      if (phone) {
        let contactName = null;
        try {
          if (client && typeof client.getContactById === 'function') {
            const contact = await client.getContactById(rawSender);
            contactName = contact?.name || contact?.pushname || null;
          }
        } catch {}

        const leadRes = recordLead(db, { phone, name: contactName });
        if (leadRes?.status === 'NEW_LEAD') {
          console.log(`[LEAD] New lead recorded: +${phone}${contactName ? ` (${contactName})` : ''}`);
          const targetChat = msg.id?.remote || msg.from || (phone ? `${phone}@c.us` : null);
          let welcomeResult = null;
          if (targetChat) {
            const isTest = process.env.NODE_ENV === 'test' || process.argv.some(a => a.includes('test'));
            welcomeResult = await sendWelcomeDemo({
              client,
              targetChat,
              db,
              phone,
              delayMs: isTest ? 0 : 800
            });
          }
          return { action: 'RECORDED_NEW_LEAD', details: { phone, name: contactName, welcomeResult } };
        }
      }
    } catch (err) {
      console.warn('[LEAD] Error checking/recording lead:', err.message);
    }

    return { action: 'IGNORED_NOT_FROM_ME' };
  }

  const recipient = msg.to || '';
  if (recipient.endsWith('@g.us') || msg.id?.remote?.endsWith('@g.us')) {
    return { action: 'IGNORED_GROUP' };
  }

  // Handle video document sent from our side
  if (msg.fromMe && !isSelf && isVideoDocumentMessage(msg)) {
    try {
      const targetChat = msg.id?.remote || msg.to || msg.from;
      const rawRecipient = recipient || targetChat;
      const phone = await resolveCustomerPhone({ client, recipient: rawRecipient, msg });
      if (phone) {
        recentOutboundJobTypes.set(phone, { jobType: 'video', time: Date.now() });
        console.log(`[VIDEO_DISPATCH] Outbound video tracked for +${phone}`);
      }
    } catch (err) {
      console.warn('[VIDEO] Error tracking video document:', err.message);
    }
  }

  // Handle audio document sent from our side
  if (msg.fromMe && !isSelf && isAudioDocumentMessage(msg)) {
    try {
      const duration = await resolveAudioDuration({ msg, client });

      if (duration !== null && duration !== undefined && duration >= 0) {
        const billAmount = calculateAudioBill(duration);
        const billText = formatBillMessage(billAmount);
        const targetChat = msg.id?.remote || msg.to || msg.from;
        const rawRecipient = recipient || targetChat;
        const phone = await resolveCustomerPhone({ client, recipient: rawRecipient, msg });

        let contactName = null;
        try {
          if (typeof client.getContactById === 'function') {
            const contact = await client.getContactById(rawRecipient);
            contactName = contact?.name || contact?.pushname || null;
          }
        } catch {
          // Non-fatal if contact info cannot be fetched
        }

        // Auto-migrate previous transactions stored under raw recipient / LID if phone resolved to a different number
        if (phone && phone !== rawRecipient) {
          const strippedLid = rawRecipient.split('@')[0].split(':')[0].replace(/\D/g, '');
          migrateCustomerPhone(db, rawRecipient, phone);
          if (strippedLid && strippedLid !== phone) {
            migrateCustomerPhone(db, strippedLid, phone);
          }
        }

        const record = recordTransaction(db, {
          phone,
          name: contactName,
          type: 'BILL',
          amount: billAmount,
          rawText: billText,
          messageId: msg.id?._serialized || null,
          jobType: 'voice',
          durationSeconds: Math.round(duration)
        });

        console.log(`[AUDIO_BILL] Recorded voice job (${Math.round(duration)}s) bill ${billAmount} BDT for +${phone}${contactName ? ` (${contactName})` : ''}. Current due: ${record.dueAmount} BDT`);

        // Record pending auto-bill to prevent double-recording when message_create echoes
        pendingAutoBills.push({
          targetChat,
          phone,
          amount: billAmount,
          time: Date.now()
        });

        let sent = false;
        let sentMsg = null;

        if (client && typeof client.sendMessage === 'function' && targetChat) {
          try {
            sentMsg = await client.sendMessage(targetChat, billText);
            sent = true;
          } catch (err) {
            console.warn('client.sendMessage failed, falling back to msg.reply:', err.message);
          }
        }

        if (!sent && typeof msg.reply === 'function') {
          sentMsg = await msg.reply(billText);
        }

        if (sentMsg?.id?._serialized) {
          sentAutoBillMsgIds.add(sentMsg.id._serialized);
        }
        if (sentMsg?.id?.id) {
          sentAutoBillMsgIds.add(sentMsg.id.id);
        }

        const sentMessageId = sentMsg?.id?._serialized || sentMsg?.id?.id || (typeof sentMsg?.id === 'string' ? sentMsg.id : null);
        if (sentMessageId && record?.transactionId) {
          updateTransactionMessageId(db, record.transactionId, sentMessageId);
        }

        console.log(`[AUDIO] Sent bill (${billText}) to ${targetChat}`);

        return {
          action: 'SENT_AUDIO_BILL',
          details: {
            duration,
            billAmount,
            billText,
            phone,
            dueAmount: record.dueAmount,
            targetChat,
            messageId: sentMessageId,
            jobType: 'voice',
            durationSeconds: Math.round(duration)
          }
        };
      } else {
        console.warn('[AUDIO] Could not determine audio duration for message media');
        return { action: 'IGNORED_AUDIO_NO_DURATION' };
      }
    } catch (err) {
      console.error('[AUDIO] Error processing audio document:', err);
      return { action: 'ERROR_AUDIO_PROCESSING', error: err.message };
    }
  }

  // Check if message is an echo of an auto-sent bill message
  if (msg.id?._serialized && sentAutoBillMsgIds.has(msg.id._serialized)) {
    sentAutoBillMsgIds.delete(msg.id._serialized);
    if (msg.id?.id) sentAutoBillMsgIds.delete(msg.id.id);
    return { action: 'IGNORED_ECHO_AUTO_BILL' };
  }
  if (msg.id?.id && sentAutoBillMsgIds.has(msg.id.id)) {
    sentAutoBillMsgIds.delete(msg.id.id);
    return { action: 'IGNORED_ECHO_AUTO_BILL' };
  }

  const parsed = parseMessage(msg.body);

  if (!parsed) {
    return { action: 'IGNORED_UNMATCHED' };
  }

  // Handle self-chat command
  if (isSelf && parsed.type === 'COMMAND_DUE') {
    const dues = getDueList(db);
    const report = formatDueReport(dues);
    console.log(`[COMMAND_DUE] !due triggered in self-chat. Found ${dues.length} customer(s) with dues.`);

    const targetChat = msg.id?.remote || msg.to || msg.from;
    let sent = false;

    if (client && typeof client.sendMessage === 'function' && targetChat) {
      try {
        await client.sendMessage(targetChat, report);
        sent = true;
      } catch (err) {
        console.warn('client.sendMessage failed, falling back to msg.reply:', err.message);
      }
    }

    if (!sent && typeof msg.reply === 'function') {
      await msg.reply(report);
    }

    return { action: 'RESPONDED_DUE_LIST', details: { count: dues.length } };
  }

  // Handle customer transactions
  if (!isSelf && (parsed.type === 'BILL' || parsed.type === 'PAYMENT')) {
    if (parsed.type === 'BILL') {
      const now = Date.now();
      const targetChat = msg.id?.remote || msg.to || msg.from;
      const cleanPhone = recipient.replace(/@c\.us$/, '').replace(/\D/g, '');
      const pendingIndex = pendingAutoBills.findIndex(p =>
        (p.targetChat === recipient ||
         p.targetChat === targetChat ||
         p.phone === cleanPhone) &&
        p.amount === parsed.amount &&
        (now - p.time < 30000)
      );
      if (pendingIndex !== -1) {
        pendingAutoBills.splice(pendingIndex, 1);
        return { action: 'IGNORED_ECHO_AUTO_BILL' };
      }
    }

    const rawRecipient = recipient;
    const phone = await resolveCustomerPhone({ client, recipient, msg });
    let contactName = null;

    try {
      if (typeof client.getContactById === 'function') {
        const contact = await client.getContactById(recipient);
        contactName = contact?.name || contact?.pushname || null;
      }
    } catch {
      // Non-fatal if contact info cannot be fetched
    }

    // Auto-migrate previous transactions stored under raw recipient / LID if phone resolved to a different number
    if (phone && phone !== rawRecipient) {
      const strippedLid = rawRecipient.split('@')[0].split(':')[0].replace(/\D/g, '');
      migrateCustomerPhone(db, rawRecipient, phone);
      if (strippedLid && strippedLid !== phone) {
        migrateCustomerPhone(db, strippedLid, phone);
      }
    }

    let jobType = 'voice';
    if (parsed.type === 'BILL') {
      const recentJob = recentOutboundJobTypes.get(phone);
      if (recentJob && (Date.now() - recentJob.time < 30 * 60 * 1000)) {
        jobType = recentJob.jobType;
      }
    }

    const msgId = msg.id?._serialized || msg.id?.id || (typeof msg.id === 'string' ? msg.id : null);
    const record = recordTransaction(db, {
      phone,
      name: contactName,
      type: parsed.type,
      amount: parsed.amount,
      rawText: parsed.rawText,
      messageId: msgId,
      jobType: parsed.type === 'BILL' ? jobType : null
    });

    console.log(`[${parsed.type}] ${parsed.amount} BDT recorded for +${phone}${contactName ? ` (${contactName})` : ''}. Current due: ${record.dueAmount} BDT`);

    return {
      action: parsed.type === 'BILL' ? 'RECORDED_BILL' : 'RECORDED_PAYMENT',
      details: { phone, amount: parsed.amount, dueAmount: record.dueAmount, messageId: msgId }
    };
  }

  // Handle set total due (e.g. 'বকেয়া ২৩০০ টাকা')
  if (!isSelf && parsed.type === 'SET_DUE') {
    const rawRecipient = recipient;
    const phone = await resolveCustomerPhone({ client, recipient, msg });
    let contactName = null;

    try {
      if (typeof client.getContactById === 'function') {
        const contact = await client.getContactById(recipient);
        contactName = contact?.name || contact?.pushname || null;
      }
    } catch {
      // Non-fatal if contact info cannot be fetched
    }

    // Auto-migrate previous transactions stored under raw recipient / LID if phone resolved to a different number
    if (phone && phone !== rawRecipient) {
      const strippedLid = rawRecipient.split('@')[0].split(':')[0].replace(/\D/g, '');
      migrateCustomerPhone(db, rawRecipient, phone);
      if (strippedLid && strippedLid !== phone) {
        migrateCustomerPhone(db, strippedLid, phone);
      }
    }

    const summary = getCustomerSummary(db, phone);
    const currentDue = summary ? summary.due_amount : 0;
    const targetDue = parsed.amount;
    const diff = Math.round((targetDue - currentDue) * 100) / 100;

    if (diff === 0) {
      console.log(`[SET_DUE] Balance for +${phone}${contactName ? ` (${contactName})` : ''} is already ${targetDue} BDT. No adjustment needed.`);
      return {
        action: 'SET_DUE_UNCHANGED',
        details: { phone, targetDue, dueAmount: currentDue }
      };
    }

    const txType = diff > 0 ? 'BILL' : 'PAYMENT';
    const txAmount = Math.abs(diff);

    const msgId = msg.id?._serialized || msg.id?.id || (typeof msg.id === 'string' ? msg.id : null);
    const record = recordTransaction(db, {
      phone,
      name: contactName,
      type: txType,
      amount: txAmount,
      rawText: parsed.rawText,
      messageId: msgId
    });

    console.log(`[SET_DUE] Total due for +${phone}${contactName ? ` (${contactName})` : ''} set to ${targetDue} BDT (previous: ${currentDue} BDT, adjusted ${txType}: ${txAmount} BDT). Current due: ${record.dueAmount} BDT`);

    return {
      action: 'SET_DUE_ADJUSTED',
      details: {
        phone,
        targetDue,
        adjustmentType: txType,
        adjustmentAmount: txAmount,
        previousDue: currentDue,
        dueAmount: record.dueAmount,
        messageId: msgId
      }
    };
  }

  return { action: 'IGNORED_OTHER' };
}

function getCandidateMessageIds(after, before) {
  const ids = [];
  const add = (val) => {
    if (!val) return;
    if (typeof val === 'string') {
      ids.push(val);
    } else if (typeof val === 'object') {
      if (val._serialized) ids.push(val._serialized);
      if (val.id) ids.push(val.id);
    }
  };

  if (before) {
    add(before.id);
    add(before.protocolMessageKey);
  }

  if (after) {
    add(after.id);
    add(after.protocolMessageKey);
  }

  return [...new Set(ids)];
}

async function handleMessageRevoke({ after, before, client, db }) {
  const candidateIds = getCandidateMessageIds(after, before);
  if (candidateIds.length === 0) {
    return { action: 'IGNORED_NO_MESSAGE_ID' };
  }

  const result = deleteTransactionByMessageId(db, candidateIds);
  if (!result) {
    return { action: 'IGNORED_NO_MATCHING_TRANSACTION', details: { candidateIds } };
  }

  for (const cid of candidateIds) {
    sentAutoBillMsgIds.delete(cid);
  }

  const tx = result.transaction;
  console.log(`[REVOKE] Unsent message detected (${tx.message_id || candidateIds[0]}). Removed ${tx.type} of ${tx.amount} BDT for +${tx.phone_number}. New due: ${result.dueAmount} BDT`);

  return {
    action: 'REVOKED_TRANSACTION',
    details: {
      transactionId: tx.id,
      phone: tx.phone_number,
      type: tx.type,
      amount: tx.amount,
      dueAmount: result.dueAmount,
      messageId: tx.message_id
    }
  };
}

function setupBotHandlers({ client, db }) {
  client.on('qr', (qr) => {
    console.log('Scan the QR code below to log in:');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', async () => {
    console.log('✅ WhatsApp Web Client is ready!');
    console.log(`Logged in as: ${client.info?.wid?.user}`);

    // Auto-migrate any existing LID customer records in the database to actual phone numbers
    try {
      const lidCustomers = db.prepare(
        "SELECT phone_number FROM customers WHERE phone_number LIKE '%@lid' OR LENGTH(phone_number) > 14"
      ).all();

      for (const row of lidCustomers) {
        const actualPhone = await resolveCustomerPhone({ client, recipient: row.phone_number });
        if (actualPhone && actualPhone !== row.phone_number) {
          console.log(`[MIGRATION] Migrating LID ${row.phone_number} to actual phone number +${actualPhone}...`);
          migrateCustomerPhone(db, row.phone_number, actualPhone);
        }
      }
    } catch (e) {
      // Non-fatal if migration query fails
    }
  });

  client.on('authenticated', () => {
    console.log('🔐 Authentication successful. Session stored.');
  });

  client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Loading screen: ${percent}% - ${message}`);
  });

  client.on('change_state', (state) => {
    console.log('🔄 State changed:', state);
  });

  client.on('disconnected', (reason) => {
    console.log('⚠️ Disconnected:', reason);
  });

  client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failed:', msg);
  });

  client.on('message_create', async (msg) => {
    try {
      await handleMessageCreate({ msg, client, db });
    } catch (err) {
      console.error('Error handling message_create event:', err);
    }
  });

  client.on('message_revoke_everyone', async (after, before) => {
    try {
      await handleMessageRevoke({ after, before, client, db });
    } catch (err) {
      console.error('Error handling message_revoke_everyone event:', err);
    }
  });
}

module.exports = {
  extractUser,
  isSelfChat,
  resolveCustomerPhone,
  toBengaliDigits,
  formatDueReport,
  handleMessageCreate,
  handleMessageRevoke,
  getCandidateMessageIds,
  setupBotHandlers,
  sentAutoBillMsgIds,
  pendingAutoBills
};
