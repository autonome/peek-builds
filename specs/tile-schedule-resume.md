---
enabled: true
touches: [apps/desktop/main/tile-schedule.ts, apps/desktop/main/tile-schedule.test.ts, apps/desktop/main/system-resume.ts, apps/desktop/main/system-resume.test.ts, apps/desktop/main/electron-window-backend.ts, apps/desktop/main/main.ts]
depends-on: []
---

# Peeklet schedules catch up after the machine sleeps

Peek item `f9e278fb`. `main/tile-schedule.ts` arms one timer per schedule entry
(`armEntry()` → `scheduleFire()`). When the machine sleeps mid-interval the timer fires late,
so a feature on a 15-minute schedule (`features/feeds`, topic `feeds:poll`) can run up to a full
interval late after resume. Nothing in `apps/desktop/main/` listens for system resume today.

`armEntry()` already computes the right delay from the persisted `lastRunAt`: zero when the
interval has elapsed (once, however many intervals were missed), otherwise the remainder. The
fix is to run it again for every armed entry on resume.

Decisions:

- **`tile-schedule.ts` exports `rearmTileSchedules()`**: when `startTileSchedules()` has not run
  yet it does nothing; otherwise it calls `armEntry(tileId, entry)` for every entry in
  `scheduledTiles`, the same loop `startTileSchedules()` runs. `scheduleFire()` already clears
  an entry's existing timer, so no entry ends up armed twice.
- **A new neutral module, `main/system-resume.ts`**, carries the signal with no Electron
  vocabulary: `onSystemResume(listener: () => void): () => void` (returns an unsubscribe) and
  `notifySystemResume()`, which calls every listener and logs, without rethrowing, a listener
  that throws. Plus `__resetSystemResumeForTest()`.
- **The Electron backend is the only source**: `electron-window-backend.ts
  attachAppListeners()` adds `powerMonitor.on('resume', notifySystemResume)`. A backend without
  the concept never calls `notifySystemResume()`, and schedules keep today's behaviour.
- **`main.ts loadFeatures()`** registers `onSystemResume(rearmTileSchedules)` right after its
  `startTileSchedules(…)` call.
- `scripts/check-platform-leak.mjs` must stay clean: `powerMonitor` appears only in
  `electron-window-backend.ts`.

## Tests to change

Written first and failing:

- `main/tile-schedule.test.ts`, a "resume" suite using `__setTileScheduleDepsForTest()` with the
  injected clock, timers and store, interval 15 minutes, entry started and `lastRunAt` set:
  - clock advanced 40 minutes past `lastRunAt` with the original timer not fired, then
    `rearmTileSchedules()`: the entry fires exactly once, immediately, not three times;
  - clock advanced 5 minutes, then `rearmTileSchedules()`: the entry is re-armed for the
    remaining 10 minutes and does not fire before;
  - `rearmTileSchedules()` before `startTileSchedules()` arms nothing.
- `main/system-resume.test.ts`: listeners run on `notifySystemResume()`; an unsubscribed
  listener does not; a throwing listener does not stop the next one.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
node scripts/check-platform-leak.mjs
```

Done when both unit tallies report `fail 0`, the new suites pass, and the platform-leak check
passes. Record the main-process unit pass/fail count under `**Result**` in the handoff.
Unverified by this run: a real sleep and resume, which needs the laptop.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app; read it before editing, especially "Electron
is ONE backend". Change only the files in `touches`. Run one command per Bash call.
