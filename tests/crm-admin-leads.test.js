const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initCrmDb, createCaller, insertLead, getAdminLeads, reassignLead } = require('../src/crm/db');
const { handleCrmRequest } = require('../src/crm/api');

describe('CRM Admin Lead Pipeline API', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    initCrmDb(db);
    createCaller(db, { id: 'c1', name: 'Tanvir', pin: '1234' });
    createCaller(db, { id: 'c2', name: 'Rahim', pin: '5678' });
    insertLead(db, { id: 'l1', name: 'Alice', phone_number: '+8801711111111' });
    insertLead(db, { id: 'l2', name: 'Bob', phone_number: '+8801722222222' });
  });

  test('getAdminLeads filters by search query and status', () => {
    const results = getAdminLeads(db, { search: 'Alice' });
    assert.equal(results.leads.length, 1);
    assert.equal(results.leads[0].name, 'Alice');

    const empty = getAdminLeads(db, { status: 'won' });
    assert.equal(empty.leads.length, 0);
  });

  test('reassignLead updates lead assignment', () => {
    const updated = reassignLead(db, 'l1', 'c2');
    assert.equal(updated.assigned_caller_id, 'c2');
  });

  test('POST /api/crm/admin/leads/:id/reassign updates caller via API', async () => {
    const req = {
      method: 'POST',
      url: '/api/crm/admin/leads/l1/reassign',
      body: JSON.stringify({ caller_id: 'c2' })
    };
    const res = {
      statusCode: 200,
      headers: {},
      data: '',
      setHeader(k, v) { this.headers[k] = v; },
      end(chunk) { if (chunk) this.data += chunk; }
    };

    const handled = await handleCrmRequest(req, res, db);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.data);
    assert.equal(body.lead.assigned_caller_id, 'c2');
  });

  test('GET /api/crm/admin/leads returns list with total', async () => {
    const req = {
      method: 'GET',
      url: '/api/crm/admin/leads?limit=10',
      headers: {}
    };
    const res = {
      statusCode: 200,
      headers: {},
      data: '',
      setHeader(k, v) { this.headers[k] = v; },
      end(chunk) { if (chunk) this.data += chunk; }
    };

    const handled = await handleCrmRequest(req, res, db);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.data);
    assert.equal(body.success, true);
    assert.equal(body.leads.length, 2);
    assert.equal(body.total, 2);
  });
});
