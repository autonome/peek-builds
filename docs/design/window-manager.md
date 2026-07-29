# The Window Manager

Status: **mandate.** This document is directive, not exploratory. It is not a menu of
options and not a record of a discussion. It states what the system must become and what
is forbidden on the way there.

---

## Where we are

Read this table first. §4 and §5 below are the detailed record; this block is the fast,
current answer to "how much is done" — verified against `scripts/check-r2-window-ops.mjs`
and the commit log, not against the prose elsewhere in this document, which drifts.

### Step status (§5 migration sequence, 11 steps)

| Step | What it is | Status |
|---|---|---|
| 1 | Id space (`WindowId`, one id-minting seam) | DONE |
| 2 | The backend port (`WindowBackend` / `ElectronWindowBackend`) | DONE |
| 3 | R2 enforcement check (`scripts/check-r2-window-ops.mjs`) | DONE |
| 4 | Special window classes + registry unification | DONE |
| 5 | Z-order / stacking (`SET_STACKING`, `stackOrder`) | DONE |
| 6 | Visibility (`visible` authoritative, app-hide derived, no polling) | DONE |
| 7 | Geometry / maximize (bounds/maximize collapse into one reducer-owned model) | DONE |
| 8 | Focus rivals (delete `izui-state.ts`'s focus surface, `getFocusedWindow()` call sites) | PARTIAL — 4 entries / 8 calls still allowlisted under §5 step 8: `hybrid-overlay.ts` `focus` ×1, `izui-state.ts` `showInactive` ×2, `main.ts` `focus` ×2, `windows.ts` `focus` ×3 |
| 9 | Overlay attach/retarget + transient autoclose | PARTIAL — transient autoclose and overlay follow/retarget are absorbed (`window-state.ts` `selectTransientAutoclose`, `applyOverlayFollow`); 4 entries / 6 calls still allowlisted under §5 step 9: `hybrid-overlay.ts` `showInactive` ×1 (test bridge), `destroy` ×2, `ipc.ts` `focus` ×2, `main.ts` `close` ×1 |
| 10 | Displays and Spaces | DONE |
| 11 | Session save / restore (last) | PARTIAL — 8 tasks landed (11.1, two Task 3s, two Task 4s, Task 5, Task 7, Task 8 — see §5 step 11 for the full write-up and the task-number collision note); no commit evidence of any task beyond these 8 |

### The mechanical progress measure

`node scripts/check-r2-window-ops.mjs` (run 2026-07-29): **23 allowlisted entries / 37
calls**. This number — not the table above, not any other prose in this document — is the
honest measure of how much window-op code still bypasses the machine. It is expected to
shrink monotonically to zero; the check fails a PR that grows it.

### Remaining work, most-tractable first

1. Close step 8: route its 4 residual call sites through the machine, delete their
   allowlist entries.
2. Close step 9: route its 4 residual call sites through the machine, delete their
   allowlist entries.
3. Determine whether step 11 has any task beyond the 8 already landed. No commit or doc
   evidence of one exists as of this writing; if none turns up, step 11 — and the whole
   migration — is DONE once the R2 allowlist above also reaches zero.
4. Once steps 8, 9, and 11 are all DONE and the R2 allowlist is empty, delete this block
   and replace it with a one-line completion note (see the directive below).

### Maintenance directive

**This block is the single source of truth for migration status. Every agent that lands
window-manager work MUST update this block in the same commit — adjust the step statuses,
refresh the R2 count, and strike completed items off the remaining-work list. Do NOT
delete this block until the migration is complete (all 11 steps DONE and the R2 allowlist
empty); at that point it is replaced by a one-line completion note. Any handoff document
must point at this block by name (`docs/design/window-manager.md`, "Where we are") rather
than restating its contents.**

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
*(Machinery landed inert — §5 step 7A. The hybrid store is DELETED — §5 step 7B:
`hybrid-page-host-registry.ts` `maximized`/`preMaxBounds` are machine-record
fields now, hybrid maximize is fully machine-owned. The generic BrowserWindow
maximize IPC is machine-owned and the `params` `preMaxX/Y/W/H`/`maximized`
bags as in-memory authority are DELETED — §5 step 7C: `tile-ipc.ts`'s
maximize/unmaximize/update-canvas-state dispatch machine events and the
`isMaximized()` distrust block is gone. `preMaxX/Y/W/H` keys survived only as
persisted-snapshot/open-options FORMAT (session save wrote them from the
presenter; reopen/restore read them to seed `MAXIMIZE_RESTORED`) until the
session read-model step, which landed at §5 step 11 task 5: the four flat keys
collapsed into one nested `preMaxBounds` field, read tolerantly
(`session-projection.ts readPreMaxBounds`) so a pre-collapse snapshot still
restores. The geometry READ model is machine-owned — §5 step
7D: presenter/close-capture/session-save read the reducer through the ONE
restorable-geometry rule (`window-presenter.ts getRestorableBounds`:
fullscreen → `fsMode.preBounds`, else the `bounds` mirror), live reads
surviving only as machine-unseen-window fallbacks. Still running: the
non-maximize `setBounds` IPC + drag/resize streams, until the remaining
step 7 cutovers.)*
Today: split three ways — live Electron `getBounds()`, `windowRegistry.params`
`preMaxX/Y/W/H`, and (deleted, step 7B) `hybrid-page-host-registry.ts
InternalEntry.maximized` / `preMaxBounds`. `tile-ipc.ts tile:window:maximize`
explicitly distrusts Electron's `isMaximized()` on frameless macOS windows.
Becomes: `bounds` + `maximized` + `preMaxBounds` fields per window record, updated solely
by the `boundsChanged` event (plus a one-shot registration-time seed of `bounds`,
step 7B); maximize is a reducer transition, never an OS question.

**2b. Placement intent** — OWNED, KEEP AS IS.
`window-placement.ts computePlacement` is already pure and genuinely well-owned. Do not
rewrite it. *(Resolution, §5 step 7A: it does NOT become "a helper the reducer calls" —
the reducer's zero-value-imports invariant wins. Placement rects are computed at the
dispatch site and carried on the event payload; `computePlacement` stays where it is.)*

**7. Multi-display** — ABSORBED (§5 step 10, Part A).
`display-watcher.ts` no longer calls `setBounds()` directly. It reads the OS (display
snapshot, both window registries, `getWindowInfo`), decides via the pure seam
`display-projection.ts collectDisplayProjection()`, and dispatches ONE `DISPLAY_CHANGED`
per pass; the reducer computes bounds and emits the `SET_BOUNDS` effects, which the port
performs. See §5 step 10 for the full mechanism (parent-centered resolution against the
projected rect, the `pendingProjectedBounds` fullscreen/hidden retry).

**7b. macOS Spaces** — TO ABSORB.
Today: `setVisibleOnAllWorkspaces` is write-only, never read back.
Becomes: a `visibleOnAllSpaces` field per window.

**7c. Space-change events** — ABSORBED (§5 step 10, Part B).
`electron-window-backend.ts attachSpaceChangeListener` (called from `attachAppListeners`,
darwin-only) subscribes to `NSWorkspaceActiveSpaceDidChangeNotification` through
`systemPreferences.subscribeWorkspaceNotification` and emits `SPACE_CHANGED`. The
notification's `userInfo` is EMPTY — verified live on a real machine — so the event carries
no Space identity and the machine holds no per-Space state. The reducer's clause is inert:
it writes nothing and emits nothing. The all-Spaces flag is sticky collection behavior, so a
Space switch is not a moment the OS forgets it, and re-asserting would fire a native
`setVisibleOnAllWorkspaces` per pinned window mid-transition and in the background — the call
this app has flash regressions on. The listener stays so the signal exists when something
needs it; the clause in `window-state.ts` carries the full argument.

### 4.3 Stacking and visibility

**3. Z-order / stacking / always-on-top** — ABSORBED (§5 step 5).
The reducer owns `stackOrder` (bottom→top) plus a per-record stacking level
(`deriveStackingLevel`); `SET_STACKING` is the sole ordering effect, and the executor's
`setStacking` — routed to the backend's `setStacking()` — is the only path to the OS.
`WINDOW_CONTENT_ORDERABLE`, produced from the `hybrid:first-frame` boundary signal, marks a
record orderable and re-drives `SET_STACKING` for it and everything above it. This is the
precondition for `SET_STACKING` to actually land where `applyRaiseRequest` and
`applyOsFocusRealized` (§6) already point `front` — a page-host that can't yet take a raise
must not be left stacked behind reality once it can.

**3b. Chrome overlay follow / retarget** — ABSORBED (§5 step 9, commit `1bdd1c11`).
The overlay-attachment relation lives in reducer state (`WindowRecord.overlayFor`);
`window-state.ts applyOverlayFollow` drives follow/retarget off `BOUNDS_CHANGED` and
`OS_FULLSCREEN_ENTERED`/`LEFT` for every registered window, reached through
`OVERLAY_ATTACH_REQUESTED`. `hybrid-overlay.ts` no longer drives the OS itself for this;
its own module-level `appActive` copy — the third copy of app-active — is also gone: the
module now reads `AppWindowState.appActive` through `getAppActive()`/`subscribeAppActive()`
(see the "FOLLOW is not wired here any more" comment at the old follow site in
`hybrid-overlay.ts`). **Honest residue, still allowlisted (§5 step 9):**
`hybrid-overlay.ts` `showInactive` ×1 (test bridge only) and `destroy` ×2 (singleton
teardown) — `scripts/check-r2-window-ops.mjs`. A further `hybrid-overlay.ts` `focus` ×1
(address-bar-typing activation) is allowlisted separately under §5 step 8, not this
dimension. **Not re-verified here:** the original "40 live-query call sites" figure — the
mechanism it counted is gone, so the number is stale, but no replacement count was taken
in this pass.

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

**5b. Restore focus guard** — ABSORBED (§5 step 8b, deleted outright).
Was: `izui-state.ts restoreFocusGuard` with `setFocusedWindow` / `getFocusedWindowId` —
a **rival focus authority**. *(Top divergence risk #4.)*
Now: nothing. The guard, `beginRestoreFocusGuard`/`clearRestoreFocusGuard`, and
`session.ts`'s restore-time arm are gone; restore focus determinism lives in the
machine's `front` (driven by restore's machine-routed show dispatches).
`setFocusedWindow` / `getFocusedWindowId` remain as a plain tracker until step 8c
deletes them.

**4b. Transient-sibling autoclose** — ABSORBED (§5 step 9 cutover).
Was: `ipc.ts closeTransientSiblingsOnFocus` (+ `gatherTransientSiblingCandidates`,
`izui-roles.ts selectTransientSiblingsToClose`) plus a `pendingAppResignClose` timer with a
`did-become-active` cancel; it fired on focus change and closed windows behind the reducer's
back. All deleted.
Now: `selectTransientAutoclose` on `OS_FOCUS_GAINED` and `selectAppResignTransients` on
`APP_RESIGN_SETTLED`, both dismissing through the shared keepLive decision
(`HIDE_WINDOW`/`CLOSE_WINDOW`, never `DESTROY_WINDOW` — a keepLive slide must survive, peek
2c94c125). The timer was deleted, not ported: its CANCEL is now reducer state
(`pendingAppResignSweep`, armed by `APP_RESIGNED`, disarmed by `APP_ACTIVATED`). What
remains irreducible is the settle DELAY — macOS offers no "the resign→become dance is over"
signal — so it sits at the OS boundary as `electron-window-backend.ts
APP_RESIGN_SETTLE_MS`, which only says "500ms elapsed" and never decides the sweep. The one
piece still unmodelled is the izui overlay entry/exit cooldown, read at that producer to
suppress the settle EDGE; re-home it when the cooldown becomes machine state.

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
5. **Z-order / stacking — DONE** (commits 693816ab, 9302478d, c18e361b). This is what lets
   `SET_STACKING` land wherever the reducer's own raise/focus decisions already point
   `front` (§6); it precedes session restore as planned.
   **Part A — machinery** (commit 693816ab). The reducer carries a per-record
   stacking level (`window-state.ts deriveStackingLevel`: `stacked` participates,
   `pinned` = hud/overlay/palette above the stack via the existing `SET_ALWAYS_ON_TOP`,
   `excluded` = the other satellites) and the ordered list
   (`AppWindowState.stackOrder`, bottom→top; membership = stacked ∧ visible;
   `stackOrderInvariantHolds` checks it). `SET_STACKING` is the new SOLE ordering
   effect (relative order only — activation stays `RAISE_WINDOW`), emitted by
   `applyRaiseRequest` alongside the raise it drives, so the machine's own
   front-driving now also drives order and places `front` at the top of the list. The
   page-host orderability caveat (an NSWindow no-ops raises until first composited
   frame) is the `WINDOW_CONTENT_ORDERABLE` event: it marks the record orderable and
   re-drives `SET_STACKING` for the window and everything above it — no timer, no
   poll. Port command `window-backend.ts setStacking(id)`, implemented in
   `electron-window-backend.ts` as the native relative raise (`moveTop`).
   **Part B — caller cutover** (commit 9302478d). `session.ts`
   (`reassertColdStartFocusOnce`, `reassertStackingOrder`, the willActivate restack
   loop) and `hybrid-overlay.ts` are routed through the machine; both legacy
   `moveTop` R2 allowlist entries are deleted (allowlist now 38 entries / 95 calls).
   **Live-run fix** (commit c18e361b): an `OS_FOCUS_GAINED` that landed on `front` must
   mirror what the OS already did (`applyOsFocusRealized`, §6), not echo an activating
   raise back at it — echoing it caused a perpetual multi-tile focus ping-pong at
   frontmost restore.
6. **Visibility.** Make `visible` authoritative; delete the hand-dispatch of
   `WINDOW_HIDDEN` and the `isVisible()` polling in `maybeHideApp`.
   **Part A — per-window show/hide through the machine: DONE, gate green** (commits
   0996ba38, 765a6215, baa51bda, d66a6d51; full gate green after the hide-event-lag
   fix bb9d7226 and test-wait fix 11d53bc6).
   - **6A-1** (0996ba38): the reducer owns the keepLive close-request decision —
     `WINDOW_CLOSE_OR_HIDE_REQUESTED` branches on the record's first-class
     `keepLive` (hide vs the resolved close); no caller decides anymore.
   - **6A-2** (765a6215): the show path behind the port — `showWindow` in the
     backend owns the whole policy (headless opacity-0-before-show, activate vs
     `showInactive`, the quick-view NSPanel non-activation mask) and echoes
     `WINDOW_SHOWN` with the unmasked intent; the `windows.ts` show seams
     (`showWindowHeadlessSafe`, `showHybridHost`) are thin dispatchers.
     **Known asymmetry:** `raiseWindow` (the front assertion's own show/raise/
     activate path — §5 step 5) has no matching quick-view mask; it activates
     a page-host under plain `!isHeadless()` regardless of window class.
     Currently unreachable (`session.ts` never restores a quick-view host, and
     `raiseWindow` is already the front assertion's path), but it is a real gap
     between the two show paths, worth recording rather than leaving to memory.
   - **6A-3** (baa51bda): keepLive producers — `closeOrHideWindow` (both window
     kinds) and the tile-launcher `close` intercept dispatch the intent; the
     `windows.ts` hand-dispatched `WINDOW_HIDDEN` died.
   - **6A-4** (d66a6d51): the last per-window sites — `tile-ipc.ts`
     `tile:window:show/hide` + `show-self`/`hide-self`, `ipc.ts` hybrid and
     BrowserWindow key/url-reuse shows, and `windows.ts modWindow` 'hide' all
     dispatch `WINDOW_SHOW_REQUESTED` / the new `WINDOW_HIDE_REQUESTED` (the
     plain-hide twin of the show intent). The reuse paths' hand-dispatched
     `WINDOW_SHOWN` mirrors died with them — the backend's echo is the source.
     Remaining hand-dispatches of `WINDOW_SHOWN`/`WINDOW_HIDDEN` outside the
     backend + the executor's registration pump: the `hybrid-overlay.ts` test
     bridge's synthetic events for fake hosts (step 9) and `ipc.ts`'s fresh-open
     visible-intent seed (headless opens force ctor `show:false`, so no native
     or backend event ever fires there; dies when open lands behind the port).
   **Part B — app-level derivation: DONE.** `windows.ts getVisibleWindowCount`
   counts machine records (`listMachineWindowRecords`, the record's `visible`
   flag) instead of polling `isVisible()` across the BrowserWindow + hybrid
   registries — one table, both window kinds. The exclusion is by window CLASS
   (`APP_HIDE_EXCLUDED_CLASSES`: background / quick-view / palette / overlay /
   hud — the exact class image of the old address + TRANSIENT_ROLES +
   HUD-predicate checks), deliberately NOT by the `satellite` flag: quick-view
   is satellite:false yet excluded, while devtools (satellite:true) and
   extension-ui windows count. The in-flight window is still excluded, by
   machine id via `getWindowIdFor` (its native hide event may not have echoed
   yet). Design decision (operator, 2026-07-23): `app.hide()` and
   `app.dock.hide/show` get NO port command — they are app-level operations,
   not window operations, so they are outside the port's scope (the port
   governs window ops; this is not an exception to it). The machine's job ends
   at supplying the visibility state the decision reads; the app-surface calls
   stay in `windows.ts maybeHideApp` / `applyDockPreference` (the latter
   collapsed to one preference-derived show/hide decision). The `windows.ts`
   hide-family R2 entry shrank 3→2 calls accordingly.
7. **Geometry / maximize.** Collapse the three stores into one; delete the `isMaximized()`
   distrust workaround along with the need for it.
   **Part A — machinery: DONE (inert — no caller cutover, R2 allowlist unchanged).**
   The reducer record carries `bounds` + `maximized` + `preMaxBounds`
   (`window-state.ts WindowRecord`). Inbound `BOUNDS_CHANGED` is the SOLE
   writer of `bounds` (an honest mirror of native reality — the restorable
   pre-fullscreen rect stays structurally in `fsMode.preBounds`, the aa34cb50
   trap). Maximize/unmaximize are reducer transitions (`MAXIMIZE_REQUESTED` /
   `UNMAXIMIZE_REQUESTED`), never an OS `isMaximized()` question: maximize
   stashes `preMaxBounds` from the machine's own bounds mirror and emits the
   new `SET_BOUNDS` effect with the display work area; a re-maximize re-snaps
   WITHOUT overwriting the stash (the stale-snapshot trap tile-ipc.ts's X11
   heuristic guards); maximize is a no-op while `fsMode` is non-normal
   (fullscreen owns the display); unmaximize restores the stash and clears it.
   **§4.2 dim 2b resolution:** the dim-2b phrasing "computePlacement becomes a
   pure helper the reducer calls" is resolved in favor of the reducer's
   ZERO-value-imports invariant (the unit gate compiles `window-state.ts`
   standalone): `window-placement.ts computePlacement` stays where it is,
   unrewritten, and any rect the reducer needs (the maximize work area, future
   display reprojection) is computed at the DISPATCH SITE and carried on the
   event payload — the reducer never imports it. Port command
   `window-backend.ts setWindowBounds(id, rect)` (deliberately NOT the
   platform name `setBounds` — the R2 check greps platform call names
   verbatim, same convention as `setFullscreen`/`pinAlwaysOnTop`), executed in
   `electron-window-backend.ts`, whose native `resize`/`move`/`moved`
   listeners emit `BOUNDS_CHANGED` for every registered window; executor case
   `SET_BOUNDS` in `window-os-adapter.ts` (no headless gate — a bounds write
   neither activates nor shows, same reasoning as `SET_STACKING`).
   **Part B — hybrid maximize cutover: DONE.** The
   `hybrid-page-host-registry.ts` store (`InternalEntry.maximized` /
   `preMaxBounds` / `setHybridMaximizeState`) is DELETED grep-zero; the
   machine record is the one holder. `ipc.ts page:maximize`/`page:unmaximize`
   dispatch `MAXIMIZE_REQUESTED` (work area resolved at the dispatch site,
   carried on the event) / `UNMAXIMIZE_REQUESTED`; readers
   (`window-presenter.ts getHybridPresentation`, the `hybrid-overlay.ts`
   active-handoff + test bridge) read the machine record. Reducer semantics
   added in this step (all pinned in `window-state.test.ts`, suite 206→222):
   - `MAXIMIZE_RESTORED {id, preMaxBounds}` — the construction-time restore
     seed (reopen/session-restore build the window AT the maximized rect, so
     it sets flag+stash and drives NO `SET_BOUNDS`); dispatched by the
     `ipc.ts` hybrid open path right after machine registration.
   - `MAXIMIZE_EXITED_BY_RESIZE {id}` — the pinned "resize gesture exits
     maximize at press" invariant as a transition: clears flag+stash, drives
     nothing (the gesture owns the bounds). Producers: the band-drag press
     (`exitMaximizeForResize`) and the native-resize reconciler
     (`reconcileMaximizeAfterResize`) — both now read the machine flag; the
     reconciler's work-area comparison stays a live-read because it RACES the
     backend's own `resize` listener on the same native event (geometry is
     evidence there, never authority).
   - `WINDOW_REGISTERED` gained an optional `bounds` seed for the mirror:
     the backend reads `getBounds()` ONCE at registration (same boundary-read
     pattern as `nativeVisible`) and the executor carries it on the pump —
     without it a ctor-placed window that was never natively resized/moved
     has an empty mirror and its first `MAXIMIZE_REQUESTED` would stash
     null. A re-registration never overwrites a lived mirror.
   Divergences from the legacy handlers, deliberate: `page:unmaximize` with a
   null stash now clears the flag (legacy no-oped), and the maximize stash
   comes from the machine's mirror rather than a live `getBounds()` at
   toggle time. R2: `ipc.ts` `setBounds` 7→5 (the maximize snap + restore
   calls died); the `hybrid-overlay.ts` `setBounds` ×6 are all
   overlay-follow geometry (step 9's share) and were untouched.
   **Part C — generic BrowserWindow maximize cutover: DONE.** The
   `tile-ipc.ts` maximize path is machine-owned and the `params` bag as
   in-memory maximize authority is deleted grep-zero (no live
   `info.params.preMaxX/Y/Width/Height` or `params.maximized`
   reads/writes remain):
   - `tile:window:maximize` dispatches `MAXIMIZE_REQUESTED` (work area
     resolved at the dispatch site, riding the event — same shape as
     `ipc.ts page:maximize`). The manual `setBounds(workArea)` + params
     stash died; the X11 at-work-area slack heuristic (geometry guarding
     the re-maximize stash-overwrite trap) is subsumed by the reducer's
     flag-idempotent `MAXIMIZE_REQUESTED` clause — geometry no longer
     votes. The `tile:window:maximize-request` renderer notification
     survives, its `prevWindowBounds` now the machine's pre-dispatch
     bounds mirror (null on re-maximize, matching the unoverwritten
     stash).
   - `tile:window:unmaximize` dispatches `UNMAXIMIZE_REQUESTED`; the
     `isMaximized()` distrust block (stash-else-native fallback, both
     native `unmaximize()` calls) is deleted entirely — maximize is a
     reducer fact, never an OS question (§3).
   - `tile:window:update-canvas-state` (a canvas-era surface with no
     in-tree callers left, kept as the declared-layout sync channel)
     routes maximize facts to the machine: `maximized:true` →
     `MAXIMIZE_RESTORED` (declared stash, no `SET_BOUNDS` — the renderer
     owns the bounds), `maximized:false` → `MAXIMIZE_EXITED_BY_RESIZE`.
     Position x/y/width/height still land in `info.params`
     (session-format passthrough, step 11's read-model).
   Deliberate semantics changes vs legacy: unmaximize of a
   never-machine-maximized window is now a reducer no-op (the native
   `unmaximize()` fallback for "maximized via OS frame dbl-click" died —
   no in-app path produces that state); a maximized-then-natively-resized
   BrowserWindow keeps its original stash (generic windows have no
   resize-exits-maximize reconciler — that producer exists only on the
   hybrid path). Persisted-snapshot FORMAT untouched at this step:
   `session.ts` still wrote `preMaxX/Y/Width/Height`+`maximized` keys (from the
   presenter) and reopen/restore still threaded them as open options into the
   `ipc.ts` `MAXIMIZE_RESTORED` seed — the four flat keys later collapsed into
   one nested `preMaxBounds` field at §5 step 11 task 5; `maximized` stayed a
   flat boolean throughout, matching `WindowRecord.maximized`. `ipc.ts
   windowParams` still carries the open-time `maximized` passthrough
   (write-only — no in-memory reader remains; dies with the session
   read-model cutover). R2:
   `tile-ipc.ts` `setBounds` 5→3, `unmaximize` entry (×2) deleted —
   allowlist 32→31 entries.
   **Part D — geometry READ-model cutover: DONE.** Presenter, close-capture
   and (through the presenter) session-save read reducer state, never live
   Electron queries, and "restorable geometry" is ONE concept with ONE home:
   `window-presenter.ts getRestorableBounds(machineId)` — fullscreen episode
   → `fsMode.preBounds` (the aa34cb50 lookalike trap, previously a presenter
   special case); else the machine's `bounds` mirror, which while maximized
   IS the maximized rect, persisted at this step alongside `maximized` +
   `preMaxX/Y/Width/Height` exactly as the session format then expected
   (restore re-seeds via `MAXIMIZE_RESTORED`, 7C) — the four flat keys later
   collapsed into one nested `preMaxBounds` field at §5 step 11 task 5.
   Cutovers, each keeping the live
   read only as the fallback for a machine-unseen window (tripwire-hunted):
   - `window-presenter.ts getLivePresentation` — machine bounds via the rule;
     the hardcoded `maximized:false`/`preMaxBounds:null` for generic
     BrowserWindows (7C known gap) now reads the machine record, so
     `tile:window:list` and session-save finally surface generic-window
     maximize state. `getHybridPresentation`'s two-step (7B mirror + 7A
     fullscreen override) collapsed into the same rule.
   - `main.ts` `'close'` capture (`lastBounds`) and `ipc.ts`
     `captureHybridClose` (`hybridLastBounds`) — the undo-close raw-bounds
     fallbacks read the machine via the rule.
   Persisted-snapshot FORMAT untouched at this step (session.ts still wrote
   the same keys from the presenter; collapsed later at §5 step 11 task 5).
   R2 allowlist unchanged (31 entries / 72 calls — the check tracks op calls,
   not reads).
   **Part E — remaining geometry-write cutover: DONE. Step 7 is DONE.**
   One new inbound event closes the write side:
   `SET_BOUNDS_REQUESTED {id, bounds}` (`window-state.ts`) — the plain
   geometry-write intent behind every legacy direct `setBounds` — emitting
   the existing `SET_BOUNDS` effect. Same shape as the maximize pair: the
   rect is computed AT THE DISPATCH SITE (`computePlacement`, gesture math)
   and rides the event (ZERO-value-imports invariant); the `bounds` mirror
   still updates ONLY via the `BOUNDS_CHANGED` echo; dropped while `fsMode`
   is non-normal (fullscreen owns the display, the aa34cb50 family — a
   deliberate divergence from the legacy calls, which would have written
   blindly mid-episode); deliberately does NOT touch `maximized`/
   `preMaxBounds` (matching the legacy calls — invalidation stays
   `MAXIMIZE_EXITED_BY_RESIZE`, whose producers fire at the gesture press).
   Cutovers: `tile-ipc.ts` `tile:window:center` / `center-all` /
   `set-bounds` (×3, all dead — entry deleted), `ipc.ts`
   `applyPlacementOnReuse` + the open-time `options.maximize` work-area fill
   + BOTH drag/resize streams (`page:set-bounds` and the band-drag
   `applyResize`). The streams go through the reducer PER EVENT, not through
   a sanctioned port-command side door: the pump's dispatch is synchronous
   (read-after-dispatch contract) and already carries `BOUNDS_CHANGED` at
   native resize-event frequency, so a gesture stream costs what its own
   echo stream already costs — and one path stays one path. The 7B gesture
   reconciler is untouched (its live read stays evidence, never authority).
   The fifth `ipc.ts` hit is the `assembleHybridPageHost` fillView
   `view.setBounds` — a CHILD-VIEW op on the host's content
   `WebContentsView`, not a window op: reclassified into the R2 check's
   not-window-ops section (entry kept at ×1, the mechanical greps can't see
   receivers). R2: `tile-ipc.ts` `setBounds` entry deleted, `ipc.ts`
   `setBounds` 5→1 — allowlist 31→30 entries / 72→65 calls. Reducer suite
   222→228. Geometry writers still on the R2 list are OTHER steps' shares,
   not step-7 remainder: `hybrid-overlay.ts` overlay-follow geometry (×6,
   step 9). `display-watcher.ts` is no longer on this list at all — step 10
   deleted its `setBounds` call outright; the module is now a pure producer.
8. **Focus rivals — DONE except for 4 residual allowlisted call sites (see below).** Delete `izui-state.ts`'s focus surface and `restoreFocusGuard`; delete
   `BrowserWindow.getFocusedWindow()` from `entry.ts` and `tile-ipc.ts`. Reduce
   `izui-state.ts` to the session tri-state only.
   **8a — switcher focus-restore seed: DONE** (commit eff3bcd6). `enterOverlay`
   seeds `preOverlayFocusTarget` from the machine's `front`, not the
   coordinator tracker.
   **8b — restore focus guard deleted: DONE.** `restoreFocusGuard` +
   `beginRestoreFocusGuard`/`clearRestoreFocusGuard` (`izui-state.ts`) and
   `session.ts`'s restore-time arm are gone; `setFocusedWindow` is a plain
   setter (§4.4 dim 5b). Known, deliberate consequence: the arm was also the
   only deterministic restore-time seed of `session.focusedWindowId`, so that
   tracker is now fed only by async OS focus events — acceptable because its
   last load-bearing reader left in 8a and step 8c deletes it. The
   session-restore-hybrid-focus spec asserts the machine's `front` instead
   (test bridge `getFrontWindowId`/`getMachineWindowIdFor` in `entry.ts`).
   **8b follow-up — session-restore front-steal fixed (two layers).** (1) The
   restore loop in `session.ts restoreSessionSnapshot` never activates: every
   in-loop show is inactive, and the window-reuse path honors `show:false`, so
   the post-loop `willActivate` block is the single activation authority
   (commit aee38a6d). (2) AppKit can deliver a stale/lagged native `hide`
   event for a just-activated hybrid host that is still visible — no JS hide
   call exists (proven via a prototype-level `.hide()` trap). The native
   `win.on('hide')` listener in `electron-window-backend.ts` therefore echoes
   `WINDOW_HIDDEN` only when `win.isVisible()` is false — a commented
   OS-boundary workaround (peek `71cfde09` lag class); do not remove.
   **8c — izui coordinator focus tracker deleted: DONE.** `setFocusedWindow` /
   `clearFocusedWindow` / `getFocusedWindowId` and `IzuiSession.focusedWindowId`
   are gone (`izui-state.ts`), along with the `ipc.ts` focus-handler tracker
   update, the `main.ts` closed-handler clear, and the
   `entry.ts` `getIzuiFocusedWindowId` test bridge.
   `session-restore-page-host.spec.ts` now asserts the machine front
   (`getMachineWindowIdFor` → `getFrontWindowId`). The izui tri-state,
   app-active tracking, overlay executor, and `enterOverlay()`'s
   machine-front seed via the injected provider remain.
   **8d — current-window queries via machine front: DONE.** The remaining
   `BrowserWindow.getFocusedWindow()` calls in `entry.ts` (Cmd+W devtools
   guard) and `tile-ipc.ts` (`tile:dialogs:save`/`tile:dialogs:open`
   parenting, `tile:theme:setWindowColorScheme` resolution chain) now resolve
   through `getFrontWindowId()` → native window. Dialog sheets parent
   directly over hybrid BaseWindow hosts (Electron dialog APIs accept
   `BaseWindow`). Deliberate hold-over: the devtools guard still skips a
   hybrid front (matches the old null behavior) — extending it to hybrid
   content devtools is a possible follow-up, not done.
   **8e — clean focus calls routed through the machine: DONE.** The
   `tile:window` focus IPC (both BrowserWindow and hybrid branches,
   `tile-ipc.ts`) and all four `ipc.ts` open-dedupe reuse paths now ride
   `WINDOW_SHOW_REQUESTED {activate:true}` (the headless-gated reuse sites
   already did via `showWindowHeadlessSafe`); the hand-dispatched
   `OS_FOCUS_GAINED` mirror in `tile-ipc.ts` is gone. R2 allowlist
   29 entries / 57 calls. Punted to step 9 (entangled, entries retained):
   the `ipc.ts` `devtools-opened` first-responder restore and the modal
   blur-settle re-focus.
   **8 live verification — DONE (visible macOS run, temporary front-diag
   instrumentation, reverted after).** Both mandatory focus gestures pass:
   - **Gesture A (switcher ESC-ESC restore):** `enterOverlay` seeds
     `preOverlayFocusTarget` to the real machine front; the switcher is a
     satellite so `front` never moves while it is focused; on ESC dismiss the
     machine (not the close handler) owns restore via `RAISE_WINDOW`, and the OS
     focus event lands back on the pre-overlay front. Verified across five
     open/dismiss cycles.
   - **Gesture B (restore-then-front):** every restore-loop show is
     `inactive=true` (the loop never activates); the post-loop decision is the
     single authority (`willActivate=true`, `focusedId` = the focused
     descriptor) and activates it via `showHybridHost`; the stale-macOS-hide
     guard correctly suppresses lagged `'hide'` events for still-visible
     windows. The only front shift observed afterward was a `DEVTOOLS_OPENED`
     first-responder grab in the `DEBUG=1` build — the already-known step-9
     `ipc.ts devtools-opened` punt, not a restore regression.
   **Step 8 residual R2 debt (not yet cut over):** 4 entries / 8 calls remain allowlisted
   under §5 step 8 in `scripts/check-r2-window-ops.mjs` — `hybrid-overlay.ts` `focus` ×1
   (overlayWin.focus for address-bar typing, `page:show-navbar`), `izui-state.ts`
   `showInactive` ×2 (restore-without-activating in the focus-restore guard), `main.ts`
   `focus` ×2 (overlay-selection/restore focus of the switcher target), `windows.ts`
   `focus` ×3 (contentWC first-responder + bw/webContents focus, the show invariant).
   Each is individually justified in the allowlist as "focus rivals, §5 step 8"; none has
   a caller-cutover write-up here yet.
9. **Overlay attach/retarget + transient autoclose — PARTIAL.** Transient-sibling
   autoclose is absorbed (§4.4 dim 4b: `selectTransientAutoclose` /
   `selectAppResignTransients`). Overlay follow/retarget and the module's own `appActive`
   copy are absorbed (commit `1bdd1c11`, §4.3 dim 3b): `hybrid-overlay.ts` no longer
   drives the OS itself for geometry; the reducer owns the follow via
   `applyOverlayFollow` / `WindowRecord.overlayFor`.
   **Residual R2 debt:** 4 entries / 6 calls remain allowlisted under §5 step 9 in
   `scripts/check-r2-window-ops.mjs` — `hybrid-overlay.ts` `showInactive` ×1 (test bridge
   only, fake-host focus-free show), `destroy` ×2 (overlay singleton teardown), `ipc.ts`
   `focus` ×2 (devtools-opened first-responder restore + modal blur-settle re-focus,
   punted from step 8e), `main.ts` `close` ×1 (close the overlay switcher on
   `did-resign-active`).
   **Unverified here:** whether further step-9 work beyond the overlay-follow cutover has
   landed under other commit messages — the commit log carries at least two more
   `wm step 9`-tagged commits (`ed0f80ce`, `c5c9bcd7`) that this pass did not audit
   task-by-task. A future pass should reconcile them into this section rather than assume
   step 9's remaining scope is only the 4 entries above.
10. **Displays and Spaces.** Route `display-watcher.ts` through events; add the
    space-change listener that does not exist yet.
    **Part A — Displays: DONE** (commits af540e74, 81175dfe, b8e44377, 10c79748).
    `display-watcher.ts`'s `projectWindow()` — the direct `win.setBounds()` call
    it ran per window — is deleted; the module is reduced to a pure producer: it
    reads the OS (the display snapshot, the two window registries,
    `getWindowInfo`), decides via the new pure seam `display-projection.ts
    collectDisplayProjection()`, and dispatches ONE `DISPLAY_CHANGED` per pass
    carrying the whole batch instead of writing bounds inline window-by-window.
    The reducer emits the `SET_BOUNDS` effects; the port performs them (R2, the
    single geometry funnel) (`81175dfe`). Two reducer-side fixes landed inside
    the same cutover: `parent-centered` now resolves against the PARENT's
    projected rect for this pass, not its pre-pass snapshot, via on-demand
    memoized recursion (`projectOne`/`resolveParentProjectedBounds` in
    `display-projection.ts`) — a `81175dfe` regression closed by `b8e44377`. And
    `WindowRecord.pendingProjectedBounds` (`window-state.ts`) — a projected rect
    the reducer now HOLDS instead of discarding when `DISPLAY_CHANGED` lands on
    a window that is fullscreen or hidden, flushed by `flushPendingProjection`
    from every transition that lifts one blocking axis (the `→ normal` fsMode
    transitions, `WINDOW_SHOWN`), emitted only once BOTH axes clear (`10c79748`)
    — closes a stranding gap the old inline `projectWindow()` walk had no retry
    mechanism for at all. R2: the `display-watcher.ts setBounds` allowlist entry
    is gone outright (28 entries / 56 calls, unchanged since). Tests:
    `display-projection.test.ts` (ordering, parent resolution, drops, purity) +
    `window-state.test.ts`'s `DISPLAY_CHANGED` describe (deferred/flush cases);
    270 pass, 0 fail across both files. `tsc --noEmit` clean.
    **Part B — Spaces: DONE.** `WindowRecord.visibleOnAllSpaces` and
    `SET_VISIBLE_ON_ALL_SPACES_REQUESTED` landed first as inert machinery
    (`af540e74`); the write paths then cut over — the port's
    `setVisibleOnAllSpaces` with its Electron implementation, the role-derived
    `SPACES_POLICY_REQUESTED` (which owns the follow/anchor decision and the
    anchor's ordered true-then-false pair), and the renderer-driven tile IPC on
    the raw event — so every `setVisibleOnAllWorkspaces` call now runs through
    the reducer. The listener this item called for closes it: the backend
    subscribes to the macOS active-Space notification and emits `SPACE_CHANGED`
    (§4.2 dim 7c). The notification says only THAT the Space changed —
    `userInfo` is empty, verified live — so the reducer stores nothing, and it
    emits nothing either: the all-Spaces flag is sticky, so there is nothing for
    a Space switch to undo, and a per-window re-assert mid-transition would be a
    speculative fix paid for with the native call this app has flash regressions
    on. The event lands wired but inert, as `visibleOnAllSpaces` itself first did
    (`af540e74`); the clause is where a re-assert would go if a dropped flag is
    ever actually observed.
11. **Session save / restore. Last.** Worst regression history in the app, and the one
    place doing bulk z-order plus focus as a single sweep.
    **Task 5 — the descriptor's pre-maximize rect collapses to one nested field: DONE.**
    A saved descriptor's `params` bag carried the pre-maximize rect as four flat numbers
    (`preMaxX`/`preMaxY`/`preMaxWidth`/`preMaxHeight`); it now rides as one nested
    `params.preMaxBounds` field, named exactly as the machine record names it
    (`WindowRecord.preMaxBounds`). `params.maximized` stays a flat boolean, mirroring
    `WindowRecord.maximized`. Migration: tolerant read, new shape on write — no one-shot
    rewrite pass over stored snapshots, because `session.ts saveSessionSnapshot()`
    already overwrites the whole snapshot row (`INSERT OR REPLACE INTO feature_settings
    ... VALUES ('session-snapshot', ...)`), so every stored row converts after one
    autosave cycle. `session-projection.ts readPreMaxBounds()` owns the tolerant read;
    its flat-bag branch exists only to absorb pre-collapse snapshots and can be deleted
    once those have aged out. **Known gap:** the tolerant-read seam is pinned only at
    the function level — no test drives a genuine pre-collapse ON-DISK snapshot through
    restore; the `readPreMaxBounds` suite in `session-projection.test.ts` exercises the
    function directly. Risk is low because `session.ts stripKeys` is an explicit
    deny-list that does not name these keys, so they are not at risk of being silently
    dropped on the way through.
    **Task 7 — restore replays the saved stack instead of rebuilding it from focus
    recency: DONE.** A saved descriptor recorded only `zOrder` (the record's `focusSeq`),
    and restore rebuilt the stack from it — so the restored order was a focus-recency
    ranking, not the order that was on screen. The two genuinely disagree: `WINDOW_SHOWN`
    raises a window in `stackOrder` on ANY show but bumps `focusSeq` only when the show
    focused it, so a window opened in the background sits visually above the last-focused
    window and ranks below it by recency — and the old restore put it back underneath. A
    descriptor now also carries `stackIndex`, its position in the machine's bottom→top
    `AppWindowState.stackOrder` at save time, and the post-loop `STACK_ORDER_IMPORTED`
    orders by it. Session restore restores the session as you left it.
    `zOrder` stays exactly what it was and keeps its OTHER job — the eager/deferred
    restore-loading split (`SESSION_EAGER_RESTORE_COUNT`): "load what you were last using
    first" is right even when the visual stack differs, so the two ranks are separate
    persisted facts rather than one collapsed one. The post-loop reconstruction step does
    not go away either — the restore loop's own non-activating shows scramble `stackOrder`
    mid-restore whatever feeds the final import.
    Migration: same strategy as task 5 — new shape on write, tolerant read, no one-shot
    pass, for the same reason (save rewrites the whole snapshot row every autosave).
    `session-projection.ts readStackIndex()` reads the field and
    `orderRestoredWindowsBottomToTop()` orders with it; its all-unrecorded branch is the
    old focus-recency ordering, commented as existing only to absorb pre-field snapshots
    and deletable once those age out. A window with no recorded position sorts below the
    recorded ones, so the import still names every restored window and the
    `stackDrives === restored count` invariant the focus specs assert is untouched.

    **The six tasks below landed on `main` after Task 5 and Task 7 above but had no
    write-up here until this pass. They are ordered chronologically by commit timestamp,
    which is NOT the same as their task numbers — see the collision note at the end.**

    **Task 11.1 (2026-07-26) — session SAVE reads `WindowRecord.visible`, not the OS:
    DONE.** `saveSessionSnapshot`'s early-skip block and `saveSpaceWorkspaces` no longer
    call `isVisible()` on the native handle; both route through one helper,
    `isWindowVisiblePerMachine(electronWindowId)`, joining the Electron id onto the
    machine's `WindowRecord.visible` mirror (owned since §5 step 6). No-record fallback is
    `true` (treat as visible, save the window) — deliberately asymmetric: a false negative
    would silently drop a user window from the restored session, a false positive at worst
    leaves one stale entry. `isVisible` is a read, not in the R2 `FORBIDDEN` set, so this
    commit does not move the allowlist. Commit `43d0d4e4`.

    **Task 3 (2026-07-26) — restore focus routed through the machine: DONE.** The last two
    raw window ops in `session.ts` — the restore post-loop's `focusWin.focus()` and the
    one-shot cold-start `reassertColdStartFocusOnce()` — now dispatch
    `WINDOW_SHOW_REQUESTED {activate:true}` via `showWindowHeadlessSafe`. No new event was
    needed: in both sites the target window is already visible (shown inactive by the
    restore loop), so an activating show IS the activation. Bonus: `SHOW_WINDOW` echoes
    `WINDOW_SHOWN {focused:true}`, so `front` updates synchronously instead of waiting on
    the async OS focus event. Deleted the `session.ts` `focus` ×2 R2 entry — the only
    step-11-tagged one at the time (allowlist 26→25 entries / 46→44 calls). Commit
    `9e08523a`. **Collides in task number with Task 3 (2026-07-28) below.**

    **Task 4 (2026-07-26) — session SAVE becomes a pure projection of machine state:
    DONE.** `saveSessionSnapshot` mixed three jobs: reading OS/registry facts, deciding
    what the session is, and writing SQLite. The deciding job moves out whole into a new
    pure module, `session-projection.ts serializeSession(input)` (mirrors the
    `display-projection.ts` / `overlay-frame.ts` seam pattern); `session.ts` is now read →
    project → write and computes no window decisions. Every window-management fact in a
    descriptor is read off a machine `StateSnapshot`: `visible` from
    `WindowRecord.visible`, bounds from the restorable-geometry rule, `maximized`/the flat
    preMax bag from the record, `zOrder` from `focusSeq`, `focused` from
    `StateSnapshot.front`. On-disk shape proven unchanged two ways: a legacy-oracle
    text-diff across 15 fixture worlds, and a real headless A/B run (byte-identical
    snapshot/metadata rows modulo `createdAt`). One deliberate divergence: `focused` is
    now `machineId === snapshot.front` rather than joining front through
    `getNativeWindowFor(front).id` — the two disagree only if `front` is set while its
    native handle is already gone. Commit `52cb2235`. **Collides in task number with
    Task 4 (2026-07-28) below.**

    **Task 8 (2026-07-26) — the cold-start re-raise latch becomes reducer state: DONE.** A
    sweep of `session.ts`'s module-level mutable bindings, classifying each as window
    state (fold into the machine) or module state (keep, say why). Only one was genuine
    window state: the cold-start trailing-dance latch (`_coldStartReassertArmed` /
    `_coldStartReassertId`), which held "which window is meant to be in front" outside the
    machine and drove the OS itself from `reassertColdStartFocusOnce()`. It is now
    `AppWindowState.pendingColdStartFocus`, armed by `COLD_START_FOCUS_ARMED` (dispatched
    by the restore's focus block under the old gate: cold start + non-headless + window
    present) and consumed by `APP_ACTIVATED`, which re-fronts the window and drives
    `RAISE_WINDOW` + `FOCUS_CONTENT` + `SET_STACKING`. `reassertColdStartFocusOnce()` is
    deleted, along with `main.ts`'s `did-become-active` call and its test bridge. The
    survivors (`_restoreComplete`, `_firstFrameProducerInstalled`, the autosave timer +
    interval, the `_restore*Count` test-observability block) each get a one-line
    "why this stays module state" note in source. Commit `52cf2612`.

    **Task 3 (2026-07-28) — `CONTENT_FIRST_RESPONDER_CHANGED`, `WindowRecord.contentFocused`:
    DONE.** Adds the inbound event and record field that Task 4 (2026-07-28, below) reads:
    the backend's mirror of the renderer `WebContents` `focus`/`blur` pair. Commit
    `c43843cc` (a one-line commit message; no further detail is available from the log).
    **Collides in task number with Task 3 (2026-07-26) above.**

    **Task 4 (2026-07-28) — re-key the Escape grab off `contentFocused`, not
    `frontAsserted`: DONE.** `deriveEscGrabRegistered`'s front-not-first-responder half now
    reads the front window's `WindowRecord.contentFocused` (fed by
    `CONTENT_FIRST_RESPONDER_CHANGED`) instead of the (now-deleted) machine's own
    `AppWindowState.frontAsserted`, which `frontAsserted` was only ever approximating. Old
    predicate: `appActive && (front === null || !frontAsserted)`. New:
    `appActive && (front === null || front's record.contentFocused === false)`. Absent
    (`contentFocused === undefined`, "nothing reported yet") does NOT arm the grab — only
    an explicit `false` does; two cases land on absent and must not permanently arm it (a
    browser-kind front, which never gets this event at all, and a page-host between a
    just-driven `FOCUS_CONTENT` and the async native `focus` event it produces).
    Live-verified against the original 7fffa286/7c61e917 regression pair that
    `frontAsserted` originally existed to guard: a real app resign fires the content blur
    before `APP_RESIGNED` itself, so `contentFocused` is already `false` by the time the
    app goes inactive. Commit `555ff5fb`. **Collides in task number with Task 4
    (2026-07-26) above.**

    **Task-numbering collision, noted rather than fixed:** the 2026-07-26 and 2026-07-28
    sessions each independently shipped a "Task 3" and a "Task 4" for step 11. Commit
    history is immutable, so this document does not renumber them — dates disambiguate:
    "Task 3 (2026-07-26)" (`9e08523a`, restore focus routed through the machine) is
    unrelated to "Task 3 (2026-07-28)" (`c43843cc`, `CONTENT_FIRST_RESPONDER_CHANGED`);
    "Task 4 (2026-07-26)" (`52cb2235`, session SAVE as a pure projection) is unrelated to
    "Task 4 (2026-07-28)" (`555ff5fb`, the Escape-grab re-key). Any future step-11 task
    number should be checked against this list to avoid a third collision; past ones stay
    as committed.

    **Step 11 remaining work:** as of this pass, no commit or doc evidence was found of
    any step-11 task beyond the eight above (11.1, two Task 3s, two Task 4s, Task 5,
    Task 7, Task 8) — the R2 allowlist carries zero entries tagged step 11
    (`scripts/check-r2-window-ops.mjs`). Whether step 11 has further tasks left is
    therefore genuinely open; this document gives no basis to enumerate them, and none
    should be invented. A future agent auditing step 11 should start from the "Accepted
    behavior loss" and "Restored z-order" notes in §6.

**Live verification is mandatory at every seam cutover that touches focus.** macOS
first-responder behavior is **unobservable in headless tests** and a green headless suite
has produced false confidence on this exact family of bugs twice already. The protocol:
instrument in a clone, commit the instrumentation, launch, have the **operator perform only
the reproduction gesture** — the agent does everything else, including reading the log and
cleaning up.

---

## 6. Current state

**Superseded by "Where we are" at the top of this document — read that first.** What
follows is a recount taken directly against §4 for this pass, not a copy of the figure
this section previously carried (which was stale). §4 has ~24 dimension entries; 2 of
them (dim 10, and the explicitly out-of-scope "Peek / slide content features" line) are
OUT OF SCOPE and don't count either way. Of the remaining 22 in-scope dimensions,
**18 are owned or fine-as-is** (ABSORBED / DONE / OWNED-KEEP-AS-IS: 1a, 12, 2, 2b, 3, 3b,
4, 5b, 4b, 6b, 7, 7b, 7c, 8a, 8b, 9, 11, 5c) and **4 are still genuinely open** (1b —
new-window-vs-reuse dedup; 6 — roles + session tri-state, partial; 4c — deferred/lazy
content load, partial; 5 — session save/restore, PARTIAL per §5 step 11). Four of the 18
"owned" dimensions (2, 4, 7b, 9) had stale "TO ABSORB" markers in §4 at the start of this
pass — their bodies (or the linked §5 steps' bodies) already documented the landing, but
the opening status word on the dimension itself hadn't been updated to match. Verified
directly: `window-state.ts` carries `visibleOnAllSpaces` (dim 7b) and `WindowRecord`'s
`visible` field is fed only by `shown`/`hidden` events (dim 4, confirmed by the §5 step
11.1 commit `43d0d4e4`'s own description); no `getFocusedWindowId` symbol remains
anywhere in `apps/desktop/main/`, and `entry.ts` / `tile-ipc.ts` no longer call
`BrowserWindow.getFocusedWindow()` live, only in comments (dim 9). Dim 2's "Step 7 is
DONE" sentence is already in its own body (§4.2). **The stale marker words themselves are
NOT rewritten in this pass** — out of scope for this truthing pass, which was scoped to
§6 and dim 3b specifically; a follow-up should fix the four inline markers to match.

Migration steps landed since this document was written: the id space (§5 step 1), the
port (§5 step 2), the R2 enforcement check (§5 step 3), special window classes + registry
unification (§5 step 4), z-order/stacking (§5 step 5), visibility (§5 step 6),
geometry/maximize (§5 step 7), displays and Spaces (§5 step 10) are all DONE; focus
rivals (§5 step 8) and overlay attach/retarget + transient autoclose (§5 step 9) are each
PARTIAL with a handful of allowlisted residual call sites; session save/restore (§5 step
11) is PARTIAL with 8 tasks landed. See "Where we are" for the live per-step table. The
machine is live behind the seams already cut over (`window-state-singleton.ts` lists the
authorities it replaced).

**`apps/desktop/main/window-state.ts`** — the owner, as R1 describes it, for the dimensions
it covers. Pure, zero imports, 187 unit tests in `window-state.test.ts`, keyed by
`WindowId`. It owns: `front` (a pure projection of OS focus — the most recently
OS-focused front-eligible window, written only by `applyFocusGained`), the switcher
state, the Escape decision (`applyEscape`), fullscreen mode,
satellite classification (`isSatelliteRegistration`), window classes
(`classifyWindowRegistration` + the record's closed `class` enum), the stacking level +
ordered z-order list (`deriveStackingLevel`, `AppWindowState.stackOrder` — §5 step 5),
the window-manager
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
`test:desktop:electron` chain: **23 allowlisted entries / 37 calls** as of this pass
(`node scripts/check-r2-window-ops.mjs`, 2026-07-29 — see "Where we are" at the top of
this document for the canonical live count), each tagged with the §5 step that deletes
it. The sole exempt file is `apps/desktop/main/electron-window-backend.ts` (swapped from
the executor when the port landed). The entry count is the migration's progress bar; it
only goes down.

**The machine's separate belief about front is deleted; `front` is a pure projection of
OS focus** (commit ef200b7c) — the claim field, its invalidation clause, and the
closing-assertion step that used to run at the tail of `reduce` are gone. `front` itself
survives: the most recently OS-focused front-eligible window, written only by
`applyFocusGained`, reached from BOTH `OS_FOCUS_GAINED` and `WINDOW_SHOWN {focused:true}`.
The machine no longer holds a value that can disagree with what macOS reports and then
re-drive the OS to match it.

- **`applyRaiseRequest` is the sole `RAISE_WINDOW` emitter**, reached from
  `RAISE_WINDOW_REQUESTED` and four user-act sites: switcher selection
  (`SWITCHER_SELECTED`), the `WINDOW_CLOSED` parent/successor handoff, devtools
  open/close (`DEVTOOLS_OPENED`/`DEVTOOLS_CLOSED`), and `applyEscape`'s close-switcher
  branch.
- **Two focus-bearing events, deliberately different.** `OS_FOCUS_GAINED` moves `front`
  AND runs `selectTransientAutoclose`; `WINDOW_SHOWN {focused:true}` moves `front` but does
  NOT sweep, because it is a registration-time visibility import
  (`decideWindowRegistration.pumpShownEvent`) rather than evidence the OS moved focus.
  Conflating them is what caused the command-palette flash-and-vanish.
- **`applyOsFocusRealized`** carries what the deleted assertion's record-not-echo branch
  did: on an `OS_FOCUS_GAINED` for the current front, it pushes `FOCUS_CONTENT` for a
  page-host and calls `stackRaise` on the window — mirroring an order the OS already
  performed, never re-driving a raise back at it.
- **The Escape grab is derived from `WindowRecord.contentFocused`** — the backend's mirror
  of the renderer WebContents `focus`/`blur` pair — not from a machine-side claim. Absent
  means "nothing reported yet" and does NOT arm the net.
- **Termination of the `pump` drain is now structural**, not an ordering coincidence: no
  arm reachable from `RAISE_WINDOW`'s `WINDOW_SHOWN` echo may call `applyRaiseRequest` —
  concretely, the `WINDOW_SHOWN` and `OS_FOCUS_GAINED` arms never call it. A unit test pins
  this: `INVARIANT: no RAISE_WINDOW is emitted from WINDOW_SHOWN or OS_FOCUS_GAINED (the
  pump's convergence obligation)`.

**Accepted behavior loss:** `APP_ACTIVATED` no longer drives stack order for an unchanged
`front` — macOS restores the app's own window order on activation, and `stackOrder`
(intent) never moved while the app was away, so there is nothing to re-drive. Unverified
on a real display.

**Restored z-order is a literal replay of the pre-quit visual stack** (§5 step 11 task 7).
Each saved descriptor records its position in the machine's `stackOrder`
(`WindowDescriptor.stackIndex`), and restore imports that order via
`session-projection.ts orderRestoredWindowsBottomToTop()`. It used to be rebuilt from focus
recency, which inverted any window that had been shown without being focused. Live-verified
on macOS before the front-projection rewrite (visible run, quit→relaunch): the window
focused at quit restores focused and on top, with a clean 6/6 save set (no
background/overlay/bridge leakage).

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
