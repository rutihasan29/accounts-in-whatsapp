const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  calculateExpectedRate,
  formatChatForLlm,
  segmentChatWithLlm,
  saveLlmJobBlocksToDb,
  runLlmAuditOnAllChats,
  getClientWatermark,
  filterIncrementalMessages
} = require('../src/llm-job-segmenter');

test('calculateExpectedRate computes accurate pricing tiers', () => {
  // Voice tiers
  assert.equal(calculateExpectedRate('audio', 0), 50);
  assert.equal(calculateExpectedRate('audio', 30), 50);
  assert.equal(calculateExpectedRate('audio', 60), 50);
  assert.equal(calculateExpectedRate('audio', 61), 75);
  assert.equal(calculateExpectedRate('audio', 85), 75);
  assert.equal(calculateExpectedRate('audio', 120), 75);
  assert.equal(calculateExpectedRate('audio', 121), 100);
  assert.equal(calculateExpectedRate('ptt', 45), 50);

  // Video tier
  assert.equal(calculateExpectedRate('video', 15), 250);
  assert.equal(calculateExpectedRate('video/mp4', 60), 250);
});

test('formatChatForLlm orders chronologically and attaches durations & rates', () => {
  const rawChat = {
    phone: '8801711111111',
    name: 'Test Client',
    messages: [
      { t: 1002, fromMe: true, type: 'audio', duration: 45, filename: 'news1.mp3' },
      { t: 1001, fromMe: false, body: 'Please voice this' },
      { t: 1003, fromMe: true, body: 'বিল ৫০ টাকা' }
    ]
  };

  const formatted = formatChatForLlm(rawChat);
  assert.equal(formatted.clientPhone, '8801711111111');
  assert.equal(formatted.totalMessages, 3);
  // Verify chronological sort
  assert.equal(formatted.messages[0].sender, 'CLIENT');
  assert.equal(formatted.messages[1].sender, 'STAFF');
  assert.equal(formatted.messages[1].mediaDurationSec, 45);
  assert.equal(formatted.messages[1].expectedRateBdt, 50);
  assert.equal(formatted.messages[2].text, 'বিল ৫০ টাকা');
});

test('segmentChatWithLlm throws error when GEMINI_API_KEY is missing (no fallback)', async () => {
  const chat = {
    clientPhone: '8801722222222',
    messages: [
      { fromMe: true, type: 'audio', duration: 45, hasMedia: true }
    ]
  };

  await assert.rejects(
    async () => {
      await segmentChatWithLlm(chat, { apiKey: '' });
    },
    /GEMINI_API_KEY is required/
  );
});

test('segmentChatWithLlm throws error when Gemini returns HTTP failure (no fallback)', async () => {
  const mockFailingFetch = async () => ({
    ok: false,
    status: 500,
    text: async () => 'Internal Server Error'
  });

  const chat = {
    clientPhone: '8801733333333',
    messages: [
      { fromMe: true, type: 'audio', duration: 45, hasMedia: true }
    ]
  };

  await assert.rejects(
    async () => {
      await segmentChatWithLlm(chat, { apiKey: 'test-key', fetchFn: mockFailingFetch });
    },
    /Gemini API request failed with HTTP 500/
  );
});

test('saveLlmJobBlocksToDb saves unbilled jobs into SQLite accurately', () => {
  const { initDb } = require('../src/db');
  const db = initDb(':memory:');

  const mockAudit = {
    clientPhone: '8801744444444',
    jobBlocks: [
      {
        jobType: 'voice',
        deliveredAt: '2026-11-25T11:00:00.000Z',
        mediaDetails: { type: 'audio', durationSeconds: 50 },
        expectedAmountBdt: 50,
        billedAmountBdt: 0,
        unbilledLeakageBdt: 50,
        status: 'UNBILLED_LEAKAGE',
        rawMediaMsgId: 'raw_media_unbilled_123',
        billText: null
      }
    ]
  };

  const res = saveLlmJobBlocksToDb(db, mockAudit);
  assert.equal(res.savedJobs, 1);
  assert.equal(res.totalExpected, 50);
  assert.equal(res.totalLeakage, 50);

  // Verify stored row in metrics_chat_jobs
  const job = db.prepare('SELECT * FROM metrics_chat_jobs WHERE phone_number = ?').get('8801744444444');
  assert.ok(job);
  assert.equal(job.expected_amount_bdt, 50);
  assert.equal(job.billed_amount_bdt, 0);
  assert.equal(job.unbilled_leakage_bdt, 50);
  assert.equal(job.status, 'UNBILLED_LEAKAGE');

  db.close();
});

