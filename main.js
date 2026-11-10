'use strict';
// BubbyPDF main process: one window, a custom app:// scheme for local files,
// and a handful of IPC calls for native open/save dialogs. No network.
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let win = null;
let dirty = false;
let pendingFile = null;
let lastDir = null;
// Files the user opened or saved in this session: the only paths Save may write back to.
const writable = new Set();

const recentFile = () => path.join(app.getPath('userData'), 'recent.json');

const thumbDir = () => path.join(app.getPath('userData'), 'thumbs');
const thumbPath = (p) => path.join(thumbDir(), require('crypto').createHash('sha1').update(p.toLowerCase()).digest('hex') + '.jpg');

// The recent list keeps up to 40 files; starred files are never pushed out.
function loadRecent() {
  try {
    const list = JSON.parse(fs.readFileSync(recentFile(), 'utf8'));
    return list.filter((r) => r && typeof r.path === 'string' && fs.existsSync(r.path));
  } catch {
    return [];
  }
}
function writeRecent(list) {
  const starred = list.filter((r) => r.starred);
  const rest = list.filter((r) => !r.starred).slice(0, Math.max(0, 40 - starred.length));
  const keep = list.filter((r) => starred.includes(r) || rest.includes(r));
  fs.mkdirSync(path.dirname(recentFile()), { recursive: true });
  fs.writeFileSync(recentFile(), JSON.stringify(keep));
}
function readRecent() {
  return loadRecent().map((r) => {
    let size = 0; let thumb = null;
    try { size = fs.statSync(r.path).size; } catch { /* gone */ }
    try { thumb = 'data:image/jpeg;base64,' + fs.readFileSync(thumbPath(r.path)).toString('base64'); } catch { /* no thumbnail yet */ }
    return { ...r, size, thumb };
  });
}

function addRecent(p) {
  try {
    const list = loadRecent();
    const old = list.find((r) => r.path === p);
    const rest = list.filter((r) => r.path !== p);
    rest.unshift({ path: p, name: path.basename(p), openedAt: Date.now(), starred: !!(old && old.starred) });
    writeRecent(rest);
  } catch {
    /* recent list is a convenience; never block opening a file */
  }
}

function pdfArg(argv) {
  return argv.slice(1).find((a) => /\.pdf$/i.test(a) && fs.existsSync(a)) || null;
}

