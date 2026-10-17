@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\local-service.ps1" -Action start %*
set "COYOTE_EXIT=%ERRORLEVEL%"
if not "%COYOTE_EXIT%"=="0" pause
exit /b %COYOTE_EXIT%
