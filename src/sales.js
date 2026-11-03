const {
  saveWhatsappCustomerNote,
  getWhatsappCustomerNotes
} = require('./db');

/**
 * Format phone number to clean Bangladeshi display format (01XXXXXXXXX).
 */
function formatDisplayNumber(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('8801') && digits.length === 13) {
    return '0' + digits.slice(3);
  }
  if (digits.startsWith('01') && digits.length === 11) {
    return digits;
  }
  return digits || String(phone);
}

/**
 * Calculate lead status color:
 * - 2+ distinct billing days: green
 * - 1 billing day: yellow
 * - 0 billing days + note present: black
 * - 0 billing days + no note: red
 */
function calculateCustomerColor({ daysBilled = 0, hasNote = false }) {
  if (daysBilled >= 2) return 'green';
  if (daysBilled === 1) return 'yellow';
  if (hasNote) return 'black';
  return 'red';
}

/**
 * Calculate weekly average orders:
 * Total orders / weeks active since first contact.
 */
function calculateWeeklyAvgOrders({ totalOrders = 0, firstContactAt, now = Date.now() }) {
  if (!totalOrders || totalOrders <= 0) return 0.0;
  const firstTime = firstContactAt ? new Date(firstContactAt).getTime() : now;
  const diffMs = Math.max(0, now - firstTime);
  const weeks = Math.max(1, diffMs / (7 * 24 * 60 * 60 * 1000));
  return Number((totalOrders / weeks).toFixed(1));
}

/**
 * Formats a calendar date string (YYYY-MM-DD) into a human-readable title (e.g. 3 November 2026).
 */
function formatGroupDate(dateStr) {
  if (!dateStr) return '';
  const parts = String(dateStr).split('-');
  if (parts.length !== 3) return dateStr;
  const year = parseInt(parts[0], 10);
  const monthIdx = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const monthName = months[monthIdx] || parts[1];
  return `${day} ${monthName} ${year}`;
}

/**
 * Compute weekly average orders distribution histogram.
 */
function computeHistogram(leads = []) {
  const buckets = [
    { range: '0.0', min: 0, max: 0, count: 0 },
    { range: '0.1 - 1.0', min: 0.01, max: 1.0, count: 0 },
    { range: '1.1 - 2.0', min: 1.01, max: 2.0, count: 0 },
    { range: '2.1 - 3.0', min: 2.01, max: 3.0, count: 0 },
    { range: '3.1 - 5.0', min: 3.01, max: 5.0, count: 0 },
    { range: '> 5.0', min: 5.01, max: Infinity, count: 0 }
  ];

  const total = leads.length;

  for (const lead of leads) {
    const val = Number(lead.weeklyAvgOrders) || 0;
    for (const b of buckets) {
      if (b.max === 0) {
        if (val === 0) {
          b.count++;
          break;
        }
      } else if (val >= b.min && val <= b.max) {
        b.count++;
        break;
      }
    }
  }

  const maxCount = Math.max(1, ...buckets.map(b => b.count));

  return buckets.map(b => {
    const pct = total > 0 ? ((b.count / total) * 100).toFixed(1) : '0.0';
    const barLen = Math.round((b.count / maxCount) * 24);
    const bar = '#'.repeat(barLen);
    return {
      range: b.range,
      count: b.count,
      percentage: pct,
      bar
    };
  });
}

/**
 * Fetch all leads since startDate, attach notes, compute metrics & colors,
 * and group by calendar date.
 */
