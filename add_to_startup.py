"""
VoiceCraft AI — Windows Baslangic Kaydi
Bilgisayar acildiginda VoiceCraft AI otomatik baslar.

Kullanim:
  .venv/Scripts/python.exe add_to_startup.py          # Ekle
  .venv/Scripts/python.exe add_to_startup.py --remove # Kaldir
  .venv/Scripts/python.exe add_to_startup.py --status # Durum
"""
import os
import sys
import subprocess
from pathlib import Path

APP_DIR   = Path(__file__).parent.resolve()
TASK_NAME = "VoiceCraft AI"
PYTHONW   = APP_DIR / ".venv" / "Scripts" / "pythonw.exe"
LAUNCHER  = APP_DIR / "launcher.py"


def task_exists():
    r = subprocess.run(
        ["schtasks", "/Query", "/TN", TASK_NAME],
        capture_output=True
    )
    return r.returncode == 0


def add_startup():
    if not PYTHONW.exists():
        print("[HATA] .venv bulunamadi. Once Setup.bat calistirin.")
        return False
    if not LAUNCHER.exists():
        print("[HATA] launcher.py bulunamadi.")
        return False

    if task_exists():
        print(f"[OK] '{TASK_NAME}' gorevi zaten kayitli.")
        return True

    # Task Scheduler ile giris yapildiginda calistir (konsol penceresi yok)
    cmd = [
        "schtasks", "/Create",
        "/TN", TASK_NAME,
        "/TR", f'"{PYTHONW}" "{LAUNCHER}"',
        "/SC", "ONLOGON",
        "/RL", "HIGHEST",   # Yonetici yetkisi (GPU icin gerekebilir)
        "/F",               # Varsa ustune yaz
        "/DELAY", "0001:00" # 1 dakika sonra basla (masaustu tam yuklenmeden once baslamasin)
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode == 0:
        print(f"[OK] '{TASK_NAME}' Windows baslangiclarina eklendi.")
        print(f"     Bilgisayar acildiginda 1 dakika sonra otomatik baslar.")
        print(f"     Sistem tepsisinde gorulur (sagda alt kosede).")
        return True
    else:
        # Yonetici yetkisi olmayabilir, startup klasorune dene
        print(f"[!] Task Scheduler basarisiz: {r.stderr.strip()}")
        print("    Startup klasorune ekleniyor...")
        return add_to_startup_folder()


def add_to_startup_folder():
    """Task Scheduler calismazsa Startup klasorune VBScript ekle."""
    startup = Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
    vbs_path = startup / "VoiceCraft-AI.vbs"

    vbs_content = f'''Set WshShell = CreateObject("WScript.Shell")
WshShell.Run Chr(34) & "{PYTHONW}" & Chr(34) & " " & Chr(34) & "{LAUNCHER}" & Chr(34), 0, False
'''
    try:
        vbs_path.write_text(vbs_content, encoding="utf-8")
        print(f"[OK] Startup klasorune eklendi: {vbs_path}")
        print(f"     Bilgisayar acildiginda arka planda otomatik baslar.")
        return True
    except Exception as e:
        print(f"[HATA] {e}")
        print()
        print("Manuel adim:")
        print(f"  1. Win+R -> shell:startup -> Enter")
        print(f"  2. Asagidaki VBS dosyasini olusturup o klasore koy:")
        print()
        print(f'Set WshShell = CreateObject("WScript.Shell")')
        print(f'WshShell.Run Chr(34) & "{PYTHONW}" & Chr(34) & " " & Chr(34) & "{LAUNCHER}" & Chr(34), 0, False')
        return False


def remove_startup():
    removed = False
    # Task Scheduler'dan kaldir
    if task_exists():
        r = subprocess.run(
            ["schtasks", "/Delete", "/TN", TASK_NAME, "/F"],
            capture_output=True
        )
        if r.returncode == 0:
            print(f"[OK] Task Scheduler'dan kaldirildi: '{TASK_NAME}'")
            removed = True

    # Startup klasorunden kaldir
    startup = Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
    vbs_path = startup / "VoiceCraft-AI.vbs"
    if vbs_path.exists():
        vbs_path.unlink()
        print(f"[OK] Startup klasoründen kaldirildi.")
        removed = True

    if not removed:
        print("[!] Kayitli baslangiç görevi bulunamadi.")


def show_status():
    ts = task_exists()
    startup = Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
    vbs = (startup / "VoiceCraft-AI.vbs").exists()
    print(f"Task Scheduler : {'[KAYITLI]' if ts else '[YOK]'}")
    print(f"Startup klasoru: {'[KAYITLI]' if vbs else '[YOK]'}")
    if not ts and not vbs:
        print("=> Otomatik baslama aktif degil.")
    else:
        print("=> Bilgisayar acildiginda otomatik baslar.")


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    if arg == "--remove":
        remove_startup()
    elif arg == "--status":
        show_status()
    else:
        add_startup()
