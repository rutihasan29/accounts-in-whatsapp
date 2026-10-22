const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const {
  initDb,
  recordTransaction,
  recordLead,
  getLead,
  updateTransactionMessageId,
  deleteTransactionByMessageId,
  getDueList,
  getCustomerSummary,
  getCustomerTransactions,
  getAllCustomersSummary,
  getDashboardStats,
  getBusinessPerformanceMetrics,
  PROFIT_MARGINS,
  migrateCustomerPhone,
  recordAdSpend,
  getAdSpendList,
  getAdSpendSummary,
  getSimulationBaselines,
  addVideoCustomer,
  removeVideoCustomer,
  getVideoCustomers,
  isVideoCustomer,
  createVoiceJobOrder,
  findVoiceJobOrderByVa2MsgId,
  findVoiceJobOrderByScriptText,
  findLatestPendingVoiceJob,
  updateVoiceJobVa2ForwardMsgId,
  updateVoiceJobDelivered,
  getVoiceJobOrder
} = require('../src/db');

describe('Database Module', () => {
  let db;

  beforeEach(() => {
    // In-memory database for isolated tests
    db = initDb(':memory:');
  });

  it('records bill and creates customer record with message_id', () => {
    const res = recordTransaction(db, {
      phone: '8801711111111',
      name: 'Customer A',
      type: 'BILL',
      amount: 400,
      rawText: 'বিল ৪০০ টাকা',
      messageId: 'true_8801711111111@c.us_MSG123'
    });

    assert.ok(res.transactionId > 0);
    assert.strictEqual(res.dueAmount, 400);

    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(res.transactionId);
    assert.strictEqual(tx.message_id, 'true_8801711111111@c.us_MSG123');
  });

  it('updates transaction message_id via updateTransactionMessageId', () => {
    const res = recordTransaction(db, {
      phone: '8801711111111',
      name: 'Customer A',
      type: 'BILL',
      amount: 150,
      rawText: 'বিল ১৫০ টাকা'
    });

    const updated = updateTransactionMessageId(db, res.transactionId, 'true_8801711111111@c.us_AUDIO_BILL_001');
    assert.strictEqual(updated, true);

    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(res.transactionId);
    assert.strictEqual(tx.message_id, 'true_8801711111111@c.us_AUDIO_BILL_001');

    assert.strictEqual(updateTransactionMessageId(db, null, 'some_id'), false);
    assert.strictEqual(updateTransactionMessageId(db, res.transactionId, null), false);
  });

  it('deletes transaction by message_id and recalculates customer due balance', () => {
    recordTransaction(db, {
      phone: '8801711111111',
      name: 'Customer A',
      type: 'BILL',
      amount: 500,
      rawText: 'বিল ৫০০ টাকা',
      messageId: 'MSG_BILL_500'
    });

    recordTransaction(db, {
      phone: '8801711111111',
      type: 'PAYMENT',
      amount: 100,
      rawText: '১০০ টাকা পেয়েছি, ধন্যবাদ',
      messageId: 'MSG_PAY_100'
    });

    assert.strictEqual(getCustomerSummary(db, '8801711111111').due_amount, 400);

    // Revoke the bill message
    const revokeRes = deleteTransactionByMessageId(db, ['MSG_BILL_500']);
    assert.ok(revokeRes);
    assert.strictEqual(revokeRes.deleted, true);
    assert.strictEqual(revokeRes.transaction.amount, 500);
    assert.strictEqual(revokeRes.dueAmount, -100); // 0 bill - 100 paid

    const summary = getCustomerSummary(db, '8801711111111');
    assert.strictEqual(summary.total_bill, 0);
    assert.strictEqual(summary.total_paid, 100);
    assert.strictEqual(summary.due_amount, -100);
  });

  it('matches bare stanza ID when stored with serialized ID and vice versa', () => {
    recordTransaction(db, {
      phone: '8801722222222',
      type: 'BILL',
      amount: 250,
      rawText: 'বিল ২৫০ টাকা',
      messageId: 'true_8801722222222@c.us_STANZA999'
    });

    // Delete passing only bare stanza ID
    const res1 = deleteTransactionByMessageId(db, 'STANZA999');
    assert.ok(res1);
    assert.strictEqual(res1.deleted, true);
    assert.strictEqual(res1.transaction.amount, 250);

    // Stored with bare ID, revoked with serialized
    recordTransaction(db, {
      phone: '8801722222222',
      type: 'BILL',
      amount: 300,
      rawText: 'বিল ৩০০ টাকা',
      messageId: 'BARE_ID_888'
    });

    const res2 = deleteTransactionByMessageId(db, ['true_8801722222222@c.us_BARE_ID_888']);
    assert.ok(res2);
    assert.strictEqual(res2.deleted, true);
    assert.strictEqual(res2.transaction.amount, 300);
  });

  it('deleteTransactionByMessageId returns null for non-matching or empty IDs', () => {
    assert.strictEqual(deleteTransactionByMessageId(db, null), null);
    assert.strictEqual(deleteTransactionByMessageId(db, []), null);
    assert.strictEqual(deleteTransactionByMessageId(db, ['NON_EXISTENT_ID']), null);
  });

  it('records bill and creates customer record', () => {
    const res = recordTransaction(db, {
      phone: '8801711111111',
      name: 'Customer A',
      type: 'BILL',
      amount: 400,
      rawText: 'বিল ৪০০ টাকা'
    });

    assert.ok(res.transactionId > 0);
    assert.strictEqual(res.dueAmount, 400);

    const summary = getCustomerSummary(db, '8801711111111');
    assert.strictEqual(summary.phone_number, '8801711111111');
    assert.strictEqual(summary.name, 'Customer A');
    assert.strictEqual(summary.total_bill, 400);
    assert.strictEqual(summary.total_paid, 0);
    assert.strictEqual(summary.due_amount, 400);
  });

  it('records payment and recalculates due correctly', () => {
    recordTransaction(db, {
      phone: '8801711111111',
      name: 'Customer A',
      type: 'BILL',
      amount: 400,
      rawText: 'বিল ৪০০ টাকা'
    });

    const res = recordTransaction(db, {
      phone: '8801711111111',
      type: 'PAYMENT',
      amount: 56,
      rawText: '৫৬ টাকা পেয়েছি, ধন্যবাদ'
    });

    assert.strictEqual(res.dueAmount, 344);

    const summary = getCustomerSummary(db, '8801711111111');
    assert.strictEqual(summary.total_bill, 400);
    assert.strictEqual(summary.total_paid, 56);
    assert.strictEqual(summary.due_amount, 344);
  });

  it('getDueList returns only customers with positive dues ordered descending', () => {
    // Customer 1: due 200
    recordTransaction(db, { phone: '880171', name: 'User 1', type: 'BILL', amount: 300, rawText: 'bill' });
    recordTransaction(db, { phone: '880171', type: 'PAYMENT', amount: 100, rawText: 'pay' });

    // Customer 2: due 500
    recordTransaction(db, { phone: '880172', name: 'User 2', type: 'BILL', amount: 500, rawText: 'bill' });

    // Customer 3: fully paid (due 0)
    recordTransaction(db, { phone: '880173', name: 'User 3', type: 'BILL', amount: 150, rawText: 'bill' });
    recordTransaction(db, { phone: '880173', type: 'PAYMENT', amount: 150, rawText: 'pay' });

    const dueList = getDueList(db);
    assert.strictEqual(dueList.length, 2);
    assert.strictEqual(dueList[0].phone_number, '880172');
    assert.strictEqual(dueList[0].due_amount, 500);
    assert.strictEqual(dueList[1].phone_number, '880171');
    assert.strictEqual(dueList[1].due_amount, 200);
  });

  it('initializes statement cache on db and reuses cached prepared statements', () => {
    assert.ok(db._stmtCache, 'db._stmtCache should exist');
    assert.ok(db._stmtCache.getCustomerSummary, 'getCustomerSummary statement should be cached');
    assert.ok(db._stmtCache.insertCustomer, 'insertCustomer statement should be cached');
    assert.ok(db._stmtCache.insertTransaction, 'insertTransaction statement should be cached');
    assert.ok(db._stmtCache.getDueList, 'getDueList statement should be cached');

    const origSummaryStmt = db._stmtCache.getCustomerSummary;
    const origDueListStmt = db._stmtCache.getDueList;

    // Execute operations
    recordTransaction(db, { phone: '880199', name: 'Cached User', type: 'BILL', amount: 250, rawText: 'bill' });
    getCustomerSummary(db, '880199');
    getDueList(db);

    // Verify cache references were maintained and reused
    assert.strictEqual(db._stmtCache.getCustomerSummary, origSummaryStmt);
    assert.strictEqual(db._stmtCache.getDueList, origDueListStmt);
  });

  it('migrateCustomerPhone migrates records from old LID to actual phone number', () => {
    const { migrateCustomerPhone } = require('../src/db');
    // First record under LID
    recordTransaction(db, {
      phone: '149181746389200@lid',
      name: 'Preenan',
      type: 'BILL',
      amount: 34,
      rawText: 'বিল ৩৪ টাকা'
    });

    assert.strictEqual(getCustomerSummary(db, '149181746389200@lid').due_amount, 34);

    // Migrate to actual phone
    migrateCustomerPhone(db, '149181746389200@lid', '8801712345678');

    // Verify LID is gone and actual phone holds the transaction
    assert.strictEqual(getCustomerSummary(db, '149181746389200@lid'), null);
    const updated = getCustomerSummary(db, '8801712345678');
    assert.ok(updated);
    assert.strictEqual(updated.name, 'Preenan');
    assert.strictEqual(updated.due_amount, 34);
    assert.strictEqual(updated.total_bill, 34);
  });

  it('getCustomerTransactions returns chronological ledger with computed running balance', () => {
    recordTransaction(db, {
      phone: '8801700000001',
      name: 'Ledger Test',
      type: 'BILL',
      amount: 1000,
      rawText: 'বিল ১০০০ টাকা'
    });

    recordTransaction(db, {
      phone: '8801700000001',
      type: 'BILL',
      amount: 500,
      rawText: 'বিল ৫০০ টাকা'
    });

    recordTransaction(db, {
      phone: '8801700000001',
      type: 'PAYMENT',
      amount: 300,
      rawText: '৩০০ টাকা পেয়েছি'
    });

    const txs = getCustomerTransactions(db, '8801700000001');
    assert.strictEqual(txs.length, 3);
    assert.strictEqual(txs[0].running_balance, 1000);
    assert.strictEqual(txs[1].running_balance, 1500);
    assert.strictEqual(txs[2].running_balance, 1200);
  });

  it('getAllCustomersSummary returns all customers with transaction count', () => {
    recordTransaction(db, { phone: '8801700000002', name: 'User 2', type: 'BILL', amount: 300, rawText: 'bill' });
    recordTransaction(db, { phone: '8801700000003', name: 'User 3', type: 'BILL', amount: 400, rawText: 'bill' });
    recordTransaction(db, { phone: '8801700000003', type: 'PAYMENT', amount: 400, rawText: 'pay' });

    const list = getAllCustomersSummary(db);
    assert.strictEqual(list.length, 2);
    const u2 = list.find(c => c.phone_number === '8801700000002');
    const u3 = list.find(c => c.phone_number === '8801700000003');
    assert.strictEqual(u2.due_amount, 300);
    assert.strictEqual(u2.transaction_count, 1);
    assert.strictEqual(u3.due_amount, 0);
    assert.strictEqual(u3.transaction_count, 2);
  });

  it('getDashboardStats calculates total due, debtor count, and daily stats', () => {
    recordTransaction(db, { phone: '8801700000004', name: 'Stats User', type: 'BILL', amount: 600, rawText: 'bill' });
    recordTransaction(db, { phone: '8801700000004', type: 'PAYMENT', amount: 200, rawText: 'pay' });

    const stats = getDashboardStats(db);
    assert.strictEqual(stats.totalDue, 400);
    assert.strictEqual(stats.debtorsCount, 1);
    assert.strictEqual(stats.totalCustomers, 1);
    assert.strictEqual(stats.todayBilled, 600);
    assert.strictEqual(stats.todayCollected, 200);
    assert.strictEqual(stats.todayTransactionsCount, 2);
    assert.ok(stats.performance);
    assert.strictEqual(stats.performance.daily.jobsCount, 1);
    assert.strictEqual(stats.performance.daily.grossProfit, 360); // 600 * 0.60
  });

  it('records transaction with jobType and durationSeconds and retrieves them in getCustomerTransactions', () => {
    const res = recordTransaction(db, {
      phone: '8801700000005',
      name: 'Voice Client',
      type: 'BILL',
      amount: 100,
      rawText: 'বিল ১০০ টাকা',
      jobType: 'voice',
      durationSeconds: 85
    });

    assert.ok(res.transactionId > 0);

    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(res.transactionId);
    assert.strictEqual(tx.job_type, 'voice');
    assert.strictEqual(tx.duration_seconds, 85);

    const txs = getCustomerTransactions(db, '8801700000005');
    assert.strictEqual(txs.length, 1);
    assert.strictEqual(txs[0].job_type, 'voice');
    assert.strictEqual(txs[0].duration_seconds, 85);
  });

  it('getBusinessPerformanceMetrics calculates daily, weekly, and monthly jobs and gross profit (60%) with growth rate', () => {
    // Today's jobs
    recordTransaction(db, {
      phone: '8801700000006',
      type: 'BILL',
      amount: 100,
      rawText: 'বিল ১০০ টাকা',
      jobType: 'voice',
      durationSeconds: 80
    });
    recordTransaction(db, {
      phone: '8801700000006',
      type: 'BILL',
      amount: 50,
      rawText: 'বিল ৫০ টাকা',
      jobType: 'voice',
      durationSeconds: 40
    });

    const metrics = getBusinessPerformanceMetrics(db);
    assert.strictEqual(metrics.daily.jobsCount, 2);
    // 150 * 0.60 = 90
    assert.strictEqual(metrics.daily.grossProfit, 90);
    assert.strictEqual(metrics.daily.previousJobsCount, 0);
    assert.strictEqual(metrics.daily.jobsGrowth, 100);

    assert.strictEqual(metrics.weekly.jobsCount, 2);
    assert.strictEqual(metrics.weekly.grossProfit, 90);

    assert.strictEqual(metrics.monthly.jobsCount, 2);
    assert.strictEqual(metrics.monthly.grossProfit, 90);
  });

  it('calculates differentiated gross profit: 60% for voice/audio and 34% for video', () => {
    assert.strictEqual(PROFIT_MARGINS.voice, 0.60);
    assert.strictEqual(PROFIT_MARGINS.audio, 0.60);
    assert.strictEqual(PROFIT_MARGINS.video, 0.34);

    const memDb = initDb(':memory:');
    // Voice job: 1000 * 0.60 = 600
    recordTransaction(memDb, {
      phone: '8801999999991',
      type: 'BILL',
      amount: 1000,
      rawText: 'বিল ১০০০ টাকা',
      jobType: 'voice'
    });
    // Video job: 1000 * 0.34 = 340
    recordTransaction(memDb, {
      phone: '8801999999992',
      type: 'BILL',
      amount: 1000,
      rawText: 'বিল ১০০০ টাকা',
      jobType: 'video'
    });

    const metrics = getBusinessPerformanceMetrics(memDb);
    assert.strictEqual(metrics.daily.jobsCount, 2);
    // 600 + 340 = 940
    assert.strictEqual(metrics.daily.grossProfit, 940);

    const baselines = getSimulationBaselines(memDb);
    // Total billed = 2000, Total GP = 940 => Blended margin = 940 / 2000 = 0.47
    assert.strictEqual(baselines.grossMarginRate, 0.47);
    assert.strictEqual(baselines.avgGrossProfitPerJob, 470);
    assert.strictEqual(baselines.profitMargins.voice, 0.60);
    assert.strictEqual(baselines.profitMargins.video, 0.34);
  });

  it('records new lead and ignores if contact is already customer or existing lead', () => {
    // 1. Record a brand new lead
    const res1 = recordLead(db, { phone: '8801811111111', name: 'New Reporter' });
    assert.strictEqual(res1.status, 'NEW_LEAD');

    const lead = getLead(db, '8801811111111');
    assert.ok(lead);
    assert.strictEqual(lead.status, 'PENDING');
    assert.strictEqual(lead.name, 'New Reporter');
    assert.ok(lead.first_contact_at);
    assert.strictEqual(lead.first_job_delivered_at, null);

    // 2. Duplicate lead message should return EXISTING_LEAD and not overwrite first_contact_at
    const res2 = recordLead(db, { phone: '8801811111111', name: 'New Reporter Updated' });
    assert.strictEqual(res2.status, 'EXISTING_LEAD');
    const lead2 = getLead(db, '8801811111111');
    assert.strictEqual(lead2.first_contact_at, lead.first_contact_at);

    // 3. If contact is already an established customer, recordLead returns EXISTING_CUSTOMER
    recordTransaction(db, { phone: '8801822222222', name: 'Cust 2', type: 'BILL', amount: 100, rawText: 'bill' });
    const res3 = recordLead(db, { phone: '8801822222222' });
    assert.strictEqual(res3.status, 'EXISTING_CUSTOMER');
  });

  it('converts pending lead to customer on first BILL transaction and sets conversion timestamps', () => {
    // First, lead contacts us
    recordLead(db, { phone: '8801833333333', name: 'Potential Client' });
    const leadBefore = getLead(db, '8801833333333');
    assert.strictEqual(leadBefore.status, 'PENDING');

    // First job delivered and billed
    recordTransaction(db, {
      phone: '8801833333333',
      name: 'Potential Client',
      type: 'BILL',
      amount: 100,
      rawText: 'বিল ১০০ টাকা',
      jobType: 'voice',
      durationSeconds: 90
    });

    const leadAfter = getLead(db, '8801833333333');
    assert.strictEqual(leadAfter.status, 'CONVERTED');
    assert.ok(leadAfter.first_job_delivered_at);
    assert.strictEqual(leadAfter.first_job_type, 'voice');
    assert.ok(leadAfter.conversion_duration_seconds >= 0);

    // Customer summary now has conversion details
    const summary = getCustomerSummary(db, '8801833333333');
    assert.strictEqual(summary.first_job_type, 'voice');
    assert.ok(summary.first_contact_at);
    assert.ok(summary.first_job_delivered_at);

    // Performance metrics conversion section reflects this conversion
    const metrics = getBusinessPerformanceMetrics(db);
    assert.ok(metrics.daily.conversion);
    assert.strictEqual(metrics.daily.conversion.leadsCount, 1);
    assert.strictEqual(metrics.daily.conversion.convertedCount, 1);
    assert.strictEqual(metrics.daily.conversion.conversionRate, 100);
  });

  describe('Ad Spend Tracking & Growth Simulation Baselines', () => {
    it('records ad spend for a single date and allows updating it', () => {
      const res = recordAdSpend(db, { date: '2026-10-10', amount: 350, note: 'Facebook test' });
      assert.strictEqual(res.count, 1);
      assert.strictEqual(res.totalAmount, 350);

      const list = getAdSpendList(db);
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].spend_date, '2026-10-10');
      assert.strictEqual(list[0].amount, 350);
      assert.strictEqual(list[0].note, 'Facebook test');

      // Update existing date
      const resUpdate = recordAdSpend(db, { date: '2026-10-10', amount: 450, note: 'Facebook revised' });
      assert.strictEqual(resUpdate.count, 1);
      const listUpdated = getAdSpendList(db);
      assert.strictEqual(listUpdated.length, 1);
      assert.strictEqual(listUpdated[0].amount, 450);
      assert.strictEqual(listUpdated[0].note, 'Facebook revised');
    });

    it('records ad spend across a continuous date range', () => {
      // 4 continuous days: Oct 12 to Oct 15 at 200 BDT/day
      const res = recordAdSpend(db, {
        startDate: '2026-10-12',
        endDate: '2026-10-15',
        dailyAmount: 200,
        note: 'Google campaign'
      });
      assert.strictEqual(res.count, 4);
      assert.strictEqual(res.totalAmount, 800);

      const summary = getAdSpendSummary(db);
      assert.strictEqual(summary.totalSpend, 800);
      assert.strictEqual(summary.daysCount, 4);
    });

    it('calculates daily CPL per date based on leads received that day', () => {
      // Record spend for 2026-10-12
      recordAdSpend(db, { date: '2026-10-12', amount: 200, note: 'Daily test' });

      // Add 2 leads on that date
      db.prepare(`
        INSERT INTO leads (phone_number, name, status, first_contact_at)
        VALUES ('8801999990001', 'Lead 1', 'PENDING', '2026-10-12 10:00:00'),
               ('8801999990002', 'Lead 2', 'PENDING', '2026-10-12 14:30:00')
      `).run();

      const list = getAdSpendList(db);
      const oct12 = list.find((e) => e.spend_date === '2026-10-12');
      assert.ok(oct12);
      assert.strictEqual(oct12.leads_count, 2);
      assert.strictEqual(oct12.daily_cpl, 100); // 200 / 2 = 100
    });

    it('calculates comprehensive simulation baselines from historical data', () => {
      recordAdSpend(db, { date: '2026-10-10', amount: 500 });
      recordTransaction(db, {
        phone: '8801700000001',
        name: 'Client A',
        type: 'BILL',
        amount: 300,
        rawText: 'বিল ৩০০ টাকা',
        jobType: 'voice'
      });

      const baselines = getSimulationBaselines(db);
      assert.ok(baselines);
      assert.strictEqual(baselines.avgTicket, 300);
      assert.strictEqual(baselines.grossMarginRate, 0.6);
      assert.strictEqual(baselines.avgGrossProfitPerJob, 180);
      assert.strictEqual(baselines.totalJobs, 1);
      assert.strictEqual(baselines.uniquePayingCustomers, 1);
      assert.strictEqual(baselines.repeatJobFrequency, 1);
      assert.strictEqual(baselines.totalAdSpend, 500);
      assert.ok(baselines.dailyCplHistory.length > 0);
    });
  });

  describe('Video Customers', () => {
    it('adds, retrieves, and removes a video customer', () => {
      const added = addVideoCustomer(db, '+8801711223344', 'Regular News Video');
      assert.ok(added);
      assert.strictEqual(added.phone_number, '8801711223344');
      assert.strictEqual(added.note, 'Regular News Video');

      const list = getVideoCustomers(db);
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].phone_number, '8801711223344');
      assert.strictEqual(list[0].note, 'Regular News Video');

      assert.strictEqual(isVideoCustomer(db, '8801711223344'), true);
      assert.strictEqual(isVideoCustomer(db, '01711223344'), true);
      assert.strictEqual(isVideoCustomer(db, '+8801711223344'), true);

      const del = removeVideoCustomer(db, '8801711223344');
      assert.strictEqual(del.deleted, true);
      assert.strictEqual(isVideoCustomer(db, '8801711223344'), false);
    });

    it('identifies pure video customer based on transaction history', () => {
      // Customer has video transactions only
      recordTransaction(db, {
        phone: '8801799887766',
        name: 'Video Only Client',
        type: 'BILL',
        amount: 800,
        rawText: 'বিল ৮০০ টাকা',
        jobType: 'video'
      });

      assert.strictEqual(isVideoCustomer(db, '8801799887766'), true);
      assert.strictEqual(isVideoCustomer(db, '01799887766'), true);

      // Now add a voice transaction for this customer -> no longer pure video customer!
      recordTransaction(db, {
        phone: '8801799887766',
        type: 'BILL',
        amount: 150,
        rawText: 'বিল ১৫০ টাকা',
        jobType: 'voice'
      });

      assert.strictEqual(isVideoCustomer(db, '8801799887766'), false);
    });

    it('returns false for unknown customer or audio-only customer', () => {
      assert.strictEqual(isVideoCustomer(db, '8801700000999'), false);
      assert.strictEqual(isVideoCustomer(db, ''), false);
      assert.strictEqual(isVideoCustomer(null, '8801700000999'), false);

      recordTransaction(db, {
        phone: '8801700000999',
        type: 'BILL',
        amount: 100,
        rawText: 'বিল ১০০ টাকা',
        jobType: 'voice'
      });
      assert.strictEqual(isVideoCustomer(db, '8801700000999'), false);
    });
  });

  describe('Voice Job Orders', () => {
    it('creates a voice job order and verifies order_id, status PENDING_VA2, and phone normalization', () => {
      const order = createVoiceJobOrder(db, {
        customerPhone: '+880 1711-223344',
        customerName: 'Munni Voice Client',
        customerScriptMsgId: 'msg_cust_01',
        va2ForwardMsgId: 'msg_va2_fwd_01',
        scriptText: 'আজকের প্রধান খবর: পদ্মা সেতুর কাজ সফলভাবে সম্পন্ন হয়েছে।',
        headline: 'পদ্মা সেতু সংবাদ'
      });

      assert.ok(order, 'Order should be created');
      assert.ok(order.id > 0, 'Order should have autoincrement id');
      assert.match(order.order_id, /^VJO-\d+-\d{4}$/, 'Order ID should match VJO pattern');
      assert.strictEqual(order.customer_phone, '8801711223344', 'Phone number should be stripped of non-digits');
      assert.strictEqual(order.customer_name, 'Munni Voice Client');
      assert.strictEqual(order.customer_script_msg_id, 'msg_cust_01');
      assert.strictEqual(order.va2_forward_msg_id, 'msg_va2_fwd_01');
      assert.strictEqual(order.script_text, 'আজকের প্রধান খবর: পদ্মা সেতুর কাজ সফলভাবে সম্পন্ন হয়েছে।');
      assert.strictEqual(order.headline, 'পদ্মা সেতু সংবাদ');
      assert.strictEqual(order.status, 'PENDING_VA2');
      assert.strictEqual(order.va2_audio_msg_id, null);
      assert.strictEqual(order.va2_audio_filename, null);
      assert.strictEqual(order.final_audio_filename, null);
      assert.strictEqual(order.clean_duration_seconds, null);
      assert.strictEqual(order.cuts_applied_count, 0);
      assert.ok(order.created_at, 'created_at should be populated');
      assert.strictEqual(order.delivered_at, null);
    });

    it('finds order by va2_forward_msg_id (direct match and serialized stanza format)', () => {
      const order = createVoiceJobOrder(db, {
        customerPhone: '01811223344',
        scriptText: 'স্পোর্টস বুলেটিন: বাংলাদেশ জয়ী',
        va2ForwardMsgId: 'VA2_MSG_12345'
      });

      // Direct exact match
      const found = findVoiceJobOrderByVa2MsgId(db, 'VA2_MSG_12345');
      assert.ok(found);
      assert.strictEqual(found.order_id, order.order_id);

      // Stanza serialized search
      const foundByStanza = findVoiceJobOrderByVa2MsgId(db, 'true_8801999999999@c.us_VA2_MSG_12345');
      assert.ok(foundByStanza);
      assert.strictEqual(foundByStanza.order_id, order.order_id);

      // Non-matching ID returns null
      assert.strictEqual(findVoiceJobOrderByVa2MsgId(db, 'NON_EXISTENT_MSG'), null);
      assert.strictEqual(findVoiceJobOrderByVa2MsgId(db, null), null);
    });

    it('finds order by script text match (exact and substring)', () => {
      const fullScript = 'আজকের বিশেষ বুলেটিন: ঢাকায় নতুন ফ্লাইওভার উদ্বোধন করলেন প্রধানমন্ত্রী। বিস্তারিত আসছে...';
      const order = createVoiceJobOrder(db, {
        customerPhone: '01700112233',
        scriptText: fullScript,
        headline: 'ফ্লাইওভার উদ্বোধন'
      });

      // 1. Exact match
      const exactMatch = findVoiceJobOrderByScriptText(db, fullScript);
      assert.ok(exactMatch);
      assert.strictEqual(exactMatch.order_id, order.order_id);

      // 2. Query is substring of stored script
      const subQueryMatch = findVoiceJobOrderByScriptText(db, 'ঢাকায় নতুন ফ্লাইওভার উদ্বোধন');
      assert.ok(subQueryMatch);
      assert.strictEqual(subQueryMatch.order_id, order.order_id);

      // 3. Stored script is substring of query
      const longerQuery = `ব্রেকিং নিউজ আপডেট: ${fullScript} পরবর্তী খবর রাত ৮টায়।`;
      const superQueryMatch = findVoiceJobOrderByScriptText(db, longerQuery);
      assert.ok(superQueryMatch);
      assert.strictEqual(superQueryMatch.order_id, order.order_id);

      // 4. Non-matching query returns null
      assert.strictEqual(findVoiceJobOrderByScriptText(db, 'সম্পূর্ণ অমিল কোনো স্ক্রিপ্ট যা ডাটাবেজে নেই'), null);
      assert.strictEqual(findVoiceJobOrderByScriptText(db, ''), null);
      assert.strictEqual(findVoiceJobOrderByScriptText(db, null), null);
    });

    it('finds latest pending voice job optionally filtered by customerPhone', () => {
      // Create first order for Customer A
      const order1 = createVoiceJobOrder(db, {
        customerPhone: '01711000001',
        scriptText: 'স্ক্রিপ্ট ১'
      });

      // Create second order for Customer B
      const order2 = createVoiceJobOrder(db, {
        customerPhone: '01711000002',
        scriptText: 'স্ক্রিপ্ট ২'
      });

      // Latest pending across all customers should be order2
      const latestAll = findLatestPendingVoiceJob(db);
      assert.ok(latestAll);
      assert.strictEqual(latestAll.order_id, order2.order_id);

      // Latest pending for Customer A should be order1
      const latestA = findLatestPendingVoiceJob(db, { customerPhone: '01711000001' });
      assert.ok(latestA);
      assert.strictEqual(latestA.order_id, order1.order_id);

      // Latest pending with country code normalization
      const latestANormalized = findLatestPendingVoiceJob(db, { customerPhone: '+880 1711-000001' });
      assert.ok(latestANormalized);
      assert.strictEqual(latestANormalized.order_id, order1.order_id);

      // Mark order2 as delivered; latest across all should now be order1
      updateVoiceJobDelivered(db, order2.order_id, {
        cleanDuration: 30,
        finalAudioFilename: 'order2_clean.mp3'
      });
      const latestAfterDelivered = findLatestPendingVoiceJob(db);
      assert.ok(latestAfterDelivered);
      assert.strictEqual(latestAfterDelivered.order_id, order1.order_id);

      // Customer B should now have no pending jobs
      assert.strictEqual(findLatestPendingVoiceJob(db, { customerPhone: '01711000002' }), null);
    });

    it('updates va2_forward_msg_id', () => {
      const order = createVoiceJobOrder(db, {
        customerPhone: '01711555555',
        scriptText: 'ভয়েস টেস্ট'
      });
      assert.strictEqual(order.va2_forward_msg_id, null);

      const res = updateVoiceJobVa2ForwardMsgId(db, order.order_id, 'FWD_MSG_NEW_789');
      assert.strictEqual(res.updated, true);

      const updated = findVoiceJobOrderByVa2MsgId(db, 'FWD_MSG_NEW_789');
      assert.ok(updated);
      assert.strictEqual(updated.order_id, order.order_id);
      assert.strictEqual(updated.va2_forward_msg_id, 'FWD_MSG_NEW_789');

      // Non-existent order
      assert.strictEqual(updateVoiceJobVa2ForwardMsgId(db, 'NON_EXISTENT_ID', 'SOME_MSG').updated, false);
      assert.strictEqual(updateVoiceJobVa2ForwardMsgId(db, null, 'SOME_MSG').updated, false);
    });

    it('updates voice job as delivered and verifies status DELIVERED and delivered_at timestamp', () => {
      const order = createVoiceJobOrder(db, {
        customerPhone: '01711666666',
        scriptText: 'নিউজ বুলেটিন ডেলিভারি টেস্ট'
      });

      const res = updateVoiceJobDelivered(db, order.order_id, {
        va2AudioMsgId: 'va2_audio_msg_999',
        va2AudioFilename: 'va2_raw_audio.mp3',
        finalAudioFilename: 'final_clean_voice.mp3',
        cleanDuration: 48.75,
        cutsCount: 4,
        modelUsed: 'gemini-2.5-pro'
      });

      assert.strictEqual(res.updated, true);

      const record = getVoiceJobOrder(db, order.order_id);
      assert.ok(record);
      assert.strictEqual(record.status, 'DELIVERED');
      assert.ok(record.delivered_at, 'delivered_at should have a timestamp');
      assert.strictEqual(record.va2_audio_msg_id, 'va2_audio_msg_999');
      assert.strictEqual(record.va2_audio_filename, 'va2_raw_audio.mp3');
      assert.strictEqual(record.final_audio_filename, 'final_clean_voice.mp3');
      assert.strictEqual(record.clean_duration_seconds, 48.75);
      assert.strictEqual(record.cuts_applied_count, 4);
      assert.strictEqual(record.aircheck_model_used, 'gemini-2.5-pro');

      // Non-existent order returns updated: false
      const failedRes = updateVoiceJobDelivered(db, 'NON_EXISTENT_ORDER_ID', { cleanDuration: 10 });
      assert.strictEqual(failedRes.updated, false);
    });
  });
});
