# Page-host state machine — design

*Historical: a design for a state machine inside the canvas page-host renderer, which no longer exists; not current guidance.*

**Status:** draft for review  
**Date:** 2026-04-27  
**Failing repro:** `tests/desktop/session-restore-page-host.spec.ts` — _maximized page host: maximize state survives save+restore_

---

## Why

`app/page/page.js` is the canvas page-host renderer. Today it manages window state with a swarm of module-scoped `let` variables and ad-hoc setters:

```
isMaximized          isDragging              webviewHoldReady
extraWidth           pageMouseButtonDown     webviewMouseDown
preMaximizeBounds    preMaximizeWindowBounds dragStartScreenX/Y/...
pendingBoundsUpdate  screenBounds            ...
```

There is no single answer to _"what state is this window in right now?"_. The CSS layer reads `body.classList.contains('maximized')`, the JS layer reads `isMaximized`, the OS layer reads `BrowserWindow.getBounds()`, and session-save reads URL params — and these four can drift out of sync. The user-reported regression is exactly that drift: a maximized page-host saved and restored has `body.maximized=false`, no `maximized=1` URL param, visible resize handles, and an OS window sized to the work area. JS thinks it is windowed; everything else thinks it is something else.

Additional smells the current design produces:

- **Restore loses state.** `window-open` regenerates the page-host URL from scratch and drops the `maximized=1` param.
- **Init does not derive state.** Page.js boots into NORMAL regardless of whether the just-loaded URL describes a maximized layout.
- **Bounds math is fragile.** `computeWindowBounds` mixes `extraWidth` (panels) into the OS window, so a save based on OS bounds + fixed-margin subtraction over-counts whenever a panel is open. The recent undo-close fix worked around this by reading URL params; the restore path has the same shape and a similar fix would just be another patch on top of the same model.
- **No explicit transitions.** `toggleMaximize` is the only function that flips `isMaximized` _and_ updates the body class _and_ recomputes screenBounds _and_ persists the URL param. Anything else that wants to enter maximized mode (e.g. session restore) would have to duplicate every step.

The FSM model lets us encode the transitions in one place, so any code path that wants to enter MAXIMIZED takes the same edge.

---

## States

```
INITIALIZING ──▶ NORMAL ◀─────▶ MAXIMIZED
                  │ ▲             │ ▲
                  │ │             │ │
                  ▼ │             ▼ │
                DRAGGING        DRAGGING_OUT_OF_MAXIMIZED
                  │ ▲             │
                  │ │             │ (drag exit
                  ▼ │              ▼  re-enters NORMAL,
                RESIZING            never MAXIMIZED)
```

| State | Meaning | Resize handles | Body class |
|-------|---------|----------------|------------|
| `INITIALIZING` | Page-host module loaded; URL params parsed; reading initial state | hidden | none |
| `NORMAL` | Default windowed state | visible | none |
| `MAXIMIZED` | Filled to display work area; OS window == webview | hidden | `maximized` |
| `DRAGGING` | Mouse-driven move from `NORMAL` | hidden during drag | `dragging` |
| `RESIZING` | Pointer-captured resize from `NORMAL` | active handle visible | `resizing` |
| `DRAGGING_OUT_OF_MAXIMIZED` | User dragged a maximized window — bounds restored to pre-maximize, drag continues | hidden | `dragging` |

