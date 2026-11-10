'use strict';
/* BubbyPDF text editing support.
   removeText() deletes the text-showing operators whose start point falls inside given regions of a
   page's content stream, and replaces each with an equal-width blank move ("[n] TJ"), so every other
   piece of text on the page stays exactly where it was. Fonts it cannot measure (Type 3, text inside
   form XObjects) are reported as unsupported so the caller can fall back to covering the area. */
(() => {
  const L = () => window.PDFLib;

  // ---------- standard 14 font metrics (used for measuring and for fonts without /Widths) ----------
  let scratch = null; const stdCache = new Map();
  async function stdFont(name) {
    if (stdCache.has(name)) return stdCache.get(name);
    if (!scratch) scratch = await L().PDFDocument.create();
    const f = await scratch.embedFont(name);
    stdCache.set(name, f);
    return f;
  }
  const stdFontSync = (name) => stdCache.get(name) || null;
  function stdName(family, bold, italic) {
    const S = L().StandardFonts;
    if (family === 'times') return bold && italic ? S.TimesRomanBoldItalic : bold ? S.TimesRomanBold : italic ? S.TimesRomanItalic : S.TimesRoman;
    if (family === 'cour') return bold && italic ? S.CourierBoldOblique : bold ? S.CourierBold : italic ? S.CourierOblique : S.Courier;
    return bold && italic ? S.HelveticaBoldOblique : bold ? S.HelveticaBold : italic ? S.HelveticaOblique : S.Helvetica;
  }
  async function loadAllStd() {
    for (const fam of ['helv', 'times', 'cour']) for (const b of [false, true]) for (const i of [false, true]) await stdFont(stdName(fam, b, i));
  }
  function stdForBase(base) {
    const n = base.replace(/^([A-Z]{6}\+)/, '').replace(/[,_ -]/g, '').toLowerCase();
    const bold = /bold|black|heavy|semibold|demi/.test(n), italic = /italic|oblique/.test(n);
    if (/symbol/.test(n)) return L().StandardFonts.Symbol;
    if (/zapf|dingbat/.test(n)) return L().StandardFonts.ZapfDingbats;
    if (/courier|mono/.test(n)) return stdName('cour', bold, italic);
    if (/times|roman|serif|georgia|garamond|minion|cambria/.test(n) && !/sans/.test(n)) return stdName('times', bold, italic);
    if (/helvetica|arial|sans|verdana|calibri|segoe|tahoma/.test(n)) return stdName('helv', bold, italic);
    return null;
  }

  // ---------- content stream tokenizer ----------
  const WS = new Set([0, 9, 10, 12, 13, 32]);
  const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
  function tokenize(b) {
    const ops = []; let args = []; let argStart = -1; const stack = []; const n = b.length; let i = 0;
    const put = (v, s) => { if (stack.length) stack[stack.length - 1].push(v); else { if (argStart < 0) argStart = s; args.push(v); } };
    while (i < n) {
      const c = b[i];
      if (WS.has(c)) { i++; continue; }
      if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; }
      const s = i;
      if (c === 40) {
        let depth = 1; i++; const out = [];
        while (i < n && depth > 0) {
          const ch = b[i++];
          if (ch === 92) {
            const e = b[i++];
            if (e === 110) out.push(10); else if (e === 114) out.push(13); else if (e === 116) out.push(9);
            else if (e === 98) out.push(8); else if (e === 102) out.push(12);
            else if (e === 13) { if (b[i] === 10) i++; } else if (e === 10) { /* line continuation */ }
            else if (e >= 48 && e <= 55) { let v = e - 48; for (let k = 0; k < 2 && b[i] >= 48 && b[i] <= 55; k++) v = v * 8 + (b[i++] - 48); out.push(v & 255); }
            else out.push(e);
          } else if (ch === 40) { depth++; out.push(ch); }
          else if (ch === 41) { depth--; if (depth) out.push(ch); }
          else out.push(ch);
        }
        put({ str: Uint8Array.from(out) }, s); continue;
      }
      if (c === 60) {
        if (b[i + 1] === 60) {
          let depth = 0;
          while (i < n) {
            if (b[i] === 60 && b[i + 1] === 60) { depth++; i += 2; } else if (b[i] === 62 && b[i + 1] === 62) { depth--; i += 2; if (!depth) break; } else i++;
          }
          put({ dict: true }, s); continue;
        }
        i++; let hex = '';
        while (i < n && b[i] !== 62) { if (!WS.has(b[i])) hex += String.fromCharCode(b[i]); i++; }
        i++; if (hex.length % 2) hex += '0';
        const out = new Uint8Array(hex.length / 2);
        for (let k = 0; k < out.length; k++) out[k] = parseInt(hex.substr(k * 2, 2), 16) || 0;
        put({ str: out }, s); continue;
      }
      if (c === 91) { if (!stack.length && argStart < 0) argStart = s; stack.push([]); i++; continue; }
      if (c === 93) { i++; const arr = stack.pop() || []; if (stack.length) stack[stack.length - 1].push(arr); else args.push(arr); continue; }
      if (c === 47) { i++; let nm = ''; while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) nm += String.fromCharCode(b[i++]); put({ name: nm }, s); continue; }
      if (c === 123 || c === 125 || c === 41 || c === 62) { i++; continue; }
      let tok = '';
      while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) tok += String.fromCharCode(b[i++]);
      if (!tok) { i++; continue; }
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) { put(parseFloat(tok), s); continue; }
      if (tok === 'true' || tok === 'false' || tok === 'null') { put(tok, s); continue; }
      if (stack.length) continue;
      ops.push({ op: tok, args, start: argStart < 0 ? s : argStart, end: i });
      args = []; argStart = -1;
      if (tok === 'ID') { // inline image: skip binary data up to EI
        let j = i + 1;
        while (j < n - 1 && !(b[j] === 69 && b[j + 1] === 73 && WS.has(b[j - 1]) && (j + 2 >= n || WS.has(b[j + 2])))) j++;
        i = Math.min(n, j + 2);
        ops.push({ op: 'EI', args: [], start: j, end: i });
      }
    }
    return ops;
  }

  // ---------- fonts on the page ----------
  async function fontInfo(doc, fd) {
    const P = L(); const N = (s) => P.PDFName.of(s); const ctx = doc.context;
    const num = (o) => { const v = ctx.lookup(o); return v && v.asNumber ? v.asNumber() : 0; };
    const sub = String(fd.get(N('Subtype')) || '');
    if (sub === '/Type3') return null;
    if (sub === '/Type0') {
      const enc = String(fd.get(N('Encoding')) || '');
      if (enc && !/Identity-[HV]/.test(enc)) return null;
      const desc = fd.lookup(N('DescendantFonts')); const d0 = desc && ctx.lookup(desc.get(0));
      if (!d0) return null;
      const dwv = d0.lookup(N('DW')); const dw = dwv ? dwv.asNumber() : 1000;
      const map = new Map(); const W = d0.lookup(N('W'));
      if (W) {
        const a = W.asArray().map((x) => ctx.lookup(x));
        for (let k = 0; k < a.length;) {
          const c0 = a[k].asNumber(); const nx = a[k + 1];
          if (nx instanceof P.PDFArray) { nx.asArray().forEach((w, j) => map.set(c0 + j, num(w))); k += 2; }
          else { const c1 = nx.asNumber(), w = num(a[k + 2]); for (let cc = c0; cc <= c1; cc++) map.set(cc, w); k += 3; }
        }
      }
      return { two: true, w: (code) => (map.has(code) ? map.get(code) : dw) };
    }
    const widths = fd.lookup(N('Widths'));
    if (widths) {
      const fc = fd.lookup(N('FirstChar')); const first = fc ? fc.asNumber() : 0;
      const arr = widths.asArray().map(num);
      let missing = 0; const desc = fd.lookup(N('FontDescriptor'));
      if (desc) { const mw = desc.lookup(N('MissingWidth')); if (mw) missing = mw.asNumber(); }
      return { two: false, w: (code) => { const k = code - first; return k >= 0 && k < arr.length ? arr[k] : missing; } };
    }
    const std = stdForBase(String(fd.get(N('BaseFont')) || '').replace(/^\//, ''));
    if (!std) return null;
    const f = await stdFont(std); const dec = new TextDecoder('windows-1252');
    return { two: false, w: (code) => { try { return f.widthOfTextAtSize(dec.decode(Uint8Array.of(code)), 1000); } catch { return 500; } } };
  }

  const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
  const fmt = (v) => (Math.round(v * 1000) / 1000).toString();

  function streamBytes(st) {
    const P = L();
    if (st instanceof P.PDFRawStream) return P.decodePDFRawStream(st).decode();
    if (st.getUnencodedContents) return st.getUnencodedContents();
    return new Uint8Array(0);
  }

  async function removeText(doc, page, regions, opts = {}) {
    const P = L(); const N = (s) => P.PDFName.of(s); const ctx = doc.context;
    const raw = page.node.get(N('Contents'));
    if (!raw) return { removed: 0, unsupported: 0 };
    const list = raw instanceof P.PDFArray ? raw.asArray() : [raw];
    const refs = []; const chunks = [];
    for (const r of list) {
      const st = ctx.lookup(r); if (!st) continue;
      chunks.push(streamBytes(st), Uint8Array.of(10));
      if (r instanceof P.PDFRef) refs.push(r);
    }
    const total = chunks.reduce((t, c) => t + c.length, 0);
    const bytes = new Uint8Array(total); let o = 0; for (const c of chunks) { bytes.set(c, o); o += c.length; }
    const res = page.node.Resources(); const fontDict = res && res.lookup(N('Font'));
    const fonts = new Map();
    const getFont = async (name) => {
      if (!name || !fontDict) return null;
      if (fonts.has(name)) return fonts.get(name);
      let info = null;
      try { const fd = fontDict.lookup(N(name)); if (fd instanceof P.PDFDict) info = await fontInfo(doc, fd); } catch { info = null; }
      fonts.set(name, info); return info;
    };
    const advance = (arg, fi, gs) => {
      if (!fi) return null;
      const parts = Array.isArray(arg) ? arg : [arg]; let tx = 0;
      for (const el of parts) {
        if (typeof el === 'number') { tx -= (el / 1000) * gs.size * gs.Th; continue; }
        if (!el || !el.str) continue;
        const s = el.str;
        if (fi.two) {
          for (let k = 0; k + 1 < s.length; k += 2) tx += ((fi.w((s[k] << 8) | s[k + 1]) / 1000) * gs.size + gs.Tc) * gs.Th;
        } else {
          for (const code of s) tx += ((fi.w(code) / 1000) * gs.size + gs.Tc + (code === 32 ? gs.Tw : 0)) * gs.Th;
        }
      }
      return tx;
    };
    const ops = tokenize(bytes);
    let gs = { ctm: [1, 0, 0, 1, 0, 0], Tc: 0, Tw: 0, Th: 1, TL: 0, Ts: 0, font: null, size: 0, fillCS: '', fill: '0 g' };
    const opText = (op) => new TextDecoder('latin1').decode(bytes.subarray(op.start, op.end));
    const caps = regions.map(() => null); const capPool = new Map(); const scan = [];
    const stack = []; let Tm = [1, 0, 0, 1, 0, 0], Tlm = [1, 0, 0, 1, 0, 0];
    const edits = []; let removed = 0, unsupported = 0;
    for (const op of ops) {
      const A = op.args;
      switch (op.op) {
        case 'q': stack.push({ ...gs, ctm: gs.ctm.slice() }); break;
        case 'Q': if (stack.length) gs = stack.pop(); break;
        case 'cm': if (A.length >= 6) gs.ctm = mul(A.slice(0, 6), gs.ctm); break;
        case 'BT': Tm = [1, 0, 0, 1, 0, 0]; Tlm = Tm.slice(); break;
        case 'rg': case 'g': case 'k': gs.fill = opText(op); gs.fillCS = ''; break;
        case 'cs': gs.fillCS = opText(op); break;
        case 'sc': case 'scn': gs.fill = (gs.fillCS ? gs.fillCS + ' ' : '') + opText(op); break;
        case 'Tc': gs.Tc = A[0] || 0; break;
        case 'Tw': gs.Tw = A[0] || 0; break;
        case 'Tz': gs.Th = (A[0] == null ? 100 : A[0]) / 100; break;
        case 'TL': gs.TL = A[0] || 0; break;
        case 'Ts': gs.Ts = A[0] || 0; break;
        case 'Tf': gs.font = A[0] && A[0].name; gs.size = A[1] || 0; break;
        case 'Td': Tlm = mul([1, 0, 0, 1, A[0] || 0, A[1] || 0], Tlm); Tm = Tlm.slice(); break;
        case 'TD': gs.TL = -(A[1] || 0); Tlm = mul([1, 0, 0, 1, A[0] || 0, A[1] || 0], Tlm); Tm = Tlm.slice(); break;
        case 'Tm': if (A.length >= 6) { Tlm = A.slice(0, 6); Tm = Tlm.slice(); } break;
        case 'T*': Tlm = mul([1, 0, 0, 1, 0, -gs.TL], Tlm); Tm = Tlm.slice(); break;
        case 'Tj': case 'TJ': case "'": case '"': {
          if (op.op === '"') { gs.Tw = A[0] || 0; gs.Tc = A[1] || 0; }
          if (op.op === "'" || op.op === '"') { Tlm = mul([1, 0, 0, 1, 0, -gs.TL], Tlm); Tm = Tlm.slice(); }
          const arg = op.op === '"' ? A[2] : A[0];
          const fi = await getFont(gs.font);
          const trm = mul([1, 0, 0, 1, 0, gs.Ts], mul(Tm, gs.ctm));
          const x = trm[4], y = trm[5];
          const adv = advance(arg, fi, gs);
          const ri = regions.findIndex((r) => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2);
          if (ri >= 0) {
            if (adv == null || !gs.size || !gs.Th) unsupported++;
            else {
              // The style of this run, in page units: what new text must use to look the same.
              const tm = mul(Tm, gs.ctm); const sy = Math.hypot(tm[2], tm[3]) || 1; const sx = Math.hypot(tm[0], tm[1]) || 1;
              const rot = Math.abs(tm[1]) > 1e-3 || Math.abs(tm[2]) > 1e-3 || tm[0] <= 0 || tm[3] <= 0;
              const ck = [gs.font, fmt(gs.size * sy), fmt(gs.Tc * sy), fmt(gs.Tw * sy), fmt(gs.Th * sx / sy), gs.fill, rot].join('|');
              let cap = capPool.get(ck);
              if (!cap) { cap = { font: gs.font, size: gs.size * sy, Tc: gs.Tc * sy, Tw: gs.Tw * sy, Th: gs.Th * sx / sy, fill: gs.fill, rotated: rot }; capPool.set(ck, cap); }
              if (!caps[ri]) caps[ri] = cap;
              scan.push({ ri, x, y, w: adv * sx, cap });
              removed++;
              let rep = `[${fmt(-adv * 1000 / (gs.size * gs.Th))}] TJ`;
              if (op.op === "'") rep = `T* ${rep}`;
              if (op.op === '"') rep = `${fmt(A[0] || 0)} Tw ${fmt(A[1] || 0)} Tc T* ${rep}`;
              edits.push({ start: op.start, end: op.end, text: ` ${rep} ` });
            }
          }
          if (adv != null) Tm = mul([1, 0, 0, 1, adv, 0], Tm);
          break;
        }
        default: break;
      }
    }
    if (!removed || opts.dryRun) return { removed, unsupported, caps, scan };
    const enc = new TextEncoder(); const out = []; let pos = 0;
    edits.sort((a, b) => a.start - b.start);
    for (const e of edits) { out.push(bytes.subarray(pos, e.start), enc.encode(e.text)); pos = e.end; }
    out.push(bytes.subarray(pos));
    const len = out.reduce((t, c) => t + c.length, 0); const nb = new Uint8Array(len); let q = 0;
    for (const c of out) { nb.set(c, q); q += c.length; }
    page.node.set(N('Contents'), ctx.register(ctx.flateStream(nb)));
    // pdf-lib keeps its own handle on the page's content stream; it is gone now, so make it start a new one.
    page.contentStream = undefined; page.contentStreamRef = undefined;
    // Delete the old streams unless another page still uses them, so the removed text is really gone.
    const used = new Set();
    for (const pg of doc.getPages()) {
      if (pg === page) continue;
      const c = pg.node.get(N('Contents'));
      (c instanceof P.PDFArray ? c.asArray() : [c]).forEach((x) => { if (x instanceof P.PDFRef) used.add(x.tag); });
    }
    for (const r of refs) if (!used.has(r.tag)) ctx.delete(r);
    return { removed, unsupported, caps, scan };
  }


  // ---------- writing new text in the page's own font ----------
  const AGL = {
    space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'",
    quoteright: '’', quoteleft: '‘', parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-',
    period: '.', slash: '/', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@',
    bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|',
    braceright: '}', asciitilde: '~', quotedblleft: '“', quotedblright: '”', endash: '–', emdash: '—',
    bullet: '•', ellipsis: '…', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
    eight: '8', nine: '9',
  };
  function glyphChar(n) {
    if (n.length === 1) return n;
    if (Object.prototype.hasOwnProperty.call(AGL, n)) return AGL[n];
    const m = /^uni([0-9A-F]{4})$/i.exec(n) || /^u([0-9A-F]{4,6})$/i.exec(n);
    return m ? String.fromCodePoint(parseInt(m[1], 16)) : null;
  }
  // ToUnicode CMap: character code -> text. Inverted here: one character -> code.
  function parseCMap(text, map) {
    const hex = (h) => parseInt(h, 16);
    const u16 = (h) => { let out = ''; for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(hex(h.substr(i, 4))); return out; };
    const add = (ch, code) => { if ([...ch].length === 1 && !map.has(ch)) map.set(ch, code); };
    for (const block of text.split('beginbfchar').slice(1)) {
      const body = block.split('endbfchar')[0];
      for (const m of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) add(u16(m[2]), hex(m[1]));
    }
    for (const block of text.split('beginbfrange').slice(1)) {
      const body = block.split('endbfrange')[0];
      for (const m of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
        const lo = hex(m[1]), hi = hex(m[2]);
        if (m[3] != null) {
          const base = u16(m[3]);
          for (let c = lo; c <= hi && c - lo < 65536; c++) add(base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo)), c);
        } else {
          [...m[4].matchAll(/<([0-9a-fA-F]+)>/g)].forEach((d, k) => add(u16(d[1]), lo + k));
        }
      }
    }
    return map;
  }
  async function fontEncoder(doc, page, name, allowed) {
    const P = L(); const N = (x) => P.PDFName.of(x);
    const res = page.node.Resources(); const fonts = res && res.lookup(N('Font'));
    const fd = fonts && fonts.lookup(N(name));
    if (!(fd instanceof P.PDFDict)) return null;
    const info = await fontInfo(doc, fd); if (!info) return null;
    const map = new Map();
    const tu = fd.lookup(N('ToUnicode'));
    if (tu && tu.dict) { try { parseCMap(new TextDecoder('latin1').decode(streamBytes(tu)), map); } catch { /* no usable map */ } }
    const subset = /^\/[A-Z]{6}\+/.test(String(fd.get(N('BaseFont')) || ''));
    if (!map.size && !info.two) {
      const enc = fd.lookup(N('Encoding'));
      // An embedded subset with no character map and no declared encoding uses its own private codes: not safe to write with.
      if (subset && !enc) return null;
      const baseName = enc instanceof P.PDFName ? String(enc) : enc instanceof P.PDFDict ? String(enc.get(N('BaseEncoding')) || '') : '';
      const dec = new TextDecoder(baseName === '/MacRomanEncoding' ? 'macintosh' : 'windows-1252');
      for (let c = 32; c < 256; c++) { const ch = dec.decode(Uint8Array.of(c)); if (ch && ch !== '�' && !map.has(ch)) map.set(ch, c); }
      const diff = enc instanceof P.PDFDict ? enc.lookup(N('Differences')) : null;
      if (diff) {
        let code = 0;
        for (const el of diff.asArray()) {
          const v = doc.context.lookup(el);
          if (v && v.asNumber) { code = v.asNumber(); continue; }
          const ch = glyphChar(String(v).replace(/^\//, ''));
          for (const [k, c] of map) if (c === code) map.delete(k);
          if (ch) map.set(ch, code);
          code++;
        }
      }
    }
    // A subset font only has the glyphs the document already used.
    if (subset && allowed) for (const k of [...map.keys()]) if (!allowed.has(k) && k !== ' ') map.delete(k);
    if (!map.size) return null;
    return { name, info, map, two: info.two };
  }
  function encodeRun(enc, str) {
    let hex = '';
    for (const ch of str) hex += enc.map.get(ch).toString(16).padStart(enc.two ? 4 : 2, '0');
    return '<' + hex + '>';
  }
  function runWidth(enc, cap, str) {
    let w = 0;
    for (const ch of str) {
      const code = enc.map.get(ch);
      w += ((enc.info.w(code) / 1000) * cap.size + cap.Tc + (!enc.two && code === 32 ? cap.Tw : 0)) * cap.Th;
    }
    return w;
  }
  // Isolate whatever the page already draws, so anything added afterwards starts from a clean state.
  function wrap(doc, page) {
    const ctx = doc.context;
    if (!page.__bbWrapped) { page.node.wrapContentStreams(ctx.getPushGraphicsStateContentStream(), ctx.getPopGraphicsStateContentStream()); page.__bbWrapped = true; }
  }
  function appendContent(doc, page, ops) {
    wrap(doc, page);
    page.node.addContentStream(doc.context.register(doc.context.flateStream('q\n' + ops + '\nQ')));
  }

  window.BubbyTextEdit = { removeText, stdFont, stdFontSync, stdName, loadAllStd, tokenize, fontEncoder, encodeRun, runWidth, appendContent, wrap, parseCMap, fmt };
})();
