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

/**
 * Calculates bill amount based on audio duration tiered formula:
 * Rate: 50 Taka per minute (ratePerMinute defaults to 50).
 * - Up to 1:08 (68 seconds) => counted as 1 minute (50 Taka)
 * - 1:09 to 1:19 (69s to 79s) => counted as 1.5 minutes (75 Taka)
 * - 1:20 to 2:08 (80s to 128s) => counted as 2 minutes (100 Taka)
 * - This exact tiered range continues for subsequent minutes:
 *   For any minute M >= 1:
 *     - Seconds <= 08s => M minutes (M * 50 Taka)
 *     - Seconds 09s..19s => M + 0.5 minutes ((M + 0.5) * 50 Taka)
 *     - Seconds >= 20s => M + 1 minutes ((M + 1) * 50 Taka)
 */
function calculateAudioBill(durationSeconds, ratePerMinute = 50) {
  if (durationSeconds === null || durationSeconds === undefined || isNaN(durationSeconds) || durationSeconds <= 0) {
    return 0;
  }

  const totalSeconds = Math.round(durationSeconds);
  if (totalSeconds <= 0) return 0;

  if (totalSeconds <= 68) {
    return 1 * ratePerMinute;
  }

  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;

  let billableMinutes;
  if (s <= 8) {
    billableMinutes = m;
  } else if (s <= 19) {
    billableMinutes = m + 0.5;
  } else {
    billableMinutes = m + 1;
  }

  return Math.round(billableMinutes * ratePerMinute * 100) / 100;
}

/**
 * Formats bill message into the required Bengali format:
 * 'বিল ১০০ টাকা'
 */
function formatBillMessage(amount) {
  if (amount === null || amount === undefined || isNaN(amount)) {
    return null;
  }
  return `বিল ${toBengaliDigits(amount)} টাকা`;
}

const BENGALI_DIGIT_MAP = {
  '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
  '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9'
};

/**
 * Extracts duration in seconds from audio filename or headline.
 * Supports:
 * - '(1m 23s)' or '(59s)'
 * - Bengali minutes.seconds: 'জামালপুরে ১.৪  .wav' (64s), 'দীর্ঘদিনের আন্দোলন সংগ্রামে ২.৪২ .wav' (162s), '১.২৫' (85s)
 * - Bengali standalone seconds: 'পরকীয়া ৪৫  .wav' (45s), 'ভালুকা ৪৭' (47s)
 */
function extractDurationFromFilename(filename) {
  if (!filename || typeof filename !== 'string') return null;
  const name = filename.replace(/\.[^/.]+$/, '').trim();

  // Pattern 1: (1m 23s) or (59s)
  const parenMatch = name.match(/\((\d+)\s*m\s*(\d+)\s*s\)/i);
  if (parenMatch) return parseInt(parenMatch[1], 10) * 60 + parseInt(parenMatch[2], 10);
  const parenSecMatch = name.match(/\((\d+)\s*s\)/i);
  if (parenSecMatch) return parseInt(parenSecMatch[1], 10);

  // Convert Bengali digits to ASCII
  const ascii = name.replace(/[০-৯]/g, (d) => BENGALI_DIGIT_MAP[d] || d);

  // Pattern 2: minutes:seconds or minutes.seconds e.g. "১.২৫", "২.৪২", "১:০৯", "১.৪"
  const minSecMatch = ascii.match(/(?:^|\s|[(\[])(\d+)[.:](\d{1,2})(?:\s*[)\]]|\s*$)/);
  if (minSecMatch) {
    const mins = parseInt(minSecMatch[1], 10);
    const secs = parseInt(minSecMatch[2], 10);
    if (secs < 60) return mins * 60 + secs;
  }

  // Pattern 3: standalone seconds e.g. "পরকীয়া ৪৫", "ভালুকা ৪৭"
  const secMatch = ascii.match(/(?:^|\s|[(\[])(\d{2,3})(?:\s*[)\]]|\s*$)/);
  if (secMatch) {
    const secs = parseInt(secMatch[1], 10);
    if (secs > 0 && secs < 3600) return secs;
  }

  return null;
}

