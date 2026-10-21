# LLM Incoming Message Classification & Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and integrate an intelligent LLM message classifier and dispatcher that analyzes the last 10 messages of customer chats via Google Gemini 2.5 Flash, handling voice script confirmations, script forwarding to VA2, and escalation alerts to VE3.

**Architecture:** A modular `src/classifier.js` formats chat history and interfaces with Gemini API using native JSON output. In `src/bot.js`, incoming non-self customer messages trigger classification and route actions (`VOICE_JOB` -> reply `ওকে` + forward script to VA2; `SCRIPT_PENDING_CONFIRMATION` -> reply `শুধু ভয়েস? `; `ESCALATE` -> alert VE3 with customer phone and reason).

**Tech Stack:** Node.js (v22 native fetch & loadEnvFile), Google Gemini API (`gemini-2.5-flash`), WhatsApp-web.js, Node test runner (`node --test`).

**Spec:** `docs/superpowers/specs/2026-10-21-incoming-message-classifier-design.md`

## Global Constraints
- **Gemini Model:** `gemini-2.5-flash`
- **VA2 Target:** `8801307760509` (JID: `8801307760509@c.us`)
- **VE3 Target:** `8801831366604` (JID: `8801831366604@c.us`)
- **API Timeout:** 6,000ms with safe fallback to `ESCALATE`
- **Zero Regressions:** All existing 128 tests must continue passing.

---

### Task 1: Environment & Config Setup

**Files:**
- Modify: `src/config.js`
- Test: `tests/config.test.js`

**Interfaces:**
- Produces: `config.GEMINI_API_KEY`, `config.VA2_PHONE`, `config.VE3_PHONE`

- [ ] **Step 1: Write the failing test**

Create `tests/config.test.js`:
```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');

test('config exports Gemini and forwarding contacts', () => {
  assert.ok('GEMINI_API_KEY' in config, 'GEMINI_API_KEY should be defined');
  assert.equal(config.VA2_PHONE, process.env.VA2_PHONE || '8801307760509');
  assert.equal(config.VE3_PHONE, process.env.VE3_PHONE || '8801831366604');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/config.test.js`  
Expected: FAIL with missing properties.

- [ ] **Step 3: Update `src/config.js`**

Update `src/config.js`:
```javascript
const path = require('path');

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch {}
}

module.exports = {
  DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'ledger.db'),
  AUTH_DATA_PATH: process.env.AUTH_DATA_PATH || path.join(__dirname, '..', '.wwebjs_auth'),
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  VA2_PHONE: process.env.VA2_PHONE || '8801307760509',
  VE3_PHONE: process.env.VE3_PHONE || '8801831366604'
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/config.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.js tests/config.test.js
git commit -m "feat(config): add GEMINI_API_KEY and forwarding phone configs"
```

---

### Task 2: Core Classifier Module (`src/classifier.js`)

**Files:**
- Create: `src/classifier.js`
- Test: `tests/classifier.test.js`

**Interfaces:**
- Produces:
  - `buildHistoryTranscript(messages, myUser)`: returns clean string transcript
  - `classifyChat({ messages, myUser, apiKey, fetchFn, timeoutMs })`: returns Promise<{ classification, confidence, extracted_script, reason }>

- [ ] **Step 1: Write unit tests in `tests/classifier.test.js`**

Create `tests/classifier.test.js`:
```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHistoryTranscript, classifyChat } = require('../src/classifier');

test('buildHistoryTranscript formats roles properly', () => {
  const msgs = [
    { fromMe: false, body: 'Hello' },
    { fromMe: true, body: 'How can I help?' },
    { fromMe: false, body: 'I need a voice recording' }
  ];
  const transcript = buildHistoryTranscript(msgs);
  assert.match(transcript, /\[Customer\]: Hello/);
  assert.match(transcript, /\[Bot\]: How can I help\?/);
  assert.match(transcript, /\[Customer\]: I need a voice recording/);
});

test('classifyChat returns VOICE_JOB when API provides voice job classification', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              classification: 'VOICE_JOB',
              confidence: 'HIGH',
              extracted_script: 'This is the ad script for commercial.',
              reason: 'Customer submitted script with voice request'
            })
          }]
        }
      }]
    })
  });

  const res = await classifyChat({
    messages: [{ fromMe: false, body: 'Here is script: This is the ad script for commercial. Voice recording lagbe' }],
    apiKey: 'dummy-key',
    fetchFn: mockFetch
  });

  assert.equal(res.classification, 'VOICE_JOB');
  assert.equal(res.extracted_script, 'This is the ad script for commercial.');
});

test('classifyChat returns SCRIPT_PENDING_CONFIRMATION for raw script', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              classification: 'SCRIPT_PENDING_CONFIRMATION',
              confidence: 'HIGH',
              extracted_script: 'Raw script without voice keyword',
              reason: 'Raw script submitted without medium specification'
            })
          }]
        }
      }]
    })
  });

  const res = await classifyChat({
    messages: [{ fromMe: false, body: 'Raw script without voice keyword' }],
    apiKey: 'dummy-key',
    fetchFn: mockFetch
  });

  assert.equal(res.classification, 'SCRIPT_PENDING_CONFIRMATION');
});

test('classifyChat returns ESCALATE on API error or timeout', async () => {
  const mockFetch = async () => {
    throw new Error('Network timeout');
  };

  const res = await classifyChat({
    messages: [{ fromMe: false, body: 'Video banano jabe?' }],
    apiKey: 'dummy-key',
    fetchFn: mockFetch
  });

  assert.equal(res.classification, 'ESCALATE');
  assert.match(res.reason, /Network timeout|Error/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/classifier.test.js`  
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `src/classifier.js`**

