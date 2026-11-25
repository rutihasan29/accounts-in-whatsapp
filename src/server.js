const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  getDueList,
  getCustomerSummary,
  getCustomerTransactions,
  getAllCustomersSummary,
  getDashboardStats,
  recordAdSpend,
  getAdSpendList,
  getAdSpendSummary,
  getSimulationBaselines,
  getBotUptimeStats,
  addVideoCustomer,
  removeVideoCustomer,
  getVideoCustomers,
  getAllBotSettings,
  setBotSetting,
  DEFAULT_BOT_SETTINGS
} = require('./db');
const { getBusinessKpiReport } = require('./metrics');
const { getCohortPaybackAnalysis } = require('./cohort');
const { getMetricsAnalytics } = require('./metrics-roi');
const { syncChatMetricsToDb, extractLiveWhatsAppChats } = require('./metrics-traverser');
const { runLlmAuditOnAllChats } = require('./llm-job-segmenter');
const { PORT, DASHBOARD_PIN } = require('./config');
const { syncExistingInboxContacts } = require('./sync');
const { resolveCustomerPhone } = require('./bot');
const { handleCrmRequest } = require('./crm/api');
const { checkAndEscalateTimeouts } = require('./crm/routing');
const { createCaller, updateCallerStatus } = require('./crm/db');
const { getSalesLeads, syncWhatsAppNotes } = require('./sales');
const { getServerVersionInfo, performUpdate, verifyGitHubWebhookSignature } = require('./updater');
const {
  getQrStatus,
  getQrDataUrl,
  getQrPngBuffer,
  getQrSvg
} = require('./qrState');

const DASHBOARD_HTML_PATH = path.join(__dirname, 'dashboard.html');
const SALES_HTML_PATH = path.join(__dirname, 'sales.html');
const QR_HTML_PATH = path.join(__dirname, 'qr.html');
const METRICS_HTML_PATH = path.join(__dirname, 'metrics.html');
let lastSalesNotesSyncTime = 0;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        return resolve({});
      }
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Invalid JSON payload: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getNetworkIps() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push({ name, address: net.address });
      }
    }
  }
  return ips;
}

function renderHtmlPage(options = {}) {
  const db = options.db;
  let html = fs.readFileSync(DASHBOARD_HTML_PATH, 'utf8');

  if (db) {
    try {
      const stats = getDashboardStats(db);
      try {
        stats.kpi = getBusinessKpiReport(db);
        stats.cohort = getCohortPaybackAnalysis(db);
      } catch (e) {
        console.error('Error pre-rendering KPI/cohort in dashboard:', e.message);
      }
      const customers = getAllCustomersSummary(db);
      const simBaselines = getSimulationBaselines(db);
      const adSpendSummary = getAdSpendSummary(db);
      const adSpendList = getAdSpendList(db, { limit: 60 });
      const botUptime = getBotUptimeStats(db);
      const botSettings = getAllBotSettings(db);
      const initialJson = JSON.stringify({
        stats,
        customers,
        simBaselines,
        adSpendSummary,
        adSpendList,
        botUptime,
        botSettings
      });
      html = html.replace('/*__INITIAL_DATA__*/', `window.__INITIAL_DATA__ = ${initialJson};\n`);
    } catch (e) {
      console.error('Error pre-rendering initial data in dashboard:', e.message);
    }
  }
  return html;
}

