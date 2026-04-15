// ── VoiceCraft AI ─────────────────────────────────────────────────────────────
'use strict';

// ── Guncelleme Kontrolu ──────────────────────────────────────────────────────
(function() {
  fetch('/api/update/check').then(function(r) { return r.json(); }).then(function(d) {
    if (d.success && d.update) {
      var bar = document.getElementById('update-bar');
      var txt = document.getElementById('update-bar-text');
      if (bar) bar.style.display = 'block';
      if (txt) txt.textContent = 'v' + d.update.new_version + ' mevcut — ' +
        d.update.files_to_update + ' dosya degismis' +
        (d.update.changelog ? ' | ' + d.update.changelog : '');
    }
  }).catch(function() {});
})();

function applyUpdate() {
  var btn = document.getElementById('update-bar-btn');
  var prog = document.getElementById('update-bar-progress');
  if (btn) { btn.disabled = true; btn.textContent = 'Guncelleniyor...'; }
  if (prog) prog.style.display = 'inline';

  fetch('/api/update/apply', { method: 'POST' }).then(function(r) { return r.json(); }).then(function(d) {
    if (!d.success) { alert('Guncelleme hatasi: ' + d.error); return; }
    // Poll
    var timer = setInterval(function() {
      fetch('/api/update/status/' + d.job_id).then(function(r) { return r.json(); }).then(function(s) {
        if (prog) prog.textContent = '%' + s.pct + ' — ' + s.step;
        if (s.status === 'done') {
          clearInterval(timer);
          if (prog) prog.textContent = 'Guncelleme tamamlandi!';
          if (btn) btn.textContent = 'Yeniden Baslat';
          btn.disabled = false;
          btn.onclick = function() {
            fetch('/api/update/restart', { method: 'POST' }).then(function() {
              if (prog) prog.textContent = 'Sunucu yeniden baslatiliyor... 5 saniye bekleyin';
              setTimeout(function() { location.reload(); }, 5000);
            });
          };
        }
        if (s.status === 'error') {
          clearInterval(timer);
          if (prog) prog.textContent = 'Hata: ' + s.error;
          var cb = document.getElementById('update-bar-copy');
          if (cb) cb.style.display = 'inline-block';
          if (btn) { btn.textContent = 'Tekrar Dene'; btn.disabled = false; }
        }
      });
    }, 2000);
  }).catch(function(e) { alert('Baglanti hatasi: ' + e.message); });
}

function copyUpdateError() {
  var prog = document.getElementById('update-bar-progress');
  var txt = document.getElementById('update-bar-text');
  var msg = (txt ? txt.textContent + '\n' : '') + (prog ? prog.textContent : '');
  navigator.clipboard.writeText(msg).then(function() {
    var cb = document.getElementById('update-bar-copy');
    if (cb) { var orig = cb.textContent; cb.textContent = '✓ Kopyalandi'; setTimeout(function() { cb.textContent = orig; }, 2000); }
  }).catch(function() {
    var ta = document.createElement('textarea');
    ta.value = msg; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    alert('Kopyalandi:\n' + msg);
  });
}

let _rawFileBlob = null;          // yüklenen ham dosya (File objesi) — TDZ önlemek için en üstte
let _originalAudioBuffer = null;  // pipeline başlamadan önceki orijinal AudioBuffer (PDF raporu için)
let _pipeStepBusy = false;        // Pipeline adımı API çağrısı sırasında true — polling'i durdurur

// Pipeline fetch wrapper — polling'i durdurur, uzun API çağrılarında Flask'ı rahatlatır
async function pipeFetch(url, options, timeoutMs) {
  _pipeStepBusy = true;
  try {
    if (timeoutMs) {
      var controller = new AbortController();
      var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
      var opts = Object.assign({}, options, { signal: controller.signal });
      var res = await fetch(url, opts);
      clearTimeout(timer);
      return res;
    }
    return await fetch(url, options);
  } finally {
    _pipeStepBusy = false;
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  audioCtx:      null,
  audioBuffer:   null,
  sourceNode:    null,
  analyserL:     null,
  analyserR:     null,
  gainNode:      null,
  layerGainNode: null,  // katman bazlı gain (mute/solo/vol)
  isPlaying:     false,
  startTime:     0,
  offset:        0,
  rafId:         null,
  animVU:        null,
  fileName:      '',
  analysis:      null,
  pps:           100,
  aiPanelOpen:   true,
  // Katman ses durumu: {layerId: {vol:0-1, muted:bool, soloed:bool}}
  layerState:    {},
  // Katman segmentleri analiz verisinden: {layerId: [{start,end}]}
  layerSegments: {},
};

// ── Modül geçişi (Ses / Video) ────────────────────────────────────────────────
function switchModule(mod) {
  document.getElementById('module-ses').style.display   = mod === 'ses'   ? '' : 'none';
  document.getElementById('module-video').style.display  = mod === 'video' ? '' : 'none';
  document.getElementById('module-tab-ses').classList.toggle('active',   mod === 'ses');
  document.getElementById('module-tab-video').classList.toggle('active', mod === 'video');
}

// ── Video Modülü ──────────────────────────────────────────────────────────────
const videoState = {
  file: null,
  audioBuffer: null,
  audioBlob: null,
  srtData: null,
  transcriptSegments: null,
  sceneAnalysis: null
};

function switchVideoTab(tab) {
  ['preview','audio','ai','subtitle'].forEach(function(t) {
    var el = document.getElementById('vtab-' + t);
    var btn = document.getElementById('vtab-' + t + '-btn');
    if (el) el.style.display = t === tab ? 'flex' : 'none';
    if (btn) btn.classList.toggle('active', t === tab);
  });
}

function vLog(msg, color) {
  var el = document.getElementById('video-pipeline-log');
  if (!el) return;
  var c = color || '#94a3b8';
  el.innerHTML += '<div style="color:' + c + '">[' + new Date().toLocaleTimeString('tr') + '] ' + msg + '</div>';
  el.scrollTop = el.scrollHeight;
}

// Uzun süren sync adımlar için canlı heartbeat — ses modülündeki _fakeTick muadili.
// Tek satırı yerinde günceller (id ile bulur), her saniye geçen süre + tahmini %.
// estSec sadece % çubuğu için kullanılır; gerçek bilgi geçen süredir.
function _vTick(label, estSec) {
  var el = document.getElementById('video-pipeline-log');
  if (!el) return { stop: function(){} };
  var liveId = 'vtick-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  var startMs = Date.now();
  el.innerHTML += '<div id="' + liveId + '" style="color:#fbbf24"></div>';
  el.scrollTop = el.scrollHeight;
  function update() {
    var live = document.getElementById(liveId);
    if (!live) return;
    var elapsed = (Date.now() - startMs) / 1000;
    var pct = Math.min(90, (elapsed / Math.max(estSec, 10)) * 100);
    var em = Math.floor(elapsed / 60);
    var es = Math.floor(elapsed % 60);
    var elapsedStr = em > 0 ? em + 'dk ' + (es < 10 ? '0' : '') + es + 'sn' : es + 'sn';
    live.textContent = '[' + new Date().toLocaleTimeString('tr') + '] ⏳ ' + label + ' — geçen ' + elapsedStr + ' (~%' + Math.round(pct) + ')';
  }
  update();
  var t = setInterval(update, 1000);
  return {
    stop: function(done) {
      clearInterval(t);
      var live = document.getElementById(liveId);
      if (live) {
        var elapsed = Math.round((Date.now() - startMs) / 1000);
        var em = Math.floor(elapsed / 60);
        var es = elapsed % 60;
        var elapsedStr = em > 0 ? em + 'dk ' + (es < 10 ? '0' : '') + es + 'sn' : es + 'sn';
        if (done === false) {
          live.style.color = '#ef4444';
          live.textContent = '[' + new Date().toLocaleTimeString('tr') + '] ✗ ' + label + ' başarısız (' + elapsedStr + ')';
        } else {
          live.style.color = '#4ade80';
          live.textContent = '[' + new Date().toLocaleTimeString('tr') + '] ✓ ' + label + ' tamamlandı (' + elapsedStr + ')';
        }
      }
    }
  };
}

function formatDuration(sec) {
  var m = Math.floor(sec / 60);
  var s = Math.floor(sec % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

// ── Video pipeline adım butonları (Sesi Dinle / İndir / Video İzle / İndir) ──
// Adım N'in ses çıktısını IndexedDB'den (video_step_N) oku.
async function _loadVideoStepAudio(stepNum) {
  var db = await openDB();
  try {
    var saved = await new Promise(function(res, rej) {
      var tx = db.transaction('step_audio', 'readonly');
      var req = tx.objectStore('step_audio').get('video_step_' + stepNum);
      req.onsuccess = function(e) { res(e.target.result); };
      req.onerror = function(e) { rej(e.target.error); };
    });
    if (saved && saved.data) {
      return new File([saved.data], saved.name || ('video_step_' + stepNum + '.mp3'), { type: saved.type || 'audio/mpeg' });
    }
    return null;
  } finally {
    db.close();
  }
}

// Modal: küçük overlay açar (audio veya video player için).
function _openVStepModal(title, contentEl) {
  // Önceki modal varsa kapat
  var prev = document.getElementById('vstep-modal');
  if (prev) prev.remove();
  var modal = document.createElement('div');
  modal.id = 'vstep-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px';
  var inner = document.createElement('div');
  inner.style.cssText = 'background:#0a1628;border:1px solid #334155;border-radius:8px;padding:16px;max-width:90vw;max-height:90vh;display:flex;flex-direction:column;gap:12px';
  var head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:12px;color:#e2e8f0;font-size:14px;font-weight:600';
  head.innerHTML = '<span style="flex:1">' + title + '</span><button style="background:none;border:1px solid #334155;color:#94a3b8;border-radius:4px;cursor:pointer;padding:4px 12px;font-size:12px">✗ Kapat</button>';
  head.querySelector('button').onclick = function() { modal.remove(); };
  inner.appendChild(head);
  inner.appendChild(contentEl);
  modal.appendChild(inner);
  modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
  return modal;
}

// Server'dan video + ses merge isteyip blob döndürür. İlerlemeyi statusCb(text, pct) ile bildirir.
async function _serverMergeVideoWithAudio(videoFile, audioFile, statusCb) {
  if (!videoFile) throw new Error('Video dosyası yok');
  if (!audioFile) throw new Error('Ses dosyası yok');
  if (statusCb) statusCb('Sunucuya yükleniyor...', 0);
  var fd = new FormData();
  fd.append('file', videoFile, videoFile.name);
  fd.append('clean_audio', audioFile, audioFile.name || 'temiz_ses.mp3');
  var r = await fetch('/api/video-merge-only', { method: 'POST', body: fd });
  var d = await r.json();
  if (!d.success) throw new Error(d.error || 'Merge başlatılamadı');

  // Progress polling
  await new Promise(function(resolve, reject) {
    var timer = setInterval(async function() {
      try {
        var pr = await fetch('/api/video-merge-only/progress/' + d.job_id);
        var pd = await pr.json();
        if (statusCb) statusCb(pd.step || 'işleniyor...', pd.pct || 0);
        if (pd.status === 'done') { clearInterval(timer); resolve(); }
        if (pd.status === 'error') { clearInterval(timer); reject(new Error(pd.error || 'Merge hatası')); }
      } catch(e) {}
    }, 1500);
  });

  if (statusCb) statusCb('Birleştirilmiş video indiriliyor...', 99);
  var dlR = await fetch('/api/video-merge-only/download/' + d.job_id);
  if (!dlR.ok) throw new Error('İndirme HTTP ' + dlR.status);
  var blob = await dlR.blob();
  if (statusCb) statusCb('Hazır', 100);
  return blob;
}

// Adım buton aksiyonu — 4 farklı işlev.
async function handleVStepAction(action, step, btn) {
  if (action === 'audio-listen') {
    btn.disabled = true; var oldText = btn.textContent; btn.textContent = '⏳ Yükleniyor...';
    try {
      var f = await _loadVideoStepAudio(step);
      if (!f) { alert('Bu adımın sesi cache\'de yok'); return; }
      var audio = document.createElement('audio');
      audio.controls = true;
      audio.autoplay = true;
      audio.style.cssText = 'width:60vw;min-width:300px;max-width:600px';
      audio.src = URL.createObjectURL(f);
      _openVStepModal('🔊 Adım ' + step + ' — Sesi Dinle (' + (f.size/1024/1024).toFixed(1) + ' MB)', audio);
    } finally { btn.disabled = false; btn.textContent = oldText; }
    return;
  }
  if (action === 'audio-dl') {
    btn.disabled = true; var oldText2 = btn.textContent; btn.textContent = '⏳ Yükleniyor...';
    try {
      var f2 = await _loadVideoStepAudio(step);
      if (!f2) { alert('Bu adımın sesi cache\'de yok'); return; }
      var a = document.createElement('a');
      a.href = URL.createObjectURL(f2);
      a.download = (videoState.file ? videoState.file.name.replace(/\.[^.]+$/, '') : 'video') + '_adim' + step + '.mp3';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function() { URL.revokeObjectURL(a.href); }, 5000);
    } finally { btn.disabled = false; btn.textContent = oldText2; }
    return;
  }
  if (action === 'video-watch' || action === 'video-dl') {
    if (!videoState.file) { alert('Video dosyası bellekte yok — videoyu tekrar açın'); return; }
    var ok = confirm('Bu işlem ' + (videoState.audioBuffer ? formatDuration(videoState.audioBuffer.duration) : '?') + ' uzunluğundaki videoyu sunucuda yeniden encode edecek. ~3-5 dakika sürebilir. Devam edilsin mi?');
    if (!ok) return;

    btn.disabled = true;
    var oldText3 = btn.textContent;
    btn.textContent = '⏳ Hazırlanıyor...';

    // Modal — progress göster
    var statusEl = document.createElement('div');
    statusEl.style.cssText = 'min-width:400px;color:#e2e8f0;font-size:13px;padding:20px';
    statusEl.innerHTML = '<div style="margin-bottom:8px">⏳ Sunucuya yükleniyor...</div><div style="height:6px;background:#1e293b;border-radius:3px;overflow:hidden"><div id="vstep-merge-bar" style="height:100%;background:#a78bfa;width:0%;transition:width 0.4s"></div></div>';
    var modal = _openVStepModal('▶ Adım ' + step + ' — Video Hazırlanıyor', statusEl);

    try {
      var stepAudio = await _loadVideoStepAudio(step);
      if (!stepAudio) throw new Error('Bu adımın sesi cache\'de yok');

      var blob = await _serverMergeVideoWithAudio(videoState.file, stepAudio, function(text, pct) {
        statusEl.firstChild.textContent = '⏳ ' + text + ' — %' + pct;
        var bar = document.getElementById('vstep-merge-bar');
        if (bar) bar.style.width = (pct || 0) + '%';
      });

      // Modal'ı kapat, sonucu göster
      modal.remove();
      if (action === 'video-watch') {
        var v = document.createElement('video');
        v.controls = true;
        v.autoplay = true;
        v.style.cssText = 'max-width:80vw;max-height:75vh';
        v.src = URL.createObjectURL(blob);
        _openVStepModal('▶ Adım ' + step + ' — Video İzle (' + (blob.size/1024/1024).toFixed(1) + ' MB)', v);
      } else {
        var a2 = document.createElement('a');
        a2.href = URL.createObjectURL(blob);
        a2.download = (videoState.file ? videoState.file.name.replace(/\.[^.]+$/, '') : 'video') + '_adim' + step + '.mp4';
        document.body.appendChild(a2);
        a2.click();
        document.body.removeChild(a2);
        setTimeout(function() { URL.revokeObjectURL(a2.href); }, 5000);
      }
    } catch(e) {
      modal.remove();
      alert('Video oluşturma hatası: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = oldText3;
    }
    return;
  }
  if (action === 'resume-from') {
    var fromStep = parseInt(step);
    var remaining = 10 - fromStep;
    if (!confirm('Adım ' + step + ' çıktısından itibaren devam edilecek.\n' + remaining + ' adım yeniden işlenecek.\n\nDevam edilsin mi?')) return;

    // localStorage'daki pipeline state'i güncelle: fromStep'ten sonrasını temizle
    try {
      var lsRaw = localStorage.getItem('video_pipeline_state');
      var lsState = lsRaw ? JSON.parse(lsRaw) : {};
      var completed = lsState.completedSteps || {};
      for (var ri = fromStep + 1; ri <= 10; ri++) {
        delete completed[String(ri)];
      }
      lsState.completedSteps = completed;
      localStorage.setItem('video_pipeline_state', JSON.stringify(lsState));
    } catch(e) {}

    // videoState üzerinde de güncelle (aynı session içindeyse geçerli)
    if (videoState._completedSteps) {
      for (var ri2 = fromStep + 1; ri2 <= 10; ri2++) {
        delete videoState._completedSteps[String(ri2)];
      }
    }

    // Pipeline'ı yeniden başlat (fromStep'e kadar önbellekten gelir, sonrası çalışır)
    videoStartPipeline();
    return;
  }
}

document.addEventListener('DOMContentLoaded', function() {
  var videoInput = document.getElementById('video-file-input');
  if (!videoInput) return;

  videoInput.addEventListener('change', function(e) {
    var file = e.target.files[0];
    if (!file) return;
    videoState.file = file;
    videoState.audioBuffer = null;
    videoState.audioBlob = null;
    videoState.srtData = null;
    videoState.transcriptSegments = null;

    // Önceki kesim haritasını localStorage'dan geri yükle
    // [v2] Sadece aynı pipeline versiyonuyla yapılmış kesim haritalarını geri yükle.
    try {
      var savedState = JSON.parse(localStorage.getItem('video_pipeline_state') || '{}');
      if (savedState.version === 'v2' && savedState.fileName === file.name && savedState.cutSegments && savedState.cutSegments.length) {
        videoState.cutSegments = savedState.cutSegments;
        // Kesim alanını göster
        setTimeout(function() {
          if (typeof window._onPipelineCutsReady === 'function') {
            window._onPipelineCutsReady(savedState.cutSegments);
          }
        }, 2000); // video metadata yüklendikten sonra
      }
    } catch(e) {}

    var player = document.getElementById('video-player');
    var placeholder = document.getElementById('video-placeholder');
    var nameEl = document.getElementById('video-file-name');
    var infoPanel = document.getElementById('video-info-panel');
    var metaEl = document.getElementById('video-meta');
    var audioMetaEl = document.getElementById('video-audio-meta');

    if (nameEl) nameEl.textContent = file.name;

    var url = URL.createObjectURL(file);
    player.src = url;
    player.style.display = 'block';
    if (placeholder) placeholder.style.display = 'none';

    player.onloadedmetadata = function() {
      if (infoPanel) infoPanel.style.display = 'block';
      var dur = player.duration;
      var sizeMB = (file.size / (1024 * 1024)).toFixed(1);
      var fps = 30; // tahmini

      if (metaEl) {
        metaEl.innerHTML =
          '<div><b>Dosya:</b> ' + file.name + '</div>' +
          '<div><b>Boyut:</b> ' + sizeMB + ' MB</div>' +
          '<div><b>Süre:</b> ' + formatDuration(dur) + '</div>' +
          '<div><b>Çözünürlük:</b> ' + player.videoWidth + 'x' + player.videoHeight + '</div>' +
          '<div><b>Tür:</b> ' + (file.type || 'video') + '</div>' +
          '<div><b>Toplam Kare:</b> ~' + Math.round(dur * fps) + '</div>';
      }

      // Üst durum çubuğunu hemen sarıya çek — kullanıcı niye beklediğini görsün
      var statusDot = document.getElementById('video-audio-status-dot');
      var statusTxt = document.getElementById('video-audio-status-text');
      if (statusDot) statusDot.style.background = '#fbbf24';
      if (statusTxt) statusTxt.textContent = 'Video belleğe okunuyor (0%)...';

      // Ses bilgisi — Web Audio ile çöz
      var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var reader = new FileReader();
      reader.onprogress = function(ev) {
        if (ev.lengthComputable && statusTxt) {
          var pct = Math.round((ev.loaded / ev.total) * 100);
          statusTxt.textContent = 'Video belleğe okunuyor %' + pct + ' (' + (ev.loaded / 1024 / 1024).toFixed(0) + '/' + (ev.total / 1024 / 1024).toFixed(0) + ' MB)';
        }
      };
      reader.onload = function() {
        if (statusTxt) statusTxt.textContent = 'Ses kanalı çözümleniyor (' + formatDuration(dur) + ')...';
        audioCtx.decodeAudioData(reader.result, function(buffer) {
          videoState.audioBuffer = buffer;
          if (audioMetaEl) {
            audioMetaEl.innerHTML =
              '<div><b>Kanal:</b> ' + buffer.numberOfChannels + '</div>' +
              '<div><b>Sample Rate:</b> ' + buffer.sampleRate + ' Hz</div>' +
              '<div><b>Süre:</b> ' + formatDuration(buffer.duration) + '</div>' +
              '<div><b>Toplam Sample:</b> ' + buffer.length.toLocaleString() + '</div>';
          }
          // Butonları etkinleştir
          var btn1 = document.getElementById('btn-video-extract-audio');
          var btn2 = document.getElementById('btn-video-screenshot');
          var btn3 = document.getElementById('btn-video-start-pipeline');
          var btn4 = document.getElementById('btn-video-ai-analyze');
          var btn5 = document.getElementById('btn-video-gen-srt');
          if (btn1) btn1.disabled = false;
          if (btn2) btn2.disabled = false;
          if (btn3) btn3.disabled = false;
          if (btn4) btn4.disabled = false;
          if (btn5) btn5.disabled = false;

          // Ses işleme durumunu güncelle
          if (statusDot) statusDot.style.background = '#4ade80';
          if (statusTxt) statusTxt.textContent = 'Ses çıkarıldı — ' + buffer.numberOfChannels + ' kanal, ' + formatDuration(buffer.duration);

          audioCtx.close();
        }, function(err) {
          if (audioMetaEl) audioMetaEl.innerHTML = '<div style="color:#ef4444">Ses kanalı çözümlenemedi</div>';
          if (statusDot) statusDot.style.background = '#ef4444';
          if (statusTxt) statusTxt.textContent = 'Ses kanalı çözümlenemedi: ' + (err && err.message || err);
          audioCtx.close();
        });
      };
      reader.readAsArrayBuffer(file);
    };
  });
});

// Video → Ses çıkar (arka planda, modül değiştirmeden)
async function videoExtractAudioSilent(onProgress) {
  if (!videoState.audioBuffer) return null;
  var wavBlob = await audioBufferToWavBlob(videoState.audioBuffer, onProgress);
  videoState.audioBlob = wavBlob;
  var wavFile = new File([wavBlob], videoState.file.name.replace(/\.[^.]+$/, '.wav'), { type: 'audio/wav' });

  // Global state'e yükle (pipeline bunları kullanır) — ama modül değiştirme
  _rawFileBlob = wavFile;
  state.audioBuffer = videoState.audioBuffer;
  _originalAudioBuffer = videoState.audioBuffer;
  state.fileName = wavFile.name;

  return wavFile;
}

// Eski fonksiyon — geriye uyumluluk (video sekmesinde kalır)
function videoExtractAndProcess() {
  switchVideoTab('audio');
  videoStartPipeline(true);
}

// AudioBuffer → WAV Blob
// Async/chunked AudioBuffer → WAV. Uzun dosyalar (2+ saat) tek sync loop ile
// ana thread'i 30+ dakika kilitliyordu — chunk'lara bölüp setTimeout(0) ile yield ediyoruz.
// onProgress(0..1) her chunk sonunda çağrılır, UI canlı kalır ve gerçek % gösterilebilir.
async function audioBufferToWavBlob(buffer, onProgress) {
  var numCh = buffer.numberOfChannels;
  var sr = buffer.sampleRate;
  var len = buffer.length;
  var bytesPerSample = 2;
  var dataLen = len * numCh * bytesPerSample;
  var bufferArr = new ArrayBuffer(44 + dataLen);
  var view = new DataView(bufferArr);

  function writeStr(offset, str) { for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); }

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * numCh * bytesPerSample, true);
  view.setUint16(32, numCh * bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataLen, true);

  var channels = [];
  for (var ch = 0; ch < numCh; ch++) channels.push(buffer.getChannelData(ch));

  var offset = 44;
  var CHUNK = 500000; // 500K sample/chunk → ~50ms iş, yield arası
  var i = 0;
  if (onProgress) onProgress(0);
  while (i < len) {
    var endI = Math.min(i + CHUNK, len);
    for (; i < endI; i++) {
      for (var ch = 0; ch < numCh; ch++) {
        var s = Math.max(-1, Math.min(1, channels[ch][i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
      }
    }
    if (onProgress) onProgress(i / len);
    // Yield to event loop — UI render + log update için fırsat ver
    await new Promise(function(r) { setTimeout(r, 0); });
  }
  if (onProgress) onProgress(1);
  return new Blob([bufferArr], { type: 'audio/wav' });
}

// Ekran görüntüsü al
function videoScreenshot() {
  var player = document.getElementById('video-player');
  if (!player || player.readyState < 2) return alert('Video henüz yüklenmedi');
  var canvas = document.createElement('canvas');
  canvas.width = player.videoWidth;
  canvas.height = player.videoHeight;
  canvas.getContext('2d').drawImage(player, 0, 0);
  canvas.toBlob(function(blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (videoState.file ? videoState.file.name.replace(/\.[^.]+$/, '') : 'screenshot') + '_' + formatDuration(player.currentTime).replace(':','-') + '.png';
    a.click();
    URL.revokeObjectURL(a.href);
  }, 'image/png');
}

// Video pipeline — ses çıkar ve pipeline'ı video sekmesinde çalıştır
async function videoStartPipeline(forceRestart) {
  if (!videoState.audioBuffer) return alert('Önce video yükleyin');

  var dot = document.getElementById('video-audio-status-dot');
  var txt = document.getElementById('video-audio-status-text');
  var logEl = document.getElementById('video-pipeline-log');
  if (dot) dot.style.background = '#fbbf24';
  if (txt) txt.textContent = 'Ses çıkarılıyor...';

  // Kesim alanını göster
  var cutArea = document.getElementById('video-cut-area');
  if (cutArea) cutArea.style.display = 'block';
  var cutStatus = document.getElementById('video-cut-status');
  if (cutStatus) cutStatus.textContent = 'Pipeline çalışıyor...';

  vLog('🎵 Videodan ses çıkarılıyor...', '#38bdf8');
  vLog('📁 ' + (videoState.file ? videoState.file.name : '?'), '#94a3b8');

  // Uzun videolar için WAV oluşturma süreci dakikalar sürebilir — kullanıcıya neden
  // beklediğini göstermek için canlı satır + üst durum çubuğunu güncelle.
  var _wavDur = videoState.audioBuffer ? formatDuration(videoState.audioBuffer.duration) : '?';
  vLog('⏳ WAV verisi hazırlanıyor (' + _wavDur + ' uzunluk) — büyük dosyalarda dakikalar sürebilir...', '#fbbf24');
  var _wavLiveId = 'wav-conv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  if (logEl) {
    logEl.innerHTML += '<div id="' + _wavLiveId + '" style="color:#fbbf24"></div>';
    logEl.scrollTop = logEl.scrollHeight;
  }
  var _wavStartMs = Date.now();
  // Sesi arka planda global state'e yükle
  var wavFile = await videoExtractAudioSilent(function(pct) {
    var liveEl = document.getElementById(_wavLiveId);
    var elapsed = (Date.now() - _wavStartMs) / 1000;
    var em = Math.floor(elapsed / 60);
    var es = Math.floor(elapsed % 60);
    var elapsedStr = em > 0 ? em + 'dk ' + (es < 10 ? '0' : '') + es + 'sn' : es + 'sn';
    var pctInt = Math.round(pct * 100);
    if (liveEl) {
      liveEl.textContent = '[' + new Date().toLocaleTimeString('tr') + '] ⏳ WAV hazırlanıyor %' + pctInt + ' (geçen ' + elapsedStr + ')';
    }
    if (txt) txt.textContent = 'WAV hazırlanıyor %' + pctInt + ' (' + elapsedStr + ')';
  });
  // Final durumu canlı satıra yaz
  var _wavLiveFinal = document.getElementById(_wavLiveId);
  if (_wavLiveFinal) {
    var _elTotal = Math.round((Date.now() - _wavStartMs) / 1000);
    var _emT = Math.floor(_elTotal / 60);
    var _esT = _elTotal % 60;
    var _elStr = _emT > 0 ? _emT + 'dk ' + (_esT < 10 ? '0' : '') + _esT + 'sn' : _esT + 'sn';
    _wavLiveFinal.style.color = '#4ade80';
    _wavLiveFinal.textContent = '[' + new Date().toLocaleTimeString('tr') + '] ✓ WAV hazırlandı (' + _elStr + ')';
  }
  if (!wavFile) return;

  vLog('✅ Ses çıkarıldı: ' + videoState.audioBuffer.numberOfChannels + ' kanal, ' + formatDuration(videoState.audioBuffer.duration), '#4ade80');
  if (dot) dot.style.background = '#4ade80';
  if (txt) txt.textContent = 'Ses çıkarıldı — Pipeline başlatılıyor...';

  // Video pipeline kendi state'ini tutar — ses modülü DB'sine dokunmaz
  // Eğer aynı video için daha önce adımlar tamamlandıysa, kaldığı yerden devam et
  // [v2] Adım sırası değişti (Normalize/DeepFilter VAD/Diarize'dan ÖNCE).
  // Eski cache (v1 veya damga yok) yüklenirse adım numaraları yanlış olur → sıfırla.
  var VIDEO_PIPELINE_VERSION = 'v2';
  var videoFileName = videoState.file ? videoState.file.name : '';
  var savedVideoState = JSON.parse(localStorage.getItem('video_pipeline_state') || 'null');
  if (savedVideoState && savedVideoState.version !== VIDEO_PIPELINE_VERSION) {
    vLog('⚠ Eski cache versiyonu (' + (savedVideoState.version || 'v1') + ') tespit edildi → sıfırlanıyor (yeni: ' + VIDEO_PIPELINE_VERSION + ')', '#fbbf24');
    // IndexedDB'deki video_step_* kayıtlarını da temizle (eski adım numaraları geçersiz)
    try {
      var dbCleanup = await openDB();
      var txCleanup = dbCleanup.transaction('step_audio', 'readwrite');
      var storeCleanup = txCleanup.objectStore('step_audio');
      for (var sn = 1; sn <= 10; sn++) {
        storeCleanup.delete('video_step_' + sn);
      }
      await new Promise(function(res, rej) { txCleanup.oncomplete = res; txCleanup.onerror = function(e) { rej(e.target.error); }; });
      dbCleanup.close();
    } catch(eCleanup) { vLog('⚠ Eski cache temizleme uyarısı: ' + eCleanup.message, '#f59e0b'); }
    savedVideoState = null;
  }
  if (!forceRestart && savedVideoState && savedVideoState.fileName === videoFileName && savedVideoState.completedSteps) {
    videoState._completedSteps = savedVideoState.completedSteps;
    videoState._cachedFiles = savedVideoState.cachedFiles || {};
    vLog('📂 Önceki ilerleme bulundu: ' + Object.keys(savedVideoState.completedSteps).length + ' adım tamamlanmış — kaldığı yerden devam ediliyor', '#38bdf8');
  } else {
    videoState._completedSteps = {};
    videoState._cachedFiles = {};
  }

  vLog('⚡ Pipeline başlatılıyor (bağımsız video pipeline)...', '#fbbf24');
  videoState._pipelineMode = true;

  var stepsEl = document.getElementById('video-pipeline-steps');
  if (stepsEl) stepsEl.innerHTML = '';
  // Adım butonları için event delegation — bir kez kur, bir daha kurma (idempotent)
  if (stepsEl && !stepsEl._vstepHandlerInstalled) {
    stepsEl._vstepHandlerInstalled = true;
    stepsEl.addEventListener('click', async function(ev) {
      var btn = ev.target.closest('[data-vstep-action]');
      if (!btn) return;
      var action = btn.getAttribute('data-vstep-action');
      var step = btn.getAttribute('data-vstep');
      try { await handleVStepAction(action, step, btn); }
      catch(e) { alert('Hata: ' + e.message); }
    });
  }

  // Bağımsız video pipeline — ses modülüne dokunmaz, doğrudan API çağırır
  var currentFile = wavFile;
  var totalSteps = 10;
  var stepsDone = 0;
  var _vCompleted = videoState._completedSteps || {};

  // ── Adım sonucu kaydetme/yükleme fonksiyonları ──
  async function _saveStepFile(stepNum, file) {
    try {
      var db = await openDB();
      var tx = db.transaction('step_audio', 'readwrite');
      var buf = await file.arrayBuffer();
      tx.objectStore('step_audio').put({ data: buf, name: file.name, type: file.type, size: file.size }, 'video_step_' + stepNum);
      await new Promise(function(res, rej) { tx.oncomplete = res; tx.onerror = function(e) { rej(e.target.error); }; });
      db.close();
      vLog('  💾 Adım ' + stepNum + ' kaydedildi (' + (file.size/1024/1024).toFixed(1) + ' MB)', '#64748b');
    } catch(e) { vLog('  ⚠ Adım ' + stepNum + ' kayıt hatası: ' + e.message, '#f59e0b'); }
  }

  async function _loadStepFile(stepNum) {
    try {
      var db = await openDB();
      var tx = db.transaction('step_audio', 'readonly');
      var saved = await new Promise(function(res, rej) {
        var req = tx.objectStore('step_audio').get('video_step_' + stepNum);
        req.onsuccess = function(e) { res(e.target.result); };
        req.onerror = function(e) { rej(e.target.error); };
      });
      db.close();
      if (saved && saved.data) {
        return new File([saved.data], saved.name || 'step_' + stepNum + '.mp3', { type: saved.type || 'audio/mpeg' });
      }
    } catch(e) {}
    return null;
  }

  // En son tamamlanan adımı bul (resume için)
  var lastCompletedStep = 0;
  for (var s = 10; s >= 1; s--) {
    if (_vCompleted[String(s)]) { lastCompletedStep = s; break; }
  }
  // [v2] Audio dosyasını yükle: Adım 8 (VAD), 9 (Diarize), 10 (Kesim haritası) audio değiştirmez,
  // bu adımlar sadece segment cache tutar. Bu durumlarda en son audio-yazan adımdan yükle.
  // Audio yazan adımlar: 1 (Whisper-orijinal), 2-5, 6 (Normalize), 7 (DeepFilter)
  if (lastCompletedStep > 0) {
    var audioStepCandidates = [7, 6, 5, 4, 3, 2, 1];
    var audioStepToLoad = 0;
    for (var i = 0; i < audioStepCandidates.length; i++) {
      var cand = audioStepCandidates[i];
      if (cand <= lastCompletedStep && _vCompleted[String(cand)]) {
        audioStepToLoad = cand;
        break;
      }
    }
    if (audioStepToLoad > 0) {
      var resumeFile = await _loadStepFile(audioStepToLoad);
      if (resumeFile) {
        currentFile = resumeFile;
        vLog('📂 Adım ' + audioStepToLoad + ' çıktısı yüklendi (' + (resumeFile.size/1024/1024).toFixed(1) + ' MB) — kaldığı yerden devam (son tamamlanan: adım ' + lastCompletedStep + ')', '#38bdf8');
      }
    }
  }

  // vStep — id'li / replace destekli adım göstergesi.
  // Aynı num ile tekrar çağrılırsa içeriği günceller (yeni satır eklemez).
  // text "✅" ile başlayan adımlar "tamamlandı" sayılır ve butonlar gösterilir.
  function vStep(num, text, color) {
    var c = color || '#4ade80';
    var stepId = 'vstep-row-' + String(num);
    var existing = stepsEl ? stepsEl.querySelector('#' + stepId) : null;
    var isFirst = !existing;
    if (isFirst) stepsDone++;

    var isDone = /^\s*✅/.test(text);
    var isErr  = /^\s*[✗⚠]/.test(text);
    var isSkip = /^\s*○/.test(text);

    // [v2] Butonlar sadece tamamlanan ses-içeren adımlarda gösterilir.
    // Adım 8 (VAD), 9 (Diarize), 10 (Kesim haritası) ses dosyası üretmez → onlarda ses butonu gösterme.
    var nStr = String(num);
    var hasAudio = isDone && nStr !== '8' && nStr !== '9' && nStr !== '10';
    var canResume = isDone && nStr !== '10';  // 10 sonrası adım yok
    var btnsHtml = '';
    if (hasAudio || canResume) {
      var btnStyle = 'background:rgba(255,255,255,0.04);border:1px solid #334155;border-radius:5px;cursor:pointer;font-size:11px;padding:3px 9px;margin-left:6px;white-space:nowrap';
      if (hasAudio) {
        btnsHtml =
          '<button data-vstep-action="audio-listen" data-vstep="' + num + '" style="' + btnStyle + ';color:#38bdf8" title="Bu adımdaki sesi dinle">🔊 Sesi Dinle</button>' +
          '<button data-vstep-action="audio-dl" data-vstep="' + num + '" style="' + btnStyle + ';color:#4ade80" title="Bu adımdaki sesi indir">⬇ Sesi İndir</button>' +
          '<button data-vstep-action="video-watch" data-vstep="' + num + '" style="' + btnStyle + ';color:#a78bfa" title="Bu adımdaki sesle videoyu izle (~3-5 dk merge)">▶ Video İzle</button>' +
          '<button data-vstep-action="video-dl" data-vstep="' + num + '" style="' + btnStyle + ';color:#f59e0b" title="Bu adımdaki sesle videoyu indir (~3-5 dk merge)">💾 Video İndir</button>';
      }
      if (canResume) {
        btnsHtml += '<button data-vstep-action="resume-from" data-vstep="' + num + '" style="' + btnStyle + ';color:#fb923c" title="Bu adımın çıktısından itibaren sonraki seçili adımlara devam et">↺ Devam Et</button>';
      }
    }

    var rowHtml =
      '<div id="' + stepId + '" data-vstep-row="' + num + '" style="padding:8px 12px;background:rgba(255,255,255,0.03);border-left:3px solid ' + c + ';border-radius:4px;font-size:12px;color:' + c + ';display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<span style="flex:1;min-width:200px">' + text + '</span>' +
        (btnsHtml ? '<div style="display:flex;gap:4px;flex-wrap:wrap">' + btnsHtml + '</div>' : '') +
      '</div>';

    if (existing) {
      // Replace mevcut satırı (insertAdjacentHTML ile)
      existing.outerHTML = rowHtml;
    } else if (stepsEl) {
      stepsEl.insertAdjacentHTML('beforeend', rowHtml);
    }

    if (txt) txt.textContent = 'İşleniyor (' + stepsDone + '/' + totalSteps + ')';
    vLog(text, c);
  }

  try {
    // Checkbox durumlarını oku
    var chkWhisper = document.getElementById('vp-chk-whisper')?.checked !== false;
    var chkDemucs  = document.getElementById('vp-chk-demucs')?.checked !== false;
    var chkNR      = document.getElementById('vp-chk-nr')?.checked !== false;
    var chkDNS64   = document.getElementById('vp-chk-dns64')?.checked !== false;
    var chkSpeechOnly = document.getElementById('vp-chk-speechonly')?.checked !== false;
    var chkVAD     = document.getElementById('vp-chk-vad')?.checked !== false;
    var chkDiarize = document.getElementById('vp-chk-diarize')?.checked !== false;
    var chkNormalize = document.getElementById('vp-chk-normalize')?.checked !== false;
    var chkCut     = document.getElementById('vp-chk-cut')?.checked !== false;
    var chkDeepFilter = document.getElementById('vp-chk-deepfilter')?.checked === true;

    // State kaydetme fonksiyonu
    function _saveVideoState() {
      localStorage.setItem('video_pipeline_state', JSON.stringify({
        version: VIDEO_PIPELINE_VERSION,
        fileName: videoFileName,
        completedSteps: _vCompleted,
        timestamp: Date.now()
      }));
    }

    // ── 1. Whisper Transkript ──
    if (!chkWhisper) {
      vStep(1, '○ 1. Adım — Whisper atlandı', '#64748b');
    } else if (_vCompleted['1']) {
      vStep(1, '✅ 1. Adım — Transkript (önbellekten) ✓', '#4ade80');
      videoState.transcriptSegments = _vCompleted['1'].transcriptSegments;
    } else {
      vStep(1, '⏳ 1. Adım — Whisper transkript başlatılıyor...', '#f59e0b');
      var fd1 = new FormData();
      // Türkçe karakterli dosya adı Werkzeug'da Latin-1 patlatabilir → ASCII-safe ad
      var _safeName1 = (currentFile.name || 'audio.mp3').replace(/[^\x20-\x7E]/g, '_');
      fd1.append('file', currentFile, _safeName1);
      fd1.append('model', 'large');
      var r1 = await fetch('/api/transcribe/start', { method: 'POST', body: fd1 });
      var _rawTxt1 = await r1.text();
      if (!r1.ok) {
        var _snip1 = _rawTxt1.slice(0, 300).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        throw new Error('Whisper start HTTP ' + r1.status + ' ' + r1.statusText + ' — ' + (_snip1 || '(yanıt boş)'));
      }
      var d1;
      try { d1 = JSON.parse(_rawTxt1); }
      catch(_je1) { throw new Error('Whisper yanıtı JSON değil (HTTP ' + r1.status + '): ' + _rawTxt1.slice(0,300)); }
      if (!d1.success) throw new Error('Whisper başlatılamadı: ' + d1.error);
      var transcript = await new Promise(function(resolve, reject) {
        var timer = setInterval(async function() {
          try {
            var rs = await fetch('/api/transcribe/status/' + d1.job_id);
            var ds = await rs.json();
            if (ds.status === 'done') { clearInterval(timer); resolve(ds.result); }
            if (ds.status === 'error') { clearInterval(timer); reject(new Error(ds.error)); }
            if (ds.progress) vLog('  Whisper %' + ds.progress + (ds.seg_count ? ' (' + ds.seg_count + ' segment)' : ''), '#f59e0b');
          } catch(e) {}
        }, 2000);
      });
      videoState.transcriptSegments = transcript.segments;
      _vCompleted['1'] = { transcriptSegments: transcript.segments };
      _saveVideoState();
      await _saveStepFile(1, currentFile);
      vStep(1, '✅ 1. Adım — Transkript tamamlandı: ' + (transcript.segments?.length || 0) + ' segment', '#4ade80');
    }

    // ── 2. Demucs (Vokal İzolasyon) ──
    if (!chkDemucs) {
      vStep(2, '○ 2. Adım — Demucs atlandı', '#64748b');
    } else if (_vCompleted['2'] && lastCompletedStep >= 2) {
      vStep(2, '✅ 2. Adım — Vokal izolasyonu (önbellekten) ✓', '#4ade80');
    } else {
      vStep(2, '⏳ 2. Adım — Demucs vokal izolasyonu...', '#f59e0b');
      var fd2 = new FormData();
      // Türkçe karakterli dosya adı Werkzeug'da Latin-1 patlatabilir → ASCII-safe ad
      var _safeName2 = (currentFile.name || 'audio.mp3').replace(/[^\x20-\x7E]/g, '_');
      fd2.append('file', currentFile, _safeName2);
      fd2.append('stem', 'vocals');
      // Demucs GPU'da ses süresinin ~%10-15'i kadar sürer; uzun dosyalarda WAV→MP3 encode da eklenir.
      var _audioDur2 = videoState.audioBuffer ? videoState.audioBuffer.duration : 600;
      var _tick2 = _vTick('Demucs vokal izolasyonu', Math.max(120, _audioDur2 * 0.15));
      var r2;
      try {
        r2 = await pipeFetch('/api/denoise', { method: 'POST', body: fd2 });
      } catch(_eFetch) { _tick2.stop(false); throw _eFetch; }
      if (!r2.ok) {
        _tick2.stop(false);
        // Sunucu hata gövdesini oku — gerçek hata mesajını göster
        var _errTxt = '';
        try {
          var _ct = (r2.headers.get('content-type') || '').toLowerCase();
          if (_ct.indexOf('json') >= 0) {
            var _ej = await r2.json();
            _errTxt = _ej.error || JSON.stringify(_ej).slice(0, 400);
          } else {
            _errTxt = (await r2.text()).slice(0, 400);
          }
        } catch(_) {}
        throw new Error('Demucs hatası: HTTP ' + r2.status + (_errTxt ? ' — ' + _errTxt : ''));
      }
      var blob2 = await r2.blob();
      _tick2.stop(true);
      currentFile = new File([blob2], currentFile.name.replace(/\.[^.]+$/, '_vocals.mp3'), { type: 'audio/mpeg' });
      _vCompleted['2'] = true; _saveVideoState();
      await _saveStepFile(2, currentFile);
      vStep(2, '✅ 2. Adım — Vokal izolasyonu tamamlandı (' + (currentFile.size/1024/1024).toFixed(1) + ' MB)', '#4ade80');
    }

    // ── 3. NoiseReduce (async job) ──
    if (!chkNR) {
      vStep(3, '○ 3. Adım — NoiseReduce atlandı', '#64748b');
    } else if (_vCompleted['3'] && lastCompletedStep >= 3) {
      vStep(3, '✅ 3. Adım — NoiseReduce (önbellekten) ✓', '#4ade80');
    } else {
    vStep(3, '⏳ 3. Adım — Gürültü bastırma (NoiseReduce)...', '#f59e0b');
    var fd3 = new FormData();
    fd3.append('file', currentFile, currentFile.name);
    fd3.append('prop_decrease', '0.65');
    fd3.append('async', 'true');
    var r3 = await fetch('/api/denoise-nr', { method: 'POST', body: fd3 });
    var d3 = await r3.json();
    if (!d3.success) throw new Error('NoiseReduce başlatılamadı: ' + d3.error);
    await new Promise(function(resolve, reject) {
      var timer = setInterval(async function() {
        try {
          var pr = await fetch('/api/denoise-nr/progress/' + d3.job_id);
          var pd = await pr.json();
          if (pd.step) vLog('  NoiseReduce: %' + pd.pct + ' — ' + pd.step, '#f59e0b');
          if (pd.status === 'done') { clearInterval(timer); resolve(); }
          if (pd.status === 'error') { clearInterval(timer); reject(new Error(pd.error)); }
        } catch(e) {}
      }, 3000);
    });
    var r3dl = await fetch('/api/denoise-nr/download/' + d3.job_id);
    if (!r3dl.ok) throw new Error('NoiseReduce indirme hatası: HTTP ' + r3dl.status);
    var blob3 = await r3dl.blob();
    currentFile = new File([blob3], currentFile.name.replace(/\.[^.]+$/, '_nr.mp3'), { type: 'audio/mpeg' });
    _vCompleted['3'] = true; _saveVideoState();
    await _saveStepFile(3, currentFile);
    vStep(3, '✅ 3. Adım — Gürültü bastırma tamamlandı (' + (currentFile.size/1024/1024).toFixed(1) + ' MB)', '#4ade80');
    }

    // ── 4. DNS64 (Anlık Gürültü) ──
    if (!chkDNS64) {
      vStep(4, '○ 4. Adım — DNS64 atlandı', '#64748b');
    } else if (_vCompleted['4'] && lastCompletedStep >= 4) {
      vStep(4, '✅ 4. Adım — DNS64 (önbellekten) ✓', '#4ade80');
    } else {
      vStep(4, '⏳ 4. Adım — DNS64 anlık gürültü temizleme...', '#f59e0b');
      var _audioDur4 = videoState.audioBuffer ? videoState.audioBuffer.duration : 600;
      var _tick4 = _vTick('DNS64 gürültü temizleme', Math.max(60, _audioDur4 * 0.05));
      try {
        var fd4 = new FormData();
        fd4.append('file', currentFile, currentFile.name);
        var r4 = await pipeFetch('/api/enhance', { method: 'POST', body: fd4 }, 300000);
        if (!r4.ok) {
          _tick4.stop(false);
          vStep(4, '⚠ 4. Adım — DNS64 endpoint hatası, atlanıyor', '#f59e0b');
        } else {
          var blob4 = await r4.blob();
          _tick4.stop(true);
          currentFile = new File([blob4], currentFile.name.replace(/\.[^.]+$/, '_dns.mp3'), { type: 'audio/mpeg' });
          vStep(4, '✅ 4. Adım — DNS64 tamamlandı', '#4ade80');
        }
      } catch(e4) {
        _tick4.stop(false);
        vStep(4, '⚠ 4. Adım — DNS64 hatası: ' + e4.message + ', atlanıyor', '#f59e0b');
      }
    }
    if (!_vCompleted['4'] || lastCompletedStep < 4) { _vCompleted['4'] = true; _saveVideoState(); await _saveStepFile(4, currentFile); }

    // ── 5. SpeechOnly (Konuşma Dışı Sesleri Temizle) ──
    if (!chkSpeechOnly) {
      vStep(5, '○ 5. Adım — SpeechOnly atlandı', '#64748b');
    } else if (_vCompleted['5'] && lastCompletedStep >= 5) {
      vStep(5, '✅ 5. Adım — SpeechOnly (önbellekten) ✓', '#4ade80');
    } else {
      vStep(5, '⏳ 5. Adım — Konuşma dışı sesler temizleniyor...', '#f59e0b');
      try {
        var fd5s = new FormData();
        fd5s.append('file', currentFile, currentFile.name);
        fd5s.append('zero_out', 'true');  // Video pipeline: sessizliği sıfırla, süreyi koru (A/V sync)
        var r5s = await pipeFetch('/api/speech-only/start', { method: 'POST', body: fd5s }, 60000);
        if (r5s.ok) {
          var d5s = await r5s.json();
          if (d5s.job_id) {
            // Poll
            var soResult = await new Promise(function(resolve, reject) {
              var timer = setInterval(async function() {
                try {
                  var pr = await fetch('/api/speech-only/progress/' + d5s.job_id);
                  var pd = await pr.json();
                  if (pd.pct) vLog('  SpeechOnly: %' + pd.pct, '#f59e0b');
                  if (pd.status === 'done') { clearInterval(timer); resolve(d5s.job_id); }
                  if (pd.status === 'error') { clearInterval(timer); reject(new Error(pd.error)); }
                } catch(e) {}
              }, 3000);
            });
            // Download result
            var r5dl = await fetch('/api/speech-only/download/' + soResult);
            if (r5dl.ok) {
              var blob5s = await r5dl.blob();
              currentFile = new File([blob5s], currentFile.name.replace(/\.[^.]+$/, '_speech.mp3'), { type: 'audio/mpeg' });
              vStep(5, '✅ 5. Adım — Konuşma dışı sesler temizlendi (' + (currentFile.size/1024/1024).toFixed(1) + ' MB)', '#4ade80');
            } else {
              vStep(5, '⚠ 5. Adım — SpeechOnly indirme hatası', '#f59e0b');
            }
          } else {
            vStep(5, '⚠ 5. Adım — SpeechOnly job başlatılamadı', '#f59e0b');
          }
        } else {
          vStep(5, '⚠ 5. Adım — SpeechOnly endpoint hatası', '#f59e0b');
        }
      } catch(e5s) {
        vStep(5, '⚠ 5. Adım — SpeechOnly hatası: ' + e5s.message + ', atlanıyor', '#f59e0b');
      }
    }
    if (!_vCompleted['5'] || lastCompletedStep < 5) { _vCompleted['5'] = true; _saveVideoState(); await _saveStepFile(5, currentFile); }

    // ── 6. Ses Dengeleme (Normalize) ──
    // [v2] Eski sıra: 8. Normalize idi. Yeni sırada VAD/Diarize'dan ÖNCE,
    // çünkü VAD/Diarize kalitesini artırmak için ses temiz olmalı.
    if (!chkNormalize) {
      vStep(6, '○ 6. Adım — Ses dengeleme atlandı', '#64748b');
    } else if (_vCompleted['6'] && lastCompletedStep >= 6) {
      vStep(6, '✅ 6. Adım — Ses dengeleme (önbellekten) ✓', '#4ade80');
    } else {
      vStep(6, '⏳ 6. Adım — Ses seviyeleri dengeleniyor...', '#f59e0b');
      var _audioDur6 = videoState.audioBuffer ? videoState.audioBuffer.duration : 600;
      var _tick6 = _vTick('Ses seviyeleri dengeleniyor', Math.max(60, _audioDur6 * 0.05));
      try {
        var fd6n = new FormData();
        fd6n.append('audio', currentFile, currentFile.name);
        fd6n.append('segments', JSON.stringify([]));
        var r6n = await pipeFetch('/api/normalize-speakers', { method: 'POST', body: fd6n }, 600000);
        if (r6n.ok) {
          var blob6n = await r6n.blob();
          _tick6.stop(true);
          currentFile = new File([blob6n], currentFile.name.replace(/\.[^.]+$/, '_norm.mp3'), { type: 'audio/mpeg' });
          vStep(6, '✅ 6. Adım — Ses seviyeleri dengelendi (' + (currentFile.size/1024/1024).toFixed(1) + ' MB)', '#4ade80');
        } else {
          _tick6.stop(false);
          vStep(6, '⚠ 6. Adım — Normalize endpoint hatası, atlanıyor', '#f59e0b');
        }
      } catch(e6n) {
        _tick6.stop(false);
        vStep(6, '⚠ 6. Adım — Normalize hatası: ' + e6n.message + ', atlanıyor', '#f59e0b');
      }
    }
    if (!_vCompleted['6'] || lastCompletedStep < 6) { _vCompleted['6'] = true; _saveVideoState(); await _saveStepFile(6, currentFile); }

    // ── 7. DeepFilterNet (Derin Filtreleme) ──
    // [v2] Eski sıra: 10. DeepFilter idi. Şimdi VAD/Diarize'dan ÖNCE çalışıyor
    // ki VAD/Diarize tertemiz ses üzerinde çalışsın.
    if (!chkDeepFilter) {
      vStep(7, '○ 7. Adım — DeepFilter atlandı', '#64748b');
    } else if (_vCompleted['7'] && lastCompletedStep >= 7) {
      var df7Cached = await _loadStepFile(7);
      if (df7Cached) {
        currentFile = df7Cached;
        vStep(7, '✅ 7. Adım — DeepFilter (önbellekten) ' + (currentFile.size/1024/1024).toFixed(1) + ' MB ✓', '#4ade80');
      } else {
        vStep(7, '✅ 7. Adım — DeepFilter (önbellekten) ✓', '#4ade80');
      }
    } else {
      vStep(7, '⏳ 7. Adım — DeepFilterNet derin filtreleme...', '#f59e0b');
      var _audioDur7 = videoState.audioBuffer ? videoState.audioBuffer.duration : 600;
      var _tick7 = _vTick('DeepFilterNet derin filtreleme (GPU chunked)', Math.max(60, _audioDur7 * 0.1));
      try {
        var fd7df = new FormData();
        fd7df.append('file', currentFile, currentFile.name);
        var r7df = await pipeFetch('/api/deepfilter', { method: 'POST', body: fd7df });
        if (r7df.ok) {
          var blob7df = await r7df.blob();
          _tick7.stop(true);
          currentFile = new File([blob7df], currentFile.name.replace(/\.[^.]+$/, '_df.mp3'), { type: 'audio/mpeg' });
          _vCompleted['7'] = true; _saveVideoState();
          await _saveStepFile(7, currentFile);
          vStep(7, '✅ 7. Adım — DeepFilter tamamlandı (' + (currentFile.size/1024/1024).toFixed(1) + ' MB)', '#4ade80');
        } else {
          var _df7ErrTxt = '';
          try {
            var _df7Ct = (r7df.headers.get('content-type') || '').toLowerCase();
            if (_df7Ct.indexOf('json') >= 0) {
              var _df7Ej = await r7df.json();
              _df7ErrTxt = _df7Ej.error || JSON.stringify(_df7Ej).slice(0, 300);
            } else {
              _df7ErrTxt = (await r7df.text()).slice(0, 300);
            }
          } catch(_) {}
          _tick7.stop(false);
          vStep(7, '⚠ 7. Adım — DeepFilter HTTP ' + r7df.status + (_df7ErrTxt ? ' — ' + _df7ErrTxt : '') + ', atlanıyor', '#f59e0b');
        }
      } catch(e7df) {
        _tick7.stop(false);
        vStep(7, '⚠ 7. Adım — DeepFilter hatası: ' + e7df.message + ', atlanıyor', '#f59e0b');
      }
    }

    // ── 8. VAD ──
    // [v2] Eski sıra: 6. VAD idi. Şimdi DeepFilter sonrası — temiz ses üzerinde
    // VAD modeli yanlış pozitifleri (gürültü→konuşma) çok daha az yapar.
    var vadSegments = [];
    if (!chkVAD) {
      vStep(8, '○ 8. Adım — VAD atlandı', '#64748b');
    } else if (_vCompleted['8'] && _vCompleted['8'].vadSegments) {
      vadSegments = _vCompleted['8'].vadSegments;
      vStep(8, '✅ 8. Adım — VAD (önbellekten): ' + vadSegments.length + ' konuşma bölgesi ✓', '#4ade80');
    } else {
      vStep(8, '⏳ 8. Adım — VAD sessizlik haritası (temiz ses üzerinden)...', '#f59e0b');
      try {
        var fd8v = new FormData();
        fd8v.append('file', currentFile, currentFile.name);
        var r8v = await pipeFetch('/api/vad', { method: 'POST', body: fd8v }, 60000);
        if (r8v.ok) {
          var d8v = await r8v.json();
          if (d8v.job_id) {
            vadSegments = await new Promise(function(resolve, reject) {
              var timer = setInterval(async function() {
                try {
                  var pr = await fetch('/api/vad/progress/' + d8v.job_id);
                  var pd = await pr.json();
                  if (pd.pct) vLog('  VAD: %' + pd.pct, '#f59e0b');
                  if (pd.status === 'done') { clearInterval(timer); resolve(pd.segments || pd.result?.segments || []); }
                  if (pd.status === 'error') { clearInterval(timer); reject(new Error(pd.error)); }
                } catch(e) {}
              }, 2000);
            });
          } else if (d8v.segments) {
            vadSegments = d8v.segments;
          }
          vStep(8, '✅ 8. Adım — VAD: ' + vadSegments.length + ' konuşma bölgesi (temiz ses)', '#4ade80');
        } else {
          vStep(8, '⚠ 8. Adım — VAD endpoint hatası, atlanıyor', '#f59e0b');
        }
      } catch(e8v) {
        vStep(8, '⚠ 8. Adım — VAD hatası: ' + e8v.message + ', atlanıyor', '#f59e0b');
      }
    }
    _vCompleted['8'] = { vadSegments: vadSegments };
    _saveVideoState();

    // ── 9. Diarize ──
    // [v2] Eski sıra: 7. Diarize idi. Şimdi DeepFilter sonrası — pyannote temiz seste
    // konuşmacıları çok daha doğru ayırt eder.
    var diarizeSegments = [];
    if (!chkDiarize) {
      vStep(9, '○ 9. Adım — Diarize atlandı', '#64748b');
    } else if (_vCompleted['9'] && _vCompleted['9'].diarizeSegments) {
      diarizeSegments = _vCompleted['9'].diarizeSegments;
      vStep(9, '✅ 9. Adım — Diarize (önbellekten): ' + diarizeSegments.length + ' segment ✓', '#4ade80');
    } else {
      vStep(9, '⏳ 9. Adım — Konuşmacı tespiti (Diarize, temiz ses)...', '#f59e0b');
      try {
        var fd9d = new FormData();
        fd9d.append('file', currentFile, currentFile.name);
        var r9d = await pipeFetch('/api/diarize', { method: 'POST', body: fd9d }, 60000);
        if (r9d.ok) {
          var d9d = await r9d.json();
          if (d9d.job_id) {
            diarizeSegments = await new Promise(function(resolve, reject) {
              var timer = setInterval(async function() {
                try {
                  var pr = await fetch('/api/diarize/progress/' + d9d.job_id);
                  var pd = await pr.json();
                  if (pd.pct) vLog('  Diarize: %' + pd.pct, '#f59e0b');
                  if (pd.status === 'done') { clearInterval(timer); resolve(pd.segments || pd.result?.segments || []); }
                  if (pd.status === 'error') { clearInterval(timer); reject(new Error(pd.error)); }
                } catch(e) {}
              }, 2000);
            });
          }
          vStep(9, '✅ 9. Adım — Diarize: ' + diarizeSegments.length + ' segment (temiz ses)', '#4ade80');
        } else {
          vStep(9, '⚠ 9. Adım — Diarize endpoint hatası, atlanıyor', '#f59e0b');
        }
      } catch(e9d) {
        vStep(9, '⚠ 9. Adım — Diarize hatası: ' + e9d.message + ', atlanıyor', '#f59e0b');
      }
    }
    _vCompleted['9'] = { diarizeSegments: diarizeSegments };
    _saveVideoState();

    // ── 10. Kesim haritası oluştur ──
    // [v2] Eski sıra: 9. Kesim idi. Şimdi en sonda — temiz ses üzerinde hesaplanan
    // VAD+Diarize ile en doğru kesim noktaları belirlenir, drift yok.
    if (!chkCut) {
      vStep(10, '○ 10. Adım — Kesim atlandı', '#64748b');
    } else if (_vCompleted['10'] && _vCompleted['10'].cutSegments) {
      var cachedCuts = _vCompleted['10'].cutSegments;
      videoState.cutSegments = cachedCuts;
      if (typeof window._onPipelineCutsReady === 'function') window._onPipelineCutsReady(cachedCuts);
      var _cdc = cachedCuts.length;
      vStep(10, '✅ 10. Adım — Kesim haritası (önbellekten): ' + _cdc + ' sessiz bölge ✓', '#4ade80');
    } else {
      vStep(10, '⏳ 10. Adım — Kesim haritası oluşturuluyor...', '#f59e0b');
      var allSpeech = [];
      vadSegments.forEach(function(s) { allSpeech.push({ start: s.start, end: s.end }); });
      diarizeSegments.forEach(function(s) { allSpeech.push({ start: s.start, end: s.end }); });

      if (allSpeech.length > 0) {
        var totalDur = videoState.audioBuffer ? videoState.audioBuffer.duration : 0;
        // pad: her konuşma segmentinin başına ve sonuna eklenen nefes payı (sn).
        // 0.45s → bitişik segmentler arası <0.9s boşluk birleşir; daha uzun boşluklarda
        // sadece ortası kesilir, her iki tarafta 0.45s doğal duraklama kalır.
        var pad = 0.45;
        // minCut: bu süreden kısa kalan boşluklar kesilmez (geçişi yumuşatır).
        var minCut = 0.25;
        var padded = allSpeech.map(function(s) { return { start: Math.max(0, s.start - pad), end: Math.min(totalDur, s.end + pad) }; }).sort(function(a,b) { return a.start - b.start; });
        var merged = [padded[0]];
        for (var i = 1; i < padded.length; i++) {
          var last = merged[merged.length - 1];
          if (padded[i].start <= last.end) last.end = Math.max(last.end, padded[i].end);
          else merged.push(padded[i]);
        }
        var cutSegs = [];
        var cursor = 0;
        merged.forEach(function(seg) {
          if (seg.start > cursor + minCut) cutSegs.push({ action: 'delete', start: +cursor.toFixed(3), end: +seg.start.toFixed(3) });
          cursor = seg.end;
        });
        if (totalDur && cursor < totalDur - 0.05) cutSegs.push({ action: 'delete', start: +cursor.toFixed(3), end: +totalDur.toFixed(3) });

        videoState.cutSegments = cutSegs;
        if (typeof window._onPipelineCutsReady === 'function') window._onPipelineCutsReady(cutSegs);
        var delCount = cutSegs.length;
        var delDur = cutSegs.reduce(function(a,s) { return a + (s.end - s.start); }, 0);
        vStep(10, '✅ 10. Adım — Kesim haritası: ' + delCount + ' sessiz bölge (' + formatDuration(delDur) + ' kesilecek)', '#4ade80');
        _vCompleted['10'] = { cutSegments: cutSegs };
        _saveVideoState();
      } else {
        vStep(10, '⚠ 10. Adım — VAD/Diarize verisi yok, kesim yapılamadı', '#f59e0b');
      }
    }

    // Temiz ses dosyasını sakla
    videoState.cleanAudioFile = currentFile;
    _rawFileBlob = currentFile; // Temiz ses indirme için

    // Temiz sesi IndexedDB'ye kaydet (sayfa yenilense bile erişilebilir)
    try {
      var dbClean = await openDB();
      var audioBlob = await currentFile.arrayBuffer();
      var txClean = dbClean.transaction('step_audio', 'readwrite');
      txClean.objectStore('step_audio').put({ data: audioBlob, name: currentFile.name, type: currentFile.type }, 'video_clean_audio');
      await new Promise(function(res, rej) { txClean.oncomplete = res; txClean.onerror = function(e) { rej(e.target.error); }; });
      dbClean.close();
      vLog('💾 Temiz ses IndexedDB\'ye kaydedildi', '#4ade80');
    } catch(edb) {
      vLog('⚠ Temiz ses kayıt hatası: ' + edb.message, '#f59e0b');
    }

    if (dot) dot.style.background = '#4ade80';
    if (txt) txt.textContent = 'Pipeline tamamlandı!';
    if (cutStatus) cutStatus.textContent = 'Pipeline tamamlandı — videoyu kesebilirsiniz';
    vLog('═══ Video Pipeline Tamamlandı ═══', '#4ade80');

    // Butonları aktifle
    var dlBtn = document.getElementById('btn-video-cut-download');
    if (dlBtn) dlBtn.disabled = false;
    var dlAudioBtn = document.getElementById('btn-video-dl-audio-only');
    if (dlAudioBtn) dlAudioBtn.style.display = 'inline-block';

    // Kesim haritası varsa otomatik video kesim başlat
    if (videoState.cutSegments && videoState.cutSegments.length && videoState.file) {
      vLog('🎬 Video kesim otomatik başlatılıyor...', '#38bdf8');
      videoCutAndDownload();
    }

  } catch(e) {
    vLog('❌ Pipeline hatası: ' + e.message, '#ef4444');
    if (dot) dot.style.background = '#ef4444';
    if (txt) txt.textContent = 'Pipeline hatası: ' + e.message;
  }
}

// Claude Vision ile sahne analizi
async function videoAIAnalyze() {
  var player = document.getElementById('video-player');
  if (!player || player.readyState < 2) return alert('Önce video yükleyin');

  var resultsEl = document.getElementById('video-ai-results');
  var placeholderEl = document.getElementById('video-ai-placeholder');
  if (placeholderEl) placeholderEl.style.display = 'none';
  if (resultsEl) { resultsEl.style.display = 'block'; resultsEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim)">⏳ Sahneler analiz ediliyor...</div>'; }

  var duration = player.duration;
  var frameCount = Math.min(10, Math.max(3, Math.floor(duration / 10)));
  var frames = [];

  // Eşit aralıklarla frame yakala
  for (var i = 0; i < frameCount; i++) {
    var time = (duration / (frameCount + 1)) * (i + 1);
    frames.push(await captureFrameAtTime(player, time));
  }

  // Claude'a gönder
  try {
    var response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        features: {
          duration: duration,
          type: 'video_analysis',
          frames: frames,
          fileName: videoState.file ? videoState.file.name : 'video',
          resolution: player.videoWidth + 'x' + player.videoHeight,
          frameCount: frameCount
        }
      })
    });
    var data = await response.json();
    if (data.success && data.analysis) {
      videoState.sceneAnalysis = data.analysis;
      renderVideoAnalysis(data.analysis, frames);
    } else {
      resultsEl.innerHTML = '<div style="color:#ef4444;padding:20px">Analiz hatası: ' + (data.error || 'Bilinmeyen hata') + '</div>';
    }
  } catch(e) {
    resultsEl.innerHTML = '<div style="color:#ef4444;padding:20px">Bağlantı hatası: ' + e.message + '</div>';
  }
}

function captureFrameAtTime(video, time) {
  return new Promise(function(resolve) {
    var canvas = document.createElement('canvas');
    canvas.width = Math.min(640, video.videoWidth);
    canvas.height = Math.round(canvas.width * (video.videoHeight / video.videoWidth));

    var handler = function() {
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      var dataUrl = canvas.toDataURL('image/jpeg', 0.7);
      video.removeEventListener('seeked', handler);
      resolve({ time: time, image: dataUrl });
    };
    video.addEventListener('seeked', handler);
    video.currentTime = time;
  });
}

function renderVideoAnalysis(analysis, frames) {
  var el = document.getElementById('video-ai-results');
  if (!el) return;
  var html = '<div style="display:flex;flex-direction:column;gap:16px">';

  // Genel özet
  if (analysis.summary) {
    html += '<div style="background:rgba(168,85,247,0.08);border:1px solid rgba(168,85,247,0.3);border-radius:8px;padding:14px">' +
      '<div style="font-size:12px;font-weight:700;color:#c084fc;margin-bottom:6px">📋 Genel Özet</div>' +
      '<div style="font-size:12px;color:var(--text);line-height:1.6">' + analysis.summary + '</div></div>';
  }

  // Sahneler
  if (analysis.scenes && analysis.scenes.length > 0) {
    html += '<div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:4px">🎬 Sahne Listesi (' + analysis.scenes.length + ')</div>';
    analysis.scenes.forEach(function(scene, idx) {
      html += '<div style="background:var(--bg-mid);border:1px solid var(--border);border-radius:8px;padding:12px;display:flex;gap:12px;align-items:flex-start">' +
        '<div style="min-width:40px;text-align:center;color:#60a5fa;font-weight:700;font-size:16px">' + (idx + 1) + '</div>' +
        '<div style="flex:1">' +
          '<div style="font-size:12px;font-weight:600;color:var(--text)">' + (scene.title || 'Sahne ' + (idx + 1)) + '</div>' +
          '<div style="font-size:11px;color:var(--text-dim);margin-top:4px">' + (scene.description || '') + '</div>' +
          (scene.timestamp ? '<div style="font-size:10px;color:#475569;margin-top:4px">⏱ ' + scene.timestamp + '</div>' : '') +
        '</div></div>';
    });
  }

  // Tespit edilen objeler
  if (analysis.objects && analysis.objects.length > 0) {
    html += '<div style="font-size:13px;font-weight:700;color:var(--text);margin:8px 0 4px">🏷 Tespit Edilen Objeler</div>';
    html += '<div style="display:flex;flex-wrap:wrap;gap:6px">';
    analysis.objects.forEach(function(obj) {
      html += '<span style="padding:4px 10px;background:rgba(59,130,246,0.12);border:1px solid rgba(59,130,246,0.3);border-radius:12px;font-size:11px;color:#93c5fd">' + obj + '</span>';
    });
    html += '</div>';
  }

  html += '</div>';
  el.innerHTML = html;
}

// Altyazı (SRT) oluştur
function videoGenerateSRT() {
  if (!videoState.audioBuffer) return alert('Önce video yükleyin');

  // Transkript verisi var mı kontrol et (IndexedDB'den veya videoState'den)
  switchVideoTab('subtitle');
  var previewEl = document.getElementById('video-srt-preview');
  var placeholderEl = document.getElementById('video-srt-placeholder');

  // Önce ses modülüne yönlendir
  if (!videoState.transcriptSegments) {
    if (placeholderEl) {
      placeholderEl.style.display = 'block';
      placeholderEl.innerHTML = '<div style="font-size:32px;margin-bottom:12px;opacity:0.5">📝</div>' +
        'Transkript verisi bulunamadı.<br>' +
        '<b>Sesi Çıkar ve İşle</b> butonuna basarak önce Whisper transkriptini oluşturun.<br><br>' +
        '<button onclick="switchVideoTab(\'audio\'); videoStartPipeline(true);" style="padding:8px 16px;background:rgba(74,222,128,0.12);border:1px solid #22c55e;color:#4ade80;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600">🎵 Sesi Çıkar ve İşle</button>';
    }
    return;
  }

  var segments = videoState.transcriptSegments;
  var srt = '';
  segments.forEach(function(seg, idx) {
    srt += (idx + 1) + '\n';
    srt += srtTime(seg.start) + ' --> ' + srtTime(seg.end) + '\n';
    srt += seg.text.trim() + '\n\n';
  });

  videoState.srtData = srt;
  if (placeholderEl) placeholderEl.style.display = 'none';
  if (previewEl) {
    previewEl.style.display = 'block';
    previewEl.textContent = srt;
  }
  var dlBtn = document.getElementById('btn-video-download-srt');
  if (dlBtn) dlBtn.disabled = false;
}

function srtTime(seconds) {
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = Math.floor(seconds % 60);
  var ms = Math.round((seconds % 1) * 1000);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + ',' + String(ms).padStart(3, '0');
}

// ── Video Kesim — Pipeline'dan gelen cutSegments ile videoyu kes ───────────────
// Pipeline bittiğinde cutSegments'i videoState'e kaydet
function videoCaptureCurrentCuts() {
  // Pipeline state'inden cutSegments'i al
  try {
    var pipeEl = document.querySelector('#ng-post-pipeline');
    if (!pipeEl) return;
    // _pipe8Segs global değişkeninden veya pipeline state'inden al
    // Burada window._lastPipeCutSegments kullanıyoruz (pipeline sonunda set ediyoruz)
  } catch(e) {}
}

// cutSegments'tan keep bölgelerini hesapla
function computeKeepRegions(cutSegments, totalDuration) {
  if (!cutSegments || !cutSegments.length) return [{ start: 0, end: totalDuration }];

  var deletes = cutSegments
    .filter(function(s) { return s.action === 'delete'; })
    .sort(function(a, b) { return a.start - b.start; });

  if (!deletes.length) return [{ start: 0, end: totalDuration }];

  var keeps = [];
  var cursor = 0;
  deletes.forEach(function(d) {
    if (d.start > cursor + 0.01) {
      keeps.push({ start: cursor, end: d.start });
    }
    cursor = d.end;
  });
  if (cursor < totalDuration - 0.01) {
    keeps.push({ start: cursor, end: totalDuration });
  }
  return keeps;
}

// Video'yu kesim haritasına göre kes — FFmpeg backend
async function videoCutAndDownload() {
  var player = document.getElementById('video-player');
  if (!player || !videoState.file) return alert('Önce video yükleyin');

  // Zaten kesilmiş video bellekte varsa tekrar kesme, sadece indir
  if (videoState._cutVideoBlob) {
    var dlName = videoState.file.name.replace(/\.[^.]+$/, '') + '_kesilmis.mp4';
    var a = document.createElement('a');
    a.href = URL.createObjectURL(videoState._cutVideoBlob);
    a.download = dlName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    return;
  }

  // Önce bellekteki, yoksa localStorage'daki kesim verisini al
  var cuts = videoState.cutSegments;
  if (!cuts || !cuts.length) {
    try {
      var saved = JSON.parse(localStorage.getItem('video_pipeline_state') || '{}');
      if (saved.cutSegments && saved.cutSegments.length) cuts = saved.cutSegments;
    } catch(e) {}
  }
  if (!cuts || !cuts.length) return alert('Kesim verisi bulunamadı. Önce pipeline çalıştırın.');

  var keeps = computeKeepRegions(cuts, player.duration);
  if (!keeps.length) return alert('Tüm video kesilmiş — korunacak bölge yok');

  var statusEl = document.getElementById('video-cut-status');
  if (statusEl) statusEl.textContent = 'Video sunucuya yükleniyor...';

  // Canlı log satırı — tek bir DOM elemanını sürekli güncelliyoruz (yeni satır eklemiyoruz)
  var vcLogEl = document.getElementById('video-pipeline-log');
  var vcLiveId = 'vcut-live-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  var vcStartMs = Date.now();
  if (vcLogEl) {
    vLog('═══ Video Kesim Başladı ═══', '#38bdf8');
    vcLogEl.innerHTML += '<div id="' + vcLiveId + '" style="color:#fbbf24"></div>';
    vcLogEl.scrollTop = vcLogEl.scrollHeight;
  }
  function _vcLive(text, color) {
    var el = document.getElementById(vcLiveId);
    if (!el) return;
    el.style.color = color || '#fbbf24';
    var elapsed = Math.round((Date.now() - vcStartMs) / 1000);
    var em = Math.floor(elapsed / 60);
    var es = elapsed % 60;
    var elStr = em > 0 ? em + 'dk ' + (es < 10 ? '0' : '') + es + 'sn' : es + 'sn';
    el.textContent = '[' + new Date().toLocaleTimeString('tr') + '] ' + text + ' (geçen ' + elStr + ')';
    if (vcLogEl) vcLogEl.scrollTop = vcLogEl.scrollHeight;
  }
  _vcLive('⏳ Hazırlanıyor...');

  try {
    // Temiz sesi bul — bellekte, yoksa IndexedDB'den
    var cleanAudio = videoState.cleanAudioFile;
    if (!cleanAudio) {
      _vcLive('💾 Temiz ses IndexedDB\'den okunuyor...');
      try {
        var db = await openDB();
        var tx = db.transaction('step_audio', 'readonly');
        var saved = await new Promise(function(res, rej) {
          var req = tx.objectStore('step_audio').get('video_clean_audio');
          req.onsuccess = function(e) { res(e.target.result); };
          req.onerror = function(e) { rej(e.target.error); };
        });
        db.close();
        if (saved && saved.data) {
          cleanAudio = new File([saved.data], saved.name || 'temiz_ses.mp3', { type: saved.type || 'audio/mpeg' });
          if (statusEl) statusEl.textContent = 'Temiz ses IndexedDB\'den yüklendi';
          _vcLive('✓ Temiz ses yüklendi (' + (cleanAudio.size/1024/1024).toFixed(1) + ' MB)', '#4ade80');
        }
      } catch(e) {}
    }

    // Video dosyasını, temiz sesi ve keep bölgelerini sunucuya gönder
    if (statusEl) statusEl.textContent = 'Video + temiz ses sunucuya yükleniyor...';
    _vcLive('📤 Video sunucuya yükleniyor (' + (videoState.file.size/1024/1024).toFixed(0) + ' MB)...');
    var fd = new FormData();
    fd.append('file', videoState.file, videoState.file.name);
    fd.append('keep_regions', JSON.stringify(keeps));
    try {
      if (cleanAudio && cleanAudio.size > 0) {
        fd.append('clean_audio', cleanAudio, cleanAudio.name || 'temiz_ses.mp3');
      } else {
        if (statusEl) statusEl.textContent = 'Video sunucuya yükleniyor (orijinal ses kullanılacak)...';
        _vcLive('⚠ Temiz ses yok — orijinal ses kullanılacak', '#f59e0b');
      }
    } catch(e) {
      if (statusEl) statusEl.textContent = 'Video sunucuya yükleniyor (orijinal ses kullanılacak)...';
    }

    var r = await fetch('/api/video-cut', { method: 'POST', body: fd });
    var d = await r.json();
    if (!d.success) throw new Error(d.error);

    // Poll for progress — backend ffmpeg stderr parse ediyor, gerçek time/speed/fps döner
    if (statusEl) statusEl.textContent = 'Video kesiliyor...';
    var lastStep = '';
    await new Promise(function(resolve, reject) {
      var timer = setInterval(async function() {
        try {
          var pr = await fetch('/api/video-cut/progress/' + d.job_id);
          var pd = await pr.json();
          if (statusEl) statusEl.textContent = 'Video kesiliyor... %' + pd.pct + ' — ' + pd.step;
          // Step text değiştiyse log'a önemli geçişleri kalıcı sat olarak ekle (yeni faz vs.)
          if (pd.step && pd.step !== lastStep) {
            // Yeni faz mı? "Merge" / "Cut" gibi tamamen farklı kelimeyle başlıyorsa yeni satır aç
            var oldPhase = (lastStep.split(':')[0] || '').trim();
            var newPhase = (pd.step.split(':')[0] || '').trim();
            if (newPhase && newPhase !== oldPhase && lastStep !== '') {
              vLog('▸ Faz değişti: ' + newPhase, '#a78bfa');
            }
            lastStep = pd.step;
          }
          _vcLive('🎬 ' + (pd.step || '...') + ' — %' + (pd.pct || 0));
          if (pd.status === 'done') { clearInterval(timer); resolve(); }
          if (pd.status === 'error') { clearInterval(timer); reject(new Error(pd.error)); }
        } catch(e) {}
      }, 1500);
    });
    _vcLive('✓ Kesim tamamlandı, indirme başlıyor...', '#4ade80');

    // Download — blob olarak indir ve sakla
    if (statusEl) statusEl.textContent = 'Kesilmiş video indiriliyor...';
    var dlR = await fetch('/api/video-cut/download/' + d.job_id);
    if (!dlR.ok) throw new Error('İndirme hatası: HTTP ' + dlR.status);
    var videoBlob = await dlR.blob();
    videoState._cutVideoBlob = videoBlob;
    videoState._cutCompleted = true;

    // İndir
    var dlName = videoState.file.name.replace(/\.[^.]+$/, '') + '_kesilmis.mp4';
    var a = document.createElement('a');
    a.href = URL.createObjectURL(videoBlob);
    a.download = dlName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    if (statusEl) statusEl.textContent = 'Video indirildi! (' + (videoBlob.size / (1024*1024)).toFixed(1) + ' MB)';
    _vcLive('✅ Video indirildi (' + (videoBlob.size/1024/1024).toFixed(1) + ' MB)', '#4ade80');
    vLog('═══ Video Kesim Tamamlandı ═══', '#4ade80');

  } catch(e) {
    if (statusEl) statusEl.textContent = 'Kesim hatası: ' + e.message;
    _vcLive('✗ Kesim hatası: ' + e.message, '#ef4444');
    vLog('❌ Video kesim hatası: ' + e.message, '#ef4444');
    alert('Video kesim hatası: ' + e.message);
  }
}

// Pipeline sonunda cutSegments'i videoState'e kaydetmek için hook
window._onPipelineCutsReady = function(cutSegments) {
  videoState.cutSegments = cutSegments;
  // [v2] Kesim haritasını localStorage'a kaydet (versiyon damgalı)
  try {
    var saved = JSON.parse(localStorage.getItem('video_pipeline_state') || '{}');
    saved.version = 'v2';
    saved.cutSegments = cutSegments;
    localStorage.setItem('video_pipeline_state', JSON.stringify(saved));
  } catch(e) {}
  // Kesim alanını göster
  var cutArea = document.getElementById('video-cut-area');
  if (cutArea) cutArea.style.display = 'block';
  var btn = document.getElementById('btn-video-cut-download');
  if (btn) btn.disabled = false;
  var dlAudioBtn = document.getElementById('btn-video-dl-audio-only');
  if (dlAudioBtn) dlAudioBtn.style.display = 'inline-block';

  var player = document.getElementById('video-player');
  var totalDur = player ? player.duration : 0;
  var keeps = computeKeepRegions(cutSegments, totalDur);
  var delCount = cutSegments.filter(function(s) { return s.action === 'delete'; }).length;
  var delDur = cutSegments.filter(function(s) { return s.action === 'delete'; }).reduce(function(a,s) { return a + (s.end - s.start); }, 0);
  var keepDur = totalDur - delDur;

  var statusEl = document.getElementById('video-cut-status');
  if (statusEl) statusEl.innerHTML = '<b>' + delCount + '</b> bölge kesilecek (<b>' + formatDuration(delDur) + '</b>) — <b>' + keeps.length + '</b> bölge korunacak (<b>' + formatDuration(keepDur) + '</b>)';

  // Kesim haritası görsel önizleme
  var previewEl = document.getElementById('video-cut-preview');
  if (previewEl && totalDur > 0) {
    var html = '<div style="display:flex;height:24px;border-radius:4px;overflow:hidden;border:1px solid var(--border)">';
    var cursor = 0;
    var allSegs = [];
    cutSegments.filter(function(s) { return s.action === 'delete'; }).sort(function(a,b) { return a.start - b.start; }).forEach(function(s) {
      if (s.start > cursor) allSegs.push({ type: 'keep', start: cursor, end: s.start });
      allSegs.push({ type: 'cut', start: s.start, end: s.end });
      cursor = s.end;
    });
    if (cursor < totalDur) allSegs.push({ type: 'keep', start: cursor, end: totalDur });

    allSegs.forEach(function(s) {
      var pct = ((s.end - s.start) / totalDur * 100).toFixed(2);
      var bg = s.type === 'keep' ? '#22c55e' : '#ef4444';
      var opacity = s.type === 'keep' ? '0.4' : '0.6';
      html += '<div title="' + formatDuration(s.start) + ' → ' + formatDuration(s.end) + ' (' + s.type + ')" style="width:' + pct + '%;background:' + bg + ';opacity:' + opacity + '"></div>';
    });
    html += '</div>';
    html += '<div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text-dim);margin-top:2px"><span>0:00</span><span style="display:flex;gap:12px"><span style="color:#22c55e">■ Korunan</span><span style="color:#ef4444">■ Kesilen</span></span><span>' + formatDuration(totalDur) + '</span></div>';
    previewEl.innerHTML = html;
  }
};

// Temizlenmiş sesi indir
function videoDownloadCleanAudio() {
  if (!_rawFileBlob) return alert('Pipeline henüz tamamlanmadı');
  var name = videoState.file ? videoState.file.name.replace(/\.[^.]+$/, '') + '_temiz_ses.mp3' : 'temiz_ses.mp3';
  var a = document.createElement('a');
  a.href = URL.createObjectURL(_rawFileBlob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function videoDownloadSRT() {
  if (!videoState.srtData) return alert('Önce SRT oluşturun');
  var name = videoState.file ? videoState.file.name.replace(/\.[^.]+$/, '') : 'video';
  var blob = new Blob([videoState.srtData], { type: 'text/srt' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name + '.srt';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Sekme geçişi ──────────────────────────────────────────────────────────────
function switchTrackTab(tab) {
  // track-tab-gate sabit görünür — sekme değil
  document.getElementById('track-tab-ai').style.display        = tab === 'ai'      ? 'flex' : 'none';
  document.getElementById('track-tab-tr-main').style.display   = tab === 'tr-main' ? 'flex' : 'none';
  document.getElementById('tab-ai-btn').classList.toggle('active',       tab === 'ai');
  document.getElementById('tab-tr-main-btn').classList.toggle('active',  tab === 'tr-main');
  if (tab === 'tr-main') _renderTrMainTabFromDB();
  if (tab === 'gate') openNoiseGateInline();
}

const LAYERS = [
  { id:'speaker',          name:'Konuşmacı Sesi',    color:'#4fc3f7' },
  { id:'background_noise', name:'Arka Plan Gürültüsü',color:'#ef5350' },
  { id:'breath_sounds',    name:'Nefes / Hapşırma',  color:'#ffa726' },
  { id:'ambient',          name:'Ortam / Fan',        color:'#66bb6a' },
  { id:'music',            name:'Arka Plan Müziği',   color:'#ab47bc' },
];

// ── Katman state başlat ────────────────────────────────────────────────────────
function initLayerState() {
  LAYERS.forEach(l => {
    state.layerState[l.id] = state.layerState[l.id] || { vol: 1, muted: false, soloed: false };
  });
}
initLayerState();

// Analiz verisinden her layer için segment listesi çıkar
function populateLayerSegments(analysis) {
  state.layerSegments = {};
  (analysis?.layers || []).forEach(layer => {
    state.layerSegments[layer.id] = (layer.segments || []).map(s => ({
      start: typeof s.start === 'number' ? s.start : parseFloat(s.start) || 0,
      end:   typeof s.end   === 'number' ? s.end   : parseFloat(s.end)   || 0,
    }));
  });
}

// t anında hangi gain değeri uygulanmalı?
function computeLayerGainAt(t) {
  const soloedLayers = LAYERS.filter(l => state.layerState[l.id]?.soloed);

  const inSegs = (id) => {
    const segs = state.layerSegments[id] || [];
    return segs.length === 0 || segs.some(s => t >= s.start && t <= s.end);
    // Boş segment = o layer'ın tüm ses boyunca aktif olduğu kabul edilir
  };

  if (soloedLayers.length > 0) {
    // Solo: sadece solo'lu layer'ların aktif olduğu anlarda ses çal
    const anyActive = soloedLayers.some(l => inSegs(l.id));
    if (!anyActive) return 0;
    return Math.max(...soloedLayers.filter(l => inSegs(l.id)).map(l => state.layerState[l.id].vol));
  }

  // Mute: en yüksek unmuted layer vol'ü
  const unmuted = LAYERS.filter(l => !state.layerState[l.id]?.muted && inSegs(l.id));
  if (unmuted.length === 0) return 0;  // Tüm covering layer'lar muted
  return Math.max(...unmuted.map(l => state.layerState[l.id]?.vol ?? 1));
}

const EVENT_COLORS = {
  sneeze:'#ffa726', cough:'#ef5350', thump:'#9c27b0',
  click:'#2196f3', keyboard:'#2196f3', mouse:'#2196f3',
  paper:'#4caf50', music:'#ab47bc', ambient:'#66bb6a',
  background:'#66bb6a', default:'#8b949e',
};

// Olay türü ve aksiyon Türkçe karşılıkları
const TYPE_TR = {
  sneeze:'hapşırık', cough:'öksürük', thump:'darbe', click:'tıklama',
  keyboard:'klavye', mouse:'fare', paper:'kağıt', music:'müzik',
  ambient:'ortam', background:'arka plan', breath:'nefes', silence:'sessizlik',
};
const ACTION_TR = {keep:'koru', delete:'sil', attenuate:'azalt', keep_check:'kontrol et'};
const CMD_ACTION_TR = {delete:'SİL', attenuate:'AZALT', keep:'KORU', normalize:'NORMALİZE', trim:'KIRP'};

// ── IndexedDB — session kalıcılığı ────────────────────────────────────────────
// Kaydedilen: ham dosya (ArrayBuffer) + meta
// Böylece F5 sonrası orijinal dosya arşivden decode edilir, yeniden yükleme gerekmez.
const DB_NAME = 'voicecraft', DB_STORE = 'session', DB_KEY = 'current';

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 9);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(DB_STORE))     db.createObjectStore(DB_STORE);
      if (!db.objectStoreNames.contains('transcripts')) db.createObjectStore('transcripts');
      if (!db.objectStoreNames.contains('diarize'))     db.createObjectStore('diarize');
      if (!db.objectStoreNames.contains('vad'))         db.createObjectStore('vad');
      if (!db.objectStoreNames.contains('projects'))    db.createObjectStore('projects');
      if (!db.objectStoreNames.contains('pipeline'))    db.createObjectStore('pipeline');
      if (!db.objectStoreNames.contains('step_audio'))  db.createObjectStore('step_audio');
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function clearAllDB() {
  try {
    const db     = await openDB();
    const stores = ['session', 'transcripts', 'diarize', 'vad', 'projects', 'pipeline', 'step_audio'];
    await Promise.all(stores.map(s => new Promise((res, rej) => {
      const tx = db.transaction(s, 'readwrite');
      const req = tx.objectStore(s).clear();
      tx.oncomplete = res;
      tx.onerror    = e => rej(e.target.error);
    })));
    addLog('ok', 'Tüm arşiv kayıtları silindi (session, transcripts, diarize, vad, projects)');
    return true;
  } catch(e) {
    addLog('error', 'Arşiv silme hatası: ' + e.message);
    return false;
  }
}

async function saveSessionToDB(rawArrayBuffer, fileName, fileSize) {
  try {
    const db   = await openDB();
    const data = { name: fileName, size: fileSize, raw: rawArrayBuffer };
    const tx   = db.transaction(DB_STORE, 'readwrite');
    const st   = tx.objectStore(DB_STORE);
    st.put(data, DB_KEY);                          // 'current' — hızlı erişim
    st.put(data, `${fileName}|${fileSize}`);       // per-file key — proje geri yükleme için
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = e => rej(e.target.error); });
    addLog('info', `Arşiv kaydedildi: ${fileName} (${(fileSize/1024/1024).toFixed(1)}MB)`);
  } catch(e) {
    addLog('warn', 'IndexedDB kayıt hatası: ' + e.message);
  }
}

async function loadSessionByKey(fileKey) {
  try {
    const db = await openDB();
    const tx = db.transaction(DB_STORE, 'readonly');
    return await new Promise((res, rej) => {
      const req = tx.objectStore(DB_STORE).get(fileKey);
      req.onsuccess = e => res(e.target.result || null);
      req.onerror   = e => rej(e.target.error);
    });
  } catch(e) { return null; }
}

async function loadSessionFromDB() {
  try {
    const db = await openDB();
    const tx = db.transaction(DB_STORE, 'readonly');
    return await new Promise((res, rej) => {
      const req = tx.objectStore(DB_STORE).get(DB_KEY);
      req.onsuccess = e => res(e.target.result || null);
      req.onerror   = e => rej(e.target.error);
    });
  } catch(e) { return null; }
}

// ── Diarize Arşivi (IndexedDB) ────────────────────────────────────────────────
async function saveDiarizeToDB(fileName, fileSize, data) {
  try {
    const db = await openDB();
    const tx = db.transaction('diarize', 'readwrite');
    tx.objectStore('diarize').put(data, `${fileName}|${fileSize}`);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = e => rej(e.target.error); });
  } catch(e) { addLog('warn', 'Diarize DB kayıt hatası: ' + e.message); }
}

// ── VAD Arşivi (IndexedDB) ────────────────────────────────────────────────────
async function saveVadToDB(fileName, fileSize, segments) {
  try {
    const db = await openDB();
    const tx = db.transaction('vad', 'readwrite');
    tx.objectStore('vad').put({ segments }, `${fileName}|${fileSize}`);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = e => rej(e.target.error); });
    addLog('info', `VAD arşive kaydedildi: ${segments.length} bölge`);
  } catch(e) { addLog('warn', 'VAD DB kayıt hatası: ' + e.message); }
}

async function loadVadFromDB(fileName, fileSize) {
  try {
    const db = await openDB();
    const tx = db.transaction('vad', 'readonly');
    return await new Promise((res, rej) => {
      const req = tx.objectStore('vad').get(`${fileName}|${fileSize}`);
      req.onsuccess = e => res(e.target.result || null);
      req.onerror   = e => rej(e.target.error);
    });
  } catch(e) { return null; }
}

// ── Pipeline Durum Arşivi (IndexedDB) ─────────────────────────────────────────

async function savePipelineStateToDB(state) {
  try {
    const db = await openDB();
    const tx = db.transaction('pipeline', 'readwrite');
    const store = tx.objectStore('pipeline');
    store.put(state, 'current');
    // Proje adıyla da kaydet — proje bazlı geri yükleme için
    const projName = state.projectName || _currentProjectName || localStorage.getItem('current_project_name') || '';
    if (projName) store.put(state, `proj__${projName}`);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = e => rej(e.target.error); });
  } catch(e) { /* sessiz */ }
}

async function loadPipelineStateFromDB(projectName) {
  try {
    const db = await openDB();
    const tx = db.transaction('pipeline', 'readonly');
    const key = projectName ? `proj__${projectName}` : 'current';
    return await new Promise((res, rej) => {
      const req = tx.objectStore('pipeline').get(key);
      req.onsuccess = e => res(e.target.result || null);
      req.onerror   = e => rej(e.target.error);
    });
  } catch(e) { return null; }
}

async function clearPipelineStateFromDB() {
  try {
    const db = await openDB();
    const tx = db.transaction('pipeline', 'readwrite');
    tx.objectStore('pipeline').delete('current');
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = e => rej(e.target.error); });
  } catch(e) { /* sessiz */ }
}

// ── Adım Ses Kayıtları (IndexedDB) ───────────────────────────────────────────
async function saveStepAudioToDB(projectName, stepNum, blob) {
  try {
    // arrayBuffer'ı transaction'dan ÖNCE hazırla (async bekleme tx'i kapatır)
    const ab = await blob.arrayBuffer();
    const db = await openDB();
    const tx = db.transaction('step_audio', 'readwrite');
    tx.objectStore('step_audio').put({
      audio: ab,
      name: blob.name || `step_${stepNum}.mp3`,
      type: blob.type || 'audio/mpeg',
      size: blob.size,
      step: String(stepNum),
      project: projectName,
      timestamp: Date.now()
    }, `${projectName}__step_${stepNum}`);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = e => rej(e.target.error); });
  } catch(e) { console.warn('Step audio kayıt hatası:', e.message); }
}

async function loadStepAudioFromDB(projectName, stepNum) {
  try {
    const db = await openDB();
    const tx = db.transaction('step_audio', 'readonly');
    return await new Promise((res, rej) => {
      const req = tx.objectStore('step_audio').get(`${projectName}__step_${stepNum}`);
      req.onsuccess = e => res(e.target.result || null);
      req.onerror   = e => rej(e.target.error);
    });
  } catch(e) { return null; }
}

async function loadAllStepAudiosFromDB(projectName) {
  try {
    const db = await openDB();
    const tx = db.transaction('step_audio', 'readonly');
    const store = tx.objectStore('step_audio');
    return await new Promise((res, rej) => {
      const all = store.getAll();
      all.onsuccess = () => {
        const items = (all.result || []).filter(r => r.project === projectName);
        res(items);
      };
      all.onerror = e => rej(e.target.error);
    });
  } catch(e) { return []; }
}

// ── Pipeline Rapor Sistemi ────────────────────────────────────────────────────
let _pipeReport = null;

function _initPipeReport(projectName, file) {
  _pipeReport = {
    projectName: projectName || file?.name || 'İsimsiz Proje',
    startTime: new Date(),
    endTime: null,
    originalFile: { name: file?.name || '', sizeMB: +(( file?.size||0)/1024/1024).toFixed(2), duration: 0 },
    finalFile:    { name: '', sizeMB: 0, duration: 0 },
    steps: [],
    cuts: [],
    speechSegments: [],
    noiseEvents: [],
    ollamaEvents: [],
  };
}

function _reportStep(stepId, stepName) {
  if (!_pipeReport) return null;
  const s = {
    id: String(stepId), name: stepName, status: 'running',
    startTime: new Date(), endTime: null,
    sizeBefore: +((_rawFileBlob?.size||0)/1024/1024).toFixed(2),
    sizeAfter: null,
    durBefore: +(state.audioBuffer?.duration||0).toFixed(1),
    durAfter: null,
    details: {}
  };
  _pipeReport.steps.push(s);
  return s;
}

function _reportStepDone(s, details = {}) {
  if (!s) return;
  s.status = 'done';
  s.endTime = new Date();
  s.sizeAfter = +((_rawFileBlob?.size||0)/1024/1024).toFixed(2);
  s.durAfter  = +(state.audioBuffer?.duration||0).toFixed(1);
  Object.assign(s.details, details);
}

function _reportStepSkip(stepId, stepName) {
  if (!_pipeReport) return;
  _pipeReport.steps.push({ id: String(stepId), name: stepName, status: 'skipped', startTime: new Date(), endTime: new Date(), sizeBefore:0, sizeAfter:0, durBefore:0, durAfter:0, details:{} });
}

function _reportStepResume(stepId, stepName) {
  if (!_pipeReport) return;
  _pipeReport.steps.push({ id: String(stepId), name: stepName, status: 'resumed', startTime: new Date(), endTime: new Date(), sizeBefore:0, sizeAfter:0, durBefore:0, durAfter:0, details:{} });
}

function _reportCuts(segs, reason) {
  if (!_pipeReport || !segs) return;
  segs.forEach(s => {
    if (s.action === 'delete') {
      _pipeReport.cuts.push({ start: +s.start.toFixed(3), end: +s.end.toFixed(3), dur: +(s.end-s.start).toFixed(3), reason });
    }
  });
}

function _reportOllama(original, cleaned) {
  if (!_pipeReport) return;
  _pipeReport.ollamaEvents.push({ time: new Date(), original, cleaned });
}

// ── Dalga Formu Görüntüsü (PDF için) ─────────────────────────────────────────
function _drawWaveformPng(audioBuffer, width, height, strokeColor) {
  if (!audioBuffer) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  // merkez çizgi
  ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, height/2); ctx.lineTo(width, height/2); ctx.stroke();
  // dalga
  const data = audioBuffer.getChannelData(0);
  const step = Math.ceil(data.length / width);
  const mid = height / 2;
  const amp = mid * 0.88;
  ctx.strokeStyle = strokeColor || '#1e40af'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < width; x++) {
    let mn = 0, mx = 0;
    for (let j = 0; j < step; j++) { const v = data[x*step+j]||0; if(v<mn)mn=v; if(v>mx)mx=v; }
    ctx.moveTo(x+0.5, mid - mx*amp);
    ctx.lineTo(x+0.5, mid - mn*amp);
  }
  ctx.stroke();
  return canvas.toDataURL('image/png');
}

// ── Transkript Excel Export / Import ─────────────────────────────────────────
function _exportTranscriptExcel() {
  const segs = _ngTranscript?.segments;
  if (!segs?.length) { alert('Transkript yok. Önce Whisper adımını çalıştırın.'); return; }
  if (typeof XLSX === 'undefined') { alert('SheetJS yüklenmedi — internet bağlantısını kontrol edin.'); return; }
  const rows = segs.map((s, i) => ({
    '#': i + 1,
    'Başlangıç (s)': +parseFloat(s.start).toFixed(3),
    'Bitiş (s)':     +parseFloat(s.end).toFixed(3),
    'Süre (s)':      +(s.end - s.start).toFixed(3),
    'Konuşmacı':     (s.speaker || '').replace('SPEAKER_', 'K'),
    'Metin':         (s.text || '').trim(),
    'Sil':           0
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{wch:4},{wch:14},{wch:14},{wch:10},{wch:12},{wch:65},{wch:6}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Transkript');
  const name = (_currentProjectName || 'transkript').replace(/[\\/:*?"<>|]/g, '_');
  XLSX.writeFile(wb, `${name}_transkript.xlsx`);
}

async function _importTranscriptExcel(file) {
  if (typeof XLSX === 'undefined') { alert('SheetJS yüklenmedi.'); return; }
  try {
    const data = await file.arrayBuffer();
    const wb = XLSX.read(data);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);
    const toDelete = rows.filter(r => {
      const v = r['Sil'];
      return v === 1 || v === '1' || v === true ||
             String(v).toLowerCase() === 'true' ||
             String(v).toLowerCase() === 'evet';
    });
    if (!toDelete.length) {
      alert('Silinecek satır bulunamadı.\n"Sil" sütununa 1 yazılan satırlar silinir.'); return;
    }
    const segs = toDelete.map(r => ({
      action: 'delete',
      start: parseFloat(r['Başlangıç (s)'] ?? r['Başlangıç'] ?? 0),
      end:   parseFloat(r['Bitiş (s)']    ?? r['Bitiş']    ?? 0)
    })).filter(s => s.end > s.start && s.start >= 0);
    if (!segs.length) { alert('Geçerli zaman damgası bulunamadı.'); return; }
    const totalSec = segs.reduce((a, s) => a + (s.end - s.start), 0).toFixed(1);
    if (!confirm(`${segs.length} segment silinecek (toplam ${totalSec}s).\nDevam edilsin mi?`)) return;
    const btn = document.createElement('button');
    await applyAndDownload(segs, btn);
  } catch(e) { alert('Excel okuma hatası: ' + e.message); }
}

// ── Proje Arşivi (IndexedDB) ──────────────────────────────────────────────────
let _currentProjectName = '';   // aktif proje adı — Son Hali İndir dosya adı için

async function saveProjectToDB(name, fileKey, stages) {
  try {
    const db = await openDB();
    // Aynı isim VEYA aynı fileKey için mevcut proje var mı kontrol et
    const all = await loadAllProjectsFromDB();
    const existing = all.find(p => p.name === name) || all.find(p => p.fileKey === fileKey);
    const id = existing ? existing.id : 'proj_' + Date.now();
    const tx = db.transaction('projects', 'readwrite');
    tx.objectStore('projects').put({ id, name, fileKey, stages, updatedAt: Date.now(), createdAt: existing?.createdAt || Date.now() }, id);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = e => rej(e.target.error); });
    addLog('info', `Proje kaydedildi: "${name}"`);
  } catch(e) { addLog('warn', 'Proje DB kayıt hatası: ' + e.message); }
}

async function loadAllProjectsFromDB() {
  try {
    const db = await openDB();
    const tx = db.transaction('projects', 'readonly');
    return await new Promise((res, rej) => {
      const req = tx.objectStore('projects').getAll();
      req.onsuccess = e => res(e.target.result || []);
      req.onerror   = e => rej(e.target.error);
    });
  } catch(e) { return []; }
}

async function deleteProjectFromDB(id) {
  try {
    const db = await openDB();
    const tx = db.transaction('projects', 'readwrite');
    tx.objectStore('projects').delete(id);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = e => rej(e.target.error); });
  } catch(e) { addLog('warn', 'Proje silme hatası: ' + e.message); }
}

async function loadDiarizeFromDB(fileName, fileSize) {
  try {
    const db = await openDB();
    const tx = db.transaction('diarize', 'readonly');
    return await new Promise((res, rej) => {
      const req = tx.objectStore('diarize').get(`${fileName}|${fileSize}`);
      req.onsuccess = e => res(e.target.result || null);
      req.onerror   = e => rej(e.target.error);
    });
  } catch(e) { return null; }
}

// ── Transkript Arşivi ─────────────────────────────────────────────────────────
function _fileKey() {
  if (!_rawFileBlob) return null;
  return _rawFileBlob.name + '|' + _rawFileBlob.size;
}

async function saveTranscriptToDB(result) {
  // Video modülüne transkript bildir (SRT oluşturma için)
  if (result && result.segments && result.segments.length && typeof videoState !== 'undefined') {
    videoState.transcriptSegments = result.segments;
  }
  const key = _fileKey();
  if (!key) return;
  try {
    const db = await openDB();
    const tx = db.transaction('transcripts', 'readwrite');
    const store = tx.objectStore('transcripts');
    store.put(result, key);
    // Proje adıyla da kaydet — pipeline sonrası dosya boyutu değişse bile bulunabilsin
    const projName = (typeof _currentProjectName !== 'undefined' && _currentProjectName)
      || localStorage.getItem('current_project_name') || '';
    if (projName) store.put(result, 'proj__' + projName);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = e => rej(e.target.error); });
    addLog('ok', `Transkript arşive kaydedildi — ${_rawFileBlob.name}`);
  } catch(e) { addLog('warn', 'Transkript kayıt hatası: ' + e.message); }
}

async function loadTranscriptFromDB() {
  try {
    const db = await openDB();
    const tx = db.transaction('transcripts', 'readonly');
    const store = tx.objectStore('transcripts');
    // 1) Dosya key ile dene
    const key = _fileKey();
    if (key) {
      const r1 = await new Promise(r => { const req = store.get(key); req.onsuccess = e => r(e.target.result || null); req.onerror = () => r(null); });
      if (r1?.segments?.length) return r1;
    }
    // 2) Proje adı ile dene
    const projName = (typeof _currentProjectName !== 'undefined' && _currentProjectName)
      || localStorage.getItem('current_project_name') || '';
    if (projName) {
      const r2 = await new Promise(r => { const req = store.get('proj__' + projName); req.onsuccess = e => r(e.target.result || null); req.onerror = () => r(null); });
      if (r2?.segments?.length) return r2;
    }
    return null;
  } catch(e) { return null; }
}

async function deleteTranscriptFromDB() {
  const key = _fileKey();
  if (!key) return;
  try {
    const db = await openDB();
    const tx = db.transaction('transcripts', 'readwrite');
    tx.objectStore('transcripts').delete(key);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = e => rej(e.target.error); });
    addLog('info', 'Transkript arşivden silindi');
  } catch(e) { addLog('warn', 'Transkript silme hatası: ' + e.message); }
}

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const fileInput    = $('file-input');
const btnAnalyze   = $('btn-analyze');
const btnPlay      = $('btn-play');
const btnStop      = $('btn-stop');
const btnSkipStart = $('btn-skip-start');
const btnRewind    = $('btn-rewind');
const btnFfwd      = $('btn-ffwd');
const btnZoomFit   = $('btn-zoom-fit');
const btnAiToggle  = $('btn-ai-toggle');
const aiPanel      = $('ai-panel');
const tracksList   = $('tracks-list');
const emptyState   = $('empty-state');
const rulerCanvas  = $('ruler-canvas');
const rulerWrap    = $('ruler-canvas-wrap');
const timeDisplay  = $('time-display');
const selStart     = $('sel-start');
const selEnd       = $('sel-end');
const statusDot    = $('status-dot');
const statusMain   = $('status-main');
const statusExtra  = $('status-extra');
const loadingOvl   = $('loading-overlay');
const ldText       = $('ld-text');
const ldSub        = $('ld-sub');
const dragOvl      = $('drag-overlay');
const infoFile     = $('info-file');
const infoMeta     = $('info-meta');
const vuLFill      = $('vu-l-fill');
const vuRFill      = $('vu-r-fill');
const aiStatusBadge= $('ai-status-badge');
const analysisCards= $('analysis-cards');
const analysisPlPh = $('analysis-placeholder');
const noEventsMsg  = $('no-events-msg');
const eventsList   = $('events-list');
const cmdTextarea  = $('cmd-textarea');
const btnSendCmd   = $('btn-send-cmd');
const cmdResult        = $('cmd-result');
const btnCleanDownload = $('btn-clean-download');
const btnNoiseGate     = $('btn-noise-gate');

// ── Proje Manager Hook'ları ───────────────────────────────────────────────────
// project-manager.js dosya seçilince bu hook'u çağırır
window.onAudioFileReady = function(file) {
  loadFile(file);
};

// project-manager.js proje yüklenince bu hook'u çağırır
window.onProjectLoaded = async function(project) {
  _currentProjectName = project.name || '';
  localStorage.setItem('current_project_name', _currentProjectName);
  // Projenin pipeline state'ini 'current' olarak kopyala
  const projState = await loadPipelineStateFromDB(_currentProjectName);
  if (projState) {
    await savePipelineStateToDB({ ...projState, projectName: _currentProjectName });
    addLog('info', `Proje "${project.name}": ${projState.doneSteps?.length || 0} adım tamamlanmış`);
  } else {
    addLog('info', `Proje ayarları yüklendi: "${project.name}"`);
  }
  // Pipeline panelini aç
  setTimeout(() => {
    if (typeof openNoiseGateInline === 'function') openNoiseGateInline();
  }, 500);
};

// project-manager.js yeni proje oluştururken bu hook'u çağırır
window.onNewProject = function() {
  _rawFileBlob = null;
  state.audioBuffer = null; state.analysis = null; state.fileName = null;
  state.layerState = {}; state.layerSegments = {};
  _currentProjectName = '';
  localStorage.removeItem('current_project_name');
  localStorage.removeItem('ng_settings');
  if (emptyState) emptyState.style.display = '';
  if (tracksList) tracksList.innerHTML = '';
  setStatus('Yeni proje başlatıldı', 'idle');
  addLog('info', 'Yeni proje başlatıldı — tüm ayarlar sıfırlandı.');
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatTime(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms= Math.floor((sec % 1) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad3(ms)}`;
}
function formatBig(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${pad2(h)} h ${pad2(m)} m ${pad2(s)} s`;
}
const pad2 = n => String(n).padStart(2,'0');
const pad3 = n => String(n).padStart(3,'0');

function setStatus(txt, mode='idle') {
  statusMain.textContent = txt;
  statusDot.className = 'status-dot' +
    (mode==='active' ? '' : mode==='busy' ? ' busy' : ' waiting');
}
function setExtra(txt) { statusExtra.textContent = txt; }

const ldProgressBar = $('ld-progress-bar');
const ldPercent     = $('ld-percent');
let _progressTimer  = null;

function showLoading(t, s) {
  if (ldText) ldText.textContent = t;
  if (ldSub)  ldSub.textContent  = s;
  setProgress(0, '');
  loadingOvl.classList.add('show');
}
function hideLoading() {
  loadingOvl.classList.remove('show');
  if (_progressTimer) { clearInterval(_progressTimer); _progressTimer = null; }
  setProgress(0, '');
}
function setProgress(pct, label) {
  ldProgressBar.style.width = pct + '%';
  ldPercent.textContent = label !== undefined ? label : (pct > 0 ? pct + '%' : '');
}
function startElapsedTimer(label) {
  if (_progressTimer) clearInterval(_progressTimer);
  const t0 = Date.now();
  _progressTimer = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    ldPercent.textContent = `${label} ${s}s geçti...`;
    // fake progress: quickly to 30%, then slow creep
    const fakePct = Math.min(95, s < 10 ? s * 3 : 30 + (s - 10) * 0.5);
    ldProgressBar.style.width = fakePct + '%';
  }, 1000);
}

function showErrorBanner(msg) {
  let banner = document.getElementById('error-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'error-banner';
    banner.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#c62828;color:#fff;padding:12px 20px;border-radius:8px;font-size:13px;z-index:9999;max-width:600px;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,0.4);cursor:pointer;';
    banner.title = 'Kapatmak için tıkla';
    banner.addEventListener('click', () => banner.remove());
    document.body.appendChild(banner);
  }
  banner.textContent = msg;
  clearTimeout(banner._t);
  banner._t = setTimeout(() => banner.remove(), 10000);
}

// ── Global JS hata yakalayıcı ──────────────────────────────────────────────────
window.onerror = (msg, src, line, col, err) => {
  console.error('[JS Error]', msg, src, line, col);
  try { addLog('error', `JS Hatası: ${msg}`, `${src}:${line}:${col}\n${err?.stack||''}`); } catch(e) {}
};
window.addEventListener('unhandledrejection', e => {
  console.error('[Unhandled Promise]', e.reason);
  try { addLog('error', `Promise hatası: ${e.reason?.message || e.reason}`, e.reason?.stack || ''); } catch(ex) {}
});

// ── Floating Log Helper (index.html'deki float-log-list'e yazar) ──────────────
function _floatLog(level, msg, detail) {
  try {
    const list = document.getElementById('float-log-list');
    if (!list) return;
    const COLORS = { error:'#ef5350', warn:'#ffa726', info:'#4fc3f7', ok:'#66bb6a' };
    const color  = COLORS[level] || '#8b949e';
    const icon   = level==='error'?'✖':level==='warn'?'⚠':level==='ok'?'✔':'ℹ';
    const ts     = new Date().toTimeString().slice(0,8);
    const safeMsg = escHtml ? escHtml(msg) : msg;
    const copyText = detail ? msg + '\n\n' + detail : msg;

    const row = document.createElement('div');
    row.style.cssText = 'padding:2px 8px;border-bottom:1px solid rgba(255,255,255,0.04);display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap';
    row.innerHTML = `<span style="color:#475569;flex-shrink:0">${ts}</span><span style="color:${color};flex-shrink:0">${icon}</span><span style="color:${color};word-break:break-word;flex:1">${safeMsg}</span>`;

    /* Kopyala butonu */
    const cpBtn = document.createElement('button');
    cpBtn.textContent = '⎘';
    cpBtn.title = 'Kopyala';
    cpBtn.style.cssText = 'background:transparent;border:none;cursor:pointer;color:#475569;padding:0 3px;font-size:12px;flex-shrink:0;line-height:1';
    cpBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(copyText).then(() => {
        cpBtn.textContent = '✔'; cpBtn.style.color = '#4ade80';
        setTimeout(() => { cpBtn.textContent = '⎘'; cpBtn.style.color = '#475569'; }, 1500);
      }).catch(() => {
        cpBtn.style.color = '#ef4444';
        setTimeout(() => { cpBtn.style.color = '#475569'; }, 1500);
      });
    });
    row.appendChild(cpBtn);

    if (detail) {
      const det = document.createElement('details');
      det.style.cssText = 'font-size:9px;color:#475569;width:100%;padding-left:20px';
      det.innerHTML = `<summary style="cursor:pointer">detay</summary><pre style="margin:2px 0;white-space:pre-wrap">${escHtml ? escHtml(String(detail)) : detail}</pre>`;
      row.appendChild(det);
    }
    list.appendChild(row);

    /* hata gelince paneli otomatik aç ve kırmızı yak */
    if (level === 'error') {
      const wrap = document.getElementById('float-log-wrap');
      const bar  = document.getElementById('float-log-bar');
      const ind  = document.getElementById('float-log-indicator');
      const title= document.getElementById('float-log-title');
      if (ind)  ind.style.background = '#ef4444';
      if (title){ title.style.color='#fca5a5'; title.textContent='Loglar — HATA'; }
      list.style.display = 'block';
      document.getElementById('float-log-arrow').textContent = '▼';
    }
    list.scrollTop = list.scrollHeight;
  } catch(_) {}
}

// ── Log Panel ─────────────────────────────────────────────────────────────────
const LOG_LEVELS = { error:'#ef5350', warn:'#ffa726', info:'#4fc3f7', ok:'#66bb6a' };

function addLog(level, msg, detail) {
  _floatLog(level, msg, detail);   /* floating panel'e de yaz */
  const list = document.getElementById('log-list');
  if (!list) return;

  const now = new Date();
  const ts = now.toTimeString().slice(0,8) + '.' + String(now.getMilliseconds()).padStart(3,'0');
  const color = LOG_LEVELS[level] || '#8b949e';
  const icon = level==='error'?'✖':level==='warn'?'⚠':level==='ok'?'✔':'ℹ';

  const entry = document.createElement('div');
  entry.style.cssText = `padding:3px 8px;border-bottom:1px solid rgba(255,255,255,0.04);display:flex;gap:6px;align-items:flex-start;`;
  entry.innerHTML = `
    <span style="color:var(--text-dim);white-space:nowrap;flex-shrink:0">${ts}</span>
    <span style="color:${color};flex-shrink:0">${icon}</span>
    <span style="color:${color==='#8b949e'?'var(--text)':color};word-break:break-word;flex:1">${escHtml(msg)}</span>
    <button title="Kopyala" style="background:transparent;border:none;cursor:pointer;color:#475569;padding:0 2px;flex-shrink:0;font-size:12px;line-height:1;transition:color 0.15s" data-copy="${escHtml(detail ? msg + '\n\n' + detail : msg)}">⎘</button>`;

  entry.querySelector('[data-copy]').addEventListener('click', function() {
    const text = this.getAttribute('data-copy');
    navigator.clipboard.writeText(text).then(() => {
      this.textContent = '✔';
      this.style.color = '#4ade80';
      setTimeout(() => { this.textContent = '⎘'; this.style.color = '#475569'; }, 1500);
    }).catch(() => {
      this.style.color = '#ef4444';
      setTimeout(() => { this.style.color = '#475569'; }, 1500);
    });
  });

  if (detail) {
    const pre = document.createElement('details');
    pre.style.cssText = 'font-size:9px;color:var(--text-dim);margin-top:2px;word-break:break-all;';
    pre.innerHTML = `<summary style="cursor:pointer;color:var(--text-dim)">detay</summary><pre style="margin:2px 0;white-space:pre-wrap">${escHtml(typeof detail==='string'?detail:JSON.stringify(detail,null,2))}</pre>`;
    entry.appendChild(pre);
  }

  list.appendChild(entry);
  list.scrollTop = list.scrollHeight;

  // Logs sekmesi badge'i
  const btn = document.getElementById('tab-logs-btn');
  if (btn && level === 'error') {
    btn.style.color = '#ef5350';
    btn.textContent = 'Loglar ●';
  }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function clearLogs() {
  const list = document.getElementById('log-list');
  if (list) list.innerHTML = '';
  const btn = document.getElementById('tab-logs-btn');
  if (btn) { btn.style.color=''; btn.textContent='Loglar'; }
}

function copyLogs(btn) {
  const list = document.getElementById('log-list');
  if (!list) return;
  const text = Array.from(list.querySelectorAll('div')).map(d => d.innerText).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    if (btn) { btn.textContent = '✓ Kopyalandı'; setTimeout(() => btn.textContent = 'Kopyala', 1500); }
  });
}

// Tarayıcı console'unu da yakala
const _origConsole = { log: console.log, warn: console.warn, error: console.error };
console.log   = (...a) => { try { _origConsole.log(...a);   addLog('info',  a.map(v=>typeof v==='object'?JSON.stringify(v):String(v)).join(' ')); } catch(_){} };
console.warn  = (...a) => { try { _origConsole.warn(...a);  addLog('warn',  a.map(v=>typeof v==='object'?JSON.stringify(v):String(v)).join(' ')); } catch(_){} };
console.error = (...a) => { try { _origConsole.error(...a); addLog('error', a.map(v=>typeof v==='object'?JSON.stringify(v):String(v)).join(' ')); } catch(_){} };

window.addEventListener('error', e => { try { addLog('error', `[JS] ${e.message}`, `${e.filename}:${e.lineno}:${e.colno}`); } catch(_){} });
window.addEventListener('unhandledrejection', e => { try { addLog('error', `[Promise] ${String(e.reason)}`, String(e.reason?.stack||'')); } catch(_){} });

function evColor(type) {
  const t = (type||'').toLowerCase();
  for (const [k,v] of Object.entries(EVENT_COLORS)) if (t.includes(k)) return v;
  return EVENT_COLORS.default;
}

// ── AudioContext ──────────────────────────────────────────────────────────────
function getCtx() {
  if (!state.audioCtx || state.audioCtx.state==='closed')
    state.audioCtx = new (window.AudioContext||window.webkitAudioContext)();
  if (state.audioCtx.state==='suspended') state.audioCtx.resume();
  return state.audioCtx;
}

// ── File Loading ──────────────────────────────────────────────────────────────
// loadFile çağrısı project-manager.js → window.onAudioFileReady üzerinden geliyor.
// Burada sadece input sıfırlama ve menü kapama yapılır.
fileInput.addEventListener('change', e => {
  closeOpenMenu();
  // value sıfırlama burada yapılmıyor — project-manager.js onFileSelected'dan sonra yapıyor
});

// ── Aç dropdown ──────────────────────────────────────────────────────────────
const btnOpenMenu = $('btn-open-menu');
const openMenu    = $('open-menu');

function closeOpenMenu() { openMenu.style.display = 'none'; }

btnOpenMenu.addEventListener('click', e => {
  e.stopPropagation();
  const visible = openMenu.style.display !== 'none';
  openMenu.style.display = visible ? 'none' : 'block';
});

// Hover efekti
openMenu.querySelectorAll('label').forEach(el => {
  el.addEventListener('mouseenter', () => el.style.background = 'rgba(255,255,255,0.07)');
  el.addEventListener('mouseleave', () => el.style.background = '');
});

document.addEventListener('click', closeOpenMenu);


async function loadFile(file) {
  console.log('loadFile çağrıldı:', file.name);
  _rawFileBlob = file;   // Whisper için sakla
  setStatus('Yükleniyor...','busy');
  showLoading('Ses dosyası okunuyor...', file.name);
  try {
    const ctx = getCtx();
    addLog('info', `[loadFile] 1/4 ctx.state=${ctx.state} · ${(file.size/1024/1024).toFixed(1)}MB`);

    let rawBuf;
    try { rawBuf = await file.arrayBuffer(); }
    catch(e) { throw new Error('[1/4 arrayBuffer] ' + e.message); }
    addLog('info', `[loadFile] 2/4 arrayBuffer OK: ${rawBuf.byteLength} bytes`);

    if (ldText) ldText.textContent = 'Ses decode ediliyor...';
    if (ldSub)  ldSub.textContent  = `${(file.size/1024/1024).toFixed(1)}MB`;
    const rawCopy = rawBuf.slice(0);
    try { state.audioBuffer = await ctx.decodeAudioData(rawBuf); }
    catch(e) { throw new Error('[2/4 decode] ' + e.message); }
    _originalAudioBuffer = state.audioBuffer;  // orijinali sakla
    addLog('info', `[loadFile] 3/4 decode OK: ${state.audioBuffer.duration.toFixed(1)}s`);

    state.fileName = file.name; state.offset = 0; state.analysis = null;
    if (infoFile)  infoFile.textContent  = file.name;
    if (infoMeta)  infoMeta.textContent  =
      `${formatTime(state.audioBuffer.duration)} · ${state.audioBuffer.sampleRate.toLocaleString()}Hz · ${state.audioBuffer.numberOfChannels}ch`;
    if (btnAnalyze)      btnAnalyze.disabled      = false;
    if (btnSendCmd)      btnSendCmd.disabled      = false;
    if (btnCleanDownload)btnCleanDownload.disabled = false;
    if (btnNoiseGate)    btnNoiseGate.disabled     = false;
    if (emptyState)      emptyState.style.display  = 'none';
    try { drawRuler(); updateTimeDisplay(0); }
    catch(e) { throw new Error('[3/4 buildUI] ' + e.message); }

    setStatus('','idle');
    setExtra('');
    if (aiStatusBadge) aiStatusBadge.textContent = 'Hazır';
    addLog('ok', `Dosya yüklendi: ${file.name} · ${formatTime(state.audioBuffer.duration)}`);
    onAudioLoaded();
    const _oldModal = document.getElementById('noisegate-modal');
    if (_oldModal) _oldModal.remove();
    // ── Proje adı dialogu ─────────────────────────────────────────────────────
    await new Promise(resolve => {
      const existing = document.getElementById('_proj-name-dialog');
      if (existing) existing.remove();
      const dlg = document.createElement('div');
      dlg.id = '_proj-name-dialog';
      dlg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center';
      const suggestedName = file.name.replace(/\.[^.]+$/, '');
      dlg.innerHTML = `
        <div style="background:#0f172a;border:1px solid #38bdf8;border-radius:12px;padding:24px;min-width:360px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,0.8)">
          <div style="font-size:16px;font-weight:700;color:#38bdf8;margin-bottom:4px">🎙 Yeni Proje</div>
          <div style="font-size:11px;color:#64748b;margin-bottom:16px">${file.name} · ${(file.size/1024/1024).toFixed(1)}MB · ${formatTime(state.audioBuffer?.duration||0)}</div>
          <label style="font-size:12px;color:#94a3b8;display:block;margin-bottom:6px">Proje Adı</label>
          <input id="_proj-name-inp" value="${suggestedName}" style="width:100%;box-sizing:border-box;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#f1f5f9;padding:8px 10px;font-size:14px;outline:none;margin-bottom:16px">
          <div style="display:flex;gap:8px">
            <button id="_proj-name-ok" style="flex:1;padding:9px;background:linear-gradient(135deg,#1e3a5f,#0e4a2f);border:1px solid #38bdf8;border-radius:6px;color:#38bdf8;cursor:pointer;font-size:13px;font-weight:700">✓ Başla</button>
            <button id="_proj-name-skip" style="padding:9px 14px;background:transparent;border:1px solid #334155;border-radius:6px;color:#475569;cursor:pointer;font-size:12px">Atla</button>
          </div>
        </div>`;
      document.body.appendChild(dlg);
      const inp = dlg.querySelector('#_proj-name-inp');
      inp.focus(); inp.select();
      const finish = async () => {
        const name = inp.value.trim() || suggestedName;
        _currentProjectName = name;
        localStorage.setItem('current_project_name', name);
        // Eski pipeline state ve step audio'ları temizle (yeni proje)
        await clearPipelineStateFromDB();
        window._stepAudioSnapshots = {};
        window._stepDetails = {};
        _initPipeReport(name, file);
        _pipeReport.originalFile.duration = +(state.audioBuffer?.duration||0).toFixed(1);
        // Projeyi oluştur ve kaydet
        if (typeof _project !== 'undefined') {
          if (!_project.id) _project.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          if (!_project.createdAt) _project.createdAt = Date.now();
          _project.name = name;
          _project.fileName = file.name;
          _project.fileSize = file.size;
        }
        if (typeof _setProjectName === 'function') _setProjectName(name);
        if (typeof ProjectStorage !== 'undefined') ProjectStorage.setActive(_project.id);
        if (typeof saveProject === 'function') saveProject();
        dlg.remove();
        resolve();
      };
      dlg.querySelector('#_proj-name-ok').onclick    = finish;
      dlg.querySelector('#_proj-name-skip').onclick  = () => {
        _currentProjectName = suggestedName;
        localStorage.setItem('current_project_name', suggestedName);
        _initPipeReport(suggestedName, file);
        _pipeReport.originalFile.duration = +(state.audioBuffer?.duration||0).toFixed(1);
        if (typeof _project !== 'undefined') {
          if (!_project.id) _project.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          if (!_project.createdAt) _project.createdAt = Date.now();
          _project.name = suggestedName;
          _project.fileName = file.name;
          _project.fileSize = file.size;
        }
        if (typeof _setProjectName === 'function') _setProjectName(suggestedName);
        if (typeof ProjectStorage !== 'undefined') ProjectStorage.setActive(_project.id);
        if (typeof saveProject === 'function') saveProject();
        dlg.remove(); resolve();
      };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') finish(); });
    });

    openNoiseGateInline();

    addLog('info', `[loadFile] 4/4 DB'ye kaydediliyor...`);
    if (ldText) ldText.textContent = 'Arşive kaydediliyor...';
    if (ldSub)  ldSub.textContent  = 'Bir sonraki açılışta otomatik yüklenir';
    setProgress(50, 'Kaydediliyor...');
    try { await saveSessionToDB(rawCopy, file.name, file.size); }
    catch(e) { addLog('warn', '[4/4 saveDB] ' + e.message); } // DB hatası kritik değil
    setProgress(100, 'Arşivlendi!');
  } catch(err) {
    addLog('error', 'Dosya yükleme hatası: ' + err.message, err.stack||'');
    setStatus('Dosya yükleme hatası','idle');
    showErrorBanner('❌ Ses dosyası açılamadı: ' + err.message);
  } finally { hideLoading(); }
}

// ── Sayfa açılışında arşivden dosyayı geri yükle ─────────────────────────────
(async () => {
  const saved = await loadSessionFromDB();
  if (!saved || !saved.raw) return;
  addLog('info', `Arşiv bulundu: ${saved.name} (${((saved.size||saved.raw.byteLength)/1024/1024).toFixed(1)}MB) — decode ediliyor...`);
  showLoading('Arşivden yükleniyor...', saved.name);
  startElapsedTimer('🗃 Arşiv decode ediliyor —');
  try {
    const ctx = getCtx();
    const ab = await ctx.decodeAudioData(saved.raw.slice(0));
    state.audioBuffer = ab;
    state.fileName = saved.name;
    // Whisper ve FFmpeg için ham dosyayı Blob olarak sakla
    _rawFileBlob = new File([saved.raw], saved.name, {type: 'audio/mpeg'});
    state.offset = 0;
    setProgress(90, 'Ekran oluşturuluyor...');
    infoFile.textContent = saved.name;
    infoMeta.textContent =
      `${formatTime(ab.duration)} · ${ab.sampleRate.toLocaleString()}Hz · ${ab.numberOfChannels}ch`;
    if (btnAnalyze)      btnAnalyze.disabled      = false;
    if (btnSendCmd)      btnSendCmd.disabled      = false;
    if (btnCleanDownload)btnCleanDownload.disabled = false;
    if (btnNoiseGate)    btnNoiseGate.disabled    = false;
    if (emptyState)      emptyState.style.display = 'none';
    drawRuler();
    updateTimeDisplay(0);
    setStatus('Durduruldu.','idle');
    setExtra(`${saved.name} · ${((saved.size||0)/1024/1024).toFixed(1)}MB`);
    if (aiStatusBadge) aiStatusBadge.textContent = 'Hazır';
    setProgress(100, 'Hazır!');
    addLog('ok', `Arşivden yüklendi: ${saved.name} · ${formatTime(ab.duration)}`);
    // Proje adını ve pipeline panelini otomatik aç
    _originalAudioBuffer = state.audioBuffer;
    const _savedProjName = localStorage.getItem('current_project_name');
    if (_savedProjName) _currentProjectName = _savedProjName;
    onAudioLoaded();
  } catch(err) {
    addLog('error', 'Arşiv yükleme hatası: ' + err.message);
  } finally { hideLoading(); }
})();

// ── Proje yöneticisinden audio yükleme (dosya seçmeden) ──────────────────────
window.loadSessionByKey = loadSessionByKey;

async function loadFileFromBuffer(rawArrayBuffer, fileName, fileSize) {
  showLoading('Proje yükleniyor...', fileName);
  try {
    const ctx = getCtx();
    const ab = await ctx.decodeAudioData(rawArrayBuffer.slice(0));
    state.audioBuffer = ab;
    _originalAudioBuffer = ab;
    state.fileName = fileName;
    _rawFileBlob = new File([rawArrayBuffer], fileName, {type: 'audio/mpeg'});
    state.offset = 0;
    if (infoFile)  infoFile.textContent  = fileName;
    if (infoMeta)  infoMeta.textContent  =
      `${formatTime(ab.duration)} · ${ab.sampleRate.toLocaleString()}Hz · ${ab.numberOfChannels}ch`;
    if (btnAnalyze)      btnAnalyze.disabled      = false;
    if (btnSendCmd)      btnSendCmd.disabled      = false;
    if (btnCleanDownload)btnCleanDownload.disabled = false;
    if (btnNoiseGate)    btnNoiseGate.disabled     = false;
    if (emptyState)      emptyState.style.display  = 'none';
    drawRuler();
    updateTimeDisplay(0);
    setStatus('Durduruldu.','idle');
    setExtra(`${fileName} · ${((fileSize||0)/1024/1024).toFixed(1)}MB`);
    if (aiStatusBadge) aiStatusBadge.textContent = 'Hazır';
    addLog('ok', `Proje yüklendi: ${fileName} · ${formatTime(ab.duration)}`);
    onAudioLoaded();
    // Bir sonraki refresh'te otomatik yüklensin
    try { await saveSessionToDB(rawArrayBuffer, fileName, fileSize || rawArrayBuffer.byteLength); } catch(_) {}
  } catch(err) {
    addLog('error', 'Proje yükleme hatası: ' + err.message);
  } finally { hideLoading(); }
}
window.loadFileFromBuffer = loadFileFromBuffer;

// ── Feature Extraction ────────────────────────────────────────────────────────
const yield_ = () => new Promise(r => setTimeout(r, 0));

async function extractFeatures(buf) {
  const { duration, sampleRate, numberOfChannels } = buf;
  const ch = buf.getChannelData(0);
  const total = ch.length;

  // Amplitude per 100ms
  setProgress(0, 'Amplitude hesaplanıyor... 0%');
  const step = Math.floor(sampleRate * 0.1);
  const amplitudeData = [];
  const ampChunks = Math.ceil(total / step);
  for (let i = 0; i < total; i += step) {
    let pk = 0;
    const end = Math.min(i+step, total);
    for (let j=i;j<end;j++) if (Math.abs(ch[j])>pk) pk=Math.abs(ch[j]);
    amplitudeData.push(Math.round(pk*10000)/10000);
    if (amplitudeData.length % 2000 === 0) {
      const pct = Math.round(amplitudeData.length / ampChunks * 40);
      setProgress(pct, `Amplitude hesaplanıyor... ${Math.round(amplitudeData.length/ampChunks*100)}%`);
      await yield_();
    }
  }

  // RMS per 200ms (dBFS)
  setProgress(40, 'RMS hesaplanıyor... 0%');
  const rmsStep = Math.floor(sampleRate * 0.2);
  const rmsEnergy = [];
  const rmsChunks = Math.ceil(total / rmsStep);
  for (let i = 0; i < total; i += rmsStep) {
    let s=0; const end=Math.min(i+rmsStep,total), cnt=end-i;
    for (let j=i;j<end;j++) s+=ch[j]*ch[j];
    const rms=Math.sqrt(s/cnt);
    rmsEnergy.push(Math.round((rms>0?20*Math.log10(rms):-96)*10)/10);
    if (rmsEnergy.length % 2000 === 0) {
      const pct = 40 + Math.round(rmsEnergy.length / rmsChunks * 25);
      setProgress(pct, `RMS hesaplanıyor... ${Math.round(rmsEnergy.length/rmsChunks*100)}%`);
      await yield_();
    }
  }

  // Silence periods
  setProgress(65, 'Sessizlikler tespit ediliyor...');
  await yield_();
  const silThr = 0.015, silMin = Math.floor(sampleRate*0.5);
  const silencePeriods = [];
  let silStart = -1;
  for (let i=0;i<total;i++) {
    if (Math.abs(ch[i])<silThr) { if (silStart<0) silStart=i; }
    else {
      if (silStart>=0 && (i-silStart)>=silMin)
        silencePeriods.push({ start:Math.round(silStart/sampleRate*1000)/1000, end:Math.round(i/sampleRate*1000)/1000 });
      silStart=-1;
    }
    if (i % 2000000 === 0) {
      setProgress(65 + Math.round(i/total*20), `Sessizlikler tespit ediliyor... ${Math.round(i/total*100)}%`);
      await yield_();
    }
  }

  // Frequency bands (ZCR-based proxy)
  setProgress(85, 'Frekans analizi...');
  await yield_();
  const fftSize=2048;
  let lo=0,mi=0,hi=0;
  const nf = Math.min(Math.floor(total/fftSize),100);
  for (let f=0;f<nf;f++) {
    let e=0,zcr=0;
    const base=f*fftSize;
    for (let i=base+1;i<base+fftSize;i++) {
      e+=ch[i]*ch[i];
      if ((ch[i]>=0)!==(ch[i-1]>=0)) zcr++;
    }
    const nz=zcr/fftSize;
    if (nz>0.15) hi+=e; else if (nz>0.05) mi+=e; else lo+=e;
  }
  const tot=lo+mi+hi||1;

  // Peak/avg
  setProgress(92, 'Peak/Average hesaplanıyor...');
  await yield_();
  let pk=0,sum=0;
  for (let i=0;i<total;i++) { const a=Math.abs(ch[i]); if(a>pk)pk=a; sum+=a; }

  setProgress(100, 'Özellik çıkarımı tamamlandı!');
  return {
    duration, sampleRate, channels:numberOfChannels, format:'PCM',
    amplitudeData, silencePeriods,
    frequencyBands:{ low:Math.round(lo/tot*1000)/1000, mid:Math.round(mi/tot*1000)/1000, high:Math.round(hi/tot*1000)/1000 },
    rmsEnergy,
    peakAmplitude:Math.round(pk*10000)/10000,
    averageAmplitude:Math.round((sum/ch.length)*10000)/10000,
  };
}

// ── Track Rendering ───────────────────────────────────────────────────────────
function buildTracks() {
  if (!state.audioBuffer) return;
  if (!rulerWrap) return;
  tracksList.innerHTML = '';
  const viewW = rulerWrap.clientWidth || 800;
  // Uzun dosyalar için pps'yi otomatik düşür — max 16000px canvas
  const maxW = 16000;
  const naturalW = Math.floor(state.audioBuffer.duration * state.pps);
  if (naturalW > maxW) {
    state.pps = Math.floor(maxW / state.audioBuffer.duration * 10) / 10;
  }
  const totalW = Math.max(viewW, Math.min(maxW, Math.floor(state.audioBuffer.duration * state.pps)));
  const ch = state.audioBuffer.getChannelData(0);

  LAYERS.forEach(layer => {
    const row = document.createElement('div');
    row.className = 'track-row';
    row.id = `row-${layer.id}`;
    row.innerHTML = `
      <div class="track-header">
        <div class="track-title-row">
          <div class="track-color-bar" style="background:${layer.color}"></div>
          <span class="track-name-text">${layer.name}</span>
        </div>
        <div class="track-btn-row">
          <button class="tr-btn" data-track="${layer.id}" data-action="mute">Mute</button>
          <button class="tr-btn" data-track="${layer.id}" data-action="solo">Solo</button>
        </div>
        <div class="track-vol-row">
          <span>Vol</span>
          <input type="range" class="track-slider track-vol" data-track="${layer.id}" min="0" max="100" value="${Math.round((state.layerState[layer.id]?.vol??1)*100)}">
          <span style="font-size:9px;min-width:22px;text-align:right" id="vol-val-${layer.id}">${Math.round((state.layerState[layer.id]?.vol??1)*100)}%</span>
        </div>
      </div>
      <div class="track-canvas-wrap">
        <canvas class="track-canvas" id="cv-${layer.id}" height="100" width="${totalW}"></canvas>
        <div class="playhead" id="ph-${layer.id}"></div>
      </div>`;
    tracksList.appendChild(row);

    drawWaveform($(`cv-${layer.id}`), ch, layer.color);

    // Vol slider → state
    const volSl = row.querySelector('.track-vol');
    volSl.addEventListener('input', () => {
      const v = +volSl.value / 100;
      state.layerState[layer.id].vol = v;
      const lbl = document.getElementById(`vol-val-${layer.id}`);
      if (lbl) lbl.textContent = Math.round(v * 100) + '%';
    });

    // Mute / Solo → state
    row.querySelectorAll('.tr-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.track;
        if (btn.dataset.action === 'mute') {
          state.layerState[id].muted = !state.layerState[id].muted;
          btn.classList.toggle('muted', state.layerState[id].muted);
        }
        if (btn.dataset.action === 'solo') {
          state.layerState[id].soloed = !state.layerState[id].soloed;
          btn.classList.toggle('soloed', state.layerState[id].soloed);
        }
      });
    });
  });

  resizeCanvases();
}

function drawWaveform(canvas, ch, color) {
  const W=canvas.width, H=canvas.height, mid=H/2;
  const ctx=canvas.getContext('2d');

  ctx.fillStyle='#232c3d'; ctx.fillRect(0,0,W,H);

  // Center line
  ctx.strokeStyle='rgba(255,255,255,0.06)'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(0,mid); ctx.lineTo(W,mid); ctx.stroke();

  const spp = ch.length/W;
  ctx.fillStyle = color;
  for (let x=0;x<W;x++) {
    const s=Math.floor(x*spp), e=Math.floor((x+1)*spp);
    let mn=0,mx=0;
    for (let i=s;i<e&&i<ch.length;i++) { if(ch[i]<mn)mn=ch[i]; if(ch[i]>mx)mx=ch[i]; }
    const yHi = mid - mx*(mid-2);
    const yLo = mid - mn*(mid-2);
    ctx.fillRect(x, yHi, 1, Math.max(1, yLo-yHi));
  }
}

function resizeCanvases() {
  if (!state.audioBuffer) return;
  if (!rulerWrap) return;
  const availW = rulerWrap.clientWidth || 800;
  const totalW = Math.max(availW, Math.floor(state.audioBuffer.duration*state.pps));
  const ch = state.audioBuffer.getChannelData(0);

  LAYERS.forEach(layer => {
    const cv = $(`cv-${layer.id}`);
    if (!cv) return;
    cv.width = totalW;
    drawWaveform(cv, ch, layer.color);
    if (state.analysis) {
      const ld = state.analysis.layers?.find(l=>l.id===layer.id);
      applyLayerOverlay(cv, ld, state.analysis.noise_events);
    }
  });
  drawRuler();
}

// ── Analysis Overlay ──────────────────────────────────────────────────────────
function applyLayerOverlay(canvas, layerData, events) {
  const ctx=canvas.getContext('2d');
  const W=canvas.width, H=canvas.height;
  const dur=state.audioBuffer?.duration||1;

  layerData?.segments?.forEach(seg => {
    const x1=(seg.start/dur)*W, w=Math.max(2,(seg.end/dur)*W-x1);
    if (seg.action==='delete') {
      ctx.fillStyle='rgba(239,68,68,0.22)'; ctx.fillRect(x1,0,w,H);
      ctx.strokeStyle='rgba(239,68,68,0.7)'; ctx.lineWidth=1.5;
      ctx.beginPath(); ctx.moveTo(x1,H/2); ctx.lineTo(x1+w,H/2); ctx.stroke();
    } else if (seg.action==='attenuate') {
      ctx.fillStyle='rgba(251,191,36,0.15)'; ctx.fillRect(x1,0,w,H);
    }
  });

  events?.forEach(ev => {
    const c=evColor(ev.type);
    const s = ev.start_sec ?? ev.start ?? 0;
    const e = ev.end_sec   ?? ev.end   ?? s;
    const x=(s/dur)*W, w=Math.max(3,(e/dur)*W-x);
    ctx.fillStyle=c+'28'; ctx.fillRect(x,0,w,H);
    ctx.strokeStyle=c; ctx.lineWidth=1;
    ctx.strokeRect(x,1,w,H-2);
    if (w>18) {
      ctx.fillStyle=c; ctx.font='bold 8px monospace';
      ctx.fillText((ev.type||'').substring(0,5).toUpperCase(), x+2, 11);
    }
  });
}

// ── Ruler ─────────────────────────────────────────────────────────────────────
function drawRuler() {
  if (!state.audioBuffer || !rulerWrap || !rulerCanvas) return;
  const W=rulerWrap.clientWidth||800, H=24;
  rulerCanvas.width=W; rulerCanvas.height=H;
  const ctx=rulerCanvas.getContext('2d');
  const dur=state.audioBuffer.duration, pps=state.pps;

  ctx.fillStyle='#252f40'; ctx.fillRect(0,0,W,H);
  ctx.font='9px monospace'; ctx.lineWidth=1;

  const tickSec = dur<30?1:dur<120?5:dur<600?10:30;
  const minorSec = tickSec/5;

  for (let t=0;t<=dur;t+=minorSec) {
    const x=t*pps;
    if (x>W) break;
    const major = Math.abs(t%tickSec)<0.001;
    ctx.strokeStyle = major?'#5a6478':'#3a4558';
    ctx.beginPath(); ctx.moveTo(x,major?6:14); ctx.lineTo(x,H); ctx.stroke();
    if (major) {
      ctx.fillStyle='#8b95a8';
      ctx.fillText(formatTime(t).substring(0,8), x+2, 8);
    }
  }
}

// ── Ruler tıklama → seek ──────────────────────────────────────────────────────
if (rulerCanvas) {
  rulerCanvas.style.cursor = 'pointer';
  rulerCanvas.addEventListener('mousedown', e => {
    if (!state.audioBuffer) return;
    e.preventDefault();
    const rect = rulerCanvas.getBoundingClientRect();
    const t = Math.max(0, Math.min(state.audioBuffer.duration,
      (e.clientX - rect.left) / state.pps));
    seekTo(t);
    if (typeof window._ngSeek === 'function') window._ngSeek(t);
  });
}

// ── Analyze ───────────────────────────────────────────────────────────────────
btnAnalyze.addEventListener('click', runAnalysis);

async function runAnalysis() {
  if (!state.audioBuffer) return;
  btnAnalyze.disabled=true;
  setStatus('Özellikler çıkarılıyor...','busy');
  aiStatusBadge.textContent='Analiz ediliyor...';
  showLoading('Ses özellikleri çıkarılıyor...','Lütfen bekleyin');

  try {
    const features = await extractFeatures(state.audioBuffer);
    addLog('info', `Özellik çıkarımı tamam: ${features.amplitudeData.length} amplitude, ${features.rmsEnergy.length} RMS, ${features.silencePeriods.length} sessizlik`);
    console.log('[analyze] Feature extraction done:', features.amplitudeData.length, 'samples');

    // ── Aşama 1: Python analizi (hızlı) ──────────────────────────────────────
    ldText.textContent = '① Python analizi yapılıyor...';
    ldSub.textContent  = `${features.amplitudeData.length} örnek · ${features.silencePeriods.length} sessizlik`;
    setProgress(10, 'Hızlı analiz...');

    const res1 = await fetch('/api/analyze/python', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({features}),
    });
    if (!res1.ok) throw new Error(`Python analiz hatası: HTTP ${res1.status}`);
    const d1 = await res1.json();
    if (!d1.success) throw new Error(d1.error);

    // Amplitude verisini ileriki kullanım için sakla (NoiseGate, vb.)
    state._ampData     = features.amplitudeData;
    state._ampInterval = 0.1; // saniye başına örnek

    // Python sonucunu hemen göster
    state.analysis = d1.analysis;
    populateLayerSegments(d1.analysis);
    setProgress(50, 'Waveform çiziliyor...');
    ldText.textContent = '① Temel analiz tamamlandı — waveform yükleniyor...';
    renderAnalysis(d1.analysis);
    LAYERS.forEach(layer => {
      const cv = $(`cv-${layer.id}`);
      if (!cv) return;
      const ch = state.audioBuffer.getChannelData(0);
      drawWaveform(cv, ch, layer.color);
      const ld = d1.analysis.layers?.find(l => l.id === layer.id);
      applyLayerOverlay(cv, ld||{segments:[]}, d1.analysis.noise_events||[]);
    });
    const ev1 = d1.analysis.noise_events?.length || 0;
    aiStatusBadge.textContent = `① ${ev1} olay · Ollama bekliyor...`;
    addLog('ok', `Python analizi: ${ev1} olay tespit edildi`);

    // ── Aşama 2: Ollama zenginleştirme ───────────────────────────────────────
    ldText.textContent = '② Ollama yorumluyor...';
    ldSub.textContent  = 'Senaryo tespiti · Akıllı öneriler · EQ tavsiyeleri';
    startElapsedTimer('🤖 Ollama analiz ediyor —');

    let ollamaOk = false;
    try {
      const res2 = await fetch('/api/analyze/enrich', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({analysis: d1.analysis, features}),
      });
      if (res2.ok) {
        const d2 = await res2.json();
        if (d2.success && d2.ollama_enriched) {
          state.analysis = d2.analysis;
          populateLayerSegments(d2.analysis);
          ollamaOk = true;
          // Paneli Ollama zenginleştirmesiyle güncelle
          ldText.textContent = '② Ollama tamamlandı — panel güncelleniyor...';
          setProgress(90, 'Güncelleniyor...');
          renderAnalysis(d2.analysis);
          addLog('ok', `Ollama zenginleştirme: senaryo=${d2.analysis.scenario_detected||'?'}`);
        } else {
          addLog('warn', 'Ollama zenginleştirme başarısız — Python sonucu korunuyor');
        }
      }
    } catch(e2) {
      addLog('warn', 'Ollama aşaması atlandı: ' + e2.message);
    }

    // ── Sonuçları göster ──────────────────────────────────────────────────────
    const finalAnalysis = state.analysis;
    const evCount   = finalAnalysis.noise_events?.length || 0;
    const warnCount = finalAnalysis.warnings?.length || 0;
    const confCount = finalAnalysis.user_confirmations_required?.length || 0;
    const ollamaTag = ollamaOk ? ' · ✦ Ollama' : '';
    setStatus(`Analiz tamamlandı · ${evCount} olay${warnCount?` · ${warnCount} uyarı`:''}${confCount?` · ${confCount} onay gerekli`:''}${ollamaTag}`, 'active');
    aiStatusBadge.textContent = `✓ ${evCount} olay${ollamaOk ? ' ✦' : ''}${warnCount?' ⚠'+warnCount:''}`;
    switchTab('analysis');
  } catch(err) {
    console.error('[analyze] Error:', err);
    addLog('error', 'Analiz hatası: ' + err.message, err.stack||'');
    setStatus('Analiz başarısız: '+err.message,'idle');
    aiStatusBadge.textContent='✗ Hata';
    showErrorBanner('❌ Analiz hatası: ' + err.message);
    switchTab('logs');
  } finally {
    hideLoading();
    btnAnalyze.disabled=false;
  }
}

btnNoiseGate.addEventListener('click', () => {
  if (!state.audioBuffer) return addLog('warn', 'Önce ses dosyası yükleyin');
  switchTrackTab('gate');
});

// ── Temizle ve İndir — Pipeline: Whisper → Ollama → Popup ─────────────────────
btnCleanDownload.addEventListener('click', () => {
  if (!state.audioBuffer || !_rawFileBlob) return;
  showPipelineModal();
});

function showPipelineModal() {
  const existing = document.getElementById('pipeline-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'pipeline-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.82);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  modal.innerHTML = `
    <div style="background:#0f172a;border:1px solid #334155;border-radius:12px;width:100%;max-width:480px;display:flex;flex-direction:column;overflow:hidden">
      <div style="padding:16px;border-bottom:1px solid #1e293b">
        <div style="font-weight:700;color:#f1f5f9;font-size:14px">🚀 Hazırlık Aşamaları</div>
        <div style="color:#64748b;font-size:10px;margin-top:2px">Whisper transkripsiyon → Ollama analizi → Seçenekler</div>
      </div>
      <!-- Adımlar -->
      <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
        ${['whisper','analysis','ollama'].map((id,i) => {
          const labels = ['1. Whisper Large — Transkripsiyon', '2. Ses Analizi', '3. Ollama AI Analizi'];
          return `<div class="pipe-step" id="pipe-${id}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid #1e293b;border-radius:6px">
            <div class="pipe-icon" style="width:28px;height:28px;border-radius:50%;background:#1e293b;display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0;color:#475569">${i+1}</div>
            <div style="flex:1;min-width:0">
              <div style="color:#94a3b8;font-size:12px;font-weight:600">${labels[i]}</div>
              <div class="pipe-sub" id="pipe-${id}-sub" style="color:#475569;font-size:10px;margin-top:2px">Bekliyor...</div>
              <div class="pipe-bar-wrap" id="pipe-${id}-bar-wrap" style="display:none;margin-top:5px;height:3px;background:#1e293b;border-radius:2px">
                <div class="pipe-bar" id="pipe-${id}-bar" style="height:100%;width:0%;background:#38bdf8;border-radius:2px;transition:width .3s"></div>
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>
      <div style="padding:12px 16px;border-top:1px solid #1e293b">
        <button id="pipe-cancel" style="width:100%;padding:8px;background:transparent;border:1px solid #334155;color:#64748b;border-radius:6px;cursor:pointer;font-size:12px">İptal</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.querySelector('#pipe-cancel').onclick = () => modal.remove();

  runPipeline(modal);
}

function pipeStep(modal, id, state, sub, pct) {
  const el    = modal?.querySelector(`#pipe-${id}`);
  const subEl = modal?.querySelector(`#pipe-${id}-sub`);
  const barW  = modal?.querySelector(`#pipe-${id}-bar-wrap`);
  const bar   = modal?.querySelector(`#pipe-${id}-bar`);
  const icon  = modal?.querySelector(`#pipe-${id} .pipe-icon`);
  if (!el) return;
  const colors = { pending:'#1e293b', active:'#1e3a5f', done:'#14532d', error:'#450a0a' };
  const icons  = { pending:'⏳', active:'⚡', done:'✓', error:'✗' };
  el.style.borderColor = state==='done'?'#166534':state==='active'?'#1d4ed8':state==='error'?'#991b1b':'#1e293b';
  el.style.background  = colors[state] || '#1e293b';
  if (icon) { icon.textContent = icons[state]||''; icon.style.color = state==='done'?'#22c55e':state==='active'?'#38bdf8':state==='error'?'#ef4444':'#475569'; }
  if (subEl && sub) subEl.textContent = sub;
  if (barW) barW.style.display = (state==='active'||state==='done') ? 'block':'none';
  if (bar && pct!=null) bar.style.width = pct+'%';
}

async function runPipeline(modal) {
  try {
    // ── 1. Whisper ─────────────────────────────────────────────────────────
    let transcript = _transcriptResult; // bellekte varsa kullan

    // Bellekte yoksa DB arşivine bak
    if (!transcript) {
      pipeStep(modal,'whisper','active','Transkript arşivi kontrol ediliyor...', 3);
      const cached = await loadTranscriptFromDB();
      if (cached) {
        transcript = cached;
        _transcriptResult = cached;
        renderTranscript(cached);
        addLog('ok', `Transkript arşivden yüklendi: ${cached.stats?.total_words} kelime`);
        pipeStep(modal,'whisper','done', `✓ Arşivden yüklendi — ${cached.stats?.total_words||0} kelime · ${(cached.language||'').toUpperCase()}`, 100);
      }
    } else {
      pipeStep(modal,'whisper','done', `✓ Transkript hazır — ${transcript.stats?.total_words||0} kelime`, 100);
    }

    if (!transcript) {
      pipeStep(modal,'whisper','active','Dosya yükleniyor...', 5);
      const fd = new FormData();
      fd.append('file', _rawFileBlob, _rawFileBlob.name);
      fd.append('model', 'large');
      const r1 = await fetch('/api/transcribe/start', {method:'POST', body:fd});
      if (!r1.ok) throw new Error(`Whisper başlatma HTTP ${r1.status}`);
      const d1 = await r1.json();
      if (!d1.success) throw new Error(d1.error);
      _transcriptJobId = d1.job_id;
      pipeStep(modal,'whisper','active', `Model yükleniyor... (${d1.size_mb}MB)`, 10);

      // Poll
      transcript = await new Promise((resolve, reject) => {
        const timer = setInterval(async () => {
          if (!document.getElementById('pipeline-modal')) { clearInterval(timer); reject(new Error('İptal edildi')); return; }
          try {
            const r = await fetch(`/api/transcribe/status/${_transcriptJobId}`);
            const d = await r.json();
            const pct = d.status==='done'?100:d.status==='loading_model'?8:Math.min(85,10+(d.elapsed||0)*0.18);
            const elMin = Math.floor((d.elapsed||0)/60), elSec = (d.elapsed||0)%60;
            const subs = {queued:'Sırada...', loading_model:'Model yükleniyor...', transcribing:`Transkripsiyon devam ediyor — ${elMin}dk ${elSec}s geçti · lütfen bekleyin`, done:'Tamamlandı!'};
            pipeStep(modal,'whisper','active', subs[d.status]||d.status, pct);
            if (d.status==='done') {
              clearInterval(timer);
              _transcriptResult = d.result;
              renderTranscript(d.result);
              saveTranscriptToDB(d.result); // arşive kaydet
              resolve(d.result);
            } else if (d.status==='error') {
              clearInterval(timer);
              reject(new Error(d.error||'Whisper hatası'));
            }
          } catch(e) { clearInterval(timer); reject(e); }
        }, 3000);
      });
      pipeStep(modal,'whisper','done', `✓ ${transcript.stats?.total_words||0} kelime · ${transcript.language?.toUpperCase()||''}`, 100);
    } else {
      pipeStep(modal,'whisper','done', `✓ Mevcut transkript kullanılıyor (${transcript.stats?.total_words||0} kelime)`, 100);
    }

    // ── 2. Ses Analizi ─────────────────────────────────────────────────────
    pipeStep(modal,'analysis','active','Ses özellikleri çıkarılıyor...', 30);
    if (!state.analysis) await runAnalysis();
    pipeStep(modal,'analysis','done','✓ Analiz tamamlandı', 100);

    // ── 3. Ollama ──────────────────────────────────────────────────────────
    pipeStep(modal,'ollama','active','Transkript + analiz ile zenginleştiriliyor...', 20);
    if (state.analysis && transcript) {
      await reEnrichWithTranscript(transcript);
    }
    pipeStep(modal,'ollama','done','✓ AI analizi tamamlandı', 100);

    // Kısa bekleme sonra popup
    await new Promise(r => setTimeout(r, 600));
    if (!document.getElementById('pipeline-modal')) return;
    modal.remove();
    showCleanupPopup(true); // transcript hazır = true

  } catch(err) {
    const failId = err.message.includes('Whisper')||err.message.includes('transcri') ? 'whisper'
                 : err.message.includes('Analiz') ? 'analysis' : 'ollama';
    pipeStep(modal, failId, 'error', '✗ '+err.message);
    addLog('error', 'Pipeline hatası: '+err.message);
    const cancelBtn = modal?.querySelector('#pipe-cancel');
    if (cancelBtn) { cancelBtn.textContent = 'Kapat'; cancelBtn.style.borderColor='#991b1b'; cancelBtn.style.color='#ef4444'; }
  }
}

const CLEANUP_OPTIONS = [
  { id:'normalize',  label:'Ses seviyesini normalize et',        icon:'🔊',  desc:'1. Adım — Tüm tespitler için seviyeyi eşitle',            def:true,  sens:80 },
  { id:'bg_noise',   label:'Arka plan gürültüsünü kaldır',      icon:'🔇',  desc:'2. Adım — Fan, klima, sürekli uğultu (sabit gürültü)',    def:true,  sens:70 },
  { id:'music',      label:'Arka plan müziğini azalt',          icon:'🎵',  desc:'3. Adım — Fon müziği, jingle sesleri',                    def:false, sens:70 },
  { id:'cough',      label:'Öksürme ve boğaz temizlemeyi kes',  icon:'🤧',  desc:'4. Adım — Öksürük, hapşırma, boğaz temizleme',            def:true,  sens:80 },
  { id:'utensil',    label:'Kaşık / çatal / tabak sesi',        icon:'🥄',  desc:'5. Adım — Metalik klik, çarpma, mutfak aleti sesleri',    def:false, sens:75 },
  { id:'breath',     label:'Nefes seslerini azalt',             icon:'💨',  desc:'6. Adım — Derin nefes, üfleme, ağız sesi',                def:false, sens:65 },
  { id:'stutter',    label:'Kekemelik / tekrar kelimeleri kes', icon:'🔁',  desc:'7. Adım — "ee", "şey şey", takılmalar',                   def:false, sens:60 },
  { id:'overlap',    label:'Çakışan sesleri tespit et',         icon:'👥',  desc:'8. Adım — Birden fazla kişi aynı anda konuşuyorsa',       def:false, sens:70 },
  { id:'silences',   label:'Sessiz yerleri kes',                icon:'✂️',  desc:'9. Adım — Son olarak kalan sessizlikleri temizle',         def:true,  sens:75 },
  { id:'peaks',      label:'Ani yüksek sesleri dinle & onayla', icon:'⚡',  desc:'10. Adım — Patlamalar, ani yükselmeler (manuel onay)',     def:false, sens:80, special:'peaks'      },
  { id:'transcript', label:'Transkript ile kesim',              icon:'📝',  desc:'11. Adım — Whisper metni çıkar, seçilen bölgeleri kes',   def:false, sens:null, special:'transcript' },
];

function showCleanupPopup(transcriptReady) {
  const existing = document.getElementById('cleanup-popup');
  if (existing) existing.remove();

  const optsHtml = CLEANUP_OPTIONS.map(o => {
    const isLocked = o.special === 'transcript' && !transcriptReady;
    const hasSlider = o.sens !== null && o.sens !== undefined && !isLocked;
    const sliderHtml = hasSlider ? `
      <div class="copt-slider-row" style="margin-top:6px;display:${o.def?'flex':'none'};align-items:center;gap:8px">
        <span style="color:#64748b;font-size:10px;white-space:nowrap">Hassasiyet</span>
        <input type="range" class="copt-slider" data-id="${o.id}" min="10" max="100" value="${o.sens}"
          style="flex:1;accent-color:#38bdf8;height:3px;cursor:pointer">
        <span class="copt-sens-val" style="color:#38bdf8;font-size:11px;font-weight:700;min-width:32px;text-align:right">${o.sens}%</span>
      </div>` : '';
    const badge = isLocked
      ? `<span style="font-size:9px;background:#1e293b;color:#475569;border-radius:3px;padding:1px 6px">Whisper gerekli</span>`
      : o.special==='transcript'
        ? `<span style="font-size:9px;background:#14532d;color:#4ade80;border-radius:3px;padding:1px 6px">✓ Transkript hazır</span>`
        : o.special==='peaks'
          ? `<span style="font-size:9px;background:#1e3a5f;color:#38bdf8;border-radius:3px;padding:1px 5px">Manuel onay</span>`
          : '';
    return `
    <div class="copt-row" data-id="${o.id}" style="padding:9px 12px;border:1px solid ${o.def&&!isLocked?'#334155':'#1e293b'};border-radius:6px;background:${o.def&&!isLocked?'rgba(255,255,255,0.03)':'transparent'};transition:border-color .15s;opacity:${isLocked?'0.45':'1'}">
      <label style="display:flex;align-items:flex-start;gap:10px;cursor:${isLocked?'not-allowed':'pointer'}">
        <input type="checkbox" class="copt-cb" data-id="${o.id}" ${o.def&&!isLocked?'checked':''} ${isLocked?'disabled':''} style="margin-top:2px;accent-color:#38bdf8;flex-shrink:0;width:15px;height:15px">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:1px;flex-wrap:wrap">
            <span style="font-size:14px">${o.icon}</span>
            <span style="font-weight:600;color:#f1f5f9;font-size:12px">${o.label}</span>
            ${badge}
          </div>
          <div style="color:#64748b;font-size:10px">${o.desc}</div>
        </div>
      </label>
      ${sliderHtml}
    </div>`;
  }).join('');

  const popup = document.createElement('div');
  popup.id = 'cleanup-popup';
  popup.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  popup.innerHTML = `
    <div style="background:#0f172a;border:1px solid #334155;border-radius:12px;width:100%;max-width:480px;max-height:90vh;overflow-y:auto;display:flex;flex-direction:column">
      <div style="padding:16px 16px 12px;border-bottom:1px solid #1e293b;display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
        <div>
          <div style="font-weight:700;color:#f1f5f9;font-size:14px">🧹 Temizleme Seçenekleri</div>
          <div style="color:#64748b;font-size:10px;margin-top:2px">Hangi işlemleri yapmamı istiyorsunuz?</div>
        </div>
        <button id="copt-close" style="background:transparent;border:1px solid #334155;color:#64748b;border-radius:4px;padding:2px 10px;cursor:pointer">✕</button>
      </div>
      <div style="padding:12px 16px;display:flex;flex-direction:column;gap:6px">
        ${optsHtml}
      </div>
      <div style="padding:12px 16px;border-top:1px solid #1e293b;flex-shrink:0">
        <button id="copt-start" style="width:100%;padding:10px;background:#2563eb;border:1px solid #3b82f6;color:#fff;border-radius:7px;cursor:pointer;font-size:13px;font-weight:700">🚀 Temizlemeyi Başlat</button>
      </div>
    </div>`;

  document.body.appendChild(popup);

  // Checkbox değişince border + slider göster/gizle
  popup.querySelectorAll('.copt-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const row = popup.querySelector(`.copt-row[data-id="${cb.dataset.id}"]`);
      if (row) {
        row.style.borderColor = cb.checked ? '#334155' : '#1e293b';
        row.style.background  = cb.checked ? 'rgba(255,255,255,0.03)' : 'transparent';
        const sliderRow = row.querySelector('.copt-slider-row');
        if (sliderRow) sliderRow.style.display = cb.checked ? 'flex' : 'none';
      }
    });
  });

  // Slider değeri güncellenince yüzde etiketini güncelle
  popup.querySelectorAll('.copt-slider').forEach(sl => {
    sl.addEventListener('input', () => {
      const valEl = sl.closest('.copt-slider-row')?.querySelector('.copt-sens-val');
      if (valEl) valEl.textContent = sl.value + '%';
    });
  });

  document.getElementById('copt-close').onclick = () => popup.remove();
  popup.addEventListener('click', e => { if (e.target === popup) popup.remove(); });

  document.getElementById('copt-start').onclick = async () => {
    const selected = [...popup.querySelectorAll('.copt-cb:checked')].map(cb => cb.dataset.id);
    if (!selected.length) return;

    // Hassasiyet değerlerini topla
    const sensMap = {};
    popup.querySelectorAll('.copt-slider').forEach(sl => {
      sensMap[sl.dataset.id] = parseInt(sl.value);
    });

    const hasSpecialPeaks      = selected.includes('peaks');
    const hasSpecialTranscript = selected.includes('transcript');
    const normalOpts           = selected.filter(id => id !== 'peaks' && id !== 'transcript');

    popup.remove();
    await runCleanupPipeline(normalOpts, sensMap, hasSpecialPeaks, hasSpecialTranscript);
  };
}

async function runCleanupPipeline(opts, sensMap, withPeaks, withTranscript) {
  btnCleanDownload.disabled = true;
  btnCleanDownload.textContent = '⏳ Çalışıyor...';

  try {
    // 1. Analiz (yoksa çalıştır)
    if (!state.analysis) {
      btnCleanDownload.textContent = '⏳ Analiz ediliyor...';
      await runAnalysis();
    }

    // 2. Seçilen opsiyonlara göre komut oluştur
    const s = id => sensMap[id] ?? 75; // hassasiyet yüzdesi
    const thresh = id => {
      const v = s(id);
      if (v >= 90) return 'very aggressive (high sensitivity)';
      if (v >= 70) return 'standard sensitivity';
      if (v >= 50) return 'conservative (low sensitivity)';
      return 'minimal sensitivity';
    };
    // Normalize global FFmpeg işlemi — Ollama'ya gönderilmez
    const withNormalize = opts.includes('normalize');
    const normalizeTarget = s('normalize') >= 80 ? -16 : s('normalize') >= 60 ? -20 : -23; // LUFS hedefi

    const parts = [];
    if (opts.includes('bg_noise'))  parts.push(`remove background noise like fan/AC/hum (sensitivity: ${s('bg_noise')}%)`);
    if (opts.includes('music'))     parts.push(`attenuate background music (sensitivity: ${s('music')}%)`);
    if (opts.includes('cough'))     parts.push(`detect and remove coughing/throat-clearing/sneezing (sensitivity: ${s('cough')}%)`);
    if (opts.includes('utensil'))   parts.push(`detect and remove utensil sounds like spoon/fork/plate clinking (sensitivity: ${s('utensil')}%)`);
    if (opts.includes('breath'))    parts.push(`reduce breath sounds (sensitivity: ${s('breath')}%)`);
    if (opts.includes('stutter'))   parts.push(`remove stutters and filler word repetitions (sensitivity: ${s('stutter')}%)`);
    if (opts.includes('overlap'))   parts.push(`detect speaker overlaps (sensitivity: ${s('overlap')}%)`);
    if (opts.includes('silences'))  parts.push(`trim silences (sensitivity: ${s('silences')}% — ${thresh('silences')})`);

    if (!parts.length && !withNormalize && !withPeaks && !withTranscript) {
      btnCleanDownload.textContent = '⚡ Temizle ve İndir';
      btnCleanDownload.disabled = false;
      return;
    }

    let allSegments = [];

    if (parts.length) {
      btnCleanDownload.textContent = '⏳ AI analiz ediyor...';
      const command = parts.join('; ');
      const res = await fetch('/api/command', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({command, analysisContext: state.analysis}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      allSegments = data.result.affected_segments || [];
      applyCommandResult(allSegments);
    }

    if (withTranscript) {
      addLog('info', 'Transkript özelliği yakında — şimdi atlanıyor');
    }

    if (withPeaks) {
      addLog('info', 'Ani yüksek ses onay özelliği yakında — şimdi atlanıyor');
    }

    // 3. Onay ekranı göster
    btnCleanDownload.textContent = '✓ Onaylayın';
    btnCleanDownload.disabled = false;
    setStatus(`${allSegments.length} bölge bulundu`, 'active');
    showApprovalModal(allSegments, withNormalize ? normalizeTarget : null);

  } catch(err) {
    addLog('error', 'Temizleme hatası: ' + err.message);
    setStatus('Hata: ' + err.message, 'idle');
    btnCleanDownload.textContent = '⚡ Temizle ve İndir';
    btnCleanDownload.disabled = false;
  }
}

// ── Sessizlik Eşiği — Inline Panel ───────────────────────────────────────────
function openNoiseGateInline() {
  if (!state.audioBuffer) {
    document.getElementById('ng-host').innerHTML =
      '<div style="text-align:center;color:#64748b;padding:60px;font-size:13px">Önce ses dosyası yükleyin.</div>';
    return;
  }
  // Zaten kurulu ise yeniden kurma
  if (document.getElementById('noisegate-modal')) return;
  try {
    showNoiseGateModal();
  } catch(e) {
    console.error('[NoiseGate] showNoiseGateModal hatası:', e);
    addLog('error', '[Eşik Paneli] Başlatma hatası: ' + e.message, e.stack || '');
    document.getElementById('ng-host').innerHTML =
      `<div style="background:#1a0a0a;border:1px solid #ef4444;border-radius:8px;padding:16px;margin:12px;color:#fca5a5;font-size:12px;font-family:monospace;white-space:pre-wrap">
⚠️ Eşik paneli başlatılamadı:\n${e.message}\n\n${e.stack||''}</div>`;
  }
}

function showNoiseGateModal() {
  if (!state.audioBuffer) return addLog('warn', 'Önce ses dosyası yükleyin');

  // Amplitude verisini al — analiz yapılmışsa saklanmıştır, yoksa AudioBuffer'dan hesapla
  let amp = state._ampData;
  const interval = state._ampInterval || 0.1;

  if (!amp || !amp.length) {
    const chL = state.audioBuffer.getChannelData(0);
    const chR = state.audioBuffer.numberOfChannels > 1 ? state.audioBuffer.getChannelData(1) : chL;
    const sr   = state.audioBuffer.sampleRate;
    const step = Math.floor(sr * 0.1);
    const ampL = [], ampR = [];
    for (let i = 0; i < chL.length; i += step) {
      let pkL = 0, pkR = 0;
      const end = Math.min(i + step, chL.length);
      for (let j = i; j < end; j++) {
        const aL = Math.abs(chL[j]); if (aL > pkL) pkL = aL;
        const aR = Math.abs(chR[j]); if (aR > pkR) pkR = aR;
      }
      ampL.push(Math.round(pkL * 10000) / 10000);
      ampR.push(Math.round(pkR * 10000) / 10000);
    }
    amp = ampL;
    state._ampData     = ampL;
    state._ampDataR    = ampR;
    state._ampInterval = 0.1;
  }
  const ampR = state._ampDataR || amp;

  const dur = state.audioBuffer.duration;

  // ── Otomatik gürültü tabanı ──────────────────────────────────────────────────
  const sorted = [...amp].filter(v => v > 0).sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(sorted.length * 0.05)] || 0.01;
  let threshold    = Math.min(noiseFloor * 4, sorted[Math.floor(sorted.length * 0.18)] || 0.05);
  threshold        = Math.max(0.002, Math.min(0.8, threshold));

  // ── Inline panel içine render ────────────────────────────────────────────────
  const ngHost = document.getElementById('ng-host');
  ngHost.innerHTML = '';  // temizle
  const modal = document.createElement('div');
  modal.id = 'noisegate-modal';
  modal.style.cssText = 'width:100%;display:flex;flex-direction:column;gap:10px;padding:10px;box-sizing:border-box';
  modal.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="color:#f1f5f9;font-size:14px;font-weight:700">🎛 Ses İşleme Pipeline</div>
        <button id="ng-close" style="background:transparent;border:1px solid #334155;color:#94a3b8;border-radius:6px;padding:4px 12px;cursor:pointer;font-size:12px">✕ Kapat</button>
      </div>

      <!-- Proje Adı Çubuğu -->
      <div style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:#0a1628;border:1px solid #1e3a5f;border-radius:7px;flex-wrap:wrap">
        <span style="font-size:11px;color:#475569;white-space:nowrap">📁 Proje:</span>
        <input id="ng-proj-name" type="text" placeholder="Proje adı girin..." value=""
          style="flex:1;min-width:140px;background:#0f172a;border:1px solid #1e3a5f;color:#e2e8f0;border-radius:5px;padding:4px 8px;font-size:12px">
        <button id="ng-proj-save" style="display:none">💾 Kaydet</button>
        <button id="ng-proj-list" style="background:#0f172a;border:1px solid #334155;color:#64748b;border-radius:5px;padding:4px 10px;cursor:pointer;font-size:11px;white-space:nowrap">📋 Projeler</button>
        <button id="ng-clear-db" style="background:#2a0a0a;border:1px solid #dc2626;color:#ef4444;border-radius:5px;padding:5px 12px;cursor:pointer;font-size:11px;font-weight:600;white-space:nowrap" title="Tüm arşiv kayıtlarını sil" onmouseenter="this.style.background='#450a0a'" onmouseleave="this.style.background='#2a0a0a'">🗑 Arşivi Temizle</button>
      </div>
      <!-- Projeler listesi (toggle) -->
      <div id="ng-proj-panel" style="display:none;background:#070d1a;border:1px solid #1e293b;border-radius:8px;padding:8px;max-height:220px;overflow-y:auto"></div>

      <!-- Canvas editör bölümü — pipeline bitmeden gizli -->
      <div id="ng-canvas-section" style="display:none;flex-direction:column;gap:6px">

      <!-- Waveform canvas — L ve R ayrı -->
      <div id="ng-wrap" style="position:relative;user-select:none;border-radius:8px;overflow:hidden;background:#070d1a;display:flex;flex-direction:column;gap:2px">
        <div style="position:relative">
          <label style="position:absolute;left:4px;top:3px;z-index:2;background:rgba(0,0,0,0.65);color:#4ade80;font-size:10px;font-weight:700;padding:2px 6px;border-radius:3px;display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none">
            <input type="checkbox" id="ng-chk-l" checked style="accent-color:#4ade80;width:11px;height:11px;cursor:pointer;margin:0">
            L
          </label>
          <canvas id="ng-canvas-l" height="120" style="width:100%;display:block;cursor:crosshair"></canvas>
          <div id="ng-thr-label" style="position:absolute;right:10px;background:#ef4444;color:#fff;font-size:11px;font-weight:700;padding:2px 7px;border-radius:4px;pointer-events:none;transform:translateY(-50%)"></div>
        </div>
        <div style="position:relative">
          <label style="position:absolute;left:4px;top:3px;z-index:2;background:rgba(0,0,0,0.65);color:#38bdf8;font-size:10px;font-weight:700;padding:2px 6px;border-radius:3px;display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none">
            <input type="checkbox" id="ng-chk-r" checked style="accent-color:#38bdf8;width:11px;height:11px;cursor:pointer;margin:0">
            R
          </label>
          <canvas id="ng-canvas-r" height="120" style="width:100%;display:block;cursor:crosshair"></canvas>
        </div>
        <!-- eski id alias — bazı kodlar hâlâ ng-canvas'a bakıyor -->
        <canvas id="ng-canvas" height="0" style="display:none"></canvas>
      </div>
      <!-- Overlay kontrol paneli -->
      <div id="overlay-controls-container"></div>

      <!-- Çalma + zoom + eşik kontrolleri -->
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <button id="ng-play" style="background:#1e3a5f;border:1px solid #3b82f6;color:#60a5fa;border-radius:6px;padding:6px 16px;cursor:pointer;font-size:14px;font-weight:700;min-width:90px">▶ Çal</button>
        <button id="ng-undo" style="background:#0f172a;border:1px solid #475569;color:#64748b;border-radius:6px;padding:6px 10px;cursor:default;font-size:15px;line-height:1" title="Geri Al (Ctrl+Z)" disabled>↩</button>
        <button id="ng-redo" style="background:#0f172a;border:1px solid #475569;color:#64748b;border-radius:6px;padding:6px 10px;cursor:default;font-size:15px;line-height:1" title="İleri Al (Ctrl+Y)" disabled>↪</button>
        <span id="ng-time" style="font-family:monospace;font-size:12px;color:#94a3b8;min-width:90px">00:00 / --:--</span>
        <div style="height:16px;width:1px;background:#334155"></div>
        <!-- Zoom -->
        <button id="ng-zoom-in"  style="background:#0f172a;border:1px solid #334155;color:#94a3b8;border-radius:5px;padding:4px 11px;cursor:pointer;font-size:14px;font-weight:700" title="Yakınlaştır">+</button>
        <button id="ng-zoom-out" style="background:#0f172a;border:1px solid #334155;color:#94a3b8;border-radius:5px;padding:4px 11px;cursor:pointer;font-size:14px;font-weight:700" title="Uzaklaştır">−</button>
        <button id="ng-zoom-all" style="background:#0f172a;border:1px solid #334155;color:#64748b;border-radius:5px;padding:4px 9px;cursor:pointer;font-size:11px">Tümü</button>
        <span id="ng-zoom-label" style="font-size:11px;color:#f59e0b;min-width:40px;font-weight:700"></span>
        <div style="height:16px;width:1px;background:#334155"></div>
        <!-- Hız -->
        <label style="color:#64748b;font-size:12px">Hız:</label>
        <select id="ng-speed" style="background:#0f172a;border:1px solid #334155;color:#a78bfa;border-radius:5px;padding:3px 6px;font-size:12px;cursor:pointer">
          <option value="0.5">0.5×</option>
          <option value="0.75">0.75×</option>
          <option value="1" selected>1×</option>
          <option value="1.1">1.1×</option>
          <option value="1.2">1.2×</option>
          <option value="1.3">1.3×</option>
          <option value="1.5">1.5×</option>
          <option value="2">2×</option>
        </select>
        <div style="height:16px;width:1px;background:#334155"></div>
        <button id="ng-auto" style="background:#0f2d4a;border:1px solid #334155;color:#60a5fa;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px">🎯 Otomatik</button>
        <label style="color:#64748b;font-size:12px">Eşik:</label>
        <button id="ng-thr-dec" style="background:#1a0a0a;border:1px solid #7f1d1d;color:#fca5a5;border-radius:5px;padding:2px 9px;cursor:pointer;font-size:15px;font-weight:700;line-height:1" title="Eşiği azalt (−)">−</button>
        <input type="range" id="ng-slider" min="1" max="800" style="width:140px;accent-color:#ef4444">
        <button id="ng-thr-inc" style="background:#1a0a0a;border:1px solid #7f1d1d;color:#fca5a5;border-radius:5px;padding:2px 9px;cursor:pointer;font-size:15px;font-weight:700;line-height:1" title="Eşiği artır (+)">+</button>
        <span id="ng-val" style="color:#ef4444;font-size:12px;font-weight:700;min-width:100px"></span>
        <button id="ng-clear-segs" style="background:#1a0a0a;border:1px solid #7f1d1d;color:#f87171;border-radius:5px;padding:3px 10px;cursor:pointer;font-size:12px;font-weight:600" title="Tespit edilen tüm sessizlikleri sil">🗑 Tümünü Sil</button>
        <label style="color:#64748b;font-size:12px">Min:</label>
        <input type="range" id="ng-min-dur" min="1" max="50" value="3" style="width:80px;accent-color:#f59e0b">
        <span id="ng-min-val" style="color:#f59e0b;font-size:12px;font-weight:700;min-width:32px"></span>
        <div id="ng-stats" style="margin-left:auto;color:#94a3b8;font-size:12px;text-align:right"></div>
      </div>
      <!-- L/R Kanal ses seviyesi -->
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:4px 0">
        <span style="color:#4ade80;font-size:12px;font-weight:700">L</span>
        <input type="range" id="ng-vol-l" min="0" max="400" value="100" style="width:100px;accent-color:#4ade80">
        <input type="number" id="ng-vol-l-val" min="0" max="400" value="100" style="width:54px;background:#0f172a;border:1px solid #4ade80;color:#4ade80;border-radius:5px;padding:2px 5px;font-size:11px;font-weight:700;text-align:center">
        <span style="color:#4ade80;font-size:10px;margin-left:-6px">%</span>
        <div style="height:16px;width:1px;background:#334155"></div>
        <span style="color:#38bdf8;font-size:12px;font-weight:700">R</span>
        <input type="range" id="ng-vol-r" min="0" max="400" value="100" style="width:100px;accent-color:#38bdf8">
        <input type="number" id="ng-vol-r-val" min="0" max="400" value="100" style="width:54px;background:#0f172a;border:1px solid #38bdf8;color:#38bdf8;border-radius:5px;padding:2px 5px;font-size:11px;font-weight:700;text-align:center">
        <span style="color:#38bdf8;font-size:10px;margin-left:-6px">%</span>
        <div style="height:16px;width:1px;background:#334155"></div>
        <span style="color:#facc15;font-size:12px;font-weight:700">🔊 Güçlendir</span>
        <input type="range" id="ng-vol-boost" min="100" max="400" value="100" step="5" style="width:120px;accent-color:#facc15">
        <input type="number" id="ng-vol-boost-val" min="100" max="400" value="100" step="5" style="width:54px;background:#0f172a;border:1px solid #facc15;color:#facc15;border-radius:5px;padding:2px 5px;font-size:11px;font-weight:700;text-align:center">
        <span style="color:#facc15;font-size:10px;margin-left:-6px">%</span>
      </div>
      <!-- Gürültü azaltma + sessizlik atlama + temizle satırı -->
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <label style="color:#64748b;font-size:12px;white-space:nowrap">🔇 Gürültü Azaltma:</label>
        <input type="range" id="ng-noise-reduce" min="0" max="100" value="0" style="flex:1;min-width:80px;accent-color:#8b5cf6">
        <span id="ng-noise-val" style="color:#8b5cf6;font-size:12px;font-weight:700;min-width:60px">%0 (kapalı)</span>
        <button id="ng-nclean-btn" style="background:#0f1a14;border:1px solid #14532d;color:#4ade80;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px;font-weight:600;white-space:nowrap">🔇 Gürültü Temizle</button>
        <div style="height:16px;width:1px;background:#334155"></div>
        <label id="ng-skip-label" style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;padding:4px 10px;border:1px solid #22c55e;border-radius:6px;background:#052e16">
          <input type="checkbox" id="ng-skip-sil" checked style="accent-color:#22c55e;width:14px;height:14px;cursor:pointer">
          <span style="color:#22c55e;font-size:12px;font-weight:600">⏭ Sessizlikleri Atla</span>
        </label>
        <span id="ng-skip-info" style="color:#475569;font-size:11px">eşik altındaki bölgeleri atlayarak birleşik dinle</span>
      </div>

      <!-- Gürültü Temizle güç satırı (Gürültü Temizle butonuna basınca açılır) -->
      <div id="ng-nclean-row" style="display:none;align-items:center;gap:8px;flex-wrap:wrap">
        <label style="color:#64748b;font-size:11px;white-space:nowrap">Güç:</label>
        <input id="ng-nclean-str" type="range" min="1" max="10" value="5" style="flex:1;min-width:80px;accent-color:#4ade80">
        <span id="ng-nclean-val" style="color:#4ade80;font-size:11px;min-width:72px">Orta (5)</span>
        <button id="ng-nclean-go" style="background:#14532d;border:1px solid #166534;color:#4ade80;border-radius:5px;padding:4px 12px;cursor:pointer;font-size:12px">İndir</button>
      </div>

      <!-- Manuel kes + uygula -->
      <div style="display:flex;gap:10px;justify-content:space-between;align-items:center;flex-wrap:wrap">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button id="ng-mark" style="background:#7c3aed;border:1px solid #8b5cf6;color:#fff;border-radius:6px;padding:7px 16px;cursor:pointer;font-size:13px;font-weight:600">📌 Kes Başlat</button>
          <span id="ng-mark-info" style="color:#64748b;font-size:11px">Çalarken "Kes Başlat" → istediğin yerde "Kes Bitir" → bölge eklenir</span>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button id="ng-save-settings" style="background:#0f2d1a;border:1px solid #166534;color:#4ade80;border-radius:6px;padding:7px 14px;cursor:pointer;font-size:12px;font-weight:600" title="Konuşmacı isimleri ve gürültü gücü ayarlarını kaydet">💾 Ayarları Kaydet</button>
          <button id="ng-apply" style="background:#dc2626;border:1px solid #ef4444;color:#fff;border-radius:7px;padding:9px 26px;cursor:pointer;font-size:14px;font-weight:700">✂️ Onayla</button>
        </div>
      </div>
      <!-- Manuel kes listesi -->
      <div id="ng-seg-list" style="display:none;background:#070d1a;border:1px solid #1e293b;border-radius:8px;padding:8px 10px;max-height:100px;overflow-y:auto"></div>

      </div><!-- /ng-canvas-section -->

      <!-- Pipeline Adımları -->
      <div style="border:1px solid #1e293b;border-radius:6px;padding:4px 8px;background:#0a0f1a">

        <!-- Adım listesi -->
        <div style="display:flex;flex-direction:column">

          <!-- 1. Whisper -->
          <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:6px 8px;border-bottom:1px solid #1e293b">
            <input type="checkbox" id="ng-chk-whisper" checked style="margin-top:3px;flex-shrink:0">
            <div>
              <div style="font-size:12px;color:#cbd5e1;font-weight:600;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                🎙 1. Whisper — Konuşmayı Yazıya Çevir
                <select id="ng-whisper-model" style="font-size:11px;background:#0f172a;border:1px solid #334155;border-radius:3px;color:#94a3b8;padding:1px 4px;margin-left:auto">
                  <option value="tiny">Tiny (hız)</option><option value="base">Base</option>
                  <option value="small">Small</option><option value="medium">Medium</option>
                  <option value="large" selected>Large (kalite)</option>
                </select>
              </div>
              <div style="font-size:11px;color:#94a3b8;margin-top:3px;line-height:1.5">Ses kaydındaki tüm konuşmalar yazıya çevrilir. Her cümle zaman damgalı olarak kaydedilir. 99 farklı dili otomatik algılar. Sonraki adımlarda kullanılacak konuşma metni oluşturulur.</div>
            </div>
          </label>

          <!-- 1b. Ollama -->
          <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:6px 8px;border-bottom:1px solid #1e293b">
            <input type="checkbox" id="ng-chk-ollama" checked style="margin-top:3px;flex-shrink:0">
            <div>
              <div style="font-size:12px;color:#cbd5e1;font-weight:600">🤖 1b. Ollama — Transkript Temizleme</div>
              <div style="font-size:11px;color:#94a3b8;margin-top:3px;line-height:1.5">1. adımda oluşturulan metindeki gereksiz dolgu kelimeleri (eee, şey, yani, işte) silinir. Noktalama işaretleri düzeltilir. Kekemelik tekrarları tek kelimeye indirilir. 1. adım çalışmadıysa bu adım atlanır.</div>
            </div>
          </label>

          <!-- 2. Demucs -->
          <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:6px 8px;border-bottom:1px solid #1e293b">
            <input type="checkbox" id="ng-chk-step2" checked style="margin-top:3px;flex-shrink:0">
            <div>
              <div style="font-size:12px;color:#cbd5e1;font-weight:600">🎵 2. Vokal İzolasyonu — Arka Plan Temizleme</div>
              <div style="font-size:11px;color:#94a3b8;margin-top:3px;line-height:1.5">Ses kaydındaki müzik, fan, klima, televizyon gibi sürekli arka plan sesleri ayrıştırılır. Sadece insan konuşması korunur, diğer tüm ses kaynakları kaldırılır. GPU ile işlenir, 3-5 dakika sürebilir.</div>
            </div>
          </label>

          <!-- 3. NoiseReduce -->
          <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:6px 8px;border-bottom:1px solid #1e293b">
            <input type="checkbox" id="ng-chk-nr" checked style="margin-top:3px;flex-shrink:0">
            <div>
              <div style="font-size:12px;color:#cbd5e1;font-weight:600">🎛 3. Frekans Bazlı Gürültü Temizleme</div>
              <div style="font-size:11px;color:#94a3b8;margin-top:3px;line-height:1.5">Önceki adımlardan kalan hışırtı, tıslama, vızıltı ve elektrik paraziti gibi frekans bazlı gürültüler temizlenir. Sesin frekans haritası çıkarılır, gürültü profili belirlenir ve sadece gürültü frekansları bastırılır. Konuşma frekansları korunur.</div>
            </div>
          </label>

          <!-- 4. DNS64 -->
          <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:6px 8px;border-bottom:1px solid #1e293b">
            <input type="checkbox" id="ng-chk-enhance" checked style="margin-top:3px;flex-shrink:0">
            <div>
              <div style="font-size:12px;color:#cbd5e1;font-weight:600">🔇 4. Anlık Gürültü Silici</div>
              <div style="font-size:11px;color:#94a3b8;margin-top:3px;line-height:1.5">Öksürük, bardak sesi, kapı kapanması, hapşırma, kalem düşmesi gibi anlık ve kısa süreli gürültüler tespit edilir ve ses kaydından silinir. Ses 60 saniyelik parçalar halinde GPU ile işlenir.</div>
            </div>
          </label>

          <!-- 5. SpeechOnly -->
          <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:6px 8px;border-bottom:1px solid #1e293b">
            <input type="checkbox" id="ng-chk-speech-only" checked style="margin-top:3px;flex-shrink:0">
            <div>
              <div style="font-size:12px;color:#cbd5e1;font-weight:600">🎙️ 5. Konuşma Dışı Sesleri Temizle</div>
              <div style="font-size:11px;color:#94a3b8;margin-top:3px;line-height:1.5">60Hz-8kHz frekans filtresi uygulanır — insan konuşma aralığı dışındaki sesler kesilir. Konuşma olan ve olmayan bölgeler ayrılır. Rüzgar, trafik, ortam uğultusu gibi konuşma dışı sesler temizlenir. Kısık sesli konuşmacılar korunur.</div>
            </div>
          </label>

          <!-- 6. Diarize -->
          <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:6px 8px;border-bottom:1px solid #1e293b">
            <input type="checkbox" id="ng-chk-step4" checked style="margin-top:3px;flex-shrink:0">
            <div style="flex:1">
              <div style="font-size:12px;color:#cbd5e1;font-weight:600">👥 6. Konuşmacı Tespiti</div>
              <div style="font-size:11px;color:#94a3b8;margin-top:3px;margin-bottom:5px;line-height:1.5">Ses kaydında kaç kişi konuşuyor ve her kişi hangi zaman aralığında konuşuyor tespit edilir. Her konuşmacıya etiket atanır (Konuşmacı 1, Konuşmacı 2...). 9. adımda sessiz bölgeler kesilirken bu bilgi kullanılır — kısık sesli konuşmacılar korunur.</div>
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <span style="font-size:11px;color:#64748b">HF Token:</span>
                <input id="ng-hf-token" type="password" placeholder="hf_..." style="flex:1;min-width:100px;background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:4px;padding:2px 6px;font-size:11px">
                <span style="font-size:11px;color:#64748b">Konuşmacı:</span>
                <input id="ng-hf-nspk" type="number" min="1" max="30" placeholder="Oto" style="width:44px;background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:4px;padding:2px 4px;font-size:11px">
              </div>
            </div>
          </label>

          <!-- 7. VAD -->
          <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:6px 8px;border-bottom:1px solid #1e293b">
            <input type="checkbox" id="ng-chk-step5" checked style="margin-top:3px;flex-shrink:0">
            <div>
              <div style="font-size:12px;color:#cbd5e1;font-weight:600">🎚 7. Sessizlik Haritası Oluştur</div>
              <div style="font-size:11px;color:#94a3b8;margin-top:3px;line-height:1.5">Ses kaydı baştan sona taranarak konuşma olan ve olmayan bölgeler işaretlenir. Bu adımda ses kesilmez — sadece bir sessizlik haritası oluşturulur. 9. adımda bu harita ve 6. adımdaki konuşmacı bilgisi birleştirilerek sessiz yerler kesilir.</div>
            </div>
          </label>

          <!-- 8b. Ses Dengeleme -->
          <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:6px 8px;border-bottom:1px solid #1e293b">
            <input type="checkbox" id="ng-chk-normalize" checked style="margin-top:3px;flex-shrink:0">
            <div>
              <div style="font-size:12px;color:#cbd5e1;font-weight:600">🔊 8. Ses Seviyesi Dengeleme (Normalizasyon)</div>
              <div style="font-size:11px;color:#94a3b8;margin-top:3px;line-height:1.5">Kısık sesli konuşmacıların sesi yükseltilir, yüksek sesli konuşmacılar dengelenir. Tüm konuşmacılar benzer ses seviyesine getirilir. 9. adımdaki kesimden önce uygulanır — böylece kısık sesler yanlışlıkla kesilmez.</div>
            </div>
          </label>

          <!-- 9. Cut -->
          <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:6px 8px">
            <input type="checkbox" id="ng-chk-step6" checked style="margin-top:3px;flex-shrink:0">
            <div>
              <div style="font-size:12px;color:#cbd5e1;font-weight:600">✂️ 9. Sessiz Bölgeleri Kes ve Son Halini Oluştur</div>
              <div style="font-size:11px;color:#94a3b8;margin-top:3px;line-height:1.5">7. adımdaki sessizlik haritası ve 6. adımdaki konuşmacı tespiti birleştirilir. Hiçbir konuşmacının konuşmadığı sessiz bölgeler kesilir. 8. adımda ses seviyeleri dengelendiyse kısık sesler korunmuş olur. Temizlenmiş son MP3 dosyası oluşturulur.</div>
            </div>
          </label>

          <!-- Ayırıcı: Ses Güzelleştirme -->
          <div style="border-top:1px solid #1e293b;padding-top:8px;margin-top:4px;font-size:11px;color:#7c3aed;text-align:center;font-weight:600;letter-spacing:.05em">— SES KALİTESİ İYİLEŞTİRME (opsiyonel) —</div>
          <div style="font-size:10px;color:#64748b;text-align:center;padding-bottom:6px">Aşağıdaki adımlar sesin kalitesini artırır. Kayıt kalitesine göre seçin.</div>

          <!-- VoiceFixer -->
          <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:6px 8px;border-bottom:1px solid #1e293b">
            <input type="checkbox" id="ng-chk-voicefixer" style="margin-top:3px;flex-shrink:0">
            <div>
              <div style="font-size:12px;color:#cbd5e1;font-weight:600">🔧 10a. Ses Restorasyonu</div>
              <div style="font-size:11px;color:#94a3b8;margin-top:3px;line-height:1.5">Düşük kaliteli, bozuk veya eski ses kayıtlarını restore eder. Eksik frekansları tamamlar, telefon kaydını stüdyo kalitesine yaklaştırır. Not: Çok konuşmacılı kayıtlarda kısık seslerde pitch bozulması yapabilir — bu durumda kullanmayın.</div>
            </div>
          </label>

          <!-- Resemble Enhance -->
          <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:6px 8px;border-bottom:1px solid #1e293b">
            <input type="checkbox" id="ng-chk-resemble" style="margin-top:3px;flex-shrink:0">
            <div>
              <div style="font-size:12px;color:#cbd5e1;font-weight:600">💎 10b. Yapay Zeka Gürültü Temizleme</div>
              <div style="font-size:11px;color:#94a3b8;margin-top:3px;line-height:1.5">Önceki adımlardan kalan ince gürültüleri temizler. Arka plan seslerini filtreler, konuşma netliğini artırır. Denoise modu ile doğal ses korunur. GPU ile çalışır.</div>
            </div>
          </label>

          <!-- DeepFilterNet -->
          <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:6px 8px">
            <input type="checkbox" id="ng-chk-deepfilter" style="margin-top:3px;flex-shrink:0">
            <div>
              <div style="font-size:12px;color:#cbd5e1;font-weight:600">🔬 10c. Derin Konuşma Filtresi</div>
              <div style="font-size:11px;color:#94a3b8;margin-top:3px;line-height:1.5">Son aşama derin filtreleme — arka plandaki en ince gürültüleri bile temizler. Konuşma sesi korunurken ortam sesleri kaldırılır. Radyo yayını netliğinde ses kalitesi sağlar. Konuşma tonunu ve doğallığını bozmaz. CPU ile çalışır.</div>
            </div>
          </label>
          <!-- Sesi Otomatik Dengele — DeepFilterNet sonrası bağımsız satır -->
          <label id="ng-autoboost-row" style="display:flex;align-items:center;gap:6px;cursor:pointer;padding:4px 8px 6px 30px">
            <input type="checkbox" id="ng-chk-autoboost" checked style="flex-shrink:0">
            <span style="font-size:11px;color:#a5b4fc;font-weight:500">Sesi Otomatik Dengele</span>
            <span title="Düşük sesli bölgeler otomatik tespit edilip yükseltilir" style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:#334155;color:#94a3b8;font-size:9px;cursor:help;flex-shrink:0;font-weight:700">i</span>
          </label>

        </div>

        <!-- Durum satırı (her zaman görünür) -->
        <div id="ng-status-bar" style="display:none;padding:6px 12px;border-radius:6px;font-size:11px;font-weight:600;text-align:center"></div>

        <!-- Pipeline İlerleme (butonun üstünde) -->
        <div id="ng-pipeline-progress" style="display:none;flex-direction:column;gap:4px"></div>

        <!-- Başlat / Durdur -->
        <div style="display:flex;gap:8px">
          <button id="ng-pipeline-btn" style="flex:1;background:linear-gradient(135deg,#1e3a5f,#14532d);border:1px solid #22c55e;color:#fff;border-radius:7px;padding:9px 16px;cursor:pointer;font-size:13px;font-weight:700">
            🚀 Başlat
          </button>
          <button id="ng-pipeline-stop" style="display:none;background:#450a0a;border:1px solid #ef4444;color:#fca5a5;border-radius:7px;padding:9px 12px;cursor:pointer;font-size:12px;font-weight:600">
            ⏹ Durdur
          </button>
        </div>

        <!-- Donanım Dashboard -->
        <div id="ng-hw-dashboard" style="display:none;gap:6px;padding:8px;background:#020609;border:1px solid #1e293b;border-radius:7px;font-size:10px;font-family:monospace">
          <div style="color:#475569;font-size:9px;margin-bottom:4px;font-weight:700;letter-spacing:1px">DONANIM</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
            <div id="ng-hw-cpu" style="background:#0f172a;border:1px solid #1e293b;border-radius:5px;padding:5px 8px">
              <div style="color:#64748b;font-size:9px">CPU</div>
              <div style="color:#38bdf8;font-size:14px;font-weight:700" id="ng-hw-cpu-val">—</div>
              <div style="background:#1e293b;border-radius:3px;height:4px;margin-top:3px"><div id="ng-hw-cpu-bar" style="background:#38bdf8;height:4px;border-radius:3px;width:0%;transition:width 0.5s"></div></div>
            </div>
            <div id="ng-hw-ram" style="background:#0f172a;border:1px solid #1e293b;border-radius:5px;padding:5px 8px">
              <div style="color:#64748b;font-size:9px">RAM</div>
              <div style="color:#a78bfa;font-size:14px;font-weight:700" id="ng-hw-ram-val">—</div>
              <div style="background:#1e293b;border-radius:3px;height:4px;margin-top:3px"><div id="ng-hw-ram-bar" style="background:#a78bfa;height:4px;border-radius:3px;width:0%;transition:width 0.5s"></div></div>
            </div>
            <div id="ng-hw-gpu" style="background:#0f172a;border:1px solid #1e293b;border-radius:5px;padding:5px 8px">
              <div style="color:#64748b;font-size:9px">GPU</div>
              <div style="color:#4ade80;font-size:14px;font-weight:700" id="ng-hw-gpu-val">—</div>
              <div style="background:#1e293b;border-radius:3px;height:4px;margin-top:3px"><div id="ng-hw-gpu-bar" style="background:#4ade80;height:4px;border-radius:3px;width:0%;transition:width 0.5s"></div></div>
            </div>
            <div id="ng-hw-vram" style="background:#0f172a;border:1px solid #1e293b;border-radius:5px;padding:5px 8px">
              <div style="color:#64748b;font-size:9px">VRAM</div>
              <div style="color:#fb923c;font-size:14px;font-weight:700" id="ng-hw-vram-val">—</div>
              <div style="background:#1e293b;border-radius:3px;height:4px;margin-top:3px"><div id="ng-hw-vram-bar" style="background:#fb923c;height:4px;border-radius:3px;width:0%;transition:width 0.5s"></div></div>
            </div>
          </div>
        </div>

        <!-- Sunucu logları -->
        <div id="ng-server-log-wrap" style="display:none;flex-direction:column;gap:4px">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span style="font-size:10px;color:#475569;font-weight:600">📋 Sunucu Logları</span>
            <button id="ng-server-log-btn" style="font-size:10px;padding:2px 8px;background:#0f172a;border:1px solid #334155;color:#64748b;border-radius:4px;cursor:pointer">🔄 Yenile</button>
            <button id="ng-server-log-copy-all" style="font-size:10px;padding:2px 8px;background:#0f172a;border:1px solid #334155;color:#94a3b8;border-radius:4px;cursor:pointer">⎘ Tümünü Kopyala</button>
            <button id="ng-server-log-close" style="font-size:10px;padding:2px 8px;background:transparent;border:none;color:#334155;cursor:pointer;margin-left:auto">✕</button>
          </div>
          <div id="ng-server-log-list" style="background:#020609;border:1px solid #1e293b;border-radius:5px;padding:4px 6px;max-height:220px;overflow-y:auto;font-family:monospace;font-size:9px;color:#64748b"></div>
        </div>

        <!-- Pipeline sonrası aksiyonlar -->
        <div id="ng-post-pipeline" style="display:none;flex-direction:column;gap:7px;padding-top:8px;border-top:1px solid #1e293b">
          <div style="font-size:12px;color:#4ade80;font-weight:700;text-align:center">✅ İşlem tamamlandı</div>

          <!-- Meta Bilgi Formu -->
          <div id="ng-meta-form" style="display:flex;flex-direction:column;gap:5px;padding:10px;background:#0a1628;border:1px solid #1e293b;border-radius:8px">
            <div style="font-size:11px;color:#64748b;font-weight:600;margin-bottom:2px">📋 Kayıt Bilgileri (PDF raporuna yazılır)</div>
            <div style="display:grid;grid-template-columns:120px 1fr;gap:4px 8px;align-items:center;font-size:11px">
              <label style="color:#94a3b8">Ses Kaydının Adı:</label>
              <input id="ng-meta-title" type="text" placeholder="Toplantı kaydı, röportaj vb." style="background:#1e293b;border:1px solid #334155;border-radius:4px;color:#f1f5f9;padding:4px 8px;font-size:11px;outline:none">
              <label style="color:#94a3b8">Çekildiği Yer:</label>
              <input id="ng-meta-location" type="text" placeholder="Ofis, stüdyo, dışarı vb." style="background:#1e293b;border:1px solid #334155;border-radius:4px;color:#f1f5f9;padding:4px 8px;font-size:11px;outline:none">
              <label style="color:#94a3b8">Tarih:</label>
              <input id="ng-meta-date" type="text" placeholder="28.03.2026" style="background:#1e293b;border:1px solid #334155;border-radius:4px;color:#f1f5f9;padding:4px 8px;font-size:11px;outline:none">
              <label style="color:#94a3b8">Konuşmacılar:</label>
              <input id="ng-meta-speakers" type="text" placeholder="Ali Yılmaz, Ayşe Demir..." style="background:#1e293b;border:1px solid #334155;border-radius:4px;color:#f1f5f9;padding:4px 8px;font-size:11px;outline:none">
              <label style="color:#94a3b8">Konu Başlıkları:</label>
              <input id="ng-meta-topics" type="text" placeholder="Bütçe, planlama, proje..." style="background:#1e293b;border:1px solid #334155;border-radius:4px;color:#f1f5f9;padding:4px 8px;font-size:11px;outline:none">
              <label style="color:#94a3b8;align-self:flex-start;margin-top:4px">Notlar:</label>
              <textarea id="ng-meta-notes" rows="3" placeholder="Ek notlar, açıklamalar..." style="background:#1e293b;border:1px solid #334155;border-radius:4px;color:#f1f5f9;padding:4px 8px;font-size:11px;outline:none;resize:vertical;font-family:inherit"></textarea>
            </div>
            <button id="ng-meta-save-btn" style="align-self:flex-end;background:#14532d;border:1px solid #22c55e;color:#4ade80;border-radius:5px;padding:5px 16px;cursor:pointer;font-size:11px;font-weight:600;margin-top:4px">💾 Bilgileri Kaydet</button>
          </div>

          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button id="ng-show-comparison-btn" style="flex:1;background:#1e293b;border:1px solid #f59e0b;color:#fbbf24;border-radius:7px;padding:7px 14px;cursor:pointer;font-size:12px;font-weight:600">
              🔍 Sonuç Ekranı
            </button>
            <button id="ng-to-canvas-btn" style="flex:1;background:#1e3a5f;border:1px solid #3b82f6;color:#60a5fa;border-radius:7px;padding:7px 14px;cursor:pointer;font-size:12px;font-weight:600">
              ✂️ Canvas'ta Düzenle
            </button>
            <button id="ng-download-final-btn" style="flex:1;background:#0f2d1a;border:1px solid #166534;color:#4ade80;border-radius:7px;padding:7px 14px;cursor:pointer;font-size:12px;font-weight:600">
              ⬇ Temizlenmiş Sesi İndir
            </button>
          </div>
          <button id="ng-report-btn" style="display:none;align-items:center;justify-content:center;gap:6px;width:100%;background:#1e3a5f;border:1px solid #3b82f6;color:#60a5fa;border-radius:5px;padding:8px 12px;cursor:pointer;font-size:12px;font-weight:700">
            📄 İşlem Raporunu PDF İndir
          </button>
          <div id="ng-excel-area" style="display:none;flex-direction:column;gap:5px">
            <button id="ng-excel-export-btn" style="width:100%;background:#0f172a;border:1px solid #334155;color:#94a3b8;border-radius:5px;padding:6px 12px;cursor:pointer;font-size:12px;font-weight:600">
              📊 Transkripti Excel Olarak İndir
            </button>
            <label style="display:flex;align-items:center;gap:8px;padding:6px 12px;background:#0f172a;border:1px solid #334155;border-radius:5px;cursor:pointer;font-size:12px;color:#94a3b8;font-weight:600">
              <input type="file" id="ng-excel-import-input" accept=".xlsx,.xls" style="display:none">
              📥 İşaretli Excel'i İçeri Aktar & Uygula
            </label>
          </div>
          <audio id="ng-preview-audio" style="width:100%;height:32px;accent-color:#4ade80" controls></audio>
        </div>

        <!-- Gizli alanlar (backward compat) -->
        <div style="display:none">
          <button id="ng-whisper-btn"></button>
          <button id="ng-denoise-btn"></button>
          <button id="ng-diarize-btn"></button>
          <button id="ng-vad-btn"></button>
          <button id="ng-clear-overlay"></button>
          <button id="ng-hf-go"></button>
          <div id="ng-hf-row"></div>
          <div id="ng-ai-result"></div>
          <div id="ng-whisper-result"></div>
          <div id="ng-ollama-result" style="display:none;margin-top:8px;padding:10px;background:#0f172a;border:1px solid #f59e0b;border-radius:6px;font-size:11px;color:#fde68a;white-space:pre-wrap;max-height:300px;overflow-y:auto"></div>
        </div>
      </div>
    </div>
  `;
  ngHost.appendChild(modal);

  const canvasL  = modal.querySelector('#ng-canvas-l');
  const canvasR  = modal.querySelector('#ng-canvas-r');
  const canvas   = canvasL; // backward compat (mouse events, getW vb.)
  const wrap     = modal.querySelector('#ng-wrap');
  const slider   = modal.querySelector('#ng-slider');
  const valSpan  = modal.querySelector('#ng-val');
  const minDurSl = modal.querySelector('#ng-min-dur');
  const minValSp = modal.querySelector('#ng-min-val');
  const statsDiv = modal.querySelector('#ng-stats');
  const thrLabel = modal.querySelector('#ng-thr-label');
  const chkL     = modal.querySelector('#ng-chk-l');
  const chkR     = modal.querySelector('#ng-chk-r');

  // Kanal seçimi değişince yeniden çiz
  chkL.addEventListener('change', () => draw(threshold));
  chkR.addEventListener('change', () => draw(threshold));

  let minDurSec = 0.3;

  // Hangi kanalların seçili olduğuna göre birleşik genlik dizisini döndür.
  // İkisi de seçiliyse max, sadece biri seçiliyse o kanal, hiçbiri yoksa L.
  function getActiveAmp() {
    const useL = chkL.checked, useR = chkR.checked;
    if (useL && useR) {
      const len = Math.max(amp.length, ampR.length);
      const out = new Float32Array(len);
      for (let i = 0; i < len; i++) out[i] = Math.max(amp[i] || 0, ampR[i] || 0);
      return out;
    }
    if (useR) return ampR;
    return amp; // default: L
  }

  // ── Sessizlik segmentleri hesapla ────────────────────────────────────────────
  function computeSegs(thr, minDur) {
    const src = getActiveAmp();
    const segs = [];
    let inSil = false, silStart = 0;
    for (let i = 0; i < src.length; i++) {
      const t = i * interval;
      if (!inSil && src[i] < thr) { inSil = true; silStart = t; }
      else if (inSil && (src[i] >= thr || i === src.length - 1)) {
        inSil = false;
        const silEnd = t;
        if (silEnd - silStart >= minDur)
          segs.push({ start: +silStart.toFixed(3), end: +silEnd.toFixed(3), action: 'delete', label: 'Sessizlik' });
      }
    }
    return segs;
  }

  // ── Slider ↔ threshold (log scale 0.001 – 0.9) ───────────────────────────
  const LOG_MIN = Math.log10(0.001), LOG_MAX = Math.log10(0.9);
  function sliderToThr(v) { return Math.pow(10, LOG_MIN + (v / 800) * (LOG_MAX - LOG_MIN)); }
  function thrToSlider(t) { return Math.round((Math.log10(Math.max(t, 0.001)) - LOG_MIN) / (LOG_MAX - LOG_MIN) * 800); }

  // Ayarları localStorage'dan yükle
  const _ngSettings = (() => { try { return JSON.parse(localStorage.getItem('ng_settings') || '{}'); } catch(e) { return {}; } })();
  function _saveNgSettings() {
    try {
      localStorage.setItem('ng_settings', JSON.stringify({
        sliderVal: slider.value,
        minDurVal: minDurSl.value,
        speedVal:  modal.querySelector('#ng-speed')?.value,
        noiseVal:  modal.querySelector('#ng-noise-reduce')?.value,
        spStrVal:  modal.querySelector('#ng-nclean-str')?.value,
      }));
    } catch(e) {}
  }

  if (_ngSettings.sliderVal) slider.value = _ngSettings.sliderVal;
  slider.value = _ngSettings.sliderVal || thrToSlider(threshold);
  threshold = sliderToThr(+slider.value);

  slider.addEventListener('input', () => { threshold = sliderToThr(+slider.value); draw(threshold); _saveNgSettings(); });

  // +/− ince ayar: threshold değerine doğrudan ±0.001 ekle (%0.1 adım)
  function thrStep(dir) {
    threshold = Math.max(0.001, Math.min(0.9, threshold + dir * 0.001));
    slider.value = thrToSlider(threshold);
    draw(threshold);
    _saveNgSettings();
  }
  modal.querySelector('#ng-thr-dec').addEventListener('click', () => thrStep(-1));
  modal.querySelector('#ng-thr-inc').addEventListener('click', () => thrStep(+1));

  if (_ngSettings.minDurVal) { minDurSl.value = _ngSettings.minDurVal; minDurSec = +minDurSl.value * 0.1; }
  minDurSl.addEventListener('input', () => {
    minDurSec = +minDurSl.value * 0.1;
    minValSp.textContent = minDurSec.toFixed(1) + 's';
    draw(threshold);
    _saveNgSettings();
  });
  minValSp.textContent = minDurSec.toFixed(1) + 's';

  // ── Oynatma + zoom durumu ─────────────────────────────────────────────────────
  let ngAudio      = null;  // HTMLAudioElement (pitch-corrected speed)
  let ngAudioUrl   = null;  // Blob URL
  let ngPlaying    = false;
  let ngOffset     = 0;
  let ngRaf        = null;
  let ngMarkStart  = null;
  let ngSelStart   = null, ngSelEnd = null; // Sürükle-seç bölgesi
  let _dragSelAnchor = null;
  const manualSegs = [];
  // ── Geçmiş (undo/redo) sistemi ────────────────────────────────────────────────
  let _hist = [[]], _histIdx = 0; // snapshot dizisi
  function _snapManual() { return manualSegs.map(s => ({...s})); }
  function _restoreManual(snap) { manualSegs.splice(0, manualSegs.length, ...snap.map(s => ({...s}))); }
  function _saveHist() {
    _hist = _hist.slice(0, _histIdx + 1);
    _hist.push(_snapManual());
    _histIdx = _hist.length - 1;
    _syncHistBtns();
  }
  function _histUndo() {
    if (_histIdx <= 0) return;
    _histIdx--;
    _restoreManual(_hist[_histIdx]);
    refreshSegList(); draw(threshold); _syncHistBtns();
  }
  function _histRedo() {
    if (_histIdx >= _hist.length - 1) return;
    _histIdx++;
    _restoreManual(_hist[_histIdx]);
    refreshSegList(); draw(threshold); _syncHistBtns();
  }
  function _syncHistBtns() {
    const u = modal.querySelector('#ng-undo'), r = modal.querySelector('#ng-redo');
    if (u) {
      const can = _histIdx > 0;
      u.disabled = !can;
      u.style.background    = can ? '#1e3a5f' : '#0f172a';
      u.style.borderColor   = can ? '#3b82f6' : '#475569';
      u.style.color         = can ? '#60a5fa' : '#64748b';
      u.style.cursor        = can ? 'pointer' : 'default';
      u.title = can ? `Geri Al (${_histIdx} adım) — Ctrl+Z` : 'Geri Al (Ctrl+Z)';
    }
    if (r) {
      const can = _histIdx < _hist.length - 1;
      r.disabled = !can;
      r.style.background    = can ? '#1e3a5f' : '#0f172a';
      r.style.borderColor   = can ? '#3b82f6' : '#475569';
      r.style.color         = can ? '#60a5fa' : '#64748b';
      r.style.cursor        = can ? 'pointer' : 'default';
      r.title = can ? `İleri Al (${_hist.length-1-_histIdx} adım) — Ctrl+Y` : 'İleri Al (Ctrl+Y)';
    }
  }

  // Zoom: görünür pencere [ngVS, ngVE] (saniye)
  let ngVS = 0, ngVE = dur;
  let ngSpeed       = 1.0;
  let ngNoiseReduce = 0.0; // 0 = kapalı, 1 = tamamen sus — varsayılan kapalı
  let _canvasW      = 0;   // son geçerli canvas genişliği

  const btnPlay        = modal.querySelector('#ng-play');
  const timeDisp       = modal.querySelector('#ng-time');
  const btnMark        = modal.querySelector('#ng-mark');
  const btnUndo        = modal.querySelector('#ng-undo');
  const markInfo       = modal.querySelector('#ng-mark-info');
  const segList        = modal.querySelector('#ng-seg-list');
  const zoomLabel      = modal.querySelector('#ng-zoom-label');
  const speedSel       = modal.querySelector('#ng-speed');
  const noiseReduceSl  = modal.querySelector('#ng-noise-reduce');
  const noiseReduceVal = modal.querySelector('#ng-noise-val');
  const skipSilCb      = modal.querySelector('#ng-skip-sil');

  // Akıllı analiz overlay verileri
  let ngVadSegs      = [];   // [{start, end}] — VAD konuşma bölgeleri
  let ngDiarizeSegs  = [];   // [{start, end, speaker, speakerIdx}]

  // Konuşmacı dinleme — modal scope'ta tek örnek
  let _spAudio = null, _spPlaying = null, _spToken = 0, _spActiveBtn = null;
  function stopSpAudio() {
    _spToken++;
    if (_spAudio) { _spAudio.pause(); _spAudio.src = ''; _spAudio = null; }
    if (_spActiveBtn) { _spActiveBtn.textContent = '▶'; _spActiveBtn.style.background = '#0f172a'; _spActiveBtn = null; }
    if (_spPlaying) {
      // Fallback: attribute ile de ara (eski panel'deki butonlar için)
      const old = document.querySelector(`[data-sp-play="${CSS.escape(_spPlaying)}"]`);
      if (old) { old.textContent = '▶'; old.style.background = '#0f172a'; }
      _spPlaying = null;
    }
  }
  function playSpeaker(spId, btn) {
    if (_spPlaying === spId) { stopSpAudio(); return; }
    stopSpAudio();
    const segs = ngDiarizeSegs.filter(s => s.speaker === spId).sort((a, b) => a.start - b.start);
    if (!segs.length || !_rawFileBlob) return;
    const myToken = ++_spToken;
    const url = ngAudioUrl || URL.createObjectURL(_rawFileBlob);
    _spAudio = new Audio(url);
    _spPlaying = spId;
    _spActiveBtn = btn;
    btn.textContent = '⏹'; btn.style.background = '#1e3a5f';
    let idx = 0;
    const audio = _spAudio;
    function playNext() {
      if (_spToken !== myToken) return;  // başka biri durdurdu
      if (idx >= segs.length) { stopSpAudio(); return; }
      const seg = segs[idx++];
      audio.currentTime = seg.start;
      audio.play().catch(() => { if (_spToken === myToken) stopSpAudio(); });
      function onTime() {
        if (_spToken !== myToken) { audio.removeEventListener('timeupdate', onTime); return; }
        if (audio.currentTime >= seg.end) {
          audio.removeEventListener('timeupdate', onTime);
          playNext();
        }
      }
      audio.addEventListener('timeupdate', onTime);
    }
    playNext();
  }

  let ngSkipSilence = true;
  skipSilCb.addEventListener('change', () => {
    ngSkipSilence = skipSilCb.checked;
    const label = modal.querySelector('#ng-skip-label');
    label.style.borderColor  = ngSkipSilence ? '#22c55e' : '#334155';
    label.style.background   = ngSkipSilence ? '#052e16' : '#0f172a';
  });

  function getW() { return canvas.getBoundingClientRect().width || _canvasW || 1200; }

  function updateZoomLabel() {
    const ratio = dur / (ngVE - ngVS);
    zoomLabel.textContent = ratio < 1.05 ? '1×' : `${ratio.toFixed(1)}×`;
  }
  function tToX(t, W) { return ((t - ngVS) / (ngVE - ngVS)) * W; }
  function xToT(x, W) { return ngVS + (x / W) * (ngVE - ngVS); }

  // Hız slider — kayıtlı değeri yükle
  if (_ngSettings.speedVal) speedSel.value = _ngSettings.speedVal;
  ngSpeed = +speedSel.value;
  speedSel.addEventListener('change', () => {
    ngSpeed = +speedSel.value;
    if (ngAudio) ngAudio.playbackRate = ngSpeed;
    _saveNgSettings();
  });

  // Gürültü azaltma slider — her zaman 0'dan başlasın (oynatma sırasında ses kesmez)
  noiseReduceSl.value = 0;
  ngNoiseReduce = 0;
  noiseReduceSl.addEventListener('input', () => {
    ngNoiseReduce = +noiseReduceSl.value / 100;
    const pct = +noiseReduceSl.value;
    noiseReduceVal.textContent = pct === 100 ? '%100 (tam)' : pct === 0 ? '%0 (kapalı)' : `%${pct}`;
    draw(threshold);
    _saveNgSettings();
  });

  function refreshSegList() {
    if (!manualSegs.length) { segList.style.display = 'none'; btnUndo.style.display = 'none'; return; }
    segList.style.display = 'block';
    btnUndo.style.display = '';
    segList.innerHTML = manualSegs.map((sg, i) =>
      `<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;font-size:11px;border-bottom:1px solid #1e293b">
        <span style="color:#f97316;font-family:monospace">${formatMM(sg.start)} – ${formatMM(sg.end)}</span>
        <span style="color:#64748b;margin:0 8px">${(sg.end - sg.start).toFixed(2)}s</span>
        <button onclick="this.closest('[id=noisegate-modal]') && window._ngRemoveSeg(${i})" style="background:transparent;border:none;color:#ef4444;cursor:pointer;font-size:12px;padding:0 4px">✕</button>
      </div>`
    ).join('');
  }
  window._ngRemoveSeg = (i) => {
    manualSegs.splice(i, 1);
    refreshSegList();
    draw(threshold);
  };

  function ngCurrentTime() {
    // Oynarken audio elementinin gerçek zamanını kullan,
    // duraklatılmış/seek sırasında ngOffset'i kullan (currentTime asenkron güncellenir)
    if (ngPlaying && ngAudio) return Math.min(dur, ngAudio.currentTime);
    return ngOffset;
  }

  function formatMM(s) {
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2,'0')}:${String(Math.floor(s % 60)).padStart(2,'0')}`;
  }

  // ── Canvas çiz (zoom + playhead + susturulan bölgeler) ───────────────────────
  function draw(thr) {
    const W = Math.round(getW());
    if (W > 0) _canvasW = W;
    const viewDur = ngVE - ngVS;
    const silSegs = computeSegs(thr, minDurSec);
    const SPEAKER_COLORS = ['rgba(59,130,246,0.22)','rgba(249,115,22,0.22)',
                             'rgba(168,85,247,0.22)','rgba(236,72,153,0.22)',
                             'rgba(20,184,166,0.22)'];

    // Draw one full-height channel canvas
    // isTop=true → L canvas (seek strip + playhead triangle + time label)
    // isTop=false → R canvas (time ruler at bottom)
    // isActive=false → channel unchecked: dim waveform, hide threshold/silence overlays
    function drawCh(cv, ampData, barColor, silColor, isTop, isActive) {
      if (cv.width !== W && W > 0) cv.width = W;
      const H = cv.height, mid = H / 2;
      const c = cv.getContext('2d');

      // Background — slightly darker when inactive
      c.fillStyle = isActive ? '#070d1a' : '#040810'; c.fillRect(0, 0, W, H);
      // Seek strip (top canvas only)
      if (isTop) { c.fillStyle = 'rgba(250,204,21,0.06)'; c.fillRect(0, 0, W, 20); }
      // Right threshold zone (only when active)
      if (isActive) { c.fillStyle = 'rgba(239,68,68,0.06)'; c.fillRect(W * 0.85, 0, W * 0.15, H); }

      // Center line
      c.strokeStyle = 'rgba(255,255,255,0.08)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(0, mid); c.lineTo(W, mid); c.stroke();

      // Amplitude bars (symmetric, full height)
      const iStart   = Math.max(0, Math.floor(ngVS / interval));
      const iEnd     = Math.min(ampData.length, Math.ceil(ngVE / interval) + 1);
      const visCount = iEnd - iStart;
      // When inactive: draw waveform dimmed, no color distinction for threshold
      const activeBarColor = isActive ? barColor : barColor.replace(/[\d.]+\)$/, '0.25)');
      const activeSilColor = isActive ? silColor : silColor.replace(/[\d.]+\)$/, '0.18)');
      for (let x = 0; x < W; x++) {
        const fi = iStart + (x / W) * visCount;
        const i0 = Math.floor(fi), i1 = Math.min(i0 + Math.max(1, Math.ceil(visCount / W)), iEnd);
        let pk = 0;
        for (let i = i0; i < i1; i++) { if (ampData[i] > pk) pk = ampData[i]; }
        const barH = Math.max(1, pk * (mid - 4));
        c.fillStyle = (isActive && pk < thr) ? activeSilColor : activeBarColor;
        c.fillRect(x, mid - barH, 1, barH * 2);
      }

      // Silence darkening (only for active/checked channels)
      if (isActive) {
        c.fillStyle = 'rgba(0,0,0,0.22)';
        silSegs.forEach(sg => {
          const x1 = tToX(sg.start, W), x2 = tToX(sg.end, W);
          if (x2 < 0 || x1 > W) return;
          c.fillRect(Math.max(0, x1), 0, Math.min(W, x2) - Math.max(0, x1), H);
        });
      }

      // Manual segments (orange/red deleted regions)
      manualSegs.forEach(sg => {
        const x1 = tToX(sg.start, W), x2 = tToX(sg.end, W);
        if (x2 < 0 || x1 > W) return;
        c.fillStyle = 'rgba(249,115,22,0.35)';
        c.fillRect(Math.max(0, x1), 0, Math.min(W, x2) - Math.max(0, x1), H);
        [x1, x2].forEach(x => {
          if (x < 0 || x > W) return;
          c.strokeStyle = '#f97316'; c.lineWidth = 1.5;
          c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
        });
      });

      // ── Overlay katmanları (AI segmentler, konuşmacılar, VAD) ──
      CanvasOverlay.draw(c, W, H, ngVS, ngVE, isTop);

      // Threshold lines (dashed — dimmed when channel inactive)
      const thrY = mid - thr * (mid - 2);
      c.strokeStyle = isActive ? '#ef4444' : 'rgba(239,68,68,0.25)'; c.lineWidth = isActive ? 2 : 1; c.setLineDash([7, 5]);
      c.beginPath(); c.moveTo(0, thrY); c.lineTo(W, thrY); c.stroke();
      c.strokeStyle = isActive ? 'rgba(239,68,68,0.35)' : 'rgba(239,68,68,0.12)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(0, mid + thr * (mid - 2)); c.lineTo(W, mid + thr * (mid - 2)); c.stroke();
      c.setLineDash([]);

      // Selection region
      if (ngSelStart !== null && ngSelEnd !== null && ngSelEnd > ngSelStart) {
        const sx1 = Math.max(0, tToX(ngSelStart, W)), sx2 = Math.min(W, tToX(ngSelEnd, W));
        c.fillStyle = 'rgba(56,189,248,0.18)'; c.fillRect(sx1, 0, sx2 - sx1, H);
        c.strokeStyle = '#38bdf8'; c.lineWidth = 1.5;
        [sx1, sx2].forEach(x => { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); });
      }

      // Mark start region
      if (ngMarkStart !== null) {
        const xs = tToX(ngMarkStart, W), xp = tToX(ngCurrentTime(), W);
        if (xs >= 0 && xs <= W) {
          c.strokeStyle = '#f97316'; c.lineWidth = 2; c.setLineDash([4, 3]);
          c.beginPath(); c.moveTo(xs, 0); c.lineTo(xs, H); c.stroke();
          c.setLineDash([]);
        }
        if (xp > xs) { c.fillStyle = 'rgba(249,115,22,0.14)'; c.fillRect(Math.max(0,xs), 0, Math.min(W,xp)-Math.max(0,xs), H); }
      }

      // Playhead
      const xph = tToX(ngCurrentTime(), W);
      if (xph >= 0 && xph <= W) {
        c.strokeStyle = '#facc15'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(xph, 0); c.lineTo(xph, H); c.stroke();
        if (isTop) {
          // Triangle handle + time label on L canvas
          c.fillStyle = '#facc15';
          c.beginPath(); c.moveTo(xph - 9, 0); c.lineTo(xph + 9, 0); c.lineTo(xph, 17); c.closePath(); c.fill();
          c.strokeStyle = '#fff'; c.lineWidth = 0.8; c.stroke();
          c.fillStyle = '#facc15'; c.font = 'bold 10px monospace';
          const lx = Math.min(W - 50, Math.max(0, xph - 18));
          c.fillText(formatMM(ngCurrentTime()), lx, 26);
        }
      }

      // Time ruler (R canvas only, at bottom)
      if (!isTop) {
        c.fillStyle = 'rgba(255,255,255,0.55)'; c.font = '10px monospace';
        const tickCount = Math.min(20, Math.floor(W / 60));
        for (let i = 0; i <= tickCount; i++) {
          const t = ngVS + (i / tickCount) * viewDur;
          c.fillText(formatMM(t), (i / tickCount) * W + 2, H - 4);
        }
      }
    }

    drawCh(canvasL, amp,  'rgba(74,222,128,0.82)', 'rgba(59,130,246,0.45)', true,  chkL.checked);
    drawCh(canvasR, ampR, 'rgba(56,189,248,0.82)', 'rgba(59,130,246,0.35)', false, chkR.checked);

    // Threshold label overlay (on L canvas — hide when L is inactive)
    const thrYL = canvasL.height / 2 - thr * (canvasL.height / 2 - 2);
    const pct = (thr * 100).toFixed(1);
    const db  = thr > 0 ? (20 * Math.log10(thr)).toFixed(1) : '-∞';
    thrLabel.textContent = `${pct}% / ${db} dBFS`;
    thrLabel.style.top     = thrYL + 'px';
    thrLabel.style.opacity = chkL.checked ? '1' : '0.3';

    // Stats + time display
    const totalCut = silSegs.reduce((s, g) => s + (g.end - g.start), 0) + manualSegs.reduce((s,g)=>s+(g.end-g.start),0);
    valSpan.textContent = `${pct}%  /  ${db} dBFS`;
    statsDiv.innerHTML  = `<span style="color:#ef4444;font-weight:700">${silSegs.length}</span> eşik + <span style="color:#f97316;font-weight:700">${manualSegs.length}</span> manuel · <span style="color:#ef4444;font-weight:700">${totalCut.toFixed(1)}s</span>`;
    timeDisp.textContent = `${formatMM(ngCurrentTime())} / ${formatMM(dur)}`;
    updateZoomLabel();
  }

  // ── Zoom penceresini t etrafında ortala (playhead takibi) ────────────────────
  function ngCenterView(t) {
    const viewDur = ngVE - ngVS;
    ngVS = Math.max(0, t - viewDur / 2);
    ngVE = Math.min(dur, ngVS + viewDur);
    if (ngVE >= dur) { ngVS = Math.max(0, dur - viewDur); ngVE = dur; }
  }

  // ── RAF animasyon döngüsü (oynarken) ─────────────────────────────────────────
  let _skipLock = false;  // seek tamamlanana kadar tekrar seek engeli

  function ngLoop() {
    const t = ngCurrentTime();

    // Manuel kesim bölgelerini atla (her zaman aktif)
    if (ngAudio && !_skipLock && manualSegs.length) {
      for (const sg of manualSegs) {
        if (t >= sg.start && t < sg.end) {
          _skipLock = true;
          ngAudio.currentTime = sg.end;
          ngAudio.addEventListener('seeked', () => { _skipLock = false; }, { once: true });
          break;
        }
      }
    }

    // Sessizlikleri atla: eşik altındaki bölgenin sonuna zıpla
    if (ngSkipSilence && ngAudio && !_skipLock) {
      const silSegs = computeSegs(threshold, minDurSec);
      for (const sg of silSegs) {
        if (t >= sg.start && t < sg.end) {
          _skipLock = true;
          ngAudio.currentTime = sg.end;
          ngAudio.addEventListener('seeked', () => { _skipLock = false; }, { once: true });
          break;
        }
      }
    }

    // Gürültü azaltma — sessizlik bölgelerinde ses kısılır (varsayılan kapalı)
    if (ngAudio && ngNoiseReduce > 0) {
      const activeAmp = getActiveAmp();
      const idx   = Math.min(Math.floor(t / interval), activeAmp.length - 1);
      const isSil = (activeAmp[idx] || 0) < threshold;
      ngAudio.volume = isSil ? Math.max(0, 1 - ngNoiseReduce) : 1;
    } else if (ngAudio) {
      ngAudio.volume = 1;
    }

    // Playhead görünüm penceresinin dışına çıkınca veya kenar %15'e girince ortala
    const viewDur = ngVE - ngVS;
    if (t < ngVS || t > ngVE - viewDur * 0.15) ngCenterView(t);

    draw(threshold);
    if (t >= dur) { ngStop(); return; }
    ngRaf = requestAnimationFrame(ngLoop);
  }

  function ngStop() {
    if (ngAudio) { ngOffset = Math.min(ngAudio.currentTime, dur); ngAudio.pause(); }
    if (ngRaf) { cancelAnimationFrame(ngRaf); ngRaf = null; }
    _skipLock = false;
    if (ngAudio) ngAudio.volume = 1;
    ngPlaying = false;
    btnPlay.textContent = '▶ Çal';
    draw(threshold);
  }

  // Ruler tıklaması buraya ulaşsın
  window._ngSeek = t => {
    ngOffset = Math.max(0, Math.min(dur, t));
    if (ngAudio) ngAudio.currentTime = ngOffset;
    if (!ngPlaying) draw(threshold);
  };

  // ── Çal / Durdur ─────────────────────────────────────────────────────────────
  btnPlay.onclick = () => {
    console.log('[ng-play] tıklandı, ngPlaying=', ngPlaying, '_rawFileBlob=', !!_rawFileBlob, 'ngAudioUrl=', !!ngAudioUrl);
    if (ngPlaying) { ngStop(); return; }

    // HTMLAudioElement oluştur (bir kez)
    if (!ngAudioUrl && _rawFileBlob) ngAudioUrl = URL.createObjectURL(_rawFileBlob);

    if (!ngAudio && ngAudioUrl) {
      ngAudio = new Audio(ngAudioUrl);
      ngAudio.preservesPitch       = true;
      ngAudio.mozPreservesPitch    = true;
      ngAudio.webkitPreservesPitch = true;
      // L/R ayrı gain — WebAudio routing
      try {
        const actx = getCtx();
        const src   = actx.createMediaElementSource(ngAudio);
        const split = actx.createChannelSplitter(2);
        const gainL = actx.createGain();
        const gainR = actx.createGain();
        const merge = actx.createChannelMerger(2);
        const gainBoost = actx.createGain();
        src.connect(split);
        split.connect(gainL, 0); split.connect(gainR, 1);
        gainL.connect(merge, 0, 0); gainR.connect(merge, 0, 1);
        merge.connect(gainBoost);
        gainBoost.connect(actx.destination);
        ngAudio._gainL = gainL; ngAudio._gainR = gainR; ngAudio._gainBoost = gainBoost;
        // Slider bağlantısı — L/R kanal + boost
        const slL = modal.querySelector('#ng-vol-l');
        const slR = modal.querySelector('#ng-vol-r');
        const slB = modal.querySelector('#ng-vol-boost');
        const vlL = modal.querySelector('#ng-vol-l-val');
        const vlR = modal.querySelector('#ng-vol-r-val');
        const vlB = modal.querySelector('#ng-vol-boost-val');

        // Slider ↔ number input çift yönlü bağlantı
        function bindVolPair(slider, numInput, applyFn) {
          if (!slider || !numInput) return;
          const clamp = v => Math.max(+numInput.min, Math.min(+numInput.max, v));
          slider.addEventListener('input', () => {
            numInput.value = slider.value;
            applyFn(+slider.value);
          });
          numInput.addEventListener('input', () => {
            const v = clamp(+numInput.value || 0);
            slider.value = v; applyFn(v);
          });
          numInput.addEventListener('change', () => {
            const v = clamp(+numInput.value || 0);
            numInput.value = v; slider.value = v; applyFn(v);
          });
        }

        bindVolPair(slL, vlL, v => { gainL.gain.value = v / 100; });
        bindVolPair(slR, vlR, v => { gainR.gain.value = v / 100; });
        bindVolPair(slB, vlB, v => { gainBoost.gain.value = v / 100; window._ngBoostValue = v / 100; });
        window._ngBoostValue = +(slB?.value || 100) / 100;
      } catch(e) { /* eski tarayıcı fallback */ }
    }

    if (!ngAudio) {
      const why = !_rawFileBlob ? 'Dosya yüklenmemiş (_rawFileBlob null)' : !ngAudioUrl ? 'URL oluşturulamadı' : 'ngAudio oluşturulamadı';
      addLog('error', '▶ Çal — ' + why);
      btnPlay.textContent = '⚠ ' + why;
      setTimeout(() => { btnPlay.textContent = '▶ Çal'; }, 3000);
      return;
    }

    if (ngOffset >= dur) ngOffset = 0;
    ngAudio.playbackRate = ngSpeed;
    ngAudio.currentTime  = ngOffset;
    ngAudio.play().catch(err => {
      addLog('error', '▶ Çal — play() hatası: ' + err.message);
      btnPlay.textContent = '⚠ ' + err.message;
      setTimeout(() => { btnPlay.textContent = '▶ Çal'; }, 3000);
    });
    ngAudio.onended = () => { if (ngPlaying) ngStop(); };

    ngPlaying = true;
    btnPlay.textContent = '⏸ Durdur';
    ngRaf = requestAnimationFrame(ngLoop);
  };

  // ── Canvas: eşik sürükle (dikey) | playhead sürükle (yatay, üst %30) ─────────
  let dragging = false, dragMoved = false, dragMode = 'thresh'; // 'thresh' | 'seek' | 'select'
  let _phDragging = false;

  // Track which canvas was the drag source (for threshold Y calculation)
  let _dragCanvas = canvasL;

  // Cursor güncelle — handle üzerinde pointer, sağ %15 ns-resize, diğerleri crosshair
  wrap.addEventListener('mousemove', e => {
    if (dragging) return;
    const tgt  = (e.target === canvasR) ? canvasR : canvasL;
    const rect = tgt.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const W    = getW();
    const xph  = tToX(ngCurrentTime(), W);
    const clickPx = relX * rect.width;
    const topY = e.clientY - canvasL.getBoundingClientRect().top;
    const onHandle = Math.abs(clickPx - xph) < 14 && topY < 22;
    if ((topY < 20 && e.target === canvasL) || onHandle) tgt.style.cursor = 'pointer';
    else if (relX > 0.85) tgt.style.cursor = 'ns-resize';
    else tgt.style.cursor = 'crosshair';
  });

  wrap.addEventListener('mousedown', e => {
    _dragCanvas = (e.target === canvasR) ? canvasR : canvasL;
    const rect  = _dragCanvas.getBoundingClientRect();
    const relX  = (e.clientX - rect.left) / rect.width;
    const clickT = Math.max(0, Math.min(dur, xToT(relX * getW(), getW())));
    const W     = getW();
    const xph   = tToX(ngCurrentTime(), W);
    const clickPx = relX * rect.width;
    // Seek strip: only top 20px of L canvas; or dragging the yellow triangle handle
    const topY    = e.clientY - canvasL.getBoundingClientRect().top;
    const onHandle = Math.abs(clickPx - xph) < 14 && topY < 22;
    const inTopStrip = e.target === canvasL && topY < 20;
    const inThreshZone = relX > 0.85;
    if (inTopStrip || onHandle) {
      dragMode = 'seek';
    } else if (inThreshZone) {
      dragMode = 'thresh';
    } else {
      dragMode = 'select';
    }
    dragging  = true;
    dragMoved = false;
    e.preventDefault();
    _dragSelAnchor = clickT;
    if (dragMode === 'seek') {
      ngOffset = clickT;
      if (ngAudio) ngAudio.currentTime = ngOffset;
      if (!ngPlaying) draw(threshold);
    } else if (dragMode === 'select') {
      ngSelStart = null; ngSelEnd = null;
      if (!ngPlaying) draw(threshold);
    }
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const rect = _dragCanvas.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const t    = Math.max(0, Math.min(dur, xToT(relX * getW(), getW())));
    if (dragMode === 'select') {
      if (!dragMoved && Math.abs(e.movementX) < 3) return;
      dragMoved = true;
      ngSelStart = Math.min(_dragSelAnchor, t);
      ngSelEnd   = Math.max(_dragSelAnchor, t);
      const viewDur = ngVE - ngVS;
      const edgeFrac = 0.08;
      if (relX < edgeFrac && ngVS > 0) {
        const shift = viewDur * 0.12 * (edgeFrac - relX) / edgeFrac;
        ngVS = Math.max(0, ngVS - shift); ngVE = ngVS + viewDur;
      } else if (relX > 1 - edgeFrac && ngVE < dur) {
        const shift = viewDur * 0.12 * (relX - (1 - edgeFrac)) / edgeFrac;
        ngVE = Math.min(dur, ngVE + shift); ngVS = ngVE - viewDur;
      }
      draw(threshold);
    } else if (dragMode === 'seek') {
      dragMoved = true;
      const viewDur = ngVE - ngVS;
      const edge = 0.05; // sol/sağ %5 = pan bölgesi
      if (relX < edge && ngVS > 0) {
        // frac 0→1 arası (kenar=%5, dışı da max 1'e sabitlendi)
        const frac = Math.min(1, Math.max(0, edge - relX) / edge);
        const speed = frac * viewDur * 0.008; // çok yavaş, hassas
        ngVS = Math.max(0, ngVS - speed);
        ngVE = ngVS + viewDur;
      } else if (relX > 1 - edge && ngVE < dur) {
        const frac = Math.min(1, Math.max(0, relX - (1 - edge)) / edge);
        const speed = frac * viewDur * 0.008;
        ngVE = Math.min(dur, ngVE + speed);
        ngVS = ngVE - viewDur;
      }
      // Panning sonrası güncel view'a göre zaman hesapla
      ngOffset = Math.max(0, Math.min(dur, xToT(relX * getW(), getW())));
      if (ngAudio) ngAudio.currentTime = ngOffset;
      if (!ngPlaying) draw(threshold);
    } else {
      dragMoved = true;
      // Threshold drag (vertical) — use the canvas that was clicked
      const relY = (e.clientY - rect.top) / rect.height * _dragCanvas.height;
      const mid  = _dragCanvas.height / 2;
      threshold  = Math.max(0.001, Math.min(0.95, (mid - relY) / (mid - 2)));
      slider.value = thrToSlider(threshold);
      draw(threshold);
    }
  });
  window.addEventListener('mouseup', e => {
    dragging = false;
  });

  // Scroll = pan (yatay kaydır) veya Alt+scroll = zoom
  wrap.addEventListener('wheel', e => {
    e.preventDefault();
    const viewDur = ngVE - ngVS;
    if (e.ctrlKey || e.altKey) {
      // Ctrl/Alt + scroll = zoom (fare konumunu merkez al)
      const rect = canvas.getBoundingClientRect();
      const cx   = xToT((e.clientX - rect.left) / rect.width * (canvas.offsetWidth || 1), canvas.offsetWidth || 1);
      const factor = e.deltaY > 0 ? 1.25 : 0.8;
      const newDur = Math.max(0.5, Math.min(dur, viewDur * factor));
      ngVS = Math.max(0, cx - (cx - ngVS) * (newDur / viewDur));
      ngVE = Math.min(dur, ngVS + newDur);
      if (ngVE >= dur) { ngVE = dur; ngVS = Math.max(0, dur - newDur); }
    } else {
      // Scroll = pan
      const shift = viewDur * 0.15 * (e.deltaY > 0 ? 1 : -1);
      ngVS = Math.max(0, Math.min(dur - viewDur, ngVS + shift));
      ngVE = ngVS + viewDur;
    }
    draw(threshold);
  }, { passive: false });

  // ── Zoom butonları ────────────────────────────────────────────────────────────
  function ngZoom(factor) {
    // Playhead konumunu merkez al
    const center = Math.max(ngVS, Math.min(ngVE, ngCurrentTime()));
    const half   = (ngVE - ngVS) * factor / 2;
    ngVS = Math.max(0, center - half);
    ngVE = Math.min(dur, center + half);
    if (ngVE - ngVS < 0.5) { ngVE = Math.min(dur, ngVS + 0.5); }
    draw(threshold);
  }
  modal.querySelector('#ng-zoom-in').onclick  = () => ngZoom(0.5);   // 2× yakınlaştır
  modal.querySelector('#ng-zoom-out').onclick = () => ngZoom(2.0);   // 2× uzaklaştır
  modal.querySelector('#ng-zoom-all').onclick = () => { ngVS = 0; ngVE = dur; draw(threshold); };

  // Sarı üçgene çift tık → başa git + tüm görünümü göster
  wrap.addEventListener('dblclick', e => {
    const rect = (e.target === canvasR ? canvasR : canvasL).getBoundingClientRect();
    const topY = e.clientY - canvasL.getBoundingClientRect().top;
    const relX = (e.clientX - rect.left) / rect.width;
    const W    = getW();
    const xph  = tToX(ngCurrentTime(), W);
    const onHandle = Math.abs(relX * W - xph) < 18 && topY < 26;
    if (onHandle || topY < 20) {
      ngOffset = 0;
      ngVS = 0; ngVE = dur;
      if (ngAudio) ngAudio.currentTime = 0;
      draw(threshold);
    }
  });

  // ── Otomatik eşik ────────────────────────────────────────────────────────────
  modal.querySelector('#ng-auto').onclick = () => {
    const s2 = [...amp].filter(v => v > 0).sort((a, b) => a - b);
    threshold = Math.min(s2[Math.floor(s2.length * 0.18)] || 0.05, 0.5);
    slider.value = thrToSlider(threshold);
    draw(threshold);
  };

  // ── Tespit edilen tüm sessizlikleri kes ve sesi indir ────────────────────────
  modal.querySelector('#ng-clear-segs').onclick = () => {
    const segs = computeSegs(threshold, minDurSec);
    if (!segs.length) { addLog('warn', 'Silinecek sessizlik bulunamadı'); return; }
    segs.sort((a, b) => a.start - b.start);
    const merged = [segs[0]];
    for (let i = 1; i < segs.length; i++) {
      const last = merged[merged.length - 1];
      if (segs[i].start <= last.end + 0.05) last.end = Math.max(last.end, segs[i].end);
      else merged.push(segs[i]);
    }
    addLog('ok', `${merged.length} sessizlik bölgesi siliniyor · ${merged.reduce((s,g)=>s+(g.end-g.start),0).toFixed(1)}s`);
    closeModal();
    showApprovalModal(merged, null);
  };

  // ── Manuel kes (📌 Başlat → 📌 Bitir) ────────────────────────────────────────
  btnMark.onclick = () => {
    if (ngMarkStart === null) {
      // Başlangıç noktası seç
      ngMarkStart = ngCurrentTime();
      btnMark.textContent = '✂️ Kes Bitir';
      btnMark.style.background = '#dc2626';
      btnMark.style.borderColor = '#ef4444';
      markInfo.textContent = `Başlangıç: ${formatMM(ngMarkStart)} — şimdi "Kes Bitir" basın`;
      draw(threshold);
    } else {
      // Bitiş → segment oluştur
      const end = ngCurrentTime();
      if (end > ngMarkStart + 0.05) {
        _saveHist();
        manualSegs.push({ start: +ngMarkStart.toFixed(3), end: +end.toFixed(3), action: 'delete', label: 'Manuel kes' });
        addLog('ok', `Manuel kes: ${formatMM(ngMarkStart)} – ${formatMM(end)}`);
        markInfo.textContent = `${manualSegs.length} manuel bölge eklendi`;
        refreshSegList();
      }
      ngMarkStart = null;
      btnMark.textContent = '📌 Kes Başlat';
      btnMark.style.background = '#7c3aed';
      btnMark.style.borderColor = '#8b5cf6';
      draw(threshold);
    }
  };

  // ── Geri Al / İleri ──────────────────────────────────────────────────────────
  btnUndo.onclick = () => _histUndo();
  modal.querySelector('#ng-redo').onclick = () => _histRedo();

  // ── Klavye kısayolları (Adobe tarzı) ─────────────────────────────────────────
  function _addSel() {
    if (ngSelStart !== null && ngSelEnd !== null && ngSelEnd > ngSelStart + 0.02) {
      _saveHist();
      manualSegs.push({ start: +ngSelStart.toFixed(3), end: +ngSelEnd.toFixed(3), action: 'delete', label: 'Seçim kes' });
      addLog('ok', `Seçim kes: ${formatMM(ngSelStart)} – ${formatMM(ngSelEnd)}`);
      refreshSegList(); ngSelStart = null; ngSelEnd = null; draw(threshold);
      return true;
    }
    return false;
  }
  const _ngKeyHandler = e => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const t = ngCurrentTime();
    if (e.key === 'i' || e.key === 'I') {                      // I = Giriş noktası
      ngSelStart = t; ngSelEnd = null; draw(threshold); e.preventDefault();
    } else if (e.key === 'o' || e.key === 'O') {               // O = Çıkış noktası
      if (ngSelStart !== null) { ngSelEnd = Math.max(ngSelStart + 0.02, t); draw(threshold); } e.preventDefault();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {  // Delete = seçimi sil/kes
      _addSel(); e.preventDefault();
    } else if (e.ctrlKey && (e.key === 'x' || e.key === 'c')) { // Ctrl+X / Ctrl+C = kes
      _addSel(); e.preventDefault();
    } else if (e.ctrlKey && e.key === 'z') {                   // Ctrl+Z = geri al
      _histUndo(); e.preventDefault();
    } else if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) { // Ctrl+Y = ileri
      _histRedo(); e.preventDefault();
    } else if (e.key === ' ') {                                 // Space = oynat/durdur
      modal.querySelector('#ng-play')?.click(); e.preventDefault();
    }
  };
  document.addEventListener('keydown', _ngKeyHandler);
  // Modal kapandığında handler'ı temizle
  const _ngMutObs = new MutationObserver(() => {
    if (!document.body.contains(modal)) { document.removeEventListener('keydown', _ngKeyHandler); _ngMutObs.disconnect(); }
  });
  _ngMutObs.observe(document.body, { childList: true, subtree: false });

  // ── Akıllı Analiz butonları ───────────────────────────────────────────────────
  const aiStatus      = modal.querySelector('#ng-ai-status');
  const aiResult      = modal.querySelector('#ng-ai-result');
  const hfRow         = modal.querySelector('#ng-hf-row');
  const clearOverlay  = modal.querySelector('#ng-clear-overlay');

  function aiSetStatus(msg, color='#64748b') {
    if (!aiStatus) return;
    aiStatus.textContent = msg;
    aiStatus.style.color = color;
    // Hata varsa yanına kopyala butonu ekle
    const existing = aiStatus.parentElement.querySelector('.ai-copy-btn');
    if (existing) existing.remove();
    if (color === '#ef4444') {
      const btn = document.createElement('button');
      btn.className = 'ai-copy-btn';
      btn.title = 'Hatayı kopyala';
      btn.textContent = '⎘';
      btn.style.cssText = 'background:transparent;border:none;cursor:pointer;color:#475569;padding:0 4px;font-size:13px;line-height:1;vertical-align:middle';
      btn.onclick = () => {
        navigator.clipboard.writeText(msg).then(() => {
          btn.textContent = '✔'; btn.style.color = '#4ade80';
          setTimeout(() => { btn.textContent = '⎘'; btn.style.color = '#475569'; }, 1500);
        });
      };
      aiStatus.after(btn);
    }
  }

  function showClearBtn() { clearOverlay.style.display = ''; }

  clearOverlay.onclick = () => {
    ngVadSegs = []; ngDiarizeSegs = [];
    aiResult.textContent = ''; aiSetStatus('');
    clearOverlay.style.display = 'none';
    draw(threshold);
  };

  // Yardımcı: VAD sonucunu göster (canlı çalıştırma + arşivden geri yükleme için ortak)
  // VAD konuşma bölgelerinin tersini hesapla → sessizlikleri sil
  function _vadSilenceSegs(speechSegs, pad = 0.10) {
    if (!speechSegs || !speechSegs.length) return [];
    const dur    = state.audioBuffer ? state.audioBuffer.duration : 99999;
    // Konuşma segmentlerini pad ile genişlet → aralarında nefes boşluğu kalır
    const padded = speechSegs.map(s => ({
      start: Math.max(0, s.start - pad),
      end:   Math.min(dur, s.end + pad)
    })).sort((a, b) => a.start - b.start);
    // Çakışan padded segmentleri birleştir
    const merged = [padded[0]];
    for (let i = 1; i < padded.length; i++) {
      const last = merged[merged.length - 1];
      if (padded[i].start <= last.end) last.end = Math.max(last.end, padded[i].end);
      else merged.push(padded[i]);
    }
    const silence = [];
    let cursor = 0;
    for (const seg of merged) {
      if (seg.start > cursor + 0.05)
        silence.push({ action: 'delete', start: +cursor.toFixed(3), end: +seg.start.toFixed(3) });
      cursor = seg.end;
    }
    if (dur && cursor < dur - 0.05)
      silence.push({ action: 'delete', start: +cursor.toFixed(3), end: +dur.toFixed(3) });
    return silence;
  }

  function _showVadResult(count, totalSec, fromCache) {
    const label = fromCache ? `✓ VAD (arşiv): ${count} konuşma bölgesi · ${totalSec}s` : null;
    if (fromCache && label) aiSetStatus(label, '#4ade80');
    aiResult.innerHTML = `${fromCache ? '<span style="font-size:10px;color:#64748b">💾 Arşivden yüklendi · </span>' : ''}<span style="color:#4ade80">Yeşil</span> = konuşma bölgeleri · toplam <strong>${totalSec}s</strong>
      <button id="ng-vad-dl" style="margin-left:10px;background:#14532d;border:1px solid #16a34a;color:#4ade80;border-radius:5px;padding:3px 10px;cursor:pointer;font-size:11px">⬇ Son Hali İndir</button>`;
    aiResult.querySelector('#ng-vad-dl').onclick = function() {
      // Sessizlikleri sil (konuşmaları koru)
      const segs = _vadSilenceSegs(ngVadSegs);
      applyAndDownload(segs.length ? segs : ngVadSegs, this);
    };
  }

  // ── Silero VAD ──
  modal.querySelector('#ng-vad-btn').onclick = async () => {
    if (!_rawFileBlob) { aiSetStatus('Önce ses dosyası yükleyin', '#ef4444'); return; }
    aiSetStatus('⏳ VAD başlatılıyor...', '#f59e0b');
    try {
      const fd = new FormData();
      fd.append('file', _rawFileBlob, _rawFileBlob.name || 'audio.wav');
      const r1   = await fetch('/api/vad', { method: 'POST', body: fd });
      const d1   = await r1.json();
      if (!d1.success) throw new Error(d1.error);
      const jobId = d1.job_id;

      // Polling — progress ile göster
      const data = await new Promise((resolve, reject) => {
        const t = setInterval(async () => {
          try {
            const rs = await fetch(`/api/vad/progress/${jobId}`);
            const ds = await rs.json();
            aiSetStatus(`⏳ %${ds.pct || 0} — ${ds.step || '…'}`, '#f59e0b');
            if (ds.status === 'done')  { clearInterval(t); resolve(ds.result); }
            if (ds.status === 'error') { clearInterval(t); reject(new Error(ds.error)); }
          } catch(e) { clearInterval(t); reject(e); }
        }, 600);
      });

      ngVadSegs = data.segments;
      CanvasOverlay.setVad(ngVadSegs);
      draw(threshold);
      showClearBtn();
      if (_rawFileBlob) saveVadToDB(_rawFileBlob.name, _rawFileBlob.size, data.segments);
      aiSetStatus(`✓ ${data.method}: ${data.count} konuşma bölgesi · ${data.total_speech_sec}s`, '#4ade80');
      _showVadResult(data.count, data.total_speech_sec);
    } catch(e) {
      aiSetStatus('VAD hatası: ' + e.message, '#ef4444');
    }
  };

  // ── HF Token otomatik doldur ──
  fetch('/api/config').then(r => r.json()).then(cfg => {
    if (cfg.hf_token) {
      const inp = modal.querySelector('#ng-hf-token');
      if (inp && !inp.value) inp.value = cfg.hf_token;
    }
  }).catch(() => {});

  // ── Donanım Dashboard ──
  const _hwDash = modal.querySelector('#ng-hw-dashboard');
  let _hwTimer = null;

  function _startHwDash() {
    _hwDash.style.display = 'grid';
    _hwTimer = setInterval(async () => {
      if (_pipeStepBusy) return; // Pipeline adımı çalışırken polling yapma
      try {
        const s = await fetch('/api/system-stats').then(r => r.json());
        modal.querySelector('#ng-hw-cpu-val').textContent = s.cpu_pct + '%';
        modal.querySelector('#ng-hw-cpu-bar').style.width = s.cpu_pct + '%';
        modal.querySelector('#ng-hw-ram-val').textContent = s.ram_used_gb + ' GB';
        modal.querySelector('#ng-hw-ram-bar').style.width = s.ram_pct + '%';
        if (s.gpu_pct !== null) {
          modal.querySelector('#ng-hw-gpu-val').textContent = s.gpu_pct + '%';
          modal.querySelector('#ng-hw-gpu-bar').style.width = s.gpu_pct + '%';
          const vramPct = Math.round(s.gpu_mem_used_mb / s.gpu_mem_total_mb * 100);
          modal.querySelector('#ng-hw-vram-val').textContent = Math.round(s.gpu_mem_used_mb / 1024 * 10) / 10 + ' GB';
          modal.querySelector('#ng-hw-vram-bar').style.width = vramPct + '%';
        }
      } catch(e) {}
    }, 1500);
  }

  function _stopHwDash() {
    if (_hwTimer) { clearInterval(_hwTimer); _hwTimer = null; }
  }

  // ── Otomatik Pipeline ──
  let _pipelineRunning = false;

  const _pipeBtn  = modal.querySelector('#ng-pipeline-btn');
  const _pipeStop = modal.querySelector('#ng-pipeline-stop');
  const _pipeProg = modal.querySelector('#ng-pipeline-progress');

  // DeepFilterNet ↔ Sesi Otomatik Dengele bağlantısı
  const _dfChk = modal.querySelector('#ng-chk-deepfilter');
  const _abRow = modal.querySelector('#ng-autoboost-row');
  if (_dfChk && _abRow) {
    const _syncAB = () => { _abRow.style.opacity = _dfChk.checked ? '1' : '0.4'; _abRow.style.pointerEvents = _dfChk.checked ? 'auto' : 'none'; };
    _syncAB();
    _dfChk.addEventListener('change', _syncAB);
  }

  // Modal açılınca: eğer bu dosya için kayıtlı pipeline durumu varsa
  // tamamlanan adımların checkbox'larını otomatik kaldır
  // Her adımın sonuç sesini sakla — global (modal yeniden açılınca korunsun)
  if (!window._stepAudioSnapshots) window._stepAudioSnapshots = {};
  const _stepAudioSnapshots = window._stepAudioSnapshots;
  let _stepAudioPlayer = null;

  // Her adımın detay bilgisi
  if (!window._stepDetails) window._stepDetails = {};
  const _stepDetails = window._stepDetails;

  // Panel açıldığında: DB'den tamamlanan adımları yükle, step audio'ları göster
  (async () => {
    try {
      const projName = _currentProjectName || localStorage.getItem('current_project_name') || '';
      console.log('[resume-panel] projName:', projName);

      // 1) Pipeline state — tüm yolları dene
      let saved = null;
      if (projName) saved = await loadPipelineStateFromDB(projName);
      if (!saved?.doneSteps?.length) saved = await loadPipelineStateFromDB(); // 'current'
      // Proje adı eşleşmesi kontrol — farklı projenin verisini yükleme
      if (saved?.projectName && projName && saved.projectName !== projName) saved = null;
      console.log('[resume-panel] doneSteps:', saved?.doneSteps);
      if (!saved?.doneSteps?.length) return;
      const savedProjName = saved.projectName || projName;

      // 2) Step audio'ları DB'den belleğe yükle — birden fazla proje adı dene
      let stepAudios = await loadAllStepAudiosFromDB(savedProjName);
      if (!stepAudios.length && projName !== savedProjName) stepAudios = await loadAllStepAudiosFromDB(projName);
      // Hiç bulunamadıysa tüm step_audio kayıtlarını al
      if (!stepAudios.length) {
        try {
          const db = await openDB();
          const tx = db.transaction('step_audio', 'readonly');
          stepAudios = await new Promise(r => { const req = tx.objectStore('step_audio').getAll(); req.onsuccess = () => r(req.result || []); });
        } catch(_) {}
      }
      console.log(`[resume-panel] ${stepAudios.length} step audio bulundu:`, stepAudios.map(s => s.step));
      // stepDetails'i DB'den geri yükle
      if (saved.stepDetails && typeof saved.stepDetails === 'object') {
        Object.assign(window._stepDetails, saved.stepDetails);
        console.log('[resume-panel] stepDetails yüklendi:', Object.keys(saved.stepDetails).length, 'adım');
      }
      for (const sa of stepAudios) {
        _stepAudioSnapshots[sa.step] = new Blob([sa.audio], { type: sa.type || 'audio/mpeg' });
      }
      // Progress alanını görünür yap
      _pipeProg.style.display = 'flex';

      // 3) Tamamlanan adımları göster (artık _stepAudioSnapshots dolu)
      const stepLabels = {
        '1':'1. Adım','1b':'1b. Adım','2':'2. Adım','3':'3. Adım',
        '4':'4. Adım','5':'5. Adım','6':'6. Adım','7':'7. Adım',
        '8b':'8. Adım','8':'9. Adım','9a':'10a. Adım','9b':'10b. Adım','9c':'10c. Adım'
      };
      const stepNames = {
        '1':'Konuşma Yazıya Çevrildi','1b':'Metin Temizlendi','2':'Arka Plan Ayrıldı','3':'Frekans Gürültüsü Temizlendi',
        '4':'Anlık Gürültüler Silindi','5':'Konuşma Dışı Sesler Temizlendi','6':'Konuşmacılar Tespit Edildi','7':'Sessizlik Haritası Oluşturuldu',
        '8b':'Ses Seviyeleri Dengelendi','8':'Sessiz Bölgeler Kesildi','9a':'Ses Restorasyonu','9b':'Gürültü Temizleme','9c':'Derin Filtreleme'
      };
      for (const sid of saved.doneSteps.map(String)) {
        const hasAud = !!_stepAudioSnapshots[sid];
        console.log(`[resume-panel] Adım ${sid}: audio=${hasAud}`);
        _pipeLog(sid, '✓', `${stepLabels[sid]||sid} — ${stepNames[sid]||sid} ✓`, '#4ade80');
      }
      // 4) Tamamlanan adımların checkbox'larını devre dışı bırak
      const chkMap = {
        '1':'#ng-chk-whisper','1b':'#ng-chk-ollama','2':'#ng-chk-step2',
        '3':'#ng-chk-nr','4':'#ng-chk-enhance','5':'#ng-chk-speech-only',
        '6':'#ng-chk-step4','7':'#ng-chk-step5','8b':'#ng-chk-normalize','8':'#ng-chk-step6',
        '9a':'#ng-chk-voicefixer','9b':'#ng-chk-resemble','9c':'#ng-chk-deepfilter'
      };
      const doneSet = new Set(saved.doneSteps.map(String));
      Object.entries(chkMap).forEach(([sid, sel]) => {
        const chk = modal.querySelector(sel);
        if (!chk) return;
        if (doneSet.has(sid)) {
          chk.checked = false; chk.disabled = true;
          chk.parentElement.style.opacity = '0.45';
        } else {
          chk.checked = true; chk.disabled = false;
          chk.parentElement.style.opacity = '1';
        }
      });

      addLog('info', `Proje "${projName}": ${doneSet.size} adım tamamlanmış, ${stepAudios.length} ses kaydı — kalan adımları seçip Başlat'a basın`);

      // Post-pipeline alanını göster (sonuç ekranı, indir, PDF butonları)
      const _postEl = modal.querySelector('#ng-post-pipeline');
      if (_postEl && doneSet.size >= 8) _postEl.style.display = 'flex';
      const _repBtn = modal.querySelector('#ng-report-btn');
      if (_repBtn && doneSet.size >= 8) { _repBtn.style.display = 'inline-flex'; _repBtn.onclick = () => _openPipelineReport(); }
      // Son adımın ses kaydını preview'a bağla
      const lastStep = saved.doneSteps[saved.doneSteps.length - 1];
      const lastBlob = _stepAudioSnapshots[String(lastStep)];
      const _prevAudio = modal.querySelector('#ng-preview-audio');
      if (_prevAudio && lastBlob) _prevAudio.src = URL.createObjectURL(lastBlob);
      // Sonuç ekranı butonu — orijinal (step 1 veya ilk audio) vs son hal
      const _cmpBtn = modal.querySelector('#ng-show-comparison-btn');
      const firstBlob = _stepAudioSnapshots['1'] || _stepAudioSnapshots[saved.doneSteps[0]];
      let _savedCutSegs = saved.cutSegments || [];
      // cutSegments boşsa VAD/Diarize'dan hesapla
      if (!_savedCutSegs.length) {
        let _cmpSegs = [];
        try {
          const db2 = await openDB();
          const tx2 = db2.transaction('vad','readonly');
          const allV = await new Promise(r=>{const req=tx2.objectStore('vad').getAll();req.onsuccess=()=>r(req.result||[])});
          const vf = allV.find(x=>x?.segments?.length);
          if (vf?.segments) _cmpSegs.push(...vf.segments.map(s=>({start:s.start,end:s.end})));
        } catch(_){}
        try {
          const db3 = await openDB();
          const tx3 = db3.transaction('diarize','readonly');
          const allD = await new Promise(r=>{const req=tx3.objectStore('diarize').getAll();req.onsuccess=()=>r(req.result||[])});
          const df = allD.find(x=>x?.segments?.length);
          if (df?.segments) _cmpSegs.push(...df.segments.map(s=>({start:s.start,end:s.end})));
        } catch(_){}
        if (_cmpSegs.length) _savedCutSegs = _vadSilenceSegs(_cmpSegs);
      }
      if (_cmpBtn && lastBlob) {
        _cmpBtn.onclick = async () => {
          if (firstBlob) {
            _originalAudioBuffer = await new AudioContext().decodeAudioData(await firstBlob.slice(0).arrayBuffer()).catch(() => null);
          }
          const _cleanDlName = (_currentProjectName || _rawFileBlob?.name || 'son_hal').replace(/\.[^.]+$/, '').replace(/^temizlenmis\d*_?/, '').replace(/_(vocals|nr|enhanced|sadece_konusma|vf|re|df|cut|speech).*/i, '');
          const dlName = 'temizlenmis_' + _cleanDlName + '.mp3';
          showComparison(lastBlob, _savedCutSegs, dlName);
        };
      }
      // İndir butonu
      const _dlBtn = modal.querySelector('#ng-download-final-btn');
      if (_dlBtn && lastBlob) {
        _dlBtn.onclick = () => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(lastBlob);
          const _cleanDl2 = (_currentProjectName || _rawFileBlob?.name || 'son_hal').replace(/\.[^.]+$/, '').replace(/^temizlenmis\d*_?/, '').replace(/_(vocals|nr|enhanced|sadece_konusma|vf|re|df|cut|speech).*/i, '');
          a.download = 'temizlenmis_' + _cleanDl2 + '.mp3';
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 3000);
        };
      }
      // Excel alanını göster
      const _xlArea2 = modal.querySelector('#ng-excel-area');
      if (_xlArea2) {
        _xlArea2.style.display = 'flex';
        const _xlExp2 = modal.querySelector('#ng-excel-export-btn');
        if (_xlExp2) _xlExp2.onclick = () => _exportTranscriptExcel();
        const _xlImp2 = modal.querySelector('#ng-excel-import-input');
        if (_xlImp2) _xlImp2.onchange = e => { if (e.target.files[0]) _importTranscriptExcel(e.target.files[0]); };
      }
    } catch(e) { console.warn('[resume-panel] hata:', e); }
  })();

  function _pipeLog(stepNum, icon, text, color) {
    const id = `pipe-step-${stepNum}`;
    let el = _pipeProg.querySelector(`#${id}`);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.style.cssText = 'border-radius:7px;background:#0a1628;border:1px solid #1e293b;overflow:hidden';
      _pipeProg.appendChild(el);
    }

    const pctMatch = text.match(/%(\d+)/);
    const pct = pctMatch ? parseInt(pctMatch[1]) : (icon === '✓' ? 100 : icon === '○' ? 0 : null);
    const isDone  = icon === '✓' || icon === '♻';
    const isSkip  = icon === '○';
    const isErr   = icon === '✗';
    const bgColor = isDone ? 'rgba(74,222,128,0.08)' : isErr ? 'rgba(239,68,68,0.08)' : isSkip ? 'transparent' : 'rgba(59,130,246,0.05)';
    el.style.background = bgColor;
    el.style.borderColor = isDone ? '#166534' : isErr ? '#7f1d1d' : isSkip ? '#1e293b' : '#334155';

    const hasAudio = !!_stepAudioSnapshots[stepNum];
    const btnStyle = 'background:none;border:1px solid #334155;border-radius:5px;cursor:pointer;font-size:10px;padding:2px 7px;white-space:nowrap;flex-shrink:0';
    const listenBtn = (isDone && hasAudio)
      ? `<button data-step-listen="${stepNum}" style="${btnStyle};color:#38bdf8" title="Dinle">&#9654;</button>` : '';
    const dlBtn = (isDone && hasAudio)
      ? `<button data-step-dl="${stepNum}" style="${btnStyle};color:#4ade80" title="Bu adımın çıktısını indir">⬇</button>` : '';
    const pdfBtn = isDone
      ? `<button data-step-pdf="${stepNum}" style="${btnStyle};color:#94a3b8" title="Detaylı rapor">PDF</button>` : '';
    const restartBtn = (isDone && hasAudio)
      ? `<button data-step-restart="${stepNum}" style="${btnStyle};color:#fbbf24;border-color:#92400e" title="Buradan devam et">▶ Devam</button>` : '';
    // Ayar butonu — parametresi olan adımlar için
    const _hasParams = ['3','5','7','8','9a','9b','9c'].includes(String(stepNum));
    const settingsBtn = (isDone && _hasParams)
      ? `<button data-step-settings="${stepNum}" style="${btnStyle};color:#c084fc;border-color:#7c3aed" title="Parametreleri ayarla ve tekrar çalıştır">⚙</button>` : '';
    // Konuşmacı isimlendirme butonu — sadece step 6 için
    const speakerBtn = (isDone && String(stepNum) === '6')
      ? `<button data-step-speakers="6" style="${btnStyle};color:#a5b4fc;border-color:#4338ca" title="Konuşmacıları dinle ve isimlendir">👥 İsimlendir</button>` : '';

    const barHtml = (!isSkip && pct !== null)
      ? `<div style="height:3px;background:#1e293b"><div style="height:3px;background:${color};width:${pct}%;transition:width 0.4s;border-radius:0 2px 2px 0"></div></div>`
      : '';
    const actionBtns = [listenBtn, dlBtn, pdfBtn, settingsBtn, speakerBtn, restartBtn].filter(Boolean).join('');
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:7px 12px">
        <span style="font-size:16px;flex-shrink:0">${icon}</span>
        <span style="color:${color};flex:1;font-size:12px;font-weight:600">${text}</span>
        ${pct !== null && !isSkip ? `<span style="color:${color};font-size:13px;font-weight:700;flex-shrink:0">%${pct}</span>` : ''}
      </div>
      ${actionBtns ? `<div style="display:flex;gap:4px;padding:0 12px 6px 40px">${actionBtns}</div>` : ''}
      ${barHtml}`;

    // Dinle butonu event
    const btn = el.querySelector(`[data-step-listen="${stepNum}"]`);
    if (btn) btn.addEventListener('click', () => _playStepAudio(stepNum, btn));
    // Buradan devam butonu event
    const rbtn = el.querySelector(`[data-step-restart="${stepNum}"]`);
    if (rbtn) rbtn.addEventListener('click', () => _restartFromStep(stepNum));
    // PDF butonu event
    const pbtn = el.querySelector(`[data-step-pdf="${stepNum}"]`);
    if (pbtn) pbtn.addEventListener('click', () => _openStepPDF(stepNum));
    // Ayar butonu event
    const sbtn = el.querySelector(`[data-step-settings="${stepNum}"]`);
    if (sbtn) sbtn.addEventListener('click', () => _openStepSettings(stepNum, el));
    // Konuşmacı isimlendirme butonu — inline onclick (innerHTML yeniden yazılınca event delegation gerekli)
    const spbtn = el.querySelector(`[data-step-speakers="6"]`);
    if (spbtn) spbtn.onclick = () => _openSpeakerNaming(el);
    // İndir butonu event
    const dbtn = el.querySelector(`[data-step-dl="${stepNum}"]`);
    if (dbtn) dbtn.addEventListener('click', () => {
      const b = _stepAudioSnapshots[stepNum];
      if (!b) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      const cleanName = (_currentProjectName || _rawFileBlob?.name || 'ses').replace(/\.[^.]+$/, '').replace(/^temizlenmis\d*_?/, '');
      a.download = `temizlenmis${stepNum}_${cleanName}.mp3`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    });

    // Başlat butonuna genel durum yaz (sadece pipeline çalışırken)
    if (_pipelineRunning) {
      const doneCount = _pipeProg.querySelectorAll('[id^=pipe-step-]').length;
      _pipeBtn.textContent = `⏳ İşleniyor... (${doneCount}/${_pipeTotalSteps})`;
    }
  }

  // ── Konuşmacı İsimlendirme Paneli (step 6 satırının altında açılır) ─────
  async function _openSpeakerNaming(parentEl) {
    // ngDiarizeSegs boşsa DB'den yüklemeyi dene
    if (!ngDiarizeSegs.length) {
      try {
        const _tryNames = [_rawFileBlob?.name, _currentProjectName, localStorage.getItem('current_project_name')].filter(Boolean);
        const _trySizes = [_rawFileBlob?.size].filter(Boolean);
        for (const nm of _tryNames) {
          for (const sz of _trySizes) {
            try {
              const c = await loadDiarizeFromDB(nm, sz);
              if (c?.segments?.length) { ngDiarizeSegs = c.segments; break; }
            } catch(_) {}
          }
          if (ngDiarizeSegs.length) break;
        }
        // Hâlâ boşsa tüm diarize kayıtlarını tara
        if (!ngDiarizeSegs.length) {
          const db = await openDB();
          const tx = db.transaction('diarize','readonly');
          const all = await new Promise(r => { const req = tx.objectStore('diarize').getAll(); req.onsuccess = () => r(req.result||[]); });
          const found = all.find(v => v?.segments?.length);
          if (found) ngDiarizeSegs = found.segments;
        }
      } catch(_) {}
    }
    if (!ngDiarizeSegs.length) {
      alert('Konuşmacı verisi bulunamadı — önce 6. Adımı (Konuşmacı Tespiti) çalıştırın.');
      return;
    }

    // Mevcut panel varsa kapat
    const existingPanel = parentEl.querySelector('.sp-naming-panel');
    if (existingPanel) { existingPanel.remove(); return; }

    // Konuşmacı süreleri
    const spkDurs = {};
    ngDiarizeSegs.forEach(s => { spkDurs[s.speaker] = (spkDurs[s.speaker]||0) + (s.end - s.start); });
    const spkList = Object.entries(spkDurs).sort((a,b) => b[1] - a[1]);

    // DB'den kayıtlı isimleri yükle
    let savedNames = {};
    try {
      const pn = _currentProjectName || localStorage.getItem('current_project_name') || '';
      const ps = await loadPipelineStateFromDB(pn) || await loadPipelineStateFromDB() || {};
      if (ps.speakerNames) savedNames = ps.speakerNames;
    } catch(_) {}
    // Diarize DB'den de dene
    if (!Object.keys(savedNames).length) {
      try {
        const names = [_rawFileBlob?.name, _currentProjectName].filter(Boolean);
        for (const nm of names) {
          const c = await loadDiarizeFromDB(nm, _rawFileBlob?.size);
          if (c?.speakerNames) { savedNames = c.speakerNames; break; }
        }
      } catch(_) {}
    }

    const colors = ['#3b82f6','#f97316','#a855f7','#ec4899','#14b8a6','#eab308','#ef4444','#22d3ee'];
    const panel = document.createElement('div');
    panel.className = 'sp-naming-panel';
    panel.style.cssText = 'padding:10px 12px;background:rgba(99,102,241,0.06);border-top:1px solid #4338ca';
    panel.innerHTML = `
      <div style="font-size:11px;color:#a5b4fc;font-weight:700;margin-bottom:6px">👥 Konuşmacıları Dinle & İsimlendir</div>
      <div style="font-size:10px;color:#64748b;margin-bottom:8px">Her konuşmacının ▶ butonuna basıp sesini dinleyin, yanına ismini yazın.</div>
      ${spkList.map(([sp, dur], i) => {
        // Segment'lerdeki güncel isim mi yoksa orijinal id mi kontrol et
        const displayId = sp.replace('SPEAKER_','K');
        const savedName = savedNames[sp] || '';
        const m = Math.floor(dur/60), s = Math.floor(dur%60);
        return `<div style="display:flex;align-items:center;gap:6px;margin:5px 0">
          <span style="width:10px;height:10px;border-radius:50%;background:${colors[i%colors.length]};flex-shrink:0"></span>
          <button data-snp-play="${sp}" style="background:#0f172a;border:1px solid #1e40af;color:#93c5fd;border-radius:4px;padding:3px 10px;font-size:12px;cursor:pointer;flex-shrink:0" title="Bu konuşmacıyı dinle">▶</button>
          <span style="font-size:11px;color:#64748b;min-width:50px;flex-shrink:0">${displayId}</span>
          <span style="font-size:10px;color:#475569;min-width:50px;flex-shrink:0">${m}dk ${s}sn</span>
          <input type="text" data-snp-name="${sp}" value="${savedName}" placeholder="İsim girin..."
            style="background:#1e293b;border:1px solid #334155;color:#e2e8f0;border-radius:4px;padding:4px 8px;font-size:12px;flex:1;min-width:90px">
        </div>`;
      }).join('')}
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center">
        <button data-snp-save style="background:linear-gradient(135deg,#312e81,#1e3a5f);border:1px solid #6366f1;color:#e0e7ff;border-radius:6px;padding:6px 16px;font-size:12px;font-weight:600;cursor:pointer">💾 Kaydet</button>
        <span data-snp-status style="font-size:11px;color:#64748b"></span>
      </div>`;
    parentEl.appendChild(panel);

    // ▶ Dinle butonları
    panel.querySelectorAll('button[data-snp-play]').forEach(btn => {
      btn.addEventListener('click', () => playSpeaker(btn.dataset.snpPlay, btn));
    });

    // 💾 Kaydet butonu
    panel.querySelector('[data-snp-save]').addEventListener('click', async () => {
      const nameMap = {};
      panel.querySelectorAll('input[data-snp-name]').forEach(inp => {
        const name = inp.value.trim();
        if (name) nameMap[inp.dataset.snpName] = name;
      });
      if (!Object.keys(nameMap).length) {
        panel.querySelector('[data-snp-status]').textContent = '⚠ En az bir isim girin';
        panel.querySelector('[data-snp-status]').style.color = '#f59e0b';
        return;
      }

      // ngDiarizeSegs'teki speaker alanlarını güncelle
      ngDiarizeSegs.forEach(s => { if (nameMap[s.speaker]) s.speaker = nameMap[s.speaker]; });

      // Transkript segmentlerine de ata
      _assignSpeakersToTranscript();

      // Diarize DB'ye kaydet
      try {
        const names = [_rawFileBlob?.name, _currentProjectName].filter(Boolean);
        for (const nm of names) {
          const existing = await loadDiarizeFromDB(nm, _rawFileBlob?.size);
          if (existing) {
            existing.segments = ngDiarizeSegs;
            existing.speakers = [...new Set(ngDiarizeSegs.map(s => s.speaker))];
            existing.speakerNames = nameMap;
            await saveDiarizeToDB(nm, _rawFileBlob?.size, existing);
            break;
          }
        }
      } catch(_) {}

      // Pipeline state'e kaydet
      try {
        const pn = _currentProjectName || localStorage.getItem('current_project_name') || '';
        const ps = await loadPipelineStateFromDB(pn) || await loadPipelineStateFromDB() || {};
        ps.speakerNames = nameMap;
        await savePipelineStateToDB(ps);
      } catch(_) {}

      // Transkripti DB'ye kaydet
      if (_ngTranscript?.segments?.length) {
        try { await saveTranscriptToDB(_ngTranscript); } catch(_) {}
      }

      // UI güncelle
      window._pipelineSpeakerNames = nameMap;
      CanvasOverlay.setSpeakers(ngDiarizeSegs);
      if (_ngTranscript) _renderTrMainTab(_ngTranscript);

      // PDF meta alanındaki "Konuşmacılar" input'unu otomatik doldur
      const _metaSp = document.querySelector('#ng-meta-speakers');
      if (_metaSp) _metaSp.value = Object.values(nameMap).join(', ');

      panel.querySelector('[data-snp-status]').textContent = `✅ ${Object.keys(nameMap).length} konuşmacı kaydedildi`;
      panel.querySelector('[data-snp-status]').style.color = '#4ade80';
      addLog('ok', `👥 Konuşmacı isimleri kaydedildi: ${Object.entries(nameMap).map(([k,v])=>k.replace('SPEAKER_','K')+'→'+v).join(', ')}`);
    });
  }

  function _saveStepAudio(stepNum) {
    if (!_rawFileBlob) { console.warn('[step-audio] rawFileBlob yok, kayıt atlandı'); return; }
    const blob = _rawFileBlob.slice(0, _rawFileBlob.size, _rawFileBlob.type);
    _stepAudioSnapshots[stepNum] = blob;
    // IndexedDB'ye de kaydet (arka planda)
    const projName = _currentProjectName || localStorage.getItem('current_project_name') || 'default';
    console.log(`[step-audio] Adım ${stepNum} kaydediliyor: proje="${projName}", boyut=${(_rawFileBlob.size/1024/1024).toFixed(1)}MB`);
    saveStepAudioToDB(projName, stepNum, _rawFileBlob)
      .then(() => console.log(`[step-audio] Adım ${stepNum} DB'ye kaydedildi ✓`))
      .catch(e => console.error(`[step-audio] Adım ${stepNum} kayıt hatası:`, e));
  }

  function _playStepAudio(stepNum, triggerBtn) {
    const blob = _stepAudioSnapshots[stepNum];
    if (!blob) return;

    // Önceki popup varsa kapat
    const old = document.getElementById('step-audio-popup');
    if (old) { old._cleanup?.(); old.remove(); }

    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    audio.src = url;
    _stepAudioPlayer = audio;

    const stepLabels = {
      '1':'1. Adım','1b':'1b. Adım','2':'2. Adım','3':'3. Adım',
      '4':'4. Adım','5':'5. Adım','6':'6. Adım','7':'7. Adım',
      '8b':'8. Adım','8':'9. Adım','9a':'10a. Adım','9b':'10b. Adım','9c':'10c. Adım'
    };
    const stepNames = {
      '1':'Konuşma Yazıya Çevrildi','1b':'Metin Temizlendi','2':'Arka Plan Ayrıldı','3':'Frekans Gürültüsü Temizlendi',
      '4':'Anlık Gürültüler Silindi','5':'Konuşma Dışı Sesler Temizlendi','6':'Konuşmacılar Tespit Edildi','7':'Sessizlik Haritası Oluşturuldu',
      '8b':'Ses Seviyeleri Dengelendi','8':'Sessiz Bölgeler Kesildi','9a':'Ses Restorasyonu','9b':'Gürültü Temizleme','9c':'Derin Filtreleme'
    };

    // Popup oluştur
    const popup = document.createElement('div');
    popup.id = 'step-audio-popup';
    popup.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);z-index:999999;background:#0f172a;border:1px solid #334155;border-radius:12px;padding:14px 18px;min-width:480px;max-width:90vw;box-shadow:0 12px 40px rgba(0,0,0,0.7);display:flex;flex-direction:column;gap:8px';

    popup.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between">
        <span style="color:#38bdf8;font-size:13px;font-weight:700">${stepLabels[String(stepNum)]||stepNum}: ${stepNames[String(stepNum)]||stepNum}</span>
        <button id="sap-close" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:16px;line-height:1;padding:2px 6px" title="Kapat">✕</button>
      </div>
      <canvas id="sap-waveform" height="60" style="width:100%;border-radius:6px;background:#1e293b;cursor:crosshair"></canvas>
      <div id="sap-seekbar-wrap" style="position:relative;width:100%;height:28px;cursor:pointer;user-select:none;padding:4px 0">
        <div style="position:absolute;top:11px;left:0;right:0;height:6px;background:#334155;border-radius:3px"></div>
        <div id="sap-seekbar-fill" style="position:absolute;top:11px;left:0;width:0%;height:6px;background:linear-gradient(90deg,#3b82f6,#38bdf8);border-radius:3px;box-shadow:0 0 6px rgba(56,189,248,0.4)"></div>
        <div id="sap-seekbar-thumb" style="position:absolute;top:5px;left:0%;width:16px;height:16px;background:#60a5fa;border:2px solid #0f172a;border-radius:50%;transform:translateX(-50%);box-shadow:0 0 8px rgba(96,165,250,0.5)"></div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <button id="sap-prev" style="background:#1e293b;border:1px solid #334155;border-radius:6px;color:#94a3b8;cursor:pointer;padding:5px 12px;font-size:12px;font-weight:600" title="-10 saniye">⏪ -10s</button>
        <button id="sap-play" style="background:#1e3a5f;border:1px solid #3b82f6;border-radius:8px;color:#60a5fa;cursor:pointer;padding:6px 16px;font-size:16px;font-weight:700">▶</button>
        <button id="sap-next" style="background:#1e293b;border:1px solid #334155;border-radius:6px;color:#94a3b8;cursor:pointer;padding:5px 12px;font-size:12px;font-weight:600" title="+10 saniye">+10s ⏩</button>
        <span id="sap-time" style="color:#94a3b8;font-size:12px;min-width:100px;text-align:center">00:00 / 00:00</span>
        <div style="margin-left:auto;display:flex;align-items:center;gap:4px">
          <span style="color:#64748b;font-size:10px">Hız:</span>
          <button data-speed="0.5" class="sap-spd" style="background:#1e293b;border:1px solid #334155;border-radius:4px;color:#64748b;cursor:pointer;padding:2px 6px;font-size:10px">0.5x</button>
          <button data-speed="0.75" class="sap-spd" style="background:#1e293b;border:1px solid #334155;border-radius:4px;color:#64748b;cursor:pointer;padding:2px 6px;font-size:10px">0.75x</button>
          <button data-speed="1" class="sap-spd" style="background:#1e3a5f;border:1px solid #3b82f6;border-radius:4px;color:#60a5fa;cursor:pointer;padding:2px 6px;font-size:10px;font-weight:700">1x</button>
          <button data-speed="1.25" class="sap-spd" style="background:#1e293b;border:1px solid #334155;border-radius:4px;color:#64748b;cursor:pointer;padding:2px 6px;font-size:10px">1.25x</button>
          <button data-speed="1.5" class="sap-spd" style="background:#1e293b;border:1px solid #334155;border-radius:4px;color:#64748b;cursor:pointer;padding:2px 6px;font-size:10px">1.5x</button>
          <button data-speed="2" class="sap-spd" style="background:#1e293b;border:1px solid #334155;border-radius:4px;color:#64748b;cursor:pointer;padding:2px 6px;font-size:10px">2x</button>
        </div>
      </div>
    `;
    document.body.appendChild(popup);

    const canvas  = popup.querySelector('#sap-waveform');
    const ctx2d   = canvas.getContext('2d');
    const playBtn = popup.querySelector('#sap-play');
    const timeEl  = popup.querySelector('#sap-time');
    const prevBtn = popup.querySelector('#sap-prev');
    const nextBtn = popup.querySelector('#sap-next');
    const closeBtn= popup.querySelector('#sap-close');
    const seekWrap = popup.querySelector('#sap-seekbar-wrap');
    const seekFill = popup.querySelector('#sap-seekbar-fill');
    const seekThumb= popup.querySelector('#sap-seekbar-thumb');
    let animId = null;

    // Dalga formu — bir kez çiz, ImageData olarak cache'le
    let _waveImage = null;
    let _wW = 0, _wH = 0;

    async function initWaveform() {
      try {
        const actx = new AudioContext();
        const rawBuf = await blob.arrayBuffer();
        const ab = await actx.decodeAudioData(rawBuf);
        actx.close();
        const ch = ab.getChannelData(0);
        _wW = canvas.width = canvas.offsetWidth * 2;
        _wH = canvas.height = 120;
        const step = Math.floor(ch.length / _wW) || 1;
        ctx2d.fillStyle = '#1e293b';
        ctx2d.fillRect(0, 0, _wW, _wH);
        ctx2d.strokeStyle = '#3b82f6';
        ctx2d.lineWidth = 1;
        ctx2d.beginPath();
        for (let i = 0; i < _wW; i++) {
          let mn = 1, mx = -1;
          for (let j = i * step; j < (i + 1) * step && j < ch.length; j++) {
            if (ch[j] < mn) mn = ch[j];
            if (ch[j] > mx) mx = ch[j];
          }
          ctx2d.moveTo(i, (1 - mx) * _wH / 2);
          ctx2d.lineTo(i, (1 - mn) * _wH / 2);
        }
        ctx2d.stroke();
        _waveImage = ctx2d.getImageData(0, 0, _wW, _wH);
      } catch(e) { console.warn('[waveform]', e); }
    }
    initWaveform();

    // Zaman gösterimi
    const fmtT = s => { s = Math.max(0,s); const m = Math.floor(s/60); const sec = Math.floor(s%60); return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`; };

    // Playhead animasyonu — cache'li waveform üzerine çiz
    function drawPlayhead() {
      if (!_waveImage || !audio.duration) { animId = requestAnimationFrame(drawPlayhead); return; }
      // Cache'li dalga formunu geri koy
      ctx2d.putImageData(_waveImage, 0, 0);
      const pct = audio.currentTime / audio.duration;
      const x = pct * _wW;
      // Geçen bölümü hafif renklendir
      ctx2d.fillStyle = 'rgba(59,130,246,0.15)';
      ctx2d.fillRect(0, 0, x, _wH);
      // Playhead çizgisi
      ctx2d.strokeStyle = '#f59e0b';
      ctx2d.lineWidth = 2;
      ctx2d.beginPath();
      ctx2d.moveTo(x, 0);
      ctx2d.lineTo(x, _wH);
      ctx2d.stroke();
      timeEl.textContent = `${fmtT(audio.currentTime)} / ${fmtT(audio.duration)}`;
      // Seek bar güncelle
      const seekPct = (audio.currentTime / audio.duration) * 100;
      seekFill.style.width = seekPct + '%';
      seekThumb.style.left = seekPct + '%';
      if (!audio.paused) animId = requestAnimationFrame(drawPlayhead);
    }

    // Play/Pause
    playBtn.onclick = () => {
      if (audio.paused) {
        audio.play();
        playBtn.textContent = '⏸';
        animId = requestAnimationFrame(drawPlayhead);
      } else {
        audio.pause();
        playBtn.textContent = '▶';
        if (animId) cancelAnimationFrame(animId);
      }
    };

    // İleri/Geri
    prevBtn.onclick = () => { audio.currentTime = Math.max(0, audio.currentTime - 10); drawPlayhead(); };
    nextBtn.onclick = () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10); drawPlayhead(); };

    // Canvas tıklama + sürükleme — seek
    const seekTo = (e) => {
      if (!audio.duration) return;
      const rect = canvas.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      audio.currentTime = pct * audio.duration;
      drawPlayhead();
    };
    canvas.onclick = seekTo;
    let dragging = false;
    canvas.onmousedown = () => { dragging = true; };
    canvas.onmousemove = (e) => { if (dragging) seekTo(e); };
    canvas.onmouseup = () => { dragging = false; };
    canvas.onmouseleave = () => { dragging = false; };

    // Seek bar tıklama/sürükleme
    const seekBarSeek = (e) => {
      if (!audio.duration) return;
      const rect = seekWrap.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      audio.currentTime = pct * audio.duration;
      seekFill.style.width = (pct * 100) + '%';
      seekThumb.style.left = (pct * 100) + '%';
      drawPlayhead();
    };
    let seekDragging = false;
    seekWrap.onmousedown = (e) => { seekDragging = true; seekBarSeek(e); };
    seekWrap.onmousemove = (e) => { if (seekDragging) seekBarSeek(e); };
    seekWrap.onmouseup = () => { seekDragging = false; };
    seekWrap.onmouseleave = () => { seekDragging = false; };

    // Hız butonları
    popup.querySelectorAll('.sap-spd').forEach(b => {
      b.onclick = () => {
        const spd = parseFloat(b.dataset.speed);
        audio.playbackRate = spd;
        popup.querySelectorAll('.sap-spd').forEach(s => {
          s.style.background = '#1e293b'; s.style.borderColor = '#334155'; s.style.color = '#64748b'; s.style.fontWeight = 'normal';
        });
        b.style.background = '#1e3a5f'; b.style.borderColor = '#3b82f6'; b.style.color = '#60a5fa'; b.style.fontWeight = '700';
      };
    });

    // Bittiğinde
    audio.addEventListener('ended', () => {
      playBtn.textContent = '▶';
      if (animId) cancelAnimationFrame(animId);
    });

    // Metadata yüklendiğinde süre göster
    audio.addEventListener('loadedmetadata', () => {
      timeEl.textContent = `00:00 / ${fmtT(audio.duration)}`;
    });

    // Kapat
    const cleanup = () => {
      audio.pause();
      if (animId) cancelAnimationFrame(animId);
      URL.revokeObjectURL(url);
      _stepAudioPlayer = null;
    };
    popup._cleanup = cleanup;
    closeBtn.onclick = () => { cleanup(); popup.remove(); };

    // Otomatik başlat
    audio.play().then(() => {
      playBtn.textContent = '⏸';
      animId = requestAnimationFrame(drawPlayhead);
    }).catch(() => {});
  }

  // Adım detay raporu PDF'i
  // ── Adım Parametre Ayarları ─────────────────────────────────────────────────
  const _stepParams = {
    '3': { title:'NoiseReduce', params:[
      { key:'prop_decrease', label:'Gürültü Azaltma Gücü', type:'range', min:0.1, max:1.0, step:0.05, default:0.65 },
    ]},
    '5': { title:'SpeechOnly (Band-pass + VAD)', params:[
      { key:'threshold', label:'VAD Eşik (düşük=hassas)', type:'range', min:0.1, max:0.8, step:0.05, default:0.30 },
      { key:'min_ms', label:'Min Konuşma (ms)', type:'number', min:10, max:500, step:10, default:50 },
      { key:'pad_ms', label:'Dolgu (ms)', type:'number', min:0, max:500, step:10, default:150 },
      { key:'bandpass', label:'Band-pass Filtre', type:'checkbox', default:true },
    ]},
    '7': { title:'Silero VAD', params:[
      { key:'threshold', label:'VAD Eşik', type:'range', min:0.1, max:0.8, step:0.05, default:0.25 },
      { key:'min_speech_ms', label:'Min Konuşma (ms)', type:'number', min:10, max:500, step:10, default:40 },
      { key:'min_silence_ms', label:'Min Sessizlik (ms)', type:'number', min:100, max:2000, step:50, default:500 },
    ]},
    '8': { title:'Sessiz Yerleri Kes', params:[
      { key:'pad', label:'Kesim Dolgusu (sn)', type:'range', min:0, max:0.5, step:0.01, default:0.10 },
    ]},
    '9a': { title:'VoiceFixer', params:[
      { key:'mode', label:'Mod (0=normal, 1=agresif, 2=çok agresif)', type:'number', min:0, max:2, step:1, default:0 },
    ]},
    '9b': { title:'Resemble Enhance', params:[
      { key:'mode', label:'Mod', type:'select', options:['denoise','enhance'], default:'denoise' },
    ]},
    '9c': { title:'DeepFilterNet', params:[
      { key:'info', label:'CPU modunda çalışır — ayarlanabilir parametre yok', type:'info' },
    ]},
  };

  function _openStepSettings(stepNum, parentEl) {
    const sid = String(stepNum);
    const cfg = _stepParams[sid];
    if (!cfg) return;

    // Mevcut settings paneli varsa kapat
    const existing = parentEl.querySelector('.step-settings-panel');
    if (existing) { existing.remove(); return; }

    const panel = document.createElement('div');
    panel.className = 'step-settings-panel';
    panel.style.cssText = 'padding:10px 12px;background:#0a1628;border-top:1px solid #1e293b;display:flex;flex-direction:column;gap:6px';

    let html = `<div style="font-size:11px;color:#c084fc;font-weight:700;margin-bottom:2px">⚙ ${cfg.title} — Parametre Ayarları</div>`;

    for (const p of cfg.params) {
      if (p.type === 'info') {
        html += `<div style="font-size:10px;color:#64748b;padding:4px 0">${p.label}</div>`;
        continue;
      }
      const id = `stp-${sid}-${p.key}`;
      html += `<div style="display:flex;align-items:center;gap:8px;font-size:11px">`;
      html += `<label style="color:#94a3b8;min-width:140px">${p.label}</label>`;
      if (p.type === 'range') {
        html += `<input id="${id}" type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.default}" style="flex:1;accent-color:#c084fc">`;
        html += `<span id="${id}-val" style="color:#e2e8f0;min-width:35px;text-align:right;font-weight:600">${p.default}</span>`;
      } else if (p.type === 'number') {
        html += `<input id="${id}" type="number" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.default}" style="width:70px;background:#1e293b;border:1px solid #334155;border-radius:4px;color:#f1f5f9;padding:3px 6px;font-size:11px;outline:none">`;
      } else if (p.type === 'checkbox') {
        html += `<input id="${id}" type="checkbox" ${p.default ? 'checked' : ''} style="accent-color:#c084fc">`;
      } else if (p.type === 'select') {
        html += `<select id="${id}" style="background:#1e293b;border:1px solid #334155;border-radius:4px;color:#f1f5f9;padding:3px 6px;font-size:11px;outline:none">`;
        for (const o of p.options) html += `<option value="${o}" ${o===p.default?'selected':''}>${o}</option>`;
        html += `</select>`;
      }
      html += `</div>`;
    }

    // Önceki adım vs bu adım karşılaştırmalı dinleme
    const allStepsForCmp = ['1','1b','2','3','4','5','6','7','8b','8','9a','9b','9c'];
    const idxCmp = allStepsForCmp.indexOf(sid);
    const prevStepCmp = idxCmp > 0 ? allStepsForCmp[idxCmp - 1] : null;
    const hasPrev = prevStepCmp && !!_stepAudioSnapshots[prevStepCmp];
    const hasCur = !!_stepAudioSnapshots[sid];

    if (hasPrev || hasCur) {
      html += `<div style="margin-top:6px;padding:8px;background:#1e293b;border-radius:6px">
        <div style="font-size:10px;color:#64748b;margin-bottom:4px">🎧 Karşılaştırmalı Dinleme</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">`;
      if (hasPrev) {
        html += `<div>
          <div style="font-size:10px;color:#f59e0b;margin-bottom:3px">◀ Önceki (${prevStepCmp}. adım)</div>
          <audio id="stp-${sid}-audio-prev" controls style="width:100%;height:28px;accent-color:#f59e0b"></audio>
        </div>`;
      }
      if (hasCur) {
        html += `<div>
          <div style="font-size:10px;color:#4ade80;margin-bottom:3px">▶ Bu adım (${sid}. adım)</div>
          <audio id="stp-${sid}-audio-cur" controls style="width:100%;height:28px;accent-color:#4ade80"></audio>
        </div>`;
      }
      html += `</div></div>`;
    }

    html += `<div style="display:flex;gap:6px;margin-top:4px">
      <button id="stp-${sid}-apply" style="flex:1;background:#1e3a5f;border:1px solid #7c3aed;border-radius:6px;color:#c084fc;cursor:pointer;padding:6px;font-size:11px;font-weight:700">⚙ Bu ayarlarla tekrar çalıştır</button>
      <button id="stp-${sid}-close" style="background:#1e293b;border:1px solid #334155;border-radius:6px;color:#64748b;cursor:pointer;padding:6px 10px;font-size:11px">✕</button>
    </div>`;

    panel.innerHTML = html;
    parentEl.appendChild(panel);

    // Range slider value gösterimi
    for (const p of cfg.params) {
      if (p.type === 'range') {
        const inp = panel.querySelector(`#stp-${sid}-${p.key}`);
        const valEl = panel.querySelector(`#stp-${sid}-${p.key}-val`);
        if (inp && valEl) inp.oninput = () => { valEl.textContent = inp.value; };
      }
    }

    // Audio player'lara blob URL bağla
    if (hasPrev) {
      const prevAudioEl = panel.querySelector(`#stp-${sid}-audio-prev`);
      if (prevAudioEl) prevAudioEl.src = URL.createObjectURL(_stepAudioSnapshots[prevStepCmp]);
    }
    if (hasCur) {
      const curAudioEl = panel.querySelector(`#stp-${sid}-audio-cur`);
      if (curAudioEl) curAudioEl.src = URL.createObjectURL(_stepAudioSnapshots[sid]);
    }

    // Kapat
    panel.querySelector(`#stp-${sid}-close`).onclick = () => panel.remove();

    // Uygula — önceki adımın audio'sundan bu adımı tekrar çalıştır
    panel.querySelector(`#stp-${sid}-apply`).onclick = async () => {
      const allSteps = ['1','1b','2','3','4','5','6','7','8b','8','9a','9b','9c'];
      const idx = allSteps.indexOf(sid);
      const prevStep = idx > 0 ? allSteps[idx - 1] : null;

      // Önceki adımın audio'sunu yükle
      let prevBlob = prevStep ? _stepAudioSnapshots[prevStep] : null;
      if (!prevBlob && prevStep) {
        const projName = _currentProjectName || localStorage.getItem('current_project_name') || 'default';
        const sa = await loadStepAudioFromDB(projName, prevStep);
        if (sa?.audio) prevBlob = new Blob([sa.audio], { type: sa.type || 'audio/mpeg' });
      }
      if (!prevBlob) { alert('Önceki adımın ses verisi bulunamadı.'); return; }

      // Parametreleri topla
      const params = {};
      for (const p of cfg.params) {
        if (p.type === 'info') continue;
        const el = panel.querySelector(`#stp-${sid}-${p.key}`);
        if (!el) continue;
        if (p.type === 'checkbox') params[p.key] = el.checked;
        else params[p.key] = el.value;
      }

      // Dosyayı hazırla
      const fileName = _rawFileBlob?.name || 'audio.mp3';
      _rawFileBlob = new File([prevBlob], fileName, { type: prevBlob.type || 'audio/mpeg' });
      try { state.audioBuffer = await new AudioContext().decodeAudioData(await prevBlob.slice(0).arrayBuffer()); } catch(_) {}

      panel.innerHTML = '<div style="padding:8px;color:#c084fc;font-size:11px;text-align:center">⏳ İşleniyor...</div>';

      try {
        const fd = new FormData();
        fd.append('file', _rawFileBlob, _rawFileBlob.name || 'audio.mp3');

        let endpoint = '', resultName = '';
        if (sid === '3') {
          endpoint = '/api/denoise-nr';
          fd.append('prop_decrease', params.prop_decrease || '0.65');
          resultName = '_nr.mp3';
        } else if (sid === '5') {
          endpoint = '/api/speech-only';
          for (const [k,v] of Object.entries(params)) fd.append(k, String(v));
          resultName = '_speech.mp3';
        } else if (sid === '9a') {
          endpoint = '/api/voicefixer';
          fd.append('mode', params.mode || '0');
          resultName = '_vf.mp3';
        } else if (sid === '9b') {
          endpoint = '/api/resemble-enhance';
          fd.append('mode', params.mode || 'denoise');
          resultName = '_re.mp3';
        } else if (sid === '9c') {
          endpoint = '/api/deepfilter';
          resultName = '_df.mp3';
        } else {
          panel.innerHTML = '<div style="padding:8px;color:#ef4444;font-size:11px">Bu adım henüz ayarlanamıyor</div>';
          return;
        }

        const resp = await fetch(endpoint, { method: 'POST', body: fd });
        if (!resp.ok) { const e = await resp.json().catch(()=>({error:resp.statusText})); throw new Error(e.error || resp.statusText); }
        const blob = await resp.blob();
        const newName = (fileName).replace(/\.[^.]+$/, '') + resultName;
        _rawFileBlob = new File([blob], newName, { type: 'audio/mpeg' });
        _stepAudioSnapshots[sid] = blob;
        try { state.audioBuffer = await new AudioContext().decodeAudioData(await blob.slice(0).arrayBuffer()); } catch(_) {}

        // DB'ye kaydet
        const projName = _currentProjectName || localStorage.getItem('current_project_name') || 'default';
        saveStepAudioToDB(projName, sid, _rawFileBlob).catch(() => {});

        _pipeLog(sid, '✓', `${sid}. Adım — ${cfg.title} (ayarlı) ✓`, '#c084fc');
        addLog('ok', `${sid}. Adım yeni parametrelerle tamamlandı: ${JSON.stringify(params)}`);
      } catch(e) {
        panel.innerHTML = `<div style="padding:8px;color:#ef4444;font-size:11px">❌ Hata: ${e.message}</div>`;
      }
    };
  }

  function _openStepPDF(stepNum) {
    const projName = _currentProjectName || 'Proje';
    const fmtSec = s => { s = Math.abs(s); const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60); return h ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`; };
    const fmtMB = v => `${v} MB`;
    const now = new Date().toLocaleString('tr-TR');

    // Tüm adımlar — Türkçe açıklamalar
    const allStepOrder = ['1','1b','2','3','4','5','6','7','8b','8','9a','9b','9c'];
    const stepDescTR = {
      '1': 'Ses kaydı yazıya çevrildi. Konuşmalar zaman damgalı olarak metin haline getirildi.',
      '1b': 'Yazıya çevrilen metindeki gereksiz dolgu kelimeleri (eee, şey, yani) temizlendi ve noktalama düzeltildi.',
      '2': 'Ses kaydından müzik, fan, klima gibi arka plan sesleri ayrıldı. Sadece insan sesi korundu.',
      '3': 'Kalan hışırtı, tıslama ve vızıltı gibi frekans bazlı gürültüler temizlendi.',
      '4': 'Anlık gürültüler (öksürük, bardak sesi, kapı kapanması) yapay zeka ile tespit edilip silindi.',
      '5': 'Konuşma olmayan bölgeler (rüzgar, ortam uğultusu) tespit edilip ses kaydından çıkarıldı.',
      '6': 'Kaç kişinin konuştuğu ve her konuşmacının hangi zaman aralığında konuştuğu tespit edildi.',
      '7': 'Ses kaydındaki sessiz bölgeler tespit edildi ve bir sessizlik haritası oluşturuldu.',
      '8': 'Konuşma olmayan sessiz bölgeler ses kaydından kesildi. Son temizlenmiş dosya oluşturuldu.',
      '9a': 'Düşük kaliteli ses restorasyonu yapıldı. Eksik frekanslar tamamlanarak ses netleştirildi.',
      '9b': 'Ses kaydına gürültü temizleme uygulandı. Arka plan sesleri filtrelenerek konuşma netleştirildi.',
      '9c': 'Derin filtreleme ile arka plan gürültüsü tamamen temizlendi. Konuşma kalitesi artırıldı.',
    };

    // Bu adıma kadar yapılan tüm adımları topla
    const idx = allStepOrder.indexOf(String(stepNum));
    const doneUpTo = allStepOrder.slice(0, idx + 1);

    let allStepsHtml = '';
    for (const sid of doneUpTo) {
      const det = _stepDetails[sid];
      const desc = stepDescTR[sid] || '';
      const dur = det?.elapsed ? det.elapsed + 's' : '—';
      const sizeBefore = det?.sizeBefore ? fmtMB(det.sizeBefore) : '—';
      const sizeAfter = det?.sizeAfter ? fmtMB(det.sizeAfter) : '—';
      const status = det ? '✓ Tamamlandı' : '♻ Arşivden';
      const color = det ? '#16a34a' : '#0891b2';
      allStepsHtml += `<tr>
        <td style="color:${color};font-weight:700">${sid}</td>
        <td>${desc}</td>
        <td style="color:${color}">${status}</td>
        <td>${dur}</td>
        <td>${sizeBefore}</td>
        <td>${sizeAfter}</td>
      </tr>`;
    }

    // Bu adımın detayları
    const d = _stepDetails[String(stepNum)];
    let currentStepHtml = '';
    if (d) {
      currentStepHtml = `
        <tr><td>İşlem Süresi</td><td>${d.elapsed ? d.elapsed + ' saniye' : '—'}</td></tr>
        <tr><td>Dosya Boyutu (Öncesi)</td><td>${fmtMB(d.sizeBefore)} · ${fmtSec(d.durBefore)}</td></tr>
        <tr><td>Dosya Boyutu (Sonrası)</td><td>${fmtMB(d.sizeAfter)} · ${fmtSec(d.durAfter)}</td></tr>
        <tr><td>Boyut Değişimi</td><td>${d.sizeBefore && d.sizeAfter ? ((d.sizeAfter-d.sizeBefore)>0?'+':'') + (d.sizeAfter-d.sizeBefore).toFixed(2)+' MB' : '—'}</td></tr>
        <tr><td>Süre Değişimi</td><td>${d.durBefore && d.durAfter ? ((d.durAfter-d.durBefore)>0?'+':'') + (d.durAfter-d.durBefore).toFixed(1)+' sn' : '—'}</td></tr>`;
    }

    const html = `<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8">
<title>Ses İşleme Raporu — ${projName} — ${stepNum}. Adım</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',Arial,sans-serif;font-size:10px;color:#1e293b;background:#f8fafc;padding:14px}
  h1{font-size:14px;color:#1e40af;margin-bottom:3px}
  h2{font-size:11px;color:#1e3a8a;margin:10px 0 5px;padding-bottom:3px;border-bottom:1.5px solid #bfdbfe}
  .header{background:linear-gradient(135deg,#1e3a8a,#0f766e);color:white;padding:12px 16px;border-radius:8px;margin-bottom:12px}
  .header h1{color:white}.header .sub{font-size:9px;opacity:0.8;margin-top:3px}
  .section{background:white;border:1px solid #e2e8f0;border-radius:6px;padding:10px;margin-bottom:10px}
  .highlight{background:#eff6ff;border:1px solid #bfdbfe;border-radius:5px;padding:8px;font-size:10px;color:#1e40af;line-height:1.5;margin-bottom:10px}
  table{width:100%;border-collapse:collapse;background:white;border-radius:6px;overflow:hidden;margin-bottom:8px}
  th{background:#1e3a8a;color:white;padding:4px 6px;text-align:left;font-size:8px}
  td{padding:4px 6px;border-bottom:1px solid #f1f5f9;font-size:9px}
  td:first-child{font-weight:600;color:#1e3a8a;width:120px}
  tr:last-child td{border-bottom:none}tr:nth-child(even){background:#f8fafc}
  .print-btn{position:fixed;top:8px;right:8px;background:#1e40af;color:white;border:none;border-radius:6px;padding:5px 12px;cursor:pointer;font-size:9px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,0.2)}
  @media print{.print-btn{display:none!important}}
</style></head><body>
<button class="print-btn" onclick="window.print()">🖨 PDF Olarak Kaydet</button>

<div class="header">
  <h1>🎙 Ses İşleme Raporu</h1>
  <div style="font-size:16px;margin-top:4px;font-weight:600">${projName}</div>
  <div class="sub">${stepNum}. adıma kadar yapılan işlemler · ${now}</div>
</div>

<h2>📌 Bu Adımda Yapılan İşlem</h2>
<div class="highlight">${stepDescTR[String(stepNum)] || '—'}</div>

${currentStepHtml ? `
<h2>📊 Bu Adımın Detayları</h2>
<div class="section">
  <table><tbody>${currentStepHtml}</tbody></table>
</div>` : ''}

${(() => {
  // Tüm adımların müdahale loglarını topla
  let intHtml = '';
  for (const sid of doneUpTo) {
    const det = _stepDetails[sid];
    if (!det?.interventions?.length) continue;
    intHtml += '<div style="margin-bottom:10px"><div style="font-weight:600;color:#1e3a8a;font-size:12px;margin-bottom:4px">' + sid + '. Adım — ' + (stepDescTR[sid]||'').split('.')[0] + '</div>';
    intHtml += '<ul style="margin:0;padding-left:18px;font-size:11px;color:#334155">';
    det.interventions.forEach(iv => { intHtml += '<li style="margin-bottom:2px">' + iv + '</li>'; });
    intHtml += '</ul></div>';
  }
  return intHtml ? '<h2>📝 Yapılan Müdahaleler (Detay)</h2><div class="section">' + intHtml + '</div>' : '';
})()}

<h2>🔄 Bu Adıma Kadar Yapılan Tüm İşlemler</h2>
<table>
  <thead><tr><th>#</th><th>Yapılan İşlem</th><th>Durum</th><th>Süre</th><th>Önceki Boyut</th><th>Sonraki Boyut</th></tr></thead>
  <tbody>${allStepsHtml}</tbody>
</table>

<div style="margin-top:20px;padding:10px;background:#f1f5f9;border-radius:8px;font-size:10px;color:#64748b;text-align:center">
  Rapor oluşturulma tarihi: ${now} · ${projName}
</div>
</body></html>`;

    const win = window.open('', '_blank');
    if (!win) { alert('Pop-up engelleyici açık!'); return; }
    win.document.write(html);
    win.document.close();
  }

  // Belirli bir adımın çıktısından devam et
  async function _restartFromStep(stepNum) {
    let blob = _stepAudioSnapshots[stepNum];
    // Bellekte yoksa IndexedDB'den dene
    if (!blob) {
      const projName = _currentProjectName || localStorage.getItem('current_project_name') || 'default';
      const saved = await loadStepAudioFromDB(projName, stepNum);
      if (saved?.audio) {
        blob = new Blob([saved.audio], { type: saved.type || 'audio/mpeg' });
        _stepAudioSnapshots[stepNum] = blob; // belleğe de koy
      }
    }
    if (!blob) { alert('Bu adımın ses verisi bulunamadı.'); return; }

    // Audio'yu bu adımın snapshot'ına geri al
    const fileName = _rawFileBlob?.name || 'audio.mp3';
    _rawFileBlob = new File([blob], fileName, { type: blob.type || 'audio/mpeg' });
    try {
      const ab = await new AudioContext().decodeAudioData(await blob.slice(0).arrayBuffer());
      state.audioBuffer = ab;
    } catch(_) {}

    // Bu adım ve öncesini done olarak işaretle, sonrasını sıfırla
    const allSteps = ['1','1b','2','3','4','5','6','7','8b','8','9a','9b','9c'];
    const idx = allSteps.indexOf(String(stepNum));
    const newDone = new Set(allSteps.slice(0, idx + 1));
    // Mevcut cutSegments'ı koru
    const _existingState = await loadPipelineStateFromDB(_currentProjectName) || await loadPipelineStateFromDB();
    await savePipelineStateToDB({
      doneSteps: [...newDone],
      origName:  _rawFileBlob?.name,
      fileName:  _rawFileBlob?.name,
      projectName: _currentProjectName || localStorage.getItem('current_project_name') || '',
      cutSegments: _existingState?.cutSegments || [],
      stepDetails: _existingState?.stepDetails || window._stepDetails || {},
      timestamp: Date.now()
    });

    // Checkbox'ları güncelle: done olanlar kaldır, kalanları seç
    const chkMap = {
      '1':'#ng-chk-whisper','1b':'#ng-chk-ollama','2':'#ng-chk-step2',
      '3':'#ng-chk-nr','4':'#ng-chk-enhance','5':'#ng-chk-speech-only',
      '6':'#ng-chk-step4','7':'#ng-chk-step5','8b':'#ng-chk-normalize','8':'#ng-chk-step6',
      '9a':'#ng-chk-voicefixer','9b':'#ng-chk-resemble','9c':'#ng-chk-deepfilter'
    };
    Object.entries(chkMap).forEach(([sid, sel]) => {
      const chk = modal.querySelector(sel);
      if (!chk) return;
      if (newDone.has(sid)) {
        // Tamamlanan adımlar — devre dışı
        chk.checked = false; chk.disabled = true;
        chk.parentElement.style.opacity = '0.45';
      } else {
        // Kalan adımlar — kilidi aç ve seçili yap
        chk.checked = true;
        chk.disabled = false;
        chk.parentElement.style.opacity = '1';
      }
    });

    // Progress loglarını temizle
    _pipeProg.innerHTML = '';

    addLog('info', `${stepNum}. adımdan devam edilecek — Başlat'a basın`);
    _pipeBtn.textContent = '🚀 Başlat';
    _pipeBtn.style.background = 'linear-gradient(135deg,#1e3a5f,#14532d)';
    _pipeBtn.disabled = false;

    // Bilgi notu göster
    const note = document.createElement('div');
    note.style.cssText = 'font-size:11px;color:#fbbf24;text-align:center;padding:4px 0';
    note.textContent = `▶ ${stepNum}. adımın çıktısından devam — kalan adımları seçip Başlat'a basın`;
    _pipeBtn.parentElement.insertBefore(note, _pipeBtn);
  }

  let _pipeTotalSteps = 4;

  // Sahte ilerleme ticker'ı — gerçek progress yokken kullanılır
  function _fakeTick(stepNum, label, estSec) {
    let pct = 0;
    const rate = 88 / Math.max(estSec, 10); // saniyede kaç %
    const t = setInterval(() => {
      pct = Math.min(90, pct + rate);
      _pipeLog(stepNum, '⏳', `${label} %${Math.round(pct)}`, '#f59e0b');
    }, 1000);
    return { stop: () => clearInterval(t) };
  }

  // Pipeline içi dosya güncelleme — loadFile'ın aksine modal'ı sıfırlamaz
  async function _pipeUpdateFile(file) {
    _rawFileBlob = file;
    const rawBuf = await file.arrayBuffer();
    const rawCopy = rawBuf.slice(0); // decodeAudioData rawBuf'u tüketir, önceden kopyala
    const ctx = getCtx();
    state.audioBuffer = await ctx.decodeAudioData(rawBuf);
    state.fileName = file.name;
    if (infoFile) infoFile.textContent = file.name;
    if (infoMeta) infoMeta.textContent =
      `${formatTime(state.audioBuffer.duration)} · ${state.audioBuffer.sampleRate.toLocaleString()}Hz · ${state.audioBuffer.numberOfChannels}ch`;
    try { await saveSessionToDB(rawCopy, file.name, file.size); } catch(_e) {}
  }

  async function _pipeRunVad() {
    const rec = window._audioProfile?.recommended || {};
    const fd = new FormData();
    fd.append('file', _rawFileBlob, _rawFileBlob.name || 'audio.wav');
    if (rec.vad_threshold) fd.append('threshold', String(rec.vad_threshold));
    if (rec.min_speech_ms) fd.append('min_speech_ms', String(rec.min_speech_ms));
    if (rec.min_silence_ms) fd.append('min_silence_ms', String(rec.min_silence_ms));
    const r1 = await fetch('/api/vad', { method: 'POST', body: fd });
    const d1 = await r1.json().catch(()=>({ success: false, error: r1.statusText }));
    if (!r1.ok || !d1.success) throw new Error(d1.error || r1.statusText);
    const jobId = d1.job_id;
    const data = await new Promise((resolve, reject) => {
      const t = setInterval(async () => {
        try {
          const rs = await fetch(`/api/vad/progress/${jobId}`);
          const ds = await rs.json();
          _pipeLog(7, '⏳', `7. Adım — %${ds.pct || 0} ${ds.step || '…'}`, '#f59e0b');
          _setStatusBar(`⏳ 7. Adım: VAD %${ds.pct || 0}`, '#f59e0b');
          if (ds.status === 'done')  { clearInterval(t); resolve(ds.result); }
          if (ds.status === 'error') { clearInterval(t); reject(new Error(ds.error)); }
        } catch(e) { clearInterval(t); reject(e); }
      }, 600);
    });
    ngVadSegs = data.segments;
    CanvasOverlay.setVad(ngVadSegs);
    if (_rawFileBlob) saveVadToDB(_rawFileBlob.name, _rawFileBlob.size, data.segments);
    draw(threshold);
    return data;
  }

  async function _pipeRunDiarize(token, nspk) {
    const fd = new FormData();
    fd.append('file', _rawFileBlob, _rawFileBlob.name || 'audio.wav');
    fd.append('hf_token', token);
    if (nspk) fd.append('num_speakers', nspk);
    const res = await fetch('/api/diarize', { method: 'POST', body: fd });
    if (!res.ok) { const t = await res.text(); throw new Error(`HTTP ${res.status} — ${t.slice(0,200)}`); }
    const { job_id } = await res.json();
    // Polling — aynı mantık
    let _notFound = 0;
    const data = await new Promise((resolve, reject) => {
      const poll = setInterval(async () => {
        try {
          const pr = await fetch(`/api/diarize/progress/${job_id}`);
          if (pr.status === 404) { if (++_notFound > 3) { clearInterval(poll); reject(new Error('Sunucu yeniden başladı')); } return; }
          const pd = await pr.json();
          _notFound = 0;
          _pipeLog(6, '⏳', `6. Adım — ${pd.step || '…'} %${pd.pct||0}`, '#f59e0b');
          _setStatusBar(`⏳ 6. Adım: pyannote %${pd.pct||0}`, '#f59e0b');
          if (pd.status === 'done')  { clearInterval(poll); resolve(pd.result); }
          else if (pd.status === 'error') { clearInterval(poll); reject(new Error(pd.error)); }
        } catch(e) { if (++_notFound > 5) { clearInterval(poll); reject(e); } }
      }, 600);
    });
    if (window._restoreDiarize) window._restoreDiarize(data);
    saveDiarizeToDB(_rawFileBlob.name, _rawFileBlob.size, data);
    return data;
  }

  async function _pipeRunWhisper(model) {
    const fd = new FormData();
    // Türkçe karakterli dosya adı Werkzeug'da Latin-1 patlatabilir → ASCII-safe ad
    const _safeName = (_rawFileBlob.name || 'audio.mp3').replace(/[^\x20-\x7E]/g, '_');
    fd.append('file', _rawFileBlob, _safeName);
    fd.append('model', model);
    const r1 = await fetch('/api/transcribe/start', { method: 'POST', body: fd });
    const _rawTxt = await r1.text();
    if (!r1.ok) {
      const _snippet = _rawTxt.slice(0, 300).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      throw new Error(`Whisper start HTTP ${r1.status} ${r1.statusText} — ${_snippet || '(yanıt boş)'}`);
    }
    let d1;
    try { d1 = JSON.parse(_rawTxt); }
    catch (_je) {
      throw new Error(`Whisper yanıtı JSON değil (HTTP ${r1.status}): ${_rawTxt.slice(0,300)}`);
    }
    if (!d1.success) throw new Error(d1.error);
    const jobId = d1.job_id;
    return await new Promise((resolve, reject) => {
      const t = setInterval(async () => {
        try {
          const rs = await fetch(`/api/transcribe/status/${jobId}`);
          const ds = await rs.json();
          const pct      = ds.progress  || 0;
          const elapsed  = ds.elapsed   ? ` [${Math.round(ds.elapsed)}s]` : '';
          const pos      = ds.step      ? ` | ${ds.step}` : '';
          const segInfo  = ds.seg_count ? ` | ${ds.seg_count} seg` : '';
          const txt      = ds.step_text ? `\n   "${ds.step_text}"` : '';
          if (ds.status === 'queued') {
            _pipeLog(1, '⏳', `1. Adım — Whisper sırada bekliyor${elapsed}`, '#f59e0b');
          } else if (ds.status === 'loading_model') {
            _pipeLog(1, '⏸', `1. Adım — Model yükleniyor (Large ~3GB)${elapsed}`, '#f59e0b');
          } else if (ds.status === 'transcribing') {
            _pipeLog(1, '⏳', `1. Adım — Whisper %${pct}${pos}${segInfo}${elapsed}${txt}`, '#f59e0b');
          }
          if (ds.status === 'done')  { clearInterval(t); saveTranscriptToDB(ds.result); resolve(ds.result); }
          if (ds.status === 'error') { clearInterval(t); reject(new Error(ds.error)); }
        } catch(e) { /* ağ hatası — tekrar dene */ }
      }, 1000);
    });
  }

  async function _pipeRunDenoiseNR(propDecrease) {
    const fd = new FormData();
    fd.append('file', _rawFileBlob, _rawFileBlob.name || 'audio.wav');
    fd.append('prop_decrease', propDecrease ?? 0.75);
    const durSec = state.audioBuffer?.duration || 120;
    const ticker = _fakeTick(3, '3. Adım — Gürültü bastırma (NoiseReduce)...', durSec * 0.15);
    try {
      const res = await pipeFetch('/api/denoise-nr', { method: 'POST', body: fd });
      ticker.stop();
      if (!res.ok) { const e = await res.json().catch(()=>({error:res.statusText})); throw new Error(e.error||res.statusText); }
      const blob = await res.blob();
      const base = (_rawFileBlob.name || 'ses').replace(/\.[^.]+$/, '');
      const nrFile = new File([blob], base + '_nr.mp3', { type: 'audio/mpeg' });
      await _pipeUpdateFile(nrFile);
      return nrFile;
    } catch(e) { ticker.stop(); throw e; }
  }

  async function _pipeRunSpeechOnly() {
    const rec = window._audioProfile?.recommended || {};
    const fd = new FormData();
    fd.append('file', _rawFileBlob, _rawFileBlob.name || 'audio.wav');
    fd.append('threshold', String(rec.speech_only_threshold || 0.30));
    fd.append('min_ms', String(rec.min_speech_ms || 50));
    fd.append('pad_ms', String(rec.pad_ms || 150));
    fd.append('bandpass', 'true');
    const r1 = await pipeFetch('/api/speech-only/start', { method: 'POST', body: fd });
    if (!r1.ok) { const e = await r1.json().catch(()=>({error:r1.statusText})); throw new Error(e.error||r1.statusText); }
    const { job_id } = await r1.json();

    // Polling
    const result = await new Promise((resolve, reject) => {
      const poll = setInterval(async () => {
        try {
          const pr = await fetch(`/api/speech-only/progress/${job_id}`);
          if (pr.status === 404) { clearInterval(poll); reject(new Error('Job bulunamadı')); return; }
          const pd = await pr.json();
          _pipeLog(5, '⏳', `5. Adım — ${pd.step || '…'} %${pd.pct || 0}`, '#38bdf8');
          _setStatusBar(`⏳ 5. Adım: ${pd.step || '…'} %${pd.pct || 0}`, '#38bdf8');
          if (pd.status === 'done')  { clearInterval(poll); resolve(pd); }
          if (pd.status === 'error') { clearInterval(poll); reject(new Error(pd.error)); }
        } catch(e) { clearInterval(poll); reject(e); }
      }, 800);
    });

    // İndir
    const dlRes = await fetch(`/api/speech-only/download/${job_id}`);
    if (!dlRes.ok) throw new Error('İndirme hatası: ' + dlRes.statusText);
    const blob = await dlRes.blob();
    const base = (_rawFileBlob.name || 'ses').replace(/\.[^.]+$/, '');
    const soFile = new File([blob], base + '_sadece_konusma.mp3', { type: 'audio/mpeg' });
    await _pipeUpdateFile(soFile);
    return soFile;
  }

  async function _pipeRunDemucs() {
    const fd = new FormData();
    fd.append('file', _rawFileBlob, _rawFileBlob.name || 'audio.wav');
    fd.append('stem', 'vocals');
    const durSec = state.audioBuffer?.duration || 120;
    const ticker = _fakeTick(2, '2. Adım — Vokal izolasyonu (Demucs)...', durSec * 0.7);
    try {
      const res = await pipeFetch('/api/denoise', { method: 'POST', body: fd });
      ticker.stop();
      if (!res.ok) { const e = await res.json().catch(()=>({error:res.statusText})); throw new Error(e.error||res.statusText); }
      const blob = await res.blob();
      const base = (_rawFileBlob.name || 'ses').replace(/\.[^.]+$/, '');
      const vocalFile = new File([blob], base + '_vocals.mp3', { type: 'audio/mpeg' });
      await _pipeUpdateFile(vocalFile);
      return vocalFile;
    } catch(e) { ticker.stop(); throw e; }
  }

  async function _pipeApplyStep1() {
    const _chk = modal.querySelector('#ng-chk-step1');
    if (_chk && !_chk.checked) return null;
    const segs = computeSegs(threshold, minDurSec);
    if (!segs.length) return null;
    const blob = await uploadAndProcess(segs, null);
    const base = (_rawFileBlob.name || 'ses').replace(/\.[^.]+$/, '');
    const processed = new File([blob], base + '_esik.mp3', { type: 'audio/mpeg' });
    await _pipeUpdateFile(processed);
    return processed;
  }

  // ── Post-pipeline butonları ───────────────────────────────────────────────────
  modal.querySelector('#ng-to-canvas-btn').onclick = () => {
    const sec = modal.querySelector('#ng-canvas-section');
    if (sec) sec.style.display = 'flex';
    sec?.scrollIntoView({ behavior: 'smooth' });
  };

  modal.querySelector('#ng-download-final-btn').onclick = () => {
    if (!_rawFileBlob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(_rawFileBlob);
    const cleanDlName = (_currentProjectName || _rawFileBlob.name || 'son_hal').replace(/\.[^.]+$/, '').replace(/^temizlenmis\d*_?/, '').replace(/_(vocals|nr|enhanced|sadece_konusma|vf|re|df|cut|speech).*/i, '');
    a.download = 'temizlenmis_' + cleanDlName + '.mp3';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  };

  const _statusBar = modal.querySelector('#ng-status-bar');
  function _setStatusBar(txt, color) {
    if (!_statusBar) return;
    _statusBar.style.display = 'block';
    _statusBar.style.background = color === '#ef4444' ? '#450a0a' : color === '#4ade80' ? '#14532d' : '#0f172a';
    _statusBar.style.border = `1px solid ${color}`;
    _statusBar.style.color = color;
    _statusBar.textContent = txt;
  }

  _pipeBtn.onclick = async () => {
    if (!_rawFileBlob) { aiSetStatus('Önce ses dosyası yükleyin', '#ef4444'); return; }
    _pipelineRunning = true;
    _startHwDash();
    _pipeBtn.disabled = true;
    _pipeBtn.textContent = '⏳ Başlatılıyor...';
    _pipeBtn.style.background = 'linear-gradient(135deg,#1c2f1c,#0f2d1a)';
    _pipeStop.style.display = 'inline-block';
    _pipeProg.innerHTML = '';
    _pipeProg.style.display = 'flex';
    _setStatusBar('⏳ Pipeline çalışıyor...', '#f59e0b');
    floatLogClear();

    /* Sunucu log paneli — endpoint hazır olunca açılır */
    const _srvLogWrap = modal.querySelector('#ng-server-log-wrap');
    const _srvLogList = modal.querySelector('#ng-server-log-list');
    const _srvLogBtn  = modal.querySelector('#ng-server-log-btn');
    const _srvLogClose= modal.querySelector('#ng-server-log-close');
    let _srvLogTimer = null;
    async function _fetchServerLog() {
      if (_pipeStepBusy) return; // Pipeline adımı çalışırken polling yapma
      try {
        const r = await fetch('/api/server-log?n=80');
        if (!r.ok) { if (_srvLogWrap) _srvLogWrap.style.display='none'; return; }
        const d = await r.json();
        if (!d.success) return;
        if (_srvLogWrap) _srvLogWrap.style.display = 'flex';
        _srvLogList.innerHTML = '';
        d.logs.forEach(l => {
          const c = l.level === 'ERROR' || l.level === 'CRITICAL' ? '#ef5350'
                  : l.level === 'WARNING' ? '#ffa726' : '#4fc3f7';
          const row = document.createElement('div');
          row.style.cssText = 'padding:1px 0;border-bottom:1px solid rgba(255,255,255,0.03);display:flex;align-items:flex-start;gap:4px';
          const txt = document.createElement('span');
          txt.style.cssText = `color:${c};flex:1;word-break:break-all`;
          txt.textContent = `[${l.ts}] ${l.level} ${l.msg}`;
          const cp = document.createElement('button');
          cp.textContent = '⎘'; cp.title = 'Kopyala';
          cp.style.cssText = 'background:transparent;border:none;cursor:pointer;color:#334155;font-size:11px;padding:0 2px;flex-shrink:0;line-height:1';
          cp.addEventListener('click', () => {
            navigator.clipboard.writeText(`[${l.ts}] ${l.level} ${l.msg}`).then(() => {
              cp.textContent = '✔'; cp.style.color = '#4ade80';
              setTimeout(() => { cp.textContent = '⎘'; cp.style.color = '#334155'; }, 1200);
            });
          });
          row.appendChild(txt); row.appendChild(cp);
          _srvLogList.appendChild(row);
        });
        _srvLogList.scrollTop = _srvLogList.scrollHeight;
      } catch(e) { /* endpoint yok — sessiz geç */ }
    }
    _fetchServerLog();
    _srvLogTimer = setInterval(_fetchServerLog, 2000);
    if (_srvLogBtn)   _srvLogBtn.onclick   = _fetchServerLog;
    if (_srvLogClose) _srvLogClose.onclick = () => { clearInterval(_srvLogTimer); if (_srvLogWrap) _srvLogWrap.style.display='none'; };
    const _srvLogCopyAll = modal.querySelector('#ng-server-log-copy-all');
    if (_srvLogCopyAll) _srvLogCopyAll.onclick = () => {
      const lines = [..._srvLogList.querySelectorAll('span[style*="color"]')].map(s => s.textContent).join('\n');
      if (!lines) return;
      navigator.clipboard.writeText(lines).then(() => {
        _srvLogCopyAll.textContent = '✔ Kopyalandı';
        _srvLogCopyAll.style.color = '#4ade80';
        setTimeout(() => { _srvLogCopyAll.textContent = '⎘ Tümünü Kopyala'; _srvLogCopyAll.style.color = '#94a3b8'; }, 2000);
      });
    };

    const chkWhisper    = modal.querySelector('#ng-chk-whisper')?.checked;
    const chkOllama     = modal.querySelector('#ng-chk-ollama')?.checked;
    const chkDemucs     = modal.querySelector('#ng-chk-step2')?.checked;
    const chkNR         = modal.querySelector('#ng-chk-nr')?.checked;
    const chkEnhance    = modal.querySelector('#ng-chk-enhance')?.checked;
    const chkSpeechOnly = modal.querySelector('#ng-chk-speech-only')?.checked;
    const chkDiarize    = modal.querySelector('#ng-chk-step4')?.checked;
    const chkVad        = modal.querySelector('#ng-chk-step5')?.checked;
    const chkCut        = modal.querySelector('#ng-chk-step6')?.checked;
    const chkVoiceFixer = modal.querySelector('#ng-chk-voicefixer')?.checked;
    const chkResemble   = modal.querySelector('#ng-chk-resemble')?.checked;
    const chkDeepFilter = modal.querySelector('#ng-chk-deepfilter')?.checked;
    const chkAutoBoost  = modal.querySelector('#ng-chk-autoboost')?.checked;

    // ── Ses Analizi — dosyaya özel eşik hesaplama ──────────────────────────────
    window._audioProfile = null;
    try {
      _pipeLog(0, '⏳', '🔍 Ses analiz ediliyor — optimal eşikler hesaplanıyor...', '#c084fc');
      const afd = new FormData();
      afd.append('file', _rawFileBlob, _rawFileBlob.name || 'audio.mp3');
      const ar = await fetch('/api/analyze-audio', { method: 'POST', body: afd });
      if (ar.ok) {
        const ad = await ar.json();
        if (ad.success) {
          window._audioProfile = ad;
          const a = ad.analysis;
          const r = ad.recommended;
          _pipeLog(0, '✓', `🔍 Ses Profili: ${a.profile.toUpperCase()} · SNR ${a.snr_db}dB · Sessizlik %${(a.silence_ratio*100).toFixed(0)} · Ses çeşitliliği: ${a.volume_diversity}`, '#c084fc');
          addLog('info', `Ses analizi: profil=${a.profile}, SNR=${a.snr_db}dB, VAD=${r.vad_threshold}, NR=${r.nr_prop_decrease}`);
        }
      }
    } catch(e) { addLog('warn', 'Ses analizi atlandı: ' + e.message); }
    let hfTok = modal.querySelector('#ng-hf-token')?.value.trim() || localStorage.getItem('hf_token') || '';
    // Token boşsa sunucudan çek (async race condition önleme)
    if (!hfTok) {
      try {
        const cfgR = await fetch('/api/config');
        const cfgD = await cfgR.json();
        if (cfgD.hf_token) {
          hfTok = cfgD.hf_token;
          const inp = modal.querySelector('#ng-hf-token');
          if (inp) inp.value = hfTok;
          localStorage.setItem('hf_token', hfTok);
        }
      } catch(_) {}
    }
    const nspk  = modal.querySelector('#ng-hf-nspk')?.value.trim() || '';
    const wModel= modal.querySelector('#ng-whisper-model')?.value || 'large';

    _pipeTotalSteps = [chkWhisper,chkDemucs,chkNR,chkEnhance,chkSpeechOnly,chkDiarize,chkVad,chkVoiceFixer,chkResemble,chkDeepFilter].filter(Boolean).length;
    let _curStep = 1;

    // ── Kaldığı yerden otomatik devam ────────────────────────────────────────
    const _pipeOrigFileName = _rawFileBlob?.name;
    let _doneSteps = new Set();
    const _projN = _currentProjectName || localStorage.getItem('current_project_name') || '';
    let _resumeState = await loadPipelineStateFromDB(_projN);
    if (!_resumeState?.doneSteps?.length) _resumeState = await loadPipelineStateFromDB();
    addLog('info', `[resume-pipeline] DB'den okunan: doneSteps=${JSON.stringify(_resumeState?.doneSteps||[])}, proje=${_projN}`);
    if (_resumeState?.doneSteps?.length) {
      _doneSteps = new Set(_resumeState.doneSteps.map(String));
      addLog('info', `[resume-pipeline] ${_doneSteps.size} adım atlanacak: ${[..._doneSteps].join(', ')}`);
    }

    const _persistOrigName = _resumeState?.origName || _pipeOrigFileName;
    const _persistCutSegs = _resumeState?.cutSegments || [];
    const _savePipeState = async () => {
      await savePipelineStateToDB({
        doneSteps: [..._doneSteps],
        origName:  _persistOrigName,
        fileName:  _rawFileBlob?.name,
        projectName: _currentProjectName || localStorage.getItem('current_project_name') || '',
        cutSegments: _pipe8Segs || _persistCutSegs || [],
        stepDetails: { ...(window._stepDetails || {}) },
        speakerNames: window._pipelineSpeakerNames || {},
        timestamp: Date.now()
      });
    };

    // Rapor adım takibi
    let _rStep = null;
    let _stepStartTime = null;
    let _pendingInterventions = [];
    let _pipe8Segs = null;
    let _stepSizeBefore = 0;
    let _stepDurBefore = 0;
    const _ok     = (n, txt) => {
      const elapsed = _stepStartTime ? ((Date.now() - _stepStartTime) / 1000).toFixed(1) : '?';
      const sizeAfter = +((_rawFileBlob?.size||0)/1024/1024).toFixed(2);
      const durAfter = +(state.audioBuffer?.duration||0).toFixed(1);
      _stepDetails[String(n)] = {
        name: txt, status: 'done', stepNum: String(n),
        startTime: _stepStartTime, endTime: Date.now(), elapsed: +elapsed,
        sizeBefore: _stepSizeBefore, sizeAfter,
        durBefore: _stepDurBefore, durAfter,
        fileName: _rawFileBlob?.name || '',
        details: _rStep?.details || {},
        interventions: _pendingInterventions || []
      };
      _pendingInterventions = [];
      _doneSteps.add(String(n)); _saveStepAudio(n); _pipeLog(n, '✓', txt, '#4ade80'); addLog('ok', txt); _savePipeState();
      if (_rStep) { _reportStepDone(_rStep); _rStep = null; }
    };
    const _busy   = (n, txt) => {
      _curStep = n; _stepStartTime = Date.now();
      _stepSizeBefore = +((_rawFileBlob?.size||0)/1024/1024).toFixed(2);
      _stepDurBefore = +(state.audioBuffer?.duration||0).toFixed(1);
      _pipeLog(n, '⏳', txt, '#f59e0b'); _rStep = _reportStep(n, txt.replace(/^[\d\w.]+\s*—\s*/,''));
    };
    const _skip   = (n, txt) => { _pipeLog(n, '○', txt, '#334155'); _reportStepSkip(n, txt.replace(/^[\d\w.]+\s*—\s*/,'')); };
    const _err    = (n, txt) => { _pipeLog(n, '✗', txt, '#ef4444'); addLog('error', txt); if (_rStep) { _rStep.status='error'; _rStep.endTime=new Date(); _rStep=null; } };
    const _resume = async (n, txt) => {
      // DB'den step audio yükle (varsa)
      if (!_stepAudioSnapshots[String(n)]) {
        const projName = _currentProjectName || localStorage.getItem('current_project_name') || 'default';
        try {
          const sa = await loadStepAudioFromDB(projName, n);
          if (sa?.audio) _stepAudioSnapshots[String(n)] = new Blob([sa.audio], { type: sa.type || 'audio/mpeg' });
        } catch(_) {}
      }
      // DB'de yoksa mevcut _rawFileBlob'u kaydet (ilk çalışmada arşivden gelen adımlar)
      if (!_stepAudioSnapshots[String(n)] && _rawFileBlob) {
        _saveStepAudio(n);
      }
      _pipeLog(n, '♻', txt, '#22d3ee'); _reportStepResume(n, txt.replace(/^[\d\w.]+\s*—\s*/,''));
    };

    try {
      // 1. Adım — Whisper
      if (!_pipelineRunning) return;
      if (_doneSteps.has('1')) {
        // Transkript DB'den yükle (Ollama ve diğer adımlar için gerekli)
        if (!_ngTranscript) {
          try {
            const _trCached = await loadTranscriptFromDB();
            if (_trCached?.segments?.length) { _ngTranscript = _trCached; _renderNgTranscript(_trCached, true); console.log('[resume-1] Transkript yüklendi:', _trCached.segments.length); }
          } catch(_) {}
        }
        await _resume(1, `1. Adım — Konuşma yazıya çevrildi ✓`);
      } else if (chkWhisper) {
        _busy(1, `1. Adım — Whisper (${wModel}) transkripsiyon...`);
        const tr = await _pipeRunWhisper(wModel);
        _renderNgTranscript(tr, false);
        const _wWords = tr.segments?.reduce((a,s)=>a+(s.text?.trim().split(/\s+/).length||0),0)||0;
        if (_rStep) _rStep.details = { model: wModel, segments: tr.segments?.length||0, words: _wWords, language: tr.language||'tr' };
        _pendingInterventions = (tr.segments||[]).slice(0,5).map(s => `[${Math.floor(s.start/60)}:${String(Math.floor(s.start%60)).padStart(2,'0')}] "${(s.text||'').trim().slice(0,60)}"`);
        _pendingInterventions.unshift(`Toplam ${tr.segments?.length||0} konuşma segmenti tespit edildi, ${_wWords} kelime yazıya çevrildi`);
        _ok(1, `1. Adım — Konuşma yazıya çevrildi: ${tr.segments?.length || 0} bölüm, ${_wWords} kelime`);
      } else { _skip(1, '1. Adım — atlandı'); }

      // 1b. Adım — Ollama transkript temizleme
      if (!_pipelineRunning) return;
      if (_doneSteps.has('1b')) {
        await _resume('1b', '1b. Adım — Metin temizlendi ✓');
      } else if (chkOllama && _ngTranscript?.segments?.length) {
        _busy('1b', '1b. Adım — Ollama transkript temizleme (mistral-nemo)...');
        _setStatusBar('⏳ 1b. Ollama transkript temizliyor...', '#f59e0b');
        try {
          const or1 = await fetch('/api/transcript/clean', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ segments: _ngTranscript.segments })
          });
          if (or1.ok) {
            const od1 = await or1.json();
            if (od1.success) {
              _renderOllamaTranscript(od1.cleaned);
              _reportOllama(_ngTranscript.segments?.map(s=>s.text).join('\n')||'', od1.cleaned);
              if (_rStep) _rStep.details = { model: od1.model, inputChars: _ngTranscript.segments?.map(s=>s.text).join('').length||0, outputChars: od1.cleaned.length };
              _ok('1b', `1b. Adım — Metin temizlendi ve düzeltildi`);
            } else {
              _pipeLog('1b', '⚠', `1b. Adım — Ollama hata: ${od1.error}`, '#f59e0b');
            }
          } else {
            _pipeLog('1b', '⚠', '1b. Adım — Ollama bağlantı hatası, atlandı', '#f59e0b');
          }
        } catch(e) {
          _pipeLog('1b', '⚠', `1b. Adım — Ollama hatası: ${e.message}`, '#f59e0b');
        }
      } else if (chkOllama && !_ngTranscript?.segments?.length) {
        _pipeLog('1b', '○', '1b. Adım — Whisper çalışmadı, Ollama atlandı', '#334155');
      } else {
        _skip('1b', '1b. Adım — atlandı');
      }

      // 2. Adım — Vokal izolasyonu (Demucs)
      if (!_pipelineRunning) return;
      if (_doneSteps.has('2')) {
        await _resume(2, `2. Adım — Arka plan sesleri ayrıldı ✓`);
      } else if (chkDemucs) {
        _busy(2, '2. Adım — Vokal izolasyonu (Demucs)...');
        await _pipeRunDemucs();
        _pendingInterventions = [
          `Müzik, fan, klima, televizyon gibi sürekli arka plan sesleri ayrıştırıldı`,
          `Boyut: ${_stepSizeBefore}MB → ${+((_rawFileBlob?.size||0)/1024/1024).toFixed(1)}MB`,
          `Sadece insan sesi korundu, diğer ses kaynakları silindi`
        ];
        _ok(2, `2. Adım — Arka plan sesleri ayrıldı, sadece insan sesi korundu`);
      } else { _skip(2, '2. Adım — atlandı'); }

      // 3. Adım — Gürültü Bastırma (NoiseReduce)
      if (!_pipelineRunning) return;
      if (_doneSteps.has('3')) {
        await _resume(3, `3. Adım — Frekans gürültüsü temizlendi ✓`);
      } else if (chkNR) {
        _busy(3, '3. Adım — Gürültü bastırma (NoiseReduce)...');
        await _pipeRunDenoiseNR(window._audioProfile?.recommended?.nr_prop_decrease || 0.65);
        const nrProp = window._audioProfile?.recommended?.nr_prop_decrease || 0.65;
        _pendingInterventions = [
          `Gürültü azaltma gücü: %${Math.round(nrProp*100)}`,
          `Hışırtı, tıslama, vızıltı ve elektrik paraziti temizlendi`,
          `Boyut: ${_stepSizeBefore}MB → ${+((_rawFileBlob?.size||0)/1024/1024).toFixed(1)}MB`
        ];
        _ok(3, `3. Adım — Frekans bazlı gürültüler temizlendi`);
      } else { _skip(3, '3. Adım — atlandı'); }

      // 4. Adım — Neural Ses İyileştirme (DNS64)
      if (!_pipelineRunning) return;
      if (_doneSteps.has('4')) {
        await _resume(4, `4. Adım — Anlık gürültüler silindi ✓`);
      } else if (chkEnhance) {
        _busy(4, '4. Adım — Neural ses iyileştirme (DNS64)...');
        _setStatusBar('⏳ 4. Adım: DNS64 GPU ile çalışıyor...', '#a855f7');
        const fd4 = new FormData();
        fd4.append('file', _rawFileBlob, _rawFileBlob.name || 'audio.mp3');
        const r4 = await pipeFetch('/api/enhance', { method: 'POST', body: fd4 });
        if (!r4.ok) { const e4 = await r4.json().catch(()=>({error:r4.statusText})); throw new Error(e4.error||r4.statusText); }
        const blob4 = await r4.blob();
        const base4 = (_rawFileBlob.name||'ses').replace(/\.[^.]+$/,'');
        await _pipeUpdateFile(new File([blob4], base4+'_enhanced.mp3', {type:'audio/mpeg'}));
        _pendingInterventions = [
          `Öksürük, bardak sesi, kapı kapanması, hapşırma gibi anlık gürültüler silindi`,
          `60 saniyelik parçalar halinde GPU ile işlendi`,
          `Boyut: ${_stepSizeBefore}MB → ${+((_rawFileBlob?.size||0)/1024/1024).toFixed(1)}MB`
        ];
        _ok(4, `4. Adım — Anlık gürültüler silindi (öksürük, bardak, kapı)`);
      } else { _skip(4, '4. Adım — atlandı'); }

      // 5. Adım — Sadece Konuşma Sesini Tut
      if (!_pipelineRunning) return;
      if (_doneSteps.has('5')) {
        await _resume(5, `5. Adım — Konuşma dışı sesler temizlendi ✓`);
      } else if (chkSpeechOnly) {
        _busy(5, '5. Adım — Sadece konuşma sesini tut (band-pass + VAD)...');
        await _pipeRunSpeechOnly();
        const soRec = window._audioProfile?.recommended || {};
        _pendingInterventions = [
          `Frekans filtresi: 60Hz-8000Hz band-pass uygulandı`,
          `VAD eşik: ${soRec.speech_only_threshold||0.30} · Min konuşma: ${soRec.min_speech_ms||50}ms · Dolgu: ${soRec.pad_ms||150}ms`,
          `Rüzgar, trafik, ortam uğultusu gibi konuşma dışı sesler temizlendi`,
          `Boyut: ${_stepSizeBefore}MB → ${+((_rawFileBlob?.size||0)/1024/1024).toFixed(1)}MB`
        ];
        _ok(5, `5. Adım — Konuşma dışı sesler temizlendi`);
      } else { _skip(5, '5. Adım — atlandı'); }

      // 6. Adım — Konuşmacı tespiti
      if (!_pipelineRunning) return;
      if (_doneSteps.has('6')) {
        // Diarize sonuçlarını DB'den yükle
        if (!ngDiarizeSegs.length) {
          const _tryNames2 = [_rawFileBlob?.name, _pipeOrigFileName, _persistOrigName].filter(Boolean);
          const _trySizes2 = [_rawFileBlob?.size].filter(Boolean);
          for (const nm of _tryNames2) {
            for (const sz of _trySizes2) {
              try {
                const c = await loadDiarizeFromDB(nm, sz);
                if (c?.segments?.length) { ngDiarizeSegs = c.segments; break; }
              } catch(_) {}
            }
            if (ngDiarizeSegs.length) break;
          }
          if (!ngDiarizeSegs.length) {
            try {
              const db = await openDB();
              const tx = db.transaction('diarize','readonly');
              const all = await new Promise(r=>{const req=tx.objectStore('diarize').getAll();req.onsuccess=()=>r(req.result||[])});
              const found = all.find(v=>v?.segments?.length);
              if (found) ngDiarizeSegs = found.segments;
            } catch(_) {}
          }
          if (ngDiarizeSegs.length) console.log('[resume-6] Diarize yüklendi:', ngDiarizeSegs.length);
        }
        // Kayıtlı konuşmacı isimlerini yükle
        try {
          const _pnR6 = _currentProjectName || localStorage.getItem('current_project_name') || '';
          const _psR6 = await loadPipelineStateFromDB(_pnR6) || await loadPipelineStateFromDB() || {};
          if (_psR6.speakerNames && Object.keys(_psR6.speakerNames).length) {
            window._pipelineSpeakerNames = _psR6.speakerNames;
            const _metaSpR = modal.querySelector('#ng-meta-speakers');
            if (_metaSpR && !_metaSpR.value.trim()) _metaSpR.value = Object.values(_psR6.speakerNames).join(', ');
            console.log('[resume-6] Speaker isimleri yüklendi:', _psR6.speakerNames);
          }
        } catch(_) {}
        await _resume(6, `6. Adım — Konuşmacılar tespit edildi ✓`);
      } else if (chkDiarize) {
        if (!hfTok) { _err(6, '6. Adım — HuggingFace token girilmemiş, atlandı'); }
        else {
          _busy(6, '6. Adım — Konuşmacı tespiti (pyannote)...');
          const dr = await _pipeRunDiarize(hfTok, nspk);
          _pendingInterventions = [`${dr.speaker_count} farklı konuşmacı tespit edildi`];
          if (ngDiarizeSegs.length) {
            const spkMap = {};
            ngDiarizeSegs.forEach(s => { spkMap[s.speaker] = (spkMap[s.speaker]||0) + (s.end-s.start); });
            Object.entries(spkMap).forEach(([spk, dur]) => {
              _pendingInterventions.push(`${spk}: toplam ${Math.floor(dur/60)}dk ${Math.floor(dur%60)}sn konuşma`);
            });
          }
          _ok(6, `6. Adım — ${dr.speaker_count} konuşmacı tespit edildi`);
        }
      } else { _skip(6, '6. Adım — atlandı'); }

      // ── 6+ Konuşmacı İsimlendirme (diarize yapıldıysa) ────────────────────
      if (ngDiarizeSegs.length && _pipelineRunning) {
        // Mevcut konuşmacıları ve sürelerini hesapla
        const _spkDurs = {};
        ngDiarizeSegs.forEach(s => { _spkDurs[s.speaker] = (_spkDurs[s.speaker]||0) + (s.end - s.start); });
        const _spkList = Object.entries(_spkDurs).sort((a,b) => b[1] - a[1]);
        // DB'den veya pipeline state'den kayıtlı isimleri yükle
        let _savedNames = {};
        try {
          const _pn6 = _currentProjectName || localStorage.getItem('current_project_name') || '';
          const _ps6 = await loadPipelineStateFromDB(_pn6) || await loadPipelineStateFromDB() || {};
          if (_ps6.speakerNames) _savedNames = _ps6.speakerNames;
        } catch(_) {}
        // Diarize DB'den de dene
        if (!Object.keys(_savedNames).length) {
          try {
            const _tryN = [_rawFileBlob?.name, _pipeOrigFileName, _persistOrigName].filter(Boolean);
            for (const nm of _tryN) {
              const c = await loadDiarizeFromDB(nm, _rawFileBlob?.size);
              if (c?.speakerNames && Object.keys(c.speakerNames).length) { _savedNames = c.speakerNames; break; }
            }
          } catch(_) {}
        }

        const _spColors = ['#3b82f6','#f97316','#a855f7','#ec4899','#14b8a6','#eab308','#ef4444','#22d3ee'];
        const _spNamingId = 'pipe-step-6-naming';
        let _namingEl = _pipeProg.querySelector(`#${_spNamingId}`);
        if (!_namingEl) { _namingEl = document.createElement('div'); _namingEl.id = _spNamingId; _pipeProg.appendChild(_namingEl); }
        _namingEl.style.cssText = 'border-radius:7px;background:rgba(99,102,241,0.08);border:1px solid #4338ca;overflow:hidden;padding:10px 12px';
        _namingEl.innerHTML = `
          <div style="font-size:12px;color:#a5b4fc;font-weight:700;margin-bottom:8px">👥 Konuşmacı İsimlendirme</div>
          <div style="font-size:10px;color:#64748b;margin-bottom:8px">Her konuşmacıyı dinleyip ismini yazın. Transkriptte ve PDF'te bu isimler kullanılır.</div>
          ${_spkList.map(([sp, dur], i) => {
            const savedName = _savedNames[sp] || '';
            const m = Math.floor(dur/60), s = Math.floor(dur%60);
            return `<div style="display:flex;align-items:center;gap:6px;margin:4px 0">
              <span style="width:10px;height:10px;border-radius:50%;background:${_spColors[i%_spColors.length]};flex-shrink:0;display:inline-block"></span>
              <button data-pipe-sp-play="${sp}" style="background:#0f172a;border:1px solid #1e40af;color:#93c5fd;border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer" title="Dinle">▶</button>
              <span style="font-size:10px;color:#64748b;min-width:55px">${sp.replace('SPEAKER_','K')}</span>
              <span style="font-size:10px;color:#475569;min-width:45px">${m}dk ${s}sn</span>
              <input type="text" data-pipe-sp-name="${sp}" value="${savedName}" placeholder="İsim girin..."
                style="background:#1e293b;border:1px solid #334155;color:#e2e8f0;border-radius:4px;padding:3px 8px;font-size:12px;flex:1;min-width:80px">
            </div>`;
          }).join('')}
          <div style="margin-top:10px;display:flex;gap:8px;align-items:center">
            <button id="pipe-sp-save-continue" style="background:linear-gradient(135deg,#312e81,#1e3a5f);border:1px solid #6366f1;color:#e0e7ff;border-radius:6px;padding:6px 16px;font-size:12px;font-weight:600;cursor:pointer">💾 Kaydet & Devam</button>
            <button id="pipe-sp-skip" style="background:none;border:1px solid #334155;color:#64748b;border-radius:6px;padding:6px 12px;font-size:11px;cursor:pointer">Atla →</button>
          </div>`;

        // Dinle butonları
        _namingEl.querySelectorAll('button[data-pipe-sp-play]').forEach(btn => {
          btn.addEventListener('click', () => playSpeaker(btn.dataset.pipeSpPlay, btn));
        });

        // Pipeline DURMADAN devam et — isimlendirme arka planda yapılır
        // Kaydet butonu tıklanınca isimleri uygula
        const _saveSpNames = async () => {
          const map = {};
          _namingEl.querySelectorAll('input[data-pipe-sp-name]').forEach(inp => {
            const name = inp.value.trim();
            if (name) map[inp.dataset.pipeSpName] = name;
          });
          if (!Object.keys(map).length) return;
          ngDiarizeSegs.forEach(s => { if (map[s.speaker]) s.speaker = map[s.speaker]; });
          try {
            const _tryN2 = [_rawFileBlob?.name, _pipeOrigFileName, _persistOrigName].filter(Boolean);
            for (const nm of _tryN2) {
              const existing = await loadDiarizeFromDB(nm, _rawFileBlob?.size);
              if (existing) {
                existing.segments = ngDiarizeSegs;
                existing.speakers = [...new Set(ngDiarizeSegs.map(s => s.speaker))];
                existing.speakerNames = map;
                await saveDiarizeToDB(nm, _rawFileBlob?.size, existing);
                break;
              }
            }
          } catch(_) {}
          try {
            const _pn7 = _currentProjectName || localStorage.getItem('current_project_name') || '';
            const _ps7 = await loadPipelineStateFromDB(_pn7) || await loadPipelineStateFromDB() || {};
            _ps7.speakerNames = map;
            await savePipelineStateToDB(_ps7);
          } catch(_) {}
          try { CanvasOverlay.setSpeakers(ngDiarizeSegs); } catch(_) {}
          const _metaSp2 = modal.querySelector('#ng-meta-speakers');
          if (_metaSp2) _metaSp2.value = Object.values(map).join(', ');
          _namingEl.innerHTML = `<div style="padding:6px 12px;font-size:11px;color:#4ade80;font-weight:600">✓ ${Object.keys(map).length} konuşmacı isimlendirildi</div>`;
          addLog('ok', `👥 Konuşmacı isimleri kaydedildi: ${Object.entries(map).map(([k,v])=>k.replace('SPEAKER_','K')+'→'+v).join(', ')}`);
          window._pipelineSpeakerNames = map;
        };
        _namingEl.querySelector('#pipe-sp-save-continue').addEventListener('click', _saveSpNames);
        _namingEl.querySelector('#pipe-sp-skip').addEventListener('click', () => {
          _namingEl.innerHTML = `<div style="padding:6px 12px;font-size:11px;color:#64748b">○ Konuşmacı isimlendirme atlandı</div>`;
        });
        window._pipelineSpeakerNames = _savedNames;
        // Transkript segmentlerine konuşmacı isimlerini ata
        _assignSpeakersToTranscript();
        // Transkripti DB'ye güncellenmiş halleriyle kaydet
        if (_ngTranscript?.segments?.length) {
          try { await saveTranscriptToDB(_ngTranscript); } catch(_) {}
        }
      }

      // 7. Adım — Silero VAD
      if (!_pipelineRunning) return;
      if (_doneSteps.has('7')) {
        // VAD sonuçlarını DB'den yükle — farklı dosya adlarıyla dene
        if (!ngVadSegs.length) {
          const _tryNames = [_rawFileBlob?.name, _pipeOrigFileName, _persistOrigName].filter(Boolean);
          const _trySizes = [_rawFileBlob?.size].filter(Boolean);
          for (const nm of _tryNames) {
            for (const sz of _trySizes) {
              try {
                const c = await loadVadFromDB(nm, sz);
                if (c?.segments?.length) { ngVadSegs = c.segments; break; }
              } catch(_) {}
            }
            if (ngVadSegs.length) break;
          }
          // Hâlâ boşsa tüm vad store'u tara
          if (!ngVadSegs.length) {
            try {
              const db = await openDB();
              const tx = db.transaction('vad','readonly');
              const all = await new Promise(r=>{const req=tx.objectStore('vad').getAll();req.onsuccess=()=>r(req.result||[])});
              const found = all.find(v=>v?.segments?.length);
              if (found) ngVadSegs = found.segments;
            } catch(_) {}
          }
          if (ngVadSegs.length) console.log('[resume-7] VAD yüklendi:', ngVadSegs.length);
        }
        await _resume(7, `7. Adım — Sessizlik haritası oluşturuldu ✓`);
      } else if (chkVad) {
        _busy(7, '7. Adım — Silero VAD...');
        const vd = await _pipeRunVad();
        _showVadResult(vd.count, vd.total_speech_sec);
        if (_rStep) _rStep.details = { speechSegments: vd.count, totalSpeechSec: vd.total_speech_sec };
        if (_pipeReport) _pipeReport.speechSegments = ngVadSegs.map(s=>({...s}));
        const totalSpeech = ngVadSegs.reduce((a,s)=>a+(s.end-s.start),0);
        const totalSilence = (state.audioBuffer?.duration||0) - totalSpeech;
        _pendingInterventions = [
          `${vd.count} konuşma bölgesi tespit edildi`,
          `Toplam konuşma: ${Math.floor(totalSpeech/60)}dk ${Math.floor(totalSpeech%60)}sn`,
          `Toplam sessizlik: ${Math.floor(totalSilence/60)}dk ${Math.floor(totalSilence%60)}sn`,
          `Sessizlik oranı: %${((totalSilence/(state.audioBuffer?.duration||1))*100).toFixed(1)}`
        ];
        _ok(7, `7. Adım — Sessizlik haritası oluşturuldu: ${vd.count} konuşma bölgesi`);
      } else { _skip(7, '7. Adım — atlandı'); }

      // 7b (8b). Ses Seviyesi Dengeleme — kesimden ÖNCE yapılır
      const chkNormalize = modal.querySelector('#ng-chk-normalize')?.checked;
      console.log('[pipeline] 8b chkNormalize:', chkNormalize, 'doneSteps.has(8b):', _doneSteps.has('8b'));
      addLog('info', `[8b] checkbox=${chkNormalize}, done=${_doneSteps.has('8b')}`);
      if (!_pipelineRunning) return;
      if (_doneSteps.has('8b')) {
        await _resume('8b', '8. Adım — Ses seviyeleri dengelendi ✓');
      } else if (chkNormalize) {
        _busy('8b', '8. Adım — Konuşmacı bazlı ses dengeleme...');
        const ticker8b = _fakeTick('8b', '8. Adım — Ses seviyeleri dengeleniyor...', 60);
        try {
          // Diarize segmentlerini topla (6. adımdan)
          const fdNorm = new FormData();
          fdNorm.append('audio', _rawFileBlob, _rawFileBlob.name || 'audio.mp3');
          fdNorm.append('segments', JSON.stringify(ngDiarizeSegs || []));
          fdNorm.append('target_lufs', '-20');
          fdNorm.append('max_gain_db', '18');
          const rNorm = await pipeFetch('/api/normalize-speakers', { method: 'POST', body: fdNorm });
          ticker8b.stop();
          if (rNorm.ok) {
            const normBlob = await rNorm.blob();
            _rawFileBlob = new File([normBlob], _pipeOrigFileName || 'audio.mp3', { type: 'audio/mpeg' });
            try { state.audioBuffer = await new AudioContext().decodeAudioData(await normBlob.slice(0).arrayBuffer()); } catch(_){}
            // Konuşmacı istatistiklerini logla
            let spkStats = {};
            try { spkStats = JSON.parse(rNorm.headers.get('X-Speaker-Stats') || '{}'); } catch(_) {}
            const spkCount = Object.keys(spkStats).length;
            _pendingInterventions = [`${spkCount} konuşmacı bazlı ses dengeleme yapıldı (hedef: -20 LUFS)`];
            for (const [spk, lufs] of Object.entries(spkStats)) {
              const gain = (-20 - lufs).toFixed(1);
              _pendingInterventions.push(`${spk}: ${lufs.toFixed(1)} LUFS → ${gain > 0 ? '+' : ''}${gain} dB gain uygulandı`);
            }
            _ok('8b', `8. Adım — ${spkCount} konuşmacı ses seviyesi dengelendi`);
          } else {
            const errData = await rNorm.json().catch(() => ({}));
            _pipeLog('8b', '⚠', '8. Adım — Dengeleme hatası: ' + (errData.error || ''), '#f59e0b');
          }
        } catch(e) { ticker8b.stop(); _pipeLog('8b', '⚠', '8. Adım — Hata: ' + e.message, '#f59e0b'); }
      } else { _skip('8b', '8. Adım — Ses dengeleme atlandı'); }


      // 8. Adım — Sessiz yerleri kes (sonuç ekranı en son adımdan sonra gösterilir)
      if (!_pipelineRunning) return;
      if (_doneSteps.has('8')) {
        await _resume(8, '9. Adım — Sessiz bölgeler kesildi ✓');
        // cutSegments yoksa VAD/Diarize'dan yeniden hesapla ve kaydet
        if (!_pipe8Segs || !_pipe8Segs.length) {
          let _recalcSegs = [];
          if (ngVadSegs.length) _recalcSegs.push(...ngVadSegs.map(s => ({ start: s.start, end: s.end })));
          if (ngDiarizeSegs.length) _recalcSegs.push(...ngDiarizeSegs.map(s => ({ start: s.start, end: s.end })));
          if (_recalcSegs.length) {
            _pipe8Segs = _vadSilenceSegs(_recalcSegs);
            // DB'ye kaydet
            try {
              const _pn3 = _currentProjectName || localStorage.getItem('current_project_name') || '';
              const _es3 = await loadPipelineStateFromDB(_pn3) || await loadPipelineStateFromDB() || {};
              _es3.cutSegments = _pipe8Segs;
              await savePipelineStateToDB(_es3);
              console.log('[resume-8] cutSegments yeniden hesaplandı:', _pipe8Segs.length);
            } catch(_) {}
          }
        }
      } else if (!chkCut) { _skip(8, '9. Adım — atlandı'); } else {
        _busy(8, '✂️ 9. Adım — Sessiz yerler kesiliyor...');
        // VAD + Diarize birleştirme: her iki kaynaktaki konuşma bölgeleri korunur
        let _allSpeechSegs = [];
        if (ngVadSegs.length) _allSpeechSegs.push(...ngVadSegs.map(s => ({ start: s.start, end: s.end })));
        if (ngDiarizeSegs.length) _allSpeechSegs.push(...ngDiarizeSegs.map(s => ({ start: s.start, end: s.end })));
        // Eğer ikisi de varsa birleştir, yoksa hangisi varsa onu kullan
        const finalSegs = _allSpeechSegs.length ? _vadSilenceSegs(_allSpeechSegs) : null;
        if (finalSegs && finalSegs.length) {
          _reportCuts(finalSegs, 'VAD/Diarize sessizlik');
          if (_rStep) _rStep.details = { cutsCount: finalSegs.filter(s=>s.action==='delete').length, totalRemovedSec: +finalSegs.filter(s=>s.action==='delete').reduce((a,s)=>a+(s.end-s.start),0).toFixed(1) };
          // Sessizce işle — sonuç ekranını gösterme, _rawFileBlob'u güncelle
          const processedBlob = await uploadAndProcess(finalSegs);
          const cd = processedBlob._cd || '';
          const nm = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i);
          const _baseName = nm ? decodeURIComponent(nm[1]) : 'temizlendi.mp3';
          const cutName = _pipeOrigFileName || _rawFileBlob?.name || _baseName;
          _rawFileBlob = new File([processedBlob], cutName, { type: 'audio/mpeg' });
          try { state.audioBuffer = await new AudioContext().decodeAudioData(await processedBlob.slice(0).arrayBuffer()); } catch(_){}
          _pipe8Segs = finalSegs;
          // Video modülüne kesim haritasını bildir
          if (typeof window._onPipelineCutsReady === 'function') window._onPipelineCutsReady(finalSegs);
          // Kesim segmentlerini hemen DB'ye kaydet
          try {
            const _pn = _currentProjectName || localStorage.getItem('current_project_name') || '';
            const _existing = await loadPipelineStateFromDB(_pn) || await loadPipelineStateFromDB() || {};
            _existing.cutSegments = finalSegs;
            _existing.doneSteps = [..._doneSteps];
            _existing.projectName = _pn;
            await savePipelineStateToDB(_existing);
          } catch(_) {}
          const delCount = finalSegs.filter(s=>s.action==='delete').length;
          const delTotal = finalSegs.filter(s=>s.action==='delete').reduce((a,s)=>a+(s.end-s.start),0);
          _pendingInterventions = [
            `${delCount} sessiz bölge kesildi · toplam ${Math.floor(delTotal/60)}dk ${Math.floor(delTotal%60)}sn`,
            `Kesim kaynağı: VAD + Konuşmacı tespiti birleşik harita`
          ];
          // İlk 5 kesimi göster
          finalSegs.filter(s=>s.action==='delete').slice(0,5).forEach((s,i) => {
            _pendingInterventions.push(`Kesim ${i+1}: ${Math.floor(s.start/60)}:${String(Math.floor(s.start%60)).padStart(2,'0')} → ${Math.floor(s.end/60)}:${String(Math.floor(s.end%60)).padStart(2,'0')} (${(s.end-s.start).toFixed(1)}sn)`);
          });
          if (delCount > 5) _pendingInterventions.push(`... ve ${delCount-5} kesim daha`);
          _ok(8, `9. Adım — Sessiz bölgeler kesildi: ${delCount} kesim, ${Math.floor(delTotal/60)}dk ${Math.floor(delTotal%60)}sn`);
        } else {
          _ok(8, '9. Adım — Kesilecek sessizlik bulunamadı, atlandı');
        }
      }

      // ── Ses Güzelleştirme Adımları (opsiyonel) ────────────────────────────────

      // 9a. Adım — VoiceFixer
      if (!_pipelineRunning) return;
      if (_doneSteps.has('9a')) {
        await _resume('9a', '10a. Adım — Ses restorasyonu yapıldı ✓');
      } else if (chkVoiceFixer) {
        _busy('9a', '10a. Adım — Ses restorasyonu...');
        _setStatusBar('⏳ 10a. VoiceFixer CUDA ile çalışıyor...', '#fbbf24');
        const ticker9a = _fakeTick('9a', '10a. Adım — Ses restorasyonu...', 120);
        const fdVF = new FormData();
        fdVF.append('file', _rawFileBlob, _rawFileBlob.name || 'audio.mp3');
        const rvf = await pipeFetch('/api/voicefixer', { method: 'POST', body: fdVF });
        ticker9a.stop();
        if (!rvf.ok) { const e = await rvf.json().catch(()=>({error:rvf.statusText})); throw new Error('VoiceFixer: ' + (e.error||rvf.statusText)); }
        const vfBlob = await rvf.blob();
        _rawFileBlob = new File([vfBlob], _pipeOrigFileName || 'audio.mp3', { type: 'audio/mpeg' });
        if (state.audioBuffer) { const ab = await new AudioContext().decodeAudioData(await vfBlob.arrayBuffer()); state.audioBuffer = ab; }
        _ok('9a', `10a. Adım — Ses restorasyonu yapıldı`);
      } else { _skip('9a', '10a. Adım — Ses restorasyonu atlandı'); }

      // 9b. Adım — Resemble Enhance
      if (!_pipelineRunning) return;
      if (_doneSteps.has('9b')) {
        await _resume('9b', '10b. Adım — Gürültü temizleme uygulandı ✓');
      } else if (chkResemble) {
        _busy('9b', '10b. Adım — Gürültü temizleme...');
        _setStatusBar('⏳ 10b. Resemble Enhance CUDA ile çalışıyor...', '#34d399');
        const ticker9b = _fakeTick('9b', '10b. Adım — Gürültü temizleme...', 180);
        const fdRE = new FormData();
        fdRE.append('file', _rawFileBlob, _rawFileBlob.name || 'audio.mp3');
        fdRE.append('mode', 'enhance');
        const rre = await pipeFetch('/api/resemble-enhance', { method: 'POST', body: fdRE });
        ticker9b.stop();
        if (!rre.ok) { const e = await rre.json().catch(()=>({error:rre.statusText})); throw new Error('Resemble: ' + (e.error||rre.statusText)); }
        const reBlob = await rre.blob();
        _rawFileBlob = new File([reBlob], _pipeOrigFileName || 'audio.mp3', { type: 'audio/mpeg' });
        if (state.audioBuffer) { const ab = await new AudioContext().decodeAudioData(await reBlob.arrayBuffer()); state.audioBuffer = ab; }
        _ok('9b', `10b. Adım — Gürültü temizleme uygulandı`);
      } else { _skip('9b', '10b. Adım — Gürültü temizleme atlandı'); }

      // 9c. Adım — DeepFilterNet
      if (!_pipelineRunning) return;
      if (_doneSteps.has('9c')) {
        await _resume('9c', '10c. Adım — Derin filtreleme yapıldı ✓');
      } else if (chkDeepFilter) {
        _busy('9c', '10c. Adım — Derin filtreleme...');
        _setStatusBar('⏳ 10c. DeepFilterNet çalışıyor...', '#7dd3fc');
        const ticker9c = _fakeTick('9c', '10c. Adım — Derin filtreleme...', 60);
        const fdDF = new FormData();
        fdDF.append('file', _rawFileBlob, _rawFileBlob.name || 'audio.mp3');
        if (chkAutoBoost) fdDF.append('auto_boost', 'true');
        const rdf = await pipeFetch('/api/deepfilter', { method: 'POST', body: fdDF });
        ticker9c.stop();
        if (!rdf.ok) { const e = await rdf.json().catch(()=>({error:rdf.statusText})); throw new Error('DeepFilterNet: ' + (e.error||rdf.statusText)); }
        const dfBlob = await rdf.blob();
        _rawFileBlob = new File([dfBlob], _pipeOrigFileName || 'audio.mp3', { type: 'audio/mpeg' });
        if (state.audioBuffer) { const ab = await new AudioContext().decodeAudioData(await dfBlob.arrayBuffer()); state.audioBuffer = ab; }
        _ok('9c', `10c. Adım — Derin filtreleme yapıldı`);
      } else { _skip('9c', '10c. Adım — Derin filtreleme atlandı'); }

      // ── Son kalite kontrol ─────────────────────────────────────────────
      try {
        _pipeLog('qc', '⏳', 'Kalite kontrol yapılıyor...', '#c084fc');
        const _qcFd = new FormData();
        _qcFd.append('file', _rawFileBlob, _rawFileBlob.name || 'audio.mp3');
        if (_ngTranscript) _qcFd.append('transcript', JSON.stringify(_ngTranscript));
        const _qcResp = await pipeFetch('/api/quality-check', { method: 'POST', body: _qcFd });
        if (_qcResp.ok) {
          const _qcData = await _qcResp.json();
          if (_qcData.success) {
            window._lastQualityCheck = _qcData.result;
            const sc = _qcData.result.quality_score;
            const clr = sc >= 80 ? '#4ade80' : sc >= 60 ? '#eab308' : '#ef4444';
            _pipeLog('qc', '✓', `Kalite Skoru: %${sc}`, clr);
            _showQualityCard(_qcData.result);
          }
        }
      } catch(_qcE) { console.warn('[qc] Kalite kontrol atlandı:', _qcE); }

      // Pipeline tamamen bitti — state korunur (proje yüklendiğinde adımlar görünsün)
      await _savePipeState();
      if (_pipeReport) {
        _pipeReport.endTime = new Date();
        _pipeReport.finalFile = { name: _rawFileBlob?.name||'', sizeMB: +((_rawFileBlob?.size||0)/1024/1024).toFixed(2), duration: +(state.audioBuffer?.duration||0).toFixed(1) };
      }
      aiSetStatus('✅ Pipeline tamamlandı', '#4ade80');
      _setStatusBar('✅ Pipeline tamamlandı!', '#4ade80');
      _pipeBtn.textContent = '✅ Tamamlandı';
      _pipeBtn.style.background = 'linear-gradient(135deg,#14532d,#1e3a5f)';
      // Tüm adımların loglarını butonlarla yeniden render et (Devam butonu dahil)
      const _stepLabelsRefresh = {
        '1':'1. Adım','1b':'1b. Adım','2':'2. Adım','3':'3. Adım',
        '4':'4. Adım','5':'5. Adım','6':'6. Adım','7':'7. Adım',
        '8b':'8. Adım','8':'9. Adım','9a':'10a. Adım','9b':'10b. Adım','9c':'10c. Adım'
      };
      const _stepNamesRefresh = {
        '1':'Konuşma Yazıya Çevrildi','1b':'Metin Temizlendi','2':'Arka Plan Ayrıldı','3':'Frekans Gürültüsü Temizlendi',
        '4':'Anlık Gürültüler Silindi','5':'Konuşma Dışı Sesler Temizlendi','6':'Konuşmacılar Tespit Edildi','7':'Sessizlik Haritası Oluşturuldu',
        '8b':'Ses Seviyeleri Dengelendi','8':'Sessiz Bölgeler Kesildi','9a':'Ses Restorasyonu','9b':'Gürültü Temizleme','9c':'Derin Filtreleme'
      };
      for (const sid of [..._doneSteps]) {
        _pipeLog(sid, '✓', `${_stepLabelsRefresh[sid]||sid} — ${_stepNamesRefresh[sid]||sid} ✓`, '#4ade80');
      }
      const _postEl = modal.querySelector('#ng-post-pipeline');
      if (_postEl) _postEl.style.display = 'flex';
      const _prevAudio = modal.querySelector('#ng-preview-audio');
      if (_prevAudio && _rawFileBlob) _prevAudio.src = URL.createObjectURL(_rawFileBlob);
      // Kesim segmentlerini DB'den yükle (resume durumunda _pipe8Segs null olabilir)
      if (!_pipe8Segs || !_pipe8Segs.length) {
        const _projN2 = _currentProjectName || localStorage.getItem('current_project_name') || '';
        let _savedState2 = await loadPipelineStateFromDB(_projN2);
        if (!_savedState2?.cutSegments?.length) _savedState2 = await loadPipelineStateFromDB();
        if (_savedState2?.cutSegments?.length) _pipe8Segs = _savedState2.cutSegments;
      }
      // Tüm adımlar bittikten sonra karşılaştırma ekranını göster
      const _finalBlob = _rawFileBlob;
      const _finalSegs = _pipe8Segs || [];
      const _cleanFinal = (_pipeOrigFileName || _rawFileBlob?.name || 'son_hal').replace(/\.[^.]+$/, '').replace(/^temizlenmis\d*_?/, '').replace(/_(vocals|nr|enhanced|sadece_konusma|vf|re|df|cut|speech).*/i, '');
      const _finalDlName = 'temizlenmis_' + _cleanFinal + '.mp3';
      if (_finalBlob) {
        try { await showComparison(_finalBlob, _finalSegs, _finalDlName); } catch(_) {}
      }
      // Sonuç ekranı butonu — tekrar açılabilir
      const _cmpBtn = modal.querySelector('#ng-show-comparison-btn');
      if (_cmpBtn) _cmpBtn.onclick = () => {
        if (_finalBlob) showComparison(_finalBlob, _finalSegs, _finalDlName);
      };
      // Rapor butonu
      const _repBtn = modal.querySelector('#ng-report-btn');
      if (_repBtn) { _repBtn.style.display = 'inline-flex'; _repBtn.onclick = () => _openPipelineReport(); }
      // Excel alanı
      const _xlArea = modal.querySelector('#ng-excel-area');
      if (_xlArea) {
        _xlArea.style.display = 'flex';
        const _xlExp = modal.querySelector('#ng-excel-export-btn');
        if (_xlExp) _xlExp.onclick = () => _exportTranscriptExcel();
        const _xlImp = modal.querySelector('#ng-excel-import-input');
        if (_xlImp) _xlImp.onchange = e => { if (e.target.files[0]) _importTranscriptExcel(e.target.files[0]); };
      }

    } catch(e) {
      _err(_curStep || 1, '❌ Hata: ' + e.message);
      aiSetStatus('Pipeline hatası: ' + e.message, '#ef4444');
      addLog('error', 'Pipeline hatası: ' + e.message);
      _setStatusBar('❌ Hata oluştu — Başlat butonuna basınca kaldığı yerden devam eder', '#ef4444');
    } finally {
      _pipelineRunning = false;
      _stopHwDash();
      _pipeBtn.disabled = false;
      _pipeStop.style.display = 'none';
      if (!_pipeBtn.textContent.includes('Tamamlandı')) {
        _pipeBtn.textContent = '🚀 Başlat';
        _pipeBtn.style.background = 'linear-gradient(135deg,#1e3a5f,#14532d)';
      }
    }
  };

  _pipeStop.onclick = () => {
    _pipelineRunning = false;
    _stopHwDash();
    _pipeStop.style.display = 'none';
    _pipeBtn.disabled = false;
    _pipeBtn.textContent = '🚀 Başlat';
    _pipeBtn.style.background = 'linear-gradient(135deg,#1e3a5f,#14532d)';
    _pipeLog(99, '⏹', 'Kullanıcı tarafından durduruldu.', '#94a3b8');
  };

  // ── Meta Bilgileri Kaydet/Yükle ──
  const _metaSaveBtn = modal.querySelector('#ng-meta-save-btn');
  const _metaFields = ['ng-meta-title','ng-meta-location','ng-meta-date','ng-meta-speakers','ng-meta-topics','ng-meta-notes'];
  function _saveMetaToStorage() {
    const projName = _currentProjectName || localStorage.getItem('current_project_name') || '';
    if (!projName) return;
    const data = {};
    _metaFields.forEach(id => { const el = modal.querySelector('#'+id); if (el) data[id] = el.value || ''; });
    localStorage.setItem('meta__' + projName, JSON.stringify(data));
  }
  function _loadMetaFromStorage() {
    const projName = _currentProjectName || localStorage.getItem('current_project_name') || '';
    if (!projName) return;
    try {
      const data = JSON.parse(localStorage.getItem('meta__' + projName) || '{}');
      _metaFields.forEach(id => { const el = modal.querySelector('#'+id); if (el && data[id]) el.value = data[id]; });
    } catch(_) {}
  }
  if (_metaSaveBtn) _metaSaveBtn.onclick = () => {
    _saveMetaToStorage();
    _metaSaveBtn.textContent = '✔ Kaydedildi';
    _metaSaveBtn.style.color = '#4ade80';
    setTimeout(() => { _metaSaveBtn.textContent = '💾 Bilgileri Kaydet'; _metaSaveBtn.style.color = '#4ade80'; }, 2000);
  };
  // Sayfa açıldığında meta bilgileri yükle
  _loadMetaFromStorage();

  // ── Konuşmacı Tespiti (pyannote) ──
  // localStorage'dan kayıtlı token'ı yükle
  const _savedHfToken = localStorage.getItem('hf_token') || '';
  if (_savedHfToken) modal.querySelector('#ng-hf-token').value = _savedHfToken;

  // ── Whisper (3. Adım) ──
  const _whisperChk    = modal.querySelector('#ng-chk-whisper');
  const _whisperBtn    = modal.querySelector('#ng-whisper-btn');
  const _whisperModel  = modal.querySelector('#ng-whisper-model');
  const _whisperResult = modal.querySelector('#ng-whisper-result');
  let   _ngTranscript  = null;   // {segments:[{text,start,end,words:[],speaker?}]}
  const _ollamaResult  = modal.querySelector('#ng-ollama-result');

  /**
   * Whisper transkript segmentlerine diarize konuşmacı isimlerini ata.
   * Her transkript segmentinin zaman aralığı ile en çok örtüşen konuşmacıyı bulur.
   */
  function _assignSpeakersToTranscript() {
    if (!_ngTranscript?.segments?.length || !ngDiarizeSegs.length) return;
    _ngTranscript.segments.forEach(tSeg => {
      // Bu transkript segmentiyle örtüşen diarize segmentlerini bul
      let bestSpeaker = '', bestOverlap = 0;
      ngDiarizeSegs.forEach(dSeg => {
        const oStart = Math.max(tSeg.start, dSeg.start);
        const oEnd   = Math.min(tSeg.end, dSeg.end);
        const overlap = oEnd - oStart;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestSpeaker = dSeg.speaker;
        }
      });
      if (bestSpeaker) tSeg.speaker = bestSpeaker;
    });
  }

  function _renderOllamaTranscript(cleaned) {
    if (!_ollamaResult) return;
    _ollamaResult.style.display = 'block';
    _ollamaResult.innerHTML = `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;padding-bottom:5px;border-bottom:1px solid #92400e">
      <span style="font-size:10px;color:#f59e0b;font-weight:700">🤖 Ollama Temizlenmiş Transkript</span>
      <button onclick="navigator.clipboard.writeText(this.closest('[id]').querySelector('pre')?.textContent||'').then(()=>{this.textContent='✔';setTimeout(()=>this.textContent='⎘ Kopyala',1500)})" style="margin-left:auto;font-size:9px;padding:1px 6px;background:#1e293b;border:1px solid #334155;border-radius:3px;color:#94a3b8;cursor:pointer">⎘ Kopyala</button>
    </div><pre style="margin:0;font-size:10px;white-space:pre-wrap;color:#fde68a;font-family:inherit">${cleaned.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`;
  }

  async function _openPipelineReport() {
    let r = _pipeReport;
    // _pipeReport null ise — resume/devam durumunda — DB'den ve bellekten topla
    if (!r || !r.steps?.length) {
      const projName = _currentProjectName || localStorage.getItem('current_project_name') || 'Proje';
      const snaps = window._stepAudioSnapshots || {};
      const actx = new AudioContext();

      // Orijinal ses: step 1 snapshot
      const origBlob = snaps['1'];
      let origDur = 0, origSizeMB = 0;
      if (origBlob) {
        origSizeMB = +(origBlob.size/1024/1024).toFixed(2);
        try { const ab = await actx.decodeAudioData(await origBlob.slice(0).arrayBuffer()); origDur = +ab.duration.toFixed(1); } catch(_){}
      }

      // Son ses: en son tamamlanmış step snapshot
      const lastOrder = ['9c','9b','9a','8','7','6','5','4','3','2','1b','1'];
      let lastBlob = null, lastStepId = '';
      for (const sid of lastOrder) { if (snaps[sid]) { lastBlob = snaps[sid]; lastStepId = sid; break; } }
      let finalDur = 0, finalSizeMB = 0;
      if (lastBlob) {
        finalSizeMB = +(lastBlob.size/1024/1024).toFixed(2);
        try { const ab = await actx.decodeAudioData(await lastBlob.slice(0).arrayBuffer()); finalDur = +ab.duration.toFixed(1); } catch(_){}
      }
      actx.close();

      // Kesim segmentleri — DB'den veya VAD/Diarize'dan hesapla
      let cuts = [];
      try {
        let pState = await loadPipelineStateFromDB(projName);
        if (!pState?.cutSegments?.length) pState = await loadPipelineStateFromDB();
        if (pState?.cutSegments?.length) cuts = pState.cutSegments;
      } catch(_) {}
      // cutSegments boşsa, VAD ve Diarize verilerinden yeniden hesapla
      if (!cuts.length && origDur > 0) {
        let _allSegs = [];
        // VAD store'dan
        try {
          const db = await openDB();
          const tx = db.transaction('vad','readonly');
          const allVad = await new Promise(r=>{const req=tx.objectStore('vad').getAll();req.onsuccess=()=>r(req.result||[])});
          const v = allVad.find(x=>x?.segments?.length);
          if (v?.segments) _allSegs.push(...v.segments.map(s=>({start:s.start,end:s.end})));
        } catch(_){}
        // Diarize store'dan
        try {
          const db = await openDB();
          const tx = db.transaction('diarize','readonly');
          const allDiar = await new Promise(r=>{const req=tx.objectStore('diarize').getAll();req.onsuccess=()=>r(req.result||[])});
          const d2 = allDiar.find(x=>x?.segments?.length);
          if (d2?.segments) _allSegs.push(...d2.segments.map(s=>({start:s.start,end:s.end})));
        } catch(_){}
        if (_allSegs.length) {
          cuts = _vadSilenceSegs(_allSegs);
          console.log('[pdf] cutSegments VAD/Diarize\'dan hesaplandı:', cuts.length);
        }
      }

      // Adım bilgileri — doneSteps + step audio boyutlarından oluştur
      const stepDescTR2 = {
        '1':'Ses kaydı yazıya çevrildi','1b':'Metin temizlendi ve düzeltildi','2':'Arka plan sesleri ayrıldı, sadece insan sesi korundu',
        '3':'Frekans bazlı gürültüler temizlendi (hışırtı, vızıltı)','4':'Anlık gürültüler silindi (öksürük, bardak, kapı)',
        '5':'Konuşma dışı sesler temizlendi (rüzgar, ortam sesi)','6':'Konuşmacılar tespit edildi',
        '7':'Sessizlik haritası oluşturuldu','8b':'Ses seviyeleri dengelendi','8':'Sessiz bölgeler kesildi, son dosya oluşturuldu',
        '9a':'Ses restorasyonu yapıldı, frekanslar düzeltildi','9b':'Yapay zeka gürültü temizleme uygulandı',
        '9c':'Derin filtreleme ile arka plan tamamen temizlendi'
      };
      const allOrder = ['1','1b','2','3','4','5','6','7','8b','8','9a','9b','9c'];
      let pState2 = null;
      try { pState2 = await loadPipelineStateFromDB(projName) || await loadPipelineStateFromDB(); } catch(_){}
      const doneSet = new Set((pState2?.doneSteps || []).map(String));
      const steps = [];
      let prevSize = origSizeMB;
      for (const sid of allOrder) {
        if (!doneSet.has(sid)) continue;
        const blob = snaps[sid];
        const sizeMB = blob ? +(blob.size/1024/1024).toFixed(2) : 0;
        steps.push({
          id: sid, name: stepDescTR2[sid] || sid, status: 'done',
          startTime: null, endTime: null,
          sizeBefore: prevSize, sizeAfter: sizeMB,
          details: {}
        });
        if (sizeMB > 0) prevSize = sizeMB;
      }

      // VAD konuşma bölgelerini topla
      let speechSegs = [];
      try {
        const db = await openDB();
        const tx = db.transaction('vad','readonly');
        const allVad = await new Promise(res=>{const req=tx.objectStore('vad').getAll();req.onsuccess=()=>res(req.result||[])});
        const v = allVad.find(x=>x?.segments?.length);
        if (v?.segments) speechSegs = v.segments.map(s=>({start:s.start,end:s.end}));
      } catch(_){}

      r = {
        projectName: projName,
        startTime: null, endTime: null,
        originalFile: { name: _rawFileBlob?.name || '', sizeMB: origSizeMB, duration: origDur },
        finalFile: { name: _rawFileBlob?.name || '', sizeMB: finalSizeMB, duration: finalDur },
        steps,
        cuts: cuts.map(c => ({ start: c.start, end: c.end, dur: +(c.end-c.start).toFixed(3), reason: c.reason || 'sessizlik' })),
        speechSegments: speechSegs,
        ollamaEvents: []
      };
    }

    // Meta bilgileri formdan oku
    const meta = {
      title:    modal.querySelector('#ng-meta-title')?.value?.trim()    || '',
      location: modal.querySelector('#ng-meta-location')?.value?.trim() || '',
      date:     modal.querySelector('#ng-meta-date')?.value?.trim()     || '',
      speakers: modal.querySelector('#ng-meta-speakers')?.value?.trim() || '',
      topics:   modal.querySelector('#ng-meta-topics')?.value?.trim()   || '',
      notes:    modal.querySelector('#ng-meta-notes')?.value?.trim()    || ''
    };

    const fmt = d => d ? new Date(d).toLocaleString('tr-TR') : '—';
    const fmtSec = s => { s = Math.abs(s); const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60); return h ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`; };
    const fmtMB = v => `${v} MB`;
    const totalDur = r.endTime && r.startTime ? ((new Date(r.endTime)-new Date(r.startTime))/1000/60).toFixed(1) : '—';
    const sizeSaved = r.originalFile.sizeMB > 0 && r.finalFile.sizeMB > 0 ? `−${(r.originalFile.sizeMB - r.finalFile.sizeMB).toFixed(2)} MB (${Math.round((1-r.finalFile.sizeMB/r.originalFile.sizeMB)*100)}% küçüldü)` : '—';
    const durSaved = r.originalFile.duration && r.finalFile.duration ? `−${fmtSec(r.originalFile.duration - r.finalFile.duration)} (${Math.round((1-r.finalFile.duration/r.originalFile.duration)*100)}% kısaldı)` : '—';
    const totalCutSec = r.cuts.reduce((a,c) => a+c.dur, 0);
    const stepColors = { done:'#16a34a', skipped:'#334155', error:'#dc2626', resumed:'#0891b2' };
    const stepIcons  = { done:'✓', skipped:'○', error:'✗', resumed:'♻' };

    // Dalga formu görüntüleri
    // Orijinal ve son ses dalga formları — step snapshot'lardan decode et
    let _origBuf = _originalAudioBuffer;
    let _finalBuf = state.audioBuffer;
    if (!_origBuf && window._stepAudioSnapshots?.['1']) {
      try { _origBuf = await new AudioContext().decodeAudioData(await window._stepAudioSnapshots['1'].slice(0).arrayBuffer()); } catch(_) {}
    }
    const lastOrder2 = ['9c','9b','9a','8','7','6','5','4','3','2','1b'];
    if (!_finalBuf || _finalBuf === _origBuf) {
      for (const sid of lastOrder2) {
        if (window._stepAudioSnapshots?.[sid]) {
          try { _finalBuf = await new AudioContext().decodeAudioData(await window._stepAudioSnapshots[sid].slice(0).arrayBuffer()); break; } catch(_) {}
        }
      }
    }
    const waveOrig  = _drawWaveformPng(_origBuf,  1200, 50, '#1e40af');
    const waveFinal = _drawWaveformPng(_finalBuf, 1200, 50, '#16a34a');

    // Adım açıklamaları — Türkçe, yapılan işlem detayı
    const stepDescTR = {
      '1': 'Ses kaydı yazıya çevrildi. Konuşmalar zaman damgalı olarak metin haline getirildi.',
      '1b': 'Yazıya çevrilen metindeki gereksiz kelimeler (eee, şey, yani) temizlendi, noktalama düzeltildi.',
      '2': 'Ses kaydından müzik, fan, klima gibi arka plan sesleri ayrıldı. Sadece insan sesi korundu.',
      '3': 'Kalan hışırtı, tıslama ve vızıltı gibi frekans bazlı gürültüler temizlendi.',
      '4': 'Anlık gürültüler (öksürük, bardak sesi, kapı kapanması) yapay zeka ile tespit edilip silindi.',
      '5': 'Konuşma olmayan bölgeler (rüzgar, ortam uğultusu) tespit edilip ses kaydından çıkarıldı.',
      '6': 'Kaç kişinin konuştuğu ve her konuşmacının hangi zaman aralığında konuştuğu tespit edildi.',
      '7': 'Ses kaydındaki sessiz bölgeler tespit edildi ve bir sessizlik haritası oluşturuldu.',
      '8': 'Konuşma olmayan sessiz bölgeler ses kaydından kesildi. Son temizlenmiş dosya oluşturuldu.',
      '9a': 'Düşük kaliteli ses restorasyonu yapıldı. Eksik frekanslar tamamlanarak ses netleştirildi.',
      '9b': 'Ses kaydına gürültü temizleme uygulandı. Arka plan sesleri filtrelenerek konuşma netleştirildi.',
      '9c': 'Derin filtreleme ile arka plan gürültüsü tamamen temizlendi. Konuşma kalitesi artırıldı.',
    };
    const stepStatusTR = { done:'Tamamlandı', skipped:'Atlandı', error:'Hata', resumed:'Arşivden yüklendi' };
    const stepsHtml = r.steps.map((s, idx) => {
      const dur = s.startTime && s.endTime ? ((new Date(s.endTime)-new Date(s.startTime))/1000).toFixed(1)+'s' : '—';
      const color = stepColors[s.status] || '#94a3b8';
      const icon  = stepIcons[s.status]  || '?';
      const desc = stepDescTR[String(s.id)] || s.name;
      return `<tr>
        <td style="color:${color};font-weight:700;white-space:nowrap">${icon} ${idx + 1}</td>
        <td>${desc}</td>
        <td style="color:${color}">${stepStatusTR[s.status] || s.status}</td>
        <td>${dur}</td>
        <td>${s.sizeBefore ? fmtMB(s.sizeBefore) : '—'}</td>
        <td>${s.sizeAfter  ? fmtMB(s.sizeAfter)  : '—'}</td>
      </tr>`;
    }).join('');

    // Kesimler — 3 sütunlu kompakt tablo
    const _cutsPerCol = Math.ceil(r.cuts.length / 3) || 1;
    const _cutCols = [r.cuts.slice(0, _cutsPerCol), r.cuts.slice(_cutsPerCol, _cutsPerCol*2), r.cuts.slice(_cutsPerCol*2)];
    const _makeCutCol = (cuts, offset) => cuts.map((c,i) => `<tr><td>${offset+i+1}</td><td>${fmtSec(c.start)}</td><td>${fmtSec(c.end)}</td><td><b>${fmtSec(c.dur)}</b></td></tr>`).join('');
    const cutsHtml = r.cuts.length
      ? `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px">` +
        _cutCols.map((col, ci) => `<table><thead><tr><th>#</th><th>Başlangıç</th><th>Bitiş</th><th>Süre</th></tr></thead><tbody>${_makeCutCol(col, ci * _cutsPerCol)}</tbody></table>`).join('') +
        `</div>`
      : '<div style="color:#64748b;text-align:center;font-size:7px;padding:4px">Kesim yapılmadı</div>';

    const speechHtml = r.speechSegments?.length ? r.speechSegments.map((s,i) => `<tr>
      <td>${i+1}</td>
      <td>${fmtSec(s.start)}</td>
      <td>${fmtSec(s.end)}</td>
      <td>${fmtSec(s.end-s.start)}</td>
    </tr>`).join('') : '<tr><td colspan="4" style="color:#64748b;text-align:center">VAD çalışmadı</td></tr>';

    // Transkript bellekte yoksa DB'den yükle — birden fazla key dene
    if (!_ngTranscript?.segments?.length) {
      // 1) Mevcut _fileKey ile dene
      try { const _trDB = await loadTranscriptFromDB(); if (_trDB?.segments?.length) _ngTranscript = _trDB; } catch(_) {}
      // 2) Hâlâ yoksa tüm transcripts kayıtlarını tara
      if (!_ngTranscript?.segments?.length) {
        try {
          const db = await openDB();
          const tx = db.transaction('transcripts', 'readonly');
          const all = await new Promise(r => { const req = tx.objectStore('transcripts').getAll(); req.onsuccess = () => r(req.result || []); });
          const found = all.find(v => v?.segments?.length);
          if (found) { _ngTranscript = found; console.log('[pdf] Transkript DB taramasıyla bulundu'); }
        } catch(_) {}
      }
      // 3) _currentTranscriptResult'tan dene
      if (!_ngTranscript?.segments?.length && _currentTranscriptResult?.segments?.length) {
        _ngTranscript = _currentTranscriptResult;
      }
    }
    // Transkript segmentlerine konuşmacı isimlerini ata (henüz atanmamışsa)
    if (_ngTranscript?.segments?.length && ngDiarizeSegs.length) {
      const _hasNames = _ngTranscript.segments.some(s => s.speaker && !s.speaker.startsWith('SPEAKER_'));
      if (!_hasNames) _assignSpeakersToTranscript();
    }
    const whisperHtml = _ngTranscript?.segments?.length ? _ngTranscript.segments.map(s => {
      const spName = (s.speaker || '').replace(/^SPEAKER_(\d+)$/, 'Konuşmacı $1');
      return `<tr>
      <td style="white-space:nowrap;color:#64748b">${fmtSec(s.start)} – ${fmtSec(s.end)}</td>
      <td style="font-weight:600;color:#4338ca">${spName}</td>
      <td>${(s.text||'').trim()}</td>
    </tr>`;
    }).join('') : '<tr><td colspan="3" style="color:#64748b;text-align:center">Transkript yok</td></tr>';

    const ollamaHtml = r.ollamaEvents?.length ? r.ollamaEvents.map((e,i) => `
      <div style="margin-bottom:12px;padding:10px;background:#fefce8;border-radius:6px;border:1px solid #fde68a">
        <div style="font-size:11px;color:#78350f;margin-bottom:6px">🤖 Ollama Müdahalesi #${i+1}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div><div style="font-size:10px;color:#92400e;margin-bottom:3px">Orijinal (Whisper)</div><pre style="font-size:10px;white-space:pre-wrap;margin:0;background:#fff7ed;padding:6px;border-radius:4px">${(e.original||'').replace(/</g,'&lt;').slice(0,1000)}</pre></div>
          <div><div style="font-size:10px;color:#166534;margin-bottom:3px">Düzeltilmiş (Ollama)</div><pre style="font-size:10px;white-space:pre-wrap;margin:0;background:#f0fdf4;padding:6px;border-radius:4px">${(e.cleaned||'').replace(/</g,'&lt;').slice(0,1000)}</pre></div>
        </div>
      </div>`) .join('') : '<p style="color:#94a3b8">Ollama müdahalesi yapılmadı.</p>';

    const html = `<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8">
<title>Ses İşleme Raporu — ${r.projectName}</title>
<style>
  @page{size:A4;margin:6mm}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',Arial,sans-serif;font-size:8px;color:#1e293b;background:white;padding:4px;line-height:1.3}
  h1{font-size:13px;color:#1e40af}h2{font-size:9px;color:#1e3a8a;margin:6px 0 3px;padding-bottom:2px;border-bottom:1px solid #bfdbfe}
  h3{font-size:8px;color:#1e40af;margin:4px 0 2px}
  .header{background:linear-gradient(135deg,#1e3a8a,#0f766e);color:white;padding:8px 10px;border-radius:5px;margin-bottom:6px}
  .header h1{color:white;font-size:13px;margin-bottom:1px}.header .sub{font-size:7px;opacity:0.8;margin-top:2px}
  .summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(70px,1fr));gap:3px;margin-bottom:6px}
  .card{background:white;border:1px solid #e2e8f0;border-radius:4px;padding:4px;text-align:center}
  .card .val{font-size:10px;font-weight:700;color:#1e40af}.card .lbl{font-size:6px;color:#64748b;margin-top:1px}
  table{width:100%;border-collapse:collapse;background:white;border-radius:4px;overflow:hidden;margin-bottom:5px}
  th{background:#1e3a8a;color:white;padding:2px 4px;text-align:left;font-size:7px;font-weight:600}
  td{padding:2px 4px;border-bottom:1px solid #f1f5f9;font-size:7px;vertical-align:top}
  tr:last-child td{border-bottom:none}tr:nth-child(even){background:#f8fafc}
  .section{background:white;border:1px solid #e2e8f0;border-radius:4px;padding:5px;margin-bottom:5px}
  img{max-width:100%;height:auto;max-height:50px}
  @media print{body{padding:0}button{display:none!important}.no-print{display:none!important}}
  .print-btn{position:fixed;top:6px;right:6px;background:#1e40af;color:white;border:none;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:8px;font-weight:600;box-shadow:0 2px 6px rgba(0,0,0,0.2)}
  .tag{display:inline-block;padding:1px 4px;border-radius:8px;font-size:6px;font-weight:600}
  .tag-done{background:#dcfce7;color:#16a34a}.tag-skip{background:#f1f5f9;color:#64748b}.tag-err{background:#fef2f2;color:#dc2626}.tag-res{background:#e0f2fe;color:#0891b2}
</style></head><body>
<button class="print-btn no-print" onclick="window.print()">🖨 PDF Olarak Kaydet</button>

<div class="header">
  <h1>🎙 Ses İşleme Raporu</h1>
  <div style="font-size:16px;margin-top:4px;font-weight:600">${r.projectName}</div>
  <div class="sub">Başlangıç: ${fmt(r.startTime)} &nbsp;|&nbsp; Bitiş: ${fmt(r.endTime)} &nbsp;|&nbsp; Toplam Süre: ${totalDur} dakika</div>
</div>

${(meta.title || meta.location || meta.date || meta.speakers || meta.topics || meta.notes) ? `
<h2>📋 Kayıt Bilgileri</h2>
<div class="section">
  <table>
    <tbody>
      ${meta.title    ? `<tr><td style="font-weight:600;width:160px;color:#1e3a8a">Ses Kaydının Adı</td><td>${meta.title}</td></tr>` : ''}
      ${meta.location ? `<tr><td style="font-weight:600;width:160px;color:#1e3a8a">Kaydın Çekildiği Yer</td><td>${meta.location}</td></tr>` : ''}
      ${meta.date     ? `<tr><td style="font-weight:600;width:160px;color:#1e3a8a">Tarih</td><td>${meta.date}</td></tr>` : ''}
      ${meta.speakers ? `<tr><td style="font-weight:600;width:160px;color:#1e3a8a">Konuşmacılar</td><td>${meta.speakers}</td></tr>` : ''}
      ${meta.topics   ? `<tr><td style="font-weight:600;width:160px;color:#1e3a8a">Konu Başlıkları</td><td>${meta.topics}</td></tr>` : ''}
      ${meta.notes    ? `<tr><td style="font-weight:600;width:160px;color:#1e3a8a">Notlar</td><td style="white-space:pre-wrap">${meta.notes.replace(/</g,'&lt;')}</td></tr>` : ''}
    </tbody>
  </table>
</div>` : ''}

<h2>📊 Özet</h2>
<div class="summary-grid">
  <div class="card"><div class="val">${r.originalFile.duration ? fmtSec(r.originalFile.duration) : '—'}</div><div class="lbl">Orijinal Süre</div></div>
  <div class="card"><div class="val">${r.finalFile.duration ? fmtSec(r.finalFile.duration) : '—'}</div><div class="lbl">Son Süre</div></div>
  <div class="card"><div class="val" style="color:#16a34a">${durSaved}</div><div class="lbl">Kazanılan Süre</div></div>
  <div class="card"><div class="val">${fmtMB(r.originalFile.sizeMB)}</div><div class="lbl">Orijinal Boyut</div></div>
  <div class="card"><div class="val">${fmtMB(r.finalFile.sizeMB)}</div><div class="lbl">Son Boyut</div></div>
  <div class="card"><div class="val" style="color:#16a34a">${sizeSaved}</div><div class="lbl">Kazanılan Boyut</div></div>
  <div class="card"><div class="val">${r.cuts.length}</div><div class="lbl">Toplam Kesim</div></div>
  <div class="card"><div class="val">${totalCutSec > 0 ? fmtSec(totalCutSec) : '—'}</div><div class="lbl">Kesilen Toplam Süre</div></div>
  <div class="card"><div class="val">${r.speechSegments?.length||0}</div><div class="lbl">Konuşma Bölgesi (VAD)</div></div>
</div>

<h2>📈 Ses Dalga Formu Karşılaştırması</h2>
<div class="section" style="padding:4px">
  <div style="display:flex;align-items:center;gap:4px;margin-bottom:2px">
    <span style="font-size:7px;color:#1e40af;font-weight:700">🎵 Orijinal</span>
    <span style="font-size:6px;color:#64748b">${r.originalFile.name} · ${fmtMB(r.originalFile.sizeMB)} · ${r.originalFile.duration ? fmtSec(r.originalFile.duration) : '—'}</span>
  </div>
  ${waveOrig ? `<img src="${waveOrig}" style="width:100%;border:1px solid #e2e8f0;border-radius:2px;display:block">` : '<div style="color:#94a3b8;font-size:7px">veri yok</div>'}
  <div style="display:flex;align-items:center;gap:4px;margin:3px 0 2px">
    <span style="font-size:7px;color:#16a34a;font-weight:700">✅ İşlenmiş</span>
    <span style="font-size:6px;color:#64748b">${r.finalFile.name||'son hal'} · ${fmtMB(r.finalFile.sizeMB)} · ${r.finalFile.duration ? fmtSec(r.finalFile.duration) : '—'}</span>
  </div>
  ${waveFinal ? `<img src="${waveFinal}" style="width:100%;border:1px solid #e2e8f0;border-radius:2px;display:block">` : '<div style="color:#94a3b8;font-size:7px">veri yok</div>'}
  <div style="margin-top:3px;padding:3px 4px;background:#f8fafc;border-radius:3px;font-size:6px;color:#64748b;display:flex;gap:10px">
    <span>Süre farkı: <b style="color:#16a34a">${r.originalFile.duration && r.finalFile.duration ? fmtSec(r.originalFile.duration - r.finalFile.duration) + ' kısaldı' : '—'}</b></span>
    <span>Boyut farkı: <b style="color:#16a34a">${r.originalFile.sizeMB && r.finalFile.sizeMB ? (r.originalFile.sizeMB - r.finalFile.sizeMB).toFixed(1) + ' MB küçüldü' : '—'}</b></span>
    <span>Oran: <b style="color:#16a34a">${r.originalFile.duration && r.finalFile.duration ? Math.round((1-r.finalFile.duration/r.originalFile.duration)*100) + '% temizlendi' : '—'}</b></span>
  </div>
</div>

<h2>📁 Dosya Bilgileri</h2>
<div class="section">
  <table><thead><tr><th>Durum</th><th>Dosya Adı</th><th>Boyut</th><th>Süre</th></tr></thead><tbody>
    <tr><td>🎵 Orijinal</td><td>${r.originalFile.name}</td><td>${fmtMB(r.originalFile.sizeMB)}</td><td>${fmtSec(r.originalFile.duration)}</td></tr>
    <tr><td>✅ İşlenmiş</td><td>${r.finalFile.name||'—'}</td><td>${fmtMB(r.finalFile.sizeMB)}</td><td>${r.finalFile.duration ? fmtSec(r.finalFile.duration) : '—'}</td></tr>
  </tbody></table>
</div>

<h2>🔄 Yapılan İşlemler</h2>
<table><thead><tr><th>#</th><th>Yapılan İşlem</th><th>Durum</th><th>Süre</th><th>Önce</th><th>Sonra</th></tr></thead><tbody>${stepsHtml}</tbody></table>

${(() => {
  const allStepIds = ['1','1b','2','3','4','5','6','7','8b','8','9a','9b','9c'];
  const descMap = {
    '1':'Konuşma yazıya çevrildi','1b':'Metin temizlendi','2':'Arka plan ayrıştırıldı',
    '3':'Frekans gürültüsü temizlendi','4':'Anlık gürültüler silindi','5':'Konuşma dışı sesler temizlendi',
    '6':'Konuşmacılar tespit edildi','7':'Sessizlik haritası oluşturuldu','8b':'Ses seviyeleri dengelendi','8':'Sessiz bölgeler kesildi',
    '9a':'Ses restorasyonu yapıldı','9b':'Gürültü temizleme uygulandı','9c':'Derin filtreleme yapıldı'
  };
  let html = '', stepNum = 0;
  for (const sid of allStepIds) {
    const det = window._stepDetails?.[sid];
    if (!det?.interventions?.length) continue;
    stepNum++;
    html += '<div style="margin-bottom:8px"><div style="font-weight:600;color:#1e3a8a;font-size:12px;margin-bottom:3px">' + stepNum + '. ' + (descMap[sid]||'') + '</div>';
    html += '<ul style="margin:0;padding-left:18px;font-size:11px;color:#334155">';
    det.interventions.forEach(iv => { html += '<li style="margin-bottom:1px">' + iv + '</li>'; });
    html += '</ul></div>';
  }
  return html ? '<h2>📝 Müdahale Detayları</h2><div class="section">' + html + '</div>' : '';
})()}

<h2>✂️ Kesimler (${r.cuts.length} adet — ${fmtSec(totalCutSec)} toplam)</h2>
${cutsHtml}

<h2>🗣 Konuşma Bölgeleri (${r.speechSegments?.length||0} bölge)</h2>
<table><thead><tr><th>#</th><th>Başlangıç</th><th>Bitiş</th><th>Süre</th></tr></thead><tbody>${speechHtml}</tbody></table>

<h2>📝 Konuşma Metni (${_ngTranscript?.segments?.length||0} bölüm)</h2>
<table><thead><tr><th>Zaman</th><th>Konuşmacı</th><th>Metin</th></tr></thead><tbody>${whisperHtml}</tbody></table>

<h2>🤖 Metin Düzeltme Müdahaleleri</h2>
<div class="section">${ollamaHtml}</div>

<div style="margin-top:24px;padding:12px;background:#f1f5f9;border-radius:8px;font-size:11px;color:#64748b;text-align:center">
  Rapor oluşturulma tarihi: ${fmt(new Date())} &mdash; ${r.projectName}
</div>
</body></html>`;

    const _pdfFileName = (r.projectName || _currentProjectName || 'rapor').replace(/\.[^.]+$/, '');
    try {
      const resp = await fetch('/api/html-to-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: html, filename: _pdfFileName })
      });
      if (!resp.ok) throw new Error('PDF hata');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = _pdfFileName + '.pdf'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch(e) {
      const win = window.open('', '_blank');
      if (win) { win.document.write(html); win.document.close(); }
    }
  }

  // checkbox: devre dışıysa butonu soluklaştır
  _whisperChk.addEventListener('change', () => {
    _whisperBtn.disabled = !_whisperChk.checked;
    _whisperBtn.style.opacity = _whisperChk.checked ? '1' : '0.35';
  });

  // Inline transkript render: segment satırları + seç/kes
  function _renderNgTranscript(data, fromCache) {
    _ngTranscript = data;
    // Ana Transkript sekmesini de doldur
    _currentTranscriptResult = data;
    _renderTrMainTab(data);
    const segs = data.segments || [];
    if (!segs.length) { _whisperResult.style.display = 'none'; return; }

    const tag = fromCache ? '<span style="font-size:9px;color:#475569;margin-right:6px">💾 arşiv</span>' : '';
    let html = `<div style="display:flex;align-items:center;gap:6px;padding-bottom:5px;border-bottom:1px solid #1e293b;flex-wrap:wrap">
      ${tag}<span style="font-size:10px;color:#60a5fa;font-weight:600">Transkript — ${segs.length} segment</span>
      <button id="ng-wh-selall" style="font-size:9px;padding:1px 6px;background:#1e293b;border:1px solid #334155;border-radius:3px;color:#94a3b8;cursor:pointer">Tümü</button>
      <button id="ng-wh-selnone" style="font-size:9px;padding:1px 6px;background:#1e293b;border:1px solid #334155;border-radius:3px;color:#94a3b8;cursor:pointer">Hiçbiri</button>
      <button id="ng-wh-cut" style="font-size:10px;padding:2px 8px;background:rgba(239,68,68,0.12);border:1px solid #ef4444;border-radius:4px;color:#ef4444;cursor:pointer;margin-left:auto" disabled>✂️ Seçilileri Kes</button>
    </div>`;
    html += '<div style="display:flex;flex-direction:column;gap:2px;padding-top:4px">';
    segs.forEach((s, i) => {
      const t = `${_fmtSec(s.start)}–${_fmtSec(s.end)}`;
      const txt = (s.text || '').trim();
      const spk = s.speaker ? `<span style="font-size:9px;color:#818cf8;font-weight:600;flex-shrink:0;min-width:50px">${s.speaker.replace('SPEAKER_','K')}</span>` : '';
      html += `<label style="display:flex;align-items:flex-start;gap:5px;cursor:pointer;padding:2px 0">
        <input type="checkbox" class="ng-wh-seg" data-i="${i}" data-start="${s.start}" data-end="${s.end}" style="margin-top:2px;accent-color:#ef4444;flex-shrink:0">
        <span style="font-size:10px;color:#64748b;flex-shrink:0;min-width:72px">${t}</span>
        ${spk}
        <span style="font-size:10px;color:#cbd5e1;flex:1">${txt}</span>
      </label>`;
    });
    html += '</div>';

    _whisperResult.innerHTML = html;
    _whisperResult.style.display = 'flex';
    _whisperResult.style.flexDirection = 'column';

    const cutBtn = _whisperResult.querySelector('#ng-wh-cut');
    const updateCut = () => {
      const n = _whisperResult.querySelectorAll('.ng-wh-seg:checked').length;
      cutBtn.disabled = !n;
      cutBtn.textContent = n ? `✂️ ${n} segmenti kes` : '✂️ Seçilileri Kes';
    };
    _whisperResult.querySelectorAll('.ng-wh-seg').forEach(cb => cb.addEventListener('change', updateCut));
    _whisperResult.querySelector('#ng-wh-selall').onclick  = () => { _whisperResult.querySelectorAll('.ng-wh-seg').forEach(c => c.checked = true);  updateCut(); };
    _whisperResult.querySelector('#ng-wh-selnone').onclick = () => { _whisperResult.querySelectorAll('.ng-wh-seg').forEach(c => c.checked = false); updateCut(); };
    cutBtn.onclick = () => {
      const toDelete = [..._whisperResult.querySelectorAll('.ng-wh-seg:checked')].map(c => ({
        action: 'delete', start: +c.dataset.start, end: +c.dataset.end
      }));
      if (!toDelete.length) return;
      applyAndDownload(toDelete, cutBtn);
    };
  }

  function _fmtSec(s) {
    s = Math.abs(s);
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
    return h ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  }

  _whisperBtn.onclick = async () => {
    if (!_rawFileBlob || !_whisperChk.checked) return;
    // Önce arşivi kontrol et
    const cached = await loadTranscriptFromDB();
    if (cached && cached.segments && cached.segments.length) {
      aiSetStatus(`✓ Whisper (arşiv): ${cached.segments.length} segment`, '#60a5fa');
      _renderNgTranscript(cached, true);
      addLog('ok', `💾 Whisper transkript arşivden yüklendi — tekrar çalıştırmana gerek yok`);
      return;
    }
    aiSetStatus('⏳ Whisper çalışıyor...', '#60a5fa');
    _whisperBtn.disabled = true;
    _whisperResult.style.display = 'flex';
    _whisperResult.innerHTML = '<span style="font-size:10px;color:#475569;padding:4px">⏳ Dosya gönderiliyor...</span>';
    try {
      const fd = new FormData();
      fd.append('file',  _rawFileBlob, _rawFileBlob.name);
      fd.append('model', _whisperModel.value);
      const r1 = await fetch('/api/transcribe/start', { method: 'POST', body: fd });
      if (!r1.ok) throw new Error(`HTTP ${r1.status}`);
      const d1 = await r1.json();
      if (!d1.success) throw new Error(d1.error);
      const jobId = d1.job_id;
      addLog('ok', `Whisper işi başlatıldı: ${jobId}`);

      // Polling
      await new Promise((resolve, reject) => {
        const timer = setInterval(async () => {
          try {
            const rs = await fetch(`/api/transcribe/status/${jobId}`);
            const ds = await rs.json();
            const pct = ds.status === 'done' ? 100 : ds.status === 'loading_model' ? 8 : Math.min(90, 10 + (ds.elapsed || 0) * 0.4);
            _whisperResult.innerHTML = `<span style="font-size:10px;color:#60a5fa;padding:4px">⏳ ${ds.status} — ${Math.round(pct)}%</span>`;
            if (ds.status === 'done') {
              clearInterval(timer);
              saveTranscriptToDB(ds.result);
              resolve(ds.result);
            } else if (ds.status === 'error') {
              clearInterval(timer);
              reject(new Error(ds.error || 'Whisper hatası'));
            }
          } catch(e) { clearInterval(timer); reject(e); }
        }, 3000);
      }).then(result => {
        aiSetStatus(`✓ Whisper: ${result.segments.length} segment`, '#60a5fa');
        _renderNgTranscript(result, false);
        addLog('ok', `Whisper tamamlandı: ${result.segments.length} segment, ${result.stats?.total_words || '?'} kelime`);
      });
    } catch(e) {
      aiSetStatus('Whisper hatası: ' + e.message, '#ef4444');
      _whisperResult.innerHTML = `<span style="font-size:10px;color:#ef4444;padding:4px">✗ ${e.message}</span>`;
    } finally {
      _whisperBtn.disabled = !_whisperChk.checked;
    }
  };

  // Arşivden otomatik yükle
  if (_rawFileBlob) {
    loadTranscriptFromDB().then(cached => {
      if (cached && cached.segments && cached.segments.length) {
        _renderNgTranscript(cached, true);
        aiSetStatus(`✓ Whisper (arşiv): ${cached.segments.length} segment`, '#60a5fa');
        addLog('ok', `💾 Whisper transkript arşivden yüklendi`);
      }
    }).catch(() => {});
  }

  modal.querySelector('#ng-diarize-btn').onclick = () => {
    if (!_rawFileBlob) { aiSetStatus('Önce ses dosyası yükleyin', '#ef4444'); return; }
    hfRow.style.display = 'flex';
  };
  // Diarize progress UI
  let _diarProgEl = null;
  function _setDiarProg(pct, step, color='#f59e0b') {
    if (!_diarProgEl) {
      _diarProgEl = document.createElement('div');
      _diarProgEl.style.cssText = 'margin-top:8px;background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:10px 14px';
      hfRow.parentElement.insertBefore(_diarProgEl, hfRow.nextSibling);
    }
    _diarProgEl.style.display = '';
    _diarProgEl.innerHTML = `
      <div style="font-size:11px;color:${color};margin-bottom:6px">${step}</div>
      <div style="background:#1e293b;border-radius:4px;height:8px;overflow:hidden">
        <div style="background:linear-gradient(90deg,#6366f1,#a855f7);height:100%;width:${pct}%;transition:width 0.4s;border-radius:4px"></div>
      </div>
      <div style="font-size:10px;color:#475569;margin-top:4px;text-align:right">${pct}%</div>`;
  }

  modal.querySelector('#ng-hf-go').onclick = async () => {
    const token = modal.querySelector('#ng-hf-token').value.trim();
    if (!token) { aiSetStatus('Token boş olamaz', '#ef4444'); return; }
    localStorage.setItem('hf_token', token);
    hfRow.style.display = 'none';
    _setDiarProg(2, '📤 Dosya yükleniyor…');
    try {
      const fd = new FormData();
      fd.append('file', _rawFileBlob, _rawFileBlob.name || 'audio.wav');
      fd.append('hf_token', token);
      const nspk = modal.querySelector('#ng-hf-nspk').value.trim();
      if (nspk) fd.append('num_speakers', nspk);
      const res = await fetch('/api/diarize', { method: 'POST', body: fd });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status} — ${txt.replace(/<[^>]+>/g,'').trim().slice(0,300)}`);
      }
      const { job_id } = await res.json();

      // Progress polling — retry on network errors
      let _diarNotFound = 0;
      const data = await new Promise((resolve, reject) => {
        const poll = setInterval(async () => {
          try {
            const pr = await fetch(`/api/diarize/progress/${job_id}`);
            if (pr.status === 404) {
              _diarNotFound++;
              if (_diarNotFound > 3) { clearInterval(poll); reject(new Error('Sunucu yeniden başladı — işlemi tekrar başlatın')); }
              return;
            }
            const pd = await pr.json();
            _diarNotFound = 0;
            _setDiarProg(pd.pct || 0, pd.step || '…');
            aiSetStatus(`⏳ ${pd.step || '…'}`, '#f59e0b');
            if (pd.status === 'done') { clearInterval(poll); resolve(pd.result); }
            else if (pd.status === 'error') { clearInterval(poll); reject(new Error(pd.error)); }
          } catch(e) {
            _diarNotFound++;
            if (_diarNotFound > 5) { clearInterval(poll); reject(new Error('Sunucu bağlantısı kesildi — işlemi tekrar başlatın')); }
          }
        }, 600);
      });

      _setDiarProg(100, '✅ Tamamlandı!', '#4ade80');
      setTimeout(() => { if (_diarProgEl) _diarProgEl.style.display = 'none'; }, 4000);
      applyDiarizeResult(data);
    } catch(e) {
      _setDiarProg(0, '❌ ' + e.message, '#ef4444');
      aiSetStatus('Diarizasyon hatası: ' + e.message, '#ef4444');
    }
  };

  // Diarize sonucunu UI'ye uygula — hem canlı hem cache'den yükleme için ortak fonksiyon
  function applyDiarizeResult(data) {
      ngDiarizeSegs = data.segments;
      CanvasOverlay.setSpeakers(ngDiarizeSegs);
      draw(threshold);
      showClearBtn();
      const colors = ['#3b82f6','#f97316','#a855f7','#ec4899','#14b8a6'];
      aiSetStatus(`✓ ${data.speaker_count} konuşmacı tespit edildi`, '#818cf8');
      addLog('ok', `👥 ${data.speaker_count} konuşmacı tespit edildi: ${data.speakers.join(', ')}`);

      // Sonuçları IndexedDB'ye kaydet
      if (_rawFileBlob) {
        saveDiarizeToDB(_rawFileBlob.name, _rawFileBlob.size,
          { segments: data.segments, speakers: data.speakers, speaker_count: data.speaker_count }
        ).then(() => addLog('info', '💾 Konuşmacı verileri DB\'ye kaydedildi'));
      }

      // Geçici banner bildirimi
      const _banner = document.createElement('div');
      _banner.style.cssText = 'position:fixed;top:24px;left:50%;transform:translateX(-50%);background:#312e81;border:1px solid #6366f1;color:#e0e7ff;padding:10px 24px;border-radius:10px;font-size:14px;font-weight:600;z-index:9999;box-shadow:0 4px 24px #0008;pointer-events:none';
      _banner.textContent = `👥 ${data.speaker_count} konuşmacı tespit edildi — dalga formunda renkli gösterildi`;
      document.body.appendChild(_banner);
      setTimeout(() => _banner.remove(), 4000);

      // Konuşmacı yeniden adlandırma + silme + dinleme UI
      aiResult.innerHTML = data.speakers.map((sp, i) => `
        <div data-sp="${sp}" style="display:flex;align-items:center;gap:6px;margin:4px 0">
          <input type="checkbox" data-sp-chk="${sp}" checked
            style="width:14px;height:14px;cursor:pointer;accent-color:${colors[i%colors.length]}">
          <span style="width:10px;height:10px;border-radius:50%;background:${colors[i%colors.length]};flex-shrink:0;display:inline-block"></span>
          <button data-sp-play="${sp}"
            style="background:#0f172a;border:1px solid #1e40af;color:#93c5fd;border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer"
            title="Bu konuşmacının sesini dinle">▶</button>
          <input type="text" value="${sp}" data-sp-id="${sp}"
            style="background:#1e293b;border:1px solid #334155;color:#e2e8f0;border-radius:4px;padding:2px 8px;font-size:12px;width:110px"
            placeholder="İsim girin...">
          <button data-sp-del="${sp}"
            style="background:#1a0a0a;border:1px solid #7f1d1d;color:#f87171;border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer"
            title="Bu konuşmacının tüm bölgelerini sil">🗑 Sil</button>
        </div>`).join('') + `
        <div style="margin-top:10px;padding-top:8px;border-top:1px solid #1e293b;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <button id="ng-sp-process"
            style="background:linear-gradient(135deg,#1e3a5f,#312e81);border:1px solid #3b82f6;color:#93c5fd;border-radius:6px;padding:5px 14px;font-size:12px;font-weight:600;cursor:pointer">
            ✂ Seçilenleri İşle &amp; İndir</button>
          <label style="font-size:11px;color:#64748b;display:flex;align-items:center;gap:4px">
            Gürültü gücü:
            <input id="ng-sp-str" type="range" min="0" max="10" value="5" style="width:70px">
            <span id="ng-sp-str-val">5</span>
            <span id="ng-sp-str-desc" style="font-size:9px;color:#475569;margin-left:2px"></span>
          </label>
        </div>`;

      // ▶ Dinle
      aiResult.querySelectorAll('button[data-sp-play]').forEach(btn => {
        btn.addEventListener('click', () => playSpeaker(btn.dataset.spPlay, btn));
      });

      // Gürültü gücü slider
      const spStrSlider = aiResult.querySelector('#ng-sp-str');
      const spStrVal    = aiResult.querySelector('#ng-sp-str-val');
      const spStrDesc   = aiResult.querySelector('#ng-sp-str-desc');
      const _strLabels  = ['Yok','Hafif','Hafif','Orta','Orta','Orta+','Vurma+','Yoğun','Yoğun+','Maks','Maks+'];
      const _strColors  = ['#475569','#64748b','#64748b','#78716c','#78716c','#92400e','#b45309','#dc2626','#dc2626','#7c3aed','#7c3aed'];
      function _updateStrLabel(v) {
        spStrVal.textContent = v;
        if (spStrDesc) { spStrDesc.textContent = _strLabels[v] || ''; spStrDesc.style.color = _strColors[v] || '#475569'; }
      }
      spStrSlider.addEventListener('input', () => _updateStrLabel(+spStrSlider.value));
      _updateStrLabel(+spStrSlider.value);

  // ── Proje paneli ──
  const projNameInput = modal.querySelector('#ng-proj-name');
  const projPanel     = modal.querySelector('#ng-proj-panel');

  // Aktif proje adını yükle (localStorage'dan)
  const _savedProjName = localStorage.getItem('current_project_name') || '';
  if (_savedProjName) { projNameInput.value = _savedProjName; _currentProjectName = _savedProjName; }

  function _currentStages() {
    return {
      vocals:    !!(_rawFileBlob && _rawFileBlob.name && _rawFileBlob.name.includes('_vocals')),
      whisper:   !!(_ngTranscript && _ngTranscript.segments && _ngTranscript.segments.length),
      diarize:   !!(ngDiarizeSegs && ngDiarizeSegs.length),
      vad:       !!(ngVadSegs && ngVadSegs.length),
    };
  }

  function _stageBadges(stages) {
    const defs = [
      { key: 'vocals',  label: '🎵 Vokal',       color: '#fb923c', bg: '#1a0a00', border: '#7c2d12' },
      { key: 'whisper', label: '🎙 Whisper',      color: '#60a5fa', bg: '#06111e', border: '#1d4ed8' },
      { key: 'diarize', label: '👥 Diarizasyon',  color: '#818cf8', bg: '#0f172a', border: '#3730a3' },
      { key: 'vad',     label: '✦ VAD',           color: '#4ade80', bg: '#0c1f12', border: '#166534' },
    ];
    return defs.map(d => stages[d.key]
      ? `<span style="font-size:9px;padding:1px 6px;background:${d.bg};border:1px solid ${d.border};color:${d.color};border-radius:10px">${d.label}</span>`
      : `<span style="font-size:9px;padding:1px 6px;background:#0f172a;border:1px solid #1e293b;color:#334155;border-radius:10px">${d.label}</span>`
    ).join('');
  }

  async function _renderProjPanel() {
    const projects = await loadAllProjectsFromDB();
    if (!projects.length) {
      projPanel.innerHTML = '<div style="font-size:11px;color:#475569;padding:8px;text-align:center">Henüz kayıtlı proje yok.</div>';
      return;
    }
    projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    projPanel.innerHTML = projects.map(p => {
      const d = new Date(p.updatedAt || p.createdAt);
      const dateStr = `${d.getDate()}.${d.getMonth()+1}.${d.getFullYear()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
      const active = p.name === _currentProjectName;
      return `<div style="display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:6px;border:1px solid ${active?'#3b82f6':'#1e293b'};background:${active?'#0c1f3f':'transparent'};margin-bottom:3px;flex-wrap:wrap">
        <span style="font-size:11px;color:${active?'#93c5fd':'#e2e8f0'};font-weight:${active?'700':'400'};flex:1;min-width:80px">${p.name}</span>
        <span style="font-size:9px;color:#334155;white-space:nowrap">${dateStr}</span>
        <div style="display:flex;gap:3px;flex-wrap:wrap">${_stageBadges(p.stages || {})}</div>
        <button class="proj-load-btn" data-id="${p.id}" style="font-size:10px;padding:2px 7px;background:#1e3a5f;border:1px solid #3b82f6;border-radius:4px;color:#93c5fd;cursor:pointer;white-space:nowrap">▶ Yükle</button>
        <button class="proj-del-btn"  data-id="${p.id}" style="font-size:10px;padding:2px 7px;background:transparent;border:1px solid #450a0a;border-radius:4px;color:#7f1d1d;cursor:pointer">✕</button>
      </div>`;
    }).join('');

    projPanel.querySelectorAll('.proj-del-btn').forEach(btn => btn.onclick = async () => {
      if (!confirm(`"${projects.find(p=>p.id===btn.dataset.id)?.name}" projesini sil?`)) return;
      await deleteProjectFromDB(btn.dataset.id);
      _renderProjPanel();
    });

    projPanel.querySelectorAll('.proj-load-btn').forEach(btn => btn.onclick = async () => {
      const proj = projects.find(p => p.id === btn.dataset.id);
      if (!proj) return;
      btn.textContent = '⏳';  btn.disabled = true;
      const sessData = await loadSessionByKey(proj.fileKey);
      if (!sessData || !sessData.raw) {
        alert(`Bu proje için ses dosyası arşivde bulunamadı.\nDosyayı tekrar yükleyin.`);
        btn.textContent = '▶ Yükle'; btn.disabled = false; return;
      }
      // Sesi yükle
      const file = new File([sessData.raw], sessData.name, { type: 'audio/mpeg' });
      projNameInput.value = proj.name;
      _currentProjectName = proj.name;
      localStorage.setItem('current_project_name', proj.name);
      projPanel.style.display = 'none';
      modal.querySelector('#ng-close').click();   // modalı kapat
      await loadFile(file);
      addLog('ok', `Proje yüklendi: "${proj.name}" (${proj.fileKey})`);
    });
  }

  const _clearBtn = document.getElementById('ng-clear-db');
  console.log('[init] clear btn:', !!_clearBtn);
  if (_clearBtn) _clearBtn.onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    _clearBtn.textContent = '⏳ Siliniyor...';
    _clearBtn.style.color = '#f59e0b';
    _clearBtn.disabled = true;
    const ok = await clearAllDB();
    if (ok) {
      _clearBtn.textContent = '✔ Silindi — yenileniyor...';
      _clearBtn.style.color = '#4ade80';
      _clearBtn.style.borderColor = '#166534';
      localStorage.removeItem('current_project_name');
      window._stepAudioSnapshots = {};
      window._stepDetails = {};
      setTimeout(() => location.reload(), 800);
    } else {
      btn.textContent = '✗ Hata';
      btn.disabled = false;
    }
  };

  modal.querySelector('#ng-proj-list').onclick = () => {
    const open = projPanel.style.display !== 'none';
    projPanel.style.display = open ? 'none' : 'block';
    if (!open) _renderProjPanel();
  };

  modal.querySelector('#ng-proj-save').onclick = async () => {
    const name = projNameInput.value.trim();
    if (!name) { projNameInput.focus(); return; }
    if (!_rawFileBlob) { addLog('warn', 'Ses dosyası yüklenmemiş'); return; }
    _currentProjectName = name;
    localStorage.setItem('current_project_name', name);
    const fileKey = `${_rawFileBlob.name}|${_rawFileBlob.size}`;
    await saveProjectToDB(name, fileKey, _currentStages());
    const btn = modal.querySelector('#ng-proj-save');
    btn.textContent = '✓ Kaydedildi';
    btn.style.color = '#4ade80';
    setTimeout(() => { btn.textContent = '💾 Kaydet'; btn.style.color = '#93c5fd'; }, 1800);
    addLog('ok', `Proje kaydedildi: "${name}" · ${JSON.stringify(_currentStages())}`);
  };

      // Ayarları Kaydet butonu (toolbar'daki statik buton) — isimler + güç + segmentler DB'ye
      modal.querySelector('#ng-save-settings').addEventListener('click', async () => {
        if (!_rawFileBlob) return;
        // Güncel konuşmacı isimlerini topla
        const nameMap = {};
        aiResult.querySelectorAll('input[data-sp-id]').forEach(inp => {
          nameMap[inp.dataset.spId] = inp.value.trim() || inp.dataset.spId;
        });
        const updatedSpeakers = Object.values(nameMap);
        const updatedSegs = ngDiarizeSegs.map(s => ({
          ...s,
          speaker: nameMap[s.speaker] || s.speaker
        }));
        const saveBtn = modal.querySelector('#ng-save-settings');
        saveBtn.textContent = '⏳ Kaydediliyor…';
        saveBtn.disabled = true;
        await saveDiarizeToDB(_rawFileBlob.name, _rawFileBlob.size, {
          segments: updatedSegs,
          speakers: updatedSpeakers,
          speaker_count: updatedSpeakers.length,
          sp_strength: +spStrSlider.value
        });
        // ngDiarizeSegs'i de güncelle
        ngDiarizeSegs = updatedSegs;
        CanvasOverlay.setSpeakers(ngDiarizeSegs);
        _saveNgSettings();
        saveBtn.textContent = '✅ Kaydedildi';
        saveBtn.style.color = '#22c55e';
        saveBtn.style.borderColor = '#22c55e';
        setTimeout(() => {
          saveBtn.textContent = '💾 Ayarları Kaydet';
          saveBtn.style.color = '#4ade80';
          saveBtn.style.borderColor = '#166534';
          saveBtn.disabled = false;
        }, 2000);
        addLog('ok', `💾 Konuşmacı isimleri ve ayarlar DB'ye kaydedildi`);
      });

      // İsim değişince segmentlerdeki speaker adını güncelle
      aiResult.querySelectorAll('input[data-sp-id]').forEach(inp => {
        inp.addEventListener('change', () => {
          const oldId = inp.dataset.spId;
          const newName = inp.value.trim() || oldId;
          ngDiarizeSegs.forEach(s => { if (s.speaker === oldId) s.speaker = newName; });
          if (_spPlaying === oldId) _spPlaying = newName;
          inp.dataset.spId = newName;
          const row = inp.closest('[data-sp]');
          row.dataset.sp = newName;
          row.querySelector('[data-sp-del]').dataset.spDel = newName;
          row.querySelector('[data-sp-play]').dataset.spPlay = newName;
          row.querySelector('[data-sp-chk]').dataset.spChk = newName;
        });
      });

      // Sil — o konuşmacının bölgelerini kaldır ve dalga formunu yenile
      aiResult.querySelectorAll('button[data-sp-del]').forEach(btn => {
        btn.addEventListener('click', () => {
          const sp = btn.dataset.spDel;
          if (_spPlaying === sp) stopSpAudio();
          ngDiarizeSegs = ngDiarizeSegs.filter(s => s.speaker !== sp);
          CanvasOverlay.setSpeakers(ngDiarizeSegs);
          btn.closest('[data-sp]').remove();
          draw(threshold);
          const remaining = aiResult.querySelectorAll('[data-sp]').length;
          aiSetStatus(`✓ ${remaining} konuşmacı kaldı`, '#818cf8');
        });
      });

      // ✂ Seçilenleri İşle & İndir
      aiResult.querySelector('#ng-sp-process').addEventListener('click', async () => {
        if (!_rawFileBlob) { aiSetStatus('Dosya yüklenmemiş', '#ef4444'); return; }
        const checked = [...aiResult.querySelectorAll('input[data-sp-chk]:checked')].map(c => c.dataset.spChk);
        if (!checked.length) { aiSetStatus('En az bir konuşmacı seçin', '#ef4444'); return; }

        // Seçili konuşmacı segmentleri
        let spSegs = ngDiarizeSegs.filter(s => checked.includes(s.speaker)).sort((a, b) => a.start - b.start);
        if (!spSegs.length) { aiSetStatus('Seçili konuşmacıya ait bölge yok', '#ef4444'); return; }

        // Eşik sessizliklerini çıkar: konuşmacı segmentleri içindeki sessiz bölgeleri kes
        const _chkStep1Sp = document.querySelector('#ng-chk-step1');
        const silSegs = (_chkStep1Sp && !_chkStep1Sp.checked) ? [] : computeSegs(threshold, minDurSec);
        if (silSegs.length) {
          const refined = [];
          for (const sp of spSegs) {
            let cur = sp.start;
            for (const sil of silSegs) {
              if (sil.end <= sp.start || sil.start >= sp.end) continue; // çakışmıyor
              const silS = Math.max(sil.start, sp.start);
              const silE = Math.min(sil.end, sp.end);
              if (cur < silS) refined.push({ start: cur, end: silS, speaker: sp.speaker, speakerIdx: sp.speakerIdx });
              cur = silE;
            }
            if (cur < sp.end) refined.push({ start: cur, end: sp.end, speaker: sp.speaker, speakerIdx: sp.speakerIdx });
          }
          spSegs = refined.filter(s => s.end - s.start > 0.1);
        }

        const _chkStep1Noise = document.querySelector('#ng-chk-step1');
        const strength = (_chkStep1Noise && !_chkStep1Noise.checked) ? 0 : +spStrSlider.value;
        const names = checked.join(', ');

        // Progress UI
        let _progEl = document.getElementById('ng-sp-progress');
        if (!_progEl) {
          _progEl = document.createElement('div');
          _progEl.id = 'ng-sp-progress';
          _progEl.style.cssText = 'margin-top:10px;background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:10px 14px';
          aiResult.querySelector('#ng-sp-process').parentElement.after(_progEl);
        }
        const _setProg = (pct, step, color='#f59e0b') => {
          _progEl.innerHTML = `
            <div style="font-size:11px;color:${color};margin-bottom:6px">${step}</div>
            <div style="background:#1e293b;border-radius:4px;height:8px;overflow:hidden">
              <div style="background:linear-gradient(90deg,#3b82f6,#8b5cf6);height:100%;width:${pct}%;transition:width 0.3s;border-radius:4px"></div>
            </div>
            <div style="font-size:10px;color:#475569;margin-top:4px;text-align:right">${pct}%</div>`;
        };

        try {
          _setProg(2, '📤 Dosya yükleniyor…');
          const fd = new FormData();
          fd.append('file', _rawFileBlob, _rawFileBlob.name || 'audio.wav');
          fd.append('segments', JSON.stringify(spSegs));
          fd.append('strength', strength);
          const res = await fetch('/api/process_speakers', { method: 'POST', body: fd });
          if (!res.ok) {
            const txt = await res.text();
            throw new Error(`HTTP ${res.status} — ${txt.replace(/<[^>]+>/g,'').trim().slice(0,300)}`);
          }
          const { job_id } = await res.json();

          // Progress polling — 404 = sunucu yeniden başladı
          let _notFoundCount = 0;
          await new Promise((resolve, reject) => {
            const poll = setInterval(async () => {
              try {
                const pr = await fetch(`/api/process_speakers/progress/${job_id}`);
                if (pr.status === 404) {
                  _notFoundCount++;
                  if (_notFoundCount > 3) {
                    clearInterval(poll);
                    reject(new Error('Sunucu yeniden başladı — işlemi tekrar başlatın'));
                  }
                  return;
                }
                const pd = await pr.json();
                _notFoundCount = 0;
                _setProg(pd.pct || 0, pd.step || '…');
                if (pd.status === 'done') { clearInterval(poll); resolve(); }
                else if (pd.status === 'error') { clearInterval(poll); reject(new Error(pd.error)); }
              } catch(e) {
                _notFoundCount++;
                if (_notFoundCount > 5) { clearInterval(poll); reject(new Error('Sunucu bağlantısı kesildi — işlemi tekrar başlatın')); }
              }
            }, 600);
          });

          _setProg(100, '⬇ İndiriliyor…', '#4ade80');
          const dlRes = await fetch(`/api/process_speakers/download/${job_id}`);
          const blob = await dlRes.blob();
          const url  = URL.createObjectURL(blob);
          const a    = document.createElement('a');
          a.href = url; a.download = 'konusmaci_secim.mp3'; a.click();
          URL.revokeObjectURL(url);

          _setProg(100, `✅ Tamamlandı — ${names}`, '#4ade80');
          aiSetStatus(`✓ İndirildi — ${names}`, '#4ade80');
          addLog('ok', `✂ Konuşmacı seçimi işlendi ve indirildi: ${names} (${spSegs.length} segment)`);
          setTimeout(() => { _progEl.style.display = 'none'; }, 4000);
        } catch(e) {
          _setProg(0, '❌ ' + e.message, '#ef4444');
          aiSetStatus('İşlem hatası: ' + e.message, '#ef4444');
        }
      });
  }  // applyDiarizeResult sonu

  // Cache'den geri yükleme için global referans
  window._restoreDiarize = applyDiarizeResult;

  // DB'den otomatik yükle (timing sorunu yok — openNoiseGateInline içinde sync değil async)
  if (_rawFileBlob && !ngDiarizeSegs.length) {
    loadDiarizeFromDB(_rawFileBlob.name, _rawFileBlob.size).then(cached => {
      if (cached && cached.segments && !ngDiarizeSegs.length) {
        applyDiarizeResult(cached);
        // Kaydedilmiş güç ayarını geri yükle
        if (cached.sp_strength != null) {
          const sl = document.querySelector('#ng-sp-str');
          const sv = document.querySelector('#ng-sp-str-val');
          if (sl) { sl.value = cached.sp_strength; if (sv) sv.textContent = cached.sp_strength; }
        }
        addLog('ok', `💾 DB'den yüklendi: ${cached.speaker_count} konuşmacı — tekrar çalıştırmana gerek yok`);
      }
    }).catch(e => addLog('warn', 'Diarize DB yükleme: ' + e.message));
  }

  // VAD arşivden geri yükle
  if (_rawFileBlob && !ngVadSegs.length) {
    loadVadFromDB(_rawFileBlob.name, _rawFileBlob.size).then(cached => {
      if (cached && cached.segments && cached.segments.length && !ngVadSegs.length) {
        ngVadSegs = cached.segments;
        CanvasOverlay.setVad(ngVadSegs);
        draw(threshold);
        const totalSec = Math.round(ngVadSegs.reduce((s, g) => s + (g.end - g.start), 0) * 10) / 10;
        _showVadResult(ngVadSegs.length, totalSec, true);
        addLog('ok', `💾 VAD arşivden yüklendi: ${ngVadSegs.length} bölge — tekrar çalıştırmana gerek yok`);
      }
    }).catch(e => addLog('warn', 'VAD DB yükleme: ' + e.message));
  }

  // Step 2 tamamlandı göstergesi: session DB'de vocals dosyası varsa otomatik banner göster
  if (_rawFileBlob && _rawFileBlob.name && _rawFileBlob.name.includes('_vocals')) {
    const _vb = document.createElement('div');
    _vb.style.cssText = 'margin:8px 0 4px;padding:7px 12px;background:#1a0a00;border:1px solid #92400e;border-radius:7px;display:flex;align-items:center;gap:8px;flex-wrap:wrap';
    _vb.innerHTML = `<span style="font-size:10px;color:#fb923c;flex:1">💾 2. Adım ✓ Vokal arşivden: <b>${_rawFileBlob.name}</b></span>
      <button id="_vb-dl" style="font-size:10px;padding:2px 8px;background:#1c1400;border:1px solid #92400e;border-radius:4px;color:#fb923c;cursor:pointer">⬇ İndir</button>`;
    aiResult.innerHTML = '';
    aiResult.appendChild(_vb);
    _vb.querySelector('#_vb-dl').onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(_rawFileBlob);
      a.download = _rawFileBlob.name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    };
    aiSetStatus('💾 Arşivden yüklendi — 2. Adım tamamlandı', '#fb923c');
  }

  // ── Vokal İzolasyonu (demucs) ──
  modal.querySelector('#ng-denoise-btn').onclick = async () => {
    if (!_rawFileBlob) { aiSetStatus('Önce ses dosyası yükleyin', '#ef4444'); return; }
    aiSetStatus('⏳ Vokal izolasyonu (demucs)... GPU\'da 1-3dk sürebilir.', '#f59e0b');
    try {
      const fd = new FormData();
      fd.append('file', _rawFileBlob, _rawFileBlob.name || 'audio.wav');
      fd.append('stem', 'vocals');
      const res = await pipeFetch('/api/denoise', { method: 'POST', body: fd });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
      }
      const blob = await res.blob();
      const base = (_rawFileBlob.name || 'ses').replace(/\.[^.]+$/, '');
      const vocalFile = new File([blob], base + '_vocals.mp3', { type: 'audio/mpeg' });

      aiSetStatus('✓ Vokal izolasyonu tamamlandı', '#fb923c');

      // Sonuç banner'ı — indir veya bu sesle devam et
      const _b = document.createElement('div');
      _b.style.cssText = 'margin:8px 0;padding:10px 14px;background:#1a0a00;border:1px solid #92400e;border-radius:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap';
      _b.innerHTML = `
        <span style="font-size:12px;color:#fb923c;flex:1">🎵 Vokal izole edildi: <b>${vocalFile.name}</b></span>
        <button id="_vocal-dl" style="font-size:11px;padding:3px 10px;background:#1c1400;border:1px solid #92400e;border-radius:4px;color:#fb923c;cursor:pointer">⬇ İndir</button>
        <button id="_vocal-load" style="font-size:11px;padding:3px 10px;background:#1e3a5f;border:1px solid #3b82f6;border-radius:4px;color:#93c5fd;cursor:pointer;font-weight:700">3. Adım → Konuşmacı Tespiti</button>
        <button id="_vocal-skip" style="font-size:11px;padding:3px 10px;background:#1a3a1a;border:1px solid #16a34a;border-radius:4px;color:#4ade80;cursor:pointer">Tespiti Atla →</button>`;
      aiResult.innerHTML = '';
      aiResult.appendChild(_b);

      _b.querySelector('#_vocal-dl').onclick = () => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = vocalFile.name; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
      };

      // Ortak yükleme fonksiyonu
      const _doVocalLoad = async (keepSegs) => {
        const loadBtn  = _b.querySelector('#_vocal-load');
        const skipBtn  = _b.querySelector('#_vocal-skip');
        if (loadBtn)  { loadBtn.disabled = true;  loadBtn.textContent  = '⏳ Yükleniyor…'; }
        if (skipBtn)  { skipBtn.disabled = true; }
        try {
          // AudioContext'i kapatmıyoruz — close() asenkron, hemen ardından gelen
          // decodeAudioData "Cannot call decodeAudioData on a closed AudioContext" hatası verir.
          // getCtx() zaten kapalı/null ise yeni context oluşturur, açıksa reuse eder.
          const _savedSegs     = keepSegs ? ngDiarizeSegs.slice() : [];
          const _savedSpeakers = _savedSegs.length ? [...new Set(_savedSegs.map(s => s.speaker))] : [];
          await loadFile(vocalFile);
          if (_savedSegs.length && window._restoreDiarize) {
            window._restoreDiarize({ segments: _savedSegs, speakers: _savedSpeakers, speaker_count: _savedSpeakers.length });
            addLog('ok', `🎵 Vokal yüklendi + ${_savedSpeakers.length} konuşmacı segmenti korundu`);
          } else {
            addLog('ok', `🎵 Vokal yüklendi — şimdi Konuşmacı Tespiti yapabilirsin`);
          }
        } catch(e) {
          addLog('error', '🎵 Vokal yükleme hatası: ' + e.message);
          if (loadBtn) { loadBtn.disabled = false; loadBtn.textContent = '3. Adım → Konuşmacı Tespiti'; }
          if (skipBtn) { skipBtn.disabled = false; }
        }
      };

      // 2. Adım → Konuşmacı Tespiti: yükle, segmentleri temizle, diarize panelini aç
      _b.querySelector('#_vocal-load').onclick = async () => {
        await _doVocalLoad(false);
        // Konuşmacı tespiti butonunu otomatik tetikle
        const dBtn = document.querySelector('#ng-diarize-btn');
        if (dBtn) dBtn.click();
      };

      // Tespiti Atla: mevcut segmentleri koru, yükle
      _b.querySelector('#_vocal-skip').onclick = () => _doVocalLoad(true);

    } catch(e) {
      aiSetStatus('demucs hatası: ' + e.message, '#ef4444');
    }
  };

  // ── Gürültü Temizle (FFmpeg afftdn) ──
  const ncleanRow = modal.querySelector('#ng-nclean-row');
  const ncleanStr = modal.querySelector('#ng-nclean-str');
  const ncleanVal = modal.querySelector('#ng-nclean-val');
  const ncleanLabels = ['','Hafif','Hafif','Hafif','Orta','Orta','Orta','Güçlü','Güçlü','Maksimum','Maksimum'];
  if (_ngSettings.spStrVal) { ncleanStr.value = _ngSettings.spStrVal; }
  ncleanVal.textContent = ncleanLabels[+ncleanStr.value] + ' (' + ncleanStr.value + ')';
  ncleanStr.addEventListener('input', () => {
    ncleanVal.textContent = ncleanLabels[+ncleanStr.value] + ' (' + ncleanStr.value + ')';
    _saveNgSettings();
  });
  modal.querySelector('#ng-nclean-btn').onclick = () => {
    if (!_rawFileBlob) { aiSetStatus('Önce ses dosyası yükleyin', '#ef4444'); return; }
    ncleanRow.style.display = 'flex';
  };
  modal.querySelector('#ng-nclean-go').onclick = async () => {
    ncleanRow.style.display = 'none';
    const strength = ncleanStr.value;  // 1–10
    aiSetStatus('⏳ Gürültü temizleniyor (FFmpeg afftdn)...', '#4ade80');
    try {
      const fd = new FormData();
      fd.append('file', _rawFileBlob, _rawFileBlob.name || 'audio.wav');
      fd.append('strength', strength);
      const res = await fetch('/api/noise_clean', { method: 'POST', body: fd });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      const base = (_rawFileBlob.name || 'ses').replace(/\.[^.]+$/, '');
      a.href = url; a.download = base + '_temiz.mp3'; a.click();
      URL.revokeObjectURL(url);
      aiSetStatus('✓ Temizlenmiş dosya indirildi', '#4ade80');
      aiResult.textContent = 'FFmpeg afftdn ile arka plan gürültüsü temizlendi ve mp3 olarak indirildi.';
    } catch(e) {
      aiSetStatus('Hata: ' + e.message, '#ef4444');
    }
  };

  // ── Kapat ────────────────────────────────────────────────────────────────────
  function closeModal() {
    ngStop();
    if (ngAudio) { ngAudio.src = ''; ngAudio = null; }
    if (ngAudioUrl) { URL.revokeObjectURL(ngAudioUrl); ngAudioUrl = null; }
    modal.remove();
    switchTrackTab('ai');   // AI Analiz sekmesine geri dön
  }
  modal.querySelector('#ng-close').onclick = closeModal;

  // ── Uygula ───────────────────────────────────────────────────────────────────
  modal.querySelector('#ng-apply').onclick = () => {
    const _chkStep1 = modal.querySelector('#ng-chk-step1');
    const autoSegs  = (_chkStep1 && !_chkStep1.checked) ? [] : computeSegs(threshold, minDurSec);
    const allSegs    = [...autoSegs, ...manualSegs];
    if (!allSegs.length) { addLog('warn', 'Kesilecek bölge bulunamadı'); return; }
    // Örtüşenleri birleştir, zaman sırasına koy
    allSegs.sort((a, b) => a.start - b.start);
    const merged = [allSegs[0]];
    for (let i = 1; i < allSegs.length; i++) {
      const last = merged[merged.length - 1];
      if (allSegs[i].start <= last.end + 0.05) last.end = Math.max(last.end, allSegs[i].end);
      else merged.push(allSegs[i]);
    }
    addLog('ok', `${merged.length} kesim bölgesi · ${merged.reduce((s,g)=>s+(g.end-g.start),0).toFixed(1)}s`);
    closeModal();
    showApprovalModal(merged, null);
  };

  // ── İlk çizim + overlay kontrol paneli ──────────────────────────────────────
  requestAnimationFrame(() => {
    draw(threshold);
    CanvasOverlay.renderControls('overlay-controls-container');
  });
}

function showApprovalModal(allSegments, normalizeLUFS) {
  const existing = document.getElementById('approval-modal');
  if (existing) existing.remove();

  // Segment başlangıç/bitiş ayarlamaları: {index: {start, end}}
  const _adj = {};
  allSegments.forEach((s,i) => { _adj[i] = {start: s.start, end: s.end}; });

  const delSegs  = allSegments.filter(s=>s.action==='delete');
  const attSegs  = allSegments.filter(s=>s.action==='attenuate');
  const totalDur = allSegments.reduce((acc,s)=>acc+(s.end-s.start),0);

  function segRowHtml(s, i) {
    const actLabel  = CMD_ACTION_TR[s.action?.toLowerCase()] || s.action?.toUpperCase() || '?';
    const typeLabel = TYPE_TR[s.type?.toLowerCase()] || s.type || '';
    const dur       = (s.end - s.start).toFixed(2);
    const color     = s.action==='delete' ? '#ef4444' : '#fbbf24';
    return `<div class="aseg-row" data-index="${i}" style="display:flex;align-items:center;gap:6px;padding:4px 8px;border-left:2px solid ${color};margin-bottom:3px;border-radius:0 4px 4px 0;background:rgba(255,255,255,0.02)">
      <input type="checkbox" class="aseg-cb" data-index="${i}" checked style="accent-color:${color};flex-shrink:0;width:14px;height:14px;cursor:pointer">
      <span style="flex:1;min-width:0;font-size:11px">
        <span style="color:${color};font-weight:700;font-size:10px">${actLabel}</span>${typeLabel?` <span style="color:#64748b">· ${typeLabel}</span>`:''}
        <span class="aseg-times" data-index="${i}" style="color:#64748b;margin-left:6px;font-size:10px">${s.start.toFixed(2)}s–${s.end.toFixed(2)}s · <strong style="color:#94a3b8">${dur}s</strong></span>
      </span>
      <button class="seg-preview-btn" data-index="${i}" title="Dinle ve düzenle"
        style="flex-shrink:0;background:#1e293b;border:1px solid #334155;color:#94a3b8;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px">▶</button>
      <button class="aseg-del-btn" data-index="${i}" title="Bu bölgeyi listeden kaldır"
        style="flex-shrink:0;background:transparent;border:1px solid #334155;color:#64748b;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:11px">✕</button>
    </div>`;
  }

  const segsHtml = allSegments.map((s,i) => segRowHtml(s,i)).join('');

  const modal = document.createElement('div');
  modal.id = 'approval-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.82);z-index:9999;display:flex;align-items:center;justify-content:center;padding:12px';
  modal.innerHTML = `
    <div id="amod-box" style="background:#0f172a;border:1px solid #334155;border-radius:12px;width:90vw;max-width:90vw;height:92vh;max-height:92vh;display:flex;flex-direction:column;transition:all .2s">
      <!-- Başlık -->
      <div style="padding:12px 14px;border-bottom:1px solid #1e293b;display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
        <div>
          <span style="font-weight:700;color:#f1f5f9;font-size:14px">✅ Değişiklikleri Onayla</span>
          <span style="color:#64748b;font-size:10px;margin-left:8px">İstemediğin işareti kaldır · Kırmızı sınırları sürükle</span>
        </div>
        <div style="display:flex;gap:6px">
          <button id="amod-expand" title="Genişlet / Küçült" style="background:transparent;border:1px solid #334155;color:#64748b;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:13px">⤢</button>
          <button id="amod-close" style="background:transparent;border:1px solid #334155;color:#64748b;border-radius:4px;padding:2px 10px;cursor:pointer">✕</button>
        </div>
      </div>
      <!-- İstatistikler -->
      <div style="display:flex;gap:6px;padding:8px 14px;border-bottom:1px solid #1e293b;flex-shrink:0">
        <div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);border-radius:6px;padding:5px 8px;flex:1;text-align:center">
          <div style="color:#ef4444;font-size:16px;font-weight:700">${delSegs.length}</div><div style="color:#64748b;font-size:10px">Silinecek</div>
        </div>
        <div style="background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.25);border-radius:6px;padding:5px 8px;flex:1;text-align:center">
          <div style="color:#fbbf24;font-size:16px;font-weight:700">${attSegs.length}</div><div style="color:#64748b;font-size:10px">Azaltılacak</div>
        </div>
        <div style="background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.25);border-radius:6px;padding:5px 8px;flex:1;text-align:center">
          <div style="color:#22c55e;font-size:16px;font-weight:700">${totalDur.toFixed(1)}s</div><div style="color:#64748b;font-size:10px">Kazanılan</div>
        </div>
      </div>
      <!-- Önizleme waveform -->
      <div id="seg-preview-panel" style="display:none;padding:10px 14px;border-bottom:1px solid #1e293b;flex-shrink:0">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
          <span style="color:#38bdf8;font-size:10px;font-weight:600" id="seg-preview-label">▶ Önizleme</span>
          <span style="color:#64748b;font-size:9px">← Kırmızı sınırları mouse ile sürükle →</span>
        </div>
        <div style="position:relative;user-select:none">
          <canvas id="seg-preview-canvas" height="90" style="width:100%;border-radius:5px;display:block;background:#1a2234;cursor:default"></canvas>
          <div id="seg-preview-cursor" style="position:absolute;top:0;bottom:0;width:2px;background:rgba(56,189,248,0.8);left:0;pointer-events:none"></div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:9px;color:#475569" id="seg-preview-times"></div>
        <div style="display:flex;gap:6px;margin-top:6px">
          <button id="seg-play-btn" style="background:#1e293b;border:1px solid #334155;color:#94a3b8;border-radius:5px;padding:4px 14px;cursor:pointer;font-size:12px;flex:1">▶ Çal</button>
          <button id="seg-reset-btn" style="background:transparent;border:1px solid #334155;color:#64748b;border-radius:5px;padding:4px 10px;cursor:pointer;font-size:11px" title="AI sınırlarına sıfırla">↺ Sıfırla</button>
        </div>
      </div>
      <!-- Segment listesi -->
      <div style="padding:8px 14px;flex:1;overflow-y:auto">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <span style="color:#94a3b8;font-size:11px;font-weight:600">${allSegments.length} bölge</span>
          <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:11px;color:#64748b">
            <input type="checkbox" id="amod-all-cb" checked> Tümünü seç
          </label>
        </div>
        <div id="amod-seg-list">${segsHtml || '<div style="color:#64748b;text-align:center;padding:20px">Bölge bulunamadı</div>'}</div>
      </div>
      <!-- Uygula -->
      <div style="padding:10px 14px;border-top:1px solid #1e293b;flex-shrink:0">
        <button id="amod-apply" style="width:100%;padding:10px;background:#16a34a;border:1px solid #22c55e;color:#fff;border-radius:7px;cursor:pointer;font-size:13px;font-weight:700">⚙️ ${allSegments.length} bölgeyi uygula ve işle</button>
      </div>
    </div>`;

  document.body.appendChild(modal);

  // Genişlet / küçült
  let _expanded = false;
  modal.querySelector('#amod-expand').addEventListener('click', () => {
    _expanded = !_expanded;
    const box = modal.querySelector('#amod-box');
    box.style.maxWidth = _expanded ? '98vw' : '90vw';
    box.style.width = _expanded ? '98vw' : '90vw';
    box.style.maxHeight = _expanded ? '98vh' : '92vh';
    box.style.height = _expanded ? '98vh' : '92vh';
    modal.querySelector('#amod-expand').textContent = _expanded ? '⤡' : '⤢';
    // Canvas'ı yeniden çiz
    previewCanvas.height = _expanded ? 180 : 90;
  if (_activeSegIdx !== null) requestAnimationFrame(() => redrawPreview());
  });

  // Checkbox mantığı
  const allCb  = modal.querySelector('#amod-all-cb');
  const segCbs = () => [...modal.querySelectorAll('.aseg-cb')];

  function getChecked() {
    return segCbs().filter(cb=>cb.checked).map(cb => {
      const i = +cb.dataset.index;
      const orig = allSegments[i];
      return {...orig, start: _adj[i].start, end: _adj[i].end};
    });
  }
  function updateApplyBtn() {
    const n = getChecked().length;
    const btn = modal.querySelector('#amod-apply');
    btn.textContent = n ? `⚙️ ${n} bölgeyi uygula ve işle` : '— Seçili bölge yok —';
    btn.disabled = !n;
  }
  allCb.addEventListener('change', () => { segCbs().forEach(cb=>cb.checked=allCb.checked); updateApplyBtn(); });
  modal.querySelector('#amod-seg-list').addEventListener('change', e => {
    if (!e.target.classList.contains('aseg-cb')) return;
    allCb.checked = segCbs().every(c=>c.checked);
    updateApplyBtn();
  });

  // ── Preview + sürüklenebilir handle'lar ──────────────────────────────────
  let _previewSrc = null, _previewRaf = null, _previewStartCtxTime = 0;
  let _activeSegIdx = null, _regionStart = 0, _regionEnd = 0;
  let _dragHandle = null; // 'left' | 'right'
  const HANDLE_HIT = 10; // px

  const previewPanel  = modal.querySelector('#seg-preview-panel');
  const previewCanvas = modal.querySelector('#seg-preview-canvas');
  const previewCursor = modal.querySelector('#seg-preview-cursor');
  const previewLabel  = modal.querySelector('#seg-preview-label');
  const previewTimes  = modal.querySelector('#seg-preview-times');

  function redrawPreview() {
    if (_activeSegIdx === null) return;
    const seg = allSegments[_activeSegIdx];
    const adj = _adj[_activeSegIdx];
    const buf = state.audioBuffer;
    const ch  = buf.getChannelData(0);
    const W   = previewCanvas.offsetWidth || 500;
    previewCanvas.width = W;
    const H   = previewCanvas.height;
    const c   = previewCanvas.getContext('2d');
    const rDur = _regionEnd - _regionStart;
    const startSample = Math.floor(_regionStart * buf.sampleRate);
    const spp = Math.floor(rDur * buf.sampleRate) / W;

    // Arka plan
    c.fillStyle = '#0f1b2d'; c.fillRect(0,0,W,H);
    c.strokeStyle = 'rgba(255,255,255,0.04)'; c.lineWidth=1;
    c.beginPath(); c.moveTo(0,H/2); c.lineTo(W,H/2); c.stroke();

    const x1 = ((adj.start - _regionStart) / rDur) * W;
    const x2 = ((adj.end   - _regionStart) / rDur) * W;

    // Kırmızı arka plan (kesilecek bölge)
    c.fillStyle = 'rgba(239,68,68,0.13)'; c.fillRect(x1,0,x2-x1,H);

    // Waveform
    for (let x=0; x<W; x++) {
      const s = Math.floor(x*spp)+startSample, e = Math.floor((x+1)*spp)+startSample;
      let mn=0, mx=0;
      for (let i=s;i<e&&i<ch.length;i++){if(ch[i]<mn)mn=ch[i];if(ch[i]>mx)mx=ch[i];}
      const yH=H/2-mx*(H/2-2), yL=H/2-mn*(H/2-2);
      c.fillStyle = (x>=x1&&x<=x2) ? '#f87171' : '#38bdf8';
      c.fillRect(x,yH,1,Math.max(1,yL-yH));
    }

    // Handle çizgileri + tutma noktaları
    const drawHandle = (hx, label) => {
      c.strokeStyle='#ef4444'; c.lineWidth=2;
      c.beginPath(); c.moveTo(hx,0); c.lineTo(hx,H); c.stroke();
      // Üçgen tutma noktası
      c.fillStyle='#ef4444';
      c.beginPath(); c.moveTo(hx-6,0); c.lineTo(hx+6,0); c.lineTo(hx,10); c.closePath(); c.fill();
      c.beginPath(); c.moveTo(hx-6,H); c.lineTo(hx+6,H); c.lineTo(hx,H-10); c.closePath(); c.fill();
      if (x2-x1>40) { c.fillStyle='rgba(239,68,68,0.9)'; c.font='bold 9px monospace'; c.fillText(label, hx+3, 12); }
    };
    drawHandle(x1, '◀ BAŞLANGIÇ');
    drawHandle(x2, 'BİTİŞ ▶');

    // "KESİLECEK" etiketi ortada
    if (x2-x1>60) {
      c.fillStyle='rgba(239,68,68,0.7)'; c.font='bold 10px monospace';
      const lbl='KESİLECEK'; const lw=c.measureText(lbl).width;
      c.fillText(lbl, x1+(x2-x1)/2-lw/2, H/2+4);
    }

    updatePreviewTimes();
  }

  function updatePreviewTimes() {
    if (_activeSegIdx === null) return;
    const adj = _adj[_activeSegIdx];
    const dur = (adj.end-adj.start).toFixed(2);
    previewTimes.innerHTML = `<span style="color:#64748b">${_regionStart.toFixed(1)}s</span><span style="color:#ef4444;font-weight:600">${adj.start.toFixed(2)}s → ${adj.end.toFixed(2)}s · ${dur}s kesilecek</span><span style="color:#64748b">${_regionEnd.toFixed(1)}s</span>`;
    // Satır etiketini güncelle
    const timesEl = modal.querySelector(`.aseg-times[data-index="${_activeSegIdx}"]`);
    if (timesEl) timesEl.innerHTML = `${adj.start.toFixed(2)}s–${adj.end.toFixed(2)}s · <strong style="color:#94a3b8">${dur}s</strong>`;
  }

  function canvasXtoTime(x) {
    const rect = previewCanvas.getBoundingClientRect();
    const px = (x - rect.left) * (previewCanvas.width / rect.width);
    return _regionStart + (px / previewCanvas.width) * (_regionEnd - _regionStart);
  }

  function hitTest(clientX) {
    if (_activeSegIdx === null) return null;
    const adj = _adj[_activeSegIdx];
    const W = previewCanvas.width;
    const rDur = _regionEnd - _regionStart;
    const x1 = ((adj.start - _regionStart) / rDur) * W;
    const x2 = ((adj.end   - _regionStart) / rDur) * W;
    const rect = previewCanvas.getBoundingClientRect();
    const px = (clientX - rect.left) * (W / rect.width);
    if (Math.abs(px-x1) <= HANDLE_HIT) return 'left';
    if (Math.abs(px-x2) <= HANDLE_HIT) return 'right';
    return null;
  }

  previewCanvas.addEventListener('mousemove', e => {
    if (_dragHandle) {
      const t = canvasXtoTime(e.clientX);
      const adj = _adj[_activeSegIdx];
      if (_dragHandle==='left')  adj.start = Math.min(Math.max(_regionStart, t), adj.end-0.05);
      else                        adj.end   = Math.max(Math.min(_regionEnd, t), adj.start+0.05);
      redrawPreview();
      return;
    }
    const hit = hitTest(e.clientX);
    previewCanvas.style.cursor = hit ? 'ew-resize' : 'default';
  });

  previewCanvas.addEventListener('mousedown', e => {
    const hit = hitTest(e.clientX);
    if (hit) { _dragHandle = hit; stopPreview(); e.preventDefault(); }
  });

  window.addEventListener('mouseup', () => { _dragHandle = null; });

  function animateCursor() {
    const W = previewCanvas.width || previewCanvas.offsetWidth;
    const elapsed = getCtx().currentTime - _previewStartCtxTime;
    const pct = Math.min(elapsed / (_regionEnd - _regionStart), 1);
    previewCursor.style.left = (pct * W) + 'px';
    if (pct < 1 && _previewSrc) _previewRaf = requestAnimationFrame(animateCursor);
  }

  function stopPreview() {
    if (_previewRaf) { cancelAnimationFrame(_previewRaf); _previewRaf=null; }
    if (_previewSrc) { try{_previewSrc.stop();}catch(e){} _previewSrc=null; }
    previewCursor.style.left='0px';
    const pb = modal.querySelector('#seg-play-btn');
    if (pb) { pb.textContent='▶ Çal'; pb.style.color='#94a3b8'; pb.style.borderColor='#334155'; }
    modal.querySelectorAll('.seg-preview-btn').forEach(b=>{b.textContent='▶';b.style.color='#94a3b8';});
  }

  function startPlay() {
    stopPreview();
    if (!state.audioBuffer || _activeSegIdx===null) return;
    const buf=state.audioBuffer, ctx=getCtx();
    const src=ctx.createBufferSource();
    src.buffer=buf; src.connect(ctx.destination);
    src.start(0, _regionStart, _regionEnd-_regionStart);
    _previewSrc=src; _previewStartCtxTime=ctx.currentTime;
    const pb=modal.querySelector('#seg-play-btn');
    if(pb){pb.textContent='■ Durdur';pb.style.color='#38bdf8';pb.style.borderColor='#38bdf8';}
    animateCursor();
    src.onended = () => { if(_previewSrc===src) stopPreview(); };
  }

  modal.querySelector('#seg-preview-panel').addEventListener('click', e => {
    if (e.target.id==='seg-play-btn') {
      if (_previewSrc) stopPreview(); else startPlay();
    } else if (e.target.id==='seg-reset-btn') {
      if (_activeSegIdx===null) return;
      const orig=allSegments[_activeSegIdx];
      _adj[_activeSegIdx]={start:orig.start, end:orig.end};
      redrawPreview();
    }
  });

  modal.querySelector('#amod-seg-list').addEventListener('click', e => {
    // ── Bölge sil (✕) ───────────────────────────────────────────────────────
    const delBtn = e.target.closest('.aseg-del-btn');
    if (delBtn) {
      const row = delBtn.closest('.aseg-row');
      if (row) {
        row.style.transition = 'opacity 0.2s';
        row.style.opacity = '0';
        setTimeout(() => row.remove(), 200);
        addLog('info', 'Bölge listeden kaldırıldı');
      }
      return;
    }

    const btn = e.target.closest('.seg-preview-btn');
    if (!btn) return;
    const idx = +btn.dataset.index;
    const seg = allSegments[idx];
    if (!state.audioBuffer) return;

    // Aynı segmente tekrar basılınca play/stop
    if (_activeSegIdx===idx && previewPanel.style.display!=='none') {
      if (_previewSrc) { stopPreview(); return; }
      startPlay(); return;
    }

    stopPreview();
    _activeSegIdx = idx;
    _regionStart  = Math.max(0, seg.start-5);
    _regionEnd    = Math.min(state.audioBuffer.duration, seg.end+5);

    const actLabel  = CMD_ACTION_TR[seg.action?.toLowerCase()] || seg.action?.toUpperCase();
    const typeLabel = TYPE_TR[seg.type?.toLowerCase()] || seg.type || '';
    previewLabel.innerHTML = `<span style="color:#ef4444">▶</span> ${actLabel}${typeLabel?' · '+typeLabel:''} — sınırları sürükleyerek ayarla`;
    previewPanel.style.display='block';
    previewPanel.scrollIntoView({behavior:'smooth',block:'nearest'});

    requestAnimationFrame(() => { redrawPreview(); startPlay(); });
  });

  modal.querySelector('#amod-close').onclick = () => { stopPreview(); modal.remove(); };

  modal.querySelector('#amod-apply').onclick = async () => {
    const chosen = getChecked();
    if (!chosen.length) return;
    stopPreview(); modal.remove();
    await processAndFinish(chosen, normalizeLUFS);
  };
}

async function processAndFinish(segments, normalizeLUFS) {
  btnCleanDownload.disabled = true;
  btnCleanDownload.textContent = '⏳ FFmpeg işliyor...';
  setStatus('Ses işleniyor...', 'busy');

  try {
    const processedBlob = await uploadAndProcess(segments, normalizeLUFS);
    const cd = processedBlob._cd || '';
    const nm = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i);
    const dlName = nm ? decodeURIComponent(nm[1]) : 'temizlendi.mp3';

    btnCleanDownload.textContent = '⚡ Temizle ve İndir';
    btnCleanDownload.disabled = false;
    setStatus('Tamamlandı', 'active');
    showComparison(processedBlob, segments, dlName);
  } catch(err) {
    addLog('error', 'FFmpeg hatası: ' + err.message);
    setStatus('Hata: ' + err.message, 'idle');
    btnCleanDownload.textContent = '⚡ Temizle ve İndir';
    btnCleanDownload.disabled = false;
    alert('Hata: ' + err.message);
  }
}

// ── Render Analysis ────────────────────────────────────────────────────────────
function renderAnalysis(a) {
  analysisPlPh.style.display='none';
  analysisCards.style.display='block';
  analysisCards.innerHTML='';

  const meta = a.metadata || {};
  const sum  = a.summary  || {};
  const q    = (meta.overall_quality || sum.overall_quality || 'good').toLowerCase();
  const qClass = q==='excellent'||q==='good' ? 'q-good' : q==='fair' ? 'q-fair' : 'q-poor';
  const QUALITY_TR = {excellent:'MÜKEMMEL', good:'İYİ', fair:'ORTA', poor:'KÖTÜ', bad:'KÖTÜ'};
  const qDisplay = QUALITY_TR[q] || q.toUpperCase();
  const score  = meta.quality_score ?? sum.quality_score;
  const durStr = meta.duration_total || '';

  // ── Summary card ──
  analysisCards.innerHTML+=`
  <div class="a-card">
    <div class="a-card-hdr">📊 Özet</div>
    <div class="stat-row">
      ${durStr?`<div class="stat-cell"><span class="stat-lbl">Süre</span><span class="stat-val">${durStr}</span></div>`:''}
      <div class="stat-cell"><span class="stat-lbl">Kalite</span><span class="stat-val ${qClass}">${qDisplay}</span></div>
      ${score!=null?`<div class="stat-cell"><span class="stat-lbl">Puan</span><span class="stat-val">${Math.round(score)}/100</span></div>`:''}
      <div class="stat-cell"><span class="stat-lbl">Konuşma</span><span class="stat-val">${Math.round(sum.speech_percentage||0)}%</span></div>
      <div class="stat-cell"><span class="stat-lbl">Gürültü</span><span class="stat-val">${Math.round(sum.noise_percentage||0)}%</span></div>
      <div class="stat-cell"><span class="stat-lbl">Olaylar</span><span class="stat-val">${sum.total_noise_events??a.noise_events?.length??0}</span></div>
    </div>
    ${sum.priority_actions?.length?`<div style="padding:0 8px 8px;font-size:10px;color:var(--text-dim)">${
      sum.priority_actions.map(p=>`<div>• ${p}</div>`).join('')
    }</div>`:''}
  </div>`;

  // ── Environment / Metadata card ──
  if (meta.environment || meta.microphone_type || meta.rt60_estimate_ms!=null) {
    analysisCards.innerHTML+=`
    <div class="a-card">
      <div class="a-card-hdr">🏠 Kayıt Ortamı</div>
      <div style="padding:8px;display:flex;flex-direction:column;gap:4px;font-size:11px">
        ${meta.environment?`<div><span style="color:var(--text-dim)">Ortam:</span> <strong>${meta.environment}</strong></div>`:''}
        ${meta.microphone_type?`<div><span style="color:var(--text-dim)">Mikrofon:</span> <strong>${meta.microphone_type}${meta.microphone_quality?' · '+meta.microphone_quality:''}</strong></div>`:''}
        ${meta.rt60_estimate_ms!=null?`<div><span style="color:var(--text-dim)">RT60 (yankı):</span> <strong>${meta.rt60_estimate_ms}ms</strong></div>`:''}
        ${meta.clipping_detected!=null?`<div><span style="color:${meta.clipping_detected?'var(--red)':'var(--green)'}">Kırpma: <strong>${meta.clipping_detected?`VAR · ${meta.clipping_duration_ms||0}ms (${meta.clipping_severity||''})`:'Yok'}</strong></span></div>`:''}
      </div>
    </div>`;
  }

  // ── Speakers card ──
  if (a.speakers?.length) {
    a.speakers.forEach(sp => {
      const pitch = sp.pitch_range
        ? `${sp.pitch_range.min}–${sp.pitch_range.max}${sp.pitch_range.unit||'Hz'}`
        : null;
      analysisCards.innerHTML+=`
      <div class="a-card">
        <div class="a-card-hdr">🎙 ${sp.id||'Konuşmacı'}</div>
        <div style="padding:8px;display:flex;flex-direction:column;gap:4px;font-size:11px">
          ${pitch?`<div><span style="color:var(--text-dim)">Perde:</span> <strong>${pitch}</strong></div>`:''}
          ${sp.speech_rate?`<div><span style="color:var(--text-dim)">Konuşma hızı:</span> <strong>${sp.speech_rate} k/dk</strong></div>`:''}
          ${sp.silence_ratio!=null?`<div><span style="color:var(--text-dim)">Sessizlik oranı:</span> <strong>${Math.round(sp.silence_ratio)}%</strong></div>`:''}
          ${sp.emotional_tone?`<div><span style="color:var(--text-dim)">Ton:</span> <strong>${sp.emotional_tone}${sp.pitch_variation?' · '+sp.pitch_variation:''}</strong></div>`:''}
          ${sp.intonation_notes?`<div style="color:var(--text-dim);font-size:9px;margin-top:2px">${sp.intonation_notes}</div>`:''}
        </div>
      </div>`;
    });
  }

  // ── Layers card ──
  if (a.layers?.length) {
    const durSec = state.audioBuffer?.duration || 1;
    analysisCards.innerHTML+=`<div class="a-card"><div class="a-card-hdr">🎚 Katmanlar</div><div class="layer-bar-list" id="layer-bars"></div></div>`;
    const lb=$('layer-bars');
    a.layers.forEach(layer=>{
      const cfg=LAYERS.find(l=>l.id===layer.id)||{};
      const c=layer.color||cfg.color||'#888';
      const secs=layer.segments?.reduce((s,sg)=>s+(sg.end-sg.start),0)||0;
      const pct=Math.min(100,Math.round(secs/durSec*100));
      const item=document.createElement('div');
      item.className='layer-bar-item';
      item.innerHTML=`
        <div class="lb-dot" style="background:${c}"></div>
        <span class="lb-name">${layer.name||layer.id}</span>
        <div class="lb-bar-wrap"><div class="lb-bar" style="background:${c};width:${pct}%"></div></div>
        <span class="lb-pct">${pct}%</span>`;
      lb.appendChild(item);
    });
  }

  // ── Noise Map mini chart ──
  if (a.noise_map?.values_dbfs?.length) {
    const vals = a.noise_map.values_dbfs;
    const minDb=-60, maxDb=0;
    const bars = vals.map(v=>{
      const pct=Math.max(0,Math.min(100,Math.round((v-minDb)/(maxDb-minDb)*100)));
      const col = pct>75?'#ef5350':pct>40?'#ffa726':'#66bb6a';
      return `<div style="flex:1;height:${pct}%;background:${col};min-height:1px;border-radius:1px 1px 0 0" title="${v}dBFS"></div>`;
    }).join('');
    analysisCards.innerHTML+=`
    <div class="a-card">
      <div class="a-card-hdr">📈 Gürültü Haritası (saniye bazlı)</div>
      <div style="padding:6px 8px">
        <div style="display:flex;align-items:flex-end;height:40px;gap:1px;background:var(--bg-dark);border-radius:3px;padding:3px">${bars}</div>
        <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text-dim);margin-top:2px">
          <span>0s</span>
          <span>${a.noise_map.pattern||''} · ${a.noise_map.source_mobility||''}</span>
          <span>${vals.length}s</span>
        </div>
      </div>
    </div>`;
  }

  // ── Auto-Correction card ──
  const cor = a.corrections || a.auto_correction;
  if (cor) {
    const comp = cor.compression || {};
    analysisCards.innerHTML+=`
    <div class="a-card">
      <div class="a-card-hdr">🎛 Düzeltmeler</div>
      <div style="padding:8px;display:flex;flex-direction:column;gap:4px;font-size:11px">
        ${cor.normalize_target_db!=null?`<div><span style="color:var(--text-dim)">Normalize hedefi:</span> <strong>${cor.normalize_target_db} dBFS</strong></div>`:''}
        ${comp.threshold!=null?`<div><span style="color:var(--text-dim)">Sıkıştırma:</span> <strong>${comp.threshold}dB · ${comp.ratio||'4:1'} · att ${comp.attack_ms||10}ms · rel ${comp.release_ms||100}ms</strong></div>`:''}
        ${cor.reverb_detected!=null?`<div><span style="color:${cor.reverb_detected?'var(--yellow)':'var(--green)'}">Yankı: <strong>${cor.reverb_detected?`${cor.reverb_severity||''} · ${cor.reverb_amount_ms||0}ms`:'Yok'}</strong></span></div>`:''}
        ${cor.eq_suggestions?.length?`<div style="margin-top:4px;color:var(--text-dim)">EQ önerileri:</div>${cor.eq_suggestions.map(e=>`<div style="padding-left:8px">• ${e}</div>`).join('')}`:''}
      </div>
    </div>`;
  }

  // ── Cut List card ──
  if (a.cut_list?.length) {
    const rows = a.cut_list.slice(0,8).map(c=>`
      <div style="display:flex;gap:6px;align-items:center;padding:3px 0;border-bottom:1px solid var(--border);font-size:10px">
        <span style="color:var(--red);font-weight:bold;min-width:60px">${c.start||''}</span>
        <span style="color:var(--text-dim)">→</span>
        <span style="color:var(--red);min-width:60px">${c.end||''}</span>
        <span style="color:var(--accent);font-size:9px">${c.transition||'hard'}</span>
        <span style="color:var(--text-dim);font-size:9px;flex:1">${c.reason||''}</span>
      </div>`).join('');
    const more = a.cut_list.length>8?`<div style="font-size:9px;color:var(--text-dim);padding-top:4px">… ${a.cut_list.length-8} kesim daha</div>`:'';
    analysisCards.innerHTML+=`
    <div class="a-card">
      <div class="a-card-hdr">✂ Kesim Listesi (${a.cut_list.length})</div>
      <div style="padding:4px 8px 8px">${rows}${more}</div>
    </div>`;
  }

  // ── Micro-Transitions card ──
  if (a.micro_transitions) {
    const mt = a.micro_transitions;
    const breathCount = mt.breath_intakes?.length||0;
    const fillersCount = mt.fillers?.length||0;
    const mouthCount = mt.mouth_sounds?.length||0;
    const fillerTypes = mt.fillers?.reduce((acc,f)=>{acc[f.type]=(acc[f.type]||0)+1;return acc},{});
    analysisCards.innerHTML+=`
    <div class="a-card">
      <div class="a-card-hdr">🔬 Mikro Geçişler</div>
      <div style="padding:8px;display:flex;flex-direction:column;gap:4px;font-size:11px">
        <div><span style="color:var(--text-dim)">Nefes alışlar:</span> <strong>${breathCount}</strong></div>
        ${mouthCount?`<div><span style="color:var(--text-dim)">Ağız sesleri:</span> <strong>${mouthCount}</strong></div>`:''}
        ${fillersCount?`<div><span style="color:var(--text-dim)">Dolgu sözcükler:</span> <strong>${fillersCount}</strong> — ${Object.entries(fillerTypes||{}).map(([k,v])=>`"${k}"×${v}`).join(', ')}</div>`:''}
        ${mt.repeated_phrases?.length?`<div><span style="color:var(--text-dim)">Tekrarlanan ifadeler:</span> <strong>${mt.repeated_phrases.length}</strong> — ${mt.repeated_phrases.map(r=>`"${r.phrase}" ×${r.occurrences?.length||0}`).join(', ')}</div>`:''}
      </div>
    </div>`;
  }

  // ── Adaptive Thresholds card ──
  if (a.adaptive_thresholds) {
    const at = a.adaptive_thresholds;
    analysisCards.innerHTML+=`
    <div class="a-card">
      <div class="a-card-hdr">⚡ Adaptif Eşikler</div>
      <div style="padding:8px;display:flex;flex-direction:column;gap:4px;font-size:11px">
        ${at.noise_floor_db!=null?`<div><span style="color:var(--text-dim)">Gürültü tabanı:</span> <strong>${at.noise_floor_db} dBFS</strong></div>`:''}
        ${at.dynamic_silence_threshold!=null?`<div><span style="color:var(--text-dim)">Sessizlik eşiği:</span> <strong>${at.dynamic_silence_threshold}</strong></div>`:''}
        ${at.speaker_reference_min_db!=null?`<div><span style="color:var(--text-dim)">Konuşmacı min ref:</span> <strong>${at.speaker_reference_min_db} dBFS</strong></div>`:''}
        ${at.level_drift_detected?`<div style="color:var(--yellow)">⚠ Seviye kayması: ${at.level_drift_description||'tespit edildi'}</div>`:'<div style="color:var(--green)">✓ Seviye kayması yok</div>'}
        ${at.environment_changes?.length?`<div style="color:var(--yellow)">⚠ Ortam değişimi: ${at.environment_changes.length} tespit edildi</div>`:''}
      </div>
    </div>`;
  }

  // ── Frequency Bands card ──
  if (a.frequency_bands) {
    const fb = a.frequency_bands;
    const bands = ['sub_bass','bass','low_mid','mid','upper_mid','presence','high'];
    const bRows = bands.filter(b=>fb[b]).map(b=>{
      const d=fb[b];
      const pct=Math.max(0,Math.min(100,Math.round((d.noise_db+70)/70*100)));
      const col=pct>70?'#ef5350':pct>40?'#ffa726':'#66bb6a';
      return `<div style="display:flex;align-items:center;gap:6px;font-size:10px;padding:2px 0">
        <span style="min-width:72px;color:var(--text-dim)">${d.range||b}</span>
        <div style="flex:1;height:6px;background:var(--bg-dark);border-radius:3px">
          <div style="height:100%;width:${pct}%;background:${col};border-radius:3px"></div>
        </div>
        <span style="min-width:36px;text-align:right;color:${d.noise_db<-50?'var(--green)':'var(--yellow)'}">${d.noise_db}dB</span>
        ${d.speaker_presence?'<span style="color:#4fc3f7;font-size:9px">🎙</span>':''}
      </div>`;
    }).join('');
    analysisCards.innerHTML+=`
    <div class="a-card">
      <div class="a-card-hdr">📻 Frekans Bantları</div>
      <div style="padding:6px 8px">${bRows}</div>
    </div>`;
  }

  // ── Fixed Frequency Noise ──
  if (a.fixed_frequency_noise?.length) {
    const rows = a.fixed_frequency_noise.map(n=>
      `<div style="font-size:10px;padding:2px 0"><span style="color:var(--red)">${n.frequency||n.hz||'?'}Hz</span> — ${n.type||n.description||''} <span style="color:var(--text-dim)">${n.severity||''}</span></div>`
    ).join('');
    analysisCards.innerHTML+=`
    <div class="a-card">
      <div class="a-card-hdr">🔊 Sabit Frekanslı Gürültü</div>
      <div style="padding:6px 8px">${rows}</div>
    </div>`;
  }

  // ── Speaker Overlaps ──
  if (a.speaker_overlaps?.length) {
    const rows = a.speaker_overlaps.map(o=>
      `<div style="font-size:10px;padding:2px 0;color:var(--yellow)">${o.start||o.start_sec||'?'}s — ${o.end||o.end_sec||'?'}s: ${o.dominant||''} baskın${o.description?' · '+o.description:''}</div>`
    ).join('');
    analysisCards.innerHTML+=`
    <div class="a-card">
      <div class="a-card-hdr">👥 Konuşmacı Örtüşmeleri (${a.speaker_overlaps.length})</div>
      <div style="padding:6px 8px">${rows}</div>
    </div>`;
  }

  // ── Warnings card ──
  if (a.warnings?.length) {
    const WARN_ICONS = {LOW_CONFIDENCE:'⚠',OVERLAP:'⚠',CLIPPING:'🔴',SHORT_SEGMENT:'⚠',INTEGRITY:'⚠',IRREVERSIBLE:'🔴'};
    const rows = a.warnings.map(w=>{
      const code = typeof w==='string'?w:(w.code||w.type||w);
      const msg  = typeof w==='object'?(w.message||w.description||''):code;
      const icon = WARN_ICONS[code]||'⚠';
      return `<div style="font-size:10px;padding:2px 0;color:var(--yellow)">${icon} <strong>${code}</strong>${msg&&msg!==code?' — '+msg:''}</div>`;
    }).join('');
    analysisCards.innerHTML+=`
    <div class="a-card" style="border-color:rgba(255,167,38,0.4)">
      <div class="a-card-hdr" style="color:var(--yellow)">⚠ Uyarılar (${a.warnings.length})</div>
      <div style="padding:6px 8px">${rows}</div>
    </div>`;
  }

  // ── User Confirmations Required ──
  if (a.user_confirmations_required?.length) {
    const rows = a.user_confirmations_required.map(c=>{
      const txt = typeof c==='string'?c:(c.action||c.description||JSON.stringify(c));
      return `<div style="font-size:10px;padding:3px 6px;margin:2px 0;background:rgba(239,83,80,0.1);border-left:2px solid var(--red);border-radius:2px">${txt}</div>`;
    }).join('');
    analysisCards.innerHTML+=`
    <div class="a-card" style="border-color:rgba(239,83,80,0.4)">
      <div class="a-card-hdr" style="color:var(--red)">👆 Onayınız Gerekli (${a.user_confirmations_required.length})</div>
      <div style="padding:6px 8px">${rows}</div>
    </div>`;
  }

  // ── Contextual Rules Applied ──
  if (a.contextual_rules_applied?.length) {
    const rows = a.contextual_rules_applied.map(r=>{
      const label = typeof r==='string'?r:(r.rule||r.name||'');
      const desc  = typeof r==='object'?(r.description||r.result||''):'';
      return `<div style="font-size:10px;padding:2px 0"><span style="color:var(--accent)">${label}</span>${desc?' — '+desc:''}</div>`;
    }).join('');
    analysisCards.innerHTML+=`
    <div class="a-card">
      <div class="a-card-hdr">📋 Uygulanan Kurallar (${a.contextual_rules_applied.length})</div>
      <div style="padding:6px 8px">${rows}</div>
    </div>`;
  }

  // ── Recommended Exports ──
  if (a.recommended_exports?.length) {
    const EXPORT_LABELS = {
      SPEAKER_ONLY:'🎙 Sadece Konuşmacı', SPEAKER_AMBIENT:'🎙+🌿 Konuşmacı + Ortam',
      LAYERED:'📂 Katmanlı Dışa Aktarım', PROJECT_FILE:'🎛 Proje Dosyası',
      REPORT:'📄 Rapor Dosyası', BEFORE_AFTER:'↔ Önce/Sonra',
    };
    const pills = a.recommended_exports.map(e=>
      `<span style="display:inline-block;padding:2px 8px;margin:2px;background:rgba(79,195,247,0.15);border:1px solid rgba(79,195,247,0.4);border-radius:10px;font-size:10px;color:#4fc3f7">${EXPORT_LABELS[e]||e}</span>`
    ).join('');
    analysisCards.innerHTML+=`
    <div class="a-card">
      <div class="a-card-hdr">📤 Önerilen Dışa Aktarımlar</div>
      <div style="padding:6px 8px">${pills}</div>
    </div>`;
  }

  // ── Calibration card ──
  if (a.calibration) {
    const cal = a.calibration;
    const snr = cal.snr_db??0;
    const snrCol = snr>=20?'var(--green)':snr>=10?'var(--yellow)':'var(--red)';
    const CONF_TR = {high:'YÜKSEK', medium:'ORTA', low:'DÜŞÜK'};
    const confCol = cal.confidence_level==='high'?'var(--green)':cal.confidence_level==='medium'?'var(--yellow)':'var(--red)';
    analysisCards.innerHTML+=`
    <div class="a-card">
      <div class="a-card-hdr">🎯 Kalibrasyon</div>
      <div style="padding:8px;display:flex;flex-direction:column;gap:4px;font-size:11px">
        <div><span style="color:var(--text-dim)">Gürültü tabanı:</span> <strong>${cal.noise_floor_db} dBFS</strong></div>
        <div><span style="color:var(--text-dim)">Konuşma tabanı:</span> <strong>${cal.speech_floor_db} dBFS</strong></div>
        <div><span style="color:var(--text-dim)">Dinamik eşik:</span> <strong>${cal.dynamic_threshold_db} dBFS</strong></div>
        <div><span style="color:var(--text-dim)">SNR:</span> <strong style="color:${snrCol}">${snr} dB</strong></div>
        <div><span style="color:var(--text-dim)">Güven:</span> <strong style="color:${confCol}">${CONF_TR[cal.confidence_level]||(cal.confidence_level||'').toUpperCase()}</strong></div>
        ${cal.reference_segment?.start?`<div style="color:var(--text-dim)">Referans: ${cal.reference_segment.start} → ${cal.reference_segment.end}</div>`:''}
      </div>
    </div>`;
  }

  // ── Scenario card ──
  if (a.scenario_detected) {
    const SCENARIO_ICONS = {podcast:'🎙',interview:'🎤',lecture:'📚',presentation:'📊',meeting:'💻',audiobook:'📖',field:'🌍',music:'🎵',default:'🎧'};
    const SCENARIO_TR = {podcast:'Podcast', interview:'Röportaj', lecture:'Ders', presentation:'Sunum', meeting:'Toplantı', audiobook:'Sesli Kitap', field:'Saha Kaydı', music:'Müzik'};
    const scen = a.scenario_detected.toLowerCase();
    const icon = SCENARIO_ICONS[scen] || SCENARIO_ICONS.default;
    const scenDisplay = SCENARIO_TR[scen] || a.scenario_detected.toUpperCase();
    analysisCards.innerHTML+=`
    <div class="a-card">
      <div class="a-card-hdr">🎬 Tespit Edilen Senaryo</div>
      <div style="padding:8px;font-size:11px">
        <div style="font-size:16px;margin-bottom:4px">${icon} <strong>${scenDisplay}</strong></div>
        ${a.scenario_notes?`<div style="color:var(--text-dim);font-size:10px">${a.scenario_notes}</div>`:''}
      </div>
    </div>`;
  }

  // ── Anomalies card ──
  if (a.anomalies?.length) {
    const SEV_COL = {info:'var(--text-dim)',warning:'var(--yellow)',error:'var(--red)',critical:'#ff1744'};
    const rows = a.anomalies.map(an=>{
      const col = SEV_COL[an.severity]||'var(--text-dim)';
      return `<div style="padding:4px 6px;margin:2px 0;border-left:2px solid ${col};font-size:10px">
        <div style="color:${col};font-weight:bold">${an.type||''} <span style="font-weight:normal;opacity:.7">${an.timestamp||''}</span></div>
        <div style="color:var(--text-dim)">${an.description||''}</div>
        ${an.fix_suggestion?`<div style="color:var(--accent);font-size:9px">→ ${an.fix_suggestion}${an.auto_fixable?' (auto-fixable)':''}</div>`:''}
      </div>`;
    }).join('');
    analysisCards.innerHTML+=`
    <div class="a-card" style="border-color:rgba(239,83,80,0.4)">
      <div class="a-card-hdr" style="color:var(--red)">🔴 Anomaliler (${a.anomalies.length})</div>
      <div style="padding:4px 6px 8px">${rows}</div>
    </div>`;
  }

  // ── QA Results card ──
  if (a.qa_results) {
    const qa = a.qa_results;
    const QA_TR = {passed:'GEÇTİ', warning:'UYARI', failed:'BAŞARISIZ'};
    const overallCol = a.overall_qa==='passed'?'var(--green)':a.overall_qa==='warning'?'var(--yellow)':'var(--red)';
    const tests = [
      {key:'speaker_integrity',   label:'Konuşmacı Bütünlüğü', val: r=>r.score!=null?`${Math.round(r.score*100)}% korelasyon`:''},
      {key:'noise_reduction',     label:'Gürültü Azaltma',     val: r=>r.improvement_db!=null?`+${r.improvement_db}dB SNR`:''},
      {key:'artifact_check',      label:'Bozukluk Kontrolü',   val: r=>r.artifacts_found!=null?`${r.artifacts_found} bulundu`:''},
      {key:'timeline_check',      label:'Zaman Çizelgesi',     val: r=>r.gaps_found!=null?`${r.gaps_found} boşluk`:''},
      {key:'lufs_check',          label:'LUFS',                val: r=>r.achieved_lufs!=null?`${r.achieved_lufs} LUFS`:''},
    ];
    const rows = tests.filter(t=>qa[t.key]).map(t=>{
      const r=qa[t.key];
      const pass=r.passed;
      return `<div style="display:flex;align-items:center;gap:6px;font-size:10px;padding:2px 0">
        <span style="color:${pass?'var(--green)':'var(--red)'}">${pass?'✓':'✗'}</span>
        <span style="flex:1">${t.label}</span>
        <span style="color:var(--text-dim)">${t.val(r)}</span>
      </div>`;
    }).join('');
    analysisCards.innerHTML+=`
    <div class="a-card" style="border-color:${overallCol}40">
      <div class="a-card-hdr" style="color:${overallCol}">✅ KG Sonuçları — ${QA_TR[a.overall_qa]||(a.overall_qa||'').toUpperCase()}</div>
      <div style="padding:6px 8px">${rows}
        ${a.ready_for_export!=null?`<div style="margin-top:6px;padding:4px 6px;background:${a.ready_for_export?'rgba(102,187,106,0.15)':'rgba(239,83,80,0.1)'};border-radius:3px;font-size:10px;color:${a.ready_for_export?'var(--green)':'var(--red)'}">
          ${a.ready_for_export?'✓ Dışa aktarmaya hazır':'⚠ Hazır değil — inceleme gerekli'}
        </div>`:''}
      </div>
    </div>`;
  }

  // ── Delivery Summary card ──
  if (a.delivery_summary) {
    const ds = a.delivery_summary;
    const OUTPUT_LABELS = {
      cleaned_audio:'🎵 Temizlenmiş ses', layer_files:'📂 Katman dosyaları (5)',
      json_report:'📄 JSON raporu', srt_subtitles:'💬 SRT altyazıları',
      html_report:'🌐 HTML raporu', history_log:'📋 Geçmiş logu',
    };
    const pills = (ds.available_outputs||[]).map(o=>
      `<span style="display:inline-block;padding:2px 7px;margin:2px;background:rgba(102,187,106,0.12);border:1px solid rgba(102,187,106,0.35);border-radius:10px;font-size:9px;color:var(--green)">${OUTPUT_LABELS[o]||o}</span>`
    ).join('');
    analysisCards.innerHTML+=`
    <div class="a-card" style="border-color:rgba(102,187,106,0.4)">
      <div class="a-card-hdr" style="color:var(--green)">📦 Teslimat Özeti</div>
      <div style="padding:8px;font-size:11px">
        ${ds.snr_improvement_db!=null?`<div><span style="color:var(--text-dim)">SNR iyileştirmesi:</span> <strong style="color:var(--green)">+${ds.snr_improvement_db} dB</strong></div>`:''}
        ${ds.events_cleaned!=null?`<div><span style="color:var(--text-dim)">Temizlenen olaylar:</span> <strong>${ds.events_cleaned}</strong></div>`:''}
        <div style="margin-top:6px">${pills}</div>
        ${ds.confirmation_required?`<div style="margin-top:8px;padding:6px 8px;background:rgba(239,83,80,0.1);border:1px solid rgba(239,83,80,0.4);border-radius:4px;font-size:10px;color:var(--red)">
          ⚠ <strong>Dışa aktarmadan önce onayınız gerekli</strong>
        </div>`:''}
      </div>
    </div>`;
  }

  // ── Speaker Verification card ──
  if (a.speaker_verification) {
    const sv = a.speaker_verification;
    const idConf = Math.round((sv.identity_confidence||0)*100);
    const conConf = Math.round((sv.consistency_score||0)*100);
    const confCol = idConf>=80?'var(--green)':idConf>=60?'var(--yellow)':'var(--red)';
    analysisCards.innerHTML+=`
    <div class="a-card">
      <div class="a-card-hdr">🔐 Konuşmacı Doğrulama</div>
      <div style="padding:8px;display:flex;flex-direction:column;gap:4px;font-size:11px">
        <div><span style="color:var(--text-dim)">Konuşmacı sayısı:</span> <strong>${sv.speaker_count||1}</strong></div>
        <div><span style="color:var(--text-dim)">Kimlik güveni:</span> <strong style="color:${confCol}">${idConf}%</strong></div>
        <div><span style="color:var(--text-dim)">Tutarlılık:</span> <strong style="color:${conConf>=80?'var(--green)':'var(--yellow)'}">${conConf}%</strong></div>
        ${sv.voice_changes_detected?.length?`<div style="color:var(--yellow)">⚠ Ses değişimleri: ${sv.voice_changes_detected.join(', ')}</div>`:'<div style="color:var(--green)">✓ Ses tutarlı</div>'}
        ${sv.suspicious_segments?.length?`<div style="color:var(--red)">🔴 ${sv.suspicious_segments.length} şüpheli segment</div>`:''}
      </div>
    </div>`;
  }

  // ── Prosody card ──
  if (a.prosody) {
    const pr = a.prosody;
    const mono = pr.monotony_score??50;
    const monoCol = mono>=70?'var(--green)':mono>=40?'var(--yellow)':'var(--text-dim)';
    analysisCards.innerHTML+=`
    <div class="a-card">
      <div class="a-card-hdr">🎵 Prozodi Analizi</div>
      <div style="padding:8px;display:flex;flex-direction:column;gap:4px;font-size:11px">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="color:var(--text-dim)">Dinamizm:</span>
          <div style="flex:1;height:6px;background:var(--bg-dark);border-radius:3px">
            <div style="height:100%;width:${mono}%;background:${monoCol};border-radius:3px"></div>
          </div>
          <strong style="color:${monoCol}">${mono}/100</strong>
        </div>
        ${pr.rhythm?`<div><span style="color:var(--text-dim)">Ritim:</span> <strong>${pr.rhythm}</strong></div>`:''}
        ${pr.stress_pattern?`<div><span style="color:var(--text-dim)">Vurgu:</span> <strong>${pr.stress_pattern}</strong></div>`:''}
        ${pr.silence_distribution?.between_sentences_ms!=null?`<div><span style="color:var(--text-dim)">Ort. duraklama:</span> <strong>cümleler arası ${pr.silence_distribution.between_sentences_ms}ms</strong></div>`:''}
        ${pr.top_energy_segments?.length?`<div style="margin-top:3px;color:var(--text-dim)">Yüksek enerji zirveleri: ${pr.top_energy_segments.length}</div>`:''}
      </div>
    </div>`;
  }

  // ── Content Classification card ──
  if (a.content_classification) {
    const cc = a.content_classification;
    const langConf = Math.round((cc.language_confidence||0)*100);
    analysisCards.innerHTML+=`
    <div class="a-card">
      <div class="a-card-hdr">🏷 İçerik Sınıflandırması</div>
      <div style="padding:8px;display:flex;flex-direction:column;gap:4px;font-size:11px">
        ${cc.format?`<div><span style="color:var(--text-dim)">Format:</span> <strong>${cc.format}</strong></div>`:''}
        ${cc.language?`<div><span style="color:var(--text-dim)">Dil:</span> <strong>${cc.language.toUpperCase()}</strong> <span style="color:var(--text-dim)">(${langConf}% güven)</span></div>`:''}
        ${cc.speech_tone?`<div><span style="color:var(--text-dim)">Ton:</span> <strong>${cc.speech_tone}</strong></div>`:''}
        ${cc.target_audience?`<div><span style="color:var(--text-dim)">Hedef kitle:</span> <strong>${cc.target_audience}</strong></div>`:''}
        ${cc.recommended_platform?`<div style="margin-top:4px;padding:4px 6px;background:rgba(79,195,247,0.1);border-radius:3px;border-left:2px solid #4fc3f7">
          <span style="color:var(--text-dim)">Platform:</span> <strong>${cc.recommended_platform}</strong>
          ${cc.lufs_target?` → <span style="color:#4fc3f7">${cc.lufs_target} LUFS ${cc.output_config||''}</span>`:''}
        </div>`:''}
      </div>
    </div>`;
  }

  // ── Loudness Standards card ──
  if (a.loudness) {
    const lo = a.loudness;
    const compliantCol = lo.ebu_r128_compliant?'var(--green)':'var(--yellow)';
    analysisCards.innerHTML+=`
    <div class="a-card">
      <div class="a-card-hdr">📢 Loudness & Standards</div>
      <div style="padding:8px;display:flex;flex-direction:column;gap:4px;font-size:11px">
        ${lo.integrated_lufs!=null?`<div><span style="color:var(--text-dim)">Entegre Seviye:</span> <strong>${lo.integrated_lufs} LUFS</strong></div>`:''}
        ${lo.true_peak_dbtp!=null?`<div><span style="color:var(--text-dim)">True Peak:</span> <strong>${lo.true_peak_dbtp} dBTP</strong></div>`:''}
        ${lo.loudness_range_lra!=null?`<div><span style="color:var(--text-dim)">LRA:</span> <strong>${lo.loudness_range_lra} LU</strong></div>`:''}
        ${lo.dynamic_range_dr!=null?`<div><span style="color:var(--text-dim)">Dinamik Aralık:</span> <strong>${lo.dynamic_range_dr}</strong></div>`:''}
        ${lo.normalization_gain_db!=null?`<div><span style="color:var(--text-dim)">Gerekli Kazanç:</span> <strong style="color:${lo.normalization_gain_db>0?'var(--green)':'var(--yellow)'}">${lo.normalization_gain_db>0?'+':''}${lo.normalization_gain_db} dB</strong></div>`:''}
        <div><span style="color:var(--text-dim)">EBU R128:</span> <strong style="color:${compliantCol}">${lo.ebu_r128_compliant?'✓ Uyumlu':'✗ Uyumsuz'}</strong></div>
      </div>
    </div>`;
  }

  // ── Privacy & PII card ──
  const piiCount = a.pii_detected?.length||0;
  const hasSensitive = a.sensitive_content&&(a.sensitive_content.medical||a.sensitive_content.legal||a.sensitive_content.financial);
  if (piiCount||hasSensitive) {
    const piiRows = (a.pii_detected||[]).map(p=>{
      const txt = typeof p==='string'?p:(p.type||p.description||JSON.stringify(p));
      return `<div style="font-size:10px;padding:2px 0;color:var(--red)">🔴 ${txt}</div>`;
    }).join('');
    const sensitiveRows = hasSensitive ? Object.entries(a.sensitive_content)
      .filter(([,v])=>v).map(([k])=>{
        const SENS_TR={medical:'Tıbbi içerik',legal:'Hukuki içerik',financial:'Mali içerik'};
        return `<div style="font-size:10px;padding:2px 0;color:var(--yellow)">⚠ ${SENS_TR[k]||k} tespit edildi</div>`;
      }).join('') : '';
    analysisCards.innerHTML+=`
    <div class="a-card" style="border-color:rgba(239,83,80,0.5)">
      <div class="a-card-hdr" style="color:var(--red)">🔒 Privacy & Sensitive Content</div>
      <div style="padding:6px 8px">${piiRows}${sensitiveRows}
        <div style="font-size:9px;color:var(--text-dim);margin-top:4px">GDPR/KVKK: Yayınlamadan önce inceleyin</div>
      </div>
    </div>`;
  }

  // ── Recommendations card ──
  if (a.recommendations?.length) {
    analysisCards.innerHTML+=`<div class="a-card"><div class="a-card-hdr">💡 Recommendations</div><div class="rec-list">${
      a.recommendations.map(r=>`<div class="rec-item">${r}</div>`).join('')
    }</div></div>`;
  }

  // ── Events list (tab) ──
  renderEvents(a.noise_events||a.events||[]);
}

function renderEvents(events) {
  if (!events.length) { noEventsMsg.style.display='block'; return; }
  noEventsMsg.style.display='none';
  eventsList.innerHTML='';
  events.forEach((ev) => {
    const c=evColor(ev.type);
    const startSec = ev.start_sec ?? ev.start ?? 0;
    const endSec   = ev.end_sec   ?? ev.end   ?? startSec;
    // frequency_range may be an object {min,max} or a string
    const freqStr = typeof ev.frequency_range==='object'
      ? `${ev.frequency_range.min||0}–${ev.frequency_range.max||0}Hz`
      : (ev.frequency_range||ev.dominant_frequency||'');
    const recField = ev.recommendation||ev.action||'keep';
    const typeRaw = (ev.type||'bilinmiyor').toLowerCase().replace(/_/g,' ');
    const typeDisplay = TYPE_TR[ev.type?.toLowerCase()] || typeRaw;
    const recDisplay = ACTION_TR[recField] || recField;
    const item=document.createElement('div');
    item.className='ev-item';
    item.innerHTML=`
      <div class="ev-dot" style="background:${c}"></div>
      <div class="ev-info">
        <div class="ev-type">${typeDisplay}${ev.low_confidence?'<span style="color:var(--text-dim);font-size:9px"> · düşük güven</span>':''}</div>
        <div class="ev-time">${startSec.toFixed(2)}s – ${endSec.toFixed(2)}s${ev.duration_ms?` · ${ev.duration_ms}ms`:''} ${freqStr?'· '+freqStr:''}</div>
        ${ev.description?`<div style="font-size:9px;color:var(--text-dim)">${ev.description}</div>`:''}
      </div>
      <div class="ev-conf">${Math.round((ev.confidence||0)*100)}%</div>
      <div class="ev-action ${recField}">${recDisplay}</div>`;
    item.addEventListener('click', ()=>seekTo(startSec));
    eventsList.appendChild(item);
  });
}

// ── AI Commands ────────────────────────────────────────────────────────────────
document.querySelectorAll('.qbtn').forEach(btn => {
  btn.addEventListener('click', ()=>{ switchTab('command'); sendCommand(btn.dataset.cmd); });
});

btnSendCmd.addEventListener('click', sendCommand);
cmdTextarea.addEventListener('keydown', e => { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendCommand(); } });
cmdTextarea.addEventListener('input', () => {
  const hasText = cmdTextarea.value.trim().length > 0;
  const hasAnalysis = !!state.analysis;
  btnSendCmd.disabled = !(hasText && hasAnalysis);
});

// Komut tarama barı — track-area içine eklenir
let _scanBar = null;
function showCmdScan() {
  if (!_scanBar) {
    _scanBar = document.createElement('div');
    _scanBar.id = 'cmd-scan-bar';
    const ta = document.getElementById('track-area');
    if (ta) ta.style.position = 'relative', ta.appendChild(_scanBar);
  }
  _scanBar.classList.add('active');
}
function hideCmdScan() {
  _scanBar?.classList.remove('active');
}

// Komut sonucunu waveform üzerine çiz
function applyCommandResult(segments) {
  if (!segments?.length || !state.audioBuffer) return;
  const dur = state.audioBuffer.duration;
  LAYERS.forEach(layer => {
    const cv = $(`cv-${layer.id}`);
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    segments.forEach(s => {
      const x = (s.start / dur) * W;
      const w = Math.max(3, ((s.end - s.start) / dur) * W);
      if (s.action === 'delete') {
        ctx.fillStyle = 'rgba(239,68,68,0.30)';
        ctx.fillRect(x, 0, w, H);
        // Çapraz çizgiler — silinecek bölge işareti
        ctx.strokeStyle = 'rgba(239,68,68,0.6)';
        ctx.lineWidth = 1;
        for (let xi = x; xi < x + w; xi += 10) {
          ctx.beginPath(); ctx.moveTo(xi, 0); ctx.lineTo(xi + H, H); ctx.stroke();
        }
        // Üst kenar çizgisi
        ctx.strokeStyle = 'rgba(239,68,68,0.9)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x, 1, w, H - 2);
      } else if (s.action === 'attenuate') {
        ctx.fillStyle = 'rgba(251,191,36,0.20)';
        ctx.fillRect(x, 0, w, H);
        ctx.strokeStyle = 'rgba(251,191,36,0.7)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x, 1, w, H - 2);
      }
      // Etiket
      if (w > 24) {
        const label = s.type ? s.type.substring(0, 6).toUpperCase() : (s.action || '').toUpperCase();
        const col = s.action === 'delete' ? 'rgba(239,68,68,0.9)' : 'rgba(251,191,36,0.9)';
        ctx.fillStyle = col;
        ctx.font = 'bold 9px monospace';
        ctx.fillText(label, x + 3, 10);
      }
    });
  });
  addLog('ok', `${segments.length} segment waveform'e işaretlendi`);
}

function buildSegmentPanel(r, allSegs, delSegs, attSegs, totalDur) {
  const segsHtml = allSegs.map((s, i) => {
    const actLabel  = CMD_ACTION_TR[s.action?.toLowerCase()] || (s.action||'').toUpperCase();
    const typeLabel = TYPE_TR[s.type?.toLowerCase()] || s.type || '';
    const dur       = (s.end - s.start).toFixed(2);
    const color     = s.action === 'delete' ? 'var(--red)' : 'var(--yellow)';
    return `<label style="display:flex;align-items:center;gap:6px;padding:3px 4px;border-left:2px solid ${color};margin-bottom:2px;cursor:pointer;border-radius:0 3px 3px 0;background:rgba(255,255,255,0.02)">
      <input type="checkbox" class="seg-cb" data-index="${i}" checked style="accent-color:${color};cursor:pointer;flex-shrink:0">
      <span style="flex:1;display:flex;justify-content:space-between;align-items:center;min-width:0">
        <span><span style="color:${color};font-weight:bold;font-size:10px">${actLabel}</span>${typeLabel?` <span style="color:var(--text-dim);font-size:10px">· ${typeLabel}</span>`:''}</span>
        <span style="color:var(--text-dim);font-size:10px;white-space:nowrap;margin-left:6px">${s.start?.toFixed(1)}s–${s.end?.toFixed(1)}s · ${dur}s</span>
      </span>
    </label>`;
  }).join('');

  return `
    <div style="margin-bottom:8px">
      <h4 style="margin:0 0 4px">✓ ${r.description||'Analiz tamamlandı'}</h4>
      ${r.estimated_quality_improvement?`<div style="color:var(--green);font-size:10px">📈 ${r.estimated_quality_improvement}</div>`:''}
    </div>
    <div style="display:flex;gap:8px;margin-bottom:8px;font-size:11px">
      <div style="background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.4);border-radius:4px;padding:4px 8px;flex:1;text-align:center">
        <div style="color:var(--red);font-size:16px;font-weight:bold">${delSegs.length}</div>
        <div style="color:var(--text-dim)">Silinecek</div>
      </div>
      <div style="background:rgba(251,191,36,0.15);border:1px solid rgba(251,191,36,0.4);border-radius:4px;padding:4px 8px;flex:1;text-align:center">
        <div style="color:var(--yellow);font-size:16px;font-weight:bold">${attSegs.length}</div>
        <div style="color:var(--text-dim)">Azaltılacak</div>
      </div>
      <div style="background:rgba(100,200,100,0.1);border:1px solid rgba(100,200,100,0.3);border-radius:4px;padding:4px 8px;flex:1;text-align:center">
        <div style="color:var(--green);font-size:16px;font-weight:bold">${totalDur.toFixed(1)}s</div>
        <div style="color:var(--text-dim)">Toplam süre</div>
      </div>
    </div>
    ${allSegs.length ? `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <span style="color:var(--text-dim);font-size:10px">İstemediğinizin işaretini kaldırın:</span>
      <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:10px;color:var(--text-dim)">
        <input type="checkbox" id="seg-all-cb" checked> Tümü
      </label>
    </div>
    <div style="max-height:220px;overflow-y:auto;font-size:10px">${segsHtml}</div>
    ` : '<div style="color:var(--text-dim);font-size:11px">Etkilenen bölge bulunamadı.</div>'}`;
}

function wireSegmentPanel(container, allSegs) {
  const allCb  = container.querySelector('#seg-all-cb');
  const segCbs = container.querySelectorAll('.seg-cb');

  // Tümü checkbox — hepsini seç/kaldır
  if (allCb) {
    allCb.addEventListener('change', () => {
      segCbs.forEach(cb => cb.checked = allCb.checked);
      updateApplyBtn();
    });
  }
  segCbs.forEach(cb => cb.addEventListener('change', () => {
    if (allCb) allCb.checked = [...segCbs].every(c => c.checked);
    updateApplyBtn();
  }));

  function getCheckedSegs() {
    return [...segCbs].filter(cb => cb.checked).map(cb => allSegs[+cb.dataset.index]);
  }

  function updateApplyBtn() {
    const btn = container.querySelector('#seg-apply-btn');
    if (!btn) return;
    const n = getCheckedSegs().length;
    btn.textContent = n ? `⬇ ${n} bölgeyi uygula ve indir` : '— Seçili bölge yok —';
    btn.disabled = !n || !_rawFileBlob;
  }

  if (allSegs.length && _rawFileBlob) {
    const btnApply = document.createElement('button');
    btnApply.id = 'seg-apply-btn';
    btnApply.className = 'btn-send';
    btnApply.style.cssText = 'margin-top:8px;background:#16a34a;border-color:#22c55e;width:100%';
    btnApply.textContent = `⬇ ${allSegs.length} bölgeyi uygula ve indir`;
    btnApply.onclick = () => applyAndDownload(getCheckedSegs(), btnApply);
    container.appendChild(btnApply);
  }
}

async function sendCommand(cmdOverride) {
  const cmd=(typeof cmdOverride==='string' ? cmdOverride : cmdTextarea.value).trim();
  if (!cmd) return;
  btnSendCmd.disabled=true;
  cmdResult.className=''; cmdResult.style.display='none';
  setStatus('Komut işleniyor...','busy');
  showCmdScan();
  try {
    const res=await fetch('/api/command',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({command:cmd, analysisContext:state.analysis}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data=await res.json();
    if (!data.success) throw new Error(data.error);
    const r=data.result;

    // Waveform üzerine çiz
    applyCommandResult(r.affected_segments);

    const allSegs = r.affected_segments || [];
    const delSegs = allSegs.filter(s=>s.action==='delete');
    const attSegs = allSegs.filter(s=>s.action==='attenuate');
    const totalDur = allSegs.reduce((acc,s)=>(acc+(s.end-s.start)),0);

    cmdResult.innerHTML = buildSegmentPanel(r, allSegs, delSegs, attSegs, totalDur);
    cmdResult.className='show'; cmdResult.style.display='block';
    cmdResult.scrollIntoView({behavior:'smooth',block:'nearest'});
    setStatus(`${delSegs.length} sil · ${attSegs.length} azalt · ${totalDur.toFixed(1)}s`, 'active');
    wireSegmentPanel(cmdResult, allSegs);
  } catch(err) {
    addLog('error', 'Komut hatası: ' + err.message, err.stack||'');
    cmdResult.innerHTML=`<div style="color:var(--red)">✗ ${err.message}</div>`;
    cmdResult.className='show'; cmdResult.style.display='block';
    setStatus('Komut başarısız','idle');
  } finally {
    btnSendCmd.disabled=false;
    hideCmdScan();
  }
}

async function applyAndDownload(segments, btn) {
  if (!_rawFileBlob) { alert('Ses dosyası bulunamadı — lütfen tekrar yükleyin.'); return; }
  btn.disabled = true;
  btn.textContent = '⏳ FFmpeg işliyor...';
  setStatus('Ses işleniyor...', 'busy');
  try {
    const processedBlob = await uploadAndProcess(segments);
    const cd = processedBlob._cd || '';
    const nm = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i);
    const _baseName = nm ? decodeURIComponent(nm[1]) : 'temizlendi.mp3';
    const downloadName = _currentProjectName ? _currentProjectName.replace(/[\\/:*?"<>|]/g, '_') + '.mp3' : _baseName;
    btn.textContent = '✓ Tamamlandı';
    btn.style.background = '#15803d';
    setStatus('İşlem tamamlandı', 'active');
    showComparison(processedBlob, segments, downloadName);
  } catch(err) {
    btn.disabled = false;
    btn.textContent = '⬇ Uygula ve İndir';
    addLog('error', 'İşlem hatası: ' + err.message);
    setStatus('İşlem başarısız', 'idle');
    alert('Hata: ' + err.message);
  }
}

async function uploadAndProcess(segments, normalizeLUFS) {
  const fd = new FormData();
  fd.append('file', _rawFileBlob, _rawFileBlob.name);
  fd.append('segments', JSON.stringify(segments));
  if (normalizeLUFS != null) fd.append('normalize_lufs', String(normalizeLUFS));
  const boost = window._ngBoostValue || 1.0;
  if (boost !== 1.0) fd.append('voice_boost', String(boost));
  const res = await pipeFetch('/api/process', { method: 'POST', body: fd });
  if (!res.ok) {
    const err = await res.json().catch(() => ({error: `HTTP ${res.status}`}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  blob._cd = res.headers.get('Content-Disposition') || '';
  return blob;
}

async function showComparison(processedBlob, segments, downloadName) {
  // Processed audio decode
  const procArrBuf = await processedBlob.arrayBuffer();
  let procBuffer = null;
  try {
    procBuffer = await getCtx().decodeAudioData(procArrBuf.slice(0));
  } catch(e) { /* görselleştirme olmadan devam */ }

  const origDur   = _originalAudioBuffer?.duration || state.audioBuffer?.duration || 0;
  const procDur   = procBuffer?.duration || 0;
  const savedSec  = origDur - procDur;
  const delSegs   = segments.filter(s=>s.action==='delete');
  const attSegs   = segments.filter(s=>s.action==='attenuate');
  const _origBlobForSize = window._stepAudioSnapshots?.['1'] || _rawFileBlob;
  const origMB    = (_pipeReport?.originalFile?.sizeMB || (_origBlobForSize?.size || _rawFileBlob.size)/1024/1024).toFixed(1);
  const procMB    = (processedBlob.size/1024/1024).toFixed(1);

  // Waveform çizici (mini canvas için)
  function drawMiniWave(canvas, audioBuffer, markedSegs) {
    if (!audioBuffer) return;
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    const ch  = audioBuffer.getChannelData(0);
    const dur = audioBuffer.duration;
    ctx.fillStyle = '#1a2234'; ctx.fillRect(0,0,W,H);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(0,H/2); ctx.lineTo(W,H/2); ctx.stroke();
    const spp = ch.length/W;
    ctx.fillStyle = '#4fc3f7';
    for (let x=0;x<W;x++) {
      const s=Math.floor(x*spp), e=Math.floor((x+1)*spp);
      let mn=0,mx=0;
      for(let i=s;i<e&&i<ch.length;i++){if(ch[i]<mn)mn=ch[i];if(ch[i]>mx)mx=ch[i];}
      const yH=H/2-mx*(H/2-2), yL=H/2-mn*(H/2-2);
      ctx.fillRect(x,yH,1,Math.max(1,yL-yH));
    }
    if (markedSegs) markedSegs.forEach(s => {
      const x = (s.start/dur)*W;
      const w = Math.max(2,((s.end-s.start)/dur)*W);
      const col = s.action==='delete' ? 'rgba(239,68,68,0.45)' : 'rgba(251,191,36,0.35)';
      ctx.fillStyle = col;
      ctx.fillRect(x,0,w,H);
      ctx.strokeStyle = s.action==='delete' ? 'rgba(239,68,68,0.8)' : 'rgba(251,191,36,0.7)';
      ctx.lineWidth=1.5;
      ctx.strokeRect(x,1,w,H-2);
    });
  }

  // URL'ler — orijinal ses: step 1'den veya session'dan, son hal: processedBlob
  let _origBlob = _rawFileBlob;
  // Step 1 audio varsa orijinal olarak kullan (pipeline öncesi ses)
  if (window._stepAudioSnapshots?.['1']) _origBlob = window._stepAudioSnapshots['1'];
  const origUrl = URL.createObjectURL(_origBlob);
  const procUrl = URL.createObjectURL(processedBlob);

  // ── Yardımcı fonksiyonlar ─────────────────────────────────────────────────
  const fmtMSS = sec => {
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60), ms = Math.round((sec % 1) * 10);
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${ms}`;
  };
  const fmtDur = s => s >= 60 ? `${Math.floor(s/60)}dk ${(s%60).toFixed(1)}s` : `${s.toFixed(2)}s`;
  const durLabel = s => s < 0.3 ? {txt:'Kısa duraklama', col:'#64748b'} :
                        s < 1.5 ? {txt:'Normal duraklama', col:'#94a3b8'} :
                        s < 5   ? {txt:'Uzun duraklama', col:'#fbbf24'} :
                                  {txt:'Çok uzun sessizlik', col:'#f97316'};

  // ── İstatistikler ────────────────────────────────────────────────────────
  const totalDelSec = delSegs.reduce((a, s) => a + (s.end - s.start), 0);
  const avgDelSec   = delSegs.length ? totalDelSec / delSegs.length : 0;
  const maxDelSec   = delSegs.length ? Math.max(...delSegs.map(s => s.end - s.start)) : 0;
  const minDelSec   = delSegs.length ? Math.min(...delSegs.map(s => s.end - s.start)) : 0;
  const savePct     = origDur > 0 ? ((savedSec / origDur) * 100).toFixed(1) : 0;

  // Kategori dağılımı
  const catShort  = delSegs.filter(s => (s.end-s.start) < 0.3).length;
  const catNormal = delSegs.filter(s => (s.end-s.start) >= 0.3 && (s.end-s.start) < 1.5).length;
  const catLong   = delSegs.filter(s => (s.end-s.start) >= 1.5 && (s.end-s.start) < 5).length;
  const catVLong  = delSegs.filter(s => (s.end-s.start) >= 5).length;

  // ── Değişiklikler listesi HTML ────────────────────────────────────────────
  const changesHtml = segments.map((s, i) => {
    const dur   = s.end - s.start;
    const color = s.action === 'delete' ? '#ef4444' : '#fbbf24';
    const lbl   = durLabel(dur);
    const pct   = Math.min(100, (dur / Math.max(maxDelSec, 0.01)) * 100);
    const type  = TYPE_TR[s.type?.toLowerCase()] || s.type || '';
    return `<div style="display:flex;align-items:center;gap:6px;padding:4px 8px;background:rgba(255,255,255,0.02);border-radius:4px;margin-bottom:2px;border-left:2px solid ${color}">
      <span style="color:#334155;font-size:9px;width:22px;text-align:right;flex-shrink:0">${i+1}</span>
      <span style="color:${lbl.col};font-size:10px;width:110px;flex-shrink:0">${type || lbl.txt}</span>
      <span style="color:#94a3b8;font-family:monospace;font-size:10px;flex-shrink:0">${fmtMSS(s.start)}</span>
      <span style="color:#475569;font-size:9px">→</span>
      <span style="color:#94a3b8;font-family:monospace;font-size:10px;flex-shrink:0">${fmtMSS(s.end)}</span>
      <div style="flex:1;background:#1e293b;border-radius:2px;height:5px;min-width:30px">
        <div style="background:${color};height:5px;border-radius:2px;width:${pct}%;opacity:0.7"></div>
      </div>
      <span style="color:${color};font-size:10px;font-weight:bold;width:44px;text-align:right;flex-shrink:0">${fmtDur(dur)}</span>
    </div>`;
  }).join('') + (segments.length > 500 ? `<div style="color:#64748b;font-size:10px;padding:4px 8px;text-align:center">... toplam ${segments.length} bölge</div>` : '');

  // ── Modal HTML ────────────────────────────────────────────────────────────
  const modal = document.createElement('div');
  modal.id = 'cmp-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  modal.innerHTML = `
  <div style="background:#0f172a;border:1px solid #334155;border-radius:10px;width:100%;max-width:920px;max-height:94vh;overflow-y:auto;display:flex;flex-direction:column">

    <!-- Başlık -->
    <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #1e293b;flex-shrink:0">
      <div style="font-weight:bold;color:#f1f5f9;font-size:14px">🔍 Karşılaştırma — Orijinal vs Temizlenmiş</div>
      <button id="cmp-close" style="background:transparent;border:1px solid #334155;color:#94a3b8;border-radius:4px;padding:3px 12px;cursor:pointer;font-size:12px">✕ Kapat (Esc)</button>
    </div>

    <!-- Özet istatistikler -->
    <div style="display:flex;gap:8px;padding:10px 16px;border-bottom:1px solid #1e293b;flex-shrink:0;flex-wrap:wrap">
      <div style="background:#1e293b;border-radius:7px;padding:8px 14px;flex:1;min-width:110px;text-align:center">
        <div style="color:#ef4444;font-size:20px;font-weight:bold">${delSegs.length}</div>
        <div style="color:#64748b;font-size:10px">Silinen bölge</div>
        <div style="color:#ef4444;font-size:11px;margin-top:2px">${fmtDur(totalDelSec)}</div>
      </div>
      <div style="background:#1e293b;border-radius:7px;padding:8px 14px;flex:1;min-width:110px;text-align:center">
        <div style="color:#fbbf24;font-size:20px;font-weight:bold">${attSegs.length}</div>
        <div style="color:#64748b;font-size:10px">Azaltılan bölge</div>
        <div style="color:#fbbf24;font-size:11px;margin-top:2px">${attSegs.length ? 'ses kısıldı' : '—'}</div>
      </div>
      <div style="background:#1e293b;border-radius:7px;padding:8px 14px;flex:1;min-width:110px;text-align:center">
        <div style="color:#22c55e;font-size:20px;font-weight:bold">${fmtDur(savedSec)}</div>
        <div style="color:#64748b;font-size:10px">Kazanılan süre</div>
        <div style="color:#22c55e;font-size:11px;margin-top:2px">%${savePct} tasarruf</div>
      </div>
      <div style="background:#1e293b;border-radius:7px;padding:8px 14px;flex:1;min-width:110px;text-align:center">
        <div style="color:#38bdf8;font-size:20px;font-weight:bold">${origMB}→${procMB} MB</div>
        <div style="color:#64748b;font-size:10px">Dosya boyutu</div>
        <div style="color:#38bdf8;font-size:11px;margin-top:2px">${((1-procMB/origMB)*100).toFixed(0)}% küçüldü</div>
      </div>
    </div>

    <!-- Sessizlik dağılımı -->
    <div style="padding:8px 16px;border-bottom:1px solid #1e293b;flex-shrink:0;display:flex;gap:6px;flex-wrap:wrap">
      <span style="font-size:10px;color:#475569;align-self:center">Sessizlik dağılımı:</span>
      ${catShort  ? `<span style="background:#1e293b;color:#64748b;font-size:10px;padding:2px 8px;border-radius:12px;border:1px solid #334155">Kısa &lt;0.3s: <b>${catShort}</b></span>` : ''}
      ${catNormal ? `<span style="background:#1e293b;color:#94a3b8;font-size:10px;padding:2px 8px;border-radius:12px;border:1px solid #475569">Normal 0.3-1.5s: <b>${catNormal}</b></span>` : ''}
      ${catLong   ? `<span style="background:#1e293b;color:#fbbf24;font-size:10px;padding:2px 8px;border-radius:12px;border:1px solid #854d0e">Uzun 1.5-5s: <b>${catLong}</b></span>` : ''}
      ${catVLong  ? `<span style="background:#1e293b;color:#f97316;font-size:10px;padding:2px 8px;border-radius:12px;border:1px solid #9a3412">Çok uzun &gt;5s: <b>${catVLong}</b></span>` : ''}
      <span style="background:#1e293b;color:#64748b;font-size:10px;padding:2px 8px;border-radius:12px;border:1px solid #334155;margin-left:auto">Ort: ${avgDelSec.toFixed(2)}s | Min: ${minDelSec.toFixed(2)}s | Max: ${maxDelSec.toFixed(2)}s</span>
    </div>

    <!-- Waveform karşılaştırması -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px 16px;border-bottom:1px solid #1e293b;flex-shrink:0">
      <div>
        <div style="color:#ef4444;font-size:11px;font-weight:bold;margin-bottom:4px">🔴 Orijinal · ${formatTime(origDur)} · ${origMB}MB</div>
        <canvas id="cmp-canvas-orig" height="70" style="width:100%;border-radius:4px;display:block"></canvas>
        <audio id="cmp-audio-orig" controls src="${origUrl}" style="width:100%;margin-top:6px;height:28px;accent-color:#4fc3f7"></audio>
      </div>
      <div>
        <div style="color:#22c55e;font-size:11px;font-weight:bold;margin-bottom:4px">✅ Temizlenmiş · ${formatTime(procDur)} · ${procMB}MB</div>
        <canvas id="cmp-canvas-proc" height="70" style="width:100%;border-radius:4px;display:block"></canvas>
        <audio id="cmp-audio-proc" controls src="${procUrl}" style="width:100%;margin-top:6px;height:28px;accent-color:#22c55e"></audio>
      </div>
    </div>

    <!-- Değişiklikler listesi -->
    <div style="padding:10px 16px 4px;flex-shrink:0">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div style="color:#94a3b8;font-size:11px;font-weight:bold">📋 Silinen Bölgeler — ${segments.length} adet</div>
        <div style="font-size:10px;color:#475569">Sütunlar: # · Tür · Başlangıç → Bitiş · Süre</div>
      </div>
      <div style="max-height:220px;overflow-y:auto;padding-right:4px">${changesHtml}</div>
    </div>

    <!-- Butonlar -->
    <div style="padding:12px 16px;border-top:1px solid #1e293b;flex-shrink:0;display:flex;gap:8px">
      <button id="cmp-load-ng" style="flex:1;padding:10px;background:#1e3a5f;border:1px solid #3b82f6;color:#60a5fa;border-radius:7px;cursor:pointer;font-size:13px;font-weight:bold">
        ✏️ Editörde Düzenle
        <div style="font-size:10px;color:#475569;font-weight:normal;margin-top:2px">Temizlenmiş sesi yükle, daha fazla düzenle</div>
      </button>
      <button id="cmp-download" style="flex:1;padding:10px;background:linear-gradient(135deg,#15803d,#166534);border:1px solid #22c55e;color:#fff;border-radius:7px;cursor:pointer;font-size:13px;font-weight:bold">
        ⬇ Temizlenmiş Sesi İndir
        <div style="font-size:10px;color:#86efac;font-weight:normal;margin-top:2px">${downloadName}</div>
      </button>
    </div>
  </div>`;

  document.body.appendChild(modal);

  // Canvas boyutlarını ayarla ve çiz
  requestAnimationFrame(() => {
    const cvO = document.getElementById('cmp-canvas-orig');
    const cvP = document.getElementById('cmp-canvas-proc');
    if (cvO) { cvO.width = cvO.offsetWidth || 380; drawMiniWave(cvO, _originalAudioBuffer || state.audioBuffer, segments); }
    if (cvP) { cvP.width = cvP.offsetWidth || 380; drawMiniWave(cvP, procBuffer, []); }
  });

  // Kapat
  document.getElementById('cmp-close').onclick = () => {
    URL.revokeObjectURL(origUrl);
    URL.revokeObjectURL(procUrl);
    modal.remove();
  };

  // İndir
  document.getElementById('cmp-download').onclick = () => {
    const a = document.createElement('a');
    a.href = procUrl; a.download = downloadName; a.click();
    addLog('ok', `İndirildi: ${downloadName}`);
  };

  // Gürültü Paneline Yükle — işlenmiş sesi yeni çalışma dosyası yap
  document.getElementById('cmp-load-ng').onclick = async () => {
    URL.revokeObjectURL(origUrl);
    URL.revokeObjectURL(procUrl);
    modal.remove();
    const file = new File([processedBlob], downloadName, { type: 'audio/mpeg' });
    await loadFile(file);
  };

  addLog('ok', `Karşılaştırma hazır: ${segments.length} değişiklik · ${origMB}MB → ${procMB}MB`);
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.ai-tab').forEach(t=>t.addEventListener('click',()=>switchTab(t.dataset.tab)));

function switchTab(name) {
  document.querySelectorAll('.ai-tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));
  ['analysis','events','transcript','command','logs'].forEach(n=>{
    $(`tab-${n}`)?.classList.toggle('active', n===name);
  });
}

// ── AI Panel Toggle ────────────────────────────────────────────────────────────
btnAiToggle?.addEventListener('click', ()=>{
  state.aiPanelOpen=!state.aiPanelOpen;
  aiPanel.classList.toggle('hidden',!state.aiPanelOpen);
  btnAiToggle.classList.toggle('active',state.aiPanelOpen);
  setTimeout(resizeCanvases, 220);
});

// ── Playback ──────────────────────────────────────────────────────────────────
btnPlay.addEventListener('click', togglePlay);
btnStop.addEventListener('click', stop);
btnSkipStart.addEventListener('click', ()=>{ stop(); seekTo(0); });
btnRewind.addEventListener('click', ()=>seekTo(Math.max(0,now()-5)));
btnFfwd.addEventListener('click', ()=>seekTo(Math.min(state.audioBuffer?.duration||0,now()+5)));
btnZoomFit?.addEventListener('click', ()=>{
  if (!state.audioBuffer) return;
  state.pps = (rulerWrap.clientWidth||800)/state.audioBuffer.duration;
  resizeCanvases();
});

function now() {
  return state.isPlaying
    ? state.offset+(state.audioCtx.currentTime-state.startTime)
    : state.offset;
}

function seekTo(t) {
  const was=state.isPlaying;
  if (was) stopPlayback();
  state.offset=Math.max(0,Math.min(t,state.audioBuffer?.duration||0));
  updateTimeDisplay(state.offset);
  movePlayheads(state.offset);
  if (was) startPlayback();
}

function togglePlay() { if (!state.audioBuffer) return; state.isPlaying?stopPlayback():startPlayback(); }

function startPlayback() {
  const ctx=getCtx();
  // Zincir: source → layerGainNode → masterGain → analyser → destination
  state.gainNode=ctx.createGain(); state.gainNode.connect(ctx.destination);
  state.layerGainNode=ctx.createGain(); state.layerGainNode.connect(state.gainNode);
  state.analyserL=ctx.createAnalyser(); state.analyserL.fftSize=256;
  state.analyserR=ctx.createAnalyser(); state.analyserR.fftSize=256;
  state.gainNode.connect(state.analyserL);
  state.gainNode.connect(state.analyserR);

  state.sourceNode=ctx.createBufferSource();
  state.sourceNode.buffer=state.audioBuffer;
  state.sourceNode.connect(state.layerGainNode);
  state.sourceNode.start(0,state.offset);
  state.sourceNode.onended=()=>{ if (state.isPlaying) stop(); };

  state.startTime=ctx.currentTime;
  state.isPlaying=true;
  btnPlay.textContent='⏸';
  btnPlay.classList.add('active');
  setStatus('Oynatılıyor...','active');
  animLoop();
  animVU();
}

function stopPlayback() {
  if (state.sourceNode) { state.sourceNode.onended=null; try{state.sourceNode.stop();}catch(e){} state.sourceNode=null; }
  state.offset=now();
  state.isPlaying=false;
  btnPlay.textContent='▶';
  btnPlay.classList.remove('active');
  cancelAnimationFrame(state.rafId);
  cancelAnimationFrame(state.animVU);
  resetVU();
}

function stop() {
  stopPlayback();
  state.offset=0;
  updateTimeDisplay(0);
  movePlayheads(0);
  setStatus('Durduruldu.','idle');
}

function animLoop() {
  const frame=()=>{
    if (!state.isPlaying) return;
    const t=now();
    updateTimeDisplay(t);
    movePlayheads(t);
    // Katman mute/solo/vol gain uygula
    if (state.layerGainNode) {
      state.layerGainNode.gain.value = computeLayerGainAt(t);
    }
    if (t>=(state.audioBuffer?.duration||0)) { stop(); return; }
    state.rafId=requestAnimationFrame(frame);
  };
  state.rafId=requestAnimationFrame(frame);
}

function animVU() {
  const data=new Uint8Array(state.analyserL?.frequencyBinCount||128);
  const frame=()=>{
    if (!state.isPlaying) return;
    state.analyserL?.getByteFrequencyData(data);
    const avg=data.slice(0,32).reduce((s,v)=>s+v,0)/32/255;
    const lPct=Math.min(100,avg*120);
    const rPct=Math.min(100,(avg*0.9+Math.random()*0.05)*120);
    vuLFill.style.width=lPct+'%';
    vuRFill.style.width=rPct+'%';
    state.animVU=requestAnimationFrame(frame);
  };
  state.animVU=requestAnimationFrame(frame);
}

function resetVU() { vuLFill.style.width='0%'; vuRFill.style.width='0%'; }

function updateTimeDisplay(t) {
  if (timeDisplay) timeDisplay.textContent=formatBig(t);
  if (selStart) selStart.textContent=formatTime(t);
  if (selEnd)   selEnd.textContent=formatTime(t);
}

function movePlayheads(t) {
  const dur=state.audioBuffer?.duration||1;
  const pct=t/dur;
  LAYERS.forEach(layer=>{
    const cv=$(`cv-${layer.id}`);
    const ph=$(`ph-${layer.id}`);
    if (cv&&ph) ph.style.left=(pct*cv.width)+'px';
  });
}

// ── Tool buttons ──────────────────────────────────────────────────────────────
['tool-select','tool-envelope','tool-draw','tool-zoom','tool-timeshift','tool-multi'].forEach(id=>{
  const el=$(id);
  if (!el) return;
  el.addEventListener('click',()=>{
    document.querySelectorAll('.tbtn-tool').forEach(b=>b.classList.remove('active'));
    el.classList.add('active');
  });
});

// ── Drag & Drop ───────────────────────────────────────────────────────────────
document.addEventListener('dragover',e=>{e.preventDefault();dragOvl.classList.add('show');});
document.addEventListener('dragleave',e=>{if(!e.relatedTarget)dragOvl.classList.remove('show');});
document.addEventListener('drop',e=>{
  e.preventDefault(); dragOvl.classList.remove('show');
  const f=e.dataTransfer.files[0];
  if (f&&f.type.startsWith('audio/')) loadFile(f);
});

// ── Keyboard ──────────────────────────────────────────────────────────────────
document.addEventListener('keydown',e=>{
  if (e.target===cmdTextarea || e.target.tagName==='INPUT' || e.target.tagName==='TEXTAREA' || e.target.tagName==='SELECT') return;
  switch(e.code) {
    case 'Space':    e.preventDefault(); togglePlay();  break;
    case 'Home':     e.preventDefault(); stop();         break;
    case 'ArrowLeft':e.preventDefault(); seekTo(Math.max(0,now()-1)); break;
    case 'ArrowRight':e.preventDefault();seekTo(now()+1); break;
    case 'Equal':  case 'NumpadAdd':  e.preventDefault(); state.pps=Math.min(500,state.pps*1.5); resizeCanvases(); break;
    case 'Minus':  case 'NumpadSubtract': e.preventDefault(); state.pps=Math.max(10,state.pps/1.5); resizeCanvases(); break;
  }
});

// ── Resize ────────────────────────────────────────────────────────────────────
let resizeTimer;
window.addEventListener('resize',()=>{ clearTimeout(resizeTimer); resizeTimer=setTimeout(resizeCanvases,150); });

// ── Init ──────────────────────────────────────────────────────────────────────
setStatus('Durduruldu.','idle');
btnAiToggle?.classList.add('active');

// ── Whisper Transkripsiyon ─────────────────────────────────────────────────────
const btnTranscribe       = $('btn-transcribe');
const whisperModelSelect  = $('whisper-model-select');
const transcriptStatus    = $('transcript-status');
const transcriptProgress  = $('transcript-progress');
const transcriptProgLabel = $('transcript-progress-label');
const transcriptProgBar   = $('transcript-progress-bar');
const transcriptStats     = $('transcript-stats');
const transcriptSegments  = $('transcript-segments');
const transcriptPlaceholder = $('transcript-placeholder');

let _transcriptJobId   = null;
let _transcriptPollTimer = null;
let _transcriptResult  = null;   // son başarılı transkripsiyon sonucu
// _rawFileBlob dosyanın başına taşındı (bkz. aşağısı)

// Dosya yüklendiğinde butonu aktifleştir ve blob'u sakla
const _origLoadFile = loadFile;
// Dosya değişkenini loadFile içinden yakalayabilmek için fileInput listener genişletildi:
fileInput.addEventListener('change', e => { if (e.target.files[0]) _rawFileBlob = e.target.files[0]; });

// Drag & drop için de yakala
document.addEventListener('drop', e => {
  const f = e.dataTransfer?.files?.[0];
  if (f && f.type.startsWith('audio')) _rawFileBlob = f;
}, true);

async function onAudioLoaded() {
  if (btnTranscribe) {
    btnTranscribe.disabled = false;
    const btnRe = $('btn-retranscribe');
    if (btnRe) btnRe.disabled = false;
  }
  const cached = await loadTranscriptFromDB();
  if (cached) {
    _transcriptResult = cached;
    renderTranscript(cached);
    if (transcriptStatus) transcriptStatus.textContent = `✓ Arşivden yüklendi — ${cached.stats?.total_words} kelime`;
    addLog('ok', `Transkript arşivden yüklendi: ${cached.stats?.total_words} kelime`);
    const tabBtn = $('tab-transcript-btn');
    if (tabBtn) { tabBtn.style.color = 'var(--green)'; tabBtn.textContent = 'Transkript ✓'; }
  } else {
    if (transcriptStatus) transcriptStatus.textContent = `Hazır — ${state.fileName}`;
  }
}

btnTranscribe?.addEventListener('click', startTranscription);

async function startTranscription() {
  if (!_rawFileBlob && !state.fileName) {
    showErrorBanner('❌ Transkripsiyon için ses dosyası gerekli.');
    return;
  }
  if (!_rawFileBlob) {
    showErrorBanner('❌ Ham dosya bulunamadı. Lütfen dosyayı yeniden yükleyin.');
    return;
  }

  // Arşivde transkript varsa: göster, yeniden transkribe etme
  if (!$('btn-retranscribe')) { // "Yeniden" butonuna basılmadıysa
    const cached = await loadTranscriptFromDB();
    if (cached) {
      _transcriptResult = cached;
      renderTranscript(cached);
      switchTab('transcript');
      transcriptStatus.textContent = `✓ Arşivden yüklendi — yeniden transkribe etmek için "🔄 Yeniden" butonuna basın`;
      addLog('ok', `Transkript arşivden yüklendi: ${cached.stats?.total_words} kelime`);
      return;
    }
  }

  const model = whisperModelSelect?.value || 'large';
  btnTranscribe.disabled = true;
  switchTab('transcript');
  transcriptPlaceholder.style.display = 'none';
  transcriptSegments.innerHTML = '';
  transcriptStats.style.display = 'none';
  transcriptProgress.style.display = 'block';
  transcriptProgBar.style.width = '0%';
  transcriptProgLabel.textContent = 'Dosya sunucuya gönderiliyor...';
  transcriptStatus.textContent = `⏳ ${model} modeli çalışıyor...`;

  const tabBtn = $('tab-transcript-btn');
  if (tabBtn) { tabBtn.style.color = 'var(--accent)'; tabBtn.textContent = 'Transkript ⏳'; }

  addLog('info', `Whisper transkripsiyon başlatılıyor: model=${model}, dosya=${_rawFileBlob.name}`);

  try {
    const fd = new FormData();
    fd.append('file',  _rawFileBlob, _rawFileBlob.name);
    fd.append('model', model);

    const res = await fetch('/api/transcribe/start', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    _transcriptJobId = data.job_id;
    addLog('ok', `Whisper işi başlatıldı: ${_transcriptJobId} (${data.size_mb}MB)`);
    transcriptProgLabel.textContent = `Whisper ${model} — model yükleniyor...`;
    startTranscriptionPoll();

  } catch(err) {
    addLog('error', 'Transkripsiyon başlatma hatası: ' + err.message);
    transcriptStatus.textContent = '✗ Hata: ' + err.message;
    transcriptProgress.style.display = 'none';
    btnTranscribe.disabled = false;
    if (tabBtn) { tabBtn.style.color = 'var(--red)'; tabBtn.textContent = 'Transkript ✗'; }
  }
}

function startTranscriptionPoll() {
  if (_transcriptPollTimer) clearInterval(_transcriptPollTimer);
  _transcriptPollTimer = setInterval(pollTranscriptionStatus, 3000);
}

async function pollTranscriptionStatus() {
  if (!_transcriptJobId) return;
  try {
    const res  = await fetch(`/api/transcribe/status/${_transcriptJobId}`);
    const data = await res.json();
    const tabBtn = $('tab-transcript-btn');

    const STATUS_LABELS = {
      queued:        'Sırada bekliyor...',
      loading_model: `Whisper ${data.model} modeli yükleniyor...`,
      transcribing:  `Transkripsiyon çalışıyor... (${data.elapsed}s geçti)`,
      done:          'Tamamlandı!',
      error:         'Hata oluştu',
    };
    transcriptProgLabel.textContent = STATUS_LABELS[data.status] || data.status;

    // Sahte ilerleme animasyonu (gerçek % yok, Whisper vermez)
    const fakePct = data.status === 'done' ? 100
      : data.status === 'loading_model'  ? 8
      : Math.min(95, 10 + (data.elapsed || 0) * 0.3);
    transcriptProgBar.style.width = fakePct + '%';

    if (data.status === 'done') {
      clearInterval(_transcriptPollTimer);
      _transcriptPollTimer = null;
      _transcriptResult = data.result;
      renderTranscript(data.result);
      saveTranscriptToDB(data.result); // arşive kaydet
      btnTranscribe.disabled = false;
      if (tabBtn) { tabBtn.style.color = 'var(--green)'; tabBtn.textContent = 'Transkript ✓'; }
      transcriptStatus.textContent = `✓ Tamamlandı — ${data.result.language?.toUpperCase()} · ${data.elapsed}s`;
      addLog('ok', `Whisper tamamlandı: ${data.result.stats?.total_words} kelime, ${data.result.stats?.segment_count} segment`);

      // Transkripsiyon varken Ollama yeniden zenginleştirsin
      if (state.analysis) {
        addLog('info', 'Transkripsiyon hazır — Ollama yeniden zenginleştiriyor...');
        reEnrichWithTranscript(data.result);
      }

    } else if (data.status === 'error') {
      clearInterval(_transcriptPollTimer);
      _transcriptPollTimer = null;
      addLog('error', 'Whisper hatası: ' + data.error);
      transcriptStatus.textContent = '✗ ' + data.error;
      btnTranscribe.disabled = false;
      if (tabBtn) { tabBtn.style.color = 'var(--red)'; tabBtn.textContent = 'Transkript ✗'; }
    }
  } catch(err) {
    addLog('warn', 'Durum sorgu hatası: ' + err.message);
  }
}

// ── Transkript görünüm durumu ──────────────────────────────────────────────────
let _transcriptView = 'segments'; // 'segments' | 'words' | 'text'
let _selectedWords  = new Set();  // seçili kelime indeksleri
let _lastShiftIdx   = null;
let _currentTranscriptResult = null;

function renderTranscript(result) {
  _currentTranscriptResult = result;
  transcriptProgress.style.display = 'none';
  transcriptPlaceholder.style.display = 'none';

  // İstatistik şeridi
  const s = result.stats || {};
  const LANG_TR = {tr:'Türkçe', en:'İngilizce', de:'Almanca', fr:'Fransızca', es:'İspanyolca', unknown:'Bilinmiyor'};
  transcriptStats.innerHTML = `
    <span style="margin-right:10px">🌐 ${LANG_TR[result.language]||result.language?.toUpperCase()||'?'}</span>
    <span style="margin-right:10px">📝 ${(s.total_words||0).toLocaleString()} kelime</span>
    <span style="margin-right:10px">⚡ ${s.words_per_min||0} k/dk</span>
    <span style="margin-right:10px">🔁 ${s.filler_count||0} dolgu</span>
    <span style="margin-right:10px">🎙 ${s.segment_count||0} cümle</span>
    <span>⏱ ${result.elapsed_sec||'?'}s · Whisper ${result.model||''}</span>`;
  transcriptStats.style.display = 'block';

  // Görünüm butonlarını bağla (bir kez)
  if (!$('tv-segments').__trBound) {
    ['segments','words','text'].forEach(mode => {
      const btn = $(`tv-${mode}`);
      if (!btn) return;
      btn.__trBound = true;
      btn.onclick = () => { _transcriptView = mode; _renderTranscriptBody(); _updateTvButtons(); };
    });
    const btnCut = $('btn-cut-selected');
    if (btnCut) btnCut.onclick = () => _cutSelectedWords();

    // "Yeniden" butonu
    const btnRe = $('btn-retranscribe');
    if (btnRe) {
      btnRe.disabled = false;
      btnRe.onclick = async () => {
        if (!confirm('Arşivdeki transkript silinecek ve Whisper yeniden çalıştırılacak. Emin misiniz?')) return;
        await deleteTranscriptFromDB();
        _transcriptResult = null;
        _currentTranscriptResult = null;
        transcriptStats.style.display = 'none';
        transcriptSegments.innerHTML = '';
        transcriptPlaceholder.style.display = 'block';
        transcriptStatus.textContent = `Hazır — ${state.fileName}`;
        startTranscription();
      };
    }
    $('tv-segments').__trBound = true;
  }

  _renderTranscriptBody();
  _updateTvButtons();
  _renderTrMainTab(result);
}

// ── Transkript ana sekme (checkbox + sil) ─────────────────────────────────────

let _trMainSelected = new Set(); // silinecek segment index'leri

// ── Transkript player ──────────────────────────────────────────────────────────
const _trPlayer = { playing: false, source: null, ctx: null, startedAt: 0, audioOffset: 0, rafId: null, rows: [], segs: [] };

function _trPlayerCurrentTime() {
  if (!_trPlayer.playing || !_trPlayer.ctx) return _trPlayer.audioOffset;
  return _trPlayer.audioOffset + (_trPlayer.ctx.currentTime - _trPlayer.startedAt);
}

function _trPlayerStop() {
  if (_trPlayer.source) { try { _trPlayer.source.stop(); } catch(e){} _trPlayer.source = null; }
  if (_trPlayer.rafId) { cancelAnimationFrame(_trPlayer.rafId); _trPlayer.rafId = null; }
  _trPlayer.playing = false;
  _trPlayer.audioOffset = 0;
  const btn = document.getElementById('tr-main-play-btn');
  if (btn) { btn.textContent = '▶ Oynat'; btn.style.background = 'rgba(56,189,248,0.15)'; }
  _trPlayer.rows.forEach((r, i) => { if (!_trMainSelected.has(i)) r.style.background = ''; });
}

function _trPlayerPlay(segs, rows, fromTime) {
  _trPlayerStop();
  if (!state.audioBuffer) return;
  const ctx = getCtx();
  const src = ctx.createBufferSource();
  src.buffer = state.audioBuffer;
  src.connect(ctx.destination);
  src.start(0, fromTime);
  src.onended = () => _trPlayerStop();
  _trPlayer.playing = true;
  _trPlayer.source = src;
  _trPlayer.ctx = ctx;
  _trPlayer.startedAt = ctx.currentTime;
  _trPlayer.audioOffset = fromTime;
  _trPlayer.segs = segs;
  _trPlayer.rows = rows;
  const btn = document.getElementById('tr-main-play-btn');
  if (btn) { btn.textContent = '⏸ Duraklat'; btn.style.background = 'rgba(251,146,60,0.2)'; }
  const body = document.getElementById('tr-main-body');
  (function frame() {
    const t = _trPlayerCurrentTime();
    let activeIdx = -1;
    for (let i = 0; i < segs.length; i++) {
      const end = segs[i].end ?? (segs[i+1]?.start ?? t+1);
      if (t >= segs[i].start && t < end) { activeIdx = i; break; }
    }
    rows.forEach((r, i) => {
      if (i === activeIdx) {
        r.style.background = 'rgba(56,189,248,0.18)';
        if (body) {
          const top = r.offsetTop - body.clientHeight / 2;
          if (Math.abs(body.scrollTop - top) > 80) body.scrollTop = top;
        }
      } else if (!_trMainSelected.has(i)) {
        r.style.background = '';
      }
    });
    if (_trPlayer.playing) _trPlayer.rafId = requestAnimationFrame(frame);
  })();
}

async function _trPlayerPlayCleaned(segs) {
  _trPlayerStop();
  if (!state.audioBuffer) return;
  const sr = state.audioBuffer.sampleRate;
  const ch = state.audioBuffer.numberOfChannels;
  const dur = state.audioBuffer.duration;
  const ranges = segs.map((s, i) => ({
    s: Math.max(0, Math.floor(s.start * sr)),
    e: Math.min(state.audioBuffer.length, Math.ceil((s.end ?? segs[i+1]?.start ?? Math.min(s.start + 10, dur)) * sr))
  })).filter(r => r.e > r.s);
  const total = ranges.reduce((sum, r) => sum + r.e - r.s, 0);
  const ctx = getCtx();
  const newBuf = ctx.createBuffer(ch, total, sr);
  for (let c = 0; c < ch; c++) {
    const srcData = state.audioBuffer.getChannelData(c);
    const dst = newBuf.getChannelData(c);
    let off = 0;
    ranges.forEach(r => { dst.set(srcData.subarray(r.s, r.e), off); off += r.e - r.s; });
  }
  const src = ctx.createBufferSource();
  src.buffer = newBuf;
  src.connect(ctx.destination);
  src.start();
  _trPlayer.playing = true;
  _trPlayer.source = src;
  _trPlayer.ctx = ctx;
  _trPlayer.startedAt = ctx.currentTime;
  _trPlayer.audioOffset = 0;
  const cBtn = document.getElementById('tr-main-clean-play-btn');
  if (cBtn) cBtn.textContent = '⏹ Durdur';
  src.onended = () => {
    _trPlayer.playing = false;
    _trPlayer.source = null;
    if (cBtn) cBtn.textContent = '▶ Temizlenmiş Dinle';
  };
}

async function _renderTrMainTabFromDB() {
  // DB'den yükle, yoksa bellekteki veriyi kullan
  let result = _currentTranscriptResult;
  try {
    const fromDB = await loadTranscriptFromDB();
    if (fromDB) result = fromDB;
  } catch(e) {}
  _renderTrMainTab(result);
}

// ── Kalite Kontrol Kartı ──────────────────────────────────────────────────────

function _showQualityCard(qc) {
  // Mevcut kartı kaldır
  const old = document.getElementById('qc-card');
  if (old) old.remove();

  const score = qc.quality_score || 0;
  const clr   = score >= 80 ? '#4ade80' : score >= 60 ? '#eab308' : '#ef4444';
  const bgClr = score >= 80 ? 'rgba(74,222,128,0.06)' : score >= 60 ? 'rgba(234,179,8,0.06)' : 'rgba(239,68,68,0.06)';
  const bdrClr = score >= 80 ? '#166534' : score >= 60 ? '#78350f' : '#7f1d1d';
  const label  = score >= 80 ? 'İyi' : score >= 60 ? 'Orta' : 'Düşük';

  const audioIssues  = qc.audio_issues  || [];
  const speechIssues = qc.speech_issues || [];
  const recs = qc.summary?.recommendations || [];

  const issueIcon = { clipping:'🔴', dc_offset:'⚡', dropout:'💥', click:'🔊', stutter:'🗣', long_pause:'⏸', fast_speech:'⚡', filler:'💬' };
  const sevClr = { high:'#ef4444', medium:'#eab308', low:'#94a3b8' };

  function renderIssues(issues, maxShow) {
    if (!issues.length) return '<div style="font-size:11px;color:#4ade80;padding:4px 0">✓ Sorun yok</div>';
    return issues.slice(0, maxShow).map(is => {
      const ic = issueIcon[is.type] || '⚠';
      const sc = sevClr[is.severity] || '#94a3b8';
      const timeStr = is.start != null ? `${is.start.toFixed(1)}s` : '';
      return `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:11px">
        <span>${ic}</span>
        <span style="color:${sc};min-width:45px">${timeStr}</span>
        <span style="color:#cbd5e1">${is.description || is.word || is.type}</span>
      </div>`;
    }).join('') + (issues.length > maxShow ? `<div style="font-size:10px;color:#64748b;padding:2px 0">... ve ${issues.length - maxShow} sorun daha</div>` : '');
  }

  const card = document.createElement('div');
  card.id = 'qc-card';
  card.style.cssText = `background:${bgClr};border:1px solid ${bdrClr};border-radius:10px;padding:16px;margin:12px 0;position:relative`;
  card.innerHTML = `
    <button id="qc-close" style="position:absolute;top:8px;right:10px;background:none;border:none;color:#64748b;cursor:pointer;font-size:16px;line-height:1" title="Kapat">✕</button>
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px">
      <div style="width:64px;height:64px;border-radius:50%;border:3px solid ${clr};display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <span style="font-size:22px;font-weight:800;color:${clr}">${score}</span>
      </div>
      <div>
        <div style="font-size:14px;font-weight:700;color:${clr}">Kalite: ${label}</div>
        <div style="font-size:11px;color:#94a3b8;margin-top:2px">${qc.summary?.total_audio_issues || 0} ses sorunu · ${qc.summary?.total_speech_issues || 0} konuşma sorunu</div>
      </div>
    </div>
    ${audioIssues.length ? `<div style="margin-bottom:10px"><div style="font-size:11px;color:#f59e0b;font-weight:600;margin-bottom:4px">🔊 Ses Sorunları</div>${renderIssues(audioIssues, 5)}</div>` : ''}
    ${speechIssues.length ? `<div style="margin-bottom:10px"><div style="font-size:11px;color:#a78bfa;font-weight:600;margin-bottom:4px">🗣 Konuşma Sorunları</div>${renderIssues(speechIssues, 5)}</div>` : ''}
    ${recs.length ? `<div style="margin-bottom:8px"><div style="font-size:11px;color:#38bdf8;font-weight:600;margin-bottom:4px">💡 Öneriler</div>${recs.map(r => `<div style="font-size:11px;color:#94a3b8;padding:2px 0">• ${r}</div>`).join('')}</div>` : ''}
    ${score < 70 ? `<button id="qc-reprocess" style="background:#1e293b;border:1px solid #334155;color:#f59e0b;border-radius:6px;padding:5px 14px;font-size:11px;font-weight:600;cursor:pointer;margin-top:4px">🔄 Tekrar İşle</button>` : ''}`;

  // Pipeline progress alanının altına ekle
  const pipeProg = document.getElementById('ng-pipeline-progress');
  if (pipeProg) {
    pipeProg.appendChild(card);
  }

  card.querySelector('#qc-close').addEventListener('click', () => card.remove());
  const reBtn = card.querySelector('#qc-reprocess');
  if (reBtn) {
    reBtn.addEventListener('click', () => {
      card.remove();
      const pipeBtn = document.getElementById('ng-pipeline-btn');
      if (pipeBtn) pipeBtn.click();
    });
  }
}


// ── Kelime Bazlı Düzenleme ────────────────────────────────────────────────────
const _wordEdits = [];  // [{start, end, word, action: 'delete'|'silence'}]

// CSS enjeksiyonu
(function _injectWordStyles() {
  if (document.getElementById('tr-word-style')) return;
  const s = document.createElement('style');
  s.id = 'tr-word-style';
  s.textContent = `.tr-word{cursor:pointer;padding:0 1px;border-radius:2px;transition:background .15s}
.tr-word:hover{background:rgba(59,130,246,0.2)}
.tr-word.w-deleted{text-decoration:line-through;color:#ef4444;opacity:0.5}
.tr-word.w-silenced{background:rgba(234,179,8,0.15);color:#eab308;text-decoration:underline dotted}
#tr-word-ctx{position:fixed;z-index:9999;background:#1e293b;border:1px solid #334155;border-radius:6px;box-shadow:0 8px 32px #000a;padding:4px 0;min-width:160px;font-size:12px}
#tr-word-ctx div{padding:6px 12px;cursor:pointer;color:#e2e8f0}
#tr-word-ctx div:hover{background:rgba(59,130,246,0.15)}`;
  document.head.appendChild(s);
})();

function _showWordContextMenu(e, w, spanEl) {
  let menu = document.getElementById('tr-word-ctx');
  if (menu) menu.remove();
  menu = document.createElement('div');
  menu.id = 'tr-word-ctx';
  menu.innerHTML = `
    <div data-action="delete">🗑 Bu kelimeyi sil</div>
    <div data-action="silence">🔇 Sessizleştir</div>
    <div data-action="undo" style="border-top:1px solid #334155;color:#94a3b8">↩ Geri al</div>`;
  menu.style.left = e.clientX + 'px';
  menu.style.top  = e.clientY + 'px';
  document.body.appendChild(menu);

  menu.addEventListener('click', ev => {
    const action = ev.target.dataset.action;
    if (!action) return;
    menu.remove();

    if (action === 'undo') {
      // Bu kelimeyi düzenleme listesinden çıkar
      const idx = _wordEdits.findIndex(ed => ed.start === w.start && ed.end === w.end);
      if (idx >= 0) _wordEdits.splice(idx, 1);
      spanEl.classList.remove('w-deleted', 'w-silenced');
    } else {
      // Önceki düzenlemeyi kaldır, yenisini ekle
      const idx = _wordEdits.findIndex(ed => ed.start === w.start && ed.end === w.end);
      if (idx >= 0) _wordEdits.splice(idx, 1);
      _wordEdits.push({ start: w.start, end: w.end, word: w.word, action });
      spanEl.classList.remove('w-deleted', 'w-silenced');
      spanEl.classList.add(action === 'delete' ? 'w-deleted' : 'w-silenced');
    }
    _updateWordEditBtn();
  });

  // Dışına tıklayınca kapat
  setTimeout(() => {
    document.addEventListener('click', function _closeCtx() {
      menu.remove();
      document.removeEventListener('click', _closeCtx);
    }, { once: true });
  }, 50);
}

function _updateWordEditBtn() {
  let btn = document.getElementById('tr-word-apply-btn');
  if (_wordEdits.length > 0) {
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'tr-word-apply-btn';
      btn.style.cssText = 'background:linear-gradient(135deg,#7f1d1d,#991b1b);border:1px solid #ef4444;color:#fecaca;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;margin:8px 0';
      btn.addEventListener('click', _applyWordEdits);
      const list = document.getElementById('tr-main-list');
      if (list) list.parentElement.insertBefore(btn, list.nextSibling);
    }
    const delCount = _wordEdits.filter(e => e.action === 'delete').length;
    const silCount = _wordEdits.filter(e => e.action === 'silence').length;
    let label = `✂ Değişiklikleri Uygula (${_wordEdits.length} kelime:`;
    if (delCount) label += ` ${delCount} sil`;
    if (silCount) label += ` ${silCount} sessiz`;
    btn.textContent = label + ')';
  } else if (btn) {
    btn.remove();
  }
}

async function _applyWordEdits() {
  if (!_wordEdits.length || !_rawFileBlob) return;
  const btn = document.getElementById('tr-word-apply-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Uygulanıyor...'; }

  const fd = new FormData();
  fd.append('file', _rawFileBlob, _rawFileBlob.name || 'audio.mp3');
  fd.append('edits', JSON.stringify(_wordEdits));

  try {
    const resp = await fetch('/api/align/word-edit', { method: 'POST', body: fd });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error || resp.statusText);
    }
    const blob = await resp.blob();
    _rawFileBlob = new File([blob], _rawFileBlob.name || 'audio.mp3', { type: 'audio/mpeg' });
    try { state.audioBuffer = await new AudioContext().decodeAudioData(await blob.slice(0).arrayBuffer()); } catch(_) {}
    _wordEdits.length = 0;
    _updateWordEditBtn();
    addLog('ok', '✂ Kelime düzenlemeleri uygulandı');
    // Silinen kelimeleri transkriptten de kaldır
    if (_currentTranscriptResult?.segments) {
      _currentTranscriptResult.segments.forEach(seg => {
        if (!seg.words) return;
        seg.words = seg.words.filter(w => !_wordEdits.some(e => e.action === 'delete' && e.start === w.start && e.end === w.end));
        seg.text = seg.words.map(w => w.word).join(' ');
      });
    }
    _renderTrMainTab();
  } catch(e) {
    addLog('error', '✂ Kelime düzenleme hatası: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = '✂ Tekrar Dene'; }
  }
}

function _renderTrMainTab(dataOverride) {
  _trPlayerStop();
  const result = dataOverride !== undefined ? dataOverride : _currentTranscriptResult;
  const list   = document.getElementById('tr-main-list');
  const ph     = document.getElementById('tr-main-placeholder');
  const count  = document.getElementById('tr-main-count');
  const delBtn = document.getElementById('tr-main-delete-btn');
  const selBtn = document.getElementById('tr-main-selectall-btn');
  const playBtn  = document.getElementById('tr-main-play-btn');
  const cleanBtn = document.getElementById('tr-main-clean-play-btn');
  if (!list) return;

  if (!result || !result.segments || !result.segments.length) {
    ph.style.display   = 'block';
    list.innerHTML     = '';
    count.textContent  = 'Transkript yok';
    delBtn.style.display = 'none';
    selBtn.style.display = 'none';
    if (playBtn)  playBtn.style.display  = 'none';
    if (cleanBtn) cleanBtn.style.display = 'none';
    return;
  }

  ph.style.display = 'none';
  _trMainSelected.clear();
  count.textContent = `${result.segments.length} segment`;
  delBtn.style.display = 'none';
  selBtn.style.display = '';
  if (playBtn)  { playBtn.style.display = ''; playBtn.textContent = '▶ Oynat'; }
  if (cleanBtn) cleanBtn.style.display = 'none';

  const rows = [];

  function _applyRowStyle(row, i) {
    if (_trMainSelected.has(i)) {
      row.style.background = 'rgba(239,68,68,0.12)';
      row.querySelector('span:last-child').style.textDecoration = 'line-through';
      row.querySelector('span:last-child').style.opacity = '0.5';
    } else {
      row.style.background = '';
      row.querySelector('span:last-child').style.textDecoration = '';
      row.querySelector('span:last-child').style.opacity = '';
    }
  }

  selBtn.onclick = () => {
    const all = list.querySelectorAll('input[type=checkbox]');
    const allChecked = [...all].every(c => c.checked);
    all.forEach((c, i) => {
      c.checked = !allChecked;
      if (!allChecked) _trMainSelected.add(i); else _trMainSelected.delete(i);
      _applyRowStyle(rows[i], i);
    });
    _updateTrMainDeleteBtn();
  };

  delBtn.onclick = () => {
    if (!_trMainSelected.size) return;
    if (!confirm(`${_trMainSelected.size} segment silinecek. Emin misiniz?`)) return;
    const remaining = result.segments.filter((_, i) => !_trMainSelected.has(i));
    result.segments = remaining;
    _currentTranscriptResult = result;
    _trMainSelected.clear();
    _renderTrMainTab();
    _renderTranscriptBody();
    if (cleanBtn) cleanBtn.style.display = '';
  };

  if (playBtn) {
    playBtn.onclick = () => {
      if (_trPlayer.playing) {
        _trPlayer.audioOffset = _trPlayerCurrentTime();
        _trPlayerStop();
      } else {
        const startTime = result.segments[0]?.start ?? 0;
        _trPlayerPlay(result.segments, rows, startTime);
      }
    };
  }

  if (cleanBtn) {
    cleanBtn.onclick = () => {
      if (_trPlayer.playing) { _trPlayerStop(); cleanBtn.textContent = '▶ Temizlenmiş Dinle'; }
      else { _trPlayerPlayCleaned(result.segments); }
    };
  }

  list.innerHTML = '';
  result.segments.forEach((seg, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:6px 4px;border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;transition:background 0.1s';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.style.cssText = 'margin-top:4px;flex-shrink:0;accent-color:#ef4444;cursor:pointer';
    cb.addEventListener('change', () => {
      if (cb.checked) _trMainSelected.add(i); else _trMainSelected.delete(i);
      _applyRowStyle(row, i);
      _updateTrMainDeleteBtn();
    });

    const ts = document.createElement('span');
    ts.style.cssText = 'min-width:60px;color:var(--text-dim);font-size:11px;font-family:monospace;flex-shrink:0;margin-top:3px';
    ts.textContent = formatTime(seg.start).substring(0, 8);

    const txt = document.createElement('span');
    txt.style.cssText = 'flex:1;font-size:14px;line-height:1.7;color:var(--text)';

    // Kelime bazlı render (words varsa)
    if (seg.words && seg.words.length) {
      seg.words.forEach((w, wi) => {
        const ws = document.createElement('span');
        ws.className = 'tr-word';
        ws.textContent = w.word + ' ';
        ws.title = `${w.start.toFixed(2)}s – ${w.end.toFixed(2)}s`;
        ws.dataset.segIdx  = i;
        ws.dataset.wordIdx = wi;
        ws.dataset.start   = w.start;
        ws.dataset.end     = w.end;
        ws.dataset.word    = w.word;
        // Tıklama → o saniyeye git
        ws.addEventListener('click', e => {
          e.stopPropagation();
          seekTo(w.start);
        });
        // Sağ tık → context menu
        ws.addEventListener('contextmenu', e => {
          e.preventDefault();
          e.stopPropagation();
          _showWordContextMenu(e, w, ws);
        });
        txt.appendChild(ws);
      });
    } else {
      txt.textContent = seg.text;
    }

    row.appendChild(cb);
    row.appendChild(ts);
    if (seg.speaker) {
      const spk = document.createElement('span');
      spk.style.cssText = 'font-size:11px;color:#818cf8;font-weight:600;flex-shrink:0;min-width:55px;margin-top:3px';
      spk.textContent = seg.speaker.replace('SPEAKER_', 'K');
      row.appendChild(spk);
    }
    row.appendChild(txt);

    row.addEventListener('click', e => {
      if (e.target === cb || e.target.classList.contains('tr-word')) return;
      cb.checked = !cb.checked;
      if (cb.checked) _trMainSelected.add(i); else _trMainSelected.delete(i);
      _applyRowStyle(row, i);
      _updateTrMainDeleteBtn();
    });

    rows.push(row);
    list.appendChild(row);
  });
}

function _updateTrMainDeleteBtn() {
  const delBtn  = document.getElementById('tr-main-delete-btn');
  const selCount = document.getElementById('tr-main-sel-count');
  if (!delBtn) return;
  delBtn.style.display = _trMainSelected.size > 0 ? '' : 'none';
  if (selCount) selCount.textContent = _trMainSelected.size;
}

function _updateTvButtons() {
  ['segments','words','text'].forEach(mode => {
    const btn = $(`tv-${mode}`);
    if (!btn) return;
    const active = mode === _transcriptView;
    btn.style.background = active ? '#1e3a5f' : 'transparent';
    btn.style.color       = active ? '#60a5fa' : '#64748b';
    btn.style.borderColor = active ? '#3b82f6' : '#1e293b';
  });
  const btnCut = $('btn-cut-selected');
  if (btnCut) {
    btnCut.style.display = _transcriptView === 'words' ? '' : 'none';
  }
}

function _renderTranscriptBody() {
  if (!_currentTranscriptResult) return;
  transcriptSegments.innerHTML = '';
  _selectedWords.clear();
  _lastShiftIdx = null;
  _updateCutCount();
  if (_transcriptView === 'segments') _renderSegmentsView();
  else if (_transcriptView === 'words') _renderWordsView();
  else _renderTextView();
}

function _renderSegmentsView() {
  const result = _currentTranscriptResult;
  result.segments.forEach(seg => {
    const conf = seg.avg_logprob > -0.5 ? 'var(--text)' : seg.avg_logprob > -1 ? 'var(--text-dim)' : '#ef5350';
    const div  = document.createElement('div');
    div.style.cssText = 'display:flex;gap:8px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer';
    div.innerHTML = `
      <span style="min-width:52px;color:var(--text-dim);font-size:9px;font-family:monospace;flex-shrink:0;margin-top:2px">${formatTime(seg.start).substring(0,8)}</span>
      <span style="color:${conf};flex:1;font-size:11px;line-height:1.5">${escHtml(seg.text)}</span>`;
    div.addEventListener('click', () => seekTo(seg.start));
    transcriptSegments.appendChild(div);
  });
}

function _renderWordsView() {
  const result = _currentTranscriptResult;
  const words  = result.words || [];
  if (!words.length) {
    transcriptSegments.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim);font-size:11px">Kelime bazlı veri yok — "Segmentler" görünümünü kullanın</div>';
    return;
  }

  // CSS ekle
  if (!document.getElementById('tw-style')) {
    const s = document.createElement('style');
    s.id = 'tw-style';
    s.textContent = '.tw{cursor:pointer;padding:1px 3px;border-radius:2px;display:inline;line-height:2}.tw:hover{background:rgba(59,130,246,0.15)}.tw.tw-sel{background:rgba(239,68,68,0.3)!important;color:#fca5a5!important;border-radius:3px}';
    document.head.appendChild(s);
  }

  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:9px;color:#475569;padding:4px 4px 8px;';
  hint.textContent = 'Tıkla = seç/kaldır   Shift+Tıkla = aralık seç   Seçili kelimeleri ✂️ ile kes';
  transcriptSegments.appendChild(hint);

  const container = document.createElement('div');
  container.style.cssText = 'line-height:2.1;font-size:12.5px;padding:4px;word-break:break-word;';

  words.forEach((w, idx) => {
    const span = document.createElement('span');
    span.className   = 'tw';
    span.dataset.idx = idx;
    span.textContent = w.word + (w.word.endsWith(' ') ? '' : ' ');
    span.title       = `${formatTime(w.start).substring(0,8)} – ${formatTime(w.end).substring(0,8)}  p=${Math.round((w.prob||0)*100)}%`;

    span.addEventListener('click', e => {
      if (e.shiftKey && _lastShiftIdx !== null) {
        const lo = Math.min(_lastShiftIdx, idx), hi = Math.max(_lastShiftIdx, idx);
        for (let i = lo; i <= hi; i++) {
          const s = container.querySelector(`[data-idx="${i}"]`);
          if (s) { _selectedWords.add(i); s.classList.add('tw-sel'); }
        }
      } else {
        if (_selectedWords.has(idx)) { _selectedWords.delete(idx); span.classList.remove('tw-sel'); }
        else                         { _selectedWords.add(idx);    span.classList.add('tw-sel'); }
        _lastShiftIdx = idx;
      }
      _updateCutCount();
    });

    container.appendChild(span);
  });

  transcriptSegments.appendChild(container);
}

function _renderTextView() {
  const result = _currentTranscriptResult;
  const ta = document.createElement('textarea');
  ta.style.cssText = 'width:100%;height:calc(100% - 8px);background:#0a1120;border:none;color:#cbd5e1;font-size:12px;line-height:1.8;padding:8px;resize:none;font-family:inherit;outline:none;box-sizing:border-box;';
  ta.readOnly  = false;
  ta.spellcheck = false;
  let text = '';
  result.segments.forEach(seg => { text += `[${formatTime(seg.start).substring(0,8)}]  ${seg.text.trim()}\n\n`; });
  ta.value = text;
  transcriptSegments.style.height = '100%';
  transcriptSegments.appendChild(ta);
}

function _updateCutCount() {
  const btn = $('btn-cut-selected');
  const cnt = $('cut-sel-count');
  if (!btn) return;
  const n = _selectedWords.size;
  if (cnt) cnt.textContent = n ? ` (${n})` : '';
  btn.disabled = n === 0;
}

function _cutSelectedWords() {
  const result = _currentTranscriptResult;
  if (!result) return;
  const words = result.words || [];
  const list  = [..._selectedWords].sort((a,b) => a-b).map(i => words[i]).filter(Boolean);
  if (!list.length) return;

  // Bitişik/yakın kelimeleri birleştir
  const GAP  = 0.08;
  const segs = [];
  let cur    = { start: list[0].start, end: list[0].end };
  for (let i = 1; i < list.length; i++) {
    const w = list[i];
    if (w.start - cur.end <= GAP) { cur.end = Math.max(cur.end, w.end); }
    else {
      segs.push({ start: +cur.start.toFixed(3), end: +cur.end.toFixed(3), action: 'delete', label: 'Metin kesimi' });
      cur = { start: w.start, end: w.end };
    }
  }
  segs.push({ start: +cur.start.toFixed(3), end: +cur.end.toFixed(3), action: 'delete', label: 'Metin kesimi' });

  addLog('ok', `${list.length} sözcük seçildi → ${segs.length} kesim bölgesi oluşturuldu`);
  showApprovalModal(segs, null);
}

async function reEnrichWithTranscript(transcript) {
  try {
    // Whisper sonucunun özeti — tüm kelimeler gönderilmez, sadece stats + ilk metin
    const compactTranscript = {
      language:     transcript.language,
      duration_sec: transcript.duration_sec,
      model:        transcript.model,
      full_text:    transcript.full_text,
      stats:        transcript.stats,
    };

    const res = await fetch('/api/analyze/enrich', {
      method:  'POST',
      headers: {'Content-Type': 'application/json'},
      body:    JSON.stringify({
        analysis:   state.analysis,
        features:   { duration: state.audioBuffer?.duration || 0 },
        transcript: compactTranscript,
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.success && data.ollama_enriched) {
      state.analysis = data.analysis;
      renderAnalysis(data.analysis);
      addLog('ok', `Ollama transkript ile yeniden zenginleştirdi${data.analysis.content_summary ? ' — özet eklendi' : ''}`);
      aiStatusBadge.textContent = `✓ Transkript + Ollama ✦`;
    }
  } catch(err) {
    addLog('warn', 'Yeniden zenginleştirme hatası: ' + err.message);
  }
}

// Dosya yüklendiğinde Transkript butonunu aktifleştir (loadFile'dan sonra çağrılır)
const _origOnAudioLoaded = onAudioLoaded;
// loadFile içinde onAudioLoaded çağrısını ekle:
const _origFileChange = fileInput.onchange;
fileInput.addEventListener('change', () => setTimeout(onAudioLoaded, 500));

// ── Frontend Debug — durumu sunucuya raporla ─────────────────────────────────
setInterval(async () => {
  if (_pipeStepBusy) return; // Pipeline adımı çalışırken debug polling yapma
  try {
    const pipeState = await loadPipelineStateFromDB().catch(() => null);
    const stepKeys = Object.keys(window._stepAudioSnapshots || {});
    const report = {
      time: new Date().toLocaleTimeString('tr-TR'),
      project: _currentProjectName || localStorage.getItem('current_project_name') || '',
      rawFile: _rawFileBlob?.name || null,
      rawSize: _rawFileBlob ? +(_rawFileBlob.size/1024/1024).toFixed(1) : 0,
      audioDur: state.audioBuffer ? +state.audioBuffer.duration.toFixed(1) : 0,
      pipelineDoneSteps: pipeState?.doneSteps || [],
      cutSegmentsCount: pipeState?.cutSegments?.length || 0,
      stepAudioInMemory: stepKeys,
      modalOpen: !!document.getElementById('noisegate-modal'),
      pipeProg: document.getElementById('ng-pipeline-progress')?.style?.display || 'yok',
      pipeProgChildren: document.getElementById('ng-pipeline-progress')?.childElementCount || 0,
      errors: window._lastErrors || []
    };
    await fetch('/api/debug', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(report) });
  } catch(_) {}
}, 5000);

// Hataları yakala
window._lastErrors = [];
window.addEventListener('error', e => {
  window._lastErrors.push({ msg: e.message, file: e.filename?.split('/').pop(), line: e.lineno, time: new Date().toLocaleTimeString('tr-TR') });
  if (window._lastErrors.length > 10) window._lastErrors.shift();
});
