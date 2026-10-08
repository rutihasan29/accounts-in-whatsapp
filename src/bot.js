const { parseMessage } = require('./parser');
const { recordTransaction, getDueList, migrateCustomerPhone } = require('./db');
const qrcode = require('qrcode-terminal');

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

  return (
    (toUser && toUser === myUser) ||
    (remoteUser && remoteUser === myUser) ||
    (fromUser === myUser && (!toUser || toUser === myUser))
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
    return { action: 'IGNORED_NOT_FROM_ME' };
  }

  const recipient = msg.to || '';
  if (recipient.endsWith('@g.us') || msg.id?.remote?.endsWith('@g.us')) {
    return { action: 'IGNORED_GROUP' };
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

    const record = recordTransaction(db, {
      phone,
      name: contactName,
      type: parsed.type,
      amount: parsed.amount,
      rawText: parsed.rawText
    });

    console.log(`[${parsed.type}] ${parsed.amount} BDT recorded for +${phone}${contactName ? ` (${contactName})` : ''}. Current due: ${record.dueAmount} BDT`);

    return {
      action: parsed.type === 'BILL' ? 'RECORDED_BILL' : 'RECORDED_PAYMENT',
      details: { phone, amount: parsed.amount, dueAmount: record.dueAmount }
    };
  }

  return { action: 'IGNORED_OTHER' };
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
}

module.exports = {
  extractUser,
  isSelfChat,
  resolveCustomerPhone,
  toBengaliDigits,
  formatDueReport,
  handleMessageCreate,
  setupBotHandlers
};
