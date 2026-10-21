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

### desktop (28)

| Spec | Test | Cause |
|---|---|---|
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

Three `cmd-url-ghost.spec.ts` rows are gone from this table, fixed by
`specs/cmd-url-linux-failures.md`: every panel open in that spec omitted `key`, so each open built
a new window while `getWindow` kept returning the first one, hidden by keepLive and holding stale
ghost state. The opens now pass `key: 'peek://cmd/panel.html'` as production does, the one panel
is reused and reset on show, and each open asserts that exactly one live panel exists. The table
header count moves from 31 to 28; the runner totals above are left as recorded.

### desktop-serial (1)

| Spec | Test | Cause |
|---|---|---|
| `cmd-noun-commands.spec.ts` | new note without content signals editor open | RESOLVED — asserted against a page that is meant to close; see "Resolved: the new-note editor signal" |

## Intermittent failures — present in one run, absent in the other

| Spec | Test |
|---|---|
| `hybrid-overlay.spec.ts` | clicking the chrome (overlay focus on content blur) does NOT deactivate |
| `reopen-closed-window.spec.ts` | open → close → reopen brings the URL back |
| `editor-query-tag-action-key.spec.ts` | u after x puts the tags back and the block returns |

`editor-query-tag-action-key.spec.ts` "u after x puts the tags back and the block returns" failed
once, in the 2026-10-12 full gate on `bbe79458`, at the `x` step: the item's tags had become
`['done']`, but its `.qs-block` was still in the query view 10 s later. The spec alone passed 15/15 (5 repeats) on
the same packaged build. Not yet reproduced with the specs that preceded it in its worker.

`reopen-closed-window.spec.ts` "open → close → reopen brings the URL back" passed in both runs
recorded above and failed in a later gate run. Three isolated runs of that spec alone on an
unchanged tree gave pass, fail, pass, so it is timing-dependent rather than a regression the later
run introduced. The maximize-fidelity failure in the same spec is deterministic and stays listed
above.

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
  **One Linux-only share of this cluster is diagnosed and fixed at `0013a7a9`:** specs that open a
  REAL host through `app.window.open` and activate it through the bridge's `setActive` lost the
  chrome because the bridge hid the focused host first. The rows here that open real hosts
  (`page-layout.spec.ts`, `hybrid-content-window-gesture.spec.ts`, and five in
  `permission-prompt.spec.ts`) should leave the failing set; the fake-host rows should not. See
  "Linux single-spec A/B of the bridge `setActive` fix" below.
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

## Linux single-spec A/B of the bridge `setActive` fix (2026-09-14)

Not a gate run, and the tables above are not re-recorded from it: each row is one spec file run
alone (source build, `--workers=1`, Xvfb + openbox) at `0013a7a9` ("fixed") and at the same head
with only `hybrid-overlay.ts` restored to its parent ("unfixed"). It exists because two of the
"overlay race" rows above have a diagnosed cause, and a later gate run should expect the failing
set to move.

**The diagnosed cause.** `hybrid-overlay.ts installTestBridge setActive(id)` hid every visible
base-layer page host, the target included, before reporting the target shown and focused. For a
REAL host (opened through `app.window.open`) that hide is a native hide of a window holding real
OS focus, which Linux runs grant. openbox hands focus to the settings window;
`electron-window-backend.ts` suppresses one hide-provoked focus, but two arrive, and the second
raises the settings window above the host. `window-kernel.ts topmostBaseLayerPageHost` then answers
null, the chrome detaches, and `waitOverlayReady` reports `activeHandoffApplied: false`. Fake hosts
(`makeFakeHybridWindow`) hold no OS focus, so they were never affected. `0013a7a9` leaves the
target out of the hide.

