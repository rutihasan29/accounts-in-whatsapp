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
    assert.ok(res.body.includes('MUNNI SOFT'));
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

  it('GET /unknown-route returns 404', async () => {
    const res = await makeRequest(`${baseUrl}/not-found-xyz`);
    assert.strictEqual(res.statusCode, 404);
  });
});
