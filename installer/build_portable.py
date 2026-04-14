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

    # .env.example
    env_ex = os.path.join(ROOT, '.env.example')
    if os.path.exists(env_ex):
        shutil.copy2(env_ex, DIST)

    # public/
    shutil.copytree(os.path.join(ROOT, 'public'), os.path.join(DIST, 'public'))

    # launcher
    shutil.copy2(os.path.join(ROOT, 'installer', 'launcher.py'), DIST)

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

def create_bat_launcher():
    """Windows BAT başlatıcı oluştur."""
    bat_content = '''@echo off
title VoiceCraft AI
echo.
echo   ╔══════════════════════════════════════╗
echo   ║       VoiceCraft AI — Portable       ║
echo   ║   Ses ve Video Editoru               ║
echo   ╚══════════════════════════════════════╝
echo.

REM FFmpeg PATH'e ekle
set PATH=%~dp0bin;%PATH%

REM Python kontrol
python --version >nul 2>&1
if errorlevel 1 (
    echo [HATA] Python bulunamadi!
    echo Python 3.12+ yukleyin: https://python.org
    pause
    exit /b 1
)

echo [*] Sunucu baslatiliyor...
echo.
python "%~dp0launcher.py"
pause
'''
    bat_path = os.path.join(DIST, 'VoiceCraft-AI.bat')
    with open(bat_path, 'w', encoding='utf-8') as f:
        f.write(bat_content)

    print('[4/6] BAT başlatıcı oluşturuldu')

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
flask>=3.0
flask-cors>=4.0
anthropic>=0.39
torch>=2.0
torchaudio>=2.0
faster-whisper>=1.0
demucs>=4.0
noisereduce>=3.0
soundfile>=0.12
librosa>=0.10
scipy>=1.10
numpy>=1.24
pyannote.audio>=3.0
pydub>=0.25
DeepFilterNet>=0.5
pystray>=0.19
Pillow>=10.0
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

### 2. GPU Desteği (önerilen)
NVIDIA GPU varsa CUDA destekli PyTorch kurun:
```
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
```

### 3. Paketleri yükleyin
```
pip install -r requirements-minimal.txt
```

### 4. HuggingFace Token (Diarize için)
`.env` dosyasına HF token ekleyin:
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
    create_bat_launcher()
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
