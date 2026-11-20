const config = require('./config');
const { extractHeadline, toBengaliDigits, getAudioDurationFromBuffer } = require('./audio');
const {
  recordCartesiaUsage,
  getCartesiaBalance,
  setCartesiaBalance,
  getCartesiaDefaultVoice,
  setCartesiaDefaultVoice,
  getCartesiaDefaultSpeed,
  setCartesiaDefaultSpeed,
  getCartesiaDefaultFormat,
  setCartesiaDefaultFormat
} = require('./db');

const DEFAULT_VOICES = {
  dalia: config.CARTESIA_VOICE_DALIA || 'b01f022f-dec6-458c-9b5c-8189a0ffea0b',
  malia: config.CARTESIA_VOICE_MALIA || '07febb56-f8ad-48e1-acd0-1ace10d69823'
};

const BENGALI_TO_DIGIT = {
  '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
  '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9'
};

function parseBengaliNumber(str) {
  if (!str) return 0;
  const converted = String(str).replace(/[০-৯]/g, d => BENGALI_TO_DIGIT[d] || d).replace(/,/g, '');
  const num = parseInt(converted.replace(/\D/g, ''), 10);
  return isNaN(num) ? 0 : num;
}

/**
 * Parses speed multiplier float from string (Bengali or English digits).
 * Clamps speed between 0.6 and 1.5. Returns null if invalid.
 */
function parseSpeedMultiplier(str) {
  if (!str) return null;
  const converted = String(str)
    .replace(/[০-৯]/g, d => BENGALI_TO_DIGIT[d] || d)
    .replace(/x$/i, '')
    .trim();
  const num = parseFloat(converted);
  if (isNaN(num)) return null;
  return Math.min(1.5, Math.max(0.6, Math.round(num * 100) / 100));
}

/**
 * Extracts speed specification from prefix if present.
 * Matches:
 *  - '1.15x:', '১.১৫x:', '1.2x -'
 *  - '[1.15x]', '(১.২x)', '[speed 1.1]'
 *  - 'speed 1.1:', 'স্পিড ১.২:', 'গতি ১.১৫:'
 *  - '1.15:', '১.২:' (decimal dot required)
 */
