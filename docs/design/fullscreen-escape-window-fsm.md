# One deterministic window state machine: front-window / fullscreen / Escape / switcher

Design blueprint. Status: approved-for-implementation draft (this doc is the spec the
next session implements from). Directive: "I want ONE deterministic system" — an
explicit state machine with named states, one transition owner, illegal states
unrepresentable, no event-listener backdoors.

---

## 1. Current-state map — what exists, and where it diverges

### 1.1 The scattered state variables

| # | State | Owner today | Writers | Readers |
|---|---|---|---|---|
| S1 | `lastFocusedVisibleWindowId` (module `let`) | `ipc.ts` | `trackVisibleWindowFocus`, `trackHybridWindowFocus`, `trackOnWindowFocus` (3 writers, heterogeneous focus events); cleared only by `clearLastFocusedVisibleWindowId` on window close | `resolveFocusedVisibleWindowId` rank 1 (via `tile:window:get-focused-visible-id` in `tile-ipc.ts`), devtools fallback, session-save focused descriptor |
| S2 | `activeHybridWindowId` | `hybrid-page-host-registry.ts` | single chokepoint `setActiveHybridWindowId`, fed by BaseWindow `focus`/`blur` (+ deferred `decideAfterBlur`), `show`/`hide`, `noteHybridWindowHidden`, close/unregister | overlay retarget (`onActiveHybridWindowChange`), Esc redirect (`resolveHybridEscapeTarget`), close target (`resolveCloseTargetId`), global-Esc predicate, resolver rank 3 |
| S3 | `nativeFullScreen` + `preFullScreenBounds` (hybrid entries ONLY) | `hybrid-page-host-registry.ts` | `setHybridNativeFullScreen` (driven by `enter-full-screen`/`leave-full-screen` wired in `ipc.ts assembleHybridPageHost`); stash set by `setHybridHostFullScreen` | Esc precedence (`escExitsHybridFullscreen`), presenter bounds (`window-presenter.ts getHybridPresentation`), overlay suppression |
| S4 | `lastContentWindowId` (module `let`) | `ipc.ts` | `trackContentWindowFocus`, `trackHybridWindowFocus` | `tile:window:devtools` |
| S5 | Focus-recency ledger | `focus-order.ts` (`noteWindowFocus`/`getFocusOrder`) | the same 3 focus trackers | session save restore-ranking |
| S6 | `_escGlobalRegistered` + the OS Escape grab | `main.ts updateEscGlobalRegistration` | re-evaluated from 5 listener sites (`browser-window-focus`, `browser-window-blur` deferred, `did-become-active` deferred, `did-resign-active`, `onActiveHybridWindowChange`) | pre-empts every `before-input-event` |
| S7 | IZUI session/overlay state (`idle/transient/active/overlay`) | `izui-state.ts` coordinator | `setAppFocused`, `enterOverlay`/`exitOverlay`(+`ForAppBlur`), cooldown timers | `escPolicy`, `escUnhandledPolicy`, switcher lifecycle |
| S8 | Non-hybrid fullscreen | **NOBODY** | raw `win.setFullScreen(!win.isFullScreen())` in `tile-ipc.ts tile:window:fullscreen` | nothing — no listener, no state, no Esc awareness |

### 1.2 The decision points that read them

- **Target of `fullscreen`/`maximize`/`center`/`tag`:** `features/windows/background.js`
  → `api.window.getFocusedVisibleWindowId()` → `tile-ipc.ts` builds SEVEN inputs and calls
  `izui-roles.ts resolveFocusedVisibleWindowId` (tracked-id S1 ranked FIRST, above the
  better-disciplined S2).
- **Fullscreen execution:** `tile-ipc.ts tile:window:fullscreen` — TWO routes: hybrid id
  → `setHybridHostFullScreen` (settle-aware, stateful); any live BrowserWindow → raw
  `setFullScreen()` (S8, unmanaged).
- **Escape:** FOUR entry points/deciders: (a) content-WC `before-input-event` in
  `ipc.ts wireHybridContentEvents` → `windows.ts handleHybridEscape` (redirect via
  `resolveHybridEscapeTarget`, fullscreen precedence via `escExitsHybridFullscreen`, then
  `handleEscapeForWindowId`); (b) per-BrowserWindow `addEscHandler` → same core; (c) the
  OS-level `globalShortcut('Escape')` in `main.ts` whose handler publishes
  `cmd:execute:windows` DIRECTLY — no fullscreen check, no shared decision; (d) the
  policy pair `escPolicy`/`escUnhandledPolicy` in `izui-state.ts`.