function getSalesLeads(db, { startDate = '2026-11-01', now = Date.now() } = {}) {
  if (!db) {
    return { startDate, totalLeads: 0, histogram: [], dateGroups: [] };
  }

  // 1. Fetch leads filtered by startDate
  const leads = db.prepare(`
    SELECT phone_number, name, first_contact_at, status, welcome_sent
    FROM leads
    WHERE first_contact_at >= ?
    ORDER BY first_contact_at DESC
  `).all(startDate);

  // 2. Fetch existing customer notes
  const notesRows = getWhatsappCustomerNotes(db);
  const notesMap = new Map();
  for (const n of notesRows) {
    const clean = String(n.phone).replace(/\D/g, '');
    if (clean) notesMap.set(clean, n.note);
  }

  // 3. Batch fetch billing history from transactions
  const billRows = db.prepare(`
    SELECT phone_number,
           COUNT(*) as bill_count,
           COUNT(DISTINCT date(created_at)) as bill_days,
           MIN(created_at) as first_bill_at
    FROM transactions
    WHERE type = 'BILL'
    GROUP BY phone_number
  `).all();
  const billsMap = new Map();
  for (const b of billRows) {
    const clean = String(b.phone_number).replace(/\D/g, '');
    if (clean) billsMap.set(clean, b);
  }

  // 4. Batch fetch voice orders from voice_job_orders
  const orderRows = db.prepare(`
    SELECT customer_phone,
           COUNT(*) as order_count,
           COUNT(DISTINCT date(created_at)) as order_days,
           MIN(created_at) as first_order_at
    FROM voice_job_orders
    WHERE status = 'DELIVERED'
    GROUP BY customer_phone
  `).all();
  const ordersMap = new Map();
  for (const o of orderRows) {
    const clean = String(o.customer_phone).replace(/\D/g, '');
    if (clean) ordersMap.set(clean, o);
  }

  // 5. Build enriched lead list and group by date
  let globalIndex = 1;
  const groupsByDate = new Map();
  const allEnrichedLeads = [];

  for (const lead of leads) {
    const rawPhone = String(lead.phone_number || '').trim();
    const cleanPhone = rawPhone.replace(/\D/g, '');
    const formattedNumber = formatDisplayNumber(rawPhone);

    const note = notesMap.get(cleanPhone) || '';
    const billData = billsMap.get(cleanPhone) || null;
    const orderData = ordersMap.get(cleanPhone) || null;

    const daysBilled = Math.max(billData?.bill_days || 0, orderData?.order_days || 0);
    const totalOrders = Math.max(billData?.bill_count || 0, orderData?.order_count || 0);
    const firstOrderTime = billData?.first_bill_at || orderData?.first_order_at || lead.first_contact_at;

    const weeklyAvgOrders = calculateWeeklyAvgOrders({
      totalOrders,
      firstContactAt: firstOrderTime,
      now
    });

    const color = calculateCustomerColor({
      daysBilled,
      hasNote: Boolean(note && note.trim())
    });

    // Date grouping key YYYY-MM-DD
    const contactDateStr = lead.first_contact_at ? String(lead.first_contact_at).split('T')[0].split(' ')[0] : 'Unknown';

    const enrichedLead = {
      index: globalIndex++,
      phone: rawPhone,
      cleanPhone,
      displayNumber: formattedNumber,
      name: lead.name || null,
      note,
      color,
      daysBilled,
      totalOrders,
      weeklyAvgOrders,
      firstContactAt: lead.first_contact_at
    };

    allEnrichedLeads.push(enrichedLead);

    if (!groupsByDate.has(contactDateStr)) {
      groupsByDate.set(contactDateStr, []);
    }
    groupsByDate.get(contactDateStr).push(enrichedLead);
  }

  const dateGroups = [];
  for (const [dateStr, groupLeads] of groupsByDate.entries()) {
    dateGroups.push({
      date: dateStr,
      formattedDate: formatGroupDate(dateStr),
      leads: groupLeads
    });
  }

  // 6. Compute histogram over all leads
  const histogram = computeHistogram(allEnrichedLeads);

  return {
    startDate,
    totalLeads: allEnrichedLeads.length,
    histogram,
    dateGroups
  };
}

/**
 * Fetch a customer's note from WhatsApp Web via client/pupPage.
 */
