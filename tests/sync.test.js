const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { initDb, recordExistingContact } = require('../src/db');
const { syncExistingInboxContacts } = require('../src/sync');
const { handleMessageCreate } = require('../src/bot');
const { startWebServer } = require('../src/server');

describe('Inbox & Contacts Sync Module', () => {
  it('recordExistingContact inserts new phone as EXISTING with welcome_sent = 1', () => {
    const db = initDb(':memory:');
    const res = recordExistingContact(db, {
      phone: '8801711111111',
      name: 'Old Friend',
      timestamp: '2026-01-01T10:00:00.000Z'
    });

    assert.strictEqual(res.status, 'RECORDED_EXISTING');
    assert.strictEqual(res.phone, '8801711111111');

    const row = db.prepare('SELECT * FROM leads WHERE phone_number = ?').get('8801711111111');
    assert.ok(row);
    assert.strictEqual(row.status, 'EXISTING');
    assert.strictEqual(row.welcome_sent, 1);
    assert.strictEqual(row.name, 'Old Friend');
  });

  it('recordExistingContact marks existing customer in customers table as CONVERTED with welcome_sent = 1', () => {
    const db = initDb(':memory:');
    db.prepare('INSERT INTO customers (phone_number, name) VALUES (?, ?)').run('8801722222222', 'Paying Client');

    const res = recordExistingContact(db, { phone: '8801722222222', name: 'Paying Client' });
    assert.strictEqual(res.status, 'EXISTING_CUSTOMER');

    const lead = db.prepare('SELECT * FROM leads WHERE phone_number = ?').get('8801722222222');
    assert.ok(lead);
    assert.strictEqual(lead.welcome_sent, 1);
    assert.strictEqual(lead.status, 'CONVERTED');
  });

  it('syncExistingInboxContacts filters groups/broadcasts/self and populates database', async () => {
    const db = initDb(':memory:');
    const mockClient = {
      info: { wid: { _serialized: '8801999999999@c.us' } },
      getChats: async () => [
        // 1. Valid individual chat
        {
          id: { _serialized: '8801733333333@c.us' },
          isGroup: false,
          isBroadcast: false,
          name: 'Chat Contact A',
          timestamp: 1700000000
        },
        // 2. Group chat (should be skipped)
        {
          id: { _serialized: '120363000000@g.us' },
          isGroup: true,
          name: 'Business Group'
        },
        // 3. Broadcast channel (should be skipped)
        {
          id: { _serialized: 'status@broadcast' },
          isBroadcast: true
        },
        // 4. Newsletter (should be skipped)
        {
          id: { _serialized: '12345@newsletter' }
        },
        // 5. Self chat (should be skipped)
        {
          id: { _serialized: '8801999999999@c.us' },
          isGroup: false
        }
      ],
      getContacts: async () => [
        // 1. Saved contact (not in chats above)
        {
          id: { _serialized: '8801744444444@c.us' },
          number: '8801744444444',
          isMyContact: true,
          isGroup: false,
          name: 'Saved Phone Contact B'
        },
        // 2. Unsaved contact (should be skipped in getContacts)
        {
          id: { _serialized: '8801755555555@c.us' },
          number: '8801755555555',
          isMyContact: false,
          isGroup: false
        }
      ]
    };

    const res = await syncExistingInboxContacts({
      client: mockClient,
      db,
      resolveCustomerPhone: async ({ recipient }) => recipient.replace('@c.us', '')
    });

    assert.strictEqual(res.syncedChats, 1);
    assert.strictEqual(res.syncedContacts, 1);
    assert.strictEqual(res.totalProtected, 2);

    // Verify chat contact is in db
    const leadA = db.prepare('SELECT * FROM leads WHERE phone_number = ?').get('8801733333333');
    assert.ok(leadA);
    assert.strictEqual(leadA.welcome_sent, 1);
    assert.strictEqual(leadA.name, 'Chat Contact A');

    // Verify saved address book contact is in db
    const leadB = db.prepare('SELECT * FROM leads WHERE phone_number = ?').get('8801744444444');
    assert.ok(leadB);
    assert.strictEqual(leadB.welcome_sent, 1);
    assert.strictEqual(leadB.name, 'Saved Phone Contact B');
  });

  it('handleMessageCreate skips welcome demo when contact has isMyContact === true', async () => {
    const db = initDb(':memory:');
    let welcomeSent = false;

    const client = {
      info: { wid: { _serialized: '8801999999999@c.us' } },
      getContactById: async () => ({
        name: 'My Best Friend',
        isMyContact: true
      }),
      sendMessage: async () => {
        welcomeSent = true;
      }
    };

    const msg = {
      fromMe: false,
      from: '8801766666666@c.us',
      to: '8801999999999@c.us',
      body: 'Hi, are you free tomorrow?',
      id: { remote: '8801766666666@c.us', _serialized: 'msg_101' }
    };

    const res = await handleMessageCreate({ msg, client, db });
    assert.strictEqual(res.action, 'IGNORED_EXISTING_CONTACT');
    assert.strictEqual(welcomeSent, false, 'Should NEVER send welcome demo to existing phonebook contact');

    // Database should have welcome_sent = 1 recorded
    const lead = db.prepare('SELECT * FROM leads WHERE phone_number = ?').get('8801766666666');
    assert.ok(lead);
    assert.strictEqual(lead.welcome_sent, 1);
  });

  it('handleMessageCreate skips welcome demo when chat has previous message history', async () => {
    const db = initDb(':memory:');
    let welcomeSent = false;

    const client = {
      info: { wid: { _serialized: '8801999999999@c.us' } },
      getContactById: async () => ({
        name: 'Past Client',
        isMyContact: false
      }),
      sendMessage: async () => {
        welcomeSent = true;
      }
    };

    const currentMsgId = 'msg_current_202';
    const msg = {
      fromMe: false,
      from: '8801777777777@c.us',
      to: '8801999999999@c.us',
      body: 'Hello again',
      id: { remote: '8801777777777@c.us', _serialized: currentMsgId },
      getChat: async () => ({
        fetchMessages: async () => [
          { id: { _serialized: 'msg_past_100' }, body: 'Past project discussion from 2 weeks ago' },
          { id: { _serialized: currentMsgId }, body: 'Hello again' }
        ]
      })
    };

    const res = await handleMessageCreate({ msg, client, db });
    assert.strictEqual(res.action, 'IGNORED_EXISTING_CHAT_HISTORY');
    assert.strictEqual(welcomeSent, false, 'Should NEVER send welcome demo when chat already has past history');

    const lead = db.prepare('SELECT * FROM leads WHERE phone_number = ?').get('8801777777777');
    assert.ok(lead);
    assert.strictEqual(lead.welcome_sent, 1);
  });

  it('GET and POST /api/sync-inbox HTTP endpoints function properly', async () => {
    const db = initDb(':memory:');
    const mockClient = {
      info: { wid: { _serialized: '8801999999999@c.us' } },
      getChats: async () => [
        { id: { _serialized: '8801788888888@c.us' }, isGroup: false, name: 'Endpoint Chat Test' }
      ],
      getContacts: async () => []
    };

    const server = startWebServer({ db, client: mockClient, port: 0 });
    const port = server.address().port;

    try {
      // 1. POST /api/sync-inbox
      const postRes = await new Promise((resolve, reject) => {
        const req = http.request(`http://localhost:${port}/api/sync-inbox`, { method: 'POST' }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve({ statusCode: res.statusCode, data: JSON.parse(data) }));
        });
        req.on('error', reject);
        req.end();
      });

      assert.strictEqual(postRes.statusCode, 200);
      assert.strictEqual(postRes.data.status, 'ok');
      assert.strictEqual(postRes.data.syncedChats, 1);

      // 2. GET /api/sync-inbox
      const getRes = await new Promise((resolve, reject) => {
        http.get(`http://localhost:${port}/api/sync-inbox`, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve({ statusCode: res.statusCode, data: JSON.parse(data) }));
        }).on('error', reject);
      });

      assert.strictEqual(getRes.statusCode, 200);
      assert.strictEqual(getRes.data.status, 'ok');
      assert.strictEqual(getRes.data.protectedContacts, 1);
    } finally {
      server.close();
    }
  });
});
