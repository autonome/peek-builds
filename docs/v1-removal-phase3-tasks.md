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
   `apps/desktop/main/ipc.ts`, `apps/desktop/main/index.ts`,
   `apps/desktop/main/config.ts`. Delete after no callers remain.
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
- `/Users/dietrich/misc/mpeek/apps/desktop/main/main.ts` (lines 73-77,
  247-258, 1335-1343, 1393-1397, 1418-1442, 1447-1450)
- `/Users/dietrich/misc/mpeek/apps/desktop/main/index.ts:149-151`
- `/Users/dietrich/misc/mpeek/apps/desktop/main/ipc.ts:97-98, 1199,
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
- `/Users/dietrich/misc/mpeek/apps/desktop/main/tile-preload.cts` (lines
  1624, 1636, 1644, 1652, 1660)
- `/Users/dietrich/misc/mpeek/apps/desktop/main/ipc.ts` (`izui-*` handler
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
- `/Users/dietrich/misc/mpeek/apps/desktop/main/tile-preload.cts`
- `/Users/dietrich/misc/mpeek/chrome-extensions/**` (content scripts)
- `/Users/dietrich/misc/mpeek/apps/tauri-desktop/preload.js` (reference,
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
- `/Users/dietrich/misc/mpeek/apps/desktop/main/main.ts` (lines 89, 97,
  1214, 1225, 1237, 1313-1373, 1380-1413, 1462-1464)
- `/Users/dietrich/misc/mpeek/apps/desktop/main/ipc.ts:100, 1300, 1310,
  1323` (`isConsolidatedExtension` callsite + handlers)
- `/Users/dietrich/misc/mpeek/apps/desktop/main/index.ts` (if exported)

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
- `/Users/dietrich/misc/mpeek/apps/desktop/main/main.ts` (lines 80, 226-
  244, 767-771, 1103-1176, 1208, 1321, 1386, 1455-1457)
- `/Users/dietrich/misc/mpeek/apps/desktop/main/ipc.ts:2306`
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
`apps/desktop/main/ipc.ts:121`, `apps/desktop/main/index.ts:13`,
`apps/desktop/main/config.ts:14` imports. Delete the
`IPC_CHANNELS.SUBSCRIBE/PUBLISH/CLOSE_WINDOW/REGISTER_SHORTCUT/
UNREGISTER_SHORTCUT/MODIFY_WINDOW/CONSOLE/RENDERER_LOG/APP_QUIT/
APP_RESTART` handler blocks at `ipc.ts:4158-4476`.

**Files:**
- `/Users/dietrich/misc/mpeek/apps/desktop/main/ipc.ts` (many lines —
  see phase3.4 output)
- `/Users/dietrich/misc/mpeek/apps/desktop/main/tile-preload.cts` (the
  ~70 `ipcRenderer.invoke('legacy-*')` sites in bucket (b))
- `/Users/dietrich/misc/mpeek/apps/desktop/main/config.ts:16-27`
- `/Users/dietrich/misc/mpeek/apps/desktop/main/config.ts:14`
- `/Users/dietrich/misc/mpeek/apps/desktop/main/index.ts:13`

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
`apps/desktop/main/config.ts`, `entry.ts`, `index.ts`, and the window-open
fallback at `ipc.ts:2268,2670`. Update `will-attach-webview` in
`entry.ts:189-211` to drop the v1 fallback branch — all peek:// webview
children get `tile-preload.cjs` unconditionally (or throw if not a v2
tile).

**Files:**
- `/Users/dietrich/misc/mpeek/preload.js` — delete (2693 LOC)
- `/Users/dietrich/misc/mpeek/apps/desktop/main/entry.ts` (lines 63, 152,
  157, 189-211)
- `/Users/dietrich/misc/mpeek/apps/desktop/main/config.ts` (preload path
  getters/setters)
- `/Users/dietrich/misc/mpeek/apps/desktop/main/index.ts` (exports)
- `/Users/dietrich/misc/mpeek/apps/desktop/main/ipc.ts` (lines 119,
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

- Tauri-side preload migration (`apps/tauri-desktop/preload.js`,
  `apps/mobile/.../include_str!`). Per Phase 2.5 #5 — copy to a
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
in `apps/desktop/main/ipc.ts`, then grepped every call site across
`preload.js`, `apps/desktop/main/tile-preload.cts`, `app/**`,
`chrome-extensions/**`, and `apps/desktop/main/**` (excluding test files
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
`preload.js`, `tp` = `apps/desktop/main/tile-preload.cts`,
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

---

### Wave 2 — re-planned (2026-04-18 after 3.4 audit)

The 3.4 audit revealed 193 channels (vs. 103 estimated), with **71
strict-shadow channels** that need `tile:*` equivalents BEFORE the
legacy handler can be deleted, plus a hidden dependency: `app/context/
*.js` calls `context-*` directly via the v1 preload, blocking
`preload.js` deletion until those modules migrate.

This re-plan replaces the original 3.5–3.8 packages with smaller,
strictly-sized (15–25 min) work items. Every package is shippable by a
Sonnet agent in one spawn.

#### Re-planned dependency graph

```
Wave 2a — strict shim builders (parallel, no inter-deps)
    3.5a  opener-* shims              (3 ch)
    3.5b  theme:* shims               (6 ch)
    3.5c  extension-* shims           (10 ch)
    3.5d  chrome-ext:* shims          (6 ch)
    3.5e  feature-settings-schema +
          get-window-id shims         (2 ch)
    3.5f  app-control shims
          (renderer-log, app-quit,
           app-restart)               (3 ch)
    3.5g  datastore-* shim completion
          (28 ch verify + fill)
        |
        +-- (each above unblocks one tile-preload route flip)

Wave 2b — flip tile-preload to strict (after matching 2a shim)
    3.6a  flip opener-*               (after 3.5a)
    3.6b  flip theme:*                (after 3.5b)
    3.6c  flip extension-*            (after 3.5c)
    3.6d  flip chrome-ext:*           (after 3.5d)
    3.6e  flip feature-settings-schema
          + get-window-id             (after 3.5e)
    3.6f  flip renderer-log/quit/
          restart                     (after 3.5f)
    3.6g  flip datastore-* (28 ch)    (after 3.5g)

Wave 2c — collapse fallback else-branches (after corresponding flip)
    3.7a  collapse window-* fallbacks (11 ch, no deps)
    3.7b  collapse feature-registry/
          install/browse fallbacks    (10 ch, after 3.6e)
    3.7c  collapse context-* fallbacks
          (6 ch, after Wave 2d-context)
    3.7d  collapse oauth + sync-full
          + screen + save-space-ws +
          window-set-visible-on-all-
          workspaces                  (5 ch)

Wave 2d — context module migration (gates 3.7c + preload.js delete)
    3.8a  audit app/context/*.js call
          surface
    3.8b  port context modules to use
          tile-preload api.context.*
          (or wrap as a tile)

Wave 2e — getRunning/getAllRegistered rewrite (was 3.5)
    3.9   rewrite for v2 tiles        (after 3.1 → already GO)

Wave 2f — extensionHostWindow delete (was 3.6)
    3.10  delete host window + iframe
          loader + INTERNAL_URLS +
          smoke tests + fixture
                                      (after 3.9)

Wave 2g — preload.js + IPC_CHANNELS deletion (was 3.7e/3.8)
    3.11a delete suspected-dead
          channels (~31 ch, no
          callers grep'd)
    3.11b delete remaining preload-
          only handlers (~48 ch) +
          delete preload.js file
                                      (after Wave 2b + 2c + 2d + 2f)
    3.11c delete IPC_CHANNELS const +
          remaining .on handlers
                                      (after 3.11b)
```

#### Parallelism summary

- **Wave 2a (3.5a–g):** all 7 packages independent. Run in parallel
  with isolated workspaces.
- **Wave 2b (3.6a–g):** each gated on its 2a sibling. Within 2b the
  flips are independent (different domains in tile-preload.cts).
- **Wave 2c (3.7a–d):** mostly independent of each other; 3.7b waits
  on 3.6e, 3.7c waits on Wave 2d.
- **Wave 2d (3.8a–b):** sequential (audit → port).
- **Wave 2e (3.9):** independent of everything in Wave 2 — can run
  alongside any other wave. Already cleared by 3.1 audit.
- **Wave 2f (3.10):** depends on 3.9.
- **Wave 2g (3.11):** the final lockstep deletion. 3.11a can run
  earlier as a low-risk isolated package.

---

#### 3.5a — Build `tile:window:opener-*` strict shims

**Scope:** Add `tile:window:opener-postmessage`, `tile:window:opener-
close`, `tile:window:opener-focus` handlers in `tile-ipc.ts`. Mirror
existing `opener-*` semantics from `ipc.ts`. Gate on `window.manage`
capability (or new `opener` cap if more appropriate — pick the simpler
one).

**Files:** `apps/desktop/main/tile-ipc.ts`, `apps/desktop/main/tile-
preload.cts` (add wrapper methods only — DO NOT remove legacy invoke
yet; that's 3.6a).

**Dependencies:** none

**Budget:** 20 min

**Validation:** `yarn tsc --noEmit`, `yarn test:unit`,
`yarn test:electron:bg -g "page"` (page widget exercises opener-*).

**Risk:** low — additive only.

---

#### 3.5b — Build `tile:theme:*` strict shims (6 channels)

**Scope:** Add `tile:theme:get`, `tile:theme:setColorScheme`,
`tile:theme:setWindowColorScheme`, `tile:theme:setTheme`,
`tile:theme:list`, `tile:theme:getAll` handlers in `tile-ipc.ts`. All
require trustedBuiltin enforcement (theme handlers should refuse
non-trusted callers — pattern from existing `tile:datastore:*`
trustedBuiltin sites in recent commits).

**Files:** `apps/desktop/main/tile-ipc.ts`, `apps/desktop/main/tile-
preload.cts` (add wrappers, additive).

**Dependencies:** none

**Budget:** 20 min

**Validation:** `yarn tsc --noEmit`, `yarn test:unit`,
`yarn test:electron:bg -g "theme"`.

**Risk:** low — additive; trustedBuiltin gating is well-tested.

---

#### 3.5c — Build `tile:extensions:*` strict shims (10 channels)

**Scope:** Add `tile:extensions:pickFolder`, `validateFolder`, `add`,
`remove`, `update`, `getAll`, `get`, `windowList`,
`listAllRegistered`, `windowDevtools`, `reload` (10 total).
TrustedBuiltin enforcement.

**Files:** `apps/desktop/main/tile-ipc.ts`, `apps/desktop/main/tile-
preload.cts` (add wrappers).

**Dependencies:** none

**Budget:** 25 min (10 channels — split if it overruns 25)

**Validation:** `yarn tsc --noEmit`, `yarn test:unit`,
`yarn test:electron:bg -g "extension"` (or features pane).

**Risk:** low — additive.

---

#### 3.5d — Build `tile:chrome-extensions:*` strict shims (6 channels)

**Scope:** Add `tile:chrome-extensions:list`, `enable`, `disable`,
`getStatus`, `getUiEntries`, `openPage`. TrustedBuiltin enforcement.

**Files:** `apps/desktop/main/tile-ipc.ts`, `apps/desktop/main/tile-
preload.cts`.

**Dependencies:** none

**Budget:** 20 min

**Validation:** `yarn tsc --noEmit`, `yarn test:unit`,
`yarn test:electron:bg -g "chrome-ext"`.

**Risk:** low — additive.

---

#### 3.5e — Build `tile:features:settings-schema` + `tile:window:get-id` shims

**Scope:** Two unrelated small shims grouped because each is too small
for its own package. Add `tile:features:settings-schema` (mirror of
`feature-settings-schema`) and `tile:window:get-id` (mirror of
`get-window-id`). Both used unconditionally in tile-preload.

**Files:** `apps/desktop/main/tile-ipc.ts`, `apps/desktop/main/tile-
preload.cts`.

**Dependencies:** none

**Budget:** 15 min

**Validation:** `yarn tsc --noEmit`, `yarn test:unit`,
`yarn test:electron:bg`.

**Risk:** low — additive.

---

#### 3.5f — Build `tile:app:*` shims (renderer-log, quit, restart)

**Scope:** Add `tile:log:write` (= renderer-log), `tile:app:quit`,
`tile:app:restart` shims. These are write-only sends (no return). May
opt to keep the legacy `ipcMain.on` handlers permanently as the only
survivors instead — decide based on capability story (per 3.7e
recommendation in audit).

**Files:** `apps/desktop/main/tile-ipc.ts`, `apps/desktop/main/tile-
preload.cts`.

**Dependencies:** none

**Budget:** 15 min

**Validation:** `yarn tsc --noEmit`, `yarn test:unit`,
`yarn test:electron:bg -g "smoke"`.

**Risk:** low — additive.

---

#### 3.5g — Datastore strict-shim completion sweep (28 channels)

**Scope:** Verify every `datastore-*` strict-shadow channel listed in
the 3.4 audit table has a working `tile:datastore:*` equivalent. The
last 3 commits (b820dafc, 06eaacb6, 48d15aca) added many; this package
is the "fill the gaps" pass. For each missing, add a strict shim with
permissive datastore-capability gating (existing pattern).

**Files:** `apps/desktop/main/tile-ipc.ts`, `apps/desktop/main/tile-
preload.cts`. Reference: 3.4 audit table for the 28 strict-shadow
datastore channels.

**Dependencies:** none

**Budget:** 25 min (split into 3.5g1/g2 by channel count if over)

**Validation:** `yarn tsc --noEmit`, `yarn test:unit`,
`yarn test:electron:bg -g "datastore"`.

**Risk:** low–medium — additive but high channel count = high test
surface.

---

#### 3.6a — Flip tile-preload `opener-*` to strict + delete legacy handlers

**Scope:** Replace the 3 `ipcRenderer.invoke('opener-*', …)` calls in
tile-preload with `tile:window:opener-*`. Then delete the 3
`ipcMain.handle('opener-*')` blocks in `ipc.ts`.

**Files:** `apps/desktop/main/tile-preload.cts` (lines around 1112,
1122, 1129 in `app/page/page.js` consumer paths), `apps/desktop/main/
ipc.ts`.

**Dependencies:** 3.5a

**Budget:** 15 min

**Validation:** `yarn tsc --noEmit`, `yarn test:unit`,
`yarn test:electron:bg -g "page"`.

**Risk:** low.

---

#### 3.6b — Flip tile-preload `theme:*` to strict + delete legacy handlers

**Scope:** Replace 6 unconditional `ipcRenderer.invoke('theme:*', …)`
sites in tile-preload with strict equivalents. Delete the 6 legacy
handlers.

**Files:** `apps/desktop/main/tile-preload.cts` (lines 2036–2055),
`apps/desktop/main/ipc.ts`.

**Dependencies:** 3.5b

**Budget:** 20 min

**Validation:** `yarn tsc --noEmit`, `yarn test:electron:bg -g "theme"`.

**Risk:** low — straight rename of channel string + handler delete.

---

#### 3.6c — Flip tile-preload `extension-*` to strict + delete legacy handlers

**Scope:** Replace 10 `ipcRenderer.invoke('extension-*', …)` sites
(1933–1993). Delete legacy handlers in `ipc.ts`.

**Files:** `apps/desktop/main/tile-preload.cts`, `apps/desktop/main/
ipc.ts`.

**Dependencies:** 3.5c

**Budget:** 20 min

**Validation:** `yarn tsc --noEmit`, `yarn test:electron:bg
-g "extension"`.

**Risk:** medium — extension management touches Features pane.

---

#### 3.6d — Flip tile-preload `chrome-ext:*` to strict + delete legacy handlers

**Scope:** Replace 6 sites (2071–2101). Delete legacy handlers.

**Files:** `apps/desktop/main/tile-preload.cts`, `apps/desktop/main/
ipc.ts`.

**Dependencies:** 3.5d

**Budget:** 20 min

**Validation:** `yarn tsc --noEmit`, `yarn test:electron:bg
-g "chrome-ext"`.

**Risk:** low.

---

#### 3.6e — Flip `feature-settings-schema` + `get-window-id` to strict + delete

**Scope:** Replace tile-preload calls + delete handlers.

**Files:** `apps/desktop/main/tile-preload.cts`, `apps/desktop/main/
ipc.ts`.

**Dependencies:** 3.5e

**Budget:** 15 min

**Validation:** `yarn tsc --noEmit`, `yarn test:electron:bg`.

**Risk:** low.

---

#### 3.6f — Flip `renderer-log`/`app-quit`/`app-restart` to strict (or keep as survivors)

**Scope:** Either flip to `tile:*` (per 3.5f shims) and delete legacy
`.on` handlers, OR explicitly choose to keep the 3 as legacy-permanent
survivors. Document the decision inline in `ipc.ts`.

**Files:** `apps/desktop/main/tile-preload.cts`, `apps/desktop/main/
ipc.ts`.

**Dependencies:** 3.5f

**Budget:** 15 min

**Validation:** `yarn tsc --noEmit`, `yarn test:electron:bg -g "smoke"`.

**Risk:** low.

---

#### 3.6g — Flip tile-preload `datastore-*` to strict + delete legacy handlers

**Scope:** Replace 28 unconditional `ipcRenderer.invoke('datastore-*',
…)` sites in tile-preload (lines 861–955) with `tile:datastore:*`
equivalents. Delete the matching 28 legacy handlers in `ipc.ts`.

**Files:** `apps/desktop/main/tile-preload.cts`, `apps/desktop/main/
ipc.ts`.

**Dependencies:** 3.5g (shims must exist first)

**Budget:** 25 min — split into 3.6g1 (first 14) + 3.6g2 (last 14)
if it overruns.

**Validation:** `yarn tsc --noEmit`, `yarn test:unit`,
`yarn test:electron:bg -g "datastore"`,
`yarn test:electron:bg -g "items"`,
`yarn test:electron:bg -g "tags"`.

**Risk:** medium-high — datastore is product-critical. Split if
unsure.

---

#### 3.7a — Collapse `window-*` fallback else-branches (11 channels)

**Scope:** Convert the 11 `window-*` `if (!hasWindowCapability())
return ipcRenderer.invoke('window-*', …)` else branches in tile-preload
to throw + delete. Mirror the 3.3 izui pattern. Delete the legacy
`window-*` handlers in `ipc.ts` for the 11 affected channels.

**Files:** `apps/desktop/main/tile-preload.cts` (lines 514, 541, 570,
585, 600, 615, 636, 654, 668, 682, 696, 710, 726, 749), `backend/
electron/ipc.ts`.

**Dependencies:** none

**Budget:** 25 min

**Validation:** `yarn tsc --noEmit`, `yarn test:unit`,
`yarn test:electron:bg -g "window"`.

**Risk:** medium — many call sites; if any v2 tile is silently relying
on the fallback (cap not declared), it'll throw. Pre-audit by grep
through all tile manifests for `window` capability.

---

#### 3.7b — Collapse `feature-registry/install/browse:*` fallbacks (10 channels)

**Scope:** Convert the 10 `feature-*` else branches in tile-preload
(lines 1448–1470) to throw + delete fallback. Delete the 10 legacy
handlers in `ipc.ts`.

**Files:** `apps/desktop/main/tile-preload.cts`, `apps/desktop/main/
ipc.ts`.

**Dependencies:** 3.6e (clears related surfaces)

**Budget:** 20 min

**Validation:** `yarn tsc --noEmit`, `yarn test:electron:bg
-g "feature"`.

**Risk:** medium — features pane.

---

#### 3.7c — Collapse `context-*` fallbacks (6 channels)

**Scope:** Convert the 6 `context-*` else branches in tile-preload
(lines 1287–1297) to throw + delete fallback. Delete the 6 legacy
handlers in `ipc.ts`.

**Files:** `apps/desktop/main/tile-preload.cts`, `apps/desktop/main/
ipc.ts`.

**Dependencies:** 3.8b (`app/context/*.js` must already use
tile-preload — otherwise they break).

**Budget:** 15 min

**Validation:** `yarn tsc --noEmit`, `yarn test:electron:bg
-g "context"`, `yarn test:electron:bg -g "history"`.

**Risk:** medium — context is used by cmd, history, idx.

---

#### 3.7d — Collapse misc fallbacks (oauth, sync-full, screen, save-space-workspaces, set-visible-on-all-workspaces) — 5 channels

**Scope:** Convert 5 misc fallback branches and delete the 5 legacy
handlers. Per-channel sites:
- `oauth-start-loopback`/`oauth-await-callback`: tp:1690, 1692
- `sync-full`: tp:1744
- `screen-get-primary-display`: tp:1769
- `save-space-workspaces`: tp:1791
- `window-set-visible-on-all-workspaces`: tp:749

**Files:** `apps/desktop/main/tile-preload.cts`, `apps/desktop/main/
ipc.ts`.

**Dependencies:** none

**Budget:** 20 min

**Validation:** `yarn tsc --noEmit`, `yarn test:electron:bg`.

**Risk:** medium — oauth flows are infrequently exercised in tests.

---

#### 3.8a — Audit `app/context/*.js` call surface

**Scope:** Read-only. Enumerate every direct `window.app.invoke(
'context-*')` (or equivalent) call in `app/context/*.js`. List the
modules' entry points and which renderers load them. Determine the
migration path: (i) move into a tile with `context` capability, (ii)
load via tile-preload across the board, or (iii) inline the calls into
each consumer renderer that already has a tile-preload. Output a short
recommendation appended to this doc.

**Files (read-only):** `app/context/*.js`, plus grep for
`context-get`, `context-set`, `context-history`, `context-snapshot`,
`context-windows-*` across `app/**`.

**Dependencies:** none

**Budget:** 20 min

**Validation:** none (audit). Commit the audit append.

**Risk:** low — read-only.

---

#### 3.8b — Port `app/context/*.js` to use tile-preload `api.context.*`

**Scope:** Per 3.8a recommendation, refactor every direct `context-*`
invoke in `app/context/*.js` to use `api.context.*` (tile-preload's
strict surface). Verify load contexts already use tile-preload (cmd,
hud, page glue all do). For any consumer still on v1 preload, defer to
3.11b.

**Files:** `app/context/*.js` (all), plus consumers per 3.8a output.

**Dependencies:** 3.8a

**Budget:** 25 min — split into 3.8b1/b2 by file count if over.

**Validation:** `yarn tsc --noEmit`, `yarn test:unit`,
`yarn test:electron:bg -g "context"`,
`yarn test:electron:bg -g "history"`.

**Risk:** medium — context drives history widget + cmd context.

---

#### 3.9 — Rewrite `getRunningExtensions` / `getAllRegisteredExtensions` for v2

**Scope:** (Was 3.5 in original plan.) Rewrite both functions to use
`getLoadedTileIds()` + `declarativeExtensions` + a hardcoded core-
renderer ids list (cmd/hud/page). Delete `isConsolidatedExtension()`
and the `loadedConsolidatedExtensions.add(...)` calls. Verify Features
pane.

**Files:** `apps/desktop/main/main.ts` (lines 89, 97, 1214, 1225, 1237,
1313–1373, 1380–1413, 1462–1464), `apps/desktop/main/ipc.ts:100, 1300,
1310, 1323`, `apps/desktop/main/index.ts` (if exported).

**Dependencies:** 3.1 (cleared — GO).

**Budget:** 25 min

**Validation:** `yarn tsc --noEmit`, `yarn test:electron:bg
-g "features"`, manual smoke of Settings > Features.

**Risk:** medium — Features pane is user-facing.

---

#### 3.10 — Delete `extensionHostWindow` + host HTML + broadcaster v1 branch

**Scope:** (Was 3.6 in original plan.) Per 3.1 audit's option (a):
delete the host window, the iframe loader, INTERNAL_URLS reference,
the broadcaster v1 branch in main.ts:226–244, the `app/extension-
host.html` file. Update smoke tests per 3.1's per-site recommendations
(delete tests 4174-4179, 4181-4217, 5291-5371, 5373-5433; trim
1380-1386 and 4359-4366; rewrite fixture helper at desktop-app.ts:
222-244; trim README.md:140-141 + 148).

**Files:** `apps/desktop/main/main.ts`, `apps/desktop/main/ipc.ts:2306`,
`app/extension-host.html` (delete), smoke.spec.ts, fixtures, README.

**Dependencies:** 3.9

**Budget:** 25 min — split into 3.10a (source delete) + 3.10b (test +
fixture rewrite) if over.

**Validation:** `yarn tsc --noEmit`, `yarn test:electron:bg -g "smoke"`,
`yarn test:electron:bg` (full).

**Risk:** high — biggest single delete. 3.1 audit is the safety net.

---

#### 3.11a — Delete suspected-dead channels (~31 channels)

**Scope:** Delete the 31 channels with NO callers in `preload.js` or
`tile-preload.cts` (per 3.4 audit). List: `extension-window-unload`,
`extension-manifest-get`, `web-nav-back/forward/reload/state`,
`backup-get-config/set-config/create/list`, `session-save/get-snapshot
-info/restore/restore-interactive`, `shell-open-path`, `default-
browser-status`, `set-default-browser`, `window-reopen-last-closed`,
`window-animate`, `window-is-draggable`, `datastore-query-items-by-
frecency`, `IPC_CHANNELS.CONSOLE`. Pre-delete: re-verify via grep for
`api.invoke('<name>')` passthrough usage.

**Files:** `apps/desktop/main/ipc.ts`, `backend/config.ts` (CONSOLE).

**Dependencies:** none — independent low-risk package, runnable any
time after 3.4.

**Budget:** 20 min

**Validation:** `yarn tsc --noEmit`, `yarn test:unit`,
`yarn test:electron:bg`.

**Risk:** low–medium. Risk hinges on the `api.invoke()` passthrough
gap (per 3.4 "Open gaps"). Full electron suite catches any runtime
miss.

---

#### 3.11b — Delete remaining preload-only handlers + delete `preload.js` file

**Scope:** With Wave 2b + 2c + 2d complete, the remaining ~48 preload-
only handlers in `ipc.ts` have no live consumers. Delete them all.
Then delete `preload.js`. Remove `setPreloadPath`/`getPreloadPath`
from `apps/desktop/main/config.ts`, `entry.ts`, `index.ts`, and the
window-open fallback at `ipc.ts:2268,2670`. Update `will-attach-
webview` in `entry.ts:189-211` to drop the v1 fallback branch.

**Files:** `apps/desktop/main/ipc.ts` (~48 handler blocks), `preload.js`
(delete 2693 LOC), `apps/desktop/main/entry.ts` (lines 63, 152, 157,
189–211), `apps/desktop/main/config.ts`, `apps/desktop/main/index.ts`.

**Dependencies:** Wave 2b (3.6a–g) + Wave 2c (3.7a–d) + Wave 2d
(3.8b) + Wave 2f (3.10) all complete.

**Budget:** 25 min — if it overruns, split into 3.11b1 (delete handler
blocks only) + 3.11b2 (delete preload.js + update glue).

**Validation:** `yarn tsc --noEmit`, `yarn test:unit`,
`yarn test:electron:bg` (full),
`git grep preload.js` → only Tauri-local + docs,
`git grep "preload-only"` → zero in source.

**Risk:** high — final delete. Mitigations: 2b/2c/2d should have
caught all live consumers; tsc + full electron suite is the final net.

---

#### 3.11c — Delete `IPC_CHANNELS` const + remaining `.on` handlers

**Scope:** Delete `IPC_CHANNELS` const from `backend/config.ts:16-27`.
Update imports in `apps/desktop/main/ipc.ts:121`, `apps/desktop/main/
index.ts:13`, `apps/desktop/main/config.ts:14`. Delete the
`IPC_CHANNELS.SUBSCRIBE/PUBLISH/CLOSE_WINDOW/REGISTER_SHORTCUT/
UNREGISTER_SHORTCUT/MODIFY_WINDOW/RENDERER_LOG/APP_QUIT/APP_RESTART/
CONSOLE` handler blocks at `ipc.ts:4158-4476`.

**Files:** `backend/config.ts`, `apps/desktop/main/config.ts`, `backend/
electron/index.ts`, `apps/desktop/main/ipc.ts`.

**Dependencies:** 3.11b. Also requires 3.6f decision (if `renderer-
log`/`app-quit`/`app-restart` are kept as legacy survivors, they stay;
otherwise delete here).

**Budget:** 15 min

**Validation:** `yarn tsc --noEmit`, `yarn test:unit`,
`yarn test:electron:bg` (full),
`git grep "IPC_CHANNELS\b"` → zero matches.

**Risk:** medium. Final cleanup.

---

#### Risk-aware execution order (TL;DR for dispatchers)

1. Spawn 3.5a–g and 3.11a in parallel (8 packages, all low-risk
   additive or deletion-of-truly-dead).
2. Spawn 3.8a (audit) in parallel with the above.
3. As each 3.5x lands, spawn matching 3.6x.
4. Spawn 3.9 anytime in parallel.
5. After 3.5g + 3.6g land: spawn 3.7a (window cleanup).
6. After 3.8a lands: spawn 3.8b.
7. After 3.6e lands: spawn 3.7b.
8. After 3.8b lands: spawn 3.7c.
9. Spawn 3.7d anytime (independent).
10. After 3.9 lands: spawn 3.10.
11. After Wave 2b + 2c + 2d + 2f all complete: spawn 3.11b.
12. After 3.11b lands: spawn 3.11c.

Each agent follows the 25-min ceiling; if any package overruns,
commit-what-you-have + report blocker. Splits noted inline (3.6g, 3.8b,
3.10, 3.11b) are pre-authorised.

---

### phase3.8a — context audit (2026-04-18)

#### Channel inventory in `app/context/*.js`

| File | IPC channel(s) invoked | Where called |
|------|------------------------|--------------|
| `app/context/index.js` | `context-set` (in `set()`, line 80) | indirectly via `history.js` import; `set()` is the only IPC path |
| `app/context/history.js` | `context-set` (in `save()`, line 56) | called by `index.js::set()` when `persist=true` |
| `app/context/history.js` | `context-history` (in `query()`, line 77) | called by `index.js::getHistory()` |
| `app/context/history.js` | `context-snapshot` (in `getSnapshot()`, line 110) | called by `index.js::getSnapshot()` |
| `app/context/store.js` | _none_ — pure in-memory; no IPC | internal only |

Channels **not** present in `app/context/*.js`: `context-get`,
`context-windows-with-value`, `context-windows-in-space`.  Those are
exposed by `preload.js::api.context` but are not called directly inside
these modules.

#### Who actually calls `app/context/*.js`?

**Nobody.** A full-codebase grep finds zero `import … from
'peek://app/context/…'`, zero `import … from './context/…'` or similar
in any `.js`, `.ts`, `.cts`, or `.html` file outside the three
`app/context/` files themselves. The JSDoc comment at the top of
`index.js` advertises a `peek://app/context/index.js` URL but no
renderer has ever wired it up. `context.init(renderer)` is never called
from anywhere — `ipcRenderer` stays `null` in every live session, so
the three IPC invocations are dead code today.

#### Who calls `api.context.*` (tile-preload surface)?

All live context consumers go through `api.context` on `window.app`,
which tile-preload provides. Confirmed callers:

| File | Methods used |
|------|--------------|
| `app/cmd/panel.js` | `get`, `setMode`, `watchMode` |
| `app/page/page.js` | `get`, `setMode`, `watchMode` |
| `app/hud/widgets/mode.js` | `get`, `watchMode` |
| `features/spaces/background.js` | `get`, `setMode`, `getWindowsInSpace` |
| `features/groups/background.js` | `get`, `setMode`, `getWindowsInSpace` |
| `features/groups/home.js` | `setMode` |
| `features/editor/home.js` | `setMode` |
| `features/entities/background.js` | `set` |

All renderers listed above load `tile-preload.cjs` (cmd, hud, page via
their glue files; spaces, groups, editor, entities as v2 tiles). Every
feature tile has a `context` capability declared in its manifest, so
they already use `contextStrict` (`tile:context:*` channels). The core
builtins (cmd, hud, page) are `trustedBuiltin` grants with no `context`
capability key, so they fall through to `contextCompat` (`context-get /
context-set / …`) — those six compat branches in tile-preload are the
ones that still depend on `preload.js`.

#### Six `contextCompat` fallback branches in tile-preload

```
contextCompat.get      → ipcRenderer.invoke('context-get', …)
contextCompat.set      → ipcRenderer.invoke('context-set', …)
contextCompat.history  → ipcRenderer.invoke('context-history', …)
contextCompat.snapshot → ipcRenderer.invoke('context-snapshot', …)
contextCompat.windowsWithValue → ipcRenderer.invoke('context-windows-with-value', …)
contextCompat.windowsInSpace   → ipcRenderer.invoke('context-windows-in-space', …)
```

The compat path is taken when `grantedCapabilities.context` is falsy.
For cmd/hud/page, the token grant carries `trustedBuiltin: true` but no
`context` key, so `hasContextCapability()` returns `false` and every
`api.context.*` call in those three renderers hits the compat channels.

#### Migration path recommendation

**Option (ii) — add `context` capability to the trustedBuiltin grant
for cmd, hud, and page** is the correct migration path.

`app/context/*.js` is dead code and does not need to be ported or moved;
it can be deleted as part of 3.8b. The real migration work is entirely
in the backend: `cmd-glue.ts`, `hud-glue.ts`, and `page-glue.ts` (or
wherever the trustedBuiltin capability set is assembled) need `context:
true` added to the grant so `hasContextCapability()` returns `true` for
those windows. Once that is done, the six `contextCompat` fallback
branches in `tile-preload.cts` are unreachable and can be deleted along
with the matching `ipc.ts` legacy `context-get / context-set /
context-history / context-snapshot / context-windows-*` handlers. No
consumer renderer needs code changes — they already call `api.context.*`
and tile-preload's `api.context` will silently switch to strict channels
once the capability is present. Option (i) (a new tile) introduces
unnecessary indirection; option (iii) (inline per-renderer) is the same
work as option (ii) but harder to validate. Option (ii) is a two-line
change to the grant payload and unblocks both the compat-branch delete
and the eventual `preload.js` delete.

**Suggested 3.8b scope update:** delete `app/context/*.js` (three files,
currently unreferenced dead code), add `context: true` to the cmd/hud/
page trustedBuiltin capability grant in the relevant glue files, delete
the six `contextCompat` compat branches from `tile-preload.cts`, and
delete the five legacy `context-*` handlers from `ipc.ts`.

---

### phase3.11-pre — preload.js deletion blockers (2026-04-18)

This audit answers the question: after Wave 2 (3.5–3.10) completes, what
prevents `preload.js` from being deleted in 3.11b? The 3.7a audit found
23 channels with live `api.invoke('<channel>', …)` callers in `app/`
files. This audit identifies those callers precisely, classifies each by
renderer context (tile-preload vs preload.js), and determines which ones
are true blockers.

#### Methodology

Searched all `.js` and `.html` files under `app/` and `features/` for:
- `api.invoke(` (direct channel invocation)
- `api.send(` / `api.on(` (IPC send/receive)
- `window.app.invoke(` (DOM-based passthrough)
- `ipcRenderer.invoke(` (renderer-side raw IPC)

Results: **zero hits in `features/**`**. All live callers are in `app/`.

---

#### Section 1 — Complete `api.invoke(...)` call inventory in `app/`

| File | Line | Channel | Context (-1 line) |
|------|------|---------|-------------------|
| `app/index.js` | 489 | `session-save` | `execute: async () => {` |
| `app/index.js` | 501 | `session-restore-interactive` | `execute: async () => {` |
| `app/index.js` | 528 | `web-nav-back` | `execute: () =>` |
| `app/index.js` | 534 | `web-nav-forward` | `execute: () =>` |
| `app/index.js` | 540 | `web-nav-reload` | `execute: () =>` |
| `app/index.js` | 547 | `web-nav-state` | `execute: async () => {` |
| `app/index.js` | 684 | `window-reopen-last-closed` | `api.subscribe('cmd:execute:reopen closed window', …)` |
| `app/index.js` | 701 | `frontend-ready` | `// Signal to main process that frontend subscribers are ready.` |
| `app/index.js` | 710 | `session-restore-pending` | `if (p.restoreSession !== false) {` |
| `app/settings/settings.js` | 281 | `default-browser-status` | `(async () => {` |
| `app/settings/settings.js` | 296 | `set-default-browser` | `defaultBrowserBtn.textContent = 'Setting...';` |
| `app/settings/settings.js` | 3147 | `backup-create` | `backupOutput.textContent = 'Creating backup...';` |
| `app/settings/settings.js` | 3159 | `backup-list` | `backupOutput.textContent = 'Loading...';` |
| `app/settings/settings.js` | 3186 | `backup-get-config` | `backupBtnRow.appendChild(makeBtn('Open Backup Folder', async () => {` |
| `app/settings/settings.js` | 3196 | `shell-open-path` | `await api.invoke('backup-get-config'); …` |
| `app/page/page.js` | 847 | `get-app-prefs` | `(async () => {` |
| `app/diagnostic.html` | 155 | `backup-create` | `logBackup('Creating Backup', 'Please wait...');` |
| `app/diagnostic.html` | 169 | `backup-list` | `logBackup('Loading', 'Fetching backup list...');` |
| `app/diagnostic.html` | 205 | `backup-get-config` | `window.openBackupFolder = async function() {` |
| `app/diagnostic.html` | 217 | `shell-open-path` | `const configResult = await api.invoke('backup-get-config');` |
| `app/cmd/commands/page.js` | 148 | `window-devtools` | `// DevTools is handled via IPC directly, not via page.js` |

No `api.send(...)`, `api.on(...)`, `window.app.invoke(...)`, or
`ipcRenderer.invoke(...)` calls found in any `app/` or `features/` file.

---

#### Section 2 — Channel table

For each unique channel, the table records:

- **Legacy handler in `ipc.ts`?** — `Y` = yes, `entry.ts` = in `entry.ts` not `ipc.ts`.
- **`tile:*` equivalent in `tile-ipc.ts`?** — `Y` = yes, `N` = no.
- **Caller files** — where invoked.
- **Preload used by caller** — `tile-preload` or `preload.js`.
- **Recommended action.**

| Channel | ipc.ts? | tile:* equiv? | Caller file(s) | Caller preload | Action |
|---------|---------|---------------|----------------|----------------|--------|
| `frontend-ready` | entry.ts | N | `app/index.js:701` | tile-preload | **No action needed.** Core renderer uses tile-preload's `api.invoke` trustedBuiltin passthrough. `frontend-ready` lives in `entry.ts` (not ipc.ts); it is NOT in the preload.js legacy surface being deleted. |
| `session-restore-pending` | entry.ts | N | `app/index.js:710` | tile-preload | **No action needed.** Same reason as `frontend-ready` — `entry.ts` handler, tile-preload trustedBuiltin passthrough. |
| `session-save` | Y | N | `app/index.js:489` | tile-preload | **Build `tile:session:save` shim.** Caller is core background renderer (tile-preload, trustedBuiltin). Direct preload.js removal unblocks this channel's deletion, but to KEEP the feature working we need either a strict shim or keep the legacy handler. Since core renderer will use trustedBuiltin passthrough, keeping the legacy handler as a named channel is fine until a `tile:session:*` namespace is built out. |
| `session-restore-interactive` | Y | N | `app/index.js:501` | tile-preload | Same as `session-save`. |
| `web-nav-back` | Y | N | `app/index.js:528` | tile-preload | **Legacy handler can stay.** Caller is tile-preload trustedBuiltin passthrough — not blocked by preload.js deletion. These are in the "suspected dead in 3.4 audit" bucket (grep found no pl/tp callers). The `app/index.js` callers were missed by the 3.4 grep because that grep only scanned preload.js and tile-preload.cts, not `app/` scripts. These channels are LIVE, not dead. |
| `web-nav-forward` | Y | N | `app/index.js:534` | tile-preload | Same as `web-nav-back`. LIVE via trustedBuiltin. |
| `web-nav-reload` | Y | N | `app/index.js:540` | tile-preload | Same. LIVE. |
| `web-nav-state` | Y | N | `app/index.js:547` | tile-preload | Same. LIVE. |
| `window-reopen-last-closed` | Y | N | `app/index.js:684` | tile-preload | Same — LIVE via trustedBuiltin. (3.4 audit: "no caller found in pl/tp" — missed this.) |
| `default-browser-status` | Y | N | `app/settings/settings.js:281` | **preload.js** | **BLOCKER.** `app/settings` has no v2 manifest; settings window gets `preload.js`. |
| `set-default-browser` | Y | N | `app/settings/settings.js:296` | **preload.js** | **BLOCKER.** Same. |
| `backup-create` | Y | N | `app/settings/settings.js:3147`, `app/diagnostic.html:155` | **preload.js** | **BLOCKER.** Both files use preload.js. (3.4 audit: "likely dead" — missed these.) |
| `backup-list` | Y | N | `app/settings/settings.js:3159`, `app/diagnostic.html:169` | **preload.js** | **BLOCKER.** Same. |
| `backup-get-config` | Y | N | `app/settings/settings.js:3186`, `app/diagnostic.html:205` | **preload.js** | **BLOCKER.** Same. |
| `shell-open-path` | Y | N | `app/settings/settings.js:3196`, `app/diagnostic.html:217` | **preload.js** | **BLOCKER.** Same. (3.4 audit: "no caller — likely dead" — missed these.) |
| `get-app-prefs` | Y | N | `app/page/page.js:847` | **preload.js** | **BLOCKER.** Canvas page windows have no tile manifest → get `preload.js`. |
| `window-devtools` | Y | N | `app/cmd/commands/page.js:148` | tile-preload | **No action needed.** cmd is trustedBuiltin. Channel stays in ipc.ts until cmd migrates to strict `tile:extensions:windowDevtools` path (already exists). |

**3.4 audit correction:** six channels were incorrectly classified as
"no caller — likely dead" (`backup-get-config`, `backup-create`,
`backup-list`, `shell-open-path`, `web-nav-back/forward/reload/state`,
`window-reopen-last-closed`). The 3.4 grep only searched `preload.js`
and `tile-preload.cts`. Actual callers live in `app/*.js` and
`app/settings/settings.js` which were NOT grepped. These channels must
NOT be deleted in 3.11a without first migrating the callers.

Additionally, `frontend-ready` and `session-restore-pending` are NOT in
`ipc.ts` — they live in `entry.ts` and are outside the v1-removal scope
entirely. No action needed.

---

#### Section 3 — Renderer context per blocker file

For each file with legacy-preload callers, this section identifies HOW
the renderer is loaded and why it receives `preload.js`.

The `window-open` handler in `ipc.ts:1022` calls
`getTileWebPreferencesForUrl(url, …)` to decide which preload to assign
a new BrowserWindow. That function returns `null` for any URL whose
`peek://` host is not a registered v2 tile manifest. A `null` result
falls back to `getPreloadPath()` = `preload.js`.

##### `app/settings/settings.html` + `app/settings/settings.js`

- **Entry point:** opened via `windowManager.createWindow(url, …)` in
  `app/index.js:58`, which calls `api.window.open(settingsAddress, …)`
  → `window-open` IPC with url = `peek://app/settings/settings.html`.
- **URL host:** `app` — not a registered v2 tile (`app/settings/` has no
  `manifest.json`, no tile registration in `tile-launcher.ts`).
- **`getTileWebPreferencesForUrl` result:** `null`.
- **Preload assigned:** `getPreloadPath()` = **`preload.js`**.
- **Consequence:** All `api.*` calls in `settings.js` come from
  `preload.js`. The file uses: `api.invoke` (5 direct channels),
  `api.extensions.*`, `api.theme.*`, `api.adblocker.*`,
  `api.chromeExtensions.*`, `api.darkMode.*`, `api.sync.*`,
  `api.profiles.*`, `api.publish`, `api.scopes`.
- **LOC:** `settings.js` 3491 + `settings.html` 30 = **3521 LOC**.
- **Blocker classification:** BLOCKER. Cannot delete `preload.js` while
  this window uses it.
- **Migration path:** Convert `app/settings/` to a v2 tile. Add
  `manifest.json` declaring `app/settings/settings.html` as its home
  entry, add capability grants covering every `api.*` namespace used
  (window, extensions, theme, adblocker, chromeExtensions, darkMode,
  sync, profiles, datastore, pubsub). Register via `tile-launcher.ts`.
  Replace all `api.invoke(...)` calls with structured `api.<ns>.<method>`
  calls through tile-preload. Estimated budget: 30–45 min (large file).
  Can be split into 3.11b-settings (manifest + registration) + 3.11b-settings2
  (port api.* calls).

##### `app/diagnostic.html`

- **Entry point:** `api.window.open('peek://app/diagnostic.html', …)` in
  `app/index.js:268` → `window-open` IPC with url = `peek://app/diagnostic.html`.
- **URL host:** `app` — not a registered v2 tile.
- **Preload assigned:** **`preload.js`**.
- **API surface:** `api.invoke` (4 direct channels: `backup-create`,
  `backup-list`, `backup-get-config`, `shell-open-path`),
  `api.datastore.getTable`.
- **LOC:** 232 LOC.
- **Blocker classification:** BLOCKER. However, this is a developer-only
  diagnostic tool. Lowest-risk migration option: either (a) convert to a
  minimal v2 tile with `backup` + `datastore` capabilities, or (b) wrap
  the 4 `api.invoke` calls into proper `api.backup.*` tile methods and
  add a `tile:backup:*` namespace, then add a manifest. Budget: 20 min.

##### `app/page/page.js` (canvas page host)

- **Entry point:** canvas page windows are created by `window-open` with
  a WEB URL (e.g. `https://example.com`). `getTileWebPreferencesForUrl`
  returns `null` for non-`peek://` URLs. The window then loads
  `peek://app/page/index.html?url=...` as `loadUrl` (ipc.ts:1225), but
  the preload was already determined against the original `https://` URL
  — so `preload.js` is used.
- **Preload assigned:** **`preload.js`** (all canvas page windows).
- **API surface used by `page.js`:**
  - `api.invoke('get-app-prefs')` (line 847)
  - `api.window.*` (getWindowId, setBounds, getBounds, getDisplayInfo,
    setScrollPosition, openerPostMessage, openerClose, openerFocus)
  - `api.profiles.getPartition` (line 630)
  - `api.context.get` / `api.context.setMode` / `api.context.watchMode`
    (lines 2109, 2119, 2133, 2140)
  - `api.datastore.*` (updateItemTitle, trackNavigation, queryItems,
    getItemTags, getTagsByFrecency, getOrCreateTag, tagItem, untagItem)
  - `api.chromeExtensions.list` / `getUiEntries` (line 3543-3544)
  - `api.subscribe` / `api.publish` / `api.scopes`
- **LOC:** `page.js` 3788 + `app/page/index.html` (canvas host) —
  combined **~4000+ LOC** of preload.js-dependent renderer code.
- **Blocker classification:** BLOCKER — the largest single blocker.
- **Migration path:** There is no straightforward v2 tile manifest path
  for canvas page windows because they are created dynamically with web
  URLs as their identity. The correct migration is one of:
  - **(a) Dedicated `page` tile** — register `app/page/index.html` as a
    v2 tile entry under a `page` tile manifest (`peek://page/page-host.html`
    or similar), and in the `window-open` handler, use that tile's preload
    for any canvas window instead of the web URL. This keeps the existing
    canvas architecture but routes `page.js`'s `api.*` calls through
    tile-preload. The token would carry `window`, `datastore`, `context`,
    `profiles`, `chromeExtensions` capabilities + trustedBuiltin.
    Estimated budget: 30 min (manifest + glue change in ipc.ts:1041-1042).
  - **(b) Unconditional tile-preload for `peek://app/*`** — in the
    `window-open` handler, for URLs that will `loadUrl` into
    `peek://app/page/index.html`, assign a hardcoded tile-preload path +
    `core` trustedBuiltin token (same as core background). Simpler but
    gives the canvas window the full trustedBuiltin surface (same risk as
    current `preload.js` isCore).
  - **(c) Port `get-app-prefs` to a proper `tile:*` channel** and register
    `app/page/` as a v2 tile. Requires addressing the full `api.*` surface
    used by `page.js` — essentially same as option (a) but scoped to the
    canvas page tile manifest.
  Option (a) is cleanest architecturally.

---

#### Section 4 — Path-forward recommendation

**True blockers** (renderers running under `preload.js`): 3 renderer
contexts, ~3753 LOC of consumer code.

**Non-blockers** (callers already on tile-preload trustedBuiltin
passthrough): `app/index.js` (9 channels), `app/cmd/commands/page.js`
(1 channel). These do NOT block preload.js deletion but do require the
corresponding legacy channels to remain in `ipc.ts` until a `tile:*`
shim is built for each. They represent channels the 3.4 audit
incorrectly classified as "dead" — they must be removed from the 3.11a
deletion list.

##### Corrected 3.11a channel list

Remove from the "suspected dead, delete in 3.11a" list:
- `web-nav-back`, `web-nav-forward`, `web-nav-reload`, `web-nav-state`
  (live callers: `app/index.js:528, 534, 540, 547` via trustedBuiltin)
- `window-reopen-last-closed` (live caller: `app/index.js:684` via
  trustedBuiltin)
- `backup-get-config`, `backup-create`, `backup-list`, `shell-open-path`
  (live callers: `app/settings/settings.js` + `app/diagnostic.html`)
- `default-browser-status`, `set-default-browser` (live callers:
  `app/settings/settings.js`)

Keep these channels in `ipc.ts` until their callers migrate.

##### Packages needed before 3.11b can execute

| Package | Scope | Budget |
|---------|-------|--------|
| **3.11b-settings** | Convert `app/settings/settings.html` to v2 tile: add `manifest.json`, register in `tile-launcher.ts`, add `tile:backup:*` and `tile:shell:open` shims, add `tile:app:default-browser-*` shims, port all `api.invoke()` calls to structured `api.<ns>.*`. Replace remaining preload.js surface with tile-preload equivalents (most already exist: theme, extensions, chromeExtensions, sync, profiles, adblocker all have tile:* channels from Waves 2a–2b). | 45 min — split into 3.11b-settings1 (manifest + registration) + 3.11b-settings2 (api migration) |
| **3.11b-diagnostic** | Convert `app/diagnostic.html` to v2 tile OR add `tile:backup:create/list/get-config` + `tile:shell:open-path` shims and keep as a core utility with trustedBuiltin. The file is only 232 LOC with 4 direct `api.invoke` calls and 1 `api.datastore.getTable` call — simplest path is option (b): give it a minimal `app` tile entry + trustedBuiltin grant in the window-open handler for `peek://app/diagnostic.html`. | 20 min |
| **3.11b-page** | Convert canvas page host (`app/page/index.html` → `page.js`) to tile-preload. Add a `page-host` tile manifest or modify the `window-open` handler (ipc.ts:1041) to assign `tile-preload.cjs` with a trustedBuiltin page-host token for all canvas windows. Port `api.invoke('get-app-prefs')` to a `tile:app:get-prefs` shim. The rest of `page.js`'s `api.*` calls already have tile:* equivalents (window, datastore, context, profiles, chromeExtensions, pubsub). | 30 min |
| **3.11b-nav-session** | Build `tile:nav:*` shims for `web-nav-back/forward/reload/state` and `tile:session:save` + `tile:session:restore-interactive` + `tile:session:reopen-last-closed`. These are called from `app/index.js` via trustedBuiltin passthrough — the channels still need to exist in ipc.ts until tile-preload has strict equivalents, but they do NOT block preload.js deletion (only block the legacy handler deletion in 3.7/3.11c). | 20 min |
| **3.11b-prefs** | Build `tile:app:get-prefs` shim. Needed by `app/page/page.js:847`. Pairs with 3.11b-page. | (fold into 3.11b-page) |

##### Summary of additional work before 3.11b

1. **Build 3 missing `tile:*` namespaces:** `tile:backup:*` (3 methods),
   `tile:shell:open-path` (1 method), `tile:app:get-prefs` (1 method).
   Optionally `tile:nav:*` (4 methods) and `tile:app:default-browser-*`
   (2 methods) for clean channel removal in 3.11c.
2. **Migrate 3 renderer contexts** to tile-preload: `app/settings/`,
   `app/diagnostic.html`, `app/page/` (canvas host).
3. **Do NOT delete** these 10 channels in 3.11a: `backup-*` (3),
   `shell-open-path`, `default-browser-*` (2), `web-nav-*` (4),
   `window-reopen-last-closed`, `get-app-prefs`, `session-save`,
   `session-restore-interactive`.
4. **Fastest unblocking path:** 3.11b-diagnostic (20 min) + 3.11b-page
   (30 min) + the `tile:backup:*` shims (15 min folded into 3.11b-settings1)
   clear the majority of the surface. `settings.js` at 3491 LOC is the
   largest single item but can be staged across two spawns.

**Total additional budget before 3.11b:** ~115 min across 4–5 packages.
Biggest single blocker: `app/settings/settings.js` (3491 LOC, broadest
API surface, most new tile:* shims needed).

