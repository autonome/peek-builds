# V1 Removal Plan

## Status (2026-04-24, autonomous overnight pass)

What's actually done as of today, on top of the work documented in earlier sections:

- Phase 1 (core background → tile-preload): done. cmd/page/hud are consolidated into the core background renderer (`app/index.js` → `initCmd/initPage/initHud`). HUD is currently disabled (commit `6f8a80b1`) but the wiring exists.
- Phase 2 (test fixture → tile-preload): done. `peek://test/index.html` is the privileged renderer, launched from `test-fixture-glue.ts` with a `createTrustedBuiltinGrant('test')` token.
- Phase 2.5 (other v1 surfaces): done. `loadExtInHost`, `extensionHostWindow`, `createExtensionHostWindow`, `extensionWindows` map, and the `createExtensionWindow` helper are all gone — only stale comments remain.
- Phase 3.7e (delete `IPC_CHANNELS.*` handlers + const): done in commit `dadb6902`. All 6 handlers (`PUBLISH`/`SUBSCRIBE`/`CLOSE_WINDOW`/`REGISTER_SHORTCUT`/`UNREGISTER_SHORTCUT`/`MODIFY_WINDOW`) had zero callers after preload.js's deletion.
- Phase 3.7b (window-* dead handlers): done in commit `39440baa`. Deleted `window-resize`, `window-blur`, `window-is-transient`, `window-set-scroll-position`, `window-get-bounds`, `window-set-bounds`, `get-display-info`, `window-move`, `window-get-position`. Also migrated tile-preload's drag IIFE off `window-move`/`window-get-position` to the strict `tile:window:get-bounds`/`tile:window:set-bounds`.
- Phase 3.7d (extract-page-content + dialog/file/info/fetch + modes/izui/feature-settings): done in commit `39dba9d6`. Deleted ~20 dead legacy handlers; their only callers were preload.js or in already-deleted code paths. tile-preload's surfaces (`api.dialogs`, `api.filesystem`, `api.modes`, `api.izui`, `api.settings`) all route through strict `tile:*` channels now.
- Theme directory shims: added `api.theme.{pickFolder,validateFolder,add,remove,reload}` to tile-preload (committed alongside Phase 3.7d). These keep using legacy `theme:*` IPC handlers — Settings UI requires them. Settings was previously broken on these calls.
- preload.js: already gone (deleted in Phase 3.11b-hud).

What remains:

- Phase 3.7a/c: tile-preload still has window-* fallback branches (`if (!hasWindowCapability()) return ipcRenderer.invoke('window-*')`) that route to legacy handlers. Each fallback can be deleted once we confirm every deployed tile declares the relevant capability. No tile-preload caller of window-* is unconditional anymore — the only LIVE callers are: capability-fallbacks + my new drag IIFE (which now uses strict).
- Phase 3.8 (final preload.js cleanup): preload.js itself is gone; `setPreloadPath`/`getPreloadPath` may still be referenced — quick audit needed.
- Phase 4 (manifest cleanup): NOT started. Drop `type?` field, drop `windowHints`, decide manifestVersion bump, update 26 feature manifests.

Validation today: `yarn tsc --noEmit` clean after each commit. Unit tests 2284/0 across all commits. Full Playwright suite NOT run during this session — user explicitly asked to defer until morning review.



Goal: every renderer in Peek runs through `tile-preload.cts` against `tile:*` IPC. No more v1 consolidated-extension-host iframes, no more legacy IPC channels, no more dual paths in tile-preload. Frontend logic stays in `app/` (portable across Electron / Tauri / mobile); backend glue only launches the renderer.

This eliminates the v1↔v2 seam that's the source of the kagi/google/tag flaky test cluster (~10 tests). Removes substantial compat code in `tile-preload.cts`, `main.ts`, and `ipc.ts`, and one whole BrowserWindow.

---

## Vocabulary

