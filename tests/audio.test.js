const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  formatAudioDuration,
  isAudioDocumentMessage,
  getAudioDurationFromBuffer
} = require('../src/audio');

describe('Audio Module', () => {
  describe('formatAudioDuration', () => {
    it('formats seconds only when under one minute', () => {
      assert.strictEqual(formatAudioDuration(45), 'অডিওর দৈর্ঘ্য: ৪৫ সেকেন্ড');
      assert.strictEqual(formatAudioDuration(12.4), 'অডিওর দৈর্ঘ্য: ১২ সেকেন্ড');
    });

    it('formats minutes and seconds', () => {
      assert.strictEqual(formatAudioDuration(135), 'অডিওর দৈর্ঘ্য: ২ মিনিট ১৫ সেকেন্ড');
      assert.strictEqual(formatAudioDuration(61), 'অডিওর দৈর্ঘ্য: ১ মিনিট ১ সেকেন্ড');
      assert.strictEqual(formatAudioDuration(120), 'অডিওর দৈর্ঘ্য: ২ মিনিট ০ সেকেন্ড');
    });

    it('formats hours, minutes, and seconds when an hour or more', () => {
      assert.strictEqual(formatAudioDuration(3665), 'অডিওর দৈর্ঘ্য: ১ ঘণ্টা ১ মিনিট ৫ সেকেন্ড');
    });

    it('handles zero or invalid duration gracefully', () => {
      assert.strictEqual(formatAudioDuration(0), 'অডিওর দৈর্ঘ্য: ০ সেকেন্ড');
      assert.strictEqual(formatAudioDuration(null), null);
    });
  });

  describe('isAudioDocumentMessage', () => {
    it('returns true for .mp3 document file', () => {
      const msg = {
        hasMedia: true,
        type: 'document',
        isVoice: false,
        mimetype: 'audio/mpeg',
        filename: 'recording.mp3'
      };
      assert.strictEqual(isAudioDocumentMessage(msg), true);
    });

    it('returns true for .wav document file', () => {
      const msg = {
        hasMedia: true,
        type: 'document',
        isVoice: false,
        mimetype: 'audio/wav',
        filename: 'sample.wav'
      };
      assert.strictEqual(isAudioDocumentMessage(msg), true);
    });

    it('returns false for voice note / ptt messages', () => {
      const pttMsg1 = {
        hasMedia: true,
        type: 'ptt',
        isVoice: true,
        mimetype: 'audio/ogg; codecs=opus'
      };
      const pttMsg2 = {
        hasMedia: true,
        type: 'document',
        isVoice: true,
        mimetype: 'audio/ogg'
      };
      assert.strictEqual(isAudioDocumentMessage(pttMsg1), false);
      assert.strictEqual(isAudioDocumentMessage(pttMsg2), false);
    });

    it('returns false for non-audio document (pdf, image)', () => {
      const pdfMsg = {
        hasMedia: true,
        type: 'document',
        isVoice: false,
        filename: 'invoice.pdf',
        mimetype: 'application/pdf'
      };
      assert.strictEqual(isAudioDocumentMessage(pdfMsg), false);
    });

    it('returns false for regular text message without media', () => {
      const textMsg = {
        hasMedia: false,
        type: 'chat',
        body: 'বিল ৩০০ টাকা'
      };
      assert.strictEqual(isAudioDocumentMessage(textMsg), false);
    });
  });

  describe('getAudioDurationFromBuffer', () => {
    it('parses duration from a valid WAV buffer', async () => {
      // Construct a minimal valid 1-second 8kHz 8-bit mono PCM WAV buffer
      const sampleRate = 8000;
      const numChannels = 1;
      const bitsPerSample = 8;
      const dataSize = sampleRate * numChannels * (bitsPerSample / 8); // 8000 bytes = 1 second
      const buffer = Buffer.alloc(44 + dataSize);

      buffer.write('RIFF', 0);
      buffer.writeUInt32LE(36 + dataSize, 4);
      buffer.write('WAVE', 8);
      buffer.write('fmt ', 12);
      buffer.writeUInt32LE(16, 16); // Subchunk1Size
      buffer.writeUInt16LE(1, 20); // PCM
      buffer.writeUInt16LE(numChannels, 22);
      buffer.writeUInt32LE(sampleRate, 24);
      buffer.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28); // ByteRate
      buffer.writeUInt16LE(numChannels * (bitsPerSample / 8), 32); // BlockAlign
      buffer.writeUInt16LE(bitsPerSample, 34);
      buffer.write('data', 36);
      buffer.writeUInt32LE(dataSize, 40);

      const duration = await getAudioDurationFromBuffer(buffer, 'audio/wav');
      assert.ok(duration !== null, 'Duration should be extracted');
      assert.strictEqual(Math.round(duration), 1);
    });
  });
});
