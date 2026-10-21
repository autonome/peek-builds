---
enabled: true
touches: [apps/desktop/main/overlay-frame.ts, apps/desktop/main/overlay-frame.test.ts, apps/desktop/main/ipc.ts, apps/desktop/renderer/page/overlay.js, apps/desktop/tests/desktop/hybrid-overlay.spec.ts]
depends-on: []
---

# The address bar waits 2 seconds before covering a page flush with the screen top

Peek item `bf879b8c`. When a page window is maximized, or its top edge sits at the top of the
screen's work area, hovering the top of the page reveals the address bar straight away, and the
bar then covers the page's own top elements (account menu, home link, site nav) so they cannot be
clicked. Shifting the page content down was tried and rejected.

## What the code does now

- `main/ipc.ts wireHybridContentEvents()` watches the content view's idle (no-button) mouse moves.
  On entering the top strip (`dy <= REVEAL_ENTER_PX`, 4 px below the host's top edge) it publishes
  `page-overlay:content-pointer {phase:'reveal'}`; on leaving the band (`REVEAL_EXIT_PX`, 44 px)
  it publishes `phase:'reveal-out'`. It emits only on band enter and exit (`inRevealBand`).
- `renderer/page/overlay.js` subscribes to `page-overlay:content-pointer` and calls
  `showNavbar()` on `reveal` and `scheduleHide()` on `reveal-out`, at once.
- The same `wireHybridContentEvents()` already reads the host's display work area in
  `fillsWorkArea()` (`screen.getDisplayNearestPoint(...).workArea`, `WORK_AREA_MATCH_PX` slop).

## What changes

1. A pure function in `main/overlay-frame.ts`, beside `NAVBAR_HEIGHT` and `GUTTER_TOP`, takes the
   host's screen bounds and its display's work area and returns the reveal delay in ms:
   `2000` when the host's top edge is within `GUTTER_TOP` of the work area's top (maximized, or
   flush or nearly flush with the top), `0` otherwise. The 2 s value is a named constant, not a
   setting.
2. `wireHybridContentEvents()` computes that delay from `hostBounds()` and the host's work area
   when it emits `reveal`, and carries it on the message (`delayMs`).
3. `overlay.js` shows the navbar at once when `delayMs` is 0 or absent, as now. Otherwise it arms
   one pending reveal that fires `showNavbar()` after `delayMs`, and a `reveal-out` for the same
   window before it fires cancels it. A second `reveal` while one is pending does not restart or
   duplicate it. The pending reveal is one variable owned by the subscriber, cleared on fire and on
   cancel; no polling.
4. Nothing else about the band changes: enter strip, exit band, the gutter's own reveal loop for a
   window with room above it, and Cmd+L.

## Tests to change

- `main/overlay-frame.test.ts`: the delay function returns 2000 for a maximized host (bounds equal
  the work area), 2000 for a floating host whose top edge is a few px below the work-area top,
  0 for a host with more than `GUTTER_TOP` of room above it, and handles a work area with a
  non-zero `y` (a menu bar or top panel).
- `tests/desktop/hybrid-overlay.spec.ts`, the "top-border gesture reveal (363e7cff)" case: add a
  maximized-host case asserting the navbar is not shown shortly after a top-strip move and is
  shown after about 2 s, a case where leaving the band before 2 s leaves it hidden, and keep the
  existing floating case's immediate reveal.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "top-border gesture reveal"
```

Done when the unit tallies report `fail 0`, including the new delay-function tests. The
`hybrid-overlay.spec.ts` cluster fails on Linux (`apps/desktop/tests/gate-baseline.md`), so the
`test:grep` run here is not the check: record its pass/fail count under `**Result**` in the
handoff, with whether the new cases fail for the same reason as the cluster's recorded failures.
The spec run on macOS is the sign-off check and is left to the account holder.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing. Run one command per
Bash call.
