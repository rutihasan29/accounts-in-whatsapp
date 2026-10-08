const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initDb, recordTransaction, getDueList, getCustomerSummary } = require('../src/db');

describe('Database Module', () => {
  let db;

  beforeEach(() => {
    // In-memory database for isolated tests
    db = initDb(':memory:');
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
});
