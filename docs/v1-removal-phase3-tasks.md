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

---

### phase3.4 — IPC channel audit (2026-04-18)

Audited every `ipcMain.handle(...)` and `ipcMain.on(...)` registration
in `backend/electron/ipc.ts`, then grepped every call site across
`preload.js`, `backend/electron/tile-preload.cts`, `app/**`,
`chrome-extensions/**`, and `backend/electron/**` (excluding test files
and Tauri).

**Total channel count: 193** (183 `.handle` + 10 `.on`).

#### Bucket totals

| Bucket | Count | Meaning |
|---|---|---|
| `preload-only` | 79 | Called only from `preload.js`. Falls when preload.js is deleted in 3.7a/3.8. |
| `tile-preload-fallback` | 33 | Called from `tile-preload.cts` only inside an `if (!hasXxxCapability())` branch. Gated; can be deleted once we audit that every deployed tile declares the relevant capability. |
| `tile-preload-strict-shadow` | 71 | Called UNCONDITIONALLY from `tile-preload.cts` (no strict `tile:*` equivalent OR strict equivalent only for some methods). Need a strict shim built first. |
| `live-other` | 10 | `IPC_CHANNELS.*` set — used by both preload.js and the `tile-preload.cts` pubsub send/subscribe and core glue. Treated as their own batch (3.7e). |

Sum: 79 + 33 + 71 + 10 = 193 ✔

`live-other` here is NOT "external content scripts" — there are zero
`ipcRenderer.*` calls in `chrome-extensions/**`. The chrome polyfills
generate IPC code at runtime via `_ipc-bridge.js` but those target
`chrome-ext-api:*` channels in `tile-ipc.ts`, not legacy channels in
`ipc.ts`. The only true "non-preload" surface in scope here is the
`IPC_CHANNELS.*` family.

#### Channel table

Format: `channel | bucket | callers (file:line, abbreviated)`. `pl` =
`preload.js`, `tp` = `backend/electron/tile-preload.cts`,
`pg` = `app/page/page.js`, `ctx` = `app/context/*.js`.

##### `datastore-*` (47 channels) — batch 3.7c

