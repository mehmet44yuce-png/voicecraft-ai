/* ============================================================
   canvas-overlay.js  v2
   draw() içine entegre edilecek overlay katmanları:
   - Claude AI segment overlay (renk kodlu)
   - Konuşmacı diarizasyon overlay (etiketli, renkli serit)
   - VAD overlay
   ============================================================ */

/* ── Konuşmacı renk paleti ── */
const OVERLAY_SPEAKER_PALETTE = [
  { fill: 'rgba(79,195,247,0.15)',  stripe: 'rgba(79,195,247,0.80)',  label: '#4fc3f7' },
  { fill: 'rgba(174,213,129,0.15)', stripe: 'rgba(174,213,129,0.80)', label: '#aed581' },
  { fill: 'rgba(255,183,77,0.15)',  stripe: 'rgba(255,183,77,0.80)',  label: '#ffb74d' },
  { fill: 'rgba(206,147,216,0.15)', stripe: 'rgba(206,147,216,0.80)', label: '#ce93d8' },
  { fill: 'rgba(255,138,128,0.15)', stripe: 'rgba(255,138,128,0.80)', label: '#ff8a80' },
  { fill: 'rgba(128,222,234,0.15)', stripe: 'rgba(128,222,234,0.80)', label: '#80deea' },
  { fill: 'rgba(165,214,167,0.15)', stripe: 'rgba(165,214,167,0.80)', label: '#a5d6a7' },
  { fill: 'rgba(255,204,128,0.15)', stripe: 'rgba(255,204,128,0.80)', label: '#ffcc80' },
  { fill: 'rgba(159,168,218,0.15)', stripe: 'rgba(159,168,218,0.80)', label: '#9fa8da' },
  { fill: 'rgba(240,98,146,0.15)',  stripe: 'rgba(240,98,146,0.80)',  label: '#f06292' },
];

const SEEK_STRIP_H = 20; /* isTop kanalında üst seek şeridinin yüksekliği */