- **Tile mechanics** = renderer mechanics: single HTML file in `app/<id>/` or `features/<id>/`, loads `tile-preload.cts`, talks to main via `tile:*` IPC. Same for everyone.
- **Feature tile** = third-party / installable code. Has a manifest with declared capabilities; tile-preload + tile-ipc enforce them via capability tokens.
- **Core renderer** = bundled with the app, lives in `app/`. Uses the same tile mechanics, but its token grant is **privileged** (skips capability checks). cmd, hud, page are core renderers.
- **Frontend** = `app/` and `features/` — HTML / JS / CSS, portable across all backends.
- **Backend glue** = `backend/{electron,tauri,mobile}/*.ts` — platform-specific code that launches windows, handles protocols, etc. Should be thin.

---

## Current state — what's still v1

1. **Core background scripts** (`app/cmd/background.{html,js}`, `app/hud/background.{html,js}`, `app/page/background.{html,js}`) load via `loadExtInHost(host, id, url)` — iframes inside `extensionHostWindow`. They use the v1 `preload.js` surface (`api.commands.register`, `api.publish`, `api.subscribe`) routed through legacy IPC channels. The cmd / hud / page UI windows themselves are already standalone BrowserWindows — only the background scripts are iframes.
2. **Test fixture `bgWindow`** = `peek://app/background.html`, another iframe in the same host. Tests subscribe / publish via the legacy `IPC_CHANNELS.SUBSCRIBE` / `IPC_CHANNELS.PUBLISH` path (`ipc.ts:4466`).
3. **Legacy IPC channels** in `ipc.ts`: `window-open`, `window-close`, `IPC_CHANNELS.SUBSCRIBE`, `IPC_CHANNELS.PUBLISH`, several others. Used by core + tests + as fallback paths inside `tile-preload.cts`.
4. **`preload.js`** — the v1 preload. Loaded by every iframe in the consolidated extension host.
5. **`extensionHostWindow`, `loadExtInHost`, `extensionWindows` map, the v1 portion of `extensionBroadcaster`** — the consolidated-host plumbing in `main.ts`.

Features (the 26 tiles in `features/`) are all v2 already — no work there.

---

## Why now

- Every flaky-test cluster we hit this session traced back to the v1↔v2 seam. The kagi / tag / widget-update tests (~10) are blocked by routing that only exists *because* the seam exists.
- Two preloads, two IPC paths, two pubsub-broadcast paths → 4× the code surface for every change. Recent work in `tile-preload.cts` (single-file tiles, showSelf/hideSelf) had to add legacy-fallback branches in ~10 methods.
- The "tiles are the unit" principle (per `project_tile_is_fundamental.md`) is undermined as long as core lives outside the tile mechanics.
- Cleanup yields a big LOC reduction in `main.ts`, `ipc.ts`, and `tile-preload.cts`.

---

## Phases

### Phase 1 — Inline core background logic into `app/`, drop iframe loading

Frontend changes (portable):
- **`app/cmd/`**: merge `background.{html,js}` content into `app/cmd/index.html`'s module script. The cmd panel UI window is already loaded at startup as a standalone BrowserWindow — its renderer just needs to also do the command registration that the iframe used to.
- **`app/hud/`**: same — merge into `app/hud/index.html`. The hud overlay window is already at-startup.
- **`app/page/`**: page is different — there's no always-loaded "page UI" window (each page canvas opens per URL). So `app/page/background.html` becomes its own tiny resident renderer that just registers `open` and `modal` commands and never shows UI. Same shape as `mcp-server` (converted in the single-file tile work, commit `4e612222`).

All three frontend renderers use `tile-preload.cts` and the standard `api.*` surface — identical to feature tiles.

