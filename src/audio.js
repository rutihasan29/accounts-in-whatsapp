const mm = require('music-metadata');
const ffprobe = require('@ffprobe-installer/ffprobe');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

/**
 * Extracts duration using ffprobe binary
 */
async function getAudioDurationWithFFprobe(buffer, extension = '.mp3') {
  if (!buffer || !Buffer.isBuffer(buffer) || !ffprobe?.path) return null;

  const tempFile = path.join(
    os.tmpdir(),
    `temp_audio_${Date.now()}_${Math.random().toString(36).slice(2)}${extension}`
  );

  try {
    await fs.promises.writeFile(tempFile, buffer);
    return await new Promise((resolve) => {
      execFile(
        ffprobe.path,
        [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1',
          tempFile
        ],
        (err, stdout) => {
          if (err || !stdout) {
            return resolve(null);
          }
          const d = parseFloat(stdout.trim());
          resolve(!isNaN(d) && d >= 0 ? d : null);
        }
      );
    });
  } catch {
    return null;
  } finally {
    try {
      await fs.promises.unlink(tempFile);
    } catch {}
  }
}

/**
 * Parses duration from audio buffer via ffprobe, falling back to music-metadata
 */
async function getAudioDurationFromBuffer(buffer, mimeType, filename = '') {
  if (!buffer || !Buffer.isBuffer(buffer)) return null;

  // 1. Try ffprobe (requested by user)
  try {
    const ext = filename && filename.includes('.')
      ? path.extname(filename)
      : (mimeType && mimeType.includes('wav') ? '.wav' : '.mp3');
    const ffprobeDuration = await getAudioDurationWithFFprobe(buffer, ext);
    if (ffprobeDuration !== null && ffprobeDuration >= 0) {
      console.log(`[AUDIO] ffprobe extracted duration: ${ffprobeDuration}s`);
      return ffprobeDuration;
    }
  } catch (err) {
    console.warn('[AUDIO] ffprobe attempt failed:', err.message);
  }

  // 2. Fallback to music-metadata
  try {
    const metadata = await mm.parseBuffer(buffer, mimeType, { duration: true });
    if (metadata?.format?.duration !== undefined && metadata?.format?.duration !== null) {
      console.log(`[AUDIO] music-metadata extracted duration: ${metadata.format.duration}s`);
      return metadata.format.duration;
    }
  } catch (err) {
    console.warn('[AUDIO] music-metadata parse error:', err.message);
  }

  return null;
}

/**
 * Resolves duration using all available strategies (direct properties, in-page store, DOM, downloadManager, ffprobe)
 */
