const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ffmpeg = require('@ffmpeg-installer/ffmpeg');
const ffprobe = require('@ffprobe-installer/ffprobe');
const config = require('./config');
const { getAudioDurationFromBuffer } = require('./audio');

/**
 * Broadcast News Voiceover Editor System Prompt
 * Ported from aircheck_-voiceover-mistake-&-retake-remover2/server.ts
 */
const VOICEOVER_PROMPT = (duration) => `You are a senior broadcast news voiceover editor.
Analyze this voiceover audio recording (Total duration: ${duration ? Number(duration).toFixed(2) : 'unknown'}s).

HOW NEWS VOICEOVER RETAKES WORK:
When a voice artist makes a mistake (slip of the tongue, mispronunciation, stutter, false start, or wrong word):
1. They speak the mistaken phrase or partial sentence (e.g., "Winds are expected to reach Category for- fiv-...").
2. They STOP and PAUSE (usually 0.5s to 4.0s of silence) to reset.
3. They RE-READ from the beginning of that clause or sentence (e.g., "Winds are expected to reach Category three intensity by dawn.") and continue.

CRITICAL RULE FOR ACCURATE CUTS (DO NOT CUT IN WRONG PLACES):
- Look at the first few words of the clean RETAKE after the pause.
- Trace back before the pause to where those exact words (or that aborted clause/phrase) originally started!
- You MUST remove the ENTIRE aborted attempt from where it started (plus the pause), up to the exact start of the clean retake.
- DO NOT cut normal pauses between two different sentences where nothing was flubbed or repeated.`;

/**
 * JSON Schema for Structured Gemini Voiceover Mistake & Retake Analysis
 */
const VOICEOVER_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    overallTranscript: {
      type: 'STRING',
      description: 'Full verbatim transcription of everything spoken in the audio, including slips and retakes.'
    },
    summary: {
      type: 'STRING',
      description: 'Brief summary of voiceover quality and edits found.'
    },
    mistakesAndRetakes: {
      type: 'ARRAY',
      description: 'List of detected slips of the tongue and retake events.',
      items: {
        type: 'OBJECT',
        properties: {
          cutStartTime: {
            type: 'NUMBER',
            description: 'Exact timestamp in seconds where the cut begins (start of the aborted phrase/clause).'
          },
          cutEndTime: {
            type: 'NUMBER',
            description: 'Exact timestamp in seconds where the cut ends (start of the clean retake).'
          },
          mistakeText: {
            type: 'STRING',
            description: 'The entire flubbed or aborted clause spoken before the pause.'
          },
          retakeText: {
            type: 'STRING',
            description: 'The corrected clause spoken after the pause.'
          },
          reason: {
            type: 'STRING',
            description: 'Why this was identified as a slip of the tongue and retake.'
          },
          confidence: {
            type: 'NUMBER',
            description: 'Confidence score from 0.0 to 1.0.'
          }
        },
        required: [
          'cutStartTime',
          'cutEndTime',
          'mistakeText',
          'retakeText',
          'reason',
          'confidence'
        ]
      }
    }
  },
  required: ['overallTranscript', 'mistakesAndRetakes']
};

/**
 * Multi-Model Cascade Candidates
 */
const DEFAULT_CANDIDATE_CONFIGS = [
  { model: 'gemini-3.8-flash', thinkingConfig: { thinkingLevel: 'low' } },
  { model: 'gemini-flash-latest' },
  { model: 'gemini-3.5-flash-lite' },
  { model: 'gemini-3.5-flash' }
];

/**
 * Helper to strip markdown code fences (```json ... ``` or ``` ... ```)
 */
function cleanJsonString(str) {
  if (!str || typeof str !== 'string') return '';
  let trimmed = str.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    trimmed = fenceMatch[1].trim();
  } else if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }
  return trimmed;
}

/**
 * Computes kept audio intervals by inverting mistake cut regions over [0, totalDuration]
 *
 * @param {Object|number} opts Options object or totalDuration number
 * @param {Array} [maybeCuts] Cuts array if first arg is totalDuration
 * @returns {Array<{ start: number, end: number }>} Kept segments
 */
