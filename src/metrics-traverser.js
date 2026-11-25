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
 * Locate all available chat transcript JSON files across the workspace.
 */
function getTranscriptCandidatePaths() {
  const baseDir = path.join(__dirname, '..');
  const possiblePaths = [
    path.join(baseDir, 'data', 'latest_live_chats.json'),
    path.join(baseDir, 'data', 'whatsapp_oct26_ui_traverse_raw.json'),
    path.join(baseDir, 'data', 'all_target_chat_messages.json'),
    path.join(baseDir, 'data', 'recent_chat_messages.json'),
    'C:/Users/ASUS/.gemini/antigravity-cli/brain/e2efe527-a091-4c47-8987-e835c828fac5/scratch/all_target_chat_messages.json'
  ];
  return possiblePaths.filter(p => fs.existsSync(p));
}

/**
 * Load and merge all chat transcripts from disk with deduplication across multiple dumps.
 */
function loadChatTranscripts() {
  const filePaths = getTranscriptCandidatePaths();
  if (filePaths.length === 0) return [];

  const chatMap = new Map();
  for (const fp of filePaths) {
    try {
      const raw = fs.readFileSync(fp, 'utf8');
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) continue;

      for (const item of data) {
        if (!item || (!item.phone && !item.rawId)) continue;
        const key = String(item.phone || item.rawId).replace(/\D/g, '') || item.rawId;
        if (!key) continue;

        if (!chatMap.has(key)) {
          chatMap.set(key, {
            phone: item.phone || key,
            name: item.name || '',
            rawId: item.rawId || key,
            firstContactIso: item.firstContactIso || null,
            messages: []
          });
        }

        const entry = chatMap.get(key);
        if (!entry.name && item.name) entry.name = item.name;
        if (!entry.firstContactIso && item.firstContactIso) entry.firstContactIso = item.firstContactIso;

        const seenMsgKeys = new Set(
          entry.messages.map(m => m.id || `${m.t}|${m.fromMe ? 1 : 0}|${m.type}|${m.filename || ''}|${m.duration || ''}|${m.body || ''}`)
        );

        for (const m of (item.messages || [])) {
          if (!m) continue;
          const mKey = m.id || `${m.t}|${m.fromMe ? 1 : 0}|${m.type}|${m.filename || ''}|${m.duration || ''}|${m.body || ''}`;
          if (!seenMsgKeys.has(mKey)) {
            entry.messages.push(m);
            seenMsgKeys.add(mKey);
          }
        }
      }
    } catch (err) {
      console.warn('[TRAVERSER] Error reading transcript file:', fp, err.message);
    }
  }

  // Sort messages in each chat chronologically
  for (const entry of chatMap.values()) {
    entry.messages.sort((a, b) => {
      const ta = a.t || (a.isoTime ? new Date(a.isoTime).getTime() / 1000 : 0);
      const tb = b.t || (b.isoTime ? new Date(b.isoTime).getTime() / 1000 : 0);
      return ta - tb;
    });
  }

  return Array.from(chatMap.values());
}

/**
 * Load pre-compiled production jobs directly from metrics-seed.json.
 * Used on server instances where raw 3MB transcripts are omitted from git.
 */