Create `src/classifier.js`:
```javascript
const config = require('./config');

const SYSTEM_INSTRUCTION = `You are an expert message classifier for a WhatsApp audio/voice production service.
Analyze the provided conversation history between Customer and Bot.

Classify into exactly ONE of the following categories:
1. VOICE_JOB:
   - The Customer submits an ad script / voiceover text and explicitly requests voice or audio (e.g., "voice", "audio", "ভয়েস", "রেকর্ড", "voice lagbe").
   - OR, the Bot previously asked "শুধু ভয়েস?", and the Customer's latest message confirms affirmatively (e.g., "হ্যাঁ", "জি", "yes", "shudu voice", "hmm", "thik ache", "ok").
   Extract the clean script into extracted_script.

2. SCRIPT_PENDING_CONFIRMATION:
   - The Customer provides a commercial, narration, or ad script without specifying whether they need voiceover, video editing, or both, and the Bot has NOT yet asked "শুধু ভয়েস?".

3. ESCALATE:
   - Questions about pricing, video editing, graphics, revisions, complaints, or ambiguous/complex queries where intent is uncertain.

4. OTHER:
   - Casual greetings (hi, hello, salam), payment receipts, or unrelated chatter requiring no script dispatch.

Return strictly a JSON object:
{
  "classification": "VOICE_JOB" | "SCRIPT_PENDING_CONFIRMATION" | "ESCALATE" | "OTHER",
  "confidence": "HIGH" | "LOW",
  "extracted_script": "string",
  "reason": "string"
}`;

function buildHistoryTranscript(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  return messages
    .filter(m => m && (m.body || m.hasMedia))
    .map(m => {
      const sender = m.fromMe ? '[Bot]' : '[Customer]';
      const text = (m.body || (m.hasMedia ? '<Media attached>' : '')).trim();
      return `${sender}: ${text}`;
    })
    .join('\n');
}

async function classifyChat({
  messages,
  apiKey = config.GEMINI_API_KEY,
  fetchFn = globalThis.fetch,
  timeoutMs = 6000
}) {
  if (!apiKey) {
    console.warn('[CLASSIFIER] No GEMINI_API_KEY provided; falling back to ESCALATE');
    return {
      classification: 'ESCALATE',
      confidence: 'LOW',
      extracted_script: '',
      reason: 'Missing GEMINI_API_KEY'
    };
  }

  const transcript = buildHistoryTranscript(messages);
  if (!transcript) {
    return {
      classification: 'OTHER',
      confidence: 'HIGH',
      extracted_script: '',
      reason: 'Empty conversation transcript'
    };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const payload = {
    system_instruction: {
      parts: [{ text: SYSTEM_INSTRUCTION }]
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: `Here is the conversation history (oldest to newest):\n\n${transcript}` }]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const textPart = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textPart) {
      throw new Error('Empty response from Gemini API');
    }

    const parsed = JSON.parse(textPart);
    return {
      classification: parsed.classification || 'OTHER',
      confidence: parsed.confidence || 'LOW',
      extracted_script: parsed.extracted_script || '',
      reason: parsed.reason || ''
    };
  } catch (err) {
    console.warn('[CLASSIFIER] Error classifying chat:', err.message);
    return {
      classification: 'ESCALATE',
      confidence: 'LOW',
      extracted_script: '',
      reason: `Error: ${err.message}`
    };
  }
}

module.exports = {
  SYSTEM_INSTRUCTION,
  buildHistoryTranscript,
  classifyChat
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/classifier.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/classifier.js tests/classifier.test.js
git commit -m "feat(classifier): implement Gemini-powered chat classification"
```

---

### Task 3: Dispatch & Action Execution Module

**Files:**
- Create: `src/dispatch.js`
- Test: `tests/dispatch.test.js`

**Interfaces:**
- Produces:
  - `handleClassificationAction({ client, chat, classificationResult, customerPhone, customerName, latestMessageText })`

- [ ] **Step 1: Write tests in `tests/dispatch.test.js`**

Create `tests/dispatch.test.js`:
```javascript
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
  // Check customer received "ওকে"
  assert.ok(sentMessages.some(m => m.jid === 'customer' && m.text === 'ওকে'));
  // Check VA2 received script
  assert.ok(sentMessages.some(m => m.jid.includes('8801307760509') && m.text.includes('My voiceover script text')));
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
  assert.ok(sentMessages.some(m => m.jid.includes('8801831366604') && m.text.includes('8801700000000') && m.text.includes('Eitar dam koto?')));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/dispatch.test.js`  
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `src/dispatch.js`**

