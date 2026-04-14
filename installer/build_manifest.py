"""
VoiceCraft AI — Manifest Olusturucu
Her release'de calistirilir. manifest.json + version.json uretir.

Kullanim:
  python build_manifest.py 1.1.0 "Video pipeline iyilestirmeleri"
  python build_manifest.py 1.2.0 "DeepFilter entegrasyonu" --base-url https://github.com/user/repo/releases/download/v1.2.0
"""
import sys
import os
import json
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from updater import Updater, generate_manifest

def main():
    if len(sys.argv) < 2:
        print('Kullanim: python build_manifest.py <versiyon> [changelog] [--base-url URL]')
        print('Ornek:    python build_manifest.py 1.1.0 "Bug fix ve iyilestirmeler"')
        sys.exit(1)

    version = sys.argv[1]
    changelog = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith('--') else ''

    base_url = 'https://github.com/mehmet44yuce-png/voicecraft-ai/releases/download/v' + version
    for i, arg in enumerate(sys.argv):
        if arg == '--base-url' and i + 1 < len(sys.argv):
            base_url = sys.argv[i + 1]

    app_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    print(f'Manifest olusturuluyor...')
    print(f'  Versiyon: {version}')
    print(f'  Changelog: {changelog}')
    print(f'  Base URL: {base_url}')
    print(f'  App dir: {app_dir}')
    print()

    manifest = generate_manifest(app_dir, version, base_url, changelog)

    # manifest.json kaydet
    manifest_path = os.path.join(app_dir, 'manifest.json')
    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=2, ensure_ascii=True)

    # version.json guncelle
    u = Updater(app_dir)
    version_data = {
        'version': version,
        'installed_date': time.strftime('%Y-%m-%d %H:%M:%S'),
        'files': {fp: info['sha256'] for fp, info in manifest['files'].items()}
    }
    u.save_local_version(version_data)

    file_count = len(manifest['files'])
    total_size = sum(info['size'] for info in manifest['files'].values())

    print(f'[OK] manifest.json olusturuldu: {file_count} dosya, {total_size/1024/1024:.1f} MB')
    print(f'[OK] version.json guncellendi: v{version}')
    print()
    print(f'GitHub Release icin yuklenecek dosyalar:')

    # Degisen dosyalari listele (onceki versiyonla karsilastir)
    for fp in sorted(manifest['files'].keys()):
        size = manifest['files'][fp]['size']
        if size > 1024:
            print(f'  {fp} ({size/1024:.0f} KB)')

if __name__ == '__main__':
    main()