function loadMetricsFromSeed(db, seedPath, options = {}) {
  try {
    const raw = fs.readFileSync(seedPath, 'utf8');
    const data = JSON.parse(raw);
    const jobs = data.jobs || [];
    const clients = data.clients || [];
    const events = data.events || [];
    const adSpend = data.adSpend || [];

    if (options.cleanSync && options.forceFullClean) {
      db.exec(`
        DELETE FROM metrics_chat_jobs;
        DELETE FROM metrics_chat_events;
        DELETE FROM metrics_chat_clients;
      `);
    }

    const tx = db.transaction(() => {
      const insertJob = db.prepare(`
        INSERT INTO metrics_chat_jobs (
          id, phone_number, job_type, delivered_at, media_type, duration_seconds,
          expected_amount_bdt, billed_amount_bdt, unbilled_leakage_bdt,
          status, raw_media_msg_id, bill_text
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          phone_number = excluded.phone_number,
          job_type = excluded.job_type,
          delivered_at = excluded.delivered_at,
          media_type = excluded.media_type,
          duration_seconds = excluded.duration_seconds,
          expected_amount_bdt = excluded.expected_amount_bdt,
          billed_amount_bdt = excluded.billed_amount_bdt,
          unbilled_leakage_bdt = excluded.unbilled_leakage_bdt,
          status = excluded.status,
          raw_media_msg_id = excluded.raw_media_msg_id,
          bill_text = excluded.bill_text
      `);

      for (const j of jobs) {
        insertJob.run(
          j.id, j.phone_number, j.job_type, j.delivered_at, j.media_type,
          j.duration_seconds || 0, j.expected_amount_bdt, j.billed_amount_bdt || 0,
          j.unbilled_leakage_bdt || 0, j.status, j.raw_media_msg_id || null, j.bill_text || null
        );
      }

      const insertClient = db.prepare(`
        INSERT INTO metrics_chat_clients (
          phone_number, client_name, first_contact_at, first_job_delivered_at,
          total_jobs_delivered, total_billed_bdt, total_unbilled_bdt, status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(phone_number) DO UPDATE SET
          client_name = excluded.client_name,
          first_contact_at = excluded.first_contact_at,
          first_job_delivered_at = excluded.first_job_delivered_at,
          total_jobs_delivered = excluded.total_jobs_delivered,
          total_billed_bdt = excluded.total_billed_bdt,
          total_unbilled_bdt = excluded.total_unbilled_bdt,
          status = excluded.status
      `);

      for (const c of clients) {
        insertClient.run(
          c.phone_number, c.client_name, c.first_contact_at, c.first_job_delivered_at,
          c.total_jobs_delivered, c.total_billed_bdt, c.total_unbilled_bdt, c.status
        );
      }

      if (Array.isArray(events) && events.length > 0) {
        const insertEvent = db.prepare(`
          INSERT OR IGNORE INTO metrics_chat_events (
            id, phone_number, event_type, event_time, latency_seconds, note
          )
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const e of events) {
          insertEvent.run(e.id, e.phone_number, e.event_type, e.event_time, e.latency_seconds || 0, e.note || null);
        }
      }

      if (Array.isArray(adSpend) && adSpend.length > 0) {
        const insertSpend = db.prepare(`
          INSERT OR REPLACE INTO ad_spend (id, spend_date, amount, notes)
          VALUES (?, ?, ?, ?)
        `);
        for (const a of adSpend) {
          insertSpend.run(a.id, a.spend_date, a.amount, a.notes || null);
        }
      }
    });

    tx();

    return {
      status: 'ok',
      source: 'SEED_FILE',
      totalJobs: jobs.length,
      totalClients: clients.length,
      totalBilled: jobs.reduce((s, j) => s + (j.billed_amount_bdt || 0), 0),
      totalUnbilled: jobs.reduce((s, j) => s + (j.unbilled_leakage_bdt || 0), 0)
    };
  } catch (err) {
    console.error('[TRAVERSER] Error loading seed:', err.message);
    return { status: 'error', error: err.message };
  }
}

/**
 * Traverse chat stream and sync structured production jobs to dedicated SQLite tables.
 */
function syncChatMetricsToDb(db, options = {}) {
  const rawChats = options.chats || loadChatTranscripts();
  if (!rawChats || rawChats.length === 0) {
    const seedPath = path.join(__dirname, 'metrics-seed.json');
    if (fs.existsSync(seedPath)) {
      return loadMetricsFromSeed(db, seedPath, options);
    }
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

  // Clear existing traversed jobs if full re-sync (preserving live real-time bot jobs unless forceFullClean is requested)
  if (options.cleanSync) {
    if (options.forceFullClean) {
      db.exec(`
        DELETE FROM metrics_chat_jobs;
        DELETE FROM metrics_chat_events;
        DELETE FROM metrics_chat_clients;
      `);
    } else {
      db.exec(`
        DELETE FROM metrics_chat_jobs WHERE substr(delivered_at, 1, 10) <= '2026-11-14';
        DELETE FROM metrics_chat_events WHERE substr(event_time, 1, 10) <= '2026-11-14';
        DELETE FROM metrics_chat_clients WHERE phone_number NOT IN (SELECT DISTINCT phone_number FROM metrics_chat_jobs);
      `);
    }
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
          const expectedRate = isVideo ? 250 : (duration > 0 ? calculateAudioBill(duration, 50) : 50);

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

/**
 * Backwards compatibility helper returning primary transcript path.
 */
function getChatTranscriptPath() {
  const paths = getTranscriptCandidatePaths();
  return paths[0] || null;
}

/**
 * In-page WhatsApp Web message extractor for live sync.
 */
async function extractLiveWhatsAppChats(client) {
  if (!client?.pupPage || typeof client.pupPage.evaluate !== 'function') {
    return [];
  }
  try {
    const res = await client.pupPage.evaluate(async () => {
      const chatCollection = window.require('WAWebCollections')?.Chat;
      if (!chatCollection) return [];
      const allModels = chatCollection.getModelsArray();
      const results = [];
      for (const chat of allModels) {
        const rawId = chat.id?._serialized || '';
        if (!rawId || chat.isGroup || chat.isBroadcast || rawId.endsWith('@g.us') || rawId.endsWith('@broadcast') || rawId.endsWith('@newsletter')) {
          continue;
        }

        let phone = null;
        if (rawId.endsWith('@c.us') || rawId.endsWith('@s.whatsapp.net')) {
          phone = rawId.split('@')[0].split(':')[0].replace(/\D/g, '');
        } else if (rawId.endsWith('@lid')) {
          try {
            const widFactory = window.require('WAWebWidFactory');
            const targetWid = widFactory.createWid(rawId);
            const contactApi = window.require('WAWebApiContact');
            if (contactApi?.getPhoneNumber) {
              const pWid = contactApi.getPhoneNumber(targetWid);
              if (pWid?.user) phone = pWid.user;
            }
          } catch {}
          if (!phone) phone = rawId.split('@')[0].split(':')[0].replace(/\D/g, '');
        }

        const msgs = chat.msgs?.getModelsArray() || [];
        const extractedMsgs = msgs.map(m => ({
          id: m.id?._serialized,
          t: m.t,
          isoTime: m.t ? new Date(m.t * 1000).toISOString() : null,
          fromMe: Boolean(m.id?.fromMe),
          type: m.type,
          body: m.body || '',
          caption: m.caption || '',
          filename: m.filename || '',
          duration: m.duration || m._data?.duration || 0,
          hasMedia: Boolean(m.isMedia || m.mimetype)
        }));

        if (extractedMsgs.length > 0) {
          results.push({
            rawId,
            phone: phone || rawId,
            name: chat.name || chat.formattedTitle || '',
            firstContactIso: extractedMsgs[0]?.isoTime || null,
            messages: extractedMsgs
          });
        }
      }
      return results;
    });
    return Array.isArray(res) ? res : [];
  } catch (err) {
    console.error('[LIVE_SYNC] Error in extractLiveWhatsAppChats:', err.message);
    return [];
  }
}

module.exports = {
  loadChatTranscripts,
  syncChatMetricsToDb,
  normalizeDigits,
  getChatTranscriptPath,
  getTranscriptCandidatePaths,
  extractLiveWhatsAppChats
};
