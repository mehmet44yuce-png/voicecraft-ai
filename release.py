"""
VoiceCraft AI - Otomatik Release Scripti

Kullanim:
  python release.py <versiyon> "<changelog>" [dosya1 dosya2 ...]

Ornekler:
  # Otomatik: git'te degisen dosyalari algila
  python release.py 1.0.5 "Bug fixleri"

  # Manuel: belirli dosyalari release et
  python release.py 1.0.5 "Sadece UI" public/index.html public/admin.html

Gereksinim:
  .env dosyasinda: GITHUB_TOKEN=ghp_xxxxx
  Token izinleri: 'repo' scope (Settings > Developer settings > Personal access tokens)

Yaptiklari:
  1. Degisen dosyalari tespit et
  2. SHA-256 hash hesapla
  3. manifest.json olustur (sadece degisen dosyalar)
  4. Commit + push
  5. GitHub release olustur (REST API)
  6. Dosyalari release'e yukle
"""
import os
import sys
import json
import hashlib
import subprocess
import urllib.request
import urllib.error
import mimetypes
from pathlib import Path

# ── Yapilandirma ─────────────────────────────────────────────────────────────
REPO_OWNER = 'mehmet44yuce-png'
REPO_NAME = 'voicecraft-ai'
BASE_URL = f'https://github.com/{REPO_OWNER}/{REPO_NAME}/releases/download'
API_BASE = 'https://api.github.com'

APP_DIR = Path(__file__).parent.absolute()


def load_env():
    """`.env` dosyasindan GITHUB_TOKEN oku."""
    env_path = APP_DIR / '.env'
    if env_path.exists():
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    os.environ[k.strip()] = v.strip().strip('"').strip("'")
    token = os.environ.get('GITHUB_TOKEN', '')
    if not token:
        sys.exit('HATA: GITHUB_TOKEN bulunamadi. .env dosyasina ekle:\n'
                 '  GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx\n'
                 'Token uretmek: https://github.com/settings/tokens (scope: repo)')
    return token


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            h.update(chunk)
    return h.hexdigest()


def detect_changed_files():
    """Git'te degisen + yeni dosyalari bul (manifest.json haric)."""
    try:
        result = subprocess.run(
            ['git', 'diff', '--name-only', 'HEAD'],
            capture_output=True, text=True, cwd=APP_DIR, check=True
        )
        modified = [l.strip() for l in result.stdout.splitlines() if l.strip()]

        result2 = subprocess.run(
            ['git', 'ls-files', '--others', '--exclude-standard'],
            capture_output=True, text=True, cwd=APP_DIR, check=True
        )
        untracked = [l.strip() for l in result2.stdout.splitlines() if l.strip()]

        files = list(set(modified + untracked))
        files = [f for f in files if f not in ('manifest.json', 'version.json', 'release.py')]
        return files
    except subprocess.CalledProcessError as e:
        sys.exit(f'HATA: git diff calistirmadi: {e}')


def build_manifest(version, changelog, files):
    """Verilen dosya listesi icin manifest olustur."""
    base_url = f'{BASE_URL}/v{version}'
    import time
    manifest = {
        'version': version,
        'release_date': time.strftime('%Y-%m-%d'),
        'min_version': '1.0.0',
        'changelog': changelog,
        'files': {},
        'delete': []
    }
    for fp in files:
        full = APP_DIR / fp
        if not full.exists():
            print(f'  [!] Atlanan (yok): {fp}')
            continue
        # GitHub release asset adlari klasor desteklemez, sadece dosya adi
        asset_name = Path(fp).name
        manifest['files'][fp.replace('\\', '/')] = {
            'sha256': sha256(full),
            'size': full.stat().st_size,
            'url': f'{base_url}/{asset_name}'
        }
    return manifest


