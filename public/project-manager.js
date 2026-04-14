/* ============================================================
   project-manager.js
   Ac / Yeni Proje / Eski Projeler islevleri
   localStorage simdilik, ileride API'ye tasinacak
   ============================================================ */

/* ----------------------------------------------------------
   STORAGE KATMANI
   Sunucuya tasirken sadece bu 4 fonksiyonu degistir.
   ---------------------------------------------------------- */
const ProjectStorage = {
  _key: 'ses_projeler',

  list() {
    try { return JSON.parse(localStorage.getItem(this._key) || '[]'); }
    catch { return []; }
  },

  get(id) {
    return this.list().find(p => p.id === id) || null;
  },

  save(project) {
    const all = this.list().filter(p => p.id !== project.id);
    all.unshift({ ...project, updatedAt: Date.now() });
    localStorage.setItem(this._key, JSON.stringify(all));
  },

  delete(id) {
    const all = this.list().filter(p => p.id !== id);
    localStorage.setItem(this._key, JSON.stringify(all));
  },

  setActive(id) { localStorage.setItem('ses_aktif_proje', id || ''); },
  getActive()   { return localStorage.getItem('ses_aktif_proje') || null; },
};

/* ----------------------------------------------------------
   PROJE DURUMU
   ---------------------------------------------------------- */
let _project = {
  id:        null,
  name:      '',
  fileName:  '',
  fileData:  null,
  segments:  [],
  settings:  {},
  createdAt: null,
};

function _genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function _setProjectName(name) {
  _project.name = name;
  const inp = document.getElementById('project-name-input');
  if (inp) inp.value = name;
}

/* ----------------------------------------------------------
   YENI PROJE
   ---------------------------------------------------------- */
function newProject() {
  if (_project.id && _isDirty()) {
    showConfirmModal(
      'Kaydedilmemis degisiklikler var',
      'Yeni proje acarsan mevcut calisma kaybolur.',
      'Devam Et', 'Iptal',
      _doNewProject
    );
  } else {
    _doNewProject();
  }
}

function _doNewProject() {
  /* Noise gate paneli aciksa duzgunce kapat */
  const ngCloseBtn = document.getElementById('ng-close');
  if (ngCloseBtn) ngCloseBtn.click();

  _project = {
    id:        _genId(),
    name:      '',
    fileName:  '',
    fileData:  null,
    segments:  [],
    settings:  {},
    createdAt: Date.now(),
  };
  ProjectStorage.setActive(_project.id);
  _setProjectName('');

  _resetUI();
  if (typeof switchTrackTab === 'function') switchTrackTab('layers');
  showToast('Yeni proje olusturuldu');

  /* app.js state temizligi */
  if (typeof window.onNewProject === 'function') window.onNewProject();
}

function _resetUI() {
  /* Dosya input sifirla */
  const fi = document.getElementById('file-input');
  if (fi) fi.value = '';

  /* Track listesini temizle */
  const tl = document.getElementById('tracks-list');
  if (tl) tl.innerHTML = '';

  /* Empty state goster */
  const es = document.getElementById('empty-state');
  if (es) es.style.display = '';

  /* Transkript — sadece veri containerlarini temizle, HTML yapisini koru */
  const trList = document.getElementById('tr-main-list');
  if (trList) trList.innerHTML = '';
  const trPlaceholder = document.getElementById('tr-main-placeholder');
  if (trPlaceholder) trPlaceholder.style.display = '';
  const trCount = document.getElementById('tr-main-count');
  if (trCount) trCount.textContent = 'Transkript yok';

  /* AI panel — sadece veri containerlarini temizle */
  const analysisCards = document.getElementById('analysis-cards');
  if (analysisCards) { analysisCards.innerHTML = ''; analysisCards.style.display = 'none'; }
  const analysisPlaceholder = document.getElementById('analysis-placeholder');
  if (analysisPlaceholder) analysisPlaceholder.style.display = '';
  const eventsList = document.getElementById('events-list');
  if (eventsList) eventsList.innerHTML = '';
  const noEventsMsg = document.getElementById('no-events-msg');
  if (noEventsMsg) noEventsMsg.style.display = '';
  const transcriptSegs = document.getElementById('transcript-segments');
  if (transcriptSegs) transcriptSegs.innerHTML = '';

  /* ng-host icerigi sifirla */
  const ngHost = document.getElementById('ng-host');
  if (ngHost) ngHost.innerHTML =
    '<div style="text-align:center;color:var(--text-dim);padding:40px;font-size:13px">Ses dosyasi yuklendiginde Esik paneli burada acilacak.</div>';

  _markClean();
}

