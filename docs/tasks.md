# Peek Task Queue

Cross-session task list. Updated during Claude Code sessions, persisted via jj. When starting a session, scan this file for `[ ]` items and TaskCreate the relevant ones into the session.

Format: `[ ]` pending · `[>]` in-progress in some session · `[x]` done (can be pruned periodically)

Long-term replacement: once the tiles runtime ships with MCP server, this file becomes obsolete — tasks live as tagged items in Peek.

---

## Bugs

- [ ] **post.nl → postnl.nl redirect shows blank page.** Navigating to post.nl (which server-redirects to postnl.nl) leaves Peek on a blank white page instead of following the redirect. Likely a webview/canvas redirect handling issue. Reproduce: open post.nl in a page window.
- [ ] **Proton Pass extension doesn't autofill.** Still broken — doesn't show up in form fields, no autofill suggestions. Likely a content-script injection or messaging API gap in the webview/canvas setup. Reproduce: install Proton Pass extension, navigate to any login page, observe no inline autofill UI.

---

## Features

- [ ] **Commands for browser-extension options pages.** For each installed Chromium extension that declares an `options_page` (or `options_ui`) in its manifest, auto-register a command like `<extension-name> options` that opens that page directly. Scope: browser extensions only (not Peek v2 tiles / v1 features). Requires iterating installed extensions, reading their manifest, registering into the command registry.
- [ ] **Bundle TWP (Translate Web Pages) as a default browser extension.** Ship TWP alongside other bundled browser extensions so users get page translation out of the box. Extension homepage: https://github.com/FilipePS/Traduzir-paginas-web

---

## Deferred from audits / fixes

### Atproto install flow hardening (from atproto pipeline audit, 2026-04-16)
- [x] CID validation on downloaded bundle blobs
- [x] Atomic install with rollback on partial failure (temp dir + rename)
- [x] `minPeekVersion` enforcement on install
- [x] Icon/screenshot blob handling in publish.js

### Pubsub audit follow-ups (2026-04-16)
- [x] Missing tag lifecycle events: `tag:created`, `tag:renamed`, `tag:deleted`
- [x] Bare `tagItem()` bypasses — 3 of 7 converted (sync + 2 ipc handlers); 2 in `datastore.ts` kept bare pending dedicated pass; 1 in `tile-ipc.ts` already publishes manually

### Security audit follow-ups (2026-04-16)
- [x] CSP gaps on error responses — catch-block fallback now applies CSP for tile origins

### Settings audit follow-ups (2026-04-16)
- [x] Backend defaults enforcement
- [x] JSON Schema validation for settings-schema.json files
- [ ] Dedicated settings isolation / defaults / UI tests (only migration tests exist)

---

## Planned major work

### Tiles v1-compat trimming (from `docs/tile-preload-trimming-plan.md`)
- [x] Phase 1 — inventory + capability-violation logger
- [ ] Phase 2 — build strict APIs alongside shims (3-5 days)
  - [x] Phase 2.3 — strict shortcuts IPC + keys allowlist
  - [ ] Remaining: context capability, window strict extensions, features strict, dialogs, settings cleanup
- [ ] Phase 3 — per-feature migration in 3 complexity rounds (2-4 weeks)
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
