const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHistoryTranscript, classifyChat } = require('../src/classifier');

test('buildHistoryTranscript formats roles properly', () => {
  const msgs = [
    { fromMe: false, body: 'Hello' },
    { fromMe: true, body: 'How can I help?' },
    { fromMe: false, body: 'I need a voice recording' }
  ];
  const transcript = buildHistoryTranscript(msgs);
  assert.match(transcript, /\[Customer\]: Hello/);
  assert.match(transcript, /\[Bot\]: How can I help\?/);
  assert.match(transcript, /\[Customer\]: I need a voice recording/);
});

test('classifyChat returns VOICE_JOB when API provides voice job classification', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              classification: 'VOICE_JOB',
              confidence: 'HIGH',
              extracted_script: 'This is the ad script for commercial.',
              reason: 'Customer submitted script with voice request'
            })
          }]
        }
      }]
    })
  });

  const res = await classifyChat({
    messages: [{ fromMe: false, body: 'Here is script: This is the ad script for commercial. Voice recording lagbe' }],
    apiKey: 'dummy-key',
    fetchFn: mockFetch
  });

  assert.equal(res.classification, 'VOICE_JOB');
  assert.equal(res.extracted_script, 'This is the ad script for commercial.');
});

test('classifyChat returns SCRIPT_PENDING_CONFIRMATION for raw script', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              classification: 'SCRIPT_PENDING_CONFIRMATION',
              confidence: 'HIGH',
              extracted_script: 'Raw script without voice keyword',
              reason: 'Raw script submitted without medium specification'
            })
          }]
        }
      }]
    })
  });

  const res = await classifyChat({
    messages: [{ fromMe: false, body: 'Raw script without voice keyword' }],
    apiKey: 'dummy-key',
    fetchFn: mockFetch
  });

  assert.equal(res.classification, 'SCRIPT_PENDING_CONFIRMATION');
});

test('classifyChat returns ESCALATE on API error or timeout', async () => {
  const mockFetch = async () => {
    throw new Error('Network timeout');
  };

  const res = await classifyChat({
    messages: [{ fromMe: false, body: 'Video banano jabe?' }],
    apiKey: 'dummy-key',
    fetchFn: mockFetch
  });

  assert.equal(res.classification, 'ESCALATE');
  assert.match(res.reason, /Network timeout|Error/);
});

test('classifyChat falls back to ESCALATE when apiKey is missing', async () => {
  const res = await classifyChat({
    messages: [{ fromMe: false, body: 'Hello' }],
    apiKey: ''
  });

  assert.equal(res.classification, 'ESCALATE');
  assert.equal(res.confidence, 'LOW');
  assert.equal(res.reason, 'Missing GEMINI_API_KEY');
});

test('classifyChat returns OTHER when transcript is empty', async () => {
  const res = await classifyChat({
    messages: [],
    apiKey: 'dummy-key'
  });

  assert.equal(res.classification, 'OTHER');
  assert.equal(res.confidence, 'HIGH');
  assert.equal(res.reason, 'Empty conversation transcript');
});

test('classifyChat handles markdown json code blocks in API response', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{
            text: '```json\n{"classification":"OTHER","confidence":"HIGH","extracted_script":"","reason":"Greeting"}\n```'
          }]
        }
      }]
    })
  });

  const res = await classifyChat({
    messages: [{ fromMe: false, body: 'Hi' }],
    apiKey: 'dummy-key',
    fetchFn: mockFetch
  });

  assert.equal(res.classification, 'OTHER');
  assert.equal(res.confidence, 'HIGH');
  assert.equal(res.reason, 'Greeting');
});

test('buildHistoryTranscript attributes [Bot] correctly based on myUser when fromMe is false or undefined', () => {
  const msgs = [
    { fromMe: false, from: '8801831366604@c.us', body: 'Outgoing message synced from web client' },
    { fromMe: undefined, author: '8801831366604:15@c.us', body: 'Another bot message' },
    { fromMe: false, from: '8801700000000@c.us', body: 'Customer reply' }
  ];
  const transcript = buildHistoryTranscript(msgs, '8801831366604');
  assert.match(transcript, /\[Bot\]: Outgoing message synced from web client/);
  assert.match(transcript, /\[Bot\]: Another bot message/);
  assert.match(transcript, /\[Customer\]: Customer reply/);
});

test('classifyChat handles multi-turn confirmation ("শুধু ভয়েস?" -> "হ্যাঁ" -> VOICE_JOB)', async () => {
  let capturedPayload = null;
  const mockFetch = async (url, options) => {
    capturedPayload = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                classification: 'VOICE_JOB',
                confidence: 'HIGH',
                extracted_script: 'স্পেশাল বিরিয়ানি এখন হোম ডেলিভারি ফ্রি। এখনই অর্ডার করুন।',
                reason: 'Customer affirmatively confirmed voice only after bot question'
              })
            }]
          }
        }]
      })
    };
  };

  const messages = [
    { fromMe: false, body: 'স্পেশাল বিরিয়ানি এখন হোম ডেলিভারি ফ্রি। এখনই অর্ডার করুন।' },
    { fromMe: true, body: 'শুধু ভয়েস? ' },
    { fromMe: false, body: 'হ্যাঁ' }
  ];

  const res = await classifyChat({
    messages,
    myUser: '8801340517587',
    apiKey: 'dummy-key',
    fetchFn: mockFetch
  });

  assert.equal(res.classification, 'VOICE_JOB');
  assert.equal(res.extracted_script, 'স্পেশাল বিরিয়ানি এখন হোম ডেলিভারি ফ্রি। এখনই অর্ডার করুন।');
  assert.ok(capturedPayload.contents[0].parts[0].text.includes('[Bot]: শুধু ভয়েস?'));
  assert.ok(capturedPayload.contents[0].parts[0].text.includes('[Customer]: হ্যাঁ'));
});

test('classifyChat falls back to ESCALATE when API returns invalid classification enum', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              classification: 'UNRECOGNIZED_CATEGORY',
              confidence: 'HIGH',
              extracted_script: '',
              reason: 'Unknown enum value'
            })
          }]
        }
      }]
    })
  });

  const res = await classifyChat({
    messages: [{ fromMe: false, body: 'Hello' }],
    apiKey: 'dummy-key',
    fetchFn: mockFetch
  });

  assert.equal(res.classification, 'ESCALATE');
});
