# Architecture

A desktop app with no server. The default web stack (Next.js, Postgres, auth, Stripe) does not apply:
the product promise is "free, offline, no account", so there is no database, no auth and no payments.

## Stack
| layer | choice | why |
|---|---|---|
| shell | Electron 33 | produces a Windows .exe from web tech; Node already installed |
| packaging | electron-builder 25 (NSIS installer + portable .exe) | one command builds both |
| UI | plain HTML/CSS/JS, no framework, no bundler | small, fast start (fix #8), nothing to compile |
| PDF rendering | pdf.js (pdfjs-dist 3.11.174) | Mozilla's renderer, Apache-2.0 |
| PDF writing | pdf-lib 1.17.1 | edits, forms, page ops, MIT |
| storage | the user's own files + a small JSON of recent files in `%APPDATA%` | offline, no cloud (fix #2) |
| network | none; CSP blocks all remote loads | no telemetry, no updates phoning home |

## Data model (in memory, replaces schema.sql)
No SQL: there is no database. The model from `recon.md`:
```
docs:     Map id -> { name, path, bytes, pdfjsDoc, encrypted }
pages:    [ { docId, src (index), rot (0/90/180/270), blank?: {w,h}, annots: [...] } ]   order = output order
annots:   { id, type: text|highlight|ink|rect|whiteout|image|check, x, y, w, h, ...style }
          coordinates in PDF points, top-left origin, unrotated page space
images:   Map id -> { dataUrl, bytes }   (signatures and inserted images)
fields:   Map docId -> Map fieldName -> value
history:  undo/redo stacks of JSON snapshots of pages+fields
```

## IPC (replaces the API table)
| channel | does | flow |
|---|---|---|
| `dialog:open` | native open dialog, returns [{name, path, bytes}] | F01-F06 |
| `file:read` | read a path (recent files, drag-drop, "open with") | F01 |
| `dialog:save` | native save dialog defaulting to `name (edited).pdf`, writes bytes | F01-F05 |
| `recent:get` / `recent:add` | recent files JSON in userData | S01 |
| `app:open-file` (main -> renderer) | file passed on command line / file association | F01 |

Renderer runs with `contextIsolation: true`, `nodeIntegration: false`, a preload bridge exposing only those calls.

## Parts that bite
- **Coordinates:** pages have crop boxes and existing `/Rotate`. Store annotations in unrotated top-left space, map through pdf.js viewport transform on screen, and through cropBox on export.
- **Fonts:** pdf-lib standard fonts are WinAnsi only. Characters outside it get replaced and the user is told.
- **Forms across merges:** copying pages to a new document drops the AcroForm. If output is exactly one source doc in original page order, edit in place (forms stay fillable); otherwise flatten filled forms first.
- **Encrypted PDFs:** pdf.js opens with a password; pdf-lib cannot re-save them. Saving is refused with a clear message.
- **Big files:** render pages lazily (IntersectionObserver), thumbnails at low scale.
- **Never lose work:** Save writes a new file by default; overwriting requires picking the same name in the dialog. Unsaved-changes guard on close.
- **Unsigned .exe:** Windows SmartScreen warns on first run until it is code-signed.

## Build order
1. Vertical slice: open -> view pages -> add text box -> save a copy. (S01, S02, S09)
2. Must-haves: markup tools (S03), fill & sign (S04, S05), edit text (S06), organize + merge (S07), search (S08), undo.
3. Should-haves: recent files, password files, extract pages, dark mode, Back after jump.
4. Package: NSIS installer + portable .exe.
