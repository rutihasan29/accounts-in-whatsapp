/**
 * Full-Chat LLM Job Segmentation and Production Auditor
 * 
 * Takes entire chronological customer conversations with media file types and
 * durations, identifies discrete production jobs via Google Gemini LLM (or deterministic fallback),
 * guarantees every delivered file is accounted for (EVEN IF BILL MESSAGE IS MISSING),
 * and syncs ground-truth records into metrics_chat_jobs and metrics_chat_clients.
 * 
 * Strict Privacy: ZERO customer financial data sent to WhatsApp chats.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const BENGALI_NUM_MAP = {
  '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
  '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9'
};

function normalizeDigits(str) {
  if (!str) return '';
  return String(str).replace(/[০-৯]/g, d => BENGALI_NUM_MAP[d] || d);
}

/**
 * Standard pricing formula:
 * Audio: <=60s = 50 BDT, each extra minute = +25 BDT
 * Video: 250 BDT standard rate
 */
function calculateExpectedRate(mediaType = 'audio', durationSeconds = 0) {
  const isVideo = String(mediaType).toLowerCase().includes('video') || String(mediaType).toLowerCase().endsWith('.mp4');
  if (isVideo) return 250;

  const dur = Number(durationSeconds) || 0;
  if (dur <= 0) return 50;
  if (dur <= 60) return 50;
  return 50 + Math.ceil((dur - 60) / 60) * 25;
}

function getMessageTimeMs(m) {
  if (!m) return 0;
  if (m.isoTime) {
    const ms = new Date(m.isoTime).getTime();
    if (!isNaN(ms)) return ms;
  }
  if (m.time) {
    const ms = new Date(m.time).getTime();
    if (!isNaN(ms)) return ms;
  }
  if (m.t) {
    const n = Number(m.t);
    return n > 1e11 ? n : n * 1000;
  }
  return 0;
}

/**
 * Pre-processes raw customer chat into structured message stream for LLM
 */
function formatChatForLlm(chat) {
  if (!chat) return null;
  const rawMsgs = Array.isArray(chat.messages) ? chat.messages : [];
  const cleanPhone = String(chat.clientPhone || chat.phone || chat.rawId || '').replace(/\D/g, '');
  const clientName = chat.clientName || chat.name || `Client +${cleanPhone}`;

  // Sort chronologically
  const sorted = [...rawMsgs].sort((a, b) => {
    return getMessageTimeMs(a) - getMessageTimeMs(b);
  });

  const formattedMessages = sorted.map((m, idx) => {
    const isFromMe = Boolean(m.fromMe || m.id?.fromMe);
    const type = m.type || (m.hasMedia ? 'media' : 'chat');
    const isMedia = Boolean(m.hasMedia || type === 'audio' || type === 'ptt' || type === 'video');
    const dur = Number(m.duration || m._data?.duration || 0);
    const iso = m.isoTime || (m.t ? new Date(m.t * 1000).toISOString() : null);

    return {
      index: idx + 1,
      id: m.id?._serialized || m.id?.id || (typeof m.id === 'string' ? m.id : null),
      time: iso,
      sender: isFromMe ? 'STAFF' : 'CLIENT',
      type,
      text: String(m.body || m.caption || '').trim(),
      hasMedia: isMedia,
      mediaDurationSec: isMedia ? dur : null,
      filename: m.filename || m._data?.filename || null,
      expectedRateBdt: isMedia ? calculateExpectedRate(type, dur) : null
    };
  });

  return {
    clientPhone: cleanPhone,
    clientName,
    firstContactIso: formattedMessages[0]?.time || null,
    totalMessages: formattedMessages.length,
    messages: formattedMessages
  };
}

/**
 * Builds the comprehensive prompt for Gemini LLM to detect job blocks and production worth
 * for a batch of customers
 */
