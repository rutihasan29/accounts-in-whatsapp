const config = require('./config');
const { parseMessage } = require('./parser');
const {
  recordTransaction,
  recordLead,
  recordExistingContact,
  updateTransactionMessageId,
  deleteTransactionByMessageId,
  getDueList,
  getCustomerSummary,
  migrateCustomerPhone,
  recordBotState,
  heartbeatBotState,
  isVideoCustomer,
  addVideoCustomer,
  removeVideoCustomer,
  getVideoCustomers,
  getBotUptimeStats,
  getDashboardStats,
  findVoiceJobOrderByScriptText,
  findLatestPendingVoiceJob,
  findVoiceJobOrderByVa2MsgId,
  updateVoiceJobVa2ForwardMsgId,
  updateVoiceJobDelivered,
  getBotSetting
} = require('./db');
const {
  isAudioDocumentMessage,
  isVideoDocumentMessage,
  getAudioDurationFromBuffer,
  formatAudioDuration,
  calculateAudioBill,
  formatBillMessage,
  resolveAudioDuration,
  hasBengaliCharacters,
  buildCleanVoiceFilename
} = require('./audio');
const { cleanVoiceoverAudio } = require('./aircheck');
const { sendWelcomeDemo } = require('./welcome');
const { syncExistingInboxContacts } = require('./sync');
const { classifyChat, isAffirmativeConfirmation, isNegativeConfirmation } = require('./classifier');
const { handleClassificationAction, cancelPendingConfirmation, getPendingConfirmation } = require('./dispatch');
const qrcode = require('qrcode-terminal');

let MessageMedia = null;
try {
  ({ MessageMedia } = require('whatsapp-web.js'));
} catch {}

function createMedia(mimetype, base64data, filename) {
  if (MessageMedia) {
    return new MessageMedia(mimetype, base64data, filename);
  }
  return {
    mimetype,
    data: base64data,
    filename
  };
}

// Track auto-sent bill messages to prevent duplicate ledger entries on message_create echo
const sentAutoBillMsgIds = new Set();
const pendingAutoBills = [];
const recentOutboundJobTypes = new Map();
const sentSelfBotMsgIds = new Set();

function isBotSystemMessage(text) {
  if (!text || typeof text !== 'string') return false;
  return text.startsWith('ℹ️ কমান্ড বুঝতে পারিনি') ||
         text.startsWith('ℹ️ বিল বা পেমেন্ট') ||
         text.startsWith('🤖 *মুন্নিসফট বট') ||
         text.startsWith('🟢 *মুন্নিসফট বট') ||
         text.startsWith('📊 *আজকের লেজার') ||
         text.startsWith('*মুন্নিসফট গ্রাহক বকেয়া তালিকা*') ||
         text.includes('[সহায়তা প্রয়োজন / Customer Escalation]') ||
         text.includes('[গ্রাহকের বার্তা / Customer Message]') ||
         text.includes('[ভিডিও গ্রাহকের বার্তা / Video Customer Message]') ||
         text.includes('[নতুন ভয়েস অর্ডার]');
}

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

function isPhoneMatch(p1, p2) {
  if (!p1 || !p2) return false;
  const c1 = String(p1).replace(/\D/g, '');
  const c2 = String(p2).replace(/\D/g, '');
  if (c1 === c2) return true;
  if (c1.startsWith('880') && c1.slice(2) === c2) return true;
  if (c2.startsWith('880') && c2.slice(2) === c1) return true;
  if (c1.length >= 10 && c2.endsWith(c1)) return true;
  if (c2.length >= 10 && c1.endsWith(c2)) return true;
  return false;
}

function getMyUser(client) {
  return (
    client?.info?.wid?.user ||
    extractUser(client?.info?.wid?._serialized) ||
    extractUser(client?.info?.me?._serialized) ||
    ''
  );
}

function getMyLid(client) {
  return (
    client?.myLid ||
    client?.info?.lid?._serialized ||
    ''
  );
}

function getMyLidUser(client) {
  return (
    client?.myLidUser ||
    extractUser(client?.myLid) ||
    extractUser(client?.info?.lid?._serialized) ||
    client?.info?.lid?.user ||
    ''
  );
}

function isSelfChat(msg, client) {
  const myUser = getMyUser(client);
  const myLid = getMyLid(client);
  const myLidUser = getMyLidUser(client);
  if (!myUser && !myLidUser) return false;

  const rawRemote = msg.id?.remote || '';
  const rawFrom = msg.from || '';
  const rawTo = msg.to || '';

  // Never a group, broadcast, or newsletter
  if (rawRemote.endsWith('@g.us') || rawRemote.endsWith('@broadcast') || rawRemote.endsWith('@newsletter')) {
    return false;
  }

  // Never treat messages to or from staff/editors (VE3, VA2) as self-chat
  const cleanVe3 = String(config.VE3_PHONE || '8801831366604').replace(/\D/g, '');
  const cleanVa2 = String(config.VA2_PHONE || '8801307760509').replace(/\D/g, '');
  const remoteUser = extractUser(rawRemote);
  const fromUser = extractUser(rawFrom);
  const toUser = extractUser(rawTo);
  if (remoteUser === cleanVe3 || remoteUser === cleanVa2 || toUser === cleanVe3 || toUser === cleanVa2) {
    return false;
  }

  const isMe = (user, jid) => {
    if (!user && !jid) return false;
    if (myUser && (user === myUser || jid?.startsWith(`${myUser}@`) || jid?.startsWith(`${myUser}:`))) return true;
    if (myLid && jid === myLid) return true;
    if (myLidUser && user === myLidUser) return true;
    return false;
  };

  // When fromMe is true: it's self-chat if addressed to myself (via to or remote)
  if (msg.fromMe === true) {
    if (isMe(remoteUser, rawRemote) || isMe(toUser, rawTo)) {
      return true;
    }
    // Also if fromMe is true and fromUser matches remoteUser (sender and chat are identical)
    if (fromUser && (fromUser === remoteUser || rawFrom === rawRemote)) {
      if (isMe(fromUser, rawFrom)) {
        return true;
      }
    }
  }

  // When fromMe is false: it can only be self-chat if incoming from myself to myself
  if (msg.fromMe === false) {
    if (isMe(fromUser, rawFrom)) {
      if (isMe(remoteUser, rawRemote) || isMe(toUser, rawTo) || !rawTo || rawRemote === rawFrom) {
        return true;
      }
    }
  }

  return false;
}

