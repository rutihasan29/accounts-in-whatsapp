@echo off
title Munni Soft - Official Ledger Dashboard
cd /d "%~dp0"

echo ====================================================
echo       Munni Soft - Official Ledger Web Dashboard
echo ====================================================
echo.

node src/server.js

pause