function renderPrintableStatement({ summary, transactions }) {
  const custName = summary?.name || 'Client';
  const custPhone = summary?.phone_number || '';
  const cleanPhone = custPhone.replace(/\D/g, '');
  const totalBill = summary?.total_bill || 0;
  const totalPaid = summary?.total_paid || 0;
  const dueAmount = summary?.due_amount || 0;

  const rows = (transactions || []).map((t) => {
    const isBill = t.type === 'BILL';
    const dr = isBill ? Number(t.amount).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : '--';
    const cr = !isBill ? Number(t.amount).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : '--';
    const bal = Number(t.running_balance).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    const dt = new Date(t.created_at);
    const dateFormatted = !isNaN(dt) ? dt.toLocaleDateString('en-GB') : t.created_at;

    return `
      <tr>
        <td>${escapeHtml(dateFormatted)}</td>
        <td>${escapeHtml(t.raw_text || (isBill ? 'Audio Bill' : 'Payment'))}</td>
        <td class="num">${dr}</td>
        <td class="num">${cr}</td>
        <td class="num"><strong>${bal}</strong></td>
      </tr>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>STATEMENT &bull; ${escapeHtml(custName)} (+${escapeHtml(custPhone)})</title>
  <style>
    body {
      font-family: 'Courier New', Courier, monospace;
      font-size: 13px;
      line-height: 1.4;
      background: #FFF;
      color: #000;
      padding: 20px;
      max-width: 700px;
      margin: 0 auto;
    }
    .header {
      text-align: center;
      border-bottom: 2px solid #000;
      padding-bottom: 12px;
      margin-bottom: 14px;
    }
    h1 {
      font-size: 16px;
      letter-spacing: 1px;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .details {
      display: flex;
      justify-content: space-between;
      margin-bottom: 12px;
      font-size: 12px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
    }
    th, td {
      border: 1px solid #000;
      padding: 6px 5px;
      text-align: left;
    }
    th {
      background: #F4F4F4;
      font-weight: bold;
    }
    .num {
      text-align: right;
    }
    .total-row {
      font-weight: bold;
      border-top: 3px double #000;
    }
    .actions {
      margin-top: 20px;
      display: flex;
      gap: 10px;
    }
    .btn {
      padding: 8px 14px;
      background: #FFF;
      border: 1px solid #000;
      font-family: inherit;
      font-size: 12px;
      font-weight: bold;
      cursor: pointer;
      text-decoration: none;
      color: #000;
    }
    .btn-dark {
      background: #000;
      color: #FFF;
    }
    @media print {
      .actions { display: none; }
      body { padding: 0; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>NEWS VOICE &bull; STATEMENT OF ACCOUNT</h1>
    <div>OFFICIAL CLIENT COPY &bull; VOICE &amp; AUDIO DISPATCH SERVICES</div>
  </div>

  <div class="details">
    <div>
      <strong>CLIENT:</strong> ${escapeHtml(custName)}<br>
      <strong>PHONE:</strong> +${escapeHtml(custPhone)}
    </div>
    <div style="text-align: right;">
      <strong>DATE:</strong> ${new Date().toLocaleDateString('en-GB')}<br>
      <strong>CLIENT ID:</strong> ${escapeHtml(cleanPhone)}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width: 20%;">DATE</th>
        <th>PARTICULAR / DETAILS</th>
        <th class="num" style="width: 18%;">BILL (DR)</th>
        <th class="num" style="width: 18%;">PAID (CR)</th>
        <th class="num" style="width: 20%;">BALANCE</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="5" style="text-align:center;">No records found.</td></tr>'}
    </tbody>
    <tfoot>
      <tr class="total-row">
        <td colspan="4" style="text-align: right;">OUTSTANDING TOTAL DUE:</td>
        <td class="num">৳ ${Number(dueAmount).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}</td>
      </tr>
    </tfoot>
  </table>

  <div class="actions">
    <button class="btn btn-dark" onclick="window.print()">🖨️ PRINT / SAVE AS PDF</button>
    <a href="/" class="btn">&larr; BACK TO LEDGER</a>
  </div>
</body>
</html>`;
}

function startWebServer({ db, client = null, port = PORT, onRestart = null, autoSeed = false } = {}) {
  const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check
    if (pathname === '/health' || pathname === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
      return;
    }

    // API: Extract delivered media durations directly from WhatsApp Web
    if (pathname === '/api/extract-client-media-durations') {
      try {
        if (!client) {
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ status: 'error', message: 'WhatsApp client is not connected' }));
          return;
        }
        delete require.cache[require.resolve('./extractDurations')];
        const { extractDeliveredMediaDurations } = require('./extractDurations');
        const results = await extractDeliveredMediaDurations({ client });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', data: results }));
      } catch (err) {
        console.error('[EXTRACT ERROR]', err);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', message: err.message, stack: err.stack }));
      }
      return;
    }

    // API: Verify Admin PIN
    if (pathname === '/api/auth/verify-pin' && method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const expectedPin = String(DASHBOARD_PIN || '6700').trim();
        if (body.pin !== undefined && String(body.pin).trim() === expectedPin) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: 'Incorrect PIN' }));
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
      }
      return;
    }

    // Telecaller CRM Routes & Static Assets (/crm*, /api/crm/*)
    if (pathname && (pathname.startsWith('/crm') || pathname.startsWith('/api/crm'))) {
      const handled = await handleCrmRequest(req, res, db);
      if (handled) return;
    }

    // Sales Leads Directory Page (/sales)
    if (pathname === '/sales' && method === 'GET') {
      try {
        const html = fs.readFileSync(SALES_HTML_PATH, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Error reading sales page: ' + err.message);
      }
      return;
    }

    // WhatsApp Web QR Code Scanner Page (/qr)
    if (pathname === '/qr' && method === 'GET') {
      try {
        const html = fs.readFileSync(QR_HTML_PATH, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Error reading QR page: ' + err.message);
      }
      return;
    }

    // Dedicated Ground-Truth Metrics Page (/metrics)
    if (pathname === '/metrics' && method === 'GET') {
      try {
        const accept = req.headers['accept'] || '';
        if (accept.includes('application/json')) {
          const analytics = getMetricsAnalytics(db, {
            startDate: parsedUrl.query?.startDate || null,
            endDate: parsedUrl.query?.endDate || null,
            customDailySpend: parsedUrl.query?.spend || null
          });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(analytics));
          return;
        }
        const html = fs.readFileSync(METRICS_HTML_PATH, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Error reading metrics page: ' + err.message);
      }
      return;
    }

    // API: Dedicated Ground-Truth Analytics & ROI
    if (pathname === '/api/metrics/analytics' && method === 'GET') {
      try {
        const analytics = getMetricsAnalytics(db, {
          startDate: parsedUrl.query?.startDate || null,
          endDate: parsedUrl.query?.endDate || null,
          customDailySpend: parsedUrl.query?.spend || null
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(analytics));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', error: err.message }));
      }
      return;
    }

    // API: Re-sync chat transcripts to dedicated metrics tables & live WhatsApp Web
    if ((pathname === '/api/metrics/sync' || pathname === '/api/metrics/sync-live') && method === 'POST') {
      try {
        const body = await readJsonBody(req).catch(() => ({}));
        let liveSynced = false;
        let liveChatCount = 0;

        // 1. If payload contains uploaded chats or custom json
        if (body.chats && Array.isArray(body.chats) && body.chats.length > 0) {
          const livePath = path.join(__dirname, '..', 'data', 'latest_live_chats.json');
          fs.writeFileSync(livePath, JSON.stringify(body.chats, null, 2), 'utf8');
          liveSynced = true;
          liveChatCount = body.chats.length;
        } else if (client && client.pupPage && typeof client.pupPage.evaluate === 'function') {
          // 2. If WhatsApp client is connected and ready, attempt in-page live extraction
          try {
            const extracted = await extractLiveWhatsAppChats(client);
            if (extracted && extracted.length > 0) {
              const livePath = path.join(__dirname, '..', 'data', 'latest_live_chats.json');
              fs.writeFileSync(livePath, JSON.stringify(extracted, null, 2), 'utf8');
              liveSynced = true;
              liveChatCount = extracted.length;
            }
          } catch (liveErr) {
            console.warn('[METRICS_SYNC] Live extraction warning:', liveErr.message);
          }
        }

        // Run traversal across all available and newly merged transcripts
        const result = syncChatMetricsToDb(db, { cleanSync: true });
        const qrInfo = getQrStatus();

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          status: 'ok',
          success: true,
          liveSynced,
          liveChatCount,
          qrRequired: !liveSynced && qrInfo.status !== 'READY',
          qrStatus: qrInfo.status,
          qrUrl: '/qr',
          result,
          message: liveSynced
            ? `সফলভাবে ${liveChatCount}টি চ্যাট থেকে লাইভ ডেটা সিঙ্ক করা হয়েছে!`
            : (qrInfo.status === 'READY'
                ? `ডেটাবেজে সকল উপলব্ধ চ্যাট সফলভাবে সিঙ্ক হয়েছে (${result.totalJobs}টি কাজ)।`
                : `ডেটাবেজে সকল উপলব্ধ চ্যাট সিঙ্ক হয়েছে (${result.totalJobs}টি কাজ, ১৪ নভেম্বর পর্যন্ত)। আজকের লাইভ ডেটা পেতে দয়া করে /qr পেজ থেকে WhatsApp কিউআর কোড স্ক্যান করুন।`)
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', error: err.message }));
      }
      return;
    }

    // Global AI Audit progress tracker state
    if (!globalThis._currentAiAuditProgress) {
      globalThis._currentAiAuditProgress = {
        isRunning: false,
        startedAt: null,
        totalChats: 0,
        auditedChats: 0,
        currentBatch: 0,
        totalBatches: 0,
        totalJobs: 0,
        totalEstimated: 0,
        totalBilled: 0,
        totalLeakage: 0,
        statusText: 'কোনো অডিট চলছে না',
        percent: 0,
        lastResult: null,
        error: null
      };
    }
    const currentAiAuditProgress = globalThis._currentAiAuditProgress;

    // API: Real-time progress tracker for ongoing AI audit
    if ((pathname === '/api/metrics/ai-audit/progress' || pathname === '/api/metrics/ai-audit/status') && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(JSON.stringify({
        status: 'ok',
        ...currentAiAuditProgress
      }));
      return;
    }

    // API: Run Full AI LLM Job Segmentation and Production Leakage Audit
    if (pathname === '/api/metrics/ai-audit' && method === 'POST') {
      try {
        const body = await readJsonBody(req).catch(() => ({}));

        if (currentAiAuditProgress.isRunning && !body.force) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            status: 'running',
            success: true,
            message: 'অডিট ইতিমধ্যে ব্যাকগ্রাউন্ডে চলছে',
            ...currentAiAuditProgress
          }));
          return;
        }

        const auditOptions = {
          phone: body.phone || null,
          limit: typeof body.limit === 'number' ? body.limit : null,
          batchSize: typeof body.batchSize === 'number' ? body.batchSize : 8,
          client: client || null,
          apiKey: (typeof body.apiKey === 'string' && body.apiKey.trim()) ? body.apiKey.trim() : null,
          incremental: body.incremental !== undefined ? Boolean(body.incremental) : true,
          forceFullAudit: Boolean(body.forceFullAudit),
          onProgress: (prog) => {
            Object.assign(currentAiAuditProgress, prog);
          }
        };

        currentAiAuditProgress.isRunning = true;
        currentAiAuditProgress.startedAt = new Date().toISOString();
        currentAiAuditProgress.statusText = 'অডিট শুরু হচ্ছে...';
        currentAiAuditProgress.percent = 2;
        currentAiAuditProgress.error = null;
        currentAiAuditProgress.totalJobs = 0;
        currentAiAuditProgress.totalEstimated = 0;
        currentAiAuditProgress.totalBilled = 0;
        currentAiAuditProgress.totalLeakage = 0;

        if (body.async) {
          // Asynchronous execution for real-time progress polling
          runLlmAuditOnAllChats(db, auditOptions).then(summary => {
            currentAiAuditProgress.lastResult = summary;
            currentAiAuditProgress.isRunning = false;
            currentAiAuditProgress.percent = 100;
          }).catch(err => {
            currentAiAuditProgress.error = err.message;
            currentAiAuditProgress.isRunning = false;
            currentAiAuditProgress.statusText = `ত্রুটি: ${err.message}`;
          });

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            status: 'ok',
            success: true,
            async: true,
            message: 'AI Audit started in background',
            progress: currentAiAuditProgress
          }));
          return;
        }

        // Synchronous execution (for unit tests and direct callers)
        const auditSummary = await runLlmAuditOnAllChats(db, auditOptions);
        currentAiAuditProgress.lastResult = auditSummary;
        currentAiAuditProgress.isRunning = false;

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          status: 'ok',
          success: true,
          ...auditSummary
        }));
      } catch (err) {
        currentAiAuditProgress.isRunning = false;
        currentAiAuditProgress.error = err.message;
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', error: err.message }));
      }
      return;
    }

    // API: Export all metrics production jobs, clients, and ad spend (for remote instance sync)
    if ((pathname === '/api/metrics/export-chats' || pathname === '/api/metrics/export-live') && method === 'GET') {
      try {
        const jobs = db.prepare('SELECT * FROM metrics_chat_jobs ORDER BY delivered_at ASC').all();
        const clients = db.prepare('SELECT * FROM metrics_chat_clients ORDER BY first_contact_at ASC').all();
        const adSpend = db.prepare('SELECT * FROM ad_spend ORDER BY spend_date ASC').all();
        let latestLiveChats = [];
        const livePath = path.join(__dirname, '..', 'data', 'latest_live_chats.json');
        if (fs.existsSync(livePath)) {
          try { latestLiveChats = JSON.parse(fs.readFileSync(livePath, 'utf8')); } catch {}
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
          status: 'ok',
          exportedAt: new Date().toISOString(),
          counts: {
            jobs: jobs.length,
            clients: clients.length,
            adSpend: adSpend.length,
            liveChats: latestLiveChats.length
          },
          jobs,
          clients,
          adSpend,
          latestLiveChats
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', error: err.message }));
      }
      return;
    }

    // API: Sync data from remote server instance directly into local SQLite database
    if (pathname === '/api/metrics/sync-remote' && method === 'POST') {
      try {
        const body = await readJsonBody(req).catch(() => ({}));
        let payload = null;

        if (body.data && typeof body.data === 'object') {
          payload = body.data;
        } else if (body.remoteUrl) {
          let remoteUrl = String(body.remoteUrl).trim().replace(/\/+$/, '');
          if (!remoteUrl.startsWith('http://') && !remoteUrl.startsWith('https://')) {
            remoteUrl = 'http://' + remoteUrl;
          }
          const targetExportUrl = `${remoteUrl}/api/metrics/export-chats`;
          console.log(`[REMOTE_SYNC] Fetching live data from remote server: ${targetExportUrl}`);

          const fetchRes = await fetch(targetExportUrl, {
            signal: AbortSignal.timeout(15000),
            headers: { 'Accept': 'application/json' }
          });

          if (!fetchRes.ok) {
            throw new Error(`Remote server returned HTTP ${fetchRes.status}: ${fetchRes.statusText}`);
          }
          payload = await fetchRes.json();
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ status: 'error', error: 'Please provide remoteUrl or data payload' }));
          return;
        }

        if (!payload || (!payload.jobs && !payload.clients)) {
          throw new Error('Invalid or empty export payload received from remote server');
        }

        const jobs = payload.jobs || [];
        const clients = payload.clients || [];
        const adSpend = payload.adSpend || [];
        const latestLiveChats = payload.latestLiveChats || [];

        // Upsert into local SQLite
        const syncTransaction = db.transaction(() => {
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

        syncTransaction();

        if (Array.isArray(latestLiveChats) && latestLiveChats.length > 0) {
          const livePath = path.join(__dirname, '..', 'data', 'latest_live_chats.json');
          fs.writeFileSync(livePath, JSON.stringify(latestLiveChats, null, 2), 'utf8');
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          status: 'ok',
          success: true,
          message: `সফলভাবে রিমোট সার্ভার থেকে ${jobs.length}টি কাজ ও ${clients.length}টি ক্লায়েন্টের ডেটা সিঙ্ক করা হয়েছে!`,
          syncedAt: new Date().toISOString(),
          counts: {
            jobs: jobs.length,
            clients: clients.length,
            adSpend: adSpend.length
          }
        }));
      } catch (err) {
        console.error('[REMOTE_SYNC] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          status: 'error',
          error: `রিমোট সার্ভার সিঙ্ক ব্যর্থ: ${err.message}`
        }));
      }
      return;
    }

    // API: Live WhatsApp QR status & data URL
    if (pathname === '/api/qr' && method === 'GET') {
      try {
        const qrInfo = getQrStatus();
        let qrImage = null;
        if (qrInfo.hasQr) {
          qrImage = await getQrDataUrl();
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(JSON.stringify({
          status: qrInfo.status,
          hasQr: qrInfo.hasQr,
          qr: qrInfo.qr,
          qrTime: qrInfo.qrTime,
          qrImage,
          userPhone: qrInfo.userPhone
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', error: err.message }));
      }
      return;
    }

    // Raw binary PNG of active QR code
    if (pathname === '/qr.png' && method === 'GET') {
      try {
        const pngBuf = await getQrPngBuffer();
        if (pngBuf) {
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': pngBuf.length,
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          });
          res.end(pngBuf);
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ status: 'NO_ACTIVE_QR', message: 'No active QR code waiting for scan' }));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Error generating QR image: ' + err.message);
      }
      return;
    }

    // API: Sales Leads Directory Data (/api/sales/leads)
    if (pathname === '/api/sales/leads' && method === 'GET') {
      try {
        const startDate = parsedUrl.query?.startDate || '2026-11-01';
        const data = getSalesLeads(db, { startDate });

        // Non-blocking background sync if WhatsApp client is active and > 15s since last sync
        if (client && Date.now() - lastSalesNotesSyncTime > 15000) {
          lastSalesNotesSyncTime = Date.now();
          syncWhatsAppNotes(db, client, { startDate }).catch(() => {});
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Trigger WhatsApp Customer Notes Sync (/api/sales/sync-notes)
    if (pathname === '/api/sales/sync-notes' && method === 'POST') {
      try {
        if (!client) {
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'WhatsApp client is not connected' }));
          return;
        }
        const resSync = await syncWhatsAppNotes(db, client);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', ...resSync }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Inbox Sync - POST trigger scan & sync
    if (pathname === '/api/sync-inbox' && method === 'POST') {
      try {
        if (!client) {
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ status: 'error', message: 'WhatsApp client is not connected' }));
          return;
        }
        const syncResult = await syncExistingInboxContacts({ client, db, resolveCustomerPhone });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', ...syncResult }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', error: err.message }));
      }
      return;
    }

    // API: Inbox Sync - GET stats
    if (pathname === '/api/sync-inbox' && method === 'GET') {
      try {
        const totalLeads = db.prepare('SELECT COUNT(*) AS c FROM leads').get().c;
        const protectedContacts = db.prepare('SELECT COUNT(*) AS c FROM leads WHERE welcome_sent = 1').get().c;
        const totalCustomers = db.prepare('SELECT COUNT(*) AS c FROM customers').get().c;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          status: 'ok',
          totalLeads,
          protectedContacts,
          totalCustomers
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', error: err.message }));
      }
      return;
    }

    // API: Bot Status & Uptime - GET
    if (pathname === '/api/bot-status' && method === 'GET') {
      try {
        const status = getBotUptimeStats(db);
        status.serverVersion = getServerVersionInfo();
        status.qrStatus = getQrStatus();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(status));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Server Version & Auto-update info - GET
    if (pathname === '/api/server/version' && method === 'GET') {
      try {
        const version = getServerVersionInfo();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', version }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', error: err.message }));
      }
      return;
    }

    // API: Manual Update Trigger - POST
    if (pathname === '/api/server/update' && method === 'POST') {
      try {
        const result = await performUpdate({
          reason: 'MANUAL_API_TRIGGER',
          onRestart
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', result }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', error: err.message }));
      }
      return;
    }

    // API: GitHub Webhook - POST
    if (pathname === '/api/webhook/github' && method === 'POST') {
      try {
        const rawBody = await readRawBody(req);
        const signature = req.headers['x-hub-signature-256'];
        if (!verifyGitHubWebhookSignature(rawBody, signature)) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ status: 'error', error: 'Invalid signature' }));
          return;
        }

        const event = req.headers['x-github-event'] || 'push';
        let payload = {};
        try {
          payload = rawBody ? JSON.parse(rawBody) : {};
        } catch {}

        if (event === 'ping') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ status: 'ok', message: 'pong' }));
          return;
        }

        if (event === 'push') {
          console.log(`[AUTO-UPDATE] Received GitHub push webhook for ref: ${payload.ref || 'unknown'}`);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ status: 'ok', updating: true }));

          // Run update asynchronously
          performUpdate({
            reason: 'GITHUB_WEBHOOK_PUSH',
            onRestart
          }).catch(err => {
            console.error('[AUTO-UPDATE] Webhook triggered update failed:', err.message);
          });
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', message: `Unhandled event: ${event}` }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', error: err.message }));
      }
      return;
    }

    // API: Summary Stats
    if (pathname === '/api/stats' && method === 'GET') {
      try {
        const stats = getDashboardStats(db);
        stats.kpi = getBusinessKpiReport(db);
        stats.cohort = getCohortPaybackAnalysis(db);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(stats));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Cohort Payback & Ad Spend Velocity
    if (pathname === '/api/cohort/payback' && method === 'GET') {
      try {
        const parsedUrl = url.parse(req.url, true);
        const spend = parsedUrl.query.spend ? parseFloat(parsedUrl.query.spend) : null;
        const cac = parsedUrl.query.cac ? parseFloat(parsedUrl.query.cac) : null;
        const result = getCohortPaybackAnalysis(db, { dailyAdSpend: spend, customCac: cac });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Trigger Meta Ads Sync
    if (pathname === '/api/sync-fb-ads' && method === 'POST') {
      try {
        const body = await readJsonBody(req).catch(() => ({}));
        const { syncAdSpendToDb } = require('./fb-ads');
        const result = await syncAdSpendToDb(db, {
          token: body.token || null,
          datePreset: body.datePreset || 'this_month',
          startDate: body.startDate || null,
          endDate: body.endDate || null
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', result }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', error: err.message }));
      }
      return;
    }

    // API: Trigger Ground-Truth Job Audit
    if (pathname === '/api/audit-jobs' && method === 'POST') {
      try {
        const { auditChatsDeterministic, initAuditDb } = require('./auditor');
        initAuditDb(db);
        const dumpPath = path.join(__dirname, '..', 'scratch', 'all_target_chat_messages.json');
        let unbilledTotal = 0;
        let jobsTotal = 0;
        if (fs.existsSync(dumpPath)) {
          const rawChats = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
          const audit = auditChatsDeterministic(rawChats);
          const upsertStmt = db.prepare(`
            INSERT INTO job_audit_logs (phone_number, jobs_delivered, total_billed, unbilled_leakage, details_json, created_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `);
          const runSave = db.transaction(() => {
            for (const r of audit.results) {
              upsertStmt.run(r.phone, r.jobs_delivered, r.total_billed, r.unbilled_leakage_amount, JSON.stringify(r.jobs || []));
              unbilledTotal += r.unbilled_leakage_amount;
              jobsTotal += r.jobs_delivered;
            }
          });
          runSave();
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', jobsTotal, unbilledTotal }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', error: err.message }));
      }
      return;
    }

    // API: Customer List with balance and last activity
    if (pathname === '/api/customers' && method === 'GET') {
      try {
        const customers = getAllCustomersSummary(db);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(customers));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Video Customers - GET list
    if (pathname === '/api/video-customers' && method === 'GET') {
      try {
        const list = getVideoCustomers(db);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(list));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Video Customers - POST add
    if (pathname === '/api/video-customers' && method === 'POST') {
      try {
        const body = await readJsonBody(req);
        if (!body.phone) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'phone is required' }));
          return;
        }
        const record = addVideoCustomer(db, body.phone, body.note);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', record }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Video Customers - DELETE remove
    if ((pathname.startsWith('/api/video-customers/') || pathname === '/api/video-customers') && method === 'DELETE') {
      try {
        let phone = '';
        if (pathname.startsWith('/api/video-customers/')) {
          phone = decodeURIComponent(pathname.replace('/api/video-customers/', '')).trim();
        }
        if (!phone && parsedUrl.query?.phone) {
          phone = String(parsedUrl.query.phone).trim();
        }
        if (!phone) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'phone is required' }));
          return;
        }
        const result = removeVideoCustomer(db, phone);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', ...result }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Customer Statement with running balance
    if (pathname.startsWith('/api/customer/') && method === 'GET') {
      const phone = decodeURIComponent(pathname.replace('/api/customer/', '')).trim();
      try {
        const summary = getCustomerSummary(db, phone);
        const transactions = getCustomerTransactions(db, phone);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ summary, transactions }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Ad Spend - GET list & summary
    if (pathname === '/api/ad-spend' && method === 'GET') {
      try {
        const summary = getAdSpendSummary(db);
        const list = getAdSpendList(db, { limit: 90 });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ summary, list }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Ad Spend - POST record ad spend (single date or continuous range)
    if (pathname === '/api/ad-spend' && method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const result = recordAdSpend(db, body);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', result }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', error: err.message }));
      }
      return;
    }

    // API: Simulation baselines derived from historical transactions & ad spend
    if (pathname === '/api/simulation/baselines' && method === 'GET') {
      try {
        const baselines = getSimulationBaselines(db);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(baselines));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Executive KPI & ROI - GET unified health metrics
    if (pathname === '/api/kpi' && method === 'GET') {
      try {
        const parsedUrl = url.parse(req.url, true);
        const date = parsedUrl.query?.date;
        const startDate = parsedUrl.query?.startDate || date;
        const endDate = parsedUrl.query?.endDate || date;
        const report = getBusinessKpiReport(db, { startDate, endDate });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(report));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Bot Settings - GET current settings
    if (pathname === '/api/bot-settings' && method === 'GET') {
      try {
        const settings = getAllBotSettings(db);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', success: true, settings }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', error: err.message }));
      }
      return;
    }

    // API: Bot Settings - POST update settings
    if (pathname === '/api/bot-settings' && method === 'POST') {
      try {
        const body = await readJsonBody(req);
        if (!body || (typeof body.key === 'undefined' && (!body.settings || typeof body.settings !== 'object'))) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ status: 'error', error: 'key or settings is required' }));
          return;
        }

        if (typeof body.key === 'string' && body.key.trim()) {
          setBotSetting(db, body.key.trim(), body.value);
        } else if (body.settings && typeof body.settings === 'object') {
          for (const [k, v] of Object.entries(body.settings)) {
            if (typeof k === 'string' && k.trim()) {
              setBotSetting(db, k.trim(), v);
            }
          }
        }

        const updatedSettings = getAllBotSettings(db);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', success: true, settings: updatedSettings }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'error', error: err.message }));
      }
      return;
    }

    // Direct printable statement URL (e.g. /statement/8801712345678)
    if (pathname.startsWith('/statement/') && method === 'GET') {
      const phone = decodeURIComponent(pathname.replace('/statement/', '')).trim();
      try {
        const summary = getCustomerSummary(db, phone);
        const transactions = getCustomerTransactions(db, phone);
        const html = renderPrintableStatement({ summary, transactions });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Error generating statement: ' + err.message);
      }
      return;
    }

    // Main Single Page Mobile Dashboard (with pre-rendered initial data)
    if ((pathname === '/' || pathname === '/dashboard' || pathname === '/kpi') && method === 'GET') {
      try {
        const accept = req.headers['accept'] || '';
        if (accept.includes('application/json') && pathname === '/kpi') {
          const report = getBusinessKpiReport(db);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(report));
          return;
        }
        const html = renderHtmlPage({ db });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Error reading dashboard: ' + err.message);
      }
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  // Seed default callers if none exist
  try {
    const callersCount = db.prepare('SELECT COUNT(*) as count FROM crm_callers').get()?.count || 0;
    if (callersCount === 0) {
      const fullWeekShift = JSON.stringify({
        mon: [{ start: '00:00', end: '23:59' }],
        tue: [{ start: '00:00', end: '23:59' }],
        wed: [{ start: '00:00', end: '23:59' }],
        thu: [{ start: '00:00', end: '23:59' }],
        fri: [{ start: '00:00', end: '23:59' }],
        sat: [{ start: '00:00', end: '23:59' }],
        sun: [{ start: '00:00', end: '23:59' }]
      });
      createCaller(db, { id: 'caller_1', name: 'Caller 1 (Tanvir)', pin: '1234', shift_schedule_json: fullWeekShift });
      updateCallerStatus(db, 'caller_1', 'active');
      createCaller(db, { id: 'caller_2', name: 'Caller 2 (Agent)', pin: '5678', shift_schedule_json: fullWeekShift });
      updateCallerStatus(db, 'caller_2', 'active');
    }
  } catch {}

  // Periodic background escalation check for CRM every 5s
  const escalationInterval = setInterval(() => {
    try {
      checkAndEscalateTimeouts(db);
    } catch {}
  }, 5000);
  if (escalationInterval.unref) escalationInterval.unref();

  // Ensure metrics tables are populated with seed/transcripts if empty in standalone/production mode
  if (autoSeed && db) {
    try {
      const existingJobs = db.prepare('SELECT COUNT(*) as cnt FROM metrics_chat_jobs').get();
      if (!existingJobs || existingJobs.cnt < 100) {
        console.log('[SERVER_INIT] Populating metrics database from seed/transcripts...');
        syncChatMetricsToDb(db);
      }
    } catch (err) {
      console.warn('[SERVER_INIT] Metrics auto-sync warning:', err.message);
    }
  }

  server.on('close', () => {
    clearInterval(escalationInterval);
  });

  server.listen(port, () => {
    const netIps = getNetworkIps();
    console.log(`📄 Official Ledger Web Dashboard running:`);
    console.log(`   > Local:   http://localhost:${port}`);
    netIps.forEach(net => {
      console.log(`   > ${net.name}: http://${net.address}:${port} (Mobile access)`);
    });
  });

  return server;
}

// Standalone execution support: node src/server.js
if (require.main === module) {
  const { initDb } = require('./db');
  const { DB_PATH } = require('./config');
  const db = initDb(DB_PATH);
  startWebServer({ db, port: PORT, autoSeed: true });
}

module.exports = {
  startWebServer,
  renderHtmlPage,
  renderPrintableStatement
};
