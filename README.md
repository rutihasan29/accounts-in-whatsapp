# WhatsApp Business Ledger Bot 🇧🇩

An automated, privacy-first WhatsApp Business ledger bot built with [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) and [better-sqlite3](https://github.com/WiseLibs/better-sqlite3).

The bot operates **silently** in the background during day-to-day customer conversations. It listens to outgoing messages sent by the business owner, automatically parses bill and payment amounts (supporting both Bengali and English numerals), and logs transactions in a local SQLite database. Whenever the business owner sends `!due` in their own self-chat ("Message Yourself"), the bot replies with an aggregated due balance report.

---

## 🌟 Key Features

- **Silent Outgoing Message Tracking**: Listens exclusively to outgoing messages sent by the business owner (`message.fromMe === true`).
- **Zero Customer Interruption (Silent Mode)**: When bills or payments are sent in customer chats, the bot logs them silently without sending automated replies or reactions to customers.
- **Bilingual Numeral Normalization**: Seamlessly recognizes Bengali digits (`০-৯`) and standard English digits (`0-9`), including decimal amounts.
- **Self-Chat Due Reports**: Sending `!due` in your own WhatsApp chat ("Message Yourself") returns a complete list of customers with pending balances.
- **Automatic Contact Name Association**: Automatically extracts customer names from WhatsApp contacts when available.
- **Persistent Session with LocalAuth**: Stores WhatsApp multi-device authentication locally in `.wwebjs_auth`—scan the QR code once, and stay logged in across restarts.
- **Embedded SQLite Ledger**: Robust local SQLite database (`data/ledger.db`) running with Write-Ahead Logging (`WAL`) mode for fast and reliable transactions.

---

## 📋 Prerequisites

- **Node.js**: Version 18.0.0 or higher
- **npm**: Version 8.0.0 or higher
- An active WhatsApp account on your smartphone

---

## 🚀 Installation & Setup

1. **Clone or navigate to the project directory**:
   ```bash
   cd D:/munnisoft
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the bot**:
   ```bash
   npm start
   ```

---

## 📱 QR Code Authentication (`LocalAuth`)

When you run `npm start` for the first time:

1. A QR code will be generated directly in your terminal.
2. Open WhatsApp on your phone:
   - Go to **Linked Devices** (Settings > Linked Devices on iOS; Menu `⋮` > Linked devices on Android).
   - Tap **Link a device** and scan the QR code displayed in your terminal.
3. Once authenticated:
   - The session credentials are saved locally in the `.wwebjs_auth/` directory.
   - Subsequent restarts will automatically reuse this saved session without requiring another QR scan.

To log out or reset the session, simply delete the `.wwebjs_auth` folder.

---

## 💬 Usage Examples

### 1. Recording a Bill (Silent Mode)
Send a message to any customer chat using the standard bill format:
```text
বিল ৪০০ টাকা
```
- **Variants supported**:
  - `বিল ৩০ টাকা` (Bengali numerals)
  - `বিল 400 টাকা` (English numerals)
  - `বিল ১৫০.৫০ টাকা` (Decimal amounts)
- **Bot Action**: Silently parses the amount and records a `BILL` transaction against that customer's phone number. No reply is sent to the customer chat.
- **Console Log**:
  ```text
  [BILL] 400 BDT recorded for +88017XXXXXXXX. Current due: 400 BDT
  ```

### 2. Recording a Payment (Silent Mode)
When a customer pays, send the acknowledgment message in their chat:
```text
৫৬ টাকা পেয়েছি, ধন্যবাদ
```
- **Variants supported**:
  - `৫৬ টাকা পেয়েছি, ধন্যবাদ`
  - `56 টাকা পেয়েছি ধন্যবাদ` (without comma)
  - `১২০.৫০ টাকা পেয়েছি, ধন্যবাদ` (decimals)
- **Bot Action**: Silently logs a `PAYMENT` transaction, reducing the customer's outstanding balance. No automated bot message is sent to the customer.
- **Console Log**:
  ```text
  [PAYMENT] 56 BDT recorded for +88017XXXXXXXX. Current due: 344 BDT
  ```

### 3. Checking Outstanding Dues (`!due`)
Open WhatsApp and navigate to your **Message Yourself** (self-chat) conversation. Send:
```text
!due
```
- **Bot Action**: Queries the SQLite database for all customers with a positive balance (`total_bill - total_paid > 0`) and replies directly in the self-chat with a formatted summary:

```text
📋 *বকেয়া তালিকা (Due List)*:
১. 88017XXXXXXXX (Rahim): ৪০০ টাকা
২. 88018XXXXXXXX (Karim): ৫০ টাকা
─────────────────────
মোট বকেয়া: ৪৫০ টাকা (২ জন গ্রাহক)
```

If there are no outstanding dues, the bot responds:
```text
✅ বর্তমানে কোনো গ্রাহকের বকেয়া নেই!
```

---

## ⚙️ Configuration & Environment Variables

The application comes with sensible defaults and supports optional environment variables:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `DB_PATH` | `./data/ledger.db` | Path to the SQLite ledger database file. |
| `AUTH_DATA_PATH` | `./.wwebjs_auth` | Path to the WhatsApp session storage directory. |
| `PORT` | `3000` | HTTP port for web dashboard and health check. |
| `ADMIN_SECRET` | `""` | Secret token to secure `/api/backup` database downloads. |
| `PAIR_PHONE_NUMBER` | `""` | (Optional) Phone number (e.g. `01712345678`) to auto-request an 8-character login pairing code instead of scanning QR code. |

---

## 🧪 Running Tests

The test suite uses Node.js's built-in test runner (`node:test`) and asserts coverage across message parsing, database operations, and bot message routing:

```bash
npm test
```

Expected output:
```text
# tests 26
# suites 5
# pass 26
# fail 0
```

---

## 📂 Project Structure

```
munnisoft/
├── data/
│   └── ledger.db              # SQLite database (auto-generated on startup)
├── src/
│   ├── config.js              # Database, port, and session path configuration
│   ├── parser.js              # Bengali/English numeral normalization & pattern matcher
│   ├── db.js                  # SQLite database initialization, migrations & queries
│   ├── audio.js               # Audio duration extraction & tiered billing formula
│   ├── server.js              # HTTP health check & web dashboard server
│   └── bot.js                 # WhatsApp Web event handlers, router & formatters
├── tests/                     # Automated test suites
├── Dockerfile                 # Production container for Render.com free tier
├── render.yaml                # Render Blueprint deployment definition
├── RENDER_DEPLOY.md           # Step-by-step Render cloud hosting guide
├── index.js                   # Application bootstrap and graceful shutdown handler
├── package.json               # Project manifest & npm scripts
└── README.md                  # Project documentation & usage guide
```

---

## ☁️ Deploying to Render.com (Free Tier)

This bot is fully optimized to run on **Render.com Free Tier ($0/month)**:
- **Phone Number Login (No Camera/QR Required)**: Enter your WhatsApp phone number on the web dashboard to instantly generate an 8-character pairing code (`ABCD - 1234`) and link directly from your phone!
- **Built-in HTTP Health Check**: Listens on `$PORT` with `/healthz` answering `200 OK`.
- **Web QR Code Viewer**: Open `https://<your-app>.onrender.com/qr` if you prefer scanning QR code.
- **Web Status Dashboard**: View real-time connection status and outstanding customer balances at `https://<your-app>.onrender.com`.
- **Container Memory Tuning**: Pre-configured flags for Render's 512MB RAM cap.

👉 **See the complete step-by-step cloud guide in [RENDER_DEPLOY.md](RENDER_DEPLOY.md).**

---

## 🛡️ License

MIT License. Designed and developed for business ledger management.
