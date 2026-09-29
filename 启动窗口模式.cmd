@echo off
rem ============================================================
rem  dsh-chat-bridge - start the bridge and open the console
rem  (ASCII only on purpose: see scripts/make-launchers.mjs)
rem ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :nonode

node "scripts/launch.mjs" %*
if errorlevel 1 goto :failed
endlocal
exit /b 0

:nonode
echo.
echo   [ERROR] Node.js was not found on PATH.
echo   Install Node.js 22 or newer: https://nodejs.org/
call :maybe_pause
endlocal
exit /b 1

:failed
echo.
echo   Startup failed. See bridge.log in this folder,
echo   or run the troubleshooting launcher to watch the output.
call :maybe_pause
endlocal
exit /b 1

rem Wait for a key only when a human is watching; when the output is redirected
rem or piped (automation, CI, a script calling us) waiting would hang forever.
:maybe_pause
set "_interactive=1"
2>nul (set /p =<nul) || set "_interactive="
if defined _interactive pause
exit /b 0
