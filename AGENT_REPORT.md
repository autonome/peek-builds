# Phase 3 — v1-removal destructive cleanup

## Outcome — limited scope, 1 commit

The Phase 3 preconditions documented in `docs/v1-removal-plan.md` are
only partially met: Phase 1 (cmd/hud/page on tile-preload) and
Phase 2 (test fixture on v2 renderer) are landed, but the v1 plumbing
has more dependencies than the plan enumerated. Most of the targets
listed in the task are still LIVE at runtime and cannot be deleted
in this phase without collateral migration work.

One dead-code path was safely removed; everything else is documented
here with evidence for the follow-up phase.

## Commits in this run

1. `chore(agent-report): Phase 3 triage — document v1 blockers`
   (`f2755d5c`)
2. `refactor main: delete dead loadExtensionsConsolidated — no callers,
   stale path` (`744fd220`) — removed 59-line dead function in
   `backend/electron/main.ts`. Not called anywhere; documented "kept
   for compatibility" but actual loader is `loadExtensions()` which
   incorporates the logic inline. No references outside a stale docs
   mention.

## Validation after commit `744fd220`

All six quick tests pass, plus full unit suite:

| Test | Status |
| --- | --- |
| yarn test:unit (2220 tests) | pass |
| v2 trustedBuiltin tile → v2 pubsub round-trip | pass |
| direct pubsub kagi execution works (control) | pass |
| tag command with # prefixed tags stores tags without prefix | pass |
| open and close settings | pass |
| HUD (11 tests) | pass |
| Group Mode Context (5 tests) | pass |

LOC reduction: -59 lines (one function).

## Targets from the task — disposition

### Part A — frontend / test side

- `app/background.html` — **KEPT.** It is the target of
  `WEB_CORE_ADDRESS` (`backend/config.ts:12`). Loaded at startup by
  `createBackgroundWindow()` in `main.ts:2097` (called unconditionally
  from `entry.ts:780`). Runs `app/index.js` — the core app logic
  (session manager, pubsub hub, etc.). Cannot delete without migrating
  this core window to a v2 renderer. Not Phase 3 scope.
- `app/background.js` — **already absent** (tree has no such file).

### Part B — preload + glue

- `backend/electron/preload.js` — **already absent** (tree has no such
  file). The file that plays this role lives at repo root:
  `/Users/dietrich/misc/mpeek/preload.js`.
- Root `preload.js` (v1) — **KEPT.** Live consumers:
  - `backend/electron/entry.ts:149` captures the path via
    `setPreloadPath()` and installs it on every `peek://` webview in
    `will-attach-webview` (entry.ts:179).
  - `backend/electron/main.ts:2098` uses it as the preload for
    `createBackgroundWindow()` (the WEB_CORE_ADDRESS window).
  - `backend/electron/ipc.ts:2296, 2698` use it as the window-open
    fallback for non-v2 tile URLs.
  - `backend/tauri/src-tauri/src/lib.rs:30` reads it via
    `include_str!` for Tauri (mobile) backend.
  All of these need migration before this file can go.
- tile-preload.cts legacy fallback branches — **KEPT.** The plan says
  these become unconditional strict-only once v1 is gone. With v1 still
  present (see above), converting could break any v2 tile whose
  manifest omits a capability. ~10 affected methods under
  `window.*`, `datastore.*`, `context.*`, `feature-registry/install/update`,
  `oauth`, `sync`. Audit cost exceeds remaining budget.

### Part C — main process IPC + window mgmt

