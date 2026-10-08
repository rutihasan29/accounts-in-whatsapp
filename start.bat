@echo off
title WhatsApp Business Ledger Bot
cd /d "%~dp0"

echo ====================================================
echo       WhatsApp Business Ledger Bot Starter
echo ====================================================
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not found in PATH!
    echo Please install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: Check if dependencies are installed
if not exist "node_modules\" (
    echo [INFO] node_modules not found. Running npm install...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed!
        pause
        exit /b 1
    )
)

echo [INFO] Starting WhatsApp Business Ledger Bot...
echo [INFO] Press Ctrl+C anytime to stop the bot.
echo.

call npm start

echo.
echo [INFO] Bot process terminated.
pause
