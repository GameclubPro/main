@echo off
setlocal
set ELECTRON_RUN_AS_NODE=

where node >nul 2>nul || (
  echo Node.js is required. Install Node.js 22 LTS or newer, then run this file again.
  exit /b 1
)

where npm >nul 2>nul || (
  echo npm is required. Reinstall Node.js with npm enabled, then run this file again.
  exit /b 1
)

node -e "const v=process.versions.node.split('.').map(Number); const ok=(v[0]===20&&v[1]>=19)||(v[0]===22&&v[1]>=12)||v[0]>22; if(!ok){console.error('Node.js 20.19.0 or 22.12.0+ is required. Current version: '+process.versions.node); process.exit(1);}" || exit /b 1

call npm ci || exit /b 1
call npm run build || exit /b 1
echo.
echo Setup complete. Start the launcher with run-windows.cmd
endlocal
