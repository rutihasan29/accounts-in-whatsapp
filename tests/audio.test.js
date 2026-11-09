const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  formatAudioDuration,
  calculateAudioBill,
  formatBillMessage,
  isAudioDocumentMessage,
  getAudioDurationFromBuffer,
  extractHeadline,
  formatDurationForFilename,
  buildCleanVoiceFilename,
  hasBengaliCharacters
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

  describe('calculateAudioBill', () => {
    it('returns 0 for zero, negative or invalid durations', () => {
      assert.strictEqual(calculateAudioBill(0), 0);
      assert.strictEqual(calculateAudioBill(-10), 0);
      assert.strictEqual(calculateAudioBill(null), 0);
      assert.strictEqual(calculateAudioBill(undefined), 0);
      assert.strictEqual(calculateAudioBill('invalid'), 0);
    });

    it('charges 1 minute (50 Taka) for durations up to 1:08 (68 seconds)', () => {
      assert.strictEqual(calculateAudioBill(1), 50);
      assert.strictEqual(calculateAudioBill(30), 50);
      assert.strictEqual(calculateAudioBill(60), 50); // 1:00
      assert.strictEqual(calculateAudioBill(68), 50); // 1:08
      assert.strictEqual(calculateAudioBill(68.4), 50); // rounds to 68s
    });

    it('charges 1.5 minutes (75 Taka) for durations from 1:09 to 1:19 (69s to 79s)', () => {
      assert.strictEqual(calculateAudioBill(69), 75); // 1:09
      assert.strictEqual(calculateAudioBill(70), 75); // 1:10
      assert.strictEqual(calculateAudioBill(75), 75); // 1:15
      assert.strictEqual(calculateAudioBill(79), 75); // 1:19
    });

    it('charges 2 minutes (100 Taka) for durations from 1:20 to 2:08 (80s to 128s)', () => {
      assert.strictEqual(calculateAudioBill(80), 100); // 1:20
      assert.strictEqual(calculateAudioBill(90), 100); // 1:30
      assert.strictEqual(calculateAudioBill(119), 100); // 1:59
      assert.strictEqual(calculateAudioBill(120), 100); // 2:00
      assert.strictEqual(calculateAudioBill(128), 100); // 2:08
    });

    it('charges subsequent tiered ranges correctly', () => {
      // 2:09 to 2:19 -> 2.5 minutes (125 Taka)
      assert.strictEqual(calculateAudioBill(129), 125);
      assert.strictEqual(calculateAudioBill(135), 125);
      assert.strictEqual(calculateAudioBill(139), 125);

      // 2:20 to 3:08 -> 3 minutes (150 Taka)
      assert.strictEqual(calculateAudioBill(140), 150);
      assert.strictEqual(calculateAudioBill(180), 150);
      assert.strictEqual(calculateAudioBill(188), 150);

      // 3:09 to 3:19 -> 3.5 minutes (175 Taka)
      assert.strictEqual(calculateAudioBill(189), 175);
      assert.strictEqual(calculateAudioBill(199), 175);

      // 3:20 to 4:08 -> 4 minutes (200 Taka)
      assert.strictEqual(calculateAudioBill(200), 200);
      assert.strictEqual(calculateAudioBill(248), 200);
    });

    it('supports custom rate per minute', () => {
      assert.strictEqual(calculateAudioBill(60, 60), 60);
      assert.strictEqual(calculateAudioBill(70, 60), 90); // 1.5 * 60 = 90
      assert.strictEqual(calculateAudioBill(80, 60), 120); // 2 * 60 = 120
    });
  });

  describe('formatBillMessage', () => {
    it('formats bill message into Bengali string "বিল <সংখ্যা> টাকা"', () => {
      assert.strictEqual(formatBillMessage(50), 'বিল ৫০ টাকা');
      assert.strictEqual(formatBillMessage(75), 'বিল ৭৫ টাকা');
      assert.strictEqual(formatBillMessage(100), 'বিল ১০০ টাকা');
      assert.strictEqual(formatBillMessage(125), 'বিল ১২৫ টাকা');
      assert.strictEqual(formatBillMessage(150), 'বিল ১৫০ টাকা');
    });

    it('returns null for invalid amount', () => {
      assert.strictEqual(formatBillMessage(null), null);
      assert.strictEqual(formatBillMessage(undefined), null);
      assert.strictEqual(formatBillMessage(NaN), null);
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

    it('returns true for real whatsapp-web.js Message with filename and mimetype in _data', () => {
      const msg = {
        hasMedia: true,
        type: 'document',
        isVoice: false,
        _data: {
          mimetype: 'audio/mpeg',
          filename: 'voice.mp3'
        }
      };
      assert.strictEqual(isAudioDocumentMessage(msg), true);
    });

    it('returns false for playable audio (type: audio, e.g. welcome sequence preview)', () => {
      const msg = {
        hasMedia: true,
        type: 'audio',
        isVoice: false,
        _data: {
          type: 'audio',
          mimetype: 'audio/ogg; codecs=opus'
        }
      };
      assert.strictEqual(isAudioDocumentMessage(msg), false);
    });

    it('returns true for audio documents with m4a, wav, aac, flac in _data', () => {
      const m4aMsg = {
        hasMedia: true,
        type: 'document',
        _data: {
          filename: 'news_report.m4a',
          mimetype: 'audio/mp4'
        }
      };
      assert.strictEqual(isAudioDocumentMessage(m4aMsg), true);
    });

    it('returns false for voice note with isVoice: true in _data', () => {
      const pttMsg = {
        hasMedia: true,
        type: 'audio',
        _data: {
          isVoice: true,
          type: 'ptt',
          mimetype: 'audio/ogg; codecs=opus'
        }
      };
      assert.strictEqual(isAudioDocumentMessage(pttMsg), false);
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

  describe('resolveAudioDuration', () => {
    const { resolveAudioDuration } = require('../src/audio');

    it('resolves duration immediately from msg.duration', async () => {
      const msg = { duration: '135' };
      const duration = await resolveAudioDuration({ msg });
      assert.strictEqual(duration, 135);
    });

    it('resolves duration immediately from msg._data.duration', async () => {
      const msg = { _data: { duration: 42 } };
      const duration = await resolveAudioDuration({ msg });
      assert.strictEqual(duration, 42);
    });

    it('resolves duration immediately from msg._data.seconds', async () => {
      const msg = { _data: { seconds: 75 } };
      const duration = await resolveAudioDuration({ msg });
      assert.strictEqual(duration, 75);
    });

    it('resolves duration from client.pupPage evaluate when direct property is missing', async () => {
      const msg = { id: { _serialized: 'true_1234@c.us_ABC' } };
      const client = {
        pupPage: {
          evaluate: async () => ({ duration: 88 })
        }
      };
      const duration = await resolveAudioDuration({ msg, client });
      assert.strictEqual(duration, 88);
    });

    it('handles downloadMedia throwing "r: r" error gracefully without crashing', async () => {
      const msg = {
        id: { _serialized: 'true_1234@c.us_DEF' },
        downloadMedia: async () => {
          throw new Error('r: r');
        }
      };
      const client = {
        pupPage: {
          evaluate: async () => null
        }
      };
      // Should not throw, returns null after retries
      const duration = await resolveAudioDuration({ msg, client });
      assert.strictEqual(duration, null);
    });

    it('does NOT extract duration from filename numbers like Standard recording 933.wav', async () => {
      const msg = {
        filename: 'Standard recording 933.wav',
        _data: { filename: 'Standard recording 933.wav' }
      };
      const client = {
        pupPage: { evaluate: async () => null }
      };
      const duration = await resolveAudioDuration({ msg, client });
      assert.strictEqual(duration, null, 'Should not extract 933s from filename');
    });

    it('extractDurationFromFilename returns null for all filenames as per user directive', () => {
      const { extractDurationFromFilename } = require('../src/audio');
      assert.strictEqual(extractDurationFromFilename('Standard recording 933.wav'), null);
      assert.strictEqual(extractDurationFromFilename('Audio 934.mp3'), null);
      assert.strictEqual(extractDurationFromFilename('(1m 23s).wav'), null);
    });
  });

  describe('getAudioDurationWithFFprobe', () => {
    const { getAudioDurationWithFFprobe } = require('../src/audio');

    it('extracts duration from WAV buffer using ffprobe binary', async () => {
      const sampleRate = 8000;
      const numChannels = 1;
      const bitsPerSample = 8;
      const dataSize = 2 * sampleRate * numChannels * (bitsPerSample / 8);
      const buffer = Buffer.alloc(44 + dataSize);
      buffer.write('RIFF', 0);
      buffer.writeUInt32LE(36 + dataSize, 4);
      buffer.write('WAVE', 8);
      buffer.write('fmt ', 12);
      buffer.writeUInt32LE(16, 16);
      buffer.writeUInt16LE(1, 20);
      buffer.writeUInt16LE(numChannels, 22);
      buffer.writeUInt32LE(sampleRate, 24);
      buffer.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
      buffer.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
      buffer.writeUInt16LE(bitsPerSample, 34);
      buffer.write('data', 36);
      buffer.writeUInt32LE(dataSize, 40);

      const duration = await getAudioDurationWithFFprobe(buffer, '.wav');
      assert.ok(duration !== null);
      assert.strictEqual(Math.round(duration), 2);
    });
  });

  describe('Headline & Filename Formatting', () => {
    describe('extractHeadline', () => {
      it('extracts 3-5 words from first line of multi-line script', () => {
        const script = 'নবাবপুর ফুড সিটি নিয়ে এলো বিশেষ অফার\nদ্বিতীয় লাইন এখানে\nতৃতীয় লাইন এখানে';
        assert.strictEqual(extractHeadline(script), 'নবাবপুর ফুড সিটি নিয়ে এলো');
        assert.strictEqual(extractHeadline(script, 3), 'নবাবপুর ফুড সিটি');

        const shortLineScript = 'নবাবপুর ফুড সিটি\nএখানে যাবতীয় খাবারের আয়োজন আছে';
        assert.strictEqual(extractHeadline(shortLineScript), 'নবাবপুর ফুড সিটি');
      });

      it('strips markdown, emojis, and [নতুন ভয়েস অর্ডার] headers', () => {
        const formattedScript = '[নতুন ভয়েস অর্ডার]\n# *নবাবপুর ফুড সিটি* - সেরা অফার! 🍔🔥\nবিস্তারিত জানতে কল করুন ০১৭১১০০০০০০';
        assert.strictEqual(extractHeadline(formattedScript), 'নবাবপুর ফুড সিটি সেরা অফার');

        const sameLineScript = '[নতুন ভয়েস অর্ডার] _*নবাবপুর ফুড সিটি*_ ~সেরা~ `অফার` 🎉';
        assert.strictEqual(extractHeadline(sameLineScript), 'নবাবপুর ফুড সিটি সেরা অফার');
      });

      it('falls back to "ভয়েস স্ক্রিপ্ট" for empty, null, or non-Bengali text', () => {
        assert.strictEqual(extractHeadline(''), 'ভয়েস স্ক্রিপ্ট');
        assert.strictEqual(extractHeadline(null), 'ভয়েস স্ক্রিপ্ট');
        assert.strictEqual(extractHeadline(undefined), 'ভয়েস স্ক্রিপ্ট');
        assert.strictEqual(extractHeadline('   '), 'ভয়েস স্ক্রিপ্ট');
        assert.strictEqual(extractHeadline('Hello this is a pure English voice script with no Bengali'), 'ভয়েস স্ক্রিপ্ট');
        assert.strictEqual(extractHeadline('12345 67890 !@#$%^&*()'), 'ভয়েস স্ক্রিপ্ট');
      });
    });

    describe('formatDurationForFilename', () => {
      it('under 60s formats as 45s', () => {
        assert.strictEqual(formatDurationForFilename(45), '45s');
        assert.strictEqual(formatDurationForFilename(15), '15s');
        assert.strictEqual(formatDurationForFilename(59), '59s');
        assert.strictEqual(formatDurationForFilename(44.6), '45s');
      });

      it('over 60s formats as 1m 23s', () => {
        assert.strictEqual(formatDurationForFilename(83), '1m 23s');
        assert.strictEqual(formatDurationForFilename(145), '2m 25s');
        assert.strictEqual(formatDurationForFilename(83.2), '1m 23s');
      });

      it('exactly 60s formats as 1m 0s', () => {
        assert.strictEqual(formatDurationForFilename(60), '1m 0s');
        assert.strictEqual(formatDurationForFilename(120), '2m 0s');
        assert.strictEqual(formatDurationForFilename(180), '3m 0s');
      });

      it('zero or invalid formats as 0s', () => {
        assert.strictEqual(formatDurationForFilename(0), '0s');
        assert.strictEqual(formatDurationForFilename(null), '0s');
        assert.strictEqual(formatDurationForFilename(undefined), '0s');
        assert.strictEqual(formatDurationForFilename(NaN), '0s');
        assert.strictEqual(formatDurationForFilename(-10), '0s');
      });
    });

    describe('buildCleanVoiceFilename', () => {
      it('formats full filename e.g. নবাবপুর ফুড সিটি (1m 23s).mp3', () => {
        const filename = buildCleanVoiceFilename({
          headline: 'নবাবপুর ফুড সিটি',
          durationSeconds: 83,
          ext: 'mp3'
        });
        assert.strictEqual(filename, 'নবাবপুর ফুড সিটি (1m 23s).mp3');

        // Defaults ext to mp3
        const filenameDefault = buildCleanVoiceFilename({
          headline: 'নবাবপুর ফুড সিটি',
          durationSeconds: 45
        });
        assert.strictEqual(filenameDefault, 'নবাবপুর ফুড সিটি (45s).mp3');

        // Handles leading dot in ext
        const filenameDot = buildCleanVoiceFilename({
          headline: 'নবাবপুর ফুড সিটি',
          durationSeconds: 60,
          ext: '.wav'
        });
        assert.strictEqual(filenameDot, 'নবাবপুর ফুড সিটি (1m 0s).wav');
      });

      it('sanitizes invalid filename characters like :, /, ?', () => {
        const sanitized = buildCleanVoiceFilename({
          headline: 'নবাবপুর: ফুড / সিটি? * < > | " \r \n',
          durationSeconds: 83,
          ext: 'mp3'
        });
        assert.strictEqual(sanitized, 'নবাবপুর ফুড সিটি (1m 23s).mp3');
      });
    });

    describe('hasBengaliCharacters', () => {
      it('returns true for strings with Bengali characters', () => {
        assert.strictEqual(hasBengaliCharacters('নবাবপুর.mp3'), true);
        assert.strictEqual(hasBengaliCharacters('voice_নবাবপুর_take1.wav'), true);
        assert.strictEqual(hasBengaliCharacters('বাংলা'), true);
      });

      it('returns false for pure English/numeric filenames', () => {
        assert.strictEqual(hasBengaliCharacters('voice1.mp3'), false);
        assert.strictEqual(hasBengaliCharacters('audio_take_2.wav'), false);
        assert.strictEqual(hasBengaliCharacters('12345.mp3'), false);
        assert.strictEqual(hasBengaliCharacters(''), false);
        assert.strictEqual(hasBengaliCharacters(null), false);
        assert.strictEqual(hasBengaliCharacters(undefined), false);
      });
    });
  });
});


