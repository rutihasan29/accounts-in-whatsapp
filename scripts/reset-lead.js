const Database = require('better-sqlite3');
const path = require('path');
const config = require('../src/config');

const phoneInput = process.argv[2];
if (!phoneInput) {
  console.log('Usage: node scripts/reset-lead.js <phone_number>');
  process.exit(1);
}

const cleanPhone = phoneInput.replace(/\D/g, '');
if (!cleanPhone) {
  console.log('Error: Invalid phone number provided.');
  process.exit(1);
}

const db = new Database(config.DB_PATH);

// Disable foreign keys temporarily during targeted cleanup
db.pragma('foreign_keys = OFF');
const delTx = db.prepare('DELETE FROM transactions WHERE phone_number LIKE ?').run(`%${cleanPhone}%`);
const delCust = db.prepare('DELETE FROM customers WHERE phone_number LIKE ?').run(`%${cleanPhone}%`);
const delLeads = db.prepare('DELETE FROM leads WHERE phone_number LIKE ?').run(`%${cleanPhone}%`);
db.pragma('foreign_keys = ON');

console.log(`[RESET] Cleaned records matching "${cleanPhone}":`);
console.log(`  - Leads removed: ${delLeads.changes}`);
console.log(`  - Customers removed: ${delCust.changes}`);
console.log(`  - Transactions removed: ${delTx.changes}`);
console.log(`Now ${cleanPhone} will be treated as a brand-new contact on their next message!`);
