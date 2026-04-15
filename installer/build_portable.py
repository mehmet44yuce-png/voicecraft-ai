"""
VoiceCraft AI — Portable Build Script
Bu script portable dağıtım paketini oluşturur.

Kullanım:
  cd installer
  python build_portable.py

Çıktı: dist/VoiceCraft-AI/ klasörü (zip'lenebilir)
"""
import os
import sys
import shutil
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'installer', 'dist', 'VoiceCraft-AI')
BUILD = os.path.join(ROOT, 'installer', 'build')

def clean():
    """Önceki build'i temizle."""
    for d in [DIST, BUILD]:
        if os.path.exists(d):
            shutil.rmtree(d)
    print('[1/6] Temizlendi')

def copy_app_files():
    """Uygulama dosyalarını kopyala."""
    os.makedirs(DIST, exist_ok=True)

    # server.py
    shutil.copy2(os.path.join(ROOT, 'server.py'), DIST)

    # .env
    env_file = os.path.join(ROOT, '.env')
    if os.path.exists(env_file):
        shutil.copy2(env_file, DIST)

    # .env.default (HF token gömülü — gitignore'da, ZIP'e dahil edilir)
    env_default = os.path.join(ROOT, '.env.default')
    if os.path.exists(env_default):
        shutil.copy2(env_default, DIST)

    # .env.example
    env_ex = os.path.join(ROOT, '.env.example')
    if os.path.exists(env_ex):
        shutil.copy2(env_ex, DIST)

    # public/
    shutil.copytree(os.path.join(ROOT, 'public'), os.path.join(DIST, 'public'))

    # launcher
    shutil.copy2(os.path.join(ROOT, 'installer', 'launcher.py'), DIST)

    # setup_compat.py (Setup.bat tarafindan cagrilir — uyumluluk yamalari)
    shutil.copy2(os.path.join(ROOT, 'setup_compat.py'), DIST)

    # installer/ klasoru: setup_packages.py (Setup.bat tarafindan cagrilir)
    installer_dist = os.path.join(DIST, 'installer')
    os.makedirs(installer_dist, exist_ok=True)
    shutil.copy2(os.path.join(ROOT, 'installer', 'setup_packages.py'), installer_dist)

    # updater.py + version.json
    for f in ['updater.py', 'version.json']:
        src = os.path.join(ROOT, f)
        if os.path.exists(src):
            shutil.copy2(src, DIST)

    # uploads klasörü
    os.makedirs(os.path.join(DIST, 'uploads'), exist_ok=True)

    print('[2/6] Uygulama dosyaları kopyalandı')

def copy_ffmpeg():
    """FFmpeg'i kopyala."""
    ffmpeg_path = shutil.which('ffmpeg')
    if not ffmpeg_path:
        print('[!] FFmpeg bulunamadı — manuel ekleyin')
        return

    ffmpeg_dir = os.path.dirname(ffmpeg_path)
    dest_bin = os.path.join(DIST, 'bin')
    os.makedirs(dest_bin, exist_ok=True)

    for f in ['ffmpeg.exe', 'ffprobe.exe']:
        src = os.path.join(ffmpeg_dir, f)
        if os.path.exists(src):
            shutil.copy2(src, dest_bin)

    print(f'[3/6] FFmpeg kopyalandı: {dest_bin}')

