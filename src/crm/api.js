const fs = require('fs');
const path = require('path');
const {
  insertLead,
  getLeadById,
  createCaller,
  getCallerById,
  updateCallerStatus,
  addLeadNote,
  getLeadHistory,
  getCrmAdminOverview
} = require('./db');
const {
  assignFreshLead,
  claimLead,
  checkAndEscalateTimeouts
} = require('./routing');
const {
  logCallDisposition,
  getCallerQueue
} = require('./queue');

function sendJson(res, statusCode, data) {
  res.statusCode = statusCode;
  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'application/json');
  }
  res.end(JSON.stringify(data));
}

async function parseRequestBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      if (!req.body.trim()) return {};
      try {
        return JSON.parse(req.body);
      } catch {
        return {};
      }
    }
    if (typeof req.body === 'object') {
      return req.body;
    }
  }

  if (typeof req.on === 'function') {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => {
        data += chunk;
      });
      req.on('end', () => {
        if (!data.trim()) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({});
        }
      });
      req.on('error', err => reject(err));
    });
  }

  return {};
}

async function handleCrmRequest(req, res, db) {
  const method = (req.method || 'GET').toUpperCase();
  const rawUrl = req.url || '/';
  const pathname = rawUrl.split('?')[0].replace(/\/+$/, '') || '/';

  // Static Frontend Routes
  if (method === 'GET' && (pathname === '/crm' || pathname === '/crm/')) {
    const filePath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(filePath)) {
      const html = fs.readFileSync(filePath, 'utf8');
      res.statusCode = 200;
      if (typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'text/html');
      }
      res.end(html);
      return true;
    }
  }

  if (method === 'GET' && pathname === '/crm/styles.css') {
    const filePath = path.join(__dirname, 'public', 'styles.css');
    if (fs.existsSync(filePath)) {
      const css = fs.readFileSync(filePath, 'utf8');
      res.statusCode = 200;
      if (typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'text/css');
      }
      res.end(css);
      return true;
    }
  }

  if (method === 'GET' && pathname === '/crm/dialer.js') {
    const filePath = path.join(__dirname, 'public', 'dialer.js');
    if (fs.existsSync(filePath)) {
      const js = fs.readFileSync(filePath, 'utf8');
      res.statusCode = 200;
      if (typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'application/javascript');
      }
      res.end(js);
      return true;
    }
  }

  if (!pathname.startsWith('/api/crm')) {
    return false;
  }

  try {
    // 0. GET /api/crm/admin/overview - Aggregated CRM pipeline KPIs, callers, and recent calls
    if (method === 'GET' && pathname === '/api/crm/admin/overview') {
      const overview = getCrmAdminOverview(db);
      sendJson(res, 200, {
        success: true,
        ...overview
      });
      return true;
    }

    // 1. POST /api/crm/leads - Ingest lead & assign round-robin
    if (method === 'POST' && pathname === '/api/crm/leads') {
      const body = await parseRequestBody(req);
      const leadId = body.id || 'lead_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      const inserted = insertLead(db, {
        id: leadId,
        name: body.name,
        phone_number: body.phone_number,
        source: body.source || 'whatsapp'
      });

      const assignment = assignFreshLead(db, inserted.id);
      const lead = getLeadById(db, inserted.id);

      sendJson(res, 201, {
        success: true,
        lead,
        assignment
      });
      return true;
    }

    // 2. POST /api/crm/leads/:id/claim - Lock lead to caller
    const claimMatch = pathname.match(/^\/api\/crm\/leads\/([^/]+)\/claim$/);
    if (method === 'POST' && claimMatch) {
      const leadId = claimMatch[1];
      const body = await parseRequestBody(req);
      const callerId = body.caller_id || body.callerId;

      const lead = claimLead(db, leadId, callerId);
      sendJson(res, 200, {
        success: true,
        lead
      });
      return true;
    }

    // 3. POST /api/crm/leads/:id/disposition - Log call outcome & update status
    const dispositionMatch = pathname.match(/^\/api\/crm\/leads\/([^/]+)\/disposition$/);
    if (method === 'POST' && dispositionMatch) {
      const leadId = dispositionMatch[1];
      const body = await parseRequestBody(req);

      const lead = logCallDisposition(db, {
        leadId,
        callerId: body.caller_id || body.callerId,
        disposition: body.disposition,
        notes: body.notes || body.call_notes,
        callbackTime: body.callback_time || body.callbackTime
      });

      sendJson(res, 200, {
        success: true,
        lead
      });
      return true;
    }

    // 4. POST /api/crm/leads/:id/notes - Save timestamped note
    const notesMatch = pathname.match(/^\/api\/crm\/leads\/([^/]+)\/notes$/);
    if (method === 'POST' && notesMatch) {
      const leadId = notesMatch[1];
      const body = await parseRequestBody(req);
      const note = addLeadNote(db, {
        leadId,
        callerId: body.caller_id || body.callerId || null,
        note: body.note
      });

      sendJson(res, 201, {
        success: true,
        note
      });
      return true;
    }

    // 5. GET /api/crm/leads/:id/history - Lead first contact, call history & notes
    const historyMatch = pathname.match(/^\/api\/crm\/leads\/([^/]+)\/history$/);
    if (method === 'GET' && historyMatch) {
      const leadId = historyMatch[1];
      const history = getLeadHistory(db, leadId);
      if (!history) {
        sendJson(res, 404, {
          success: false,
          error: 'Lead not found'
        });
        return true;
      }

      sendJson(res, 200, {
        success: true,
        first_contact_at: history.first_contact_at,
        call_history: history.call_history,
        notes: history.notes,
        lead: history.lead
      });
      return true;
    }

    // 6. GET /api/crm/callers/:id/queue - Prioritized caller queue
    const queueMatch = pathname.match(/^\/api\/crm\/callers\/([^/]+)\/queue$/);
    if (method === 'GET' && queueMatch) {
      const callerId = queueMatch[1];
      checkAndEscalateTimeouts(db);
      const queue = getCallerQueue(db, callerId);

      sendJson(res, 200, {
        success: true,
        queue
      });
      return true;
    }

    // 7. POST /api/crm/callers/:id/status - Update duty status
    const statusMatch = pathname.match(/^\/api\/crm\/callers\/([^/]+)\/status$/);
    if (method === 'POST' && statusMatch) {
      const callerId = statusMatch[1];
      const body = await parseRequestBody(req);
      const caller = updateCallerStatus(db, callerId, body.status);

      sendJson(res, 200, {
        success: true,
        caller
      });
      return true;
    }

    // 8. GET /api/crm/callers - List all callers
    if (method === 'GET' && pathname === '/api/crm/callers') {
      const callers = db.prepare('SELECT * FROM crm_callers ORDER BY created_at ASC').all();
      sendJson(res, 200, {
        success: true,
        callers
      });
      return true;
    }

    // 9. POST /api/crm/callers - Create new caller
    if (method === 'POST' && pathname === '/api/crm/callers') {
      const body = await parseRequestBody(req);
      const callerId = body.id || 'caller_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      const shiftSchedule = typeof body.shift_schedule_json === 'object'
        ? JSON.stringify(body.shift_schedule_json)
        : (body.shift_schedule_json || '{}');

      const caller = createCaller(db, {
        id: callerId,
        name: body.name,
        pin: body.pin,
        shift_schedule_json: shiftSchedule
      });

      sendJson(res, 201, {
        success: true,
        caller
      });
      return true;
    }

    // 404 for unmatched CRM endpoints
    sendJson(res, 404, {
      success: false,
      error: 'Endpoint not found'
    });
    return true;
  } catch (err) {
    const isNotFound = err.message && err.message.toLowerCase().includes('not found');
    sendJson(res, isNotFound ? 404 : 400, {
      success: false,
      error: err.message
    });
    return true;
  }
}

module.exports = {
  handleCrmRequest
};
