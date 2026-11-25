const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { getMetricsAnalytics, getAdSpendInfo } = require('../src/metrics-roi');

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ad_spend (
      spend_date TEXT PRIMARY KEY,
      amount REAL NOT NULL
    );

    CREATE TABLE metrics_chat_clients (
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

    CREATE TABLE metrics_chat_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT NOT NULL,
      job_type TEXT NOT NULL CHECK(job_type IN ('voice', 'video')),
      delivered_at DATETIME NOT NULL,
      media_type TEXT NOT NULL,
      duration_seconds REAL DEFAULT 0,
      expected_amount_bdt REAL NOT NULL,
      billed_amount_bdt REAL DEFAULT 0,
      unbilled_leakage_bdt REAL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('CONFIRMED_BILLED', 'UNBILLED_LEAKAGE', 'TYPO_FLAGGED')),
      raw_media_msg_id TEXT,
      bill_text TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE metrics_chat_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_time DATETIME NOT NULL,
      latency_seconds REAL DEFAULT 0,
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed test ad spend
  db.prepare("INSERT INTO ad_spend (spend_date, amount) VALUES ('2026-11-01', 250)").run();
  db.prepare("INSERT INTO ad_spend (spend_date, amount) VALUES ('2026-11-02', 250)").run();
  db.prepare("INSERT INTO ad_spend (spend_date, amount) VALUES ('2026-11-03', 250)").run();

  // Seed test events
  db.prepare("INSERT INTO metrics_chat_events (phone_number, event_type, event_time, latency_seconds) VALUES ('88017001', 'FIRST_INQUIRY', '2026-11-01T10:00:00Z', 0)").run();
  db.prepare("INSERT INTO metrics_chat_events (phone_number, event_type, event_time, latency_seconds) VALUES ('88017001', 'FIRST_REPLY', '2026-11-01T10:02:00Z', 120)").run();
  db.prepare("INSERT INTO metrics_chat_events (phone_number, event_type, event_time, latency_seconds) VALUES ('88017001', 'FIRST_JOB_DELIVERED', '2026-11-01T12:00:00Z', 7200)").run();

  db.prepare("INSERT INTO metrics_chat_events (phone_number, event_type, event_time, latency_seconds) VALUES ('88017002', 'FIRST_INQUIRY', '2026-11-02T11:00:00Z', 0)").run();
  db.prepare("INSERT INTO metrics_chat_events (phone_number, event_type, event_time, latency_seconds) VALUES ('88017002', 'FIRST_REPLY', '2026-11-02T11:01:00Z', 60)").run();

  // Seed test jobs
  // Client 1 - Voice Job Nov 1: 50 BDT billed
  db.prepare(`
    INSERT INTO metrics_chat_jobs (phone_number, job_type, delivered_at, media_type, duration_seconds, expected_amount_bdt, billed_amount_bdt, unbilled_leakage_bdt, status, bill_text)
    VALUES ('88017001', 'voice', '2026-11-01T12:00:00Z', 'audio', 45, 50, 50, 0, 'CONFIRMED_BILLED', 'বিল ৫০ টাকা')
  `).run();

  // Client 1 - Repeat Voice Job Nov 2: unbilled leakage 50 BDT
  db.prepare(`
    INSERT INTO metrics_chat_jobs (phone_number, job_type, delivered_at, media_type, duration_seconds, expected_amount_bdt, billed_amount_bdt, unbilled_leakage_bdt, status, bill_text)
    VALUES ('88017001', 'voice', '2026-11-02T14:00:00Z', 'audio', 50, 50, 0, 50, 'UNBILLED_LEAKAGE', NULL)
  `).run();

  // Client 2 - Video Job Nov 3: 250 BDT billed
  db.prepare(`
    INSERT INTO metrics_chat_jobs (phone_number, job_type, delivered_at, media_type, duration_seconds, expected_amount_bdt, billed_amount_bdt, unbilled_leakage_bdt, status, bill_text)
    VALUES ('88017002', 'video', '2026-11-03T16:00:00Z', 'video', 120, 250, 250, 0, 'CONFIRMED_BILLED', 'বিল ২৫০ টাকা')
  `).run();

  return db;
}

test('getMetricsAnalytics calculates KPIs and respects date filters', () => {
  const db = createTestDb();

  // 1. All dates
  const allResult = getMetricsAnalytics(db);
  assert.equal(allResult.productionAudit.totalMediaDelivered, 3);
  assert.equal(allResult.productionAudit.voiceDelivered, 2);
  assert.equal(allResult.productionAudit.videoDelivered, 1);
  assert.equal(allResult.productionAudit.verifiedBilledRevenue, 300); // 50 + 250
  assert.equal(allResult.productionAudit.unbilledLeakage, 50);
  assert.equal(allResult.clientsSummary.activeClients, 2);
  assert.equal(allResult.clientsSummary.repeatClients, 1); // 88017001 has 2 jobs

  // Operational velocity
  assert.equal(allResult.operationalVelocity.speedToLeadMinutes, 1.5); // (120+60)/2 = 90s = 1.5m
  assert.equal(allResult.operationalVelocity.timeToFirstJobHours, 2.0); // 7200s / 3600 = 2h

  // 2. Filter: 2026-11-01 only
  const nov1Result = getMetricsAnalytics(db, { startDate: '2026-11-01', endDate: '2026-11-01' });
  assert.equal(nov1Result.productionAudit.totalMediaDelivered, 1);
  assert.equal(nov1Result.productionAudit.verifiedBilledRevenue, 50);
  assert.equal(nov1Result.productionAudit.unbilledLeakage, 0);

  // 3. Filter: 2026-11-03 only (Video)
  const nov3Result = getMetricsAnalytics(db, { startDate: '2026-11-03', endDate: '2026-11-03' });
  assert.equal(nov3Result.productionAudit.totalMediaDelivered, 1);
  assert.equal(nov3Result.productionAudit.videoDelivered, 1);
  assert.equal(nov3Result.productionAudit.verifiedBilledRevenue, 250);

  // 4. Custom daily spend override
  const customResult = getMetricsAnalytics(db, { customDailySpend: 500 });
  assert.equal(customResult.adSpend.dailyRate, 500);

  // 5. Recent jobs array
  assert.equal(Array.isArray(allResult.recentJobs), true);
  assert.equal(allResult.recentJobs.length, 3);

  db.close();
});