function readEntry(p) {
  const bytes = fs.readFileSync(p);
  lastDir = path.dirname(p);
  addRecent(p);
  writable.add(path.resolve(p));
  let mtime = null; try { mtime = fs.statSync(p).mtimeMs; } catch { /* unknown */ }
  return { name: path.basename(p), path: p, size: bytes.byteLength, mtime, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    title: 'BubbyPDF',
    backgroundColor: '#FBF6F1',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, 'src', 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (dirty) {
      e.preventDefault();
      win.webContents.send('app:close-request');
    }
  });
  win.on('closed', () => { win = null; });
  win.loadURL('app://bench/src/index.html');

  // Packaged-build smoke check: BUBBY_SMOKE=<png path> BubbyPDF.exe some.pdf
  // Opens the file, waits for rendering, prints what rendered, saves a screenshot, exits.
  if (process.env.BUBBY_SMOKE) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 6000));
      // Everything a friend's PC needs must load from inside the app: libraries, text recognition, converters.
      const r = await win.webContents.executeJavaScript(`(async () => {
        const out = { pages: window.__bubbypdf.S.pages.length, rendered: [...document.querySelectorAll('canvas.base')].filter((c) => c.width > 0).length,
          fields: document.querySelectorAll('.field').length, thumbs: document.querySelectorAll('.thumb').length };
        out.missing = ['pdfjsLib', 'PDFLib', 'fflate', 'mammoth', 'XLSX', 'Tesseract', 'BubbyTools', 'BubbyCombine', 'BubbyTextEdit', 'JSZip', 'docx', 'ExcelJS'].filter((k) => !window[k]);
        try {
          const c = document.createElement('canvas'); c.width = 760; c.height = 160; const g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, 760, 160); g.fillStyle = '#000'; g.font = 'bold 56px Arial'; g.fillText('PACKAGED READER', 20, 100);
          out.ocr = (await window.BubbyTools.readCanvas(c)).words.map((w) => w.t).join(' ');
        } catch (e) { out.ocr = 'ERROR ' + e.message; }
        try { const t = await window.BubbyTools.textToPdf({ name: 'a.txt', bytes: new TextEncoder().encode('hello from the packaged app') }); out.convert = t.bytes.length > 500; } catch (e) { out.convert = 'ERROR ' + e.message; }
        try { const T = window.BubbyTools; const pg = await T.exactPages(); const w = await T.wordToPdf({ name: 'a.docx', bytes: T.docxExact(pg) }, { builtIn: true }); out.exact = pg.length > 0 && pg[0].segs.length > 0 && w.bytes.length > 1000; } catch (e) { out.exact = 'ERROR ' + e.message; }
        try { const x = window.BubbyTools.xlsxFile([{ name: 'S', rows: [['a', '1']] }]); out.xlsx = window.XLSX.read(x, { type: 'array' }).SheetNames[0] === 'S'; } catch (e) { out.xlsx = 'ERROR ' + e.message; }
        return out;
      })()`);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.BUBBY_SMOKE, img.toPNG());
      process.stdout.write('SMOKE ' + JSON.stringify(r) + '\n');
      const ok = r.pages > 0 && r.rendered > 0 && !r.missing.length && /PACKAGED/i.test(r.ocr) && r.convert === true && r.xlsx === true && r.exact === true;
      app.exit(ok ? 0 : 1);
    });
  }

  // Developer self-test: BUBBY_SELFTEST=1 electron .  (runs test/ui-test.mjs in the real window)
  if (process.env.BUBBY_SELFTEST && !app.isPackaged) {
    win.webContents.once('did-finish-load', async () => {
      let code = 1;
      const shot = async (name) => {
        if (!process.env.BUBBY_SHOTS) return;
        await new Promise((r) => setTimeout(r, 1200));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(process.env.BUBBY_SHOTS, name), img.toPNG());
      };
      try {
        await shot('01-start.png');
        const r = await win.webContents.executeJavaScript(`import(${JSON.stringify('../test/' + path.basename(process.env.BUBBY_SELFTEST_FILE || 'ui-test.mjs'))}).then((t) => t.run())`);
        await win.webContents.executeJavaScript("(() => { const D = window.__bubbypdf; D.setTool('select'); const p = D.S.pages[0]; D.S.sel = p.annots[0] && p.annots[0].id; D.layoutPages(false); document.querySelector('#viewer').scrollTop = 0; })()");
        await shot('02-editor.png');
        await win.webContents.executeJavaScript("document.documentElement.setAttribute('data-theme','dark'); window.__bubbypdf.setTool('check');");
        await shot('03-dark.png');
        process.stdout.write('SELFTEST ' + JSON.stringify(r) + '\n');
        code = r.failed.length ? 1 : 0;
      } catch (e) {
        process.stdout.write('SELFTEST ERROR ' + (e && e.stack || e) + '\n');
      }
      dirty = false;
      app.exit(code);
    });
  }
}

// Test runs get their own settings folder and may run beside an open BubbyPDF window.
const testRun = !!(process.env.BUBBY_SELFTEST || process.env.BUBBY_SMOKE || process.env.BUBBY_DEV);
if (testRun) app.setPath('userData', path.join(os.tmpdir(), process.env.BUBBY_DEV ? 'bubbypdf-dev-profile' : 'bubbypdf-test-profile'));
const gotLock = testRun ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  pendingFile = pdfArg(process.argv);

  app.on('second-instance', (_e, argv) => {
    const p = pdfArg(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (p) win.webContents.send('app:open-file', readEntry(p));
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    const root = path.normalize(__dirname);
    protocol.handle('app', (req) => {
      const { pathname } = new URL(req.url);
      const file = path.normalize(path.join(root, decodeURIComponent(pathname)));
      if (!file.startsWith(root)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}

ipcMain.handle('dialog:open-pdf', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open PDF',
    defaultPath: lastDir || app.getPath('documents'),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (r.canceled) return [];
  return r.filePaths.map(readEntry);
});

ipcMain.handle('dialog:open-image', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Insert image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  const b = fs.readFileSync(p);
  return { name: path.basename(p), bytes: new Uint8Array(b.buffer, b.byteOffset, b.byteLength) };
});

ipcMain.handle('dialog:open-images', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose images', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
  });
  if (r.canceled) return [];
  return r.filePaths.map((p) => { const b = fs.readFileSync(p); return { name: path.basename(p), bytes: new Uint8Array(b.buffer, b.byteOffset, b.byteLength) }; });
});

