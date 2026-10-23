const test = require('node:test');
const assert = require('node:assert/strict');
const { handleMessageCreate } = require('../src/bot');
const { initDb, addVideoCustomer } = require('../src/db');
const {
  schedulePendingConfirmation,
  getPendingConfirmation,
  clearAllPendingConfirmations
} = require('../src/dispatch');

test('handleMessageCreate triggers classifier on incoming customer message', async () => {
  let fetchedMessages = false;
  let chatSentText = null;

  const mockChat = {
    id: { _serialized: '8801712345678@c.us' },
    fetchMessages: async () => {
      fetchedMessages = true;
      return [
        { fromMe: false, body: 'Amar script ta voice banai den: Test Script' }
      ];
    },
    sendMessage: async (text) => {
      chatSentText = text;
    }
  };

  const mockMsg = {
    fromMe: false,
    from: '8801712345678@c.us',
    to: '8801340517587@c.us',
    body: 'Amar script ta voice banai den: Test Script',
    getChat: async () => mockChat
  };

  const mockClient = {
    info: { wid: { user: '8801340517587' } },
    getContactById: async () => ({ isMyContact: false, name: 'Customer Test' }),
    sendMessage: async () => {}
  };

  // Dummy DB instance
  const mockDb = {
    prepare: () => ({ get: () => null, run: () => ({}) })
  };

  // We can pass classifier mock through env or dependency injection
  const res = await handleMessageCreate({
    msg: mockMsg,
    client: mockClient,
    db: mockDb,
    classifierFn: async () => ({
      classification: 'VOICE_JOB',
      extracted_script: 'Test Script'
    })
  });

  assert.ok(fetchedMessages, 'Chat messages should have been fetched');
  assert.equal(res?.action, 'VOICE_JOB_DISPATCHED');
});

test('handleMessageCreate handles SCRIPT_PENDING_CONFIRMATION dispatch', async () => {
  let sentPrompt = null;
  const mockChat = {
    id: { _serialized: '8801712345678@c.us' },
    fetchMessages: async () => [
      { fromMe: false, body: 'Raw script without voice keyword' }
    ],
    sendMessage: async (text) => {
      sentPrompt = text;
    }
  };

  const mockMsg = {
    fromMe: false,
    from: '8801712345678@c.us',
    to: '8801340517587@c.us',
    body: 'Raw script without voice keyword',
    getChat: async () => mockChat
  };

  const mockClient = {
    info: { wid: { user: '8801340517587' } },
    getContactById: async () => ({ isMyContact: false, name: 'Customer Test' }),
    sendMessage: async () => {}
  };

  const mockDb = {
    prepare: () => ({ get: () => null, run: () => ({}) })
  };

  const res = await handleMessageCreate({
    msg: mockMsg,
    client: mockClient,
    db: mockDb,
    classifierFn: async () => ({
      classification: 'SCRIPT_PENDING_CONFIRMATION',
      extracted_script: ''
    })
  });

  assert.equal(res?.action, 'SCRIPT_CONFIRMATION_ASKED');
  assert.equal(sentPrompt, 'ভয়েস?');
});

test('handleMessageCreate handles ESCALATE dispatch to VE3', async () => {
  const sentVE3 = [];
  const mockChat = {
    id: { _serialized: '8801712345678@c.us' },
    fetchMessages: async () => [
      { fromMe: false, body: 'Video banano jabe?' }
    ]
  };

  const mockMsg = {
    fromMe: false,
    from: '8801712345678@c.us',
    to: '8801340517587@c.us',
    body: 'Video banano jabe?',
    getChat: async () => mockChat
  };

  const mockClient = {
    info: { wid: { user: '8801340517587' } },
    getContactById: async () => ({ isMyContact: false, name: 'Customer Test' }),
    sendMessage: async (jid, text) => {
      sentVE3.push({ jid, text });
    }
  };

  const mockDb = {
    prepare: () => ({ get: () => null, run: () => ({}) })
  };

  const res = await handleMessageCreate({
    msg: mockMsg,
    client: mockClient,
    db: mockDb,
    classifierFn: async () => ({
      classification: 'ESCALATE',
      reason: 'Customer inquired about video production'
    })
  });

  assert.equal(res?.action, 'ESCALATED_TO_VE3');
  assert.ok(sentVE3.some(m => m.jid.includes('8801831366604') && /Customer Escalation/.test(m.text)));
});

