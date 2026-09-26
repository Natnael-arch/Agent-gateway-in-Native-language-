@echo off
setlocal
title Agelgay Activation
cd /d "%~dp0"

echo ========================================
echo   Agelgay Launcher
echo ========================================
echo.

if exist "%~dp0node\node.exe" (
    "%~dp0node\node.exe" "%~dp0activate.js" %*
) else if exist "%~dp0..\node\node.exe" (
    "%~dp0..\node\node.exe" "%~dp0activate.js" %*
) else (
    node "%~dp0activate.js" %*
)

if %ERRORLEVEL% neq 0 (
    echo.
    echo Activation encountered an error (exit code %ERRORLEVEL%).
    echo Press any key to exit.
    pause >nul
)
