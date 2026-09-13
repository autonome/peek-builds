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
| `hybrid-transient-on-blur.spec.ts` | opening (focusing) a second hybrid quick-view closes the first | RESOLVED — stale staging; see "Resolved: the second-quick-view staging" |
| `izui-escape.spec.ts` | a page opened FROM a palette-role opener is classified content, never child-content | unclassified — see note |
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
| `cmd-noun-commands.spec.ts` | new note without content signals editor open | RESOLVED — asserted against a page that is meant to close; see "Resolved: the new-note editor signal" |

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

- **overlay race** — identified by a single diagnostic string: `overlay renderer never became
  usable: moduleReady=…, activeHandoffApplied=…`. Fourteen specs share it, which makes it the
  largest single lever on this gate. The race is live on **both** platforms, at different rates:
  six Linux runs at an earlier head gave one clean run (`docs/design/window-manager.md` § 4.3.1),
  and four macOS runs against a freshly built package at `0f1f6e44` gave 1, 2, 0 and 0 failures.
  **A clean batch of this file proves nothing** — eight consecutive clean macOS runs preceded that
  1/2/0/0 batch and were briefly misread as the cluster being closed; only a failing batch is
  informative. The renderer's first-load subscription race this diagnostic once named — the handoff
  publishing before the renderer subscribes, recovered by a `did-finish-load` re-send — **is
  closed**: `hybrid-overlay.ts wireOverlayReady()` answers the renderer's own post-subscribe
  `page-overlay:ready` declaration instead of a load event it can arrive after. This cluster's
  continued failures are attributed to a second, undiagnosed defect: a subsequent activation's
  handoff (or a content event) fails to land on the renderer even after it is demonstrably
  subscribed (`docs/design/window-manager.md` § 4.3 dim 3b), not to first-load subscription timing.
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
| `hybrid-transient-on-blur.spec.ts:153` | opening (focusing) a second hybrid quick-view closes the first | **RESOLVED** — stale staging, not a defect; see "Resolved: the second-quick-view staging" below |
| `desktop-serial/cmd-noun-commands.spec.ts:228` | new note without content signals editor open | **RESOLVED** — see "Resolved: the new-note editor signal" below |
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

## Second macOS gate run (2026-08-20) — both unattributed failures settled

`yarn test:desktop:electron:bg` on `wip/window-kernel-executor` at `ca9b613f`, macOS arm64,
packaged. Exit 1. Run over a tip carrying the peek slot-key fix, the restore-source fix and the
hybrid key-namespace fix.

| Runner | Pass | Fail | Cancelled |
|---|---|---|---|
| main-process unit | 3365 | 0 | 20 |
| node unit | 743 | 0 | — |
| desktop | 432 | 1 | — |
| desktop-serial | 39 | 1 | — |
| components | 64 | 0 | — |
| editor | 91 | 0 | — |

The failing set is exactly two, both already carried as pre-existing:
`hybrid-transient-on-blur.spec.ts:153` and `desktop-serial/cmd-noun-commands.spec.ts:228`. Both
have since been resolved — neither was a product defect; both were tests staged against behavior
the machine no longer has. See the two "Resolved:" sections below.

### Resolved: the second-quick-view staging

`hybrid-transient-on-blur.spec.ts` "opening (focusing) a second hybrid quick-view closes the
first" was a stale staging, not a defect, and the behavior it names is correct at the tip.

The spec opened quick-views A and B back to back, asserted both alive, and only then fired a
synthetic focus at B to make A close. Under the kernel, opening B *is* the focus: an activating
show arms a self-caused focus token, `electron-window-backend.ts attachNativeListeners`
(`win.on('focus')`) reports it with `cause.kind === 'machine'`, and both suppression arms
(`pendingStackingFocus`, `pendingHideProvokedFocus`) deliberately decline to suppress a
machine-caused focus. So `OS_FOCUS_GAINED` lands for B at open time,
`window-kernel.ts selectTransientAutoclose` runs with B as the focuser, and A — an earlier
`openSeq` sibling with no parent or overlay relation to B — is dismissed there. The old machine
granted no attention on open, which is what the mid-test `expect(hybridAlive(a)).toBe(true)`
encoded.