/* ----------------------------------------------------------
   AC (dosya sec)
   ---------------------------------------------------------- */
function onFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;

  if (!_project.id) _doNewProject();

  _project.fileName = file.name;
  _project.fileSize = file.size;
  if (!_project.name) {
    _setProjectName(file.name.replace(/\.[^/.]+$/, ''));
  }

  _markDirty();

  /* window.onAudioFileReady app.js tarafindan tanimlanir */
  if (typeof window.onAudioFileReady === 'function') {
    window.onAudioFileReady(file);
  }
}

/* ----------------------------------------------------------
   KAYDET
   ---------------------------------------------------------- */
function saveProject() {
  if (!_project.id) return;
  if (!_project.name.trim()) {
    const name = prompt('Proje adi girin:');
    if (!name) return;
    _setProjectName(name.trim());
  }

  const toSave = {
    id:        _project.id,
    name:      _project.name,
    fileName:  _project.fileName,
    fileSize:  _project.fileSize || 0,
    segments:  _project.segments,
    settings:  _project.settings,
    createdAt: _project.createdAt,
    updatedAt: Date.now(),
  };
  ProjectStorage.save(toSave);
  ProjectStorage.setActive(_project.id);
  _markClean();
  showToast(`"${_project.name}" kaydedildi`);
}

/* ----------------------------------------------------------
   ESKI PROJELER MODALI
   ---------------------------------------------------------- */
function openOldProjects() {
  const existing = document.getElementById('old-projects-modal');
  if (existing) { existing.remove(); return; }

  const projects = ProjectStorage.list();
  const modal = document.createElement('div');
  modal.id = 'old-projects-modal';
  modal.style.cssText = `
    position:fixed;inset:0;z-index:99999;
    display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,0.65);backdrop-filter:blur(4px);
  `;

  modal.innerHTML = `
    <div style="
      background:var(--bg-dark);border:1px solid var(--border);
      border-radius:12px;width:520px;max-width:95vw;max-height:80vh;
      display:flex;flex-direction:column;overflow:hidden;
      box-shadow:0 24px 48px rgba(0,0,0,0.5);
    ">
      <div style="
        display:flex;align-items:center;justify-content:space-between;
        padding:16px 20px;border-bottom:1px solid var(--border);
        background:var(--bg-mid);flex-shrink:0;
      ">
        <span style="color:var(--text-bright);font-size:14px;font-weight:600;">Kayitli Projeler</span>
        <button onclick="document.getElementById('old-projects-modal').remove()"
          style="background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;">x</button>
      </div>
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);flex-shrink:0;">
        <input id="proj-search" type="text" placeholder="Proje ara..."
          oninput="filterProjects(this.value)"
          style="
            width:100%;background:var(--bg);border:1px solid var(--border);
            border-radius:7px;color:var(--text);font-size:13px;
            padding:8px 12px;outline:none;box-sizing:border-box;
          ">
      </div>
      <div id="proj-list" style="overflow-y:auto;flex:1;padding:8px;">
        ${projects.length === 0
          ? `<div style="text-align:center;color:var(--text-dim);padding:40px;font-size:13px;">Henuz kayitli proje yok</div>`
          : projects.map(p => _projectRow(p)).join('')
        }
      </div>
    </div>
  `;

  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
  setTimeout(() => document.getElementById('proj-search')?.focus(), 50);
}