test('handleMessageCreate passes myUser to classifierFn', async () => {
  let passedMyUser = null;
  const mockChat = {
    id: { _serialized: '8801712345678@c.us' },
    fetchMessages: async () => [{ fromMe: false, body: 'Hello' }]
  };

  const mockMsg = {
    fromMe: false,
    from: '8801712345678@c.us',
    to: '8801340517587@c.us',
    body: 'Hello',
    getChat: async () => mockChat
  };

  const mockClient = {
    info: { wid: { user: '8801340517587' } },
    getContactById: async () => ({ isMyContact: false, name: 'Customer Test' }),
    sendMessage: async () => {}
  };

  const mockDb = {
    prepare: () => ({ get: () => null, run: () => ({}) })
  };

  await handleMessageCreate({
    msg: mockMsg,
    client: mockClient,
    db: mockDb,
    classifierFn: async ({ myUser }) => {
      passedMyUser = myUser;
      return { classification: 'OTHER' };
    }
  });

  assert.equal(passedMyUser, '8801340517587');
});

test('handleMessageCreate falls back to [msg] when chat.fetchMessages is unavailable', async () => {
  let receivedMessages = null;
  const mockMsg = {
    fromMe: false,
    from: '8801712345678@c.us',
    to: '8801340517587@c.us',
    body: 'Direct message without chat object',
    getChat: async () => null
  };

  const mockClient = {
    info: { wid: { user: '8801340517587' } },
    getContactById: async () => ({ isMyContact: false, name: 'Customer Test' }),
    sendMessage: async () => {}
  };

  const mockDb = {
    prepare: () => ({ get: () => null, run: () => ({}) })
  };

  const res = await handleMessageCreate({
    msg: mockMsg,
    client: mockClient,
    db: mockDb,
    classifierFn: async ({ messages }) => {
      receivedMessages = messages;
      return { classification: 'OTHER' };
    }
  });

  assert.equal(res?.action, 'ESCALATED_TO_VE3');
  assert.equal(receivedMessages?.length, 1);
  assert.equal(receivedMessages[0].body, 'Direct message without chat object');
});

test('handleMessageCreate classifies existing contact where welcome demo was already sent', async () => {
  let classified = false;
  const mockChat = {
    id: { _serialized: '8801799999999@c.us' },
    fetchMessages: async () => [{ fromMe: false, body: 'Voice lagbe' }]
  };
  const mockMsg = {
    fromMe: false,
    from: '8801799999999@c.us',
    to: '8801340517587@c.us',
    body: 'Voice lagbe',
    getChat: async () => mockChat
  };
  const mockClient = {
    info: { wid: { user: '8801340517587' } },
    getContactById: async () => ({ isMyContact: false, name: 'Existing Lead' }),
    sendMessage: async () => {}
  };
  // DB returns existing lead with welcome_sent = 1
  const mockDb = {
    prepare: () => ({
      get: () => ({ phone_number: '8801799999999', status: 'PENDING', welcome_sent: 1 }),
      run: () => ({})
    })
  };

  const res = await handleMessageCreate({
    msg: mockMsg,
    client: mockClient,
    db: mockDb,
    classifierFn: async () => {
      classified = true;
      return { classification: 'VOICE_JOB', extracted_script: 'Voice lagbe' };
    }
  });

  assert.equal(classified, true);
  assert.equal(res?.action, 'VOICE_JOB_DISPATCHED');
});

