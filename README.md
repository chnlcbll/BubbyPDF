# BubbyPDF

A free, offline PDF editor for Windows. Fill forms, sign, add and edit text, highlight, draw, add check marks,
cover content with white, insert images, merge PDFs, reorder, rotate, delete and extract pages, and search.
No account, no network access, no ads. Save always writes a new copy.

## Run it
- Installer: `dist/BubbyPDF-Setup-1.2.0.exe`
- No install: `dist/BubbyPDF-Portable-1.2.0.exe`

The .exe files are not code-signed, so Windows may show "Windows protected your PC". Click **More info**, then **Run anyway**.

## Develop
```
npm install
npm start                                   # run from source
BUBBY_SELFTEST=1 npx electron .          # 60 end-to-end checks (bash syntax)
npm run dist                                # build both .exe files
```
If `npm start` says Electron failed to install, see `replica/deploy.md` (two one-time fixes on this PC).

## Shortcuts
V select and fill · T text · E edit existing text · K check mark · S signature · H highlight · U underline · X strikethrough · N sticky note · D draw · R rectangle · W whiteout · B redact · I image
Ctrl+O open · Ctrl+S save a copy · Ctrl+P print · Ctrl+Z / Ctrl+Y undo / redo · Ctrl+F search · Ctrl+= / Ctrl+- / Ctrl+0 zoom · Alt+Left back · Delete removes the selection

The home page has tools (Edit PDF, Combine PDFs, Fill & Sign, Organize pages, Redact) and your recent and starred files.

Markups are saved as real PDF annotations: other PDF apps show them as comments, and BubbyPDF reopens them as movable objects.

## Known limits
- Edit text (E) removes the old paragraph from the file and writes the new one in a standard font (Helvetica, Times or Courier family). Text in unusual fonts or inside graphics is covered with white instead, and you are told.
- Redacted pages are saved as images: their text can no longer be selected or searched. Bookmarks are dropped from a redacted copy.
- Saved text uses the standard PDF fonts (Latin characters). Other characters are replaced with "?" and you are told.
- No OCR for scanned PDFs. Password-protected PDFs open, but changes to them can't be saved.
