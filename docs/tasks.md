# Peek Task Queue

Cross-session task list. Updated during Claude Code sessions, persisted via jj. When starting a session, scan this file for `[ ]` items and TaskCreate the relevant ones into the session.

Format: `[ ]` pending · `[>]` in-progress in some session · `[x]` done (can be pruned periodically)

Long-term replacement: once the tiles runtime ships with MCP server, this file becomes obsolete — tasks live as tagged items in Peek.

---

## Bugs

- [ ] **post.nl → postnl.nl redirect shows blank page.** Navigating to post.nl (which server-redirects to postnl.nl) leaves Peek on a blank white page instead of following the redirect. Likely a webview/canvas redirect handling issue. Reproduce: open post.nl in a page window.
- [ ] **Proton Pass extension doesn't autofill.** Still broken — doesn't show up in form fields, no autofill suggestions. Likely a content-script injection or messaging API gap in the webview/canvas setup. Reproduce: install Proton Pass extension, navigate to any login page, observe no inline autofill UI.
- [ ] **Download save failing.** Saving a download fails when the target filename already exists. Two possible causes to investigate: (a) need to auto-iterate filenames — `download.jpg` → `download-1.jpg`, `download-2.jpg`, etc., with iterator before the extension; OR (b) the failure is actually in the post-download step that opens the file's local filesystem location (redirect to localfs), not the save itself. Repro and isolate before fixing.

---

## Features

- [x] **Commands for browser-extension options pages.** Registered `<name> options` command per installed Chromium extension that declares `options_page`/`options_ui.page`.
- [x] **Bundle TWP (Translate Web Pages) as a default browser extension.** TWP v10.1.1.0 vendored at `chrome-extensions/twp/` (~2.1MB). Auto-loads on startup.

---

## Deferred from audits / fixes

### Atproto install flow hardening (from atproto pipeline audit, 2026-04-16)
- [x] CID validation on downloaded bundle blobs
- [x] Atomic install with rollback on partial failure (temp dir + rename)
- [x] `minPeekVersion` enforcement on install
- [x] Icon/screenshot blob handling in publish.js

### Pubsub audit follow-ups (2026-04-16)
- [x] Missing tag lifecycle events: `tag:created`, `tag:renamed`, `tag:deleted`
- [x] Bare `tagItem()` bypasses — 5 of 7 converted (sync + 2 ipc handlers + 2 in datastore.ts); 1 in `tile-ipc.ts` already publishes manually

### Security audit follow-ups (2026-04-16)
- [x] CSP gaps on error responses — catch-block fallback now applies CSP for tile origins

### Settings audit follow-ups (2026-04-16)
- [x] Backend defaults enforcement
- [x] JSON Schema validation for settings-schema.json files
- [x] Settings isolation + defaults test coverage (UI render intentionally skipped — no schema-driven renderer exists)

---

## Planned major work

### Tiles v1-compat trimming (from `docs/tile-preload-trimming-plan.md`)
- [x] Phase 1 — inventory + capability-violation logger
- [ ] Phase 2 — build strict APIs alongside shims (3-5 days)
  - [x] Phase 2.3 — strict shortcuts IPC + keys allowlist
  - [x] Phase 2 — strict context IPC + read/write/modes/queryWindows allowlists
  - [x] Phase 2 — strict dialogs IPC + types allowlist
  - [x] Phase 2 — settings cleanup (audit found every shim still has callers; deferred to Phase 3 or `settings.readForeign` capability work)
  - [x] Phase 2 — strict window IPC + create/query/manage/urls allowlist
  - [x] Phase 2 — strict features IPC + read/install/manage/sources allowlist
  - **Phase 2 complete** — all strict IPC surfaces landed; next is Phase 3 per-feature migration
  - [ ] Missing `api.sync.*` surface (discovered during sync migration; feature declares `sync: true` cap but tile-preload has no strict routing for it; `background.js` guards the call)
  - [x] Missing `api.window.exists/show/hide/setIgnoreMouseEvents` surface — strict handlers added, gated by `window.manage`
  - [ ] Missing `api.escape.onEscape` surface in tile-preload.ts (used by tags, entities, search, lex, lists). Current convention: `if (api.escape)` guard — works only with v1 preload.
  - [ ] Missing `api.scopes.SYSTEM` in tile-preload.ts (only SELF=2 and GLOBAL=3 exposed). `api.scopes.SYSTEM` silently evaluates to `undefined` which publishImpl defaults to SELF — semantic drift for lifecycle events like `ext:ready`, `app:shutdown`.
  - [ ] Settings response shape: strict path returns `{value, error}` but several features destructure `{success, data}` (v1 shape). Preload may wrap back, but needs audit. Found in peeks so far.
  - [ ] `api.window.close` in strict path is fire-and-forget `ipcRenderer.send` (no promise). Document this; any existing `.catch()` chains need try/catch instead. Discovered in slides migration.
  - [ ] Missing strict surfaces: `api.window.center/centerAll/maximize/fullscreen/getFocusedVisibleWindowId/setOverlayFocusTarget`, `api.izui.*`, `api.escape.*`. Used by `windows` feature and others; currently fall back to legacy preload in separate BrowserWindows.
  - [ ] Missing `api.oauth.startLoopback/awaitCallback` surface in tile-preload (used by wonderwall). Needs an `oauth` capability + strict tile IPC before v1 shim removal — wonderwall will break otherwise.
  - [ ] Missing `api.datastore.extractPageContent` surface in tile-preload (used by entities). Feature-specific helper; needs strict routing or extraction to a different capability.
  - [ ] Missing `api.commands.unregister` in tile-preload (only `register` exposed). Used by entities and others for cleanup.
  - [ ] Missing `api.screen.getPrimaryDisplay`, `api.window.setVisibleOnAllWorkspaces`, `api.context.setMode` (setMode is an alias over set+modes cap but not wrapped), `api.context.getWindowsInSpace` (alias over queryWindows), `api.session.saveSpaceWorkspaces`. Discovered in spaces migration.
