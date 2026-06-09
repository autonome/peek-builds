# Desktop App (Electron) — Agent Guide

This is the Electron desktop app. Code lives under `apps/desktop/` with subdirectories:
- `main/` — Electron main process (TypeScript/ESM, compiled via `yarn build`)
- `renderer/` — Frontend app UI (Lit-based, `app/` historically)
- `features/` — Built-in tile features
- `tests/` — Playwright integration tests
- `electron-builder.yml` — Packaging config

For cross-cutting rules (jj workflow, subagent dispatch, Bash discipline), see the root `CLAUDE.md`.

---

## Testing

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

- **Hybrid page-host is the DEFAULT path (since 2026-06-08); the legacy CANVAS suite
  (~44 specs) is now flag-gated OUT by default.** `PEEK_PAGEHOST_HYBRID` defaults **on**;
  only `=0` selects canvas. So a green `yarn test:desktop:electron` now exercises the
  HYBRID path — the `hybrid-overlay` / `hybrid-popups` / `hybrid-windows-feature` specs
  run, and the canvas-only specs self-skip via `test.skip(await hybridFlagOn(app))`. To
  exercise the legacy canvas path instead, run
  `PEEK_PAGEHOST_HYBRID=0 yarn test:desktop:electron`. (Pre-flip this was inverted: hybrid
  was the opt-in `=1` suite. Verified green at the flip: **3162 passed, 0 failed, 75 skipped**
  in the default hybrid run — the ~44-spec canvas bucket now skips instead of the ~40-spec
  hybrid bucket, so whole-suite skips rose ~56 → ~75.)
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

## Page View Canvas Architecture — FROZEN

**Do not replace or restructure this architecture.** It was accidentally destroyed once and had to be restored.

> **Status (2026-06-08): this canvas path is now the OPT-OUT, not the default.** Web pages
> default to the **hybrid** page-host (`WebContentsView` content + one shared chrome overlay —
> `main/hybrid-overlay.ts`, `isHybridPageHost()` defaults on). The canvas path described below
> is selected with `PEEK_PAGEHOST_HYBRID=0` and remains fully supported + frozen as the
> fallback. Measured win behind the flip: `docs/perf/page-host-cost-baseline.md`.

Content and child-content web pages use a **fullscreen transparent canvas** BrowserWindow:

1. `useCanvas = true` → content/child-content pages. `useCanvas = false` → slides, modals, overlays (load URL directly in a positioned BrowserWindow).
2. Canvas BrowserWindow is sized to cover the full display work area at (0,0), background `#00000000` (fully transparent).
3. All elements (`<webview>`, navbar, resize handle) are `position: absolute` siblings. Positions set via inline styles by `updatePositions()` based on `bounds` URL params.
4. Drag/resize uses a custom mousedown handler — no `-webkit-app-region: drag`.

**Headless perf exception (do not "fix" as a bug):** under `isHeadless()` the canvas
window is created **opaque** (`ipc.ts` — `transparent: useCanvas && !isHeadless()`),
not transparent. It's `opacity:0` (invisible) in tests anyway, and a full-screen
*transparent* window forces per-pixel alpha compositing that saturates macOS
`WindowServer` when many page-host windows exist (e.g. session restore at parallel
workers). Opaque keeps the full-screen geometry (bounds round-trip tests pass) and
cut measured WindowServer from 56–75% → 38–49%. Visible/prod behavior is unchanged.
More desktop test-run perf levers: peek `d8e7efa5` / memory `project_headless_test_perf`.

See "Page View Canvas Architecture" in `DEVELOPMENT.md` for the canonical description.

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
  in `windows.ts`, and the `closeOrHideWindow()` BaseWindow branch.
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
`hybrid-shortcut-routing`. **`yarn test:desktop:electron:bg` uses `setsid` (Linux-only) and
fails on macOS** — run `HEADLESS=1 yarn test:desktop:electron` directly (background it via the
harness) instead.

**Fixed since (2026-06-09, second pass):**

- **peek/slide transient-on-blur — DONE (peek `8e5c3174`).** Peeks/slides open with
  `role:'quick-view' + modal + canvas`, so under the hybrid default they are **BaseWindows**, and
  the old transient-autoclose lived entirely on `BrowserWindow` (focuser-driven loop over
  `getAllLiveWindows()` only). Fix, FSM-aligned (extend the existing focuser-driven mechanism, no
  new blur listener): pure `selectTransientSiblingsToClose()` in `izui-roles.ts`; an `ipc.ts`
  wrapper gathers candidates from BOTH the BrowserWindow and hybrid registries and runs from BOTH
  the `win.on('focus')` handler AND the hybrid `onHybridHostFocus` path. App-switch
  (Cmd+Tab-away) is handled separately via `did-resign-active`, **deferred** with a
  `did-become-active` cancel (`HYBRID_APP_RESIGN_SETTLE_MS`) so the macOS startup activation
  **dance** can't dismiss a freshly opened slide. Tests: `hybrid-transient-on-blur.spec` +
  `izui-roles` selector units.
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

**Still open — the ONE remaining cluster item: top-border gesture overlay-reveal (peek
`363e7cff`).** Making the content WC the first responder appears to **starve the overlay's
top-border hover region of `mousemove`**: when the content `WebContentsView` is first responder
AND fills the window, it captures the pointer events the reveal trigger needs (worst in the
**maximized / no-gutter** case, where the overlay frame == content rect so the trigger strip sits
directly over the content WC). The reveal tracking must live above/around the content view (not
rely on the BaseWindow/overlay receiving `mouse-moved`). Candidate fix: in `wireHybridContentEvents`
(`ipc.ts`), forward idle (no-button) `mouseMove` near the top edge — currently only button-down
`mouseMove` is forwarded — to wake the overlay reveal; the overlay renderer (`overlay.js`) then
takes over once it captures.

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
- `sandbox: false` does **not** propagate to cross-origin iframes. Disable Site Isolation app-wide if cross-origin frame access is required.
- `peek://groups/` and `peek://ext/groups/` are URL substrings of each other. Always pair tile moves with a URL migration to avoid Playwright selector collisions.
- "Works in `yarn start`, broken in packaged" usually means profile-scoped `localStorage` or an asar path issue, not a code bug.
- Never disable `webSecurity` or `nodeIntegration` to fix a bug. Wire a narrow capability instead.
- **Headless/test runs (macOS): the activation policy must be `'accessory'`, never `'prohibited'`** (`main/headless-policy.ts` + `entry.ts`). A `'prohibited'` app can't own the macOS key window, so headless test launches strand the user's foreground app frontmost-but-not-key — input dead until a cmd-tab cycle. To also kill the residual launch-time focus *blip*, use `LSUIElement` on the **test** build's `Info.plist` (never production), not `'prohibited'`. Diagnostic probes: `tools/focus-probes/`. Regression history: peek task `2b55f3af`.
