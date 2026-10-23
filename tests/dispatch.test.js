const test = require('node:test');
const assert = require('node:assert/strict');
const {
  handleClassificationAction,
  cancelPendingConfirmation,
  schedulePendingConfirmation,
  getPendingConfirmation,
  clearAllPendingConfirmations
} = require('../src/dispatch');
const { initDb } = require('../src/db');

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
  // Check VA2 received script ONLY, and NEVER customer name or phone number
  const va2Msg = sentMessages.find(m => m.jid.includes('8801307760509'));
  assert.ok(va2Msg);
  assert.ok(va2Msg.text.includes('My voiceover script text'));
  assert.ok(!va2Msg.text.includes('Rahim'), 'VA2 must never receive customer name');
  assert.ok(!va2Msg.text.includes('8801700000000'), 'VA2 must never receive customer phone number');
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
  assert.ok(sentMessages.some(m => m.text === 'ভয়েস?'));
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

test('handleClassificationAction routes OTHER to ESCALATED_TO_VE3', async () => {
  const sentMessages = [];
  const mockClient = {
    sendMessage: async (jid, text) => {
      sentMessages.push({ jid, text });
      return { id: { _serialized: 'msg-id' } };
    }
  };

  const res = await handleClassificationAction({
    client: mockClient,
    classificationResult: {
      classification: 'OTHER',
      reason: 'Casual greeting'
    },
    customerPhone: '8801700000000',
    latestMessageText: 'Hello kemon আছেন?'
  });

  assert.equal(res.action, 'ESCALATED_TO_VE3');
  assert.equal(res.details.delivered, true);
  assert.ok(sentMessages.some(m => m.jid.includes('8801831366604') && m.text.includes('8801700000000') && m.text.includes('Hello kemon আছেন?')));
});

