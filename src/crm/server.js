const http = require('http');
const Database = require('better-sqlite3');
const path = require('path');
const { initCrmDb, createCaller, getCallerById, updateCallerStatus } = require('./db');
const { handleCrmRequest } = require('./api');
const { DB_PATH } = require('../config');

// Open database and initialize CRM schema
const crmDbPath = DB_PATH || path.join(__dirname, '..', '..', 'data', 'ledger.db');
const db = new Database(crmDbPath);
initCrmDb(db);

// Seed default callers if none exist
const callersCount = db.prepare('SELECT COUNT(*) as count FROM crm_callers').get().count;
if (callersCount === 0) {
  const fullWeekShift = JSON.stringify({
    mon: [{ start: '00:00', end: '23:59' }],
    tue: [{ start: '00:00', end: '23:59' }],
    wed: [{ start: '00:00', end: '23:59' }],
    thu: [{ start: '00:00', end: '23:59' }],
    fri: [{ start: '00:00', end: '23:59' }],
    sat: [{ start: '00:00', end: '23:59' }],
    sun: [{ start: '00:00', end: '23:59' }]
  });

  createCaller(db, {
    id: 'caller_1',
    name: 'Caller 1 (Tanvir)',
    pin: '1234',
    shift_schedule_json: fullWeekShift
  });
  updateCallerStatus(db, 'caller_1', 'active');

  createCaller(db, {
    id: 'caller_2',
    name: 'Caller 2 (Agent)',
    pin: '5678',
    shift_schedule_json: fullWeekShift
  });
  updateCallerStatus(db, 'caller_2', 'active');

  console.log('🌱 Seeded default callers: caller_1 (Tanvir) and caller_2 (Agent) as Active');
}

const PORT = process.env.CRM_PORT || 3001;

const server = http.createServer(async (req, res) => {
  const handled = await handleCrmRequest(req, res, db);
  if (!handled) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Not Found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('====================================================');
  console.log(`🚀 Telecaller CRM running on port ${PORT}`);
  console.log(`📱 Caller 1 Workspace: http://localhost:${PORT}/crm?caller_id=caller_1`);
  console.log(`📱 Caller 2 Workspace: http://localhost:${PORT}/crm?caller_id=caller_2`);
  console.log(`🌐 On Mobile Phone:    http://<YOUR_COMPUTER_IP>:${PORT}/crm`);
  console.log('====================================================');
});

// Periodic background escalation check every 5 seconds
const { checkAndEscalateTimeouts } = require('./routing');
setInterval(() => {
  try {
    const escalations = checkAndEscalateTimeouts(db);
    if (escalations.length > 0) {
      console.log(`⚡ Auto-escalated ${escalations.length} timed-out lead(s) to next caller`);
    }
  } catch (err) {
    console.error('Escalation check error:', err.message);
  }
}, 5000);
