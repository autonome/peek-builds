# V1 Removal Plan

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

Tests today get `bgWindow` via `getBackgroundWindow()` and call `(window as any).app.publish/subscribe`. Replacement options:

- **A — Privileged test renderer:** add `app/_test/index.html` (or similar) — a hidden resident renderer loaded only when `E2E_TEST=true`. It uses `tile-preload.cts` with a privileged grant (same as core). `getBackgroundWindow()` returns this renderer's BrowserWindow. Test code keeps the same shape (`api.pubsub.publish`, `api.subscribe`, etc.) — only the underlying preload + IPC channels change.
- **B — Drive through real UI:** rewrite tests to invoke commands via the cmd panel and assert on side effects. More realistic, much larger test rewrite.

Recommend A. Keeps test mechanics close to current; only `s/api.publish/api.pubsub.publish/g`-style edits needed in tests. The privileged renderer is a frontend file in `app/_test/`; the gating to load-only-when-`E2E_TEST=true` lives in backend glue.

Acceptance: every existing test passes against the new fixture. No `IPC_CHANNELS.SUBSCRIBE` callers in tests.

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