test('handleClassificationAction escalates any unrecognized or other category to VE3', async () => {
  const sentMessages = [];
  const mockClient = {
    sendMessage: async (jid, text) => {
      sentMessages.push({ jid, text });
      return { id: { _serialized: 'msg-id' } };
    }
  };

  const res = await handleClassificationAction({
    client: mockClient,
    classificationResult: {
      classification: 'UNKNOWN_OR_NULL'
    },
    customerPhone: '8801700000000',
    latestMessageText: 'Random unstructured message'
  });

  assert.equal(res.action, 'ESCALATED_TO_VE3');
  assert.equal(res.details.delivered, true);
  assert.ok(sentMessages.some(m => m.jid.includes('8801831366604') && m.text.includes('Random unstructured message')));
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

test('schedulePendingConfirmation alerts VE3 after timeout expires', async () => {
  clearAllPendingConfirmations();
  const sentMessages = [];
  const mockClient = {
    sendMessage: async (jid, text) => {
      sentMessages.push({ jid, text });
      return { id: { _serialized: 'msg-id' } };
    }
  };

  schedulePendingConfirmation({
    client: mockClient,
    customerPhone: '8801711223344',
    customerName: 'Test Customer',
    script: 'Sample script awaiting voice confirmation',
    timeoutMs: 30
  });

  const pending = getPendingConfirmation('8801711223344');
  assert.ok(pending);
  assert.equal(pending.script, 'Sample script awaiting voice confirmation');

  // Wait for 50ms so timer fires
  await new Promise(r => setTimeout(r, 60));

  // Should have sent alert to VE3
  assert.equal(sentMessages.length, 1);
  assert.ok(sentMessages[0].jid.includes('8801831366604'));
  assert.ok(sentMessages[0].text.includes('8801711223344'));
  assert.ok(sentMessages[0].text.includes('Sample script awaiting voice confirmation'));
  assert.ok(sentMessages[0].text.includes('Test Customer'));

  // Should no longer be pending
  assert.equal(getPendingConfirmation('8801711223344'), null);
});

test('cancelPendingConfirmation prevents alert from firing', async () => {
  clearAllPendingConfirmations();
  const sentMessages = [];
  const mockClient = {
    sendMessage: async (jid, text) => {
      sentMessages.push({ jid, text });
      return { id: { _serialized: 'msg-id' } };
    }
  };

  schedulePendingConfirmation({
    client: mockClient,
    customerPhone: '8801711223344',
    script: 'Script to cancel',
    timeoutMs: 50
  });

  const cancelled = cancelPendingConfirmation('8801711223344');
  assert.equal(cancelled, true);
  assert.equal(getPendingConfirmation('8801711223344'), null);

  await new Promise(r => setTimeout(r, 70));
  assert.equal(sentMessages.length, 0);
});

test('handleClassificationAction schedules timeout on SCRIPT_PENDING_CONFIRMATION and cancels on next classification', async () => {
  clearAllPendingConfirmations();
  const sentMessages = [];
  const mockClient = {
    sendMessage: async (jid, text) => {
      sentMessages.push({ jid, text });
      return { id: { _serialized: 'msg-id' } };
    }
  };
  const mockChat = {
    sendMessage: async (text) => {
      sentMessages.push({ jid: 'customer', text });
      return { id: { _serialized: 'msg-id' } };
    }
  };

  // 1. Script received -> asks "শুধু ভয়েস?" and schedules timeout
  await handleClassificationAction({
    client: mockClient,
    chat: mockChat,
    classificationResult: {
      classification: 'SCRIPT_PENDING_CONFIRMATION',
      extracted_script: 'Special ad script'
    },
    customerPhone: '8801799999999',
    customerName: 'Karim',
    timeoutMs: 100
  });

  assert.ok(getPendingConfirmation('8801799999999'));

  // 2. Customer confirms with VOICE_JOB -> cancels pending confirmation
  await handleClassificationAction({
    client: mockClient,
    chat: mockChat,
    classificationResult: {
      classification: 'VOICE_JOB',
      extracted_script: 'Special ad script'
    },
    customerPhone: '8801799999999',
    customerName: 'Karim'
  });

  assert.equal(getPendingConfirmation('8801799999999'), null);

  // Wait 120ms to verify no unanswered alert was triggered
  await new Promise(r => setTimeout(r, 120));
  assert.ok(!sentMessages.some(m => m.text.includes('Unanswered Script Alert')));
  clearAllPendingConfirmations();
});

test('handleClassificationAction directly escalates VIDEO_CUSTOMER to VE3 without questioning customer', async () => {
  clearAllPendingConfirmations();
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

  // Pre-set pending confirmation to test it gets cancelled
  schedulePendingConfirmation({
    client: mockClient,
    customerPhone: '8801700000000',
    customerName: 'Video Client',
    script: 'Old pending script',
    timeoutMs: 10000
  });
  assert.ok(getPendingConfirmation('8801700000000'));

  const res = await handleClassificationAction({
    client: mockClient,
    chat: mockChat,
    classificationResult: {
      classification: 'VIDEO_CUSTOMER',
      extracted_script: 'Eita diye ekta video banai den',
      reason: 'ভিডিও গ্রাহক—কোনো প্রশ্ন ছাড়াই সরাসরি VE3 তে ফরোয়ার্ড'
    },
    customerPhone: '8801700000000',
    customerName: 'Video Client',
    latestMessageText: 'Eita diye ekta video banai den'
  });

  assert.equal(res.action, 'VIDEO_CUSTOMER_ESCALATED_TO_VE3');
  assert.equal(res.details.delivered, true);
  assert.equal(res.details.classification, 'VIDEO_CUSTOMER');

  // Customer should NOT have received any message (no "ওকে", no "শুধু ভয়েস?")
  assert.ok(!sentMessages.some(m => m.jid === 'customer'), 'Customer must never be asked anything');

  // Pending confirmation should be cleared
  assert.equal(getPendingConfirmation('8801700000000'), null);

  // VE3 should have received the escalation message with video customer header and details
  const ve3Msg = sentMessages.find(m => m.jid.includes('8801831366604'));
  assert.ok(ve3Msg, 'VE3 must receive the escalation message');
  assert.ok(ve3Msg.text.includes('ভিডিও গ্রাহকের বার্তা'));
  assert.ok(ve3Msg.text.includes('8801700000000'));
  assert.ok(ve3Msg.text.includes('Video Client'));
  assert.ok(ve3Msg.text.includes('Eita diye ekta video banai den'));
});

test('VOICE_JOB dispatch with db records a voice_job_orders row with customer_script_msg_id, va2_forward_msg_id, script_text, and headline', async () => {
  const db = initDb(':memory:');
  const sentMessages = [];
  const mockClient = {
    sendMessage: async (jid, text) => {
      sentMessages.push({ jid, text });
      return { id: { _serialized: 'va2-forward-msg-999' } };
    }
  };
  const mockChat = {
    id: { _serialized: '8801700000000@c.us' },
    sendMessage: async () => ({ id: { _serialized: 'ack-msg-1' } })
  };

  const res = await handleClassificationAction({
    client: mockClient,
    chat: mockChat,
    classificationResult: {
      classification: 'VOICE_JOB',
      extracted_script: 'ঢাকার সেরা বিরিয়ানি এখন উত্তরায় পাওয়া যাচ্ছে।'
    },
    customerPhone: '8801700000000',
    customerName: 'Rahim',
    customerScriptMsgId: 'customer-script-msg-111',
    db
  });

  assert.equal(res.action, 'VOICE_JOB_DISPATCHED');
  assert.equal(res.details.delivered, true);
  assert.equal(res.details.va2ForwardMsgId, 'va2-forward-msg-999');
  assert.ok(res.details.orderId);
  assert.ok(res.details.headline);

  const row = db.prepare('SELECT * FROM voice_job_orders WHERE order_id = ?').get(res.details.orderId);
  assert.ok(row);
  assert.equal(row.customer_phone, '8801700000000');
  assert.equal(row.customer_name, 'Rahim');
  assert.equal(row.customer_script_msg_id, 'customer-script-msg-111');
  assert.equal(row.va2_forward_msg_id, 'va2-forward-msg-999');
  assert.equal(row.script_text, 'ঢাকার সেরা বিরিয়ানি এখন উত্তরায় পাওয়া যাচ্ছে।');
  assert.equal(row.headline, res.details.headline);
  assert.equal(row.status, 'PENDING_VA2');
  db.close();
});

test('VOICE_JOB dispatch without db succeeds gracefully without throwing', async () => {
  const mockClient = {
    sendMessage: async (jid, text) => {
      return { id: { _serialized: 'va2-forward-msg-888' } };
    }
  };
  const mockChat = {
    sendMessage: async () => ({ id: { _serialized: 'ack-msg-2' } })
  };

  const res = await handleClassificationAction({
    client: mockClient,
    chat: mockChat,
    classificationResult: {
      classification: 'VOICE_JOB',
      extracted_script: 'নোয়াখালীর খাঁটি নারকেল তেল'
    },
    customerPhone: '8801800000000',
    customerName: 'Karim',
    customerScriptMsgId: 'msg-no-db',
    db: null
  });

  assert.equal(res.action, 'VOICE_JOB_DISPATCHED');
  assert.equal(res.details.delivered, true);
  assert.equal(res.details.orderId, null);
  assert.equal(res.details.va2ForwardMsgId, 'va2-forward-msg-888');
  assert.ok(res.details.headline);
});
