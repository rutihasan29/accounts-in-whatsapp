const { describe, it } = require('node:test');
const assert = require('node:assert');
const { initDb, getDueList } = require('../src/db');
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
});

