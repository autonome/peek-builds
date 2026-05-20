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

`yarn test:electron` is the canonical gate. It runs `electron-builder --dir`, then Playwright `desktop` + `desktop-serial` projects with `PACKAGED=1`. Always run this before considering a change done — source-only tests miss asar/asar.unpacked path bugs and electron-builder file inclusion problems.

```bash
yarn test:electron          # Full packaged build + Playwright (canonical)
yarn test:grep "<pattern>"  # Fast inner-loop: source-only, single test
yarn test:electron:source   # Escape hatch: source-only, no packaging
yarn test:packaged          # Re-run against existing out/mac-arm64/Peek.app
```

`yarn test:grep` iterates fast during editing. Validate with `yarn test:electron` before declaring done.

**Tauri desktop (`apps/tauri-desktop/`) is off the critical path.** Do NOT gate on `yarn test` (which includes tauri tests); use `yarn test:electron` only.

---

## Tile Architecture

Every UI surface — browser tabs, cmd panel, settings, everything — is a **tile**: a `BrowserWindow` loaded through `tile-preload.cts` and the capability-gated `tile:*` IPC. There is no "tile type" or "tile role" distinction.

Key facts:
- **`tile-preload.cts` must stay `.cts` (CommonJS TypeScript).** The backend `tsconfig.json` emits ESM for `.ts` files. Electron's sandbox preload silently rejects ESM — `window.app` becomes empty and the entire tile API disappears with no error thrown. Do not rename or convert this file.
- `window.app.*` is the API surface exposed to every tile renderer. It is frozen by the ContextBridge — you cannot wrap methods on it at the renderer side.
- Tile capabilities are declared in `manifest.json` (schema v3). A CONSUMER tile must list each topic it subscribes to in its own `pubsub.topics`; producer-only listing causes silent failures.
- PubSub is the default messaging pattern. Switch to directed `webContents.send` only if you see a broadcast-then-filter smell.

See `docs/architecture.md` and `docs/tiles-single-file.md` for the full tile model.

---

## Page View Canvas Architecture — FROZEN

**Do not replace or restructure this architecture.** It was accidentally destroyed once and had to be restored.

Content and child-content web pages use a **fullscreen transparent canvas** BrowserWindow:

1. `useCanvas = true` → content/child-content pages. `useCanvas = false` → slides, modals, overlays (load URL directly in a positioned BrowserWindow).
2. Canvas BrowserWindow is sized to cover the full display work area at (0,0), background `#00000000` (fully transparent).
3. All elements (`<webview>`, navbar, resize handle) are `position: absolute` siblings. Positions set via inline styles by `updatePositions()` based on `bounds` URL params.
4. Drag/resize uses a custom mousedown handler — no `-webkit-app-region: drag`.

See "Page View Canvas Architecture" in `DEVELOPMENT.md` for the canonical description.

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
