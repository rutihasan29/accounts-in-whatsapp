const Database = require('better-sqlite3');

function initCrmDb(db) {
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_callers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      pin TEXT NOT NULL,
      status TEXT DEFAULT 'offline' CHECK(status IN ('active', 'break', 'offline')),
      shift_schedule_json TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS crm_leads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone_number TEXT NOT NULL UNIQUE,
      source TEXT DEFAULT 'whatsapp',
      status TEXT DEFAULT 'fresh' CHECK(status IN ('fresh', 'in_progress', 'callback_set', 'unreachable', 'won', 'lost')),
      assigned_caller_id TEXT REFERENCES crm_callers(id),
      claimed_at DATETIME,
      assignment_expires_at DATETIME,
      speed_to_lead_seconds INTEGER,
      sla_status TEXT CHECK(sla_status IN ('met_sla', 'breached_sla')),
      next_callback_at DATETIME,
      retry_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS crm_lead_assignments (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL REFERENCES crm_leads(id),
      caller_id TEXT NOT NULL REFERENCES crm_callers(id),
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'assigned' CHECK(status IN ('assigned', 'claimed', 'timed_out', 'rejected')),
      claimed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS crm_call_logs (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL REFERENCES crm_leads(id),
      caller_id TEXT NOT NULL REFERENCES crm_callers(id),
      disposition TEXT NOT NULL,
      call_notes TEXT,
      callback_scheduled_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS crm_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

function createCaller(db, { id, name, pin, shift_schedule_json = '{}' }) {
  const stmt = db.prepare(`
    INSERT INTO crm_callers (id, name, pin, status, shift_schedule_json)
    VALUES (?, ?, ?, 'offline', ?)
  `);
  stmt.run(id, name, pin, shift_schedule_json);
  return getCallerById(db, id);
}

function getCallerById(db, callerId) {
  return db.prepare('SELECT * FROM crm_callers WHERE id = ?').get(callerId);
}

function updateCallerStatus(db, callerId, status) {
  db.prepare('UPDATE crm_callers SET status = ? WHERE id = ?').run(status, callerId);
  return getCallerById(db, callerId);
}

function insertLead(db, { id, name, phone_number, source = 'whatsapp', created_at = null }) {
  const existing = db.prepare('SELECT id FROM crm_leads WHERE phone_number = ?').get(phone_number);
  if (existing) {
    db.prepare(`
      UPDATE crm_leads
      SET name = COALESCE(?, name), status = 'fresh', assignment_expires_at = NULL, claimed_at = NULL
      WHERE id = ?
    `).run(name, existing.id);
    return getLeadById(db, existing.id);
  }

  if (created_at) {
    const stmt = db.prepare(`
      INSERT INTO crm_leads (id, name, phone_number, source, status, created_at)
      VALUES (?, ?, ?, ?, 'fresh', ?)
    `);
    stmt.run(id, name, phone_number, source, created_at);
  } else {
    const stmt = db.prepare(`
      INSERT INTO crm_leads (id, name, phone_number, source, status)
      VALUES (?, ?, ?, ?, 'fresh')
    `);
    stmt.run(id, name, phone_number, source);
  }
  return getLeadById(db, id);
}

function getLeadById(db, leadId) {
  return db.prepare('SELECT * FROM crm_leads WHERE id = ?').get(leadId);
}

function getSetting(db, key, defaultValue = null) {
  const row = db.prepare('SELECT value FROM crm_settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

function setSetting(db, key, value) {
  db.prepare(`
    INSERT INTO crm_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

module.exports = {
  initCrmDb,
  createCaller,
  getCallerById,
  updateCallerStatus,
  insertLead,
  getLeadById,
  getSetting,
  setSetting
};