test('segmentChatWithLlm uses mock Gemini fetch and calculates unbilled leakage', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              clientPhone: '8801755555555',
              totalJobsDetected: 1,
              clientSummary: {
                totalRevenueEstimatedBdt: 100,
                totalRevenueBilledBdt: 0,
                totalLeakageBdt: 100,
                conversionStatus: 'CONVERTED'
              },
              jobBlocks: [{
                jobBlockId: 1,
                jobType: 'voice',
                deliveredAt: '2026-11-25T12:00:00Z',
                mediaDetails: { type: 'audio', durationSeconds: 130 },
                expectedAmountBdt: 100,
                billedAmountBdt: 0,
                unbilledLeakageBdt: 100,
                status: 'UNBILLED_LEAKAGE',
                auditNotes: 'Audio delivered without bill message'
              }]
            })
          }]
        }
      }]
    })
  });

  const chat = {
    clientPhone: '8801755555555',
    messages: [
      { fromMe: true, type: 'audio', duration: 130, hasMedia: true }
    ]
  };

  const audit = await segmentChatWithLlm(chat, {
    apiKey: 'test-key',
    fetchFn: mockFetch
  });

  assert.equal(audit.totalJobsDetected, 1);
  assert.equal(audit.jobBlocks[0].expectedAmountBdt, 100);
  assert.equal(audit.jobBlocks[0].billedAmountBdt, 0);
  assert.equal(audit.jobBlocks[0].unbilledLeakageBdt, 100);
  assert.equal(audit.jobBlocks[0].status, 'UNBILLED_LEAKAGE');
});

test('runLlmAuditOnAllChats audits multiple chats and saves aggregated results to db', async () => {
  const { initDb } = require('../src/db');
  const db = initDb(':memory:');

  const testChats = [
    {
      phone: '8801799999991',
      messages: [
        { fromMe: true, type: 'audio', duration: 45, hasMedia: true, t: 1732500000 }
      ]
    },
    {
      phone: '8801799999992',
      messages: [
        { fromMe: true, type: 'video', duration: 30, hasMedia: true, t: 1732500010 },
        { fromMe: true, type: 'chat', body: 'বিল ২৫০ টাকা', t: 1732500020 }
      ]
    }
  ];

  const mockMultiFetch = async (url, opts) => {
    const bodyStr = opts?.body || '';
    if (bodyStr.includes('8801799999991')) {
      return {
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  clientPhone: '8801799999991',
                  totalJobsDetected: 1,
                  clientSummary: {
                    totalRevenueEstimatedBdt: 50,
                    totalRevenueBilledBdt: 0,
                    totalLeakageBdt: 50,
                    conversionStatus: 'CONVERTED'
                  },
                  jobBlocks: [{
                    jobBlockId: 1,
                    jobType: 'voice',
                    deliveredAt: '2026-11-25T10:00:00.000Z',
                    mediaDetails: { type: 'audio', durationSeconds: 45 },
                    worthBdt: 50,
                    expectedAmountBdt: 50,
                    billedAmountBdt: 0,
                    unbilledLeakageBdt: 50,
                    status: 'UNBILLED_LEAKAGE',
                    billText: null
                  }]
                })
              }]
            }
          }]
        })
      };
    } else {
      return {
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  clientPhone: '8801799999992',
                  totalJobsDetected: 1,
                  clientSummary: {
                    totalRevenueEstimatedBdt: 250,
                    totalRevenueBilledBdt: 250,
                    totalLeakageBdt: 0,
                    conversionStatus: 'CONVERTED'
                  },
                  jobBlocks: [{
                    jobBlockId: 1,
                    jobType: 'video',
                    deliveredAt: '2026-11-25T10:00:10.000Z',
                    mediaDetails: { type: 'video', durationSeconds: 30 },
                    worthBdt: 250,
                    expectedAmountBdt: 250,
                    billedAmountBdt: 250,
                    unbilledLeakageBdt: 0,
                    status: 'CONFIRMED_BILLED',
                    billText: 'বিল ২৫০ টাকা'
                  }]
                })
              }]
            }
          }]
        })
      };
    }
  };

  const res = await runLlmAuditOnAllChats(db, {
    chats: testChats,
    apiKey: 'mock-key',
    fetchFn: mockMultiFetch
  });

  assert.equal(res.auditedChats, 2);
  assert.equal(res.totalJobs, 2);
  assert.equal(res.totalEstimated, 300); // 50 voice + 250 video
  assert.equal(res.totalBilled, 250);   // video billed
  assert.equal(res.totalLeakage, 50);   // unbilled voice note

  // Check database persistence
  const jobs = db.prepare('SELECT * FROM metrics_chat_jobs ORDER BY delivered_at ASC').all();
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].unbilled_leakage_bdt, 50);
  assert.equal(jobs[0].status, 'UNBILLED_LEAKAGE');
  assert.equal(jobs[1].billed_amount_bdt, 250);
  assert.equal(jobs[1].status, 'CONFIRMED_BILLED');

  const clients = db.prepare('SELECT * FROM metrics_chat_clients ORDER BY phone_number ASC').all();
  assert.equal(clients.length, 2);

  db.close();
});

