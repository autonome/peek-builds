# Desktop App (Electron) — Agent Guide

This is the Electron desktop app. Code lives under `apps/desktop/` with subdirectories:
- `main/` — Electron main process (TypeScript/ESM, compiled via `yarn build`)
- `renderer/` — Frontend app UI (Lit-based, `app/` historically)
- `features/` — Built-in tile features
- `tests/` — Playwright integration tests
- `electron-builder.yml` — Packaging config

For cross-cutting rules (git workflow, subagent dispatch, Bash discipline), see the root `CLAUDE.md`.

---

## Testing

> **ALWAYS ASK BEFORE RUNNING THE FULL GATE.** Never launch `yarn test:desktop:electron`
> (or its `:bg`/`:x`/`:source` variants, or an equivalent all-runner Playwright run) on
> your own initiative — not to "confirm green" before landing, not because a handoff says
> to, not for any reason. It is expensive: it pins the CPU, makes the laptop run hot, and
> pops up crash/app windows that intrude on whatever the user is doing. So: state that the
> change needs the gate, ask, and wait for an explicit yes before running it. Fast
> single-test iteration (`yarn test:grep`) does not need to ask. (User directive, 2026-07-08.)

Test commands follow a `test:{environment}:{implementation}` system. The canonical
gate for this app is **`yarn test:desktop:electron`** — and it is the *whole* suite, not a
subset. It runs `electron-builder --dir`, then **all six runners** with `PACKAGED=1` where
applicable:

| # | Runner | Approx count |
|---|---|---|
| 1 | main-process unit (`main/*.test.ts` → `dist/main/*.test.js`, `electron --test`) | ~1950 |
| 2 | node unit (`tests/unit/*.test.js`, `node --test`) | ~670 |
| 3 | Playwright `desktop` project | ~383 |
| 4 | Playwright `desktop-serial` project (`--workers=1`) | ~38 |
| 5 | Playwright `components` project (chromium, not Electron) | ~56 |
| 6 | Playwright `editor` project (chromium, not Electron) | ~90 |

**Total ≈ 3190 unique tests (~3135 pass + ~56 skip), ~10 min wall-clock.** Each spec runs in
exactly ONE project — every project's `testMatch` is anchored to its own `tests/<dir>/`, so
nothing double-runs. When reporting a full-suite result, cite the per-runner numbers AND the
grand total — never report one project's tail as if it were the suite. The Electron-launched
Playwright pair (`desktop`+`desktop-serial`, ~365 run) is **~11% of the suite**, not the suite.

The Chrome **extension** Playwright suite is NOT part of this gate — it's a different
environment, run via `yarn test:extension:chrome` (see Coverage caveats).

### Coverage caveats — what "all 6 green" does NOT cover

A clean run reports ~56 *skipped*, and they are NOT "macOS-headless OS surfaces" — that's
only ~3. The buckets:

- **Hybrid page-host is the ONLY page-host (canvas removed 2026-07).** The legacy
  `<webview>` canvas page-host and its spec suite were deleted outright — there is no
  flag to select it and no `else` branch to fall back to. `yarn test:desktop:electron`
  now exercises a single page-host path unconditionally — the `hybrid-overlay` /
  `hybrid-popups` / `hybrid-windows-feature` specs run every time. See git history /
  peek item `e8081cce` for the removal.
- **~13 unconditionally-parked feature describes** (`HUD Extension`, `Proton Pass`) —
  disabled features, `describe.skip` in source.
- **~3 genuine macOS-headless OS-surface skips** (geolocation grant, devtools-open) — need a
  real display.

Separately: the Chrome **extension** UI specs (`tests/extension/`) are their own environment
and run via `yarn test:extension:chrome` (headed Chrome, or Linux+Xvfb), NOT this gate. They
previously leaked into the `desktop` project through an unanchored `testMatch` — fixed by
anchoring each project to its own `tests/<dir>/`.

```bash
yarn test:desktop:electron          # CANONICAL: full build + all 6 runners (~3190)
yarn test:desktop:electron:bg       # same, backgrounded → tail /tmp/test-electron.log
                                    #   pass/fail = /tmp/test-electron.exit, NOT the :bg exit code
yarn test:grep "<pattern>"          # Fast inner-loop: source-only, single test
yarn test:desktop:electron:source   # Escape hatch: source-only, no packaging (runners 3+4 only)
yarn test:desktop:electron:x        # Packaged desktop project, stop on first failure
yarn test:packaged                  # Re-run desktop project against existing out/mac-arm64/Peek.app
yarn test:extension:chrome          # SEPARATE env: Chrome extension UI suite (headed)
```