function isGroupMessage(msg, chat = null) {
  if (!msg) return false;

  const rawRemote = String(msg.id?.remote || '');
  const rawFrom = String(msg.from || '');
  const rawTo = String(msg.to || '');
  const rawAuthor = String(msg.author || msg.id?.participant || '');

  // 1. Any domain indicating group, broadcast, or newsletter
  if (
    rawRemote.includes('@g.us') ||
    rawFrom.includes('@g.us') ||
    rawTo.includes('@g.us') ||
    rawRemote.includes('@broadcast') ||
    rawFrom.includes('@broadcast') ||
    rawRemote.includes('@newsletter') ||
    rawFrom.includes('@newsletter')
  ) {
    return true;
  }

  // 2. Author / participant is ONLY present in WhatsApp group messages
  if (rawAuthor && rawAuthor !== rawFrom && (rawAuthor.includes('@c.us') || rawAuthor.includes('@lid') || rawAuthor.includes('@s.whatsapp.net'))) {
    return true;
  }

  // 3. Flags from wwebjs message or chat
  if (msg.isGroup === true || chat?.isGroup === true || msg.broadcast === true) {
    return true;
  }

  // 4. Meta's modern group ID prefix is 120363
  const fromDigits = rawFrom.split('@')[0].split(':')[0].replace(/\D/g, '');
  const remoteDigits = rawRemote.split('@')[0].split(':')[0].replace(/\D/g, '');
  const toDigits = rawTo.split('@')[0].split(':')[0].replace(/\D/g, '');
  if (fromDigits.startsWith('120363') || remoteDigits.startsWith('120363') || toDigits.startsWith('120363')) {
    return true;
  }

  return false;
}

