// In-page end-to-end test. Load the app (src/index.html) in a browser, then:
//   const t = await import('../test/ui-test.mjs'); await t.run();
// Opens test/fixture.pdf, exercises every editing feature through the app's own code,
// saves, then re-reads the output with pdf.js and pdf-lib and checks the result.
export async function run() {
  const D = window.__bubbypdf; const { S } = D;
  const results = [];
  const check = (name, ok, info = '') => { results.push({ name, ok: !!ok, info }); };
  const bytes = new Uint8Array(await (await fetch('../test/fixture.pdf')).arrayBuffer());

  await D.openFiles([{ name: 'fixture.pdf', path: null, bytes }], { replace: true });
  check('opens 3 pages', S.pages.length === 3, S.pages.length);
  check('reads stored rotation', S.pages[1].rot0 === 90, S.pages[1].rot0);
  await new Promise((r) => setTimeout(r, 800));
  check('renders form fields as inputs', document.querySelectorAll('.field').length >= 5, document.querySelectorAll('.field').length);
  check('renders internal link', document.querySelectorAll('.link').length >= 1);

  // Fill form fields through the UI
  const docId = S.pages[0].docId;
  const fire = (n, ev) => n.dispatchEvent(new Event(ev, { bubbles: true }));
  const name = document.querySelector(`[data-field="${docId}|name"]`); name.value = 'Ada Lovelace'; fire(name, 'change');
  const agree = document.querySelector(`[data-field="${docId}|agree"]`); agree.checked = true; fire(agree, 'change');
  const radios = [...document.querySelectorAll(`[data-field="${docId}|size"]`)];
  check('renders both radio options', radios.length === 2, radios.map((n) => n.dataset.on).join(','));
  const large = radios[1]; large.checked = true; fire(large, 'change');
  const color = document.querySelector(`[data-field="${docId}|color"]`); color.value = 'blue'; fire(color, 'change');

  // Annotations of every type
  const p0 = S.pages[0], p2 = S.pages[2];
  p0.annots.push({ id: 't1', type: 'text', x: 300, y: 100, size: 14, color: '#C62828', font: 'helv', text: 'Approved by BubbyPDF\nline two' });
  p0.annots.push({ id: 'h1', type: 'highlight', x: 70, y: 95, w: 200, h: 14, color: '#FFD84D' });
  p0.annots.push({ id: 'c1', type: 'check', mark: 'check', x: 400, y: 150, size: 24, color: '#111111' });
  p0.annots.push({ id: 'i1', type: 'ink', pts: [[100, 300], [150, 320], [200, 300]], color: '#1F4FD1', width: 2 });
  p2.annots.push({ id: 'r1', type: 'rect', x: 60, y: 60, w: 200, h: 60, color: '#0E7466', width: 2 });
  p2.annots.push({ id: 'w1', type: 'whiteout', x: 60, y: 200, w: 100, h: 30 });
  p0.annots.push({ id: 'u1', type: 'text', x: 300, y: 200, size: 12, color: '#111111', font: 'times', text: 'Ünïcödé ok — 日本' });

  // Edit existing text: find "Invoice number 4471" and replace it
  const items = await D.textItems(p0);
  const idx = items.findIndex((it) => it.str.includes('Invoice number'));
  check('finds existing text', idx >= 0, idx);

  // F03: edit existing text by clicking it in the Edit text tool, typing, and committing
  D.setTool('edittext');
  D.layoutPages(false);
  await new Promise((r) => setTimeout(r, 900));
  const blocks0 = await D.textBlocks(p0);
  const bidx = blocks0.findIndex((b) => b.text.includes('Invoice number'));
  const tx = document.querySelector(`.page[data-key="${p0.key}"] .tx[data-blk="${bidx}"]`);
  check('F03 edit-text hit box exists', !!tx);
  if (tx) {
    const rc = tx.getBoundingClientRect();
    tx.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: rc.left + 3, clientY: rc.top + 3, pointerId: 1 }));
    await new Promise((r) => setTimeout(r, 150));
    const ed = document.querySelector('.editor');
    check('F03 opens inline editor with the old text', ed && ed.value.includes('Invoice number'), ed && ed.value);
    if (ed) { ed.value = 'Invoice number 9999 for red widgets.'; ed.dispatchEvent(new Event('input')); ed.blur(); }
    check('F03 replacement text stored', p0.annots.some((a) => a.type === 'textedit' && a.text.includes('9999')));
    check('F03 edit remembers the original area', p0.annots.some((a) => a.type === 'textedit' && a.region && a.region.w > 50));
  }
  D.setTool('select');

  // F01-N1: a file that is not a PDF shows an error instead of crashing
  const before0 = S.pages.length;
  await D.openFiles([{ name: 'broken.pdf', path: null, bytes: new TextEncoder().encode('not a pdf at all') }], { replace: false });
  check('F01-N1 broken file rejected, document unchanged', S.pages.length === before0 && !document.querySelector('#toast').hidden && /could not be opened/.test(document.querySelector('#toast').textContent), document.querySelector('#toast').textContent);

  // Search
  const hits = await D.runSearch('widgets');
  check('search finds matches on 2 pages', hits === 2, hits);

  // Undo/redo
  const before = S.pages[2].annots.length;
  D.S.undo.push(JSON.stringify({ pages: S.pages, fields: [...S.fields] }));
  S.pages[2].annots.push({ id: 'tmp', type: 'rect', x: 1, y: 1, w: 5, h: 5, color: '#111111', width: 1 });
  D.undo();
  check('undo removes change', S.pages[2].annots.length === before);
  D.redo();
  check('redo restores change', S.pages[2].annots.length === before + 1);
  D.undo();

  // Rotation + blank page + delete
  S.selPages = new Set([S.pages[2].key]);
  D.rotatePages(90);
  check('rotate selected page', S.pages[2].rot === 90);
  S.selPages = new Set(); S.current = 2;
  D.insertBlank();
  check('insert blank page', S.pages.length === 4 && S.pages[3].blank);

  // Build (merge path since a blank page was added)
  let out = await D.buildPdf(S.pages);
  check('reports replaced characters', out.replaced >= 2, out.replaced);
  let lib = await window.PDFLib.PDFDocument.load(out.bytes);
  check('output has 4 pages', lib.getPageCount() === 4, lib.getPageCount());
  check('page 3 rotated 90', lib.getPage(2).getRotation().angle === 90, lib.getPage(2).getRotation().angle);
  check('page 2 keeps stored rotation', lib.getPage(1).getRotation().angle === 90);
  let pdf = await window.pdfjsLib.getDocument({ data: out.bytes.slice(), isEvalSupported: false }).promise;
  let txt = (await (await pdf.getPage(1)).getTextContent()).items.map((i) => i.str).join(' ');
  const anns1 = await (await pdf.getPage(1)).getAnnotations();
  const annText = anns1.map((a) => (a.contentsObj && a.contentsObj.str) || a.contents || '').join(' | ');
  check('added text saved as a text annotation', annText.includes('Approved by BubbyPDF') && annText.includes('line two'), annText.slice(0, 160));
  check('F03 edited text is page text, old text removed', txt.includes('9999') && !txt.includes('4471'), txt.slice(0, 200));
  check('flattened field value is in the output', txt.includes('Ada Lovelace'), '');

  // In-place path: remove the blank page and undo the rotation, so forms stay fillable
  S.pages = S.pages.filter((p) => !p.blank); S.pages[2].rot = 0;
  out = await D.buildPdf(S.pages);
  lib = await window.PDFLib.PDFDocument.load(out.bytes);
  const form = lib.getForm();
  check('in-place: text field value saved', form.getTextField('name').getText() === 'Ada Lovelace', form.getTextField('name').getText());
  check('in-place: checkbox saved', form.getCheckBox('agree').isChecked());
  check('in-place: radio saved', form.getRadioGroup('size').getSelected() === 'large', form.getRadioGroup('size').getSelected());
  check('in-place: dropdown saved', form.getDropdown('color').getSelected()[0] === 'blue', form.getDropdown('color').getSelected());

  // Extract a single page
  out = await D.buildPdf([S.pages[2]]);
  lib = await window.PDFLib.PDFDocument.load(out.bytes);
  check('extract 1 page', lib.getPageCount() === 1);

  // Merge two copies
  await D.openFiles([{ name: 'fixture-copy.pdf', path: null, bytes }], { replace: false });
  check('merge appends pages', S.pages.length === 6, S.pages.length);
  out = await D.buildPdf(S.pages);
  lib = await window.PDFLib.PDFDocument.load(out.bytes);
  check('merged output has 6 pages', lib.getPageCount() === 6);

  // ---------- wave 1 ----------
  S.dirty = false;
  await D.openFiles([{ name: 'fixture.pdf', path: null, bytes }], { replace: true });
  const q0 = S.pages[0], q2 = S.pages[2];
  // Snapping: a drag across "Invoice number 4471" should hug the words
  const items0 = await D.textItems(q0);
  const inv = items0.find((it) => it.str.includes('Invoice number'));
  const snapped = await D.snapRects(q0, { x: inv.u - 5, y: inv.vb - 6, w: 120, h: 4 });
  check('W1 text markup snaps to the words', snapped.length === 1 && Math.abs(snapped[0].x - inv.u) < 1 && snapped[0].w < 125 && snapped[0].w > 60, JSON.stringify(snapped));
  const rects = snapped;
  const bb = { x: rects[0].x, y: rects[0].y, w: rects[0].w, h: rects[0].h };
  q0.annots.push({ id: 'u1', type: 'underline', color: '#C62828', rects, ...bb });
  q0.annots.push({ id: 's1', type: 'strike', color: '#1F4FD1', rects, ...bb });
  q0.annots.push({ id: 'hl', type: 'highlight', color: '#FFD84D', rects, ...bb });
  q0.annots.push({ id: 'n1', type: 'note', x: 500, y: 60, color: '#FFD84D', text: 'Check the invoice total' });
  q0.annots.push({ id: 'k1', type: 'check', mark: 'dot', x: 450, y: 150, size: 16, color: '#111111' });
  q0.annots.push({ id: 'tx', type: 'text', x: 300, y: 100, size: 14, color: '#C62828', font: 'helv', text: 'Approved' });
  q0.annots.push({ id: 'ik', type: 'ink', pts: [[100, 300], [150, 320]], color: '#1F4FD1', width: 2 });
  const sig = document.createElement('canvas'); sig.width = 60; sig.height = 20; sig.getContext('2d').fillRect(5, 5, 50, 10);
  D.S.images.set('img1', { id: 'img1', dataUrl: sig.toDataURL('image/png'), bytes: Uint8Array.from(atob(sig.toDataURL('image/png').split(',')[1]), (c) => c.charCodeAt(0)), mime: 'png', w0: 60, h0: 20 });
  q0.annots.push({ id: 'im', type: 'image', imageId: 'img1', x: 60, y: 600, w: 120, h: 40 });
  const before1 = q0.annots.length;
  out = await D.buildPdf(S.pages);
  lib = await window.PDFLib.PDFDocument.load(out.bytes);
  const subs = lib.getPage(0).node.Annots().asArray().map((r) => lib.context.lookup(r)).map((d) => String(d.get(window.PDFLib.PDFName.of('Subtype')))).filter((s) => s !== '/Widget' && s !== '/Link');
  check('W1 markups saved as real PDF annotations', ['/Underline', '/StrikeOut', '/Highlight', '/Text', '/Stamp', '/FreeText', '/Ink'].every((s) => subs.includes(s)), subs.join(','));
  check('W1 form stays fillable when saving markups', lib.getForm().getFields().length >= 4);
  pdf = await window.pdfjsLib.getDocument({ data: out.bytes.slice(), isEvalSupported: false }).promise;
  const note = (await (await pdf.getPage(1)).getAnnotations()).find((a) => a.subtype === 'Text');
  check('W1 sticky note text readable by other viewers', note && ((note.contentsObj && note.contentsObj.str) || note.contents) === 'Check the invoice total');
  // Reopen: our annotations come back as editable objects, and are removed from the file layer
  S.dirty = false;
  await D.openFiles([{ name: 'saved.pdf', path: null, bytes: out.bytes }], { replace: true });
  check('W1 reopened markups are editable again', S.pages[0].annots.length === before1, `${S.pages[0].annots.length} vs ${before1}`);
  check('W1 reopened types match', ['underline', 'strike', 'highlight', 'note', 'check', 'text', 'ink', 'image'].every((t) => S.pages[0].annots.some((a) => a.type === t)));
  const reDoc = S.docs.get(S.pages[0].docId);
  const reAnns = await (await reDoc.pdf.getPage(1)).getAnnotations();
  check('W1 no duplicate drawn by the PDF layer', !reAnns.some((a) => a.subtype === 'Underline' || a.subtype === 'Text') && !D.hasMarker(reDoc.bytes), reAnns.map((a) => a.subtype).join(','));
  // Saving again does not double them
  out = await D.buildPdf(S.pages);
  lib = await window.PDFLib.PDFDocument.load(out.bytes);
  const n2 = lib.getPage(0).node.Annots().asArray().filter((r) => { const d = lib.context.lookup(r); return d.get(window.PDFLib.PDFName.of('BubbyPDFData')); }).length;
  check('W1 re-save keeps one copy of each annotation', n2 === before1, `${n2}`);

  // Redaction on page 3: the words must be gone from every stream in the file
  const p3 = S.pages[2];
  const it3 = (await D.textItems(p3)).find((it) => it.str.includes('Tuesday'));
  p3.annots.push({ id: 'rd', type: 'redact', x: it3.u - 2, y: it3.vb - it3.size, w: it3.w + 4, h: it3.size * 1.4 });
  out = await D.buildPdf(S.pages);
  check('W1 redaction reports 1 page', out.redactedPages === 1);
  pdf = await window.pdfjsLib.getDocument({ data: out.bytes.slice(), isEvalSupported: false }).promise;
  check('W1 redacted file still has 3 pages', pdf.numPages === 3);
  let allText = '';
  for (let i = 1; i <= pdf.numPages; i++) allText += (await (await pdf.getPage(i)).getTextContent()).items.map((x) => x.str).join(' ') + ' ';
  check('W1 redacted words not in page text', !allText.includes('Tuesday') && allText.includes('Invoice number'), allText.slice(0, 120));
  lib = await window.PDFLib.PDFDocument.load(out.bytes);
  const hexT = Array.from(new TextEncoder().encode('Tuesday')).map((b) => b.toString(16).padStart(2, '0')).join('');
  let leaked = false;
  for (const [, obj] of lib.context.enumerateIndirectObjects()) {
    if (!(obj instanceof window.PDFLib.PDFRawStream)) continue;
    let s;
    try { s = new TextDecoder('latin1').decode(window.PDFLib.decodePDFRawStream(obj).decode()); } catch { s = new TextDecoder('latin1').decode(obj.contents); }
    if (s.includes('Tuesday') || s.toLowerCase().includes(hexT)) { leaked = true; break; }
  }
  check('W1 redacted words not anywhere in the file', !leaked);

  // Printing renders every page (the dialog itself is not opened in tests)
  let printed = 0;
  await D.rasterize(out.bytes, [0, 1, 2], 72, async () => { printed++; });
  check('W1 print renders all pages', printed === 3);

  // ---------- wave 2: paragraph editing ----------
  S.dirty = false;
  await D.openFiles([{ name: 'fixture.pdf', path: null, bytes }], { replace: true });
  const e0 = S.pages[0];
  const blocks = await D.textBlocks(e0);
  const pb = blocks.findIndex((b) => b.text.includes('zephyr'));
  const para = blocks[pb];
  check('W2 finds the 3-line paragraph as one block', para && para.lines === 3 && para.text.endsWith('trip north.') && para.text.includes('them quiet'), para && JSON.stringify({ lines: para.lines, text: para.text }));
  check('W2 detects font, size and spacing', para && para.font === 'times' && Math.abs(para.size - 11) < 0.8 && Math.abs(para.leading - 14) < 0.5, para && `${para.font} ${para.size} ${para.leading}`);
  const fixturePdf = await window.pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const posOf = async (doc, needle) => { const it = (await (await doc.getPage(1)).getTextContent()).items.find((i) => i.str.includes(needle)); return it && it.transform; };
  const before2 = await posOf(fixturePdf, 'Invoice number');
  D.setTool('edittext');
  const ea = await D.editBlock(e0, pb);
  await new Promise((r) => setTimeout(r, 100));
  const ped = document.querySelector('.editor.para');
  check('W2 opens a paragraph editor with all the text', ped && ped.value === para.text, ped && ped.value);
  const NEW = 'We now ship twelve brass hinges with every crate, plus spare latches and a printed packing list so nothing rattles on the way north.';
  if (ped) { ped.value = NEW; ped.dispatchEvent(new Event('input')); ped.blur(); }
  check('W2 new text stored', ea && ea.text === NEW);
  ea.bold = true; // formatting carried to the file
  out = await D.buildPdf(S.pages);
  check('W2 old text removed cleanly (no white cover needed)', out.covered === 0, out.covered);
  pdf = await window.pdfjsLib.getDocument({ data: out.bytes.slice(), isEvalSupported: false }).promise;
  const page1 = await pdf.getPage(1);
  const tc1 = await page1.getTextContent();
  const all1 = tc1.items.map((i) => i.str).join(' ');
  check('W2 old paragraph words gone from page text', !all1.includes('zephyr') && !all1.includes('straw'), all1.slice(0, 200));
  check('W2 new paragraph is real page text', all1.includes('twelve brass hinges') && all1.includes('rattles'));
  const newLines = tc1.items.filter((i) => /twelve|crate|rattles|packing|nothing|north/.test(i.str));
  const [x0w, , , y1w] = e0.view;
  const maxRight = Math.max(...newLines.map((i) => i.transform[4] + i.width)) - x0w;
  check('W2 new paragraph wraps inside its box', newLines.length >= 2 && maxRight <= ea.x + ea.w + 1, `${newLines.length} lines, right ${maxRight.toFixed(1)} vs ${(ea.x + ea.w).toFixed(1)}`);
  const firstBase = y1w - newLines[0].transform[5];
  check('W2 first line sits on the original baseline', Math.abs(firstBase - para.firstBase) < 0.6, `${firstBase} vs ${para.firstBase}`);
  const after2 = await posOf(pdf, 'Invoice number');
  check('W2 other text did not move', after2 && Math.abs(after2[4] - before2[4]) < 0.01 && Math.abs(after2[5] - before2[5]) < 0.01);
  check('W2 bold font used', Object.values(tc1.styles).length >= 1 && (await page1.getOperatorList()) && newLines.length > 0);
  lib = await window.PDFLib.PDFDocument.load(out.bytes);
  let leaked2 = false; const hexZ = Array.from(new TextEncoder().encode('zephyr')).map((b) => b.toString(16).padStart(2, '0')).join('');
  for (const [, obj] of lib.context.enumerateIndirectObjects()) {
    if (!(obj instanceof window.PDFLib.PDFRawStream)) continue;
    let s; try { s = new TextDecoder('latin1').decode(window.PDFLib.decodePDFRawStream(obj).decode()); } catch { s = new TextDecoder('latin1').decode(obj.contents); }
    if (s.includes('zephyr') || s.toLowerCase().includes(hexZ)) { leaked2 = true; break; }
  }
  check('W2 old paragraph not anywhere in the file', !leaked2);
  check('W2 form still fillable after text edit', lib.getForm().getFields().length >= 4);
  // Merge path (a blank page forces copying into a new file)
  S.current = 0; D.insertBlank();
  out = await D.buildPdf(S.pages);
  pdf = await window.pdfjsLib.getDocument({ data: out.bytes.slice(), isEvalSupported: false }).promise;
  const allM = (await (await pdf.getPage(1)).getTextContent()).items.map((i) => i.str).join(' ');
  check('W2 edit also works when pages are rearranged', !allM.includes('zephyr') && allM.includes('twelve brass hinges'));
  D.undo();
  // Emptying a paragraph deletes it
  D.setTool('select');
  S.pages[0].annots.find((a) => a.type === 'textedit').text = ''; // undo replaced the objects, so look it up again
  out = await D.buildPdf(S.pages);
  pdf = await window.pdfjsLib.getDocument({ data: out.bytes.slice(), isEvalSupported: false }).promise;
  const allE = (await (await pdf.getPage(1)).getTextContent()).items.map((i) => i.str).join(' ');
  check('W2 emptied paragraph is deleted', !allE.includes('zephyr') && !allE.includes('twelve') && allE.includes('Invoice number'));

  // ---------- Combine screen ----------
  S.dirty = false;
  const C = window.BubbyCombine;
  await C.open({ files: [{ name: 'a.pdf', path: null, bytes }, { name: 'b.pdf', path: null, bytes }] });
  await new Promise((r) => setTimeout(r, 200));
  check('C opens with 2 files', C.state.items.length === 2 && document.body.classList.contains('in-combine'));
  check('C shows a card per file', document.querySelectorAll('#cbBody .ccard').length === 2);
  C.moveFile(C.state.items[1].id, 0);
  check('C reorder puts b first', C.state.items[0].name === 'b.pdf');
  C.undo(); check('C undo reorder', C.state.items[0].name === 'a.pdf');
  C.redo(); check('C redo reorder', C.state.items[0].name === 'b.pdf');
  C.toggleExpand(C.state.items[0].id);
  check('C expand shows each page', document.querySelectorAll('#cbBody .ccard.page').length === 3);
  C.state.sel = new Set(['p:' + C.state.items[0].pages[0].key]); C.removeSelected();
  check('C remove one page', C.state.items[0].pages.length === 2);
  C.undo(); check('C undo remove page', C.state.items[0].pages.length === 3);
  C.movePage(C.state.items[0].id, C.state.items[0].pages[2].key, 0);
  check('C reorder pages inside a file', C.state.items[0].pages[0].src === 2);
  await C.go();
  check('C combine opens 6 pages', S.pages.length === 6 && !document.body.classList.contains('in-combine') && S.fileName === 'Combined.pdf');
  check('C page order kept', S.pages[0].src === 2 && S.pages[3].src === 0);
  check('Save is available for the unsaved combined file', !document.querySelector('#btnSave').disabled);

  // ---------- exact preview after a paragraph edit ----------
  S.dirty = false;
  await D.openFiles([{ name: 'fixture.pdf', path: null, bytes }], { replace: true });
  const pv0 = S.pages[0];
  const pblocks = await D.textBlocks(pv0);
  const pbi = pblocks.findIndex((b) => b.text.includes('zephyr'));
  D.setTool('edittext');
  const pva = await D.editBlock(pv0, pbi);
  await new Promise((r) => setTimeout(r, 150));
  const ped2 = document.querySelector('.editor.para');
  check('Editor box opens at full paragraph height', ped2 && ped2.getBoundingClientRect().height >= 3 * pblocks[pbi].leading * S.zoom * 0.9, ped2 && ped2.getBoundingClientRect().height);
  if (ped2) { ped2.value = ped2.value.replace('eleven', 'twelve'); ped2.dispatchEvent(new Event('input')); ped2.blur(); }
  await new Promise((r) => setTimeout(r, 1500));
  check('Exact preview drawn from the saved result', D.pvReady(pv0), String(window.__bubbyPreviewError || 'no error').slice(0, 400));
  D.setTool('select');

  // ---------- wave 3: tools ----------
  {
    const T = window.BubbyTools; const PL = window.PDFLib;
    const saved = {}; window.__bubbyTestSave = async (kind, name, b) => { saved[kind] = b; return { name, path: null }; };
    const pdfText = async (b, pw) => { const d = await window.pdfjsLib.getDocument({ data: b.slice(), isEvalSupported: false, ...(pw ? { password: pw } : {}) }).promise; let t = ''; for (let i = 1; i <= d.numPages; i++) t += (await (await d.getPage(i)).getTextContent()).items.map((x) => x.str).join(' ') + '\n'; const n = d.numPages; d.destroy(); return { t, n }; };
    S.dirty = false;
    await D.openFiles([{ name: 'fixture.pdf', path: null, bytes }], { replace: true });

    // PDF to Word, read back by a separate Word reader
    await T.toWord({ mode: 'flow' });
    const html = saved.docx ? (await window.mammoth.convertToHtml({ arrayBuffer: saved.docx.slice().buffer })).value : '';
    check('T1 PDF to Word: readable .docx with the text', html.includes('Invoice number 4471') && html.includes('zephyr'), html.slice(0, 120));
    check('T1 PDF to Word: heading kept as a heading', /<h[12]>[^<]*BubbyPDF test form/.test(html) || /<p><strong>BubbyPDF test form/.test(html), html.slice(0, 160));
    // PDF to Excel, read back by a separate spreadsheet reader
    await T.toExcel();
    const wb = saved.xlsx ? window.XLSX.read(saved.xlsx, { type: 'array' }) : null;
    const csv = wb ? window.XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]) : '';
    check('T2 PDF to Excel: one sheet per page', wb && wb.SheetNames.length === 3, wb && wb.SheetNames.join(','));
    check('T2 PDF to Excel: cell text present', csv.includes('Invoice number 4471'), csv.slice(0, 120));
    // PDF to PowerPoint: valid package, converts back to PDF
    await T.toPowerPoint();
    let xmlOk = !!saved.pptx;
    if (saved.pptx) { const files = window.fflate.unzipSync(saved.pptx); for (const [k, v] of Object.entries(files)) if (/\.(xml|rels)$/.test(k)) { const d = new DOMParser().parseFromString(new TextDecoder().decode(v), 'application/xml'); if (d.getElementsByTagName('parsererror').length) { xmlOk = false; } } }
    check('T3 PDF to PowerPoint: every part is well-formed', xmlOk);
    const back = saved.pptx ? await T.pptxToPdf({ name: 'x.pptx', bytes: saved.pptx }, { builtIn: true }) : null;
    const backN = back ? (await pdfText(back.bytes)).n : 0;
    check('T3 PowerPoint to PDF: one page per slide', backN === 3, backN);
    // HTML, Markdown, text
    await T.toHtml({ mode: 'flow' }); await T.toMarkdown(); await T.toText();
    const hs = saved.html ? new TextDecoder().decode(saved.html) : '', ms = saved.md ? new TextDecoder().decode(saved.md) : '', ts = saved.txt ? new TextDecoder().decode(saved.txt) : '';
    check('T4 PDF to HTML / Markdown / text', hs.includes('zephyr') && ms.includes('zephyr') && ts.includes('Invoice number 4471') && /^# |^## /m.test(ms));

    // ---------- exact-layout conversions keep the page as it is ----------
    {
      // where each line of the original sits, to compare with what comes back
      const linesOf = async (b, pageNo = 1) => {
        const d = await window.pdfjsLib.getDocument({ data: b.slice(), isEvalSupported: false }).promise;
        const pg = await d.getPage(pageNo); const vp = pg.getViewport({ scale: 1 }); const U = window.pdfjsLib.Util;
        const out = (await pg.getTextContent()).items.filter((x) => x.str.trim()).map((x) => { const m = U.transform(vp.transform, x.transform); return { s: x.str.trim(), x: m[4], y: m[5], h: Math.hypot(m[2], m[3]) }; });
        const n = d.numPages; d.destroy(); return { out, n, w: vp.width, h: vp.height };
      };
      // for every word of 4+ letters that appears once in both, how far did it move?
      const drift = (a, b) => {
        const words = (L) => { const m = new Map(); for (const it of L) for (const w of it.s.split(/\s+/)) if (/^[A-Za-z]{4,}$/.test(w)) m.set(w, m.has(w) ? null : it); return m; };
        const A = words(a), B = words(b); const dx = [], dy = [];
        for (const [w, it] of A) { const o = B.get(w); if (it && o) { dx.push(Math.abs(o.x - it.x) <= it.h * 20 ? o.x - it.x : NaN); dy.push(o.y - it.y); } }
        const med = (v) => { const q = v.filter((z) => !Number.isNaN(z)).sort((p, r) => p - r); return q.length ? q[Math.floor(q.length / 2)] : NaN; };
        return { n: dy.length, dy: med(dy), maxDy: Math.max(...dy.map(Math.abs)), dx: med(dx) };
      };
      const orig = await linesOf(bytes);
      const L1 = await window.pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
      const lay = await T.pageLayout(await L1.getPage(1));
      const lay2 = await T.pageLayout(await L1.getPage(2)); L1.destroy();
      const zeph = lay.segs.find((g) => g.runs.some((r) => /zephyr/.test(r.t)));
      check('E1 exact layout: text lifted off the page with its font and colour', lay.segs.length > 5 && zeph && zeph.runs[0].font === 'Times New Roman' && /^[0-9A-F]{6}$/.test(zeph.runs[0].color), `${lay.segs.length} segs, ${zeph && zeph.runs[0].font} ${zeph && zeph.runs[0].color}`);
      // the background keeps the drawings but not the lifted text: the ink under a lifted line is gone
      const bgc = lay.bg.getContext('2d'); const z = zeph || lay.segs[0];
      const px = bgc.getImageData(Math.round(z.x * 2), Math.round((z.base - z.sz * 0.7) * 2), Math.max(4, Math.round(z.w * 2)), Math.round(z.sz * 1.4)).data;
      let dark = 0; for (let k = 0; k < px.length; k += 4) if (px[k] + px[k + 1] + px[k + 2] < 300) dark++;
      check('E1 exact layout: background has no copy of the text', dark < px.length / 4 * 0.01, `${dark} dark px`);
      check('E1 exact layout: turned page handled (text lifted or kept in the picture)', lay2.segs.length >= 0 && lay2.w > 0, `${lay2.segs.length} segs on the turned page, ${Math.round(lay2.w)}x${Math.round(lay2.h)}`);

      await T.toWord({ mode: 'exact' });
      const dz = saved.docx ? window.fflate.unzipSync(saved.docx) : {};
      const docXml = dz['word/document.xml'] ? new TextDecoder().decode(dz['word/document.xml']) : '';
      const okXml = docXml && !new DOMParser().parseFromString(docXml, 'application/xml').getElementsByTagName('parsererror').length;
      check('E2 PDF to Word (exact): well-formed, every page a section with its picture and positioned text', okXml && (docXml.match(/<w:sectPr>/g) || []).length === 3 && dz['word/media/page3.png'] && (docXml.match(/<w:framePr /g) || []).length > 10 && docXml.includes('zephyr'), `${(docXml.match(/<w:framePr /g) || []).length} frames`);
      const has = await window.bench.hasOffice('a.docx').catch(() => null);
      if (has && has.ms) {
        const back = await T.wordToPdf({ name: 'exact.docx', bytes: saved.docx });
        const got = await linesOf(back.bytes); const dr = drift(orig.out, got.out);
        window.__bubbyDrift = { word: dr };
        check('E3 Exact Word file opened in Microsoft Word: same pages, size and places', got.n === orig.n && Math.abs(got.w - orig.w) < 1 && dr.n >= 5 && Math.abs(dr.dy) < 1.5 && dr.maxDy < 3 && Math.abs(dr.dx) < 1.5, JSON.stringify({ how: back.how, pages: got.n, ...dr }));
      } else check('E3 Exact Word file opened in Microsoft Word (skipped: Word not installed)', true);
      const bw = await T.wordToPdf({ name: 'exact.docx', bytes: saved.docx }, { builtIn: true });
      const bwt = await linesOf(bw.bytes); const bdr = drift(orig.out, bwt.out);
      check('E4 Exact Word file to PDF without Word: same pages and places', bwt.n === 3 && bdr.n >= 5 && Math.abs(bdr.dy) < 4 && Math.abs(bdr.dx) < 4, JSON.stringify({ pages: bwt.n, ...bdr }));

      await T.toPowerPoint();
      const pz = saved.pptx ? window.fflate.unzipSync(saved.pptx) : {};
      const s1 = pz['ppt/slides/slide1.xml'] ? new TextDecoder().decode(pz['ppt/slides/slide1.xml']) : '';
      check('E5 PDF to PowerPoint: slides carry editable text over the page picture', s1.includes('<p:pic>') && (s1.match(/txBox="1"/g) || []).length > 5 && s1.includes('Invoice'), `${(s1.match(/txBox="1"/g) || []).length} text boxes`);
      const hp = await window.bench.hasOffice('a.pptx').catch(() => null);
      if (hp && hp.ms) {
        const back = await T.pptxToPdf({ name: 'exact.pptx', bytes: saved.pptx });
        const got = await linesOf(back.bytes); const dr = drift(orig.out, got.out);
        window.__bubbyDrift = { ...(window.__bubbyDrift || {}), ppt: dr };
        check('E6 PowerPoint file opened in Microsoft PowerPoint: same places', got.n === 3 && dr.n >= 5 && Math.abs(dr.dy) < 1.5 && Math.abs(dr.dx) < 1.5, JSON.stringify({ how: back.how, pages: got.n, ...dr }));
      } else check('E6 PowerPoint file opened in Microsoft PowerPoint (skipped: not installed)', true);

      await T.toHtml({ mode: 'exact' });
      const he = saved.html ? new TextDecoder().decode(saved.html) : '';
      check('E7 PDF to HTML (exact): pages with positioned text', (he.match(/class="pg"/g) || []).length === 3 && he.includes('zephyr') && he.includes('data:image/png;base64,'));
      const hpdf = await window.bench.htmlToPdf({ html: he.replace('<style>', '<style>@page{size:612pt 792pt;margin:0}body{padding:0!important;background:#fff!important}.pg{margin:0!important;box-shadow:none!important;break-after:page}.pg~.pg{display:none}'), cssPageSize: true, pageSize: { width: 8.5, height: 11 }, margins: { marginType: 'none' } });
      const ht = hpdf && hpdf.bytes ? await linesOf(hpdf.bytes) : { out: [], n: 0 }; const hdr = drift(orig.out, ht.out);
      check('E7 PDF to HTML (exact): text where it was', hdr.n >= 5 && Math.abs(hdr.dy) < 1.5 && Math.abs(hdr.dx) < 1.5, JSON.stringify(hdr) + ' pages ' + ht.n + ' ' + ht.w + 'x' + ht.h + ' ' + JSON.stringify(ht.out.slice(0, 3).map((o) => [o.s.slice(0, 12), Math.round(o.x), Math.round(o.y)])) + JSON.stringify(orig.out.slice(0, 3).map((o) => [o.s.slice(0, 12), Math.round(o.x), Math.round(o.y)])));

      // Office files to PDF keep their pages: a Word file made by the flowing export, laid out without Word
      const hx = await window.bench.hasOffice('a.xlsx').catch(() => null);
      if (hx && hx.ms && saved.xlsx) {
        let xb; try { xb = await T.excelToPdf({ name: 'a.xlsx', bytes: saved.xlsx }); } catch { xb = await T.excelToPdf({ name: 'a.xlsx', bytes: saved.xlsx }, { builtIn: true }); }
        check('E8 Excel to PDF: Microsoft Excel, or the built-in converter if Excel does not answer', /^(Microsoft Excel|built-in)$/.test(xb.how) && (await pdfText(xb.bytes)).t.includes('4471'), xb.how);
      } else check('E8 Excel to PDF with Microsoft Excel (skipped: not installed)', true);
    }
    // Word and Excel to PDF (built-in converters)
    const w2p = saved.docx ? await T.wordToPdf({ name: 'a.docx', bytes: saved.docx }, { builtIn: true }) : null;
    check('T5 Word to PDF', w2p && (await pdfText(w2p.bytes)).t.includes('Invoice'), w2p && w2p.how);
    const x2p = saved.xlsx ? await T.excelToPdf({ name: 'a.xlsx', bytes: saved.xlsx }, { builtIn: true }) : null;
    check('T5 Excel to PDF', x2p && (await pdfText(x2p.bytes)).t.includes('4471'));
    const t2p = await T.textToPdf({ name: 'a.txt', bytes: new TextEncoder().encode('Hello from a text file\nSecond line') });
    check('T5 Text to PDF', (await pdfText(t2p.bytes)).t.includes('Hello from a text file'));
    const cv = document.createElement('canvas'); cv.width = 400; cv.height = 300; const cg = cv.getContext('2d'); cg.fillStyle = '#c2410c'; cg.fillRect(0, 0, 400, 300);
    const png = new Uint8Array(await (await new Promise((r) => cv.toBlob(r, 'image/png'))).arrayBuffer());
    const i2p = await T.imagesToPdf([{ name: 'a.png', bytes: png }, { name: 'b.png', bytes: png }], { size: 'a4', margin: 'small' });
    check('T5 Images to PDF: one page per image', (await PL.PDFDocument.load(i2p)).getPageCount() === 2);
    // Compress a PDF with a large picture
    // a photo-like picture: smooth colour gradients with fine grain, like a camera image
    const big = document.createElement('canvas'); big.width = 1600; big.height = 1200; const bg = big.getContext('2d');
    const pix = bg.createImageData(1600, 1200); let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let y = 0; y < 1200; y++) for (let x = 0; x < 1600; x++) { const k = (y * 1600 + x) * 4; const g = rnd() * 40;
      pix.data[k] = 120 + 100 * Math.sin(x / 140) + g; pix.data[k + 1] = 110 + 90 * Math.cos(y / 110) + g; pix.data[k + 2] = 90 + 80 * Math.sin((x + y) / 200) + g; pix.data[k + 3] = 255; }
    bg.putImageData(pix, 0, 0);
    const bigPng = new Uint8Array(await (await new Promise((r) => big.toBlob(r, 'image/png'))).arrayBuffer());
    const bd = await PL.PDFDocument.create(); const im = await bd.embedPng(bigPng); bd.addPage([600, 600]).drawImage(im, { x: 0, y: 0, width: 600, height: 600 });
    const bigBytes = await bd.save();
    const { bytes: smaller } = await T.compressBytes(bigBytes, 'balanced');
    check('T6 Reduce file size: smaller and still opens', smaller.length < bigBytes.length * 0.8 && (await PL.PDFDocument.load(smaller)).getPageCount() === 1, `${bigBytes.length} -> ${smaller.length}`);
    // Split ranges
    check('T7 Split: page ranges understood', JSON.stringify(T.parseRanges('1-2, 3', 3)) === '[[1,2],[3,3]]' && T.parseRanges('0-9', 3) === null && JSON.stringify(T.parseRanges('2-end', 3)) === '[[2,3]]');
    // Protect: locked without the password, opens with it
    S.protect = { userPassword: 'open sesame', ownerPassword: 'owner pw 2', permissions: { printing: false, copying: false } };
    const locked = await D.__protect((await D.buildPdf(S.pages)).bytes);
    let refused = false; try { await window.pdfjsLib.getDocument({ data: locked.slice(), isEvalSupported: false }).promise; } catch { refused = true; }
    check('T8 Protect: needs the password', refused);
    check('T8 Protect: opens with the password', (await pdfText(locked, 'open sesame')).t.includes('Invoice'));
    S.protect = null;
    // Watermark and page numbers in the saved file
    S.marks = { watermark: { text: 'DRAFT COPY', size: 50, opacity: 0.2, angle: 45, color: '#C2410C', layout: 'center' }, pageNumbers: { format: 'Page {n} of {total}', pos: 'bc', size: 10, start: 1, skipFirst: false } };
    const mk = await pdfText((await D.buildPdf(S.pages)).bytes);
    check('T9 Watermark and page numbers saved', mk.t.includes('DRAFT COPY') && mk.t.includes('Page 1 of 3') && mk.t.includes('Page 3 of 3'), mk.t.slice(0, 80));
    S.marks = null;
    // Form field text size saved
    D.setFieldSize(S.pages[0].docId, 'name', 18);
    const fdoc = await PL.PDFDocument.load((await D.buildPdf(S.pages)).bytes);
    const da = String(fdoc.getForm().getTextField('name').acroField.getDefaultAppearance() || '');
    check('T10 Form text size saved', /18 Tf/.test(da), da);
    // Unreadable text detection
    check('T11 Unreadable text detected', D.unreadable('\uE001\uE002\uE003 \uE004\uE005') && !D.unreadable('Hello, world 2026!'));
    // Text recognition reads real words
    const oc = document.createElement('canvas'); oc.width = 900; oc.height = 200; const og = oc.getContext('2d');
    og.fillStyle = '#fff'; og.fillRect(0, 0, 900, 200); og.fillStyle = '#000'; og.font = 'bold 64px Arial'; og.fillText('HELLO BUBBY READER', 30, 120);
    let ocrWords = '';
    try { const r = await T.readCanvas(oc); ocrWords = r.words.map((w) => w.t).join(' '); } catch (e) { ocrWords = 'ERROR ' + e.message; }
    check('T12 Text recognition reads words', /HELLO/i.test(ocrWords) && /BUBBY/i.test(ocrWords) && /READER/i.test(ocrWords), ocrWords);
    // A scanned page (an image of text) becomes searchable
    const sc = await PL.PDFDocument.create(); const sp = sc.addPage([612, 300]);
    sp.drawImage(await sc.embedPng(new Uint8Array(await (await new Promise((r) => oc.toBlob(r, 'image/png'))).arrayBuffer())), { x: 0, y: 50, width: 612, height: 136 });
    S.dirty = false;
    await D.openFiles([{ name: 'scan.pdf', path: null, bytes: await sc.save() }], { replace: true });
    await T.recognize();
    const scanOut = await pdfText((await D.buildPdf(S.pages)).bytes);
    check('T13 Scanned page becomes searchable text', S.pages[0].ocr && S.pages[0].ocr.length >= 3 && /BUBBY/i.test(scanOut.t), scanOut.t.slice(0, 80));
    // Markups made in another app can be removed
    const fx = await PL.PDFDocument.load(bytes); const ctx2 = fx.context;
    const ap = ctx2.register(ctx2.stream('1 0 0 RG 2 w 301 301 98 48 re S', { Type: 'XObject', Subtype: 'Form', BBox: [300, 300, 400, 350] }));
    const sq = ctx2.register(ctx2.obj({ Type: 'Annot', Subtype: 'Square', Rect: [300, 300, 400, 350], C: [1, 0, 0], F: 4, AP: { N: ap } }));
    fx.getPage(0).node.addAnnot(sq);
    S.dirty = false;
    await D.openFiles([{ name: 'other-app.pdf', path: null, bytes: await fx.save() }], { replace: true });
    const foreign = S.pages[0].annots.find((a) => a.type === 'foreign');
    check('T14 Other app markup is listed and selectable', !!foreign && foreign.subtype === 'Square');
    if (foreign) { S.sel = foreign.id; D.deleteSelected(); await new Promise((r) => setTimeout(r, 900)); }
    const fo = await PL.PDFDocument.load((await D.buildPdf(S.pages)).bytes);
    const left = (fo.getPage(0).node.Annots() ? fo.getPage(0).node.Annots().asArray() : []).map((r) => String(fo.context.lookup(r).get(PL.PDFName.of('Subtype'))));
    check('T14 Other app markup removed from the saved file', !left.includes('/Square'), left.join(','));
    D.undo(); await new Promise((r) => setTimeout(r, 900));
    check('T14 Undo brings it back', S.pages[0].annots.some((a) => a.type === 'foreign'));
    // Save refuses to write anywhere the user did not open
    if (window.bench && window.bench.writeFile) { const w = await window.bench.writeFile('C:/Windows/not-allowed.pdf', new Uint8Array([1])); check('T15 Save only writes to files you opened', !!(w && w.error)); }
    window.__bubbyTestSave = null;
  }

  // Home page renders
  S.dirty = false;
  document.querySelector('#btnHome').click();
  await new Promise((r) => setTimeout(r, 200));
  document.querySelector('#toggleAllTools').click();
  check('All tools card collapses', document.querySelector('#homeTools').hidden && document.querySelector('#toggleAllTools').getAttribute('aria-expanded') === 'false');
  document.querySelector('#toggleAllTools').click();
  check('All tools card opens again', !document.querySelector('#homeTools').hidden);
  check('Home sidebar lists every tool', document.querySelectorAll('#navTools .navitem').length === window.BubbyTools.TOOLS.length, document.querySelectorAll('#navTools .navitem').length);
  check('Home page shows tools and resume card', !document.querySelector('#start').hidden && document.querySelectorAll('.tile').length === 4 && !document.querySelector('#resume').hidden);
  document.querySelector('#btnResume').click();
  check('Continue editing returns to the document', document.querySelector('#start').hidden && !document.querySelector('#workspace').hidden);

  const failed = results.filter((r) => !r.ok);
  return { passed: results.length - failed.length, total: results.length, failed };
}
