const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ffmpeg = require('@ffmpeg-installer/ffmpeg');
const ffprobe = require('@ffprobe-installer/ffprobe');
const config = require('./config');
const { getAudioDurationFromBuffer } = require('./audio');

/**
 * Default Splice Settings (Ported from standalone AirCheck app)
 */
const DEFAULT_SPLICE_SETTINGS = {
  crossfadeDurationMs: 12,  // 12ms equal-power cosine crossfade
  searchWindowMs: 150,       // +/- ms around cut point to find silence valley
  breathPaddingMs: 80,       // ms of natural silence to preserve at splice
  snapToZeroCrossing: true,
};

/**
 * Broadcast News Voiceover Editor System Prompt
 * Injects ground-truth acoustic phrase boundaries measured via waveform DSP
 */
const VOICEOVER_PROMPT = (duration, acousticPhrases = []) => {
  const phraseTableText =
    Array.isArray(acousticPhrases) && acousticPhrases.length > 0
      ? acousticPhrases
          .map(
            (p) =>
              `Phrase #${p.index}: [${Number(p.startTime).toFixed(2)}s - ${Number(p.endTime).toFixed(2)}s] (duration: ${Number(p.duration).toFixed(2)}s, silence pause after: ${Number(p.pauseAfter).toFixed(2)}s)`
          )
          .join('\n')
      : 'No pre-computed phrase table provided.';

  return `You are a senior broadcast news voiceover editor.
Analyze this voiceover audio recording (Total duration: ${duration ? Number(duration).toFixed(2) : 'unknown'}s).

GROUND-TRUTH ACOUSTIC PHRASE BOUNDARIES (measured from the audio waveform via DSP):
${phraseTableText}

HOW NEWS VOICEOVER RETAKES WORK:
When a voice artist makes a mistake (slip of the tongue, mispronunciation, stutter, false start, or wrong word):
1. They speak the mistaken phrase or partial sentence (e.g., "Winds are expected to reach Category for- fiv-...").
2. They STOP and PAUSE (usually 0.5s to 4.0s of silence) to reset.
3. They RE-READ from the beginning of that clause or sentence (e.g., "Winds are expected to reach Category three intensity by dawn.") and continue.

CRITICAL RULE FOR ACCURATE CUTS (DO NOT CUT IN WRONG PLACES):
- Look at the first few words of the clean RETAKE after the pause.
- Trace back before the pause to where those exact words (or that aborted clause/phrase) originally started!
- You MUST remove the ENTIRE aborted attempt from where it started (plus the pause), up to the exact start of the clean retake.
- Anchor your cutStartTime and cutEndTime to the Ground-Truth Acoustic Phrase Boundaries above whenever a mistake starts at a phrase boundary and the retake starts at a subsequent phrase boundary!
- Provide the exact flubStartPhraseIndex (the Phrase # where the aborted attempt began) and retakeStartPhraseIndex (the Phrase # where the clean retake began), or -1 if mid-phrase.
- In "newsTitle", provide a concise 2-word Bengali headline summarizing what this news voiceover is about (e.g. "তিতাসে শতবর্ষী", "চেয়ারম্যান প্রার্থী"). It MUST be exactly 2 Bengali words.
- DO NOT cut normal pauses between two different sentences where nothing was flubbed or repeated.`;
};

/**
 * JSON Schema for Structured Gemini Voiceover Mistake & Retake Analysis
 */