`yarn test:grep` iterates fast during editing. Validate with **`yarn test:desktop:electron`**
(the full gate) before declaring done — source-only / single-project runs miss asar /
asar.unpacked path bugs, electron-builder file-inclusion problems, and entire surfaces (unit,
components, editor).

**Tauri desktop (`apps/tauri-desktop/`) is off the critical path.** Its full suite is
`yarn test:desktop:tauri` (frontend + Rust). Do NOT gate desktop work on it; use
`yarn test:desktop:electron` only. There is intentionally **no bare `yarn test`** — name the
environment + implementation explicitly.

---

## Tile Architecture

Every UI surface — browser tabs, cmd panel, settings, everything — is a **tile**: a `BrowserWindow` loaded through `tile-preload.cts` and the capability-gated `tile:*` IPC. There is no "tile type" or "tile role" distinction.

Key facts:
- **`tile-preload.cts` must stay `.cts` (CommonJS TypeScript).** The backend `tsconfig.json` emits ESM for `.ts` files. Electron's sandbox preload silently rejects ESM — `window.app` becomes empty and the entire tile API disappears with no error thrown. Do not rename or convert this file.
- `window.app.*` is the API surface exposed to every tile renderer. It is frozen by the ContextBridge — you cannot wrap methods on it at the renderer side.
- Tile capabilities are declared in `manifest.json` (schema v3). A CONSUMER tile must list each topic it subscribes to in its own `pubsub.topics`; producer-only listing causes silent failures.
- PubSub is the default messaging pattern. Switch to directed `webContents.send` only if you see a broadcast-then-filter smell.

See `docs/architecture.md` and `docs/tiles-single-file.md` for the full tile model.

### UI: the `<peek-*>` component system is the DEFAULT — don't hand-roll chrome

**Every tile/feature UI ships on the shared Lit component library** in
`renderer/components/` (`peek-button`, `peek-input`, `peek-select`, `peek-card`,
`peek-grid`, …). That is the design system here. Do **not** hand-roll `.btn` /
`.card` / `.input` / modal CSS that *approximates* it — those copies drift (wrong
radius/height/weight, UA-font leaks) and are exactly why a surface reads as "a
different app." If a control exists as a `<peek-*>` component, use the component.

- **Why not just mirror tokens into `:root`?** The `--peek-*` geometry tokens
  (`components/tokens.css`, `base.js` `sharedStyles`) are `:host`-scoped — a plain
  `peek://` tile document can't read them at `:root`. But each component
  re-declares the tokens inside its OWN shadow root, so **using the component gets
  correct geometry for free**. Mirroring token *values* into a tile's `:root` (the
  old `features-manager/common.css` approach) is a half-measure that still leaves
  hand-rolled chrome subtly wrong; prefer the components.
- **REQUIRED: the `lit` importmap.** Component source does `import … from 'lit'`
  (a *bare* specifier). A plain tile document resolves it ONLY if its `<head>`
  declares a `<script type="importmap">` mapping `lit` / `lit-html` /
  `lit-element` / `@lit/reactive-element` → `peek://node_modules/…`. **Without it
  every component import silently fails and the elements stay un-upgraded
  (`HTMLElement`, no shadow root) with no thrown error** — they render as inert,
  unstyled custom tags. Copy the block verbatim from `features/windows/windows.html`.
- **Reference baseline:** `features/windows/` is the genuine on-system surface
  (`<peek-card>`/`<peek-grid>`/`<peek-input>`, measures to canonical). `settings`
  is NOT on the system — it's bespoke CSS that only *looks* close; don't cite it as
  the standard.

### Lazy feature activation

Built-in feature tiles (mcp-server, windows, websearch, peeks, slides) are **lazy** — they spawn on demand, not at boot. Production fixed boot was cut from 6 to 2 windows by this change.

**Making a tile lazy:** drop `resident: true` from its manifest `TileEntry`. A tile with no commands but event-driven behavior also needs `lazyEvents: [...]` on the entry. `main/tile-compat.ts` routes any tile with `!resident && (hasCommands || hasLazyEvents)` through `registerLazyTile()` instead of the eager launch path.

**Wake triggers** — `main/tile-lazy.ts` installs a single pre-publish hook (`installLoadOnDispatchHook`). The hook intercepts:
- `cmd:execute:<command>` for any command declared in the tile's manifest
- Any topic listed in the entry's `lazyEvents[]` (CLI verb topics like `cli:*` are pubsub topics and wake this way too)

