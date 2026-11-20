const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  isAudioMedia,
  uploadBufferToReplicate,
  createLatentSyncPrediction,
  pollPrediction,
  downloadUrlToBuffer,
  handleLipSyncCommand
} = require('../src/lipsync');
const { handleGeneratedVoiceMessage } = require('../src/tts');
const { initDb } = require('../src/db');

describe('LatentSync Lip-Sync Module (Replicate 1.6)', () => {
  describe('isAudioMedia', () => {
    it('returns true for type=audio and type=ptt', () => {
      assert.strictEqual(isAudioMedia({ type: 'audio' }), true);
      assert.strictEqual(isAudioMedia({ type: 'ptt' }), true);
    });

    it('returns true for audio mimetypes', () => {
      assert.strictEqual(isAudioMedia({ mimetype: 'audio/mpeg' }), true);
      assert.strictEqual(isAudioMedia({ mimetype: 'audio/wav' }), true);
      assert.strictEqual(isAudioMedia({ mimetype: 'audio/ogg; codecs=opus' }), true);
    });

    it('returns true for audio file extensions', () => {
      assert.strictEqual(isAudioMedia({ filename: 'voiceover.mp3' }), true);
      assert.strictEqual(isAudioMedia({ filename: 'news.wav' }), true);
      assert.strictEqual(isAudioMedia({ filename: 'report.m4a' }), true);
    });

    it('returns false for non-audio messages', () => {
      assert.strictEqual(isAudioMedia(null), false);
      assert.strictEqual(isAudioMedia({ type: 'chat', body: 'hello' }), false);
      assert.strictEqual(isAudioMedia({ type: 'image', mimetype: 'image/jpeg' }), false);
      assert.strictEqual(isAudioMedia({ filename: 'document.pdf', mimetype: 'application/pdf' }), false);
    });
  });

  describe('uploadBufferToReplicate', () => {
    it('throws if apiToken is missing', async () => {
      await assert.rejects(
        () => uploadBufferToReplicate({ buffer: Buffer.from('test'), apiToken: '' }),
        /REPLICATE_API_TOKEN is not configured/
      );
    });

    it('throws if buffer is invalid', async () => {
      await assert.rejects(
        () => uploadBufferToReplicate({ buffer: null, apiToken: 'test-token' }),
        /Valid buffer is required/
      );
    });

    it('uploads buffer successfully and returns file URL', async () => {
      const mockFetch = async (url, opts) => {
        assert.strictEqual(url, 'https://api.replicate.com/v1/files');
        assert.strictEqual(opts.headers.Authorization, 'Bearer test-token');
        return {
          ok: true,
          json: async () => ({
            urls: { get: 'https://api.replicate.com/v1/files/sample.mp3' }
          })
        };
      };

      const resultUrl = await uploadBufferToReplicate({
        buffer: Buffer.from('audio-bytes'),
        filename: 'sample.mp3',
        contentType: 'audio/mpeg',
        apiToken: 'test-token',
        fetchFn: mockFetch
      });

      assert.strictEqual(resultUrl, 'https://api.replicate.com/v1/files/sample.mp3');
    });

    it('handles Replicate HTTP upload errors', async () => {
      const mockFetch = async () => ({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized'
      });

      await assert.rejects(
        () => uploadBufferToReplicate({
          buffer: Buffer.from('bytes'),
          apiToken: 'bad-token',
          fetchFn: mockFetch
        }),
        /Replicate file upload failed \(HTTP 401\): Unauthorized/
      );
    });
  });

  describe('createLatentSyncPrediction', () => {
    it('creates prediction payload with guidance_scale: 1.3', async () => {
      let capturedPayload = null;
      const mockFetch = async (url, opts) => {
        assert.strictEqual(url, 'https://api.replicate.com/v1/predictions');
        capturedPayload = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({ id: 'pred_123', status: 'starting' })
        };
      };

      const res = await createLatentSyncPrediction({
        videoUrl: 'https://cdn.example.com/video.mp4',
        audioUrl: 'https://cdn.example.com/audio.mp3',
        guidanceScale: 1.3,
        apiToken: 'test-token',
        fetchFn: mockFetch
      });

      assert.strictEqual(res.id, 'pred_123');
      assert.strictEqual(capturedPayload.input.guidance_scale, 1.3);
      assert.strictEqual(capturedPayload.input.video, 'https://cdn.example.com/video.mp4');
      assert.strictEqual(capturedPayload.input.audio, 'https://cdn.example.com/audio.mp3');
    });
  });

  describe('pollPrediction', () => {
    it('polls until status is succeeded and returns output URL', async () => {
      let callCount = 0;
      const mockFetch = async (url) => {
        callCount++;
        assert.ok(url.includes('pred_123'));
        if (callCount < 2) {
          return {
            ok: true,
            json: async () => ({ id: 'pred_123', status: 'processing' })
          };
        }
        return {
          ok: true,
          json: async () => ({
            id: 'pred_123',
            status: 'succeeded',
            output: 'https://replicate.delivery/output.mp4'
          })
        };
      };

      const output = await pollPrediction({
        predictionId: 'pred_123',
        apiToken: 'test-token',
        intervalMs: 10,
        fetchFn: mockFetch
      });

      assert.strictEqual(output, 'https://replicate.delivery/output.mp4');
      assert.strictEqual(callCount, 2);
    });

    it('throws on failed prediction', async () => {
      const mockFetch = async () => ({
        ok: true,
        json: async () => ({ id: 'pred_fail', status: 'failed', error: 'CUDA out of memory' })
      });

      await assert.rejects(
        () => pollPrediction({ predictionId: 'pred_fail', apiToken: 'test-token', intervalMs: 10, fetchFn: mockFetch }),
        /LatentSync prediction failed: CUDA out of memory/
      );
    });
  });

  describe('handleLipSyncCommand', () => {
    it('replies with warning when no message is quoted', async () => {
      const sentReplies = [];
      const mockMsg = {
        from: '12345@g.us',
        body: 'gs1',
        hasQuotedMsg: false,
        getQuotedMessage: async () => null,
        reply: async (text) => sentReplies.push(text)
      };

      const res = await handleLipSyncCommand({ msg: mockMsg, command: 'gs1' });
      assert.strictEqual(res.action, 'MISSING_QUOTED_MESSAGE');
      assert.ok(sentReplies[0].includes('কোনো অডিও ফাইলে রিপ্লাই দিয়ে "*gs1*" লিখুন'));
    });

    it('replies with warning when quoted message is not audio', async () => {
      const sentReplies = [];
      const mockMsg = {
        from: '12345@g.us',
        body: 'gs1',
        hasQuotedMsg: true,
        getQuotedMessage: async () => ({
          type: 'chat',
          body: 'Hello text'
        }),
        reply: async (text) => sentReplies.push(text)
      };

      const res = await handleLipSyncCommand({ msg: mockMsg, command: 'gs1' });
      assert.strictEqual(res.action, 'QUOTED_NOT_AUDIO');
      assert.ok(sentReplies[0].includes('কোনো অডিও ফাইল পাওয়া যায়নি'));
    });

    it('replies with warning when input video gs1.mp4 is not in project root', async () => {
      const sentReplies = [];
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lipsync-test-'));
      const mockMsg = {
        from: '12345@g.us',
        body: 'gs1',
        hasQuotedMsg: true,
        getQuotedMessage: async () => ({
          type: 'audio',
          mimetype: 'audio/mpeg',
          filename: 'test.mp3'
        }),
        reply: async (text) => sentReplies.push(text)
      };

      const res = await handleLipSyncCommand({
        msg: mockMsg,
        command: 'gs1',
        projectRoot: tempDir
      });

      assert.strictEqual(res.action, 'VIDEO_NOT_FOUND');
      assert.ok(sentReplies[0].includes('gs1.mp4') && sentReplies[0].includes('ফাইলটি পাওয়া যায়নি'));
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('executes full pipeline successfully: uploads, predicts, and sends document back', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lipsync-test-'));
      fs.writeFileSync(path.join(tempDir, 'gs1.mp4'), Buffer.from('fake-video-mp4-data'));

      const sentReplies = [];
      const sentClientMessages = [];

      const mockMsg = {
        from: '12345@g.us',
        body: 'gs1',
        hasQuotedMsg: true,
        getQuotedMessage: async () => ({
          type: 'audio',
          mimetype: 'audio/mpeg',
          filename: 'news_audio.mp3',
          downloadMedia: async () => ({
            mimetype: 'audio/mpeg',
            data: Buffer.from('fake-audio-mp3-data').toString('base64'),
            filename: 'news_audio.mp3'
          })
        }),
        reply: async (text) => sentReplies.push(text)
      };

      const mockClient = {
        sendMessage: async (chat, media, opts) => {
          sentClientMessages.push({ chat, media, opts });
          return { id: { _serialized: 'sent_lip_sync_1' } };
        }
      };

      const mockFetch = async (url, opts = {}) => {
        if (url === 'https://api.replicate.com/v1/files') {
          return {
            ok: true,
            json: async () => ({ urls: { get: 'https://api.replicate.com/v1/files/uploaded.bin' } })
          };
        }
        if (url === 'https://api.replicate.com/v1/predictions') {
          return {
            ok: true,
            json: async () => ({ id: 'pred_e2e_123', status: 'starting' })
          };
        }
        if (url === 'https://api.replicate.com/v1/predictions/pred_e2e_123') {
          return {
            ok: true,
            json: async () => ({
              id: 'pred_e2e_123',
              status: 'succeeded',
              output: 'https://replicate.delivery/e2e_result.mp4'
            })
          };
        }
        if (url === 'https://replicate.delivery/e2e_result.mp4') {
          return {
            ok: true,
            arrayBuffer: async () => Buffer.from('rendered-lipsync-video-buffer')
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      const res = await handleLipSyncCommand({
        msg: mockMsg,
        client: mockClient,
        command: 'gs1',
        targetChat: '12345@g.us',
        projectRoot: tempDir,
        fetchFn: mockFetch
      });

      assert.strictEqual(res.action, 'LIPSYNC_COMPLETED');
      assert.strictEqual(res.command, 'gs1');
      assert.ok(res.filename.startsWith('gs1_lipsync_'));

      // Check progress message
      assert.ok(sentReplies.some(r => r.includes('লিপসিঙ্ক প্রসেসিং শুরু হয়েছে (GS1)')));

      // Check final video sent as document
      assert.strictEqual(sentClientMessages.length, 1);
      const delivery = sentClientMessages[0];
      assert.strictEqual(delivery.chat, '12345@g.us');
      assert.strictEqual(delivery.opts.sendMediaAsDocument, true);
      assert.ok(delivery.opts.caption.includes('লিপসিঙ্ক ভিডিও সম্পন্ন হয়েছে'));

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('Integration with handleGeneratedVoiceMessage in tts.js', () => {
    it('dispatches "gs1" reply command in generated voice group to handleLipSyncCommand', async () => {
      const db = initDb(':memory:');
      const sentReplies = [];

      const mockGroupMsg = {
        from: '120363000000000000@g.us',
        to: '120363000000000000@g.us',
        body: 'gs1',
        hasQuotedMsg: false,
        getQuotedMessage: async () => null,
        reply: async (text) => sentReplies.push(text)
      };

      const mockClient = {
        getChatById: async () => ({ name: 'জেনারেটেড ভয়েস' })
      };

      const res = await handleGeneratedVoiceMessage({
        msg: mockGroupMsg,
        client: mockClient,
        db
      });

      assert.strictEqual(res.action, 'MISSING_QUOTED_MESSAGE');
      assert.ok(sentReplies[0].includes('কোনো অডিও ফাইলে রিপ্লাই দিয়ে "*gs1*" লিখুন'));
      db.close();
    });
  });
});
