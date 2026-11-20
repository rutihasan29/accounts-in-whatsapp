const fs = require('fs');
const path = require('path');
const config = require('./config');

const DEFAULT_LATENTSYNC_VERSION = '637ce1919f807ca20da3a448ddc2743535d2853649574cd52a933120e9b9e293';
const DEFAULT_GUIDANCE_SCALE = 1.3;

/**
 * Checks if a message represents an audio or voice recording
 */
function isAudioMedia(msg) {
  if (!msg) return false;
  const type = String(msg.type || '').toLowerCase();
  const mime = String(msg.mimetype || '').toLowerCase();
  const fn = String(msg.filename || '').toLowerCase();

  if (type === 'audio' || type === 'ptt') return true;
  if (mime.startsWith('audio/')) return true;
  if (mime === 'video/ogg' || mime === 'application/ogg') return true;
  if (/\.(mp3|wav|m4a|aac|ogg|opus|flac)$/i.test(fn)) return true;

  return false;
}

/**
 * Uploads a local buffer to Replicate's Files API
 */
async function uploadBufferToReplicate({
  buffer,
  filename = 'file.bin',
  contentType = 'application/octet-stream',
  apiToken = config.REPLICATE_API_TOKEN,
  fetchFn = globalThis.fetch
} = {}) {
  if (!apiToken) {
    throw new Error('REPLICATE_API_TOKEN is not configured in .env');
  }
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error('Valid buffer is required for upload');
  }

  const blob = new Blob([buffer], { type: contentType });
  const form = new FormData();
  form.append('content', blob, filename);

  const res = await fetchFn('https://api.replicate.com/v1/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`
    },
    body: form
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Replicate file upload failed (HTTP ${res.status}): ${errText}`);
  }

  const data = await res.json();
  const getUrl = data.urls?.get;
  if (!getUrl) {
    throw new Error('Replicate did not return a valid file download URL');
  }

  return getUrl;
}

/**
 * Creates a LatentSync prediction on Replicate
 */
async function createLatentSyncPrediction({
  videoUrl,
  audioUrl,
  guidanceScale = DEFAULT_GUIDANCE_SCALE,
  version = config.REPLICATE_LATENTSYNC_VERSION || DEFAULT_LATENTSYNC_VERSION,
  apiToken = config.REPLICATE_API_TOKEN,
  fetchFn = globalThis.fetch
} = {}) {
  if (!apiToken) {
    throw new Error('REPLICATE_API_TOKEN is not configured in .env');
  }
  if (!videoUrl || !audioUrl) {
    throw new Error('Both videoUrl and audioUrl are required');
  }

  const payload = {
    version,
    input: {
      video: videoUrl,
      audio: audioUrl,
      guidance_scale: Number(guidanceScale) || DEFAULT_GUIDANCE_SCALE,
      seed: 0
    }
  };

  const res = await fetchFn('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Failed to create LatentSync prediction (HTTP ${res.status}): ${errText}`);
  }

  return await res.json();
}

/**
 * Polls a Replicate prediction until completion
 */
