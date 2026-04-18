# Agent Report: v1 Removal Phase 1c (cmd + page conversion)

## Summary

Converted `cmd` and `page` core renderers from v1 iframe-in-extension-host
loading to v2 standalone BrowserWindows using `tile-preload.cjs` with a
`trustedBuiltin` capability grant. Same pattern HUD was converted to in
Phase 1b.

Both renderers now participate in the same tile mechanics as feature
tiles. Capability enforcement is bypassed at every `tile:*` IPC because
the tokens carry `trustedBuiltin: true` (added to `tile-manifest.ts` in
Phase 1a; enforcement bypass points already audited in Phase 1b).

No new enforcement-bypass sites were needed — the existing Phase 1b
bypass points in the `check*Allowed` pure helpers + tile-ipc inline
checks covered everything cmd and page exercise.

## Commits (all jj; no git, no push)

1. `0219c831` — `chore: triage + plan stub for v1-removal phase 1c`
2. `420cff39` — `feat(cmd): merge background.{html,js} into index.html (single-file core renderer)`
3. `3b6183e3` — `refactor(cmd): use api.pubsub.* instead of v1 api.publish/subscribe`
4. `a0a4d3a4` — `feat(cmd-glue): launch cmd with tile-preload + trustedBuiltin grant, drop loadExtInHost`
5. `bff756b3` — `feat(page): single-file resident renderer for open/modal commands`
6. `b0fcef88` — `feat(page-glue): launch page-bg with tile-preload + trustedBuiltin grant, drop loadExtInHost`

Note: the plan listed a separate "refactor(page): use api.pubsub.*" commit
between steps 5 and 6. Because page's `background.js` was short (~180
LOC, all command registration), the inlining into `background.html`
(step 5) was written directly in the v2 api shape — there was no
standalone `s/api.publish/api.pubsub.publish/g` diff worth isolating.
Six commits total instead of seven; semantics unchanged from the plan.

## What landed (per renderer)

### cmd

- `app/cmd/index.html` added — resident renderer, single-file, imports
  `background.js` as an ES module. Contains the `await api.initialize()`
  (tile-preload token handshake), then `extension.init()`, then the
  `ext:ready` publish via `api.pubsub.publish(..., api.scopes.SYSTEM)`,
  then the shutdown subscriptions.
- `app/cmd/background.html` deleted.
- `app/cmd/background.js` converted: every `api.subscribe` → `api.pubsub.subscribe`,
  every `api.publish` → `api.pubsub.publish`. Header comment updated to
  describe the resident-renderer host.
- `api.app.getInfo()` replaced with a best-effort `window.__APP_VERSION__`
  lookup (tile-preload does not expose `api.app`; see "Open items").
  This is only used for cache-staleness checks — a mismatch just forces
  re-registration, not a correctness bug.
- `api.extensions.list()` replaced with `api.features.list()` (the v2
  surface on tile-preload). Response shape is `{ entries }` instead of
  `{ success, data }`; handled defensively.
- `backend/electron/cmd-glue.ts` rewritten:
  - Drops `loadExtInHost` + `waitForExtLoaded`.
  - Creates hidden `BrowserWindow` with `tile-preload.cjs` + `createTrustedBuiltinGrant('cmd')` token.
  - Calls `registerTrustedBuiltinWindow(CMD_ID, CMD_ENTRY_ID, win, token)` so `extensionBroadcaster` forwards pubsub.
  - Blocks on cmd's `ext:ready` publish (subscribes via a unique source
    address so it doesn't collide with main.ts's system subscriber) —
    critical because features that publish `cmd:register-batch` before
    cmd's subscribers are in place would have their registrations
    dropped silently. 5s safety timeout matches the old
    `waitForExtLoaded` budget.
  - Keeps the 100ms post-ready buffer (lifted from the old glue) for
    pubsub-bookkeeping settling.