const CanvasOverlay = {

  _segments: [],  /* [ { start_sec, end_sec, type, action, reason } ] */
  _speakers: [],  /* [ { start, end, speaker } ]  örnek: "SPEAKER_00" */
  _vad:      [],  /* [ { start, end } ] */

  visible: {
    segments: true,
    speakers: true,
    vad:      false,
  },

  /* ----------------------------------------------------------
     syncFromGlobals() — drawCh() her çağrıldığında kapanım
     içindeki güncel verileri overlay'e kopyalar.
     ngVadSegs ve ngDiarizeSegs closure-scope'unda tanımlı.
     ---------------------------------------------------------- */
  syncFromGlobals() {
    try {
      /* eslint-disable no-undef */
      if (typeof ngVadSegs     !== 'undefined') this._vad      = ngVadSegs     || [];
      if (typeof ngDiarizeSegs !== 'undefined') this._speakers = ngDiarizeSegs || [];
      /* eslint-enable no-undef */
    } catch(e) { /* güvenli: tanımsız değişken varsa sessizce geç */ }
  },

  setSegments(segs) { this._segments = segs || []; },
  setSpeakers(segs) { this._speakers = segs || []; },
  setVad(segs)      { this._vad      = segs || []; },

  /* ----------------------------------------------------------
     RENK PALETLERİ
     ---------------------------------------------------------- */
  segmentColor(type, action) {
    const map = {
      speech:    { keep:'rgba(74,222,128,0.18)',  remove:'rgba(248,113,113,0.22)', filter:'rgba(251,191,36,0.18)'  },
      silence:   { keep:'rgba(99,102,241,0.12)',  remove:'rgba(248,113,113,0.28)', filter:'rgba(248,113,113,0.20)' },
      noise:     { keep:'rgba(251,191,36,0.15)',  remove:'rgba(248,113,113,0.30)', filter:'rgba(251,146,60,0.22)'  },
      music:     { keep:'rgba(168,85,247,0.18)',  remove:'rgba(248,113,113,0.22)', filter:'rgba(168,85,247,0.14)'  },
      breathing: { keep:'rgba(20,184,166,0.15)',  remove:'rgba(248,113,113,0.22)', filter:'rgba(20,184,166,0.12)'  },
      click:     { keep:'rgba(239,68,68,0.20)',   remove:'rgba(239,68,68,0.35)',   filter:'rgba(239,68,68,0.18)'   },
    };
    return (map[type] || map.speech)[action] || 'rgba(255,255,255,0.08)';
  },

  actionStripeColor(action) {
    return action === 'keep'   ? 'rgba(74,222,128,0.7)'
         : action === 'remove' ? 'rgba(248,113,113,0.7)'
         :                       'rgba(251,191,36,0.7)';
  },

  /* speakerId: sayı (speakerIdx) veya "SPEAKER_00" string */
  _speakerColorEntry(speakerId) {
    let idx;
    if (typeof speakerId === 'number') {
      idx = speakerId;
    } else {
      /* "SPEAKER_00" → 0, "SPEAKER_01" → 1, "Alice" → hash */
      const m = String(speakerId || '').match(/(\d+)$/);
      idx = m ? parseInt(m[1]) : (String(speakerId).split('').reduce((a, c) => a + c.charCodeAt(0), 0));
    }
    return OVERLAY_SPEAKER_PALETTE[idx % OVERLAY_SPEAKER_PALETTE.length];
  },

  /* ----------------------------------------------------------
     ANA ÇİZİM — drawCh() içinde barlardan sonra, playhead'den önce:
       CanvasOverlay.syncFromGlobals();
       CanvasOverlay.draw(c, W, H, ngVS, ngVE, isTop);
     ---------------------------------------------------------- */
  draw(c, W, H, vStart, vEnd, isTop) {
    const viewDur = vEnd - vStart;
    if (viewDur <= 0) return;

    const tToX    = t => ((t - vStart) / viewDur) * W;
    const inView  = (s, e) => e > vStart && s < vEnd;
    const clipX   = (s, e) => ({
      x1: Math.max(0, tToX(s)),
      x2: Math.min(W, tToX(e)),
    });

    /* isTop kanalda seek şeridini korumak için üst kenar */
    const yTop = isTop ? SEEK_STRIP_H : 0;
    const hEff = H - yTop;               /* kullanılabilir yükseklik */

    /* 1. VAD overlay — ince üst şerit, sadece isTop */
    if (this.visible.vad && isTop && this._vad.length) {
      c.save();
      this._vad.forEach(seg => {
        if (!inView(seg.start, seg.end)) return;
        const { x1, x2 } = clipX(seg.start, seg.end);
        if (x2 - x1 < 0.5) return;
        c.fillStyle = 'rgba(74,222,128,0.10)';
        c.fillRect(x1, yTop, x2 - x1, hEff);
        c.fillStyle = 'rgba(74,222,128,0.5)';
        c.fillRect(x1, yTop, x2 - x1, 2);
      });
      c.restore();
    }

    /* 2. Konuşmacı diarizasyon overlay */
    if (this.visible.speakers && this._speakers.length) {
      c.save();
      this._speakers.forEach(seg => {
        /* speakerIdx (sayı) veya speaker (string) — her ikisini de destekle */
        const spKey = (seg.speaker !== undefined) ? seg.speaker : seg.speakerIdx;
        if (!inView(seg.start, seg.end)) return;
        const { x1, x2 } = clipX(seg.start, seg.end);
        if (x2 - x1 < 0.5) return;

        const pal = this._speakerColorEntry(spKey);

        /* Dolgu */
        c.fillStyle = pal.fill;
        c.fillRect(x1, yTop, x2 - x1, hEff);

        /* Alt şerit — 3px */
        c.fillStyle = pal.stripe;
        c.fillRect(x1, H - 3, x2 - x1, 3);

        /* Etiket (yalnızca isTop ve yeterince geniş) */
        if (isTop && x2 - x1 > 28) {
          const label = String(spKey).replace('SPEAKER_', 'SP');
          c.save();
          c.font = '9px monospace';
          c.fillStyle = pal.label;
          c.globalAlpha = 0.85;
          c.beginPath();
          c.rect(x1 + 2, H - 14, x2 - x1 - 4, 13);
          c.clip();
          c.fillText(label, x1 + 3, H - 3);
          c.restore();
        }
      });
      c.restore();
    }

    /* 3. Claude AI segment overlay — en üste */
    if (this.visible.segments && this._segments.length) {
      c.save();
      this._segments.forEach(seg => {
        if (!inView(seg.start_sec, seg.end_sec)) return;
        const { x1, x2 } = clipX(seg.start_sec, seg.end_sec);
        if (x2 - x1 < 0.5) return;

        /* Dolgu */
        c.fillStyle = this.segmentColor(seg.type, seg.action);
        c.fillRect(x1, yTop, x2 - x1, hEff);

        /* Üst şerit — 3px */
        c.fillStyle = this.actionStripeColor(seg.action);
        c.fillRect(x1, yTop, x2 - x1, 3);

        /* Etiket */
        if (isTop && x2 - x1 > 36) {
          c.save();
          c.font = '10px monospace';
          c.globalAlpha = 0.9;
          c.fillStyle = this.actionStripeColor(seg.action);
          c.beginPath();
          c.rect(x1 + 3, yTop + 5, x2 - x1 - 6, 14);
          c.clip();
          const icon  = seg.action === 'remove' ? 'x' : seg.action === 'filter' ? '~' : 'v';
          c.fillText(icon + ' ' + (seg.type || ''), x1 + 4, yTop + 15);
          c.restore();
        }

        /* Sol kenar çizgisi */
        c.strokeStyle = this.actionStripeColor(seg.action);
        c.globalAlpha = 0.6;
        c.lineWidth   = 1;
        c.setLineDash([]);
        c.beginPath();
        c.moveTo(x1 + 0.5, yTop);
        c.lineTo(x1 + 0.5, H);
        c.stroke();
      });
      c.restore();
    }
  },

  /* ----------------------------------------------------------
     KONTROL PANELİ — DOM tabanlı (innerHTML yerine)
     CanvasOverlay.renderControls('overlay-controls-container')
     ---------------------------------------------------------- */
  renderControls(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;

    el.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 0;';

    const lbl = document.createElement('span');
    lbl.style.cssText = 'font-size:11px;color:var(--text-dim);';
    lbl.textContent = 'Overlay:';
    wrap.appendChild(lbl);

    const layers = [
      { key: 'segments', label: 'AI Segmentler', color: '#a78bfa' },
      { key: 'speakers', label: 'Konuşmacı',     color: '#4fc3f7' },
      { key: 'vad',      label: 'VAD',            color: '#4ade80' },
    ];

    layers.forEach(({ key, label, color }) => {
      const btn = document.createElement('button');
      btn.id = `overlay-btn-${key}`;
      const on = this.visible[key];
      btn.style.cssText = `padding:3px 9px;font-size:11px;cursor:pointer;border-radius:5px;
        border:1px solid ${on ? color : 'var(--border)'};
        color:${on ? color : 'var(--text-dim)'};
        background:var(--bg);white-space:nowrap;`;
      btn.textContent = label;
      btn.addEventListener('click', () => {
        const nowOn = CanvasOverlay.toggle(key);
        btn.style.borderColor = nowOn ? color : 'var(--border)';
        btn.style.color       = nowOn ? color : 'var(--text-dim)';
      });
      wrap.appendChild(btn);
    });

    el.appendChild(wrap);
  },

  renderLegend(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const items = [
      { color: 'rgba(74,222,128,0.7)',  label: 'Tut' },
      { color: 'rgba(248,113,113,0.7)', label: 'Sil' },
      { color: 'rgba(251,191,36,0.7)',  label: 'Filtrele' },
      { color: 'rgba(79,195,247,0.8)',  label: 'Konuşmacı' },
    ];
    el.innerHTML = items.map(i =>
      `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:10px;font-size:11px;color:var(--text-dim)">
        <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${i.color}"></span>${i.label}
      </span>`
    ).join('');
  },

  toggle(layer) {
    this.visible[layer] = !this.visible[layer];
    if (typeof draw === 'function' && typeof threshold !== 'undefined') draw(threshold);
    return this.visible[layer];
  },
};