function _projectRow(p) {
  const date = new Date(p.updatedAt || p.createdAt).toLocaleDateString('tr-TR', {
    day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit'
  });
  const isActive = p.id === _project.id;
  return `
    <div class="proj-row" data-id="${p.id}" data-name="${(p.name||'').toLowerCase()}"
      style="
        display:flex;align-items:center;gap:10px;
        padding:10px 12px;border-radius:8px;
        border:1px solid ${isActive ? 'var(--accent)' : 'transparent'};
        background:${isActive ? 'rgba(74,158,255,0.08)' : 'transparent'};
        margin-bottom:4px;
      "
    >
      <div style="flex:1;min-width:0;cursor:pointer;" onclick="loadProject('${p.id}')">
        <div style="color:var(--text-bright);font-size:13px;font-weight:500;
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ${isActive ? '> ' : ''}${p.name || '(isimsiz)'}
        </div>
        <div style="color:var(--text-dim);font-size:11px;margin-top:2px;">
          ${p.fileName || '-'} - ${date}
        </div>
      </div>
      <button onclick="event.stopPropagation();deleteProject('${p.id}')"
        style="
          background:none;border:1px solid transparent;color:var(--text-dim);
          cursor:pointer;border-radius:6px;padding:4px 8px;font-size:11px;
          white-space:nowrap;flex-shrink:0;
        "
        onmouseenter="this.style.borderColor='var(--red)';this.style.color='var(--red)'"
        onmouseleave="this.style.borderColor='transparent';this.style.color='var(--text-dim)'"
      >Sil</button>
    </div>
  `;
}

function filterProjects(q) {
  const rows = document.querySelectorAll('#proj-list .proj-row');
  rows.forEach(row => {
    row.style.display = row.dataset.name.includes(q.toLowerCase()) ? 'flex' : 'none';
  });
}

async function loadProject(id) {
  const p = ProjectStorage.get(id);
  if (!p) return;

  document.getElementById('old-projects-modal')?.remove();

  _project = { ...p, fileData: null };
  ProjectStorage.setActive(id);
  _setProjectName(p.name);
  _markClean();

  if (typeof window.onProjectLoaded === 'function') {
    window.onProjectLoaded(p);
  }

  // Session'dan yükle
  if (typeof window.loadSessionByKey === 'function') {
    // fileName|fileSize key ile dene
    if (p.fileName && p.fileSize) {
      const saved = await window.loadSessionByKey(p.fileName + '|' + p.fileSize);
      if (saved && saved.raw) {
        showToast('"' + p.name + '" yukleniyor...');
        if (typeof window.loadFileFromBuffer === 'function') await window.loadFileFromBuffer(saved.raw, saved.name, saved.size);
        return;
      }
    }
    // 'current' key ile dene
    const current = await window.loadSessionByKey('current');
    if (current && current.raw) {
      showToast('"' + p.name + '" yukleniyor...');
      if (typeof window.loadFileFromBuffer === 'function') await window.loadFileFromBuffer(current.raw, current.name, current.size);
      return;
    }
  }

  // Dosya seçtir
  showToast('"' + p.name + '" — ses dosyasini secin');
  const fi = document.getElementById('file-input');
  if (fi) fi.click();
}

function deleteProject(id) {
  const p = ProjectStorage.get(id);
  if (!p) return;
  showConfirmModal(
    `"${p.name || '(isimsiz)'}" silinsin mi?`,
    'Bu islem geri alinamaz.',
    'Sil', 'Iptal',
    () => {
      ProjectStorage.delete(id);
      if (_project.id === id) _doNewProject();
      openOldProjects();
      showToast('Proje silindi');
    }
  );
}

/* ----------------------------------------------------------
   DIRTY FLAG
   ---------------------------------------------------------- */
