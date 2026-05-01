# Core Extraction Plan — cmd, page, hud

## Context

During the tiles migration, we identified that cmd, page, and hud aren't features — they're platform infrastructure. Features are things users can install, enable, disable, remove, publish, and distribute. cmd/page/hud are prerequisites for Peek existing.

This document plans moving them out of `features/` and into `./app/` (cross-platform frontend code), with thin backend-specific glue where needed.

## Why they're not features

1. **Can't be uninstalled** — without cmd, no invocation. Without page, no web content rendering. Without hud, no overlay.
2. **Can't be published/distributed** — a "cmd" on atproto makes no sense. They ARE Peek's interface.
3. **Need deep platform integration** — cmd needs global shortcuts, hud needs main-process focus handling, page needs webview embedding. Sandboxing is actively harmful.
4. **The tile capability model is for untrusted code** — breaks down when the code IS the trusted platform.
5. **Converting them requires workarounds** — cmd lazy-loading itself, page hosting webviews under sandbox. The friction is a signal.

## Cross-backend principle

Peek runs on Electron AND Tauri (and mobile via Tauri). Core UI components must remain platform-agnostic:

- `./app/` — cross-platform frontend (webview code, identical on Electron or Tauri)
- `./backend/electron/` — Electron-specific main process, IPC, protocol handlers
- `./backend/tauri/` — Tauri-specific (Rust)
- `./backend/tauri-mobile/` — mobile Tauri

**cmd/page/hud UI code goes in `./app/`, not `./backend/electron/`.**

The cross-platform `api.*` surface (`api.pubsub`, `api.shortcuts`, `api.window`) hides backend differences. Each backend implements this contract.

## Target structure

```
app/
  cmd/
    panel.html, panel.js, panel.css       — command palette UI
    state-machine.js                      — pure state machine (no DOM/IPC)
    registry.js                           — command registry (in-renderer)
    nouns.js, noun-registry.js            — noun system
  page/
    page.html, page.js, page.css          — canvas / webview host (partially here already)
  hud/
    hud.html, hud.js, hud.css             — always-on overlay UI
    widgets/...                           — HUD widgets

backend/electron/
  cmd-glue.ts                             — registers global Cmd+K shortcut, creates cmd window
  page-glue.ts                            — URL rewriting, webview protocol setup
  hud-glue.ts                             — creates HUD window with alwaysOnTop/focusable:false/transparent, handles did-resign-active hide/show

backend/tauri/src-tauri/src/
  cmd_glue.rs                             — equivalent for Tauri
  page_glue.rs                            — equivalent for Tauri
  hud_glue.rs                             — equivalent for Tauri
```

## What changes

### Loading path
- No `manifest.json` for cmd/page/hud — they load as app pages, not features
- Each backend's startup code creates their windows / loads their URLs directly
- Drop them from `CONSOLIDATED_EXTENSION_IDS`
- Drop them from `EAGER_EXTENSION_IDS`
- Not subject to tile sandboxing, CSP injection, capability tokens

### Backend-specific hooks move to glue files
Currently in `backend/electron/main.ts`:
- Global shortcut registration for Cmd+K → `cmd-glue.ts`
- HUD window creation (alwaysOnTop, focusable: false, transparent) → `hud-glue.ts`
- HUD focus handling (`did-resign-active`/`did-become-active` hide/show) → `hud-glue.ts`
- `trackVisibleWindowFocus()` HUD exclusion → `hud-glue.ts`
- Page URL rewriting (`https://...` → `peek://app/page/index.html?url=...`) → `page-glue.ts`

### Public API surface (stable)
These are the interfaces tiles continue to use — they just get implemented by core code instead of feature code:

- `api.commands.register(def)` → cmd registry
- `api.shortcuts.register(...)` → shortcut system
- `api.window.open(url, options)` → window manager
- `cmd:execute:{name}` pubsub → command invocation
- Noun registration API

Tiles don't know or care that cmd/page/hud moved. They just use the `api`.

## Extraction order

### Phase 1: cmd
Highest impact. Current cmd is in `features/cmd/` as a consolidated extension. Move:
1. `features/cmd/panel.html`, `panel.js`, `state-machine.js`, `nouns.js`, `noun-registry.js`, etc. → `app/cmd/`
2. Backend glue (global shortcut registration, window creation) → `backend/electron/cmd-glue.ts`
3. Remove `features/cmd/manifest.json`
4. Drop `cmd` from `CONSOLIDATED_EXTENSION_IDS` and `EAGER_EXTENSION_IDS`
5. Update startup: `loadCmdPanel()` in main.ts calls into `cmd-glue.ts` to create the panel window
6. Verify all tile features still get their commands registered and invoked

### Phase 2: hud
1. `features/hud/` → `app/hud/`
2. Backend glue (window creation with special properties, focus handling) → `backend/electron/hud-glue.ts`
3. Remove manifest, drop from CONSOLIDATED/EAGER lists
4. Startup calls `initHud()` from hud-glue

### Phase 3: page
Trickiest because of frozen canvas architecture (see CLAUDE.md). Move UI to `./app/page/` (some already there). Backend glue for URL rewriting and webview protocol setup. Careful not to break the fullscreen transparent canvas model.

## Tiles runtime cross-backend

Also flagged for future work, not part of this extraction:

- The tiles runtime (tile-launcher, tile-preload, tile-csp, tile-ipc, tile-tokens) is currently Electron-specific
- To run tile-based features on Tauri: build equivalent modules under `backend/tauri/`
- Document the tile runtime as a cross-backend contract — what any backend MUST provide
- Treat Electron impl as one of N backends

Not blocking core extraction. Important once mobile tiles become a real requirement.

## Sequencing

This extraction happens AFTER all remaining features are converted to tiles. Rationale:
- cmd/page/hud work fine as v1 features today — no urgency
- Converting other features has momentum
- With all other features as tiles, cmd/page/hud are the only v1 left — a focused, clean refactor

Near-term tile conversions (example, pagewidgets-sample, entities, tag-actions, pagestream, groups, lex, search, editor) proceed first.
