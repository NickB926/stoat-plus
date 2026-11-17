@echo off
setlocal
cd /d "%~dp0android"
where java >nul 2>nul || (echo Java isn't installed. Install a JDK 17+ and run this again. & pause & exit /b 1)

echo Building the Stoat+ Android app (the first build takes a long time)...
call gradlew.bat :app:assembleRelease --console=plain > ..\android-build.log 2>&1
if errorlevel 1 (
  echo.
  echo Build failed - the output was saved to android-build.log.
  pause
  exit /b 1
)

copy /y "app\build\outputs\apk\release\app-release.apk" "..\Stoat+.apk" >nul
echo.
echo Done. The app is at %~dp0Stoat+.apk
echo Copy it to your phone and open it to install (allow installs from unknown sources).
echo With a phone plugged in over USB debugging you can also run:
echo   "%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" install -r "%~dp0Stoat+.apk"
pause
exit /b 0
