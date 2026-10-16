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
  getDashboardStats
} = require('./db');
const { PORT } = require('./config');

const DASHBOARD_HTML_PATH = path.join(__dirname, 'dashboard.html');

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
      const initialJson = JSON.stringify({ stats, customers });
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

function startWebServer({ db, port = PORT }) {
  const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
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