Backend glue changes (Electron-specific, kept thin):
- `backend/electron/cmd-glue.ts` / `hud-glue.ts` / `page-glue.ts`: drop `loadExtInHost(...)` call. Replace with a `launchTile()`-style call that creates the BrowserWindow with `tile-preload.cts` and a **privileged token grant** (no capability enforcement).
- New: a privileged-grant helper, e.g. `createCoreGrant(id: string): CapabilityGrant` that returns a grant which short-circuits all capability checks. Lives in `backend/electron/tile-manifest.ts` next to `resolveCapabilities`.
- Tile-ipc enforcement updates: at each `checkXxxAllowed` site, an early-return for grants flagged `core: true`. Audit each enforcement point to make this explicit (avoid silent bypasses).

Acceptance: cmd panel, hud, page-host commands all work. No `loadExtInHost` calls remain for these three. Frontend logic moved into `app/` files; backend glue files shrink.

### Phase 2 — Migrate test fixture to `tile-preload`

**Status: rolled back 2026-04-18.** First attempt landed (commits `ce382a0b` … `ee0379be`) but introduced a regression: when the new v2 BrowserWindow test fixture published via `tile:pubsub:publish` IPC, the message never reached the main-process handler. Confirmed via instrumentation: `api.publish` was a function, `tokenValid` was true, `api.scopes.GLOBAL` was correct, but `ipcRenderer.send('tile:pubsub:publish', ...)` produced no observable effect on main. Cause not isolated. The kagi control test (passing post-Phase-1c) regressed. Reverted to Phase 1c tip (`6a9e79ae`).

#### Lessons

- The previously-passing kagi control test exercises the exact v1 fixture → v2 tile → v1 fixture round-trip we wanted to keep working. It is the canary for any test-fixture migration.
- Instrumenting tile-preload's preload context is hard: `require('fs')` is unavailable under sandbox, `console.error` survives forwarding but is suppressed by Playwright's reporter. The cleanest probe is to surface diagnostic data inside the test's `evaluate` return value (worked).
- `ensureTileIpcHandlers()` (added in `a5c98bc4`) is load-bearing for the rest of Phase 2 — can't revert in isolation.

#### Next attempt — Option A1: unit-test reproducer FIRST

Before touching the fixture again, build a Node-level unit test that boots a minimal Electron-like environment with two tile-preload renderers and asserts a publish from one reaches the other through the broadcaster. This isolates the failure (or proves the v2 round-trip works in principle) outside Playwright's hard-to-debug environment.

If the unit test reproduces the failure, fix it in product code. If the unit test passes but Playwright still fails, the bug is in something specific to how Playwright launches Electron / how the test fixture interacts with the cmd/hud/page renderers.

##### Status (2026-04-18)

**Partial progress** — landed in commit `745af1f5`:
- `ensureTileIpcHandlers()` exported from `tile-compat.ts` and called at top of `main.ts::initialize()` so the `tile:*` IPC handlers exist before ANY BrowserWindow is created (was lazy-registered from `loadV2Tile()` previously).
- Failing reproducer test at `tests/desktop/v2-pubsub-reproducer.spec.ts` — cmd publishes `repro:v2-v2-hello` GLOBAL, hud subscribes. Both report `published: true` / `subscribed: true`, but hud never receives. Documents the bug as a regression test.

**Next probe needed:** something IPC-based or main-process-side that confirms whether `ipcRenderer.send('tile:pubsub:publish')` from cmd's tile-preload actually reaches the main-process handler. Window-level probes from preload don't reach the test's main-world `evaluate` (`contextIsolation` blocks them). File-based probes from main-process work but require running tests from the correct cwd (`/Users/dietrich/misc/mpeek`, not an agent worktree — yarn/tsc respects cwd).

**Next angle to try (recommended):** build a bare-bones standalone Electron app (NOT Peek) — `main.ts` + `preload.cjs` + two HTML pages — that does the same v2-style flow: renderer A publishes via `ipcRenderer.send` → main `ipcMain.on` handler → broadcast via `webContents.send` → renderer B's `ipcRenderer.on` fires. If the standalone repro works, the bug is in Peek's specific orchestration (interaction with `extensionHostWindow`, capability tokens, multiple windows on the same `peek://` protocol, etc.). If it fails the same way, the bug is fundamental to the pattern and we have a 200-line reproducer to ship to Electron upstream or fix in our IPC plumbing.

