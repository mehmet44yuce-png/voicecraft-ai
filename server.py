"""
VoiceCraft AI — Python Backend
Analiz: Python + Whisper + Ollama
"""

import os
from dotenv import load_dotenv
load_dotenv()
# os.environ['CUDA_VISIBLE_DEVICES'] = ''  # CUDA tamamen kapat — OOM önlemi (RTX 5070 Ti: kapalı)
# GPU bellek sınırı — ekranın donmasını önler
os.environ['PYTORCH_CUDA_ALLOC_CONF'] = 'max_split_size_mb:512'

# GPU clock sınırı — laptop ekranı kararmasın (%80 max)
import subprocess as _sp
try:
    _sp.run(['nvidia-smi', '-lgc', '300,2470'], capture_output=True, timeout=5)
    print('[GPU] Clock sınırı ayarlandı: max 2470 MHz (%80)')
except Exception:
    pass
import re
import sys
import json
import time
import uuid
import logging
import threading
import urllib.request
import urllib.error
from json_repair import repair_json
import subprocess
import tempfile
from flask import Flask, request, jsonify, send_from_directory, send_file, after_this_request


import collections
import soundfile as sf
import pyloudnorm as pyln

# ── In-memory log buffer (son 300 satır) ─────────────────────────────────────
_log_buffer = collections.deque(maxlen=300)

class _BufHandler(logging.Handler):
    def emit(self, record):
        try:
            _log_buffer.append({
                'ts':    time.strftime('%H:%M:%S'),
                'level': record.levelname,
                'msg':   record.getMessage(),
            })
        except Exception:
            pass

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)
_bh = _BufHandler()
_bh.setLevel(logging.DEBUG)
logging.getLogger().addHandler(_bh)

# FFmpeg PATH — winget ile kurulduğunda PATH güncellemesi için yeni terminal gerekir.
# Kurulum yolunu doğrudan ekleyerek bu sorunu aşıyoruz.
_FFMPEG_DIR = os.path.expandvars(
    r'%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1-full_build\bin'
)
if os.path.isdir(_FFMPEG_DIR) and _FFMPEG_DIR not in os.environ.get('PATH', ''):
    os.environ['PATH'] = _FFMPEG_DIR + os.pathsep + os.environ.get('PATH', '')

app = Flask(__name__, static_folder='public', static_url_path='')
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0  # JS/CSS cache'i kapat — geliştirme modu
app.config['MAX_CONTENT_LENGTH'] = 15 * 1024 * 1024 * 1024  # 15 GB

# ── Whisper — lazy yükleme ──────────────────────────────────────────────────────
_whisper_model  = None
_whisper_lock   = threading.Lock()
WHISPER_MODEL_NAME = os.environ.get('WHISPER_MODEL', 'large')

# Arka plan transkripsiyon işleri: {job_id: {status, progress, result, error}}
_transcription_jobs: dict = {}

_whisper_model_name_loaded = None

def get_whisper(model_name=None):
    """faster-whisper modelini ilk kullanımda yükle (lazy). model_name değişince yeniden yükle."""
    global _whisper_model, _whisper_model_name_loaded
    target = model_name or WHISPER_MODEL_NAME
    if _whisper_model is not None and _whisper_model_name_loaded == target:
        return _whisper_model
    with _whisper_lock:
        if _whisper_model is not None and _whisper_model_name_loaded == target:
            return _whisper_model
        from faster_whisper import WhisperModel
        log.info(f"[whisper] faster-whisper yükleniyor: {target} → CUDA/int8_float16")
        _whisper_model = WhisperModel(target, device='cuda', compute_type='int8_float16')
        _whisper_model_name_loaded = target
        log.info(f"[whisper] Model hazır: {target}")
        return _whisper_model


def _transcribe_job(job_id: str, audio_path: str, language: str | None):
    """Arka planda çalışan transkripsiyon iş parçacığı."""
    job = _transcription_jobs[job_id]
    try:
        job['status']   = 'loading_model'
        job['progress'] = 5
        model = get_whisper(job.get('model'))

        job['status']   = 'transcribing'
        job['progress'] = 10
        job['step']     = 'Ses analiz ediliyor...'
        job['step_text'] = ''
        job['seg_count'] = 0
        log.info(f"[whisper] Job {job_id}: transkripsiyon başlıyor, model={WHISPER_MODEL_NAME}")

        t0 = time.time()

        def _iter_segs(gen, audio_dur):
            """Generator'ı iterate et, her segment sonrası progress güncelle."""
            segs = []
            for seg in gen:
                segs.append(seg)
                if audio_dur and audio_dur > 0:
                    pct = min(90, int(10 + (seg.end / audio_dur) * 80))
                else:
                    pct = min(90, job['progress'] + 2)
                job['progress']  = pct
                job['seg_count'] = len(segs)
                job['step']      = f"{int(seg.end//60):02d}:{int(seg.end%60):02d} / {int(audio_dur//60):02d}:{int(audio_dur%60):02d}" if audio_dur else f"{seg.end:.0f}s"
                job['step_text'] = seg.text.strip()[:60]
                log.info(f"[whisper] seg {len(segs)}: {seg.start:.1f}-{seg.end:.1f}s | {seg.text.strip()[:40]}")
            return segs

        try:
            fw_segs_gen, info = model.transcribe(
                audio_path,
                language=language,
                task='transcribe',
                word_timestamps=True,
                condition_on_previous_text=True,
            )
            audio_dur = info.duration if hasattr(info, 'duration') and info.duration else 0
            fw_segs = _iter_segs(fw_segs_gen, audio_dur)
        except RuntimeError as e:
            if 'out of memory' in str(e).lower() or 'cuda' in str(e).lower():
                log.warning(f"[whisper] CUDA OOM, VAD kapatılıp tekrar deneniyor: {e}")
                fw_segs_gen, info = model.transcribe(
                    audio_path,
                    language=language,
                    task='transcribe',
                    word_timestamps=True,
                    condition_on_previous_text=False,
                    vad_filter=False,
                )
                audio_dur = info.duration if hasattr(info, 'duration') and info.duration else 0
                fw_segs = _iter_segs(fw_segs_gen, audio_dur)
            else:
                raise
        elapsed = round(time.time() - t0, 1)
        log.info(f"[whisper] Job {job_id}: tamamlandı {elapsed}s, {len(fw_segs)} segment")

        # Sonucu işle
        segments  = []
        words_all = []
        for seg in fw_segs:
            segments.append({
                'id':             seg.id,
                'start':          round(seg.start, 3),
                'end':            round(seg.end, 3),
                'text':           seg.text.strip(),
                'avg_logprob':    round(seg.avg_logprob, 3),
                'no_speech_prob': round(seg.no_speech_prob, 3),
            })
            for w in (seg.words or []):
                words_all.append({
                    'word':  w.word.strip(),
                    'start': round(w.start, 3),
                    'end':   round(w.end, 3),
                    'prob':  round(w.probability, 3),
                })

        # İstatistikler
        total_words   = len(words_all)
        duration      = fw_segs[-1].end if fw_segs else 0
        speech_min    = duration / 60 if duration else 1
        words_per_min = round(total_words / speech_min) if speech_min else 0

        # Dolgu sözcük tespiti (Türkçe + İngilizce)
        FILLERS = {'um','uh','eh','ah','hmm','hm','şey','yani','işte','falan','filan',
                   'mm','mhm','huh','like','you know','so','actually','basically'}
        filler_hits = [w for w in words_all if w['word'].lower().strip('.,?!') in FILLERS]

        job['status']   = 'done'
        job['progress'] = 100
        job['result']   = {
            'language':     info.language if hasattr(info,'language') else 'unknown',
            'duration_sec': round(duration, 1),
            'model':        WHISPER_MODEL_NAME,
            'elapsed_sec':  elapsed,
            'full_text':    ' '.join(s['text'] for s in segments),
            'segments':     segments,
            'words':        words_all,
            'stats': {
                'total_words':   total_words,
                'words_per_min': words_per_min,
                'filler_count':  len(filler_hits),
                'filler_words':  filler_hits[:50],
                'segment_count': len(segments),
            },
        }

    except Exception as e:
        log.error(f"[whisper] Job {job_id} hata: {e}")
        job['status'] = 'error'
        job['error']  = str(e)
    finally:
        # Geçici dosyayı temizle
        try:
            os.unlink(audio_path)
        except Exception:
            pass

# ── System Prompt ──────────────────────────────────────────────────────────────

