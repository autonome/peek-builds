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
  (Electron window ids, Electron webContents ids, and synthetic ids).
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

**Window identity is an opaque WM-assigned id.** Not an Electron window id. Today there
are **three colliding id spaces**:

1. Electron window ids (`windowRegistry`, `WindowRecord`, most of `main.ts`),
2. Electron webContents ids (`webview-guest-registry.ts guestToHost`,
   `hybrid-editable-focus.ts editableByWcId`, `tile-ipc-gate.ts perWcOriginalSend`) —
   numerically indistinguishable from window ids, so a mix-up is silent,
3. synthetic ids from `window-registry.ts nextSyntheticId`, counting **down** from
   `Number.MAX_SAFE_INTEGER` specifically to avoid colliding with the other two — an
   explicit acknowledgement in code that the id spaces are unsafe.

A single WM-owned id space is a **precondition** for the port, not a later cleanup. The
backend maps `WindowId -> platform handle` internally and never leaks the handle.

**First implementation:** `ElectronWindowBackend`. Portability targets that justify the
shape: Tauri, ElectroBun, native Swift.

---

## 4. The state model — all dimensions, one owner

Everything below is window management and belongs to the WM unless marked otherwise.
`OWNED TODAY` = already inside the reducer. `TO ABSORB` = must move in, deleting its
current authority. `OUT OF SCOPE` = genuinely not window management.

### 4.1 Identity and creation

**1a. Window identity / params** — TO ABSORB.
Today: `main.ts` module-level `windowRegistry` Map, mutated in place by six-plus writers
with no invariant.
Becomes: the reducer's window table, keyed by WM id, written only by reducer transitions.

**1b. New-window-vs-reuse dedup** — TO ABSORB.
Today: not held anywhere; recomputed on every open from **two parallel dedup ladders**
(the hybrid registry and `windowRegistry`) plus `ipc.ts pendingWindowKeys`. Every reuse
branch calls show/focus directly — a straight R2 violation, repeated four times.
Becomes: a dedup key index in reducer state; open requests dispatch an intent event and the
reducer answers reuse-or-create.

**12. Pending / unrealized windows** — TO ABSORB.
Today: `window-registry.ts refs`, with synthetic ids from `nextSyntheticId` counting down
from `Number.MAX_SAFE_INTEGER`, realized by a focus request.
Becomes: a `pending` lifecycle phase on the ordinary reducer window record — same id
space, no synthetic range, realization is a transition.

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

**8b. Special window classes** — TO ABSORB. *(Top divergence risk #5.)*
Today: **8+ independent singletons** — `main.ts mainWindow` and `backgroundWindow`,
`core-glue.ts coreBackgroundWindow`, `test-fixture-glue.ts testFixtureWindow`,
`hybrid-overlay.ts overlayWin`, `tile-lifecycle.ts bgWindow`, `tray.ts tray`,
`chrome-extensions.ts extensionUiWindows` and `_bridgeWindows`. HUD, bridge, extension-UI
and test-fixture windows are **unclassified** — not satellite, not anything. The HUD is
identified by sniffing `isAlwaysOnTop() && !isFocusable()` plus a `(win as any).__hudHidden`
expando.
Becomes: a `class` field on the window record with a closed enum
(`primary | quick-view | overlay | palette | hud | background | bridge | extension-ui |
test-fixture`). Every singleton becomes a lookup by class. The expando and the sniffing
predicate are deleted.

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

**8a. Devtools windows** — TO ABSORB.
Today: no held state at all; entirely live queries.
Becomes: devtools windows register like everything else, with class `devtools`, and a
devtools open/close invalidates the front assertion.

**11. WebContents ↔ window mapping** — TO ABSORB (id space only).
Today: `webview-guest-registry.ts guestToHost`, `hybrid-editable-focus.ts editableByWcId`,
`tile-ipc-gate.ts perWcOriginalSend` — all keyed by webContents ids that are numerically
indistinguishable from window ids.
Becomes: these keep their own concerns, but re-key onto WM ids so the collision hazard is
gone. Their *content* concerns are not the WM's business.

**10. Per-window context / mode** — OUT OF SCOPE (but re-key).
`datastore.ts windowContextState`, keyed by window id plus a `null` key for global. This is
application content state, not window management. It stays where it is; it must adopt the
WM id space, and it must be told when a window dies.

**Peek / slide content features** — EXPLICITLY OUT OF SCOPE. What a peek *shows*, how a
slide *animates its content*, what the switcher *lists* — none of that is window
management. The WM owns whether those windows exist, where they are, what is front, and
what Escape does. It owns nothing about what is inside them.

---

## 5. Migration sequence

Ordered so the highest-regression-risk area lands last. **Each step deletes its old
authority in the same commit. Nothing runs in parallel with its replacement — that is the
failure mode this document exists to prevent (§2).**

1. **Id space.** Introduce the WM id. Collapse `window-registry.ts` synthetic ids into it.
   Re-key the webContents-keyed maps. Nothing else can be trusted until ids are.
2. **The port.** Define `WindowBackend` and `ElectronWindowBackend`. Convert
   `window-os-adapter.ts` to call the port; delete its Electron imports.
3. **R2 enforcement check.** Land the CI grep now, not at the end, with the current
   violations listed as an explicit shrinking allowlist. The allowlist only ever gets
   shorter; a PR that lengthens it fails.
4. **Special window classes + registry unification.** Absorb `windowRegistry`, the 8+
   singletons, devtools. Delete `__hudHidden` and the always-on-top sniffing predicate.
5. **Z-order / stacking.** Give the reducer stacking. This is what makes `frontAsserted`
   sound (§6) and it must precede session restore.
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

Roughly **1.5 of ~19 dimensions** are owned. That is the honest number.

**`apps/desktop/main/window-state.ts`** — the owner, as R1 describes it, for the dimensions
it covers. Pure, zero imports, 113 unit tests in `window-state.test.ts`. It owns:
`front` (intent), `frontAsserted` (the claim that the OS matches that intent), the switcher
state, the Escape decision (`applyEscape`), fullscreen mode, satellite classification
(`isSatelliteRegistration`), and MRU focus order. This is the nucleus; everything in §4
grows into it rather than beside it.

**`apps/desktop/main/window-os-adapter.ts`** — the executor, as R2 describes it, but **still
Electron-coupled**. It must become the port implementation's only caller (§5 step 2). Its
`runEffect` is already the single funnel; the coupling is the remaining defect, not the
structure.

**`frontAsserted` is CURRENTLY UNSOUND**, and this must not be papered over. It claims "we
have driven the OS to match `front`," but **nothing owns z-order** (§4.3, dimension 3):
`session.ts` drives `moveTop()` during restore and during cold-start re-assert without ever
informing the reducer, and macOS silently **no-ops `moveTop` for a non-frontmost app**. So
`frontAsserted` can read `true` while the window is buried behind another window — the
reducer believes the assertion holds and the Escape-grab safety net
(`deriveEscGrabRegistered`) stays off. The assertion model does not become trustworthy
until step 5 of §5 lands. Until then, treat `frontAsserted === true` as "we issued the
raise," not "the window is on top."

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
