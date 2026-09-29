@echo off
rem Run the bridge in the foreground so every message stays on screen.
rem ASCII only on purpose: see scripts/make-launchers.mjs
setlocal
cd /d "%~dp0"
chcp 65001 >nul 2>nul

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on PATH. Install Node.js 22 or newer.
  pause
  endlocal
  exit /b 1
)

echo Starting dsh-chat-bridge in the foreground. Press Ctrl+C to stop.
echo.
node "src/index.mjs" %*
echo.
echo The service has stopped.
pause
endlocal
