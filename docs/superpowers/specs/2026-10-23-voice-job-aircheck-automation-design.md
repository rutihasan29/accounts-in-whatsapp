# Design Spec: Voice Job Tracking & AirCheck Automation

**Date:** 2026-10-23  
**Status:** Approved  
**Author:** Antigravity  

---

## 1. Overview & Goals

This system automates the end-to-end voiceover workflow between customers, the bot operator, VA2 (Voice Artist 2), and the newly integrated broadcast audio editing engine (AirCheck):

1. **Script Forward Tracking:** Whenever a customer script is forwarded to VA2—either automatically via the message classifier or manually by the operator—log and associate:
   - The customer's phone number and name.
   - The message ID of the customer's incoming script (`customer_script_msg_id`).
   - The message ID of the forwarded script sent to VA2 (`va2_forward_msg_id`).
   - The extracted Bengali headline (first 3–6 words).
   - The full script text.
2. **Audio File Inspection from VA2:** When VA2 replies to a script with an audio file (`.wav`, `.mp3`, `.m4a`, etc.):
   - If the audio filename **contains Bengali words** (`/[\u0980-\u09FF]/`):
     - Bypass AirCheck editing.
     - Directly forward the audio file to the customer as a quoted reply to `customer_script_msg_id`.
   - If the audio filename **does NOT contain Bengali words** (e.g. `voice1.mp3`, `raw_take.wav`):
     - Pass the audio to the **Embedded AirCheck Engine** to remove mistakes, retakes, and prolonged pauses.
     - Measure the clean duration ($D$).
     - Construct a new filename in Bengali: `<Headline> (<1m 23s>).<ext>` (using English digits for duration).
     - Send the clean audio to the **Customer** as a quoted reply to `customer_script_msg_id`.
     - Send the clean audio to **VA2** as a quoted reply to `va2_forward_msg_id`.
     - Mark the voice job order as `DELIVERED`.

---

## 2. Database Schema: `voice_job_orders`

Added in `src/db.js` within `data/ledger.db`:

```sql
CREATE TABLE IF NOT EXISTS voice_job_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT UNIQUE NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_name TEXT,
  customer_script_msg_id TEXT,
  va2_forward_msg_id TEXT,
  script_text TEXT NOT NULL,
  headline TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING_VA2', -- 'PENDING_VA2', 'EDITING', 'DELIVERED', 'FAILED'
  va2_audio_msg_id TEXT,
  va2_audio_filename TEXT,
  final_audio_filename TEXT,
  original_duration_seconds REAL,
  clean_duration_seconds REAL,
  aircheck_model_used TEXT,
  cuts_applied_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  delivered_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_voice_job_va2_msg ON voice_job_orders(va2_forward_msg_id);
CREATE INDEX IF NOT EXISTS idx_voice_job_customer_phone ON voice_job_orders(customer_phone);
CREATE INDEX IF NOT EXISTS idx_voice_job_status ON voice_job_orders(status);
```

### DB Helper Functions
- `createVoiceJobOrder(db, { customerPhone, customerName, customerScriptMsgId, va2ForwardMsgId, scriptText, headline })`
- `findVoiceJobOrderByVa2MsgId(db, va2ForwardMsgId)`
- `findVoiceJobOrderByScriptText(db, scriptText)`
- `findLatestPendingVoiceJob(db, { customerPhone } = {})`
- `updateVoiceJobVa2ForwardMsgId(db, orderId, va2ForwardMsgId)`
- `updateVoiceJobDelivered(db, orderId, { va2AudioMsgId, va2AudioFilename, finalAudioFilename, cleanDuration, cutsCount, modelUsed })`

---

## 3. Script Forward Tracking & Headline Extraction

### 3.1 Bengali Headline Extraction
Function: `extractHeadline(scriptText, maxWords = 5)`
- Extracts the first line of the script.
- Cleans out non-Bengali tags, markdown, punctuation, and emojis.
- Returns the first 3 to 6 words (e.g., `নবাবপুর ফুড সিটি হাউসের`).
- Falls back to `ভয়েস স্ক্রিপ্ট` if no Bengali text is detected.

### 3.2 English Duration Formatter for Filename
Function: `formatDurationForFilename(seconds)`
- Rounds to nearest second.
- If under 1 minute: `(${sec}s)`, e.g., `(45s)`.
- If 1 minute or more: `(${min}m ${sec}s)`, e.g., `(1m 23s)`.
- Filename format: `${headline} (${formatDurationForFilename(seconds)}).${ext}`

### 3.3 Automatic Forwarding Logging
In `src/dispatch.js` (`handleClassificationAction` for `VOICE_JOB`):
- Capture `sentMsg = await client.sendMessage(va2Jid, forwardMsg)`.
- Call `createVoiceJobOrder` with `customer_script_msg_id`, `va2_forward_msg_id = sentMsg.id._serialized`, `script_text`, and `headline`.

