const { describe, it } = require('node:test');
const assert = require('node:assert');
const { initDb, recordLead, recordTransaction, saveWhatsappCustomerNote } = require('../src/db');
const {
  formatDisplayNumber,
  calculateCustomerColor,
  calculateWeeklyAvgOrders,
  computeHistogram,
  getSalesLeads
} = require('../src/sales');

describe('Sales Directory & WhatsApp Notes Module', () => {
  it('formatDisplayNumber formats Bangladeshi numbers to local 01XXXXXXXXX style', () => {
    assert.strictEqual(formatDisplayNumber('8801815530241'), '01815530241');
    assert.strictEqual(formatDisplayNumber('8801711111111'), '01711111111');
    assert.strictEqual(formatDisplayNumber('01711111111'), '01711111111');
    assert.strictEqual(formatDisplayNumber('1234567890'), '1234567890');
  });

  it('calculateCustomerColor returns correct color based on days billed and note status', () => {
    // 0 days billed, no note => RED
    assert.strictEqual(calculateCustomerColor({ daysBilled: 0, hasNote: false }), 'red');

    // 0 days billed, has note => BLACK
    assert.strictEqual(calculateCustomerColor({ daysBilled: 0, hasNote: true }), 'black');

    // 1 day billed (regardless of note) => YELLOW
    assert.strictEqual(calculateCustomerColor({ daysBilled: 1, hasNote: false }), 'yellow');
    assert.strictEqual(calculateCustomerColor({ daysBilled: 1, hasNote: true }), 'yellow');

    // 2+ days billed (regardless of note) => GREEN
    assert.strictEqual(calculateCustomerColor({ daysBilled: 2, hasNote: false }), 'green');
    assert.strictEqual(calculateCustomerColor({ daysBilled: 5, hasNote: true }), 'green');
  });

  it('calculateWeeklyAvgOrders computes average orders per week correctly', () => {
    const now = new Date('2026-11-03T18:00:00Z').getTime();

    // 0 orders => 0.0
    assert.strictEqual(calculateWeeklyAvgOrders({ totalOrders: 0, firstContactAt: '2026-11-01T00:00:00Z', now }), 0.0);

    // 2 orders within 3 days => weeks clamped to min 1 => 2.0
    assert.strictEqual(calculateWeeklyAvgOrders({ totalOrders: 2, firstContactAt: '2026-11-01T00:00:00Z', now }), 2.0);

    // 6 orders over 14 days (2 weeks) => 3.0
    const twoWeeksAgo = new Date(now - 14 * 86400 * 1000).toISOString();
    assert.strictEqual(calculateWeeklyAvgOrders({ totalOrders: 6, firstContactAt: twoWeeksAgo, now }), 3.0);
  });

  it('getSalesLeads filters out leads prior to startDate (Nov 1, 2026)', () => {
    const db = initDb(':memory:');

    // October lead (should be excluded)
    recordLead(db, {
      phone: '8801700000001',
      name: 'October Lead',
      firstContactAt: '2026-10-25T10:00:00Z'
    });

    // November leads (should be included)
    recordLead(db, {
      phone: '8801700000002',
      name: 'Nov 1 Lead',
      firstContactAt: '2026-11-01T09:00:00Z'
    });
    recordLead(db, {
      phone: '8801700000003',
      name: 'Nov 2 Lead',
      firstContactAt: '2026-11-02T14:00:00Z'
    });

    const res = getSalesLeads(db, { startDate: '2026-11-01' });

    assert.strictEqual(res.totalLeads, 2);
    const phones = res.dateGroups.flatMap(g => g.leads.map(l => l.phone));
    assert.ok(phones.includes('8801700000002'));
    assert.ok(phones.includes('8801700000003'));
    assert.ok(!phones.includes('8801700000001'), 'October lead must be excluded');

    db.close();
  });

  it('getSalesLeads attaches notes, computes colors, numbers sequentially, and groups by date', () => {
    const db = initDb(':memory:');

    // 1. Lead with no note, 0 bills => RED
    recordLead(db, { phone: '8801711111111', name: 'Lead Red', firstContactAt: '2026-11-03T10:00:00Z' });

    // 2. Lead with note, 0 bills => BLACK
    recordLead(db, { phone: '8801722222222', name: 'Lead Black', firstContactAt: '2026-11-03T11:00:00Z' });
    saveWhatsappCustomerNote(db, '8801722222222', 'kotha hoyeche, script dibe');

    // 3. Lead with 1 day bill => YELLOW
    recordLead(db, { phone: '8801733333333', name: 'Lead Yellow', firstContactAt: '2026-11-02T08:00:00Z' });
    recordTransaction(db, {
      phone: '8801733333333',
      type: 'BILL',
      amount: 75,
      rawText: 'বিল ৭৫ টাকা'
    });

    // 4. Lead with 2 distinct days bills => GREEN
    recordLead(db, { phone: '8801744444444', name: 'Lead Green', firstContactAt: '2026-11-01T08:00:00Z' });
    saveWhatsappCustomerNote(db, '8801744444444', 'regular customer, daily 1ta news');
    db.prepare('INSERT OR IGNORE INTO customers (phone_number, name) VALUES (?, ?)').run('8801744444444', 'Lead Green');
    // Bill 1 on Nov 1
    db.prepare(`
      INSERT INTO transactions (phone_number, type, amount, raw_text, created_at)
      VALUES (?, 'BILL', 100, 'বিল ১০০ টাকা', '2026-11-01 10:00:00')
    `).run('8801744444444');
    // Bill 2 on Nov 2
    db.prepare(`
      INSERT INTO transactions (phone_number, type, amount, raw_text, created_at)
      VALUES (?, 'BILL', 150, 'বিল ১৫০ টাকা', '2026-11-02 12:00:00')
    `).run('8801744444444');

    const res = getSalesLeads(db, { startDate: '2026-11-01' });

    assert.strictEqual(res.totalLeads, 4);
    assert.strictEqual(res.dateGroups.length, 3); // Nov 3, Nov 2, Nov 1

    // Flatten all leads
    const allLeads = res.dateGroups.flatMap(g => g.leads);

    // Sequential numbering verification (1, 2, 3, 4)
    assert.strictEqual(allLeads[0].index, 1);
    assert.strictEqual(allLeads[1].index, 2);
    assert.strictEqual(allLeads[2].index, 3);
    assert.strictEqual(allLeads[3].index, 4);

    const leadRed = allLeads.find(l => l.phone === '8801711111111');
    assert.strictEqual(leadRed.color, 'red');
    assert.strictEqual(leadRed.note, '');
    assert.strictEqual(leadRed.daysBilled, 0);

    const leadBlack = allLeads.find(l => l.phone === '8801722222222');
    assert.strictEqual(leadBlack.color, 'black');
    assert.strictEqual(leadBlack.note, 'kotha hoyeche, script dibe');
    assert.strictEqual(leadBlack.daysBilled, 0);

    const leadYellow = allLeads.find(l => l.phone === '8801733333333');
    assert.strictEqual(leadYellow.color, 'yellow');
    assert.strictEqual(leadYellow.daysBilled, 1);

    const leadGreen = allLeads.find(l => l.phone === '8801744444444');
    assert.strictEqual(leadGreen.color, 'green');
    assert.strictEqual(leadGreen.daysBilled, 2);
    assert.ok(leadGreen.weeklyAvgOrders > 0);

    db.close();
  });

  it('computeHistogram accurately tallies distribution buckets', () => {
    const sampleLeads = [
      { weeklyAvgOrders: 0.0 },
      { weeklyAvgOrders: 0.0 },
      { weeklyAvgOrders: 0.0 },
      { weeklyAvgOrders: 0.8 },
      { weeklyAvgOrders: 1.5 },
      { weeklyAvgOrders: 3.4 },
      { weeklyAvgOrders: 6.0 }
    ];

    const hist = computeHistogram(sampleLeads);
    assert.strictEqual(hist.length, 6);

    const zeroBucket = hist.find(b => b.range === '0.0');
    assert.strictEqual(zeroBucket.count, 3);

    const midBucket = hist.find(b => b.range === '0.1 - 1.0');
    assert.strictEqual(midBucket.count, 1);

    const highBucket = hist.find(b => b.range === '> 5.0');
    assert.strictEqual(highBucket.count, 1);
  });

  it('serves /sales HTML page and /api/sales/leads API endpoint', async () => {
    const { startWebServer } = require('../src/server');
    const db = initDb(':memory:');

    recordLead(db, {
      phone: '8801815530241',
      name: 'Omair',
      firstContactAt: '2026-11-02T10:00:00Z'
    });
    saveWhatsappCustomerNote(db, '8801815530241', 'Test note from WhatsApp');

    const server = startWebServer({ db, client: null, port: 0 });
    const port = server.address().port;
    const baseUrl = `http://localhost:${port}`;

    try {
      // 1. GET /sales HTML
      const htmlRes = await fetch(`${baseUrl}/sales`);
      assert.strictEqual(htmlRes.status, 200);
      const htmlText = await htmlRes.text();
      assert.ok(htmlText.includes('Sales Leads Directory'));
      assert.ok(htmlText.includes('leads-container'));
      assert.ok(htmlText.includes('toggle-hist-btn'));

      // 2. GET /api/sales/leads JSON
      const apiRes = await fetch(`${baseUrl}/api/sales/leads`);
      assert.strictEqual(apiRes.status, 200);
      const data = await apiRes.json();
      assert.strictEqual(data.totalLeads, 1);
      assert.strictEqual(data.dateGroups.length, 1);
      assert.strictEqual(data.dateGroups[0].leads[0].phone, '8801815530241');
      assert.strictEqual(data.dateGroups[0].leads[0].note, 'Test note from WhatsApp');
      assert.strictEqual(data.dateGroups[0].leads[0].color, 'black'); // Has note, 0 bills
      assert.strictEqual(data.dateGroups[0].leads[0].displayNumber, '01815530241');
      assert.ok(Array.isArray(data.histogram));
    } finally {
      server.close();
      db.close();
    }
  });
});
