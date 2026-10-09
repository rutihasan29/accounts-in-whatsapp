# 🚀 Render.com Free Tier Deployment Guide

This guide explains how to deploy the WhatsApp Business Ledger Bot (`munnisoft-v3`) to **Render.com's Free Tier** ($0/month).

---

## 🌟 Key Render Features Included in v3

1. **HTTP Health Check & Port Binding**: Listens on `PORT` (automatically provided by Render) with `/healthz` answering `200 OK`.
2. **Web QR Code Viewer**: Open `https://<your-service>.onrender.com/qr` in any browser or phone to scan the QR code without checking terminal logs.
3. **Web Status Dashboard**: View bot connection status, uptime, and outstanding customer due balances at `https://<your-service>.onrender.com`.
4. **Optimized for 512 MB RAM**: Chromium flags tuned to prevent memory leaks and container sandbox errors (`--disable-dev-shm-usage`, `--single-process`, etc.).
5. **Database Backup Endpoint**: Download SQLite database backups anytime from `/api/backup`.
6. **Automatic Keep-Alive**: Prevents Render's 15-minute inactivity sleep when configured with external pingers.

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

Click **Create Web Service**.

---

### Step 4: Scan WhatsApp QR Code via Web Browser

1. Wait 2-3 minutes while Render builds the Docker image and starts the container.
2. Once the service is running, open:
   ```
   https://<your-app-name>.onrender.com/qr
   ```
   *(or visit the main dashboard at `https://<your-app-name>.onrender.com`)*
3. On your phone:
   - Open WhatsApp > **Settings** (or `⋮` on Android) > **Linked Devices**.
   - Tap **Link a device** and point your camera at the QR code displayed on your screen.
4. Once scanned, the web dashboard will turn green with:
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