| Spec | Unfixed | Fixed |
|---|---|---|
| `desktop-disruptive/hybrid-content-window-gesture-fullscreen.spec.ts` | 2 of 2 failed, 2 runs | 2 of 2 passed, 3 runs |
| `hybrid-content-window-gesture.spec.ts` | not re-run at this head | 6 of 6 passed, 1 run |
| `page-layout.spec.ts` | not re-run at this head | 5 of 5 passed, 1 run |
| `permission-prompt.spec.ts` | 6 failed, 1 run | 2 failed, 1 run |
| `hybrid-overlay.spec.ts` | 20 and 23 failed, 2 runs | 20 and 21 failed, 2 runs |

- **`permission-prompt.spec.ts`.** The five rows in the deterministic table above (geolocation
  Deny, Allow path, Remember + Deny, Remember + Allow, window close) all open real hosts; four of
  them failed unfixed and all five pass fixed. Two tests missing from the table above fail on BOTH
  trees: "queueing: two requests show ONE prompt…" and "background-window deferral: request for a
  non-active window stays queued; surfaces on setActive". Both use fake hosts, so the fix cannot
  reach them. Run alone on the fixed build (2 runs), background-window deferral failed both times
  and queueing passed both times, so queueing's failure depends on the tests before it.
- **`hybrid-overlay.spec.ts`.** Roughly twenty tests fail on both trees, and the fix does not move
  the set: the tests that differ between the four runs ("retarget is focus-free", "maximize snaps to
  work area", "a hidden host must not leave the chrome revealed", "entities panel renders…", "Cmd+L
  reveals the navbar AND focuses the URL field") are the race `docs/design/window-manager.md`
  § 4.3.1 records. The table above lists only "repeat Cmd+L (press 2)" as deterministic, so for this
  file the table is stale at this head. The cause of the growth since `43cda804` is not attributed;
  every test in the file uses fake hosts, so it is not the mechanism above.
- **`hybrid-content-window-gesture.spec.ts` and `page-layout.spec.ts`** pass fixed, but their
  unfixed state was not re-measured at this head, so "fixed by `0013a7a9`" is inferred from the
  mechanism (both open real hosts through `app.window.open`) and the table above, not A/B'd.

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

### Eighth macOS gate run — 2026-09-13, night

Run at commit `fbdbf3e3`: the seventh run's headless fix applied — `performEffect`'s
`RaiseWindow` `'inactive-show'` arm shows with `activate: true`, so `showWindow`'s echo lands the
confirming `OsFocusGained` under headless. Green; the first green gate on this branch.

| runner | pass | fail | skipped |
|---|---|---|---|
| main-process unit | 3249 | 0 | — |
| node unit | 747 | 0 | — |
| desktop | 435 | 0 | 31 |
| desktop-serial | 40 | 0 | — |
| components | 64 | 0 | — |
| editor | 91 | 0 | — |

The six specs the seventh run attributed to the headless cause all pass, in isolation and in the
gate. `command-chaining.spec.ts` passed in the gate this time; the focus shuffle it recorded is
still gate-only and still possible. No flakes.

One observation from the isolation runs before the gate, not reproduced in the gate:
`hybrid-transient-on-blur.spec.ts:139` ("a focused workspace window closes a hybrid quick-view
sibling") timed out three times in a row when run alone, because the quick-view's first-paint
report (`evolve WindowContentOrderable`) landed about 3.1 s after the window opened instead of
about 60 ms; reverting the one-line fix restored 60 ms. In the gate the same case passed in
307 ms. The dismissal itself is correct either way; only its latency in a fresh, single-spec
instance is open. No timer in the window-manager code accounts for 3 s.

### Ninth macOS gate run — 2026-09-14

Run at commit `1bbc7366`, with `tangled/main` merged in (40 commits: sync, MCP server, notes,
none in the window manager) and the raise-echo fix `296cf83d`. Green.

| runner | pass | fail | skipped |
|---|---|---|---|
| main-process unit | 3264 | 0 | — |
| node unit | 759 | 0 | — |
| desktop | 437 | 0 | 31 |
| desktop-serial | 40 | 0 | — |
| components | 64 | 0 | — |
| editor | 91 | 0 | — |

Between the eighth run and this one, a run at `1bbc7366`'s parent tree (the merge without the
fix) failed two `desktop` cases: `hybrid-content-window-gesture.spec.ts:227`, the overlay race
in the intermittent table above, and `hybrid-transient-on-blur.spec.ts:139`. The eighth run's
note on that case was wrong about the cause: the quick-view's first paint arrives on time
(60–75 ms). What raced was the anchor's world focus against the paint. `react`'s key-change
rule raises the window a world report just handed key to, and the backend echoes that raise as
a machine-caused `OsFocusGained` about 1 ms later; `evolve` recorded the echo as fresh machine
attention, so a transient that painted after the echo was spared by the ordering floor as
`newer-than-focuser`, and one that painted before it was dismissed. `296cf83d` makes a raise
echo for the window already holding key re-confirm the standing attention (fresh `seq`, same
cause). Live shares the path through `raiseWindow`'s `kernelWindowShown(id, true, opSeq)`.

Packaging note: `electron-builder --dir` failed twice in a row with `certificate has expired`
from a network fetch inside electron-builder, then succeeded on the same command with no
change. A gate that dies there has not run any test; rerun it.

### Tenth macOS gate run — 2026-09-14

Run at commit `a63df259`, the restore-activation fix over the talk-deck move `b8c51d9e`.
Green.

| runner | pass | fail | skipped |
|---|---|---|---|
| main-process unit | 3265 | 0 | — |
| node unit | 759 | 0 | — |
| desktop | 437 | 0 | 31 |
| desktop-serial | 40 | 0 | — |
| components | 64 | 0 | — |
| editor | 91 | 0 | — |

The fix: session restore's cold-start focus block passes user activation intent, so the
saved-focused window's raise runs `app.focus({ steal: true })` through the same channel the
palette uses (`session.ts restoreSessionSnapshot`, `windows.ts showHybridHost`). Before it,
a packaged launch with another app frontmost left that app frontmost, restore lifted a
different window to the top, and every window past the eager five stayed black because its
deferred load is released only by host OS focus. Hand check on a packaged build against a
clone of the production profile, launched with the terminal frontmost: Peek came to the
front, the window frontmost at quit was key, and no window was black after a minute. All
three symptoms shared the missing activation; the stack-import key re-lift and the
focus-gated deferred load are still in the code but no longer produce a symptom.

### Eleventh macOS gate run — 2026-09-14

Run at commit `19fa3f8a`, the peek-input change-event fix plus the Features Manager
search-field focus, over `d96e8dce`. Green.

| runner | pass | fail | skipped |
|---|---|---|---|
| main-process unit | 3265 | 0 | — |
| node unit | 759 | 0 | — |
| desktop | 439 | 0 | 31 |
| desktop-serial | 40 | 0 | — |
| components | 64 | 0 | — |
| editor | 91 | 0 | — |

The fix: `peek-input` renders its native `<input>` inside a shadow root, and the native
`change` event is not composed, so it never reached the `change` listener the Features
Manager attaches on the host (`manage.js optInput()`). Text fields in Features Manager →
Options therefore never saved, while switches and selects did because their elements emit
composed custom events. The production datastore showed the symptom directly: both slides
rows rewritten in the same second as a switch toggle, carrying the unchanged address, and
the slide opening that address 22 seconds later. `PeekInput._handleChange()` now re-emits
the inner input's `change` as a composed event. The two new desktop specs drive the field
with real keyboard input and blur; the pre-existing options-save spec dispatched a
synthetic composed `change`, which is why it passed on the broken code.

### Twelfth macOS gate run — 2026-09-23

`yarn test:desktop:electron:bg` on `track/spaces-switch-cleanup`, macOS arm64, packaged. Exit 1.

| runner | pass | fail | skipped |
|---|---|---|---|
| main-process unit | 3311 | 0 | — |
| node unit | 774 | 0 | — |
| desktop | 476 | 1 | 21 |
| desktop-serial | 35 | 5 | — |
| components | 64 | 0 | — |
| editor | 91 | 0 | — |

Six failures total, all in the `desktop` and `desktop-serial` Playwright projects; main-process unit
and node unit are clean. Both unit runners were separately re-verified at 3311/3311 and 774/774
passing with 0 failures, run twice on this track — once before rebasing onto `main`, once after.

| Spec | Test | Verdict |
|---|---|---|
| `device-settings.spec.ts:166` | Device Settings Panel — lists, renames, revokes (including itself), mints a code and enrols with it | pre-existing — fails identically in isolation (`yarn test:grep`), unrelated feature area (device enrolment dialog text assertion: `Expected substring: "the device you are using right now" / Received string: ""`) |
| `desktop-serial/cmd-url-window-reuse.spec.ts:82` | opening an already-open URL via cmd reuses the window instead of duplicating | pre-existing — reproducible (not flaky) on a second isolated run against the same packaged build; times out waiting for the `window:opened` pubsub event after a cmd-panel-driven URL open, though the window itself is created (`open-registry-set ... role=content`) |
| `desktop-serial/external-url.spec.ts:25` | cmd panel detects and opens domain without protocol (youtube.com) | pre-existing — same `window:opened`-wait timeout pattern as the reuse test above |
| `desktop-serial/external-url.spec.ts:89` | cmd panel opens URL with http protocol | pre-existing — same pattern |
| `desktop-serial/external-url.spec.ts:164` | cmd panel opens URL with https protocol | pre-existing — same pattern |
| `desktop-serial/external-url.spec.ts:227` | cmd panel opens localhost URLs | pre-existing — same pattern |

This track's diff touches only `apps/desktop/features/spaces/background.js`
`closeCurrentWorkspaceWindows()`, `apps/desktop/features/editor/home.js`, and the spec files added
alongside them — `git diff --stat main..track/spaces-switch-cleanup` shows nothing in `main/ipc.ts`,
the cmd UI, or the window-open/`window:opened`-publish path. The shared root cause across the four
`external-url` failures and the one `cmd-url-window-reuse` failure is the cmd panel's "type a URL,
press Enter" open path never firing, or never matching, the `window:opened` listener the tests wait
on — a mechanism entirely outside this diff. The verdict also rests on static reachability:
`closeCurrentWorkspaceWindows()` is only invoked from `openSpace()`, a user-triggered workspace
switch, and none of these five tests trigger one.

One thing is NOT established and should not be read as settled:

- **None of the five cmd-panel failures have been A/B'd against `main` on the same packaged build.**
  The verdict rests on static reachability plus confirmed non-flaky reproducibility (a second
  isolated run against the same build reproduces all five identically), not on reverting this
  track's changes and re-running the identical specs against the identical binary — which is what
  would close the question outright.

This track's own `workspace membership` (8 tests) and `spaces ui activation` (5 tests) describe
blocks were green throughout the gate — neither appears in the failing set above.

### Thirteenth macOS gate run — 2026-09-25

`yarn test:desktop:electron:bg` on `agent/cmd-panel-focus-regression` rebased onto `main`
(`1fe79e2d`), macOS arm64, packaged. Exit 1.

| runner | pass | fail | skipped |
|---|---|---|---|
| main-process unit | 3369 | 0 | — |
| node unit | 826 | 0 | — |
| desktop | 486 | 3 | 21 |
| desktop-serial | 34 | 6 | — |
| components | 66 | 0 | — |
| editor | 91 | 0 | — |

Nine failures. Five are the twelfth run's cmd-panel set unchanged (`device-settings.spec.ts:190`,
`desktop-serial/cmd-url-window-reuse.spec.ts:115`, `desktop-serial/external-url.spec.ts:25/89/164/227`;
line numbers moved with the files). The other four:

