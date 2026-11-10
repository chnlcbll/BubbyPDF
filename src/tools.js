'use strict';
/* BubbyPDF tools: conversions, protect, compress, split, watermark, page numbers, repair, export,
   text recognition (OCR) and read aloud. Everything runs on this computer. */
(() => {
  let D = null;
  const L = () => window.PDFLib;
  const enc = new TextEncoder();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const xesc = (s) => esc(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const abs = (rel) => new URL(rel, location.href).href;
  const base = () => (D.S.fileName || 'document').replace(/\.pdf$/i, '').replace(/ \(edited\)$/, '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const r2 = (v) => Math.round(v * 100) / 100;

  // ---------- progress dialog ----------
  function progress(title) {
    const bar = D.el('div', { class: 'pbar' }, D.el('span'));
    const text = D.el('p', { class: 'muted pstatus' }, 'Starting…');
    let cancelled = false;
    const { close, root } = D.modal([D.el('h2', {}, title), bar, text,
      D.el('div', { class: 'actions' }, D.el('button', { class: 'btn secondary', onclick: () => { cancelled = true; text.textContent = 'Stopping…'; } }, 'Cancel'))]);
    return {
      set(frac, msg) { bar.firstChild.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%'; if (msg) text.textContent = msg; },
      get cancelled() { return cancelled; },
      close() { close(); }, root,
    };
  }
  function done(msg, result) {
    // result: { path } from a save. Offer to show it.
    D.toast(msg, '', result && result.path && D.bench.showInFolder ? { label: 'Show in folder', fn: () => D.bench.showInFolder(result.path) } : null);
  }
  async function needDoc() {
    if (D.S.pages.length && !D.atHome()) return true;
    if (D.S.pages.length) { D.resume(); return true; }
    const files = await D.bench.openPdf(); if (!files.length) return false;
    await D.openFiles(files, { replace: true });
    return !!D.S.pages.length;
  }
  // The document as it would be saved: edits, signatures, markups, redactions, watermarks.
  async function builtBytes() { const r = await D.buildPdf(D.S.pages); return r.bytes; }
  async function withBuiltDoc(fn) {
    const bytes = await builtBytes();
    const pdf = await window.pdfjsLib.getDocument({ ...D.PDFJS_OPTS, data: bytes.slice() }).promise;
    try { return await fn(pdf, bytes); } finally { pdf.destroy(); }
  }
  async function saveAs(kind, name, bytes) {
    if (window.__bubbyTestSave) return window.__bubbyTestSave(kind, name, bytes); // automated tests only
    const r = await D.bench.saveFile({ suggestedName: name, bytes, kind });
    return r;
  }

  // ---------- reading a page: paragraphs with formatting, and images ----------
  function familyOf(n) {
    if (/mono|courier|consol/i.test(n)) return 'mono';
    if (/sans|arial|helvet|verdana|calibri|segoe|tahoma/i.test(n)) return 'sans';
    if (/serif|times|roman|georgia|garamond|minion|cambria|book/i.test(n)) return 'serif';
    return 'sans';
  }
  async function pageParagraphs(page) {
    const [x0, , , y1] = page.view;
    const tc = await page.getTextContent();
    try { await page.getOperatorList(); } catch { /* names only */ }
    const items = [];
    for (const it of tc.items) {
      if (!it.str) continue;
      const [a, b, c, d, e, f] = it.transform;
      if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01) continue;
      const size = it.height || Math.hypot(c, d); if (!size) continue;
      let fname = ''; try { if (page.commonObjs.has(it.fontName)) fname = page.commonObjs.get(it.fontName).name || ''; } catch { /* none */ }
      const st = tc.styles[it.fontName] || {};
      items.push({ str: it.str, x: e - x0, y: y1 - f, w: it.width, size, bold: /bold|black|heavy|semibold|demi/i.test(fname), italic: /italic|oblique/i.test(fname), fam: familyOf(fname + ' ' + (st.fontFamily || '')) });
    }
    items.sort((p, q) => p.y - q.y || p.x - q.x);
    const lines = [];
    for (const it of items) {
      if (!it.str.trim()) { const l = lines[lines.length - 1]; if (l && Math.abs(l.y - it.y) < it.size * 0.4) l.trailingSpace = true; continue; }
      const l = lines.find((q) => Math.abs(q.y - it.y) < Math.min(q.size, it.size) * 0.4 && it.x >= q.x + q.w - q.size * 0.4 && it.x - (q.x + q.w) < q.size * 4);
      if (l) {
        const gap = it.x - (l.x + l.w);
        const sp = (gap > l.size * 0.12 || l.trailingSpace) && !/\s$/.test(l.text) ? ' ' : '';
        l.runs.push({ t: sp + it.str, b: it.bold, i: it.italic, sz: it.size, fam: it.fam }); l.text += sp + it.str; l.w = it.x + it.w - l.x; l.trailingSpace = false;
        if (gap > l.size * 1.6) l.cells.push({ x: it.x, t: it.str }); else l.cells[l.cells.length - 1].t += sp + it.str;
      } else lines.push({ x: it.x, y: it.y, w: it.w, size: it.size, text: it.str, runs: [{ t: it.str, b: it.bold, i: it.italic, sz: it.size, fam: it.fam }], cells: [{ x: it.x, t: it.str }] });
    }
    lines.sort((p, q) => p.y - q.y || p.x - q.x);
    const MARK = /^\s*([-–—•◦▪●*·]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s+/;
    const paras = [];
    for (const l of lines) {
      const m = MARK.exec(l.text); if (m) l.marker = m[1];
      const p = paras[paras.length - 1];
      const last = p && p.lines[p.lines.length - 1];
      const bold = l.runs.every((r) => r.b);
      if (p && !l.marker && l.y - last.y > last.size * 0.5 && l.y - last.y < last.size * 1.8 && Math.abs(l.size - last.size) < last.size * 0.15 && bold === p.bold && Math.abs(l.x - (p.lines.length > 1 ? last.x : (last.marker ? last.x + last.size * 1.5 : last.x))) < last.size * 4) {
        p.lines.push(l);
      } else paras.push({ lines: [l], bold, y: l.y, size: l.size, x: l.x });
    }
    for (const p of paras) {
      const runs = [];
      p.lines.forEach((l, i) => {
        if (i) { const lr = runs[runs.length - 1]; if (lr && /-$/.test(lr.t)) { /* hyphen: join */ } else if (lr) lr.t += ' '; }
        for (const r of l.runs) { const q = runs[runs.length - 1]; if (q && q.b === r.b && q.i === r.i && Math.abs(q.sz - r.sz) < 0.6) q.t += r.t; else runs.push({ ...r }); }
      });
      if (p.lines[0].marker) { const k = MARK.exec(runs[0].t); if (k) runs[0].t = runs[0].t.slice(k[0].length); p.marker = p.lines[0].marker; }
      p.runs = runs.filter((r) => r.t.length);
      p.text = p.runs.map((r) => r.t).join('');
      const xs = p.lines.map((l) => l.x), rs = p.lines.map((l) => l.x + l.w);
      p.align = p.lines.length > 2 && Math.max(...rs.slice(0, -1)) - Math.min(...rs.slice(0, -1)) < p.size * 0.5 ? 'both'
        : p.lines.length > 1 && Math.max(...xs) - Math.min(...xs) > p.size && Math.max(...rs) - Math.min(...rs) < p.size * 0.5 ? 'right' : 'left';
    }
    const sizes = paras.flatMap((p) => p.lines.map((l) => l.size)).sort((a, b) => a - b);
    const body = sizes[Math.floor(sizes.length / 2)] || 11;
    for (const p of paras) p.heading = p.size >= body * 1.45 ? 1 : p.size >= body * 1.18 || (p.bold && p.lines.length === 1 && p.text.length < 80 && !p.marker) ? 2 : 0;
    return { paras, lines, body };
  }
  // Images drawn on a page, with where they sit (top-left page units).
  async function pageImages(page, minPx = 24) {
    const OPS = window.pdfjsLib.OPS; const ops = await page.getOperatorList();
    const [x0, , , y1] = page.view; const out = [];
    let ctm = [1, 0, 0, 1, 0, 0]; const stack = [];
    const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i]; const args = ops.argsArray[i];
      if (fn === OPS.save) stack.push(ctm.slice());
      else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) ctm = mul(args, ctm);
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
        let img = null;
        try { img = fn === OPS.paintInlineImageXObject ? args[0] : await new Promise((res) => { const id = args[0]; const objs = id.startsWith('g_') ? page.commonObjs : page.objs; objs.get(id, res); }); } catch { img = null; }
        if (!img || img.width < minPx || img.height < minPx) continue;
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]]);
        const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const g = c.getContext('2d');
        if (img.bitmap) g.drawImage(img.bitmap, 0, 0);
        else if (img.data) {
          const id = g.createImageData(img.width, img.height); const src = img.data; const dst = id.data;
          if (src.length === img.width * img.height * 4) dst.set(src);
          else if (src.length === img.width * img.height * 3) { for (let s = 0, d = 0; s < src.length; s += 3, d += 4) { dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; dst[d + 3] = 255; } }
          else if (img.kind === 1) { const rowB = (img.width + 7) >> 3; for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) { const bit = (src[y * rowB + (x >> 3)] >> (7 - (x & 7))) & 1; const k = (y * img.width + x) * 4; dst[k] = dst[k + 1] = dst[k + 2] = bit ? 255 : 0; dst[k + 3] = 255; } }
          else continue;
          g.putImageData(id, 0, 0);
        } else continue;
        out.push({ canvas: c, x: Math.min(...xs) - x0, y: y1 - Math.max(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
      }
    }
    return out;
  }
  const canvasBytes = (c, type = 'image/png', q = 0.92) => new Promise((res) => c.toBlob(async (b) => res(new Uint8Array(await b.arrayBuffer())), type, q));

  // ---------- zip helpers ----------
  const zip = (files) => window.fflate.zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? enc.encode(v) : v])), { level: 6 });
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

  // ======================================================================
  // Exact layout: each page keeps its graphics (lines, tables, shading, pictures, stamps, form
  // fields) as a background, and every piece of text sits on top of it as real, editable text in
  // the same place, font, size, colour, bold and italic.
  // ======================================================================
  const FONT_MAP = [
    [/arial|helvetica|liberationsans|nimbussans|arimo/i, 'Arial'], [/timesnewroman|times|liberationserif|nimbusroman|tinos/i, 'Times New Roman'],
    [/couriernew|courier|liberationmono|nimbusmono|cousine/i, 'Courier New'], [/calibri|carlito/i, 'Calibri'], [/cambria|caladea/i, 'Cambria'], [/verdana/i, 'Verdana'],
    [/tahoma/i, 'Tahoma'], [/georgia/i, 'Georgia'], [/garamond/i, 'Garamond'], [/segoeui/i, 'Segoe UI'], [/trebuchet/i, 'Trebuchet MS'],
    [/bookantiqua/i, 'Book Antiqua'], [/centurygothic/i, 'Century Gothic'], [/consolas/i, 'Consolas'], [/symbol/i, 'Symbol'], [/wingdings/i, 'Wingdings'],
    [/aptos/i, 'Aptos'], [/candara/i, 'Candara'], [/constantia/i, 'Constantia'], [/corbel/i, 'Corbel'], [/franklin/i, 'Franklin Gothic Medium'],
    [/palatino/i, 'Palatino Linotype'], [/lucidaconsole/i, 'Lucida Console'], [/comicsans/i, 'Comic Sans MS'], [/impact/i, 'Impact'],
  ];
  function realFont(name, fam) {
    const n = String(name || '').replace(/^[A-Z]{6}\+/, '');
    const flat = n.replace(/[\s,_-]/g, '').replace(/(PSMT|MT|PS)$/i, '');
    for (const [re, f] of FONT_MAP) if (re.test(flat)) return f;
    const core = n.replace(/[,-](Bold|Italic|Oblique|Regular|Roman|Light|Medium|Semibold|SemiBold|Black|BoldItalic|BoldOblique|Book|Heavy)+.*$/i, '').replace(/(PSMT|MT|PS)$/i, '');
    if (core && /^[A-Za-z][A-Za-z0-9 ]+$/.test(core) && !/^(g_d\d|F\d+|T\d|TT\d|C\d)/i.test(core)) return core.replace(/([a-z])([A-Z])/g, '$1 $2');
    return fam === 'serif' ? 'Times New Roman' : fam === 'mono' ? 'Courier New' : 'Arial';
  }
  const hex2 = (n) => n.toString(16).padStart(2, '0');
  // The colour of a piece of text: the pixels that differ between the page with and without its
  // text are the ink. Returns null when nothing was drawn there (invisible text, like a scan's
  // recognised-text layer).
  function inkOf(withText, noText, dims, s, x, y, w, h) {
    const px = Math.max(0, Math.floor(x * s)), py = Math.max(0, Math.floor(y * s));
    const pw = Math.min(dims.w - px, Math.ceil(w * s)), ph = Math.min(dims.h - py, Math.ceil(h * s));
    if (pw <= 0 || ph <= 0) return null;
    let best = 0, col = null, count = 0;
    for (let yy = py; yy < py + ph; yy++) {
      for (let xx = px; xx < px + pw; xx++) {
        const k = (yy * dims.w + xx) * 4;
        const d = Math.abs(withText[k] - noText[k]) + Math.abs(withText[k + 1] - noText[k + 1]) + Math.abs(withText[k + 2] - noText[k + 2]);
        if (d > 60) count++;
        if (d > best) { best = d; col = [withText[k], withText[k + 1], withText[k + 2]]; }
      }
    }
    if (count < 2 || !col) return null;
    // dark greys are anti-aliased black
    if (col[0] < 70 && col[1] < 70 && col[2] < 70 && Math.max(...col) - Math.min(...col) < 18) return '000000';
    return col.map(hex2).join('').toUpperCase();
  }
  // Text pieces of a page with their exact place and look; and the page's graphics without the text.
  async function pageLayout(page, scale = 2) {
    const vp = page.getViewport({ scale });
    const cw = Math.ceil(vp.width), ch = Math.ceil(vp.height);
    const render = async (annots, noText) => {
      const c = document.createElement('canvas'); c.width = cw; c.height = ch;
      const g = c.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#fff'; g.fillRect(0, 0, cw, ch);
      if (noText) {
        // leave out upright text only: turned or sideways text stays part of the picture
        const fill = g.fillText.bind(g), stroke = g.strokeText.bind(g);
        const upright = () => { const m = g.getTransform(); return m.a > 0 && m.d > 0 && Math.abs(m.b) <= m.a * 0.02 && Math.abs(m.c) <= m.d * 0.02; };
        g.fillText = (...x) => { if (!upright()) fill(...x); };
        g.strokeText = (...x) => { if (!upright()) stroke(...x); };
      }
      const AM = window.pdfjsLib.AnnotationMode;
      await page.render({ canvasContext: g, viewport: vp, annotationMode: annots ? AM.ENABLE : AM.DISABLE }).promise;
      return c;
    };
    const W = vp.width / scale, H = vp.height / scale;
    const full = await render(true, false);
    const plain = await render(false, false), bare = await render(false, true);
    const gC = bare.getContext('2d');
    const a = full.getContext('2d').getImageData(0, 0, cw, ch).data;
    const B = plain.getContext('2d').getImageData(0, 0, cw, ch).data;
    const C = gC.getImageData(0, 0, cw, ch); const c = C.data;
    const noText = new Uint8ClampedArray(c);
    // background = page without text + everything annotations draw (form fields, stamps, notes, signatures)
    for (let k = 0; k < a.length; k += 4) if (a[k] !== B[k] || a[k + 1] !== B[k + 1] || a[k + 2] !== B[k + 2]) { c[k] = a[k]; c[k + 1] = a[k + 1]; c[k + 2] = a[k + 2]; }
    gC.putImageData(C, 0, 0);
    // text positions as the page is shown (turned pages included), top-left origin
    const vp1 = page.getViewport({ scale: 1 }); const U = window.pdfjsLib.Util;
    const tc = await page.getTextContent(); try { await page.getOperatorList(); } catch { /* names */ }
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const m = U.transform(vp1.transform, it.transform);
      const size = Math.hypot(m[2], m[3]) || it.height; if (!size) continue;
      if (m[0] <= 0 || Math.abs(m[1]) > size * 0.05 || Math.abs(m[2]) > size * 0.05) continue; // not upright as shown
      let fname = ''; try { if (page.commonObjs.has(it.fontName)) fname = page.commonObjs.get(it.fontName).name || ''; } catch { /* none */ }
      const st = tc.styles[it.fontName] || {};
      const fam = familyOf(fname + ' ' + (st.fontFamily || ''));
      items.push({ t: it.str, x: m[4], base: m[5], w: it.width, sz: size, b: /bold|black|heavy|semibold|demi/i.test(fname), i: /italic|oblique/i.test(fname), font: realFont(fname, fam) });
    }
    items.sort((p, q) => p.base - q.base || p.x - q.x);
    // lines, then segments: a big gap starts a new segment (table cells, columns, tab stops)
    const segs = [];
    for (const it of items) {
      const sg = segs.find((s) => Math.abs(s.base - it.base) < Math.min(s.sz, it.sz) * 0.35 && it.x >= s.x + s.w - s.sz * 0.3 && it.x - (s.x + s.w) < s.sz * 1.0);
      const run = { t: it.t, b: it.b, i: it.i, sz: it.sz, font: it.font };
      if (sg) {
        const gap = it.x - (sg.x + sg.w);
        if (gap > sg.sz * 0.12 && !/\s$/.test(sg.runs[sg.runs.length - 1].t) && !/^\s/.test(it.t)) sg.runs[sg.runs.length - 1].t += ' ';
        const last = sg.runs[sg.runs.length - 1];
        if (last.b === run.b && last.i === run.i && last.font === run.font && Math.abs(last.sz - run.sz) < 0.3) last.t += run.t; else sg.runs.push(run);
        sg.w = it.x + it.w - sg.x;
      } else segs.push({ x: it.x, base: it.base, w: it.w, sz: it.sz, runs: [run] });
    }
    // the colour of each segment's ink; skip text nobody can see
    const dims = { w: cw, h: ch };
    const visible = [];
    for (const sg of segs) {
      const col = inkOf(B, noText, dims, scale, sg.x, sg.base - sg.sz * 0.85, Math.max(2, sg.w), sg.sz * 1.05);
      if (!col) continue;
      for (const r of sg.runs) r.color = col;
      visible.push(sg);
    }
    return { w: W, h: H, bg: bare, segs: visible };
  }
  // How much to tighten or loosen letters so the text is as wide in Word/PowerPoint as in the PDF.
  const mctx2 = document.createElement('canvas').getContext('2d');
  function naturalWidth(sg) {
    let w = 0;
    for (const r of sg.runs) { mctx2.font = `${r.i ? 'italic ' : ''}${r.b ? 'bold ' : ''}${r.sz}px "${r.font}", Arial, sans-serif`; w += mctx2.measureText(r.t).width; }
    return w;
  }
  function letterAdjust(sg) {
    const chars = sg.runs.reduce((t, r) => t + [...r.t].length, 0); if (chars < 2) return 0;
    const diff = (sg.w - naturalWidth(sg)) / (chars - 1);
    return Math.max(-2, Math.min(2, diff)); // points per character
  }
  async function exactPages(pr) {
    return withBuiltDoc(async (pdf) => {
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        if (pr && pr.cancelled) return null;
        pr && pr.set((i - 1) / pdf.numPages, `Reading page ${i} of ${pdf.numPages}…`);
        const L2 = await pageLayout(await pdf.getPage(i));
        L2.bgPng = await canvasBytes(L2.bg, 'image/png');
        L2.bg = null;
        pages.push(L2);
      }
      return pages;
    });
  }
  // where the top of a line box sits above the baseline, as a share of the font size
  const EX = { wordAscent: 0.94, pptAscent: 0.93 };
  function docxExact(pages) {
    const tw = (v) => Math.round(v * 20); const emu = (v) => Math.round(v * 12700);
    const media = {}; const body = [];
    const sect = (pg) => `<w:sectPr><w:pgSz w:w="${tw(pg.w)}" w:h="${tw(pg.h)}"${pg.w > pg.h ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;
    const tiny = '<w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>';
    pages.forEach((pg, pi) => {
      const n = pi + 1;
      media[`word/media/page${n}.png`] = pg.bgPng;
      const pic = `<w:r><w:rPr><w:noProof/><w:sz w:val="2"/></w:rPr><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${n}" behindDoc="1" locked="1" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="${emu(pg.w)}" cy="${emu(pg.h)}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${n}" name="Page ${n} background"/><wp:cNvGraphicFramePr/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="page${n}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdPage${n}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(pg.w)}" cy="${emu(pg.h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;
      const isLast = pi === pages.length - 1;
      const segs = pg.segs.slice().sort((p, q) => p.base - q.base || p.x - q.x);
      const paras = segs.map((sg, k) => {
        const next = segs.find((o, j) => j !== k && Math.abs(o.base - sg.base) < sg.sz * 0.4 && o.x > sg.x);
        const room = (next ? next.x : pg.w) - sg.x;
        const width = Math.max(room - 1, sg.w * 1.15 + sg.sz);
        const top = sg.base - sg.sz * EX.wordAscent;
        const adj = letterAdjust(sg);
        const runs = sg.runs.map((r) => `<w:r><w:rPr><w:rFonts w:ascii="${xesc(r.font)}" w:hAnsi="${xesc(r.font)}" w:cs="${xesc(r.font)}"/>${r.b ? '<w:b/>' : ''}${r.i ? '<w:i/>' : ''}<w:color w:val="${r.color}"/>${Math.abs(adj) > 0.02 ? `<w:spacing w:val="${Math.round(adj * 20)}"/>` : ''}<w:sz w:val="${Math.round(r.sz * 2)}"/><w:szCs w:val="${Math.round(r.sz * 2)}"/></w:rPr><w:t xml:space="preserve">${xesc(r.t)}</w:t></w:r>`).join('');
        return `<w:p><w:pPr><w:framePr w:w="${tw(width)}" w:wrap="none" w:hAnchor="page" w:vAnchor="page" w:x="${tw(sg.x)}" w:y="${tw(Math.max(0, top))}"/><w:spacing w:before="0" w:after="0" w:line="${tw(sg.sz * 1.2)}" w:lineRule="exact"/><w:ind w:left="0" w:right="0" w:firstLine="0"/><w:jc w:val="left"/></w:pPr>${runs}</w:p>`;
      });
      // the background rides on a tiny first paragraph of the page
      body.push(`<w:p><w:pPr>${tiny}<w:rPr><w:sz w:val="2"/></w:rPr></w:pPr>${pic}</w:p>`);
      body.push(...paras);
      // every page ends with its own section, so it keeps its own size and starts a new page
      if (!isLast) body.push(`<w:p><w:pPr>${tiny}${sect(pg)}<w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>`);
    });
    const rels = pages.map((_, pi) => `<Relationship Id="rIdPage${pi + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/page${pi + 1}.png"/>`).join('');
    return zip({
      '[Content_Types].xml': XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>',
      '_rels/.rels': XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      'word/_rels/document.xml.rels': XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>${rels}</Relationships>`,
      'word/settings.xml': XML + '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>',
      'word/styles.xml': XML + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>',
      'word/document.xml': XML + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body.join('')}${sect(pages[pages.length - 1])}</w:body></w:document>`,
      ...media,
    });
  }
  function pptxExact(pages) {
    const emu = (v) => Math.round(v * 12700);
    const slides = pages.map((pg) => {
      let shapes = ''; let sid = 3;
      for (const sg of pg.segs) {
        const top = sg.base - sg.sz * EX.pptAscent; const adj = letterAdjust(sg);
        const runs = sg.runs.map((r) => `<a:r><a:rPr lang="en-US" sz="${Math.round(r.sz * 100)}"${r.b ? ' b="1"' : ''}${r.i ? ' i="1"' : ''}${Math.abs(adj) > 0.02 ? ` spc="${Math.round(adj * 100)}"` : ''} dirty="0"><a:solidFill><a:srgbClr val="${r.color}"/></a:solidFill><a:latin typeface="${xesc(r.font)}"/><a:cs typeface="${xesc(r.font)}"/></a:rPr><a:t>${xesc(r.t)}</a:t></a:r>`).join('');
        shapes += `<p:sp><p:nvSpPr><p:cNvPr id="${sid}" name="Text ${sid}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(sg.x)}" y="${emu(Math.max(0, top))}"/><a:ext cx="${emu(Math.max(4, sg.w * 1.05 + sg.sz * 0.5))}" cy="${emu(sg.sz * 1.25)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t" anchorCtr="0"><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr marL="0" indent="0" algn="l"><a:lnSpc><a:spcPct val="100000"/></a:lnSpc><a:spcBef><a:spcPts val="0"/></a:spcBef><a:spcAft><a:spcPts val="0"/></a:spcAft><a:buNone/></a:pPr>${runs}</a:p></p:txBody></p:sp>`;
        sid++;
      }
      return { png: pg.bgPng, shapes };
    });
    const pg0 = pages[0];
    return pptxFile(slides, Math.max(914400, Math.min(51206400, emu(pg0.w))), Math.max(914400, Math.min(51206400, emu(pg0.h))));
  }
  function htmlExact(pages) {
    const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
    let body = '';
    pages.forEach((pg, pi) => {
      // SVG text sits exactly on its baseline and keeps its exact width; it can still be selected, copied and searched
      let texts = '';
      for (const sg of pg.segs) {
        const one = sg.runs.length === 1 ? sg.runs[0] : null;
        const st = (r) => `font-family="'${esc(r.font)}', Arial, sans-serif" font-size="${r2(r.sz)}"${r.b ? ' font-weight="bold"' : ''}${r.i ? ' font-style="italic"' : ''} fill="#${r.color}"`;
        const inner = one ? esc(one.t) : sg.runs.map((r) => `<tspan ${st(r)}>${esc(r.t)}</tspan>`).join('');
        texts += `<text x="${r2(sg.x)}" y="${r2(sg.base)}" ${st(sg.runs[0])}${sg.w > sg.sz && naturalWidth(sg) > 0 ? ` textLength="${r2(sg.w)}" lengthAdjust="spacing"` : ''}>${inner}</text>`;
      }
      body += `<section class="pg" style="width:${r2(pg.w)}pt;height:${r2(pg.h)}pt" aria-label="Page ${pi + 1}"><img src="data:image/png;base64,${b64(pg.bgPng)}" alt="" style="width:${r2(pg.w)}pt;height:${r2(pg.h)}pt"><svg viewBox="0 0 ${r2(pg.w)} ${r2(pg.h)}" width="${r2(pg.w)}pt" height="${r2(pg.h)}pt" preserveAspectRatio="none" style="width:${r2(pg.w)}pt;height:${r2(pg.h)}pt" xmlns="http://www.w3.org/2000/svg">${texts}</svg></section>`;
    });
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(base())}</title><style>body{margin:0;background:#e9e5df;padding:16px}.pg{position:relative;margin:0 auto 16px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);overflow:hidden}.pg img,.pg svg{position:absolute;left:0;top:0}.pg text{white-space:pre}@media print{body{background:none;padding:0}.pg{margin:0;box-shadow:none;break-after:page}}</style></head><body>${body}</body></html>`;
  }
  // Ask once per conversion: exact layout (default) or flowing text.
  function askMode(what) {
    return new Promise((res) => {
      const pick = D.el('div', { class: 'modechoice', role: 'radiogroup', 'aria-label': 'Layout' });
      const opt = (v, title, desc, on) => { const r = D.el('input', { type: 'radio', name: 'cvmode', value: v, id: 'cv' + v }); r.checked = on; pick.append(D.el('label', { class: 'modeopt', for: 'cv' + v }, r, D.el('span', {}, D.el('strong', {}, title), D.el('span', { class: 'muted' }, desc)))); };
      opt('exact', 'Exact layout (recommended)', `Looks exactly like the PDF. Every line of text stays editable in ${what}; lines, tables, shading and pictures stay where they are.`, true);
      opt('flow', 'Flowing text', 'Paragraphs, headings and lists that rewrap as you type. Easier to rewrite, but the page layout changes.', false);
      let v = null;
      const { root, close } = D.modal([D.el('h2', {}, `Convert to ${what}`), pick, D.el('div', { class: 'actions' }, D.el('button', { class: 'btn secondary', onclick: () => close() }, 'Cancel'), D.el('button', { class: 'btn primary', onclick: () => { v = pick.querySelector('input:checked').value; close(); } }, 'Convert'))], 'wide');
      root.addEventListener('closed', () => res(v));
    });
  }
  async function exactExport(kind) {
    const what = { docx: 'Word', pptx: 'PowerPoint', html: 'HTML' }[kind];
    const pr = progress(`Converting to ${what}`);
    try {
      const pages = await exactPages(pr); if (!pages) { pr.close(); return; }
      pr.set(0.97, 'Writing the file…');
      const out = kind === 'docx' ? docxExact(pages) : kind === 'pptx' ? pptxExact(pages) : enc.encode(htmlExact(pages));
      pr.close();
      const r = await saveAs(kind, `${base()}.${kind}`, out);
      const rotated = pages.filter((p) => p.rotated).length;
      if (r) done(`Saved ${r.name}. It looks like the PDF, and the text can be edited.${rotated ? ` ${rotated} turned page${rotated > 1 ? 's were' : ' was'} kept as a picture.` : ''}`, r);
      return out;
    } catch (e) { pr.close(); D.toast(`Could not convert to ${what}: ${e.message || e}`, 'error'); }
  }

  // ---------- PDF to Word (.docx) ----------
  async function toWord(o) {
    if (!(await needDoc())) return;
    const mode = (o && o.mode) || await askMode('Word'); if (!mode) return;
    if (mode === 'exact') return exactExport('docx');
    const pr = progress('Converting to Word');
    try {
      const res = await withBuiltDoc(async (pdf) => {
        const media = {}; let imgN = 0; const body = [];
        let pageW = 612, pageH = 792;
        for (let i = 1; i <= pdf.numPages; i++) {
          if (pr.cancelled) return null;
          pr.set((i - 1) / pdf.numPages, `Reading page ${i} of ${pdf.numPages}…`);
          const page = await pdf.getPage(i);
          if (i === 1) { const v = page.getViewport({ scale: 1 }); pageW = v.width; pageH = v.height; }
          const { paras } = await pageParagraphs(page);
          const imgs = await pageImages(page);
          const items = [...paras.map((p) => ({ y: p.y - p.size, p })), ...imgs.map((im) => ({ y: im.y, im }))].sort((a, b) => a.y - b.y);
          for (const it of items) {
            if (it.p) {
              const p = it.p;
              const style = p.heading === 1 ? '<w:pStyle w:val="Heading1"/>' : p.heading === 2 ? '<w:pStyle w:val="Heading2"/>' : '';
              const ind = p.marker ? '<w:ind w:left="567" w:hanging="283"/>' : '';
              let runs = p.marker ? `<w:r><w:t xml:space="preserve">${xesc(p.marker)}</w:t></w:r><w:r><w:tab/></w:r>` : '';
              for (const r of p.runs) {
                const rp = `${r.b ? '<w:b/>' : ''}${r.i ? '<w:i/>' : ''}<w:sz w:val="${Math.round(r.sz * 2)}"/>`;
                runs += `<w:r><w:rPr>${rp}</w:rPr><w:t xml:space="preserve">${xesc(r.t)}</w:t></w:r>`;
              }
              body.push(`<w:p><w:pPr>${style}${ind}<w:jc w:val="${p.align}"/><w:spacing w:after="120"/></w:pPr>${runs}</w:p>`);
            } else {
              const im = it.im; imgN++;
              const bytes = await canvasBytes(im.canvas);
              media[`word/media/image${imgN}.png`] = bytes;
              const maxW = (pageW - 144) * 12700; let cx = Math.round(im.w * 12700), cy = Math.round(im.h * 12700);
              if (cx > maxW) { cy = Math.round(cy * maxW / cx); cx = Math.round(maxW); }
              body.push(`<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${imgN}" name="Picture ${imgN}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${imgN}" name="image${imgN}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg${imgN}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`);
            }
          }
          if (i < pdf.numPages) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
        }
        const rels = Object.keys(media).map((k, n) => `<Relationship Id="rIdImg${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${k.split('/').pop()}"/>`).join('');
        const tw = (v) => Math.round(v * 20);
        return zip({
          '[Content_Types].xml': XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
          '_rels/.rels': XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
          'word/_rels/document.xml.rels': XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${rels}</Relationships>`,
          'word/styles.xml': XML + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/></w:rPr></w:style></w:styles>',
          'word/document.xml': XML + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="${tw(pageW)}" w:h="${tw(pageH)}"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`,
          ...media,
        });
      });
      pr.close(); if (!res) return;
      const r = await saveAs('docx', `${base()}.docx`, res);
      if (r) done(`Saved ${r.name}. The text flows as paragraphs, headings and lists, with bold, italic and pictures.`, r);
      return res;
    } catch (e) { pr.close(); D.toast('Could not convert to Word: ' + (e.message || e), 'error'); }
  }

  // ---------- PDF to Excel (.xlsx) ----------
  function colName(n) { let s = ''; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
  function sheetXml(rows) {
    const out = rows.map((cells, ri) => `<row r="${ri + 1}">${cells.map((v, ci) => {
      if (v == null || v === '') return '';
      const ref = colName(ci) + (ri + 1); const t = String(v).trim();
      const num = /^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(t) ? Number(t.replace(/,/g, '')) : null;
      return num != null && Number.isFinite(num) ? `<c r="${ref}"><v>${num}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xesc(t)}</t></is></c>`;
    }).join('')}</row>`).join('');
    return XML + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${out}</sheetData></worksheet>`;
  }
  function xlsxFile(sheets) {
    const files = {
      '[Content_Types].xml': XML + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
      '_rels/.rels': XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml': XML + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xesc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      'xl/styles.xml': XML + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>',
    };
    sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s.rows); });
    return zip(files);
  }
  async function toExcel() {
    if (!(await needDoc())) return;
    const pr = progress('Converting to Excel');
    try {
      const res = await withBuiltDoc(async (pdf) => {
        const sheets = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          if (pr.cancelled) return null;
          pr.set((i - 1) / pdf.numPages, `Reading page ${i} of ${pdf.numPages}…`);
          const { lines } = await pageParagraphs(await pdf.getPage(i));
          // columns: cluster the start of every cell on the page
          const starts = lines.flatMap((l) => l.cells.map((c) => c.x)).sort((a, b) => a - b);
          const cols = [];
          for (const x of starts) { const c = cols[cols.length - 1]; if (c && x - c.max < 8) { c.max = x; c.n++; } else cols.push({ min: x, max: x, n: 1 }); }
          const colOf = (x) => { let best = 0, bd = Infinity; cols.forEach((c, k) => { const d = x < c.min ? c.min - x : x > c.max ? x - c.max : 0; if (d < bd) { bd = d; best = k; } }); return best; };
          const rows = lines.map((l) => { const r = []; for (const c of l.cells) { const k = colOf(c.x); r[k] = r[k] ? r[k] + ' ' + c.t : c.t; } return r; });
          sheets.push({ name: `Page ${i}`, rows });
        }
        return xlsxFile(sheets);
      });
      pr.close(); if (!res) return;
      const r = await saveAs('xlsx', `${base()}.xlsx`, res);
      if (r) done(`Saved ${r.name}. Each page is a sheet; numbers became real numbers.`, r);
      return res;
    } catch (e) { pr.close(); D.toast('Could not convert to Excel: ' + (e.message || e), 'error'); }
  }

  // ---------- PDF to PowerPoint (.pptx): one slide per page ----------
  const THEME = '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="BubbyPDF"><a:themeElements><a:clrScheme name="BubbyPDF"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="C2410C"/></a:accent1><a:accent2><a:srgbClr val="EA580C"/></a:accent2><a:accent3><a:srgbClr val="9A3412"/></a:accent3><a:accent4><a:srgbClr val="FB923C"/></a:accent4><a:accent5><a:srgbClr val="1F4FD1"/></a:accent5><a:accent6><a:srgbClr val="1E7B45"/></a:accent6><a:hlink><a:srgbClr val="1F4FD1"/></a:hlink><a:folHlink><a:srgbClr val="7A3FC2"/></a:folHlink></a:clrScheme><a:fontScheme name="BubbyPDF"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="BubbyPDF"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>';
  function pptxFile(slides, cx, cy) {
    const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
    const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const spTree = (inner) => `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${inner}</p:spTree>`;
    const files = {
      '[Content_Types].xml': XML + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`,
      '_rels/.rels': XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
      'ppt/presentation.xml': XML + `<p:presentation ${P} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rIdS${i + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle></p:presentation>`,
      'ppt/_rels/presentation.xml.rels': XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rIdT" Type="${REL}/theme" Target="theme/theme1.xml"/><Relationship Id="rIdP" Type="${REL}/presProps" Target="presProps.xml"/><Relationship Id="rIdV" Type="${REL}/viewProps" Target="viewProps.xml"/><Relationship Id="rIdTS" Type="${REL}/tableStyles" Target="tableStyles.xml"/>${slides.map((_, i) => `<Relationship Id="rIdS${i + 1}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`,
      'ppt/presProps.xml': XML + `<p:presentationPr ${P}/>`,
      'ppt/viewProps.xml': XML + `<p:viewPr ${P}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`,
      'ppt/tableStyles.xml': XML + '<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>',
      'ppt/theme/theme1.xml': XML + THEME,
      'ppt/slideMasters/slideMaster1.xml': XML + `<p:sldMaster ${P}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${spTree('')}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2000"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`,
      'ppt/slideMasters/_rels/slideMaster1.xml.rels': XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`,
      'ppt/slideLayouts/slideLayout1.xml': XML + `<p:sldLayout ${P} type="blank" preserve="1"><p:cSld name="Blank">${spTree('')}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels': XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    };
    slides.forEach((sl, i) => {
      const n = i + 1; const png = sl.png || sl; const shapes = sl.shapes || '';
      files[`ppt/media/image${n}.png`] = png;
      files[`ppt/slides/slide${n}.xml`] = XML + `<p:sld ${P}><p:cSld>${spTree(`<p:pic><p:nvPicPr><p:cNvPr id="2" name="Page ${n}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>${shapes}`)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
      files[`ppt/slides/_rels/slide${n}.xml.rels`] = XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/image" Target="../media/image${n}.png"/></Relationships>`;
    });
    return zip(files);
  }
  async function toPowerPoint() {
    if (!(await needDoc())) return;
    return exactExport('pptx');
  }

  // ---------- PDF to HTML, Markdown and text ----------
  async function docModel(onPage) {
    return withBuiltDoc(async (pdf) => {
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        onPage && onPage(i, pdf.numPages);
        const page = await pdf.getPage(i);
        pages.push({ ...(await pageParagraphs(page)), images: await pageImages(page) });
      }
      return pages;
    });
  }
  const runsHtml = (runs) => runs.map((r) => { let t = esc(r.t); if (r.b) t = `<strong>${t}</strong>`; if (r.i) t = `<em>${t}</em>`; return t; }).join('');
  async function toHtml(o) {
    if (!(await needDoc())) return;
    const mode = (o && o.mode) || await askMode('HTML'); if (!mode) return;
    if (mode === 'exact') return exactExport('html');
    const pr = progress('Converting to HTML');
    try {
      const pages = await docModel((i, n) => pr.set((i - 1) / n, `Reading page ${i} of ${n}…`));
      let body = '';
      for (const [k, pg] of pages.entries()) {
        const items = [...pg.paras.map((p) => ({ y: p.y - p.size, p })), ...pg.images.map((im) => ({ y: im.y, im }))].sort((a, b) => a.y - b.y);
        body += `<section class="page" aria-label="Page ${k + 1}">`;
        let list = false;
        for (const it of items) {
          if (it.p && it.p.marker) { if (!list) { body += '<ul>'; list = true; } body += `<li>${runsHtml(it.p.runs)}</li>`; continue; }
          if (list) { body += '</ul>'; list = false; }
          if (it.p) {
            const p = it.p; const tag = p.heading === 1 ? 'h1' : p.heading === 2 ? 'h2' : 'p';
            body += `<${tag}${p.align !== 'left' ? ` style="text-align:${p.align === 'both' ? 'justify' : p.align}"` : ''}>${runsHtml(p.runs)}</${tag}>`;
          } else {
            const b64 = it.im.canvas.toDataURL('image/png');
            body += `<img src="${b64}" alt="" style="width:${Math.round(it.im.w)}pt;max-width:100%">`;
          }
        }
        if (list) body += '</ul>';
        body += '</section>';
      }
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(base())}</title><style>body{font:16px/1.55 system-ui,"Segoe UI",sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1d1b18}section.page{border-bottom:1px solid #ddd;padding-bottom:1.5rem;margin-bottom:1.5rem}img{display:block;margin:1rem 0}</style></head><body>${body}</body></html>`;
      pr.close();
      const r = await saveAs('html', `${base()}.html`, enc.encode(html));
      if (r) done(`Saved ${r.name}.`, r);
      return html;
    } catch (e) { pr.close(); D.toast('Could not convert to HTML: ' + (e.message || e), 'error'); }
  }
  async function toMarkdown() {
    if (!(await needDoc())) return;
    const pr = progress('Converting to Markdown');
    try {
      const pages = await docModel((i, n) => pr.set((i - 1) / n, `Reading page ${i} of ${n}…`));
      const md = pages.map((pg) => pg.paras.map((p) => {
        const t = p.runs.map((r) => { let s = r.t.replace(/([*_`#\\])/g, '\\$1'); if (r.b && s.trim()) s = `**${s.trim()}** `; if (r.i && s.trim()) s = `_${s.trim()}_ `; return s; }).join('').replace(/\s+/g, ' ').trim();
        if (p.marker) return (/\d/.test(p.marker) ? '1. ' : '- ') + t;
        if (p.heading === 1) return '# ' + t; if (p.heading === 2) return '## ' + t;
        return t;
      }).join('\n\n')).join('\n\n---\n\n') + '\n';
      pr.close();
      const r = await saveAs('md', `${base()}.md`, enc.encode(md));
      if (r) done(`Saved ${r.name}.`, r);
      return md;
    } catch (e) { pr.close(); D.toast('Could not convert to Markdown: ' + (e.message || e), 'error'); }
  }
  async function toText() {
    if (!(await needDoc())) return;
    const pr = progress('Exporting text');
    try {
      const pages = await docModel((i, n) => pr.set((i - 1) / n, `Reading page ${i} of ${n}…`));
      const txt = pages.map((pg, i) => `--- Page ${i + 1} ---\n` + pg.lines.map((l) => l.text).join('\n')).join('\n\n') + '\n';
      pr.close();
      const r = await saveAs('txt', `${base()}.txt`, enc.encode(txt));
      if (r) done(`Saved ${r.name}.`, r);
      return txt;
    } catch (e) { pr.close(); D.toast('Could not export text: ' + (e.message || e), 'error'); }
  }

  // ---------- pages as images, and the pictures inside ----------
  async function toImages() {
    if (!(await needDoc())) return;
    const fmt = D.el('select', { id: 'imgFmt' }, D.el('option', { value: 'png' }, 'PNG'), D.el('option', { value: 'jpg' }, 'JPG'));
    const dpi = D.el('select', { id: 'imgDpi' }, ...[[72, 'Screen (72 dpi)'], [150, 'Standard (150 dpi)'], [300, 'High (300 dpi)']].map(([v, l]) => D.el('option', { value: v }, l)));
    dpi.value = '150';
    const which = D.el('select', { id: 'imgWhich' }, D.el('option', { value: 'pages' }, 'Every page as an image'), D.el('option', { value: 'images' }, 'Only the pictures inside the PDF'));
    const go = await new Promise((res) => {
      const { root, close } = D.modal([D.el('h2', {}, 'Save as images'), D.el('div', { class: 'form' },
        D.el('label', { for: 'imgWhich' }, 'What to save'), which, D.el('label', { for: 'imgFmt' }, 'Format'), fmt, D.el('label', { for: 'imgDpi' }, 'Quality'), dpi),
      D.el('div', { class: 'actions' }, D.el('button', { class: 'btn secondary', onclick: () => { close(); } }, 'Cancel'), D.el('button', { class: 'btn primary', onclick: () => { res(true); close(); } }, 'Choose folder'))]);
      root.addEventListener('closed', () => res(false));
    });
    if (!go) return;
    const folder = await D.bench.pickFolder(); if (!folder) return;
    const pr = progress('Saving images'); let count = 0;
    try {
      const type = fmt.value === 'jpg' ? 'image/jpeg' : 'image/png'; const ext = fmt.value;
      if (which.value === 'pages') {
        const bytes = await builtBytes(); const n = D.S.pages.length;
        await D.rasterize(bytes, D.S.pages.map((_, i) => i), +dpi.value, async (i, c) => {
          if (pr.cancelled) throw new Error('cancelled');
          pr.set(i / n, `Page ${i + 1} of ${n}…`);
          if (await D.bench.writeInFolder({ token: folder.token, name: `${base()} page ${String(i + 1).padStart(3, '0')}.${ext}`, bytes: await canvasBytes(c, type) })) count++;
        });
      } else {
        await withBuiltDoc(async (pdf) => {
          for (let i = 1; i <= pdf.numPages; i++) {
            if (pr.cancelled) throw new Error('cancelled');
            pr.set((i - 1) / pdf.numPages, `Looking for pictures on page ${i}…`);
            const imgs = await pageImages(await pdf.getPage(i), 32);
            for (const [k, im] of imgs.entries()) if (await D.bench.writeInFolder({ token: folder.token, name: `${base()} p${i} picture ${k + 1}.${ext}`, bytes: await canvasBytes(im.canvas, type) })) count++;
          }
        });
      }
      pr.close();
      done(count ? `Saved ${count} image${count > 1 ? 's' : ''} in ${folder.path}.` : 'No pictures were found in this PDF.', count ? { path: folder.path } : null);
      return count;
    } catch (e) { pr.close(); if (e.message !== 'cancelled') D.toast('Could not save images: ' + (e.message || e), 'error'); }
  }

  // ---------- making PDFs from other files ----------
  async function openResult(bytes, name) {
    await D.openFiles([{ name, path: null, bytes }], { replace: true });
    D.S.dirty = true; D.bench.setDirty(true); D.updateTitle();
  }
  const PRINT_CSS = '@page{size:A4;margin:18mm}body{font:11pt/1.45 Calibri,"Segoe UI",Arial,sans-serif;color:#000}img{max-width:100%}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #999;padding:3px 6px;vertical-align:top}h1,h2,h3{page-break-after:avoid}';
  async function htmlPdf(html, opts = {}) {
    const r = await D.bench.htmlToPdf({ html, cssPageSize: true, ...opts });
    if (!r || r.error) throw new Error(r ? r.error : 'conversion failed');
    return r.bytes;
  }
  async function viaOffice(file) {
    if (!D.bench.officeToPdf) return null;
    const r = await D.bench.officeToPdf({ name: file.name, bytes: file.bytes });
    if (!r || r.missing) return null;
    if (r.error) throw new Error(r.error);
    return { bytes: r.bytes, how: r.how || 'office' };
  }
  const PT = (v) => `${r2(v)}pt`;
  // Word puts some things at exact places on the page: text frames and pictures anchored to the
  // page or margin. Mark them in the file, then put them in place after the layout.
  const WNS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const WPNS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
  function markPositioned(bytes) {
    let files; try { files = window.fflate.unzipSync(bytes); } catch { return { bytes, frames: [], anchors: [] }; }
    const raw = files['word/document.xml']; if (!raw) return { bytes, frames: [], anchors: [] };
    const text = new TextDecoder().decode(raw); const lrpb = text.includes('lastRenderedPageBreak');
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return { bytes, frames: [], anchors: [], lrpb };
    const frames = [], anchors = []; let bid = 990000;
    const mark = (name) => { const b = doc.createElementNS(WNS, 'w:bookmarkStart'); b.setAttributeNS(WNS, 'w:id', String(bid++)); b.setAttributeNS(WNS, 'w:name', name); return b; };
    const wa = (e, n) => e.getAttributeNS(WNS, n) ?? e.getAttribute('w:' + n);
    for (const f of [...doc.getElementsByTagNameNS(WNS, 'framePr')]) {
      const pPr = f.parentNode; const p = pPr && pPr.parentNode; if (!p || p.localName !== 'p') continue;
      if (wa(f, 'dropCap') && wa(f, 'dropCap') !== 'none') continue;
      const k = frames.length;
      frames.push({ x: wa(f, 'x'), y: wa(f, 'y'), w: wa(f, 'w'), h: wa(f, 'hAnchor') || 'column', v: wa(f, 'vAnchor') || 'margin', xAlign: wa(f, 'xAlign'), yAlign: wa(f, 'yAlign') });
      p.insertBefore(mark('bbf' + k), pPr.nextSibling);
    }
    for (const an of [...doc.getElementsByTagNameNS(WPNS, 'anchor')]) {
      const pos = (tag) => { const e = an.getElementsByTagNameNS(WPNS, tag)[0]; if (!e) return null; const o = e.getElementsByTagNameNS(WPNS, 'posOffset')[0]; const al = e.getElementsByTagNameNS(WPNS, 'align')[0]; return { rel: e.getAttribute('relativeFrom'), off: o ? +o.textContent / 12700 : null, align: al ? al.textContent : null }; };
      let r = an; while (r && r.localName !== 'r') r = r.parentNode;
      if (!r || !r.parentNode) continue;
      const k = anchors.length;
      anchors.push({ h: pos('positionH'), v: pos('positionV'), behind: an.getAttribute('behindDoc') === '1', wrapNone: !!an.getElementsByTagNameNS(WPNS, 'wrapNone')[0] });
      r.parentNode.insertBefore(mark('bba' + k), r);
    }
    if (!frames.length && !anchors.length) return { bytes, frames, anchors, lrpb };
    files['word/document.xml'] = enc.encode(new XMLSerializer().serializeToString(doc));
    return { bytes: window.fflate.zipSync(files), frames, anchors, lrpb };
  }
  function placePositioned(body, prep) {
    const PX = 96 / 72;
    const secOf = (el) => el && el.closest('section.docx');
    const pad = (sec) => { const cs = getComputedStyle(sec); return { l: parseFloat(cs.paddingLeft) || 0, t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0 }; };
    for (const sec of body.querySelectorAll('section.docx')) { sec.style.position = 'relative'; sec.style.zIndex = '0'; }
    // measure everything first, then move, so one move does not shift the next
    const moves = [];
    prep.frames.forEach((f, k) => {
      const m = body.querySelector(`[id="bbf${k}"]`); const p = m && m.closest('p'); const sec = secOf(p); if (!p || !sec) return;
      const P = pad(sec); const sr = sec.getBoundingClientRect(); const pr = p.getBoundingClientRect();
      const w = f.w ? (+f.w / 20) * PX : null;
      let left = pr.left - sr.left, top = pr.top - sr.top;
      if (f.x != null) left = (f.h === 'page' ? 0 : P.l) + (+f.x / 20) * PX;
      else if (f.xAlign && w) left = f.xAlign === 'right' ? (f.h === 'page' ? sr.width : sr.width - P.r) - w : f.xAlign === 'center' ? (f.h === 'page' ? sr.width / 2 : P.l + (sr.width - P.l - P.r) / 2) - w / 2 : (f.h === 'page' ? 0 : P.l);
      if (f.y != null) top = (f.v === 'page' ? 0 : f.v === 'margin' ? P.t : top) + (+f.y / 20) * PX;
      moves.push(() => { Object.assign(p.style, { position: 'absolute', left: left + 'px', top: top + 'px', margin: '0', zIndex: '1' }); if (w) p.style.width = w + 'px'; });
    });
    prep.anchors.forEach((a, k) => {
      const m = body.querySelector(`[id="bba${k}"]`); if (!m) return;
      let run = m.nextElementSibling; const box = run && (run.matches('div') ? run : run.querySelector('div')); const sec = secOf(box); if (!box || !sec) return;
      if (a.behind) moves.push(() => { box.style.zIndex = '-1'; if (!box.style.position) box.style.position = 'relative'; });
      const fixedH = a.h && (a.h.rel === 'page' || a.h.rel === 'margin') && a.h.off != null;
      const fixedV = a.v && (a.v.rel === 'page' || a.v.rel === 'margin') && a.v.off != null;
      if (!a.wrapNone && !a.behind) return;
      if (!fixedH && !fixedV) return;
      const P = pad(sec); const sr = sec.getBoundingClientRect(); const br = box.getBoundingClientRect();
      const left = fixedH ? (a.h.rel === 'page' ? 0 : P.l) + a.h.off * PX : br.left - sr.left;
      const top = fixedV ? (a.v.rel === 'page' ? 0 : P.t) + a.v.off * PX : br.top - sr.top;
      moves.push(() => Object.assign(box.style, { position: 'absolute', left: left + 'px', top: top + 'px' }));
    });
    for (const mv of moves) mv();
  }
  // Word without Microsoft Word or LibreOffice: the document is laid out page by page with its own
  // page size, margins, fonts, tables, headers and footers, then printed.
  async function wordToPdf(file, opts = {}) {
    const off = opts.builtIn ? null : await viaOffice(file); if (off) return off;
    if (!/\.docx$/i.test(file.name)) throw new Error('Only .docx files can be converted without Microsoft Word or LibreOffice. Open it in Word and save it as .docx, or install LibreOffice (free).');
    const host = D.el('div', { 'aria-hidden': 'true', style: 'position:fixed;left:-100000px;top:0;width:2000px;visibility:hidden' });
    const styleBox = D.el('div'); host.append(styleBox); const body = D.el('div'); host.append(body);
    document.body.append(host);
    try {
      const prep = markPositioned(file.bytes);
      await window.docx.renderAsync(prep.bytes.slice().buffer, body, styleBox, {
        className: 'docx', inWrapper: false, ignoreWidth: false, ignoreHeight: false, ignoreFonts: false, breakPages: true,
        ignoreLastRenderedPageBreak: !prep.lrpb, experimental: true, trimXmlDeclaration: true, useBase64URL: true,
        renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, renderComments: false,
      });
      const sections = [...body.querySelectorAll('section.docx')];
      if (!sections.length) throw new Error('This Word file has no pages.');
      placePositioned(body, prep);
      // pages that follow each other with the same size are printed together; each run on its own paper
      const ptOf = (v, d) => { const m = /^([\d.]+)(pt|px|in|cm|mm)?$/.exec(String(v || '').trim()); if (!m) return d; const n = +m[1]; return ({ pt: n, px: n * 0.75, in: n * 72, cm: n * 72 / 2.54, mm: n * 72 / 25.4 })[m[2] || 'px']; };
      const runs = [];
      for (const s of sections) {
        const w = ptOf(s.style.width, 612), h = ptOf(s.style.minHeight || s.style.height, 792);
        const last = runs[runs.length - 1];
        if (last && Math.abs(last.w - w) < 0.5 && Math.abs(last.h - h) < 0.5) last.secs.push(s); else runs.push({ w, h, secs: [s] });
      }
      const head = `<meta charset="utf-8">${styleBox.innerHTML}`;
      const P = L(); const out = await P.PDFDocument.create();
      for (const run of runs) {
        const css = `@page{size:${run.w}pt ${run.h}pt;margin:0}html,body{margin:0;padding:0;background:#fff}` +
          `section.docx{box-shadow:none!important;margin:0!important;box-sizing:border-box;overflow:hidden;width:${run.w}pt!important;height:${run.h - 0.5}pt!important;min-height:0!important;break-after:page;page-break-after:always}` +
          'section.docx:last-child{break-after:auto;page-break-after:auto}';
        const html = `<!doctype html><html><head>${head}<style>${css}</style></head><body>${run.secs.map((s) => s.outerHTML).join('')}</body></html>`;
        const part = await P.PDFDocument.load(await htmlPdf(html, { cssPageSize: true, pageSize: { width: run.w / 72, height: run.h / 72 }, margins: { marginType: 'none' } }));
        for (const pg of await out.copyPages(part, part.getPageIndices())) out.addPage(pg);
      }
      return { bytes: await out.save(), how: 'built-in' };
    } finally { host.remove(); }
  }
  // Excel without Microsoft Excel or LibreOffice: every sheet with its column widths, row heights,
  // fonts, fills, borders, merged cells, alignment and number formats, on its own paper and orientation.
  const OFFICE_THEME = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47'];
  function themeColors(wb) {
    try {
      const t = wb._themes && Object.values(wb._themes)[0]; if (!t) return OFFICE_THEME;
      const doc = new DOMParser().parseFromString(t, 'application/xml');
      const pick = (tag) => { const e = doc.getElementsByTagName('a:' + tag)[0]; if (!e) return null; const c = e.firstElementChild; return c && (c.getAttribute('lastClr') || c.getAttribute('val')); };
      const out = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'].map((k, i) => pick(k) || OFFICE_THEME[i]);
      return out;
    } catch { return OFFICE_THEME; }
  }
  function xlColor(c, theme) {
    if (!c) return null;
    let hex = null;
    if (c.argb) hex = String(c.argb).slice(-6);
    else if (c.theme != null && theme[c.theme]) hex = theme[c.theme];
    else if (c.indexed != null) hex = ({ 8: '000000', 9: 'FFFFFF', 10: 'FF0000', 11: '00FF00', 12: '0000FF', 13: 'FFFF00', 14: 'FF00FF', 15: '00FFFF', 64: null })[c.indexed] || null;
    if (!hex) return null;
    let [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const t = c.tint || 0;
    if (t) { const f = (v) => Math.round(t < 0 ? v * (1 + t) : v + (255 - v) * t); [r, g, b] = [f(r), f(g), f(b)]; }
    return '#' + [r, g, b].map(hex2).join('');
  }
  const BORDER = { thin: '1px solid', hair: '1px solid', dotted: '1px dotted', dashed: '1px dashed', medium: '2px solid', mediumDashed: '2px dashed', dashDot: '1px dashed', mediumDashDot: '2px dashed', dashDotDot: '1px dotted', slantDashDot: '2px dashed', thick: '3px solid', double: '3px double' };
  async function excelToPdf(file, opts = {}) {
    const off = opts.builtIn ? null : await viaOffice(file); if (off) return off;
    if (!/\.xlsx$|\.xlsm$/i.test(file.name)) {
      // older formats: values only
      const wb = window.XLSX.read(file.bytes, { type: 'array' });
      const parts = wb.SheetNames.map((n) => `<h2>${esc(n)}</h2>${window.XLSX.utils.sheet_to_html(wb.Sheets[n], { header: '', footer: '' })}`);
      return { bytes: await htmlPdf(`<!doctype html><html><head><meta charset="utf-8"><style>${PRINT_CSS.replace('size:A4', 'size:A4 landscape')} h2{font-size:12pt;margin:0 0 6px} h2:not(:first-child){page-break-before:always} td{font-size:9pt}</style></head><body>${parts.join('')}</body></html>`), how: 'built-in' };
    }
    const wb = new window.ExcelJS.Workbook();
    await wb.xlsx.load(file.bytes.slice().buffer);
    const theme = themeColors(wb);
    const shown = window.XLSX.read(file.bytes, { type: 'array', cellNF: true, cellStyles: false }); // for numbers formatted as Excel shows them
    const sheetsOut = [];
    const PAPER = { 1: [8.5, 11], 5: [8.5, 14], 8: [11.69, 16.54], 9: [8.27, 11.69], 11: [5.83, 8.27] };
    let sheetNo = 0;
    wb.eachSheet((ws) => {
      if (ws.state && ws.state !== 'visible') return;
      const sj = shown.Sheets[ws.name] || {};
      // the used range
      let maxR = 0, maxC = 0;
      ws.eachRow({ includeEmpty: false }, (row, r) => { row.eachCell({ includeEmpty: false }, (cell, c) => { if (cell.value != null && cell.value !== '' || (cell.fill && cell.fill.pattern && cell.fill.pattern !== 'none') || cell.border && Object.keys(cell.border).length) { maxR = Math.max(maxR, r); maxC = Math.max(maxC, c); } }); });
      let r0 = 1, c0 = 1;
      const pa = ws.pageSetup && ws.pageSetup.printArea;
      if (pa && /^\$?[A-Z]+\$?\d+:\$?[A-Z]+\$?\d+$/.test(pa.split(',')[0])) {
        const [a, b] = pa.split(',')[0].replace(/\$/g, '').split(':');
        const dec = window.XLSX.utils.decode_cell; const A = dec(a), B = dec(b);
        r0 = A.r + 1; c0 = A.c + 1; maxR = B.r + 1; maxC = B.c + 1;
      }
      if (!maxR || !maxC) return;
      sheetNo++;
      // merges
      const master = new Map(), covered = new Set();
      for (const m of (ws.model.merges || [])) {
        const [a, b] = m.split(':'); const A = window.XLSX.utils.decode_cell(a), B = window.XLSX.utils.decode_cell(b || a);
        master.set(`${A.r + 1},${A.c + 1}`, { rs: B.r - A.r + 1, cs: B.c - A.c + 1 });
        for (let r = A.r + 1; r <= B.r + 1; r++) for (let c = A.c + 1; c <= B.c + 1; c++) if (r !== A.r + 1 || c !== A.c + 1) covered.add(`${r},${c}`);
      }
      const defW = (ws.properties && ws.properties.defaultColWidth) || 8.43;
      const defH = (ws.properties && ws.properties.defaultRowHeight) || 15;
      const cols = [];
      for (let c = c0; c <= maxC; c++) { const col = ws.getColumn(c); if (col.hidden) continue; cols.push({ c, px: Math.round(((col.width || defW) * 7 + 5)) }); }
      const totalPx = cols.reduce((t, x) => t + x.px, 0);
      const ps = ws.pageSetup || {};
      const land = ps.orientation === 'landscape';
      let [pw, ph] = PAPER[ps.paperSize] || PAPER[9]; if (land) [pw, ph] = [ph, pw];
      const mg = ps.margins || { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75 };
      const usable = (pw - (mg.left || 0) - (mg.right || 0)) * 96;
      let zoom = (ps.scale && ps.scale !== 100) ? ps.scale / 100 : 1;
      if (ps.fitToPage && (ps.fitToWidth || 1) >= 1) zoom = Math.min(1, usable * (ps.fitToWidth || 1) / totalPx);
      if (totalPx * zoom > usable && !(ps.fitToPage && ps.fitToWidth === 0)) zoom = Math.min(zoom, usable / totalPx); // never cut columns off
      const pname = `s${sheetNo}`;
      const grid = !!ps.showGridLines;
      let t = `<table class="xl${grid ? ' grid' : ''}" style="width:${totalPx}px;zoom:${r2(zoom)}"><colgroup>${cols.map((x) => `<col style="width:${x.px}px">`).join('')}</colgroup>`;
      for (let r = r0; r <= maxR; r++) {
        const row = ws.getRow(r); if (row.hidden) continue;
        t += `<tr style="height:${PT(row.height || defH)}">`;
        for (const { c } of cols) {
          const key = `${r},${c}`; if (covered.has(key)) continue;
          const cell = row.getCell(c); const st = cell.style || {};
          const m = master.get(key);
          const f = st.font || {}; const al = st.alignment || {}; const fill = st.fill; const bd = st.border || {};
          const sjc = sj[window.XLSX.utils.encode_cell({ r: r - 1, c: c - 1 })];
          let text = sjc ? (sjc.w != null ? sjc.w : sjc.v != null ? String(sjc.v) : '') : (cell.text || '');
          if (cell.value && cell.value.richText && !sjc) text = cell.value.richText.map((x) => x.text).join('');
          const isNum = sjc ? sjc.t === 'n' : typeof cell.value === 'number';
          const css = [];
          if (f.name) css.push(`font-family:'${esc(f.name)}',Calibri,Arial,sans-serif`);
          if (f.size) css.push(`font-size:${f.size}pt`);
          if (f.bold) css.push('font-weight:bold'); if (f.italic) css.push('font-style:italic');
          if (f.underline || f.strike) css.push(`text-decoration:${f.underline ? 'underline' : ''} ${f.strike ? 'line-through' : ''}`);
          const fc = xlColor(f.color, theme); if (fc) css.push(`color:${fc}`);
          if (fill && fill.type === 'pattern' && fill.pattern && fill.pattern !== 'none') { const bg = xlColor(fill.fgColor, theme) || xlColor(fill.bgColor, theme); if (bg) css.push(`background:${bg}`); }
          else if (fill && fill.type === 'gradient' && fill.stops && fill.stops.length) { const bg = xlColor(fill.stops[0].color, theme); if (bg) css.push(`background:${bg}`); }
          for (const side of ['top', 'right', 'bottom', 'left']) { const b = bd[side]; if (b && b.style && BORDER[b.style]) css.push(`border-${side}:${BORDER[b.style]} ${xlColor(b.color, theme) || '#000'}`); }
          const h = al.horizontal || (isNum ? 'right' : 'left');
          css.push(`text-align:${h === 'centerContinuous' || h === 'center' ? 'center' : h === 'right' ? 'right' : h === 'justify' || h === 'distributed' ? 'justify' : 'left'}`);
          css.push(`vertical-align:${al.vertical === 'top' ? 'top' : al.vertical === 'middle' ? 'middle' : 'bottom'}`);
          if (al.wrapText) css.push('white-space:pre-wrap;word-break:break-word');
          if (al.indent) css.push(`padding-left:${al.indent * 9 + 2}px`);
          if (al.textRotation === 90 || al.textRotation === 'vertical') css.push('writing-mode:vertical-rl;transform:rotate(180deg)');
          if (!al.wrapText && !m && text && !isNum) { const nx = row.getCell(c + 1).value; if (nx == null || nx === '') css.push('overflow:visible'); }
          t += `<td${m ? ` rowspan="${m.rs}" colspan="${m.cs}"` : ''} style="${css.join(';')}">${esc(text)}</td>`;
        }
        t += '</tr>';
      }
      t += '</table>';
      sheetsOut.push({ t, pw, ph, mg });
    });
    if (!sheetsOut.length) throw new Error('This workbook has nothing to print.');
    // every sheet on its own paper size, orientation and margins
    const P = L(); const out = await P.PDFDocument.create();
    for (const sh of sheetsOut) {
      const m = sh.mg;
      const css = `html,body{margin:0;background:#fff}` +
        'table.xl{border-collapse:collapse;table-layout:fixed;font:11pt Calibri,Arial,sans-serif;color:#000}table.xl td{padding:0 2px;overflow:hidden;white-space:nowrap;line-height:1.15}table.xl.grid td{outline:1px solid #d4d4d4}tr{break-inside:avoid}';
      const part = await P.PDFDocument.load(await htmlPdf(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${sh.t}</body></html>`, { cssPageSize: false, pageSize: { width: sh.pw, height: sh.ph }, margins: { marginType: 'custom', top: m.top || 0, bottom: m.bottom || 0, left: m.left || 0, right: m.right || 0 } }));
      for (const pg of await out.copyPages(part, part.getPageIndices())) out.addPage(pg);
    }
    return { bytes: await out.save(), how: 'built-in' };
  }
  async function textToPdf(file) {
    const t = new TextDecoder('utf-8').decode(file.bytes);
    return { bytes: await htmlPdf(`<!doctype html><html><head><meta charset="utf-8"><style>${PRINT_CSS} pre{white-space:pre-wrap;font:10pt/1.4 Consolas,"Courier New",monospace;margin:0}</style></head><body><pre>${esc(t)}</pre></body></html>`), how: 'built-in' };
  }
  // PowerPoint without LibreOffice: slides rebuilt from their shapes, text and pictures.
  async function pptxToPdf(file, opts = {}) {
    const off = opts.builtIn ? null : await viaOffice(file); if (off) return off;
    if (!/\.pptx$/i.test(file.name)) throw new Error('Only .pptx files can be converted without Microsoft PowerPoint or LibreOffice. Open it in PowerPoint and save it as .pptx, or install LibreOffice (free).');
    const files = window.fflate.unzipSync(file.bytes);
    const txt = (p) => (files[p] ? new TextDecoder().decode(files[p]) : null);
    const xml = (p) => { const t = txt(p); return t ? new DOMParser().parseFromString(t, 'application/xml') : null; };
    const relsOf = (p) => { const dir = p.slice(0, p.lastIndexOf('/')); const r = xml(`${dir}/_rels/${p.split('/').pop()}.rels`); const m = {}; if (r) for (const e of r.getElementsByTagName('Relationship')) { const t = e.getAttribute('Target'); m[e.getAttribute('Id')] = { type: e.getAttribute('Type').split('/').pop(), path: t.startsWith('/') ? t.slice(1) : new URL(t, 'http://x/' + dir + '/').pathname.slice(1) }; } return m; };
    const pres = xml('ppt/presentation.xml'); if (!pres) throw new Error('This is not a PowerPoint file.');
    const sz = pres.getElementsByTagName('p:sldSz')[0];
    const W = +sz.getAttribute('cx'), H = +sz.getAttribute('cy'); const px = (e) => e / 9525;
    const prel = relsOf('ppt/presentation.xml');
    const slidePaths = [...pres.getElementsByTagName('p:sldId')].map((s) => prel[s.getAttribute('r:id')].path);
    const color = (node) => { if (!node) return null; const c = node.getElementsByTagName('a:srgbClr')[0]; return c ? '#' + c.getAttribute('val') : null; };
    const mime = (p) => (/\.png$/i.test(p) ? 'image/png' : /\.jpe?g$/i.test(p) ? 'image/jpeg' : /\.gif$/i.test(p) ? 'image/gif' : null);
    const dataUrl = (p) => { const b = files[p]; const m = mime(p); if (!b || !m) return null; let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return `data:${m};base64,${btoa(s)}`; };
    const direct = (el, tag) => [...el.children].find((c) => c.tagName === tag);
    function phKey(sp) { const ph = sp.getElementsByTagName('p:ph')[0]; return ph ? (ph.getAttribute('type') || 'body') + ':' + (ph.getAttribute('idx') || '') : null; }
    function xfrmOf(sp) { const x = sp.getElementsByTagName('a:xfrm')[0]; if (!x) return null; const o = x.getElementsByTagName('a:off')[0], e = x.getElementsByTagName('a:ext')[0]; return o && e ? { x: +o.getAttribute('x'), y: +o.getAttribute('y'), w: +e.getAttribute('cx'), h: +e.getAttribute('cy') } : null; }
    function placeholders(doc) { const m = {}; if (!doc) return m; for (const sp of doc.getElementsByTagName('p:sp')) { const k = phKey(sp); const x = xfrmOf(sp); if (k && x) { m[k] = x; const t = k.split(':')[0]; if (!m[t + ':']) m[t + ':'] = x; } } return m; }
    let html = '';
    for (const sp of slidePaths) {
      const sdoc = xml(sp); const srel = relsOf(sp);
      const layoutPath = Object.values(srel).find((r) => r.type === 'slideLayout'); const ldoc = layoutPath && xml(layoutPath.path);
      const mrel = layoutPath ? relsOf(layoutPath.path) : {}; const masterPath = Object.values(mrel).find((r) => r.type === 'slideMaster'); const mdoc = masterPath && xml(masterPath.path);
      const inherit = { ...placeholders(mdoc), ...placeholders(ldoc) };
      const bgNode = (sdoc.getElementsByTagName('p:bg')[0]) || (ldoc && ldoc.getElementsByTagName('p:bg')[0]) || (mdoc && mdoc.getElementsByTagName('p:bg')[0]);
      const bg = color(bgNode) || '#ffffff';
      let inner = '';
      const tree = sdoc.getElementsByTagName('p:spTree')[0];
      const walk = (node, dx, dy) => {
        for (const el of node.children) {
          if (el.tagName === 'p:grpSp') { walk(el, dx, dy); continue; }
          if (el.tagName !== 'p:sp' && el.tagName !== 'p:pic') continue;
          const k = phKey(el); const x = xfrmOf(el) || (k && (inherit[k] || inherit[k.split(':')[0] + ':']));
          if (!x) continue;
          const style = `left:${px(x.x + dx)}px;top:${px(x.y + dy)}px;width:${px(x.w)}px;height:${px(x.h)}px`;
          if (el.tagName === 'p:pic') {
            const blip = el.getElementsByTagName('a:blip')[0]; const rel = blip && srel[blip.getAttribute('r:embed')];
            const src = rel && dataUrl(rel.path);
            if (src) inner += `<img src="${src}" style="position:absolute;${style};object-fit:fill" alt="">`;
            continue;
          }
          const spPr = direct(el, 'p:spPr'); const fill = spPr && direct(spPr, 'a:solidFill');
          const body = el.getElementsByTagName('p:txBody')[0];
          let text = '';
          const isTitle = k && /^(title|ctrTitle)/.test(k);
          if (body) for (const p of body.getElementsByTagName('a:p')) {
            const ppr = direct(p, 'a:pPr'); const al = ppr && ppr.getAttribute('algn');
            let runs = '';
            for (const r of p.children) {
              if (r.tagName === 'a:br') { runs += '<br>'; continue; }
              if (r.tagName !== 'a:r' && r.tagName !== 'a:fld') continue;
              const rpr = direct(r, 'a:rPr'); const t = r.getElementsByTagName('a:t')[0];
              const size = rpr && rpr.getAttribute('sz') ? +rpr.getAttribute('sz') / 100 : isTitle ? 40 : 20;
              const col = rpr && color(direct(rpr, 'a:solidFill'));
              runs += `<span style="font-size:${size}pt;${rpr && rpr.getAttribute('b') === '1' ? 'font-weight:bold;' : ''}${rpr && rpr.getAttribute('i') === '1' ? 'font-style:italic;' : ''}${col ? `color:${col};` : ''}">${esc(t ? t.textContent : '')}</span>`;
            }
            const bullet = ppr && ppr.getElementsByTagName('a:buChar')[0];
            text += `<p style="margin:0 0 .25em;text-align:${al === 'ctr' ? 'center' : al === 'r' ? 'right' : al === 'just' ? 'justify' : 'left'}">${bullet && runs ? esc(bullet.getAttribute('char')) + ' ' : ''}${runs || '&nbsp;'}</p>`;
          }
          const anchor = body && body.getElementsByTagName('a:bodyPr')[0] && body.getElementsByTagName('a:bodyPr')[0].getAttribute('anchor');
          inner += `<div style="position:absolute;${style};${fill ? `background:${color(fill)};` : ''}display:flex;flex-direction:column;justify-content:${anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : 'flex-start'};padding:4px 8px;box-sizing:border-box;overflow:hidden;font-family:Calibri,'Segoe UI',Arial,sans-serif;${isTitle ? 'font-weight:600;' : ''}">${text}</div>`;
        }
      };
      walk(tree, 0, 0);
      html += `<div class="slide" style="background:${bg}">${inner}</div>`;
    }
    const wIn = W / 914400, hIn = H / 914400;
    const doc = `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${wIn}in ${hIn}in;margin:0}html,body{margin:0}.slide{position:relative;width:${px(W)}px;height:${px(H)}px;overflow:hidden;page-break-after:always;break-after:page}.slide:last-child{page-break-after:auto;break-after:auto}</style></head><body>${html}</body></html>`;
    return { bytes: await htmlPdf(doc, { pageSize: { width: wIn, height: hIn }, margins: { marginType: 'none' } }), how: 'built-in' };
  }
  async function imagesToPdf(files, opts = {}) {
    const P = L(); const doc = await P.PDFDocument.create();
    const sizes = { a4: [595.28, 841.89], letter: [612, 792] };
    const margin = { none: 0, small: 18, big: 48 }[opts.margin || 'none'];
    for (const f of files) {
      const isJpg = /\.jpe?g$/i.test(f.name) || (f.bytes[0] === 0xFF && f.bytes[1] === 0xD8);
      const img = isJpg ? await doc.embedJpg(f.bytes) : await doc.embedPng(f.bytes);
      let [pw, ph] = opts.size && sizes[opts.size] ? sizes[opts.size] : [img.width * 0.75 + margin * 2, img.height * 0.75 + margin * 2];
      const land = opts.orientation === 'landscape' || (opts.orientation !== 'portrait' && opts.size && sizes[opts.size] && img.width > img.height);
      if (land && pw < ph) [pw, ph] = [ph, pw];
      const page = doc.addPage([pw, ph]);
      const k = Math.min((pw - margin * 2) / img.width, (ph - margin * 2) / img.height);
      const w = img.width * k, h = img.height * k;
      page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    }
    return doc.save();
  }
  async function makePdf(kind) {
    const pick = { word: 'word', excel: 'excel', powerpoint: 'powerpoint', text: 'text', html: 'html', images: 'images' }[kind];
    let files;
    if (pick === 'images') files = await D.bench.openImages(); else files = await D.bench.openKind(pick, false);
    if (!files || !files.length) return;
    if (!(await D.guardUnsaved('You have unsaved changes in the open document. Save them first?'))) return;
    let opts = {};
    if (pick === 'images') {
      const size = D.el('select', { id: 'imSize' }, D.el('option', { value: 'fit' }, 'Same as each image'), D.el('option', { value: 'a4' }, 'A4'), D.el('option', { value: 'letter' }, 'Letter'));
      const orient = D.el('select', { id: 'imOrient' }, D.el('option', { value: 'auto' }, 'Automatic'), D.el('option', { value: 'portrait' }, 'Portrait'), D.el('option', { value: 'landscape' }, 'Landscape'));
      const margin = D.el('select', { id: 'imMargin' }, D.el('option', { value: 'none' }, 'No margin'), D.el('option', { value: 'small' }, 'Small'), D.el('option', { value: 'big' }, 'Big'));
      const ok = await new Promise((res) => {
        const { root, close } = D.modal([D.el('h2', {}, `Make a PDF from ${files.length} image${files.length > 1 ? 's' : ''}`), D.el('div', { class: 'form' },
          D.el('label', { for: 'imSize' }, 'Page size'), size, D.el('label', { for: 'imOrient' }, 'Orientation'), orient, D.el('label', { for: 'imMargin' }, 'Margin'), margin),
        D.el('div', { class: 'actions' }, D.el('button', { class: 'btn secondary', onclick: () => close() }, 'Cancel'), D.el('button', { class: 'btn primary', onclick: () => { res(true); close(); } }, 'Make PDF'))]);
        root.addEventListener('closed', () => res(false));
      });
      if (!ok) return;
      opts = { size: size.value === 'fit' ? null : size.value, orientation: orient.value, margin: margin.value };
    }
    D.busy(true);
    try {
      const f = files[0]; let out;
      if (pick === 'images') out = { bytes: await imagesToPdf(files, opts), how: 'built-in' };
      else if (pick === 'word') out = await wordToPdf(f);
      else if (pick === 'excel') out = await excelToPdf(f);
      else if (pick === 'powerpoint') out = await pptxToPdf(f);
      else if (pick === 'text') out = await textToPdf(f);
      else if (pick === 'html') { const r = await D.bench.fileToPdf(f.path); if (!r || r.error) throw new Error(r ? r.error : 'failed'); out = { bytes: r.bytes, how: 'built-in' }; }
      const name = (pick === 'images' ? 'Images' : f.name.replace(/\.[^.]+$/, '')) + '.pdf';
      await openResult(out.bytes, name);
      D.toast(`Made ${name}${/^Microsoft|LibreOffice/.test(out.how || '') ? ` with ${out.how}, page for page` : ''}. Save it to keep it.`);
      return out.bytes;
    } catch (e) { D.toast('Could not make a PDF: ' + (e.message || e), 'error'); } finally { D.busy(false); }
  }

  // ---------- protect ----------
  async function protect() {
    if (!(await needDoc())) return;
    const S = D.S; const cur = S.protect || {};
    const pw = D.el('input', { type: 'password', id: 'pw1', autocomplete: 'new-password', value: cur.userPassword || '' });
    const pw2 = D.el('input', { type: 'password', id: 'pw2', autocomplete: 'new-password', value: cur.userPassword || '' });
    const own = D.el('input', { type: 'password', id: 'pw3', autocomplete: 'new-password', value: cur.ownerPassword && cur.ownerPassword !== cur.userPassword ? cur.ownerPassword : '' });
    const perm = (id, label, key) => { const c = D.el('input', { type: 'checkbox', id, checked: !cur.permissions || cur.permissions[key] !== false }); return { c, row: D.el('label', { class: 'chk', for: id }, c, ' ' + label), key }; };
    const ps = [perm('ppr', 'Printing', 'printing'), perm('pcp', 'Copying text and images', 'copying'), perm('ped', 'Changing the document', 'modifying'), perm('pan', 'Adding comments', 'annotating'), perm('pff', 'Filling in forms', 'fillingForms'), perm('pas', 'Adding, removing or reordering pages', 'documentAssembly')];
    const err = D.el('p', { class: 'perr', role: 'alert' });
    const { close } = D.modal([D.el('h2', {}, 'Protect with a password'),
      D.el('p', {}, 'People will need this password to open the file. Keep it somewhere safe: nobody, including BubbyPDF, can recover it.'),
      D.el('div', { class: 'form' }, D.el('label', { for: 'pw1' }, 'Password to open'), pw, D.el('label', { for: 'pw2' }, 'Type it again'), pw2),
      D.el('h3', { class: 'sub' }, 'What people can do after opening it'), D.el('div', { class: 'perms' }, ...ps.map((p) => p.row)),
      D.el('div', { class: 'form' }, D.el('label', { for: 'pw3' }, 'Password to change these limits (needed if you turn any off)'), own), err,
      D.el('div', { class: 'actions' },
        S.protect ? D.el('button', { class: 'btn ghost danger', onclick: () => { D.snap(); S.protect = null; D.markDirty(); close(); D.toast('The password will be removed when you save.'); } }, 'Remove password') : null,
        D.el('span', { class: 'spacer' }),
        D.el('button', { class: 'btn secondary', onclick: () => close() }, 'Cancel'),
        D.el('button', { class: 'btn primary', onclick: () => {
          const permissions = {}; let limited = false;
          for (const p of ps) { const on = p.c.checked; if (!on) limited = true; permissions[p.key] = p.key === 'printing' ? (on ? 'highResolution' : false) : on; }
          if (pw.value !== pw2.value) { err.textContent = 'The two passwords are different. Type the same password twice.'; return; }
          if (!pw.value && !limited) { err.textContent = 'Type a password, or turn off something people may do.'; return; }
          if (limited && !own.value) { err.textContent = 'Choose a password for changing the limits.'; return; }
          if (limited && own.value === pw.value) { err.textContent = 'Use a different password for changing the limits, or anyone who can open the file could change them.'; return; }
          D.snap(); S.protect = { userPassword: pw.value, ownerPassword: own.value || pw.value, permissions }; D.markDirty(); close();
          D.toast('Protection is set. It is applied when you save.');
        } }, 'Protect'))], 'wide');
    pw.focus();
  }

  // ---------- compress ----------
  async function compressBytes(bytes, level, onStep) {
    const P = L(); const doc = await P.PDFDocument.load(bytes, { updateMetadata: false });
    const N = (s) => P.PDFName.of(s); const ctx = doc.context;
    const cfg = { strong: { max: 1100, q: 0.55 }, balanced: { max: 1700, q: 0.7 }, light: { max: 2600, q: 0.85 } }[level] || { max: 1700, q: 0.7 };
    const objs = ctx.enumerateIndirectObjects(); let done = 0, saved = 0;
    for (const [ref, obj] of objs) {
      done++;
      if (!(obj instanceof P.PDFRawStream)) continue;
      const d = obj.dict;
      if (String(d.get(N('Subtype'))) !== '/Image' || d.get(N('ImageMask'))) continue;
      const bpc = d.lookup(N('BitsPerComponent')); if (!bpc || bpc.asNumber() !== 8) continue;
      let cs = d.lookup(N('ColorSpace')); let comps = 0;
      if (cs instanceof P.PDFName) comps = String(cs) === '/DeviceRGB' ? 3 : String(cs) === '/DeviceGray' ? 1 : 0;
      else if (cs instanceof P.PDFArray && String(cs.get(0)) === '/ICCBased') { const st = cs.lookup(1); const n = st && st.dict && st.dict.lookup(N('N')); comps = n ? n.asNumber() : 0; if (comps !== 1 && comps !== 3) comps = 0; }
      if (!comps) continue;
      const filter = d.get(N('Filter')); const fname = filter instanceof P.PDFArray ? (filter.size() === 1 ? String(filter.get(0)) : '') : String(filter || '');
      const w = d.lookup(N('Width')).asNumber(), h = d.lookup(N('Height')).asNumber();
      if (w * h < 40000) continue;
      let canvas;
      try {
        if (fname === '/DCTDecode') {
          const bmp = await createImageBitmap(new Blob([obj.contents], { type: 'image/jpeg' }));
          canvas = document.createElement('canvas'); canvas.width = bmp.width; canvas.height = bmp.height; canvas.getContext('2d').drawImage(bmp, 0, 0);
        } else if (fname === '/FlateDecode' && !d.get(N('DecodeParms'))) {
          const raw = P.decodePDFRawStream(obj).decode(); if (raw.length < w * h * comps) continue;
          canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
          const g = canvas.getContext('2d'); const id = g.createImageData(w, h);
          for (let i = 0, j = 0; i < w * h; i++, j += comps) { const k = i * 4; id.data[k] = raw[j]; id.data[k + 1] = raw[j + (comps === 3 ? 1 : 0)]; id.data[k + 2] = raw[j + (comps === 3 ? 2 : 0)]; id.data[k + 3] = 255; }
          g.putImageData(id, 0, 0);
        } else continue;
      } catch { continue; }
      const scale = Math.min(1, cfg.max / Math.max(canvas.width, canvas.height));
      const out = document.createElement('canvas'); out.width = Math.max(1, Math.round(canvas.width * scale)); out.height = Math.max(1, Math.round(canvas.height * scale));
      const og = out.getContext('2d'); og.fillStyle = '#fff'; og.fillRect(0, 0, out.width, out.height); og.drawImage(canvas, 0, 0, out.width, out.height);
      const jpg = await canvasBytes(out, 'image/jpeg', cfg.q);
      if (jpg.length >= obj.contents.length * 0.9) continue;
      const nd = {};
      for (const [k, v] of d.entries()) { const kn = String(k).slice(1); if (!['Filter', 'DecodeParms', 'Width', 'Height', 'ColorSpace', 'BitsPerComponent', 'Decode', 'Length'].includes(kn)) nd[kn] = v; }
      Object.assign(nd, { Type: 'XObject', Subtype: 'Image', Width: out.width, Height: out.height, ColorSpace: comps === 1 ? 'DeviceGray' : 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' });
      nd.ColorSpace = 'DeviceRGB'; const finalJpg = jpg; // canvas pictures are always RGB
      saved += obj.contents.length - finalJpg.length;
      ctx.assign(ref, ctx.stream(finalJpg, nd));
      onStep && onStep(done / objs.length);
    }
    const outBytes = await doc.save({ useObjectStreams: true });
    return { bytes: outBytes.length < bytes.length ? outBytes : bytes, saved };
  }
  async function compress() {
    if (!(await needDoc())) return;
    const lvl = D.el('select', { id: 'cLvl' }, D.el('option', { value: 'strong' }, 'Smallest file (lower picture quality)'), D.el('option', { value: 'balanced' }, 'Balanced (recommended)'), D.el('option', { value: 'light' }, 'Best quality (smaller saving)'));
    lvl.value = 'balanced';
    const ok = await new Promise((res) => {
      const { root, close } = D.modal([D.el('h2', {}, 'Reduce file size'), D.el('p', {}, 'Pictures are resized and saved more efficiently. Text stays sharp. Your open document is not changed; you save the smaller copy.'),
        D.el('div', { class: 'form' }, D.el('label', { for: 'cLvl' }, 'How much'), lvl),
        D.el('div', { class: 'actions' }, D.el('button', { class: 'btn secondary', onclick: () => close() }, 'Cancel'), D.el('button', { class: 'btn primary', onclick: () => { res(true); close(); } }, 'Reduce size'))]);
      root.addEventListener('closed', () => res(false));
    });
    if (!ok) return;
    const pr = progress('Reducing file size');
    try {
      const before = await builtBytes();
      pr.set(0.1, 'Shrinking pictures…');
      const { bytes } = await compressBytes(before, lvl.value, (f) => pr.set(0.1 + f * 0.85));
      const protectedBytes = D.protectBytes ? await D.protectBytes(bytes) : bytes;
      pr.close();
      const pct = Math.round((1 - protectedBytes.length / before.length) * 100);
      if (pct < 3) D.toast('This PDF is already about as small as it can get without losing quality.');
      const r = await saveAs('pdf', `${base()} (smaller).pdf`, protectedBytes);
      if (r) done(`Saved ${r.name}: ${D.fmtSize(before.length)} → ${D.fmtSize(protectedBytes.length)}${pct > 0 ? ` (${pct}% smaller)` : ''}.`, r);
      return protectedBytes;
    } catch (e) { pr.close(); D.toast('Could not reduce the size: ' + (e.message || e), 'error'); }
  }

  // ---------- split ----------
  function parseRanges(text, n) {
    const out = [];
    for (const part of String(text).split(/[,;]+/)) {
      const m = /^\s*(\d+)\s*(?:-\s*(\d+|end))?\s*$/i.exec(part); if (!m) { if (part.trim()) return null; continue; }
      const a = +m[1], b = m[2] ? (/end/i.test(m[2]) ? n : +m[2]) : a;
      if (a < 1 || b > n || a > b) return null;
      out.push([a, b]);
    }
    return out.length ? out : null;
  }
  async function split() {
    if (!(await needDoc())) return;
    const n = D.S.pages.length;
    const mode = D.el('select', { id: 'spMode' }, D.el('option', { value: 'ranges' }, 'Into the page ranges I type'), D.el('option', { value: 'every' }, 'Every page into its own file'), D.el('option', { value: 'chunks' }, 'Into files of a fixed number of pages'));
    const ranges = D.el('input', { type: 'text', id: 'spRanges', placeholder: `e.g. 1-3, 4-${Math.min(n, 6)}, ${Math.min(n, 7)}-end`, value: n > 1 ? `1-${Math.ceil(n / 2)}, ${Math.ceil(n / 2) + 1}-end` : '1' });
    const chunk = D.el('input', { type: 'number', id: 'spChunk', min: '1', max: String(n), value: String(Math.min(2, n)) });
    const err = D.el('p', { class: 'perr', role: 'alert' });
    const rRow = D.el('div', { class: 'form' }, D.el('label', { for: 'spRanges' }, `Page ranges (this PDF has ${n} pages)`), ranges);
    const cRow = D.el('div', { class: 'form', hidden: true }, D.el('label', { for: 'spChunk' }, 'Pages per file'), chunk);
    mode.onchange = () => { rRow.hidden = mode.value !== 'ranges'; cRow.hidden = mode.value !== 'chunks'; };
    const groups = await new Promise((res) => {
      const { root, close } = D.modal([D.el('h2', {}, 'Split PDF'), D.el('div', { class: 'form' }, D.el('label', { for: 'spMode' }, 'Split'), mode), rRow, cRow, err,
        D.el('div', { class: 'actions' }, D.el('button', { class: 'btn secondary', onclick: () => close() }, 'Cancel'), D.el('button', { class: 'btn primary', onclick: () => {
          let g;
          if (mode.value === 'every') g = D.S.pages.map((_, i) => [i + 1, i + 1]);
          else if (mode.value === 'chunks') { const k = Math.max(1, Math.min(n, parseInt(chunk.value, 10) || 1)); g = []; for (let i = 1; i <= n; i += k) g.push([i, Math.min(n, i + k - 1)]); }
          else { g = parseRanges(ranges.value, n); if (!g) { err.textContent = `Use page numbers from 1 to ${n}, like "1-3, 5, 8-end".`; return; } }
          res(g); close();
        } }, 'Choose folder'))]);
      root.addEventListener('closed', () => res(null));
    });
    if (!groups) return;
    const folder = await D.bench.pickFolder(); if (!folder) return;
    const pr = progress('Splitting'); let made = 0;
    try {
      for (const [k, [a, b]] of groups.entries()) {
        if (pr.cancelled) break;
        pr.set(k / groups.length, `Making file ${k + 1} of ${groups.length}…`);
        const r = await D.buildPdf(D.S.pages.slice(a - 1, b));
        const bytes = D.protectBytes ? await D.protectBytes(r.bytes) : r.bytes;
        const name = `${base()} ${a === b ? `page ${a}` : `pages ${a}-${b}`}.pdf`;
        if (await D.bench.writeInFolder({ token: folder.token, name, bytes })) made++;
      }
      pr.close();
      done(`Made ${made} file${made !== 1 ? 's' : ''} in ${folder.path}.`, { path: folder.path });
      return made;
    } catch (e) { pr.close(); D.toast('Could not split: ' + (e.message || e), 'error'); }
  }

  // ---------- watermark and page numbers (kept with the document; applied when saving) ----------
  const POS = { tl: 'Top left', tc: 'Top center', tr: 'Top right', bl: 'Bottom left', bc: 'Bottom center', br: 'Bottom right' };
  function marksDialog(kind) {
    const S = D.S; const cur = (S.marks && S.marks[kind]) || {};
    const fields = []; const f = (label, node) => { fields.push(D.el('label', { for: node.id }, label), node); return node; };
    let get;
    if (kind === 'watermark') {
      const text = f('Text', D.el('input', { type: 'text', id: 'wmText', value: cur.text || 'CONFIDENTIAL' }));
      const size = f('Size', D.el('input', { type: 'number', id: 'wmSize', min: '8', max: '200', value: String(cur.size || 60) }));
      const op = f('Transparency', D.el('select', { id: 'wmOp' }, ...[[0.12, 'Very light'], [0.2, 'Light'], [0.35, 'Medium'], [0.6, 'Strong']].map(([v, l]) => D.el('option', { value: v }, l))));
      op.value = String(cur.opacity || 0.2);
      const rot = f('Angle', D.el('select', { id: 'wmRot' }, D.el('option', { value: '45' }, 'Diagonal'), D.el('option', { value: '0' }, 'Straight')));
      rot.value = String(cur.angle != null ? cur.angle : 45);
      const color = f('Color', D.el('input', { type: 'color', id: 'wmColor', value: cur.color || '#C2410C' }));
      const layout = f('Layout', D.el('select', { id: 'wmLayout' }, D.el('option', { value: 'center' }, 'Once, in the middle'), D.el('option', { value: 'tile' }, 'Repeated across the page')));
      layout.value = cur.layout || 'center';
      get = () => ({ text: text.value.trim(), size: Math.max(8, Math.min(200, +size.value || 60)), opacity: +op.value, angle: +rot.value, color: color.value, layout: layout.value });
    } else {
      const fmt = f('Format', D.el('select', { id: 'pnFmt' }, ...[['{n}', '1'], ['Page {n}', 'Page 1'], ['Page {n} of {total}', 'Page 1 of 9'], ['{n} / {total}', '1 / 9'], ['- {n} -', '- 1 -']].map(([v, l]) => D.el('option', { value: v }, l))));
      fmt.value = cur.format || 'Page {n} of {total}';
      const pos = f('Position', D.el('select', { id: 'pnPos' }, ...Object.entries(POS).map(([v, l]) => D.el('option', { value: v }, l))));
      pos.value = cur.pos || 'bc';
      const size = f('Size', D.el('input', { type: 'number', id: 'pnSize', min: '6', max: '36', value: String(cur.size || 10) }));
      const start = f('First number', D.el('input', { type: 'number', id: 'pnStart', min: '0', value: String(cur.start != null ? cur.start : 1) }));
      const skip = D.el('input', { type: 'checkbox', id: 'pnSkip', checked: !!cur.skipFirst });
      fields.push(D.el('span'), D.el('label', { class: 'chk', for: 'pnSkip' }, skip, ' Leave the first page without a number'));
      get = () => ({ format: fmt.value, pos: pos.value, size: Math.max(6, Math.min(36, +size.value || 10)), start: Math.max(0, parseInt(start.value, 10) || 0), skipFirst: skip.checked });
    }
    const title = kind === 'watermark' ? 'Watermark' : 'Page numbers';
    const { close } = D.modal([D.el('h2', {}, title), D.el('p', {}, 'Shown on every page now, and added to the file when you save.'), D.el('div', { class: 'form' }, ...fields),
      D.el('div', { class: 'actions' },
        cur && Object.keys(cur).length ? D.el('button', { class: 'btn ghost danger', onclick: () => { D.snap(); delete S.marks[kind]; D.markDirty(); D.redrawAll(); close(); } }, 'Remove') : null,
        D.el('span', { class: 'spacer' }), D.el('button', { class: 'btn secondary', onclick: () => close() }, 'Cancel'),
        D.el('button', { class: 'btn primary', onclick: () => {
          const v = get(); if (kind === 'watermark' && !v.text) return;
          D.snap(); S.marks = { ...(S.marks || {}), [kind]: v }; D.markDirty(); D.redrawAll(); close();
        } }, 'Apply'))], 'wide');
  }
  // Where a mark sits on the page as you see it (display space, points).
  function markPlaces(p, index, total, marks, dispW, dispH) {
    const out = [];
    const pn = marks && marks.pageNumbers;
    if (pn && !(pn.skipFirst && index === 0)) {
      const n = index + pn.start - (pn.skipFirst ? 1 : 0);
      const t = pn.format.replace('{n}', String(n)).replace('{total}', String(total - (pn.skipFirst ? 1 : 0) + pn.start - 1));
      const m = 28; const horiz = pn.pos[1]; const vert = pn.pos[0];
      out.push({ kind: 'pn', text: t, size: pn.size, x: horiz === 'l' ? m : horiz === 'r' ? dispW - m : dispW / 2, align: horiz === 'l' ? 'left' : horiz === 'r' ? 'right' : 'center', y: vert === 't' ? m + pn.size : dispH - m, color: '#222222', opacity: 1, angle: 0 });
    }
    const wm = marks && marks.watermark;
    if (wm && wm.text) {
      const spots = wm.layout === 'tile' ? (() => { const s = []; for (let y = dispH / 6; y < dispH; y += dispH / 3) for (let x = dispW / 4; x < dispW; x += dispW / 2) s.push([x, y]); return s; })() : [[dispW / 2, dispH / 2]];
      for (const [x, y] of spots) out.push({ kind: 'wm', text: wm.text, size: wm.layout === 'tile' ? wm.size * 0.6 : wm.size, x, y, align: 'center', middle: true, color: wm.color, opacity: wm.opacity, angle: wm.angle });
    }
    return out;
  }
  function drawMarksOverlay(ctx, p, index, total, s) {
    const marks = D.S.marks; if (!marks || (!marks.watermark && !marks.pageNumbers)) return;
    const [dw, dh] = D.dispSize(p, 1);
    ctx.save(); ctx.setTransform(s, 0, 0, s, 0, 0);
    for (const m of markPlaces(p, index, total, marks, dw, dh)) {
      ctx.save(); ctx.globalAlpha = m.opacity; ctx.fillStyle = m.color; ctx.font = `${m.kind === 'wm' ? 'bold ' : ''}${m.size}px Helvetica, Arial, sans-serif`;
      ctx.textAlign = m.align; ctx.textBaseline = m.middle ? 'middle' : 'alphabetic';
      ctx.translate(m.x, m.y); ctx.rotate(-m.angle * Math.PI / 180); ctx.fillText(m.text, 0, 0); ctx.restore();
    }
    ctx.restore();
  }
  async function applyMarks(out, entries, marks) {
    if (!marks || (!marks.watermark && !marks.pageNumbers)) return;
    const P = L(); const helv = await out.embedFont(P.StandardFonts.Helvetica); const bold = await out.embedFont(P.StandardFonts.HelveticaBold);
    const set = new Set(helv.getCharacterSet());
    const clean = (t) => [...t].map((ch) => (set.has(ch.codePointAt(0)) || ch === ' ' ? ch : '?')).join('');
    entries.forEach((p, i) => {
      const pg = out.getPage(i); const [dw, dh] = D.dispSize(p, 1); const rot = D.dispRot(p);
      const [x0, , , y1] = p.view;
      const toPdf = (dx, dy) => { const [u, v] = D.invert(D.mat(p, 1), dx, dy); return [x0 + u, y1 - v]; };
      for (const m of markPlaces(p, i, entries.length, marks, dw, dh)) {
        const font = m.kind === 'wm' ? bold : helv; const t = clean(m.text);
        const w = font.widthOfTextAtSize(t, m.size); const hgt = font.heightAtSize(m.size);
        // start of the text in display space, before rotation by the mark's own angle
        let ox = m.align === 'center' ? -w / 2 : m.align === 'right' ? -w : 0; let oy = m.middle ? hgt * 0.35 : 0;
        const a = m.angle * Math.PI / 180;
        const sx = m.x + ox * Math.cos(a) + oy * Math.sin(a), sy = m.y - ox * Math.sin(a) + oy * Math.cos(a);
        const [px, py] = toPdf(sx, sy);
        const c = parseInt(m.color.slice(1), 16);
        pg.drawText(t, { x: px, y: py, size: m.size, font, color: P.rgb(((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255), opacity: m.opacity, rotate: P.degrees(rot + m.angle) });
      }
    });
  }

  // ---------- repair ----------
  async function repair() {
    const files = await D.bench.openKind('pdf', false); if (!files || !files.length) return;
    if (!(await D.guardUnsaved('You have unsaved changes in the open document. Save them first?'))) return;
    const f = files[0]; const P = L();
    const pr = progress('Repairing'); let bytes = null; let how = '';
    try {
      pr.set(0.1, 'Reading the file…');
      try {
        const doc = await P.PDFDocument.load(f.bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
        if (doc.getPageCount() > 0) { bytes = await doc.save({ useObjectStreams: false }); how = 'rebuilt'; }
      } catch { bytes = null; }
      let pdf = null;
      if (bytes) { try { pdf = await window.pdfjsLib.getDocument({ ...D.PDFJS_OPTS, data: bytes.slice() }).promise; } catch { bytes = null; } }
      if (pdf) pdf.destroy();
      if (!bytes) {
        // Last resort: the PDF reader is very forgiving. Draw every page it can read into a new file.
        pr.set(0.3, 'Recovering pages…');
        const src = await window.pdfjsLib.getDocument({ ...D.PDFJS_OPTS, data: f.bytes.slice(), stopAtErrors: false }).promise;
        const doc = await P.PDFDocument.create();
        for (let i = 1; i <= src.numPages; i++) {
          if (pr.cancelled) break;
          pr.set(0.3 + 0.6 * i / src.numPages, `Recovering page ${i} of ${src.numPages}…`);
          try {
            const page = await src.getPage(i); const vp = page.getViewport({ scale: 2 });
            const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
            const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
            await page.render({ canvasContext: g, viewport: vp }).promise;
            const img = await doc.embedJpg(await canvasBytes(c, 'image/jpeg', 0.9));
            const pg = doc.addPage([vp.width / 2, vp.height / 2]); pg.drawImage(img, { x: 0, y: 0, width: vp.width / 2, height: vp.height / 2 });
          } catch { /* skip a page that cannot be read at all */ }
        }
        src.destroy();
        if (!doc.getPageCount()) throw new Error('No readable pages were found in this file.');
        bytes = await doc.save(); how = 'images';
      }
      pr.close();
      await openResult(bytes, f.name.replace(/\.pdf$/i, '') + ' (repaired).pdf');
      D.toast(how === 'images' ? 'Recovered the pages as images (the text could not be saved). Run Recognize text to make it searchable again, then save.' : 'Repaired. Save to keep the fixed copy.');
      return bytes;
    } catch (e) { pr.close(); D.toast('Could not repair this file: ' + (e.message || e), 'error'); }
  }

  // ---------- blank PDF ----------
  async function blankPdf() {
    if (!(await D.guardUnsaved('You have unsaved changes in the open document. Save them first?'))) return;
    const P = L(); const doc = await P.PDFDocument.create(); doc.addPage([595.28, 841.89]);
    await openResult(await doc.save(), 'Untitled.pdf');
    D.toast('A blank A4 page is ready. Add text, images or more pages, then save.');
  }

  // ---------- text recognition (OCR) ----------
  let worker = null; let workerLoading = null;
  // The recognition engine sits in a different folder in the installed app than in development: find it.
  async function findCore() {
    for (const c of ['../node_modules/tesseract.js-core/', '../node_modules/tesseract.js/node_modules/tesseract.js-core/']) {
      try { const r = await fetch(abs(c) + 'package.json'); if (r.ok) return abs(c); } catch { /* try the next place */ }
    }
    throw new Error('The text reader is missing from this copy of BubbyPDF. Reinstall BubbyPDF to fix it.');
  }
  async function ocrWorker(onLog) {
    if (worker) return worker;
    if (!workerLoading) {
      const corePath = await findCore();
      workerLoading = window.Tesseract.createWorker('eng', 1, {
        workerPath: abs('../node_modules/tesseract.js/dist/worker.min.js'),
        corePath,
        langPath: abs('../node_modules/@tesseract.js-data/eng/4.0.0/'),
        gzip: true, workerBlobURL: false, cacheMethod: 'none',
        logger: (m) => onLog && onLog(m),
      }).then((w) => { worker = w; return w; }).catch((e) => { workerLoading = null; throw new Error(typeof e === 'string' ? e : (e && e.message) || 'The text reader could not start.'); });
    }
    return workerLoading;
  }
  // Read the words on a canvas; returns words with boxes in canvas pixels.
  async function readCanvas(canvas) {
    const w = await ocrWorker();
    let data;
    try { ({ data } = await w.recognize(canvas, {}, { text: true, blocks: true })); } catch (e) { throw new Error(typeof e === 'string' ? e : (e && e.message) || 'Text recognition failed.'); }
    const words = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const wd of l.words || []) {
      if (!wd.text || !wd.text.trim() || wd.confidence < 35) continue;
      words.push({ t: wd.text, x0: wd.bbox.x0, y0: wd.bbox.y0, x1: wd.bbox.x1, y1: wd.bbox.y1, line: l.bbox, para: p });
    }
    return { words, text: data.text || '', paragraphs: (data.blocks || []).flatMap((b) => b.paragraphs || []) };
  }
  async function renderSource(p, dpi, crop) {
    const doc = D.S.docs.get(p.docId); const page = await doc.pdf.getPage(p.src + 1);
    const s = dpi / 72; const vp = page.getViewport({ scale: s, rotation: 0 });
    const c = document.createElement('canvas');
    if (crop) { c.width = Math.ceil(crop.w * s); c.height = Math.ceil(crop.h * s); } else { c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height); }
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    if (crop) g.translate(-crop.x * s, -crop.y * s);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    return { canvas: c, s };
  }
  async function recognize() {
    if (!(await needDoc())) return;
    const S = D.S;
    const todo = [];
    for (const p of S.pages) { if (p.blank) continue; const items = await D.textItems(p); if (!items.some((it) => /[A-Za-z0-9]/.test(it.str))) todo.push(p); }
    let pages = todo;
    if (!todo.length) {
      const again = await D.ask('Recognize text', 'Every page already has text you can search. Recognize the text of every page again from the page images?', [{ label: 'Cancel', value: null }, { label: 'Recognize all pages', value: 'all', primary: true }]);
      if (!again) return; pages = S.pages.filter((p) => !p.blank);
    }
    const pr = progress('Recognizing text');
    try {
      pr.set(0.02, 'Getting the text reader ready (first time takes a few seconds)…');
      await ocrWorker();
      D.snap(); let words = 0;
      for (const [k, p] of pages.entries()) {
        if (pr.cancelled) break;
        pr.set((k + 0.1) / pages.length, `Reading page ${S.pages.indexOf(p) + 1} (${k + 1} of ${pages.length})…`);
        const { canvas, s } = await renderSource(p, 300);
        const r = await readCanvas(canvas);
        p.ocr = r.words.map((w) => ({ t: w.t, x: r2(w.x0 / s), y: r2(w.y0 / s), w: r2((w.x1 - w.x0) / s), h: r2((w.y1 - w.y0) / s), lh: r2((w.line.y1 - w.line.y0) / s) }));
        words += p.ocr.length;
        D.forgetText(p);
      }
      pr.close(); D.markDirty(); D.layoutPages(true);
      D.toast(words ? `Recognized ${words} words. You can now search and copy the text; it is added to the file when you save.` : 'No text was found on these pages.');
      return words;
    } catch (e) { pr.close(); D.toast('Could not recognize text: ' + (e.message || e), 'error'); }
  }
  // Invisible recognized text, placed over the words in the image (searchable and selectable).
  async function writeOcr(out, pg, p) {
    if (!p.ocr || !p.ocr.length) return;
    const P = L(); const helv = await out.embedFont(P.StandardFonts.Helvetica); const set = new Set(helv.getCharacterSet());
    const [x0, , , y1] = p.view;
    for (const w of p.ocr) {
      const t = [...w.t].map((ch) => (set.has(ch.codePointAt(0)) ? ch : '?')).join('');
      const w1 = helv.widthOfTextAtSize(t, 1); if (!w1) continue;
      const size = Math.max(2, Math.min(w.h * 1.15, w.w / w1));
      pg.drawText(t, { x: x0 + w.x, y: y1 - (w.y + w.h * 0.85), size, font: helv, opacity: 0 });
    }
  }
  // A paragraph whose letters can't be read from the file: read it from the page image.
  async function readRegion(p, box) {
    const { canvas, s } = await renderSource(p, 300, box);
    const r = await readCanvas(canvas);
    const text = r.paragraphs.map((pp) => (pp.text || '').replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).join('\n');
    return { text, s };
  }

  // ---------- read aloud ----------
  let speaking = false;
  async function readAloud() {
    if (!(await needDoc())) return;
    const btn = document.getElementById('btnRead');
    if (speaking) { speechSynthesis.cancel(); speaking = false; if (btn) btn.setAttribute('aria-pressed', 'false'); return; }
    if (!window.speechSynthesis) { D.toast('Read aloud is not available on this computer.', 'error'); return; }
    const S = D.S; const start = S.current || 0;
    const chunks = [];
    for (let i = start; i < S.pages.length; i++) {
      const items = await D.textItems(S.pages[i]);
      const text = items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
      if (text) for (const part of text.match(/[^.!?]+[.!?]*\s*/g) || [text]) chunks.push({ page: i, t: part });
    }
    if (!chunks.length) { D.toast('There is no text to read on these pages. Try Recognize text first.'); return; }
    speaking = true; if (btn) btn.setAttribute('aria-pressed', 'true');
    D.toast(`Reading from page ${start + 1}. Click the headphones again to stop.`);
    let k = 0;
    const next = () => {
      if (!speaking || k >= chunks.length) { speaking = false; if (btn) btn.setAttribute('aria-pressed', 'false'); return; }
      const c = chunks[k++]; if (c.page !== D.S.current) D.scrollToPage(c.page);
      const u = new SpeechSynthesisUtterance(c.t); u.rate = 1; u.onend = next; u.onerror = next;
      speechSynthesis.speak(u);
    };
    next();
  }

  // ---------- the tool list (used by the tools panel, tabs and home page) ----------
  const TOOLS = [
    { id: 'edit', cat: 'edit', label: 'Edit text', desc: 'Change paragraphs; untouched lines stay as they are', icon: 'edittext', run: async () => { if (await needDoc()) D.setTool('edittext'); } },
    { id: 'addtext', cat: 'edit', label: 'Add text', desc: 'Type anywhere on a page', icon: 'text', run: async () => { if (await needDoc()) D.setTool('text'); } },
    { id: 'image', cat: 'edit', label: 'Add image', desc: 'Place a PNG or JPG on a page', icon: 'image', run: async () => { if (await needDoc()) D.setTool('image'); } },
    { id: 'highlight', cat: 'edit', label: 'Highlight and comment', desc: 'Highlight, underline, strike out, sticky notes', icon: 'highlight', run: async () => { if (await needDoc()) D.setTool('highlight'); } },
    { id: 'draw', cat: 'edit', label: 'Draw and shapes', desc: 'Freehand, rectangles, check marks', icon: 'draw', run: async () => { if (await needDoc()) D.setTool('draw'); } },
    { id: 'markups', cat: 'edit', label: 'Remove markups', desc: 'Delete highlights, checks and comments, including from other apps', icon: 'markups', run: async () => { if (await needDoc()) D.openMarkups(); } },
    { id: 'fill', cat: 'sign', label: 'Fill & Sign', desc: 'Type into forms and tick boxes', icon: 'fillsign', run: async () => { if (await needDoc()) D.setTool('select'); } },
    { id: 'sign', cat: 'sign', label: 'Add signature', desc: 'Draw, type or import your signature', icon: 'sign', run: async () => { if (await needDoc()) D.setTool('sign'); } },
    { id: 'protect', cat: 'protect', label: 'Protect with password', desc: 'Require a password; limit printing or copying', icon: 'lock', run: protect },
    { id: 'redact', cat: 'protect', label: 'Redact', desc: 'Remove sensitive content for good', icon: 'redact', run: async () => { if (await needDoc()) D.setTool('redact'); } },
    { id: 'combine', cat: 'organize', label: 'Combine PDFs', desc: 'Put files together in the order you choose', icon: 'combine', run: () => window.BubbyCombine.open(D.S.pages.length && !D.atHome() ? { fromWorkspace: true } : {}) },
    { id: 'split', cat: 'organize', label: 'Split PDF', desc: 'By ranges, every page, or fixed-size parts', icon: 'split', run: split },
    { id: 'organize', cat: 'organize', label: 'Organize pages', desc: 'Reorder, rotate, delete, extract pages', icon: 'organize', run: async () => { if (await needDoc()) D.focusPages(); } },
    { id: 'pagenumbers', cat: 'organize', label: 'Page numbers', desc: 'Number pages, choose position and format', icon: 'hash', run: async () => { if (await needDoc()) marksDialog('pageNumbers'); } },
    { id: 'watermark', cat: 'organize', label: 'Watermark', desc: 'Stamp text across pages', icon: 'stamp', run: async () => { if (await needDoc()) marksDialog('watermark'); } },
    { id: 'toword', cat: 'convert', label: 'PDF to Word', desc: 'Editable .docx that looks like the PDF', icon: 'convert', run: toWord },
    { id: 'toexcel', cat: 'convert', label: 'PDF to Excel', desc: 'Tables to .xlsx, one sheet per page', icon: 'convert', run: toExcel },
    { id: 'toppt', cat: 'convert', label: 'PDF to PowerPoint', desc: 'One slide per page, text stays editable', icon: 'convert', run: toPowerPoint },
    { id: 'toimage', cat: 'convert', label: 'PDF to images', desc: 'Pages as PNG/JPG, or extract pictures', icon: 'images', run: toImages },
    { id: 'tohtml', cat: 'convert', label: 'PDF to HTML', desc: 'A web page that looks like the PDF', icon: 'convert', run: toHtml },
    { id: 'tomd', cat: 'convert', label: 'PDF to Markdown', desc: 'Headings, lists, bold and italic', icon: 'convert', run: toMarkdown },
    { id: 'totext', cat: 'convert', label: 'PDF to text', desc: 'Plain text, page by page', icon: 'convert', run: toText },
    { id: 'fromword', cat: 'convert', label: 'Word to PDF', desc: '.docx (more formats with LibreOffice)', icon: 'convert', run: () => makePdf('word') },
    { id: 'fromexcel', cat: 'convert', label: 'Excel to PDF', desc: '.xlsx and .csv', icon: 'convert', run: () => makePdf('excel') },
    { id: 'fromppt', cat: 'convert', label: 'PowerPoint to PDF', desc: '.pptx slides', icon: 'convert', run: () => makePdf('powerpoint') },
    { id: 'fromimages', cat: 'convert', label: 'Images to PDF', desc: 'JPG and PNG, with page size and margins', icon: 'images', run: () => makePdf('images') },
    { id: 'fromtext', cat: 'convert', label: 'Text to PDF', desc: '.txt and .md files', icon: 'convert', run: () => makePdf('text') },
    { id: 'fromhtml', cat: 'convert', label: 'Web page to PDF', desc: 'A saved .html file from your computer', icon: 'convert', run: () => makePdf('html') },
    { id: 'ocr', cat: 'more', label: 'Recognize text (OCR)', desc: 'Make scanned pages searchable', icon: 'scan', run: recognize },
    { id: 'compress', cat: 'more', label: 'Reduce file size', desc: 'Smaller file, sharp text', icon: 'compress', run: compress },
    { id: 'repair', cat: 'more', label: 'Repair PDF', desc: 'Recover a damaged file', icon: 'wrench', run: repair },
    { id: 'read', cat: 'more', label: 'Read aloud', desc: 'Listen from the current page', icon: 'headphones', run: readAloud },
    { id: 'blank', cat: 'more', label: 'New blank PDF', desc: 'Start from an empty page', icon: 'blank', run: blankPdf },
    { id: 'print', cat: 'more', label: 'Print', desc: 'Print with your markups', icon: 'print', run: async () => { if (await needDoc()) D.printDoc(); } },
  ];
  const CATS = { edit: 'Edit', sign: 'Fill & Sign', organize: 'Organize', convert: 'Convert', protect: 'Protect', more: 'More' };

  function init(deps) { D = deps; }
  window.BubbyTools = {
    init, TOOLS, CATS, applyMarks, drawMarksOverlay, writeOcr, readRegion, ocrWorker, readCanvas,
    exactPages, docxExact, pptxExact, htmlExact, pageLayout, realFont, EX,
    toWord, toExcel, toPowerPoint, toHtml, toMarkdown, toText, toImages, makePdf, protect, compress, compressBytes, split, parseRanges,
    marksDialog, repair, blankPdf, recognize, readAloud, imagesToPdf, wordToPdf, excelToPdf, pptxToPdf, textToPdf, pptxFile, xlsxFile, pageParagraphs, pageImages,
  };
})();
