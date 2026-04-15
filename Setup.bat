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

REM === ADIM 1: Python kontrol ve otomatik kurulum ===
echo [1/4] Python kontrol ediliyor...
call :check_python
if "!PYTHON_OK!"=="1" goto :python_ready

echo  [!] Python 3.12+ bulunamadi. Otomatik kuruluyor...
echo.

REM Once winget ile dene (Windows 11 / guncel Windows 10)
winget --version >nul 2>&1
if errorlevel 1 goto :python_manual

echo  [*] winget ile Python 3.12 kuruluyor...
winget install -e --id Python.Python.3.12 --silent --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto :python_manual

REM PATH'i yenile
call :refresh_path
call :check_python
if "!PYTHON_OK!"=="1" (
    echo  [OK] Python !PYVER! kuruldu
    goto :python_ready
)

:python_manual
echo  [*] Python 3.12 indiriliyor (python.org)...
set PY_URL=https://www.python.org/ftp/python/3.12.9/python-3.12.9-amd64.exe
set PY_INSTALLER=%TEMP%\python-3.12-installer.exe

powershell -Command "Invoke-WebRequest -Uri '%PY_URL%' -OutFile '%PY_INSTALLER%' -UseBasicParsing"
if errorlevel 1 (
    echo  [HATA] Python indirilemedi. Internet baglantinizi kontrol edin.
    echo  Manuel kurulum: https://python.org
    pause
    exit /b 1
)

echo  [*] Python 3.12 yukleniyor...
"%PY_INSTALLER%" /quiet InstallAllUsers=0 PrependPath=1 Include_test=0
if errorlevel 1 (
    echo  [HATA] Python kurulumu basarisiz!
    pause
    exit /b 1
)
del "%PY_INSTALLER%" >nul 2>&1

REM PATH'i yenile
call :refresh_path
call :check_python
if "!PYTHON_OK!"=="0" (
    echo  [HATA] Python kuruldu ama bulunamadi. Terminali yeniden ac ve Setup.bat tekrar calistir.
    pause
    exit /b 1
)
echo  [OK] Python !PYVER! kuruldu

:python_ready
echo  [OK] Python !PYVER! hazir

REM === ADIM 2: FFmpeg kontrol ve otomatik kurulum ===
echo.
echo [2/4] FFmpeg kontrol ediliyor...
ffmpeg -version >nul 2>&1
if not errorlevel 1 (
    echo  [OK] FFmpeg mevcut
    goto :ffmpeg_ready
)

echo  [!] FFmpeg bulunamadi. Otomatik kuruluyor...
winget --version >nul 2>&1
if not errorlevel 1 (
    winget install -e --id Gyan.FFmpeg --silent --accept-source-agreements --accept-package-agreements
    call :refresh_path
    ffmpeg -version >nul 2>&1
    if not errorlevel 1 (
        echo  [OK] FFmpeg kuruldu
        goto :ffmpeg_ready
    )
)

echo  [!] FFmpeg winget ile kurulamadi. Manuel kurulum gerekebilir.
echo      winget install Gyan.FFmpeg
echo      veya: https://ffmpeg.org/download.html

:ffmpeg_ready

REM === ADIM 3: Virtual environment ===
echo.
echo [3/4] Virtual environment hazirlaniyor...
set VENV=%~dp0.venv
set VENV_PY=%VENV%\Scripts\python.exe

if not exist "!VENV_PY!" (
    echo  [*] .venv olusturuluyor...
    python -m venv "!VENV!"
    if errorlevel 1 (
        echo.
        echo  [HATA] Virtual environment olusturulamadi!
        pause
        exit /b 1
    )
    echo  [*] pip guncelleniyor...
    "!VENV_PY!" -m pip install --upgrade pip --quiet
) else (
    echo  [OK] .venv zaten mevcut
)
echo  [OK] Virtual environment hazir

REM === ADIM 4: Paket kurulumu ===
echo.
echo [4/4] Paket kurulumu baslatiliyor...
echo  Bu islem GPU'ya ve internet hizina gore 15-30 dk surebilir.
echo  Lutfen bekleyin...
echo.

"!VENV_PY!" "%~dp0installer\setup_packages.py"

if errorlevel 1 (
    echo.
    echo  [HATA] Kurulum tamamlanamadi!
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

REM === Otomatik baslama kaydi ===
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
exit /b 0


REM ── Yardimci fonksiyonlar ──────────────────────────────────────────

:check_python
set PYTHON_OK=0
set PYVER=
python --version >nul 2>&1
if errorlevel 1 exit /b 0
for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PYVER=%%v
for /f "tokens=1,2 delims=." %%a in ("!PYVER!") do (
    set PY_MAJ=%%a
    set PY_MIN=%%b
)
if !PY_MAJ! LSS 3 exit /b 0
if !PY_MAJ! EQU 3 if !PY_MIN! LSS 12 exit /b 0
set PYTHON_OK=1
exit /b 0

:refresh_path
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v PATH 2^>nul') do set USR_PATH=%%b
for /f "tokens=2*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v PATH 2^>nul') do set SYS_PATH=%%b
set PATH=!SYS_PATH!;!USR_PATH!
exit /b 0