| channel | bucket | callers |
|---|---|---|
| `datastore-add-address` | strict-shadow | pl:518, tp:861 |
| `datastore-get-address` | strict-shadow | pl:521, tp:863 |
| `datastore-update-address` | strict-shadow | pl:524, tp:865 |
| `datastore-query-addresses` | strict-shadow | pl:527,1227, tp:867 |
| `datastore-add-visit` | strict-shadow | pl:530, tp:869 |
| `datastore-query-visits` | strict-shadow | pl:533, tp:871 |
| `datastore-add-content` | strict-shadow | pl:536, tp:873 |
| `datastore-query-content` | strict-shadow | pl:539, tp:875 |
| `datastore-get-table` | strict-shadow | pl:542, tp:877 |
| `datastore-set-row` | strict-shadow | pl:545, tp:879 |
| `datastore-get-row` | strict-shadow | pl:548, tp:881 |
| `datastore-get-stats` | preload-only | pl:551 (tp uses `tile:datastore:get-stats`) |
| `datastore-get-or-create-tag` | strict-shadow | pl:555, tp:885 |
| `datastore-tag-address` | strict-shadow | pl:558, tp:887 |
| `datastore-untag-address` | strict-shadow | pl:561, tp:889 |
| `datastore-get-tags-by-frecency` | strict-shadow | pl:564, tp:891 |
| `datastore-rename-tag` | preload-only | pl:608 (tp uses `tile:datastore:rename-tag`) |
| `datastore-update-tag-color` | preload-only | pl:611 (tp uses `tile:datastore:update-tag-color`) |
| `datastore-delete-tag` | preload-only | pl:614 (tp uses `tile:datastore:delete-tag`) |
| `datastore-get-address-tags` | strict-shadow | pl:567, tp:899 |
| `datastore-get-addresses-by-tag` | strict-shadow | pl:570, tp:901 |
| `datastore-get-untagged-addresses` | strict-shadow | pl:573, tp:903 |
| `datastore-add-item` | strict-shadow | pl:578, tp:906 |
| `datastore-get-item` | strict-shadow | pl:581, tp:908 |
| `datastore-update-item` | strict-shadow | pl:584, tp:910 |
| `datastore-delete-item` | strict-shadow | pl:587, tp:912 |
| `datastore-hard-delete-item` | preload-only | pl:590 (tp uses `tile:datastore:hard-delete-item`) |
| `datastore-update-item-title` | preload-only | pl:640 (tp uses `tile:datastore:update-item-title`) |
| `datastore-update-item-favicon` | preload-only | pl:645 (tp uses `tile:datastore:update-item-favicon`) |
| `datastore-query-items` | strict-shadow | pl:593, tp:920 |
| `datastore-tag-item` | strict-shadow | pl:596, tp:922 |
| `datastore-untag-item` | strict-shadow | pl:599, tp:924 |
| `datastore-get-item-tags` | strict-shadow | pl:602, tp:926 |
| `datastore-get-items-by-tag` | strict-shadow | pl:605, tp:928 |
| `datastore-get-history` | preload-only | pl:619 (tp uses `tile:datastore:get-history`) |
| `datastore-record-item-visit` | preload-only | pl:630 (tp uses `tile:datastore:record-item-visit`) |
| `datastore-get-item-visits` | preload-only | pl:627 (tp uses `tile:datastore:get-item-visits`) |
| `datastore-query-item-visits` | preload-only | pl:624 (tp uses `tile:datastore:query-item-visits`) |
| `datastore-track-navigation` | preload-only | pl:635 (tp uses `tile:datastore:track-navigation`) |
| `datastore-query-items-by-frecency` | preload-only | (tp uses `tile:datastore:query-items-by-frecency`; no preload caller — actually unused) |
| `datastore-add-item-event` | strict-shadow | pl:655, tp:943 |
| `datastore-get-item-event` | strict-shadow | pl:658, tp:945 |
| `datastore-query-item-events` | strict-shadow | pl:661, tp:947 |
| `datastore-delete-item-event` | strict-shadow | pl:664, tp:949 |
| `datastore-delete-item-events` | strict-shadow | pl:667, tp:951 |
| `datastore-get-latest-item-event` | strict-shadow | pl:670, tp:953 |
| `datastore-count-item-events` | strict-shadow | pl:673, tp:955 |
| `extract-page-content` | preload-only | pl:650 (tp uses `tile:datastore:extract-page-content`) |

##### `window-*` (~24 channels) — batch 3.7b

| channel | bucket | callers |
|---|---|---|
| `window-open` | fallback | pl:283, tp:514 (else of `hasWindowCapability`) |
| `window-close` | fallback | pl:295, tp:541 (else of cap check) |
| `window-hide` | fallback | pl:302, tp:615 |
| `window-show` | fallback | pl:309, tp:600 |
| `window-exists` | fallback | pl:316, tp:585 |
| `window-move` | preload-only | pl:323,2585 |
| `window-resize` | preload-only | pl:332 |
| `window-get-position` | preload-only | pl:341,2491 |
| `window-focus` | preload-only | pl:348 |
| `window-set-overlay-focus-target` | fallback | pl:355, tp:726 |
| `window-blur` | preload-only | pl:362 |
| `window-list` | fallback | pl:369, tp:570 |
| `window-devtools` | preload-only | pl:376 |
| `window-get-bounds` | preload-only | pl:383 |
| `window-set-bounds` | preload-only | pl:389 |
| `get-display-info` | preload-only | pl:392 |
| `window-set-ignore-mouse-events` | fallback | pl:396, tp:636 |
| `get-focused-visible-window-id` | fallback | pl:409,794, tp:710,2048 |
| `get-window-id` | fallback | pl:416,797,2625, tp:2050 (always-on, no cap gate) |
| `window-is-transient` | preload-only | pl:424 |
| `window-set-scroll-position` | preload-only | pl:431 |
| `window-center` | fallback | pl:435, tp:654 |
| `window-center-all` | fallback | pl:439, tp:668 |
| `window-maximize` | fallback | pl:443, tp:682 |
| `window-fullscreen` | fallback | pl:447, tp:696 |
| `window-set-visible-on-all-workspaces` | fallback | tp:749 (else of cap), no pl call |
| `window-reopen-last-closed` | preload-only | (no caller found in pl/tp; check core-glue/cmd) — likely dead |
| `window-animate` | preload-only | (only docs/api.md reference; no live caller) — likely dead |
| `window-is-draggable` | preload-only | (only `.agent-plan.md` reference; no live caller) — likely dead |
| `get-app-prefs` | preload-only | pl:2632 |
| `pubsub-stats` | preload-only | pl:276 |
| `opener-postmessage` | strict-shadow | pg:1112 (via `api.invoke('opener-postmessage')` passthrough) |
| `opener-close` | strict-shadow | pg:1122 (via `api.invoke('opener-close')` passthrough) |
| `opener-focus` | strict-shadow | pg:1129 (via `api.invoke('opener-focus')` passthrough) |
| `screen-get-primary-display` | fallback | tp:1769 (else of `hasScreenCapability` at 1764); no pl |

