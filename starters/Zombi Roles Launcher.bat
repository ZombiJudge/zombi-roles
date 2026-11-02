@echo off
title Zombi Roles
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto need_node

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 goto need_node

rem Runs in the background with no window. Shut down from the panel.
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath node -ArgumentList 'launcher.mjs' -WindowStyle Hidden"
exit /b

:need_node
echo Zombi Roles needs Node.js 24 or newer, a free program from nodejs.org.
echo.
echo Your browser will open the download page now. Choose the LTS version and
echo install it with the normal options. Then double-click this file again.
echo.
start "" "https://nodejs.org/en/download"
pause
