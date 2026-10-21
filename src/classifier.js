const config = require('./config');

const SYSTEM_INSTRUCTION = `You are an expert message classifier for a WhatsApp audio/voice production service.
Analyze the provided conversation history between Customer and Bot.

Classify into exactly ONE of the following categories:
1. VOICE_JOB:
   - The Customer submits an ad script / voiceover text and explicitly requests voice or audio (e.g., "voice", "audio", "ভয়েস", "রেকর্ড", "voice lagbe").
   - OR, the Bot previously asked "শুধু ভয়েস?", and the Customer's latest message confirms affirmatively (e.g., "হ্যাঁ", "জি", "yes", "shudu voice", "hmm", "thik ache", "ok").
   Extract the clean script into extracted_script.

2. SCRIPT_PENDING_CONFIRMATION:
   - The Customer provides a commercial, narration, or ad script without specifying whether they need voiceover, video editing, or both, and the Bot has NOT yet asked "শুধু ভয়েস?".

3. ESCALATE:
   - Questions about pricing, video editing, graphics, revisions, complaints, or ambiguous/complex queries where intent is uncertain.

4. OTHER:
   - Casual greetings (hi, hello, salam), payment receipts, or unrelated chatter requiring no script dispatch.

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
  model = config.OPENROUTER_MODEL || 'nvidia/nemotron-3.5-lightning:free',
  fetchFn = globalThis.fetch,
  timeoutMs = 6000
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
          'nvidia/nemotron-3-super-120b-a12b:free'
        ],
        messages: [
          { role: 'system', content: SYSTEM_INSTRUCTION },
          { role: 'user', content: `Here is the conversation history (oldest to newest):\n\n${transcript}` }
        ],
        response_format: { type: 'json_object' },
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
  timeoutMs = 6000
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

module.exports = {
  SYSTEM_INSTRUCTION,
  VALID_CLASSIFICATIONS,
  buildHistoryTranscript,
  classifyWithOpenRouter,
  classifyChat
};
