const config = require('./config');

const SYSTEM_INSTRUCTION = `You are an expert message classifier for a WhatsApp audio/voice production service specializing in Bengali news voiceovers and audio narration.
Analyze the provided conversation history between Customer and Bot.
Focus especially on the Customer's LATEST message, using the prior conversation context.

Language note: Messages may be in Bengali (বাংলা), Banglish (Bengali written in English letters), or English. Understand all three fluently.

MANDATORY NEWS SCRIPT VERIFICATION RULE:
When evaluating whether a text is a script (for VOICE_JOB or SCRIPT_PENDING_CONFIRMATION), you MUST verify with utmost scrutiny: Could this candidate text reasonably be a news script, news report, feature article, bulletin, press release, or voiceover narration script (বাংলা নিউজ স্ক্রিপ্ট / সংবাদ প্রতিবেদন) intended to be read aloud and recorded by a voice artist?
- If YES: Set "is_news_script": true.
- If NO (e.g. casual conversation, personal message, general inquiry, question, greeting, payment remark, instructions, feedback, complaints, or general chatter): Set "is_news_script": false.
IF "is_news_script" is false, the message CANNOT be classified as VOICE_JOB or SCRIPT_PENDING_CONFIRMATION under any circumstances! Classify as OTHER (or ESCALATE if inquiry/pricing/video).

Classify into exactly ONE of the following categories:

1. VOICE_JOB:
   - Case A (Explicit voice request): The Customer's latest message contains an ACTUAL news script/story/report AND explicitly asks for voiceover / audio recording (e.g., "এইটার ভয়েস লাগবে: [নিউজ স্ক্রিপ্ট]", "ভয়েস করে দেন: [নিউজ স্ক্রিপ্ট]").
     CRITICAL REQUIREMENT: A message that ONLY expresses interest or inquires (e.g., "নিউজ ভয়েস লাগবে", "ভয়েস লাগবে", "ভাই ভয়েস দরকার", "voice lagbe", "audio lagbe", "amar news voice lagbe") WITHOUT an actual news story or script text to read/record is NOT a VOICE_JOB. Classify service inquiries without a script as OTHER.
   - Case B (Confirmation to Bot's question): The Bot's previous question was "ভয়েস?" (or "শুধু ভয়েস?"), and the Customer's latest message answers affirmatively (e.g., "হ্যাঁ", "জি", "জী", "জি ভাই", "ji", "jee", "yes", "shudu voice", "hmm", "thik ache", "ok", "ha", "হুম", "voice", "voice e", "শুধু ভয়েস", "ভয়েস").
   In both cases, extract the full script text into extracted_script (if confirming, retrieve the script from the customer's prior message in history). The extracted_script must be the actual content/story to be recorded, NOT an inquiry phrase.

2. SCRIPT_PENDING_CONFIRMATION:
   - The Customer's latest message provides a news story, news report, feature article, press release, or narration script text, BUT does not explicitly specify whether they want voiceover, video editing, or both.
   - You MUST ensure the text could reasonably be a news script / voiceover report ("is_news_script": true). If it is just conversation, inquiry, greetings, or non-script text, DO NOT classify as SCRIPT_PENDING_CONFIRMATION.
   - NOTE: Even if the Bot asked "ভয়েস?" in earlier turns of the conversation for an earlier script, if the Customer is now submitting a new script without specifying voice/video, ALWAYS classify as SCRIPT_PENDING_CONFIRMATION so the Bot can ask "ভয়েস?".

3. ESCALATE:
   - Questions about pricing/rates ("কত টাকা", "রেট কত", "দাম কত", "price", "cost", "charge", "koto taka").
   - Video editing, animation, graphics, reels, or video production ("ভিডিও", "video", "reels", "graphics", "edit").
   - Revision requests, complaints, or negative replies to "ভয়েস?" (e.g., "না", "no", declining voice).
   - Any customer message that does not explicitly affirm voice or submit a new script.

4. OTHER:
   - Casual greetings ("hi", "hello", "assalamu alaikum", "kemon achen", "kire").
   - Service inquiries without an actual script (e.g., "নিউজ ভয়েস লাগবে", "ভয়েস লাগবে", "voice lagbe", "recording korte chai", "amar voice dorkar", "news voice chai", "service available?").
   - General chatter, questions, personal updates, or remarks that are NOT a news script.
   - Payment notifications ("paid", "টাকা পাঠিয়েছি", "taka disi").
   - Media attachments without text, or any general chatter.

Return strictly a JSON object:
{
  "classification": "VOICE_JOB" | "SCRIPT_PENDING_CONFIRMATION" | "ESCALATE" | "OTHER",
  "confidence": "HIGH" | "LOW",
  "is_news_script": true | false,
  "extracted_script": "string",
  "reason": "string"
}`;