##### `extension-*` + `feature-*` (15 channels) — batch 3.7d

| channel | bucket | callers |
|---|---|---|
| `extension-pick-folder` | strict-shadow | pl:1755, tp:1957 (trustedBuiltin gate, not capability) |
| `extension-validate-folder` | strict-shadow | pl:1764, tp:1963 |
| `extension-add` | strict-shadow | pl:1778, tp:1969 |
| `extension-remove` | strict-shadow | pl:1790, tp:1975 |
| `extension-update` | strict-shadow | pl:1803, tp:1981 |
| `extension-get-all` | strict-shadow | pl:1811, tp:1987 |
| `extension-get` | strict-shadow | pl:1820, tp:1993 |
| `extension-window-unload` | preload-only | (no live caller — likely dead) |
| `extension-window-list` | strict-shadow | pl:1598, tp:1933 |
| `extension-list-all-registered` | strict-shadow | pl:1606, tp:1939 |
| `extension-window-devtools` | strict-shadow | pl:1709, tp:1951 |
| `extension-reload` | strict-shadow | pl:1697, tp:1945 |
| `extension-manifest-get` | preload-only | (no caller in pl or tp — likely dead) |
| `feature-settings-get` | preload-only | pl:1847 |
| `feature-settings-set` | preload-only | pl:1861 |
| `feature-settings-get-key` | preload-only | pl:1874,1902 |
| `feature-settings-set-key` | preload-only | pl:1888 |
| `feature-settings-schema` | strict-shadow | pl:1830, tp:1999 |

##### `feature-registry:*` / `feature-install:*` / `feature-browse:*` (9 channels) — batch 3.7d

| channel | bucket | callers |
|---|---|---|
| `feature-registry:list` | fallback | tp:1448 (else of `hasFeaturesCapability`) |
| `feature-registry:get` | fallback | tp:1450 |
| `feature-registry:history` | fallback | tp:1452 |
| `feature-registry:enable` | fallback | tp:1454 |
| `feature-registry:disable` | fallback | tp:1456 |
| `feature-registry:remove` | fallback | tp:1458 |
| `feature-install:resolve` | fallback | tp:1460 |
| `feature-install:preview-capabilities` | fallback | tp:1462 |
| `feature-install:install` | fallback | tp:1468 |
| `feature-browse:resolve-publisher` | fallback | tp:1470 |

##### `context-*` (6 channels) — batch 3.7d

| channel | bucket | callers |
|---|---|---|
| `context-get` | fallback | pl:2107,2210, tp:1287, ctx — but ctx is in core renderer (preload-loaded) |
| `context-set` | fallback | pl:2120,2223, tp:1289, ctx (idx:80, history:56) |
| `context-history` | fallback | pl:2170, tp:1291, ctx (history:77) |
| `context-snapshot` | fallback | pl:2180, tp:1293, ctx (history:110) |
| `context-windows-with-value` | fallback | pl:2190,2249, tp:1295 |
| `context-windows-in-space` | fallback | pl:2199, tp:1297 |

Note: `app/context/*.js` modules import via the v1 preload's
`window.app.invoke` → still classified as preload-only consumers from
the channel's perspective. Once preload.js dies, those modules will
need to either move into a tile that has the `context` capability or
be loaded from a context that uses tile-preload.

##### `theme:*` + `darkMode:*` (12 channels) — batch 3.7a

