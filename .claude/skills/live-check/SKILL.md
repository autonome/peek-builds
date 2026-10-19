---
name: live-check
description: Launch a worktree's own Peek desktop build for a live check and watch it from the first second — one event log of lifecycle events and real errors (stdout/stderr + the profile's main.log, noise filtered), meant for Monitor. Use for EVERY app launch made to check a track, by any agent, headless or visible, instead of composing an Electron command line by hand — and ALWAYS when asking the user to check something by hand in the app, so their check runs under a watched launch.
---

`scripts/live-check.mjs` launches `<worktree>/node_modules/electron/...` with the worktree
root as the app path, on the track's own profile, and supervises it. Everything that
matters lands in one file, `<worktree>/.tmp/live-check/events.log`, so a watcher sees each
error as it happens instead of grepping afterwards.

## When

Any time Peek is launched to check a track's change — headless (the default) or visible.

**A hand check by the user always runs through this tool.** When a change needs the user to
look at or do something in the app, don't hand them a launch command or ask them to start
the app themselves. Build the worktree, `start <worktree> --visible` (ask before a visible
launch, as below), start `Monitor` on the event log, then ask for only the gesture or the
observation. Errors, exits and relaunches during their check land in the log as they
happen, so the result is read from the log as well as from what they report. `stop` when
they're done. The Linux box has no display, so a hand check always happens on the Mac.
It replaces the hand-composed launch in the user-level `peek-bg-run` skill for that case;
`peek-bg-run` still describes what headless does and doesn't hide, and the test-running
rules. Playwright specs are not launched through this tool.

## Commands

Run by absolute path, one command per call:

```bash
node <worktree>/scripts/live-check.mjs start <worktree>                 # headless
node <worktree>/scripts/live-check.mjs start <worktree> --visible       # needs the user's OK
node <worktree>/scripts/live-check.mjs start <worktree> --watch '<cmd>' # extra watchers, repeatable
node <worktree>/scripts/live-check.mjs status <worktree>
node <worktree>/scripts/live-check.mjs stop <worktree>
node <worktree>/scripts/live-check.mjs log-path <worktree>
```

Options for `start`: `--profile <name>` (default: the worktree directory's name, so
`PROFILE` and `PEEK_PROFILE` both equal the track name), `--all` (pass every line, not
just error-looking ones). `TMPDIR` is always `<worktree>/.tmp`.

`start` returns once Electron is spawned and prints the log path. Readiness arrives in the
log as a `ready` event (when `scripts/peek-cli.mjs debug-list-windows` lists windows), so
drive the app with `PEEK_PROFILE=<profile> node scripts/peek-cli.mjs …` after that.

## Pair it with Monitor

Start the check, then hand the log to `Monitor`:

```
Monitor: tail -F <worktree>/.tmp/live-check/events.log
```

Each line is `<ISO time> [<source>] <text>`, source one of:

- `lifecycle` — `launched`, `ready`, `not ready after 60s`, `exited code=…`, `relaunched`,
  `stopping`, `stopped; no process … is left`, `launch-failed`, `watch:N started/exited`.
- `main.log` — entries from `<userData>/<profile>/logs/main.log` (macOS:
  `~/Library/Application Support/Peek/<profile>/logs/main.log`) that look like errors;
  continuation lines (stacks, details) stay with their entry.
- `stdout` / `stderr` — the same filter over the launch's own output, minus anything
  main.log already reported (main-log.ts mirrors console output there). This is where
  Chromium's native errors and Electron's own uncaught-exception output show up.
  Unfiltered output goes to `electron.out.log` beside the event log.
- `watch:N` — every line the Nth `--watch` command prints, unfiltered (e.g. the probes
  in `tools/drag-pasteboard-probe/`).

Lines after `stopping` come from the shutdown itself — a kill provokes some errors of its own.

Known noise is listed in `NOISE_PATTERNS` in the script (Electron's missing webRequest
bindings, the extension bridge's routine startup logged at error level, Proton Pass's
unknown permissions, punycode deprecation, zero-failure perf lines). Add to it when a line
shows up on every launch and never means anything; don't widen it to hide a real error.

## Modes

- **Headless (default):** `PEEK_HEADLESS=1`. The app exiting ends the check; the
  supervisor records the exit code and stops its watchers.
- **Visible (`--visible`):** a real window, which takes focus once at launch on macOS —
  ask the user before using it. A quit ends the check, as in headless mode. Add
  `--relaunch` only when a restart is part of the check: the app then comes back a second
  after each quit (`relaunched` event) until `stop`.

## Refusals (nothing is launched)

- The app path's `package.json` has no `main` — e.g. `apps/desktop` given instead of the
  worktree root. Electron would fall back to its default app, which shows a focus-taking
  "Error launching app" dialog before any Peek code runs, so `PEEK_HEADLESS` can't stop it.
- The file `main` names isn't built — run `yarn --cwd <worktree> workspace @peek/desktop build`.
- No Electron binary in the worktree — run `node node_modules/electron/install.js` there
  (a fresh worktree's `yarn install` can leave it undownloaded).
- A check is already running for the worktree, or that worktree's Electron is.

## Stopping

`stop` kills only processes whose command line contains this worktree's absolute
`node_modules/electron/dist/Electron.app/` path (helpers included) — never
`/Applications/Peek.app`, the primary checkout, or another worktree — then confirms none
are left and exits non-zero if any are. Always stop a check before finishing.