const VALID_CLASSIFICATIONS = new Set([
  'VOICE_JOB',
  'SCRIPT_PENDING_CONFIRMATION',
  'ESCALATE',
  'OTHER'
]);

const NEWS_SCRIPT_CHECK_INSTRUCTION = `You are an expert news editor and voiceover production analyst for a Bengali news and audio service.
Analyze the provided text and determine whether it could reasonably be a news script, news report, press release, bulletin, feature article, or audio narration script (বাংলা নিউজ স্ক্রিপ্ট / সংবাদ প্রতিবেদন) intended for voiceover recording.

Guidelines:
- Return true if the text is a news report, event update, headline story, investigative piece, crime/political/business/sports report, or narrative copy meant to be read by a voice artist.
- Return false if the text is casual conversation, personal greeting, question to the bot, inquiry ("ভয়েস লাগবে", "দাম কত"), admin chatter, payment message, complaint, instructions, or non-script talk.

Return strictly a JSON object:
{
  "is_news_script": true | false,
  "confidence": "HIGH" | "LOW",
  "reason": "string"
}`;

function buildHistoryTranscript(messages, myUser) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const cleanMyUser = myUser ? String(myUser).replace(/\D/g, '') : '';
  return messages
    .filter(m => m && (m.body || m.hasMedia))
    .map(m => {
      const isBot = Boolean(
        m.fromMe ||
        (cleanMyUser && (
          (m.author && String(m.author).replace(/\D/g, '').startsWith(cleanMyUser)) ||
          (m.from && String(m.from).replace(/\D/g, '').startsWith(cleanMyUser))
        ))
      );
      const sender = isBot ? '[Bot]' : '[Customer]';
      const text = (m.body || (m.hasMedia ? '<Media attached>' : '')).trim();
      return `${sender}: ${text}`;
    })
    .join('\n');
}

