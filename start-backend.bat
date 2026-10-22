@echo off
rem Starts the GMAO backend (port 4000). Double-click this file.
rem Close the window to stop the server.
setlocal
title GMAO backend

cd /d "%~dp0backend" || goto :nofolder
where node >nul 2>nul || goto :nonode

rem Install packages the first time, or when the "compression" package is missing.
if exist "node_modules\compression" goto :haspackages
echo Installing packages (first time only, needs internet)...
call npm install
if errorlevel 1 goto :fail
:haspackages

if not exist ".env" goto :noenv

echo.
echo Starting the backend on port 4000. Keep this window open.
echo.
call npm start
echo.
echo The backend has stopped.
goto :end

:nofolder
echo ERROR: the "backend" folder was not found next to this file.
goto :end
:nonode
echo ERROR: Node.js is not installed or not in PATH. Install it from https://nodejs.org then try again.
goto :end
:noenv
echo ERROR: backend\.env is missing. Copy backend\.env.example to backend\.env and fill in the SQL Server settings.
goto :end
:fail
echo ERROR: npm install failed. See the messages above.
:end
echo.
pause
