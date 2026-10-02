# WhatsApp Audio Billing Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node.js WhatsApp Bot using `whatsapp-web.js` that detects audio documents, calculates tiered bills based on duration, sends automated responses, and logs transactions to `bills.json`.

**Architecture:** A modular Node.js application. `billingCalculator.js` handles duration-to-price logic, `ledger.js` manages local JSON storage, and `index.js` ties together `whatsapp-web.js` event listeners with an Express health-check server.

**Tech Stack:** Node.js, `whatsapp-web.js`, `music-metadata`, `express`, `qrcode-terminal`, `fs-extra`, Docker.

## Global Constraints

- Must calculate rates using exact rules: 0:00-1:08 (50 taka), 1:09-1:19 (75 taka), 1:20-2:08 (100 taka), +50 taka per extra minute block, +25 taka for the :09-:19 buffer.
- Must respond to `হিসাব` with unpaid bill balance.
- Must respond to `বিল ক্লিয়ার` with reset balance confirmation.
- Exclude `ptt` voice notes; process only document attachments.

---

### Task 1: Billing Calculator Core & Tests

**Files:**
- Create: `lib/billingCalculator.js`
- Create: `test/billingCalculator.test.js`

- [ ] **Step 1: Write unit tests for billing calculator**

Create `test/billingCalculator.test.js`:
```javascript
const assert = require('assert');
const { calculateBill, formatDuration } = require('../lib/billingCalculator');

// Test Tier 1 (0:00 to 1:08)
assert.strictEqual(calculateBill(30), 50, '30s should be 50 Taka');
assert.strictEqual(calculateBill(68), 50, '68s (1:08) should be 50 Taka');

// Test Tier 1 Buffer (1:09 to 1:19)
assert.strictEqual(calculateBill(69), 75, '69s (1:09) should be 75 Taka');
assert.strictEqual(calculateBill(79), 75, '79s (1:19) should be 75 Taka');

// Test Tier 2 (1:20 to 2:08)
assert.strictEqual(calculateBill(80), 100, '80s (1:20) should be 100 Taka');
assert.strictEqual(calculateBill(128), 100, '128s (2:08) should be 100 Taka');

// Test Tier 2 Buffer (2:09 to 2:19)
assert.strictEqual(calculateBill(129), 125, '129s (2:09) should be 125 Taka');
assert.strictEqual(calculateBill(139), 125, '139s (2:19) should be 125 Taka');

// Test Tier 3 (2:20 to 3:08)
assert.strictEqual(calculateBill(140), 150, '140s (2:20) should be 150 Taka');
assert.strictEqual(calculateBill(188), 150, '188s (3:08) should be 150 Taka');

// Test Duration Format
assert.strictEqual(formatDuration(75), '1:15');
assert.strictEqual(formatDuration(68), '1:08');

console.log('All billingCalculator tests passed!');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/billingCalculator.test.js`
Expected: Error - Cannot find module '../lib/billingCalculator'

- [ ] **Step 3: Implement `lib/billingCalculator.js`**

Create `lib/billingCalculator.js`:
```javascript
function calculateBill(durationInSeconds) {
    if (!durationInSeconds || durationInSeconds <= 0) return 0;

    const roundedSeconds = Math.round(durationInSeconds);

    if (roundedSeconds <= 68) { // 0:00 to 1:08
        return 50;
    }
    if (roundedSeconds <= 79) { // 1:09 to 1:19
        return 75;
    }

    const offset = roundedSeconds - 80; // starting at 1:20 (80s)
    const k = Math.floor(offset / 60);
    const remainder = offset % 60;

    if (remainder <= 48) { // x:20 to (x+1):08
        return 100 + (k * 50);
    } else { // (x+1):09 to (x+1):19
        return 125 + (k * 50);
    }
}

function formatDuration(durationInSeconds) {
    const totalSec = Math.round(durationInSeconds || 0);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

module.exports = {
    calculateBill,
    formatDuration
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/billingCalculator.test.js`
Expected: "All billingCalculator tests passed!"

---

### Task 2: Ledger Manager (`lib/ledger.js`) & Tests

**Files:**
- Create: `lib/ledger.js`
- Create: `test/ledger.test.js`

- [ ] **Step 1: Write unit tests for ledger manager**

Create `test/ledger.test.js`:
```javascript
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { getCustomerBill, recordTransaction, clearCustomerBill } = require('../lib/ledger');

const testDbPath = path.join(__dirname, 'test_bills.json');
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

const customer = '123456789';

// Record transaction
const record = recordTransaction(customer, { filename: 'test.mp3', durationSeconds: 75, amount: 75 }, testDbPath);
assert.strictEqual(record.totalBill, 75);

// Check getCustomerBill
const data = getCustomerBill(customer, testDbPath);
assert.strictEqual(data.totalBill, 75);

// Record second transaction
recordTransaction(customer, { filename: 'test2.mp3', durationSeconds: 60, amount: 50 }, testDbPath);
const updatedData = getCustomerBill(customer, testDbPath);
assert.strictEqual(updatedData.totalBill, 125);

// Clear bill
clearCustomerBill(customer, testDbPath);
const clearedData = getCustomerBill(customer, testDbPath);
assert.strictEqual(clearedData.totalBill, 0);

if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
console.log('All ledger tests passed!');
```

