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
const { startWebServer, botState } = require('./src/server');

console.log('🚀 Starting WhatsApp Business Ledger Bot...');
console.log(`📁 Database path: ${DB_PATH}`);
console.log(`📁 Auth storage: ${AUTH_DATA_PATH}`);

// Ensure required data directories exist
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(AUTH_DATA_PATH, { recursive: true });

const db = initDb(DB_PATH);

// Start HTTP web server for Render health checks and Web QR dashboard
const server = startWebServer({ db, port: PORT });

// Container and memory-optimized Puppeteer flags for Render Free Tier (512MB RAM)
const puppeteerArgs = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
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

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: AUTH_DATA_PATH
  }),
  puppeteer: puppeteerOptions
});

setupBotHandlers({ client, db, botState });

let isShuttingDown = false;
const handleShutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\nGracefully shutting down (${signal})...`);
  try {
    server.close();
  } catch {}
  try {
    await client.destroy();
  } catch {}
  try {
    db.close();
  } catch {}
  process.exit(0);
};

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

client.initialize();