async function classifyWithOpenRouter({
  transcript,
  apiKey = config.OPENROUTER_API_KEY,
  model = config.OPENROUTER_MODEL || 'minimax/minimax-m3.1-flash:free',
  fetchFn = globalThis.fetch,
  timeoutMs = 15000
}) {
  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        models: [
          model,
          'minimax/minimax-m3.1-flash:free',
          'nvidia/nemotron-3.5-lightning:free'
        ],
        messages: [
          { role: 'system', content: SYSTEM_INSTRUCTION },
          { role: 'user', content: `Here is the conversation history (oldest to newest):\n\n${transcript}` }
        ],
        response_format: { type: 'json_object' },
        max_tokens: 1500,
        temperature: 0.1
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenRouter API error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from OpenRouter API');
    }

    let cleaned = content.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    }
    const parsed = JSON.parse(cleaned);
    let classification = parsed.classification || 'OTHER';
    let extractedScript = parsed.extracted_script || '';
    let isNewsScript = parsed.is_news_script !== undefined ? Boolean(parsed.is_news_script) : (classification === 'VOICE_JOB' || classification === 'SCRIPT_PENDING_CONFIRMATION');
    if (!VALID_CLASSIFICATIONS.has(classification)) {
      classification = 'ESCALATE';
    }

    if (classification === 'VOICE_JOB' && isServiceInquiryOnly(extractedScript)) {
      console.log(`[CLASSIFIER] Reclassifying VOICE_JOB -> OTHER because extracted_script "${extractedScript}" is only a service inquiry, not an actual script.`);
      classification = 'OTHER';
      extractedScript = '';
      isNewsScript = false;
    }

    if ((classification === 'VOICE_JOB' || classification === 'SCRIPT_PENDING_CONFIRMATION') && parsed.is_news_script === false) {
      console.log(`[CLASSIFIER] Reclassifying ${classification} -> OTHER because LLM verified text is NOT a news script.`);
      classification = 'OTHER';
      extractedScript = '';
      isNewsScript = false;
    }

    return {
      classification,
      confidence: parsed.confidence || 'LOW',
      is_news_script: isNewsScript,
      extracted_script: extractedScript,
      reason: parsed.reason || ''
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function classifyChat({
  messages,
  myUser,
  provider = config.LLM_PROVIDER,
  apiKey = undefined,
  model = null,
  fetchFn = globalThis.fetch,
  timeoutMs = 15000
}) {
  const transcript = buildHistoryTranscript(messages, myUser);
  if (!transcript) {
    return {
      classification: 'OTHER',
      confidence: 'HIGH',
      extracted_script: '',
      reason: 'Empty conversation transcript'
    };
  }

  // Never consider or classify WhatsApp group messages with AI
  const hasGroup = (messages || []).some(m => {
    const rawFrom = String(m?.from || '');
    const rawRemote = String(m?.id?.remote || '');
    return rawFrom.includes('@g.us') ||
      rawRemote.includes('@g.us') ||
      rawFrom.includes('@broadcast') ||
      rawRemote.includes('@broadcast') ||
      rawFrom.includes('@newsletter') ||
      rawRemote.includes('@newsletter') ||
      Boolean(m?.author) ||
      rawFrom.replace(/\D/g, '').startsWith('120363') ||
      rawRemote.replace(/\D/g, '').startsWith('120363');
  });

  if (hasGroup) {
    console.log('[CLASSIFIER] Group message detected; skipping AI classification completely.');
    return {
      classification: 'OTHER',
      confidence: 'HIGH',
      extracted_script: '',
      reason: 'Group message ignored'
    };
  }

  const effectiveKey = apiKey !== undefined ? apiKey : (provider === 'openrouter' ? config.OPENROUTER_API_KEY : config.GEMINI_API_KEY);

  if (!effectiveKey) {
    const missingMsg = provider === 'openrouter' ? 'Missing OPENROUTER_API_KEY' : 'Missing GEMINI_API_KEY';
    console.warn(`[CLASSIFIER] ${missingMsg}; falling back to ESCALATE`);
    return {
      classification: 'ESCALATE',
      confidence: 'LOW',
      extracted_script: '',
      reason: missingMsg
    };
  }

  if (provider === 'openrouter') {
    try {
      return await classifyWithOpenRouter({
        transcript,
        apiKey: effectiveKey,
        model: model || config.OPENROUTER_MODEL,
        fetchFn,
        timeoutMs
      });
    } catch (err) {
      console.warn('[CLASSIFIER] OpenRouter failed, falling back to Gemini:', err.message);
    }
  }

  const geminiKey = (apiKey !== undefined && provider !== 'openrouter') ? apiKey : config.GEMINI_API_KEY;
  const geminiModel = model || config.GEMINI_MODEL || 'gemini-flash-lite-latest';

  if (!geminiKey) {
    console.warn('[CLASSIFIER] No GEMINI_API_KEY provided; falling back to ESCALATE');
    return {
      classification: 'ESCALATE',
      confidence: 'LOW',
      extracted_script: '',
      reason: 'Missing GEMINI_API_KEY'
    };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`;

  const payload = {
    system_instruction: {
      parts: [{ text: SYSTEM_INSTRUCTION }]
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: `Here is the conversation history (oldest to newest):\n\n${transcript}` }]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok && (response.status === 503 || response.status === 429) && geminiModel !== 'gemini-3.1-flash-lite') {
      console.warn(`[CLASSIFIER] Gemini returned ${response.status} (rate limit), retrying with gemini-3.1-flash-lite...`);
      const fallbackUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${geminiKey}`;
      try {
        response = await fetchFn(fallbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch {}
    }

    if (!response.ok && config.OPENROUTER_API_KEY) {
      console.warn(`[CLASSIFIER] Gemini failed (${response.status}), falling back to OpenRouter...`);
      try {
        return await classifyWithOpenRouter({
          transcript,
          apiKey: config.OPENROUTER_API_KEY,
          model: config.OPENROUTER_MODEL,
          fetchFn,
          timeoutMs
        });
      } catch (orErr) {
        console.warn('[CLASSIFIER] OpenRouter fallback also failed:', orErr.message);
      }
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const textPart = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textPart) {
      throw new Error('Empty response from Gemini API');
    }

    let cleaned = textPart.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    }
    const parsed = JSON.parse(cleaned);
    let classification = parsed.classification || 'OTHER';
    let extractedScript = parsed.extracted_script || '';
    let isNewsScript = parsed.is_news_script !== undefined ? Boolean(parsed.is_news_script) : (classification === 'VOICE_JOB' || classification === 'SCRIPT_PENDING_CONFIRMATION');
    if (!VALID_CLASSIFICATIONS.has(classification)) {
      classification = 'ESCALATE';
    }

    if (classification === 'VOICE_JOB' && isServiceInquiryOnly(extractedScript)) {
      console.log(`[CLASSIFIER] Reclassifying VOICE_JOB -> OTHER because extracted_script "${extractedScript}" is only a service inquiry, not an actual script.`);
      classification = 'OTHER';
      extractedScript = '';
      isNewsScript = false;
    }

    if ((classification === 'VOICE_JOB' || classification === 'SCRIPT_PENDING_CONFIRMATION') && parsed.is_news_script === false) {
      console.log(`[CLASSIFIER] Reclassifying ${classification} -> OTHER because LLM verified text is NOT a news script.`);
      classification = 'OTHER';
      extractedScript = '';
      isNewsScript = false;
    }

    return {
      classification,
      confidence: parsed.confidence || 'LOW',
      is_news_script: isNewsScript,
      extracted_script: extractedScript,
      reason: parsed.reason || ''
    };
  } catch (err) {
    console.warn('[CLASSIFIER] Error classifying chat:', err.message);
    return {
      classification: 'ESCALATE',
      confidence: 'LOW',
      extracted_script: '',
      reason: `Error: ${err.message}`
    };
  }
}

function isServiceInquiryOnly(text) {
  if (!text || typeof text !== 'string') return true;
  const clean = text.trim();
  if (clean.length === 0) return true;

  // Normalize Bengali characters (ya variants: \u09af\u09bc -> \u09df)
  const normalized = clean.replace(/\u09af\u09bc/g, 'য়').toLowerCase();

  // Common service inquiry patterns
  const inquiryRegex = /^(ভাই|ভাইয়া|হ্যালো|আসসালামু\s*আলাইকুম|hello|hi|vai|bhai|bhaiya|admin|এডমিন)?\s*(আমার|amar)?\s*(একটি|একটা|ekta)?\s*(নিউজ|news|সংবাদ)?\s*(ভয়েস|ভয়েস|ভয়েজ|ভয়েজ|ভইস|voice|voiceover|audio|ভয়েসওভার|ভয়েসওভার|রেকর্ডিং|recording)?\s*(লাগবে|দেন|দরকার|হবে|চাই|করব|করতে\s*চাই|নিব|নেব|lagbe|dorkar|chai|needed|need|want|service)?[\s.!,?]*$/i;

  if (inquiryRegex.test(normalized)) {
    return true;
  }

  // If very short (<= 4 words) and consists only of inquiry keywords
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length <= 4) {
    const inquiryKeywords = new Set([
      'নিউজ', 'ভয়েস', 'ভয়েস', 'ভয়েজ', 'ভয়েজ', 'ভইস', 'ভয়েসওভার', 'ভয়েসওভার',
      'লাগবে', 'দরকার', 'হবে', 'চাই', 'দেন', 'করব', 'রেকর্ডিং', 'সার্ভিস',
      'ভাই', 'ভাইয়া', 'হ্যালো', 'আসসালামু', 'আলাইকুম',
      'voice', 'voiceover', 'news', 'audio', 'recording', 'lagbe', 'dorkar', 'chai',
      'need', 'needed', 'service', 'vai', 'bhai', 'bhaiya', 'hello', 'hi', 'amar', 'ekta'
    ]);
    const allKeywords = words.every(w => {
      const stripped = w.replace(/[^a-z\u0980-\u09ff]/g, '');
      return inquiryKeywords.has(stripped);
    });
    if (allKeywords) {
      return true;
    }
  }

  return false;
}

