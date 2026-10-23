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
const { PORT } = require('./config');
const { syncExistingInboxContacts } = require('./sync');
const { resolveCustomerPhone } = require('./bot');

const DASHBOARD_HTML_PATH = path.join(__dirname, 'dashboard.html');

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
      html = html.replace('/*__INITIAL_DATA__*/', `window.__INITIAL_DATA__ = ${initialJson};`);
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

function startWebServer({ db, client = null, port = PORT }) {
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
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(status));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: Summary Stats
    if (pathname === '/api/stats' && method === 'GET') {
      try {
        const stats = getDashboardStats(db);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(stats));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
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
    if (pathname === '/' && method === 'GET') {
      try {
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
  startWebServer({ db, port: PORT });
}

module.exports = {
  startWebServer,
  renderHtmlPage,
  renderPrintableStatement
};
