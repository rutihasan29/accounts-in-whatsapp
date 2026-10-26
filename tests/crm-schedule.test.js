const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initCrmDb, createCaller, updateCallerStatus } = require('../src/crm/db');
const { isCallerOnShift, getEligibleCallers } = require('../src/crm/schedule');

describe('CRM Shift Schedule Engine', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    initCrmDb(db);
  });

  test('isCallerOnShift returns true during scheduled window and false outside', () => {
    const schedule = {
      mon: [{ start: '09:00', end: '17:00' }],
      tue: [{ start: '13:00', end: '21:00' }]
    };

    // Monday at 10:30 AM
    const mon1030 = new Date('2026-10-26T10:30:00'); // Note: 2026-10-26 is Monday
    assert.equal(isCallerOnShift(schedule, mon1030), true);

    // Monday at 18:00 (after shift)
    const mon1800 = new Date('2026-10-26T18:00:00');
    assert.equal(isCallerOnShift(schedule, mon1800), false);

    // Tuesday at 14:00 (inside Tuesday shift)
    const tue1400 = new Date('2026-10-27T14:00:00');
    assert.equal(isCallerOnShift(schedule, tue1400), true);
  });

  test('getEligibleCallers filters by both on-shift schedule AND active status', () => {
    // Caller 1: Mon 09:00 - 17:00
    createCaller(db, {
      id: 'c1',
      name: 'Morning Caller',
      pin: '1111',
      shift_schedule_json: JSON.stringify({ mon: [{ start: '09:00', end: '17:00' }] })
    });

    // Caller 2: Mon 13:00 - 21:00 (Overlapping with c1 from 13:00 to 17:00)
    createCaller(db, {
      id: 'c2',
      name: 'Evening Caller',
      pin: '2222',
      shift_schedule_json: JSON.stringify({ mon: [{ start: '13:00', end: '21:00' }] })
    });

    const mon1400 = new Date('2026-10-26T14:00:00');

    // Both are offline initially
    let eligible = getEligibleCallers(db, mon1400);
    assert.equal(eligible.length, 0);

    // Turn C1 active
    updateCallerStatus(db, 'c1', 'active');
    eligible = getEligibleCallers(db, mon1400);
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].id, 'c1');

    // Turn C2 active (overlapping shift at 14:00)
    updateCallerStatus(db, 'c2', 'active');
    eligible = getEligibleCallers(db, mon1400);
    assert.equal(eligible.length, 2);

    // Put C1 on break
    updateCallerStatus(db, 'c1', 'break');
    eligible = getEligibleCallers(db, mon1400);
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].id, 'c2');
  });
});
