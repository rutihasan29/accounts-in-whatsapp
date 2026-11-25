/**
 * Meta / Facebook Ads Integration Module
 * 
 * IMPORTANT PRIVACY CONSTRAINT:
 * All data fetched by this module must NEVER be broadcast, printed, or forwarded
 * to WhatsApp groups or client chats where employees or external parties have access.
 * This data is STRICTLY for the owner's private viewing (CLI, private web dashboard).
 */

const config = require('./config');

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/**
 * Fetch ad accounts associated with the access token.
 */
async function fetchAdAccounts(token = config.FB_ACCESS_TOKEN, fetchFn = globalThis.fetch) {
  if (!token) {
    throw new Error('FB_ACCESS_TOKEN is required');
  }
  const url = `${GRAPH_API_BASE}/me/adaccounts?fields=id,name,account_id,account_status,currency,amount_spent&access_token=${encodeURIComponent(token)}`;
  const res = await fetchFn(url);
  const json = await res.json();
  if (json.error) {
    throw new Error(`Meta Graph API Error [${json.error.code}]: ${json.error.message}`);
  }
  return json.data || [];
}

/**
 * Fetch insights for a specific ad account.
 * Supports date presets (e.g. 'today', 'yesterday', 'this_month', 'last_30d')
 * or custom date range { startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD' }.
 */
async function fetchAdInsights({
  token = config.FB_ACCESS_TOKEN,
  adAccountId = config.FB_AD_ACCOUNT_ID,
  datePreset = 'this_month',
  timeIncrement = 1,
  startDate = null,
  endDate = null,
  fetchFn = globalThis.fetch
} = {}) {
  if (!token) {
    throw new Error('FB_ACCESS_TOKEN is required');
  }
  if (!adAccountId) {
    throw new Error('FB_AD_ACCOUNT_ID is required');
  }

  const actId = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
  const fields = 'spend,impressions,clicks,cpc,cpm,actions,date_start,date_stop';
  
  let url = `${GRAPH_API_BASE}/${actId}/insights?fields=${fields}&time_increment=${timeIncrement}&access_token=${encodeURIComponent(token)}`;
  
  if (startDate && endDate) {
    const timeRange = JSON.stringify({ since: startDate, until: endDate });
    url += `&time_range=${encodeURIComponent(timeRange)}`;
  } else if (datePreset) {
    url += `&date_preset=${encodeURIComponent(datePreset)}`;
  }

  const res = await fetchFn(url);
  const json = await res.json();
  if (json.error) {
    throw new Error(`Meta Graph API Error [${json.error.code}]: ${json.error.message}`);
  }
  return json.data || [];
}

/**
 * Extract messaging conversations / chats started from Meta action breakdown.
 */
function extractMessagingConversations(actions) {
  if (!Array.isArray(actions)) return 0;
  
  const conversationAction = actions.find(a => 
    a.action_type === 'onsite_conversion.messaging_conversation_started_7d' ||
    a.action_type === 'onsite_conversion.total_messaging_connection'
  );
  if (conversationAction && !isNaN(parseInt(conversationAction.value, 10))) {
    return parseInt(conversationAction.value, 10);
  }

  const leadAction = actions.find(a => a.action_type === 'lead');
  if (leadAction && !isNaN(parseInt(leadAction.value, 10))) {
    return parseInt(leadAction.value, 10);
  }

  return 0;
}

/**
 * Sync ad spend from Meta Ads to SQLite database.
 * Upserts each daily spend row into `ad_spend` table.
 */
async function syncAdSpendToDb(db, {
  token = null,
  adAccountId = null,
  datePreset = 'this_month',
  startDate = null,
  endDate = null,
  usdRate = config.USD_TO_BDT_RATE || 122.0,
  currency = 'USD',
  fetchFn = globalThis.fetch
} = {}) {
  if (!db) {
    throw new Error('Database instance is required for syncing ad spend');
  }

  const { getBotSetting, setBotSetting } = require('./db');
  const resolvedToken = token || (db ? getBotSetting(db, 'fb_access_token') : null) || config.FB_ACCESS_TOKEN;
  const resolvedAdAccount = adAccountId || (db ? getBotSetting(db, 'fb_ad_account_id') : null) || config.FB_AD_ACCOUNT_ID;

  const insights = await fetchAdInsights({
    token: resolvedToken,
    adAccountId: resolvedAdAccount,
    datePreset,
    timeIncrement: 1,
    startDate,
    endDate,
    fetchFn
  });

  if (token && db && typeof setBotSetting === 'function') {
    try {
      setBotSetting(db, 'fb_access_token', token);
    } catch {}
  }

  const upsertStmt = db.prepare(`
    INSERT INTO ad_spend (spend_date, amount, note, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(spend_date) DO UPDATE SET
      amount = excluded.amount,
      note = excluded.note,
      updated_at = CURRENT_TIMESTAMP
  `);

  let totalSpendOriginal = 0;
  let totalSpendBDT = 0;
  let totalConversations = 0;
  let syncedDays = 0;

  const runSync = db.transaction((rows) => {
    for (const row of rows) {
      const spendNum = parseFloat(row.spend) || 0;
      const spendBDT = currency === 'USD' ? Math.round(spendNum * usdRate * 100) / 100 : Math.round(spendNum * 100) / 100;
      const conversations = extractMessagingConversations(row.actions);
      const impressions = parseInt(row.impressions, 10) || 0;
      const clicks = parseInt(row.clicks, 10) || 0;
      
      const note = `Meta Ads: $${spendNum.toFixed(2)} USD (${spendBDT.toFixed(0)} BDT) | ${conversations} chats | ${impressions} imp | ${clicks} clicks`;

      upsertStmt.run(row.date_start, spendBDT, note);

      totalSpendOriginal += spendNum;
      totalSpendBDT += spendBDT;
      totalConversations += conversations;
      syncedDays++;
    }
  });

  runSync(insights);

  const avgCplBDT = totalConversations > 0 ? Math.round((totalSpendBDT / totalConversations) * 100) / 100 : null;

  return {
    success: true,
    syncedDays,
    totalSpendUSD: Math.round(totalSpendOriginal * 100) / 100,
    totalSpendBDT: Math.round(totalSpendBDT * 100) / 100,
    totalConversations,
    avgCplBDT,
    currency,
    usdRate,
    days: insights.map(i => ({
      date: i.date_start,
      spendUSD: parseFloat(i.spend) || 0,
      spendBDT: currency === 'USD' ? Math.round((parseFloat(i.spend) || 0) * usdRate) : (parseFloat(i.spend) || 0),
      chats: extractMessagingConversations(i.actions)
    }))
  };
}

module.exports = {
  fetchAdAccounts,
  fetchAdInsights,
  extractMessagingConversations,
  syncAdSpendToDb,
  GRAPH_API_VERSION,
  GRAPH_API_BASE
};
