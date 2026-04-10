@echo off
chcp 65001 >nul 2>&1
title SoloPlayer Server

echo ================================
echo   SoloPlayer - Starting Server
echo ================================
echo.

REM ポート8090を使用中のプロセスを終了
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8090 " ^| findstr "LISTENING"') do (
    echo Port 8090 is in use by PID %%a. Killing...
    taskkill /PID %%a /F >nul 2>&1
)

echo Starting server on http://localhost:8090
echo Press Ctrl+C to stop.
echo.

start http://localhost:8090

python -m http.server 8090
