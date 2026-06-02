# scripts/perf — page-host cost measurement

Reproducible measurement harness for perf epic **`d8e7efa5`** / task **`ed717516`** (collapse
the per-page page-host). Use these to capture a baseline now and to measure the win after the
hybrid (`WebContentsView` content + shared chrome overlay) lands — against the **same** restored
session.

Findings + the 2026-06-02 baseline: **`docs/perf/page-host-cost-baseline.md`**.

## Scripts

| Script | Purpose |
|---|---|
| `sample.sh` | **Main tool.** Per-tick comprehensive sampler: windows, procs-by-type {count, RSS, CPU%}, WindowServer {RSS, CPU%}, system {CPU, PhysMem, load}. CPU via cputime-delta (true instantaneous). |
| `wait-ready.sh` | Poll the IPC sock until the app is up and returning windows; print them. |
| `snapshot.sh` | Cheap one-shot: window count + procs-by-type RSS (no CPU). |

All take the launched profile via the `PROF` env var. `sample.sh` also honours `ITERS`,
`INTERVAL`, `DELTA`.

## Runbook

```bash
# 0. Build (only if you edited main/** or chrome-api-polyfills/**)
yarn workspace @peek/desktop build

# 1. Clone the prod profile — APFS copy-on-write: instant, ~zero disk, fully isolated.
#    The live prod 'default' profile is only READ. NEVER run on it directly.
cp -c -R "$HOME/Library/Application Support/Peek/default" \
         "$HOME/Library/Application Support/Peek/perfX"

# 2. Launch. Two modes:
#    - HEADLESS  -> clean RAM/proc counts, no focus steal (windows render at opacity 0).
#    - VISIBLE   -> also pays the real compositor (WindowServer/GPU) cost.
#    RULE: never set DEBUG=1 on a VISIBLE run (ipc.ts:2378 auto-opens DevTools on every
#    peek:// window -> contaminates counts). peek-cli + main.log work without DEBUG.
ELECTRON=/Users/<you>/misc/mpeek/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
PEEK_HEADLESS=1 PROFILE=perfX "$ELECTRON" .        # headless
#                PROFILE=perfX "$ELECTRON" .        # visible (no DEBUG!)

# 3. Wait for the session to restore, then sample through load -> settle.
PROF=perfX bash scripts/perf/wait-ready.sh
PROF=perfX ITERS=14 INTERVAL=15 DELTA=3 bash scripts/perf/sample.sh

# 4. Tear down (prod-safe + clone-safe: the /mpeek/ path excludes /Applications/Peek.app).
pkill -f '/Users/<you>/misc/mpeek/node_modules/electron/dist/Electron.app'
pgrep -la Electron      # confirm ZERO (teardown of 100+ procs takes a few seconds)

# 5. Delete the clone (and any partition dir it spawned).
rm -rf "$HOME/Library/Application Support/Peek/perfX" \
       "$HOME/Library/Application Support/Peek/Partitions/perfX"
```

Run these as background tasks (the launch and `sample.sh` are long-lived); `sample.sh`'s loop
`sleep`s internally, so let it run to completion rather than polling.

## Reading the output

- `loading=0` and a flat RSS/CPU plateau ⇒ settled; read those rows, not the load-spike rows.
- Renderer **proc count** is the headline for the process win; **WindowServer CPU%** is the
  compositor cost (only non-trivial in a visible run).
- ps RSS over-counts the shared Electron framework per-process; trust **deltas** (per-page,
  before/after a change) more than absolute totals.

## Comparing against the frozen baseline

A COW snapshot of the exact 2026-06-02 session is preserved (uncommitted) at
`~/peek-perf-baseline/`. To measure the hybrid: copy that snapshot back to a `perfX` profile,
run the same launch + `sample.sh`, and diff against `docs/perf/page-host-cost-baseline.md`.
