# Window Placement Refactor — Sprint Plan

**Goal:** Eliminate ad-hoc display/positioning logic scattered across `ipc.ts`,
`tile-ipc.ts`, `display-watcher.ts`, and `features/slides/background.js`.
Replace with one pure module driven by a `Placement` intent recorded on the
window registry. Make display-change behavior deterministically unit-testable
without real multi-monitor hardware.

**Non-goals:** No FSM. No IZUI integration. No session-restore changes beyond
the minimum needed to populate `placement`. No slides-feature redesign — only
moving the math from renderer to main.

**Sprint discipline:** No e2e tests, no manual repro, no shipping until all
phases are complete. Each phase is committable on its own but stays in the
local stack until the sprint closes. Phase exit criteria are **build clean +
unit tests pass** — that's it.

---

## The model

### `Placement` discriminated union

```ts
// backend/electron/window-placement.ts

export type Placement =
  | { mode: 'centered' }
      // Always centered on the cursor's display, every time the window
      // is shown. cmd panel, modal palettes, "center: true" callers.
  | { mode: 'cursor-display-fallback' }
      // Centered on cursor display ONLY if no explicit position was
      // ever provided. Once positioned, stays put across reuse —
      // unless stranded (see below). Page-host default.
  | { mode: 'edge'; edge: 'top' | 'bottom' | 'left' | 'right' }
      // Anchored to one edge of the cursor's display, every show.
      // Slides.
  | { mode: 'parent-centered'; parentId: number }
      // Centered on the parent window's bounds. Quick-views, child
      // dialogs.
  | { mode: 'manual' };
      // User-positioned (drag, manual setBounds). Never auto-moved
      // EXCEPT when stranded.

export interface PlacementInput {
  placement: Placement;
  currentBounds: Electron.Rectangle;  // window's bounds right now
  windowSize: { width: number; height: number };  // desired/intrinsic size
  displays: Electron.Display[];
  cursorPoint: Electron.Point;
  parentBounds?: Electron.Rectangle;  // required for parent-centered
}

export type PlacementResult =
  | { kind: 'no-change' }
  | { kind: 'reposition'; bounds: Electron.Rectangle };
```

### The single function

```ts
export function computePlacement(input: PlacementInput): PlacementResult;
```

**Contract:**

- Pure. No `screen.*` calls inside. No `BrowserWindow.*`. Caller passes in
  display state.
- Returns `no-change` if the window is already correctly placed for the given
  placement intent. Callers should skip `setBounds()` in that case.
- For every mode, "stranded" rescue is built in: if `currentBounds` has <50%
  area on any display, the result is always `reposition` to the cursor
  display, regardless of mode. (Replaces today's `isWindowAccessibleNow` +
  `repositionOnCursorDisplay`.)
- Output bounds always clamp size to the chosen display's `workArea`.

### Where intent gets set

`Placement` is assigned **once at window-open time**, stored on
`windowRegistry.params.placement`, and never re-derived from flag soup
(`center: true`, explicit `x/y`, `useCanvas`, etc.). All consumers — reuse
paths, display-watcher, fresh-open fallback — read from the registry.

Mapping from current flags to `Placement`:

| Current flags                                              | Placement                                            |
|------------------------------------------------------------|------------------------------------------------------|
| `options.center === true`                                  | `{ mode: 'centered' }`                               |
| `options.x` / `options.y` provided + valid                 | `{ mode: 'manual' }`                                 |
| Has real parent + no explicit position                     | `{ mode: 'parent-centered', parentId }`              |
| Slides feature (`screenEdge` in opts)                      | `{ mode: 'edge', edge: <screenEdge> }`               |
| Everything else (page-host, generic web pages, new-tab)    | `{ mode: 'cursor-display-fallback' }`                |

Slides currently passes explicit `x`/`y` from the renderer's stale
`window.screen` — Phase 4 deletes that and passes `screenEdge` instead.

---

## Phase plan

Each phase has: scope, files, exit criteria, what's explicitly **out**.

### Phase 1 — Pure module + unit tests + fake-displays helper

**Scope:**
- New file `backend/electron/window-placement.ts` exporting `Placement`,
  `PlacementInput`, `PlacementResult`, and `computePlacement`.
- New file `backend/electron/window-placement.test.ts` (or
  `tests/unit/window-placement.test.js`, matching project unit-test
  conventions — agent decides based on existing layout) with a
  `fakeDisplays(...)` helper and exhaustive coverage of every `Placement`
  mode + the stranded-rescue path.
- No production code touched. No imports added to `ipc.ts` etc.

**Files touched:**
- `backend/electron/window-placement.ts` (new)
- Test file (new)

