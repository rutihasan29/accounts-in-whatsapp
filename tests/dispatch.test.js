const test = require('node:test');
const assert = require('node:assert/strict');
const { handleClassificationAction } = require('../src/dispatch');

test('handleClassificationAction routes VOICE_JOB to customer and VA2', async () => {
  const sentMessages = [];
  const mockClient = {
    sendMessage: async (jid, text) => {
      sentMessages.push({ jid, text });
      return { id: { _serialized: 'msg-id' } };
    }
  };
  const mockChat = {
    id: { _serialized: '8801700000000@c.us' },
    sendMessage: async (text) => {
      sentMessages.push({ jid: 'customer', text });
      return { id: { _serialized: 'msg-id' } };
    }
  };

  const res = await handleClassificationAction({
    client: mockClient,
    chat: mockChat,
    classificationResult: {
      classification: 'VOICE_JOB',
      extracted_script: 'My voiceover script text'
    },
    customerPhone: '8801700000000',
    customerName: 'Rahim'
  });

  assert.equal(res.action, 'VOICE_JOB_DISPATCHED');
  assert.equal(res.details.delivered, true);
  // Check customer received "ওকে"
  assert.ok(sentMessages.some(m => m.jid === 'customer' && m.text === 'ওকে'));
  // Check VA2 received script and customer name
  assert.ok(sentMessages.some(m => m.jid.includes('8801307760509') && m.text.includes('My voiceover script text') && m.text.includes('(Rahim)')));
});

test('handleClassificationAction routes VOICE_JOB with latestMessageText fallback and gracefully handles chat error', async () => {
  const sentMessages = [];
  const mockClient = {
    sendMessage: async (jid, text) => {
      sentMessages.push({ jid, text });
      return { id: { _serialized: 'msg-id' } };
    }
  };
  const mockChat = {
    sendMessage: async () => {
      throw new Error('Network error');
    }
  };

  const res = await handleClassificationAction({
    client: mockClient,
    chat: mockChat,
    classificationResult: {
      classification: 'VOICE_JOB'
    },
    customerPhone: '8801700000000',
    latestMessageText: 'Fallback script content'
  });

  assert.equal(res.action, 'VOICE_JOB_DISPATCHED');
  assert.equal(res.details.script, 'Fallback script content');
  assert.ok(sentMessages.some(m => m.jid.includes('8801307760509') && m.text.includes('Fallback script content')));
});

test('handleClassificationAction routes SCRIPT_PENDING_CONFIRMATION to customer', async () => {
  const sentMessages = [];
  const mockChat = {
    id: { _serialized: '8801700000000@c.us' },
    sendMessage: async (text) => {
      sentMessages.push({ jid: 'customer', text });
      return { id: { _serialized: 'msg-id' } };
    }
  };

  const res = await handleClassificationAction({
    chat: mockChat,
    classificationResult: {
      classification: 'SCRIPT_PENDING_CONFIRMATION'
    },
    customerPhone: '8801700000000'
  });

  assert.equal(res.action, 'SCRIPT_CONFIRMATION_ASKED');
  assert.equal(res.details.delivered, true);
  assert.ok(sentMessages.some(m => m.text === 'শুধু ভয়েস? '));
});

test('handleClassificationAction routes ESCALATE to VE3', async () => {
  const sentMessages = [];
  const mockClient = {
    sendMessage: async (jid, text) => {
      sentMessages.push({ jid, text });
      return { id: { _serialized: 'msg-id' } };
    }
  };
  const mockChat = {
    id: { _serialized: '8801700000000@c.us' }
  };

  const res = await handleClassificationAction({
    client: mockClient,
    chat: mockChat,
    classificationResult: {
      classification: 'ESCALATE',
      reason: 'Pricing query'
    },
    customerPhone: '8801700000000',
    latestMessageText: 'Eitar dam koto?'
  });

  assert.equal(res.action, 'ESCALATED_TO_VE3');
  assert.equal(res.details.delivered, true);
  assert.ok(sentMessages.some(m => m.jid.includes('8801831366604') && m.text.includes('8801700000000') && m.text.includes('Eitar dam koto?')));
});

test('handleClassificationAction routes OTHER to NO_ACTION_REQUIRED', async () => {
  const res = await handleClassificationAction({
    classificationResult: {
      classification: 'OTHER'
    },
    customerPhone: '8801700000000'
  });

  assert.equal(res.action, 'NO_ACTION_REQUIRED');
  assert.equal(res.details.delivered, false);
});

test('handleClassificationAction falls back to client.sendMessage when chat is null in VOICE_JOB', async () => {
  const sentMessages = [];
  const mockClient = {
    sendMessage: async (jid, text) => {
      sentMessages.push({ jid, text });
      return { id: { _serialized: 'msg-id' } };
    }
  };

  const res = await handleClassificationAction({
    client: mockClient,
    chat: null,
    classificationResult: {
      classification: 'VOICE_JOB',
      extracted_script: 'Standalone script'
    },
    customerPhone: '+8801700000000'
  });

  assert.equal(res.action, 'VOICE_JOB_DISPATCHED');
  assert.equal(res.details.customerPhone, '8801700000000');
  assert.equal(res.details.delivered, true);
  // Verify client sent "ওকে" to customer JID directly
  assert.ok(sentMessages.some(m => m.jid === '8801700000000@c.us' && m.text === 'ওকে'));
  // Verify VA2 forward
  assert.ok(sentMessages.some(m => m.jid.includes('8801307760509')));
});

test('handleClassificationAction reports delivered: false when forwarding fails', async () => {
  const mockClient = {
    sendMessage: async () => {
      throw new Error('Network timeout');
    }
  };

  const res = await handleClassificationAction({
    client: mockClient,
    chat: null,
    classificationResult: {
      classification: 'ESCALATE',
      reason: 'Network inquiry'
    },
    customerPhone: '+8801700000000'
  });

  assert.equal(res.action, 'ESCALATED_TO_VE3');
  assert.equal(res.details.delivered, false);
});
