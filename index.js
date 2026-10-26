const { Client, LocalAuth } = require('whatsapp-web.js');
const { DB_PATH, AUTH_DATA_PATH, PORT } = require('./src/config');
const { initDb, recoverUngracefulShutdown, recordBotState } = require('./src/db');
const { setupBotHandlers } = require('./src/bot');
const { startWebServer } = require('./src/server');
const { startNgrokTunnel, stopNgrokTunnel } = require('./src/tunnel');

console.log('🚀 Starting WhatsApp Business Ledger Bot...');
console.log(`📁 Database path: ${DB_PATH}`);
console.log(`📁 Auth storage: ${AUTH_DATA_PATH}`);

const db = initDb(DB_PATH);
recoverUngracefulShutdown(db);
recordBotState(db, 'OFFLINE', 'SERVER_STARTUP');

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: AUTH_DATA_PATH
  }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  }
});

// Start the official paper-styled mobile web dashboard
const server = startWebServer({ db, client, port: PORT });

// Automatically open ngrok public tunnel on bot startup
startNgrokTunnel({ port: PORT, db }).catch(() => {});

setupBotHandlers({ client, db });

let isShuttingDown = false;
const handleShutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\nGracefully shutting down (${signal})...`);
  try {
    await stopNgrokTunnel();
  } catch {}
  try {
    recordBotState(db, 'OFFLINE', 'SERVER_SHUTDOWN');
  } catch {}
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

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
});

client.initialize();
