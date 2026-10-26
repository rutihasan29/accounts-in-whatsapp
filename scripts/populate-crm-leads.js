const Database = require('better-sqlite3');
const path = require('path');
const { DB_PATH, VA2_PHONE, VE3_PHONE } = require('../src/config');
const { initCrmDb } = require('../src/crm/db');

function populateCrmLeads(dbPath = null) {
  const targetPath = dbPath || DB_PATH || path.join(__dirname, '..', 'data', 'ledger.db');
  console.log(`📂 Opening database: ${targetPath}`);

  const db = new Database(targetPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Ensure CRM schema exists
  initCrmDb(db);

  // Fetch active callers
  const callers = db.prepare("SELECT id FROM crm_callers WHERE status = 'active' ORDER BY id ASC").all();
  if (callers.length === 0) {
    console.warn('⚠️ No active callers found in crm_callers. Leads will be imported unassigned.');
  }

  // Identify staff phones to exclude
  const excludedPhones = new Set([
    VA2_PHONE ? VA2_PHONE.replace(/\D/g, '') : null,
    VE3_PHONE ? VE3_PHONE.replace(/\D/g, '') : null
  ].filter(Boolean));

  // Query all bot leads
  const botLeads = db.prepare(`
    SELECT phone_number, name, status, first_contact_at, created_at
    FROM leads
    ORDER BY created_at DESC
  `).all();

  console.log(`🔍 Found ${botLeads.length} leads in bot leads table.`);

  let insertedCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  const insertStmt = db.prepare(`
    INSERT INTO crm_leads (
      id, name, phone_number, source, status, assigned_caller_id, created_at
    ) VALUES (
      ?, ?, ?, 'whatsapp_bot', ?, ?, ?
    )
    ON CONFLICT(phone_number) DO UPDATE SET
      name = COALESCE(excluded.name, crm_leads.name),
      status = CASE
        WHEN crm_leads.status IN ('won', 'lost') THEN crm_leads.status
        ELSE excluded.status
      END
  `);

  const runSync = db.transaction(() => {
    let callerIndex = 0;

    for (const lead of botLeads) {
      const rawPhone = String(lead.phone_number || '').trim();
      const cleanDigits = rawPhone.replace(/\D/g, '');

      // Exclude invalid, group JIDs, or staff phones
      if (!cleanDigits || cleanDigits.startsWith('12036') || cleanDigits.length > 15 || cleanDigits.length < 9) {
        skippedCount++;
        continue;
      }
      if (excludedPhones.has(cleanDigits)) {
        skippedCount++;
        continue;
      }

      const formattedPhone = `+${cleanDigits}`;
      const leadName = lead.name && !lead.name.startsWith('+') ? lead.name : 'WhatsApp Contact';

      // Map bot status to CRM status
      let crmStatus = 'in_progress';
      if (lead.status === 'CONVERTED') {
        crmStatus = 'won';
      } else if (lead.status === 'PENDING') {
        crmStatus = 'fresh';
      } else {
        crmStatus = 'in_progress'; // Existing chat follow-ups
      }

      // Assign to caller round-robin
      let assignedCallerId = null;
      if (callers.length > 0) {
        assignedCallerId = callers[callerIndex % callers.length].id;
        callerIndex++;
      }

      const crmLeadId = 'lead_' + cleanDigits;
      const createdAt = lead.created_at || lead.first_contact_at || new Date().toISOString();

      const result = insertStmt.run(crmLeadId, leadName, formattedPhone, crmStatus, assignedCallerId, createdAt);
      if (result.changes > 0) {
        insertedCount++;
      }
    }
  });

  runSync();

  console.log('\n====================================================');
  console.log('✅ CRM POPULATION COMPLETED:');
  console.log(`   > Processed:   ${insertedCount} leads synced into crm_leads`);
  console.log(`   > Skipped:     ${skippedCount} (groups / staff / invalid numbers)`);
  console.log('====================================================\n');

  // Breakdown in crm_leads
  const summary = db.prepare('SELECT status, COUNT(*) as count FROM crm_leads GROUP BY status').all();
  console.log('📊 Current CRM Leads by Status:');
  summary.forEach(s => console.log(`   - ${s.status}: ${s.count}`));

  return { insertedCount, skippedCount, summary };
}

// Direct execution CLI support
if (require.main === module) {
  try {
    populateCrmLeads();
  } catch (err) {
    console.error('❌ Error populating CRM leads:', err);
    process.exit(1);
  }
}

module.exports = { populateCrmLeads };
