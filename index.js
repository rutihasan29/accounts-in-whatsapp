const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const musicMetadata = require('music-metadata');
const { calculateBill, formatDuration } = require('./lib/billingCalculator');
const { getCustomerBill, recordTransaction, clearCustomerBill } = require('./lib/ledger');

// Express server for Render/Koyeb health check & pinging
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('WhatsApp Audio Billing Bot is active and running!');
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
    console.log('\n========================================');
    console.log('[WhatsApp] SCAN THIS QR CODE TO LOGIN:');
    console.log('========================================\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('\n[WhatsApp] Bot client is successfully authenticated and ready!\n');
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
