"""
VoiceCraft AI — Uyumluluk Yamalari
Yeni kurulumda bir kez calistir: python setup_compat.py

Yaptiklarimiz:
- DeepFilterNet: torchaudio 2.11 ile AudioMetaData + ta.info uyumsuzlugu
- Resemble Enhance: deepspeed olmadan calisma (Windows'ta derlenemiyor)
- Resemble Enhance: PosixPath hatasi (Linux'ta kaydedilmis model)
- Resemble Enhance: model indir (git lfs)
- numpy surumu: deepfilternet vs pyannote catismasi
"""

import sys
import os
import subprocess
from pathlib import Path

VENV = Path(__file__).parent / ".venv" / "Lib" / "site-packages"


def log(msg):
    print(f"[setup_compat] {msg}")


# ── 1. numpy surumu ──────────────────────────────────────────────────────────

def fix_numpy():
    log("numpy surumu kontrol ediliyor...")
    try:
        import numpy as np
        ver = tuple(int(x) for x in np.__version__.split(".")[:2])
        if ver < (2, 0):
            log(f"numpy {np.__version__} < 2.0, guncelleniyor...")
            subprocess.run(
                [sys.executable, "-m", "pip", "install", "numpy>=2.0", "--force-reinstall", "-q"],
                check=True
            )
            log("numpy guncellendi.")
        else:
            log(f"numpy {np.__version__} OK")
    except Exception as e:
        log(f"numpy guncelleme hatasi: {e}")


# ── 2. DeepFilterNet — df/io.py ───────────────────────────────────────────────

DF_IO = VENV / "df" / "io.py"

DF_IO_OLD = "from torchaudio.backend.common import AudioMetaData"
DF_IO_NEW = """\
try:
    from torchaudio.backend.common import AudioMetaData
except ImportError:
    try:
        from torchaudio import AudioMetaData
    except ImportError:
        from dataclasses import dataclass
        @dataclass
        class AudioMetaData:
            sample_rate: int = 0
            num_frames: int = 0
            num_channels: int = 0
            bits_per_sample: int = 0
            encoding: str = ""\
"""

DF_IO_ANCHOR = "from df.logger import warn_once"
DF_IO_INJECT = """\
if not hasattr(ta, 'info'):
    import soundfile as _sf
    def _ta_info(file, **kwargs):
        info = _sf.info(file)
        return AudioMetaData(sample_rate=info.samplerate, num_frames=info.frames,
                             num_channels=info.channels, bits_per_sample=16, encoding='PCM_S')
    ta.info = _ta_info

"""


def fix_deepfilter():
    if not DF_IO.exists():
        log("df/io.py bulunamadi, deepfilternet kurulu degil — atlaniyor.")
        return
    txt = DF_IO.read_text(encoding="utf-8")
    changed = False

    if "from torchaudio.backend.common import AudioMetaData" in txt and "except ImportError" not in txt:
        txt = txt.replace(DF_IO_OLD, DF_IO_NEW)
        changed = True
        log("df/io.py: AudioMetaData stub eklendi.")

    if "if not hasattr(ta, 'info')" not in txt:
        txt = txt.replace(DF_IO_ANCHOR, DF_IO_INJECT + DF_IO_ANCHOR)
        changed = True
        log("df/io.py: ta.info monkey-patch eklendi.")

    if changed:
        DF_IO.write_text(txt, encoding="utf-8")
    else:
        log("df/io.py: zaten yamali.")


# ── 3. Resemble Enhance — deepspeed opsiyonel ────────────────────────────────

RE_BASE = VENV / "resemble_enhance"

PATCHES = [
    (
        RE_BASE / "utils" / "distributed.py",
        "import deepspeed\nimport torch\nfrom deepspeed.accelerator import get_accelerator",
        "try:\n    import deepspeed\n    from deepspeed.accelerator import get_accelerator\n    _has_deepspeed = True\nexcept ImportError:\n    _has_deepspeed = False\nimport torch",
    ),
    (
        RE_BASE / "utils" / "distributed.py",
        "deepspeed.init_distributed(get_accelerator().communication_backend_name())",
        "if _has_deepspeed:\n        deepspeed.init_distributed(get_accelerator().communication_backend_name())",
    ),
    (
        RE_BASE / "utils" / "engine.py",
        "import deepspeed\nimport pandas as pd\nfrom deepspeed.accelerator import get_accelerator\nfrom deepspeed.runtime.engine import DeepSpeedEngine\nfrom deepspeed.runtime.utils import clip_grad_norm_",
        "try:\n    import deepspeed\n    from deepspeed.accelerator import get_accelerator\n    from deepspeed.runtime.engine import DeepSpeedEngine\n    from deepspeed.runtime.utils import clip_grad_norm_\n    _has_deepspeed = True\nexcept ImportError:\n    _has_deepspeed = False\n    DeepSpeedEngine = object\n    def clip_grad_norm_(*a, **k): pass\nimport pandas as pd",
    ),
    (
        RE_BASE / "enhancer" / "train.py",
        "from deepspeed import DeepSpeedConfig\n",
        "try:\n    from deepspeed import DeepSpeedConfig\nexcept ImportError:\n    DeepSpeedConfig = None\n",
    ),
    (
        RE_BASE / "denoiser" / "train.py",
        "from deepspeed import DeepSpeedConfig\n",
        "try:\n    from deepspeed import DeepSpeedConfig\nexcept ImportError:\n    DeepSpeedConfig = None\n",
    ),
]