// Export: the user picks a folder; the renderer can then write plain file names into that folder only.
const folders = new Map();
ipcMain.handle('dialog:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const token = require('crypto').randomBytes(12).toString('hex');
  folders.set(token, r.filePaths[0]);
  return { token, path: r.filePaths[0] };
});
ipcMain.handle('fs:write-in-folder', async (_e, { token, name, bytes }) => {
  const dir = folders.get(token);
  const safe = path.basename(String(name || '')).replace(/[^\w\-(). ]+/g, '_');
  if (!dir || !safe || !/\.(png|jpe?g|txt|pdf|md|html)$/i.test(safe)) return false;
  fs.writeFileSync(path.join(dir, safe), Buffer.from(bytes));
  return true;
});
ipcMain.handle('dialog:save-file', async (_e, { suggestedName, bytes, kind }) => {
  const KIND = { txt: ['Text', 'txt'], md: ['Markdown', 'md'], html: ['Web page', 'html'], docx: ['Word document', 'docx'],
    xlsx: ['Excel workbook', 'xlsx'], pptx: ['PowerPoint presentation', 'pptx'], png: ['PNG image', 'png'], jpg: ['JPEG image', 'jpg'], pdf: ['PDF', 'pdf'] };
  const k = KIND[kind] || KIND.pdf; const filters = [{ name: k[0], extensions: [k[1]] }];
  const r = await dialog.showSaveDialog(win, { title: 'Save', defaultPath: path.join(lastDir || app.getPath('documents'), suggestedName || 'file'), filters });
  if (r.canceled || !r.filePath) return null;
  const tmp = r.filePath + '.bubbypdf-tmp';
  fs.writeFileSync(tmp, Buffer.from(bytes)); fs.renameSync(tmp, r.filePath);
  return { name: path.basename(r.filePath), path: r.filePath };
});

ipcMain.handle('file:read', async (_e, p) => {
  if (typeof p !== 'string' || !/\.pdf$/i.test(p) || !fs.existsSync(p)) return null;
  return readEntry(p);
});

ipcMain.handle('dialog:save-pdf', async (_e, { suggestedName, bytes }) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Save a copy',
    defaultPath: path.join(lastDir || app.getPath('documents'), suggestedName || 'document.pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (r.canceled || !r.filePath) return null;
  let out = r.filePath;
  if (!/\.pdf$/i.test(out)) out += '.pdf';
  // Write to a temp file first, then swap it in, so a failed write never leaves a broken PDF.
  const tmp = out + '.bubbypdf-tmp';
  fs.writeFileSync(tmp, Buffer.from(bytes));
  fs.renameSync(tmp, out);
  lastDir = path.dirname(out);
  addRecent(out);
  writable.add(path.resolve(out));
  return { name: path.basename(out), path: out };
});