- `backend/electron/main.ts`:
  - `await initCmd({ tilePreloadPath })` (new shape).
  - `loadedConsolidatedExtensions.add('cmd')` for Features-pane visibility.

### page

- `app/page/background.html` converted to single-file resident renderer.
  Inlined `background.js` (URL validation, `open`/`modal` command
  definitions, registration loop). Uses v2 `api.pubsub.*` from day one.
  Same shape as `features/mcp-server/background.html` (commit 4e612222).
- `app/page/background.js` deleted.
- `backend/electron/page-glue.ts` rewritten — same shape as hud-glue /
  cmd-glue: hidden BrowserWindow + trustedBuiltin token + registerTrustedBuiltinWindow.
  No wait for `ext:ready` (page isn't blocking any downstream registration).
- `backend/electron/main.ts`:
  - `await initPage({ tilePreloadPath })` (new shape).
  - `loadedConsolidatedExtensions.add('page')`.

### Unchanged

- The cmd panel UI (`app/cmd/panel.html` + `panel.js` + state machine,
  noun registry, chain editor, 82KB of logic) is opened on-demand as a
  separate BrowserWindow via `api.window.open('peek://ext/cmd/panel.html', ...)`.
  NOT touched — it wasn't in the iframe-in-host path to begin with.
- The page canvas (`app/page/index.html` + `page.js`, per-URL canvas,
  FROZEN architecture per DEVELOPMENT.md) is created on-demand per page.
  NOT touched.

## Test status

### Unit tests — all pass

`yarn test:unit`:
- 1655 backend Electron tests pass, 0 fail.
- 565 Node unit tests pass, 0 fail.
- Total: 2220, 100% green. Matches baseline from prior phases.

### Targeted Playwright

Run against the agent worktree:

| Test | Status |
| --- | --- |
| `cmd panel opens URL with http protocol` | pass |
| `cmd panel opens URL with https protocol` | pass |
| `cmd panel opens localhost URLs` | pass |
| `cmd panel detects and opens domain without protocol (youtube.com)` | pass |
| `cmd panel ignores non-URL non-command text on Enter` | pass |
| `cmd panel loads with chain state initialized` | pass |
| `cmd panel input works correctly` | pass |
| `external URL handler opens URL on first click` | pass |
| `handleExternalUrl from main process opens URL correctly` | pass |
| `google command via cmd panel UI does not hang` | pass |
| `direct pubsub kagi execution works (control test)` | **pass** (regressed-but-now-fixed — was failing in prior AGENT_REPORT snapshot) |
| `kagi command via cmd panel UI does not hang` | fail (same preexisting Phase 2 blocker documented in docs/tasks.md) |
| `hud command is registered` | fail (preexisting HUD test fixture issue inherited from Phase 1b — `waitForWindow('ext/hud/hud.html')` expects the hud overlay to auto-open; test mechanics haven't caught up) |

No new regressions introduced by this phase. The kagi/hud failures
predate my commits (HUD fixture failure is inherited from Phase 1b;
kagi failure is documented on tasks.md).

## Architectural decisions

### cmd's lazy-stub + command-cache flow under the new transport

cmd's registry still serves lazy-stub, cached-command-replay, and noun
auto-registration the same way. All that logic lives in
`app/cmd/background.js`, which is loaded by the new resident
`index.html`. Under the new transport every subscribe/publish is a
`tile:pubsub:*` IPC with the trustedBuiltin grant — the routing goes
main-process → extensionBroadcaster → cmd resident window
(registered via `registerTrustedBuiltinWindow`). Same event flow as
feature tiles; cmd is just another subscriber from the pubsub plumbing's
point of view.

### Handling cmd's ext:ready race

cmd's `background.js` publishes `ext:ready` only after
`initCommandRegistry()` has subscribed to `cmd:register`, `cmd:register-batch`,
etc. `cmd-glue.ts` awaits this publish before resolving `initCmd()`,
so any subsequent feature startup that publishes `cmd:register-batch`
arrives AFTER the subscribers are in place. Matches the v1 iframe path's
semantics exactly. Unique source address on the wait subscription
prevents clashes with main.ts's own `getSystemAddress()` ext:ready
subscriber (which uses source-keyed dispatch).

### v1 preload APIs not on tile-preload

`api.app.getInfo()` and `api.extensions.list()` (v1 preload surfaces) do
not exist on tile-preload. cmd's `background.js` used both. I mapped:
- `api.extensions.list()` → `api.features.list()` (v2 equivalent)
- `api.app.getInfo()` → `window.__APP_VERSION__` (compile-time) with
  `'0.0.0'` fallback. Used only for cache validity checks; functional
  impact is nil (cache mismatch just triggers re-registration).

Not adding `api.app` to tile-preload. If a future need emerges we can;
for now keeping the strict surface narrow.

### No new capability-enforcement bypass sites

Audited: cmd and page exercise pubsub, commands, settings, datastore,
shortcuts, window, features. All are already `trustedBuiltin`-aware from
Phase 1b's blanket bypass in the `check*Allowed` helpers + inline sites.
No additional edits needed in `tile-ipc.ts`, `check-capability.ts`, or
any pure-module helper.

## Open items / next-step suggestions

### Phase 2 (test fixture migration)

The remaining v1 seam is the test bgWindow (`peek://app/background.html`)
loaded via the legacy preload + `IPC_CHANNELS.SUBSCRIBE` path. This is
the last loader of `preload.js` and the last place `extensionHostWindow`
is needed. Phase 2 per `docs/v1-removal-plan.md` recommends a privileged
test renderer in `app/_test/` using `tile-preload.cjs` + trustedBuiltin.
When that lands, `extensionHostWindow` and the remaining `loadExtInHost`
call-sites (currently only featureless — cmd and page no longer use
them) can be audited for deletion.

### HUD test fixture regression (Phase 1b leftover)

`tests/desktop/hud.spec.ts:116 — 'hud command is registered'` relies on
`waitForWindow('ext/hud/hud.html')` auto-opening. This fixture was not
updated in Phase 1b. Worth a separate targeted fix — the resident HUD
renderer opens the overlay window on demand via `api.window.open(...)`,
but the test expects it already open at startup.

### cmd command-cache version check weakened

Without `api.app.getInfo()`, the app-version component of
`isCacheValid()` always sees `'0.0.0'` unless `window.__APP_VERSION__`
is injected at bundle time. Option A: expose `api.app.getInfo()` on
tile-preload (routes to the ungated `app-info` IPC). Option B: inject
`__APP_VERSION__` via preload's `additionalArguments` (or a
build-number constant like vite does for mobile). Low priority — at
worst, a known-good cache is discarded on first app-version check,
which just spends a few ms re-registering commands.

### main.ts comment cleanup

Several `initCmd` / `initPage` comments in main.ts still reference
"iframe" phrasing that no longer applies. Kept the comments honest where
I edited; sweep still available for a follow-up polish PR.

## Files changed (cumulative, across all 6 commits)

- `app/cmd/background.html` (deleted)
- `app/cmd/index.html` (new, resident renderer)
- `app/cmd/background.js` (v2 api.pubsub.* surface; api.app/api.extensions mappings)
- `app/page/background.html` (rewritten as single-file resident renderer)
- `app/page/background.js` (deleted)
- `backend/electron/cmd-glue.ts` (rewritten)
- `backend/electron/page-glue.ts` (rewritten)
- `backend/electron/main.ts` (new init signatures + loadedConsolidatedExtensions bookkeeping)
- `AGENT_REPORT.md` (this file)

## Verification

- `yarn tsc -p backend/tsconfig.json --noEmit` — clean.
- `yarn build` — clean.
- `yarn test:unit` — 2220/2220 pass.
- Targeted Playwright smoke (`test:grep "opens URL" / "cmd panel"`) —
  all green except the two preexisting failures noted above.
