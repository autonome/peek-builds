# V1 Removal — Phase 3 Work Packages

Break Phase 3 (destructive cleanup of remaining v1 plumbing) into small
agent-sized tasks. Each package is sized for a 15–20 min agent spawn.

See `docs/v1-removal-plan.md` for background, the rolled-back Phase 3
attempt's lessons, and the Phase 2/2.5 work that's already landed.

---

## Current state (what's still v1)

After Phase 2.5 cleanup, these v1 surfaces are still present:

1. **`extensionHostWindow`** BrowserWindow + `createExtensionHostWindow()`
   — still created at startup. Loads `peek://app/extension-host.html`.
   Now empty (no iframes; cmd/hud/page moved out). Still needed because
   smoke tests assert on the URL's existence (`smoke.spec.ts:4177, 4189,
   4359, 5292, 5299, 5379`) and the v1 portion of `extensionBroadcaster`
   still iterates its frames.
2. **`extensionWindows` map** — never populated after Phase 2.5 #3
   (`createExtensionWindow` was deleted). Still referenced by
   `destroyExtensionWindow`, `getExtensionWindow`, `getRunningExtensions`,
   `getAllRegisteredExtensions`, broadcaster loop. Dead-path: all callers
   hit an always-empty map.
3. **`loadedConsolidatedExtensions` Set + `CONSOLIDATED_EXTENSION_IDS`
   list** — list has 20 ids, but post-v2 migration none of them load
   through the consolidated host. `loadedConsolidatedExtensions.add(...)`
   still called for `cmd`/`hud`/`page` solely to keep them visible in
   `getRunningExtensions()`.
4. **Legacy IPC channels in `ipc.ts`** — ~103 `ipcMain.handle/on` calls
   for `window-*`, `datastore-*`, `context-*`, `chrome-ext:*`, `oauth-*`,
   `izui-*`, `extension-*`, `feature-registry:*`, `feature-install:*`,
   `feature-settings-schema`, `screen-*`, `save-space-workspaces`,
   `sync-full`, `renderer-log`, `app-quit`, `app-restart`, and the
   `IPC_CHANNELS.*` set (`SUBSCRIBE`, `PUBLISH`, `CLOSE_WINDOW`,
   `REGISTER_SHORTCUT`, `UNREGISTER_SHORTCUT`, `MODIFY_WINDOW`,
   `CONSOLE`). Callers: `preload.js` and `tile-preload.cts` fallback
   branches.
5. **`preload.js`** (2693 LOC) — still referenced by `entry.ts:152`
   (`setPreloadPath`), webview v1 fallback in `entry.ts:207`, and
   `ipc.ts:2268,2670` window-open fallback for non-tile URLs.
6. **Fallback branches in `tile-preload.cts`** — 4 explicit
   `if (!hasXxxCapability()) return ipcRenderer.invoke('legacy-*')`
   branches for `izui-*` + ~70 unconditional `ipcRenderer.invoke(...)`
   calls against legacy non-`tile:*` channels (datastore-*, window-*,
   context-*, extension-*, chrome-ext:*, oauth-*, screen-*, feature-*,
   sync-full, etc.). Each is a candidate to re-route to a strict
   `tile:*` handler or (if the capability gate is redundant) to delete
   entirely. ~10 sites need validation.
7. **`IPC_CHANNELS` const** in `backend/config.ts:16-27` — imported by
   `backend/electron/ipc.ts`, `backend/electron/index.ts`,
   `backend/electron/config.ts`. Delete after no callers remain.
8. **`getRunningExtensions()` / `getAllRegisteredExtensions()` /
   `isConsolidatedExtension()`** — still called from `ipc.ts:1300,1310,
   1323,1333`. Features pane + extension-management IPCs depend on them.
   Need to keep the product surface but rewrite to use
   `getLoadedTileIds()` + `getTileManifest()` instead of the v1 maps.

Other minor surfaces:
- `INTERNAL_URLS` array in `ipc.ts:2306` references
  `peek://app/extension-host.html` for opener-parent detection — follows
  from #1.
- `tests/fixtures/desktop-app.ts:227` — test helper filters out the
  extension-host window. Follows from #1.

---

## Dependency graph

```
phase3.1 (audit ext-host deletion feasibility)
    |
    +-- phase3.2 (delete extensionWindows map + friends)  [indep]
    |
    +-- phase3.3 (collapse tile-preload izui fallbacks)   [indep]
    |
    +-- phase3.4 (audit legacy IPC channels vs callers)   [indep, audit-only]
    |
    v
phase3.5 (rewrite getRunningExtensions / getAllRegisteredExtensions for v2)
    |
    v
phase3.6 (delete extensionHostWindow + host HTML + broadcaster v1 branch)
    |
    v
phase3.7 (delete IPC_CHANNELS.* + preload.js consumers)  <- depends on 3.4
    |
    v
phase3.8 (delete preload.js file + cleanup)
```

