@echo off
setlocal enabledelayedexpansion
title VoiceCraft AI
chcp 65001 >nul 2>nul

echo.
echo  ============================================
echo   VoiceCraft AI -- Baslatiyor
echo  ============================================
echo.

REM Yerel FFmpeg bin klasoru PATH'e ekle
set PATH=%~dp0bin;%PATH%

REM Virtual environment kontrol
set VENV_PY=%~dp0.venv\Scripts\python.exe

if not exist "!VENV_PY!" (
    echo  [!] Kurulum yapilmamis!
    echo.
    echo  Lutfen once Setup.bat dosyasini calistirin.
    echo.
    pause
    exit /b 1
)

echo  [*] Sunucu baslatiliyor...
echo.
"!VENV_PY!" "%~dp0launcher.py"

REM Sunucu beklenmedik sekilde kapandiysa bekle
echo.
echo  [*] Sunucu kapandi.
pause
