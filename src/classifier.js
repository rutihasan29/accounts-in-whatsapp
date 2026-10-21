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

function buildHistoryTranscript(messages, myUser) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  return messages
    .filter(m => m && (m.body || m.hasMedia))
    .map(m => {
      const isMe = Boolean(m.fromMe || (myUser && (m.author === myUser || m.from === myUser)));
      const sender = isMe ? '[Bot]' : '[Customer]';
      const text = (m.body || (m.hasMedia ? '<Media attached>' : '')).trim();
      return `${sender}: ${text}`;
    })
    .join('\n');
}

async function classifyChat({
  messages,
  myUser,
  apiKey = config.GEMINI_API_KEY,
  fetchFn = globalThis.fetch,
  timeoutMs = 6000
}) {
  if (!apiKey) {
    console.warn('[CLASSIFIER] No GEMINI_API_KEY provided; falling back to ESCALATE');
    return {
      classification: 'ESCALATE',
      confidence: 'LOW',
      extracted_script: '',
      reason: 'Missing GEMINI_API_KEY'
    };
  }

  const transcript = buildHistoryTranscript(messages, myUser);
  if (!transcript) {
    return {
      classification: 'OTHER',
      confidence: 'HIGH',
      extracted_script: '',
      reason: 'Empty conversation transcript'
    };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

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
    return {
      classification: parsed.classification || 'OTHER',
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
  buildHistoryTranscript,
  classifyChat
};