const VOICEOVER_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    newsTitle: {
      type: 'STRING',
      description: 'A concise 2-word Bengali headline summarizing the actual news story spoken in the voiceover (e.g. "তিতাসে শতবর্ষী", "চেয়ারম্যান প্রার্থী"). Must be exactly 2 Bengali words.'
    },
    overallTranscript: {
      type: 'STRING',
      description: 'Full verbatim transcription of everything spoken in the audio, including slips and retakes.'
    },
    summary: {
      type: 'STRING',
      description: 'Brief summary of voiceover quality and edits found.'
    },
    phraseTranscripts: {
      type: 'ARRAY',
      description: 'Verbatim transcript for each acoustic phrase in the ground-truth table.',
      items: {
        type: 'OBJECT',
        properties: {
          phraseIndex: { type: 'INTEGER' },
          text: { type: 'STRING' },
          isFlubOrMistake: { type: 'BOOLEAN' }
        },
        required: ['phraseIndex', 'text', 'isFlubOrMistake']
      }
    },
    mistakesAndRetakes: {
      type: 'ARRAY',
      description: 'List of detected slips of the tongue and retake events.',
      items: {
        type: 'OBJECT',
        properties: {
          flubStartPhraseIndex: {
            type: 'INTEGER',
            description: 'Index of the Acoustic Phrase where the mistaken/aborted read started (-1 if mid-phrase).'
          },
          retakeStartPhraseIndex: {
            type: 'INTEGER',
            description: 'Index of the Acoustic Phrase where the clean retake started (-1 if mid-phrase).'
          },
          cutStartTime: {
            type: 'NUMBER',
            description: 'Exact timestamp in seconds where the cut begins (start of the aborted phrase/clause).'
          },
          cutEndTime: {
            type: 'NUMBER',
            description: 'Exact timestamp in seconds where the cut ends (start of the clean retake).'
          },
          mistakeStartTime: {
            type: 'NUMBER',
            description: 'Where the mistaken speech began in seconds.'
          },
          mistakeEndTime: {
            type: 'NUMBER',
            description: 'Where the mistaken speech ended before the pause.'
          },
          pauseDuration: {
            type: 'NUMBER',
            description: 'Pause duration in seconds between mistake and retake.'
          },
          retakeStartTime: {
            type: 'NUMBER',
            description: 'Where the clean retake speech starts.'
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
 * Find the nearest zero-crossing in Float32Array near target sample index
 */
function findNearestZeroCrossing(channelData, targetSample, maxSearchSamples = 200) {
  if (!channelData || channelData.length === 0) return 0;
  const len = channelData.length;
  if (targetSample <= 0) return 0;
  if (targetSample >= len - 1) return len - 1;

  let bestSample = targetSample;
  let minAmplitude = Math.abs(channelData[targetSample]);

  const start = Math.max(0, targetSample - maxSearchSamples);
  const end = Math.min(len - 2, targetSample + maxSearchSamples);

  for (let i = start; i <= end; i++) {
    if (channelData[i] * channelData[i + 1] <= 0) {
      return i;
    }
    const amp = Math.abs(channelData[i]);
    if (amp < minAmplitude) {
      minAmplitude = amp;
      bestSample = i;
    }
  }

  return bestSample;
}

/**
 * Find the silence/energy valley (local minimum RMS) in a given time window
 */
function findSilenceValley(channelData, sampleRate, targetTimeSeconds, windowSeconds = 0.15) {
  if (!channelData || channelData.length === 0 || !sampleRate) return targetTimeSeconds;
  const targetSample = Math.round(targetTimeSeconds * sampleRate);
  const windowSamples = Math.round(windowSeconds * sampleRate);

  const start = Math.max(0, targetSample - windowSamples);
  const end = Math.min(channelData.length - 1, targetSample + windowSamples);

  // Evaluate RMS in 10ms micro-windows
  const step = Math.max(1, Math.round(0.01 * sampleRate));
  let minRms = Infinity;
  let bestCenterSample = targetSample;

  for (let center = start; center <= end; center += step) {
    let sum = 0;
    const subStart = Math.max(0, center - step);
    const subEnd = Math.min(channelData.length, center + step);
    const count = subEnd - subStart;

    if (count <= 0) continue;
    for (let i = subStart; i < subEnd; i++) {
      sum += channelData[i] * channelData[i];
    }
    const rms = Math.sqrt(sum / count);
    if (rms < minRms) {
      minRms = rms;
      bestCenterSample = center;
    }
  }

  // Snap to exact zero crossing around that valley within 15ms
  const zeroCrossSample = findNearestZeroCrossing(
    channelData,
    bestCenterSample,
    Math.round(0.015 * sampleRate)
  );
  return zeroCrossSample / sampleRate;
}

/**
 * Refine cut boundaries using DSP silence valley and zero-crossing alignment
 */
function refineCutBoundaries(channelData, sampleRate, cutStartTime, cutEndTime, settings = DEFAULT_SPLICE_SETTINGS) {
  if (!channelData || channelData.length === 0 || !sampleRate) {
    return { refinedStart: cutStartTime, refinedEnd: cutEndTime };
  }
  const windowSec = (settings?.searchWindowMs || 150) / 1000;
  const duration = channelData.length / sampleRate;

  let refinedStart = findSilenceValley(channelData, sampleRate, cutStartTime, windowSec);
  let refinedEnd = findSilenceValley(channelData, sampleRate, cutEndTime, windowSec);

  if (refinedEnd <= refinedStart) {
    refinedEnd = Math.min(duration, refinedStart + 0.1);
  }

  return {
    refinedStart: Number(refinedStart.toFixed(4)),
    refinedEnd: Number(refinedEnd.toFixed(4))
  };
}

/**
 * Extracts exact acoustic phrase / breath-group boundaries from waveform Float32Array
 */
function extractAcousticPhrases(channelData, sampleRate) {
  if (!channelData || channelData.length === 0 || !sampleRate) return [];
  const totalDuration = channelData.length / sampleRate;

  // 20ms frame, 10ms hop
  const frameSamples = Math.round(0.02 * sampleRate);
  const hopSamples = Math.round(0.01 * sampleRate);
  const numFrames = Math.floor((channelData.length - frameSamples) / hopSamples);
  if (numFrames <= 0) return [];

  const rmsArray = new Float32Array(numFrames);
  let maxRms = 0;
  for (let f = 0; f < numFrames; f++) {
    const start = f * hopSamples;
    let sum = 0;
    for (let i = 0; i < frameSamples; i++) {
      const s = channelData[start + i];
      sum += s * s;
    }
    const rms = Math.sqrt(sum / frameSamples);
    rmsArray[f] = rms;
    if (rms > maxRms) maxRms = rms;
  }

  // Sort copy of RMS to estimate noise floor (15th percentile)
  const sortedRms = Float32Array.from(rmsArray).sort();
  const noiseFloor = sortedRms[Math.floor(numFrames * 0.15)] || 0.001;
  const vadThreshold = Math.max(noiseFloor * 3.0, maxRms * 0.07, 0.003);

  const segments = [];
  let curIsSpeech = rmsArray[0] >= vadThreshold;
  let curStart = 0;

  for (let f = 1; f < numFrames; f++) {
    const isSpeech = rmsArray[f] >= vadThreshold;
    if (isSpeech !== curIsSpeech) {
      const segEnd = (f * hopSamples) / sampleRate;
      segments.push({
        isSpeech: curIsSpeech,
        startTime: curStart,
        endTime: segEnd,
        duration: segEnd - curStart
      });
      curIsSpeech = isSpeech;
      curStart = segEnd;
    }
  }
  segments.push({
    isSpeech: curIsSpeech,
    startTime: curStart,
    endTime: totalDuration,
    duration: totalDuration - curStart
  });

  // Merge micro-gaps (< 180ms) inside continuous phrases (e.g. plosive stops p/t/k)
  const rawPhrases = [];
  let phraseStart = -1;
  let lastSpeechEnd = -1;

  for (const seg of segments) {
    if (seg.isSpeech) {
      if (seg.duration < 0.04 && phraseStart === -1) continue; // ignore tiny clicks
      if (phraseStart === -1) {
        phraseStart = seg.startTime;
      }
      lastSpeechEnd = seg.endTime;
    } else {
      if (seg.duration >= 0.18 && phraseStart !== -1) {
        if (lastSpeechEnd - phraseStart >= 0.12) {
          rawPhrases.push({ start: phraseStart, end: lastSpeechEnd });
        }
        phraseStart = -1;
        lastSpeechEnd = -1;
      }
    }
  }
  if (phraseStart !== -1 && lastSpeechEnd - phraseStart >= 0.12) {
    rawPhrases.push({ start: phraseStart, end: lastSpeechEnd });
  }

  return rawPhrases.map((p, idx) => {
    const snappedStart = findSilenceValley(channelData, sampleRate, Math.max(0, p.start - 0.03), 0.06);
    const snappedEnd = findSilenceValley(channelData, sampleRate, Math.min(totalDuration, p.end + 0.03), 0.06);
    const nextStart = idx < rawPhrases.length - 1 ? rawPhrases[idx + 1].start : totalDuration;
    return {
      index: idx,
      startTime: Number(snappedStart.toFixed(3)),
      endTime: Number(snappedEnd.toFixed(3)),
      duration: Number((snappedEnd - snappedStart).toFixed(3)),
      pauseAfter: Number(Math.max(0, nextStart - snappedEnd).toFixed(3))
    };
  });
}

/**
 * Decode audio buffer to Float32Array PCM via FFmpeg
 */
async function decodeAudioToFloat32({ audioBuffer, targetSampleRate = 12000, channels = 1 }) {
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    return { channelData: null, sampleRate: targetSampleRate, duration: 0 };
  }

  return new Promise((resolve) => {
    try {
      const proc = spawn(ffmpeg.path, [
        '-v', 'error',
        '-i', 'pipe:0',
        '-f', 'f32le',
        '-ac', String(channels),
        '-ar', String(targetSampleRate),
        'pipe:1'
      ]);

      const chunks = [];
      proc.stdout.on('data', chunk => chunks.push(chunk));
      proc.on('error', () => resolve({ channelData: null, sampleRate: targetSampleRate, duration: 0 }));
      proc.on('close', code => {
        if (code !== 0 || chunks.length === 0) {
          return resolve({ channelData: null, sampleRate: targetSampleRate, duration: 0 });
        }
        const pcmBuf = Buffer.concat(chunks);
        const float32 = new Float32Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 4);
        resolve({
          channelData: float32,
          sampleRate: targetSampleRate,
          duration: float32.length / targetSampleRate
        });
      });

      proc.stdin.on('error', () => {});
      proc.stdin.write(audioBuffer);
      proc.stdin.end();
    } catch {
      resolve({ channelData: null, sampleRate: targetSampleRate, duration: 0 });
    }
  });
}

/**
 * Downsample audio buffer to 12kHz mono WAV via FFmpeg
 */
async function downsampleAudioBufferToWav({ audioBuffer, targetSampleRate = 12000 }) {
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    return audioBuffer;
  }

  return new Promise((resolve) => {
    try {
      const proc = spawn(ffmpeg.path, [
        '-v', 'error',
        '-i', 'pipe:0',
        '-ac', '1',
        '-ar', String(targetSampleRate),
        '-c:a', 'pcm_s16le',
        '-f', 'wav',
        'pipe:1'
      ]);

      const chunks = [];
      proc.stdout.on('data', chunk => chunks.push(chunk));
      proc.on('error', () => resolve(audioBuffer));
      proc.on('close', code => {
        if (code !== 0 || chunks.length === 0) {
          return resolve(audioBuffer);
        }
        resolve(Buffer.concat(chunks));
      });

      proc.stdin.on('error', () => {});
      proc.stdin.write(audioBuffer);
      proc.stdin.end();
    } catch {
      resolve(audioBuffer);
    }
  });
}

/**
 * Computes kept audio intervals by inverting mistake cut regions over [0, totalDuration]
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
 * Basic FFmpeg atrim + concat slicer
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
 * Render clean spliced audio with 12ms equal-power cosine micro-crossfade
 * Exactly ports the DSP crossfading algorithm from standalone audioUtils.ts
 */
async function renderCleanAudioBufferWithCrossfade({
  inputPath,
  outputPath,
  keptSegments,
  settings = DEFAULT_SPLICE_SETTINGS
}) {
  if (!Array.isArray(keptSegments) || keptSegments.length <= 1) {
    return spliceAudioWithFFmpeg({ inputPath, outputPath, keptSegments });
  }

  try {
    // 1. Probe input sample rate and channels
    const probe = await new Promise((res, rej) => {
      execFile(ffprobe.path, [
        '-v', 'error',
        '-show_entries', 'stream=sample_rate,channels',
        '-of', 'json',
        inputPath
      ], (err, stdout) => {
        if (err) return rej(err);
        try {
          const data = JSON.parse(stdout);
          const s = data.streams?.[0];
          res({
            sampleRate: parseInt(s?.sample_rate, 10) || 44100,
            channels: parseInt(s?.channels, 10) || 1
          });
        } catch (e) {
          rej(e);
        }
      });
    });

    const sampleRate = probe.sampleRate;
    const channels = probe.channels;

    // 2. Decode to Float32 PCM
    const pcmBuf = await new Promise((res, rej) => {
      const proc = spawn(ffmpeg.path, [
        '-v', 'error',
        '-i', inputPath,
        '-f', 'f32le',
        '-ac', String(channels),
        '-ar', String(sampleRate),
        'pipe:1'
      ]);
      const chunks = [];
      proc.stdout.on('data', c => chunks.push(c));
      proc.on('error', rej);
      proc.on('close', code => code === 0 ? res(Buffer.concat(chunks)) : rej(new Error(`Decode code ${code}`)));
    });

    const totalSamplesPerChannel = pcmBuf.byteLength / (4 * channels);
    const f32All = new Float32Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 4);

    // De-interleave
    const channelArrays = [];
    for (let c = 0; c < channels; c++) {
      channelArrays.push(new Float32Array(totalSamplesPerChannel));
    }
    for (let i = 0; i < totalSamplesPerChannel; i++) {
      for (let c = 0; c < channels; c++) {
        channelArrays[c][i] = f32All[i * channels + c];
      }
    }

    const crossfadeMs = settings?.crossfadeDurationMs || 12;
    const crossfadeSamples = Math.round((crossfadeMs / 1000) * sampleRate);

    // Calculate total length
    let totalOutLen = 0;
    for (let i = 0; i < keptSegments.length; i++) {
      const seg = keptSegments[i];
      const segSamples = Math.round((seg.end - seg.start) * sampleRate);
      totalOutLen += segSamples;
      if (i > 0) {
        totalOutLen -= crossfadeSamples;
      }
    }
    totalOutLen = Math.max(1, totalOutLen);

    const outChannels = [];
    for (let c = 0; c < channels; c++) {
      outChannels.push(new Float32Array(totalOutLen));
    }

    // Apply equal-power cosine crossfade
    for (let c = 0; c < channels; c++) {
      const srcData = channelArrays[c];
      const destData = outChannels[c];
      let writeIdx = 0;

      for (let segIdx = 0; segIdx < keptSegments.length; segIdx++) {
        const seg = keptSegments[segIdx];
        const startSample = Math.round(seg.start * sampleRate);
        const endSample = Math.round(seg.end * sampleRate);
        const segLen = endSample - startSample;

        if (segIdx === 0) {
          for (let s = 0; s < segLen && writeIdx < totalOutLen; s++) {
            destData[writeIdx++] = srcData[startSample + s];
          }
        } else {
          const crossStartWrite = writeIdx - crossfadeSamples;
          const actualCross = Math.min(crossfadeSamples, segLen);

          for (let i = 0; i < actualCross; i++) {
            const t = i / actualCross;
            const fadeOut = Math.cos(t * 0.5 * Math.PI);
            const fadeIn = Math.sin(t * 0.5 * Math.PI);
            const existingSample = destData[crossStartWrite + i];
            const incomingSample = srcData[startSample + i];
            destData[crossStartWrite + i] = existingSample * fadeOut + incomingSample * fadeIn;
          }

          writeIdx = crossStartWrite + actualCross;
          for (let s = actualCross; s < segLen && writeIdx < totalOutLen; s++) {
            destData[writeIdx++] = srcData[startSample + s];
          }
        }
      }
    }

    // Interleave back
    const outInterleaved = new Float32Array(totalOutLen * channels);
    for (let i = 0; i < totalOutLen; i++) {
      for (let c = 0; c < channels; c++) {
        outInterleaved[i * channels + c] = outChannels[c][i];
      }
    }
    const interleavedBuffer = Buffer.from(outInterleaved.buffer, outInterleaved.byteOffset, outInterleaved.byteLength);

    // Encode to outputPath via FFmpeg
    await new Promise((res, rej) => {
      const encodeProc = spawn(ffmpeg.path, [
        '-y',
        '-f', 'f32le',
        '-ar', String(sampleRate),
        '-ac', String(channels),
        '-i', 'pipe:0',
        outputPath
      ]);
      encodeProc.on('error', rej);
      encodeProc.on('close', code => code === 0 ? res(outputPath) : rej(new Error(`Encode code ${code}`)));
      encodeProc.stdin.write(interleavedBuffer);
      encodeProc.stdin.end();
    });

    return outputPath;
  } catch (err) {
    console.warn('[AirCheck] Crossfade PCM splice failed, falling back to FFmpeg concat:', err.message);
    return spliceAudioWithFFmpeg({ inputPath, outputPath, keptSegments });
  }
}

