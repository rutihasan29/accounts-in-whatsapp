#!/usr/bin/env node
/**
 * CLI Tool: Sync Chat Transcripts to Dedicated Metrics SQLite Tables
 * 
 * Traverses client message streams and delivered media from WhatsApp transcripts,
 * detects billing and unbilled leakage, and updates:
 *   - metrics_chat_clients
 *   - metrics_chat_jobs
 *   - metrics_chat_events
 * 
 * ZERO impact on existing billing transactions table.
 */

const { initDb } = require('../src/db');
const { DB_PATH } = require('../src/config');
const { syncChatMetricsToDb } = require('../src/metrics-traverser');

console.log('[METRICS-SYNC] Initializing database at:', DB_PATH);
const db = initDb(DB_PATH);

console.log('[METRICS-SYNC] Starting chat traversal and synchronization...');
const startTime = Date.now();
const result = syncChatMetricsToDb(db, { cleanSync: true });
const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

console.log('----------------------------------------');
console.log(`[METRICS-SYNC] Sync completed in ${elapsed}s`);
console.log(`Status:        ${result.status}`);
console.log(`Clients:       ${result.totalClients}`);
console.log(`Delivered Jobs: ${result.totalJobs}`);
console.log(`Billed (BDT):  ${result.totalBilled}`);
console.log(`Leakage (BDT): ${result.totalUnbilled}`);
console.log('----------------------------------------');

if (require.main === module) {
  process.exit(0);
}
