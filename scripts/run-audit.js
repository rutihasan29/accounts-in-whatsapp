#!/usr/bin/env node
/**
 * Standalone Production & Job Auditor
 * 
 * Audits client chats using Media File Delivery & Durations as GROUND TRUTH.
 * Identifies:
 *   - Confirmed Billed Jobs
 *   - Unbilled Leakage (Delivered audio/video without staff billing)
 *   - Typo / Abnormal Bills
 * 
 * Usage:
 *   npm run audit
 *   node scripts/run-audit.js [--file=path/to/chats.json]
 */

const fs = require('fs');
const path = require('path');
const { initDb } = require('../src/db');
const { auditChatBatchWithLlm, auditChatsDeterministic, initAuditDb } = require('../src/auditor');
const config = require('../src/config');

async function main() {
  const args = process.argv.slice(2);
  let chatsFile = null;

  for (const arg of args) {
    if (arg.startsWith('--file=')) {
      chatsFile = arg.split('=')[1];
    }
  }

  // Look for extracted chat files if not specified
  if (!chatsFile) {
    const defaultPaths = [
      'C:/Users/ASUS/.gemini/antigravity-cli/brain/e2efe527-a091-4c47-8987-e835c828fac5/scratch/all_target_chat_messages.json',
      path.join(__dirname, '../data/all_target_chat_messages.json'),
      path.join(__dirname, '../data/whatsapp_nov1_contacts_final.json')
    ];
    for (const p of defaultPaths) {
      if (fs.existsSync(p)) {
        chatsFile = p;
        break;
      }
    }
  }

  console.log(`\n🔍 [AUDITOR] Starting Ground-Truth Job Audit...`);
  console.log(`[AUDITOR] Rule: Delivered media (audio/video duration) is Primary Truth.`);

  const db = initDb(config.DB_PATH);
  initAuditDb(db);

  let rawChats = [];
  if (chatsFile && fs.existsSync(chatsFile)) {
    console.log(`[AUDITOR] Loading chats from: ${chatsFile}`);
    try {
      rawChats = JSON.parse(fs.readFileSync(chatsFile, 'utf8'));
    } catch (e) {
      console.warn(`[AUDITOR] Failed reading ${chatsFile}:`, e.message);
    }
  } else {
    console.log(`[AUDITOR] No external chat dump found. Inspecting SQLite live logs...`);
  }

  // If rawChats is an array of chats with messages
  if (Array.isArray(rawChats) && rawChats.length > 0 && rawChats[0].messages) {
    console.log(`[AUDITOR] Auditing ${rawChats.length} client chats in batches of 20...`);

    const BATCH_SIZE = 20;
    let totalAudited = 0;
    let totalJobsFound = 0;
    let totalUnbilled = 0;

    const upsertStmt = db.prepare(`
      INSERT INTO job_audit_logs (phone_number, jobs_delivered, total_billed, unbilled_leakage, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    for (let i = 0; i < rawChats.length; i += BATCH_SIZE) {
      const batch = rawChats.slice(i, i + BATCH_SIZE);
      console.log(`  Processing batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} clients)...`);

      // Audit batch
      const auditResult = await auditChatBatchWithLlm(batch, {
        apiKey: config.GEMINI_API_KEY
      });

      const results = auditResult.results || [];
      const runSave = db.transaction(() => {
        for (const r of results) {
          upsertStmt.run(
            r.phone,
            r.jobs_delivered || 0,
            r.total_billed || 0,
            r.unbilled_leakage_amount || 0,
            JSON.stringify(r.jobs || [])
          );
          totalAudited++;
          totalJobsFound += (r.jobs_delivered || 0);
          totalUnbilled += (r.unbilled_leakage_amount || 0);
        }
      });
      runSave();
    }

    console.log(`\n✅ [AUDITOR COMPLETE]`);
    console.log(`  - Total Clients Audited: ${totalAudited}`);
    console.log(`  - Total Completed Jobs (via Media): ${totalJobsFound}`);
    console.log(`  - Unbilled Staff Leakage: ${totalUnbilled} BDT`);
  } else {
    console.log(`[AUDITOR] No raw chat history found to batch audit.`);
    console.log(`[AUDITOR] To audit a chat dump, run: node scripts/run-audit.js --file=path/to/chats.json`);
  }

  try {
    db.close();
  } catch {}
}

if (require.main === module) {
  main();
}
