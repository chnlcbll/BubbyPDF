'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bench', {
  web: false,
  openPdf: () => ipcRenderer.invoke('dialog:open-pdf'),
  openImage: () => ipcRenderer.invoke('dialog:open-image'),
  readFile: (p) => ipcRenderer.invoke('file:read', p),
  savePdf: (args) => ipcRenderer.invoke('dialog:save-pdf', args),
  writeFile: (p, bytes) => ipcRenderer.invoke('file:write', { path: p, bytes }),
  recent: () => ipcRenderer.invoke('recent:get'),
  clearRecent: () => ipcRenderer.invoke('recent:clear'),
  starRecent: (p, on) => ipcRenderer.invoke('recent:star', p, on),
  removeRecent: (p) => ipcRenderer.invoke('recent:remove', p),
  saveThumb: (p, dataUrl) => ipcRenderer.invoke('recent:thumb', p, dataUrl),
  initialFile: () => ipcRenderer.invoke('app:initial-file'),
  setDirty: (v) => ipcRenderer.send('app:dirty', !!v),
  closeNow: () => ipcRenderer.send('app:close-now'),
  onCloseRequest: (fn) => ipcRenderer.on('app:close-request', () => fn()),
  onOpenFile: (fn) => ipcRenderer.on('app:open-file', (_e, entry) => fn(entry)),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  showInFolder: (p) => ipcRenderer.invoke('shell:show-in-folder', p),
  printPages: (pages) => ipcRenderer.invoke('print:pages', pages),
  openImages: () => ipcRenderer.invoke('dialog:open-images'),
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  writeInFolder: (args) => ipcRenderer.invoke('fs:write-in-folder', args),
  saveFile: (args) => ipcRenderer.invoke('dialog:save-file', args),
  htmlToPdf: (args) => ipcRenderer.invoke('convert:html-to-pdf', args),
  fileToPdf: (p) => ipcRenderer.invoke('convert:file-to-pdf', { path: p }),
  hasOffice: (name) => ipcRenderer.invoke('convert:has-office', name),
  officeToPdf: (args) => ipcRenderer.invoke('convert:office', args),
  openKind: (kind, multiple) => ipcRenderer.invoke('dialog:open-kind', { kind, multiple }),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || null; } catch { return null; }
  },
});
