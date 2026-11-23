#!/usr/bin/env node
/**
 * Standalone CLI script to sync Meta / Facebook Ads spend to SQLite database.
 * 
 * Usage:
 *   node scripts/sync-fb-ads.js
 *   node scripts/sync-fb-ads.js --preset=today
 *   node scripts/sync-fb-ads.js --preset=last_30d
 * 
 * PRIVACY: All outputs are console-only for the owner. Never sent to WhatsApp.
 */

const { initDb } = require('../src/db');
const { syncAdSpendToDb } = require('../src/fb-ads');
const config = require('../src/config');

async function main() {
  const args = process.argv.slice(2);
  let datePreset = 'this_month';

  for (const arg of args) {
    if (arg.startsWith('--preset=')) {
      datePreset = arg.split('=')[1];
    }
  }

  console.log(`[Meta Ads Sync] Starting sync for preset: '${datePreset}'...`);
  console.log(`[Meta Ads Sync] Account: ${config.FB_AD_ACCOUNT_ID}, USD/BDT Rate: ${config.USD_TO_BDT_RATE}`);

  const db = initDb(config.DB_PATH);

  try {
    const result = await syncAdSpendToDb(db, { datePreset });
    console.log(`[Meta Ads Sync] SUCCESS!`);
    console.log(`  - Synced Days: ${result.syncedDays}`);
    console.log(`  - Total Spend (USD): $${result.totalSpendUSD}`);
    console.log(`  - Total Spend (BDT): ${result.totalSpendBDT} BDT`);
    console.log(`  - Total Messaging Chats: ${result.totalConversations}`);
    console.log(`  - Avg Cost Per Chat (CPL): ${result.avgCplBDT ? result.avgCplBDT + ' BDT' : 'N/A'}`);
    console.log('\nRecent Days:');
    result.days.slice(-5).forEach(d => {
      console.log(`  ${d.date}: $${d.spendUSD.toFixed(2)} (${d.spendBDT} BDT) -> ${d.chats} chats`);
    });
  } catch (err) {
    console.error(`[Meta Ads Sync] FAILED:`, err.message);
    process.exit(1);
  } finally {
    try {
      db.close();
    } catch {}
  }
}

if (require.main === module) {
  main();
}
