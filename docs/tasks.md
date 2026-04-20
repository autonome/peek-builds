# Peek Task Queue

Cross-session task list. Updated during Claude Code sessions, persisted via jj. When starting a session, scan this file for `[ ]` items and TaskCreate the relevant ones into the session.

Format: `[ ]` pending · `[>]` in-progress in some session · `[x]` done (can be pruned periodically)

Long-term replacement: once the tiles runtime ships with MCP server, this file becomes obsolete — tasks live as tagged items in Peek.

---

## Tile architecture cleanup (post-conversion)

- [ ] **Merge websearch's separate background tile into the home window.** Manifest has two tile entries: `background.html` (lazy:true) for settings/engine state, `home.html` for the UI. They communicate via pubsub round-trips (`websearch:engine-request` → `websearch:engines-list`) across `peek://ext/websearch/background.html` vs `peek://websearch/home.html`. Cross-window pubsub within one feature is fragile (see 2026-04-20 session — broadcaster echo-prevention bug + cluster 3 regression risk). The round-trip also blocks 3 websearch tests from passing. With the single-file tiles model shipping (`resident: true`), websearch can collapse to one tile whose home window owns both UI and engine state directly. No IPC needed. Applies also to any feature tile with a bg + window pair that pubsubs between itself — audit other candidates.
- [ ] **Remove v1 entirely.** Single source of truth: every renderer runs through `tile-preload.cts` against `tile:*` IPC. No more consolidated extension host iframes, no more legacy IPC channels, no more dual paths in tile-preload. See [v1-removal-plan.md](v1-removal-plan.md). This is the root fix for the v2→v1 routing flakies (kagi/tag/widget-update tests, ~10 tests blocked) — the boundary disappears, the bugs disappear with it. Phased: (1) cmd/hud/page core scripts → tile-preload, (2) test fixture → tile-preload, (3) delete v1 plumbing, (4) manifest cleanup. ~5–6 days.
- [x] **Single-file tiles as default model.** Shipped 2026-04-17: `resident: true` marker + flat window fields on TileEntry, `api.window.showSelf/hideSelf` (token-scoped, no capability), hello-world/widget-demo/mcp-server converted. Plan: `docs/tiles-single-file.md`.
- [ ] **Theme live-reload in open tiles.** When the user switches theme, tiles that are already open don't pick up the new `peek://theme/variables.css`. The import is resolved once at tile load. `api.theme.onChange` hook exists but nothing re-imports the stylesheet. Fix: on theme change, have tiles re-resolve `peek://theme/variables.css` (e.g. bump a cache-busting query string on a `<link>` element, or replace the adopted stylesheet). Alternatively, inject theme vars via a mutable `<style>` block that the preload updates on theme change.

---

## Bugs

