# Peek Task Queue

Cross-session task list. Updated during Claude Code sessions, persisted via jj. When starting a session, scan this file for `[ ]` items and TaskCreate the relevant ones into the session.

Format: `[ ]` pending · `[>]` in-progress in some session · `[x]` done (can be pruned periodically)

Long-term replacement: once the tiles runtime ships with MCP server, this file becomes obsolete — tasks live as tagged items in Peek.

---

## Tile architecture cleanup

- [ ] **Collapse `tags` and `lists` bg+window pubsub round-trips.** Audit on 2026-04-27 found the websearch consolidation pattern still needs to be applied to two more features:
  - **tags** — 3 tiles (background lazy:true, home, plus search.js); background publishes `editor:changed`, `editor:add` to home.
  - **lists** — 2 tiles (background lazy:true, home); background↔home round-trip on `lists:settings-changed` / `lists:settings-update` for hotloading.
  - **editor**, **spaces** — minimal cross-tile pubsub (lifecycle / cmd registration only); deprioritize.
  - **sheets**, **feeds**, **search** — bg tile is pure lifecycle, no data round-trip; skip.
  Same approach as websearch: collapse to single resident tile, move state into home.js, delete background.{html,js}.

---

## Bugs

- [ ] **Server-not-found / page-load failure shows blank white page forever.** User-reported 2026-04-27 with `http://www.metikmusic.com/` (DNS resolves but server returns nothing useful, or DNS fails). The page-host webview just sits on white with no feedback. We should handle the full lifecycle of a failed page open: DNS failure, connection refused, TLS errors, HTTP 4xx/5xx, hung loads, ERR_NAME_NOT_RESOLVED, ERR_INTERNET_DISCONNECTED. Show a Peek-branded error UI inside the canvas with: the URL that failed, the underlying error reason, an obvious Retry button, and a "Go back" / "Close" affordance. Likely hooks: `did-fail-load` and `did-fail-provisional-load` on the webview's webContents in `app/page/page.js`, plus `certificate-error` on the session. Audit other entry points too (cmd web search, external URL handler, address bar) to ensure they all funnel into the same error UI.

- [ ] **Undo close window (cmd+shift+t) doesn't work a lot of the time.** User-reported 2026-04-27. The shortcut sometimes fails to reopen the most recently closed window. Needs repro + diagnosis: which window types is it failing for (canvas/page, cmd, hud, tile)? Is the closed-window stack being populated for all close paths (page-host close, tile:window:close, app-quit cleanup, accidental close vs hide)? Suspect interaction with `closeOrHideWindow`/`tile:lifecycle:visible` reuse — a hidden-then-shown window may be wrongly skipped from the undo stack, or the stack may be cleared on hide. Also check: does it work for the most recent close but not for the second-most-recent? Does the shortcut fire at all (verify `before-input-event`/accelerator binding) or does it fire and produce nothing? Start with `console.log` of the undo handler and the stack contents on close.