async function resolveCustomerPhone({ client, recipient, msg }) {
  if (!recipient || typeof recipient !== 'string') return '';

  // Reject any group, broadcast, or newsletter immediately
  if (
    recipient.includes('@g.us') ||
    recipient.includes('@broadcast') ||
    recipient.includes('@newsletter') ||
    recipient.replace(/\D/g, '').startsWith('120363')
  ) {
    return '';
  }

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

function isTestEnv() {
  return (
    process.env.NODE_ENV === 'test' ||
    Boolean(process.execArgv && process.execArgv.includes('--test')) ||
    process.argv.slice(1).some(a =>
      a === '--test' ||
      a.endsWith('.test.js') ||
      a.includes('.test.js') ||
      /[\\/]tests[\\/]/.test(a) ||
      a.startsWith('tests/') ||
      a.startsWith('tests\\')
    )
  );
}

async function resolveChat(client, msg, rawSender, phone) {
  let chat = null;
  if (msg && typeof msg.getChat === 'function') {
    try {
      chat = await msg.getChat();
      if (chat) return chat;
    } catch {}
  }
  if (client && typeof client.getChatById === 'function') {
    const candidates = [
      msg?.id?.remote,
      rawSender,
      phone ? `${phone}@c.us` : null,
      msg?.from
    ].filter(Boolean);

    for (const cid of candidates) {
      try {
        chat = await client.getChatById(cid);
        if (chat) return chat;
      } catch {}
    }
  }
  return chat;
}

async function handleMessageCreate({
  msg,
  client,
  db,
  classifierFn = null,
  dispatchFn = null,
  cleanVoiceoverAudioFn = null
} = {}) {
  // Ignore echo of bot's own self-chat replies
  if (msg.id?._serialized && sentSelfBotMsgIds.has(msg.id._serialized)) {
    sentSelfBotMsgIds.delete(msg.id._serialized);
    if (msg.id?.id) sentSelfBotMsgIds.delete(msg.id.id);
    return { action: 'IGNORED_SELF_BOT_ECHO' };
  }
  if (msg.id?.id && sentSelfBotMsgIds.has(msg.id.id)) {
    sentSelfBotMsgIds.delete(msg.id.id);
    return { action: 'IGNORED_SELF_BOT_ECHO' };
  }

  // 0. Completely ignore any messages from WhatsApp groups, broadcast lists, or newsletters.
  // Group messages must NEVER be considered by AI, nor escalated to VE3, nor recorded as customer leads.
  if (isGroupMessage(msg)) {
    return { action: 'IGNORED_GROUP' };
  }

  let isSelf = isSelfChat(msg, client);
  const isTest = isTestEnv();
  const activeClassifierFn = classifierFn || (!isTest ? classifyChat : null);
  const activeDispatchFn = dispatchFn || handleClassificationAction;

  // Real WhatsApp Web with LIDs fallback: if isSelf is not yet true and remote is an @lid,
  // check if that remote LID resolves to the bot's own phone number.
  // Note: NEVER check msg.getContact()?.isMe here because on outgoing messages (fromMe: true)
  // the sender is always "me", which would falsely mark messages to VE3/VA2/customers as self-chat.
  if (!isSelf && client && !client.myLid) {
    const rawRemote = msg.id?.remote || '';
    const myUser = getMyUser(client);

    if (rawRemote.endsWith('@lid') && myUser && !rawRemote.endsWith('@g.us') && !rawRemote.endsWith('@broadcast')) {
      try {
        const resolvedPhone = await resolveCustomerPhone({ client, recipient: rawRemote, msg });
        if (resolvedPhone && resolvedPhone === myUser) {
          isSelf = true;
          client.myLid = rawRemote;
          client.myLidUser = extractUser(rawRemote);
          console.log(`[SELF_CHAT] Auto-learned bot self LID: ${rawRemote}`);
        }
      } catch {}
    }
  }

  // Handle self-chat messages immediately
  if (isSelf) {
    // Ignore any bot-generated system messages or forwarded escalation alerts
    if (isBotSystemMessage(msg.body)) {
      return { action: 'IGNORED_SELF_BOT_MESSAGE' };
    }

    console.log(`[SELF_CHAT] Processing self-chat message: "${msg.body}" (remote: ${msg.id?.remote || msg.to || ''})`);

    const targetChat = msg.id?.remote || msg.to || msg.from;
    const sendSelfReply = async (text) => {
      let sent = false;

      // 1. Try client.sendMessage if available
      if (client && typeof client.sendMessage === 'function' && targetChat) {
        try {
          const sentMsg = await client.sendMessage(targetChat, text);
          if (sentMsg?.id?._serialized) {
            sentSelfBotMsgIds.add(sentMsg.id._serialized);
            if (sentMsg.id.id) sentSelfBotMsgIds.add(sentMsg.id.id);
            setTimeout(() => {
              if (sentMsg?.id?._serialized) sentSelfBotMsgIds.delete(sentMsg.id._serialized);
              if (sentMsg?.id?.id) sentSelfBotMsgIds.delete(sentMsg.id.id);
            }, 120000).unref?.();
          }
          sent = true;
        } catch (err) {
          console.warn('[SELF_CHAT] client.sendMessage failed, trying chat.sendMessage:', err.message);
        }
      }

      // 2. Try chat.sendMessage if client.sendMessage failed or was unavailable
      if (!sent && typeof msg.getChat === 'function') {
        try {
          const chat = await msg.getChat();
          if (chat && typeof chat.sendMessage === 'function') {
            await chat.sendMessage(text);
            sent = true;
          }
        } catch (err) {
          console.warn('[SELF_CHAT] chat.sendMessage failed, trying msg.reply:', err.message);
        }
      }

      // 3. Fallback to msg.reply
      if (!sent && typeof msg.reply === 'function') {
        try {
          await msg.reply(text);
          sent = true;
        } catch (err) {
          console.warn('[SELF_CHAT] msg.reply failed:', err.message);
        }
      }

      return sent;
    };

    const parsed = parseMessage(msg.body);

    // 1. Help Command
    if (parsed && parsed.type === 'COMMAND_HELP') {
      const helpText = [
        '🤖 *মুন্নিসফট বট সেলফ-চ্যাট কমান্ড (Bot Commands)*\n',
        '📌 *বকেয়া ও লেজার:*',
        '• `due` বা `!due` — সকল গ্রাহকের বকেয়া তালিকা দেখুন',
        '• `stats` — আজকের বিল, আদায় ও সার্বিক রিপোর্ট\n',
        '📹 *ভিডিও গ্রাহক ব্যবস্থাপনা:*',
        '• `video` বা `video list` — ভিডিও গ্রাহকদের তালিকা দেখুন',
        '• `video add <ফোন> [নোট]` — নতুন ভিডিও গ্রাহক যোগ করুন',
        '• `video remove <ফোন>` — তালিকা থেকে গ্রাহক বাদ দিন\n',
        '⚙️ *সিস্টেম ও অবস্থা:*',
        '• `status` — বট কানেকশন ও আপটাইম রিপোর্ট',
        '• `help` — এই সাহায্য মেনু দেখুন\n',
        '💡 *টিপ:* যেকোনো গ্রাহকের চ্যাটে গিয়ে সরাসরি `বিল ৫০০ টাকা` বা `৫০০ টাকা পেয়েছি, ধন্যবাদ` লিখলে স্বয়ংক্রিয়ভাবে লেজারে হিসাব যুক্ত হবে।'
      ].join('\n');

      await sendSelfReply(helpText);
      return { action: 'RESPONDED_HELP', details: { text: helpText } };
    }

    // 2. Due List Command
    if (parsed && parsed.type === 'COMMAND_DUE') {
      const dues = getDueList(db);
      const report = formatDueReport(dues);
      console.log(`[COMMAND_DUE] !due triggered in self-chat. Found ${dues.length} customer(s) with dues.`);
      await sendSelfReply(report);
      return { action: 'RESPONDED_DUE_LIST', details: { count: dues.length } };
    }

    // 3. Status Command
    if (parsed && parsed.type === 'COMMAND_STATUS') {
      const uptime = getBotUptimeStats(db);
      const statusText = [
        '🟢 *মুন্নিসফট বট স্ট্যাটাস (Bot Status)*',
        `• বর্তমান অবস্থা: ${uptime.currentStatus === 'ONLINE' ? 'অনলাইন (ONLINE) ✅' : 'অফলাইন (OFFLINE) ⚠️'}`,
        `• বট নম্বর: +${getMyUser(client) || 'Active'}`,
        `• আজকের আপটাইম: ${uptime.todayUptimePercent}%`,
        `• লোকাল ড্যাশবোর্ড: http://localhost:3000`
      ].join('\n');

      await sendSelfReply(statusText);
      return { action: 'RESPONDED_STATUS', details: uptime };
    }

    // 4. Stats Command
    if (parsed && parsed.type === 'COMMAND_STATS') {
      const stats = getDashboardStats(db);
      const statsText = [
        '📊 *আজকের লেজার সারসংক্ষেপ (Ledger Summary)*',
        `• মোট বকেয়া: ৳ ${toBengaliDigits(stats.totalDue)} (${toBengaliDigits(stats.debtorsCount)} জন গ্রাহক)`,
        `• আজকের নতুন বিল: ৳ ${toBengaliDigits(stats.todayBilled)}`,
        `• আজকের আদায়: ৳ ${toBengaliDigits(stats.todayCollected)}`,
        '─────────────────────',
        `বিস্তারিত দেখতে মোবাইল ড্যাশবোর্ড ভিজিট করুন: http://localhost:3000`
      ].join('\n');

      await sendSelfReply(statsText);
      return { action: 'RESPONDED_STATS', details: stats };
    }

    // 5. Video Command
    if (parsed && parsed.type === 'COMMAND_VIDEO') {
      if (parsed.subAction === 'add') {
        if (!parsed.phone) {
          await sendSelfReply('❌ সঠিক ফরম্যাট: video add <ফোন_নম্বর> [নোট]\nউদাহরণ: video add 017XXXXXXXX Daily Sports Video');
          return { action: 'ERROR_VIDEO_COMMAND_MISSING_PHONE' };
        }
        const record = addVideoCustomer(db, parsed.phone, parsed.note);
        await sendSelfReply(`✅ +${parsed.phone} কে ভিডিও গ্রাহক হিসেবে সংরক্ষণ করা হয়েছে।${parsed.note ? `\nনোট: ${parsed.note}` : ''}`);
        return { action: 'ADDED_VIDEO_CUSTOMER', details: { phone: parsed.phone, note: parsed.note } };
      }

      if (parsed.subAction === 'remove') {
        if (!parsed.phone) {
          await sendSelfReply('❌ সঠিক ফরম্যাট: video remove <ফোন_নম্বর>\nউদাহরণ: video remove 017XXXXXXXX');
          return { action: 'ERROR_VIDEO_COMMAND_MISSING_PHONE' };
        }
        const resDel = removeVideoCustomer(db, parsed.phone);
        if (resDel.deleted) {
          await sendSelfReply(`✅ +${parsed.phone} কে ভিডিও গ্রাহক তালিকা থেকে মুছে ফেলা হয়েছে।`);
        } else {
          await sendSelfReply(`ℹ️ +${parsed.phone} ভিডিও গ্রাহক তালিকায় পাওয়া যায়নি।`);
        }
        return { action: 'REMOVED_VIDEO_CUSTOMER', details: { phone: parsed.phone, deleted: resDel.deleted } };
      }

      // Default: list
      const list = getVideoCustomers(db);
      let replyText = '📹 *ভিডিও গ্রাহক তালিকা (Video Customers):*\n';
      if (!list || list.length === 0) {
        replyText += 'বর্তমানে কোনো ভিডিও গ্রাহক তালিকাভুক্ত নেই।\nযোগ করতে লিখুন: video add <ফোন_নম্বর> [নোট]';
      } else {
        list.forEach((c, idx) => {
          replyText += `${toBengaliDigits(idx + 1)}. +${c.phone_number}${c.note ? ` (${c.note})` : ''}\n`;
        });
      }
      await sendSelfReply(replyText.trim());
      return { action: 'LISTED_VIDEO_CUSTOMERS', details: { count: list.length } };
    }

    // 6. User sent bill / payment / set due in self-chat
    if (parsed && (parsed.type === 'BILL' || parsed.type === 'PAYMENT' || parsed.type === 'SET_DUE')) {
      const guidance = 'ℹ️ বিল বা পেমেন্ট রেকর্ড করার জন্য সংশ্লিষ্ট গ্রাহকের চ্যাটে মেসেজটি পাঠান। সেলফ-চ্যাটে বকেয়া তালিকা দেখতে *due* লিখুন।';
      await sendSelfReply(guidance);
      return { action: 'RESPONDED_SELF_LEDGER_GUIDANCE' };
    }

    // 7. Any other text in self-chat -> Friendly help hint
    const fallbackText = `ℹ️ কমান্ড বুঝতে পারিনি: "${msg.body}"\n\nউপলব্ধ কমান্ড তালিকা দেখতে *help* লিখুন অথবা বকেয়া তালিকা দেখতে *due* লিখুন।`;
    await sendSelfReply(fallbackText);
    return { action: 'RESPONDED_UNKNOWN_SELF_COMMAND', details: { text: msg.body } };
  }

  if (!msg.fromMe && !isSelf) {
    const rawSender = msg.from || msg.id?.remote || '';
    if (rawSender.endsWith('@g.us')) {
      return { action: 'IGNORED_GROUP' };
    }

    const cleanSender = String(msg.from || msg.id?.remote || '').split('@')[0].split(':')[0].replace(/\D/g, '');
    const cleanVa2 = String(config.VA2_PHONE || '8801307760509').replace(/\D/g, '');
    let isVa2 = isPhoneMatch(cleanSender, cleanVa2);

    if (!isVa2 && (rawSender.endsWith('@lid') || msg.from?.endsWith?.('@lid') || msg.id?.remote?.endsWith?.('@lid'))) {
      try {
        const resolved = await resolveCustomerPhone({ client, recipient: rawSender, msg });
        if (isPhoneMatch(resolved, cleanVa2)) {
          isVa2 = true;
        }
      } catch {}
    }

    if (isVa2) {
      const isAudio = isAudioDocumentMessage(msg) ||
        msg.type === 'audio' ||
        msg.mimetype?.startsWith('audio/') ||
        (msg.hasMedia && msg.filename && /\.(wav|mp3|m4a|ogg|aac|flac)$/i.test(msg.filename));

      if (isAudio) {
        let quotedMsgId = null;
        if (msg.hasQuotedMsg && typeof msg.getQuotedMessage === 'function') {
          try {
            const q = await msg.getQuotedMessage();
            quotedMsgId = q?.id?._serialized || q?.id?.id || null;
          } catch {}
        }
        if (!quotedMsgId && msg.quotedMsgId) {
          quotedMsgId = msg.quotedMsgId;
        }

        const order = (quotedMsgId ? findVoiceJobOrderByVa2MsgId(db, quotedMsgId) : null)
          || findLatestPendingVoiceJob(db);

        if (!order) {
          console.log('[VA2_AUDIO] Received audio from VA2 but no pending voice job order found.');
          return { action: 'IGNORED_VA2_AUDIO_NO_ORDER' };
        }

        const rawFilename = msg.filename || msg.body || '';
        const hasBengali = hasBengaliCharacters(rawFilename);

        if (hasBengali) {
          const media = typeof msg.downloadMedia === 'function' ? await msg.downloadMedia() : null;
          if (media) {
            const customerJid = `${order.customer_phone}@c.us`;
            if (client && typeof client.sendMessage === 'function') {
              try {
                await client.sendMessage(customerJid, media, {
                  quotedMessageId: order.customer_script_msg_id,
                  sendMediaAsDocument: true
                });
              } catch (sendErr) {
                console.warn('[VA2_AUDIO] Quoted send to customer failed, trying unquoted:', sendErr.message);
                try {
                  await client.sendMessage(customerJid, media, { sendMediaAsDocument: true });
                } catch {}
              }
            }
          }

          const va2AudioMsgId = msg.id?._serialized || msg.id?.id || (typeof msg.id === 'string' ? msg.id : null);
          updateVoiceJobDelivered(db, order.order_id, {
            va2AudioMsgId,
            va2AudioFilename: rawFilename,
            finalAudioFilename: rawFilename,
            cleanDuration: null,
            cutsCount: 0,
            modelUsed: 'DIRECT_FORWARD'
          });

          console.log(`[VA2_AUDIO] Directly forwarded Bengali-named audio ${rawFilename} to customer +${order.customer_phone}`);
          return {
            action: 'DELIVERED_VA2_AUDIO_DIRECT',
            details: {
              orderId: order.order_id,
              customerPhone: order.customer_phone,
              filename: rawFilename
            }
          };
        } else {
          const media = typeof msg.downloadMedia === 'function' ? await msg.downloadMedia() : null;
          const audioBuffer = (media && media.data)
            ? Buffer.from(media.data, 'base64')
            : (Buffer.isBuffer(media) ? media : Buffer.alloc(0));

          const aircheckEnabled = getBotSetting(db, 'aircheck_enabled', true);
          let aircheckRes = null;
          let aircheckFailed = false;

          if (!aircheckEnabled) {
            console.log(`[AIRCHECK] AirCheck editing disabled via bot settings.`);
            aircheckFailed = true;
          } else {
            const activeCleanAudioFn = cleanVoiceoverAudioFn || cleanVoiceoverAudio;
            try {
              aircheckRes = await activeCleanAudioFn({
                audioBuffer,
                filename: rawFilename || 'recording.wav',
                mimeType: media?.mimetype || 'audio/wav'
              });
              if (!aircheckRes || aircheckRes.failed || aircheckRes.modelUsed === 'fallback' || !aircheckRes.cleanBuffer) {
                aircheckFailed = true;
              }
            } catch (err) {
              console.warn('[AIRCHECK] AirCheck clean error:', err.message);
              aircheckFailed = true;
            }
          }

          // If AirCheck does not work (failed/quota/disabled), reply to VA2 script asking them to edit manually
          if (aircheckFailed) {
            console.log(`[AIRCHECK] AirCheck did not work for order ${order.order_id}. Notifying VA2 to edit manually.`);
            const va2ReplyText = 'এটা এডিট করে, স্ক্রিপ্টে রিপ্লাই দিয়ে পাঠান';
            const va2Jid = `${cleanVa2}@c.us`;
            const replyMsgId = order.va2_forward_msg_id || msg.id?._serialized || msg.id?.id;
            if (client && typeof client.sendMessage === 'function') {
              try {
                if (replyMsgId) {
                  await client.sendMessage(va2Jid, va2ReplyText, {
                    quotedMessageId: replyMsgId
                  });
                } else {
                  await client.sendMessage(va2Jid, va2ReplyText);
                }
              } catch (sendErr) {
                console.warn('[VA2_AUDIO] Quoted edit request to VA2 failed, sending unquoted:', sendErr.message);
                try {
                  await client.sendMessage(va2Jid, va2ReplyText);
                } catch {}
              }
            }

            return {
              action: 'AIRCHECK_FAILED_NOTIFIED_VA2',
              details: {
                orderId: order.order_id,
                customerPhone: order.customer_phone,
                va2ForwardMsgId: order.va2_forward_msg_id,
                message: va2ReplyText
              }
            };
          }

          let ext = 'mp3';
          if (rawFilename && rawFilename.includes('.')) {
            ext = rawFilename.split('.').pop();
          } else if (media?.mimetype?.includes('wav')) {
            ext = 'wav';
          } else if (media?.mimetype?.includes('mp3') || media?.mimetype?.includes('mpeg')) {
            ext = 'mp3';
          } else if (media?.mimetype?.includes('m4a')) {
            ext = 'm4a';
          } else if (media?.mimetype?.includes('ogg')) {
            ext = 'ogg';
          } else if (media?.mimetype?.includes('flac')) {
            ext = 'flac';
          } else if (media?.mimetype?.includes('aac')) {
            ext = 'aac';
          }

          const finalFilename = buildCleanVoiceFilename({
            headline: order.headline,
            durationSeconds: aircheckRes.durationSeconds,
            ext
          });

          const cleanBuf = aircheckRes.cleanBuffer || audioBuffer;
          const cleanMedia = createMedia(
            media?.mimetype || 'audio/mp3',
            cleanBuf.toString('base64'),
            finalFilename
          );

          const customerJid = `${order.customer_phone}@c.us`;
          if (client && typeof client.sendMessage === 'function') {
            try {
              await client.sendMessage(customerJid, cleanMedia, {
                quotedMessageId: order.customer_script_msg_id,
                sendMediaAsDocument: true
              });
            } catch (custErr) {
              console.warn('[VA2_AUDIO] Quoted send to customer failed, trying unquoted:', custErr.message);
              try {
                await client.sendMessage(customerJid, cleanMedia, { sendMediaAsDocument: true });
              } catch {}
            }
          }

          const va2Jid = `${cleanVa2}@c.us`;
          if (client && typeof client.sendMessage === 'function') {
            try {
              await client.sendMessage(va2Jid, cleanMedia, {
                quotedMessageId: order.va2_forward_msg_id,
                sendMediaAsDocument: true
              });
            } catch (va2Err) {
              console.warn('[VA2_AUDIO] Quoted send to VA2 failed, trying unquoted:', va2Err.message);
              try {
                await client.sendMessage(va2Jid, cleanMedia, { sendMediaAsDocument: true });
              } catch {}
            }
          }

          const va2AudioMsgId = msg.id?._serialized || msg.id?.id || (typeof msg.id === 'string' ? msg.id : null);
          updateVoiceJobDelivered(db, order.order_id, {
            va2AudioMsgId,
            va2AudioFilename: rawFilename,
            finalAudioFilename: finalFilename,
            cleanDuration: aircheckRes.durationSeconds,
            cutsCount: aircheckRes.cutsCount,
            modelUsed: aircheckRes.modelUsed
          });

          console.log(`[VA2_AUDIO] AirCheck processed ${rawFilename} -> ${finalFilename} (${aircheckRes.durationSeconds}s, ${aircheckRes.cutsCount} cuts). Delivered to customer +${order.customer_phone} and VA2.`);
          return {
            action: 'DELIVERED_VA2_AUDIO_AIRCHECK',
            details: {
              orderId: order.order_id,
              customerPhone: order.customer_phone,
              finalFilename,
              durationSeconds: aircheckRes.durationSeconds,
              cutsCount: aircheckRes.cutsCount
            }
          };
        }
      }

      return { action: 'IGNORED_VA2_NON_AUDIO' };
    }

    try {
      const phone = await resolveCustomerPhone({ client, recipient: rawSender, msg });
      if (phone) {
        let contact = null;
        let contactName = null;
        try {
          if (client && typeof client.getContactById === 'function') {
            contact = await client.getContactById(rawSender);
            contactName = contact?.name || contact?.pushname || null;
          }
        } catch {}

        // Video customer check: If customer belongs to video category,
        // NEVER ask them anything (no "শুধু ভয়েস?", no LLM classifier),
        // and escalate directly to VE3 as Video Customer Message.
        const videoEscalationEnabled = getBotSetting(db, 'video_customer_escalation_enabled', true);
        if (isVideoCustomer(db, phone) && videoEscalationEnabled) {
          cancelPendingConfirmation(phone);
          recordExistingContact(db, { phone, name: contactName });
          console.log(`[VIDEO_CUSTOMER] Inbound message from video customer +${phone}. Escalating directly to VE3.`);
          const activeChat = await resolveChat(client, msg, rawSender, phone);
          const dispatchRes = await activeDispatchFn({
            client,
            chat: activeChat,
            classificationResult: {
              classification: 'VIDEO_CUSTOMER',
              confidence: 'HIGH',
              extracted_script: msg.body || '',
              reason: 'ভিডিও গ্রাহক—কোনো প্রশ্ন ছাড়াই সরাসরি VE3 তে ফরোয়ার্ড'
            },
            customerPhone: phone,
            customerName: contactName,
            latestMessageText: msg.body || '',
            db
          });
          return dispatchRes;
        }

        // Safeguard 1: If contact is saved in user's phone contacts (isMyContact === true),
        // they are an existing contact, NOT a new cold inbound lead!
        if (contact?.isMyContact === true) {
          console.log(`[LEAD] Sender +${phone} (${contactName || 'saved contact'}) is in phone contacts. Skipping welcome demo.`);
          recordExistingContact(db, { phone, name: contactName });
          if (!activeClassifierFn) {
            return { action: 'IGNORED_EXISTING_CONTACT', details: { phone, name: contactName } };
          }
        }

        // Safeguard 2: Check if this chat has existing message history in inbox
        let chat = null;
        try {
          if (typeof msg.getChat === 'function') {
            chat = await msg.getChat();
            if (chat && typeof chat.fetchMessages === 'function') {
              const prevMsgs = await chat.fetchMessages({ limit: 5 });
              if (Array.isArray(prevMsgs) && prevMsgs.some(m => m.id?._serialized !== msg.id?._serialized)) {
                console.log(`[LEAD] Sender +${phone} has existing chat history in inbox. Skipping welcome demo.`);
                recordExistingContact(db, { phone, name: contactName });
                if (!activeClassifierFn) {
                  return { action: 'IGNORED_EXISTING_CHAT_HISTORY', details: { phone, name: contactName } };
                }
              }
            }
          }
        } catch {}

        const leadRes = recordLead(db, { phone, name: contactName });
        if (leadRes?.status === 'NEW_LEAD') {
          console.log(`[LEAD] New lead recorded: +${phone}${contactName ? ` (${contactName})` : ''}`);
          const targetChat = (phone ? `${phone}@c.us` : null) || msg.id?.remote || msg.from;
          let welcomeResult = null;
          const welcomeDemoEnabled = getBotSetting(db, 'welcome_demo_enabled', true);
          if (!welcomeDemoEnabled) {
            console.log(`[WELCOME_DEMO] Welcome demo disabled via bot settings. Skipping demo for +${phone}.`);
          } else if (targetChat) {
            welcomeResult = await sendWelcomeDemo({
              client,
              targetChat,
              db,
              phone,
              delayMs: isTest ? 0 : 800
            });
          }
          if (!classifierFn) {
            return { action: 'RECORDED_NEW_LEAD', details: { phone, name: contactName, welcomeResult } };
          }
        }

        // For existing contacts or chats where welcome demo is NOT currently in-flight:
        if (activeClassifierFn) {
          if (!chat) {
            chat = await resolveChat(client, msg, rawSender, phone);
          }
          let history = [msg];
          if (chat && typeof chat.fetchMessages === 'function') {
            try {
              const fetched = await chat.fetchMessages({ limit: 10 });
              if (Array.isArray(fetched) && fetched.length > 0) {
                history = fetched;
              }
            } catch (err) {
              console.warn(`[CHAT] fetchMessages failed for +${phone}:`, err.message);
            }
          }
          if (!Array.isArray(history) || history.length === 0) {
            history = [msg];
          } else if (msg.id?._serialized && !history.some(m => m.id?._serialized === msg.id?._serialized)) {
            history.push(msg);
          }
          if (history.length > 10) {
            history = history.slice(-10);
          }

          const myUser = getMyUser(client);
          const pending = getPendingConfirmation(phone);
          const rawText = (msg.body || '').trim();

          let classificationResult = null;

          // FAST-PATH A: If bot previously asked "ভয়েস?" and customer replies affirmatively ("জি", "জী", "হ্যাঁ", etc.)
          if (pending && pending.script && isAffirmativeConfirmation(rawText)) {
            console.log(`[CLASSIFIER] Fast-path affirmative confirmation for +${phone} ("${rawText}") confirming pending script`);
            classificationResult = {
              classification: 'VOICE_JOB',
              confidence: 'HIGH',
              extracted_script: pending.script,
              reason: `Customer affirmatively confirmed "${rawText}" to "ভয়েস?"`
            };
          } else if (pending && pending.script && isNegativeConfirmation(rawText)) {
            // FAST-PATH B: If bot previously asked "ভয়েস?" and customer declines ("না", "no", etc.)
            console.log(`[CLASSIFIER] Fast-path negative response for +${phone} ("${rawText}") declining voice`);
            classificationResult = {
              classification: 'ESCALATE',
              confidence: 'HIGH',
              extracted_script: pending.script,
              reason: `Customer declined voice ("${rawText}") in response to "ভয়েস?"`
            };
          } else {
            // Context injection: If pending script exists but fetched history is missing the prior question, inject it
            if (pending && pending.script) {
              const hasBotQuestion = history.some(m => (m.body || '').includes('ভয়েস?') || (m.body || '').includes('শুধু ভয়েস'));
              if (!hasBotQuestion) {
                console.log(`[CLASSIFIER] Injecting pending script and "ভয়েস?" into history for +${phone}`);
                history = [
                  { fromMe: false, body: pending.script },
                  { fromMe: true, body: 'ভয়েস?' },
                  ...history.filter(m => m.id?._serialized === msg.id?._serialized || m === msg)
                ];
              }
            }

            const aiClassifierEnabled = getBotSetting(db, 'ai_classifier_enabled', true);
            if (!aiClassifierEnabled) {
              console.log(`[CLASSIFIER] AI classifier disabled via bot settings. Skipping classification for +${phone}.`);
              return { action: 'CLASSIFIER_DISABLED' };
            }

            console.log(`[CLASSIFIER] Classifying ${history.length} messages for +${phone}. Latest: "${rawText.slice(0, 100)}"`);
            classificationResult = await activeClassifierFn({ messages: history, myUser });
          }

          console.log(`[CLASSIFIER] Result for +${phone}:`, JSON.stringify(classificationResult));
          const customerScriptMsgId = (pending && pending.customerScriptMsgId)
            ? pending.customerScriptMsgId
            : (msg.id?._serialized || msg.id?.id || null);

          const dispatchRes = await activeDispatchFn({
            client,
            chat,
            classificationResult,
            customerPhone: phone,
            customerName: contactName,
            latestMessageText: msg.body || '',
            db,
            customerScriptMsgId
          });
          return dispatchRes;
        }
      }
    } catch (err) {
      console.warn('[LEAD] Error checking/recording lead or classifying:', err.message);
    }

    return { action: 'IGNORED_NOT_FROM_ME' };
  }

  const recipient = msg.to || '';
  if (recipient.endsWith('@g.us') || msg.id?.remote?.endsWith('@g.us')) {
    return { action: 'IGNORED_GROUP' };
  }

  const cleanVa2 = String(config.VA2_PHONE || '8801307760509').replace(/\D/g, '');
  const toUser = extractUser(msg.to);
  const remoteUser = extractUser(msg.id?.remote);
  let isVa2 = toUser === cleanVa2 || remoteUser === cleanVa2 ||
    (recipient && recipient.replace(/\D/g, '').includes(cleanVa2)) ||
    (msg.id?.remote && String(msg.id.remote).replace(/\D/g, '').includes(cleanVa2));

  if (!isVa2 && (msg.to?.endsWith?.('@lid') || msg.id?.remote?.endsWith?.('@lid'))) {
    try {
      const resolved = await resolveCustomerPhone({ client, recipient: msg.to || msg.id?.remote, msg });
      if (resolved === cleanVa2) {
        isVa2 = true;
      }
    } catch {}
  }

  // Manual Outgoing Forward Tracking for VA2
  if (msg.fromMe === true && isVa2) {
    const isEchoOrSystem = isBotSystemMessage(msg.body) ||
      (msg.id?._serialized && (sentAutoBillMsgIds.has(msg.id._serialized) || sentSelfBotMsgIds.has(msg.id._serialized))) ||
      (msg.id?.id && (sentAutoBillMsgIds.has(msg.id.id) || sentSelfBotMsgIds.has(msg.id.id)));

    if (msg.body && !isEchoOrSystem && db) {
      const order = findVoiceJobOrderByScriptText(db, msg.body) || findLatestPendingVoiceJob(db);
      if (order) {
        const msgId = msg.id?._serialized || msg.id?.id || (typeof msg.id === 'string' ? msg.id : null);
        if (!order.va2_forward_msg_id || order.va2_forward_msg_id === msgId) {
          if (msgId) {
            updateVoiceJobVa2ForwardMsgId(db, order.order_id, msgId);
            console.log(`[VA2_FORWARD] Linked manual script message to order ${order.order_id}`);
          }
          return {
            action: 'LINKED_MANUAL_VA2_FORWARD',
            details: {
              orderId: order.order_id,
              va2ForwardMsgId: msgId
            }
          };
        }
      }
    }
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
      const autoBillingEnabled = getBotSetting(db, 'auto_audio_billing_enabled', true);
      if (!autoBillingEnabled) {
        console.log('[AUDIO_BILLING] Auto audio billing disabled via bot settings. Skipping billing.');
        return { action: 'AUDIO_BILLING_DISABLED' };
      }

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
  let heartbeatInterval = null;

  client.on('qr', (qr) => {
    console.log('Scan the QR code below to log in:');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', async () => {
    console.log('✅ WhatsApp Web Client is ready!');
    console.log(`Logged in as: ${client.info?.wid?.user}`);

    try {
      recordBotState(db, 'ONLINE', 'READY');
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      heartbeatInterval = setInterval(() => {
        try { heartbeatBotState(db); } catch {}
      }, 30000);
    } catch {}

    // Pre-cache bot's own LID for instant self-chat detection
    try {
      if (client?.pupPage && typeof client.pupPage.evaluate === 'function') {
        const myLidData = await client.pupPage.evaluate(() => {
          try {
            const lidWid = window.require('WAWebUserPrefsMeUser')?.getMaybeMeLidUser();
            return lidWid ? lidWid._serialized : null;
          } catch {
            return null;
          }
        });
        if (myLidData) {
          client.myLid = myLidData;
          client.myLidUser = extractUser(myLidData);
          console.log(`[BOT] Bot self LID registered: ${client.myLid} (${client.myLidUser})`);
        }
      }
    } catch (err) {
      console.warn('[BOT] Failed registering bot self LID:', err.message);
    }

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

    // Auto-sync all existing inbox chats and saved contacts so they never receive welcome demo
    try {
      await syncExistingInboxContacts({ client, db, resolveCustomerPhone });
    } catch (e) {
      console.warn('[SYNC] Error syncing existing contacts on ready:', e.message);
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
    try {
      if (state === 'CONNECTED') {
        recordBotState(db, 'ONLINE', 'STATE_CONNECTED');
      } else if (state === 'DISCONNECTED' || state === 'UNPAIRED') {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        recordBotState(db, 'OFFLINE', `STATE_${state}`);
      }
    } catch {}
  });

  client.on('disconnected', (reason) => {
    console.log('⚠️ Disconnected:', reason);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    try {
      recordBotState(db, 'OFFLINE', typeof reason === 'string' ? reason : 'DISCONNECTED');
    } catch {}
  });

  client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failed:', msg);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    try {
      recordBotState(db, 'OFFLINE', typeof msg === 'string' ? msg : 'AUTH_FAILURE');
    } catch {}
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
  syncExistingInboxContacts,
  sentAutoBillMsgIds,
  pendingAutoBills,
  isTestEnv,
  createMedia,
  isPhoneMatch
};