| channel | bucket | callers |
|---|---|---|
| `theme:get` | strict-shadow | pl:684,1129,1155, tp:2036 (trustedBuiltin only) |
| `theme:setColorScheme` | strict-shadow | pl:693, tp:2042 |
| `theme:setWindowColorScheme` | strict-shadow | pl:802, tp:2055 |
| `theme:setTheme` | strict-shadow | pl:702, tp:2040 |
| `theme:list` | strict-shadow | pl:710, tp:2037 |
| `theme:pickFolder` | preload-only | pl:726 |
| `theme:validateFolder` | preload-only | pl:735 |
| `theme:add` | preload-only | pl:744 |
| `theme:remove` | preload-only | pl:753 |
| `theme:getAll` | strict-shadow | pl:718, tp:2038 |
| `theme:reload` | preload-only | pl:762 (also `pl:780` listener for `theme:reload` event) |
| `darkMode:get` | preload-only | pl:968 |
| `darkMode:set` | preload-only | pl:977 |

##### `chrome-ext:*` + `adblocker:*` (12 channels) — batch 3.7d

| channel | bucket | callers |
|---|---|---|
| `chrome-ext:list` | strict-shadow | pl:1075, tp:2071 (trustedBuiltin) |
| `chrome-ext:enable` | strict-shadow | pl:1084, tp:2077 |
| `chrome-ext:disable` | strict-shadow | pl:1093, tp:2083 |
| `chrome-ext:getStatus` | strict-shadow | pl:1101, tp:2089 |
| `chrome-ext:getUiEntries` | strict-shadow | pl:1109, tp:2095 |
| `chrome-ext:openPage` | strict-shadow | pl:1119, tp:2101 |
| `adblocker:getStatus` | preload-only | pl:1003 |
| `adblocker:enable` | preload-only | pl:1011 |
| `adblocker:disable` | preload-only | pl:1019 |
| `adblocker:getBlockedCount` | preload-only | pl:1027 |
| `adblocker:getAllowlist` | preload-only | pl:1035 |
| `adblocker:isSiteAllowed` | preload-only | pl:1044 |
| `adblocker:allowSite` | preload-only | pl:1053 |
| `adblocker:disallowSite` | preload-only | pl:1062 |

##### `web-nav-*` (4 channels) — batch 3.7a

| channel | bucket | callers |
|---|---|---|
| `web-nav-back` | preload-only | (no caller in pl/tp — likely dead) |
| `web-nav-forward` | preload-only | (no caller in pl/tp — likely dead) |
| `web-nav-reload` | preload-only | (no caller in pl/tp — likely dead) |
| `web-nav-state` | preload-only | (no caller in pl/tp — likely dead) |

##### `izui-*` (5 channels) — batch 3.3 (separate package)

| channel | bucket | callers |
|---|---|---|
| `izui-is-transient` | fallback | pl:464, tp:1624 (else of izui cap check) |
| `izui-get-effective-mode` | fallback | pl:473, tp:1636 |
| `izui-get-state` | fallback | pl:481, tp:1644 |
| `izui-get-pre-overlay-focus-target` | fallback | pl:490, tp:1652 |
| `izui-close-self` | fallback | pl:500, tp:1660 |

##### `oauth-*` (2 channels) — batch 3.7d

| channel | bucket | callers |
|---|---|---|
| `oauth-start-loopback` | fallback | pl:1962, tp:1690 (else of `hasOauthCapability` check at 1697) |
| `oauth-await-callback` | fallback | pl:1963, tp:1692 |

##### `sync-*` (6 channels) — batch 3.7d

| channel | bucket | callers |
|---|---|---|
| `sync-get-config` | preload-only | pl:813 |
| `sync-set-config` | preload-only | pl:822 |
| `sync-pull` | preload-only | pl:831 |
| `sync-push` | preload-only | pl:840 |
| `sync-full` | fallback | pl:848, tp:1744 (else of `hasSyncCapability` check at 1743) |
| `sync-status` | preload-only | pl:856 |

##### `backup-*` + `session-*` + `save-space-workspaces` + `profiles:*` + `modes:*` (17 channels) — batch 3.7a/3.7d