| Spec | Test | Verdict |
|---|---|---|
| `cmd-url-unfocused.spec.ts:170` | the kernel keeps the page window on screen and never hides the app | this track's own spec: it read the window list before the reopened page had loaded, so the list carried an empty URL. Fixed in the spec by polling the list; the fix passed on the next source run |
| `command-chaining.spec.ts:365` | escape exits chain mode before closing panel | intermittent — `ERR_FAILED (-2) loading 'peek://cmd/panel.html'`, the signature already recorded for `:54` and `:127` above; passed in isolation on the same source |
| `desktop-serial/cmd-state-machine.spec.ts:216` | Escape layering: param mode -> clear text -> close | pre-existing — fails 3 of 3 in isolation on this track and 2 of 2 on `main` in the primary checkout, same source build method, same signature (`waitForState('IDLE')` times out after the second Escape). Not previously recorded |

The A/B for the Escape-layering case ran the `desktop-serial` project through
`scripts/playwright-with-display.sh` from source in both checkouts, not against the packaged build.

### Fourteenth macOS gate run — `kernel-desktops`

Gate run on the `kernel-desktops` track, macOS arm64. Exit 1.

| runner | pass | fail | skipped |
|---|---|---|---|
| main-process unit | 3888 | 0 | — |
| node unit | 826 | 0 | — |
| desktop | 489 | 2 | — |
| desktop-serial | 34 | 6 | — |
| components | 66 | 0 | — |
| editor | 91 | 0 | — |