When a matching publish arrives, the hook calls `ensureTileLoaded` → `waitForTileReady`, then delivers the deferred publish to the now-live handler.

**Global hotkeys without a renderer:** `main/feature-shortcut-registrar.ts` `registerWakeShortcuts(tileId, manifest)` registers OS accelerators at boot with no renderer running. Each keypress publishes the wake topic, which flows through the load-on-dispatch hook. Manifest `TileShortcut` supports two forms:
- `{ keys, command }` — publishes `cmd:execute:<command>`
- `{ keys, wakeTopic, wakeArgs }` — publishes `wakeTopic` directly

These are the **default hotkeys** for fresh profiles. The registrar checks the datastore first: if `hasDeclaredWakeShortcuts(tileId)` is true, it registers exactly the persisted `lazy_wake_shortcuts` rows (which may be empty — meaning register nothing); otherwise it falls back to manifest defaults. The declared marker (`lazy_wake_declared` table) distinguishes "declared-empty" from "never declared."

**Migrated-profile backfill — settings-derived hotkeys (fixed 2026-06-09, commit `e3ea1b7d`).** For features whose REAL hotkeys are *derived from settings* (peeks/slides: `prefix × enabled items`), the manifest's static `shortcuts[]` default is only a fresh-profile bootstrap. A profile with saved `feature_settings` but **no** declared wake set (settings predating the lazy-wake system) hits a **deadlock**: boot-replay registers only the manifest default (`Option+Up`/`Option+0`); the user presses their *configured* keys (e.g. a custom `Option+Shift+` prefix), which aren't registered → the lazy tile is never woken → it never declares → `lazy_wake_shortcuts` stays empty forever → **no working hotkeys**. (This is exactly the "prod hotkeys do nothing" report — diagnosed by comparing `feature_settings.prefs.shortcutKeyPrefix` against the empty wake tables.) Fix: a feature opts in with manifest flag **`wakeShortcutsFromSettings: true`**; at boot `wakeDeclarationBackfillNeeded(tileId, manifest)` (`feature-shortcut-registrar.ts`) gates a one-time `backfillWakeDeclaration(tileId)` (`tile-lazy.ts` → `ensureTileLoaded`, fire-and-forget) that WAKES the tile so its renderer declares the real settings-derived set. **Self-healing:** the declare sets `lazy_wake_declared`, so later boots skip the wake and stay lazy. The trigger is precise — `flag && !hasDeclaredWakeShortcuts && hasFeatureSettings` — so a fresh profile (no settings) keeps the manifest defaults + first-press bootstrap, and a STATIC-hotkey tile (windows: fixed command shortcut, never declares) MUST omit the flag or a wake would re-fire every boot. peeks/slides renderers now **always declare on boot** (even an empty set) so the marker is always set even with zero enabled items. Tests: `lazy-wake-shortcuts.test.ts` migrated-profile decision suite (failing-first vs the pre-fix never-backfill behaviour); verified end-to-end against a copy of a real migrated profile (backfill declared the exact `Option+Shift+*` set, 9 peeks + 4 slides, within ~1s of boot). **Known follow-up:** hotkeys now work but *opening feels slow* — peek task `9e6e91de` (triage).

**User-configured hotkeys:** persisted in the `lazy_wake_shortcuts` datastore table. The renderer calls `api.shortcuts.declareWakeShortcuts(list)` (IPC `tile:shortcuts:declare-wake`, `shortcuts` capability required), which persists the rows and re-registers the accelerators. Main re-registers all persisted rows at boot.

**Core page events:** `renderer/page/page.js` emits semantic events from its `did-finish-load` handler that lazy features wake on. First: `page:search-engine-discovered` (fired when a page advertises an OpenSearch descriptor). The websearch tile declares `lazyEvents: ["page:search-engine-discovered"]` and boots hidden on it — the detection stays in core page infra; the feature logic stays in the lazy renderer.

**CRITICAL init-ordering rule for lazy tile authors:** register all wake handlers (`api.commands.register`, `api.pubsub.subscribe` for lazyEvent topics) **synchronously in `init()` BEFORE any `await`**. The preload signals `tile:lifecycle:ready` on a `setTimeout(0)` macrotask before async `init()` awaits resolve. A handler registered after an `await` may miss the first deferred publish — the one that woke the tile. Pattern: register handlers synchronously, guard handler *bodies* on an `initReady` promise that resolves after async setup completes. See `features/websearch/home.js` for the reference implementation.

---

## Page View Canvas Architecture

