# Desktop Electron gate — failing-spec baseline (Linux)

`yarn test:desktop:electron` cannot go green on Linux. A portion of its specs assert macOS
window-server behaviour or headless paint suppression that this platform cannot produce, and a
further group fails to an overlay renderer-subscription race that is timing-dependent.

**Judging a change against this gate means diffing the failing spec set against the list below,
not reading the failure count.** The count moves between identical runs, so counting alone reports
a flake as a regression and hides a real regression that lands while a flake happens not to fire.

Recorded from two consecutive runs of `yarn test:desktop:electron` on an unchanged tree at
`43cda804`, on Linux under the Xvfb/openbox harness in `scripts/playwright-with-display.sh`. The
desktop runner took 15.7 and 15.0 minutes and both runs completed cleanly; the wrapper exits 1
whenever any runner fails, so a non-zero exit is the expected state.

## Runner totals

| Runner | Pass | Fail |
|---|---|---|
| main-process unit | 2667 | 0 |
| node unit | 743 | 0 |
| desktop | 398–400 | 31–33 |
| desktop-serial | 39 | 1 |
| components | 64 | 0 |
| editor | 91 | 0 |

The desktop runner also skips 28. Any failure in main-process unit, node unit, components or
editor is a regression — those four are green on this platform.

## Deterministic failures — present in every run

These reproduced identically across both runs. A change is clean if its failing set is a subset of
this list plus the intermittent list below.

### desktop (31)

| Spec | Test | Cause |
|---|---|---|
| `cmd-url-ghost.spec.ts` | titled history URL still shows ghost and is not mirrored into the command registry | unclassified |
| `cmd-url-ghost.spec.ts` | ArrowDown to a Visited row then Enter opens that row url | parallel load |
| `cmd-url-ghost.spec.ts` | Backspace rejects the selected completion, leaving the bare typed text | unclassified |
| `headless-no-focus-theft.spec.ts` | canvas page-host window does not steal focus after open | headless paint |
| `headless-no-focus-theft.spec.ts` | page-host window does not paint after open in headless | headless paint |
| `headless-no-focus-theft.spec.ts` | headless never registers the system-wide Escape global shortcut | headless paint |
| `headless-no-permission-flash.spec.ts` | page-host window for HTTP origin stays hidden after open | headless paint |
| `hybrid-close-shortcut.spec.ts` | getFocusedWindow() is null while a hybrid host is the active window | macOS first responder |
| `hybrid-cmd-click-open.spec.ts` | cmd-click opens a loaded page, not a blank window | unclassified |
| `hybrid-content-window-gesture.spec.ts` | double-click on dead content maximizes the host window | overlay race |
| `hybrid-content-window-gesture.spec.ts` | dead-space double-click with an incidental selection elsewhere STILL maximizes | overlay race |
| `hybrid-content-window-gesture.spec.ts` | double-click on an `<input>` does NOT maximize | overlay race |
| `hybrid-content-window-gesture.spec.ts` | double-click on a `<button>` does NOT maximize | overlay race |
| `hybrid-content-window-gesture.spec.ts` | double-click ON selected text does NOT maximize | overlay race |
| `hybrid-content-window-gesture.spec.ts` | a double-click whose second press drags past slop does NOT maximize | overlay race |
| `hybrid-overlay.spec.ts` | repeat Cmd+L (press 2) re-reveals + refocuses the navbar in the overlay renderer | overlay race |
| `hybrid-show-activate.spec.ts` | applied show path is focus-free under headless | headless paint |
| `hybrid-transient-on-blur.spec.ts` | opening (focusing) a second hybrid quick-view closes the first | unclassified |
| `izui-escape.spec.ts` | ESC on a page opened FROM a palette-role opener does NOT close it | unclassified |
| `page-layout.spec.ts` | navbar can be revealed while the host is maximized | overlay race |
| `page-layout.spec.ts` | double-click navbar triggers maximize | overlay race |
| `peeks-lazy-wake.spec.ts` | the default Option+0 wake hotkey is registered at boot without the renderer | unclassified |
| `permission-prompt.spec.ts` | geolocation request renders overlay prompt with origin + favicon; Deny resolves PERMISSION_DENIED | overlay race |
| `permission-prompt.spec.ts` | Allow path: geolocation proceeds | overlay race |
| `permission-prompt.spec.ts` | Remember + Deny persists | overlay race |
| `permission-prompt.spec.ts` | Remember + Allow persists | overlay race |
| `permission-prompt.spec.ts` | window close auto-denies: pending count drops to 0 | overlay race |
| `reopen-closed-window.spec.ts` | reopen a maximized hybrid page-host restores it maximized | maximize fidelity |
| `session-restore-coldstart.spec.ts` | cold-start restore fires the ordered z-order re-assert for every page-host | missing `swift` |
| `session-restore-page-host.spec.ts` | maximized hybrid page host: maximize state survives save+restore | maximize fidelity |
| `slides-lazy-wake.spec.ts` | cli:slide-open wakes the lazy tile and opens the slide window | unclassified |

### desktop-serial (1)

| Spec | Test | Cause |
|---|---|---|
| `cmd-noun-commands.spec.ts` | new note without content signals editor open | unclassified |

## Intermittent failures — present in one run, absent in the other

| Spec | Test |
|---|---|
| `cmdl-navbar-no-resize.spec.ts` | Cmd+L shows the navbar without maximizing or resizing the window |
| `hybrid-overlay.spec.ts` | clicking the chrome (overlay focus on content blur) does NOT deactivate |

`hybrid-overlay.spec.ts` "a hybrid window becoming active while the app is INACTIVE must not
reveal the chrome" was intermittent in the previous recording and passed in both runs here. It is
listed nowhere above; treat a fresh failure of it as another flake rather than a regression until
a recording catches it twice.

## Causes

- **overlay race** — the renderer subscribes after the handoff is published and the
  `did-finish-load` re-send never lands. Identified by a single diagnostic string: `overlay
  renderer never became usable: moduleReady=…, activeHandoffApplied=…`. Fourteen specs share it,
  which makes it the largest single lever on this gate.
- **headless paint** — `scripts/playwright-with-display.sh` unsets `HEADLESS`/`PEEK_HEADLESS` on
  Linux, because windows must render into Xvfb or Chromium's hidden page-visibility state hangs
  RAF-based waits. Specs asserting the headless suppression path therefore cannot pass here by
  construction.
- **macOS first responder** — `apps/desktop/CLAUDE.md` records this assertion as observable only
  on macOS.
- **missing `swift`** — the window-order probe shells out to `swift` and returns `spawnSync swift
  ENOENT` instead of a front-to-back order list.
- **maximize fidelity** — restored windows do not come back maximized under openbox. Both
  occurrences share that shape.
- **parallel load** — fails in the full gate but passes when run alone via `yarn test:grep`, so
  the assertion holds and the contention is the harness's. Deterministic within the gate, which is
  why it is listed above rather than as a flake.
- **unclassified** — no diagnostic ties these to any cause above. They reproduced in both runs, so
  they are deterministic rather than flaky, and each is a candidate for a real fix.

## Refreshing this file

Re-record after any change that moves the failing set, and record from at least two consecutive
runs on an unchanged tree — one run cannot distinguish a deterministic failure from a flake, which
is the whole reason this file exists.
