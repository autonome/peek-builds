# V1 Removal Plan

Goal: every renderer in Peek runs through `tile-preload.cts` against `tile:*` IPC, with capability tokens. No more v1 consolidated-extension-host iframes, no more legacy IPC channels, no more dual paths in `tile-preload.cts`.

This eliminates the v1↔v2 seam — the source of the kagi/google/tag flaky test cluster (v2 tile publishes a `:result` event, v1-host bgWindow subscriber doesn't fire). Removes ~thousands of lines of compat code and one whole BrowserWindow.

---

## Current state — what's still v1

1. **Core background scripts (cmd, hud, page)** load via `loadExtInHost(host, id, url)` — iframes inside `extensionHostWindow`. They use the v1 `preload.js` API (`api.commands.register`, `api.publish`, `api.subscribe`) routed through legacy IPC channels.
2. **Test fixture `bgWindow`** = `peek://app/background.html`, another iframe in the same host. Tests subscribe/publish via the legacy `IPC_CHANNELS.SUBSCRIBE` / `IPC_CHANNELS.PUBLISH` path (see `ipc.ts:4466`).
3. **Legacy IPC channels** in `ipc.ts`: `window-open`, `window-close`, `IPC_CHANNELS.SUBSCRIBE`, `IPC_CHANNELS.PUBLISH`, several others. Used by core + tests + as fallback paths inside `tile-preload.cts`.
4. **`preload.js`** — the v1 preload. Loaded by every iframe in the consolidated extension host.
5. **`extensionHostWindow`, `loadExtInHost`, `extensionWindows` map, `extensionBroadcaster`** — the consolidated-host plumbing in `main.ts`.

Features (the 26 tiles in `features/`) are all v2 already — no work there.

---

## Why now

- Every flaky-test cluster we hit this session traced back to the v1↔v2 seam. The kagi/tag/widget-update tests (~10 tests) are blocked by routing that only exists *because* the seam exists.
- Two preloads, two IPC paths, two pubsub-broadcast paths → 4× the code surface for every change. Recent work in `tile-preload.cts` (single-file tiles, showSelf/hideSelf) had to add legacy-fallback branches in ~10 methods.
- The "tiles are the unit of a feature" principle (per `project_tile_is_fundamental.md`) is undermined as long as core lives outside the tile model.
- Cleanup yields a big LOC reduction in `main.ts`, `ipc.ts`, and `tile-preload.cts`.

---

## Phases

### Phase 1 — Convert core (cmd, hud, page) to tile-preload

Each of `app/cmd/`, `app/hud/`, `app/page/` already has a `background.html` + `background.js` pair. Move them to the tile launcher path:

- Add a manifest equivalent to each — either a real `manifest.json` or hardcoded grant in `*-glue.ts`. Core needs broad capabilities; introduce a **`builtin: true` + `core: true`** flag (or an equivalent privileged role) that grants everything without enumerating: all pubsub topics + scopes, all datastore tables, all window ops, etc.
- Update `cmd-glue.ts` / `hud-glue.ts` / `page-glue.ts` to call `launchTile()` instead of `loadExtInHost()`. Each becomes a resident tile with its own `BrowserWindow`.
- HUD-specific window hints already supported (`alwaysOnTop`, `focusable: false`, `transparent`).
- Background scripts switch to the v2 API surface: `api.initialize()` → `api.commands.register()` → etc. Mostly `s/api.publish/api.pubsub.publish/g` and similar.

Acceptance: cmd panel, hud, page-host commands all work; no `loadExtInHost` calls remain for these three.

### Phase 2 — Migrate test fixtures to the v2 path

Tests today get a "background window" via `getBackgroundWindow()` and call `(window as any).app.publish/subscribe`. They expect:
- Subscribe to any topic with `GLOBAL` scope and receive
- Publish any topic with any scope
- Direct `api.datastore.*` access

Options:
- **A — Privileged test tile:** add `features/_test/` (or `app/_test/`) — a hidden resident tile loaded only when `E2E_TEST=true`. It uses tile-preload with the same `core: true` grant as cmd/hud/page. `getBackgroundWindow()` returns this tile's BrowserWindow.
- **B — Drive through real UI:** rewrite tests to invoke commands via the cmd panel and assert on side effects. More realistic but a much larger test rewrite.

Recommend (A) — keeps test mechanics close to today's, just swaps the underlying preload. Test rewrites are minimal (`api.publish` → `api.pubsub.publish` etc.).

Acceptance: every existing test passes against the new fixture; no `IPC_CHANNELS.SUBSCRIBE` callers in tests.

### Phase 3 — Delete v1 plumbing

Once Phases 1–2 are done, no live caller of v1 paths exists. Delete:
- `extensionHostWindow`, `loadExtInHost`, `extensionWindows`, `extensionBroadcaster` (the v1-specific iteration; v2 broadcasting via `getAllTileWindows()` stays).
- Legacy IPC channels: `IPC_CHANNELS.SUBSCRIBE/PUBLISH`, `window-open` / `window-close` / `cmd-result` / etc. Audit each before deleting.
- `preload.js` (v1) — delete the file.
- Fallback branches in `tile-preload.cts`: every `if (!hasXxxCapability()) return ipcRenderer.invoke('legacy-channel', ...)` becomes a hard error or just removes the legacy arm. ~10 methods affected.

Acceptance: full test suite passes; `git grep IPC_CHANNELS` returns nothing (or only the const declaration to also delete).

### Phase 4 — Manifest cleanup

Now that v2 is the only model:
- Drop the `type?: 'window' | 'background' | 'panel'` field from `TileEntry`. Replace background-tile uses with `resident: true` + no width/height (or 0×0 if explicitly desired).
- Drop `windowHints` nested object (already redundant with flat fields).
- Decide: bump `manifestVersion` to 3 to signal the v1-removal milestone, or drop the field entirely.
- Update all 26 feature manifests + the 3 core manifests to the canonical shape.
- Update `docs/tiles-single-file.md`, `docs/tile-preload-trimming-plan.md`, `docs/command-audit.md`.

Acceptance: one tile shape, one preload, one IPC surface. `tile-preload.cts` shrinks substantially.

---

## Risks & mitigations

- **Privileged grant for core.** The `core: true` flag bypasses capability gating. Audit every place capability is enforced to ensure the bypass is intentional. Consider a separate "trusted-builtin" path that's clearly marked.
- **Test breakage during Phase 2.** Run the migration test-by-test. Keep both paths working simultaneously during the transition (swap `getBackgroundWindow()` to return the new fixture only when ready).
- **HUD focus / alwaysOnTop.** The HUD has unusual window properties (alwaysOnTop, focusable:false, app-blur hide/show). Verify `launchTile()` honors these on macOS. Per memory, these flags are already supported in the flat manifest — but worth a smoke test.
- **Performance.** Cmd panel was an iframe; as a BrowserWindow it's heavier. But cmd is resident, so spawn happens once at startup. Expected impact: negligible after first launch.
- **Chrome extensions** stay as-is — they're loaded via Electron's `session.loadExtension`, not via the tile mechanism. No change.

---

## Order & estimate

Sequential — each phase depends on the previous:

1. Phase 1: ~2 days (3 core conversions + glue updates + capability-grant infrastructure)
2. Phase 2: ~1–2 days (test fixture + migrate test calls)
3. Phase 3: ~1 day (deletion + audit)
4. Phase 4: ~1 day (manifest cleanup, docs)

Total: ~5–6 days. Smaller if the privileged-grant infra reuses existing patterns.

---

## Validation per phase

- After each phase: full `yarn test:unit` + `yarn test:electron:bg` should pass at the *same* level (or strictly better) than before.
- The kagi/tag/widget-update flakies should pass after Phase 2 — the routing seam they hit will no longer exist.
- After Phase 3: zero references to `IPC_CHANNELS`, `loadExtInHost`, `extensionHostWindow` in the codebase.
