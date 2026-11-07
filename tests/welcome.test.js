const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { initDb } = require('../src/db');
const { handleMessageCreate } = require('../src/bot');
const { DEFAULT_WELCOME_MESSAGES, sendWelcomeDemo } = require('../src/welcome');

describe('Welcome Demo Module', () => {
  it('DEFAULT_WELCOME_MESSAGES defines exact 15-part sequence', () => {
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES.length, 15);
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[0].type, 'text');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[1].type, 'audio');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[1].filename, 'voice3.mp3');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[2].type, 'audio');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[2].filename, 'voice4.mp3');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[3].type, 'audio');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[3].filename, 'voice1.mp3');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[4].type, 'text');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[5].type, 'text');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[6].type, 'text');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[7].type, 'text');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[8].type, 'text');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[8].text, 'আমাদের কাজের আরো কিছু নমুনা নিচে দেয়া হলো:');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[9].type, 'link');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[9].url, 'https://www.youtube.com/watch?v=7w0kthHSFUM');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[10].type, 'link');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[10].url, 'https://www.youtube.com/watch?v=oRlSHM6JpkE');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[11].type, 'link');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[11].url, 'https://www.youtube.com/watch?v=DuKiMWPmg68');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[12].type, 'link');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[12].url, 'https://www.youtube.com/watch?v=BknLpjzRevE');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[13].type, 'link');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[13].url, 'https://www.youtube.com/watch?v=C9hVUi_ol6g');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[14].type, 'link');
    assert.strictEqual(DEFAULT_WELCOME_MESSAGES[14].url, 'https://www.youtube.com/watch?v=8wv9pYJT10A');
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
    assert.strictEqual(sent.length, 15);

    // 1. Text 1
    assert.strictEqual(sent[0].chat, '8801700000001@c.us');
    assert.strictEqual(sent[0].content, 'ডেমোগুলো শুনে দেখুন');

    // 2. Voice 3 as playable audio (not ptt, not document)
    assert.strictEqual(sent[1].options?.sendAudioAsVoice, false);
    assert.strictEqual(sent[1].options?.sendMediaAsDocument, false);
    assert.ok(sent[1].content?.filename?.includes('voice3') || sent[1].content?.mimetype?.includes('audio'));

    // 3. Voice 4 as playable audio (not ptt, not document)
    assert.strictEqual(sent[2].options?.sendAudioAsVoice, false);
    assert.strictEqual(sent[2].options?.sendMediaAsDocument, false);
    assert.ok(sent[2].content?.filename?.includes('voice4') || sent[2].content?.mimetype?.includes('audio'));

    // 4. Voice 1 as playable audio (not ptt, not document)
    assert.strictEqual(sent[3].options?.sendAudioAsVoice, false);
    assert.strictEqual(sent[3].options?.sendMediaAsDocument, false);
    assert.ok(sent[3].content?.filename?.includes('voice1') || sent[3].content?.mimetype?.includes('audio'));

    // 5-8. Informational text sequence
    assert.ok(sent[4].content.includes('বাংলাদেশ'));
    assert.ok(sent[5].content.includes('স্ক্রিপ্ট'));
    assert.ok(sent[6].content.includes('অগ্রিম'));
    assert.ok(sent[7].content.includes('স্যাম্পল'));

    // 9. Work samples header text
    assert.strictEqual(sent[8].content, 'আমাদের কাজের আরো কিছু নমুনা নিচে দেয়া হলো:');

    // 10-15. YouTube link previews
    for (let k = 9; k <= 14; k++) {
      assert.strictEqual(sent[k].options?.linkPreview, true);
      assert.ok(sent[k].content.includes('youtube.com'));
    }

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
    assert.strictEqual(sent.length, 15); // No extra messages sent
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
    assert.strictEqual(sent.length, 15);
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
    assert.strictEqual(sent.length, 15); // Count unchanged
  });

  it('outgoing demo audio messages (e.g. voice1.wav / voice2.mp3) are NEVER billed to customers', async () => {
    const db = initDb(':memory:');
    const sent = [];
    const client = {
      info: { wid: { _serialized: '8801999999999@c.us' } },
      sendMessage: async (chat, content, options) => {
        sent.push({ chat, content, options });
        return { id: { _serialized: `msg_${sent.length}` } };
      }
    };

    // Case 1: Audio with voice1.wav filename
    const demoMsg1 = {
      fromMe: true,
      from: '8801999999999@c.us',
      to: '8801799999999@c.us',
      id: { remote: '8801799999999@c.us', id: 'demo_msg_01', _serialized: 'true_8801799999999@c.us_demo_msg_01' },
      type: 'audio',
      filename: 'voice1.wav',
      hasMedia: true,
      duration: 92
    };

    const res1 = await handleMessageCreate({ msg: demoMsg1, client, db });
    assert.strictEqual(res1.action, 'IGNORED_DEMO_AUDIO');
    assert.strictEqual(sent.length, 0, 'No bill message should be sent for demo audio 1');

    // Case 2: Audio with voice2.mp3 filename
    const demoMsg2 = {
      fromMe: true,
      from: '8801999999999@c.us',
      to: '8801799999999@c.us',
      id: { remote: '8801799999999@c.us', id: 'demo_msg_02', _serialized: 'true_8801799999999@c.us_demo_msg_02' },
      type: 'audio',
      filename: 'voice2.mp3',
      hasMedia: true,
      duration: 80
    };

    const res2 = await handleMessageCreate({ msg: demoMsg2, client, db });
    assert.strictEqual(res2.action, 'IGNORED_DEMO_AUDIO');
    assert.strictEqual(sent.length, 0, 'No bill message should be sent for demo audio 2');

    // Case 3: Playable audio sent to a fresh lead without order
    db.prepare("INSERT INTO leads (phone_number, name, welcome_sent, first_contact_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP)").run('8801799999999', 'Fresh Lead');
    const demoMsg3 = {
      fromMe: true,
      from: '8801999999999@c.us',
      to: '8801799999999@c.us',
      id: { remote: '8801799999999@c.us', id: 'demo_msg_03', _serialized: 'true_8801799999999@c.us_demo_msg_03' },
      type: 'audio',
      hasMedia: true,
      duration: 85
    };

    const res3 = await handleMessageCreate({ msg: demoMsg3, client, db });
    assert.strictEqual(res3.action, 'IGNORED_DEMO_AUDIO');
    assert.strictEqual(sent.length, 0, 'No bill message should be sent to lead without order');

    // Verify 0 transactions were recorded in DB
    const txs = db.prepare('SELECT * FROM transactions WHERE phone_number = ?').all('8801799999999');
    assert.strictEqual(txs.length, 0, 'No transactions should be recorded for demo audios');

    db.close();
  });
});
