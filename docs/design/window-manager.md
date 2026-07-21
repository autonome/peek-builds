# The Window Manager

Status: **mandate.** This document is directive, not exploratory. It is not a menu of
options and not a record of a discussion. It states what the system must become and what
is forbidden on the way there.

---

## 1. The mandate

> "Make it one single deterministic system that is a Window Manager. We are making a
> window manager. Nothing outside of it makes actual Electron/OS window stuff happen.
> Also inside of it, Electron should be abstracted so we can port to Tauri or ElectroBun
> or Swift or whatever."
>
> — operator, 2026-07-20

Three rules follow from that. They are numbered because the rest of this document, and
every future change to window behavior, refers back to them.

### R1 — ONE owner decides all window state

A single pure reducer decides everything: which window is front, whether that intent has
been asserted onto the OS, what Escape does, what is fullscreen, what is visible, what is
stacked where, what gets restored at cold start. It is a pure function — dependency-free,
no imports, no I/O, no clock, no platform. It takes an event and a state and returns a
state plus a list of effects. It is exhaustively unit-testable without launching anything.

There is no second decider. Not a "small local decision," not a "just this one case,"
not a helper that "only handles the overlay." If code needs a window decision made, the
reducer makes it.

### R2 — ONE executor performs OS window operations

Exactly one module turns effects into real window operations. Nothing outside it calls a
window API. Not `focus`, `show`, `showInactive`, `hide`, `close`, `destroy`, `setBounds`,
`moveTop`, `setAlwaysOnTop`, `setFullScreen`, `setVisibleOnAllWorkspaces`, `maximize`,
`unmaximize`, `minimize`, `restore`, `blur`, `setSkipTaskbar`, `webContents.focus()`, or
any successor API in any successor toolkit.

Code that wants a window to change **dispatches an event**. It does not perform the
change and then inform anybody. It does not perform the change instead of informing
anybody. It dispatches, and the reducer decides whether and how the OS moves.

**R2 is enforced by a mechanical grep check in CI. A violation is a build failure, not a
review comment.** This is the rule every previous attempt lacked, and its absence is why
every previous attempt failed. An architecture that depends on contributors remembering a
document is an architecture that decays at the rate people forget. The check must run in
the same gate that runs the tests, must list the forbidden call names explicitly, and must
allow exactly one exempt file — the executor — plus a small, individually-justified,
comment-annotated carve-out list that only shrinks.

### R3 — The executor talks to a BACKEND PORT, not to Electron

The executor does not import Electron. It calls a `WindowBackend` interface. Electron is
one implementation of that interface (`ElectronWindowBackend`), and it is the only place
in the entire window manager where the word `electron` appears.

No Electron type crosses into the owner. The owner must compile, and its unit tests must
run, with **zero platform imports** — that is the mechanical test of R3, and it is
checkable the same way R2 is: if `window-state.ts` ever grows an import, R3 is broken.

---

## 2. Why this keeps failing

This has been attempted repeatedly, over months and years, and it keeps collapsing back
into poorly-architected disjoint chaos. IZUI was supposed to be this system. It did not
become it.

The reason is specific and it is not "we ran out of time."

**Every prior attempt introduced a NEW authority ALONGSIDE the existing ones instead of
DELETING them.** Each refactor was additive. Each one shipped a cleaner model, wired it up
next to the old paths, and left the old paths running — because deleting them was risky,
or out of scope, or "a follow-up." The follow-up never came, and the new clean model became
the Nth rival authority rather than the one authority.

The evidence is countable, from a full survey of `apps/desktop/main/`:

- **Three separate copies of "is the app active"** — the reducer's `appActive` in
  `window-state.ts`, `izui-state.ts`'s `appFocused`, and `hybrid-overlay.ts`'s own module
  `appActive` let. Three beliefs, three update paths, no reconciliation.
- **14 per-window registries**, spread across **3 mutually-incompatible id spaces**
  (Electron window ids, Electron webContents ids, and synthetic ids). *(The synthetic
  space has since been deleted — §5 step 1.)*
- **32 module-level mutable window-state variables** (42 if you count the timing latches),
  each one a piece of window state that no owner owns.
- **11 decision sites that query Electron live** instead of holding state — asking the OS
  a question at decision time, which is precisely how belief and reality diverge.

