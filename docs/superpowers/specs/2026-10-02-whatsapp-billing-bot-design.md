# WhatsApp Audio Document Billing Bot - Technical Specification

## Overview
A Node.js WhatsApp Bot using `whatsapp-web.js` designed for audio document duration measurement, automated tier-based bill calculation, response messaging, and customer balance ledgering in a local JSON file (`bills.json`). Prepared with a custom `Dockerfile` for continuous 24/7 hosting on Render/Koyeb.

## Core Features & Workflows

### 1. Audio Document Handler
- Listens for incoming and outgoing messages.
- Filter criteria:
  - `message.hasMedia === true`
  - `message.type === 'document'` (Excludes `ptt` voice notes).
  - Media MIME type belongs to audio formats (`audio/mp3`, `audio/wav`, `audio/m4a`, `audio/ogg`, `audio/mpeg`, etc.) or filename extension is `.mp3`, `.wav`, `.m4a`, `.ogg`, `.aac`, `.flac`, `.wma`.
- Downloads media buffer using `message.downloadMedia()`.
- Calculates exact audio duration in seconds using `music-metadata`.

### 2. Tiered Billing Algorithm
The formula for audio duration in seconds `S`:
- `S <= 68` (0:00 to 1:08): **50 Taka**
- `69 <= S <= 79` (1:09 to 1:19): **75 Taka**
- For `S >= 80` (1:20 onwards):
  - Offset `offset = S - 80`
  - Cycle index `k = Math.floor(offset / 60)`
  - Remainder `remainder = offset % 60`
  - If `remainder <= 48` (corresponds to x:20 to (x+1):08): **`100 + (k * 50)` Taka**
  - Else `remainder > 48` (corresponds to (x+1):09 to (x+1):19): **`125 + (k * 50)` Taka**

### 3. Customer Ledger (`bills.json`)
Persistence mechanism:
```json
{
  "8801700000000": {
    "totalBill": 250,
    "transactions": [
      {
        "timestamp": "2026-10-02T21:38:00.000Z",
        "filename": "document_audio.mp3",
        "durationSeconds": 75,
        "durationFormatted": "1:15",
        "amount": 75
      }
    ]
  }
}
```

### 4. Bengali Commands
- **`হিসাব`**: Replies with the sender's current unpaid bill balance and transaction count.
- **`বিল ক্লিয়ার`**: Resets the sender's bill balance to 0 and sends confirmation.

### 5. Render / Koyeb Docker Environment
- Includes Express server listening on `process.env.PORT || 3000` for health check `/`.
- Uses system Chromium with `--no-sandbox` flags.
