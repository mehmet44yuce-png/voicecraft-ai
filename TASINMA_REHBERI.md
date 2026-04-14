# VoiceCraft AI — Başka Bilgisayara Taşıma Rehberi

## 1. Donanım Gereksinimleri

| Bileşen | Minimum | Önerilen |
|---------|---------|----------|
| İşletim Sistemi | Windows 10 64-bit | Windows 11 64-bit |
| CPU | 4 çekirdek | 8+ çekirdek |
| RAM | 16 GB | 32 GB+ |
| GPU | Yok (CPU moduna düşer) | NVIDIA RTX 30/40/50 serisi, 8GB+ VRAM |
| Disk | 15 GB boş | 30 GB+ SSD |
| İnternet | Kurulum için gerekli (model indirme) | — |

**NOT:** RTX 50 serisi (Blackwell) için **CUDA 12.8** şarttır. Setup.bat otomatik kurar.

---

## 2. Yazılım Ön Gereksinimleri

Bunlar Setup.bat otomatik kurar, ama başarısız olursa manuel kur:

- **Python 3.12+** — https://python.org (kurulumda "Add to PATH" işaretle)
- **Git** — https://git-scm.com
- **Rust** — https://rustup.rs (DeepFilterNet derlemesi için)
- **Visual C++ Redistributable 2015+** — winget üzerinden otomatik
- **FFmpeg** — `bin/ffmpeg.exe` ile pakete dahil (yoksa winget)
- **NVIDIA GPU sürücüsü** — en son sürüm (geforce.com/drivers)

---

## 3. Taşınacak Dosyalar

### A. Zorunlu

```
server.py                 — Flask backend
updater.py                — Güncelleme motoru
version.json              — Versiyon + hash manifest
launcher.py               — Başlatıcı (exit code 42 restart loop)
requirements.txt          — Python paket listesi
Setup.bat                 — Kurulum sihirbazı
Synergy-Kendiyas-Fabric.bat  — Çalıştırıcı
public/                   — Frontend (index.html, app.js, admin.html, style.css)
bin/ffmpeg.exe            — FFmpeg (portable)
bin/ffprobe.exe
```

### B. Gizli / Kişisel (manuel kopyala)

```
.env                      — HF_TOKEN, ANTHROPIC_API_KEY
```

**`.env` örneği:**
```
HF_TOKEN=hf_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
ANTHROPIC_API_KEY=sk-ant-XXXXXXXXXXXXX
```
- HF_TOKEN **zorunlu** (Pyannote Diarize için) → https://huggingface.co/settings/tokens
- ANTHROPIC_API_KEY opsiyonel (Claude analiz için) → https://console.anthropic.com

### C. Taşımaya Gerek Olmayanlar

- `node_modules/` — kullanılmıyor (Flask backend)
- `__pycache__/` — otomatik yeniden oluşur
- `uploads/` — boş gelsin (yeni işleri orada tutar)
- `yedek/` — manuel yedekler, isteğe bağlı
- AI modelleri (Whisper, Pyannote, DNS64, Silero, DeepFilter) — Setup.bat ilk açılışta indirir

---

## 4. Adım Adım Kurulum (Yeni Bilgisayarda)

### Adım 1 — Dosyaları Kopyala
ZIP'i (ör. `Synergy-Kendiyas-Fabric.zip`) hedef bilgisayara aktar ve aç.

### Adım 2 — Setup.bat'i Yönetici Olarak Çalıştır
Sağ tık → "Yönetici olarak çalıştır"

Sihirbaz 5 adımdan geçer:
1. **Rust + Git + VC++ + Python + FFmpeg** (15 dk)
2. **PyTorch** — GPU varsa CUDA 12.8, yoksa CPU (10 dk, ~3 GB)
3. **AI paketleri** — Whisper, Demucs, Pyannote, DeepFilter, Silero VAD, TTS, vs (10 dk, ~2 GB)
4. **Model indirme** — Whisper Large (3 GB), DNS64 (128 MB), Silero (50 MB), DeepFilter (100 MB)
5. **Tamamlama** — `.installed` dosyası oluşur, masaüstü kısayolu

### Adım 3 — `.env` Dosyasını Doldur
Setup boş `.env` oluşturur. Eski bilgisayardan kopyalayabilir veya Admin Panel → İşlem Ayarları'ndan HF_TOKEN girebilirsin.

### Adım 4 — İlk Çalıştırma
Masaüstü kısayoluna çift tıkla veya `Synergy-Kendiyas-Fabric.bat`. Tarayıcıda otomatik `http://localhost:3000` açılır.