The failure was on that precondition, not on the outcome: the test's own final assertion (A
closes, B stands) was already true, one step earlier than staged. The test now asserts A alive
before B opens, then polls A dead after the open. All 5 tests in the file pass source-only.

### Resolved: the new-note editor signal

`desktop-serial/cmd-noun-commands.spec.ts` "new note without content signals editor open" was
asserting against a page the product deliberately closes. It failed only when run after its
neighbour, with the symptom alternating between runs — `ERR_FAILED (-2) loading
'peek://cmd/panel.html'` on the next panel's load, and `page.press: Target page ... has been
closed` at the Enter press. Alone it passed. That alternation is why it read as unclassified.

The kernel timeline named the transition (`window-kernel-executor.ts timelineForTests`), which no
state snapshot could:

```
#53 OsFocusGained(wm-10) eff=[RaiseWindow(wm-10),DismissWindow(wm-9),SetStacking(wm-10)]
#55 WindowDirectCloseRequested(wm-9) → #56 WindowClosed(wm-9)
```

`wm-9` is the test's own cmd panel and `wm-10` the editor window its Enter press opened. Both
`new note` paths end in the state machine's CLOSING arm and publish `editor:add`
(`renderer/cmd/commands/notes.js executeNewNote` returns mimeType `item` with content and
`new-item` without; `renderer/cmd/state-machine.js` routes both through `isEditorMimeType`), so an
editor window opens asynchronously and takes focus. The palette being dismissed when it opens a
page is intended behavior. The test then ran `waitForCmdNotExecuting` against that closing page,
and the editor window it left open drifted into the neighbouring test and took focus there too.

The test now awaits the `window:opened` event for the editor — the state transition itself, so
there is nothing to poll — and closes that window. That await IS the assertion, and it is stronger
than the `not TIMEOUT` / `not ERROR` checks it replaces, which passed without establishing that an
editor ever opened. A page-closed error from the Enter press is tolerated because it is the
behavior under test; any other error rethrows. All 4 tests in the file passed 4/4 runs.

**`hybrid-maximize-state-sync.spec.ts:89` passed.** Together with 4/4 isolated passes at the
previous tip, its single failure in the 2026-08-18 gate reads as flake rather than a load-only
interaction. Not proof of the absence of one — a second failure in a later gate would reopen it.

**The `sync.test.ts` failure is an install gap, not a defect, and never was one.** `sync.test.js`
requires `apps/server/index.js`, which requires `hono`. `hono` is declared in
`apps/server/package.json` but is installed nowhere in the tree, because **`apps/server` is not in
the root `workspaces` list** (`apps/desktop`, `apps/mobile`, `packages/*`). Every `before` hook in
that suite throws `MODULE_NOT_FOUND`, and its ~20 tests are CANCELLED rather than failed.

That also explains the earlier measurement that "did not reproduce": ~20 sync tests standalone
versus the one the gate reported is the same cause seen at two different truncation points, not
two inequivalent runs.

**Read the `cancelled` column, not just `fail`.** The runner prints cancelled tests under a
"failing tests:" heading while its summary line says `fail 0` — so a suite that cannot load its
own imports presents as a passing runner. That is why this went unattributed for two gate runs.

**RESOLVED 2026-08-21:** `apps/server` was added to the root `workspaces` list, so `hono`
installs and the suite loads. The main-process unit runner now reports **3385 pass / 0 fail /
0 cancelled**, against 3365 pass / 20 cancelled before. The `cancelled` count remains worth
reading on every gate run for exactly the reason above.

### Third macOS gate run — 2026-08-21

Run at commit `20cd3b75`, before the `workspaces` fix. **Every Playwright runner green, and the
two long-standing failures are gone.**

| runner | pass | fail | cancelled |
|---|---|---|---|
| main-process unit | 3365 | 0 | 20 |
| node unit | 743 | 0 | 0 |
| desktop | 433 | 0 | — |
| desktop-serial | 40 | 0 | — |
| components | 64 | 0 | — |
| editor | 91 | 0 | — |

The failing set is **empty**. `hybrid-transient-on-blur.spec.ts:153` and
`desktop-serial/cmd-noun-commands.spec.ts:228` both pass — see the two "Resolved:" sections above;
neither was a product defect. The run still exited 1, on the 20 cancelled sync tests alone, which
the `workspaces` fix landed immediately after this run closes. `hybrid-maximize-state-sync.spec.ts:89`
passed again, which is its second consecutive pass and leaves its single 2026-08-18 failure reading
as flake.

**Not re-run after the `workspaces` fix.** That change was verified against the main-process unit
runner (3385/0/0) and a clean typecheck, not against a full gate.

### Fourth macOS gate run — 2026-09-04

Run at commit `f7a35e57` on `wip/window-kernel-executor`, the first full gate on that branch.

| runner | pass | fail | skipped |
|---|---|---|---|
| main-process unit | 3208 | 0 | — |
| desktop | 429 | 6 | 31 |
| desktop-serial | 40 | 0 | — |
| components | 64 | 0 | — |
| editor | 91 | 0 | — |

Six `desktop` failures, all attributed:

- **Three deterministic and pre-existing**, fixed in the commit that follows this run:
  `hybrid-transient-on-blur.spec.ts:139`, `:153` and `:201`. One cause — the page-host compat
  preload was attached to http(s) content only, so a `data:` quick-view never reported its first
  frame, never became `orderable`, and was never a dismissal candidate. Confirmed by A/B against the
  `dcf05a91` versions of the changed files, so the failures predate the session that found them.
  Write-up: `docs/design/window-manager.md`, "Open kernel defects".
- **Three flakes**, each of which passed on a source-mode re-run in isolation and again in a
  packaged-build run (`PACKAGED=1`, the same `out/mac-arm64/Peek.app` this gate produced, all 58
  tests of the three files passing): `hybrid-content-window-gesture.spec.ts:153` (double-click on
  dead content maximizes the host window), `hybrid-overlay.spec.ts:2168` (hold-to-drag: navbar
  background HOLD then move), and `izui-escape.spec.ts:311` (a page opened FROM a palette-role
  opener is classified content — failed in setup, `window.open` of a palette-role window returned
  `success:false`). None reproduces outside the parallel gate, so flake and load-only interaction
  are not separated for them, as for `hybrid-maximize-state-sync.spec.ts:89` above.

### Fifth macOS gate run — 2026-09-04, evening

Run at commit `b625b2b3`, which makes `electron-builder.yml` exclude `.tmp/`. A first attempt
at the commit before it failed 130 desktop and 11 serial specs with
`electron.launch: Process failed to launch!` on every spec: the packed root `package.json` was a
1370-byte fragment because a `.tmp/` scratch file changed size while electron-builder streamed
the archive. Not a test result; the exclusion fixed it and the run below is the real one.

| runner | pass | fail | skipped |
|---|---|---|---|
| main-process unit | 3208 | 0 | — |
| node unit | 743 | 0 | — |
| desktop | 433 | 2 | 31 |
| desktop-serial | 40 | 0 | — |
| components | 64 | 0 | — |
| editor | 91 | 0 | — |

Two `desktop` failures:

- `hybrid-overlay.spec.ts:1879` (top-border reveal also works in the GUTTERED case) — passes in a
  packaged isolation re-run, so flake.
- `hybrid-transient-on-blur.spec.ts:153` (opening a second hybrid quick-view closes the first) —
  **real, packaged-only.** In a packaged isolation re-run of the file, `:139` fails too and `:201`
  passes; in source mode all five pass. Both failing tests open a quick-view and then focus
  another window within milliseconds; `:201` waits for an app resign. The quick-view's
  first-frame report (`hybrid:first-frame` → `WindowContentOrderable`) lands later in the packaged
  app, after the focuser's `OsFocusGained` has already run the transient sweep, and
  `window-kernel.ts evolve`'s `WindowContentOrderable` arm only flips the flag — nothing re-applies
  the transient law when a candidate becomes orderable under a focuser that already holds key. A
  kernel rule waiting to be written; tracked in this branch's `handoff.md`.

### Sixth macOS gate run — 2026-09-04, night

Run at commit `561e15ca`, which adds the orderable-flip sweep to `window-kernel.ts react`.
Immediately before it, the 50-cycle peek harness (`scripts/peek-open-cycle.mjs`, visible
instance, `DEBUG=1`, no `E2E_TEST`) passed 50 of 50 with 0 destroyed peeks and 0 `world`-cause
dismissals within 100ms of open, so the new rule spares a slow-painting peek as intended.

| runner | pass | fail | skipped |
|---|---|---|---|
| main-process unit | 3209 | 0 | — |
| node unit | 743 | 0 | — |
| desktop | 435 | 0 | 31 |
| desktop-serial | 40 | 0 | — |
| components | 63 | 1 | — |
| editor | 91 | 0 | — |

`desktop` is clean for the first time on this branch: `hybrid-transient-on-blur.spec.ts:139` and
`:153`, the two packaged-only failures of the fifth run, pass under the new rule, and the
`hybrid-overlay.spec.ts:1879` flake did not recur.

One `components` failure, `peek-navbar-autocomplete.spec.ts:148` (inline ghost fills the input and
natively selects the completion suffix), received `"it"` where `"github.com"` was expected — the
typed prefix arrived truncated. The file passes 7 of 7 in 1.8s on an immediate isolated re-run of
the same tree, and per the qualification above the `components` runner never launches Electron, so
no main-process change can reach it. Harness flake, not a regression.

### Seventh macOS gate run — 2026-09-13

Run at commit `2ec459d4`: a raise command no longer writes `key` (`84a180b4`), a closed key
window requests a successor raise (`8458ac93`), an Escape whose landed window is not the key
holder is dropped (`e889af3a`), Enter runs the ghost suggestion's row (`c51cac09`), and twelve
comment-only commits.

| runner | pass | fail | skipped |
|---|---|---|---|
| main-process unit | 3248 | 0 | — |
| node unit | 747 | 0 | — |
| desktop | 425 | 10 | 31 |
| desktop-serial | 40 | 0 | — |
| components | 64 | 0 | — |
| editor | 91 | 0 | — |

The ten `desktop` failures, each re-run in isolation with `HEADLESS=1 PACKAGED=1`:

- `cmd-enter-runs-suggestion.spec.ts:167` and `hybrid-escape-close.spec.ts:145` pinned the
  rules that `c51cac09` and `e889af3a` overturned. Repinned at `4a6a7636`; both files green.
- `command-chaining.spec.ts:54` and `:127` (`ERR_FAILED loading peek://cmd/panel.html`) pass 9
  of 9 in isolation. In the gate a cause-less world focus landed on the settings window while
  the panel was loading and the sweep dismissed it: focus shuffling between parallel headless
  instances. Gate-only.
- The other six fail deterministically in isolation and share one cause. Under headless,
  `window-kernel-executor.ts planRaise` answers `'inactive-show'`, whose effect is
  `showWindow(id, { activate: false, opSeq })`; the backend echoes only `WindowShown`, never the
  `OsFocusGained` that is now the sole writer of `key`. A raised window therefore never becomes
  key in headless, `lastAttention` stays on the settings window's boot-time world focus, and:
  - `slides-lazy-wake.spec.ts:190`, `slides-settings-race.spec.ts:110`,
    `peeks-settings-race.spec.ts:95`, `hybrid-transient-on-blur.spec.ts:227`: the window opens
    and is dismissed 60–80 ms later by the first-paint sweep (`evolve WindowContentOrderable`)
    against that stale attention (`open-registry-set` then `effect-close effect=DismissWindow`,
    no `transient-sweep` between).
  - `hello-world-escape-switcher.spec.ts:43`: key is still the settings window, so the D2 rule
    drops the press (`esc-pass-a outcome=nothing reason=stale-landing`).
  - `izui-escape.spec.ts:311`: the page raised from the palette never gets `OsFocusGained`, so
    no sweep runs and the palette survives. Deterministic now, not the earlier flake.
  Smallest fix: the `'inactive-show'` arm of `performEffect`'s `RaiseWindow` case passes
  `activate: true`; `showWindow` already masks OS activation under headless and echoes the
  caller's intent, so `kernelWindowShown(id, true, opSeq)` produces the confirming
  `OsFocusGained` with the raise's opSeq. Reproduced at the unit level against
  `dist/main/window-kernel.js` for both the dismissal and the Escape branch. Not yet applied.
