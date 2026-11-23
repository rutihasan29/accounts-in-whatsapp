const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { getCohortPaybackAnalysis, getOperationalVelocity, BASELINE_CURVE } = require('../src/cohort');

test('getCohortPaybackAnalysis calculates break-even days and horizons correctly with default params', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ad_spend (
      spend_date TEXT PRIMARY KEY,
      amount REAL NOT NULL,
      note TEXT
    );
    CREATE TABLE leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT NOT NULL,
      status TEXT,
      first_contact_at TEXT,
      conversion_duration_seconds INTEGER
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      created_at TEXT
    );
  `);

  const result = getCohortPaybackAnalysis(db, { dailyAdSpend: 250, customCac: 150 });

  assert.equal(result.dailyAdSpend, 250);
  assert.equal(result.cac, 150);
  assert.equal(result.clientsAcquired, 1.67);

  // Latencies
  assert.equal(result.revenueBreakEvenDays, 4);
  assert.equal(result.profitBreakEvenDays, 8);
  assert.equal(result.doubleProfitDays, 17);

  // 1-Week (Day 7)
  assert.ok(result.week1);
  assert.equal(Math.round(result.week1.revenue), 405);
  assert.equal(Math.round(result.week1.grossProfit), 241);
  assert.ok(result.week1.roiPercent < 0); // Day 7 is right before gross break-even (-3.7%)

  // 1-Month (Day 30)
  assert.ok(result.month1);
  assert.equal(Math.round(result.month1.revenue), 1367);
  assert.equal(Math.round(result.month1.grossProfit), 817);
  assert.ok(result.month1.netProfit > 500);
  assert.ok(result.month1.roiPercent > 200); // Day 30 net ROI is > +200%

  // Customer LTV
  assert.equal(result.customerLtv.day0Gp, 41.7);
  assert.equal(result.customerLtv.day7Gp, 144.5);
  assert.equal(result.customerLtv.day30Gp, 490.0);
  assert.equal(result.customerLtv.day60Gp, 850.0);

  // Curve length
  assert.equal(result.dailyCurve.length, 31);
  assert.equal(result.dailyCurve[0].day, 0);
  assert.equal(result.dailyCurve[30].day, 30);
});

test('getOperationalVelocity calculates conversion latency and repeat order rates from DB', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT NOT NULL,
      status TEXT,
      first_contact_at TEXT,
      conversion_duration_seconds INTEGER
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      created_at TEXT
    );
  `);

  // Insert mock leads
  db.prepare(`
    INSERT INTO leads (phone_number, status, first_contact_at, conversion_duration_seconds)
    VALUES 
      ('88017001', 'CONVERTED', datetime('now', '-2 days'), 7200), -- 2.0 hours
      ('88017002', 'CONVERTED', datetime('now', '-2 days'), 10800), -- 3.0 hours
      ('88017003', 'FOLLOW_UP', datetime('now', '-1 days'), NULL),
      ('88017004', 'LOST', datetime('now', '-1 days'), NULL)
  `).run();

  // Insert mock transactions: 88017001 has 3 bills, 88017002 has 1 bill
  db.prepare(`
    INSERT INTO transactions (phone_number, type, amount, created_at)
    VALUES
      ('88017001', 'BILL', 150, datetime('now')),
      ('88017001', 'BILL', 200, datetime('now')),
      ('88017001', 'BILL', 300, datetime('now')),
      ('88017002', 'BILL', 150, datetime('now'))
  `).run();

  const ops = getOperationalVelocity(db);

  // Avg conversion latency: (7200 + 10800) / 2 = 9000 seconds = 2.5 hours
  assert.equal(ops.timeToFirstJobHours, 2.5);

  // Conversion rate: 2 converted / 4 leads = 50%
  assert.equal(ops.conversionRatePercent, 50.0);

  // Repeat rate: 1 repeat customer (88017001) out of 2 total billing customers = 50%
  assert.equal(ops.repeatOrderRatePercent, 50.0);

  // Speed to lead
  assert.equal(ops.speedToLeadMinutes, 1.8);
});
