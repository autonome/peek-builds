---
enabled: true
touches: [apps/desktop/main/visit-dwell.ts, apps/desktop/main/visit-dwell.test.ts, apps/desktop/main/datastore.ts, apps/desktop/main/ipc.ts, apps/desktop/main/window-kernel-executor.ts, apps/desktop/main/main.ts, apps/desktop/tests/desktop/visit-dwell.spec.ts]
depends-on: []
---

# Time on page: fill `item_visits.duration` for web pages

Peek item `df3ffc86`, slice "Time on page" of `docs/design/search-rounds.md` ("Candidate first
slices"). Every web page visit gets the time the page was actually in front of the user, not the
time it was open. The seen-before line, the research view and background grouping
(`docs/design/background-grouping.md`) read this later; none of them is part of this slice.

Decisions:

- **Counted time** is time during which all of these hold: the page's window is the window
  kernel's key window, the app is active, and the window is visible. Time behind another window,
  hidden, minimized, or with another app in front does not count.
- **A visit** is the `item_visits` row that `trackWindowLoad()` already writes for a page load.
  It ends at the next tracked navigation in the same window, when the window closes, or when the
  app quits. Navigations that are not tracked (in-page fragment changes, skipped `peek://` and
  OAuth callback URLs) do not end the visit.
- **Unit**: milliseconds, written to the existing `item_visits.duration` column. Nothing reads the
  column today except the `avgVisitDuration` statistic.
- **Written once per visit**, when it ends, as one `UPDATE`. A visit still open when the process
  dies keeps duration 0; no periodic flush in this slice.
- **Main only.** No code runs inside the page. The signals come from the window kernel's state,
  not from new Electron focus or blur listeners: the executor already holds `key` and
  `appActive`, and observing their change after each dispatch is the one source of truth
  (`apps/desktop/CLAUDE.md`, "Transient windows" and the window kernel files).
- Session-restored windows (`skipTracking`) get no visit and so no duration, matching today.
- Applies to every web page, in a space or not (`docs/design/search-rounds.md` "Decided").

## What the code does now

- `main/datastore.ts trackNavigation()` finds or creates the URL item and calls
  `recordItemVisit()`, which inserts an `item_visits` row with `duration` 0 and returns its id.
  `trackWindowLoad()` wraps it and returns `visitId`.
- `main/ipc.ts`: the hybrid page-host's initial load calls `trackWindowLoad()` right after
  `wireHybridContentEvents()`; the `did-navigate` handler inside `wireHybridContentEvents()` calls
  it again for each tracked navigation (`source: 'navigation'`). Both discard `visitId` today.
- `main/window-kernel-executor.ts`: `dispatch()` moves the kernel `State`, whose `key` field is
  the key window id and `appActive` the app's active state; `keyWindow(state)` returns the key
  record. `recordTimeline()` already compares `prev.key` with `next.key` per dispatch.

## What changes

- New `main/visit-dwell.ts`, pure, no Electron or datastore imports: a small state machine per
  window holding the open visit id, accumulated milliseconds, and the instant counting last
  started (or null). Events: `visitStarted(windowId, visitId, now)`,
  `inFront(windowId, now)` / `notInFront(windowId, now)`, `visitEnded(windowId, now)`. A started
  visit while one is open ends the old one first. `visitEnded` returns
  `{ visitId, durationMs }` for the caller to write; events for unknown windows are ignored. The
  clock is passed in, never read.
- A thin owner in main wires it: the two `trackWindowLoad()` call sites in `main/ipc.ts` pass
  their `visitId` to `visitStarted`; after each executor dispatch, the window entering or leaving
  "key, app active and visible" gets `inFront` / `notInFront`; window close and app quit call
  `visitEnded` for open visits and write each result.
- `main/datastore.ts`: `setItemVisitDuration(visitId, durationMs)`, one `UPDATE item_visits SET
  duration = ? WHERE id = ?`.

## Measure the cost

`docs/design/search-rounds.md` "Decided" requires every capture slice to measure page load and
input latency with and without it. Add an environment switch `PEEK_VISIT_DWELL=off` that skips
the wiring. Load a local test page 20 times in a page window with and without it and record
median and 90th-percentile time from `loadURL` to `did-finish-load` under `**Result**` in the
handoff. This slice runs no code in the page, so input latency is recorded as not affected, with
that reason.

## Tests to change

New `main/visit-dwell.test.ts`: in front for a span then out (counts the span); never in front
(0); in front, out, in front again (sums both spans); visit ended while in front (counts up to
the end); a new visit started while one is open (old one ended with its time, new one starts at
0 and counts only if still in front); events for an unknown window ignored.

New `tests/desktop/visit-dwell.spec.ts` on a test profile: open a local page in a page window and
keep it key for about 1.5 s; open a second page window on top and keep it key for about 1 s; close
both. The first page's visit has a duration between 1 and 2.5 s that excludes the time behind the
second window; the second's is between 0.5 and 2 s.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "visit-dwell|history-unified|hybrid-overlay"
```

Done when the unit tallies report `fail 0`, the new tests pass, the other collected specs show no
new failure compared with `apps/desktop/tests/gate-baseline.md`, and the cost numbers are in the
handoff. Record the `test:grep` pass/fail count under `**Result**` in the handoff.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing, especially "Electron is
ONE backend": the dwell logic must not name Electron concepts. Run one command per Bash call.
