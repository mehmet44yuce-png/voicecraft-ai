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
cd "d:/Projeler/AI Audi"
python server.py
```
**ASLA** `npm run dev`, `npx ts-node`, veya `node` kullanma. Express sunucusu (`src/server.ts`) sadece yedek. Ana backend **Flask** (`server.py`).

## Dosya Yapisi
```
server.py             — Flask backend (3900+ satir, tum API'ler)
.env                  — Ortam degiskenleri (HF_TOKEN, ANTHROPIC_API_KEY)
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
- HF Token yonetimi

## Onemli API Endpoint'leri
| Endpoint | Metod | Aciklama |
|----------|-------|----------|
| /api/system-stats | GET | CPU, RAM, GPU, disk |
| /api/config | GET | HF token, model ayarlari |
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

### Video A/V senkron drift
Iki re-encode pass (merge → cut) audio sample boundary ile video frame boundary
arasinda kucuk kaymalar BIRIKTIRIYORDU → sonucta ses videodan once geliyordu.
→ **Tek-pass dual-input:** Her segment icin video ve ses ayri input olarak verilir, AYNI
   `-ss` ile ikisi de seek edilir → frame-perfect senkron, tek re-encode, merge adimi yok.

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
- GitHub Releases uzerinden manifest.json + degisen dosyalar
- SHA-256 hash dogrulama, otomatik yedekleme (3 yedek tutulur)
- Frontend bildirim cubugu + otomatik uygulama
- Sunucu restart: exit code 42 → launcher tekrar baslatir
- API: `/api/update/check`, `/api/update/apply`, `/api/update/status/:id`, `/api/update/rollback`, `/api/update/restart`
- Manifest olusturma: `python installer/build_manifest.py 1.1.0 "changelog"`

## Portable Dagitim (installer/)
- `installer/build_portable.py` — portable paket olusturur
- `installer/create_manual_pdf.py` — PDF kilavuz olusturur
- `installer/launcher.py` — baslat + guncelleme kontrol + restart loop
- `Setup.bat` — 5 adimli kurulum sihirbazi (VC++, Python, FFmpeg, PyTorch, AI modeller, Whisper model)
- `Synergy-Kendiyas-Fabric.bat` — calistir (CUDA_VISIBLE_DEVICES= ile GPU yoksa hata onleme)
- Masaustu kisayolu otomatik olusturulur
- GPU yoksa otomatik CPU PyTorch, DLL hatasi → eski versiyon fallback
- Eksik paketler: python-dotenv, json-repair, pyloudnorm (Setup'a eklendi)
- Visual C++ Runtime otomatik kurulumu

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
