# Window Placement — Spec

**Status:** canonical. Supersedes the model in
[`window-placement-refactor.md`](./window-placement-refactor.md), which is
retained as historical sprint planning.

**Scope:** core window-manager behavior. Platform-agnostic spec; current
implementation is Electron (`apps/desktop/main/window-placement.ts`), with a
Tauri port to follow against the same contract.

---

## Principles

1. **Intent is the source of truth. Bounds are a derived projection.** A
   window's position is computed from its placement intent + the live display
   layout, never read back as authoritative state.
2. **Every consumer goes through one pure function.** Open, reuse, drag,
   display-change, restore — all call the same `project()`. No call site
   computes its own bounds.
3. **No debounced mutation that can race with user input.** Display changes
   project synchronously on add/remove. Idempotent: projecting N times in a
   row produces the same bounds.
4. **Cursor position is never consulted.** "Where the user is" is decided by
   OS-level primary-display setting (the menu-bar screen on macOS), which is
   stable, user-controlled, and racefree.
5. **All modes recompute against live display state on every consume.**
   Restart-vs-no-restart never changes behavior.

---

## The `Placement` type

```ts
type Placement =
  | { mode: 'centered' }
  | { mode: 'edge', edge: 'top' | 'bottom' | 'left' | 'right' }
  | { mode: 'proportional', relX: number, relY: number }
  | { mode: 'parent-centered', parentId: WindowId };
```

Four modes, no others. Intent is assigned once at window-open time and only
mutates via the explicit rules in §"Drag / resize updates" below.

### Mode semantics

| Mode | Use cases | What `project()` does |
|---|---|---|
| `centered` | peeks, cmd panel, modal palettes | Center the window on its **chosen display** (see §"Display selection"). |
| `edge` | slides | Anchor to the named edge of its chosen display. The non-anchored axis is centered along that edge. |
| `proportional` | user-positioned content windows | Place top-left at `(relX × freeSpaceX, relY × freeSpaceY)` of its chosen display, where `freeSpaceX = display.workArea.width − windowSize.width`. |
| `parent-centered` | child popups | Center the window on the parent's bounds. |

### Why no `manual` and no `cursor-display-fallback`

Both were "absolute pixels by another name." A window with `manual` placement
and saved bounds (1920, 100) means nothing on a system whose external monitor
has been unplugged. `proportional` carries the same user-positioned semantics
in a form that survives display change.

`cursor-display-fallback` is decomposed: at open time, project the requested
position into proportional `(relX, relY)` and persist that. There is no
"deferred decision to the cursor" anywhere in the system.

---

## Proportional semantics in detail

`relX, relY ∈ [0, 1]` are the window's top-left expressed as a fraction of
**free space**, not a fraction of display width. Free space is the portion of
the workArea where the top-left of a window of size `windowSize` can be placed
without clipping.

```
freeSpaceX = max(0, display.workArea.width  − windowSize.width)
freeSpaceY = max(0, display.workArea.height − windowSize.height)

x = display.workArea.x + relX × freeSpaceX
y = display.workArea.y + relY × freeSpaceY
```

This makes the corners and center exact:

| Position on display | `(relX, relY)` |
|---|---|
| Flush top-left | `(0, 0)` |
| Centered | `(0.5, 0.5)` |
| Flush top-right | `(1, 0)` |
| Flush bottom-right | `(1, 1)` |

A window with `(0.95, 0.05)` is in the top-right corner of any display that
is large enough to contain `windowSize`, regardless of display dimensions.

**On windows larger than the display:** `freeSpace` clamps to 0, the projection
returns the workArea origin, and `windowSize` is clamped to the workArea —
oversized windows shrink to fit. They never overflow the display, never fail
projection.

---

## The projection contract

```ts
project(
  placement: Placement,
  windowSize: { width: number; height: number },
  displays: Display[],
  primaryDisplayId: DisplayId,
  currentBounds?: Rectangle,   // optional; only used to pick "own current display"
  parentBounds?: Rectangle,    // required for parent-centered
): Rectangle
```

**Pure.** No platform API calls inside. The caller obtains `displays`,
`primaryDisplayId`, and `parentBounds` and passes them in. This is what makes
the function unit-testable across synthetic display layouts without real
multi-monitor hardware.

**Total.** Always returns a valid `Rectangle` clamped to some display's
workArea. Never returns "no-change" — the caller compares against
`currentBounds` if it cares about skipping a redundant `setBounds` call.

**Idempotent.** `project(p, ws, d, pid)` ≡ `project(p, ws, d, pid)`.

---

## Display selection

