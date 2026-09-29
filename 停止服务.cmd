@echo off
rem Stop the running bridge (whatever listens on the console port).
rem ASCII only on purpose: see scripts/make-launchers.mjs
setlocal
cd /d "%~dp0"
node "scripts/launch.mjs" --kill
echo.
endlocal