INITIALIZING is the only state with two possible exits: **NORMAL** (default) or **MAXIMIZED** (if init inputs say so — see [Restoration inputs](#restoration-inputs)).

---

## Transition table

| From | Event | To | Side effects |
|------|-------|-----|---------------|
| `INITIALIZING` | `init.complete` (no maximize hint) | `NORMAL` | `updatePositions()` |
| `INITIALIZING` | `init.complete` (maximize hint) | `MAXIMIZED` | `updatePositions()` (in maximized layout); body class set; resize handles hidden; **no setBounds** (window-open already sized the window to work area) |
| `NORMAL` | `user.toggleMaximize` | `MAXIMIZED` | capture `preMaximizeBounds` + `preMaximizeWindowBounds`; set screenBounds = workArea; setBounds(workArea); body class added; URL param `maximized=1` written |
| `NORMAL` | `user.dragStart` (navbar / hold) | `DRAGGING` | drag overlay shown; cursor set |
| `NORMAL` | `user.resizeStart` (handle) | `RESIZING` | pointer capture; webview opacity reduced |
| `MAXIMIZED` | `user.toggleMaximize` | `NORMAL` | restore `preMaximizeWindowBounds` directly; setBounds; body class removed; URL param removed |
| `MAXIMIZED` | `user.dragStart` (navbar) | `DRAGGING_OUT_OF_MAXIMIZED` | restore screenBounds + window to `preMaximizeBounds` re-centered on cursor; body class removed |
| `DRAGGING` | `user.dragMove` | `DRAGGING` (self-loop) | `setBounds(computeWindowBounds(screenBounds))` |
| `DRAGGING` | `user.dragEnd` | `NORMAL` | drag overlay hidden; URL params updated |
| `DRAGGING_OUT_OF_MAXIMIZED` | `user.dragMove` | `DRAGGING_OUT_OF_MAXIMIZED` (self-loop) | same as `DRAGGING` |
| `DRAGGING_OUT_OF_MAXIMIZED` | `user.dragEnd` | `NORMAL` | same as `DRAGGING` |
| `RESIZING` | `user.resizeMove` | `RESIZING` (self-loop) | `setWindowBounds` (rAF-throttled) |
| `RESIZING` | `user.resizeEnd` | `NORMAL` | pointer release; URL params updated |

Any non-listed transition is illegal; the FSM should `console.warn` and ignore (or in dev, throw).

---

## Restoration inputs

The page-host's "what state am I in?" decision at INITIALIZING reads from three sources:

1. **URL params on the loaded page-host URL.** Today: `x`, `y`, `width`, `height`. After this work: also `maximized` (`'1'` or absent).
2. **OS BrowserWindow bounds.** What `window-open` actually sized the window to.
3. **Display work area** (via `api.window.getDisplayInfo`) — the canonical "what does maximized mean for this display right now?".

The init transition uses input #1. If `maximized=1` is present, transition to MAXIMIZED — but trust that `window-open` has already sized the window to the work area. If absent, transition to NORMAL.

This section describes the canvas-era design. Superseded: maximize is not restored. Session save and undo-close write the window's pre-maximize bounds and no `maximized` flag, and restore opens the window unmaximized at those bounds, because a window manager may refit a window mapped at full work-area size and restoring at the normal size avoids a stale maximized flag. Descriptors and closed-window entries from older builds that carry `maximized` are converted to the same result on restore. The propagation steps below (saving the flag, passing `maximized` through `window-open`, carrying it through `pushClosedWindow`) are therefore not implemented.

For the inputs to actually reach init, two upstream changes were originally planned:

- **Session save** persists the `maximized` flag (today it drops it via `extractRealUrl` + `extractCanvasBounds`). Add it to the `WindowDescriptor.params` payload.
- **`window-open`** propagates `maximized` to the page-host URL params it constructs in `ipc.ts:956`. Today the `pageParams` URLSearchParams is built from `{url, x, y, width, height}` only. Add `maximized` if `options.maximized === true`.
- **Session restore** passes `maximized: true` in `options` when the descriptor's saved params include it.

For undo-close (`reopenLastClosedWindow`) the same propagation was planned — the URL param + `pushClosedWindow` payload carrying `maximized` through.

---

## What this replaces

| Replaced thing | Replaced with |
|----------------|---------------|
| Bare `let isMaximized = false` | `state === 'MAXIMIZED'` |
| `let isDragging = false` + `pageMouseButtonDown` | `state === 'DRAGGING'` or `'DRAGGING_OUT_OF_MAXIMIZED'` |
| Direct `document.body.classList.add/remove` calls scattered across `toggleMaximize`/drag/resize | A single `applyState(newState, prevState)` that owns body class + handle visibility |
| `extractCanvasBounds` reading only x/y/w/h | Same function reads the maximized flag too; `WindowDescriptor.params.maximized` carries it |
| `window-open`'s `pageParams` losing maximize | `pageParams` propagates `maximized` if `options.maximized === true` |

The state machine is intentionally pure-renderer: it lives in `app/page/page-fsm.js`, has no IPC dependencies, takes events in and emits side-effect descriptors out (`{ setBounds: { ... } }`, `{ setBodyClass: 'maximized' }`, etc.). The runtime in `page.js` is the only thing that calls into IPC; the FSM stays trivially testable with `node:test`.

Mirror of `docs/cmd-state-machine.md` — same separation: pure FSM module, runtime adapter, unit tests for the FSM, Playwright tests for the integration.

---

## Implementation order

1. **Land the failing repro** (already done): `tests/desktop/session-restore-page-host.spec.ts:163`.
2. **Extract the FSM module** (`app/page/page-fsm.js`) with the states + transition table above. No DOM, no IPC. Unit tests in `tests/unit/page-fsm.test.js` cover every legal edge + a "no illegal transitions" property.
3. **Wire page.js to the FSM.** Replace each module-scoped `let` with FSM state queries; route every body-class write through one `applyState` function.
4. **Add `maximized` propagation through the four pinch points:** `updateUrlParams` (already done), `extractCanvasBounds` (read maximized too), `WindowDescriptor` save, `window-open`'s `pageParams` construction, undo-close's saveBounds path.
5. **Make INITIALIZING transition read the URL param** and enter MAXIMIZED if set.
6. **Verify the failing spec now passes** + no regressions in the existing 5/5 reopen-closed-window suite.

---

## Open questions

- Should `MAXIMIZED → DRAGGING_OUT_OF_MAXIMIZED` actually be `MAXIMIZED → NORMAL → DRAGGING`? Conceptually cleaner but means an extra transition and an intermediate `applyState` flush — risk of visual jitter. I lean toward keeping the dedicated state because `preMaximizeBounds` re-centering on cursor is its own behavior.
- `extraWidth` (side-panel padding) doesn't fit cleanly as a state — it's an additive width. Keep it as a numeric attribute on the FSM (`state.extraWidth`) rather than a state. Same for `screenBounds`.
- Should resize-from-maximized be supported (auto-exit maximize on grab)? Today it isn't (handles are hidden when maximized); keep that behavior for now.

---

## Related

- Inspiration: `docs/cmd-state-machine.md` (cmd-panel FSM, same "pure module + runtime adapter" shape)
- Inspiration: `docs/pubsub-state-machine.md` (pubsub FSM, same "single source of truth" framing)
- Memory: `feedback_no_sleep_in_tests_or_code.md` — every transition in the FSM should fire on a deterministic event, no debounce/throttle except where the timeout _is_ the feature (rAF for resize, debounce for navbar hide)
