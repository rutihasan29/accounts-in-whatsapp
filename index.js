const { Client, LocalAuth } = require('whatsapp-web.js');
const { DB_PATH, AUTH_DATA_PATH, PORT } = require('./src/config');
const { initDb } = require('./src/db');
const { setupBotHandlers } = require('./src/bot');
const { startWebServer } = require('./src/server');

console.log('🚀 Starting WhatsApp Business Ledger Bot...');
console.log(`📁 Database path: ${DB_PATH}`);
console.log(`📁 Auth storage: ${AUTH_DATA_PATH}`);

const db = initDb(DB_PATH);

// Start the official paper-styled mobile web dashboard
const server = startWebServer({ db, port: PORT });

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: AUTH_DATA_PATH
  }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

setupBotHandlers({ client, db });

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
