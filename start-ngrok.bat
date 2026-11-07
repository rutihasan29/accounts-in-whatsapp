@echo off
title News Voice - Ngrok Mobile Public Tunnel
cd /d "%~dp0"

echo ====================================================
echo         News Voice - Ngrok Public Mobile Tunnel
echo ====================================================
echo.
echo Starting Ngrok tunnel for port 3050...
echo.

node -e "require('./src/tunnel').startNgrokTunnel()"

pause
