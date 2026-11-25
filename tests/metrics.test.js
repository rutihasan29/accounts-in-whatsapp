const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { getPeriodMetrics, getBusinessKpiReport, getProfitMargin } = require('../src/metrics');
const { formatChatForAudit, auditChatsDeterministic } = require('../src/auditor');

test('formatChatForAudit formats media deliveries with durations and expected rates', () => {
  const sampleChat = {
    phone: '8801700000000',
    name: 'Test News Agency',
    messages: [
      { fromMe: false, body: 'আজকের শিরোনাম: উপজেলা নির্বাচন স্থগিত ঘোষণা।', isoTime: '2026-11-20T10:00:00Z' },
      { fromMe: true, hasMedia: true, type: 'audio', duration: 75, isoTime: '2026-11-20T10:30:00Z' },
      { fromMe: true, body: 'বিল ৭৫ টাকা', isoTime: '2026-11-20T10:31:00Z' }
    ]
  };

  const formatted = formatChatForAudit(sampleChat);
  assert.match(formatted, /DELIVERED_AUDIO duration_seconds="75"/);
  assert.match(formatted, /expected_rate="75 BDT"/);
  assert.match(formatted, /BILL_RECORDED text="বিল ৭৫ টাকা"/);
});

test('auditChatsDeterministic treats delivered media as truth and catches unbilled leakage', () => {
  const chats = [
    {
      phone: '8801711111111',
      messages: [
        { fromMe: false, body: 'নিউজ স্ক্রিপ্ট: জেলা প্রতিনিধি সম্মেলন' },
        // Delivered 65s audio, but staff FORGOT to send bill message
        { fromMe: true, hasMedia: true, type: 'audio', duration: 65 }
      ]
    },
    {
      phone: '8801722222222',
      messages: [
        { fromMe: false, body: 'নিউজ স্ক্রিপ্ট: মাদক উদ্ধার' },
        // Delivered audio AND staff sent bill
        { fromMe: true, hasMedia: true, type: 'audio', duration: 50 },
        { fromMe: true, body: 'বিল ৫০ টাকা' }
      ]
    }
  ];

  const { results } = auditChatsDeterministic(chats);
  assert.equal(results.length, 2);

  // Client 1: Unbilled leakage caught!
  assert.equal(results[0].jobs_delivered, 1);
  assert.equal(results[0].jobs[0].status, 'UNBILLED_LEAKAGE');
  assert.equal(results[0].unbilled_leakage_amount, 50);

  // Client 2: Confirmed billed
  assert.equal(results[1].jobs_delivered, 1);
  assert.equal(results[1].jobs[0].status, 'CONFIRMED_BILLED');
  assert.equal(results[1].unbilled_leakage_amount, 0);
  assert.equal(results[1].total_billed, 50);
});

test('getBusinessKpiReport aggregates revenue, ad spend, and unit economics', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ad_spend (
      spend_date TEXT PRIMARY KEY,
      amount REAL NOT NULL,
      note TEXT
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      raw_text TEXT,
      job_type TEXT DEFAULT 'voice',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE leads (
      phone_number TEXT PRIMARY KEY,
      status TEXT,
      first_contact_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      first_job_delivered_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Insert mock ad spend
  db.prepare("INSERT INTO ad_spend (spend_date, amount) VALUES (date('now', 'localtime'), 100)").run();

  // Insert mock transactions
  db.prepare("INSERT INTO transactions (phone_number, type, amount, job_type, created_at) VALUES ('8801', 'BILL', 500, 'voice', CURRENT_TIMESTAMP)").run();
  db.prepare("INSERT INTO transactions (phone_number, type, amount, job_type, created_at) VALUES ('8801', 'PAYMENT', 500, 'voice', CURRENT_TIMESTAMP)").run();

  // Insert mock lead
  db.prepare("INSERT INTO leads (phone_number, status, first_contact_at, first_job_delivered_at, created_at) VALUES ('8801', 'CONVERTED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run();

  const report = getBusinessKpiReport(db);

  assert.equal(report.daily.today.adSpend, 100);
  assert.equal(report.daily.today.billedRevenue, 500);
  assert.equal(report.daily.today.paidRevenue, 500);
  assert.equal(report.daily.today.grossProfit, 300); // 500 * 0.60
  assert.equal(report.daily.today.roas, 5.0); // 500 / 100
  assert.equal(report.daily.today.netRoiPercent, 200); // (300 - 100) / 100 * 100 = 200%

  // Custom range query
  const todayStr = new Date().toISOString().slice(0, 10);
  const customReport = getBusinessKpiReport(db, { startDate: todayStr, endDate: todayStr });
  assert.ok(customReport.custom);
  assert.equal(customReport.custom.current.billedRevenue, 500);
  assert.equal(customReport.custom.current.adSpend, 100);

  db.close();
});
