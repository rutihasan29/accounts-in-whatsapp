# Voice Job Tracking & AirCheck Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically track customer voice job orders, forward scripts to VA2 with message ID logging, detect VA2 audio replies, edit unedited files using an embedded Gemini/FFmpeg AirCheck engine, rename with a Bengali headline & duration `(1m 23s)`, and deliver as quoted replies to both client and VA2.

**Architecture:** Native SQLite table `voice_job_orders` in `src/db.js` links customer script message IDs with VA2 forwarded message IDs. An embedded AirCheck engine in `src/aircheck.js` uses a multi-model Gemini cascade (`gemini-3.8-flash` &rarr; `gemini-flash-latest` &rarr; `gemini-3.5-transcribe`) to detect mistakes/retakes, and bundled `@ffmpeg-installer/ffmpeg` to splice clean audio with micro-crossfades. Inbound VA2 audio messages are checked for Bengali characters; clean audio is renamed and delivered with dual quoted replies.

**Tech Stack:** Node.js, better-sqlite3, whatsapp-web.js, @google/genai, @ffmpeg-installer/ffmpeg, @ffprobe-installer/ffprobe.

**Spec:** `docs/superpowers/specs/2026-10-23-voice-job-aircheck-automation-design.md`

## Global Constraints
- Target workspace: `D:\munnisoft-v2`.
- Language rule: All user-facing explanations must be in clear English.
- Do not break existing customer ledger parsing (`বিল ৫০০ টাকা`, `৫০০ টাকা পেয়েছি`), auto-audio billing, welcome demo, or lead tracking.
- Output filename format: Bengali headline (first 3-6 words) + duration in English numbers inside parentheses, e.g. `নবাবপুর ফুড সিটি (1m 23s).mp3`.
- Audio files from VA2 with Bengali words in the name bypass AirCheck and are forwarded directly.

---

### Task 1: SQLite Voice Job Orders Database Layer

**Files:**
- Modify: `src/db.js`
- Test: `tests/db.test.js`

**Interfaces:**
- Produces:
  - `createVoiceJobOrder(db, { customerPhone, customerName, customerScriptMsgId, va2ForwardMsgId, scriptText, headline }) => { id, orderId, ... }`
  - `findVoiceJobOrderByVa2MsgId(db, va2ForwardMsgId) => Object | null`
  - `findVoiceJobOrderByScriptText(db, scriptText) => Object | null`
  - `findLatestPendingVoiceJob(db, { customerPhone } = {}) => Object | null`
  - `updateVoiceJobVa2ForwardMsgId(db, orderId, va2ForwardMsgId) => boolean`
  - `updateVoiceJobDelivered(db, orderId, { va2AudioMsgId, va2AudioFilename, finalAudioFilename, cleanDuration, cutsCount, modelUsed }) => boolean`

- [ ] **Step 1: Write failing unit tests in `tests/db.test.js`**
  Add a suite `Voice Job Orders Database Module` testing table creation, order insertion with unique `order_id`, lookups by VA2 message ID and script text, pending order lookup, and delivery update.

- [ ] **Step 2: Run tests to confirm failure**
  Run: `node --test tests/db.test.js` and verify new tests fail.

- [ ] **Step 3: Implement `voice_job_orders` schema and functions in `src/db.js`**
  Add `CREATE TABLE IF NOT EXISTS voice_job_orders` to `initDb` and implement helper methods.

- [ ] **Step 4: Run tests to verify pass**
  Run: `node --test tests/db.test.js` and verify 100% pass.

- [ ] **Step 5: Commit changes**
  Run: `git add src/db.js tests/db.test.js && git commit -m "feat(db): add voice_job_orders table and query helpers"`

---

### Task 2: Bengali Headline & Filename Formatters

**Files:**
- Modify: `src/audio.js`
- Test: `tests/audio.test.js`

**Interfaces:**
- Produces:
  - `extractHeadline(scriptText, maxWords = 5) => string`
  - `formatDurationForFilename(seconds) => string` (e.g. `1m 23s`, `45s`)
  - `buildCleanVoiceFilename({ headline, durationSeconds, ext }) => string` (e.g. `নবাবপুর ফুড সিটি (1m 23s).mp3`)
  - `hasBengaliCharacters(str) => boolean`

- [ ] **Step 1: Write failing unit tests in `tests/audio.test.js`**
  Test `extractHeadline` on multi-line scripts, punctuation stripping, word limits; test `formatDurationForFilename` under 60s and over 60s; test `hasBengaliCharacters` on English vs Bengali filenames.

- [ ] **Step 2: Run tests to confirm failure**
  Run: `node --test tests/audio.test.js` and verify failure.

- [ ] **Step 3: Implement formatting functions in `src/audio.js`**
  Implement and export `extractHeadline`, `formatDurationForFilename`, `buildCleanVoiceFilename`, and `hasBengaliCharacters`.

- [ ] **Step 4: Run tests to verify pass**
  Run: `node --test tests/audio.test.js` and verify 100% pass.

- [ ] **Step 5: Commit changes**
  Run: `git add src/audio.js tests/audio.test.js && git commit -m "feat(audio): add headline extraction and filename formatters"`

---

### Task 3: Embedded AirCheck Engine

**Files:**
- Create: `src/aircheck.js`
- Test: `tests/aircheck.test.js`