Each mode picks which display its bounds are computed against:

| Mode | Display picked | Fallback |
|---|---|---|
| `centered` | own current display (the one whose workArea contains the window's center, derived from `currentBounds`). If no `currentBounds`, **primary**. | **primary** |
| `edge` | own current display | **primary** |
| `proportional` | own current display | **primary** |
| `parent-centered` | parent's display (workArea containing the parent's center) | **primary** |

**Open-time disambiguation.** When a window is being created and has no
`currentBounds` yet, the chosen display is **primary**. macOS: the menu-bar
screen. Windows: `MONITORINFOF_PRIMARY`. Linux/X11: the screen with `_NET_WM_DESKTOP`'s
primary marker. The platform binding wraps each.

**Why not "follow the cursor."** Cursor position is transient and can drift
between event handlers. Primary is a stable, OS-level user setting that says
"this is my main work surface." A peek opening on primary instead of "wherever
the mouse last drifted" is the desired UX.

---

## Drag / resize updates

The `set-bounds` IPC handler runs on every drag tick and every resize tick. It
writes both `windowSize` and (conditionally) `placement`:

```
on set-bounds(newBounds):
  registry[windowId].windowSize = { width: newBounds.width, height: newBounds.height }
  match registry[windowId].placement.mode:
    'proportional', undefined:
      d = displayContaining(newBounds.center) ?? primary
      freeSpaceX = max(0, d.workArea.width  − newBounds.width)
      freeSpaceY = max(0, d.workArea.height − newBounds.height)
      relX = freeSpaceX === 0 ? 0 : (newBounds.x − d.workArea.x) / freeSpaceX
      relY = freeSpaceY === 0 ? 0 : (newBounds.y − d.workArea.y) / freeSpaceY
      registry[windowId].placement = { mode: 'proportional', relX, relY }
    'centered', 'edge', 'parent-centered':
      // by-design modes: leave placement untouched.
      // The drag changed bounds for now, but the next consume re-projects.
```

**Per-mode resize behavior follows from these rules.**

- **`edge` (slides):** edge stays pinned. Resize from the non-anchored side
  changes `windowSize` only; placement is untouched and the next projection
  re-anchors at the same edge with the new size.
- **`centered` (peeks):** stays centered automatically. Resize → next projection
  centers the new size.
- **`proportional`:** during resize, `freeSpace` changes, so the projection
  the user is *looking at* matches their cursor — but the persisted `(relX,
  relY)` is recomputed against the new free space so the relative position
  encoded in intent still corresponds to "where the user just put it."
- **`parent-centered`:** resize re-centers on parent on next projection.

**A stray drag of an `edge` slide away from its edge** does not promote it to
proportional. Slides are edge-anchored by design; the next consume holds the
anchor.

---

## Display-change handler

Three platform events: `display-added`, `display-removed`,
`display-metrics-changed`.

```
on display-added | display-removed:
  // synchronous, no debounce. Idempotent: macOS may fire several events in
  // a row during a single switch; we project N times in a row, end at the
  // same bounds.
  for win in allVisibleWindows:
    bounds = project(win.placement, win.windowSize, currentDisplays(), primaryId(), win.currentBounds, parentBounds(win))
    if bounds != win.currentBounds:
      win.setBounds(bounds)

on display-metrics-changed:
  // coalesce only this event class. Resolution / scale / rotation changes
  // typically arrive in tight bursts that don't affect bounds materially.
  debounce 50ms, then run the same projection loop above.
```

**No-debounce on add/remove is the click-drag-snap fix.** Users could
previously click into a window during the 500ms debounce window and have a
deferred `setBounds` land mid-gesture. With synchronous projection, by the
time the user can react to a display change visually, the bounds are already
settled.

**No "stranded rescue" pass.** With proportional/centered/edge always
projecting onto a present display (own or primary), no window can end up
off-screen in the first place.

---

## Persistence

Snapshot (session save) writes `placement` as **primitives only**:

```
placementMode:  'centered' | 'edge' | 'proportional' | 'parent-centered'
placementEdge:  'top' | 'bottom' | 'left' | 'right'   // when mode='edge'
placementRelX:  number                                 // when mode='proportional'
placementRelY:  number                                 // when mode='proportional'
```

These primitives survive the params sanitizer and the IPC boundary on every
platform. On restore, the union is re-derived from these fields. Bounds in
the snapshot are advisory — they may seed `windowSize` but never override the
projected position.

`parentId` is not persisted: parent windows have ephemeral IDs across runs.
On restore, a `parent-centered` window collapses to `centered` (placed on
primary) until its real parent is re-established by user action.