test('handleMessageCreate supports custom dispatchFn injection', async () => {
  let customDispatchCalled = false;
  const mockChat = {
    id: { _serialized: '8801711111111@c.us' },
    fetchMessages: async () => [{ fromMe: false, body: 'Custom dispatch test' }]
  };
  const mockMsg = {
    fromMe: false,
    from: '8801711111111@c.us',
    to: '8801340517587@c.us',
    body: 'Custom dispatch test',
    getChat: async () => mockChat
  };
  const mockClient = {
    info: { wid: { user: '8801340517587' } },
    getContactById: async () => ({ isMyContact: false, name: 'Test User' })
  };
  const mockDb = {
    prepare: () => ({ get: () => ({ phone_number: '8801711111111', welcome_sent: 1 }), run: () => ({}) })
  };

  const res = await handleMessageCreate({
    msg: mockMsg,
    client: mockClient,
    db: mockDb,
    classifierFn: async () => ({ classification: 'OTHER' }),
    dispatchFn: async ({ customerPhone, classificationResult }) => {
      customDispatchCalled = true;
      return { action: 'CUSTOM_DISPATCH_HANDLED', phone: customerPhone, cat: classificationResult.classification };
    }
  });

  assert.equal(customDispatchCalled, true);
  assert.equal(res?.action, 'CUSTOM_DISPATCH_HANDLED');
  assert.equal(res?.phone, '8801711111111');
});

test('handleMessageCreate cancels pending confirmation when customer replies', async () => {
  clearAllPendingConfirmations();
  const mockClient = {
    info: { wid: { user: '8801340517587' } },
    getContactById: async () => ({ isMyContact: false, name: 'Replying Customer' }),
    sendMessage: async () => {}
  };
  const mockChat = {
    id: { _serialized: '8801755555555@c.us' },
    fetchMessages: async () => [{ fromMe: false, body: 'Yes voice only' }],
    sendMessage: async () => {}
  };
  const mockDb = {
    prepare: () => ({ get: () => ({ phone_number: '8801755555555', welcome_sent: 1 }), run: () => ({}) })
  };

  // Pre-schedule pending confirmation
  schedulePendingConfirmation({
    client: mockClient,
    customerPhone: '8801755555555',
    script: 'Some pending script',
    timeoutMs: 60000
  });

  assert.ok(getPendingConfirmation('8801755555555'));

  const mockMsg = {
    fromMe: false,
    from: '8801755555555@c.us',
    to: '8801340517587@c.us',
    body: 'Yes voice only',
    getChat: async () => mockChat
  };

  await handleMessageCreate({
    msg: mockMsg,
    client: mockClient,
    db: mockDb,
    classifierFn: async () => ({ classification: 'VOICE_JOB', extracted_script: 'Some pending script' })
  });

  assert.equal(getPendingConfirmation('8801755555555'), null);
  clearAllPendingConfirmations();
});

test('handleMessageCreate fast-paths customer replying "জি" to pending script without needing LLM', async () => {
  clearAllPendingConfirmations();
  let llmCalled = false;
  const sentMessages = [];
  const mockClient = {
    info: { wid: { user: '8801340517587' } },
    getContactById: async () => ({ isMyContact: false, name: 'Bangla Customer' }),
    sendMessage: async (jid, text) => {
      sentMessages.push({ jid, text });
      return { id: { _serialized: 'msg-id' } };
    }
  };
  const mockChat = {
    id: { _serialized: '8801831952526@c.us' },
    fetchMessages: async () => [{ fromMe: false, body: 'জি' }],
    sendMessage: async (text) => {
      sentMessages.push({ jid: 'customer', text });
      return { id: { _serialized: 'msg-id' } };
    }
  };
  const mockDb = {
    prepare: () => ({ get: () => ({ phone_number: '8801831952526', welcome_sent: 1 }), run: () => ({}) })
  };

  schedulePendingConfirmation({
    client: mockClient,
    customerPhone: '8801831952526',
    script: 'নবাবপুর ফুড সিটি হাউসের স্পেশাল স্ক্রিপ্ট',
    timeoutMs: 60000
  });

  const mockMsg = {
    fromMe: false,
    from: '8801831952526@c.us',
    to: '8801340517587@c.us',
    body: 'জি',
    getChat: async () => mockChat
  };

  const res = await handleMessageCreate({
    msg: mockMsg,
    client: mockClient,
    db: mockDb,
    classifierFn: async () => {
      llmCalled = true;
      return { classification: 'OTHER' };
    }
  });

  assert.equal(llmCalled, false, 'LLM should not even be called when customer replies with affirmative "জি"');
  assert.equal(res?.action, 'VOICE_JOB_DISPATCHED');
  assert.equal(res?.details?.script, 'নবাবপুর ফুড সিটি হাউসের স্পেশাল স্ক্রিপ্ট');
  // Check customer received "ওকে"
  assert.ok(sentMessages.some(m => m.jid === 'customer' && m.text === 'ওকে'));
  // Check VA2 received script
  assert.ok(sentMessages.some(m => m.jid.includes('8801307760509') && m.text.includes('নবাবপুর ফুড সিটি হাউসের স্পেশাল স্ক্রিপ্ট')));
  clearAllPendingConfirmations();
});

