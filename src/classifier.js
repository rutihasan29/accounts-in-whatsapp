const config = require('./config');

const SYSTEM_INSTRUCTION = `You are an expert message classifier for a WhatsApp audio/voice production service.
Analyze the provided conversation history between Customer and Bot.
Focus especially on the Customer's LATEST message, using the prior conversation context.

Language note: Messages may be in Bengali (বাংলা), Banglish (Bengali written in English letters), or English. Understand all three fluently.

Classify into exactly ONE of the following categories:

1. VOICE_JOB:
   - Case A (Explicit voice request): The Customer's latest message contains a script/ad copy AND explicitly asks for voiceover / audio recording (e.g., "ভয়েস লাগবে", "ভয়েস দেন", "রেকর্ড", "voice", "audio", "voiceover", "voice recording", "recording lagbe").
   - Case B (Confirmation to Bot's question): The Bot's previous question was "ভয়েস?" (or "শুধু ভয়েস?"), and the Customer's latest message answers affirmatively (e.g., "হ্যাঁ", "জি", "জী", "জি ভাই", "ji", "jee", "yes", "shudu voice", "hmm", "thik ache", "ok", "ha", "হুম", "voice", "voice e", "শুধু ভয়েস", "ভয়েস").
   In both cases, extract the full script text into extracted_script (if confirming, retrieve the script from the customer's prior message in history).

2. SCRIPT_PENDING_CONFIRMATION:
   - The Customer's latest message provides a commercial, narration, ad copy, promo announcement, or script text, BUT does not explicitly specify whether they want voiceover, video editing, or both.
   - NOTE: Even if the Bot asked "ভয়েস?" in earlier turns of the conversation for an earlier script, if the Customer is now submitting a new script without specifying voice/video, ALWAYS classify as SCRIPT_PENDING_CONFIRMATION so the Bot can ask "ভয়েস?".

3. ESCALATE:
   - Questions about pricing/rates ("কত টাকা", "রেট কত", "দাম কত", "price", "cost", "charge", "koto taka").
   - Video editing, animation, graphics, reels, or video production ("ভিডিও", "video", "reels", "graphics", "edit").
   - Revision requests, complaints, or negative replies to "ভয়েস?" (e.g., "না", "no", declining voice).
   - Any customer message that does not explicitly affirm voice or submit a new script.

4. OTHER:
   - Casual greetings ("hi", "hello", "assalamu alaikum", "kemon achen", "kire").
   - Payment notifications ("paid", "টাকা পাঠিয়েছি", "taka disi").
   - Media attachments without text, or any general chatter.

Return strictly a JSON object:
{
  "classification": "VOICE_JOB" | "SCRIPT_PENDING_CONFIRMATION" | "ESCALATE" | "OTHER",
  "confidence": "HIGH" | "LOW",
  "extracted_script": "string",
  "reason": "string"
}`;

const VALID_CLASSIFICATIONS = new Set([
  'VOICE_JOB',
  'SCRIPT_PENDING_CONFIRMATION',
  'ESCALATE',
  'OTHER'
]);

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
    if (!VALID_CLASSIFICATIONS.has(classification)) {
      classification = 'ESCALATE';
    }
    return {
      classification,
      confidence: parsed.confidence || 'LOW',
      extracted_script: parsed.extracted_script || '',
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
  const geminiModel = model || config.GEMINI_MODEL || 'gemini-3.5-flash';

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

    if (!response.ok && (response.status === 503 || response.status === 429) && geminiModel !== 'gemini-flash-latest') {
      console.warn(`[CLASSIFIER] Gemini returned ${response.status} (high demand/rate limit), retrying with gemini-flash-latest...`);
      const fallbackUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${geminiKey}`;
      try {
        response = await fetchFn(fallbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch {}
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
    if (!VALID_CLASSIFICATIONS.has(classification)) {
      classification = 'ESCALATE';
    }
    return {
      classification,
      confidence: parsed.confidence || 'LOW',
      extracted_script: parsed.extracted_script || '',
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

module.exports = {
  SYSTEM_INSTRUCTION,
  VALID_CLASSIFICATIONS,
  AFFIRMATIVE_REGEX,
  NEGATIVE_REGEX,
  isAffirmativeConfirmation,
  isNegativeConfirmation,
  buildHistoryTranscript,
  classifyWithOpenRouter,
  classifyChat
};
