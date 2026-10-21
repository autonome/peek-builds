# v1 Removal Smoke Regression Analysis

*Historical: a root-cause pass over thirty smoke-test failures during the v1 removal; not current guidance.*

**Date:** 2026-04-18  
**Failing:** 30 tests (81 pass / 30 fail)  
**Analyst:** Agent (automated root-cause run)

---

## Summary

| # | Category | Root Cause | Estimated Fix |
|---|----------|-----------|--------------|
| 1 | Cmd palette UI (9 tests) | `panel.js` never calls `api.initialize()`; uses removed `api.settings.setKey`; `api.settings.get()` called with no arg (wrong signature) | 30 min |
| 2 | External URL via cmd (5 tests) | Same root cause as #1 — cmd panel crashes before commands load | 0 min (fixed by #1) |
| 3 | Hybrid Extension Mode (4 tests) | `cmd/background.js` uses old `settings.get()` (no arg) / `settings.set(wholeObject)` API shape removed in Phase 4 | 20 min |
| 4 | Window Targeting / theme (3 tests) | `lastFocusedVisibleWindowId` never set in headless mode (`show: false`); trustedBuiltin `setWindowColorScheme` wrapper returns `null`→falls back to own hidden window | 20 min |
| 5 | IZUI Behavior (3 tests) | `about:blank` windows get no preload → `window.app` undefined in `contentWindow.evaluate`; plus possible cascade from #1 in same describe block | 15 min |
| 6 | Scripts Extension (2 tests) | Both tests destructure `{ scriptExecutor }` from `script-executor.js` but the file only exports `class ScriptExecutor` (uppercase) — named export mismatch | 10 min |
| 7 | Data Persistence (1 test) | `settings.html` / `settings.js` never calls `api.initialize()` — `createDatastoreStore` silently gets empty data; theme CSS never injected → `--theme-font-sans` not set | 20 min |
| 8 | Backup configured (1 test) | Indirect cascade: settings pane is broken (see #7), but the backup test is in the `sharedBgWindow` describe block which runs independently; needs separate investigation | 10 min |

**Total estimated fix budget: ~125 min across 5–6 independent fix scopes**

**Dependency order:**
- Fix #1 (cmd panel `api.initialize` + API shape) first — resolves #1 and #2.
- Fix #3 (cmd/background.js settings API) is independent.
- Fix #4 (theme headless) is independent.
- Fix #5 (about:blank preload) is independent.
- Fix #6 (scripts named export) is independent.
- Fix #7 (settings.html initialize) may also fix #8 if backup test depends on settings loading.

---

## 1. Cmd Palette UI — 9 tests

**Failing:** lines 93, 142, 1999, 3026, 3085, 3149, 3203, 3333, 3610

**Root cause:** When `peek://ext/cmd/panel.html` is opened via `app.window.open`, it now receives `tile-preload.cjs` with a `cmd-ui` trustedBuiltin token (added in commit `mzkpnyyy`). This is correct. However, `app/cmd/panel.js` (loaded by `panel.html`) never calls `api.initialize()`. In `tile-preload.cts`, every capability API checks `tokenValid` before proceeding — `tokenValid` is only set to `true` after `api.initialize()` completes. As a result:

- `api.settings.get()` (called at panel.js:38 and :94) throws `Promise.reject(new Error('Not initialized'))` rather than returning settings.
- `api.settings.setKey(...)` (called at panel.js:49, :50, :60, :72, :73) throws `Error('[tile-preload] api.settings.setKey removed in Phase 4; use api.settings.set')` — this method was hard-deleted in tile-preload Phase 4 but panel.js was never updated.
- `api.subscribe(...)` and `api.publish(...)` silently no-op (they log a warning and return early when `tokenValid=false`), meaning no commands ever reach the panel.

The result is that the panel's JS crashes during initialization, `waitForPanelCommandsLoaded` times out, and all cmd-panel-dependent tests fail.

**Affected commits:** `mzkpnyyy` (Phase 3.11b cmd-ui routing, which added the token but didn't update panel.js for Phase 4 API shape)

**Recommended fix:**
1. Add `await api.initialize()` at the top of `panel.js` before any API calls.
2. Replace `api.settings.setKey(key, val)` calls with `api.settings.set(key, val)`.
3. Replace `api.settings.get()` (no arg, returns full object) with `api.settings.get(key)` per-key calls or a multi-key load loop.
4. Add `api.commands.flush()` as a no-op or functional method to `api.commands` in tile-preload (see §8 for the separate flush issue — tests 3956, 4000 call `api.commands.flush()` which is undefined).

**Budget:** 30 min

---

## 2. External URL via Cmd — 5 tests

**Failing:** lines 810, 857, 903, 949, 1057

**Root cause:** These tests all open `peek://ext/cmd/panel.html`, type a URL, and press Enter. Because the cmd panel crashes during init (see §1), the panel never registers its URL-detection logic. `waitForPanelCommandsLoaded` times out at 5–10s.

**Affected commits:** Same as §1.

**Recommended fix:** Fixed automatically by resolving §1.

**Budget:** 0 min (dependency on §1)

---

## 3. Hybrid Extension Mode — 4 tests

**Failing:** lines 4194, 4288, 4375, 4446

**Root cause:** `app/cmd/background.js` uses Phase 3-era `api.settings` call shapes that were removed in Phase 4:
- Line 50: `api.settings.get()` — no argument. Under the old v1 preload, this returned all settings for the `cmd` tile as a flat object (with nested `prefs` key). Under tile-preload, `tile:settings:get` requires a string `key` argument. Calling with `key=undefined` returns `{ value: null }`, so `result.data.prefs` is `undefined` and cmd always falls back to defaults.
- Line 63: `api.settings.set(settingsObject)` — passes the entire settings object as the `key` argument instead of `(key, value)`. The IPC handler stores `featureId=cmd, key=[object Object]` which is never findable.

As a consequence: cmd ignores persisted settings on load and saves to the wrong row. The tests at 4375 and 4446 expect custom `shortcutKey` to be persisted and reloaded, but both read/write to wrong DB rows. Test 4288 (window count) and 4194 (reload) may fail because the example window isn't found — the example extension is lazy and its background window is loaded via lazy-stub; if cmd's startup is confused (due to settings errors), the `ext:ready` handshake timing could be off.

**Affected commits:** Phase 3.11b commits that introduced strict settings API (`tile:settings:get/set`) without updating `app/cmd/background.js`.

**Recommended fix:**
- Change `loadSettings()` in `app/cmd/background.js` to use `api.settings.get('prefs')`.
- Change `saveSettings()` to use `api.settings.set('prefs', settings.prefs)`.
- Verify the DB row key changes from `cmd_[object Object]` to `cmd_prefs` (matching what test 4375 asserts at `getRow('feature_settings', 'cmd_prefs')`).

**Budget:** 20 min

---

## 4. Window Targeting / Theme — 3 tests

**Failing:** lines 4547, 4590, 4650

**Root cause:** All three tests call `api.theme.setWindowColorScheme(colorScheme)` from `sharedBgWindow` (the trustedBuiltin test fixture). In tile-preload, the trustedBuiltin override of `setWindowColorScheme` first calls `ipcRenderer.invoke('get-focused-visible-window-id')` to resolve the target window. This IPC returns `lastFocusedVisibleWindowId` from `ipc.ts`.

In headless mode (`E2E_TEST=true`), all windows are created with `show: false`. Windows that are never shown never emit `focus` events, so `trackVisibleWindowFocus()` is never called, and `lastFocusedVisibleWindowId` remains `null`. The tests open `peek://app/settings/settings.html` (non-modal) hoping it becomes the focus target, but in headless mode it doesn't update the tracker.

The trustedBuiltin wrapper then falls back to `tile:window:get-id` which returns the test fixture's own hidden BrowserWindow ID — a window that is neither the settings window nor any user-facing target. `setWindowColorScheme` succeeds but on the wrong window. The test asserts `result.windowId === settingsWindowId` which fails.

**Affected commits:** `mzkpnyyy` / Phase 3.11b-settings: the settings window moved from preload.js (which had a direct `theme:setWindowColorScheme` handler that accepted a windowId from the caller) to the trustedBuiltin wrapper path (which resolves window via focus tracker). The focus tracker is unreliable in headless mode.

**Recommended fix:** In the trustedBuiltin `setWindowColorScheme` wrapper, when `get-focused-visible-window-id` returns null, try to fall back to the most recently opened non-modal, non-hidden BrowserWindow (e.g. add a `tile:window:list-visible` path or maintain a secondary "last opened" tracker for headless mode). Alternatively, expose a `windowId` parameter override so tests can pass the target directly.

**Budget:** 20 min

---

## 5. IZUI Behavior — 3 tests

**Failing:** lines 4830, 4890, 4949

**Root cause (4890):** Test opens `about:blank` via `api.window.open('about:blank', ...)` and then calls `contentWindow.evaluate(() => window.app.escape.onEscape(...))`. The `window-open` handler in `ipc.ts` checks a series of special cases (diagnostic, settings, hud-overlay, viewer, cmd-ui, canvas). `about:blank` matches none of them: it doesn't start with `http/https`, it's not a `peek://` tile URL, so `tileWebPrefs = null` and `preload = undefined`. The window gets no preload. `window.app` is `undefined` in that window → `TypeError: Cannot read properties of undefined (reading 'escape')` → test fails.

**Root cause (4830 and 4949):** Likely a test-ordering cascade. The `IZUI Behavior @desktop` describe block uses `sharedBgWindow` which is the same instance as other describe blocks. If earlier failing tests in prior describe blocks leave state that causes `waitForExtensionsReady` to hang or `sharedApp.getWindow(...)` to time out, the IZUI tests may fail even though their actual window-open logic is correct. Test 4830 opens `groups/home.html` (v2 tile, correct preload) and a child canvas page — both should work. Test 4949 simply calls `api.window.close()` from bgWindow. These two may be timing/ordering casualties rather than direct regressions.

**Affected commits:** The `about:blank` gap has always existed (no preload for `about:blank`). Under v1 preload.js, `about:blank` would have received `preload.js` unconditionally. After Phase 3.11b deleted preload.js, `about:blank` gets nothing. The test was likely passing before because v1 preload was injected for all windows.

**Recommended fix:**
- For 4890: Add `about:blank` to the special-case list in ipc.ts (same as the `cmd-ui` pattern) OR update the test to open a `peek://` URL that receives a preload.
- For 4830/4949: investigate if they're real failures or ordering artifacts once the cmd panel (§1) is fixed.

**Budget:** 15 min

---

## 6. Scripts Extension — 2 tests

**Failing:** lines 5251, 5372

**Root cause:** Both tests run `const { scriptExecutor } = await import('peek://ext/scripts/script-executor.js')` — destructuring the name `scriptExecutor` (lowercase). The file `features/scripts/script-executor.js` only exports `class ScriptExecutor` (uppercase class) via `export class ScriptExecutor { ... }`. There is no named `scriptExecutor` export (a pre-built instance). Destructuring a non-existent export yields `undefined`, so `scriptExecutor.executeScript(...)` throws `TypeError: Cannot read properties of undefined (reading 'executeScript')`.

This is a test/implementation mismatch — the test was written expecting an exported singleton (`scriptExecutor`) rather than a class (`ScriptExecutor`).

**Affected commits:** Either the test was written assuming an API that was changed, or the script-executor export was refactored from a singleton to a class without updating the tests. No direct link to v1 IPC removal — this may be a pre-existing bug that was masked by other test failures.

**Recommended fix:** Either:
- Add `export const scriptExecutor = new ScriptExecutor();` to `features/scripts/script-executor.js`, OR
- Update both test calls to `const { ScriptExecutor } = await import(...); const scriptExecutor = new ScriptExecutor();`.

**Budget:** 10 min

---

## 7. Data Persistence — 1 test

**Failing:** line 1172

**Root cause:** The test opens `peek://app/settings/settings.html` after restart and checks that `getComputedStyle(document.documentElement).getPropertyValue('--theme-font-sans')` contains `'ServerMono'`. The CSS variable `--theme-font-sans` is defined in `themes/peek/variables.css` and delivered via `peek://theme/variables.css`. Settings.html doesn't import this CSS directly — settings.js normally loads theme info via `api.theme.get()` and injects it. Under tile-preload, settings.js uses `window.app` without calling `api.initialize()`. The `init()` function calls `createDatastoreStore('core', ...)` which calls `api.datastore.getTable(...)` — this silently returns empty (warning + catch at utils.js:83) because `tokenValid=false`. Settings renders with empty data, theme CSS is never injected into the DOM, `--theme-font-sans` is undefined.

**Affected commits:** `mukyouzn` (`refactor(settings): migrate to tile-preload + strict shims`). That commit gave settings.html a tile-preload token but did not add `await api.initialize()` to settings.js.

**Recommended fix:** Add `await api.initialize()` at the top of `settings.js` (or in the `window.addEventListener('load', init)` handler before other API calls). Also review that settings.js uses the new `api.settings.get(key)` / `api.settings.set(key, value)` signatures where applicable (the settings UI primarily uses `api.datastore.*` directly, so this may be minor).

**Budget:** 20 min

---

## 8. Backup Configured — 1 test

**Failing:** line 4745

**Root cause:** Test 4745 is the fourth test in the `Backup @desktop` describe block ("backup works when backupDir is configured"). The first three backup tests (4702, 4716, 4726, 4735) all pass. The failing test calls `api.backup.create()` after setting `backupDir` in core prefs. The `tile:backup:create` handler calls `getBackupConfig()` which reads from the DB directly (bypasses tile API), then calls `createBackup()`. The backup path uses `app.getPath('temp')` which is valid. This test does not have an obvious direct link to v1 IPC removal.

Likely cause: The test stores `backupDir` via `api.datastore.setRow('feature_settings', 'core:prefs', ...)` and then reads `api.backup.getConfig()`. `getBackupConfig()` calls `getBackupDirFromCoreSettings()` which reads `featureId='core', key='prefs'` from the DB, parses it as JSON, and extracts `backupDir`. If the test's `setRow` call succeeds but the row format is different from what `getBackupDirFromCoreSettings()` expects, the dir would be empty. This warrants a targeted investigation to see if `getBackupDirFromCoreSettings` is compatible with the `feature_settings` row format that `api.datastore.setRow` writes.

**Affected commits:** Likely not a direct v1 removal regression — could be a pre-existing test/implementation mismatch revealed by a separate change, or a timing issue in the shared test profile. Investigate separately.

**Budget:** 10 min (investigation; fix may be trivial or may be 0 if it's environment-specific)

---

## Phase 4 API Breakage — Cross-cutting Note

Multiple renderers that were migrated to receive `tile-preload` in Phase 3.11b were NOT updated for Phase 4 API shape changes:

| File | Problem |
|------|---------|
| `app/cmd/panel.js` | No `api.initialize()`; uses `settings.get()` (no arg); uses removed `settings.setKey()` |
| `app/cmd/background.js` | Uses `settings.get()` (no arg); uses `settings.set(wholeObj)` |
| `app/settings/settings.js` | No `api.initialize()` |
| `app/page/page.js` | No `api.initialize()` (canvas page-host gets tile-preload via ipc.ts `useCanvas` path) |

The pattern: Phase 4 hardened `api.settings.get(key)` / `api.settings.set(key, value)` and removed `api.settings.getKey` / `api.settings.setKey`, but the renderer JS files were not updated to match. Any renderer that received tile-preload during Phase 3.11b and calls the old settings API shape will fail silently or crash.
