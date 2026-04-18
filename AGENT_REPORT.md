# Phase 2.5 #1 Agent Report — Core Background Renderer to v2 Tile Mechanics

## What landed

Single jj commit: `feat(core-glue + app/background): migrate core background renderer to v2 tile-preload + trustedBuiltin`

(Files edited in this commit; the `core-glue.ts` skeleton already existed in HEAD from a prior agent but was not wired up — this commit makes it live by editing `main.ts` / `entry.ts` and the renderer-side HTML/JS + tile-preload API additions.)

### Files changed

- `backend/electron/main.ts` — `createBackgroundWindow()` refactored to delegate to `initCore()` from `./core-glue.js`. `getBackgroundWindow()` now prefers `getCoreBackgroundWindow()`. `tilePreloadPath` resolved + cached in `initialize()` (was duplicated inside `loadExtensions()`). ~150 lines of dead `setWindowOpenHandler` child-window logic removed (native `window.open()` never happens from core background HTML — only `api.window.open()` is used, which routes through `tile:window:open`). Unused imports dropped (`trackWindowLoad`, `updateItemTitle`, `updateItemFavicon`, `updateModeForNavigation`, `getPreloadPath`, `APP_DEF_WIDTH`, `APP_DEF_HEIGHT`, `trackWindow`, `addEscHandler`, `winDevtoolsConfig`, `closeOrHideWindow`, `getPrefs`).
- `backend/electron/entry.ts` — `createBackgroundWindow()` call is now `await`ed (it returns a Promise).
- `backend/electron/tile-preload.cts` — added `api.quit` / `api.restart` / `api.chromeExtensions.*` (all trustedBuiltin-gated) and extended `api.theme` with `get/list/getAll/setTheme/setColorScheme/setWindowColorScheme` when `trustedBuiltin === true`. The strict `tile:theme:*` surface is unchanged for feature tiles.
- `app/background.html` — CSP updated to `script-src 'self' 'unsafe-inline'` (inline `<script type=module>` now required by the shim below). Replaced the old `<script src="./index.js">` with a short inline module that: (a) `await api.initialize()`, (b) `await import('./index.js')` then `await mod.init()`, (c) sets `window.__coreReady = true`. Same shape as `app/_test/index.html`.
- `app/index.js` — `init` is now `export const init = async () => {...}` and the old `window.addEventListener('load', ...)` bootstrap is removed. Core startup is explicitly driven by `background.html` so subscribers are registered before any downstream publisher fires.
- `backend/electron/core-glue.ts` — already present in HEAD; no further edits needed.

## Validation results (all via `yarn test:grep`, `yarn test:unit`)

| Test | Result |
|------|--------|
| `v2 trustedBuiltin tile → v2 trustedBuiltin tile pubsub round-trip` | 1/1 pass |
| `direct pubsub kagi execution works` | 1/1 pass |
| `tag command with # prefixed tags...` | 1/1 pass |
| `open and close settings` | 1/1 pass |
| `Group Mode Context` | 5/5 pass |
| `HUD` | 11/11 pass |
| `yarn test:unit` | 565/565 pass, 0 failures |

Window-list inspection from the `v2 trustedBuiltin tile` test confirms `peek://app/background.html` now appears in the v2 tile window list alongside cmd/hud/page/test:

```
peek://app/background.html, peek://cmd/index.html, peek://hud/index.html,
peek://page/background.html, peek://test/index.html, ... (29 feature tiles)
```

## Surprises / dependencies discovered in `app/index.js`

- `api.theme` had to be augmented under trustedBuiltin. The strict `api.theme` only has `getInfo`/`onChange`. The core palette commands (`theme light`, `theme dark`, `theme next`, `theme light here`, etc.) need `get`/`list`/`setTheme`/`setColorScheme`/`setWindowColorScheme`. Added as trustedBuiltin-gated thin wrappers over the existing `theme:*` `ipcMain.handle` channels.
- `api.quit` / `api.restart` don't have an `ipcMain.handle` path — they use `ipcMain.on` (fire-and-forget). `api.invoke` can't substitute, so added dedicated `.send`-based wrappers under trustedBuiltin.
- `api.chromeExtensions.getUiEntries()` / `.openPage()` are used by `registerExtensionCommands()` to register one cmd-palette entry per chrome extension popup/options page. Added trustedBuiltin-gated wrappers.
- `api.debug` / `api.debugLevel` / `api.debugLevels` — not present in tile-preload. `app/log.js` reads them defensively (`api?.debug || false`), so the renderer falls through to no-debug-logging. Acceptable for now; if we want debug logs back, add them to tile-preload's "always available" surface.
- The big `setWindowOpenHandler` block in the old `createBackgroundWindow` was 150+ lines handling `window.open()` from the background renderer. After v2 migration, `api.window.open` routes via `tile:window:open` (which in turn delegates to the canonical `window-open` IPC handler in `ipc.ts`), so **nothing inside `app/index.js` or its imports triggers native `window.open()`**. Confirmed by grep + runtime log — the block was dead under v1 too, kept only because the code path worked.
- `app/background.html` needed `'unsafe-inline'` in its CSP — pure ES-module inline scripts (`type="module"`) are still `inline` from CSP's perspective. Every other core renderer (`_test`, `cmd`, `hud`, `page`) already has this; background.html was the holdout.
- `createBackgroundWindow` is now async. The only caller (`entry.ts:780`) was synchronous fire-and-forget; converted to `await`. If any Tauri port was going to reuse the electron entry shape, it needs the same change.

## Items for Phase 2.5 #2 / #3

- **`entry.ts:179` webview preload injection** still uses v1 `preload.js`. Unchanged.
- **`main.ts::createExtensionWindow()`** (line ~1100) still creates external-extension windows with v1 `preload.js`. Unchanged.
- **`registerWindow` call** previously inside the old `createBackgroundWindow` body now happens INSIDE the new `createBackgroundWindow` wrapper — so `closeOrHideWindow` / `countVisibleWindows` / session-restore skip logic continues to work via the `address === WEB_CORE_ADDRESS` check.
- **`core-glue.ts`** registers the background window via `registerTrustedBuiltinWindow()` for pubsub broadcast; the `registerWindow()` call in session-registry terms is done in the main.ts wrapper. The two are orthogonal — pubsub broadcast vs session-registry key-lookup.
- **v1 `preload.js` not yet removed.** Still consumed by webview injection (`entry.ts:179`), `createExtensionWindow` (main.ts), window-open IPC fallback in `ipc.ts`, and Tauri's `include_str!`. Phase 3 / 4.
- **Minor:** `app/_test/index.html` and `app/background.html` now have nearly identical bootstrap shims — could factor into a shared `app/shared/trusted-builtin-bootstrap.js` in a later cleanup. Not blocking.

## Window list inspection

From the `v2-pubsub-reproducer.spec.ts` run above, the list of live windows at steady state now contains `peek://app/background.html` as expected:

```
peek://app/background.html, peek://app/extension-host.html,
peek://app/settings/settings.html, peek://cmd/index.html,
peek://hud/index.html, peek://page/background.html,
peek://test/index.html, ...
```

`peek://app/extension-host.html` is still there — phase 2.5 #4 audit concluded it's retained solely for legacy smoke-test assertions, not for actual extension loading.
