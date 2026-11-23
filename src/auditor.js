/**
 * Batch LLM Chat Auditor
 * 
 * CORE PRINCIPLE (SOURCE OF TRUTH):
 * Delivered media files (audio/video with duration) are the ABSOLUTE PRIMARY TRUTH
 * of completed production work, rather than employee bill messages.
 * Employees frequently forget to type bills, make typos, or bundle bills.
 * 
 * This module batches customer chat histories, embeds media file metadata + durations,
 * and passes them to Gemini Flash Lite for a fast, low-cost forensic audit.
 */

const config = require('./config');

/**
 * Calculates bill amount based on audio duration tiered formula:
 * Rate: 50 Taka per minute (ratePerMinute defaults to 50).
 * - Up to 1:08 (68 seconds) => counted as 1 minute (50 Taka)
 * - 1:09 to 1:19 (69s to 79s) => counted as 1.5 minutes (75 Taka)
 * - 1:20 to 2:08 (80s to 128s) => counted as 2 minutes (100 Taka)
 */
function calculateAudioBill(durationSeconds, ratePerMinute = 50) {
  if (durationSeconds === null || durationSeconds === undefined || isNaN(durationSeconds) || durationSeconds <= 0) {
    return 0;
  }
  const totalSeconds = Math.round(durationSeconds);
  if (totalSeconds <= 0) return 0;
  if (totalSeconds <= 68) return 1 * ratePerMinute;
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

const AUDITOR_SYSTEM_PROMPT = `You are an expert production and financial auditor for a WhatsApp news voiceover and video production agency.

CRITICAL GROUND TRUTH RULE:
Delivered media files (audio/video files sent by the team to the client, marked with duration) are the ABSOLUTE PRIMARY TRUTH of completed production work, NOT employee bill messages.
Employees frequently:
1. Forget to send bill messages after delivering voiceover files ("বিল দেওয়া হয়নি").
2. Make typos in bill messages (e.g. typing বিল ৫০০০ instead of ৫০০).
3. Bundle multiple jobs into one single bill.
4. Sometimes customers pay or cancel.

YOUR INSTRUCTIONS:
For each client chat provided, analyze the sequence of events and output a JSON object with a "results" array.
For each client:
1. "phone": The client phone or chat ID.
2. "jobs_delivered": Total number of completed voice/video jobs delivered (based on audio/video media sent to client).
3. "jobs": An array of each delivered job:
   - "job_type": "voice" or "video"
   - "duration_seconds": duration in seconds (from the media tag)
   - "expected_bill": calculated standard bill for this duration
   - "billed_amount": amount actually billed in chat, or null if staff forgot to bill
   - "status": "CONFIRMED_BILLED" (audio delivered + bill matched), "UNBILLED_LEAKAGE" (audio delivered + NO bill sent), or "TYPO_FLAGGED" (bill is unreasonably high/low compared to duration)
4. "total_billed": Total BDT billed by staff.
5. "unbilled_leakage_amount": Total BDT of delivered work that staff forgot to bill.
6. "audit_summary": A concise 1-sentence summary of client status.

Output MUST be strictly valid JSON matching this schema:
{
  "results": [
    {
      "phone": "...",
      "jobs_delivered": 1,
      "jobs": [
        {
          "job_type": "voice",
          "duration_seconds": 65,
          "expected_bill": 50,
          "billed_amount": 50,
          "status": "CONFIRMED_BILLED"
        }
      ],
      "total_billed": 50,
      "unbilled_leakage_amount": 0,
      "audit_summary": "1 voice job delivered and billed correctly."
    }
  ]
}`;

/**
 * Format chat messages into compacted audit representation with media metadata.
 */
function formatChatForAudit(chat) {
  const { phone, name, messages = [] } = chat;
  const lines = [`=== CLIENT: ${name || 'Unknown'} (Phone: ${phone}) ===`];

  for (const m of messages) {
    const sender = m.fromMe ? 'Team/Bot' : 'Client';
    const timeStr = m.isoTime ? m.isoTime.slice(11, 16) : '';
    
    // Check if message is delivered media
    if (m.hasMedia && m.fromMe && (m.type === 'audio' || m.type === 'ptt')) {
      const dur = m.duration || m.durationSeconds || 0;
      const expectedBill = calculateAudioBill(dur);
      lines.push(`[${timeStr}] ${sender}: <DELIVERED_AUDIO duration_seconds="${dur}" expected_rate="${expectedBill} BDT">`);
    } else if (m.hasMedia && m.fromMe && (m.type === 'video' || (m.filename && m.filename.endsWith('.mp4')))) {
      const dur = m.duration || m.durationSeconds || 0;
      lines.push(`[${timeStr}] ${sender}: <DELIVERED_VIDEO duration_seconds="${dur}">`);
    } else if (m.body) {
      const text = m.body.trim().replace(/\n+/g, ' ');
      // Detect bill or payment markers
      if (/^বিল\s+[\d০-৯]+\s*টাকা/i.test(text)) {
        lines.push(`[${timeStr}] ${sender}: <BILL_RECORDED text="${text}">`);
      } else if (/[\d০-৯]+\s*টাকা\s*পেয়েছি/i.test(text)) {
        lines.push(`[${timeStr}] ${sender}: <PAYMENT_RECORDED text="${text}">`);
      } else {
        // Truncate long customer scripts to first 120 chars to save tokens
        const snippet = text.length > 150 ? text.slice(0, 150) + '... [script]' : text;
        lines.push(`[${timeStr}] ${sender}: "${snippet}"`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Audit a batch of chats using Gemini Flash Lite.
 */
async function auditChatBatchWithLlm(chats, {
  apiKey = config.GEMINI_API_KEY,
  model = config.GEMINI_MODEL || 'gemini-flash-lite-latest',
  fetchFn = globalThis.fetch
} = {}) {
  if (!Array.isArray(chats) || chats.length === 0) {
    return { results: [] };
  }

  const compactedText = chats.map(formatChatForAudit).join('\n\n');
  const userPrompt = `Audit the following ${chats.length} WhatsApp client chat histories:\n\n${compactedText}`;

  if (!apiKey) {
    console.warn('[AUDITOR] No GEMINI_API_KEY provided; using local deterministic fallback');
    return auditChatsDeterministic(chats);
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: `${AUDITOR_SYSTEM_PROMPT}\n\n${userPrompt}` }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  };

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[AUDITOR] Gemini API error (${res.status}): ${errText.slice(0, 200)}, falling back to local audit`);
      return auditChatsDeterministic(chats);
    }

    const data = await res.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      return auditChatsDeterministic(chats);
    }

    const parsed = JSON.parse(rawText);
    return Array.isArray(parsed) ? { results: parsed } : (parsed.results ? parsed : { results: [parsed] });
  } catch (err) {
    console.warn('[AUDITOR] LLM audit failed, using local deterministic auditor:', err.message);
    return auditChatsDeterministic(chats);
  }
}

/**
 * Pure local deterministic auditor (Zero-cost fallback or offline mode).
 * Applies exact audio duration formulas and regex pattern matching.
 */
function auditChatsDeterministic(chats) {
  const results = [];

  for (const chat of chats) {
    const phone = chat.phone || chat.rawId || 'Unknown';
    const messages = chat.messages || [];

    const deliveredAudios = [];
    const deliveredVideos = [];
    let totalBilled = 0;
    const bills = [];

    for (const m of messages) {
      if (m.fromMe && (m.type === 'audio' || m.type === 'ptt')) {
        const dur = m.duration || m.durationSeconds || 0;
        const expected = calculateAudioBill(dur);
        deliveredAudios.push({ duration: dur, expected });
      } else if (m.fromMe && (m.type === 'video' || (m.filename && m.filename.endsWith('.mp4')))) {
        deliveredVideos.push({ duration: m.duration || 0, expected: 300 });
      } else if (m.body) {
        const billMatch = m.body.match(/বিল\s+([\d০-৯]+(?:\.[\d০-৯]+)?)\s*টাকা/i);
        if (billMatch) {
          const amount = parseFloat(billMatch[1].replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d))) || 0;
          totalBilled += amount;
          bills.push(amount);
        }
      }
    }

    const jobs = [];
    let unbilledLeakage = 0;

    // Match delivered audio with bills
    deliveredAudios.forEach((audio, idx) => {
      const billed = bills[idx] !== undefined ? bills[idx] : null;
      let status = 'CONFIRMED_BILLED';
      if (billed === null) {
        status = 'UNBILLED_LEAKAGE';
        unbilledLeakage += audio.expected;
      } else if (billed > audio.expected * 2.5 || (audio.expected > 0 && billed < audio.expected * 0.4)) {
        status = 'TYPO_FLAGGED';
      }

      jobs.push({
        job_type: 'voice',
        duration_seconds: audio.duration,
        expected_bill: audio.expected,
        billed_amount: billed,
        status
      });
    });

    deliveredVideos.forEach((vid, idx) => {
      const billOffset = deliveredAudios.length + idx;
      const billed = bills[billOffset] !== undefined ? bills[billOffset] : null;
      let status = 'CONFIRMED_BILLED';
      if (billed === null) {
        status = 'UNBILLED_LEAKAGE';
        unbilledLeakage += vid.expected;
      }
      jobs.push({
        job_type: 'video',
        duration_seconds: vid.duration,
        expected_bill: vid.expected,
        billed_amount: billed,
        status
      });
    });

    const jobsDelivered = jobs.length;
    let summary = `${jobsDelivered} jobs delivered.`;
    if (unbilledLeakage > 0) {
      summary += ` ⚠️ ${unbilledLeakage} BDT unbilled leakage detected.`;
    }

    results.push({
      phone,
      jobs_delivered: jobsDelivered,
      jobs,
      total_billed: totalBilled,
      unbilled_leakage_amount: unbilledLeakage,
      audit_summary: summary
    });
  }

  return { results };
}

/**
 * Initialize audit table in SQLite database.
 */
function initAuditDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT NOT NULL,
      audit_date DATE NOT NULL DEFAULT (date('now', 'localtime')),
      jobs_delivered INTEGER NOT NULL DEFAULT 0,
      total_billed REAL NOT NULL DEFAULT 0,
      unbilled_leakage REAL NOT NULL DEFAULT 0,
      details_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_audit_phone ON job_audit_logs(phone_number);
    CREATE INDEX IF NOT EXISTS idx_audit_date ON job_audit_logs(audit_date);
  `);
}

module.exports = {
  calculateAudioBill,
  AUDITOR_SYSTEM_PROMPT,
  formatChatForAudit,
  auditChatBatchWithLlm,
  auditChatsDeterministic,
  initAuditDb
};
