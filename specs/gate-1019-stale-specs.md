---
enabled: true
touches: [apps/desktop/tests/desktop/spaces-delete.spec.ts, apps/desktop/tests/unit/spaces-delete-confirm.test.js, apps/desktop/tests/desktop/transient-on-blur.spec.ts, apps/desktop/tests/desktop/page-translate-front-window.spec.ts, apps/desktop/tests/desktop-serial/modal-self-close-on-blur.spec.ts, apps/desktop/main/hybrid-overlay.ts, apps/desktop/main/entry.ts, apps/desktop/tests/gate-baseline.md]
depends-on: []
---

# Four Linux gate failures on main at 48210abe

The 2026-10-19 Linux gate on `48210abe` failed seven tests. Three passed when re-run alone
(`hybrid-escape-editable-guard.spec.ts` "ESC with an empty editable focused opens the switcher",
`permission-prompt.spec.ts` "Remember + Allow persists", `windows-hidden-surface.spec.ts` "the
switcher hidden-windows toggle lists a hidden quick-view window"). Four fail alone too, and none
is in `apps/desktop/tests/gate-baseline.md`. Rule (Peek `57895545`, 2026-10-19): shipped code is
presumed correct and tests follow it. A product change is in scope only where the logged run
below shows the product, not the test, is wrong; then stop and record it instead of changing
product code.

## The four, with their diagnosed causes

1. **`spaces-delete.spec.ts`** "deleting a space that is not active moves its saved windows to the
   default space and removes it". Confirm text reads `It has no windows to move.` Cause (read from
   code): the only window the test puts in the space is its own `peek://spaces/home.html`, and
   since `abccba0e` / `96600433` the counts in `features/spaces/home.js loadSpaces()` drop spaces
   chrome (`features/spaces/config.js SPACES_CHROME_URL_PREFIXES`), so `countSpaceWindows` is 0
   and `deleteSpaceConfirmText(name, 0)` is correct. `background.js deleteSpace()` still moves the
   row. Fix, test only: before switching away from the doomed space, open one ordinary web page
   in it and wait until it is in the space's saved row; keep `toContain('default space')` and add
   `toContain('1 window')`. Add a chrome-only case to `tests/unit/spaces-delete-confirm.test.js`
   if the count helper is reachable from there; otherwise leave the unit file alone.
2. **`transient-on-blur.spec.ts`** "overlay attached to a host survives a palette focusing
   (ownership, not role)". First `isVisible(overlayId)` returns false in 76 ms. Cause: the spec's
   `isVisible()` calls `app.window.list({ includeInternal: true })`, and since `fd83aad4` the
   `tile:window:list` handler in `main/tile-ipc.ts` leaves app chrome (`isAppChromeWindow`, roles
   overlay and signal) out unless `includeHidden: true`. Fix, test only: pass
   `includeHidden: true` in `isVisible()` and `waitForHidden()`; both already read `w.visible`.
3. **`page-translate-front-window.spec.ts`** "the offer and the status hide with another window
   in front and come back with theirs". A `widgetBody` poll receives `null`. Suspected, not
   confirmed: the spec drives two real page hosts through the overlay test bridge
   (`hybrid-overlay.ts installTestBridge setActive`), which hides the other real host while it
   holds OS focus; on Linux openbox then moves focus and `sendActiveHandoff` reports a window
   other than the target (or `null`), so `features/translate/window-views.js setView` never draws
   the Spanish offer. The translate code is unchanged since the spec landed (`af689013`); the spec
   has likely never passed on Linux.
4. **`desktop-serial/modal-self-close-on-blur.spec.ts`** "modal:true window is dismissed when
   another window takes focus". The modal is still present. Suspected, not confirmed: on Linux
   `electron-window-backend.ts` sets `restackingTakesFocus`, so `window-kernel.ts
   platformChoseFocus()` treats the synthetic focus from `entry.ts __peek_test.fireWindowFocus`,
   which follows a restack, as the platform's own choice; no `OsFocusGained` sweep runs
   (`selectTransientAutoclose`), and the modal survives. `apps/desktop/CLAUDE.md` ("The
   `waitOverlayReady` timeout on Linux") records the same swallow for fake hosts, fixed by
   `installTestBridge showFocused()`. Open: that rule landed `59494974` (2026-09-29), before the
   last recorded gate, so the timing is unexplained.

## What to do

- Items 1 and 2: apply the test fixes above.
- Items 3 and 4: first confirm the cause with one logged run each (`main/window-diag.ts wmLog()`
  lines reach the test output; log the `page-overlay:active` payload in `sendActiveHandoff` for
  item 3, and the `platformChoseFocus` verdict for the focused id for item 4), then remove the
  diagnostic lines.
  - Confirmed: fix in the test or the test bridge only. For item 3, make the spec wait until the
    bridge's active id is the target before polling, or use a fake host for the second window.
    For item 4, have `fireWindowFocus` report the focus the way `showFocused()` does, as a
    confirmed focus rather than a world focus after a restack.
  - Not confirmed: record what the log showed under `**Result**` in the handoff, leave that spec
    untouched, and stop on it.
- `gate-baseline.md`: add a dated section "Linux gate on `48210abe` (2026-10-19)" with the runner
  totals (main-process unit 4365 pass / 0 fail, node unit 1321 / 0, desktop 572 / 6 / 24 skipped,
  desktop-serial 54 / 1, components 71 / 0, editor 91 / 0), the three intermittent tests above,
  and each of the four marked fixed or still failing with its cause. Do not rewrite the older
  sections.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "deleting a space|survives a palette focusing|the offer and the status hide"
HEADLESS=1 BACKEND=electron ./scripts/playwright-with-display.sh test --config apps/desktop/playwright.config.ts --project=desktop-serial --workers=1 --grep "modal:true window is dismissed"
```

Done when the node unit tally reports `fail 0`, the `test:grep` run collects 3 tests and the
serial run collects 1, and every one passes except any item recorded as not confirmed. Record each
run's pass/fail count under `**Result**` in the handoff.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing. Test bridge changes stay
behind the existing test-only guards. Run one command per Bash call.
