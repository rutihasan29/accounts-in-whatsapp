const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  initCrmDb,
  createCaller,
  getCallerById,
  updateCallerStatus,
  insertLead,
  getLeadById,
  getSetting,
  setSetting
} = require('../src/crm/db');

describe('CRM Database Module', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    initCrmDb(db);
  });

  test('creates tables and inserts caller successfully', () => {
    const caller = createCaller(db, {
      id: 'caller_1',
      name: 'Tanvir',
      pin: '1234',
      shift_schedule_json: JSON.stringify({ mon: [{ start: '09:00', end: '17:00' }] })
    });

    assert.equal(caller.id, 'caller_1');
    assert.equal(caller.status, 'offline');

    const fetched = getCallerById(db, 'caller_1');
    assert.equal(fetched.name, 'Tanvir');
  });

  test('updates caller status between active, break, offline', () => {
    createCaller(db, { id: 'caller_1', name: 'Tanvir', pin: '1234' });
    updateCallerStatus(db, 'caller_1', 'active');
    assert.equal(getCallerById(db, 'caller_1').status, 'active');

    updateCallerStatus(db, 'caller_1', 'break');
    assert.equal(getCallerById(db, 'caller_1').status, 'break');
  });

  test('inserts fresh lead and queries by id', () => {
    const lead = insertLead(db, {
      id: 'lead_101',
      name: 'Rahim Ahmed',
      phone_number: '+8801700000000',
      source: 'facebook_ad'
    });

    assert.equal(lead.id, 'lead_101');
    assert.equal(lead.status, 'fresh');
    assert.ok(lead.created_at);

    const fetched = getLeadById(db, 'lead_101');
    assert.equal(fetched.name, 'Rahim Ahmed');
    assert.equal(fetched.phone_number, '+8801700000000');
  });

  test('gets and sets settings', () => {
    assert.equal(getSetting(db, 'test_key', 'default_val'), 'default_val');
    setSetting(db, 'test_key', 'stored_val');
    assert.equal(getSetting(db, 'test_key'), 'stored_val');
  });
});
