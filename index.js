const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const {
  DB_PATH,
  AUTH_DATA_PATH,
  PUPPETEER_EXECUTABLE_PATH,
  PORT,
  PAIR_PHONE_NUMBER,
  normalizePhoneNumber
} = require('./src/config');
const { initDb } = require('./src/db');
const { setupBotHandlers } = require('./src/bot');
const { startWebServer, botState, broadcastStatus } = require('./src/server');

console.log('🚀 Starting WhatsApp Business Ledger Bot...');
console.log(`📁 Database path: ${DB_PATH}`);
console.log(`📁 Auth storage: ${AUTH_DATA_PATH}`);

// Ensure required data directories exist
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(AUTH_DATA_PATH, { recursive: true });

const db = initDb(DB_PATH);

// Tested & stable Puppeteer args for Docker / Render (tuned for 512MB RAM free tier, excluding --single-process to prevent WebSocket crypto failure)
const puppeteerArgs = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--no-zygote',
  '--disable-extensions',
  '--disable-infobars',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-background-networking',
  '--disable-default-apps',
  '--js-flags=--max-old-space-size=256'
];

const puppeteerOptions = {
  headless: true,
  args: puppeteerArgs
};

if (PUPPETEER_EXECUTABLE_PATH && fs.existsSync(PUPPETEER_EXECUTABLE_PATH)) {
  puppeteerOptions.executablePath = PUPPETEER_EXECUTABLE_PATH;
  console.log(`🌐 Using Puppeteer executable: ${PUPPETEER_EXECUTABLE_PATH}`);
}

let client = null;
let syncWatchdogTimer = null;

function startSyncWatchdog() {
  if (syncWatchdogTimer) clearInterval(syncWatchdogTimer);

  let checkCount = 0;
  syncWatchdogTimer = setInterval(async () => {
    checkCount++;
    if (!client || !client.pupPage || botState.status === 'READY') {
      clearInterval(syncWatchdogTimer);
      syncWatchdogTimer = null;
      return;
    }

    try {
      const pageInfo = await client.pupPage.evaluate(() => {
        try {
          const Socket = window.require?.('WAWebSocketModel')?.Socket;
          const Conn = window.require?.('WAWebConnModel')?.Conn;
          const meUser = window.require?.('WAWebUserPrefsMeUser');
          const myWid = meUser?.getMaybeMePnUser?.() || meUser?.getMaybeMeLidUser?.() || Conn?.wid;
          const socketState = Socket?.state;
          const hasSynced = Socket?.hasSynced === true;
          const hasPaneSide = !!document.querySelector('#pane-side');
          const hasChatList = !!document.querySelector('div[data-testid="chat-list"]') || !!document.querySelector('._aigs');

          return {
            socketState,
            hasSynced,
            hasWid: !!myWid,
            widUser: myWid?._serialized || myWid?.user || (typeof myWid === 'string' ? myWid : null),
            hasChatPane: hasPaneSide || hasChatList
          };
        } catch {
          return null;
        }
      });

      if (!pageInfo) return;

      // When phone confirms pairing, socket connects, wid appears, or chat pane renders
      if (pageInfo.hasWid || pageInfo.hasSynced || pageInfo.hasChatPane || pageInfo.socketState === 'CONNECTED') {
        console.log(`[SYNC-WATCHDOG] WhatsApp link confirmed! (socket=${pageInfo.socketState}, wid=${pageInfo.widUser}, hasSynced=${pageInfo.hasSynced}, chatPane=${pageInfo.hasChatPane})`);

        if (botState.status !== 'AUTHENTICATED' && botState.status !== 'READY') {
          botState.status = 'AUTHENTICATED';
          if (pageInfo.widUser) {
            botState.user = String(pageInfo.widUser).replace(/\D/g, '');
          }
          broadcastStatus();
        }

        // Trigger onAppStateHasSyncedEvent so whatsapp-web.js completes transition to ready
        await client.pupPage.evaluate(() => {
          if (typeof window.onAppStateHasSyncedEvent === 'function') {
            window.onAppStateHasSyncedEvent();
          }
        });
      }
    } catch (e) {
      // Evaluation can fail momentarily during navigation
    }

    if (checkCount > 400) {
      clearInterval(syncWatchdogTimer);
      syncWatchdogTimer = null;
    }
  }, 1500);
}

