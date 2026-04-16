# Peek Task Queue

Cross-session task list. Updated during Claude Code sessions, persisted via jj. When starting a session, scan this file for `[ ]` items and TaskCreate the relevant ones into the session.

Format: `[ ]` pending · `[>]` in-progress in some session · `[x]` done (can be pruned periodically)

Long-term replacement: once the tiles runtime ships with MCP server, this file becomes obsolete — tasks live as tagged items in Peek.

---

## Bugs

- [ ] **post.nl → postnl.nl redirect shows blank page.** Navigating to post.nl (which server-redirects to postnl.nl) leaves Peek on a blank white page instead of following the redirect. Likely a webview/canvas redirect handling issue. Reproduce: open post.nl in a page window.

---

## Deferred from audits / fixes

### Atproto install flow hardening (from atproto pipeline audit, 2026-04-16)
- [ ] CID validation on downloaded bundle blobs (currently no integrity check)
- [ ] Atomic install with rollback on partial failure (currently leaves corrupted state)
- [ ] `minPeekVersion` enforcement on install (lexicon field defined but ignored)
- [ ] Icon/screenshot blob handling in publish.js (lexicon supports, wizard doesn't)

### Pubsub audit follow-ups (2026-04-16)
- [x] Missing tag lifecycle events: `tag:created`, `tag:renamed`, `tag:deleted` (groups can't react to tag ops; orphaned groups when tag deleted) — emitted from `datastore.ts` so every caller (legacy ipc handlers, strict `tile:datastore:*` handlers, direct imports) fires the event
- [ ] 7 bare `tagItem()` calls bypass events (incidental fix during trimming Phase 3 sweep; locations in pubsub audit)

### Security audit follow-ups (2026-04-16)
- [ ] CSP gaps on error responses (404/500/redirects don't get CSP headers) — `protocol.ts:557`

### Settings audit follow-ups (2026-04-16)
- [ ] Backend defaults enforcement (`api.settings.get()` returns null if key never set, ignores manifest `defaults`)
- [ ] JSON Schema validation for settings-schema.json files (currently loaded but not validated)
- [ ] Dedicated settings isolation / defaults / UI tests (only migration tests exist)

---

## Planned major work

### Tiles v1-compat trimming (from `docs/tile-preload-trimming-plan.md`)
- [x] Phase 1 — inventory + capability-violation logger
- [ ] Phase 2 — build strict APIs alongside shims (3-5 days)
- [ ] Phase 3 — per-feature migration in 3 complexity rounds (2-4 weeks)
- [ ] Phase 4 — remove shims + hard-fail stubs (1-2 days)
- [ ] Phase 5 — strict-mode env flag + generated typings (ongoing)

### Features-manager atproto plan phases (from `features/features-manager/PLAN.md`)
- [ ] Phase 7 — polish + indexing (curated directory, relay/indexer service as separate repo)

### Core extraction (from `docs/core-extraction-plan.md`)
- [x] cmd → `app/cmd/`
- [ ] hud → `app/hud/` + `backend/electron/hud-glue.ts`
- [ ] page → `app/page/` (FROZEN canvas architecture — needs design first)

### Feature conversion holdouts
- [ ] Remaining v1 features: cmd (extracted), hud (pending extraction), page (pending design)

---

## Pruned / completed log

Keep short — for recent context only. Prune after a few weeks.

- 2026-04-16 Tag lifecycle pubsub events (datastore.ts emits tag:created/renamed/deleted/color-changed for all callers)
- 2026-04-16 Observability fixes (console forwarding, crash detection, DevTools IPC, global error handlers)
- 2026-04-16 Tile lifecycle fixes (shutdown signal, unsubscribe-on-close, disable/remove unload, listener dedup, crashed scope→GLOBAL)
- 2026-04-16 6 parallel audits (lifecycle, atproto, pubsub chains, observability, security, settings)
- 2026-04-16 Datastore scoping enforcement (18 `tile:datastore:*` handlers with per-table capability checks)
- 2026-04-16 Trimming Phase 1 (audit script + matrix + violation logger)
- 2026-04-15 Initial cmd extraction + tiles migration to v2 + features-manager phases 1-6