The `desktop-serial` failures are the six recorded in the thirteenth run
(`cmd-url-window-reuse.spec.ts:115`, `external-url.spec.ts:25/89/164/227`,
`cmd-state-machine.spec.ts:216`). Only one `desktop` failure is identifiable from the recorded
history, `device-settings.spec.ts:190` (unchanged from the twelfth and thirteenth runs); the
run's other `desktop` failure and its skipped count were not recorded, so neither is named here.

The `fix-gate-failures` track resolved the pre-existing specs in this set:

| Spec | Status |
|---|---|
| `desktop-serial/cmd-url-window-reuse.spec.ts:115` | resolved — `ipc.ts` hybrid page-host open read the opener after awaiting `loadURL`; the cmd panel is destroyed by then, so the open threw "Object has been destroyed", returned failure and skipped `window:opened`. The opener id is now read up front (`357c5a75`) |
| `desktop-serial/external-url.spec.ts:25/89/164/227` | resolved — same cause and fix (`357c5a75`) |
| `desktop-serial/cmd-state-machine.spec.ts:216` | resolved — stale spec. Escape now hides the results dropdown first (`state-machine.js`, TYPING ESCAPE), so the spec presses Escape one more time (`45890f8f`) |
| `device-settings.spec.ts:190` | resolved — stale spec. The headless guard in `entry.ts` stubs `window.confirm` to return true with no native dialog, so no `dialog` event fired; the spec now wraps `window.confirm` to record the message (`1c16b52b`) |