- [ ] **Tauri: rename `pubsub:ext:*` startup topics to `pubsub:feature:*`.** `backend/tauri/src-tauri/src/lib.rs` still emits `pubsub:ext:startup:phase` and `pubsub:ext:all-loaded`. Electron side renamed 2026-04-24; Tauri/mobile is on hold per the v1-removal plan, but track this so it lands when Tauri is unfrozen.
- [ ] **Migrate bootstrap IPC channels to tile:lifecycle:* namespace.** `session-restore-pending` and `frontend-ready` in `backend/electron/entry.ts` are bare `ipcMain.handle()` registrations from before the tile system initializes. They're only reachable from trustedBuiltin renderers via `api.invoke()`, so the security gap is theoretical, but they're the last bare main-process IPC handlers outside `tile-ipc-gate.ts`. Decision skipped 2026-04-24: leaving them bare for now since they exist *before* any tile loads — the indirection through tile-ipc-gate would require either bootstrapping the gate earlier or having two IPC modes (bootstrap vs. post-init). Worth revisiting if tile-ipc-gate ever gains a "no token required for these specific channels" mode, or if entry.ts gets folded into a tile lifecycle.
- [ ] **Page host window jumps to wrong position after switching primary monitor.** Repro: connect external monitor, set it primary; open page host (cmd+L); disconnect/swap so the laptop becomes primary; cmd+L again — the whole window shifts to a different (off-screen / wrong-display) position. Likely cause: `computeWindowBounds`/canvas positioning caches screen bounds at first compute or reads stale `screen.getPrimaryDisplay()`/`getDisplayNearestPoint` results across display topology changes. Fix path: subscribe to Electron's `screen` `display-added`/`display-removed`/`display-metrics-changed` events and recompute the page-host window's normal+maximized bounds against current displays before show; clamp restored positions to a visible display. Surfaced 2026-04-24.
- [ ] **Proton Pass extension doesn't autofill.** Still broken — doesn't show up in form fields, no autofill suggestions. Likely a content-script injection or messaging API gap in the webview/canvas setup. Reproduce: install Proton Pass extension, navigate to any login page, observe no inline autofill UI. (2026-04-17: agent triaged, 5 hypotheses in agent-ae11e03d worktree — extension gitignored so couldn't repro.)

- [x] **Tag-action toggles never render in the tiles world.** Surfaced 2026-04-26 after fixing the `api.settings.get('data')` storage bug in `tag-actions/home.js` — even with valid pair data in the datastore, no toggle affordances appear on item cards in tags/groups/search/pagestream. Confirmed via direct user testing. Tag-actions toggles were "completely untested in tiles world" per the user. Fix is multi-step:

  **Phase 1 — pubsub topic allowlists.** Consumer features (`features/{tags,groups,search,pagestream}/manifest.json`) call `api.publish('tag-actions:get-all', {})` and subscribe to `:get-all:response` / `:create:response` / `:update:response` / `:delete:response` via `app/lib/tag-action-affordances.js:createActionRulesCache`. None of the 4 consumer manifests declare `tag-actions:*` in their `pubsub.topics` allowlist, so the publish is rejected (silently or with a `gate:rejected` event per `tile-ipc-gate.ts`). Add the 5 topics (`tag-actions:get-all`, `:get-all:response`, `:create:response`, `:update:response`, `:delete:response`) to each consumer's allowlist. Confirm by running packaged with `DEBUG=1`, opening tags/home and searching for `gate:rejected.*tag-actions` in stderr.

  **Phase 2 — verify the renderer end-to-end.** Once the round-trip publishes succeed, confirm `createActionRulesCache.getRules()` returns the rules to the consumer, that `resolveAffordances()` picks the right rule for an item's tags, and that `createAffordanceElements()` renders the toggle into a `.tag-action-affordances` container that's actually attached to each card. Search for callers in tags/groups/search/pagestream `home.js` — confirm each invokes both `resolveAffordances` AND inserts the returned element into the DOM. Likely gaps: missing call site, container CSS hides it, render is gated on a flag that's never set.

  **Phase 3 — subscribe-before-publish race on cold start.** The pubsub-FSM Phase 4/5 invariant is "subscribe before publish — no buffering." `tag-actions/home.js:init` subscribes to `tag-actions:get-all` only after `await loadSettings()` (≥1 datastore round-trip, plus migration writes). Consumer tiles (tags is `lazy:true`, groups/search/pagestream all eager + resident) may publish their first `tag-actions:get-all` before tag-actions has subscribed → request is dropped and the cache stays empty forever. Two viable fixes: (a) **proactive broadcast** — tag-actions/home.js publishes `tag-actions:get-all:response` once when its own init completes, so any consumer that subscribed earlier picks up the rules without needing to publish a request; (b) **lifecycle gate** — consumers wait for a `feature:tag-actions:ready` signal before publishing. (a) is simpler and matches the Phase-4 invariant; recommended.

  **Phase 4 — `api.subscribe`/`api.publish` legacy alias check.** `tag-action-affordances.js` still uses the legacy bare `api.subscribe`/`api.publish` (not `api.pubsub.subscribe`). Verify these aliases survive in `tile-preload.cts` (most tiles use `api.pubsub.*` now). If the bare names are gone, migrate.

  **Phase 5 — Playwright coverage.** Add `tests/desktop/tag-actions-toggles.spec.ts` that opens tags/home, applies the active tag (`todo`) to a test item, and asserts the toggle element renders and is clickable; click it, assert the active tag becomes the completed tag (`done`). Mirror for groups/search/pagestream. Without these, this regresses the next time someone touches the pubsub topic gate.

  **Phase 6 — toggle interaction.** Once toggles render, verify clicking one fires the add-tag/remove-tag round-trip (`tag-action-affordances.js:227,234`) — the consumer needs `tag:*` topics (which most already have) AND the right datastore.tags grants. Likely already covered but worth confirming.

  Don't ship the data-storage fix as "complete" until Phases 1-3 land. The data fix is necessary but insufficient.

---

## Features

- [ ] **Update README + docs with tiles model, state machines, and webtil.es comparison.** README + DEVELOPMENT.md still reflect the pre-tiles era. Need: (1) a tiles-as-feature-unit section explaining capability-gated `tile-preload.cts` + manifest grants + per-tile BrowserWindow, with the project_tile_is_fundamental.md framing; (2) a state-machines section covering the three FSMs we ship — pubsub (`docs/pubsub-state-machine.md`), cmd panel (`docs/cmd-state-machine.md`), tile lifecycle (`backend/electron/tile-lifecycle.ts`), with a 1-paragraph "what they replace" each; (3) a comparison table: Peek tiles vs the [webtil.es](https://webtil.es) spec — where they overlap, where Peek goes further, where webtil.es is more conservative or has terminology we should adopt. Pull in `docs/tiles-single-file.md` and `docs/tile-preload-trimming-plan.md` as references rather than duplicating. Audience: contributors landing on the repo cold.
- [ ] **Design: ordered tag-backed lists feature.** The existing `list` feature is mainly used to view subsets of tagged items (e.g. `#todo #today`); keep that as one mode. Expand to a first-class lists primitive: each list = items sharing a `list:{name}` tag (prefix configurable in settings), with explicit ordering metadata so items can be reordered/pinned within the list. Surface as a noun in the cmd panel: `cmd → new list` (creates the tag + opens the list view), `list {name}` (open), `lists` (browse). Open questions: where ordering lives (per-item metadata? sidecar tag-metadata JSON? dedicated table?), how reorder propagates over sync, whether a list can layer additional filter tags, what happens when the prefix is changed retroactively. Out-of-scope until designed.
- [ ] **Add "Activate" button for extensions with `browser_action`/`action` but no popup.** TWP-class extensions (Translate Web Pages) declare a `browser_action` without `default_popup` — clicking the toolbar icon fires `chrome.action.onClicked`, which the extension uses to inject its UI via content script. Today's panel only shows buttons for popup OR options entries, so TWP shows only "Settings" with no way to *activate* TWP from the panel. Plan: (1) add new `action` entry type in `getChromeExtensionUiEntries` (`backend/electron/chrome-extensions.ts:491`) for extensions with `browser_action`/`action` declared but no `default_popup`; (2) add a `tile:chrome-extensions:dispatchAction` IPC (verify Electron supports firing `chrome.action.onClicked` programmatically — may need `chrome.scripting.executeScript` workaround if not); (3) extend `loadExtensionsPanel` in `app/page/page.js:3683` to render an "Activate" button for action entries. Surfaced 2026-04-23 — user expected this for TWP but it's a feature addition (not a regression restore).

---

## Deferred from audits / fixes

### Atproto install flow hardening (from atproto pipeline audit, 2026-04-16)
- [ ] **Verify atproto record signatures.** (Gap found 2026-04-20.) `backend/electron/atproto-source.ts:356` fetches the release record via `com.atproto.repo.getRecord` and accepts the response with no signature check. A compromised or malicious PDS can forge a record with CIDs pointing at tampered bundle blobs, and `verifyBlobCid()` (line 502) will happily validate those tampered bytes against the forged CIDs. Current trust boundary is TLS to the PDS, not the publisher's signing key. Full design and step-by-step plan (commit-level signature, MST inclusion, `@atproto/crypto`, PLC key-rotation handling, icon/screenshot gap) in [atproto-signature-verification-plan.md](atproto-signature-verification-plan.md). ~3 days.

---

## Planned major work

### Features-manager atproto plan phases (from `features/features-manager/PLAN.md`)
- [ ] Phase 7 — polish + indexing (curated directory, relay/indexer service as separate repo)

---

## Pruned / completed log

Keep short — for recent context only. Prune after a few weeks.

- 2026-04-27 Websearch bg+window consolidation finished: orphan `features/websearch/background.{html,js}` deleted (manifest already collapsed to a single `home` resident tile in earlier work; engine state + UI both live in `home.js`). All 10 websearch desktop tests green; no other refs in tree. Audit of remaining bg+window pubsub pairs added to "Tile architecture cleanup" — `tags` and `lists` are the next candidates.
- 2026-04-26 Tag-action toggles fixed (6-phase plan): added `tag-actions:*` to tags/groups/search/pagestream pubsub allowlists; added proactive `tag-actions:get-all:response` broadcast in `features/tag-actions/home.js:init` to defeat consumer cold-start race; new `tests/desktop/tag-actions-toggles.spec.ts` (4/0). Search runtime round-trip is asserted statically (manifest topic check) due to an unrelated `search-home` workspace-key collapse blocking fresh test windows.
- 2026-04-24 v1 removal complete: 36 commits stacked off main, every renderer routes through `tile-preload.cts` + strict `tile:*` IPC, manifestVersion 3 canonical, `extensions` SQLite table dropped, `extensionPaths` → `tilePaths`, `ext:*` startup topics → `feature:*`. Playwright 223/0, unit 2277/0.
- 2026-04-23 Pubsub message-passing state machine landed — 8-phase conversion (`docs/pubsub-state-machine.md`). P4 added bgWindow-ready latch + private lifecycle IPC; P5 deleted `cmd:request-registers` replay machinery. Resolved root cause of "only hello-world commands visible in cmd panel". Unit 2284/0, Playwright 208/0/11-skipped.
- 2026-04-23 Cmd-panel repeat invocation tests + 4 bugs fixed: panel state leak on keepLive reopen (private `tile:lifecycle:visible` IPC), `tile:window:close` now routes through `closeOrHideWindow`, per-invocation `cmd:execute:X:result` topic.
- 2026-04-23 Consolidated command-result paths: `tile:command:result` side-channel deleted; all results flow through capability-gated `tile:pubsub:publish` of `cmd:execute:{name}:result:{uuid}`.
- 2026-04-23 Theme live-reload in open tiles fixed (consolidated 3 broadcast channels into `tile:theme:changed`; preload-level cache-busted stylesheet injection).
- 2026-04-23 Settings broken sections fixed: `api.profiles.*`, `api.adblocker.*`, `api.darkMode.*`, `api.sync.*` namespaces restored in tile-preload (lost in v1→v2 migration). Settings blank-on-restore fixed by stripping hash/query before special-case URL match. Pseudo-tile registry consolidates the 6 hard-coded peek:// URL checks.
- 2026-04-23 Click-hold-drag window move restored (port `initWindowDrag()` IIFE from v1 preload into `tile-preload.cts`); page.js TDZ on `navbarGeneration` fixed.
- 2026-04-23 `target=_blank` download popup cleanup fixed: blanket-register `will-download` via `app.on('web-contents-created')` so every webContents session is covered.
- 2026-04-23 Bundled-extension links in page host widget verified working (was failing on missing `api.adblocker.getStatus()`).
- 2026-04-23 Test infrastructure: moved cmd-panel-keyboard tests to `desktop-serial` (external-url, cmd-palette, edit-param-mode, cmd-chain). 229/0 stable across 5+ full runs. HUD disabled; tag-widget + maximize flakes resolved.
- 2026-04-23 `yarn start` with `PROFILE=X` works alongside packaged Peek again (source builds always skip single-instance lock).
- 2026-04-23 FSM-pilled Claude Code skill authored at `~/.claude/skills/fsm-pilled/SKILL.md`.
- 2026-04-21 cmd / page / hud resident renderers consolidated into core background renderer (`app/index.js` → `initCmd/initPage/initHud`). `cmd-glue.ts`, `page-glue.ts`, `hud-glue.ts` deleted.
- 2026-04-21 Fixed cmd `ext:ready` / extension-commands race; registry grows 72→96 commands on cold start.
- 2026-04-21 Fixed Electron 40 console-message forwarder in `core-glue.ts` (level is string literal in E40, not int).
- 2026-04-17 post.nl → postnl.nl redirect blank page fixed; download save failing fixed (resolveUniqueDownloadPath); single-file tiles default model shipped; bundled TWP translate extension; commands for browser-extension options pages.
- 2026-04-16 Tiles v1-compat trimming complete (Phases 1-5): TILE_STRICT env flag, capability-violation pubsub topic, static tile-api.d.ts, all 26 features migrated to strict capabilities, v1 shims removed.
- 2026-04-16 Atproto install hardening (CID validation, atomic install, minPeekVersion, icon/screenshot blob handling).
- 2026-04-16 Pubsub audit follow-ups: tag lifecycle events, bare `tagItem()` bypasses converted to `tagItemAndPublish`.
- 2026-04-16 Settings audit follow-ups: backend defaults, JSON Schema validation, isolation + defaults test coverage.
- 2026-04-16 CSP gaps on error responses fixed (catch-block fallback applies CSP for tile origins).
- 2026-04-15 Initial cmd extraction + tiles migration to v2 + features-manager phases 1-6.
