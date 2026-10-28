# Bot Feature Controls & Frontend Toggle Switches Implementation Plan

This plan introduces a dedicated **Bot Controls** tab in the dashboard frontend with interactive toggle switches for key automated capabilities, backed by a persistent SQLite key-value settings table, REST API endpoints, and dynamic runtime gates in the bot message processor.

## Global Constraints
1. **Zero Downtime / Zero Regressions:** Existing customer ledger parsing (`বিল ৫০০ টাকা`, `জমা ১০০০`), automatic audio billing, AirCheck engine, and self-chat commands must remain 100% operational.
2. **Design Language:** The new UI elements in `src/dashboard.html` must seamlessly match the existing document/paper ledger design system (monospaced Courier typography, crisp borders, high contrast, responsive mobile-first layout).
3. **Optimistic & Resilient UI:** Toggle interactions in the frontend must update UI state instantly, sync asynchronously via `POST /api/bot-settings`, and rollback gracefully with clear feedback if a network/server error occurs.
4. **Default Safe:** All toggles default to `true` (ON) so current production behavior is preserved out of the box when no explicit override is set in SQLite.

---

## Tasks

### Task 1: Database Layer & Bot Settings Storage
- **Files:** `src/db.js`, `tests/db.test.js`
- **Requirements:**
  1. Define `DEFAULT_BOT_SETTINGS`:
     ```js
     const DEFAULT_BOT_SETTINGS = {
       aircheck_enabled: true,
       ai_classifier_enabled: true,
       welcome_demo_enabled: true,
       auto_audio_billing_enabled: true,
       video_customer_escalation_enabled: true,
       ve3_escalation_enabled: true
     };
     ```
  2. In `initDb(db)`: Create table `bot_settings`:
     ```sql
     CREATE TABLE IF NOT EXISTS bot_settings (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL,
       updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
     );
     ```
  3. Implement `getBotSetting(db, key, defaultValue = null)`:
     - Query `SELECT value FROM bot_settings WHERE key = ?`.
     - If row exists: if `row.value === 'true' || row.value === '1'`, return `true`. If `row.value === 'false' || row.value === '0'`, return `false`. Try `JSON.parse(row.value)` if applicable, else return `row.value`.
     - If row does not exist, check `DEFAULT_BOT_SETTINGS[key]`, then `defaultValue`.
  4. Implement `setBotSetting(db, key, value)`:
     - Sanitize key and stringify value (`String(value)`).
     - Run `INSERT INTO bot_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`.
     - Return `{ key, value: getBotSetting(db, key) }`.
  5. Implement `getAllBotSettings(db, defaults = DEFAULT_BOT_SETTINGS)`:
     - Fetch all rows from `bot_settings`.
     - Merge with defaults so every known setting has a resolved boolean value.
  6. Export all functions and `DEFAULT_BOT_SETTINGS` from `src/db.js`.
  7. Add comprehensive unit tests in `tests/db.test.js` verifying defaults, saving, reading, updating, and fallback behaviors.

### Task 2: REST API Endpoints & Pre-rendering
- **Files:** `src/server.js`, `tests/server.test.js`
- **Requirements:**
  1. Add `GET /api/bot-settings`:
     - Calls `getAllBotSettings(db)`.
     - Returns JSON `{ success: true, settings: { ... } }`.
  2. Add `POST /api/bot-settings`:
     - Reads JSON body via `readJsonBody(req)`.
     - Supports `{ key: string, value: boolean }` OR `{ settings: { [key]: boolean } }`.
     - Validates key against known keys or non-empty string.
     - Persists each setting via `setBotSetting(db, key, value)`.
     - Returns JSON `{ success: true, settings: getAllBotSettings(db) }`.
  3. In `renderHtmlPage(dashboardHtml, initialJson)`:
     - Include `botSettings: getAllBotSettings(db)` in `initialJson`.
     - Ensure `window.__INITIAL_DATA__.botSettings` is populated on page load.
  4. Add unit and integration tests in `tests/server.test.js` verifying GET and POST behaviors, validation, and pre-rendering.