function extractSpeedFromPrefix(str) {
  if (!str || typeof str !== 'string') return { speed: null, remaining: str };
  const trimmed = str.trim();

  // 1. Bracketed with keyword: [speed 1.1], [স্পিড ১.২], (গতি ১.১৫)
  const tagWithKeywordMatch = trimmed.match(/^(?:\[|\()(?:speed|স্পিড|গতি)\s*[:=]?\s*([০-৯\d.]+)\s*x?(?:\]|\))\s*[:ঃ\-—|.]?\s*([\s\S]*)$/i);
  if (tagWithKeywordMatch) {
    const sp = parseSpeedMultiplier(tagWithKeywordMatch[1]);
    if (sp !== null) {
      return { speed: sp, remaining: tagWithKeywordMatch[2].trim() };
    }
  }

  // 2. Bracketed with 'x' or decimal point: [1.15x], (১.২x), [1.15] (must have x or dot so [1]/[2]/[১]/[২] don't conflict with voice)
  const tagMatch = trimmed.match(/^(?:\[|\()\s*([০-৯\d.]+)\s*x\s*(?:\]|\))\s*[:ঃ\-—|.]?\s*([\s\S]*)$/i) ||
                   trimmed.match(/^(?:\[|\()\s*([০-৯\d]+\.[০-৯\d]+)\s*(?:\]|\))\s*[:ঃ\-—|.]?\s*([\s\S]*)$/);
  if (tagMatch) {
    const sp = parseSpeedMultiplier(tagMatch[1]);
    if (sp !== null) {
      return { speed: sp, remaining: tagMatch[2].trim() };
    }
  }

  // 3. Keyword prefix: speed 1.1:, স্পিড ১.২:, গতি ১.১৫:
  const keywordMatch = trimmed.match(/^(?:(?:\/|#|!)?(?:speed|স্পিড|গতি))\s*[:=]?\s*([০-৯\d.]+)\s*x?\s*[:ঃ\-—|.]?\s*([\s\S]*)$/i);
  if (keywordMatch) {
    const sp = parseSpeedMultiplier(keywordMatch[1]);
    if (sp !== null) {
      return { speed: sp, remaining: keywordMatch[2].trim() };
    }
  }

  // 4. Multiplier prefix with 'x': 1.15x:, ১.১৫x:, 1.2x -, 1.15x\n
  const multiplierMatch = trimmed.match(/^([০-৯\d.]+)\s*x\s*[:ঃ\-—|.]?\s*([\s\S]*)$/i);
  if (multiplierMatch) {
    const sp = parseSpeedMultiplier(multiplierMatch[1]);
    if (sp !== null) {
      return { speed: sp, remaining: multiplierMatch[2].trim() };
    }
  }

  // 5. Float number prefix with separator: 1.15:, ১.২: (Must contain decimal point to avoid clash with voice 1: / 2:)
  const floatMatch = trimmed.match(/^([০-৯\d]+\.[০-৯\d]+)\s*[:ঃ\-—|.]\s*([\s\S]*)$/);
  if (floatMatch) {
    const sp = parseSpeedMultiplier(floatMatch[1]);
    if (sp !== null) {
      return { speed: sp, remaining: floatMatch[2].trim() };
    }
  }

  return { speed: null, remaining: trimmed };
}

/**
 * Repairs Cartesia streaming WAV headers where ChunkSize and Subchunk2Size (data size)
 * are set to 0xFFFFFFFF (4294967295 / unknown streaming size).
 * Video editors (CapCut, Premiere, InShot, VN, KineMaster) and Android/iOS media frameworks
 * strictly reject files with 0xFFFFFFFF chunk sizes as corrupted.
 */
function sanitizeWavHeader(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 44) return buffer;
  if (buffer.subarray(0, 4).toString() !== 'RIFF' || buffer.subarray(8, 12).toString() !== 'WAVE') return buffer;

  // RIFF chunk size at byte offset 4 is total file size - 8
  buffer.writeUInt32LE(buffer.length - 8, 4);

  // Locate the 'data' chunk header
  const dataIndex = buffer.indexOf(Buffer.from('data'));
  if (dataIndex !== -1 && dataIndex >= 12 && dataIndex + 8 <= buffer.length) {
    buffer.writeUInt32LE(buffer.length - (dataIndex + 8), dataIndex + 4);
  }
  return buffer;
}

/**
 * Extracts audio format specification ('mp3' or 'wav') from prefix if present.
 * Matches:
 *  - '[mp3]', '(mp3)', '[wav]', '(wav)'
 *  - 'mp3:', 'wav:', 'mp3 -', 'wav -'
 *  - 'format mp3:', 'ফরম্যাট mp3:', '/format mp3'
 */
function extractFormatFromPrefix(str) {
  if (!str || typeof str !== 'string') return { format: null, remaining: str };
  const trimmed = str.trim();

  // 1. Bracketed or parenthesized format: [mp3], (mp3), [wav], (wav)
  const bracketMatch = trimmed.match(/^(?:\[|\()\s*(mp3|wav|ওয়েভ|ওয়েভ)\s*(?:\]|\))\s*[:ঃ\-—|.]?\s*([\s\S]*)$/i);
  if (bracketMatch) {
    const rawFmt = bracketMatch[1].toLowerCase();
    const fmt = rawFmt === 'wav' || rawFmt === 'ওয়েভ' || rawFmt === 'ওয়েভ' ? 'wav' : 'mp3';
    return { format: fmt, remaining: bracketMatch[2].trim() };
  }

  // 2. Keyword prefix: format mp3:, ফরম্যাট wav:, /format mp3
  const kwMatch = trimmed.match(/^(?:(?:\/|#|!)?(?:format|ফরম্যাট))\s*[:=]?\s*(mp3|wav|ওয়েভ|ওয়েভ)\s*[:ঃ\-—|.]?\s*([\s\S]*)$/i);
  if (kwMatch) {
    const rawFmt = kwMatch[1].toLowerCase();
    const fmt = rawFmt === 'wav' || rawFmt === 'ওয়েভ' || rawFmt === 'ওয়েভ' ? 'wav' : 'mp3';
    return { format: fmt, remaining: kwMatch[2].trim() };
  }

  // 3. Simple prefix: mp3:, wav:, #mp3, /wav
  const simpleMatch = trimmed.match(/^(?:#|\/|!)?(mp3|wav)\s*[:ঃ\-—|.]\s*([\s\S]*)$/i);
  if (simpleMatch) {
    const rawFmt = simpleMatch[1].toLowerCase();
    const fmt = rawFmt === 'wav' || rawFmt === 'ওয়েভ' || rawFmt === 'ওয়েভ' ? 'wav' : 'mp3';
    return { format: fmt, remaining: simpleMatch[2].trim() };
  }

  return { format: null, remaining: trimmed };
}

/**
 * Normalizes a news script using Gemini API (flash-lite model) according to newsroom rules:
 * (1) Properly apply punctuation for the news presenter
 * (2) Fix spelling errors
 * (3) Spell out all numbers in Bengali words
 * (4) Replace '৭০' or 'সত্তর' with 'সত্তোর'
 * (5) Replace 'ম:' or 'ম.' with 'মোহাম্মদ'
 *
 * Strict output: Returns ONLY the clean modified script, no conversational filler, headers, or markdown.
 * Fallback: If Gemini API fails or is unavailable, falls back to the original script text.
 */
async function normalizeScriptWithGemini(scriptText, options = {}) {
  if (!scriptText || typeof scriptText !== 'string' || !scriptText.trim()) {
    return scriptText || '';
  }

  const apiKey = options.apiKey !== undefined ? options.apiKey : config.GEMINI_API_KEY;
  const model = options.model || config.GEMINI_MODEL || 'gemini-flash-lite-latest';
  const fetchFn = options.fetchFn || globalThis.fetch;
  const timeoutMs = options.timeoutMs || 12000;

  if (!apiKey) {
    console.warn('[GENERATED_VOICE] GEMINI_API_KEY is not configured; using raw script');
    return scriptText;
  }

  const promptText = `নিচের নিউজ স্ক্রিপ্ট টিতে-
(১) সঠিকভাবে যতিচিহ্ন এপ্লাই করো যেন নিউজ টি প্রেজেন্টারের পড়তে সুবিধা হয়
(২) কোনো বানান ভুল থাকলে ঠিক করে দেও
(৩) স্ক্রিপ্টের যেকোনো সংখ্যা কে লিখিত আকারে রিপ্লেস করো
(৪) '৭০' বা 'সত্তর' কে 'সত্তোর' দিয়ে রিপ্লেস করো
(৫) 'ম:' বা 'ম.' কে 'মোহাম্মদ' দিয়ে রিপ্লেস করো
নিচের স্ক্রিপ্টের জন্য উপরের নিয়ম গুলো ফলো করো:
স্ক্রিপ্ট:
${scriptText.trim()}

[গুরুত্বপূর্ণ নির্দেশাবলী - STRICT OUTPUT RULES]:
১. আউটপুটে শুধুমাত্র এবং শুধুমাত্র চূড়ান্ত সংশোধিত বাংলা স্ক্রিপ্টটি প্রদান করবে।
২. কোনো ভূমিকা, সম্ভাষণ, ব্যাখ্যা, ফুটনোট বা উপসংহার (যেমন "নিচে স্ক্রিপ্টটি দেওয়া হলো:", "সংশোধিত রূপ:") প্রদান করা সম্পূর্ণ নিষিদ্ধ।
৩. কোনো মার্কডাউন কোড ব্লক (\`\`\` বা \`\`\`markdown) অথবা কোটেশন চিহ্নে আউটপুট আবৃত করবে না।
৪. মূল স্ক্রিপ্টের অর্থ ও বিষয়বস্তু সম্পূর্ণ অক্ষুণ্ণ রাখবে।`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: promptText }]
      }
    ],
    generationConfig: {
      temperature: 0.1
    }
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok && (response.status === 503 || response.status === 429) && model !== 'gemini-2.5-flash-lite') {
      console.warn(`[GENERATED_VOICE] Gemini ${model} returned ${response.status}, retrying with gemini-2.5-flash-lite...`);
      const fallbackUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
      try {
        response = await fetchFn(fallbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (fbErr) {
        console.warn('[GENERATED_VOICE] Fallback model error:', fbErr.message);
      }
    }

    if (!response.ok) {
      console.warn(`[GENERATED_VOICE] Gemini normalization failed with status ${response.status}; using original script`);
      return scriptText;
    }

    const data = await response.json();
    const candidateText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!candidateText || typeof candidateText !== 'string' || !candidateText.trim()) {
      console.warn('[GENERATED_VOICE] Gemini returned empty response; using original script');
      return scriptText;
    }

    let cleaned = candidateText.trim();
    // Strip code fences if present
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
    }
    // Strip common conversational preamble phrases if model added any
    cleaned = cleaned.replace(/^(?:সংশোধিত\s*(?:নিউজ\s*)?স্ক্রিপ্ট|স্ক্রিপ্ট|চূড়ান্ত\s*স্ক্রিপ্ট)\s*[:ঃ\-—]\s*/i, '').trim();

    return cleaned || scriptText;
  } catch (err) {
    console.warn('[GENERATED_VOICE] Error calling Gemini for script normalization:', err.message, '; using original script');
    return scriptText;
  }
}

/**
 * Backward-compatible helper (hardcoded regex rules removed as normalization is handled via Gemini LLM).
 */
function normalizeAbbreviationsForTts(text) {
  if (!text || typeof text !== 'string') return '';
  return text.trim();
}

/**
 * Parses script text to check if a specific voice, speed, and/or format was requested.
 * Supports prefixes ('মালিয়া:', 'দালিয়া:', '2:', '১:'), brackets ('[মালিয়া]', '[২]'),
 * hashtags/slashes ('#malia', '/malia'), separators ('মালিয়া -'), or line-1 standalone names.
 * Also parses per-script speed prefixes ('১.১৫x:', '1.2x:', '[1.15x]', 'speed 1.1:').
 * Also parses format prefixes ('mp3:', 'wav:', '[mp3]', '[wav]').
 * Falls back to defaultVoice (default: 'dalia'), defaultSpeed (default: 1.0), and defaultFormat (default: 'mp3').
 */
function extractVoiceChoiceAndCleanText(text, defaultVoice = 'dalia', defaultSpeed = 1.0, defaultFormat = 'mp3') {
  const fallbackVoice = defaultVoice === 'malia' ? 'malia' : 'dalia';
  const cleanDefSpeed = typeof defaultSpeed === 'number' && !isNaN(defaultSpeed)
    ? Math.min(1.5, Math.max(0.6, Math.round(defaultSpeed * 100) / 100))
    : 1.0;
  const fallbackFormat = String(defaultFormat || '').toLowerCase() === 'wav' ? 'wav' : 'mp3';

  if (!text || typeof text !== 'string') {
    return { voice: fallbackVoice, speed: cleanDefSpeed, format: fallbackFormat, cleanText: '' };
  }

  let working = text.trim();
  let detectedSpeed = null;
  let detectedVoice = null;
  let detectedFormat = null;

  // Multi-pass to extract speed, format, and voice in any order
  let changed = true;
  let passes = 0;
  while (changed && passes < 4) {
    changed = false;
    passes++;

    if (detectedFormat === null) {
      const fmtCheck = extractFormatFromPrefix(working);
      if (fmtCheck.format !== null) {
        detectedFormat = fmtCheck.format;
        working = fmtCheck.remaining;
        changed = true;
      }
    }

    if (detectedSpeed === null) {
      const spCheck = extractSpeedFromPrefix(working);
      if (spCheck.speed !== null) {
        detectedSpeed = spCheck.speed;
        working = spCheck.remaining;
        changed = true;
      }
    }

    if (detectedVoice === null) {
      // Voice detection
      const maliaLineMatch = working.match(/^(?:মালিয়া|মালিয়া|malia|২|2)\s*[\r\n]+([\s\S]*)$/i);
      if (maliaLineMatch) {
        detectedVoice = 'malia';
        working = maliaLineMatch[1].trim();
        changed = true;
      } else {
        const maliaPrefix = working.match(/^(?:মালিয়া|মালিয়া|malia|২|2)\s*[:ঃ\-—|.]\s*([\s\S]*)$/i);
        if (maliaPrefix) {
          detectedVoice = 'malia';
          working = maliaPrefix[1].trim();
          changed = true;
        } else {
          const maliaTag = working.match(/^(?:\[|\(|#|\/|!)(?:মালিয়া|মালিয়া|malia|২|2)(?:\]|\))\s*[:ঃ\-—|.]?\s*([\s\S]*)$/i);
          if (maliaTag) {
            detectedVoice = 'malia';
            working = maliaTag[1].trim();
            changed = true;
          } else {
            const maliaHash = working.match(/^(?:#|\/|!)(?:মালিয়া|মালিয়া|malia|২|2)\s+([\s\S]*)$/i);
            if (maliaHash) {
              detectedVoice = 'malia';
              working = maliaHash[1].trim();
              changed = true;
            }
          }
        }
      }

      if (!detectedVoice) {
        const daliaLineMatch = working.match(/^(?:দালিয়া|দালিয়া|দলিয়া|দলিয়া|dalia|১|1)\s*[\r\n]+([\s\S]*)$/i);
        if (daliaLineMatch) {
          detectedVoice = 'dalia';
          working = daliaLineMatch[1].trim();
          changed = true;
        } else {
          const daliaPrefix = working.match(/^(?:দালিয়া|দালিয়া|দলিয়া|দলিয়া|dalia|১|1)\s*[:ঃ\-—|.]\s*([\s\S]*)$/i);
          if (daliaPrefix) {
            detectedVoice = 'dalia';
            working = daliaPrefix[1].trim();
            changed = true;
          } else {
            const daliaTag = working.match(/^(?:\[|\(|#|\/|!)(?:দালিয়া|দালিয়া|দলিয়া|দলিয়া|dalia|১|1)(?:\]|\))\s*[:ঃ\-—|.]?\s*([\s\S]*)$/i);
            if (daliaTag) {
              detectedVoice = 'dalia';
              working = daliaTag[1].trim();
              changed = true;
            } else {
              const daliaHash = working.match(/^(?:#|\/|!)(?:দালিয়া|দালিয়া|দলিয়া|দলিয়া|dalia|১|1)\s+([\s\S]*)$/i);
              if (daliaHash) {
                detectedVoice = 'dalia';
                working = daliaHash[1].trim();
                changed = true;
              }
            }
          }
        }
      }
    }
  }

  return {
    voice: detectedVoice || fallbackVoice,
    speed: detectedSpeed !== null ? detectedSpeed : cleanDefSpeed,
    format: detectedFormat || fallbackFormat,
    cleanText: working.trim()
  };
}

/**
 * Formats duration in seconds into Bengali M.SS (e.g. 75s -> '১.১৫', 64s -> '১.০৪').
 */
function formatBengaliDurationForFilename(seconds) {
  if (typeof seconds !== 'number' || isNaN(seconds) || seconds < 0) {
    return toBengaliDigits('0.00');
  }

  const rounded = Math.round(seconds);
  const min = Math.floor(rounded / 60);
  const sec = rounded % 60;
  const formatted = `${min}.${String(sec).padStart(2, '0')}`;
  return toBengaliDigits(formatted);
}

/**
 * Builds the exact Bengali filename for the generated voice document:
 * `<সর্বোচ্চ ২ শব্দের শিরোনাম> <মিনিট.সেকেন্ড>.<ext>` (e.g. `মৌলভীবাজারের খবর ১.১৫.mp3`)
 */
function buildGeneratedVoiceFilename({ scriptText, durationSeconds, ext = 'mp3' } = {}) {
  const headline = extractHeadline(scriptText, 2) || 'ভয়েস সংবাদ';
  const cleanHeadline = headline
    .replace(/[\\/:*?"<>|\r\n]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .split(/\s+/)
    .slice(0, 2)
    .join(' ') || 'ভয়েস সংবাদ';

  const cleanExt = (ext ? String(ext) : 'mp3')
    .replace(/^\./, '')
    .replace(/[\\/:*?"<>|\r\n]/g, '')
    .trim() || 'mp3';

  const formattedDur = formatBengaliDurationForFilename(durationSeconds);
  return `${cleanHeadline} ${formattedDur}.${cleanExt}`;
}

/**
 * Formats delivery report showing voice used, audio duration, character/credit count,
 * remaining credits, and approx minutes of Bengali news script voiceover.
 */
function formatCartesiaDeliveryReport({
  voice = 'dalia',
  speed = 1.0,
  format = 'mp3',
  durationSeconds = 0,
  charCount = 0,
  creditsUsed = null,
  remainingCredits = 0,
  approxMinutes = 0
} = {}) {
  const voiceNameBn = voice === 'malia' ? 'মালিয়া (Malia)' : 'দালিয়া (Dalia)';
  const speedSuffix = speed && speed !== 1.0 ? ` [${toBengaliDigits(speed)}x]` : '';
  const formatBadge = String(format || 'mp3').toUpperCase();
  const formattedDur = formatBengaliDurationForFilename(durationSeconds);
  const durSecBn = toBengaliDigits(Math.round(durationSeconds));
  const charsBn = Number(charCount || 0).toLocaleString('bn-BD');
  const creditsUsedBn = Number(creditsUsed || charCount || 0).toLocaleString('bn-BD');
  const remCreditsBn = Number(remainingCredits || 0).toLocaleString('bn-BD');

  let timeStr = '';
  if (approxMinutes >= 60) {
    const hrs = Math.floor(approxMinutes / 60);
    const mins = Math.round(approxMinutes % 60);
    timeStr = `~${toBengaliDigits(Math.round(approxMinutes))} মিনিট (${toBengaliDigits(hrs)} ঘণ্টা ${toBengaliDigits(mins)} মিনিট)`;
  } else {
    timeStr = `~${toBengaliDigits(Math.round(approxMinutes))} মিনিট`;
  }

  return [
    `🎙️ *ভয়েস:* ${voiceNameBn}${speedSuffix} [${formatBadge}]`,
    `⏱️ *দৈর্ঘ্য:* ${formattedDur} মিনিট (${durSecBn} সেকেন্ড)`,
    `📝 *অক্ষর:* ${charsBn} টি (${creditsUsedBn} ক্রেডিট)`,
    `─────────────────────`,
    `📊 *কার্তেসিয়া ব্যালেন্স রিপোর্ট:*`,
    `• অবশিষ্ট ক্রেডিট: ${remCreditsBn}`,
    `• আনুমানিক বাকি সময়: ${timeStr} (বাংলা সংবাদ)`
  ].join('\n');
}

/**
 * Formats interactive voice help guide showing available voices, syntax, speed, and current balance.
 */
function formatVoiceHelpMessage({ defaultVoice = 'dalia', defaultSpeed = 1.0, defaultFormat = 'mp3', balance = null } = {}) {
  const currentDefBn = defaultVoice === 'malia' ? 'মালিয়া (Malia)' : 'দালিয়া (Dalia)';
  const curSpeedBn = toBengaliDigits(defaultSpeed || 1.0);
  const curFmt = String(defaultFormat || 'mp3').toUpperCase();
  const remCreditsBn = Number(balance?.remainingCredits || 0).toLocaleString('bn-BD');
  const approxMins = balance?.approxMinutes || 0;
  let timeStr = '';
  if (approxMins >= 60) {
    const hrs = Math.floor(approxMins / 60);
    const mins = Math.round(approxMins % 60);
    timeStr = `~${toBengaliDigits(Math.round(approxMins))} মিনিট (${toBengaliDigits(hrs)} ঘণ্টা ${toBengaliDigits(mins)} মিনিট)`;
  } else {
    timeStr = `~${toBengaliDigits(Math.round(approxMins))} মিনিট`;
  }

  return [
    `🎙️ *মুন্নিসফট ভয়েস নির্বাচন ও কার্তেসিয়া নির্দেশিকা*\n`,
    `📌 *বর্তমান ডিফল্ট:* ${currentDefBn} | স্পিড: *${curSpeedBn}x* | ফরম্যাট: *${curFmt}*\n`,
    `১️⃣ *দালিয়া (Dalia)* — গম্ভীর ও স্ট্যান্ডার্ড সংবাদ কণ্ঠ`,
    `   • ব্যবহারের নিয়ম: \`১:\` বা \`দালিয়া:\` বা \`[১]\` বা সরাসরি স্ক্রিপ্ট পাঠান\n`,
    `২️⃣ *মালিয়া (Malia)* — প্রাঞ্জল ও আকর্ষণীয় সংবাদ কণ্ঠ`,
    `   • ব্যবহারের নিয়ম: \`২:\` বা \`মালিয়া:\` বা \`[২]\` বা প্রথম লাইনে \`মালিয়া\` লিখুন\n`,
    `⚡ *ভয়েস স্পিড কন্ট্রোল (০.৬x - ১.৫x):*`,
    `   • স্পিড দেখতে: \`speed\` বা \`স্পিড\``,
    `   • ডিফল্ট স্পিড পরিবর্তন: \`speed 1.1\` বা \`স্পিড ১.২\``,
    `   • নির্দিষ্ট স্ক্রিপ্টে সাময়িক স্পিড: \`১.১৫x: স্ক্রিপ্ট...\` বা \`speed 1.2: স্ক্রিপ্ট...\`\n`,
    `🎧 *অডিও ফরম্যাট কন্ট্রোল (MP3 / WAV):*`,
    `   • ফরম্যাট দেখতে: \`format\` বা \`ফরম্যাট\``,
    `   • ডিফল্ট ফরম্যাট পরিবর্তন: \`format mp3\` বা \`format wav\``,
    `   • নির্দিষ্ট স্ক্রিপ্টে সাময়িক ফরম্যাট: \`mp3: স্ক্রিপ্ট...\` বা \`wav: স্ক্রিপ্ট...\``,
    `   • (নোট: CapCut, Premiere, InShot, VN সহ সব ভিডিও এডিটরে MP3 ১০০% নির্বিঘ্নে সাপোর্ট করে)\n`,
    `⚙️ *ডিফল্ট ভয়েস পরিবর্তনের কমান্ড:*`,
    `   • \`ভয়েস ১\` বা \`/voice dalia\` (দালিয়া ডিফল্ট)`,
    `   • \`ভয়েস ২\` বা \`/voice malia\` (মালিয়া ডিফল্ট)\n`,
    `📊 *কার্তেসিয়া ব্যালেন্স:*`,
    `   • অবশিষ্ট ক্রেডিট: ${remCreditsBn}`,
    `   • আনুমানিক সময় বাকি: ${timeStr} (বাংলা সংবাদ)`,
    `   • ব্যালেন্স আপডেট কমান্ড: \`credits <সংখ্যা>\` (যেমন: \`credits 500000\`)`
  ].join('\n');
}

/**
 * Synthesizes voice audio from Bengali script text using Cartesia TTS REST API.
 */
async function synthesizeCartesiaVoice({
  scriptText,
  voice = null,
  speed = null,
  format = null,
  apiKey = null,
  modelId = null
} = {}) {
  const { voice: detectedVoice, speed: detectedSpeed, format: detectedFormat, cleanText } = extractVoiceChoiceAndCleanText(scriptText);
  if (!cleanText || cleanText.length === 0) {
    throw new Error('SCRIPT_EMPTY');
  }

  const targetVoice = voice || detectedVoice;
  const targetSpeed = speed !== null && speed !== undefined ? speed : detectedSpeed;
  const targetFormat = String(format || detectedFormat || config.CARTESIA_OUTPUT_FORMAT || 'mp3').toLowerCase().trim() === 'wav' ? 'wav' : 'mp3';
  const voiceId = DEFAULT_VOICES[targetVoice] || DEFAULT_VOICES.dalia;
  const key = apiKey || config.CARTESIA_API_KEY;
  if (!key) {
    throw new Error('CARTESIA_API_KEY_MISSING');
  }

  const model = modelId || config.CARTESIA_MODEL_ID || 'sonic-3.6';

  let output_format;
  if (targetFormat === 'wav') {
    output_format = {
      container: 'wav',
      encoding: 'pcm_s16le',
      sample_rate: 44100
    };
  } else {
    output_format = {
      container: 'mp3',
      sample_rate: 44100,
      bitrate: 192000
    };
  }

  const payload = {
    model_id: model,
    transcript: cleanText.trim(),
    voice: {
      mode: 'id',
      id: voiceId
    },
    output_format,
    language: 'bn'
  };

  if (typeof targetSpeed === 'number' && !isNaN(targetSpeed)) {
    const clampedSpeed = Math.min(1.5, Math.max(0.6, Math.round(targetSpeed * 100) / 100));
    payload.generation_config = { speed: clampedSpeed };
  }

  const response = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'X-API-Key': key,
      'Cartesia-Version': '2024-06-10',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`CARTESIA_API_ERROR: HTTP ${response.status} - ${errorBody}`);
  }

  const arrayBuf = await response.arrayBuffer();
  let buffer = Buffer.from(arrayBuf);

  // If WAV format was requested, sanitize the RIFF header to fix 0xFFFFFFFF unknown stream sizes
  if (targetFormat === 'wav') {
    buffer = sanitizeWavHeader(buffer);
  }

  let durationSeconds = 0;
  try {
    if (typeof getAudioDurationFromBuffer === 'function') {
      durationSeconds = await getAudioDurationFromBuffer(buffer, targetFormat);
    }
  } catch (durErr) {
    console.warn('[CARTESIA_TTS] Could not measure audio buffer duration:', durErr.message);
  }

  return {
    buffer,
    voice: targetVoice,
    voiceId,
    speed: targetSpeed,
    format: targetFormat,
    cleanText,
    durationSeconds
  };
}

const knownGeneratedVoiceChatIds = new Set();
const sentGeneratedVoiceMsgIds = new Set();
const inFlightGeneratedVoiceMsgIds = new Set();
const recentSentBotTexts = new Set();

/**
 * Normalizes text by lowercasing, stripping zero-width joiners/non-joiners,
 * and normalizing Bengali nukta variants (e.g. য় -> য).
 */
function normalizeBengaliText(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u09BC/g, '')
    .replace(/\u09DF/g, '\u09AF');
}

/**
 * Checks if a chat or chat name matches the "generated voice" group.
 */
function isGeneratedVoiceGroup(chatOrName) {
  if (!chatOrName) return false;
  const raw = String(typeof chatOrName === 'string' ? chatOrName : (chatOrName.name || chatOrName.formattedTitle || '')).trim();
  if (!raw) return false;

  const lower = raw.toLowerCase();
  if (config.GENERATED_VOICE_CHAT_NAME) {
    const configTarget = config.GENERATED_VOICE_CHAT_NAME.toLowerCase();
    if (lower.includes(configTarget) || normalizeBengaliText(lower).includes(normalizeBengaliText(configTarget))) {
      return true;
    }
  }

  const norm = normalizeBengaliText(lower);

  const hasGenerate = norm.includes('generat') ||
                      norm.includes('জেনারেট') ||
                      norm.includes('জেনারেড') ||
                      norm.includes('জেনারেশন');

  const hasVoice = norm.includes('voice') ||
                   norm.includes('ভযেস') ||
                   norm.includes('ভয়েস') ||
                   norm.includes('ভয়েস') ||
                   norm.includes('ভইস') ||
                   norm.includes('ভযেজ') ||
                   norm.includes('ভয়েজ') ||
                   norm.includes('ভয়েজ');

  if (hasGenerate && hasVoice) {
    return true;
  }

  return norm.includes('generated voice') ||
         norm.includes('generate voice') ||
         norm.includes('generated voices') ||
         norm.includes('voice generator') ||
         norm.includes('ভয়েস জেনারেট') ||
         norm.includes('ভয়েস জেনারেট') ||
         norm.includes('জেনারেটেড ভয়েস') ||
         norm.includes('জেনারেটেড ভয়েস') ||
         norm.includes('জেনারেট ভয়েস') ||
         norm.includes('জেনারেট ভয়েস');
}

/**
 * Safely resolves the chat name for a message across multiple fallback layers
 * without throwing or failing on WhatsApp Web internal 'r' error.
 */
async function resolveChatNameSafe(msg, client) {
  if (!msg) return '';

  // 1. Direct properties on message / _data
  const candidates = [
    msg._data?.chat?.name,
    msg._data?.chat?.formattedTitle,
    msg._data?.formattedTitle,
    msg._data?.name,
    msg.chat?.name,
    msg.chat?.formattedTitle
  ];
  for (const c of candidates) {
    if (c && typeof c === 'string' && c.trim()) return c.trim();
  }

  const remoteJid = String(msg.id?.remote || msg.to || msg.from || '');

  // 2. In-memory Puppeteer evaluate directly from WAWebCollections with WidFactory & findOrCreateLatestChat
  if (client?.pupPage && remoteJid) {
    try {
      const inPageName = await client.pupPage.evaluate(async (jid) => {
        try {
          const collections = window.require('WAWebCollections');
          const widFactory = window.require('WAWebWidFactory');
          let chat = null;
          if (widFactory && collections?.Chat) {
            try {
              const chatWid = widFactory.createWid(jid);
              chat = collections.Chat.get(chatWid);
              if (!chat && window.require('WAWebFindChatAction')) {
                const res = await window.require('WAWebFindChatAction').findOrCreateLatestChat(chatWid);
                chat = res?.chat || chat;
              }
            } catch {}
          }
          if (!chat && collections?.Chat?.models) {
            chat = collections.Chat.models.find((m) => {
              const mid = m.id?._serialized || (typeof m.id?.toString === 'function' ? m.id.toString() : '');
              return mid === jid || (mid && jid && mid.split('@')[0] === jid.split('@')[0]);
            });
          }
          if (chat) {
            return chat.formattedTitle || chat.name || chat.contact?.name || chat.__x_formattedTitle || chat.__x_name || '';
          }
          return '';
        } catch {
          return '';
        }
      }, remoteJid);
      if (inPageName) return inPageName;
    } catch {}
  }

  // 3. Raw in-page getChat with getAsModel: false (bypasses groupMetadata.update which throws error 'r')
  if (client?.pupPage && remoteJid) {
    try {
      const inPageChat = await client.pupPage.evaluate(async (jid) => {
        try {
          if (window.WWebJS && typeof window.WWebJS.getChat === 'function') {
            const rawChat = await window.WWebJS.getChat(jid, { getAsModel: false });
            return rawChat?.formattedTitle || rawChat?.name || rawChat?.contact?.name || '';
          }
        } catch {}
        return '';
      }, remoteJid);
      if (inPageChat) return inPageChat;
    } catch {}
  }

  // 4. Try client.getChatById(remoteJid) directly (using remoteJid, not msg._getChatId())
  if (client && typeof client.getChatById === 'function' && remoteJid) {
    try {
      const c = await client.getChatById(remoteJid);
      if (c && (c.name || c.formattedTitle)) return c.name || c.formattedTitle;
    } catch {}
  }

  // 5. Fallback to msg.getChat()
  if (typeof msg.getChat === 'function') {
    try {
      const c = await msg.getChat();
      if (c && (c.name || c.formattedTitle)) return c.name || c.formattedTitle;
    } catch (err) {
      // Swallowed safely - error 'r' is handled by other layers
    }
  }

  return '';
}

/**
 * Discovers and caches the "generated voice" group JID from loaded WhatsApp chats.
 */
async function discoverGeneratedVoiceGroup(client) {
  const discovered = [];

  // Layer 1: In-page WAWebCollections evaluation
  if (client?.pupPage) {
    try {
      const inPageMatches = await client.pupPage.evaluate(() => {
        try {
          const normalize = (str) => {
            if (!str) return '';
            return String(str)
              .toLowerCase()
              .replace(/[\u200B-\u200D\uFEFF]/g, '')
              .replace(/\u09BC/g, '')
              .replace(/\u09DF/g, '\u09AF');
          };

          const isMatch = (raw) => {
            if (!raw) return false;
            const norm = normalize(raw);
            const hasGen = norm.includes('generat') || norm.includes('জেনারেট') || norm.includes('জেনারেড') || norm.includes('জেনারেশন');
            const hasVoice = norm.includes('voice') || norm.includes('ভযেস') || norm.includes('ভয়েস') || norm.includes('ভয়েস') || norm.includes('ভইস') || norm.includes('ভযেজ') || norm.includes('ভয়েজ') || norm.includes('ভয়েজ');
            return (hasGen && hasVoice) || norm.includes('generated voice') || norm.includes('ভয়েস জেনারেট') || norm.includes('জেনারেটেড ভয়েস') || norm.includes('জেনারেটেড ভয়েস');
          };

          const collections = window.require('WAWebCollections');
          const chats = collections?.Chat?.models || [];
          return chats
            .filter((c) => {
              if (!c.isGroup) return false;
              const name = c.name || c.formattedTitle || c.__x_formattedTitle || c.__x_name || '';
              return isMatch(name);
            })
            .map((c) => ({
              jid: c.id?._serialized,
              name: c.name || c.formattedTitle || c.__x_formattedTitle || c.__x_name || ''
            }))
            .filter((c) => Boolean(c.jid));
        } catch {
          return [];
        }
      });

      for (const item of (inPageMatches || [])) {
        if (item.jid && !knownGeneratedVoiceChatIds.has(item.jid)) {
          knownGeneratedVoiceChatIds.add(item.jid);
          discovered.push(item.jid);
          console.log(`[GENERATED_VOICE] Auto-discovered group in memory: "${item.name}" (${item.jid})`);
        }
      }
    } catch (err) {
      console.warn('[GENERATED_VOICE] Group discovery failed via in-page evaluate:', err.message);
    }
  }

  // Layer 2: client.getChats() fallback
  if (client && typeof client.getChats === 'function') {
    try {
      const chats = await client.getChats();
      if (Array.isArray(chats)) {
        for (const c of chats) {
          if (c?.isGroup) {
            const cName = c.name || c.formattedTitle || '';
            if (isGeneratedVoiceGroup(cName)) {
              const jid = c.id?._serialized;
              if (jid && !knownGeneratedVoiceChatIds.has(jid)) {
                knownGeneratedVoiceChatIds.add(jid);
                discovered.push(jid);
                console.log(`[GENERATED_VOICE] Auto-discovered group via getChats(): "${cName}" (${jid})`);
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('[GENERATED_VOICE] Group discovery failed via getChats():', err.message);
    }
  }

  return discovered;
}

/**
 * Detects whether a message is an automated Cartesia TTS bot system message
 * (e.g., delivery report caption, help guide, balance report, speed status, voice switched).
 */
function isCartesiaBotSystemMessage(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;

  // 1. Delivery report caption patterns
  if (t.includes('🎙️ *ভয়েস:*') || t.includes('🎙️ *ভয়েস:*')) return true;
  if (t.includes('📊 *কার্তেসিয়া ব্যালেন্স রিপোর্ট:*') || t.includes('📊 *কার্তেসিয়া ব্যালেন্স')) return true;
  if (t.includes('• অবশিষ্ট ক্রেডিট:') && (t.includes('বাংলা সংবাদ') || t.includes('ক্রেডিট'))) return true;
  if (t.includes('⏱️ *দৈর্ঘ্য:*') && t.includes('📝 *অক্ষর:*')) return true;

  // 2. Interactive help guide
  if (t.includes('🎙️ *কার্তেসিয়া এআই ভয়েস কমান্ড গাইড:*') || t.includes('কার্তেসিয়া এআই ভয়েস কমান্ড গাইড')) return true;
  if (t.includes('• ডিফল্ট পরিবর্তন করতে:') || t.includes('• সরাসরি যেকোনো সাধারণ স্ক্রিপ্ট পাঠালে')) return true;

  // 3. Command confirmation / status replies
  if (t.includes('✅ গ্রুপের ডিফল্ট ভয়েস পরিবর্তন করা হয়েছে:')) return true;
  if (t.includes('⚡ কার্তেসিয়া ভয়েস স্পিড আপডেট করা হয়েছে:')) return true;
  if (t.includes('⚡ *কার্তেসিয়া ভয়েস স্পিড স্ট্যাটাস:*')) return true;
  if (t.includes('🎧 কার্তেসিয়া অডিও ফরম্যাট আপডেট করা হয়েছে:')) return true;
  if (t.includes('🎧 *কার্তেসিয়া অডিও ফরম্যাট স্ট্যাটাস:*')) return true;
  if (t.includes('✅ কার্তেসিয়া ক্রেডিট ব্যালেন্স আপডেট করা হয়েছে!')) return true;
  if (t.includes('❌ কার্তেসিয়া ভয়েস তৈরি করতে সমস্যা হয়েছে')) return true;

  // 4. Characteristic sub-bullets used in bot reports
  if (t.includes('• বর্তমান ডিফল্ট স্পিড:') && t.includes('• অনুমোদিত রেঞ্জ:')) return true;
  if (t.includes('• প্রতি মিনিটে খরচ: ~৭৫০ ক্রেডিট')) return true;

  return false;
}

/**
 * Sends a message or media document to the WhatsApp group, while tracking
 * the text, caption, and resulting message ID in in-memory sets to strictly
 * prevent the bot from synthesizing Cartesia voice for its own messages.
 */
async function sendGroupReply(client, targetChat, content, options = {}) {
  if (!client || typeof client.sendMessage !== 'function') {
    throw new Error('client.sendMessage is not a function');
  }

  // 1. Register text and caption in recentSentBotTexts BEFORE async send
  // to prevent race conditions where message_create fires before client.sendMessage resolves.
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed) {
      recentSentBotTexts.add(trimmed);
      setTimeout(() => recentSentBotTexts.delete(trimmed), 180000).unref?.();
    }
  }
  if (options && typeof options.caption === 'string') {
    const trimmedCaption = options.caption.trim();
    if (trimmedCaption) {
      recentSentBotTexts.add(trimmedCaption);
      setTimeout(() => recentSentBotTexts.delete(trimmedCaption), 180000).unref?.();
    }
  }

  const sentMsg = await client.sendMessage(targetChat, content, options);

  // 2. Register message ID in sentGeneratedVoiceMsgIds
  if (sentMsg?.id?._serialized) {
    sentGeneratedVoiceMsgIds.add(sentMsg.id._serialized);
    setTimeout(() => sentGeneratedVoiceMsgIds.delete(sentMsg.id._serialized), 300000).unref?.();
  }
  if (sentMsg?.id?.id) {
    sentGeneratedVoiceMsgIds.add(sentMsg.id.id);
    setTimeout(() => sentGeneratedVoiceMsgIds.delete(sentMsg.id.id), 300000).unref?.();
  }

  return sentMsg;
}

/**
 * Handles incoming messages in the "generated voice" WhatsApp group.
 * Synthesizes Bengali scripts using Cartesia cloned voice and replies with
 * the audio file as a document formatted with the news headline and duration.
 */
async function handleGeneratedVoiceMessage({
  msg,
  client,
  db = null,
  MediaClass = null,
  synthesizeFn = null,
  normalizeScriptFn = null
} = {}) {
  if (!msg) {
    return { action: 'NOT_GENERATED_VOICE' };
  }

  const remoteJid = String(msg.id?.remote || msg.to || msg.from || '');
  let isTargetGroup = (config.GENERATED_VOICE_CHAT_ID && remoteJid === config.GENERATED_VOICE_CHAT_ID) ||
                      knownGeneratedVoiceChatIds.has(remoteJid);
  let resolvedName = '';

  if (!isTargetGroup) {
    resolvedName = await resolveChatNameSafe(msg, client);
    if (isGeneratedVoiceGroup(resolvedName)) {
      isTargetGroup = true;
      if (remoteJid) {
        knownGeneratedVoiceChatIds.add(remoteJid);
        console.log(`[GENERATED_VOICE] Matched group "${resolvedName}" for JID: ${remoteJid}`);
      }
    }
  }

  if (!isTargetGroup) {
    return { action: 'NOT_GENERATED_VOICE', remoteJid, resolvedName };
  }

  // 1. Prevent bot self-echo loop by Message ID
  const msgIdSerialized = msg.id?._serialized;
  const msgIdId = msg.id?.id;
  if ((msgIdSerialized && sentGeneratedVoiceMsgIds.has(msgIdSerialized)) ||
      (msgIdId && sentGeneratedVoiceMsgIds.has(msgIdId))) {
    return { action: 'IGNORED_SELF_ECHO' };
  }

  // 2. Ignore media messages (documents, audio, voice notes, stickers, video, images)
  const msgType = msg.type || msg._data?.type || 'chat';
  if (msg.hasMedia || msgType === 'document' || msgType === 'audio' || msgType === 'ptt' || msgType === 'sticker' || msgType === 'video' || msgType === 'image') {
    return { action: 'IGNORED_MEDIA_OR_EMPTY' };
  }

  const rawBody = (msg.body || '').trim();

  // 3. Ignore bot automated system messages (delivery reports, help guides, balance reports, status notifications)
  if (isCartesiaBotSystemMessage(rawBody)) {
    return { action: 'IGNORED_BOT_SYSTEM_MESSAGE' };
  }

  // 4. Prevent bot self-echo loop by recently sent bot text/caption (race-condition proof)
  if (rawBody && recentSentBotTexts.has(rawBody)) {
    return { action: 'IGNORED_SELF_ECHO' };
  }

  const targetChat = remoteJid || (msg.chat?.id?._serialized) || msg.from;

  // 1. Group Command: Switch Default Voice to Malia
  const voiceSwitchMalia = rawBody.match(/^(?:(?:\/|!)?(?:voice|ভয়েস))\s*(?:মালিয়া|মালিয়া|malia|2|২)$/i);
  if (voiceSwitchMalia) {
    setCartesiaDefaultVoice(db, 'malia');
    const reply = '✅ গ্রুপের ডিফল্ট ভয়েস পরিবর্তন করা হয়েছে: *মালিয়া (Malia)*\nএখন থেকে সরাসরি যেকোনো স্ক্রিপ্ট পাঠালে মালিয়ার কণ্ঠে ভয়েস তৈরি হবে।';
    await sendGroupReply(client, targetChat, reply);
    return { action: 'DEFAULT_VOICE_CHANGED', voice: 'malia' };
  }

  // 2. Group Command: Switch Default Voice to Dalia
  const voiceSwitchDalia = rawBody.match(/^(?:(?:\/|!)?(?:voice|ভয়েস))\s*(?:দালিয়া|দালিয়া|দলিয়া|dalia|1|১)$/i);
  if (voiceSwitchDalia) {
    setCartesiaDefaultVoice(db, 'dalia');
    const reply = '✅ গ্রুপের ডিফল্ট ভয়েস পরিবর্তন করা হয়েছে: *দালিয়া (Dalia)*\nএখন থেকে সরাসরি যেকোনো স্ক্রিপ্ট পাঠালে দালিয়ার কণ্ঠে ভয়েস তৈরি হবে।';
    await sendGroupReply(client, targetChat, reply);
    return { action: 'DEFAULT_VOICE_CHANGED', voice: 'dalia' };
  }

  // 3. Group Command: Voice Help / Instructions Guide
  if (/^(?:(?:\/|!)?(?:voice|voices|ভয়েস|ভয়েস লিস্ট))$/i.test(rawBody)) {
    const defVoice = getCartesiaDefaultVoice(db);
    const defSpeed = getCartesiaDefaultSpeed(db);
    const defFormat = getCartesiaDefaultFormat(db);
    const bal = getCartesiaBalance(db);
    const helpText = formatVoiceHelpMessage({ defaultVoice: defVoice, defaultSpeed: defSpeed, defaultFormat: defFormat, balance: bal });
    await sendGroupReply(client, targetChat, helpText);
    return { action: 'VOICE_HELP_SENT', defaultVoice: defVoice };
  }

  // 4. Group Command: Set Default Speed (e.g. "speed 1.1", "স্পিড ১.২", "/speed 1.15")
  const speedSetMatch = rawBody.match(/^(?:(?:\/|!)?(?:speed|স্পিড|গতি))\s+([০-৯\d.]+)x?$/i);
  if (speedSetMatch) {
    const rawVal = speedSetMatch[1];
    const parsed = parseSpeedMultiplier(rawVal);
    const newSpeed = setCartesiaDefaultSpeed(db, parsed);
    const speedBn = toBengaliDigits(newSpeed);
    const reply = `⚡ কার্তেসিয়া ভয়েস স্পিড আপডেট করা হয়েছে: *${speedBn}x (${newSpeed}x)*\nএখন থেকে সরাসরি যেকোনো স্ক্রিপ্ট পাঠালে এই স্পিডে ভয়েস তৈরি হবে।\n(নোট: কার্তেসিয়া স্পিড লিমিট ০.৬x থেকে ১.৫x পর্যন্ত)।`;
    await sendGroupReply(client, targetChat, reply);
    return { action: 'DEFAULT_SPEED_CHANGED', speed: newSpeed };
  }

  // 5. Group Command: Check Current Speed (e.g. "speed", "স্পিড", "/speed")
  if (/^(?:(?:\/|!)?(?:speed|স্পিড|গতি))$/i.test(rawBody)) {
    const curSpeed = getCartesiaDefaultSpeed(db);
    const speedBn = toBengaliDigits(curSpeed);
    const reply = [
      `⚡ *কার্তেসিয়া ভয়েস স্পিড স্ট্যাটাস:*`,
      `• বর্তমান ডিফল্ট স্পিড: *${speedBn}x (${curSpeed}x)*`,
      `• অনুমোদিত রেঞ্জ: ০.৬x থেকে ১.৫x (স্ট্যান্ডার্ড সংবাদ গতি: ১.০x - ১.২x)`,
      `• স্পিড পরিবর্তন করতে লিখুন: \`speed <সংখ্যা>\` (যেমন: \`speed 1.1\` বা \`স্পিড ১.২\`)`,
      `• স্ক্রিপ্টে সাময়িক স্পিড দিতে: \`১.১৫x: স্ক্রিপ্ট...\``
    ].join('\n');
    await sendGroupReply(client, targetChat, reply);
    return { action: 'SPEED_STATUS_SENT', speed: curSpeed };
  }

  // 6. Group Command: Set Default Audio Format (e.g. "format mp3", "format wav", "/format mp3")
  const formatSetMatch = rawBody.match(/^(?:(?:\/|!)?(?:format|ফরম্যাট))\s+(mp3|wav|ওয়েভ|ওয়েভ)$/i);
  if (formatSetMatch) {
    const rawVal = formatSetMatch[1].toLowerCase();
    const targetFmt = (rawVal === 'wav' || rawVal === 'ওয়েভ' || rawVal === 'ওয়েভ') ? 'wav' : 'mp3';
    const newFmt = setCartesiaDefaultFormat(db, targetFmt);
    const reply = newFmt === 'mp3'
      ? '🎧 কার্তেসিয়া অডিও ফরম্যাট আপডেট করা হয়েছে: *MP3 (192kbps)*\nএখন থেকে সরাসরি যেকোনো স্ক্রিপ্ট পাঠালে MP3 ফরম্যাটে ভয়েস ফাইল তৈরি হবে।\n(ক্যাপকাট, প্রিমিয়ার প্রো, ইনশট, ভিএন সহ যেকোনো ভিডিও এডিটরে সরাসরি কাজ করবে)।'
      : '🎧 কার্তেসিয়া অডিও ফরম্যাট আপডেট করা হয়েছে: *WAV (PCM 16-bit 44.1kHz)*\nএখন থেকে সরাসরি যেকোনো স্ক্রিপ্ট পাঠালে WAV ফরম্যাটে ভয়েস ফাইল তৈরি হবে।\n(ফাইলটির হেডার স্বয়ংক্রিয়ভাবে মেরামত করা হবে যাতে কোনো ভিডিও এডিটরে সমস্যা না হয়)।';
    await sendGroupReply(client, targetChat, reply);
    return { action: 'DEFAULT_FORMAT_CHANGED', format: newFmt };
  }

  // 7. Group Command: Check Current Format (e.g. "format", "ফরম্যাট", "/format")
  if (/^(?:(?:\/|!)?(?:format|ফরম্যাট))$/i.test(rawBody)) {
    const curFmt = getCartesiaDefaultFormat(db);
    const reply = [
      `🎧 *কার্তেসিয়া অডিও ফরম্যাট স্ট্যাটাস:*`,
      `• বর্তমান ডিফল্ট ফরম্যাট: *${curFmt.toUpperCase()}*`,
      `• সমর্থিত ফরম্যাট: *MP3 (192kbps)* ও *WAV (44.1kHz)*`,
      `• ফরম্যাট পরিবর্তন করতে লিখুন: \`format mp3\` বা \`format wav\``,
      `• স্ক্রিপ্টে সাময়িক ফরম্যাট দিতে: \`mp3: স্ক্রিপ্ট...\` বা \`wav: স্ক্রিপ্ট...\``,
      `• ভিডিও এডিটর অ্যাপে (CapCut, Premiere, InShot, VN) ব্যবহারের জন্য MP3 ১০০% নির্ভরযোগ্য।`
    ].join('\n');
    await sendGroupReply(client, targetChat, reply);
    return { action: 'FORMAT_STATUS_SENT', format: curFmt };
  }

  // 8. Group Command: Set Credits Balance (e.g. "credits 450000" or "ক্রেডিট ৫০০০০০")
  const setCreditsMatch = rawBody.match(/^(?:(?:\/|!)?(?:credits?|balance|ক্রেডিট|ব্যালেন্স))\s+([০-৯\d,]+)$/i);
  if (setCreditsMatch) {
    const cleanNum = parseBengaliNumber(setCreditsMatch[1]);
    const bal = setCartesiaBalance(db, cleanNum);
    let timeStr = '';
    if (bal.approxMinutes >= 60) {
      const hrs = Math.floor(bal.approxMinutes / 60);
      const mins = Math.round(bal.approxMinutes % 60);
      timeStr = `~${toBengaliDigits(Math.round(bal.approxMinutes))} মিনিট (${toBengaliDigits(hrs)} ঘণ্টা ${toBengaliDigits(mins)} মিনিট)`;
    } else {
      timeStr = `~${toBengaliDigits(Math.round(bal.approxMinutes))} মিনিট`;
    }
    const reply = `✅ কার্তেসিয়া ক্রেডিট ব্যালেন্স আপডেট করা হয়েছে!\n• নতুন ব্যালেন্স: ${Number(cleanNum).toLocaleString('bn-BD')} ক্রেডিট\n• আনুমানিক বাকি সময়: ${timeStr} (বাংলা সংবাদ)`;
    await sendGroupReply(client, targetChat, reply);
    return { action: 'CREDITS_UPDATED', newCredits: cleanNum, approxMinutes: bal.approxMinutes };
  }

  // 9. Group Command: Check Credits Balance (e.g. "credits", "ক্রেডিট")
  if (/^(?:(?:\/|!)?(?:credits?|balance|ক্রেডিট|ব্যালেন্স))$/i.test(rawBody)) {
    const bal = getCartesiaBalance(db);
    let timeStr = '';
    if (bal.approxMinutes >= 60) {
      const hrs = Math.floor(bal.approxMinutes / 60);
      const mins = Math.round(bal.approxMinutes % 60);
      timeStr = `~${toBengaliDigits(Math.round(bal.approxMinutes))} মিনিট (${toBengaliDigits(hrs)} ঘণ্টা ${toBengaliDigits(mins)} মিনিট)`;
    } else {
      timeStr = `~${toBengaliDigits(Math.round(bal.approxMinutes))} মিনিট`;
    }
    const reply = [
      `📊 *কার্তেসিয়া ব্যালেন্স রিপোর্ট:*`,
      `• অবশিষ্ট ক্রেডিট: ${Number(bal.remainingCredits).toLocaleString('bn-BD')}`,
      `• আনুমানিক বাকি সময়: ${timeStr} (বাংলা সংবাদ স্ক্রিপ্ট)`,
      `• প্রতি মিনিটে খরচ: ~৭৫০ ক্রেডিট (১ অক্ষর = ১ ক্রেডিট)`,
      `• ব্যালেন্স আপডেট করতে লিখুন: \`credits <সংখ্যা>\``
    ].join('\n');
    await sendGroupReply(client, targetChat, reply);
    return { action: 'CREDITS_REPORT_SENT', remainingCredits: bal.remainingCredits, approxMinutes: bal.approxMinutes };
  }

  const scriptText = rawBody;
  if (scriptText.length < 5) {
    return { action: 'IGNORED_SHORT_TEXT' };
  }

  const defVoice = getCartesiaDefaultVoice(db);
  const defSpeed = getCartesiaDefaultSpeed(db);
  const defFormat = getCartesiaDefaultFormat(db);
  const { voice: targetVoice, speed: targetSpeed, format: targetFormat, cleanText } = extractVoiceChoiceAndCleanText(scriptText, defVoice, defSpeed, defFormat);
  if (!cleanText || cleanText.length < 5) {
    return { action: 'IGNORED_SHORT_TEXT' };
  }

  const msgKey = msgIdSerialized || msgIdId;
  if (msgKey && inFlightGeneratedVoiceMsgIds.has(msgKey)) {
    return { action: 'ALREADY_IN_FLIGHT' };
  }
  if (msgKey) inFlightGeneratedVoiceMsgIds.add(msgKey);

  // Normalize script using Gemini API (punctuation, spelling, numbers to words, সত্তোর, মোহাম্মদ)
  const normFn = normalizeScriptFn || normalizeScriptWithGemini;
  let scriptForAudio = cleanText;
  try {
    scriptForAudio = await normFn(cleanText);
    if (!scriptForAudio || typeof scriptForAudio !== 'string' || !scriptForAudio.trim()) {
      scriptForAudio = cleanText;
    }
  } catch (normErr) {
    console.warn('[GENERATED_VOICE] Script normalization error:', normErr.message);
    scriptForAudio = cleanText;
  }

  console.log(`[GENERATED_VOICE] Processing voice script in group (${targetVoice}, ${targetSpeed}x, ${targetFormat}): "${scriptForAudio.slice(0, 50)}..."`);

  try {
    const synth = synthesizeFn || synthesizeCartesiaVoice;
    const synthRes = await synth({ scriptText: scriptForAudio, voice: targetVoice, speed: targetSpeed, format: targetFormat });

    const finalFormat = synthRes?.format || targetFormat || 'mp3';
    const filename = buildGeneratedVoiceFilename({
      scriptText: synthRes.cleanText || scriptForAudio,
      durationSeconds: synthRes.durationSeconds,
      ext: finalFormat
    });

    const usage = recordCartesiaUsage(db, {
      scriptHeadline: filename,
      voice: synthRes.voice,
      charCount: scriptForAudio.length,
      durationSeconds: synthRes.durationSeconds,
      creditsUsed: scriptForAudio.length
    });

    const finalSpeed = synthRes?.speed !== undefined ? synthRes.speed : targetSpeed;

    const caption = formatCartesiaDeliveryReport({
      voice: synthRes.voice,
      speed: finalSpeed,
      format: finalFormat,
      durationSeconds: synthRes.durationSeconds,
      charCount: cleanText.length,
      creditsUsed: cleanText.length,
      remainingCredits: usage.remainingCredits,
      approxMinutes: usage.approxMinutes
    });

    console.log(`[GENERATED_VOICE] Synthesized ${synthRes.durationSeconds}s (${synthRes.voice}, ${finalSpeed}x, ${finalFormat}). Filename: "${filename}". Remaining: ${usage.remainingCredits} (~${usage.approxMinutes} mins)`);

    const mimeType = finalFormat === 'wav' ? 'audio/wav' : 'audio/mpeg';

    let media;
    if (MediaClass) {
      media = new MediaClass(mimeType, synthRes.buffer.toString('base64'), filename);
    } else {
      let WwebMedia = null;
      try {
        ({ MessageMedia: WwebMedia } = require('whatsapp-web.js'));
      } catch {}
      if (WwebMedia) {
        media = new WwebMedia(mimeType, synthRes.buffer.toString('base64'), filename);
      } else {
        media = {
          mimetype: mimeType,
          data: synthRes.buffer.toString('base64'),
          filename
        };
      }
    }

    const sendOptions = {
      sendMediaAsDocument: true,
      caption
    };
    if (msg.id?._serialized) {
      sendOptions.quotedMessageId = msg.id._serialized;
    }

    let sentMsg = null;
    try {
      sentMsg = await sendGroupReply(client, targetChat, media, sendOptions);
    } catch (sendErr) {
      console.warn('[GENERATED_VOICE] Quoted send with caption failed, retrying unquoted:', sendErr.message);
      sentMsg = await sendGroupReply(client, targetChat, media, { sendMediaAsDocument: true, caption });
    }

    return {
      action: 'GENERATED_VOICE_SENT',
      filename,
      durationSeconds: synthRes.durationSeconds,
      voice: synthRes.voice,
      speed: finalSpeed,
      format: finalFormat,
      charCount: cleanText.length,
      remainingCredits: usage.remainingCredits,
      approxMinutes: usage.approxMinutes,
      msgId: sentMsg?.id?._serialized
    };
  } catch (err) {
    console.error('[GENERATED_VOICE] Error generating or sending voice:', err);
    throw err;
  } finally {
    if (msgKey) inFlightGeneratedVoiceMsgIds.delete(msgKey);
  }
}

module.exports = {
  normalizeScriptWithGemini,
  extractVoiceChoiceAndCleanText,
  normalizeAbbreviationsForTts,
  formatBengaliDurationForFilename,
  buildGeneratedVoiceFilename,
  synthesizeCartesiaVoice,
  sanitizeWavHeader,
  extractFormatFromPrefix,
  isGeneratedVoiceGroup,
  handleGeneratedVoiceMessage,
  resolveChatNameSafe,
  discoverGeneratedVoiceGroup,
  formatCartesiaDeliveryReport,
  formatVoiceHelpMessage,
  isCartesiaBotSystemMessage,
  sendGroupReply,
  parseBengaliNumber,
  parseSpeedMultiplier,
  DEFAULT_VOICES,
  knownGeneratedVoiceChatIds,
  sentGeneratedVoiceMsgIds,
  recentSentBotTexts
};