const AFFIRMATIVE_REGEX = /^(হ্যাঁ|হা|হ|জি|জী|হুম|হুঁ|yes|yeah|yep|ok|okay|thik\s*ache|ঠিক\s*আছে|শুধু\s*ভয়েস|shudu\s*voice|voice|voice\s*e)(\s+(ভাই|ভাইয়া|bhai|bhaiya|admin))?[\s.!,]*$/i;

function isAffirmativeConfirmation(text) {
  if (!text || typeof text !== 'string') return false;
  return AFFIRMATIVE_REGEX.test(text.trim());
}

const NEGATIVE_REGEX = /^(না|নাহ|না\s*ভাই|না\s*ভাইয়া|না\s*ভিডিও|no|nope|nah|not\s*voice)[\s.!,]*$/i;

function isNegativeConfirmation(text) {
  if (!text || typeof text !== 'string') return false;
  return NEGATIVE_REGEX.test(text.trim());
}

async function checkIfNewsScript({
  text,
  apiKey = undefined,
  provider = config.LLM_PROVIDER,
  model = null,
  fetchFn = globalThis.fetch,
  timeoutMs = 15000
} = {}) {
  if (!text || typeof text !== 'string') {
    return { is_news_script: false, confidence: 'HIGH', reason: 'Missing or non-string text' };
  }
  const clean = text.trim();
  if (!clean) {
    return { is_news_script: false, confidence: 'HIGH', reason: 'Empty text' };
  }
  if (isServiceInquiryOnly(clean)) {
    return { is_news_script: false, confidence: 'HIGH', reason: 'Service inquiry only' };
  }

  const effectiveKey = apiKey !== undefined ? apiKey : (provider === 'openrouter' ? config.OPENROUTER_API_KEY : config.GEMINI_API_KEY);
  if (!effectiveKey) {
    const words = clean.split(/\s+/).filter(Boolean);
    const looksLikeScript = words.length >= 3 && !isServiceInquiryOnly(clean);
    return {
      is_news_script: looksLikeScript,
      confidence: 'LOW',
      reason: 'No API key, fallback heuristic'
    };
  }

  if (provider === 'openrouter') {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchFn('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${effectiveKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            models: [
              model || config.OPENROUTER_MODEL || 'minimax/minimax-m3.1-flash:free',
              'minimax/minimax-m3.1-flash:free',
              'nvidia/nemotron-3.5-lightning:free'
            ],
            messages: [
              { role: 'system', content: NEWS_SCRIPT_CHECK_INSTRUCTION },
              { role: 'user', content: `Text to evaluate:\n\n${clean}` }
            ],
            response_format: { type: 'json_object' },
            max_tokens: 300,
            temperature: 0.1
          }),
          signal: controller.signal
        });
        if (res.ok) {
          const data = await res.json();
          let content = data?.choices?.[0]?.message?.content?.trim() || '';
          if (content.startsWith('```')) {
            content = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
          }
          const parsed = JSON.parse(content);
          return {
            is_news_script: Boolean(parsed.is_news_script),
            confidence: parsed.confidence || 'HIGH',
            reason: parsed.reason || ''
          };
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      console.warn('[CLASSIFIER] OpenRouter news script check failed, falling back to Gemini:', err.message);
    }
  }

  // Gemini check
  const geminiKey = (apiKey !== undefined && provider !== 'openrouter') ? apiKey : config.GEMINI_API_KEY;
  const geminiModel = model || config.GEMINI_MODEL || 'gemini-flash-lite-latest';
  if (!geminiKey) {
    return { is_news_script: true, confidence: 'LOW', reason: 'Missing GEMINI_API_KEY fallback' };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`;
  const payload = {
    system_instruction: {
      parts: [{ text: NEWS_SCRIPT_CHECK_INSTRUCTION }]
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: `Text to evaluate:\n\n${clean}` }]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (res.ok) {
      const data = await res.json();
      let textPart = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
      if (textPart.startsWith('```')) {
        textPart = textPart.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      }
      const parsed = JSON.parse(textPart);
      return {
        is_news_script: Boolean(parsed.is_news_script),
        confidence: parsed.confidence || 'HIGH',
        reason: parsed.reason || ''
      };
    }
  } catch (err) {
    console.warn('[CLASSIFIER] Gemini news script check error:', err.message);
  } finally {
    clearTimeout(timeout);
  }

  return { is_news_script: true, confidence: 'LOW', reason: 'LLM check failed fallback' };
}

module.exports = {
  SYSTEM_INSTRUCTION,
  NEWS_SCRIPT_CHECK_INSTRUCTION,
  VALID_CLASSIFICATIONS,
  AFFIRMATIVE_REGEX,
  NEGATIVE_REGEX,
  isAffirmativeConfirmation,
  isNegativeConfirmation,
  buildHistoryTranscript,
  isServiceInquiryOnly,
  classifyWithOpenRouter,
  classifyChat,
  checkIfNewsScript
};