/**
 * Extracts duration from text like '১ মিনিট ৯ সেকেন্ড' or '১ মিনিট ৩৭ সেকেন্ড'
 */
function extractDurationFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const ascii = text.replace(/[০-৯]/g, (d) => BENGALI_DIGIT_MAP[d] || d).trim();
  const minSecMatch = ascii.match(/(\d+)\s*(?:মিনিট|min|m)\s*(?:(\d+)\s*(?:সেকেন্ড|sec|s)?)?/i);
  if (minSecMatch) {
    const mins = parseInt(minSecMatch[1], 10);
    const secs = minSecMatch[2] ? parseInt(minSecMatch[2], 10) : 0;
    return mins * 60 + secs;
  }
  const secMatch = ascii.match(/(\d+)\s*(?:সেকেন্ড|sec|s)/i);
  if (secMatch) return parseInt(secMatch[1], 10);
  return null;
}

function isAudioDocumentMessage(msg) {
  if (!msg) return false;

  // Plain chat messages without media are not audio documents
  if (msg.type === 'chat' && !msg.hasMedia && !msg._data?.directPath && !msg._data?.mediaKey) {
    return false;
  }

  const rawFilename = msg.filename || msg._data?.filename || msg._data?.title || msg.body || '';
  const filename = String(rawFilename).toLowerCase();
  const mimetype = String(msg.mimetype || msg._data?.mimetype || '').toLowerCase();
  const type = String(msg.type || msg._data?.type || '').toLowerCase();

  const isAudioExt = /\.(mp3|wav|m4a|ogg|opus|aac|flac|wma)$/i.test(filename);
  const isAudioMime = mimetype.startsWith('audio/') || mimetype.includes('audio');

  // If filename clearly has an audio extension, it IS an audio document even if marked voice
  if (isAudioExt) {
    return true;
  }

  // Strictly exclude voice notes / PTT if they don't have an audio file extension
  if (msg.isVoice === true || msg.type === 'ptt' || msg._data?.isVoice === true || msg._data?.type === 'ptt') {
    return false;
  }

  if (type === 'audio') {
    return true;
  }

  return isAudioMime;
}

