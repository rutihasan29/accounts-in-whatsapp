const assert = require('assert');
const { calculateBill, formatDuration } = require('../lib/billingCalculator');

console.log('Testing billing calculator logic...');

// Test Tier 1 (0:00 to 1:08)
assert.strictEqual(calculateBill(30), 50, '30s should be 50 Taka');
assert.strictEqual(calculateBill(68), 50, '68s (1:08) should be 50 Taka');

// Test Tier 1 Buffer (1:09 to 1:19)
assert.strictEqual(calculateBill(69), 75, '69s (1:09) should be 75 Taka');
assert.strictEqual(calculateBill(79), 75, '79s (1:19) should be 75 Taka');

// Test Tier 2 (1:20 to 2:08)
assert.strictEqual(calculateBill(80), 100, '80s (1:20) should be 100 Taka');
assert.strictEqual(calculateBill(128), 100, '128s (2:08) should be 100 Taka');

// Test Tier 2 Buffer (2:09 to 2:19)
assert.strictEqual(calculateBill(129), 125, '129s (2:09) should be 125 Taka');
assert.strictEqual(calculateBill(139), 125, '139s (2:19) should be 125 Taka');

// Test Tier 3 (2:20 to 3:08)
assert.strictEqual(calculateBill(140), 150, '140s (2:20) should be 150 Taka');
assert.strictEqual(calculateBill(188), 150, '188s (3:08) should be 150 Taka');

// Test Duration Format
assert.strictEqual(formatDuration(75), '1:15');
assert.strictEqual(formatDuration(68), '1:08');

console.log('✅ All billingCalculator tests passed!');
