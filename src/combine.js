'use strict';
/* BubbyPDF Combine screen: put files in order, expand a file to arrange or drop single pages,
   preview pages, remove files or pages, undo and redo every step, then combine. */
(() => {
  let D = null;
  const st = { items: [], sel: new Set(), multi: false, layout: 'grid', zoom: 170, undo: [], redo: [], from: 'home', owned: new Set(), drag: null };
  const reg = new Map(); // page key -> page entry
  const $ = (s) => document.querySelector(s);

  // ---------- undo ----------
  const snapshot = () => JSON.stringify(st.items.map((it) => ({ id: it.id, name: it.name, size: it.size, mtime: it.mtime, expanded: it.expanded, current: !!it.current, keys: it.pages.map((p) => p.key) })));
  function restore(s) {
    st.items = JSON.parse(s).map((o) => { const it = { ...o, pages: o.keys.map((k) => reg.get(k)).filter(Boolean) }; delete it.keys; return it; });
    st.sel.clear(); render();
  }
  function push() { st.undo.push(snapshot()); if (st.undo.length > 150) st.undo.shift(); st.redo.length = 0; }
  function undo() { if (!st.undo.length) return; st.redo.push(snapshot()); restore(st.undo.pop()); }
  function redo() { if (!st.redo.length) return; st.undo.push(snapshot()); restore(st.redo.pop()); }

  // ---------- open / close ----------
  async function open({ files = [], fromWorkspace = false } = {}) {
    st.items = []; st.sel.clear(); st.undo = []; st.redo = []; st.owned = new Set(); reg.clear(); st.multi = false;
    $('#cbMulti').checked = false;
    st.from = fromWorkspace ? 'workspace' : 'home';
    if (fromWorkspace && D.S.pages.length) {
      const pages = D.S.pages.slice(); pages.forEach((p) => reg.set(p.key, p));
      st.items.push({ id: D.nid(), name: D.S.fileName || 'Current document', size: null, mtime: null, expanded: false, current: true, pages });
    }
    show(true); render();
    if (files.length) await addFiles(files);
    else if (!st.items.length || fromWorkspace) await addFiles(await D.bench.openPdf());
  }
  function show(on) {
    $('#combine').hidden = !on;
    document.body.classList.toggle('in-combine', on);
    if (on) { $('#start').hidden = true; $('#workspace').hidden = true; setTimeout(() => $('#cbBody').focus(), 0); }
  }
  function close() {
    show(false); D.cleanupDocs(st.owned); reg.clear();
    if (st.from === 'workspace' && D.S.pages.length) D.resume(); else D.showHome();
  }
  async function go() {
    const pages = st.items.flatMap((it) => it.pages);
    if (!pages.length) return;
    const inPlace = st.from === 'workspace' && st.items.some((it) => it.current);
    if (!inPlace && !(await D.guardUnsaved('You have unsaved changes in the open document. Save a copy before combining?'))) return;
    show(false);
    D.applyCombined(pages, { inPlace, files: st.items.length });
    D.cleanupDocs(st.owned); reg.clear();
  }

  // ---------- adding ----------
  async function addFiles(files) {
    files = (files || []).filter(Boolean);
    if (!files.length) { render(); return; }
    const before = snapshot(); let added = 0;
    D.busy(true);
    try {
      for (const f of files) {
        let entries = null;
        try { entries = await D.loadPdf(f); } catch (e) { D.toast(e.message || String(e), 'error'); }
        if (!entries || !entries.length) continue;
        entries.forEach((e) => reg.set(e.key, e)); st.owned.add(entries[0].docId);
        st.items.push({ id: D.nid(), name: f.name, size: f.size || (f.bytes && f.bytes.length) || null, mtime: f.mtime || null, expanded: false, pages: entries });
        added++;
      }
    } finally { D.busy(false); }
    if (added) { st.undo.push(before); st.redo.length = 0; }
    render();
  }

  // ---------- editing ----------
  const fileOf = (id) => st.items.find((it) => it.id === id);
  function removeSelected() {
    if (!st.sel.size) return;
    push();
    for (const s of st.sel) {
      if (s.startsWith('f:')) st.items = st.items.filter((it) => it.id !== s.slice(2));
      else { const k = s.slice(2); st.items.forEach((it) => { it.pages = it.pages.filter((p) => p.key !== k); }); }
    }
    st.items = st.items.filter((it) => it.pages.length);
    st.sel.clear(); render();
  }
  function removeFile(id) { st.sel = new Set(['f:' + id]); removeSelected(); }
  function removePage(key) { st.sel = new Set(['p:' + key]); removeSelected(); }
  function toggleExpand(id) { const it = fileOf(id); if (!it || it.pages.length < 2) return; push(); it.expanded = !it.expanded; st.sel.clear(); render(); }
  function moveFile(id, toIndex) {
    const from = st.items.findIndex((it) => it.id === id); if (from < 0) return;
    if (toIndex > from) toIndex--;
    if (toIndex === from) return;
    push(); const [it] = st.items.splice(from, 1); st.items.splice(toIndex, 0, it); render();
  }
  function movePage(itemId, key, toIndex) {
    const it = fileOf(itemId); if (!it) return;
    const from = it.pages.findIndex((p) => p.key === key); if (from < 0) return;
    if (toIndex > from) toIndex--;
    if (toIndex === from) return;
    push(); const [p] = it.pages.splice(from, 1); it.pages.splice(toIndex, 0, p); render();
  }
  function select(key, e) {
    if (st.multi || e.ctrlKey || e.metaKey) { st.sel.has(key) ? st.sel.delete(key) : st.sel.add(key); }
    else st.sel = new Set([key]);
    render();
  }

  // ---------- preview ----------
  function preview(itemId, startKey) {
    const it = fileOf(itemId); if (!it) return;
    let i = Math.max(0, it.pages.findIndex((p) => p.key === startKey));
    const c = D.el('canvas', { class: 'cprev-canvas' });
    const label = D.el('span', { class: 'muted' });
    const prev = D.el('button', { class: 'btn secondary', onclick: () => { if (i > 0) { i--; draw(); } } }, 'Previous');
    const next = D.el('button', { class: 'btn secondary', onclick: () => { if (i < it.pages.length - 1) { i++; draw(); } } }, 'Next');
    const draw = () => {
      label.textContent = `Page ${i + 1} of ${it.pages.length}`; prev.disabled = i === 0; next.disabled = i === it.pages.length - 1;
      D.thumb(it.pages[i], c, 640);
    };
    const { close } = D.modal([D.el('h2', {}, it.name), c, D.el('div', { class: 'actions' }, label, D.el('span', { class: 'spacer' }), prev, next, D.el('button', { class: 'btn primary', onclick: () => close() }, 'Done'))], 'wide cprev');
    draw();
  }

  // ---------- rendering ----------
  const s = (n) => (n === 1 ? '' : 's');
  const actBtn = (icon, label, fn, cls = '') => {
    const b = D.el('button', { class: 'btn icon sm cact ' + cls, 'aria-label': label, title: label, html: window.icon(icon, 18) });
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    b.addEventListener('dblclick', (e) => e.stopPropagation());
    return b;
  };
  function tip(it) {
    const rows = [['Name', it.name], ['Pages', `${it.pages.length} page${s(it.pages.length)}`]];
    if (it.size) rows.push(['Size', D.fmtSize(it.size)]);
    if (it.mtime) rows.push(['Modified', new Date(it.mtime).toLocaleString()]);
    if (it.current) rows.push(['', 'The document you have open']);
    return D.el('div', { class: 'ctip', role: 'tooltip' }, ...rows.map(([k, v]) => D.el('div', {}, k ? D.el('span', { class: 'muted' }, k + ': ') : null, v)));
  }
  function dndTarget(node, onDrop, kind, itemId) {
    node.addEventListener('dragover', (e) => {
      const d = st.drag; if (!d || d.kind !== kind || (kind === 'page' && d.itemId !== itemId)) return;
      e.preventDefault();
      const r = node.getBoundingClientRect();
      const after = st.layout === 'list' ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
      document.querySelectorAll('.cdrop-before, .cdrop-after').forEach((n) => n.classList.remove('cdrop-before', 'cdrop-after'));
      node.classList.add(after ? 'cdrop-after' : 'cdrop-before');
    });
    node.addEventListener('drop', (e) => {
      const d = st.drag; if (!d || d.kind !== kind) return;
      e.preventDefault(); e.stopPropagation();
      const after = node.classList.contains('cdrop-after');
      document.querySelectorAll('.cdrop-before, .cdrop-after').forEach((n) => n.classList.remove('cdrop-before', 'cdrop-after'));
      onDrop(after); st.drag = null;
    });
  }
  function fileCard(it, idx) {
    const key = 'f:' + it.id; const n = it.pages.length;
    const card = D.el('div', { class: 'ccard' + (st.sel.has(key) ? ' selected' : '') + (n > 1 ? ' stack' : '') + (it.current ? ' current' : ''), draggable: 'true', tabindex: '0', role: 'listitem', 'aria-label': `${it.name}, ${n} page${s(n)}` });
    const c = D.el('canvas'); D.thumb(it.pages[0], c, Math.round(st.zoom * 1.5));
    const acts = D.el('div', { class: 'cacts' });
    if (n > 1) acts.append(actBtn('expand', 'Show pages', () => toggleExpand(it.id)));
    acts.append(actBtn('trash', 'Remove file', () => removeFile(it.id), 'danger'), actBtn('zoomin', 'Preview', () => preview(it.id)));
    card.append(D.el('div', { class: 'cthumb' }, c), acts, D.el('div', { class: 'cname', title: it.name }, it.name), D.el('div', { class: 'cmeta' }, `${n} page${s(n)}`), tip(it));
    card.addEventListener('click', (e) => select(key, e));
    card.addEventListener('dblclick', () => preview(it.id));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') preview(it.id); if (e.key === 'Delete') removeFile(it.id); });
    card.addEventListener('dragstart', (e) => { st.drag = { kind: 'file', id: it.id }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'bubbypdf-file'); });
    card.addEventListener('dragend', () => { st.drag = null; });
    dndTarget(card, (after) => moveFile(st.drag.id, idx + (after ? 1 : 0)), 'file');
    return card;
  }
  function groupEl(it, idx) {
    const g = D.el('div', { class: 'cgroup', role: 'group', 'aria-label': it.name, draggable: 'false' });
    const head = D.el('div', { class: 'cghead', draggable: 'true' },
      actBtn('collapse', 'Put pages back together', () => toggleExpand(it.id)),
      D.el('span', { class: 'cname', title: it.name }, it.name), D.el('span', { class: 'muted' }, `${it.pages.length} pages`));
    head.addEventListener('dragstart', (e) => { st.drag = { kind: 'file', id: it.id }; e.dataTransfer.setData('text/plain', 'bubbypdf-file'); });
    head.addEventListener('dragend', () => { st.drag = null; });
    dndTarget(g, (after) => moveFile(st.drag.id, idx + (after ? 1 : 0)), 'file');
    const row = D.el('div', { class: 'cpages' });
    it.pages.forEach((p, pi) => {
      const key = 'p:' + p.key;
      const card = D.el('div', { class: 'ccard page' + (st.sel.has(key) ? ' selected' : ''), draggable: 'true', tabindex: '0', role: 'listitem', 'aria-label': `${it.name}, page ${pi + 1}` });
      const c = D.el('canvas'); D.thumb(p, c, Math.round(st.zoom * 1.5));
      const acts = D.el('div', { class: 'cacts' }, actBtn('trash', 'Remove page', () => removePage(p.key), 'danger'), actBtn('zoomin', 'Preview', () => preview(it.id, p.key)));
      card.append(D.el('div', { class: 'cthumb' }, c), acts, D.el('div', { class: 'cmeta' }, String(pi + 1)));
      card.addEventListener('click', (e) => select(key, e));
      card.addEventListener('dblclick', () => preview(it.id, p.key));
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter') preview(it.id, p.key); if (e.key === 'Delete') removePage(p.key); });
      card.addEventListener('dragstart', (e) => { e.stopPropagation(); st.drag = { kind: 'page', itemId: it.id, key: p.key }; e.dataTransfer.setData('text/plain', 'bubbypdf-page'); });
      card.addEventListener('dragend', () => { st.drag = null; });
      dndTarget(card, (after) => movePage(it.id, st.drag.key, pi + (after ? 1 : 0)), 'page', it.id);
      row.append(card);
    });
    g.append(head, row);
    return g;
  }
  function listView(body) {
    body.append(D.el('div', { class: 'clrow head', role: 'row' }, D.el('span'), D.el('span', {}, 'Name'), D.el('span', {}, 'Pages'), D.el('span', {}, 'Size'), D.el('span', {}, 'Modified'), D.el('span')));
    st.items.forEach((it, idx) => {
      const key = 'f:' + it.id;
      const c = D.el('canvas'); D.thumb(it.pages[0], c, 80);
      const row = D.el('div', { class: 'clrow' + (st.sel.has(key) ? ' selected' : ''), role: 'row', tabindex: '0', draggable: 'true' },
        D.el('span', { class: 'cthumb' }, c), D.el('span', { class: 'cname', title: it.name }, it.name), D.el('span', {}, String(it.pages.length)),
        D.el('span', {}, it.size ? D.fmtSize(it.size) : ''), D.el('span', {}, it.mtime ? new Date(it.mtime).toLocaleDateString() : ''),
        D.el('span', { class: 'clacts' },
          actBtn('back', 'Move up', () => moveFile(it.id, idx - 1), 'up'), actBtn('back', 'Move down', () => moveFile(it.id, idx + 2), 'down'),
          actBtn('trash', 'Remove file', () => removeFile(it.id), 'danger')));
      row.querySelector('.up').disabled = idx === 0; row.querySelector('.down').disabled = idx === st.items.length - 1;
      row.addEventListener('click', (e) => select(key, e));
      row.addEventListener('dblclick', () => preview(it.id));
      row.addEventListener('dragstart', (e) => { st.drag = { kind: 'file', id: it.id }; e.dataTransfer.setData('text/plain', 'bubbypdf-file'); });
      row.addEventListener('dragend', () => { st.drag = null; });
      dndTarget(row, (after) => moveFile(st.drag.id, idx + (after ? 1 : 0)), 'file');
      body.append(row);
    });
  }
  function render() {
    const body = $('#cbBody'); body.textContent = '';
    body.className = 'cbody ' + st.layout; body.style.setProperty('--cz', st.zoom + 'px');
    const total = st.items.reduce((t, it) => t + it.pages.length, 0);
    $('#cbSummary').textContent = st.items.length ? `${st.items.length} file${s(st.items.length)}, ${total} page${s(total)}${st.sel.size ? ` · ${st.sel.size} selected` : ''}` : '';
    $('#cbGo').disabled = !total;
    $('#cbUndo').disabled = !st.undo.length; $('#cbRedo').disabled = !st.redo.length; $('#cbRemove').disabled = !st.sel.size;
    ['cbGrid', 'cbList'].forEach((id) => { const on = (id === 'cbList') === (st.layout === 'list'); $('#' + id).setAttribute('aria-pressed', String(on)); });
    if (!st.items.length) {
      body.append(D.el('div', { class: 'cempty' }, D.el('img', { src: 'logo.png', alt: '', width: '64', height: '64' }),
        D.el('h2', {}, 'Add the files you want to combine'), D.el('p', { class: 'muted' }, 'Drop PDFs here, or choose them from your computer.'),
        D.el('button', { class: 'btn primary', onclick: async () => addFiles(await D.bench.openPdf()) }, 'Add files')));
      return;
    }
    if (st.layout === 'list') { listView(body); return; }
    st.items.forEach((it, idx) => body.append(it.expanded ? groupEl(it, idx) : fileCard(it, idx)));
  }

  function init(deps) {
    D = deps;
    $('#cbAdd').onclick = async () => addFiles(await D.bench.openPdf());
    $('#cbRemove').onclick = removeSelected;
    $('#cbUndo').onclick = undo; $('#cbRedo').onclick = redo;
    $('#cbGrid').onclick = () => { st.layout = 'grid'; render(); };
    $('#cbList').onclick = () => { st.layout = 'list'; render(); };
    $('#cbClose').onclick = close; $('#cbGo').onclick = go;
    $('#cbZoomIn').onclick = () => { st.zoom = Math.min(320, st.zoom + 30); render(); };
    $('#cbZoomOut').onclick = () => { st.zoom = Math.max(110, st.zoom - 30); render(); };
    $('#cbMulti').onchange = (e) => { st.multi = e.target.checked; if (!st.multi && st.sel.size > 1) st.sel.clear(); render(); };
    $('#cbBody').addEventListener('click', (e) => { if (e.target === e.currentTarget && st.sel.size) { st.sel.clear(); render(); } });
    document.addEventListener('keydown', (e) => {
      if (!document.body.classList.contains('in-combine') || document.querySelector('.backdrop')) return;
      const mod = e.ctrlKey || e.metaKey; const k = e.key.toLowerCase();
      if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      else if (e.key === 'Delete' && st.sel.size) { e.preventDefault(); removeSelected(); }
      else if (mod && k === 'a') { e.preventDefault(); st.multi = true; $('#cbMulti').checked = true; st.sel = new Set(st.items.map((it) => 'f:' + it.id)); render(); }
      else if (e.key === 'Escape' && st.sel.size) { st.sel.clear(); render(); }
    });
  }

  window.BubbyCombine = { init, open, addFiles, state: st, undo, redo, removeSelected, toggleExpand, moveFile, movePage, go, close };
})();
