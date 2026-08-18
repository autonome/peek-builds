# Desktop Electron gate — failing-spec baseline (Linux)

> **This file records the LINUX failing set only.** A macOS gate run has nothing here to diff
> against, so "diff the failing set against gate-baseline.md" is not a usable macOS procedure —
> attribution on macOS means A/B against the tree without the change. The first macOS gate run on
> `wip/window-kernel-executor` is recorded under "First macOS gate run" at the bottom; it is ONE
> run and does not meet this file's own two-consecutive-runs bar, so it is an observation rather
> than a baseline.

`yarn test:desktop:electron` cannot go green on Linux. A portion of its specs assert macOS
window-server behaviour or headless paint suppression that this platform cannot produce, and a
further group fails to an overlay-publish defect that is timing-dependent.

**Judging a change against this gate means diffing the failing spec set against the list below,
not reading the failure count.** The count moves between identical runs, so counting alone reports
a flake as a regression and hides a real regression that lands while a flake happens not to fire.

Recorded from two consecutive runs of `yarn test:desktop:electron:bg` on the same tree, on Linux
under the Xvfb/openbox harness in `scripts/playwright-with-display.sh`. Runs took ~14 and ~15
minutes and both completed cleanly; the wrapper exits 1 whenever any runner fails, so a non-zero
exit is the expected state.

## Runner totals

| Runner | Pass | Fail |
|---|---|---|
| main-process unit | 2637 | 0 |
| node unit | 743 | 0 |
| desktop | 398–403 | 27–32 |
| desktop-serial | 39 | 1 |
| components | 64 | 0 |
| editor | 91 | 0 |

Any failure in main-process unit, node unit, components or editor is a regression — those four are
green on this platform.

**One qualification on `components` and `editor`, learned the expensive way.** Both run in
plain chromium against their own static server and never launch Electron, so no change to the
main process — the window manager included — can reach them. A failure there that is a 60-second
timeout ending in `Target page, context or browser has been closed` is the harness losing its
browser, not a regression: `peek-navbar-autocomplete.spec.ts` produced exactly that on the last
test of the run, then passed 64 of 64 in 6 seconds on an immediate re-run of the same tree. Re-run
the runner once before treating a failure in either as real, and if a main-process change is the
suspect, note that it has no path to these two runners at all.

## Deterministic failures — present in every run

These reproduced identically across both runs. A change is clean if its failing set is a subset of
this list plus the intermittent list below.

### desktop (27)

| Spec | Test | Cause |
|---|---|---|
| `cmd-url-ghost.spec.ts` | titled history URL still shows ghost and is not mirrored into the command registry | unclassified |
| `cmd-url-ghost.spec.ts` | Backspace rejects the selected completion, leaving the bare typed text | unclassified |
| `headless-no-focus-theft.spec.ts` | canvas page-host window does not steal focus after open | headless paint |
| `headless-no-focus-theft.spec.ts` | page-host window does not paint after open in headless | headless paint |
| `headless-no-permission-flash.spec.ts` | page-host window for HTTP origin stays hidden after open | headless paint |
| `hybrid-close-shortcut.spec.ts` | getFocusedWindow() is null while a hybrid host is the active window | macOS first responder |
| `hybrid-cmd-click-open.spec.ts` | cmd-click opens a loaded page, not a blank window | unclassified |
| `hybrid-content-window-gesture.spec.ts` | double-click on dead content maximizes the host window | overlay race |
| `hybrid-content-window-gesture.spec.ts` | dead-space double-click with an incidental selection elsewhere STILL maximizes | overlay race |
| `hybrid-content-window-gesture.spec.ts` | double-click on a `<button>` does NOT maximize | overlay race |
| `hybrid-content-window-gesture.spec.ts` | a double-click whose second press drags past slop does NOT maximize | overlay race |
| `hybrid-overlay.spec.ts` | clicking the chrome (overlay focus on content blur) does NOT deactivate | overlay race |
| `hybrid-overlay.spec.ts` | repeat Cmd+L (press 2) re-reveals + refocuses the navbar in the overlay renderer | overlay race |
| `hybrid-show-activate.spec.ts` | applied show path is focus-free under headless | headless paint |
| `hybrid-transient-on-blur.spec.ts` | opening (focusing) a second hybrid quick-view closes the first | not Linux-only — also fails 4/4 packaged on macOS (2026-08-18) |
| `izui-escape.spec.ts` | a page opened FROM a palette-role opener is classified content, never child-content | unclassified — see note |
| `page-layout.spec.ts` | navbar can be revealed while the host is maximized | overlay race |
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

These fired in the second run only. Their presence is not a regression and their absence is not a
fix; both states have been observed on an unchanged tree.

| Spec | Test |
|---|---|
| `cmdl-navbar-no-resize.spec.ts` | Cmd+L shows the navbar without maximizing or resizing the window |
| `headless-no-focus-theft.spec.ts` | headless never registers the system-wide Escape global shortcut |
| `hybrid-content-window-gesture.spec.ts` | double-click on an `<input>` does NOT maximize |
| `hybrid-overlay.spec.ts` | a hybrid window becoming active while the app is INACTIVE must not reveal the chrome |
| `page-layout.spec.ts` | double-click navbar triggers maximize |

## Causes

