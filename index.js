const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const musicMetadata = require('music-metadata');
const fs = require('fs');
const path = require('path');
const { calculateBill, formatDuration } = require('./lib/billingCalculator');
const { getCustomerBill, recordTransaction, clearCustomerBill } = require('./lib/ledger');

const app = express();
const PORT = process.env.PORT || 3000;
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '6700';

app.use(express.json());

// Bot state
let botStatus = 'INITIALIZING'; // 'INITIALIZING', 'QR_READY', 'AUTHENTICATED', 'READY', 'AUTH_FAILURE', 'DISCONNECTED'
let currentQrDataUrl = null;
let lastQrTimestamp = null;
let sseClients = [];

function broadcastStatus() {
    const payload = JSON.stringify({
        status: botStatus,
        qr: currentQrDataUrl,
        qrTimestamp: lastQrTimestamp,
        timestamp: new Date().toISOString()
    });
    sseClients.forEach(client => {
        try {
            client.res.write(`data: ${payload}\n\n`);
        } catch (e) {}
    });
}

// Express server endpoints
app.get('/api/status', (req, res) => {
    const pass = req.query.pass;
    if (pass !== ACCESS_PASSWORD) {
        return res.status(401).json({ success: false, error: 'ভুল পাসওয়ার্ড!' });
    }
    res.json({
        success: true,
        status: botStatus,
        qr: currentQrDataUrl,
        qrTimestamp: lastQrTimestamp,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/events', (req, res) => {
    const pass = req.query.pass;
    if (pass !== ACCESS_PASSWORD) {
        return res.status(401).json({ success: false, error: 'ভুল পাসওয়ার্ড!' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }

    const clientId = Date.now();
    const newClient = { id: clientId, res };
    sseClients.push(newClient);

    // Send initial status immediately
    const payload = JSON.stringify({
        status: botStatus,
        qr: currentQrDataUrl,
        qrTimestamp: lastQrTimestamp,
        timestamp: new Date().toISOString()
    });
    res.write(`data: ${payload}\n\n`);

    req.on('close', () => {
        sseClients = sseClients.filter(c => c.id !== clientId);
    });
});

app.post('/api/reset-session', async (req, res) => {
    const pass = req.query.pass || (req.body && req.body.pass);
    if (pass !== ACCESS_PASSWORD) {
        return res.status(401).json({ success: false, error: 'ভুল পাসওয়ার্ড!' });
    }

    try {
        console.log('[WhatsApp] Resetting session by user request...');
        botStatus = 'INITIALIZING';
        currentQrDataUrl = null;
        lastQrTimestamp = null;
        broadcastStatus();

        if (client) {
            try {
                await client.destroy();
            } catch (e) {
                console.error('Error destroying client:', e);
            }
        }

        // Remove auth folder if exists
        const authPath = path.join(__dirname, '.wwebjs_auth');
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
        }

        initializeWhatsAppClient();
        res.json({ success: true, message: 'সেশন রিসেট সফল হয়েছে। নতুন QR কোড তৈরির কাজ চলছে...' });
    } catch (err) {
        console.error('Failed to reset session:', err);
        res.status(500).json({ success: false, error: 'সেশন রিসেট করতে সমস্যা হয়েছে।' });
    }
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="bn">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Bot Dashboard & QR Scanner</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Outfit', sans-serif; }
        body {
            background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%);
            color: #f8fafc;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .card {
            background: rgba(30, 41, 59, 0.75);
            backdrop-filter: blur(16px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 24px;
            padding: 32px;
            width: 100%;
            max-width: 460px;
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
            text-align: center;
        }
        .logo-icon {
            width: 64px;
            height: 64px;
            background: linear-gradient(135deg, #22c55e, #16a34a);
            border-radius: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 16px;
            box-shadow: 0 10px 25px rgba(34, 197, 94, 0.3);
        }
        h1 { font-size: 22px; font-weight: 700; margin-bottom: 8px; color: #ffffff; }
        p.subtitle { color: #94a3b8; font-size: 14px; margin-bottom: 24px; }
        
        .input-group {
            margin-bottom: 20px;
            text-align: left;
        }
        label { display: block; font-size: 13px; color: #cbd5e1; margin-bottom: 8px; font-weight: 600; }
        input[type="password"] {
            width: 100%;
            padding: 14px 18px;
            border-radius: 14px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            background: rgba(15, 23, 42, 0.6);
            color: #fff;
            font-size: 16px;
            outline: none;
            transition: all 0.3s ease;
        }
        input[type="password"]:focus {
            border-color: #22c55e;
            box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.15);
        }
        button.btn-primary {
            width: 100%;
            padding: 14px;
            border-radius: 14px;
            border: none;
            background: linear-gradient(135deg, #22c55e, #15803d);
            color: white;
            font-weight: 600;
            font-size: 16px;
            cursor: pointer;
            transition: all 0.3s ease;
            box-shadow: 0 8px 20px rgba(34, 197, 94, 0.3);
        }
        button.btn-primary:hover { transform: translateY(-2px); box-shadow: 0 12px 25px rgba(34, 197, 94, 0.4); }

        button.btn-reset {
            width: 100%;
            padding: 12px;
            border-radius: 14px;
            border: 1px solid rgba(234, 179, 8, 0.4);
            background: rgba(234, 179, 8, 0.15);
            color: #fde047;
            font-weight: 600;
            font-size: 14px;
            cursor: pointer;
            margin-top: 14px;
            transition: all 0.3s ease;
        }
        button.btn-reset:hover { background: rgba(234, 179, 8, 0.25); }

        button.btn-logout {
            margin-top: 20px;
            width: 100%;
            padding: 12px;
            border-radius: 14px;
            background: rgba(239, 68, 68, 0.15);
            color: #f87171;
            border: 1px solid rgba(239, 68, 68, 0.3);
            font-weight: 600;
            font-size: 14px;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        button.btn-logout:hover { background: rgba(239, 68, 68, 0.25); }
        
        .badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 6px 14px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 16px;
        }
        .badge.qr { background: rgba(234, 179, 8, 0.2); color: #fde047; border: 1px solid rgba(234, 179, 8, 0.3); }
        .badge.ready { background: rgba(34, 197, 94, 0.2); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); }
        .badge.init { background: rgba(148, 163, 184, 0.2); color: #cbd5e1; border: 1px solid rgba(148, 163, 184, 0.3); }
        .badge.error { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }

        .qr-container {
            background: #ffffff;
            padding: 16px;
            border-radius: 16px;
            display: inline-block;
            margin: 12px 0;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
            position: relative;
        }
        .qr-container img { width: 230px; height: 230px; display: block; border-radius: 8px; }

        .qr-timer {
            font-size: 12px;
            color: #38bdf8;
            background: rgba(56, 189, 248, 0.1);
            padding: 4px 10px;
            border-radius: 12px;
            display: inline-block;
            margin-bottom: 8px;
        }

        .error-msg { color: #ef4444; font-size: 14px; margin-top: 10px; display: none; }
        .hidden { display: none !important; }
        .pulse { animation: pulse 2s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    </style>
</head>
<body>

    <div class="card" id="loginCard">
        <div class="logo-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
        </div>
        <h1>WhatsApp Bot Access</h1>
        <p class="subtitle">QR Code এক্সেস করতে পাসওয়ার্ড প্রবেশ করান</p>

        <form id="loginForm" onsubmit="handleLogin(event)">
            <div class="input-group">
                <label for="password">পাসওয়ার্ড (PIN):</label>
                <input type="password" id="password" placeholder="পাসওয়ার্ড প্রবেশ করান..." required autocomplete="off">
            </div>
            <button type="submit" class="btn-primary">Dashboard প্রবেশ করুন ➔</button>
            <p class="error-msg" id="errorText">ভুল পাসওয়ার্ড! আবার চেষ্টা করুন।</p>
        </form>
    </div>

    <div class="card hidden" id="dashboardCard">
        <div class="logo-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
        </div>
        <h1>WhatsApp Billing Bot</h1>
        <p class="subtitle" id="statusDescription">অবস্থা পর্যবেক্ষণ করা হচ্ছে...</p>

        <div id="statusBadge" class="badge init">
            <span class="pulse">●</span> <span id="statusText">ইনটিয়ালাইজ হচ্ছে...</span>
        </div>

        <div id="qrBox" class="hidden">
            <div id="qrTimerBox" class="qr-timer">🔄 QR কোড লাইভ আপডেট হচ্ছে...</div>
            <br>
            <div class="qr-container">
                <img id="qrImage" src="" alt="WhatsApp QR Code">
            </div>
            <p style="font-size: 13px; color: #94a3b8; margin-top: 8px;">
                আপনার ফোনের WhatsApp ➔ Linked Devices ➔ <b>Link a Device</b> দিয়ে স্ক্যান করুন।
            </p>
        </div>

        <div id="readyBox" class="hidden" style="margin-top: 20px; padding: 20px; background: rgba(34, 197, 94, 0.1); border-radius: 16px; border: 1px solid rgba(34, 197, 94, 0.2);">
            <h3 style="color: #4ade80; margin-bottom: 6px;">✅ বোট কানেক্টেড এবং ২৪/৭ সক্রিয়!</h3>
            <p style="font-size: 13px; color: #cbd5e1;">অডিও ফাইল পাঠালে এটি স্বয়ংক্রিয়ভাবে বিল হিসাব পাঠাবে।</p>
        </div>

        <div id="errorBox" class="hidden" style="margin-top: 20px; padding: 16px; background: rgba(239, 68, 68, 0.1); border-radius: 16px; border: 1px solid rgba(239, 68, 68, 0.2);">
            <p id="errorBoxText" style="font-size: 13px; color: #f87171;">লগইন করতে সমস্যা হয়েছে। নিচের বোতামে ক্লিক করে নতুন QR কোড তৈরি করুন।</p>
        </div>

        <button onclick="resetSession()" class="btn-reset">🔄 সেশন রিসেট করুন (নতুন QR তৈরি)</button>
        <button onclick="logout()" class="btn-logout">লগআউট করুন</button>
    </div>

    <script>
        let savedPass = localStorage.getItem('bot_access_pass') || '';
        let eventSource = null;
        let pollTimer = null;
        let lastQrTime = null;
        let qrFreshTimer = null;

        if (savedPass) {
            startSession(savedPass);
        }

        function handleLogin(e) {
            e.preventDefault();
            const pass = document.getElementById('password').value;
            startSession(pass);
        }

        async function startSession(pass) {
            try {
                const res = await fetch('/api/status?pass=' + encodeURIComponent(pass));
                const data = await res.json();

                if (data.success) {
                    localStorage.setItem('bot_access_pass', pass);
                    savedPass = pass;
                    document.getElementById('loginCard').classList.add('hidden');
                    document.getElementById('dashboardCard').classList.remove('hidden');
                    updateDashboardUI(data);
                    setupRealtimeEvents(pass);
                } else {
                    document.getElementById('errorText').style.display = 'block';
                    localStorage.removeItem('bot_access_pass');
                }
            } catch (err) {
                console.error(err);
            }
        }

        function setupRealtimeEvents(pass) {
            if (eventSource) eventSource.close();
            if (pollTimer) clearInterval(pollTimer);

            // Realtime Server-Sent Events (SSE)
            try {
                eventSource = new EventSource('/api/events?pass=' + encodeURIComponent(pass));
                eventSource.onmessage = function(e) {
                    try {
                        const data = JSON.parse(e.data);
                        updateDashboardUI(data);
                    } catch (err) {
                        console.error('SSE JSON error:', err);
                    }
                };
                eventSource.onerror = function() {
                    // Fallback to 1-second polling if SSE drops
                    eventSource.close();
                    startFallbackPolling(pass);
                };
            } catch (e) {
                startFallbackPolling(pass);
            }
        }

        function startFallbackPolling(pass) {
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = setInterval(async () => {
                try {
                    const res = await fetch('/api/status?pass=' + encodeURIComponent(pass));
                    const data = await res.json();
                    if (data.success) {
                        updateDashboardUI(data);
                    }
                } catch(e) {}
            }, 1000);
        }

        function updateDashboardUI(data) {
            const badge = document.getElementById('statusBadge');
            const statusText = document.getElementById('statusText');
            const qrBox = document.getElementById('qrBox');
            const readyBox = document.getElementById('readyBox');
            const errorBox = document.getElementById('errorBox');
            const statusDescription = document.getElementById('statusDescription');
            const qrImage = document.getElementById('qrImage');

            if (data.status === 'READY') {
                badge.className = 'badge ready';
                statusText.innerText = 'Bot Connected & Active';
                statusDescription.innerText = 'হোয়াটসঅ্যাপ সার্ভারের সাথে সফলভাবে কানেক্টেড।';
                qrBox.classList.add('hidden');
                readyBox.classList.remove('hidden');
                errorBox.classList.add('hidden');
            } else if (data.status === 'QR_READY' && data.qr) {
                badge.className = 'badge qr';
                statusText.innerText = 'QR Code প্রস্তুত — স্ক্যান করুন';
                statusDescription.innerText = 'নিচের QR কোডটি স্ক্যান করে লগইন শেষ করুন।';
                
                // Only update img src if changed to prevent camera scanning flicker
                if (qrImage.src !== data.qr) {
                    qrImage.src = data.qr;
                }
                
                lastQrTime = data.qrTimestamp ? new Date(data.qrTimestamp) : new Date();
                updateQrFreshnessText();
                
                qrBox.classList.remove('hidden');
                readyBox.classList.add('hidden');
                errorBox.classList.add('hidden');
            } else if (data.status === 'AUTH_FAILURE' || data.status === 'DISCONNECTED') {
                badge.className = 'badge error';
                statusText.innerText = data.status === 'AUTH_FAILURE' ? 'লগইন ব্যর্থ হয়েছে' : 'কানেকশন বিচ্ছিন্ন';
                statusDescription.innerText = 'নতুন করে QR কোড পাওয়ার জন্য সেশন রিসেট করুন।';
                qrBox.classList.add('hidden');
                readyBox.classList.add('hidden');
                errorBox.classList.remove('hidden');
            } else {
                badge.className = 'badge init';
                statusText.innerText = 'বোট স্টার্ট হচ্ছে...';
                statusDescription.innerText = 'অনুগ্রহ করে কয়েক সেকেন্ড অপেক্ষা করুন...';
                qrBox.classList.add('hidden');
                readyBox.classList.add('hidden');
                errorBox.classList.add('hidden');
            }
        }

        function updateQrFreshnessText() {
            if (!lastQrTime) return;
            const timerBox = document.getElementById('qrTimerBox');
            const elapsedSec = Math.floor((new Date() - lastQrTime) / 1000);
            if (elapsedSec < 18) {
                timerBox.innerText = `⚡ QR কোড তাজা (আপডেট: ${elapsedSec}s আগে)`;
                timerBox.style.color = '#38bdf8';
            } else {
                timerBox.innerText = `⚠️ QR কোড রিফ্রেশ হচ্ছে... (স্ক্যান না হলে অপেক্ষা করুন)`;
                timerBox.style.color = '#fde047';
            }
        }

        if (!qrFreshTimer) {
            qrFreshTimer = setInterval(updateQrFreshnessText, 1000);
        }

        async function resetSession() {
            if (!savedPass) return;
            if (!confirm('আপনি কি সত্যিই নতুন QR কোড তৈরির জন্য সেশন রিসেট করতে চান?')) return;
            
            try {
                const res = await fetch('/api/reset-session?pass=' + encodeURIComponent(savedPass), { method: 'POST' });
                const data = await res.json();
                alert(data.message || 'সেশন রিসেট করা হয়েছে!');
            } catch (err) {
                alert('সেশন রিসেট করতে ব্যর্থ হয়েছে: ' + err.message);
            }
        }

        function logout() {
            localStorage.removeItem('bot_access_pass');
            if (eventSource) eventSource.close();
            if (pollTimer) clearInterval(pollTimer);
            if (qrFreshTimer) clearInterval(qrFreshTimer);
            location.reload();
        }
    </script>
</body>
</html>
    `);
});

app.listen(PORT, () => {
    console.log(`[HTTP Server] Listening on port ${PORT}`);
});

let client = null;

function initializeWhatsAppClient() {
    client = new Client({
        authStrategy: new LocalAuth(),
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1014111620-alpha.html',
        },
        puppeteer: {
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        }
    });

    client.on('qr', async (qr) => {
        console.log('\n========================================');
        console.log('[WhatsApp] QR CODE GENERATED!');
        console.log('========================================\n');
        botStatus = 'QR_READY';
        lastQrTimestamp = Date.now();
        try {
            currentQrDataUrl = await QRCode.toDataURL(qr);
            qrcodeTerminal.generate(qr, { small: true });
        } catch (err) {
            console.error('Error generating QR data URL:', err);
        }
        broadcastStatus();
    });

    client.on('authenticated', () => {
        console.log('[WhatsApp] Authenticated successfully!');
        botStatus = 'AUTHENTICATED';
        broadcastStatus();
    });

    client.on('ready', () => {
        console.log('\n[WhatsApp] Bot client is successfully authenticated and ready!\n');
        botStatus = 'READY';
        currentQrDataUrl = null;
        lastQrTimestamp = null;
        broadcastStatus();
    });

    client.on('auth_failure', (msg) => {
        console.error('[WhatsApp] Authentication failure:', msg);
        botStatus = 'AUTH_FAILURE';
        currentQrDataUrl = null;
        lastQrTimestamp = null;
        broadcastStatus();
    });

    client.on('disconnected', (reason) => {
        console.warn('[WhatsApp] Client disconnected:', reason);
        botStatus = 'DISCONNECTED';
        currentQrDataUrl = null;
        lastQrTimestamp = null;
        broadcastStatus();
    });

    client.on('message', async (msg) => {
        try {
            const customerId = msg.from;
            const text = (msg.body || '').trim();

            // Command: হিসাব
            if (text === 'হিসাব') {
                const customerData = getCustomerBill(customerId);
                const replyMsg = `📋 *আপনার হিসাব বিবরণী:*\n\n` +
                                 `মোট অপিরিশোধিত বিল: *৳ ${customerData.totalBill} টাকা*\n` +
                                 `মোট অডিও ফাইল প্রসেসড: ${customerData.transactions.length} টি`;
                await msg.reply(replyMsg);
                return;
            }

            // Command: বিল ক্লিয়ার
            if (text === 'বিল ক্লিয়ার') {
                clearCustomerBill(customerId);
                await msg.reply(`✅ আপনার পূর্বের সকল হিসাব পরিশোধ করা হয়েছে।\nবর্তমান বকেয়া: *৳ 0 টাকা*`);
                return;
            }

            // Audio Document Handler
            if (msg.hasMedia && msg.type === 'document') {
                const media = await msg.downloadMedia();
                if (!media || !media.mimetype) return;

                const isAudioMime = media.mimetype.startsWith('audio/') || 
                                    media.mimetype.includes('octet-stream') || 
                                    media.mimetype.includes('ogg') || 
                                    media.mimetype.includes('mp4');
                const isAudioFilename = media.filename && /\.(mp3|wav|m4a|ogg|aac|flac|wma)$/i.test(media.filename);

                if (isAudioMime || isAudioFilename) {
                    const buffer = Buffer.from(media.data, 'base64');
                    const metadata = await musicMetadata.parseBuffer(buffer, media.mimetype);
                    const durationSeconds = metadata.format.duration || 0;

                    if (durationSeconds > 0) {
                        const billAmount = calculateBill(durationSeconds);
                        const formattedDur = formatDuration(durationSeconds);

                        const updatedData = recordTransaction(customerId, {
                            filename: media.filename || 'audio_document',
                            durationSeconds: durationSeconds,
                            amount: billAmount
                        });

                        const replyText = `📄 *অডিও ফাইল প্রসেস করা হয়েছে*\n\n` +
                                          `⏱️ *ডিউরেশন:* ${formattedDur}\n` +
                                          `💰 *এই ফাইলের বিল:* ৳ ${billAmount} টাকা\n` +
                                          `📊 *আপনার সর্বমোট বকেয়া বিল:* ৳ ${updatedData.totalBill} টাকা`;

                        await msg.reply(replyText);
                    }
                }
            }
        } catch (err) {
            console.error('[Error processing message]:', err);
        }
    });

    client.initialize();
}

initializeWhatsAppClient();