function isVideoDocumentMessage(msg) {
  if (!msg) return false;
  const hasMedia = Boolean(msg.hasMedia || msg._data?.directPath || msg._data?.mediaKey);
  if (!hasMedia) return false;

  const rawFilename = msg.filename || msg._data?.filename || msg._data?.title || msg.body || '';
  const filename = String(rawFilename).toLowerCase();
  const mimetype = String(msg.mimetype || msg._data?.mimetype || '').toLowerCase();
  const type = String(msg.type || msg._data?.type || '').toLowerCase();

  const isVideoExt = /\.(mp4|mov|mkv|avi|webm|3gp|m4v)$/i.test(filename);
  const isVideoMime = mimetype.startsWith('video/');

  return type === 'video' || ((type === 'document' || !type) && (isVideoExt || isVideoMime));
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
    console.log(`[AUDIO] Running ffprobe on buffer written to temporary file...`);
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
            console.warn('[AUDIO] ffprobe error:', err?.message || 'No stdout');
            return resolve(null);
          }
          const d = parseFloat(stdout.trim());
          if (!isNaN(d) && d >= 0) {
            console.log(`[AUDIO] ffprobe extracted duration: ${d}s`);
            return resolve(d);
          }
          resolve(null);
        }
      );
    });
  } catch (err) {
    console.warn('[AUDIO] Failed to write temp file for ffprobe:', err.message);
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
 * Resolves duration using all available strategies:
 * - Direct metadata from msg and msg._data
 * - Decryption via WAWebDownloadManager using msg._data keys
 * - In-page stores (WAWebCollections.Msg, WAWebCollections.Chat)
 * - DOM audio elements
 * - ffprobe audio parser
 */
async function resolveAudioDuration({ msg, client }) {
  if (!msg) return null;

  const stanzaId = msg.id?.id;
  const targetId = msg.id?._serialized;
  const filename = msg.filename || msg._data?.filename || msg._data?.title || '';
  const targetChat = msg.id?.remote || msg.to || msg.from;

  console.log(`[AUDIO] Resolving duration for "${filename || 'audio'}" (stanzaId: ${stanzaId}, to: ${targetChat})...`);

  // Direct metadata on msg object (instant, zero overhead)
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

  // Gather direct media keys from msg._data if available
  const directMediaParams = {
    directPath: msg._data?.directPath || msg.directPath,
    mediaKey: msg._data?.mediaKey || msg.mediaKey,
    encFilehash: msg._data?.encFilehash || msg.encFilehash,
    filehash: msg._data?.filehash || msg.filehash,
    mediaKeyTimestamp: msg._data?.mediaKeyTimestamp || msg.mediaKeyTimestamp,
    type: msg.type || msg._data?.type || 'document',
    mimetype: msg.mimetype || msg._data?.mimetype || 'audio/mpeg'
  };

  // Helper to query in-page WhatsApp internal structures safely
  async function queryInPage() {
    if (!client?.pupPage || typeof client.pupPage.evaluate !== 'function') {
      return null;
    }

    try {
      return await client.pupPage.evaluate(
        async ({ targetId, stanzaId, filename, targetChat, directMediaParams }) => {
          try {
            // 1. First: Try downloading and decrypting directly using directMediaParams if keys exist!
            const dm = window.require('WAWebDownloadManager')?.downloadManager;
            if (dm && directMediaParams.directPath && directMediaParams.mediaKey) {
              try {
                const mockQpl = { addAnnotations: () => {}, addPoint: () => {} };
                const decrypted = await dm.downloadAndMaybeDecrypt({
                  directPath: directMediaParams.directPath,
                  encFilehash: directMediaParams.encFilehash,
                  filehash: directMediaParams.filehash,
                  mediaKey: directMediaParams.mediaKey,
                  mediaKeyTimestamp: directMediaParams.mediaKeyTimestamp,
                  type: directMediaParams.type,
                  signal: new AbortController().signal,
                  downloadQpl: mockQpl
                });
                if (decrypted) {
                  const base64 = await window.WWebJS.arrayBufferToBase64Async(decrypted);
                  return { data: base64, mimetype: directMediaParams.mimetype };
                }
              } catch (directDecryptErr) {
                // Will try finding message model next
              }
            }

            // 2. Ensure chat is loaded into memory
            if (targetChat && window.WWebJS && typeof window.WWebJS.getChat === 'function') {
              try {
                await window.WWebJS.getChat(targetChat, { getAsModel: false });
              } catch {}
            }

            const collections = window.require('WAWebCollections');
            const msgCollection = collections?.Msg;

            // 3. Find message across Msg collection, Chat models, and recent messages
            let m = targetId && msgCollection ? msgCollection.get(targetId) : null;
            if (!m && stanzaId && Array.isArray(msgCollection?.models)) {
              m = msgCollection.models.find((x) => x.id?.id === stanzaId);
            }
            if (!m && collections?.Chat?.models) {
              for (const c of collections.Chat.models) {
                if (c.msgs?.models) {
                  const found = c.msgs.models.find((x) => x.id?.id === stanzaId || x.id?._serialized === targetId);
                  if (found) {
                    m = found;
                    break;
                  }
                }
              }
            }
            if (!m && filename && Array.isArray(msgCollection?.models)) {
              m = msgCollection.models.slice(-30).reverse().find(
                (x) => x.filename && x.filename.toLowerCase() === filename.toLowerCase()
              );
            }

            if (!m) {
              return { err: 'Msg model not found in WhatsApp Web cache' };
            }

            // 4. Direct duration fields on model
            const d = m.duration || m.mediaData?.duration || m._data?.duration || m._data?.seconds;
            if (d !== undefined && d !== null && !isNaN(Number(d)) && Number(d) >= 0) {
              return { duration: Number(d) };
            }

            // 5. Check DOM audio element if already rendered in UI
            const audioEl = (targetId ? document.querySelector(`[data-id="${targetId}"] audio`) : null) ||
              (stanzaId ? document.querySelector(`[data-id*="${stanzaId}"] audio`) : null);
            if (audioEl && audioEl.duration && !isNaN(audioEl.duration) && isFinite(audioEl.duration) && audioEl.duration >= 0) {
              return { duration: audioEl.duration };
            }

            // 6. Check if media blob or renderableUrl is available directly in memory
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

            // 7. Try resolving mediaStage if not already RESOLVED
            if (m.mediaData && m.mediaData.mediaStage !== 'RESOLVED' && typeof m.downloadMedia === 'function') {
              try {
                await m.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
              } catch {}
            }

            // 8. Try downloadAndMaybeDecrypt with parameters from model
            const directPath = m.directPath || m.mediaData?.directPath;
            const mediaKey = m.mediaKey || m.mediaData?.mediaKey;
            const encFilehash = m.encFilehash || m.mediaData?.encFilehash;
            const filehash = m.filehash || m.mediaData?.filehash;
            const mediaKeyTimestamp = m.mediaKeyTimestamp || m.mediaData?.mediaKeyTimestamp;

            if (dm && directPath && mediaKey) {
              try {
                const mockQpl = { addAnnotations: () => {}, addPoint: () => {} };
                const decrypted = await dm.downloadAndMaybeDecrypt({
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
        },
        { targetId, stanzaId, filename, targetChat, directMediaParams }
      );
    } catch (evalErr) {
      return { err: evalErr.message };
    }
  }

  // Multi-attempt retry loop to accommodate media sync timing
  for (let attempt = 1; attempt <= 3; attempt++) {
    // 1. Direct metadata on msg object (re-checked in case patched)
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
      const d = await getAudioDurationFromBuffer(buf, inPageResult.mimetype || msg.mimetype || msg._data?.mimetype, filename);
      if (d !== null && d >= 0) return d;
    }
    if (inPageResult?.err) {
      console.log(`[AUDIO] Attempt ${attempt} diagnostic:`, inPageResult.err);
    }

    // 3. Try standard msg.downloadMedia() wrapped safely in try-catch
    if (typeof msg.downloadMedia === 'function') {
      try {
        const media = await msg.downloadMedia();
        if (media && media.data) {
          const buf = Buffer.from(media.data, 'base64');
          const d = await getAudioDurationFromBuffer(buf, media.mimetype || msg.mimetype || msg._data?.mimetype, filename);
          if (d !== null && d >= 0) return d;
        }
      } catch (dmErr) {
        // Will continue to retry or in-page fallback
      }
    }

    if (attempt < 3) {
      console.log(`[AUDIO] Attempt ${attempt} waiting for media sync...`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  // 4. Reliable Fallback: Parse duration from filename or caption/text
  const fallbackDuration = extractDurationFromFilename(filename) ||
    extractDurationFromFilename(msg.filename) ||
    extractDurationFromFilename(msg._data?.filename) ||
    extractDurationFromFilename(msg._data?.title) ||
    extractDurationFromText(msg.body);

  if (fallbackDuration !== null && fallbackDuration > 0) {
    console.log(`[AUDIO] Successfully extracted fallback duration ${fallbackDuration}s from filename/text "${filename || msg.body}"`);
    return fallbackDuration;
  }

  return null;
}

/**
 * Checks if a string contains Bengali Unicode characters (\u0980-\u09FF).
 */
function hasBengaliCharacters(str) {
  return Boolean(str && /[\u0980-\u09FF]/.test(String(str)));
}

/**
 * Formats duration in seconds for inclusion in voice filenames.
 * E.g.:
 * - under 60s: '45s', '0s'
 * - 60s or more: '1m 23s', '1m 0s', '2m 0s'
 */
function formatDurationForFilename(seconds) {
  const rounded = Math.max(0, Math.round(Number(seconds) || 0));
  if (rounded < 60) {
    return `${rounded}s`;
  }
  const min = Math.floor(rounded / 60);
  const sec = rounded % 60;
  return `${min}m ${sec}s`;
}

/**
 * Extracts a concise Bengali headline from a script text.
 * - Extracts first non-empty line of the script.
 * - Strips system brackets [নতুন ভয়েস অর্ডার], URLs, HTML tags, emojis, markdown, and punctuation.
 * - Splits into words and prioritizes words containing Bengali characters.
 * - Takes up to maxWords (default 5).
 * - Falls back to 'ভয়েস স্ক্রিপ্ট' if empty, null, or no Bengali characters found.
 */
function extractHeadline(scriptText, maxWords = 5) {
  if (!scriptText || typeof scriptText !== 'string') {
    return 'ভয়েস স্ক্রিপ্ট';
  }

  const limit = typeof maxWords === 'number' && maxWords > 0 ? maxWords : 5;

  // Clean bracketed system headers like [নতুন ভয়েস অর্ডার]
  const cleanedText = scriptText.replace(/\[[^\]]*\]/g, ' ');
  const lines = cleanedText.split(/\r?\n/);

  for (let line of lines) {
    let clean = line.replace(/https?:\/\/\S+|www\.\S+/gi, ' ');
    clean = clean.replace(/<[^>]+>/g, ' ');
    clean = clean.replace(/\p{Extended_Pictographic}/gu, ' ');
    clean = clean.replace(/[*_~#`]/g, ' ');
    clean = clean.replace(/[!"$%&'()*+,\-./:;<=>?@[\\\]^{|}~।॥«»“”‘’]/g, ' ');
    clean = clean.replace(/^(?:স্ক্রিপ্ট|script)\s*[:ঃ]?\s*/gi, ' ');

    const words = clean.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    const bengaliWords = words.filter((w) => /[\u0980-\u09FF]/.test(w));
    if (bengaliWords.length > 0) {
      return bengaliWords.slice(0, limit).join(' ');
    }
  }

  return 'ভয়েস স্ক্রিপ্ট';
}

/**
 * Builds a clean Bengali audio filename:
 * `${cleanHeadline} (${formatDurationForFilename(durationSeconds)}).${cleanExt}`
 * E.g.: 'নবাবপুর ফুড সিটি (1m 23s).mp3'
 */
function buildCleanVoiceFilename({ headline, durationSeconds, ext = 'mp3' } = {}) {
  const cleanHeadline = (headline ? String(headline) : '')
    .replace(/[\\/:*?"<>|\r\n]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ') || 'ভয়েস স্ক্রিপ্ট';

  const cleanExt = (ext ? String(ext) : 'mp3')
    .replace(/^\./, '')
    .replace(/[\\/:*?"<>|\r\n]/g, '')
    .trim() || 'mp3';

  const formattedDuration = formatDurationForFilename(durationSeconds);
  return `${cleanHeadline} (${formattedDuration}).${cleanExt}`;
}

module.exports = {
  toBengaliDigits,
  formatAudioDuration,
  calculateAudioBill,
  formatBillMessage,
  isAudioDocumentMessage,
  isVideoDocumentMessage,
  getAudioDurationFromBuffer,
  getAudioDurationWithFFprobe,
  resolveAudioDuration,
  hasBengaliCharacters,
  formatDurationForFilename,
  extractHeadline,
  buildCleanVoiceFilename,
  extractDurationFromFilename,
  extractDurationFromText
};
