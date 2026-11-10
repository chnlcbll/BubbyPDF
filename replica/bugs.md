# Bugs

| id | sev | summary | status |
|---|---|---|---|
| B1 | S2 | Radio choices from some PDF generators saved to the wrong value: widget states are indices ("0", "1") into /Opt | fixed: map index to option on save; test "in-place: radio saved" |
| B2 | S2 | Electron runtime auto-extract failed silently after npm install (dist had only `locales`) | worked around: extracted the cached zip with Windows tar; note in README |
| B3 | S3 | Whiteout and Edit text cover the old text visually, but the original text stays in the file | fixed in 1.1.0: Redact tool (B) removes content; Whiteout says it is visual only |
| B6 | S2 | Redaction leaked: a link on another page pulled the unredacted page into the saved file | fixed: redacted pages are rewritten in place before copying; test "redacted words not anywhere in the file" |
| B7 | S4 | Search results from the previous document stayed visible after opening another | fixed |
| B4 | S4 | Opening the search panel at fit-width zoom adds a horizontal scrollbar | open |
| B5 | S4 | The floating tool options bar covers the top edge of page 1 when scrolled to the very top | open |

Open S1: none.

## To check (not reproduced)
- Performance on 500+ page PDFs.
- Password-protected PDFs (open works through pdf.js; saving is refused with a message by design).
- Text in a font Windows doesn't have as a metric match shows slightly different widths in the app vs. the saved file.
