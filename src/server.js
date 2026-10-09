const http = require('http');
const fs = require('fs');
const path = require('path');
const { getDueList } = require('./db');
const { toBengaliDigits } = require('./audio');

const botState = {
  status: 'STARTING', // STARTING | QR_READY | AUTHENTICATED | READY | AUTH_FAILURE | DISCONNECTED
  user: null,
  qrCode: null,
  qrDataUrl: null,
  disconnectedReason: null,
  startTime: Date.now()
};

function formatUptime(seconds) {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function renderHtmlPage({ db }) {
  let dues = [];
  let totalDue = 0;
  if (db) {
    try {
      dues = getDueList(db);
      totalDue = dues.reduce((acc, c) => acc + (c.due_amount || 0), 0);
      totalDue = Math.round(totalDue * 100) / 100;
    } catch {}
  }

  const uptimeStr = formatUptime(Math.round(process.uptime()));
  const isReady = botState.status === 'READY';
  const isQr = botState.status === 'QR_READY' && botState.qrDataUrl;

  const statusBadge = isReady
    ? '<span class="badge badge-success">● ONLINE / READY</span>'
    : isQr
    ? '<span class="badge badge-warning">● SCAN QR CODE</span>'
    : botState.status === 'AUTHENTICATED'
    ? '<span class="badge badge-info">● AUTHENTICATED (LOADING...)</span>'
    : '<span class="badge badge-secondary">● ' + botState.status + '</span>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Business Ledger Bot</title>
  ${isQr ? '<meta http-equiv="refresh" content="6">' : ''}
  <style>
    :root {
      --bg: #0f172a;
      --card: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #25d366;
      --primary-dark: #128c7e;
      --danger: #ef4444;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background-color: var(--bg); color: var(--text); padding: 24px 16px; min-height: 100vh; display: flex; flex-direction: column; align-items: center; }
    .container { max-width: 680px; width: 100%; display: flex; flex-direction: column; gap: 20px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.2); }
    .header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
    .title { font-size: 1.25rem; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .badge { padding: 4px 10px; border-radius: 9999px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
    .badge-success { background: rgba(37, 211, 102, 0.15); color: #25d366; border: 1px solid rgba(37, 211, 102, 0.3); }
    .badge-warning { background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); }
    .badge-info { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); }
    .badge-secondary { background: rgba(148, 163, 184, 0.15); color: #94a3b8; border: 1px solid rgba(148, 163, 184, 0.3); }
    .qr-box { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 24px; background: #0f172a; border-radius: 8px; text-align: center; }
    .qr-img { background: #fff; padding: 12px; border-radius: 8px; width: 260px; height: 260px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 16px; }
    .stat-card { background: #0f172a; border: 1px solid var(--border); padding: 16px; border-radius: 8px; text-align: center; }
    .stat-val { font-size: 1.5rem; font-weight: 700; color: #38bdf8; margin-top: 4px; }
    .stat-lbl { font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase; }
    .info-list { margin-top: 12px; font-size: 0.9rem; line-height: 1.6; color: var(--text-muted); }
    .info-list code { background: #0f172a; padding: 2px 6px; border-radius: 4px; color: #38bdf8; }
    .btn { display: inline-block; padding: 8px 16px; background: var(--primary-dark); color: #fff; text-decoration: none; border-radius: 6px; font-size: 0.85rem; font-weight: 600; text-align: center; margin-top: 12px; }
    .btn:hover { background: var(--primary); }
    footer { margin-top: 24px; font-size: 0.8rem; color: var(--text-muted); text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="header">
        <div class="title">
          <span>📱 WhatsApp Business Ledger Bot</span>
        </div>
        ${statusBadge}
      </div>

      ${isQr ? `
      <div class="qr-box" style="margin-top: 20px;">
        <h3 style="color: #f59e0b;">Scan QR Code to Login</h3>
        <p style="color: var(--text-muted); font-size: 0.9rem;">
          Open WhatsApp on your phone &gt; Settings &gt; Linked Devices &gt; Link a Device.
        </p>
        <img class="qr-img" src="${botState.qrDataUrl}" alt="WhatsApp QR Code" />
        <p style="color: var(--text-muted); font-size: 0.75rem;">Page auto-refreshes every 6 seconds until authenticated.</p>
      </div>
      ` : ''}

      ${isReady ? `
      <div style="margin-top: 20px; padding: 16px; background: rgba(37, 211, 102, 0.08); border: 1px solid rgba(37, 211, 102, 0.2); border-radius: 8px;">
        <h3 style="color: #25d366; display: flex; align-items: center; gap: 8px;">
          <span>✅ Bot is Active & Running</span>
        </h3>
        <p style="margin-top: 6px; font-size: 0.95rem;">
          Logged in as: <strong>+${botState.user || 'Unknown'}</strong>
        </p>
        <p style="font-size: 0.85rem; color: var(--text-muted); margin-top: 4px;">
          Ready to automatically process audio documents, bills, payments, and self-chat <code>!due</code> reports.
        </p>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-lbl">Customers with Due</div>
          <div class="stat-val">${dues.length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-lbl">Total Due Balance</div>
          <div class="stat-val">${totalDue} BDT</div>
        </div>
        <div class="stat-card">
          <div class="stat-lbl">Uptime</div>
          <div class="stat-val" style="font-size: 1.1rem; padding-top: 6px;">${uptimeStr}</div>
        </div>
      </div>
      ` : ''}

      ${!isQr && !isReady ? `
      <div style="margin-top: 20px; text-align: center; padding: 32px 16px; color: var(--text-muted);">
        <p style="font-size: 1.1rem;">⏳ Initializing WhatsApp Web Client...</p>
        <p style="font-size: 0.85rem; margin-top: 8px;">Please wait while Chromium launches in the cloud.</p>
      </div>
      ` : ''}
    </div>

    <div class="card">
      <h4 style="font-size: 1rem; color: var(--text); margin-bottom: 8px;">⚙️ Render Free Tier Hosting Tips</h4>
      <div class="info-list">
        <p>• <strong>Keep-Alive URL:</strong> <code>/healthz</code> responds with <code>200 OK</code> to satisfy Render health checks.</p>
        <p>• <strong>Prevent Sleep:</strong> Set up a free 10-minute HTTP monitor on <a href="https://cron-job.org" target="_blank" style="color: #38bdf8;">cron-job.org</a> or <a href="https://uptimerobot.com" target="_blank" style="color: #38bdf8;">UptimeRobot</a> pointing to <code>https://&lt;your-render-url&gt;/healthz</code>.</p>
        <p>• <strong>Database Backup:</strong> Download your SQLite database anytime at <a href="/api/backup" style="color: #38bdf8;"><code>/api/backup</code></a>.</p>
      </div>
      <a href="/api/backup" class="btn">📥 Download Database Backup</a>
    </div>

    <footer>
      WhatsApp Business Ledger Bot &bull; Node.js v22 &bull; Render Free Tier Compatible
    </footer>
  </div>
</body>
</html>`;
}

function startWebServer({ db, port = 3000, dbPath, adminSecret }) {
  const actualDbPath = dbPath || (require('./config').DB_PATH);
  const actualSecret = adminSecret || (require('./config').ADMIN_SECRET);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // 1. Health check endpoint for Render.com
    if (pathname === '/healthz' || pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        status: 'ok',
        botStatus: botState.status,
        uptime: Math.round(process.uptime()),
        user: botState.user || null,
        timestamp: new Date().toISOString()
      }));
    }

    // 2. Direct QR code JSON/HTML
    if (pathname === '/qr') {
      if (botState.qrDataUrl) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!DOCTYPE html><html><head><title>Scan QR</title><meta http-equiv="refresh" content="5"></head><body style="background:#0f172a;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;"><h2>Scan with WhatsApp (Linked Devices)</h2><img src="${botState.qrDataUrl}" style="background:#fff;padding:16px;border-radius:12px;margin:20px;width:280px;height:280px;"/><p style="color:#94a3b8;">Refreshing every 5 seconds...</p></body></html>`);
      } else if (botState.status === 'READY') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!DOCTYPE html><html><body style="background:#0f172a;color:#25d366;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;"><h2>✅ Bot is already authenticated!</h2><p style="color:#94a3b8;">Logged in as: +${botState.user}</p><a href="/" style="color:#38bdf8;margin-top:16px;">Go to Dashboard</a></body></html>`);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="3"></head><body style="background:#0f172a;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;"><h2>⏳ Generating QR Code...</h2><p style="color:#94a3b8;">Please wait...</p></body></html>`);
      }
    }

    // 3. Database backup download endpoint
    if (pathname === '/api/backup') {
      if (actualSecret) {
        const token = url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer\s+/, '');
        if (token !== actualSecret) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing token' }));
        }
      }

      if (fs.existsSync(actualDbPath)) {
        res.writeHead(200, {
          'Content-Type': 'application/x-sqlite3',
          'Content-Disposition': 'attachment; filename="ledger_backup.db"'
        });
        const readStream = fs.createReadStream(actualDbPath);
        return readStream.pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Database file not found' }));
      }
    }

    // 4. Main web dashboard
    if (pathname === '/' || pathname === '/index.html') {
      const html = renderHtmlPage({ db });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // 404 for other routes
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(port, () => {
    console.log(`🌐 Web interface & Render health check listening on port ${port}`);
    console.log(`🔗 Health check URL: http://localhost:${port}/healthz`);
    console.log(`🔗 Web Dashboard: http://localhost:${port}/`);
  });

  // Enable self keep-alive ping if RENDER_EXTERNAL_URL is configured
  const renderExternalUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
  if (renderExternalUrl) {
    const keepAliveUrl = `${renderExternalUrl.replace(/\/$/, '')}/healthz`;
    console.log(`[KEEP_ALIVE] Auto self-ping configured for: ${keepAliveUrl} (every 13m)`);
    setInterval(() => {
      try {
        fetch(keepAliveUrl).catch(() => {});
      } catch {}
    }, 13 * 60 * 1000);
  }

  return server;
}

module.exports = {
  botState,
  startWebServer,
  renderHtmlPage
};
