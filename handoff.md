# Handoff — hybrid page-host corner/edge resize ("dodgy corner drag")

## Status: ✅ DONE / SHIPPED
Peek task `item_1782157074888_5ovnbbiz5` ("corner hover to click and drag is
really dodgy"). Fixed, full desktop gate green, user-verified ("feels great,
ship it"), collapsed into one commit and pushed to `main`.

If you're picking this up: the work is **complete**. This file is kept only as a
record of how it was solved (and which approaches are dead ends, so nobody
re-treads them). There is no open work here unless a regression resurfaces.

## What shipped (commit on `main`)
`fix(desktop): reliable wide-band resize for hybrid page-host edges/corners`

Resize was moved **entirely to main + the content WebContentsView**; the chrome
overlay was reverted to chrome-only (its resize handles removed).
- **Cursor** — main observes the content WC `input-event` stream (`globalX/Y`),
  computes the edge/corner band direction via the pure predicate
  `hybridResizeDirAt` (`apps/desktop/main/izui-roles.ts`; band = **8px edge /
  16px corner**), and on direction-change injects a whole-document
  `*{cursor:<dir>-resize !important}` rule via `contentWC.insertCSS` /
  `removeInsertedCSS` (`apps/desktop/main/ipc.ts`, in `wireHybridContentEvents`).
  Gated on `contentWC.isFocused()` (first responder) so a background/transitional
  host doesn't churn the injection and flash the page.
- **Drag** — a press inside the band starts a main-driven resize FSM that calls
  `baseWin.setBounds(.., false)` from the observed move stream until release. No
  timers.

## Why this shape (the load-bearing constraints — don't re-litigate)
- The chrome overlay is a separate floating BrowserWindow and is **never the macOS
  key window / first responder**, so it **cannot paint a resize cursor** even when
  opaque. Proven live: an overlay-driven resize could capture the press but showed
  **no cursor anywhere**. Only the content WC (first responder) can render a cursor.
- The OS cursor belongs to the **topmost hit-testable window**. To capture a press
  the overlay must be opaque → topmost → its (non-rendering) cursor wins. So
  overlay-opaque-capture and a visible content cursor are mutually exclusive →
  the overlay had to exit resize entirely.
- Native frameless resize alone only grabs the outermost ~2-3px and the content
  view fills to the edge showing the page pointer → pointer↔arrow flicker.
  **Insetting the content view does NOT widen the native zone.**

## Dead ends (confirmed — do not revisit)
1. JS `document.mousemove` resize loop.
2. Overlay-opaque-on-edge resize (the old `corner-drag-redo`): flickered from two
   disagreeing capture authorities AND can't paint a cursor (above).
3. Native-only resize: too thin, flickers.

## Known minor tradeoff (accepted)
The content `input-event` stream is **observe-only** (can't preventDefault), so the
page also receives the band mousedown. The outer ~8px is almost always page
margin/scrollbar, so it's harmless in practice. If a real conflict shows up
(near-edge link/scrollbar), the documented mitigation is arming the *drag* on a
narrower outer band than the cursor band.

## Tests
- `izui-roles` unit suite **66/66** (incl. `hybridResizeDirAt` boundary cases that
  track the 8/16 constants).
- `hybrid-overlay` spec **39/39**.
- Full `yarn test:desktop:electron` gate **green** (all 6 runners), run twice
  (pre- and post- the first-responder guard).

## If a regression appears
- Cursor flicker/flash again → check `contentWC.isFocused()` gating in
  `wireHybridContentEvents` (the first-responder guard) and whether a host is being
  hovered while not first responder (the original symptom's mechanism).
- Wrong/stuck cursor → the `insertCSS`/`removeInsertedCSS` reconciler
  (`reconcileCursor`) is the single applier; `setHoverDir` is the only entry.
- Band feels off → tune `RESIZE_EDGE_PX` / `RESIZE_CORNER_PX` in `izui-roles.ts`
  (and the `// 8` / `// 16` comments + boundary cases in `izui-roles.test.ts`).
