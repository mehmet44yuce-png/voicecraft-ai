@echo off
setlocal enabledelayedexpansion
title VoiceCraft AI -- Kurulum Sihirbazi
chcp 65001 >nul 2>nul

echo.
echo  ============================================
echo   VoiceCraft AI -- Kurulum Sihirbazi
echo   Ses ve Video Editoru
echo  ============================================
echo.

REM === ADIM 1: Python kontrol ===
echo [1/3] Python kontrol ediliyor...
python --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo  [HATA] Python bulunamadi!
    echo.
    echo  Python 3.12+ yukleyin: https://python.org
    echo  Kurulum sirasinda "Add to PATH" secenegini isaretleyin.
    echo.
    pause
    exit /b 1
)

for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo  [OK] Python !PYVER! bulundu

REM Python surum kontrolu: 3.12+ gerekli
for /f "tokens=1,2 delims=." %%a in ("!PYVER!") do (
    set PY_MAJ=%%a
    set PY_MIN=%%b
)
if !PY_MAJ! LSS 3 goto :pyerr
if !PY_MAJ! EQU 3 if !PY_MIN! LSS 12 goto :pyerr
goto :pyok

:pyerr
echo.
echo  [HATA] Python 3.12+ gerekli, !PYVER! bulundu.
echo  Guncelleme: https://python.org
echo.
pause
exit /b 1

:pyok

REM === ADIM 2: Virtual environment ===
echo.
echo [2/3] Virtual environment hazirlaniyor...
set VENV=%~dp0.venv
set VENV_PY=%VENV%\Scripts\python.exe

if not exist "!VENV_PY!" (
    echo  [*] .venv olusturuluyor...
    python -m venv "!VENV!"
    if errorlevel 1 (
        echo.
        echo  [HATA] Virtual environment olusturulamadi!
        echo  Disk alani veya izin sorunu olabilir.
        echo.
        pause
        exit /b 1
    )
    echo  [*] pip guncelleniyor...
    "!VENV_PY!" -m pip install --upgrade pip --quiet
) else (
    echo  [OK] .venv zaten mevcut
)
echo  [OK] Virtual environment hazir

REM === ADIM 3: Paket kurulumu ===
echo.
echo [3/3] Paket kurulumu baslatiliyor...
echo  Bu islem GPU'ya ve internet hizina gore 10-30 dk surebilir.
echo  Lutfen bekleyin...
echo.

"!VENV_PY!" "%~dp0installer\setup_packages.py"

if errorlevel 1 (
    echo.
    echo  [HATA] Kurulum tamamlanamadi!
    echo  Yukaridaki hata mesajlarina bakin.
    echo.
    pause
    exit /b 1
)

REM === Uyumluluk yamalari ===
echo  [*] Uyumluluk yamalari uygulanıyor...
"!VENV_PY!" "%~dp0setup_compat.py"

REM === .env olustur (yoksa) ===
if not exist "%~dp0.env" (
    if exist "%~dp0.env.default" (
        echo  [*] .env olusturuluyor...
        copy "%~dp0.env.default" "%~dp0.env" >nul
        echo  [OK] HF Token ayarlandi
    )
) else (
    echo  [OK] .env zaten mevcut
)

REM === Otomatik baslama kaydı ===
echo  [*] Otomatik baslama ekleniyor...
"!VENV_PY!" "%~dp0add_to_startup.py"

echo.
echo  ============================================
echo   [OK] Kurulum basariyla tamamlandi!
echo.
echo   Baslatmak icin: VoiceCraft-AI.bat
echo  ============================================
echo.
pause