function computeKeptSegments(opts, maybeCuts) {
  let totalDuration;
  let cuts;

  if (typeof opts === 'number') {
    totalDuration = opts;
    cuts = maybeCuts;
  } else if (opts && typeof opts === 'object') {
    totalDuration = opts.totalDuration;
    cuts = opts.cuts;
  } else {
    return [];
  }

  totalDuration = Number(totalDuration) || 0;
  if (totalDuration <= 0) {
    return [];
  }

  if (!Array.isArray(cuts) || cuts.length === 0) {
    return [{ start: 0, end: totalDuration }];
  }

  // Filter cuts where cutEndTime > cutStartTime and within [0, totalDuration]
  const validCuts = cuts
    .map(c => {
      const start = Math.max(0, Number(c.cutStartTime || 0));
      const end = Math.min(totalDuration, Number(c.cutEndTime || 0));
      return { start, end };
    })
    .filter(c => !isNaN(c.start) && !isNaN(c.end) && c.end > c.start);

  if (validCuts.length === 0) {
    return [{ start: 0, end: totalDuration }];
  }

  // Sort by start, then end
  validCuts.sort((a, b) => a.start - b.start || a.end - b.end);

  // Merge overlapping or contiguous cuts
  const mergedCuts = [];
  let current = { ...validCuts[0] };

  for (let i = 1; i < validCuts.length; i++) {
    const next = validCuts[i];
    if (next.start <= current.end) {
      current.end = Math.max(current.end, next.end);
    } else {
      mergedCuts.push(current);
      current = { ...next };
    }
  }
  mergedCuts.push(current);

  // Invert merged cuts to compute kept segments covering [0, totalDuration]
  const keptSegments = [];
  let cursor = 0;

  for (const cut of mergedCuts) {
    if (cut.start > cursor) {
      const segStart = Number(cursor.toFixed(4));
      const segEnd = Number(cut.start.toFixed(4));
      if (segEnd > segStart) {
        keptSegments.push({ start: segStart, end: segEnd });
      }
    }
    cursor = Math.max(cursor, cut.end);
  }

  if (cursor < totalDuration) {
    const segStart = Number(cursor.toFixed(4));
    const segEnd = Number(totalDuration.toFixed(4));
    if (segEnd > segStart) {
      keptSegments.push({ start: segStart, end: segEnd });
    }
  }

  return keptSegments;
}

/**
 * Slices and concatenates kept segments using bundled FFmpeg
 *
 * @param {Object} params
 * @param {string} params.inputPath Path to input audio file
 * @param {string} params.outputPath Path to output audio file
 * @param {Array<{ start: number, end: number }>} params.keptSegments Segments to retain
 * @returns {Promise<string>} Resolves with outputPath
 */
function spliceAudioWithFFmpeg({ inputPath, outputPath, keptSegments }) {
  return new Promise((resolve, reject) => {
    if (!inputPath || !outputPath) {
      return reject(new Error('spliceAudioWithFFmpeg requires inputPath and outputPath'));
    }
    if (!Array.isArray(keptSegments) || keptSegments.length === 0) {
      return reject(new Error('spliceAudioWithFFmpeg: keptSegments is empty'));
    }

    const n = keptSegments.length;
    let filterComplex;

    if (n === 1) {
      const seg = keptSegments[0];
      filterComplex = `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[aout]`;
    } else {
      const trimParts = keptSegments.map((seg, i) => {
        return `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`;
      });
      const concatInputs = keptSegments.map((_, i) => `[a${i}]`).join('');
      filterComplex = `${trimParts.join(';')};${concatInputs}concat=n=${n}:v=0:a=1[aout]`;
    }

    const args = [
      '-y',
      '-i', inputPath,
      '-filter_complex', filterComplex,
      '-map', '[aout]',
      outputPath
    ];

    execFile(ffmpeg.path, args, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`FFmpeg splice failed: ${err.message} (stderr: ${stderr})`));
      }
      resolve(outputPath);
    });
  });
}

