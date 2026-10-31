const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  handleMessageCreate,
  getVoiceArtistPhones,
  isVaPhoneMatch,
  isVoiceArtistMessage
} = require('../src/bot');
const {
  initDb,
  createVoiceJobOrder,
  getVoiceJobOrder,
  getDueList,
  getCustomerTransactions,
  recordLead
} = require('../src/db');
const {
  extractDurationFromText,
  extractDurationFromFilename,
  calculateAudioBill,
  formatBillMessage
} = require('../src/audio');

describe('Voice Artist Recognition & Automated Billing Suite', () => {
  it('recognizes VA2 and VA3 phone numbers in getVoiceArtistPhones and isVaPhoneMatch', () => {
    const phones = getVoiceArtistPhones();
    assert.ok(phones.includes('8801307760509'), 'Must include VA2');
    assert.ok(phones.includes('8801844674843'), 'Must include VA3');

    assert.strictEqual(isVaPhoneMatch('8801307760509'), true);
    assert.strictEqual(isVaPhoneMatch('01307760509'), true);
    assert.strictEqual(isVaPhoneMatch('+8801307760509'), true);

    assert.strictEqual(isVaPhoneMatch('8801844674843'), true);
    assert.strictEqual(isVaPhoneMatch('01844674843'), true);
    assert.strictEqual(isVaPhoneMatch('+8801844674843'), true);

    assert.strictEqual(isVaPhoneMatch('8801700000000'), false);
  });

  it('isVoiceArtistMessage correctly identifies VA from phone, contact name, or LID', async () => {
    const db = initDb(':memory:');
    recordLead(db, { phone: '8801844674843', name: 'VA3' });
    recordLead(db, { phone: '208826091495661', name: 'VA3' });

    const isVa1 = await isVoiceArtistMessage({
      rawSender: '8801844674843@c.us',
      cleanSender: '8801844674843',
      db
    });
    assert.strictEqual(isVa1, true, 'VA3 phone should be recognized');

    const isVa2 = await isVoiceArtistMessage({
      rawSender: '208826091495661@lid',
      cleanSender: '208826091495661',
      db
    });
    assert.strictEqual(isVa2, true, 'VA3 LID should be recognized');

    const isRegular = await isVoiceArtistMessage({
      rawSender: '8801799887766@c.us',
      cleanSender: '8801799887766',
      db
    });
    assert.strictEqual(isRegular, false, 'Regular customer should not be VA');
    db.close();
  });

  it('extractDurationFromText accurately parses Bengali minutes and seconds', () => {
    assert.strictEqual(extractDurationFromText('১ মিনিট ৯ সেকেন্ড'), 69);
    assert.strictEqual(extractDurationFromText('১ মিনিট ৩৭ সেকেন্ড'), 97);
    assert.strictEqual(extractDurationFromText('২ মিনিট'), 120);
    assert.strictEqual(extractDurationFromText('৪৫ সেকেন্ড'), 45);
  });

  it('when VA3 sends duration text "১ মিনিট ৯ সেকেন্ড", bills customer 75 BDT, records transaction, and updates order', async () => {
    const db = initDb(':memory:');
    const order = createVoiceJobOrder(db, {
      customerPhone: '8801914934383',
      customerName: 'Customer Raypura',
      customerScriptMsgId: 'script-msg-001',
      va2ForwardMsgId: 'fwd-msg-va3-001',
      scriptText: 'রায়পুরায় নতুন স্বাস্থ্যসেবা কেন্দ্র',
      headline: 'রায়পুরায় স্বাস্থ্যসেবা'
    });

    const sentMessages = [];
    const mockClient = {
      info: { wid: { user: '8801340517587' } },
      sendMessage: async (jid, content, options) => {
        sentMessages.push({ jid, content, options });
        return { id: { _serialized: `msg-${Date.now()}` } };
      }
    };

    const va3Msg = {
      id: { _serialized: 'va3-duration-msg-01', id: 'va3-duration-msg-01' },
      fromMe: false,
      from: '8801844674843@c.us',
      to: '8801340517587@c.us',
      body: '১ মিনিট ৯ সেকেন্ড',
      hasMedia: false,
      type: 'chat'
    };

    const res = await handleMessageCreate({
      msg: va3Msg,
      client: mockClient,
      db
    });

    assert.strictEqual(res.action, 'DELIVERED_VA_DURATION_TEXT');
    assert.strictEqual(res.details.orderId, order.order_id);
    assert.strictEqual(res.details.customerPhone, '8801914934383');
    assert.strictEqual(res.details.durationSeconds, 69);

    // Verify bill message was sent to customer
    const customerBillMsg = sentMessages.find(m => m.jid === '8801914934383@c.us');
    assert.ok(customerBillMsg, 'Bill message must be sent to customer');
    assert.strictEqual(customerBillMsg.content, 'বিল ৭৫ টাকা');

    // Verify NO message was sent to VA3 (VA must NEVER receive customer bill confirmations or pricing)
    const vaConfirmMsg = sentMessages.find(m => m.jid === '8801844674843@c.us');
    assert.strictEqual(vaConfirmMsg, undefined, 'VA must NOT receive any bill confirmation or message');

    // Verify transaction in DB
    const txs = getCustomerTransactions(db, '8801914934383');
    assert.strictEqual(txs.length, 1);
    assert.strictEqual(txs[0].type, 'BILL');
    assert.strictEqual(txs[0].amount, 75);
    assert.strictEqual(txs[0].duration_seconds, 69);

    // Verify order was marked delivered
    const updatedOrder = getVoiceJobOrder(db, order.order_id);
    assert.strictEqual(updatedOrder.status, 'DELIVERED');
    assert.strictEqual(updatedOrder.clean_duration_seconds, 69);

    db.close();
  });

  it('when VA3 sends duration text "১ মিনিট ৩৭ সেকেন্ড", bills customer 100 BDT', async () => {
    const db = initDb(':memory:');
    const order = createVoiceJobOrder(db, {
      customerPhone: '8801914934383',
      customerName: 'Customer Raypura 2',
      customerScriptMsgId: 'script-msg-002',
      va2ForwardMsgId: 'fwd-msg-va3-002',
      scriptText: 'স্কুলে যাবে মানবিক স্বাস্থ্য দল',
      headline: 'স্কুলে যাবে'
    });

    const sentMessages = [];
    const mockClient = {
      info: { wid: { user: '8801340517587' } },
      sendMessage: async (jid, content, options) => {
        sentMessages.push({ jid, content, options });
        return { id: { _serialized: `msg-${Date.now()}` } };
      }
    };

    const va3Msg = {
      id: { _serialized: 'va3-duration-msg-02', id: 'va3-duration-msg-02' },
      fromMe: false,
      from: '8801844674843@c.us',
      to: '8801340517587@c.us',
      body: '১ মিনিট ৩৭ সেকেন্ড',
      hasMedia: false,
      type: 'chat'
    };

    const res = await handleMessageCreate({
      msg: va3Msg,
      client: mockClient,
      db
    });

    assert.strictEqual(res.action, 'DELIVERED_VA_DURATION_TEXT');
    assert.strictEqual(res.details.durationSeconds, 97);

    // Verify customer received 100 BDT bill
    const customerBillMsg = sentMessages.find(m => m.jid === '8801914934383@c.us');
    assert.ok(customerBillMsg);
    assert.strictEqual(customerBillMsg.content, 'বিল ১০০ টাকা');

    // Verify transaction in DB
    const txs = getCustomerTransactions(db, '8801914934383');
    assert.strictEqual(txs.length, 1);
    assert.strictEqual(txs[0].amount, 100);
    assert.strictEqual(txs[0].duration_seconds, 97);

    db.close();
  });

  it('when owner sends audio file to customer, marks pending voice job order as DELIVERED', async () => {
    const db = initDb(':memory:');
    const order = createVoiceJobOrder(db, {
      customerPhone: '8801914934383',
      customerName: 'Customer Test',
      customerScriptMsgId: 'script-msg-003',
      va2ForwardMsgId: 'fwd-003',
      scriptText: 'পরীক্ষামূলক অডিও স্ক্রিপ্ট',
      headline: 'পরীক্ষামূলক'
    });

    const sentMessages = [];
    const mockClient = {
      info: { wid: { user: '8801340517587' } },
      sendMessage: async (jid, content, options) => {
        sentMessages.push({ jid, content, options });
        return { id: { _serialized: `msg-${Date.now()}` } };
      }
    };

    const outgoingAudioMsg = {
      id: { _serialized: 'outgoing-audio-01', id: 'outgoing-audio-01', remote: '8801914934383@c.us' },
      fromMe: true,
      to: '8801914934383@c.us',
      from: '8801340517587@c.us',
      hasMedia: true,
      type: 'document',
      filename: 'পরীক্ষামূলক ১.৪.wav',
      mimetype: 'audio/wav',
      duration: 64
    };

    const res = await handleMessageCreate({
      msg: outgoingAudioMsg,
      client: mockClient,
      db
    });

    assert.strictEqual(res.action, 'SENT_AUDIO_BILL');
    assert.strictEqual(res.details.billAmount, 50);

    // Verify bill was sent
    const billMsg = sentMessages.find(m => m.jid === '8801914934383@c.us');
    assert.ok(billMsg);
    assert.strictEqual(billMsg.content, 'বিল ৫০ টাকা');

    // Verify order was marked delivered
    const updatedOrder = getVoiceJobOrder(db, order.order_id);
    assert.strictEqual(updatedOrder.status, 'DELIVERED');
    assert.strictEqual(updatedOrder.clean_duration_seconds, 64);

    db.close();
  });

  it('when owner sends audio file from mobile device (with device LID author), it is NOT dropped as a group message', async () => {
    const db = initDb(':memory:');
    const order = createVoiceJobOrder(db, {
      customerPhone: '8801914934383',
      customerName: 'Mobile Send Test',
      customerScriptMsgId: 'script-msg-mobile-01',
      va2ForwardMsgId: 'fwd-mobile-01',
      scriptText: 'মোবাইল থেকে পাঠানো স্ক্রিপ্ট',
      headline: 'মোবাইল টেস্ট'
    });

    const sentMessages = [];
    const mockClient = {
      info: { wid: { user: '8801340517587' } },
      sendMessage: async (jid, content, options) => {
        sentMessages.push({ jid, content, options });
        return { id: { _serialized: `msg-${Date.now()}` } };
      }
    };

    // Realistic WhatsApp Multi-Device message sent from linked mobile phone
    const outgoingFromMobile = {
      id: {
        _serialized: 'true_8801914934383@c.us_3EB01234567890ABCDEF',
        id: '3EB01234567890ABCDEF',
        remote: '8801914934383@c.us',
        participant: '96950900789260@lid'
      },
      fromMe: true,
      from: '8801340517587@c.us',
      to: '8801914934383@c.us',
      author: '96950900789260@lid',
      hasMedia: true,
      type: 'document',
      filename: 'জামালপুরে ১.৪  .wav',
      mimetype: 'audio/wav'
      // note: duration property intentionally omitted to test filename extraction!
    };

    const res = await handleMessageCreate({
      msg: outgoingFromMobile,
      client: mockClient,
      db
    });

    assert.notStrictEqual(res.action, 'IGNORED_GROUP', 'Must not be classified as a group message!');
    assert.strictEqual(res.action, 'SENT_AUDIO_BILL');
    assert.strictEqual(res.details.billAmount, 50);
    assert.strictEqual(res.details.duration, 64);

    // Verify bill was sent to customer
    const billMsg = sentMessages.find(m => m.jid === '8801914934383@c.us');
    assert.ok(billMsg, 'Bill message must be sent to customer chat');
    assert.strictEqual(billMsg.content, 'বিল ৫০ টাকা');

    // Verify order was marked delivered
    const updatedOrder = getVoiceJobOrder(db, order.order_id);
    assert.strictEqual(updatedOrder.status, 'DELIVERED');
    assert.strictEqual(updatedOrder.clean_duration_seconds, 64);

    db.close();
  });

  it('when owner sends audio file to customer using LID chat, sends bill directly to LID chat', async () => {
    const db = initDb(':memory:');
    const sentMessages = [];
    const mockClient = {
      info: { wid: { user: '8801340517587' } },
      sendMessage: async (jid, content, options) => {
        sentMessages.push({ jid, content, options });
        return { id: { _serialized: `msg-${Date.now()}` } };
      }
    };

    const outgoingToLid = {
      id: {
        _serialized: 'true_12345678901234@lid_3EB0999999999999',
        id: '3EB0999999999999',
        remote: '12345678901234@lid'
      },
      fromMe: true,
      from: '8801340517587@c.us',
      to: '12345678901234@lid',
      hasMedia: true,
      type: 'document',
      filename: 'ভয়েস ১.২৫ .mp3',
      mimetype: 'audio/mp3'
    };

    const res = await handleMessageCreate({
      msg: outgoingToLid,
      client: mockClient,
      db
    });

    assert.strictEqual(res.action, 'SENT_AUDIO_BILL');
    assert.strictEqual(res.details.billAmount, 100); // 1.25 -> 85s -> 2 min -> 100 BDT
    assert.strictEqual(res.details.targetChat, '12345678901234@lid');

    const billMsg = sentMessages.find(m => m.jid === '12345678901234@lid');
    assert.ok(billMsg, 'Bill message must be sent to the LID chat');
    assert.strictEqual(billMsg.content, 'বিল ১০০ টাকা');

    db.close();
  });

  it('prevents duplicate billing when automated bill echo or forwarded audio arrives via message_create', async () => {
    const db = initDb(':memory:');
    const sentMessages = [];
    const mockClient = {
      info: { wid: { user: '8801340517587' } },
      getContactById: async (jid) => {
        return {
          id: { _serialized: '8801984926697@c.us' },
          number: '8801984926697',
          name: 'South Bangla Times'
        };
      },
      sendMessage: async (jid, content, options) => {
        sentMessages.push({ jid, content, options });
        return { id: { _serialized: `msg-${Date.now()}` } };
      }
    };

    // 1. First: audio file is sent to customer via LID chat
    const outgoingAudio = {
      id: {
        _serialized: 'true_158931724828876@lid_3EB0CCE9EEA04AD7E639B0',
        id: '3EB0CCE9EEA04AD7E639B0',
        remote: '158931724828876@lid'
      },
      fromMe: true,
      from: '8801340517587@c.us',
      to: '158931724828876@lid',
      hasMedia: true,
      type: 'document',
      filename: 'মেহেন্দীগঞ্জের ২.৪৬ .wav',
      mimetype: 'audio/wav'
    };

    const firstRes = await handleMessageCreate({
      msg: outgoingAudio,
      client: mockClient,
      db
    });
    assert.strictEqual(firstRes.action, 'SENT_AUDIO_BILL');
    assert.strictEqual(firstRes.details.billAmount, 150);

    // 2. Second: identical audio or echo arrives from multi-device sync
    const echoAudio = {
      id: {
        _serialized: 'true_158931724828876@lid_3EB0CCE9EEA04AD7E639B0',
        id: '3EB0CCE9EEA04AD7E639B0',
        remote: '158931724828876@lid'
      },
      fromMe: true,
      from: '8801340517587@c.us',
      to: '158931724828876@lid',
      hasMedia: true,
      type: 'document',
      filename: 'মেহেন্দীগঞ্জের ২.৪৬ .wav',
      mimetype: 'audio/wav'
    };

    const secondRes = await handleMessageCreate({
      msg: echoAudio,
      client: mockClient,
      db
    });
    assert.strictEqual(secondRes.action, 'IGNORED_ALREADY_BILLED');

    // 3. Third: echo of the automated bill message "বিল ১৫০ টাকা" arrives from multi-device sync
    const billEcho = {
      id: {
        _serialized: 'true_158931724828876@lid_3EB0E92215537DBEEDBA92',
        id: '3EB0E92215537DBEEDBA92',
        remote: '158931724828876@lid'
      },
      fromMe: true,
      from: '8801340517587@c.us',
      to: '158931724828876@lid',
      body: 'বিল ১৫০ টাকা',
      type: 'chat'
    };

    const thirdRes = await handleMessageCreate({
      msg: billEcho,
      client: mockClient,
      db
    });
    assert.strictEqual(thirdRes.action, 'IGNORED_ECHO_AUTO_BILL');

    // Verify only ONE transaction exists in DB for this customer
    const txs = getCustomerTransactions(db, '8801984926697');
    assert.strictEqual(txs.length, 1);
    assert.strictEqual(txs[0].amount, 150);

    db.close();
  });
});
