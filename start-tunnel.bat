@echo off
rem Opens a temporary public https address to the backend (Cloudflare quick tunnel).
rem Start the backend first (start-backend.bat). Keep this window open.
setlocal
title Cloudflare tunnel

set "CF=cloudflared"
where cloudflared >nul 2>nul && goto :go
set "CF=C:\cloudflared\cloudflared.exe"
if not exist "%CF%" goto :missing
:go
echo.
echo Look for the line  https://something.trycloudflare.com  below.
echo In the app: login screen, Adresse du serveur, enter that address followed by /api
echo The address changes every time this window is restarted.
echo.
"%CF%" tunnel --url http://localhost:4000
goto :end
:missing
echo ERROR: cloudflared was not found. Put cloudflared.exe in C:\cloudflared or add it to PATH.
:end
echo.
pause