- **Close target (cmd+W):** `windows.ts resolveFocusedWindowIdForClose` →
  `izui-roles.ts resolveCloseTargetId` (S2 + overlay-id provider).
- **Global-Esc registration predicate:** `izui-roles.ts shouldRegisterGlobalEscFallback`
  (appActive, `getFocusedWindow()!==null`, S2 non-null).

### 1.3 Where they diverge — the illegal/ambiguous combinations

These are the observed bug mechanics; each is a combination the current model can
represent but should not be able to:

1. **S1 ≠ real front window.** S1 is last-writer-wins with no arbitration and is
   cleared only on CLOSE. A transient settings focus (Space-switch churn, restore
   dance) writes S1 = settings and nothing ever corrects it → `fullscreen` acts on the
   SETTINGS window. S2 has arbitration (satellite/overlay focus-group, deferred blur);
   S1 does not — yet the resolver ranks S1 first.
2. **S2 momentarily null while a host is visibly front.** Live trace
   (`/tmp/peek-fullscreen-diag.log`): `activeHybridWindowId=null` right after the host
   came forward; corrected ~3 s later. During that window every S2 reader (Esc redirect,
   close target, global-Esc predicate) sees "no hybrid window".
3. **Global Esc grab live while a window is fullscreen-front.** The predicate reads S2;
   Space-switch blur churn (or divergence #2) nulls S2 with no focused BrowserWindow
   → `shouldRegisterGlobalEscFallback` true → OS grab registers → grab PRE-EMPTS
   `before-input-event`, and its handler opens the switcher unconditionally. This is
   the just-failed-live path: target resolution was CORRECT (host 7, hybrid branch)
   and Esc still opened the switcher — the grab (or the `escUnhandledPolicy` fallthrough
   on a host whose S3 hadn't settled) fired without ever consulting fullscreen state.
   Four Esc deciders, four different state reads → whichever fires first wins.
4. **Fullscreen invisible for non-hybrid windows (S8).** A fullscreened settings window
   has NO state anywhere: Esc on it runs role `workspace` → `escPolicy` 'nothing' →
   `escUnhandledPolicy` 'open-switcher' — switcher over a fullscreen window, by design
   of the current model. Session-save also persists its fullscreen bounds (the
   lookalike trap fixed for hybrids by `aa34cb50` has no non-hybrid equivalent).
5. **"fullscreen flag set but window not in a fullscreen Space" (and inverse).** S3 is
   only as good as the settle events arriving; `setHybridHostFullScreen` times out after
   1.5 s and resolves WITHOUT reconciling S3 against reality. Nothing self-corrects.
6. **Esc semantics split-brained during the ask-renderer await.** `handleEscapeForWindowId`
   awaits the renderer up to 500 ms; state (S2, S3, overlay cooldowns) can change
   underneath, and the post-await decision re-reads the world.

The pattern: four+ independent stores, each with its own writers, each reader picking
its own precedence. Every fix so far (`c4a73259`, `ebb10894`, `9d50ea29`, `7c61e917`)
added one more pure predicate reconciling two of them at one seam — correct in
isolation, and the cluster re-breaks at the next unreconciled seam.

---

## 2. The proposed ONE system

### 2.1 Owner

New module **`apps/desktop/main/window-state.ts`** — the single owner of all
front/fullscreen/switcher/escape state. Structure:

- an `AppWindowState` value (below) held privately;
- ONE `dispatch(event)` entry — the only mutator; internally a **pure reducer**
  `reduce(state, event) → { state, effects[] }` (unit-testable, Electron-free);
- read-only selectors (`getFrontWindowId`, `getWindowMode`, `snapshot()` for tests);
- `subscribe(listener)` fired on actual transitions (replaces
  `onActiveHybridWindowChange`);
- effects are returned by the reducer and executed by the OS adapter (§2.6) — the
  reducer never touches Electron.

`izui-state.ts`'s coordinator stays for session semantics (`idle/transient/active`)
but its `overlay` responsibilities move here; see §3.

### 2.2 State shape — illegal states unrepresentable

```ts
type WindowKind = 'page-host' /* BaseWindow + WebContentsView */ | 'browser';

// Fullscreen is a MODE with explicit async edges, not a boolean.
// preFullScreenBounds lives INSIDE the non-normal variants: it cannot exist for a
// normal window, and a fullscreen window cannot lack the concept (null = OS-initiated
// entry where no stash was possible). This encodes the aa34cb50 lookalike fix
// structurally.
type FsMode =
  | { name: 'normal' }
  | { name: 'entering-fullscreen'; preBounds: Rectangle | null; pendingDesire?: boolean }
  | { name: 'fullscreen';          preBounds: Rectangle | null }
  | { name: 'leaving-fullscreen';  preBounds: Rectangle | null; pendingDesire?: boolean };

interface WindowRecord {
  id: number;
  kind: WindowKind;
  role: string;                 // existing izui role vocabulary
  escapeMode?: 'auto' | 'close' | 'navigate' | 'ignore';
  // Satellite = a surface that can hold OS focus but is never "the window the user
  // is working in": the shared chrome overlay, the command palette / modal dialogs,
  // the switcher overlay, HUD. Generalizes the registry's overlay focus-group AND
  // the resolver's modal exclusion into one declared property, set at registration.
  satellite: boolean;
  visible: boolean;
  fsMode: FsMode;
  focusSeq: number;             // MRU counter (absorbs focus-order.ts)
  lastHttpUrl?: string;         // absorbs lastContentWindowId (devtools)
}

interface AppWindowState {
  appActive: boolean;
  // THE target. Replaces S1 + S2 as separate truths. Invariant (asserted after every
  // transition, self-corrected in prod / thrown in dev+test): front is null or refers
  // to a live, visible, non-satellite record.
  front: number | null;
  switcher:
    | { open: false }
    | { open: true; windowId: number; previousFront: number | null };
  windows: Map<number, WindowRecord>;
}
```

Notes:
- There is deliberately NO "tracker" separate from `front`. Session-save's focused
  descriptor, command targeting, overlay retarget, close target, and the Esc target
  are all reads of `front`.
- Multiple windows may each be `fsMode:'fullscreen'` (separate macOS Spaces) — legal.
- `switcher.open` implies `windows` contains `switcher.windowId` with role `overlay`;
  `previousFront` is the restore target (absorbs the coordinator's
  `preOverlayFocusTarget`/`overlayFocusTarget`).

### 2.3 Events (the complete input alphabet)

Normalized by the OS adapter — no other module attaches native listeners.

| Event | Source (adapter) |
|---|---|
| `WINDOW_REGISTERED {id, kind, role, satellite, escapeMode}` | window-open paths (both kinds) |
| `WINDOW_SHOWN {id, focused}` / `WINDOW_HIDDEN {id}` / `WINDOW_CLOSED {id}` | show/hide/close seams + native `show`/`hide`/`closed` safety net |
| `OS_FOCUS_GAINED {id}` | BrowserWindow `focus`, BaseWindow `focus`, content-WC `focus` — all three collapse here |
| `OS_FOCUS_SETTLED_NULL` | the ONE deferred-blur settle (adapter, §4) concluded focus left all Peek windows |
| `APP_ACTIVATED` / `APP_RESIGNED` | `did-become-active` / `did-resign-active` |
| `FULLSCREEN_REQUESTED {id?, desired?}` | `tile:window:fullscreen`, green button intent, Esc exit, teardown exits; `id` defaults to `front` |
| `OS_FULLSCREEN_ENTERED {id}` / `OS_FULLSCREEN_LEFT {id}` | native `enter-full-screen` / `leave-full-screen`, wired for BOTH kinds at registration (closes S8) |
| `FULLSCREEN_SETTLE_TIMEOUT {id}` | adapter's bounded timer (1.5 s, as today) |
| `ESC_PRESSED {landedId \| 'global'}` | `before-input-event` (both kinds) AND the global grab handler — same event |
| `ESC_RENDERER_ANSWER {id, handled, close}` | reply to the ask-renderer effect |
| `SWITCHER_OPEN_REQUESTED` / `SWITCHER_SELECTED {id \| null}` | `cmd:execute:windows`, switcher UI |

### 2.4 Transition table (decision-dense core)

**Front arbitration** (kills divergences #1 and #2):

- `OS_FOCUS_GAINED(id)`:
  - `windows[id].satellite` → **no front change** (bumps `focusSeq` only). The chrome
    overlay, palette, dialogs and switcher can never clobber the target. This replaces
    `decideAfterBlur`'s overlay focus-group AND the resolver's modal exclusion.
  - any window `entering-`/`leaving-fullscreen` → **ignored for front** ("transition
    pin"): the macOS Space switch focuses random windows mid-animation; front stays
    pinned to the transitioning window until it settles. This is what makes the
    settings-clobber impossible.
  - else → `front = id`, bump `focusSeq`.
- `FULLSCREEN_REQUESTED(id)` → `front = id` (making a window fullscreen makes it the
  target) then the fsMode edge below.
- `OS_FOCUS_SETTLED_NULL` → front UNCHANGED (the target must survive an app switch;
  it is corrected only by hide/close/next-focus). `appActive` handles "is Peek front".
- `WINDOW_HIDDEN`/`WINDOW_CLOSED(id)`: record updated/removed; if `id === front`,
  `front =` highest-`focusSeq` visible non-satellite window, else null. (No more
  "cleared only on close, stale forever" — hide corrects too, and there is always a
  deterministic successor.)
- `WINDOW_SHOWN(id, focused)`: `focused` → as `OS_FOCUS_GAINED`; non-satellite shown
  while `front === null` → seed `front = id` (covers the restore/`show:false` case the
  old resolver's ranks 4–5 patched).

**Fullscreen** (per-window `fsMode`; total over every (mode × event) pair):

| From \ Event | `FULLSCREEN_REQUESTED` (toggle/desired) | `OS_FULLSCREEN_ENTERED` | `OS_FULLSCREEN_LEFT` | `FULLSCREEN_SETTLE_TIMEOUT` |
|---|---|---|---|---|
| `normal` | → `entering` (stash `preBounds = getBounds()` via effect-captured value); effect `setFullScreen(true)` | → `fullscreen` (`preBounds:null` — OS/green-button initiated) | no-op | n/a |
| `entering` | record `pendingDesire` (coalesce; no second `setFullScreen` mid-animation) | → `fullscreen` (keep stash); then if `pendingDesire===false` re-dispatch request | → `normal` (aborted by OS) | effect `reconcile(id)` (§2.6) |
| `fullscreen` | → `leaving`; effect `setFullScreen(false)` | no-op | → `normal` (clear stash; OS/green-button initiated leave) | n/a |
| `leaving` | record `pendingDesire` | → `fullscreen` (OS won) | → `normal` (clear stash); then honor `pendingDesire===true` | effect `reconcile(id)` |

`setFullScreen` is called in EXACTLY ONE place (the adapter executing these effects)
for BOTH window kinds — the raw route in `tile-ipc.ts` is deleted. The settle-await
that callers like tests want is `waitForMode(id, mode)` on the machine, not a promise
inside the mutator.

**Escape — one total decision.** `ESC_PRESSED` runs `decideEscape` inside the reducer;
BOTH the `before-input-event` path and the global grab dispatch the same event, so a
stale grab is harmless (defense by shared decision, not by registration timing):

```
decideEscape(state):
  1. state.switcher.open                → CLOSE_SWITCHER (restore previousFront)
  2. t = state.front; t == null         → OPEN_SWITCHER   (the old global-fallback case)
  3. windows[t].escapeMode == 'ignore'  → PASS_THROUGH
  4. windows[t].fsMode.name != 'normal' → EXIT_FULLSCREEN(t)   // entering/full/leaving all exit
  5. → effect ASK_RENDERER(t); on ESC_RENDERER_ANSWER{handled:true} → done
  6. role × session policy table (absorbs escPolicy + escUnhandledPolicy verbatim)
       → CLOSE_WINDOW(t) | OPEN_SWITCHER | NOTHING
```

Key properties: step 4 precedes EVERY switcher outcome in EVERY entry path, making
the live failure (switcher over fullscreen) structurally impossible; the target is
always `front` — `landedId` is treated as first-responder noise (generalizing
`resolveHybridEscapeTarget`'s redirect: the landed WC is only used as the reply
channel when `landedId === front`). The overlay-exit cooldown collapses into the
switcher state: an Esc that closed the switcher consumed itself (steps run once per
event), so the 300 ms cooldown timer in the coordinator and in `escGlobalHandler`
is deleted, not ported.

**Switcher:** `SWITCHER_OPEN_REQUESTED` → `switcher = {open, windowId, previousFront: front}`
+ effect open-overlay-window (the existing windows-feature tile still renders it);
`SWITCHER_SELECTED(id|null)` → `switcher = {open:false}`, `front = id ?? previousFront`
+ effects raise/activate. `APP_RESIGNED` while open → close without focus theft
(today's `exitOverlayForAppBlur`).

**Derived (never stored):**
- Global Esc grab: registered ⇔ `appActive && front === null && !switcher.open`.
  A subscriber (in the adapter) reconciles the OS registration to this predicate on
  every transition — replacing 5 listener call sites; the handler dispatches
  `ESC_PRESSED{'global'}` (never publishes `cmd:execute:windows` directly).
- Command target: `getFrontWindowId()` — replaces `resolveFocusedVisibleWindowId` and
  its 7 inputs.
- Close target (cmd+W): `front` — replaces `resolveCloseTargetId` (satellite rule
  already excludes the chrome overlay).
- Overlay chrome retarget: `subscribe` on front+visibility — replaces
  `onActiveHybridWindowChange`.
- Session-save: focused descriptor = `front`; restore ranking = `focusSeq`;
  persistable bounds = `fsMode.preBounds ?? getBounds()` (now for both kinds).
- Devtools target = `lastHttpUrl`-bearing record with highest `focusSeq`.

### 2.5 Self-correction (illegal states that OS async could still produce)

- Front invariant checked after every transition; violation self-corrects to the MRU
  successor (and throws in dev/test so the reducer bug is caught, not papered).
- `reconcile(id)` effect (only on settle-timeout and on `APP_ACTIVATED`): the adapter
  reads actual `isFullScreen()` ONCE and dispatches the matching
  `OS_FULLSCREEN_ENTERED/LEFT`, snapping `fsMode` to reality. This is the single
  sanctioned OS poll; no other code may read `isFullScreen()` for state.

### 2.6 The OS boundary adapter

New module **`apps/desktop/main/window-os-adapter.ts`** — the ONLY file that touches
native window events/effects for this domain:

- attaches, at `WINDOW_REGISTERED` time for BOTH kinds: `focus`, `blur`, `show`,
  `hide`, `closed`, `enter-full-screen`, `leave-full-screen` (+ content-WC `focus`
  for page-hosts), each a one-line `dispatch(...)`;
- owns the ONE deferred-blur settle (§4) that emits `OS_FOCUS_SETTLED_NULL`;
- executes effects: `setFullScreen`, show/raise/activate + `contentWC.focus()`
  (the first-responder invariant from `shouldFocusHybridContentOnHostFocus` becomes
  the standard effect on any transition that makes a page-host front), grab
  register/unregister, ASK_RENDERER (`escape-pressed` IPC, unchanged protocol),
  open/close switcher window.

---

## 3. Migration / deletion plan — old paths GONE, not dual-run

Implementation lands as one stack: introduce `window-state.ts` + adapter with the
reducer fully unit-tested FIRST, then cut consumers over seam by seam, deleting each
old path in the same commit that reroutes it. Grep for every symbol below before
calling it done.

**DELETE (folded into the machine):**

- `ipc.ts`: `lastFocusedVisibleWindowId`, `lastContentWindowId`,
  `trackVisibleWindowFocus`, `trackContentWindowFocus`, `trackOnWindowFocus`,
  `trackHybridWindowFocus`, `clearLastFocusedVisibleWindowId`,
  `clearLastContentWindowId`, `getLastFocusedVisibleWindowId`,
  `getLastContentWindowId`, the `onHybridHostFocus` tracker feed + the
  `enter/leave-full-screen` wiring in `assembleHybridPageHost` (adapter owns them).
- `hybrid-page-host-registry.ts`: `activeHybridWindowId`, `setActiveHybridWindowId`,
  `getActiveHybridWindowId`, `onActiveHybridWindowChange`, `decideAfterBlur`,
  `pendingBlurChecks`, `anyHybridContentFocused`, `setOverlayFocusProvider`,
  `noteHybridWindowHidden` (active-clearing half; the chrome-hide intent becomes
  `WINDOW_HIDDEN`), entry fields `nativeFullScreen`/`preFullScreenBounds`,
  `setHybridNativeFullScreen`, `setHybridHostFullScreen` (its settle-aware pattern IS
  the machine's fullscreen table, generalized to both kinds). The registry shrinks to
  what it is well-suited for: object ownership (baseWin/contentWC/key/deferredLoad/
  maximize) — no focus/fullscreen state.
- `izui-roles.ts`: `resolveFocusedVisibleWindowId`, `resolveHybridEscapeTarget`,
  `escExitsHybridFullscreen`, `shouldRegisterGlobalEscFallback`,
  `resolveCloseTargetId`, `shouldFocusHybridContentOnHostFocus` — each becomes a
  clause of the reducer/`decideEscape`; port their unit tests to reducer tests so no
  covered regression is dropped.
- `izui-state.ts`: `escPolicy`, `escUnhandledPolicy` (absorbed as `decideEscape`
  step 6), `enterOverlay`/`exitOverlay`/`exitOverlayForAppBlur` overlay bookkeeping +
  both overlay cooldowns (replaced by switcher state; the hide/restore of other
  windows becomes machine effects). Coordinator keeps only session
  `idle/transient/active` + `setAppFocused` mirroring `appActive`.
- `windows.ts`: `handleHybridEscape`, `handleEscapeForWindow`,
  `handleEscapeForWindowId`, `addEscHandler`'s decision half (the
  `before-input-event` attach moves to the adapter; debounce stays there as input
  hygiene), `resolveFocusedWindowIdForClose` (becomes `front` read).
- `main.ts`: `updateEscGlobalRegistration`, `escGlobalHandler`,
  `_escGlobalRegistered`, and the five re-evaluation call sites; the
  `did-become/resign-active` handlers keep their HUD/overlay chores but dispatch
  `APP_ACTIVATED/RESIGNED` instead of poking Esc registration.
- `tile-ipc.ts`: `tile:window:fullscreen` BOTH branches → `dispatch(FULLSCREEN_REQUESTED)`
  (deletes the raw `win.setFullScreen()` route — S8); `tile:window:get-focused-visible-id`
  body → `getFrontWindowId()`; `tile:window:devtools` fallback → machine selector;
  all `fsDiag` tracing (replaced by the machine's transition log).
- `focus-order.ts` (whole module): `focusSeq` in the record replaces it;
  `window-registry.ts`/`session.ts` consumers read the machine.
- `features/windows/background.js`: unchanged API surface; the fire-and-forget
  dispatch comment (palette-spinner fix `d18e9aef`) remains valid — `FULLSCREEN_REQUESTED`
  returns immediately by construction.

**KEEP (genuine OS shims, one per boundary):**

- `hybrid-overlay.ts` `fullscreenable: false` + follow-suppression while host
  fullscreen (`0687a1f5`) — hard AppKit boundary (black-tile promotion), lowest layer.
- `showHybridHost`/`hybridShowIntent` (`windows.ts`) — show/activation intent; the
  adapter calls it as an effect.
- `window-presenter.ts` — reads `fsMode.preBounds` from the machine instead of the
  registry entry; otherwise unchanged.

**SUPERSEDED commits in the current stack** (next agent: collapse these — their
mechanisms are absorbed, their regression tests port to reducer tests):

- `c4a73259` Esc-exits-fullscreen precedence → `decideEscape` step 4.
- `aa34cb50` fullscreen-lookalike session-save fix → `preBounds` inside `FsMode`.
- `0687a1f5` overlay-out-of-fullscreen → KEPT as-is (OS shim).
- `d18e9aef` palette release before Space switch → behavior preserved by construction.
- `5b363f17` debug-list-windows `nativeFullScreen` → re-point to machine snapshot.
- `066e210f`, `7d232a11` DEBUG traces (`[fs-target]`/`[fs-toggle]`/Esc decision) →
  DELETE; the machine's transition log replaces them.
- Earlier landed fixes absorbed the same way: `efde7394` (single hybrid fullscreen
  owner → generalized), `ebb10894` (`shouldRegisterGlobalEscFallback` → derived grab),
  `9d50ea29` (`resolveCloseTargetId` → front), `7c61e917`
  (`shouldFocusHybridContentOnHostFocus` → standard front-change effect),
  `8e5c3174` transient-sibling autoclose (stays, but triggered from the machine's
  front-change subscription instead of raw focus handlers).

---

## 4. macOS boundary constraints the design must respect

1. **Native fullscreen is async (~600 ms) and Space-switching.** Only
   `enter/leave-full-screen` mark completion; `isFullScreen()` flips mid-animation.
   → Modeled as explicit `entering/leaving` states; the settle events are the only
   edges into `fullscreen`/`normal`; the transition PIN ignores focus churn while a
   transition is in flight (this is the fix for the observed S2-null lag and the
   settings-clobber). Bounded timeout → `reconcile`, never a blind resolve.
2. **`globalShortcut` pre-empts `before-input-event`.** Any OS grab that exists will
   eat the key first. → Exactly one grab, derived from machine state, whose handler
   dispatches into the SAME `decideEscape` — correctness no longer depends on
   registration racing focus events.
3. **BaseWindow focus quirks:** `BrowserWindow.getFocusedWindow()` is null for a
   page-host, and non-null-but-wrong when the chrome overlay holds focus; BaseWindows
   don't fire `browser-window-focus`. → No consumer reads `getFocusedWindow()`;
   the adapter normalizes both kinds into `OS_FOCUS_GAINED`, and satellites are
   declared, not inferred.
4. **Blur→focus event ordering:** Electron fires old-window `blur` before new-window
   `focus`, so "focus left Peek" is only knowable one tick later. → The ONE
   deferred-blur settle lives in the adapter (commented as this boundary), emitting
   `OS_FOCUS_SETTLED_NULL`; the reducer itself has no timers. This is the single
   necessary shim on the focus path — the per-registry `decideAfterBlur` copy is
   deleted, not joined.
5. **First responder is unobservable headless**, and headless must never steal focus.
   → All decisions are pure reducer clauses (testable headless); focus side effects
   run only in the adapter, gated on `isHeadless()` exactly as `hybridShowIntent`
   does today.

---

## 5. Verification strategy

1. **Pure-reducer unit suite** (`window-state.test.ts`, runner 1): totality check —
   every (state-class × event) pair returns a defined transition (exhaustive matrix
   over `fsMode × switcher × satellite × escapeMode × role`); invariant check after
   every transition (front validity); regression ports of every superseded predicate
   test (`izui-roles.test.ts`, `focused-window-tracking.test.ts`,
   `hybrid-page-host-registry.test.ts` active-id/fullscreen suites).
2. **Scenario replays as event scripts.** Each historical bug becomes a literal event
   sequence asserted against the reducer: the Space-switch settings clobber; the
   S2-null lag; grab-alive-during-fullscreen → `ESC_PRESSED('global')` must yield
   `EXIT_FULLSCREEN`; switcher-over-fullscreen; the palette-issuer exclusion;
   OS-initiated (green button) fullscreen on a settings window.
3. **Transition log.** The owner logs one line per transition
   (`[window-state] EVENT … front a→b mode(id) x→y`), DEBUG-gated — the permanent
   replacement for the ad-hoc `fsDiag`/`[esc]`/`[focus-tracker]` traces, so the next
   live repro needs zero instrumentation.
4. **Playwright via the existing hybrid test bridge:** a `snapshot()` test hook;
   re-point the disruptive fullscreen spec (which already drives
   `setHybridHostFullScreen` via the bridge) at `FULLSCREEN_REQUESTED`/`waitForMode`.
5. **Minimal live (non-headless) checklist** — the residue that is genuinely
   unobservable headless (first responder, real grab pre-emption, real Spaces):
   (a) `fullscreen` on a page host → Esc exits (no switcher); (b) enter fullscreen,
   Cmd+Tab away and back → Esc still exits; (c) focus settings → `fullscreen` acts on
   settings → Esc exits it; (d) Esc with no window on the current Space → switcher
   opens. Operator performs the gestures only; the agent reads the transition log.

---

## What this doc did not decide

- Exact placement of maximize state (currently clean in the hybrid registry via
  `setHybridMaximizeState`): candidate for a later fold into `WindowRecord`, out of
  scope here to keep the first cut focused on the broken cluster.
- Whether `izui-state.ts`'s `transient` session semantics eventually merge into this
  machine — they interact only through `decideEscape` step 6 for now.
