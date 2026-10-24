const { describe, it } = require('node:test');
const assert = require('node:assert');
const { initDb, getDueList, createVoiceJobOrder, getVoiceJobOrder } = require('../src/db');
const {
  formatDueReport,
  handleMessageCreate,
  handleMessageRevoke,
  getCandidateMessageIds
} = require('../src/bot');

describe('Bot Message Router', () => {
  it('formatDueReport formats list nicely in Bengali', () => {
    const list = [
      { phone_number: '8801712345678', name: 'করিম', due_amount: 400 },
      { phone_number: '8801812345678', name: null, due_amount: 150 }
    ];
    const report = formatDueReport(list);
    assert.ok(report.includes('📋 *বকেয়া তালিকা (Due List)*'));
    assert.ok(report.includes('8801712345678 (করিম): ৪০০ টাকা'));
    assert.ok(report.includes('8801812345678: ১৫০ টাকা'));
    assert.ok(report.includes('মোট বকেয়া: ৫৫০ টাকা (২ জন গ্রাহক)'));
  });

  it('formatDueReport rounds floating-point totalDue to avoid float inaccuracies', () => {
    // 10.1 + 20.2 === 30.299999999999997 in IEEE 754
    const list = [
      { phone_number: '8801711111111', name: null, due_amount: 10.1 },
      { phone_number: '8801722222222', name: null, due_amount: 20.2 }
    ];
    const report = formatDueReport(list);
    assert.ok(report.includes('মোট বকেয়া: ৩০.৩ টাকা (২ জন গ্রাহক)'));
    assert.strictEqual(report.includes('৩০.২৯৯৯৯৯'), false);
  });

  it('formatDueReport handles empty list', () => {
    const report = formatDueReport([]);
    assert.strictEqual(report, '✅ বর্তমানে কোনো গ্রাহকের বকেয়া নেই!');
  });

  it('ignores incoming messages from customer (fromMe === false)', async () => {
    const db = initDb(':memory:');
    const msg = { fromMe: false, body: 'বিল ৩০ টাকা', to: '8801700000000@c.us' };
    const res = await handleMessageCreate({ msg, client: {}, db });
    assert.strictEqual(res.action, 'IGNORED_NOT_FROM_ME');
  });

  it('ignores group messages', async () => {
    const db = initDb(':memory:');
    const msg = { fromMe: true, body: 'বিল ৩০ টাকা', to: '123456789-group@g.us' };
    const res = await handleMessageCreate({ msg, client: {}, db });
    assert.strictEqual(res.action, 'IGNORED_GROUP');
  });

  it('strictly ignores inbound group messages and never calls classifier or escalates', async () => {
    const db = initDb(':memory:');
    let classifierCalled = false;
    const classifierFn = async () => {
      classifierCalled = true;
      return { classification: 'OTHER', confidence: 'HIGH' };
    };

    // Case 1: WhatsApp Multi-device group message with author and 120363 JID
    const groupMsg1 = {
      fromMe: false,
      from: '120363229586789471@g.us',
      author: '8801700000001@c.us',
      id: { remote: '120363229586789471@g.us:1', participant: '8801700000001@c.us' },
      body: 'https://somewebsite.com/news-story',
      isGroup: true
    };
    const res1 = await handleMessageCreate({
      msg: groupMsg1,
      client: { info: { wid: { _serialized: '8801999999999@c.us' } } },
      db,
      classifierFn
    });
    assert.strictEqual(res1.action, 'IGNORED_GROUP');
    assert.strictEqual(classifierCalled, false, 'AI classifier must NOT be invoked for group messages');

    // Case 2: Inbound group message without isGroup flag but with @g.us in id.remote
    const groupMsg2 = {
      fromMe: false,
      from: '8801700000002@c.us',
      id: { remote: '120363000000000000@g.us' },
      body: 'Important group alert'
    };
    const res2 = await handleMessageCreate({
      msg: groupMsg2,
      client: { info: { wid: { _serialized: '8801999999999@c.us' } } },
      db,
      classifierFn
    });
    assert.strictEqual(res2.action, 'IGNORED_GROUP');
    assert.strictEqual(classifierCalled, false);

    // Case 3: Broadcast or newsletter message
    const broadcastMsg = {
      fromMe: false,
      from: 'status@broadcast',
      body: 'Status update'
    };
    const res3 = await handleMessageCreate({
      msg: broadcastMsg,
      client: { info: { wid: { _serialized: '8801999999999@c.us' } } },
      db,
      classifierFn
    });
    assert.strictEqual(res3.action, 'IGNORED_GROUP');
    assert.strictEqual(classifierCalled, false);
  });

  it('silently records bill in customer chat without replying', async () => {
    const db = initDb(':memory:');
    let replyCalled = false;
    const msg = {
      fromMe: true,
      body: 'বিল ৪০০ টাকা',
      to: '8801712345678@c.us',
      reply: () => { replyCalled = true; }
    };
    const client = {
      info: { wid: { _serialized: '8801999999999@c.us' } },
      getContactById: async () => ({ name: 'Test Customer', pushname: 'Customer' })
    };

    const res = await handleMessageCreate({ msg, client, db });
    assert.strictEqual(res.action, 'RECORDED_BILL');
    assert.strictEqual(res.details.amount, 400);
    assert.strictEqual(res.details.phone, '8801712345678');
    assert.strictEqual(replyCalled, false, 'Should be completely silent in customer chat');
  });

  it('silently records payment in customer chat without replying', async () => {
    const db = initDb(':memory:');
    let replyCalled = false;
    const msg = {
      fromMe: true,
      body: '৫৬ টাকা পেয়েছি, ধন্যবাদ',
      to: '8801712345678@c.us',
      reply: () => { replyCalled = true; }
    };
    const client = {
      info: { wid: { _serialized: '8801999999999@c.us' } },
      getContactById: async () => ({ name: 'Test Customer' })
    };

    const res = await handleMessageCreate({ msg, client, db });
    assert.strictEqual(res.action, 'RECORDED_PAYMENT');
    assert.strictEqual(res.details.amount, 56);
    assert.strictEqual(replyCalled, false);
  });

  it('sets total due for a new customer when বকেয়া ২৩০০ টাকা is sent (adds bill of 2300)', async () => {
    const db = initDb(':memory:');
    const msg = {
      fromMe: true,
      body: 'বকেয়া ২৩০০ টাকা',
      to: '8801712345678@c.us'
    };
    const client = {
      info: { wid: { _serialized: '8801999999999@c.us' } },
      getContactById: async () => ({ name: 'Test Customer' })
    };

    const res = await handleMessageCreate({ msg, client, db });
    assert.strictEqual(res.action, 'SET_DUE_ADJUSTED');
    assert.strictEqual(res.details.targetDue, 2300);
    assert.strictEqual(res.details.adjustmentType, 'BILL');
    assert.strictEqual(res.details.adjustmentAmount, 2300);
    assert.strictEqual(res.details.dueAmount, 2300);

    const dueList = getDueList(db);
    assert.strictEqual(dueList.length, 1);
    assert.strictEqual(dueList[0].due_amount, 2300);
  });

  it('adjusts total due upward when customer already has due (e.g. 500 Tk due + বকেয়া ২৩০০ টাকা -> adds bill 1800 Tk)', async () => {
    const db = initDb(':memory:');
    const client = {
      info: { wid: { _serialized: '8801999999999@c.us' } },
      getContactById: async () => ({ name: 'Test Customer' })
    };

    // Customer has initial bill of 500
    await handleMessageCreate({
      msg: { fromMe: true, body: 'বিল ৫০০ টাকা', to: '8801712345678@c.us' },
      client,
      db
    });

    // Now set total due to 2300
    const res = await handleMessageCreate({
      msg: { fromMe: true, body: 'বকেয়া ২৩০০ টাকা', to: '8801712345678@c.us' },
      client,
      db
    });

    assert.strictEqual(res.action, 'SET_DUE_ADJUSTED');
    assert.strictEqual(res.details.previousDue, 500);
    assert.strictEqual(res.details.adjustmentType, 'BILL');
    assert.strictEqual(res.details.adjustmentAmount, 1800);
    assert.strictEqual(res.details.dueAmount, 2300);

    const dueList = getDueList(db);
    assert.strictEqual(dueList[0].due_amount, 2300);
  });

  it('adjusts total due downward when customer has higher due (e.g. 3000 Tk due + বকেয়া ২৩০০ টাকা -> adds payment 700 Tk)', async () => {
    const db = initDb(':memory:');
    const client = {
      info: { wid: { _serialized: '8801999999999@c.us' } },
      getContactById: async () => ({ name: 'Test Customer' })
    };

    // Customer has initial bill of 3000
    await handleMessageCreate({
      msg: { fromMe: true, body: 'বিল ৩০০০ টাকা', to: '8801712345678@c.us' },
      client,
      db
    });

    // Now set total due to 2300
    const res = await handleMessageCreate({
      msg: { fromMe: true, body: 'বকেয়া ২৩০০ টাকা', to: '8801712345678@c.us' },
      client,
      db
    });

    assert.strictEqual(res.action, 'SET_DUE_ADJUSTED');
    assert.strictEqual(res.details.previousDue, 3000);
    assert.strictEqual(res.details.adjustmentType, 'PAYMENT');
    assert.strictEqual(res.details.adjustmentAmount, 700);
    assert.strictEqual(res.details.dueAmount, 2300);

    const dueList = getDueList(db);
    assert.strictEqual(dueList[0].due_amount, 2300);
  });

  it('does not create new transaction if customer already has exactly the target due', async () => {
    const db = initDb(':memory:');
    const client = {
      info: { wid: { _serialized: '8801999999999@c.us' } },
      getContactById: async () => ({ name: 'Test Customer' })
    };

    // Customer has initial bill of 2300
    await handleMessageCreate({
      msg: { fromMe: true, body: 'বিল ২৩০০ টাকা', to: '8801712345678@c.us' },
      client,
      db
    });

    // Send 'বকেয়া ২৩০০ টাকা' when balance is already 2300
    const res = await handleMessageCreate({
      msg: { fromMe: true, body: 'বকেয়া ২৩০০ টাকা', to: '8801712345678@c.us' },
      client,
      db
    });

    assert.strictEqual(res.action, 'SET_DUE_UNCHANGED');
    assert.strictEqual(res.details.dueAmount, 2300);
  });

  it('replies with due list when !due command sent to self-chat', async () => {
    const db = initDb(':memory:');
    const ownerWid = '8801999999999@c.us';
    let replyMessage = '';

    // First record a bill for a customer
    const msgBill = {
      fromMe: true,
      body: 'বিল ৫০০ টাকা',
      to: '8801712345678@c.us',
      reply: () => {}
    };
    const client = {
      info: { wid: { _serialized: ownerWid } },
      getContactById: async () => ({ name: 'করিম' })
    };
    await handleMessageCreate({ msg: msgBill, client, db });

    // Now send !due in self-chat
    const msgDue = {
      fromMe: true,
      body: '!due',
      to: ownerWid,
      reply: (text) => { replyMessage = text; }
    };

    const res = await handleMessageCreate({ msg: msgDue, client, db });
    assert.strictEqual(res.action, 'RESPONDED_DUE_LIST');
    assert.ok(replyMessage.includes('8801712345678 (করিম): ৫০০ টাকা'));
  });

  it('replies with due list when !due command sent to self-chat with multi-device companion ID (:1@c.us)', async () => {
    const db = initDb(':memory:');
    let sentMessage = '';
    let targetRecipient = '';
    const client = {
      info: { wid: { _serialized: '8801999999999:1@c.us', user: '8801999999999' } },
      sendMessage: async (to, text) => {
        targetRecipient = to;
        sentMessage = text;
      }
    };
    const msg = {
      fromMe: true,
      body: '!due',
      to: '8801999999999@c.us',
      from: '8801999999999:1@c.us',
      id: { remote: '8801999999999@c.us' },
      reply: (text) => { sentMessage = text; }
    };

    const res = await handleMessageCreate({ msg, client, db });
    assert.strictEqual(res.action, 'RESPONDED_DUE_LIST');
    assert.ok(sentMessage.includes('বর্তমানে কোনো গ্রাহকের বকেয়া নেই'));
    assert.strictEqual(targetRecipient, '8801999999999@c.us');
  });

  it('replies with due list when !due is sent from phone in self-chat where fromMe might be false in sync', async () => {
    const db = initDb(':memory:');
    let sentMessage = '';
    const client = {
      info: { wid: { _serialized: '8801999999999:2@c.us', user: '8801999999999' } },
      sendMessage: async (to, text) => {
        sentMessage = text;
      }
    };
    const msg = {
      fromMe: false,
      body: '!due',
      to: '8801999999999@c.us',
      from: '8801999999999@c.us',
      id: { remote: '8801999999999@c.us' }
    };

    const res = await handleMessageCreate({ msg, client, db });
    assert.strictEqual(res.action, 'RESPONDED_DUE_LIST');
    assert.ok(sentMessage.includes('বর্তমানে কোনো গ্রাহকের বকেয়া নেই'));
  });

  it('replies with help menu when "help" or "menu" sent to self-chat', async () => {
    const db = initDb(':memory:');
    let sentMessage = '';
    const client = {
      info: { wid: { _serialized: '8801999999999@c.us', user: '8801999999999' } },
      sendMessage: async (to, text) => {
        sentMessage = text;
      }
    };
    const msg = {
      fromMe: true,
      body: 'help',
      to: '8801999999999@c.us',
      id: { remote: '8801999999999@c.us' }
    };

    const res = await handleMessageCreate({ msg, client, db });
    assert.strictEqual(res.action, 'RESPONDED_HELP');
    assert.ok(sentMessage.includes('মুন্নিসফট বট সেলফ-চ্যাট কমান্ড'));
    assert.ok(sentMessage.includes('due'));
    assert.ok(sentMessage.includes('video'));
  });

  it('replies with bot status when "status" or "ping" sent to self-chat', async () => {
    const db = initDb(':memory:');
    const { recordBotState } = require('../src/db');
    recordBotState(db, 'ONLINE');
    let sentMessage = '';
    const client = {
      info: { wid: { _serialized: '8801999999999@c.us', user: '8801999999999' } },
      sendMessage: async (to, text) => {
        sentMessage = text;
      }
    };
    const msg = {
      fromMe: true,
      body: 'ping',
      to: '8801999999999@c.us',
      id: { remote: '8801999999999@c.us' }
    };

    const res = await handleMessageCreate({ msg, client, db });
    assert.strictEqual(res.action, 'RESPONDED_STATUS');
    assert.ok(sentMessage.includes('মুন্নিসফট বট স্ট্যাটাস'));
    assert.ok(sentMessage.includes('ONLINE'));
  });

  it('replies with stats summary when "stats" sent to self-chat', async () => {
    const db = initDb(':memory:');
    let sentMessage = '';
    const client = {
      info: { wid: { _serialized: '8801999999999@c.us', user: '8801999999999' } },
      sendMessage: async (to, text) => {
        sentMessage = text;
      }
    };
    const msg = {
      fromMe: true,
      body: 'stats',
      to: '8801999999999@c.us',
      id: { remote: '8801999999999@c.us' }
    };

    const res = await handleMessageCreate({ msg, client, db });
    assert.strictEqual(res.action, 'RESPONDED_STATS');
    assert.ok(sentMessage.includes('আজকের লেজার সারসংক্ষেপ'));
    assert.ok(sentMessage.includes('মোট বকেয়া'));
  });

  it('replies with command guidance when unrecognized message sent to self-chat', async () => {
    const db = initDb(':memory:');
    let sentMessage = '';
    const client = {
      info: { wid: { _serialized: '8801999999999@c.us', user: '8801999999999' } },
      sendMessage: async (to, text) => {
        sentMessage = text;
      }
    };
    const msg = {
      fromMe: true,
      body: 'hello what can you do',
      to: '8801999999999@c.us',
      id: { remote: '8801999999999@c.us' }
    };

    const res = await handleMessageCreate({ msg, client, db });
    assert.strictEqual(res.action, 'RESPONDED_UNKNOWN_SELF_COMMAND');
    assert.ok(sentMessage.includes('কমান্ড বুঝতে পারিনি'));
    assert.ok(sentMessage.includes('help'));
  });

  it('does not treat outgoing escalation message to VE3 as self-chat, even with LID remote and isMe contact', async () => {
    const db = initDb(':memory:');
    let sentMessage = '';
    const client = {
      myLid: '96950900789260@lid',
      info: { wid: { _serialized: '8801340517587@c.us', user: '8801340517587' } },
      sendMessage: async (to, text) => {
        sentMessage = text;
      }
    };
    const msgVe3 = {
      fromMe: true,
      to: '8801831366604@c.us',
      from: '8801340517587@c.us',
      id: { remote: '150414083264675@lid', _serialized: 'VE3_OUTBOUND_123' },
      body: '[সহায়তা প্রয়োজন / Customer Escalation]\nগ্রাহক: +120363229586789471 (Dhaka Post)\nমেসেজ: https://www.dhakapost.com/sports/492316',
      getContact: async () => ({ isMe: true })
    };

    const res = await handleMessageCreate({ msg: msgVe3, client, db });
    assert.strictEqual(res.action, 'IGNORED_UNMATCHED');
    assert.strictEqual(sentMessage, '');
  });

  it('ignores bot-generated system messages in self-chat to prevent echo loops', async () => {
    const db = initDb(':memory:');
    let sentMessage = '';
    const client = {
      myLid: '96950900789260@lid',
      info: { wid: { _serialized: '8801340517587@c.us', user: '8801340517587' } },
      sendMessage: async (to, text) => {
        sentMessage = text;
      }
    };
    const msgEcho = {
      fromMe: true,
      to: '96950900789260@lid',
      id: { remote: '96950900789260@lid', _serialized: 'BOT_REPLY_123' },
      body: 'ℹ️ কমান্ড বুঝতে পারিনি: "foo"\n\nউপলব্ধ কমান্ড তালিকা দেখতে *help* লিখুন'
    };

    const res = await handleMessageCreate({ msg: msgEcho, client, db });
    assert.strictEqual(res.action, 'IGNORED_SELF_BOT_MESSAGE');
    assert.strictEqual(sentMessage, '');
  });

  it('detects self-chat correctly when chat remote is an @lid JID matching client.myLid', async () => {
    const db = initDb(':memory:');
    let sentMessage = '';
    let targetRecipient = '';
    const client = {
      myLid: '123456789012345@lid',
      info: { wid: { _serialized: '8801999999999@c.us', user: '8801999999999' } },
      sendMessage: async (to, text) => {
        targetRecipient = to;
        sentMessage = text;
      }
    };
    const msg = {
      fromMe: true,
      body: 'due',
      to: '123456789012345@lid',
      id: { remote: '123456789012345@lid' }
    };

    const res = await handleMessageCreate({ msg, client, db });
    assert.strictEqual(res.action, 'RESPONDED_DUE_LIST');
    assert.ok(sentMessage.includes('বর্তমানে কোনো গ্রাহকের বকেয়া নেই'));
    assert.strictEqual(targetRecipient, '123456789012345@lid');
  });

  it('strictly strips only trailing @c.us suffix from recipient JID', async () => {
    const db = initDb(':memory:');
    const msg = {
      fromMe: true,
      body: 'বিল ১০০ টাকা',
      to: '8801712345678@c.us',
      reply: () => {}
    };
    const client = {
      info: { wid: { _serialized: '8801999999999@c.us' } },
      getContactById: async () => null
    };

    const res = await handleMessageCreate({ msg, client, db });
    assert.strictEqual(res.details.phone, '8801712345678');
  });

  it('resolves actual phone number from @lid recipient using client.getContactLidAndPhone', async () => {
    const db = initDb(':memory:');
    const msg = {
      fromMe: true,
      body: 'বিল ৫০০ টাকা',
      to: '149181746389200@lid',
      reply: () => {}
    };
    const client = {
      info: { wid: { _serialized: '8801999999999@c.us', user: '8801999999999' } },
      getContactLidAndPhone: async (lid) => {
        return [{ lid: '149181746389200@lid', pn: '8801712345678@c.us' }];
      },
      getContactById: async () => ({ name: 'Preenan' })
    };

    const res = await handleMessageCreate({ msg, client, db });
    assert.strictEqual(res.action, 'RECORDED_BILL');
    assert.strictEqual(res.details.phone, '8801712345678');
  });

  it('resolves actual phone number from @lid recipient using getContactById fallback', async () => {
    const db = initDb(':memory:');
    const msg = {
      fromMe: true,
      body: 'বিল ৩০০ টাকা',
      to: '149181746389200@lid',
      reply: () => {}
    };
    const client = {
      info: { wid: { _serialized: '8801999999999@c.us', user: '8801999999999' } },
      getContactLidAndPhone: async () => [],
      getContactById: async () => ({ number: '8801812345678', name: 'User' })
    };

    const res = await handleMessageCreate({ msg, client, db });
    assert.strictEqual(res.action, 'RECORDED_BILL');
    assert.strictEqual(res.details.phone, '8801812345678');
  });

  it('auto-migrates existing transaction with LID identifier when real phone is resolved', async () => {
    const db = initDb(':memory:');
    const { recordTransaction, getCustomerSummary } = require('../src/db');

    // Simulate prior bill stored under LID
    recordTransaction(db, {
      phone: '149181746389200@lid',
      name: 'Preenan',
      type: 'BILL',
      amount: 34,
      rawText: 'বিল ৩৪ টাকা'
    });

    // Now payment arrives with LID, but resolved to real phone number
    const msg = {
      fromMe: true,
      body: '৩৪ টাকা পেয়েছি, ধন্যবাদ',
      to: '149181746389200@lid',
      reply: () => {}
    };
    const client = {
      info: { wid: { _serialized: '8801999999999@c.us', user: '8801999999999' } },
      getContactLidAndPhone: async () => [{ lid: '149181746389200@lid', pn: '8801712345678@c.us' }],
      getContactById: async () => ({ name: 'Preenan' })
    };

    const res = await handleMessageCreate({ msg, client, db });
    assert.strictEqual(res.action, 'RECORDED_PAYMENT');
    assert.strictEqual(res.details.phone, '8801712345678');

    // Both bill and payment should now be merged under 8801712345678
    const summary = getCustomerSummary(db, '8801712345678');
    assert.ok(summary);
    assert.strictEqual(summary.total_bill, 34);
    assert.strictEqual(summary.total_paid, 34);
    assert.strictEqual(summary.due_amount, 0);

    // Old LID record should be gone
    assert.strictEqual(getCustomerSummary(db, '149181746389200@lid'), null);
  });

  describe('Audio Document Duration Handling', () => {
    function createWavBuffer(durationSeconds = 1) {
      const sampleRate = 8000;
      const numChannels = 1;
      const bitsPerSample = 8;
      const dataSize = Math.round(durationSeconds * sampleRate * numChannels * (bitsPerSample / 8));
      const buffer = Buffer.alloc(44 + dataSize);

      buffer.write('RIFF', 0);
      buffer.writeUInt32LE(36 + dataSize, 4);
      buffer.write('WAVE', 8);
      buffer.write('fmt ', 12);
      buffer.writeUInt32LE(16, 16);
      buffer.writeUInt16LE(1, 20);
      buffer.writeUInt16LE(numChannels, 22);
      buffer.writeUInt32LE(sampleRate, 24);
      buffer.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
      buffer.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
      buffer.writeUInt16LE(bitsPerSample, 34);
      buffer.write('data', 36);
      buffer.writeUInt32LE(dataSize, 40);

      return buffer;
    }

    it('calculates duration, records bill in DB, and sends bill message when outgoing audio document is sent', async () => {
      const db = initDb(':memory:');
      const wavBuffer = createWavBuffer(135); // 2 minutes 15 seconds -> 2.5 min = 125 Taka
      let sentTo = null;
      let sentMessage = null;

      const client = {
        info: { wid: { _serialized: '8801999999999@c.us', user: '8801999999999' } },
        sendMessage: async (to, text) => {
          sentTo = to;
          sentMessage = text;
          return { id: { _serialized: `true_${to}_msg1` } };
        }
      };

      const msg = {
        fromMe: true,
        hasMedia: true,
        type: 'document',
        isVoice: false,
        mimetype: 'audio/wav',
        filename: 'recording.wav',
        to: '8801712345678@c.us',
        id: { remote: '8801712345678@c.us' },
        downloadMedia: async () => ({
          data: wavBuffer.toString('base64'),
          mimetype: 'audio/wav',
          filename: 'recording.wav'
        })
      };

      const res = await handleMessageCreate({ msg, client, db });
      assert.strictEqual(res.action, 'SENT_AUDIO_BILL');
      assert.strictEqual(sentTo, '8801712345678@c.us');
      assert.strictEqual(sentMessage, 'বিল ১২৫ টাকা');
      assert.strictEqual(res.details.billAmount, 125);
      assert.strictEqual(res.details.dueAmount, 125);

      // Verify transaction recorded in SQLite
      const dues = getDueList(db);
      assert.strictEqual(dues.length, 1);
      assert.strictEqual(dues[0].phone_number, '8801712345678');
      assert.strictEqual(dues[0].due_amount, 125);

      const tx = db.prepare('SELECT * FROM transactions WHERE phone_number = ?').get('8801712345678');
      assert.strictEqual(tx.job_type, 'voice');
      assert.strictEqual(tx.duration_seconds, 135);
    });

    it('prevents duplicate recording when auto-sent bill message echoes back on message_create', async () => {
      const db = initDb(':memory:');
      const client = {
        info: { wid: { _serialized: '8801999999999@c.us', user: '8801999999999' } },
        sendMessage: async (to, text) => ({
          id: { _serialized: 'true_8801712345678@c.us_sentAuto999', id: 'sentAuto999' }
        })
      };

      // 1. Send outgoing audio document of 90s (1:30 -> 2 min = 100 Taka)
      const audioMsg = {
        fromMe: true,
        hasMedia: true,
        type: 'document',
        isVoice: false,
        filename: 'recording.mp3',
        duration: 90,
        to: '8801712345678@c.us',
        id: { remote: '8801712345678@c.us' },
        downloadMedia: async () => {
          throw new Error('r: r');
        }
      };

      const resAudio = await handleMessageCreate({ msg: audioMsg, client, db });
      assert.strictEqual(resAudio.action, 'SENT_AUDIO_BILL');
      assert.strictEqual(resAudio.details.billAmount, 100);

      // Verify exactly 100 Taka due
      let dues = getDueList(db);
      assert.strictEqual(dues.length, 1);
      assert.strictEqual(dues[0].due_amount, 100);

      // 2. Simulate echo of the sent message arriving on message_create
      const echoMsg = {
        fromMe: true,
        body: 'বিল ১০০ টাকা',
        to: '8801712345678@c.us',
        id: {
          _serialized: 'true_8801712345678@c.us_sentAuto999',
          id: 'sentAuto999',
          remote: '8801712345678@c.us'
        }
      };

      const resEcho = await handleMessageCreate({ msg: echoMsg, client, db });
      assert.strictEqual(resEcho.action, 'IGNORED_ECHO_AUTO_BILL');

      // Verify ledger was NOT duplicated (still 100 Taka, not 200)
      dues = getDueList(db);
      assert.strictEqual(dues.length, 1);
      assert.strictEqual(dues[0].due_amount, 100);
    });

    it('ignores outgoing voice note / ptt and does not calculate duration', async () => {
      const db = initDb(':memory:');
      let sendMessageCalled = false;

      const client = {
        info: { wid: { _serialized: '8801999999999@c.us', user: '8801999999999' } },
        sendMessage: async () => {
          sendMessageCalled = true;
        }
      };

      const msg = {
        fromMe: true,
        hasMedia: true,
        type: 'ptt',
        isVoice: true,
        mimetype: 'audio/ogg; codecs=opus',
        to: '8801712345678@c.us'
      };

      const res = await handleMessageCreate({ msg, client, db });
      assert.strictEqual(res.action, 'IGNORED_UNMATCHED');
      assert.strictEqual(sendMessageCalled, false);
    });

    it('ignores incoming audio document from customer (fromMe === false)', async () => {
      const db = initDb(':memory:');
      const msg = {
        fromMe: false,
        hasMedia: true,
        type: 'document',
        isVoice: false,
        filename: 'customer_audio.mp3',
        to: '8801999999999@c.us'
      };

      const res = await handleMessageCreate({ msg, client: {}, db });
      assert.strictEqual(res.action, 'IGNORED_NOT_FROM_ME');
    });

    it('ignores outgoing audio document sent in group chat', async () => {
      const db = initDb(':memory:');
      const msg = {
        fromMe: true,
        hasMedia: true,
        type: 'document',
        isVoice: false,
        filename: 'group_audio.mp3',
        to: '123456789-group@g.us',
        id: { remote: '123456789-group@g.us' }
      };

      const res = await handleMessageCreate({ msg, client: {}, db });
      assert.strictEqual(res.action, 'IGNORED_GROUP');
    });

    it('succeeds using direct msg.duration when msg.downloadMedia would fail with "r: r"', async () => {
      const db = initDb(':memory:');
      let sentMessage = null;
      const client = {
        info: { wid: { _serialized: '8801999999999@c.us', user: '8801999999999' } },
        sendMessage: async (to, text) => {
          sentMessage = text;
        }
      };
      const msg = {
        fromMe: true,
        hasMedia: true,
        type: 'document',
        isVoice: false,
        filename: 'sample.mp3',
        duration: 90, // 1 minute 30 seconds -> 2 minutes -> 100 Taka
        to: '8801712345678@c.us',
        id: { remote: '8801712345678@c.us' },
        downloadMedia: async () => {
          throw new Error('r: r');
        }
      };

      const res = await handleMessageCreate({ msg, client, db });
      assert.strictEqual(res.action, 'SENT_AUDIO_BILL');
      assert.strictEqual(sentMessage, 'বিল ১০০ টাকা');
      assert.strictEqual(res.details.duration, 90);
      assert.strictEqual(res.details.billAmount, 100);
      assert.strictEqual(res.details.dueAmount, 100);
    });

    it('succeeds using in-page evaluate duration when msg.downloadMedia throws "r: r"', async () => {
      const db = initDb(':memory:');
      let sentMessage = null;
      const client = {
        info: { wid: { _serialized: '8801999999999@c.us', user: '8801999999999' } },
        pupPage: {
          evaluate: async () => ({ duration: 60 }) // 1 minute -> 50 Taka
        },
        sendMessage: async (to, text) => {
          sentMessage = text;
        }
      };
      const msg = {
        fromMe: true,
        hasMedia: true,
        type: 'document',
        isVoice: false,
        filename: 'voice_file.wav',
        to: '8801712345678@c.us',
        id: { remote: '8801712345678@c.us', _serialized: 'true_8801712345678@c.us_123' },
        downloadMedia: async () => {
          throw new Error('r: r');
        }
      };

      const res = await handleMessageCreate({ msg, client, db });
      assert.strictEqual(res.action, 'SENT_AUDIO_BILL');
      assert.strictEqual(sentMessage, 'বিল ৫০ টাকা');
      assert.strictEqual(res.details.duration, 60);
      assert.strictEqual(res.details.billAmount, 50);
      assert.strictEqual(res.details.dueAmount, 50);
    });
  });

  describe('Message Revocation / Unsend Handling', () => {
    it('getCandidateMessageIds extracts IDs from after and before objects and strings', () => {
      const before = {
        id: { _serialized: 'true_8801712345678@c.us_MSG1', id: 'MSG1' }
      };
      const after = {
        id: { _serialized: 'true_8801712345678@c.us_REVOKE1', id: 'REVOKE1' },
        protocolMessageKey: { _serialized: 'true_8801712345678@c.us_MSG1', id: 'MSG1' }
      };

      const ids = getCandidateMessageIds(after, before);
      assert.ok(ids.includes('true_8801712345678@c.us_MSG1'));
      assert.ok(ids.includes('MSG1'));
      assert.ok(ids.includes('true_8801712345678@c.us_REVOKE1'));
      assert.ok(ids.includes('REVOKE1'));
    });

    it('getCandidateMessageIds handles empty or null inputs safely', () => {
      assert.deepStrictEqual(getCandidateMessageIds(null, null), []);
      assert.deepStrictEqual(getCandidateMessageIds({}, {}), []);
    });

    it('revokes a manual bill transaction and recalculates customer balance', async () => {
      const db = initDb(':memory:');
      const client = {
        info: { wid: { _serialized: '8801999999999@c.us' } },
        getContactById: async () => ({ name: 'Test Customer' })
      };

      // 1. Send manual bill
      const msg = {
        fromMe: true,
        body: 'বিল ৫০০ টাকা',
        to: '8801712345678@c.us',
        id: {
          _serialized: 'true_8801712345678@c.us_3EB0MANUAL500',
          id: '3EB0MANUAL500',
          remote: '8801712345678@c.us'
        }
      };

      const createRes = await handleMessageCreate({ msg, client, db });
      assert.strictEqual(createRes.action, 'RECORDED_BILL');
      assert.strictEqual(createRes.details.dueAmount, 500);

      // Verify transaction in DB has messageId
      const tx = db.prepare('SELECT * FROM transactions WHERE phone_number = ?').get('8801712345678');
      assert.strictEqual(tx.message_id, 'true_8801712345678@c.us_3EB0MANUAL500');

      // 2. Unsend / Revoke message
      const revokePayload = {
        after: {
          protocolMessageKey: {
            id: '3EB0MANUAL500',
            remote: '8801712345678@c.us',
            fromMe: true
          }
        },
        before: undefined // WA Web often has undefined before if uncached
      };

      const revokeRes = await handleMessageRevoke({ ...revokePayload, client, db });
      assert.strictEqual(revokeRes.action, 'REVOKED_TRANSACTION');
      assert.strictEqual(revokeRes.details.type, 'BILL');
      assert.strictEqual(revokeRes.details.amount, 500);
      assert.strictEqual(revokeRes.details.dueAmount, 0);

      // Verify transaction was removed from DB
      const remainingTx = db.prepare('SELECT * FROM transactions WHERE phone_number = ?').all('8801712345678');
      assert.strictEqual(remainingTx.length, 0);
    });

    it('revokes an automated audio bill transaction and recalculates balance', async () => {
      const db = initDb(':memory:');
      let sentBillId = 'true_8801712345678@c.us_3EB0AUTOBILL999';

      const client = {
        info: { wid: { _serialized: '8801999999999@c.us', user: '8801999999999' } },
        pupPage: {
          evaluate: async () => ({ duration: 90 }) // 90s -> 100 Taka
        },
        sendMessage: async (to, text) => ({
          id: {
            _serialized: sentBillId,
            id: '3EB0AUTOBILL999'
          }
        })
      };

      const msg = {
        fromMe: true,
        hasMedia: true,
        type: 'document',
        isVoice: false,
        filename: 'recording.mp3',
        to: '8801712345678@c.us',
        id: { remote: '8801712345678@c.us', _serialized: 'true_8801712345678@c.us_AUDIO_DOC_1' },
        downloadMedia: async () => {
          throw new Error('r: r');
        }
      };

      // 1. Process audio message -> records bill and sends auto-bill message
      const audioRes = await handleMessageCreate({ msg, client, db });
      assert.strictEqual(audioRes.action, 'SENT_AUDIO_BILL');
      assert.strictEqual(audioRes.details.billAmount, 100);
      assert.strictEqual(audioRes.details.dueAmount, 100);

      // Verify transaction in DB has messageId linked to the sent bill message
      const tx = db.prepare('SELECT * FROM transactions WHERE phone_number = ?').get('8801712345678');
      assert.strictEqual(tx.message_id, sentBillId);

      // 2. Unsend / Revoke the auto-sent bill message
      const revokePayload = {
        after: {
          id: { _serialized: 'true_8801712345678@c.us_REVOKE_PROTOCOL_KEY' },
          protocolMessageKey: {
            _serialized: sentBillId,
            id: '3EB0AUTOBILL999'
          }
        },
        before: {
          id: {
            _serialized: sentBillId,
            id: '3EB0AUTOBILL999'
          }
        }
      };

      const revokeRes = await handleMessageRevoke({ ...revokePayload, client, db });
      assert.strictEqual(revokeRes.action, 'REVOKED_TRANSACTION');
      assert.strictEqual(revokeRes.details.amount, 100);
      assert.strictEqual(revokeRes.details.dueAmount, 0);

      // Verify transaction is gone
      const remainingTx = db.prepare('SELECT * FROM transactions WHERE phone_number = ?').all('8801712345678');
      assert.strictEqual(remainingTx.length, 0);
    });

    it('revokes a payment transaction and restores outstanding balance', async () => {
      const db = initDb(':memory:');
      const client = {
        info: { wid: { _serialized: '8801999999999@c.us' } }
      };

      // Send bill of 1000
      await handleMessageCreate({
        msg: {
          fromMe: true,
          body: 'বিল ১০০০ টাকা',
          to: '8801712345678@c.us',
          id: { _serialized: 'BILL_1000' }
        },
        client,
        db
      });

      // Send payment of 400
      await handleMessageCreate({
        msg: {
          fromMe: true,
          body: '৪০০ টাকা পেয়েছি, ধন্যবাদ',
          to: '8801712345678@c.us',
          id: { _serialized: 'PAY_400' }
        },
        client,
        db
      });

      // Due should be 600
      const dues = getDueList(db);
      assert.strictEqual(dues[0].due_amount, 600);

      // Revoke the payment
      const revokeRes = await handleMessageRevoke({
        after: { protocolMessageKey: { id: 'PAY_400' } },
        client,
        db
      });

      assert.strictEqual(revokeRes.action, 'REVOKED_TRANSACTION');
      assert.strictEqual(revokeRes.details.type, 'PAYMENT');
      assert.strictEqual(revokeRes.details.amount, 400);
      assert.strictEqual(revokeRes.details.dueAmount, 1000);

      const duesAfter = getDueList(db);
      assert.strictEqual(duesAfter[0].due_amount, 1000);
    });

    it('returns IGNORED_NO_MATCHING_TRANSACTION when revoked message is not a recorded transaction', async () => {
      const db = initDb(':memory:');
      const revokeRes = await handleMessageRevoke({
        after: { protocolMessageKey: { id: 'RANDOM_CHAT_MSG_123' } },
        client: {},
        db
      });

      assert.strictEqual(revokeRes.action, 'IGNORED_NO_MATCHING_TRANSACTION');
    });

    it('returns IGNORED_NO_MESSAGE_ID when candidate IDs are missing', async () => {
      const db = initDb(':memory:');
      const revokeRes = await handleMessageRevoke({
        after: null,
        before: null,
        client: {},
        db
      });

      assert.strictEqual(revokeRes.action, 'IGNORED_NO_MESSAGE_ID');
    });

    it('setupBotHandlers registers message_revoke_everyone listener on client', () => {
      const { setupBotHandlers } = require('../src/bot');
      const registeredEvents = {};
      const dummyClient = {
        on: (event, handler) => {
          registeredEvents[event] = handler;
        }
      };

      setupBotHandlers({ client: dummyClient, db: initDb(':memory:') });
      assert.ok(typeof registeredEvents['message_revoke_everyone'] === 'function', 'message_revoke_everyone listener should be registered');
    });
  });

  describe('Lead Tracking & Conversion Funnel', () => {
    it('records incoming message from new contact as a lead silently without replying', async () => {
      const db = initDb(':memory:');
      const client = {
        info: { wid: { _serialized: '8801999999999@c.us' } },
        getContactById: async () => ({ name: 'Prospective Client', pushname: 'Prospective Client' })
      };

      const msg = {
        fromMe: false,
        from: '8801755555555@c.us',
        to: '8801999999999@c.us',
        body: 'আসসালামু আলাইকুম, ভয়েস কি রেটে করেন?',
        id: { remote: '8801755555555@c.us' }
      };

      const res = await handleMessageCreate({ msg, client, db });
      assert.strictEqual(res.action, 'RECORDED_NEW_LEAD');
      assert.strictEqual(res.details.phone, '8801755555555');

      // Lead is in database as PENDING
      const lead = db.prepare('SELECT * FROM leads WHERE phone_number = ?').get('8801755555555');
      assert.ok(lead);
      assert.strictEqual(lead.status, 'PENDING');
      assert.ok(lead.first_contact_at);
      assert.strictEqual(lead.first_job_delivered_at, null);

      // Second message from same lead is ignored and does not overwrite first_contact_at
      const msg2 = {
        fromMe: false,
        from: '8801755555555@c.us',
        to: '8801999999999@c.us',
        body: 'রেট কত জানাবেন প্লিজ',
        id: { remote: '8801755555555@c.us' }
      };
      const res2 = await handleMessageCreate({ msg: msg2, client, db });
      assert.strictEqual(res2.action, 'IGNORED_NOT_FROM_ME');
    });

    it('tracks outgoing video document and converts lead to customer upon subsequent bill', async () => {
      const db = initDb(':memory:');
      const client = {
        info: { wid: { _serialized: '8801999999999@c.us' } },
        getContactById: async () => ({ name: 'Video Client' })
      };

      // 1. Inbound lead contact
      await handleMessageCreate({
        msg: {
          fromMe: false,
          from: '8801766666666@c.us',
          to: '8801999999999@c.us',
          body: 'ভিডিও এডিটিং কাজ আছে',
          id: { remote: '8801766666666@c.us' }
        },
        client,
        db
      });

      // 2. Outgoing video dispatch
      await handleMessageCreate({
        msg: {
          fromMe: true,
          to: '8801766666666@c.us',
          id: { remote: '8801766666666@c.us' },
          hasMedia: true,
          type: 'document',
          filename: 'news_report.mp4',
          mimetype: 'video/mp4'
        },
        client,
        db
      });

      // 3. Bill sent for the video
      const billRes = await handleMessageCreate({
        msg: {
          fromMe: true,
          to: '8801766666666@c.us',
          id: { remote: '8801766666666@c.us' },
          body: 'বিল ৫০০ টাকা'
        },
        client,
        db
      });

      assert.strictEqual(billRes.action, 'RECORDED_BILL');

      // Lead is now converted to customer with first_job_type = 'video'
      const lead = db.prepare('SELECT * FROM leads WHERE phone_number = ?').get('8801766666666');
      assert.strictEqual(lead.status, 'CONVERTED');
      assert.strictEqual(lead.first_job_type, 'video');
      assert.ok(lead.first_job_delivered_at);
      assert.ok(lead.conversion_duration_seconds >= 0);

      // Customer summary includes conversion fields
      const { getCustomerSummary } = require('../src/db');
      const summary = getCustomerSummary(db, '8801766666666');
      assert.strictEqual(summary.first_job_type, 'video');
      assert.ok(summary.first_contact_at);
      assert.ok(summary.first_job_delivered_at);
    });

    it('records customerScriptMsgId and va2ForwardMsgId in voice_job_orders when incoming customer voice script is processed', async () => {
      const db = initDb(':memory:');
      const sentMessages = [];
      const mockClient = {
        info: { wid: { user: '8801340517587' } },
        getContactById: async () => ({ isMyContact: false, name: 'Customer Rahim' }),
        sendMessage: async (jid, text) => {
          sentMessages.push({ jid, text });
          return { id: { _serialized: 'va2-auto-forward-msg-777' } };
        }
      };
      const mockChat = {
        id: { _serialized: '8801711223344@c.us' },
        fetchMessages: async () => [
          { fromMe: false, body: 'ভয়েস দেন: নতুন অফার চলছে দোকানে' }
        ],
        sendMessage: async (text) => {
          sentMessages.push({ jid: 'customer', text });
          return { id: { _serialized: 'ack-ok-id' } };
        }
      };
      const mockMsg = {
        id: { _serialized: 'cust-script-msg-456', id: 'cust-script-msg-456' },
        fromMe: false,
        from: '8801711223344@c.us',
        to: '8801340517587@c.us',
        body: 'ভয়েস দেন: নতুন অফার চলছে দোকানে',
        getChat: async () => mockChat
      };

      const res = await handleMessageCreate({
        msg: mockMsg,
        client: mockClient,
        db,
        classifierFn: async () => ({
          classification: 'VOICE_JOB',
          extracted_script: 'নতুন অফার চলছে দোকানে'
        })
      });

      assert.strictEqual(res?.action, 'VOICE_JOB_DISPATCHED');
      assert.strictEqual(res?.details?.delivered, true);
      assert.strictEqual(res?.details?.va2ForwardMsgId, 'va2-auto-forward-msg-777');

      const orders = db.prepare('SELECT * FROM voice_job_orders WHERE customer_phone = ?').all('8801711223344');
      assert.strictEqual(orders.length, 1);
      const order = orders[0];
      assert.strictEqual(order.customer_script_msg_id, 'cust-script-msg-456');
      assert.strictEqual(order.va2_forward_msg_id, 'va2-auto-forward-msg-777');
      assert.strictEqual(order.script_text, 'নতুন অফার চলছে দোকানে');
      assert.strictEqual(order.status, 'PENDING_VA2');
      db.close();
    });

    it('updates order va2_forward_msg_id when operator sends outgoing message to VA2 matching customer script', async () => {
      const db = initDb(':memory:');
      const order = createVoiceJobOrder(db, {
        customerPhone: '8801799887766',
        customerName: 'Pending Client',
        customerScriptMsgId: 'inbound-cust-msg-001',
        va2ForwardMsgId: null,
        scriptText: 'স্পেশাল কাচ্চি বিরিয়ানি অফার মাত্র ৩৫০ টাকা'
      });
      assert.strictEqual(order.va2_forward_msg_id, null);

      const mockClient = {
        info: { wid: { user: '8801340517587' } },
        getContactById: async () => ({ isMyContact: false, name: 'VA2 Staff' })
      };

      const operatorMsg = {
        id: { _serialized: 'operator-manual-fwd-msg-888', id: 'operator-manual-fwd-msg-888' },
        fromMe: true,
        to: '8801307760509@c.us',
        body: 'স্পেশাল কাচ্চি বিরিয়ানি অফার মাত্র ৩৫০ টাকা'
      };

      const res = await handleMessageCreate({
        msg: operatorMsg,
        client: mockClient,
        db
      });

      assert.strictEqual(res?.action, 'LINKED_MANUAL_VA2_FORWARD');
      assert.strictEqual(res?.details?.orderId, order.order_id);
      assert.strictEqual(res?.details?.va2ForwardMsgId, 'operator-manual-fwd-msg-888');

      const updatedOrder = db.prepare('SELECT * FROM voice_job_orders WHERE order_id = ?').get(order.order_id);
      assert.strictEqual(updatedOrder.va2_forward_msg_id, 'operator-manual-fwd-msg-888');
      db.close();
    });

    it('preserves original customerScriptMsgId when order is confirmed affirmatively after SCRIPT_PENDING_CONFIRMATION', async () => {
      const db = initDb(':memory:');
      const { schedulePendingConfirmation, clearAllPendingConfirmations } = require('../src/dispatch');
      clearAllPendingConfirmations();
      const sentMessages = [];
      const mockClient = {
        info: { wid: { user: '8801340517587' } },
        getContactById: async () => ({ isMyContact: false, name: 'Affirmative Customer' }),
        sendMessage: async (jid, text) => {
          sentMessages.push({ jid, text });
          return { id: { _serialized: 'va2-affirmative-forward-999' } };
        }
      };
      const mockChat = {
        id: { _serialized: '8801755555555@c.us' },
        fetchMessages: async () => [
          { fromMe: false, body: 'জি' }
        ],
        sendMessage: async (text) => {
          sentMessages.push({ jid: 'customer', text });
          return { id: { _serialized: 'ack-ok-id' } };
        }
      };

      // Step 1: Pre-populate pending confirmation with original script message ID
      schedulePendingConfirmation({
        client: mockClient,
        customerPhone: '8801755555555',
        customerName: 'Affirmative Customer',
        script: 'ধানমন্ডি লেক ভিউ রেস্টুরেন্টের গ্রিল চিকেন অফার',
        customerScriptMsgId: 'original-script-msg-001',
        timeoutMs: 60000
      });

      // Step 2: Customer replies "জি"
      const confirmMsg = {
        id: { _serialized: 'confirm-reply-msg-002', id: 'confirm-reply-msg-002' },
        fromMe: false,
        from: '8801755555555@c.us',
        to: '8801340517587@c.us',
        body: 'জি',
        getChat: async () => mockChat
      };

      const res = await handleMessageCreate({
        msg: confirmMsg,
        client: mockClient,
        db,
        classifierFn: async () => ({ classification: 'OTHER' })
      });

      assert.strictEqual(res?.action, 'VOICE_JOB_DISPATCHED');
      assert.strictEqual(res?.details?.delivered, true);
      assert.strictEqual(res?.details?.va2ForwardMsgId, 'va2-affirmative-forward-999');

      const orders = db.prepare('SELECT * FROM voice_job_orders WHERE customer_phone = ?').all('8801755555555');
      assert.strictEqual(orders.length, 1);
      const order = orders[0];
      // Crucial: customer_script_msg_id MUST be original-script-msg-001, NOT confirm-reply-msg-002!
      assert.strictEqual(order.customer_script_msg_id, 'original-script-msg-001');
      assert.strictEqual(order.va2_forward_msg_id, 'va2-affirmative-forward-999');
      assert.strictEqual(order.script_text, 'ধানমন্ডি লেক ভিউ রেস্টুরেন্টের গ্রিল চিকেন অফার');
      assert.strictEqual(order.status, 'PENDING_VA2');

      clearAllPendingConfirmations();
      db.close();
    });
  });

  describe('VA2 Audio Reply & Dual Delivery', () => {
    function createWavBuffer(durationSeconds = 1) {
      const sampleRate = 8000;
      const numChannels = 1;
      const bitsPerSample = 8;
      const dataSize = Math.round(durationSeconds * sampleRate * numChannels * (bitsPerSample / 8));
      const buffer = Buffer.alloc(44 + dataSize);

      buffer.write('RIFF', 0);
      buffer.writeUInt32LE(36 + dataSize, 4);
      buffer.write('WAVE', 8);
      buffer.write('fmt ', 12);
      buffer.writeUInt32LE(16, 16);
      buffer.writeUInt16LE(1, 20);
      buffer.writeUInt16LE(numChannels, 22);
      buffer.writeUInt32LE(sampleRate, 24);
      buffer.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
      buffer.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
      buffer.writeUInt16LE(bitsPerSample, 34);
      buffer.write('data', 36);
      buffer.writeUInt32LE(dataSize, 40);

      return buffer;
    }

    it('VA2 audio reply with Bengali filename forwards directly to customer quoting script message', async () => {
      const db = initDb(':memory:');
      const order = createVoiceJobOrder(db, {
        customerPhone: '8801711223344',
        customerName: 'Rahim',
        customerScriptMsgId: 'cust-script-msg-101',
        va2ForwardMsgId: 'va2-fwd-msg-202',
        scriptText: 'নবাবপুর ফুড সিটির স্পেশাল কাচ্চি বিরিয়ানি',
        headline: 'নবাবপুর ফুড সিটি'
      });

      const sentMessages = [];
      const mockClient = {
        info: { wid: { user: '8801340517587' } },
        sendMessage: async (jid, content, options) => {
          sentMessages.push({ jid, content, options });
          return { id: { _serialized: 'sent-msg-bengali-direct-001' } };
        }
      };

      const mediaPayload = {
        data: Buffer.from('bengali-direct-audio-content').toString('base64'),
        mimetype: 'audio/mp3',
        filename: 'নবাবপুর ফুড সিটি.mp3'
      };

      const va2Msg = {
        id: { _serialized: 'va2-audio-reply-303', id: 'va2-audio-reply-303' },
        fromMe: false,
        from: '8801307760509@c.us',
        to: '8801340517587@c.us',
        hasMedia: true,
        type: 'document',
        filename: 'নবাবপুর ফুড সিটি.mp3',
        mimetype: 'audio/mp3',
        hasQuotedMsg: true,
        getQuotedMessage: async () => ({
          id: { _serialized: 'va2-fwd-msg-202' }
        }),
        downloadMedia: async () => mediaPayload
      };

      const res = await handleMessageCreate({
        msg: va2Msg,
        client: mockClient,
        db
      });

      assert.strictEqual(res.action, 'DELIVERED_VA2_AUDIO_DIRECT');
      assert.strictEqual(res.details.orderId, order.order_id);
      assert.strictEqual(res.details.customerPhone, '8801711223344');
      assert.strictEqual(res.details.filename, 'নবাবপুর ফুড সিটি.mp3');

      // Check forwarded directly to customer quoting customer_script_msg_id
      assert.strictEqual(sentMessages.length, 1);
      assert.strictEqual(sentMessages[0].jid, '8801711223344@c.us');
      assert.strictEqual(sentMessages[0].options.quotedMessageId, 'cust-script-msg-101');
      assert.strictEqual(sentMessages[0].options.sendMediaAsDocument, true);
      assert.strictEqual(sentMessages[0].content.filename, 'নবাবপুর ফুড সিটি.mp3');

      // Verify DB update
      const updatedOrder = db.prepare('SELECT * FROM voice_job_orders WHERE order_id = ?').get(order.order_id);
      assert.strictEqual(updatedOrder.status, 'DELIVERED');
      assert.strictEqual(updatedOrder.va2_audio_msg_id, 'va2-audio-reply-303');
      assert.strictEqual(updatedOrder.va2_audio_filename, 'নবাবপুর ফুড সিটি.mp3');
      assert.strictEqual(updatedOrder.final_audio_filename, 'নবাবপুর ফুড সিটি.mp3');
      assert.strictEqual(updatedOrder.aircheck_model_used, 'DIRECT_FORWARD');
      assert.ok(updatedOrder.delivered_at);
      db.close();
    });

    it('VA2 audio reply with English filename runs AirCheck, renames with headline + duration, and delivers quoted reply to both customer and VA2', async () => {
      const db = initDb(':memory:');
      const order = createVoiceJobOrder(db, {
        customerPhone: '8801799887766',
        customerName: 'Karim',
        customerScriptMsgId: 'cust-script-msg-505',
        va2ForwardMsgId: 'va2-fwd-msg-606',
        scriptText: 'স্পেশাল কাচ্চি অফার',
        headline: 'স্পেশাল কাচ্চি অফার'
      });

      const sentMessages = [];
      const mockClient = {
        info: { wid: { user: '8801340517587' } },
        sendMessage: async (jid, content, options) => {
          sentMessages.push({ jid, content, options });
          return { id: { _serialized: `sent-${Date.now()}` } };
        }
      };

      const wavBuffer = createWavBuffer(83); // 83 seconds -> 1m 23s
      const va2Msg = {
        id: { _serialized: 'va2-audio-reply-707', id: 'va2-audio-reply-707' },
        fromMe: false,
        from: '8801307760509@c.us',
        to: '8801340517587@c.us',
        hasMedia: true,
        type: 'document',
        filename: 'voice1.wav',
        mimetype: 'audio/wav',
        hasQuotedMsg: true,
        getQuotedMessage: async () => ({
          id: { _serialized: 'va2-fwd-msg-606' }
        }),
        downloadMedia: async () => ({
          data: wavBuffer.toString('base64'),
          mimetype: 'audio/wav',
          filename: 'voice1.wav'
        })
      };

      const res = await handleMessageCreate({
        msg: va2Msg,
        client: mockClient,
        db,
        cleanVoiceoverAudioFn: async ({ audioBuffer }) => ({
          cleanBuffer: audioBuffer,
          durationSeconds: 83,
          cutsCount: 1,
          modelUsed: 'gemini-3.8-flash',
          cuts: [{ cutStartTime: 10, cutEndTime: 15 }]
        })
      });

      assert.strictEqual(res.action, 'DELIVERED_VA2_AUDIO_AIRCHECK');
      assert.strictEqual(res.details.orderId, order.order_id);
      assert.strictEqual(res.details.customerPhone, '8801799887766');
      assert.strictEqual(res.details.finalFilename, 'স্পেশাল কাচ্চি অফার (1m 23s).wav');
      assert.strictEqual(res.details.durationSeconds, 83);
      assert.strictEqual(res.details.cutsCount, 1);

      // Check dual delivery
      assert.strictEqual(sentMessages.length, 2);

      // Delivery 1: To Customer quoting cust-script-msg-505
      assert.strictEqual(sentMessages[0].jid, '8801799887766@c.us');
      assert.strictEqual(sentMessages[0].options.quotedMessageId, 'cust-script-msg-505');
      assert.strictEqual(sentMessages[0].options.sendMediaAsDocument, true);
      assert.strictEqual(sentMessages[0].content.filename, 'স্পেশাল কাচ্চি অফার (1m 23s).wav');

      // Delivery 2: To VA2 quoting va2-fwd-msg-606
      assert.strictEqual(sentMessages[1].jid, '8801307760509@c.us');
      assert.strictEqual(sentMessages[1].options.quotedMessageId, 'va2-fwd-msg-606');
      assert.strictEqual(sentMessages[1].options.sendMediaAsDocument, true);
      assert.strictEqual(sentMessages[1].content.filename, 'স্পেশাল কাচ্চি অফার (1m 23s).wav');

      // Verify DB update
      const updatedOrder = db.prepare('SELECT * FROM voice_job_orders WHERE order_id = ?').get(order.order_id);
      assert.strictEqual(updatedOrder.status, 'DELIVERED');
      assert.strictEqual(updatedOrder.va2_audio_msg_id, 'va2-audio-reply-707');
      assert.strictEqual(updatedOrder.va2_audio_filename, 'voice1.wav');
      assert.strictEqual(updatedOrder.final_audio_filename, 'স্পেশাল কাচ্চি অফার (1m 23s).wav');
      assert.strictEqual(updatedOrder.clean_duration_seconds, 83);
      assert.strictEqual(updatedOrder.cuts_applied_count, 1);
      assert.strictEqual(updatedOrder.aircheck_model_used, 'gemini-3.8-flash');
      assert.ok(updatedOrder.delivered_at);
      db.close();
    });

    it('VA2 audio reply when no pending order exists is safely ignored', async () => {
      const db = initDb(':memory:');
      const sentMessages = [];
      const mockClient = {
        info: { wid: { user: '8801340517587' } },
        sendMessage: async (jid, content, options) => {
          sentMessages.push({ jid, content, options });
          return { id: { _serialized: 'some-id' } };
        }
      };

      const va2Msg = {
        id: { _serialized: 'va2-audio-reply-unmatched', id: 'va2-audio-reply-unmatched' },
        fromMe: false,
        from: '8801307760509@c.us',
        to: '8801340517587@c.us',
        hasMedia: true,
        type: 'audio',
        mimetype: 'audio/mp3',
        filename: 'unmatched.mp3',
        hasQuotedMsg: true,
        quotedMsgId: 'unknown-script-msg-id',
        getQuotedMessage: async () => ({ id: { _serialized: 'unknown-script-msg-id' } }),
        downloadMedia: async () => ({
          data: Buffer.from('unmatched-audio').toString('base64'),
          mimetype: 'audio/mp3'
        })
      };

      const res = await handleMessageCreate({
        msg: va2Msg,
        client: mockClient,
        db
      });

      assert.strictEqual(res.action, 'IGNORED_VA2_AUDIO_NO_ORDER');
      assert.strictEqual(sentMessages.length, 0);
      db.close();
    });

    it('VA2 audio reply without quote is ignored (must be reply to script)', async () => {
      const db = initDb(':memory:');
      createVoiceJobOrder(db, {
        customerPhone: '8801811223344',
        customerName: 'Pending Customer',
        customerScriptMsgId: 'script-msg-888',
        va2ForwardMsgId: 'va2-msg-999',
        scriptText: 'নতুন মেগা সেল অফার',
        headline: 'মেগা সেল অফার'
      });

      const sentMessages = [];
      const mockClient = {
        info: { wid: { user: '8801340517587' } },
        sendMessage: async (jid, content, options) => {
          sentMessages.push({ jid, content, options });
          return { id: { _serialized: 'sent-fallback-fwd' } };
        }
      };

      // Inbound audio from VA2 without any quoted message
      const va2Msg = {
        id: { _serialized: 'va2-unquoted-audio', id: 'va2-unquoted-audio' },
        fromMe: false,
        from: '8801307760509@c.us',
        to: '8801340517587@c.us',
        hasMedia: true,
        type: 'document',
        filename: 'মেগা সেল অফার.mp3',
        mimetype: 'audio/mp3',
        hasQuotedMsg: false
      };

      const res = await handleMessageCreate({
        msg: va2Msg,
        client: mockClient,
        db
      });

      assert.strictEqual(res.action, 'IGNORED_VA2_UNQUOTED_AUDIO');
      assert.strictEqual(sentMessages.length, 0);
      db.close();
    });

    it('VA2 audio reply from multi-device LID matching cached staff_lids is recognized and delivered', async () => {
      const { cacheStaffLid } = require('../src/db');
      const db = initDb(':memory:');
      cacheStaffLid(db, 'VA2', '8801307760509', '123456789012345@lid');

      const order = createVoiceJobOrder(db, {
        customerPhone: '8801700112233',
        customerName: 'LID Customer',
        customerScriptMsgId: 'script-msg-lid',
        va2ForwardMsgId: 'va2-msg-lid',
        scriptText: 'স্পেশাল টেস্ট স্ক্রিপ্ট',
        headline: 'স্পেশাল টেস্ট'
      });

      const sentMessages = [];
      const mockClient = {
        info: { wid: { user: '8801340517587' } },
        sendMessage: async (jid, content, options) => {
          sentMessages.push({ jid, content, options });
          return { id: { _serialized: 'lid-delivery-ack' } };
        }
      };

      // Message from VA2 with LID as sender quoting script
      const va2Msg = {
        id: { _serialized: 'va2-lid-msg-id', id: 'va2-lid-msg-id', remote: '123456789012345@lid' },
        fromMe: false,
        from: '123456789012345@lid',
        to: '8801340517587@c.us',
        hasMedia: true,
        type: 'document',
        filename: 'স্পেশাল টেস্ট.mp3',
        mimetype: 'audio/mp3',
        hasQuotedMsg: true,
        quotedMsgId: 'va2-msg-lid',
        getQuotedMessage: async () => ({ id: { _serialized: 'va2-msg-lid' } }),
        downloadMedia: async () => ({
          data: Buffer.from('audio-data-lid').toString('base64'),
          mimetype: 'audio/mp3',
          filename: 'স্পেশাল টেস্ট.mp3'
        })
      };

      const res = await handleMessageCreate({
        msg: va2Msg,
        client: mockClient,
        db
      });

      assert.strictEqual(res.action, 'DELIVERED_VA2_AUDIO_DIRECT');
      assert.strictEqual(res.details.orderId, order.order_id);
      assert.strictEqual(sentMessages[0].jid, '8801700112233@c.us');
      db.close();
    });

    it('VA2 voice note (type === ptt, isVoice === true) is strictly ignored', async () => {
      const db = initDb(':memory:');
      createVoiceJobOrder(db, {
        customerPhone: '8801799001122',
        customerName: 'Voice Note Customer',
        customerScriptMsgId: 'script-msg-ptt',
        va2ForwardMsgId: 'va2-msg-ptt',
        scriptText: 'ভয়েস নোট টেস্ট স্ক্রিপ্ট',
        headline: 'ভয়েস নোট টেস্ট'
      });

      const sentMessages = [];
      const mockClient = {
        info: { wid: { user: '8801340517587' } },
        sendMessage: async (jid, content, options) => {
          sentMessages.push({ jid, content, options });
          return { id: { _serialized: 'ptt-delivery-ack' } };
        }
      };

      // Voice note message (Push To Talk / PTT)
      const va2Msg = {
        id: { _serialized: 'va2-ptt-msg-id', id: 'va2-ptt-msg-id' },
        fromMe: false,
        from: '8801307760509@c.us',
        to: '8801340517587@c.us',
        hasMedia: true,
        type: 'ptt',
        isVoice: true,
        mimetype: 'audio/ogg; codecs=opus',
        hasQuotedMsg: true,
        quotedMsgId: 'va2-msg-ptt'
      };

      const res = await handleMessageCreate({
        msg: va2Msg,
        client: mockClient,
        db
      });

      assert.strictEqual(res.action, 'IGNORED_VA2_PTT');
      assert.strictEqual(sentMessages.length, 0);
      db.close();
    });

    it('VA2 audio reply with quote in _data.quotedStanzaId when hasQuotedMsg is false is recognized and delivered', async () => {
      const db = initDb(':memory:');
      const order = createVoiceJobOrder(db, {
        customerPhone: '8801711223344',
        customerName: 'Audio Customer',
        customerScriptMsgId: 'cust-script-1',
        va2ForwardMsgId: 'script-stanza-999',
        scriptText: 'টেস্ট স্ক্রিপ্ট টেক্সট',
        headline: 'টেস্ট স্ক্রিপ্ট'
      });

      const sentMessages = [];
      const mockClient = {
        info: { wid: { user: '8801340517587' } },
        sendMessage: async (jid, content, options) => {
          sentMessages.push({ jid, content, options });
          return { id: { _serialized: 'ack-999' } };
        }
      };

      const va2Msg = {
        id: { _serialized: 'va2-audio-reply-1', id: 'va2-audio-reply-1' },
        fromMe: false,
        from: '8801307760509@c.us',
        to: '8801340517587@c.us',
        hasMedia: true,
        type: 'document',
        filename: 'ভয়েস ফাইনাল.mp3',
        mimetype: 'audio/mp3',
        hasQuotedMsg: false, // WhatsApp Web had not set hasQuotedMsg
        _data: {
          quotedStanzaId: 'script-stanza-999'
        },
        downloadMedia: async () => ({
          data: Buffer.from('mock-audio').toString('base64'),
          mimetype: 'audio/mp3',
          filename: 'ভয়েস ফাইনাল.mp3'
        })
      };

      const res = await handleMessageCreate({
        msg: va2Msg,
        client: mockClient,
        db
      });

      assert.strictEqual(res.action, 'DELIVERED_VA2_AUDIO_DIRECT');
      assert.strictEqual(sentMessages.length, 1);
      assert.strictEqual(sentMessages[0].jid, '8801711223344@c.us');
      db.close();
    });

    it('VA2 audio reply matches order by quoted script text when va2_forward_msg_id was null in DB', async () => {
      const db = initDb(':memory:');
      const order = createVoiceJobOrder(db, {
        customerPhone: '8801534323811',
        customerName: 'Preenan',
        customerScriptMsgId: 'cust-script-2',
        va2ForwardMsgId: null, // null in database!
        scriptText: 'পবা উপজেলার ৪ নং হরিপুর ইউনিয়ন চেয়ারম্যান',
        headline: 'হরিপুর ইউনিয়ন'
      });

      const sentMessages = [];
      const mockClient = {
        info: { wid: { user: '8801340517587' } },
        sendMessage: async (jid, content, options) => {
          sentMessages.push({ jid, content, options });
          return { id: { _serialized: 'ack-preenan' } };
        }
      };

      const va2Msg = {
        id: { _serialized: 'va2-audio-reply-preenan', id: 'va2-audio-reply-preenan' },
        fromMe: false,
        from: '8801307760509@c.us',
        to: '8801340517587@c.us',
        hasMedia: true,
        type: 'document',
        filename: 'হরিপুর ভয়েস ফাইনাল.mp3',
        mimetype: 'audio/mp3',
        hasQuotedMsg: true,
        _data: {
          quotedStanzaId: 'some-new-quoted-id',
          quotedMsg: {
            body: '[নতুন ভয়েস অর্ডার]\n\nস্ক্রিপ্ট:\nপবা উপজেলার ৪ নং হরিপুর ইউনিয়ন চেয়ারম্যান'
          }
        },
        getQuotedMessage: async () => {
          throw new Error('Puppeteer execution context was destroyed');
        },
        downloadMedia: async () => ({
          data: Buffer.from('mock-audio').toString('base64'),
          mimetype: 'audio/mp3',
          filename: 'হরিপুর ভয়েস ফাইনাল.mp3'
        })
      };

      const res = await handleMessageCreate({
        msg: va2Msg,
        client: mockClient,
        db
      });

      assert.strictEqual(res.action, 'DELIVERED_VA2_AUDIO_DIRECT');
      assert.strictEqual(sentMessages.length, 1);
      assert.strictEqual(sentMessages[0].jid, '8801534323811@c.us');

      // Verify that the null va2_forward_msg_id in order was updated!
      const updatedOrder = getVoiceJobOrder(db, order.order_id);
      assert.strictEqual(updatedOrder.va2_forward_msg_id, 'some-new-quoted-id');
      assert.strictEqual(updatedOrder.status, 'DELIVERED');
      db.close();
    });

    it('outgoing forward message with [নতুন ভয়েস অর্ডার] links msgId to order', async () => {
      const db = initDb(':memory:');
      const order = createVoiceJobOrder(db, {
        customerPhone: '8801534323811',
        customerName: 'Preenan',
        customerScriptMsgId: 'cust-script-3',
        va2ForwardMsgId: null,
        scriptText: 'হরিপুর ইউনিয়ন নির্বাচন সংক্রান্ত স্ক্রিপ্ট',
        headline: 'হরিপুর ইউনিয়ন'
      });

      const forwardMsg = {
        id: { _serialized: 'true_8801307760509@c.us_FORW12345', id: 'FORW12345' },
        fromMe: true,
        from: '8801340517587@c.us',
        to: '8801307760509@c.us',
        body: '[নতুন ভয়েস অর্ডার]\n\nস্ক্রিপ্ট:\nহরিপুর ইউনিয়ন নির্বাচন সংক্রান্ত স্ক্রিপ্ট'
      };

      const res = await handleMessageCreate({
        msg: forwardMsg,
        client: { info: { wid: { user: '8801340517587' } } },
        db
      });

      assert.strictEqual(res.action, 'LINKED_MANUAL_VA2_FORWARD');
      const updatedOrder = getVoiceJobOrder(db, order.order_id);
      assert.strictEqual(updatedOrder.va2_forward_msg_id, 'true_8801307760509@c.us_FORW12345');
      db.close();
    });
  });
});

