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
  migrateCustomerPhone
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
});
