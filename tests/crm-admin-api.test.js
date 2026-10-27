const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initCrmDb, createCaller, insertLead, getCrmAdminOverview } = require('../src/crm/db');
const { handleCrmRequest } = require('../src/crm/api');

describe('CRM Admin Overview API', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    initCrmDb(db);
    createCaller(db, { id: 'c1', name: 'Tanvir', pin: '1234' });
    insertLead(db, { id: 'l1', name: 'Lead 1', phone_number: '+8801700000001' });
    insertLead(db, { id: 'l2', name: 'Lead 2', phone_number: '+8801700000002' });
  });

  test('getCrmAdminOverview returns counts, callers, and recent calls', () => {
    const overview = getCrmAdminOverview(db);
    assert.equal(overview.kpis.total_leads, 2);
    assert.equal(overview.kpis.fresh_leads, 2);
    assert.equal(overview.callers.length, 1);
    assert.equal(overview.callers[0].name, 'Tanvir');
    assert.ok(Array.isArray(overview.recent_calls));
  });

  test('GET /api/crm/admin/overview returns 200 with overview payload', async () => {
    const req = {
      method: 'GET',
      url: '/api/crm/admin/overview',
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
    assert.equal(body.kpis.total_leads, 2);
    assert.equal(body.callers.length, 1);
  });
});
