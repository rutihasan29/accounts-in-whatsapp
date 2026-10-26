@echo off
title Munni Soft - Ngrok Mobile Public Tunnel
cd /d "%~dp0"

echo ====================================================
echo         Munni Soft - Ngrok Public Mobile Tunnel
echo ====================================================
echo.
echo Starting Ngrok tunnel for port 3000...
echo.

node -e "require('./src/tunnel').startNgrokTunnel({ port: 3000 })"

pause