async function fetchWhatsAppCustomerNote(client, phone) {
  if (!client || !phone) return null;
  const cleanPhone = String(phone).replace(/\D/g, '');
  if (!cleanPhone) return null;

  if (client?.pupPage && typeof client.pupPage.evaluate === 'function') {
    try {
      const content = await client.pupPage.evaluate(async (cleanPhone) => {
        try {
          const openDb = () => new Promise((resolve, reject) => {
            const req = window.indexedDB.open('model-storage');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const idb = await openDb();
          if (idb.objectStoreNames.contains('note')) {
            const tx = idb.transaction('note', 'readonly');
            const req = tx.objectStore('note').getAll();
            const rawNotes = await new Promise(r => {
              req.onsuccess = () => r(req.result || []);
              req.onerror = () => r([]);
            });
            idb.close();
            const match = rawNotes.find(n => {
              const cJid = String(n.chatJid || '').replace(/\D/g, '');
              return cJid === cleanPhone;
            });
            if (match && match.content) return String(match.content).trim();
          }
        } catch {}
        return null;
      }, cleanPhone);

      if (content) return content;
    } catch {}
  }

  return null;
}

/**
 * Sync notes for all recent leads or loaded contacts from WhatsApp Web into SQLite.
 */
async function syncWhatsAppNotes(db, client, { limit = 60, startDate = '2026-11-01' } = {}) {
  if (!db || !client) return { synced: 0 };

  // 1. Direct high-speed batch scan of IndexedDB model-storage notes
  let batchCount = 0;
  if (client?.pupPage && typeof client.pupPage.evaluate === 'function') {
    try {
      const extracted = await client.pupPage.evaluate(async () => {
        const openDb = () => new Promise((resolve, reject) => {
          const req = window.indexedDB.open('model-storage');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });

        let rawNotes = [];
        try {
          const idb = await openDb();
          if (idb.objectStoreNames.contains('note')) {
            const tx = idb.transaction('note', 'readonly');
            const req = tx.objectStore('note').getAll();
            rawNotes = await new Promise(r => {
              req.onsuccess = () => r(req.result || []);
              req.onerror = () => r([]);
            });
          }
          idb.close();
        } catch {}

        const results = [];
        const widFactory = window.require('WAWebWidFactory');
        const contactApi = window.require('WAWebApiContact');
        const collections = window.require('WAWebCollections');

        for (const n of rawNotes) {
          const chatJid = n.chatJid || '';
          const content = n.content || '';
          if (!chatJid || !content) continue;

          let resolvedPhone = null;
          try {
            if (widFactory && contactApi) {
              const wid = widFactory.createWid(chatJid);
              if (contactApi.getPhoneNumber) {
                const pWid = contactApi.getPhoneNumber(wid);
                if (pWid?.user) resolvedPhone = pWid.user;
              }
              if (!resolvedPhone && collections?.Contact) {
                const c = collections.Contact.get(wid);
                if (c?.phoneNumber?.user) resolvedPhone = c.phoneNumber.user;
              }
              if (!resolvedPhone && collections?.Chat) {
                const ch = collections.Chat.get(wid);
                if (ch?.contact?.phoneNumber?.user) resolvedPhone = ch.contact.phoneNumber.user;
              }
            }
          } catch {}

          results.push({
            cleanJid: chatJid.split('@')[0].replace(/\D/g, ''),
            resolvedPhone: resolvedPhone ? String(resolvedPhone).replace(/\D/g, '') : null,
            content: content.trim()
          });
        }

        return results;
      });

      if (Array.isArray(extracted) && extracted.length > 0) {
        for (const item of extracted) {
          if (item.cleanJid && item.content) {
            saveWhatsappCustomerNote(db, item.cleanJid, item.content);
            batchCount++;
          }
          if (item.resolvedPhone && item.resolvedPhone !== item.cleanJid && item.content) {
            saveWhatsappCustomerNote(db, item.resolvedPhone, item.content);
          }
        }
      }
    } catch (err) {
      console.warn('[SALES] Error during in-page note extraction:', err.message);
    }
  }

  // 2. For leads that do not yet have a note in DB, fetch on-demand
  const leads = db.prepare(`
    SELECT phone_number FROM leads
    WHERE first_contact_at >= ?
    ORDER BY first_contact_at DESC
    LIMIT ?
  `).all(startDate, limit);

  let individualCount = 0;
  for (const lead of leads) {
    const cleanPhone = String(lead.phone_number).replace(/\D/g, '');
    if (!cleanPhone) continue;
    try {
      const note = await fetchWhatsAppCustomerNote(client, cleanPhone);
      if (note) {
        saveWhatsappCustomerNote(db, cleanPhone, note);
        individualCount++;
      }
    } catch {}
  }

  return { synced: batchCount + individualCount };
}

module.exports = {
  formatDisplayNumber,
  calculateCustomerColor,
  calculateWeeklyAvgOrders,
  formatGroupDate,
  computeHistogram,
  getSalesLeads,
  fetchWhatsAppCustomerNote,
  syncWhatsAppNotes
};