/**
 * High-level helper to splice audio cuts directly
 */
async function spliceAudioCuts({ inputPath, outputPath, cuts = [], totalDuration }) {
  const keptSegments = computeKeptSegments({ totalDuration, cuts });
  if (keptSegments.length === 0) {
    throw new Error('spliceAudioCuts: No audio remaining after applying cuts');
  }
  await spliceAudioWithFFmpeg({ inputPath, outputPath, keptSegments });
  const durationSeconds = keptSegments.reduce((sum, s) => sum + (s.end - s.start), 0);
  return {
    outputPath,
    durationSeconds: Number(durationSeconds.toFixed(4)),
    cutsApplied: cuts.length,
    keptSegments
  };
}

let lastPoolSignature = '';
let currentAudioKeyIndex = 0;

function resetAudioKeyRotation(index = 0) {
  currentAudioKeyIndex = index;
  lastPoolSignature = '';
}

function getAudioApiKeysPool(customKey = undefined) {
  if (customKey !== undefined) {
    if (Array.isArray(customKey)) {
      return customKey.map(k => String(k).trim()).filter(Boolean);
    }
    if (typeof customKey === 'string') {
      return customKey.split(/[,;\n]/).map(k => k.trim()).filter(Boolean);
    }
  }

  if (Array.isArray(config.GEMINI_AUDIO_API_KEYS) && config.GEMINI_AUDIO_API_KEYS.length > 0) {
    if (config.GEMINI_AUDIO_API_KEY && !config.GEMINI_AUDIO_API_KEYS.includes(config.GEMINI_AUDIO_API_KEY)) {
      return [config.GEMINI_AUDIO_API_KEY];
    }
    return [...config.GEMINI_AUDIO_API_KEYS];
  }

  if (config.GEMINI_AUDIO_API_KEY) {
    return typeof config.GEMINI_AUDIO_API_KEY === 'string'
      ? config.GEMINI_AUDIO_API_KEY.split(/[,;\n]/).map(k => k.trim()).filter(Boolean)
      : [config.GEMINI_AUDIO_API_KEY];
  }

  if (config.GEMINI_API_KEY) {
    return [config.GEMINI_API_KEY];
  }

  return [];
}

function getRotatedAudioKeys(customKey = undefined) {
  const pool = getAudioApiKeysPool(customKey);
  if (pool.length === 0) return [];
  if (pool.length === 1) return pool;

  const poolSig = pool.join('||');
  if (poolSig !== lastPoolSignature) {
    lastPoolSignature = poolSig;
    currentAudioKeyIndex = 0;
  }

  const startIdx = currentAudioKeyIndex % pool.length;
  currentAudioKeyIndex = (currentAudioKeyIndex + 1) % pool.length;

  const rotated = [];
  for (let i = 0; i < pool.length; i++) {
    rotated.push(pool[(startIdx + i) % pool.length]);
  }
  return rotated;
}

/**
 * Analyzes audio for voiceover retakes using multi-model cascade with exponential backoff
 */
