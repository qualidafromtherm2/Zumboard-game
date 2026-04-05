@echo off
REM Restart frontend + backend servers
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restart-servers.ps1"
