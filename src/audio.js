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

async function resolveAudioDuration({ msg, client }) {
  if (!msg) return null;

  // 1. Direct metadata on msg object (instant, zero overhead)
  if (msg.duration !== undefined && msg.duration !== null) {
    const d = parseFloat(msg.duration);
    if (!isNaN(d) && d >= 0) return d;
  }
  if (msg._data?.duration) {
    const d = parseFloat(msg._data.duration);
    if (!isNaN(d) && d >= 0) return d;
  }
  if (msg._data?.seconds) {
    const d = parseFloat(msg._data.seconds);
    if (!isNaN(d) && d >= 0) return d;
  }

  const msgId = msg.id?._serialized;

  // Helper to query in-page WhatsApp internal structures safely
  async function queryInPage() {
    if (!client?.pupPage || typeof client.pupPage.evaluate !== 'function' || !msgId) {
      return null;
    }

    try {
      return await client.pupPage.evaluate(async (targetId) => {
        try {
          const collections = window.require('WAWebCollections');
          const m = collections?.Msg?.get(targetId) ||
            (await collections?.Msg?.getMessagesById([targetId]))?.messages?.[0];

          if (!m) return null;

          // Check internal duration fields
          const d = m.duration || m.mediaData?.duration || m._data?.duration || m._data?.seconds;
          if (d !== undefined && d !== null && !isNaN(Number(d)) && Number(d) >= 0) {
            return { duration: Number(d) };
          }

          // Check DOM audio element if already rendered
          const audioEl = document.querySelector(`[data-id="${targetId}"] audio`);
          if (audioEl && audioEl.duration && !isNaN(audioEl.duration) && isFinite(audioEl.duration) && audioEl.duration >= 0) {
            return { duration: audioEl.duration };
          }

          // Check if media blob or renderableUrl is available directly in memory
          if (m.mediaData?.renderableUrl) {
            try {
              const resp = await fetch(m.mediaData.renderableUrl);
              const blob = await resp.blob();
              const buffer = await blob.arrayBuffer();
              const base64 = await window.WWebJS.arrayBufferToBase64Async(buffer);
              return { data: base64, mimetype: m.mimetype || 'audio/mpeg' };
            } catch {}
          }

          if (m.mediaData?.blob) {
            try {
              const buffer = await m.mediaData.blob.arrayBuffer();
              const base64 = await window.WWebJS.arrayBufferToBase64Async(buffer);
              return { data: base64, mimetype: m.mimetype || 'audio/mpeg' };
            } catch {}
          }
        } catch {}
        return null;
      }, msgId);
    } catch {
      return null;
    }
  }

  // 2. Query in-page state
  let inPageResult = await queryInPage();
  if (inPageResult?.duration !== undefined && inPageResult?.duration !== null) {
    return inPageResult.duration;
  }
  if (inPageResult?.data) {
    const buf = Buffer.from(inPageResult.data, 'base64');
    const d = await getAudioDurationFromBuffer(buf, inPageResult.mimetype || msg.mimetype);
    if (d !== null && d >= 0) return d;
  }

  // 3. Try standard msg.downloadMedia() wrapped safely in try-catch
  if (typeof msg.downloadMedia === 'function') {
    try {
      const media = await msg.downloadMedia();
      if (media && media.data) {
        const buf = Buffer.from(media.data, 'base64');
        const d = await getAudioDurationFromBuffer(buf, media.mimetype || msg.mimetype);
        if (d !== null && d >= 0) return d;
      }
    } catch (dmErr) {
      console.warn('[AUDIO] msg.downloadMedia initial attempt failed:', dmErr.message);
    }
  }

  // 4. Retry after a short delay (1.5s) in case media was still syncing when message_create fired
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // Re-check direct properties
  if (msg.duration !== undefined && msg.duration !== null) {
    const d = parseFloat(msg.duration);
    if (!isNaN(d) && d >= 0) return d;
  }
  if (msg._data?.duration) {
    const d = parseFloat(msg._data.duration);
    if (!isNaN(d) && d >= 0) return d;
  }

  // Re-query in-page
  inPageResult = await queryInPage();
  if (inPageResult?.duration !== undefined && inPageResult?.duration !== null) {
    return inPageResult.duration;
  }
  if (inPageResult?.data) {
    const buf = Buffer.from(inPageResult.data, 'base64');
    const d = await getAudioDurationFromBuffer(buf, inPageResult.mimetype || msg.mimetype);
    if (d !== null && d >= 0) return d;
  }

  // Final safe attempt with downloadMedia
  if (typeof msg.downloadMedia === 'function') {
    try {
      const media = await msg.downloadMedia();
      if (media && media.data) {
        const buf = Buffer.from(media.data, 'base64');
        const d = await getAudioDurationFromBuffer(buf, media.mimetype || msg.mimetype);
        if (d !== null && d >= 0) return d;
      }
    } catch {}
  }

  return null;
}

module.exports = {
  toBengaliDigits,
  formatAudioDuration,
  isAudioDocumentMessage,
  getAudioDurationFromBuffer,
  resolveAudioDuration
};