### Task 3: Bot Runtime Feature Toggle Integration
- **Files:** `src/bot.js`, `src/dispatch.js`, `tests/bot-toggles.test.js`
- **Requirements:**
  1. In `src/bot.js`:
     - Import `getBotSetting` from `./db`.
     - **Welcome Demo (`welcome_demo_enabled`):**
       Before calling `sendWelcomeDemo`, check `getBotSetting(db, 'welcome_demo_enabled', true)`. If false, log `[WELCOME_DEMO] Welcome demo disabled via bot settings. Skipping.` and do not send demo.
     - **Auto Audio Billing (`auto_audio_billing_enabled`):**
       In outgoing audio billing check, check `getBotSetting(db, 'auto_audio_billing_enabled', true)`. If false, log `[AUDIO_BILLING] Auto audio billing disabled via bot settings. Skipping.` and do not format/record bill.
     - **Video Customer Escalation (`video_customer_escalation_enabled`):**
       Before triggering video customer escalation, check `getBotSetting(db, 'video_customer_escalation_enabled', true)`. If false, bypass video escalation and proceed with regular message handling.
     - **AI Classifier (`ai_classifier_enabled`):**
       Before invoking AI classification for customer messages, check `getBotSetting(db, 'ai_classifier_enabled', true)`. If false, log `[CLASSIFIER] AI classifier disabled via bot settings. Skipping.` and skip auto-classification.
     - **AirCheck Editing (`aircheck_enabled`):**
       When VA2 voiceover audio arrives and has no Bengali characters: check `getBotSetting(db, 'aircheck_enabled', true)`. If false, log `[AIRCHECK] AirCheck editing disabled via bot settings. Forwarding directly to client.` and skip `cleanVoiceoverAudio`, forwarding the original audio buffer directly with the clean Bengali headline filename.
  2. In `src/dispatch.js`:
     - Import `getBotSetting` from `./db`.
     - **VE3 Escalation Alert (`ve3_escalation_enabled`):**
       Before sending escalation alert to VE3 (`client.sendMessage(ve3Jid, ...)`), check `getBotSetting(db, 've3_escalation_enabled', true)`. If false, log `[DISPATCH] VE3 escalation disabled via bot settings. Skipping alert.` and return with `{ action: 'ESCALATION_DISABLED' }` or skip sending message.
  3. Create `tests/bot-toggles.test.js`:
     - Test each feature respects its toggle when disabled (set to false in SQLite).
     - Verify full test suite passes.

### Task 4: Frontend Bot Controls Tab & Toggle UI
- **Files:** `src/dashboard.html`
- **Requirements:**
  1. Add tab button to `.tabs`:
     `<button class="tab-btn" data-tab="toggles" onclick="setTab('toggles')">⚙️ ফিচার কন্ট্রোল</button>`.
  2. Add `#toggles-panel` section right after `.controls`:
     - Contains 6 feature control cards:
       1. **AirCheck অডিও ক্লিনিং (AirCheck Retake & Mistake Removal)**:
          `aircheck_enabled` - VA2 থেকে আসা ভয়েস ওভার স্বয়ংক্রিয়ভাবে কাট-ছাঁট ও ক্লিন করা।
       2. **AI স্ক্রিপ্ট ক্লাসিফায়ার (AI Script Classifier)**:
          `ai_classifier_enabled` - ইনবাউন্ড কাস্টমার স্ক্রিপ্ট শনাক্ত করে VA2-কে স্বয়ংক্রিয়ভাবে পাঠানো।
       3. **স্বয়ংক্রিয় ওয়েলকাম ডেমো (Welcome Demo 7-Step Sequence)**:
          `welcome_demo_enabled` - নতুন ক্লায়েন্টকে স্বয়ংক্রিয় ৭-ধাপের অডিও-সহ স্বাগতম মেসেজ পাঠানো।
       4. **অডিও সময়ভিত্তিক অটো-বিলিং (Auto Audio Duration Billing)**:
          `auto_audio_billing_enabled` - ক্লায়েন্টকে পাঠানো অডিও ফাইল থেকে সেকেন্ড হিসাব করে স্বয়ংক্রিয় বিল তৈরি।
       5. **ভিডিও গ্রাহক সরাসরি এসকেলেশন (Video Customer VE3 Escalation)**:
          `video_customer_escalation_enabled` - ভিডিও ক্লায়েন্টদের কোনো প্রশ্ন না করে সরাসরি VE3 এডিটরের কাছে পাঠানো।
       6. **VE3 সাধারণ সতর্কতা (VE3 Inbound Alerts)**:
          `ve3_escalation_enabled` - সাধারণ অনুসন্ধান ও অন্যান্য মেসেজে VE3 এডিটরকে হোয়াটসঅ্যাপ এলার্ট দেওয়া।
  3. Design & Styling:
     - Pure CSS modern switch toggles with smooth transition.
     - Dark status badge: `সক্রিয় (ACTIVE)` vs `নিষ্ক্রিয় (OFF)`.
     - Card grid with paper-ledger border style, responsive on mobile & desktop.
  4. Client JS:
     - Read initial states from `window.__INITIAL_DATA__.botSettings || {}`.
     - Update UI switch positions and status badges based on state.
     - Handle `change` event on toggles:
       - Instantly update badge and state.
       - Asynchronously `POST /api/bot-settings` with `{ key, value }`.
       - If request fails, revert toggle switch and show toast alert.
     - Update `setTab(tab)`:
       - When `tab === 'toggles'`: show `#toggles-panel`, hide `#customer-container` and `#search-box` container.
       - When `tab !== 'toggles'`: hide `#toggles-panel`, show `#customer-container` and `#search-box`.

### Task 5: Full Regression Testing & Verification
- **Requirements:**
  1. Run `npm test` across all 50+ test files and ensure 100% pass rate.
  2. Test `GET /api/bot-settings` and `POST /api/bot-settings` via curl/Invoke-RestMethod.
  3. Restart bot daemon (`task-5516`).
  4. Confirm dashboard loads smoothly via Cloudflare tunnel.
