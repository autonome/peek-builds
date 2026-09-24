---
enabled: true
touches: [apps/desktop/tests/desktop-serial/cmd-url-window-reuse.spec.ts]
depends-on: []
---

# Deflake cmd-url-window-reuse: never drive a closing cmd panel

Peek item `5a54699f`. The test `"opening an already-open URL via cmd reuses the window instead of
duplicating"` in `apps/desktop/tests/desktop-serial/cmd-url-window-reuse.spec.ts` intermittently
fails with `keyboard.press: Target page, context or browser has been closed` during the second
`openViaCmd('example.com')`.

## What's still live and needs to go

`openViaCmd()` opens `peek://cmd/panel.html` with no `key`/`keepLive`, then resolves the page with
`app.getWindow('cmd/panel.html', 5000)`. For Electron, `apps/desktop/tests/fixtures/desktop-app.ts`
`getWindow` calls `window-utils.ts waitForWindow()`, which returns the first page whose URL
matches without checking `isClosed()` or liveness. After the first cycle's Enter, the helper only
waits for `_cmdState.currentState` to leave `TYPING`, and swallows the error if the page is already
gone. The first panel is still being torn down when the second cycle starts, so the second
`getWindow` can resolve that first panel page, which then closes under `fill`/`keyboard.press`.

## What changes

All changes are in the spec file:

- `openViaCmd()` returns the panel `Page` it drove.
- Before the second `openViaCmd`, the test waits until the first panel's `Page` has closed:
  `firstPanel.isClosed()`, or else `await firstPanel.waitForEvent('close')`. This is the
  deterministic teardown signal.
- In the second cycle, the page is resolved by picking from `app.windows()` a `cmd/panel.html`
  page that is not closed and is not the previous handle — not a bare
  `getWindow('cmd/panel.html')`. The new panel page is proven distinct and live before `fill`
  runs.
- No `sleep`, no `waitForTimeout`, and no timeout used as synchronization.
- If the first panel page never emits `close` (the panel is kept alive and reused rather than
  destroyed), stop and record that on the item instead of working around it: it contradicts the
  item's root-cause hypothesis.

## What stays

- Every assertion: `__exampleOpenedCount` stays `1` after the second open; exactly one example.com
  window, with the same id; the focused-id check, which runs only when `HEADLESS` is unset.
- The `window:opened` counter setup and the cleanup `window.close`.
- `tests/fixtures/desktop-app.ts` and `tests/helpers/window-utils.ts`. Changing `getWindow` for the
  whole suite is out of scope.

## Tests to change

Only `cmd-url-window-reuse.spec.ts`, as described above. No product code or unit tests change.

## Verify

The spec lives in the `desktop-serial` project. `yarn workspace @peek/desktop test:grep` hard-codes
`tests/desktop/` and would report "No tests found", so run the project directly from source after
building, and record the counts under **Result**:

```
yarn workspace @peek/desktop build
HEADLESS=1 BACKEND=electron ./scripts/playwright-with-display.sh test --config apps/desktop/playwright.config.ts --project=desktop-serial --workers=1 --grep 'Cmd URL window reuse' --repeat-each=20
```

Done when Playwright reports 20 passed, 0 failed, and no "Target page, context or browser has been
closed" error appears. "No tests found" is a failure. On Linux the focus assertion runs for real,
because the display wrapper unsets `HEADLESS`; if only that assertion fails, record it separately —
it is a focus observation, not this race.

## Working rules

Run one command per Bash call.
