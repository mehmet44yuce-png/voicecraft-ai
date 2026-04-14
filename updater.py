"""
VoiceCraft AI — Uzaktan Guncelleme Motoru
GitHub Releases uzerinden diferansiyel guncelleme.
"""
import os
import sys
import json
import hashlib
import shutil
import time
import logging
from pathlib import Path

log = logging.getLogger('updater')

# ── Yapilandirma ─────────────────────────────────────────────────────────────
UPDATE_URL = "https://raw.githubusercontent.com/mehmet44yuce-png/voicecraft-ai/main/manifest.json"
CHECK_TIMEOUT = 5
DOWNLOAD_TIMEOUT = 60
MAX_BACKUPS = 3
STAGING_DIR = "_staging"
BACKUP_DIR = "_backups"
VERSION_FILE = "version.json"

# Guncellenmeyecek dosyalar
EXCLUDE = {'.env', '.installed', 'uploads', '_backups', '_staging', 'node_modules', '__pycache__'}

class Updater:
    def __init__(self, app_dir, update_url=None):
        self.app_dir = Path(app_dir)
        self.update_url = update_url or UPDATE_URL
        self.version_file = self.app_dir / VERSION_FILE
        self.staging_dir = self.app_dir / STAGING_DIR
        self.backup_dir = self.app_dir / BACKUP_DIR

    # ── Versiyon bilgisi ─────────────────────────────────────────────────────
    def get_local_version(self):
        """Yerel versiyon bilgisini oku."""
        try:
            with open(self.version_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except:
            return {'version': '0.0.0', 'files': {}}

    def save_local_version(self, data):
        """Yerel versiyon bilgisini kaydet."""
        with open(self.version_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=True)

    # ── Hash hesaplama ───────────────────────────────────────────────────────
    @staticmethod
    def sha256(filepath):
        """Dosyanin SHA-256 hash'ini hesapla."""
        h = hashlib.sha256()
        with open(filepath, 'rb') as f:
            for chunk in iter(lambda: f.read(8192), b''):
                h.update(chunk)
        return h.hexdigest()

    def compute_local_hashes(self):
        """Tum guncellenebilir dosyalarin hash'lerini hesapla."""
        hashes = {}
        for root, dirs, files in os.walk(self.app_dir):
            # Haric tutulan klasorleri atla
            dirs[:] = [d for d in dirs if d not in EXCLUDE and not d.startswith('_')]
            rel_root = os.path.relpath(root, self.app_dir)
            for f in files:
                if f.startswith('.') and f != '.env.example':
                    continue
                rel_path = os.path.join(rel_root, f) if rel_root != '.' else f
                rel_path = rel_path.replace('\\', '/')
                full_path = os.path.join(root, f)
                try:
                    hashes[rel_path] = self.sha256(full_path)
                except:
                    pass
        return hashes

    # ── Guncelleme kontrol ───────────────────────────────────────────────────
    def check_for_updates(self):
        """Uzak manifest'i kontrol et, guncelleme varsa bilgi don."""
        import urllib.request
        try:
            req = urllib.request.Request(self.update_url, headers={'User-Agent': 'VoiceCraftAI/1.0'})
            with urllib.request.urlopen(req, timeout=CHECK_TIMEOUT) as resp:
                manifest = json.loads(resp.read().decode('utf-8'))

            local = self.get_local_version()
            local_ver = local.get('version', '0.0.0')
            remote_ver = manifest.get('version', '0.0.0')

            if self._ver_compare(remote_ver, local_ver) > 0:
                # Degisen dosyalari bul
                diff = self.compute_diff(manifest)
                return {
                    'current_version': local_ver,
                    'new_version': remote_ver,
                    'changelog': manifest.get('changelog', ''),
                    'release_date': manifest.get('release_date', ''),
                    'files_to_update': len(diff),
                    'total_size': sum(manifest['files'][f].get('size', 0) for f in diff),
                    'diff': diff,
                    'manifest': manifest
                }
            return None  # Guncelleme yok
        except Exception as e:
            log.warning(f'[updater] Guncelleme kontrol hatasi: {e}')
            return None

    def compute_diff(self, manifest):
        """Degisen dosyalari bul (hash karsilastirmasi)."""
        local = self.get_local_version()
        local_hashes = local.get('files', {})
        diff = []
        for filepath, info in manifest.get('files', {}).items():
            remote_hash = info.get('sha256', '')
            local_hash = local_hashes.get(filepath, '')
            if remote_hash != local_hash:
                diff.append(filepath)
        # Silinecek dosyalar
        for f in manifest.get('delete', []):
            if os.path.exists(os.path.join(self.app_dir, f)):
                diff.append(f'DELETE:{f}')
        return diff

    # ── Yedekleme ────────────────────────────────────────────────────────────
    def backup(self, files_to_update):
        """Guncellenecek dosyalari yedekle."""
        backup_id = time.strftime('%Y%m%d_%H%M%S')
        backup_path = self.backup_dir / backup_id
        backup_path.mkdir(parents=True, exist_ok=True)

        for filepath in files_to_update:
            if filepath.startswith('DELETE:'):
                continue
            src = self.app_dir / filepath
            if src.exists():
                dst = backup_path / filepath
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)

        # Mevcut version.json'i da yedekle
        if self.version_file.exists():
            shutil.copy2(self.version_file, backup_path / VERSION_FILE)

        # Eski yedekleri temizle
        self._cleanup_old_backups()

        log.info(f'[updater] Yedek olusturuldu: {backup_id} ({len(files_to_update)} dosya)')
        return backup_id

    def _cleanup_old_backups(self):
        """En eski yedekleri sil (MAX_BACKUPS kadar tut)."""
        if not self.backup_dir.exists():
            return
        backups = sorted([d for d in self.backup_dir.iterdir() if d.is_dir()])
        while len(backups) > MAX_BACKUPS:
            oldest = backups.pop(0)
            shutil.rmtree(oldest, ignore_errors=True)

    # ── Indirme ──────────────────────────────────────────────────────────────
    def download_files(self, diff, manifest, progress_cb=None):
        """Degisen dosyalari indir ve staging'e koy."""
        import urllib.request
        if self.staging_dir.exists():
            shutil.rmtree(self.staging_dir)
        self.staging_dir.mkdir(parents=True)

        files_info = manifest.get('files', {})
        total = len([f for f in diff if not f.startswith('DELETE:')])
        done = 0

        for filepath in diff:
            if filepath.startswith('DELETE:'):
                continue

            info = files_info.get(filepath, {})
            url = info.get('url', '')
            expected_hash = info.get('sha256', '')

            if not url:
                log.warning(f'[updater] URL yok: {filepath}')
                continue

            dst = self.staging_dir / filepath
            dst.parent.mkdir(parents=True, exist_ok=True)

            try:
                req = urllib.request.Request(url, headers={'User-Agent': 'VoiceCraftAI/1.0'})
                with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT) as resp:
                    with open(dst, 'wb') as f:
                        f.write(resp.read())

                # Hash dogrula
                if expected_hash:
                    actual_hash = self.sha256(dst)
                    if actual_hash != expected_hash:
                        raise ValueError(f'Hash uyumsuz: beklenen={expected_hash[:12]}... gercek={actual_hash[:12]}...')

                done += 1
                if progress_cb:
                    progress_cb(done, total, filepath)
                log.info(f'[updater] Indirildi: {filepath}')
            except Exception as e:
                log.error(f'[updater] Indirme hatasi: {filepath} — {e}')
                # Staging temizle
                shutil.rmtree(self.staging_dir, ignore_errors=True)
                raise

        return True

    # ── Guncelleme uygulama ──────────────────────────────────────────────────
    def apply_update(self, manifest, backup_id=None):
        """Staging'deki dosyalari yerine koy."""
        if not self.staging_dir.exists():
            raise RuntimeError('Staging klasoru bulunamadi')

        diff = self.compute_diff(manifest)

        # Staging dosyalarini kopyala
        for filepath in diff:
            if filepath.startswith('DELETE:'):
                # Dosya silme
                target = self.app_dir / filepath.replace('DELETE:', '')
                if target.exists():
                    target.unlink()
                    log.info(f'[updater] Silindi: {filepath}')
                continue

            src = self.staging_dir / filepath
            dst = self.app_dir / filepath
            if src.exists():
                dst.parent.mkdir(parents=True, exist_ok=True)
                # Windows'ta dosya kilitli olabilir — retry
                for attempt in range(3):
                    try:
                        shutil.copy2(src, dst)
                        break
                    except PermissionError:
                        time.sleep(1)
                log.info(f'[updater] Guncellendi: {filepath}')

        # Versiyon bilgisini guncelle
        new_version = {
            'version': manifest.get('version', '0.0.0'),
            'installed_date': time.strftime('%Y-%m-%d %H:%M:%S'),
            'files': {}
        }
        for filepath, info in manifest.get('files', {}).items():
            new_version['files'][filepath] = info.get('sha256', '')
        self.save_local_version(new_version)

        # Staging temizle
        shutil.rmtree(self.staging_dir, ignore_errors=True)
        log.info(f'[updater] Guncelleme tamamlandi: v{manifest.get("version")}')
        return True

    # ── Geri alma ────────────────────────────────────────────────────────────
    def rollback(self, backup_id=None):
        """En son yedekten geri yukle."""
        if not self.backup_dir.exists():
            raise RuntimeError('Yedek bulunamadi')

        if backup_id:
            backup_path = self.backup_dir / backup_id
        else:
            # En son yedegi bul
            backups = sorted([d for d in self.backup_dir.iterdir() if d.is_dir()])
            if not backups:
                raise RuntimeError('Yedek bulunamadi')
            backup_path = backups[-1]

        if not backup_path.exists():
            raise RuntimeError(f'Yedek bulunamadi: {backup_id}')

        # Yedekteki dosyalari geri yukle
        for root, dirs, files in os.walk(backup_path):
            for f in files:
                src = os.path.join(root, f)
                rel = os.path.relpath(src, backup_path)
                dst = os.path.join(self.app_dir, rel)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
                log.info(f'[updater] Geri yuklendi: {rel}')

        log.info(f'[updater] Rollback tamamlandi: {backup_path.name}')
        return True

    def list_backups(self):
        """Mevcut yedekleri listele."""
        if not self.backup_dir.exists():
            return []
        backups = []
        for d in sorted(self.backup_dir.iterdir()):
            if d.is_dir():
                files = list(d.rglob('*'))
                size = sum(f.stat().st_size for f in files if f.is_file())
                backups.append({
                    'id': d.name,
                    'date': d.name[:8],
                    'files': len([f for f in files if f.is_file()]),
                    'size_mb': round(size / 1024 / 1024, 1)
                })
        return backups

    # ── Yardimci ─────────────────────────────────────────────────────────────
    @staticmethod
    def _ver_compare(v1, v2):
        """Versiyon karsilastirma: v1 > v2 ise pozitif don."""
        def parts(v):
            return [int(x) for x in v.split('.')]
        p1, p2 = parts(v1), parts(v2)
        for a, b in zip(p1, p2):
            if a != b:
                return a - b
        return len(p1) - len(p2)