// Printing: the renderer sends one image per page (already including annotations and redactions).
// They go into a temporary HTML file in a hidden window, which opens the system print dialog.
ipcMain.handle('print:pages', async (_e, pages) => {
  if (!Array.isArray(pages) || !pages.length) return { ok: false, reason: 'nothing to print' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbypdf-print-'));
  let pw = null;
  try {
    const body = pages.map((p, i) => {
      const m = /^data:image\/(jpeg|png);base64,(.+)$/.exec(String(p.dataUrl || ''));
      if (!m) return '';
      const file = `p${i}.${m[1] === 'png' ? 'png' : 'jpg'}`;
      fs.writeFileSync(path.join(dir, file), Buffer.from(m[2], 'base64'));
      return `<div class="pg ${p.land ? 'land' : 'port'}"><img src="${file}" alt=""></div>`;
    }).join('');
    const html = '<!doctype html><html><head><meta charset="utf-8"><style>' +
      '@page{margin:0}@page port{size:portrait;margin:0}@page land{size:landscape;margin:0}' +
      'html,body{margin:0}.pg{width:100vw;height:100vh;display:flex;align-items:center;justify-content:center;break-after:page;overflow:hidden}' +
      '.pg:last-child{break-after:auto}.port{page:port}.land{page:land}img{max-width:100%;max-height:100%}' +
      '</style></head><body>' + body + '</body></html>';
    const htmlPath = path.join(dir, 'print.html');
    fs.writeFileSync(htmlPath, html);
    pw = new BrowserWindow({ show: false, parent: win || undefined, webPreferences: { sandbox: true, javascript: false } });
    await pw.loadFile(htmlPath);
    return await new Promise((resolve) => {
      pw.webContents.print({ silent: false, printBackground: true, margins: { marginType: 'none' } }, (ok, reason) => resolve({ ok, reason: reason || '' }));
    });
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally {
    if (pw && !pw.isDestroyed()) pw.destroy();
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
});

// Save: write back into a file the user opened. Written to a temp file first, then swapped in.
ipcMain.handle('file:write', async (_e, { path: p, bytes }) => {
  const target = path.resolve(String(p || ''));
  if (!writable.has(target)) return { error: 'BubbyPDF can only save over a file you opened' };
  const tmp = target + '.bubbypdf-tmp';
  try {
    fs.writeFileSync(tmp, Buffer.from(bytes));
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing left behind */ }
    const busy = /EBUSY|EPERM|EACCES/.test(e.code || '');
    return { error: busy ? 'the file is open in another program or is read-only' : e.message };
  }
  addRecent(target);
  return { name: path.basename(target), path: target };
});

ipcMain.handle('recent:get', () => readRecent());
ipcMain.handle('recent:clear', () => {
  // Starred files stay; everything else is cleared.
  try { writeRecent(loadRecent().filter((r) => r.starred)); } catch { /* nothing to clear */ }
  return readRecent();
});
ipcMain.handle('recent:star', (_e, p, on) => {
  const list = loadRecent(); const r = list.find((x) => x.path === p);
  if (r) { r.starred = !!on; writeRecent(list); }
  return readRecent();
});
ipcMain.handle('recent:remove', (_e, p) => {
  writeRecent(loadRecent().filter((x) => x.path !== p));
  return readRecent();
});
ipcMain.handle('recent:thumb', (_e, p, dataUrl) => {
  const m = /^data:image\/jpeg;base64,(.+)$/.exec(String(dataUrl || ''));
  if (typeof p !== 'string' || !m) return false;
  try { fs.mkdirSync(thumbDir(), { recursive: true }); fs.writeFileSync(thumbPath(p), Buffer.from(m[1], 'base64')); return true; } catch { return false; }
});
ipcMain.handle('app:initial-file', () => {
  const p = pendingFile;
  pendingFile = null;
  return p ? readEntry(p) : null;
});
ipcMain.on('app:dirty', (_e, v) => { dirty = !!v; });
ipcMain.on('app:close-now', () => { dirty = false; if (win) win.close(); });
ipcMain.handle('shell:open-external', (_e, url) => {
  if (typeof url === 'string' && /^(https?:|mailto:)/i.test(url)) return shell.openExternal(url);
  return null;
});
ipcMain.handle('shell:show-in-folder', (_e, p) => {
  if (typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(p);
});

// ---------- conversions ----------
// HTML to PDF in a hidden window: no scripts, no network. Used for Word, Excel, PowerPoint,
// text and web-page conversions done inside BubbyPDF.
const { session } = require('electron');
let convertSession = null;
function offlineSession() {
  if (convertSession) return convertSession;
  convertSession = session.fromPartition('bubbypdf-convert');
  convertSession.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !/^(file|data|blob):/i.test(details.url) }));
  return convertSession;
}
async function printHtmlFile(file, opts = {}) {
  const w = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, session: offlineSession() } });
  try {
    await w.loadFile(file);
    const data = await w.webContents.printToPDF({
      printBackground: true,
      landscape: !!opts.landscape,
      pageSize: opts.pageSize || 'A4',
      margins: opts.margins || { marginType: 'default' },
      preferCSSPageSize: !!opts.cssPageSize,
    });
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } finally { if (!w.isDestroyed()) w.destroy(); }
}
ipcMain.handle('convert:html-to-pdf', async (_e, { html, pageSize, landscape, margins, cssPageSize }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbypdf-conv-'));
  try {
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, String(html || ''));
    return { bytes: await printHtmlFile(file, { pageSize, landscape, margins, cssPageSize }) };
  } catch (e) { return { error: e.message }; } finally { fs.rm(dir, { recursive: true, force: true }, () => {}); }
});
// A local web page (and the images next to it) to PDF.
ipcMain.handle('convert:file-to-pdf', async (_e, { path: p }) => {
  const target = path.resolve(String(p || ''));
  if (!pickedFiles.has(target) || !/\.html?$/i.test(target)) return { error: 'Choose the web page with Open first' };
  try { return { bytes: await printHtmlFile(target, { cssPageSize: true }) }; } catch (e) { return { error: e.message }; }
});

