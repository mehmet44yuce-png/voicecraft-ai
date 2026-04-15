"""
VoiceCraft AI -- Kapsamli Paket Kurulumu
Tum bilgisayarlarda stabil calisacak sekilde tasarlanmistir.

Yapar:
  1. GPU tespiti (RTX 40/50 -> cu128, RTX 30/oncesi -> cu121, yoksa CPU)
  2. PyTorch + torchaudio kurulumu
  3. Temel Flask/yardimci paketler
  4. AI paketleri (Demucs, Whisper, Pyannote, DeepFilterNet, Resemble, VoiceFixer)
  5. numpy surum duzeltmesi (deepfilternet vs pyannote catismasi)
  6. DeepFilterNet / torchaudio 2.11 uyumluluk yamasi
  7. Resemble Enhance deepspeed + PosixPath yamalari
  8. .env dosyasi kontrolu

Kullanim (venv icinden):
  .venv/Scripts/python.exe installer/setup_packages.py
"""

import subprocess
import sys
import os
import re
import shutil

# Proje kok dizini (installer/ ust klasoru)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENV_PY = sys.executable

STEP_OK   = "  [OK]"
STEP_WARN = "  [!] "
STEP_ERR  = "  [HATA]"
STEP_INFO = "  [*] "

# ─────────────────────────────────────────────
# Yardimci: pip install calistir
# ─────────────────────────────────────────────
def pip_install(*packages, index_url=None, extra_args=None, quiet=False):
    cmd = [VENV_PY, "-m", "pip", "install"] + list(packages)
    if index_url:
        cmd += ["--index-url", index_url]
    if extra_args:
        cmd += extra_args
    if quiet:
        cmd += ["--quiet"]
    result = subprocess.run(cmd)
    return result.returncode == 0


def run_cmd(cmd, capture=False):
    kwargs = {"capture_output": True, "text": True} if capture else {}
    try:
        return subprocess.run(cmd, timeout=15, **kwargs)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None


# ─────────────────────────────────────────────
# ADIM 1 — GPU Tespiti
# ─────────────────────────────────────────────
def detect_gpu():
    """
    NVIDIA GPU varsa modelini tespit et.
    RTX 40xx/50xx (Ada/Blackwell) -> cu128
    RTX 30xx ve oncesi             -> cu121
    GPU yok                        -> cpu
    """
    result = run_cmd(
        ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
        capture=True,
    )
    if result and result.returncode == 0 and result.stdout.strip():
        gpu_name = result.stdout.strip().splitlines()[0].strip()
        print(f"{STEP_OK} GPU tespit edildi: {gpu_name}")

        # RTX 40xx / 50xx serisi -> Ada / Blackwell -> cu128
        if re.search(
            r"(RTX\s*[45]\d{3}|"
            r"RTX\s*40[6-9]0|RTX\s*4050|RTX\s*4060|RTX\s*4070|RTX\s*4080|RTX\s*4090|"
            r"RTX\s*50[6-9]0|RTX\s*5050|RTX\s*5060|RTX\s*5070|RTX\s*5080|RTX\s*5090)",
            gpu_name,
            re.IGNORECASE,
        ):
            print(f"{STEP_INFO}Ada/Blackwell serisi tespit edildi -> cu128 kullanilacak")
            return "cu128", gpu_name

        # Diger NVIDIA (Ampere, Turing, Pascal...) -> cu121
        print(f"{STEP_INFO}Ampere/oncesi tespit edildi -> cu121 kullanilacak")
        return "cu121", gpu_name

    print(f"{STEP_WARN}NVIDIA GPU bulunamadi -> CPU modu")
    return "cpu", None


