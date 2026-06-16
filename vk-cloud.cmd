@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\vk-cloud.ps1" %*
exit /b %ERRORLEVEL%