### Adım 5 — Test Et
- **Admin Panel** (`/admin.html`) → Sistem Durumu → GPU algılanmış mı?
- Küçük bir .mp3 yükle → 13 adımlık pipeline tam çalışıyor mu?

---

## 5. Yaygın Sorunlar

### GPU Algılanmıyor / "torch.cuda.is_available()=False"
- `nvidia-smi` çalışıyor mu? Çalışmıyorsa GPU sürücüsü güncelle.
- RTX 50 serisi için **CUDA 12.8 şart** — CUDA 12.4 çalışmaz. Setup.bat otomatik kurar, kurulmadıysa:
  ```
  pip uninstall torch torchaudio -y
  pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
  ```

### DLL Hatası / "DLL load failed"
- Visual C++ Redistributable 2015+ eksik. Winget ile kur:
  ```
  winget install Microsoft.VCRedist.2015+.x64
  ```

### Pyannote Diarize Hata Veriyor
- HF_TOKEN yok veya geçersiz → `.env`'yi kontrol et.
- https://huggingface.co/pyannote/speaker-diarization-3.1 sayfasından modele erişim onayla.

### DeepFilterNet Crashes (RTX 50)
- cuDNN RNN kerneli Blackwell'de patlıyor. `server.py` içinde `torch.backends.cudnn.enabled = False` zaten set. Kod taşındıysa sorun olmaz.

### Ses Yüklenemiyor (32-bit float WAV)
- Chrome `decodeAudioData` bazı 32-bit float WAV'larda yavaş/hatalı. WAV'ı önce 16-bit'e çevir:
  ```
  ffmpeg -i input.wav -c:a pcm_s16le output.wav
  ```

### "CUDA_VISIBLE_DEVICES= " ile CPU moduna zorla
`Synergy-Kendiyas-Fabric.bat` içine ekle:
```bat
set CUDA_VISIBLE_DEVICES=
```

### FFmpeg Bulunamadı
`bin/` klasöründe `ffmpeg.exe` yoksa:
```
winget install Gyan.FFmpeg
```

---

## 6. Yedek ve Geri Yükleme

### IndexedDB Verileri (Projeler, Pipeline Cache)
Tarayıcıda saklı. Admin Panel → Yedekleme → JSON olarak dışa aktar. Yeni bilgisayarda aynı paneleden içe aktar.

### `.installed` Dosyası
Setup.bat tekrar gerektirse bu dosyayı sil, tekrar çalışır.

### Güncelleme Sistemi
`version.json` + GitHub Releases'den otomatik kontrol. Güncelleme varsa bildirim çubuğu görünür, "Uygula" ile tek tıkla.

---

## 7. Manuel Kurulum (Setup.bat İşe Yaramazsa)

```powershell
# 1. Python sanal ortam (opsiyonel ama tavsiye)
python -m venv .venv
.\.venv\Scripts\activate

# 2. PyTorch (GPU varsa CUDA 12.8)
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128

# 3. Temel
pip install flask flask-cors anthropic python-dotenv pystray Pillow psutil pynvml tabulate json-repair

# 4. AI pipeline
pip install faster-whisper demucs noisereduce soundfile librosa scipy numpy pydub pyannote.audio silero-vad DeepFilterNet denoiser voicefixer pyloudnorm ffmpeg-python

# 5. Opsiyonel (Resemble + TTS)
pip install resemble-enhance --no-deps
pip install TTS

# 6. omegaconf uyumluluk
pip install "omegaconf>=2.3" --force-reinstall

# 7. Başlat
python server.py
```

---

## 8. Kontrol Listesi (Yeni Bilgisayarda)

- [ ] Windows 10/11 64-bit
- [ ] NVIDIA driver güncel (`nvidia-smi` çalışıyor)
- [ ] Python 3.12+ PATH'te (`python --version`)
- [ ] FFmpeg ulaşılabilir (`ffmpeg -version` veya `bin/ffmpeg.exe`)
- [ ] `.env` dosyası HF_TOKEN içeriyor
- [ ] Setup.bat tamamlandı, `.installed` oluştu
- [ ] `python server.py` hatasız başlıyor, 3000 portu açık
- [ ] http://localhost:3000 → Arayüz açılıyor
- [ ] http://localhost:3000/admin.html → Sistem Durumu GPU algılıyor
- [ ] Test ses dosyası 13 adımlık pipeline'dan geçiyor

---

## 9. Güvenlik Notu

- `.env` dosyasını **asla** paylaşmayın, git'e eklemeyin (zaten `.gitignore`'da).
- HF_TOKEN ve ANTHROPIC_API_KEY kişiseldir, ücrete tabi olabilir.
- Portable paket başka kullanıcılara dağıtılacaksa `.env`'yi önceden silin.
