@echo off
chcp 65001 >nul
setlocal
title CyberCall

set "TARGET=%LOCALAPPDATA%\CyberCall"
set "INSTALLER=%TARGET%\VencordInstallerCli.exe"

if not exist "%~dp0dist\patcher.js" (
    echo Рядом с install.bat нет папки dist.
    echo Сначала распакуй весь архив CyberCall-win.zip, потом запускай install.bat.
    pause
    exit /b 1
)

echo [1/4] Закрываю Discord...
taskkill /IM Discord.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2/4] Копирую файлы в %TARGET%
if exist "%TARGET%\dist" rmdir /S /Q "%TARGET%\dist"
xcopy "%~dp0dist" "%TARGET%\dist\" /E /I /Y /Q >nul
if errorlevel 1 (
    echo Не получилось скопировать файлы.
    pause
    exit /b 1
)

echo [3/4] Скачиваю установщик Vencord...
curl.exe -L --fail -s -o "%INSTALLER%" "https://github.com/Vencord/Installer/releases/latest/download/VencordInstallerCli.exe"
if errorlevel 1 (
    echo Не получилось скачать установщик. Проверь интернет или VPN и запусти ещё раз.
    pause
    exit /b 1
)

echo [4/4] Подключаю к Discord...
set "VENCORD_USER_DATA_DIR=%TARGET%"
set "VENCORD_DEV_INSTALL=1"
"%INSTALLER%" -install -branch auto
if errorlevel 1 (
    echo.
    echo Автоматически не вышло, открываю установщик в ручном режиме: выбери Install и свой Discord.
    "%INSTALLER%"
)

echo.
echo Готово. Запускаю Discord.
echo Включи плагин: Настройки - Vencord - Plugins - CyberCall.
if exist "%LOCALAPPDATA%\Discord\Update.exe" start "" "%LOCALAPPDATA%\Discord\Update.exe" --processStart Discord.exe
pause
