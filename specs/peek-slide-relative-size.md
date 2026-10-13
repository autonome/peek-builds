---
enabled: true
touches: [apps/desktop/features/peeks/**, apps/desktop/features/slides/**, apps/desktop/main/window-placement.ts, apps/desktop/main/window-placement.test.ts, apps/desktop/main/ipc.ts, apps/desktop/tests/desktop/peeks.spec.ts, apps/desktop/tests/desktop/slides.spec.ts]
depends-on: []
---

# Peeks and slides open at a size relative to the display when no size is set

Peek item `36f54555`, its remaining half. Remembering a resize already ships
(`4b8e4d4e`, `69d315bc`): each peek (by window key) and slide (by edge) saves its settled
resize in the `sizes` setting, and an Options width/height edit made after a resize wins. What
is left is the default size: an item with no resize and no explicit Options size opens at the
config's 1024x768, or the 800x600 fallback, whatever the display.

## What the code does now

- `features/peeks/config.js` and `features/slides/config.js`: every default item carries
  `width:1024, height:768`; each `itemSchema` defaults the same. Saved profiles carry these
  values in their `items` rows.
- `peeks/background.js executeItem()` and `slides/background.js sizeFor()` pick the saved
  resize if `resizeStillApplies`, else `item.width || 800` / `item.height || 600`, and pass the
  pair to `api.window.open`.
- `main/ipc.ts`'s window-open handler maps a slide's `screenEdge` to an edge placement (peeks
  use `center:true`) and calls `main/window-placement.ts computeInitialBounds`, which uses the
  cursor display's work area and clamps the size to it (`clampSize`).

## Decisions

- Precedence at open, highest first: a saved resize that still applies; an explicit Options
  width/height; the display-relative default. The first two are unchanged.
- An item's width/height of exactly 1024x768 (the old shipped default, present in nearly every
  saved profile) counts as "no explicit size" when choosing the fallback. Rows are not rewritten,
  so `resizeStillApplies`'s comparison against `optionsWidth`/`optionsHeight` is unaffected.
- Defaults are fractions of the opening display's work area (`wa`), computed in main where the
  display is known:
  - Peek: width `0.60 * wa.width`, height `0.80 * wa.height`; about 1152x830 on a 1920x1080
    display, roughly 10-15% larger each way than 1024x768.
  - Slide: height `0.90 * wa.height`; width `0.35 * wa.width` with an 800 px floor so a page in a
    slide stays above a common mobile breakpoint (768 px). The floor wins over "taller than wide"
    on a display too short for both.
  - The existing `clampSize` to the work area still applies last.
- `persistState` and `allowSound` are untouched; Peek item `92d39f76` decides their fate.

## What changes

- `window-placement.ts`: `computeInitialBounds` accepts an optional relative size (fractions of
  the work area plus an optional minimum width), used when the open request carries no explicit
  width/height. Keep it pure and platform-neutral (`apps/desktop/CLAUDE.md`, "Electron is ONE
  backend").
- `ipc.ts` window-open: passes the relative size from the open params through to placement.
- `peeks/background.js` and `slides/background.js`: when neither a saved resize nor an explicit
  Options size applies, send the type's relative size instead of a pixel pair. Delete the
  800/600 fallbacks.
- `config.js` (both): remove `width`/`height` from the default items, and make the schema's
  defaults empty so a new item opens at the relative default. Check the Features Manager Options
  form still renders and saves an empty width/height, and that an explicit value still applies.

## Tests to change

- `main/window-placement.test.ts`: relative sizes resolve to the stated fractions of a given
  work area; the slide width floor applies on a narrow work area; the result is still clamped to
  the work area; an explicit width/height bypasses the relative size.
- `tests/desktop/peeks.spec.ts` and `slides.spec.ts`: existing placement tests keep passing
  (adjust any that assert 1024x768). Add: a peek and an Up slide with no size set open at the
  expected fractions of the test display's work area (allow a few px for window-manager
  rounding); an item saved at 1024x768 opens at the relative size too; an item with an explicit
  non-default Options size opens at that size; the slide's width is at least 800 or the work
  area width, whichever is smaller.
- The existing resize-memory specs from `4b8e4d4e` / `69d315bc` keep passing unchanged.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "Peeks|Slides|peek|slide"
```

Done when the unit tallies report `fail 0`, the new tests pass, and no peek or slide spec fails
that is not recorded in `apps/desktop/tests/gate-baseline.md`. Record the `test:grep` pass/fail
count under `**Result**` in the handoff. Window sizing is display-dependent: the Linux run is
not evidence for macOS; note that under `**Result**`.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing. Run one command per
Bash call.
