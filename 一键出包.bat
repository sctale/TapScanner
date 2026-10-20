@echo off
rem TapScanner: double-click to build the signed release APK (local only, no remote push).
rem Output: TapScanner-v<version>.apk in this folder.
setlocal
cd /d "%~dp0"
echo(
echo  [1/2] checking toolchain
where node >nul 2>&1
if errorlevel 1 (
  echo  [ERROR] node not found in PATH. Install Node.js first.
  pause
  exit /b 1
)
echo(
echo  [2/2] running scripts\release-app.ps1 -LocalOnly
powershell -ExecutionPolicy Bypass -File scripts\release-app.ps1 -LocalOnly
set RC=%ERRORLEVEL%
echo(
if "%RC%"=="0" (
  echo  Done. The APK is in this folder.
) else (
  echo  Failed with exit code %RC%. See the messages above.
)
pause
endlocal