**Interfaces:**
- Consumes:
  - `config.GEMINI_API_KEY`
  - `@ffmpeg-installer/ffmpeg`
  - `@ffprobe-installer/ffprobe`
- Produces:
  - `analyzeVoiceoverWithGemini({ audioBuffer, mimeType, duration, title, client }) => Promise<{ cuts, modelUsed, overallTranscript }>`
  - `spliceAudioCuts({ inputPath, outputPath, cuts, totalDuration }) => Promise<{ outputPath, durationSeconds, cutsApplied }>`
  - `cleanVoiceoverAudio({ audioBuffer, filename, mimeType }) => Promise<{ cleanBuffer, durationSeconds, cutsCount, modelUsed, outputPath }>`

- [ ] **Step 1: Write unit tests in `tests/aircheck.test.js`**
  Mock Gemini client responses for cut detection, test candidate model fallback on 503/429 errors, test interval inversion for kept segments, and test FFmpeg splice invocation on sample WAV buffers.

- [ ] **Step 2: Run tests to confirm failure**
  Run: `node --test tests/aircheck.test.js` and confirm failure.

- [ ] **Step 3: Implement `src/aircheck.js`**
  Include multi-model cascade (`gemini-3.8-flash` &rarr; `gemini-flash-latest` &rarr; `gemini-3.5-transcribe`), broadcast retake prompt, interval inversion, and FFmpeg filter concat with crossfade.

- [ ] **Step 4: Run tests to verify pass**
  Run: `node --test tests/aircheck.test.js` and verify 100% pass.

- [ ] **Step 5: Commit changes**
  Run: `git add src/aircheck.js tests/aircheck.test.js && git commit -m "feat(aircheck): implement embedded voiceover retake remover engine"`

---

### Task 4: Script Forward Logging (Automatic & Manual)

**Files:**
- Modify: `src/dispatch.js`
- Modify: `src/bot.js`
- Test: `tests/dispatch.test.js`
- Test: `tests/bot.test.js`

**Interfaces:**
- Consumes:
  - `createVoiceJobOrder`, `findVoiceJobOrderByScriptText`, `updateVoiceJobVa2ForwardMsgId` from `src/db.js`
  - `extractHeadline` from `src/audio.js`
- Produces:
  - Automatic `VOICE_JOB` dispatch saves order with `customer_script_msg_id` and `va2_forward_msg_id`.
  - Outgoing message to VA2 with script text links `va2_forward_msg_id` to matching pending customer script.

- [ ] **Step 1: Write unit tests in `tests/dispatch.test.js` and `tests/bot.test.js`**
  Test automatic forward logging in `handleClassificationAction` and manual outgoing message script matching in `handleMessageCreate`.

- [ ] **Step 2: Run tests to confirm failure**
  Run: `node --test tests/dispatch.test.js tests/bot.test.js` and verify failure.

- [ ] **Step 3: Implement forward logging in `src/dispatch.js` and `src/bot.js`**
  Wire `createVoiceJobOrder` when dispatching `VOICE_JOB` and add outgoing message check in `handleMessageCreate` for VA2.

- [ ] **Step 4: Run tests to verify pass**
  Run: `node --test tests/dispatch.test.js tests/bot.test.js` and verify 100% pass.

- [ ] **Step 5: Commit changes**
  Run: `git add src/dispatch.js src/bot.js tests/dispatch.test.js tests/bot.test.js && git commit -m "feat(dispatch): track and log script message IDs for VA2 orders"`

---

### Task 5: VA2 Audio Reply Ingestion, Editing & Dual Quoted Delivery

**Files:**
- Modify: `src/bot.js`
- Test: `tests/bot.test.js`

**Interfaces:**
- Consumes:
  - `findVoiceJobOrderByVa2MsgId`, `findLatestPendingVoiceJob`, `updateVoiceJobDelivered` from `src/db.js`
  - `hasBengaliCharacters`, `buildCleanVoiceFilename` from `src/audio.js`
  - `cleanVoiceoverAudio` from `src/aircheck.js`
- Produces:
  - Direct forwarding to customer quoting script message if filename has Bengali characters.
  - AirCheck clean + rename + dual delivery (Customer quoting customer script, VA2 quoting VA2 script) if filename has no Bengali characters.

- [ ] **Step 1: Write integration tests in `tests/bot.test.js`**
  1. Test VA2 audio reply with Bengali filename &rarr; directly delivered to customer quoting `customer_script_msg_id`.
  2. Test VA2 audio reply with English filename (e.g. `voice1.mp3`) &rarr; edited via AirCheck, renamed with headline + `(1m 23s)`, delivered to Customer quoting `customer_script_msg_id` and to VA2 quoting `va2_forward_msg_id`.

- [ ] **Step 2: Run tests to confirm failure**
  Run: `node --test tests/bot.test.js` and verify failure.

- [ ] **Step 3: Implement VA2 audio reply handler in `src/bot.js`**
  Handle inbound audio messages from VA2, quote resolution, Bengali character check, AirCheck invocation, and dual quoted delivery.

- [ ] **Step 4: Run full test suite**
  Run: `npm test` across all files to ensure all unit and integration tests pass without regressions.

- [ ] **Step 5: Restart Bot Daemon & Verify Live Operation**
  Restart the live bot daemon (`node index.js`) and confirm successful connection.

- [ ] **Step 6: Commit changes**
  Run: `git add . && git commit -m "feat(bot): add VA2 audio reply ingestion, aircheck editing, and dual quoted delivery"`