### Parallelism

- **Wave 1 (parallel):** 3.1, 3.2, 3.3, 3.4 — all independent, audit or
  narrowly-scoped delete.
- **Wave 2 (sequential):** 3.5 after 3.1 (needs audit outcome).
- **Wave 3:** 3.6 after 3.5.
- **Wave 4:** 3.7 after 3.4 + 3.6.
- **Wave 5:** 3.8 after 3.7.

---

## Work packages

### phase3.1 — Audit: can `extensionHostWindow` be removed?

**Scope:** Read-only audit. Document whether the 6 smoke-test assertions
on `peek://app/extension-host.html` represent a real product assertion
(there must be exactly one extension host window) or are historical. For
each of the 6 sites in `smoke.spec.ts`, note what the test is actually
validating and whether the assertion can be rewritten against v2 tile
windows or deleted. Produce a short report (append to this doc or in a
commit body) recommending one of: (a) rewrite tests + delete window,
(b) delete tests + delete window, (c) keep window as empty shell.

**Files:**
- `/Users/dietrich/misc/mpeek/tests/desktop/smoke.spec.ts` (lines 1383,
  4177, 4189, 4359, 5292, 5299, 5379)
- `/Users/dietrich/misc/mpeek/tests/fixtures/desktop-app.ts:227`
- `/Users/dietrich/misc/mpeek/tests/README.md:140` (docs reference)

**Dependencies:** none

**Budget:** 20 min

**Validation:** none (audit-only). Commit the recommendation doc.

**Risk:** low — no source changes. Output is a decision input for 3.6.

---

### phase3.2 — Delete `extensionWindows` map + `destroyExtensionWindow` + `getExtensionWindow`

**Scope:** After Phase 2.5 #3 deleted `createExtensionWindow()`, nothing
populates `extensionWindows`. Delete the map, its inserts/deletes, the
`destroyExtensionWindow` + `getExtensionWindow` exports, and the
broadcaster loop iterating it. Update callers in `ipc.ts:1199, 1290,
1333` — they become no-ops returning `false`/`null`, or delete the IPC
handlers entirely if no tile uses them.

**Files:**
- `/Users/dietrich/misc/mpeek/backend/electron/main.ts` (lines 73-77,
  247-258, 1335-1343, 1393-1397, 1418-1442, 1447-1450)
- `/Users/dietrich/misc/mpeek/backend/electron/index.ts:149-151`
- `/Users/dietrich/misc/mpeek/backend/electron/ipc.ts:97-98, 1199,
  1290, 1333`

**Dependencies:** none (map is already orphan data)

**Budget:** 20 min

**Validation:**
- `yarn tsc --noEmit`
- `yarn test:unit`
- `yarn test:electron:bg -g "smoke"` (smoke suite to catch regressions)

**Risk:** low — dead code elimination; map is already never populated.

---

### phase3.3 — Collapse `hasIzuiCapability()` fallback branches in tile-preload

**Scope:** Four sites in `tile-preload.cts` have
`if (!hasIzuiCapability()) return ipcRenderer.invoke('izui-*')`.
These fall back to legacy non-`tile:*` channels. Every current v2 tile
with izui needs should declare the `izui` capability. Audit each of the
4 methods: verify the strict `tile:*` handler exists, verify no
currently-deployed tile relies on the fallback. Replace with an
unconditional error throw + remove the fallback branch + remove the
corresponding `ipcMain.handle('izui-*')` legacy handler in `ipc.ts` if
no other caller.

**Files:**
- `/Users/dietrich/misc/mpeek/backend/electron/tile-preload.cts` (lines
  1624, 1636, 1644, 1652, 1660)
- `/Users/dietrich/misc/mpeek/backend/electron/ipc.ts` (`izui-*` handler
  sites — grep first)

**Dependencies:** none

**Budget:** 20 min

**Validation:**
- `yarn tsc --noEmit`
- `yarn test:unit`
- `yarn test:electron:bg -g "izui"` (+ windows-switcher tests, which
  exercise izui heavily)

**Risk:** medium — if any tile was silently relying on the fallback
(i.e. not declaring `izui` capability), it'll start throwing. The audit
step is the mitigation.

---

### phase3.4 — Audit: which legacy IPC channels are still live?

**Scope:** Read-only. For each of the ~103 `ipcMain.handle/on`
registrations in `ipc.ts`, grep who calls it. Three buckets per channel:
(a) only called from `preload.js` → falls when preload.js falls; (b)
also called from `tile-preload.cts` unconditionally → needs strict
migration; (c) called from chrome-extension content scripts or other
non-preload surface → keep. Produce a table: channel → bucket → action.
Output as a new section in this doc.

