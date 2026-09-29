@echo off
rem Start the bridge service in the background (no console window).
rem ASCII only on purpose: see scripts/make-launchers.mjs
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on PATH. Install Node.js 22 or newer.
  pause
  endlocal
  exit /b 1
)

node "scripts/launch.mjs" --no-window
endlocal
