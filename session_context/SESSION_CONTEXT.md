# NEWS VOICE & TELECALLER CRM — FULL SESSION CONTEXT & ARCHITECTURE

> **Document Type:** Master Session Context & System Specification  
> **Updated:** 2026-10-28  
> **Workspace Path:** `D:\munnisoft-v2`  
> **Active Branch:** `master` (342/342 unit & integration tests passing across 65 test suites)

---

## 1. PROJECT OVERVIEW & BRANDING

- **Product Name:** **NEWS VOICE (নিউজ ভয়েস)**
- **System Purpose:** Automated WhatsApp Business Ledger, Voiceover & Video Dispatch Automation, Embedded AirCheck Audio Splicing, and Telecaller CRM Hub.
- **Tech Stack:**
  - **Runtime:** Node.js (CommonJS, v22+)
  - **Database:** SQLite 3 (`better-sqlite3`) in WAL (Write-Ahead Logging) mode with strict foreign key constraints.
  - **WhatsApp Driver:** `whatsapp-web.js` with Puppeteer & Chromium headless browser.
  - **Audio Processing:** Native FFmpeg (`@ffmpeg-installer/ffmpeg`, `@ffprobe-installer/ffprobe`, `music-metadata`).
  - **AI / LLM:** Google Gemini API (`gemini-2.5-flash`, `gemini-flash-lite-latest`) with multi-key round-robin pool + OpenRouter fallback (`minimax/minimax-m3.1-flash:free`).
  - **Frontend:** High-contrast paper ledger UI (`src/dashboard.html`) + Telecaller dialer (`src/crm/public/index.html`, `dialer.js`).

---

## 2. REPOSITORY & DIRECTORY STRUCTURE

```
D:\munnisoft-v2\
├── Dockerfile                     # Production Linux container with Chromium & FFmpeg
├── docker-compose.yml             # Container definitions with volume mounts for data & auth
├── deploy.sh                      # Zero-downtime Linux pull & rebuild automation script
├── package.json                   # Dependencies and scripts (start, test, web, sync-crm)
├── .env                           # Local environment variables & secrets (NOT in Git)
├── .env.example                   # Clean template for environment deployment
├── .gitignore                     # Strictly ignores data/*.db, .wwebjs_auth, .env, npm logs
├── .dockerignore                  # Excludes node_modules, tests, data, and auth from images
│
├── index.js                       # Master process: Boots DB, WhatsApp client, Web Server & Ngrok
├── welcome_messages.json          # 7-step onboarding sequence for fresh customer inquiries
│
├── data/
│   └── ledger.db                  # Local SQLite database (Customers, Orders, Leads, CRM)
│
├── src/
│   ├── config.js                  # Central environment parser and path constants
│   ├── db.js                      # Core SQLite schema, migrations, queries, and bot settings
│   ├── bot.js                     # WhatsApp message router, self-chat commands, error handlers
│   ├── server.js                  # Express/Node HTTP server for Dashboard API & Statement exports
│   ├── dashboard.html             # Single-page Ledger UI + Feature Toggles + Telecaller CRM Admin
│   ├── classifier.js              # Gemini/OpenRouter Bengali script detection & quote generator
│   ├── aircheck.js                # Gemini audio analysis & FFmpeg 12ms cosine crossfade splicing
│   ├── dispatch.js                # In-flight order tracking, VA2/VE3 forwarding, crash recovery
│   ├── welcome.js                 # 7-step welcome demo sender (audio files + instructions)
│   ├── parser.js                  # Bengali numeral normalizer & command parser
│   ├── sync.js                    # In-page memory scanner protecting existing chats from welcome demo
│   ├── tunnel.js                  # Automatic Ngrok public tunnel with browser warning bypass
│   └── crm/
│       ├── api.js                 # Telecaller & CRM Admin REST API routes
│       ├── db.js                  # CRM SQLite tables, queries, pagination, and assignment engine
│       └── public/
│           ├── index.html         # Responsive mobile dialer interface
│           ├── dialer.js          # Dialer controller, lead history timeline & notes engine
│           └── styles.css         # Clean high-contrast dialer styling
│
├── docs/
│   └── superpowers/
│       ├── specs/                 # Architectural specifications
│       └── plans/                 # Executed implementation plans
│
├── session_context/
│   └── SESSION_CONTEXT.md         # This comprehensive session context file
│
└── tests/                         # 65 automated test suites (342 unit & integration tests)
```

---

## 3. CORE SUBSYSTEMS & CAPABILITIES

### A. Ledger & Accounting Engine
- **Tables:** `customers`, `transactions`, `leads`, `ad_spend`.
- **Parsing:** Natural Bengali chat messages parsed automatically:
  - `বিল ৫০০ টাকা` / `বিল 500 টাকা` &rarr; adds debit to customer account.
  - `২০০ টাকা পেয়েছি, ধন্যবাদ` / `200 টাকা পেয়েছি` &rarr; records credit payment.
  - `বকেয়া ১৫০০ টাকা` &rarr; balance adjustment.
  - WhatsApp *Delete for Everyone* &rarr; automatically revokes transaction.
- **Reporting:** Self-chat command `!due` / `বকেয়া` replies with formatted debtor balances.

