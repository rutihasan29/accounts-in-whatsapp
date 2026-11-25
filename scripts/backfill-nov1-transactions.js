const fs = require('fs');
const { initDb } = require('../src/db');
const config = require('../src/config');

const db = initDb(config.DB_PATH);

const nov1Path = 'C:/Users/ASUS/.gemini/antigravity-cli/brain/e2efe527-a091-4c47-8987-e835c828fac5/scratch/nov1_client_jobs.json';
const nov1 = JSON.parse(fs.readFileSync(nov1Path, 'utf8'));

console.log(`Inspecting ${nov1.length} clients in nov1_client_jobs.json...`);

let insertedCust = 0;
let insertedLeads = 0;
let insertedTx = 0;

const insertCust = db.prepare(`
  INSERT INTO customers (phone_number, name)
  VALUES (?, ?)
  ON CONFLICT(phone_number) DO UPDATE SET name = COALESCE(excluded.name, customers.name)
`);

const insertLead = db.prepare(`
  INSERT INTO leads (phone_number, name, status, first_contact_at, first_job_delivered_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(phone_number) DO UPDATE SET
    first_contact_at = COALESCE(leads.first_contact_at, excluded.first_contact_at),
    first_job_delivered_at = COALESCE(leads.first_job_delivered_at, excluded.first_job_delivered_at),
    status = excluded.status
`);

const insertTx = db.prepare(`
  INSERT INTO transactions (phone_number, type, amount, raw_text, created_at, message_id, job_type, duration_seconds)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const existingTx = new Set(
  db.prepare("SELECT phone_number || '_' || created_at as k FROM transactions").all().map(r => r.k)
);

db.transaction(() => {
  nov1.forEach(c => {
    const phone = c.phone;
    const name = c.name || `Client ${phone}`;
    insertCust.run(phone, name);
    insertedCust++;

    // First contact & first job delivered
    const firstContact = c.first_contact_at || '2026-11-01 00:00:00';
    let firstJobTime = null;
    const voiceJobs = c.voice_jobs_detail || [];
    if (voiceJobs.length > 0 && voiceJobs[0].created_at) {
      firstJobTime = voiceJobs[0].created_at;
    }

    insertLead.run(phone, name, 'CONVERTED', firstContact, firstJobTime);
    insertedLeads++;

    // Transactions (Bills)
    voiceJobs.forEach(j => {
      const txKey = `${phone}_${j.created_at}`;
      if (!existingTx.has(txKey)) {
        insertTx.run(
          phone,
          j.type || 'BILL',
          j.amount || 50,
          j.raw_text || `বিল ${j.amount} টাকা`,
          j.created_at,
          j.message_id || null,
          j.job_type || 'voice',
          j.duration_seconds || null
        );
        existingTx.add(txKey);
        insertedTx++;
      }
    });
  });
})();

console.log(`Backfilled: ${insertedCust} customers, ${insertedLeads} leads, ${insertedTx} transactions.`);
