const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Import from src/tts (which does not exist yet -> will fail in RED phase)
const {
  normalizeScriptWithGemini,
  extractVoiceChoiceAndCleanText,
  normalizeAbbreviationsForTts,
  formatBengaliDurationForFilename,
  buildGeneratedVoiceFilename,
  synthesizeCartesiaVoice,
  sanitizeWavHeader,
  extractFormatFromPrefix,
  isGeneratedVoiceGroup,
  handleGeneratedVoiceMessage,
  discoverGeneratedVoiceGroup,
  formatCartesiaDeliveryReport,
  isCartesiaBotSystemMessage,
  recentSentBotTexts,
  sentGeneratedVoiceMsgIds,
  sendGroupReply
} = require('../src/tts');

describe('Cartesia TTS Module - TDD', () => {
  describe('extractVoiceChoiceAndCleanText', () => {
    test('defaults to dalia and preserves text when no prefix is present', () => {
      const text = 'আজকের সিলেট অঞ্চলের আবহাওয়া পরিস্থিতি স্বাভাবিক রয়েছে।';
      const result = extractVoiceChoiceAndCleanText(text);
      assert.equal(result.voice, 'dalia');
      assert.equal(result.cleanText, text);
    });

    test('selects malia and strips Bengali prefix "মালিয়া:" or "মালিয়া:"', () => {
      const text1 = 'মালিয়া: সিলেটের সাম্প্রতিক বন্যা পরিস্থিতি নিয়ে প্রতিবেদন।';
      const result1 = extractVoiceChoiceAndCleanText(text1);
      assert.equal(result1.voice, 'malia');
      assert.equal(result1.cleanText, 'সিলেটের সাম্প্রতিক বন্যা পরিস্থিতি নিয়ে প্রতিবেদন।');

      const text2 = 'মালিয়াঃ কুলাউড়ার সর্বশেষ সংবাদ।';
      const result2 = extractVoiceChoiceAndCleanText(text2);
      assert.equal(result2.voice, 'malia');
      assert.equal(result2.cleanText, 'কুলাউড়ার সর্বশেষ সংবাদ।');
    });

    test('selects malia with English prefix "malia:" (case-insensitive)', () => {
      const text = 'Malia: আজকের শীর্ষ খবর বিস্তারিত।';
      const result = extractVoiceChoiceAndCleanText(text);
      assert.equal(result.voice, 'malia');
      assert.equal(result.cleanText, 'আজকের শীর্ষ খবর বিস্তারিত।');
    });

    test('selects malia with number prefixes: "2:", "২:", "২.", "2.", "[2]", "[২]", "(২)"', () => {
      assert.equal(extractVoiceChoiceAndCleanText('২: সিলেটের খবর').voice, 'malia');
      assert.equal(extractVoiceChoiceAndCleanText('২: সিলেটের খবর').cleanText, 'সিলেটের খবর');
      assert.equal(extractVoiceChoiceAndCleanText('2: সিলেটের খবর').voice, 'malia');
      assert.equal(extractVoiceChoiceAndCleanText('২. সিলেটের খবর').voice, 'malia');
      assert.equal(extractVoiceChoiceAndCleanText('[২] সিলেটের খবর').voice, 'malia');
      assert.equal(extractVoiceChoiceAndCleanText('(2) সিলেটের খবর').voice, 'malia');
      assert.equal(extractVoiceChoiceAndCleanText('মালিয়া - সিলেটের খবর').voice, 'malia');
      assert.equal(extractVoiceChoiceAndCleanText('#malia সিলেটের খবর').voice, 'malia');
    });

    test('selects voice when voice name is alone on first line', () => {
      const scriptWithLine = 'মালিয়া\nসিলেটের বন্যা পরিস্থিতি নিয়ে জরুরি বৈঠক।';
      const res = extractVoiceChoiceAndCleanText(scriptWithLine);
      assert.equal(res.voice, 'malia');
      assert.equal(res.cleanText, 'সিলেটের বন্যা পরিস্থিতি নিয়ে জরুরি বৈঠক।');

      const daliaWithLine = 'দালিয়া\nমৌলভীবাজারের খবর।';
      const resDalia = extractVoiceChoiceAndCleanText(daliaWithLine);
      assert.equal(resDalia.voice, 'dalia');
      assert.equal(resDalia.cleanText, 'মৌলভীবাজারের খবর।');
    });

    test('selects dalia with prefix "দালিয়া:" or "দলিয়া:" or "dalia:" or "১:" or "[1]"', () => {
      const text1 = 'দালিয়া: বিশেষ সংবাদ প্রতিবেদন।';
      const res1 = extractVoiceChoiceAndCleanText(text1);
      assert.equal(res1.voice, 'dalia');
      assert.equal(res1.cleanText, 'বিশেষ সংবাদ প্রতিবেদন।');

      const text2 = 'দলিয়া: আন্তর্জাতিক খবর।';
      const res2 = extractVoiceChoiceAndCleanText(text2);
      assert.equal(res2.voice, 'dalia');
      assert.equal(res2.cleanText, 'আন্তর্জাতিক খবর।');

      const text3 = 'DALIA: খেলাধুলার সংবাদ।';
      const res3 = extractVoiceChoiceAndCleanText(text3);
      assert.equal(res3.voice, 'dalia');
      assert.equal(res3.cleanText, 'খেলাধুলার সংবাদ।');

      assert.equal(extractVoiceChoiceAndCleanText('১: সিলেটের খবর').voice, 'dalia');
      assert.equal(extractVoiceChoiceAndCleanText('[1] সিলেটের খবর').voice, 'dalia');
    });

    test('respects custom defaultVoice parameter when no voice tag is provided', () => {
      const text = 'আজকের সাধারণ সংবাদ প্রতিবেদন।';
      const res = extractVoiceChoiceAndCleanText(text, 'malia');
      assert.equal(res.voice, 'malia');
      assert.equal(res.cleanText, text);
    });

    test('does not misidentify regular sentence words as voice tags', () => {
      const text = 'দালিয়া নামের এক নারী নদীতে নিখোঁজ হয়েছেন।';
      const res = extractVoiceChoiceAndCleanText(text, 'dalia');
      assert.equal(res.voice, 'dalia');
      assert.equal(res.cleanText, text);
    });

    test('preserves clean text without applying hardcoded regex replacements', () => {
      const text1 = 'ম: রফিকুল ইসলাম জানিয়েছেন পরিস্থিতি শান্ত রয়েছে।';
      const res1 = extractVoiceChoiceAndCleanText(text1);
      assert.equal(res1.cleanText, text1);

      const text2 = 'মালিয়া: ম. মিজানুর রহমান উপস্থিত ছিলেন।';
      const res2 = extractVoiceChoiceAndCleanText(text2);
      assert.equal(res2.voice, 'malia');
      assert.equal(res2.cleanText, 'ম. মিজানুর রহমান উপস্থিত ছিলেন।');

      const text3 = 'মো\u200cঃ কৃষ্ণ আক্তার';
      const res3 = extractVoiceChoiceAndCleanText(text3);
      assert.equal(res3.cleanText, 'মো\u200cঃ কৃষ্ণ আক্তার');
    });
  });

  describe('normalizeScriptWithGemini', () => {
    test('sends news script to Gemini flash-lite with prompt and returns normalized text', async () => {
      let capturedPayload = null;
      let capturedUrl = null;
      const mockFetch = async (url, options) => {
        capturedUrl = url;
        capturedPayload = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: 'মোহাম্মদ রফিক জানিয়েছেন, সত্তোর শতাংশ মানুষ উপস্থিত ছিলেন।'
                    }
                  ]
                }
              }
            ]
          })
        };
      };

      const input = 'ম. রফিক জানিয়েছেন ৭০ শতাংশ মানুষ উপস্থিত ছিলেন';
      const result = await normalizeScriptWithGemini(input, {
        apiKey: 'test-key',
        fetchFn: mockFetch
      });

      assert.equal(result, 'মোহাম্মদ রফিক জানিয়েছেন, সত্তোর শতাংশ মানুষ উপস্থিত ছিলেন।');
      assert.ok(capturedUrl.includes('gemini-flash-lite-latest'));
      assert.ok(capturedUrl.includes('key=test-key'));
      assert.ok(capturedPayload.contents[0].parts[0].text.includes('নিচের নিউজ স্ক্রিপ্ট টিতে-'));
      assert.ok(capturedPayload.contents[0].parts[0].text.includes('(১) সঠিকভাবে যতিচিহ্ন এপ্লাই করো'));
      assert.ok(capturedPayload.contents[0].parts[0].text.includes('(৪) \'৭০\' বা \'সত্তর\' কে \'সত্তোর\' দিয়ে রিপ্লেস করো'));
      assert.ok(capturedPayload.contents[0].parts[0].text.includes('(৫) \'ম:\' বা \'ম.\' কে \'মোহাম্মদ\' দিয়ে রিপ্লেস করো'));
      assert.ok(capturedPayload.contents[0].parts[0].text.includes('STRICT OUTPUT RULES'));
    });

    test('strips markdown code fences if returned by Gemini', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: '```markdown\nআজকের শীর্ষ সংবাদ।\n```' }]
              }
            }
          ]
        })
      });

      const res = await normalizeScriptWithGemini('আজকের শীর্ষ সংবাদ', {
        apiKey: 'test-key',
        fetchFn: mockFetch
      });
      assert.equal(res, 'আজকের শীর্ষ সংবাদ।');
    });

    test('strips conversational prelude if returned by Gemini', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: 'সংশোধিত স্ক্রিপ্ট: মোহাম্মদ আলী আজকের অনুষ্ঠানে প্রধান অতিথি হিসেবে যোগ দেন।' }]
              }
            }
          ]
        })
      });

      const res = await normalizeScriptWithGemini('ম. আলী আজকের অনুষ্ঠানে প্রধান অতিথি হিসেবে যোগ দেন', {
        apiKey: 'test-key',
        fetchFn: mockFetch
      });
      assert.equal(res, 'মোহাম্মদ আলী আজকের অনুষ্ঠানে প্রধান অতিথি হিসেবে যোগ দেন।');
    });

    test('gracefully falls back to original script on API error (503/429/network)', async () => {
      const mockFetch = async () => ({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable'
      });

      const original = 'মূল স্ক্রিপ্ট যা অক্ষুণ্ণ থাকবে';
      const res = await normalizeScriptWithGemini(original, {
        apiKey: 'test-key',
        fetchFn: mockFetch
      });
      assert.equal(res, original);
    });

    test('gracefully falls back to original script when apiKey is missing', async () => {
      const original = 'কোনো এপিআই কি নেই';
      const res = await normalizeScriptWithGemini(original, { apiKey: '' });
      assert.equal(res, original);
    });
  });

  describe('normalizeAbbreviationsForTts (legacy passthrough)', () => {
    test('returns clean trimmed text without hardcoded regex modifications', () => {
      assert.equal(normalizeAbbreviationsForTts('  ম: রফিক আহমেদ  '), 'ম: রফিক আহমেদ');
      assert.equal(normalizeAbbreviationsForTts('ম. রফিক আহমেদ'), 'ম. রফিক আহমেদ');
      assert.equal(normalizeAbbreviationsForTts(''), '');
    });
  });

  describe('formatBengaliDurationForFilename', () => {
    test('formats seconds into Bengali M.SS correctly', () => {
      assert.equal(formatBengaliDurationForFilename(75), '১.১৫');
      assert.equal(formatBengaliDurationForFilename(64), '১.০৪');
      assert.equal(formatBengaliDurationForFilename(45), '০.৪৫');
      assert.equal(formatBengaliDurationForFilename(130), '২.১০');
      assert.equal(formatBengaliDurationForFilename(0), '০.০০');
    });

    test('handles float and null durations safely', () => {
      assert.equal(formatBengaliDurationForFilename(75.8), '১.১৬');
      assert.equal(formatBengaliDurationForFilename(null), '০.০০');
      assert.equal(formatBengaliDurationForFilename(undefined), '০.০০');
    });
  });

  describe('buildGeneratedVoiceFilename', () => {
    test('generates Bengali news headline with Bengali duration and .wav extension', () => {
      const script = 'মৌলভীবাজারের বন্যা পরিস্থিতি নিয়ে স্থানীয় প্রশাসনের সতর্কবার্তা।';
      const filename = buildGeneratedVoiceFilename({
        scriptText: script,
        durationSeconds: 75,
        ext: 'wav'
      });
      // Should match format: "<শিরোনাম> <১.১৫> .wav"
      assert.equal(filename.includes('মৌলভীবাজারের'), true);
      assert.equal(filename.includes('১.১৫'), true);
      assert.equal(filename.endsWith('.wav'), true);
    });

    test('cleans illegal filename characters while preserving Bengali headline', () => {
      const script = 'চট্টগ্রাম বন্দরে/নতুন কন্টেইনার: টার্মিনাল চালু?';
      const filename = buildGeneratedVoiceFilename({
        scriptText: script,
        durationSeconds: 64,
        ext: 'wav'
      });
      assert.equal(/[\\/:*?"<>|]/.test(filename), false);
      assert.equal(filename.includes('১.০৪'), true);
      assert.equal(filename.endsWith('.wav'), true);
    });

    test('restricts Bengali news headline in filename to highest 2 words', () => {
      const script = 'মৌলভীবাজারের বন্যা পরিস্থিতি নিয়ে জরুরি বৈঠক অনুষ্ঠিত।';
      const filename = buildGeneratedVoiceFilename({
        scriptText: script,
        durationSeconds: 75,
        ext: 'wav'
      });
      assert.equal(filename, 'মৌলভীবাজারের বন্যা ১.১৫.wav');
    });

    test('defaults extension to mp3 without space before dot', () => {
      const script = 'মৌলভীবাজারের বন্যা পরিস্থিতি নিয়ে জরুরি বৈঠক।';
      const filename = buildGeneratedVoiceFilename({
        scriptText: script,
        durationSeconds: 75
      });
      assert.equal(filename, 'মৌলভীবাজারের বন্যা ১.১৫.mp3');
    });
  });

  describe('sanitizeWavHeader', () => {
    test('repairs 0xFFFFFFFF chunk sizes in Cartesia streaming WAV headers', () => {
      // Create a mock WAV buffer with 0xFFFFFFFF chunk size and data size
      const totalLen = 1000;
      const buf = Buffer.alloc(totalLen);
      buf.write('RIFF', 0);
      buf.writeUInt32LE(0xFFFFFFFF, 4); // Corrupted Cartesia chunk size
      buf.write('WAVE', 8);
      buf.write('fmt ', 12);
      buf.writeUInt32LE(16, 16);
      buf.write('data', 70);
      buf.writeUInt32LE(0xFFFFFFFF, 74); // Corrupted Cartesia data chunk size

      const sanitized = sanitizeWavHeader(buf);
      assert.equal(sanitized.readUInt32LE(4), totalLen - 8);
      assert.equal(sanitized.readUInt32LE(74), totalLen - (70 + 8));
    });

    test('safely returns non-WAV or short buffers untouched', () => {
      assert.equal(sanitizeWavHeader(null), null);
      const shortBuf = Buffer.from('short');
      assert.equal(sanitizeWavHeader(shortBuf), shortBuf);
      const nonWavBuf = Buffer.alloc(50);
      assert.equal(sanitizeWavHeader(nonWavBuf), nonWavBuf);
    });
  });

  describe('extractFormatFromPrefix', () => {
    test('detects mp3 and wav prefixes and brackets', () => {
      assert.deepEqual(extractFormatFromPrefix('[mp3] সিলেটের খবর'), { format: 'mp3', remaining: 'সিলেটের খবর' });
      assert.deepEqual(extractFormatFromPrefix('(wav) সিলেটের খবর'), { format: 'wav', remaining: 'সিলেটের খবর' });
      assert.deepEqual(extractFormatFromPrefix('mp3: সিলেটের খবর'), { format: 'mp3', remaining: 'সিলেটের খবর' });
      assert.deepEqual(extractFormatFromPrefix('wav: সিলেটের খবর'), { format: 'wav', remaining: 'সিলেটের খবর' });
      assert.deepEqual(extractFormatFromPrefix('format mp3: সিলেটের খবর'), { format: 'mp3', remaining: 'সিলেটের খবর' });
      assert.deepEqual(extractFormatFromPrefix('ফরম্যাট wav: সিলেটের খবর'), { format: 'wav', remaining: 'সিলেটের খবর' });
      assert.deepEqual(extractFormatFromPrefix('আজকের সাধারণ সংবাদ'), { format: null, remaining: 'আজকের সাধারণ সংবাদ' });
    });
  });

  describe('formatCartesiaDeliveryReport', () => {
    test('formats delivery report with voice, duration, char credits, remaining credits and approx minutes', () => {
      const report = formatCartesiaDeliveryReport({
        voice: 'dalia',
        durationSeconds: 75,
        charCount: 945,
        creditsUsed: 945,
        remainingCredits: 482500,
        approxMinutes: 107.2
      });

      assert.ok(report.includes('দালিয়া (Dalia)'));
      assert.ok(report.includes('১.১৫ মিনিট'));
      assert.ok(report.includes('৭৫ সেকেন্ড'));
      assert.ok(report.includes('৯৪৫'));
      assert.ok(report.includes('৪,৮২,৫০০'));
      assert.ok(report.includes('১০৭ মিনিট'));
      assert.ok(report.includes('১ ঘণ্টা ৪৭ মিনিট'));
    });

    test('handles report for minutes less than 60 cleanly', () => {
      const report = formatCartesiaDeliveryReport({
        voice: 'malia',
        durationSeconds: 30,
        charCount: 375,
        creditsUsed: 375,
        remainingCredits: 15000,
        approxMinutes: 20
      });

      assert.ok(report.includes('মালিয়া (Malia)'));
      assert.ok(report.includes('০.৩০ মিনিট'));
      assert.ok(report.includes('২০ মিনিট'));
      assert.ok(!report.includes('ঘণ্টা'));
    });
  });

  describe('synthesizeCartesiaVoice', () => {
    test('throws error if script text is missing or empty', async () => {
      await assert.rejects(
        async () => {
          await synthesizeCartesiaVoice({ scriptText: '' });
        },
        /SCRIPT_EMPTY/
      );
    });

    test('calls Cartesia API with proper parameters and returns mp3 buffer by default', async () => {
      // Mock global fetch
      const originalFetch = global.fetch;
      let requestedUrl = null;
      let requestedOptions = null;

      const dummyMp3Buffer = Buffer.from('MP3_MOCK_DATA');

      global.fetch = async (url, options) => {
        requestedUrl = url;
        requestedOptions = options;
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'audio/mpeg' }),
          arrayBuffer: async () => dummyMp3Buffer.buffer
        };
      };

      try {
        const result = await synthesizeCartesiaVoice({
          scriptText: 'মালিয়া: টেস্ট অডিও স্ক্রিপ্ট।',
          apiKey: 'test_api_key'
        });

        assert.equal(requestedUrl, 'https://api.cartesia.ai/tts/bytes');
        assert.equal(requestedOptions.method, 'POST');
        assert.equal(requestedOptions.headers['X-API-Key'], 'test_api_key');
        assert.equal(requestedOptions.headers['Cartesia-Version'], '2024-06-10');

        const body = JSON.parse(requestedOptions.body);
        assert.equal(body.voice.id, '07febb56-f8ad-48e1-acd0-1ace10d69823'); // Malia ID
        assert.equal(body.transcript, 'টেস্ট অডিও স্ক্রিপ্ট।'); // stripped prefix
        assert.equal(body.output_format.container, 'mp3');
        assert.equal(body.output_format.bitrate, 192000);
        assert.equal(body.language, 'bn');

        assert.ok(Buffer.isBuffer(result.buffer));
        assert.equal(result.voice, 'malia');
        assert.equal(result.format, 'mp3');
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('calls Cartesia API with wav format and sanitizes wav header when requested', async () => {
      const originalFetch = global.fetch;
      let requestedOptions = null;

      // Mock Cartesia WAV response with 0xFFFFFFFF chunk sizes
      const rawWav = Buffer.alloc(100);
      rawWav.write('RIFF', 0);
      rawWav.writeUInt32LE(0xFFFFFFFF, 4);
      rawWav.write('WAVE', 8);
      rawWav.write('fmt ', 12);
      rawWav.write('data', 50);
      rawWav.writeUInt32LE(0xFFFFFFFF, 54);

      global.fetch = async (url, options) => {
        requestedOptions = options;
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'audio/wav' }),
          arrayBuffer: async () => rawWav.buffer
        };
      };

      try {
        const result = await synthesizeCartesiaVoice({
          scriptText: 'wav: মৌলভীবাজারের খবর।',
          apiKey: 'test_api_key'
        });

        const body = JSON.parse(requestedOptions.body);
        assert.equal(body.output_format.container, 'wav');
        assert.equal(result.format, 'wav');
        // Verify WAV header was sanitized
        assert.equal(result.buffer.readUInt32LE(4), rawWav.length - 8);
        assert.equal(result.buffer.readUInt32LE(54), rawWav.length - (50 + 8));
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('isGeneratedVoiceGroup & handleGeneratedVoiceMessage', () => {
    test('isGeneratedVoiceGroup detects "generated voice" group name and common variations', () => {
      assert.equal(isGeneratedVoiceGroup({ name: 'Generated Voice' }), true);
      assert.equal(isGeneratedVoiceGroup({ name: 'Generated voice 2026' }), true);
      assert.equal(isGeneratedVoiceGroup({ formattedTitle: 'generated voice' }), true);
      assert.equal(isGeneratedVoiceGroup({ name: 'Generated Voices' }), true);
      assert.equal(isGeneratedVoiceGroup({ name: 'Generate Voice' }), true);
      assert.equal(isGeneratedVoiceGroup({ name: 'AI Generated Voice' }), true);
      assert.equal(isGeneratedVoiceGroup({ name: 'জেনারেটেড ভয়েস' }), true);
      assert.equal(isGeneratedVoiceGroup({ name: 'জেনারেটেড ভয়েস' }), true);
      assert.equal(isGeneratedVoiceGroup({ name: 'জেনারেট ভয়েস' }), true);
      assert.equal(isGeneratedVoiceGroup({ name: 'ভয়েস জেনারেটর' }), true);
      assert.equal(isGeneratedVoiceGroup({ name: 'ভয়েস জেনারেট' }), true);
      assert.equal(isGeneratedVoiceGroup({ name: 'General Family Group' }), false);
      assert.equal(isGeneratedVoiceGroup({ name: '🎙️ জেনারেটেড ভয়েস 🔊' }), true);
      assert.equal(isGeneratedVoiceGroup({ name: 'জেনারেটেড\u200Dভয়েস' }), true); // with ZWJ
      assert.equal(isGeneratedVoiceGroup({ name: 'ভয়েস জেনারেশন' }), true);
      assert.equal(isGeneratedVoiceGroup(null), false);
    });

    test('ignores non-text or short messages', async () => {
      const chat = { id: { _serialized: '120363001@g.us' }, name: 'Generated Voice', isGroup: true };
      const msgMedia = {
        id: { _serialized: 'm1' },
        type: 'audio',
        body: '',
        getChat: async () => chat
      };
      const res1 = await handleGeneratedVoiceMessage({ msg: msgMedia, client: {} });
      assert.equal(res1.action, 'IGNORED_MEDIA_OR_EMPTY');

      const msgShort = {
        id: { _serialized: 'm2' },
        type: 'chat',
        body: 'ok',
        getChat: async () => chat
      };
      const res2 = await handleGeneratedVoiceMessage({ msg: msgShort, client: {} });
      assert.equal(res2.action, 'IGNORED_SHORT_TEXT');
    });

    test('synthesizes script and sends mp3 document to group chat by default', async () => {
      const groupJid = '1203639999999@g.us';
      const chat = { id: { _serialized: groupJid }, name: 'generated voice', isGroup: true };
      let sentTarget = null;
      let sentMedia = null;
      let sentOptions = null;

      const mockClient = {
        sendMessage: async (target, media, options) => {
          sentTarget = target;
          sentMedia = media;
          sentOptions = options;
          return { id: { _serialized: 'sent-msg-123' } };
        }
      };

      const mockSynthesize = async ({ scriptText }) => {
        return {
          buffer: Buffer.from('MP3_MOCK_DATA'),
          voice: 'dalia',
          voiceId: 'b01f022f-dec6-458c-9b5c-8189a0ffea0b',
          format: 'mp3',
          cleanText: scriptText,
          durationSeconds: 75
        };
      };

      const msg = {
        id: { _serialized: 'script-msg-001', remote: groupJid },
        type: 'chat',
        body: 'সিলেটের বন্যা পরিস্থিতি নিয়ে প্রশাসনের জরুরি বৈঠক অনুষ্ঠিত।',
        from: '8801700000001@c.us',
        to: groupJid,
        getChat: async () => chat
      };

      const res = await handleGeneratedVoiceMessage({
        msg,
        client: mockClient,
        synthesizeFn: mockSynthesize,
        normalizeScriptFn: async (s) => s
      });

      assert.equal(res.action, 'GENERATED_VOICE_SENT');
      assert.equal(sentTarget, groupJid);
      assert.equal(sentOptions.sendMediaAsDocument, true);
      assert.ok(sentOptions.caption);
      assert.ok(sentOptions.caption.includes('কার্তেসিয়া ব্যালেন্স'));
      assert.ok(sentOptions.caption.includes('অবশিষ্ট ক্রেডিট'));
      assert.equal(sentMedia.mimetype, 'audio/mpeg');
      assert.ok(sentMedia.filename.includes('সিলেটের'));
      assert.ok(sentMedia.filename.includes('১.১৫'));
      assert.ok(sentMedia.filename.endsWith('.mp3'));
    });

    test('synthesizes script in wav format when wav prefix is specified', async () => {
      const groupJid = '1203639999999@g.us';
      const chat = { id: { _serialized: groupJid }, name: 'generated voice', isGroup: true };
      let sentMedia = null;

      const mockClient = {
        sendMessage: async (target, media) => {
          sentMedia = media;
          return { id: { _serialized: 'sent-msg-wav' } };
        }
      };

      const mockSynthesize = async ({ scriptText, format }) => {
        return {
          buffer: Buffer.from('RIFF_MOCK_WAV'),
          voice: 'malia',
          format: format || 'wav',
          cleanText: scriptText,
          durationSeconds: 45
        };
      };

      const msg = {
        id: { _serialized: 'script-msg-wav-001', remote: groupJid },
        type: 'chat',
        body: 'wav: সিলেটের বন্যা পরিস্থিতি নিয়ে সংবাদ।',
        from: '8801700000001@c.us',
        to: groupJid,
        getChat: async () => chat
      };

      const res = await handleGeneratedVoiceMessage({
        msg,
        client: mockClient,
        synthesizeFn: mockSynthesize,
        normalizeScriptFn: async (s) => s
      });

      assert.equal(res.action, 'GENERATED_VOICE_SENT');
      assert.equal(res.format, 'wav');
      assert.equal(sentMedia.mimetype, 'audio/wav');
      assert.ok(sentMedia.filename.endsWith('.wav'));
    });

    test('normalizes script with Gemini before synthesizing and sending audio', async () => {
      const groupJid = '1203639999999@g.us';
      const chat = { id: { _serialized: groupJid }, name: 'generated voice', isGroup: true };
      let sentMedia = null;
      let synthesizedText = null;

      const mockClient = {
        sendMessage: async (target, media) => {
          sentMedia = media;
          return { id: { _serialized: 'sent-msg-gemini' } };
        }
      };

      const mockSynthesize = async ({ scriptText }) => {
        synthesizedText = scriptText;
        return {
          buffer: Buffer.from('ID3_MOCK_MP3'),
          voice: 'dalia',
          format: 'mp3',
          cleanText: scriptText,
          durationSeconds: 30
        };
      };

      const mockNormalize = async (raw) => {
        return 'মোহাম্মদ রফিক জানিয়েছেন, সত্তোর শতাংশ মানুষ উপস্থিত ছিলেন।';
      };

      const msg = {
        id: { _serialized: 'script-msg-gemini-001', remote: groupJid },
        type: 'chat',
        body: 'ম. রফিক জানিয়েছেন ৭০ শতাংশ মানুষ উপস্থিত ছিলেন',
        from: '8801700000001@c.us',
        to: groupJid,
        getChat: async () => chat
      };

      const res = await handleGeneratedVoiceMessage({
        msg,
        client: mockClient,
        synthesizeFn: mockSynthesize,
        normalizeScriptFn: mockNormalize
      });

      assert.equal(res.action, 'GENERATED_VOICE_SENT');
      assert.equal(synthesizedText, 'মোহাম্মদ রফিক জানিয়েছেন, সত্তোর শতাংশ মানুষ উপস্থিত ছিলেন।');
    });

    test('handles default voice change command in group chat', async () => {
      const groupJid = '1203639999999@g.us';
      const chat = { id: { _serialized: groupJid }, name: 'generated voice', isGroup: true };
      let sentText = null;

      const mockClient = {
        sendMessage: async (target, text) => {
          sentText = text;
          return { id: { _serialized: 'cmd-reply-01' } };
        }
      };

      const msg = {
        id: { _serialized: 'cmd-01', remote: groupJid },
        type: 'chat',
        body: 'ভয়েস মালিয়া',
        getChat: async () => chat
      };

      const res = await handleGeneratedVoiceMessage({ msg, client: mockClient });
      assert.equal(res.action, 'DEFAULT_VOICE_CHANGED');
      assert.equal(res.voice, 'malia');
      assert.ok(sentText.includes('মালিয়া'));
    });

    test('handles speed change and check commands in group chat', async () => {
      const groupJid = '1203639999999@g.us';
      const chat = { id: { _serialized: groupJid }, name: 'generated voice', isGroup: true };
      let sentText = null;

      const mockClient = {
        sendMessage: async (target, text) => {
          sentText = text;
          return { id: { _serialized: 'speed-reply-01' } };
        }
      };

      // 1. Set speed with English digits "speed 1.1"
      const setSpeedMsg = {
        id: { _serialized: 'speed-01', remote: groupJid },
        type: 'chat',
        body: 'speed 1.1',
        getChat: async () => chat
      };
      const resSet = await handleGeneratedVoiceMessage({ msg: setSpeedMsg, client: mockClient });
      assert.equal(resSet.action, 'DEFAULT_SPEED_CHANGED');
      assert.equal(resSet.speed, 1.1);
      assert.ok(sentText.includes('১.১x'));

      // 2. Set speed with Bengali digits "স্পিড ১.২"
      const setSpeedBnMsg = {
        id: { _serialized: 'speed-02', remote: groupJid },
        type: 'chat',
        body: 'স্পিড ১.২',
        getChat: async () => chat
      };
      const resSetBn = await handleGeneratedVoiceMessage({ msg: setSpeedBnMsg, client: mockClient });
      assert.equal(resSetBn.action, 'DEFAULT_SPEED_CHANGED');
      assert.equal(resSetBn.speed, 1.2);
      assert.ok(sentText.includes('১.২x'));

      // 3. Clamping speed outside 0.6 - 1.5 range
      const clampMsg = {
        id: { _serialized: 'speed-03', remote: groupJid },
        type: 'chat',
        body: 'speed 2.5',
        getChat: async () => chat
      };
      const resClamp = await handleGeneratedVoiceMessage({ msg: clampMsg, client: mockClient });
      assert.equal(resClamp.action, 'DEFAULT_SPEED_CHANGED');
      assert.equal(resClamp.speed, 1.5);

      // 4. Check current speed "speed"
      const checkSpeedMsg = {
        id: { _serialized: 'speed-04', remote: groupJid },
        type: 'chat',
        body: 'speed',
        getChat: async () => chat
      };
      const resCheck = await handleGeneratedVoiceMessage({ msg: checkSpeedMsg, client: mockClient });
      assert.equal(resCheck.action, 'SPEED_STATUS_SENT');
      assert.ok(sentText.includes('স্পিড'));
    });

    test('supports per-script speed override and passes speed to synthesis', async () => {
      const groupJid = '1203639999999@g.us';
      const chat = { id: { _serialized: groupJid }, name: 'generated voice', isGroup: true };
      let synthSpeed = null;

      const mockClient = {
        sendMessage: async () => ({ id: { _serialized: 'sent-1' } })
      };

      const mockSynth = async ({ scriptText, voice, speed }) => {
        synthSpeed = speed;
        return {
          buffer: Buffer.from('RIFF_WAV'),
          voice: voice || 'dalia',
          cleanText: scriptText,
          durationSeconds: 40
        };
      };

      const msg = {
        id: { _serialized: 'script-speed-01', remote: groupJid },
        type: 'chat',
        body: '১.১৫x: সিলেটের সাম্প্রতিক আবহাওয়া আপডেট।',
        getChat: async () => chat
      };

      const res = await handleGeneratedVoiceMessage({
        msg,
        client: mockClient,
        synthesizeFn: mockSynth,
        normalizeScriptFn: async (s) => s
      });

      assert.equal(res.action, 'GENERATED_VOICE_SENT');
      assert.equal(synthSpeed, 1.15);
      assert.equal(res.speed, 1.15);
    });

    test('handles audio format change and check commands in group chat', async () => {
      const groupJid = '1203639999999@g.us';
      const chat = { id: { _serialized: groupJid }, name: 'generated voice', isGroup: true };
      let sentText = null;

      const mockClient = {
        sendMessage: async (target, text) => {
          sentText = text;
          return { id: { _serialized: 'fmt-reply-01' } };
        }
      };

      // 1. Change format to wav: "format wav"
      const setWavMsg = {
        id: { _serialized: 'fmt-01', remote: groupJid },
        type: 'chat',
        body: 'format wav',
        getChat: async () => chat
      };
      const resWav = await handleGeneratedVoiceMessage({ msg: setWavMsg, client: mockClient });
      assert.equal(resWav.action, 'DEFAULT_FORMAT_CHANGED');
      assert.equal(resWav.format, 'wav');
      assert.ok(sentText.includes('WAV'));

      // 2. Change format to mp3: "format mp3"
      const setMp3Msg = {
        id: { _serialized: 'fmt-02', remote: groupJid },
        type: 'chat',
        body: 'format mp3',
        getChat: async () => chat
      };
      const resMp3 = await handleGeneratedVoiceMessage({ msg: setMp3Msg, client: mockClient });
      assert.equal(resMp3.action, 'DEFAULT_FORMAT_CHANGED');
      assert.equal(resMp3.format, 'mp3');
      assert.ok(sentText.includes('MP3'));

      // 3. Check current format: "format"
      const checkFmtMsg = {
        id: { _serialized: 'fmt-03', remote: groupJid },
        type: 'chat',
        body: 'format',
        getChat: async () => chat
      };
      const resCheck = await handleGeneratedVoiceMessage({ msg: checkFmtMsg, client: mockClient });
      assert.equal(resCheck.action, 'FORMAT_STATUS_SENT');
      assert.ok(sentText.includes('ফরম্যাট'));
    });

    test('handles voice guide/help command in group chat', async () => {
      const groupJid = '1203639999999@g.us';
      const chat = { id: { _serialized: groupJid }, name: 'generated voice', isGroup: true };
      let sentText = null;

      const mockClient = {
        sendMessage: async (target, text) => {
          sentText = text;
          return { id: { _serialized: 'help-reply-01' } };
        }
      };

      const msg = {
        id: { _serialized: 'help-01', remote: groupJid },
        type: 'chat',
        body: '/voice',
        getChat: async () => chat
      };

      const res = await handleGeneratedVoiceMessage({ msg, client: mockClient });
      assert.equal(res.action, 'VOICE_HELP_SENT');
      assert.ok(sentText.includes('দালিয়া (Dalia)'));
      assert.ok(sentText.includes('মালিয়া (Malia)'));
    });

    test('handles credits balance check and credits set commands in group chat', async () => {
      const groupJid = '1203639999999@g.us';
      const chat = { id: { _serialized: groupJid }, name: 'generated voice', isGroup: true };
      let sentText = null;

      const mockClient = {
        sendMessage: async (target, text) => {
          sentText = text;
          return { id: { _serialized: 'credit-reply-01' } };
        }
      };

      // 1. Check credits
      const checkMsg = {
        id: { _serialized: 'check-01', remote: groupJid },
        type: 'chat',
        body: 'credits',
        getChat: async () => chat
      };
      const resCheck = await handleGeneratedVoiceMessage({ msg: checkMsg, client: mockClient });
      assert.equal(resCheck.action, 'CREDITS_REPORT_SENT');
      assert.ok(sentText.includes('কার্তেসিয়া ব্যালেন্স'));

      // 2. Set credits
      const setMsg = {
        id: { _serialized: 'set-01', remote: groupJid },
        type: 'chat',
        body: 'credits 450000',
        getChat: async () => chat
      };
      const resSet = await handleGeneratedVoiceMessage({ msg: setMsg, client: mockClient });
      assert.equal(resSet.action, 'CREDITS_UPDATED');
      assert.equal(resSet.newCredits, 450000);
      assert.ok(sentText.includes('৪,৫০,০০০'));
    });

    test('recovers and resolves generated voice group when msg.getChat throws error r', async () => {
      const groupJid = '1203638888888@g.us';
      let sentTarget = null;
      const mockClient = {
        pupPage: {
          evaluate: async () => 'Generated Voice'
        },
        sendMessage: async (target, media, options) => {
          sentTarget = target;
          return { id: { _serialized: 'sent-msg-456' } };
        }
      };

      const mockSynthesize = async ({ scriptText }) => {
        return {
          buffer: Buffer.from('RIFF_MOCK_WAV'),
          voice: 'dalia',
          voiceId: 'b01f022f-dec6-458c-9b5c-8189a0ffea0b',
          cleanText: scriptText,
          durationSeconds: 30
        };
      };

      const msg = {
        id: { _serialized: 'script-msg-r-001', remote: groupJid },
        type: 'chat',
        body: 'চট্টগ্রাম বন্দরে কনটেইনার জট নিরসনে নতুন সিদ্ধান্ত গ্রহণ।',
        from: '8801700000003@c.us',
        to: groupJid,
        getChat: async () => {
          throw new Error('r');
        }
      };

      const res = await handleGeneratedVoiceMessage({
        msg,
        client: mockClient,
        synthesizeFn: mockSynthesize,
        normalizeScriptFn: async (s) => s
      });

      assert.equal(res.action, 'GENERATED_VOICE_SENT');
      assert.equal(sentTarget, groupJid);
    });

    test('discoverGeneratedVoiceGroup auto-discovers groups in memory and via getChats()', async () => {
      const mockClient = {
        pupPage: {
          evaluate: async () => [
            { jid: '120363111222@g.us', name: 'জেনারেটেড ভয়েস' }
          ]
        },
        getChats: async () => [
          { isGroup: true, id: { _serialized: '120363333444@g.us' }, name: 'Generated Voice Team' },
          { isGroup: true, id: { _serialized: '120363555666@g.us' }, name: 'Random Group' }
        ]
      };

      const discovered = await discoverGeneratedVoiceGroup(mockClient);
      assert.ok(discovered.includes('120363111222@g.us'));
      assert.ok(discovered.includes('120363333444@g.us'));
      assert.ok(!discovered.includes('120363555666@g.us'));
    });

    test('isCartesiaBotSystemMessage identifies bot outputs and does not false-positive normal news scripts', () => {
      const deliveryCaption = formatCartesiaDeliveryReport({
        voice: 'malia',
        speed: 1.15,
        durationSeconds: 45,
        charCount: 200,
        remainingCredits: 400000,
        approxMinutes: 533
      });
      assert.equal(isCartesiaBotSystemMessage(deliveryCaption), true);

      const helpMsg = `🎙️ *কার্তেসিয়া এআই ভয়েস কমান্ড গাইড:*
• ডিফল্ট পরিবর্তন করতে: \`/voice malia\`
• সরাসরি যেকোনো সাধারণ স্ক্রিপ্ট পাঠালে`;
      assert.equal(isCartesiaBotSystemMessage(helpMsg), true);

      assert.equal(isCartesiaBotSystemMessage('✅ গ্রুপের ডিফল্ট ভয়েস পরিবর্তন করা হয়েছে: *মালিয়া (Malia)*\nএখন থেকে সরাসরি যেকোনো স্ক্রিপ্ট পাঠালে মালিয়ার কণ্ঠে ভয়েস তৈরি হবে।'), true);
      assert.equal(isCartesiaBotSystemMessage('⚡ কার্তেসিয়া ভয়েস স্পিড আপডেট করা হয়েছে: *১.১৫x (1.15x)*\nএখন থেকে সরাসরি যেকোনো স্ক্রিপ্ট পাঠালে এই স্পিডে ভয়েস তৈরি হবে।'), true);
      assert.equal(isCartesiaBotSystemMessage('⚡ *কার্তেসিয়া ভয়েস স্পিড স্ট্যাটাস:*\n• বর্তমান ডিফল্ট স্পিড: *১.০x (1x)*\n• অনুমোদিত রেঞ্জ: ০.৬x থেকে ১.৫x'), true);
      assert.equal(isCartesiaBotSystemMessage('📊 *কার্তেসিয়া ব্যালেন্স রিপোর্ট:*\n• অবশিষ্ট ক্রেডিট: ৪,৫০,০০০\n• আনুমানিক বাকি সময়: ~৬০০ মিনিট (বাংলা সংবাদ স্ক্রিপ্ট)'), true);
      assert.equal(isCartesiaBotSystemMessage('✅ কার্তেসিয়া ক্রেডিট ব্যালেন্স আপডেট করা হয়েছে!\n• নতুন ব্যালেন্স: ৪,৫০,০০০ ক্রেডিট'), true);

      // Normal Bengali news scripts should return false
      assert.equal(isCartesiaBotSystemMessage('মৌলভীবাজারের জুড়ী নদীতে আকস্মিক পানি বৃদ্ধি পেয়ে নিম্নাঞ্চল প্লাবিত হয়েছে।'), false);
      assert.equal(isCartesiaBotSystemMessage('২: সিলেটে বন্যা পরিস্থিতি নিয়ে প্রশাসনের জরুরি বৈঠক অনুষ্ঠিত।'), false);
      assert.equal(isCartesiaBotSystemMessage('১.১৫x: চট্টগ্রাম বন্দরে কনটেইনার জট নিরসনে নতুন উদ্যোগ।'), false);
      assert.equal(isCartesiaBotSystemMessage(null), false);
      assert.equal(isCartesiaBotSystemMessage(''), false);
    });

    test('handleGeneratedVoiceMessage rejects bot system messages and captions from synthesizing voice', async () => {
      const groupJid = '1203639999999@g.us';
      const chat = { id: { _serialized: groupJid }, name: 'generated voice', isGroup: true };
      let synthCalled = false;
      const mockSynthesize = async () => {
        synthCalled = true;
        return { buffer: Buffer.from('RIFF'), voice: 'dalia', durationSeconds: 10, cleanText: 'test' };
      };

      const captionMsg = {
        id: { _serialized: 'bot-caption-01', remote: groupJid },
        type: 'chat',
        body: formatCartesiaDeliveryReport({ voice: 'malia', durationSeconds: 20, remainingCredits: 500000 }),
        fromMe: true,
        getChat: async () => chat
      };

      const resCaption = await handleGeneratedVoiceMessage({
        msg: captionMsg,
        client: {},
        synthesizeFn: mockSynthesize
      });
      assert.equal(resCaption.action, 'IGNORED_BOT_SYSTEM_MESSAGE');
      assert.equal(synthCalled, false);

      const helpMsg = {
        id: { _serialized: 'bot-help-01', remote: groupJid },
        type: 'chat',
        body: '🎙️ *কার্তেসিয়া এআই ভয়েস কমান্ড গাইড:*\n• ডিফল্ট পরিবর্তন করতে:\n• সরাসরি যেকোনো সাধারণ স্ক্রিপ্ট পাঠালে',
        fromMe: true,
        getChat: async () => chat
      };

      const resHelp = await handleGeneratedVoiceMessage({
        msg: helpMsg,
        client: {},
        synthesizeFn: mockSynthesize
      });
      assert.equal(resHelp.action, 'IGNORED_BOT_SYSTEM_MESSAGE');
      assert.equal(synthCalled, false);

      const switchMsg = {
        id: { _serialized: 'bot-switch-01', remote: groupJid },
        type: 'chat',
        body: '✅ গ্রুপের ডিফল্ট ভয়েস পরিবর্তন করা হয়েছে: *মালিয়া (Malia)*\nএখন থেকে সরাসরি যেকোনো স্ক্রিপ্ট পাঠালে মালিয়ার কণ্ঠে ভয়েস তৈরি হবে।',
        fromMe: true,
        getChat: async () => chat
      };

      const resSwitch = await handleGeneratedVoiceMessage({
        msg: switchMsg,
        client: {},
        synthesizeFn: mockSynthesize
      });
      assert.equal(resSwitch.action, 'IGNORED_BOT_SYSTEM_MESSAGE');
      assert.equal(synthCalled, false);
    });

    test('handleGeneratedVoiceMessage rejects recently sent bot texts (race condition prevention)', async () => {
      const groupJid = '1203639999999@g.us';
      const chat = { id: { _serialized: groupJid }, name: 'generated voice', isGroup: true };
      const uniqueText = 'কিছুক্ষণের মধ্যে টেস্ট বট রিপ্লাই পাঠানো সম্পন্ন হবে।';
      recentSentBotTexts.add(uniqueText);

      const echoMsg = {
        id: { _serialized: 'some-outgoing-msg-999', remote: groupJid },
        type: 'chat',
        body: uniqueText,
        fromMe: true,
        getChat: async () => chat
      };

      let synthCalled = false;
      const res = await handleGeneratedVoiceMessage({
        msg: echoMsg,
        client: {},
        synthesizeFn: async () => { synthCalled = true; }
      });

      assert.equal(res.action, 'IGNORED_SELF_ECHO');
      assert.equal(synthCalled, false);
      recentSentBotTexts.delete(uniqueText);
    });

    test('handleGeneratedVoiceMessage rejects messages with hasMedia: true even if type is chat', async () => {
      const groupJid = '1203639999999@g.us';
      const chat = { id: { _serialized: groupJid }, name: 'generated voice', isGroup: true };

      const mediaMsg = {
        id: { _serialized: 'media-doc-with-caption', remote: groupJid },
        type: 'chat',
        hasMedia: true,
        body: 'সিলেটের বন্যা পরিস্থিতি নিয়ে জরুরি সংবাদ বুলেটিন।',
        fromMe: true,
        getChat: async () => chat
      };

      const res = await handleGeneratedVoiceMessage({
        msg: mediaMsg,
        client: {}
      });

      assert.equal(res.action, 'IGNORED_MEDIA_OR_EMPTY');
    });
  });
});