**Files to grep (callers):**
- `/Users/dietrich/misc/mpeek/preload.js`
- `/Users/dietrich/misc/mpeek/backend/electron/tile-preload.cts`
- `/Users/dietrich/misc/mpeek/chrome-extensions/**` (content scripts)
- `/Users/dietrich/misc/mpeek/backend/tauri/preload.js` (reference,
  don't touch)
- `/Users/dietrich/misc/mpeek/app/**` (legacy `app.*` call sites)

**Dependencies:** none

**Budget:** 30 min (genuine audit with unknown scope — 103 channels)

**Validation:** none (audit). Commit audit table.

**Risk:** low — read-only. Output drives 3.7 sizing.

---

### phase3.5 — Rewrite `getRunningExtensions()` / `getAllRegisteredExtensions()` for v2

**Scope:** These two functions still read `loadedConsolidatedExtensions`
+ `extensionWindows` + `declarativeExtensions` + `CONSOLIDATED_EXTENSION_IDS`.
Rewrite to: running = `getLoadedTileIds()` + `declarativeExtensions` +
core-renderer ids (cmd/hud/page; hardcoded list since they're explicit).
Registered = `getRegisteredExtensionIds()` (unchanged) with running-set
derived the same way. Delete `isConsolidatedExtension()` + the
`loadedConsolidatedExtensions` adds at lines 1214/1225/1237. Verify
Features pane still displays everything correctly.

**Files:**
- `/Users/dietrich/misc/mpeek/backend/electron/main.ts` (lines 89, 97,
  1214, 1225, 1237, 1313-1373, 1380-1413, 1462-1464)
- `/Users/dietrich/misc/mpeek/backend/electron/ipc.ts:100, 1300, 1310,
  1323` (`isConsolidatedExtension` callsite + handlers)
- `/Users/dietrich/misc/mpeek/backend/electron/index.ts` (if exported)

**Dependencies:** phase3.1 (if 3.1 recommends deleting the host window,
the cleanup is tighter)

**Budget:** 30 min

**Validation:**
- `yarn tsc --noEmit`
- `yarn test:electron:bg -g "features"` (Features pane / settings tests)
- `yarn test:electron:bg -g "extension-list"` if any exist
- Manual smoke: launch app, check Settings > Features shows everything.

**Risk:** medium — Features pane is a real user-facing surface. Test
coverage on it may be thin; run a manual smoke.

---

### phase3.6 — Delete `extensionHostWindow` + host HTML + broadcaster v1 branch

**Scope:** Conditional on phase3.1's recommendation being (a) or (b).
Delete `extensionHostWindow` variable, `createExtensionHostWindow()`,
`getExtensionHostWindow()`, the `await createExtensionHostWindow()` call
at `main.ts:1208`, the broadcaster loop iterating host frames
(`main.ts:226-244`), the `INTERNAL_URLS` reference in `ipc.ts:2306`, and
the `app/extension-host.html` file. Update smoke tests per 3.1 outcome.

**Files:**
- `/Users/dietrich/misc/mpeek/backend/electron/main.ts` (lines 80, 226-
  244, 767-771, 1103-1176, 1208, 1321, 1386, 1455-1457)
- `/Users/dietrich/misc/mpeek/backend/electron/ipc.ts:2306`
- `/Users/dietrich/misc/mpeek/app/extension-host.html` — delete
- `/Users/dietrich/misc/mpeek/tests/desktop/smoke.spec.ts` (lines per
  3.1)
- `/Users/dietrich/misc/mpeek/tests/fixtures/desktop-app.ts:227`
- `/Users/dietrich/misc/mpeek/tests/README.md:140`

**Dependencies:** phase3.1 (audit), phase3.5 (rewrites the map consumers
that reference the host window)

**Budget:** 30 min

**Validation:**
- `yarn tsc --noEmit`
- `yarn test:electron:bg -g "smoke"` (full smoke suite)
- `yarn test:electron:bg` (full) if smoke passes

**Risk:** high — this is the "big one." Deletes a window that's existed
since the start of v1. Any test or product code still implicitly
depending on it will break. Phase 3.1's audit is the safety net.

---

### phase3.7 — Delete unused legacy IPC channels + `IPC_CHANNELS` const

**Scope:** For each channel from phase3.4 bucket (a) (only preload.js
callers), delete the `ipcMain.handle/on(...)` registration in `ipc.ts`.
For bucket (b) channels, convert the `tile-preload.cts` calls to strict
`tile:*` paths (audit which need capability gates, which are privileged).
Delete the `IPC_CHANNELS` const from `backend/config.ts`. Update
`backend/electron/ipc.ts:121`, `backend/electron/index.ts:13`,
`backend/electron/config.ts:14` imports. Delete the
`IPC_CHANNELS.SUBSCRIBE/PUBLISH/CLOSE_WINDOW/REGISTER_SHORTCUT/
UNREGISTER_SHORTCUT/MODIFY_WINDOW/CONSOLE/RENDERER_LOG/APP_QUIT/
APP_RESTART` handler blocks at `ipc.ts:4158-4476`.

**Files:**
- `/Users/dietrich/misc/mpeek/backend/electron/ipc.ts` (many lines —
  see phase3.4 output)
- `/Users/dietrich/misc/mpeek/backend/electron/tile-preload.cts` (the
  ~70 `ipcRenderer.invoke('legacy-*')` sites in bucket (b))
- `/Users/dietrich/misc/mpeek/backend/config.ts:16-27`
- `/Users/dietrich/misc/mpeek/backend/electron/config.ts:14`
- `/Users/dietrich/misc/mpeek/backend/electron/index.ts:13`

**Dependencies:** phase3.4 (must know bucket per channel), phase3.6
(host window gone = no frame.send path using IPC_CHANNELS names), phase
3.2 (broadcaster loop simplified)

**Budget:** Split into sub-packages — the whole sweep is too big for
one agent. Suggested split:
- **phase3.7a** (20 min): bucket-(a) channels (preload-only callers).
  Just delete the handler and the preload.js wrapper.
- **phase3.7b** (20 min): window-* channels (~14 channels). Route
  tile-preload calls to existing `tile:window:*` handlers; delete
  legacy window-* handlers.
- **phase3.7c** (20 min): datastore-* channels (~25 channels). Route
  tile-preload calls to existing `tile:datastore:*` handlers; add
  strict variants where missing.
- **phase3.7d** (20 min): extension-* + feature-* channels (~12
  channels) + context-* + chrome-ext:* audit — these are the ones
  most likely to need product decisions; may bounce back to user.
- **phase3.7e** (15 min): `IPC_CHANNELS.*` handlers (9 channels) +
  delete the const.

**Validation per sub-package:**
- `yarn tsc --noEmit`
- `yarn test:unit`
- `yarn test:electron:bg` (each sub-package)

**Risk:** medium–high per sub-package. Bucket (b) tile-preload sites
may hit product-critical paths. Split per domain (window/datastore/
extension) so each agent has a tight scope and the blast radius stays
small.

---

### phase3.8 — Delete `preload.js` file + final cleanup

**Scope:** After 3.7, nothing should import or use `preload.js`. Delete
the file. Remove `preloadPath`/`setPreloadPath`/`getPreloadPath` from
`backend/electron/config.ts`, `entry.ts`, `index.ts`, and the window-open
fallback at `ipc.ts:2268,2670`. Update `will-attach-webview` in
`entry.ts:189-211` to drop the v1 fallback branch — all peek:// webview
children get `tile-preload.cjs` unconditionally (or throw if not a v2
tile).

**Files:**
- `/Users/dietrich/misc/mpeek/preload.js` — delete (2693 LOC)
- `/Users/dietrich/misc/mpeek/backend/electron/entry.ts` (lines 63, 152,
  157, 189-211)
- `/Users/dietrich/misc/mpeek/backend/electron/config.ts` (preload path
  getters/setters)
- `/Users/dietrich/misc/mpeek/backend/electron/index.ts` (exports)
- `/Users/dietrich/misc/mpeek/backend/electron/ipc.ts` (lines 119,
  2268, 2670)

**Dependencies:** phase3.7 (all buckets) + phase3.6

**Budget:** 20 min

**Validation:**
- `yarn tsc --noEmit`
- `yarn test:unit`
- `yarn test:electron:bg` (full suite)
- `git grep preload.js` → should only match comments, docs, or
  Tauri-local copy (which is out of scope per Phase 2.5 #5)
- `git grep "IPC_CHANNELS\b"` → zero matches

**Risk:** medium — the final delete. If anything sneaks through 3.7, it
breaks here. Mitigation: the tsc + test runs in 3.7 should catch it
first.

---

## Out of scope (deferred to Phase 4)

- Tauri-side preload migration (`backend/tauri/preload.js`,
  `backend/tauri-mobile/.../include_str!`). Per Phase 2.5 #5 — copy to a
  Tauri-local path if Electron deletion would break `include_str!`.
- Manifest v3 bump / `type?` field deletion / `windowHints` cleanup —
  Phase 4.
- `docs/tile-preload-trimming-plan.md`, `docs/tiles-single-file.md`,
  `docs/command-audit.md` doc updates — Phase 4.

---

## Sizing principle (per feedback_agent_budgets_short.md)

All packages target 15–30 min. Packages that hit the ceiling (3.4, 3.6,
3.7) are the ones with genuine unknowns; if they overrun, the agent
commits what it has + reports blocker so the next spawn adjusts scope.
Prefer shipping 5 validated packages over 10 sketchy ones.
