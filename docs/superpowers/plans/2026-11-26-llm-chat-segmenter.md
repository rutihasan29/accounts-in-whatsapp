# Full-Chat LLM Job Segmentation and Production Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an intelligent LLM-driven job segmentation engine that receives the entire chronological WhatsApp conversation with rich media types and audio/video durations, detects all independent production jobs (even if no bill message was ever sent), audits billing amounts, discovers unbilled leakages, and updates the ground-truth `/metrics` database.

**Architecture:** 
1. Pre-processes raw chats to attach exact file types and durations (seconds) to every message.
2. Formats the full conversation stream into a structured JSON payload for Google Gemini (`gemini-flash-lite-latest` or `gemini-2.5-flash`).
3. Employs Gemini with a strict JSON schema prompt to delineate job blocks, calculate expected rates for every delivered media (voice tier: 0-60s = 50 BDT, +25 BDT/min; video: 250 BDT) regardless of whether a bill message exists.
4. Distributes bundled bills, detects free retakes, audits typos, and upserts verified jobs into `metrics_chat_jobs` and `metrics_chat_clients`.
5. Provides deterministic algorithmic fallback if Gemini API is unreachable or rate-limited.
6. Connects to `/metrics` dashboard with an interactive `[🤖 Run Full AI Audit]` action button.

**Tech Stack:** Node.js, Better-SQLite3, Google Gemini REST API (`fetch`), ffprobe, ASD-STE100 specifications.

**Spec:** `SPEC-LLM-FULLCHAT-STE100-2026-V2`

## Global Constraints
- Target workspace: `D:\munnisoft-v2` (mirrored in `D:\munnisoft`).
- Strict Privacy: ZERO customer financial data broadcast to WhatsApp chats.
- Zero Loss Rule: Every delivered voice or video file MUST be recorded with its expected production revenue, EVEN IF NO BILL MESSAGE WAS EVER SENT (status: `UNBILLED_LEAKAGE`, `expectedAmountBdt > 0`, `billedAmountBdt: 0`).
- No duplicate jobs: Idempotent upsert by `(phone_number, raw_media_msg_id)` or unique job ID.
- Fallback requirement: If Gemini API fails or returns non-JSON, fallback to deterministic regex/duration auditing without crashing.

---

### Task 1: Chat Data Pre-Processor & Rich Context Formatter

**Files:**
- Create: `src/llm-job-segmenter.js`
- Test: `tests/llm-job-segmenter.test.js`

**Interfaces:**
- Produces: `formatChatForLlm(chat)` -> returns `{ clientPhone, clientName, totalMessages, messages: [...] }`
- Produces: `calculateExpectedRate(mediaType, durationSeconds)` -> returns number (BDT)

- [ ] **Step 1: Write test for chat formatting and expected rate calculation**
  Ensure test checks:
  1. `calculateExpectedRate('audio', 45)` returns 50.
  2. `calculateExpectedRate('audio', 85)` returns 75.
  3. `calculateExpectedRate('audio', 125)` returns 100.
  4. `calculateExpectedRate('video', 10)` returns 250.
  5. `formatChatForLlm(rawChat)` extracts `index`, `time`, `sender`, `text`, `type`, `mediaDurationSec`, `filename`, `hasMedia`.

- [ ] **Step 2: Implement `calculateExpectedRate` and `formatChatForLlm` in `src/llm-job-segmenter.js`**

- [ ] **Step 3: Run test to confirm pass**
  Run: `node --test tests/llm-job-segmenter.test.js`

---

### Task 2: Gemini LLM Segmentation Engine with Unbilled Job Protection

**Files:**
- Modify: `src/llm-job-segmenter.js`
- Test: `tests/llm-job-segmenter.test.js`

**Interfaces:**
- Produces: `segmentChatWithLlm(chatPayload, options)` -> returns Promise resolving to `{ totalJobsDetected, clientSummary, jobBlocks }`
- Produces: `segmentChatDeterministicFallback(chatPayload)` -> returns fallback `{ totalJobsDetected, clientSummary, jobBlocks }`

- [ ] **Step 1: Write tests for LLM segmentation schema and missing bill calculation**
  Test cases:
  1. Delivered audio with NO bill message -> must produce job block with `status: 'UNBILLED_LEAKAGE'`, `billedAmountBdt: 0`, `expectedAmountBdt: 50`.
  2. Delivered audio WITH bill message -> `status: 'CONFIRMED_BILLED'`, `billedAmountBdt: 50`, `expectedAmountBdt: 50`.
  3. Bundled billing: 2 audios delivered, 1 bill message "বিল ১০০ টাকা" -> 2 jobs detected, 50 BDT each.
  4. Free retake: Customer says "ভয়েস ভুল হয়েছে" -> second audio flagged as retake (`isRetake: true`, `expectedAmountBdt: 0`).

- [ ] **Step 2: Implement prompt, schema, and API call in `segmentChatWithLlm`**
  Use `gemini-flash-lite-latest` with standard `responseSchema` or structured JSON instructions.
  Ensure prompt explicitly mandates:
  *"CRITICAL RULE: For every delivered audio or video file, you MUST create a job block even if the staff never sent a bill message. Set expectedAmountBdt to the standard rate, billedAmountBdt to 0, unbilledLeakageBdt to expectedAmountBdt, and status to UNBILLED_LEAKAGE."*

- [ ] **Step 3: Implement `segmentChatDeterministicFallback`**
  Ensures offline functionality if Gemini API key is missing or quota exceeded.

- [ ] **Step 4: Run test to confirm pass**
  Run: `node --test tests/llm-job-segmenter.test.js`

---

### Task 3: Database Synchronization & Server API Endpoint

**Files:**
- Modify: `src/llm-job-segmenter.js`
- Modify: `src/server.js`
- Test: `tests/server-metrics.test.js`

**Interfaces:**
- Produces: `saveLlmJobBlocksToDb(db, auditResult)` -> upserts into `metrics_chat_jobs` and `metrics_chat_clients`
- Produces: `POST /api/metrics/ai-audit` -> runs audit across all or specified client chats and returns aggregated stats

- [ ] **Step 1: Write test for saving LLM job blocks and `POST /api/metrics/ai-audit`**

- [ ] **Step 2: Implement `saveLlmJobBlocksToDb` with duplicate prevention**

- [ ] **Step 3: Add endpoint `POST /api/metrics/ai-audit` in `src/server.js`**

- [ ] **Step 4: Run test to confirm pass**
  Run: `node --test tests/server-metrics.test.js`

---

### Task 4: Interactive Dashboard UI in `src/metrics.html`

**Files:**
- Modify: `src/metrics.html`

- [ ] **Step 1: Add AI Audit section and button in `src/metrics.html`**
  Add `[🤖 Run Full AI Chat Audit (LLM)]` in the Sync Modal.
  Add real-time progress bar and status alert.
  Show LLM reasoning/discrepancy notes in the recent jobs table.

- [ ] **Step 2: Add client-side handler `executeAiAudit()` in `src/metrics.html`**

---

### Task 5: End-to-End Verification, Mirroring & Commit

**Files:**
- Mirror all modified files from `D:\munnisoft-v2` to `D:\munnisoft`
- Restart server daemon on port 3050
- Run full test suite: `server-metrics.test.js`, `metrics.test.js`, `metrics-roi.test.js`, `llm-job-segmenter.test.js`
- Commit and push to GitHub `origin/master`
