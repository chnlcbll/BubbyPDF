# Deploy (desktop build)

BubbyPDF is an offline desktop app, so there is no server, database, domain, Stripe or OAuth step.
"Deploy" here means: build the Windows .exe files and, when you decide, publish them.

## Preflight (2026-11-10)
| check | result |
|---|---|
| End-to-end self-test in Electron (`BUBBY_SELFTEST=1`) | 30 / 30 pass |
| Feature parity (`parity.py`) | see `parity.md` |
| Brand sweep (`sweep.py --config replica/brand.json`) | clean, exit 0 |
| Open S1 / S2 bugs | none (`bugs.md`) |
| Packaged build smoke test (`BUBBY_SMOKE`) | opened a PDF from the command line, 3 pages, 5 form fields, rendered; screenshot `screens-clone/04-packaged.png` |
| Network access | none: CSP blocks remote loads, no update checks, no telemetry |
| Privacy policy | not needed for the app itself (it collects nothing); needed on a website if you add analytics |

## Build
```
npm install
npm run dist        # -> dist/BubbyPDF-Setup-1.0.0.exe and dist/BubbyPDF-Portable-1.0.0.exe
```
Two machine-specific workarounds were needed on this PC:
1. Electron's postinstall did not extract its runtime. Fix: extract `%LOCALAPPDATA%\electron\Cache\...\electron-v33.2.1-win32-x64.zip` into `node_modules/electron/dist` and write `electron.exe` into `node_modules/electron/path.txt`.
2. electron-builder's winCodeSign archive has macOS symlinks that Windows refuses without Developer Mode. Fix: extract it with 7za into `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0` (the symlink errors are harmless).

## Outputs
| file | what |
|---|---|
| `dist/BubbyPDF-Setup-1.0.0.exe` | installer: per-user, lets you pick the folder, adds Start menu entry, registers .pdf "Open with" |
| `dist/BubbyPDF-Portable-1.0.0.exe` | single file, runs without installing |

## Before you share it publicly (your decisions)
- **Code signing.** The .exe files are unsigned, so Windows SmartScreen will warn "Windows protected your PC" on first run. Options: an OV/EV code-signing certificate, or Azure Trusted Signing. You buy and set this up; then add the cert to electron-builder (`CSC_LINK` / `CSC_KEY_PASSWORD`, or `win.azureSignOptions`).
- **Where to host the download.** GitHub Releases is free and fine. Nothing has been published.
- **Name check.** Trademark searches for "BubbyPDF" are still marked "to run" in `brand.md`.
- **Licenses.** pdf.js is Apache-2.0, pdf-lib is MIT, Electron is MIT. Keep their notices (Electron ships `LICENSES.chromium.html` in the build).

## First week to watch
There is no telemetry by design, so feedback comes from people: a GitHub Issues page or an email address on the download page.
