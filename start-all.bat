@echo off
rem Starts the backend and the Cloudflare tunnel, each in its own window.
setlocal
start "GMAO backend" "%~dp0start-backend.bat"
timeout /t 6 /nobreak >nul
start "Cloudflare tunnel" "%~dp0start-tunnel.bat"
