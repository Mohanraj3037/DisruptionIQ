@echo off
setlocal
cd /d "%~dp0"
title DisruptionIQ - Node.js Backend
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is not on PATH.
  echo Install Node.js 22.16 LTS or newer from https://nodejs.org/
  pause
  exit /b 1
)
node -e "const v=process.versions.node.split('.').map(Number); if(v[0]<22 || (v[0]===22 && v[1]<13)){console.error('DisruptionIQ requires Node.js 22.13 or newer. Current:',process.version);process.exit(1)}; require('node:sqlite'); console.log('Node runtime:',process.version,'- SQLite ready')"
if errorlevel 1 (
  echo Please install Node.js 22.16 LTS or newer and try again.
  pause
  exit /b 1
)
if not exist "instance" mkdir "instance"
if not exist "uploads" mkdir "uploads"
echo.
echo Starting DisruptionIQ 7.0...
echo The server will print the actual login URL after startup.
echo Default port is 3000. If busy, it scans browser-safe ports and skips restricted ports such as 5060/5061.
echo Press CTRL+C to stop.
echo.
npm start
pause