Each fix was verified by running the affected specs alone, not by a repeat of the full gate.

### Intermittent failures from the `page-host-resilience` gate

Two `desktop` failures from the full gate on the `page-host-resilience` branch. Neither is a
regression: both are intermittent, and the full gate on `eef9e955` passed without either failing.

| Spec | Test | Verdict |
|---|---|---|
| `hybrid-close-two-hosts-hang.spec.ts` | closing a peek over two surviving page hosts stays within a sane transition bound | intermittent — failed in the branch gate and also fails on `main`; the bound was raised to 16 in `e4ef6094`; did not fail in the full gate on `eef9e955` |
| `hybrid-show-activate.spec.ts` | overlay hides when the app resigns active, re-shows on become-active (R6) | intermittent focus flake — failed in the branch gate; passes alone on both `main` and the branch; did not fail in the full gate on `eef9e955` |

Treat a fresh failure of either as a flake rather than a regression until a recording catches it
on an unchanged tree twice.

### Known failure on `main` at `3818282e`

Full gate on `main` at `3818282e`: `desktop` 533 passed, 1 failed. The one failure,
`spaces-window-locking.spec.ts` "a space entered for the first time from its own item list gets the
resolved accent on every window", was a stale spec: `features/spaces/home.js activateSpace()` sends
a card click to `switch space` by design since `318c401b`, so the in-page item list it waited for no
longer renders. The test now enters the space by its card click and is titled "a space entered for
the first time by clicking its card gets the resolved accent on every window". No failure on `main`
outside the intermittent set below is known.

