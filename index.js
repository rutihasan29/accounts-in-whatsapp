const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const {
  DB_PATH,
  AUTH_DATA_PATH,
  PUPPETEER_EXECUTABLE_PATH,
  PORT
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

  client.initialize().catch((err) => {
    console.error('❌ Error initializing WhatsApp client:', err.message);
    botState.status = 'ERROR';
    broadcastStatus();
  });
}

// Handler for reset-session endpoint
async function resetSession() {
  console.log('🔄 Resetting WhatsApp session and clearing auth credentials...');
  botState.status = 'STARTING';
  botState.qrCode = null;
  botState.qrDataUrl = null;
  botState.lastQrTimestamp = null;
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

// Start HTTP web server for Render health checks and Web QR dashboard
const server = startWebServer({
  db,
  port: PORT,
  onResetSession: resetSession
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
