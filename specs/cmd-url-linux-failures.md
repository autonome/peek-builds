---
enabled: true
touches: [apps/desktop/tests/desktop/cmd-url-ghost.spec.ts, apps/desktop/tests/desktop/cmd-url-unfocused.spec.ts, apps/desktop/tests/gate-baseline.md]
depends-on: []
---

# Make the "cmd URL" Playwright set green on Linux

`yarn workspace @peek/desktop test:grep "cmd URL"` collects 15 tests on `main` on this Linux box:
11 pass, 4 fail, and the same four fail without any track's changes:

- `cmd-url-ghost.spec.ts` "titled history URL still shows ghost and is not mirrored into the
  command registry" — times out in `waitForFunction` waiting for
  `urlGhostSuggestion.matchable === TITLED_MATCHABLE`.
- `cmd-url-ghost.spec.ts` "ArrowDown to a Visited row then Enter opens that row url" — times out
  waiting for `matches.length === 0 && urlMatches.length >= 2`.
- `cmd-url-ghost.spec.ts` "Backspace rejects the selected completion, leaving the bare typed
  text" — times out waiting for the completion to be filled into `#command-input` with the suffix
  selected.
- `cmd-url-unfocused.spec.ts` "the kernel keeps the page window on screen and never hides the
  app" — fails `expect(appActiveBefore, 'the palette must not have activated the app').toBe(false)`
  with `true`.

`apps/desktop/tests/gate-baseline.md` lists the first three as deterministic desktop failures
("unclassified", "parallel load", "unclassified"). The three ghost tests share one cause, a test
bug. The unfocused test checks behaviour Linux cannot observe.

## What's still live and needs to go

### Three ghost tests drive a stale, hidden panel

Every test in `cmd-url-ghost.spec.ts` opens the panel with
`app.window.open('peek://cmd/panel.html', { keepLive: true, role: 'palette', … })` and no `key`.
Production `renderer/cmd/background.js openPanelWindow()` passes `key: panelAddress`, and
`main/ipc.ts windowOpenHandler` reuses a window only when `options.key` is set. So each test open
creates a new panel window, and the previous panel's close is a keepLive hide, not a destroy — the
wm log shows a fresh `open-registry-set id=wm-N` per open while earlier panels stay hidden until
teardown.

Each test then resolves its panel with `app.getWindow('cmd/panel.html')`, which goes through
`tests/helpers/window-utils.ts waitForWindow()` and returns the first page whose URL matches: the
describe's first panel, now hidden. The new panel is never driven. `renderer/cmd/panel.js` is never
re-shown, so the hidden panel keeps its old `state`, `urlGhostSuggestion` and `urlMatches`, and
`waitForPanelReady()` still passes because the panel is not in `CLOSING`. The first test in every
describe passes; later tests pass only when stale state happens to satisfy their wait, and fail
when they need a fresh ghost query.

