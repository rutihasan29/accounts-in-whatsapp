const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { initDb, recordTransaction } = require('../src/db');
const { startWebServer } = require('../src/server');

function makeRequest(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    }).on('error', reject);
  });
}

function makePostRequest(urlStr, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(bodyObj);
    const parsed = new URL(urlStr);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + (parsed.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function makeDeleteRequest(urlStr) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + (parsed.search || ''),
      method: 'DELETE'
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Web Server & Frontend Endpoints', () => {
  let db;
  let server;
  let baseUrl;

  before(async () => {
    db = initDb(':memory:');

    // Populate test data
    recordTransaction(db, {
      phone: '8801712345678',
      name: 'Rahim Traders',
      type: 'BILL',
      amount: 1500,
      rawText: 'বিল ১৫০০ টাকা'
    });

    recordTransaction(db, {
      phone: '8801712345678',
      type: 'PAYMENT',
      amount: 500,
      rawText: '৫০০ টাকা পেয়েছি'
    });

    recordTransaction(db, {
      phone: '8801811111111',
      name: 'Karim Textile',
      type: 'BILL',
      amount: 300,
      rawText: 'বিল ৩০০ টাকা'
    });

    // Start server on ephemeral port (0)
    server = startWebServer({ db, port: 0 });
    await new Promise((resolve) => server.on('listening', resolve));
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('GET /health returns 200 ok', async () => {
    const res = await makeRequest(`${baseUrl}/health`);
    assert.strictEqual(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.status, 'ok');
  });

  it('GET / returns HTML dashboard with official printed paper branding', async () => {
    const res = await makeRequest(`${baseUrl}/`);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.ok(res.body.includes('NEWS VOICE'));
    assert.ok(res.body.includes('about-modal'));
    assert.ok(res.body.includes('about-btn'));
    assert.ok(res.body.includes('copy-phone-btn'));
    assert.ok(res.body.includes('STATEMENT OF ACCOUNT'));
    assert.ok(res.body.includes('PRINT / PDF'));
  });

  it('GET /api/stats returns dashboard financial summary', async () => {
    const res = await makeRequest(`${baseUrl}/api/stats`);
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.totalDue, 1300); // 1000 + 300
    assert.strictEqual(data.debtorsCount, 2);
    assert.strictEqual(data.totalCustomers, 2);
    assert.strictEqual(data.todayBilled, 1800);
    assert.strictEqual(data.todayCollected, 500);
  });

  it('GET /api/customers returns customer ledger accounts list', async () => {
    const res = await makeRequest(`${baseUrl}/api/customers`);
    assert.strictEqual(res.statusCode, 200);
    const list = JSON.parse(res.body);
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].phone_number, '8801712345678');
    assert.strictEqual(list[0].name, 'Rahim Traders');
    assert.strictEqual(list[0].due_amount, 1000);
    assert.strictEqual(list[0].transaction_count, 2);
  });

  it('GET /api/customer/:phone returns customer statement and running balances', async () => {
    const res = await makeRequest(`${baseUrl}/api/customer/8801712345678`);
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.summary.name, 'Rahim Traders');
    assert.strictEqual(data.summary.due_amount, 1000);
    assert.strictEqual(data.transactions.length, 2);
    assert.strictEqual(data.transactions[0].type, 'BILL');
    assert.strictEqual(data.transactions[0].running_balance, 1500);
    assert.strictEqual(data.transactions[1].type, 'PAYMENT');
    assert.strictEqual(data.transactions[1].running_balance, 1000);
  });

  it('GET /statement/:phone returns printable official invoice voucher', async () => {
    const res = await makeRequest(`${baseUrl}/statement/8801712345678`);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.ok(res.body.includes('STATEMENT OF ACCOUNT'));
    assert.ok(res.body.includes('Rahim Traders'));
    assert.ok(res.body.includes('1,000'));
    assert.ok(res.body.includes('PRINT / SAVE AS PDF'));
  });

  it('POST /api/ad-spend records ad spend for single date and date range', async () => {
    // 1. Single date
    const res1 = await makePostRequest(`${baseUrl}/api/ad-spend`, {
      date: '2026-10-14',
      amount: 400,
      note: 'Facebook Campaign'
    });
    assert.strictEqual(res1.statusCode, 200);
    const body1 = JSON.parse(res1.body);
    assert.strictEqual(body1.status, 'ok');
    assert.strictEqual(body1.result.count, 1);
    assert.strictEqual(body1.result.totalAmount, 400);

    // 2. Date range
    const res2 = await makePostRequest(`${baseUrl}/api/ad-spend`, {
      startDate: '2026-10-15',
      endDate: '2026-10-17',
      dailyAmount: 300,
      note: 'Continuous 3-day test'
    });
    assert.strictEqual(res2.statusCode, 200);
    const body2 = JSON.parse(res2.body);
    assert.strictEqual(body2.status, 'ok');
    assert.strictEqual(body2.result.count, 3);
    assert.strictEqual(body2.result.totalAmount, 900);
  });

  it('GET /api/ad-spend returns summary and recent ad spend entries', async () => {
    const res = await makeRequest(`${baseUrl}/api/ad-spend`);
    assert.strictEqual(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.ok(json.summary);
    assert.strictEqual(json.summary.daysCount, 4);
    assert.strictEqual(json.summary.totalSpend, 1300); // 400 + 900
    assert.ok(Array.isArray(json.list));
    assert.strictEqual(json.list.length, 4);
  });

  it('GET /api/simulation/baselines returns unit economics baselines', async () => {
    const res = await makeRequest(`${baseUrl}/api/simulation/baselines`);
    assert.strictEqual(res.statusCode, 200);
    const baselines = JSON.parse(res.body);
    assert.ok(baselines.avgTicket > 0);
    assert.strictEqual(baselines.grossMarginRate, 0.6);
    assert.ok(baselines.avgGrossProfitPerJob > 0);
    assert.ok(baselines.totalJobs > 0);
    assert.strictEqual(baselines.totalAdSpend, 1300);
  });

  it('manages video customers via POST, GET, and DELETE /api/video-customers', async () => {
    // 1. POST add video customer
    const postRes = await makePostRequest(`${baseUrl}/api/video-customers`, {
      phone: '8801722334455',
      note: 'Weekly video packages'
    });
    assert.strictEqual(postRes.statusCode, 200);
    const postBody = JSON.parse(postRes.body);
    assert.strictEqual(postBody.status, 'ok');
    assert.strictEqual(postBody.record.phone_number, '8801722334455');
    assert.strictEqual(postBody.record.note, 'Weekly video packages');

    // 2. GET video customers list
    const getRes = await makeRequest(`${baseUrl}/api/video-customers`);
    assert.strictEqual(getRes.statusCode, 200);
    const list = JSON.parse(getRes.body);
    assert.ok(Array.isArray(list));
    const found = list.find(c => c.phone_number === '8801722334455');
    assert.ok(found);
    assert.strictEqual(found.note, 'Weekly video packages');

    // 3. DELETE video customer
    const delRes = await makeDeleteRequest(`${baseUrl}/api/video-customers/8801722334455`);
    assert.strictEqual(delRes.statusCode, 200);
    const delBody = JSON.parse(delRes.body);
    assert.strictEqual(delBody.status, 'ok');
    assert.strictEqual(delBody.deleted, true);

    // Verify removed
    const getRes2 = await makeRequest(`${baseUrl}/api/video-customers`);
    const list2 = JSON.parse(getRes2.body);
    assert.ok(!list2.some(c => c.phone_number === '8801722334455'));
  });

  it('GET /unknown-route returns 404', async () => {
    const res = await makeRequest(`${baseUrl}/not-found-xyz`);
    assert.strictEqual(res.statusCode, 404);
  });

  describe('Bot Settings Endpoints', () => {
    it('GET /api/bot-settings returns HTTP 200 with default settings', async () => {
      const res = await makeRequest(`${baseUrl}/api/bot-settings`);
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.headers['content-type'].includes('application/json'));
      const json = JSON.parse(res.body);
      assert.strictEqual(json.status, 'ok');
      assert.strictEqual(json.success, true);
      assert.ok(json.settings);
      assert.strictEqual(typeof json.settings, 'object');
      assert.strictEqual(json.settings.aircheck_enabled, true);
      assert.strictEqual(json.settings.ai_classifier_enabled, true);
      assert.strictEqual(json.settings.welcome_demo_enabled, true);
      assert.strictEqual(json.settings.auto_audio_billing_enabled, true);
      assert.strictEqual(json.settings.video_customer_escalation_enabled, true);
      assert.strictEqual(json.settings.ve3_escalation_enabled, true);
    });

    it('POST /api/bot-settings with { key, value } updates the setting and returns updated settings', async () => {
      const res = await makePostRequest(`${baseUrl}/api/bot-settings`, {
        key: 'welcome_demo_enabled',
        value: false
      });
      assert.strictEqual(res.statusCode, 200);
      const json = JSON.parse(res.body);
      assert.strictEqual(json.status, 'ok');
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.settings.welcome_demo_enabled, false);

      // Verify persistence via GET
      const getRes = await makeRequest(`${baseUrl}/api/bot-settings`);
      const getJson = JSON.parse(getRes.body);
      assert.strictEqual(getJson.settings.welcome_demo_enabled, false);
    });

    it('POST /api/bot-settings with { settings: { ... } } batch updates multiple settings', async () => {
      const res = await makePostRequest(`${baseUrl}/api/bot-settings`, {
        settings: {
          aircheck_enabled: false,
          auto_audio_billing_enabled: false
        }
      });
      assert.strictEqual(res.statusCode, 200);
      const json = JSON.parse(res.body);
      assert.strictEqual(json.status, 'ok');
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.settings.aircheck_enabled, false);
      assert.strictEqual(json.settings.auto_audio_billing_enabled, false);
      assert.strictEqual(json.settings.welcome_demo_enabled, false);
    });

    it('POST /api/bot-settings with invalid payload returns HTTP 400', async () => {
      const res1 = await makePostRequest(`${baseUrl}/api/bot-settings`, { foo: 'bar' });
      assert.strictEqual(res1.statusCode, 400);
      const json1 = JSON.parse(res1.body);
      assert.strictEqual(json1.status, 'error');
      assert.strictEqual(json1.error, 'key or settings is required');

      const res2 = await makePostRequest(`${baseUrl}/api/bot-settings`, {});
      assert.strictEqual(res2.statusCode, 400);
      const json2 = JSON.parse(res2.body);
      assert.strictEqual(json2.status, 'error');
      assert.strictEqual(json2.error, 'key or settings is required');
    });

    it('Main dashboard request GET / contains window.__INITIAL_DATA__ with botSettings key', async () => {
      const res = await makeRequest(`${baseUrl}/`);
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.body.includes('window.__INITIAL_DATA__ ='));
      assert.ok(res.body.includes('botSettings'));

      const prefix = 'window.__INITIAL_DATA__ = ';
      const idx = res.body.indexOf(prefix);
      assert.ok(idx !== -1, 'window.__INITIAL_DATA__ must be present in HTML');
      const lineEnd = res.body.indexOf(';\n', idx);
      const rawJson = res.body.slice(idx + prefix.length, lineEnd !== -1 ? lineEnd : undefined).replace(/;$/, '').trim();
      const initialData = JSON.parse(rawJson);
      assert.ok(initialData.botSettings, 'initialData must contain botSettings');
      assert.strictEqual(typeof initialData.botSettings, 'object');
      assert.strictEqual(initialData.botSettings.aircheck_enabled, false);
      assert.strictEqual(initialData.botSettings.auto_audio_billing_enabled, false);
    });
  });
});
