# VoiceCraft AI — Proje Rehberi

## Genel Bakis
AI destekli ses ve video editoru. Ses/video dosyalarini yukleyip, AI pipeline ile temizleyip, kesilmis/temizlenmis cikti uretir.

## Teknoloji
- **Backend:** Python Flask (`server.py`, port 3000) — TUM API endpoint'leri burada
- **Frontend:** Vanilla JS (`public/app.js`, `index.html`, `style.css`)
- **AI/ML:** Whisper, Demucs, NoiseReduce, Silero VAD, Pyannote Diarize, DNS64, DeepFilterNet, VoiceFixer, Resemble Enhance
- **GPU:** NVIDIA RTX 5070 Ti Laptop GPU (12GB VRAM, CUDA)
- **Video:** FFmpeg — video/ses birlestirme, kesim, re-encode
- **DB:** IndexedDB (tarayici) — session, transcripts, diarize, vad, projects, pipeline, step_audio

## Sunucu Baslatma
```bash
cd "d:/kod/AI Audi"
python server.py
```
**ASLA** `npm run dev`, `npx ts-node`, veya `node` kullanma. Express sunucusu (`src/server.ts`) sadece yedek. Ana backend **Flask** (`server.py`).

## Dosya Yapisi
```
server.py             — Flask backend (3900+ satir, tum API'ler)
.env                  — Ortam degiskenleri (HF_TOKEN, ANTHROPIC_API_KEY, OLLAMA_MODEL)
.env.default          — Dagitim icin varsayilan HF_TOKEN (gitignore'da, ZIP'e dahil edilir)
setup_compat.py       — Kurulum sonrasi uyumluluk yamalari (Resemble, DeepFilter vb.)
add_to_startup.py     — Windows otomatik baslama kaydeder (Task Scheduler veya Startup klasoru)
launcher.py           — Sunucu baslatici (guncelleme kontrol + restart loop + sistem tepsisi)
src/server.ts         — Express yedek sunucu (kullanilmiyor normalde)
public/
  index.html          — Ana sayfa (Ses + Video modulleri, 4 sekme)
  app.js              — Tum frontend mantigi (9500+ satir)
  style.css           — Audacity-ilhamli koyu tema
  admin.html          — Admin panel (sistem durumu, yedekleme, ayarlar)
  project-manager.js  — Proje kayit/yukleme (IndexedDB)
  canvas-overlay.js   — Dalga formu gorsellestirme
yedek/                — Manuel yedekler
```

## Modul Yapisi

### 1. Ses Modulu (orijinal — DOKUNMA)
- Ses dosyasi yukle → 13 adimlik pipeline → temizlenmis ses indir
- `showNoiseGateModal()` icinde calisiyor
- Pipeline adimlari: 1.Whisper → 1b.Ollama → 2.Demucs → 3.NoiseReduce → 4.DNS64 → 5.SpeechOnly → 6.Diarize → 7.VAD → 8b.Normalize → 8.Kesim → 9a.VoiceFixer → 9b.Resemble → 9c.DeepFilter
- **Bu module mudahale etme** — calisiyor, test edilmis

### 2. Video Modulu (yeni — v2 sira)
- Video yukle → ses cikar → bagimsiz pipeline → temiz ses + video kesim → indir
- 4 alt sekme: Onizleme | Ses Isleme | AI Analiz | Altyazi
- **Ses modulune hic dokunmaz** — dogrudan API cagirir
- Pipeline sonucu IndexedDB'ye kaydedilir, kaldigi yerden devam eder
- Cache versiyon damgasi: `localStorage.video_pipeline_state.version = 'v2'`

#### Video Pipeline Adimlari (10 adim — v2 yeni sira)
**Mantik:** Once sesi tamamen temizle (1-7), sonra TEMIZ ses uzerinden VAD/Diarize cikar (8-9),
en son kesim haritasi olustur (10). Eski v1 sirada VAD/Diarize kirli ses uzerinde calisiyordu,
yanlis pozitiflere yol aciyordu.

