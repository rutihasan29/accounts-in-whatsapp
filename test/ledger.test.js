const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { getCustomerBill, recordTransaction, clearCustomerBill } = require('../lib/ledger');

console.log('Testing ledger storage logic...');

const testDbPath = path.join(__dirname, 'test_bills.json');
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

const customer = '8801700000000';

// Record transaction
const record = recordTransaction(customer, { filename: 'test.mp3', durationSeconds: 75, amount: 75 }, testDbPath);
assert.strictEqual(record.totalBill, 75, 'First transaction bill should be 75');

// Check getCustomerBill
const data = getCustomerBill(customer, testDbPath);
assert.strictEqual(data.totalBill, 75, 'Fetched bill should be 75');

// Record second transaction
recordTransaction(customer, { filename: 'test2.mp3', durationSeconds: 60, amount: 50 }, testDbPath);
const updatedData = getCustomerBill(customer, testDbPath);
assert.strictEqual(updatedData.totalBill, 125, 'Accumulated bill should be 125');

// Clear bill
clearCustomerBill(customer, testDbPath);
const clearedData = getCustomerBill(customer, testDbPath);
assert.strictEqual(clearedData.totalBill, 0, 'Cleared bill should be 0');

if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
console.log('✅ All ledger tests passed!');
