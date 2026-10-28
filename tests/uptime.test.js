const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const {
  initDb,
  recordBotState,
  heartbeatBotState,
  recoverUngracefulShutdown,
  getBotUptimeStats
} = require('../src/db');
const { startWebServer } = require('../src/server');

describe('Bot Online/Offline Uptime Tracker Module', () => {
  it('recordBotState opens an initial OFFLINE session on startup', () => {
    const db = initDb(':memory:');
    const row = recordBotState(db, 'OFFLINE', 'SERVER_STARTUP');

    assert.ok(row);
    assert.strictEqual(row.status, 'OFFLINE');
    assert.strictEqual(row.reason, 'SERVER_STARTUP');
    assert.strictEqual(row.ended_at, null);

    const stats = getBotUptimeStats(db);
    assert.strictEqual(stats.currentStatus, 'OFFLINE');
    assert.strictEqual(stats.recentLogs.length, 1);
  });

  it('recordBotState transitions from OFFLINE to ONLINE, closing previous session', () => {
    const db = initDb(':memory:');
    recordBotState(db, 'OFFLINE', 'SERVER_STARTUP');
    const onlineRow = recordBotState(db, 'ONLINE', 'READY');

    assert.ok(onlineRow);
    assert.strictEqual(onlineRow.status, 'ONLINE');
    assert.strictEqual(onlineRow.reason, 'READY');
    assert.strictEqual(onlineRow.ended_at, null);

    // Verify first session was closed
    const prevSession = db.prepare('SELECT * FROM bot_uptime_logs WHERE id = 1').get();
    assert.ok(prevSession.ended_at);
    assert.ok(prevSession.duration_seconds !== null);

    const stats = getBotUptimeStats(db);
    assert.strictEqual(stats.currentStatus, 'ONLINE');
    assert.strictEqual(stats.recentLogs.length, 2);
  });

  it('recordBotState with identical status updates heartbeat without creating duplicate records', () => {
    const db = initDb(':memory:');
    recordBotState(db, 'ONLINE', 'READY');
    recordBotState(db, 'ONLINE', 'READY'); // Duplicate call

    const count = db.prepare('SELECT COUNT(*) AS c FROM bot_uptime_logs').get().c;
    assert.strictEqual(count, 1, 'Should not insert duplicate rows for same status');
  });

  it('heartbeatBotState updates last_heartbeat_at on currently open session', () => {
    const db = initDb(':memory:');
    recordBotState(db, 'ONLINE', 'READY');
    heartbeatBotState(db);

    const current = db.prepare('SELECT * FROM bot_uptime_logs WHERE ended_at IS NULL').get();
    assert.ok(current.last_heartbeat_at);
  });

  it('recoverUngracefulShutdown closes unclosed ONLINE session and logs downtime', () => {
    const db = initDb(':memory:');
    // Simulate bot was ONLINE in a previous run and crashed without clean exit
    db.prepare(`
      INSERT INTO bot_uptime_logs (status, started_at, last_heartbeat_at, reason)
      VALUES ('ONLINE', datetime('now', '-2 hours'), datetime('now', '-1 hours'), 'READY')
    `).run();

    // Now server starts up
    recoverUngracefulShutdown(db);

    // 1. The old ONLINE session should now be closed with ended_at
    const oldOnline = db.prepare('SELECT * FROM bot_uptime_logs WHERE id = 1').get();
    assert.ok(oldOnline.ended_at, 'Crashed session must have ended_at populated');
    assert.ok(oldOnline.duration_seconds > 0, 'Duration must be computed');

    // 2. An OFFLINE downtime record should be inserted for the crash period
    const offlineGap = db.prepare('SELECT * FROM bot_uptime_logs WHERE reason = ?').get('CRASH_RECOVERED');
    assert.ok(offlineGap, 'Crash downtime gap session must be logged');
    assert.strictEqual(offlineGap.status, 'OFFLINE');
    assert.ok(offlineGap.duration_seconds > 0);
  });

  it('getBotUptimeStats computes stats and calculates recent session durations', () => {
    const db = initDb(':memory:');
    recordBotState(db, 'ONLINE', 'READY');

    const stats = getBotUptimeStats(db);
    assert.strictEqual(stats.currentStatus, 'ONLINE');
    assert.ok(stats.todayUptimePercent >= 0 && stats.todayUptimePercent <= 100);
    assert.ok(Array.isArray(stats.recentLogs));
    assert.strictEqual(stats.recentLogs[0].status, 'ONLINE');
    assert.ok(stats.recentLogs[0].duration_seconds !== null);
  });

  it('GET /api/bot-status returns 200 and bot uptime stats payload', async () => {
    const db = initDb(':memory:');
    recordBotState(db, 'ONLINE', 'READY');

    const server = startWebServer({ db, port: 0 });
    const port = server.address().port;

    try {
      const res = await new Promise((resolve, reject) => {
        http.get(`http://localhost:${port}/api/bot-status`, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve({ statusCode: res.statusCode, data: JSON.parse(data) }));
        }).on('error', reject);
      });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.data.currentStatus, 'ONLINE');
      assert.ok(res.data.recentLogs.length > 0);
    } finally {
      server.close();
    }
  });
});
