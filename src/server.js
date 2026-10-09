const http = require('http');
const fs = require('fs');
const path = require('path');
const { getDueList } = require('./db');

const botState = {
  status: 'STARTING', // STARTING | QR_READY | AUTHENTICATED | READY | AUTH_FAILURE | DISCONNECTED
  user: null,
  qrCode: null,
  qrDataUrl: null,
  lastQrTimestamp: null,
  disconnectedReason: null,
  startTime: Date.now()
};

let sseClients = [];

function broadcastStatus() {
  const payload = JSON.stringify({
    status: botState.status,
    qr: botState.qrDataUrl,
    qrTimestamp: botState.lastQrTimestamp,
    user: botState.user,
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });

  sseClients.forEach((client) => {
    try {
      client.res.write(`data: ${payload}\n\n`);
    } catch {}
  });
}

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

function renderHtmlDashboard({ db }) {
  let dues = [];
  let totalDue = 0;
  if (db) {
    try {
      dues = getDueList(db);
      totalDue = dues.reduce((acc, c) => acc + (c.due_amount || 0), 0);
      totalDue = Math.round(totalDue * 100) / 100;
    } catch {}
  }

  return `<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Business Ledger Bot &bull; Live Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
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
      --accent: #38bdf8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif; }
    body { background-color: var(--bg); color: var(--text); padding: 24px 16px; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .container { max-width: 580px; width: 100%; display: flex; flex-direction: column; gap: 20px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 24px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.3); }
    .header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
    .title { font-size: 1.25rem; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .badge { padding: 4px 12px; border-radius: 9999px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; transition: all 0.3s ease; }
    .badge-success { background: rgba(37, 211, 102, 0.15); color: #25d366; border: 1px solid rgba(37, 211, 102, 0.3); }
    .badge-warning { background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); }
    .badge-info { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); }
    .badge-secondary { background: rgba(148, 163, 184, 0.15); color: #94a3b8; border: 1px solid rgba(148, 163, 184, 0.3); }
    .qr-container { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 20px; background: #0b1120; border-radius: 12px; margin-top: 16px; border: 1px solid var(--border); }
    .qr-img { background: #fff; padding: 12px; border-radius: 10px; width: 260px; height: 260px; box-shadow: 0 4px 16px rgba(0,0,0,0.4); transition: transform 0.2s ease; }
    .qr-timer { font-size: 0.85rem; font-weight: 600; transition: color 0.3s ease; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 16px; }
    .stat-card { background: #0b1120; border: 1px solid var(--border); padding: 16px; border-radius: 10px; text-align: center; }
    .stat-val { font-size: 1.4rem; font-weight: 700; color: var(--accent); margin-top: 4px; }
    .stat-lbl { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 10px 18px; background: var(--primary-dark); color: #fff; text-decoration: none; border-radius: 8px; font-size: 0.9rem; font-weight: 600; cursor: pointer; border: none; transition: background 0.2s ease; }
    .btn:hover { background: var(--primary); }
    .btn-secondary { background: #334155; color: #f8fafc; }
    .btn-secondary:hover { background: #475569; }
    .btn-danger { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); }
    .btn-danger:hover { background: rgba(239, 68, 68, 0.35); }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; justify-content: center; }
    .hidden { display: none !important; }
    footer { margin-top: 20px; font-size: 0.8rem; color: var(--text-muted); text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="header">
        <div class="title">
          <span>📱 WhatsApp Business Ledger Bot</span>
        </div>
        <span id="statusBadge" class="badge badge-secondary">● INITIALIZING</span>
      </div>

      <!-- State 1: QR Ready -->
      <div id="qrBox" class="qr-container hidden">
        <h3 style="color: #f59e0b; font-size: 1.1rem;">WhatsApp স্ক্যান করুন</h3>
        <p style="color: var(--text-muted); font-size: 0.85rem; text-align: center;">
          ফোনে WhatsApp খুলুন &gt; <strong>Linked Devices</strong> &gt; <strong>Link a Device</strong> দিয়ে নিচের QR কোডটি স্ক্যান করুন:
        </p>
        <img id="qrImg" class="qr-img" src="" alt="WhatsApp QR Code" />
        <div id="qrTimerBox" class="qr-timer" style="color: var(--accent);">⚡ QR কোড লোড হচ্ছে...</div>
        <p style="color: var(--text-muted); font-size: 0.75rem;">রিয়েল-টাইম সিঙ্ক হচ্ছে &bull; পেজ রিলোড করার প্রয়োজন নেই</p>
      </div>

      <!-- State 2: Authenticated / Loading -->
      <div id="authBox" style="margin-top: 20px; text-align: center; padding: 24px 16px;" class="hidden">
        <h3 style="color: var(--accent);">🔐 Authentication Successful!</h3>
        <p style="color: var(--text-muted); font-size: 0.9rem; margin-top: 8px;">
          WhatsApp Web সেশন লোড হচ্ছে... অনুগ্রহ করে কয়েক সেকেন্ড অপেক্ষা করুন।
        </p>
      </div>

      <!-- State 3: Ready / Online -->
      <div id="readyBox" class="hidden">
        <div style="margin-top: 16px; padding: 16px; background: rgba(37, 211, 102, 0.08); border: 1px solid rgba(37, 211, 102, 0.2); border-radius: 10px;">
          <h3 style="color: #25d366; display: flex; align-items: center; gap: 8px; font-size: 1.1rem;">
            <span>✅ Bot is Active &amp; Ready!</span>
          </h3>
          <p style="margin-top: 6px; font-size: 0.95rem;">
            লগইন অ্যাকাউন্ট: <strong id="readyUserNumber" style="color: #fff;">+...</strong>
          </p>
          <p style="font-size: 0.82rem; color: var(--text-muted); margin-top: 4px;">
            স্বয়ংক্রিয় অডিও ডকুমেন্ট বিলিং, হিসাব ট্র্যাকিং এবং <code>!due</code> কমান্ড সক্রিয় রয়েছে।
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
            <div id="uptimeDisplay" class="stat-val" style="font-size: 1.1rem; padding-top: 4px;">0s</div>
          </div>
        </div>
      </div>

      <!-- State 4: Initializing / Waiting -->
      <div id="initBox" style="margin-top: 20px; text-align: center; padding: 32px 16px; color: var(--text-muted);">
        <p style="font-size: 1.1rem;">⏳ WhatsApp Web ক্লায়েন্ট প্রস্তুত হচ্ছে...</p>
        <p style="font-size: 0.85rem; margin-top: 8px;">Chromium ব্রাউজার চালু হচ্ছে। কিছুক্ষণের মধ্যেই QR কোড আসবে।</p>
      </div>

      <div class="actions">
        <a href="/api/backup" class="btn btn-secondary">📥 Download DB Backup</a>
        <button id="btnReset" onclick="resetSession()" class="btn btn-danger">🔄 সেশন রিসেট (Reset QR)</button>
      </div>
    </div>

    <div class="card" style="padding: 18px 24px;">
      <h4 style="font-size: 0.95rem; color: var(--text); margin-bottom: 6px;">💡 Render Free Tier ২৪/৭ অনলাইনে রাখার নিয়ম:</h4>
      <p style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.5;">
        Render-এর ফ্রি সার্ভার ১৫ মিনিট পর স্লিপে চলে যায়। এটি ২৪/৭ চালু রাখতে <a href="https://cron-job.org" target="_blank" style="color: var(--accent);">cron-job.org</a> বা <a href="https://uptimerobot.com" target="_blank" style="color: var(--accent);">UptimeRobot</a>-এ প্রতি <strong>১০ মিনিট</strong> পর পর <code>${(process.env.RENDER_EXTERNAL_URL || 'https://<your-app>.onrender.com').replace(/\/$/, '')}/healthz</code> এ একটি ফ্রি পিং (GET request) সেট করে দিন।
      </p>
    </div>

    <footer>
      WhatsApp Business Ledger Bot &bull; Node.js v22 &bull; Render Cloud Ready
    </footer>
  </div>

  <script>
    let lastQrTime = null;
    let qrTimerInterval = null;

    function updateUi(data) {
      const badge = document.getElementById('statusBadge');
      const qrBox = document.getElementById('qrBox');
      const authBox = document.getElementById('authBox');
      const readyBox = document.getElementById('readyBox');
      const initBox = document.getElementById('initBox');
      const qrImg = document.getElementById('qrImg');
      const readyUser = document.getElementById('readyUserNumber');
      const uptimeDisplay = document.getElementById('uptimeDisplay');

      if (data.uptime && uptimeDisplay) {
        uptimeDisplay.innerText = data.uptime + 's';
      }

      if (data.status === 'QR_READY' && data.qr) {
        badge.className = 'badge badge-warning';
        badge.innerText = '● SCAN QR CODE';
        qrBox.classList.remove('hidden');
        authBox.classList.add('hidden');
        readyBox.classList.add('hidden');
        initBox.classList.add('hidden');

        if (qrImg.src !== data.qr) {
          qrImg.src = data.qr;
          lastQrTime = data.qrTimestamp ? new Date(data.qrTimestamp) : new Date();
        }
      } else if (data.status === 'AUTHENTICATED') {
        badge.className = 'badge badge-info';
        badge.innerText = '● AUTHENTICATED';
        qrBox.classList.add('hidden');
        authBox.classList.remove('hidden');
        readyBox.classList.add('hidden');
        initBox.classList.add('hidden');
      } else if (data.status === 'READY') {
        badge.className = 'badge badge-success';
        badge.innerText = '● ONLINE / READY';
        qrBox.classList.add('hidden');
        authBox.classList.add('hidden');
        readyBox.classList.remove('hidden');
        initBox.classList.add('hidden');
        if (readyUser) readyUser.innerText = '+' + (data.user || 'Connected');
      } else {
        badge.className = 'badge badge-secondary';
        badge.innerText = '● ' + data.status;
        qrBox.classList.add('hidden');
        authBox.classList.add('hidden');
        readyBox.classList.add('hidden');
        initBox.classList.remove('hidden');
      }
    }

    function updateQrFreshness() {
      if (!lastQrTime) return;
      const timerBox = document.getElementById('qrTimerBox');
      const elapsed = Math.floor((new Date() - lastQrTime) / 1000);
      if (elapsed < 18) {
        timerBox.innerText = '⚡ QR কোড সতেজ (আপডেট: ' + elapsed + 's আগে)';
        timerBox.style.color = '#38bdf8';
      } else {
        timerBox.innerText = '⚠️ QR কোড রিফ্রেশ হচ্ছে... নতুন কোড আসার অপেক্ষা করুন';
        timerBox.style.color = '#fde047';
      }
    }

    // Connect SSE for instantaneous real-time streaming
    function connectSse() {
      try {
        const es = new EventSource('/api/events');
        es.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            updateUi(data);
          } catch {}
        };
        es.onerror = () => {
          es.close();
          setTimeout(connectSse, 4000);
        };
      } catch {}
    }

    // Fallback regular poll every 3s
    async function pollStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        updateUi(data);
      } catch {}
    }

    async function resetSession() {
      if (!confirm('আপনি কি সত্যিই নতুন QR কোড তৈরির জন্য সেশন রিসেট করতে চান?')) return;
      const btn = document.getElementById('btnReset');
      btn.disabled = true;
      btn.innerText = '⏳ রিসেট হচ্ছে...';
      try {
        const res = await fetch('/api/reset-session', { method: 'POST' });
        const data = await res.json();
        alert(data.message || 'সেশন রিসেট করা হয়েছে!');
      } catch (err) {
        alert('রিসেট করতে ব্যর্থ হয়েছে: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerText = '🔄 সেশন রিসেট (Reset QR)';
        pollStatus();
      }
    }

    connectSse();
    setInterval(pollStatus, 3000);
    setInterval(updateQrFreshness, 1000);
    pollStatus();
  </script>
</body>
</html>`;
}

