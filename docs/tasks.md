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
  - **Missing strict surfaces (gap fill complete)**:
    - [x] `api.window.exists/show/hide/setIgnoreMouseEvents` — gated by `window.manage`
    - [x] `api.window.center/centerAll/maximize/fullscreen/setOverlayFocusTarget/setVisibleOnAllWorkspaces` — gated by `window.manage`; `getFocusedVisibleWindowId` gated by `window.query`
    - [x] `api.window.exists` return shape now supports both `{exists}` and `{success, data}` destructure styles
    - [x] `api.window.close` fire-and-forget documented in tile-preload.ts
    - [x] `api.escape.onEscape` — no capability gate (UX primitive)
    - [x] `api.commands.unregister` — gated by existing `commands` capability
    - [x] `api.screen.getPrimaryDisplay` — no cap (read-only info)
    - [x] `api.session.saveSpaceWorkspaces` — new `session` capability
    - [x] `api.settings.getExtKey` — new `settings.readForeign` allowlist (or top-level `settingsForeign` fallback)
    - [x] `api.oauth.startLoopback/awaitCallback` — new `oauth` capability with optional providers allowlist
    - [x] `api.sync.syncAll` — new `sync` capability (builtin-only)
    - [x] `api.izui.*` — new `izui` capability
    - [x] `api.datastore.extractPageContent` — under existing `datastore` capability
    - [x] `api.features.*` admin: update/dev/publish/devtools/browse actions (extends `FeaturesCapability`); features-manager `api.ipc.invoke` call sites migrated to `api.features.*`
  - **Still open (lower priority / defer to Phase 4 decisions)**:
    - [ ] `api.scopes.SYSTEM` semantic in tile-preload (currently undefined → defaults to SELF). Affects lifecycle events.
    - [ ] Settings response shape audit: `{value, error}` strict vs `{success, data}` callers — peeks, slides, wonderwall use v1 shape
    - [ ] `api.context.setMode`/`getWindowsInSpace` are aliases over already-strict set+modes/queryWindows — not wrapped explicitly
    - [ ] Cross-tile `api.settings.getExtKey('lex', 'session')` in features-manager can also use the new `settings.readForeign` path; or implement `lex:get-session` pubsub request/response (TBD)
- [ ] Phase 3 — per-feature migration in 3 complexity rounds (2-4 weeks)
  - [x] Round 1 (trivial): sync, widget-demo, helpdocs, websearch, mcp-server, dropzone, timers
  - [x] Round 2 (moderate): tag-actions, peeks, lists, pagestream, slides, scripts, windows, feeds, search, tags, sheets, example
  - [x] Round 3 (complex): entities, spaces, groups, editor, lex, wonderwall, features-manager
  - **Phase 3 complete** — all 26 features migrated to strict capability-gated calls; v2 shim blocks dropped from v2 paths; v1 legacy fallback branches preserved pending Phase 4 shim removal
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

- 2026-04-16 Trimming Phase 3 gap-fill: new capabilities (escape/session/izui/oauth/sync/settings.readForeign); extended window ops; features admin; extract-page-content (2164 tests passing)
- 2026-04-16 Trimming Phase 3 closed: all 26 features migrated to strict capabilities
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
