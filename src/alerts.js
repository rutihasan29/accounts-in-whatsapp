const config = require('./config');
const { recordSystemAlert } = require('./db');

const recentAlertHistory = new Map();
const ALERT_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes cooldown per context

/**
 * Sends a high-priority system/UI alert with diagnostics to Preenan (WhatsApp +8801534323811)
 */
async function sendSystemAlertToPreenan({
  client,
  db,
  context,
  error,
  logs = null,
  force = false
} = {}) {
  const cleanPreenan = String(config.PREENAN_PHONE || '8801534323811').replace(/\D/g, '');
  const preenanJid = `${cleanPreenan}@c.us`;
  const alertKey = String(context || 'GENERAL_ERROR');

  const now = Date.now();
  const lastAlert = recentAlertHistory.get(alertKey);

  if (!force && lastAlert && (now - lastAlert.time < ALERT_COOLDOWN_MS)) {
    lastAlert.suppressedCount = (lastAlert.suppressedCount || 0) + 1;
    console.warn(`[ALERT: PREENAN] Suppressing duplicate alert for context "${alertKey}" (cooldown active, count: ${lastAlert.suppressedCount})`);
    return { sent: false, reason: 'COOLDOWN_ACTIVE', suppressedCount: lastAlert.suppressedCount };
  }

  const suppressedCount = lastAlert?.suppressedCount || 0;
  recentAlertHistory.set(alertKey, { time: now, suppressedCount: 0 });

  const timeStr = new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka', hour12: true });
  const errStr = error ? (typeof error === 'string' ? error : error.message || String(error)) : 'অজানা ত্রুটি (Unknown Error)';
  const logStr = logs ? (typeof logs === 'string' ? logs : JSON.stringify(logs, null, 2)) : '';

  const alertLines = [
    '🚨 *[মুন্নিসফট বট সতর্কতা — UI / সিস্টেম সমস্যা]*',
    '',
    '⚠️ *সমস্যা:* WhatsApp Web UI পরিবর্তন বা সিস্টেমে ত্রুটি শনাক্ত হয়েছে!',
    `📌 *কনটেক্সট:* ${context || 'সাধারণ ত্রুটি'}`,
    `❌ *ত্রুটি:* ${errStr}`
  ];

  if (suppressedCount > 0) {
    alertLines.push(`🔁 *পুনরাবৃত্তি:* বিগত ৩ মিনিটে এই ত্রুটি ${suppressedCount} বার ঘটেছে।`);
  }

  if (logStr) {
    alertLines.push('', '📋 *লগ বিবরণ (Log Details):*', '```', logStr.slice(0, 800), '```');
  }

  alertLines.push(
    '',
    `⏰ *সময়:* ${timeStr}`,
    '💡 *পরামর্শ:* WhatsApp Web UI পরিবর্তিত হয়ে থাকলে সিলেক্টর আপডেট বা বট রিস্টার্ট করার প্রয়োজন হতে পারে।'
  );

  const alertMessage = alertLines.join('\n');
  let sent = false;
  let sentMessageId = null;

  if (client && typeof client.sendMessage === 'function') {
    try {
      const sentMsg = await client.sendMessage(preenanJid, alertMessage);
      sent = true;
      sentMessageId = sentMsg?.id?._serialized || sentMsg?.id?.id || null;
      console.error(`[ALERT: PREENAN] Alert sent to Preenan (+${cleanPreenan}): [${context}] ${errStr}`);
    } catch (sendErr) {
      console.error(`[ALERT: PREENAN] Failed to send alert message to Preenan (+${cleanPreenan}):`, sendErr.message);
    }
  } else {
    console.error(`[ALERT: PREENAN] Client unavailable. Logged alert for Preenan: [${context}] ${errStr}`);
  }

  if (db) {
    try {
      recordSystemAlert(db, {
        alertType: 'UI_SYSTEM_ERROR',
        context,
        errorMessage: errStr,
        logDetails: logStr,
        recipient: cleanPreenan,
        sentStatus: sent ? 'SENT' : 'FAILED'
      });
    } catch (dbErr) {
      console.warn('[ALERT: PREENAN] Could not record alert in database:', dbErr.message);
    }
  }

  return {
    sent,
    recipient: cleanPreenan,
    messageId: sentMessageId,
    context,
    error: errStr
  };
}

/**
 * Checks WhatsApp Web in-page DOM and injection health
 */
async function checkUiHealth({ client }) {
  if (!client || !client.pupPage || typeof client.pupPage.evaluate !== 'function') {
    return { healthy: false, reason: 'Puppeteer page not ready or evaluate unavailable' };
  }

  try {
    const health = await client.pupPage.evaluate(() => {
      const hasApp = !!document.querySelector('#app');
      const hasWWebJS = typeof window.WWebJS !== 'undefined';
      const hasStore = typeof window.Store !== 'undefined';
      const hasRequire = typeof window.require === 'function';
      const hasConversation = !!document.querySelector('#main, [data-testid="conversation-panel-wrapper"]');
      return {
        hasApp,
        hasWWebJS,
        hasStore,
        hasRequire,
        hasConversation,
        url: window.location?.href || '',
        title: document.title || ''
      };
    });

    if (!health.hasApp) {
      return {
        healthy: false,
        reason: 'WhatsApp Web root element #app is missing. UI markup may have changed or page reloaded.',
        details: health
      };
    }

    if (!health.hasWWebJS && !health.hasStore && !health.hasRequire) {
      return {
        healthy: false,
        reason: 'WhatsApp internal module access (WWebJS/Store/require) is completely missing. Webpack loader likely changed.',
        details: health
      };
    }

    return { healthy: true, details: health };
  } catch (err) {
    return {
      healthy: false,
      reason: 'pupPage.evaluate execution error: ' + err.message
    };
  }
}

/**
 * Starts a recurring background UI health watchdog
 */
function startUiHealthWatchdog({ client, db, intervalMs = 120000 }) {
  let consecutiveFailures = 0;

  const interval = setInterval(async () => {
    try {
      const health = await checkUiHealth({ client });
      if (!health.healthy) {
        consecutiveFailures++;
        console.warn(`[WATCHDOG: UI_HEALTH] Warning: UI health check failed (attempt ${consecutiveFailures}): ${health.reason}`);

        // Alert on the first failure, and repeat if continuous
        if (consecutiveFailures === 1 || consecutiveFailures % 3 === 0) {
          await sendSystemAlertToPreenan({
            client,
            db,
            context: 'WhatsApp Web UI Health Failure',
            error: health.reason,
            logs: health.details || null
          });
        }
      } else {
        if (consecutiveFailures > 0) {
          console.log(`[WATCHDOG: UI_HEALTH] WhatsApp Web UI health recovered after ${consecutiveFailures} failure(s).`);
          consecutiveFailures = 0;
        }
      }
    } catch (watchdogErr) {
      console.warn('[WATCHDOG: UI_HEALTH] Watchdog tick error:', watchdogErr.message);
    }
  }, intervalMs);

  if (interval && typeof interval.unref === 'function') {
    interval.unref();
  }

  return interval;
}

module.exports = {
  sendSystemAlertToPreenan,
  checkUiHealth,
  startUiHealthWatchdog,
  ALERT_COOLDOWN_MS,
  recentAlertHistory
};