| # | Adim | API | Async | Audio yazar mi? |
|---|------|-----|-------|-----------------|
| 1 | Whisper (Transkript) | /api/transcribe/start + status polling | Evet | Hayir (sadece okur) |
| 2 | Demucs (Vokal Izolasyon) | /api/denoise | Hayir (pipeFetch) | Evet |
| 3 | NoiseReduce | /api/denoise-nr?async=true + progress + download | Evet | Evet |
| 4 | DNS64 (Anlik Gurultu) | /api/enhance | Hayir (pipeFetch) | Evet |
| 5 | SpeechOnly | /api/speech-only/start + progress + download | Evet | Evet |
| 6 | Normalize (Ses Dengeleme) | /api/normalize-speakers (field: `audio`) | Hayir | Evet |
| 7 | DeepFilterNet | /api/deepfilter | Hayir (timeout YOK) | Evet |
| 8 | VAD (Sessizlik Haritasi) | /api/vad + progress polling | Evet | Hayir (segments) |
| 9 | Diarize (Konusmaci Tespiti) | /api/diarize + progress polling | Evet | Hayir (segments) |
| 10 | Kesim Haritasi | Frontend (VAD+Diarize birlestirme) | — | Hayir (cuts) |

**Resume mantigi:** Audio yazan adimlar listesi `[7, 6, 5, 4, 3, 2, 1]`. En son tamamlanan
audio-yazar adimdan IndexedDB'deki `video_step_N`'i yukler.

#### Video Kesim (son adim — buton)
- **Tek-pass dual-input + segment-bazli NVENC + concat demuxer** (G yontemi)
- Eski: Merge (re-encode) -> Cut (re-encode) -> A/V drift birikimi
- Yeni: Tek pass — her segment icin video + temiz_ses AYRI input, AYNI `-ss` -> frame-perfect senkron
- Encoder: NVIDIA NVENC (`h264_nvenc`), libx264 fallback otomatik
- Concat: `-f concat -c copy` (re-encode YOK, ms cinsinden)
- Async job: `/api/video-cut` -> progress polling -> download
- Frontend canli progress: `_ffmpeg_run_with_progress` stderr parse + tek satir guncelleme
- 2000+ segment desteklenir (eski `select+aselect` filter bellek hatasi veriyordu)

#### Video Pipeline Buton Aksiyonlari (her tamamlanan ses-adimi icin)
- 🔊 Sesi Dinle (IndexedDB modal player)
- ⬇ Sesi Indir (mp3)
- ▶ Video Izle (NVENC merge `/api/video-merge-only`)
- 💾 Video Indir (NVENC merge)

### 3. Admin Panel (admin.html)
- 9 sekme: Sistem Durumu, Proje Yonetimi, Veritabani, Model Yonetimi, Islem Ayarlari, Hata Gecmisi, Sunucu Loglari, Raporlar, TTS Test, Yedekleme
- Yedekleme: IndexedDB (7 store) + dosya export JSON olarak
- Pipeline adimlari checkbox'lari (13 adim)
- **HF Token:** Admin → Islem Ayarlari → giris + Kaydet → `.env` dosyasina kalici yazar (`/api/config/save`)
- **Ollama Model secimi:** Admin → Islem Ayarlari → yüklü modeller otomatik listelenir → sec + Kaydet → aninda aktif (sunucu restart gerekmez)

