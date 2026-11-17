@echo off
setlocal
cd /d "%~dp0desktop"
where node >nul 2>nul || (echo Node.js isn't installed. Get it from https://nodejs.org and run this again. & pause & exit /b 1)

rem Close a running copy so its files can be replaced.
powershell -NoProfile -Command "Get-Process stoat-plus -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }; Start-Sleep 2; Get-Process stoat-plus -ErrorAction SilentlyContinue | Stop-Process -Force"

echo Installing dependencies (first run only takes a while)...
call npx -y pnpm@11.17.0 install --frozen-lockfile > ..\desktop-build.log 2>&1

echo Building Stoat+ for desktop...
call npx -y pnpm@11.17.0 run package >> ..\desktop-build.log 2>&1
if errorlevel 1 (
  echo.
  echo Build failed - the output was saved to desktop-build.log.
  pause
  exit /b 1
)

echo.
echo Done. Starting Stoat+...
start "" "%~dp0desktop\out\Stoat Plus-win32-x64\stoat-plus.exe"
exit /b 0