# ─────────────────────────────────────────────
# ADIM 2 — PyTorch
# ─────────────────────────────────────────────
def install_pytorch(cuda_tag):
    if cuda_tag == "cpu":
        idx = "https://download.pytorch.org/whl/cpu"
        label = "CPU"
    else:
        idx = f"https://download.pytorch.org/whl/{cuda_tag}"
        label = cuda_tag.upper()

    print(f"{STEP_INFO}PyTorch kuruluyor ({label})...")
    ok = pip_install("torch", "torchaudio", index_url=idx, extra_args=["--upgrade"])
    if ok:
        print(f"{STEP_OK} PyTorch kuruldu ({label})")
    else:
        print(f"{STEP_ERR} PyTorch kurulamadi!")
    return ok


# ─────────────────────────────────────────────
# ADIM 3 — Temel paketler
# ─────────────────────────────────────────────
def install_base():
    print(f"{STEP_INFO}Temel paketler kuruluyor...")
    packages = [
        "flask>=3.0", "flask-cors>=4.0",
        "anthropic>=0.39",
        "soundfile>=0.12", "librosa>=0.10", "scipy>=1.10",
        "pyloudnorm>=0.1",
        "pydub>=0.25",
        "python-dotenv>=1.0", "json-repair>=0.1",
        "pystray>=0.19", "Pillow>=10.0",
    ]
    ok = pip_install(*packages, extra_args=["--upgrade"])
    if ok:
        print(f"{STEP_OK} Temel paketler kuruldu")
    else:
        print(f"{STEP_WARN}Bazi temel paketler yuklenemedi — devam ediliyor")
    return ok


# ─────────────────────────────────────────────
# ADIM 4 — AI Paketleri
# ─────────────────────────────────────────────
def install_ai_packages():
    results = {}

    def try_install(label, *pkgs, extra=None):
        print(f"{STEP_INFO}{label} kuruluyor...")
        ok = pip_install(*pkgs, extra_args=(extra or []) + ["--upgrade"])
        if ok:
            print(f"{STEP_OK} {label} kuruldu")
        else:
            print(f"{STEP_WARN}{label} yuklenemedi — atlanıyor")
        results[label] = ok

    try_install("faster-whisper", "faster-whisper")
    try_install("demucs",         "demucs")
    try_install("noisereduce",    "noisereduce")
    try_install("pyannote.audio", "pyannote.audio")
    try_install("DeepFilterNet",  "DeepFilterNet")

    # Resemble Enhance: --no-deps (deepspeed Windows'ta derlenemiyor)
    print(f"{STEP_INFO}resemble-enhance kuruluyor (--no-deps)...")
    ok = pip_install("resemble-enhance", extra_args=["--no-deps"])
    print(f"{STEP_OK} resemble-enhance kuruldu" if ok else f"{STEP_WARN}resemble-enhance yuklenemedi")
    results["resemble-enhance"] = ok

    try_install("voicefixer", "voicefixer")

    # numpy duzelme: deepfilternet 1.x'e dusurebilir, pyannote 2.x+ ister
    print(f"{STEP_INFO}numpy>=2.0 zorlanıyor (surum catismasi duzeltmesi)...")
    ok = pip_install("numpy>=2.0", extra_args=["--force-reinstall", "--quiet"])
    print(f"{STEP_OK} numpy duzeltildi" if ok else f"{STEP_WARN}numpy duzeltmesi basarisiz")

    return results


# ─────────────────────────────────────────────
# ADIM 5 — DeepFilterNet / torchaudio 2.11 Yamasi
# ─────────────────────────────────────────────
DEEPFILTER_PATCH_MARKER = "# VoiceCraft-AI: torchaudio-2.11-compat-patch"
DEEPFILTER_PATCH_MARKER_V2 = "_ta_save_compat"  # v2 marker: ta.save yamasi var mi