def python_analyze(features: dict) -> dict:
    """Amplitude verisinden doğrudan analiz yap — Ollama'ya gerek yok."""
    duration       = features.get('duration', 0)
    sample_rate    = features.get('sampleRate', 44100)
    channels       = features.get('channels', 1)
    amp            = features.get('amplitudeData', [])   # 100ms başına peak
    rms            = features.get('rmsEnergy', [])       # 200ms başına dBFS
    silence_periods= features.get('silencePeriods', [])
    freq           = features.get('frequencyBands', {'low':0.33,'mid':0.34,'high':0.33})
    peak_amp       = features.get('peakAmplitude', 0)
    avg_amp        = features.get('averageAmplitude', 0)

    interval = 0.1  # saniye başına amplitude sample

    # ── Noise events: ani yüksek amplitude spikeleri ──────────────────────────
    if amp:
        avg = sum(amp) / len(amp)
        spike_thr = max(avg * 3.0, 0.4)   # ortalamadan 3x yüksek veya 0.4+
    else:
        spike_thr = 0.4

    noise_events = []
    i = 0
    while i < len(amp):
        if amp[i] >= spike_thr:
            start_i = i
            while i < len(amp) and amp[i] >= spike_thr * 0.5:
                i += 1
            end_i = i
            dur_ms = int((end_i - start_i) * interval * 1000)
            start_sec = round(start_i * interval, 3)
            end_sec   = round(end_i   * interval, 3)
            peak      = max(amp[start_i:end_i])

            # Tür tahmini — süreye ve peak'e göre
            if dur_ms < 80:
                etype = 'keyboard'
            elif dur_ms < 300:
                etype = 'thump' if peak > 0.7 else 'click'
            elif dur_ms < 600:
                etype = 'cough'
            else:
                etype = 'sneeze' if peak > 0.6 else 'breath'

            # Sessizlik içinde mi? → delete, değilse attenuate
            in_silence = any(s['start'] <= start_sec <= s['end'] for s in silence_periods)
            rec = 'delete' if in_silence else 'attenuate'

            def fmt_ts(sec):
                h=int(sec//3600); m=int((sec%3600)//60); s=sec%60
                return f"{h:02d}:{m:02d}:{s:06.3f}"

            noise_events.append({
                'type': etype,
                'start': fmt_ts(start_sec), 'end': fmt_ts(end_sec),
                'start_sec': start_sec, 'end_sec': end_sec,
                'duration_ms': dur_ms,
                'confidence': round(min(0.95, peak / spike_thr * 0.7), 2),
                'low_confidence': peak < spike_thr * 1.2,
                'intensity': 'high' if peak > 0.7 else ('medium' if peak > 0.4 else 'low'),
                'recommendation': rec,
                'description': f'{etype} @ {start_sec:.1f}s peak={peak:.2f}',
            })
        else:
            i += 1

    # ── Silence segments ──────────────────────────────────────────────────────
    def fmt_ts(sec):
        h=int(sec//3600); m=int((sec%3600)//60); s=sec%60
        return f"{h:02d}:{m:02d}:{s:06.3f}"

    silence_segments = []
    for s in silence_periods:
        d = s['end'] - s['start']
        if d >= 1.0:
            silence_segments.append({
                'start': fmt_ts(s['start']), 'end': fmt_ts(s['end']),
                'start_sec': s['start'], 'end_sec': s['end'],
                'duration_ms': int(d * 1000),
                'recommendation': 'cut' if d > 3.0 else 'keep',
            })

    # ── Speaker segments: sessizlik olmayan bölgeler ──────────────────────────
    silence_set = set()
    for s in silence_periods:
        for idx in range(int(s['start']/interval), int(s['end']/interval)+1):
            silence_set.add(idx)

    speaker_segs = []
    in_speech = False
    seg_start = 0
    for idx in range(len(amp)):
        is_speech = idx not in silence_set and amp[idx] > 0.005
        if is_speech and not in_speech:
            seg_start = idx * interval
            in_speech = True
        elif not is_speech and in_speech:
            seg_end = idx * interval
            if seg_end - seg_start > 0.5:
                speaker_segs.append({'start': round(seg_start,2), 'end': round(seg_end,2),
                                     'confidence': 0.85, 'action': 'keep'})
            in_speech = False
    if in_speech:
        speaker_segs.append({'start': round(seg_start,2), 'end': round(duration,2),
                             'confidence': 0.85, 'action': 'keep'})

    # Çok fazla segment varsa birleştir (max 30)
    if len(speaker_segs) > 30:
        merged, prev = [], speaker_segs[0]
        for seg in speaker_segs[1:]:
            if seg['start'] - prev['end'] < 2.0:
                prev = {**prev, 'end': seg['end']}
            else:
                merged.append(prev); prev = seg
        merged.append(prev)
        speaker_segs = merged[:30]

    # ── İstatistikler ─────────────────────────────────────────────────────────
    total_silence = sum(s['end'] - s['start'] for s in silence_periods)
    total_noise   = sum(e['duration_ms']/1000 for e in noise_events)
    total_speech  = max(0, duration - total_silence - total_noise)
    sp_pct  = round(total_speech  / duration * 100) if duration else 0
    sil_pct = round(total_silence / duration * 100) if duration else 0
    noi_pct = round(total_noise   / duration * 100) if duration else 0

    rms_vals  = [r for r in rms if r > -90]
    avg_rms   = round(sum(rms_vals)/len(rms_vals), 1) if rms_vals else -40
    noise_floor = round(sorted(rms_vals)[:max(1,len(rms_vals)//10)][-1], 1) if rms_vals else -60
    snr       = round(avg_rms - noise_floor, 1)
    quality   = min(100, max(0, int(50 + snr * 1.5 - len(noise_events) * 0.5)))

    clipping  = peak_amp >= 0.99
    high_freq_ratio = freq.get('high', 0)
    env = 'studio' if high_freq_ratio < 0.15 else ('office' if high_freq_ratio < 0.3 else 'home')

    h=int(duration//3600); m=int((duration%3600)//60); s_=int(duration%60)
    dur_str = f"{h:02d}:{m:02d}:{s_:02d}"
    sp_h=int(total_speech//3600); sp_m=int((total_speech%3600)//60); sp_s=int(total_speech%60)

    # Cut list: büyük noise eventleri ve uzun sessizlikler
    cut_list = []
    for e in noise_events:
        if e['recommendation'] == 'delete':
            cut_list.append({'start': e['start'], 'end': e['end'],
                             'reason': e['type'], 'transition': 'crossfade'})
    for ss in silence_segments:
        if ss['recommendation'] == 'cut':
            cut_list.append({'start': ss['start'], 'end': ss['end'],
                             'reason': 'long silence', 'transition': 'crossfade'})

    priority_actions = []
    if noise_events: priority_actions.append(f"{len(noise_events)} gürültü olayı tespit edildi")
    if clipping:     priority_actions.append("Kırpma tespit edildi — seviye düşürün")
    priority_actions.append(f"Normalize: -16 dBFS hedef")
    if snr < 15:     priority_actions.append("Gürültü azaltma önerilir (SNR düşük)")

    return {
        'metadata': {
            'duration_total': dur_str,
            'duration_speech': f"{sp_h:02d}:{sp_m:02d}:{sp_s:02d}",
            'duration_noise': fmt_ts(total_noise),
            'quality_score': quality,
            'overall_quality': 'good' if quality>70 else ('fair' if quality>50 else 'poor'),
            'environment': env,
            'microphone_quality': 'high' if snr>25 else ('medium' if snr>15 else 'low'),
            'noise_floor_db': noise_floor,
            'clipping_detected': clipping,
            'clipping_severity': 'high' if clipping else 'none',
        },
        'summary': {
            'total_noise_events': len(noise_events),
            'speech_percentage': sp_pct,
            'noise_percentage': noi_pct,
            'silence_percentage': sil_pct,
            'priority_actions': priority_actions,
        },
        'speakers': [{'id':'SPEAKER_01','pitch_range':{'min':100,'max':300},
                      'speech_rate':130,'silence_ratio':sil_pct,
                      'emotional_tone':'neutral','pitch_variation':'stable'}],
        'layers': [
            {'id':'speaker',          'name':'Speaker Voice',    'color':'#4fc3f7', 'segments': speaker_segs},
            {'id':'background_noise', 'name':'Background Noise', 'color':'#ef5350',
             'segments': [{'start':e['start_sec'],'end':e['end_sec'],'confidence':e['confidence'],'action':e['recommendation']}
                          for e in noise_events if e['type'] in ('thump','click','keyboard')]},
            {'id':'breath_sounds',    'name':'Breath',           'color':'#ffa726',
             'segments': [{'start':e['start_sec'],'end':e['end_sec'],'confidence':e['confidence'],'action':e['recommendation']}
                          for e in noise_events if e['type'] in ('breath','sneeze','cough')]},
            {'id':'ambient',          'name':'Ambient',          'color':'#66bb6a', 'segments':[]},
            {'id':'music',            'name':'Music',            'color':'#ab47bc', 'segments':[]},
        ],
        'noise_events': noise_events,
        'silence_segments': silence_segments,
        'corrections': {
            'normalize_target_db': -16,
            'eq_suggestions': ['Cut 80-120Hz 6dB (rumble)', 'Boost 2-4kHz 3dB (clarity)'],
            'compression': {'threshold': -24, 'ratio': '4:1'},
            'reverb_detected': False, 'reverb_severity': 'none',
        },
        'cut_list': cut_list,
        'content_classification': {
            'format': 'podcast', 'language': 'tr', 'speech_tone': 'informal',
            'recommended_platform': 'Podcast', 'lufs_target': -16,
        },
        'loudness': {
            'integrated_lufs': avg_rms,
            'true_peak_dbtp': round(20 * (peak_amp if peak_amp > 0 else 0.001), 1) if peak_amp else -1,
            'loudness_range_lra': 8.0, 'ebu_r128_compliant': False,
        },
        'warnings': (['CLIPPING_DETECTED'] if clipping else []) + (['LOW_SNR'] if snr < 10 else []),
        'user_confirmations_required': [],
    }


def extract_json(text: str) -> dict:
    """Extract JSON object from Claude's response text."""
    text = text.strip()
    # Remove markdown code blocks if present
    code_block = re.search(r'```(?:json)?\s*([\s\S]*?)```', text)
    if code_block:
        text = code_block.group(1).strip()
    # Find the outermost JSON object
    brace_match = re.search(r'\{[\s\S]*\}', text)
    if brace_match:
        text = brace_match.group(0)
    # Try standard parse first
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        log.warning(f"[extract_json] Standard parse failed ({e}), trying json_repair...")
        repaired = repair_json(text, return_objects=True)
        if isinstance(repaired, dict):
            log.info("[extract_json] json_repair succeeded")
            return repaired
        raise


def ensure_valid_structure(a: dict, duration: float) -> dict:
    """Model boş bırakırsa zorunlu alanları doldur."""
    LAYER_DEFAULTS = [
        {'id': 'speaker',          'name': 'Speaker Voice',    'color': '#4fc3f7'},
        {'id': 'background_noise', 'name': 'Background Noise', 'color': '#ef5350'},
        {'id': 'breath_sounds',    'name': 'Breath',           'color': '#ffa726'},
        {'id': 'ambient',          'name': 'Ambient',          'color': '#66bb6a'},
        {'id': 'music',            'name': 'Music',            'color': '#ab47bc'},
    ]
    # Layers — eksik veya boş ise varsayılan oluştur
    layers = a.get('layers', [])
    layer_ids = {l.get('id') for l in layers}
    for ld in LAYER_DEFAULTS:
        if ld['id'] not in layer_ids:
            layers.append({**ld, 'segments': []})
    # Speaker layer'ın segmenti yoksa tüm dosyayı kapsasın
    for l in layers:
        if l.get('id') == 'speaker' and not l.get('segments'):
            l['segments'] = [{'start': 0.0, 'end': round(duration, 3),
                              'confidence': 0.8, 'action': 'keep'}]
    a['layers'] = layers
    # Zorunlu boş listeler
    a.setdefault('noise_events', [])
    a.setdefault('silence_segments', [])
    a.setdefault('warnings', [])
    a.setdefault('user_confirmations_required', [])
    # Metadata
    meta = a.setdefault('metadata', {})
    meta.setdefault('quality_score', 70)
    meta.setdefault('overall_quality', 'good')
    meta.setdefault('environment', 'unknown')
    h = int(duration // 3600)
    m = int((duration % 3600) // 60)
    s = int(duration % 60)
    meta.setdefault('duration_total', f'{h:02d}:{m:02d}:{s:02d}')
    # Summary
    summ = a.setdefault('summary', {})
    summ.setdefault('total_noise_events', len(a.get('noise_events', [])))
    summ.setdefault('speech_percentage', 75)
    summ.setdefault('noise_percentage', 5)
    summ.setdefault('silence_percentage', 20)
    summ.setdefault('priority_actions', ['Normalize to -16 dBFS'])
    return a


OLLAMA_URL   = 'http://localhost:11434/api/generate'
OLLAMA_MODEL = 'mistral-nemo:12b'


def ollama_generate(system: str, prompt: str) -> str:
    """Call Ollama with streaming — collect tokens until done or } found."""
    payload = json.dumps({
        'model': OLLAMA_MODEL,
        'system': system,
        'prompt': prompt,
        'stream': True,
        'options': {
            'temperature': 0.05,
            'num_predict': 8192,
            'stop': ['\n\n\n', '```']
        }
    }).encode()
    req = urllib.request.Request(OLLAMA_URL, data=payload,
                                  headers={'Content-Type': 'application/json'})
    try:
        chunks = []
        with urllib.request.urlopen(req, timeout=900) as resp:
            for raw_line in resp:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                token = obj.get('response', '')
                chunks.append(token)
                if obj.get('done', False):
                    break
                # Early exit: JSON complete when outermost } closes
                text_so_far = ''.join(chunks)
                if len(text_so_far) > 200:
                    stripped = text_so_far.rstrip()
                    if stripped.endswith('}') and stripped.count('{') <= stripped.count('}'):
                        log.info('[ollama] JSON complete — stopping early')
                        break
        result = ''.join(chunks)
        log.info(f'[ollama] Generated {len(result)} chars')
        return result
    except urllib.error.URLError as e:
        raise RuntimeError(f'Ollama bağlantı hatası: {e}')


@app.route('/api/models', methods=['GET'])
def list_models():
    """List available Ollama models."""
    try:
        req = urllib.request.Request('http://localhost:11434/api/tags')
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            models = [m['name'] for m in data.get('models', [])]
            return jsonify({'success': True, 'models': models})
    except Exception as e:
        return jsonify({'success': False, 'models': [], 'error': str(e)})


# ── Ollama Transkript Temizleme ─────────────────────────────────────────────────

@app.route('/api/transcript/clean', methods=['POST'])
def transcript_clean():
    """
    Whisper transkriptini Ollama (mistral-nemo:12b) ile temizle.
    Noktalama düzelt, dolgu kelimeleri sil (eeee, şey, yani, işte vb.)
    """
    data     = request.get_json(force=True)
    segments = data.get('segments', [])
    if not segments:
        return jsonify({'success': False, 'error': 'Segment bulunamadı'}), 400

    lines = []
    for seg in segments:
        spk  = seg.get('speaker', '').strip()
        txt  = seg.get('text', '').strip()
        t0   = seg.get('start', 0)
        t1   = seg.get('end', 0)
        ts   = f"[{int(t0)//60:02d}:{int(t0)%60:02d}]"
        line = f"{ts} [{spk}]: {txt}" if spk else f"{ts} {txt}"
        lines.append(line)
    full_text = '\n'.join(lines)

    system = (
        "Sen bir Türkçe transkript düzeltici aracısın.\n"
        "KESİNLİKLE UYULMASI GEREKEN KURALLAR:\n"
        "- Her satırı AYNEN koru. Satır sayısı DEĞİŞMEMELİ.\n"
        "- Zaman damgalarını ([MM:SS]) ve konuşmacı etiketlerini ([SPEAKER_XX]) HİÇ DEĞİŞTİRME.\n"
        "- Cümle anlamını, kelime sırasını ve içeriği DEĞİŞTİRME.\n"
        "- SADECE şunları yap:\n"
        "  a) Noktalama ekle (nokta, virgül, soru/ünlem işareti).\n"
        "  b) Dolgu seslerini sil: 'eee', 'ıı', 'mmm', 'hmm', 'şey', 'hani'.\n"
        "  c) Arka arkaya tekrarlanan aynı kelimeyi teke indir (kekemelik).\n"
        "- Bunlar dışında HİÇBİR kelimeyi ekleme, silme veya değiştirme.\n"
        "- Açıklama, yorum veya ek metin YAZMA. Sadece düzeltilmiş satırları döndür."
    )
    prompt = f"{full_text}"

    try:
        log.info(f"[transcript/clean] Ollama temizleme başlıyor: {len(segments)} segment")
        cleaned = ollama_generate(system, prompt)
        log.info(f"[transcript/clean] Tamamlandı: {len(cleaned)} karakter")
        return jsonify({'success': True, 'cleaned': cleaned, 'model': OLLAMA_MODEL})
    except Exception as e:
        log.error(f"[transcript/clean] Hata: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


# ── Whisper Transkripsiyon Endpoints ───────────────────────────────────────────

@app.route('/api/transcribe/start', methods=['POST'])
def transcribe_start():
    """
    Ses dosyasını kabul et, arka planda Whisper transkripsiyon işi başlat.
    Döner: {job_id} — durumu /api/transcribe/status/<job_id> ile sorgulanır.
    """
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Dosya bulunamadı'}), 400

    f          = request.files['file']
    language   = request.form.get('language') or None   # None → otomatik tespit
    model_req  = request.form.get('model') or WHISPER_MODEL_NAME

    # Geçici dosyaya kaydet
    import tempfile
    suffix     = os.path.splitext(f.filename or 'audio')[1] or '.audio'
    tmp_path   = os.path.join(tempfile.gettempdir(), f'whisper_tmp_{int(time.time())}{suffix}')
    f.save(tmp_path)
    size_mb    = round(os.path.getsize(tmp_path) / 1024 / 1024, 1)
    log.info(f"[transcribe] Dosya kaydedildi: {tmp_path} ({size_mb}MB), model={model_req}, lang={language}")

    job_id = f"job_{int(time.time()*1000)}"
    _transcription_jobs[job_id] = {
        'status':    'queued',
        'progress':  0,
        'model':     model_req,
        'file_size': size_mb,
        'started_at': time.time(),
        'result':    None,
        'error':     None,
    }

    # Arka plan iş parçacığı başlat
    t = threading.Thread(
        target=_transcribe_job,
        args=(job_id, tmp_path, language),
        daemon=True,
    )
    t.start()

    return jsonify({'success': True, 'job_id': job_id, 'model': model_req, 'size_mb': size_mb})


@app.route('/api/transcribe/status/<job_id>', methods=['GET'])
def transcribe_status(job_id):
    """Transkripsiyon iş durumunu döndür."""
    job = _transcription_jobs.get(job_id)
    if not job:
        return jsonify({'success': False, 'error': 'İş bulunamadı'}), 404

    resp = {
        'success':   True,
        'job_id':    job_id,
        'status':    job['status'],
        'progress':  job['progress'],
        'step':      job.get('step', ''),
        'step_text': job.get('step_text', ''),
        'seg_count': job.get('seg_count', 0),
        'model':     job.get('model'),
        'file_size': job.get('file_size'),
        'elapsed':   round(time.time() - job.get('started_at', time.time()), 1),
    }
    if job['status'] == 'done':
        resp['result'] = job['result']
    elif job['status'] == 'error':
        resp['error'] = job['error']
    return jsonify(resp)


@app.route('/api/transcribe/models', methods=['GET'])
def transcribe_models():
    """Kullanılabilir Whisper model listesi ve tahmini süreler."""
    models = [
        {'id': 'tiny',   'label': 'Tiny',   'size': '75MB',   'est_min_per_hour': 2},
        {'id': 'base',   'label': 'Base',   'size': '145MB',  'est_min_per_hour': 5},
        {'id': 'small',  'label': 'Small',  'size': '461MB',  'est_min_per_hour': 12},
        {'id': 'medium', 'label': 'Medium', 'size': '1.4GB',  'est_min_per_hour': 36},
        {'id': 'large',  'label': 'Large',  'size': '2.9GB',  'est_min_per_hour': 90},
    ]
    return jsonify({'success': True, 'models': models, 'current': WHISPER_MODEL_NAME})


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory('public', 'index.html')


def ollama_enrich(python_result: dict, features: dict, transcript: dict | None = None) -> dict | None:
    """
    Python analizini Ollama ile zenginleştir.
    transcript varsa (Whisper sonucu) çok daha zengin analiz üretilir.
    Hata durumunda None döner.
    """
    duration   = features.get('duration', 0)
    noise_evs  = python_result.get('noise_events', [])
    meta       = python_result.get('metadata', {})
    summ       = python_result.get('summary', {})
    freq       = features.get('frequencyBands', {})

    noise_types = list(dict.fromkeys(e['type'] for e in noise_evs))
    silence_cnt = len(python_result.get('silence_segments', []))

    compact = {
        'duration_sec':      round(duration, 1),
        'quality_score':     meta.get('quality_score', 70),
        'environment':       meta.get('environment', 'unknown'),
        'clipping':          meta.get('clipping_detected', False),
        'noise_floor_db':    meta.get('noise_floor_db', -40),
        'speech_pct':        summ.get('speech_percentage', 0),
        'noise_pct':         summ.get('noise_percentage', 0),
        'silence_pct':       summ.get('silence_percentage', 0),
        'noise_event_count': len(noise_evs),
        'noise_types':       noise_types,
        'silence_segments':  silence_cnt,
        'freq_low':          round(freq.get('low', 0), 3),
        'freq_mid':          round(freq.get('mid', 0), 3),
        'freq_high':         round(freq.get('high', 0), 3),
    }

    # Whisper transkripsiyon özeti (varsa)
    transcript_section = ''
    if transcript:
        stats      = transcript.get('stats', {})
        full_text  = transcript.get('full_text', '')
        preview    = full_text[:500] + ('...' if len(full_text) > 500 else '')
        filler_cnt = stats.get('filler_count', 0)
        wpm        = stats.get('words_per_min', 0)
        lang       = transcript.get('language', 'unknown')
        transcript_section = f"""

Whisper transkripsiyon özeti:
- Dil: {lang}
- Kelime/dakika: {wpm}
- Dolgu sözcük sayısı: {filler_cnt}
- Toplam kelime: {stats.get('total_words', 0)}
- İlk 500 karakter: {preview}"""

    system = """Sen profesyonel bir ses mühendisi ve içerik analistisin.
Sana verilen ses analiz özetini ve (varsa) transkripsiyon verisini yorumla.
JSON formatında kısa, pratik Türkçe çıktı üret.
SADECE JSON döndür, başka hiçbir metin yazma."""

    extra_fields = ''
    if transcript:
        extra_fields = '''
  "content_summary": "içeriğin tek cümle Türkçe özeti",
  "speech_quality": "konuşma kalitesi değerlendirmesi",
  "filler_assessment": "dolgu sözcük kullanımı hakkında yorum",'''

    prompt = f"""Ses analiz özeti:
{json.dumps(compact, ensure_ascii=False)}{transcript_section}

Aşağıdaki JSON şablonunu doldur:
{{
  "scenario": "podcast|interview|lecture|presentation|meeting|audiobook|field|music",
  "scenario_notes": "tek cümle Türkçe açıklama",
  "priority_actions": ["öncelik 1", "öncelik 2", "öncelik 3"],
  "eq_suggestions": ["EQ önerisi 1", "EQ önerisi 2"],
  "noise_assessment": "gürültü durumu hakkında tek cümle Türkçe",
  "recommendations": ["tavsiye 1", "tavsiye 2", "tavsiye 3"],
  "microphone_type": "dynamic|condenser|lavalier|unknown",
  "recording_quality_note": "kayıt kalitesi hakkında tek cümle Türkçe"{extra_fields}
}}"""

    try:
        has_transcript = transcript is not None
        log.info(f"[enrich] Ollama zenginleştirme başlıyor (transkript={'var' if has_transcript else 'yok'})...")
        raw = ollama_generate(system, prompt)
        enrichment = extract_json(raw)
        log.info(f"[enrich] Ollama yanıtı: senaryo={enrichment.get('scenario','?')}")
        return enrichment
    except Exception as e:
        log.warning(f"[enrich] Ollama başarısız (Python sonucu kullanılacak): {e}")
        return None


def merge_enrichment(analysis: dict, enrichment: dict) -> dict:
    """Ollama zenginleştirmesini Python analizinin üzerine uygula."""
    if not enrichment:
        return analysis

    # Senaryo
    if enrichment.get('scenario'):
        analysis['scenario_detected'] = enrichment['scenario']
        analysis['scenario_notes']    = enrichment.get('scenario_notes', '')

    # Öncelik aksiyonları
    if enrichment.get('priority_actions'):
        analysis.setdefault('summary', {})['priority_actions'] = enrichment['priority_actions']

    # EQ önerileri
    if enrichment.get('eq_suggestions'):
        analysis.setdefault('corrections', {})['eq_suggestions'] = enrichment['eq_suggestions']

    # Mikrofon türü
    if enrichment.get('microphone_type'):
        analysis.setdefault('metadata', {})['microphone_type'] = enrichment['microphone_type']

    # Genel tavsiyeler
    if enrichment.get('recommendations'):
        analysis['recommendations'] = enrichment['recommendations']

    # Gürültü ve kalite notları
    if enrichment.get('noise_assessment'):
        analysis.setdefault('metadata', {})['noise_assessment'] = enrichment['noise_assessment']
    if enrichment.get('recording_quality_note'):
        analysis.setdefault('metadata', {})['recording_quality_note'] = enrichment['recording_quality_note']

    # Whisper tabanlı alanlar (sadece transkripsiyon varsa Ollama bunları doldurur)
    if enrichment.get('content_summary'):
        analysis['content_summary'] = enrichment['content_summary']
    if enrichment.get('speech_quality'):
        analysis.setdefault('metadata', {})['speech_quality'] = enrichment['speech_quality']
    if enrichment.get('filler_assessment'):
        analysis.setdefault('metadata', {})['filler_assessment'] = enrichment['filler_assessment']

    return analysis


@app.route('/api/analyze', methods=['POST'])
def analyze():
    """
    Receives extracted audio features from Web Audio API.
    1) python_analyze() — hızlı, güvenilir temel analiz
    2) ollama_enrich()  — akıllı yorum ve öneriler (opsiyonel)
    """
    data = request.get_json(force=True)
    features = data.get('features', {})

    if not features or not features.get('duration'):
        return jsonify({'success': False, 'error': 'Ses özellikleri bulunamadı'}), 400

    duration    = features.get('duration', 0)
    amp_samples = len(features.get('amplitudeData', []))
    log.info(f"[analyze] {duration:.1f}s ses, {amp_samples} amplitude örneği")

    try:
        # ── 1. Python analizi (hızlı) ──────────────────────────────────────────
        log.info("[analyze] Python analizi başlıyor...")
        analysis = python_analyze(features)
        ev_count  = len(analysis.get('noise_events', []))
        log.info(f"[analyze] Python tamamlandı. NoiseEvents={ev_count}")

        # ── 2. Ollama zenginleştirme (akıllı yorum) ───────────────────────────
        enrichment = ollama_enrich(analysis, features)
        analysis   = merge_enrichment(analysis, enrichment)
        ollama_ok  = enrichment is not None

        log.info(f"[analyze] Analiz hazır. Ollama={'✓' if ollama_ok else '✗ (Python fallback)'}")
        return jsonify({
            'success':         True,
            'analysis':        analysis,
            'stop_reason':     'stop',
            'ollama_enriched': ollama_ok,
            'tokens_used':     0,
        })

    except Exception as e:
        log.error(f"[analyze] Hata: {type(e).__name__}: {e}")
        return jsonify({'success': False, 'error': f'{type(e).__name__}: {e}'}), 500


@app.route('/api/analyze/python', methods=['POST'])
def analyze_python_only():
    """
    Sadece Python analizi — hızlı ön sonuç.
    Frontend bunu alıp waveform'u gösterir, sonra /api/analyze/enrich çağırır.
    """
    data = request.get_json(force=True)
    features = data.get('features', {})
    if not features or not features.get('duration'):
        return jsonify({'success': False, 'error': 'Ses özellikleri bulunamadı'}), 400
    try:
        analysis = python_analyze(features)
        return jsonify({'success': True, 'analysis': analysis})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/analyze/enrich', methods=['POST'])
def analyze_enrich_only():
    """
    Mevcut Python analizini Ollama ile zenginleştir.
    Frontend /api/analyze/python sonucunu aldıktan sonra bunu çağırır.
    """
    data       = request.get_json(force=True)
    analysis   = data.get('analysis', {})
    features   = data.get('features', {})
    transcript = data.get('transcript')   # Whisper sonucu — opsiyonel
    if not analysis:
        return jsonify({'success': False, 'error': 'Analiz verisi bulunamadı'}), 400
    try:
        enrichment = ollama_enrich(analysis, features, transcript=transcript)
        if enrichment:
            analysis = merge_enrichment(analysis, enrichment)
            return jsonify({'success': True, 'analysis': analysis, 'ollama_enriched': True,
                            'transcript_used': transcript is not None})
        else:
            return jsonify({'success': True, 'analysis': analysis, 'ollama_enriched': False,
                            'transcript_used': False})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/command', methods=['POST'])
def command():
    """
    Natural language audio editing commands.
    """
    data = request.get_json(force=True)
    cmd = (data.get('command') or '').strip()
    analysis_ctx = data.get('analysisContext') or {}

    if not cmd:
        return jsonify({'success': False, 'error': 'No command provided'}), 400

    ev_count = len(analysis_ctx.get('events', []))
    lay_count = len(analysis_ctx.get('layers', []))
    dur = analysis_ctx.get('summary', {}).get('duration', 0)

    system_prompt = f"""You are a professional AI audio editing assistant.

Current analysis context:
- {ev_count} detected events across {lay_count} layers
- Duration: {dur:.1f}s

Full context:
{json.dumps(analysis_ctx, indent=2)[:3000]}

Respond ONLY with valid JSON (no markdown, no text outside JSON):
{{
  "action": "delete_events|attenuate_events|keep_only|silence_trim|normalize|custom",
  "targets": ["event_type_1"],
  "parameters": {{"attenuate_db": -20}},
  "description": "Human readable description",
  "affected_segments": [
    {{"start": 0.0, "end": 0.5, "action": "delete", "type": "sneeze", "confidence": 0.95}}
  ],
  "estimated_quality_improvement": "Description of improvement"
}}"""

    try:
        raw = ollama_generate(system_prompt, cmd)
        result = extract_json(raw)
        return jsonify({'success': True, 'result': result})
    except json.JSONDecodeError as e:
        return jsonify({'success': False, 'error': f'JSON parse hatası: {e}'}), 500
    except Exception as e:
        log.error(f"[command] Hata: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


# ── Ses İşleme (FFmpeg) ────────────────────────────────────────────────────────

@app.route('/api/process', methods=['POST'])
def process_audio():
    """
    Ham ses dosyası + segment listesi alır, FFmpeg ile işler, temiz dosyayı döner.
    Segments: [{start, end, action: 'delete'|'attenuate', attenuate_db?: number}]
    """
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Dosya bulunamadı'}), 400

    f = request.files['file']
    try:
        segments = json.loads(request.form.get('segments', '[]'))
    except Exception:
        segments = []

    normalize_lufs = request.form.get('normalize_lufs')
    try:
        normalize_lufs = float(normalize_lufs) if normalize_lufs else None
    except Exception:
        normalize_lufs = None

    voice_boost = request.form.get('voice_boost')
    try:
        voice_boost = float(voice_boost) if voice_boost else 1.0
        voice_boost = max(0.1, min(8.0, voice_boost))  # güvenli aralık
    except Exception:
        voice_boost = 1.0

    boost_segments = request.form.get('boost_segments')
    try:
        boost_segments = json.loads(boost_segments) if boost_segments else []
        boost_segments = [
            {
                'start': float(b['start']),
                'end':   float(b['end']),
                'db':    float(b.get('db', 6.0)),
            }
            for b in boost_segments
            if float(b.get('end', 0)) > float(b.get('start', 0))
        ]
    except Exception:
        boost_segments = []

    auto_boost = request.form.get('auto_boost', '').lower() == 'true'

    suffix  = os.path.splitext(f.filename or 'audio')[1] or '.audio'
    tmp_in  = os.path.join(tempfile.gettempdir(), f'vc_in_{int(time.time())}{suffix}')
    tmp_out = os.path.join(tempfile.gettempdir(), f'vc_out_{int(time.time())}.mp3')
    f.save(tmp_in)
    log.info(f"[process] Dosya alındı: {tmp_in}, {len(segments)} segment")

    # boost_segments boşsa ve auto_boost isteniyorsa otomatik tespit et
    if not boost_segments and auto_boost:
        try:
            tmp_16k = tmp_in + '_16k.wav'
            r = subprocess.run(
                ['ffmpeg', '-y', '-i', tmp_in, '-ar', '16000', '-ac', '1', tmp_16k],
                capture_output=True, timeout=120)
            if r.returncode == 0:
                detected = _detect_low_volume(tmp_16k)
                boost_segments = [
                    {'start': s['start'], 'end': s['end'], 'db': s['suggested_db']}
                    for s in detected
                ]
                log.info(f"[process] Auto-boost: {len(boost_segments)} düşük sesli bölge tespit edildi")
            try:
                os.unlink(tmp_16k)
            except Exception:
                pass
        except Exception as e:
            log.warning(f"[process] Auto-boost başarısız: {e}")

    try:
        # Geçerli segmentleri filtrele
        valid = []
        for s in segments:
            try:
                start = float(s.get('start', 0))
                end   = float(s.get('end', 0))
                if end > start:
                    valid.append({'start': start, 'end': end,
                                  'action': s.get('action', 'delete'),
                                  'db': float(s.get('attenuate_db', -20))})
            except Exception:
                pass

        # FFmpeg filtresi:
        # - delete → aselect ile zaman aralığını gerçekten keser (süreyi kısaltır)
        # - attenuate → volume filtresi ile ses seviyesini düşürür
        del_segs = [s for s in valid if s['action'] == 'delete']
        att_segs = [s for s in valid if s['action'] != 'delete']

        filters = []

        # Attenuate: volume filtresi
        if att_segs:
            expr = '1'
            for seg in reversed(att_segs):
                vol = round(10 ** (seg['db'] / 20), 4)
                expr = f"if(between(t,{seg['start']},{seg['end']}),{vol},{expr})"
            filters.append(f"volume='{expr}'")

        # Delete segmentlerini hesapla — concat demuxer VEYA aselect (segment sayısına göre)
        tmp_concat = None
        if del_segs and (len(del_segs) > 30 or att_segs):
            # Çok sayıda silme: concat demuxer kullan (aselect filter string limiti yok)
            # Silme bölgelerini KORUMA bölgelerine çevir
            all_del = sorted(del_segs, key=lambda s: s['start'])
            # Ses süresini ffprobe ile al
            probe = subprocess.run(
                ['ffprobe','-v','error','-show_entries','format=duration',
                 '-of','default=noprint_wrappers=1:nokey=1', tmp_in],
                capture_output=True, text=True)
            total_dur = float(probe.stdout.strip() or '0') or 99999.0
            # keep_parts = del bölgelerinin tersi
            keep_parts, cursor = [], 0.0
            for d in all_del:
                if d['start'] > cursor + 0.01:
                    keep_parts.append((cursor, d['start']))
                cursor = max(cursor, d['end'])
            if cursor < total_dur - 0.01:
                keep_parts.append((cursor, total_dur))

            tmp_concat = tmp_in + '_concat.txt'
            with open(tmp_concat, 'w', encoding='utf-8') as fh:
                for start, end in keep_parts:
                    fh.write(f"file '{tmp_in.replace(chr(92), '/')}'\n")
                    fh.write(f"inpoint {start:.3f}\n")
                    fh.write(f"outpoint {end:.3f}\n")

            # Attenuate, voice boost, normalize varsa ek -af
            extra_filters = []
            if att_segs:
                expr = '1'
                for seg in reversed(att_segs):
                    vol = round(10 ** (seg['db'] / 20), 4)
                    expr = f"if(between(t,{seg['start']},{seg['end']}),{vol},{expr})"
                extra_filters.append(f"volume='{expr}'")
            if boost_segments:
                expr = '1'
                for b in reversed(boost_segments):
                    gain_lin = round(10 ** (b['db'] / 20), 4)
                    expr = f"if(between(t,{b['start']},{b['end']}),{gain_lin},{expr})"
                extra_filters.append(f"volume='{expr}'")
            if voice_boost != 1.0:
                extra_filters.append(f"volume={voice_boost:.3f}")
            if normalize_lufs is not None:
                extra_filters.append(f"loudnorm=I={normalize_lufs:.0f}:TP=-1.5:LRA=11")

            cmd = ['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', tmp_concat]
            if extra_filters:
                cmd += ['-af', ','.join(extra_filters)]
            cmd += ['-q:a', '2', tmp_out]

        else:
            # Az segment — klasik aselect filtresi
            if del_segs:
                not_parts = '+'.join([f"between(t,{s['start']},{s['end']})" for s in del_segs])
                filters.append(f"aselect='not({not_parts})',asetpts=N/SR/TB")
            if boost_segments:
                expr = '1'
                for b in reversed(boost_segments):
                    gain_lin = round(10 ** (b['db'] / 20), 4)
                    expr = f"if(between(t,{b['start']},{b['end']}),{gain_lin},{expr})"
                filters.append(f"volume='{expr}'")
            if voice_boost != 1.0:
                filters.append(f"volume={voice_boost:.3f}")
            if normalize_lufs is not None:
                filters.append(f"loudnorm=I={normalize_lufs:.0f}:TP=-1.5:LRA=11")
            if filters:
                cmd = ['ffmpeg', '-y', '-i', tmp_in, '-af', ','.join(filters), '-q:a', '2', tmp_out]
            else:
                cmd = ['ffmpeg', '-y', '-i', tmp_in, '-q:a', '2', tmp_out]

        log.info(f"[process] FFmpeg başlıyor: {len(valid)} segment, concat={'evet' if tmp_concat else 'hayır'}")
        result = subprocess.run(cmd, capture_output=True, timeout=600)
        if tmp_concat:
            try: os.unlink(tmp_concat)
            except Exception: pass
        if result.returncode != 0:
            err = result.stderr.decode('utf-8', errors='replace')
            log.error(f"[process] FFmpeg hatası: {err[-500:]}")
            raise RuntimeError('FFmpeg başarısız: ' + err[-400:])

        size_mb = round(os.path.getsize(tmp_out) / 1024 / 1024, 1)
        log.info(f"[process] Tamamlandı: {tmp_out} ({size_mb}MB)")

        # İndirme sonrası geçici dosyaları temizle
        @after_this_request
        def cleanup(response):
            try: os.unlink(tmp_in)
            except Exception: pass
            try: os.unlink(tmp_out)
            except Exception: pass
            return response

        out_name = os.path.splitext(f.filename or 'ses')[0] + '_temizlendi.mp3'
        resp = send_file(tmp_out, mimetype='audio/mpeg', as_attachment=True,
                         download_name=out_name)
        _attach_quality_header(resp, tmp_out)
        return resp

    except Exception as e:
        log.error(f"[process] Hata: {e}")
        try: os.unlink(tmp_in)
        except Exception: pass
        return jsonify({'success': False, 'error': str(e)}), 500


# ── Silero VAD ─────────────────────────────────────────────────────────────────

_vad_model = None
_vad_lock  = threading.Lock()

def get_vad_model():
    global _vad_model
    import torch
    _vad_dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    if _vad_model is not None:
        return _vad_model
    with _vad_lock:
        if _vad_model is not None:
            return _vad_model
        from silero_vad import load_silero_vad
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        try:
            _vad_model, _ = torch.hub.load(
                repo_or_dir='snakers4/silero-vad',
                model='silero_vad',
                force_reload=False,
                verbose=False,
            )
        except Exception:
            _vad_model = load_silero_vad()
        _vad_model = _vad_model.to(_vad_dev).eval()
        log.info(f'[vad] Silero VAD yüklendi — device: {next(_vad_model.parameters()).device}')
        return _vad_model


_vad_jobs = {}   # job_id → {status, pct, step, result, error}

_VAD_SUBPROCESS_SCRIPT = r"""
import sys, json
import torch
import soundfile as sf
import numpy as np

audio_path = sys.argv[1]

device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
torch.set_num_threads(1 if device.type == 'cuda' else 4)

def _load_vad_model():
    try:
        from silero_vad import load_silero_vad, get_speech_timestamps
        m = load_silero_vad()
        m = m.to(device).eval()
        return m, get_speech_timestamps
    except ImportError:
        pass
    m, utils = torch.hub.load('snakers4/silero-vad', 'silero_vad',
                              force_reload=False, onnx=False, trust_repo=True, verbose=False)
    m = m.to(device).eval()
    return m, utils[0]

try:
    print(json.dumps({'progress': 15, 'step': f'VAD modeli yükleniyor ({device})...'}), flush=True)
    model, get_speech_timestamps = _load_vad_model()
    print(json.dumps({'progress': 40, 'step': 'Ses dosyası okunuyor...'}), flush=True)
    data, sr = sf.read(audio_path)
    if data.ndim > 1: data = data.mean(axis=1)
    wav = torch.from_numpy(data.astype(np.float32))
    if sr != 16000:
        import torchaudio.functional as TAF
        wav = TAF.resample(wav, sr, 16000)
        sr = 16000
    wav = wav.to(device)
    dur = round(wav.shape[0] / sr, 1)
    print(json.dumps({'progress': 60, 'step': f'Analiz ediliyor... ({dur}s, {device})'}), flush=True)
    _vad_th = float(sys.argv[2]) if len(sys.argv) > 2 else 0.25
    _vad_min_sp = int(sys.argv[3]) if len(sys.argv) > 3 else 40
    _vad_min_si = int(sys.argv[4]) if len(sys.argv) > 4 else 500
    with torch.no_grad():
        ts = get_speech_timestamps(wav, model, return_seconds=True, sampling_rate=16000,
                                   min_silence_duration_ms=_vad_min_si,
                                   min_speech_duration_ms=_vad_min_sp,
                                   threshold=_vad_th)
    segs = [{'start': round(t['start'], 3), 'end': round(t['end'], 3)} for t in ts]
    print(json.dumps({'done': True, 'segments': segs, 'method': f'silero_{device}'}), flush=True)
except Exception as e:
    print(json.dumps({'error': str(e)}), flush=True)
"""

def _run_vad_job(job_id, tmp, vad_params=None):
    job = _vad_jobs[job_id]
    tmp_wav = tmp.rsplit('.', 1)[0] + '_16k.wav'
    try:
        job['pct'] = 5; job['step'] = 'ffmpeg: 16kHz WAV oluşturuluyor...'
        r_conv = subprocess.run(
            ['ffmpeg', '-y', '-i', tmp, '-ar', '16000', '-ac', '1', tmp_wav],
            capture_output=True, timeout=120)
        input_path = tmp_wav if r_conv.returncode == 0 else tmp
        if r_conv.returncode != 0:
            log.warning(f'[vad] ffmpeg dönüşüm başarısız, orijinal dosya kullanılıyor: {tmp}')

        job['pct'] = 10; job['step'] = 'Subprocess başlatılıyor (GPU varsa CUDA)...'

        env = {**os.environ}
        vp = vad_params or {}
        proc = subprocess.Popen(
            [sys.executable, '-c', _VAD_SUBPROCESS_SCRIPT, input_path,
             str(vp.get('threshold', 0.25)),
             str(vp.get('min_speech_ms', 40)),
             str(vp.get('min_silence_ms', 500))],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env=env
        )

        segs, method = None, 'silero_vad'
        fallback = False

        job['pct'] = 20; job['step'] = 'VAD modeli yükleniyor (CPU, CUDA kapalı)...'

        import select as _select
        import time as _time
        _deadline = _time.monotonic() + 300  # 300 sn timeout

        while True:
            remaining = _deadline - _time.monotonic()
            if remaining <= 0:
                log.warning('[vad] Subprocess zaman aşımı, CPU fallback deneniyor...')
                proc.kill()
                fallback = True
                break
            if proc.poll() is not None:
                # Process bitti, kalan stdout'u oku
                for line in proc.stdout:
                    line = line.strip()
                    if not line: continue
                    try:
                        d = json.loads(line)
                        if 'progress' in d:
                            job['pct'] = d['progress']; job['step'] = d.get('step', '…')
                        elif d.get('done') and 'segments' in d:
                            segs = d['segments']; method = d.get('method', 'silero_vad')
                        elif d.get('fallback'):
                            fallback = True
                        elif 'error' in d:
                            raise RuntimeError(d['error'])
                    except json.JSONDecodeError:
                        pass
                break
            line = proc.stdout.readline()
            if not line:
                _time.sleep(0.2)
                continue
            line = line.strip()
            if not line: continue
            try:
                d = json.loads(line)
                if 'progress' in d:
                    job['pct'] = d['progress']; job['step'] = d.get('step', '…')
                elif d.get('done') and 'segments' in d:
                    segs = d['segments']; method = d.get('method', 'silero_vad')
                elif d.get('fallback'):
                    fallback = True
                elif 'error' in d:
                    raise RuntimeError(d['error'])
            except json.JSONDecodeError:
                pass

        if proc.poll() is None:
            proc.kill()
        stderr_out = proc.stderr.read() if proc.poll() is not None else ''
        if proc.returncode not in (None, 0) and segs is None and not fallback:
            log.warning(f'[vad] Subprocess başarısız (returncode={proc.returncode}), CPU fallback deneniyor: {stderr_out[-200:]}')
            fallback = True

        # Subprocess başarısız → librosa enerji tabanlı VAD (model indirmez, her zaman çalışır)
        if fallback or segs is None:
            job['pct'] = 45; job['step'] = 'Librosa VAD (CPU) kullanılıyor...'
            log.info('[vad] librosa enerji tabanlı VAD kullanılıyor...')
            import librosa as _librosa
            import numpy as _np
            job['pct'] = 55; job['step'] = 'Ses yükleniyor...'
            y, sr = _librosa.load(tmp, sr=16000, mono=True)
            job['pct'] = 65; job['step'] = 'Enerji analizi yapılıyor...'
            hop = 512
            rms = _librosa.feature.rms(y=y, hop_length=hop)[0]
            times = _librosa.frames_to_time(_np.arange(len(rms)), sr=sr, hop_length=hop)
            threshold = _np.percentile(rms, 30)
            min_speech = int(0.1 * sr / hop)   # 100ms
            min_silence = int(0.3 * sr / hop)  # 300ms
            segs, in_seg, seg_start, silence_count = [], False, 0.0, 0
            for i, (t, r) in enumerate(zip(times, rms)):
                if not in_seg and r > threshold:
                    in_seg = True; seg_start = t; silence_count = 0
                elif in_seg:
                    if r <= threshold:
                        silence_count += 1
                        if silence_count >= min_silence:
                            dur_frames = i - silence_count - int(seg_start * sr / hop)
                            if dur_frames >= min_speech:
                                segs.append({'start': round(seg_start, 3),
                                             'end': round(t - silence_count * hop / sr, 3)})
                            in_seg = False
                    else:
                        silence_count = 0
            if in_seg and times[-1] - seg_start > 0.1:
                segs.append({'start': round(seg_start, 3), 'end': round(float(times[-1]), 3)})
            method = 'librosa_vad'

        job['pct'] = 90; job['step'] = 'Sonuçlar işleniyor...'
        total = round(sum(s['end'] - s['start'] for s in segs), 1)
        job['pct'] = 100; job['status'] = 'done'
        job['step'] = f'Tamamlandı! {len(segs)} konuşma bölgesi · {total}s konuşma'
        job['result'] = {'success': True, 'segments': segs, 'method': method,
                         'count': len(segs), 'total_speech_sec': total}
        log.info(f'[vad] {method}: {len(segs)} bölge')

    except Exception as e:
        job['status'] = 'error'; job['error'] = str(e); job['step'] = f'Hata: {e}'
        log.error(f'[vad] Hata: {e}')
    finally:
        for _p in [tmp, tmp_wav]:
            try: os.unlink(_p)
            except Exception: pass


@app.route('/api/vad', methods=['POST'])
def vad_analyze():
    """Silero VAD — async job başlat, /api/vad/progress/<job_id> ile takip et."""
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Dosya bulunamadı'}), 400
    f      = request.files['file']
    suffix = os.path.splitext(f.filename or 'audio')[1] or '.audio'
    job_id = uuid.uuid4().hex[:10]
    tmp    = os.path.join(tempfile.gettempdir(), f'vad_{job_id}{suffix}')
    f.save(tmp)
    # Opsiyonel parametreler (ses analizinden gelen)
    vad_params = {
        'threshold': float(request.form.get('threshold', 0.25)),
        'min_speech_ms': int(request.form.get('min_speech_ms', 40)),
        'min_silence_ms': int(request.form.get('min_silence_ms', 500)),
    }
    _vad_jobs[job_id] = {'status': 'running', 'pct': 5, 'step': 'İş kuyruğa alındı...', 'result': None, 'error': None}
    threading.Thread(target=_run_vad_job, args=(job_id, tmp, vad_params), daemon=True).start()
    return jsonify({'success': True, 'job_id': job_id})


@app.route('/api/vad/progress/<job_id>')
def vad_progress(job_id):
    job = _vad_jobs.get(job_id)
    if not job:
        return jsonify({'status': 'error', 'error': 'Job bulunamadı'}), 404
    return jsonify(job)


# ── pyannote Konuşmacı Diarizasyonu ────────────────────────────────────────────

_diarize_pipeline = None
_diarize_lock     = threading.Lock()


_diar_jobs = {}  # job_id → {status, pct, step, result, error}

def _run_diar_job(job_id, tmp, hf_token, num_speakers):
    job = _diar_jobs[job_id]
    global _diarize_pipeline
    try:
        import torch
        import soundfile as sf
        from pyannote.audio import Pipeline

        job['step'] = 'Model yükleniyor…'; job['pct'] = 5
        if _diarize_pipeline is None:
            with _diarize_lock:
                if _diarize_pipeline is None:
                    job['step'] = 'pyannote modeli indiriliyor / yükleniyor…'; job['pct'] = 8
                    _diarize_pipeline = Pipeline.from_pretrained(
                        'pyannote/speaker-diarization-3.1', token=hf_token)
                    if torch.cuda.is_available():
                        _diarize_pipeline = _diarize_pipeline.to(torch.device('cuda'))
                    log.info('[diarize] Pipeline hazır')

        job['step'] = 'Ses dosyası WAV formatına dönüştürülüyor…'; job['pct'] = 12
        wav_tmp = tmp + '_16k.wav'
        subprocess.run(
            ['ffmpeg', '-y', '-i', tmp, '-ar', '16000', '-ac', '1', '-f', 'wav', wav_tmp],
            capture_output=True, timeout=120)
        waveform, sample_rate = sf.read(wav_tmp)
        try: os.unlink(wav_tmp)
        except Exception: pass

        job['step'] = 'Ses tensörü hazırlanıyor…'; job['pct'] = 18
        waveform_tensor = torch.tensor(waveform, dtype=torch.float32).unsqueeze(0)
        audio_input = {'waveform': waveform_tensor, 'sample_rate': sample_rate}
        total_dur = waveform.shape[0] / sample_rate

        # pyannote hook → gerçek zamanlı ilerleme
        def _hook(step_name, step_artifact=None, file=None, total=None, completed=None):
            if completed is not None and total and total > 0:
                raw_pct = int(completed / total * 100)
                job['pct'] = min(95, 20 + int(raw_pct * 0.75))
                job['step'] = f'{step_name} — %{raw_pct}  ({completed}/{total} parça)'
            else:
                job['step'] = step_name

        diarize_kwargs = {'hook': _hook}
        if num_speakers:
            diarize_kwargs['num_speakers'] = int(num_speakers)

        job['step'] = 'pyannote analiz başlıyor…'; job['pct'] = 20
        diarization = _diarize_pipeline(audio_input, **diarize_kwargs)

        job['step'] = 'Sonuçlar işleniyor…'; job['pct'] = 97
        segs, speakers, idx = [], {}, 0
        annotation = diarization.speaker_diarization if hasattr(diarization, 'speaker_diarization') else diarization
        for turn, _, speaker in annotation.itertracks(yield_label=True):
            if speaker not in speakers:
                speakers[speaker] = idx; idx += 1
            segs.append({'start': round(turn.start, 3), 'end': round(turn.end, 3),
                         'speaker': speaker, 'speakerIdx': speakers[speaker]})

        log.info(f'[diarize] job={job_id} → {len(speakers)} konuşmacı, {len(segs)} bölge')
        job['result'] = {'success': True, 'segments': segs,
                         'speakers': list(speakers.keys()), 'speaker_count': len(speakers)}
        job['step'] = f'Tamamlandı! {len(speakers)} konuşmacı, {len(segs)} bölge tespit edildi.'
        job['pct'] = 100; job['status'] = 'done'
        # Diarizasyon bitti — GPU belleğini serbest bırak, VAD ve diğer işlemler için yer aç
        try:
            import torch
            if torch.cuda.is_available() and torch.cuda.is_initialized():
                torch.cuda.empty_cache()
                log.info('[diarize] CUDA cache temizlendi')
        except Exception:
            pass

    except ImportError:
        job['status'] = 'error'
        job['error'] = 'pyannote.audio kurulu değil. Terminal: pip install pyannote.audio'
    except Exception as e:
        log.error(f'[diarize] job={job_id} hata: {e}')
        job['status'] = 'error'; job['error'] = str(e)
    finally:
        try: os.unlink(tmp)
        except Exception: pass


_SPEECH_ONLY_SCRIPT = r"""
import sys, json
import torch
import soundfile as sf
import numpy as np

audio_path = sys.argv[1]
threshold  = float(sys.argv[2]) if len(sys.argv) > 2 else 0.30
min_ms     = int(sys.argv[3])   if len(sys.argv) > 3 else 50
pad_ms     = int(sys.argv[4])   if len(sys.argv) > 4 else 150

device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
torch.set_num_threads(1 if device.type == 'cuda' else 4)

def _load_silero():
    try:
        from silero_vad import load_silero_vad, get_speech_timestamps
        m = load_silero_vad()
        m = m.to(device).eval()
        return m, get_speech_timestamps, f'pip+{device}'
    except ImportError:
        pass
    m, utils = torch.hub.load('snakers4/silero-vad', 'silero_vad',
                              force_reload=False, onnx=False, trust_repo=True, verbose=False)
    m = m.to(device).eval()
    return m, utils[0], f'hub+{device}'

try:
    model, get_speech_timestamps, src = _load_silero()
    data, sr = sf.read(audio_path)
    if data.ndim > 1: data = data.mean(axis=1)
    wav = torch.from_numpy(data.astype(np.float32))
    if sr != 16000:
        import torchaudio.functional as TAF
        wav = TAF.resample(wav, sr, 16000)
        sr = 16000
    wav = wav.to(device)
    print(json.dumps({'progress': 50, 'step': f'VAD analiz ({src}, {round(wav.shape[0]/sr,1)}s)...'}), flush=True)
    with torch.no_grad():
        ts = get_speech_timestamps(wav, model, return_seconds=True, sampling_rate=16000,
                                   threshold=threshold,
                                   min_speech_duration_ms=min_ms,
                                   min_silence_duration_ms=400,
                                   speech_pad_ms=pad_ms)
    segs = [{'start': round(t['start'], 3), 'end': round(t['end'], 3)} for t in ts]
    print(json.dumps({'done': True, 'segments': segs}), flush=True)
except Exception as e:
    print(json.dumps({'error': str(e)}), flush=True)
"""

_so_jobs = {}   # job_id → {status, pct, step, result_path, orig_name, error}

def _run_so_job(job_id, tmp_in, tmp_16k, tmp_bp, tmp_out, tmp_concat,
                threshold, min_ms, pad_ms, bandpass, orig_name):
    job = _so_jobs[job_id]
    bp_path = tmp_16k
    try:
        # 1. ffmpeg dönüştür
        job['pct'] = 5;  job['step'] = '1/4 — ffmpeg: 16kHz mono WAV oluşturuluyor...'
        r = subprocess.run(['ffmpeg', '-y', '-i', tmp_in, '-ar', '16000', '-ac', '1', tmp_16k],
                           capture_output=True, timeout=120)
        if r.returncode != 0:
            raise RuntimeError('ffmpeg dönüştürme hatası: ' + r.stderr.decode('utf-8', errors='replace')[-200:])

        # 2. Band-pass filtresi (GPU önce, scipy fallback)
        job['pct'] = 20; job['step'] = '2/4 — Band-pass filtresi uygulanıyor (85Hz–7.4kHz)...'
        if bandpass:
            import soundfile as sf
            import numpy as np
            data, sr = sf.read(tmp_16k)
            _bp_done = False
            try:
                import torchaudio.functional as TAF
                _dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
                wav_t = torch.from_numpy(data.astype(np.float32)).unsqueeze(0).to(_dev)  # [1, N]
                wav_t = TAF.highpass_biquad(wav_t, sample_rate=sr, cutoff_freq=85.0)
                wav_t = TAF.lowpass_biquad(wav_t, sample_rate=sr, cutoff_freq=7400.0)
                sf.write(tmp_bp, wav_t.squeeze(0).cpu().numpy(), sr)
                del wav_t
                if _dev.type == 'cuda': torch.cuda.empty_cache()
                log.info(f'[so] GPU band-pass OK (device={_dev})')
                _bp_done = True
            except Exception as _e:
                log.warning(f'[so] GPU band-pass başarısız ({_e}), scipy fallback...')
            if not _bp_done:
                from scipy import signal as sp_signal
                nyq = sr / 2.0
                sos = sp_signal.butter(4, [60.0/nyq, min(8000.0/nyq, 0.99)], btype='band', output='sos')
                sf.write(tmp_bp, sp_signal.sosfilt(sos, data.astype(np.float32)), sr)
                log.info('[so] scipy band-pass OK')
            bp_path = tmp_bp

        # 3. VAD subprocess (Popen ile ilerleme takibi)
        job['pct'] = 30; job['step'] = '3/4 — Agresif VAD: konuşma bölgeleri tespit ediliyor...'
        env = {**os.environ}
        proc = subprocess.Popen(
            [sys.executable, '-c', _SPEECH_ONLY_SCRIPT, bp_path,
             str(threshold), str(min_ms), str(pad_ms)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env=env
        )
        import time as _time
        deadline = _time.monotonic() + 420
        segs = None
        while True:
            if _time.monotonic() > deadline:
                proc.kill(); raise RuntimeError('VAD zaman aşımı (420s)')
            if proc.poll() is not None:
                for line in proc.stdout:
                    line = line.strip()
                    if not line: continue
                    try:
                        d = json.loads(line)
                        if d.get('done'): segs = d['segments']
                        elif d.get('error'): raise RuntimeError('VAD hatası: ' + d['error'])
                        elif 'progress' in d:
                            pct = 30 + int(d['progress'] * 0.5)
                            job['pct'] = pct; job['step'] = f'3/4 — VAD: {d.get("step","...")}'
                    except json.JSONDecodeError: pass
                break
            try:
                line = proc.stdout.readline()
                if line:
                    line = line.strip()
                    try:
                        d = json.loads(line)
                        if d.get('done'): segs = d['segments']; proc.wait(); break
                        elif d.get('error'): raise RuntimeError('VAD hatası: ' + d['error'])
                        elif 'progress' in d:
                            pct = 30 + int(d['progress'] * 0.5)
                            job['pct'] = pct; job['step'] = f'3/4 — VAD %{d["progress"]}: {d.get("step","...")}'
                    except json.JSONDecodeError: pass
            except Exception: pass
            _time.sleep(0.1)

        if segs is None:
            stderr_out = proc.stderr.read()[-400:] if proc.stderr else ''
            raise RuntimeError(f'VAD çıktısı alınamadı. stderr: {stderr_out}')
        if not segs:
            raise RuntimeError('VAD hiç konuşma bölgesi bulamadı')
        log.info(f'[so] {len(segs)} segment')

        # 4. ffmpeg concat — segmentler arasına 120ms sessizlik ekle (doğal geçiş)
        job['pct'] = 85; job['step'] = f'4/4 — {len(segs)} konuşma bölgesi birleştiriliyor...'
        silence_path = bp_path.replace(chr(92), '/')
        with open(tmp_concat, 'w', encoding='utf-8') as fh:
            for i, s in enumerate(segs):
                # Her segmentin başına 85ms, sonuna 85ms pad (orijinal 60ms + 25ms nefes)
                start = max(0.0, s['start'] - 0.085)
                end   = s['end'] + 0.085
                fh.write(f"file '{silence_path}'\n")
                fh.write(f"inpoint {start:.3f}\noutpoint {end:.3f}\n")
        r2 = subprocess.run(
            ['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', tmp_concat,
             '-ar', '44100', '-q:a', '2', tmp_out],
            capture_output=True, timeout=240)
        if r2.returncode != 0:
            raise RuntimeError('ffmpeg concat hatası: ' + r2.stderr.decode('utf-8', errors='replace')[-200:])

        job['pct'] = 100; job['status'] = 'done'
        job['result_path'] = tmp_out; job['orig_name'] = orig_name
        log.info('[so] Tamamlandı')

    except Exception as e:
        job['status'] = 'error'; job['error'] = str(e)
        log.error(f'[so] Hata: {e}')
    finally:
        for p in [tmp_in, tmp_16k, tmp_bp, tmp_concat]:
            try: os.unlink(p)
            except Exception: pass

@app.route('/api/speech-only/start', methods=['POST'])
def speech_only_start():
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Dosya bulunamadı'}), 400
    f         = request.files['file']
    threshold = float(request.form.get('threshold', '0.30'))
    min_ms    = int(request.form.get('min_ms', '50'))
    pad_ms    = int(request.form.get('pad_ms', '150'))
    bandpass  = request.form.get('bandpass', 'true').lower() == 'true'

    ts  = int(time.time() * 1000)
    job_id = f'so_{ts}'
    suffix = os.path.splitext(f.filename or 'audio')[1] or '.mp3'
    tmp_in  = os.path.join(tempfile.gettempdir(), f'so_in_{ts}{suffix}')
    tmp_16k = os.path.join(tempfile.gettempdir(), f'so_16k_{ts}.wav')
    tmp_bp  = os.path.join(tempfile.gettempdir(), f'so_bp_{ts}.wav')
    tmp_out = os.path.join(tempfile.gettempdir(), f'so_out_{ts}.mp3')
    tmp_concat = os.path.join(tempfile.gettempdir(), f'so_concat_{ts}.txt')
    f.save(tmp_in)

    _so_jobs[job_id] = {'status': 'running', 'pct': 0, 'step': 'Başlatılıyor...', 'result_path': None, 'error': None}
    t = threading.Thread(target=_run_so_job, args=(
        job_id, tmp_in, tmp_16k, tmp_bp, tmp_out, tmp_concat,
        threshold, min_ms, pad_ms, bandpass, f.filename or 'ses'), daemon=True)
    t.start()
    return jsonify({'success': True, 'job_id': job_id})

@app.route('/api/speech-only/progress/<job_id>')
def speech_only_progress(job_id):
    job = _so_jobs.get(job_id)
    if not job:
        return jsonify({'error': 'Job bulunamadı'}), 404
    return jsonify({'status': job['status'], 'pct': job['pct'],
                    'step': job['step'], 'error': job.get('error')})

@app.route('/api/speech-only/download/<job_id>')
def speech_only_download(job_id):
    job = _so_jobs.get(job_id)
    if not job or job['status'] != 'done':
        return jsonify({'error': 'Hazır değil'}), 404
    orig = job.get('orig_name', 'ses')
    base = os.path.splitext(orig)[0]
    resp = send_file(job['result_path'], mimetype='audio/mpeg',
                     as_attachment=True, download_name=base + '_sadece_konusma.mp3')
    _attach_quality_header(resp, job['result_path'])
    @after_this_request
    def _cleanup(response):
        try: os.unlink(job['result_path'])
        except Exception: pass
        _so_jobs.pop(job_id, None)
        return response
    return resp


# ── Otomatik Kalite Kontrol ─────────────────────────────────────────────────────

def _quality_check(audio_path: str, transcript: dict | None = None) -> dict:
    """Ses ve konuşma bozukluğu analizi. Hafif — sadece numpy kullanır."""
    import numpy as np

    audio_issues  = []
    speech_issues = []
    recs = []

    try:
        data, sr = sf.read(audio_path)
    except Exception:
        return {'quality_score': 0, 'audio_issues': [], 'speech_issues': [],
                'summary': {'total_audio_issues': 0, 'total_speech_issues': 0,
                            'recommendations': ['Ses dosyası okunamadı']}}

    if data.ndim > 1:
        data = data.mean(axis=1)
    data = data.astype(np.float64)
    duration = len(data) / sr
    abs_data = np.abs(data)
    penalty = 0

    # ── 1) Clipping ──────────────────────────────────────────────────────
    clip_mask = abs_data >= 0.99
    if clip_mask.any():
        clip_idx = np.where(clip_mask)[0]
        # Bitişik clipping bölgelerini birleştir
        groups, start_i = [], clip_idx[0]
        for k in range(1, len(clip_idx)):
            if clip_idx[k] - clip_idx[k-1] > sr * 0.05:
                groups.append((start_i, clip_idx[k-1]))
                start_i = clip_idx[k]
        groups.append((start_i, clip_idx[-1]))
        for s_i, e_i in groups[:20]:
            audio_issues.append({
                'type': 'clipping', 'severity': 'high',
                'start': round(s_i / sr, 3), 'end': round(e_i / sr, 3),
                'description': f'Ses kırpılması (clipping) — {round((e_i-s_i)/sr*1000)}ms',
            })
        penalty += min(25, len(groups) * 3)
        recs.append('Ses kırpılması tespit edildi — kayıt seviyesini düşürün')

    # ── 2) DC offset ─────────────────────────────────────────────────────
    dc = float(np.mean(data))
    if abs(dc) > 0.01:
        audio_issues.append({
            'type': 'dc_offset', 'severity': 'medium',
            'start': 0, 'end': round(duration, 3),
            'description': f'DC offset: {dc:.4f}',
        })
        penalty += 5
        recs.append('DC offset algılandı — highpass filtre önerilir')

    # ── 3) Dropout (ses kopması) ─────────────────────────────────────────
    frame_len = int(sr * 0.02)  # 20ms pencere
    n_frames  = len(data) // frame_len
    if n_frames > 2:
        rms_frames = np.array([
            np.sqrt(np.mean(data[i*frame_len:(i+1)*frame_len] ** 2))
            for i in range(n_frames)
        ])
        avg_rms = float(rms_frames.mean())
        if avg_rms > 1e-6:
            for i in range(1, n_frames):
                if rms_frames[i-1] > avg_rms * 0.3 and rms_frames[i] < avg_rms * 0.05:
                    t = round(i * frame_len / sr, 3)
                    audio_issues.append({
                        'type': 'dropout', 'severity': 'high',
                        'start': t, 'end': round(t + 0.02, 3),
                        'description': f'Ses kopması — {t:.2f}s',
                    })
            drop_count = sum(1 for a in audio_issues if a['type'] == 'dropout')
            if drop_count:
                penalty += min(20, drop_count * 4)
                recs.append(f'{drop_count} ses kopması tespit edildi')

    # ── 4) Click/pop (1ms'den kısa spike) ────────────────────────────────
    if avg_rms > 1e-6 if n_frames > 2 else False:
        diff = np.abs(np.diff(data))
        spike_thr = avg_rms * 8
        spike_mask = diff > spike_thr
        if spike_mask.any():
            spike_idx = np.where(spike_mask)[0]
            # 1ms = sr/1000 sample
            ms_samples = sr // 1000
            click_count = 0
            i = 0
            while i < len(spike_idx):
                s_pos = spike_idx[i]
                e_pos = s_pos
                while i + 1 < len(spike_idx) and spike_idx[i+1] - spike_idx[i] < ms_samples:
                    i += 1
                    e_pos = spike_idx[i]
                if e_pos - s_pos < ms_samples:
                    click_count += 1
                    if click_count <= 10:
                        audio_issues.append({
                            'type': 'click', 'severity': 'low',
                            'start': round(s_pos / sr, 3), 'end': round(e_pos / sr, 3),
                            'description': f'Tıklama/pop — {round(s_pos/sr, 2)}s',
                        })
                i += 1
            if click_count > 0:
                penalty += min(10, click_count)

    # ── 5) Konuşma bozuklukları (transkript varsa) ───────────────────────
    if transcript:
        segments = transcript.get('segments', [])
        words    = transcript.get('words', [])
        stats    = transcript.get('stats', {})

        # 5a) Kekemelik — aynı kelime arka arkaya
        for i in range(1, len(words)):
            w1 = words[i-1].get('word', '').strip().lower().rstrip('.,?!')
            w2 = words[i].get('word', '').strip().lower().rstrip('.,?!')
            if w1 and w1 == w2:
                speech_issues.append({
                    'type': 'stutter', 'severity': 'low',
                    'start': words[i-1].get('start', 0), 'end': words[i].get('end', 0),
                    'word': w1,
                })
        stutter_count = sum(1 for s in speech_issues if s['type'] == 'stutter')
        if stutter_count:
            penalty += min(5, stutter_count)

        # 5b) Uzun sessizlik (cümle ortasında 1s+)
        for i in range(1, len(words)):
            gap = words[i].get('start', 0) - words[i-1].get('end', 0)
            if gap >= 1.0:
                speech_issues.append({
                    'type': 'long_pause', 'severity': 'medium',
                    'start': words[i-1].get('end', 0), 'end': words[i].get('start', 0),
                    'word': f'{gap:.1f}s sessizlik',
                })
        pause_count = sum(1 for s in speech_issues if s['type'] == 'long_pause')
        if pause_count > 3:
            penalty += min(5, pause_count - 3)
            recs.append(f'{pause_count} uzun sessizlik — kesim önerilir')

        # 5c) Konuşma hızı
        wpm = stats.get('words_per_min', 0)
        if wpm > 250:
            speech_issues.append({
                'type': 'fast_speech', 'severity': 'medium',
                'start': 0, 'end': round(duration, 3),
                'word': f'{wpm} kelime/dk',
            })
            penalty += 5
            recs.append(f'Konuşma hızı çok yüksek ({wpm} kelime/dk)')

        # 5d) Dolgu sesleri
        FILLERS = {'eee','ıı','mmm','hmm','şey','hani','yani','işte','falan'}
        filler_count = 0
        for w in words:
            wt = w.get('word', '').strip().lower().rstrip('.,?!')
            if wt in FILLERS:
                filler_count += 1
                if filler_count <= 10:
                    speech_issues.append({
                        'type': 'filler', 'severity': 'low',
                        'start': w.get('start', 0), 'end': w.get('end', 0),
                        'word': wt,
                    })
        if filler_count > 5:
            penalty += min(5, filler_count // 3)
            recs.append(f'{filler_count} dolgu sesi tespit edildi')

    score = max(0, min(100, 100 - penalty))
    return {
        'quality_score': score,
        'audio_issues':  audio_issues[:50],
        'speech_issues': speech_issues[:50],
        'summary': {
            'total_audio_issues':  len(audio_issues),
            'total_speech_issues': len(speech_issues),
            'recommendations':     recs if recs else ['Ses kalitesi iyi görünüyor'],
        },
    }


def _attach_quality_header(response, audio_path, transcript=None):
    """Response header'ına X-Quality-Check JSON ekle."""
    try:
        qc = _quality_check(audio_path, transcript)
        response.headers['X-Quality-Check'] = json.dumps(qc, ensure_ascii=True)
    except Exception as e:
        log.warning(f'[qc] Kalite kontrol atlandı: {e}')
    return response


@app.route('/api/quality-check', methods=['POST'])
def quality_check_endpoint():
    """Son ses dosyasının kalite kontrolünü yap."""
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Dosya bulunamadı'}), 400
    f = request.files['file']
    transcript_json = request.form.get('transcript')
    transcript = None
    if transcript_json:
        try:
            transcript = json.loads(transcript_json)
        except Exception:
            pass

    suffix = os.path.splitext(f.filename or 'audio')[1] or '.mp3'
    tmp_in = os.path.join(tempfile.gettempdir(), f'qc_{int(time.time()*1000)}{suffix}')
    tmp_wav = tmp_in.replace(suffix, '_16k.wav')
    f.save(tmp_in)
    try:
        r = subprocess.run(['ffmpeg', '-y', '-i', tmp_in, '-ar', '16000', '-ac', '1', tmp_wav],
                           capture_output=True, timeout=60)
        qc_path = tmp_wav if r.returncode == 0 else tmp_in
        result = _quality_check(qc_path, transcript)
        log.info(f'[qc] Kalite skoru: {result["quality_score"]}, '
                 f'ses={result["summary"]["total_audio_issues"]}, '
                 f'konuşma={result["summary"]["total_speech_issues"]}')
        return jsonify({'success': True, 'result': result})
    except Exception as e:
        log.error(f'[qc] Hata: {e}')
        return jsonify({'success': False, 'error': str(e)}), 500
    finally:
        for p in [tmp_in, tmp_wav]:
            try: os.unlink(p)
            except Exception: pass


# ── Düşük Sesli Bölge Tespiti ──────────────────────────────────────────────────

def _detect_low_volume(wav_path: str) -> list[dict]:
    """500ms pencerelerle RMS hesapla, ortalamanın altında kalan bölgeleri döndür."""
    import numpy as np

    data, sr = sf.read(wav_path)
    if data.ndim > 1:
        data = data.mean(axis=1)
    data = data.astype(np.float64)

    window_sec = 0.5
    window_samples = int(sr * window_sec)
    n_windows = len(data) // window_samples
    if n_windows == 0:
        return []

    # Her pencere için RMS
    rms_vals = np.zeros(n_windows)
    for i in range(n_windows):
        chunk = data[i * window_samples : (i + 1) * window_samples]
        rms_vals[i] = np.sqrt(np.mean(chunk ** 2))

    avg_rms = float(rms_vals.mean())
    if avg_rms < 1e-8:
        return []

    threshold = avg_rms * 0.50

    # Düşük sesli pencereleri işaretle
    low_flags = rms_vals < threshold

    # Bitişik düşük pencereleri birleştir
    segments = []
    in_low = False
    seg_start_idx = 0
    for i in range(n_windows):
        if low_flags[i] and not in_low:
            seg_start_idx = i
            in_low = True
        elif not low_flags[i] and in_low:
            _start = round(seg_start_idx * window_sec, 3)
            _end = round(i * window_sec, 3)
            _seg_rms = float(rms_vals[seg_start_idx:i].mean())
            if _end - _start >= 2.0:
                segments.append({'start': _start, 'end': _end, 'avg_rms': _seg_rms})
            in_low = False
    if in_low:
        _start = round(seg_start_idx * window_sec, 3)
        _end = round(n_windows * window_sec, 3)
        _seg_rms = float(rms_vals[seg_start_idx:].mean())
        if _end - _start >= 2.0:
            segments.append({'start': _start, 'end': _end, 'avg_rms': _seg_rms})

    # suggested_db hesapla
    for seg in segments:
        ratio = seg['avg_rms'] / avg_rms if avg_rms > 0 else 0
        if ratio >= 0.30:
            seg['suggested_db'] = 4.0
        elif ratio >= 0.15:
            seg['suggested_db'] = 7.0
        else:
            seg['suggested_db'] = 10.0
        seg['avg_rms'] = round(seg['avg_rms'], 6)

    return segments


@app.route('/api/detect-low-volume', methods=['POST'])
def detect_low_volume():
    """Ses dosyasındaki düşük sesli bölgeleri tespit et."""
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Dosya bulunamadı'}), 400

    f = request.files['file']
    suffix = os.path.splitext(f.filename or 'audio')[1] or '.mp3'
    tmp_in = os.path.join(tempfile.gettempdir(), f'lowvol_in_{int(time.time() * 1000)}{suffix}')
    tmp_wav = tmp_in.replace(suffix, '_16k.wav')
    f.save(tmp_in)
    try:
        r = subprocess.run(
            ['ffmpeg', '-y', '-i', tmp_in, '-ar', '16000', '-ac', '1', tmp_wav],
            capture_output=True, timeout=120)
        if r.returncode != 0:
            raise RuntimeError('ffmpeg: ' + r.stderr.decode('utf-8', errors='replace')[-200:])

        segments = _detect_low_volume(tmp_wav)
        log.info(f'[detect-low-volume] {len(segments)} düşük sesli bölge tespit edildi')
        return jsonify({'success': True, 'low_volume_segments': segments})
    except Exception as e:
        log.error(f'[detect-low-volume] Hata: {e}')
        return jsonify({'success': False, 'error': str(e)}), 500
    finally:
        for p in [tmp_in, tmp_wav]:
            try:
                os.unlink(p)
            except Exception:
                pass


# ── Ses Analizi — her dosyaya özel eşik hesaplama ─────────────────────────────
@app.route('/api/analyze-audio', methods=['POST'])
def analyze_audio():
    """
    Ses dosyasını analiz et — gürültü tabanı, ortalama ses, dinamik aralık hesapla.
    Bu değerlere göre optimal VAD eşikleri öner.
    """
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Dosya bulunamadı'}), 400
    import tempfile, soundfile as sf, numpy as np
    f = request.files['file']
    suffix = os.path.splitext(f.filename or 'audio')[1] or '.mp3'
    tmp_in = os.path.join(tempfile.gettempdir(), f'analyze_{int(time.time()*1000)}{suffix}')
    tmp_wav = tmp_in.replace(suffix, '_16k.wav')
    f.save(tmp_in)
    try:
        # 16kHz mono WAV'a çevir
        r = subprocess.run(['ffmpeg', '-y', '-i', tmp_in, '-ar', '16000', '-ac', '1', tmp_wav],
                           capture_output=True, timeout=60)
        if r.returncode != 0:
            raise RuntimeError('ffmpeg: ' + r.stderr.decode('utf-8', errors='replace')[-200:])

        data, sr = sf.read(tmp_wav)
        if data.ndim > 1: data = data.mean(axis=1)
        data = data.astype(np.float64)
        total_samples = len(data)
        duration = total_samples / sr

        # ── 1) Genel istatistikler ─────────────────────────────────────────
        abs_data = np.abs(data)
        rms_global = float(np.sqrt(np.mean(data ** 2)))
        peak = float(abs_data.max())
        mean_abs = float(abs_data.mean())

        # ── 2) Frame bazlı RMS (50ms pencere) ──────────────────────────────
        frame_len = int(sr * 0.05)  # 50ms
        n_frames = total_samples // frame_len
        frame_rms = np.zeros(n_frames)
        for i in range(n_frames):
            chunk = data[i * frame_len : (i + 1) * frame_len]
            frame_rms[i] = np.sqrt(np.mean(chunk ** 2))

        # ── 3) Gürültü tabanı — en sessiz %10'un ortalaması ────────────────
        sorted_rms = np.sort(frame_rms)
        noise_floor_idx = max(1, int(n_frames * 0.10))
        noise_floor = float(sorted_rms[:noise_floor_idx].mean())

        # ── 4) Konuşma seviyesi — en yüksek %60'ın ortalaması ──────────────
        speech_idx = max(1, int(n_frames * 0.40))
        speech_level = float(sorted_rms[speech_idx:].mean())

        # ── 5) Dinamik aralık ───────────────────────────────────────────────
        dynamic_range = speech_level / max(noise_floor, 1e-8)
        snr_db = float(20 * np.log10(max(speech_level, 1e-8) / max(noise_floor, 1e-8)))

        # ── 6) Sessiz bölge oranı (noise_floor * 2'den düşük frame'ler) ────
        silence_threshold = noise_floor * 2.5
        silent_frames = int(np.sum(frame_rms < silence_threshold))
        silence_ratio = silent_frames / max(n_frames, 1)

        # ── 7) Konuşmacı ses çeşitliliği (RMS standart sapma) ──────────────
        rms_std = float(frame_rms.std())
        # Yüksek std = çok farklı ses seviyeleri (kısık + yüksek konuşmacılar)
        volume_diversity = 'yüksek' if rms_std > rms_global * 0.8 else 'orta' if rms_std > rms_global * 0.4 else 'düşük'

        # ── 8) Optimal eşik hesaplama ───────────────────────────────────────
        # VAD threshold: gürültü ile konuşma arasında bir nokta
        # Düşük SNR → düşük threshold (hassas), Yüksek SNR → yüksek threshold
        if snr_db < 10:
            # Çok gürültülü kayıt
            vad_threshold = 0.20
            speech_only_threshold = 0.20
            min_speech_ms = 30
            min_silence_ms = 600
            pad_ms = 200
            profile = 'gürültülü'
        elif snr_db < 20:
            # Orta gürültü
            vad_threshold = 0.25
            speech_only_threshold = 0.25
            min_speech_ms = 40
            min_silence_ms = 500
            pad_ms = 150
            profile = 'orta'
        elif snr_db < 35:
            # İyi kayıt
            vad_threshold = 0.35
            speech_only_threshold = 0.35
            min_speech_ms = 60
            min_silence_ms = 400
            pad_ms = 120
            profile = 'iyi'
        else:
            # Çok temiz kayıt (stüdyo)
            vad_threshold = 0.45
            speech_only_threshold = 0.45
            min_speech_ms = 80
            min_silence_ms = 300
            pad_ms = 100
            profile = 'stüdyo'

        # Ses çeşitliliği yüksekse (kısık+yüksek konuşmacılar) → daha hassas
        if volume_diversity == 'yüksek':
            vad_threshold = max(0.15, vad_threshold - 0.10)
            speech_only_threshold = max(0.15, speech_only_threshold - 0.10)
            min_speech_ms = max(20, min_speech_ms - 20)
            pad_ms = min(250, pad_ms + 50)

        # NoiseReduce agresifliği
        if snr_db < 15:
            nr_prop = 0.80  # gürültülü → agresif
        elif snr_db < 25:
            nr_prop = 0.65  # orta
        else:
            nr_prop = 0.45  # temiz → hafif

        result = {
            'success': True,
            'duration': round(duration, 1),
            'analysis': {
                'rms_global': round(rms_global, 6),
                'peak': round(peak, 6),
                'noise_floor': round(noise_floor, 6),
                'speech_level': round(speech_level, 6),
                'snr_db': round(snr_db, 1),
                'dynamic_range': round(dynamic_range, 1),
                'silence_ratio': round(silence_ratio, 3),
                'volume_diversity': volume_diversity,
                'profile': profile,
            },
            'recommended': {
                'vad_threshold': round(vad_threshold, 2),
                'speech_only_threshold': round(speech_only_threshold, 2),
                'min_speech_ms': min_speech_ms,
                'min_silence_ms': min_silence_ms,
                'pad_ms': pad_ms,
                'nr_prop_decrease': round(nr_prop, 2),
            }
        }
        log.info(f'[analyze] Ses analizi: SNR={snr_db:.1f}dB, profil={profile}, '
                 f'diversity={volume_diversity}, vad_th={vad_threshold}, nr_prop={nr_prop}')
        return jsonify(result)
    except Exception as e:
        log.error(f'[analyze] Hata: {e}')
        return jsonify({'success': False, 'error': str(e)}), 500
    finally:
        for p in [tmp_in, tmp_wav]:
            try: os.unlink(p)
            except Exception: pass


@app.route('/api/config', methods=['GET'])
def get_config():
    hf_token = os.environ.get('HF_TOKEN', '')
    return jsonify({'hf_token': hf_token})

@app.route('/api/config/save', methods=['POST'])
def save_config():
    """HF Token'i .env dosyasına kaydet."""
    data = request.get_json(force=True) or {}
    hf_token = data.get('hf_token', '').strip()
    if not hf_token:
        return jsonify({'error': 'Token bos'}), 400

    env_path = os.path.join(os.path.dirname(__file__), '.env')
    lines = []
    found = False
    if os.path.exists(env_path):
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                if line.startswith('HF_TOKEN='):
                    lines.append(f'HF_TOKEN={hf_token}\n')
                    found = True
                else:
                    lines.append(line)
    if not found:
        lines.append(f'HF_TOKEN={hf_token}\n')

    with open(env_path, 'w', encoding='utf-8') as f:
        f.writelines(lines)

    os.environ['HF_TOKEN'] = hf_token
    return jsonify({'ok': True})

# ── Frontend Debug ────────────────────────────────────────────────────────────
_frontend_state = {}

@app.route('/api/debug', methods=['POST'])
def debug_post():
    """Frontend durumunu kaydet — Claude Code okuyabilir."""
    global _frontend_state
    _frontend_state = request.get_json(force=True)
    log.info(f'[FRONTEND] {json.dumps(_frontend_state, ensure_ascii=False)[:500]}')
    return jsonify({'ok': True})

@app.route('/api/debug', methods=['GET'])
def debug_get():
    """Frontend durumunu oku."""
    return jsonify(_frontend_state)

@app.route('/reset')
def reset_page():
    """Sadece aktif projeyi sıfırla — eski projeler korunsun."""
    return '''<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Proje Sıfırlama</title></head><body style="background:#0f172a;color:#f1f5f9;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px">
<div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:32px;max-width:420px;text-align:center">
  <div style="font-size:40px;margin-bottom:12px">🔄</div>
  <h2 style="color:#f59e0b;margin-bottom:8px">Aktif Projeyi Sıfırla</h2>
  <p style="color:#94a3b8;font-size:13px;margin-bottom:20px">Sadece mevcut aktif proje sıfırlanacak. Eski projeler korunur.</p>
  <div id="msg" style="display:none;margin-bottom:12px;font-size:14px"></div>
  <div style="display:flex;gap:10px;justify-content:center">
    <button onclick="location.href='/'" style="padding:10px 24px;background:#1e293b;border:1px solid #334155;color:#94a3b8;border-radius:8px;cursor:pointer;font-size:13px">İptal</button>
    <button id="confirm-btn" onclick="doReset()" style="padding:10px 24px;background:#92400e;border:1px solid #f59e0b;color:#fef3c7;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700">Sıfırla</button>
  </div>
</div>
<script>
async function doReset(){
  const m=document.getElementById('msg');
  const b=document.getElementById('confirm-btn');
  m.style.display='block';m.style.color='#f59e0b';m.textContent='⏳ Sıfırlanıyor...';
  b.disabled=true;b.style.opacity='0.5';
  try{
    const DB_NAME='voicecraft';
    const db=await new Promise((r,j)=>{const req=indexedDB.open(DB_NAME);req.onsuccess=e=>r(e.target.result);req.onerror=e=>j(e.target.error)});
    const projName=localStorage.getItem('current_project_name')||'';
    m.textContent='⏳ '+projName+' sıfırlanıyor...';

    // 1) session store — sadece 'current' key sil (per-file key'ler korunsun)
    try{const tx=db.transaction('session','readwrite');tx.objectStore('session').delete('current');await new Promise(r=>{tx.oncomplete=r})}catch(e){}

    // 2) pipeline store — 'current' ve bu projenin kaydını sil
    try{const tx=db.transaction('pipeline','readwrite');const s=tx.objectStore('pipeline');s.delete('current');if(projName)s.delete('proj__'+projName);await new Promise(r=>{tx.oncomplete=r})}catch(e){}

    // 3) step_audio store — bu projenin ses kayıtlarını sil
    if(projName){
      try{
        const tx=db.transaction('step_audio','readwrite');const s=tx.objectStore('step_audio');
        const keys=await new Promise(r=>{const req=s.getAllKeys();req.onsuccess=()=>r(req.result||[])});
        for(const k of keys){if(String(k).startsWith(projName+'__'))s.delete(k)}
        await new Promise(r=>{tx.oncomplete=r});
      }catch(e){}
    }

    db.close();

    // 4) localStorage — sadece aktif proje bilgisini sil, projeler listesi korunsun
    localStorage.removeItem('current_project_name');
    localStorage.removeItem('ses_aktif_proje');

    m.textContent='✅ "'+(projName||'Aktif proje')+'" sıfırlandı!';
    m.style.color='#4ade80';
    setTimeout(()=>location.href='/',1500);
  }catch(e){
    m.style.color='#ef4444';m.textContent='❌ Hata: '+e.message;
    b.disabled=false;b.style.opacity='1';
  }
}
</script></body></html>'''


@app.route('/reset-all')
def reset_all_page():
    """Tüm verileri sil — onay gerektirir, otomatik çalışmaz."""
    return '''<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Tam Sıfırlama</title></head><body style="background:#0f172a;color:#f1f5f9;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px">
<div style="background:#1e293b;border:1px solid #7f1d1d;border-radius:12px;padding:32px;max-width:420px;text-align:center">
  <div style="font-size:40px;margin-bottom:12px">⚠️</div>
  <h2 style="color:#ef4444;margin-bottom:8px">Tüm Verileri Sil</h2>
  <p style="color:#94a3b8;font-size:13px;margin-bottom:20px">Bu işlem tüm projeleri, ses kayıtlarını, transkriptleri ve pipeline verilerini kalıcı olarak silecek. Bu işlem geri alınamaz!</p>
  <div id="msg" style="display:none;margin-bottom:12px;font-size:14px"></div>
  <div style="display:flex;gap:10px;justify-content:center">
    <button onclick="location.href='/'" style="padding:10px 24px;background:#1e293b;border:1px solid #334155;color:#94a3b8;border-radius:8px;cursor:pointer;font-size:13px">İptal — Ana Sayfa</button>
    <button id="confirm-btn" onclick="doReset()" style="padding:10px 24px;background:#991b1b;border:1px solid #ef4444;color:#fecaca;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700">Evet, Her Şeyi Sil</button>
  </div>
</div>
<script>
async function doReset(){
  const m=document.getElementById('msg');
  const b=document.getElementById('confirm-btn');
  m.style.display='block';m.style.color='#f59e0b';m.textContent='⏳ Siliniyor...';
  b.disabled=true;b.style.opacity='0.5';
  try{
    await new Promise((r,j)=>{const d=indexedDB.deleteDatabase('voicecraft');d.onsuccess=r;d.onerror=j;d.onblocked=r});
    localStorage.clear();
    m.style.color='#4ade80';m.textContent='✅ Tüm veriler silindi!';
    setTimeout(()=>location.href='/',1500);
  }catch(e){
    m.style.color='#ef4444';m.textContent='❌ Hata: '+e.message;
    b.disabled=false;b.style.opacity='1';
  }
}
</script></body></html>'''


@app.route('/api/normalize-speakers', methods=['POST'])
def normalize_speakers():
    """Konuşmacı bazlı ses seviyesi dengeleme — her konuşmacıya ayrı gain uygular."""
    try:
        if 'audio' not in request.files:
            return jsonify({'error': 'audio dosyası gerekli'}), 400
        import tempfile, traceback
        import numpy as np

        audio_file  = request.files['audio']
        segments    = json.loads(request.form.get('segments', '[]'))
        target_lufs = float(request.form.get('target_lufs', -20.0))
        max_gain_db = float(request.form.get('max_gain_db', 18.0))

        tmp_in = os.path.join(tempfile.gettempdir(), f'spknorm_in_{int(time.time()*1000)}.wav')
        tmp_wav = tmp_in.replace('.wav', '_16k.wav')
        audio_file.save(tmp_in)

        # ffmpeg ile WAV'a çevir (herhangi bir format gelirse)
        r = subprocess.run(['ffmpeg', '-y', '-i', tmp_in, '-ar', '16000', '-ac', '1', tmp_wav],
                           capture_output=True, timeout=120)
        wav_path = tmp_wav if r.returncode == 0 else tmp_in

        y, sr = sf.read(wav_path)
        if y.ndim > 1: y = y.mean(axis=1)
        y = y.astype(np.float64)

        meter = pyln.Meter(sr)
        speaker_mean = {}

        if len(segments) == 0:
            # Segment yok — global loudnorm
            log.info('[spk-norm] Diarize segmenti yok, global normalizasyon yapılıyor')
            loudness = meter.integrated_loudness(y)
            if loudness > -70:
                gain_db = float(np.clip(target_lufs - loudness, -6, max_gain_db))
                y = y * (10 ** (gain_db / 20.0))
        else:
            # Her konuşmacının ortalama loudness'ını hesapla
            log.info(f'[spk-norm] {len(segments)} diarize segmenti ile konuşmacı bazlı dengeleme')
            speaker_chunks = {}
            for seg in segments:
                spk = seg.get('speaker', 'UNKNOWN')
                s   = int(seg['start'] * sr)
                e   = int(min(seg['end'] * sr, len(y)))
                chunk = y[s:e]
                if len(chunk) < int(sr * 0.3):
                    continue
                try:
                    loud = meter.integrated_loudness(chunk)
                    if loud < -70:
                        continue
                    speaker_chunks.setdefault(spk, []).append(
                        {'start': s, 'end': e, 'loudness': loud}
                    )
                except Exception:
                    continue

            for spk, chunks in speaker_chunks.items():
                speaker_mean[spk] = float(np.mean([c['loudness'] for c in chunks]))
                log.info(f'[spk-norm] {spk}: ortalama {speaker_mean[spk]:.1f} LUFS')

            y_out    = y.copy()
            fade_len = int(sr * 0.01)  # 10 ms crossfade

            for spk, chunks in speaker_chunks.items():
                gain_db  = float(np.clip(target_lufs - speaker_mean[spk], -6.0, max_gain_db))
                gain_lin = 10 ** (gain_db / 20.0)
                log.info(f'[spk-norm] {spk}: gain {gain_db:+.1f} dB')

                for c in chunks:
                    s, e = c['start'], c['end']
                    seg_len = e - s

                    # Orijinal sesi sakla, gain uygula
                    orig_start = y[s:s+fade_len].copy() if fade_len < seg_len else y[s:e].copy()
                    orig_end   = y[e-fade_len:e].copy() if fade_len < seg_len else np.array([])
                    y_out[s:e] *= gain_lin

                    # Crossfade: orijinal ses → gain'li ses (başlangıç), gain'li ses → orijinal ses (bitiş)
                    f = min(fade_len, seg_len)
                    if f > 1:
                        alpha = np.linspace(0, 1, f)
                        y_out[s:s+f] = orig_start[:f] * (1 - alpha) + y_out[s:s+f] * alpha
                        if len(orig_end) >= f:
                            y_out[e-f:e] = y_out[e-f:e] * (1 - alpha) + orig_end[-f:] * alpha

            # Final global trim
            try:
                final_loud = meter.integrated_loudness(y_out)
                if final_loud > -70:
                    trim_db = float(np.clip(target_lufs - final_loud, -6, 3))
                    y_out   = y_out * (10 ** (trim_db / 20.0))
            except Exception:
                pass

            y = np.clip(y_out, -1.0, 1.0)

        tmp_out = tmp_in.replace('.wav', '_out.mp3')
        tmp_wav_out = tmp_in.replace('.wav', '_out.wav')
        sf.write(tmp_wav_out, y.astype(np.float32), sr)
        # WAV → MP3
        r2 = subprocess.run(['ffmpeg', '-y', '-i', tmp_wav_out, '-q:a', '2', tmp_out],
                            capture_output=True, timeout=120)
        if r2.returncode != 0:
            raise RuntimeError('ffmpeg MP3: ' + r2.stderr.decode('utf-8', errors='replace')[-200:])

        log.info(f'[spk-norm] Tamamlandı: {len(speaker_mean)} konuşmacı dengelendi')
        resp = send_file(tmp_out, mimetype='audio/mpeg', as_attachment=True,
                         download_name='normalized.mp3')
        resp.headers['X-Speaker-Stats'] = json.dumps(speaker_mean)
        @after_this_request
        def _cl(response):
            for p in [tmp_in, tmp_wav, tmp_wav_out, tmp_out]:
                try: os.unlink(p)
                except: pass
            return response
        return resp
    except Exception as e:
        import traceback
        log.error(f'[spk-norm] Hata: {e}\n{traceback.format_exc()}')
        return jsonify({'error': str(e)}), 500


@app.route('/api/normalize', methods=['POST'])
def normalize_audio():
    """Ses seviyesi normalizasyonu — kısık sesleri yükselt, yüksek sesleri dengele (eski global yöntem)."""
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Dosya bulunamadı'}), 400
    import tempfile
    f = request.files['file']
    suffix = os.path.splitext(f.filename or 'audio')[1] or '.mp3'
    tmp_in = os.path.join(tempfile.gettempdir(), f'norm_in_{int(time.time()*1000)}{suffix}')
    tmp_out = tmp_in.replace(suffix, '_norm.mp3')
    f.save(tmp_in)
    try:
        # 2-pass loudnorm: önce analiz, sonra yumuşak normalize
        # I=-20 (daha yumuşak, cıyaklama önlenir), TP=-1.0 (headroom), LRA=15 (geniş dinamik aralık)
        log.info('[norm] Ses seviyesi normalizasyonu başlıyor (2-pass, yumuşak)...')
        # Pass 1: analiz
        r1 = subprocess.run(
            ['ffmpeg', '-y', '-i', tmp_in, '-af', 'loudnorm=I=-20:TP=-1.0:LRA=15:print_format=json', '-f', 'null', '-'],
            capture_output=True, timeout=120, text=True
        )
        # Pass 1 çıktısından measured değerleri çek
        import re as _re
        stderr = r1.stderr or ''
        mi = _re.search(r'"input_i"\s*:\s*"([^"]+)"', stderr)
        mtp = _re.search(r'"input_tp"\s*:\s*"([^"]+)"', stderr)
        mlra = _re.search(r'"input_lra"\s*:\s*"([^"]+)"', stderr)
        mt = _re.search(r'"input_thresh"\s*:\s*"([^"]+)"', stderr)
        mo = _re.search(r'"target_offset"\s*:\s*"([^"]+)"', stderr)
        if mi and mtp and mlra and mt and mo:
            # Pass 2: measured değerlerle yumuşak normalize
            af = (f'loudnorm=I=-20:TP=-1.0:LRA=15:'
                  f'measured_I={mi.group(1)}:measured_TP={mtp.group(1)}:'
                  f'measured_LRA={mlra.group(1)}:measured_thresh={mt.group(1)}:'
                  f'offset={mo.group(1)}:linear=true')
            log.info(f'[norm] 2-pass: {af[:100]}...')
        else:
            # Fallback: tek pass
            af = 'loudnorm=I=-20:TP=-1.0:LRA=15'
            log.info('[norm] Fallback: tek pass loudnorm')
        # Sadece loudnorm — kompresör kaldırıldı (timeout sorunu)
        log.info(f'[norm] Filter: loudnorm')
        r2 = subprocess.run(
            ['ffmpeg', '-y', '-i', tmp_in, '-af', af, '-q:a', '2', tmp_out],
            capture_output=True, timeout=300
        )
        if r2.returncode != 0:
            raise RuntimeError('ffmpeg: ' + r2.stderr.decode('utf-8', errors='replace')[-200:])
        log.info('[norm] Ses seviyesi normalizasyonu tamamlandı')
        base = os.path.splitext(f.filename or 'ses')[0]
        resp = send_file(tmp_out, mimetype='audio/mpeg', as_attachment=True,
                         download_name=base + '_norm.mp3')
        @after_this_request
        def _cl(response):
            for p in [tmp_in, tmp_out]:
                try: os.unlink(p)
                except: pass
            return response
        return resp
    except Exception as e:
        for p in [tmp_in, tmp_out]:
            try: os.unlink(p)
            except: pass
        log.error(f'[norm] Hata: {e}')
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/html-to-pdf', methods=['POST'])
def html_to_pdf():
    """HTML'i PDF'e çevir ve indir — Edge/Chrome headless kullanır."""
    import tempfile
    data = request.get_json(force=True)
    html_content = data.get('html', '')
    filename = data.get('filename', 'rapor') + '.pdf'
    if not html_content:
        return jsonify({'success': False, 'error': 'HTML içerik boş'}), 400
    tmp_html = os.path.join(tempfile.gettempdir(), f'pdf_{int(time.time()*1000)}.html')
    tmp_pdf = tmp_html.replace('.html', '.pdf')
    try:
        with open(tmp_html, 'w', encoding='utf-8') as f:
            f.write(html_content)
        # Edge veya Chrome headless ile PDF oluştur
        edge_paths = [
            r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
            r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
            r'C:\Program Files\Google\Chrome\Application\chrome.exe',
            r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
        ]
        browser = None
        for p in edge_paths:
            if os.path.exists(p):
                browser = p
                break
        if not browser:
            raise RuntimeError('Edge veya Chrome bulunamadı')
        r = subprocess.run([
            browser, '--headless=new', '--disable-gpu', '--no-sandbox',
            '--disable-extensions', '--no-first-run',
            f'--print-to-pdf={tmp_pdf}', '--print-to-pdf-no-header',
            f'file:///{tmp_html.replace(os.sep, "/")}'
        ], capture_output=True, timeout=30)
        if not os.path.exists(tmp_pdf):
            raise RuntimeError('PDF oluşturulamadı')
        resp = send_file(tmp_pdf, mimetype='application/pdf', as_attachment=True, download_name=filename)
        @after_this_request
        def _cl(response):
            for p in [tmp_html, tmp_pdf]:
                try: os.unlink(p)
                except: pass
            return response
        return resp
    except Exception as e:
        for p in [tmp_html, tmp_pdf]:
            try: os.unlink(p)
            except: pass
        log.error(f'[pdf] Hata: {e}')
        return jsonify({'success': False, 'error': str(e)}), 500


_nr_jobs = {}  # job_id → {status, pct, result_path, error, tmp_files}

def _run_nr_job(job_id, tmp_in, prop):
    """Arka planda NoiseReduce çalıştır."""
    import soundfile as sf
    import numpy as np
    job = _nr_jobs[job_id]
    suffix = os.path.splitext(tmp_in)[1] or '.mp3'
    tmp_wav = os.path.join(tempfile.gettempdir(), f'nr_mid_{job_id}.wav')
    tmp_out = os.path.join(tempfile.gettempdir(), f'nr_out_{job_id}.mp3')
    job['tmp_files'] = [tmp_in, tmp_wav, tmp_out]
    try:
        job['pct'] = 5; job['step'] = 'FFmpeg dönüştürme...'
        r = subprocess.run(['ffmpeg', '-y', '-i', tmp_in, '-ar', '16000', '-ac', '1', tmp_wav],
                           capture_output=True, timeout=120)
        if r.returncode != 0:
            raise RuntimeError('ffmpeg hatası: ' + r.stderr.decode('utf-8', errors='replace')[-300:])
        job['pct'] = 15; job['step'] = 'Ses verisi okunuyor...'
        data, rate = sf.read(tmp_wav)
        data = data.astype(np.float32)
        _nr_done = False
        # GPU yolu
        try:
            _dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
            job['pct'] = 20; job['step'] = f'GPU spektral gating ({_dev})...'
            log.info(f'[nr] GPU spektral gating başlıyor — device={_dev}, samples={len(data)}, sr={rate}')
            wav = torch.from_numpy(data).to(_dev)
            n_fft, hop = 1024, 256
            win = torch.hann_window(n_fft, device=_dev)
            spec = torch.stft(wav, n_fft=n_fft, hop_length=hop, win_length=n_fft,
                              window=win, return_complex=True)
            mag = spec.abs()
            job['pct'] = 40; job['step'] = 'Gürültü profili hesaplanıyor...'
            frame_e = mag.mean(dim=0)
            n_noise = max(8, int(frame_e.shape[0] * 0.10))
            _, noise_idx = frame_e.topk(n_noise, largest=False)
            noise_prof = mag[:, noise_idx].mean(dim=1, keepdim=True)
            job['pct'] = 60; job['step'] = 'Mask uygulanıyor...'
            mask = ((mag - prop * noise_prof) / (mag + 1e-9)).clamp(0.0, 1.0)
            wav_out = torch.istft(spec * mask, n_fft=n_fft, hop_length=hop, win_length=n_fft,
                                  window=win, length=wav.shape[0])
            job['pct'] = 80; job['step'] = 'Sonuç yazılıyor...'
            sf.write(tmp_wav, wav_out.cpu().numpy(), rate)
            del wav, spec, mag, mask, wav_out, win, noise_prof, frame_e
            if _dev.type == 'cuda': torch.cuda.empty_cache()
            log.info(f'[nr] GPU spektral gating tamamlandı')
            _nr_done = True
        except Exception as _e:
            log.warning(f'[nr] GPU yolu başarısız ({_e}), CPU fallback...')
        # CPU fallback
        if not _nr_done:
            import noisereduce as nr
            job['pct'] = 30; job['step'] = 'noisereduce (CPU) çalışıyor...'
            log.info(f'[nr] noisereduce (CPU) başlıyor: {len(data)} örnek, {rate}Hz')
            reduced = nr.reduce_noise(y=data, sr=rate, prop_decrease=prop, stationary=False, n_jobs=1)
            sf.write(tmp_wav, reduced, rate)
        # WAV → MP3
        job['pct'] = 90; job['step'] = 'MP3 dönüştürme...'
        r2 = subprocess.run(['ffmpeg', '-y', '-i', tmp_wav, '-q:a', '2', tmp_out],
                            capture_output=True, timeout=120)
        if r2.returncode != 0:
            raise RuntimeError('ffmpeg MP3 hatası: ' + r2.stderr.decode('utf-8', errors='replace')[-300:])
        job['pct'] = 100; job['step'] = 'Tamamlandı'
        job['status'] = 'done'; job['result_path'] = tmp_out
        log.info('[nr] Gürültü bastırma tamamlandı')
    except Exception as e:
        job['status'] = 'error'; job['error'] = str(e)
        log.error(f'[nr] Hata: {e}')

@app.route('/api/denoise-nr', methods=['POST'])
def denoise_nr():
    """noisereduce ile gürültü bastırma — async job olarak çalışır."""
    # Eğer async=true parametresi yoksa eski senkron davranış
    is_async = request.form.get('async', 'false').lower() == 'true'

    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Dosya bulunamadı'}), 400
    f      = request.files['file']
    prop   = float(request.form.get('prop_decrease', '0.65'))
    suffix = os.path.splitext(f.filename or 'audio')[1] or '.mp3'
    tmp_in = os.path.join(tempfile.gettempdir(), f'nr_in_{int(time.time())}{suffix}')
    f.save(tmp_in)

    if is_async:
        job_id = f'nr_{int(time.time()*1000)}'
        _nr_jobs[job_id] = {'status': 'running', 'pct': 0, 'step': 'Başlatılıyor...', 'result_path': None, 'error': None, 'tmp_files': [], 'filename': f.filename}
        threading.Thread(target=_run_nr_job, args=(job_id, tmp_in, prop), daemon=True).start()
        return jsonify({'success': True, 'job_id': job_id})

    # Senkron mod (eski davranış — ses modülü için)
    tmp_wav= os.path.join(tempfile.gettempdir(), f'nr_mid_{int(time.time())}.wav')
    tmp_out= os.path.join(tempfile.gettempdir(), f'nr_out_{int(time.time())}.mp3')
    try:
        r = subprocess.run(['ffmpeg', '-y', '-i', tmp_in, '-ar', '16000', '-ac', '1', tmp_wav],
                           capture_output=True, timeout=120)
        if r.returncode != 0:
            raise RuntimeError('ffmpeg dönüştürme hatası: ' + r.stderr.decode('utf-8', errors='replace')[-300:])
        import soundfile as sf
        import numpy as np
        data, rate = sf.read(tmp_wav)
        data = data.astype(np.float32)
        _nr_done = False
        try:
            _dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
            log.info(f'[nr] GPU spektral gating başlıyor — device={_dev}, samples={len(data)}, sr={rate}')
            wav = torch.from_numpy(data).to(_dev)
            n_fft, hop = 1024, 256
            win = torch.hann_window(n_fft, device=_dev)
            spec = torch.stft(wav, n_fft=n_fft, hop_length=hop, win_length=n_fft,
                              window=win, return_complex=True)
            mag = spec.abs()
            frame_e = mag.mean(dim=0)
            n_noise = max(8, int(frame_e.shape[0] * 0.10))
            _, noise_idx = frame_e.topk(n_noise, largest=False)
            noise_prof = mag[:, noise_idx].mean(dim=1, keepdim=True)
            mask = ((mag - prop * noise_prof) / (mag + 1e-9)).clamp(0.0, 1.0)
            wav_out = torch.istft(spec * mask, n_fft=n_fft, hop_length=hop, win_length=n_fft,
                                  window=win, length=wav.shape[0])
            sf.write(tmp_wav, wav_out.cpu().numpy(), rate)
            del wav, spec, mag, mask, wav_out, win, noise_prof, frame_e
            if _dev.type == 'cuda': torch.cuda.empty_cache()
            log.info(f'[nr] GPU spektral gating tamamlandı')
            _nr_done = True
        except Exception as _e:
            log.warning(f'[nr] GPU yolu başarısız ({_e}), noisereduce CPU fallback...')
        if not _nr_done:
            import noisereduce as nr
            log.info(f'[nr] noisereduce (CPU) başlıyor: {len(data)} örnek, {rate}Hz')
            reduced = nr.reduce_noise(y=data, sr=rate, prop_decrease=prop, stationary=False, n_jobs=1)
            sf.write(tmp_wav, reduced, rate)
        r2 = subprocess.run(['ffmpeg', '-y', '-i', tmp_wav, '-q:a', '2', tmp_out],
                            capture_output=True, timeout=120)
        if r2.returncode != 0:
            raise RuntimeError('ffmpeg MP3 hatası: ' + r2.stderr.decode('utf-8', errors='replace')[-300:])
        log.info('[nr] Gürültü bastırma tamamlandı')
        base = os.path.splitext(f.filename or 'ses')[0]
        resp = send_file(tmp_out, mimetype='audio/mpeg',
                         as_attachment=True, download_name=base + '_temiz.mp3')
        _attach_quality_header(resp, tmp_out)
        @after_this_request
        def _cleanup(response):
            for p in [tmp_in, tmp_wav, tmp_out]:
                try: os.unlink(p)
                except Exception: pass
            return response
        return resp
    except Exception as e:
        for p in [tmp_in, tmp_wav, tmp_out]:
            try: os.unlink(p)
            except Exception: pass
        log.error(f'[nr] Hata: {e}')
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/denoise-nr/progress/<job_id>', methods=['GET'])
def denoise_nr_progress(job_id):
    """NoiseReduce job durumu."""
    job = _nr_jobs.get(job_id)
    if not job:
        return jsonify({'success': False, 'error': 'İş bulunamadı'}), 404
    return jsonify({'success': True, 'status': job['status'], 'pct': job.get('pct', 0), 'step': job.get('step', ''), 'error': job.get('error')})

@app.route('/api/denoise-nr/download/<job_id>', methods=['GET'])
def denoise_nr_download(job_id):
    """Tamamlanmış NoiseReduce sonucunu indir."""
    job = _nr_jobs.get(job_id)
    if not job or job['status'] != 'done':
        return jsonify({'success': False, 'error': 'Sonuç hazır değil'}), 404
    result_path = job['result_path']
    if not result_path or not os.path.exists(result_path):
        return jsonify({'success': False, 'error': 'Sonuç dosyası bulunamadı'}), 404
    # Dosyayı belleğe oku — cleanup ile yarış koşulunu önle
    with open(result_path, 'rb') as f:
        data = f.read()
    # Temizlik
    for p in job.get('tmp_files', []):
        try: os.unlink(p)
        except: pass
    _nr_jobs.pop(job_id, None)
    # ASCII-safe dosya adı
    safe_name = 'temiz_ses'
    try:
        import unicodedata, re
        base = os.path.splitext(job.get('filename', 'ses'))[0]
        safe_name = unicodedata.normalize('NFKD', base).encode('ascii', 'ignore').decode('ascii')
        safe_name = re.sub(r'[^\w\s\-.]', '_', safe_name).strip() or 'temiz_ses'
    except: pass
    from flask import Response
    resp = Response(data, mimetype='audio/mpeg')
    resp.headers['Content-Disposition'] = f'attachment; filename="{safe_name}_temiz.mp3"'
    resp.headers['Content-Length'] = len(data)
    return resp


import torch

_dns_model = None
_dns_lock  = threading.Lock()

def _get_dns_model():
    global _dns_model
    with _dns_lock:
        if _dns_model is not None:
            return _dns_model
        from denoiser import pretrained
        _dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
        _dns_model = pretrained.dns64().to(_dev)
        _dns_model.eval()
        log.info(f'[dns] DNS64 modeli yüklendi — device={_dev}')
        return _dns_model


@app.route('/api/enhance', methods=['POST'])
def enhance_audio():
    """Facebook DNS64 neural speech enhancement — öksürük, bardak, kaşık, masa seslerini siler."""
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Dosya bulunamadı'}), 400
    f      = request.files['file']
    suffix = os.path.splitext(f.filename or 'audio')[1] or '.mp3'
    ts     = int(time.time() * 1000)
    tmp_in  = os.path.join(tempfile.gettempdir(), f'enh_in_{ts}{suffix}')
    tmp_wav = os.path.join(tempfile.gettempdir(), f'enh_mid_{ts}.wav')
    tmp_out = os.path.join(tempfile.gettempdir(), f'enh_out_{ts}.mp3')
    f.save(tmp_in)
    try:
        # ffmpeg → 16 kHz mono WAV (DNS64 modeli 16kHz bekler)
        r = subprocess.run(['ffmpeg', '-y', '-i', tmp_in, '-ar', '16000', '-ac', '1', tmp_wav],
                           capture_output=True, timeout=120)
        if r.returncode != 0:
            raise RuntimeError('ffmpeg: ' + r.stderr.decode('utf-8', errors='replace')[-200:])

        import soundfile as sf
        import numpy as np
        from denoiser.dsp import convert_audio

        model = _get_dns_model()
        _dev  = next(model.parameters()).device

        data, sr = sf.read(tmp_wav)
        if data.ndim > 1: data = data.mean(axis=1)
        wav = torch.from_numpy(data.astype(np.float32)).unsqueeze(0)  # [1, T]
        wav = convert_audio(wav.to(_dev), sr, model.sample_rate, model.chin)

        log.info(f'[dns] enhance başlıyor — {len(data)/sr:.1f}s, device={_dev}')
        # Chunk'larla işle — overlap YOK, sınırlarda 8ms fade ile artifact önle
        chunk_sec = 60
        chunk_smp = model.sample_rate * chunk_sec
        fade_smp  = int(model.sample_rate * 0.008)   # 8ms
        T = wav.shape[-1]
        if T <= chunk_smp * 1.2:
            with torch.no_grad():
                out = model(wav[None])[0]          # [1, T]
        else:
            chunks_out = []
            pos = 0
            while pos < T:
                end = min(pos + chunk_smp, T)
                chunk = wav[:, pos:end]
                with torch.no_grad():
                    c_out = model(chunk[None])[0]  # [1, T_chunk]
                if fade_smp > 0 and c_out.shape[-1] > fade_smp * 2:
                    fade = torch.linspace(0, 1, fade_smp, device=_dev)
                    if pos > 0:        # fade-in (ilk chunk hariç)
                        c_out[..., :fade_smp] *= fade
                    if end < T:        # fade-out (son chunk hariç)
                        c_out[..., -fade_smp:] *= fade.flip(0)
                chunks_out.append(c_out)
                pos = end
            out = torch.cat(chunks_out, dim=-1)[..., :T]

        result = out.squeeze(0).cpu().numpy()
        sf.write(tmp_wav, result, model.sample_rate)

        # WAV → MP3
        r2 = subprocess.run(['ffmpeg', '-y', '-i', tmp_wav, '-q:a', '2', tmp_out],
                            capture_output=True, timeout=120)
        if r2.returncode != 0:
            raise RuntimeError('ffmpeg MP3: ' + r2.stderr.decode('utf-8', errors='replace')[-200:])

        if _dev.type == 'cuda': torch.cuda.empty_cache()
        log.info('[dns] Enhancement tamamlandı')

        base = os.path.splitext(f.filename or 'ses')[0]
        resp = send_file(tmp_out, mimetype='audio/mpeg',
                         as_attachment=True, download_name=base + '_enhanced.mp3')
        _attach_quality_header(resp, tmp_out)
        @after_this_request
        def _cleanup(response):
            for p in [tmp_in, tmp_wav, tmp_out]:
                try: os.unlink(p)
                except Exception: pass
            return response
        return resp
    except Exception as e:
        for p in [tmp_in, tmp_wav, tmp_out]:
            try: os.unlink(p)
            except Exception: pass
        log.error(f'[dns] Hata: {e}')
        return jsonify({'success': False, 'error': str(e)}), 500


# ── VoiceFixer ─────────────────────────────────────────────────────────────────
_vf_model = None
_vf_lock   = threading.Lock()

def _get_vf_model():
    global _vf_model
    if _vf_model is not None: return _vf_model
    with _vf_lock:
        if _vf_model is not None: return _vf_model
        from voicefixer import VoiceFixer
        _vf_model = VoiceFixer()
        log.info('[vf] VoiceFixer modeli yüklendi')
        return _vf_model

@app.route('/api/voicefixer', methods=['POST'])
def voicefixer_enhance():
    """VoiceFixer — bozulmuş, düşük kaliteli, gürültülü sesi restore et ve güzelleştir."""
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Dosya bulunamadı'}), 400
    import tempfile, soundfile as sf, numpy as np
    f       = request.files['file']
    mode    = int(request.form.get('mode', 0))   # 0=normal, 1=agresif, 2=çok agresif
    suffix  = os.path.splitext(f.filename or 'audio')[1] or '.mp3'
    tmp_in  = os.path.join(tempfile.gettempdir(), f'vf_in_{int(time.time()*1000)}{suffix}')
    tmp_wav = tmp_in.replace(suffix, '_44k.wav')
    tmp_out = tmp_in.replace(suffix, '_vf.mp3')
    f.save(tmp_in)
    try:
        # ffmpeg → 44100 Hz mono WAV + loudnorm (ses seviyesi eşitleme — düşük sesleri yükselt)
        r = subprocess.run(['ffmpeg', '-y', '-i', tmp_in,
                           '-af', 'loudnorm=I=-20:TP=-1.0:LRA=15',
                           '-ar', '44100', '-ac', '1', tmp_wav],
                           capture_output=True, timeout=120)
        if r.returncode != 0:
            raise RuntimeError('ffmpeg: ' + r.stderr.decode('utf-8', errors='replace')[-200:])
        model = _get_vf_model()
        log.info(f'[vf] VoiceFixer başlıyor: mode={mode}')
        model.restore(input=tmp_wav, output=tmp_wav + '_out.wav', cuda=torch.cuda.is_available(), mode=mode)
        out_wav = tmp_wav + '_out.wav'
        # WAV → MP3
        r2 = subprocess.run(['ffmpeg', '-y', '-i', out_wav, '-q:a', '2', tmp_out],
                            capture_output=True, timeout=120)
        if r2.returncode != 0:
            raise RuntimeError('ffmpeg MP3: ' + r2.stderr.decode('utf-8', errors='replace')[-200:])
        log.info('[vf] VoiceFixer tamamlandı')
        # GPU bellek temizle
        import gc; gc.collect()
        if torch.cuda.is_available(): torch.cuda.empty_cache()
        base = os.path.splitext(f.filename or 'ses')[0]
        resp = send_file(tmp_out, mimetype='audio/mpeg', as_attachment=True,
                         download_name=base + '_vf.mp3')
        @after_this_request
        def _cleanup(response):
            for p in [tmp_in, tmp_wav, tmp_out, out_wav]:
                try: os.unlink(p)
                except Exception: pass
            return response
        return resp
    except Exception as e:
        for p in [tmp_in, tmp_wav, tmp_out]:
            try: os.unlink(p)
            except Exception: pass
        log.error(f'[vf] Hata: {e}')
        return jsonify({'success': False, 'error': str(e)}), 500


# ── Resemble Enhance (denoiser + enhancer) ──────────────────────────────────────
@app.route('/api/resemble-enhance', methods=['POST'])
def resemble_enhance_audio():
    """Resemble Enhance — ses kristalleştirme: harmonik ekleme, tını güzelleştirme, netlik artırma."""
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Dosya bulunamadı'}), 400
    import tempfile
    f      = request.files['file']
    mode   = request.form.get('mode', 'enhance')   # 'denoise' veya 'enhance'
    suffix = os.path.splitext(f.filename or 'audio')[1] or '.mp3'
    tmp_in  = os.path.join(tempfile.gettempdir(), f're_in_{int(time.time()*1000)}{suffix}')
    tmp_wav = tmp_in.replace(suffix, '_16k.wav')
    tmp_out = tmp_in.replace(suffix, '_re.mp3')
    f.save(tmp_in)
    try:
        import soundfile as sf
        import numpy as np
        # loudnorm — ses seviyelerini eşitle (düşük sesleri yükselt, pitch bozulmasını azalt)
        r = subprocess.run(['ffmpeg', '-y', '-i', tmp_in,
                           '-af', 'loudnorm=I=-20:TP=-1.0:LRA=15',
                           '-ar', '16000', '-ac', '1', tmp_wav],
                           capture_output=True, timeout=120)
        if r.returncode != 0:
            raise RuntimeError('ffmpeg: ' + r.stderr.decode('utf-8', errors='replace')[-200:])
        _dev = torch.device('cpu')  # Resemble: torchaudio 2.11 ile CUDA tensor karışıklığı
        log.info(f'[re] CUDA available={torch.cuda.is_available()}, device={_dev} (cpu forced)')
        # Model download bypass — model_repo zaten klonlanmis
        import resemble_enhance.enhancer.download as _re_dl
        _re_dl.download = lambda: _re_dl.REPO_DIR / "enhancer_stage2"
        from resemble_enhance.enhancer.inference import denoise, enhance
        data, sr = sf.read(tmp_wav)
        if data.ndim > 1: data = data.mean(axis=1)  # stereo → mono
        wav = torch.from_numpy(data.astype(np.float32)).to(_dev)  # [N] — 1D
        log.info(f'[re] Resemble Enhance başlıyor: mode={mode}, device={_dev}, wav.device={wav.device}')
        # Sadece denoise — enhance ünsüz harfleri yutuyor (r→y, pelteklik)
        out, sr_out = denoise(wav, sr, _dev)
        log.info(f'[re] Resemble denoise tamamlandı (enhance atlandı — ünsüz koruma)')
        # GPU bellek temizle
        import gc; gc.collect()
        if torch.cuda.is_available(): torch.cuda.empty_cache()
        log.info(f'[re] out type={type(out)}, sr_out type={type(sr_out)} val={sr_out}')
        if isinstance(out, torch.Tensor):
            log.info(f'[re] out.shape={out.shape}, out.dtype={out.dtype}, out.device={out.device}')
            out_np = out.detach().cpu().float().numpy()
        else:
            out_np = np.asarray(out, dtype=np.float32)
        log.info(f'[re] out_np.shape={out_np.shape}, out_np.ndim={out_np.ndim}')
        if out_np.ndim == 0:
            out_np = out_np.reshape(1)
        elif out_np.ndim > 1:
            out_np = out_np.squeeze()
            if out_np.ndim > 1:
                out_np = out_np[0]  # ilk kanalı al
        sr_int = int(sr_out.item()) if isinstance(sr_out, (torch.Tensor, np.ndarray)) else int(sr_out)
        log.info(f'[re] sf.write: shape={out_np.shape}, sr={sr_int}')
        sf.write(tmp_wav + '_out.wav', out_np, sr_int)
        r2 = subprocess.run(['ffmpeg', '-y', '-i', tmp_wav + '_out.wav', '-q:a', '2', tmp_out],
                            capture_output=True, timeout=120)
        if r2.returncode != 0:
            raise RuntimeError('ffmpeg MP3: ' + r2.stderr.decode('utf-8', errors='replace')[-200:])
        log.info('[re] Resemble Enhance tamamlandı')
        base = os.path.splitext(f.filename or 'ses')[0]
        resp = send_file(tmp_out, mimetype='audio/mpeg', as_attachment=True,
                         download_name=base + '_enhanced.mp3')
        @after_this_request
        def _cleanup(response):
            for p in [tmp_in, tmp_wav, tmp_out, tmp_wav+'_out.wav']:
                try: os.unlink(p)
                except Exception: pass
            return response
        return resp
    except Exception as e:
        for p in [tmp_in, tmp_wav, tmp_out]:
            try: os.unlink(p)
            except Exception: pass
        import traceback
        log.error(f'[re] Hata: {e}\n{traceback.format_exc()}')
        return jsonify({'success': False, 'error': str(e)}), 500


# ── DeepFilterNet ───────────────────────────────────────────────────────────────
@app.route('/api/deepfilter', methods=['POST'])
def deepfilter_enhance():
    """DeepFilterNet — gerçek zamanlı derin filtre: konuşma netliği maksimum, arka plan sıfır."""
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Dosya bulunamadı'}), 400
    import tempfile
    f      = request.files['file']
    auto_boost = request.form.get('auto_boost', '').lower() == 'true'
    suffix = os.path.splitext(f.filename or 'audio')[1] or '.mp3'
    tmp_in  = os.path.join(tempfile.gettempdir(), f'df_in_{int(time.time()*1000)}{suffix}')
    tmp_wav = tmp_in.replace(suffix, '_48k.wav')
    tmp_out = tmp_in.replace(suffix, '_df.mp3')
    f.save(tmp_in)
    try:
        # DeepFilterNet 48kHz bekler — uzun dosyalar için input boyutuna göre timeout
        try:
            _df_in_mb = os.path.getsize(tmp_in) / 1024 / 1024
        except Exception:
            _df_in_mb = 0
        _df_wav_timeout = max(300, min(3600, int(_df_in_mb * 2)))
        log.info(f'[df] MP3→48kHz WAV ({_df_in_mb:.0f}MB), timeout={_df_wav_timeout}s')
        r = subprocess.run(['ffmpeg', '-y', '-i', tmp_in, '-ar', '48000', '-ac', '1', tmp_wav],
                           capture_output=True, timeout=_df_wav_timeout)
        if r.returncode != 0:
            raise RuntimeError('ffmpeg: ' + r.stderr.decode('utf-8', errors='replace')[-200:])
        try:
            import soundfile as sf_df
            import numpy as np
            from df.enhance import enhance as df_enhance, init_df
            from df.io import load_audio as df_load, save_audio as df_save

            # ── DeepFilterNet device seçimi ──────────────────────────────────────
            # Tarihçe: cuDNN'in RNN kernel'i bazı GPU/CUDA kombinasyonlarında
            # (özellikle Blackwell — RTX 50xx) GRU forward pass'ını patlatıyor.
            # Eski çözüm: torch.cuda.is_available = lambda: False ile CPU'ya zorla.
            # Yeni çözüm: cudnn'i kapat (PyTorch CUDA kernel'lerine düşer), önce GPU dene,
            # başarısız olursa CPU'ya otomatik fallback. CPU'dan ~10-30× hızlı olur.
            #
            # USE_DEEPFILTER_GPU=0 environment variable ile zorla CPU'ya alabilirsiniz.
            _df_force_cpu = os.environ.get('USE_DEEPFILTER_GPU', '1').strip() == '0'
            _df_used_device = 'unknown'
            _df_gpu_error = None
            out_path = tmp_wav + '_out.wav'

            def _df_run(force_cpu_mode):
                """Tek bir DeepFilter geçişi. force_cpu_mode=True ise CUDA bypass'lı.
                Döndürür: kullanılan device adı.
                NOT: DeepFilterNet API'si — model GPU'da, audio tensor CPU'da olmalıdır.
                Kütüphane içeride STFT'yi rust ile CPU'da yapıp özellik tensor'ını GPU'ya taşır.
                Bu yüzden audio.to(device) ÇAĞIRMAYIN — TypeError'a yol açar."""
                # cuDNN'i her durumda kapat — Blackwell GRU bug'ından kaçınmak için
                _orig_cudnn = torch.backends.cudnn.enabled
                torch.backends.cudnn.enabled = False
                _orig_is_avail = torch.cuda.is_available
                if force_cpu_mode:
                    torch.cuda.is_available = lambda: False
                try:
                    model, df_state, _ = init_df()
                    target_sr = df_state.sr()
                    audio, _info = df_load(tmp_wav, sr=target_sr)
                    try:
                        _dev = str(next(model.parameters()).device)
                    except Exception:
                        _dev = 'cpu' if force_cpu_mode else 'cuda?'
                    total_samples = audio.shape[-1]
                    audio_dur = total_samples / target_sr
                    log.info(f'[df] DeepFilterNet başlıyor (device={_dev}, cudnn=off)... shape={tuple(audio.shape)}, sr={target_sr}, dur={audio_dur:.0f}s')

                    # ── Chunked inference ───────────────────────────────────────
                    # 12 GB VRAM bile 2.5 saatlik dosyayı tek seferde sığdıramıyor.
                    # Audio'yu parçalara böl, her birini ayrı işle, birleştir.
                    # CPU modunda chunk'lamaya gerek yok ama kod basit kalsın diye
                    # her iki durumda da chunk yapıyoruz; CPU'da fark etmez.
                    chunk_sec = 30  # 30sn × 48kHz = 1.44M sample, ~5 MB float32 → güvenli
                    chunk_samples = int(chunk_sec * target_sr)
                    out_parts = []
                    n_chunks = (total_samples + chunk_samples - 1) // chunk_samples
                    log.info(f'[df] Chunked inference: {n_chunks} parça × {chunk_sec}sn')

                    cur_chunk_samples = chunk_samples
                    i = 0
                    s = 0
                    while s < total_samples:
                        e = min(s + cur_chunk_samples, total_samples)
                        chunk = audio[:, s:e]
                        try:
                            enh = df_enhance(model, df_state, chunk)
                        except RuntimeError as _e_chunk:
                            _msg = str(_e_chunk)
                            # OOM: bu chunk'ı yarıya böl ve tekrar dene
                            if 'out of memory' in _msg.lower() and cur_chunk_samples > target_sr * 2:
                                cur_chunk_samples = max(int(cur_chunk_samples / 2), target_sr * 2)
                                try: torch.cuda.empty_cache()
                                except Exception: pass
                                log.warning(f'[df] OOM @ chunk {i+1}, chunk_samples → {cur_chunk_samples} ({cur_chunk_samples/target_sr:.0f}sn), tekrar deneniyor')
                                continue  # aynı pozisyondan, daha küçük chunk ile
                            raise
                        if hasattr(enh, 'cpu'):
                            enh = enh.cpu()
                        out_parts.append(enh)
                        s = e
                        i += 1
                        # 10 chunk'ta bir progress logu
                        if i % 10 == 0 or i == n_chunks:
                            pct = round(100 * s / total_samples, 1)
                            log.info(f'[df]   chunk {i}/{n_chunks} (%{pct})')
                        # GPU cache temizle (parçalar arası boşalt)
                        if 'cuda' in _dev:
                            try: torch.cuda.empty_cache()
                            except Exception: pass

                    # Parçaları birleştir
                    enhanced = torch.cat(out_parts, dim=-1) if len(out_parts) > 1 else out_parts[0]
                    # Belleği boşalt
                    out_parts.clear()
                    df_save(out_path, enhanced, target_sr)
                    return _dev
                finally:
                    torch.backends.cudnn.enabled = _orig_cudnn
                    torch.cuda.is_available = _orig_is_avail
                    # GPU mode bittikten sonra cache'i serbest bırak
                    try: torch.cuda.empty_cache()
                    except Exception: pass

            if _df_force_cpu or not torch.cuda.is_available():
                _df_used_device = _df_run(force_cpu_mode=True)
            else:
                # Önce GPU dene; bug çıkarsa CPU'ya düş.
                try:
                    _df_used_device = _df_run(force_cpu_mode=False)
                except Exception as _e_gpu:
                    _df_gpu_error = str(_e_gpu)[:300]
                    log.warning(f'[df] GPU denemesi başarısız, CPU\'ya geçiliyor: {_df_gpu_error}')
                    # CUDA OOM olabilir — cache'i temizle
                    try: torch.cuda.empty_cache()
                    except Exception: pass
                    _df_used_device = _df_run(force_cpu_mode=True)

            log.info(f'[df] DeepFilterNet tamamlandı (device={_df_used_device}): {out_path}')
        except ImportError:
            raise RuntimeError('DeepFilterNet kurulu değil. pip install deepfilternet')
        # Auto-boost: düşük sesli bölgeleri tespit et ve yükselt
        tmp_boost = None
        if auto_boost:
            try:
                tmp_16k = out_path + '_16k.wav'
                rb = subprocess.run(
                    ['ffmpeg', '-y', '-i', out_path, '-ar', '16000', '-ac', '1', tmp_16k],
                    capture_output=True, timeout=120)
                if rb.returncode == 0:
                    boost_segs = _detect_low_volume(tmp_16k)
                    if boost_segs:
                        expr = '1'
                        for b in reversed(boost_segs):
                            gain_lin = round(10 ** (b['suggested_db'] / 20), 4)
                            expr = f"if(between(t,{b['start']},{b['end']}),{gain_lin},{expr})"
                        tmp_boost = out_path + '_boosted.wav'
                        rb2 = subprocess.run(
                            ['ffmpeg', '-y', '-i', out_path, '-af', f"volume='{expr}'", tmp_boost],
                            capture_output=True, timeout=300)
                        if rb2.returncode == 0:
                            out_path = tmp_boost
                            log.info(f'[df] Auto-boost: {len(boost_segs)} düşük sesli bölge yükseltildi')
                        else:
                            tmp_boost = None
                            log.warning('[df] Auto-boost ffmpeg başarısız, orijinal kullanılıyor')
                try: os.unlink(tmp_16k)
                except Exception: pass
            except Exception as e_ab:
                log.warning(f'[df] Auto-boost atlandı: {e_ab}')

        # Uzun dosyalar için 300s yetersiz — DeepFilter çıktı boyutuna göre ölçekle
        try:
            _df_out_mb = os.path.getsize(out_path) / 1024 / 1024
        except Exception:
            _df_out_mb = 0
        _df_mp3_timeout = max(600, min(3600, int(_df_out_mb * 2)))
        log.info(f'[df] WAV→MP3 ({_df_out_mb:.0f}MB), timeout={_df_mp3_timeout}s')
        r2 = subprocess.run(['ffmpeg', '-y', '-i', out_path, '-q:a', '2', tmp_out],
                            capture_output=True, timeout=_df_mp3_timeout)
        if r2.returncode != 0:
            raise RuntimeError('ffmpeg MP3: ' + r2.stderr.decode('utf-8', errors='replace')[-200:])
        log.info('[df] DeepFilterNet tamamlandı')
        base = os.path.splitext(f.filename or 'ses')[0]
        resp = send_file(tmp_out, mimetype='audio/mpeg', as_attachment=True,
                         download_name=base + '_df.mp3')
        _attach_quality_header(resp, tmp_out)
        @after_this_request
        def _cleanup(response):
            for p in [tmp_in, tmp_wav, tmp_out, out_path]:
                try: os.unlink(p)
                except Exception: pass
            if tmp_boost:
                try: os.unlink(tmp_boost)
                except Exception: pass
            return response
        return resp
    except Exception as e:
        for p in [tmp_in, tmp_wav, tmp_out]:
            try: os.unlink(p)
            except Exception: pass
        log.error(f'[df] Hata: {e}')
        return jsonify({'success': False, 'error': str(e)}), 500


# ── Coqui TTS ──────────────────────────────────────────────────────────────────

_tts_model = None
_tts_lock  = threading.Lock()

def get_tts_model():
    global _tts_model
    if _tts_model is not None:
        return _tts_model
    with _tts_lock:
        if _tts_model is not None:
            return _tts_model
        from TTS.api import TTS
        _dev = 'cuda' if torch.cuda.is_available() else 'cpu'
        log.info(f'[tts] XTTS v2 modeli yükleniyor — device={_dev}')
        _tts_model = TTS('tts_models/multilingual/multi-dataset/xtts_v2').to(_dev)
        log.info('[tts] Model hazır')
        return _tts_model


@app.route('/api/tts', methods=['POST'])
def tts_synthesize():
    """Coqui TTS ile metni seslendır. speaker_wav varsa ses klonlama yapar."""
    try:
        from TTS.api import TTS
    except ImportError:
        return jsonify({'success': False, 'error': 'TTS kurulu değil. pip install TTS'}), 500

    text     = request.form.get('text', '').strip()
    language = request.form.get('language', 'tr').strip()
    if not text:
        return jsonify({'success': False, 'error': 'Metin boş'}), 400

    ts      = int(time.time() * 1000)
    tmp_spk = None
    tmp_out = os.path.join(tempfile.gettempdir(), f'tts_out_{ts}.wav')
    tmp_mp3 = os.path.join(tempfile.gettempdir(), f'tts_out_{ts}.mp3')

    try:
        model = get_tts_model()

        # Referans ses dosyası (voice cloning)
        if 'speaker_wav' in request.files:
            f_spk  = request.files['speaker_wav']
            suffix = os.path.splitext(f_spk.filename or 'ref')[1] or '.wav'
            tmp_spk = os.path.join(tempfile.gettempdir(), f'tts_ref_{ts}{suffix}')
            f_spk.save(tmp_spk)
            log.info(f'[tts] Voice cloning: ref={tmp_spk}, lang={language}, text={text[:60]}')
            model.tts_to_file(text=text, file_path=tmp_out,
                              speaker_wav=tmp_spk, language=language)
        else:
            log.info(f'[tts] Varsayılan ses: lang={language}, text={text[:60]}')
            model.tts_to_file(text=text, file_path=tmp_out, language=language)

        # WAV → MP3
        r = subprocess.run(['ffmpeg', '-y', '-i', tmp_out, '-q:a', '2', tmp_mp3],
                           capture_output=True, timeout=60)
        out_file = tmp_mp3 if r.returncode == 0 else tmp_out
        mime     = 'audio/mpeg' if out_file.endswith('.mp3') else 'audio/wav'

        log.info(f'[tts] Seslendirme tamamlandı: {out_file}')
        resp = send_file(out_file, mimetype=mime, as_attachment=True,
                         download_name='tts_output.mp3')

        @after_this_request
        def _cleanup(response):
            for p in [tmp_out, tmp_mp3, tmp_spk]:
                if p:
                    try: os.unlink(p)
                    except Exception: pass
            return response
        return resp

    except Exception as e:
        for p in [tmp_out, tmp_mp3, tmp_spk]:
            if p:
                try: os.unlink(p)
                except Exception: pass
        log.error(f'[tts] Hata: {e}')
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/tts/voices', methods=['GET'])
def tts_voices():
    """Kullanılabilir TTS seslerini listele."""
    try:
        from TTS.api import TTS
    except ImportError:
        return jsonify({'success': False, 'error': 'TTS kurulu değil. pip install TTS'}), 500
    try:
        models = TTS().list_models()
        # Multilingual modelleri filtrele
        multi = [m for m in models if 'multilingual' in m or 'xtts' in m.lower()]
        return jsonify({
            'success': True,
            'current': 'tts_models/multilingual/multi-dataset/xtts_v2',
            'multilingual': multi,
            'all_count': len(models),
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/system-stats', methods=['GET'])
def system_stats():
    import psutil, shutil
    cpu = psutil.cpu_percent(interval=1)
    ram = psutil.virtual_memory()
    disk = shutil.disk_usage('/')
    stats = {
        'cpu_percent': round(cpu, 1), 'cpu_pct': round(cpu, 1),
        'ram_percent': round(ram.percent, 1), 'ram_pct': round(ram.percent, 1),
        'ram_used_gb': round(ram.used / 1024**3, 1),
        'ram_total_gb': round(ram.total / 1024**3, 1),
        'disk_used_gb': round(disk.used / 1024**3, 1),
        'disk_total_gb': round(disk.total / 1024**3, 1),
        'gpu_name': None,
        'gpu_percent': 0, 'gpu_pct': 0,
        'vram_used_mb': 0, 'vram_total_mb': 0,
        'gpu_mem_used_mb': 0, 'gpu_mem_total_mb': 0,
        'gpu_temp': None,
        'gpu_clock_mhz': None, 'gpu_clock_limit_mhz': 2470,
    }
    try:
        from pynvml import (nvmlInit, nvmlDeviceGetHandleByIndex,
            nvmlDeviceGetUtilizationRates, nvmlDeviceGetMemoryInfo,
            nvmlDeviceGetTemperature, nvmlDeviceGetName,
            nvmlDeviceGetClockInfo, nvmlDeviceGetMaxClockInfo,
            NVML_TEMPERATURE_GPU, NVML_CLOCK_GRAPHICS)
        nvmlInit()
        h = nvmlDeviceGetHandleByIndex(0)
        u = nvmlDeviceGetUtilizationRates(h)
        m = nvmlDeviceGetMemoryInfo(h)
        name = nvmlDeviceGetName(h)
        if isinstance(name, bytes): name = name.decode('utf-8')
        stats['gpu_name'] = name
        stats['gpu_percent'] = u.gpu
        stats['gpu_pct'] = u.gpu
        stats['gpu_mem_used_mb'] = round(m.used / 1024**2)
        stats['gpu_mem_total_mb'] = round(m.total / 1024**2)
        stats['vram_used_mb'] = round(m.used / 1024**2)
        stats['vram_total_mb'] = round(m.total / 1024**2)
        stats['gpu_temp'] = nvmlDeviceGetTemperature(h, NVML_TEMPERATURE_GPU)
        try:
            stats['gpu_clock_mhz'] = nvmlDeviceGetClockInfo(h, NVML_CLOCK_GRAPHICS)
            stats['gpu_clock_limit_mhz'] = nvmlDeviceGetMaxClockInfo(h, NVML_CLOCK_GRAPHICS)
        except Exception:
            pass
    except Exception as e:
        print(f"[WARN] GPU verisi alınamadı: {e}")
        stats['gpu_name'] = 'Algılanamadı'
    return jsonify(stats)


@app.route('/api/diarize', methods=['POST'])
def diarize():
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Dosya bulunamadı'}), 400
    hf_token = request.form.get('hf_token') or os.environ.get('HF_TOKEN', '')
    if not hf_token:
        return jsonify({'success': False, 'error': 'HuggingFace token gerekli.'}), 400

    f      = request.files['file']
    suffix = os.path.splitext(f.filename or 'audio')[1] or '.audio'
    tmp    = os.path.join(tempfile.gettempdir(), f'diar_{int(time.time())}{suffix}')
    f.save(tmp)

    num_speakers = request.form.get('num_speakers', '').strip()
    job_id = f'd{int(time.time()*1000) % 999999:06d}'
    _diar_jobs[job_id] = {'status': 'running', 'pct': 0, 'step': 'Başlatılıyor…', 'result': None, 'error': None}

    t = threading.Thread(target=_run_diar_job, args=(job_id, tmp, hf_token, num_speakers), daemon=True)
    t.start()
    return jsonify({'job_id': job_id})


@app.route('/api/diarize/progress/<job_id>')
def diarize_progress(job_id):
    job = _diar_jobs.get(job_id)
    if not job:
        return jsonify({'error': 'Job bulunamadı'}), 404
    resp = {k: v for k, v in job.items() if k != 'result'}
    if job['status'] == 'done':
        resp['result'] = job['result']
        _diar_jobs.pop(job_id, None)
    return jsonify(resp)


# ── demucs Vokal İzolasyonu ────────────────────────────────────────────────────

@app.route('/api/denoise', methods=['POST'])
def denoise():
    """demucs ile vokal/gürültü ayrıştırma. İstenen stem dosyası döner."""
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Dosya bulunamadı'}), 400

    stem   = request.form.get('stem', 'vocals')   # vocals | no_vocals
    f      = request.files['file']
    suffix = os.path.splitext(f.filename or 'audio')[1] or '.audio'
    tmp_in = os.path.join(tempfile.gettempdir(), f'dmc_in_{int(time.time())}{suffix}')
    out_dir= os.path.join(tempfile.gettempdir(), f'dmc_out_{int(time.time())}')
    f.save(tmp_in)
    os.makedirs(out_dir, exist_ok=True)

    try:
        log.info(f'[denoise] demucs başlıyor, stem={stem}...')
        # torchaudio.save torchcodec gerektiriyor — soundfile ile patch et
        wrapper = tempfile.mktemp(suffix='_demucs_run.py')
        with open(wrapper, 'w', encoding='utf-8') as wf:
            wf.write('''import soundfile as sf
import torchaudio, sys

def _sf_save(filepath, tensor, sample_rate, **kw):
    import numpy as np
    audio = tensor.numpy()
    if audio.ndim == 2:
        audio = audio.T
    sf.write(str(filepath), audio, sample_rate)

torchaudio.save = _sf_save

from demucs.__main__ import main
sys.exit(main())
''')
        import torch as _torch
        _demucs_dev = 'cuda' if _torch.cuda.is_available() else 'cpu'
        log.info(f'[demucs] device={_demucs_dev}')
        cmd = [sys.executable, wrapper,
               '--two-stems=vocals', '--out', out_dir, '-n', 'htdemucs',
               '--device', _demucs_dev, tmp_in]
        r = subprocess.run(cmd, capture_output=True, timeout=900, text=True)
        try: os.unlink(wrapper)
        except Exception: pass
        if r.returncode != 0:
            raise RuntimeError(f'demucs hatası: {r.stderr[-400:]}')

        # Çıktı dosyasını bul: demucs/htdemucs/<basename>/<stem>.wav
        out_wav = None
        for root, _, files in os.walk(out_dir):
            for fn in files:
                if fn == f'{stem}.wav':
                    out_wav = os.path.join(root, fn)
                    break
            if out_wav:
                break
        if not out_wav:
            raise RuntimeError('demucs çıktı dosyası bulunamadı')

        # WAV → MP3
        # Uzun dosyalar (2+ saat) için 120s yetersiz — dosya boyutuna göre ölçekle.
        # ~10MB/saniye ile encode hızını varsayalım, min 600s, max 3600s.
        tmp_mp3 = out_wav.replace('.wav', '.mp3')
        try:
            _wav_size_mb = os.path.getsize(out_wav) / 1024 / 1024
        except Exception:
            _wav_size_mb = 0
        _mp3_timeout = max(600, min(3600, int(_wav_size_mb * 2)))  # ~2s/MB, 10dk-1sa arası
        log.info(f'[denoise] WAV→MP3 ({_wav_size_mb:.0f}MB), timeout={_mp3_timeout}s')
        _mp3_res = subprocess.run(['ffmpeg', '-y', '-i', out_wav, '-q:a', '2', tmp_mp3],
                       capture_output=True, timeout=_mp3_timeout)
        if _mp3_res.returncode != 0:
            log.warning(f'[denoise] MP3 encode başarısız (kod={_mp3_res.returncode}), WAV döndürülüyor')
        out_file = tmp_mp3 if os.path.exists(tmp_mp3) else out_wav

        @after_this_request
        def cleanup(response):
            try: os.unlink(tmp_in)
            except Exception: pass
            try:
                import shutil
                shutil.rmtree(out_dir, ignore_errors=True)
            except Exception: pass
            return response

        base = os.path.splitext(f.filename or 'ses')[0]
        ext  = 'mp3' if out_file.endswith('.mp3') else 'wav'
        mime = 'audio/mpeg' if ext == 'mp3' else 'audio/wav'
        return send_file(out_file, mimetype=mime, as_attachment=True,
                         download_name=f'{base}_{stem}.{ext}')
    except FileNotFoundError:
        return jsonify({'success': False,
                        'error': 'demucs kurulu değil. Terminal: pip install demucs'}), 500
    except Exception as e:
        log.error(f'[denoise] Hata: {e}')
        try: os.unlink(tmp_in)
        except Exception: pass
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/noise_clean', methods=['POST'])
def noise_clean():
    """Çok katmanlı FFmpeg filtresi ile arka plan gürültüsü temizleme."""
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Dosya bulunamadı'}), 400

    f        = request.files['file']
    # strength: 1–10 (UI slider değeri)
    strength = int(float(request.form.get('strength', 5)))
    strength = max(1, min(10, strength))

    suffix  = os.path.splitext(f.filename or 'audio')[1] or '.audio'
    tmp_in  = os.path.join(tempfile.gettempdir(), f'nc_in_{int(time.time())}{suffix}')
    tmp_out = os.path.join(tempfile.gettempdir(), f'nc_out_{int(time.time())}.mp3')
    f.save(tmp_in)
    log.info(f'[noise_clean] başlıyor, güç={strength}/10')

    try:
        # Güç seviyesine göre artan filtre zinciri:
        # afftdn  → Adaptive FFT Denoiser (frekans alanı, sürekli gürültü)
        #   nf  = noise floor (dBFS, düşük = daha agresif)
        #   nr  = noise reduction oranı (0-1, 1=tam)
        #   tn  = noise tracking (1 = değişen gürültüye adapte olur — büyük iyileştirme)
        # anlmdn  → Non-Local Means Denoiser (zaman alanı, rastgele gürültü)
        # eq_hum  → 50/60 Hz elektrik hattı uğultusu + harmonikler notch filtre
        # highpass → düşük frekanslı uğultu/gürültü kaldır
        # loudnorm → ses seviyesini normalize et (filtreden sonra düşen sesi düzelt)
        _dn_soft  = 'afftdn=nf=-25:nr=0.5:nt=w:tn=1'
        _dn_med   = 'afftdn=nf=-35:nr=0.85:nt=w:tn=1'
        _dn_hard  = 'afftdn=nf=-45:nr=1.0:nt=w:tn=1'           # maksimum FFT denoiser
        _nlm_med  = 'anlmdn=s=7:p=0.002:r=0.002:m=15'
        _nlm_hard = 'anlmdn=s=12:p=0.001:r=0.001:m=21'          # çok agresif NLM
        # Elektrik hattı hum: 50 Hz (Türkiye) ve 2. harmonik 100 Hz notch
        _eq_hum   = 'equalizer=f=50:width_type=o:width=1.5:g=-18,equalizer=f=100:width_type=o:width=1.5:g=-12'
        _snm      = 'speechnorm=e=6.25:r=0.00001:l=1'
        _norm     = 'loudnorm=I=-20:TP=-1.0:LRA=15'
        if strength <= 2:
            # Çok hafif: tek geçiş yumuşak + noise tracking
            af = f'{_dn_soft},{_norm}'
        elif strength <= 4:
            # Hafif: afftdn orta + hum filter + anlmdn
            af = f'highpass=f=80,{_eq_hum},{_dn_med},{_nlm_med},{_norm}'
        elif strength <= 6:
            # Orta: highpass + hum + 2× afftdn + anlmdn
            af = f'highpass=f=100,{_eq_hum},{_dn_med},{_nlm_med},{_dn_med},{_norm}'
        elif strength <= 8:
            # Güçlü: bant + hum + 2× hard afftdn + hard NLM + speechnorm
            af = f'highpass=f=100,lowpass=f=8000,{_eq_hum},{_dn_hard},{_nlm_med},{_dn_hard},{_snm},{_norm}'
        else:
            # Maksimum: bant + hum + 3× hard afftdn + 2× hard NLM + speechnorm
            af = (f'highpass=f=120,lowpass=f=7500,'
                  f'{_eq_hum},'
                  f'{_dn_hard},{_nlm_hard},'
                  f'{_dn_hard},{_nlm_hard},'
                  f'{_dn_hard},'
                  f'{_snm},{_norm}')

        cmd = ['ffmpeg', '-y', '-i', tmp_in, '-af', af, '-q:a', '2', tmp_out]
        result = subprocess.run(cmd, capture_output=True, timeout=300)
        if result.returncode != 0:
            err = result.stderr.decode('utf-8', errors='replace')
            raise RuntimeError('FFmpeg hatası: ' + err[-300:])

        @after_this_request
        def cleanup(response):
            try: os.unlink(tmp_in)
            except Exception: pass
            try: os.unlink(tmp_out)
            except Exception: pass
            return response

        base = os.path.splitext(f.filename or 'ses')[0]
        return send_file(tmp_out, mimetype='audio/mpeg', as_attachment=True,
                         download_name=f'{base}_temiz.mp3')
    except Exception as e:
        log.error(f'[noise_clean] Hata: {e}')
        try: os.unlink(tmp_in)
        except Exception: pass
        return jsonify({'success': False, 'error': str(e)}), 500


_sp_jobs = {}  # job_id → {status, pct, step, file, error}

def _run_sp_job(job_id, tmp_in, segs, strength, tmp_out):
    """
    Concat demuxer yaklaşımı: filter_complex yerine ffconcat listesi kullanır.
    542 segment için filter_complex FFmpeg'i dakikalarca başlatma aşamasında bloke eder,
    concat demuxer ise anında başlar ve gerçek zamanlı progress verir.
    """
    job = _sp_jobs[job_id]
    tmp_concat = None
    tmp_raw    = None
    prog_file  = None
    try:
        import re as _re
        _ot_re = _re.compile(r'out_time=(\d+):(\d+):(\d+\.?\d*)')

        # Örtüşen segmentleri merge et (farklı konuşmacılar aynı zamanı kapsayabilir)
        segs_sorted = sorted(segs, key=lambda s: s['start'])
        merged = []
        for seg in segs_sorted:
            s, e = float(seg['start']), float(seg['end'])
            if merged and s <= merged[-1][1]:          # örtüşüyor veya bitişik
                merged[-1] = (merged[-1][0], max(merged[-1][1], e))
            else:
                merged.append((s, e))
        n_orig = len(segs_sorted)
        segs_sorted = [{'start': s, 'end': e} for s, e in merged]
        n = len(segs_sorted)
        total_dur = sum(s['end'] - s['start'] for s in segs_sorted)
        log.info(f'[process_speakers] job={job_id} n_orig={n_orig}→n={n} güç={strength} dur={total_dur:.1f}s')

        # ── 1. ffconcat listesi oluştur ──────────────────────────────────────────
        job['step'] = f'{n} segment için concat listesi hazırlanıyor…'; job['pct'] = 3
        tmp_concat = tempfile.mktemp(suffix='_concat.txt')
        # tmp_in'in Windows yolunu düzelt (ffconcat single-quote ister)
        safe_in = tmp_in.replace('\\', '/').replace("'", "\\'")
        with open(tmp_concat, 'w', encoding='utf-8') as fh:
            fh.write('ffconcat version 1.0\n')
            for seg in segs_sorted:
                fh.write(f"file '{safe_in}'\n")
                fh.write(f"inpoint {seg['start']}\n")
                fh.write(f"outpoint {seg['end']}\n")

        # ── 2. Gürültü filtre zinciri ────────────────────────────────────────────
        # afftdn  : spektral gürültü azaltma — tn=1 ile değişen gürültüyü takip eder
        # anlmdn  : non-local means (zaman alanı, rastgele gürültü)
        # adeclick: darbe/tıklama/vurma sesleri kaldırma
        # agate   : gürültü kapısı — konuşma seviyesinin altındaki sesleri keser
        # eq_hum  : 50/100 Hz elektrik hattı uğultusu notch
        # speechnorm/loudnorm: normalize
        _nrm  = 'loudnorm=I=-20:TP=-1.0:LRA=15'
        _dn1  = 'afftdn=nf=-30:nr=0.85:nt=w:tn=1'   # orta güçlü + noise tracking
        _dn2  = 'afftdn=nf=-45:nr=1.0:nt=w:tn=1'    # maksimum güç + noise tracking
        _nlm  = 'anlmdn=s=7:p=0.002:r=0.002:m=15'
        _nlm2 = 'anlmdn=s=12:p=0.001:r=0.001:m=21'
        _clk  = 'adeclick=w=55:t=25'
        _gt   = 'agate=threshold=0.008:ratio=15:attack=3:release=200'  # daha agresif gate
        _hum  = 'equalizer=f=50:width_type=o:width=1.5:g=-18,equalizer=f=100:width_type=o:width=1.5:g=-12'
        _snm  = 'speechnorm=e=6.25:r=0.00001:l=1'

        if strength == 0:
            af = _nrm
        elif strength <= 2:
            af = f'{_dn1},{_nrm}'
        elif strength <= 4:
            af = f'highpass=f=80,{_hum},{_dn1},{_dn1},{_nrm}'
        elif strength <= 6:
            af = f'highpass=f=80,{_hum},{_clk},{_dn1},{_nlm},{_dn1},{_nrm}'
        elif strength <= 8:
            af = f'highpass=f=100,lowpass=f=8000,{_hum},{_clk},{_dn2},{_gt},{_nlm},{_dn1},{_snm},{_nrm}'
        else:
            # Maksimum: bant + hum + tıklama + 2× hard afftdn + hard NLM + gate + speechnorm
            af = f'highpass=f=100,lowpass=f=8000,{_hum},{_clk},{_dn2},{_gt},{_nlm2},{_dn2},{_snm},{_nrm}'

        # ── 3. FFmpeg — concat demuxer + ses filtresi ─────────────────────────────
        job['step'] = 'FFmpeg birleştiriyor ve işliyor…'; job['pct'] = 8
        prog_file = tmp_concat + '.prog'
        cmd = ['ffmpeg', '-y',
               '-f', 'concat', '-safe', '0', '-i', tmp_concat,
               '-af', af,
               '-q:a', '2',
               '-progress', prog_file,
               tmp_out]

        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

        stderr_buf = []
        def _drain():
            try: stderr_buf.append(proc.stderr.read())
            except Exception: pass
        threading.Thread(target=_drain, daemon=True).start()

        # Progress dosyasını poll et
        while proc.poll() is None:
            time.sleep(0.5)
            try:
                if os.path.exists(prog_file):
                    with open(prog_file, 'r', errors='ignore') as pf:
                        content = pf.read()
                    last = None
                    for m in _ot_re.finditer(content):
                        last = m
                    if last:
                        done_s = int(last.group(1))*3600 + int(last.group(2))*60 + float(last.group(3))
                        pct = min(90, 8 + int(done_s / max(total_dur, 1) * 82))
                        job['pct'] = pct
                        job['step'] = f'FFmpeg işliyor… %{pct}  ({done_s:.0f}s / {total_dur:.0f}s)'
            except Exception:
                pass

        try: os.unlink(prog_file); prog_file = None
        except Exception: pass
        try: os.unlink(tmp_concat); tmp_concat = None
        except Exception: pass

        if proc.returncode != 0:
            err = b''.join(stderr_buf).decode('utf-8', errors='replace')
            raise RuntimeError(err[-800:])

        job['step'] = 'Tamamlandı! İndiriliyor…'; job['pct'] = 100; job['status'] = 'done'
        job['file'] = tmp_out
        log.info(f'[process_speakers] job={job_id} tamamlandı')

    except Exception as e:
        log.error(f'[process_speakers] job={job_id} hata: {e}')
        job['status'] = 'error'; job['error'] = str(e)
    finally:
        try: os.unlink(tmp_in)
        except Exception: pass
        for f in [tmp_concat, tmp_raw, prog_file]:
            if f:
                try: os.unlink(f)
                except Exception: pass


@app.route('/api/process_speakers', methods=['POST'])
def process_speakers():
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Dosya bulunamadı'}), 400
    if 'segments' not in request.form:
        return jsonify({'success': False, 'error': 'Segment bilgisi eksik'}), 400

    f        = request.files['file']
    segs     = json.loads(request.form.get('segments', '[]'))
    strength = max(0, min(10, int(float(request.form.get('strength', 5)))))

    if not segs:
        return jsonify({'success': False, 'error': 'Segment listesi boş'}), 400

    suffix  = os.path.splitext(f.filename or 'ses')[1] or '.wav'
    tmp_in  = tempfile.mktemp(suffix=suffix)
    tmp_out = tempfile.mktemp(suffix='.mp3')
    f.save(tmp_in)

    job_id = f'{int(time.time()*1000) % 999999:06d}'
    _sp_jobs[job_id] = {'status': 'running', 'pct': 0, 'step': 'Başlatılıyor…', 'file': None, 'error': None}

    t = threading.Thread(target=_run_sp_job, args=(job_id, tmp_in, segs, strength, tmp_out), daemon=True)
    t.start()
    return jsonify({'job_id': job_id})


@app.route('/api/process_speakers/progress/<job_id>')
def process_speakers_progress(job_id):
    job = _sp_jobs.get(job_id)
    if not job:
        return jsonify({'error': 'Job bulunamadı'}), 404
    return jsonify({k: v for k, v in job.items() if k != 'file'})


@app.route('/api/process_speakers/download/<job_id>')
def process_speakers_download(job_id):
    job = _sp_jobs.pop(job_id, None)
    if not job or job['status'] != 'done' or not job.get('file'):
        return jsonify({'error': 'Hazır değil'}), 400
    return send_file(job['file'], mimetype='audio/mpeg', as_attachment=True,
                     download_name='konusmaci_secim.mp3')


# ── Whisper Word-Level Alignment ────────────────────────────────────────────────

@app.route('/api/align', methods=['POST'])
def align_words():
    """
    Ses dosyasını Whisper ile kelime bazlı hizala.
    Mevcut transkript segmentlerini alır, word_timestamps ile kelimeleri eşler.
    """
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Dosya bulunamadı'}), 400

    f = request.files['file']
    transcript_json = request.form.get('transcript', '[]')
    try:
        transcript = json.loads(transcript_json)
    except Exception:
        transcript = []

    language = request.form.get('language') or None
    suffix   = os.path.splitext(f.filename or 'audio')[1] or '.mp3'
    tmp_in   = os.path.join(tempfile.gettempdir(), f'align_{int(time.time()*1000)}{suffix}')
    f.save(tmp_in)

    try:
        model = get_whisper()
        log.info(f'[align] Kelime hizalama başlıyor: {len(transcript)} segment')

        fw_segs, info = model.transcribe(
            tmp_in,
            language=language,
            task='transcribe',
            word_timestamps=True,
            condition_on_previous_text=True,
        )

        # Whisper kelimelerini topla
        all_words = []
        for seg in fw_segs:
            for w in (seg.words or []):
                all_words.append({
                    'word':  w.word.strip(),
                    'start': round(w.start, 3),
                    'end':   round(w.end, 3),
                    'prob':  round(w.probability, 3),
                })

        # Transkript segmentlerine kelimeleri eşle (zaman örtüşmesi)
        aligned = []
        for t_seg in transcript:
            seg_start = float(t_seg.get('start', 0))
            seg_end   = float(t_seg.get('end', 0))
            seg_words = [
                w for w in all_words
                if w['start'] >= seg_start - 0.1 and w['end'] <= seg_end + 0.1
            ]
            aligned.append({
                'start':   round(seg_start, 3),
                'end':     round(seg_end, 3),
                'text':    t_seg.get('text', ''),
                'speaker': t_seg.get('speaker', ''),
                'words':   seg_words,
            })

        log.info(f'[align] Tamamlandı: {len(all_words)} kelime, {len(aligned)} segment')
        return jsonify({
            'success':    True,
            'segments':   aligned,
            'total_words': len(all_words),
            'language':   info.language if hasattr(info, 'language') else 'unknown',
        })

    except Exception as e:
        log.error(f'[align] Hata: {e}')
        return jsonify({'success': False, 'error': str(e)}), 500
    finally:
        try: os.unlink(tmp_in)
        except Exception: pass


@app.route('/api/align/word-edit', methods=['POST'])
def align_word_edit():
    """
    Belirtilen kelimeleri ses dosyasından sil veya sessizleştir.
    edits: [{start, end, action: 'delete'|'silence'}]
    """
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Dosya bulunamadı'}), 400

    f = request.files['file']
    edits_json = request.form.get('edits', '[]')
    try:
        edits = json.loads(edits_json)
    except Exception:
        edits = []

    if not edits:
        return jsonify({'success': False, 'error': 'Düzenleme listesi boş'}), 400

    suffix  = os.path.splitext(f.filename or 'audio')[1] or '.mp3'
    tmp_in  = os.path.join(tempfile.gettempdir(), f'wedit_in_{int(time.time()*1000)}{suffix}')
    tmp_out = os.path.join(tempfile.gettempdir(), f'wedit_out_{int(time.time()*1000)}.mp3')
    f.save(tmp_in)

    try:
        del_edits = [e for e in edits if e.get('action') == 'delete']
        sil_edits = [e for e in edits if e.get('action') == 'silence']
        filters   = []

        # Sessizleştirme: volume=0 uygula
        if sil_edits:
            expr = '1'
            for e in reversed(sil_edits):
                s, end = float(e['start']), float(e['end'])
                expr = f"if(between(t,{s},{end}),0,{expr})"
            filters.append(f"volume='{expr}'")

        # Silme: aselect ile zaman aralığını kes
        if del_edits:
            not_parts = '+'.join(
                f"between(t,{float(e['start'])},{float(e['end'])})" for e in del_edits
            )
            filters.append(f"aselect='not({not_parts})',asetpts=N/SR/TB")

        if filters:
            cmd = ['ffmpeg', '-y', '-i', tmp_in, '-af', ','.join(filters), '-q:a', '2', tmp_out]
        else:
            cmd = ['ffmpeg', '-y', '-i', tmp_in, '-q:a', '2', tmp_out]

        log.info(f'[word-edit] {len(del_edits)} silme, {len(sil_edits)} sessizleştirme')
        result = subprocess.run(cmd, capture_output=True, timeout=300)
        if result.returncode != 0:
            err = result.stderr.decode('utf-8', errors='replace')
            raise RuntimeError('FFmpeg hatası: ' + err[-300:])

        base = os.path.splitext(f.filename or 'ses')[0]
        resp = send_file(tmp_out, mimetype='audio/mpeg', as_attachment=True,
                         download_name=base + '_edited.mp3')

        @after_this_request
        def _cleanup(response):
            for p in [tmp_in, tmp_out]:
                try: os.unlink(p)
                except Exception: pass
            return response
        return resp

    except Exception as e:
        for p in [tmp_in, tmp_out]:
            try: os.unlink(p)
            except Exception: pass
        log.error(f'[word-edit] Hata: {e}')
        return jsonify({'success': False, 'error': str(e)}), 500


# ── Server Log Endpoint ────────────────────────────────────────────────────────
@app.route('/api/server-log', methods=['GET'])
def server_log():
    n    = int(request.args.get('n', 100))
    lvl  = request.args.get('level', '').upper()  # INFO / WARNING / ERROR
    rows = list(_log_buffer)[-n:]
    if lvl:
        rows = [r for r in rows if r['level'] == lvl or (lvl == 'ERROR' and r['level'] in ('ERROR','CRITICAL'))]
    return jsonify({'success': True, 'logs': rows, 'total': len(_log_buffer)})

# ── Video Kesim (FFmpeg) ───────────────────────────────────────────────────────

_video_cut_jobs = {}


def _ffmpeg_run_with_progress(cmd, job, phase_label, base_pct, max_pct):
    """ffmpeg'i Popen ile çalıştır, stderr'i parse edip job['pct']/['step']'i canlı güncelle.

    capture_output=True yerine line-by-line stderr okuruz; hem ilerleme görünür hem de
    son 200 satır hata olursa elimizde olur.

    base_pct/max_pct: bu ffmpeg çağrısı job genelinin %X'inden %Y'sine denk gelir.

    Döner: (returncode, full_stderr_text)
    """
    import re as _re
    time_re  = _re.compile(r'time=(\d+):(\d{2}):(\d{2})\.(\d+)')
    speed_re = _re.compile(r'speed=\s*([\d.]+)x')
    fps_re   = _re.compile(r'fps=\s*([\d.]+)')
    dur_re   = _re.compile(r'Duration:\s*(\d+):(\d{2}):(\d{2})')

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        encoding='utf-8',
        errors='replace',
    )
    stderr_lines = []
    total_dur_sec = 0.0
    last_update = 0.0
    job['step'] = f'{phase_label}: başlatılıyor...'
    job['pct'] = base_pct

    try:
        for line in proc.stderr:
            stderr_lines.append(line)
            if len(stderr_lines) > 200:
                del stderr_lines[:len(stderr_lines) - 200]

            # Input duration'ı yakala (ilk birkaç satırda gelir)
            if total_dur_sec == 0:
                dm = dur_re.search(line)
                if dm:
                    h, m, s = dm.groups()
                    total_dur_sec = int(h) * 3600 + int(m) * 60 + int(s)

            # Progress satırlarını saniyede en fazla 1 kez işle (CPU israfı önle)
            now = time.time()
            if now - last_update < 0.8:
                continue

            tm = time_re.search(line)
            if not tm:
                continue
            last_update = now
            h, m, s, _frac = tm.groups()
            elapsed = int(h) * 3600 + int(m) * 60 + int(s)

            sp_m = speed_re.search(line)
            fp_m = fps_re.search(line)
            speed_str = f' @ {sp_m.group(1)}x' if sp_m else ''
            fps_str = f' fps={fp_m.group(1)}' if fp_m else ''
            time_str = f'{int(h)}:{int(m):02d}:{int(s):02d}'

            if total_dur_sec > 0:
                pct_local = min(1.0, elapsed / total_dur_sec)
                job['pct'] = int(base_pct + pct_local * (max_pct - base_pct))
                tot_h = int(total_dur_sec // 3600)
                tot_m = int((total_dur_sec % 3600) // 60)
                tot_s = int(total_dur_sec % 60)
                total_str = f'{tot_h}:{tot_m:02d}:{tot_s:02d}'
                job['step'] = f'{phase_label}: {time_str} / {total_str}{speed_str}{fps_str}'
            else:
                job['step'] = f'{phase_label}: {time_str}{speed_str}{fps_str}'
    finally:
        proc.wait()

    return proc.returncode, ''.join(stderr_lines)


def _run_video_cut(job_id, video_path, keep_regions, output_path, clean_audio_path=None):
    """FFmpeg ile video kesim — temiz ses + keep bölgelerini birleştir."""
    job = _video_cut_jobs[job_id]
    try:
        tmp_dir = os.path.join(tempfile.gettempdir(), f'vcut_{job_id}')
        os.makedirs(tmp_dir, exist_ok=True)

        # ── Encoder seçimi ──────────────────────────────────────────────────
        # NVIDIA NVENC donanım encoder'ı varsa kullan (5-10× daha hızlı).
        # USE_NVENC=0 environment variable ile zorla libx264'e dönülebilir.
        # Başarısız olursa otomatik libx264 fallback yapıyoruz (alttaki try/except).
        _use_nvenc = os.environ.get('USE_NVENC', '1').strip() != '0'
        # NVENC'in -cq (constant quality) parametresi libx264'ün -crf'ine yakın
        # mantıkta çalışır. p4 = 'medium' preset, hq tune = kalite önceliği.
        def _vid_enc_args(use_nvenc):
            if use_nvenc:
                return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq',
                        '-rc', 'vbr', '-cq', '23', '-b:v', '0']
            return ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23']

        # ── Tek-pass dual-input segment kesim ──────────────────────────────
        # Eski yaklaşım iki ayrı re-encode pass kullanıyordu:
        #   1) video + temiz_ses → merged.mp4 (re-encode)
        #   2) merged.mp4 → segments (re-encode tekrar)
        # İki pass arasında audio sample boundary ile video frame boundary
        # arasındaki küçük kaymalar BİRİKİYORDU → final videoda audio leads video.
        #
        # Yeni: her segment için video ve ses ayrı input olarak verilir; ffmpeg
        # ikisini AYNI -ss ile seek eder → frame-perfect senkron, tek re-encode,
        # merge adımı yok (~5-10 dk daha hızlı, ~370 MB daha az disk).
        total = len(keep_regions)
        log.info(f'[video-cut] Tek-pass dual-input segment kesim: {total} bölüm')
        job['pct'] = 5; job['step'] = f'Segment kesim hazırlığı ({total} bölüm)...'

        seg_dir = os.path.join(tmp_dir, 'segments')
        os.makedirs(seg_dir, exist_ok=True)
        seg_files = []

        # Temiz ses var mı? Yoksa video'nun kendi sesini kullan.
        has_clean_audio = clean_audio_path and os.path.exists(clean_audio_path)
        if has_clean_audio:
            log.info(f'[video-cut] Temiz ses kullanılacak: {clean_audio_path}')
        else:
            log.info('[video-cut] Temiz ses yok, video orijinal sesi kullanılacak')

        def _build_seg_cmd(start_s, end_s, out_path, use_nvenc):
            # Kritik: -ss INPUT ÖNCESİ frame-accurate olabilmesi için modern ffmpeg
            # gerekir. Hem keyframe seek hızı hem de frame-accurate için bu en iyi yol.
            # Aynı -ss değerini hem video hem audio input'una vererek senkronu garanti ediyoruz.
            duration = max(0.001, float(end_s) - float(start_s))
            ss = f'{float(start_s):.3f}'
            dur = f'{duration:.3f}'
            cmd = [
                'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
                # Video input — input öncesi seek (keyframe-aware fast seek)
                '-ss', ss,
                '-i', video_path,
            ]
            if has_clean_audio:
                cmd += [
                    # Ses input — AYNI -ss ile (sync garanti)
                    '-ss', ss,
                    '-i', clean_audio_path,
                    '-t', dur,
                    *_vid_enc_args(use_nvenc),
                    '-c:a', 'aac', '-b:a', '192k',
                    '-map', '0:v:0',  # video → orijinal videodan
                    '-map', '1:a:0',  # audio → temiz sesten
                    '-shortest',
                    '-avoid_negative_ts', 'make_zero',
                    out_path,
                ]
            else:
                cmd += [
                    '-t', dur,
                    *_vid_enc_args(use_nvenc),
                    '-c:a', 'aac', '-b:a', '192k',
                    '-avoid_negative_ts', 'make_zero',
                    out_path,
                ]
            return cmd

        # Toplam keep süresi (progress yüzdesi için)
        total_keep_dur = sum(max(0.0, float(r['end']) - float(r['start'])) for r in keep_regions)
        cur_keep_dur = 0.0
        seg_start_time = time.time()
        first_seg_failure_logged = False
        cur_use_nvenc = _use_nvenc
        log.info(f'[video-cut] Segment encoder: {"NVENC" if cur_use_nvenc else "libx264 (CPU)"}, toplam keep süresi: {total_keep_dur:.0f}s')

        for i, region in enumerate(keep_regions):
            seg_path = os.path.join(seg_dir, f'seg_{i:05d}.mp4')
            seg_dur = max(0.001, float(region['end']) - float(region['start']))

            cmd_seg = _build_seg_cmd(region['start'], region['end'], seg_path, cur_use_nvenc)
            res = subprocess.run(cmd_seg, capture_output=True, timeout=120)
            if res.returncode != 0:
                err_text = res.stderr.decode('utf-8', errors='replace')[-300:]
                # NVENC başarısızsa bir kerelik libx264'e düş ve devam et
                if cur_use_nvenc and not first_seg_failure_logged:
                    log.warning(f'[video-cut] Segment {i+1}/{total} NVENC başarısız, libx264\'e geçiliyor: {err_text}')
                    cur_use_nvenc = False
                    first_seg_failure_logged = True
                    cmd_seg = _build_seg_cmd(region['start'], region['end'], seg_path, False)
                    res = subprocess.run(cmd_seg, capture_output=True, timeout=300)
                if res.returncode != 0:
                    raise RuntimeError(
                        f'Segment {i+1}/{total} kesim hatası ({region["start"]:.3f}-{region["end"]:.3f}): '
                        + res.stderr.decode('utf-8', errors='replace')[-300:]
                    )
            seg_files.append(seg_path)

            # Progress güncelle (her segment sonrası)
            cur_keep_dur += seg_dur
            pct_local = cur_keep_dur / total_keep_dur if total_keep_dur > 0 else 0
            # Cut adımı: %5-95 aralığı (concat için %5 ayrılı, merge yok)
            job['pct'] = int(5 + pct_local * 90)
            elapsed = time.time() - seg_start_time
            if i > 0 and elapsed > 0:
                rate = (i + 1) / elapsed  # segment/sn
                eta = (total - i - 1) / rate if rate > 0 else 0
                eta_min = int(eta // 60)
                eta_sec = int(eta % 60)
                eta_str = f'{eta_min}dk {eta_sec:02d}sn' if eta_min > 0 else f'{eta_sec}sn'
                enc_label = 'NVENC' if cur_use_nvenc else 'libx264'
                job['step'] = f'Segment {i+1}/{total} ({enc_label}) — kalan ~{eta_str}'
            else:
                job['step'] = f'Segment {i+1}/{total} işleniyor...'

        log.info(f'[video-cut] {total} segment yazıldı, concat demuxer ile birleştiriliyor')
        job['pct'] = 95; job['step'] = f'{total} segment birleştiriliyor (stream copy)...'

        # Concat demuxer için list dosyası
        concat_list = os.path.join(tmp_dir, 'concat_list.txt')
        with open(concat_list, 'w', encoding='utf-8') as cf:
            for sp in seg_files:
                # Path içinde tek tırnak olabilir, escape gerek
                escaped = sp.replace("'", r"'\''")
                cf.write(f"file '{escaped}'\n")

        # Stream copy birleştirme — re-encode YOK, milisaniyeler içinde biter
        cmd_concat = [
            'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'concat', '-safe', '0',
            '-i', concat_list,
            '-c', 'copy',
            '-movflags', '+faststart',
            output_path
        ]
        res_concat = subprocess.run(cmd_concat, capture_output=True, timeout=600)
        if res_concat.returncode != 0:
            raise RuntimeError('Concat demuxer hatası: ' + res_concat.stderr.decode('utf-8', errors='replace')[-400:])

        # Genel temizlik
        try: os.unlink(concat_list)
        except Exception: pass
        for sp in seg_files:
            try: os.unlink(sp)
            except Exception: pass
        try: os.rmdir(seg_dir)
        except Exception: pass
        try: os.rmdir(tmp_dir)
        except Exception: pass

        job['pct'] = 100; job['step'] = 'Tamamlandı'
        job['status'] = 'done'
        file_size = os.path.getsize(output_path) if os.path.exists(output_path) else 0
        log.info(f'[video-cut] Tamamlandı: {total} bölüm, {file_size/1024/1024:.1f} MB')
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        job['status'] = 'error'; job['error'] = str(e)
        log.error(f'[video-cut] Hata: {e}\n{tb}')


@app.route('/api/video-cut', methods=['POST'])
def video_cut():
    """Video kesim — temiz ses + keep bölgelerini FFmpeg ile birleştir."""
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'Video dosyası bulunamadı'}), 400
    f = request.files['file']
    keep_json = request.form.get('keep_regions', '[]')
    try:
        keep_regions = json.loads(keep_json)
    except:
        return jsonify({'success': False, 'error': 'Geçersiz keep_regions JSON'}), 400
    if not keep_regions:
        return jsonify({'success': False, 'error': 'Korunacak bölge yok'}), 400

    suffix = os.path.splitext(f.filename or 'video.mp4')[1] or '.mp4'
    tmp_in = os.path.join(tempfile.gettempdir(), f'vcut_in_{int(time.time())}{suffix}')
    tmp_out = os.path.join(tempfile.gettempdir(), f'vcut_out_{int(time.time())}.mp4')
    f.save(tmp_in)

    # Temiz ses dosyası (opsiyonel)
    clean_audio_path = None
    if 'clean_audio' in request.files:
        af = request.files['clean_audio']
        a_suffix = os.path.splitext(af.filename or 'audio.mp3')[1] or '.mp3'
        clean_audio_path = os.path.join(tempfile.gettempdir(), f'vcut_audio_{int(time.time())}{a_suffix}')
        af.save(clean_audio_path)
        log.info(f'[video-cut] Temiz ses alındı: {af.filename} ({os.path.getsize(clean_audio_path)/1024/1024:.1f} MB)')

    job_id = f'vcut_{int(time.time()*1000)}'
    _video_cut_jobs[job_id] = {
        'status': 'running', 'pct': 0, 'step': 'Başlatılıyor...', 'error': None,
        'input_path': tmp_in, 'output_path': tmp_out, 'audio_path': clean_audio_path
    }
    threading.Thread(target=_run_video_cut, args=(job_id, tmp_in, keep_regions, tmp_out, clean_audio_path), daemon=True).start()
    return jsonify({'success': True, 'job_id': job_id})


@app.route('/api/video-cut/progress/<job_id>', methods=['GET'])
def video_cut_progress(job_id):
    job = _video_cut_jobs.get(job_id)
    if not job:
        return jsonify({'success': False, 'error': 'İş bulunamadı'}), 404
    return jsonify({'success': True, 'status': job['status'], 'pct': job.get('pct', 0),
                    'step': job.get('step', ''), 'error': job.get('error')})


@app.route('/api/video-cut/download/<job_id>', methods=['GET'])
def video_cut_download(job_id):
    job = _video_cut_jobs.get(job_id)
    if not job or job['status'] != 'done':
        return jsonify({'success': False, 'error': 'Sonuç hazır değil'}), 404
    output_path = job.get('output_path', '')
    if not os.path.exists(output_path):
        return jsonify({'success': False, 'error': 'Dosya bulunamadı'}), 404
    file_size = os.path.getsize(output_path)
    log.info(f'[video-cut] İndirme başlıyor: {file_size/1024/1024:.1f} MB')
    resp = send_file(output_path, mimetype='video/mp4',
                     as_attachment=True, download_name='kesilmis_video.mp4')
    @after_this_request
    def _cleanup(response):
        # İndirme sonrası temizlik — 10 dakika bekle (tekrar indirme için)
        import threading
        def _delayed_cleanup():
            import time; time.sleep(600)
            for p in [job.get('input_path', ''), output_path, job.get('audio_path', '')]:
                if p:
                    try: os.unlink(p)
                    except: pass
            _video_cut_jobs.pop(job_id, None)
        threading.Thread(target=_delayed_cleanup, daemon=True).start()
        return response
    return resp


# ── Video Merge Only (kesim YOK, sadece ses+video birleştir) ─────────────────
# Frontend'deki "Adım N — Video İzle/İndir" butonları için. Belirli bir adımdaki
# temizlenmiş sesi orijinal videoyla NVENC ile birleştirip döner.

_video_merge_jobs = {}

def _run_video_merge_only(job_id, video_path, audio_path, output_path):
    """Sadece ses+video merge — keep_regions yok, kesim yok."""
    job = _video_merge_jobs[job_id]
    try:
        _use_nvenc = os.environ.get('USE_NVENC', '1').strip() != '0'
        def _enc_args(use_nvenc):
            if use_nvenc:
                return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq',
                        '-rc', 'vbr', '-cq', '23', '-b:v', '0']
            return ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23']

        def _build_cmd(use_nvenc):
            return [
                'ffmpeg', '-y',
                '-i', video_path,
                '-i', audio_path,
                *_enc_args(use_nvenc),
                '-c:a', 'aac', '-b:a', '192k',
                '-map', '0:v:0', '-map', '1:a:0',
                '-shortest',
                '-async', '1',
                output_path
            ]
        log.info(f'[video-merge] Başlıyor: {"NVENC" if _use_nvenc else "libx264"}')
        cmd = _build_cmd(_use_nvenc)
        phase = 'Merge (NVENC)' if _use_nvenc else 'Merge (libx264)'
        rc, stderr = _ffmpeg_run_with_progress(cmd, job, phase, 5, 99)
        if rc != 0 and _use_nvenc:
            log.warning(f'[video-merge] NVENC başarısız, libx264\'e geçiliyor')
            cmd = _build_cmd(False)
            rc, stderr = _ffmpeg_run_with_progress(cmd, job, 'Merge (libx264 fallback)', 5, 99)
        if rc != 0:
            raise RuntimeError('FFmpeg merge hatası: ' + stderr[-400:])
        job['pct'] = 100; job['step'] = 'Tamamlandı'
        job['status'] = 'done'
        log.info(f'[video-merge] Tamamlandı: {os.path.getsize(output_path)/1024/1024:.1f} MB')
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        job['status'] = 'error'; job['error'] = str(e)
        log.error(f'[video-merge] Hata: {e}\n{tb}')


@app.route('/api/video-merge-only', methods=['POST'])
def video_merge_only():
    """Sadece merge — frontend adım butonları için."""
    if 'file' not in request.files or 'clean_audio' not in request.files:
        return jsonify({'success': False, 'error': 'Video ve clean_audio gerekli'}), 400
    f = request.files['file']
    af = request.files['clean_audio']

    suffix = os.path.splitext(f.filename or 'video.mp4')[1] or '.mp4'
    a_suffix = os.path.splitext(af.filename or 'audio.mp3')[1] or '.mp3'
    tmp_in = os.path.join(tempfile.gettempdir(), f'vmrg_in_{int(time.time()*1000)}{suffix}')
    tmp_audio = os.path.join(tempfile.gettempdir(), f'vmrg_audio_{int(time.time()*1000)}{a_suffix}')
    tmp_out = os.path.join(tempfile.gettempdir(), f'vmrg_out_{int(time.time()*1000)}.mp4')
    f.save(tmp_in)
    af.save(tmp_audio)
    log.info(f'[video-merge] Video alındı: {os.path.getsize(tmp_in)/1024/1024:.1f} MB, ses: {os.path.getsize(tmp_audio)/1024/1024:.1f} MB')

    job_id = f'vmrg_{int(time.time()*1000)}'
    _video_merge_jobs[job_id] = {
        'status': 'running', 'pct': 0, 'step': 'Başlatılıyor...', 'error': None,
        'input_path': tmp_in, 'output_path': tmp_out, 'audio_path': tmp_audio
    }
    threading.Thread(target=_run_video_merge_only, args=(job_id, tmp_in, tmp_audio, tmp_out), daemon=True).start()
    return jsonify({'success': True, 'job_id': job_id})


@app.route('/api/video-merge-only/progress/<job_id>', methods=['GET'])
def video_merge_only_progress(job_id):
    job = _video_merge_jobs.get(job_id)
    if not job:
        return jsonify({'success': False, 'error': 'İş bulunamadı'}), 404
    return jsonify({'success': True, 'status': job['status'], 'pct': job.get('pct', 0),
                    'step': job.get('step', ''), 'error': job.get('error')})


@app.route('/api/video-merge-only/download/<job_id>', methods=['GET'])
def video_merge_only_download(job_id):
    job = _video_merge_jobs.get(job_id)
    if not job or job['status'] != 'done':
        return jsonify({'success': False, 'error': 'Sonuç hazır değil'}), 404
    output_path = job.get('output_path', '')
    if not os.path.exists(output_path):
        return jsonify({'success': False, 'error': 'Dosya bulunamadı'}), 404
    log.info(f'[video-merge] İndirme: {os.path.getsize(output_path)/1024/1024:.1f} MB')
    resp = send_file(output_path, mimetype='video/mp4',
                     as_attachment=True, download_name='adim_merge.mp4')
    @after_this_request
    def _cleanup(response):
        def _delayed_cleanup():
            import time; time.sleep(600)
            for p in [job.get('input_path', ''), output_path, job.get('audio_path', '')]:
                if p:
                    try: os.unlink(p)
                    except: pass
            _video_merge_jobs.pop(job_id, None)
        threading.Thread(target=_delayed_cleanup, daemon=True).start()
        return response
    return resp


# ── Uzaktan Guncelleme API ─────────────────────────────────────────────────────

_update_jobs = {}

@app.route('/api/update/check', methods=['GET'])
def update_check():
    """Guncelleme kontrol — _update_pending.json varsa veya canli kontrol."""
    pending_file = os.path.join(os.path.dirname(__file__), '_update_pending.json')
    if os.path.exists(pending_file):
        try:
            with open(pending_file, 'r', encoding='utf-8') as f:
                return jsonify({'success': True, 'update': json.load(f)})
        except:
            pass
    # Canli kontrol
    try:
        from updater import Updater
        u = Updater(os.path.dirname(__file__))
        info = u.check_for_updates()
        if info:
            # manifest objesini cikar (cok buyuk)
            result = {k: v for k, v in info.items() if k != 'manifest'}
            return jsonify({'success': True, 'update': result})
        return jsonify({'success': True, 'update': None, 'message': 'Guncel versiyon'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/update/apply', methods=['POST'])
def update_apply():
    """Guncellemeyi indir ve uygula (async job)."""
    try:
        from updater import Updater
        u = Updater(os.path.dirname(__file__))
        info = u.check_for_updates()
        if not info:
            return jsonify({'success': False, 'error': 'Guncelleme bulunamadi'})

        job_id = f'upd_{int(time.time()*1000)}'
        _update_jobs[job_id] = {'status': 'running', 'pct': 0, 'step': 'Baslatiliyor...', 'error': None}

        def _run_update():
            job = _update_jobs[job_id]
            try:
                manifest = info['manifest']
                diff = info['diff']
                job['pct'] = 10; job['step'] = f'Yedek olusturuluyor ({len(diff)} dosya)...'
                backup_id = u.backup(diff)

                def progress_cb(done, total, filepath):
                    job['pct'] = 20 + int((done / total) * 60)
                    job['step'] = f'Indiriliyor: {filepath} ({done}/{total})'

                job['pct'] = 20; job['step'] = 'Dosyalar indiriliyor...'
                u.download_files(diff, manifest, progress_cb)

                job['pct'] = 85; job['step'] = 'Guncelleme uygulanıyor...'
                u.apply_update(manifest, backup_id)

                job['pct'] = 100; job['step'] = 'Tamamlandi — yeniden baslatma gerekli'
                job['status'] = 'done'
                job['new_version'] = manifest.get('version', '')
                job['backup_id'] = backup_id

                # Pending dosyasini temizle
                pending_file = os.path.join(os.path.dirname(__file__), '_update_pending.json')
                if os.path.exists(pending_file):
                    try: os.unlink(pending_file)
                    except: pass

                log.info(f'[updater] Guncelleme tamamlandi: v{manifest.get("version")}')
            except Exception as e:
                job['status'] = 'error'; job['error'] = str(e)
                log.error(f'[updater] Guncelleme hatasi: {e}')

        threading.Thread(target=_run_update, daemon=True).start()
        return jsonify({'success': True, 'job_id': job_id})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/update/status/<job_id>', methods=['GET'])
def update_status(job_id):
    """Guncelleme durumu."""
    job = _update_jobs.get(job_id)
    if not job:
        return jsonify({'success': False, 'error': 'Is bulunamadi'}), 404
    return jsonify({'success': True, 'status': job['status'], 'pct': job.get('pct', 0),
                    'step': job.get('step', ''), 'error': job.get('error'),
                    'new_version': job.get('new_version', '')})

@app.route('/api/update/rollback', methods=['POST'])
def update_rollback():
    """Son yedekten geri yukle."""
    try:
        from updater import Updater
        u = Updater(os.path.dirname(__file__))
        backup_id = request.json.get('backup_id') if request.is_json else None
        u.rollback(backup_id)
        return jsonify({'success': True, 'message': 'Geri yukleme tamamlandi — yeniden baslatma gerekli'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/update/version', methods=['GET'])
def update_version():
    """Mevcut versiyon bilgisi."""
    try:
        from updater import Updater
        u = Updater(os.path.dirname(__file__))
        v = u.get_local_version()
        return jsonify({'success': True, 'version': v.get('version', '0.0.0'),
                       'installed_date': v.get('installed_date', ''),
                       'files_count': len(v.get('files', {}))})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/update/backups', methods=['GET'])
def update_backups():
    """Mevcut yedekleri listele."""
    try:
        from updater import Updater
        u = Updater(os.path.dirname(__file__))
        return jsonify({'success': True, 'backups': u.list_backups()})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/update/restart', methods=['POST'])
def update_restart():
    """Sunucuyu yeniden baslat (guncelleme sonrasi)."""
    log.info('[updater] Yeniden baslatma istendi')
    # Exit code 42 = launcher restart signal
    def _delayed_exit():
        time.sleep(1)
        os._exit(42)
    threading.Thread(target=_delayed_exit, daemon=True).start()
    return jsonify({'success': True, 'message': 'Sunucu yeniden baslatiliyor...'})


# ── Start ──────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 3000))
    log.info(f"\n  VoiceCraft AI  →  http://localhost:{port}\n")
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
