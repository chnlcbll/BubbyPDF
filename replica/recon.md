# Recon map: Acrobat-style desktop PDF editor (clean-room)

Version 2, 2026-11-10. v1 was written from general knowledge; v2 is checked against Acrobat's public desktop help center.

## Scope
1. **App / platform:** Adobe Acrobat for Windows desktop.
2. **Slice:** v1 was the core loop (open, mark up, fill and sign, fix text, organize pages, save). v2 maps the **whole desktop feature set** from the help center, so the feature matrix shows what is still missing. Cloud, AI and Adobe's network services are out (see "What cannot be cloned").
3. **For:** BubbyPDF, a free offline Windows app. **User decision (2026-11-10): no pricing research and no paid tiers. Every feature the clone builds is free.** Feature gating on the original's pricing page was deliberately not read.

Clean-room: built from the publicly documented features and review evidence. No Adobe code, binaries, assets, icons, names or private APIs. Help pages were read in a browser at human speed; nothing was crawled or saved. No screenshots of the original were captured (`replica/screens/` is empty), so replica-diff has no layout score.

## Sources
| source | url | read | used for |
|---|---|---|---|
| Desktop help hub | https://helpx.adobe.com/acrobat/desktop.html | 2026-11-10 | top tasks, popular articles |
| Get started | https://helpx.adobe.com/acrobat/desktop/get-started.html | 2026-11-10 | workspace, preferences, shortcuts, themes |
| Help navigation (all sections) | same site, side navigation | 2026-11-10 | the full feature list below (section and article titles only) |
| Change, replace, or delete text | https://helpx.adobe.com/acrobat/desktop/edit-documents/edit-text-in-pdfs/modify-text.html | 2026-11-10 | S06 behaviour |
| What's new / release notes | https://helpx.adobe.com/acrobat/desktop/whats-new.html | not read | the recent focus is visibly AI (the hub leads with it) |
| Pricing | https://www.adobe.com/acrobat/pricing.html | **skipped by user decision** | n/a: everything is free in the clone |
| App Store reviews (RSS) | https://itunes.apple.com/us/rss/customerreviews/id=469337564/json | 2026-11-10 | 500 reviews (see `fixes.md`) |
| Google Play reviews | https://play.google.com/store/apps/details?id=com.adobe.reader | 2026-11-10 | 50 reviews |
| Hacker News (Algolia API) | https://hn.algolia.com/api/v1/search?query=Acrobat | 2026-11-10 | 135 comments |

## What the help center shows (summary, in our words)
The desktop help is organised into these areas. The counts are the number of help articles in each, which roughly shows how much surface each area has.

| area | articles | what it covers |
|---|---|---|
| Get started | 29 | workspace, page navigation, themes, language, side panels, toolbar customisation, shortcuts, install/update |
| AI | 29 | AI assistant, summaries, chat-based editing, podcasts (out of scope) |
| Create documents | 31 | convert files/web pages/clipboard to PDF, blank PDF, print-to-PDF, scan + text recognition (OCR), reduce file size, Distiller settings |
| Edit documents | 60 | edit and format text, text boxes, lists, spell check; add/modify/delete images and objects; links, attachments, destinations; properties and metadata; organize pages (delete, move, move between PDFs, rotate, replace, renumber, split, extract, crop); watermarks, backgrounds, headers and footers, page numbers, Bates numbering; combine files; layers |
| Sign | 22 | e-sign yourself, digital (certificate) signatures, certify, validate, timestamps; request signatures from others (their service) |
| Forms | 30 | create forms (auto-detect fields, add/align/resize fields), field properties, formatting, calculations, fill and sign, flatten, auto-fill, barcodes, share and track forms |
| Share and review | 40 | comments: sticky notes, text box comments, callouts, insert/replace-text marks, highlights and other markups, shapes and drawings, stamps (custom, dated); comment list, replies, reactions, resolve, find, author name; shared reviews (their cloud) |
| Protect | 60 | passwords to open, permission restrictions (print/edit/copy), remove passwords, certificate encryption, digital IDs, **redaction** (text, images, search-and-redact, redaction codes) and **sanitize** (remove hidden data), protected view, security warnings, policies |
| Print | 30 | printer settings, multiple pages per sheet, booklets, posters, duplex, page sizes, comments in print, colour separations |
| Export | 8 | PDF to images, Word, Excel, PowerPoint, PostScript, HTML, plain text, RTF |

From the edit-text article: in the original, clicking existing text turns the block into an editable text box (with a rotation handle) whose font, size, colour and alignment can be changed; editing in a specific font needs that font installed, otherwise only colour and size change. BubbyPDF v1 covers and retypes a single text run instead; this is the largest quality gap in the core loop.