DEEPFILTER_PATCH_HEADER = '''\
# VoiceCraft-AI: torchaudio-2.11-compat-patch
# AudioMetaData, ta.info, ta.load, ta.save torchaudio 2.11'de torchcodec'e tasindi
try:
    from torchaudio.backend.common import AudioMetaData  # torchaudio <=2.10
except ImportError:
    try:
        from torchaudio._backend.utils import AudioMetaData  # ara surum
    except ImportError:
        from dataclasses import dataclass

        @dataclass
        class AudioMetaData:  # stub
            sample_rate: int = 0
            num_frames: int = 0
            num_channels: int = 0
            bits_per_sample: int = 0
            encoding: str = ""

try:
    import torchaudio as _ta_mod
    import soundfile as _sf_mod
    import torch as _torch_mod

    if not hasattr(_ta_mod, "info"):
        def _ta_info_compat(path, **kwargs):
            _i = _sf_mod.info(path)
            return AudioMetaData(
                sample_rate=_i.samplerate,
                num_frames=_i.frames,
                num_channels=_i.channels,
                bits_per_sample=16,
                encoding="PCM_S",
            )
        _ta_mod.info = _ta_info_compat

    if not hasattr(_ta_mod, "_original_load"):
        _ta_mod._original_load = _ta_mod.load
        def _ta_load_compat(file, frame_offset=0, num_frames=-1, **kwargs):
            try:
                return _ta_mod._original_load(file, frame_offset=frame_offset, num_frames=num_frames, **kwargs)
            except Exception:
                data, sr = _sf_mod.read(file, dtype="float32", always_2d=True,
                                        start=frame_offset,
                                        stop=None if num_frames < 0 else frame_offset + num_frames)
                return _torch_mod.from_numpy(data.T), sr
        _ta_mod.load = _ta_load_compat

    if not hasattr(_ta_mod, "_original_save"):
        _ta_mod._original_save = _ta_mod.save
        def _ta_save_compat(uri, src, sample_rate, **kwargs):
            try:
                return _ta_mod._original_save(uri, src, sample_rate, **kwargs)
            except Exception:
                arr = src.detach().cpu()
                if arr.dtype == _torch_mod.int16:
                    arr = arr.to(_torch_mod.float32) / (1 << 15)
                else:
                    arr = arr.to(_torch_mod.float32)
                _sf_mod.write(uri, arr.numpy().T, sample_rate)
        _ta_mod.save = _ta_save_compat

except Exception:
    pass
# ── end VoiceCraft-AI patch ──

'''


def _find_site_file(*path_parts):
    """site-packages altinda dosya ara, ilk bulunan yolu doner."""
    try:
        import site
        dirs = site.getsitepackages()
    except AttributeError:
        dirs = [os.path.join(os.path.dirname(VENV_PY), "..", "lib", "site-packages")]
    for sp in dirs:
        candidate = os.path.join(sp, *path_parts)
        if os.path.exists(candidate):
            return candidate
    return None


