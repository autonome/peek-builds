# Phase 2 Retry — v1-removal test fixture migration

## Status

In progress. Retry of Phase 2 after commits `ce382a0b`..`ee0379be` were
rolled back 2026-04-18 due to a v2-pubsub routing regression (the
broadcaster's self-echo filter used `new URL('peek://…').origin` which
returns the literal string `"null"` for non-standard schemes in Node).

That routing bug is now fixed on the current worktree HEAD `b8dbc1b8`
(`peekHost()` helper parses the host manually). With routing fixed, the
v1-removal reproducer test passes and the ~10 tag/kagi/hud flakies pass.

Phase 1 is fully landed (cmd, hud, page on tile-preload + trustedBuiltin).
`ensureTileIpcHandlers()` is called centrally at top of
`main.ts::initialize()` (commit `745af1f5`), so per-glue calls are
redundant and will NOT be re-introduced.

## Scope — re-apply orphaned Phase 2 commits

Identified via `git reflog` (still findable):

- `5797a148` — `app/_test/index.html` privileged renderer, `protocol.ts`
  peek://test/ host route, `tile-ipc.ts` trustedBuiltin in validate-token
  response, `tile-preload.cts` api.invoke (trustedBuiltin-gated).
- `7bf2f15f` — `backend/electron/test-fixture-glue.ts` (new) + hook in
  `main.ts::loadExtensions()` to launch it when `E2E_TEST=true`.
- `28e248ab` — `tests/fixtures/desktop-app.ts` getBackgroundWindow()
  returns v2 renderer. (The USE_V1_TEST_FIXTURE flag was later dropped.)
- `a5c98bc4` — `tile-preload.cts` `api.extensions.*` + `api.commands.list`
  (trustedBuiltin-gated). Also added per-glue `ensureTileIpcHandlers()`
  calls in cmd/hud/page/test-fixture glue. **The per-glue calls will NOT
  be re-applied** — central one at top of `initialize()` is authoritative.
- `ee0379be` — drop USE_V1_TEST_FIXTURE — single v2 path.

## Re-apply commit order

1. `chore: triage stub for Phase 2 retry` (this file)
2. `feat(_test): privileged test renderer` — app/_test/index.html (final
   shape from a5c98bc4 — thin, relies on tile-preload surface)
3. `feat(protocol): peek://test/ host route` — backend/electron/protocol.ts
4. `feat(test-fixture-glue): launch test renderer when E2E_TEST=true` —
   new file + initTestFixture import/call in main.ts loadExtensions().
   `ensureTileIpcHandlers()` inside test-fixture-glue is safe (idempotent)
   — keeping that one. Not adding the per-glue ones.
5. `feat(tile-preload): api.invoke + api.extensions + api.commands.list
   trustedBuiltin-gated; trustedBuiltin in validate-token response` —
   tile-preload.cts + tile-ipc.ts
6. `feat(fixtures,main): getBackgroundWindow returns v2 renderer` —
   tests/fixtures/desktop-app.ts (single v2 path — no flag)

## What was REMOVED from the original Phase 2

- Per-glue `ensureTileIpcHandlers()` calls from `a5c98bc4`
  (cmd-glue.ts, hud-glue.ts, page-glue.ts). The central call in
  `main.ts::initialize()` handles it for all core renderers.
- `USE_V1_TEST_FIXTURE` feature flag from `28e248ab`. Went straight to
  single v2 path (equivalent to `28e248ab` + `ee0379be` combined).

## Validation results

Will populate after each test run.

| Test | Status |
| --- | --- |
| v2 trustedBuiltin tile | pending |
| direct pubsub kagi execution works | pending |
| tag command with # prefixed tags stores tags without prefix | pending |
| open and close settings | pending |
| Group Mode Context (5 tests) | pending |

## Open items / risks for Phase 3

- Once validation is green, Phase 3 can delete `extensionHostWindow`,
  `loadExtInHost`, `extensionWindows`, v1 portion of
  `extensionBroadcaster`, legacy IPC channels
  (`IPC_CHANNELS.SUBSCRIBE/PUBLISH`, `window-open`, `window-close`,
  `cmd-result`), and `preload.js`. Audit for any chrome-extensions content
  script that still depends on `IPC_CHANNELS`.
- The 10 fallback branches inside `tile-preload.cts` (each gated
  `if (!hasXxxCapability()) return ipcRenderer.invoke('legacy-channel',
  ...)`) can become unconditional strict paths once v1 is deleted.
- `app/background.html` + `app/background.js` — last v1 consumers.
  Delete after Phase 3.
