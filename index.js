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

// Tested & stable Puppeteer args for Docker / Render (excluding --single-process to prevent WebSocket crypto failure)
const puppeteerArgs = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--disable-gpu'
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

function initializeClient() {
  botState.status = 'STARTING';
  broadcastStatus();

  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: AUTH_DATA_PATH
    }),
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1049839371-alpha.html'
    },
    puppeteer: puppeteerOptions
  });

  setupBotHandlers({
    client,
    db,
    botState,
    onStatusChange: broadcastStatus
  });

  if (PAIR_PHONE_NUMBER) {
    let pairCodeRequested = false;
    client.on('qr', async () => {
      if (!pairCodeRequested) {
        pairCodeRequested = true;
        try {
          console.log(`[PAIRING] Auto-requesting pairing code for env PAIR_PHONE_NUMBER: ${PAIR_PHONE_NUMBER}`);
          await handlePairPhone(PAIR_PHONE_NUMBER);
        } catch (e) {
          console.warn('[PAIRING] Auto-pairing request error:', e.message);
        }
      }
    });
  }

  client.initialize().catch((err) => {
    console.error('❌ Error initializing WhatsApp client:', err.message);
    botState.status = 'ERROR';
    broadcastStatus();
  });
}

// Handler for phone pairing code requests
async function handlePairPhone(phoneNumber) {
  if (!client) {
    throw new Error('WhatsApp ক্লায়েন্ট প্রস্তুত নয়। কিছুক্ষণ পর চেষ্টা করুন।');
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
  broadcastStatus();

  try {
    const code = await client.requestPairingCode(cleanPhone);
    console.log(`[PAIRING] Pairing code received: ${code}`);
    botState.status = 'CODE_READY';
    botState.pairingCode = code;
    botState.pairingPhone = cleanPhone;
    botState.pairingCodeTimestamp = Date.now();
    broadcastStatus();
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