Fragmentation on this scale is not an accident of rushed work. It is the *predictable
output* of additive refactoring. You cannot get to one authority by adding a better one.

Therefore the mandate is enforced as a **deletion rule with a mechanical check**, not as an
architecture diagram and not as a convention anyone has to remember:

> **Every step of this migration DELETES the authority it replaces, in the same commit
> that introduces the replacement.** A step that leaves the old path running has not been
> completed; it has been *skipped while appearing done*. Grep for the old symbol name
> before calling any step finished. Source control is the backstop that makes deletion
> safe — deleting committed code is not lossy.

---

## 3. The backend port (R3)

### Shape

`WindowBackend` is a narrow **command + event** interface. Two halves:

**Outbound — commands the executor issues.** Roughly:

| Command | Meaning |
|---|---|
| `create(spec) -> WindowId` | Realize a window from a platform-neutral spec |
| `destroy(id)` | Tear it down |
| `show(id, { activate })` | Make visible, optionally taking key |
| `hide(id)` | Remove from screen, keep alive |
| `focus(id)` | Make key / make first responder |
| `focusContent(id)` | Make the content surface first responder (the hybrid-host case) |
| `setBounds(id, rect)` | Position and size |
| `setStacking(id, level)` | Raise/lower relative to siblings; the `moveTop` replacement |
| `setAlwaysOnTop(id, on, level?)` | The HUD / chrome-overlay class |
| `setFullScreen(id, on)` | Native fullscreen |
| `setVisibleOnAllWorkspaces(id, on)` | macOS Spaces |
| `loadContent(id, source)` | Attach or navigate content |

**Inbound — events the backend emits.** The backend pushes; the owner never pulls:

`focusGained` · `focusLost` · `shown` · `hidden` · `closed` · `fullscreenEntered` ·
`fullscreenLeft` · `boundsChanged` · `displayChanged` · `appActivated` · `appResigned` ·
`spaceChanged`.

### Constraints — these are the point, not decoration

**The port is COMMAND + EVENT, never QUERY.** There is no `isVisible()`, no
`getBounds()`, no `isMaximized()`, no `isAlwaysOnTop()`, no `getFocusedWindow()`. The
owner must never ask the OS a question at decision time. Live queries are exactly how
belief and reality diverge, and the survey found 11 sites already doing it. Any OS fact the
system needs **arrives as an event and is stored in the reducer.** If a fact the system
needs has no event today, adding that event is the work — not adding a getter.

The existing code already admits this failure in its own comments: `closeOrHideWindow` and
`tile:window:hide` hand-dispatch `WINDOW_HIDDEN` because the OS event lags, and
`tile-ipc.ts tile:window:maximize` explicitly distrusts Electron's `isMaximized()` on
frameless macOS windows. Those are not quirks to work around; they are the reason the
query half of the boundary must not exist.

**No Electron types in the signature.** `BrowserWindow`, `BaseWindow`, `WebContents`,
`WebContentsView`, and Electron's `Rectangle` must not appear anywhere in the port. Use
plain structural types: `WindowId`, `Rect { x, y, width, height }`, `WindowSpec`,
`DisplayInfo`. The port is the seam that makes Tauri, ElectroBun, or a native Swift shell
a reimplementation rather than a rewrite.

**Window identity is an opaque WM-assigned id — LANDED** (commits 90becfc5, 5d760baf,
04d2eb94; minting moved with the port, 84ce45b4). `WindowId` is an opaque branded string
(`"wm-N"`), minted in exactly one place — `electron-window-backend.ts registerWindow()` —
idempotent per native window, returning the existing id on re-registration. The backend is
the **sole** `WindowId` ↔ Electron mapper — a private `idByOsWindowId` reverse map; no
other module translates. The reducer (`window-state.ts`), the executor
(`window-os-adapter.ts`), and the singleton (`window-state-singleton.ts`) are re-keyed to
`WindowId`, and `webview-guest-registry.ts guestToHost` now holds `WindowId` values.

When this document was written there were **three colliding id spaces**: Electron window
ids (`windowRegistry`, `WindowRecord`, most of `main.ts`), Electron webContents ids
(numerically indistinguishable from window ids, so a mix-up is silent), and synthetic ids
from `window-registry.ts nextSyntheticId`, counting **down** from
`Number.MAX_SAFE_INTEGER` specifically to avoid colliding with the other two. The
synthetic space is now **deleted, grep-zero** — `nextSyntheticId`, `refs`,
`registerPendingWindow`, `realize`, `getWindowRef`, and the `WindowRef` type are all gone
(they had no production producers). The other two numeric spaces survive only outside the
WM core:

**Deliberate scope decision — the renderer-facing id economy stays NUMERIC for now.** The
`tile-api.d.ts` window/context APIs, pubsub `windowId` payloads, the persisted
`datastore.ts windowContextState`, and the overlay focus protocol still speak numeric
Electron window ids. Conversion happens at the seams via `window-state-singleton.ts
getWindowIdFor()` / `getNativeWindowFor()`. Flipping that economy to `WindowId` is
**deferred to the session/context-store step**, not skipped.

A single WM-owned id space was a **precondition** for the port, not a later cleanup; it is
now in place. The backend maps `WindowId -> platform handle` internally and never leaks
the handle.

**First implementation — LANDED** (commit 84ce45b4): `electron-window-backend.ts
ElectronWindowBackend`. Portability targets that justify the shape: Tauri, ElectroBun,
native Swift.

---

## 4. The state model — all dimensions, one owner

Everything below is window management and belongs to the WM unless marked otherwise.
`OWNED TODAY` = already inside the reducer. `TO ABSORB` = must move in, deleting its
current authority. `OUT OF SCOPE` = genuinely not window management.

### 4.1 Identity and creation

**1a. Window identity / params** — ABSORBED (§5 step 4).
The `main.ts` module-level `windowRegistry` Map is deleted. The reducer's window table
(keyed by WM id, written only by reducer transitions) carries the `{source, params}`
payload, declared on the registration spec at the ipc.ts open sites (or merged later
via `WINDOW_PARAMS_SET` — the surviving `main.ts registerWindow` export). The old
accessors (`getWindowInfo` / `findWindowByKey` / `findWindowByUrl` / `getAllWindows` /
…) survive as a numeric-Electron-id seam over machine state with identical
membership: records without a payload (tiles, bridge/background/test-fixture/devtools)
stay invisible to them, exactly as they were absent from the Map. `params` is stored
BY REFERENCE and legacy consumers still mutate it in place (`params.currentUrl`,
`tile:window` bounds writes) — the reducer never reads inside it; collapsing those
in-place writes is later-step work (geometry §5 step 7, session §5 step 11).

**1b. New-window-vs-reuse dedup** — TO ABSORB.
Today: not held anywhere; recomputed on every open from **two parallel dedup ladders**
(the hybrid registry and `windowRegistry`) plus `ipc.ts pendingWindowKeys`. Every reuse
branch calls show/focus directly — a straight R2 violation, repeated four times.
Becomes: a dedup key index in reducer state; open requests dispatch an intent event and the
reducer answers reuse-or-create.

**12. Pending / unrealized windows** — DONE, by deletion rather than absorption.
The synthetic-id machinery (`window-registry.ts refs`, `nextSyntheticId`,
`registerPendingWindow`, `realize`, `getWindowRef`, the `WindowRef` type) is deleted,
grep-zero — it had no production producers. If pending windows return, they get an
ordinary `WindowId` and a `pending` lifecycle phase on the reducer window record — same id
space, never a separate synthetic range.

### 4.2 Geometry