async function analyzeVoiceoverWithGemini({
  audioBuffer,
  mimeType = 'audio/wav',
  duration = 0,
  apiKey = undefined,
  fetchFn = globalThis.fetch,
  candidates = DEFAULT_CANDIDATE_CONFIGS,
  timeoutMs = 60000,
  backoffMs = undefined
} = {}) {
  const keys = getRotatedAudioKeys(apiKey);
  if (keys.length === 0) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const audioBase64 = Buffer.isBuffer(audioBuffer)
    ? audioBuffer.toString('base64')
    : (typeof audioBuffer === 'string' ? audioBuffer : '');

  if (!audioBase64) {
    throw new Error('audioBuffer is required');
  }

  const effectiveBackoff = backoffMs !== undefined
    ? backoffMs
    : (process.env.NODE_ENV === 'test' ? 10 : 700);

  const cleanMime = (mimeType || 'audio/wav').split(';')[0].trim();
  const prompt = VOICEOVER_PROMPT(duration);

  let lastError = null;

  for (const candidate of candidates) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      let candidateCompleted = false;

      for (let kIdx = 0; kIdx < keys.length; kIdx++) {
        const effectiveKey = keys[kIdx];
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const generationConfig = {
            responseMimeType: 'application/json',
            responseSchema: VOICEOVER_RESPONSE_SCHEMA,
            temperature: 0.1
          };

          if (candidate.thinkingConfig) {
            generationConfig.thinkingConfig = candidate.thinkingConfig;
          }

          const payload = {
            contents: [
              {
                parts: [
                  {
                    inlineData: {
                      mimeType: cleanMime,
                      data: audioBase64
                    }
                  },
                  {
                    text: prompt
                  }
                ]
              }
            ],
            generationConfig
          };

          const url = `https://generativelanguage.googleapis.com/v1beta/models/${candidate.model}:generateContent?key=${effectiveKey}`;
          const res = await fetchFn(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
          });

          if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            const err = new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);

            // If 429 quota exhaustion or 403, and additional keys exist, rotate immediately!
            if ((res.status === 429 || res.status === 403) && kIdx < keys.length - 1) {
              console.warn(`[AirCheck AI] Key (...${effectiveKey.slice(-6)}) hit HTTP ${res.status} quota limit. Rotating to next key in pool...`);
              lastError = err;
              continue;
            }
            throw err;
          }

          const data = await res.json();
          const rawText = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
          if (!rawText) {
            throw new Error(`Empty response from ${candidate.model}`);
          }

          const cleanedJson = cleanJsonString(rawText);
          const parsedData = JSON.parse(cleanedJson);

          const mistakesAndRetakes = Array.isArray(parsedData.mistakesAndRetakes)
            ? parsedData.mistakesAndRetakes
            : [];

          return {
            overallTranscript: parsedData.overallTranscript || '',
            mistakesAndRetakes,
            cuts: mistakesAndRetakes,
            modelUsed: candidate.model,
            keyUsed: effectiveKey,
            data: parsedData
          };
        } catch (err) {
          lastError = err;
          break; // For non-429 errors (500, 503, etc), break key loop to proceed with retry/backoff
        } finally {
          clearTimeout(timeout);
        }
      }

      console.warn(`[AirCheck AI] ${candidate.model} (attempt ${attempt}) error: ${lastError?.message}`);
      if (attempt < 2 && effectiveBackoff > 0) {
        await new Promise(r => setTimeout(r, effectiveBackoff * attempt));
      }
    }
  }

  throw new Error(`All Gemini audio models were temporarily unreachable (${lastError?.message || 'Service busy'}).`);
}

/**
 * End-to-end Voiceover Retake Remover & Audio Splicer
 *
 * 1. Measures original duration via getAudioDurationFromBuffer
 * 2. Calls Gemini retake analysis
 * 3. If no cuts found, returns original audioBuffer
 * 4. If cuts found, runs FFmpeg splice and returns cleaned buffer
 * 5. On API or splice error, gracefully falls back to original audioBuffer
 */