let _dirty = false;
function _markDirty()  { _dirty = true;  _updateSaveBtn(); }
function _markClean()  { _dirty = false; _updateSaveBtn(); }
function _isDirty()    { return _dirty; }
function _updateSaveBtn() {
  const btn = document.getElementById('btn-save-project');
  if (!btn) return;
  btn.style.borderColor = _dirty ? 'var(--yellow)' : 'var(--border)';
  btn.style.color       = _dirty ? 'var(--yellow)'  : 'var(--text-dim)';
  btn.title = _dirty ? 'Kaydedilmemis degisiklikler var (Ctrl+S)' : 'Kaydet (Ctrl+S)';
}

/* ----------------------------------------------------------
   YARDIMCI: TOAST
   ---------------------------------------------------------- */
function showToast(msg, duration = 2800) {
  const existing = document.getElementById('pm-toast');
  if (existing) existing.remove();

  const t = document.createElement('div');
  t.id = 'pm-toast';
  t.textContent = msg;
  t.style.cssText = `
    position:fixed;bottom:28px;left:50%;transform:translateX(-50%);
    background:var(--bg-mid);border:1px solid var(--border);
    color:var(--text-bright);font-size:13px;padding:9px 18px;
    border-radius:8px;z-index:99999;pointer-events:none;
    box-shadow:0 4px 16px rgba(0,0,0,0.4);
  `;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

/* ----------------------------------------------------------
   YARDIMCI: ONAY MODALI
   ---------------------------------------------------------- */
function showConfirmModal(title, desc, confirmLabel, cancelLabel, onConfirm) {
  const existing = document.getElementById('pm-confirm-modal');
  if (existing) existing.remove();

  const m = document.createElement('div');
  m.id = 'pm-confirm-modal';
  m.style.cssText = `
    position:fixed;inset:0;z-index:999999;
    display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,0.7);
  `;
  m.innerHTML = `
    <div style="
      background:var(--bg-dark);border:1px solid var(--border);
      border-radius:10px;padding:24px;width:360px;max-width:90vw;
      box-shadow:0 16px 40px rgba(0,0,0,0.5);
    ">
      <div style="color:var(--text-bright);font-size:15px;font-weight:600;margin-bottom:8px;">${title}</div>
      <div style="color:var(--text-dim);font-size:13px;margin-bottom:20px;">${desc}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button onclick="document.getElementById('pm-confirm-modal').remove()"
          style="padding:7px 16px;background:var(--bg-mid);border:1px solid var(--border);
            color:var(--text);border-radius:7px;cursor:pointer;font-size:13px;">
          ${cancelLabel}
        </button>
        <button id="pm-confirm-ok"
          style="padding:7px 16px;background:#7f1d1d;border:1px solid var(--red);
            color:var(--red);border-radius:7px;cursor:pointer;font-size:13px;font-weight:600;">
          ${confirmLabel}
        </button>
      </div>
    </div>
  `;
  m.querySelector('#pm-confirm-ok').onclick = () => { m.remove(); onConfirm(); };
  document.body.appendChild(m);
}

/* ----------------------------------------------------------
   BUTON BAGLAMALARI
   ---------------------------------------------------------- */
function initProjectManager() {
  /* file-input onchange — app.js'deki listener da var, o loadFile() cagiriyor.
     Burada sadece proje metadata'sini guncelliyoruz. */
  const fi = document.getElementById('file-input');
  if (fi) fi.addEventListener('change', onFileSelected);

  /* Yeni Proje — app.js'deki onclick kaldirildi */
  const btnNew = document.getElementById('btn-new-project');
  if (btnNew) btnNew.addEventListener('click', newProject);

  /* Eski Projeler — app.js'deki onclick kaldirildi */
  const btnOld = document.getElementById('btn-old-projects');
  if (btnOld) btnOld.addEventListener('click', openOldProjects);

  /* Kaydet */
  const btnSave = document.getElementById('btn-save-project');
  if (btnSave) btnSave.addEventListener('click', saveProject);

  /* Proje adi input */
  const nameInp = document.getElementById('project-name-input');
  if (nameInp) {
    nameInp.addEventListener('input', e => { _project.name = e.target.value; _markDirty(); });
    nameInp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.target.blur(); saveProject(); } });
  }

  /* Ctrl+S */
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveProject(); }
  });

  /* Sayfa kapanmadan once uyard */
  window.addEventListener('beforeunload', e => {
    if (_isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  /* Aktif projeyi restore et */
  const activeId = ProjectStorage.getActive();
  if (activeId) {
    const p = ProjectStorage.get(activeId);
    if (p) {
      _project = { ...p, fileData: null };
      _setProjectName(p.name);
    }
  }

  /* IndexedDB'deki session kayıtlarını tara — kayıtlı olmayan projeleri otomatik ekle */
  (async () => {
    try {
      const DB_NAME = 'voicecraft';
      const db = await new Promise((res, rej) => {
        const req = indexedDB.open(DB_NAME);
        req.onsuccess = e => res(e.target.result);
        req.onerror = e => rej(e.target.error);
      });
      if (!db.objectStoreNames.contains('session')) { db.close(); return; }
      const tx = db.transaction('session', 'readonly');
      const store = tx.objectStore('session');
      const allKeys = await new Promise((res, rej) => {
        const req = store.getAllKeys();
        req.onsuccess = () => res(req.result || []);
        req.onerror = e => rej(e.target.error);
      });
      db.close();

      const existingProjects = ProjectStorage.list();
      const existingFiles = new Set(existingProjects.map(p => p.fileName));
      // Mevcut proje adlarını da kontrol et — türetilmiş dosyalar yeni proje olmasın
      const existingNames = new Set(existingProjects.map(p => (p.name || '').toLowerCase()));

      // İşlenmiş dosya adından orijinal kök adı çıkar
      // "Yeni Kayıt 5.m4a vocals nr enhanced" → "Yeni Kayıt 5"
      const _suffixes = /[\s._-]*(vocals?|no_vocals|temizlendi|temiz|norm|enhanced|sadece.konusma|konusmaci.secim|vf|df|nr|re)(\s|$|\.)/gi;
      function _baseFileName(fn) {
        let base = fn.replace(/\.[^.]+$/, ''); // uzantıyı kaldır
        // Tekrarlı suffix'leri temizle
        let prev = '';
        while (prev !== base) { prev = base; base = base.replace(_suffixes, '').trim(); }
        return base.toLowerCase();
      }
      const existingBases = new Set(existingProjects.map(p => _baseFileName(p.fileName || p.name || '')));

      for (const key of allKeys) {
        if (key === 'current') continue; // 'current' key'i atla
        // key formatı: "dosyaAdı|boyut"
        const parts = String(key).split('|');
        if (parts.length < 2) continue;
        const fileName = parts[0];
        const fileSize = parseInt(parts[1]) || 0;
        if (existingFiles.has(fileName)) continue; // zaten kayıtlı

        // Türetilmiş dosya mı kontrol et (orijinal dosyanın kök adı kayıtlıysa atla)
        const baseName = _baseFileName(fileName);
        if (existingBases.has(baseName)) continue;

        // Proje adı da zaten varsa atla
        const projName = fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
        if (existingNames.has(projName.toLowerCase())) continue;

        // Yeni proje olarak ekle
        const id = 'auto_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
        ProjectStorage.save({
          id, name: projName, fileName, fileSize,
          segments: [], settings: {},
          createdAt: Date.now(), updatedAt: Date.now()
        });
        existingFiles.add(fileName);
        existingBases.add(baseName);
        existingNames.add(projName.toLowerCase());
        console.log(`[auto-project] Eski kayıt bulundu, proje oluşturuldu: "${projName}"`);
      }
    } catch(e) { console.warn('[auto-project] hata:', e); }
  })();
}

document.addEventListener('DOMContentLoaded', initProjectManager);
