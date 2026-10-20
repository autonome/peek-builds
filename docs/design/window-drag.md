# Hold-to-drag window move

Click and hold still on a window for the `dragHoldDelay` pref (seconds,
default 1), the cursor turns into an open hand, then moving the pointer moves
the window. Moving before the hold elapses cancels it, so clicks, text
selection and link drags are untouched. The gesture is owned by the main
process and serves every registered window the same way — page hosts (pages,
peeks, slides, quick view), their shared chrome overlay, and tile windows —
whether or not the window was focused when the press landed.

## Pieces

| Piece | File | What it is |
|---|---|---|
| State machine | `main/window-drag.ts stepWindowDrag()` | Pure: state + event → state + effects. No timers, no Electron. |
| Runtime | `main/window-drag-runtime.ts` | Holds the one live state, runs the hold timer, resolves which window a press moves, executes effects through injected deps. |
| Input | `main/electron-window-backend.ts wirePointerInput()` | Backend effect: every registered window's webContents `input-event` stream (left press / move / release, screen coordinates) and its press-blocked message, fed to the runtime keyed by the window's id. |
| Indicator | `main/webcontents-cursor.ts setWebContentsCursor()` | Backend effect: one CSS rule inserted into a webContents (`cursor`, plus `user-select:none` while a drag is armed). The page-host edge-resize hover cursor uses the same per-webContents reconciler, so a webContents never carries two cursor rules. |
| Mover | `kernelSetBounds` | Every move step is a kernel `SetBounds`, the same path every other geometry write takes. |
| Wiring | `main/window-machine.ts initWindowStateMachine()` | Builds the runtime deps from the kernel state, the backend and pubsub. |

The state machine sits above the window port; input and cursor painting are
backend effects, so another backend supplies the same three events and paints
the indicator its own way.

## States

`idle` → press → `pending` (hold timer running) → hold elapsed → `ready`
(open-hand cursor) → move past `MOVE_THRESHOLD_PX` → `dragging`
(closed-hand cursor, window follows the pointer 1:1 from the press point).

- A move past `HOLD_TOLERANCE_PX` while `pending` cancels.
- A press always ends whatever came before it: a release the OS delivered
  elsewhere must not leave a stale gesture armed.
- Release, a move reporting no held button (once `ready` or `dragging`), or the
  source or target window closing ends the gesture. While `pending`, a move
  reporting no held button is ignored — the OS synthesises those when a window
  frame moves under a still pointer.
- A veto for the press's own window cancels a gesture that has not started
  moving the window.

## Which window a press moves

The press lands in a window (the source). The target is the window the source
is chrome for (`WindowRecord.overlayFor`), else the source itself. So a press
on the page chrome moves the page under it, and a press on page content moves
that page — even when it was unfocused and the chrome overlay is still over
another page. A press arms only when the target is visible, not maximized and
not fullscreen; the same checks run again when the hold elapses, and the
target's bounds are read then, so a resize between press and hold is kept.

A press on an inactive window counts only if it reaches that window's
webContents. On macOS the press that activates a window is swallowed into the
activation unless the window accepts the first mouse, so page hosts
(`ipc.ts createHybridHostBaseWindow()`), windows from the window-open path and
tile windows (`tile-launcher.ts createTileBrowserWindow()`) are constructed
with `acceptFirstMouse: true` (guarded by `window-construction-gate.test.ts`).
The side effect: the activating click also clicks the content under it, as it
does on every other platform.

## What blocks a press

Blockers are facts only the renderer knows (which element is under the
pointer). Each is reported the same way: the window's preload sends one
`window-drag:press-blocked` message on a capture-phase `mousedown` it judges
not draggable, and the runtime vetoes the pending press for that window. The
judgement (`tile-preload.cts`, "Press blockers"):

- the press is inside an element carrying `data-no-drag` (including `<body>`,
  which opts the whole window out),
- the press is on the text field or contenteditable being edited: it has focus
  and the user typed in it, or placed the caret or a selection in it with a
  completed click, since it took focus (shadow-DOM aware, so the navbar URL
  field counts). Focus alone is not editing: a field focused by Cmd+L or
  autofocus, or left focused while its window was in the background, still
  drags on hold. Focus moving elsewhere or the window losing focus ends the
  edit,
- the press is inside the current page-text selection (that press starts a
  selection drag); a text field's own selection is covered by the rule above.

Web pages in page hosts load no preload, so a press on page content is never
vetoed; only moving before the hold elapses cancels there.

Another main-side gesture that owns a press — the page-host edge resize —
calls `claimWindowPress(id)`; the claim works whichever `input-event` listener
runs first.

The veto travels over IPC and lands after the press, so it races the hold
timer only when `dragHoldDelay` is 0.

## Clicks after a drag

A window drag keeps the pointer over the same element, so its release would
synthesise a click. The preload swallows a click whose press and release
differ in screen position by more than they differ in window position — the
window moved under the pointer — without any message from main.

## The chrome overlay during a drag

The runtime publishes `window:drag-active {active}` from the press that arms a
gesture until the gesture ends, so for every click as well as every drag. While
it is set the overlay freezes its click-through state, as it does for an edge
resize (flipping it mid-drag would take the pointer stream away from the
webContents the press landed in), and the chrome does not hide: hover-leave and
load-settled hides wait for the gesture to end, so the chrome stays put for the
whole press-and-hold and drag. The overlay's cached host bounds keep
following through `publishHostBoundsOnChange()`; the overlay still needs them
for maximize and panel positioning.
