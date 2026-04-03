@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found in PATH.
  pause
  exit /b 1
)
node tools\official-buddy-lab\start-buddy-studio.mjs
if errorlevel 1 (
  echo.
  echo Buddy Studio did not start successfully.
  pause
  exit /b 1
)
