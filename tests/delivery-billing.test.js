const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  handleMessageCreate,
  handleMessageRevoke
} = require('../src/bot');
const {
  initDb,
  createVoiceJobOrder,
  getCustomerTransactions,
  getBotSetting,
  setBotSetting
} = require('../src/db');
const { isAudioDocumentMessage, isVideoDocumentMessage } = require('../src/audio');

describe('Delivery Billing & Duration Logging Suite', () => {
  it('isAudioDocumentMessage strictly returns false for playable audio (type: audio) and PTT', () => {
    // Playable audio player (welcome sequence demo style)
    const playableAudioMsg = {
      hasMedia: true,
      type: 'audio',
      isVoice: false,
      mimetype: 'audio/ogg; codecs=opus'
    };
    assert.strictEqual(isAudioDocumentMessage(playableAudioMsg), false, 'Playable audio player should not be treated as audio document');

    // PTT voice note
    const pttMsg = {
      hasMedia: true,
      type: 'ptt',
      isVoice: true,
      mimetype: 'audio/ogg; codecs=opus'
    };
    assert.strictEqual(isAudioDocumentMessage(pttMsg), false, 'PTT voice note should not be treated as audio document');

    // Document audio file
    const docAudioMsg = {
      hasMedia: true,
      type: 'document',
      isVoice: false,
      filename: 'voiceover.mp3',
      mimetype: 'audio/mpeg'
    };
    assert.strictEqual(isAudioDocumentMessage(docAudioMsg), true, 'Document audio file should be treated as audio document');
  });

  it('outbound playable audio (type: audio) to client is ignored (no bill, no log)', async () => {
    const db = initDb(':memory:');
    const sentMessages = [];
    const mockClient = {
      sendMessage: async (jid, text) => {
        sentMessages.push({ jid, text });
        return { id: { _serialized: `true_${jid}_msg123`, id: 'msg123' } };
      },
      getContactById: async () => ({ name: 'Test Client' })
    };

    const playableMsg = {
      id: { _serialized: 'true_8801700000001@c.us_demo1', id: 'demo1' },
      fromMe: true,
      from: '8801340517587@c.us',
      to: '8801700000001@c.us',
      hasMedia: true,
      type: 'audio',
      isVoice: false,
      filename: 'sample_audio.mp3',
      mimetype: 'audio/mpeg',
      duration: 30
    };

    const res = await handleMessageCreate({
      msg: playableMsg,
      client: mockClient,
      db
    });

    assert.ok(
      res.action.startsWith('IGNORED_'),
      `Expected ignored action for playable audio to client, got ${res.action}`
    );
    assert.strictEqual(sentMessages.length, 0, 'Should not send any bill for playable audio');
    const txs = getCustomerTransactions(db, '8801700000001');
    assert.strictEqual(txs.length, 0, 'Should not log any transaction for playable audio');
    db.close();
  });

  it('outbound PTT voice note to client is ignored (no bill, no log)', async () => {
    const db = initDb(':memory:');
    const sentMessages = [];
    const mockClient = {
      sendMessage: async (jid, text) => {
        sentMessages.push({ jid, text });
        return { id: { _serialized: `true_${jid}_ptt123`, id: 'ptt123' } };
      },
      getContactById: async () => ({ name: 'Test Client' })
    };

    const pttMsg = {
      id: { _serialized: 'true_8801700000001@c.us_ptt1', id: 'ptt1' },
      fromMe: true,
      from: '8801340517587@c.us',
      to: '8801700000001@c.us',
      hasMedia: true,
      type: 'ptt',
      isVoice: true,
      mimetype: 'audio/ogg; codecs=opus',
      duration: 25
    };

    const res = await handleMessageCreate({
      msg: pttMsg,
      client: mockClient,
      db
    });

    assert.ok(
      res.action.startsWith('IGNORED_'),
      `Expected ignored action for PTT to client, got ${res.action}`
    );
    assert.strictEqual(sentMessages.length, 0, 'Should not send any bill for PTT');
    const txs = getCustomerTransactions(db, '8801700000001');
    assert.strictEqual(txs.length, 0, 'Should not log any transaction for PTT');
    db.close();
  });

  it('outbound audio document to client notes duration and bills correctly', async () => {
    const db = initDb(':memory:');
    const sentMessages = [];
    const mockClient = {
      sendMessage: async (jid, text) => {
        sentMessages.push({ jid, text });
        return { id: { _serialized: `true_${jid}_bill1`, id: 'bill1' } };
      },
      getContactById: async () => ({ name: 'Test Client' })
    };

    // Pending order for this client
    createVoiceJobOrder(db, {
      orderId: 'VJO-TEST-001',
      customerPhone: '8801700000001',
      customerName: 'Test Client',
      scriptText: 'টেস্ট স্ক্রিপ্ট'
    });

    const docAudioMsg = {
      id: { _serialized: 'true_8801700000001@c.us_doc1', id: 'doc1' },
      fromMe: true,
      from: '8801340517587@c.us',
      to: '8801700000001@c.us',
      hasMedia: true,
      type: 'document',
      isVoice: false,
      filename: 'final_delivery.wav',
      mimetype: 'audio/wav',
      duration: 85 // 85s -> 2 min -> 100 Taka
    };

    const res = await handleMessageCreate({
      msg: docAudioMsg,
      client: mockClient,
      db
    });

    assert.strictEqual(res.action, 'SENT_AUDIO_BILL');
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].text, 'বিল ১০০ টাকা');

    const txs = getCustomerTransactions(db, '8801700000001');
    assert.strictEqual(txs.length, 1);
    assert.strictEqual(txs[0].amount, 100);
    assert.strictEqual(txs[0].duration_seconds, 85, 'Duration should be saved in transactions table');
    assert.strictEqual(txs[0].job_type, 'voice');

    // Check order updated
    const order = db.prepare('SELECT * FROM voice_job_orders WHERE order_id = ?').get('VJO-TEST-001');
    assert.strictEqual(order.status, 'DELIVERED');
    assert.strictEqual(order.clean_duration_seconds, 85);
    db.close();
  });

  it('outbound video document sends default 350 Tk auto-bill and logs job_type video', async () => {
    const db = initDb(':memory:');
    const sentMessages = [];
    const mockClient = {
      sendMessage: async (jid, text) => {
        sentMessages.push({ jid, text });
        return { id: { _serialized: `true_${jid}_vidbill1`, id: 'vidbill1' } };
      },
      getContactById: async () => ({ name: 'Video Client' })
    };

    const videoDocMsg = {
      id: { _serialized: 'true_8801700000002@c.us_viddoc1', id: 'viddoc1' },
      fromMe: true,
      from: '8801340517587@c.us',
      to: '8801700000002@c.us',
      hasMedia: true,
      type: 'document',
      filename: 'explainer_video.mp4',
      mimetype: 'video/mp4'
    };

    const res = await handleMessageCreate({
      msg: videoDocMsg,
      client: mockClient,
      db
    });

    assert.strictEqual(res.action, 'SENT_VIDEO_BILL');
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].text, 'বিল ৩৫০ টাকা');

    const txs = getCustomerTransactions(db, '8801700000002');
    assert.strictEqual(txs.length, 1);
    assert.strictEqual(txs[0].amount, 350);
    assert.strictEqual(txs[0].job_type, 'video');
    assert.strictEqual(txs[0].type, 'BILL');
    assert.strictEqual(txs[0].message_id, 'true_8801700000002@c.us_vidbill1');

    // Multi-device echo of the auto-sent bill message should be ignored
    const echoMsg = {
      id: { _serialized: 'true_8801700000002@c.us_vidbill1', id: 'vidbill1' },
      fromMe: true,
      from: '8801340517587@c.us',
      to: '8801700000002@c.us',
      body: 'বিল ৩৫০ টাকা',
      type: 'chat'
    };
    const echoRes = await handleMessageCreate({
      msg: echoMsg,
      client: mockClient,
      db
    });
    assert.strictEqual(echoRes.action, 'IGNORED_ECHO_AUTO_BILL');
    assert.strictEqual(getCustomerTransactions(db, '8801700000002').length, 1);

    db.close();
  });

  it('outbound video document respects auto_video_billing_enabled toggle', async () => {
    const db = initDb(':memory:');
    setBotSetting(db, 'auto_video_billing_enabled', false);

    const sentMessages = [];
    const mockClient = {
      sendMessage: async (jid, text) => {
        sentMessages.push({ jid, text });
        return { id: { _serialized: `true_${jid}_msg1`, id: 'msg1' } };
      },
      getContactById: async () => ({ name: 'Video Client' })
    };

    const videoDocMsg = {
      id: { _serialized: 'true_8801700000002@c.us_viddoc2', id: 'viddoc2' },
      fromMe: true,
      from: '8801340517587@c.us',
      to: '8801700000002@c.us',
      hasMedia: true,
      type: 'document',
      filename: 'ad_video.mp4',
      mimetype: 'video/mp4'
    };

    const res = await handleMessageCreate({
      msg: videoDocMsg,
      client: mockClient,
      db
    });

    assert.strictEqual(res.action, 'VIDEO_BILLING_DISABLED');
    assert.strictEqual(sentMessages.length, 0);
    assert.strictEqual(getCustomerTransactions(db, '8801700000002').length, 0);
    db.close();
  });

  it('unsend (revoke) 350 Tk video bill and replacement bill is logged with job_type video', async () => {
    const db = initDb(':memory:');
    let autoBillMsgId = 'true_8801700000003@c.us_vidbill3';
    const mockClient = {
      sendMessage: async (jid, text) => ({ id: { _serialized: autoBillMsgId, id: 'vidbill3' } }),
      getContactById: async () => ({ name: 'Revoke Video Client' })
    };

    // 1. Send video document -> sends 350 Tk auto bill
    const videoDocMsg = {
      id: { _serialized: 'true_8801700000003@c.us_viddoc3', id: 'viddoc3' },
      fromMe: true,
      from: '8801340517587@c.us',
      to: '8801700000003@c.us',
      hasMedia: true,
      type: 'document',
      filename: 'animation.mp4',
      mimetype: 'video/mp4'
    };

    const sendRes = await handleMessageCreate({
      msg: videoDocMsg,
      client: mockClient,
      db
    });
    assert.strictEqual(sendRes.action, 'SENT_VIDEO_BILL');
    assert.strictEqual(getCustomerTransactions(db, '8801700000003').length, 1);

    // 2. User unsends (Delete for Everyone) the 350 Tk auto bill
    const revokeRes = await handleMessageRevoke({
      after: {
        id: { _serialized: autoBillMsgId, id: 'vidbill3', remote: '8801700000003@c.us' }
      },
      db,
      client: mockClient
    });
    assert.strictEqual(revokeRes.action, 'REVOKED_TRANSACTION');
    assert.strictEqual(getCustomerTransactions(db, '8801700000003').length, 0, 'Transaction must be deleted');

    // 3. User types replacement bill in same format: "বিল ৩০০ টাকা"
    const manualBillMsg = {
      id: { _serialized: 'true_8801700000003@c.us_manualbill3', id: 'manualbill3', remote: '8801700000003@c.us' },
      fromMe: true,
      from: '8801340517587@c.us',
      to: '8801700000003@c.us',
      body: 'বিল ৩০০ টাকা',
      type: 'chat'
    };

    const manualRes = await handleMessageCreate({
      msg: manualBillMsg,
      client: mockClient,
      db
    });
    assert.strictEqual(manualRes.action, 'RECORDED_BILL');

    const txs = getCustomerTransactions(db, '8801700000003');
    assert.strictEqual(txs.length, 1);
    assert.strictEqual(txs[0].amount, 300);
    assert.strictEqual(txs[0].job_type, 'video', 'Manual replacement bill must inherit video job type');
    db.close();
  });

  it('unsend audio bill and replacement manual bill preserves audio duration_seconds', async () => {
    const db = initDb(':memory:');
    let autoBillMsgId = 'true_8801700000004@c.us_audbill4';
    const mockClient = {
      sendMessage: async (jid, text) => ({ id: { _serialized: autoBillMsgId, id: 'audbill4' } }),
      getContactById: async () => ({ name: 'Revoke Audio Client' })
    };

    // 1. Send audio document (75s -> 75 Tk)
    const audioDocMsg = {
      id: { _serialized: 'true_8801700000004@c.us_auddoc4', id: 'auddoc4' },
      fromMe: true,
      from: '8801340517587@c.us',
      to: '8801700000004@c.us',
      hasMedia: true,
      type: 'document',
      filename: 'voice_take.wav',
      mimetype: 'audio/wav',
      duration: 75
    };

    await handleMessageCreate({
      msg: audioDocMsg,
      client: mockClient,
      db
    });

    // 2. Unsend auto-bill
    await handleMessageRevoke({
      after: {
        id: { _serialized: autoBillMsgId, id: 'audbill4', remote: '8801700000004@c.us' }
      },
      db,
      client: mockClient
    });

    // 3. User types replacement bill: "বিল ১০০ টাকা"
    const manualBillMsg = {
      id: { _serialized: 'true_8801700000004@c.us_manualbill4', id: 'manualbill4', remote: '8801700000004@c.us' },
      fromMe: true,
      from: '8801340517587@c.us',
      to: '8801700000004@c.us',
      body: 'বিল ১০০ টাকা',
      type: 'chat'
    };

    const manualRes = await handleMessageCreate({
      msg: manualBillMsg,
      client: mockClient,
      db
    });
    assert.strictEqual(manualRes.action, 'RECORDED_BILL');

    const txs = getCustomerTransactions(db, '8801700000004');
    assert.strictEqual(txs.length, 1);
    assert.strictEqual(txs[0].amount, 100);
    assert.strictEqual(txs[0].job_type, 'voice');
    assert.strictEqual(txs[0].duration_seconds, 75, 'Manual replacement bill should retain delivered audio duration');
    db.close();
  });
});