test('handleMessageCreate injects pending script into history when customer asks a price question', async () => {
  clearAllPendingConfirmations();
  let receivedHistory = null;
  const mockClient = {
    info: { wid: { user: '8801340517587' } },
    getContactById: async () => ({ isMyContact: false, name: 'Question Customer' }),
    sendMessage: async () => {}
  };
  const mockChat = {
    id: { _serialized: '8801700000000@c.us' },
    fetchMessages: async () => [{ fromMe: false, body: 'ভিডিও সহ কত টাকা লাগবে?' }],
    sendMessage: async () => {}
  };
  const mockDb = {
    prepare: () => ({ get: () => ({ phone_number: '8801700000000', welcome_sent: 1 }), run: () => ({}) })
  };

  schedulePendingConfirmation({
    client: mockClient,
    customerPhone: '8801700000000',
    script: 'Original pending ad script',
    timeoutMs: 60000
  });

  const mockMsg = {
    fromMe: false,
    from: '8801700000000@c.us',
    to: '8801340517587@c.us',
    body: 'ভিডিও সহ কত টাকা লাগবে?',
    getChat: async () => mockChat
  };

  await handleMessageCreate({
    msg: mockMsg,
    client: mockClient,
    db: mockDb,
    classifierFn: async ({ messages }) => {
      receivedHistory = messages;
      return { classification: 'ESCALATE', reason: 'Video inquiry' };
    }
  });

  assert.ok(receivedHistory);
  assert.ok(receivedHistory.some(m => m.body === 'Original pending ad script'));
  assert.ok(receivedHistory.some(m => m.body === 'ভয়েস?'));
  assert.ok(receivedHistory.some(m => m.body === 'ভিডিও সহ কত টাকা লাগবে?'));
  clearAllPendingConfirmations();
});

test('handleMessageCreate fast-paths customer replying "না" to pending script and escalates to VE3', async () => {
  clearAllPendingConfirmations();
  let llmCalled = false;
  const sentMessages = [];
  const mockClient = {
    info: { wid: { user: '8801340517587' } },
    getContactById: async () => ({ isMyContact: false, name: 'Declining Customer' }),
    sendMessage: async (jid, text) => {
      sentMessages.push({ jid, text });
      return { id: { _serialized: 'msg-id' } };
    }
  };
  const mockChat = {
    id: { _serialized: '8801811223344@c.us' },
    fetchMessages: async () => [{ fromMe: false, body: 'না' }],
    sendMessage: async () => {}
  };
  const mockDb = {
    prepare: () => ({ get: () => ({ phone_number: '8801811223344', welcome_sent: 1 }), run: () => ({}) })
  };

  schedulePendingConfirmation({
    client: mockClient,
    customerPhone: '8801811223344',
    customerName: 'Declining Customer',
    script: 'Declined Voice Script Text',
    timeoutMs: 60000
  });

  const mockMsg = {
    fromMe: false,
    from: '8801811223344@c.us',
    to: '8801340517587@c.us',
    body: 'না',
    getChat: async () => mockChat
  };

  const res = await handleMessageCreate({
    msg: mockMsg,
    client: mockClient,
    db: mockDb,
    classifierFn: async () => {
      llmCalled = true;
      return { classification: 'OTHER' };
    }
  });

  assert.equal(llmCalled, false, 'LLM should not be called when customer directly declines voice');
  assert.equal(res?.action, 'ESCALATED_TO_VE3');
  // Check VE3 received escalation with customer number and script
  assert.ok(sentMessages.some(m => m.jid.includes('8801831366604') && m.text.includes('8801811223344') && m.text.includes('Declined Voice Script Text')));
  clearAllPendingConfirmations();
});

