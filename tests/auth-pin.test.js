const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { startWebServer } = require('../src/server');

describe('Dashboard PIN Authentication API', () => {
  let server;
  let baseUrl;
  let db;

  test('setup test server', async () => {
    db = initDb(':memory:');
    server = startWebServer({ db, client: null, port: 0 });
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;
  });

  test('POST /api/auth/verify-pin rejects incorrect PIN', async () => {
    const res = await fetch(`${baseUrl}/api/auth/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '0000' })
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'Incorrect PIN');
  });

  test('POST /api/auth/verify-pin accepts correct PIN (6700)', async () => {
    const res = await fetch(`${baseUrl}/api/auth/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '6700' })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
  });

  test('teardown server', async () => {
    if (server) server.close();
  });
});