def fix_resemble_deepspeed():
    if not RE_BASE.exists():
        log("resemble_enhance bulunamadi — atlaniyor.")
        return
    for fpath, old, new in PATCHES:
        if not fpath.exists():
            continue
        txt = fpath.read_text(encoding="utf-8")
        if new in txt:
            log(f"resemble_enhance/{fpath.name}: zaten yamali.")
        elif old in txt:
            txt = txt.replace(old, new)
            fpath.write_text(txt, encoding="utf-8")
            log(f"resemble_enhance/{fpath.name}: deepspeed yamasi uygulanadi.")
        else:
            log(f"resemble_enhance/{fpath.name}: hedef satir bulunamadi, atlaniyor.")


# ── 4. Resemble Enhance — inference.py device zorla ──────────────────────────

RE_INFER = RE_BASE / "inference.py"
RE_INFER_OLD = "def inference(model, dwav, sr, device, chunk_seconds: float = 30.0, overlap_seconds: float = 1.0):\n    remove_weight_norm_recursively(model)\n\n    hp: HParams = model.hp"
RE_INFER_NEW = "def inference(model, dwav, sr, device, chunk_seconds: float = 30.0, overlap_seconds: float = 1.0):\n    remove_weight_norm_recursively(model)\n    model.to(device)  # ensure model is on correct device\n    dwav = dwav.to(device)  # ensure input is on correct device\n\n    hp: HParams = model.hp"


def fix_resemble_inference():
    if not RE_INFER.exists():
        log("resemble_enhance/inference.py bulunamadi — atlaniyor.")
        return
    txt = RE_INFER.read_text(encoding="utf-8")
    if "model.to(device)  # ensure model is on correct device" not in txt:
        txt = txt.replace(RE_INFER_OLD, RE_INFER_NEW)
        RE_INFER.write_text(txt, encoding="utf-8")
        log("resemble_enhance/inference.py: device force yamasi uygulanadi.")
    else:
        log("resemble_enhance/inference.py: zaten yamali.")


# ── 5. Resemble Enhance — hparams.yaml PosixPath ─────────────────────────────

HPARAMS = RE_BASE / "model_repo" / "enhancer_stage2" / "hparams.yaml"
HPARAMS_OLD = """fg_dir: !!python/object/apply:pathlib.PosixPath
- data
- fg
bg_dir: !!python/object/apply:pathlib.PosixPath
- data
- bg
rir_dir: !!python/object/apply:pathlib.PosixPath
- data
- rir"""
HPARAMS_NEW = "fg_dir: data/fg\nbg_dir: data/bg\nrir_dir: data/rir"


def fix_hparams():
    if not HPARAMS.exists():
        log("hparams.yaml bulunamadi — model henuz indirilmemis olabilir.")
        return
    txt = HPARAMS.read_text(encoding="utf-8")
    if "PosixPath" in txt:
        txt = txt.replace(HPARAMS_OLD, HPARAMS_NEW)
        HPARAMS.write_text(txt, encoding="utf-8")
        log("hparams.yaml: PosixPath duzeltildi.")
    else:
        log("hparams.yaml: zaten duzeltilmis.")


# ── 6. Resemble Enhance — model indir ────────────────────────────────────────

MODEL_DIR = RE_BASE / "model_repo"
MODEL_PT  = MODEL_DIR / "enhancer_stage2" / "ds" / "G" / "default" / "mp_rank_00_model_states.pt"


def download_resemble_model():
    if MODEL_PT.exists():
        log(f"Resemble modeli mevcut: {MODEL_PT}")
        return

    log("Resemble modeli bulunamadi, indiriliyor...")

    # git lfs kurulu mu?
    try:
        subprocess.run(["git", "lfs", "version"], capture_output=True, check=True)
    except Exception:
        log("Git LFS bulunamadi! Kuruluyor...")
        subprocess.run(["winget", "install", "GitHub.GitLFS", "--silent"], capture_output=True)
        subprocess.run(["git", "lfs", "install"], capture_output=True)

    repo_url = "https://huggingface.co/ResembleAI/resemble-enhance"

    if not (MODEL_DIR / ".git").exists():
        log("Git clone basliyor (~800MB)...")
        r = subprocess.run(
            ["git", "clone", repo_url, str(MODEL_DIR), "--no-local"],
            capture_output=False
        )
        if r.returncode != 0:
            log("HATA: git clone basarisiz! Internet baglantisini kontrol et.")
            return
    else:
        log("Repo mevcut, pull yapiliyor...")
        subprocess.run(["git", "-C", str(MODEL_DIR), "pull"], capture_output=True)

    log("LFS dosyalari cekiliyor...")
    subprocess.run(["git", "-C", str(MODEL_DIR), "lfs", "pull"])

    if MODEL_PT.exists():
        log("Resemble modeli basariyla indirildi.")
        fix_hparams()
    else:
        log("HATA: Model dosyasi hala eksik! Manuel indirme gerekebilir.")


# ── 7. __pycache__ temizle ────────────────────────────────────────────────────

def clear_pycache():
    import shutil
    for p in VENV.rglob("__pycache__"):
        if "resemble_enhance" in str(p) or "df" in str(p.parent.name):
            shutil.rmtree(p, ignore_errors=True)
    log("Ilgili __pycache__ temizlendi.")


# ── Ana akis ─────────────────────────────────────────────────────────────────

def main():
    log("=" * 50)
    log("VoiceCraft AI — Uyumluluk Yamalari Basliyor")
    log("=" * 50)

    fix_numpy()
    fix_deepfilter()
    fix_resemble_deepspeed()
    fix_resemble_inference()
    download_resemble_model()
    fix_hparams()
    clear_pycache()

    log("=" * 50)
    log("Tum yamalar tamamlandi. Sunucu baslatilabilir:")
    log("  .venv\\Scripts\\python.exe server.py")
    log("=" * 50)


if __name__ == "__main__":
    main()
