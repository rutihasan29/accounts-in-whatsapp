@echo off
title News Voice - Official Ledger Dashboard
cd /d "%~dp0"

echo ====================================================
echo       News Voice - Official Ledger Web Dashboard
echo ====================================================
echo.

node src/server.js

pause
