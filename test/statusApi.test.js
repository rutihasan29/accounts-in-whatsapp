const assert = require('assert');
const express = require('express');
const http = require('http');

console.log('Testing status API logic...');

const ACCESS_PASSWORD = '6700';
let botStatus = 'INITIALIZING';
let currentQrDataUrl = null;
let lastQrTimestamp = null;

const app = express();
app.use(express.json());

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

app.post('/api/reset-session', (req, res) => {
    const pass = req.query.pass || (req.body && req.body.pass);
    if (pass !== ACCESS_PASSWORD) {
        return res.status(401).json({ success: false, error: 'ভুল পাসওয়ার্ড!' });
    }
    botStatus = 'INITIALIZING';
    currentQrDataUrl = null;
    lastQrTimestamp = null;
    res.json({ success: true, message: 'Session reset successfully' });
});

const server = app.listen(0, () => {
    const port = server.address().port;
    
    // Test 1: Invalid Password
    http.get(`http://localhost:${port}/api/status?pass=wrong`, (res) => {
        assert.strictEqual(res.statusCode, 401, 'Should return 401 for wrong pass');
        
        // Test 2: Valid Password
        http.get(`http://localhost:${port}/api/status?pass=6700`, (res2) => {
            let data = '';
            res2.on('data', chunk => data += chunk);
            res2.on('end', () => {
                const json = JSON.parse(data);
                assert.strictEqual(json.success, true);
                assert.strictEqual(json.status, 'INITIALIZING');
                
                // Test 3: Reset endpoint
                const reqPost = http.request(`http://localhost:${port}/api/reset-session?pass=6700`, { method: 'POST' }, (res3) => {
                    assert.strictEqual(res3.statusCode, 200);
                    server.close(() => {
                        console.log('✅ All statusApi tests passed!');
                    });
                });
                reqPost.end();
            });
        });
    });
});
