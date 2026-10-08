const { describe, it } = require('node:test');
const assert = require('node:assert');
const { initDb } = require('../src/db');
const { formatDueReport, handleMessageCreate } = require('../src/bot');

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
});
