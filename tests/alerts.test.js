const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { initDb, recordSystemAlert, getRecentSystemAlerts } = require('../src/db');
const {
  sendSystemAlertToPreenan,
  checkUiHealth,
  startUiHealthWatchdog,
  recentAlertHistory
} = require('../src/alerts');

describe('System & UI Change Alerts for Preenan', () => {
  beforeEach(() => {
    recentAlertHistory.clear();
  });

  it('records system alert in DB and sends formatted WhatsApp alert to Preenan (+8801534323811)', async () => {
    const db = initDb(':memory:');
    const sentMessages = [];
    const mockClient = {
      sendMessage: async (jid, text) => {
        sentMessages.push({ jid, text });
        return { id: { _serialized: 'alert-msg-01' } };
      }
    };

    const res = await sendSystemAlertToPreenan({
      client: mockClient,
      db,
      context: 'DOM Selector Changed',
      error: 'Audio element not found in DOM',
      logs: { selector: '[data-id] audio', attempt: 3 },
      force: true
    });

    assert.strictEqual(res.sent, true);
    assert.strictEqual(res.recipient, '8801534323811');
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].jid, '8801534323811@c.us');
    assert.ok(sentMessages[0].text.includes('মুন্নিসফট বট সতর্কতা'));
    assert.ok(sentMessages[0].text.includes('DOM Selector Changed'));
    assert.ok(sentMessages[0].text.includes('Audio element not found'));
    assert.ok(sentMessages[0].text.includes('Log Details'));

    // Verify recorded in DB
    const alerts = getRecentSystemAlerts(db);
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].context, 'DOM Selector Changed');
    assert.strictEqual(alerts[0].recipient, '8801534323811');
    assert.strictEqual(alerts[0].sent_status, 'SENT');

    db.close();
  });

  it('debounces duplicate alerts within 3-minute cooldown period', async () => {
    const db = initDb(':memory:');
    const sentMessages = [];
    const mockClient = {
      sendMessage: async (jid, text) => {
        sentMessages.push({ jid, text });
        return { id: { _serialized: `alert-msg-${Date.now()}` } };
      }
    };

    // First alert sends
    const res1 = await sendSystemAlertToPreenan({
      client: mockClient,
      db,
      context: 'Repeated UI Error',
      error: 'Module not found'
    });
    assert.strictEqual(res1.sent, true);
    assert.strictEqual(sentMessages.length, 1);

    // Second immediate alert with same context is debounced
    const res2 = await sendSystemAlertToPreenan({
      client: mockClient,
      db,
      context: 'Repeated UI Error',
      error: 'Module not found'
    });
    assert.strictEqual(res2.sent, false);
    assert.strictEqual(res2.reason, 'COOLDOWN_ACTIVE');
    assert.strictEqual(res2.suppressedCount, 1);
    assert.strictEqual(sentMessages.length, 1, 'Should NOT send duplicate message during cooldown');

    db.close();
  });

  it('checkUiHealth flags unhealthy when pupPage is missing or evaluate fails', async () => {
    const res1 = await checkUiHealth({ client: null });
    assert.strictEqual(res1.healthy, false);

    const mockClientError = {
      pupPage: {
        evaluate: async () => {
          throw new Error('Target closed');
        }
      }
    };
    const res2 = await checkUiHealth({ client: mockClientError });
    assert.strictEqual(res2.healthy, false);
    assert.ok(res2.reason.includes('Target closed'));
  });

  it('checkUiHealth flags unhealthy when WhatsApp #app DOM element is missing', async () => {
    const mockClientMissingApp = {
      pupPage: {
        evaluate: async (fn) => {
          return {
            hasApp: false,
            hasWWebJS: false,
            hasStore: false,
            hasRequire: false,
            hasConversation: false
          };
        }
      }
    };

    const res = await checkUiHealth({ client: mockClientMissingApp });
    assert.strictEqual(res.healthy, false);
    assert.ok(res.reason.includes('#app is missing'));
  });

  it('checkUiHealth passes when WhatsApp Web DOM and internals are intact', async () => {
    const mockClientHealthy = {
      pupPage: {
        evaluate: async (fn) => {
          return {
            hasApp: true,
            hasWWebJS: true,
            hasStore: true,
            hasRequire: true,
            hasConversation: true
          };
        }
      }
    };

    const res = await checkUiHealth({ client: mockClientHealthy });
    assert.strictEqual(res.healthy, true);
    assert.strictEqual(res.details.hasApp, true);
  });

  it('startUiHealthWatchdog alerts Preenan when UI health check fails', async () => {
    const db = initDb(':memory:');
    const sentMessages = [];
    const mockClient = {
      pupPage: {
        evaluate: async () => ({
          hasApp: false,
          hasWWebJS: false,
          hasStore: false,
          hasRequire: false
        })
      },
      sendMessage: async (jid, text) => {
        sentMessages.push({ jid, text });
        return { id: { _serialized: 'watchdog-alert-01' } };
      }
    };

    // Run watchdog with short interval (10ms)
    const interval = startUiHealthWatchdog({
      client: mockClient,
      db,
      intervalMs: 15
    });

    // Wait for at least one tick
    await new Promise((resolve) => setTimeout(resolve, 60));
    clearInterval(interval);

    assert.ok(sentMessages.length >= 1, 'Watchdog must send alert to Preenan upon UI health failure');
    assert.strictEqual(sentMessages[0].jid, '8801534323811@c.us');
    assert.ok(sentMessages[0].text.includes('WhatsApp Web UI Health Failure'));

    db.close();
  });
});