def patch_deepfilter():
    io_path = _find_site_file("df", "io.py")
    if not io_path:
        print(f"{STEP_WARN}df/io.py bulunamadi — DeepFilterNet yuklu olmayabilir")
        return

    with open(io_path, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()

    if DEEPFILTER_PATCH_MARKER in content and DEEPFILTER_PATCH_MARKER_V2 in content:
        print(f"{STEP_OK} df/io.py zaten yamali (v2)")
        return
    # Eski yamali ama ta.save eksik — yamayı yeniden uygula
    if DEEPFILTER_PATCH_MARKER in content:
        content = content.replace(DEEPFILTER_PATCH_HEADER.split("\n")[0], "")
        # Eski patch bloğunu sil (marker'dan end marker'a kadar)
        import re as _re
        content = _re.sub(
            r"# VoiceCraft-AI: torchaudio-2\.11-compat-patch.*?# ── end VoiceCraft-AI patch ──\s*\n",
            "",
            content,
            flags=_re.DOTALL,
        )

    # Mevcut (artik calismayan) import satirini kaldir
    patched = re.sub(
        r"^from torchaudio\.backend\.common import AudioMetaData\s*\n",
        "",
        content,
        flags=re.MULTILINE,
    )
    patched = DEEPFILTER_PATCH_HEADER + patched

    with open(io_path, "w", encoding="utf-8") as f:
        f.write(patched)
    print(f"{STEP_OK} df/io.py yamandi (torchaudio 2.11 uyumu)")


# ─────────────────────────────────────────────
# ADIM 6 — Resemble Enhance Yamalari
# ─────────────────────────────────────────────
RESEMBLE_DS_MARKER = "# VoiceCraft-AI: deepspeed-optional"


def _patch_deepspeed_imports(fpath):
    """import deepspeed / from deepspeed import X satirlarini try/except ile sar."""
    if not os.path.exists(fpath):
        return False
    with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()
    if RESEMBLE_DS_MARKER in content:
        return False  # Zaten yamali

    # import deepspeed
    patched = re.sub(
        r"^(import deepspeed)$",
        RESEMBLE_DS_MARKER + "\ntry:\n    \\1\nexcept ImportError:\n    deepspeed = None",
        content,
        flags=re.MULTILINE,
    )
    # from deepspeed import X (veya from deepspeed.X import Y)
    patched = re.sub(
        r"^(from deepspeed(?:\.\S+)?\s+import\s+.+)$",
        "try:\n    \\1\nexcept ImportError:\n    pass",
        patched,
        flags=re.MULTILINE,
    )
    if patched == content:
        return False  # Degistirilecek bir sey yoktu

    with open(fpath, "w", encoding="utf-8") as f:
        f.write(patched)
    return True


def _patch_posixpath(hparams_path):
    """hparams.yaml icindeki Linux PosixPath nesnelerini string path'e cevir."""
    if not os.path.exists(hparams_path):
        return False
    with open(hparams_path, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()
    if "PosixPath" not in content:
        return False

    # fg_dir / bg_dir / rir_dir
    patched = re.sub(
        r"(\w+_dir):\s*!!python/object/apply:pathlib\.PosixPath\s*\n(?:\s*- (\S+)\s*\n)+",
        lambda m: _posix_join(m),
        content,
    )
    if patched == content:
        # Basit tek-satirlik format dene
        patched = re.sub(
            r"(\w+_dir):\s*!!python/object/apply:pathlib\.PosixPath\s*\[([^\]]+)\]",
            lambda m: m.group(1) + ": " + "/".join(
                p.strip().strip("'\"") for p in m.group(2).split(",")
            ),
            content,
        )
    if patched == content:
        return False
    with open(hparams_path, "w", encoding="utf-8") as f:
        f.write(patched)
    return True


def _posix_join(match):
    """YAML list formundaki PosixPath parcalarini path string'e donustur."""
    key = match.group(1)
    parts = re.findall(r"^\s*- (\S+)", match.group(0), re.MULTILINE)
    return f"{key}: {'/'.join(parts)}\n"


def patch_resemble_enhance():
    resemble_root = None
    try:
        import site
        for sp in site.getsitepackages():
            candidate = os.path.join(sp, "resemble_enhance")
            if os.path.exists(candidate):
                resemble_root = candidate
                break
    except AttributeError:
        pass

    if not resemble_root:
        print(f"{STEP_WARN}resemble_enhance bulunamadi — yuklu degil olabilir")
        return

    # 1. deepspeed opsiyonel (4 dosya)
    ds_files = [
        os.path.join(resemble_root, "utils", "distributed.py"),
        os.path.join(resemble_root, "utils", "engine.py"),
        os.path.join(resemble_root, "enhancer", "train.py"),
        os.path.join(resemble_root, "denoiser", "train.py"),
    ]
    patched_count = 0
    for fpath in ds_files:
        if _patch_deepspeed_imports(fpath):
            patched_count += 1
            print(f"{STEP_OK} deepspeed patch: {os.path.basename(fpath)}")

    if patched_count == 0:
        print(f"{STEP_OK} resemble_enhance deepspeed yamalari zaten uygulanmis")

    # 2. PosixPath fix
    hparams = os.path.join(resemble_root, "model_repo", "enhancer_stage2", "hparams.yaml")
    if _patch_posixpath(hparams):
        print(f"{STEP_OK} PosixPath fix: hparams.yaml")
    elif not os.path.exists(hparams):
        print(f"{STEP_WARN}model_repo bulunamadi — Resemble model henuz indirilmemis")
        print(f"        Model indirmek icin README.md'ye bakin (git lfs pull)")
    else:
        print(f"{STEP_OK} hparams.yaml PosixPath yok veya zaten duzeltilmis")


# ─────────────────────────────────────────────
# ADIM 7 — .env Dosyasi Kontrolu
# ─────────────────────────────────────────────
def check_env():
    env_path = os.path.join(ROOT, ".env")

    if not os.path.exists(env_path):
        example = os.path.join(ROOT, ".env.example")
        if os.path.exists(example):
            shutil.copy2(example, env_path)
            print(f"{STEP_OK} .env olusturuldu (.env.example kopyalandi)")
        else:
            with open(env_path, "w") as f:
                f.write("HF_TOKEN=\nANTHROPIC_API_KEY=\n")
            print(f"{STEP_OK} .env olusturuldu (bos)")

    with open(env_path, "r") as f:
        content = f.read()

    issues = []
    if "HF_TOKEN=hf_" not in content:
        issues.append(
            "HF_TOKEN eksik -> https://huggingface.co/settings/tokens\n"
            "         .env dosyasina ekleyin: HF_TOKEN=hf_xxxxx\n"
            "         (Diarize/konusmaci tespiti icin gerekli)"
        )
    if "ANTHROPIC_API_KEY=sk-" not in content and "ANTHROPIC_API_KEY=sk_" not in content:
        issues.append(
            "ANTHROPIC_API_KEY eksik -> https://console.anthropic.com\n"
            "         (Claude AI analiz icin gerekli, opsiyonel)"
        )

    if not issues:
        print(f"{STEP_OK} .env yapilandirmasi tam")
    else:
        for issue in issues:
            print(f"{STEP_WARN}{issue}")


# ─────────────────────────────────────────────
# Ana akis
# ─────────────────────────────────────────────
def main():
    print()
    print("=" * 54)
    print("  VoiceCraft AI -- Paket Kurulumu")
    print("=" * 54)

    fatal = False

    # 1. GPU
    print("\n[1/7] GPU tespiti...")
    cuda_tag, gpu_name = detect_gpu()

    # 2. PyTorch
    print(f"\n[2/7] PyTorch ({cuda_tag.upper()})...")
    if not install_pytorch(cuda_tag):
        print(f"{STEP_ERR} PyTorch olmadan devam edilemiyor.")
        fatal = True

    if fatal:
        print("\n[HATA] Kritik hata — kurulum durduruluyor.")
        sys.exit(1)

    # 3. Temel paketler
    print("\n[3/7] Temel paketler...")
    install_base()

    # 4. AI paketleri
    print("\n[4/7] AI paketleri (bu sure alabilir)...")
    install_ai_packages()

    # 5. DeepFilterNet yamasi
    print("\n[5/7] DeepFilterNet / torchaudio 2.11 yamasi...")
    patch_deepfilter()

    # 6. Resemble Enhance yamalari
    print("\n[6/7] Resemble Enhance yamalari...")
    patch_resemble_enhance()

    # 7. .env
    print("\n[7/7] .env kontrolu...")
    check_env()

    print()
    print("=" * 54)
    print(f"  [OK] Kurulum tamamlandi!")
    if gpu_name:
        print(f"  GPU: {gpu_name} ({cuda_tag.upper()})")
    else:
        print("  GPU: Yok (CPU modu)")
    print()
    print("  Baslatmak icin: VoiceCraft-AI.bat")
    print("=" * 54)
    print()


if __name__ == "__main__":
    main()
