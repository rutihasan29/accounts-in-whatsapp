const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  initDb,
  createVoiceJobOrder,
  savePendingConfirmation,
  getVoiceJobOrder
} = require('../src/db');
const {
  recoverPendingWorkflows,
  catchupUnreadCustomerMessages
} = require('../src/bot');
const {
  restorePendingConfirmations,
  getPendingConfirmation,
  clearAllPendingConfirmations
} = require('../src/dispatch');

describe('Multistep Workflow Recovery & Offline Downtime Catchup', () => {
  it('restorePendingConfirmations re-arms pending confirmation timers from SQLite across restart', () => {
    const db = initDb(':memory:');
    clearAllPendingConfirmations();

    // 1. Customer was asked "ভয়েস?" and recorded in SQLite
    savePendingConfirmation(db, {
      customerPhone: '8801700998877',
      customerName: 'Downtime Customer',
      script: 'নির্বাচনী বিশেষ প্রতিবেদন',
      customerScriptMsgId: 'msg-cust-script-1',
      timeoutMs: 60000,
      askedAt: Date.now() - 5000 // asked 5 seconds ago
    });

    const restoredCount = restorePendingConfirmations({ client: {}, db });
    assert.equal(restoredCount, 1);

    const confirmation = getPendingConfirmation('8801700998877', db);
    assert.ok(confirmation);
    assert.equal(confirmation.script, 'নির্বাচনী বিশেষ প্রতিবেদন');
    assert.equal(confirmation.customerName, 'Downtime Customer');
    clearAllPendingConfirmations();
    db.close();
  });

  it('recoverPendingWorkflows picks up unhandled audio from VA2 chat for PENDING_VA2 orders', async () => {
    const db = initDb(':memory:');

    // Create a pending voice job order waiting for VA2
    const order = createVoiceJobOrder(db, {
      customerPhone: '8801911223344',
      customerName: 'Pending Audio Client',
      customerScriptMsgId: 'cust-script-444',
      va2ForwardMsgId: 'va2-fwd-444',
      scriptText: 'খামারের গরুর দুধের খবর',
      headline: 'গরুর দুধের খবর'
    });

    assert.equal(order.status, 'PENDING_VA2');

    // Simulate VA2's chat having an audio message sent while bot was offline
    const va2AudioMsg = {
      id: { _serialized: 'va2-offline-audio-msg', id: 'va2-offline-audio-msg' },
      fromMe: false,
      from: '8801307760509@c.us',
      to: '8801340517587@c.us',
      hasMedia: true,
      type: 'document',
      filename: 'গরুর দুধের খবর.mp3',
      mimetype: 'audio/mp3',
      hasQuotedMsg: true,
      quotedMsgId: 'va2-fwd-444',
      getQuotedMessage: async () => ({ id: { _serialized: 'va2-fwd-444' } }),
      downloadMedia: async () => ({
        data: Buffer.from('offline-audio-bytes').toString('base64'),
        mimetype: 'audio/mp3',
        filename: 'গরুর দুধের খবর.mp3'
      })
    };

    const mockVa2Chat = {
      id: { _serialized: '8801307760509@c.us' },
      fetchMessages: async () => [va2AudioMsg]
    };

    const sentDeliveries = [];
    const mockClient = {
      info: { wid: { user: '8801340517587' } },
      getChatById: async (jid) => {
        if (jid.includes('8801307760509')) return mockVa2Chat;
        return null;
      },
      sendMessage: async (jid, content, options) => {
        sentDeliveries.push({ jid, content, options });
        return { id: { _serialized: 'ack-recovered' } };
      }
    };

    // Run recovery scanner
    const result = await recoverPendingWorkflows({ client: mockClient, db });
    assert.equal(result.recovered, 1);

    // Verify order was delivered to customer quoting original script
    const updated = getVoiceJobOrder(db, order.order_id);
    assert.equal(updated.status, 'DELIVERED');
    assert.equal(updated.final_audio_filename, 'গরুর দুধের খবর.mp3');
    assert.equal(sentDeliveries.length, 1);
    assert.equal(sentDeliveries[0].jid, '8801911223344@c.us');
    assert.equal(sentDeliveries[0].options.quotedMessageId, 'cust-script-444');
    db.close();
  });

  it('catchupUnreadCustomerMessages processes unread customer scripts sent during downtime', async () => {
    const { recordExistingContact } = require('../src/db');
    const db = initDb(':memory:');
    recordExistingContact(db, { phone: '8801755555555', name: 'Existing Downtime Client' });
    let askedVoice = false;

    const unreadScriptMsg = {
      id: { _serialized: 'unread-script-msg-555', id: 'unread-script-msg-555' },
      fromMe: false,
      from: '8801755555555@c.us',
      to: '8801340517587@c.us',
      body: 'কুমিল্লায় নতুন সেতু উদ্বোধন হয়েছে। মন্ত্রী মহোদয় প্রধান অতিথি ছিলেন।',
      hasMedia: false,
      reply: async (text) => {
        if (text === 'ভয়েস?') askedVoice = true;
      }
    };

    const mockCustomerChat = {
      id: { _serialized: '8801755555555@c.us' },
      isGroup: false,
      unreadCount: 1,
      fetchMessages: async () => [unreadScriptMsg],
      sendMessage: async (text) => {
        if (text === 'ভয়েস?') askedVoice = true;
        return { id: { _serialized: 'voice-ask-ack' } };
      }
    };

    const mockClient = {
      info: { wid: { user: '8801340517587' } },
      getChats: async () => [mockCustomerChat],
      sendMessage: async (jid, text) => {
        if (text === 'ভয়েস?') askedVoice = true;
        return { id: { _serialized: 'voice-ask-ack' } };
      }
    };

    const { handleMessageCreate } = require('../src/bot');
    const result = await catchupUnreadCustomerMessages({
      client: mockClient,
      db,
      handleMessageCreateFn: (opts) => handleMessageCreate({
        ...opts,
        classifierFn: async () => ({
          classification: 'SCRIPT_PENDING_CONFIRMATION',
          confidence: 'HIGH'
        })
      })
    });
    assert.equal(result.processed, 1);
    assert.equal(askedVoice, true, 'Bot should have asked "ভয়েস?" for unread script arriving during downtime');
    db.close();
  });
});