**2. Geometry / bounds / maximize** — TO ABSORB. *(Top divergence risk #1.)*
Today: split three ways — live Electron `getBounds()`, `windowRegistry.params`
`preMaxX/Y/W/H`, and `hybrid-page-host-registry.ts InternalEntry.maximized` /
`preMaxBounds`. `tile-ipc.ts tile:window:maximize` explicitly distrusts Electron's
`isMaximized()` on frameless macOS windows.
Becomes: `bounds` + `maximized` + `preMaxBounds` fields per window record, updated solely
by the `boundsChanged` event; maximize is a reducer transition, never an OS question.

**2b. Placement intent** — OWNED, KEEP AS IS.
`window-placement.ts computePlacement` is already pure and genuinely well-owned. It becomes
a pure helper the reducer calls. Do not rewrite it.

**7. Multi-display** — TO ABSORB (partial).
Today: `display-watcher.ts` is well-structured, but it reprojects bounds by calling
`setBounds()` directly and never tells the reducer.
Becomes: it emits `displayChanged` into the reducer; the reducer computes new bounds via
`computePlacement` and emits `setBounds` effects. The watcher stops touching windows.

**7b. macOS Spaces** — TO ABSORB.
Today: `setVisibleOnAllWorkspaces` is write-only, never read back.
Becomes: a `visibleOnAllSpaces` field per window.

**7c. Space-change events** — TO ABSORB (build new).
Today: **no listener exists anywhere.** Absence confirmed by survey. The port declares
`spaceChanged`; the Electron backend must acquire it (NSWorkspace notification via a native
hook or the closest available Electron signal).

### 4.3 Stacking and visibility

**3. Z-order / stacking / always-on-top** — TO ABSORB. *(Top divergence risk #3.)*
Today: **owned nowhere.** Driven ad hoc by `session.ts restoreSessionSnapshot`,
`reassertColdStartFocusOnce`, and `reassertStackingOrder`, plus `hybrid-overlay.ts
ensureOverlay` / `retarget`.
Becomes: an explicit stacking level per window plus an ordered list in reducer state; the
executor's `setStacking` is the only path to the OS. This is a precondition for
`frontAsserted` being sound at all (see §6).

**3b. Chrome overlay follow / retarget** — TO ABSORB.
Today: `hybrid-overlay.ts` module-level lets **including its own `appActive` copy** — the
third copy of app-active. 40 live-query call sites, the densest concentration in the tree.
Becomes: an overlay-attachment relation in reducer state (`overlayFor: WindowId`); follow
and retarget are `setBounds` + `setStacking` effects driven by `boundsChanged`.

**4. Visibility lifecycle** — TO ABSORB. *(Top divergence risk #2.)*
Today: `WindowRecord.visible` (a mirror only) plus live `isVisible()` plus
`params.keepLive`. `closeOrHideWindow` and `tile:window:hide` hand-dispatch
`WINDOW_HIDDEN` because the OS event lags — a written admission that belief and reality
drift. `maybeHideApp` live-polls `isVisible()`.
Becomes: `visible` becomes authoritative, updated only by `shown` / `hidden` events;
app-hide is derived from reducer state, never polled.

**8b. Special window classes** — ABSORBED (§5 step 4). *(Was top divergence risk #5.)*
The window record carries a `class` field with a closed enum
(`primary | quick-view | overlay | palette | hud | background | bridge | extension-ui |
test-fixture | devtools`), declared at registration — `window-state.ts
classifyWindowRegistration` owns the ordinary-window rule; the infrastructure classes
are declared by their glue modules. `main.ts mainWindow`/`backgroundWindow`,
`core-glue.ts coreBackgroundWindow` and `test-fixture-glue.ts testFixtureWindow` are
deleted — their accessors are lookups by class (`window-state-singleton.ts
getNativeWindowByClass`). The HUD-sniffing predicate (`isAlwaysOnTop() &&
!isFocusable()`) and the `__hudHidden` expando are deleted: the reducer's
APP_RESIGNED/APP_ACTIVATED clauses sweep class-`hud` records (a `hiddenByAppBlur`
record flag) via HIDE_WINDOW/SHOW_WINDOW effects. The chrome-extension
`extensionUiWindows`/`_bridgeWindows` Maps REMAIN as extension-identity indexes
(keyed by runtimeId/page — content-side identity, like the hybrid registry), but
every window in them is a registered class-tagged machine record and all their
window OPS route through the machine. **Survey corrections:** `tile-lifecycle.ts
bgWindow` was wrongly listed here — it is a `{tileId, entryId}` identity latch, not
a window handle; `tray.ts tray` is a Tray, not a window. Neither is WM state.

### 4.4 Focus and routing

**9. Menu / shortcut target resolution** — TO ABSORB.
Today: **three coexisting answers** to "which window" —
`BrowserWindow.getFocusedWindow()` (still live in `entry.ts` and `tile-ipc.ts`),
`getIzuiCoordinator().getFocusedWindowId()`, and `getFrontWindowId()`.
Becomes: `getFrontWindowId()` only, backed by the reducer. Delete the other two paths.

**5b. Restore focus guard** — TO ABSORB (delete).
Today: `izui-state.ts restoreFocusGuard` with `setFocusedWindow` / `getFocusedWindowId` —
a **rival focus authority**. *(Top divergence risk #4.)*
Becomes: nothing. Restore ordering is expressed as reducer states, not a guard flag.

**4b. Transient-sibling autoclose** — TO ABSORB.
Today: `ipc.ts closeTransientSiblingsOnFocus` plus a `pendingAppResignClose` timer; it
fires on focus change and closes windows behind the reducer's back.
Becomes: a reducer rule on focus-change transitions emitting `destroy` effects. The timer
is deleted, not ported — if it proves load-bearing the replacement is a reducer state, never
a timer.

**6. Roles + session tri-state** — TO ABSORB (partial).
Today: `izui-state.ts IzuiStateCoordinator`. The role string is duplicated into
`windowRegistry.params.role`, `tile-launcher.ts tileWindowInfo`, and `WindowRecord.role`.
`appFocused` is the third copy of app-active.
Becomes: `role` lives once on the window record; app-active lives once as the reducer's
`appActive`. The session tri-state (`idle`/`transient`/`active`) is the **only** thing
`izui-state.ts` keeps, mirrored one-way into the reducer via `SESSION_CHANGED`.

**6b. Role-derived policy** — OWNED, KEEP AS IS.
`izui-roles.ts` pure predicates. Well-owned. The reducer calls them.

### 4.5 Persistence

**5. Session save / restore** — TO ABSORB, LAST.
Today: an on-disk `SessionSnapshot` / `WindowDescriptor` plus **12 module-level lets** in
`session.ts`. It drives the OS directly without telling the reducer.
Becomes: serialization of reducer state, and restore becomes a sequence of dispatched
events. `session.ts` computes no window decisions.

**5c. Closed-window undo stack** — KEEP.
`main.ts closedWindowStack`. Single owner, no rival. Fine as is; it may move into the
reducer for tidiness but nothing is broken.

### 4.6 Deferred / adjacent

**4c. Deferred / lazy content load** — TO ABSORB (partial).
Today: `hybrid-page-host-registry.ts` deferredLoad plus **four parallel side Maps**.
Becomes: a `contentPhase` field on the window record (`deferred | loading | loaded`); the
side Maps collapse into it. Content *policy* (what to load, when it's worth loading) may
stay outside; window lifecycle does not.

**8a. Devtools windows** — ABSORBED (§5 step 4).
A global `web-contents-created` listener (main.ts) registers the detached devtools
window (when one exists — attached mode has none) with class `devtools`, satellite,
parented to its host — so closing it hands `front` back via the parent-refocus
transition — and dispatches `DEVTOOLS_OPENED`/`DEVTOOLS_CLOSED` for the host on both
edges. Both events invalidate AND re-drive the front assertion in the same transition
(the machine form of the old scattered "re-focus the content window around devtools"
handlers). Deliberate carve-out: OS focus landing ON a devtools-class window does NOT
clear the assertion — otherwise the derived Esc grab would switch on and eat every
Esc typed inside devtools (parity with the pre-registration behavior).

**11. WebContents ↔ window mapping** — DONE (the id-space part).
`webview-guest-registry.ts guestToHost` now maps guest webContents id → host `WindowId`,
so a host reference can no longer be confused with a numeric webContents id.
`hybrid-editable-focus.ts editableByWcId` and `tile-ipc-gate.ts perWcOriginalSend` remain
keyed by webContents ids, which is correct: their keys are genuinely content-side and
their values hold no window ids, so no window-id collision exists in them. Their
*content* concerns are not the WM's business.

**10. Per-window context / mode** — OUT OF SCOPE (but re-key — deliberately deferred).
`datastore.ts windowContextState`, keyed by window id plus a `null` key for global. This is
application content state, not window management. It stays where it is; it still speaks
numeric Electron window ids today (converted at the seams via `window-state-singleton.ts
getWindowIdFor()` / `getNativeWindowFor()`), and adopting the WM id space is deferred to
the session/context-store step (§3 scope decision). It must be told when a window dies.

**Peek / slide content features** — EXPLICITLY OUT OF SCOPE. What a peek *shows*, how a
slide *animates its content*, what the switcher *lists* — none of that is window
management. The WM owns whether those windows exist, where they are, what is front, and
what Escape does. It owns nothing about what is inside them.

---

## 5. Migration sequence

Ordered so the highest-regression-risk area lands last. **Each step deletes its old
authority in the same commit. Nothing runs in parallel with its replacement — that is the
failure mode this document exists to prevent (§2).**

1. **Id space — DONE** (commits 90becfc5, 5d760baf, 04d2eb94). Branded-string `WindowId`
   (`"wm-N"`), minted only by `window-os-adapter.ts registerWindow()`; the reducer, the
   adapter, and `window-state-singleton.ts` are re-keyed to it; the synthetic ids are
   deleted grep-zero; `guestToHost` holds `WindowId` values. The renderer-facing id
   economy deliberately stays numeric until the session/context-store step (§3 scope
   decision).
2. **The port — DONE** (commit 84ce45b4). `window-backend.ts` defines the command+event
   `WindowBackend` port — surface limited to what the executor issues today (raise,
   focus-content, fullscreen drive + reconcile, close-or-hide, the renderer Escape ask,
   the Escape grab and per-window interceptor, app-activation listeners); the rest of the
   §3 table arrives with the steps that need it, never speculatively.
   `electron-window-backend.ts ElectronWindowBackend` implements it and is the only
   window-manager module importing Electron: it holds every native handle, mints
   `WindowId`, translates native events into the machine's event vocabulary through the
   one injected `BackendEventSink`, and owns the two boundary settles (deferred-blur §4.4,
   bounded fullscreen §2.3). `window-os-adapter.ts` lost its Electron imports in the same
   commit — its `runEffect` now issues port commands only. Handle-carrying registration
   and the numeric-id seam survive as comment-annotated shims
   (`electron-window-backend.ts BackendMigrationShims`) — the registration shim until
   window CREATION moves behind the port (`create(spec)`, still future work after step
   4), the id seam until step 11. The R2 check's exempt file swapped to the backend in
   the same commit.
3. **R2 enforcement check — DONE** (commit b3853bee). `scripts/check-r2-window-ops.mjs`
   runs in the `test:desktop:electron` chain (`apps/desktop/package.json`), with a
   51-entry comment-annotated allowlist covering 129 legacy window-op call sites, each
   entry tagged with the migration step that deletes it; the sole exempt file is the
   executor — swapped to `apps/desktop/main/electron-window-backend.ts` when the port
   landed (step 2), since that is where the native calls now live. The allowlist only
   ever gets shorter; a PR that lengthens it fails.
4. **Special window classes + registry unification — DONE** (commit fa004fbe). The
   window record carries the closed `class` enum (§4.3 dim 8b); every window registers
   (bridge, extension-UI, core background, test fixture, detached devtools);
   `windowRegistry` is deleted with the machine table as the one registry (§4.1 dim
   1a); `__hudHidden` + the always-on-top sniffing predicate are deleted (reducer
   APP_RESIGNED/APP_ACTIVATED sweeps); the `browser-window-created → 'closed' →
   parentWin.focus()` block became the reducer's parent-refocus transition
   (registration-declared `parentId`); the port grew the close/destroy/show/hide/pin
   command family (`closeWindow` guest-safe close, `destroyWindow`, `closeContent`,
   `showWindow`, `hideWindow`, `pinAlwaysOnTop`, `destroyAllContentGuests`); the R2
   allowlist shrank 51→40 entries / 129→104 calls. NOT absorbed here (deliberate):
   handle-carrying registration itself — `create(spec)` is still future work, so the
   `registerWindow` migration shim stays until window CREATION moves behind the port.
5. **Z-order / stacking.** Give the reducer stacking. This is what makes `frontAsserted`
   sound (§6) and it must precede session restore.
   **Part A — machinery: DONE** (commit 693816ab). The reducer carries a per-record
   stacking level (`window-state.ts deriveStackingLevel`: `stacked` participates,
   `pinned` = hud/overlay/palette above the stack via the existing `SET_ALWAYS_ON_TOP`,
   `excluded` = the other satellites) and the ordered list
   (`AppWindowState.stackOrder`, bottom→top; membership = stacked ∧ visible;
   `stackOrderInvariantHolds` checks it). `SET_STACKING` is the new SOLE ordering
   effect (relative order only — activation stays `RAISE_WINDOW`), emitted by the
   closing assertion (`applyFrontAssertion`) alongside the raise, so the machine's own
   front-driving now also drives order and places `front` at the top of the list. The
   page-host orderability caveat (an NSWindow no-ops raises until first composited
   frame) is the `WINDOW_CONTENT_ORDERABLE` event: it marks the record orderable and
   re-drives `SET_STACKING` for the window and everything above it — no timer, no
   poll. Port command `window-backend.ts setStacking(id)`, implemented in
   `electron-window-backend.ts` as the native relative raise (`moveTop`).
   **Part B — caller cutover: PENDING.** The legacy imperative movers are untouched
   and still run beside the machine: `session.ts` (`reassertColdStartFocusOnce`,
   `reassertStackingOrder`, the willActivate restack loop — moveTop ×8, still keyed
   on the raw `hybrid:first-frame` IPC) and `hybrid-overlay.ts` (moveTop ×1); their
   R2 entries remain, and no producer fires `WINDOW_CONTENT_ORDERABLE` yet. Part B
   wires the producers, routes those callers through the machine, and deletes the
   nine moveTop calls + their allowlist entries.
6. **Visibility.** Make `visible` authoritative; delete the hand-dispatch of
   `WINDOW_HIDDEN` and the `isVisible()` polling in `maybeHideApp`.
7. **Geometry / maximize.** Collapse the three stores into one; delete the `isMaximized()`
   distrust workaround along with the need for it.
8. **Focus rivals.** Delete `izui-state.ts`'s focus surface and `restoreFocusGuard`; delete
   `BrowserWindow.getFocusedWindow()` from `entry.ts` and `tile-ipc.ts`. Reduce
   `izui-state.ts` to the session tri-state only.
9. **Overlay attach/retarget + transient autoclose.** Fold `hybrid-overlay.ts`'s 40 live
   queries and its private `appActive` into reducer state.
10. **Displays and Spaces.** Route `display-watcher.ts` through events; add the
    space-change listener that does not exist yet.
11. **Session save / restore. Last.** Worst regression history in the app, and the one
    place doing bulk z-order plus focus as a single sweep.

**Live verification is mandatory at every seam cutover that touches focus.** macOS
first-responder behavior is **unobservable in headless tests** and a green headless suite
has produced false confidence on this exact family of bugs twice already. The protocol:
instrument in a clone, commit the instrumentation, launch, have the **operator perform only
the reproduction gesture** — the agent does everything else, including reading the log and
cleaning up.

---

## 6. Current state

Roughly **5 of ~19 dimensions** are owned. Since this document was written, four
migration steps have landed — the id space (§5 step 1), the port (§5 step 2), the R2
enforcement check (§5 step 3), and special window classes + registry unification (§5
step 4: window identity/params §4.1 dim 1a, classes §4.3 dim 8b, devtools §4.6 dim 8a)
— plus the MACHINERY half of z-order/stacking (§5 step 5 part A: reducer stacking
level + ordered list, the `SET_STACKING` effect, the backend `setStacking` command;
the legacy `moveTop` callers are NOT cut over yet). The machine is live behind the
seams already cut over (`window-state-singleton.ts` lists the authorities it
replaced). The §4 dimensions not yet absorbed still run on their old owners.

**`apps/desktop/main/window-state.ts`** — the owner, as R1 describes it, for the dimensions
it covers. Pure, zero imports, 171 unit tests in `window-state.test.ts`, keyed by
`WindowId`. It owns: `front` (intent), `frontAsserted` (the claim that the OS matches that
intent), the switcher state, the Escape decision (`applyEscape`), fullscreen mode,
satellite classification (`isSatelliteRegistration`), window classes
(`classifyWindowRegistration` + the record's closed `class` enum), the stacking level +
ordered z-order list (`deriveStackingLevel`, `AppWindowState.stackOrder` — §5 step 5
part A), the window-manager
registry payload (`source`/`params` — the deleted `main.ts windowRegistry`), parent
linkage (parent-refocus on WINDOW_CLOSED), the HUD app-blur hide/show sweep, and MRU
focus order. This is the nucleus; everything in §4 grows into it rather than beside it.

**`apps/desktop/main/window-os-adapter.ts`** — the executor, as R2 describes it, and since
the port landed (§5 step 2) **Electron-free**: it imports no platform module and holds no
native handle. Its `runEffect` is the single funnel, and every effect it executes is a
`WindowBackend` port command; native reality re-enters only through the backend's
injected event sink into its dispatch pump.

**`apps/desktop/main/window-backend.ts`** — the port, as R3 describes it: command + event,
never query, zero platform imports. Its surface is exactly what the executor issues
today; the steps that need more of the §3 table widen it when they land.

**`apps/desktop/main/electron-window-backend.ts`** — the Electron implementation, and the
only window-manager module that imports Electron. It retains every native handle, mints
every `WindowId` (`registerWindow()`, idempotent per native window; its private
`idByOsWindowId` map is the only `WindowId` ↔ Electron translation in the tree), owns the
two OS-boundary settles (deferred-blur §4.4, bounded fullscreen §2.3), performs the
step-4 command family (guest-safe `closeWindow` — the absorbed d1cf0b9a UAF guard —
`destroyWindow`, `closeContent`, `showWindow`, `hideWindow`, `pinAlwaysOnTop`,
`destroyAllContentGuests`) plus step 5's `setStacking` (the native relative raise,
`moveTop` — legal only here, the R2-exempt file), and carries the comment-annotated migration shims
(`BackendMigrationShims`) — deleted when creation moves behind the port and at step 11.

**`apps/desktop/main/window-state-singleton.ts`** — the composition point: holds the one
machine + adapter pair and exposes the numeric-id seam (`getWindowIdFor()` /
`getNativeWindowFor()`) that the still-numeric renderer-facing id economy converts
through (§3 scope decision).

**The R2 check is live** — `scripts/check-r2-window-ops.mjs`, in the
`test:desktop:electron` chain: 40 allowlist entries covering 104 legacy window-op call
sites, each tagged with the §5 step that deletes it. The sole exempt file is
`apps/desktop/main/electron-window-backend.ts` (swapped from the executor when the port
landed). The entry count is the migration's progress bar; it only goes down.

**`frontAsserted` is sound only for MACHINE-DRIVEN raises so far** (§5 step 5 part A —
the honest intermediate state; do not paper over the remainder). Since part A, every
transition that sets `frontAsserted: true` also DRIVES order: the closing assertion
emits `SET_STACKING(front)` alongside the raise and places `front` at the top of the
reducer's `stackOrder` — so within the machine's own event flow the claim now means
"raised, first-respondered, AND ordered on top", which kills the buried-but-asserted
state for machine-driven raises. What remains unsound until part B cuts the callers
over: the LEGACY movers still restack behind the machine's back — `session.ts` drives
`moveTop()` ×8 during restore/cold-start re-assert and `hybrid-overlay.ts` ×1 without
informing the reducer — and macOS silently **no-ops `moveTop` for a non-frontmost
app**, so a legacy sweep can bury the asserted front while `frontAsserted` reads
`true` and the Escape-grab safety net (`deriveEscGrabRegistered`) stays off. Also not
yet modeled: a show/import of another stacked window does NOT invalidate the
assertion (deliberate — re-driving there would be a RAISE_WINDOW activation storm
during restore-shaped imports; the burial converges on the focused window's own
event). Until part B lands, treat `frontAsserted === true` as "the MACHINE's last
drive put it on top", not "nothing has restacked since".

---

## 7. Decisions locked — do not re-litigate

- **Satellite rule** is owned solely by `window-state.ts isSatelliteRegistration`: role
  `overlay`/`palette`, OR modal, OR `focusable === false`. Peeks/slides
  (`role:'quick-view'`) stay front-eligible.
- **Every window registers** with the machine. Some registrations no-op. There is no class
  of window that is exempt from the WM.
- **The switcher's "first Escape closes" is intended.** It replaced "first Escape clears
  search, second closes". Accepted behavior change; do not restore.
- **Peeks/slides never native-fullscreen** — enforced at the OS boundary (now: the backend),
  not by a reducer gate.
- **Duplicate registration re-pumps `WINDOW_REGISTERED` on purpose** — it is an idempotent
  merge, and the later spec is the richer one.
- **REJECTED: widening the Escape-grab predicate to live OS reads.** That reintroduces the
  rival-authority pattern this document exists to delete, and papers over a wrong `front`
  instead of surfacing it. It also violates the command+event-not-query constraint in §3.
- **REJECTED: the staged switcher seam** where `izui-state.ts` executes the overlay
  lifecycle and the machine merely decides. Split execution is the defect, not the fix.
