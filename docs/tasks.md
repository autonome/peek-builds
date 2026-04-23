# Peek Task Queue

Cross-session task list. Updated during Claude Code sessions, persisted via jj. When starting a session, scan this file for `[ ]` items and TaskCreate the relevant ones into the session.

Format: `[ ]` pending · `[>]` in-progress in some session · `[x]` done (can be pruned periodically)

Long-term replacement: once the tiles runtime ships with MCP server, this file becomes obsolete — tasks live as tagged items in Peek.

---

## Current priority (drop everything)

- [ ] **Message-passing / pubsub state machine.** Cmd dispatch + pubsub + tile lifecycle have too many intersecting paths; Phase E/F surfaced three different manifestations of the same class of bug (see below). Write a formal state machine describing every legal transition: who can publish what topic from what source in what tile-state, who can subscribe to what, how results return, how lazy tiles mount. Runtime enforcement + bisectable tests derive from the machine. Goal: the "lost publish somewhere in the fabric" class of bug becomes impossible — if a message is dropped, the machine tells us exactly which transition was invalid. Explicit user directive 2026-04-23: "we're going to drop everything and write a state machine for the message passing and pubsub, so never have to worry about this again." Pre-requisite for tasks below.

- [ ] **Root-cause: only hello-world commands visible in cmd panel.** After Phases E/F, only hello-world's commands (`hello`, "hello world trace") appear in the cmd panel. Every other lazy tile's commands — tag, untag, kagi, google, ddg, lists, peeks, slides, and dozens more — are missing. Agent hypothesis: Phase E's `registerLazyTile()` publishes `cmd:register-batch` at boot before the cmd panel's core/background subscription lands. Do NOT band-aid; fix this only after the state machine is in place so the fix comes from the right abstraction. Manual test case: `yarn start`, open cmd panel, type a few characters, should see many matches — currently only sees hello-world's.

- [x] **Consolidate command-result paths into one.** DONE 2026-04-23 as Phase 3 of pubsub-state-machine.md. The `tile:command:result` side-channel (preload send site + main-process unrestricted `publish()` handler) is gone; all command results now flow through the capability-gated `tile:pubsub:publish` of `cmd:execute:{name}:result:{uuid}` via the infra carve-out (commit `f32063db`).

