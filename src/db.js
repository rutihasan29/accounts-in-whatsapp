const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { initCrmDb } = require('./crm/db');

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
      welcome_sent INTEGER DEFAULT 0,
      first_contact_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      first_job_delivered_at DATETIME,
      conversion_duration_seconds INTEGER,
      first_job_type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ad_spend (
      spend_date TEXT PRIMARY KEY,
      amount REAL NOT NULL,
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bot_uptime_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL CHECK(status IN ('ONLINE', 'OFFLINE')),
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME DEFAULT NULL,
      duration_seconds INTEGER DEFAULT NULL,
      last_heartbeat_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reason TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS video_customers (
      phone_number TEXT PRIMARY KEY,
      note TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS voice_job_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT UNIQUE NOT NULL,
      customer_phone TEXT NOT NULL,
      customer_name TEXT,
      customer_script_msg_id TEXT,
      va2_forward_msg_id TEXT,
      script_text TEXT NOT NULL,
      headline TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING_VA2',
      va2_audio_msg_id TEXT,
      va2_audio_filename TEXT,
      final_audio_filename TEXT,
      original_duration_seconds REAL,
      clean_duration_seconds REAL,
      aircheck_model_used TEXT,
      cuts_applied_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      delivered_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS bot_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pending_confirmations (
      customer_phone TEXT PRIMARY KEY,
      script TEXT NOT NULL,
      customer_name TEXT,
      customer_script_msg_id TEXT,
      timeout_ms INTEGER NOT NULL,
      asked_at INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS staff_lids (
      staff_role TEXT PRIMARY KEY,
      phone_number TEXT NOT NULL,
      lid TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS whatsapp_customer_notes (
      phone TEXT PRIMARY KEY,
      note TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS system_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_type TEXT NOT NULL,
      context TEXT,
      error_message TEXT,
      log_details TEXT,
      recipient TEXT,
      sent_status TEXT DEFAULT 'SENT',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON system_alerts(created_at);

    CREATE INDEX IF NOT EXISTS idx_transactions_phone ON transactions(phone_number);
    CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_first_contact ON leads(first_contact_at);
    CREATE INDEX IF NOT EXISTS idx_ad_spend_date ON ad_spend(spend_date);
    CREATE INDEX IF NOT EXISTS idx_uptime_status ON bot_uptime_logs(status);
    CREATE INDEX IF NOT EXISTS idx_uptime_started ON bot_uptime_logs(started_at);
    CREATE INDEX IF NOT EXISTS idx_video_customers_phone ON video_customers(phone_number);
    CREATE INDEX IF NOT EXISTS idx_voice_job_va2_msg ON voice_job_orders(va2_forward_msg_id);
    CREATE INDEX IF NOT EXISTS idx_voice_job_customer_phone ON voice_job_orders(customer_phone);
    CREATE INDEX IF NOT EXISTS idx_voice_job_status ON voice_job_orders(status);
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

    const leadCols = db.pragma('table_info(leads)');
    if (!leadCols.some(c => c.name === 'welcome_sent')) {
      db.exec('ALTER TABLE leads ADD COLUMN welcome_sent INTEGER DEFAULT 0;');
    }
  } catch (err) {
    console.error('Error ensuring columns/indexes in SQLite:', err);
  }

  // Initialize CRM subsystem tables
  try {
    initCrmDb(db);
  } catch (crmInitErr) {
    console.error('Error initializing CRM database schema:', crmInitErr);
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

function recordLead(db, { phone, name = null, firstContactAt = null }) {
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
    VALUES (?, ?, 'PENDING', COALESCE(?, CURRENT_TIMESTAMP))
  `).run(phone, name, firstContactAt);

  return { status: 'NEW_LEAD', phone, name };
}

function getLead(db, phone) {
  if (!phone) return null;
  return db.prepare('SELECT * FROM leads WHERE phone_number = ?').get(phone) || null;
}

function recordExistingContact(db, { phone, name = null, timestamp = null }) {
  if (!phone) return null;

  const existingCust = db.prepare('SELECT phone_number FROM customers WHERE phone_number = ?').get(phone);
  if (existingCust) {
    db.prepare(`
      INSERT INTO leads (phone_number, name, status, welcome_sent, first_contact_at)
      VALUES (?, ?, 'CONVERTED', 1, COALESCE(?, CURRENT_TIMESTAMP))
      ON CONFLICT(phone_number) DO UPDATE SET welcome_sent = 1, name = COALESCE(excluded.name, leads.name), updated_at = CURRENT_TIMESTAMP
    `).run(phone, name, timestamp);
    return { status: 'EXISTING_CUSTOMER', phone };
  }

  db.prepare(`
    INSERT INTO leads (phone_number, name, status, welcome_sent, first_contact_at)
    VALUES (?, ?, 'EXISTING', 1, COALESCE(?, CURRENT_TIMESTAMP))
    ON CONFLICT(phone_number) DO UPDATE SET welcome_sent = 1, name = COALESCE(excluded.name, leads.name), updated_at = CURRENT_TIMESTAMP
  `).run(phone, name, timestamp);

  return { status: 'RECORDED_EXISTING', phone, name };
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
  audio: 0.60,
  video: 0.34,
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

function parseDateYMD(d) {
  if (!d) return null;
  if (d instanceof Date) {
    return d.toISOString().split('T')[0];
  }
  if (typeof d === 'string') {
    const trimmed = d.trim();
    const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  }
  return null;
}

function getDatesBetween(startDateStr, endDateStr) {
  const dates = [];
  const start = new Date(startDateStr + 'T00:00:00Z');
  const end = new Date(endDateStr + 'T00:00:00Z');
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return dates;
  }
  let [earlier, later] = start <= end ? [start, end] : [end, start];
  const curr = new Date(earlier);
  while (curr <= later) {
    dates.push(curr.toISOString().split('T')[0]);
    curr.setUTCDate(curr.getUTCDate() + 1);
  }
  return dates;
}

function recordAdSpend(db, { date, startDate, endDate, dailyAmount, amount, note = null }) {
  const spendAmount = Number(dailyAmount !== undefined ? dailyAmount : amount);
  if (isNaN(spendAmount) || spendAmount < 0) {
    throw new Error('Valid ad spend amount is required');
  }

  const sDate = parseDateYMD(date || startDate);
  const eDate = parseDateYMD(endDate || date || startDate);

  if (!sDate) {
    throw new Error('Valid date is required');
  }

  const targetDates = getDatesBetween(sDate, eDate);
  if (targetDates.length === 0) {
    targetDates.push(sDate);
  }

  const upsertStmt = db.prepare(`
    INSERT INTO ad_spend (spend_date, amount, note, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(spend_date) DO UPDATE SET
      amount = excluded.amount,
      note = COALESCE(excluded.note, ad_spend.note),
      updated_at = CURRENT_TIMESTAMP
  `);

  const runUpsert = db.transaction((dates) => {
    for (const d of dates) {
      upsertStmt.run(d, spendAmount, note);
    }
  });

  runUpsert(targetDates);

  return {
    count: targetDates.length,
    totalAmount: spendAmount * targetDates.length,
    dates: targetDates
  };
}

function getAdSpendList(db, { limit = 100 } = {}) {
  const rows = db.prepare(`
    SELECT 
      a.spend_date,
      a.amount,
      a.note,
      a.created_at,
      a.updated_at,
      (SELECT COUNT(*) FROM leads WHERE strftime('%Y-%m-%d', first_contact_at, 'localtime') = a.spend_date) AS leads_count
    FROM ad_spend a
    ORDER BY a.spend_date DESC
    LIMIT ?
  `).all(limit);

  return rows.map((r) => {
    const leads = r.leads_count || 0;
    const cpl = leads > 0 ? Math.round((r.amount / leads) * 100) / 100 : null;
    return {
      ...r,
      daily_cpl: cpl
    };
  });
}

function getAdSpendSummary(db) {
  const totalRow = db.prepare(`
    SELECT 
      COALESCE(SUM(amount), 0) AS total_spend,
      COUNT(spend_date) AS days_count,
      COALESCE(AVG(amount), 0) AS avg_daily_spend,
      MIN(spend_date) AS first_date,
      MAX(spend_date) AS last_date
    FROM ad_spend
  `).get();

  return {
    totalSpend: totalRow.total_spend || 0,
    daysCount: totalRow.days_count || 0,
    avgDailySpend: Math.round((totalRow.avg_daily_spend || 0) * 100) / 100,
    firstDate: totalRow.first_date,
    lastDate: totalRow.last_date
  };
}

function getSimulationBaselines(db) {
  const txStats = db.prepare(`
    SELECT 
      COUNT(*) AS total_jobs,
      COALESCE(SUM(amount), 0) AS total_billed,
      COALESCE(AVG(amount), 0) AS avg_ticket,
      COUNT(DISTINCT phone_number) AS paying_customers
    FROM transactions 
    WHERE type = 'BILL'
  `).get();

  const totalJobs = txStats.total_jobs || 0;
  const totalBilled = txStats.total_billed || 0;
  const avgTicket = totalJobs > 0 ? Math.round((totalBilled / totalJobs) * 100) / 100 : 250;
  const payingCustomers = txStats.paying_customers || 0;
  const repeatFrequency = payingCustomers > 0 ? Math.round((totalJobs / payingCustomers) * 100) / 100 : 2.0;

  const billRows = db.prepare(`SELECT amount, job_type FROM transactions WHERE type = 'BILL'`).all();
  let totalGrossProfit = 0;
  for (const r of billRows) {
    totalGrossProfit += r.amount * getProfitMargin(r.job_type);
  }
  const grossMarginRate = totalBilled > 0 ? (Math.round((totalGrossProfit / totalBilled) * 100) / 100) : (PROFIT_MARGINS.voice || 0.60);
  const avgGrossProfitPerJob = totalJobs > 0 ? Math.round((totalGrossProfit / totalJobs) * 100) / 100 : Math.round(avgTicket * grossMarginRate * 100) / 100;

  const leadStats = db.prepare(`
    SELECT 
      COUNT(*) AS total_leads,
      COUNT(CASE WHEN status = 'CONVERTED' THEN 1 END) AS converted_leads,
      COALESCE(AVG(conversion_duration_seconds), 0) AS avg_duration_sec
    FROM leads
  `).get();

  const totalLeads = leadStats.total_leads || 0;
  const convertedLeads = leadStats.converted_leads || 0;
  const conversionRate = totalLeads > 0 ? Math.round((convertedLeads / totalLeads) * 1000) / 10 : 25.0;
  const avgTurnaroundSeconds = Math.round(leadStats.avg_duration_sec || 0);

  const spendList = getAdSpendList(db, { limit: 90 });
  const spendSummary = getAdSpendSummary(db);

  const totalAdSpend = spendSummary.totalSpend;
  const totalLeadsWithAds = spendList.reduce((acc, r) => acc + (r.leads_count || 0), 0);
  const historicalCpl = totalLeadsWithAds > 0 && totalAdSpend > 0 
    ? Math.round((totalAdSpend / totalLeadsWithAds) * 100) / 100 
    : (totalLeads > 0 && totalAdSpend > 0 ? Math.round((totalAdSpend / totalLeads) * 100) / 100 : 50);

  const historicalCac = convertedLeads > 0 && totalAdSpend > 0
    ? Math.round((totalAdSpend / convertedLeads) * 100) / 100
    : Math.round((historicalCpl / ((conversionRate || 25) / 100)) * 100) / 100;

  return {
    avgTicket,
    grossMarginRate,
    profitMargins: PROFIT_MARGINS,
    avgGrossProfitPerJob,
    totalJobs,
    uniquePayingCustomers: payingCustomers,
    repeatJobFrequency: repeatFrequency,
    totalLeads,
    convertedLeads,
    conversionRate,
    avgTurnaroundSeconds,
    totalAdSpend,
    adSpendDays: spendSummary.daysCount,
    historicalCpl,
    historicalCac,
    dailyCplHistory: spendList.slice(0, 30)
  };
}

function recoverUngracefulShutdown(db) {
  const openSession = db.prepare('SELECT * FROM bot_uptime_logs WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get();
  if (!openSession) return;

  if (openSession.status === 'ONLINE') {
    const endedAt = openSession.last_heartbeat_at || openSession.started_at;
    db.prepare(`
      UPDATE bot_uptime_logs
      SET ended_at = ?,
          duration_seconds = MAX(0, CAST((strftime('%s', ?) - strftime('%s', started_at)) AS INTEGER))
      WHERE id = ?
    `).run(endedAt, endedAt, openSession.id);

    db.prepare(`
      INSERT INTO bot_uptime_logs (status, started_at, ended_at, duration_seconds, last_heartbeat_at, reason)
      VALUES ('OFFLINE', ?, CURRENT_TIMESTAMP, MAX(0, CAST((strftime('%s', CURRENT_TIMESTAMP) - strftime('%s', ?)) AS INTEGER)), CURRENT_TIMESTAMP, 'CRASH_RECOVERED')
    `).run(endedAt, endedAt);
  }
}

function recordBotState(db, status, reason = null) {
  if (!status || (status !== 'ONLINE' && status !== 'OFFLINE')) return null;

  const currentOpen = db.prepare('SELECT * FROM bot_uptime_logs WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get();
  if (currentOpen && currentOpen.status === status) {
    db.prepare(`
      UPDATE bot_uptime_logs
      SET last_heartbeat_at = CURRENT_TIMESTAMP,
          reason = COALESCE(?, reason)
      WHERE id = ?
    `).run(reason, currentOpen.id);
    return currentOpen;
  }

  if (currentOpen) {
    db.prepare(`
      UPDATE bot_uptime_logs
      SET ended_at = CURRENT_TIMESTAMP,
          duration_seconds = MAX(0, CAST((strftime('%s', CURRENT_TIMESTAMP) - strftime('%s', started_at)) AS INTEGER)),
          last_heartbeat_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(currentOpen.id);
  }

  const info = db.prepare(`
    INSERT INTO bot_uptime_logs (status, started_at, last_heartbeat_at, reason)
    VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
  `).run(status, reason);

  return db.prepare('SELECT * FROM bot_uptime_logs WHERE id = ?').get(info.lastInsertRowid);
}

function heartbeatBotState(db) {
  const currentOpen = db.prepare('SELECT * FROM bot_uptime_logs WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get();
  if (currentOpen) {
    db.prepare(`
      UPDATE bot_uptime_logs
      SET last_heartbeat_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(currentOpen.id);
  }
}

function getBotUptimeStats(db, { limit = 20 } = {}) {
  const current = db.prepare('SELECT * FROM bot_uptime_logs WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get();
  const currentStatus = current ? current.status : 'OFFLINE';
  const startedAt = current ? current.started_at : null;

  let currentDurationSeconds = 0;
  if (current) {
    const durRow = db.prepare("SELECT MAX(0, CAST((strftime('%s', CURRENT_TIMESTAMP) - strftime('%s', ?)) AS INTEGER)) AS dur").get(current.started_at);
    currentDurationSeconds = durRow?.dur || 0;
  }

  const todayRows = db.prepare(`
    SELECT status, started_at, COALESCE(ended_at, CURRENT_TIMESTAMP) AS session_end
    FROM bot_uptime_logs
    WHERE date(COALESCE(ended_at, CURRENT_TIMESTAMP), 'localtime') >= date('now', 'localtime')
       OR date(started_at, 'localtime') >= date('now', 'localtime')
    ORDER BY id ASC
  `).all();

  const midnightRow = db.prepare("SELECT datetime('now', 'start of day', 'utc') AS midnight").get();
  const todayStartTs = midnightRow?.midnight ? new Date(midnightRow.midnight).getTime() : Date.now() - 86400000;
  const nowTs = Date.now();

  let todayOnlineSeconds = 0;
  let todayOfflineSeconds = 0;

  for (const row of todayRows) {
    const rowStart = Math.max(new Date(row.started_at + 'Z').getTime(), todayStartTs);
    const rowEnd = Math.min(new Date(row.session_end + 'Z').getTime(), nowTs);
    const sec = Math.max(0, Math.floor((rowEnd - rowStart) / 1000));
    if (row.status === 'ONLINE') {
      todayOnlineSeconds += sec;
    } else {
      todayOfflineSeconds += sec;
    }
  }

  const totalTrackedToday = todayOnlineSeconds + todayOfflineSeconds;
  const todayUptimePercent = totalTrackedToday > 0
    ? Math.round((todayOnlineSeconds / totalTrackedToday) * 1000) / 10
    : (currentStatus === 'ONLINE' ? 100 : 0);

  const recentLogs = db.prepare(`
    SELECT 
      id,
      status,
      started_at,
      ended_at,
      COALESCE(duration_seconds, MAX(0, CAST((strftime('%s', CURRENT_TIMESTAMP) - strftime('%s', started_at)) AS INTEGER))) AS duration_seconds,
      reason,
      created_at
    FROM bot_uptime_logs
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);

  return {
    currentStatus,
    currentSessionStartedAt: startedAt,
    currentDurationSeconds,
    todayUptimePercent,
    todayOnlineSeconds,
    todayOfflineSeconds,
    recentLogs
  };
}

function addVideoCustomer(db, phone, note = null) {
  if (!db || !phone) return null;
  const cleanPhone = String(phone).replace(/\D/g, '');
  if (!cleanPhone) return null;

  db.prepare(`
    INSERT INTO video_customers (phone_number, note, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(phone_number) DO UPDATE SET
      note = COALESCE(excluded.note, video_customers.note),
      updated_at = CURRENT_TIMESTAMP
  `).run(cleanPhone, note ? String(note).trim() : null);

  return db.prepare('SELECT phone_number, note, created_at, updated_at FROM video_customers WHERE phone_number = ?').get(cleanPhone);
}

function removeVideoCustomer(db, phone) {
  if (!db || !phone) return { phone_number: null, deleted: false };
  const cleanPhone = String(phone).replace(/\D/g, '');
  if (!cleanPhone) return { phone_number: null, deleted: false };

  const candidates = [cleanPhone];
  if (cleanPhone.startsWith('880') && cleanPhone.length === 13) {
    candidates.push(cleanPhone.slice(2));
  } else if (cleanPhone.startsWith('01') && cleanPhone.length === 11) {
    candidates.push(`88${cleanPhone}`);
  }

  const placeholders = candidates.map(() => '?').join(',');
  const res = db.prepare(`DELETE FROM video_customers WHERE phone_number IN (${placeholders})`).run(...candidates);
  return { phone_number: cleanPhone, deleted: res.changes > 0 };
}

function getVideoCustomers(db) {
  if (!db) return [];
  return db.prepare('SELECT phone_number, note, created_at, updated_at FROM video_customers ORDER BY created_at DESC').all();
}

function isVideoCustomer(db, phone) {
  if (!db || !phone) return false;
  const cleanPhone = String(phone).replace(/\D/g, '');
  if (!cleanPhone) return false;

  const candidates = [cleanPhone];
  if (cleanPhone.startsWith('880') && cleanPhone.length === 13) {
    candidates.push(cleanPhone.slice(2));
  } else if (cleanPhone.startsWith('01') && cleanPhone.length === 11) {
    candidates.push(`88${cleanPhone}`);
  }

  const placeholders = candidates.map(() => '?').join(',');

  // 1. Explicit entry in video_customers
  try {
    const explicit = db.prepare(`SELECT 1 AS is_video FROM video_customers WHERE phone_number IN (${placeholders}) LIMIT 1`).get(...candidates);
    if (explicit && (explicit.is_video === 1 || explicit['1'] === 1)) return true;
  } catch {}

  // 2. Pure video transaction history: customer has at least 1 video transaction and 0 voice/audio transactions
  try {
    const stats = db.prepare(`
      SELECT 
        SUM(CASE WHEN LOWER(job_type) = 'video' THEN 1 ELSE 0 END) AS video_count,
        SUM(CASE WHEN LOWER(job_type) IN ('voice', 'audio') THEN 1 ELSE 0 END) AS voice_count
      FROM transactions
      WHERE phone_number IN (${placeholders})
    `).get(...candidates);

    if (stats && Number(stats.video_count) > 0 && Number(stats.voice_count || 0) === 0) {
      return true;
    }
  } catch {}

  return false;
}

function createVoiceJobOrder(db, {
  orderId = null,
  customerPhone,
  customerName = null,
  customerScriptMsgId = null,
  va2ForwardMsgId = null,
  scriptText,
  headline = null
} = {}) {
  if (!db) return null;
  const cleanPhone = String(customerPhone || '').replace(/\D/g, '');
  const finalOrderId = orderId || `VJO-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
  const cleanScript = scriptText != null ? String(scriptText) : '';

  const stmt = db.prepare(`
    INSERT INTO voice_job_orders (
      order_id,
      customer_phone,
      customer_name,
      customer_script_msg_id,
      va2_forward_msg_id,
      script_text,
      headline,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING_VA2')
  `);

  stmt.run(
    finalOrderId,
    cleanPhone,
    customerName,
    customerScriptMsgId,
    va2ForwardMsgId,
    cleanScript,
    headline
  );

  return db.prepare('SELECT * FROM voice_job_orders WHERE order_id = ?').get(finalOrderId) || null;
}

function findVoiceJobOrderByVa2MsgId(db, va2ForwardMsgId) {
  if (!db || !va2ForwardMsgId) return null;
  const idStr = String(va2ForwardMsgId).trim();
  if (!idStr) return null;

  const direct = db.prepare('SELECT * FROM voice_job_orders WHERE va2_forward_msg_id = ? ORDER BY id DESC LIMIT 1').get(idStr);
  if (direct) return direct;

  const bareId = idStr.includes('_') ? idStr.split('_').pop() : idStr;
  const match = db.prepare(`
    SELECT * FROM voice_job_orders 
    WHERE va2_forward_msg_id = ? 
       OR va2_forward_msg_id LIKE '%_' || ?
       OR ? LIKE '%_' || va2_forward_msg_id
    ORDER BY id DESC LIMIT 1
  `).get(bareId, bareId, idStr);
  return match || null;
}

function findVoiceJobOrderByScriptText(db, scriptText) {
  if (!db || !scriptText) return null;
  const trimmed = String(scriptText).trim();
  if (!trimmed) return null;

  return db.prepare(`
    SELECT * FROM voice_job_orders
    WHERE status = 'PENDING_VA2'
      AND length(trim(script_text)) > 0
      AND (
        trim(script_text) = ?
        OR instr(script_text, ?) > 0
        OR instr(?, trim(script_text)) > 0
      )
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(trimmed, trimmed, trimmed) || null;
}

function findLatestPendingVoiceJob(db, { customerPhone } = {}) {
  if (!db) return null;
  if (customerPhone) {
    const cleanPhone = String(customerPhone).replace(/\D/g, '');
    if (cleanPhone) {
      const candidates = [cleanPhone];
      if (cleanPhone.startsWith('880') && cleanPhone.length === 13) {
        candidates.push(cleanPhone.slice(2));
      } else if (cleanPhone.startsWith('01') && cleanPhone.length === 11) {
        candidates.push(`88${cleanPhone}`);
      }
      const placeholders = candidates.map(() => '?').join(',');
      return db.prepare(`
        SELECT * FROM voice_job_orders
        WHERE status = 'PENDING_VA2' AND customer_phone IN (${placeholders})
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get(...candidates) || null;
    }
  }

  return db.prepare(`
    SELECT * FROM voice_job_orders
    WHERE status = 'PENDING_VA2'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get() || null;
}

function updateVoiceJobVa2ForwardMsgId(db, orderId, va2ForwardMsgId) {
  if (!db || !orderId) return { updated: false };
  const res = db.prepare(`
    UPDATE voice_job_orders
    SET va2_forward_msg_id = ?
    WHERE order_id = ?
  `).run(va2ForwardMsgId || null, orderId);
  return { updated: res.changes > 0 };
}

function updateVoiceJobDelivered(db, orderId, {
  va2AudioMsgId = null,
  va2AudioFilename = null,
  finalAudioFilename = null,
  cleanDuration = null,
  cleanDurationSeconds = null,
  originalDuration = null,
  originalDurationSeconds = null,
  cutsCount = null,
  cutsAppliedCount = null,
  modelUsed = null,
  aircheckModelUsed = null
} = {}) {
  if (!db || !orderId) return { updated: false };
  const finalCleanDur = cleanDuration !== null && cleanDuration !== undefined ? cleanDuration : cleanDurationSeconds;
  const finalOrigDur = originalDuration !== null && originalDuration !== undefined ? originalDuration : originalDurationSeconds;
  const finalCuts = cutsCount !== null && cutsCount !== undefined ? cutsCount : (cutsAppliedCount !== null && cutsAppliedCount !== undefined ? cutsAppliedCount : 0);
  const finalModel = modelUsed || aircheckModelUsed || null;

  const res = db.prepare(`
    UPDATE voice_job_orders
    SET status = 'DELIVERED',
        delivered_at = CURRENT_TIMESTAMP,
        va2_audio_msg_id = COALESCE(?, va2_audio_msg_id),
        va2_audio_filename = COALESCE(?, va2_audio_filename),
        final_audio_filename = COALESCE(?, final_audio_filename),
        clean_duration_seconds = COALESCE(?, clean_duration_seconds),
        original_duration_seconds = COALESCE(?, original_duration_seconds),
        cuts_applied_count = COALESCE(?, cuts_applied_count),
        aircheck_model_used = COALESCE(?, aircheck_model_used)
    WHERE order_id = ?
  `).run(
    va2AudioMsgId,
    va2AudioFilename,
    finalAudioFilename,
    finalCleanDur,
    finalOrigDur,
    finalCuts,
    finalModel,
    orderId
  );
  return { updated: res.changes > 0 };
}

function getVoiceJobOrder(db, orderId) {
  if (!db || !orderId) return null;
  return db.prepare('SELECT * FROM voice_job_orders WHERE order_id = ?').get(orderId) || null;
}

const DEFAULT_BOT_SETTINGS = Object.freeze({
  aircheck_enabled: true,
  ai_classifier_enabled: true,
  welcome_demo_enabled: true,
  auto_audio_billing_enabled: true,
  auto_video_billing_enabled: true,
  default_video_bill_amount: 350,
  video_customer_escalation_enabled: true,
  ve3_escalation_enabled: true
});

function parseSettingValue(rawVal) {
  if (rawVal === 'true' || rawVal === '1') return true;
  if (rawVal === 'false' || rawVal === '0') return false;
  try {
    return JSON.parse(rawVal);
  } catch (_) {
    return rawVal;
  }
}

function getBotSetting(db, key, defaultValue = null) {
  if (!key || typeof key !== 'string') {
    return defaultValue;
  }
  const cleanKey = key.trim();
  if (!cleanKey) {
    return defaultValue;
  }
  if (!db || typeof db.prepare !== 'function') {
    return (cleanKey in DEFAULT_BOT_SETTINGS) ? DEFAULT_BOT_SETTINGS[cleanKey] : defaultValue;
  }
  try {
    const row = db.prepare('SELECT value FROM bot_settings WHERE key = ?').get(cleanKey);
    if (row && row.value !== undefined && row.value !== null) {
      return parseSettingValue(row.value);
    }
  } catch (err) {
    return (cleanKey in DEFAULT_BOT_SETTINGS) ? DEFAULT_BOT_SETTINGS[cleanKey] : defaultValue;
  }
  return (cleanKey in DEFAULT_BOT_SETTINGS) ? DEFAULT_BOT_SETTINGS[cleanKey] : defaultValue;
}

function setBotSetting(db, key, value) {
  if (!db || typeof db.prepare !== 'function') {
    return null;
  }
  if (!key || typeof key !== 'string') {
    return null;
  }
  const cleanKey = key.trim();
  if (!cleanKey) {
    return null;
  }
  const strVal = (typeof value === 'object' && value !== null) ? JSON.stringify(value) : String(value);
  try {
    const stmt = db.prepare(`
      INSERT INTO bot_settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(cleanKey, strVal);
    return {
      key: cleanKey,
      value: getBotSetting(db, cleanKey)
    };
  } catch (err) {
    return null;
  }
}

function getAllBotSettings(db, defaults = DEFAULT_BOT_SETTINGS) {
  const baseDefaults = (defaults && typeof defaults === 'object') ? defaults : DEFAULT_BOT_SETTINGS;
  const settings = { ...baseDefaults };
  if (!db || typeof db.prepare !== 'function') {
    return settings;
  }
  try {
    const rows = db.prepare('SELECT key, value FROM bot_settings').all();
    for (const row of rows) {
      if (row && row.key) {
        settings[row.key] = parseSettingValue(row.value);
      }
    }
  } catch (err) {
    return settings;
  }
  return settings;
}

function savePendingConfirmation(db, {
  customerPhone,
  script,
  customerName = null,
  customerScriptMsgId = null,
  timeoutMs = 300000,
  askedAt = Date.now()
}) {
  if (!db || !customerPhone) return null;
  const cleanPhone = String(customerPhone).replace(/\D/g, '');
  if (!cleanPhone) return null;

  try {
    const stmt = db.prepare(`
      INSERT INTO pending_confirmations (
        customer_phone, script, customer_name, customer_script_msg_id, timeout_ms, asked_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(customer_phone) DO UPDATE SET
        script = excluded.script,
        customer_name = excluded.customer_name,
        customer_script_msg_id = excluded.customer_script_msg_id,
        timeout_ms = excluded.timeout_ms,
        asked_at = excluded.asked_at,
        created_at = CURRENT_TIMESTAMP
    `);
    stmt.run(cleanPhone, script, customerName, customerScriptMsgId, timeoutMs, askedAt);
    return {
      customerPhone: cleanPhone,
      script,
      customerName,
      customerScriptMsgId,
      timeoutMs,
      askedAt
    };
  } catch (err) {
    console.warn('[DB] Error saving pending confirmation:', err.message);
    return null;
  }
}

function getPendingConfirmationFromDb(db, customerPhone) {
  if (!db || !customerPhone) return null;
  const cleanPhone = String(customerPhone).replace(/\D/g, '');
  if (!cleanPhone) return null;

  try {
    const row = db.prepare(`
      SELECT customer_phone, script, customer_name, customer_script_msg_id, timeout_ms, asked_at
      FROM pending_confirmations
      WHERE customer_phone = ?
    `).get(cleanPhone);
    if (!row) return null;

    // Check expiration
    const now = Date.now();
    if (now - row.asked_at > row.timeout_ms) {
      removePendingConfirmationFromDb(db, cleanPhone);
      return null;
    }

    return {
      customerPhone: row.customer_phone,
      script: row.script,
      customerName: row.customer_name,
      customerScriptMsgId: row.customer_script_msg_id,
      timeoutMs: row.timeout_ms,
      askedAt: row.asked_at
    };
  } catch (err) {
    return null;
  }
}

function removePendingConfirmationFromDb(db, customerPhone) {
  if (!db || !customerPhone) return false;
  const cleanPhone = String(customerPhone).replace(/\D/g, '');
  if (!cleanPhone) return false;

  try {
    const res = db.prepare('DELETE FROM pending_confirmations WHERE customer_phone = ?').run(cleanPhone);
    return res.changes > 0;
  } catch (err) {
    return false;
  }
}

function getAllPendingConfirmationsFromDb(db) {
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT customer_phone, script, customer_name, customer_script_msg_id, timeout_ms, asked_at
      FROM pending_confirmations
    `).all();
    const now = Date.now();
    return rows.filter(r => (now - r.asked_at) <= r.timeout_ms).map(r => ({
      customerPhone: r.customer_phone,
      script: r.script,
      customerName: r.customer_name,
      customerScriptMsgId: r.customer_script_msg_id,
      timeoutMs: r.timeout_ms,
      askedAt: r.asked_at
    }));
  } catch {
    return [];
  }
}

function cacheStaffLid(db, staffRole, phone, lid) {
  if (!db || !staffRole || !lid) return false;
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  const cleanLid = String(lid).trim();
  try {
    const stmt = db.prepare(`
      INSERT INTO staff_lids (staff_role, phone_number, lid, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(staff_role) DO UPDATE SET
        phone_number = excluded.phone_number,
        lid = excluded.lid,
        updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(staffRole.toUpperCase(), cleanPhone, cleanLid);
    return true;
  } catch (err) {
    console.warn('[DB] Error caching staff LID:', err.message);
    return false;
  }
}

function getCachedStaffLid(db, staffRole) {
  if (!db || !staffRole) return null;
  try {
    const row = db.prepare('SELECT phone_number, lid FROM staff_lids WHERE staff_role = ?').get(staffRole.toUpperCase());
    return row ? row.lid : null;
  } catch {
    return null;
  }
}

function getAllCachedStaffLids(db) {
  if (!db) return [];
  try {
    return db.prepare('SELECT staff_role, phone_number, lid FROM staff_lids').all() || [];
  } catch {
    return [];
  }
}

function recordSystemAlert(db, { alertType, context, errorMessage, logDetails, recipient, sentStatus = 'SENT' } = {}) {
  if (!db) return null;
  try {
    const stmt = db.prepare(`
      INSERT INTO system_alerts (alert_type, context, error_message, log_details, recipient, sent_status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const res = stmt.run(
      alertType || 'SYSTEM_ERROR',
      context || null,
      errorMessage ? String(errorMessage).slice(0, 1000) : null,
      logDetails ? String(logDetails).slice(0, 4000) : null,
      recipient || null,
      sentStatus
    );
    return { id: res.lastInsertRowid };
  } catch (err) {
    console.warn('[DB] Failed recording system alert:', err.message);
    return null;
  }
}

function getRecentSystemAlerts(db, limit = 20) {
  if (!db) return [];
  try {
    return db.prepare('SELECT * FROM system_alerts ORDER BY id DESC LIMIT ?').all(limit);
  } catch {
    return [];
  }
}

function saveWhatsappCustomerNote(db, phone, note) {
  if (!db || !phone) return null;
  const cleanPhone = String(phone).replace(/\D/g, '');
  if (!cleanPhone) return null;
  const trimmedNote = String(note || '').trim();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO whatsapp_customer_notes (phone, note, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      note = excluded.note,
      updated_at = excluded.updated_at
  `).run(cleanPhone, trimmedNote, now);
  return { phone: cleanPhone, note: trimmedNote, updated_at: now };
}

function getWhatsappCustomerNotes(db) {
  if (!db) return [];
  try {
    return db.prepare('SELECT phone, note, updated_at FROM whatsapp_customer_notes').all();
  } catch {
    return [];
  }
}

function getWhatsappCustomerNote(db, phone) {
  if (!db || !phone) return null;
  const cleanPhone = String(phone).replace(/\D/g, '');
  if (!cleanPhone) return null;
  try {
    return db.prepare('SELECT phone, note, updated_at FROM whatsapp_customer_notes WHERE phone = ?').get(cleanPhone) || null;
  } catch {
    return null;
  }
}

module.exports = {
  initDb,
  saveWhatsappCustomerNote,
  getWhatsappCustomerNotes,
  getWhatsappCustomerNote,
  recordTransaction,
  recordLead,
  recordExistingContact,
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
  recordBotState,
  heartbeatBotState,
  recoverUngracefulShutdown,
  getBotUptimeStats,
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
  getVoiceJobOrder,
  DEFAULT_BOT_SETTINGS,
  getBotSetting,
  setBotSetting,
  getAllBotSettings,
  savePendingConfirmation,
  getPendingConfirmationFromDb,
  removePendingConfirmationFromDb,
  getAllPendingConfirmationsFromDb,
  cacheStaffLid,
  getCachedStaffLid,
  getAllCachedStaffLids,
  recordSystemAlert,
  getRecentSystemAlerts
};
