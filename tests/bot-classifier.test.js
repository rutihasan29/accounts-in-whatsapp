const test = require('node:test');
const assert = require('node:assert/strict');
const { handleMessageCreate } = require('../src/bot');

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
  assert.equal(sentPrompt, 'শুধু ভয়েস? ');
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

  assert.equal(res?.action, 'NO_ACTION_REQUIRED');
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