- [ ] **UI-level tests for cmd-panel repeat invocation.** The 2026-04-23 repro (`tests/desktop/cmd-execute-twice.spec.ts`) fires on the pubsub bus directly and passes 3/3. Manual testing caught a 3rd-invocation stall that the bus test misses — the difference must be panel UI state (`state.executionTimeout`, `urlSearchTimer`, command subscription lifetime) leaking across repeats. Add Playwright tests that drive Cmd+K → type → Enter 3-5x in a row and assert panel closes + no spinner.

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
- [ ] **`target=_blank` download popup window not cleaned up.** `tests/desktop/download.spec.ts:151` expects `windowCountAfter ≤ windowCountBefore` after a download triggered through a popup-spawning link closes its popup. Consistently fails with one extra window remaining (off-by-one, 37 vs ≤36). 2026-04-20 session investigation: the existing `will-download` handler in `backend/electron/session-partition.ts` already has popup-closing logic (branch 3: webview guest in popup window opened for a download URL). Adding a file-based diagnostic at the top of `ses.on('will-download', ...)` showed the handler NEVER fires in this test. Suspects: (a) the popup's canvas webview uses a session partition different from `profileSession` (where the handler is registered — session-partition.ts:58), so will-download fires on the other session with no handler attached; or (b) Chromium takes a different code path for popup-scoped downloads that skips will-download on the parent session. Next concrete investigation: grep for all `session.fromPartition` call sites that could be attached to a popup webview, and either register the download handler on ALL of them OR find the single partition the popup uses.
- [ ] **Test ordering flake: `tags page widget updates dynamically when tag is added via command` (smoke.spec.ts:2010).** Passes in isolation. Fails only in the full `yarn test:electron` suite after ~148 tests. 2026-04-20 session attempted a fix (commit 4d3f6cc7) that gives test 2010 its own unique URL + key, closing the shared `cmd-exec-test-page` window and reopening a clean one for just this test, then restoring the shared window in `finally`. The Command Execution describe now passes 8/8 in isolation, and the test completes in 2.8s rather than 41ms (real work now happens). But **the flake still reproduces in the full suite** — 235 passing + tag widget still failing at 12.8s. Root cause not state on the shared window, then. Possible alternatives: (a) a non-window GLOBAL subscriber state leak from a much earlier test in some other describe block (audit all `api.subscribe` calls not scoped to `pageWindow`); (b) datastore items/tags from earlier tests pollute `loadAllTags()` or item queries in a way that breaks the assertion; (c) page.js at module-level installs a listener that persists across window reopens. Next investigation: run the failing test alongside its preceding test (the one that most recently opened a page window) via a cooperative grep pattern to narrow the triggering test.
- [ ] **Test ordering flake: Page Layout Maximize `maximize command fills work area` (page-layout.spec.ts:407).** Passes in isolation (583ms). Fails in full suite at 15.1s (timeout). Surfaced 2026-04-20 run; not historically present. May be a new flake introduced by recent changes or a latent flake that only shows under specific suite ordering. Needs its own investigation, unrelated to the tag widget flake.
- [ ] **Settings window not populating content** (post pubsub-FSM rollout 2026-04-23). Window opens at `peek://app/settings/settings.html`, URL loads in page-host, but sidebarNav + contentArea stay empty. No `gate:rejected` events in main stderr. No renderer errors forwarded. Silent failure — settings' `await api.initialize()` probably hangs or `createDatastoreStore('core', ...)` returns empty. Possibly related: `api.window.focus is not a function` error in core:background (caught by try/catch — separate symptom, see next task). Root cause needs DevTools console on the settings window. First investigation: add temp `console.error` at each `await` in settings.js `init()` to see where it hangs, OR add logging in tile-preload.cts around `validationPromise` resolution. Hit 2026-04-23 during pubsub FSM verification; blocked mid-debug.
- [ ] **`api.window.focus` / `.blur` / `.move` missing from tile-preload surface** but called by `app/windows.js:98-100` (windowController returned from `createWindow`) and `app/cmd/panel.js:2390`. Calls throw `TypeError: api.window.focus is not a function`. In settings' case the throw is caught in `openSettingsWindow` try/catch and logged as `[core] Failed to open settings window: …` — doesn't block window open. Fix: add these methods to tile-preload's `api.window` backed by a `tile:window:focus` / `:blur` / `:move` handler through `registerTileIpc`. Or remove them from `windows.js` / `panel.js` if the calls weren't load-bearing (investigate first). Unknown when this regressed — user reports multi-instance + settings worked about a year ago; may have surfaced post-Phase-8 chokepoint.
- [ ] **Almost all features listed in settings are missing their options.** Settings sidebar shows features, but opening most of them reveals no options/controls. Only a handful render their settings UI correctly. Unknown when this regressed — possibly related to the broader settings-window-empty issue above, or a schema-driven renderer gap. Investigation: open settings, note which features DO show options vs don't, compare their `settings-schema.json` shape + how they register into the settings UI.
- [ ] **Regression: `yarn start` with `PROFILE=X` no longer runs alongside packaged Peek.** Multi-instance (prod + dev on different PROFILEs) worked "for about a year" per user. Now `yarn start` exits with `APP INSTANCE ALREADY RUNNING, QUITTING` — `app.requestSingleInstanceLock()` returns false even with distinct PROFILE env. Root cause candidate: on macOS the lock is keyed by app bundle identity (not userData path), and packaged + dev share the same Electron bundle id. Hit 2026-04-23 blocking dev verification against a running prod session. Investigation: `git log -p backend/electron/main.ts` around `requestSingleInstanceLock` to find when the gating changed — likely used to have `if (app.isPackaged) app.requestSingleInstanceLock(...)` or a PROFILE-aware bypass. Fix: either gate the lock call on packaged builds only, or set a distinct bundle id for non-packaged runs.
- [x] **Playwright suite baseline after pubsub-FSM conversion: green 2026-04-23.** 208 passed / 11 skipped / 0 failed (desktop 1.1m + serial 10.7s). First post-P8 rerun surfaced 30 failures in clusters (HUD, page-layout, localsearch, page-navbar, cmd-palette edit); HUD was disabled (10 skipped) and the remaining 19 were all `api.scopes.GLOBAL` refs in 4 test files commit 66419c28 had missed (page-layout.spec.ts, localsearch.spec.ts, page-navbar.spec.ts, cmd-palette.spec.ts). Migrated with `perl -i -0pe 's/,\s*\(window as any\)\.app\.scopes\.GLOBAL//g'` across those + the two already-skipped files (hud, groups-context) for future re-enable.
- [x] **HUD disabled 2026-04-23.** Feature unused; failing tests blocking baseline. Disabled by commenting out `initHud()` import + call in `app/index.js:10,604`. Skipped `HUD Extension @desktop` describe in `tests/desktop/hud.spec.ts:96` and the single HUD test at `tests/desktop/groups-context.spec.ts:336`. App-focus hide/show handlers in `backend/electron/main.ts` left in place (no-op when no HUD window exists). Re-enable: uncomment in `app/index.js`, un-skip both tests (scopes refs already migrated).

