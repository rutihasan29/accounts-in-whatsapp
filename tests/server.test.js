const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { initDb } = require('../src/db');
const { startWebServer, botState } = require('../src/server');

describe('HTTP Web Server & Health Check Module', () => {
  let server;
  let testPort;
  let testDb;
  let tempDbFile;
  const testSecret = 'secret_test_123';

  before(async () => {
    tempDbFile = path.join(os.tmpdir(), `test_ledger_${Date.now()}.db`);
    testDb = initDb(tempDbFile);
    testPort = 38999;

    server = startWebServer({
      db: testDb,
      port: testPort,
      dbPath: tempDbFile,
      adminSecret: testSecret
    });

    // Wait a brief tick for server listening
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (testDb) {
      try { testDb.close(); } catch {}
    }
    try { fs.unlinkSync(tempDbFile); } catch {}
  });

  it('GET /healthz returns 200 OK with JSON status and uptime', async () => {
    const res = await fetch(`http://localhost:${testPort}/healthz`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/json');

    const json = await res.json();
    assert.strictEqual(json.status, 'ok');
    assert.strictEqual(typeof json.uptime, 'number');
    assert.strictEqual(typeof json.botStatus, 'string');
  });

  it('GET / returns HTML dashboard', async () => {
    const res = await fetch(`http://localhost:${testPort}/`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('text/html'));

    const html = await res.text();
    assert.ok(html.includes('WhatsApp Business Ledger Bot'));
    assert.ok(html.includes('Render Free Tier Hosting Tips'));
  });

  it('GET /qr returns HTML QR page', async () => {
    botState.qrDataUrl = 'data:image/png;base64,mockqrdata';
    const res = await fetch(`http://localhost:${testPort}/qr`);
    assert.strictEqual(res.status, 200);

    const html = await res.text();
    assert.ok(html.includes('Scan with WhatsApp'));
    assert.ok(html.includes('mockqrdata'));
    botState.qrDataUrl = null;
  });

  it('GET /api/backup enforces ADMIN_SECRET and rejects unauthorized requests', async () => {
    const res = await fetch(`http://localhost:${testPort}/api/backup`);
    assert.strictEqual(res.status, 401);

    const json = await res.json();
    assert.ok(json.error.includes('Unauthorized'));
  });

  it('GET /api/backup streams SQLite database when token is provided', async () => {
    const res = await fetch(`http://localhost:${testPort}/api/backup?token=${testSecret}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/x-sqlite3');
    assert.ok(res.headers.get('content-disposition').includes('ledger_backup.db'));

    const buf = await res.arrayBuffer();
    assert.ok(buf.byteLength > 0);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`http://localhost:${testPort}/unknown-route`);
    assert.strictEqual(res.status, 404);
  });
});
