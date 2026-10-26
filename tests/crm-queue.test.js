const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initCrmDb, createCaller, updateCallerStatus, insertLead } = require('../src/crm/db');
const { logCallDisposition, getCallerQueue } = require('../src/crm/queue');

describe('CRM Priority Queue & Call Disposition', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    initCrmDb(db);
    createCaller(db, { id: 'c1', name: 'Tanvir', pin: '1111' });
    updateCallerStatus(db, 'c1', 'active');
  });

  test('logCallDisposition handles callback_requested and schedules exact time', () => {
    insertLead(db, { id: 'l1', name: 'Customer 1', phone_number: '111' });

    const callbackTime = '2026-10-26T16:30:00Z';
    logCallDisposition(db, {
      leadId: 'l1',
      callerId: 'c1',
      disposition: 'callback_requested',
      notes: 'Asked to call at 4:30 PM',
      callbackTime
    });

    const lead = db.prepare('SELECT * FROM crm_leads WHERE id = ?').get('l1');
    assert.equal(lead.status, 'callback_set');
    assert.equal(lead.next_callback_at, callbackTime);
    assert.equal(lead.assigned_caller_id, 'c1');
  });

  test('logCallDisposition handles ringing_no_answer and increments retry_count with 2-hour cooldown', () => {
    insertLead(db, { id: 'l2', name: 'Customer 2', phone_number: '222' });

    const t0 = new Date('2026-10-26T10:00:00.000Z');
    logCallDisposition(db, {
      leadId: 'l2',
      callerId: 'c1',
      disposition: 'ringing_no_answer',
      notes: 'No response',
      timestamp: t0
    });

    const lead = db.prepare('SELECT * FROM crm_leads WHERE id = ?').get('l2');
    assert.equal(lead.status, 'unreachable');
    assert.equal(lead.retry_count, 1);
    // Cooldown is 2 hours (7200000ms)
    assert.equal(new Date(lead.next_callback_at).toISOString(), new Date(t0.getTime() + 2 * 3600 * 1000).toISOString());
  });

  test('logCallDisposition handles busy_declined (30 min) and switched_off (18 hr)', () => {
    insertLead(db, { id: 'l_busy', name: 'Busy Customer', phone_number: '333' });
    insertLead(db, { id: 'l_off', name: 'Off Customer', phone_number: '444' });

    const t0 = new Date('2026-10-26T10:00:00.000Z');

    logCallDisposition(db, {
      leadId: 'l_busy',
      callerId: 'c1',
      disposition: 'busy_declined',
      notes: 'Busy line',
      timestamp: t0
    });

    const busyLead = db.prepare('SELECT * FROM crm_leads WHERE id = ?').get('l_busy');
    assert.equal(busyLead.status, 'unreachable');
    assert.equal(busyLead.retry_count, 1);
    assert.equal(new Date(busyLead.next_callback_at).toISOString(), new Date(t0.getTime() + 30 * 60 * 1000).toISOString());

    logCallDisposition(db, {
      leadId: 'l_off',
      callerId: 'c1',
      disposition: 'switched_off',
      notes: 'Phone switched off',
      timestamp: t0
    });

    const offLead = db.prepare('SELECT * FROM crm_leads WHERE id = ?').get('l_off');
    assert.equal(offLead.status, 'unreachable');
    assert.equal(offLead.retry_count, 1);
    assert.equal(new Date(offLead.next_callback_at).toISOString(), new Date(t0.getTime() + 18 * 3600 * 1000).toISOString());
  });

  test('logCallDisposition handles order_won and not_interested dispositions', () => {
    insertLead(db, { id: 'l_won', name: 'Won Customer', phone_number: '555' });
    insertLead(db, { id: 'l_lost', name: 'Lost Customer', phone_number: '666' });

    logCallDisposition(db, {
      leadId: 'l_won',
      callerId: 'c1',
      disposition: 'order_won',
      notes: 'Ordered 2 units'
    });

    const wonLead = db.prepare('SELECT * FROM crm_leads WHERE id = ?').get('l_won');
    assert.equal(wonLead.status, 'won');
    assert.equal(wonLead.next_callback_at, null);

    logCallDisposition(db, {
      leadId: 'l_lost',
      callerId: 'c1',
      disposition: 'not_interested',
      notes: 'Refused offer'
    });

    const lostLead = db.prepare('SELECT * FROM crm_leads WHERE id = ?').get('l_lost');
    assert.equal(lostLead.status, 'lost');
    assert.equal(lostLead.next_callback_at, null);
  });

  test('getCallerQueue strictly sorts: Fresh > Due Callback > Retries', () => {
    const now = new Date('2026-10-26T14:00:00.000Z');

    // 1. Due Callback (due at 13:30)
    insertLead(db, { id: 'l_callback', name: 'Callback Client', phone_number: '111' });
    logCallDisposition(db, {
      leadId: 'l_callback',
      callerId: 'c1',
      disposition: 'callback_requested',
      callbackTime: '2026-10-26T13:30:00.000Z',
      timestamp: now
    });

    // 2. Fresh Lead
    insertLead(db, { id: 'l_fresh', name: 'Fresh Client', phone_number: '222' });
    db.prepare("UPDATE crm_leads SET assigned_caller_id = 'c1', status = 'fresh' WHERE id = 'l_fresh'").run();

    // 3. Retry (unreachable past 2 hours)
    insertLead(db, { id: 'l_retry', name: 'Retry Client', phone_number: '333' });
    db.prepare(`
      UPDATE crm_leads
      SET assigned_caller_id = 'c1', status = 'unreachable', next_callback_at = '2026-10-26T12:00:00.000Z'
      WHERE id = 'l_retry'
    `).run();

    const queue = getCallerQueue(db, 'c1', now);
    assert.equal(queue.length, 3);
    assert.equal(queue[0].id, 'l_fresh'); // Priority 1
    assert.equal(queue[1].id, 'l_callback'); // Priority 2
    assert.equal(queue[2].id, 'l_retry'); // Priority 3
  });

  test('getCallerQueue filters out future callbacks and future retries', () => {
    const now = new Date('2026-10-26T14:00:00.000Z');

    // Callback in future (15:00)
    insertLead(db, { id: 'l_future_cb', name: 'Future Callback', phone_number: '777' });
    logCallDisposition(db, {
      leadId: 'l_future_cb',
      callerId: 'c1',
      disposition: 'callback_requested',
      callbackTime: '2026-10-26T15:00:00.000Z',
      timestamp: now
    });

    // Retry in future (16:00)
    insertLead(db, { id: 'l_future_retry', name: 'Future Retry', phone_number: '888' });
    db.prepare(`
      UPDATE crm_leads
      SET assigned_caller_id = 'c1', status = 'unreachable', next_callback_at = '2026-10-26T16:00:00.000Z'
      WHERE id = 'l_future_retry'
    `).run();

    // In progress lead
    insertLead(db, { id: 'l_inp', name: 'In Progress', phone_number: '999' });
    db.prepare("UPDATE crm_leads SET assigned_caller_id = 'c1', status = 'in_progress' WHERE id = 'l_inp'").run();

    const queue = getCallerQueue(db, 'c1', now);
    // Future ones should not be in queue yet, in_progress should be included
    assert.equal(queue.length, 1);
    assert.equal(queue[0].id, 'l_inp');
    assert.equal(queue[0].queue_priority, 4);
  });
});
