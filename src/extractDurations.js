const fs = require('fs');
const path = require('path');
const { getAudioDurationWithFFprobe, calculateAudioBill } = require('./audio');

function formatMinSec(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds)) return 'N/A';
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem < 10 ? '0' : ''}${rem}s`;
}

function toBdNumber(phone) {
  let p = String(phone || '').replace(/\D/g, '');
  if (p.startsWith('880')) p = '0' + p.slice(3);
  return p;
}

const BENGALI_DIGITS = { '০': 0, '১': 1, '২': 2, '৩': 3, '৪': 4, '৫': 5, '৬': 6, '৭': 7, '৮': 8, '৯': 9 };
function parseDurationFromFilename(fn) {
  if (!fn) return null;
  const ascii = fn.replace(/[০-৯]/g, d => BENGALI_DIGITS[d] !== undefined ? BENGALI_DIGITS[d] : d);
  const minSecMatch = ascii.match(/(\d+)\s*\.\s*(\d+)/);
  if (minSecMatch) {
    const mins = parseInt(minSecMatch[1], 10);
    const secs = parseInt(minSecMatch[2], 10);
    return mins * 60 + secs;
  }
  const standaloneMatch = ascii.match(/\b(\d{2})\b/);
  if (standaloneMatch) {
    const s = parseInt(standaloneMatch[1], 10);
    if (s >= 20 && s <= 90) return s;
  }
  return null;
}

async function extractDeliveredMediaDurations({ client }) {
  console.log('[EXTRACT] Starting exact media duration extraction from live WhatsApp Web...');

  const deliveredDocsData = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/exact_delivered_media_docs.json'), 'utf8'));
  const rawData = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/whatsapp_oct26_ui_traverse_raw.json'), 'utf8'));

  // Attach rawId to each candidate
  const candidateList = deliveredDocsData.map(c => {
    const match = rawData.find(r => r.phone === c.phone);
    return {
      ...c,
      rawId: match?.rawId || (c.phone.includes('@') ? c.phone : `${c.phone}@c.us`)
    };
  });

  console.log(`[EXTRACT] Total candidates to inspect: ${candidateList.length}`);

  const finalClients = [];

  for (let idx = 0; idx < candidateList.length; idx++) {
    const cand = candidateList[idx];
    const bdNum = toBdNumber(cand.phone);
    console.log(`\n[EXTRACT] [${idx+1}/${candidateList.length}] Checking ${cand.phone} (${bdNum} - ${cand.name}) [rawId: ${cand.rawId}]...`);

    let pageResult = null;
    try {
      pageResult = await client.pupPage.evaluate(async ({ targetRawId, targetPhone }) => {
        try {
          const collections = window.require('WAWebCollections');
          const chatCollection = collections?.Chat;
          if (!chatCollection) return { error: 'No Chat collection' };

          const cleanTarget = targetPhone.replace(/\D/g, '');
          let chat = chatCollection.get(targetRawId);
          if (!chat && chatCollection.models) {
            chat = chatCollection.models.find(c => {
              const id = c.id?._serialized || '';
              const user = c.id?.user || '';
              return id === targetRawId || id === targetPhone || id.includes(cleanTarget) || user === cleanTarget;
            });
          }

          if (!chat) return { error: `Chat not found in memory for ${targetRawId}` };

          const msgsArray = chat.msgs?.models || [];
          const deliveredMedia = [];

          for (const m of msgsArray) {
            if (!m.id?.fromMe && !m.fromMe) continue;

            const fn = (m.filename || m.caption || m.body || '').trim();
            const type = (m.type || '').toLowerCase();
            const isVideo = type === 'video' || /\.(mp4|mov|mkv|avi|webm)$/i.test(fn);
            const isAudio = (type === 'audio' || type === 'document') && (/\.(wav|mp3|m4a|ogg|opus|aac)$/i.test(fn) || type === 'audio');

            const isDemo = fn.toLowerCase().startsWith('voice1') ||
                           fn.toLowerCase().startsWith('voice2') ||
                           fn.toLowerCase().startsWith('voice3') ||
                           fn.toLowerCase().startsWith('voice4') ||
                           (type === 'audio' && !fn && (m.duration === 73 || m.duration === 74 || m.duration === 92 || m.duration === 80));

            if (isDemo) continue;
            if (!isVideo && !isAudio) continue;

            let modelDuration = null;
            if (m.duration && Number(m.duration) > 0) modelDuration = Number(m.duration);
            else if (m.mediaData?.duration && Number(m.mediaData.duration) > 0) modelDuration = Number(m.mediaData.duration);
            else if (m._data?.duration && Number(m._data.duration) > 0) modelDuration = Number(m._data.duration);
            else if (m._data?.seconds && Number(m._data.seconds) > 0) modelDuration = Number(m._data.seconds);

            let base64Data = null;
            if (!modelDuration) {
              try {
                const dm = window.require('WAWebDownloadManager')?.downloadManager;
                if (dm && m.directPath && m.mediaKey) {
                  const decrypted = await dm.downloadAndMaybeDecrypt({
                    directPath: m.directPath,
                    encFilehash: m.encFilehash,
                    filehash: m.filehash,
                    mediaKey: m.mediaKey,
                    mediaKeyTimestamp: m.mediaKeyTimestamp,
                    type: m.type,
                    signal: new AbortController().signal,
                    downloadQpl: { addAnnotations: () => {}, addPoint: () => {} }
                  });
                  if (decrypted) {
                    base64Data = await window.WWebJS.arrayBufferToBase64Async(decrypted);
                  }
                }
              } catch (decErr) {}
            }

            deliveredMedia.push({
              msgId: m.id?._serialized,
              timestamp: m.t,
              filename: fn,
              type: isVideo ? 'video' : 'voice',
              modelDuration,
              hasBase64: Boolean(base64Data),
              base64Data
            });
          }

          return { success: true, deliveredMedia };
        } catch (err) {
          return { error: err.message };
        }
      }, { targetRawId: cand.rawId, targetPhone: cand.phone });
    } catch (evalErr) {
      console.warn(`[EXTRACT] evaluate error for ${cand.phone}:`, evalErr.message);
    }

    let deliveredJobs = [];

    if (pageResult && pageResult.success && Array.isArray(pageResult.deliveredMedia) && pageResult.deliveredMedia.length > 0) {
      console.log(`[EXTRACT] In-page found ${pageResult.deliveredMedia.length} delivered media items for ${cand.phone}`);

      for (const item of pageResult.deliveredMedia) {
        let exactDuration = item.modelDuration;

        if (!exactDuration && item.hasBase64 && item.base64Data) {
          try {
            const buf = Buffer.from(item.base64Data, 'base64');
            const ext = item.type === 'video' ? (path.extname(item.filename) || '.mp4') : (path.extname(item.filename) || '.wav');
            exactDuration = await getAudioDurationWithFFprobe(buf, ext);
            console.log(`[EXTRACT] -> ffprobe measured duration for "${item.filename}": ${exactDuration}s`);
          } catch (probeErr) {
            console.warn(`[EXTRACT] probe error:`, probeErr.message);
          }
        }

        if (!exactDuration && item.type === 'voice') {
          exactDuration = parseDurationFromFilename(item.filename);
          if (exactDuration) {
            console.log(`[EXTRACT] -> Fallback filename duration for "${item.filename}": ${exactDuration}s`);
          }
        }

        let calculatedBill = 0;
        if (item.type === 'voice') {
          calculatedBill = exactDuration ? calculateAudioBill(exactDuration, 50) : 50;
        } else {
          calculatedBill = 350;
        }

        deliveredJobs.push({
          jobType: item.type,
          filename: item.filename || (item.type === 'video' ? 'Video File' : 'Audio File'),
          timestamp: item.timestamp,
          dateIso: new Date(item.timestamp * 1000).toISOString(),
          dateBst: new Date(item.timestamp * 1000 + 6 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19),
          durationSeconds: exactDuration ? Math.round(exactDuration * 10) / 10 : null,
          durationFormatted: formatMinSec(exactDuration),
          calculatedBillBdt: calculatedBill,
          messageId: item.msgId
        });
      }
    } else {
      console.log(`[EXTRACT] In-page returned: ${pageResult?.error || 'No media'}. Using exact_delivered_media_docs fallback...`);
      if (Array.isArray(cand.docs) && cand.docs.length > 0) {
        for (const d of cand.docs) {
          let dur = d.dur ? parseFloat(d.dur) : null;
          if (!dur && d.type === 'voice') {
            dur = parseDurationFromFilename(d.fn);
          }

          let calculatedBill = 0;
          if (d.type === 'voice') {
            calculatedBill = dur ? calculateAudioBill(dur, 50) : 50;
          } else {
            calculatedBill = 350;
          }

          deliveredJobs.push({
            jobType: d.type,
            filename: d.fn,
            timestamp: d.t,
            dateIso: d.isoTime,
            dateBst: new Date(new Date(d.isoTime).getTime() + 6 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19),
            durationSeconds: dur ? Math.round(dur * 10) / 10 : null,
            durationFormatted: formatMinSec(dur),
            calculatedBillBdt: calculatedBill,
            messageId: null
          });
        }
      }
    }

    // Deduplicate jobs by filename and timestamp
    const uniqueDeliveredJobs = [];
    const seenJobKeys = new Set();
    deliveredJobs.forEach(j => {
      const key = `${j.filename}_${j.timestamp}_${j.jobType}`;
      if (!seenJobKeys.has(key)) {
        seenJobKeys.add(key);
        uniqueDeliveredJobs.push(j);
      }
    });

    if (uniqueDeliveredJobs.length > 0) {
      finalClients.push({
        phone: cand.phone,
        bdNumber: bdNum,
        name: cand.name,
        firstContactIso: cand.firstContact,
        firstContactBst: new Date(new Date(cand.firstContact).getTime() + 6 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19),
        totalJobs: uniqueDeliveredJobs.length,
        jobs: uniqueDeliveredJobs
      });
    }
  }

  console.log(`\n[EXTRACT] FINISHED. Total clients with delivered jobs: ${finalClients.length}`);

  // Save JSON
  const outJsonPath = path.join(__dirname, '../data/whatsapp_oct26_clients_jobs.json');
  fs.writeFileSync(outJsonPath, JSON.stringify(finalClients, null, 2), 'utf8');

  // Save CSV
  let csv = 'Client Serial,Phone Number,Client Name,First Contact Date (BST),Job Serial,Job Type,Job Date (BST),File Duration (Sec),File Duration (Min:Sec),Calculated Bill (BDT),Filename\n';
  let totalBdt = 0;
  let totalJobs = 0;

  finalClients.forEach((c, cIdx) => {
    c.jobs.forEach((j, jIdx) => {
      totalJobs++;
      totalBdt += j.calculatedBillBdt;
      const fnEsc = `"${(j.filename || '').replace(/"/g, '""')}"`;
      const nameEsc = `"${(c.name || '').replace(/"/g, '""')}"`;
      csv += `${cIdx + 1},${c.bdNumber},${nameEsc},${c.firstContactBst},${jIdx + 1},${j.jobType.toUpperCase()},${j.dateBst},${j.durationSeconds || ''},${j.durationFormatted},${j.calculatedBillBdt},${fnEsc}\n`;
    });
  });

  const outCsvPath = path.join(__dirname, '../data/whatsapp_oct26_clients_jobs.csv');
  fs.writeFileSync(outCsvPath, csv, 'utf8');

  // Save phone list
  const phonesList = finalClients.map((c, i) => `${i + 1}. ${c.bdNumber} (${c.name}) - First Contact: ${c.firstContactBst} - Jobs: ${c.totalJobs}`).join('\n');
  fs.writeFileSync(path.join(__dirname, '../data/whatsapp_oct26_clients_phones.txt'), phonesList, 'utf8');

  console.log(`[EXTRACT] Written ${totalJobs} jobs across ${finalClients.length} clients to JSON, CSV, and TXT.`);
  console.log(`[EXTRACT] Total Calculated Bill = ${totalBdt} BDT.`);

  return {
    clientsCount: finalClients.length,
    totalJobsCount: totalJobs,
    totalBillBdt: totalBdt,
    clients: finalClients
  };
}

module.exports = { extractDeliveredMediaDurations };
