const mm = require('music-metadata');

const DIGITS_TO_BENGALI = {
  '0': '০', '1': '১', '2': '২', '3': '৩', '4': '৪',
  '5': '৫', '6': '৬', '7': '৭', '8': '৮', '9': '৯'
};

function toBengaliDigits(num) {
  return String(num).replace(/\d/g, (d) => DIGITS_TO_BENGALI[d] || d);
}

function formatAudioDuration(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined || isNaN(totalSeconds)) {
    return null;
  }

  const rounded = Math.round(Math.max(0, totalSeconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;

  let timeString = '';
  if (hours > 0) {
    timeString = `${toBengaliDigits(hours)} ঘণ্টা ${toBengaliDigits(minutes)} মিনিট ${toBengaliDigits(seconds)} সেকেন্ড`;
  } else if (minutes > 0) {
    timeString = `${toBengaliDigits(minutes)} মিনিট ${toBengaliDigits(seconds)} সেকেন্ড`;
  } else {
    timeString = `${toBengaliDigits(seconds)} সেকেন্ড`;
  }

  return `অডিওর দৈর্ঘ্য: ${timeString}`;
}

function isAudioDocumentMessage(msg) {
  if (!msg || !msg.hasMedia) return false;

  // Strictly exclude voice notes / PTT
  if (msg.isVoice === true || msg.type === 'ptt') {
    return false;
  }

  const filename = (msg.filename || msg.body || '').toLowerCase();
  const mimetype = (msg.mimetype || '').toLowerCase();

  const isAudioExt = filename.endsWith('.mp3') || filename.endsWith('.wav');
  const isAudioMime = (
    mimetype.startsWith('audio/mpeg') ||
    mimetype.startsWith('audio/mp3') ||
    mimetype.startsWith('audio/wav') ||
    mimetype.startsWith('audio/x-wav') ||
    mimetype.startsWith('audio/wave')
  );

  return isAudioExt || isAudioMime;
}

async function getAudioDurationFromBuffer(buffer, mimeType) {
  if (!buffer || !Buffer.isBuffer(buffer)) return null;

  try {
    const metadata = await mm.parseBuffer(buffer, mimeType, { duration: true });
    return metadata?.format?.duration ?? null;
  } catch (err) {
    console.error('Error parsing audio buffer metadata:', err.message);
    return null;
  }
}

module.exports = {
  toBengaliDigits,
  formatAudioDuration,
  isAudioDocumentMessage,
  getAudioDurationFromBuffer
};
