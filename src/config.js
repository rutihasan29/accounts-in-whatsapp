const path = require('path');

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch {}
}

module.exports = {
  DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'ledger.db'),
  AUTH_DATA_PATH: process.env.AUTH_DATA_PATH || path.join(__dirname, '..', '.wwebjs_auth'),
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  VA2_PHONE: process.env.VA2_PHONE || '8801307760509',
  VE3_PHONE: process.env.VE3_PHONE || '8801831366604'
};