def create_bat_launchers():
    """Windows BAT dosyalarini olustur: Setup.bat + VoiceCraft-AI.bat"""

    # ── Setup.bat ────────────────────────────────────────────────────────
    setup_content = '''@echo off
setlocal enabledelayedexpansion
title VoiceCraft AI -- Kurulum Sihirbazi
chcp 65001 >nul 2>nul

echo.
echo  ============================================
echo   VoiceCraft AI -- Kurulum Sihirbazi
echo  ============================================
echo.

echo [1/3] Python kontrol ediliyor...
python --version >nul 2>&1
if errorlevel 1 (
    echo  [HATA] Python bulunamadi!
    echo  Python 3.12+ yukleyin: https://python.org
    echo  Kurulum sirasinda "Add to PATH" secenegini isaretleyin.
    pause
    exit /b 1
)

for /f "tokens=2" %%v in (\'python --version 2^>^&1\') do set PYVER=%%v
echo  [OK] Python !PYVER! bulundu

for /f "tokens=1,2 delims=." %%a in ("!PYVER!") do (
    set PY_MAJ=%%a
    set PY_MIN=%%b
)
if !PY_MAJ! LSS 3 goto :pyerr
if !PY_MAJ! EQU 3 if !PY_MIN! LSS 12 goto :pyerr
goto :pyok
:pyerr
echo  [HATA] Python 3.12+ gerekli. https://python.org
pause
exit /b 1
:pyok

echo.
echo [2/3] Virtual environment hazirlaniyor...
set VENV=%~dp0.venv
set VENV_PY=%VENV%\\Scripts\\python.exe

if not exist "!VENV_PY!" (
    python -m venv "!VENV!"
    if errorlevel 1 ( echo  [HATA] venv olusturulamadi! & pause & exit /b 1 )
    "!VENV_PY!" -m pip install --upgrade pip --quiet
)
echo  [OK] Virtual environment hazir

echo.
echo [3/3] Paket kurulumu (10-30 dk surebilir)...
echo.
"!VENV_PY!" "%~dp0installer\\setup_packages.py"
if errorlevel 1 (
    echo  [HATA] Kurulum tamamlanamadi!
    pause
    exit /b 1
)

echo.
echo  ============================================
echo   [OK] Kurulum tamamlandi!
echo   Baslatmak icin: VoiceCraft-AI.bat
echo  ============================================
echo.
pause
'''
    setup_path = os.path.join(DIST, 'Setup.bat')
    with open(setup_path, 'w', encoding='utf-8') as f:
        f.write(setup_content)

    # ── VoiceCraft-AI.bat ─────────────────────────────────────────────
    run_content = '''@echo off
setlocal enabledelayedexpansion
title VoiceCraft AI
chcp 65001 >nul 2>nul

echo.
echo  ============================================
echo   VoiceCraft AI -- Baslatiyor
echo  ============================================
echo.

set PATH=%~dp0bin;%PATH%
set VENV_PY=%~dp0.venv\\Scripts\\python.exe

if not exist "!VENV_PY!" (
    echo  [!] Kurulum yapilmamis -- once Setup.bat calistirin.
    pause
    exit /b 1
)

echo  [*] Sunucu baslatiliyor...
echo.
"!VENV_PY!" "%~dp0launcher.py"
echo.
echo  [*] Sunucu kapandi.
pause
'''
    bat_path = os.path.join(DIST, 'VoiceCraft-AI.bat')
    with open(bat_path, 'w', encoding='utf-8') as f:
        f.write(run_content)

    print('[4/6] BAT dosyalari olusturuldu (Setup.bat + VoiceCraft-AI.bat)')

def create_requirements():
    """requirements.txt oluştur."""
    # Mevcut ortamdaki paketleri al
    result = subprocess.run([sys.executable, '-m', 'pip', 'freeze'],
                          capture_output=True, text=True)

    req_path = os.path.join(DIST, 'requirements.txt')
    with open(req_path, 'w') as f:
        f.write(result.stdout)

    # Ayrıca minimal requirements da oluştur
    minimal = """# VoiceCraft AI — Minimal Requirements
#
# KURULUM SIRASI (onemli — once PyTorch, sonra digerler):
#
# ADIM 1 — PyTorch (RTX 40/50 serisi Blackwell/Ada icin cu128 zorunlu):
#   pip install torch==2.11.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cu128
#   (RTX 30xx ve oncesi icin: --index-url https://download.pytorch.org/whl/cu121)
#
# ADIM 2 — Bu dosyadaki paketler (normal pip ile):
#   pip install -r requirements-minimal.txt
#
# ADIM 3 — Resemble Enhance (deepspeed olmadan, --no-deps gerekli):
#   pip install resemble-enhance==0.0.1 --no-deps
#   Sonra 4 dosyada deepspeed import'larini try/except ile sar (README'ye bak)
#
# ADIM 4 — DeepFilterNet / torchaudio 2.11 yaması:
#   df/io.py icinde AudioMetaData ve ta.info() uyumsuzluklarini yama
#
# ADIM 5 — numpy surum sabitleme (deepfilternet <2.0, pyannote >=2.0 catismasi):
#   pip install "numpy==1.26.4"  # 1.26.x her ikisiyle de calisiyor
#
# ADIM 6 — Resemble Enhance model (Git LFS ile):
#   cd .venv/Lib/site-packages/resemble_enhance
#   git clone https://huggingface.co/ResembleAI/resemble-enhance model_repo
#   cd model_repo && git lfs install && git lfs pull

# --- Web Framework ---
flask>=3.1
flask-cors>=6.0
Werkzeug>=3.1

# --- Anthropic / AI API ---
anthropic>=0.94
requests>=2.33
python-dotenv>=1.2
json-repair>=0.59

# --- AI/ML Core ---
faster-whisper>=1.2
openai-whisper>=20250101
demucs>=4.0
noisereduce>=3.0
DeepFilterNet>=0.5.6
silero-vad>=5.1
voicefixer>=0.1.3
# resemble-enhance: pip install resemble-enhance --no-deps (ayri adim, yukarda bak)

# --- Audio ---
soundfile>=0.13
librosa>=0.11
scipy>=1.17
numpy==1.26.4
pyloudnorm>=0.2
pydub>=0.25
sounddevice>=0.5

# --- Pyannote (Diarize) ---
pyannote.audio>=4.0
onnxruntime>=1.24

# --- Sistem / GPU izleme ---
psutil>=7.0
nvidia-ml-py>=13.0
pynvml>=13.0

# --- Versiyon / Release ---
GitPython>=3.1

# --- UI / Tray ---
pystray>=0.19
Pillow>=12.0
"""
    min_path = os.path.join(DIST, 'requirements-minimal.txt')
    with open(min_path, 'w') as f:
        f.write(minimal)

    print('[5/6] Requirements oluşturuldu')

