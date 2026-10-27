# CRM Admin Panel & Dashboard PIN Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement full-dashboard 4-digit PIN authentication (`6700`) and a comprehensive CRM Admin Hub tab (`📞 টেলি-কলার CRM`) inside the official paper dashboard (`/`).

**Architecture:** 
1. PIN authentication validated via `POST /api/auth/verify-pin` and enforced through a modal lock overlay on `src/dashboard.html` backed by `sessionStorage`.
2. Backend CRM Admin data layer in `src/crm/db.js` and `src/crm/api.js` providing aggregated KPI pipeline counts, caller performance metrics, searchable/filterable lead exploration, and inline lead reassignment.
3. Clean paper-styled responsive UI in `src/dashboard.html` adhering to the existing black-and-white print document aesthetic with mobile-friendly touch targets.

**Tech Stack:** Node.js (CommonJS), `better-sqlite3`, Native Node test runner (`node --test`), Vanilla HTML5/CSS3/JavaScript.

**Spec:** `docs/superpowers/specs/2026-10-27-crm-admin-panel-and-pin-auth-design.md`

## Global Constraints
- Engine: Node.js (CommonJS `require`/`module.exports`).
- Security: Default PIN is strictly `6700`, configurable via `DASHBOARD_PIN` in `.env`.
- Database: `better-sqlite3` with foreign keys enabled and WAL mode.
- SLA & Lead Source: CRM tracks both fresh inbound bot leads and manual entries; phone numbers normalized with international country codes.
- Test runner: `node --test tests/*.test.js`. Zero regressions allowed across all 62 existing test suites.

---

### Task 1: Dashboard PIN Verification API & Config

**Files:**
- Modify: `src/config.js`
- Modify: `src/server.js`
- Create: `tests/auth-pin.test.js`

**Interfaces:**
- Produces:
  - `DASHBOARD_PIN`: exported from `src/config.js`.
  - `POST /api/auth/verify-pin`: returns `{ success: true }` on valid PIN, `{ success: false, error: 'Incorrect PIN' }` with HTTP 401 on failure.

- [ ] **Step 1: Write the failing test**

