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
       COALESCE(SUM(CASE WHEN t.type = 'PAYMENT' THEN t.amount ELSE 0 END), 0)) AS due_amount,
      l.first_contact_at,
      l.first_job_delivered_at,
      l.conversion_duration_seconds,
      l.first_job_type
    FROM customers c
    LEFT JOIN transactions t ON c.phone_number = t.phone_number
    LEFT JOIN leads l ON c.phone_number = l.phone_number
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
    INSERT INTO transactions (phone_number, type, amount, raw_text, message_id, job_type, duration_seconds)
    VALUES (?, ?, ?, ?, ?, ?, ?)
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
  `,
  getAllCustomersSummary: `
    SELECT 
      c.phone_number,
      c.name,
      COALESCE(SUM(CASE WHEN t.type = 'BILL' THEN t.amount ELSE 0 END), 0) AS total_bill,
      COALESCE(SUM(CASE WHEN t.type = 'PAYMENT' THEN t.amount ELSE 0 END), 0) AS total_paid,
      (COALESCE(SUM(CASE WHEN t.type = 'BILL' THEN t.amount ELSE 0 END), 0) - 
       COALESCE(SUM(CASE WHEN t.type = 'PAYMENT' THEN t.amount ELSE 0 END), 0)) AS due_amount,
      MAX(t.created_at) AS last_activity,
      COUNT(t.id) AS transaction_count,
      l.first_contact_at,
      l.first_job_delivered_at,
      l.conversion_duration_seconds,
      l.first_job_type
    FROM customers c
    LEFT JOIN transactions t ON c.phone_number = t.phone_number
    LEFT JOIN leads l ON c.phone_number = l.phone_number
    GROUP BY c.phone_number
    ORDER BY due_amount DESC, last_activity DESC
  `,
  getCustomerTransactions: `
    SELECT id, phone_number, type, amount, raw_text, message_id, job_type, duration_seconds, created_at
    FROM transactions
    WHERE phone_number = ?
    ORDER BY id ASC
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
      job_type TEXT DEFAULT NULL,
      duration_seconds INTEGER DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS leads (
      phone_number TEXT PRIMARY KEY,
      name TEXT,
      status TEXT DEFAULT 'PENDING',
      first_contact_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      first_job_delivered_at DATETIME,
      conversion_duration_seconds INTEGER,
      first_job_type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_phone ON transactions(phone_number);
    CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_first_contact ON leads(first_contact_at);
  `);

  // Ensure message_id, job_type, duration_seconds exist for pre-existing databases before indexing
  try {
    const cols = db.pragma('table_info(transactions)');
    if (!cols.some(c => c.name === 'message_id')) {
      db.exec('ALTER TABLE transactions ADD COLUMN message_id TEXT;');
    }
    if (!cols.some(c => c.name === 'job_type')) {
      db.exec('ALTER TABLE transactions ADD COLUMN job_type TEXT DEFAULT NULL;');
    }
    if (!cols.some(c => c.name === 'duration_seconds')) {
      db.exec('ALTER TABLE transactions ADD COLUMN duration_seconds INTEGER DEFAULT NULL;');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_message_id ON transactions(message_id);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_job_type ON transactions(job_type);');
  } catch (err) {
    console.error('Error ensuring columns/indexes in SQLite:', err);
  }

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

function recordLead(db, { phone, name = null }) {
  if (!phone) return null;

  // Check if customer already exists in customers table
  const existingCust = db.prepare('SELECT phone_number FROM customers WHERE phone_number = ?').get(phone);
  if (existingCust) {
    return { status: 'EXISTING_CUSTOMER', phone };
  }

  // Check if lead already exists in leads table
  const existingLead = db.prepare('SELECT phone_number, status, first_contact_at FROM leads WHERE phone_number = ?').get(phone);
  if (existingLead) {
    if (name) {
      db.prepare('UPDATE leads SET name = COALESCE(?, name), updated_at = CURRENT_TIMESTAMP WHERE phone_number = ?').run(name, phone);
    }
    return { status: 'EXISTING_LEAD', phone, isPending: existingLead.status === 'PENDING' };
  }

  // Insert brand new lead
  db.prepare(`
    INSERT INTO leads (phone_number, name, status, first_contact_at)
    VALUES (?, ?, 'PENDING', CURRENT_TIMESTAMP)
  `).run(phone, name);

  return { status: 'NEW_LEAD', phone, name };
}

function getLead(db, phone) {
  if (!phone) return null;
  return db.prepare('SELECT * FROM leads WHERE phone_number = ?').get(phone) || null;
}

function recordTransaction(db, {
  phone,
  name = null,
  type,
  amount,
  rawText,
  messageId = null,
  jobType = null,
  durationSeconds = null
}) {
  const insertCustomer = getStatement(db, 'insertCustomer');
  const insertTx = getStatement(db, 'insertTransaction');

  if (!db._stmtCache) {
    db._stmtCache = {};
  }

  if (!db._stmtCache.recordTx) {
    db._stmtCache.recordTx = db.transaction((p, n, t, a, r, m, jt, ds) => {
      insertCustomer.run(p, n);
      const info = insertTx.run(
        p,
        t,
        a,
        r,
        m || null,
        jt || null,
        ds !== null && ds !== undefined ? ds : null
      );

      // If this transaction is a BILL, convert any pending lead
      if (t === 'BILL') {
        const lead = db.prepare("SELECT phone_number, first_contact_at, status FROM leads WHERE phone_number = ?").get(p);
        if (lead && lead.status === 'PENDING') {
          db.prepare(`
            UPDATE leads
            SET status = 'CONVERTED',
                first_job_delivered_at = CURRENT_TIMESTAMP,
                first_job_type = ?,
                conversion_duration_seconds = MAX(0, CAST((strftime('%s', CURRENT_TIMESTAMP) - strftime('%s', first_contact_at)) AS INTEGER)),
                updated_at = CURRENT_TIMESTAMP
            WHERE phone_number = ?
          `).run(jt || 'voice', p);
        }
      }

      const summary = getCustomerSummary(db, p);
      return {
        transactionId: info.lastInsertRowid,
        dueAmount: summary ? summary.due_amount : a
      };
    });
  }

  return db._stmtCache.recordTx(phone, name, type, amount, rawText, messageId, jobType, durationSeconds);
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

function getCustomerTransactions(db, phone) {
  const stmt = getStatement(db, 'getCustomerTransactions');
  const rows = stmt.all(phone);
  let runningBalance = 0;
  return rows.map((tx) => {
    if (tx.type === 'BILL') {
      runningBalance += tx.amount;
    } else if (tx.type === 'PAYMENT') {
      runningBalance -= tx.amount;
    }
    return {
      ...tx,
      running_balance: Math.round(runningBalance * 100) / 100
    };
  });
}

function getAllCustomersSummary(db) {
  const stmt = getStatement(db, 'getAllCustomersSummary');
  return stmt.all();
}

const PROFIT_MARGINS = {
  voice: 0.60,
  default: 0.60
};

function getProfitMargin(jobType) {
  if (!jobType) return PROFIT_MARGINS.default;
  const key = String(jobType).toLowerCase().trim();
  return PROFIT_MARGINS[key] !== undefined ? PROFIT_MARGINS[key] : PROFIT_MARGINS.default;
}

function calculateGrowthRate(current, previous) {
  if (previous === 0) {
    return current > 0 ? 100 : 0;
  }
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function getBusinessPerformanceMetrics(db) {
  const getMetricsForFilter = (dateCondition) => {
    const rows = db.prepare(`
      SELECT amount, job_type
      FROM transactions
      WHERE type = 'BILL' AND ${dateCondition}
    `).all();

    const jobsCount = rows.length;
    let grossProfit = 0;
    for (const row of rows) {
      grossProfit += row.amount * getProfitMargin(row.job_type);
    }
    return {
      jobsCount,
      grossProfit: Math.round(grossProfit * 100) / 100
    };
  };

  const getConversionMetrics = (dateCondition) => {
    try {
      const leadsCond = dateCondition.replace(/created_at/g, 'first_contact_at');
      const leadsRow = db.prepare(`SELECT COUNT(*) AS count FROM leads WHERE ${leadsCond}`).get();
      const leadsCount = leadsRow?.count || 0;

      const convCond = dateCondition.replace(/created_at/g, 'first_job_delivered_at');
      const convRow = db.prepare(`
        SELECT 
          COUNT(*) AS count,
          AVG(conversion_duration_seconds) AS avg_duration
        FROM leads 
        WHERE status = 'CONVERTED' AND ${convCond}
      `).get();
      const convertedCount = convRow?.count || 0;
      const avgDurationSeconds = Math.round(convRow?.avg_duration || 0);

      let conversionRate = 0;
      if (leadsCount > 0) {
        conversionRate = Math.min(100, Math.round((convertedCount / leadsCount) * 100));
      } else if (convertedCount > 0) {
        conversionRate = 100;
      }

      return {
        leadsCount,
        convertedCount,
        conversionRate,
        avgDurationSeconds
      };
    } catch {
      return { leadsCount: 0, convertedCount: 0, conversionRate: 0, avgDurationSeconds: 0 };
    }
  };

  // Daily: Today vs Yesterday
  const today = getMetricsForFilter("date(created_at, 'localtime') = date('now', 'localtime')");
  const yesterday = getMetricsForFilter("date(created_at, 'localtime') = date('now', 'localtime', '-1 day')");

  // Weekly: Current 7 days vs Previous 7 days
  const thisWeek = getMetricsForFilter("date(created_at, 'localtime') >= date('now', 'localtime', '-6 days')");
  const lastWeek = getMetricsForFilter("date(created_at, 'localtime') >= date('now', 'localtime', '-13 days') AND date(created_at, 'localtime') < date('now', 'localtime', '-6 days')");

  // Monthly: Current calendar month vs Previous calendar month
  const thisMonth = getMetricsForFilter("strftime('%Y-%m', created_at, 'localtime') = strftime('%Y-%m', 'now', 'localtime')");
  const lastMonth = getMetricsForFilter("strftime('%Y-%m', created_at, 'localtime') = strftime('%Y-%m', date('now', 'localtime', 'start of month', '-1 day'))");

  return {
    daily: {
      periodLabel: 'দৈনিক (আজ)',
      periodKey: 'daily',
      jobsCount: today.jobsCount,
      grossProfit: today.grossProfit,
      previousJobsCount: yesterday.jobsCount,
      previousGrossProfit: yesterday.grossProfit,
      jobsGrowth: calculateGrowthRate(today.jobsCount, yesterday.jobsCount),
      profitGrowth: calculateGrowthRate(today.grossProfit, yesterday.grossProfit),
      conversion: getConversionMetrics("date(created_at, 'localtime') = date('now', 'localtime')")
    },
    weekly: {
      periodLabel: 'সাপ্তাহিক (চলতি সপ্তাহ)',
      periodKey: 'weekly',
      jobsCount: thisWeek.jobsCount,
      grossProfit: thisWeek.grossProfit,
      previousJobsCount: lastWeek.jobsCount,
      previousGrossProfit: lastWeek.grossProfit,
      jobsGrowth: calculateGrowthRate(thisWeek.jobsCount, lastWeek.jobsCount),
      profitGrowth: calculateGrowthRate(thisWeek.grossProfit, lastWeek.grossProfit),
      conversion: getConversionMetrics("date(created_at, 'localtime') >= date('now', 'localtime', '-6 days')")
    },
    monthly: {
      periodLabel: 'মাসিক (চলতি মাস)',
      periodKey: 'monthly',
      jobsCount: thisMonth.jobsCount,
      grossProfit: thisMonth.grossProfit,
      previousJobsCount: lastMonth.jobsCount,
      previousGrossProfit: lastMonth.grossProfit,
      jobsGrowth: calculateGrowthRate(thisMonth.jobsCount, lastMonth.jobsCount),
      profitGrowth: calculateGrowthRate(thisMonth.grossProfit, lastMonth.grossProfit),
      conversion: getConversionMetrics("strftime('%Y-%m', created_at, 'localtime') = strftime('%Y-%m', 'now', 'localtime')")
    }
  };
}

function getDashboardStats(db) {
  const dues = getDueList(db);
  const totalDue = dues.reduce((acc, c) => acc + (c.due_amount || 0), 0);

  const todayStmt = db.prepare(`
    SELECT 
      COALESCE(SUM(CASE WHEN type = 'BILL' THEN amount ELSE 0 END), 0) AS today_billed,
      COALESCE(SUM(CASE WHEN type = 'PAYMENT' THEN amount ELSE 0 END), 0) AS today_collected,
      COUNT(id) AS today_count
    FROM transactions
    WHERE date(created_at, 'localtime') = date('now', 'localtime')
  `);
  const today = todayStmt.get() || { today_billed: 0, today_collected: 0, today_count: 0 };

  const totalCustomers = db.prepare('SELECT COUNT(*) AS count FROM customers').get().count;
  const performance = getBusinessPerformanceMetrics(db);

  return {
    totalDue: Math.round(totalDue * 100) / 100,
    debtorsCount: dues.length,
    totalCustomers,
    todayBilled: Math.round(today.today_billed * 100) / 100,
    todayCollected: Math.round(today.today_collected * 100) / 100,
    todayTransactionsCount: today.today_count,
    performance
  };
}

module.exports = {
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
};