- [ ] Phase 3 — per-feature migration in 3 complexity rounds (2-4 weeks)
  - [x] Round 1 (trivial): sync, widget-demo, helpdocs, websearch, mcp-server, dropzone, timers
  - [x] Round 2 (moderate): tag-actions, peeks, lists, pagestream, slides, scripts, windows, feeds, search, tags, sheets, example
  - [ ] Round 3 (complex): entities, spaces, groups, editor, lex, wonderwall, features-manager (hud is already core, not v1)
- [ ] Phase 4 — remove shims + hard-fail stubs (1-2 days)
- [ ] Phase 5 — strict-mode env flag + generated typings (ongoing)

### Features-manager atproto plan phases (from `features/features-manager/PLAN.md`)
- [ ] Phase 7 — polish + indexing (curated directory, relay/indexer service as separate repo)

### Core extraction (from `docs/core-extraction-plan.md`)
- [x] cmd → `app/cmd/`
- [x] hud → `app/hud/` + `backend/electron/hud-glue.ts`
- [ ] page → `app/page/` (FROZEN canvas architecture — needs design first)

### Feature conversion holdouts
- [ ] Remaining v1 features: page (pending design)

---

## Pruned / completed log

Keep short — for recent context only. Prune after a few weeks.

- 2026-04-16 Trimming Phase 2 closed: strict window + features IPC + settings-cleanup audit (2065 tests passing)
- 2026-04-16 Bundled TWP translate extension (chrome-extensions/twp/) + commands for all installed browser extensions with options pages
- 2026-04-16 Strict `tile:context:*` + `tile:dialogs:*` IPC with allowlists (trimming Phase 2)
- 2026-04-16 Settings isolation + defaults test coverage (34 new tests)
- 2026-04-16 Datastore `tagItem` pubsub fix (syncContentHashtags + history auto-tag)
- 2026-04-16 Scripts: `/tmp/mpeek-agent-name` fallback to avoid per-name permission prompts
- 2026-04-16 HUD extraction to `app/hud/` + `hud-glue.ts` (mirrors cmd extraction)
- 2026-04-16 Atproto install hardening (CID + atomic + minPeekVersion); publish wizard icon/screenshot upload
- 2026-04-16 Settings backend defaults + schema-validation on load
- 2026-04-16 Strict `tile:shortcuts:*` IPC with keys allowlist (trimming Phase 2.3)
- 2026-04-16 Tag pubsub gap fixes: sync.ts + 2 ipc handlers now use `tagItemAndPublish`
- 2026-04-16 CSP on protocol.ts error fallback for tile origins
- 2026-04-16 Tag lifecycle pubsub events (datastore.ts emits tag:created/renamed/deleted/color-changed for all callers)
- 2026-04-16 Observability fixes (console forwarding, crash detection, DevTools IPC, global error handlers)
- 2026-04-16 Tile lifecycle fixes (shutdown signal, unsubscribe-on-close, disable/remove unload, listener dedup, crashed scope→GLOBAL)
- 2026-04-16 6 parallel audits (lifecycle, atproto, pubsub chains, observability, security, settings)
- 2026-04-16 Datastore scoping enforcement (18 `tile:datastore:*` handlers with per-table capability checks)
- 2026-04-16 Trimming Phase 1 (audit script + matrix + violation logger)
- 2026-04-15 Initial cmd extraction + tiles migration to v2 + features-manager phases 1-6