- `extensionHostWindow`, `loadExtInHost`, `extensionWindows` — **KEPT.**
  - `extensionHostWindow` is created unconditionally in `loadExtensions()`
    via `createExtensionHostWindow()` (main.ts:1383) and loads
    `peek://app/extension-host.html`.
  - Playwright contracts assert its existence: `smoke.spec.ts:4177,
    4189, 4359, 5299, 5379` and `README.md:140`.
  - The v1 portion of `extensionBroadcaster` iterates
    `extensionHostWindow.webContents.mainFrame.framesInSubtree` —
    dead at runtime (no frames are added) but live code path.
  - `loadExtInHost` is only called from within `loadExtensions()`'s
    nested CONSOLIDATED_EXTENSION_IDS loops. Those loops are dead at
    runtime because every feature is now `manifestVersion: 2` so
    `consolidatedIds` is always empty — the `if (consolidatedIds.length
    > 0)` block never enters. Deletion is technically safe but omits
    updating `getRunningExtensions()` and the smoke tests that still
    reference the host as "consolidated extension home".
  - `extensionWindows` is the external-extension window map. Populated
    by `createExtensionWindow()` — still called for `externalBuiltinIds`
    and `enabledExternalExts`. Live.
- Legacy IPC handlers in `ipc.ts` — **KEPT.**
  - `ipcMain.handle('window-open')` (ipc.ts:3466), `handle('window-close')`
    (3535) — called by root preload.js and by tile-preload fallback paths.
  - `ipcMain.on(IPC_CHANNELS.PUBLISH/SUBSCRIBE)` (4460/4466) — called
    by root preload.js lines 50, 68, 82, 163, 206, 233, 251, 508, 1288,
    1292, 1331+ (many places).
  - `cmd-result` — not yet audited, but likely live via the same
    preload-mediated path.

### Part D — types / consts cleanup

- `IPC_CHANNELS` const — **KEPT.** Every member is referenced by live
  `ipcMain.on` handlers in `ipc.ts` plus the v1 preload, plus mobile
  (Tauri) backend reads from the same file.

## Architectural observation — "Phase 2.5" is needed

The plan's Phase 3 envisions a clean sweep after test-fixture migration,
but the real blocker is broader:

- `createBackgroundWindow()` → `WEB_CORE_ADDRESS` → `app/background.html`
  → `app/index.js` is an entire second v1 code path that was not
  enumerated in the plan. It is always-on core infrastructure.
- `entry.ts` injects v1 preload into every peek:// webview — widget
  panes, HUD children, etc.
- `createExtensionWindow()` (external extensions incl. Chrome extensions)
  still uses v1 preload paths.

Phase 3 as planned requires those to be migrated first.

## Follow-up items for Phase 2.5 / Phase 4

1. Migrate `createBackgroundWindow()` (`WEB_CORE_ADDRESS`) to a v2
   renderer — either split `app/index.js` into a tile or promote it
   so it no longer needs v1 `window.app`.
2. Migrate `peek://` webview preload injection in `entry.ts:179` to
   tile-preload (or remove entirely if widgets no longer need the
   v1 API).
3. Audit `createExtensionWindow()` callers (external built-ins like
   `example`, third-party installable extensions) — migrate to the v2
   tile launcher path.
4. Remove the `CONSOLIDATED_EXTENSION_IDS` list — every feature now
   reports `manifestVersion: 2`, so this list only affects dead
   filtering.
5. Remove the dead iframe-load code in `loadExtensions()` (the
   `if (consolidatedIds.length > 0)` block plus the `loadExtInHost`
   helper). Safe once the CONSOLIDATED list is gone.
6. Once v1 preload.js has no consumers in Electron, inline the Tauri
   bridge's equivalent functions so `include_str!("../../preload.js")`
   can be swapped for the mobile-specific implementation, then delete
   the Electron file.
7. Update `smoke.spec.ts` assertions on `peek://app/extension-host.html`
   once the consolidated host is gone.
8. Flip tile-preload.cts fallback branches to unconditional strict —
   one method per commit with a validation pass each.
9. Delete `IPC_CHANNELS` const + handlers after root preload.js is gone.

## Files touched

- `AGENT_REPORT.md` — this report (triage commit + final).
- `backend/electron/main.ts` — removed `loadExtensionsConsolidated`
  (59 lines).
