const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  calculateExpectedRate,
  formatChatForLlm,
  segmentChatWithLlm,
  segmentChatDeterministicFallback,
  saveLlmJobBlocksToDb,
  runLlmAuditOnAllChats
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

test('Deterministic segmenter calculates unbilled jobs even when bill message is NOT sent', () => {
  const chatWithoutBill = {
    clientPhone: '8801722222222',
    clientName: 'Unbilled Client',
    messages: [
      {
        index: 1,
        time: '2026-11-25T10:00:00.000Z',
        sender: 'CLIENT',
        text: 'Script sent: Urgent election update'
      },
      {
        index: 2,
        time: '2026-11-25T10:15:00.000Z',
        sender: 'STAFF',
        type: 'audio',
        hasMedia: true,
        mediaDurationSec: 80,
        filename: 'election.mp3'
      }
      // Note: NO bill message was ever sent by staff!
    ]
  };

  const audit = segmentChatDeterministicFallback(chatWithoutBill);
  assert.equal(audit.totalJobsDetected, 1);
  const job = audit.jobBlocks[0];

  // Guaranteed calculation without bill message:
  assert.equal(job.expectedAmountBdt, 75); // 80s = 75 BDT
  assert.equal(job.billedAmountBdt, 0);
  assert.equal(job.unbilledLeakageBdt, 75);
  assert.equal(job.status, 'UNBILLED_LEAKAGE');
  assert.equal(audit.clientSummary.totalRevenueEstimatedBdt, 75);
  assert.equal(audit.clientSummary.totalLeakageBdt, 75);
  assert.equal(audit.clientSummary.totalRevenueBilledBdt, 0);
});

test('Deterministic segmenter matches confirmed bill when bill message is present', () => {
  const chatWithBill = {
    clientPhone: '8801733333333',
    clientName: 'Billed Client',
    messages: [
      {
        index: 1,
        time: '2026-11-25T10:00:00.000Z',
        sender: 'CLIENT',
        text: 'Weather update script'
      },
      {
        index: 2,
        time: '2026-11-25T10:15:00.000Z',
        sender: 'STAFF',
        type: 'audio',
        hasMedia: true,
        mediaDurationSec: 40,
        filename: 'weather.mp3'
      },
      {
        index: 3,
        time: '2026-11-25T10:16:00.000Z',
        sender: 'STAFF',
        text: 'বিল ৫০ টাকা'
      }
    ]
  };

  const audit = segmentChatDeterministicFallback(chatWithBill);
  assert.equal(audit.totalJobsDetected, 1);
  const job = audit.jobBlocks[0];
  assert.equal(job.expectedAmountBdt, 50);
  assert.equal(job.billedAmountBdt, 50);
  assert.equal(job.unbilledLeakageBdt, 0);
  assert.equal(job.status, 'CONFIRMED_BILLED');
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

  // We test using deterministic fallback (apiKey: '' prevents real network calls)
  const res = await runLlmAuditOnAllChats(db, {
    chats: testChats,
    apiKey: ''
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