# ── Manifest olusturucu (yayin icin) ─────────────────────────────────────────
def generate_manifest(app_dir, version, base_url, changelog=''):
    """Dagitim icin manifest.json olustur."""
    updater = Updater(app_dir)
    hashes = updater.compute_local_hashes()

    manifest = {
        'version': version,
        'release_date': time.strftime('%Y-%m-%d'),
        'min_version': '1.0.0',
        'changelog': changelog,
        'files': {},
        'delete': []
    }

    for filepath, file_hash in hashes.items():
        full_path = os.path.join(app_dir, filepath)
        size = os.path.getsize(full_path) if os.path.exists(full_path) else 0
        manifest['files'][filepath] = {
            'sha256': file_hash,
            'size': size,
            'url': f'{base_url}/{filepath}'
        }

    return manifest


if __name__ == '__main__':
    # Test: yerel hash'leri hesapla
    app_dir = os.path.dirname(os.path.abspath(__file__))
    u = Updater(app_dir)
    hashes = u.compute_local_hashes()
    print(f'Toplam {len(hashes)} dosya:')
    for f, h in sorted(hashes.items())[:10]:
        print(f'  {h[:12]}... {f}')
    if len(hashes) > 10:
        print(f'  ... ve {len(hashes)-10} dosya daha')