- **overlay race** — identified by a single diagnostic string: `overlay renderer never became
  usable: moduleReady=…, activeHandoffApplied=…`. Twelve specs share it, which makes it the
  largest single lever on this gate. **These twelve rows are stale as of 2026-08-18 and must be
  re-recorded on Linux before this file is used to judge a change.** The race is live on **both**
  platforms, at different rates: six Linux runs at the current head gave one clean run
  (`docs/design/window-manager.md` § 4.3.1), and four macOS runs against a freshly built package at
  `0f1f6e44` gave 1, 2, 0 and 0 failures. **A clean batch of this file proves nothing** — eight
  consecutive clean macOS runs preceded that 1/2/0/0 batch and were briefly misread as the cluster
  being closed; only a failing batch is informative. The renderer's first-load subscription race this
  diagnostic once named — the handoff publishing before the renderer subscribes, recovered by
  a `did-finish-load` re-send — is closed (`hybrid-overlay.ts wireOverlayReady()` answers the
  renderer's own post-subscribe `page-overlay:ready` declaration instead). This cluster's
  continued failures are now attributed to a second, undiagnosed defect: a subsequent
  activation's handoff (or a content event) fails to land on the renderer even after it is
  demonstrably subscribed (`docs/design/window-manager.md` § 4.3 dim 3b), not to first-load
  subscription timing.
- **headless paint** — `scripts/playwright-with-display.sh` unsets `HEADLESS`/`PEEK_HEADLESS` on
  Linux, because windows must render into Xvfb or Chromium's hidden page-visibility state hangs
  RAF-based waits. Specs asserting the headless paint-suppression path therefore cannot pass here
  by construction.
- **macOS first responder** — `apps/desktop/CLAUDE.md` records this assertion as observable only
  on macOS.
- **missing `swift`** — the window-order probe shells out to `swift` and returns `spawnSync swift
  ENOENT` instead of a front-to-back order list.
- **maximize fidelity** — restored windows do not come back maximized under openbox. Both
  occurrences share that shape.
- **unclassified** — no diagnostic ties these to any cause above. They reproduced in both runs, so
  they are deterministic rather than flaky, and each is a candidate for a real fix.
- **the `izui-escape.spec.ts` row** was recorded under the test's former name, *"regression: ESC on
  a page opened FROM a palette-role opener does NOT close it (full backend path)"*. That test was
  renamed and rewritten: its Escape assertion was vacuous, and the guard is now the opened window's
  classification. The row above carries the current name. Whether it still fails on Linux is
  **unverified** — the rewrite has only been run on macOS, where it passes 6/6 packaged, twice.

## Refreshing this file

Re-record after any change that moves the failing set, and record from at least two consecutive
runs on an unchanged tree — one run cannot distinguish a deterministic failure from a flake, which
is the whole reason this file exists.

## First macOS gate run (2026-08-18, one run — an observation, not a baseline)

`yarn test:desktop:electron:bg` on `wip/window-kernel-executor`, macOS arm64, packaged. Exit 1,
~5.7 min. This is the first time the gate has run over the window-kernel conversion on macOS.

| Runner | Pass | Fail | Skip |
|---|---|---|---|
| main-process unit | — | 1 | — |
| node unit | — | 0 | — |
| desktop | 428 | 4 | 31 |
| desktop-serial | 39 | 1 | — |
| components | 64 | 0 | — |
| editor | 91 | 0 | — |

Failing set, with attribution. Every "pre-existing" verdict is an A/B: the same spec run against a
build with both same-day window-backend changes reverted (the `win.on('show')` ground-truth guard
and the `pendingHideProvokedFocus` focused-window gate).

| Spec | Test | Verdict |
|---|---|---|
| `transient-on-blur.spec.ts:225` | utility focusing does NOT close transient parent (chain popup invariant) | pre-existing — fails with both changes reverted |
| `transient-on-blur.spec.ts:237` | overlay is exempt from auto-close when a palette focuses | pre-existing — fails with both changes reverted |
| `hybrid-transient-on-blur.spec.ts:153` | opening (focusing) a second hybrid quick-view closes the first | pre-existing — 3/3 failing reverted; see `docs/design/window-manager.md` 4.3.2 |
| `desktop-serial/cmd-noun-commands.spec.ts:228` | new note without content signals editor open | pre-existing — fails with both changes reverted |
| `hybrid-maximize-state-sync.spec.ts:89` | overlay keeps its maximized flag when a maximized window is switched away and back | **UNATTRIBUTED** — passed reverted, and passes 4/4 at the tip in isolation. Failed only inside the parallel gate, so flake and load-only interaction are not yet separated. |
| `sync.test.ts` | a failed tag push does not advance the watermark, and the next push retries that tag | **UNATTRIBUTED** — see below |

Two things are NOT established and should not be read as settled:

- **`hybrid-maximize-state-sync.spec.ts:89`** needs a second gate run. Four isolated runs at the
  tip pass, so it does not reproduce outside the gate's parallelism.
- **The `sync.test.ts` failure was never validly measured.** The unit runner could not be
  reproduced standalone: invoked on its own — including with the gate's exact command and cwd — it
  fails roughly twenty sync tests rather than the one the gate reported, so those runs are not
  equivalent and prove nothing. The suspicion that it is unrelated rests only on inspection (it
  drives a fetch stub against a fake server URL, and none of the changed files are in its import
  graph), which is an argument, not evidence. A second gate run is what settles it.

The `transient-on-blur.spec.ts:225`/`:237` verdicts above need a correction beyond "pre-existing".
Both asserted the role-based autoclose exemption (`AUTOCLOSE_FOCUSER_EXEMPT_ROLES` /
`AUTOCLOSE_EXEMPT_ROLES` in the old `window-state.ts`) that `window-kernel.ts
selectTransientAutoclose` deliberately does not carry forward — it replaced the role set with an
ownership relation over `overlayFor` and `parentId`. Neither test staged that relation: the
chain-popup test opened both windows with no parent link at all, and the overlay test opened a
plain `role:'overlay'` window with no `AttachOverlay`. Both have been restaged to stage the
relation the kernel checks (`declareParent` for the parent case, the hybrid-overlay E2E bridge's
`AttachOverlay` for the attached case) and pass.