#### Next attempt — Option A2: keep test fixture out of v1 cleanup

Phase 3 can proceed *almost* fully: delete `loadExtInHost` for cmd/hud/page (already done in Phase 1), delete the legacy IPC channels NOT used by the test fixture, but **preserve** `extensionHostWindow` + `IPC_CHANNELS.SUBSCRIBE/PUBLISH` + `app/background.html` solely as the test fixture path. Defer Phase 4 until the test fixture is migrated. Cost: a sliver of v1 plumbing stays. Benefit: unblocks the rest of cleanup, isolates the test-fixture problem.

#### Next attempt — Option B: drive tests through cmd panel UI

Rewrite tests to invoke commands by typing into the cmd panel and asserting on side effects. Larger test rewrite but no privileged test renderer needed. Tests become more realistic.

Recommend Option A1 next. The unit-test reproducer is a 1-day investment that either tells us how to fix Phase 2 or proves we need Option A2 / B.

Acceptance (when ready to retry): every existing test passes against the new fixture. No `IPC_CHANNELS.SUBSCRIBE` callers in tests.

### Phase 2.5 — Migrate the OTHER v1 surface (added 2026-04-18)

Phase 3 attempt revealed the original plan didn't enumerate a second always-on v1 path. Before Phase 3 destructive cleanup can proceed, these need migration:

