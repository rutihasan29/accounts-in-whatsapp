@echo off
title News Voice - Cloudflare Public Mobile Tunnel
cd /d "%~dp0"

echo ====================================================
echo       News Voice - Cloudflare Public Mobile Tunnel
echo ====================================================
echo.
echo Starting secure public HTTPS tunnel for port 3050...
echo.

cloudflared tunnel --url http://localhost:3050

pause
