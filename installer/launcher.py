"""
Synergy Kendiyas Fabric — Portable Launcher
Cift tiklayinca Flask sunucusu baslar ve tarayici acilir.
Guncelleme kontrolu ve otomatik yeniden baslatma destegi.
"""
import os
import sys
import time
import subprocess
import threading
import webbrowser
import signal
import json

# Uygulama dizini
APP_DIR = os.path.dirname(os.path.abspath(__file__))
SERVER_PY = os.path.join(APP_DIR, 'server.py')
PORT = 3000
URL = f'http://localhost:{PORT}'
RESTART_CODE = 42  # Ozel cikis kodu = yeniden baslat

# Ortam degiskenleri
os.environ['PORT'] = str(PORT)
env_file = os.path.join(APP_DIR, '.env')
if os.path.exists(env_file):
    with open(env_file, 'r') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, val = line.split('=', 1)
                os.environ[key.strip()] = val.strip()

server_process = None

def check_for_updates():
    """Baslatmadan once guncelleme kontrol et."""
    try:
        sys.path.insert(0, APP_DIR)
        from updater import Updater
        u = Updater(APP_DIR)
        info = u.check_for_updates()
        if info:
            print(f'  [!] Guncelleme mevcut: v{info["current_version"]} -> v{info["new_version"]}')
            print(f'      {info.get("changelog", "")}')
            print(f'      {info["files_to_update"]} dosya degismis ({info["total_size"]/1024:.0f} KB)')
            # Bekleyen guncelleme bilgisini kaydet
            pending = {k: v for k, v in info.items() if k != 'manifest'}
            with open(os.path.join(APP_DIR, '_update_pending.json'), 'w') as f:
                json.dump(pending, f, ensure_ascii=True)
            print('      Tarayicide guncelleme bildirimi gosterilecek.')
        else:
            print('  [OK] Guncel versiyon')
    except Exception as e:
        print(f'  [!] Guncelleme kontrolu basarisiz: {e}')
        # Hata durumunda devam et, baslatmayi engelleme

def start_server():
    """Flask sunucusunu baslat."""
    global server_process
    python_exe = sys.executable
    server_process = subprocess.Popen(
        [python_exe, SERVER_PY],
        cwd=APP_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0
    )
    return server_process

def wait_for_server(timeout=60):
    """Sunucunun hazir olmasini bekle."""
    import urllib.request
    start = time.time()
    while time.time() - start < timeout:
        try:
            urllib.request.urlopen(f'{URL}/api/system-stats', timeout=2)
            return True
        except:
            time.sleep(1)
    return False

def open_browser():
    """Tarayiciyi ac."""
    webbrowser.open(URL)

def stop_server():
    """Sunucuyu durdur."""
    global server_process
    if server_process:
        server_process.terminate()
        try:
            server_process.wait(timeout=5)
        except:
            server_process.kill()
        server_process = None

def run_with_restart():
    """Sunucuyu restart loop ile calistir."""
    global server_process
    first_run = True

    while True:
        print('[*] Sunucu baslatiliyor...')
        proc = start_server()

        if first_run:
            if wait_for_server():
                print(f'[OK] Sunucu hazir: {URL}')
                open_browser()
            else:
                print('[!] Sunucu baslatilamadi!')
                break
            first_run = False

        # Sunucu kapanana kadar bekle
        exit_code = proc.wait()

        if exit_code == RESTART_CODE:
            print('[*] Guncelleme sonrasi yeniden baslatiliyor...')
            time.sleep(2)
            continue
        else:
            print(f'[*] Sunucu kapandi (kod: {exit_code})')
            break

def run_simple():
    """Basit mod — konsol penceresi ile calistir."""
    print('=' * 50)
    print('  Synergy Kendiyas Fabric')
    print('  AI Ses ve Video Editoru')
    print('=' * 50)
    print()

    # Guncelleme kontrol
    print('[*] Guncelleme kontrol ediliyor...')
    check_for_updates()
    print()

    # Restart loop ile calistir
    run_with_restart()

def run_with_tray():
    """Sistem tepsisi ikonu ile calistir (pystray varsa)."""
    try:
        import pystray
        from PIL import Image, ImageDraw

        def create_icon():
            img = Image.new('RGB', (64, 64), '#1e293b')
            draw = ImageDraw.Draw(img)
            draw.ellipse([12, 12, 52, 52], fill='#3b82f6')
            draw.text((22, 18), 'S', fill='white')
            return img

        def on_open(icon, item):
            open_browser()

        def on_quit(icon, item):
            stop_server()
            icon.stop()

        menu = pystray.Menu(
            pystray.MenuItem('Synergy Fabric Ac', on_open, default=True),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem('Sunucuyu Durdur ve Cik', on_quit)
        )

        icon = pystray.Icon('Synergy Fabric', create_icon(), 'Synergy Kendiyas Fabric', menu)

        def setup(icon):
            icon.visible = True
            print('[*] Guncelleme kontrol ediliyor...')
            check_for_updates()
            run_with_restart()
            icon.stop()

        icon.run(setup)

    except ImportError:
        run_simple()

if __name__ == '__main__':
    signal.signal(signal.SIGINT, lambda s, f: stop_server())
    run_with_tray()
