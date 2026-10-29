# Session-local track notifications

A project-local Pi extension for the coordinator in this checkout. It watches only
the targets in `.pi/track-monitor.json` and the latest GitHub macOS candidate
workflow run. It does not start writers, land/push changes, dispatch builds, change
authentication, or authorize anything the coordinator was not already allowed to do.
It is coordination tooling, not a Peek runtime component.

## Activate in the current conversation

1. Run `/reload` in Pi and approve project resources if asked. If this folder has
   not been trusted, use Pi's `/trust` flow first; the extension never changes trust.
2. An interactive/RPC session in the **primary** checkout starts the monitor. It
   posts an initial observed-state report once Pi is idle. `/track-monitor status`
   confirms activation; `/track-monitor test` explicitly tests a conversational wake-up.

An already-running Pi process cannot load a newly written extension until its runtime
reloads. RPC/SDK frontends must expose resource reload or restart/resume their Pi
backend; merely writing these files does not patch a live process. RPC clients must
continue consuming session events to display unsolicited assistant messages. A host
that presents its extension context as print/JSON mode is intentionally not activated.

Commands:

- `/track-monitor status`: display cached observations without calling the model.
- `/track-monitor off`: stop; remains off across reloads in this session branch.
- `/track-monitor on`: resume; uses the saved report checkpoint to avoid duplicates.
  The watchlist is read at startup: after editing `.pi/track-monitor.json`, reload Pi
  or turn the monitor off and on to pick up new targets.
- `/track-monitor test`: one clearly labelled synthetic wake-up, not a status claim.

Monitoring stops at session shutdown/reload, restart, or process exit. It runs only
while Pi remains open; it is not a daemon or a notification service for a closed chat.
No automatic monitoring runs in print/JSON writer processes or linked worktrees.

## What triggers an update

Read-only samples every **45 seconds** observe commits, writer process exit, handoff
content-digest changes, current review verdict/state, landing markers, and CI
status/conclusion/new run. Unchanged polls do not call a model. A stopped writer is
not interpreted as success. Manual-track removal is called landed only when the
previously observed tip is an ancestor of `main`; otherwise removal is unconfirmed.

Changes are coalesced while Pi is busy or has queued user messages. Automatic wake-ups
are at least **two minutes** apart, with a ceiling of **12/hour**; pending changes
remain queued when throttled. Checkpoints survive runtime reloads through Pi custom
session entries. User-requested `/track-monitor test` is separate from that limit.

A sample uses the existing `spec-status.mjs`, read-only local Git commands, and
`gh run list` for exactly the configured repository/workflow. Commands have a 20-second
timeout and a 4 MiB output bound. Optional Git index locking and CLI prompts are off.
No shell command interpolation, fetch/pull/push, token-file reads, or raw test/CI/session
log reads. `gh` uses its normal existing authentication for this read-only query.

Failed sources retain previous observations. Three consecutive source failures emit
one unavailable transition; recovery emits another. Failure stderr/argv/error messages
are never forwarded. Only validated names/enums, commit IDs, finite counts, review
verdicts, handoff digests and constructed github.com run links enter notifications.
Handoff bodies and arbitrary status notes are not sent by the extension. The notified
agent is instructed to verify outcomes before making user-facing claims.

Only one coordinator session owns `.tmp/pi-track-monitor.lock`. Shutdown releases
its own token. Existing or malformed locks are never stolen, including after a crash.
If startup reports a lock problem, inspect the lock's PID and remove that exact file
only after confirming the owner is gone. There is no automatic stale-lock deletion.
The lock lives in already-ignored scratch; no credentials or transcript are stored there.
This is not a hostile-filesystem security boundary: extensions share Pi's OS privileges.

## Verify

From the repo root, using Pi's supported Node version (22.19+; tested on Node 24):

```sh
node --test .pi/extensions/track-monitor/tests/monitor.test.mjs
node .pi/extensions/track-monitor/snapshot.mjs
```

The automated suite uses fake clocks/contexts/CI/status sources and disposable temp
fixtures, with no live model/provider calls. It covers batching, rate limits,
checkpoints, redaction, source failures, cancellation, leases, shutdown/reload/off,
noninteractive exclusion and the real TypeScript extension entrypoint. It verifies
that notifications call Pi's `sendMessage` with `triggerTurn: true` and follow-up
delivery, not that an un-reloaded live conversation has already received one.

The snapshot command is an **explicit read-only live status/CI check**, not a watcher;
it prints only normalized metadata. It does not start Pi, call a model, or hold a lock.