async function pollPrediction({
  predictionId,
  apiToken = config.REPLICATE_API_TOKEN,
  timeoutMs = 5 * 60 * 1000,
  intervalMs = 3000,
  fetchFn = globalThis.fetch
} = {}) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const res = await fetchFn(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: {
        Authorization: `Bearer ${apiToken}`
      }
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Prediction status check failed (HTTP ${res.status}): ${errText}`);
    }

    const data = await res.json();
    const status = data.status;

    if (status === 'succeeded') {
      const output = data.output;
      if (!output) {
        throw new Error('Prediction succeeded but output URL was empty');
      }
      return output;
    }

    if (status === 'failed' || status === 'canceled') {
      const errorMsg = data.error || 'Unknown Replicate error';
      throw new Error(`LatentSync prediction ${status}: ${errorMsg}`);
    }

    // Wait before polling again
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new Error(`LatentSync prediction timed out after ${Math.round(timeoutMs / 1000)}s`);
}

/**
 * Downloads a remote URL to a Buffer
 */
async function downloadUrlToBuffer({ url, fetchFn = globalThis.fetch } = {}) {
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`Failed to download output video from ${url} (HTTP ${res.status})`);
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Main command handler when a user replies to an audio with "gs1", "gs2", etc.
 */
async function handleLipSyncCommand({
  msg,
  client,
  command = 'gs1',
  targetChat,
  projectRoot = path.join(__dirname, '..'),
  fetchFn = globalThis.fetch
} = {}) {
  const cmdLower = command.toLowerCase().trim();
  const chatJid = targetChat || msg.from;

  // Helper to reply in group
  const sendReply = async (text) => {
    try {
      if (typeof msg.reply === 'function') {
        return await msg.reply(text);
      }
      if (client && typeof client.sendMessage === 'function') {
        return await client.sendMessage(chatJid, text);
      }
    } catch (err) {
      console.warn(`[LIPSYNC] Failed to send reply: ${err.message}`);
    }
  };

  // 1. Check if message has a quoted message
  let quotedMsg = null;
  if (typeof msg.getQuotedMessage === 'function') {
    try {
      quotedMsg = await msg.getQuotedMessage();
    } catch (err) {
      console.warn('[LIPSYNC] Error calling getQuotedMessage:', err.message);
    }
  }

  if (!quotedMsg && msg.quotedMsg) {
    quotedMsg = msg.quotedMsg;
  }

  if (!quotedMsg) {
    await sendReply(`⚠️ কোনো অডিও ফাইলে রিপ্লাই দিয়ে "*${cmdLower}*" লিখুন।\n(যে অডিওটির লিপসিঙ্ক করতে চান, সেই অডিওতে সোয়াইপ/রিপ্লাই করুন)।`);
    return { action: 'MISSING_QUOTED_MESSAGE' };
  }

  // 2. Verify that the quoted message contains audio
  if (!isAudioMedia(quotedMsg)) {
    await sendReply(`⚠️ নির্বাচিত মেসেজটিতে কোনো অডিও ফাইল পাওয়া যায়নি!\nদয়া করে একটি অডিও/ভয়েস মেসেজে রিপ্লাই দিয়ে "*${cmdLower}*" লিখুন।`);
    return { action: 'QUOTED_NOT_AUDIO' };
  }

  // 3. Verify that the input video file (e.g. gs1.mp4) exists in project root
  const videoFilename = `${cmdLower}.mp4`;
  const videoFilePath = path.join(projectRoot, videoFilename);
  if (!fs.existsSync(videoFilePath)) {
    await sendReply(`❌ প্রজেক্ট ফোল্ডারে "*${videoFilename}*" ফাইলটি পাওয়া যায়নি!\nদয়া করে প্রজেক্ট ফোল্ডারে "*${videoFilename}*" ভিডিও আপলোড করে আবার চেষ্টা করুন।`);
    return { action: 'VIDEO_NOT_FOUND', videoFilename };
  }

  const guidanceScale = config.LATENTSYNC_GUIDANCE_SCALE || DEFAULT_GUIDANCE_SCALE;

  // 4. Send initial progress notification to the group
  await sendReply(
    `⏳ *লিপসিঙ্ক প্রসেসিং শুরু হয়েছে (${cmdLower.toUpperCase()})*\n` +
    `• ইনপুট ভিডিও: \`${videoFilename}\`\n` +
    `• অডিও: সিলেক্টেড অডিও ফাইল\n` +
    `• মডেল: Replicate LatentSync 1.6 (Guidance Scale: ${guidanceScale})\n\n` +
    `মিডিয়া ফাইল আপলোড এবং রেন্ডারিং চলছে, অনুগ্রহ করে অপেক্ষা করুন...`
  );

  try {
    // 5. Download the quoted audio media buffer
    let audioBuffer = null;
    let audioMime = quotedMsg.mimetype || 'audio/mp3';
    let audioName = quotedMsg.filename || `${cmdLower}_audio.mp3`;

    if (typeof quotedMsg.downloadMedia === 'function') {
      const media = await quotedMsg.downloadMedia();
      if (media && media.data) {
        audioBuffer = Buffer.from(media.data, 'base64');
        if (media.mimetype) audioMime = media.mimetype;
        if (media.filename) audioName = media.filename;
      }
    } else if (quotedMsg.data) {
      audioBuffer = Buffer.from(quotedMsg.data, 'base64');
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      throw new Error('হোয়াটসঅ্যাপ থেকে অডিও ফাইল ডাউনলোড করা সম্ভব হয়নি');
    }

    // Read the local video file buffer
    const videoBuffer = fs.readFileSync(videoFilePath);

    // 6. Upload both audio and video to Replicate Files API
    const [audioUrl, videoUrl] = await Promise.all([
      uploadBufferToReplicate({
        buffer: audioBuffer,
        filename: audioName,
        contentType: audioMime,
        fetchFn
      }),
      uploadBufferToReplicate({
        buffer: videoBuffer,
        filename: videoFilename,
        contentType: 'video/mp4',
        fetchFn
      })
    ]);

    // 7. Create LatentSync prediction on Replicate
    const prediction = await createLatentSyncPrediction({
      videoUrl,
      audioUrl,
      guidanceScale,
      fetchFn
    });

    // 8. Poll prediction until completion
    const outputVideoUrl = await pollPrediction({
      predictionId: prediction.id,
      fetchFn
    });

    // 9. Download output video buffer
    const resultVideoBuffer = await downloadUrlToBuffer({
      url: outputVideoUrl,
      fetchFn
    });

    // 10. Send the output video back to the group as a document
    const outputFilename = `${cmdLower}_lipsync_${Date.now()}.mp4`;
    let sentMsg = null;

    if (client && typeof client.sendMessage === 'function') {
      // Use whatsapp-web.js MessageMedia if available
      let mediaPayload;
      try {
        const { MessageMedia } = require('whatsapp-web.js');
        mediaPayload = new MessageMedia('video/mp4', resultVideoBuffer.toString('base64'), outputFilename);
      } catch {
        mediaPayload = {
          mimetype: 'video/mp4',
          data: resultVideoBuffer.toString('base64'),
          filename: outputFilename
        };
      }

      sentMsg = await client.sendMessage(chatJid, mediaPayload, {
        sendMediaAsDocument: true,
        caption: `✅ *লিপসিঙ্ক ভিডিও সম্পন্ন হয়েছে! (${cmdLower.toUpperCase()})*\n• ফাইল: \`${outputFilename}\`\n• মডেল: LatentSync 1.6`
      });

      // Avoid echo processing
      try {
        const { sentGeneratedVoiceMsgIds } = require('./tts');
        if (sentMsg?.id?._serialized && sentGeneratedVoiceMsgIds) {
          sentGeneratedVoiceMsgIds.add(sentMsg.id._serialized);
        }
      } catch {}
    }

    return {
      action: 'LIPSYNC_COMPLETED',
      command: cmdLower,
      filename: outputFilename,
      videoUrl: outputVideoUrl
    };
  } catch (err) {
    console.error(`[LIPSYNC ERROR]`, err);
    await sendReply(`❌ *লিপসিঙ্ক ব্যর্থ হয়েছে!*\nকারণ: ${err.message || 'অপ্রত্যাশিত সমস্যা দেখা দিয়েছে'}`);
    return { action: 'LIPSYNC_FAILED', error: err.message };
  }
}

module.exports = {
  isAudioMedia,
  uploadBufferToReplicate,
  createLatentSyncPrediction,
  pollPrediction,
  downloadUrlToBuffer,
  handleLipSyncCommand,
  DEFAULT_LATENTSYNC_VERSION,
  DEFAULT_GUIDANCE_SCALE
};