Still known as intermittent, carried forward from the `page-host-resilience` gate above (treat a
fresh failure of either as a flake, not a regression):

| Spec | Test | Verdict |
|---|---|---|
| `hybrid-close-two-hosts-hang.spec.ts` | closing a peek over two surviving page hosts stays within a sane transition bound | intermittent — did not fail in the `3818282e` gate |
| `hybrid-show-activate.spec.ts` | overlay hides when the app resigns active, re-shows on become-active (R6) | intermittent focus flake — did not fail in the `3818282e` gate |

### Intermittent failures from the `desktop-lazy-restore` and `move-to-space-scope` gates

Full gates on the `desktop-lazy-restore` and `move-to-space-scope` branches, macOS arm64. The two
runs matched apart from which `desktop` tests failed:

| runner | pass | fail | skipped |
|---|---|---|---|
| main-process unit | 4028 | 0 | — |
| node unit | 1103 | 0 | — |
| desktop | 532–533 | 2 | 22 |
| desktop-serial | 40 | 0 | — |
| components | 66 | 0 | — |
| editor | 91 | 0 | — |

| Spec | Test | Verdict |
|---|---|---|
| `hybrid-overlay.spec.ts` | a hybrid window becoming active while the app is INACTIVE must not reveal the chrome | intermittent — failed in both gates; already noted as intermittent in the paragraph before "Causes", but missing from the carried-forward table above |
| `page-host-blocked-renderer.spec.ts` | alert: chrome attaches, open reports, navigate and close work | intermittent — failed in the `desktop-lazy-restore` gate only; passes alone |
| `hybrid-overlay.spec.ts` | real switch between two hybrid windows still retargets (A → B) | intermittent — failed in the `move-to-space-scope` gate only; passes alone |

The full intermittent set later gates are judged against is this table plus the two carried forward
in the previous section (`hybrid-close-two-hosts-hang.spec.ts`, `hybrid-show-activate.spec.ts` R6).
Treat a failure of any of them as a flake rather than a regression until a recording catches it on
an unchanged tree twice. The INACTIVE case failed in two consecutive gates, but on different trees,
so it stays intermittent.

### Gates after the transient closing rule (2026-10-19)

Two full gates on `main`, macOS arm64. The first, at `788737cc`, failed 7 `desktop` tests; each was
traced to a cause and fixed or skipped (test changes `64c42665`, `69b31bc0`, `b5904c4c`; product fix
`f4a29804`; `dedf1d36` skips the two command-chaining popup tests pending peek `ef7f63a8`). The
second, at `f4a29804`, was green:

| runner | pass | fail | skipped |
|---|---|---|---|
| main-process unit | 4358 | 0 | 1 |
| node unit | 1331 | 0 | 0 |
| desktop | 567 | 0 | 26 |
| desktop-serial | 55 | 0 | 1 |
| components | 71 | 0 | — |
| editor | 91 | 0 | — |

| Spec | Test | Verdict |
|---|---|---|
| `hybrid-overlay.spec.ts` | move intent moves the content window + overlay follows (P1.4b-3) | intermittent — failed in the `788737cc` gate only (window kept its starting bounds after `page:set-bounds`; cause not found); passes alone and in the `f4a29804` gate |

### Linux gate on `48210abe` (2026-10-19)

Seven tests failed. Three pass when re-run alone and are intermittent; four fail alone too. None of
the seven was in this file before. Two of the four were already fixed on `main` after this gate ran
(`69b31bc0`, `64c42665`, neither an ancestor of `48210abe`), which is why their causes read as
settled below.

