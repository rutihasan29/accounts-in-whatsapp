const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { auditChatStream, getGroundTruthAnalytics } = require('../src/metrics-engine');

test('auditChatStream detects delivered media, bills, and unbilled leakage across dates', () => {
  const sampleChats = [
    {
      phone: '88017001',
      messages: [
        { fromMe: false, body: 'News script 1', isoTime: '2026-11-05T10:00:00Z' },
        { fromMe: true, body: 'Received script', isoTime: '2026-11-05T10:01:30Z' }, // 1.5 min reply
        { fromMe: true, hasMedia: true, type: 'audio', duration: 55, isoTime: '2026-11-05T11:00:00Z' }, // 1 hr turnaround
        { fromMe: true, body: 'বিল ৫০ টাকা', isoTime: '2026-11-05T11:01:00Z' },
        // Second job
        { fromMe: false, body: 'News script 2', isoTime: '2026-11-06T10:00:00Z' },
        { fromMe: true, hasMedia: true, type: 'audio', duration: 75, isoTime: '2026-11-06T10:30:00Z' },
        // Staff forgot bill -> Unbilled leakage 75 BDT
      ]
    },
    {
      phone: '88017002',
      messages: [
        { fromMe: false, body: 'Video editing inquiry', isoTime: '2026-11-10T12:00:00Z' },
        { fromMe: true, hasMedia: true, type: 'video', filename: 'report.mp4', isoTime: '2026-11-10T14:30:00Z' },
        { fromMe: true, body: 'বিল ২৫০ টাকা', isoTime: '2026-11-10T14:35:00Z' }
      ]
    }
  ];

  // Audit all dates
  const fullAudit = auditChatStream(sampleChats);
  assert.equal(fullAudit.totalMediaDelivered, 3);
  assert.equal(fullAudit.voiceDelivered, 2);
  assert.equal(fullAudit.videoDelivered, 1);
  assert.equal(fullAudit.billedRevenue, 300); // 50 + 250
  assert.equal(fullAudit.unbilledLeakage, 75); // 75 BDT audio unbilled
  assert.equal(fullAudit.convertedClients, 2);
  assert.equal(fullAudit.clientsWithMultipleJobs, 1); // 88017001 has 2 jobs

  // Audit specific date range (Nov 5 only)
  const nov5Audit = auditChatStream(sampleChats, { startDate: '2026-11-05', endDate: '2026-11-05' });
  assert.equal(nov5Audit.totalMediaDelivered, 1);
  assert.equal(nov5Audit.billedRevenue, 50);
  assert.equal(nov5Audit.unbilledLeakage, 0);

  // Audit Nov 10 only (Video)
  const nov10Audit = auditChatStream(sampleChats, { startDate: '2026-11-10', endDate: '2026-11-10' });
  assert.equal(nov10Audit.totalMediaDelivered, 1);
  assert.equal(nov10Audit.videoDelivered, 1);
  assert.equal(nov10Audit.billedRevenue, 250);
});

test('getGroundTruthAnalytics returns complete KPIs and break-even metrics', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ad_spend (
      spend_date TEXT PRIMARY KEY,
      amount REAL NOT NULL
    );
  `);

  db.prepare("INSERT INTO ad_spend (spend_date, amount) VALUES ('2026-11-05', 250)").run();
  db.prepare("INSERT INTO ad_spend (spend_date, amount) VALUES ('2026-11-06', 250)").run();

  const analytics = getGroundTruthAnalytics(db, { startDate: '2026-11-01', endDate: '2026-11-18' });

  assert.ok(analytics.meta);
  assert.ok(analytics.breakEvenLatencies);
  assert.equal(typeof analytics.breakEvenLatencies.revenueBreakEvenDays, 'number');
  assert.equal(typeof analytics.breakEvenLatencies.profitBreakEvenDays, 'number');
  assert.equal(typeof analytics.breakEvenLatencies.doubleProfitDays, 'number');

  assert.ok(analytics.horizons.week1);
  assert.ok(analytics.horizons.month1);
  assert.equal(analytics.customerLtv.day0Gp, 41.7);
  assert.equal(analytics.customerLtv.day30Gp, 490.0);

  assert.ok(analytics.productionAudit);
  assert.ok(analytics.operationalVelocity);

  db.close();
});
