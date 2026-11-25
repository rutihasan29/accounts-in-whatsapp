const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { startWebServer } = require('../src/server');

test('Server /metrics and /api/metrics endpoints work correctly', async (t) => {
  // Create in-memory db with all schemas
  const db = new Database(':memory:');
  const { initDb } = require('../src/db');
  
  // Create test schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      phone_number TEXT PRIMARY KEY,
      name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      raw_text TEXT NOT NULL,
      message_id TEXT,
      job_type TEXT DEFAULT NULL,
      duration_seconds INTEGER DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS leads (
      phone_number TEXT PRIMARY KEY,
      name TEXT,
      status TEXT DEFAULT 'PENDING',
      welcome_sent INTEGER DEFAULT 0,
      first_contact_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      first_job_delivered_at DATETIME,
      conversion_duration_seconds INTEGER,
      first_job_type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS ad_spend (
      spend_date TEXT PRIMARY KEY,
      amount REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bot_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      state TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS video_customers (
      phone_number TEXT PRIMARY KEY,
      name TEXT,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS voice_job_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_phone TEXT,
      customer_name TEXT,
      raw_text TEXT,
      va2_forward_msg_id TEXT,
      status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      delivered_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS bot_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS crm_callers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      pin TEXT NOT NULL,
      status TEXT DEFAULT 'OFFLINE',
      last_active_at DATETIME,
      current_call_id TEXT,
      shift_schedule_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS metrics_chat_clients (
      phone_number TEXT PRIMARY KEY,
      client_name TEXT,
      first_contact_at DATETIME NOT NULL,
      first_job_delivered_at DATETIME,
      total_jobs_delivered INTEGER DEFAULT 0,
      total_billed_bdt REAL DEFAULT 0,
      total_unbilled_bdt REAL DEFAULT 0,
      status TEXT DEFAULT 'PENDING',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS metrics_chat_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT NOT NULL,
      job_type TEXT NOT NULL CHECK(job_type IN ('voice', 'video')),
      delivered_at DATETIME NOT NULL,
      media_type TEXT NOT NULL,
      duration_seconds REAL DEFAULT 0,
      expected_amount_bdt REAL NOT NULL,
      billed_amount_bdt REAL DEFAULT 0,
      unbilled_leakage_bdt REAL DEFAULT 0,
      status TEXT NOT NULL,
      raw_media_msg_id TEXT,
      bill_text TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS metrics_chat_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_time DATETIME NOT NULL,
      latency_seconds REAL DEFAULT 0,
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Insert mock metrics job
  db.prepare(`
    INSERT INTO metrics_chat_jobs (phone_number, job_type, delivered_at, media_type, duration_seconds, expected_amount_bdt, billed_amount_bdt, unbilled_leakage_bdt, status, bill_text)
    VALUES ('88017009', 'voice', '2026-11-05T10:00:00Z', 'audio', 50, 50, 50, 0, 'CONFIRMED_BILLED', 'বিল ৫০ টাকা')
  `).run();

  const testPort = 3189;
  const server = startWebServer({ db, port: testPort });

  await new Promise(resolve => server.on('listening', resolve));

  try {
    // 1. GET /metrics (HTML)
    const htmlRes = await fetch(`http://localhost:${testPort}/metrics`);
    assert.equal(htmlRes.status, 200);
    const htmlText = await htmlRes.text();
    assert.ok(htmlText.includes('GROUND-TRUTH BUSINESS METRICS'));
    assert.ok(htmlText.includes('NEWS VOICE'));

    // 2. GET /metrics with Accept: application/json
    const jsonPageRes = await fetch(`http://localhost:${testPort}/metrics`, {
      headers: { 'Accept': 'application/json' }
    });
    assert.equal(jsonPageRes.status, 200);
    const pageJson = await jsonPageRes.json();
    assert.ok(pageJson.productionAudit);
    assert.equal(pageJson.productionAudit.totalMediaDelivered, 1);
    assert.equal(pageJson.productionAudit.verifiedBilledRevenue, 50);

    // 3. GET /api/metrics/analytics
    const apiRes = await fetch(`http://localhost:${testPort}/api/metrics/analytics?startDate=2026-11-01&endDate=2026-11-10`);
    assert.equal(apiRes.status, 200);
    const apiJson = await apiRes.json();
    assert.ok(apiJson.productionAudit);
    assert.equal(apiJson.productionAudit.verifiedBilledRevenue, 50);
    assert.equal(apiJson.recentJobs.length, 1);
    assert.equal(apiJson.recentJobs[0].phone_number, '88017009');

    // 4. GET /api/metrics/analytics outside date range
    const emptyRes = await fetch(`http://localhost:${testPort}/api/metrics/analytics?startDate=2026-11-20&endDate=2026-11-25`);
    assert.equal(emptyRes.status, 200);
    const emptyJson = await emptyRes.json();
    assert.equal(emptyJson.productionAudit.totalMediaDelivered, 0);

    // 5. POST /api/metrics/sync with payload
    const syncRes = await fetch(`http://localhost:${testPort}/api/metrics/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chats: [{
          phone: '8801999999999',
          name: 'Sync Test Client',
          messages: [{
            id: 'm1',
            fromMe: true,
            type: 'audio',
            t: 1794700000,
            isoTime: '2026-11-15T10:00:00.000Z',
            hasMedia: true
          }]
        }]
      })
    });
    assert.equal(syncRes.status, 200);
    const syncJson = await syncRes.json();
    assert.equal(syncJson.status, 'ok');
    assert.equal(syncJson.success, true);

    // 6. GET /api/metrics/export-chats
    const exportRes = await fetch(`http://localhost:${testPort}/api/metrics/export-chats`);
    assert.equal(exportRes.status, 200);
    const exportJson = await exportRes.json();
    assert.equal(exportJson.status, 'ok');
    assert.ok(Array.isArray(exportJson.jobs));
    assert.ok(Array.isArray(exportJson.clients));

    // 7. POST /api/metrics/sync-remote with direct payload
    const remoteSyncRes = await fetch(`http://localhost:${testPort}/api/metrics/sync-remote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          jobs: [{
            id: 99991,
            phone_number: '8801888888888',
            job_type: 'voice',
            delivered_at: '2026-11-25T12:00:00.000Z',
            media_type: 'audio',
            duration_seconds: 45,
            expected_amount_bdt: 50,
            billed_amount_bdt: 50,
            unbilled_leakage_bdt: 0,
            status: 'CONFIRMED_BILLED',
            raw_media_msg_id: 'test_remote_msg_1',
            bill_text: 'বিল ৫০ টাকা'
          }],
          clients: [{
            phone_number: '8801888888888',
            client_name: 'Remote Client',
            first_contact_at: '2026-11-25T10:00:00.000Z',
            first_job_delivered_at: '2026-11-25T12:00:00.000Z',
            total_jobs_delivered: 1,
            total_billed_bdt: 50,
            total_unbilled_bdt: 0,
            status: 'CONVERTED'
          }]
        }
      })
    });
    assert.equal(remoteSyncRes.status, 200);
    const remoteSyncJson = await remoteSyncRes.json();
    assert.equal(remoteSyncJson.status, 'ok');
    assert.equal(remoteSyncJson.success, true);
    assert.equal(remoteSyncJson.counts.jobs, 1);

  } finally {
    const livePath = path.join(__dirname, '..', 'data', 'latest_live_chats.json');
    if (fs.existsSync(livePath)) {
      try { fs.unlinkSync(livePath); } catch {}
    }
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});
