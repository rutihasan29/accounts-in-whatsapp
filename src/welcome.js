const path = require('path');
const fs = require('fs');

let MessageMedia = null;
try {
  ({ MessageMedia } = require('whatsapp-web.js'));
} catch {}

const DEFAULT_WELCOME_MESSAGES = [
  {
    type: 'text',
    text: 'ডেমোগুলো শুনে দেখুন'
  },
  {
    type: 'audio',
    filename: 'voice1.wav',
    filePath: path.join(__dirname, '..', 'voice1.wav')
  },
  {
    type: 'audio',
    filename: 'voice2.wav',
    filePath: path.join(__dirname, '..', 'voice2.wav')
  },
  {
    type: 'text',
    text: 'আমরা বাংলাদেশের একমাত্র ভয়েস সার্ভিস যেটা ২৪ ঘণ্টা একটিভ পাবেন'
  },
  {
    type: 'text',
    text: 'ভয়েস লাগলেই এখন হোয়াটসঅ্যাপে স্ক্রিপ্ট পাঠিয়ে দেবেন, ১০-১৫ মিনিটের মধ্যে ভয়েস পেয়ে যাবেন'
  },
  {
    type: 'text',
    text: 'কোনো অগ্রিম পেমেন্ট করতে হবে না, প্রতিদিন রাত ১২ টার মধ্যে প্রতিদিনের পেমেন্ট ক্লিয়ার করলেই চলবে'
  },
  {
    type: 'text',
    text: 'উপরের স্যাম্পলগুলো শুনে দেখুন, তারপর বিস্তারিত কথা হবে ইন শা আল্লাহ'
  },
  {
    type: 'link',
    url: 'https://www.facebook.com/share/v/18nczkKmZC/'
  }
];

function getWelcomeMessages() {
  const customConfigPath = path.join(__dirname, '..', 'welcome_messages.json');
  if (fs.existsSync(customConfigPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(customConfigPath, 'utf8'));
      if (Array.isArray(data) && data.length > 0) {
        return data;
      }
    } catch (err) {
      console.warn('[WELCOME_DEMO] Failed to parse welcome_messages.json, using defaults:', err.message);
    }
  }
  return DEFAULT_WELCOME_MESSAGES;
}

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendWelcomeDemo({
  client,
  targetChat,
  db = null,
  phone = null,
  messages = null,
  delayMs = 800,
  MediaClass = MessageMedia
}) {
  if (!client || typeof client.sendMessage !== 'function' || !targetChat) {
    return { success: false, error: 'INVALID_CLIENT_OR_TARGET' };
  }

  // Guard against duplicate welcome demo sends to the same lead
  if (db && phone) {
    try {
      const row = db.prepare('SELECT welcome_sent FROM leads WHERE phone_number = ?').get(phone);
      if (row && row.welcome_sent === 1) {
        console.log(`[WELCOME_DEMO] Welcome demo already sent to +${phone}. Skipping.`);
        return { success: false, reason: 'ALREADY_SENT' };
      }
    } catch {}
  }

  const msgList = messages || getWelcomeMessages();
  console.log(`[WELCOME_DEMO] Sending welcome demo sequence (${msgList.length} messages) to ${targetChat}...`);
  const sentResults = [];

  for (let i = 0; i < msgList.length; i++) {
    const item = msgList[i];
    try {
      if (item.type === 'text') {
        const res = await client.sendMessage(targetChat, item.text);
        sentResults.push({ type: 'text', res });
      } else if (item.type === 'audio') {
        let filePath = item.filePath || (item.filename ? path.join(__dirname, '..', item.filename) : null);
        // Prefer .mp3 version if available for fast and reliable WhatsApp delivery
        if (filePath && filePath.endsWith('.wav')) {
          const mp3Candidate = filePath.replace(/\.wav$/, '.mp3');
          if (fs.existsSync(mp3Candidate)) {
            filePath = mp3Candidate;
          }
        }
        if (filePath && fs.existsSync(filePath)) {
          let media;
          if (MediaClass && typeof MediaClass.fromFilePath === 'function') {
            media = MediaClass.fromFilePath(filePath);
          } else {
            const b64data = fs.readFileSync(filePath, { encoding: 'base64' });
            const ext = path.extname(filePath).toLowerCase();
            const mimeType = ext === '.mp3' ? 'audio/mp3' : (ext === '.wav' ? 'audio/wav' : 'audio/ogg');
            media = {
              mimetype: mimeType,
              data: b64data,
              filename: path.basename(filePath)
            };
          }

          let sentMediaRes = null;
          try {
            // Send as playable audio voice note
            sentMediaRes = await client.sendMessage(targetChat, media, { sendAudioAsVoice: true });
          } catch (voiceErr) {
            console.warn(`[WELCOME_DEMO] sendAudioAsVoice fallback to regular audio for ${path.basename(filePath)}:`, voiceErr.message);
            sentMediaRes = await client.sendMessage(targetChat, media, { sendMediaAsDocument: false });
          }
          sentResults.push({ type: 'audio', res: sentMediaRes });
        } else {
          console.warn(`[WELCOME_DEMO] Audio file not found at: ${filePath}`);
        }
      } else if (item.type === 'link') {
        const res = await client.sendMessage(targetChat, item.url, { linkPreview: true });
        sentResults.push({ type: 'link', res });
      }
    } catch (sendErr) {
      console.error(`[WELCOME_DEMO] Error sending message ${i + 1} (${item.type}):`, sendErr.message);
    }

    if (delayMs > 0 && i < msgList.length - 1) {
      await sleep(delayMs);
    }
  }

  // Mark welcome demo as sent in DB
  if (db && phone) {
    try {
      db.prepare('UPDATE leads SET welcome_sent = 1 WHERE phone_number = ?').run(phone);
    } catch {}
  }

  return { success: true, count: sentResults.length };
}

module.exports = {
  DEFAULT_WELCOME_MESSAGES,
  getWelcomeMessages,
  sendWelcomeDemo,
  sleep
};