1. **`createBackgroundWindow()` → `WEB_CORE_ADDRESS` → `app/background.html` → `app/index.js`** — this is the *core background renderer*, not a test fixture. Always created at startup. Runs `app/index.js` (session manager, pubsub hub). Migrate to a v2 resident renderer with a `createTrustedBuiltinGrant('core')` token (same shape as cmd/hud/page/test).
2. **Webview preload injection in `entry.ts:179`** — every `peek://` webview (widget panes, HUD children, page canvas children) gets the v1 `preload.js` injected via `will-attach-webview`. Switch to `tile-preload.cjs` (or remove if widgets don't need the API).
3. **`createExtensionWindow()`** — Phase 2.5 #3 audit found 8 callers: 4 dead (deleted in `25c154ea`, -110 LOC); 0 v2-migratable builtins (`example` is already on `loadV2Tile`); 0 chrome extensions (those use `session.loadExtension()`, separate path). 2 live callers remain: `reloadExtension()` (features-manager UI reload button) and `loadDevExtension()` (`--load-extension` CLI flag). They need a `relaunchTile(tileId)` helper in `tile-launcher.ts` (re-read manifest, revoke old token via `revokeTokensForTile`, close old window, call `launchTile`). Once that helper exists, both callers migrate and `createExtensionWindow` can be deleted entirely. Phase 2.5 #3b.
4. **Dead-code cleanup that's safe today:** `CONSOLIDATED_EXTENSION_IDS` list (always empty after v2 migration), the `if (consolidatedIds.length > 0)` block in `loadExtensions()`, the `loadExtInHost` helper. Safe to delete now since no v2 feature uses them — preserved only because their removal interacts with smoke tests asserting on `peek://app/extension-host.html` existence.
5. ~~Tauri mobile uses `preload.js` via `include_str!`~~ **Out of scope.** No Tauri/mobile work in this v1-removal pass. If deleting `preload.js` from Electron's path would break Tauri's `include_str!`, copy the file into a Tauri-local path first (e.g. `backend/tauri/src-tauri/src/preload.js`) and update the include — Tauri keeps its v1 surface untouched. The Electron-side cleanup proceeds regardless.

After Phase 2.5: Phase 3 (destructive cleanup) can proceed cleanly. Phase 4 (manifest cleanup) follows.

### Phase 3 — Delete v1 plumbing

Once Phases 1–2 are done, no live caller of v1 paths exists. Delete:
- `extensionHostWindow`, `loadExtInHost`, `extensionWindows`, the v1 portion of `extensionBroadcaster` (v2 broadcast via `getAllTileWindows()` stays).
- Legacy IPC channels: `IPC_CHANNELS.SUBSCRIBE/PUBLISH`, `window-open` / `window-close` / `cmd-result` / etc. Audit each before deleting (some may still be used by chrome-extensions content scripts — investigate).
- `preload.js` (v1) — delete the file.
- Fallback branches in `tile-preload.cts`: every `if (!hasXxxCapability()) return ipcRenderer.invoke('legacy-channel', ...)` becomes an unconditional call to the strict path. ~10 methods affected.

Acceptance: full test suite passes. `git grep IPC_CHANNELS` returns nothing (or only the const declaration to also delete).

### Phase 4 — Manifest cleanup

Now that `tile-preload.cts` is the only preload and `tile:*` is the only IPC surface:
- Drop `type?: 'window' | 'background' | 'panel'` from `TileEntry`. Replace background-tile uses with `resident: true` + no width/height (or 0×0 if explicitly desired).
- Drop the `windowHints` nested object (already redundant with flat fields).
- Decide: bump `manifestVersion` to 3 to signal the v1-removal milestone, or drop the field.
- Update all 26 feature manifests + the 3 core renderers' implicit "manifests" (the privileged-grant declarations) to the canonical shape.
- Update `docs/tiles-single-file.md`, `docs/tile-preload-trimming-plan.md`, `docs/command-audit.md`.

Acceptance: one renderer mechanic, one preload, one IPC surface. `tile-preload.cts` shrinks substantially.

---

## Risks & mitigations

- **Privileged grant for core.** The `core: true` flag bypasses capability gating. Audit every place capability is enforced to make the bypass explicit (avoid silent bypasses). Consider naming it `trusted-builtin` or similar to make the intent unmistakable in code review.
- **Test breakage during Phase 2.** Migrate test-by-test. Keep both fixtures available simultaneously during the transition (return either bgWindow-v1 or test-renderer-v2 from `getBackgroundWindow()` based on a feature flag; flip the default once green).
- **HUD focus / alwaysOnTop.** The HUD has unusual window properties (`alwaysOnTop`, `focusable: false`, `transparent`, app-blur hide/show). Already supported in flat-field manifest, but verify on macOS via a smoke test after Phase 1.
- **Performance.** No regression expected: cmd panel and hud were already standalone BrowserWindows; only the background iframe changes. The page tiny resident renderer is ~one extra hidden window.
- **Chrome extensions** stay as-is — loaded via Electron's `session.loadExtension`, not the tile mechanism. No change.
- **Cross-backend portability.** Phase 1's frontend changes work in any backend. Each backend (Electron / Tauri / mobile) needs its own glue file equivalent (`cmd-glue.rs`, etc.) that launches the renderer with privileged grant — small and predictable.

---

## Order & estimate

Sequential — each phase depends on the previous:

1. Phase 1: ~2 days (3 core renderer conversions + privileged-grant infra + glue updates)
2. Phase 2: ~1–2 days (test fixture renderer + migrate test calls)
3. Phase 3: ~1 day (deletion + audit)
4. Phase 4: ~1 day (manifest cleanup, docs)

Total: ~5–6 days.

---

## Validation per phase

- After each phase: full `yarn test:unit` + `yarn test:electron:bg` should pass at the same level (or strictly better) than before.
- After Phase 2: the kagi / tag / widget-update flakies should pass — the v1↔v2 routing seam disappears.
- After Phase 3: zero references to `IPC_CHANNELS`, `loadExtInHost`, `extensionHostWindow` in the codebase.