---

## Test infrastructure

- [ ] **Move OS-integration-fragile tests to a non-parallel suite.** Under `fullyParallel: true` + `workers > 1`, tests that drive modal cmd panels with OS-level focus/blur dependencies are flaky. Confirmed examples: most of `tests/desktop/cmd-state-machine.spec.ts` (`Escape layering…`, `URL opening…`) and `smoke.spec.ts` Type-Specific Noun Commands describe (`new note with content saves to datastore`, `new note without content signals editor open`). Add a second Playwright project in `playwright.config.ts` matching `tests/desktop-serial/` with `workers: 1, fullyParallel: false`. Move the fragile tests. Also refine the `isTestProfile()` gate in `backend/electron/ipc.ts:2373` that currently disables modal close-on-blur in all test profiles — the serial suite may want to exercise that behavior.

---

## Features

- [x] **Commands for browser-extension options pages.** Registered `<name> options` command per installed Chromium extension that declares `options_page`/`options_ui.page`.
- [x] **Bundle TWP (Translate Web Pages) as a default browser extension.** TWP v10.1.1.0 vendored at `chrome-extensions/twp/` (~2.1MB). Auto-loads on startup.
- [ ] **Restore bundled-extension links in page host widget.** Regression — at some point we lost the affordance where each bundled Chromium extension (TWP, Proton Pass, etc.) surfaced links in the page host widget to open its popup / options page / extension UI directly from the page canvas. Commands for options pages still exist (see above) but the in-widget links are gone. Investigate when this was lost (git log on the page widget / extension-host widget), restore the UI, and confirm it works for all bundled extensions.

---

## Deferred from audits / fixes

### Atproto install flow hardening (from atproto pipeline audit, 2026-04-16)
- [x] CID validation on downloaded bundle blobs
- [x] Atomic install with rollback on partial failure (temp dir + rename)
- [x] `minPeekVersion` enforcement on install
- [x] Icon/screenshot blob handling in publish.js
- [ ] **Verify atproto record signatures.** (Gap found 2026-04-20.) `backend/electron/atproto-source.ts:356` fetches the release record via `com.atproto.repo.getRecord` and accepts the response with no signature check. A compromised or malicious PDS can forge a record with CIDs pointing at tampered bundle blobs, and `verifyBlobCid()` (line 502) will happily validate those tampered bytes against the forged CIDs. Current trust boundary is TLS to the PDS, not the publisher's signing key. Full design and step-by-step plan (commit-level signature, MST inclusion, `@atproto/crypto`, PLC key-rotation handling, icon/screenshot gap) in [atproto-signature-verification-plan.md](atproto-signature-verification-plan.md). ~3 days.

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
- [x] cmd → `app/cmd/` → consolidated into core background renderer (2026-04-21)
- [x] hud → `app/hud/` → consolidated into core background renderer (2026-04-21)
- [x] page → `app/page/` → consolidated into core background renderer (2026-04-21)

All three command-registration surfaces now run inside the core
background renderer (`app/index.js` awaits `initCmd()`, `initPage()`,
`initHud()`). No separate resident BrowserWindows; `cmd-glue.ts`,
`page-glue.ts`, and `hud-glue.ts` are deleted. The page-canvas and
HUD overlay windows still exist — only the *command-registering*
resident renderers were merged.

---

## Pruned / completed log

Keep short — for recent context only. Prune after a few weeks.

- 2026-04-21 cmd / page / hud resident renderers consolidated into the core background renderer (`app/index.js` → `initCmd/initPage/initHud`). `cmd-glue.ts`, `page-glue.ts`, `hud-glue.ts`, and the three resident shim HTMLs deleted. cmd command registry, page `open`/`modal`, HUD `hud` command + CmdOrCtrl+H shortcut all run inside the single core renderer now.
- 2026-04-21 fixed cmd `ext:ready` / extension-commands race — `registerExtensionCommands()` was hung on an `ext:all-loaded` subscriber that was wired AFTER `topicCorePrefs` publish kicked off `loadExtensions()` in main, so the GLOBAL publish was dropped. Subscribe now lands before the publish; registry grows 72→96 commands on cold start (quit/restart/back/forward/reload/settings/theme-* etc. now register reliably).
- 2026-04-21 fixed Electron 40 console-message forwarder in `core-glue.ts` — event `level` is a string literal in E40, not an int, so the numeric filter dropped all renderer output.
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