function buildLlmBatchAuditPrompt(chatsPayload) {
  const jsonBatch = JSON.stringify(chatsPayload, null, 2);

  return `You are the Lead Production Auditor for News Voice Agency.
Your objective is to analyze a batch of customer WhatsApp conversations, pair each customer's news script or instruction with its delivered production file, and determine the worth (value in BDT) of each completed production job for EVERY customer in the batch.

PRICING RULES (MANDATORY):
1. Audio Voiceover (type: 'audio' or 'ptt'):
   - Duration 0 to 60 seconds: 50 BDT
   - Duration > 60 seconds: 50 BDT + 25 BDT for every additional 60 seconds (61-120s = 75 BDT, 121-180s = 100 BDT)
2. Video Production (type: 'video'): Standard rate = 250 BDT
3. Retakes/Corrections:
   - If client requests a correction or retake for a previous script ("ভুল হয়েছে", "রিটেক দিন") and staff re-delivers audio for the same script, mark as isRetake: true, worthBdt: 0, status: "FREE_RETAKE".
4. Ignore marketing demo samples:
   - Voice samples sent during initial greeting (e.g. "ডেমোগুলো শুনে দেখুন", "স্যাম্পলগুলো শুনে দেখুন") are marketing samples, NOT customer production jobs. Do not count them.

Return ONLY a valid JSON array where each element corresponds to one customer in the batch:
[
  {
    "clientPhone": "<phone number>",
    "totalJobsDetected": <number>,
    "totalWorthBdt": <number>,
    "clientSummary": {
      "totalRevenueEstimatedBdt": <number>,
      "totalRevenueBilledBdt": <number>,
      "totalLeakageBdt": <number>,
      "conversionStatus": "CONVERTED" | "LEAD_IN_PROGRESS" | "UNCONVERTED",
      "relationshipHealth": "ACTIVE_REPEAT_BUYER" | "ONE_TIME_CLIENT" | "INACTIVE"
    },
    "jobBlocks": [
      {
        "jobBlockId": <number>,
        "jobType": "voice" | "video",
        "scriptSummary": "<short headline or excerpt of customer script in Bengali>",
        "deliveredAt": "<ISO-timestamp>",
        "messageIndices": [<number>],
        "rawMediaMsgId": "<message-id or null>",
        "mediaDetails": {
          "type": "audio" | "ptt" | "video",
          "durationSeconds": <number>,
          "filename": "<string or null>"
        },
        "worthBdt": <number>,
        "expectedAmountBdt": <number>,
        "billedAmountBdt": <number>,
        "unbilledLeakageBdt": <number>,
        "status": "CONFIRMED_BILLED" | "UNBILLED_LEAKAGE" | "FREE_RETAKE",
        "isRetake": <boolean>,
        "billText": "<script headline or bill text>",
        "auditNotes": "<brief explanation of production job and rate>"
      }
    ]
  }
]

BATCH OF CHAT DATA TO AUDIT:
${jsonBatch}
`;
}

/**
 * Builds the comprehensive prompt for Gemini LLM to detect job blocks and production worth
 */
function buildLlmAuditPrompt(chatPayload) {
  const jsonChat = JSON.stringify(chatPayload, null, 2);

  return `You are the Lead Production Auditor for News Voice Agency.
Your objective is to analyze the customer conversation, pair each customer news script or instruction with its delivered production file, and determine the worth (value in BDT) of each completed production job.

PRICING RULES (MANDATORY):
1. Audio Voiceover (type: 'audio' or 'ptt'):
   - Duration 0 to 60 seconds: 50 BDT
   - Duration > 60 seconds: 50 BDT + 25 BDT for every additional 60 seconds (61-120s = 75 BDT, 121-180s = 100 BDT)
2. Video Production (type: 'video'): Standard rate = 250 BDT
3. Retakes/Corrections:
   - If client requests a correction or retake for a previous script ("ভুল হয়েছে", "রিটেক দিন") and staff re-delivers audio for the same script, mark as isRetake: true, worthBdt: 0, status: "FREE_RETAKE".
4. Ignore marketing demo samples:
   - Voice samples sent during initial greeting (e.g. "ডেমোগুলো শুনে দেখুন", "স্যাম্পলগুলো শুনে দেখুন") are marketing samples, NOT customer production jobs. Do not count them.

Return ONLY a valid JSON object matching this exact schema:
{
  "clientPhone": "${chatPayload.clientPhone}",
  "totalJobsDetected": <number>,
  "totalWorthBdt": <number>,
  "clientSummary": {
    "totalRevenueEstimatedBdt": <number>,
    "totalRevenueBilledBdt": <number>,
    "totalLeakageBdt": <number>,
    "conversionStatus": "CONVERTED" | "LEAD_IN_PROGRESS" | "UNCONVERTED",
    "relationshipHealth": "ACTIVE_REPEAT_BUYER" | "ONE_TIME_CLIENT" | "INACTIVE"
  },
  "jobBlocks": [
    {
      "jobBlockId": <number>,
      "jobType": "voice" | "video",
      "scriptSummary": "<short headline or excerpt of customer script in Bengali>",
      "deliveredAt": "<ISO-timestamp>",
      "messageIndices": [<number>],
      "rawMediaMsgId": "<message-id or null>",
      "mediaDetails": {
        "type": "audio" | "ptt" | "video",
        "durationSeconds": <number>,
        "filename": "<string or null>"
      },
      "worthBdt": <number>,
      "expectedAmountBdt": <number>,
      "billedAmountBdt": <number>,
      "unbilledLeakageBdt": <number>,
      "status": "CONFIRMED_BILLED" | "UNBILLED_LEAKAGE" | "FREE_RETAKE",
      "isRetake": <boolean>,
      "billText": "<script headline or bill text>",
      "auditNotes": "<brief explanation of production job and rate>"
    }
  ]
}

CHAT DATA TO AUDIT:
${jsonChat}
`;
}

