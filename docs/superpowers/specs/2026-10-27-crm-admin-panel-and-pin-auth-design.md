# CRM Admin Panel & Dashboard PIN Security Design Spec

**Date:** 2026-10-27  
**Status:** Approved  
**Target Workspace:** `D:\munnisoft-v2`  

---

## 1. Overview & Goals

This specification details the addition of two major capabilities to the Munni Soft system:
1. **Full-Dashboard PIN Authentication (`6700`)**: Prevents unauthorized viewing of financial ledgers, customer contact details, bot controls, and CRM operations.
2. **Integrated CRM Admin Hub**: Embeds a dedicated `📞 টেলি-কলার CRM` administrative tab inside the official paper dashboard (`/`), giving supervisors and admins full visibility and control over team operations, call logs, caller accounts, and the 6,300+ lead pipeline.

---

## 2. Security & Dashboard PIN Authentication

### 2.1 Configuration
- Stored in `.env` as `DASHBOARD_PIN=6700`.
- Loaded in `src/config.js` with fallback to `'6700'`.

### 2.2 API Endpoint
- **`POST /api/auth/verify-pin`**:
  - Request: `{ "pin": "6700" }`
  - Response (Success): `{ "success": true }`
  - Response (Failure): `{ "success": false, "error": "Incorrect PIN" }` with HTTP 401.

### 2.3 User Experience & Lock Overlay
- On page load (`/` or via ngrok), if `sessionStorage.getItem('dashboard_authenticated') !== 'true'`, an opaque lock screen overlay covers the document.
- Interface components:
  - Header: `🔒 MUNNI SOFT SECURE ACCESS`
  - Prompt: `Enter 4-Digit Admin PIN to unlock the dashboard:`
  - Input: `<input type="password" maxlength="4" pattern="[0-9]*" inputmode="numeric">`
  - Unlock Button: `[ 🔓 UNLOCK DASHBOARD ]`
- On valid PIN:
  - Fades out overlay and marks `sessionStorage.setItem('dashboard_authenticated', 'true')`.
- On invalid PIN:
  - Shakes the input field, clears value, and displays `Incorrect PIN. Please try again.`
- Header Lock Button:
  - A small `[ 🔒 Lock ]` button in the dashboard top bar allows re-locking at any time.

---

## 3. CRM Admin Tab (`src/dashboard.html`)

### 3.1 Tab Navigation
- Added alongside existing tabs (`বকেয়া তালিকা`, `সব কাস্টমার`, `পরিশোধিত`, `বট ফিচার কন্ট্রোল`):
  ```html
  <button class="tab-btn" data-tab="crm" onclick="setTab('crm')">📞 টেলি-কলার CRM</button>
  ```

### 3.2 Top KPI Metrics Grid
Displays 6 key operational metrics:
- **Total Leads**: Count of all records in `crm_leads`.
- **🔥 Fresh Queue**: Count of leads with `status = 'fresh'`.
- **📞 In Progress**: Count of leads currently in follow-up.
- **⏰ Callbacks Due**: Count of leads where `status = 'callback_set'` and `next_callback_at <= now`.
- **🏆 Deals Won**: Count of converted leads (`status = 'won'`).
- **📵 Unreachable / Lost**: Count of leads marked unreachable, busy, or not interested.

### 3.3 Telecaller Team Management
- **Callers Table**:
  - Columns: Caller Name, PIN, Shift Schedule, Duty Status, Completed Calls Today, Quick Action.
  - Live Duty Status Dropdown (`active`, `break`, `offline`) updating via `POST /api/crm/callers/:id/status`.
  - Quick Launcher Button: `[ 📞 Open Dialer ]` opening `/crm?caller_id=<id>` in a new tab with caller credentials pre-selected.
- **Add Caller Modal/Drawer**:
  - Input fields: Name, 4-digit PIN, Shift schedule.
  - Submits via `POST /api/crm/callers`.

### 3.4 Lead Pipeline Explorer (Filter & Search)
- Search box: Matches phone numbers or customer names.
- Filters:
  - Status: `All`, `Fresh`, `In Progress`, `Callbacks`, `Won`, `Lost`.
  - Assigned Caller: `All`, `Caller 1`, `Caller 2`, `Unassigned`.
- Table columns:
  - Lead Name & Phone Number.
  - Source (`whatsapp_bot`, `web`, etc.).
  - Status chip badge.
  - Assigned Caller with inline reassignment dropdown (`POST /api/crm/admin/leads/:id/reassign`).
  - Speed-to-Lead seconds & SLA tag (`met_sla` / `breached_sla`).
  - First contact timestamp.

### 3.5 Live Call Audit Stream
- Feed displaying the latest 20 calls logged across the entire team (`crm_call_logs`).
- Displays:
  - Timestamp.
  - Caller name badge.
  - Customer phone number.
  - Outcome badge (`✅ Connected`, `⏰ Callback`, `📳 Ringing`, `📵 Busy`, `🏆 Won`, `❌ Lost`).
  - Call notes / feedback summary.

---

## 4. Backend Architecture & REST APIs

### 4.1 Endpoint: `GET /api/crm/admin/overview`
- Executes aggregated SQL queries over `crm_leads`, `crm_callers`, and `crm_call_logs`:
  ```sql
  SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN status = 'fresh' THEN 1 ELSE 0 END) as fresh,
    SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
    SUM(CASE WHEN status = 'callback_set' AND (next_callback_at <= datetime('now') OR next_callback_at IS NULL) THEN 1 ELSE 0 END) as callback_due,
    SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as won,
    SUM(CASE WHEN status IN ('lost', 'unreachable') THEN 1 ELSE 0 END) as lost
  FROM crm_leads;
  ```
- Queries callers joined with today's call count:
  ```sql
  SELECT c.*, 
    (SELECT COUNT(*) FROM crm_call_logs l WHERE l.caller_id = c.id AND date(l.created_at) = date('now')) as today_calls
  FROM crm_callers c
  ORDER BY c.created_at ASC;
  ```
- Queries last 20 call logs:
  ```sql
  SELECT l.*, c.name as caller_name, lead.phone_number, lead.name as lead_name
  FROM crm_call_logs l
  LEFT JOIN crm_callers c ON l.caller_id = c.id
  LEFT JOIN crm_leads lead ON l.lead_id = lead.id
  ORDER BY l.created_at DESC
  LIMIT 20;
  ```

### 4.2 Endpoint: `GET /api/crm/admin/leads`
- Parameters: `search` (string), `status` (string), `caller_id` (string), `limit` (integer, default 50), `offset` (integer, default 0).
- Dynamically constructs parameterized query against `crm_leads` with `COUNT(*) OVER()` total count.

### 4.3 Endpoint: `POST /api/crm/admin/leads/:id/reassign`
- Parameters: `id` (lead ID).
- Body: `{ "caller_id": "caller_2" }`.
- Updates `crm_leads.assigned_caller_id` and records reassignment in `crm_lead_assignments`.

---

## 5. Testing & Verification

1. **Unit & API Tests (`tests/crm-admin.test.js`)**:
   - `POST /api/auth/verify-pin` rejects invalid PIN and accepts `6700`.
   - `GET /api/crm/admin/overview` returns accurate KPI counts, caller summary, and recent call logs.
   - `GET /api/crm/admin/leads` filters leads by search query and status.
   - `POST /api/crm/admin/leads/:id/reassign` reassigns lead to caller.
2. **Integration Verification**:
   - Run complete suite (`npm test`) in `D:\munnisoft-v2` verifying 100% test pass rate.
   - Verify lock overlay and CRM tab render cleanly on mobile viewports.