function initializeClient() {
  botState.status = 'STARTING';
  broadcastStatus();

  const clientOptions = {
    authStrategy: new LocalAuth({
      dataPath: AUTH_DATA_PATH
    }),
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1049839371-alpha.html'
    },
    puppeteer: puppeteerOptions
  };

  const envPhone = normalizePhoneNumber(PAIR_PHONE_NUMBER);
  if (envPhone && envPhone.length >= 10) {
    console.log(`[PAIRING] Pre-configuring pairing for phone number +${envPhone}...`);
    clientOptions.pairWithPhoneNumber = {
      phoneNumber: envPhone,
      showNotification: true,
      intervalMs: 180000
    };
    botState.pairingPhone = envPhone;
    botState.status = 'PAIRING_REQUESTED';
  }

  client = new Client(clientOptions);

  setupBotHandlers({
    client,
    db,
    botState,
    onStatusChange: broadcastStatus
  });

  client.initialize().catch((err) => {
    console.error('❌ Error initializing WhatsApp client:', err.message);
    botState.status = 'ERROR';
    broadcastStatus();
  });

  // Start background sync watchdog
  startSyncWatchdog();
}

// Handler for phone pairing code requests
async function handlePairPhone(phoneNumber) {
  if (!client || !client.pupPage) {
    throw new Error('WhatsApp ক্লায়েন্ট পেজ এখনও লোড হচ্ছে, অনুগ্রহ করে ৫-১০ সেকেন্ড পর আবার চেষ্টা করুন।');
  }
  if (botState.status === 'READY') {
    throw new Error('হোয়াটসঅ্যাপ ইতিমধ্যে সফলভাবে লগইন করা আছে!');
  }
  const cleanPhone = normalizePhoneNumber(phoneNumber);
  if (!cleanPhone || cleanPhone.length < 10) {
    throw new Error('অনুগ্রহ করে সঠিক ফোন নম্বর দিন (যেমন: 01712345678 বা 8801712345678)');
  }

  console.log(`[PAIRING] Requesting pairing code for +${cleanPhone}...`);
  botState.status = 'PAIRING_REQUESTED';
  botState.pairingPhone = cleanPhone;
  botState.qrCode = null;
  botState.qrDataUrl = null;
  broadcastStatus();

  // Prevent QR refreshes from cancelling alt linking
  if (client.options) {
    client.options.pairWithPhoneNumber = {
      phoneNumber: cleanPhone,
      showNotification: true,
      intervalMs: 180000
    };
  }

  try {
    await client.pupPage.evaluate(() => {
      window.onQRChangedEvent = () => {};
      if (window.AuthStore?.Conn) {
        window.AuthStore.Conn.off('change:ref');
      }
      if (window.require) {
        try {
          const Cmd = window.require('WAWebCmd')?.Cmd;
          if (Cmd) Cmd.refreshQR = () => {};
        } catch {}
      }
    });
  } catch (e) {
    console.warn('[PAIRING] Could not mute QR events:', e.message);
  }

  try {
    const code = await client.requestPairingCode(cleanPhone);
    console.log(`[PAIRING] Pairing code received: ${code}`);
    botState.status = 'CODE_READY';
    botState.pairingCode = code;
    botState.pairingPhone = cleanPhone;
    botState.pairingCodeTimestamp = Date.now();
    broadcastStatus();

    startSyncWatchdog();
    return code;
  } catch (err) {
    console.error('[PAIRING] Failed to get pairing code:', err.message);
    botState.status = 'ERROR';
    broadcastStatus();
    throw err;
  }
}

// Handler for reset-session endpoint
async function resetSession() {
  console.log('🔄 Resetting WhatsApp session and clearing auth credentials...');
  if (syncWatchdogTimer) {
    clearInterval(syncWatchdogTimer);
    syncWatchdogTimer = null;
  }
  botState.status = 'STARTING';
  botState.qrCode = null;
  botState.qrDataUrl = null;
  botState.lastQrTimestamp = null;
  botState.pairingCode = null;
  botState.pairingPhone = null;
  botState.pairingCodeTimestamp = null;
  broadcastStatus();

  if (client) {
    try {
      await client.destroy();
    } catch (e) {
      console.warn('Error destroying client:', e.message);
    }
  }

  try {
    if (fs.existsSync(AUTH_DATA_PATH)) {
      fs.rmSync(AUTH_DATA_PATH, { recursive: true, force: true });
    }
    fs.mkdirSync(AUTH_DATA_PATH, { recursive: true });
  } catch (e) {
    console.warn('Error clearing auth directory:', e.message);
  }

  // Small delay to ensure clean process release
  await new Promise((resolve) => setTimeout(resolve, 1000));
  initializeClient();
}

// Start HTTP web server for Render health checks, Web QR dashboard and Phone Pairing
const server = startWebServer({
  db,
  port: PORT,
  onResetSession: resetSession,
  onPairPhone: handlePairPhone
});

let isShuttingDown = false;
const handleShutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\nGracefully shutting down (${signal})...`);
  try {
    server.close();
  } catch {}
  try {
    if (client) await client.destroy();
  } catch {}
  try {
    db.close();
  } catch {}
  process.exit(0);
};

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

initializeClient();
