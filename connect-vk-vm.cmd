@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\connect-vk-vm.ps1" %*
exit /b %ERRORLEVEL%
