#!/usr/bin/env node
/**
 * Instant Executive KPI & ROI Dashboard for Termux / CLI
 * 
 * Usage:
 *   npm run kpi
 *   npm run kpi -- --weekly
 *   npm run kpi -- --monthly
 *   npm run kpi -- --daily
 * 
 * STRICT PRIVACY: Console-only for the business owner. NEVER sent to WhatsApp.
 */

const { initDb } = require('../src/db');
const { getBusinessKpiReport } = require('../src/metrics');
const config = require('../src/config');

function formatCurrency(num) {
  if (num === null || num === undefined) return 'N/A';
  return `${Number(num).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 1 })} BDT`;
}

function formatGrowth(pct) {
  if (pct === null || pct === undefined) return '';
  const prefix = pct > 0 ? '+' : '';
  return `(${prefix}${pct}%)`;
}

function printSection(title, current, previous, labelCur = 'Current', labelPrev = 'Previous') {
  console.log(`\n================== [ ${title.toUpperCase()} ] ==================`);
  console.log(`Metric                     | ${labelCur.padEnd(14)} | ${labelPrev.padEnd(14)}`);
  console.log(`---------------------------+----------------+---------------`);
  console.log(`Meta Ad Spend              | ${formatCurrency(current.adSpend).padEnd(14)} | ${formatCurrency(previous.adSpend).padEnd(14)}`);
  console.log(`Billed Revenue             | ${formatCurrency(current.billedRevenue).padEnd(14)} | ${formatCurrency(previous.billedRevenue).padEnd(14)}`);
  console.log(`Paid Revenue               | ${formatCurrency(current.paidRevenue).padEnd(14)} | ${formatCurrency(previous.paidRevenue).padEnd(14)}`);
  console.log(`Gross Profit (60%/34%)     | ${formatCurrency(current.grossProfit).padEnd(14)} | ${formatCurrency(previous.grossProfit).padEnd(14)}`);
  console.log(`Jobs Delivered             | ${String(current.jobsCount).padEnd(14)} | ${String(previous.jobsCount).padEnd(14)}`);
  console.log(`Leads / Inquiries          | ${String(current.totalLeads).padEnd(14)} | ${String(previous.totalLeads).padEnd(14)}`);
  console.log(`Converted Clients          | ${String(current.convertedClients).padEnd(14)} | ${String(previous.convertedClients).padEnd(14)}`);
  console.log(`Cost Per Lead (CPL)        | ${current.cpl ? formatCurrency(current.cpl).padEnd(14) : 'N/A           '} | ${previous.cpl ? formatCurrency(previous.cpl).padEnd(14) : 'N/A           '}`);
  console.log(`Customer Acq Cost (CAC)    | ${current.cac ? formatCurrency(current.cac).padEnd(14) : 'N/A           '} | ${previous.cac ? formatCurrency(previous.cac).padEnd(14) : 'N/A           '}`);
  console.log(`ROAS (Rev / Ad Spend)      | ${(current.roas + 'x').padEnd(14)} | ${(previous.roas + 'x').padEnd(14)}`);
  console.log(`Net ROI %                  | ${(current.netRoiPercent + '%').padEnd(14)} | ${(previous.netRoiPercent + '%').padEnd(14)}`);

  if (current.unbilledLeakage > 0) {
    console.log(`\n⚠️  REVENUE LEAKAGE ALERT: ${formatCurrency(current.unbilledLeakage)} unbilled work delivered without bills!`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const showDaily = args.includes('--daily');
  const showWeekly = args.includes('--weekly');
  const showMonthly = args.includes('--monthly');
  const showAll = !showDaily && !showWeekly && !showMonthly;

  const db = initDb(config.DB_PATH);

  try {
    const report = getBusinessKpiReport(db);

    console.log(`\n📊 EXECUTIVE KPI & ROI REPORT — ${new Date().toLocaleDateString('en-GB')}`);
    console.log(`Generated: ${new Date().toLocaleTimeString()} | DB: ${config.DB_PATH}`);

    if (showAll || showDaily) {
      printSection('Daily Performance', report.daily.today, report.daily.yesterday, 'Today', 'Yesterday');
    }

    if (showAll || showWeekly) {
      printSection('Weekly Performance (7 Days)', report.weekly.thisWeek, report.weekly.lastWeek, 'This Week', 'Last Week');
    }

    if (showAll || showMonthly) {
      printSection('Monthly Performance (Calendar Month)', report.monthly.thisMonth, report.monthly.lastMonth, 'This Month', 'Last Month');
    }

    console.log('\n=============================================================');
    console.log(`💡 Pro-tip: Run 'npm run audit' to inspect unbilled staff leakage.`);
    console.log(`🔒 Data is private and never broadcast to WhatsApp.\n`);
  } catch (err) {
    console.error('Failed generating KPI report:', err.message);
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
