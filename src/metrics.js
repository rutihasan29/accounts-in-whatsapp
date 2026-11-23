/**
 * Unified KPI & ROI Analytics Engine
 * 
 * Aggregates:
 * 1. Meta Ad Spend (USD & BDT) from `ad_spend` table.
 * 2. Revenue, Bills, Payments from `transactions` table.
 * 3. Leads and Conversions from `leads` table.
 * 4. Production Jobs from `voice_job_orders` and `job_audit_logs`.
 * 5. Unit Economics: CAC, CPL, ROAS, Net ROI %, Gross Profit (60% Voice, 34% Video).
 * 
 * STRICT PRIVACY: ZERO financial data sent to WhatsApp.
 */

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

/**
 * Fetch and calculate metrics for a specific date filter.
 */
function getPeriodMetrics(db, dateCondition) {
  // 1. Ad Spend
  const adSpendCond = dateCondition.replace(/created_at/g, 'spend_date');
  const adRow = db.prepare(`
    SELECT 
      COALESCE(SUM(amount), 0) AS total_ad_spend,
      COUNT(spend_date) AS days_with_ads
    FROM ad_spend
    WHERE ${adSpendCond}
  `).get();
  const adSpend = Math.round((adRow?.total_ad_spend || 0) * 100) / 100;

  // 2. Transactions & Jobs
  const txRows = db.prepare(`
    SELECT type, amount, job_type
    FROM transactions
    WHERE ${dateCondition}
  `).all();

  let billedRevenue = 0;
  let paidRevenue = 0;
  let jobsCount = 0;
  let grossProfit = 0;

  for (const tx of txRows) {
    if (tx.type === 'BILL') {
      billedRevenue += tx.amount;
      jobsCount++;
      grossProfit += tx.amount * getProfitMargin(tx.job_type);
    } else if (tx.type === 'PAYMENT') {
      paidRevenue += tx.amount;
    }
  }

  billedRevenue = Math.round(billedRevenue * 100) / 100;
  paidRevenue = Math.round(paidRevenue * 100) / 100;
  grossProfit = Math.round(grossProfit * 100) / 100;

  // 3. Leads & Conversions
  const leadsCond = dateCondition.replace(/created_at/g, 'first_contact_at');
  const leadsRow = db.prepare(`
    SELECT COUNT(*) AS total_leads
    FROM leads
    WHERE ${leadsCond}
  `).get();
  const totalLeads = leadsRow?.total_leads || 0;

  const convCond = dateCondition.replace(/created_at/g, 'first_job_delivered_at');
  const convRow = db.prepare(`
    SELECT COUNT(*) AS converted_clients
    FROM leads
    WHERE status = 'CONVERTED' AND ${convCond}
  `).get();
  const convertedClients = convRow?.converted_clients || 0;

  // 4. Unit Economics
  const cpl = totalLeads > 0 ? Math.round((adSpend / totalLeads) * 100) / 100 : null;
  const cac = convertedClients > 0 ? Math.round((adSpend / convertedClients) * 100) / 100 : null;
  const roas = adSpend > 0 ? Math.round((billedRevenue / adSpend) * 100) / 100 : (billedRevenue > 0 ? 99.9 : 0);
  const netProfit = Math.round((grossProfit - adSpend) * 100) / 100;
  const netRoiPercent = adSpend > 0 ? Math.round(((grossProfit - adSpend) / adSpend) * 1000) / 10 : (grossProfit > 0 ? 100 : 0);

  // 5. Unbilled Leakage (if job_audit_logs exists)
  let unbilledLeakage = 0;
  try {
    const auditCond = dateCondition.replace(/created_at/g, 'audit_date');
    const leakRow = db.prepare(`SELECT SUM(unbilled_leakage) as leak FROM job_audit_logs WHERE ${auditCond}`).get();
    unbilledLeakage = Math.round((leakRow?.leak || 0) * 100) / 100;
  } catch {}

  return {
    adSpend,
    billedRevenue,
    paidRevenue,
    grossProfit,
    netProfit,
    jobsCount,
    totalLeads,
    convertedClients,
    cpl,
    cac,
    roas,
    netRoiPercent,
    unbilledLeakage
  };
}

/**
 * Returns comprehensive Daily, Weekly, and Monthly business health metrics.
 */
function getBusinessKpiReport(db) {
  // Daily: Today vs Yesterday
  const today = getPeriodMetrics(db, "date(created_at, 'localtime') = date('now', 'localtime')");
  const yesterday = getPeriodMetrics(db, "date(created_at, 'localtime') = date('now', 'localtime', '-1 day')");

  // Weekly: Current 7 days vs Previous 7 days
  const thisWeek = getPeriodMetrics(db, "date(created_at, 'localtime') >= date('now', 'localtime', '-6 days')");
  const lastWeek = getPeriodMetrics(db, "date(created_at, 'localtime') >= date('now', 'localtime', '-13 days') AND date(created_at, 'localtime') < date('now', 'localtime', '-6 days')");

  // Monthly: Current calendar month vs Previous calendar month
  const thisMonth = getPeriodMetrics(db, "strftime('%Y-%m', created_at, 'localtime') = strftime('%Y-%m', 'now', 'localtime')");
  const lastMonth = getPeriodMetrics(db, "strftime('%Y-%m', created_at, 'localtime') = strftime('%Y-%m', date('now', 'localtime', 'start of month', '-1 day'))");

  // All-time totals
  const allTime = getPeriodMetrics(db, "1=1");

  return {
    generatedAt: new Date().toISOString(),
    daily: {
      today,
      yesterday,
      revenueGrowthRate: calculateGrowthRate(today.billedRevenue, yesterday.billedRevenue),
      jobsGrowthRate: calculateGrowthRate(today.jobsCount, yesterday.jobsCount)
    },
    weekly: {
      thisWeek,
      lastWeek,
      revenueGrowthRate: calculateGrowthRate(thisWeek.billedRevenue, lastWeek.billedRevenue),
      jobsGrowthRate: calculateGrowthRate(thisWeek.jobsCount, lastWeek.jobsCount),
      profitGrowthRate: calculateGrowthRate(thisWeek.grossProfit, lastWeek.grossProfit)
    },
    monthly: {
      thisMonth,
      lastMonth,
      revenueGrowthRate: calculateGrowthRate(thisMonth.billedRevenue, lastMonth.billedRevenue),
      jobsGrowthRate: calculateGrowthRate(thisMonth.jobsCount, lastMonth.jobsCount),
      profitGrowthRate: calculateGrowthRate(thisMonth.grossProfit, lastMonth.grossProfit)
    },
    allTime
  };
}

module.exports = {
  getPeriodMetrics,
  getBusinessKpiReport,
  getProfitMargin,
  calculateGrowthRate
};