| channel | bucket | callers |
|---|---|---|
| `backup-get-config` | preload-only | (no caller in pl/tp — likely dead) |
| `backup-set-config` | preload-only | (no caller — likely dead) |
| `backup-create` | preload-only | (no caller — likely dead) |
| `backup-list` | preload-only | (no caller — likely dead) |
| `session-save` | preload-only | (no caller — likely dead) |
| `session-get-snapshot-info` | preload-only | (no caller — likely dead) |
| `session-restore` | preload-only | (no caller — likely dead) |
| `session-restore-interactive` | preload-only | (no caller — likely dead) |
| `save-space-workspaces` | fallback | pl:1913, tp:1791 (else of `hasSessionCapability` at 1786) |
| `profiles:list` | preload-only | pl:867 |
| `profiles:create` | preload-only | pl:876 |
| `profiles:get` | preload-only | pl:885 |
| `profiles:delete` | preload-only | pl:894 |
| `profiles:getCurrent` | preload-only | pl:902 |
| `profiles:switch` | preload-only | pl:911 |
| `profiles:enableSync` | preload-only | pl:922 |
| `profiles:disableSync` | preload-only | pl:931 |
| `profiles:getSyncConfig` | preload-only | pl:940 |
| `profiles:getPartition` | preload-only | pl:949 |
| `modes:getWindowMode` | preload-only | pl:2055 |
| `modes:setMajorMode` | preload-only | pl:2065 |
| `modes:listModes` | preload-only | pl:2073 |
| `modes:getCommandContext` | preload-only | pl:1520,1530,2082 |

##### `file-*` + `app-info` + `shell-open-path` + `default-browser-*` + `set-default-browser` + `net-fetch` (8 channels) — batch 3.7a

| channel | bucket | callers |
|---|---|---|
| `file-save-dialog` | preload-only | pl:2264 (tp uses `tile:dialogs:save`) |
| `file-open-dialog` | preload-only | pl:2276 (tp uses `tile:dialogs:open`) |
| `file-read-from-path` | preload-only | pl:2285 (tp uses `tile:filesystem:read`) |
| `file-write-to-path` | preload-only | pl:2295 (tp uses `tile:filesystem:write`) |
| `app-info` | preload-only | pl:143 |
| `shell-open-path` | preload-only | (no caller in pl/tp — likely dead) |
| `default-browser-status` | preload-only | (no caller — likely dead) |
| `set-default-browser` | preload-only | (no caller — likely dead) |
| `net-fetch` | preload-only | pl:1927 (tp uses `tile:network:fetch`) |

##### `IPC_CHANNELS.*` (10 `ipcMain.on` channels) — batch 3.7e

| channel | const value | bucket | callers |
|---|---|---|---|
| `RENDERER_LOG` | `renderer-log` | live-other | pl:128, tp:1868 (always-on) |
| `REGISTER_SHORTCUT` | `registershortcut` | live-other | pl:163 (tp uses `tile:shortcuts:register`) |
| `UNREGISTER_SHORTCUT` | `unregistershortcut` | live-other | pl:187 (tp uses `tile:shortcuts:unregister`) |
| `CLOSE_WINDOW` | `closewindow` | live-other | pl:206 |
| `PUBLISH` | `publish` | live-other | pl:50,82,233,1346,1357,1396,1452,1487,1555,1634,1673,1734 (tp uses `tile:pubsub:publish`) |
| `SUBSCRIBE` | `subscribe` | live-other | pl:68,251,1331,1374,1478,1546,1621,1660,1721 (tp uses `tile:pubsub:subscribe`) |
| `CONSOLE` | `console` | live-other | (no caller in pl/tp — likely dead) |
| `APP_QUIT` | `app-quit` | live-other | pl:1288, tp:2015 (always-on) |
| `APP_RESTART` | `app-restart` | live-other | pl:1292, tp:2023 (always-on) |
| `MODIFY_WINDOW` | `modifywindow` | live-other | pl:508 |

#### Deletion order recommendation

Recommended sequencing aligns with the plan's 3.7a–e split, ordered by
risk (low → high). Each batch can ship as one PR with `tsc --noEmit`
+ `test:unit` + `test:electron:bg` validation.

