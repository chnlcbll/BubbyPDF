'use strict';
/* BubbyPDF renderer.
   Model: S.pages is the output document, in order. Each entry points at a page of a loaded
   source PDF (or is a blank page) and carries its own annotations. Annotation geometry is in
   PDF points, top-left origin, in the page's unrotated space; mat() maps it to the screen. */
(() => {
  const pdfjsLib = window.pdfjsLib;
  const { PDFDocument, StandardFonts, rgb, degrees, BlendMode, LineCapStyle } = window.PDFLib;
  const abs = (rel) => new URL(rel, location.href).href;
  pdfjsLib.GlobalWorkerOptions.workerSrc = abs('../node_modules/pdfjs-dist/build/pdf.worker.min.js');
  const PDFJS_OPTS = {
    isEvalSupported: false,
    standardFontDataUrl: abs('../node_modules/pdfjs-dist/standard_fonts/'),
    cMapUrl: abs('../node_modules/pdfjs-dist/cmaps/'),
    cMapPacked: true,
  };

  // ---------- bridge (Electron preload, or a browser fallback for testing) ----------
  const bench = window.bench || webBridge();
  function webBridge() {
    const pick = (accept, multiple) => new Promise((res) => {
      const i = document.createElement('input');
      i.type = 'file'; i.accept = accept; i.multiple = multiple;
      i.onchange = async () => res(await Promise.all([...i.files].map(async (f) => ({ name: f.name, path: null, bytes: new Uint8Array(await f.arrayBuffer()) }))));
      i.click();
    });
    return {
      web: true,
      openPdf: () => pick('application/pdf,.pdf', true),
      openImage: async () => (await pick('image/png,image/jpeg', false))[0] || null,
      readFile: async () => null,
      savePdf: async ({ suggestedName, bytes }) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        a.download = suggestedName; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        return { name: suggestedName, path: null };
      },
      recent: async () => [], clearRecent: async () => [], initialFile: async () => null,
      setDirty() {}, closeNow() {}, onCloseRequest() {}, onOpenFile() {},
      openExternal: async (u) => window.open(u, '_blank', 'noopener'), showInFolder: async () => {},
      pathForFile: () => null,
    };
  }

  // ---------- state ----------
  const S = {
    docs: new Map(), pages: [], images: new Map(), fields: new Map(),
    tool: 'select', zoom: 1, sel: null, selPages: new Set(), anchorPage: null, current: 0, fsize: new Map(), marks: null, fieldFocus: null,
    undo: [], redo: [], dirty: false, placing: null, editing: null, drag: null, history: [],
    fileName: null, search: { q: '', results: [], active: -1 },
    style: { color: '#111111', hl: '#FFD84D', markup: '#C62828', note: '#FFD84D', size: 12, width: 2, mark: 'check', check: 14, font: 'helv' },
    note: null,
  };
  let uidN = 1;
  const nid = () => 'k' + (uidN++).toString(36) + Math.random().toString(36).slice(2, 6);

  const $ = (s, r = document) => r.querySelector(s);
  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dpr = () => window.devicePixelRatio || 1;

  // ---------- geometry ----------
  const dispRot = (p) => (((p.rot0 + p.rot) % 360) + 360) % 360;
  function mat(p, s) {
    const W = p.W, H = p.H;
    switch (dispRot(p)) {
      case 90: return [0, s, -s, 0, s * H, 0];
      case 180: return [-s, 0, 0, -s, s * W, s * H];
      case 270: return [0, -s, s, 0, 0, s * W];
      default: return [s, 0, 0, s, 0, 0];
    }
  }
  const dispSize = (p, s) => (dispRot(p) % 180 ? [p.H * s, p.W * s] : [p.W * s, p.H * s]);
  const apply = (m, u, v) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
  function invert(m, x, y) {
    const [a, b, c, d, e, f] = m; const det = a * d - b * c; const X = x - e, Y = y - f;
    return [(d * X - c * Y) / det, (-b * X + a * Y) / det];
  }
  function screenRect(p, u1, v1, u2, v2, s = S.zoom) {
    const m = mat(p, s); const A = apply(m, u1, v1), B = apply(m, u2, v2);
    return { left: Math.min(A[0], B[0]), top: Math.min(A[1], B[1]), width: Math.abs(A[0] - B[0]), height: Math.abs(A[1] - B[1]) };
  }
  function pos(node, r) { Object.assign(node.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' }); }

  // ---------- fonts and text measuring ----------
  const FONTS = { helv: 'Helvetica, Arial, sans-serif', times: '"Times New Roman", Times, serif', cour: '"Courier New", Courier, monospace' };
  const mctx = document.createElement('canvas').getContext('2d');
  function measure(str, a) { mctx.font = `${a.size}px ${FONTS[a.font] || FONTS.helv}`; return mctx.measureText(str).width; }

  // ---------- images ----------
  const imgEls = new Map();
  function imgEl(id) {
    let im = imgEls.get(id);
    if (!im) { im = new Image(); im.src = S.images.get(id).dataUrl; im.onload = () => redrawAll(); imgEls.set(id, im); }
    return im;
  }
  function dataUrlBytes(url) {
    const b = atob(url.split(',')[1]); const out = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
    return out;
  }
  function addImage(dataUrl, w0, h0) {
    const id = nid();
    const mime = /^data:image\/jpe?g/.test(dataUrl) ? 'jpg' : 'png';
    S.images.set(id, { id, dataUrl, bytes: dataUrlBytes(dataUrl), mime, w0, h0 });
    return id;
  }

  // ---------- annotation drawing ----------
  function markSegs(a) {
    const s = a.size, x = a.x, y = a.y;
    if (a.mark === 'cross') return [[[x + 0.18 * s, y + 0.18 * s], [x + 0.82 * s, y + 0.82 * s]], [[x + 0.82 * s, y + 0.18 * s], [x + 0.18 * s, y + 0.82 * s]]];
    return [[[x + 0.12 * s, y + 0.55 * s], [x + 0.4 * s, y + 0.82 * s], [x + 0.9 * s, y + 0.16 * s]]];
  }
  function drawAnnot(ctx, a) {
    ctx.save();
    switch (a.type) {
      case 'highlight':
        ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = 0.45; ctx.fillStyle = a.color;
        for (const r of rectsOf(a)) ctx.fillRect(r.x, r.y, r.w, r.h);
        break;
      case 'underline': case 'strike':
        ctx.strokeStyle = a.color; ctx.lineCap = 'butt';
        for (const r of rectsOf(a)) {
          const y = a.type === 'underline' ? r.y + r.h * 0.92 : r.y + r.h * 0.55;
          ctx.lineWidth = Math.max(0.8, r.h * 0.07);
          ctx.beginPath(); ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); ctx.stroke();
        }
        break;
      case 'note': drawNoteIcon(ctx, a); break;
      case 'textedit': {
        // White over the old paragraph is only an on-screen preview; on save the old text is removed from the file.
        if (a.region) { ctx.fillStyle = '#ffffff'; ctx.fillRect(a.region.x, a.region.y, a.region.w, a.region.h); }
        ctx.fillStyle = a.color; ctx.font = cssFont(a); ctx.textBaseline = 'alphabetic';
        wrapLines(a).forEach((ln, i) => {
          const lw = textWidth(a, ln); const dx = a.align === 'center' ? (a.w - lw) / 2 : a.align === 'right' ? a.w - lw : 0;
          ctx.fillText(ln, a.x + dx, a.y + a.size * 0.8 + i * a.leading);
        });
        break;
      }
      case 'redact':
        ctx.fillStyle = 'rgba(0,0,0,0.82)'; ctx.fillRect(a.x, a.y, a.w, a.h);
        ctx.strokeStyle = '#D92D20'; ctx.lineWidth = 1; ctx.strokeRect(a.x, a.y, a.w, a.h);
        break;
      case 'whiteout': ctx.fillStyle = '#ffffff'; ctx.fillRect(a.x, a.y, a.w, a.h); break;
      case 'rect': ctx.strokeStyle = a.color; ctx.lineWidth = a.width; ctx.strokeRect(a.x, a.y, a.w, a.h); break;
      case 'ink':
        ctx.strokeStyle = a.color; ctx.lineWidth = a.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        a.pts.forEach(([u, v], i) => (i ? ctx.lineTo(u, v) : ctx.moveTo(u, v)));
        if (a.pts.length === 1) ctx.lineTo(a.pts[0][0] + 0.01, a.pts[0][1]);
        ctx.stroke(); break;
      case 'text':
        ctx.fillStyle = a.color; ctx.font = `${a.size}px ${FONTS[a.font] || FONTS.helv}`; ctx.textBaseline = 'alphabetic';
        a.text.split('\n').forEach((ln, i) => ctx.fillText(ln, a.x, a.y + a.size * (0.8 + 1.2 * i))); break;
      case 'check':
        ctx.strokeStyle = a.color; ctx.fillStyle = a.color;
        if (a.mark === 'dot') { ctx.beginPath(); ctx.arc(a.x + a.size / 2, a.y + a.size / 2, a.size * 0.3, 0, Math.PI * 2); ctx.fill(); break; }
        ctx.lineWidth = a.size * 0.13; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (const seg of markSegs(a)) { ctx.beginPath(); seg.forEach(([u, v], i) => (i ? ctx.lineTo(u, v) : ctx.moveTo(u, v))); ctx.stroke(); }
        break;
      case 'image': {
        const im = S.images.has(a.imageId) ? imgEl(a.imageId) : null;
        if (im && im.complete && im.naturalWidth) ctx.drawImage(im, a.x, a.y, a.w, a.h);
        break;
      }
    }
    ctx.restore();
  }
  const NOTE = 18; // sticky note icon size in points
  const rectsOf = (a) => (a.rects && a.rects.length ? a.rects : [{ x: a.x, y: a.y, w: a.w, h: a.h }]);
  function drawNoteIcon(ctx, a) {
    const { x, y } = a; const s = NOTE;
    ctx.fillStyle = a.color || '#FFD84D'; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + s, y); ctx.lineTo(x + s, y + s * 0.7); ctx.lineTo(x + s * 0.7, y + s); ctx.lineTo(x, y + s); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + s * 0.2, y + s * 0.32); ctx.lineTo(x + s * 0.8, y + s * 0.32);
    ctx.moveTo(x + s * 0.2, y + s * 0.55); ctx.lineTo(x + s * 0.6, y + s * 0.55); ctx.stroke();
  }
  // Move an annotation by (dx, dy) from its original copy o.
  function shiftAnnot(a, o, dx, dy) {
    if (a.type === 'ink') { a.pts = o.pts.map(([x, y]) => [x + dx, y + dy]); return; }
    a.x = o.x + dx; a.y = o.y + dy;
    if (o.rects) a.rects = o.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }));
  }
  function bounds(a) {
    if (a.type === 'note') return { x: a.x, y: a.y, w: NOTE, h: NOTE };
    if (a.type === 'textedit') { const n = Math.max(1, wrapLines(a).length); return { x: a.x, y: a.y, w: a.w, h: (n - 1) * a.leading + a.size * 1.2 }; }
    if (a.type === 'text') {
      const lines = a.text.split('\n');
      return { x: a.x, y: a.y, w: Math.max(a.size * 0.6, ...lines.map((l) => measure(l, a))), h: a.size * 1.2 * lines.length };
    }
    if (a.type === 'check') return { x: a.x, y: a.y, w: a.size, h: a.size };
    if (a.type === 'ink') {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const [u, v] of a.pts) { x1 = Math.min(x1, u); y1 = Math.min(y1, v); x2 = Math.max(x2, u); y2 = Math.max(y2, v); }
      const r = a.width / 2 + 2;
      return { x: x1 - r, y: y1 - r, w: x2 - x1 + 2 * r, h: y2 - y1 + 2 * r };
    }
    return { x: a.x, y: a.y, w: a.w, h: a.h };
  }
  const resizable = (a) => a.type !== 'ink' && a.type !== 'note' && a.type !== 'foreign' && !(a.rects && a.rects.length);
  function hit(p, u, v) {
    const tol = 4 / S.zoom;
    for (let i = p.annots.length - 1; i >= 0; i--) {
      const b = bounds(p.annots[i]); const vv = v - pushOf(p, b.y);
      if (u >= b.x - tol && u <= b.x + b.w + tol && vv >= b.y - tol && vv <= b.y + b.h + tol) return p.annots[i];
    }
    return null;
  }
  function onHandle(a, u, v) {
    if (!resizable(a)) return false;
    const b = bounds(a); const hz = 9 / S.zoom;
    return Math.abs(u - (b.x + b.w)) <= hz && Math.abs(v - (b.y + b.h)) <= hz;
  }
  function drawSelection(ctx, a) {
    const b = bounds(a); const k = 1 / S.zoom;
    ctx.save();
    ctx.strokeStyle = '#C2410C'; ctx.lineWidth = 1.5 * k; ctx.setLineDash([4 * k, 3 * k]);
    ctx.strokeRect(b.x - 2 * k, b.y - 2 * k, b.w + 4 * k, b.h + 4 * k);
    if (resizable(a)) {
      ctx.setLineDash([]); ctx.fillStyle = '#ffffff';
      const hs = 8 * k;
      ctx.fillRect(b.x + b.w - hs / 2, b.y + b.h - hs / 2, hs, hs);
      ctx.strokeRect(b.x + b.w - hs / 2, b.y + b.h - hs / 2, hs, hs);
    }
    ctx.restore();
  }

  // ---------- documents ----------
  async function loadPdf(file) {
    const id = nid();
    let bytes = file.bytes; let imported = null;
    if (hasMarker(bytes)) {
      try { ({ bytes, imported } = await extractOwnAnnots(bytes)); } catch (e) { console.warn('Could not read BubbyPDF annotations', e); }
    }
    const task = pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes.slice() });
    let cancelled = false; let usedPassword = null;
    task.onPassword = (update, reason) => {
      askPassword(file.name, reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD).then((pw) => {
        if (pw == null) { cancelled = true; task.destroy(); } else { usedPassword = pw; update(pw); }
      });
    };
    let pdf;
    try { pdf = await task.promise; } catch (e) {
      if (cancelled) return null;
      throw new Error(`"${file.name}" could not be opened. It may be damaged or not a PDF.`);
    }
    const doc = { id, name: file.name, path: file.path || null, bytes, origBytes: bytes, pdf, password: usedPassword, foreignAll: new Set() };
    S.docs.set(id, doc);
    const entries = [];
    for (let i = 0; i < pdf.numPages; i++) {
      const pg = await pdf.getPage(i + 1);
      const [x0, y0, x1, y1] = pg.view;
      const annots = imported && imported[i] ? imported[i].map(importAnnot) : [];
      // Markups made in other apps: selectable and removable (BubbyPDF does not redraw them; the PDF layer does).
      try {
        for (const fa of await pg.getAnnotations({ intent: 'display' })) {
          if (!fa.rect || !fa.id || ['Widget', 'Link', 'Popup'].includes(fa.subtype)) continue;
          doc.foreignAll.add(fa.id);
          annots.push({ id: nid(), type: 'foreign', ref: fa.id, subtype: fa.subtype, label: (fa.contentsObj && fa.contentsObj.str) || '',
            x: fa.rect[0] - x0, y: y1 - fa.rect[3], w: Math.max(2, fa.rect[2] - fa.rect[0]), h: Math.max(2, fa.rect[3] - fa.rect[1]) });
        }
      } catch { /* annotations are optional */ }
      entries.push({ key: nid(), docId: id, src: i, rot0: pg.rotate || 0, rot: 0, W: x1 - x0, H: y1 - y0, view: [x0, y0, x1, y1], blank: false, annots });
    }
    return entries;
  }

  async function openFiles(files, { replace }) {
    files = files.filter(Boolean);
    if (!files.length) return;
    if (replace && !(await guardUnsaved('You have unsaved changes. Save them before opening another file?'))) return;
    busy(true);
    try {
      const added = [];
      for (const f of files) {
        const entries = await loadPdf(f);
        if (entries) added.push({ f, entries });
      }
      if (!added.length) return;
      if (replace || !S.pages.length) {
        for (const d of S.docs.values()) if (!added.some((x) => x.entries[0] && x.entries[0].docId === d.id)) { try { d.pdf.destroy(); } catch {} S.docs.delete(d.id); }
        S.pages = []; S.undo = []; S.redo = []; S.fields = new Map(); S.fsize = new Map(); S.marks = null; S.history = []; S.selPages.clear(); S.sel = null;
        S.fileName = added[0].f.name; S.filePath = added.length === 1 ? added[0].f.path || null : null; textCache.clear(); blockCache.clear(); closeNote(); closeSearch();
        for (const x of added) S.pages.push(...x.entries);
        S.dirty = added.length > 1; bench.setDirty(S.dirty);
        if (added.length > 1) S.fileName = 'Combined.pdf';
        const d0 = S.docs.get(added[0].entries[0].docId);
        S.protect = d0 && d0.password ? { userPassword: d0.password, ownerPassword: d0.password, permissions: {}, inherited: true } : null;
        showWorkspace(true);
        for (const x of added) saveThumbFor(S.docs.get(x.entries[0] && x.entries[0].docId));
        fitWidth();
        if (added.length > 1) toast(`Combined ${added.length} PDFs into one document.`);
      } else {
        snap();
        const n = added.reduce((t, x) => t + x.entries.length, 0);
        for (const x of added) S.pages.push(...x.entries);
        markDirty();
        layoutPages(); renderThumbs();
        toast(`Added ${n} page${n === 1 ? '' : 's'} from ${added.map((x) => x.f.name).join(', ')}.`);
      }
      updateTitle(); updateUndoButtons();
    } catch (e) {
      toast(e.message || String(e), 'error');
    } finally { busy(false); }
  }

  async function guardUnsaved(msg) {
    if (!S.dirty || !S.pages.length) return true;
    const r = await ask('Unsaved changes', msg, [
      { label: 'Cancel', value: null }, { label: "Don't save", value: 'discard' }, { label: 'Save', value: 'save', primary: true }]);
    if (r == null) return false;
    if (r === 'save') return await saveInPlace();
    return true;
  }

  // ---------- markups from other apps: removing them ----------
  const fsync = new Map();
  function scheduleForeign(docId) { clearTimeout(fsync.get(docId)); fsync.set(docId, setTimeout(() => syncForeign(docId), 30)); }
  function syncForeignAll() { for (const id of S.docs.keys()) scheduleForeign(id); }
  async function libOf(d, bytes = d.bytes) {
    const base = { updateMetadata: false };
    try { return await PDFDocument.load(bytes, d.password != null ? { ...base, password: d.password } : base); } catch (e) {
      if (/encrypt|password/i.test(e.message || '')) return PDFDocument.load(bytes, { ...base, password: d.password || '' });
      throw e;
    }
  }
  async function syncForeign(docId) {
    const doc = S.docs.get(docId); if (!doc || !doc.foreignAll || !doc.foreignAll.size) return;
    const keep = new Set();
    for (const p of S.pages) if (p.docId === docId) for (const a of p.annots) if (a.type === 'foreign') keep.add(a.ref);
    const removed = [...doc.foreignAll].filter((r) => !keep.has(r)).sort();
    const sig = removed.join(',');
    if (sig === (doc.removedSig || '')) return;
    let bytes = doc.origBytes; let decrypted = false;
    if (removed.length) {
      const P = window.PDFLib; const ld = await libOf(doc, doc.origBytes);
      const tags = new Set(removed.map((r) => { const m = /^(\d+)R(\d*)$/.exec(r); return m ? `${m[1]} ${m[2] || 0} R` : r; }));
      for (const pg of ld.getPages()) {
        const arr = pg.node.Annots(); if (!arr) continue;
        for (let i = arr.size() - 1; i >= 0; i--) {
          const raw = arr.get(i);
          if (raw instanceof P.PDFRef && tags.has(raw.tag)) { arr.remove(i); continue; }
          const d = arr.lookup(i); const par = d instanceof P.PDFDict ? d.get(P.PDFName.of('Parent')) : null;
          if (par instanceof P.PDFRef && tags.has(par.tag)) arr.remove(i);
        }
      }
      bytes = await ld.save({ useObjectStreams: false }); decrypted = true;
    }
    const opts = { ...PDFJS_OPTS, data: bytes.slice() };
    if (!decrypted && doc.password != null) opts.password = doc.password;
    const pdf = await pdfjsLib.getDocument(opts).promise;
    try { doc.pdf.destroy(); } catch { /* already gone */ }
    doc.pdf = pdf; doc.bytes = bytes; doc.removedSig = sig;
    for (const k of [...textCache.keys()]) if (k.startsWith(docId + ':')) textCache.delete(k);
    for (const k of [...blockCache.keys()]) if (k.startsWith(docId + ':')) blockCache.delete(k);
    for (const p of S.pages) if (p.docId === docId) {
      const pe = pageEls.get(p.key);
      if (pe) { pe.rendered = null; pe.layerKey = null; if (pe.visible) renderBase(p); }
      scheduleThumb(p);
    }
  }
  function removeAllMarkups() {
    const n = S.pages.reduce((t, p) => t + p.annots.length, 0);
    if (!n) { toast('There are no markups in this document.'); return; }
    snap();
    for (const p of S.pages) p.annots = [];
    S.sel = null; markDirty(); redrawAll(); renderThumbs(); syncForeignAll(); renderToolOpts();
    toast(`Removed ${n} markup${n > 1 ? 's' : ''}. Ctrl+Z brings them back.`);
  }

  // ---------- page layout and rendering ----------
  const viewer = $('#viewer'), pagesEl = $('#pages');
  const pageEls = new Map();
  let io = null;

  function layoutPages(keepPage = true) {
    const anchor = keepPage ? S.pages[S.current] && S.pages[S.current].key : null;
    if (io) io.disconnect();
    for (const pe of pageEls.values()) if (pe.task) { try { pe.task.cancel(); } catch {} }
    pagesEl.textContent = ''; pageEls.clear();
    io = new IntersectionObserver(onVisible, { root: viewer, rootMargin: '900px 0px' });
    S.pages.forEach((p, i) => {
      const [w, h] = dispSize(p, S.zoom);
      const root = el('div', { class: 'page', 'data-key': p.key, role: 'img', 'aria-label': `Page ${i + 1}` });
      root.style.width = w + 'px'; root.style.height = h + 'px';
      const base = el('canvas', { class: 'base' }), over = el('canvas', { class: 'over' }), layer = el('div', { class: 'layer' });
      root.append(base, over, layer);
      pagesEl.append(root);
      pageEls.set(p.key, { root, base, over, layer, rendered: null, task: null, visible: false, layerKey: null });
      io.observe(root);
    });
    $('#pageTotal').textContent = '/ ' + S.pages.length;
    $('#pageCount').textContent = String(S.pages.length);
    if (anchor) { const i = S.pages.findIndex((p) => p.key === anchor); if (i >= 0) scrollToPage(i, false); }
  }

  function onVisible(entries) {
    for (const en of entries) {
      const key = en.target.dataset.key;
      const pe = pageEls.get(key); const p = pageByKey(key);
      if (!pe || !p) continue;
      pe.visible = en.isIntersecting;
      if (pe.visible) { renderBase(p); drawOverlay(p); }
      else {
        if (pe.task) { try { pe.task.cancel(); } catch {} pe.task = null; }
        pe.base.width = pe.base.height = 0; pe.over.width = pe.over.height = 0; pe.rendered = null;
      }
    }
  }
  const pageByKey = (key) => S.pages.find((p) => p.key === key);

  const previews = new Map(); const pvTimers = new Map();
  const teSig = (p) => JSON.stringify(p.annots.filter((a) => a.type === 'textedit').map((a) => [a.id, a.text, a.x, a.y, a.w, a.size, a.leading, a.font, a.bold, a.italic, a.align, a.color, !!a.restyled]));
  const pvReady = (p) => { const pv = previews.get(p.key); return !!(pv && pv.pdf && pv.sig === teSig(p)); };
  // how far a point at height v on the page was pushed down by paragraphs above it that grew
  function pushOf(p, v) {
    const pv = previews.get(p.key); if (!pv || !pv.shifts || !pv.shifts.length || !pvReady(p)) return 0;
    return pv.shifts.filter((sh) => sh.cutV <= v + 0.01).reduce((t, sh) => t + sh.dy, 0);
  }
  function rerender(p) { const pe = pageEls.get(p.key); if (pe) { pe.rendered = null; if (pe.visible) { renderBase(p); drawOverlay(p); } } }
  function schedulePreview(p) {
    const sig = teSig(p); const pv = previews.get(p.key);
    if (sig === '[]') { if (pv) { previews.delete(p.key); try { pv.pdf && pv.pdf.destroy(); } catch { /* gone */ } rerender(p); } return; }
    if (pv && pv.sig === sig) return;
    clearTimeout(pvTimers.get(p.key));
    pvTimers.set(p.key, setTimeout(async () => {
      try {
        const only = { ...p, annots: p.annots.filter((a) => a.type === 'textedit') };
        const res = await buildPdf([only], { preview: true }); const { bytes } = res;
        if (teSig(p) !== sig) return;
        const pdf = await pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes }).promise;
        const old = previews.get(p.key); if (old && old.pdf) { try { old.pdf.destroy(); } catch { /* gone */ } }
        previews.set(p.key, { sig, pdf, shifts: (res.shifts && res.shifts[0]) || [] });
        rerender(p);
      } catch (e) { console.warn('preview', e); window.__bubbyPreviewError = String((e && e.stack) || e); }
    }, 300));
  }

  async function renderBase(p) {
    const pe = pageEls.get(p.key); if (!pe) return;
    const r = dpr(); const pvOn = pvReady(p); const rk = `${S.zoom}:${dispRot(p)}:${r}:${pvOn ? teSig(p) : ''}`;
    if (pe.rendered === rk) return;
    pe.rendered = rk;
    const [w, h] = dispSize(p, S.zoom);
    if (pe.task) { try { pe.task.cancel(); } catch {} pe.task = null; }
    if (p.blank) {
      const c = pe.base; c.width = Math.round(w * r); c.height = Math.round(h * r);
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      return;
    }
    const doc = S.docs.get(p.docId);
    const page = pvOn ? await previews.get(p.key).pdf.getPage(1) : await doc.pdf.getPage(p.src + 1);
    if (pe.rendered !== rk || !pageEls.has(p.key)) return;
    // Render into an offscreen canvas, then swap, so zooming never flashes white.
    const off = document.createElement('canvas');
    off.width = Math.round(w * r); off.height = Math.round(h * r);
    const vp = page.getViewport({ scale: S.zoom * r, rotation: dispRot(p) });
    const task = page.render({ canvasContext: off.getContext('2d'), viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS, background: '#ffffff' });
    pe.task = task;
    try { await task.promise; } catch (e) { if (e && e.name !== 'RenderingCancelledException') console.warn(e); return; }
    if (pe.task === task) pe.task = null;
    if (pe.rendered !== rk) return;
    const c = pe.base; c.width = off.width; c.height = off.height; c.getContext('2d').drawImage(off, 0, 0);
    buildLayer(p, page);
  }

  function drawOverlay(p) {
    const pe = pageEls.get(p.key); if (!pe || !pe.visible) return;
    const r = dpr(); const [w, h] = dispSize(p, S.zoom);
    const c = pe.over; const W = Math.round(w * r), H = Math.round(h * r);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
    ctx.setTransform(...mat(p, S.zoom * r));
    for (const a of p.annots) {
      if (a.type === 'textedit' && a.id !== S.editing && pvReady(p)) continue; // the page itself already shows it
      const d = pushOf(p, a.type === 'textedit' && a.region ? a.region.y : bounds(a).y);
      if (d) { ctx.save(); ctx.translate(0, d); }
      if (a.id !== S.editing) drawAnnot(ctx, a);
      else if (a.type === 'textedit' && a.region) { ctx.fillStyle = '#ffffff'; ctx.fillRect(a.region.x, a.region.y, a.region.w, a.region.h); }
      if (d) ctx.restore();
    }
    if (S.drag && S.drag.preview && S.drag.key === p.key) drawAnnot(ctx, S.drag.preview);
    const sel = S.sel && p.annots.find((a) => a.id === S.sel);
    if (sel && sel.id !== S.editing) {
      const d = pushOf(p, sel.type === 'textedit' && sel.region ? sel.region.y : bounds(sel).y);
      if (d) { ctx.save(); ctx.translate(0, d); } drawSelection(ctx, sel); if (d) ctx.restore();
    }
    if (S.marks) window.BubbyTools.drawMarksOverlay(ctx, p, S.pages.indexOf(p), S.pages.length, S.zoom * r);
  }
  function redrawAll() { for (const p of S.pages) drawOverlay(p); }

  // HTML layer: form fields, links, editable text boxes and search hits.
  async function buildLayer(p, page) {
    const pe = pageEls.get(p.key); if (!pe) return;
    const lk = `${S.zoom}:${dispRot(p)}:${pvReady(p) ? teSig(p) : ''}`;
    if (pe.layerKey === lk) return;
    pe.layerKey = lk;
    const [annots, blocks] = await Promise.all([page.getAnnotations({ intent: 'display' }), textBlocks(p)]);
    if (pe.layerKey !== lk || !pageEls.has(p.key)) return;
    pe.layer.textContent = '';
    const [x0, , , y1] = p.view;
    for (const a of annots) {
      if (!a.rect) continue;
      const r = screenRect(p, a.rect[0] - x0, y1 - a.rect[3], a.rect[2] - x0, y1 - a.rect[1]);
      if (a.subtype === 'Link' && (a.url || a.dest)) {
        const ln = el('a', { class: 'link', href: '#', title: a.url ? a.url : 'Go to linked page', 'aria-label': a.url ? `Open ${a.url}` : 'Go to linked page' });
        pos(ln, r); ln.addEventListener('click', (e) => { e.preventDefault(); followLink(p, a); });
        pe.layer.append(ln);
      } else if (a.subtype === 'Widget' && a.fieldName && !a.hidden) {
        const inp = fieldInput(p, a, r);
        if (inp) { pos(inp, r); pe.layer.append(inp); }
      }
    }
    blocks.forEach((bl, idx) => {
      const d = pushOf(p, bl.top);
      const r = screenRect(p, bl.u, bl.top + d, bl.u + bl.w, bl.bot + d);
      const tx = el('div', { class: 'tx', 'data-blk': idx, title: 'Click to edit this paragraph' });
      pos(tx, r); pe.layer.append(tx);
    });
    paintHits(p);
  }

  // ---------- text content (search and edit text) ----------
  const textCache = new Map();
  function familyOf(name) {
    if (/mono|courier/i.test(name || '')) return 'cour';
    if (/sans/i.test(name || '')) return 'helv';
    if (/serif|times|roman|georgia|garamond|minion|cambria|book/i.test(name || '')) return 'times';
    return 'helv';
  }
  async function textItems(p) {
    if (p.blank) return [];
    const ck = p.docId + ':' + p.src;
    if (textCache.has(ck)) return textCache.get(ck);
    const prom = (async () => {
      const page = await S.docs.get(p.docId).pdf.getPage(p.src + 1);
      const tc = await page.getTextContent();
      const [x0, , , y1] = p.view;
      const out = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const [a, b, c, d, e, f] = it.transform;
        if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0 || d <= 0) continue; // horizontal text only
        const size = it.height || Math.hypot(c, d);
        if (!size) continue;
        const style = tc.styles[it.fontName] || {};
        out.push({ str: it.str, u: e - x0, vb: y1 - f, size, w: it.width, font: familyOf(style.fontFamily + ' ' + (it.fontName || '')) });
      }
      if (p.ocr) for (const w of p.ocr) out.push({ str: w.t, u: w.x, vb: w.y + w.h * 0.85, size: w.lh || w.h, w: w.w, font: 'helv' });
      return out;
    })();
    textCache.set(ck, prom);
    return prom;
  }

  // ---------- paragraphs (Edit text) ----------
  const blockCache = new Map();
  const r1 = (v) => Math.round(v * 10) / 10;
  const r2 = (v) => Math.round(v * 100) / 100;
  async function textBlocks(p) {
    if (p.blank) return [];
    const ck = p.docId + ':' + p.src;
    if (blockCache.has(ck)) return blockCache.get(ck);
    const prom = (async () => {
      const page = await S.docs.get(p.docId).pdf.getPage(p.src + 1);
      const tc = await page.getTextContent();
      try { await page.getOperatorList(); } catch { /* font names are optional */ }
      const [x0, , , y1] = p.view;
      const items = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const [a, b, c, d, e, f] = it.transform;
        if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0 || d <= 0) continue;
        const size = it.height || Math.hypot(c, d); if (!size) continue;
        let fname = '';
        try { if (page.commonObjs.has(it.fontName)) { const fo = page.commonObjs.get(it.fontName); fname = (fo && (fo.name || '')) || ''; } } catch { /* ignore */ }
        const style = tc.styles[it.fontName] || {};
        items.push({ str: it.str, u: e - x0, vb: y1 - f, size, w: it.width, font: familyOf(fname + ' ' + (style.fontFamily || '')), bold: /bold|black|heavy|semibold|demi/i.test(fname), italic: /italic|oblique/i.test(fname) });
      }
      if (p.ocr) for (const w of p.ocr) items.push({ str: w.t, u: w.x, vb: w.y + w.h * 0.85, size: w.lh || w.h, w: w.w, font: 'helv', bold: false, italic: false });
      items.sort((a, b) => a.vb - b.vb || a.u - b.u);
      // Lines, keeping the position of every character so edits can leave untouched text where it is.
      const lines = [];
      const pushChars = (Ln, it) => {
        const n = [...it.str].length; const cw = n ? it.w / n : 0; let k = 0;
        for (const ch of it.str) { Ln.chars.push({ ch, x: it.u + (k + 0.5) * cw }); k++; }
      };
      for (const it of items) {
        const Ln = lines.find((l) => Math.abs(l.vb - it.vb) < Math.min(l.size, it.size) * 0.35 && Math.abs(l.size - it.size) < l.size * 0.25 && it.u >= l.u + l.w - l.size * 0.3 && it.u - (l.u + l.w) < l.size * 3);
        if (Ln) {
          const gap = it.u - (Ln.u + Ln.w);
          if (gap > Ln.size * 0.12 && !/\s$/.test(Ln.str) && !/^\s/.test(it.str)) { Ln.str += ' '; Ln.chars.push({ ch: ' ', x: Ln.u + Ln.w + gap / 2 }); }
          Ln.str += it.str; pushChars(Ln, it); Ln.items.push(it);
          Ln.w = it.u + it.w - Ln.u;
        } else {
          const Ln2 = { u: it.u, vb: it.vb, w: it.w, size: it.size, str: it.str, font: it.font, bold: it.bold, italic: it.italic, chars: [], items: [] };
          pushChars(Ln2, it); Ln2.items.push(it); lines.push(Ln2);
        }
      }
      lines.sort((a, b) => a.vb - b.vb || a.u - b.u);
      // List markers ("-", "•", "1.", "a)") are not part of the paragraph: they stay as they are.
      const MARK = /^(\s*)([-–—•◦▪●○■·*➢►▸✓]|\(?\d{1,3}(?:\.\d{1,3})*[.)]|\(?(?:[ivxlcdm]{1,7}|[IVXLCDM]{1,7})[.)]|\(?[a-zA-Z][.)])(\s+)(?=\S)/;
      for (const Ln of lines) {
        Ln.allBold = Ln.items.every((it) => it.bold); Ln.allItalic = Ln.items.every((it) => it.italic);
        const m = MARK.exec(Ln.str);
        if (m) {
          const k = m[0].length; const cs = Ln.chars;
          if (cs[k] && cs[k - m[3].length - 1] && cs[k].x - cs[k - m[3].length - 1].x > Ln.size * 0.5) {
            const cut = cs[k].x - Ln.size * 0.25; const right = Ln.u + Ln.w;
            Ln.chars = cs.slice(k); Ln.str = Ln.str.slice(k); Ln.u = cut; Ln.w = right - cut; Ln.marker = true;
          }
        }
      }
      const blocks = [];
      for (const Ln of lines) {
        const B = blocks.find((bk) => {
          const last = bk.lines[bk.lines.length - 1]; const gap = Ln.vb - last.vb;
          return !Ln.marker && gap > last.size * 0.5 && gap < last.size * 1.9 && Math.abs(Ln.size - last.size) < last.size * 0.15 &&
            Ln.font === last.font && Ln.allBold === last.allBold && Ln.u - last.u <= last.size * 0.6 &&
            Ln.u < bk.u + bk.w && Ln.u + Ln.w > bk.u && Math.abs(Ln.u - bk.u) < last.size * 4;
        });
        if (B) { const right = Math.max(B.u + B.w, Ln.u + Ln.w); B.u = Math.min(B.u, Ln.u); B.w = right - B.u; B.lines.push(Ln); }
        else blocks.push({ lines: [Ln], u: Ln.u, w: Ln.w });
      }
      return blocks.map((bk) => {
        const ls = bk.lines; const sizes = ls.map((l) => l.size).sort((a, b) => a - b); const size = sizes[Math.floor(sizes.length / 2)];
        const spread = (arr, f) => { const v = arr.map(f); return v.length ? Math.max(...v) - Math.min(...v) : 0; };
        let align = 'left';
        if (ls.length >= 3 && spread(ls.slice(0, -1), (l) => l.u + l.w) < size * 0.4 && spread(ls.slice(1), (l) => l.u) < size * 0.6) align = 'justify';
        else if (ls.length > 1 && spread(ls, (l) => l.u) > size * 0.5) {
          if (spread(ls, (l) => l.u + l.w / 2) < size * 0.5) align = 'center';
          else if (spread(ls, (l) => l.u + l.w) < size * 0.5) align = 'right';
        }
        // Paragraph text plus, for every character, the line it came from and its x position.
        let text = ''; const pos = []; const offsets = [];
        ls.forEach((l, i) => {
          let cs = l.chars; let a = 0, z = cs.length;
          while (a < z && /\s/.test(cs[a].ch)) a++;
          while (z > a && /\s/.test(cs[z - 1].ch)) z--;
          cs = cs.slice(a, z);
          if (i) { if (/-$/.test(text)) { /* hyphen at line end: join directly */ } else { text += ' '; pos.push(null); } }
          offsets.push(text.length);
          for (const c of cs) { text += c.ch; pos.push([i, Math.round(c.x * 100) / 100]); }
        });
        return {
          u: bk.u, w: bk.w, top: ls[0].vb - ls[0].size * 0.9, bot: ls[ls.length - 1].vb + ls[ls.length - 1].size * 0.25,
          size, leading: ls.length > 1 ? (ls[ls.length - 1].vb - ls[0].vb) / (ls.length - 1) : size * 1.2,
          firstBase: ls[0].vb, text, lines: ls.length, font: ls[0].font, bold: ls.every((l) => l.allBold), italic: ls.every((l) => l.allItalic), align,
          geo: ls.map((l) => ({ u: r2(l.u), vb: r2(l.vb), w: r2(l.w), size: r2(l.size) })), pos, offsets,
        };
      });
    })();
    blockCache.set(ck, prom);
    return prom;
  }
  // The darkest pixel inside the paragraph on the rendered page is its text colour.
  function sampleColor(p, bl) {
    const pe = pageEls.get(p.key); if (!pe || !pe.base.width) return null;
    const m = mat(p, S.zoom * dpr());
    const A = apply(m, bl.u, bl.top), B = apply(m, bl.u + bl.w, bl.bot);
    const x = Math.max(0, Math.floor(Math.min(A[0], B[0]))), y = Math.max(0, Math.floor(Math.min(A[1], B[1])));
    const w = Math.min(pe.base.width - x, Math.ceil(Math.abs(A[0] - B[0]))), h = Math.min(pe.base.height - y, Math.ceil(Math.abs(A[1] - B[1])));
    if (w < 1 || h < 1) return null;
    let d; try { d = pe.base.getContext('2d').getImageData(x, y, w, h).data; } catch { return null; }
    let best = 766, col = null;
    for (let i = 0; i < d.length; i += 8) { const s = d[i] + d[i + 1] + d[i + 2]; if (s < best) { best = s; col = [d[i], d[i + 1], d[i + 2]]; } }
    if (!col || best > 600) return null;
    if (best < 90) return '#000000';
    return '#' + col.map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  const famOf = (a) => (a.font === 'orig' ? a.fallbackFont || 'helv' : a.font);
  const stdOf = (a) => window.BubbyTextEdit.stdName(famOf(a), !!a.bold, !!a.italic);
  const cssFont = (a, scale = 1) => `${a.italic ? 'italic ' : ''}${a.bold ? 'bold ' : ''}${a.size * scale}px ${FONTS[famOf(a)] || FONTS.helv}`;
  function textWidth(a, str) {
    const f = window.BubbyTextEdit.stdFontSync(stdOf(a));
    if (f) { try { return f.widthOfTextAtSize(str, a.size); } catch { /* fall back to the canvas */ } }
    mctx.font = cssFont(a); return mctx.measureText(str).width;
  }
  // Word wrap used both on screen and when saving, so the saved paragraph breaks where you saw it break.
  function wrapLines(a, width = (s) => textWidth(a, s)) {
    const out = [];
    for (const para of String(a.text).split('\n')) {
      const words = para.split(/ +/); let line = '';
      for (let w of words) {
        const trial = line ? line + ' ' + w : w;
        if (!line || width(trial) <= a.w) { line = trial; continue; }
        out.push(line); line = '';
        while (w.length > 1 && width(w) > a.w) {
          let k = w.length - 1; while (k > 1 && width(w.slice(0, k)) > a.w) k--;
          out.push(w.slice(0, k)); w = w.slice(k);
        }
        line = w;
      }
      out.push(line);
    }
    return out;
  }
  async function editBlock(p, idx) {
    const bl = (await textBlocks(p))[idx]; if (!bl) return null;
    let ocrText = null;
    if (unreadable(bl.text) && !p.annots.some((x) => x.type === 'textedit' && x.region && Math.abs(x.region.x - (bl.u - 1)) < 0.5 && Math.abs(x.region.y - (bl.top - 1)) < 0.5)) {
      const go = await ask('Read this paragraph from the page?',
        "This PDF stores the letters of this paragraph in a way that can't be read back (its font has no character map). BubbyPDF can read them from the page image instead. The edited paragraph will then use a similar standard font.",
        [{ label: 'Cancel', value: null }, { label: 'Read from the page', value: 'ocr', primary: true }]);
      if (!go) return null;
      busy(true);
      try { ocrText = (await window.BubbyTools.readRegion(p, { x: bl.u - 2, y: bl.top - 2, w: bl.w + 4, h: bl.bot - bl.top + 4 })).text; }
      catch (e) { toast('Could not read the paragraph: ' + (e.message || e), 'error'); return null; } finally { busy(false); }
      if (!ocrText) { toast('No text could be read from this paragraph.', 'error'); return null; }
    }
    const ex = p.annots.find((a) => a.type === 'textedit' && a.region && Math.abs(a.region.x - (bl.u - 1)) < 0.5 && Math.abs(a.region.y - (bl.top - 1)) < 0.5);
    if (ex) { S.sel = ex.id; startEdit(p, ex, { selectAll: false }); renderToolOpts(); return ex; }
    snap();
    const blocksAll = await textBlocks(p);
    const colRight = Math.max(bl.u + bl.w, ...blocksAll.filter((b) => b.lines > 1 && b.u < bl.u + bl.w && b.u + b.w > bl.u - bl.size).map((b) => b.u + b.w));
    const a = {
      id: nid(), type: 'textedit', colRight: r1(colRight), region: { x: bl.u - 1, y: bl.top - 1, w: bl.w + 2, h: bl.bot - bl.top + 2 },
      x: bl.u, y: bl.firstBase - bl.size * 0.8, w: r1(bl.lines === 1 && bl.align === 'left' ? Math.max(bl.w * 1.02 + 2, colRight - bl.u) : bl.w * 1.02 + 2), size: r1(bl.size), leading: r1(bl.leading),
      font: 'orig', fallbackFont: bl.font, bold: bl.bold, italic: bl.italic, align: bl.align, color: sampleColor(p, bl) || '#000000', text: bl.text,
      origText: ocrText ? null : bl.text, origSize: r1(bl.size), origBold: bl.bold, origItalic: bl.italic,
      ...(ocrText ? { text: ocrText, font: bl.font, restyled: true } : {}),
      geo: bl.geo, pos: bl.pos, offsets: bl.offsets,
    };
    p.annots.push(a); S.sel = a.id; markDirty(); scheduleThumb(p);
    startEdit(p, a, { fromEdit: true });
    renderToolOpts();
    return a;
  }

  // ---------- forms ----------
  function fieldVals(docId) { let f = S.fields.get(docId); if (!f) { f = {}; S.fields.set(docId, f); } return f; }
  function fieldInput(p, a, r) {
    const vals = fieldVals(p.docId); const name = a.fieldName;
    const has = Object.prototype.hasOwnProperty.call(vals, name);
    const fid = p.docId + '|' + name;
    const label = a.alternativeText || name;
    if (a.fieldType === 'Tx') {
      const multi = !!a.multiLine;
      const inp = el(multi ? 'textarea' : 'input', { class: 'field', 'data-field': fid, 'data-doc': p.docId, 'data-name': name, 'aria-label': label, spellcheck: 'false' });
      if (!multi) inp.type = a.password ? 'password' : 'text';
      inp.value = has ? vals[name] : (a.fieldValue == null ? '' : String(a.fieldValue));
      if (a.readOnly) inp.readOnly = true;
      if (a.maxLen) inp.maxLength = a.maxLen;
      const chosen = (S.fsize.get(p.docId) || {})[name];
      const fs = chosen ? chosen * S.zoom : a.textSize ? a.textSize * S.zoom : Math.min(r.height * 0.68, 12 * S.zoom);
      inp.style.fontSize = Math.max(7, fs) + 'px';
      if (a.textAlignment === 1) inp.style.textAlign = 'center';
      if (a.textAlignment === 2) inp.style.textAlign = 'right';
      inp.addEventListener('change', () => setField(p.docId, name, inp.value, inp));
      return inp;
    }
    if (a.fieldType === 'Btn' && a.checkBox) {
      const inp = el('input', { type: 'checkbox', class: 'field check', 'data-field': fid, 'aria-label': label });
      inp.checked = has ? !!vals[name] : !!(a.fieldValue && a.fieldValue !== 'Off');
      if (a.readOnly) inp.disabled = true;
      inp.addEventListener('change', () => setField(p.docId, name, inp.checked, inp));
      return inp;
    }
    if (a.fieldType === 'Btn' && a.radioButton) {
      const inp = el('input', { type: 'radio', class: 'field radio', name: fid, 'data-field': fid, 'data-on': a.buttonValue, 'aria-label': `${label}: ${a.buttonValue}` });
      inp.checked = (has ? vals[name] : a.fieldValue) === a.buttonValue;
      if (a.readOnly) inp.disabled = true;
      inp.addEventListener('change', () => { if (inp.checked) setField(p.docId, name, a.buttonValue, inp); });
      return inp;
    }
    if (a.fieldType === 'Ch' && a.options) {
      const sel = el('select', { class: 'field', 'data-field': fid, 'aria-label': label });
      sel.append(el('option', { value: '' }, ''));
      for (const o of a.options) sel.append(el('option', { value: o.exportValue }, o.displayValue));
      const cur = has ? vals[name] : (Array.isArray(a.fieldValue) ? a.fieldValue[0] : a.fieldValue);
      sel.value = cur == null ? '' : cur;
      sel.style.fontSize = Math.max(7, Math.min(r.height * 0.6, 12 * S.zoom)) + 'px';
      if (a.readOnly) sel.disabled = true;
      sel.addEventListener('change', () => setField(p.docId, name, sel.value, sel));
      return sel;
    }
    return null;
  }
  function setField(docId, name, value, src) {
    snap();
    fieldVals(docId)[name] = value;
    const fid = docId + '|' + name;
    document.querySelectorAll(`[data-field="${CSS.escape(fid)}"]`).forEach((n) => {
      if (n === src) return;
      if (n.type === 'checkbox') n.checked = !!value;
      else if (n.type === 'radio') n.checked = n.dataset.on === value;
      else n.value = value;
    });
    markDirty();
  }

  // ---------- links, navigation, history ----------
  async function followLink(p, a) {
    if (a.url) {
      if (/^(https?:|mailto:)/i.test(a.url)) bench.openExternal(a.url);
      return;
    }
    const doc = S.docs.get(p.docId);
    try {
      let dest = a.dest;
      if (typeof dest === 'string') dest = await doc.pdf.getDestination(dest);
      if (!Array.isArray(dest)) return;
      const idx = typeof dest[0] === 'object' ? await doc.pdf.getPageIndex(dest[0]) : dest[0];
      const i = S.pages.findIndex((x) => x.docId === p.docId && x.src === idx);
      if (i >= 0) { pushHistory(); scrollToPage(i); } else toast('That page is not in this document anymore.');
    } catch { toast('That link points to a page that could not be found.'); }
  }
  function pushHistory() {
    S.history.push({ key: S.pages[S.current] && S.pages[S.current].key, top: viewer.scrollTop });
    if (S.history.length > 50) S.history.shift();
    $('#btnBack').disabled = false;
  }
  function goBack() {
    const h = S.history.pop();
    $('#btnBack').disabled = !S.history.length;
    if (!h) return;
    viewer.scrollTop = h.top;
  }
  function scrollToPage(i, smooth = true) {
    const p = S.pages[i]; if (!p) return;
    const pe = pageEls.get(p.key); if (!pe) return;
    viewer.scrollTo({ top: pe.root.offsetTop - 56, behavior: smooth ? 'smooth' : 'auto' });
    S.current = i; updatePageIndicator();
  }
  function updateCurrent() {
    const mid = viewer.scrollTop + viewer.clientHeight * 0.35;
    let cur = 0;
    for (let i = 0; i < S.pages.length; i++) {
      const pe = pageEls.get(S.pages[i].key); if (!pe) continue;
      if (pe.root.offsetTop <= mid) cur = i; else break;
    }
    if (cur !== S.current) { S.current = cur; updatePageIndicator(); }
  }
  function updatePageIndicator() {
    const inp = $('#pageInput'); if (document.activeElement !== inp) inp.value = String(S.current + 1);
    document.querySelectorAll('.thumb.current').forEach((t) => t.classList.remove('current'));
    const p = S.pages[S.current];
    if (p) { const t = document.querySelector(`.thumb[data-key="${p.key}"]`); if (t) t.classList.add('current'); }
  }
  viewer.addEventListener('scroll', () => requestAnimationFrame(updateCurrent), { passive: true });
  $('#pageInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const n = parseInt(e.target.value, 10);
      if (n >= 1 && n <= S.pages.length) { pushHistory(); scrollToPage(n - 1); }
      e.target.value = String(S.current + 1); e.target.blur();
    }
  });

  // ---------- zoom ----------
  function setZoom(z) {
    z = clamp(Math.round(z * 100) / 100, 0.25, 4);
    if (z === S.zoom) return;
    commitEdit();
    S.zoom = z;
    $('#btnZoomFit').textContent = Math.round(z * 100) + '%';
    layoutPages();
  }
  function fitWidth() {
    const maxW = Math.max(...S.pages.map((p) => dispSize(p, 1)[0]), 1);
    const avail = viewer.clientWidth - 64;
    S.zoom = 0; // force relayout
    setZoom(avail < 200 ? 1 : clamp(avail / maxW, 0.25, 2));
  }
  $('#btnZoomIn').onclick = () => setZoom(S.zoom * 1.2);
  $('#btnZoomOut').onclick = () => setZoom(S.zoom / 1.2);
  $('#btnZoomFit').onclick = fitWidth;
  viewer.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(S.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  // ---------- undo / redo ----------
  const snapshotStr = () => JSON.stringify({ pages: S.pages, fields: [...S.fields], fsize: [...S.fsize], marks: S.marks, protect: S.protect || null });
  function pushUndo(s) { S.undo.push(s); if (S.undo.length > 150) S.undo.shift(); S.redo.length = 0; updateUndoButtons(); }
  function snap() { pushUndo(snapshotStr()); }
  function restore(str) {
    const o = JSON.parse(str);
    S.pages = o.pages; S.fields = new Map(o.fields); S.fsize = new Map(o.fsize || []); S.marks = o.marks || null; S.protect = o.protect || null; S.sel = null;
    S.selPages = new Set([...S.selPages].filter((k) => S.pages.some((p) => p.key === k)));
    S.current = Math.min(S.current, S.pages.length - 1);
    layoutPages(); renderThumbs(); renderToolOpts();
    for (const q of S.pages) schedulePreview(q);
    syncForeignAll();
  }
  function undo() { commitEdit(); if (!S.undo.length) return; S.redo.push(snapshotStr()); restore(S.undo.pop()); markDirty(); updateUndoButtons(); }
  function redo() { commitEdit(); if (!S.redo.length) return; S.undo.push(snapshotStr()); restore(S.redo.pop()); markDirty(); updateUndoButtons(); }
  function updateUndoButtons() { $('#btnUndo').disabled = !S.undo.length; $('#btnRedo').disabled = !S.redo.length; }
  $('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo; $('#btnBack').onclick = goBack;

  function markDirty() { S.dirty = true; bench.setDirty(true); updateTitle(); }
  function changed(p) { markDirty(); drawOverlay(p); scheduleThumb(p); schedulePreview(p); renderMarkups(); }
  function updateTitle() {
    const sb = document.getElementById('btnSave'); if (sb) sb.disabled = !!S.filePath && !S.dirty;
    const n = $('#docName'); n.textContent = '';
    if (S.fileName) {
      if (S.dirty) n.append(el('span', { class: 'dot', title: 'Unsaved changes' }, '● '));
      n.append(S.fileName);
      document.title = `${S.dirty ? '● ' : ''}${S.fileName} - BubbyPDF`;
    } else document.title = 'BubbyPDF';
  }

  // ---------- tools ----------
  function setTool(t) {
    commitEdit();
    if (t === 'sign') { openSignature(); return; }
    if (t === 'image') { pickImage(); return; }
    S.tool = t;
    if (t !== 'place') S.placing = null;
    document.body.className = document.body.className.replace(/\btool-\S+/g, '').trim() + ' tool-' + t;
    document.querySelectorAll('.tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t || (t === 'place' && b.dataset.tool === S.placeFrom))));
    if (t !== 'select') { S.sel = null; redrawAll(); }
    renderToolOpts();
  }
  document.querySelectorAll('.tool').forEach((b) => { b.addEventListener('click', () => setTool(b.dataset.tool)); });
  // Clicking a formatting button keeps the paragraph editor open.
  $('#toolopts').addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  window.BubbyTextEdit.loadAllStd().then(() => redrawAll()).catch(() => {});

  const INK = ['#111111', '#1F4FD1', '#C62828', '#C2410C', '#7A3FC2'];
  const HL = ['#FFD84D', '#7EE08A', '#FF9AC1', '#8CCBFF'];
  function swatchRow(colors, cur, onPick, label) {
    const row = el('div', { class: 'swatches', role: 'radiogroup', 'aria-label': label });
    for (const c of colors) {
      const b = el('button', { class: 'swatch', role: 'radio', 'aria-checked': String(c.toLowerCase() === (cur || '').toLowerCase()), 'aria-label': c, title: c });
      b.style.background = c;
      b.onclick = () => onPick(c);
      row.append(b);
    }
    return row;
  }
  function sizeSelect(values, cur, onPick, label, unit = 'pt') {
    const s = el('select', { 'aria-label': label, title: label });
    for (const v of values) s.append(el('option', { value: v }, `${v} ${unit}`));
    if (!values.includes(cur)) s.append(el('option', { value: cur }, `${Math.round(cur * 10) / 10} ${unit}`));
    s.value = String(cur);
    s.onchange = () => onPick(parseFloat(s.value));
    return s;
  }
  function selectedAnnot() {
    if (!S.sel) return null;
    for (const p of S.pages) { const a = p.annots.find((x) => x.id === S.sel); if (a) return { p, a }; }
    return null;
  }
  function editSel(fn) { const s = selectedAnnot(); if (!s) return; snap(); fn(s.a); changed(s.p); renderToolOpts(); }

  function setFieldSize(docId, name, v) {
    snap();
    const m = { ...(S.fsize.get(docId) || {}) };
    if (v) m[name] = v; else delete m[name];
    S.fsize.set(docId, m); markDirty();
    for (const pe of pageEls.values()) pe.layerKey = null;
    for (const q of S.pages) if (q.docId === docId) { const pe = pageEls.get(q.key); if (pe && pe.visible) S.docs.get(docId).pdf.getPage(q.src + 1).then((pg) => buildLayer(q, pg)); }
    renderToolOpts();
  }
  function renderToolOpts() {
    const box = $('#toolopts'); box.textContent = '';
    const t = S.tool; const st = S.style; const sel = t === 'select' || t === 'edittext' ? selectedAnnot() : null;
    const sep = () => el('span', { class: 'opt-sep' });
    const add = (...n) => box.append(...n);
    const kind = sel ? sel.a.type : t;
    if (t === 'select' && !sel && S.fieldFocus) {
      const ff = S.fieldFocus; const cur = (S.fsize.get(ff.docId) || {})[ff.name] || '';
      const s2 = el('select', { 'aria-label': 'Form text size', title: 'Text size in this field' });
      s2.append(el('option', { value: '' }, 'Auto'));
      for (const v of [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24]) s2.append(el('option', { value: v }, `${v} pt`));
      s2.value = String(cur);
      s2.onchange = () => setFieldSize(ff.docId, ff.name, s2.value ? +s2.value : null);
      box.append(el('span', { class: 'label' }, 'Form field text size'), s2);
      box.hidden = false; return;
    }
    if (kind === 'foreign') box.append(el('span', { class: 'label' }, `${(sel.a.subtype || 'Markup').replace(/([a-z])([A-Z])/g, '$1 $2')} made in another app`));
    if (t === 'place') add(el('span', { class: 'label' }, 'Click on the page where it should go. Esc to cancel.'));
    else if (kind === 'textedit') {
      const a = sel.a;
      const upd = (fn) => {
        editSel((x) => { fn(x); x.restyled = true; });
        const ed = S.editor; if (ed && ed.a.id === a.id && ed.ta.restyle) { ed.ta.restyle(); ed.ta.focus(); }
      };
      add(swatchRow([...new Set([a.color.toUpperCase(), ...INK])], a.color.toUpperCase(), (c) => upd((x) => { x.color = c; }), 'Text color'));
      add(sep(), sizeSelect([8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48], a.size, (v) => upd((x) => { x.leading = r1(x.leading * v / x.size); x.size = v; }), 'Text size'));
      const fsel = el('select', { 'aria-label': 'Font', title: 'Font' });
      [['orig', 'Original font'], ['helv', 'Sans'], ['times', 'Serif'], ['cour', 'Mono']].forEach(([v, l]) => { if (v !== 'orig' || a.origText != null) fsel.append(el('option', { value: v }, l)); });
      fsel.value = a.font; fsel.onchange = () => upd((x) => { x.font = fsel.value; });
      add(fsel);
      const tog = (key, label, glyph) => {
        const b = el('button', { class: 'btn ghost sm', 'aria-pressed': String(!!a[key]), 'aria-label': label, title: label }, glyph);
        b.style.fontWeight = key === 'bold' ? '700' : '500'; if (key === 'italic') b.style.fontStyle = 'italic';
        b.onclick = () => upd((x) => { x[key] = !x[key]; });
        return b;
      };
      add(el('div', { class: 'seg' }, tog('bold', 'Bold', 'B'), tog('italic', 'Italic', 'I')));
      const al = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Alignment' });
      [['left', 'alignl', 'Align left'], ['center', 'alignc', 'Center'], ['right', 'alignr', 'Align right'], ['justify', 'alignj', 'Justify']].forEach(([v, ic, l]) => {
        const b = el('button', { class: 'btn ghost sm icon', role: 'radio', 'aria-checked': String(a.align === v), 'aria-pressed': String(a.align === v), 'aria-label': l, title: l, html: window.icon(ic, 18) });
        b.onclick = () => upd((x) => { x.align = v; });
        al.append(b);
      });
      add(sep(), al);
    } else if (kind === 'text' || kind === 'edittext') {
      const a = sel && sel.a;
      if (t === 'edittext') { add(el('span', { class: 'label' }, 'Click a paragraph to edit it. Lines rewrap as you type.')); box.hidden = false; return; }
      add(swatchRow(INK, a ? a.color : st.color, (c) => { st.color = c; if (a) editSel((x) => { x.color = c; }); else renderToolOpts(); }, 'Text color'));
      add(sep(), sizeSelect([8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48], a ? a.size : st.size, (v) => { st.size = v; if (a) editSel((x) => { x.size = v; }); }, 'Text size'));
      const fsel = el('select', { 'aria-label': 'Font', title: 'Font' });
      [['helv', 'Sans'], ['times', 'Serif'], ['cour', 'Mono']].forEach(([v, l]) => fsel.append(el('option', { value: v }, l)));
      fsel.value = a ? a.font : st.font;
      fsel.onchange = () => { st.font = fsel.value; if (a) editSel((x) => { x.font = fsel.value; }); };
      add(fsel);
    } else if (kind === 'highlight') {
      const a = sel && sel.a;
      add(swatchRow(HL, a ? a.color : st.hl, (c) => { st.hl = c; if (a) editSel((x) => { x.color = c; }); else renderToolOpts(); }, 'Highlight color'));
      if (!a) add(sep(), el('span', { class: 'label' }, 'Drag over the text to highlight.'));
    } else if (kind === 'draw' || kind === 'ink' || kind === 'rect') {
      const a = sel && sel.a;
      add(swatchRow(INK, a ? a.color : st.color, (c) => { st.color = c; if (a) editSel((x) => { x.color = c; }); else renderToolOpts(); }, 'Line color'));
      add(sep(), sizeSelect([1, 2, 3, 4, 6, 8], a ? a.width : st.width, (v) => { st.width = v; if (a) editSel((x) => { x.width = v; }); }, 'Line width'));
    } else if (kind === 'check') {
      const a = sel && sel.a;
      const seg = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Mark' });
      [['check', '✓', 'Check'], ['cross', '✕', 'Cross'], ['dot', '●', 'Dot']].forEach(([v, g, l]) => {
        const cur = a ? a.mark : st.mark;
        const b = el('button', { class: 'btn ghost', role: 'radio', 'aria-checked': String(cur === v), 'aria-pressed': String(cur === v), 'aria-label': l, title: l }, g);
        b.onclick = () => { st.mark = v; if (a) editSel((x) => { x.mark = v; }); else renderToolOpts(); };
        seg.append(b);
      });
      add(seg, sep(), sizeSelect([8, 10, 12, 14, 18, 24, 32, 40], a ? a.size : st.check, (v) => { st.check = v; if (a) editSel((x) => { x.size = v; }); }, 'Mark size'));
      add(sep(), swatchRow(INK, a ? a.color : st.color, (c) => { st.color = c; if (a) editSel((x) => { x.color = c; }); else renderToolOpts(); }, 'Mark color'));
    } else if (kind === 'underline' || kind === 'strike') {
      const a = sel && sel.a;
      add(swatchRow(INK, a ? a.color : st.markup, (c) => { st.markup = c; if (a) editSel((x) => { x.color = c; }); else renderToolOpts(); }, 'Line color'));
      if (!a) add(sep(), el('span', { class: 'label' }, 'Drag across the text.'));
    } else if (kind === 'note') {
      const a = sel && sel.a;
      add(swatchRow(HL, a ? a.color : st.note, (c) => { st.note = c; if (a) editSel((x) => { x.color = c; }); else renderToolOpts(); }, 'Note color'));
      add(sep(), el('span', { class: 'label' }, a ? 'Click the note to read or edit it.' : 'Click where the note goes.'));
    } else if (kind === 'redact') {
      add(el('span', { class: 'label' }, 'Drag over anything to remove it. Redactions are applied when you save a copy, and redacted pages are saved as images.'));
    } else if (kind === 'whiteout') {
      if (!sel) add(el('span', { class: 'label' }, 'Drag to cover part of the page with white. This hides it visually only; the text underneath stays in the file.'));
    }
    if (sel) {
      const restore = sel.a.type === 'textedit';
      add(sep(), el('button', { class: 'btn ghost sm danger', onclick: () => { commitEdit(); deleteSelected(); }, title: restore ? 'Throw away this edit and keep the original paragraph' : 'Delete (Del)' }, restore ? 'Restore original' : 'Delete'));
    }
    box.hidden = !box.childNodes.length;
  }

  function deleteSelected() {
    const s = selectedAnnot(); if (!s) return;
    snap(); s.p.annots = s.p.annots.filter((a) => a !== s.a); S.sel = null; changed(s.p); renderToolOpts();
    if (s.a.type === 'foreign') scheduleForeign(s.p.docId);
    renderMarkups();
  }

  // ---------- pointer interaction on pages ----------
  function pagePoint(e, p, root) {
    const r = root.getBoundingClientRect();
    return invert(mat(p, S.zoom), e.clientX - r.left, e.clientY - r.top);
  }
  pagesEl.addEventListener('focusin', (e) => {
    const f = e.target.closest && e.target.closest('input.field[type="text"], textarea.field');
    if (f && f.dataset.doc) { S.fieldFocus = { docId: f.dataset.doc, name: f.dataset.name }; renderToolOpts(); }
  });
  pagesEl.addEventListener('pointerdown', (e) => {
    if (S.fieldFocus && !e.target.closest('.field')) { S.fieldFocus = null; renderToolOpts(); }
    if (e.button !== 0) return;
    const root = e.target.closest('.page'); if (!root) return;
    if (S.tool === 'select' && e.target.closest('.field, .link')) return;
    if (e.target.closest('.editor')) return;
    const p = pageByKey(root.dataset.key); if (!p) return;
    const [u, v] = pagePoint(e, p, root);
    commitEdit();
    const t = S.tool; const st = S.style;
    if (t === 'select') {
      const a = hit(p, u, v);
      if (a) {
        S.sel = a.id;
        S.drag = { kind: onHandle(a, u, v) ? 'resize' : 'move', key: p.key, p, root, id: a.id, u0: u, v0: v, orig: JSON.parse(JSON.stringify(a)), b0: bounds(a), moved: false };
        redrawAll(); renderToolOpts();
      } else {
        if (S.sel) { S.sel = null; redrawAll(); renderToolOpts(); }
        S.drag = { kind: 'pan', x0: e.clientX, y0: e.clientY, st: viewer.scrollTop, sl: viewer.scrollLeft, root };
        root.classList.add('panning');
      }
    } else if (t === 'text') {
      snap();
      const a = { id: nid(), type: 'text', x: u, y: v - st.size * 0.6, size: st.size, color: st.color, font: st.font, text: '' };
      p.annots.push(a); S.sel = a.id;
      startEdit(p, a, { isNew: true });
      e.preventDefault(); return;
    } else if (t === 'edittext') {
      const tx = e.target.closest('.tx');
      if (tx) { editBlock(p, +tx.dataset.blk); e.preventDefault(); }
      return;
    } else if (t === 'note') {
      snap();
      const a = { id: nid(), type: 'note', x: u - NOTE / 2, y: v - NOTE / 2, color: st.note, text: '' };
      p.annots.push(a); S.sel = a.id; changed(p);
      setTool('select'); S.sel = a.id; redrawAll();
      openNote(p, a, true);
      e.preventDefault(); return;
    } else if (t === 'highlight' || t === 'rect' || t === 'whiteout' || t === 'underline' || t === 'strike' || t === 'redact') {
      const color = t === 'highlight' ? st.hl : t === 'underline' || t === 'strike' ? st.markup : st.color;
      S.drag = { kind: 'box', key: p.key, p, root, u0: u, v0: v, preview: { id: '_p', type: t, x: u, y: v, w: 0, h: 0, color, width: st.width } };
    } else if (t === 'draw') {
      S.drag = { kind: 'ink', key: p.key, p, root, preview: { id: '_p', type: 'ink', pts: [[u, v]], color: st.color, width: st.width } };
    } else if (t === 'check') {
      snap();
      const s = st.check;
      const a = { id: nid(), type: 'check', mark: st.mark, x: u - s / 2, y: v - s / 2, size: s, color: st.color };
      p.annots.push(a); changed(p); e.preventDefault(); return;
    } else if (t === 'place' && S.placing) {
      const im = S.images.get(S.placing);
      const w = Math.min(S.placeWidth || 160, p.W * 0.8); const h = w * im.h0 / im.w0;
      snap();
      const a = { id: nid(), type: 'image', imageId: S.placing, x: u - w / 2, y: v - h / 2, w, h };
      p.annots.push(a); changed(p);
      setTool('select'); S.sel = a.id; redrawAll(); renderToolOpts();
      e.preventDefault(); return;
    }
    if (S.drag) { root.setPointerCapture(e.pointerId); e.preventDefault(); }
  });

  pagesEl.addEventListener('pointermove', (e) => {
    const d = S.drag;
    if (!d) {
      if (S.tool === 'select') {
        const root = e.target.closest('.page'); if (!root || e.target.closest('.field, .link')) return;
        const p = pageByKey(root.dataset.key); if (!p) return;
        const [u, v] = pagePoint(e, p, root); const a = hit(p, u, v);
        root.style.cursor = a ? (onHandle(a, u, v) ? 'nwse-resize' : 'move') : '';
        root.title = a && a.type === 'note' ? (a.text || 'Empty note. Click to write.') : '';
      }
      return;
    }
    if (d.kind === 'pan') { viewer.scrollTop = d.st - (e.clientY - d.y0); viewer.scrollLeft = d.sl - (e.clientX - d.x0); return; }
    const [u, v] = pagePoint(e, d.p, d.root);
    if (d.kind === 'move' || d.kind === 'resize') {
      const a = d.p.annots.find((x) => x.id === d.id); if (!a) return;
      if (a.type === 'foreign') return;
      if (!d.moved) { if (Math.hypot(u - d.u0, v - d.v0) * S.zoom < 3) return; snap(); d.moved = true; }
      const o = d.orig;
      if (d.kind === 'move') {
        shiftAnnot(a, o, u - d.u0, v - d.v0);
      } else {
        const b = d.b0;
        if (a.type === 'textedit') { a.w = Math.max(a.size * 2, u - a.x); a.resized = true; }
        else if (a.type === 'text') { const f = Math.max((u - b.x) / b.w, (v - b.y) / b.h); a.size = clamp(Math.round(o.size * f * 2) / 2, 4, 200); }
        else if (a.type === 'check') a.size = clamp(Math.max(u - a.x, v - a.y), 4, 200);
        else if (a.type === 'image') { a.w = Math.max(8, u - a.x); a.h = e.shiftKey ? Math.max(8, v - a.y) : a.w * o.h / o.w; }
        else { a.w = Math.max(2, u - a.x); a.h = Math.max(2, v - a.y); }
      }
      drawOverlay(d.p);
    } else if (d.kind === 'box') {
      Object.assign(d.preview, { x: Math.min(d.u0, u), y: Math.min(d.v0, v), w: Math.abs(u - d.u0), h: Math.abs(v - d.v0) });
      drawOverlay(d.p);
    } else if (d.kind === 'ink') {
      const last = d.preview.pts[d.preview.pts.length - 1];
      if (Math.hypot(u - last[0], v - last[1]) * S.zoom >= 1.5) { d.preview.pts.push([Math.round(u * 100) / 100, Math.round(v * 100) / 100]); drawOverlay(d.p); }
    }
  });

  function endDrag() {
    const d = S.drag; if (!d) return;
    S.drag = null;
    if (d.root) d.root.classList.remove('panning');
    if (d.kind === 'box') {
      const a = d.preview;
      const textual = a.type === 'highlight' || a.type === 'underline' || a.type === 'strike';
      const big = a.w * S.zoom > 3 && a.h * S.zoom > 3;
      if (textual && (big || a.w * S.zoom > 3)) {
        // Snap text markups to the words under the drag, the way a text selection works.
        snapRects(d.p, { x: a.x, y: a.y, w: a.w, h: Math.max(a.h, 1) }).then((rects) => {
          if (!rects.length && !big) { drawOverlay(d.p); return; }
          snap();
          if (rects.length) {
            a.rects = rects;
            const x1 = Math.min(...rects.map((r) => r.x)), y1 = Math.min(...rects.map((r) => r.y));
            const x2 = Math.max(...rects.map((r) => r.x + r.w)), y2 = Math.max(...rects.map((r) => r.y + r.h));
            Object.assign(a, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
          }
          a.id = nid(); d.p.annots.push(a); changed(d.p);
        });
      } else if (big) { snap(); a.id = nid(); d.p.annots.push(a); changed(d.p); }
      else drawOverlay(d.p);
    } else if (d.kind === 'ink') {
      snap(); const a = d.preview; a.id = nid(); d.p.annots.push(a); changed(d.p);
    } else if ((d.kind === 'move' || d.kind === 'resize') && d.moved) {
      changed(d.p); renderToolOpts();
    } else if (d.kind === 'move' && !d.moved) {
      const a = d.p.annots.find((x) => x.id === d.id);
      if (a && a.type === 'note') openNote(d.p, a, false);
    }
  }
  pagesEl.addEventListener('pointerup', endDrag);
  pagesEl.addEventListener('pointercancel', endDrag);
  pagesEl.addEventListener('dblclick', (e) => {
    if (S.tool !== 'select') return;
    const root = e.target.closest('.page'); if (!root || e.target.closest('.field, .link')) return;
    const p = pageByKey(root.dataset.key); const [u, v] = pagePoint(e, p, root);
    const a = hit(p, u, v);
    if (a && (a.type === 'text' || a.type === 'textedit')) startEdit(p, a, { selectAll: a.type === 'text' });
  });

  // Text markups: rectangles covering the characters of each text run under box b.
  async function snapRects(p, b) {
    const items = await textItems(p); const out = [];
    for (const it of items) {
      const top = it.vb - it.size * 0.85, bot = it.vb + it.size * 0.22;
      const ov = Math.min(bot, b.y + b.h) - Math.max(top, b.y);
      if (ov < (bot - top) * 0.3 && !(b.h <= 1 && b.y >= top && b.y <= bot)) continue;
      const x1 = Math.max(it.u, b.x), x2 = Math.min(it.u + it.w, b.x + b.w);
      if (x2 - x1 < 1) continue;
      const cw = it.str.length ? it.w / it.str.length : it.w;
      const c1 = Math.max(0, Math.floor((x1 - it.u) / cw + 0.15)), c2 = Math.min(it.str.length, Math.ceil((x2 - it.u) / cw - 0.15));
      if (c2 <= c1) continue;
      out.push({ x: it.u + c1 * cw, y: top, w: (c2 - c1) * cw, h: bot - top });
    }
    out.sort((r, q) => r.y - q.y || r.x - q.x);
    const merged = [];
    for (const r of out) {
      const m = merged[merged.length - 1];
      if (m && Math.abs(m.y - r.y) < r.h * 0.3 && r.x <= m.x + m.w + r.h * 0.6) {
        const x2 = Math.max(m.x + m.w, r.x + r.w); m.x = Math.min(m.x, r.x); m.w = x2 - m.x; m.h = Math.max(m.h, r.h);
      } else merged.push({ ...r });
    }
    return merged;
  }

  // Sticky notes: a small editor next to the icon.
  function openNote(p, a, isNew) {
    commitEdit(); closeNote();
    const pe = pageEls.get(p.key); if (!pe) return;
    const [x, y] = apply(mat(p, S.zoom), a.x + NOTE, a.y);
    const ta = el('textarea', { 'aria-label': 'Note text', placeholder: 'Write a note', rows: '4' });
    ta.value = a.text || '';
    const del = el('button', { class: 'btn ghost sm danger', type: 'button' }, 'Delete');
    const pop = el('div', { class: 'notepop', role: 'dialog', 'aria-label': 'Sticky note' }, ta, el('div', { class: 'notepop-actions' }, del, el('span', { class: 'muted' }, 'Ctrl+Enter to close')));
    pop.style.left = (x + 6) + 'px'; pop.style.top = y + 'px';
    pe.root.append(pop);
    const before = isNew ? null : snapshotStr();
    const finish = (remove) => {
      if (S.note !== state) return;
      S.note = null; pop.remove();
      const txt = ta.value.trim();
      if (remove || (!txt && isNew)) {
        if (isNew) { S.undo.pop(); updateUndoButtons(); } else if (before) pushUndo(before);
        p.annots = p.annots.filter((q) => q !== a); S.sel = null;
        if (isNew && !remove) { drawOverlay(p); renderToolOpts(); return; }
      } else if (txt !== (a.text || '')) { if (before) pushUndo(before); a.text = txt; }
      else if (!isNew) return;
      changed(p); renderToolOpts();
    };
    const state = { finish };
    S.note = state;
    ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); finish(false); } });
    del.addEventListener('pointerdown', (e) => e.preventDefault());
    del.addEventListener('click', () => finish(true));
    pop.addEventListener('pointerdown', (e) => e.stopPropagation());
    pop.addEventListener('focusout', (e) => { if (!pop.contains(e.relatedTarget)) finish(false); });
    requestAnimationFrame(() => ta.focus());
  }
  function closeNote() { if (S.note) S.note.finish(false); }

  // ---------- text editing ----------
  function startEdit(p, a, { isNew = false, selectAll = false, fromEdit = false } = {}) {
    const pe = pageEls.get(p.key); if (!pe) return;
    S.editing = a.id; drawOverlay(p);
    const ta = el('textarea', { class: 'editor', spellcheck: 'false', 'aria-label': 'Text', rows: '1' });
    ta.value = a.text;
    const [x, y] = apply(mat(p, S.zoom), a.x, a.y + pushOf(p, a.type === 'textedit' && a.region ? a.region.y : a.y));
    let fit;
    if (a.type === 'textedit') {
      ta.classList.add('para');
      const styleIt = () => Object.assign(ta.style, {
        left: x + 'px', top: (y - (a.leading - a.size) * S.zoom / 2 - a.size * S.zoom * 0.1) + 'px', width: a.w * S.zoom + 'px',
        font: cssFont(a, S.zoom), lineHeight: a.leading * S.zoom + 'px', color: a.color, textAlign: a.align || 'left',
      });
      styleIt(); ta.restyle = () => { styleIt(); fit(); };
      fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; };
    } else {
      Object.assign(ta.style, { left: x + 'px', top: (y - a.size * S.zoom * 0.1) + 'px', font: `${a.size * S.zoom}px ${FONTS[a.font] || FONTS.helv}`, color: a.color });
      fit = () => {
        const lines = ta.value.split('\n');
        const w = Math.max(...lines.map((l) => measure(l || ' ', a))) * S.zoom;
        ta.style.width = Math.max(24, w + a.size * S.zoom) + 'px';
        ta.style.height = (lines.length * a.size * 1.2 * S.zoom + 2) + 'px';
      };
    }
    fit();
    ta.addEventListener('input', fit);
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); commitEdit(); }
    });
    ta.addEventListener('blur', (e) => { if (e.relatedTarget && e.relatedTarget.classList && e.relatedTarget.classList.contains('ed-grip')) return; commitEdit(); });
    pe.root.append(ta); document.body.classList.add('editing-text');
    let grip = null;
    if (a.type === 'textedit') {
      // drag the edge to make the paragraph wider or narrower; it rewraps as you drag
      grip = el('div', { class: 'ed-grip', title: 'Drag to make the paragraph wider or narrower', 'aria-hidden': 'true' });
      const place = () => { grip.style.left = (parseFloat(ta.style.left) + ta.offsetWidth - 5) + 'px'; grip.style.top = ta.style.top; grip.style.height = ta.offsetHeight + 'px'; };
      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation(); grip.setPointerCapture(e.pointerId);
        const x0 = e.clientX, w0 = a.w; const before = snapshotStr(); let moved = false;
        const mv = (ev) => { moved = true; a.w = Math.max(a.size * 2, w0 + (ev.clientX - x0) / S.zoom); a.resized = true; ta.restyle(); place(); };
        const up = () => { grip.removeEventListener('pointermove', mv); grip.removeEventListener('pointerup', up); if (moved) { pushUndo(before); markDirty(); } ta.focus(); };
        grip.addEventListener('pointermove', mv); grip.addEventListener('pointerup', up);
      });
      pe.root.append(grip); ta.addEventListener('input', () => requestAnimationFrame(place)); requestAnimationFrame(place); ta.grip = grip;
    }
    if (a.type === 'textedit') ta.style.minHeight = (Math.max(1, (a.geo ? a.geo.length : 1)) * a.leading * S.zoom) + 'px';
    fit(); requestAnimationFrame(fit);
    S.editor = { ta, p, a, isNew, fromEdit, before: isNew || fromEdit ? null : snapshotStr() };
    requestAnimationFrame(() => { ta.focus(); if (selectAll) ta.select(); });
  }
  function commitEdit() {
    const ed = S.editor; if (!ed) return;
    S.editor = null; S.editing = null;
    const { ta, p, a, isNew, before } = ed;
    const txt = ta.value.replace(/\s+$/, '');
    ta.remove(); if (ta.grip) ta.grip.remove(); document.body.classList.remove('editing-text');
    if (!txt && a.type === 'textedit') {
      // An emptied paragraph stays as an edit: it means "delete this paragraph".
      if (a.text !== '') { if (before) pushUndo(before); a.text = ''; }
    } else if (!txt) {
      p.annots = p.annots.filter((x) => x !== a); S.sel = null;
      if (isNew) { S.undo.pop(); updateUndoButtons(); drawOverlay(p); renderToolOpts(); return; }
      if (before) pushUndo(before);
    } else if (txt !== a.text) {
      if (before) pushUndo(before);
      a.text = txt;
    } else if (!isNew) { drawOverlay(p); return; }
    changed(p); renderToolOpts();
  }
  async function editExistingText(p, idx) {
    const items = await textItems(p); const it = items[idx]; if (!it) return;
    snap();
    const cover = { id: nid(), type: 'whiteout', x: it.u - 1, y: it.vb - it.size * 0.9, w: it.w + 2, h: it.size * 1.16 };
    const a = { id: nid(), type: 'text', x: it.u, y: it.vb - it.size * 0.8, size: Math.round(it.size * 10) / 10, color: '#000000', font: it.font, text: it.str };
    p.annots.push(cover, a); S.sel = a.id;
    markDirty(); scheduleThumb(p);
    startEdit(p, a, { selectAll: true, fromEdit: true });
  }

  // ---------- page thumbnails and page tools ----------
  const thumbsEl = $('#thumbs');
  let thumbIO = null; const thumbTimers = new Map();
  function renderThumbs() {
    if (thumbIO) thumbIO.disconnect();
    thumbsEl.textContent = '';
    thumbIO = new IntersectionObserver((ens) => {
      for (const en of ens) if (en.isIntersecting) { const p = pageByKey(en.target.dataset.key); if (p) drawThumb(p, en.target.querySelector('canvas')); thumbIO.unobserve(en.target); }
    }, { root: thumbsEl, rootMargin: '400px 0px' });
    S.pages.forEach((p, i) => {
      const [w, h] = dispSize(p, 1); const c = el('canvas');
      c.style.height = Math.round(120 * h / w) + 'px';
      const t = el('div', { class: 'thumb' + (S.selPages.has(p.key) ? ' selected' : '') + (i === S.current ? ' current' : ''), draggable: 'true', 'data-key': p.key, role: 'option', 'aria-selected': String(S.selPages.has(p.key)), 'aria-label': `Page ${i + 1}` }, c, el('span', { class: 'num' }, String(i + 1)));
      thumbsEl.append(t); thumbIO.observe(t);
    });
    updatePageTools();
  }
  async function drawThumb(p, c, width = 120) {
    if (!c) return;
    const r = dpr(); const [w] = dispSize(p, 1); const s = width / w;
    const [cw, ch] = dispSize(p, s);
    const off = document.createElement('canvas'); off.width = Math.round(cw * r); off.height = Math.round(ch * r);
    const ctx = off.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, off.width, off.height);
    if (!p.blank) {
      const page = await S.docs.get(p.docId).pdf.getPage(p.src + 1);
      try { await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: s * r, rotation: dispRot(p) }) }).promise; } catch { return; }
    }
    ctx.setTransform(...mat(p, s * r));
    for (const a of p.annots) drawAnnot(ctx, a);
    c.width = off.width; c.height = off.height; c.getContext('2d').drawImage(off, 0, 0);
  }
  function scheduleThumb(p) {
    clearTimeout(thumbTimers.get(p.key));
    thumbTimers.set(p.key, setTimeout(() => {
      const t = thumbsEl.querySelector(`.thumb[data-key="${p.key}"] canvas`);
      if (t) drawThumb(p, t);
    }, 400));
  }
  function updatePageTools() {
    const n = S.selPages.size;
    $('#pgDelete').disabled = !n; $('#pgExtract').disabled = !n;
    $('#pgRotL').title = n ? `Rotate ${n} selected page${n > 1 ? 's' : ''} left` : 'Rotate all pages left';
    $('#pgRotR').title = n ? `Rotate ${n} selected page${n > 1 ? 's' : ''} right` : 'Rotate all pages right';
    $('#sideHint').textContent = n ? `${n} selected. Rotate, extract or delete them, or drag to move.` : 'Click a page to select it. Ctrl+click or Shift+click for more. Drag to reorder.';
    thumbsEl.querySelectorAll('.thumb').forEach((t) => {
      const on = S.selPages.has(t.dataset.key); t.classList.toggle('selected', on); t.setAttribute('aria-selected', String(on));
    });
  }
  thumbsEl.addEventListener('click', (e) => {
    const t = e.target.closest('.thumb'); if (!t) return;
    const key = t.dataset.key; const i = S.pages.findIndex((p) => p.key === key);
    if (e.shiftKey && S.anchorPage) {
      const j = S.pages.findIndex((p) => p.key === S.anchorPage);
      const [a, b] = [Math.min(i, j), Math.max(i, j)];
      if (!e.ctrlKey) S.selPages.clear();
      for (let k = a; k <= b; k++) S.selPages.add(S.pages[k].key);
    } else if (e.ctrlKey || e.metaKey) {
      S.selPages.has(key) ? S.selPages.delete(key) : S.selPages.add(key); S.anchorPage = key;
    } else {
      S.selPages = new Set([key]); S.anchorPage = key; scrollToPage(i);
    }
    updatePageTools();
  });
  thumbsEl.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); S.selPages = new Set(S.pages.map((p) => p.key)); updatePageTools(); }
    else if (e.key === 'Delete') { e.preventDefault(); deletePages(); }
    else if (e.key === 'Escape') { S.selPages.clear(); updatePageTools(); }
  });
  let dragKeys = null;
  thumbsEl.addEventListener('dragstart', (e) => {
    const t = e.target.closest('.thumb'); if (!t) return;
    dragKeys = S.selPages.has(t.dataset.key) ? S.pages.filter((p) => S.selPages.has(p.key)).map((p) => p.key) : [t.dataset.key];
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'pages');
  });
  const clearDrop = () => thumbsEl.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
  thumbsEl.addEventListener('dragover', (e) => {
    if (!dragKeys) return;
    const t = e.target.closest('.thumb'); if (!t) return;
    e.preventDefault(); clearDrop();
    const r = t.getBoundingClientRect();
    t.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  thumbsEl.addEventListener('dragleave', (e) => { if (!thumbsEl.contains(e.relatedTarget)) clearDrop(); });
  thumbsEl.addEventListener('drop', (e) => {
    if (!dragKeys) return;
    const t = e.target.closest('.thumb'); e.preventDefault();
    const before = t && t.classList.contains('drop-before'); const targetKey = t && t.dataset.key;
    clearDrop();
    if (!t || dragKeys.includes(targetKey)) { dragKeys = null; return; }
    snap();
    const moving = S.pages.filter((p) => dragKeys.includes(p.key));
    const rest = S.pages.filter((p) => !dragKeys.includes(p.key));
    let at = rest.findIndex((p) => p.key === targetKey); if (!before) at += 1;
    rest.splice(at, 0, ...moving);
    S.pages = rest; dragKeys = null;
    markDirty(); layoutPages(); renderThumbs();
  });
  thumbsEl.addEventListener('dragend', () => { dragKeys = null; clearDrop(); });

  function targetPages() { return S.selPages.size ? S.pages.filter((p) => S.selPages.has(p.key)) : S.pages; }
  function rotatePages(delta) {
    snap();
    for (const p of targetPages()) p.rot = (((p.rot + delta) % 360) + 360) % 360;
    markDirty(); layoutPages(); renderThumbs();
  }
  function deletePages() {
    if (!S.selPages.size) return;
    if (S.selPages.size >= S.pages.length) { toast('A PDF needs at least one page. Keep one page or open another file.', 'error'); return; }
    snap();
    const n = S.selPages.size;
    S.pages = S.pages.filter((p) => !S.selPages.has(p.key)); S.selPages.clear();
    S.current = Math.min(S.current, S.pages.length - 1);
    markDirty(); layoutPages(); renderThumbs();
    toast(`Deleted ${n} page${n > 1 ? 's' : ''}. Ctrl+Z brings ${n > 1 ? 'them' : 'it'} back.`);
  }
  function insertBlank() {
    const sel = S.pages.filter((p) => S.selPages.has(p.key));
    const ref = sel.length ? sel[sel.length - 1] : S.pages[S.current];
    const at = S.pages.indexOf(ref) + 1;
    const [w, h] = dispSize(ref, 1);
    snap();
    S.pages.splice(at, 0, { key: nid(), docId: null, src: -1, rot0: 0, rot: 0, W: w, H: h, view: [0, 0, w, h], blank: true, annots: [] });
    markDirty(); layoutPages(); renderThumbs(); scrollToPage(at);
  }
  async function extractPages() {
    const sel = S.pages.filter((p) => S.selPages.has(p.key)); if (!sel.length) return;
    commitEdit(); busy(true);
    try {
      const { bytes, replaced } = await buildPdf(sel);
      const nums = sel.map((p) => S.pages.indexOf(p) + 1);
      const label = nums.length === 1 ? `page ${nums[0]}` : `pages ${nums[0]}-${nums[nums.length - 1]}`;
      const r = await bench.savePdf({ suggestedName: `${baseName()} (${label}).pdf`, bytes });
      if (r) toast(`Saved ${r.name}` + (replaced ? `. ${replaced} unsupported character${replaced > 1 ? 's were' : ' was'} replaced with "?".` : ''));
    } catch (e) { toast(e.message || String(e), 'error'); } finally { busy(false); }
  }
  $('#pgRotL').onclick = () => rotatePages(-90);
  $('#pgRotR').onclick = () => rotatePages(90);
  $('#pgDelete').onclick = deletePages;
  $('#pgBlank').onclick = insertBlank;
  $('#pgExtract').onclick = extractPages;

  // ---------- search ----------
  const searchPanel = $('#searchPanel'), searchInput = $('#searchInput'), resultsEl = $('#results');
  function openSearch() { searchPanel.hidden = false; searchInput.focus(); searchInput.select(); }
  function closeSearch() { searchPanel.hidden = true; S.search = { q: '', results: [], active: -1 }; resultsEl.textContent = ''; $('#searchCount').textContent = ''; for (const p of S.pages) paintHits(p); }
  let searchTimer = null, searchSeq = 0;
  searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 200); });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); stepResult(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
  });
  $('#btnSearch').onclick = openSearch; $('#btnSearchClose').onclick = closeSearch;
  async function runSearch() {
    const q = searchInput.value.trim(); const seq = ++searchSeq;
    S.search = { q, results: [], active: -1 }; resultsEl.textContent = '';
    if (!q) { $('#searchCount').textContent = ''; for (const p of S.pages) paintHits(p); return; }
    const ql = q.toLowerCase(); const results = [];
    for (let i = 0; i < S.pages.length; i++) {
      const p = S.pages[i]; const items = await textItems(p);
      if (seq !== searchSeq) return;
      items.forEach((it, idx) => {
        const s = it.str.toLowerCase(); let from = 0, k;
        while ((k = s.indexOf(ql, from)) !== -1) { results.push({ key: p.key, page: i, idx, at: k, len: q.length, it }); from = k + ql.length; }
      });
      if (results.length > 1000) break;
    }
    S.search.results = results;
    $('#searchCount').textContent = results.length ? `${results.length} match${results.length > 1 ? 'es' : ''} on ${new Set(results.map((r) => r.page)).size} page${new Set(results.map((r) => r.page)).size > 1 ? 's' : ''}` : `No matches for "${q}".`;
    let lastPage = -1;
    results.slice(0, 500).forEach((r, n) => {
      if (r.page !== lastPage) { resultsEl.append(el('li', { class: 'grp' }, `Page ${r.page + 1}`)); lastPage = r.page; }
      const str = r.it.str; const a = Math.max(0, r.at - 40), b = Math.min(str.length, r.at + r.len + 60);
      const btn = el('button', { 'data-n': n }, (a > 0 ? '…' : '') + str.slice(a, r.at), el('mark', {}, str.slice(r.at, r.at + r.len)), str.slice(r.at + r.len, b) + (b < str.length ? '…' : ''));
      btn.onclick = () => goResult(n);
      resultsEl.append(el('li', {}, btn));
    });
    for (const p of S.pages) paintHits(p);
  }
  function goResult(n) {
    const r = S.search.results[n]; if (!r) return;
    if (S.search.active === -1) pushHistory();
    S.search.active = n;
    resultsEl.querySelectorAll('button.active').forEach((b) => b.classList.remove('active'));
    const b = resultsEl.querySelector(`button[data-n="${n}"]`); if (b) { b.classList.add('active'); b.scrollIntoView({ block: 'nearest' }); }
    const pe = pageEls.get(r.key); const p = pageByKey(r.key);
    if (pe && p) {
      const [, y] = apply(mat(p, S.zoom), r.it.u, r.it.vb);
      viewer.scrollTo({ top: pe.root.offsetTop + y - viewer.clientHeight / 3, behavior: 'smooth' });
      paintHits(p);
    }
  }
  function stepResult(d) {
    const n = S.search.results.length; if (!n) return;
    goResult(((S.search.active + d) % n + n) % n);
  }
  function paintHits(p) {
    const pe = pageEls.get(p.key); if (!pe) return;
    pe.layer.querySelectorAll('.hit').forEach((h) => h.remove());
    const res = S.search.results; if (!res.length) return;
    const act = res[S.search.active];
    res.forEach((r) => {
      if (r.key !== p.key) return;
      const it = r.it; const unit = it.str.length ? it.w / it.str.length : 0;
      const u1 = it.u + r.at * unit, u2 = u1 + r.len * unit;
      const box = el('div', { class: 'hit' + (r === act ? ' active' : '') });
      pos(box, screenRect(p, u1, it.vb - it.size * 0.85, u2, it.vb + it.size * 0.2));
      pe.layer.append(box);
    });
  }

  // ---------- signature and images ----------
  function startPlacing(dataUrl, w0, h0, width, from) {
    const id = addImage(dataUrl, w0, h0);
    S.placing = id; S.placeWidth = width; S.placeFrom = from;
    setTool('place');
    toast(from === 'sign' ? 'Click where the signature goes.' : 'Click where the image goes.');
  }
  function trimCanvas(c) {
    const ctx = c.getContext('2d'); const { width: W, height: H } = c;
    const d = ctx.getImageData(0, 0, W, H).data;
    let x1 = W, y1 = H, x2 = -1, y2 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 8) { if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y; }
    if (x2 < 0) return null;
    const pad = 6; x1 = Math.max(0, x1 - pad); y1 = Math.max(0, y1 - pad); x2 = Math.min(W - 1, x2 + pad); y2 = Math.min(H - 1, y2 + pad);
    const out = document.createElement('canvas'); out.width = x2 - x1 + 1; out.height = y2 - y1 + 1;
    out.getContext('2d').drawImage(c, x1, y1, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }
  // Signature library: draw, type or import (PNG/JPG). Every signature you make is kept on this computer
  // until you delete it; deleting offers Undo.
  function storeSigs(list) { try { localStorage.setItem('bubbypdf.sigs', JSON.stringify(list.slice(0, 60))); return true; } catch { toast('Could not save the signature on this computer (storage is full).', 'error'); return false; } }
  function loadSavedSigs() {
    try {
      let list = JSON.parse(localStorage.getItem('bubbypdf.sigs') || localStorage.getItem('docbench.sigs') || '[]');
      list = list.map((s, i) => ({ id: s.id || 's' + Date.now().toString(36) + i, dataUrl: s.dataUrl, w: s.w, h: s.h, name: s.name || '' }));
      return list;
    } catch { return []; }
  }
  function saveSig(dataUrl, w, h) {
    const list = loadSavedSigs().filter((s) => s.dataUrl !== dataUrl);
    list.unshift({ id: 's' + Date.now().toString(36), dataUrl, w, h });
    storeSigs(list);
  }
  function deleteSig(id, after) {
    const list = loadSavedSigs(); const i = list.findIndex((s) => s.id === id); if (i < 0) return;
    const [gone] = list.splice(i, 1); storeSigs(list); after();
    toast('Signature deleted.', '', { label: 'Undo', fn: () => { const l = loadSavedSigs(); l.splice(Math.min(i, l.length), 0, gone); storeSigs(l); after(); } });
  }
  // A photo or scan of a signature: make the paper transparent, keep the ink, crop to the ink.
  function cleanSignatureImage(img, removeBg) {
    const scale = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.naturalWidth * scale)); c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, c.width, c.height);
    if (removeBg) {
      const d = ctx.getImageData(0, 0, c.width, c.height); const px = d.data;
      // paper brightness = a high percentile of the image, so grey or warm paper also disappears
      const hist = new Uint32Array(256);
      for (let i = 0; i < px.length; i += 4) hist[Math.round((px[i] + px[i + 1] + px[i + 2]) / 3)]++;
      let acc = 0; let paper = 255; const target = (px.length / 4) * 0.6;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) { paper = v; break; } }
      const hi = Math.max(120, paper - 18), lo = Math.max(40, hi - 90);
      for (let i = 0; i < px.length; i += 4) {
        const l = (px[i] + px[i + 1] + px[i + 2]) / 3;
        const a = l >= hi ? 0 : l <= lo ? 1 : (hi - l) / (hi - lo);
        px[i + 3] = Math.round(px[i + 3] * a);
        if (a > 0 && a < 1) { const k = Math.min(1, 0.35 + a); px[i] *= k; px[i + 1] *= k; px[i + 2] *= k; }
      }
      ctx.putImageData(d, 0, 0);
    }
    return trimCanvas(c) || c;
  }
  function openSignature() {
    let mode = 'draw'; let color = '#111111'; let imported = null;
    const pad = el('canvas', { class: 'sigpad', width: '900', height: '300', 'aria-label': 'Draw your signature here' });
    const typed = el('input', { type: 'text', placeholder: 'Type your name', 'aria-label': 'Your name', autocomplete: 'name' });
    const fontSel = el('select', { 'aria-label': 'Signature style' });
    [['"Segoe Script", "Lucida Handwriting", cursive', 'Script'], ['"Ink Free", "Segoe Print", cursive', 'Handwritten'], ['"Lucida Handwriting", "Segoe Script", cursive', 'Formal']].forEach(([v, l]) => fontSel.append(el('option', { value: v }, l)));
    const preview = el('canvas', { class: 'sigtyped', width: '900', height: '300', 'aria-hidden': 'true' });
    const impPreview = el('div', { class: 'sigimport' }, el('p', { class: 'muted' }, 'Choose a photo or scan of your signature (PNG or JPG).'));
    const removeBg = el('input', { type: 'checkbox', id: 'sigRemoveBg', checked: true });
    const drawPanel = el('div', { class: 'sigpanel' }, pad);
    const typePanel = el('div', { class: 'sigpanel', hidden: true }, el('div', { class: 'sig-row' }, typed, fontSel), preview);
    const importPanel = el('div', { class: 'sigpanel', hidden: true },
      el('div', { class: 'sig-row' },
        el('button', { class: 'btn secondary', onclick: () => chooseImage() }, 'Choose image'),
        el('label', { for: 'sigRemoveBg', class: 'chk' }, removeBg, ' Remove white background')),
      impPreview);
    const renderTyped = () => {
      const ctx = preview.getContext('2d'); ctx.clearRect(0, 0, 900, 300);
      ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      let size = 120; ctx.font = `${size}px ${fontSel.value}`;
      while (ctx.measureText(typed.value).width > 840 && size > 30) { size -= 6; ctx.font = `${size}px ${fontSel.value}`; }
      ctx.fillText(typed.value, 450, 150);
    };
    typed.addEventListener('input', renderTyped); fontSel.addEventListener('change', renderTyped);
    let rawImg = null;
    const renderImport = () => {
      if (!rawImg) return;
      imported = cleanSignatureImage(rawImg, removeBg.checked);
      impPreview.textContent = '';
      const show = el('img', { src: imported.toDataURL('image/png'), alt: 'Imported signature preview' });
      impPreview.append(show);
    };
    removeBg.addEventListener('change', renderImport);
    async function chooseImage() {
      const f = await bench.openImage(); if (!f) return;
      const mime = /\.jpe?g$/i.test(f.name) ? 'image/jpeg' : 'image/png';
      let bin = ''; const b = f.bytes; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      const im = new Image();
      im.onload = () => { rawImg = im; renderImport(); };
      im.onerror = () => toast('That image could not be read. Use a PNG or JPEG file.', 'error');
      im.src = `data:${mime};base64,${btoa(bin)}`;
    }
    const pctx = pad.getContext('2d'); let drawing = null; let strokes = 0;
    pad.addEventListener('pointerdown', (e) => {
      const r = pad.getBoundingClientRect(); const k = 900 / r.width;
      drawing = [(e.clientX - r.left) * k, (e.clientY - r.top) * k]; pad.setPointerCapture(e.pointerId);
      pctx.strokeStyle = color; pctx.lineWidth = 5; pctx.lineCap = 'round'; pctx.lineJoin = 'round';
      pctx.beginPath(); pctx.moveTo(...drawing); strokes++;
    });
    pad.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const r = pad.getBoundingClientRect(); const k = 900 / r.width;
      const pt = [(e.clientX - r.left) * k, (e.clientY - r.top) * k];
      const mid = [(drawing[0] + pt[0]) / 2, (drawing[1] + pt[1]) / 2];
      pctx.quadraticCurveTo(drawing[0], drawing[1], mid[0], mid[1]); pctx.stroke(); pctx.beginPath(); pctx.moveTo(...mid);
      drawing = pt;
    });
    pad.addEventListener('pointerup', () => { drawing = null; });
    const tabs = el('div', { class: 'tabs', role: 'tablist' });
    const panels = { draw: drawPanel, type: typePanel, import: importPanel };
    const tabBtn = (m, l) => {
      const b = el('button', { class: 'btn ghost', role: 'tab', 'aria-selected': String(mode === m) }, l);
      b.onclick = () => {
        mode = m; tabs.querySelectorAll('button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
        for (const [k, pnl] of Object.entries(panels)) pnl.hidden = k !== m;
        colorsRow.hidden = m === 'import';
        if (m === 'type') { typed.focus(); renderTyped(); }
        if (m === 'import' && !rawImg) chooseImage();
      };
      return b;
    };
    tabs.append(tabBtn('draw', 'Draw'), tabBtn('type', 'Type'), tabBtn('import', 'Import image'));
    const colors = swatchRow(['#111111', '#1F4FD1'], color, (c) => { color = c; colors.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-checked', String(s.title === c))); renderTyped(); }, 'Ink color');
    const colorsRow = el('div', { class: 'sig-row' }, colors, el('span', { class: 'spacer' }),
      el('button', { class: 'btn ghost', onclick: () => { pctx.clearRect(0, 0, 900, 300); strokes = 0; typed.value = ''; renderTyped(); } }, 'Clear'));
    const library = el('div', { class: 'saved-sigs', role: 'list', 'aria-label': 'Saved signatures' });
    const libHead = el('h3', { class: 'sub' }, 'Saved signatures');
    const renderLibrary = () => {
      const saved = loadSavedSigs(); library.textContent = '';
      libHead.hidden = library.hidden = !saved.length;
      for (const s of saved) {
        const use = el('button', { class: 'sig-use', title: 'Use this signature', 'aria-label': 'Use this saved signature' }, el('img', { src: s.dataUrl, alt: '' }));
        use.onclick = () => { close(); startPlacing(s.dataUrl, s.w, s.h, 150, 'sign'); };
        const del = el('button', { class: 'btn ghost sm icon sig-del', 'aria-label': 'Delete this saved signature', title: 'Delete', html: window.icon('x', 14) });
        del.onclick = () => deleteSig(s.id, renderLibrary);
        library.append(el('div', { class: 'sig-item', role: 'listitem' }, use, del));
      }
    };
    const { root, close } = modal([
      el('h2', {}, 'Signature'),
      el('p', {}, 'Use a saved signature, or make a new one. Signatures are kept on this computer only.'),
      libHead, library,
      tabs, drawPanel, typePanel, importPanel, colorsRow,
      el('div', { class: 'actions' },
        el('button', { class: 'btn secondary', onclick: () => close() }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: () => {
          let c = null;
          if (mode === 'draw') c = strokes ? trimCanvas(pad) : null;
          else if (mode === 'type') c = typed.value.trim() ? trimCanvas(preview) : null;
          else c = imported;
          if (!c) { toast(mode === 'draw' ? 'Draw your signature first.' : mode === 'type' ? 'Type your name first.' : 'Choose an image first.', 'error'); return; }
          const url = c.toDataURL('image/png'); saveSig(url, c.width, c.height);
          close(); startPlacing(url, c.width, c.height, 150, 'sign');
        } }, 'Save and use')),
    ], 'wide');
    root.querySelector('.sig-row .spacer').style.flex = '1';
    renderLibrary();
  }
  async function pickImage() {
    const f = await bench.openImage(); if (!f) return;
    const mime = /\.jpe?g$/i.test(f.name) ? 'image/jpeg' : 'image/png';
    let bin = ''; const b = f.bytes; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    const url = `data:${mime};base64,${btoa(bin)}`;
    const im = new Image();
    im.onload = () => startPlacing(url, im.naturalWidth, im.naturalHeight, Math.min(240, im.naturalWidth * 0.75), 'image');
    im.onerror = () => toast('That image could not be read. Use a PNG or JPEG file.', 'error');
    im.src = url;
  }

  // ---------- saving ----------
  // Characters the standard PDF fonts can draw (WinAnsi). Anything else becomes "?" and is counted.
  let charSet = null;
  async function encoder() {
    if (!charSet) {
      const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
      charSet = new Set(f.getCharacterSet());
    }
    return charSet;
  }
  async function safeText(str, counter) {
    const set = await encoder(); let out = '';
    for (const ch of str.replace(/\t/g, '    ')) {
      if (ch === ' ' || set.has(ch.codePointAt(0))) out += ch; else { out += '?'; counter.n++; }
    }
    return out;
  }
  function hex(c) { const n = parseInt(c.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); }
  async function applyFields(ld, vals, counter, sizes) {
    vals = vals || {}; sizes = sizes || {};
    const names = new Set([...Object.keys(vals), ...Object.keys(sizes)]);
    if (!names.size) return;
    const P = window.PDFLib; let form;
    try { form = ld.getForm(); } catch { return; }
    for (const name of names) {
      const v = vals[name];
      try {
        const f = form.getField(name);
        if (f instanceof P.PDFTextField) {
          if (sizes[name]) f.setFontSize(sizes[name]);
          if (name in vals) f.setText(await safeText(String(v ?? ''), counter));
          else if (sizes[name]) f.setText(f.getText() || '');
        }
        else if (!(name in vals)) continue;
        else if (f instanceof P.PDFCheckBox) (v ? f.check() : f.uncheck());
        else if (f instanceof P.PDFRadioGroup) {
          if (v) {
            // Widget state names are sometimes indices into /Opt ("0", "1"); map them to option values.
            const opts = f.getOptions();
            f.select(opts.includes(v) ? v : (/^\d+$/.test(v) && opts[+v] !== undefined ? opts[+v] : v));
          }
        }
        else if (f instanceof P.PDFDropdown || f instanceof P.PDFOptionList) { if (v) f.select(v); else f.clear(); }
      } catch (e) { console.warn('field', name, e); }
    }
  }
  async function buildPdf(entries, opts = {}) {
    const counter = { n: 0 };
    const used = [...new Set(entries.filter((p) => !p.blank).map((p) => p.docId))];
    const libs = new Map();
    for (const id of used) {
      const d = S.docs.get(id); let ld;
      try { ld = await libOf(d); } catch (e) {
        if (/encrypt/i.test(e.message || '')) throw new Error(`"${d.name}" is password-protected, so BubbyPDF can't save changes to it.`);
        throw new Error(`"${d.name}" could not be saved: ${e.message}`);
      }
      if (!opts.preview) await applyFields(ld, S.fields.get(id), counter, S.fsize.get(id));
      libs.set(id, ld);
    }
    const single = used.length === 1 && !entries.some((p) => p.blank) &&
      entries.length === S.docs.get(used[0]).pdf.numPages && entries.every((p, i) => p.src === i);
    let out;
    if (single) out = libs.get(used[0]);
    else {
      out = await PDFDocument.create();
      const copied = new Map();
      for (const [id, ld] of libs) {
        if (!opts.preview) { try { if (ld.getForm().getFields().length) ld.getForm().flatten(); } catch (e) { console.warn('flatten', e); } }
        const idx = entries.filter((p) => p.docId === id).map((p) => p.src);
        const pages = await out.copyPages(ld, idx);
        idx.forEach((src, k) => { if (!copied.has(id + ':' + src)) copied.set(id + ':' + src, pages[k]); });
      }
      const usedOnce = new Set();
      for (const p of entries) {
        if (p.blank) { out.addPage([p.W, p.H]); continue; }
        const ck = p.docId + ':' + p.src;
        let pg = copied.get(ck);
        if (usedOnce.has(ck)) { [pg] = await out.copyPages(libs.get(p.docId), [p.src]); }
        usedOnce.add(ck); out.addPage(pg);
      }
    }
    const fonts = {};
    const font = async (k) => fonts[k] || (fonts[k] = await out.embedFont({ helv: StandardFonts.Helvetica, times: StandardFonts.TimesRoman, cour: StandardFonts.Courier }[k] || StandardFonts.Helvetica));
    const imgs = {};
    const redacted = [];
    for (let i = 0; i < entries.length; i++) {
      const p = entries[i]; const pg = out.getPage(i);
      pg.setRotation(degrees(dispRot(p)));
      if (p.annots.some((a) => a.type === 'redact')) redacted.push(i);
      const allEdits = p.annots.filter((a) => a.type === 'textedit');
      const edits = []; const plans = [];
      const TE = window.BubbyTextEdit;
      for (const a of allEdits) {
        if (a.geo && a.pos && !a.restyled) {
          let r = { ok: false };
          try { r = await editLines(out, pg, p, a, counter); } catch (e) { console.warn('editLines', e); }
          if (!r.ok) edits.push(a); else plans.push(r);
        } else edits.push(a);
      }
      if (edits.length) {
        const [x0, , , y1] = p.view;
        const regions = edits.map((a) => ({ x1: x0 + a.region.x - 0.5, x2: x0 + a.region.x + a.region.w + 0.5, y1: y1 - (a.region.y + a.region.h) - 0.5, y2: y1 - a.region.y + 0.5 }));
        let res;
        try { res = await window.BubbyTextEdit.removeText(out, pg, regions); } catch (e) { console.warn('removeText', e); res = { removed: 0, unsupported: 1 }; }
        if (!res.removed || res.unsupported) {
          counter.covered = (counter.covered || 0) + edits.length;
          for (const a of edits) pg.drawRectangle({ x: x0 + a.region.x, y: y1 - a.region.y - a.region.h, width: a.region.w, height: a.region.h, color: rgb(1, 1, 1) });
        }
        const [, , , yTop] = p.view;
        for (const [k, a] of edits.entries()) {
          // a paragraph laid out again from scratch: room for every line it now needs
          let n = 1;
          try { const std = await out.embedFont(stdOf(a)); n = Math.max(1, wrapLines(a, (s2) => std.widthOfTextAtSize(s2, a.size)).length); } catch { n = Math.max(1, wrapLines(a).length); }
          const need = a.y + a.size * 0.8 + (n - 1) * a.leading + a.size * 0.3;
          const have = a.region ? a.region.y + a.region.h : need;
          plans.push({ dy: Math.max(0, need - have), cut: yTop - have, topY: yTop - a.y, draw: (off) => drawTextEdit(out, pg, p, a, counter, res.caps && res.caps[k], off) });
        }
      }
      // Make room below paragraphs that grew (lowest first), then write every paragraph in place.
      const grows = plans.filter((q) => q.dy > 0.01).sort((q1, q2) => q1.cut - q2.cut);
      for (const q of grows) {
        try { const r = await TE.shiftBelow(out, pg, q.cut, q.dy); counter.lost = (counter.lost || 0) + r.lost; counter.pushed = (counter.pushed || 0) + 1; }
        catch (e) { console.warn('shiftBelow', e); q.dy = 0; }
      }
      const [, , , yv] = p.view;
      const shifts = grows.filter((q) => q.dy > 0).map((q) => ({ cutV: yv - q.cut, dy: q.dy }));
      if (shifts.length) { counter.shifts = counter.shifts || {}; counter.shifts[i] = shifts; }
      for (const q of plans) {
        const off = grows.filter((g) => g !== q && g.dy > 0 && g.cut > q.topY - 0.5).reduce((t, g) => t + g.dy, 0);
        await q.draw(off);
      }
      const pushAt = (v) => shifts.filter((sh) => sh.cutV <= v).reduce((t, sh) => t + sh.dy, 0);
      for (const a of p.annots) {
        if (a.type === 'redact' || a.type === 'textedit') continue;
        const d = pushAt(bounds(a).y);
        let w = a; if (d) { w = JSON.parse(JSON.stringify(a)); shiftAnnot(w, a, 0, d); }
        await writeAnnot(out, pg, p, w, { font, imgs, counter });
      }
    }
    if (!opts.preview) {
      for (let i = 0; i < entries.length; i++) if (entries[i].ocr) await window.BubbyTools.writeOcr(out, out.getPage(i), entries[i]);
      await window.BubbyTools.applyMarks(out, entries, S.marks);
    }
    if (redacted.length && !opts.preview) out = await applyRedactions(out, entries, redacted);
    out.setProducer('BubbyPDF'); out.setModificationDate(new Date());
    // No object streams, so BubbyPDF can find its own annotations again when the file is reopened.
    const bytes = await out.save({ useObjectStreams: false });
    return { bytes, replaced: counter.n, redactedPages: redacted.length, covered: counter.covered || 0, fallbackChars: counter.fallback || 0, overflow: counter.overflow || 0, pushed: counter.pushed || 0, lost: counter.lost || 0, shifts: counter.shifts || {} };
  }

  // Line-preserving paragraph edit. Lines before the first change and (when the change fits back into the
  // same number of lines) lines after it are not touched at all. Changed lines keep their start position,
  // baseline, width and justification, and every character keeps the font, size and colour of the text run
  // it came from; typed characters take the style of the text just before them.
  async function editLines(out, pg, p, a, counter) {
    const TE = window.BubbyTextEdit;
    const [x0, , , y1] = p.view;
    const X = (u) => x0 + u, Y = (v) => y1 - v;
    const G = a.geo; const n = G.length;
    const oldT = a.origText; const newT = String(a.text);
    const origRight = Math.max(...G.map((l) => l.u + l.w));
    // the paragraph's right edge: as dragged by the user, or for a one-line paragraph the text column's edge
    const right = a.resized ? a.x + a.w : n === 1 && (a.align || 'left') === 'left' && a.colRight ? Math.max(origRight, a.colRight) : origRight;
    const widthChanged = a.resized && Math.abs(right - origRight) > 0.5;
    if (newT === oldT && !widthChanged) return { ok: true, dy: 0, draw: async () => {} };
    const leftBody = n > 1 ? Math.min(...G.slice(1).map((l) => l.u)) : G[0].u;
    const lead = a.leading || G[0].size * 1.2;
    // 1. Read the style of every text run in the paragraph (nothing is changed yet).
    const pad = G[0].size * 0.5;
    const para = { x1: X(Math.min(...G.map((l) => l.u)) - pad), x2: X(right + pad), y1: Y(G[n - 1].vb) - G[n - 1].size * 0.45, y2: Y(G[0].vb) + G[0].size * 0.45 };
    const { scan = [] } = await TE.removeText(out, pg, [para], { dryRun: true });
    if (!scan.length || scan.some((s) => s.cap.rotated)) return { ok: false };
    const capAt = (li, x) => {
      const uy = Y(G[li].vb), ux = X(x); const near = scan.filter((o) => Math.abs(o.y - uy) < G[li].size * 0.6);
      return (near.find((o) => ux >= o.x - 0.5 && ux <= o.x + o.w + 0.5) || near.sort((s1, s2) => Math.abs(s1.x - ux) - Math.abs(s2.x - ux))[0] || scan[0]).cap;
    };
    const oldCap = a.pos.map((pp) => (pp ? capAt(pp[0], pp[1]) : null));
    for (let i = 0; i < oldCap.length; i++) if (!oldCap[i]) oldCap[i] = oldCap[i - 1] || oldCap.find(Boolean);
    // 2. What changed: common prefix and suffix of the old and new text.
    let pre = 0; while (pre < oldT.length && pre < newT.length && oldT[pre] === newT[pre]) pre++;
    let suf = 0; while (suf < oldT.length - pre && suf < newT.length - pre && oldT[oldT.length - 1 - suf] === newT[newT.length - 1 - suf]) suf++;
    const shift = newT.length - oldT.length;
    const newCap = [...newT].map((_, i) => (i < pre ? oldCap[i] : i >= newT.length - suf ? oldCap[i - shift] : null));
    for (let i = 0; i < newCap.length; i++) if (!newCap[i]) newCap[i] = newCap[i - 1] || oldCap[Math.min(pre, oldCap.length - 1)] || oldCap[0];
    const lineEnd = (li) => (li + 1 < n ? a.offsets[li + 1] : oldT.length);
    // first line that changed: the first line whose text reaches past the unchanged prefix
    let top = 0; while (top < n && lineEnd(top) <= pre && (lineEnd(top) === oldT.length || (newT[lineEnd(top)] === oldT[lineEnd(top)]))) top++;
    if (top >= n) top = n - 1;
    if (widthChanged) top = 0; // a new width rewraps the whole paragraph
    const startNew = a.offsets[top]; // same offset in new text (it is inside the prefix)
    // 3. Fonts for measuring and drawing.
    const encs = new Map();
    const encFor = async (cap) => {
      if (!encs.has(cap.font)) encs.set(cap.font, await TE.fontEncoder(out, pg, cap.font, new Set([...oldT])).catch(() => null));
      return encs.get(cap.font);
    };
    for (const c of new Set(newCap)) await encFor(c);
    const charSet = await encoder();
    const stdFonts = new Map();
    const stdFor = async (cap) => {
      const fam = a.fallbackFont || 'helv'; const nm = /bold|black|heavy|semibold/i.test(cap.font + '') ? 1 : 0;
      const key = TE.stdName(fam, !!a.bold || !!nm, !!a.italic);
      if (!stdFonts.has(key)) stdFonts.set(key, await out.embedFont(key));
      return stdFonts.get(key);
    };
    const chars = [...newT];
    const chW = (i) => {
      const ch = chars[i]; const cap = newCap[i]; const enc = encs.get(cap.font);
      if (enc && enc.map.has(ch)) return TE.runWidth(enc, cap, ch);
      const sf = stdFonts.get('_any'); return sf ? sf.widthOfTextAtSize(charSet.has(ch.codePointAt(0)) ? ch : '?', cap.size) : cap.size * 0.5;
    };
    stdFonts.set('_any', await stdFor(newCap[0]));
    // 4. Lay out the changed part, line by line, in the original line slots.
    const slotX = (li) => (li < n ? G[li].u : leftBody);
    const slotY = (li) => (li < n ? G[li].vb : G[n - 1].vb + lead * (li - n + 1));
    const slotW = (li) => right - slotX(li);
    const layout = (from, to, lastSlot) => {
      // wrap chars [from, to) into lines starting at slot `top`
      const res = []; let li = top; let i = from;
      while (i < to) {
        while (i < to && chars[i] === ' ') i++;
        if (i >= to) break;
        const width = slotW(li); let w = 0; let lastBreak = -1; let j = i;
        for (; j < to; j++) {
          if (chars[j] === ' ') lastBreak = j;
          const cw = chW(j);
          if (w + cw > width + 0.01 && j > i) break;
          w += cw;
        }
        let end = j;
        if (j < to && lastBreak > i) end = lastBreak;
        res.push({ li, from: i, to: end });
        i = end; li++;
        if (lastSlot != null && li > lastSlot + 1) return null;
      }
      return res;
    };
    // try to keep the untouched lines at the bottom: the change must fit exactly in the slots before them
    let bottom = n; let lines = null;
    for (let kb = top + 1; kb < n && !widthChanged; kb++) {
      if (a.offsets[kb] < oldT.length - suf) continue;
      const endNew = a.offsets[kb] + shift;
      const mid = layout(startNew, endNew, kb - 1);
      if (mid && mid.length === kb - top && (endNew === 0 || newT[endNew - 1] === ' ' || /-$/.test(newT.slice(0, endNew)))) { bottom = kb; lines = mid; break; }
    }
    if (!lines) lines = layout(startNew, chars.length, null) || [];
    // 5. Remove the old text of the changed lines only.
    const changedSlots = []; for (let li = top; li < bottom; li++) changedSlots.push(li);
    const regions = changedSlots.map((li) => ({ x1: X(G[li].u) - 1, x2: X(G[li].u + G[li].w) + 1, y1: Y(G[li].vb) - G[li].size * 0.4, y2: Y(G[li].vb) + G[li].size * 0.4 }));
    let res;
    try { res = await TE.removeText(out, pg, regions); } catch (e) { console.warn('removeText', e); res = { removed: 0, unsupported: 1 }; }
    if (!res.removed || res.unsupported) {
      counter.covered = (counter.covered || 0) + 1;
      for (const li of changedSlots) pg.drawRectangle({ x: X(G[li].u) - 1, y: Y(G[li].vb) - G[li].size * 0.3, width: G[li].w + 2, height: G[li].size * 1.25, color: rgb(1, 1, 1) });
    }
    // 6. How much room the paragraph needs below its last line: what follows moves down by that much.
    const lastSlot = lines.length ? Math.max(...lines.map((L) => L.li)) : n - 1;
    const dy = bottom === n ? Math.max(0, lastSlot - (n - 1)) * lead : 0;
    const cut = Y(G[n - 1].vb) - G[n - 1].size * 0.3;
    // 7. Draw the new lines (called after the room is made; `off` = how far paragraphs above pushed this one).
    const draw = async (off = 0) => {
    let ops = ''; const fm = TE.fmt;
    const justify = a.align === 'justify';
    for (const [k, L] of lines.entries()) {
      const isLastOfParagraph = bottom === n && k === lines.length - 1;
      let natural = 0; let spaces = 0;
      for (let i = L.from; i < L.to; i++) { natural += chW(i); if (chars[i] === ' ') spaces++; }
      const extra = justify && !isLastOfParagraph && spaces ? Math.max(0, (slotW(L.li) - natural) / spaces) : 0;
      let x = X(slotX(L.li));
      if (a.align === 'center') x = X(slotX(L.li) + (slotW(L.li) - natural) / 2);
      else if (a.align === 'right') x = X(right - natural);
      const y = Y(slotY(L.li)) - off;
      // runs of characters with the same style and the same font coverage
      let i = L.from;
      while (i < L.to) {
        const cap = newCap[i]; const enc = encs.get(cap.font);
        const inF = (q) => !!(enc && enc.map.has(chars[q]));
        const mode = inF(i);
        let j = i; let s = '';
        while (j < L.to && newCap[j] === cap && inF(j) === mode && !(extra && chars[j] === ' ' && j > i)) { s += chars[j]; j++; if (extra && chars[j - 1] === ' ') break; }
        if (mode) {
          ops += `BT ${cap.fill} /${enc.name} ${fm(cap.size)} Tf ${fm(cap.Tc)} Tc ${fm(cap.Tw)} Tw ${fm(cap.Th * 100)} Tz 1 0 0 1 ${fm(x)} ${fm(y)} Tm ${TE.encodeRun(enc, s)} Tj ET\n`;
        } else {
          const sf = await stdFor(cap); const t = [...s].map((ch) => (charSet.has(ch.codePointAt(0)) ? ch : '?')).join('');
          counter.n += [...s].filter((ch) => ch !== '?' && !charSet.has(ch.codePointAt(0))).length;
          if (t.trim()) {
            counter.fallback = (counter.fallback || 0) + [...t.trim()].length;
            const col = /([\d.]+) ([\d.]+) ([\d.]+) rg/.exec(cap.fill);
            pg.drawText(t, { x, y, size: cap.size, font: sf, color: col ? rgb(+col[1], +col[2], +col[3]) : /([\d.]+) g$/.test(cap.fill) ? rgb(+RegExp.$1, +RegExp.$1, +RegExp.$1) : rgb(0, 0, 0) });
          }
        }
        for (let q = i; q < j; q++) x += chW(q) + (extra && chars[q] === ' ' ? extra : 0);
        i = j;
      }
    }
    if (ops) TE.appendContent(out, pg, ops);
    };
    return { ok: true, dy, cut, topY: Y(G[0].vb) + G[0].size, draw };
  }

  // An edited paragraph becomes real page text again (searchable, and editable next time).
  // By default it is written in the paragraph's own embedded font, size, colour and spacing.
  // Letters that font does not contain fall back to the closest standard font, letter by letter.
  async function drawTextEdit(out, pg, p, a, counter, cap, off = 0) {
    if (!a.text) return;
    const TE = window.BubbyTextEdit;
    const [x0, , , y1] = p.view;
    const std = await out.embedFont(stdOf(a));
    const charSet = await encoder();
    let enc = null;
    if (a.font === 'orig' && cap && cap.font && !cap.rotated && !!a.bold === !!a.origBold && !!a.italic === !!a.origItalic) {
      try { enc = await TE.fontEncoder(out, pg, cap.font, new Set([...(a.origText || '')])); } catch (e) { console.warn('font', e); enc = null; }
    }
    if (!enc) {
      const safeLines = [];
      for (const ln of String(a.text).split('\n')) safeLines.push(await safeText(ln, counter));
      const lines = wrapLines({ ...a, text: safeLines.join('\n') }, (s) => std.widthOfTextAtSize(s, a.size));
      lines.forEach((ln, i) => {
        if (!ln) return;
        const lw = std.widthOfTextAtSize(ln, a.size);
        const dx = a.align === 'center' ? (a.w - lw) / 2 : a.align === 'right' ? a.w - lw : 0;
        pg.drawText(ln, { x: x0 + a.x + dx, y: y1 - (a.y + a.size * 0.8 + i * a.leading) - off, size: a.size, font: std, color: hex(a.color) });
      });
      return;
    }
    const k = a.size / cap.size;
    const c = { ...cap, size: a.size, Tc: cap.Tc * k, Tw: cap.Tw * k };
    const inFont = (ch) => enc.map.has(ch);
    const fbChar = (ch) => (charSet.has(ch.codePointAt(0)) ? ch : '?');
    const chW = (ch) => (inFont(ch) ? TE.runWidth(enc, c, ch) : std.widthOfTextAtSize(fbChar(ch), a.size));
    const width = (s) => { let w = 0; for (const ch of s) w += chW(ch); return w; };
    const custom = a.origColor && a.color.toUpperCase() !== a.origColor.toUpperCase();
    const fill = custom ? `${rgb3(a.color).join(' ')} rg` : cap.fill;
    const fm = TE.fmt;
    let ops = '';
    wrapLines(a, width).forEach((ln, i) => {
      if (!ln) return;
      const lw = width(ln);
      let x = x0 + a.x + (a.align === 'center' ? (a.w - lw) / 2 : a.align === 'right' ? a.w - lw : 0);
      const y = y1 - (a.y + a.size * 0.8 + i * a.leading) - off;
      // split the line into runs the original font can draw, and runs it cannot
      const runs = [];
      for (const ch of ln) {
        const o = inFont(ch); const last = runs[runs.length - 1];
        if (last && last.o === o) last.s += ch; else runs.push({ o, s: ch });
      }
      for (const r of runs) {
        if (r.o) {
          ops += `BT ${fill} /${enc.name} ${fm(c.size)} Tf ${fm(c.Tc)} Tc ${fm(c.Tw)} Tw ${fm(c.Th * 100)} Tz 1 0 0 1 ${fm(x)} ${fm(y)} Tm ${TE.encodeRun(enc, r.s)} Tj ET\n`;
          x += TE.runWidth(enc, c, r.s);
        } else {
          const t = [...r.s].map(fbChar).join('');
          counter.n += [...r.s].filter((ch) => fbChar(ch) === '?' && ch !== '?').length;
          if (t.trim()) { counter.fallback = (counter.fallback || 0) + [...t.trim()].length; pg.drawText(t, { x, y, size: a.size, font: std, color: hex(a.color) }); }
          x += std.widthOfTextAtSize(t, a.size);
        }
      }
    });
    if (ops) TE.appendContent(out, pg, ops);
  }

  // ---------- real PDF annotations (stay editable in BubbyPDF and other viewers) ----------
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const rgb3 = (c) => { const k = parseInt((c || '#000000').slice(1), 16); return [((k >> 16) & 255) / 255, ((k >> 8) & 255) / 255, (k & 255) / 255].map(r3); };
  function pdfDate(d = new Date()) {
    const z = (v) => String(v).padStart(2, '0');
    return `D:${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
  }
  async function writeAnnot(out, pg, p, a, h) {
    const P = window.PDFLib; const ctx = out.context;
    const [x0, , , y1] = p.view;
    const X = (u) => r3(x0 + u), Y = (v) => r3(y1 - v), pt = (u, v) => `${X(u)} ${Y(v)}`;
    const col = rgb3(a.color); const cs = col.join(' ');
    const quads = () => rectsOf(a).flatMap((r) => [X(r.x), Y(r.y), X(r.x + r.w), Y(r.y), X(r.x), Y(r.y + r.h), X(r.x + r.w), Y(r.y + r.h)]);
    const b = { ...bounds(a) }; let pad = 2; let sub; let ops = ''; let res = {}; const extra = { C: col };
    const data = { ...a }; delete data.id;
    switch (a.type) {
      case 'highlight':
        sub = 'Highlight'; pad = 0;
        ops = `/GS0 gs ${cs} rg ` + rectsOf(a).map((r) => `${X(r.x)} ${Y(r.y + r.h)} ${r3(r.w)} ${r3(r.h)} re f`).join(' ');
        res = { ExtGState: { GS0: { BM: 'Multiply', ca: 0.45, CA: 0.45 } } };
        extra.QuadPoints = quads(); break;
      case 'underline': case 'strike':
        sub = a.type === 'underline' ? 'Underline' : 'StrikeOut';
        ops = `${cs} RG ` + rectsOf(a).map((r) => {
          const yy = a.type === 'underline' ? r.y + r.h * 0.92 : r.y + r.h * 0.55;
          return `${r3(Math.max(0.8, r.h * 0.07))} w ${pt(r.x, yy)} m ${pt(r.x + r.w, yy)} l S`;
        }).join(' ');
        extra.QuadPoints = quads(); break;
      case 'rect':
        sub = 'Square'; pad = a.width;
        ops = `${cs} RG ${r3(a.width)} w ${X(a.x)} ${Y(a.y + a.h)} ${r3(a.w)} ${r3(a.h)} re S`; extra.BS = { W: a.width }; break;
      case 'whiteout':
        sub = 'Square'; pad = 0;
        ops = `1 1 1 rg ${X(a.x)} ${Y(a.y + a.h)} ${r3(a.w)} ${r3(a.h)} re f`; extra.C = [1, 1, 1]; extra.IC = [1, 1, 1]; extra.BS = { W: 0 }; break;
      case 'ink': {
        sub = 'Ink'; pad = a.width;
        const pts = a.pts.length === 1 ? [a.pts[0], [a.pts[0][0] + 0.01, a.pts[0][1]]] : a.pts;
        ops = `${cs} RG ${r3(a.width)} w 1 J 1 j ` + pts.map(([u, v], k) => `${pt(u, v)} ${k ? 'l' : 'm'}`).join(' ') + ' S';
        extra.InkList = [pts.flatMap(([u, v]) => [X(u), Y(v)])]; extra.BS = { W: a.width }; break;
      }
      case 'check':
        sub = 'Stamp'; pad = a.size * 0.1;
        if (a.mark === 'dot') {
          const cx = a.x + a.size / 2, cy = a.y + a.size / 2, r = a.size * 0.3, k = r * 0.5523;
          ops = `${cs} rg ${pt(cx + r, cy)} m ${pt(cx + r, cy - k)} ${pt(cx + k, cy - r)} ${pt(cx, cy - r)} c ${pt(cx - k, cy - r)} ${pt(cx - r, cy - k)} ${pt(cx - r, cy)} c ` +
            `${pt(cx - r, cy + k)} ${pt(cx - k, cy + r)} ${pt(cx, cy + r)} c ${pt(cx + k, cy + r)} ${pt(cx + r, cy + k)} ${pt(cx + r, cy)} c f`;
        } else {
          ops = `${cs} RG ${r3(a.size * 0.13)} w 1 J 1 j ` + markSegs(a).map((seg) => seg.map(([u, v], k) => `${pt(u, v)} ${k ? 'l' : 'm'}`).join(' ') + ' S').join(' ');
        }
        break;
      case 'text': {
        sub = 'FreeText'; pad = 1; delete extra.C;
        const f = await h.font(a.font); const lines = a.text.split('\n');
        let t = `BT /F1 ${r3(a.size)} Tf ${cs} rg `; let w = 0;
        for (let k = 0; k < lines.length; k++) {
          const s = await safeText(lines[k], h.counter); if (!s) continue;
          w = Math.max(w, f.widthOfTextAtSize(s, a.size));
          t += `1 0 0 1 ${pt(a.x, a.y + a.size * (0.8 + 1.2 * k))} Tm ${f.encodeText(s).toString()} Tj `;
        }
        ops = t + 'ET'; res = { Font: { F1: f.ref } }; b.w = Math.max(b.w, w);
        extra.DA = P.PDFString.of(`/Helv ${r3(a.size)} Tf ${cs} rg`); extra.Contents = P.PDFHexString.fromText(a.text); extra.BS = { W: 0 };
        break;
      }
      case 'note': {
        sub = 'Text'; pad = 0; const s = NOTE, x = a.x, y = a.y;
        ops = `${cs} rg 0.35 0.35 0.35 RG 0.8 w ${pt(x, y)} m ${pt(x + s, y)} l ${pt(x + s, y + s * 0.7)} l ${pt(x + s * 0.7, y + s)} l ${pt(x, y + s)} l h B ` +
          `${pt(x + s * 0.2, y + s * 0.32)} m ${pt(x + s * 0.8, y + s * 0.32)} l ${pt(x + s * 0.2, y + s * 0.55)} m ${pt(x + s * 0.6, y + s * 0.55)} l S`;
        extra.Name = 'Comment'; extra.Contents = P.PDFHexString.fromText(a.text || ''); extra.Open = false;
        break;
      }
      case 'image': {
        const im = S.images.get(a.imageId); if (!im) return;
        if (!h.imgs[a.imageId]) h.imgs[a.imageId] = im.mime === 'jpg' ? await out.embedJpg(im.bytes) : await out.embedPng(im.bytes);
        sub = 'Stamp'; pad = 0; delete extra.C;
        ops = `q ${r3(a.w)} 0 0 ${r3(a.h)} ${X(a.x)} ${Y(a.y + a.h)} cm /Im0 Do Q`; res = { XObject: { Im0: h.imgs[a.imageId].ref } };
        delete data.imageId; data.dataUrl = im.dataUrl; data.w0 = im.w0; data.h0 = im.h0;
        break;
      }
      default: return;
    }
    const rect = [X(b.x) - pad, Y(b.y + b.h) - pad, X(b.x + b.w) + pad, Y(b.y) + pad].map(r3);
    const apRef = ctx.register(ctx.stream(ops, { Type: 'XObject', Subtype: 'Form', BBox: rect, Resources: res }));
    const dict = ctx.obj({
      Type: 'Annot', Subtype: sub, Rect: rect, F: 4, AP: { N: apRef },
      T: P.PDFHexString.fromText('BubbyPDF'), NM: P.PDFString.of('bubbypdf-' + a.id), M: P.PDFString.of(pdfDate()),
      ...extra,
    });
    dict.set(P.PDFName.of('BubbyPDFData'), P.PDFHexString.fromText(JSON.stringify(data)));
    pg.node.addAnnot(ctx.register(dict));
  }

  // On open: take BubbyPDF's own annotations back out of the file so they are editable objects again.
  // 'DocbenchData' is the marker written by 1.0/1.1, before the rename; still read it.
  const MARKS = ['BubbyPDFData', 'DocbenchData'].map((s) => [...s].map((c) => c.charCodeAt(0)));
  function hasMarker(b) {
    for (const MARK of MARKS) {
      for (let i = b.indexOf(MARK[0]); i !== -1 && i <= b.length - MARK.length; i = b.indexOf(MARK[0], i + 1)) {
        let k = 1; while (k < MARK.length && b[i + k] === MARK[k]) k++;
        if (k === MARK.length) return true;
      }
    }
    return false;
  }
  async function extractOwnAnnots(bytes) {
    const P = window.PDFLib;
    const ld = await PDFDocument.load(bytes, { updateMetadata: false });
    const ctx = ld.context; const keys = [P.PDFName.of('BubbyPDFData'), P.PDFName.of('DocbenchData')];
    let found = 0;
    const perPage = ld.getPages().map((pg) => {
      const list = []; const arr = pg.node.Annots(); if (!arr) return list;
      for (let i = arr.size() - 1; i >= 0; i--) {
        const raw = arr.get(i); const d = arr.lookup(i);
        if (!(d instanceof P.PDFDict)) continue;
        const data = d.get(keys[0]) || d.get(keys[1]); if (!data) continue;
        try { list.unshift(JSON.parse(data.decodeText())); found++; } catch { continue; }
        arr.remove(i);
        try {
          const ap = d.lookup(P.PDFName.of('AP'));
          const nref = ap && ap.get(P.PDFName.of('N'));
          if (nref instanceof P.PDFRef) {
            const st = ctx.lookup(nref);
            const rs = st && st.dict && st.dict.lookup(P.PDFName.of('Resources'));
            const xo = rs && rs.lookup(P.PDFName.of('XObject'));
            if (xo instanceof P.PDFDict) for (const [, v] of xo.entries()) if (v instanceof P.PDFRef) ctx.delete(v);
            ctx.delete(nref);
          }
        } catch { /* leave the appearance; it is unreferenced now */ }
        if (raw instanceof P.PDFRef) ctx.delete(raw);
      }
      return list;
    });
    if (!found) return { bytes, imported: null };
    return { bytes: await ld.save({ useObjectStreams: false }), imported: perPage };
  }
  function importAnnot(m) {
    const a = { ...m, id: nid() };
    if (a.type === 'image' && a.dataUrl) { a.imageId = addImage(a.dataUrl, a.w0, a.h0); delete a.dataUrl; delete a.w0; delete a.h0; }
    return a;
  }

  // ---------- rasterizing (redaction and printing) ----------
  async function rasterize(bytes, indices, dpi, onPage) {
    const pdf = await pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes.slice() }).promise;
    try {
      for (const i of indices) {
        const pg = await pdf.getPage(i + 1);
        const vp = pg.getViewport({ scale: dpi / 72 });
        const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await pg.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
        await onPage(i, c);
      }
    } finally { pdf.destroy(); }
  }
  // Redaction: each redacted page is replaced by an image of itself with the areas painted black,
  // then every page is copied into a brand-new file, so nothing from the old page content survives.
  async function applyRedactions(out, entries, redacted) {
    try { const f = out.getForm(); if (f.getFields().length) f.flatten(); } catch (e) { console.warn('flatten', e); }
    const mid = await out.save({ useObjectStreams: false });
    const dpi = 200, s = dpi / 72; const images = new Map();
    await rasterize(mid, redacted, dpi, async (i, c) => {
      const ctx = c.getContext('2d'); ctx.setTransform(...mat(entries[i], s)); ctx.fillStyle = '#000';
      for (const a of entries[i].annots) if (a.type === 'redact') ctx.fillRect(a.x - 0.5, a.y - 0.5, a.w + 1, a.h + 1);
      images.set(i, c.toDataURL('image/png'));
    });
    // Rewrite each redacted page in place (so links that point at it still work), then copy
    // everything into a new file. Old content is unreachable, so it is not copied.
    const P = window.PDFLib; const N = (s) => P.PDFName.of(s);
    const src = await PDFDocument.load(mid, { updateMetadata: false });
    for (const [i, url] of images) {
      const pg = src.getPage(i); const [w, h] = dispSize(entries[i], 1);
      const img = await src.embedPng(dataUrlBytes(url));
      for (const k of ['Annots', 'Thumb', 'PieceInfo', 'Metadata', 'B', 'AA', 'StructParents', 'TrimBox', 'BleedBox', 'ArtBox', 'Group']) pg.node.delete(N(k));
      pg.node.set(N('Resources'), src.context.obj({ XObject: { Im0: img.ref } }));
      pg.node.set(N('Contents'), src.context.register(src.context.stream(`q ${r3(w)} 0 0 ${r3(h)} 0 0 cm /Im0 Do Q`)));
      pg.setMediaBox(0, 0, w, h); pg.setCropBox(0, 0, w, h); pg.setRotation(degrees(0));
    }
    await src.flush();
    const fresh = await PDFDocument.create();
    const copied = await fresh.copyPages(src, entries.map((_, i) => i));
    copied.forEach((pg) => fresh.addPage(pg));
    return fresh;
  }

  // ---------- printing ----------
  async function printDoc() {
    commitEdit(); closeNote();
    if (!bench.printPages) { toast('Printing works in the BubbyPDF desktop app.', 'error'); return; }
    busy(true);
    try {
      const { bytes } = await buildPdf(S.pages);
      const pages = [];
      await rasterize(bytes, S.pages.map((_, i) => i), 150, async (i, c) => { pages.push({ dataUrl: c.toDataURL('image/jpeg', 0.92), land: c.width > c.height }); });
      busy(false);
      const r = await bench.printPages(pages);
      if (r && !r.ok && r.reason && !/cancel/i.test(r.reason)) toast(`Printing failed: ${r.reason}`, 'error');
    } catch (e) { toast(e.message || String(e), 'error'); } finally { busy(false); }
  }
  $('#btnPrint').onclick = printDoc;
  const baseName = () => (S.fileName || 'document').replace(/\.pdf$/i, '').replace(/ \(edited\)$/, '');
  // ---------- Save (same file) and Save as ----------
  async function protectBytes(bytes) {
    const pr = S.protect;
    if (!pr || !(pr.userPassword || pr.ownerPassword)) return bytes;
    const d = await PDFDocument.load(bytes, { updateMetadata: false });
    const all = { printing: 'highResolution', modifying: true, copying: true, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: true };
    d.encrypt({ userPassword: pr.userPassword || '', ownerPassword: pr.ownerPassword || pr.userPassword, permissions: { ...all, ...(pr.permissions || {}) } });
    return d.save({ useObjectStreams: false });
  }
  // Build the finished file (redactions applied, password kept). Returns null if the user cancels.
  async function finishPdf(verb) {
    commitEdit(); closeNote();
    if (!S.pages.length) return null;
    const nRed = S.pages.filter((p) => p.annots.some((a) => a.type === 'redact')).length;
    if (nRed) {
      const go = await ask('Apply redactions?',
        `Redacted areas are removed for good in the file you save. ${nRed === 1 ? 'The page with redactions is' : `The ${nRed} pages with redactions are`} saved as ${nRed === 1 ? 'an image' : 'images'}, so ${nRed === 1 ? 'its' : 'their'} text can't be selected or searched.`,
        [{ label: 'Cancel', value: null }, { label: `Apply and ${verb}`, value: 'go', primary: true }]);
      if (!go) return null;
    }
    const res = await buildPdf(S.pages);
    res.bytes = await protectBytes(res.bytes);
    return res;
  }
  function savedMessage(name, res) {
    const notes = [];
    if (res.replaced) notes.push(`${res.replaced} character${res.replaced > 1 ? 's' : ''} no font could show became "?"`);
    if (res.fallbackChars) notes.push(`${res.fallbackChars} new letter${res.fallbackChars > 1 ? 's' : ''} weren't in the original font, so a similar font was used`);
    if (res.overflow) notes.push('an edited paragraph is now longer than before and may overlap the text below it');
    if (res.covered) notes.push('some old text couldn\'t be removed cleanly and was covered with white instead');
    if (S.protect && S.protect.userPassword) notes.push('the file still needs its password to open');
    return `Saved ${name}.` + (notes.length ? ' Note: ' + notes.join('; ') + '.' : '');
  }
  async function saveInPlace() {
    if (!S.pages.length) return false;
    if (!S.filePath || !bench.writeFile) return saveAs();
    busy(true);
    try {
      const res = await finishPdf('save'); if (!res) return false;
      const r = await bench.writeFile(S.filePath, res.bytes);
      if (!r || r.error) { toast(`Couldn't save "${S.fileName}": ${r ? r.error : 'unknown error'}. Use Save as to keep your changes in a new file.`, 'error'); return false; }
      S.dirty = false; bench.setDirty(false); updateTitle();
      toast(savedMessage(r.name, res));
      return true;
    } catch (e) { toast(e.message || String(e), 'error'); return false; } finally { busy(false); }
  }
  async function saveAs() {
    if (!S.pages.length) return false;
    busy(true);
    try {
      const res = await finishPdf('save'); if (!res) return false;
      busy(false);
      const r = await bench.savePdf({ suggestedName: `${baseName()} (edited).pdf`, bytes: res.bytes });
      if (!r) return false;
      // From now on, Save writes to the new file.
      if (r.path) S.filePath = r.path;
      S.fileName = r.name; S.dirty = false; bench.setDirty(false); updateTitle();
      toast(savedMessage(r.name, res));
      return true;
    } catch (e) { toast(e.message || String(e), 'error'); return false; } finally { busy(false); }
  }
  const save = saveAs;

  // ---------- modal, toast, busy ----------
  function modal(children, cls = '') {
    const prev = document.activeElement;
    const box = el('div', { class: 'modal ' + cls, role: 'dialog', 'aria-modal': 'true' }, ...children);
    const root = el('div', { class: 'backdrop' }, box);
    let closed = false;
    const close = () => { if (closed) return; closed = true; root.remove(); document.removeEventListener('keydown', onKey, true); if (prev && prev.focus) prev.focus(); root.dispatchEvent(new Event('closed')); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    root.addEventListener('pointerdown', (e) => { if (e.target === root) close(); });
    $('#modalRoot').append(root);
    const h = box.querySelector('h2'); if (h) { h.id = nid(); box.setAttribute('aria-labelledby', h.id); }
    requestAnimationFrame(() => { const f = box.querySelector('input, textarea, .btn.primary, button'); if (f) f.focus(); });
    return { root, box, close };
  }
  function ask(title, body, buttons) {
    return new Promise((res) => {
      let val = null;
      const { root, close } = modal([el('h2', {}, title), el('p', {}, body), el('div', { class: 'actions' }, ...buttons.map((b) =>
        el('button', { class: 'btn ' + (b.primary ? 'primary' : 'secondary'), onclick: () => { val = b.value; close(); } }, b.label)))]);
      root.addEventListener('closed', () => res(val));
    });
  }
  function askPassword(name, wrong) {
    return new Promise((res) => {
      let val = null;
      const inp = el('input', { type: 'password', 'aria-label': 'Password', autocomplete: 'off' });
      const submit = () => { val = inp.value; close(); };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      const { root, close } = modal([el('h2', {}, 'Password needed'),
        el('p', {}, wrong ? 'That password did not work. Try again.' : `"${name}" is locked. Enter its password to open it.`), inp,
        el('div', { class: 'actions' }, el('button', { class: 'btn secondary', onclick: () => close() }, 'Cancel'), el('button', { class: 'btn primary', onclick: submit }, 'Open'))]);
      root.addEventListener('closed', () => res(val));
    });
  }
  let toastTimer = null;
  function toast(msg, kind, action) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (kind === 'error' ? ' error' : ''); t.hidden = false;
    if (action) {
      const b = el('button', { class: 'toast-act' }, action.label);
      b.onclick = () => { t.hidden = true; action.fn(); };
      t.append(b);
    }
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 6000 : action ? 7000 : 3500);
  }
  function busy(on) { $('#busy').hidden = !on; }

  // ---------- start screen, open, drag and drop ----------
  // Text whose letters came out as boxes, private codes or control characters can't be edited as text.
  function unreadable(t) {
    const cs = [...String(t || '')]; if (cs.length < 3) return false;
    const good = cs.filter((c) => /[\p{L}\p{N}\p{P}\p{Zs}\p{S}]/u.test(c) && !/[-�]/.test(c)).length;
    return good / cs.length < 0.85;
  }
  function forgetText(p) {
    textCache.delete(p.docId + ':' + p.src); blockCache.delete(p.docId + ':' + p.src);
    const pe = pageEls.get(p.key); if (pe) pe.layerKey = null;
  }

  // ---------- Markups panel ----------
  const MK = { highlight: 'Highlight', underline: 'Underline', strike: 'Strikethrough', note: 'Sticky note', text: 'Text', textedit: 'Edited paragraph', ink: 'Drawing', rect: 'Rectangle', whiteout: 'Whiteout', redact: 'Redaction', check: 'Check mark', image: 'Image or signature' };
  function openMarkups() { $('#searchPanel').hidden = true; $('#markupsPanel').hidden = false; renderMarkups(); }
  function renderMarkups() {
    const panel = $('#markupsPanel'); if (!panel || panel.hidden) return;
    const list = $('#mkList'); list.textContent = ''; let n = 0;
    S.pages.forEach((p, i) => {
      if (!p.annots.length) return;
      list.append(el('li', { class: 'grp' }, `Page ${i + 1}`));
      for (const a of p.annots) {
        n++;
        const label = a.type === 'foreign' ? `${(a.subtype || 'Markup').replace(/([a-z])([A-Z])/g, '$1 $2')} · other app` : MK[a.type] || a.type;
        const snippet = (a.text || a.label || '').replace(/\s+/g, ' ').slice(0, 90);
        list.append(el('li', { class: 'mk' + (S.sel === a.id ? ' active' : '') },
          el('button', { class: 'mk-go', onclick: () => { S.sel = a.id; scrollToPage(i); setTool('select'); S.sel = a.id; redrawAll(); renderToolOpts(); renderMarkups(); } },
            el('strong', {}, label), snippet ? el('span', { class: 'muted' }, snippet) : null),
          el('button', { class: 'btn ghost sm icon danger', 'aria-label': `Delete ${label}`, title: 'Delete', html: window.icon('trash', 16), onclick: () => { S.sel = a.id; deleteSelected(); } })));
      }
    });
    $('#mkCount').textContent = n ? `${n} markup${n > 1 ? 's' : ''} in this document` : 'No markups in this document.';
    $('#mkRemoveAll').disabled = !n;
  }
  // Right-click a markup: Delete, or remove them all.
  let ctxMenu = null;
  function closeCtx() { if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; } }
  pagesEl.addEventListener('contextmenu', (e) => {
    const root = e.target.closest('.page'); if (!root) return;
    const p = pageByKey(root.dataset.key); const [u, v] = pagePoint(e, p, root); const a = hit(p, u, v);
    e.preventDefault(); closeCtx();
    if (a) { setTool('select'); S.sel = a.id; redrawAll(); renderToolOpts(); }
    const items = [];
    if (a) items.push([`Delete ${a.type === 'foreign' ? 'this markup' : (MK[a.type] || 'item').toLowerCase()}`, () => deleteSelected()]);
    items.push(['Show all markups', () => openMarkups()]);
    if (S.pages.some((q) => q.annots.length)) items.push(['Remove all markups…', () => confirmRemoveAll()]);
    ctxMenu = el('div', { class: 'ctxmenu', role: 'menu' }, ...items.map(([l, fn]) => el('button', { role: 'menuitem', onclick: () => { closeCtx(); fn(); } }, l)));
    ctxMenu.style.left = Math.min(e.clientX, innerWidth - 220) + 'px'; ctxMenu.style.top = Math.min(e.clientY, innerHeight - 140) + 'px';
    document.body.append(ctxMenu); ctxMenu.querySelector('button').focus();
  });
  document.addEventListener('pointerdown', (e) => { if (ctxMenu && !ctxMenu.contains(e.target)) closeCtx(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtx(); });
  async function confirmRemoveAll() {
    const n = S.pages.reduce((t, q) => t + q.annots.length, 0); if (!n) return;
    const go = await ask('Remove all markups?', `This removes all ${n} highlights, comments, check marks, drawings, text boxes, signatures and other markups, including ones made in other apps. Ctrl+Z brings them back.`,
      [{ label: 'Cancel', value: null }, { label: 'Remove all', value: 'go', primary: true }]);
    if (go) { removeAllMarkups(); renderMarkups(); }
  }

  // ---------- home page ----------
  const home = { view: 'recent', layout: 'list', q: '', list: [] };
  try { home.layout = localStorage.getItem('bubbypdf.layout') === 'grid' ? 'grid' : 'list'; } catch { /* default */ }
  const atHome = () => !$('#start').hidden;
  function showWorkspace(on) {
    $('#start').hidden = on; $('#workspace').hidden = !on;
    document.body.classList.toggle('no-doc', !S.pages.length);
    document.body.classList.toggle('at-home', !on);
    if (on) { setTool('select'); layoutPages(false); renderThumbs(); updateUndoButtons(); }
    else { commitEdit(); closeNote(); renderRecent(); renderResume(); }
  }
  function resumeWorkspace() {
    $('#start').hidden = true; $('#workspace').hidden = false;
    document.body.classList.remove('at-home'); layoutPages(true);
  }
  function renderResume() {
    const has = S.pages.length > 0; $('#resume').hidden = !has; if (!has) return;
    $('#resumeName').textContent = S.fileName || 'Untitled.pdf';
    $('#resumeInfo').textContent = `${S.pages.length} page${S.pages.length > 1 ? 's' : ''}${S.dirty ? ' · unsaved changes' : ''}`;
  }
  const fmtSize = (n) => (!n ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  function fmtDate(t) {
    if (!t) return '';
    const d = new Date(t), now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today, ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
  }
  async function renderRecent(list) {
    if (!list) list = await bench.recent();
    home.list = list;
    const box = $('#recentList'); box.textContent = ''; box.className = 'recent-list ' + home.layout;
    let rows = home.view === 'starred' ? list.filter((r) => r.starred) : list;
    if (home.q) rows = rows.filter((r) => r.name.toLowerCase().includes(home.q));
    $('#recentTitle').textContent = home.view === 'starred' ? 'Starred' : 'Recent';
    const empty = $('#recentEmpty');
    empty.textContent = home.q ? `No files match "${home.q}".` : home.view === 'starred' ? 'Star a file in Recent to keep it here.' : 'Files you open will show up here.';
    empty.hidden = !!rows.length;
    $('#btnClearRecent').hidden = home.view !== 'recent' || !list.some((r) => !r.starred);
    ['viewList', 'viewGrid'].forEach((id) => { const on = (id === 'viewGrid') === (home.layout === 'grid'); $('#' + id).setAttribute('aria-checked', String(on)); $('#' + id).setAttribute('aria-pressed', String(on)); });
    if (home.layout === 'list' && rows.length) {
      box.append(el('div', { class: 'rrow head', role: 'row' }, el('span', { role: 'columnheader' }), el('span', { role: 'columnheader' }, 'Name'),
        el('span', { role: 'columnheader' }, 'Opened'), el('span', { role: 'columnheader' }, 'Size'), el('span', { role: 'columnheader' })));
    }
    for (const r of rows) {
      const thumb = r.thumb ? el('img', { src: r.thumb, alt: '' }) : el('span', { class: 'thumb-ph', html: window.icon('file', 22) });
      const star = el('button', { class: 'btn ghost sm icon star' + (r.starred ? ' on' : ''), 'aria-pressed': String(!!r.starred), 'aria-label': `${r.starred ? 'Unstar' : 'Star'} ${r.name}`, title: r.starred ? 'Unstar' : 'Star', html: window.icon('star', 18) });
      star.addEventListener('click', async (e) => { e.stopPropagation(); renderRecent(await bench.starRecent(r.path, !r.starred)); });
      const row = el('div', { class: 'rrow', role: 'row', tabindex: '0', title: r.path },
        el('span', { class: 'rthumb', role: 'cell' }, thumb),
        el('span', { class: 'rname', role: 'cell' }, el('strong', {}, r.name.replace(/\.pdf$/i, '')), el('span', { class: 'muted' }, 'PDF')),
        el('span', { class: 'rdate', role: 'cell' }, fmtDate(r.openedAt)),
        el('span', { class: 'rsize', role: 'cell' }, fmtSize(r.size)),
        el('span', { class: 'ract', role: 'cell' }, star));
      const open = async () => {
        const f = await bench.readFile(r.path);
        if (f) openFiles([f], { replace: true });
        else { toast(`"${r.name}" was moved or deleted.`, 'error'); renderRecent(await bench.removeRecent(r.path)); }
      };
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      box.append(row);
    }
  }
  async function saveThumbFor(doc) {
    if (!doc || !doc.path || !bench.saveThumb) return;
    try {
      const pg = await doc.pdf.getPage(1); const s = 120 / pg.getViewport({ scale: 1 }).width; const vp = pg.getViewport({ scale: s });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
      await bench.saveThumb(doc.path, c.toDataURL('image/jpeg', 0.8));
    } catch { /* thumbnails are optional */ }
  }
  async function startTool(kind) {
    if (kind === 'combine') { window.BubbyCombine.open(); return; }
    const files = await bench.openPdf(); if (!files.length) return;
    await openFiles(files, { replace: true });
    if (!S.pages.length || atHome()) return;
    if (kind === 'edit') { setTool('edittext'); toast('Click a paragraph to edit it. Press T to add new text.'); }
    else if (kind === 'fill') { setTool('select'); toast('Click a form field to type in it. Press S to sign, K for a check mark.'); }
    else if (kind === 'organize') { thumbsEl.focus(); toast('Drag pages to reorder. Select pages to rotate, extract or delete them.'); }
    else if (kind === 'redact') setTool('redact');
  }
  function applyCombined(pages, { inPlace }) {
    if (inPlace) {
      snap(); S.pages = pages; S.selPages.clear(); S.sel = null; markDirty();
      resumeWorkspace(); layoutPages(false); renderThumbs();
    } else {
      S.pages = pages; S.undo = []; S.redo = []; S.fields = new Map(); S.fsize = new Map(); S.marks = null; S.history = []; S.selPages.clear(); S.sel = null;
      S.fileName = 'Combined.pdf'; S.filePath = null; S.protect = null; textCache.clear(); blockCache.clear(); closeSearch();
      S.dirty = true; bench.setDirty(true); showWorkspace(true); fitWidth();
      const used = new Set(pages.map((q) => q.docId));
      for (const [id, d] of [...S.docs]) if (!used.has(id)) { try { d.pdf.destroy(); } catch { /* gone */ } S.docs.delete(id); }
    }
    updateTitle(); updateUndoButtons();
    toast(`Combined into ${pages.length} page${pages.length === 1 ? '' : 's'}. Save to keep it.`);
  }
  // Drop documents that nothing uses any more (not the open document, not anything Undo can bring back).
  function cleanupDocs(ids) {
    const used = new Set(S.pages.map((q) => q.docId)); const inUndo = S.undo.join('') + S.redo.join('');
    for (const id of ids) {
      if (used.has(id) || inUndo.includes(id)) continue;
      const d = S.docs.get(id); if (d) { try { d.pdf.destroy(); } catch { /* gone */ } S.docs.delete(id); }
    }
  }
  // ---------- tools: drawer, tabs and home grid ----------
  const TAB_CATS = { all: null, edit: ['edit'], convert: ['convert'], sign: ['sign', 'protect'], organize: ['organize'] };
  const TAB_TITLES = { all: 'All tools', edit: 'Edit', convert: 'Convert', sign: 'Sign & protect', organize: 'Organize' };
  let drawerTab = 'all';
  function toolButton(t, cls) {
    const b = el('button', { class: cls, title: t.desc }, el('span', { class: 'tl-ic', html: window.icon(t.icon, 18) }), el('span', { class: 'tl-txt' }, el('strong', {}, t.label), el('span', { class: 'muted' }, t.desc)));
    b.onclick = () => { closeDrawer(); t.run(); };
    return b;
  }
  function renderDrawer() {
    const T = window.BubbyTools; const list = $('#tdList'); list.textContent = '';
    const q = $('#tdSearch').value.trim().toLowerCase();
    const cats = TAB_CATS[drawerTab];
    const tools = T.TOOLS.filter((t) => (!cats || cats.includes(t.cat)) && (!q || (t.label + ' ' + t.desc).toLowerCase().includes(q)));
    $('#tdTitle').textContent = q ? 'Tools' : TAB_TITLES[drawerTab];
    for (const [cat, name] of Object.entries(T.CATS)) {
      const group = tools.filter((t) => t.cat === cat); if (!group.length) continue;
      list.append(el('h3', { class: 'td-cat' }, name), ...group.map((t) => toolButton(t, 'td-tool')));
    }
    if (!tools.length) list.append(el('p', { class: 'muted' }, `No tool matches "${q}".`));
    document.querySelectorAll('.ttab').forEach((b) => b.setAttribute('aria-pressed', String(!$('#toolDrawer').hidden && b.dataset.tab === drawerTab)));
  }
  function openDrawer(tab) {
    const dr = $('#toolDrawer');
    if (!dr.hidden && drawerTab === tab) { closeDrawer(); return; }
    drawerTab = tab; dr.hidden = false; $('#tdSearch').value = ''; renderDrawer(); $('#tdSearch').focus();
  }
  function closeDrawer() { $('#toolDrawer').hidden = true; document.querySelectorAll('.ttab').forEach((b) => b.setAttribute('aria-pressed', 'false')); }
  document.querySelectorAll('.ttab').forEach((b) => b.addEventListener('click', () => openDrawer(b.dataset.tab)));
  $('#tdClose').onclick = closeDrawer;
  $('#tdSearch').addEventListener('input', renderDrawer);
  $('#tdSearch').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); if (e.key === 'Enter') { const f = $('#tdList .td-tool'); if (f) f.click(); } });
  document.addEventListener('pointerdown', (e) => { const dr = $('#toolDrawer'); if (!dr.hidden && !dr.contains(e.target) && !e.target.closest('.ttab') && !e.target.closest('.backdrop')) closeDrawer(); });
  // Home sidebar: every tool, grouped like the tools panel.
  function renderNavTools() {
    const T = window.BubbyTools; const nav = $('#navTools'); if (!nav) return; nav.textContent = '';
    for (const [cat, name] of Object.entries(T.CATS)) {
      const group = T.TOOLS.filter((t) => t.cat === cat); if (!group.length) continue;
      nav.append(el('h4', { class: 'nav-cat' }, name));
      for (const t of group) {
        const b = el('button', { class: 'navitem', role: 'listitem', title: t.desc }, el('span', { html: window.icon(t.icon, 20) }), t.label);
        b.onclick = () => t.run();
        nav.append(b);
      }
    }
  }
  function renderHomeTools() {
    renderNavTools();
    const T = window.BubbyTools; const box = $('#homeTools'); box.textContent = '';
    for (const [cat, name] of Object.entries(T.CATS)) {
      const group = T.TOOLS.filter((t) => t.cat === cat); if (!group.length) continue;
      box.append(el('div', { class: 'htgroup' }, el('h3', {}, name), el('div', { class: 'htlist' }, ...group.map((t) => toolButton(t, 'ht-tool')))));
    }
  }
  $('#btnRead').onclick = () => window.BubbyTools.readAloud();
  $('#btnMarkups').onclick = () => { const pn = $('#markupsPanel'); if (pn.hidden) openMarkups(); else pn.hidden = true; };
  $('#mkClose').onclick = () => { $('#markupsPanel').hidden = true; };
  $('#mkRemoveAll').onclick = confirmRemoveAll;
  window.BubbyTools.init({
    S, el, modal, toast, busy, bench, buildPdf, rasterize, openFiles, ask, snap, markDirty, redrawAll, layoutPages, textItems, forgetText, fmtSize,
    PDFJS_OPTS, guardUnsaved, setTool, atHome, resume: resumeWorkspace, updateTitle, protectBytes, dispSize, dispRot, mat, invert, scrollToPage, printDoc,
    openMarkups, focusPages: () => { thumbsEl.focus(); toast('Drag pages to reorder. Select pages to rotate, extract or delete them.'); },
  });
  renderHomeTools();
  // The All tools card can be folded away; the choice is remembered.
  function setToolsCollapsed(on) {
    const b = $('#toggleAllTools'); $('#homeTools').hidden = on;
    b.setAttribute('aria-expanded', String(!on)); b.querySelector('.ct-label').textContent = on ? 'Show' : 'Hide';
    b.closest('.alltools').classList.toggle('collapsed', on);
    try { localStorage.setItem('bubbypdf.toolsCollapsed', on ? '1' : '0'); } catch { /* not remembered */ }
  }
  $('#toggleAllTools').onclick = () => setToolsCollapsed(!$('#homeTools').hidden);
  try { if (localStorage.getItem('bubbypdf.toolsCollapsed') === '1') setToolsCollapsed(true); } catch { /* default: open */ }

  window.BubbyCombine.init({
    S, loadPdf, nid, el, toast, busy, modal, bench, thumb: drawThumb, fmtSize, guardUnsaved, applyCombined, cleanupDocs,
    showHome: () => showWorkspace(false), resume: resumeWorkspace,
  });
  $('#btnClearRecent').onclick = async () => { renderRecent(await bench.clearRecent()); };
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    home.view = b.dataset.view;
    document.querySelectorAll('[data-view]').forEach((x) => x.toggleAttribute('aria-current', x === b));
    if (b === document.querySelector('[data-view]') || true) document.querySelectorAll('[data-view]').forEach((x) => { if (x === b) x.setAttribute('aria-current', 'page'); });
    renderRecent(home.list);
  }));
  document.querySelectorAll('[data-start-tool]').forEach((b) => b.addEventListener('click', () => startTool(b.dataset.startTool)));
  $('#recentSearch').addEventListener('input', (e) => { home.q = e.target.value.trim().toLowerCase(); renderRecent(home.list); });
  const setLayout = (l) => { home.layout = l; try { localStorage.setItem('bubbypdf.layout', l); } catch { /* fine */ } renderRecent(home.list); };
  $('#viewList').onclick = () => setLayout('list'); $('#viewGrid').onclick = () => setLayout('grid');
  $('#btnHome').setAttribute('data-needs-doc', '');
  $('#btnHome').onclick = () => showWorkspace(false);
  $('#btnResume').onclick = resumeWorkspace;
  const doOpen = async () => openFiles(await bench.openPdf(), { replace: true });
  $('#navComputer').onclick = doOpen;
  $('#btnOpen').onclick = doOpen; $('#btnOpenBig').onclick = doOpen;
  $('#btnAdd').onclick = () => window.BubbyCombine.open({ fromWorkspace: true });
  $('#btnSave').onclick = saveInPlace;
  $('#btnSaveAs').onclick = saveAs;

  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
    const files = [...e.dataTransfer.files].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!files.length) { toast('Only PDF files can be opened.', 'error'); return; }
    const entries = await Promise.all(files.map(async (f) => ({ name: f.name, path: bench.pathForFile(f), bytes: new Uint8Array(await f.arrayBuffer()) })));
    if (document.body.classList.contains('in-combine')) { window.BubbyCombine.addFiles(entries); return; }
    if (atHome() && entries.length > 1) window.BubbyCombine.open({ files: entries });
    else openFiles(entries, { replace: !S.pages.length || atHome() });
  });

  // ---------- theme ----------
  const THEMES = ['system', 'light', 'dark'];
  function applyTheme(t) {
    if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
    const b = $('#btnTheme'); b.innerHTML = window.icon(t === 'dark' ? 'moon' : t === 'light' ? 'sun' : 'auto');
    b.title = `Theme: ${t}`; b.setAttribute('aria-label', `Theme: ${t}. Click to change.`);
  }
  let theme = 'system';
  try { theme = localStorage.getItem('bubbypdf.theme') || 'system'; } catch {}
  applyTheme(theme);
  $('#btnTheme').onclick = () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % 3]; try { localStorage.setItem('bubbypdf.theme', theme); } catch {} applyTheme(theme); };

  // ---------- keyboard ----------
  const TOOL_KEYS = { v: 'select', t: 'text', e: 'edittext', k: 'check', s: 'sign', h: 'highlight', u: 'underline', x: 'strike', n: 'note', d: 'draw', r: 'rect', w: 'whiteout', b: 'redact', i: 'image' };
  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
    const mod = e.ctrlKey || e.metaKey; const k = e.key.toLowerCase();
    if (document.body.classList.contains('in-combine')) return;
    if (mod && k === 'o') { e.preventDefault(); doOpen(); return; }
    if (!S.pages.length || atHome()) return;
    if (mod && k === 's') { e.preventDefault(); if (e.shiftKey) saveAs(); else saveInPlace(); return; }
    if (mod && k === 'f') { e.preventDefault(); openSearch(); return; }
    if (mod && k === 'p') { e.preventDefault(); printDoc(); return; }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); setZoom(S.zoom * 1.2); return; }
    if (mod && k === '-') { e.preventDefault(); setZoom(S.zoom / 1.2); return; }
    if (mod && k === '0') { e.preventDefault(); fitWidth(); return; }
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); return; }
    if (typing) return;
    if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
    if (e.key === 'Escape') { if (S.sel) { S.sel = null; redrawAll(); renderToolOpts(); } else setTool('select'); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) { e.preventDefault(); deleteSelected(); return; }
    if (S.sel && e.key.startsWith('Arrow')) {
      e.preventDefault(); const st = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -st : e.key === 'ArrowRight' ? st : 0, dy = e.key === 'ArrowUp' ? -st : e.key === 'ArrowDown' ? st : 0;
      editSel((a) => shiftAnnot(a, JSON.parse(JSON.stringify(a)), dx, dy));
      return;
    }
    if (!mod && !e.altKey && TOOL_KEYS[k]) { setTool(TOOL_KEYS[k]); return; }
    if (e.key === 'PageDown') { e.preventDefault(); scrollToPage(Math.min(S.pages.length - 1, S.current + 1)); }
    if (e.key === 'PageUp') { e.preventDefault(); scrollToPage(Math.max(0, S.current - 1)); }
  });
  window.addEventListener('resize', () => { if (S.pages.length) updateCurrent(); });

  // ---------- close guard and startup ----------
  bench.onCloseRequest(async () => {
    const r = await ask('Unsaved changes', 'You have unsaved changes. Save a copy before closing?', [
      { label: 'Cancel', value: null }, { label: "Don't save", value: 'discard' }, { label: 'Save a copy', value: 'save', primary: true }]);
    if (r === 'discard') bench.closeNow();
    else if (r === 'save' && (await saveInPlace())) bench.closeNow();
  });
  bench.onOpenFile((f) => openFiles([f], { replace: !S.pages.length }));
  window.addEventListener('beforeunload', (e) => { if (bench.web && S.dirty) { e.preventDefault(); e.returnValue = ''; } });

  document.querySelectorAll('[data-icon]').forEach((n) => { if (!n.innerHTML.trim()) n.innerHTML = window.icon(n.dataset.icon, n.classList.contains('drop-mark') ? 40 : 20); });
  showWorkspace(false);
  bench.initialFile().then((f) => { if (f) openFiles([f], { replace: true }); });

  // Test hooks (used by test/ui-test.html; harmless in the app).
  window.__bubbypdf = { finishEdit: (ed) => { ed.blur(); if (S.editor && S.editor.ta === ed) commitEdit(); }, S, __protect: (b) => protectBytes(b), deleteSelected, pvReady, openMarkups, renderMarkups, setFieldSize, unreadable, openDrawer, saveInPlace, saveAs, applyCombined, buildPdf, openFiles, snapRects, rasterize, hasMarker, textBlocks, editBlock, setTool, layoutPages, save, textItems, undo, redo, rotatePages, deletePages, insertBlank, runSearch: async (q) => { openSearch(); searchInput.value = q; await runSearch(); return S.search.results.length; } };
})();