/**
 * Runs full-history LLM job segmentation using Google Gemini
 */
async function segmentChatWithLlm(chatPayload, options = {}) {
  if (Array.isArray(chatPayload)) {
    return segmentChatBatchWithLlm(chatPayload, options);
  }

  const isAlreadyFormatted = Array.isArray(chatPayload?.messages) && 
    chatPayload.messages.length > 0 && 
    ('sender' in chatPayload.messages[0]);
  const formatted = isAlreadyFormatted ? chatPayload : formatChatForLlm(chatPayload);
  if (!formatted || !Array.isArray(formatted.messages) || formatted.messages.length === 0) {
    return { clientPhone: formatted?.clientPhone || '', totalJobsDetected: 0, jobBlocks: [] };
  }

  // Filter out chats with zero media deliveries immediately (no jobs to detect)
  const hasMediaDelivery = formatted.messages.some(m => {
    const isStaff = m.sender === 'STAFF' || m.fromMe === true || m.id?.fromMe === true;
    const isMedia = Boolean(m.hasMedia || m.type === 'audio' || m.type === 'ptt' || m.type === 'video');
    return isStaff && isMedia;
  });
  if (!hasMediaDelivery) {
    return {
      clientPhone: formatted.clientPhone,
      totalJobsDetected: 0,
      clientSummary: {
        totalRevenueEstimatedBdt: 0,
        totalRevenueBilledBdt: 0,
        totalLeakageBdt: 0,
        conversionStatus: 'LEAD_IN_PROGRESS',
        relationshipHealth: 'INACTIVE'
      },
      jobBlocks: []
    };
  }

  const apiKey = (options.apiKey !== undefined && options.apiKey !== null)
    ? options.apiKey
    : config.GEMINI_API_KEY;
  const model = options.model || config.GEMINI_MODEL || 'gemini-3-flash-preview';
  const fetchFn = options.fetchFn || globalThis.fetch;

  if (!apiKey) {
    throw new Error('[LLM_SEGMENTER] GEMINI_API_KEY is required. Deterministic fallback is disabled.');
  }

  const promptText = buildLlmAuditPrompt(formatted);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: promptText }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1
        }
      }),
      signal: AbortSignal.timeout(options.timeoutMs || 25000)
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`[LLM_SEGMENTER] Gemini API request failed with HTTP ${res.status}: ${errText}`);
    }

    const resJson = await res.json();
    const rawContent = resJson?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawContent) {
      throw new Error('[LLM_SEGMENTER] Empty response received from Gemini API');
    }

    const parsed = JSON.parse(rawContent);

    // Safeguard verification: enforce worth calculation and retake status
    if (Array.isArray(parsed.jobBlocks)) {
      for (const job of parsed.jobBlocks) {
        const isRetake = Boolean(job.isRetake || job.status === 'FREE_RETAKE');
        const dur = Number(job.mediaDetails?.durationSeconds) || 0;
        const rate = calculateExpectedRate(job.mediaDetails?.type, dur);

        if (isRetake) {
          job.worthBdt = 0;
          job.expectedAmountBdt = 0;
          job.billedAmountBdt = 0;
          job.unbilledLeakageBdt = 0;
          job.status = 'FREE_RETAKE';
        } else {
          if (!job.worthBdt || job.worthBdt <= 0) {
            job.worthBdt = job.expectedAmountBdt || rate;
          }
          if (!job.expectedAmountBdt || job.expectedAmountBdt <= 0) {
            job.expectedAmountBdt = job.worthBdt;
          }
          if (job.billedAmountBdt === undefined || job.billedAmountBdt === null) {
            job.billedAmountBdt = job.expectedAmountBdt;
          }
          if (!job.status) {
            job.status = job.billedAmountBdt >= job.expectedAmountBdt ? 'CONFIRMED_BILLED' : 'UNBILLED_LEAKAGE';
          }
        }
      }
    }

    return parsed;
  } catch (err) {
    console.error('[LLM_SEGMENTER] LLM error:', err.message);
    throw err;
  }
}

function getAvailableGeminiKeys(options = {}) {
  if (options.apiKey && typeof options.apiKey === 'string' && options.apiKey.trim()) {
    return [options.apiKey.trim()];
  }
  const rawList = [
    config.GEMINI_API_KEY,
    ...(config.GEMINI_AUDIO_API_KEYS || [])
  ];
  const valid = rawList.filter(k => typeof k === 'string' && k.trim());
  return [...new Set(valid)];
}

