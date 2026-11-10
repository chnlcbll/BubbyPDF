# Test plan

Automated: `test/ui-test.mjs`, run in the real Electron window with
`BUBBY_SELFTEST=1 node_modules/electron/dist/electron.exe .` (exit code 0 = all pass).
Playwright was not used: the self-test runs the same flows inside the shipped renderer, with no extra 300 MB of browsers.
Fixture: `test/fixture.pdf` (built by `node test/make-fixture.mjs`): 3 pages, AcroForm, internal link, a page stored with /Rotate 90.

Result 2026-11-10: **30 / 30 pass.**

| case | what | how | result |
|---|---|---|---|
| F01-H1 | open, fill text/checkbox/radio/dropdown, save keeps a fillable form | auto | pass |
| F01-H2 | filled values survive a merge (flattened) | auto | pass |
| F01-N1 | non-PDF file shows an error, document untouched | auto | pass |
| F01-E1 | signature draw/type, place, resize | manual | to do on a real machine |
| F02-H1 | highlight, ink, rect, check mark, text box appear in output | auto | pass |
| F02-E1 | accents and CJK text: unsupported characters replaced with "?" and the user is told | auto | pass |
| F03-H1 | click existing text, retype, save | auto | pass |
| F04-H1 | merge a second PDF, 6 pages out | auto | pass |
| F05-H1 | rotate selected page, insert blank page, page rotation in output | auto | pass |
| F05-E1 | extract one page | auto | pass |
| F06-H1 | search finds matches on 2 pages | auto | pass |
| F06-E1 | link and Back button | manual | to do |
| X-1 | undo / redo | auto | pass |
| X-2 | light and dark theme render | screenshot | pass (`replica/screens-clone/`) |
| X-3 | close with unsaved changes asks first | manual | to do |
| X-4 | password-protected PDF opens after password | manual | to do (no fixture) |
