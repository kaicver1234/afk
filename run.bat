@echo off
REM McAfk Bot - double-click to run on Windows.
REM This just launches setup.ps1, which installs Node.js (if missing),
REM installs dependencies and starts the bot.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
pause