test('getClientWatermark and filterIncrementalMessages isolate new messages and anchor unbilled jobs', () => {
  const { initDb } = require('../src/db');
  const db = initDb(':memory:');

  // Insert existing job at T=1000
  db.prepare(`
    INSERT INTO metrics_chat_jobs (
      phone_number, job_type, delivered_at, media_type, duration_seconds,
      expected_amount_bdt, billed_amount_bdt, unbilled_leakage_bdt, status, raw_media_msg_id
    ) VALUES (
      '8801712345678', 'voice', '2026-11-25T10:00:00.000Z', 'audio', 45,
      50, 0, 50, 'UNBILLED_LEAKAGE', 'msg_audio_unbilled_1'
    )
  `).run();

  const watermark = getClientWatermark(db, '8801712345678');
  assert.ok(watermark);
  assert.equal(watermark.hasExistingJobs, true);
  assert.equal(watermark.lastJobDeliveredAt, '2026-11-25T10:00:00.000Z');
  assert.ok(watermark.lastUnbilledJob);
  assert.equal(watermark.lastUnbilledJob.raw_media_msg_id, 'msg_audio_unbilled_1');

  // Test filterIncrementalMessages:
  // Messages contain old message from 08:00 AM, the unbilled audio from 10:00 AM, and new bill message from 10:20 AM
  const chat = {
    phone: '8801712345678',
    messages: [
      { id: 'msg_old_1', isoTime: '2026-11-25T08:00:00.000Z', type: 'chat', body: 'হ্যালো' },
      { id: 'msg_audio_unbilled_1', isoTime: '2026-11-25T10:00:00.000Z', type: 'audio', duration: 45, hasMedia: true, fromMe: true },
      { id: 'msg_new_bill_1', isoTime: '2026-11-25T10:20:00.000Z', type: 'chat', body: 'বিল ৫০ টাকা', fromMe: true }
    ]
  };

  const incremental = filterIncrementalMessages(chat, watermark, 10 * 60 * 1000);
  assert.equal(incremental.isIncremental, true);
  // Old 08:00 AM message must be filtered out; unbilled audio and new bill must be preserved
  assert.equal(incremental.messages.length, 2);
  assert.equal(incremental.messages[0].id, 'msg_audio_unbilled_1');
  assert.equal(incremental.messages[1].id, 'msg_new_bill_1');

  db.close();
});

