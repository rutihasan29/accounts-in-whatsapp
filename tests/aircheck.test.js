const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../src/config');
const {
  computeKeptSegments,
  spliceAudioWithFFmpeg,
  spliceAudioCuts,
  analyzeVoiceoverWithGemini,
  cleanVoiceoverAudio,
  cleanJsonString,
  DEFAULT_CANDIDATE_CONFIGS
} = require('../src/aircheck');
const { getAudioDurationFromBuffer } = require('../src/audio');

// Helper to create a valid PCM WAV buffer for audio tests
function createWavBuffer(durationSeconds = 2, sampleRate = 8000) {
  const numChannels = 1;
  const bitsPerSample = 8;
  const dataSize = Math.round(durationSeconds * sampleRate * numChannels * (bitsPerSample / 8));
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

  for (let i = 0; i < dataSize; i++) {
    buffer[44 + i] = Math.round(128 + 50 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
  }

  return buffer;
}

describe('AirCheck Engine Module', () => {

  describe('cleanJsonString', () => {
    it('returns regular json string unchanged', () => {
      const json = '{"key": "value"}';
      assert.strictEqual(cleanJsonString(json), '{"key": "value"}');
    });

    it('strips markdown json code fences', () => {
      const fenced = '```json\n{"mistakesAndRetakes": []}\n```';
      assert.strictEqual(cleanJsonString(fenced), '{"mistakesAndRetakes": []}');
    });

    it('strips markdown code fences without language indicator', () => {
      const fenced = '```\n{"overallTranscript": "hello"}\n```';
      assert.strictEqual(cleanJsonString(fenced), '{"overallTranscript": "hello"}');
    });

    it('handles code fence preceded by prose', () => {
      const fenced = 'Here is the output:\n```json\n{"cuts": []}\n```';
      assert.strictEqual(cleanJsonString(fenced), '{"cuts": []}');
    });

    it('handles empty or non-string inputs safely', () => {
      assert.strictEqual(cleanJsonString(''), '');
      assert.strictEqual(cleanJsonString(null), '');
      assert.strictEqual(cleanJsonString(undefined), '');
    });
  });

  describe('computeKeptSegments', () => {
    it('handles single cut in the middle of audio', () => {
      const kept = computeKeptSegments({
        totalDuration: 10,
        cuts: [{ cutStartTime: 3, cutEndTime: 5 }]
      });
      assert.deepStrictEqual(kept, [
        { start: 0, end: 3 },
        { start: 5, end: 10 }
      ]);
    });

    it('handles multiple separate cuts', () => {
      const kept = computeKeptSegments({
        totalDuration: 20,
        cuts: [
          { cutStartTime: 2, cutEndTime: 4 },
          { cutStartTime: 8, cutEndTime: 11 }
        ]
      });
      assert.deepStrictEqual(kept, [
        { start: 0, end: 2 },
        { start: 4, end: 8 },
        { start: 11, end: 20 }
      ]);
    });

    it('merges overlapping cuts', () => {
      const kept = computeKeptSegments({
        totalDuration: 15,
        cuts: [
          { cutStartTime: 3, cutEndTime: 7 },
          { cutStartTime: 5, cutEndTime: 9 }
        ]
      });
      assert.deepStrictEqual(kept, [
        { start: 0, end: 3 },
        { start: 9, end: 15 }
      ]);
    });

    it('handles cut at the beginning', () => {
      const kept = computeKeptSegments({
        totalDuration: 10,
        cuts: [{ cutStartTime: 0, cutEndTime: 4 }]
      });
      assert.deepStrictEqual(kept, [
        { start: 4, end: 10 }
      ]);
    });

    it('handles cut at the end', () => {
      const kept = computeKeptSegments({
        totalDuration: 10,
        cuts: [{ cutStartTime: 6, cutEndTime: 10 }]
      });
      assert.deepStrictEqual(kept, [
        { start: 0, end: 6 }
      ]);
    });

    it('returns whole interval when cuts array is empty', () => {
      const kept = computeKeptSegments({
        totalDuration: 10,
        cuts: []
      });
      assert.deepStrictEqual(kept, [
        { start: 0, end: 10 }
      ]);
    });

    it('ignores invalid cuts where cutEndTime <= cutStartTime', () => {
      const kept = computeKeptSegments({
        totalDuration: 10,
        cuts: [
          { cutStartTime: 5, cutEndTime: 3 },
          { cutStartTime: 4, cutEndTime: 4 }
        ]
      });
      assert.deepStrictEqual(kept, [
        { start: 0, end: 10 }
      ]);
    });

    it('clamps cut boundaries to [0, totalDuration]', () => {
      const kept = computeKeptSegments({
        totalDuration: 10,
        cuts: [{ cutStartTime: -2, cutEndTime: 15 }]
      });
      assert.deepStrictEqual(kept, []);
    });

    it('supports positional arguments computeKeptSegments(duration, cuts)', () => {
      const kept = computeKeptSegments(10, [{ cutStartTime: 2, cutEndTime: 4 }]);
      assert.deepStrictEqual(kept, [
        { start: 0, end: 2 },
        { start: 4, end: 10 }
      ]);
    });

    it('returns empty array when totalDuration <= 0', () => {
      assert.deepStrictEqual(computeKeptSegments({ totalDuration: 0, cuts: [] }), []);
      assert.deepStrictEqual(computeKeptSegments({ totalDuration: -5, cuts: [] }), []);
    });
  });

  describe('analyzeVoiceoverWithGemini', () => {
    it('parses valid cuts from Gemini API response', async () => {
      const mockResult = {
        overallTranscript: 'First sentence. Second sentence with retake.',
        mistakesAndRetakes: [
          {
            cutStartTime: 1.25,
            cutEndTime: 3.5,
            mistakeText: 'wrong clause',
            retakeText: 'corrected clause',
            reason: 'slip of the tongue',
            confidence: 0.95
          }
        ]
      };

      const mockFetch = async (url) => {
        assert.ok(url.includes('gemini-3.8-flash'), 'Uses primary candidate first');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify(mockResult) }]
                }
              }
            ]
          })
        };
      };

      const wavBuffer = createWavBuffer(5);
      const res = await analyzeVoiceoverWithGemini({
        audioBuffer: wavBuffer,
        apiKey: 'test-key',
        fetchFn: mockFetch,
        backoffMs: 1
      });

      assert.strictEqual(res.modelUsed, 'gemini-3.8-flash');
      assert.strictEqual(res.overallTranscript, mockResult.overallTranscript);
      assert.strictEqual(res.mistakesAndRetakes.length, 1);
      assert.strictEqual(res.mistakesAndRetakes[0].cutStartTime, 1.25);
      assert.strictEqual(res.mistakesAndRetakes[0].cutEndTime, 3.5);
    });

    it('strips markdown code fences from response payload', async () => {
      const mockResult = {
        overallTranscript: 'Transcript text',
        mistakesAndRetakes: []
      };

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: '```json\n' + JSON.stringify(mockResult) + '\n```' }]
              }
            }
          ]
        })
      });

      const res = await analyzeVoiceoverWithGemini({
        audioBuffer: Buffer.from('mock-audio'),
        apiKey: 'test-key',
        fetchFn: mockFetch,
        backoffMs: 1
      });

      assert.strictEqual(res.overallTranscript, 'Transcript text');
      assert.deepStrictEqual(res.mistakesAndRetakes, []);
    });

    it('falls back to second candidate when first candidate returns 503', async () => {
      let callCount = 0;
      const requestedModels = [];

      const mockFetch = async (url) => {
        callCount++;
        const modelMatch = url.match(/\/models\/([^:]+):/);
        const model = modelMatch ? modelMatch[1] : '';
        requestedModels.push(model);

        if (model === 'gemini-3.8-flash') {
          return {
            ok: false,
            status: 503,
            text: async () => 'Service Unavailable'
          };
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify({ overallTranscript: 'Done', mistakesAndRetakes: [] }) }]
                }
              }
            ]
          })
        };
      };

      const res = await analyzeVoiceoverWithGemini({
        audioBuffer: Buffer.from('mock-audio'),
        apiKey: 'test-key',
        fetchFn: mockFetch,
        backoffMs: 1
      });

      assert.strictEqual(res.modelUsed, 'gemini-flash-latest');
      assert.ok(requestedModels.includes('gemini-3.8-flash'), 'Attempted gemini-3.8-flash');
      assert.ok(requestedModels.includes('gemini-flash-latest'), 'Cascaded to gemini-flash-latest');
    });

    it('throws error when apiKey is missing', async () => {
      await assert.rejects(
        analyzeVoiceoverWithGemini({
          audioBuffer: Buffer.from('audio'),
          apiKey: '',
          fetchFn: async () => {}
        }),
        /GEMINI_API_KEY is not configured/
      );
    });

    it('uses GEMINI_AUDIO_API_KEY when apiKey is omitted', async () => {
      let passedKey = null;
      const mockFetch = async (url) => {
        const u = new URL(url);
        passedKey = u.searchParams.get('key');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [
                    { text: '{"cuts": []}' }
                  ]
                }
              }
            ]
          })
        };
      };

      const originalAudioKey = config.GEMINI_AUDIO_API_KEY;
      config.GEMINI_AUDIO_API_KEY = 'test-audio-key-override';
      try {
        await analyzeVoiceoverWithGemini({
          audioBuffer: Buffer.from('audio'),
          fetchFn: mockFetch
        });
        assert.strictEqual(passedKey, 'test-audio-key-override');
      } finally {
        config.GEMINI_AUDIO_API_KEY = originalAudioKey;
      }
    });

    it('rotates across multiple GEMINI_AUDIO_API_KEYS on consecutive calls', async () => {
      const keysUsed = [];
      const mockFetch = async (url) => {
        const u = new URL(url);
        keysUsed.push(u.searchParams.get('key'));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: '{"cuts": []}' }] } }]
          })
        };
      };

      const originalKeys = config.GEMINI_AUDIO_API_KEYS;
      const originalKey = config.GEMINI_AUDIO_API_KEY;
      config.GEMINI_AUDIO_API_KEYS = ['account-key-1', 'account-key-2'];
      delete config.GEMINI_AUDIO_API_KEY;

      try {
        await analyzeVoiceoverWithGemini({
          audioBuffer: Buffer.from('audio'),
          fetchFn: mockFetch
        });
        await analyzeVoiceoverWithGemini({
          audioBuffer: Buffer.from('audio'),
          fetchFn: mockFetch
        });
        await analyzeVoiceoverWithGemini({
          audioBuffer: Buffer.from('audio'),
          fetchFn: mockFetch
        });

        assert.deepStrictEqual(keysUsed, ['account-key-1', 'account-key-2', 'account-key-1']);
      } finally {
        config.GEMINI_AUDIO_API_KEYS = originalKeys;
        config.GEMINI_AUDIO_API_KEY = originalKey;
      }
    });

    it('fails over to next key when encountering HTTP 429 quota exhausted', async () => {
      const attemptedKeys = [];
      const mockFetch = async (url) => {
        const u = new URL(url);
        const k = u.searchParams.get('key');
        attemptedKeys.push(k);

        if (k === 'exhausted-key') {
          return {
            ok: false,
            status: 429,
            text: async () => 'RESOURCE_EXHAUSTED: Quota exceeded for account'
          };
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: '{"cuts": []}' }] } }]
          })
        };
      };

      const originalKeys = config.GEMINI_AUDIO_API_KEYS;
      const originalKey = config.GEMINI_AUDIO_API_KEY;
      config.GEMINI_AUDIO_API_KEYS = ['exhausted-key', 'healthy-key'];
      delete config.GEMINI_AUDIO_API_KEY;

      try {
        const res = await analyzeVoiceoverWithGemini({
          audioBuffer: Buffer.from('audio'),
          fetchFn: mockFetch,
          backoffMs: 1
        });

        assert.ok(res);
        assert.ok(attemptedKeys.includes('exhausted-key'), 'Attempted exhausted key');
        assert.ok(attemptedKeys.includes('healthy-key'), 'Rotated to healthy key');
        assert.strictEqual(attemptedKeys[attemptedKeys.length - 1], 'healthy-key');
      } finally {
        config.GEMINI_AUDIO_API_KEYS = originalKeys;
        config.GEMINI_AUDIO_API_KEY = originalKey;
      }
    });

    it('throws error when all models fail', async () => {
      const mockFetch = async () => ({
        ok: false,
        status: 500,
        text: async () => 'Internal Error'
      });

      await assert.rejects(
        analyzeVoiceoverWithGemini({
          audioBuffer: Buffer.from('audio'),
          apiKey: 'key',
          fetchFn: mockFetch,
          backoffMs: 1
        }),
        /All Gemini audio models were temporarily unreachable/
      );
    });
  });

  describe('spliceAudioWithFFmpeg', () => {
    it('creates small WAV, cuts middle slice, and verifies shortened output', async () => {
      const totalSec = 2;
      const wavBuffer = createWavBuffer(totalSec, 8000);
      const tempIn = path.join(os.tmpdir(), `test_splice_in_${Date.now()}.wav`);
      const tempOut = path.join(os.tmpdir(), `test_splice_out_${Date.now()}.wav`);

      try {
        await fs.promises.writeFile(tempIn, wavBuffer);

        // Keep 0.0s - 0.5s and 1.5s - 2.0s (total kept = 1.0 second)
        const keptSegments = [
          { start: 0, end: 0.5 },
          { start: 1.5, end: 2.0 }
        ];

        await spliceAudioWithFFmpeg({
          inputPath: tempIn,
          outputPath: tempOut,
          keptSegments
        });

        assert.ok(fs.existsSync(tempOut), 'Output file should exist');
        const splicedBuffer = await fs.promises.readFile(tempOut);
        assert.ok(splicedBuffer.length > 0, 'Spliced buffer should not be empty');

        const cleanDuration = await getAudioDurationFromBuffer(splicedBuffer, 'audio/wav', 'test.wav');
        assert.ok(cleanDuration !== null, 'Clean duration should be determined');
        // Kept 1 second of audio
        assert.strictEqual(Math.round(cleanDuration), 1);
      } finally {
        try { await fs.promises.unlink(tempIn); } catch {}
        try { await fs.promises.unlink(tempOut); } catch {}
      }
    });

    it('handles single kept segment splice cleanly', async () => {
      const totalSec = 2;
      const wavBuffer = createWavBuffer(totalSec, 8000);
      const tempIn = path.join(os.tmpdir(), `test_single_in_${Date.now()}.wav`);
      const tempOut = path.join(os.tmpdir(), `test_single_out_${Date.now()}.wav`);

      try {
        await fs.promises.writeFile(tempIn, wavBuffer);

        const keptSegments = [{ start: 0.5, end: 1.5 }];
        await spliceAudioWithFFmpeg({
          inputPath: tempIn,
          outputPath: tempOut,
          keptSegments
        });

        assert.ok(fs.existsSync(tempOut));
        const splicedBuffer = await fs.promises.readFile(tempOut);
        const cleanDuration = await getAudioDurationFromBuffer(splicedBuffer, 'audio/wav');
        assert.strictEqual(Math.round(cleanDuration), 1);
      } finally {
        try { await fs.promises.unlink(tempIn); } catch {}
        try { await fs.promises.unlink(tempOut); } catch {}
      }
    });

    it('spliceAudioCuts helper executes splice and returns durationSeconds and cutsApplied', async () => {
      const totalSec = 2;
      const wavBuffer = createWavBuffer(totalSec, 8000);
      const tempIn = path.join(os.tmpdir(), `test_helper_in_${Date.now()}.wav`);
      const tempOut = path.join(os.tmpdir(), `test_helper_out_${Date.now()}.wav`);

      try {
        await fs.promises.writeFile(tempIn, wavBuffer);

        const res = await spliceAudioCuts({
          inputPath: tempIn,
          outputPath: tempOut,
          cuts: [{ cutStartTime: 0.5, cutEndTime: 1.5 }],
          totalDuration: totalSec
        });

        assert.strictEqual(res.cutsApplied, 1);
        assert.strictEqual(Math.round(res.durationSeconds), 1);
        assert.strictEqual(res.outputPath, tempOut);
      } finally {
        try { await fs.promises.unlink(tempIn); } catch {}
        try { await fs.promises.unlink(tempOut); } catch {}
      }
    });
  });

  describe('cleanVoiceoverAudio', () => {
    it('executes end-to-end splice with mock fetch returning cuts', async () => {
      const wavBuffer = createWavBuffer(2, 8000);

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      overallTranscript: 'Broadcast speech',
                      mistakesAndRetakes: [
                        {
                          cutStartTime: 0.5,
                          cutEndTime: 1.5,
                          mistakeText: 'bad take',
                          retakeText: 'good take',
                          reason: 'retake',
                          confidence: 0.99
                        }
                      ]
                    })
                  }
                ]
              }
            }
          ]
        })
      });

      const res = await cleanVoiceoverAudio({
        audioBuffer: wavBuffer,
        filename: 'take1.wav',
        mimeType: 'audio/wav',
        apiKey: 'test-key',
        fetchFn: mockFetch,
        backoffMs: 1
      });

      assert.strictEqual(res.cutsCount, 1);
      assert.strictEqual(res.modelUsed, 'gemini-3.8-flash');
      assert.ok(Buffer.isBuffer(res.cleanBuffer));
      assert.ok(res.cleanBuffer.length > 0);
      assert.strictEqual(Math.round(res.durationSeconds), 1);
    });

    it('returns original audioBuffer directly when no cuts are found', async () => {
      const wavBuffer = createWavBuffer(2, 8000);

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      overallTranscript: 'Clean speech',
                      mistakesAndRetakes: []
                    })
                  }
                ]
              }
            }
          ]
        })
      });

      const res = await cleanVoiceoverAudio({
        audioBuffer: wavBuffer,
        filename: 'take1.wav',
        mimeType: 'audio/wav',
        apiKey: 'test-key',
        fetchFn: mockFetch,
        backoffMs: 1
      });

      assert.strictEqual(res.cutsCount, 0);
      assert.strictEqual(res.cleanBuffer, wavBuffer);
      assert.strictEqual(Math.round(res.durationSeconds), 2);
    });

    it('safely falls back to original audioBuffer when Gemini analysis fails', async () => {
      const wavBuffer = createWavBuffer(2, 8000);

      const mockFetch = async () => ({
        ok: false,
        status: 500,
        text: async () => 'Service error'
      });

      const res = await cleanVoiceoverAudio({
        audioBuffer: wavBuffer,
        filename: 'take1.wav',
        mimeType: 'audio/wav',
        apiKey: 'test-key',
        fetchFn: mockFetch,
        backoffMs: 1
      });

      assert.strictEqual(res.cutsCount, 0);
      assert.strictEqual(res.cleanBuffer, wavBuffer);
      assert.strictEqual(Math.round(res.durationSeconds), 2);
    });
  });

});
