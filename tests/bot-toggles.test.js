const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { handleMessageCreate } = require('../src/bot');
const {
  initDb,
  setBotSetting,
  getBotSetting,
  getAllBotSettings,
  addVideoCustomer,
  createVoiceJobOrder,
  getDueList
} = require('../src/db');
const {
  handleClassificationAction,
  schedulePendingConfirmation,
  clearAllPendingConfirmations
} = require('../src/dispatch');

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

describe('Bot Feature Toggles Runtime Integration', () => {

  describe('Default Settings Verification', () => {
    it('all 6 toggles default to true (ON) when no entry is in SQLite', () => {
      const db = initDb(':memory:');
      assert.strictEqual(getBotSetting(db, 'aircheck_enabled', true), true);
      assert.strictEqual(getBotSetting(db, 'ai_classifier_enabled', true), true);
      assert.strictEqual(getBotSetting(db, 'welcome_demo_enabled', true), true);
      assert.strictEqual(getBotSetting(db, 'auto_audio_billing_enabled', true), true);
      assert.strictEqual(getBotSetting(db, 'video_customer_escalation_enabled', true), true);
      assert.strictEqual(getBotSetting(db, 've3_escalation_enabled', true), true);

      const all = getAllBotSettings(db);
      assert.strictEqual(all.aircheck_enabled, true);
      assert.strictEqual(all.ai_classifier_enabled, true);
      assert.strictEqual(all.welcome_demo_enabled, true);
      assert.strictEqual(all.auto_audio_billing_enabled, true);
      assert.strictEqual(all.video_customer_escalation_enabled, true);
      assert.strictEqual(all.ve3_escalation_enabled, true);
      db.close();
    });
  });

  describe('welcome_demo_enabled Toggle', () => {
    it('when welcome_demo_enabled is false, welcome demo is not dispatched for new contacts', async () => {
      const db = initDb(':memory:');
      setBotSetting(db, 'welcome_demo_enabled', false);

      const sent = [];
      const client = {
        info: { wid: { _serialized: '8801999999999@c.us' } },
        getContactById: async () => ({ name: 'New Inbound Lead', pushname: 'Inbound', isMyContact: false }),
        sendMessage: async (chat, content, options) => {
          sent.push({ chat, content, options });
          return { id: { _serialized: `msg_${sent.length}` } };
        }
      };

      const msg = {
        fromMe: false,
        from: '8801788880001@c.us',
        to: '8801999999999@c.us',
        body: 'হ্যালো, ভয়েস রেট কত?',
        id: { remote: '8801788880001@c.us' }
      };

      const res = await handleMessageCreate({ msg, client, db });

      assert.strictEqual(res.action, 'RECORDED_NEW_LEAD');
      assert.strictEqual(res.details.welcomeResult, null);
      assert.strictEqual(sent.length, 0, 'No welcome demo messages should be sent when disabled');
      db.close();
    });

    it('when welcome_demo_enabled is default (true), welcome demo is dispatched for new contacts', async () => {
      const db = initDb(':memory:');
      const sent = [];
      const client = {
        info: { wid: { _serialized: '8801999999999@c.us' } },
        getContactById: async () => ({ name: 'New Inbound Lead', pushname: 'Inbound', isMyContact: false }),
        sendMessage: async (chat, content, options) => {
          sent.push({ chat, content, options });
          return { id: { _serialized: `msg_${sent.length}` } };
        }
      };

      const msg = {
        fromMe: false,
        from: '8801788880002@c.us',
        to: '8801999999999@c.us',
        body: 'হ্যালো, ভয়েস রেট কত?',
        id: { remote: '8801788880002@c.us' }
      };

      const res = await handleMessageCreate({ msg, client, db });

      assert.strictEqual(res.action, 'RECORDED_NEW_LEAD');
      assert.strictEqual(res.details.welcomeResult?.success, true);
      assert.strictEqual(sent.length, 15, '15-step welcome sequence sent when enabled');
      db.close();
    });
  });

  describe('auto_audio_billing_enabled Toggle', () => {
    it('when auto_audio_billing_enabled is false, outgoing audio messages do not create billing transactions', async () => {
      const db = initDb(':memory:');
      setBotSetting(db, 'auto_audio_billing_enabled', false);

      const wavBuffer = createWavBuffer(135);
      const sentMessages = [];
      const client = {
        info: { wid: { _serialized: '8801999999999@c.us', user: '8801999999999' } },
        sendMessage: async (to, text) => {
          sentMessages.push({ to, text });
          return { id: { _serialized: 'msg-1' } };
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

      assert.strictEqual(res.action, 'AUDIO_BILLING_DISABLED');
      assert.strictEqual(sentMessages.length, 0, 'No bill message should be sent');

      const dues = getDueList(db);
      assert.strictEqual(dues.length, 0, 'No dues should be recorded');

      const txCount = db.prepare('SELECT COUNT(*) as cnt FROM transactions').get().cnt;
      assert.strictEqual(txCount, 0, 'No transactions should be inserted');
      db.close();
    });

    it('when auto_audio_billing_enabled is default (true), outgoing audio messages create billing transactions', async () => {
      const db = initDb(':memory:');
      const wavBuffer = createWavBuffer(135);
      const sentMessages = [];
      const client = {
        info: { wid: { _serialized: '8801999999999@c.us', user: '8801999999999' } },
        sendMessage: async (to, text) => {
          sentMessages.push({ to, text });
          return { id: { _serialized: 'msg-1' } };
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
      assert.strictEqual(sentMessages.length, 1);
      assert.strictEqual(sentMessages[0].text, 'বিল ১২৫ টাকা');

      const dues = getDueList(db);
      assert.strictEqual(dues.length, 1);
      assert.strictEqual(dues[0].due_amount, 125);
      db.close();
    });
  });

  describe('video_customer_escalation_enabled Toggle', () => {
    it('when video_customer_escalation_enabled is false, video customers do not escalate to VE3 directly', async () => {
      const db = initDb(':memory:');
      setBotSetting(db, 'video_customer_escalation_enabled', false);
      addVideoCustomer(db, '8801755667788');

      let classifierCalled = false;
      const sentMessages = [];

      const mockChat = {
        id: { _serialized: '8801755667788@c.us' },
        fetchMessages: async () => [
          { fromMe: false, body: 'Amar ei script diye video banai den' }
        ],
        sendMessage: async (text) => {
          sentMessages.push({ to: 'customer', text });
        }
      };

      const mockClient = {
        info: { wid: { user: '8801340517587' } },
        getContactById: async () => ({ isMyContact: false, name: 'Video Client' }),
        sendMessage: async (jid, text) => {
          sentMessages.push({ jid, text });
          return { id: { _serialized: 'msg-id' } };
        }
      };

      const mockMsg = {
        fromMe: false,
        from: '8801755667788@c.us',
        to: '8801340517587@c.us',
        body: 'Amar ei script diye video banai den',
        getChat: async () => mockChat
      };

      const res = await handleMessageCreate({
        msg: mockMsg,
        client: mockClient,
        db,
        classifierFn: async () => {
          classifierCalled = true;
          return {
            classification: 'VOICE_JOB',
            extracted_script: 'Amar ei script diye video banai den'
          };
        }
      });

      assert.notStrictEqual(res?.action, 'VIDEO_CUSTOMER_ESCALATED_TO_VE3', 'Direct video escalation must be bypassed');
      assert.strictEqual(classifierCalled, true, 'Classifier should be reached since direct escalation was bypassed');

      const ve3Msg = sentMessages.find(m => m.jid && m.jid.includes('8801831366604'));
      if (ve3Msg) {
        assert.ok(!ve3Msg.text.includes('ভিডিও গ্রাহকের বার্তা'), 'Should not contain video customer direct escalation header');
      }
      db.close();
    });

    it('when video_customer_escalation_enabled is default (true), video customers escalate directly to VE3', async () => {
      const db = initDb(':memory:');
      addVideoCustomer(db, '8801755667788');

      let classifierCalled = false;
      const sentMessages = [];

      const mockChat = {
        id: { _serialized: '8801755667788@c.us' },
        fetchMessages: async () => [
          { fromMe: false, body: 'Amar ei script diye video banai den' }
        ],
        sendMessage: async (text) => {
          sentMessages.push({ to: 'customer', text });
        }
      };

      const mockClient = {
        info: { wid: { user: '8801340517587' } },
        getContactById: async () => ({ isMyContact: false, name: 'Video Client' }),
        sendMessage: async (jid, text) => {
          sentMessages.push({ jid, text });
          return { id: { _serialized: 'msg-id' } };
        }
      };

      const mockMsg = {
        fromMe: false,
        from: '8801755667788@c.us',
        to: '8801340517587@c.us',
        body: 'Amar ei script diye video banai den',
        getChat: async () => mockChat
      };

      const res = await handleMessageCreate({
        msg: mockMsg,
        client: mockClient,
        db,
        classifierFn: async () => {
          classifierCalled = true;
          return { classification: 'VOICE_JOB' };
        }
      });

      assert.strictEqual(classifierCalled, false, 'Classifier must NOT be called for video customer when enabled');
      assert.strictEqual(res?.action, 'VIDEO_CUSTOMER_ESCALATED_TO_VE3');
      assert.strictEqual(res?.details?.delivered, true);

      const ve3Msg = sentMessages.find(m => m.jid && m.jid.includes('8801831366604'));
      assert.ok(ve3Msg, 'VE3 receives escalation');
      assert.ok(ve3Msg.text.includes('ভিডিও গ্রাহক'));
      db.close();
    });
  });

  describe('ai_classifier_enabled Toggle', () => {
    it('when ai_classifier_enabled is false, customer script messages are not sent to the classifier', async () => {
      const db = initDb(':memory:');
      setBotSetting(db, 'ai_classifier_enabled', false);

      let classifierCalled = false;
      const mockChat = {
        id: { _serialized: '8801712345678@c.us' },
        fetchMessages: async () => [
          { fromMe: false, body: 'Amar script ta voice banai den' }
        ]
      };

      const mockMsg = {
        fromMe: false,
        from: '8801712345678@c.us',
        to: '8801340517587@c.us',
        body: 'Amar script ta voice banai den',
        getChat: async () => mockChat
      };

      const mockClient = {
        info: { wid: { user: '8801340517587' } },
        getContactById: async () => ({ isMyContact: false, name: 'Customer Test' }),
        sendMessage: async () => {}
      };

      const res = await handleMessageCreate({
        msg: mockMsg,
        client: mockClient,
        db,
        classifierFn: async () => {
          classifierCalled = true;
          return { classification: 'VOICE_JOB', extracted_script: 'Amar script ta' };
        }
      });

      assert.strictEqual(classifierCalled, false, 'activeClassifierFn must NOT be invoked when ai_classifier_enabled is false');
      assert.strictEqual(res?.action, 'CLASSIFIER_DISABLED');
      db.close();
    });

    it('when ai_classifier_enabled is default (true), customer script messages are sent to the classifier', async () => {
      const db = initDb(':memory:');
      let classifierCalled = false;
      const mockChat = {
        id: { _serialized: '8801712345678@c.us' },
        fetchMessages: async () => [
          { fromMe: false, body: 'Amar script ta voice banai den' }
        ],
        sendMessage: async () => {}
      };

      const mockMsg = {
        fromMe: false,
        from: '8801712345678@c.us',
        to: '8801340517587@c.us',
        body: 'Amar script ta voice banai den',
        getChat: async () => mockChat
      };

      const mockClient = {
        info: { wid: { user: '8801340517587' } },
        getContactById: async () => ({ isMyContact: false, name: 'Customer Test' }),
        sendMessage: async () => {}
      };

      const res = await handleMessageCreate({
        msg: mockMsg,
        client: mockClient,
        db,
        classifierFn: async () => {
          classifierCalled = true;
          return { classification: 'VOICE_JOB', extracted_script: 'Amar script ta' };
        }
      });

      assert.strictEqual(classifierCalled, true, 'Classifier was invoked');
      assert.strictEqual(res?.action, 'VOICE_JOB_DISPATCHED');
      db.close();
    });
  });

  describe('aircheck_enabled Toggle', () => {
    it('when aircheck_enabled is false, VA2 non-Bengali audio reply bypasses cleanVoiceoverAudio and delivers original buffer', async () => {
      const db = initDb(':memory:');
      setBotSetting(db, 'aircheck_enabled', false);

      const order = createVoiceJobOrder(db, {
        customerPhone: '8801799887766',
        customerName: 'Karim',
        customerScriptMsgId: 'cust-script-msg-101',
        va2ForwardMsgId: 'va2-fwd-msg-102',
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

      const wavBuffer = createWavBuffer(60);
      const va2Msg = {
        id: { _serialized: 'va2-audio-reply-103', id: 'va2-audio-reply-103' },
        fromMe: false,
        from: '8801307760509@c.us',
        to: '8801340517587@c.us',
        hasMedia: true,
        type: 'document',
        filename: 'recording_raw.wav',
        mimetype: 'audio/wav',
        hasQuotedMsg: true,
        getQuotedMessage: async () => ({
          id: { _serialized: 'va2-fwd-msg-102' },
          body: `[নতুন ভয়েস অর্ডার #${order.order_id}]\n\nস্ক্রিপ্ট:\n${order.script_text}`
        }),
        downloadMedia: async () => ({
          data: wavBuffer.toString('base64'),
          mimetype: 'audio/wav',
          filename: 'recording_raw.wav'
        })
      };

      let aircheckCleanCalled = false;
      const res = await handleMessageCreate({
        msg: va2Msg,
        client: mockClient,
        db,
        cleanVoiceoverAudioFn: async () => {
          aircheckCleanCalled = true;
          throw new Error('cleanVoiceoverAudio should not be called when aircheck_enabled is false!');
        }
      });

      assert.strictEqual(aircheckCleanCalled, false, 'AirCheck cleanVoiceoverAudio must NOT be called');
      assert.strictEqual(res.action, 'AIRCHECK_FAILED_NOTIFIED_VA2');
      assert.strictEqual(res.details.orderId, order.order_id);
      assert.strictEqual(res.details.customerPhone, '8801799887766');
      assert.strictEqual(res.details.message, 'এটা এডিট করে, স্ক্রিপ্টে রিপ্লাই দিয়ে পাঠান');

      // Verify customer was NOT sent any audio, and VA2 was asked to edit quoting the script
      assert.strictEqual(sentMessages.length, 1);
      assert.strictEqual(sentMessages[0].jid, '8801307760509@c.us');
      assert.strictEqual(sentMessages[0].content, 'এটা এডিট করে, স্ক্রিপ্টে রিপ্লাই দিয়ে পাঠান');
      assert.strictEqual(sentMessages[0].options.quotedMessageId, 'va2-fwd-msg-102');

      // Verify order remains pending so VA2 can re-deliver after editing
      const currentOrder = db.prepare('SELECT * FROM voice_job_orders WHERE order_id = ?').get(order.order_id);
      assert.strictEqual(currentOrder.status, 'PENDING_VA2');
      db.close();
    });

    it('when AirCheck fails (models fail or rate-limited), notifies VA2 quoting script and does not send raw audio to customer', async () => {
      const db = initDb(':memory:');

      const order = createVoiceJobOrder(db, {
        customerPhone: '8801799887766',
        customerName: 'Karim',
        customerScriptMsgId: 'cust-script-msg-301',
        va2ForwardMsgId: 'va2-fwd-msg-302',
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

      const wavBuffer = createWavBuffer(83);
      const va2Msg = {
        id: { _serialized: 'va2-audio-reply-303', id: 'va2-audio-reply-303' },
        fromMe: false,
        from: '8801307760509@c.us',
        to: '8801340517587@c.us',
        hasMedia: true,
        type: 'document',
        filename: 'recording_with_errors.wav',
        mimetype: 'audio/wav',
        hasQuotedMsg: true,
        getQuotedMessage: async () => ({
          id: { _serialized: 'va2-fwd-msg-302' },
          body: `[নতুন ভয়েস অর্ডার #${order.order_id}]\n\nস্ক্রিপ্ট:\n${order.script_text}`
        }),
        downloadMedia: async () => ({
          data: wavBuffer.toString('base64'),
          mimetype: 'audio/wav',
          filename: 'recording_with_errors.wav'
        })
      };

      // Mock cleanVoiceoverAudioFn returning failure (e.g. Gemini 429 quota exhaustion)
      const res = await handleMessageCreate({
        msg: va2Msg,
        client: mockClient,
        db,
        cleanVoiceoverAudioFn: async () => ({
          cleanBuffer: wavBuffer,
          durationSeconds: 83,
          cutsCount: 0,
          modelUsed: 'fallback',
          failed: true,
          error: 'HTTP 429 Quota Exceeded'
        })
      });

      assert.strictEqual(res.action, 'AIRCHECK_FAILED_NOTIFIED_VA2');
      assert.strictEqual(res.details.orderId, order.order_id);
      assert.strictEqual(res.details.customerPhone, '8801799887766');
      assert.strictEqual(res.details.message, 'এটা এডিট করে, স্ক্রিপ্টে রিপ্লাই দিয়ে পাঠান');

      // VA2 receives quoted instruction on the job's script message
      assert.strictEqual(sentMessages.length, 1);
      assert.strictEqual(sentMessages[0].jid, '8801307760509@c.us');
      assert.strictEqual(sentMessages[0].content, 'এটা এডিট করে, স্ক্রিপ্টে রিপ্লাই দিয়ে পাঠান');
      assert.strictEqual(sentMessages[0].options.quotedMessageId, 'va2-fwd-msg-302');

      // Order remains pending for VA2's edited replacement
      const currentOrder = db.prepare('SELECT * FROM voice_job_orders WHERE order_id = ?').get(order.order_id);
      assert.strictEqual(currentOrder.status, 'PENDING_VA2');
      db.close();
    });

    it('when aircheck_enabled is default (true), VA2 non-Bengali audio reply runs cleanVoiceoverAudio', async () => {
      const db = initDb(':memory:');

      const order = createVoiceJobOrder(db, {
        customerPhone: '8801799887766',
        customerName: 'Karim',
        customerScriptMsgId: 'cust-script-msg-201',
        va2ForwardMsgId: 'va2-fwd-msg-202',
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

      const wavBuffer = createWavBuffer(83);
      const va2Msg = {
        id: { _serialized: 'va2-audio-reply-203', id: 'va2-audio-reply-203' },
        fromMe: false,
        from: '8801307760509@c.us',
        to: '8801340517587@c.us',
        hasMedia: true,
        type: 'document',
        filename: 'recording_raw.wav',
        mimetype: 'audio/wav',
        hasQuotedMsg: true,
        getQuotedMessage: async () => ({
          id: { _serialized: 'va2-fwd-msg-202' },
          body: `[নতুন ভয়েস অর্ডার #${order.order_id}]\n\nস্ক্রিপ্ট:\n${order.script_text}`
        }),
        downloadMedia: async () => ({
          data: wavBuffer.toString('base64'),
          mimetype: 'audio/wav',
          filename: 'recording_raw.wav'
        })
      };

      let aircheckCleanCalled = false;
      const res = await handleMessageCreate({
        msg: va2Msg,
        client: mockClient,
        db,
        cleanVoiceoverAudioFn: async ({ audioBuffer }) => {
          aircheckCleanCalled = true;
          return {
            cleanBuffer: audioBuffer,
            durationSeconds: 83,
            cutsCount: 1,
            modelUsed: 'gemini-3.8-flash',
            cuts: [{ cutStartTime: 10, cutEndTime: 15 }]
          };
        }
      });

      assert.strictEqual(aircheckCleanCalled, true, 'AirCheck cleanVoiceoverAudio was called');
      assert.strictEqual(res.action, 'DELIVERED_VA2_AUDIO_AIRCHECK');
      assert.strictEqual(res.details.cutsCount, 1);
      db.close();
    });
  });

  describe('ve3_escalation_enabled Toggle', () => {
    it('when ve3_escalation_enabled is false, non-script messages do not send alert messages to VE3 in handleClassificationAction', async () => {
      const db = initDb(':memory:');
      setBotSetting(db, 've3_escalation_enabled', false);

      const sentMessages = [];
      const client = {
        sendMessage: async (jid, text) => {
          sentMessages.push({ jid, text });
          return { id: { _serialized: 'alert-msg-id' } };
        }
      };

      const res = await handleClassificationAction({
        client,
        chat: null,
        classificationResult: {
          classification: 'OTHER',
          reason: 'General inquiry message'
        },
        customerPhone: '8801700000000',
        latestMessageText: 'Ami ki apnader office e ashte pari?',
        db
      });

      assert.strictEqual(res.action, 'ESCALATION_DISABLED');
      assert.strictEqual(sentMessages.length, 0, 'No alert message sent to VE3 when ve3_escalation_enabled is false');
      db.close();
    });

    it('when ve3_escalation_enabled is false, timeout in schedulePendingConfirmation skips sending VE3 alert', async () => {
      clearAllPendingConfirmations();
      const db = initDb(':memory:');
      setBotSetting(db, 've3_escalation_enabled', false);

      const sentMessages = [];
      const client = {
        sendMessage: async (jid, text) => {
          sentMessages.push({ jid, text });
          return { id: { _serialized: 'timeout-alert-id' } };
        }
      };

      schedulePendingConfirmation({
        client,
        customerPhone: '8801711223344',
        customerName: 'Test Client',
        script: 'Unanswered test script',
        timeoutMs: 30,
        db
      });

      // Wait for timer to expire
      await new Promise(resolve => setTimeout(resolve, 60));

      assert.strictEqual(sentMessages.length, 0, 'No timeout alert sent to VE3 when ve3_escalation_enabled is false');
      clearAllPendingConfirmations();
      db.close();
    });

    it('when ve3_escalation_enabled is default (true), non-script messages send alert messages to VE3', async () => {
      const db = initDb(':memory:');
      const sentMessages = [];
      const client = {
        sendMessage: async (jid, text) => {
          sentMessages.push({ jid, text });
          return { id: { _serialized: 'alert-msg-id' } };
        }
      };

      const res = await handleClassificationAction({
        client,
        chat: null,
        classificationResult: {
          classification: 'OTHER',
          reason: 'General inquiry message'
        },
        customerPhone: '8801700000000',
        latestMessageText: 'Ami ki apnader office e ashte pari?',
        db
      });

      assert.strictEqual(res.action, 'ESCALATED_TO_VE3');
      assert.strictEqual(sentMessages.length, 1);
      assert.ok(sentMessages[0].jid.includes('8801831366604'));
      assert.ok(sentMessages[0].text.includes('Ami ki apnader office e ashte pari?'));
      assert.ok(sentMessages[0].text.includes('8801700000000'));
      db.close();
    });
  });

});