- [x] **post.nl → postnl.nl redirect shows blank page.** Fixed 2026-04-17 commit `5dfa3e7a` — `did-redirect-navigation` listener in `app/page/page.js` updates `latestNavigationUrl` so the did-fail-load(-3) handler doesn't abort the redirect target mid-load.
- [ ] **v2 tile `cmd:execute:<name>:result` doesn't reach v1 extension-host subscribers.** (Will be obsolete after v1 removal — see [v1-removal-plan.md](v1-removal-plan.md). Documented here in case a quick patch is desired before that lands.) Tests in `smoke.spec.ts` (Command Execution describe — tag/untag/tagset/widget-update tests, ~7 of them) publish `cmd:execute:tag` from bgWindow with `expectResult:true, resultTopic:'cmd:execute:tag:result'`, then subscribe to that result topic. The tags v2 tile receives the publish, runs `executeTag()`, and tile-preload sends `tile:pubsub:publish` with the result topic — BUT the bgWindow subscriber never fires. Confirmed: 2026-04-17 added `cmd:execute:*` to tags' pubsub allowlist (in `b3a80b27`) and `waitForCommand` in beforeAll (in `daa4221a`); both necessary but tests still time out at 10s. Per Opus agent triage: bgWindow is `peek://app/background.html`, NOT in `extensionHostWindow`/`extensionWindows`/`getAllTileWindows()` — `extensionBroadcaster` skips it. bgWindow subscribes via legacy `IPC_CHANNELS.SUBSCRIBE` (`ipc.ts:4466`); the in-proc callback should fire on `publish()` but doesn't. That's the next concrete investigation.
- [ ] **Proton Pass extension doesn't autofill.** Still broken — doesn't show up in form fields, no autofill suggestions. Likely a content-script injection or messaging API gap in the webview/canvas setup. Reproduce: install Proton Pass extension, navigate to any login page, observe no inline autofill UI. (2026-04-17: agent triaged, 5 hypotheses in agent-ae11e03d worktree — extension gitignored so couldn't repro.)
- [x] **Download save failing.** Fixed 2026-04-17 commit `ab66d9e0` — cause (a): `setSavePath()` with existing path silently fails. Added `resolveUniqueDownloadPath()` in `session-partition.ts` that appends `-1`, `-2`, etc. before the extension.
- [ ] **`target=_blank` download popup window not cleaned up.** `tests/desktop/download.spec.ts:151` expects `windowCountAfter ≤ windowCountBefore` after a download triggered through a popup-spawning link closes its popup. Consistently fails with one extra window remaining (off-by-one, 37 vs ≤36). Predates the 2026-04-20 pubsub/broadcaster work — full suite baseline had it failing too. Likely the download-handling path doesn't destroy the `about:blank` popup once the download redirects it out of existence. Investigation starting points: `backend/electron/session-partition.ts` (download handler), `backend/electron/ipc.ts` window-open handler for `target=_blank`, and whether `did-create-window` → download flow leaves the popup orphaned.
- [ ] **Test ordering flake: `tags page widget updates dynamically when tag is added via command` (smoke.spec.ts:2010).** Passes in isolation (`yarn test:grep "tags page widget updates dynamically"`). Fails only inside a full `yarn test:electron` run, when ~148 tests have run before it and the test file's shared-app state has accumulated. Probably a state-leak from one of the preceding Command Execution tests that opens/closes the same canvas page URL key (`cmd-exec-test-page`) — the beforeAll re-opens but the prior instance's subscribers may still be live. Diagnosis cost: 2026-04-20 session confirmed it reproduces only in full-suite context, not under any isolated test:grep pattern. Fix direction: audit `beforeAll`/`afterAll` in the Command Execution describe for key-reuse assumptions, or switch the test suite to a unique URL-key per test rather than a shared one.

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
    - [x] `api.scopes.SYSTEM` exposed in tile-preload
    - [x] Settings response shape: wrapped to return `{success, data, value, error}` dual shape
    - [x] `api.context.setMode`/`getMode`/`watchMode`/`getWindowsInSpace` aliases added
    - [x] `api.settings.getExtKey` routed through `settings.readForeign` with compat shape
- [ ] Phase 3 — per-feature migration in 3 complexity rounds (2-4 weeks)
  - [x] Round 1 (trivial): sync, widget-demo, helpdocs, websearch, mcp-server, dropzone, timers
  - [x] Round 2 (moderate): tag-actions, peeks, lists, pagestream, slides, scripts, windows, feeds, search, tags, sheets, example
  - [x] Round 3 (complex): entities, spaces, groups, editor, lex, wonderwall, features-manager
  - **Phase 3 complete** — all 26 features migrated to strict capability-gated calls; v2 shim blocks dropped from v2 paths; v1 legacy fallback branches preserved pending Phase 4 shim removal
- [x] Phase 4 — removed v1-compat shims + hard-fail stubs; deleted v1 else-branches in 22 feature HTMLs; 54 new stub tests; 5 runtime-breaking callers fixed (pagewidgets-sample, files, groups, tags, features-manager)
  - [x] **Datastore restoration** — Phase 4 over-reached and stubbed out the `api.datastore.*` named methods that every feature actually calls. Restored as legacy-channel routes (thin wrappers over `datastore-*` IPC in ipc.ts). The generic strict surface (`api.datastore.{get,set,query,extractPageContent}`) remains unchanged alongside it.
  - [x] Follow-up: all ~38 datastore methods now have strict `tile:datastore:*` handlers + preload routes through them
- [x] Phase 5 — TILE_STRICT env flag (throws on cap violations); tile:capability-violation pubsub topic with rate limiting; static tile-api.d.ts
  - **Tiles trimming COMPLETE** — all 5 phases done. Known follow-ups tracked above (missing strict datastore handlers, legacy routing cleanup) — not blocking.

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

- 2026-04-16 Trimming Phase 5 closed: TILE_STRICT env flag, capability-violation pubsub topic with rate limiting, static tile-api.d.ts
- 2026-04-16 Trimming Phase 4 datastore restoration: Phase 4 over-reached; named api.datastore.* methods restored as legacy routes (the strict surface remains)
- 2026-04-16 Trimming Phase 4 closed: v1-compat shims removed, hard-fail stubs in their place, v1 else-branches deleted from 22 feature HTMLs (2218 tests passing)
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
