---
enabled: false
touches: [apps/desktop/features/spaces/**, apps/desktop/features/groups/home.js, apps/desktop/main/session.ts, apps/desktop/main/session.test.ts, apps/desktop/main/session-projection.ts, apps/desktop/main/session-projection.test.ts, apps/desktop/main/session-save-filter.ts, apps/desktop/main/entry.ts, apps/desktop/main/tile-ipc.ts, apps/desktop/main/tile-preload.cts, apps/desktop/main/tile-api.d.ts, apps/desktop/main/tile-session-enforcement.ts, apps/desktop/main/ipc.ts, apps/desktop/main/main.ts, apps/desktop/tests/desktop/*.spec.ts, docs/design/window-rules.md]
depends-on: []
---

**Disabled 2026-09-22:** the migration this spec describes already landed on
`main` through direct commits (`1e5b795e`, `058216ab`, `11cfd7cd`) rather than
the tracked spec-watch flow — `apps/desktop/features/spaces/background.js`
already calls `restoreSessionSnapshot()`/`saveSessionSnapshot()`, not the old
per-space save path. Disabled so a spec-watch tick doesn't start it as new work
against code that already satisfies it.

# Workspaces save and restore through the session snapshot pipeline

Peek item `5ccc51fc`. Read it with `mcp__peek__get_item` (`itemId: "5ccc51fc"`,
`maxContentLength: -1`) if that tool is available; this file carries everything needed if it is
not.

## Problem

The workspace feature (`apps/desktop/features/spaces/background.js`) persists and reopens a
workspace's windows through its own path: `main/session.ts saveSpaceWorkspaces()` writes a
`space-workspaces` row per space via `main/session-projection.ts serializeSpaceWorkspaces()`, and
`background.js enterWorkspace()` reopens each entry with a hand-rolled `api.window.open()` loop.
`session.ts saveGlobalPinnedWindows()` / `restoreGlobalPinnedWindows()` add a third list for
cross-workspace pins, restored at boot from `main/entry.ts` outside the test profile.

That is a partial reimplementation of the shutdown/startup session snapshot
(`session.ts saveSessionSnapshot()` / `restoreSessionSnapshot()`), which already carries bounds,
z-order, focus, navigation state, scroll, maximize/fullscreen, mode metadata, the closed-window
stack, crash state and the restore-focus sequence. The workspace path reproduces a subset badly:
no nav history, no focus/z-order replay, no first-frame ordering, its own reopen loop. Switching
workspaces on a real profile loses state the app already knows how to keep.

`features/groups/home.js` also calls `api.session.saveSpaceWorkspaces()`; it changes with the
rest.

## Requirements

1. A workspace is a named session snapshot. Entering one restores that snapshot through
   `restoreSessionSnapshot` (or a keyed variant of it); leaving saves the current windows through
   `saveSessionSnapshot` under the current workspace's key, then closes them. The default
   workspace is the startup snapshot, or a snapshot keyed `default`: one code path either way.
2. `serializeSpaceWorkspaces()`, the `space-workspaces` `feature_settings` rows and the reopen
   loop in `enterWorkspace()` are removed. Whatever a workspace needs beyond a plain snapshot
   (pin scope per window, workspace id) becomes fields of the snapshot descriptor read by the one
   projection, `session-projection.ts serializeSession()`.
3. Cross-workspace pins are windows the switch excludes from save-and-close and from restore,
   not a third persisted list. If a pin list must survive relaunch it is part of the same
   snapshot format. `saveGlobalPinnedWindows()` and `restoreGlobalPinnedWindows()` are removed,
   along with the `entry.ts` boot call and the `forceRestoreGlobalPins` test bridge.
4. Feature chrome the spaces feature creates on demand (the panel opened by
   `background.js showPanel()`, the border) is never persisted by any snapshot. The exclusion is
   an explicit property the window carries (a role class, or a `persist: false` open option
   honoured by `serializeSession()`), not a URL match. Today `serializeSession()` skips only
   `overlay`-role windows and non-focusable `utility` windows, so a `panel`-role window is saved.
5. Startup restore and a workspace switch call the same function with a different key. The perf
   and focus behaviour of startup restore applies to a switch unchanged.
6. `git grep -e serializeSpaceWorkspaces -e saveSpaceWorkspaces -e saveGlobalPinnedWindows -e restoreGlobalPinnedWindows`
   returns nothing, apart from this spec.
7. A new desktop spec asserts round-trip fidelity: open a page, navigate twice, scroll, switch
   away, switch back; back/forward history, scroll position, bounds and z-order survive, the same
   as quit/relaunch keeps them today.
8. `workspace-default.spec.ts`, `workspace-panel.spec.ts`, `pin-workspace-and-global.spec.ts`,
   `pin-session-restore.spec.ts`, `external-link-default-workspace.spec.ts` and
   `space-workspace-page-host.spec.ts` pass against the new path, rewritten where they asserted on
   the removed rows.
9. `apps/desktop/features/spaces/DESIGN.md` and the "Persistent windows" section of
   `docs/design/window-rules.md` describe the new persistence path where they described the old.

## Verify

The repo gate (`tracks.json` `verify`) runs only the unit tests. Run the desktop specs too and
record the pass/fail counts in the handoff's `**Result**` section:

```
yarn workspace @peek/desktop test:grep "workspace|pin-"
yarn workspace @peek/desktop test:grep "session-restore"
```

Done when every matched spec is green and the new fidelity spec (requirement 7) passes.
`apps/desktop/tests/gate-baseline.md` lists failures known on this machine; a failure named there
is not caused by this work.

## Working rules

- `apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing.
- Run one command per Bash call; use the `yarn` scripts, never `npx playwright` directly.
- Nothing here deploys or touches a real profile. Tests run under the `PEEK_PROFILE` the
  namespace sets.