**Test cases (minimum):**
1. `centered` on cursor display A, displays unchanged, cursor on A → `no-change`.
2. `centered` on cursor display A, cursor moves to B → `reposition` to B's center.
3. `centered`, A removed entirely → `reposition` to (now-only) display.
4. `cursor-display-fallback`, window currently fits on its display, cursor moves
   to other display → `no-change` (unlike `centered`, doesn't follow cursor).
5. `cursor-display-fallback`, window stranded (display unplugged) → `reposition`
   to cursor display center.
6. `edge: 'top'`, cursor on A → bounds anchored to A's top edge, X-centered.
7. `edge: 'top'`, cursor moves to B → re-anchor to B's top edge.
8. `parent-centered`, parent on A → centered on parent's bounds.
9. `parent-centered`, parent has been destroyed (parentBounds undefined) → fall
   back to `cursor-display-fallback` semantics (or whatever we decide).
10. `manual`, window fits on some display → `no-change`.
11. `manual`, window stranded → `reposition` (rescue) to cursor display.
12. Window size larger than target display → output clamped to display workArea.

**Exit criteria:**
- `yarn build` clean.
- Unit tests pass via `yarn test:unit` (or whatever runs the new test file).
- Zero references to `window-placement.ts` from production code yet — this is
  a pure addition.

**Out of scope:** wiring into existing call sites, deleting old helpers,
session-restore.

---

### Phase 2 — `placement` field on windowRegistry, set at every open call site

**Scope:**
- Add `placement: Placement` field to `windowRegistry.params` shape
  (`backend/electron/main.ts`).
- At every `registerWindow()` call site, derive and pass `placement` per the
  mapping table above.
- Slides feature: pass `screenEdge` through the open options object so the
  open path can record `{ mode: 'edge', edge }` (renderer math stays in place
  for now — Phase 4 strips it).
- No behavior change. The new field is data-only. Reuse paths still use the
  current `isWindowAccessibleNow` + `center: true` branch logic.

**Files touched:**
- `backend/electron/main.ts` (registry shape)
- `backend/electron/ipc.ts` (window-open handler — assign placement)
- `backend/electron/tile-ipc.ts` (v2 tile open path — assign placement)
- `features/slides/background.js` (pass `screenEdge` in options)

**Exit criteria:**
- `yarn build` clean.
- Unit tests still pass.
- Logging assertion: every newly registered window has a non-undefined
  `params.placement`. Agent should add a one-line `console.log` audit (then
  remove before done) or write a tiny unit test that exercises the assignment
  via the existing `registerWindow` contract.

**Out of scope:** consuming the new field. Reuse paths and display-watcher
still use today's logic. Slides renderer keeps doing its `window.screen` math.

---

### Phase 3 — Replace ad-hoc positioning with `computePlacement` calls

**Scope (three call-site groups, one phase):**

- **Reuse paths in `ipc.ts`:**
  - URL-reuse path (~ipc.ts:580): replace inline
    `isWindowAccessibleNow + repositionOnCursorDisplay` with a single
    `computePlacement` call using the stored `placement`. Apply result.
  - keepLive-reuse path (~ipc.ts:580–625): replace the `center: true` /
    stranded branches with a single `computePlacement` call.
  - Delete `isWindowAccessibleNow` and `repositionOnCursorDisplay` helpers
    (now redundant).

- **Fresh-open positioning in `ipc.ts:737–797`:** replace the cursor-display
  centering fallback (and the canvas-page variant at 791–797) with a
  `computePlacement` call seeded from the just-derived `placement`.

- **Display-watcher in `display-watcher.ts`:** replace the
  `center: true`-only second pass with a generic pass that calls
  `computePlacement` for every visible window using its registry-stored
  `placement`. The first-pass orphan rescue stays — it's the catch-all for
  windows whose `placement` produced bounds outside `workArea` (defense in
  depth) and for windows registered before placement was added.

**Files touched:**
- `backend/electron/ipc.ts`
- `backend/electron/display-watcher.ts`

**Exit criteria:**
- `yarn build` clean.
- Unit tests pass.
- Old helpers (`isWindowAccessibleNow`, `repositionOnCursorDisplay`) deleted.
- No remaining `screen.getDisplayNearestPoint(screen.getCursorScreenPoint())`
  call in `ipc.ts` — every position decision flows through `computePlacement`.

**Out of scope:** `tile-ipc.ts` v2 path. Slides renderer cleanup. Session
restore.

---

### Phase 4 — Slides renderer cleanup

**Scope:**
- Delete the `window.screen.width/height`-based x/y math in
  `features/slides/background.js` (the loop around lines 66–88 in the file as
  it stood at audit time).
- Slides now pass only `{ screenEdge, width, height }` to `api.window.open`.
- The window-open path (Phase 2 + 3) reads `screenEdge`, sets
  `placement: { mode: 'edge', edge }`, and main-process `computePlacement`
  produces coords against the actual cursor display every time the slide is
  shown.
- This fixes the "slide on wrong display, both still exist" case (the
  partially-fixed remainder from the recent display-switch sprint) without
  any IZUI changes.

**Files touched:**
- `features/slides/background.js`

**Exit criteria:**
- `yarn build` clean.
- Unit tests pass.
- Slides feature has zero references to `window.screen.width` or
  `window.screen.height`.

**Out of scope:** any other renderer that reads `window.screen` (track as
followup if found).

---

### Phase 5 — `tile-ipc.ts` v2 positioning consolidation

**Scope:**
- Replace the position-computation calls in `tile-ipc.ts` (audit identified
  lines ~2884–2891, ~2919–2926, ~3344) with `computePlacement`.
- `createTileBrowserWindow` and friends should populate `placement` on the
  registered tile params so reuse + display-watcher see consistent data for
  v2 tiles.

**Files touched:**
- `backend/electron/tile-ipc.ts`

**Exit criteria:**
- `yarn build` clean.
- Unit tests pass.
- No remaining direct `screen.*` position calls in `tile-ipc.ts`.

**Out of scope:** anything that's not v2 tile positioning.

---

### Phase 6 — Final sweep + sprint validation

**Scope:**
- Full unit test run (`yarn test:unit`).
- Full Playwright run (`yarn test:electron:bg`) — first time we run e2e for
  the sprint.
- Manual multi-display repro: cmd panel re-center, page-host stranded
  rescue, slides on cursor display, slides re-anchor on display change.
- Fix any regressions surfaced; do NOT add new features.
- Mark `docs/tasks.md` entries 32 + 33 (page-host display switch / slides
  anchor) as fully resolved.
- Add a one-paragraph "Window placement" section to `docs/architecture.md`
  pointing at `window-placement.ts` as the canonical source of truth.

**Files touched:**
- `docs/tasks.md`
- `docs/architecture.md`
- whatever needs fixing from validation

**Exit criteria:**
- All tests green.
- Multi-display manual repros pass.
- Sprint ready to ship as a single rebase onto main.

---

## Test strategy

The point of this sprint is to make display-switch behavior testable in unit
tests, with no real screens involved. Phase 1's `fakeDisplays(...)` helper
is the lever:

```ts
function fakeDisplays(specs: Array<{ id: number; x: number; y: number; w: number; h: number; primary?: boolean }>): Display[]
```

Pass synthetic display arrays + cursor points into `computePlacement` and
assert the result. Every regression we've shipped in this area would have
been a single failing unit test:

- "External monitor unplugged, cmd panel still on the laptop screen but at old
  external coordinates" → `computePlacement({ placement: { mode: 'centered' }, currentBounds: <on missing display>, displays: [laptopOnly], cursorPoint: laptop.center })`
  → expect `reposition` to laptop center.
- "Slide opened, user moves to second display, slide stays on first" →
  `computePlacement({ placement: { mode: 'edge', edge: 'top' }, currentBounds: <top of A>, displays: [A, B], cursorPoint: B.center })`
  → expect `reposition` to top of B.

After Phase 6, the in-place test file should have ≥20 cases covering every
mode + every realistic display-change scenario.

---

## Risk register

- **Session restore.** Restored windows currently flow through the same
  window-open path. Phase 2 has to derive `placement` for restored windows
  too. Risk: a restored cmd panel without `center: true` in saved options
  comes back as `manual`. Mitigation: window-open path's `placement`
  derivation runs even on restore — the restore caller still passes the
  appropriate flags.

- **Tests can't catch macOS native window migration.** When a display is
  unplugged, macOS itself moves windows; that happens before our code runs.
  Phase 1's pure function can't simulate that. Phase 6 manual repro is the
  only check — accept this gap and document it.

- **`tile-ipc.ts` is large and has its own quirks.** Phase 5 may surface
  v2-tile-specific assumptions (e.g., trustedBuiltin tokens minted before
  bounds are computed). Keep Phase 5 isolated so it can be reverted without
  losing Phases 1–4.

- **Phase 3 deletes `isWindowAccessibleNow` and `repositionOnCursorDisplay`.**
  These were just added in the most recent fixes. Confirm via grep that no
  call site outside `ipc.ts` imports them before deleting.

---

## What this prevents

Every regression that has shipped in this area in recent months:

1. cmd panel staying on disconnected external monitor → caught by the
   `centered` + stranded test.
2. Page-host opening on wrong display after primary swap → caught by the
   `cursor-display-fallback` + stranded test.
3. Slides anchoring to stale `window.screen` coords → can't happen; renderer
   no longer does the math (Phase 4).
4. Display-watcher only rescuing <30%-overlap orphans → replaced by per-window
   `computePlacement` pass that respects each window's intent.

Future regressions in this area become single failing unit tests.
