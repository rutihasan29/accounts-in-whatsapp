const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initCrmDb, createCaller, updateCallerStatus, insertLead } = require('../src/crm/db');
const { assignFreshLead, claimLead, checkAndEscalateTimeouts, TIMEOUT_SECONDS } = require('../src/crm/routing');

describe('CRM Round-Robin & Escalation Routing', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    initCrmDb(db);

    const fullWeekSchedule = JSON.stringify({
      mon: [{ start: '00:00', end: '23:59' }]
    });

    createCaller(db, { id: 'c1', name: 'Caller One', pin: '1111', shift_schedule_json: fullWeekSchedule });
    createCaller(db, { id: 'c2', name: 'Caller Two', pin: '2222', shift_schedule_json: fullWeekSchedule });
    updateCallerStatus(db, 'c1', 'active');
    updateCallerStatus(db, 'c2', 'active');
  });

  test('rotates lead assignments evenly via round-robin', () => {
    const monday = new Date('2026-10-26T10:00:00Z');

    insertLead(db, { id: 'l1', name: 'Lead 1', phone_number: '111' });
    insertLead(db, { id: 'l2', name: 'Lead 2', phone_number: '222' });
    insertLead(db, { id: 'l3', name: 'Lead 3', phone_number: '333' });

    const a1 = assignFreshLead(db, 'l1', monday);
    assert.equal(a1.assigned_caller_id, 'c1');

    const a2 = assignFreshLead(db, 'l2', monday);
    assert.equal(a2.assigned_caller_id, 'c2');

    const a3 = assignFreshLead(db, 'l3', monday);
    assert.equal(a3.assigned_caller_id, 'c1');
  });

  test('claims lead successfully and measures SLA under 60 seconds', () => {
    const t0 = new Date('2026-10-26T10:00:00.000Z');
    insertLead(db, { id: 'l1', name: 'Lead 1', phone_number: '111', created_at: t0.toISOString() });
    assignFreshLead(db, 'l1', t0);

    // Claimed 14 seconds later
    const tClaim = new Date('2026-10-26T10:00:14.000Z');
    const result = claimLead(db, 'l1', 'c1', tClaim);

    assert.equal(result.status, 'in_progress');
    assert.equal(result.speed_to_lead_seconds, 14);
    assert.equal(result.sla_status, 'met_sla');
  });

  test('measures breached SLA when claimed after 60 seconds', () => {
    const t0 = new Date('2026-10-26T10:00:00.000Z');
    insertLead(db, { id: 'l1', name: 'Lead 1', phone_number: '111', created_at: t0.toISOString() });
    assignFreshLead(db, 'l1', t0);

    // Claimed 75 seconds later
    const tClaim = new Date('2026-10-26T10:01:15.000Z');
    const result = claimLead(db, 'l1', 'c1', tClaim);

    assert.equal(result.status, 'in_progress');
    assert.equal(result.speed_to_lead_seconds, 75);
    assert.equal(result.sla_status, 'breached_sla');
  });

  test('escalates to next caller after 20-second timeout', () => {
    const t0 = new Date('2026-10-26T10:00:00.000Z');
    insertLead(db, { id: 'l1', name: 'Lead 1', phone_number: '111' });
    assignFreshLead(db, 'l1', t0); // assigned to c1 with expires_at = t0 + 20s

    // At 15 seconds, checkEscalation should do nothing
    const t15 = new Date('2026-10-26T10:00:15.000Z');
    let escalated = checkAndEscalateTimeouts(db, t15);
    assert.equal(escalated.length, 0);

    // At 21 seconds, c1 timed out -> should auto-escalate to c2
    const t21 = new Date('2026-10-26T10:00:21.000Z');
    escalated = checkAndEscalateTimeouts(db, t21);
    assert.equal(escalated.length, 1);
    assert.equal(escalated[0].lead_id, 'l1');
    assert.equal(escalated[0].from_caller_id, 'c1');
    assert.equal(escalated[0].to_caller_id, 'c2');

    // Lead's assigned caller is now c2
    const lead = db.prepare('SELECT * FROM crm_leads WHERE id = ?').get('l1');
    assert.equal(lead.assigned_caller_id, 'c2');
  });

  test('handles zero eligible callers gracefully on fresh lead assignment', () => {
    updateCallerStatus(db, 'c1', 'offline');
    updateCallerStatus(db, 'c2', 'offline');

    insertLead(db, { id: 'l_unassigned', name: 'No Caller', phone_number: '999' });
    const result = assignFreshLead(db, 'l_unassigned', new Date('2026-10-26T10:00:00Z'));

    assert.equal(result.assigned_caller_id, null);
    assert.equal(result.status, 'unassigned');
  });

  test('exports TIMEOUT_SECONDS constant set to 20', () => {
    assert.equal(TIMEOUT_SECONDS, 20);
  });
});