test('Incremental traversal updates pending unbilled job and appends new job without reprocessing past history', async () => {
  const { initDb } = require('../src/db');
  const db = initDb(':memory:');

  const phone = '8801777777777';

  // 1. Initial batch: delivery of unbilled audio at 10:00 AM
  const initialChat = {
    phone,
    messages: [
      { id: 'm1', t: 1732528800, isoTime: '2026-11-25T10:00:00.000Z', type: 'chat', body: 'হ্যালো' },
      { id: 'm_audio_1', t: 1732528810, isoTime: '2026-11-25T10:00:10.000Z', type: 'audio', duration: 40, hasMedia: true, fromMe: true }
    ]
  };

  const mockFetch1 = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              clientPhone: phone,
              totalJobsDetected: 1,
              clientSummary: {
                totalRevenueEstimatedBdt: 50,
                totalRevenueBilledBdt: 0,
                totalLeakageBdt: 50,
                conversionStatus: 'CONVERTED'
              },
              jobBlocks: [{
                jobBlockId: 1,
                jobType: 'voice',
                deliveredAt: '2026-11-25T10:00:10.000Z',
                rawMediaMsgId: 'm_audio_1',
                mediaDetails: { type: 'audio', durationSeconds: 40 },
                worthBdt: 50,
                expectedAmountBdt: 50,
                billedAmountBdt: 0,
                unbilledLeakageBdt: 50,
                status: 'UNBILLED_LEAKAGE',
                billText: null
              }]
            })
          }]
        }
      }]
    })
  });

  const audit1 = await runLlmAuditOnAllChats(db, {
    chats: [initialChat],
    apiKey: 'mock-key',
    fetchFn: mockFetch1
  });
  assert.equal(audit1.totalJobs, 1);
  assert.equal(audit1.totalLeakage, 50);

  let job1 = db.prepare('SELECT * FROM metrics_chat_jobs WHERE phone_number = ?').get(phone);
  assert.equal(job1.status, 'UNBILLED_LEAKAGE');
  assert.equal(job1.billed_amount_bdt, 0);

  // 2. Second batch (later): staff sends bill for job 1, AND delivers a new video job at 11:00 AM
  const updatedChat = {
    phone,
    messages: [
      { id: 'm1', t: 1732528800, isoTime: '2026-11-25T10:00:00.000Z', type: 'chat', body: 'হ্যালো' },
      { id: 'm_audio_1', t: 1732528810, isoTime: '2026-11-25T10:00:10.000Z', type: 'audio', duration: 40, hasMedia: true, fromMe: true },
      { id: 'm_bill_1', t: 1732528830, isoTime: '2026-11-25T10:00:30.000Z', type: 'chat', body: 'বিল ৫০ টাকা', fromMe: true },
      { id: 'm_video_2', t: 1732532400, isoTime: '2026-11-25T11:00:00.000Z', type: 'video', duration: 20, hasMedia: true, fromMe: true },
      { id: 'm_bill_2', t: 1732532420, isoTime: '2026-11-25T11:00:20.000Z', type: 'chat', body: 'বিল ২৫০ টাকা', fromMe: true }
    ]
  };

  const mockFetch2 = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              clientPhone: phone,
              totalJobsDetected: 2,
              clientSummary: {
                totalRevenueEstimatedBdt: 300,
                totalRevenueBilledBdt: 300,
                totalLeakageBdt: 0,
                conversionStatus: 'CONVERTED'
              },
              jobBlocks: [
                {
                  jobBlockId: 1,
                  jobType: 'voice',
                  deliveredAt: '2026-11-25T10:00:10.000Z',
                  rawMediaMsgId: 'm_audio_1',
                  mediaDetails: { type: 'audio', durationSeconds: 40 },
                  worthBdt: 50,
                  expectedAmountBdt: 50,
                  billedAmountBdt: 50,
                  unbilledLeakageBdt: 0,
                  status: 'CONFIRMED_BILLED',
                  billText: 'বিল ৫০ টাকা'
                },
                {
                  jobBlockId: 2,
                  jobType: 'video',
                  deliveredAt: '2026-11-25T11:00:00.000Z',
                  rawMediaMsgId: 'm_video_2',
                  mediaDetails: { type: 'video', durationSeconds: 20 },
                  worthBdt: 250,
                  expectedAmountBdt: 250,
                  billedAmountBdt: 250,
                  unbilledLeakageBdt: 0,
                  status: 'CONFIRMED_BILLED',
                  billText: 'বিল ২৫০ টাকা'
                }
              ]
            })
          }]
        }
      }]
    })
  });

  // Run incremental audit
  const audit2 = await runLlmAuditOnAllChats(db, {
    chats: [updatedChat],
    apiKey: 'mock-key',
    fetchFn: mockFetch2,
    incremental: true
  });

  // Verify that job 1 was reconciled to CONFIRMED_BILLED, and job 2 was added
  const allJobs = db.prepare('SELECT * FROM metrics_chat_jobs WHERE phone_number = ? ORDER BY delivered_at ASC').all(phone);
  assert.equal(allJobs.length, 2);
  assert.equal(allJobs[0].status, 'CONFIRMED_BILLED');
  assert.equal(allJobs[0].billed_amount_bdt, 50);
  assert.equal(allJobs[0].unbilled_leakage_bdt, 0);

  assert.equal(allJobs[1].job_type, 'video');
  assert.equal(allJobs[1].status, 'CONFIRMED_BILLED');
  assert.equal(allJobs[1].billed_amount_bdt, 250);

  // Client stats updated accurately
  const client = db.prepare('SELECT * FROM metrics_chat_clients WHERE phone_number = ?').get(phone);
  assert.equal(client.total_jobs_delivered, 2);
  assert.equal(client.total_billed_bdt, 300);
  assert.equal(client.total_unbilled_bdt, 0);

  db.close();
});
