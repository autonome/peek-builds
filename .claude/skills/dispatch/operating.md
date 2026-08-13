# Operating the dispatch loop

Read on demand — `SKILL.md` is read every tick and stays short. This file
covers how the loop is driven, how to stop it, and the ways it is known to
fail.

## Driving it

Two loops, in idle terminal sessions opened in the repo root:

```
/loop 15m /dispatch
/loop 4h /triage-pass
```

Fifteen minutes is chosen against reconcile latency, not throughput: a stalled
agent is noticed within two ticks, and one spawn per tick means the pool fills
over an hour rather than instantly. Triage runs slowly because its input is a
backlog, not an event.

**Not `claude -p` under system cron.** Headless runs started in a directory
with a previous session hit the resume-dialog stall: the run blocks on an
interactive prompt, with no error, no exit code, and nothing in the log to say
so. An in-session `/loop` also keeps the Peek MCP connection alive and stays
interruptible, both of which the loop depends on.

## Stopping it

- **Whole loop** — `touch /tmp/mpeek-dispatch-off`. Ticks become no-ops
  immediately; in-flight agents keep running and are still reconciled when the
  file is removed. Deliberately not in the repo: the switch is per-machine, and
  a tracked kill switch is one merge away from disabling someone else's loop.
- **One item** — tag it `peek:hold`. It stays in the queue and stays invisible
  to claiming.
- **One agent** — `TaskStop` it. The worktree and its `handoff.md` survive, so
  the next tick resumes rather than restarts.

## The autonomy ladder

Start at level 1 and stay there until the ratio of clean landings is boring.

1. **Dispatcher spawns, human approves every landing.** Section 5 of `SKILL.md`
   runs only on an explicit go-ahead. This is the starting position.
2. **Auto-land the classes where the suite is a sufficient reviewer** — docs,
   tests, single-file `peek:scope:*` work with a runnable verify command.
   Everything else still stops at `peek:needs-review`.

The gate between the levels is not accumulated trust, it is
`yarn test:desktop:electron`. A class of work is promotable when a failure in
it would reliably turn the suite red, and not before.

## Known failure modes

- **The queue starves.** The dispatcher is only as good as the count of items
  that are `peek:todo` + `peek:ready` with a real done-condition. When ticks
  report "nothing dispatchable" the bug is in triage, not in dispatch.
- **Same-area collisions.** Two agents in one app produce rebases at landing
  time. The scope-diversity preference in section 3 is the mitigation; the cure
  is a queue with breadth in it.
- **Landing serializes.** One worktree holds `main`, the suite takes ~10
  minutes, and finished agents queue behind it. Four parallel agents do not
  produce four parallel landings, and the pool cap is set with that in mind.
- **Rate limits.** One spawn per tick plus a cap of four is the whole
  concurrency control. Raising either without watching for rate-limit errors is
  how a loop turns into a stalled pool of half-finished worktrees.
- **A confident, wrong `handoff.md`.** A stale line in a worktree's handoff
  sends the next agent off fast in the wrong direction, which costs more than a
  missing line. Agents are told to update it before stopping for any reason,
  including failure.
- **Silent skips.** An item claimed but never spawned, or a worktree reclaimed
  without a note, disappears. Every reclaim writes a `record_event` and every
  tick reports, so the trail is in Peek rather than in a terminal scrollback.

## Related machinery that is out of date

`mpeek-clone-pool`, `agent-review` and `fix` describe the retired isolated-clone
scripts and a root `CLAUDE.md` that no longer exists. The reviewer decision
table and reviewer brief in `agent-review` are still correct and are what
`SKILL.md` points at; its finalize and clean commands are not.
