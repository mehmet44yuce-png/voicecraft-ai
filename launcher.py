"""
VoiceCraft AI — Launcher
Sunucuyu baslatir, tarayici acar, sistem tepsisinde calisir.
Guncelleme sonrasi exit 42 -> otomatik yeniden baslatma.
"""
import os
import sys
import time
import subprocess
import webbrowser
import signal
import json

# Her zaman bu dosyanin bulundugu dizin (proje koku)
APP_DIR = os.path.dirname(os.path.abspath(__file__))
SERVER_PY = os.path.join(APP_DIR, 'server.py')
PORT = 3000
URL = f'http://localhost:{PORT}'
RESTART_CODE = 42

# .env yukle
env_file = os.path.join(APP_DIR, '.env')
if os.path.exists(env_file):
    with open(env_file, 'r') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, val = line.split('=', 1)
                os.environ[key.strip()] = val.strip()

os.environ['PORT'] = str(PORT)
server_process = None


def create_desktop_shortcut():
    """Masaustu kisayolu yoksa olustur."""
    try:
        desktop = os.path.join(os.path.expanduser('~'), 'Desktop')
        shortcut_path = os.path.join(desktop, 'VoiceCraft AI.lnk')
        if os.path.exists(shortcut_path):
            return
        bat_path = os.path.join(APP_DIR, 'VoiceCraft-AI.bat')
        if not os.path.exists(bat_path):
            return
        icon_path = os.path.join(APP_DIR, 'voicecraft.ico')
        # Ikon yoksa PIL ile olustur
        if not os.path.exists(icon_path):
            try:
                from PIL import Image, ImageDraw, ImageFont
                sizes = [256, 64, 48, 32, 16]
                imgs = []
                for sz in sizes:
                    img = Image.new('RGBA', (sz, sz), (0, 0, 0, 0))
                    draw = ImageDraw.Draw(img)
                    m = max(2, sz // 16)
                    draw.ellipse([m, m, sz - m, sz - m], fill=(59, 130, 246, 255))
                    text = 'VC'
                    try:
                        font = ImageFont.truetype('arial.ttf', sz // 3)
                    except Exception:
                        font = ImageFont.load_default()
                    bbox = draw.textbbox((0, 0), text, font=font)
                    tw = bbox[2] - bbox[0]
                    th = bbox[3] - bbox[1]
                    draw.text(((sz - tw) // 2 - bbox[0], (sz - th) // 2 - bbox[1]), text, font=font, fill='white')
                    imgs.append(img)
                imgs[0].save(icon_path, format='ICO', sizes=[(s, s) for s in sizes], append_images=imgs[1:])
            except Exception:
                icon_path = ''
        ps = (
            '$ws = New-Object -ComObject WScript.Shell; '
            f'$s = $ws.CreateShortcut("{shortcut_path}"); '
            f'$s.TargetPath = "{bat_path}"; '
            f'$s.WorkingDirectory = "{APP_DIR}"; '
            f'$s.Description = "VoiceCraft AI"; '
            + (f'$s.IconLocation = "{icon_path},0"; ' if icon_path else '')
            + '$s.Save()'
        )
        result = subprocess.run(
            ['powershell', '-NoProfile', '-Command', ps],
            capture_output=True, text=True
        )
        if os.path.exists(shortcut_path):
            print('  [OK] Masaustu kisayolu olusturuldu: VoiceCraft AI.lnk')
        else:
            print(f'  [!] Kisayol olusturulamadi: {result.stderr.strip()}')
    except Exception as e:
        print(f'  [!] Kisayol hatasi: {e}')


def check_for_updates():
    try:
        sys.path.insert(0, APP_DIR)
        from updater import Updater
        u = Updater(APP_DIR)
        info = u.check_for_updates()
        if info:
            print(f'  [!] Guncelleme: v{info["current_version"]} -> v{info["new_version"]}')
            pending = {k: v for k, v in info.items() if k != 'manifest'}
            with open(os.path.join(APP_DIR, '_update_pending.json'), 'w') as f:
                json.dump(pending, f, ensure_ascii=True)
        else:
            print('  [OK] Guncel')
    except Exception as e:
        print(f'  [!] Guncelleme kontrolu basarisiz: {e}')


def start_server():
    global server_process
    python_exe = sys.executable
    log_path = os.path.join(APP_DIR, 'server_output.log')
    log_file = open(log_path, 'a', encoding='utf-8', errors='replace')
    server_process = subprocess.Popen(
        [python_exe, SERVER_PY],
        cwd=APP_DIR,
        stdout=log_file,
        stderr=log_file,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0
    )
    return server_process


def wait_for_server(timeout=60):
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
    """Varsayilan tarayiciyi ac. Windows'ta msedge veya sistem default."""
    opened = False
    if sys.platform == 'win32':
        # Once varsayilan tarayici ile dene
        try:
            import subprocess as _sp
            _sp.Popen(['cmd', '/c', 'start', '', URL],
                      creationflags=subprocess.CREATE_NO_WINDOW)
            opened = True
        except Exception:
            pass
    if not opened:
        webbrowser.open(URL)


def stop_server():
    global server_process
    if server_process:
        server_process.terminate()
        try:
            server_process.wait(timeout=5)
        except:
            server_process.kill()
        server_process = None


def is_server_running():
    """Sunucu zaten calisiyor mu kontrol et."""
    import urllib.request
    try:
        urllib.request.urlopen(f'{URL}/api/system-stats', timeout=2)
        return True
    except:
        return False


def run_with_restart():
    global server_process
    # Sunucu zaten calısıyorsa sadece tarayıcı ac
    if is_server_running():
        print(f'[OK] Sunucu zaten calisiyor: {URL}')
        open_browser()
        return
    first_run = True
    while True:
        print('[*] Sunucu baslatiliyor...')
        proc = start_server()
        if first_run:
            if wait_for_server():
                print(f'[OK] Hazir: {URL}')
                open_browser()
            else:
                print('[!] Sunucu baslatilamadi!')
                break
            first_run = False
        exit_code = proc.wait()
        if exit_code == RESTART_CODE:
            print('[*] Guncelleme sonrasi yeniden baslatiliyor...')
            time.sleep(2)
            continue
        else:
            print(f'[*] Sunucu kapandi (kod: {exit_code})')
            break


def run_with_tray():
    try:
        import pystray
        from PIL import Image, ImageDraw

        def create_icon():
            img = Image.new('RGB', (64, 64), '#1e293b')
            draw = ImageDraw.Draw(img)
            draw.ellipse([8, 8, 56, 56], fill='#3b82f6')
            draw.text((20, 18), 'VC', fill='white')
            return img

        def on_open(icon, item):
            open_browser()

        def on_quit(icon, item):
            stop_server()
            icon.stop()

        menu = pystray.Menu(
            pystray.MenuItem('VoiceCraft AI Ac', on_open, default=True),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem('Kapat', on_quit)
        )
        icon = pystray.Icon('VoiceCraft AI', create_icon(), 'VoiceCraft AI', menu)

        def setup(icon):
            icon.visible = True
            create_desktop_shortcut()
            print('[*] Guncelleme kontrol ediliyor...')
            check_for_updates()
            run_with_restart()
            icon.stop()

        icon.run(setup)
    except ImportError:
        run_simple()


def run_simple():
    print('=' * 45)
    print('  VoiceCraft AI')
    print('=' * 45)
    create_desktop_shortcut()
    check_for_updates()
    run_with_restart()


if __name__ == '__main__':
    signal.signal(signal.SIGINT, lambda s, f: stop_server())
    run_with_tray()