The comment on `waitForPanelReady()` already assumes a reused panel ("keepLive panel reuse: the
reopen dispatches VISIBILITY_SHOWN (reset → IDLE)"); that reuse never happens without a `key`.

### The unfocused test asserts a macOS-only activation model

On darwin the kernel's `appActive` is fed only by `did-become-active` / `did-resign-active`
(`main/electron-window-backend.ts attachAppListeners()`), and a `type: 'panel'` palette can take key
without activating the app — the side-task model in `docs/design/window-rules.md` G1, which this
test pins. Off darwin, `main/main.ts` falls back to `app.on('browser-window-focus')` →
`kernelAppActivated()`, so any Peek window gaining OS focus marks the app active. Under
`scripts/playwright-with-display.sh` openbox focuses the newly mapped palette
(`native-focus-arrived`), flipping `appActive` back to `true` right after the test's
`setAppFocusedForTest(false)`. Every later assertion in the test also assumes the app stayed
inactive. `apps/desktop/CLAUDE.md` "What Linux cannot verify at all" covers exactly this; it is not
a product bug.

## What changes

`apps/desktop/tests/desktop/cmd-url-ghost.spec.ts`:

- Every `app.window.open('peek://cmd/panel.html', …)` passes `key: 'peek://cmd/panel.html'`, as
  `openPanelWindow()` and `cmd-url-unfocused.spec.ts` do: the inline opens in the first describe,
  the `openPanel()` helper in each later describe, and the `'cmd URL staged Escape @desktop'`
  describe if `cmd-staged-escape` has landed by then.
- A reopen then reuses the one hidden panel; `tile:lifecycle:visible` delivers `VISIBILITY_SHOWN`,
  which resets it to `IDLE` through `resetAllState`.
- After `getWindow`, each open asserts that `app.windows()` holds exactly one non-closed page whose
  URL contains `cmd/panel.html`, so a regression to duplicate panels fails at once with a clear
  message instead of an 8-second ghost timeout.
- No `sleep`, no `waitForTimeout`, no longer timeouts, no retries. The existing
  `waitForTimeout(1000)` in the substring-match describe is a negative-assertion window and stays.
- If a reopened, keyed panel still fails any of the three tests, stop: record the failure message
  and wm log under **Result** and do not work around it. That would mean the reused panel does not
  reset on `VISIBILITY_SHOWN` — a product bug in `renderer/cmd/panel.js` or
  `renderer/cmd/state-machine.js` outside this spec.

`apps/desktop/tests/desktop/cmd-url-unfocused.spec.ts`:

- `test.skip(process.platform !== 'darwin', '<reason>')` at the top of the test body, the reason
  naming the cause: off darwin `main/main.ts` feeds `kernelAppActivated()` from
  `browser-window-focus`, so a palette taking OS focus activates the app, and Linux cannot observe
  key-without-activation. This follows the platform-conditioned `test.skip` form already in
  `permission-prompt.spec.ts` and `renderer-log-file.spec.ts`. The skip is whole-test because every
  assertion after the palette opens assumes the app stayed inactive.
- The file's header comment gains one sentence: the test runs on macOS only, and Linux coverage of
  the decision lives in the `window-kernel-executor.ts planRaise()` unit tests the comment already
  names.

`apps/desktop/tests/gate-baseline.md`:

- Remove the three `cmd-url-ghost.spec.ts` rows from the deterministic desktop table, and add one
  line under it naming this spec as the fix (the tests drove a stale hidden panel because no `key`
  was passed). Leave the runner totals as recorded.

## What stays

- Every assertion, seed URL, prefix and timeout in the three ghost tests.
- `waitForPanelReady()` and the ordering that keeps Enter-to-`CLOSING` tests last in their
  describe.
- `tests/fixtures/desktop-app.ts getWindow` and `tests/helpers/window-utils.ts waitForWindow()`;
  changing `getWindow` suite-wide is out of scope.
- Every assertion in `cmd-url-unfocused.spec.ts`, unchanged and still enforced on macOS. None is
  loosened, made conditional per line, or rewritten to accept `appActive === true`.
- All product code: the non-darwin `browser-window-focus` → `kernelAppActivated()` fallback in
  `main/main.ts`, key-based reuse in `main/ipc.ts`, `renderer/cmd/panel.js`,
  `renderer/cmd/state-machine.js`.

## Tests to change

Only the two spec files above. No product code, unit test, or new test changes.

## Verify

Run from the worktree and record all counts under **Result**:

```
yarn workspace @peek/desktop test:grep "cmd URL"
yarn workspace @peek/desktop test:unit
```

Done when `test:grep "cmd URL"` collects a nonzero count and reports 0 failed — on this Linux box
15 collected, 14 passed, 1 skipped (16 / 15 / 1 if `cmd-staged-escape` has landed first). The one
allowed skip is the unfocused test with its platform reason; any other skip is a failure, and "No
tests found" is a failure. `test:unit` must report fail 0.

A Linux-green run says nothing about the unfocused test's macOS behaviour; say so under **Result**.
A macOS run of the same command is the sign-off for that test.

## Working rules

Run one command per Bash call.
