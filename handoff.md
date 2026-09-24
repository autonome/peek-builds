# cmd-panel focus regression

## Goal

Pages opened from the cmd panel must stay on the macOS desktop where they were opened and behave as ordinary windows: clicking another app hands focus to it, and switching desktops does not drag the user back. Peek item: `f46a44ad`.

## Current state

The implementation is complete and committed. The only required sign-off still missing is the human-gesture live macOS check described below.

The fix is commit `16db3e92`:

- `apps/desktop/main/ipc.ts` no longer assigns `options.type = 'panel'` to a page requested from the command panel while another app is active. It retains `activation = 'user'` and the `page-opens-as-side-task` log, so the ordinary window activates Peek and receives typing.
- `apps/desktop/main/izui-roles.ts` now documents `pageOpensAsSideTask()` as an intent marker, not a window-type declaration.
- `apps/desktop/tests/desktop/cmd-url-unfocused.spec.ts` expects an ordinary (`nonActivating === false`) window and retains the `RaiseWindow(...):user` assertion; panel-only key/hold/Escape assertions were removed.
- `docs/design/window-rules.md` documents the activating behavior and the Electron limitation: panel windows are pinned to every desktop at construction and `setVisibleOnAllWorkspaces(false)` cannot clear that membership without a native addon.

Temporary tracing was removed by reverts `e2a50a83` and `579f75cc`. The contradictory disabled reopen-on-blur proposal was removed by `b2c5c087`. Historical commits `3a2c7806` and `c4890f69` remain in history and cancel each other exactly; they were not rewritten because this session is forbidden to rebase.

## Automated verification

All final-tree checks pass:

- `yarn workspace @peek/desktop build` — pass
- `NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js` — 826 passed
- `NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js` — 3357 passed
- `yarn test:grep 'cmd URL open while the app is in the background'` — 1 passed both before and after the fix, and again after diagnostic cleanup
- `node scripts/check-platform-leak.mjs` — pass

One concurrent invocation of the compiled-main tests raced with `yarn test:grep` rebuilding/deleting `dist` and reported 73 `MODULE_NOT_FOUND` failures. Running the exact compiled-main command alone immediately afterward passed all 3357 tests; this was an orchestration race, not a product failure.

`yarn test:desktop:electron` and all variants were not run, per the explicit user prohibition.

## Resume Here

Perform only the live macOS check; do not redo implementation or automated verification unless the tree changes.

1. The old `diag-poll` tracing is intentionally no longer in the final tree. If log-based confirmation is required, temporarily reapply the changes from commits `04b128d5` and `7fb2cf85` without retaining them in the final history, then rebuild. Otherwise the same behavior can be checked visually.
2. Run `yarn kill`, then launch this worktree with fresh profile `PROFILE=agent-cmd-panel-fix-1`.
3. Have the person perform only this gesture: on desktop 2 with another app frontmost, open a URL from the cmd panel, click Finder, press cmd+N, and switch desktops. Do not ask them to run commands or inspect logs.
4. Confirm the new page is an ordinary window: it remains on desktop 2, Finder receives focus after the click (and cmd+N opens a Finder window), and switching desktops does not pull the page along or return the user to desktop 2. If tracing was temporarily restored, confirm the page host reports `isVisibleOnAllWorkspaces=false` and `isFocused` drops after the Finder click, then remove the tracing again and verify the tree is clean.
5. Update this handoff with the live result and commit it. If the check passes, the next step is `/land cmd-panel-focus-regression`. If it fails, preserve the exact observed behavior and logs here.

The branch is not yet ready to land solely because the human-gesture live check has not occurred.
