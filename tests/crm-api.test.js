const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initCrmDb, createCaller, updateCallerStatus } = require('../src/crm/db');
const { handleCrmRequest } = require('../src/crm/api');

function mockRequest(method, url, body = {}) {
  return {
    method,
    url,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function mockResponse() {
  const res = {
    statusCode: 200,
    headers: {},
    data: '',
    setHeader(k, v) { this.headers[k] = v; },
    end(chunk) { if (chunk) this.data += chunk; }
  };
  return res;
}

describe('CRM HTTP API', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    initCrmDb(db);
    createCaller(db, {
      id: 'c1',
      name: 'Tanvir',
      pin: '1234',
      shift_schedule_json: '{"mon":[{"start":"00:00","end":"23:59"}]}'
    });
    updateCallerStatus(db, 'c1', 'active');
  });

  test('POST /api/crm/leads ingests lead and assigns via round-robin', async () => {
    const req = mockRequest('POST', '/api/crm/leads', {
      name: 'Tanvir Test',
      phone_number: '+8801700000000',
      source: 'web'
    });
    const res = mockResponse();

    await handleCrmRequest(req, res, db);

    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.data);
    assert.equal(body.success, true);
    assert.equal(body.lead.assigned_caller_id, 'c1');
  });

  test('POST /api/crm/leads/:id/claim locks lead to caller', async () => {
    db.prepare("INSERT INTO crm_leads (id, name, phone_number, status) VALUES ('l1', 'Client', '111', 'fresh')").run();

    const req = mockRequest('POST', '/api/crm/leads/l1/claim', { caller_id: 'c1' });
    const res = mockResponse();

    await handleCrmRequest(req, res, db);

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.data);
    assert.equal(body.lead.status, 'in_progress');
    assert.ok(body.lead.speed_to_lead_seconds !== undefined);
  });

  test('POST /api/crm/leads/:id/disposition logs call outcome and updates status', async () => {
    db.prepare("INSERT INTO crm_leads (id, name, phone_number, status) VALUES ('l2', 'Client 2', '222', 'in_progress')").run();

    const req = mockRequest('POST', '/api/crm/leads/l2/disposition', {
      caller_id: 'c1',
      disposition: 'callback_requested',
      notes: 'Customer asked to call back',
      callback_time: '2026-10-26T18:00:00Z'
    });
    const res = mockResponse();

    await handleCrmRequest(req, res, db);

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.data);
    assert.equal(body.lead.status, 'callback_set');
    assert.equal(body.lead.next_callback_at, '2026-10-26T18:00:00Z');
  });

  test('GET /api/crm/callers/:id/queue returns prioritized caller queue', async () => {
    db.prepare("INSERT INTO crm_leads (id, name, phone_number, status, assigned_caller_id) VALUES ('l3', 'Client 3', '333', 'fresh', 'c1')").run();

    const req = mockRequest('GET', '/api/crm/callers/c1/queue');
    const res = mockResponse();

    await handleCrmRequest(req, res, db);

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.data);
    assert.equal(body.success, true);
    assert.equal(body.queue.length, 1);
    assert.equal(body.queue[0].id, 'l3');
  });

  test('POST /api/crm/callers/:id/status updates duty status', async () => {
    const req = mockRequest('POST', '/api/crm/callers/c1/status', { status: 'break' });
    const res = mockResponse();

    await handleCrmRequest(req, res, db);

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.data);
    assert.equal(body.caller.status, 'break');
  });

  test('GET /api/crm/callers lists all callers', async () => {
    const req = mockRequest('GET', '/api/crm/callers');
    const res = mockResponse();

    await handleCrmRequest(req, res, db);

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.data);
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.callers));
    assert.equal(body.callers.length, 1);
    assert.equal(body.callers[0].id, 'c1');
  });

  test('POST /api/crm/callers creates a new caller', async () => {
    const req = mockRequest('POST', '/api/crm/callers', {
      id: 'c2',
      name: 'Rahim',
      pin: '5678'
    });
    const res = mockResponse();

    await handleCrmRequest(req, res, db);

    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.data);
    assert.equal(body.success, true);
    assert.equal(body.caller.id, 'c2');
    assert.equal(body.caller.name, 'Rahim');
    assert.equal(body.caller.status, 'offline');
  });

  test('Returns 404 for unknown CRM route', async () => {
    const req = mockRequest('GET', '/api/crm/unknown');
    const res = mockResponse();

    const handled = await handleCrmRequest(req, res, db);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.data);
    assert.equal(body.success, false);
  });

  test('GET /crm returns index.html with text/html', async () => {
    const req = mockRequest('GET', '/crm');
    const res = mockResponse();

    const handled = await handleCrmRequest(req, res, db);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'text/html');
    assert.ok(res.data.includes('<!DOCTYPE html>'));
    assert.ok(res.data.includes('Telecaller CRM'));
  });

  test('GET /crm/ returns index.html with text/html', async () => {
    const req = mockRequest('GET', '/crm/');
    const res = mockResponse();

    const handled = await handleCrmRequest(req, res, db);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'text/html');
    assert.ok(res.data.includes('<!DOCTYPE html>'));
  });

  test('GET /crm/styles.css returns styles.css with text/css', async () => {
    const req = mockRequest('GET', '/crm/styles.css');
    const res = mockResponse();

    const handled = await handleCrmRequest(req, res, db);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'text/css');
    assert.ok(res.data.includes('--bg-color'));
    assert.ok(res.data.includes('#0b0f19'));
  });

  test('GET /crm/dialer.js returns dialer.js with application/javascript', async () => {
    const req = mockRequest('GET', '/crm/dialer.js');
    const res = mockResponse();

    const handled = await handleCrmRequest(req, res, db);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'application/javascript');
    assert.ok(res.data.includes('playChime'));
    assert.ok(res.data.includes('loadQueue'));
  });

  test('POST /api/crm/leads/:id/notes saves timestamped note and returns it', async () => {
    db.prepare("INSERT INTO crm_leads (id, name, phone_number, status) VALUES ('l_note', 'Note Lead', '8801999', 'fresh')").run();

    const req = mockRequest('POST', '/api/crm/leads/l_note/notes', {
      caller_id: 'c1',
      note: 'Customer wants a demo tomorrow at 4 PM'
    });
    const res = mockResponse();

    await handleCrmRequest(req, res, db);

    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.data);
    assert.equal(body.success, true);
    assert.equal(body.note.lead_id, 'l_note');
    assert.equal(body.note.caller_id, 'c1');
    assert.equal(body.note.note, 'Customer wants a demo tomorrow at 4 PM');
    assert.ok(body.note.created_at);
  });

  test('GET /api/crm/leads/:id/history returns first contact time, call logs, and notes', async () => {
    db.prepare("INSERT INTO crm_leads (id, name, phone_number, status, created_at) VALUES ('l_hist', 'Hist Lead', '+8801711223344', 'in_progress', '2026-10-15 12:30:00')").run();

    // Log call disposition
    const dispReq = mockRequest('POST', '/api/crm/leads/l_hist/disposition', {
      caller_id: 'c1',
      disposition: 'ringing_no_answer',
      notes: 'No answer on first attempt'
    });
    await handleCrmRequest(dispReq, mockResponse(), db);

    // Add note 1
    const noteReq1 = mockRequest('POST', '/api/crm/leads/l_hist/notes', {
      caller_id: 'c1',
      note: 'First note: Sent product brochure'
    });
    await handleCrmRequest(noteReq1, mockResponse(), db);

    // Add note 2
    const noteReq2 = mockRequest('POST', '/api/crm/leads/l_hist/notes', {
      caller_id: 'c1',
      note: 'Second note: Followed up with pricing'
    });
    await handleCrmRequest(noteReq2, mockResponse(), db);

    const req = mockRequest('GET', '/api/crm/leads/l_hist/history');
    const res = mockResponse();

    await handleCrmRequest(req, res, db);

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.data);
    assert.equal(body.success, true);
    assert.ok(body.first_contact_at.includes('2026-10-15'));
    assert.equal(body.call_history.length, 1);
    assert.equal(body.call_history[0].disposition, 'ringing_no_answer');
    assert.equal(body.call_history[0].call_notes, 'No answer on first attempt');
    assert.equal(body.notes.length, 2);
    assert.equal(body.notes[0].note, 'Second note: Followed up with pricing');
    assert.equal(body.notes[1].note, 'First note: Sent product brochure');
  });
});
