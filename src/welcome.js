const path = require('path');
const fs = require('fs');

let MessageMedia = null;
try {
  ({ MessageMedia } = require('whatsapp-web.js'));
} catch {}

const sentWelcomeDemoMsgIds = new Set();
const activeWelcomeDemoChats = new Set();

const DEFAULT_WELCOME_MESSAGES = [
  {
    type: 'text',
    text: 'ডেমোগুলো শুনে দেখুন'
  },
  {
    type: 'audio',
    filename: 'voice3.mp3',
    filePath: path.join(__dirname, '..', 'voice3.mp3')
  },
  {
    type: 'audio',
    filename: 'voice4.mp3',
    filePath: path.join(__dirname, '..', 'voice4.mp3')
  },
  {
    type: 'audio',
    filename: 'voice1.mp3',
    filePath: path.join(__dirname, '..', 'voice1.mp3')
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
    type: 'text',
    text: 'আমাদের কাজের আরো কিছু নমুনা নিচে দেয়া হলো:'
  },
  {
    type: 'link',
    text: 'https://www.youtube.com/watch?v=7w0kthHSFUM',
    url: 'https://www.youtube.com/watch?v=7w0kthHSFUM'
  },
  {
    type: 'link',
    text: 'https://www.youtube.com/watch?v=oRlSHM6JpkE',
    url: 'https://www.youtube.com/watch?v=oRlSHM6JpkE'
  },
  {
    type: 'link',
    text: 'https://www.youtube.com/watch?v=DuKiMWPmg68',
    url: 'https://www.youtube.com/watch?v=DuKiMWPmg68'
  },
  {
    type: 'link',
    text: 'https://www.youtube.com/watch?v=BknLpjzRevE',
    url: 'https://www.youtube.com/watch?v=BknLpjzRevE'
  },
  {
    type: 'link',
    text: 'https://www.youtube.com/watch?v=C9hVUi_ol6g',
    url: 'https://www.youtube.com/watch?v=C9hVUi_ol6g'
  },
  {
    type: 'link',
    text: 'https://www.youtube.com/watch?v=8wv9pYJT10A',
    url: 'https://www.youtube.com/watch?v=8wv9pYJT10A'
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
  force = false,
  MediaClass = MessageMedia
}) {
  if (!client || typeof client.sendMessage !== 'function' || !targetChat) {
    return { success: false, error: 'INVALID_CLIENT_OR_TARGET' };
  }

  // Guard against duplicate welcome demo sends to the same lead (unless force = true)
  if (!force && db && phone) {
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

  const cleanTarget = targetChat ? String(targetChat).replace(/\D/g, '') : '';
  const cleanP = phone ? String(phone).replace(/\D/g, '') : '';
  if (cleanTarget) activeWelcomeDemoChats.add(cleanTarget);
  if (cleanP) activeWelcomeDemoChats.add(cleanP);
  if (targetChat) activeWelcomeDemoChats.add(targetChat);

  for (let i = 0; i < msgList.length; i++) {
    const item = msgList[i];
    try {
      if (item.type === 'text') {
        const res = await client.sendMessage(targetChat, item.text);
        if (res?.id?._serialized) sentWelcomeDemoMsgIds.add(res.id._serialized);
        if (res?.id?.id) sentWelcomeDemoMsgIds.add(res.id.id);
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
            const mimeType = ext === '.mp3' ? 'audio/mpeg' : (ext === '.wav' ? 'audio/wav' : 'audio/ogg');
            media = {
              mimetype: mimeType,
              data: b64data,
              filename: path.basename(filePath)
            };
          }

          let sentMediaRes = null;
          try {
            // Send as playable audio file (NOT voice recording / PTT, NOT generic document)
            sentMediaRes = await client.sendMessage(targetChat, media, {
              sendAudioAsVoice: false,
              sendMediaAsDocument: false
            });
            if (sentMediaRes?.id?._serialized) {
              sentWelcomeDemoMsgIds.add(sentMediaRes.id._serialized);
              if (typeof sentMediaRes.id._serialized === 'string' && sentMediaRes.id._serialized.includes('_')) {
                sentWelcomeDemoMsgIds.add(sentMediaRes.id._serialized.split('_').pop());
              }
            }
            if (sentMediaRes?.id?.id) {
              sentWelcomeDemoMsgIds.add(sentMediaRes.id.id);
            }
          } catch (audioErr) {
            console.error(`[WELCOME_DEMO] Error sending audio for ${path.basename(filePath)}:`, audioErr.message);
          }
          sentResults.push({ type: 'audio', res: sentMediaRes });
        } else {
          console.warn(`[WELCOME_DEMO] Audio file not found at: ${filePath}`);
        }
      } else if (item.type === 'link') {
        const contentToSend = item.text || item.url;
        const res = await client.sendMessage(targetChat, contentToSend, { linkPreview: true });
        if (res?.id?._serialized) sentWelcomeDemoMsgIds.add(res.id._serialized);
        if (res?.id?.id) sentWelcomeDemoMsgIds.add(res.id.id);
        sentResults.push({ type: 'link', res });
      }
    } catch (sendErr) {
      console.error(`[WELCOME_DEMO] Error sending message ${i + 1} (${item.type}):`, sendErr.message);
    }

    if (delayMs > 0 && i < msgList.length - 1) {
      const waitTime = item.type === 'link' ? Math.max(delayMs, 1500) : delayMs;
      await sleep(waitTime);
    }
  }

  // Mark welcome demo as sent in DB
  if (db && phone) {
    try {
      db.prepare('UPDATE leads SET welcome_sent = 1 WHERE phone_number = ?').run(phone);
    } catch {}
  }

  // Keep target protected in activeWelcomeDemoChats for 2 minutes to guard against delayed message_create events
  setTimeout(() => {
    if (cleanTarget) activeWelcomeDemoChats.delete(cleanTarget);
    if (cleanP) activeWelcomeDemoChats.delete(cleanP);
    if (targetChat) activeWelcomeDemoChats.delete(targetChat);
  }, 120000).unref?.();

  return { success: true, count: sentResults.length };
}

module.exports = {
  DEFAULT_WELCOME_MESSAGES,
  getWelcomeMessages,
  sendWelcomeDemo,
  sentWelcomeDemoMsgIds,
  activeWelcomeDemoChats,
  sleep
};