Create `tests/auth-pin.test.js`:
```javascript
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const Database = require('better-sqlite3');
const { initDb } = require('../src/db');
const { startWebServer } = require('../src/server');

describe('Dashboard PIN Authentication API', () => {
  let server;
  let baseUrl;
  let db;

  test('setup test server', async () => {
    db = new Database(':memory:');
    initDb(db);
    server = startWebServer({ db, client: null, port: 0 });
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;
  });

  test('POST /api/auth/verify-pin rejects incorrect PIN', async () => {
    const res = await fetch(`${baseUrl}/api/auth/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '0000' })
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'Incorrect PIN');
  });

  test('POST /api/auth/verify-pin accepts correct PIN (6700)', async () => {
    const res = await fetch(`${baseUrl}/api/auth/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '6700' })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
  });

  test('teardown server', async () => {
    if (server) server.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/auth-pin.test.js`  
Expected: FAIL with 404 on `/api/auth/verify-pin`.

- [ ] **Step 3: Implement DASHBOARD_PIN in config & verify-pin route in server**

Update `src/config.js`:
```javascript
DASHBOARD_PIN: process.env.DASHBOARD_PIN || '6700'
```

In `src/server.js`:
```javascript
if (req.method === 'POST' && pathname === '/api/auth/verify-pin') {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body || '{}');
      const expectedPin = String(DASHBOARD_PIN || '6700');
      if (parsed.pin && String(parsed.pin).trim() === expectedPin) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Incorrect PIN' }));
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
    }
  });
  return;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/auth-pin.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit changes**

```bash
git add src/config.js src/server.js tests/auth-pin.test.js
git commit -m "feat(auth): add dashboard pin verification api endpoint"
```

---

### Task 2: CRM Admin Overview & KPI Aggregation API

**Files:**
- Modify: `src/crm/db.js`
- Modify: `src/crm/api.js`
- Create: `tests/crm-admin-api.test.js`

**Interfaces:**
- Produces:
  - `getCrmAdminOverview(db)`: returns `{ kpis, callers, recent_calls }`.
  - `GET /api/crm/admin/overview`: HTTP endpoint returning the overview JSON payload.

- [ ] **Step 1: Write the failing test**

Create `tests/crm-admin-api.test.js`:
```javascript
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
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/crm-admin-api.test.js`  
Expected: FAIL with `getCrmAdminOverview is not a function`.

- [ ] **Step 3: Implement getCrmAdminOverview & router**

In `src/crm/db.js`:
```javascript
function getCrmAdminOverview(db) {
  const kpis = db.prepare(`
    SELECT
      COUNT(*) AS total_leads,
      COALESCE(SUM(CASE WHEN status = 'fresh' THEN 1 ELSE 0 END), 0) AS fresh_leads,
      COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) AS in_progress_leads,
      COALESCE(SUM(CASE WHEN status = 'callback_set' AND (next_callback_at <= datetime('now') OR next_callback_at IS NULL) THEN 1 ELSE 0 END), 0) AS callback_due_leads,
      COALESCE(SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END), 0) AS won_leads,
      COALESCE(SUM(CASE WHEN status IN ('lost', 'unreachable') THEN 1 ELSE 0 END), 0) AS lost_leads
    FROM crm_leads
  `).get();

  const callers = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM crm_call_logs l WHERE l.caller_id = c.id AND date(l.created_at) = date('now')) AS today_calls
    FROM crm_callers c
    ORDER BY c.created_at ASC
  `).all();

  const recentCalls = db.prepare(`
    SELECT l.*, c.name AS caller_name, lead.phone_number, lead.name AS lead_name
    FROM crm_call_logs l
    LEFT JOIN crm_callers c ON l.caller_id = c.id
    LEFT JOIN crm_leads lead ON l.lead_id = lead.id
    ORDER BY l.created_at DESC, l.rowid DESC
    LIMIT 20
  `).all();

  return { kpis, callers, recent_calls: recentCalls };
}
```

In `src/crm/api.js`:
Mount `GET /api/crm/admin/overview`:
```javascript
if (method === 'GET' && pathname === '/api/crm/admin/overview') {
  const overview = getCrmAdminOverview(db);
  sendJson(res, 200, { success: true, ...overview });
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/crm-admin-api.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit changes**

```bash
git add src/crm/db.js src/crm/api.js tests/crm-admin-api.test.js
git commit -m "feat(crm): implement crm admin overview kpi api"
```

---

### Task 3: CRM Admin Lead Pipeline Filtering & Reassignment API

**Files:**
- Modify: `src/crm/db.js`
- Modify: `src/crm/api.js`
- Create: `tests/crm-admin-leads.test.js`

**Interfaces:**
- Produces:
  - `getAdminLeads(db, { search, status, caller_id, limit, offset })`: returns `{ leads, total }`.
  - `reassignLead(db, leadId, newCallerId)`: updates assigned caller and records history in `crm_lead_assignments`.
  - `GET /api/crm/admin/leads`: returns paginated filtered leads.
  - `POST /api/crm/admin/leads/:id/reassign`: reassigns lead to target caller.

- [ ] **Step 1: Write the failing test**

Create `tests/crm-admin-leads.test.js`:
```javascript
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/crm-admin-leads.test.js`  
Expected: FAIL with `getAdminLeads is not a function`.

- [ ] **Step 3: Implement getAdminLeads & reassignLead in db.js & api.js**

Implement in `src/crm/db.js`:
```javascript
function getAdminLeads(db, { search = '', status = '', caller_id = '', limit = 50, offset = 0 } = {}) {
  let whereClauses = [];
  let params = [];

  if (search && search.trim()) {
    whereClauses.push('(l.phone_number LIKE ? OR l.name LIKE ?)');
    params.push(`%${search.trim()}%`, `%${search.trim()}%`);
  }
  if (status && status !== 'all') {
    whereClauses.push('l.status = ?');
    params.push(status);
  }
  if (caller_id && caller_id !== 'all') {
    if (caller_id === 'unassigned') {
      whereClauses.push('l.assigned_caller_id IS NULL');
    } else {
      whereClauses.push('l.assigned_caller_id = ?');
      params.push(caller_id);
    }
  }

  const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM crm_leads l ${whereSql}`).get(...params);
  const total = countRow ? countRow.total : 0;

  const leads = db.prepare(`
    SELECT l.*, c.name AS caller_name
    FROM crm_leads l
    LEFT JOIN crm_callers c ON l.assigned_caller_id = c.id
    ${whereSql}
    ORDER BY l.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return { leads, total };
}

function reassignLead(db, leadId, newCallerId) {
  db.prepare(`
    UPDATE crm_leads
    SET assigned_caller_id = ?,
        status = CASE WHEN status = 'fresh' THEN 'fresh' ELSE 'in_progress' END
    WHERE id = ?
  `).run(newCallerId || null, leadId);

  if (newCallerId) {
    const assignId = 'assign_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    db.prepare(`
      INSERT INTO crm_lead_assignments (id, lead_id, caller_id, status)
      VALUES (?, ?, ?, 'assigned')
    `).run(assignId, leadId, newCallerId);
  }

  return getLeadById(db, leadId);
}
```

In `src/crm/api.js`:
Mount `GET /api/crm/admin/leads` and `POST /api/crm/admin/leads/:id/reassign`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/crm-admin-leads.test.js`  
Expected: PASS.

- [ ] **Step 5: Commit changes**

```bash
git add src/crm/db.js src/crm/api.js tests/crm-admin-leads.test.js
git commit -m "feat(crm): add admin lead pipeline search and reassignment apis"
```

---

### Task 4: Frontend Lock Screen Overlay & PIN Authentication Experience

**Files:**
- Modify: `src/dashboard.html`

**Deliverables:**
- Modal lock screen overlay blocking document until PIN is entered.
- PIN entry input with auto-submit or button.
- Verification against `/api/auth/verify-pin`.
- Persistence via `sessionStorage.getItem('dashboard_auth')`.
- Lock button in the dashboard top header (`🔒 Lock`).

- [ ] **Step 1: Implement HTML markup and CSS for lock screen in `src/dashboard.html`**

Add CSS styles:
```css
/* PIN Lock Overlay */
#pin-lock-overlay {
  position: fixed;
  inset: 0;
  background: #000000;
  color: #FFFFFF;
  z-index: 99999;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono);
}
.pin-card {
  border: 3px solid #FFFFFF;
  padding: 30px 24px;
  max-width: 360px;
  width: 90%;
  text-align: center;
  background: #000000;
}
.pin-input {
  width: 180px;
  font-size: 28px;
  letter-spacing: 12px;
  text-align: center;
  background: #111;
  color: #FFF;
  border: 2px solid #FFF;
  padding: 8px 12px;
  margin: 16px 0;
  outline: none;
}
.btn-unlock {
  width: 100%;
  background: #FFF;
  color: #000;
  font-weight: 900;
  font-size: 14px;
  padding: 12px;
  border: none;
  cursor: pointer;
  letter-spacing: 1px;
  text-transform: uppercase;
}
```

Add HTML markup before `</body>`:
```html
<div id="pin-lock-overlay" style="display: none;">
  <div class="pin-card">
    <div style="font-size: 32px; margin-bottom: 8px;">🔒</div>
    <h2 style="font-size: 15px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px;">MUNNI SOFT LEDGER</h2>
    <p style="font-size: 12px; color: #AAA; margin-bottom: 12px;">ENTER 4-DIGIT ADMIN PIN TO ACCESS</p>
    <form onsubmit="handlePinSubmit(event)">
      <input type="password" id="input-admin-pin" class="pin-input" maxlength="4" pattern="[0-9]*" inputmode="numeric" placeholder="••••" required autofocus>
      <div id="pin-error-msg" style="color: #ff6b6b; font-size: 12px; margin-bottom: 12px; display: none;">INCORRECT PIN</div>
      <button type="submit" id="btn-unlock-dashboard" class="btn-unlock">UNLOCK DASHBOARD</button>
    </form>
  </div>
</div>
```

- [ ] **Step 2: Add PIN authentication logic & Header Lock button**

```javascript
function checkDashboardAuth() {
  const isAuth = sessionStorage.getItem('dashboard_auth') === 'true';
  const overlay = document.getElementById('pin-lock-overlay');
  if (!isAuth) {
    if (overlay) overlay.style.display = 'flex';
    const input = document.getElementById('input-admin-pin');
    if (input) setTimeout(() => input.focus(), 100);
  } else {
    if (overlay) overlay.style.display = 'none';
  }
}

async function handlePinSubmit(e) {
  if (e) e.preventDefault();
  const input = document.getElementById('input-admin-pin');
  const errEl = document.getElementById('pin-error-msg');
  const pin = input ? input.value.trim() : '';

  try {
    const res = await fetch('/api/auth/verify-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    const data = await res.json();
    if (data.success) {
      sessionStorage.setItem('dashboard_auth', 'true');
      const overlay = document.getElementById('pin-lock-overlay');
      if (overlay) overlay.style.display = 'none';
      if (input) input.value = '';
      if (errEl) errEl.style.display = 'none';
    } else {
      if (errEl) { errEl.textContent = data.error || 'INCORRECT PIN'; errEl.style.display = 'block'; }
      if (input) { input.value = ''; input.focus(); }
    }
  } catch (err) {
    if (errEl) { errEl.textContent = 'NETWORK ERROR'; errEl.style.display = 'block'; }
  }
}

function lockDashboard() {
  sessionStorage.removeItem('dashboard_auth');
  checkDashboardAuth();
}
```

- [ ] **Step 3: Verify manually with curl / unit tests**

Verify: `GET /` serves lock overlay and `POST /api/auth/verify-pin` unlocks.

- [ ] **Step 4: Commit changes**

```bash
git add src/dashboard.html
git commit -m "feat(dashboard): add 4-digit pin lock overlay and session auth"
```

---

### Task 5: Frontend `📞 টেলি-কলার CRM` Tab & Admin Hub Interface

**Files:**
- Modify: `src/dashboard.html`

**Deliverables:**
- Tab button `📞 টেলি-কলার CRM` added to navigation bar.
- `#tab-crm` content container containing:
  1. KPI Metrics Grid (Total, Fresh, In Progress, Callbacks Due, Won, Lost).
  2. Telecaller Team Table + Status Switchers + Open Dialer deep-link buttons.
  3. Lead Pipeline Explorer with real-time search & status/caller filter.
  4. Live Call History Audit Feed.
  5. Add Caller modal.

- [ ] **Step 1: Add Tab Button & CRM Container markup in `src/dashboard.html`**

Add navigation tab button:
```html
<button class="tab-btn" data-tab="crm" onclick="setTab('crm')">📞 টেলি-কলার CRM</button>
```

Add `#tab-crm` view containing:
- KPI summary boxes matching `.perf-box` styling.
- Callers table with `🟢 On Duty`, `🟡 Break`, `⚪ Offline` dropdowns.
- Search and filter bar for leads with status and caller selectors.
- Paginated lead pipeline table.
- Recent 20 calls audit stream.

- [ ] **Step 2: Add client-side controller logic for CRM Admin**

Implement:
- `loadCrmAdminOverview()`: fetches `/api/crm/admin/overview` and updates KPI counts, caller rows, and recent call feed.
- `loadCrmAdminLeads(page)`: fetches `/api/crm/admin/leads` based on search input and filter dropdowns.
- `handleReassignLead(leadId, callerId)`: posts to `/api/crm/admin/leads/:id/reassign`.
- `handleCallerStatusChange(callerId, status)`: posts to `/api/crm/callers/:id/status`.
- `handleCreateCaller(event)`: posts to `/api/crm/callers` and refreshes overview.
- Automatic refresh hook when `setTab('crm')` is clicked.

- [ ] **Step 3: Run regression test suite**

Run: `npm test`  
Expected: All tests pass.

- [ ] **Step 4: Commit changes**

```bash
git add src/dashboard.html
git commit -m "feat(crm): embed full crm admin hub tab into ledger dashboard"
```

---

### Task 6: End-to-End Verification & Documentation

**Files:**
- Modify: `task-tracking.md`

- [ ] **Step 1: Run complete test suite across entire repository**

Run: `npm --prefix D:\munnisoft-v2 test`  
Expected: All 332+ tests across all test suites pass with 0 errors.

- [ ] **Step 2: Test live dashboard endpoints**

Verify:
- `GET /` returns HTML with lock overlay and `📞 টেলি-কলার CRM` tab.
- `POST /api/auth/verify-pin` unlocks with `6700`.
- `GET /api/crm/admin/overview` returns KPI summary and caller data.
- `GET /api/crm/admin/leads` returns filtered leads.

- [ ] **Step 3: Update `task-tracking.md` and commit**

```bash
git add task-tracking.md
git commit -m "docs: complete crm admin panel and dashboard pin auth plan"
```
