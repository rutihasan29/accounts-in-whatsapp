const path = require('path');

function normalizePhoneNumber(input) {
  let cleaned = String(input || '').replace(/\D/g, '');
  if (cleaned.startsWith('01') && cleaned.length === 11) {
    cleaned = '88' + cleaned;
  }
  return cleaned;
}

module.exports = {
  PORT: parseInt(process.env.PORT, 10) || 3000,
  DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'ledger.db'),
  AUTH_DATA_PATH: process.env.AUTH_DATA_PATH || path.join(__dirname, '..', '.wwebjs_auth'),
  PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'linux' ? '/usr/bin/chromium' : undefined),
  RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || '',
  ADMIN_SECRET: process.env.ADMIN_SECRET || '',
  PAIR_PHONE_NUMBER: process.env.PAIR_PHONE_NUMBER || '',
  normalizePhoneNumber
};