- [ ] **Step 2: Implement `lib/ledger.js`**

Create `lib/ledger.js`:
```javascript
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'bills.json');

function readDb(filePath = DEFAULT_FILE) {
    try {
        if (!fs.existsSync(filePath)) {
            return {};
        }
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data || '{}');
    } catch (err) {
        console.error('Error reading bills DB:', err);
        return {};
    }
}

function writeDb(data, filePath = DEFAULT_FILE) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('Error writing bills DB:', err);
    }
}

function getCustomerBill(phoneNumber, filePath = DEFAULT_FILE) {
    const db = readDb(filePath);
    return db[phoneNumber] || { totalBill: 0, transactions: [] };
}

function recordTransaction(phoneNumber, transaction, filePath = DEFAULT_FILE) {
    const db = readDb(filePath);
    if (!db[phoneNumber]) {
        db[phoneNumber] = { totalBill: 0, transactions: [] };
    }

    db[phoneNumber].transactions.push({
        timestamp: new Date().toISOString(),
        ...transaction
    });
    db[phoneNumber].totalBill += transaction.amount;

    writeDb(db, filePath);
    return db[phoneNumber];
}

function clearCustomerBill(phoneNumber, filePath = DEFAULT_FILE) {
    const db = readDb(filePath);
    if (db[phoneNumber]) {
        db[phoneNumber].totalBill = 0;
        db[phoneNumber].transactions = [];
        writeDb(db, filePath);
    }
    return { totalBill: 0, transactions: [] };
}

module.exports = {
    getCustomerBill,
    recordTransaction,
    clearCustomerBill
};
```

- [ ] **Step 3: Run test to verify it passes**

Run: `node test/ledger.test.js`
Expected: "All ledger tests passed!"

---

### Task 3: Main Bot (`index.js`) and Package Manifest

**Files:**
- Create: `package.json`
- Create: `index.js`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "whatsapp-audio-billing-bot",
  "version": "1.0.0",
  "description": "WhatsApp Bot for measuring audio document duration and calculating bills",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "test": "node test/billingCalculator.test.js && node test/ledger.test.js"
  },
  "dependencies": {
    "express": "^4.19.2",
    "music-metadata": "^7.14.0",
    "qrcode-terminal": "^0.12.0",
    "whatsapp-web.js": "^1.26.0"
  }
}
```

- [ ] **Step 2: Create `index.js`**

```javascript
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const musicMetadata = require('music-metadata');
const { calculateBill, formatDuration } = require('./lib/billingCalculator');
const { getCustomerBill, recordTransaction, clearCustomerBill } = require('./lib/ledger');

// Express server for Render/Koyeb health check
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('WhatsApp Audio Billing Bot is active!');
});

app.listen(PORT, () => {
    console.log(`[HTTP Server] Listening on port ${PORT}`);
});

// Initialize WhatsApp Web Client
const client = new Client({
    authStrategy: new LocalAuth(),
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

client.on('qr', (qr) => {
    console.log('[WhatsApp] Scan this QR code:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('[WhatsApp] Client is ready and connected!');
});

client.on('message', async (msg) => {
    try {
        const chat = await msg.getChat();
        const customerId = msg.from;
        const text = (msg.body || '').trim();

        // Command: হিসাব
        if (text === 'হিসাব') {
            const customerData = getCustomerBill(customerId);
            await msg.reply(`📋 *আপনার বর্তমান হিসাব summary:*\n\nমোট অপিরিশোধিত বিল: *৳ ${customerData.totalBill} টাকা*\nমোট ফাইল গণনাকৃত: ${customerData.transactions.length} টি`);
            return;
        }

        // Command: বিল ক্লিয়ার
        if (text === 'বিল ক্লিয়ার') {
            clearCustomerBill(customerId);
            await msg.reply(`✅ আপনার পূর্বের সকল বিল পরিশোধিত হয়েছে। বর্তমান বকেয়া: *৳ 0 টাকা*`);
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
```

---

### Task 4: Deployment Artifacts (`Dockerfile`, `.dockerignore`, `README.md`)

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `README.md`

- [ ] **Step 1: Create `Dockerfile`**

```dockerfile
FROM node:18-slim

RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
```

- [ ] **Step 2: Create `.dockerignore`**

```
node_modules
.wwebjs_auth
.wwebjs_cache
bills.json
.git
```

- [ ] **Step 3: Create `README.md` with usage & hosting instructions**

Create concise documentation for running locally and hosting on Render/Koyeb.
