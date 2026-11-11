@echo off
chcp 65001 >nul
setlocal
title CyberCall - удаление

set "TARGET=%LOCALAPPDATA%\CyberCall"
set "INSTALLER=%TARGET%\VencordInstallerCli.exe"

if not exist "%INSTALLER%" (
    echo CyberCall не установлен.
    pause
    exit /b 0
)

taskkill /IM Discord.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul
set "VENCORD_USER_DATA_DIR=%TARGET%"
set "VENCORD_DEV_INSTALL=1"
"%INSTALLER%" -uninstall -branch auto
rmdir /S /Q "%TARGET%"
echo Удалено. Discord снова обычный.
pause