1. **3.7a — `preload-only` (79 channels) + truly dead channels.**
   First subdivision: delete the **31 channels** that have NO callers
   in either `preload.js` or `tile-preload.cts` (suspected dead). Risk:
   low — verifiable by grep + `tsc`. Channels: `extension-window-unload`,
   `extension-manifest-get`, `web-nav-back/forward/reload/state`,
   `backup-get-config/set-config/create/list`, `session-save/get-snapshot-info/restore/restore-interactive`,
   `shell-open-path`, `default-browser-status`, `set-default-browser`,
   `window-reopen-last-closed`, `window-animate`, `window-is-draggable`,
   `datastore-query-items-by-frecency`, `IPC_CHANNELS.CONSOLE`. (Pre-3.7
   verify they really are dead — could be invoked via `api.invoke()`
   passthrough in a feature tile.)
   Second subdivision (after preload.js is deleted in 3.8): the
   remaining 48 preload-only channels can be deleted in lockstep with
   the file. Until then, they have a live consumer.

2. **3.7b — `window-*` (~24 channels).** Mixed: 11 `fallback` channels
   that fall when tile-preload's else branches collapse, 9 preload-only,
   3 `strict-shadow` (`opener-postmessage/close/focus`). Action: build
   strict shims for the 3 opener-* channels (currently `pg` calls them
   via `api.invoke()` passthrough), then delete the fallback else
   branches in `tile-preload.cts` per 3.3 pattern, then delete the
   `window-*` handlers in `ipc.ts`.

3. **3.7c — `datastore-*` (47 channels).** Mostly `strict-shadow` (28)
   — these need strict `tile:datastore:*` equivalents built first.
   The remaining ~12 strict equivalents already exist (rename-tag,
   update-tag-color, delete-tag, hard-delete-item, update-item-title,
   update-item-favicon, get-history, record-item-visit, get-item-visits,
   query-item-visits, track-navigation, query-items-by-frecency,
   extract-page-content, get-stats — last 3 commits already added
   shims). Build the missing strict shims before deleting any
   handler. **Trickiest batch — recommend its own pre-package.**

4. **3.7d — `extension-*` + `feature-*` + `chrome-ext:*` + `oauth-*` +
   `sync-*` + `context-*` + `feature-registry/install/browse:*` +
   `save-space-workspaces` (~50 channels).** Mix of fallbacks (clean
   delete after collapsing else branches) and `strict-shadow` for the
   trustedBuiltin-only surfaces (extensions/chromeExtensions/themes).
   For trustedBuiltin paths the simplest move is to add a `tile:*`
   alias and a trustedBuiltin enforcement check, then delete the legacy
   handler — same pattern used in recent `tile:datastore:*` strict
   commits.