test('handleMessageCreate directly escalates inbound message from video customer to VE3 without asking questions or calling LLM', async () => {
  clearAllPendingConfirmations();
  const db = initDb(':memory:');
  addVideoCustomer(db, '8801755667788', 'Regular video client');

  let llmCalled = false;
  let askedCustomerQuestion = false;
  const sentMessages = [];

  const mockClient = {
    info: { wid: { user: '8801340517587' } },
    getContactById: async () => ({ isMyContact: false, name: 'Video Customer Rahim' }),
    sendMessage: async (jid, text) => {
      sentMessages.push({ jid, text });
      return { id: { _serialized: 'msg-id' } };
    }
  };

  const mockChat = {
    id: { _serialized: '8801755667788@c.us' },
    fetchMessages: async () => [{ fromMe: false, body: 'Amar ei script diye video banai den' }],
    sendMessage: async (text) => {
      askedCustomerQuestion = true;
      sentMessages.push({ jid: 'customer', text });
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
      llmCalled = true;
      return { classification: 'VOICE_JOB' };
    }
  });

  assert.equal(llmCalled, false, 'LLM classifier must NOT be called for video customer');
  assert.equal(askedCustomerQuestion, false, 'Bot must NEVER ask customer anything (e.g. "শুধু ভয়েস?")');
  assert.equal(res?.action, 'VIDEO_CUSTOMER_ESCALATED_TO_VE3');
  assert.equal(res?.details?.delivered, true);

  // Check VE3 received escalation with video customer header
  const ve3Msg = sentMessages.find(m => m.jid.includes('8801831366604'));
  assert.ok(ve3Msg, 'VE3 must receive the escalation message');
  assert.ok(ve3Msg.text.includes('ভিডিও গ্রাহকের বার্তা'));
  assert.ok(ve3Msg.text.includes('8801755667788'));
  assert.ok(ve3Msg.text.includes('Amar ei script diye video banai den'));
});

test('handleMessageCreate handles self-chat video commands (add, list, remove)', async () => {
  const db = initDb(':memory:');
  const sentMessages = [];

  const mockClient = {
    info: { wid: { user: '8801340517587' } },
    sendMessage: async (jid, text) => {
      sentMessages.push({ jid, text });
      return { id: { _serialized: 'msg-id' } };
    }
  };

  // 1. video add command in self chat
  const addMsg = {
    fromMe: true,
    from: '8801340517587@c.us',
    to: '8801340517587@c.us',
    body: 'video add 8801799001122 Daily News Video',
    id: { remote: '8801340517587@c.us' }
  };
  const addRes = await handleMessageCreate({ msg: addMsg, client: mockClient, db });
  assert.equal(addRes?.action, 'ADDED_VIDEO_CUSTOMER');
  assert.equal(addRes?.details?.phone, '8801799001122');
  assert.ok(sentMessages.some(m => m.text.includes('সংরক্ষণ করা হয়েছে')));

  // 2. video list command in self chat
  sentMessages.length = 0;
  const listMsg = {
    fromMe: true,
    from: '8801340517587@c.us',
    to: '8801340517587@c.us',
    body: 'video list',
    id: { remote: '8801340517587@c.us' }
  };
  const listRes = await handleMessageCreate({ msg: listMsg, client: mockClient, db });
  assert.equal(listRes?.action, 'LISTED_VIDEO_CUSTOMERS');
  assert.equal(listRes?.details?.count, 1);
  assert.ok(sentMessages.some(m => m.text.includes('8801799001122')));

  // 3. video remove command in self chat
  sentMessages.length = 0;
  const removeMsg = {
    fromMe: true,
    from: '8801340517587@c.us',
    to: '8801340517587@c.us',
    body: 'video remove 8801799001122',
    id: { remote: '8801340517587@c.us' }
  };
  const removeRes = await handleMessageCreate({ msg: removeMsg, client: mockClient, db });
  assert.equal(removeRes?.action, 'REMOVED_VIDEO_CUSTOMER');
  assert.equal(removeRes?.details?.deleted, true);
  assert.ok(sentMessages.some(m => m.text.includes('মুছে ফেলা হয়েছে')));
});

