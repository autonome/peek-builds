---
enabled: true
touches: [apps/mobile/src/App.tsx, apps/mobile/src/App.css, apps/mobile/src/sync-gate.js, apps/mobile/src/sync-gate.d.ts, apps/mobile/tests/sync-gate.test.js, apps/mobile/src-tauri/src/lib.rs]
depends-on: []
---

# Mobile sync: skip offline attempts, coalesce triggers, never hang, show progress

Peek items `344fcf81` (sync only with a network), `3512d804` (debounce sync), `b4388f41` (the sync indicator spins forever offline) and the mobile half of `537c5836` (the pending count must visibly drain during a run; the desktop half has shipped).

## Problems

1. Automatic sync fires on every interval tick and every foreground return even when the device has no network. The failure toast then appears for nothing.
2. Flipping the app in and out of the foreground runs a full sync each time. A foreground return just after an interval tick runs two syncs back to back.
3. With the device offline, the settings gear and the corner dot keep animating. A failed sync must stop the animation within seconds and show the failure once.
4. A long push shows "Syncing..." for minutes with nothing moving. The settings view must show a number that changes while a sync runs.

## What the code does now

`apps/mobile/src/App.tsx`:
- `syncAll()` sets `isSyncing`, invokes `sync_all`, shows toasts, and clears `isSyncing` in `finally`, so the JS side clears the flag on failure. `pullFromServer()` and `pushToServer()` do the same around `pull_from_server` and `push_to_server`. Only `pushToServer()` calls `loadSyncStatus()` on success and not in `finally`.
- The auto-sync `useEffect` (deps `webhookUrl, isSyncing, syncIntervalMs, syncIntervalMinutes`) runs `syncAll()` from a `setInterval` and from a `visibilitychange` handler. It checks only the `isSyncing` closure value. It has no network check and no debounce.
- `loadSyncStatus()` invokes `get_sync_status` (pending count) and `get_sync_failed_count`. The settings sync section shows `syncStatus.pending_count` only when it is above 0, and the button label is "Syncing..." while `isSyncing`.
- `isSyncing` drives `.settings-btn.syncing svg` (the spinning gear) and `.auto-sync-indicator.syncing` in `App.css`.

`apps/mobile/src-tauri/src/lib.rs`:
- `pull_from_server` and `push_to_server` build `reqwest::Client::new()`, which has no timeout. This is the likely cause of "spins forever": the `invoke` never returns while offline, so the JS `finally` never runs. Only `fetch_and_store_offline_content` sets a 30 s timeout.
- `sync_all_internal` runs push, then pull, then `set_last_sync`.
- `get_sync_status` returns `pending_count` from the core. Each pushed item is marked synced one by one, so the count falls during a push.

There is no reachability check anywhere in the app. `navigator.onLine` is unused.

## Decisions

- Network detection uses `navigator.onLine` plus the window `online` and `offline` events. No native plugin. It can read true on a captive network, so the Rust timeouts (below) remain the backstop.
- The debounce is leading-edge. The first trigger runs at once. Any automatic trigger within 10 s of the last sync attempt is dropped. Both the interval tick and the foreground return use it. A manual sync from settings always runs and also stamps the attempt time. The `isSyncing` guard stays.
- Skipped automatic attempts make no toast and set no state. The next tick or foreground return syncs once the device is online. No extra sync is fired on the `online` event.
- Add `.connect_timeout(10s)` and `.timeout(60s)` to every `reqwest::Client::new()` reached from `sync_all_internal` (`pull_from_server`, `push_to_server` and any helper they call), via one small shared builder. The timeout is per request, so a push of thousands of items is unaffected.
- Progress is the cheap slice only. While `isSyncing && showSettings`, poll `loadSyncStatus()` every 1 s and show the live pending count (`N items pending`, shown while a sync runs even at 0 so the line does not vanish). The button label becomes `Syncing... (N pending)`. No Rust event streaming and no batching.
- The end-of-run summary is the existing `syncMessage` ("Synced: X pulled, Y pushed") plus the existing failed-count line. Move `loadSyncStatus()` into the `finally` of `pullFromServer()` and `pushToServer()`, as `syncAll()` already does.
- The pure decision goes in a new `apps/mobile/src/sync-gate.js` (with a `.d.ts` beside it, as `auto-list.js` does): `shouldAutoSync({ online, lastAttemptAt, now, minGapMs })` returns `{ run: boolean, reason: 'offline' | 'debounced' | null }`. `App.tsx` keeps the last-attempt time in a ref and reads the latest values from refs. The interval and visibility handlers are registered by an effect that re-runs on `isSyncing`, so closure values go stale.

## What changes

- `sync-gate.js` and `sync-gate.d.ts` as above.
- `App.tsx`: use the gate in the auto-sync effect (interval and visibility). Stamp the attempt time in `syncAll()`, and in `pullFromServer()` and `pushToServer()` too. Track online state with a ref and event listeners. Add the polling effect, the button label and the pending line. Add `loadSyncStatus()` to the `finally` of pull and push.
- `src-tauri/src/lib.rs`: the timeouts.
- `App.css`: only if the pending line needs a style.

## Tests to change

New `apps/mobile/tests/sync-gate.test.js`, in the style of `auto-list.test.js` (`node:test`, `node:assert/strict`, import from `../src/sync-gate.js`):
1. Offline blocks. Online with no previous attempt runs.
2. A second trigger inside the window is debounced. One at or after the window runs.
3. Offline wins over the debounce reason.
4. A manual path that skips the gate is not modelled here (by design).

## Verify

Worker runs and records:
1. `yarn mobile:build` (tsc && vite build) succeeds.
2. `node --test apps/mobile/tests/sync-gate.test.js` reports `fail 0`.
3. `node --test apps/mobile/tests/*.test.js` shows no new failure.

The Rust timeout edit in `src-tauri` is compile-checked only by a simulator or device build. Per `apps/mobile/CLAUDE.md`, mobile Rust builds run only from the standing mobile workspace. If the worker is not there, record "src-tauri change not compiled" under `**Result**`.

Manual check (no automated UI test; either platform works, and the UI is shared). The worker cannot run it. Record these steps under `**Result**` as awaiting a manual check by the account holder:
1. `yarn mobile:ios:sim:run` (or `yarn mobile:android:dev`), with the sync interval set short in settings.
2. Set airplane mode and leave the app in the foreground across two or more intervals. Expected: no sync attempt, no failure toast, no spinning.
3. Background and foreground the app while still offline. Expected: no sync attempt and no toast.
4. While offline, tap Sync All in settings. Expected: the attempt runs, the failure is shown once, and the gear stops spinning within a few seconds.
5. Turn airplane mode off and wait one interval. Expected: a sync completes on its own.
6. Background and foreground the app four or five times within a few seconds, online. Expected: one sync, not one per foreground.
7. Tap Sync All twice in a row. Expected: both run.
8. With enough pending items that a push takes tens of seconds, open settings and tap Sync All. Expected: the pending count visibly falls during the run, and afterwards the button returns to normal and the summary shows.

## Working rules

`apps/mobile` is one React + TypeScript UI shared by iOS and Android through Tauri 2 (`apps/mobile/src/App.tsx`, `store.ts`; Rust core `apps/mobile/peek-core`; shell `apps/mobile/src-tauri`). Read `apps/mobile/CLAUDE.md` first. Build with the root yarn scripts, never raw `xcodebuild` or `cargo tauri`. Run one command per Bash call.