### B. AI Script Classifier & Video Customer Handling
- **Incoming Messages:** Analyzed via Gemini to distinguish voiceover scripts from regular inquiries.
- **Customer Types:**
  - **Voice Customers:** Prompts "শুধু ভয়েস?" confirmation before forwarding to voice artist (`VA2`).
  - **Video Customers:** Stored in `video_customers`. Zero questions asked, immediately escalated to video editor (`VE3`).
  - **General Inquiries:** Routed to `VE3` without disturbing voice workflows.

### C. Voice Job Order Tracking & AirCheck Automation
- **Order State Machine:** `DRAFT` &rarr; `PENDING_VA2` &rarr; `AIRCHECKING` &rarr; `DELIVERED`.
- **AirCheck Engine:**
  - Evaluates voiceover files received from `VA2`.
  - Gemini scans audio for retakes, stuttering, and mistakes.
  - FFmpeg cuts retakes and joins segments using 12ms equal-power cosine crossfading.
  - Automatically formats filename in Bengali (e.g., `নজরুল_ইসলাম_খবর.mp3`) and dual-delivers to customer.

### D. Telecaller CRM Hub (`/crm`) & Admin Hub (`/`)
- **Tables:** `crm_callers`, `crm_leads`, `crm_call_logs`, `crm_lead_notes`, `crm_lead_assignments`.
- **Dialer Interface (`/crm?caller_id=...`):**
  - Next Lead queuing, call outcome logging (`Interested`, `Callback`, `Won`, `Lost`, etc.).
  - Complete history timeline of prior calls and timestamps.
  - Timestamped live notes creation (`POST /api/crm/leads/:id/notes`).
- **Dashboard Admin Panel (`src/dashboard.html`):**
  - **Security Lock:** Mandatory 4-digit PIN authentication (**`6700`**) rendered as the first element inside `<body>`. Unlocks persist in `sessionStorage` with a `[ 🔒 Lock ]` button in the header.
  - **KPI Grid:** Total Leads (6,332), Fresh, In Progress, Callbacks Due Today, Won, Lost.
  - **Caller Team Table:** Duty switcher (`🟢 Active`, `🟡 Break`, `⚪ Offline`), daily call count, direct `[ 📞 Open Dialer ]` deep-links, and `[ + Add New Caller ]` modal.
  - **Lead Pipeline Explorer:** Search by phone/name, filter by status or caller, pagination, and instant inline caller reassignment.
  - **Audit Stream:** Real-time log of the latest 20 calls across the entire team.

### E. Bot Feature Toggles (`src/dashboard.html`)
- Stored in SQLite `bot_settings` table and updated in real-time without restart:
  1. `aircheck_enabled` (Toggle automatic retake removal)
  2. `ai_classifier_enabled` (Toggle AI script detection & auto-forward)
  3. `welcome_demo_enabled` (Toggle 7-part welcome demo)
  4. `auto_audio_billing_enabled` (Toggle audio duration-based auto-billing)
  5. `video_customer_escalation_enabled` (Toggle direct VE3 alerts for video customers)
  6. `ve3_escalation_enabled` (Toggle inquiry alerts to VE3)

---

## 4. CURRENT CREDENTIALS & ACCESS CONFIGURATION

| Key / Resource | Current Value | Notes |
| :--- | :--- | :--- |
| **Dashboard PIN** | `6700` | Configured in `.env` (`DASHBOARD_PIN=6700`) |
| **Local Dashboard URL** | `http://localhost:3000` | Port `3000` |
| **Public Ngrok URL** | `https://unblessed-maroon-unhearing.ngrok-free.dev` | Auto-configured via `NGROK_AUTHTOKEN` |
| **Telecaller Dialer URL** | `https://unblessed-maroon-unhearing.ngrok-free.dev/crm` | Requires Caller ID + PIN |
| **Caller 1 (Tanvir)** | ID: `caller_1` / PIN: `1234` | Active telecaller |
| **Caller 2 (Agent)** | ID: `caller_2` / PIN: `5678` | Active telecaller |
| **Voice Artist (VA2)** | `8801307760509` | Voice artist recipient |
| **Video Editor (VE3)** | `8801831366604` | Video editor / escalation recipient |

---

## 5. DOCKER & LINUX SERVER DEPLOYMENT

### Container Specification (`Dockerfile`)
- Base image: `node:22-bookworm-slim`
- Embedded packages: `chromium`, `fonts-liberation`, `ca-certificates`, `ffmpeg`, audio libraries.
- Puppeteer flags: `--no-sandbox`, `--disable-setuid-sandbox`, `--disable-dev-shm-usage`, `--disable-gpu`.

### Running on Linux Server
1. Clone repository:
   ```bash
   git clone <REPO_URL> news-voice-bot
   cd news-voice-bot
   ```
2. Copy `.env`, `data/ledger.db`, and `.wwebjs_auth/` from local machine.
3. Start container:
   ```bash
   docker compose up -d --build
   ```
4. View live logs / QR code:
   ```bash
   docker compose logs -f
   ```

### Regular Update Routine
To apply new code changes without losing database or WhatsApp sessions:
```bash
./deploy.sh
```
*(Executes `git pull`, rebuilds the container, and restarts cleanly while preserving mounted volumes).*

---

## 6. VERIFICATION & QUALITY METRICS

- **Test Suite Command:** `npm test` (`node --test tests/*.test.js`)
- **Total Test Suites:** 65
- **Total Passing Tests:** 342 (0 failing, 0 regressions)
- **Data Protection:** `.env`, `data/*.db`, and `.wwebjs_auth/` are strictly ignored by Git to prevent secret exposure.
