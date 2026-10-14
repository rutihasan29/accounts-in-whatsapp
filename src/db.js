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
    INSERT INTO transactions (phone_number, type, amount, raw_text, message_id)
    VALUES (?, ?, ?, ?, ?)
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
      message_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_phone ON transactions(phone_number);
    CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
    CREATE INDEX IF NOT EXISTS idx_transactions_message_id ON transactions(message_id);
  `);

  // Ensure message_id exists for existing databases
  try {
    const cols = db.pragma('table_info(transactions)');
    if (!cols.some(c => c.name === 'message_id')) {
      db.exec('ALTER TABLE transactions ADD COLUMN message_id TEXT;');
      db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_message_id ON transactions(message_id);');
    }
  } catch {}

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

function recordTransaction(db, { phone, name = null, type, amount, rawText, messageId = null }) {
  const insertCustomer = getStatement(db, 'insertCustomer');
  const insertTx = getStatement(db, 'insertTransaction');

  if (!db._stmtCache) {
    db._stmtCache = {};
  }

  if (!db._stmtCache.recordTx) {
    db._stmtCache.recordTx = db.transaction((p, n, t, a, r, m) => {
      insertCustomer.run(p, n);
      const info = insertTx.run(p, t, a, r, m || null);
      const summary = getCustomerSummary(db, p);
      return {
        transactionId: info.lastInsertRowid,
        dueAmount: summary ? summary.due_amount : a
      };
    });
  }

  return db._stmtCache.recordTx(phone, name, type, amount, rawText, messageId);
}

function updateTransactionMessageId(db, transactionId, messageId) {
  if (!transactionId || !messageId) return false;
  const stmt = db.prepare('UPDATE transactions SET message_id = ? WHERE id = ?');
  const res = stmt.run(messageId, transactionId);
  return res.changes > 0;
}

function deleteTransactionByMessageId(db, messageIds) {
  if (!messageIds) return null;
  const rawIds = Array.isArray(messageIds) ? messageIds.filter(Boolean) : [messageIds].filter(Boolean);
  if (rawIds.length === 0) return null;

  const candidateSet = new Set();
  for (const id of rawIds) {
    if (typeof id === 'string') {
      candidateSet.add(id);
      if (id.includes('_')) {
        candidateSet.add(id.split('_').pop());
      }
    }
  }
  const ids = Array.from(candidateSet);
  if (ids.length === 0) return null;

  const placeholders = ids.map(() => '?').join(',');
  const conditions = [`message_id IN (${placeholders})`];
  const params = [...ids];
  for (const id of ids) {
    conditions.push(`message_id LIKE '%_' || ?`);
    params.push(id);
  }

  const findStmt = db.prepare(`SELECT * FROM transactions WHERE ${conditions.join(' OR ')} ORDER BY id DESC LIMIT 1`);
  const tx = findStmt.get(...params);
  if (!tx) return null;

  const deleteStmt = db.prepare('DELETE FROM transactions WHERE id = ?');
  deleteStmt.run(tx.id);

  const summary = getCustomerSummary(db, tx.phone_number);
  return {
    deleted: true,
    transaction: tx,
    dueAmount: summary ? summary.due_amount : 0
  };
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
  updateTransactionMessageId,
  deleteTransactionByMessageId,
  getDueList,
  getCustomerSummary,
  migrateCustomerPhone
};