async function resolveAudioDuration({ msg, client }) {
  if (!msg) return null;

  const stanzaId = msg.id?.id;
  const targetId = msg.id?._serialized;
  const filename = msg.filename;
  const targetChat = msg.id?.remote || msg.to || msg.from;

  console.log(`[AUDIO] Resolving duration for "${filename || 'audio'}" (stanzaId: ${stanzaId}, to: ${targetChat})...`);

  // Helper to query in-page WhatsApp internal structures safely
  async function queryInPage() {
    if (!client?.pupPage || typeof client.pupPage.evaluate !== 'function') {
      return null;
    }

    try {
      return await client.pupPage.evaluate(async ({ targetId, stanzaId, filename, targetChat }) => {
        try {
          // Ensure chat is loaded into memory
          if (targetChat && window.WWebJS && typeof window.WWebJS.getChat === 'function') {
            try {
              await window.WWebJS.getChat(targetChat, { getAsModel: false });
            } catch {}
          }

          const collections = window.require('WAWebCollections');
          const msgCollection = collections?.Msg;
          if (!msgCollection) return { err: 'No Msg collection' };

          // 1. Find message by targetId, stanzaId, or filename (handles LID chats)
          let m = targetId ? msgCollection.get(targetId) : null;
          if (!m && stanzaId && Array.isArray(msgCollection.models)) {
            m = msgCollection.models.find((x) => x.id?.id === stanzaId);
          }
          if (!m && filename && Array.isArray(msgCollection.models)) {
            m = msgCollection.models.slice(-30).reverse().find(
              (x) => x.filename && x.filename.toLowerCase() === filename.toLowerCase()
            );
          }

          if (!m) return { err: 'Msg model not found in collection' };

          // 2. Direct duration fields on model
          const d = m.duration || m.mediaData?.duration || m._data?.duration || m._data?.seconds;
          if (d !== undefined && d !== null && !isNaN(Number(d)) && Number(d) >= 0) {
            return { duration: Number(d) };
          }

          // 3. Check DOM audio element if already rendered in UI
          const audioEl = (targetId ? document.querySelector(`[data-id="${targetId}"] audio`) : null) ||
            (stanzaId ? document.querySelector(`[data-id*="${stanzaId}"] audio`) : null);
          if (audioEl && audioEl.duration && !isNaN(audioEl.duration) && isFinite(audioEl.duration) && audioEl.duration >= 0) {
            return { duration: audioEl.duration };
          }

          // 4. Check if media blob or renderableUrl is available directly in memory
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

          if (m.mediaData?.file) {
            try {
              const buffer = await m.mediaData.file.arrayBuffer();
              const base64 = await window.WWebJS.arrayBufferToBase64Async(buffer);
              return { data: base64, mimetype: m.mimetype || 'audio/mpeg' };
            } catch {}
          }

          // 5. Try resolving mediaStage if not already RESOLVED
          if (m.mediaData && m.mediaData.mediaStage !== 'RESOLVED' && typeof m.downloadMedia === 'function') {
            try {
              await m.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
            } catch {}
          }

          // 6. Try downloadAndMaybeDecrypt with full fallback parameters
          const downloadManager = window.require('WAWebDownloadManager')?.downloadManager;
          const directPath = m.directPath || m.mediaData?.directPath;
          const mediaKey = m.mediaKey || m.mediaData?.mediaKey;
          const encFilehash = m.encFilehash || m.mediaData?.encFilehash;
          const filehash = m.filehash || m.mediaData?.filehash;
          const mediaKeyTimestamp = m.mediaKeyTimestamp || m.mediaData?.mediaKeyTimestamp;

          if (downloadManager && directPath && mediaKey) {
            try {
              const mockQpl = { addAnnotations: () => {}, addPoint: () => {} };
              const decrypted = await downloadManager.downloadAndMaybeDecrypt({
                directPath,
                encFilehash,
                filehash,
                mediaKey,
                mediaKeyTimestamp,
                type: m.type || 'document',
                signal: new AbortController().signal,
                downloadQpl: mockQpl
              });
              if (decrypted) {
                const base64 = await window.WWebJS.arrayBufferToBase64Async(decrypted);
                return { data: base64, mimetype: m.mimetype || 'audio/mpeg' };
              }
            } catch (decErr) {
              return { err: 'downloadAndMaybeDecrypt: ' + decErr.message };
            }
          }

          return {
            err: 'Media keys not ready',
            mediaStage: m.mediaData?.mediaStage,
            hasDp: !!directPath,
            hasMk: !!mediaKey
          };
        } catch (outer) {
          return { err: outer.message };
        }
      }, { targetId, stanzaId, filename, targetChat });
    } catch (evalErr) {
      return { err: evalErr.message };
    }
  }

  // Multi-attempt retry loop to accommodate media sync timing
  for (let attempt = 1; attempt <= 3; attempt++) {
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

    // 2. Query in-page state
    const inPageResult = await queryInPage();
    if (inPageResult?.duration !== undefined && inPageResult?.duration !== null) {
      return inPageResult.duration;
    }
    if (inPageResult?.data) {
      const buf = Buffer.from(inPageResult.data, 'base64');
      const d = await getAudioDurationFromBuffer(buf, inPageResult.mimetype || msg.mimetype, filename);
      if (d !== null && d >= 0) return d;
    }

    // 3. Try standard msg.downloadMedia() wrapped safely in try-catch
    if (typeof msg.downloadMedia === 'function') {
      try {
        const media = await msg.downloadMedia();
        if (media && media.data) {
          const buf = Buffer.from(media.data, 'base64');
          const d = await getAudioDurationFromBuffer(buf, media.mimetype || msg.mimetype, filename);
          if (d !== null && d >= 0) return d;
        }
      } catch (dmErr) {
        // Handled via fallback
      }
    }

    if (attempt < 3) {
      console.log(`[AUDIO] Attempt ${attempt} waiting for media sync...`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  return null;
}

module.exports = {
  toBengaliDigits,
  formatAudioDuration,
  isAudioDocumentMessage,
  getAudioDurationFromBuffer,
  getAudioDurationWithFFprobe,
  resolveAudioDuration
};
