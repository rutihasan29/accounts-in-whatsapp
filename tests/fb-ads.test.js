const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  fetchAdAccounts,
  fetchAdInsights,
  extractMessagingConversations,
  syncAdSpendToDb
} = require('../src/fb-ads');

test('extractMessagingConversations parses messaging and lead actions correctly', () => {
  const actionsWith7d = [
    { action_type: 'link_click', value: '45' },
    { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '18' },
    { action_type: 'page_engagement', value: '50' }
  ];
  assert.equal(extractMessagingConversations(actionsWith7d), 18);

  const actionsWithTotal = [
    { action_type: 'onsite_conversion.total_messaging_connection', value: '25' }
  ];
  assert.equal(extractMessagingConversations(actionsWithTotal), 25);

  const actionsWithLead = [
    { action_type: 'lead', value: '7' }
  ];
  assert.equal(extractMessagingConversations(actionsWithLead), 7);

  assert.equal(extractMessagingConversations([]), 0);
  assert.equal(extractMessagingConversations(null), 0);
});

test('fetchAdAccounts validates token and parses data', async () => {
  await assert.rejects(
    () => fetchAdAccounts(''),
    /FB_ACCESS_TOKEN is required/
  );

  const mockFetch = async (url) => {
    assert.match(url, /graph\.facebook\.com\/v21\.0\/me\/adaccounts/);
    return {
      json: async () => ({
        data: [{ id: 'act_123', name: 'Test Account', currency: 'USD' }]
      })
    };
  };

  const accounts = await fetchAdAccounts('valid_token', mockFetch);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, 'act_123');
});

test('fetchAdInsights builds query parameters and handles errors', async () => {
  await assert.rejects(
    () => fetchAdInsights({ token: '', adAccountId: 'act_123' }),
    /FB_ACCESS_TOKEN is required/
  );
  await assert.rejects(
    () => fetchAdInsights({ token: 'test', adAccountId: '' }),
    /FB_AD_ACCOUNT_ID is required/
  );

  const mockFetch = async (url) => {
    assert.match(url, /act_891050490213576\/insights/);
    assert.match(url, /date_preset=last_30d/);
    return {
      json: async () => ({
        data: [
          {
            spend: '10.50',
            impressions: '5000',
            clicks: '120',
            date_start: '2026-11-20',
            date_stop: '2026-11-20',
            actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '8' }]
          }
        ]
      })
    };
  };

  const insights = await fetchAdInsights({
    token: 'test_token',
    adAccountId: '891050490213576',
    datePreset: 'last_30d',
    fetchFn: mockFetch
  });

  assert.equal(insights.length, 1);
  assert.equal(insights[0].spend, '10.50');
});

test('syncAdSpendToDb upserts daily rows into SQLite and calculates metrics', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ad_spend (
      spend_date TEXT PRIMARY KEY,
      amount REAL NOT NULL,
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const mockFetch = async () => ({
    json: async () => ({
      data: [
        {
          spend: '5.00',
          impressions: '2000',
          clicks: '50',
          date_start: '2026-11-21',
          date_stop: '2026-11-21',
          actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '10' }]
        },
        {
          spend: '6.00',
          impressions: '2500',
          clicks: '60',
          date_start: '2026-11-22',
          date_stop: '2026-11-22',
          actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '15' }]
        }
      ]
    })
  });

  const result = await syncAdSpendToDb(db, {
    token: 'test_token',
    adAccountId: 'act_test',
    usdRate: 122.0,
    currency: 'USD',
    fetchFn: mockFetch
  });

  assert.equal(result.syncedDays, 2);
  assert.equal(result.totalSpendUSD, 11.00);
  assert.equal(result.totalSpendBDT, 1342.00); // 11 * 122
  assert.equal(result.totalConversations, 25);
  assert.equal(result.avgCplBDT, Math.round((1342 / 25) * 100) / 100);

  const rows = db.prepare('SELECT * FROM ad_spend ORDER BY spend_date ASC').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].spend_date, '2026-11-21');
  assert.equal(rows[0].amount, 610); // 5 * 122
  assert.match(rows[0].note, /Meta Ads: \$5\.00 USD/);
  assert.match(rows[0].note, /10 chats/);

  db.close();
});