The canvas page-host (a fullscreen transparent BrowserWindow hosting a `<webview>`) was
removed 2026-07. The hybrid page-host (`WebContentsView` content + one shared chrome
overlay in `main/hybrid-overlay.ts`) is the only page-host implementation now — see git
history / peek item `e8081cce` for the removal.

---

## Hybrid page-host: input / focus / menu wiring (regression cluster fixed 2026-06-08/09)

The hybrid page-host is a **`BaseWindow`** (a `WebContentsView` content view + the shared
`hybrid-overlay.ts` chrome), and that invalidates assumptions the canvas era baked in. When
the hybrid path flipped to default (2026-06-08) the whole suite still passed because NONE of
the below was covered — every one became a user-visible regression. Invariants:

- **`BrowserWindow.getFocusedWindow()` / `.fromId()` return `null` for a hybrid host.** Any
  menu item, command, or close path that resolves "the current window" through those misses
  hybrid hosts (this is why cmd+W no-op'd). Fall back to the hybrid registry's
  `getActiveHybridWindowId()` — see `resolveFocusedWindowIdForClose()` / `closeFocusedWindow()`
  in `windows.ts`, and the `closeOrHideWindow()` BaseWindow branch. **This invariant also
  governs any "is a Peek window focused?" decision, not just "which window".** The global ESC
  fallback (`main.ts`, a focus-gated `globalShortcut('Escape')` → `cmd:execute:windows`) regressed
  exactly this way (peek `ebb10894`): its predicate was `appActive && getFocusedWindow() === null`,
  so a focused slide/peek (a BaseWindow → `getFocusedWindow()` null) looked like "no Peek window
  focused", the OS-level grab registered, and — because `globalShortcut` **pre-empts**
  `before-input-event` — it ate ESC and opened the switcher instead of letting the slide close.
  Fix: pure `shouldRegisterGlobalEscFallback(appActive, hasFocusedBrowserWindow,
  hasActiveHybridWindow)` in `izui-roles.ts` (a hybrid window counts as focused), re-evaluated on
  every `onActiveHybridWindowChange` (BaseWindows don't fire `browser-window-focus`, so the
  `app.on('browser-window-focus'/'blur')` listeners alone leave the grab stale).
- **Show a fresh hybrid host with `show()` + `contentWC.focus()`, NEVER `showInactive()` alone**
  (non-headless). `show()` activates the app (frontmost + key window); `contentWC.focus()` makes
  the `WebContentsView` the macOS **first responder**. Miss either and you get the dead-focus
  cluster: cmd+L / any key equivalent → **NSBeep** (no responder), overlay never reveals (host
  `'focus'` never fires → active-hybrid id stays null), app frontmost-but-not-key (no menubar).
  Headless stays `showInactive()` + `opacity:0` so an agent/CI run never steals focus. Seam:
  `showHybridHost()` / `hybridShowIntent()` in `windows.ts`.
- **Local keyboard shortcuts:** once the content WC is first responder, keystrokes hit the
  **content WC's `before-input-event`** (`wireHybridContentEvents` in `ipc.ts`), NOT the
  per-`BrowserWindow` handler in `main.ts`. Route leftover modifier keys through
  `handleLocalShortcut` there, or cmd+N / peeks / slides / any registered local shortcut
  silently dies with a hybrid host frontmost. (OS-level `globalShortcut` wake hotkeys are
  unaffected — they pre-empt `before-input-event`.)
- **Overlay must `hide()` on `did-resign-active`** (`hybrid-overlay.ts` app-active gate) or the
  chrome lingers on screen when Peek isn't the active app.
- **Activation policy:** the non-headless app MUST stay `regular` (activatable, owns
  menubar/key window) — `headlessActivationPolicy(false) === null`. Never `accessory`/`prohibited`
  for the real app (headless = `accessory`). See also the Key Pitfalls note below.

**Testing these:** real OS focus/first-responder is **unobservable in macOS-headless**, so assert
the decision/state via the hybrid test bridge, not real focus. Coverage added:
`hybrid-show-activate`, `hybrid-activation-policy`, `hybrid-close-shortcut`,
`hybrid-shortcut-routing`. The `:bg` test family detaches cross-platform via
`scripts/bg-run.sh` (macOS `nohup` / Linux `setsid -f`), backgrounding the gate to
`/tmp/test-electron.log` (tail with `yarn test:log`).

**A `:bg` launch returning 0 means the run STARTED, not that it passed.** The script's
own status can only report the launch; the run outlives it. To judge a `:bg` run:

- **`/tmp/test-electron.exit`** — the sentinel: the gate's real exit code, written by the
  child on completion. Absent = still running. This is the machine-readable pass/fail;
  don't grep the log for "passed".
- The log always opens with `bg-run: STARTED <cmd> @<ts>` and closes with `bg-run: EXIT <code>`.
  A log with STARTED but no EXIT is still in flight; an empty log means the launcher itself
  never ran. (Before those banners an empty-looking log was indistinguishable from a quiet
  startup — for humans and agents alike.)
- `bg-run.sh` now exits **non-zero and dumps the log** if the child dies within ~1s, so the
  common instant-death case is loud at launch rather than silent.

History, because the failure mode was invisible and cost real debugging time: `bg-run.sh`
(2026-06-12) detached the child while it still inherited yarn's *temporary* PATH shim dir
(basename `xfs-<hex>`), which the launching yarn `rm -rf`s on exit. The child resolved `yarn`
after the fork, lost that race, and died in milliseconds — while the launcher still printed
"detached" and exited 0. **The gate reported success for testing nothing.** `bg-run.sh` now
strips those PATH entries before detaching. Note this makes the child resolve `yarn` the same
way your interactive shell does (a permanent install), which is the point — the `:bg` gate and
the foreground gate should run the same yarn.

Note `test:desktop:electron` exits non-zero if **any** of the 6 runners fails (it aggregates
per-runner status) — don't read the chained exit code as one runner's.

The gate cannot go green on Linux, and its failure count moves between identical runs, so judging
a change means diffing the failing spec set against the recorded set in
`apps/desktop/tests/gate-baseline.md` — which separates the failures that reproduce every run from
the ones that come and go. Reading the count alone reports a flake as a regression.

**Fixed since (2026-06-09, second pass):**

- **peek/slide transient-on-blur — DONE (peek `8e5c3174`).** Peeks/slides open with
  `role:'quick-view' + modal + canvas`, so under the hybrid default they are **BaseWindows**, and
  the old transient-autoclose lived entirely on `BrowserWindow` (focuser-driven loop over
  `getAllLiveWindows()` only). Fix, FSM-aligned (extend the existing focuser-driven mechanism, no
  new blur listener): a pure selector over candidates from BOTH registries, run from BOTH the
  `win.on('focus')` handler AND the hybrid host-focus path. App-switch (Cmd+Tab-away) is handled
  separately via `did-resign-active`, **deferred** with a `did-become-active` cancel so the macOS
  startup activation **dance** can't dismiss a freshly opened slide.
  **Now owned by the window-state machine (§5 step 9 cutover):** `window-state.ts
  selectTransientAutoclose` on `OS_FOCUS_GAINED` and `selectAppResignTransients` on
  `APP_RESIGN_SETTLED`; the dance cancel is reducer state (`pendingAppResignSweep`, armed by
  `APP_RESIGNED` / disarmed by `APP_ACTIVATED`) and only the settle DELAY survives, in
  `electron-window-backend.ts` (`APP_RESIGN_SETTLE_MS`). The `ipc.ts` wrapper, its candidate
  gatherer and `izui-roles.ts selectTransientSiblingsToClose` are deleted. Tests:
  `hybrid-transient-on-blur.spec` + the `window-state.test.ts` autoclose table.
- **slides/peeks cold-wake settings race — DONE.** Separate bug found dogfooding: `yarn start` →
  first slide hotkey did nothing, second worked. The lazy `cli:slide-open` / `cli:peek-open` wake
  handler is registered synchronously (good) but its BODY read `currentSettings` while it was
  still the bundled **defaults** (only `Up` / peek-key-`0` enabled) — the wake publish lands at
  FSM `ready`, which beats the datastore `loadSettings()`. A user slide/peek on any other
  edge/key was missed on the first, tile-spawning press. Fix (CLAUDE.md lazy-tile rule): guard the
  handler BODY on a `settingsLoaded` promise resolved after `loadSettings()`. Applied to both
  `features/slides/background.js` and `features/peeks/background.js`. Tests:
  `slides-settings-race.spec` + `peeks-settings-race.spec` (failing-first: pre-fix the window
  never appears; post-fix ~300 ms).

**Fixed since (2026-06-09/10, third pass — cluster now CLOSED):**

- **keepLive slides/peeks were destroyed instead of kept alive — DONE (peek `2c94c125`).** A
  slide/peek with `keepLive:true` (e.g. the left slide playing music) died on blur/app-switch.
  `closeOrHideWindow()` honored keepLive only on the BrowserWindow branch; the hybrid BaseWindow
  branch always `closeHostWindow`'d. Fix: the hybrid branch reads `getWindowInfo(id).params.keepLive`
  and `baseWin.hide()`s instead of closing; `tile-ipc.ts` routes its hybrid close through
  `closeOrHideWindow()` so it stops bypassing the gate. Test: `hybrid-keeplive-close.spec`.
- **ESC didn't close peeks/slides — DONE (peek `5386d44f`).** ESC→close lived only on the
  per-`BrowserWindow` `addEscHandler`; wired it into the hybrid content WC's `before-input-event`
  (`wireHybridContentEvents` → `handleHybridEscape` → shared `handleEscapeForWindowId` → one
  `escPolicy`/`escUnhandledPolicy` source of truth). Test: `hybrid-escape-close.spec`.
- **Session restore focused the wrong page — DONE (peek `4f1a974a`).** RESTORE-side: the hybrid
  show seam ignored `show:false`, so every restored hybrid window self-activated and the last to
  show (or the show-storm race winner) ended up frontmost. Fix: `hybridShowIntent(headless,
  inactive)` + `showHybridHost(.., {inactive})` honor a non-activating intent; `ipc.ts` threads
  `inactive: options.show === false`; `session.ts` restore post-loop is the SINGLE authority that
  activates only the focused descriptor. Test: `session-restore-hybrid-focus.spec`.
- **Top-border gesture overlay-reveal — DONE (peek `363e7cff`).** Two sub-causes: (1)
  active-hybrid-id-never-set was already healed by the dead-focus fix; (2) the genuinely-open part
  — when the content `WebContentsView` is first responder AND fills the overlay frame (maximized /
  no-gutter), it STARVES the click-through overlay's forwarded-`mousemove` reveal loop. Fix:
  `wireHybridContentEvents` (`ipc.ts`) forwards idle (no-button) top-band moves (within 44px =
  `TRIGGER_ZONE+NAVBAR_HEIGHT` of the host top edge — main owns geometry, so it works maximized) as
  `page-overlay:content-pointer {phase:'reveal'|'reveal-out'}`, emitted only on band enter/exit;
  `overlay.js` drives `showNavbar()`/`scheduleHide()` idempotently with the existing gutter loop.
  Test: `hybrid-overlay.spec` "top-border gesture reveal (363e7cff)".
- **ESC opened the Windows switcher instead of closing — DONE (peek `ebb10894`).** The global ESC
  fallback grabbed ESC because `getFocusedWindow()` is null for a focused hybrid slide/peek — see
  the augmented `getFocusedWindow()` invariant bullet above for the full mechanism + fix
  (`shouldRegisterGlobalEscFallback`). Test: `izui-roles.test.ts shouldRegisterGlobalEscFallback`.

**Fixed since (2026-06-10, fourth pass — the cluster wasn't quite closed):**

- **Focused page-host where ESC (and every other key) is dead until you click the page — DONE
  (peek `7c61e917`).** A further sibling of the FRESH-show dead-focus bug (`1b6eaf0b`, cmd+L beep):
  `showHybridHost` applies the `show() + contentWC.focus()` invariant only on a fresh show. A host
  restored via `showInactive` at session start (`contentFocused:false`) and **later RAISED by its
  chrome / Cmd+Tab / Mission Control** fires `baseWin 'focus'` — so `getActiveHybridWindowId()`
  correctly points at it, which (correctly) suppresses the global ESC fallback — but **nothing makes
  its content `WebContentsView` the first responder.** So the content WC's `before-input-event`
  never sees ESC (no `handleHybridEscape`) AND the global fallback is off → ESC has NO handler at
  all. Clicking the page fires `contentWC 'focus'` and restores first responder, which is why a click
  "fixed" it (and why it felt nondeterministic — it's whichever backgrounded restored window you
  raise by its chrome rather than its page). Fix: `onHybridHostFocus` (`ipc.ts`, already wired to
  `baseWin 'focus'`) now calls `contentWC.focus()`, gated by pure
  `shouldFocusHybridContentOnHostFocus(headless, contentDestroyed, contentAlreadyFocused)`
  (`izui-roles.ts`) — skips headless (focus-free) and the already-focused case (raise triggered BY a
  page click → no redundant re-focus / focus-event loop). Confirmed by the SAME live-trace method as
  `ebb10894` (see LESSON): pre-fix the raise logged no first-responder restore and ESC produced no
  `before-input-event`; post-fix every raise restores it and the next ESC lands with no click. Test:
  `izui-roles.test.ts shouldFocusHybridContentOnHostFocus` (pure predicate — real first responder is
  unobservable headless). **Takeaway for the `show() + contentWC.focus()` invariant: it must hold on
  every path that makes a host the key window, not just the fresh `showHybridHost` — re-raise of an
  already-shown (restored/inactive) host has no show seam, so the `baseWin 'focus'` handler is the
  one that must restore first responder.**

**Fixed since (2026-06-10, fifth pass — the OTHER half of the `getFocusedWindow()` invariant):**

- **cmd+W with the address bar/widgets open closed only the chrome, leaving the page visible — DONE
  (peek `9d50ea29`).** The INVERSE of the ca4ee5e6 cmd+W no-op. The shared chrome overlay
  (`hybrid-overlay.ts` `overlayWin`) is a `focusable:true` BrowserWindow — Cmd+L (`page:show-navbar`
  → `wireShowNavbarFocus`) calls `overlayWin.focus()` so the user can type a URL. So with the address
  bar open, `BrowserWindow.getFocusedWindow()` returns the **overlay**, not null and not the content
  BaseWindow. The cmd+W menu handler (`entry.ts`) did `closeOrHideWindow(getFocusedWindow().id)` →
  closed/destroyed the overlay singleton only; the content host BaseWindow stayed visible. So ca4ee5e6
  taught us "`getFocusedWindow()` is null for a hybrid host"; this is the sibling failure — it's
  **non-null but points at the chrome floating in front of the host**. Fix: overlay-aware close
  resolution. Pure `resolveCloseTargetId(focusedBrowserWindowId, focusedIsHybridOverlay,
  activeHybridWindowId)` in `izui-roles.ts` (focused non-overlay BW wins; else the active hybrid host).
  The registry gains `setOverlayWindowIdProvider`/`isHybridOverlayWindowId` (one-way provider, SAME
  pattern as `setOverlayFocusProvider` — the overlay calls IN, the registry never imports the overlay);
  `initHybridOverlay` registers a closure reading the live `overlayWin` id. `resolveFocusedWindowIdForClose`
  (`windows.ts`) feeds the predicate; the `entry.ts` handler now routes through `closeFocusedWindow()`
  after the devtools guard instead of closing the raw focused id. Closing the host nulls the active id →
  `onActiveHybridWindowChange(null)` → overlay hides, so the whole host goes away. Tests:
  `izui-roles.test.ts resolveCloseTargetId` (the redirect decision — the overlay-IS-focused state needs
  real OS focus, unobservable headless per the LESSON), `hybrid-page-host-registry.test.ts` overlay-id
  provider unit, and `hybrid-close-shortcut.spec` "registry recognises the live overlay window" (proves
  `initHybridOverlay` wired the provider against the real singleton). **Takeaway: any "which/whether a
  Peek window is focused" decision must account for BOTH hybrid-era surprises — a focused hybrid host
  reads as `getFocusedWindow()===null`, AND a focused chrome overlay reads as a focused BrowserWindow
  that ISN'T the window the user means to act on.**

**LESSON (load-bearing): headless specs CANNOT observe the macOS first-responder / `globalShortcut`
pre-emption interaction, and a green headless spec gave false confidence TWICE on the ESC bug.**
The ESC→switcher root cause was only found by **live `fs-diag` in the user's real `yarn start`
session** (see `repro-first-then-fix` + `peek-fs-diag-bridge` skills): instrument the suspected
paths, have the user repro once, read `/tmp/peek-cmd-diag.log`. The decisive signal was an ABSENCE
— none of the per-window ESC logs fired — which pointed at a pre-emptive OS-level grab, not the
handler we'd been editing. When a hybrid focus/input bug resists and the unit/Playwright suite is
green, suspect (a) anything reading `getFocusedWindow()`, and (b) an OS-level `globalShortcut` that
pre-empts `before-input-event` — and get a live trace before touching code.

**Still open (separate, NOT a focus/input bug): keepLive toggle → extension bridge error (peek
`42fff0a5`).** Checking the keepLive option for a slide/peek logs a chrome-extension compat-bridge
port disconnect + `[peek:runtime-external:bg] electron.ipcRenderer unavailable on all probed paths`
RuntimeError (Proton/peek-auth-relay ext). Untouched — chrome-extension compat scope, not the
hybrid focus cluster.

---

## Chrome extensions: compat layer only — never modify imported source

Imported chrome extensions under `apps/desktop/chrome-extensions/<ext>/` are upstream CRX downloads (refreshed by `scripts/install-chrome-extension.js`). **Never** edit their source directly — any in-place change is blown away on refresh, and Proton-/extension-specific patches make the integration fragile instead of generalizing.

When an extension exposes a gap (a Chrome API that Electron doesn't fully implement, an injection point that Electron doesn't auto-fire, etc.), the fix always lives in our compat layer:

- `apps/desktop/main/chrome-api-polyfills/*` — preload, BG SW shims, bridge window
- `apps/desktop/main/chrome-extensions.ts` — loader, lookups, match-pattern helpers
- `apps/desktop/main/entry.ts` — webview lifecycle hooks (dom-ready content-script injection, CDP polyfill registration)
- `scripts/patch-chrome-extensions.js` — build-step compat injection (bounded by `PEEK_BG_SHIMS_BEGIN/END` sentinels, idempotent — this IS the compat layer, expressed as a generated prefix on `background.js`)

Test for "is this a compat-layer fix?" — would the same code help a hypothetical *different* extension with the same Chrome API gap? If yes, compat layer. If it only helps one extension and references its internals (sender labels, hardcoded version strings, payload shapes), find the underlying Chrome API gap instead.

---

## asar / electron-builder Quirks

Three categories of files must live in `asar.unpacked` (see `electron-builder.yml`):
- `apps/desktop/assets/tray/**` — tray icons
- `apps/desktop/chrome-extensions/**` — `session.loadExtension()` cannot read from inside `app.asar`
- `scripts/peek-cli.mjs` — invoked by external `node` process; node can't read from `app.asar`

If you add a new file that needs to be accessible to native code or external processes, add it to `asarUnpack` in `electron-builder.yml`.

If a bug only appears in the packaged build (not `yarn start`), suspect asar path resolution before anything else.

---

## Process Roles

- **bgWindow** (`peek://app/background.html` → `app/index.js`) — the core orchestrator. Initialises the cmd registry, page canvas, and HUD. Session management and pubsub live here.
- **main process** (`main/`) — `datastore.ts` (SQLite via better-sqlite3), IPC handlers (`ipc.ts`), `peek://` protocol handler (`protocol.ts`).
- `datastore.ts` owns frecency, slug, hashtag, cascade, and pubsub rules. External writers must replicate its inline behaviour and include tests.
- `setTimeout` bodies in the main process **must** guard `isDestroyed()` before touching a `BrowserWindow`.

---

## Profile Isolation

- Dev builds (`yarn start`) always use the `dev` profile, isolated from production.
- Production builds use `default`.
- `PROFILE` env var overrides for tests.
- **Never use the default (production) profile for repros or debugging.** Use an isolated profile or copy production data to a tmp path.
- `workspaceKey`-keyed tiles collapse opens; Playwright cannot get a fresh window unless it uses an isolated profile.
- Prod profile data lives at `~/Library/Application Support/Peek/default/` (mostly regenerable chromium cache/partitions; the real data is `datastore.sqlite`). Before installing a new build over production, back it up: **`yarn profile:backup`** (full) or **`yarn profile:backup:datastore`** (just the DB — the only thing a new build migrates). Restore with **`yarn profile:restore <backup-dir>`** (refuses while Peek/its MCP server are running). Backups land in `~/Library/Application Support/Peek-backups/`.

---

## Killing the App

```bash
yarn kill   # ONLY safe way to kill dev Peek
```

Never `pkill -f electron` or `pkill -f Peek` — those will kill the production app if it is running.

---

## Key Pitfalls

- Top-level `await api.initialize()` followed by a later synchronous throw causes a silent halt — no error surfaced.
- `peek://groups/` and `peek://ext/groups/` are URL substrings of each other. Always pair tile moves with a URL migration to avoid Playwright selector collisions.
- "Works in `yarn start`, broken in packaged" usually means profile-scoped `localStorage` or an asar path issue, not a code bug.
- Never disable `webSecurity` or `nodeIntegration` to fix a bug. Wire a narrow capability instead.
- **Headless/test runs (macOS): the activation policy must be `'accessory'`, never `'prohibited'`** (`main/headless-policy.ts` + `entry.ts`). A `'prohibited'` app can't own the macOS key window, so headless test launches strand the user's foreground app frontmost-but-not-key — input dead until a cmd-tab cycle. To also kill the residual launch-time focus *blip*, use `LSUIElement` on the **test** build's `Info.plist` (never production), not `'prohibited'`. Diagnostic probes: `tools/focus-probes/`. Regression history: peek task `2b55f3af`.
