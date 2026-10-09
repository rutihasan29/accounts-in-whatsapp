# 🚀 Render.com Free Tier Deployment Guide

This guide explains how to deploy the WhatsApp Business Ledger Bot (`munnisoft-v3`) to **Render.com's Free Tier** ($0/month).

---

## 🌟 Key Render Features Included in v3

1. **HTTP Health Check & Port Binding**: Listens on `PORT` (automatically provided by Render) with `/healthz` answering `200 OK`.
2. **Web QR Code Viewer**: Open `https://<your-service>.onrender.com/qr` in any browser or phone to scan the QR code without checking terminal logs.
3. **Web Status Dashboard**: View bot connection status, uptime, and outstanding customer due balances at `https://<your-service>.onrender.com`.
4. **Optimized for 512 MB RAM**: Chromium flags tuned to prevent memory leaks and container sandbox errors (`--disable-dev-shm-usage`, `--no-sandbox`, `--disable-gpu`, etc.).
5. **Phone Number Login Support**: Link your WhatsApp account with an 8-character pairing code without needing a camera or QR scan.
6. **Database Backup Endpoint**: Download SQLite database backups anytime from `/api/backup`.
7. **Automatic Keep-Alive**: Prevents Render's 15-minute inactivity sleep when configured with external pingers.

---

## 📋 Step-by-Step Deployment Instructions

### Step 1: Push Code to GitHub / GitLab

1. Create a private or public repository on GitHub (e.g., `whatsapp-ledger-bot`).
2. Push your `munnisoft-v3` code to your repository:
   ```bash
   git remote add origin https://github.com/<your-username>/whatsapp-ledger-bot.git
   git branch -M main
   git push -u origin main
   ```

---

### Step 2: Create a Free Web Service on Render

1. Log in to [dashboard.render.com](https://dashboard.render.com).
2. Click **New +** > **Web Service**.
3. Connect your GitHub repository.
4. Fill in the service configuration:
   - **Name**: `whatsapp-ledger-bot` (or your preferred name)
   - **Language / Environment**: `Docker` *(Recommended: Render will automatically use the included Dockerfile)*
   - **Region**: Choose the closest region to you (e.g., `Singapore` or `Frankfurt`)
   - **Branch**: `main` (or `master`)
   - **Instance Type**: `Free` ($0/mo, 512 MB RAM)

---

### Step 3: Configure Environment Variables

Under **Environment Variables**, add the following:

| Variable | Recommended Value | Purpose |
| :--- | :--- | :--- |
| `PORT` | `10000` | Port for HTTP server and Render health checks |
| `ADMIN_SECRET` | *(Any secure random password)* | Protects `/api/backup` from unauthorized access |
| `RENDER_EXTERNAL_URL` | `https://whatsapp-ledger-bot.onrender.com` | Your public Render URL for auto-pinging |
| `PAIR_PHONE_NUMBER` | `017XXXXXXXX` | *(Optional)* Pre-set WhatsApp phone number to auto-request pairing code |

Click **Create Web Service**.

---

### Step 4: Login to WhatsApp (Phone Pairing Code or QR Scan)

Once the service is running, open your web dashboard:
```
https://<your-app-name>.onrender.com
```

#### Option A: Phone Number Pairing Code (⭐ Recommended - No Camera Needed)
1. In the **"ফোন নম্বর দিয়ে লগইন (Pairing Code)"** box on the dashboard, enter your WhatsApp phone number (e.g., `01712345678`).
2. Click **"⚡ কোড নিন"**.
3. You will receive an 8-character pairing code (e.g., `ABCD - 1234`).
4. On your phone:
   - Open WhatsApp > **Settings** (or `⋮` on Android) > **Linked Devices**.
   - Tap **Link a device**.
   - Tap **"Link with phone number instead"** (বা **"ফোন নম্বর দিয়ে লিংক করুন"**) at the bottom.
   - Enter the 8-character code shown on the screen!

#### Option B: QR Code Scanning
1. On the same dashboard (or visit `/qr`), wait for the QR code to load.
2. Open WhatsApp > **Linked Devices** > **Link a device**.
3. Scan the QR code with your phone camera.

Once paired, the status will show:
`✅ Bot is Active & Running - Logged in as: +8801xxxxxxxxx`.

---

### Step 5: Keep Bot Online 24/7 (Prevent Free Tier Sleep)

Render's free tier spins down web services after 15 minutes of inactivity. To keep your WhatsApp bot connected 24/7 for free:

1. Go to [cron-job.org](https://cron-job.org) (or [UptimeRobot](https://uptimerobot.com)).
2. Create a free account.
3. Add a new monitor / cron job:
   - **URL**: `https://<your-app-name>.onrender.com/healthz`
   - **Interval**: Every **10 minutes** (or 5 minutes)
   - **Request Method**: `GET`
4. Save the monitor. This sends an HTTP request every 10 minutes, keeping your Render free container awake 24/7!

---

### Step 6: Backup Your Database

Because Render Free Tier uses ephemeral storage (files reset if the container is redeployed):
- Download your database backup anytime:
  ```
  https://<your-app-name>.onrender.com/api/backup?token=<YOUR_ADMIN_SECRET>
  ```
- Or click the **Download Database Backup** button on the web dashboard.
