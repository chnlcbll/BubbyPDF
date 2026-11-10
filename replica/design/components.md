# Components

Tokens: `tokens.json` (light) and `tokens-dark.json` (dark). Contrast: 13 pairs each, 0 AA failures (`contrast.py`, 2026-11-10).
Implemented as CSS custom properties in `src/styles.css`. Icons are drawn in-house (`src/icons.js`, 24px stroke), no third-party icon set.

```
Button (.btn)
  variants  primary (accent fill), secondary (surface + border), ghost (no border), danger
  sizes     md 32px (titlebar), icon 36px square (tool rail)
  states    default, hover (surface-2), active/pressed (aria-pressed=true: accent tint + accent text),
            focus-visible (2px accent ring, 2px offset), disabled (40% opacity, no pointer)
  a11y      real <button>, aria-label on icon-only buttons, title tooltip with shortcut
  used on   titlebar, tool rail, sidebar actions, dialogs, S01-S09

Tool rail item     icon button, aria-pressed for the active tool; shortcut letter in the tooltip. S02-S06
Tool options bar   floating bar over the viewer: swatches (radio group), size select, mark type. S03, S04
Swatch             28px circle, radio semantics, selected = 2px ring in text colour
Page (.page)       white paper, shadow page; layers: base canvas, overlay canvas, HTML layer (fields, links, text boxes)
Thumbnail          120px canvas + page number; states: default, selected (accent ring), drop-before/after indicator; draggable
Dialog             centered, max 520px, role=dialog aria-modal, Escape closes, focus moves to first control. S05, password, unsaved
Toast              bottom center, role=status aria-live=polite; info and error variants, 3.5s
Search panel       right panel 280px: input, result count, results grouped by page, active result. S08
Start screen       drop zone + Open PDF + recent list (empty state copy), free/no-account line. S01
Form field input   positioned over PDF widgets; transparent tinted background, focus ring; text, checkbox, radio, select
```
Motion: 100-180ms ease for hover and panel. `prefers-reduced-motion` turns transitions off.