## Onemli API Endpoint'leri
| Endpoint | Metod | Aciklama |
|----------|-------|----------|
| /api/system-stats | GET | CPU, RAM, GPU, disk |
| /api/config | GET | HF token, ollama_model doner |
| /api/config/save | POST | HF Token ve/veya Ollama model `.env`'e kaydeder |
| /api/server-log | GET | Sunucu loglari |
| /api/transcribe/start | POST | Whisper (async job) |
| /api/denoise | POST | Demucs vokal izolasyon |
| /api/denoise-nr | POST | NoiseReduce (async=true destekler) |
| /api/enhance | POST | DNS64 |
| /api/speech-only/start | POST | SpeechOnly (async job) |
| /api/vad | POST | VAD (async job) |
| /api/diarize | POST | Diarize (async job) |
| /api/normalize-speakers | POST | Ses dengeleme (**field: `audio`**) |
| /api/deepfilter | POST | DeepFilterNet (GPU chunked, OOM'da CPU fallback) |
| /api/video-cut | POST | Video kesim (async, dual-input segment NVENC) |
| /api/video-cut/progress/:id | GET | Kesim canli durum (ffmpeg stderr parse) |
| /api/video-cut/download/:id | GET | Kesilmis video indir |
| /api/video-merge-only | POST | Sadece ses+video birlestir (frontend ad\u0131m butonlari) |
| /api/video-merge-only/progress/:id | GET | Merge durumu |
| /api/video-merge-only/download/:id | GET | Birlestirilmis video indir |
| /api/process | POST | Ses kesim (segments JSON) |
| /api/analyze | POST | Claude AI analiz |
| /api/command | POST | AI komut |

## Bilinen Sorunlar ve Cozumler

### DeepFilterNet + torchaudio 2.11 uyumsuzlugu
`torchaudio.backend.common.AudioMetaData` ve `ta.info()` torchaudio 2.11'de kaldirildi.
→ `.venv/Lib/site-packages/df/io.py` yamalanmali:
  - `AudioMetaData` icin dataclass stub (try/except zinciri)
  - `ta.info` yoksa soundfile ile monkey-patch
Bu yamalar yeni ortamda tekrar yapilmali (venv yeniden olusturulursa kaybolur).

### Resemble Enhance — deepspeed olmadan kurulum
`pip install resemble-enhance` deepspeed'i zorunlu tutar, Windows'ta derlenemiyor.
→ `pip install resemble-enhance --no-deps` (deepspeed atlanir)
→ Asagidaki 4 dosya yamalanmali (try/except ile deepspeed opsiyonel):
  - `.venv/.../resemble_enhance/utils/distributed.py`
  - `.venv/.../resemble_enhance/utils/engine.py`
  - `.venv/.../resemble_enhance/enhancer/train.py`
  - `.venv/.../resemble_enhance/denoiser/train.py`
→ **`setup_compat.py` bu yamalari otomatik uygular.** Bozuk `distributed.py` (coklu `if _has_deepspeed:` birikimi) de otomatik duzeltilir.

### Resemble Enhance — model indirme (Git LFS)
Model `pip install` ile gelmez, git clone gerekir:
```powershell
cd ".venv\Lib\site-packages\resemble_enhance"
git clone https://huggingface.co/ResembleAI/resemble-enhance model_repo --no-local
cd model_repo
git lfs install
git lfs pull
```
Git LFS kurulu degilse once: `winget install GitHub.GitLFS`

### Resemble Enhance — PosixPath hatasi (Windows)
`model_repo/enhancer_stage2/hparams.yaml` Linux'ta kaydedilmis, `PosixPath` nesneleri var.
Windows'ta `cannot instantiate 'PosixPath'` hatasi verir.
→ hparams.yaml icindeki su 3 satiri string path'e cevir:
```yaml
# ONCE (bozuk):
fg_dir: !!python/object/apply:pathlib.PosixPath
- data
- fg
# SONRA (duzeltilmis):
fg_dir: data/fg
```
bg_dir ve rir_dir icin de ayni sekilde.

### Resemble Enhance — CUDA tensor karışıklığı (torchaudio 2.11)
torchaudio 2.11 ile Resemble model icinde CPU/GPU tensor karismasi oluyor.
→ `server.py` icinde Resemble adimi icin `_dev = torch.device('cpu')` zorla set edilmis.

### numpy surum catismasi
`deepfilternet` numpy < 2.0 ister, `pyannote` numpy >= 2.0 ister.
`pip install deepfilternet` numpy'i 1.26.x'e dusurebilir.
→ Kurulumdan sonra: `pip install "numpy>=2.0" --force-reinstall`

### Flask tek thread
Pipeline sirasinda polling Flask'i kitler.
→ `pipeFetch()` wrapper: `_pipeStepBusy` flag polling'i durdurur.

### Turkce karakter (Latin-1)
HTTP header'larinda Turkce karakter patlatir.
→ `ensure_ascii=True` + ASCII-safe dosya adlari (`replace(/[^\x20-\x7E]/g, '_')`).

### NoiseReduce timeout
Uzun dosyalarda senkron fetch timeout olur.
→ Async job: `async=true` param + progress polling + download endpoint.

### DeepFilterNet ve cuDNN GRU bug
RTX 5070 Ti (Blackwell) + cuDNN'in RNN kerneli GRU forward pass'i patlatiyor.
→ `torch.backends.cudnn.enabled = False` (cudnn'i kapat, PyTorch native CUDA kerneli kullanir)
→ Model GPU'da, audio tensor CPU'da kalmali (DF API'si ic STFT'yi rust ile yapar)
→ Chunked inference (30sn parcalar) — VRAM dolu degilse 30-40x realtime
→ OOM olursa otomatik CPU fallback ([server.py:_df_run](server.py))

### Video kesim — 2000+ segment patolojisi
**Eski yaklasimlar (calismadi):**
- `trim+concat filter`: 2000+ segmentte O(n²) scheduler bottleneck → saatlerce takilir
- `select+aselect filter`: 2000+ between() FFmpeg expression parser'i sisirir → `Cannot allocate memory`

**Yeni cozum (G yontemi, calisiyor):**
- Her keep region icin AYRI ffmpeg + NVENC cagrisi → `tmp_dir/segments/seg_NNNNN.mp4`
- Sonra `concat demuxer -c copy` ile stream copy birlestirme (re-encode YOK, ms cinsinden)
- Filter graph YOK → bellek/scheduler sorunu yok

### Video A/V senkron drift (eski sorun — cozuldu)
Iki re-encode pass (merge → cut) audio sample boundary ile video frame boundary
arasinda kucuk kaymalar BIRIKTIRIYORDU → sonucta ses videodan once geliyordu.
→ **Tek-pass dual-input:** Her segment icin video ve ses ayri input olarak verilir, AYNI
   `-ss` ile ikisi de seek edilir → frame-perfect senkron, tek re-encode, merge adimi yok.

### SpeechOnly — Video pipeline'da ses videoya gore cok once geliyor
**Neden:** `_run_so_job` sessizlikleri kaldirip sadece konusmalari birlestiriyor (ffmpeg concat).
Bu audio dosyasini orijinal videodan cok daha kisa yapiyor (ornek: 60dk video → 15dk audio).
Sonraki adimlar (VAD, video-cut) bu kisaltilmis audioyu kullaniyor → zaman damgalari uyusmuyor.

**Cozum:** Video pipeline'dan cagrildiginda `zero_out=true` parametresi gonderilir.
`zero_out` modunda SpeechOnly: sessizlikleri kaldirmak yerine **sifirlar** (ayni sure,
konusma disi kisimlar susturulur, konusma kisilari aynen korunur).
- `server.py:_run_so_job` — `zero_out=True` parametresi, soundfile ile yerinde sifirlama
- `public/app.js` — video pipeline adim 5'te `fd5s.append('zero_out', 'true')`
- Ses modulu (ses pipeline) eski concat modunu kullanmaya devam eder, degismedi.
**DIKKAT:** Bu degisiklikten onceki `video_step_5` cache gecersiz — pipeline yeniden calistirilmali.

### NVENC + libx264 fallback
NVENC patlasa libx264'e otomatik gecis. `USE_NVENC=0` env var ile zorla CPU.
NVENC encode CPU'dan ~5x hizli, decode hala CPU'da kalir (bottleneck).

### FFmpeg filter_complex Windows komut satiri limiti (8191)
Cok bolum icin filter_complex 170 KB+ olabilir → `[WinError 206] Dosya adi cok uzun`.
→ Filter dosyaya yazilir + `-filter_complex_script filter.txt` ile gecirilir.
   (Not: G yonteminde artik filter_complex kullanilmiyor, sadece basit `-ss/-t`.)

### Upload limiti
→ `MAX_CONTENT_LENGTH = 15 GB`

### Normalize field name
→ `audio` (file degil!)

### Audio dosya zaman hesabi (frontend canli progress)
ffmpeg subprocess sync calistirken job['pct'] guncellemesi yapilamaz.
→ `_ffmpeg_run_with_progress` helper: `subprocess.Popen` + stderr line-by-line oku,
   `time=HH:MM:SS speed=X.Xx fps=N` parse et, `job['pct']/['step']` her saniyede 1 guncelle.
   Frontend `_vTick` tek satirli canli log gosterir.

## Video Pipeline Resume Sistemi
- Her adim ciktisi IndexedDB'ye kaydedilir: `video_step_N`
- Pipeline state localStorage'da: `video_pipeline_state`
- Sayfa yenilendiginde son tamamlanan adimdan devam eder
- Her adimda "Dinle" + "Buradan Devam" butonlari
- Temiz ses ayrica `video_clean_audio` key'inde saklanir

## Uzaktan Guncelleme Sistemi
- `updater.py` — guncelleme motoru (check, diff, download, backup, apply, rollback)
- `version.json` — yerel versiyon + dosya hash'leri
- GitHub repo: `mehmet44yuce-png/voicecraft-ai` (PUBLIC olmali, yoksa anonim erisim 404)
- GitHub Releases uzerinden manifest.json + degisen dosyalar
- SHA-256 hash dogrulama, otomatik yedekleme (3 yedek tutulur)
- Frontend bildirim cubugu (hem index.html hem admin.html) + otomatik uygulama
- Sunucu restart: exit code 42 → launcher tekrar baslatir
- API: `/api/update/check`, `/api/update/apply`, `/api/update/status/:id`, `/api/update/rollback`, `/api/update/restart`

### Release Yayinlama (otomatik — TERCIH EDILEN)
```bash
python release.py 1.0.6 "Bug fix aciklamasi"
# veya belirli dosyalar icin:
python release.py 1.0.6 "Sadece UI" public/index.html public/admin.html
```
Script otomatik: degisen dosyalari tespit eder → manifest yazar → commit + push → GitHub release olusturur → dosyalari yukler → hash dogrular.

**Gereksinim:** `.env`'de `GITHUB_TOKEN=ghp_xxx` (scope: `repo`). Token uretmek: https://github.com/settings/tokens

### Release Yayinlama (manuel — KULLANMA)
`python installer/build_manifest.py 1.1.0 "changelog"` — eski yontem. Manifest uretir ama GitHub release/upload manuel. Hash mismatch riskli (yanlis dosya yuklenebilir). `release.py` kullan.

### EXCLUDE Listesi (KRITIK)
`updater.py` icindeki `EXCLUDE` set'ine `.git`, `.venv`, `venv`, `voicecraft`, `installer`, `.vscode`, `.idea`, `yedek` dahil olmali. Yoksa `compute_local_hashes()` git internals + venv'i tarar → manifest sisirilir, performans cokusu ve gereksiz dosya transferi.

## Portable Dagitim (installer/)
- `installer/build_portable.py` — portable paket olusturur
- `installer/create_manual_pdf.py` — PDF kilavuz olusturur (v2 pipeline sirasi)
- `installer/launcher.py` — baslat + guncelleme kontrol + restart loop
- `Setup.bat` — Tam otomatik kurulum sihirbazi:
  1. Python 3.12 yoksa → `winget` ile kurar, olmazsa python.org'dan indirir
  2. FFmpeg yoksa → `winget` ile kurar
  3. Virtual environment olusturur
  4. PyTorch cu128 + tum AI paketleri kurulur (`installer/setup_packages.py`)
  5. Uyumluluk yamalari uygulanir (`setup_compat.py`)
  6. `.env.default` varsa `.env`'e kopyalar (HF Token otomatik)
  7. Otomatik baslama kaydedilir (`add_to_startup.py`)
- `VoiceCraft-AI.bat` — calistir (CUDA_VISIBLE_DEVICES= ile GPU yoksa hata onleme)
- Masaustu kisayolu otomatik olusturulur
- GPU yoksa otomatik CPU PyTorch, DLL hatasi → eski versiyon fallback
- Paketler: python-dotenv, json-repair, pyloudnorm, resemble-enhance, voicefixer, silero dahil
- Visual C++ Runtime otomatik kurulumu

### Kurulu Surum Referansi (Nisan 2026)
| Paket | Surum | Not |
|-------|-------|-----|
| torch / torchaudio | 2.11.0+cu128 | RTX 50xx Blackwell icin cu128 zorunlu |
| anthropic | 0.94.1 | |
| flask / flask-cors | 3.1.3 / 6.0.2 | |
| faster-whisper | 1.2.1 | |
| openai-whisper | 20250625 | |
| demucs | 4.0.1 | |
| noisereduce | 3.0.3 | |
| DeepFilterNet | 0.5.6 | df/io.py yamasi gerekli (torchaudio 2.11) |
| silero-vad | 6.2.1 | |
| voicefixer | 0.1.3 | |
| resemble-enhance | 0.0.1 | --no-deps + deepspeed yamasi + model LFS |
| pyannote.audio | 4.0.4 | |
| onnxruntime | 1.24.4 | |
| numpy | 1.26.4 | **sabit tut** — deepfilternet<2.0, pyannote>=2.0 catismasi |
| soundfile / librosa / scipy | 0.13.1 / 0.11.0 / 1.17.1 | |
| pyloudnorm | 0.2.0 | |
| psutil / nvidia-ml-py | 7.2.2 / 13.595.45 | Sistem izleme |
| GitPython | 3.1.46 | Release sistemi |
| python-dotenv / json-repair | 1.2.2 / 0.59.3 | |
| pystray / Pillow | 0.19.5 / 12.2.0 | |

**Kurulum sirasi:** torch (cu128) → pip requirements → resemble-enhance --no-deps → df/io.py yamasi → numpy sabitle

## Gelistirme Kurallari
1. **Ses modulune dokunma** — calisiyor, test edilmis
2. **Sunucu icin `python server.py`** kullan, Node.js degil
3. Turkce dosya adlarinda dikkatli ol — ASCII-safe yap (`replace(/[^\x20-\x7E]/g, '_')`)
4. Uzun suren API'ler icin async job pattern kullan
5. Pipeline sirasinda polling'i durdur (`_pipeStepBusy`)
6. **Video kesimde dual-input segment NVENC kullan** (`-ss video -ss audio` AYNI deger), `trim+concat` veya `select+aselect` filter KULLANMA — 2000+ segmentte patliyor
7. Her ses-uretici adim sonunda IndexedDB'ye `video_step_N` olarak kaydet, `_vCompleted[N] = true` set et
8. GPU olmayan bilgisayarlarda `CUDA_VISIBLE_DEVICES=` set et
9. Setup.bat'ta `/dev/null` degil `>nul` kullan (Windows)
10. PyTorch kurulumunda once `nvidia-smi` ile GPU kontrol et — RTX 5070 Ti (Blackwell) icin **cu128** gerekli, cu124 calismaz
11. **DeepFilterNet GPU:** `cudnn.enabled = False` set et (RNN kerneli Blackwell'de patliyor), audio tensor CPU'da kalmali
12. **Video pipeline yeni siralama (v2):** Sirayla 1-7 ses temizle → 8-9 TEMIZ ses uzerinden VAD/Diarize → 10 kesim haritasi. Ses modulunden farkli (orada VAD/Diarize ortada kirli ses uzerinde calisiyordu)
13. **Cache versiyonlama:** Pipeline siralamasi/cache yapisi degisirse `VIDEO_PIPELINE_VERSION` artir, `localStorage.video_pipeline_state.version !== VIDEO_PIPELINE_VERSION` ise eski cache'i temizle
14. Frontend `vStep(num, text, color)` aynı num ile tekrar cagrilirsa **mevcut satiri replace** eder, yeni satir eklemez (id'li satir)
15. Her ses-uretici tamamlanan adim icin frontend butonlari (Sesi Dinle/Indir, Video Izle/Indir) otomatik gosterilir; ses uretmeyen adimlar (8 VAD, 9 Diarize, 10 Kesim) icin gosterilmez
16. Uzun ffmpeg islemleri icin `_ffmpeg_run_with_progress` helper kullan (canli stderr parse, `job['pct']` ve `job['step']` guncelle)
17. **SpeechOnly video pipeline'da `zero_out=true` ile cagrilmali** — `zero_out=false` (varsayilan) sessizlikleri kaldirir ve audio kisalir → A/V desync. Video pipeline adim 5'te `fd5s.append('zero_out', 'true')` zorunlu. Ses modulu eski modu kullanir.