def create_readme():
    """README oluştur."""
    readme = """# VoiceCraft AI — Portable

## Kurulum

### 1. Python 3.12+ gerekli
https://python.org adresinden indirin.
Kurulum sırasında "Add to PATH" seçeneğini işaretleyin.

### 2. Kurulumu çalıştırın
```
Setup.bat
```
Bu script otomatik olarak:
- GPU'nuzu tespit eder (RTX 40/50 -> cu128, RTX 30/öncesi -> cu121, yoksa CPU)
- İzole bir virtual environment oluşturur (.venv/)
- Gerekli tüm AI paketlerini kurar
- Bilinen uyumluluk yamalarını uygular (DeepFilterNet, Resemble Enhance)
- .env dosyasını oluşturur

### 3. HuggingFace Token (Diarize için, opsiyonel)
`.env` dosyasını düzenleyip HF token ekleyin:
```
HF_TOKEN=hf_xxxxxxxxxxxxx
```
https://huggingface.co/settings/tokens adresinden alabilirsiniz.

## Başlatma

`VoiceCraft-AI.bat` dosyasına çift tıklayın.

Tarayıcınızda http://localhost:3000 açılacaktır.

## Özellikler
- 🎵 Ses Editörü — 13 adımlık AI pipeline ile ses temizleme
- 🎬 Video Editörü — Video yükle, sesi temizle, sessiz bölgeleri kes
- 📝 Whisper Transkript — 99 dil desteği
- 🤖 Claude AI Analiz — Sahne tespiti, içerik analizi
- ✂️ Otomatik Kesim — VAD + Diarize ile sessizlik tespiti

## Sistem Gereksinimleri
- Windows 10/11 64-bit
- Python 3.12+
- 16GB+ RAM (önerilen: 32GB+)
- NVIDIA GPU (önerilen, CUDA 12+)
- 10GB+ disk alanı
"""
    readme_path = os.path.join(DIST, 'README.md')
    with open(readme_path, 'w', encoding='utf-8') as f:
        f.write(readme)

    print('[6/6] README oluşturuldu')

def main():
    print('=' * 50)
    print('  VoiceCraft AI — Portable Build')
    print('=' * 50)
    print()

    clean()
    copy_app_files()
    copy_ffmpeg()
    create_bat_launchers()
    create_requirements()
    create_readme()

    print()
    print(f'[OK] Portable paket hazir: {DIST}')
    print()

    # Boyut hesapla
    total = 0
    for dirpath, dirnames, filenames in os.walk(DIST):
        for f in filenames:
            total += os.path.getsize(os.path.join(dirpath, f))
    print(f'   Toplam boyut: {total/1024/1024:.1f} MB')
    print()
    print('   Dağıtım için bu klasörü zip\'leyin:')
    print(f'   {DIST}')
    print()
    print('   NOT: Kullanıcının Python 3.12+ ve pip paketleri')
    print('   kurulu olması gerekir (README.md\'ye bakın)')

if __name__ == '__main__':
    main()