// Optional: LibreOffice gives the best Office-to-PDF results when it is installed.
function findSoffice() {
  const cands = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LibreOffice', 'program', 'soffice.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'LibreOffice', 'program', 'soffice.exe'),
  ];
  return cands.find((c) => { try { return fs.existsSync(c); } catch { return false; } }) || null;
}
ipcMain.handle('convert:has-office', (_e, name) => { const a = msAppFor(String(name || '')); return { ms: !!(a && hasMsOffice(a)), libre: !!findSoffice() }; });
ipcMain.handle('convert:office', async (_e, { name, bytes }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubbypdf-office-'));
  const safe = path.basename(String(name || 'document')).replace(/[^\w\-(). ]+/g, '_');
  const input = path.join(dir, safe);
  try { fs.writeFileSync(input, Buffer.from(bytes)); } catch (e) { return { error: e.message }; }
  // 1. Microsoft Office, if this PC has it.
  const msApp = msAppFor(safe);
  if (msApp && hasMsOffice(msApp)) {
    try { const out = await convertWithMsOffice(msApp, input, path.join(dir, 'out.pdf')); fs.rm(dir, { recursive: true, force: true }, () => {}); return { bytes: out, how: 'Microsoft ' + msApp }; }
    catch (e) { console.warn('Office conversion failed', e.message); /* fall through to LibreOffice / built-in */ }
  }
  // 2. LibreOffice, if installed.
  const soffice = findSoffice();
  if (!soffice) { fs.rm(dir, { recursive: true, force: true }, () => {}); return { missing: true }; }
  try {
    await new Promise((resolve, reject) => {
      require('child_process').execFile(soffice, ['--headless', '--norestore', '--nolockcheck', '--convert-to', 'pdf', '--outdir', dir, input],
        { timeout: 180000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
    });
    const out = path.join(dir, safe.replace(/\.[^.]+$/, '') + '.pdf');
    const b = fs.readFileSync(out);
    return { bytes: new Uint8Array(b.buffer, b.byteOffset, b.byteLength), how: 'LibreOffice' };
  } catch (e) { return { error: e.message }; } finally { fs.rm(dir, { recursive: true, force: true }, () => {}); }
});

// Pick files of a given kind for conversion.
const pickedFiles = new Set();
const KINDS = {
  word: [{ name: 'Word documents', extensions: ['docx', 'doc', 'odt', 'rtf'] }],
  excel: [{ name: 'Spreadsheets', extensions: ['xlsx', 'xls', 'ods', 'csv'] }],
  powerpoint: [{ name: 'Presentations', extensions: ['pptx', 'ppt', 'odp'] }],
  text: [{ name: 'Text files', extensions: ['txt', 'md', 'log'] }],
  html: [{ name: 'Web pages', extensions: ['html', 'htm'] }],
  any: [{ name: 'Documents', extensions: ['docx', 'doc', 'odt', 'rtf', 'xlsx', 'xls', 'ods', 'csv', 'pptx', 'ppt', 'odp', 'txt', 'md', 'html', 'htm', 'png', 'jpg', 'jpeg'] }],
  pdf: [{ name: 'PDF', extensions: ['pdf'] }],
};
ipcMain.handle('dialog:open-kind', async (_e, { kind, multiple }) => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose files', defaultPath: lastDir || app.getPath('documents'),
    properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'], filters: KINDS[kind] || KINDS.any });
  if (r.canceled) return [];
  return r.filePaths.map((p) => {
    const b = fs.readFileSync(p); pickedFiles.add(path.resolve(p)); lastDir = path.dirname(p);
    let mtime = null; try { mtime = fs.statSync(p).mtimeMs; } catch { /* unknown */ }
    return { name: path.basename(p), path: p, size: b.byteLength, mtime, bytes: new Uint8Array(b.buffer, b.byteOffset, b.byteLength) };
  });
});

// Microsoft Office, when installed, converts its own files to PDF exactly. Driven invisibly and read-only.
// File paths reach PowerShell only through environment variables, never inside the script text.
const officeApps = {};
function hasMsOffice(app) {
  if (app in officeApps) return officeApps[app];
  let ok = false;
  try { require('child_process').execFileSync('reg', ['query', `HKCR\\${app}.Application\\CLSID`], { stdio: 'ignore', windowsHide: true }); ok = true; } catch { ok = false; }
  officeApps[app] = ok; return ok;
}
const MS_SCRIPTS = {
  Word: "$ErrorActionPreference='Stop'; $w=New-Object -ComObject Word.Application; $w.Visible=$false; $w.DisplayAlerts=0; " +
    "try { $d=$w.Documents.Open($env:BB_IN, $false, $true, $false, 'bubbypdf-no-password'); $d.ExportAsFixedFormat($env:BB_OUT, 17); $d.Close(0) } finally { $w.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($w) }",
  Excel: "$ErrorActionPreference='Stop'; $x=New-Object -ComObject Excel.Application; $x.Visible=$false; $x.DisplayAlerts=$false; " +
    "try { $b=$x.Workbooks.Open($env:BB_IN, 0, $true, [Type]::Missing, 'bubbypdf-no-password'); $b.ExportAsFixedFormat(0, $env:BB_OUT); $b.Close($false) } finally { $x.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($x) }",
  PowerPoint: "$ErrorActionPreference='Stop'; $p=New-Object -ComObject PowerPoint.Application; " +
    "try { $pr=$p.Presentations.Open($env:BB_IN, -1, 0, 0); $pr.SaveAs($env:BB_OUT, 32); $pr.Close() } finally { $p.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($p) }",
};
function msAppFor(name) {
  if (/\.(docx?|rtf|odt)$/i.test(name)) return 'Word';
  if (/\.(xlsx?|ods|csv)$/i.test(name)) return 'Excel';
  if (/\.(pptx?|odp)$/i.test(name)) return 'PowerPoint';
  return null;
}
const MS_EXE = { Word: 'WINWORD.EXE', Excel: 'EXCEL.EXE', PowerPoint: 'POWERPNT.EXE' };
function officePids(app) {
  try {
    const out = require('child_process').execFileSync('tasklist', ['/FI', `IMAGENAME eq ${MS_EXE[app]}`, '/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8' });
    return new Set(out.split(/\r?\n/).map((l) => (/^"[^"]+","(\d+)"/.exec(l) || [])[1]).filter(Boolean));
  } catch { return new Set(); }
}
async function convertWithMsOffice(app, input, output) {
  const before = officePids(app);
  try {
    await new Promise((resolve, reject) => {
      require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', MS_SCRIPTS[app]],
        { env: { ...process.env, BB_IN: input, BB_OUT: output }, timeout: 90000, windowsHide: true },
        (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).split('\n')[0].slice(0, 200))) : resolve()));
    });
  } catch (e) {
    // Office did not answer (a hidden prompt, for example): close only the copy started for this, and stop using it this session
    for (const pid of officePids(app)) if (!before.has(pid)) { try { process.kill(+pid); } catch { /* gone */ } }
    officeApps[app] = false;
    throw e;
  }
  const b = fs.readFileSync(output);
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}
