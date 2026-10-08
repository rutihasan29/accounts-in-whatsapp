const { Client, LocalAuth } = require('whatsapp-web.js');
const { DB_PATH, AUTH_DATA_PATH } = require('./src/config');
const { initDb } = require('./src/db');
const { setupBotHandlers } = require('./src/bot');

console.log('🚀 Starting WhatsApp Business Ledger Bot...');
console.log(`📁 Database path: ${DB_PATH}`);
console.log(`📁 Auth storage: ${AUTH_DATA_PATH}`);

const db = initDb(DB_PATH);

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
