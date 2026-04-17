# Agent Report: fix `kagi command via cmd panel UI does not hang`

## Test

- `tests/desktop/websearch-cmd.spec.ts:202` — "kagi command via cmd panel UI does not hang"
- Adjacent: line 272 (google, same hang), line 309 (direct pubsub control — also fails)

## Regression the test guards against

The test documents (file header): "the bug where running 'kagi test' from the cmd palette UI would hang (progress bar spins forever, 30s timeout), even though the same command works fine when invoked directly via pubsub."

At the time the test was written, direct pubsub was the control (expected to pass). Right now, it also fails, so both paths are broken.

## Root causes

### Product bug #1 (confirmed, partial fix applied)

`features/websearch/manifest.json` pubsub topic allowlist was missing `cmd:execute:*`. When the v2 websearch tile tries to publish `cmd:execute:kagi:result` via `tile:pubsub:publish`, the allowlist check in `backend/electron/tile-ipc.ts:427-440` rejects the publish silently. The cmd panel proxy never gets the `:result` event, so it stays in `EXECUTING` until the 30s proxy timeout (test times out at 20s).

This matches the exact class of bug that was fixed for tags in commit `b3a80b27` (added `cmd:execute:*` to tags' manifest allowlist).

**Fix:** added `"cmd:execute:*"` to `features/websearch/manifest.json` → `capabilities.pubsub.topics`.

### Blocker #2 (same as documented v2→v1 routing issue — test still fails)

Even with the manifest fix, the control test still fails. This matches the open blocker in `docs/tasks.md`:

> v2 tile `cmd:execute:<name>:result` doesn't reach v1 extension-host subscribers. [...] The publish from v2 tile via `tile:pubsub:publish` → main `publish()` → `extensionBroadcaster` should reach all extension windows including bgWindow. Investigate: does `extensionBroadcaster` actually iterate v1 host iframes, or only legacy extension BrowserWindows? Same routing question for v2 tile → cmd panel result delivery.

bgWindow is `peek://app/background.html` — a separate `BrowserWindow` created by `createBackgroundWindow()` in `backend/electron/main.ts:2059`. It is NOT in `extensionHostWindow`, NOT in `extensionWindows`, NOT in `getAllTileWindows()`. So `extensionBroadcaster` in `main.ts:195-254` skips it entirely.

However, bgWindow subscribes via the legacy `IPC_CHANNELS.SUBSCRIBE` path (`backend/electron/ipc.ts:4466-4473`), which registers a traditional in-proc callback in `topics` via `subscribe()`. When `publish()` runs in `pubsub.ts:80-100`, it iterates all traditional subscribers (line 86-94) — that in-proc callback should fire and `ev.reply(replyTopic, data)` should send the message to bgWindow. So the routing chain should in principle work for any topic the v2 tile is allowed to publish.

That it still doesn't is consistent with the broader blocker — something further downstream in the traditional subscribe/callback chain isn't firing for v2-tile-sourced publishes. I didn't fully diagnose it within budget. Worth investigating next:

1. Whether `subscribe()` in `pubsub.ts` actually fires the bgWindow's reply callback when the publish source is a v2 tile.
2. Whether `cmd panel` also subscribes via the same path (likely yes — cmd panel loads `peek://cmd/panel.html` with `preload.js`, so same `IPC_CHANNELS.SUBSCRIBE` route).
3. Whether the tags test failure is the same chain.

## Triage summary

| Test | Before fix | After allowlist fix |
| --- | --- | --- |
| `kagi command via cmd panel UI does not hang` | times out in EXECUTING | times out in EXECUTING |
| `direct pubsub kagi execution works` | times out (15s) | times out (15s) |

The allowlist fix is a real, necessary product bug fix (otherwise the `:result` publish is hard-gated), but it's not sufficient to unblock these tests — the same downstream routing blocker documented for the tag tests is in the way.

## Decision

Per instructions: "if you hit the v2→v1 routing blocker and can't fix it without scope creep, commit your triage findings and exit — that's still valuable."

I committed the manifest allowlist fix because it's a narrow, independently-useful regression fix (same pattern as `b3a80b27` for tags). The test remains failing until the downstream routing blocker in `docs/tasks.md` is resolved.

## Verification

- `yarn test:grep "direct pubsub kagi execution works"` — still fails (same root cause as open blocker).
- `yarn test:grep "kagi command via cmd panel UI does not hang"` — still fails.
- Manifest fix verified in place: `features/websearch/manifest.json` pubsub topics now includes `cmd:execute:*`.

## Files changed

- `features/websearch/manifest.json` — added `"cmd:execute:*"` to pubsub topics allowlist.
- `AGENT_REPORT.md` — this report.