def github_request(method, path, token, data=None, headers=None):
    """GitHub REST API isteg."""
    url = f'{API_BASE}{path}'
    h = {
        'Authorization': f'token {token}',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'VoiceCraftAI-Release/1.0',
    }
    if headers:
        h.update(headers)
    body = json.dumps(data).encode('utf-8') if data is not None else None
    if body and 'Content-Type' not in h:
        h['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode('utf-8', errors='replace')
        raise RuntimeError(f'GitHub API {method} {path} -> {e.code}: {err_body}')


def upload_asset(upload_url_template, file_path, token):
    """Release asset yukle (binary)."""
    name = Path(file_path).name
    upload_url = upload_url_template.replace('{?name,label}', f'?name={name}')
    with open(file_path, 'rb') as f:
        data = f.read()
    ctype = mimetypes.guess_type(name)[0] or 'application/octet-stream'
    h = {
        'Authorization': f'token {token}',
        'Content-Type': ctype,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'VoiceCraftAI-Release/1.0',
    }
    req = urllib.request.Request(upload_url, data=data, headers=h, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode('utf-8', errors='replace')
        raise RuntimeError(f'Upload {name} -> {e.code}: {err_body}')


def git(*args):
    """Git komutu calistir."""
    result = subprocess.run(['git'] + list(args), cwd=APP_DIR,
                            capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f'git {" ".join(args)} -> {result.stderr}')
    return result.stdout.strip()


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    version = sys.argv[1].lstrip('v')
    changelog = sys.argv[2]
    explicit_files = sys.argv[3:] if len(sys.argv) > 3 else None

    print(f'═══ VoiceCraft AI Release v{version} ═══')
    print(f'Changelog: {changelog}')
    print()

    token = load_env()

    # 1. Dosyalari belirle
    if explicit_files:
        files = explicit_files
        print(f'Manuel dosya listesi: {len(files)} dosya')
    else:
        files = detect_changed_files()
        print(f'Git\'te degisen: {len(files)} dosya')

    if not files:
        sys.exit('HATA: Release edilecek dosya yok')

    # Asset adi cakismasi kontrol (GitHub release flat namespace)
    names = [Path(f).name for f in files]
    duplicates = {n for n in names if names.count(n) > 1}
    if duplicates:
        sys.exit(f'HATA: Dosya adi cakismasi (release flat namespace): {duplicates}')

    for f in files:
        print(f'  • {f}')
    print()

    # 2. Manifest olustur
    print('[1/6] manifest.json olusturuluyor...')
    manifest = build_manifest(version, changelog, files)
    if not manifest['files']:
        sys.exit('HATA: Hicbir dosya manifest\'e eklenemedi')
    with open(APP_DIR / 'manifest.json', 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=2, ensure_ascii=True)
    print(f'    OK: {len(manifest["files"])} dosya')

    # 3. Commit + push
    print('[2/6] Git commit + push...')
    git('add', 'manifest.json', *files)
    try:
        git('commit', '-m', f'release: v{version} - {changelog}')
    except RuntimeError as e:
        if 'nothing to commit' in str(e):
            print('    UYARI: commit edilecek degisiklik yok')
        else:
            raise
    git('push', 'origin', 'main')
    print('    OK: pushed')

    # 4. Tag varsa kontrol et
    print(f'[3/6] Tag v{version} olusturuluyor...')
    tag = f'v{version}'
    try:
        existing = github_request('GET', f'/repos/{REPO_OWNER}/{REPO_NAME}/releases/tags/{tag}', token)
        sys.exit(f'HATA: v{version} release zaten mevcut. Versiyonu artir.')
    except RuntimeError as e:
        if '404' not in str(e):
            raise

    # 5. Release olustur
    print(f'[4/6] GitHub release v{version} olusturuluyor...')
    release = github_request('POST', f'/repos/{REPO_OWNER}/{REPO_NAME}/releases', token, data={
        'tag_name': tag,
        'name': f'v{version}',
        'body': changelog,
        'draft': False,
        'prerelease': False,
    })
    print(f'    OK: release_id={release["id"]}')

    # 6. Dosyalari yukle
    print(f'[5/6] {len(files)} dosya yukleniyor...')
    upload_url_template = release['upload_url']
    for fp in files:
        full = APP_DIR / fp
        if not full.exists():
            continue
        print(f'    yukleniyor: {fp} ({full.stat().st_size / 1024:.1f} KB)')
        upload_asset(upload_url_template, str(full), token)
    print('    OK: tum dosyalar yuklendi')

    # 7. Dogrulama
    print('[6/6] Hash dogrulama...')
    import time
    time.sleep(3)  # GitHub yuklemenin yansimasi icin
    all_ok = True
    for fp, info in manifest['files'].items():
        url = info['url']
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                data = resp.read()
            actual = hashlib.sha256(data).hexdigest()
            if actual == info['sha256']:
                print(f'    ✓ {fp}')
            else:
                print(f'    ✗ {fp} HASH UYUMSUZ!')
                all_ok = False
        except Exception as e:
            print(f'    ✗ {fp} indirilemedi: {e}')
            all_ok = False

    print()
    if all_ok:
        print(f'🎉 RELEASE BASARILI: v{version}')
        print(f'   https://github.com/{REPO_OWNER}/{REPO_NAME}/releases/tag/v{version}')
    else:
        print(f'⚠ RELEASE OLUSTU AMA HASH SORUNU VAR — manuel kontrol et')


if __name__ == '__main__':
    main()
