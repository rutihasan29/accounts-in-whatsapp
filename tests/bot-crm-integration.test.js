const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initDb, setBotSetting } = require('../src/db');
const { handleMessageCreate } = require('../src/bot');
const { createCaller, updateCallerStatus, getLeadById } = require('../src/crm/db');
const { getCallerQueue, logCallDisposition } = require('../src/crm/queue');
const { claimLead } = require('../src/crm/routing');

describe('Native Bot -> Telecaller CRM Integration', () => {
  let db;

  beforeEach(() => {
    db = initDb(':memory:');
    setBotSetting(db, 'welcome_demo_enabled', 'false');

    // Create active telecallers with full-week shifts
    const fullWeekShift = JSON.stringify({
      mon: [{ start: '00:00', end: '23:59' }],
      tue: [{ start: '00:00', end: '23:59' }],
      wed: [{ start: '00:00', end: '23:59' }],
      thu: [{ start: '00:00', end: '23:59' }],
      fri: [{ start: '00:00', end: '23:59' }],
      sat: [{ start: '00:00', end: '23:59' }],
      sun: [{ start: '00:00', end: '23:59' }]
    });

    createCaller(db, { id: 'c1', name: 'Tanvir', pin: '1234', shift_schedule_json: fullWeekShift });
    updateCallerStatus(db, 'c1', 'active');

    createCaller(db, { id: 'c2', name: 'Agent', pin: '5678', shift_schedule_json: fullWeekShift });
    updateCallerStatus(db, 'c2', 'active');
  });

  test('incoming WhatsApp message from new customer automatically creates and assigns fresh CRM lead', async () => {
    const mockMsg = {
      fromMe: false,
      from: '8801799887766@c.us',
      to: '8801700000000@c.us',
      body: 'Hello, I want to know about your voiceover services.',
      id: { remote: '8801799887766@c.us', id: 'MSG_123' },
      getChat: async () => ({
        contact: { number: '8801799887766' },
        fetchMessages: async () => []
      })
    };

    const mockClient = {
      info: { wid: { user: '8801700000000' } },
      getContactById: async () => ({ name: 'New Client Rahim' }),
      sendMessage: async () => true
    };

    // Execute message router
    await handleMessageCreate({
      msg: mockMsg,
      client: mockClient,
      db,
      isTest: true
    });

    // Check that lead was created in crm_leads
    const crmLead = db.prepare("SELECT * FROM crm_leads WHERE phone_number = '+8801799887766'").get();
    assert.ok(crmLead, 'CRM lead should be created automatically');
    assert.equal(crmLead.name, 'New Client Rahim');
    assert.equal(crmLead.source, 'whatsapp_bot');
    assert.equal(crmLead.status, 'fresh');
    assert.equal(crmLead.assigned_caller_id, 'c1', 'Should be assigned to caller c1 via round-robin');
    assert.ok(crmLead.assignment_expires_at, 'Should have a 20s expiry set');

    // Check caller c1 priority queue
    const queue = getCallerQueue(db, 'c1');
    assert.equal(queue.length, 1);
    assert.equal(queue[0].phone_number, '+8801799887766');
    assert.equal(queue[0].queue_priority, 1, 'Fresh lead must be Priority 1');

    // Telecaller claims lead
    const claimedLead = claimLead(db, crmLead.id, 'c1');
    assert.equal(claimedLead.status, 'in_progress');
    assert.equal(claimedLead.sla_status, 'met_sla');

    // Telecaller logs disposition
    logCallDisposition(db, {
      leadId: crmLead.id,
      callerId: 'c1',
      disposition: 'callback_requested',
      notes: 'Client asked to call at 4:30 PM for rate confirmation',
      callbackTime: '2026-10-26T16:30:00Z'
    });

    const updatedLead = getLeadById(db, crmLead.id);
    assert.equal(updatedLead.status, 'callback_set');
    assert.equal(updatedLead.next_callback_at, '2026-10-26T16:30:00Z');

    // Check call logs
    const callLog = db.prepare('SELECT * FROM crm_call_logs WHERE lead_id = ?').get(crmLead.id);
    assert.ok(callLog);
    assert.equal(callLog.disposition, 'callback_requested');
    assert.equal(callLog.call_notes, 'Client asked to call at 4:30 PM for rate confirmation');
  });
});