async function cleanVoiceoverAudio({
  audioBuffer,
  filename = 'voiceover.wav',
  mimeType = 'audio/wav',
  fetchFn = globalThis.fetch,
  apiKey = undefined,
  duration = null,
  backoffMs = undefined
} = {}) {
  if (!audioBuffer) {
    throw new Error('audioBuffer is required');
  }

  const buf = Buffer.isBuffer(audioBuffer)
    ? audioBuffer
    : Buffer.from(audioBuffer, typeof audioBuffer === 'string' ? 'base64' : undefined);

  // 1. Measures original duration via getAudioDurationFromBuffer
  let originalDuration = duration;
  if (!originalDuration || originalDuration <= 0) {
    try {
      originalDuration = await getAudioDurationFromBuffer(buf, mimeType, filename);
    } catch (err) {
      console.warn('[AirCheck] Failed to measure original duration with getAudioDurationFromBuffer:', err.message);
    }
  }
  originalDuration = Number(originalDuration) || 0;

  // 2. Calls Gemini retake analysis
  let analysis;
  try {
    analysis = await analyzeVoiceoverWithGemini({
      audioBuffer: buf,
      mimeType,
      duration: originalDuration,
      apiKey,
      fetchFn,
      backoffMs
    });
  } catch (err) {
    // 5. Safe fallback if all Gemini models fail or throw
    console.warn('[AirCheck] Retake analysis failed across all models, falling back to original audio:', err.message);
    return {
      cleanBuffer: buf,
      durationSeconds: originalDuration,
      cutsCount: 0,
      modelUsed: 'fallback',
      failed: true,
      error: err.message,
      cuts: []
    };
  }

  const rawCuts = analysis?.mistakesAndRetakes || analysis?.cuts || [];
  const validCuts = rawCuts.filter(c => Number(c.cutEndTime) > Number(c.cutStartTime));

  // 3. If no cuts found, returns cleanBuffer: audioBuffer
  if (validCuts.length === 0) {
    return {
      cleanBuffer: buf,
      durationSeconds: originalDuration,
      cutsCount: 0,
      modelUsed: analysis.modelUsed,
      cuts: []
    };
  }

  // 4. If cuts found, writes temp input, runs FFmpeg splice to temp output
  const ext = (filename && filename.includes('.'))
    ? path.extname(filename)
    : (mimeType && mimeType.includes('wav') ? '.wav' : '.mp3');

  const rand = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const tempInput = path.join(os.tmpdir(), `aircheck_in_${rand}${ext}`);
  const tempOutput = path.join(os.tmpdir(), `aircheck_out_${rand}${ext}`);

  try {
    await fs.promises.writeFile(tempInput, buf);

    // Effective duration for interval inversion
    const effectiveDuration = originalDuration > 0
      ? originalDuration
      : Math.max(...validCuts.map(c => Number(c.cutEndTime || 0))) + 1;

    const keptSegments = computeKeptSegments({
      totalDuration: effectiveDuration,
      cuts: validCuts
    });

    if (keptSegments.length === 0) {
      console.warn('[AirCheck] All segments were cut; returning original buffer as fallback');
      return {
        cleanBuffer: buf,
        durationSeconds: originalDuration,
        cutsCount: 0,
        modelUsed: analysis.modelUsed,
        cuts: []
      };
    }

    await spliceAudioWithFFmpeg({
      inputPath: tempInput,
      outputPath: tempOutput,
      keptSegments
    });

    const cleanBuffer = await fs.promises.readFile(tempOutput);

    let cleanDuration = null;
    try {
      cleanDuration = await getAudioDurationFromBuffer(cleanBuffer, mimeType, filename);
    } catch {}

    if (!cleanDuration || cleanDuration <= 0) {
      cleanDuration = keptSegments.reduce((sum, s) => sum + (s.end - s.start), 0);
    }
    cleanDuration = Number(cleanDuration.toFixed(4));

    return {
      cleanBuffer,
      durationSeconds: cleanDuration,
      cutsCount: validCuts.length,
      modelUsed: analysis.modelUsed,
      cuts: validCuts
    };
  } catch (spliceErr) {
    console.warn('[AirCheck] FFmpeg splice failed, falling back to original audio:', spliceErr.message);
    return {
      cleanBuffer: buf,
      durationSeconds: originalDuration,
      cutsCount: 0,
      modelUsed: analysis.modelUsed || 'splice_fallback',
      failed: true,
      error: spliceErr.message,
      cuts: []
    };
  } finally {
    try { await fs.promises.unlink(tempInput); } catch {}
    try { await fs.promises.unlink(tempOutput); } catch {}
  }
}

module.exports = {
  VOICEOVER_PROMPT,
  VOICEOVER_RESPONSE_SCHEMA,
  DEFAULT_CANDIDATE_CONFIGS,
  cleanJsonString,
  computeKeptSegments,
  spliceAudioWithFFmpeg,
  spliceAudioCuts,
  analyzeVoiceoverWithGemini,
  cleanVoiceoverAudio,
  getRotatedAudioKeys,
  getAudioApiKeysPool,
  resetAudioKeyRotation
};