| runner | pass | fail | skipped |
|---|---|---|---|
| main-process unit | 4365 | 0 | — |
| node unit | 1321 | 0 | — |
| desktop | 572 | 6 | 24 |
| desktop-serial | 54 | 1 | — |
| components | 71 | 0 | — |
| editor | 91 | 0 | — |

Intermittent — each passes when re-run alone:

| Spec | Test |
|---|---|
| `hybrid-escape-editable-guard.spec.ts` | ESC with an empty editable focused opens the switcher |
| `permission-prompt.spec.ts` | Remember + Allow persists |
| `windows-hidden-surface.spec.ts` | the switcher hidden-windows toggle lists a hidden quick-view window |

Deterministic — each fails alone too:

| Spec | Test | Verdict |
|---|---|---|
| `spaces-delete.spec.ts` | deleting a space that is not active moves its saved windows to the default space and removes it | fixed — the only window the test put in the space was its own `peek://spaces/home.html`, which `features/spaces/config.js SPACES_CHROME_URL_PREFIXES` excludes from the count, so `It has no windows to move.` was the right question. The spec now opens an ordinary web page in the space (`69b31bc0`) and asserts the count names it |
| `transient-on-blur.spec.ts` | overlay attached to a host survives a palette focusing (ownership, not role) | fixed — `tile:window:list` leaves app chrome out unless the caller passes `includeHidden: true` (`fd83aad4`), so the spec could not see the overlay at all. `isVisible()` passes it (`64c42665`) and `waitForHidden()` now does too |
| `page-translate-front-window.spec.ts` | the offer and the status hide with another window in front and come back with theirs | still failing — the spec has never passed on Linux (it landed `af689013`, 2026-10-13, and the translate code is unchanged since). Cause recorded below; not the one first suspected |
| `desktop-serial/modal-self-close-on-blur.spec.ts` | modal:true window is dismissed when another window takes focus | still failing — the test is correct. Known open product defect, peek `3bb9b6ab`: off macOS `electron-window-backend.ts` sets `restackingTakesFocus`, and `window-kernel.ts platformChoseFocus()` holds an expectation of a platform focus after a restack that never expires when the window manager does not answer, so the next genuine focus is swallowed and no `OsFocusGained` sweep (`selectTransientAutoclose`) runs. Which fix to take is undecided |

#### What the translate front-window log showed

Logged by a `window-diag.ts wmLog()` line in `hybrid-overlay.ts sendActiveHandoff`, since removed.
The four events below span 170 ms with no test action between them, and `Spanish` / `English` name
the two page hosts the spec opens:

```
t+0     page-overlay:active -> Spanish   (the bridge's setActive(Spanish) applied; opSeq 10)
t+126   effect-hide Spanish, effect-hide overlay, page-overlay:active -> null   (opSeq 12)
t+138   effect-show overlay, effect-show English, page-overlay:active -> English   (opSeq 13, 14)
t+167   page-overlay:active -> null
```

So `setActive` does report the target: the handoff names the Spanish window and its url. Then,
unasked, the Spanish host is hidden, the English host comes back, and the chrome detaches with no
active window for the rest of the ten-second poll. The translate tile tracks the front window from
this topic (`features/translate/background.js handleFrontWindow` → `window-views.js setFront`), so
it closes the widget and nothing redraws it; `widgetBody` stays null.

The suspected cause was that `sendActiveHandoff` reports a window other than the target. It does
not. What precedes the unasked hide is the window manager handing world focus to the chrome overlay
twice (`focus-cause-taken id=<overlay> kind=world`) before the machine's own expected focus for the
Spanish host arrives. The hide that follows is not the transient sweep — every `transient-sweep`
line in the run reports `dismissed=0` — and `selectTransientAutoclose` would exempt the host anyway
(`transientAutocloseExemption` returns `overlay-attached` for a record with `overlayFor` set). Which
code issues the opSeq-12 hide is unresolved; the hide-then-show-the-other-host shape matches the
bridge's own `setActive` drain, but nothing called it.