/**
 * High-level helper to splice audio cuts directly
 */
async function spliceAudioCuts({ inputPath, outputPath, cuts = [], totalDuration, settings = DEFAULT_SPLICE_SETTINGS }) {
  const keptSegments = computeKeptSegments({ totalDuration, cuts });
  if (keptSegments.length === 0) {
    throw new Error('spliceAudioCuts: No audio remaining after applying cuts');
  }
  await renderCleanAudioBufferWithCrossfade({ inputPath, outputPath, keptSegments, settings });
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
 * Locks AI cut points to exact Acoustic Phrase boundaries, silence valleys, and zero-crossings
 */
async function analyzeVoiceoverWithGemini({
  audioBuffer,
  mimeType = 'audio/wav',
  duration = 0,
  apiKey = undefined,
  fetchFn = globalThis.fetch,
  candidates = DEFAULT_CANDIDATE_CONFIGS,
  timeoutMs = 60000,
  backoffMs = undefined,
  settings = DEFAULT_SPLICE_SETTINGS,
  acousticPhrases = null
} = {}) {
  const keys = getRotatedAudioKeys(apiKey);
  if (keys.length === 0) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const rawBuf = Buffer.isBuffer(audioBuffer)
    ? audioBuffer
    : (typeof audioBuffer === 'string' ? Buffer.from(audioBuffer, 'base64') : null);

  if (!rawBuf || rawBuf.length === 0) {
    throw new Error('audioBuffer is required');
  }

  // 1. Extract exact sample-accurate acoustic phrase boundaries from waveform via DSP
  let phrases = acousticPhrases;
  let decodedChannelData = null;
  let decodedSampleRate = 12000;

  if (!phrases) {
    try {
      const decoded = await decodeAudioToFloat32({ audioBuffer: rawBuf, targetSampleRate: 12000, channels: 1 });
      if (decoded.channelData) {
        decodedChannelData = decoded.channelData;
        decodedSampleRate = decoded.sampleRate;
        phrases = extractAcousticPhrases(decoded.channelData, decoded.sampleRate);
      }
    } catch {
      phrases = [];
    }
  }
  if (!Array.isArray(phrases)) phrases = [];

  // 2. Downsample audio to 12kHz mono WAV to minimize payload size and eliminate 503 timeouts
  let analysisBuffer = rawBuf;
  let effectiveMime = (mimeType || 'audio/wav').split(';')[0].trim();
  try {
    const downsampled = await downsampleAudioBufferToWav({ audioBuffer: rawBuf, targetSampleRate: 12000 });
    if (downsampled && downsampled.length > 0) {
      analysisBuffer = downsampled;
      effectiveMime = 'audio/wav';
    }
  } catch {}

  const audioBase64 = analysisBuffer.toString('base64');
  const effectiveBackoff = backoffMs !== undefined
    ? backoffMs
    : (process.env.NODE_ENV === 'test' ? 10 : 700);

  const prompt = VOICEOVER_PROMPT(duration, phrases);
  let lastError = null;

  for (const candidate of candidates) {
    for (let attempt = 1; attempt <= 2; attempt++) {
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
                      mimeType: effectiveMime,
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

            // If 429 quota exhaustion or 403, rotate key immediately
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

          const rawCuts = Array.isArray(parsedData.mistakesAndRetakes)
            ? parsedData.mistakesAndRetakes
            : [];

          // 3. Lock AI cut points to exact Acoustic Phrase boundaries + Silence Valleys + 0V Zero-Crossings
          const effectiveDuration = duration > 0 ? duration : (decodedChannelData ? decodedChannelData.length / decodedSampleRate : 0);

          const refinedCuts = rawCuts.map((item, idx) => {
            let candidateStart = Number(item.cutStartTime ?? item.mistakeStartTime ?? 0);
            let candidateEnd = Number(item.cutEndTime ?? item.retakeStartTime ?? candidateStart + 1);

            // If Gemini identified the exact Acoustic Phrase index where the aborted read began, lock to it
            const flubPhraseIdx = item.flubStartPhraseIndex;
            if (
              typeof flubPhraseIdx === 'number' &&
              flubPhraseIdx >= 0 &&
              flubPhraseIdx < phrases.length
            ) {
              candidateStart = phrases[flubPhraseIdx].startTime;
            } else if (phrases.length > 0) {
              // Otherwise snap to nearest acoustic phrase start within 350ms
              const nearestPhraseStart = phrases.find(
                p => Math.abs(p.startTime - candidateStart) <= 0.35
              );
              if (nearestPhraseStart) {
                candidateStart = nearestPhraseStart.startTime;
              }
            }

            // If Gemini identified the exact Acoustic Phrase index where clean retake started, lock to it
            const retakePhraseIdx = item.retakeStartPhraseIndex;
            if (
              typeof retakePhraseIdx === 'number' &&
              retakePhraseIdx >= 0 &&
              retakePhraseIdx < phrases.length
            ) {
              candidateEnd = phrases[retakePhraseIdx].startTime;
            } else if (phrases.length > 0) {
              // Snap to nearest acoustic phrase start within 350ms
              const nearestRetakePhrase = phrases.find(
                p => Math.abs(p.startTime - candidateEnd) <= 0.35
              );
              if (nearestRetakePhrase) {
                candidateEnd = nearestRetakePhrase.startTime;
              }
            }

            if (effectiveDuration > 0) {
              candidateStart = Math.max(0, Math.min(effectiveDuration, candidateStart));
              candidateEnd = Math.max(candidateStart + 0.05, Math.min(effectiveDuration, candidateEnd));
            }

            // Micro-refine boundaries with Silence Valley and Zero Crossing if channel data is available
            if (decodedChannelData && decodedSampleRate) {
              const refined = refineCutBoundaries(
                decodedChannelData,
                decodedSampleRate,
                candidateStart,
                candidateEnd,
                settings
              );
              candidateStart = refined.refinedStart;
              candidateEnd = refined.refinedEnd;
            }

            return {
              id: item.id || `cut-gemini-${idx + 1}-${Date.now()}`,
              flubStartPhraseIndex: item.flubStartPhraseIndex,
              retakeStartPhraseIndex: item.retakeStartPhraseIndex,
              cutStartTime: Number(candidateStart.toFixed(4)),
              cutEndTime: Number(candidateEnd.toFixed(4)),
              mistakeStartTime: item.mistakeStartTime ?? candidateStart,
              mistakeEndTime: item.mistakeEndTime,
              pauseDuration: item.pauseDuration,
              retakeStartTime: item.retakeStartTime ?? candidateEnd,
              mistakeText: item.mistakeText || 'Spoken slip of the tongue',
              retakeText: item.retakeText || 'Corrected speech take',
              reason: item.reason || 'Detected mistake followed by pause and retake',
              confidence: item.confidence ?? 0.95
            };
          });

          // Extract 2-word Bengali news title from Gemini
          let newsTitle = '';
          if (parsedData.newsTitle && typeof parsedData.newsTitle === 'string') {
            const words = parsedData.newsTitle
              .replace(/[^\u0980-\u09FF\s]/g, ' ')
              .trim()
              .split(/\s+/)
              .filter(Boolean);
            if (words.length >= 2) {
              newsTitle = words.slice(0, 2).join(' ');
            } else if (words.length === 1) {
              newsTitle = words[0];
            }
          }

          return {
            overallTranscript: parsedData.overallTranscript || '',
            summary: parsedData.summary || '',
            newsTitle,
            mistakesAndRetakes: refinedCuts,
            cuts: refinedCuts,
            acousticPhrases: phrases,
            modelUsed: candidate.model,
            keyUsed: effectiveKey,
            data: parsedData
          };
        } catch (err) {
          lastError = err;
          break;
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
 * 2. Calls Gemini retake analysis with acoustic anchoring
 * 3. If no cuts found, returns original audioBuffer
 * 4. If cuts found, runs micro-crossfade splice and returns cleaned buffer
 * 5. On API or splice error, gracefully falls back to original audioBuffer with failed: true
 */
async function cleanVoiceoverAudio({
  audioBuffer,
  filename = 'voiceover.wav',
  mimeType = 'audio/wav',
  fetchFn = globalThis.fetch,
  apiKey = undefined,
  duration = null,
  backoffMs = undefined,
  settings = DEFAULT_SPLICE_SETTINGS
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

  // 2. Calls Gemini retake analysis with acoustic phrase anchoring
  let analysis;
  try {
    analysis = await analyzeVoiceoverWithGemini({
      audioBuffer: buf,
      mimeType,
      duration: originalDuration,
      apiKey,
      fetchFn,
      backoffMs,
      settings
    });
  } catch (err) {
    // User constraint: "gemini pawa na gele gemini chara kaj shesh koiro na"
    // Fall back to original audio with failed: true so bot notifies VA2 to edit manually!
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
      cuts: [],
      newsTitle: analysis.newsTitle || '',
      acousticPhrases: analysis.acousticPhrases || []
    };
  }

  // 4. Splicing with 12ms equal-power cosine micro-crossfade
  const ext = (filename && filename.includes('.'))
    ? path.extname(filename)
    : (mimeType && mimeType.includes('wav') ? '.wav' : '.mp3');

  const rand = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const tempInput = path.join(os.tmpdir(), `aircheck_in_${rand}${ext}`);
  const tempOutput = path.join(os.tmpdir(), `aircheck_out_${rand}${ext}`);

  try {
    await fs.promises.writeFile(tempInput, buf);

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

    await renderCleanAudioBufferWithCrossfade({
      inputPath: tempInput,
      outputPath: tempOutput,
      keptSegments,
      settings
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
      cuts: validCuts,
      newsTitle: analysis.newsTitle || '',
      acousticPhrases: analysis.acousticPhrases || []
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
  DEFAULT_SPLICE_SETTINGS,
  VOICEOVER_PROMPT,
  VOICEOVER_RESPONSE_SCHEMA,
  DEFAULT_CANDIDATE_CONFIGS,
  cleanJsonString,
  findNearestZeroCrossing,
  findSilenceValley,
  refineCutBoundaries,
  extractAcousticPhrases,
  decodeAudioToFloat32,
  downsampleAudioBufferToWav,
  computeKeptSegments,
  spliceAudioWithFFmpeg,
  renderCleanAudioBufferWithCrossfade,
  spliceAudioCuts,
  analyzeVoiceoverWithGemini,
  cleanVoiceoverAudio,
  getRotatedAudioKeys,
  getAudioApiKeysPool,
  resetAudioKeyRotation
};