Create `src/dispatch.js`:
```javascript
const config = require('./config');

async function handleClassificationAction({
  client,
  chat,
  classificationResult,
  customerPhone,
  customerName = '',
  latestMessageText = ''
}) {
  const { classification, extracted_script, reason } = classificationResult || {};
  const namePart = customerName ? ` (${customerName})` : '';

  if (classification === 'VOICE_JOB') {
    // 1. Reply "ওকে" to customer
    if (chat && typeof chat.sendMessage === 'function') {
      try {
        await chat.sendMessage('ওকে');
      } catch (err) {
        console.warn('[DISPATCH] Error replying OK to customer:', err.message);
      }
    }

    // 2. Forward to VA2
    const va2Jid = `${config.VA2_PHONE}@c.us`;
    const scriptBody = extracted_script || latestMessageText;
    const forwardMsg = `[নতুন ভয়েস অর্ডার]\nগ্রাহক: +${customerPhone}${namePart}\n\nস্ক্রিপ্ট:\n${scriptBody}`;

    if (client && typeof client.sendMessage === 'function') {
      try {
        await client.sendMessage(va2Jid, forwardMsg);
        console.log(`[DISPATCH] Voice job forwarded to VA2 (+${config.VA2_PHONE}) for customer +${customerPhone}`);
      } catch (err) {
        console.error('[DISPATCH] Failed forwarding to VA2:', err.message);
      }
    }

    return { action: 'VOICE_JOB_DISPATCHED', details: { customerPhone, script: scriptBody } };
  }

  if (classification === 'SCRIPT_PENDING_CONFIRMATION') {
    if (chat && typeof chat.sendMessage === 'function') {
      try {
        await chat.sendMessage('শুধু ভয়েস? ');
        console.log(`[DISPATCH] Sent "শুধু ভয়েস? " to customer +${customerPhone}`);
      } catch (err) {
        console.warn('[DISPATCH] Error sending confirmation question:', err.message);
      }
    }
    return { action: 'SCRIPT_CONFIRMATION_ASKED', details: { customerPhone } };
  }

  if (classification === 'ESCALATE') {
    const ve3Jid = `${config.VE3_PHONE}@c.us`;
    const escalateMsg = `[সহায়তা প্রয়োজন / Customer Escalation]\nগ্রাহক: +${customerPhone}${namePart}\nমেসেজ: ${latestMessageText}\nকারণ: ${reason || 'Uncertain intent'}`;

    if (client && typeof client.sendMessage === 'function') {
      try {
        await client.sendMessage(ve3Jid, escalateMsg);
        console.log(`[DISPATCH] Escalation alert sent to VE3 (+${config.VE3_PHONE}) for customer +${customerPhone}`);
      } catch (err) {
        console.error('[DISPATCH] Failed sending escalation alert to VE3:', err.message);
      }
    }

    return { action: 'ESCALATED_TO_VE3', details: { customerPhone, reason } };
  }

  return { action: 'NO_ACTION_REQUIRED', details: { classification } };
}

module.exports = {
  handleClassificationAction
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/dispatch.test.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dispatch.js tests/dispatch.test.js
git commit -m "feat(dispatch): implement automated routing to customer, VA2, and VE3"
```

---

### Task 4: Integration into `src/bot.js`

**Files:**
- Modify: `src/bot.js`
- Test: `tests/bot-classifier.test.js`

**Interfaces:**
- Consumes: `classifyChat` from `src/classifier.js`, `handleClassificationAction` from `src/dispatch.js`

- [ ] **Step 1: Write integration tests in `tests/bot-classifier.test.js`**

Create `tests/bot-classifier.test.js`:
```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/bot-classifier.test.js`  
Expected: FAIL before updating `src/bot.js`.

- [ ] **Step 3: Update `src/bot.js`**

In `src/bot.js`:
- Import `classifyChat` and `handleClassificationAction`.
- In `handleMessageCreate`, when `!msg.fromMe && !isSelf`, after the lead recording / welcome demo check:
- If `welcomeResult?.status === 'DEMO_SENT'`, do not classify (let demo finish).
- Otherwise, fetch `chat.fetchMessages({ limit: 10 })`.
- Run classification.
- Execute `handleClassificationAction`.
- Return the action result.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/bot-classifier.test.js`  
Expected: PASS

- [ ] **Step 5: Run all test suites to ensure zero regressions**

Run: `npm test`  
Expected: All tests pass (including existing 128 tests).

- [ ] **Step 6: Commit**

```bash
git add src/bot.js tests/bot-classifier.test.js
git commit -m "feat(bot): hook LLM classification and dispatch pipeline into incoming customer messages"
```

---

### Task 5: Live Daemon Restart & Health Verification

**Files:**
- Background task management: Restart `node index.js` (task `task-3670`).

- [ ] **Step 1: Kill running task-3670**
- [ ] **Step 2: Restart bot daemon `node index.js` with `GEMINI_API_KEY` active**
- [ ] **Step 3: Check dashboard status & tunnel response via curl**
