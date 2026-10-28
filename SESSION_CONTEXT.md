# News Voice (নিউজ ভয়েস) — Master Session Context & Architecture Snapshot

> **Date & Time:** 2026-10-28  
> **Workspace Path:** `D:\munnisoft-v2`  
> **Git Branch:** `master`  
> **Automated Test Status:** 342 / 342 Passing across 65 Test Suites (0 Failures)  
> **Docker Ready:** Yes (`Dockerfile`, `docker-compose.yml`, `deploy.sh`)

---

## 1. Project Overview & Identity
- **Name:** **NEWS VOICE (নিউজ ভয়েস)**
- **System:** Automated WhatsApp Business Ledger, Voiceover & Video Dispatch Automation, Embedded AirCheck Audio Splicer, and Telecaller CRM Hub.
- **Tech Stack:** Node.js (CommonJS), `better-sqlite3` (WAL mode), `whatsapp-web.js` + Puppeteer (Chromium headless), native FFmpeg, Google Gemini API & OpenRouter.

---

## 2. Core Credentials & Configuration

```env
# Gemini AI (Classifier & AirCheck)
GEMINI_API_KEY=YOUR_GEMINI_KEY
GEMINI_AUDIO_API_KEYS=YOUR_GEMINI_KEY,YOUR_GEMINI_KEY
GEMINI_AUDIO_API_KEY=YOUR_GEMINI_KEY
GEMINI_MODEL=gemini-flash-lite-latest

# OpenRouter (Fallback Provider)
OPENROUTER_API_KEY=YOUR_OPENROUTER_KEY
OPENROUTER_MODEL=minimax/minimax-m3.1-flash:free
LLM_PROVIDER=gemini

# Internal Staff Phone Numbers
VA2_PHONE=8801307760509
VE3_PHONE=8801831366604
SCRIPT_TIMEOUT_MS=300000

# Ngrok Public Mobile Tunnel
NGROK_AUTHTOKEN=YOUR_NGROK_TOKEN

# Dashboard Access PIN
DASHBOARD_PIN=6700
```

---

## 3. URLs & Passwords

| Service | Link | Access PIN |
| :--- | :--- | :--- |
| **Main Dashboard & CRM Admin** | `https://unblessed-maroon-unhearing.ngrok-free.dev` | **`6700`** |
| **Local Dashboard** | `http://localhost:3000` | **`6700`** |
| **Telecaller Dialer** | `https://unblessed-maroon-unhearing.ngrok-free.dev/crm` | Caller 1: `1234` / Caller 2: `5678` |

---

## 4. Key Subsystems
1. **Ledger & Auto-Billing:** Bengali chat message parsing (`বিল ৫০০ টাকা`, `২০০ টাকা পেয়েছি`), self-chat `!due` balance command, unsend message auto-revocation.
2. **AI Classifier:** Distinguishes voice scripts from general questions; prompts voice clients with "শুধু ভয়েস?" before forwarding to voice artist (`VA2`).
3. **Video Customer Direct Escalation:** Video clients bypass all prompts and escalate straight to video editor (`VE3`).
4. **AirCheck Audio Engine:** Cuts mistakes, retakes, and stutters from `VA2` audio using Gemini + FFmpeg with 12ms cosine crossfades, formats filename with Bengali news title, and dual-delivers to customer.
5. **Telecaller CRM Hub (`/crm`):** Call queuing, duty status toggles (`Active`, `Break`, `Offline`), call history timeline, first contact duration, and timestamped caller notes.
6. **Dashboard PIN Lock:** Prompted as the first HTML element in `<body>` before any content renders.
7. **Docker & 1-Command Deploy:** `deploy.sh` pulls updates and runs `docker compose up -d --build` without losing database or WhatsApp login sessions.

---

## 5. Linux Server Commands
```bash
# First time install Docker
curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh

# Run container
docker compose up -d --build

# View logs / QR code
docker compose logs -f

# Regular 1-command update
./deploy.sh
```
