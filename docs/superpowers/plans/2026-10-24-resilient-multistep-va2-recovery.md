# Resilient Multistep Workflow Recovery & VA2 Multi-Device LID Identification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the WhatsApp bot recognizes VA2 under all multi-device LID circumstances (including PTT/voice notes) and seamlessly recovers and resumes interrupted multistep workflows across bot disconnections or process restarts (from initial inbound scripts to pending confirmations to pending VA2 deliveries).

**Architecture:**
1. **SQLite State Persistence:** Store pending confirmations in SQLite (`pending_confirmations` table) with auto-expiration, replacing the volatile in-memory Map. Store cached VA2 LIDs in SQLite (`bot_settings` or dedicated staff storage).
2. **Proactive VA2 LID & Audio Detection:** Proactively resolve VA2's LID on startup and cache it. Match incoming messages against known VA2 phone and cached LIDs. Expand audio detection to include WhatsApp PTT voice notes (`msg.type === 'ptt'`, `msg.isVoice`).
3. **Downtime Catch-up & Workflow Recovery Scanner (`recoverPendingWorkflows`):** On startup/reconnect, scan unread/pending customer chats for scripts received during downtime, and scan VA2's chat for audio replies sent during downtime for any `PENDING_VA2` orders.

**Tech Stack:** Node.js, better-sqlite3, whatsapp-web.js, node:test.

## Global Constraints
- Zero breaking changes to existing 262 unit tests across 50 test suites.
- No group chat (@g.us) messages must ever be processed or escalated.
- Audio delivery must continue to use dual quoted delivery (to customer and VA2).
- Clean logging with timestamps and graceful fallbacks.

---

### Task 1: SQLite Persistence for Pending Confirmations

**Files:**
- Modify: `D:\munnisoft-v2\src\db.js`
- Modify: `D:\munnisoft-v2\src\dispatch.js`
- Test: `D:\munnisoft-v2\tests/dispatch.test.js`

**Interfaces:**
- Produces in `src/db.js`:
  - `savePendingConfirmation(db, { customerPhone, script, customerName, timeoutMs })`
  - `getPendingConfirmation(db, customerPhone)`
  - `removePendingConfirmation(db, customerPhone)`
  - `getValidPendingConfirmations(db)`
- Updates in `src/dispatch.js`:
  - Integrates with `savePendingConfirmation`, `getPendingConfirmation`, `removePendingConfirmation` backed by SQLite.

- [ ] **Step 1: Write unit tests in `tests/dispatch.test.js` for persistent confirmations across restarts**
- [ ] **Step 2: Add `pending_confirmations` table and helper functions in `src/db.js`**
- [ ] **Step 3: Update `src/dispatch.js` to persist confirmations in SQLite and restore on initialization**
- [ ] **Step 4: Run tests to verify all pass**
- [ ] **Step 5: Git commit**

---

### Task 2: VA2 Multi-Device LID Resolution, Caching & PTT Audio Support

**Files:**
- Modify: `D:\munnisoft-v2\src\db.js`
- Modify: `D:\munnisoft-v2\src\bot.js`
- Test: `D:\munnisoft-v2\tests/bot.test.js`

**Interfaces:**
- Produces in `src/db.js`:
  - `cacheStaffLid(db, staffRole, phone, lid)`
  - `getCachedStaffLid(db, staffRole)`
- Updates in `src/bot.js`:
  - `isVa2Sender(msg, client, db)`
  - Recognize `msg.type === 'ptt'` and `msg.isVoice === true` as valid audio from VA2.
  - Proactive LID resolution on `ready` event.

- [ ] **Step 1: Write unit tests in `tests/bot.test.js` verifying VA2 recognition via cached LID and PTT voice notes**
- [ ] **Step 2: Add LID caching helpers in `src/db.js`**
- [ ] **Step 3: Update `isVa2` checking in `src/bot.js` to consult DB cache and accept PTT voice messages**
- [ ] **Step 4: Run tests to verify all pass**
- [ ] **Step 5: Git commit**

---

### Task 3: Unread & Downtime Inbound Message Catch-up Scanner

**Files:**
- Modify: `D:\munnisoft-v2\src\bot.js`
- Test: `D:\munnisoft-v2\tests/bot.test.js`

**Interfaces:**
- Produces in `src/bot.js`:
  - `catchupUnreadCustomerMessages({ client, db, handleMessageCreateFn })`
  - Runs upon `ready` or reconnect to scan unread customer chats, triggering classification and "ভয়েস?" prompt.

- [ ] **Step 1: Write unit tests in `tests/bot.test.js` for `catchupUnreadCustomerMessages`**
- [ ] **Step 2: Implement `catchupUnreadCustomerMessages` in `src/bot.js`**
- [ ] **Step 3: Run tests to verify all pass**
- [ ] **Step 4: Git commit**

---

### Task 4: In-Flight Multistep Workflow Recovery Scanner for Pending Voice Jobs

**Files:**
- Modify: `D:\munnisoft-v2\src\bot.js`
- Test: `D:\munnisoft-v2\tests/bot.test.js`

**Interfaces:**
- Produces in `src/bot.js`:
  - `recoverPendingWorkflows({ client, db, handleMessageCreateFn })`
  - Checks orders with `status = 'PENDING_VA2'`, fetches recent messages from VA2's chat, and processes audio received while offline.

- [ ] **Step 1: Write unit tests in `tests/bot.test.js` for `recoverPendingWorkflows`**
- [ ] **Step 2: Implement `recoverPendingWorkflows` in `src/bot.js`**
- [ ] **Step 3: Integrate into `client.on('ready')`**
- [ ] **Step 4: Run full test suite across all 50+ test files**
- [ ] **Step 5: Git commit**

---

### Task 5: End-to-End Verification & Daemon Startup

- [ ] **Step 1: Run full test suite `npm test` ensuring 100% pass rate**
- [ ] **Step 2: Restart the bot daemon (`node index.js`)**
- [ ] **Step 3: Confirm daemon connects and is ready**