**Legacy primitives** (`center: true`, `screenEdge`) from older snapshots are
read with reduced precedence — if `placementMode` is present, it wins; else
the legacy primitives are converted on read (`center: true` → `centered`,
`screenEdge: 'top'` → `edge: top`). Old `manual` snapshots (raw x/y) become
proportional via the same conversion the live drag handler uses.

---

## Open-time placement

The window-open path:

1. Caller passes options (intent flags, optional explicit `x/y`, `width/height`,
   `parentId`, etc.).
2. The handler maps options → `Placement`:
   - `screenEdge: 'top'` → `{ mode: 'edge', edge: 'top' }`
   - `center: true` → `{ mode: 'centered' }`
   - `parentId` set, no explicit x/y, parent is a real visible window →
     `{ mode: 'parent-centered', parentId }`
   - Explicit `x/y` provided → `{ mode: 'proportional', relX, relY }` where
     `(relX, relY)` is computed from the caller's `(x, y)` against primary's
     free space.
   - No flags, no x/y → `{ mode: 'proportional', relX: 0.5, relY: 0.5 }`
     (visually centered on primary, draggable into any sticky position later).
3. The handler calls `project(placement, windowSize, displays, primaryId)` to
   compute initial bounds and creates the window with those bounds.
4. The handler records `placement` and `windowSize` on the window registry.

---

## Test scenarios (regression suite)

Property-based / synthetic-display unit tests, run on every PR:

1. **Proportional cross-display projection round-trip is exact.** A window at
   `(relX, relY)` on display A projects to a position whose `(relX, relY)`
   recomputed on display B is the same `(relX, relY)`. (Modulo rounding ≤ 1
   px.)
2. **Resize then display-swap preserves relative position.** Window at
   `(0.95, 0.05)` on display A. Resize to a new `windowSize`. Swap to display
   B. Final position is top-right of B at the new size.
3. **Edge slide stays edge-anchored across save → topology change → restore.**
   Save a `top`-edge slide on the external. Remove the external. Restore.
   Slide projects to the top edge of primary.
4. **Edge slide stays edge-anchored across live display change (no restart).**
   Same as (3) without restart.
5. **Peek stays centered across both paths in (3) and (4).**
6. **Primary display changed while window open.** OS primary changes (user
   reassigns menu bar to a different screen). Windows re-project against the
   new primary's free space; relative position preserved.
7. **No-debounce property.** Synthetic display-change event fires while a
   synthetic "drag" is in flight (set-bounds calls interleaved). Final bounds
   match the drag's last-written position. No mid-drag jump.
8. **Stranded-by-construction.** No mode ever produces bounds outside any
   display's workArea, even with a `windowSize` larger than every display.
   (`windowSize` clamps to workArea; placement origin clamps to workArea
   origin.)

---

## Platform binding

The placement engine is pure. Each platform supplies:

| Hook | Electron | Tauri (planned) |
|---|---|---|
| Get all displays | `screen.getAllDisplays()` | `tauri::Manager::available_monitors()` |
| Get primary display | `screen.getPrimaryDisplay()` | `tauri::Manager::primary_monitor()` |
| Listen for display events | `screen.on('display-added' \| 'display-removed' \| 'display-metrics-changed')` | OS platform listener (NSScreenDidChange / WM_DISPLAYCHANGE / Wayland output events), proxied to Tauri main |
| Apply bounds | `BrowserWindow.setBounds()` | `WebviewWindow::set_position` + `set_size` |
| Read window bounds | `BrowserWindow.getBounds()` | `WebviewWindow::outer_position` + `outer_size` |
| Set-bounds IPC channel | `tile:window:set-bounds` | equivalent Tauri command |

The pure module (`window-placement.ts` and its Tauri-side equivalent) does
not depend on any of these — only on the data they produce. Spec compliance
is verified by the synthetic-display test suite running on each platform's
binding code.

---

## Anti-patterns (what NOT to do)

- **Storing raw px as authoritative position.** Always store intent. Bounds
  are a view onto intent.
- **Reading cursor position to decide placement.** Use primary instead.
- **Debouncing display-add / display-remove.** Synchronous only. The
  projection is idempotent, debounce buys nothing and costs the snap race.
- **Adding a new placement mode without updating `project()`.** The mode is
  not real until `project()` handles it.
- **Bypassing `project()` from a call site to compute bounds locally.** Every
  bounds-setting call site routes through `project()`. CI/lint check enforces
  this on `setBounds`/`setPosition` outside the placement module.
- **Using `manual` mode anywhere.** It does not exist in this spec.