A page host hiding itself 126 ms after being brought forward, and the chrome detaching with no
window active, is product behaviour rather than a test artifact, so under the rule that shipped code
is presumed correct (peek `57895545`) this is recorded rather than worked around. Pinning the
opSeq-12 owner needs an op-source field in the hide effect's log line.

### Linux gates on `b445b3af` and `dcacfea8` (2026-10-21)

`b445b3af` had eleven failures: the five already recorded above (`hybrid-cmd-click-open`,
`hybrid-escape-editable-guard`, `page-translate-front-window`, `windows-hidden-surface`,
`desktop-serial/modal-self-close-on-blur`) and six new ones. Each new one was first run alone.

| runner | `b445b3af` pass / fail / skipped | `dcacfea8` pass / fail / skipped |
|---|---|---|
| main-process unit | 4135 / 0 / — | 4136 / 0 / 1 |
| node unit | 1548 / 0 / — | 1550 / 0 / — |
| desktop | 591 / 9 / 26 | 593 / 7 / 26 |
| desktop-serial | 53 / 2 / — | 53 / 2 / 1 |
| components | 90 / 0 / — | 90 / 0 / — |
| editor | 91 / 0 / — | 91 / 0 / — |

The six new failures at `b445b3af`:

| Spec | Test | Alone | Verdict |
|---|---|---|---|
| `boot-window-inventory.spec.ts` | fixed boot inventory: no new resident tile sneaks into the boot set | fails | fixed (`762d92d6`) — `reminders` and `feeds` declare a manifest `schedule`; on a fresh profile neither had fired, so `tile-schedule.ts` fired both as boot finished and their background tiles joined the boot set (6 against 4). Boot now holds every schedule fire for `SCHEDULE_BOOT_HOLD_MS` (30 s) |
| `spaces-delete.spec.ts` | deleting the active space reopens its windows in the default space | fails | fixed (`821f817e`) — deleting the active space closes the spaces page that asked the question, and the spec read `__lastConfirm` back from that page after the click. The question now comes back through the page's console |
| `spaces-delete.spec.ts` | the default space cannot be deleted | fails | fixed (`821f817e`) — failed only because the test before it did |
| `hybrid-overlay.spec.ts` | entities panel renders active-URL entities and swaps on retarget | passes | fixed (`e021afb7`) — the overlay's own `entities:get-for-url` request is answered by the lazy entities tile about 1.5 s later with an empty list; under load that answer landed after the injected one and replaced it. The spec waits for it first |
| `peeks.spec.ts` | an explicit size still wins over the display-relative one | passes | open, `specs/linux-focus-hidden-and-resign.md` — an app resign 26 ms after the peek opened dismissed the never-focused peek while `about:blank` loaded (`ERR_FAILED (-2)`). Passed at `dcacfea8` |
| `desktop-serial/cmd-switch-to-page.spec.ts` | the URL action follows a window opening and closing while the panel stays up | passes alone, fails after "a page open only in a hidden peek" | open, same spec — the hidden chrome overlay keeps OS focus from the previous test, so its next non-activating show reports `focused=true` and the sweep dismisses the cmd panel. Failed again at `dcacfea8` |

At `dcacfea8` the fixed four pass. `hybrid-cmd-click-open` passed. Four tests failed that are not
recorded elsewhere in this file; each passes when its spec file runs alone, and none touches the
schedule, spaces or entities code changed here:

| Spec | Test | Error |
|---|---|---|
| `features-toggle-lazy-rearm.spec.ts` | second disable/enable cycle is clean and idempotent | `Window matching windows/windows.html not found within 15000ms` |
| `hybrid-resize-exits-maximize.spec.ts` | resizing out of maximize leaves the overlay mirror in sync, so the next toggle maximizes | maximize state mismatch |
| `hybrid-resize-exits-maximize.spec.ts` | a native OS resize out of maximize clears the stale maximize state | maximize state mismatch |
| `todo-commands.spec.ts` | todo with only tags, or nothing, creates no item | `Expected: true, Received: false` |
