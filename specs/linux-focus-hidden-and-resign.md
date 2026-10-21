---
enabled: true
touches: [apps/desktop/main/window-kernel.ts, apps/desktop/main/window-state.ts, apps/desktop/main/window-kernel-executor.ts, apps/desktop/main/electron-window-backend.ts, apps/desktop/main/window-kernel.test.ts, apps/desktop/main/window-state.test.ts, apps/desktop/tests/desktop-serial/cmd-switch-to-page.spec.ts, apps/desktop/tests/desktop/peeks.spec.ts]
depends-on: []
---

# Two transients dismissed by focus nobody gave them (Linux gate, `b445b3af`)

Two failures new in the `b445b3af` Linux gate pass when their spec file runs alone and fail
after particular earlier tests. Both are a transient window (the cmd panel, a peek) dismissed by
the window manager's closing rule (`apps/desktop/CLAUDE.md` "Transient windows: the closing rule",
`window-kernel.ts transientAutocloseExemption()`) because of a focus that no user or Peek action
handed to anything.

## Failure 1: a hidden window keeps the OS focus and brings it back on its next show

`desktop-serial/cmd-switch-to-page.spec.ts` "the URL action follows a window opening and closing
while the panel stays up" fails with `expect.toBeVisible: Target page, context or browser has been
closed`. Reproduce with both tests together; the second passes alone:

```
HEADLESS=1 BACKEND=electron ./scripts/playwright-with-display.sh test --config apps/desktop/playwright.config.ts --project=desktop-serial --workers=1 apps/desktop/tests/desktop-serial/cmd-switch-to-page.spec.ts --grep 'hidden peek|follows a window opening'
```

What the `[wm]` trace shows:

- In "a page open only in a hidden peek shows no URL action", the keep-alive peek is dismissed
  and hidden together with the shared page chrome overlay (`hybrid-overlay.ts`, `wm-1` in the
  trace). About 6 ms after the overlay's hide, openbox reports native focus on the hidden overlay
  (`native-focus-arrived id=wm-1 ... focus-cause-taken kind=world`), and the kernel accepts it.
- In the next test, a page opened with `show: false` makes the overlay attach and show through
  `showInactive`, yet `native-show id=wm-1 focused=true` (`electron-window-backend.ts`, the
  `win.on('show')` handler reads `isFocused()`). The kernel takes that as a machine focus of the
  overlay, and the sweep (`transient-sweep holder=wm-1 cause=machine`) dismisses the cmd panel.
- Run alone, the same show logs `focused=false` and the panel survives.

Also seen in the same trace and possibly related: in the hidden-peek test, Escape in the cmd panel
did not close it (`user-input ... key=Escape`, then the spec's 10 s close wait expired).

Expected: a hidden window holds no focus, so a later non-activating show of it is not a focus.
Decide where this belongs: the kernel ignoring a focus report for a window it holds hidden, or the
backend dropping native focus from a window it hides. A platform where hiding moves focus by
itself needs neither, which favours the kernel rule. Keep Electron names out of the kernel
(`scripts/check-platform-leak.mjs`).

## Failure 2: a just-opened, never-focused peek is dismissed on an app resign

`desktop/peeks.spec.ts` "an explicit size still wins over the display-relative one" fails with
`peek open failed: {"success":false,"error":"ERR_FAILED (-2) loading 'about:blank'"}`: the window
was closed while its page loaded. It failed in the gate's worker `w5` after
"a peek with no size set opens at a share of the display work area"; the file passes alone. To
reproduce, run the specs that preceded it in `w5` of a gate log (`[w5 ...]` tags, in log order)
with `--workers=1`; if it does not reproduce in 10 tries, record that under **Result** and fix
from the trace and a unit test.

What the gate trace shows (`/tmp/test-electron-peek.log` while it lasts):

- The peek `wm-13` shows through `showInactive` with `focused=false`; the only focus report for it
  is suppressed (`os-focus-suppressed id=wm-13 reason=stacking-provoked`).
- 26 ms later the settings window blurs (`native-blur id=wm-4`), the kernel arms the app-resign
  sweep (`app-resign-armed victims=0`), and in the same millisecond the peek is dismissed
  (`effect-close effect=DismissWindow id=wm-13`). Focus returns to `wm-4` 13 ms later.

Expected: the closing rule's resign clause closes a transient the window manager focused. A
transient the window manager never focused (`focusedSinceShown` false on its record) is not
closed by a resign. Find which transition dismissed `wm-13` and why it counted the peek as
focused.

## Tests

- A failing-first unit test for each rule in `window-kernel.test.ts` or `window-state.test.ts`,
  and the `checkClosingRule` property in `window-kernel-properties.test.ts` must still hold.
- No change to either Playwright spec's assertions. A test edit is acceptable only to stop one
  test leaking state into the next (for example destroying the hidden peek through the window
  manager rather than `BaseWindow.destroy()`), and must be stated under **Result** as such.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/window-kernel.test.js apps/desktop/dist/main/window-state.test.js apps/desktop/dist/main/window-kernel-properties.test.js
HEADLESS=1 BACKEND=electron ./scripts/playwright-with-display.sh test --config apps/desktop/playwright.config.ts --project=desktop-serial --workers=1 apps/desktop/tests/desktop-serial/cmd-switch-to-page.spec.ts --repeat-each=5
yarn test:grep 'Peeks @desktop'
yarn test:grep 'Hybrid transient on blur|Hybrid page-host keepLive'
HEADLESS=1 BACKEND=electron ./scripts/playwright-with-display.sh test --config apps/desktop/playwright.config.ts --project=desktop-serial --workers=1 apps/desktop/tests/desktop-serial/modal-self-close-on-blur.spec.ts
```

Done when the unit runs pass, `cmd-switch-to-page.spec.ts` passes 30 of 30, the peeks spec
passes, and the transient-closing specs are no worse than before the change. Linux cannot sign
off focus behaviour (`apps/desktop/CLAUDE.md`, "What Linux cannot verify at all"): record under
**Result** what a macOS check should look at.

## Working rules

Run one command per Bash call.