function startWebServer({ db, port = 3000, dbPath, adminSecret, onResetSession }) {
  const actualDbPath = dbPath || (require('./config').DB_PATH);
  const actualSecret = adminSecret || (require('./config').ADMIN_SECRET);

  const server = http.createServer(async (req, res) => {
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

    // 2. Real-time SSE event stream for instantaneous QR sync
    if (pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      const clientId = Date.now();
      const newClient = { id: clientId, res };
      sseClients.push(newClient);

      // Send current status immediately on connect
      const payload = JSON.stringify({
        status: botState.status,
        qr: botState.qrDataUrl,
        qrTimestamp: botState.lastQrTimestamp,
        user: botState.user,
        uptime: Math.round(process.uptime()),
        timestamp: new Date().toISOString()
      });
      res.write(`data: ${payload}\n\n`);

      req.on('close', () => {
        sseClients = sseClients.filter((c) => c.id !== clientId);
      });
      return;
    }

    // 3. Status JSON API for polling
    if (pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        status: botState.status,
        qr: botState.qrDataUrl,
        qrTimestamp: botState.lastQrTimestamp,
        user: botState.user,
        uptime: Math.round(process.uptime()),
        timestamp: new Date().toISOString()
      }));
    }

    // 4. Session reset endpoint to clear corrupt sessions and re-generate QR
    if (pathname === '/api/reset-session') {
      if (req.method === 'POST' || req.method === 'GET') {
        if (typeof onResetSession === 'function') {
          try {
            await onResetSession();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, message: 'সেশন সফলভাবে রিসেট করা হয়েছে। নতুন QR কোড তৈরি হচ্ছে...' }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: err.message }));
          }
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Reset handler not registered' }));
        }
      }
    }

    // 5. Database backup download endpoint
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

    // 6. Direct QR page or main dashboard
    if (pathname === '/' || pathname === '/qr' || pathname === '/index.html') {
      const html = renderHtmlDashboard({ db });
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
  broadcastStatus,
  startWebServer,
  renderHtmlDashboard
};
