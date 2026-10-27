const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { initDb } = require('../src/db');
const { handleMessageCreate } = require('../src/bot');
const { DEFAULT_WELCOME_MESSAGES, sendWelcomeDemo } = require('../src/welcome');

describe('Welcome Demo Module', () => {
  it('DEFAULT_WELCOME_MESSAGES defines exact 7-part sequence', () => {
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES.length, 7);
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[0].type, 'text');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[1].type, 'audio');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[1].filename, 'voice1.wav');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[2].type, 'audio');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[2].filename, 'voice2.wav');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[3].type, 'text');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[4].type, 'text');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[5].type, 'text');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[6].type, 'text');
  });

  it('sendWelcomeDemo sends messages in exact order with voice options', async () => {
    const db = initDb(':memory:');
    const sent = [];

    const mockClient = {
      sendMessage: async (chat, content, options) => {
        sent.push({ chat, content, options });
        return { id: { _serialized: `msg_${sent.length}` } };
      }
    };

    // Pre-insert a pending lead
    db.prepare('INSERT INTO leads (phone_number, name) VALUES (?, ?)').run('8801700000001', 'Lead One');

    const res = await sendWelcomeDemo({
      client: mockClient,
      targetChat: '8801700000001@c.us',
      db,
      phone: '8801700000001',
      delayMs: 0
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(sent.length, 7);

    // 1. Text 1
    assert.strictEqual(sent[0].chat, '8801700000001@c.us');
    assert.strictEqual(sent[0].content, 'ডেমোগুলো শুনে দেখুন');

    // 2. Voice 1 as playable audio (not ptt, not document)
    assert.strictEqual(sent[1].options?.sendAudioAsVoice, false);
    assert.strictEqual(sent[1].options?.sendMediaAsDocument, false);
    assert.ok(sent[1].content?.filename?.includes('voice1') || sent[1].content?.mimetype?.includes('audio'));

    // 3. Voice 2 as playable audio (not ptt, not document)
    assert.strictEqual(sent[2].options?.sendAudioAsVoice, false);
    assert.strictEqual(sent[2].options?.sendMediaAsDocument, false);
    assert.ok(sent[2].content?.filename?.includes('voice2') || sent[2].content?.mimetype?.includes('audio'));

    // 4-7. Informational text sequence
    assert.ok(sent[3].content.includes('বাংলাদেশ'));
    assert.ok(sent[4].content.includes('স্ক্রিপ্ট'));
    assert.ok(sent[5].content.includes('অগ্রিম'));
    assert.ok(sent[6].content.includes('স্যাম্পল'));

    // Verify welcome_sent updated to 1 in DB
    const lead = db.prepare('SELECT welcome_sent FROM leads WHERE phone_number = ?').get('8801700000001');
    assert.strictEqual(lead.welcome_sent, 1);

    // Calling again skips sending because welcome_sent is 1
    const res2 = await sendWelcomeDemo({
      client: mockClient,
      targetChat: '8801700000001@c.us',
      db,
      phone: '8801700000001',
      delayMs: 0
    });
    assert.strictEqual(res2.success, false);
    assert.strictEqual(res2.reason, 'ALREADY_SENT');
    assert.strictEqual(sent.length, 7); // No extra messages sent
  });

  it('sendWelcomeDemo sends audio with sendAudioAsVoice: false and sendMediaAsDocument: false', async () => {
    const db = initDb(':memory:');
    const sent = [];

    const mockClient = {
      sendMessage: async (chat, content, options) => {
        sent.push({ chat, content, options });
        return { id: { _serialized: `msg_${sent.length}` } };
      }
    };

    const res = await sendWelcomeDemo({
      client: mockClient,
      targetChat: '8801700000002@c.us',
      messages: [
        { type: 'audio', filename: 'voice1.wav', filePath: path.join(__dirname, '..', 'voice1.wav') }
      ],
      delayMs: 0
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].options?.sendAudioAsVoice, false);
    assert.strictEqual(sent[0].options?.sendMediaAsDocument, false);
  });

  it('handleMessageCreate automatically sends welcome demo on first message from a new contact', async () => {
    const db = initDb(':memory:');
    const sent = [];

    const client = {
      info: { wid: { _serialized: '8801999999999@c.us' } },
      getContactById: async () => ({ name: 'New Inbound Lead', pushname: 'Inbound' }),
      sendMessage: async (chat, content, options) => {
        sent.push({ chat, content, options });
        return { id: { _serialized: `msg_${sent.length}` } };
      }
    };

    const firstMsg = {
      fromMe: false,
      from: '8801788888888@c.us',
      to: '8801999999999@c.us',
      body: 'হ্যালো ভাইয়া, ভয়েস দেওয়ার রেট কত?',
      id: { remote: '8801788888888@c.us' }
    };

    const res1 = await handleMessageCreate({ msg: firstMsg, client, db });
    assert.strictEqual(res1.action, 'RECORDED_NEW_LEAD');
    assert.strictEqual(res1.details.welcomeResult?.success, true);

    // Full sequence was sent to the lead
    assert.strictEqual(sent.length, 7);
    assert.strictEqual(sent[0].chat, '8801788888888@c.us');
    assert.strictEqual(sent[0].content, 'ডেমোগুলো শুনে দেখুন');

    // Second message from the same lead: must NOT send welcome demo again
    const secondMsg = {
      fromMe: false,
      from: '8801788888888@c.us',
      to: '8801999999999@c.us',
      body: 'ডেমো দেখলাম, অনেক ভালো লাগলো!',
      id: { remote: '8801788888888@c.us' }
    };

    const res2 = await handleMessageCreate({ msg: secondMsg, client, db });
    assert.strictEqual(res2.action, 'IGNORED_NOT_FROM_ME');
    assert.strictEqual(sent.length, 7); // Count unchanged
  });
});
