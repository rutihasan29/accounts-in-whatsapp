const path = require('path');

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(path.join(__dirname, '..', '.env'));
  } catch {
    try {
      process.loadEnvFile();
    } catch {}
  }
}

const rawAudioKeys = process.env.GEMINI_AUDIO_API_KEYS || process.env.GEMINI_AUDIO_API_KEY || process.env.GEMINI_API_KEY || '';
const parsedAudioKeys = typeof rawAudioKeys === 'string'
  ? rawAudioKeys.split(/[,;\n]/).map(k => k.trim()).filter(Boolean)
  : (Array.isArray(rawAudioKeys) ? rawAudioKeys.map(k => String(k).trim()).filter(Boolean) : []);

module.exports = {
  DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'ledger.db'),
  AUTH_DATA_PATH: process.env.AUTH_DATA_PATH || path.join(__dirname, '..', '.wwebjs_auth'),
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_AUDIO_API_KEY: parsedAudioKeys[0] || process.env.GEMINI_AUDIO_API_KEY || process.env.GEMINI_API_KEY || '',
  GEMINI_AUDIO_API_KEYS: parsedAudioKeys,
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-flash-lite-latest',
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || 'minimax/minimax-m3.1-flash:free',
  LLM_PROVIDER: process.env.LLM_PROVIDER || 'gemini',
  VA2_PHONE: process.env.VA2_PHONE || '8801307760509',
  VA3_PHONE: process.env.VA3_PHONE || '8801844674843',
  VA_PHONES: (process.env.VA_PHONES || '8801307760509,8801844674843,8801568618636').split(/[,;\n]/).map(p => p.trim()).filter(Boolean),
  VE3_PHONE: process.env.VE3_PHONE || '8801831366604',
  PREENAN_PHONE: process.env.PREENAN_PHONE || '8801534323811',
  SCRIPT_TIMEOUT_MS: process.env.SCRIPT_TIMEOUT_MS ? parseInt(process.env.SCRIPT_TIMEOUT_MS, 10) : 5 * 60 * 1000,
  DASHBOARD_PIN: process.env.DASHBOARD_PIN || '6700'
};
