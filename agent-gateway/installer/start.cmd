@echo off
setlocal
title Agelgay Amharic Agent Gateway
cd /d "%~dp0"

echo =======================================================
echo Agelgay Amharic Agent Gateway Server
echo =======================================================
echo.
echo Starting gateway...
echo Listening on http://localhost:3000
echo Press Ctrl+C to stop the gateway.
echo.

if exist "%~dp0node\node.exe" (
    if exist "%~dp0agent-gateway\server.js" (
        "%~dp0node\node.exe" "%~dp0agent-gateway\server.js" %*
    ) else if exist "%~dp0..\agent-gateway\server.js" (
        "%~dp0node\node.exe" "%~dp0..\agent-gateway\server.js" %*
    ) else if exist "%~dp0server.js" (
        "%~dp0node\node.exe" "%~dp0server.js" %*
    )
) else if exist "%~dp0..\node\node.exe" (
    if exist "%~dp0agent-gateway\server.js" (
        "%~dp0..\node\node.exe" "%~dp0agent-gateway\server.js" %*
    ) else if exist "%~dp0..\..\agent-gateway\server.js" (
        "%~dp0..\node\node.exe" "%~dp0..\..\agent-gateway\server.js" %*
    ) else if exist "%~dp0server.js" (
        "%~dp0..\node\node.exe" "%~dp0server.js" %*
    )
) else (
    if exist "%~dp0agent-gateway\server.js" (
        node "%~dp0agent-gateway\server.js" %*
    ) else (
        node "%~dp0server.js" %*
    )
)

if %ERRORLEVEL% neq 0 (
    echo.
    echo Gateway server exited with error code %ERRORLEVEL%.
    echo Press any key to exit.
    pause >nul
)