/**
 * Runs full-history LLM job segmentation on a batch of customer chats using Google Gemini
 */
async function segmentChatBatchWithLlm(chatsBatch, options = {}) {
  if (!Array.isArray(chatsBatch) || chatsBatch.length === 0) {
    return [];
  }

  const formattedBatch = chatsBatch.map(c => {
    const isAlreadyFormatted = Array.isArray(c?.messages) && c.messages.length > 0 && ('sender' in c.messages[0]);
    return isAlreadyFormatted ? c : formatChatForLlm(c);
  }).filter(c => c && Array.isArray(c.messages) && c.messages.length > 0);

  if (formattedBatch.length === 0) return [];

  const validChats = [];
  const emptyResults = [];

  for (const c of formattedBatch) {
    const hasMedia = c.messages.some(m => {
      const isStaff = m.sender === 'STAFF' || m.fromMe === true || m.id?.fromMe === true;
      const isMedia = Boolean(m.hasMedia || m.type === 'audio' || m.type === 'ptt' || m.type === 'video');
      return isStaff && isMedia;
    });

    if (hasMedia) {
      validChats.push(c);
    } else {
      emptyResults.push({
        clientPhone: c.clientPhone,
        totalJobsDetected: 0,
        totalWorthBdt: 0,
        clientSummary: {
          totalRevenueEstimatedBdt: 0,
          totalRevenueBilledBdt: 0,
          totalLeakageBdt: 0,
          conversionStatus: 'LEAD_IN_PROGRESS',
          relationshipHealth: 'INACTIVE'
        },
        jobBlocks: []
      });
    }
  }

  if (validChats.length === 0) {
    return emptyResults;
  }

  const availableKeys = getAvailableGeminiKeys(options);
  if (availableKeys.length === 0) {
    throw new Error('[LLM_SEGMENTER] GEMINI_API_KEY is required. Deterministic fallback is disabled.');
  }

  const model = options.model || config.GEMINI_MODEL || 'gemini-3-flash-preview';
  const fetchFn = options.fetchFn || globalThis.fetch;
  const promptText = buildLlmBatchAuditPrompt(validChats);

  let lastError = null;
  let resJson = null;

  for (let keyIdx = 0; keyIdx < availableKeys.length; keyIdx++) {
    const activeKey = availableKeys[keyIdx];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${activeKey}`;

    const maxRetries = typeof options.maxRetries === 'number' ? options.maxRetries : 2;
    let delayMs = 2000;
    let res = null;
    let keyQuotaExceeded = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        res = await fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: promptText }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.1
            }
          }),
          signal: AbortSignal.timeout(options.timeoutMs || 90000)
        });

        if (res.status === 429) {
          const errText = await res.text().catch(() => '');
          if (errText.includes('RESOURCE_EXHAUSTED') || errText.includes('quota')) {
            console.warn(`[LLM_SEGMENTER] Key ...${activeKey.slice(-6)} exceeded quota (429). Rotating to next key...`);
            keyQuotaExceeded = true;
            break;
          }
        }

        if (res.status === 503) {
          if (attempt < maxRetries) {
            console.warn(`[LLM_SEGMENTER] Gemini returned 503 on key ...${activeKey.slice(-6)}. Retrying in ${delayMs / 1000}s...`);
            await new Promise(r => setTimeout(r, delayMs));
            delayMs *= 2;
            continue;
          }
        }
        break;
      } catch (fetchErr) {
        if (attempt < maxRetries && !String(fetchErr.name).includes('Abort')) {
          await new Promise(r => setTimeout(r, delayMs));
          delayMs *= 2;
          continue;
        }
        lastError = fetchErr;
        break;
      }
    }

    if (keyQuotaExceeded) {
      continue;
    }

    if (!res || !res.ok) {
      const errText = res ? await res.text().catch(() => '') : (lastError?.message || 'Network error');
      lastError = new Error(`[LLM_SEGMENTER] Gemini API request failed with HTTP ${res?.status || 500}: ${errText}`);
      if (keyIdx < availableKeys.length - 1) {
        console.warn(`[LLM_SEGMENTER] Request failed on key ...${activeKey.slice(-6)}. Trying next key...`);
        continue;
      }
      throw lastError;
    }

    try {
      resJson = await res.json();
      break;
    } catch (parseErr) {
      lastError = parseErr;
    }
  }

  if (!resJson) {
    throw lastError || new Error('[LLM_SEGMENTER] All available Gemini API keys failed or exhausted quota.');
  }

  try {
    const rawContent = resJson?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawContent) {
      throw new Error('[LLM_SEGMENTER] Empty response received from Gemini API');
    }

    let parsedList = JSON.parse(rawContent);
    if (!Array.isArray(parsedList)) {
      parsedList = [parsedList];
    }

    for (const clientAudit of parsedList) {
      if (Array.isArray(clientAudit.jobBlocks)) {
        for (const job of clientAudit.jobBlocks) {
          const isRetake = Boolean(job.isRetake || job.status === 'FREE_RETAKE');
          const dur = Number(job.mediaDetails?.durationSeconds) || 0;
          const rate = calculateExpectedRate(job.mediaDetails?.type, dur);

          if (isRetake) {
            job.worthBdt = 0;
            job.expectedAmountBdt = 0;
            job.billedAmountBdt = 0;
            job.unbilledLeakageBdt = 0;
            job.status = 'FREE_RETAKE';
          } else {
            if (!job.worthBdt || job.worthBdt <= 0) {
              job.worthBdt = job.expectedAmountBdt || rate;
            }
            if (!job.expectedAmountBdt || job.expectedAmountBdt <= 0) {
              job.expectedAmountBdt = job.worthBdt;
            }
            if (job.billedAmountBdt === undefined || job.billedAmountBdt === null) {
              job.billedAmountBdt = job.expectedAmountBdt;
            }
            if (!job.status) {
              job.status = job.billedAmountBdt >= job.expectedAmountBdt ? 'CONFIRMED_BILLED' : 'UNBILLED_LEAKAGE';
            }
          }
        }
      }
    }

    return [...emptyResults, ...parsedList];
  } catch (err) {
    console.error('[LLM_SEGMENTER] Batch LLM error:', err.message);
    throw err;
  }
}

/**
 * Saves LLM-audited job blocks directly into metrics_chat_jobs and metrics_chat_clients
 */
function saveLlmJobBlocksToDb(db, auditResult) {
  if (!db || !auditResult || !auditResult.clientPhone) return { savedJobs: 0 };
  const phone = String(auditResult.clientPhone).replace(/\D/g, '');
  const jobs = Array.isArray(auditResult.jobBlocks) ? auditResult.jobBlocks : [];
  if (jobs.length === 0) return { savedJobs: 0 };

  const insertJob = db.prepare(`
    INSERT INTO metrics_chat_jobs (
      phone_number, job_type, delivered_at, media_type, duration_seconds,
      expected_amount_bdt, billed_amount_bdt, unbilled_leakage_bdt,
      status, raw_media_msg_id, bill_text
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalExpected = 0;
  let totalBilled = 0;
  let totalLeakage = 0;

  const tx = db.transaction(() => {
    for (const job of jobs) {
      const jobType = job.jobType === 'video' ? 'video' : 'voice';
      const deliveredAt = job.deliveredAt || new Date().toISOString();
      const mediaType = job.mediaDetails?.type || (jobType === 'video' ? 'video' : 'audio');
      const dur = Number(job.mediaDetails?.durationSeconds || 0);
      const isRetake = Boolean(job.isRetake || job.status === 'FREE_RETAKE');
      const expected = isRetake ? 0 : (Number(job.worthBdt || job.expectedAmountBdt) || calculateExpectedRate(mediaType, dur));

      // Skip 0 expected rate free retakes from polluting job counts
      if (isRetake || (job.status === 'FREE_RETAKE' && expected === 0)) {
        continue;
      }

      const billed = typeof job.billedAmountBdt === 'number' ? job.billedAmountBdt : 0;
      const unbilled = Math.max(0, expected - billed);
      const status = job.status || (billed >= expected ? 'CONFIRMED_BILLED' : (billed > 0 ? 'UNDERBILLED_ERROR' : 'UNBILLED_LEAKAGE'));

      let dbStatus = 'UNBILLED_LEAKAGE';
      if (job.status === 'CONFIRMED_BILLED' || billed >= expected) {
        dbStatus = 'CONFIRMED_BILLED';
      } else if (job.status === 'TYPO_FLAGGED') {
        dbStatus = 'TYPO_FLAGGED';
      } else {
        dbStatus = 'UNBILLED_LEAKAGE';
      }

      totalExpected += expected;
      totalBilled += billed;
      totalLeakage += unbilled;

      const scriptOrBillText = job.scriptSummary || job.billText || null;

      // Avoid duplicate entry by raw_media_msg_id or (phone, delivered_at)
      if (job.rawMediaMsgId) {
        const existing = db.prepare('SELECT id FROM metrics_chat_jobs WHERE raw_media_msg_id = ?').get(job.rawMediaMsgId);
        if (existing) {
          db.prepare(`
            UPDATE metrics_chat_jobs
            SET expected_amount_bdt = ?, billed_amount_bdt = ?, unbilled_leakage_bdt = ?, status = ?, bill_text = COALESCE(?, bill_text)
            WHERE id = ?
          `).run(expected, billed, unbilled, dbStatus, scriptOrBillText, existing.id);
          continue;
        }
      } else if (deliveredAt) {
        const existing = db.prepare('SELECT id FROM metrics_chat_jobs WHERE phone_number = ? AND delivered_at = ?').get(phone, deliveredAt);
        if (existing) {
          db.prepare(`
            UPDATE metrics_chat_jobs
            SET expected_amount_bdt = ?, billed_amount_bdt = ?, unbilled_leakage_bdt = ?, status = ?, bill_text = COALESCE(?, bill_text)
            WHERE id = ?
          `).run(expected, billed, unbilled, dbStatus, scriptOrBillText, existing.id);
          continue;
        }
      }

      insertJob.run(
        phone,
        jobType,
        deliveredAt,
        mediaType,
        dur,
        expected,
        billed,
        unbilled,
        dbStatus,
        job.rawMediaMsgId || null,
        scriptOrBillText
      );
    }

    // Update metrics client summary with exact aggregated numbers
    try {
      const stats = db.prepare(`
        SELECT 
          COUNT(*) as cnt,
          SUM(billed_amount_bdt) as sumBilled,
          SUM(unbilled_leakage_bdt) as sumLeakage,
          MIN(delivered_at) as minDelivered
        FROM metrics_chat_jobs
        WHERE phone_number = ?
      `).get(phone);

      const jobCount = stats?.cnt || 0;
      const billedTotal = stats?.sumBilled || 0;
      const leakageTotal = stats?.sumLeakage || 0;
      const firstDelivered = stats?.minDelivered || jobs[0]?.deliveredAt || new Date().toISOString();

      db.prepare(`
        INSERT INTO metrics_chat_clients (
          phone_number, client_name, first_contact_at, first_job_delivered_at,
          total_jobs_delivered, total_billed_bdt, total_unbilled_bdt, status, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'CONVERTED', CURRENT_TIMESTAMP)
        ON CONFLICT(phone_number) DO UPDATE SET
          first_job_delivered_at = COALESCE(metrics_chat_clients.first_job_delivered_at, excluded.first_job_delivered_at),
          total_jobs_delivered = excluded.total_jobs_delivered,
          total_billed_bdt = excluded.total_billed_bdt,
          total_unbilled_bdt = excluded.total_unbilled_bdt,
          status = 'CONVERTED',
          updated_at = CURRENT_TIMESTAMP
      `).run(
        phone,
        `Client +${phone}`,
        firstDelivered,
        firstDelivered,
        jobCount,
        billedTotal,
        leakageTotal
      );
    } catch (clientErr) {
      console.warn('[LLM_SEGMENTER] Client stats update error:', clientErr.message);
    }
  });

  tx();

  return {
    clientPhone: phone,
    savedJobs: jobs.length,
    totalExpected,
    totalBilled,
    totalLeakage
  };
}

/**
 * Retrieve the high watermark and pending unbilled job state for a client
 */
function getClientWatermark(db, phoneNumber) {
  if (!db || !phoneNumber) return null;
  const cleanPhone = String(phoneNumber).replace(/\D/g, '');
  if (!cleanPhone) return null;

  try {
    const summary = db.prepare(`
      SELECT 
        MAX(delivered_at) AS lastJobDeliveredAt,
        COUNT(*) AS totalJobsRecorded
      FROM metrics_chat_jobs
      WHERE phone_number = ?
    `).get(cleanPhone);

    if (!summary || !summary.lastJobDeliveredAt) {
      return {
        phone: cleanPhone,
        hasExistingJobs: false,
        lastJobDeliveredAt: null,
        totalJobsRecorded: 0,
        lastUnbilledJob: null
      };
    }

    const lastUnbilled = db.prepare(`
      SELECT id, delivered_at, raw_media_msg_id, expected_amount_bdt, billed_amount_bdt, status
      FROM metrics_chat_jobs
      WHERE phone_number = ? AND status = 'UNBILLED_LEAKAGE'
      ORDER BY delivered_at DESC
      LIMIT 1
    `).get(cleanPhone);

    return {
      phone: cleanPhone,
      hasExistingJobs: summary.totalJobsRecorded > 0,
      lastJobDeliveredAt: summary.lastJobDeliveredAt,
      totalJobsRecorded: summary.totalJobsRecorded,
      lastUnbilledJob: lastUnbilled || null
    };
  } catch (err) {
    console.warn('[WATERMARK] Error fetching watermark:', err.message);
    return null;
  }
}

/**
 * Filter messages in a chat so only new or pending-unbilled messages are processed.
 * Lookback window defaults to 15 minutes (900,000 ms).
 */
function filterIncrementalMessages(chat, watermark, lookbackMs = 15 * 60 * 1000) {
  if (!chat || !Array.isArray(chat.messages) || chat.messages.length === 0) {
    return chat;
  }

  if (!watermark || !watermark.hasExistingJobs || !watermark.lastJobDeliveredAt) {
    return chat;
  }

  // Determine cutoff timestamp in milliseconds
  let cutoffTimeMs = new Date(watermark.lastJobDeliveredAt).getTime() - lookbackMs;

  // If there is an unbilled job, anchor from that job's delivery timestamp
  if (watermark.lastUnbilledJob && watermark.lastUnbilledJob.delivered_at) {
    const unbilledTimeMs = new Date(watermark.lastUnbilledJob.delivered_at).getTime();
    if (unbilledTimeMs < cutoffTimeMs) {
      cutoffTimeMs = unbilledTimeMs;
    }
  }

  const unbilledMediaId = watermark.lastUnbilledJob?.raw_media_msg_id || null;

  const filtered = chat.messages.filter(m => {
    // If it is the exact message ID of the unbilled job, always include it for bill reconciliation
    const msgId = m.id?._serialized || m.id?.id || (typeof m.id === 'string' ? m.id : null);
    if (unbilledMediaId && msgId === unbilledMediaId) {
      return true;
    }

    const t = getMessageTimeMs(m);
    if (!t) return true; // If no time available, keep for safety
    return t >= cutoffTimeMs;
  });

  // Sort strictly ascending by chronological time
  filtered.sort((a, b) => getMessageTimeMs(a) - getMessageTimeMs(b));

  return {
    ...chat,
    messages: filtered,
    isIncremental: true,
    watermarkTimestamp: watermark.lastJobDeliveredAt,
    originalMessageCount: chat.messages.length,
    filteredMessageCount: filtered.length
  };
}

/**
 * Run full LLM audit on all or filtered client chats and save findings into database
 */
async function runLlmAuditOnAllChats(db, options = {}) {
  let chats = [];

  if (Array.isArray(options.chats) && options.chats.length > 0) {
    chats = options.chats;
  } else if (options.client && options.client.pupPage && typeof options.client.pupPage.evaluate === 'function') {
    try {
      const { extractLiveWhatsAppChats } = require('./metrics-traverser');
      chats = await extractLiveWhatsAppChats(options.client);
    } catch (e) {
      console.warn('[LLM_AUDIT] Live extraction fallback:', e.message);
    }
  }

  if (!chats || chats.length === 0) {
    const { loadChatTranscripts } = require('./metrics-traverser');
    chats = loadChatTranscripts();
  }

  if (options.phone) {
    const cleanTarget = String(options.phone).replace(/\D/g, '');
    chats = chats.filter(c => {
      const p = String(c.phone || c.rawId || '').replace(/\D/g, '');
      return p === cleanTarget;
    });
  }

  // Filter only chats with at least one media delivery from staff
  const targetChats = chats.filter(c => {
    if (!Array.isArray(c.messages) || c.messages.length === 0) return false;
    return c.messages.some(m => {
      const isStaff = Boolean(m.fromMe || m.id?.fromMe);
      const isMedia = Boolean(m.hasMedia || m.type === 'audio' || m.type === 'ptt' || m.type === 'video');
      return isStaff && isMedia;
    });
  });

  const chatsToAudit = typeof options.limit === 'number' && options.limit > 0
    ? targetChats.slice(0, options.limit)
    : targetChats;

  let totalAuditedChats = 0;
  let totalJobs = 0;
  let totalEstimated = 0;
  let totalBilled = 0;
  let totalLeakage = 0;
  const details = [];

  const preparedChats = [];
  for (const chat of chatsToAudit) {
    const cleanPhone = String(chat.phone || chat.rawId || '').replace(/\D/g, '');
    const useIncremental = options.incremental !== false && !options.forceFullAudit;
    const watermark = (useIncremental && db) ? getClientWatermark(db, cleanPhone) : null;

    const targetChat = (watermark && watermark.hasExistingJobs)
      ? filterIncrementalMessages(chat, watermark, options.lookbackMs)
      : chat;

    if (targetChat.messages && targetChat.messages.length > 0) {
      preparedChats.push({
        chat: targetChat,
        cleanPhone,
        watermark
      });
    }
  }

  const batchSize = typeof options.batchSize === 'number' && options.batchSize > 0
    ? options.batchSize
    : 8;

  const totalBatches = Math.ceil(preparedChats.length / batchSize);
  const notifyProgress = (data) => {
    if (typeof options.onProgress === 'function') {
      try { options.onProgress(data); } catch {}
    }
  };

  notifyProgress({
    isRunning: true,
    totalChats: preparedChats.length,
    auditedChats: 0,
    currentBatch: 0,
    totalBatches,
    totalJobs: 0,
    totalEstimated: 0,
    totalBilled: 0,
    totalLeakage: 0,
    statusText: `অডিট শুরু হয়েছে (মোট ${preparedChats.length}টি কাস্টমার, ${totalBatches}টি ব্যাচ)...`,
    percent: 5
  });

  for (let i = 0; i < preparedChats.length; i += batchSize) {
    const chunk = preparedChats.slice(i, i + batchSize);
    const chatsPayload = chunk.map(item => item.chat);
    const batchNum = Math.floor(i / batchSize) + 1;

    console.log(`[LLM_AUDIT] Processing batch ${batchNum}/${totalBatches} (${chunk.length} chats)...`);
    notifyProgress({
      isRunning: true,
      totalChats: preparedChats.length,
      auditedChats: totalAuditedChats,
      currentBatch: batchNum,
      totalBatches,
      totalJobs,
      totalEstimated,
      totalBilled,
      totalLeakage,
      statusText: `ব্যাচ ${batchNum}/${totalBatches} চলছে: Gemini Flash বিশ্লেষণ করছে (${chunk.length} জন কাস্টমার)...`,
      percent: Math.min(95, Math.round(((batchNum - 1) / Math.max(1, totalBatches)) * 90) + 5)
    });

    try {
      const batchAuditRes = await segmentChatBatchWithLlm(chatsPayload, options);
      if (Array.isArray(batchAuditRes)) {
        for (const auditRes of batchAuditRes) {
          if (auditRes && Array.isArray(auditRes.jobBlocks) && auditRes.jobBlocks.length > 0) {
            const saved = saveLlmJobBlocksToDb(db, auditRes);
            totalAuditedChats++;
            totalJobs += saved.savedJobs;
            totalEstimated += saved.totalExpected;
            totalBilled += saved.totalBilled;
            totalLeakage += saved.totalLeakage;

            const matchedItem = chunk.find(c => c.cleanPhone === saved.clientPhone);
            details.push({
              phone: saved.clientPhone,
              jobsCount: saved.savedJobs,
              expectedBdt: saved.totalExpected,
              billedBdt: saved.totalBilled,
              leakageBdt: saved.totalLeakage,
              incremental: Boolean(matchedItem?.watermark && matchedItem.watermark.hasExistingJobs)
            });
          }
        }
      }

      console.log(`[LLM_AUDIT] Batch ${batchNum}/${totalBatches} completed. Total jobs: ${totalJobs}, Est: ৳${totalEstimated}`);
      notifyProgress({
        isRunning: true,
        totalChats: preparedChats.length,
        auditedChats: totalAuditedChats,
        currentBatch: batchNum,
        totalBatches,
        totalJobs,
        totalEstimated,
        totalBilled,
        totalLeakage,
        statusText: `ব্যাচ ${batchNum}/${totalBatches} সম্পন্ন! (${totalAuditedChats}/${preparedChats.length} কাস্টমার, ${totalJobs}টি কাজ সনাক্ত)`,
        percent: Math.min(95, Math.round((batchNum / Math.max(1, totalBatches)) * 90) + 5)
      });
    } catch (batchErr) {
      console.warn(`[LLM_AUDIT] Error auditing batch ${batchNum}:`, batchErr.message);
      notifyProgress({
        isRunning: true,
        totalChats: preparedChats.length,
        auditedChats: totalAuditedChats,
        currentBatch: batchNum,
        totalBatches,
        totalJobs,
        totalEstimated,
        totalBilled,
        totalLeakage,
        statusText: `ব্যাচ ${batchNum} এ সাময়িক সমস্যা (${batchErr.message.slice(0, 50)})`,
        percent: Math.min(95, Math.round((batchNum / Math.max(1, totalBatches)) * 90) + 5)
      });
    }
  }

  notifyProgress({
    isRunning: false,
    totalChats: preparedChats.length,
    auditedChats: totalAuditedChats,
    currentBatch: totalBatches,
    totalBatches,
    totalJobs,
    totalEstimated,
    totalBilled,
    totalLeakage,
    statusText: `✅ সফলভাবে সম্পূর্ণ হয়েছে! মোট ${totalJobs}টি কাজ সনাক্ত ও ডেটাবেজে সংরক্ষিত।`,
    percent: 100
  });

  return {
    auditedChats: totalAuditedChats,
    totalJobs,
    totalEstimated,
    totalBilled,
    totalLeakage,
    details
  };
}

module.exports = {
  calculateExpectedRate,
  formatChatForLlm,
  buildLlmAuditPrompt,
  buildLlmBatchAuditPrompt,
  segmentChatWithLlm,
  segmentChatBatchWithLlm,
  saveLlmJobBlocksToDb,
  runLlmAuditOnAllChats,
  getClientWatermark,
  filterIncrementalMessages
};