### 3.4 Manual Forwarding to VA2
In `src/bot.js` (`handleMessageCreate` for `msg.fromMe === true && to === va2Jid`):
- When an outgoing message is sent to VA2:
  1. Check if the message contains a script matching an existing customer's pending script (via exact substring or word overlap >= 60%).
  2. If matched, link `va2_forward_msg_id = msg.id._serialized` to that customer's pending `voice_job_orders` record.

---

## 4. Embedded AirCheck Engine (`src/aircheck.js`)

Integrated natively inside `munnisoft-v2`:

### 4.1 AI Cascade & Retake Detection
Ported from `aircheck/server.ts`:
- Candidate model cascade:
  1. `gemini-3.8-flash` (ThinkingLevel.LOW) &rarr; Retry (with backoff)
  2. `gemini-flash-latest` &rarr; Retry
  3. `gemini-3.5-transcribe`
- Uses exact broadcast voiceover prompt and JSON response schema requesting:
  - `mistakesAndRetakes`: array of `{ cutStartTime, cutEndTime, mistakeText, retakeText, reason, confidence }`.
- If Gemini returns empty cuts or finds no mistakes, the audio is verified clean (`cutsCount = 0`).

### 4.2 Splicing & Zero-Crossing Crossfade via FFmpeg
- Uses `@ffmpeg-installer/ffmpeg` and `@ffprobe-installer/ffprobe`.
- If cuts are detected:
  - Sorts and merges overlapping cut intervals `[cutStartTime, cutEndTime]`.
  - Inverts the cuts to identify kept audio segments: `[0, cut1_start]`, `[cut1_end, cut2_start]`, ..., `[cutN_end, totalDuration]`.
  - Executes FFmpeg `acrossfade` / concat filter to splice kept segments with natural micro-crossfades (12ms), eliminating clicks, pops, and sudden breath truncations.
  - Outputs the clean file to a temporary file.
- If no cuts are detected: passes through the audio buffer directly.

---

## 5. VA2 Audio Reply & Dual Quoted Delivery

In `src/bot.js` (`handleMessageCreate` when `msg.fromMe === false && sender === VA2`):

1. **Verify Audio Media:**
   - Detect if message is an audio file (`isAudioDocumentMessage(msg)` or `msg.type === 'audio'` or `msg.mimetype?.startsWith('audio/')`).
2. **Locate Associated Voice Job Order:**
   - Strategy 1: Check quoted message `msg.hasQuotedMsg` &rarr; `quotedMsg.id._serialized` &rarr; match `va2_forward_msg_id`.
   - Strategy 2: If no quote, match the latest pending order (`status = 'PENDING_VA2'`).
3. **Inspect Audio Filename:**
   - Extract filename from `msg.filename` or document metadata.
   - Test for Bengali characters: `const hasBengali = /[\u0980-\u09FF]/.test(filename);`
4. **Execution Branch:**
   - **Case A: `hasBengali === true`**
     - Forward audio media directly to customer quoting `customer_script_msg_id`.
     - Update order to `DELIVERED`.
   - **Case B: `hasBengali === false`**
     - Download audio media buffer (`msg.downloadMedia()`).
     - Pass buffer to `src/aircheck.js:cleanVoiceoverAudio({ buffer, filename, mimeType })`.
     - Measure clean duration with `ffprobe`.
     - Construct final filename: `${order.headline} (${durationStr}).${ext}`.
     - Create `MessageMedia` with the new filename and base64.
     - Send to **Customer** (`customerPhone@c.us`) with `{ quotedMessageId: customer_script_msg_id }`.
     - Send to **VA2** (`va2Jid`) with `{ quotedMessageId: va2_forward_msg_id }`.
     - Update order in DB to `DELIVERED`.

---

## 6. Error Handling & Safety

- If AirCheck AI models are all temporarily down (503/429), the bot logs a warning and delivers the original audio file to avoid customer blocking, while logging the incident.
- If customer script message ID cannot be quoted (e.g. revoked or expired), fallback to standard unquoted message in customer's chat.
- All temporary audio files created during FFmpeg processing are unlinked inside a `finally` block.

---

## 7. Verification & Testing

- Unit tests for:
  1. `src/db.js`: `voice_job_orders` CRUD operations and matching helpers.
  2. `src/aircheck.js`: Gemini cascade retry, JSON parsing, and FFmpeg segment extraction / micro-crossfade.
  3. `src/dispatch.js`: Automatic job order creation on `VOICE_JOB`.
  4. `src/bot.js`:
     - Manual script forwarding to VA2 with text match.
     - VA2 audio reply with Bengali filename (direct forwarding).
     - VA2 audio reply without Bengali filename (AirCheck editing, headline + duration rename, dual delivery).
- Full regression suite execution (`npm test`).
