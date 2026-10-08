const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const STATEMENTS = {
  getCustomerSummary: `
    SELECT 
      c.phone_number,
      c.name,
      COALESCE(SUM(CASE WHEN t.type = 'BILL' THEN t.amount ELSE 0 END), 0) AS total_bill,
      COALESCE(SUM(CASE WHEN t.type = 'PAYMENT' THEN t.amount ELSE 0 END), 0) AS total_paid,
      (COALESCE(SUM(CASE WHEN t.type = 'BILL' THEN t.amount ELSE 0 END), 0) - 
       COALESCE(SUM(CASE WHEN t.type = 'PAYMENT' THEN t.amount ELSE 0 END), 0)) AS due_amount
    FROM customers c
    LEFT JOIN transactions t ON c.phone_number = t.phone_number
    WHERE c.phone_number = ?
    GROUP BY c.phone_number
  `,
  insertCustomer: `
    INSERT INTO customers (phone_number, name)
    VALUES (?, ?)
    ON CONFLICT(phone_number) DO UPDATE SET
      name = COALESCE(excluded.name, customers.name),
      updated_at = CURRENT_TIMESTAMP
  `,
  insertTransaction: `
    INSERT INTO transactions (phone_number, type, amount, raw_text)
    VALUES (?, ?, ?, ?)
  `,
  getDueList: `
    SELECT 
      c.phone_number,
      c.name,
      COALESCE(SUM(CASE WHEN t.type = 'BILL' THEN t.amount ELSE 0 END), 0) AS total_bill,
      COALESCE(SUM(CASE WHEN t.type = 'PAYMENT' THEN t.amount ELSE 0 END), 0) AS total_paid,
      (COALESCE(SUM(CASE WHEN t.type = 'BILL' THEN t.amount ELSE 0 END), 0) - 
       COALESCE(SUM(CASE WHEN t.type = 'PAYMENT' THEN t.amount ELSE 0 END), 0)) AS due_amount
    FROM customers c
    LEFT JOIN transactions t ON c.phone_number = t.phone_number
    GROUP BY c.phone_number
    HAVING due_amount > 0
    ORDER BY due_amount DESC
  `
};

function getStatement(db, key) {
  if (!db._stmtCache) {
    db._stmtCache = {};
  }
  if (!db._stmtCache[key]) {
    const sql = STATEMENTS[key] || (key === 'insertTx' ? STATEMENTS.insertTransaction : null);
    if (!sql) {
      throw new Error(`Unknown statement key: ${key}`);
    }
    db._stmtCache[key] = db.prepare(sql);
  }
  return db._stmtCache[key];
}

function initDb(dbPath) {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Schema creation
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      phone_number TEXT PRIMARY KEY,
      name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT NOT NULL REFERENCES customers(phone_number),
      type TEXT NOT NULL CHECK(type IN ('BILL', 'PAYMENT')),
      amount REAL NOT NULL,
      raw_text TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_phone ON transactions(phone_number);
    CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
  `);

  // Initialize prepared statement cache
  db._stmtCache = {};
  for (const [key, sql] of Object.entries(STATEMENTS)) {
    db._stmtCache[key] = db.prepare(sql);
  }
  db._stmtCache.insertTx = db._stmtCache.insertTransaction;

  return db;
}

function getCustomerSummary(db, phone) {
  const stmt = getStatement(db, 'getCustomerSummary');
  return stmt.get(phone) || null;
}

function recordTransaction(db, { phone, name = null, type, amount, rawText }) {
  const insertCustomer = getStatement(db, 'insertCustomer');
  const insertTx = getStatement(db, 'insertTransaction');

  if (!db._stmtCache) {
    db._stmtCache = {};
  }

  if (!db._stmtCache.recordTx) {
    db._stmtCache.recordTx = db.transaction((p, n, t, a, r) => {
      insertCustomer.run(p, n);
      const info = insertTx.run(p, t, a, r);
      const summary = getCustomerSummary(db, p);
      return {
        transactionId: info.lastInsertRowid,
        dueAmount: summary ? summary.due_amount : a
      };
    });
  }

  return db._stmtCache.recordTx(phone, name, type, amount, rawText);
}

function getDueList(db) {
  const stmt = getStatement(db, 'getDueList');
  return stmt.all();
}

function migrateCustomerPhone(db, oldIdentifier, newPhone) {
  if (!oldIdentifier || !newPhone || oldIdentifier === newPhone) return;

  const migrateTx = db.transaction(() => {
    const existing = db.prepare('SELECT phone_number, name FROM customers WHERE phone_number = ?').get(newPhone);
    const oldCust = db.prepare('SELECT phone_number, name, created_at, updated_at FROM customers WHERE phone_number = ?').get(oldIdentifier);

    if (!oldCust) return;

    if (existing) {
      db.prepare('UPDATE transactions SET phone_number = ? WHERE phone_number = ?').run(newPhone, oldIdentifier);
      db.prepare('DELETE FROM customers WHERE phone_number = ?').run(oldIdentifier);
      if (!existing.name && oldCust.name) {
        db.prepare('UPDATE customers SET name = ? WHERE phone_number = ?').run(oldCust.name, newPhone);
      }
    } else {
      db.prepare('INSERT INTO customers (phone_number, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
        newPhone,
        oldCust.name,
        oldCust.created_at,
        oldCust.updated_at
      );
      db.prepare('UPDATE transactions SET phone_number = ? WHERE phone_number = ?').run(newPhone, oldIdentifier);
      db.prepare('DELETE FROM customers WHERE phone_number = ?').run(oldIdentifier);
    }
  });

  try {
    return migrateTx();
  } catch (err) {
    console.error('Error migrating customer phone in db:', err);
  }
}

module.exports = {
  initDb,
  recordTransaction,
  getDueList,
  getCustomerSummary,
  migrateCustomerPhone
};