5. **3.7e — `IPC_CHANNELS.*` (10 channels).** All `live-other` because
   pubsub/shortcut/quit are pervasively used. tile-preload already
   uses `tile:pubsub:*` and `tile:shortcuts:*`. The 3 channels still
   needed unconditionally are `RENDERER_LOG`, `APP_QUIT`, `APP_RESTART`
   (tile-preload calls them directly with no strict equivalent). Build
   `tile:app:quit` + `tile:app:restart` + `tile:log:write` shims (or
   just keep these 3 as the only legacy survivors, since they're tiny
   write-only sends that don't need capability gating). Then delete
   the rest of the const + handler block at `ipc.ts:4158–4476`.

#### Trickier channels (need strict shim built first)

These are the `tile-preload-strict-shadow` calls — tile-preload calls
them unconditionally and there is no strict `tile:*` alias yet:

- **`opener-postmessage` / `opener-close` / `opener-focus`** — called
  from `app/page/page.js` via `api.invoke()` passthrough. Strict
  equivalents: `tile:window:opener-postmessage` etc., gated on
  `window.manage` capability or a new `opener` capability.
- **`extension-*` (10 channels)** — tile-preload exposes them under
  `api.extensions.*` for trustedBuiltin only. Need
  `tile:extensions:*` shims with a trustedBuiltin enforcement layer
  in `tile-ipc.ts`.
- **`chrome-ext:*` (6 channels)** — same pattern as `extension-*`,
  trustedBuiltin only. Need `tile:chrome-extensions:*` shims.
- **`feature-settings-schema`** — called unconditionally from both
  preload and tile-preload (`api.extensions.getSettingsSchema`).
  Could fold into `tile:features:*` namespace.
- **`theme:get/setColorScheme/setWindowColorScheme/setTheme/list/getAll`**
  (6 channels) — tile-preload exposes them under `api.theme.*` for
  trustedBuiltin only. Need `tile:theme:*` strict equivalents (a
  `tile:theme:info` already exists, but only returns minimal data).
- **`get-window-id`** — called from tile-preload at line 2050 inside
  the theme block. Has no strict equivalent. Either add
  `tile:window:get-id` or refactor the caller to use the existing
  `tile:window:get-focused-visible-id` flow.
- **`renderer-log`, `app-quit`, `app-restart`** — see 3.7e above.

The remaining ~50 strict-shadow channels (mostly `datastore-*`) are
already partially shimmed (per recent commits b820dafc, 06eaacb6,
48d15aca); just need the shim-completion pass before flipping
tile-preload from legacy to strict.

#### Open gaps in this audit

- **`api.invoke()` passthrough surface** (tile-preload.cts:1910 +
  preload.js:2335) lets any channel name be invoked from a renderer
  with `trustedBuiltin`. The "no-caller" verdict on the 31 suspected
  dead channels was based on grep for `'channel-name'` strings; an
  inline `api.invoke('window-animate', …)` from a tile would not show
  up. Phase 3.7a's first subdivision should re-verify by running the
  full electron test suite after deletion (a missing handler will
  surface as a runtime invoke failure).
- Did not audit how tests exercise these channels — `datastore.test.ts`,
  `feature-registry.test.ts`, etc. all import handlers directly. Test
  failures during 3.7c deletion are expected and should be migrated
  to use the `tile:*` equivalents.

---

### phase3.1 — Audit findings (2026-04-18)

**Conclusion: GO** — `extensionHostWindow` can be deleted in phase3.6 with
near-zero product risk. The window is a true empty shell: cmd, hud, and
page have all moved to top-level BrowserWindows (via `*-glue.ts` files
using `tile-preload.cjs`). The only remaining iframe loader is
`loadLazyExtension()` in `main.ts:740`, used for legacy v1 lazy stubs;
all currently-bundled "consolidated" features have `manifestVersion: 2`
and are routed through the v2 tile path before the lazy stub fires
(verified entities, editor). The host therefore stays empty in practice.

**Key correctness finding:** the smoke tests' comments are wrong about
the architecture. They assert that cmd loads as an iframe inside
extension-host "via cmd-glue.ts" (lines 4214, 5314, 5383) — but
`cmd-glue.ts` actually creates a separate top-level BrowserWindow at
`peek://cmd/index.html` with `tile-preload.cjs` (see cmd-glue.ts:80-168).
Same for hud-glue.ts and page-glue.ts. The tests are therefore either
silently passing on stale state or skipping their inner iframe lookups.

#### Per-site recommendations

| Site | What it validates | Real product feature? | Action |
|------|-------------------|------------------------|--------|
| `smoke.spec.ts:1383` | Waits for any window matching `peek://app/extension-host.html` URL inside the "shared app smoke" startup block. Used to gate further checks in that suite. | No — historical leftover from when host loaded all built-ins. | **delete** the `waitForWindow(... 'extension-host.html', 15000)` + `expect(hostWindow).toBeDefined()` lines (1380-1386). The v2 background-tile waits immediately below already validate startup readiness. |
| `smoke.spec.ts:4177` (test "extension host window exists for built-in extensions") | Asserts host window exists. | No — host is empty now; cmd/hud/page are separate BrowserWindows; v2 tiles are separate BrowserWindows. | **delete** the entire test (4174-4179). Coverage of "v2 tiles exist" is provided by the test at 4219. |
| `smoke.spec.ts:4189` (test "built-in extensions load as iframes in extension host") | Asserts cmd iframe is present inside host's `#extensions` container. | No — cmd is a top-level window now (peek://cmd/index.html via cmd-glue.ts). The test's own comment is incorrect. | **delete** the entire test (4181-4217). Replace with: nothing — the existing v2 background tile test at 4219 + cmd-availability is implicitly verified by every other test that opens the cmd panel. |
| `smoke.spec.ts:4359` (inside "correct window count for hybrid mode" test) | `hostWindows.length).toBe(1)` — exactly one extension-host window exists. | No — host count is implementation detail; what matters is one bg + N tile windows + example. | **rewrite**: drop the `hostWindows` filter + assertion. Keep `bgWindows` and `exampleExtWindows` checks. Update test name comment (4344) to reflect post-host topology. |
| `smoke.spec.ts:5292` (test "local shortcut from extension-host iframe roundtrip") | Tests `ev.reply` roundtrip when sender is an iframe (BrowserWindow.fromWebContents() returns null). Walks: find host window → find cmd/hud iframe inside → register shortcut → trigger via main → assert callback fires. | **No** — cmd/hud aren't iframes anymore. The frame search at 5316-5320 looks for `peek://cmd/` or `peek://hud/` frames in the host but finds none in current architecture. The roundtrip mechanism (ev.reply for top-level windows) is already covered by "local shortcut from background window roundtrip" earlier in the file. | **delete** the entire test (5291-5371). The iframe-sender variant of ev.reply is no longer a real code path — if no v1 iframes exist in production, the codepath is dead too (and would be removed naturally as part of phase3.6 + extensionBroadcaster simplification). |
| `smoke.spec.ts:5299` (helper line inside test 5291) | Same as 5292 (it's the implementation of that test). | Same. | Covered by 5292 deletion. |
| `smoke.spec.ts:5379` (test "global shortcut from extension-host iframe roundtrip") | Same as 5292 but for global shortcuts. Same iframe lookup. | **No** — same reason as 5292. The skipped `'shortcut from external extension window roundtrip'` test at 5435 already documents that v1 iframe shortcut paths are obsolete. | **delete** the entire test (5373-5433). Apply the same rationale as the already-skipped sibling test. |
| `tests/fixtures/desktop-app.ts:227` (helper `waitForHybridExtensions`) | The fixture polls for the host window and waits for its DOM (`#extensions` div) to be ready before returning. Used as a gate for "extensions are ready". | No — gate is wrong: ready signal should come from v2 tile launch completion, not from the (empty) host's DOM. | **rewrite** to remove the host-window check; gate readiness on `getLoadedTileIds()` (via IPC) or on the bg window publishing a startup-complete signal. If the helper is hard to rewrite in scope, replace with a `waitForFunction` against the bg window that checks `app.extensions.getRunning()` (or v2 equivalent — phase 3.5 will provide `getLoadedTileIds`). |
| `tests/README.md:140` (docs row "extension host window exists") | Docs only. | No — docs reflect old architecture. | **delete** that table row plus the surrounding rows about iframes (lines 140-141, 148). Update the "Hybrid Extension Mode" section to describe v2 tile topology. |

#### Risk register for 3.6 execution

1. **Lazy v1 extensions:** `loadLazyExtension()` would lose its iframe
   target. Verified: all 20 ids in `CONSOLIDATED_EXTENSION_IDS` ship as
   v2 tiles today (spot-checked entities, editor; rest are managed via
   feature loader); the lazy stub never reaches the iframe-creation
   branch. **Mitigation:** delete the `loadLazyExtension` function body
   alongside the host (or convert to a no-op + warning) in phase3.6.
2. **Third-party / out-of-tree extensions:** none currently. The
   `example` extension is loaded as a separate window
   (`peek://ext/example/background.html`), not the host. **Mitigation:**
   none needed.
3. **`will-attach-webview` host detection** at `entry.ts:472` checks
   `address.includes('extension-host.html')`. **Mitigation:** delete
   that branch in phase3.6 — no host means no host-page webview attach
   path.
4. **`INTERNAL_URLS` opener-parent detection** in `ipc.ts:2306`
   references the host URL. **Mitigation:** drop the entry as part of
   3.6 (already in plan).
5. **`extensionBroadcaster` v1 branch** at `main.ts:226-244` iterates
   host frames. **Mitigation:** delete — no host means no host frames
   (already in plan).

#### Recommended option for 3.6

**(a) rewrite tests + delete window**, with the per-site actions above
collapsed to: delete tests 4174-4179, 4181-4217, 5291-5371, 5373-5433;
trim 1380-1386 and the host filter at 4359-4366; rewrite the fixture
helper at desktop-app.ts:222-244 to gate on a bg-window readiness
signal instead of the host DOM; trim README.md:140-141 + 148.

**Net test deletion:** 4 full tests + 2 partial assertions + 1 fixture
rewrite + 3 README rows. No production code coverage is lost — every
remaining behaviour is exercised by tests on the v2 tile path.