## Screen inventory
| ID | screen | how you get there | purpose | key components | states |
|---|---|---|---|---|---|
| S01 | Home / start | launch | open a file, recent files | open button, recent list, drop zone | empty, filled |
| S02 | Document view | open a PDF | read and navigate | toolbar, page canvas, thumbnails, zoom, page number | loading, filled, password, damaged |
| S03 | Comment / markup | tool rail | highlight, underline, strike, notes, shapes, stamps | tool rail, colour/size popover | tool active, object selected |
| S04 | Fill & sign | tool rail | fill fields, text, check marks, signature | field overlays, signature dialog | no fields, fields present |
| S05 | Signature dialog | Fill & sign > Sign | draw, type or image signature | canvas, type tab, clear, apply | empty, drawn, saved |
| S06 | Edit text and images | tool rail | change text blocks, format, move/resize images | text boxes, format panel | no text layer (scanned) |
| S07 | Organize pages | tool rail | reorder, rotate, delete, insert, extract, split, crop, replace | page grid, multi-select, action bar | one page, many pages |
| S08 | Search | Ctrl+F | find text | search box, results list | none, results |
| S09 | Save / export | Ctrl+S / Export | write PDF or other formats | save dialog, export options | success, write error |
| S10 | Settings | menu | theme, defaults, author name | toggles | default |
| S11 | Comments panel | side panel | list, reply, resolve, filter, jump to comment | comment cards, filter | none, many |
| S12 | Protect | tool | add/remove password, set permissions | password fields, permission checkboxes | protected, unprotected |
| S13 | Redact | tool | mark areas or search terms, apply, sanitize | marks list, apply confirm | marked, applied |
| S14 | Create / combine | tool | images or files to PDF, blank PDF, combine | file list, reorder | empty, filled |
| S15 | Print | Ctrl+P | print with layout options | printer, pages, n-up, booklet | n/a |
| S16 | Prepare form | tool | add and edit form fields | field palette, properties | empty form, fields |
| S17 | Page marks | tool | page numbers, headers/footers, watermark, background, Bates | template, position, preview | n/a |
| S18 | Bookmarks panel | side panel | outline navigation | tree | no outline, outline |
| S19 | Reduce size / OCR | tool | compress, recognise text | quality preset, language | n/a |

## User flows
```
F01 Fill and sign a form           S01 -> S02 -> S04 -> S05 -> S09                ~6 clicks
F02 Highlight and comment          S02 -> S03 -> S11 -> S09                       ~4 clicks
F03 Fix a typo in existing text    S02 -> S06 -> S09                              ~4 clicks (edge: scanned PDF)
F04 Merge two PDFs and reorder     S01 -> S14/S07 -> S09                          ~5 clicks
F05 Rotate all / delete pages      S02 -> S07 -> S09                              ~4 clicks
F06 Find a word, jump, come back   S02 -> S08 -> S02                              ~3 clicks
F07 Redact private info            S02 -> S13 (mark, apply, sanitize) -> S09      ~6 clicks (edge: text inside images)
F08 Password-protect a PDF         S02 -> S12 -> S09                              ~5 clicks
F09 Print 2 pages per sheet        S02 -> S15                                     ~4 clicks
F10 Turn photos into one PDF       S01 -> S14 -> S09                              ~4 clicks
F11 Add page numbers               S02 -> S17 -> S09                              ~4 clicks
F12 Make a scanned PDF searchable  S02 -> S19 (OCR) -> S09                        ~3 clicks
F13 Build a fillable form          S02 -> S16 (add fields) -> S09                 ~8 clicks
F14 Split a PDF into files         S02 -> S07 (split) -> S09                      ~4 clicks
```

## Components
Everything in v1, plus: comment card (author, time, replies, resolve), stamp picker, permission checklist,
redaction mark (pending vs applied), file list for combine (drag to reorder), print preview, form field palette and property sheet,
bookmark tree, progress dialog for long jobs (OCR, compress).

## Inferred data model (in memory, no server)
```
Document    id, name, path, bytes, pageCount, hasForm, encrypted, outline                  confidence: high
PageRef     docId, sourceIndex, rotation, crop, blank(w,h), label                          confidence: high
Annotation  id, pageRef, type (text|highlight|underline|strike|note|ink|rect|ellipse|line|arrow|
            whiteout|image|check|stamp), geometry, style, author, createdAt, replies[], resolved
            evidence: help "Share and review" section                                      confidence: high
Redaction   id, pageRef, rect | searchTerm, applied                                        confidence: high
FormField   name, type (text|checkbox|radio|dropdown|list|signature), rect, value, props    confidence: high (PDF spec)
Security    openPassword, permissions {print, edit, copy}                                  confidence: high (PDF spec)
PageMark    kind (pageNumber|header|footer|watermark|background|bates), template, position  confidence: medium (guess)
```

## Feature matrix
`features.csv`: v1 rows kept with their build status; v2 adds every desktop feature from the help center.

## What cannot be cloned (skip rows)
- AI assistant, summaries, chat editing, podcasts: their models; also a top complaint (44 reviews).
- PDF Spaces, shared reviews in their cloud, cloud storage and sync: their service.
- Request signatures from others, bulk send, agreement tracking: their e-sign network.
- Adobe Express integration: their service.
- Server-based security policies and Microsoft Purview labels: enterprise servers.
- Certified signatures trusted by Adobe's trust list: their trust programme (self-signed certificate signing is possible, listed as "could").
- Prepress printing (colour separations, trapping, Distiller/PostScript): professional print production, out of slice.

## Size
19 screens, 14 flows, 7 entities.
Hard parts: (1) **true text editing** with paragraph reflow and font handling, (2) **real redaction** that removes the content from the file, not just covers it, (3) **encryption** (pdf-lib cannot write encrypted PDFs; needs another library), plus OCR (feasible offline with an open-source engine) and Office export (needs a converter; likely skip).
Size: v1 slice was **M** and is built. The full desktop set is **L** (a quarter of focused work). Recommend building in waves: comments and markups, then redaction, then protect/print/create, then forms authoring.
