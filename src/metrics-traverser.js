/**
 * WhatsApp Chat Traversal & Media Ground-Truth Extraction Engine
 * 
 * Traverses raw chat conversations, detects delivered audio/video production work,
 * extracts durations and tiered pricing, identifies staff billing messages,
 * flags unbilled leakage, and persists everything into dedicated metrics tables:
 *   - metrics_chat_clients
 *   - metrics_chat_jobs
 *   - metrics_chat_events
 * 
 * Used EXCLUSIVELY for the /metrics page.
 * ZERO impact on existing bot billing tables.
 */

const fs = require('fs');
const path = require('path');
const { calculateAudioBill } = require('./auditor');

const BENGALI_NUM_MAP = {
  '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
  '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9'
};

function normalizeDigits(str) {
  if (!str) return '';
  return String(str).replace(/[০-৯]/g, d => BENGALI_NUM_MAP[d] || d);
}

function parseIso(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Locate chat transcripts JSON file.
 */
function getChatTranscriptPath() {
  const possiblePaths = [
    path.join(__dirname, '..', 'data', 'all_target_chat_messages.json'),
    'C:/Users/ASUS/.gemini/antigravity-cli/brain/e2efe527-a091-4c47-8987-e835c828fac5/scratch/all_target_chat_messages.json',
    path.join(__dirname, '..', 'data', 'whatsapp_nov1_contacts_final.json')
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Load chat transcripts from disk.
 */
function loadChatTranscripts() {
  const p = getChatTranscriptPath();
  if (!p) return [];
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('[TRAVERSER] Failed reading chat transcripts:', err.message);
    return [];
  }
}

/**
 * Traverse chat stream and sync structured production jobs to dedicated SQLite tables.
 */
function syncChatMetricsToDb(db, options = {}) {
  const rawChats = options.chats || loadChatTranscripts();
  if (!rawChats || rawChats.length === 0) {
    return { status: 'no_data', message: 'No chat transcripts found to traverse' };
  }

  const upsertClientStmt = db.prepare(`
    INSERT INTO metrics_chat_clients (
      phone_number, client_name, first_contact_at, first_job_delivered_at,
      total_jobs_delivered, total_billed_bdt, total_unbilled_bdt, status, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(phone_number) DO UPDATE SET
      client_name = COALESCE(excluded.client_name, metrics_chat_clients.client_name),
      first_contact_at = COALESCE(excluded.first_contact_at, metrics_chat_clients.first_contact_at),
      first_job_delivered_at = COALESCE(excluded.first_job_delivered_at, metrics_chat_clients.first_job_delivered_at),
      total_jobs_delivered = excluded.total_jobs_delivered,
      total_billed_bdt = excluded.total_billed_bdt,
      total_unbilled_bdt = excluded.total_unbilled_bdt,
      status = excluded.status,
      updated_at = CURRENT_TIMESTAMP
  `);

  const insertJobStmt = db.prepare(`
    INSERT INTO metrics_chat_jobs (
      phone_number, job_type, delivered_at, media_type, duration_seconds,
      expected_amount_bdt, billed_amount_bdt, unbilled_leakage_bdt,
      status, raw_media_msg_id, bill_text
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertEventStmt = db.prepare(`
    INSERT INTO metrics_chat_events (
      phone_number, event_type, event_time, latency_seconds, note
    )
    VALUES (?, ?, ?, ?, ?)
  `);

  // Clear existing traversed jobs if full re-sync
  if (options.cleanSync) {
    db.exec(`
      DELETE FROM metrics_chat_jobs;
      DELETE FROM metrics_chat_events;
      DELETE FROM metrics_chat_clients;
    `);
  }

  let totalClients = 0;
  let totalJobs = 0;
  let totalBilled = 0;
  let totalUnbilled = 0;

  const runSync = db.transaction(() => {
    for (const chat of rawChats) {
      const msgs = chat.messages || [];
      if (msgs.length === 0) continue;

      const phone = chat.phone || '';
      const clientName = chat.name || `Client ${phone}`;

      let firstContactIso = null;
      let firstStaffReplyIso = null;
      let firstJobIso = null;

      let clientJobsCount = 0;
      let clientBilled = 0;
      let clientUnbilled = 0;

      const claimedBillIndices = new Set();

      // 1. First contact and first reply detection
      for (const m of msgs) {
        if (!firstContactIso && !m.fromMe && m.isoTime) {
          firstContactIso = m.isoTime;
        }
        if (firstContactIso && !firstStaffReplyIso && m.fromMe && m.isoTime) {
          const cTime = new Date(firstContactIso).getTime();
          const rTime = new Date(m.isoTime).getTime();
          if (rTime >= cTime) {
            firstStaffReplyIso = m.isoTime;
            const latencySec = (rTime - cTime) / 1000;
            insertEventStmt.run(phone, 'FIRST_REPLY', m.isoTime, latencySec, 'Speed-to-lead latency');
          }
        }
      }

      if (!firstContactIso) {
        firstContactIso = msgs[0].isoTime || new Date().toISOString();
      }

      insertEventStmt.run(phone, 'FIRST_INQUIRY', firstContactIso, 0, 'Inbound lead contact');

      // 2. Media Delivery & Job Traversal
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (m.fromMe && (m.hasMedia || m.type === 'audio' || m.type === 'ptt' || m.type === 'video')) {
          clientJobsCount++;
          totalJobs++;

          const deliveredAt = m.isoTime || new Date().toISOString();
          if (!firstJobIso) {
            firstJobIso = deliveredAt;
            const cTime = new Date(firstContactIso).getTime();
            const jTime = new Date(deliveredAt).getTime();
            const convLatencySec = Math.max(0, (jTime - cTime) / 1000);
            insertEventStmt.run(phone, 'FIRST_JOB_DELIVERED', deliveredAt, convLatencySec, 'Time-to-first-job conversion');
          }

          const isVideo = m.type === 'video' || (m.filename && m.filename.endsWith('.mp4'));
          const jobType = isVideo ? 'video' : 'voice';
          const duration = m.duration || 0;
          const expectedRate = isVideo ? 250 : calculateAudioBill(duration, 50);

          // Contextual Bill Matching
          let foundBillAmount = null;
          let billText = null;
          const candidateIndices = [i + 1, i + 2, i + 3, i - 1];

          for (const candIdx of candidateIndices) {
            if (candIdx >= 0 && candIdx < msgs.length && !claimedBillIndices.has(candIdx)) {
              const candMsg = msgs[candIdx];
              if (candMsg.fromMe && typeof candMsg.body === 'string') {
                const normBody = normalizeDigits(candMsg.body);
                const match = normBody.match(/বিল\s*[:=\-]?\s*(\d+)/i) || normBody.match(/(\d+)\s*টাকা/i);
                if (match) {
                  foundBillAmount = parseInt(match[1], 10);
                  billText = candMsg.body;
                  claimedBillIndices.add(candIdx);
                  break;
                }
              }
            }
          }

          let jobStatus = 'CONFIRMED_BILLED';
          let billedAmount = 0;
          let unbilledAmount = 0;

          if (foundBillAmount !== null && foundBillAmount > 0) {
            // Check for wild typos (e.g. 1000 BDT for 20s voiceover)
            if (!isVideo && duration > 0 && duration < 60 && foundBillAmount >= 300) {
              jobStatus = 'TYPO_FLAGGED';
            }
            billedAmount = foundBillAmount;
            clientBilled += billedAmount;
            totalBilled += billedAmount;
          } else {
            // Staff forgot bill message -> Unbilled Staff Leakage
            jobStatus = 'UNBILLED_LEAKAGE';
            unbilledAmount = expectedRate;
            clientUnbilled += unbilledAmount;
            totalUnbilled += unbilledAmount;
          }

          insertJobStmt.run(
            phone,
            jobType,
            deliveredAt,
            m.type || 'audio',
            duration,
            expectedRate,
            billedAmount,
            unbilledAmount,
            jobStatus,
            m.id || null,
            billText
          );
        }
      }

      // Upsert client summary
      const clientStatus = clientJobsCount > 0 ? 'CONVERTED' : 'PENDING';
      upsertClientStmt.run(
        phone,
        clientName,
        firstContactIso,
        firstJobIso,
        clientJobsCount,
        clientBilled,
        clientUnbilled,
        clientStatus
      );
      totalClients++;
    }
  });

  runSync();

  return {
    status: 'ok',
    totalClients,
    totalJobs,
    totalBilled,
    totalUnbilled
  };
}

module.exports = {
  loadChatTranscripts,
  syncChatMetricsToDb,
  normalizeDigits,
  getChatTranscriptPath
};
