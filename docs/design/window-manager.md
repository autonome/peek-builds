# The Window Manager

Status: **mandate.** This document is directive, not exploratory. It is not a menu of
options and not a record of a discussion. It states what the system must become and what
is forbidden on the way there.

---

## Where we are

Read this table first. §4 and §5 below are the detailed record; this block is the fast,
current answer to "how much is done" — verified against `scripts/check-r2-window-ops.mjs`
and the commit log, not against the prose elsewhere in this document, which drifts.

The two R2 counts below are current as of 2026-08-17 (via
`scripts/check-r2-window-ops.mjs`). Steps 8 and 9 in the table below are verified against
the allowlist and live code as of the same date; steps 1-7, 10, and 11 track the older
11-step migration (§5), not the current window-kernel rewrite (§0.1), and carry forward
unverified.

### Step status (§5 migration sequence, 11 steps)

| Step | What it is | Status |
|---|---|---|
| 1 | Id space (`WindowId`, one id-minting seam) | DONE |
| 2 | The backend port (`WindowBackend` / `ElectronWindowBackend`) | DONE |
| 3 | R2 enforcement check (`scripts/check-r2-window-ops.mjs`) | DONE |
| 4 | Special window classes + registry unification | DONE |
| 5 | Z-order / stacking (`SET_STACKING`, `stackOrder`) | DONE |
| 6 | Visibility (`visible` authoritative, app-hide derived, no polling) | DONE |
| 7 | Geometry / maximize (bounds/maximize collapse into one reducer-owned model) | DONE |
| 8 | Focus rivals (delete `izui-state.ts`'s focus surface, `getFocusedWindow()` call sites) | DONE — residual call sites closed, commit `66c7958f` |
| 9 | Overlay attach/retarget + transient autoclose | PARTIAL — write debt closed (commits `a3f658cf`, `a731cf66`); non-write-op scope in commits `ed0f80ce` and `c5c9bcd7` remains unaudited |
| 10 | Displays and Spaces | DONE |
| 11 | Session save / restore (last) | PARTIAL — 8 tasks landed (11.1, two Task 3s, two Task 4s, Task 5, Task 7, Task 8 — see §5 step 11 for the full write-up and the task-number collision note); no commit evidence of any task beyond these 8 |

### The mechanical progress measure

`node scripts/check-r2-window-ops.mjs` (re-verified 2026-08-17): **15 allowlisted entries / 23
calls**. This number — not the table above, not any other prose in this document — is the
honest measure of how much window-op code still bypasses the machine. It is expected to
shrink monotonically to zero; the check fails a PR that grows it.

### Open design decisions

None. The last one — whether `order` includes never-shown and offscreen windows — was answered
on 2026-08-21: **it does**, every window always, with no registration-time membership test. The
decision and what it commits to are in §0.1.10, "Answered: `order` includes never-shown and
offscreen windows". The recurring boot-time
`divergence kind=stackOrder old=["wm-4"] kernel=["wm-1",…,"wm-4"]` is explained by it and is not a
defect: the comparator is contrasting two membership rules, and only the kernel's survives.

The key-reuse behavior in §4.6 is likewise decided rather than pending: a key-reuse shows the
existing window and does not navigate it.

### Open kernel defects

**Three, found by the 2026-08-21 macOS sign-off; one is a hang.** Full evidence in
`docs/design/window-manager-macos-signoff.md`, "Results: 2026-08-21 run". All three are
branch-introduced — none of the kernel files exist on `main`. **That claim now holds only for C.**
B was re-traced on 2026-08-21 and reproduces on `main`; A's mechanism is not yet attributed to
either machine, so its provenance is unknown rather than established. **All three are open.**

- **A (open): opening a peek works only every other press.** The peek is dismissed on EVERY press;
  the alternation is that dismissal racing page-load latency. On a failing press it lands inside
  `ipc.ts windowOpenHandler`'s `await ...loadURL(url)`, so reading `baseWin.id` just after throws
  `Object has been destroyed` and no window ever appears. Which machine decides the dismissal is
  unproven — `window-state.ts` and the kernel both have a transient-dismissal path, and every close
  path in the build is DEBUG-gated. Write-up: "Defect A: the peek is destroyed inside its own
  `loadURL`" below.

  A separate, genuine missing-provenance defect was fixed while chasing this — machine-issued focus
  reports reached the kernel as `world`, disarming `selectTransientAutoclose`'s ordering floor — but
  the symptom survived that fix unchanged, so it was not the cause. See "Three producers of a
  machine focus reported it as the world's" below, and the note there about why it was written up as
  resolved before anything was reproduced.
- **B: ESC on the command palette opens the switcher** instead of closing the palette.
  **NOT branch-introduced — it reproduces on `main`**, where `window-state.ts` `decideEscape` and
  `izui-roles.ts` `isSatelliteRegistration` are byte-identical. It is a pre-existing defect in the
  OLD machine's escape decider, and so does not block landing this branch.

  **It is a rule aimed at the wrong window, not a wrong fact.** An earlier reading blamed the
  registration line
  `Adding window to manager: 16 escapeMode: undefined modal: true keepLive: true transient: false`
  and concluded the palette was registered `transient: false` when it should be `true`. That is
  wrong twice over: `windowOpenHandler`'s `transient` means "opened while Peek was in the
  background" (`sessionWasTransient || entryMode === 'transient'`), not "an ephemeral overlay
  window", and no escape decision reads it — `decideEscape`/`decideEscapeUnhandled` read only
  `role`, `escapeMode`, `fsMode` and `session`.

  The actual chain: `decideEscape` targets `state.front` and discards the landed id as
  first-responder noise, while `applyFocusGained` bars every satellite from becoming `front` —
  and role `palette` is unconditionally satellite, deliberately, because the palette is a chrome
  surface and never a content target. So ESC pressed in an open palette is decided about some
  OTHER window, or about none, and both branches end in `OPEN_SWITCHER_WINDOW`. The palette's own
  `escPolicy(session, 'palette') === 'close'` is dead code for the palette itself.

  **The fix is the escape cutover, and it needs no new rule.** `window-escape.ts` `interpretEscape`
  — written, unit-tested, and with zero production callers — resolves its target through
  `resolveEscapeTarget`, which reads `keyWindow(state)`, the window in use, rather than `front`;
  and `palette` is in `ESC_CLOSE_ROLES`. Wiring it closes B as a side effect of the migration.
  Making the palette non-satellite instead would break front eligibility everywhere, and a
  palette-specific ESC arm is the failure mode this machine exists to remove.
- **C (severe): the app beachballs and must be force-quit**, reached from the state B leaves. A
  runaway loop, not a deadlock: two page hosts trade the top of the stack forever with `front`
  flipping between them. Possibly the same root cause as A, so it is re-checked against the A fix
  before being investigated on its own.

The earlier entries below are the defects closed before this sign-off, and remain closed. The one open defect — the restore-time maximize seed reaching the old machine but not the
kernel — was closed on 2026-08-18 by the kernel's `SeedMaximized` command and its
`shadowKernelSeedMaximized` pair, with the previously `test.fail()`-marked spec now passing as an
ordinary test. Write-up: "The restore-time maximize seed never reached the kernel" below.

The overlay race on macOS is CLOSED as of 2026-08-18: `electron-window-backend.ts`'s
`win.on('show')` echoed a lagged AppKit `'show'` notification into the machine without validating
it against native ground truth, re-showing a window the bridge's drain had already cleared and
re-attaching the chrome to it. It now carries the mirror of the guard `win.on('hide')` beside it
already had. Failing SETS, packaged macOS: 4 runs failing before (`1054` deterministic at 4/4), 6
runs clean after. Write-up: "Resolved: an unguarded native `'show'` echo re-showed a window the
drain had cleared" below. **Not yet re-measured on Linux**, where the same file recorded a worse
rate (§4.3.1).

The `session-restore-hybrid-focus` failure is also CLOSED as of 2026-08-18, and it was not an
intermittent: at the tip it failed 5 of 6 runs, at SAVE rather than at restore.
`pendingHideProvokedFocus` was armed by every hide rather than only by a hide of the focused
window, so an arming that nothing would ever consume sat waiting and swallowed the next genuine
focus. Write-up: "Resolved: an unowned hide-provoked-focus arming swallowed a genuine focus" below.
**One half of that rule is still unproven** — whether macOS reassigns focus when the focused window
is hidden — and only sign-off check 12 can answer it.

The peek-close overlay/hide echo hang is also CLOSED as of 2026-08-19 (commit `0bd49c7d`): closing
a page host the shared chrome overlay was attached to, while a sibling base-layer page host
survived, made `react` (`window-kernel.ts`) emit both `AttachOverlayTo` (retargeting the overlay to
the survivor) and `HideWindow` (detaching from the closing host) for the same transition, and
because neither Electron backend echo carried a token naming which op it belonged to, the hide's
echo could land after the attach's echo had already re-shown the overlay — read as fresh evidence,
so `HideWindow` was re-emitted and the two alternated forever inside one unbroken synchronous call.
Visibility effects and events now carry the same `opSeq` discipline `ShowWindow`/`RaiseWindow`
already use for focus provenance, consumed at both the synthetic echo and the native
`win.on('show')`/`win.on('hide')` listeners — tagging only the former left the loop fed. Write-up:
"Resolved: an untokened visibility echo let `AttachOverlayTo` and `HideWindow` alternate forever"
below. Regression: `hybrid-close-two-hosts-hang.spec.ts` (commit `0230c9e8`), 53 transitions before
the fix, 2 after. Found by check-driven live use during the macOS sign-off run, not by any spec or
the full test suite — see `docs/design/window-manager-macos-signoff.md`.

The retirement of `window-state.ts` / `window-os-adapter.ts` is DONE: commit `f189496b` deleted
both files along with `window-state.test.ts`. `window-kernel.ts` + `window-kernel-executor.ts`,
fed by `window-kernel-shadow.ts`, are the only window machine left — no shadow comparison, no
dual-write, no fallback path. What remains open on this branch is not code defects but unrun
verification: the macOS sign-off (`docs/design/window-manager-macos-signoff.md`, 12 checks — 1
and 2 observed passing on the 2026-08-19 run, 3-12 not run) and the remaining decision in
§0.1.10.

§0.1.10's ESC/`child-content` question is CLOSED as of 2026-08-20, by history rather than by a new
decision: `900b0268` added the close-on-ESC arm and `a9c4ec88` reversed it four weeks later, so
both current tables and `izui-escape.spec.ts` carry the standing rule and agree with each other.
Two earlier records in this document described the arm as silently lost in the port; both are
corrected. The `order`/never-shown-windows question in §0.1.10 is still open.

The `lastFsReconcile` one-shot request channel is dissolved as of 2026-08-23: `FsMode`'s
`entering`/`leaving` variants now carry an `unverified?: true` flag instead of a separate
`seq`-stamped record on `State`. The same two writers set it — `AppActivated`'s in-flight sweep and
`FullscreenSettleTimeout` — and it self-clears for free, because `nextFsModeForOsEntered` /
`nextFsModeForOsLeft` build a fresh mode object on every settle. `react`'s reconcile rule is now a
per-record diff of that flag rather than a diff of one request fact. Behavior change: a second
still-in-flight ask (a second settle timeout, or a second `AppActivated`) while a record is already
unverified now emits no second `ReconcileFullscreen` — safe, because `electron-window-backend.ts
reconcileFullscreen` answers synchronously, so an unverified window is one pump-drain wide. Of the
other three `seq`-stamped one-shot channels on `State`, `lastTeardown` and `lastFocusAssert` are
unchanged; `lastAttention`'s app-resign half is dissolved next, below.

The APP-RESIGN half of the `lastAttention` one-shot channel is dissolved as of 2026-08-23 as well:
`AppResignSettled` no longer writes a `holder: null` record onto `State.lastAttention`. `react`'s
transient-autoclose sweep is now split into two rules at the same slot (immediately after the
`RaiseWindow` rule, before `SetStacking`, so emitted effect ordering is unchanged): a focus-report
sweep still diffing `State.lastAttention`'s `seq`, and a resign sweep diffing
`pendingAppResignSweep`/`appActive` instead — exactly `AppResignSettled`'s own `attentionLost` test
(`!state.appActive`), restated as a structural comparison the arm's own write no longer has to
carry. `Attention.holder` narrows from `WindowId | null` to `WindowId`, since `OsFocusGained` is its
only writer now. The OS-FOCUS half — `OsFocusGained` writing `holder: ev.id` unconditionally on
every report, including one that re-confirms the window already holding key — is IRREDUCIBLE and
stays a one-shot write: it needs both `holder` and `cause`, and a structural diff of `key` alone
cannot tell an echo apart from silence.

### First macOS evidence for this branch, 2026-08-17

The branch was written and measured entirely on Linux, which can observe none of the focus,
fullscreen, Spaces or activation behavior it changes, and `apps/desktop/tests/gate-baseline.md`
records the Linux failing set. These are the first macOS results: Playwright over the six
window-manager-load-bearing specs, plus live runs. Machine: macOS 26.5.1, single built-in
display, no external monitors or additional Spaces.

**Method, because it is what makes the numbers mean anything.** Every claim below is an A/B
against `main` on the same machine in the same sitting, by the same command, repeated. A single
run distinguishes nothing here — `gate-baseline.md` exists precisely because this suite's failure
count moves between identical runs, and reading one run reports a flake as a regression.

#### The izui-escape palette failure: diagnosed, and not a kernel defect

`izui-escape.spec.ts` "regression: ESC on a page opened FROM a palette-role opener does NOT close
it (full backend path)" failed 4/4 source-only and 2/2 packaged on the branch against 3/3 passing
on `main`, and `apps/desktop/tests/gate-baseline.md` lists it **unclassified**. The cause is not a
kernel defect: the spec encoded behaviour the kernel deliberately changed.

*(That test no longer exists under this name — it was renamed and rewritten to assert the opened
window's classification, and now reads "regression: a page opened FROM a palette-role opener is
classified content, never child-content". The measurements in this section are kept as the dated
record that led to the rewrite.)*

Traced live: the spec's own `paletteWindow.evaluate` opens `peek://search/home.html`; that page
takes key; `window-kernel.ts selectTransientAutoclose` dismisses the palette; and the `evaluate`
call rejects because the page it was running in was destroyed. The reported
`Target page, context or browser has been closed` is the consequence of the spec's own action, not
something that happened before it.

The dismissal is correct. `selectTransientAutoclose` dismisses a visible transient whenever another
window genuinely takes key, unless that window names it as parent
(`focuser.parentId === rec.id`). `ipc.ts NON_PARENT_ROLES` deliberately withholds that parent link
from a palette-opened page — the very exclusion this spec guards — so no exemption applies. The
seam that keeps a genuine child alive is `options.declareParent`, which sets the machine-level
`parentId` without touching `isRealParent`; `renderer/cmd/panel.js openChainPopup()` uses it. So a
chain popup keeps the palette and an opened page dismisses it, which is the intended split.

`izui-escape.spec.ts` now fires the open without awaiting its result, finds the opened window in
the registry by address, and pins the dismissal after the load-bearing assertions.

##### The Escape assertion was vacuous for two independent reasons, and the guard is now the classification

Removing `'palette'` from `ipc.ts NON_PARENT_ROLES` — the exact defect the spec names — left the
spec PASSING. Both causes are structural, and neither is about whether `keyboard.press('Escape')`
reaches `before-input-event`; that question is moot.

1. **The fixture URL could not carry either role under test.** The spec opened
   `peek://search/home.html`. `izui-roles.ts inferIzuiRole` gates both `content` and
   `child-content` on `ctx.isWebPage`, so a `peek://` URL falls through to `workspace`. Measured:
   the opened window registered `role: 'workspace'`, `parentWindowId: null`. `workspace` is the one
   role `escPolicy` never closes in any session, so the survival assertion held unconditionally.

2. **The ESC outcome no longer separates `content` from `child-content` in any session.** The live
   table is `window-state.ts escPolicy`, reached through `decideEscape`. It returns `'nothing'` for
   `('active', 'child-content')` and `'close'` for BOTH roles under `'transient'`. Its successor
   `window-escape.ts escapeClosePolicy` agrees. `main.ts` treats the two roles identically at both
   of its role tests (`isContentRole`, `findWindowByUrl`). No session value tells them apart.

Cause 2 is the standing policy, not a drift. Commit `900b0268` briefly made `child-content` close
on ESC regardless of session; `a9c4ec88` reversed it four weeks later, merging the two roles under
one rule — ESC closes a real content window only in a `transient` session, and the switcher opens
while the app is OS-focused. Both current tables carry the post-reversal rule because that is the
decision. Full history and coverage in "0.1.10 Decisions and remaining questions".

The guard is therefore the **classification**, which is the only observable that still separates
the two worlds: the spec asserts the opened window registers `role: 'content'` with
`parentWindowId: null`. Proven failing-first — with `'palette'` removed from `NON_PARENT_ROLES`
the pair comes back `{parentWindowId: 5, role: 'child-content'}` and the spec fails on that
assertion. Commit `a4b1b91e` is guarded again, on the fact it actually changed.

The spec also opens a real `http://127.0.0.1` page from a local server, because that is the only
way to reach either role at all.

#### The overlay attach regression is fixed

`hybrid-overlay.spec.ts` "clicking the chrome (overlay focus on content blur) does NOT
deactivate" failed deterministically at tip `dc1b6051`, before
`docs/design/overlay-attach-effect-plan.md` was implemented — 2/2 fail there against 1/1 pass on
`main`. After the plan landed (`the overlay attach target answers null when the front window is
not a page host`, `a window declares that it tracks the base-layer top`, `the machine decides
which host the chrome overlay frames`, `the machine decides the attach target, the overlay only
paints`) it is **3/3 pass source-only on the branch, matching 3/3 on `main`.**

**Do not read the packaged full-file run as contradicting that.** Four identical packaged runs of
`hybrid-overlay.spec.ts` on the fixed tip produced 4, 0, 3 and 2 failures, with a different
failing subset each time, drawn from `active handoff paints navbar…`, `page-info renders…`,
`notes pane loads…` and the deactivate test. That instability is the overlay-renderer
subscription race `gate-baseline.md` names as **overlay race** — the renderer subscribes after
the handoff is published and the `did-finish-load` re-send never lands — and it is the largest
single lever on that gate. It is not evidence about the attach rule.

#### The overlay race is present on macOS too — an earlier "closed on macOS" reading was wrong

**Correction, recorded rather than quietly replaced, because the mistake is instructive.** Eight
consecutive packaged runs of the full `hybrid-overlay.spec.ts` on macOS came back 45/45 clean —
four at the tip carrying `c7e9f4a5` / `9dffe56d` / `93f46d9b`, four more after rebasing onto
`0f1f6e44` — against a 4/0/3/2 failure spread on the tip before those commits. That was read as the
race being closed on macOS. It is not.

Four further runs against a **freshly built** package at `0f1f6e44` produced **1, 2, 0 and 0
failures**, failing set nested:

| run | failing set |
|---|---|
| 1 | `notes pane loads for the active URL, swaps on retarget, clears on null` |
| 2 | that, plus `page-info renders the active window data, swaps on retarget, clears on null` |
| 3 | — |
| 4 | — |

So the file races on macOS as well, at a visibly lower rate than on Linux — where §4.3.1 measured
six runs for one clean. The macOS failures land on different tests again (`notes pane`,
`page-info`) than the Linux ones (`back/forward unblocked`, `Cmd+F forward`), which is the same
signature §4.3.1 describes: one race that lands on whichever test loses it, not a defect owned by
any single test.

**The lesson is about the bar, and it is higher than §4.3.1 states.** Four runs was the stated
minimum; eight consecutive clean runs still produced a false "closed" reading here. For a race at
this rate, a clean batch is evidence of nothing at all — only a *failing* batch is informative.
Treat this file as an open race on both platforms until the mechanism is found and fixed, and do
not let any number of green runs be cited as its closure.

`apps/desktop/tests/gate-baseline.md` is a Linux record and cannot be re-recorded from here; its
twelve overlay-race rows still need two consecutive Linux gate runs on this tip.

#### A packaged run reports on whatever was last packaged, not on the working tree

`yarn workspace @peek/desktop test:desktop:electron:spec` sets `PACKAGED=1` and runs Playwright.
It does **not** build. So a packaged run after any source edit silently measures the previous
package, and reports the difference as a result about the current tree.

Measured, because it produced a convincing false regression: `izui-escape.spec.ts` failed
deterministically in two packaged runs with `{parentWindowId: 12, role: 'child-content'}` — the
exact signature of `'palette'` being absent from `ipc.ts NON_PARENT_ROLES`. The working tree was
correct and the same spec passed 6/6 source-only. The package had been built while that line was
temporarily reverted during a failing-first proof, and `grep`ing the `.asar` for the literal
returned **both** spellings across its copies. After a clean rebuild the spec passes 6/6 packaged,
twice.

Two habits follow. Rebuild before any packaged run that is meant to judge a source change; and
when a packaged result disagrees with a source-only result, suspect the package before the code —
`grep -a` the `.asar` for the literal under test settles it in one command.

#### Session-restore focus is intermittent too

`session-restore-hybrid-focus.spec.ts` *"two hybrid pages: the page focused at save is the one
restore raises (not the other)"* passed in three runs and failed in a fourth, all packaged on the
same tree. It is not in `apps/desktop/tests/gate-baseline.md` under either list. Undiagnosed, and
recorded here so it is not rediscovered as new: this is the save/restore focus rule that
`4f1a974a` fixed, so an intermittent failure there is worth more than its one-in-four rate
suggests.

#### The other four specs

Against the packaged build: `session-restore-hybrid-focus` 9 passed, `window-targeting` 2 passed,
`session-restore-page-host` 2 passed. `boot-window-inventory` **skipped its only test and is
evidence for nothing** — a gated skip of that shape reports green while covering nothing.

#### Re-measured on the rebased tip, 2026-08-18

Every load-bearing spec packaged, twice each, on the tip carrying `93f46d9b` (stacking replays
only the windows that must move) and `9dffe56d` (a hide is no longer read as the user picking
another window). Two runs, because one cannot tell a deterministic failure from a flake.

| Spec | Run 1 | Run 2 |
|---|---|---|
| `session-restore-hybrid-focus` | 2 passed | 2 passed |
| `window-targeting` | 9 passed | 8 passed, 1 failed |
| `session-restore-page-host` | 2 passed, 6 skipped | 2 passed, 6 skipped |
| `boot-window-inventory` | 1 skipped | 1 skipped |
| `hybrid-content-window-gesture` | 6 passed | 5 passed, 1 failed |

Two intermittents, each failing in exactly one of two identical runs, so neither is a
deterministic regression and neither is dismissable as noise:

- `window-targeting` → *modal window does not become theme target*
- `hybrid-content-window-gesture` → *a double-click whose second press drags past slop does NOT
  maximize (click-drag suppressed)*

Both are undiagnosed. `hybrid-content-window-gesture` carries four rows in
`gate-baseline.md` under **overlay race**; on macOS it is not deterministically failing, so its
Linux classification does not carry over.

**Two specs report green while covering much less than their names suggest.**
`session-restore-page-host` skips 6 of its 8 tests in both runs, and `boot-window-inventory`
skipped its only test — that one is now split so the fixed boot-count guard runs (see below). The
`session-restore-page-host` skips are the same shape of hazard, and covering them found a live
defect (next section).

#### The restore-time maximize seed never reached the kernel — fixed by `SeedMaximized`

`session-restore-page-host.spec.ts`'s six skipped tests read geometry off the canvas shell page's
`?width`/`?height` URL params, and a hybrid page host has no shell page. Hybrid is the only
page-host architecture that ships, so **bounds and maximize round-trip through save+restore had no
coverage at all on the architecture that runs.** Four tests now read geometry from the window
registry instead, which is architecture-independent.

One of them failed, reproducibly: after save+restore, `page:unmaximize` cleared the maximized flag
but left the window at the maximized rect. A live control — maximize then unmaximize with no
save/restore — passed, so unmaximize itself was correct and only a **restored** window was broken.

The cause was the shape §0.1 warns about, in its purest form. `ipc.ts`, at the
`options.maximized === true` branch of the hybrid window-open path, seeded restore-time maximize
state with a bare `dispatchWindowEvent({type: 'MAXIMIZE_RESTORED', …, preMaxBounds})`. That reached
the **old machine only**. Every other maximize site pairs its dispatch with a kernel feed —
`page:maximize` calls `shadowKernelMaximize` alongside its dispatch, `page:unmaximize` calls
`shadowKernelUnmaximize` — for the stated reason that the kernel is what drives the window manager.
That site had no pair, and `window-kernel-shadow.ts` had no entry point to call.

So the old machine held the saved stash, `window-presenter.ts getHybridPresentation` read it from
there, and the registry reported `preMaxBounds` correctly — which is exactly why the sibling test
that asserts that field passed throughout. **The data was right and the behavior was wrong**,
because the fact was never fed to the machine that acts on it. A test asserting the stash is
present is a pin, not evidence that unmaximize works.

The fix was a kernel API addition rather than a patch. The kernel's `Maximize` command stashes
`rec.bounds`, and at restore time the window's creation bounds ARE the maximized rect, so replaying
`Maximize` stashes the maximized rect as the thing to unmaximize back to and strands the next
unmaximize. The kernel now carries a second command, `SeedMaximized`, taking an **explicit**
`preMaxBounds` — the same distinction `MAXIMIZE_RESTORED` already draws from `MAXIMIZE_REQUESTED`
in the old machine. It is a seed and nothing more: `decide` returns a lone
`Maximized{preMaxBounds}` with no paired `BoundsChanged` (the window is already at that rect) and
no `PendingProjectionDiscarded` (it matches a record to geometry that already exists rather than
deciding new geometry), under the same non-`normal` `fsMode` guard `Maximize` carries.
`shadowKernelSeedMaximized` is the pair for the `ipc.ts` dispatch.

Proven by removing nothing: the spec ran as `test.fail()` while the defect stood, and the fix made
Playwright report *"Expected to fail, but passed"* — a failing-first proof landing on the intended
assertion, in one run. The marker is gone and the test is now an ordinary member of the file
(6 passed / 6 skipped, unchanged otherwise). Three kernel unit tests in `window-kernel.test.ts`
cover the command, including a negative control asserting that replaying `Maximize` on the same
state stashes the maximized rect — the reason the command exists rather than a spelling of it.
`window-kernel-properties.test.ts` does NOT generate `SeedMaximized`: its variant roll is a fixed
36-way switch whose statistical assertions are measured against the current draw sequence, and
adding a variant or a sub-roll reshuffles every seed's trajectory for a command whose invariants
(`preMaxBounds` non-null only while maximized) it would not newly exercise.

A note for anyone writing waits in these suites: `page.waitForFunction` does **not** await a
promise its predicate returns, so an async predicate makes the wait resolve on the first tick and
guard nothing. Use `expect.poll`. The first draft of these tests hit exactly that and reported a
false timing failure — and the same pattern appears in existing helpers in that file.

Running the unmasked boot guard immediately produced a fact nothing had recorded: the fixed boot
window set is **4**, not the 3 its comment carried, and the fourth is
`peek://app/page/overlay.html` — the shared chrome overlay, one window for all page-hosts, which
became a resident boot window after that guard was last observed. Its ceiling was observed+1,
which is exactly the slack that let the overlay land unnoticed.

#### Live observations, and what they cost to interpret

Observed live at tip `dc1b6051` with `PEEK_SHADOW_KERNEL_COMPARE=1 E2E_TEST=true`.

> `PEEK_SHADOW_KERNEL_COMPARE` no longer exists. It gated `compareShadowKernelState`, which
> diffed the kernel's view against the old machine's; both were removed in `db8db214` once the
> kernel became the only machine. Every mention of the flag below is a record of the run
> conditions at the time, not a command that can be re-run.


- **A click on a background page host did not raise it; a second click did.** Cmd+` cycled once
  and then stopped moving it forward. Recorded here because the fix landed afterwards (`a raise on
  a window already on screen reorders, never shows`) and this is the behavior it should be
  measured against.
- **No address bar appeared on any page**, on either the programmatic `pageHost: true` open or the
  production Cmd+N path, where `main` showed one. This was measured before the attach plan landed;
  the spec evidence above says the attach rule is now correct, but **no live macOS run has
  confirmed the address bar returns.** That is an open sign-off item, not a closed one.

Three traps this run walked into, recorded so the next one does not:

- **A page opened programmatically from the background window lands below the last-focused
  window.** That is the locked one-order rule working, not a stacking bug. It contaminated the
  first attempt at sign-off check 1.
- **Closing the last window leaves Cmd+N dead**, because local shortcuts route through the focused
  window's input handler. An app with no windows is not a clean slate; it is a broken one.
- **`window.app.window.maximize(<id>)` answers `{"success": false, "error": "Window not found"}`
  for a live hybrid page host — and `main` answers identically.** This is the documented
  hybrid-era invariant (`BrowserWindow.fromId()` is null for a hybrid page host), not kernel
  damage.

**Log-absence proves nothing on the overlay attach path.** Neither branch nor `main` logs anything
there; both emit only the overlay's two `[preload:perf]` lines. A grep showing "no attach
activity" says the path is unlogged.


### Remaining work, most-tractable first

1. Determine whether step 11 has any task beyond the 8 already landed. No commit or doc
   evidence of one exists as of this writing; if none turns up, step 11 — and the whole
   migration — is DONE once the R2 allowlist above also reaches zero.
2. Once steps 9 and 11 are all DONE and the R2 allowlist is empty, delete this block
   and replace it with a one-line completion note (see the directive below).
3. Absorb window identity (`options.key`) into the machine — the create-versus-reuse decision
   that currently lives as a guard chain in `ipc.ts windowOpenHandler` with two key spaces that
   disagree about namespacing. Scoped in §4.6 "Window identity". Engine work, after the
   cutover; the targeted defects are being fixed in place meanwhile.

### Fixes landed 2026-07-30

Six commits reached `main`, fixing user-facing bugs found during work on this migration. What
landed, by what it fixes:

- **Space restore works for the first time.** `features/spaces/background.js` `openSpace()`
  and `features/groups/home.js` now read the featureId that `session.ts saveSpaceWorkspaces()`
  actually writes (`space-workspaces`); previously both read a namespace nothing writes, so
  `openSpace` always got null and opened the spaces home UI instead of the saved windows. The
  READERS moved, not the writer, so existing profile rows stay readable with no migration.
  `features/spaces/manifest.json` gained `"settings": { "readForeign": ["space-workspaces"] }`.
- **Hybrid page-hosts stopped being dropped from saved spaces.** `session.ts
  saveSpaceWorkspaces()` projects machine state instead of a `BrowserWindow.fromId`-backed
  liveness guard, which had discarded every `BaseWindow` page-host before any decision.
- **`api.session` no longer clobbers itself.** `tile-preload.cts` merged its two `api.session`
  assignments, so `saveSpaceWorkspaces` survives on `window.app`.
- **The groups hotkey stopped stealing `CommandOrControl+G` OS-wide** (it shadowed macOS Find
  Again); its manifest entry is removed outright.
- Behavioral cover: `tests/desktop/space-workspace-page-host.spec.ts`, which asserts its
  preconditions rather than skip-gating them.

The same batch also landed the R2 read-op checking commit. Its `READ_ALLOWLIST` enumerates
exact call sites that earlier steps in this migration had already reshaped, so it fails
`scripts/check-r2-window-ops.mjs` on a count mismatch when applied without them. Consequently
the R2 count in "The mechanical progress measure" above is still the write-only measure — reads
are not yet checked on `main`.

**Verification:** the full six-runner gate ran green over this batch in an isolated clone —
4031 tests, 4000 passed, 0 failed, 31 pre-existing intentional skips, exit 0 — plus
`node scripts/check-r2-window-ops.mjs` clean at 15 entries / 23 calls. This doc note is the
only change made after that run.

**Known real bug, fix already written but unlanded:** `window-state.ts SWITCHER_SELECTED` sets
`front`, bumps `focusSeq` and drives `applyRaiseRequest` correctly, but **has no production
dispatcher** — `main.ts`'s overlay-close handler still calls `targetWin.focus()` /
`hybrid.baseWin.focus()` directly and dispatches nothing. Symptom: switch pages via the
switcher, then `tag <name>` from the palette, and the tag lands on the page that was switched
away from. The fix exists but has not yet reached `main`; do not reimplement it, and do not
resurrect the deleted `focus-order.ts` approach (a second focus owner outside the executor).

### Test debt closed 2026-08-02/03

`session-projection.test.ts`'s `zOrder`/`stackIndex` rewrite for the one-order decision (§0.1.9,
"The one-order consequence") is fully landed. The last pinned focusSeq/stackOrder divergence,
`the saved stacking position is not the focus-recency rank`, is now `a background open is saved
BELOW the last-focused window`, with its fixture `stackOrder` flipped from `['w1','w2']` to
`['w2','w1']` — the old scene encoded a background open ABOVE the key window, a state
`window-kernel-properties.test.ts checkInvariants` rejects. `session-projection.ts` itself needed
no source change; the fix was confined to the test fixture. One caveat carries forward to the
eventual kernel cutover — see §0.1.10, "Decided: one order, and nothing else orders windows."

### The transient-dismissal exemptions are one predicate, 2026-08-23

The law's exemptions had four copies in the tree — `selectTransientAutoclose` (four clauses),
`traceTransientAutoclose` (a declared clause-for-clause mirror), `evolve`'s `WindowRegistered`
merge arm (two clauses, with the focuser-relation clause missing and nothing recording why), and
`window-kernel-properties.test.ts checkTransientHideIsNotDismiss` (three). They are now one:
`window-kernel.ts transientAutocloseExemption`, described in §0. The three production copies call
it; the property checker keeps its independent restatement on purpose, because a checker that
called the code under test could not catch a hide-instead-of-dismiss path.

Two mutations measured the cover that existed before the consolidation. Deleting the merge arm's
guard outright was caught, by one property seed. Dropping only its `acceptsInput` conjunct — the
over-clear direction, where a reversible hide the law wanted kept gets dropped — was caught by
NOTHING: the whole suite stayed green. That gap is now closed from two sides, by
`checkStrandedHideAgreesWithSelector`'s must-not-over-clear direction and by two hand-built
example logs beside "the hiddenByAppBlur mark survives a re-registration mid-sweep", which take a
marked window through a re-registration into a transient role with `acceptsInput` true and false
and assert the opposite outcomes. The examples are hand-built rather than left to the generator
because the re-registration path is measured-thin — `window-kernel-properties.test.ts`, "Pinned
merge coverage — MEASURED, not assumed".

### Maintenance directive

**This block is the single source of truth for migration status. Every agent that lands
window-manager work MUST update this block in the same commit — adjust the step statuses,
refresh the R2 count, and strike completed items off the remaining-work list. Do NOT
delete this block until the migration is complete (all 11 steps DONE and the R2 allowlist
empty); at that point it is replaced by a one-line completion note. Any handoff document
must point at this block by name (`docs/design/window-manager.md`, "Where we are") rather
than restating its contents.**

---

## 0. The governing rule set — derive everything from this

**This section states the current rules, adopted after a live session exposed three bugs
that traced to the same underlying mistake. It outranks every model described below it.
Where sections 3–5 disagree with this, they describe the older design and this section
states the intent.** The next rewrite derives from these rules; it does not add mechanisms
alongside them.

**Everything is a window, always: one single stacking order, always** — a fact regardless
of what edge case arises, not a policy to be renegotiated per case.

**Stored facts, and nothing else:**
1. **One stacking order containing every window, always.** No exclusions, no eligibility
   filter, no window removed from the order to make a policy convenient.
2. **Which window holds key**, as one id or none.
3. Each window's own lifecycle state, plus its intrinsic properties as created.
4. Whether the machine itself caused the event currently being handled.
5. **Whether Peek is the active application**, as one boolean (`window-kernel.ts
   State.appActive`, written by `evolve`'s `AppActivated` / `AppResigned` arms). The only
   app-level fact in the set: the other four are per-window or per-event, and this one has no
   window to hang on. It is a fact and not a query because nothing else in the machine implies
   it — no arrangement of windows distinguishes "Peek is frontmost" from "Peek is behind
   another app with the same windows in the same order", and the OS reports it as its own
   event rather than as a consequence of anything the machine did.

**The rule that fact 5 exists to state: Peek does not reorder its own windows on its own
initiative while it is not the active application.** A window becoming visible because the
user asked for it is a different fact and is not covered — the constraint is on the machine
acting unprompted, not on the user acting through it.

- **The test belongs on the write, not on the effect.** Stated as above it is not a gate at
  all: while the app is inactive the transition that would change which window holds key is
  simply not recorded, so `react` has no diff to project and nothing downstream has anything
  to refuse. Placing it instead at the moment of performing the effect would leave the machine
  believing in a reordering that never happened. Precedent in the same file: `evolve`'s
  `AppResignSettled` arm already performs exactly this kind of test on the write, and its own
  comment gives this reason.
- **This is not `react` holding a guard.** The written constraint is that `react` holds no
  guards at all, which the write-side placement satisfies; nothing forbids `react` from
  reading `state.appActive` as one more structural input, and it does not need to.
- **Nothing is latched for replay.** A raise the machine wanted while backgrounded is dropped,
  not remembered: on returning to Peek the user finds the window arrangement they left, and
  macOS restores the app's own window order on activation. Remembering it would mean storing a
  pending intention — a sixth fact — to serve a case no gesture asks for.
- **Consequence for the executor.** `window-kernel-executor.ts planRaise` currently resolves
  `!appActive` to a `'suppressed'` outcome that performs nothing. Under this rule there is no
  such raise to suppress, and the arm deletes. That also resolves a standing contradiction in
  this document, which calls the executor "a dumb re-assert loop with no decisions of its own"
  while `planRaise` is by construction a four-way decision.

**Everything else is a query over those, computed where the decision is made and never
stored:** the restore target (topmost window in the order matching a restorable predicate),
raise eligibility, the target of an input event.

**Why `front` must stop being stored state.** `front` was "the target window", with
`isEligibleFront` excluding satellites so a palette could never be named by it. That
exclusion was load-bearing for switcher restore (see section 5's step 8 live-verification
note) — but it means `front` and the window actually holding key diverge permanently for
satellites, which is what broke Escape. A window was excluded from a *fact* to make a
*policy* easy. Replace it with the query in rule 1, and the divergence cannot exist.

**Intrinsic window properties are orthogonal axes — never a pre-combined class name.** At
least three, all genuine OS properties: **level** (normal / always-on-top, and macOS bands
levels, so pinned windows sit above normal ones and are ordered among themselves — many
coexist, no cap implied); **can become key**; **accepts input vs passes clicks through**.
`classifyWindowRegistration` currently collapses `alwaysOnTop === true && focusable === false`
into the single class `hud`, and downstream predicates branch on that label — so any window
wanting a different combination needs a new class or an exception. The existing symptom: the
stacking exclusion set is deliberately NOT computed from the `satellite` flag, because
`quick-view` is `satellite: false` yet excluded. Keep the properties; let predicates read
them; class names may remain creation-time shorthand that nothing downstream branches on.
Note `focusable: false` is a real fact (the OS genuinely will not give such a window key), so
"a HUD never holds key" needs no special case — unlike `satellite`, which was an invention.

**The rules and the machine are platform-neutral; every platform workaround lives behind the
port.** Electron on macOS is one backend, not the design. Tauri and other platforms are
intended, so nothing above the port may name a platform's method, carry its argument names, or
encode the shape of its workarounds. The machine says WHAT it intends; the backend for a given
platform decides what native calls achieve it there, including how many calls that takes.

- **A port method carries an intention, not a call shape.** If a port argument only makes sense
  to one platform's API, it is in the wrong layer. The test is whether a second backend could
  implement the method without the argument being meaningless or having to be ignored.
- **Sequences are implementation.** Where a platform needs two native calls in a particular
  order to achieve one intention, that ordering belongs to that backend. The machine emits one
  effect for one intention; it does not emit a platform's steps.
- **A platform without the concept no-ops.** "Which desktop a window lives on" has no meaning
  where the OS has no such concept, and the backend answering with nothing is the correct
  answer, not a special case for the machine to hold.
- **Known violation, being corrected:** the macOS Spaces effect currently carries
  `visibleOnFullScreen` and `skipTransformProcessType` — both Electron argument names — and the
  ordered true-then-false pulse that lands a new window on the user's active Space is expanded
  into two effects by the reducer rather than by the backend. Both are the platform reaching up
  through the port. The intention is per-window and there are two of them: the window FOLLOWS
  the user across desktops, or the window BELONGS to the desktop it was opened on.

**Input interpretation lives OUTSIDE the window manager.** Hotkeys and Escape are not window
manager concerns. Something outside resolves what the user meant and emits a plain window
intent; the machine never learns that a key called Escape exists. Escape specifically is a
context-dependent combo button, which is why its policy does not belong inside the machine.
The machine keeps exactly one job: **the single place that can change window order,
shown/hidden, and which window holds key.** Today `decideEscape`, `escPolicy`,
`escUnhandledPolicy` and the `ASK_RENDERER` / `ESC_RENDERER_ANSWER` round trip all live
inside it and must move out. Two consequences fall out: the `'palette'` and `'utility'` arms
of `escPolicy` stop being unreachable dead code, and `deriveEscGrabRegistered` becomes the
Escape subsystem *querying* machine state rather than the machine deciding an OS grab.

**The one hazard in that split:** an interpreter that reads state and then emits an intent has
a gap where state can change in between. Carry the epoch the intent assumed and let the
machine drop stale intents — the correlation-token pattern already working in this codebase
as `ASK_RENDERER{seq}` / `ESC_RENDERER_ANSWER{seq}`.

**A transient window is dismissed when some other window, not belonging to it, genuinely takes
key — or when attention leaves the app entirely and settles on nothing of Peek's at all.**
Attention is one recorded fact with one holder, a window or none (`window-kernel.ts
State.lastAttention.holder`). Every settled move of that holder — a window taking OS focus, or the
app losing focus for real — runs the same query, `selectTransientAutoclose`, through the one
emission site in `react()`; no trigger has a dismissal path of its own. When the holder is `null`,
the directional one-hop exemption relation over `overlayFor` / `parentId` has nothing to point
with, so it admits nothing and every visible, unattached transient is dismissed — the same relation
at its degenerate value, not a second rule. This governs `window-kernel.ts
selectTransientAutoclose`, implemented against the kernel as recorded in §0.1.11. `window-state.ts`
— the reducer still driving production — keeps its own, older role-based sets
(`AUTOCLOSE_EXEMPT_ROLES`, `AUTOCLOSE_FOCUSER_EXEMPT_ROLES`) and its own
`selectAppResignTransients`; those are not the rule stated here and are not touched by it.

- **Ownership, not role.** A role-based exemption is wrong in both directions: an unrelated overlay
  taking key dismisses nothing, and a popup's relationship to its parent is expressed as a role name
  rather than as `parentId`. The exemption is a relation over `overlayFor` and `parentId` — a window
  attached to the transient is not "some other window." A window the transient merely *creates* is
  not exempt: a command palette that opens a page host is dismissed when that page host takes key,
  because the page host does not belong to it.
- **Provenance stays, and is not a second rule.** Whether the machine itself caused the event
  currently being handled is already stored fact 4 above; `FocusCause` is that fact. "Genuinely" in
  the rule means the key change came from the world, not from the machine echoing an operation it
  just requested. A machine-caused focus does not skip dismissal — it arms an ordering test, so a
  transient strictly newer than the focuser survives while an older one is still dismissed.
- **The seam is the settled loss, not the raw edge.** The app resigning active fires on ordinary
  activation churn — entering or leaving an overlay produces it — so keying dismissal to that raw
  edge would dismiss transients during normal overlay transitions. The settle guard
  (`pendingAppResignSweep`, armed by `AppResigned`, disarmed by `AppActivated`) and its 500ms delay
  exist to tell a real loss of focus from a resign the same activation cancels; only a settled,
  still-armed `AppResignSettled` writes `lastAttention`.
- **`holder` is a stored fact, never derived from `key`.** An app-resign event never touches `key`
  (RULE 2), so at the settle `key` may still name whichever window held it before the app resigned
  — and a selector reading `key` instead of the explicit `holder` would spare exactly that window,
  typically the palette that should close.
- **The machine applies the rule; no caller does.** `selectTransientAutoclose` stays a pure
  selector — a query, not a transition — but `react` emits the dismissals off a diff of
  `State.lastAttention`'s `seq`, not a branch on the event type. That keeps rule application
  non-optional: the machine remains the only thing that can dismiss a transient, and no dispatch
  site can silently skip running it.

**A transient window closes when it loses focus. Any reason. Always.** The exemptions are
relational, never per window kind: an overlay is attached to it (`rec.overlayFor !== undefined`);
it is click-through (`!rec.acceptsInput`) and so can never be in the user's way; the focuser names
it as parent (`focuser.parentId === rec.id`) or is its overlay (`focuser.overlayFor === rec.id`);
and a machine-caused focus spares anything strictly newer than the focuser (the ordering floor,
above). Transient roles are `window-kernel.ts TRANSIENT_ROLES`: `quick-view`, `palette`,
`switcher`, `overlay`.

**The exemptions are ONE statement, not one per reader.** `window-kernel.ts
transientAutocloseExemption` is that statement: it takes a single record, the focuser (or
`undefined`) and the ordering floor (or `null`), and returns which clause spared it or `null`.
Every reader of the law calls it — `selectTransientAutoclose` (the decision),
`traceTransientAutoclose` (the per-candidate diagnostic), and `evolve`'s `WindowRegistered` merge
arm, which asks the degenerate focuser-less question about a record a re-registration has just
made transient while it still carries a reversible `hiddenByAppBlur` hide. Each reader keeps its
own CANDIDACY filters (not the focuser, transient role, and — for the two sweeps — visible), its
own iteration and its own output shape; none keeps its own exemptions. That split is the point:
candidacy legitimately differs per reader, the exemptions cannot, and hand-restating them is how a
copy came to be missing the focuser-relation clause with nothing recording whether that was a
decision. There is deliberately no "ignore visible" parameter — making the law's answer depend on
which caller asked is the same defect in another shape.

Enforced by `window-kernel-properties.test.ts checkTransientHideIsNotDismiss` (the law spelled out
independently, so a hide-instead-of-dismiss path that never runs the selector is still caught) and
`checkStrandedHideAgreesWithSelector` (the same law read back THROUGH the selector, on a
counterfactually-visible probe, in both directions: a record the law would sweep may not sit on a
reversible hide, and a record whose hide was cleared while it stayed hidden must be one the law
would really have swept).

---

## 0.1 The rewritten kernel — state shape and structure

**Built, and now wired for queries.** `apps/desktop/main/window-kernel.ts` (the kernel —
`decide`/`evolve`/`react`, queries, selectors), `apps/desktop/main/window-escape.ts` (the Escape
interpreter) and `apps/desktop/main/window-kernel-executor.ts` (`WindowKernelExecutor`, the impure
edge that owns state, dispatches, and performs effects) exist and carry test coverage.
`apps/desktop/main/window-state.ts` and `window-os-adapter.ts` still own registration and OS
effects, but a cutover wired the ONE production `WindowKernelExecutor`
(`window-kernel-singleton.ts`, constructed over the real `ElectronWindowBackend` and reached
through `window-state-singleton.ts getKernelExecutorForApp`) so both machines drive the same
backend and the same `WindowId` space. Production reads the kernel's own queries directly for
"which window is front" now too — `windows.ts resolveFocusedWindowIdForClose`, `ipc.ts`'s
focus-assert call sites and `hybrid-overlay.ts`'s overlay-attachment target all read
`isContentWindow` / `isFrontEligibleWindow` / `topmost` / `keyWindow` / `topmostBaseLayerPageHost`
against that executor's live state, not a copy kept only for shadow comparison. `window-kernel.ts`
is therefore no longer imported only by `window-escape.ts`, `window-kernel-executor.ts` and their
tests — it has production readers across the window-manager surface. Derives from §0, plus a
survey of how other window managers and the state-machine literature solve the same problems.
Where this disagrees with §3–§5, those are the older design. The goal this answers: make the
machine as simple as possible; the kernel should be hardened to a diamond.

### The diagnosis

The reducer is ~3200 lines and 45 event types because of three structural mistakes, each with a
named, well-documented fix:

1. **Commands and events share one union.** Requests that may be rejected and facts that already
   happened are the same type, so guards are scattered across arms that cannot express rejection.
2. **Input interpretation lives inside the state owner.** §0 says this; the literature agrees and
   every mature system puts the boundary in the same place.
3. **Invariants are maintained by guards that a better encoding would make unstateable.**
   `stackOrderInvariantHolds`, `frontInvariantHolds`, `reconcileStackMembership` and
   `enforceFrontInvariant` all exist to repair states a different data structure could not
   represent.

### 0.1.1 Split the union: `decide` and `evolve`

```ts
type Command = { ...; expectedVersion: number };   // a request. MAY BE REJECTED.
type Event   = { ... };                            // a fact. Already happened. Cannot be rejected.

decide(state: State, cmd: Command): { events: Event[] } | { rejected: Reason };
evolve(state: State, ev: Event): State;            // TOTAL. No guards. Cannot fail.
```

**All guards live in `decide`; `evolve` has none.** That single constraint is most of the
line-count reduction and is what makes the kernel testable.

**Effects are a pure projection of the transition, not a side-channel:**

```ts
react(prev: State, ev: Event, next: State): Effect[];   // pure. No guards, no state.
```

The alternative — having `evolve` return `{ state, effects }`, or letting `decide` emit effects
directly — makes the effect list depend on something other than the transition, and replay
determinism over effects stops being checkable. As a projection it is checkable for free: fold the
log and concatenate `react` at every step. This also matches 0.1.6 — the OS stack is a write-only
projection of `order`, so the executor is a dumb re-assert loop with no decisions of its own.

Sorting today's 45 event types by mood gives roughly **~17 commands** (everything named
`*_REQUESTED`, plus `RAISE_WINDOW_REQUESTED` and `SWITCHER_OPEN_REQUESTED`), **~20 events** (the
past-tense OS reports — `WINDOW_SHOWN`/`HIDDEN`/`CLOSED`, `OS_FOCUS_GAINED`, `BOUNDS_CHANGED`,
`DISPLAY_CHANGED`, `APP_ACTIVATED`/`RESIGNED`, `WINDOW_CONTENT_ORDERABLE`, …), and **~8 that leave
entirely** with the Escape subsystem.

Why mixing them is not merely untidy: **replay determinism becomes false.** Replaying a stored
command re-evaluates its guards against a state rebuilt from other replayed commands, so one log
can produce different states. Replaying events is idempotent by construction, and every hardening
technique below depends on it.

### 0.1.2 Stale intents: `version` / `expectedVersion`

§0 names the hazard in moving interpretation out — an interpreter reads state, decides, and emits
an intent, and state can change in between. The standard answer is an **expected-version token**,
not a bespoke per-subsystem sequence number: `State.version` is one monotonic counter incremented
on every accepted event; every `Command` carries `expectedVersion`; `decide` rejects on mismatch
with a typed reason. This replaces `ASK_RENDERER{seq}` / `ESC_RENDERER_ANSWER{seq}` and `escSeq`.
It is ~10 lines, and it is the same mechanism as optimistic concurrency in event sourcing and as
fencing tokens in distributed locking.

**Exact precedent in this domain:** EWMH's `_NET_ACTIVE_WINDOW` client message carries a *source
indication* and the client's *last user-activity timestamp*, so the window manager can reject a
stale or illegitimate activation. That is rule 4's provenance plus this token, already
standardized. This is adoption, not invention.

### 0.1.3 Input interpretation moves out — the dependency arrow points one way

Three shipping systems put the boundary in the same place. **X11**: the server owns the window
tree and delivers raw input; the WM is just another client owning focus/stacking *policy*; clients
interpret their own keys. **Wayland**: `wl_seat` holds one keyboard focus; the compositor decides
*which surface* has focus, the client decides *what the key means* — there is even a negotiated
protocol for arbitrating who interprets a keystroke (`keyboard-shortcuts-inhibit`). **Android**:
`InputReader`/`InputDispatcher` are separate from `WindowManagerService`, and WMS *pushes* focus
information down to the dispatcher.

The load-bearing detail is the arrow's direction — the dispatcher never asks the window manager
"who is focused?" mid-decision. The rule here, stated the same way:

> The Escape/hotkey interpreter reads an immutable snapshot of kernel state, emits `Command`s
> carrying `expectedVersion`, and never queries the kernel mid-decision and never writes to it.

It is independently testable as a pure `(keyEvent, snapshot) → Command | null`. This removes
`decideEscape`, `applyEscape`, `decideEscapeUnhandled`, `escPolicy`, `escUnhandledPolicy`,
`applyUnhandledEscape`, `escAsk`, `escSeq`, `EscapeMode`, `session: IzuiSession`, the whole
`switcher: SwitcherState` sub-machine, and the `ASK_RENDERER` / `ESC_RENDERER_ANSWER` event pair the
old reducer answered them through. `deriveEscGrabRegistered` becomes that subsystem querying a
snapshot.

The renderer ask itself does not go with them. `EscapeKeyPress.rendererHandled` is a fact mirrored
into main (`window-escape-renderer-handled.ts`) with exactly one writer — the renderer's response to
the same `escape-pressed` message the old `ASK_RENDERER` sent — so removing the ask would leave that
fact frozen at whatever the previous press answered, and a window with a dialog open would decide its
first press against a stale or absent fact. The interpreter still needs the ask to fire before it can
decide; what the cutover changes is only the answer's path back — an event round-tripped through the
reducer, versus a value the ask's own caller already holds.

### 0.1.4 The state shape

```ts
interface State {
  /** RULE 1. EVERY window, bottom → top. Membership, order, and the records are ONE structure —
   *  not a Map plus a parallel id array. A window enters on registration and leaves on
   *  destruction; nothing else changes membership. */
  readonly order: readonly WindowRecord[];

  /** RULE 2. Which window holds key, or none. Written ONLY from OS reports. Never inferred,
   *  never repaired, never successor-guessed. `null` is a legal steady state. */
  readonly key: WindowId | null;

  /** RULE 4 + stale-intent rejection. */
  readonly version: number;
  /** RULE 4's counter: orders the machine's own focus-family actions so a later state can
   *  recognize an earlier one's echo as stale. Bumped by exactly one per transition that
   *  issues a `ShowWindow`/`RaiseWindow` effect, never per effect. */
  readonly opSeqCounter: number;

  readonly appActive: boolean;
  readonly openSeqCounter: number;
}
```

**One structure, not two, is the trick.** Today `windows: Map<WindowId, WindowRecord>` and
`stackOrder: WindowId[]` each independently encode membership, so they can disagree — which is
exactly why `stackOrderInvariantHolds`, `isStackMember`, `reconcileStackMembership` and
`stackRemove` exist. Collapsing them into one ordered array makes that entire class of bug
**unrepresentable rather than untested**, and deletes more code than any other item here.

`key` is the one field that can still dangle. Rather than guard it, make a dangling key
*unobservable*: expose it only through an accessor that resolves the id against `order` and
returns `null` on a miss. A stale key id then behaves as "nobody holds key", which is the honest
answer anyway.

**`opSeqCounter` (`window-kernel.ts`) advances by exactly one in each transition whose diff
`react` turns into a focus-family effect** (`ShowWindow` or `RaiseWindow`): a `WindowShown` that
genuinely flips `visible`, an `OsFocusGained` that genuinely raises, or an `AppActivated` that
re-shows what the app-resign sweep hid. The bump is per TRANSITION, not per effect — one
`AppActivated` re-showing three windows issues one op with one token, and `react` stamps every
focus-family effect it emits with that token, so all three records land the same `lastOpSeq`.
`evolve` writes the stamp and `react` reads the token from the same post-transition counter value,
so the two agree by construction; a property-based test asserts the equality per-transition,
per-event rather than trusting the two sites to stay in step by hand.

The reason the ordering matters: it lets a later state recognize an earlier action's own echo as
stale. `WindowRecord.lastOpSeq` holds the newest such token issued for that window; an incoming
`OsFocusGained` whose provenance is `machine` (`FocusCause`) carries the token of the op it is an
echo of. `WindowKernelExecutor apply()` (`window-kernel-executor.ts`) compares the two and drops a
stale echo before it ever reaches `evolve` — which it must, because `react` reads no event payload
and structurally cannot consult provenance to make the same call.

#### `WindowRecord`: orthogonal properties, no pre-combined class

```ts
interface WindowRecord {
  id: WindowId;
  kind: WindowKind;

  layer: number;          // index into a FIXED ordered layer array (see 0.1.6). Higher = above.
  canBecomeKey: boolean;  // Electron `focusable`. §0: "a HUD never holds key" needs no special case.
  acceptsInput: boolean;  // false = click-through (`setIgnoreMouseEvents`).

  class: WindowClass;     // creation-time shorthand for logs and singleton lookups. Nothing branches on it.

  // lifecycle + geometry carry over unchanged: visible, orderable, fsMode, bounds, maximized,
  // preMaxBounds, visibleOnAllSpaces, pendingProjectedBounds, openSeq, parentId, overlayFor,
  // keepLive, role, source, params, lastHttpUrl, hiddenByAppBlur, contentFocused, lastOpSeq.
}
```

**The rule that keeps `class` honest.** A *lookup* by class is allowed (find the background
window, sweep the HUDs); a *policy predicate* branching on class is not. Mechanical test: outside
registration, `rec.class` may appear in an equality test whose result is an identity, never in one
whose result is a decision. Every decision reads `layer`, `canBecomeKey`, `acceptsInput`, or a
relation. Checkable by lint, like the existing zero-value-imports rule.

**These three bits are the industry-standard encoding**, not an invention: AppKit exposes
`isVisible` / `ignoresMouseEvents` / `canBecomeKeyWindow` independently; wlr-layer-shell has
`keyboard_interactivity: none`; ICCCM has the No-Input model; dwm has one `neverfocus` bool
derived from `WM_HINTS.input`.

#### How much of the three axes exists today — measured

**How these are measured.** A window's construction options come from three places, and all three
must be read before any claim about how production windows are built: main-process construction
sites (`hybrid-overlay.ts` `ensureOverlay`, `test-fixture-glue.ts`), renderer-driven opens through
`api.window.open` (`renderer/**` and `features/**` background scripts), and the window entries
declared in feature manifests, which `tile-launcher.ts` resolves into options and hands to
`main.ts` `registerWindow`. A survey restricted to main-process sites misses the windows that
features open for themselves — which is precisely the class of window that carries the unusual
flags, because the chrome the main process builds is the conventional part of the system.

- **`layer`** — real but degenerate: `'floating'` is the only non-default level ever passed
  (`electron-window-backend.ts` `pinAlwaysOnTop` and `setStacking`); `'normal'` appears only in
  that file's `setAlwaysOnTop` type signature and is passed nowhere. Renderer-driven opens cannot
  widen this — `ipc.ts` coerces `api.window.open`'s `alwaysOnTop` to a boolean, and
  `tile-launcher.ts` does the same with the manifest field, so no caller outside the backend can
  name a level. The multi-band ordering §0 asks for is **unimplemented**, not merely unmodelled.
- **`canBecomeKey`** — `focusable: false` is threaded through registration, feeds
  `classifyWindowRegistration` and `isSatelliteRegistration`, and **is used by production
  windows**. Every one of them is opened from a renderer or a manifest, none from a main-process
  construction site:
  - `renderer/hud/background.js` `openHud()` opens with `alwaysOnTop: true, focusable: false` and
    no `role`, so `inferIzuiRole` returns `workspace` and `classifyWindowRegistration` returns
    `hud`. This is the real HUD, and it is the only production window that classifies `hud`.
  - `features/spaces/background.js` `showBorder()` opens the screen-border window with the same
    two flags but `role: 'overlay'`, so the role arm wins and the class is `overlay`, never `hud`.
    The `border` entry in `features/spaces/manifest.json` declares the same three options and
    reaches the same classifier through `tile-launcher.ts` and `main.ts` `registerWindow`.
  - `test-fixture-glue.ts` is `focusable: false` but not always-on-top, and declares the class
    `test-fixture` outright — test-only, and outside the always-on-top-plus-non-focusable pair.

  The chrome overlay is `focusable: true` by invariant (`hybrid-overlay.ts` `ensureOverlay`): a
  non-focusable overlay cannot take key, which breaks typing a URL in the navbar.
- **`acceptsInput`** — real and live in two production windows. The chrome overlay is toggled
  between capture and click-through by `hybrid-overlay.ts` `wireClickCapture` (as the pointer
  enters and leaves the chrome) and `wireAppActiveGate` (as the app activates and resigns), using
  `setIgnoreMouseEvents(false)` and `setIgnoreMouseEvents(true, { forward: true })`. The spaces
  screen border sets it once at creation: `features/spaces/background.js` `showBorder()` calls
  `api.window.setIgnoreMouseEvents(id, true, true)`, which lands on the
  `tile:window:set-ignore-mouse` handler in `tile-ipc.ts`. That handler is the general tile-facing
  route, gated on the `window.manage` capability, so it is available to any feature that declares
  it — the axis is not structurally confined to core chrome.

**The old `hud` class decomposes into three parts, not one.** `classifyWindowRegistration` returns
`hud` for `alwaysOnTop === true && focusable === false`, after the declared roles (`overlay`,
`palette`, `quick-view`) have already claimed their classes — so role takes precedence over the
pair. In the orthogonal record the two flags sit on different axes: `alwaysOnTop` is the `layer`
band, and `focusable: false` is `!canBecomeKey`. A rule that used to read `class === 'hud'`
therefore needs all three parts restated — the layer band, `!canBecomeKey`, and the role
exclusion. `!canBecomeKey` on its own is half of the pair, and it is not an inert half: it admits
the non-focusable window that never floated (the test fixture) and, without the role clause, the
non-focusable always-on-top windows that a declared role kept out of `hud` (the spaces screen
border).

### 0.1.5 Queries that replace `front`

| Question | Query |
|---|---|
| Who is taking keystrokes right now? | `state.key` — the stored fact. What Escape needs, and what `front` got wrong. |
| What should be restored / fallen back to? | `topmost(state, restorable)` — scan `order` from the top. |
| May this window be raised? | `raiseEligible(state, id)` — a named guard in `decide`. |
| Which page-host does the chrome overlay track? | `hostOf(overlay)` — the `overlayFor` relation. Never was a front question. |

Three current readers ask something that is none of those: `hybrid-overlay.ts
frontPageHostOsId()` (an attachment query — use `overlayFor`), `ipc.ts openNewPageWindow()`
(space-mode inheritance — `topmost(state, isPageHost)`), and `tile-ipc.ts` dialog parenting
(`state.key ?? topmost(state, isPageHost)`).

**`WindowRecord.focusSeq` and `AppWindowState.focusSeqCounter` are deleted** (see 0.1.10). There
is one order; a raise moves the window to the top of it, and "most recently used matching P" is
`topmost(state, P)`.

`WindowRecord.openSeq` **stays** — a genuinely different fact (open order, not use order) that
`selectTransientAutoclose` needs, and one that cannot be derived from `order`.

#### Key vs. main: `front` was trying to be two things

AppKit stores **two** focus facts, for exactly the reason at issue here: the **key window**
receives keyboard input, while the **main window** is "the standard window where the user is
currently working" — the semantic target of menus and commands. When key status shifts from a
standard window to a *panel*, **main status stays with the standard window**.

That is the command-palette case verbatim. The palette holds key; the page-host is still what
`tag <name>` must act on. `front` was trying to be *main* while being written from focus events —
which is why it drifts, and why `isEligibleFront` had to exclude satellites: it was hand-rolling
"panels don't become main."

**This needs no second stored fact.** `key` is stored (rule 2); *main* is the query
`topmost(state, isContentWindow)`. Naming the distinction is the point — bucket A of the test debt
below is asking for `key`, bucket B is asking for main, and today both read one field.

#### `key` is reported, never repaired — a real behavior change

`enforceFrontInvariant` currently rewrites `front` to a successor at the end of every `reduce()`.
That self-repair is what let `front` drift from the window actually holding key, which is the
Escape bug. In the new shape there is nothing to repair: between "the key window closed" and "the
OS reports the next one", `key` is `null`. Callers relying on `front` being effectively never-null
switch to `topmost(state, …)`, which is total.

Every surveyed WM does it this way — restore-after-close is a **scan, never a stored successor**.
dwm walks its MRU list for the first visible client; i3 descends `focus_head`; sway filters
`focus_stack` by ancestry. A stored successor pointer is redundant and goes stale (sway #5773 is
exactly that bug).

#### Wiring map: each current reader of `front`, resolved

`keyWindow(state)` is the mapping that looks obvious and is wrong for every production reader of
`front` below. Old `front` was satellite-excluding and sticky across app switches; kernel `key` is
neither — `OsFocusLost` nulls it, and a satellite such as the shared chrome overlay can hold it.
Every reader in this map wants the topmost content window, never the key window.

**Two readers turn a naive `key` mapping into a silent bug, with no error path to catch it:**

- `session-projection.ts` `serializeSession` / `serializeSpaceWorkspaces` read
  `focused: w.machineId === snapshot.front`. Sessions save on quit, app-resign, and window
  close — exactly when `OsFocusLost` has already nulled `key`. Mapping to `keyWindow` marks every
  saved descriptor `focused: false` and leaves restore with no head-start window. Correct mapping:
  `topmost(state, <content predicate>)`.

- `ipc.ts` `openNewPageWindow()` inherits exactly one thing, the datastore context row
  `getContextEntry('mode', <electron id>)`: when its value is `'space'`, it copies
  `metadata.spaceId` / `spaceName` / `color` into `options.spaceMode`. The chrome overlay
  routinely holds key at Cmd+N time — Cmd+L opens the address bar, and `main.ts` special-cases
  only Cmd+L for the overlay, so Cmd+N passes straight through. The overlay has no mode row, so
  space mode drops silently: the `try` swallows, and `if (modeEntry && …)` falls through with no
  error. The structurally correct fix threads the dispatch-site window id into
  `openNewPageWindow(sourceWindowId?)` — `handleLocalShortcut` already receives it at both
  dispatch sites (`main.ts` `windowId`, `ipc.ts` `wireHybridContentEvents` `hostWindowId`) —
  falling back to `topmost(content)` only when the source is the overlay or carries no mode row.
  That reuses the opener-lineage rule `windowOpenHandler` already applies via
  `windowFromWebContents(ev.sender)`, rather than adding a rival authority. Note the pre-existing
  asymmetry this does not paper over: the opener-lineage path inherits both `'space'` and
  `'group'` mode, while `openNewPageWindow` inherits only `'space'`.

**`hybrid-overlay.ts` `frontPageHostOsId()` is two different queries wearing one name:**

- The read-back of the current attachment — `ensureOverlay()`'s `did-finish-load` handler
  (`sendActiveHandoff`), `wireShowNavbarFocus()`'s windowId gate, `wireExecuteScript()`,
  `initHybridOverlay()`'s `registerLoadErrorListener` callback, and the test bridge `activeId()` /
  `runDeferredBlur()` — all want the overlay record's own `overlayFor` field, not an ordering
  query. `overlayForHost(state, hostId)` runs the wrong direction; it takes the host id these
  callers are trying to find. `window-kernel.ts` exports `hostForOverlay(state, overlayId)`,
  the opposite query these callers need — it reads the overlay record's own `overlayFor` field
  and returns the host it names, rather than searching for an overlay by host id.

- The driver that decides the attachment — `initHybridOverlay()`'s `subscribeFrontChange` →
  `retarget()`, and its seed read — is a genuine ordering query. The naive predicate,
  `topmost(state, r => r.kind === 'page-host' && r.visible && r.orderable)`, would be wrong as
  written, in two independent ways (the second is developed below): it has no role clause, so it
  admits a `quick-view` page-host — every hybrid page-host registers `kind: 'page-host'` via
  `ipc.ts assembleHybridPageHost`, peeks and slides included, with `role: 'quick-view'` — and the
  set it admits spans more than one `layer`, which the rule below forbids for any `topmost`
  predicate. Implemented as written, the chrome would frame a floating peek while a base-layer
  page sits underneath it. `window-kernel.ts` exports `topmostBaseLayerPageHost(state)` with both
  clauses added — `layer === BASE_LAYER` and a role check against `CONTENT_ROLES` — closing both
  gaps.

The split matters because `retarget(id)` detaches when `getHybridWindow(id)` is null, the base
window is destroyed, or the overlay id is not yet minted. In those states the topmost page-host is
non-null while the overlay frames nothing — an ordering query sitting in the read-back position
paints a navbar over a window with no chrome attached, and runs extension script in a page that is
not visible.

**`order` carries no layer information, and this retarget query is exactly where that stops being
free.** In `window-kernel.ts` `evolve`, five arms touch a position in `order` — `initialState`,
the `WindowRegistered` merge and fresh-registration branches, `WindowClosed`, and `OsFocusGained`
— and none reads `layer`; every other arm is a field rewrite over `order.map(...)`. So `order`
legitimately holds a base-layer window above a floating-layer one, and `topmost` (which scans
`order` from the end) can return a window that is not visually on top of it. That is correct, not
a bug: `react` walks `order` in raw sequence and the executor's bottom-to-top `moveTop()` replay
realizes each layer band correctly regardless of cross-band position (0.1.6) — but it means
cross-band position in the array is unobservable to the OS, and therefore meaningless input to a
predicate whose admitted set spans bands.

The one predicate that already scans all of `order`, `isContentWindow`, is safe only because it
collapses to a single band: the HUD and the space border are excluded by `canBecomeKey`, and the
cmd panel and peeks/slides are excluded by role. The naive retarget predicate above,
`topmost(state, r => r.kind === 'page-host' && r.visible && r.orderable)`, carries no such clause
— it admits a page-host in a floating band (behind the cmd panel, a peek, a slide) alongside
base-layer page-hosts. That set is genuinely cross-band, and for it array position and visual
stacking can diverge with no error path. This is the layer half of the two-fold defect noted above,
closed the same way the role clause is: `topmostBaseLayerPageHost`'s `layer === BASE_LAYER` clause
is the layer-aware replacement. General rule — a `topmost` predicate is safe only when the set it
admits lies within one layer band; a predicate spanning bands must add a `layer` clause or be
replaced by a band-aware query. Registering any content window above the base layer would silently
break `isContentWindow` the same way.

**`session-projection.ts` reads `focusSeq` and `stackOrder` directly, not just `front`:**

- `serializeSession` emits `zOrder` from `WindowRecord.focusSeq` and `stackIndex` from a map built
  over `snapshot.stackOrder`; `serializeSpaceWorkspaces` emits `zOrder` from the same map.
  Resolution: one order is enough — both fields become position in the kernel's `order`. The two
  orderings diverge in the old machine only because `window-state.ts`'s `WINDOW_SHOWN` non-focused
  branch calls `stackRaise` without `bumpFocusSeq`; the kernel deletes that producer rather than
  reconciling the two facts (`window-kernel-properties.test.ts checkInvariants` enforces `the key
  window is not topmost in order` over every generated log), so no consumer can observe a
  difference. `STACK_ORDER_IMPORTED` enters the kernel as a reorder-only command that replaces
  `order` wholesale, preserving membership by construction, exactly as `window-state.ts`'s arm
  does. `session-projection.test.ts`'s two pinned-divergence tests get rewritten to pin the
  kernel's fact (a background open registers below the key window), not re-pointed at the new
  fields.

**`window-state.ts getDevtoolsTargetId` (exported through `window-state-singleton.ts`) is a third
unsurveyed `focusSeq` reader, with no `visible` clause** — a live behavior difference from any
`topmost` replacement. Resolution: `lastHttpUrl` does not join the kernel record — its only reader
is this caller, `applyFocusGained` only ever sets it and never clears it (a window that navigates
from https to `peek://` stays a stale devtools candidate forever), and the kernel exists to stop
storing facts it can derive. The replacement is a filtered scan of `order`, reading each
candidate's live URL at call time, which also retires the staleness and adds the `visible` clause
the current selector lacks — an intended behavior change, not a preserving translation.

**Two test-bridge readers are unlisted, and one depends on deleted behavior:**

- `entry.ts __peek_test.getFrontWindowId` — asserted by `session-restore-hybrid-focus.spec.ts` and
  `session-restore-page-host.spec.ts` as "which window did restore focus". Resolution:
  `topmost(state, isContentWindow)`, not `keyWindow`, which is null exactly where those specs
  assert.
- `hybrid-overlay.ts`'s test-bridge `setActive` loops up to 100 times because, in its own words,
  each closing assertion promotes and re-raises the MRU successor — it is written against
  `enforceFrontInvariant`'s successor repair, the mechanism "key is reported, never repaired"
  deletes. Resolution: re-pointing its `activeId()` is not enough; the bridge contract must be
  rewritten against `hostOf(overlay)`.

**`window-state-singleton.ts getFocusOrder` reads `focusSeq` and has zero callers** — dead, and
still a compile blocker. Resolution: delete.

**`shortcuts.ts LocalShortcutEntry.callback` takes no arguments today.** Threading
`sourceWindowId` into `openNewPageWindow` (the fix described above for its silent space-mode drop)
first requires widening this callback's signature to accept the dispatch-site window id.

**Thirty-seven further reader call sites, not narrated above.** A grep of `apps/desktop/`
production, preload and renderer code finds 52 reader call sites in total; the bullets above name
15 of them, each verified present and correctly described. Counting unit: a reader call site
(enclosing symbol × fact read) — the same unit the `hybrid-overlay.ts` bullets above use, whose own
inventory (`frontPageHostOsId()`, 7 call sites plus 2 bridge readers, all 9 named) is exact. The
remaining 37, grouped by process:

**Main process (19):**

| file · symbol | what it does with the value | how a wrong translation fails |
|---|---|---|
| `windows.ts resolveFocusedWindowIdForClose` | The Cmd+W close target. Converts `front` → native handle → Electron id for `closeOrHideWindow`. Re-exported from `main/index.ts`; called by `closeFocusedWindow`, the menu handler, the non-darwin shortcut, and the hybrid test bridge. | silent — a `keyWindow` mapping closes the chrome overlay, or no-ops after app-resign nulls key. `window-kernel.ts isFrontEligibleWindow`'s docblock prescribes the composition (key when itself front-eligible, else `topmost(state, isFrontEligibleWindow)`) — not `isContentWindow`, whose role allow-list excludes `role: 'quick-view'` and so would close the page host behind a focused peek instead of the peek itself; the map never lists the reader. |
| `entry.ts onReady` (app-menu template, Window ▸ Close Window click) | Reads `front`, resolves the native window, runs the detached-devtools guard (`isDevToolsOpened() && !wc.isFocused()`), then calls `closeFocusedWindow()` | silent — a wrong front makes the devtools guard mis-fire and closes the parent |
| `tile-ipc.ts` `tile:dialogs:save` handler | Parents the save dialog over the front window; falls back to the sender | silent (falls back) |
| `tile-ipc.ts` `tile:dialogs:open` handler | Same parenting | silent |
| `tile-ipc.ts` `tile:window:fullscreen` handler | Default target when no `args.id`; also supplies the pre-fullscreen bounds stash | mixed — null yields `'Window not found'`; a wrong id fullscreens the wrong window silently |
| `tile-ipc.ts` `tile:window:get-focused-visible-id` handler | The entire renderer-facing "active window" surface; returns `front`'s numeric id | silent, and fans out to the 15 renderer readers below |
| `tile-ipc.ts` `tile:window:devtools` handler | `getDevtoolsTargetId() ?? getFrontWindowId()` — the map names the selector, not this call site or its `??` fallback | mixed — both-null returns an error string; a wrong id opens devtools on the wrong page silently |
| `tile-ipc.ts` `tile:theme:setWindowColorScheme` handler | Tier 2 of explicit-id → front → headless "highest-numbered focusable window" | silent — tier 3 masks a wrong or null tier 2 and themes an arbitrary window |
| `tile-ipc.ts tileResolveWebWindow` | Default target for `tile:nav:back/forward/reload/state`; post-filters on a live `webContents.getURL()` http(s) check | mixed — `'No web page window'` on null, silent wrong-window navigation otherwise |
| `ipc.ts` window-open modal-blur handler (the `blur` listener inside `wireWindowOpenHandler`) | `getFrontPageHostId()` in a DEBUG log naming the focus thief | compile-loud; behaviorally inert |
| `window-state-singleton.ts seedSessionMirror` | Installs `coord.setFrontWindowIdProvider(() => front → native id)` — the injection point that hands `front` to izui | silent |
| `izui-state.ts IzuiCoordinator.enterOverlay` | Calls that provider to seed `session.preOverlayFocusTarget`, the switcher's focus-restore target | silent, and its correctness argument rests on two facts the cutover deletes: its comment states "a satellite can never be `front`" and "`OS_FOCUS_SETTLED_NULL` keeps it: front is the TARGET, not the key window". Under `key`, the switcher — shown and focused before `enterOverlay` runs — can seed itself. |
| `window-os-adapter.ts logTransition` | Formats `before.front→after.front`, the `contentFocused` delta of `after.front`, and the `stackOrder` delta | compile-loud |
| `window-kernel-shadow.ts compareShadowKernelState` | Reads `oldMachine.front` and `oldMachine.stackOrder` and compares against `topmost(kernel, isContentWindow)`; runs on every shadow feed (only the console line is env-gated) | compile-loud — but deleting it removes the cutover's only automated divergence oracle, which needs its own decision rather than a fold-in |
| `session.ts saveSessionSnapshot` | The read phase: `getWindowStateSnapshot()` → `serializeSession` | compile-loud |
| `session.ts saveSpaceWorkspaces` | Same → `serializeSpaceWorkspaces` | compile-loud |
| `session.ts restoreSessionSnapshot` | Sorts descriptors by persisted `zOrder` descending (`zOrderSorted`), hoists `focusedDescriptor`, and that ordering drives the eager/deferred staged-restore split and the focus-restore target | silent — one hop out from `serializeSession`'s `zOrder`; changed provenance re-orders which windows load hot |
| `session-projection.ts readStackIndex` + `orderRestoredWindowsBottomToTop` | Read the persisted `stackIndex` (the deleted `stackOrder` fact) to compute the bottom-to-top replay, with a legacy branch for pre-`stackIndex` snapshots | silent for aged profiles — the legacy branch stacks by a different rule with no error path |
| `window-state-singleton.ts getFrontPageHostId` + `subscribeFrontChange` | The two intermediary selectors: `getFrontPageHostId` is `front` iff its record is `kind: 'page-host'`; `subscribeFrontChange` re-reads it on every dispatch and edge-dedups | silent — the map assigns the hybrid consumers but never these two. Under `key` the selector goes null whenever the overlay holds key, so the subscriber fires a spurious `retarget(null)` and detaches chrome from a still-visible page. |

**The `resolveFocusedWindowIdForClose` composition is provably redundant, not just readable.**
Key-when-itself-eligible-else-topmost equals a bare `topmost(state, isFrontEligibleWindow)` in
every reachable state: `evolve`'s `WindowRegistered` arm inserts a new record below the key
window's index, `StackOrderImported` re-lifts the key window to the top of `order`, and
`window-kernel-properties.test.ts checkInvariants` asserts the key window is last in `order` over
every generated log. So whenever the key window is itself front-eligible it is also already the
topmost front-eligible record, for any predicate that admits it — the `key` branch never actually
changes the answer the `topmost` branch would give. The composition stays written out because it
names the INTENT (prefer the key window, the one actually taking keystrokes) rather than relying on
an invariant a reader would have to trace three files to rediscover — not because a reachable state
exists where the two forms disagree. No test should be written trying to discriminate them; none
can.

**Preload (3):** all in `tile-preload.cts`; all silent pass-throughs that relay a changed answer.

- `api.window.getFocusedVisibleWindowId` — invokes `tile:window:get-focused-visible-id`
- `api.theme.setWindowColorScheme` — invokes the same channel to compute the `windowId` hint it passes to `tile:theme:setWindowColorScheme`, so the color-scheme chain reads `front` twice, once in preload and once in main
- `api.izui.getPreOverlayFocusTarget` — relays the `front`-seeded target

**Renderer and features (15):** all downstream of `tile:window:get-focused-visible-id` or of
`front`-derived persisted fields, and all silent: a wrong id reads or writes another window's
state, a null id degrades to "No active window".

- `renderer/cmd/panel.js loadCommandContext` — `api.context.get('mode', targetWindowId)`, drives the palette's mode indicator
- `renderer/cmd/panel.js cycleMode` — `api.context.setMode(…, { windowId })`, a write of per-window mode to the resolved id
- `renderer/hud/widgets/window.js refreshWindowInfo` — highlights the focused row
- `renderer/hud/widgets/mode.js refreshMode` — reads that window's `mode` context
- `features/spaces/background.js updateBorderVisibility` — shows or hides the space border from the focused window's mode row
- `features/groups/home.js resolveCurrentGroup` — resolves the active group from the focused window's mode metadata
- `features/groups/home.js openGroup` — sorts open order by the persisted space-workspace `zOrder`, i.e. by `stackOrder` position
- `features/tags/background.js getActiveWindow` — picks the page to tag or untag; its docblock is written entirely against `front`'s satellite-exclusion rule
- `features/windows/background.js` — the `center window`, `maximize window`, `unmaximize window` and `fullscreen` commands, four sites, all targeting the resolved id
- `features/entities/home.js` — the `extract entities` command's `execute` and the `extractBtn` click handler, two sites, picking which page to extract from
- `features/windows/windows.js init` — uses `getPreOverlayFocusTarget()` to choose the switcher's initially-selected card

Confirmed not readers, so absent from both the bullets above and this table: `window-escape.ts`
(prose mention only; the live escape decision is `decideEscape` inside `window-state.ts`), `main.ts`
(its `getWindowStateSnapshot()` calls are shadow feeds), `electron-window-backend.ts` (producer, not
reader), `izui-roles.ts` (comment only), `window-registry.ts` (type declaration and comment only),
and every file under `chrome-api-polyfills/`.

The three highest-risk among all 52: `windows.ts resolveFocusedWindowIdForClose` (destructive and
silent), `izui-state.ts enterOverlay` (its correctness comment cites two deleted facts by name), and
`window-state-singleton.ts getFrontPageHostId` / `subscribeFrontChange` (a silent chrome detach that
no named hybrid consumer can see, because the map re-points the consumers and leaves the selector
beneath them).

#### The map above is incomplete — re-measured against the code

The gaps re-measured below are now folded into the map above; this section stays as the measured
evidence they were derived from.

Re-checking every entry against the tree found the map's hazards intact and its call-site inventory
short by roughly a third. It names readers of `front`; the cutover also deletes `focusSeq` and
`stackOrder`, and readers of those two were never surveyed. Since §2 forbids splitting the cutover,
each gap below is a compile error or a red spec inside a commit that cannot be landed in halves.

**`session-projection.ts` reads all three facts, not just `front`.** `serializeSession` emits
`zOrder` from `WindowRecord.focusSeq` and `stackIndex` from a map built over `snapshot.stackOrder`;
`serializeSpaceWorkspaces` builds the same map and emits `zOrder` from it. `session.ts`
`saveSessionSnapshot` / `saveSpaceWorkspaces` feed both, and restore replays `stackIndex` literally
through `STACK_ORDER_IMPORTED` — which §0.1.5's own inventory files as expected-but-unwritten. Three
persisted fields and one restore path therefore rest on the two facts the cutover deletes, with no
recorded mapping onto kernel `order` position and no kernel home for the event that replays it.

**The focus-producer entry is true of the wrong layer.** `electron-window-backend.ts`
`attachNativeListeners` emits `OS_FOCUS_GAINED` (from the window's `'focus'`, again from the
page-host renderer's, and a third synthesized on the app-activation path) and `armBlurSettle` emits
`OS_FOCUS_SETTLED_NULL` — all four into the OLD machine's sink. Nothing translates to kernel
`OsFocusGained` / `OsFocusLost`, as this section states two paragraphs later. The translation is not
mechanical: `OS_FOCUS_SETTLED_NULL` is an explicit no-op that KEEPS `front` (the historical-bug
replay pins this), while `OsFocusLost` NULLS `key`. Reading the entry as "nothing to do here" ships
either an app switch that nulls key or one that never does, and neither is recorded as intended.

**The devtools fold-in cannot be executed as written.** The map tells both devtools callers to fold
their http/https post-filter into the predicate. `window-kernel.ts` states the opposite — the
http/https set needs a URL fact the kernel does not carry (`WindowRecord.lastHttpUrl`), so those
callers post-filter until it does. Either add the field or keep the filtered scan; a post-filtered
`topmost` is not `topmost`. Separately `window-state.ts getDevtoolsTargetId` (exported through
`window-state-singleton.ts`) is a third unsurveyed `focusSeq` reader, and it carries no `visible`
clause — a live behavior difference from any `topmost` replacement.

**Two test-bridge readers are unlisted, and one depends on deleted behavior.** `entry.ts`
`__peek_test.getFrontWindowId` is asserted by `session-restore-hybrid-focus.spec.ts` and
`session-restore-page-host.spec.ts` as "which window did restore focus" — it maps to
`topmost(state, isContentWindow)`, and `keyWindow` makes it null exactly where those specs assert.
`hybrid-overlay.ts`'s E2E bridge `setActive` loops up to 100 times because, in its own words, each
closing assertion promotes and re-raises the MRU successor — it is written against
`enforceFrontInvariant`'s successor repair, the mechanism "key is reported, never repaired"
deletes. Re-pointing its `activeId()` is not enough; the bridge contract must be rewritten against
`hostOf(overlay)`.

**Smaller, but each a compile site.** `window-state-singleton.ts getFocusOrder` reads `focusSeq`
and has zero callers — dead, and still a compile blocker. The "incidental blur log" is anchored to
`ipc.ts wireHybridContentEvents`, which contains no front read at all; the log is in the
window-open modal-blur handler and reads `getFrontPageHostId()`. The color-scheme channel is now
`tile:theme:setWindowColorScheme` and its front read is tier 2 of a three-tier chain, not a
one-line swap. `window-os-adapter.ts`'s dispatch log also formats `stackOrder` and reads
`after.front` twice more. Threading `sourceWindowId` into `openNewPageWindow` first requires
widening `shortcuts.ts` `LocalShortcutEntry.callback`, which takes no arguments today.

The three traps hold. Trap 1 is understated rather than wrong: two of the readers that most need
`topmost(state, isContentWindow)` are ones the map never listed. Trap 2 is clean — no caller has
grown a rival page-host predicate, and `window-state-singleton.ts getFrontPageHostId` remains the
only outside one, still in the defective shape this section warns about. Trap 3 holds exactly:
`deriveWindowSurface()` has zero production callers, and fifteen registration sites (ten
production, five `E2E_TEST`-gated: four in `hybrid-overlay.ts installTestBridge()`, plus
`test-fixture-glue.ts`, gated by its own docblock rather than living inside that bridge) would need
extending, of which only the `main.ts` tile-launcher seam and the `ipc.ts` BrowserWindow window-open path hold
the derivation inputs today.

#### Decided: the three calls the map revision was blocked on

The `zOrder`/`stackIndex` and `getDevtoolsTargetId` decisions below are now folded into the map's
`session-projection.ts` and `getDevtoolsTargetId` entries; this section stays as the reasoning that
produced them. The third decision, that `key` nulls on settle, closes Open question 2 (§0.1.10) and
was never a map gap — see "`key` is reported, never repaired" above.

**One order is enough for session restore. `zOrder` and `stackIndex` both become position in
`order`.** The two orderings genuinely diverge in the old machine, and the divergence is produced,
not incidental: `window-state.ts`'s `WINDOW_SHOWN` non-focused branch calls `stackRaise` without
`bumpFocusSeq`, so a background open sits above the last-focused window in `stackOrder` while
ranking below it in `focusSeq`. The kernel deletes the producer rather than reconciling the two
facts — a background open is registered BELOW the key window, and
`window-kernel-properties.test.ts checkInvariants` enforces `the key window is not topmost in
order` over every generated log. With that state unreachable, no consumer can observe a
difference. Concretely: `session-projection.ts serializeSession` takes both `zOrder` and
`stackIndex` from `order` position, and `serializeSpaceWorkspaces zOrder` likewise;
`session.ts restoreSessionSnapshot`'s loading order (descending position, feeding the eager/deferred
split) and its bottom-to-top replay stay reverses of one another, both derived from the one list.
`STACK_ORDER_IMPORTED` enters the kernel as a reorder-only command that replaces `order` wholesale,
preserving membership by construction, exactly as `window-state.ts`'s arm does.

Two consequences that were not translations and were done as rewrites, not re-pointings. The
formerly pinned divergence tests in `session-projection.test.ts` — `the saved stacking position is
not the focus-recency rank` and the round trip `a background open comes back ON TOP of the
last-focused window`, which asserted the two orders are reverses for the same pair — are now `a
background open is saved BELOW the last-focused window` and `SAVE → RESTORE round trip: a
background open comes back BELOW the last-focused window`, pinning the kernel's fact (a background
open registers below the key window) instead of the producer this design deletes. And
the z-order sort helper that once lived in `renderer/lib/session.js`, which had no callers anywhere
in the tree, is gone.

Two carry-overs, neither blocking: `orderRestoredWindowsBottomToTop`'s legacy branch for snapshots
that predate `stackIndex` stays until those profiles age out (`tests/helpers/restore-proof/
inject-session.sql` is the fixture exercising it), and `features/groups/home.js openGroup` sorts
descending by the space-workspace `zOrder` to pick open order — under one order that agrees with
the session reader's descending sort, so it needs no change beyond the field's new provenance.

**`key` is nulled when focus settles away from every Peek window, and this closes open question 2
below.** The framing that made this look like a behavior change was wrong: the sticky
"which window was I last working in" fact that must survive an app switch is answered by
`topmost(state, isContentWindow)`, which is total and indifferent to activation — not by `key`.
§0.1.5's wiring map already assigns every production reader to that query and none to
`keyWindow(state)`, so nulling changes no reader's answer. Keeping `key` populated while no window
holds key in the OS sense would be a repaired value under another name, which is precisely the
defect this rewrite removes: RULE 2 is that `key` is reported, never repaired.

Two constraints the port must honor. The null is driven from the SETTLE, never from the resign
edge — `electron-window-backend.ts armBlurSettle` coalesces to one `setImmediate` and checks
`anyWindowFocused()` before emitting, so it survives the macOS activation dance, and the resign
edge does not. And the shapes differ: `OS_FOCUS_SETTLED_NULL` carries no id (it reports that focus
left the whole group) while `OsFocusLost` names a window. The settle therefore emits `OsFocusLost`
naming the current `key` when one is held, and nothing otherwise — a per-window report, keeping
RULE 2 intact and needing no group-wide kernel event.

The old machine's arm and its two pins go with the producer. `window-state.ts`'s
`OS_FOCUS_SETTLED_NULL` no-op, `window-state.test.ts`'s `(b) S2-null focus lag` and
`DELIBERATE DIVERGENCE: focus leaving the whole group keeps front` all constrain `front`, which the
key/main split replaces with two facts; each is re-expressed against `topmost`, which still must
survive the switch.

**`lastHttpUrl` does NOT join the kernel record; the devtools caller scans and filters.** The field
has exactly one reader in the entire tree, `window-state.ts getDevtoolsTargetId`. The second caller
the earlier note pairs with it, `tile-ipc.ts tileResolveWebWindow`, never touches the record — it
reads a live `webContents.getURL()` on a single `front` candidate — so carrying the field would
serve one caller, not two. The cost is also understated by the `escapeMode` precedent: that field
is declared at registration and rode a pass-through, whereas `lastHttpUrl` is a lived fact written
by focus, so it would additionally need a URL payload on `OsFocusGained` and a write inside an arm
that today rebuilds `order` and touches no record field.

The decisive argument is correctness, not cost. `applyFocusGained` only ever SETS `lastHttpUrl` and
never clears it, so a window that navigates from https to `peek://` keeps a stale http URL and
stays a devtools candidate forever. That is a known-stale stored fact, and the kernel exists to
stop storing facts it can derive. `getDevtoolsTargetId`'s replacement is a filtered scan of `order`
reading each candidate's live URL at call time, which also retires the staleness. Note the
replacement is not a behavior-preserving translation in one respect worth stating: the current
selector scans the whole window Map with no `visible` clause and ranks by `focusSeq`; a scan over
`order` is inherently stack-ordered and admits a `visible` clause. Adding one is the intended
behavior, and the devtools target changing for a hidden window is the visible difference.

#### Where the swap draws its line: by responsibility, not by machine

The moment the kernel becomes authoritative, the question is not "is the old machine off yet"
but "which layer owns each thing the old machine was doing". Two facts force the split, and
neither is negotiable:

- **Two machines cannot both hold the backend.** The kernel executor and `window-os-adapter.ts`
  issue port commands to the same `ElectronWindowBackend` over the same windows. If both run
  their effect arms, every show, raise, close and stacking write happens twice. So window
  operations transfer wholesale, in one step, not one arm at a time.
- **The kernel deliberately does not own everything the old machine did.** Three
  responsibilities are outside it BY RULE, not by omission, and switching them off with the
  rest would delete working behavior with nothing to replace it:
  - **The Escape renderer round trip** (`ASK_RENDERER`). §0 puts input interpretation outside
    the window manager. Its replacement is `window-escape.ts` plus
    `window-escape-renderer-handled.ts`, which turn the round trip into a fact published ahead
    of the keypress and read synchronously — a different mechanism, not a ported effect.
  - **Opening and closing the switcher** (`OPEN_SWITCHER_WINDOW` / `CLOSE_SWITCHER_WINDOW`).
    The kernel models no switcher at all, on the stated ground that inventing one to hold a
    single guard would put a second model of that surface in the machine. Opening it is a
    `cmd:execute:windows` publish, which is not a window operation; closing it folds into the
    existing `CloseOrHideWindow` command once the switcher is just another record.
  - **The derived Escape grab** (`reconcileEscGrab`). Nothing in the kernel stack calls
    `setEscGrab`. Under §0 this becomes the Escape subsystem querying machine state, not the
    machine deciding an OS grab.

So the swap moves the window operations and leaves those three where they are, until each
gets its own home. That is a boundary drawn where the rules already draw it, not a staging
convenience — and it is why "delete the old machine in one commit" is the wrong shape: the
adapter is not only the old machine's executor, it is also the current home of three things
the kernel was never meant to hold.

**What this does NOT license.** Leaving a window operation on the old machine "for now"
because moving it is awkward. The three above are outside the kernel because a written rule
puts them outside it. Anything that shows, hides, orders, closes or focuses a window moves,
and if moving one is hard that is the work, not an exemption.

#### The cutover checklist: per file, in execution order

Every symbol below is confirmed present in the tree.

**Prerequisite, and a gap — ATTEMPTED AND REVERTED.** The cutover is
`window-state-singleton.ts initWindowStateMachine` calling
`setKernelExecutorProvider(() => getKernelExecutorForApp())`. It was installed and reverted, and
what the attempt proved is recorded under "What the first cutover attempt found" below. The
paragraph after this one records why the seam has the shape it does.

`window-kernel-executor.ts WindowKernelExecutor.waitForSettledFsMode(id, mode, timeoutMs)` exists
and returns `FsSettleOutcome = 'settled' | 'vanished' | 'timed-out'`, not `void`. The accessor is
`window-kernel-singleton.ts getKernelExecutor(backend)` built over the real
`ElectronWindowBackend`, reached by `window-state-singleton.ts getKernelExecutorForApp()` (injects
`window-os-adapter.ts getWindowOsAdapter().getBackend()`, the same backend every old-machine effect
already goes through). `window-kernel-shadow.ts` itself may not import
`getKernelExecutorForApp` directly, because that would value-import `window-state-singleton.ts`,
which pulls `window-os-adapter.ts` → `electron-window-backend.ts`'s value import of the platform
module (throwing under the `ELECTRON_RUN_AS_NODE=1` unit runner `window-kernel-shadow.test.ts` runs
under) and closes an import cycle, since `window-state-singleton.ts` already imports
`window-kernel-shadow.ts` for the feed helpers.

The three `waitForMode` call sites below (`windows.ts closeOrHideWindow`, the `tile-ipc.ts
tile:window:hide` handler, `hybrid-overlay.ts installTestBridge driveHostFullscreen`) still read the
OLD machine's settled `fsMode` through `window-state-singleton.ts waitForMode`, and that keeps
working after the swap for a reason worth stating: the backend's fullscreen listeners feed BOTH
machines, so the settle they wait on still arrives. What changed is who asks for it — the reconcile
is now issued by the kernel's `ReconcileFullscreen`. Repointing them onto
`waitForSettledFsMode(...)` is a later step, and it is not the one-line import swap it looks like:
the return type is an outcome, not `void`.

Two accessors have to repoint with the swap, both silent if missed.
`window-state-singleton.ts waitForGuestTeardown` must reach the kernel executor, whose
`DestroyAllGuests` arm holds the teardown promise — left on the adapter it resolves immediately
and the quit stops waiting for guests, observable only on a real quit.
`waitForPendingWindowEffects` must await BOTH executors, because the responsibilities are split and
neither side sees the other's in-flight work.

#### What the first cutover attempt found

**The cutover is finished completely before it is tested.** It replaces one window machine with
another, so a half-applied cutover has no reason to be green, and a red suite partway through is
not evidence that the step was wrong. Red tests are not a stop condition: do not revert to
restore a green baseline, do not stop to fix a failing test mid-cutover, and do not gate one
step on the tests passing after the previous one. Testing mid-cutover has one legitimate use,
diagnosis — run a spec to learn something, never to decide whether to proceed. Once every step
has landed, the test-and-fix cycle begins and the fixes go forward, never backward.

The provider install and the fifteen no-op arms landed as one commit and were reverted after a
Playwright A/B against the parent commit showed six regressions. **Reverting was the wrong
call** — the six failures were correct information about what the cutover still needed, and
undoing it cost the conversion a session. The feed is EVENT-shaped — it
records what happened — while four intents existed only as REQUESTS to the old machine, so
switching the arms off dropped them with nothing to carry them. The kernel commands `ShowWindow`,
`HideWindow` and `CloseOrHideWindow` had no production dispatcher at all. Feeds for those three
have since landed and are additive and safe while the old machine still performs.

Four prerequisites remain, each proven by that attempt rather than predicted:

- **Runtime keepLive has no kernel path.** `WindowRegistered` is the kernel's only writer of
  `keepLive`, and the runtime update is `main.ts registerWindow` dispatching `WINDOW_PARAMS_SET`,
  which is old-machine-only. Re-registering instead is not available: that call site holds only
  `source`, `params` and `keepLive`, and `RegisterWindow` requires `kind`, `layer`, `canBecomeKey`,
  `acceptsInput` and `class`. This needs a kernel event that writes `keepLive`.
- **The swap freezes the old machine's `front`.** It moved only through the backend's show echo
  carrying `focused: activate` (`electron-window-backend.ts showWindow` emitting `WINDOW_SHOWN`),
  and the kernel executor always calls `showWindow({ activate: false })`. Every reader in "Wiring
  map: each current reader of `front`, resolved" therefore goes stale AT the swap, which makes the
  reader repoint part of the cutover rather than a follow-up.
- **The Escape-driven close has no feed.** `applyEscape` never emits `CLOSE_WINDOW`; it comes one
  dispatch later from `ESC_RENDERER_ANSWER` → `applyUnhandledEscape`, gated by an epoch check
  against reducer-private `escAsk`. The resolved target is not available at any dispatch site, so
  the feed belongs at the dropped `CLOSE_WINDOW` arm — a temporary bridge that dies with
  `window-state.ts`. `escPolicy` and `escUnhandledPolicy` are pure and exported.
- **`appActive` had no feed on any headless run** — fixed, but the lesson holds: with
  `appActive: false`, `planRaise` suppresses every raise and issues no backend call, so ordering
  behavior reads as verified while nothing was performed.

`window-kernel.ts` needs no edits for any of this: `topmost`, `isContentWindow`, `keyWindow`,
`hostForOverlay`, `topmostBaseLayerPageHost`, `CONTENT_ROLES`, `BASE_LAYER`, and the
`StackOrderImported` event with its `decide` arm are all present and exported.

1. **`shortcuts.ts` — first, it widens a signature the rest depends on.**
   `LocalShortcutEntry.callback` — `() => void` becomes `(sourceWindowId?: number) => void`.
   `handleLocalShortcut(input, focusedWindowId?)` already receives the id; pass it through at both
   `entry.callback()` invocation sites, in the mode-conditional and the unconditional branch.
   `registerLocalShortcut` — widen the `callback` parameter to match.

2. **`window-state.ts` — deletions and the one behavior change.** `getDevtoolsTargetId(state)` —
   today scans `state.windows.values()` for the max `focusSeq` among records with a truthy
   `lastHttpUrl`, with no `visible` clause. Becomes a filtered live-URL scan of kernel `order` with a
   `visible` clause. `WindowStateOwner.getDevtoolsTargetId()` — the delegating method — goes with it.
   `WindowRecord.lastHttpUrl`, the `patchRecord(state, id, { lastHttpUrl })` write inside
   `applyFocusGained(state, id, lastHttpUrl)`, and the `lastHttpUrl` fields on the `OS_FOCUS_GAINED`
   event and the registration payload — all delete; the field has no other reader. `evolve`'s
   `case 'WINDOW_SHOWN'` non-focused branch — the bare `stackRaise(state, event.id)` with no
   `bumpFocusSeq` is the sole producer of the zOrder/stackIndex divergence; deleting it is what makes
   "one order is enough" true. `getWindowFocusSeq(state, id)` — goes with `focusSeq`.
   `getFrontWindowId(state)`, `WindowStateOwner.getFrontWindowId()`,
   `WindowStateOwner.waitForMode(id, mode)` — the owner surface beneath them retires.

3. **`window-state-singleton.ts` — the shim layer every consumer imports.**
   `getFrontWindowId()` → `topmost(state, isContentWindow)`, never `keyWindow`.
   `getFrontPageHostId()` — today `getFrontWindowId()` filtered on `rec.kind === 'page-host'` →
   `topmostBaseLayerPageHost(state)`. `subscribeFrontChange(cb)` — landed as a deletion, not a
   repoint: the attach target is an effect (`AttachOverlayTo`) the kernel emits off a diff of
   `topmostBaseLayerPageHost(state)` across the transition, realized through the port and reported
   back as the `OverlayAttached` event; the only subscription left in `hybrid-overlay.ts` is
   `subscribeOverlayAttachment(cb)`, payload-only, deciding nothing about windows. `getDevtoolsTargetId()` —
   repoint to the new filtered live-URL scan. `waitForMode(id, mode)` — repoint to the kernel waiter
   (the accessor gap above), or delete and have the three callers import it directly; either way the
   return type becomes `FsSettleOutcome`. `getFocusOrder(id)` — **delete**; zero callers tree-wide,
   only its own definition and a doc comment in `ipc.ts`. `getWindowStateSnapshot()`,
   `getMachineWindowRecord()`, `listMachineWindowRecords()` — the `StateSnapshot`-typed surface they
   return changes shape; expect compile fallout.

4. **`ipc.ts`.** `openNewPageWindow()` — today `getFrontWindowId()` → `getNativeWindowFor(front)` →
   `getContextEntry('mode', frontId)` → `options.spaceMode`. Becomes
   `openNewPageWindow(sourceWindowId?: number)`: use `sourceWindowId` when it carries a mode row,
   fall back to `topmost(state, isContentWindow)` when it is the overlay or has no row. Mapping this
   to `keyWindow` is the silent space-mode drop. `wireHybridContentEvents(contentWC, hostWindowId,
   ...)` — the `else if (handleLocalShortcut(input, hostWindowId))` branch: no change beyond the
   widened callback type, but it is one of the two dispatch sites now feeding `sourceWindowId`. The
   import block drops `getFrontWindowId`; the doc comment naming `getFrontWindowId()` /
   `getDevtoolsTargetId()` / `getFocusOrder()` is stale. The diagnostic in the `tile:network:fetch`
   region logging `'frontPageHost:', getFrontPageHostId()` follows the singleton repoint.

5. **`main.ts`.** `configure()`'s `app.on('browser-window-created')` →
   `webContents.on('before-input-event')` handler: `handleLocalShortcut(input, windowId)`, dispatch
   site 1 for `sourceWindowId`. The Cmd+L overlay special case directly above
   (`focusedUrl.includes('page/overlay.html')` early return) is why Cmd+N leaks to the overlay;
   leave it, but it is what the fallback exists for.

6. **`entry.ts`.** `onReady`'s `registerLocalShortcut('CommandOrControl+N', 'system', () => {
   openNewPageWindow(); })` — thread the callback argument into `openNewPageWindow(sourceWindowId)`.
   `__peek_test.getFrontWindowId` — `() => getFrontWindowId()` becomes `topmost(state,
   isContentWindow)`; `keyWindow` is null exactly where `session-restore-hybrid-focus.spec.ts` and
   `session-restore-page-host.spec.ts` assert. The second `frontId = getFrontWindowId()` read later
   in the file — same swap.

7. **`hybrid-overlay.ts` — where the real split happens.** Read-back position →
   `hostForOverlay(state, overlayId)`, five sites: `ensureOverlay()`'s `did-finish-load` handler
   (`const currentId = frontPageHostOsId(); if (currentId != null) sendActiveHandoff(currentId)`);
   `wireShowNavbarFocus()` (`if (msg.windowId !== frontPageHostOsId()) return`); `wireExecuteScript()`
   (`const activeId = frontPageHostOsId(); ... getHybridContentWC(activeId)`);
   `initHybridOverlay()`'s `registerLoadErrorListener((windowId, error) => ...)` callback (`if
   (windowId !== frontPageHostOsId()) return`); and the test bridge's `activeId()` and
   `runDeferredBlur(_id)`, both returning `frontPageHostOsId()`. Driver position — landed as an
   effect, not a repointed subscription: `topmostBaseLayerPageHost(state)` is diffed across the
   transition inside `react`, which emits `AttachOverlayTo`; the backend realizes it through the
   port and reports back the `OverlayAttached` event. `initHybridOverlay()`'s
   `subscribeFrontChange` → `retarget()` driver, and its seed read (`const currentId =
   frontPageHostOsId(); ... retarget(currentId)`), are both deleted rather than repointed — the
   boot seed is instead the `WindowRegistered` transition that mints the overlay's own record (see
   `docs/design/overlay-attach-effect-plan.md` § 6, "The boot seed"). `frontPageHostOsId()`
   (module-private) — deleted with them; it was the single name serving both queries, the hazard
   this design records. `installTestBridge()`'s `setActive(id)` — its `for (let
   i = 0; i < 100; i++)` hide loop over `getFrontPageHostId()` is written against
   `enforceFrontInvariant`'s successor repair; the contract must be **rewritten** against
   `hostForOverlay`, not re-pointed. `installTestBridge()`'s `driveHostFullscreen(id, desired)` —
   `waitForMode(machineId, desired ? 'fullscreen' : 'normal')` becomes the kernel waiter (the
   accessor gap above applies here); return type changes from `Promise<void>` to
   `Promise<FsSettleOutcome>`.

8. **`session-projection.ts`.** `serializeSession(input)` — three reads: `zOrder: rec?.focusSeq ??
   0`, `stackIndex: stackIndexById.get(w.machineId)` (map built from `input.snapshot.stackOrder`),
   and `focused: w.machineId === input.snapshot.front`. Both `zOrder` and `stackIndex` come from
   position in kernel `order`; `focused` becomes `topmost(state, isContentWindow)` — not
   `keyWindow`, because sessions save exactly when `OsFocusLost` has nulled key.
   `serializeSpaceWorkspaces(input)` — the same three swaps over the same map.
   `SerializeSessionInput` / `SerializeSpaceWorkspacesInput` — the `snapshot` field type changes
   from `StateSnapshot` to the kernel `State`. The module docblock's three mapping lines (`zOrder →
   WindowRecord.focusSeq`, `stackIndex → StateSnapshot.stackOrder`, `focused →
   StateSnapshot.front`) — rewrite. `readStackIndex` / `orderRestoredWindowsBottomToTop` —
   unchanged; they read the on-disk field, which survives.

9. **`session.ts`.** `restoreSessionSnapshot(...)` — the `dispatchWindowEvent({ type:
   'STACK_ORDER_IMPORTED', order: savedOrderBottomToTop })` plus its adjacent
   `shadowKernelImportStackOrder(...)` collapse into a single kernel `StackOrderImported` dispatch.
   `saveSessionSnapshot(reason, opts)` and `saveSpaceWorkspaces()` feed the two projections; update
   the snapshot they pass.

10. **`windows.ts`.** `closeOrHideWindow(id)`'s hybrid branch — `await waitForMode(machineId,
    'normal')` becomes the kernel waiter (the accessor gap above applies here). Its `'vanished'`
    outcome is the hang this port was written to fix. `resolveFocusedWindowIdForClose()` —
    `getFrontWindowId()` → the key-when-eligible-else-topmost composition over
    `isFrontEligibleWindow` (see the "Wiring map" entry for why not a bare `topmost(state,
    isContentWindow)`).

11. **`tile-ipc.ts`.** The `tile:window:hide` handler — `await waitForMode(machineId, 'normal')` →
    kernel waiter (the accessor gap above applies here). The `tile:window:devtools` handler —
    `getDevtoolsTargetId() ?? getFrontWindowId()` → the new filtered live-URL scan with
    `topmost(state, isContentWindow)` as the fallback; this is `getDevtoolsTargetId`'s only
    production caller. Same-file readers that stop compiling once the shim moves, all →
    `topmost(state, isContentWindow)`: the `tile:window:focus` handler, the `tile:dialogs:open`
    handler, the `tile:window:fullscreen` handler (`let machineId: ReturnType<typeof
    getFrontWindowId>`), the `tile:window:get-focused-visible-id` handler, the
    `tile:theme:setWindowColorScheme` handler (whose front read is tier 2 of a three-tier chain,
    not a one-line swap), and the `tile:darkMode:set` region. The import block drops
    `getFrontWindowId`, `getDevtoolsTargetId`, `waitForMode`.

12. **Tests the same commit must move.** `session-projection.test.ts` — the two pinned-divergence
    tests `zOrder is TRUE STACK POSITION (StateSnapshot.stackOrder index), not
    WindowRecord.focusSeq` (in the `serializeSpaceWorkspaces` describe) and `SAVE → RESTORE round
    trip: a background open comes back BELOW the last-focused window` (its world sets `stackOrder:
    ['w2','w1']` against `focusSeq: 9/0`) — rewrite them to pin the kernel fact rather than
    re-pointing at new fields; also `makeRecord`'s `focusSeq` option and the `zOrder:
    records.get(...)?.focusSeq` line in the expected-shape builder. `window-state.test.ts` — the
    describes `selectors: getDevtoolsTargetId / getWindowPreBounds` and `WindowStateOwner (dispatch
    / subscribe / waitForMode)`. `shortcuts.test.ts` — the `handleLocalShortcut` call sites, if the
    widened callback changes any assertion.

### Measured: the cutover checklist is a reader swap and the effect runner has eight holes

**`window-os-adapter.ts` cannot be deleted in the same commit as `window-state.ts`.**
`window-kernel-executor.ts WindowKernelExecutor` is missing eight responsibilities the adapter
performs:

- `attachAppListeners()` — no equivalent. App activation and resign never reach the kernel pump.
- `registerWindow(spec)` — the orchestration around the backend's registration decision
  (conditional `WindowShown` pump, esc-handler attach) exists nowhere in the kernel stack; the pure
  `RegisterWindow`/`WindowRegistered` pair is not a substitute.
- `getWindowIdFor` / `getNativeWindowFor` — structurally unreachable, because
  `WindowKernelExecutor` types its backend as plain `WindowBackend`, without the handle-map shims
  the adapter carries. The module that replaces `window-state-singleton.ts` should delegate to the
  backend instance directly rather than reach through the executor.
- `reconcileEscGrab(snap)` — no `setEscGrab` call anywhere in the kernel stack. `window-kernel.ts`'s
  own comment on `WindowRecord.contentFocused` already flags this as unbuilt.
- Effect arms with no kernel counterpart: `ASK_RENDERER` (the renderer-handled-Escape round trip),
  `OPEN_SWITCHER_WINDOW` and `CLOSE_SWITCHER_WINDOW` (including the overlay-cooldown
  special-casing). These three are what stayed in `window-os-adapter.ts runEffect` at the swap.
  `RECONCILE_FULLSCREEN` was listed here too and does not belong: `window-kernel-executor.ts` has a
  `ReconcileFullscreen` case calling `backend.reconcileFullscreen`, so it transferred with the rest.
- `SET_ALWAYS_ON_TOP` is the one arm genuinely superseded by design — the pinned layer realizes
  through `setAlwaysOnTop` inside `SetStacking`'s band replay. The band replay lives in
  `window-kernel-executor.ts reassertStacking`, which picks a level through `stackingLevelForLayer`;
  the `setAlwaysOnTop(true, 'floating')` call itself is in `electron-window-backend.ts setStacking`,
  one layer below any rule, which is where a platform's method name belongs.

Two of the eight are closed. `waitForPendingAsyncEffects()` and `waitForGuestTeardown()` are ported
onto `WindowKernelExecutor`, and `logTransition` is ported with the prefix `[window-kernel]`.
`waitForGuestTeardown()` protects the before-quit sequence, which awaits the last `DestroyAllGuests`
teardown; `waitForPendingAsyncEffects()` protects the E2E escape test bridge.

**A correction to "Wiring map: each current reader of `front`, resolved":** it lists
`hybrid-overlay.ts initHybridOverlay()`'s `subscribeFrontChange` → `retarget()` driver as a call
site of `frontPageHostOsId()`. It is not — that driver inlines `getNativeWindowFor(front)` and
never called the helper. It is a separate reader of `front` still to be repointed.

**`hybrid-overlay.ts` `frontPageHostOsId()` has been split** into `overlayHostOsId()` (the
read-back, six call sites, becomes `hostForOverlay`) and `attachTargetHostOsId()` (the ordering
driver, the `initHybridOverlay()` seed read, becomes `topmostBaseLayerPageHost`). Both bodies are
identical today; the split only separates the names so the cutover is a one-line repoint each.

**`window-state.ts` is no longer the main process's type home.** `WindowClass`, `StackingLevel`,
`classifyWindowRegistration` and `isSatelliteRegistration` now live in `izui-roles.ts`; `WindowId`,
`WindowKind`, `Rectangle` and `FocusCause` now resolve to `window-kernel.ts`, which holds the
single definition of each. `WindowRecord`, `Effect` and `FsMode` still exist in both
`window-state.ts` and `window-kernel.ts` with different shapes — kernel `FsMode` uses
`'entering'`/`'leaving'` where the reducer uses `'entering-fullscreen'`/`'leaving-fullscreen'` — so
any import of those three must be repointed per symbol, never wholesale.

Checklist step 1 is already satisfied: `shortcuts.ts LocalShortcutEntry.callback` already takes
`(sourceWindowId?: number)`.

`window-kernel-executor.ts planRaise` now resolves `!appActive` to a suppressing plan that performs
nothing, matching `window-state.ts applyRaiseRequest`'s `if (!state.appActive) return`, so the
cutover carries no behavior change there. The latched replay on `AppActivated` described under
"Analysed, not decided: the backgrounded raise and the backgrounded overlay" remains undecided and
unimplemented.

#### `hostOf(overlay)` and `topmost(state, isContentWindow)` are orthogonal, not aliases

`hostOf(overlay)` (the `overlayFor` relation) and `topmost(state, isContentWindow)` name different
windows and nothing makes them the same. Attachment is driven by the front signal filtered on
`kind === 'page-host'` (`window-state-singleton.ts` `getFrontPageHostId`, polled by
`subscribeFrontChange`, consumed by `hybrid-overlay.ts` `retarget`); order is moved by
`OsFocusGained` and mutated by `WindowRegistered` / `WindowClosed`. The two coincide in the case
most tests exercise — focusing a page-host raises it and makes it front in the same motion — and
diverge on three independent axes:

1. **Predicate mismatch.** `kind === 'page-host'` and `role ∈ CONTENT_ROLES` plus `canBecomeKey`
   are two different sets; neither contains the other. A focused peek makes attachment name the
   peek while the content query names the page beneath it. A focused extension popup or settings
   window (`kind: 'browser', role: 'content'`, per `chrome-extensions.ts` and the `main.ts`
   `registerWindow` seam) makes `getFrontPageHostId` return null and the overlay detach, while the
   content query still names the popup.
2. **Events move one and not the other.** `WindowRegistered` inserts at the key window's index,
   not the topmost content window's index — a background window registered while a chrome overlay
   holds key lands above the attached host. `WindowShown` / `WindowHidden` never reorder, so a host
   hidden and later re-shown without regaining focus becomes the topmost content window while
   attachment stays elsewhere — a stable steady state, not a transient.
3. **Conditions local to `retarget` with no kernel counterpart.** It detaches when the hybrid
   registry lookup fails, the base window is destroyed, or the overlay id is not yet minted; in
   each case no `WindowClosed` has necessarily reached the kernel, so a real visible window is
   still named by the content query while attachment is null.

What does not diverge, checked and not to re-investigate: `WindowContentOrderable` sets only
`orderable`, which `isContentWindow` never reads (it feeds only `react`'s `SetStacking`
emission) — that gap is between the model's order and the OS stack, not between attachment and the
content query. `isAppResignSweepEligible` requires `!canBecomeKey` and `isContentWindow` requires
`canBecomeKey`, so the two are disjoint by construction and no content window is hidden by an app
switch; the overlay itself is excluded from the sweep by role and hidden by `hybrid-overlay.ts`
`wireAppActiveGate` without dropping `overlayFor`, so attachment survives an app switch correctly.
And `evolve`'s `WindowClosed` arm clears `overlayFor` in the same pass that removes the record, so
a retired host is never named by attachment — writing `visible: false` alongside it, since any
transition that detaches a visible overlay owns the visibility fact rather than leaving it for the
backend's native-hide echo. `react` turns that stored fact into the hide through its ordinary
visibility diff; it carries no overlay-specific detach rule.

No kernel invariant should force the two to agree. Such an invariant would be false in every
divergence above, and enforcing it would mean either constraining order to follow attachment — a
second ordering rule, which §0 forbids — or constraining attachment to follow order, which is
impossible because the overlay can only frame a `kind: 'page-host'` window present in the hybrid
registry, and `isContentWindow` neither knows nor should know about `kind`. The two are orthogonal
by construction, not by oversight. The enforcement boundary that already exists — the local
invariants the `OverlayAttached` arm holds (`overlayFor` never dangles, never self) plus the
mechanical detach in `WindowClosed` — is the right one; the invariants worth adding are about
`overlayFor` alone, not its agreement with order: at most one record carries it, and a record
carrying it has `role === 'overlay'`.

The real hazard is not that attachment and order disagree — they are allowed to. It is that
`hybrid-overlay.ts` `frontPageHostOsId()` today is a single query serving both roles (above);
splitting it into the read-back (`hostOf(overlay)`) and the driver (a layer-aware ordering query,
still to be built — see the correction above) removes the hazard. Making the two agree does not.

Per caller, which relation is correct: the read-back call sites listed above want attachment,
always. `windows.ts` `resolveFocusedWindowIdForClose` wants `keyWindow` when it is itself
front-eligible, else `topmost(state, isFrontEligibleWindow)` (see the "Wiring map" entry above for
why `isFrontEligibleWindow`, not `isContentWindow`) — never attachment; a focused extension popup is
the disproof, since attachment is null there while Cmd+W plainly must close the popup. `tile-ipc.ts`
`tile:dialogs:save` / `tile:dialogs:open` want neither, as the next paragraph covers — the opener's
own window, resolved from `ev.sender` — and attachment would be actively wrong there: it would
parent a dialog raised by a background tile onto the attached host instead of the tile that opened
it.

**`tile-ipc.ts` dialog parenting** (`tile:dialogs:save`, `tile:dialogs:open`) wants the opener's
own window, resolved from `ev.sender` — not any ordering query. The current `front` read works
around `BrowserWindow.getFocusedWindow()` returning null for a hybrid `BaseWindow` host, and
returning the overlay when the address bar is focused; neither case argues for an ordering query.
`webview-registry`'s `findHostWindowId(wc)` is the canonical resolver — it handles `<webview>`
guests and top-level content, with a machine-side liveness check; `window-registry.ts`
`windowFromWebContents` also resolves a hybrid content web contents to its owning `BaseWindow`.
`topmost(content)` stays as the fallback only for an invisible or headless sender. Fixing this also
fixes a pre-existing bug: a dialog raised by a background or non-front tile currently parents onto
the wrong window.

**Mechanical mappings — all to `topmost(state, <predicate>)`:** `tile-ipc.ts`
`tile:window:get-focused-visible-id`, `tile:window:fullscreen` (default target),
`tile:theme:setWindowColorScheme` (the `resolvedId === null` branch, tier 2 of a three-tier chain),
`tileResolveWebWindow` and
`tile:window:devtools` (both already post-filter on http/https — fold that into the predicate
rather than filtering after), and `entry.ts`'s Close Window menu handler (reads `front` only for
its detached-devtools guard and can delegate to `resolveFocusedWindowIdForClose` instead — that
function itself is NOT a bare `topmost` mapping; see the "Wiring map" entry for its
key-when-eligible-else-topmost composition). `window-state-singleton.ts` `getFrontWindowId` becomes a
thin wrapper over the same query, or is deleted in favor of per-caller predicates; its one injected
consumer is `seedSessionMirror` → `coord.setFrontWindowIdProvider(...)`, read by `izui-state.ts`
`enterOverlay` for `session.preOverlayFocusTarget` — the content window session restore should
return to once the switcher palette takes key.

**Incidental, deletable reads:** `ipc.ts`'s window-open modal-blur handler's DEBUG blur log (reads
`getFrontPageHostId()` — not `wireHybridContentEvents`, which contains no front read at all),
`window-os-adapter.ts`'s dispatch log builder (`fmt(before.front) → fmt(after.front)`, and also
`after.stackOrder.join(' ')`), and `session-projection.ts`'s module-header doc lines — none carry
behavior.

**Any predicate filtering on `visible` needs re-checking** against `hiddenByAppBlur` and the
`AppActivated` re-show path, which interact with it. The kernel's `order` carries no visibility
filter, and `WindowRecord` has no `satellite` field — the old `isEligibleFront` exclusion has to be
reconstructed from `role` / `class` / `canBecomeKey`.

**`subscribeFrontChange` has exactly one subscriber** — `hybrid-overlay.ts` `initHybridOverlay` →
`retarget()` — and no kernel equivalent: the kernel is a pure `decide` / `evolve` / `react` triple
with no subscribe surface, and `OsFocusGained` / `OsFocusLost` have no producers yet. The preferred
replacement is an effect, not a subscription — "the topmost page-host changed" is a structural
diff `react(prev, ev, next)` can emit, which makes the driver push-based, removes the overlay's
last reason to read an ordering query, and closes the re-entrancy hazard where `retarget` can be
called from a subscribe callback mid-dispatch. If a polling shape is kept instead, the dedup key
must be `topmost(pageHost)`, not `keyWindow` — otherwise the overlay detaches and re-attaches on
every Cmd+L and the chrome visibly flickers.

#### The kernel does not yet cover the old machine

Measured against `apps/desktop/main/window-state.ts`'s 45 event types and 21 effect types: 29 have
no home in `window-kernel.ts`, `window-kernel-executor.ts`, or `window-escape.ts`.

**Deleted by design (5).** `ESC_RENDERER_ANSWER` and `ASK_RENDERER` are replaced by `version` /
`expectedVersion` plus the mirrored `EscapeKeyPress.rendererHandled` fact (0.1.2); `SWITCHER_SELECTED`,
`SWITCHER_OPENED`, and `SET_ALWAYS_ON_TOP` are subsumed into `SetStacking` plus `layer` (0.1.4,
0.1.6).

**Homed outside the kernel (8).** `ESC_PRESSED`, `SWITCHER_OPEN_REQUESTED`, `OPEN_SWITCHER_WINDOW`,
`CLOSE_SWITCHER_WINDOW`, and `PASS_THROUGH` belong to `window-escape.ts` or an app action — the
kernel never creates windows. `SESSION_CHANGED` is a caller-supplied `EscapeSession`. `SPACE_CHANGED`
belongs to `electron-window-backend.ts attachSpaceChangeListener` — the machine holds no per-Space
state. `RECONCILE_FULLSCREEN` belongs to `electron-window-backend.ts`, which owns the bounded
fullscreen settle.

**Expected in the kernel but unwritten (9).** `WINDOW_PARAMS_SET`, `WINDOW_CLOSE_REQUESTED`,
`WINDOW_DESTROY_REQUESTED`, `WINDOW_CONTENT_CLOSE_REQUESTED`, `GUEST_TEARDOWN_REQUESTED`,
`STACK_ORDER_IMPORTED`, `MAXIMIZE_RESTORED`, `SPACES_POLICY_REQUESTED`, and `CLOSE_WINDOW`. Seven of
these rest only on 0.1.1's blanket count of "~17 commands (everything named `*_REQUESTED`)" — a
mood-sorting tally, not a specification. `STACK_ORDER_IMPORTED` is decided below, in "Decided:
devtools re-assert, cold-start focus, and stack-order import enter the kernel" — not yet wired.

**Unaddressed — the design is silent (7).** `DEVTOOLS_OPENED`, `DEVTOOLS_CLOSED`,
`COLD_START_FOCUS_ARMED`, `CLOSE_WINDOW_DIRECT`, `DESTROY_WINDOW`, `CLOSE_CONTENT`,
`DESTROY_ALL_GUESTS`. §0.1 decides that teardown goes through the kernel the same way every other
window decision does (below), but does not yet wire it: no step names `DESTROY_WINDOW`,
`CLOSE_CONTENT`, `DESTROY_ALL_GUESTS`, or `CLOSE_WINDOW_DIRECT` as a kernel command, and none of the
four has an effect yet; `WindowClosed` still exists only as an OS report. `DEVTOOLS_OPENED`,
`DEVTOOLS_CLOSED`, and `COLD_START_FOCUS_ARMED` are likewise decided below, in "Decided: devtools
re-assert, cold-start focus, and stack-order import enter the kernel" — none of the three is wired
yet either.

§5's eleven steps migrate authorities into `window-state.ts`, not into the kernel — no wiring
sequence for the kernel appears anywhere in this document. There is no step for the switcher and
none for the close/destroy family as a decision surface.

**The consequence for §2's rule.** A partial cutover — the kernel owning focus/order/visibility/
geometry while `window-state.ts` retains close/switcher/session — is forbidden, because those
retained arms are themselves focus authority: `window-state.ts`'s `SWITCHER_SELECTED` arm sets
`front`, bumps `focusSeq`, and drives `applyRaiseRequest`; `COLD_START_FOCUS_ARMED` is consumed by
`APP_ACTIVATED`, which re-fronts and drives `RAISE_WINDOW` / `FOCUS_CONTENT` / `SET_STACKING`;
`STACK_ORDER_IMPORTED` orders `stackOrder`. Retaining them means a second writer of front — the
exact failure mode §2 exists to prevent. The permissible shape is the inverse: port those decisions
into the kernel in the same commits that cut over focus and order.

#### Decided: window teardown enters the kernel as commands and leaves as effects

`DESTROY_WINDOW`, `CLOSE_CONTENT`, `DESTROY_ALL_GUESTS`, and `CLOSE_WINDOW_DIRECT` each need a
kernel command and a corresponding effect, in the same shape as the `CloseWindow` effect already
added (`window-kernel.ts` `Effect`, derived in `react` as a structural membership diff, performed
in `window-kernel-executor.ts` `performEffect`). Teardown is not a caller composition outside the
kernel the way Escape (`window-escape.ts`), the switcher, and spaces policy are.

A caller-requested removal never originates inside the kernel. `DESTROY_WINDOW`, `CLOSE_CONTENT`,
`DESTROY_ALL_GUESTS`, and `CLOSE_WINDOW_DIRECT` each enter as a command from outside; the kernel
does its bookkeeping and emits the effect that performs the teardown.

The precedents that put Escape, the switcher, and spaces policy outside the kernel do not transfer
to teardown, because none of those three mutate window membership. `order` is membership; teardown
changes it.

Leaving teardown outside would create two paths for removing a window: a command-driven close, and
an out-of-band `backend.destroyWindow` that the kernel learns about only afterwards through a
`WindowClosed` OS report. The out-of-band path is a second authority over `order` — the exact
failure mode §2 exists to prevent.

Transient dismissal is not this case: §0's governing rule — a transient closes when some other
window, not belonging to it, genuinely takes key — is a rule the machine applies to itself, not a
request a caller makes, so it is not routed through a command either. `window-kernel.ts`'s
`selectTransientAutoclose` and `selectAppResignTransients` stay pure selectors — queries, not
transitions — but `react` turns their answer into effects directly, off the same `key`/`order`
diff every other effect derives from, so `evolve` stays guard-free and effects remain a pure
structural diff. See §0 for why this application is the machine's job and not a caller's.

#### Decided: devtools re-assert, cold-start focus, and stack-order import enter the kernel

**Devtools re-assert is not a devtools concept in the kernel.** The old `window-state.ts`
`DEVTOOLS_OPENED`/`DEVTOOLS_CLOSED` shared arm ignores `event.id` outright and calls
`applyRaiseRequest(state, state.front, effects)` — its entire content is "re-assert the raise on
whatever is currently front". No devtools event, no devtools `WindowRecord` field, and no devtools
`Command` enters the kernel; it becomes a generic focus re-assert, and the caller (`main.ts`, in the
`app.on('web-contents-created')` handler that wires `devtools-opened` / `devtools-closed`) computes
the target itself.

The mechanism follows the teardown precedent: `State.lastFocusAssert: { id, seq } | null`, written
by `Event.FocusAssertRequested` from `Command.AssertFocus`, diffed by `seq` in `react` into
`RaiseWindow` plus a new `Effect.FocusContent`. Re-asserting focus on the key window is a **no-diff**
transition in the kernel — devtools opens `activate:false` so the top of `order` never moves — and
`react` may not branch on `ev.type`, so the request has to become a fact `react` can diff. A naive
port as `Command.RaiseWindow` is a silent no-op that reproduces the `7c61e917` regression shape. The
`react` rule for this fact is emitted last, after the `SetStacking` block, because the old machine
raises after its re-show and overlay-reveal work and `react` emits in rule order.

The old arm's guards live in `applyRaiseRequest` — `id != null`, `state.appActive`,
`!state.switcher.open`, `isEligibleFront(rec)`. `isEligibleFront` maps to the existing
`isContentWindow` query and moves to `decide`. The switcher condition does not enter the kernel (the
switcher is homed outside it per this section), so the caller owns it.

**`COLD_START_FOCUS_ARMED` ports as state, but its firing needs the same mechanism.**
`State.pendingColdStartFocus: WindowId | null` ports over unchanged, written by
`Command.ArmColdStartFocus` / `Event.ColdStartFocusArmed`. The `null` payload is meaningful — it
clears a latch a prior restore pass armed and never spent — and must survive. `evolve` stores the id
as given even when the window is absent from `order`: arming happens before the window is guaranteed
live. Arming emits nothing, correctly by construction, since nothing in `react` diffs that field.

The hazard is on the consumption side. The latch exists for the case where the model already
believes the armed window is on top and only the OS disagrees (a trailing `did-resign-active`
leaving the app behind the previous one). If the `AppActivated` arm consumed the latch by moving the
record to the top of `order`, the diff would be empty in exactly the scenario the latch was written
for. `AppActivated` instead clears `pendingColdStartFocus` and writes `lastFocusAssert` — the fact
the devtools decision above introduces. One mechanism covers both primitives.

The guard relocates to state rather than being ported, because it is a behavioural relocation: the
old arm's eligibility test cannot live in `evolve` (total, guard-free), and a `decide`-time check
when arming is insufficient because the window can die between arming and activation. The
eligibility failure therefore lands at the executor, where the port resolves the handle and no-ops
when it is gone — what the teardown effects already rely on.

**`STACK_ORDER_IMPORTED` enters as a reorder-only command**, `Command.ImportStackOrder { order,
expectedVersion }` → `Event.StackOrderImported`. It preserves membership and may replace nothing but
relative position within `order` — not `key`, not `visible`, not `layer`, not `lastOpSeq`. Because
`evolve` is total and guard-free, the permutation is built so that dropping or adding an id is
**impossible rather than merely avoided**: the result is assembled from `state.order`'s own records,
with unknown ids in the payload silently inert. `decide` carries the stale-version guard and must not
reject unknown ids — `session.ts restoreSessionSnapshot` assembles the payload through
`getWindowIdFor` over windows that may have died mid-restore. `react`'s existing order-changed rule
emits the full bottom→top `SetStacking` sweep for free, so no new effect type is needed. An empty
import is the identity permutation and emits nothing without any guard in `evolve`.

Three places the kernel deliberately diverges from the old arm, each a conscious divergence:

- **The membership filter.** The old arm keeps only ids passing `isStackMember` (`stackingLevel ===
  'stacked' && visible`). The kernel's `order` is the total registered set, so its only admissible
  filter is "is in `order`" — silently dropping hidden windows would be a membership change and is
  forbidden.
- **Where unnamed windows go.** The old arm pushes unnamed members below the entire imported set
  (pinned by `window-state.test.ts` "members the import does not name keep their relative order
  below the imported set" — consciously not ported). In the kernel that would drag the command
  panel, HUD, peeks/slides and the chrome overlay beneath every restored page in array position,
  corrupting the `topmost(...)`-based queries. The kernel instead permutes only within the array
  slots the named ids already occupy, leaving every unnamed record at its current index.
- **The spurious raise.** A reorder-only import satisfies every clause of `react`'s current raise
  rule (same membership, different topmost, `nextTop` existed in `prev`), so it would emit an
  activating `RaiseWindow` — forbidden by the old arm and pinned by `window-state.test.ts` ("an order
  import must never activate anything"). This cannot be avoided inside `react` by branching on
  `ev.type`.

**Consequently, `react`'s raise rule is re-based on `key`.** The rule changes from "top of `order`
changed, with equal membership and `nextTop` present in `prev`" to "`next.key !== prev.key`, or the
`lastFocusAssert` seq changed". It remains a pure state diff and still never branches on `ev.type`;
it is more faithful, because `decide` on a raise command already returns `OsFocusGained` and that
event is the only writer of `key`, so the raise path is preserved verbatim while a reorder that
leaves `key` alone emits nothing; it removes the current rule's reliance on a fragile
length-equality trick; and it closes the re-raise-of-the-already-topmost-window hole recorded below
in "Two lossy ports, one closed" under `FOCUS_CONTENT`. The existing decision that `react` must emit
`RaiseWindow` off a focus report is preserved, not overturned — the emission remains its own fixed
point, because the OS focus echo names the window `key` already holds and therefore diffs to
nothing.

**The three `front — a projection of OS focus; raises come from named targets only` tests that deny
this rule are deleted, not honored.** `react` emits `RaiseWindow` on any `OsFocusGained` move that
changes `key`, and `window-state.test.ts`'s `an OS-driven front switch mirrors the order WITHOUT
echoing a raise (the OS already did it)`, `INVARIANT: no RAISE_WINDOW is emitted from WINDOW_SHOWN
or OS_FOCUS_GAINED (the pump's convergence obligation)`, and `a raise echo (WINDOW_SHOWN
{focused:true}) does not re-raise — the RAISE_WINDOW → WINDOW_SHOWN cycle is cut structurally` go.
The tests exist because the old reducer needed them: a focus report echoing back as a raise built a
feedback cycle, and `applyOsFocusRealized` cut it by refusing to raise on OS-driven focus at all.
The kernel needs no such refusal, because the raise is its own fixed point by construction, not by
a branch the tests pin down — `decide` on a raise command returns `OsFocusGained`, the only writer
of `key`, so the OS echo names the window `key` already holds, the diff is empty, and the echo
emits nothing. The cycle is cut by the key diff itself, not by a check on `ev.type` — which `react`
could not perform anyway, since it is a pure structural projection over `(prev, next)` and never
inspects the event that produced them. `window-kernel.test.ts`'s `INVARIANT: the raise is its own
fixed point — the focus report it provokes emits NOTHING`, `a registration that lands on top does
not raise either`, and `a focus report on the window already on top DOES raise when it takes key
from somebody else` carry this forward.

**`getDevtoolsTargetId`'s replacement stays outside the kernel, and stores nothing.**
`WindowRecord` carries no `lastHttpUrl` and `State` no `focusSeq`, and neither is restored: the
selector is `window-state-singleton.ts getTopmostWebPageWindowId`, a composition over the kernel's
own facts, read by `tile-ipc.ts`'s `tile:window:devtools` handler as
`getTopmostWebPageWindowId() ?? getTopmostContentWindowId()`.

Both halves of the old selector are derivable. RECENCY: `evolve`'s `OsFocusGained` arm re-pushes the
focused record at the end of `order` and `topmost` scans from the end, so
topmost-among-matching IS most-recently-focused-among-matching — the ranking `focusSeq` gave,
§0.1.10's same-order claim now spent on a query rather than on a stored sequence. THE http FACT: role
is its proxy. `izui-roles.ts inferIzuiRole` gates `content` and `child-content` on `ctx.isWebPage`,
so `izui-roles.ts isWebPageRole` admits exactly the roles a page open can produce, and
`getTopmostWebPageWindowId` narrows `isContentWindow` with it rather than re-deriving the
`visible` / `!pendingHidden` / `canBecomeKey` gates.

The narrowing is what the handler needed: `CONTENT_ROLES` includes `workspace` and a `peek://` open
infers `workspace`, so `topmost(state, isContentWindow)` alone answers with whatever `peek://` tile
sits on top — devtools on the tile instead of the page being read. Three accepted differences from
the deleted selector: a `peek://app/new-tab/index.html` host counts as `isWebPage` and stays
targetable (harmless — it is a page host); a peek or slide over an http page is role `quick-view`
and is no longer the automatic target, though the explicit `args.id` path still reaches it; and role
is fixed at open, so a window that navigated from http to `peek://` still reads `content` — the old
open-time feed carried the same staleness in the same direction. The any-kind fallback stays so
devtools in a `peek://`-only session still opens something.

#### Measured: quit no longer reaches `closeContent` with a live WebContents

`electron-window-backend.ts destroyAllContentGuests` awaits `guest-teardown.ts
destroyGuestsAndWait`, and `entry.ts runBeforeQuitCleanup` awaits that promise before the re-quit.
Measured on a visible run with six restored page hosts, quit by a single Cmd+Q: all six guests
resolved live at teardown entry, each host window closed as its own guest's `'destroyed'` event
landed, and every `closeContent` call found `destroyed=true` and returned on the guard — zero real
`wc.close()` calls, `stillAlive=[]` at batch resolution, 80ms spent inside the await. The host
closes are caused by the teardown rather than racing it; the windows the teardown does not touch
close after the await, from the re-quit.

Before this change the same run left all six content WebContents alive and `closeContent`'s
`wc.close()` was what freed them.

The consequence for the port: `CLOSE_CONTENT` is no longer reached with a live WebContents on any
ordinary path — the two interactive closes already no-op (the guest pass destroyed the WC, and
finalize is triggered *by* that WC's `'destroyed'` event, so the guard is structurally always
false), and quit now no-ops too. One case can still deliver a live WebContents: a wedged guest
outliving `QUIT_GUEST_TEARDOWN_BUDGET_MS`, where quit proceeds by design. Port `CLOSE_CONTENT` as
that bounded-timeout fallback, not as the ordinary quit path.

#### Two lossy ports, one closed

Two transitions ported from the old machine to the kernel still drop a sub-behavior the old
machine had:

- **`RAISE_WINDOW_REQUESTED` → `Command.RaiseWindow`.** `decide` synchronously manufactures an
  `OsFocusGained`, so `key` moves optimistically with no OS confirmation. The old machine moved
  `front` only from the real OS echo (`applyOsFocusRealized`).
- **`FULLSCREEN_SETTLE_TIMEOUT`.** The kernel force-settles optimistically (`entering` →
  `fullscreen`, `leaving` → `normal`); the old machine emitted `RECONCILE_FULLSCREEN` and re-asked
  the OS once.

**`FOCUS_CONTENT` closed.** `react` used to emit `RaiseWindow` only when the top of `order`
changed, so a re-raise of the already-topmost window produced an empty diff and no `focusContent`
call — the shape of the fixed `7c61e917` regression (a restored host raised by its chrome never
regained first responder, and Escape had no handler at all). The kernel now carries
`State.lastFocusAssert: { id, seq } | null`, a request fact that `decide` and the raw-event path
both write and that `react` diffs by `seq` (not `ev.type`) to emit `Effect.FocusContent`. A
re-assert on the already-topmost window still bumps `seq`, so `react` always emits a `RaiseWindow`
plus, for a content window (`isContentWindow`), a `FocusContent` call. The gap is closed by
construction, not by a special case for the already-topmost window.

#### Decided: `react()`'s key-diff rule has no `FocusContent` gap — the decision moved down a layer

`window-kernel.ts react()`'s general key-diff rule emits only `RaiseWindow`, never
`FocusContent`, and that is correct: content focus is not missing from `react`, it is decided one
layer down, at the executor and the backend.

`react` emits `Effect.FocusContent` from exactly one rule — the `lastFocusAssert` seq-diff
described above — and only when `isContentWindow(record)`. Two `evolve` arms write
`lastFocusAssert`: `FocusAssertRequested` and `AppActivated`'s consumption of the cold-start
focus latch. Neither is an ordinary OS focus report; an ordinary `key` change (an `OsFocusGained`
landing through the raise path) drives `RaiseWindow` alone.

That split mirrors the old reducer's shape rather than dropping half of it. `window-state.ts`
`applyRaiseRequest` pushed `RAISE_WINDOW` plus `FOCUS_CONTENT` (page-host only) for an explicit
named-target raise; `applyOsFocusRealized` pushed `FOCUS_CONTENT` alone for a page-host on an
ordinary `OS_FOCUS_GAINED`, deliberately *without* `RAISE_WINDOW` — its docblock records that
echoing a raise off an OS focus report is a feedback loop, observed live as a
`OS_FOCUS_GAINED` → `RAISE_WINDOW` ping-pong. The fact both arms carry forward is that host key
does not imply content focused (the `7c61e917` raise-by-chrome regression), not that every focus
change needs a fresh `FOCUS_CONTENT`.

The kernel carries that fact structurally rather than through a second emitter.
`electron-window-backend.ts raiseWindow()` — the port both the old adapter's `RAISE_WINDOW` and
the kernel executor's `RaiseWindow` effect resolve to — already performs `performOsShow(...)`,
`armSelfCausedFocus(...)`, and `rendererWC.focus()` for a page-host when not headless. An
activating raise makes content first responder as part of raising, so `react` does not need to
name that half separately for the ordinary case.

`window-kernel-executor.ts planRaise(record, headless, appActive)` is the structural replacement
for both old emitters, in one function: `'activating-raise'` (content focus baked into
`raiseWindow`, the `applyRaiseRequest` case), `'show-and-focus-content'` (a `quick-view` page-host
— a non-activating show, so content focus has to be driven separately, the shape `524f7aba` exists
to protect), and `'inactive-show'` (headless, or `!appActive` — no focus at all, by design in the
headless case). `planRaise` reads `record.kind` / `role` / `headless` / `appActive`, never
`ev.type`, so the decision stays a structural fact about the window rather than a branch on which
command asked for the raise. `apps/desktop/CLAUDE.md`'s "show() + contentWC.focus()" obligation
for a fresh hybrid host sits at exactly this layer — the backend/window boundary, not the reducer.
The `!appActive` branch of `'inactive-show'` is not the same design choice as the headless one; see
"Analysed, not decided" below.

**Consequence for the test migration.** `window-state.test.ts`'s `focusesContent` assertions
(describe `front — a projection of OS focus; raises come from named targets only`) pin the
`FOCUS_CONTENT` split above. They do not migrate to a `react` assertion — `react` has nothing
further to decide once `lastFocusAssert` is diffed. Their kernel-native home is `planRaise`'s
three outcomes, already covered by `window-kernel-executor.test.ts`'s `planRaise — the masks a
raise owes because it is an activating show` describe block. A migration pass that goes looking
for a `react`-level `FOCUS_CONTENT` equivalent to port these onto is looking for a gap that was
closed by moving the decision, not by dropping it.

**Headless caveat.** `window-kernel-executor.ts`'s `FocusContent` effect case returns early when
headless, and `planRaise` under headless always returns `'inactive-show'`. No headless test can
therefore observe the real `rendererWC.focus()` call this section describes — the finding rests
on reading `electron-window-backend.ts`, not on running anything, and a regression in the
`performOsShow` / `armSelfCausedFocus` sequencing is only catchable live.

**Left open: a devtools re-assert on a non-quick-view page-host double-calls focus.** A
`FocusAssertRequested` on such a window emits `[RaiseWindow, FocusContent]` at the same `opSeq`.
The executor's `RaiseWindow` case takes the `'activating-raise'` plan and calls
`backend.raiseWindow()`, which already focuses content; the separate `FocusContent` effect then
calls `backend.focusContent()`, which focuses it again and re-arms the same self-caused-focus
token. `wc.focus()` being idempotent likely makes this harmless, but the double call is real, not
hypothetical, and sits inside the provenance machinery that labels self-caused focus events. It
belongs with the `planRaise` work that moves the quick-view and headless raise masks fully into
the backend — a change that needs its own commit and its own gate run, because getting it wrong
reproduces regression `524f7aba`'s shape (focusing a background quick-view activates the whole
app).

#### Analysed, not decided: the backgrounded raise and the backgrounded overlay

Two behaviors diverge between the old reducer and the kernel when the app is backgrounded, both
reached through the `appActive` guard `planRaise` inherited from `applyRaiseRequest`. What follows
is analysis with a recommended resolution; the resolution itself is a cutover-time choice, not one
taken here.

**Superseded in part — read the rest of this section as a record of the analysis, not of current
code.** `window-kernel-executor.ts planRaise` resolves `!appActive` to `'suppressed'`, which
performs nothing, matching `window-state.ts applyRaiseRequest`'s drop. Every sentence below that
describes `'inactive-show'` as the `!appActive` outcome — including the trigger table's
`RAISE_WINDOW_REQUESTED` row — describes code that no longer exists, and the visual outcome it
warns about (a Peek window painted over the foreground app) cannot occur. All three further gaps
this section names are built now: the successor raise on `evolve`'s `WindowHidden` arm and
`react`'s mirrored loop, the visibility gate on the focus-assert rule's `[RaiseWindow,
FocusContent]` emission, and the overlay resign-hide/activate-reveal pair — see the three RESOLVED
markers below. What stays genuinely open is the backgrounded-raise placement question the rest of
this section analyses (the `!appActive` → `'suppressed'`/`'inactive-show'` choice and where its
guard belongs) — see "RESOLVED (overlay half only)" below for the line between what landed and
what didn't.

**RESOLVED — see "0. The governing rule set", stored fact 5 and the rule stated under it.**
`appActive` is now declared a stored fact, the app-active test is placed on the write, the
latched replay is decided against, and `planRaise`'s `'suppressed'` arm is slated for deletion.
The rest of this heading is the analysis that led there, kept as a record of the reasoning.

**RESOLVED (overlay half only) — see `window-kernel.ts evolve`'s `case 'AppResigned'` / `case
'AppActivated'`, `appBlurRevealAdmits`, and `WindowRecord.hiddenByAppBlur`'s doc comment.** The
backgrounded-overlay half of this heading's title is built: `AppResigned` now hides every attached
overlay on the raw resign edge, and `AppActivated` re-shows exactly what `appBlurRevealAdmits`
admits and clears the mark on what it re-shows — see "the pair has to be ported together" below for
the landed shape and where it departs from the pairing as originally stated. The backgrounded-raise
half of the title is a separate question and stays open: the RESOLVED marker above settles the
*decision* (drop, not latch) but `planRaise`'s `'suppressed'` arm is still "slated for deletion," not
deleted, so the raise guard has not moved off the executor and onto the write side yet.

**RESOLVED — see `window-kernel.ts evolve`'s `case 'WindowHidden'` and the mirrored loop in
`react` (the "Successor raise on hide" comment).** The window holding `key` going off screen now
hands the raise to whatever content window is left. `react` rides the `visible` true→false diff on
the record that equals `prev.key`, gated additionally on `next.appActive === true` and on
`topmost(next, isContentWindow)` being non-null; `evolve` mints the op token and stamps the
successor's `lastOpSeq` under the identical, mirrored condition. Neither `key` nor `order` is
written — the OS echo of the raise moves both, and leaving the hidden record in place is what keeps
the topmost-key invariant (§0.1.10) untouched, unlike the `WindowClosed` parent-refocus arm, which
removes a record and so has to reorder to preserve that invariant. A duplicate hide delivery (the
backend echo plus the lagged native event) is inert because the second delivery has no diff to react
to.

**RESOLVED — see `window-kernel.ts react`'s focus-assert rule (the last rule in the function,
"GATED ON `visible`") and the matching stamp conditions in `evolve`'s `case
'FocusAssertRequested'` (`issuesRaise`) and `case 'AppActivated'` (`assertsFocus`).** The
`[RaiseWindow, FocusContent]` emission this section named as ungated now requires the target to be
`visible`; an off-screen target gets neither effect. The gate is plain `visible`, not
`isContentWindow` — a visible palette is deliberately raised with no `FocusContent` half, a split
pinned by `window-kernel.test.ts`'s "a non-content target gets no FocusContent — the split is real,
not decorative". The decision lives in the pure kernel, not the executor: `planRaise`'s surviving
masks (headless, `!appActive`, discussed below) are the environment refusing an activation, not a
fact about the window model, and the standing direction is to remove decisions from `planRaise`
rather than add to it.

**The placement of the app-active test is itself unresolved, and is the more important half.**
The rule is that Peek does not reorder its own windows on its own initiative while it is not the
active app; a window becoming visible because the user asked for it is a different fact and is not
covered. Stated that way the behavior is not a gate at all: while the app is inactive, the
transition that would change which window holds key simply is not recorded, `react` has no diff to
project, and `planRaise`'s `'suppressed'` arm has nothing to refuse and can be deleted. Two facts
make this the shape to aim for rather than a preference. `evolve`'s `AppResignSettled` arm already
performs exactly this kind of test on the write side — its own comment states that `attentionLost`
is a state test rather than an event test, "which is why the guard belongs here, on the write,
rather than in `react`." And no document or comment anywhere forbids `react` from reading
`state.appActive`; the constraint actually written is that `react` holds no guards at all, which is
a different and stronger statement that the state-write placement satisfies.

**`appActive` is a stored fact that was never declared one.** Section "0. The governing rule set"
names four stored facts and `appActive` is not among them, nor is it a window-level fact covered by
the third. It carries "is Peek front", is written by `evolve`'s `AppResigned` and `AppActivated`
arms, and has no docblock at all on `State.appActive` in `apps/desktop/main/window-kernel.ts`.
Either it is declared as a stored fact in the governing rule set with its rule stated, or the rules
that depend on it have no authority to cite.

**One contradiction to resolve alongside it.** This document states that the executor is "a dumb
re-assert loop with no decisions of its own", while `planRaise` is by construction a four-way
decision, one arm of which suppresses an effect outright. Both cannot stand. The
`'suppressed'`-arm deletion above resolves it in favor of the stated rule.

**The raise gate is wrong under the kernel, not merely unverified.** `window-state.ts
applyRaiseRequest`'s `if (!state.appActive) return` drops a raise entirely — the request, its
`FOCUS_CONTENT`, and its `SET_STACKING` all vanish. `planRaise` does not carry that guard forward
as a suppression; it resolves `!appActive` to `'inactive-show'`, the same outcome headless gets,
and that outcome still orders and shows the window
(`backend.showWindow(effect.id, { activate: false, ... })`, i.e. `win.showInactive()`) — it
withholds only app activation. `showInactive()` is `orderFront:`, which paints a Peek window over
the user's foreground app, the same visual outcome the `APP_RESIGNED` overlay hide (peek
`88797f2d`, R6) exists to prevent.

Every trigger that reaches the raise path while `appActive` may be false:

| trigger (old machine) | kernel route | what the user sees under kernel semantics |
|---|---|---|
| `RAISE_WINDOW_REQUESTED` — its sole production dispatcher is the modal-blur re-raise in `ipc.ts`, whose own comment names this as the macOS activation dance where `appActive` may still read false | `decide(RaiseWindow)` → `OsFocusGained` → `key` diff → `react` `RaiseWindow` → `planRaise` `'inactive-show'` → `backend.showWindow({ activate: false })` | A modal panel orders itself to the front while another app is frontmost. `planRaise` carries no satellite gate either, so the old machine's second drop — `isEligibleFront` rejecting satellites — is gone as well. |
| `WINDOW_CLOSED` successor / parent handoff | `react`'s parent-refocus rule emits `RaiseWindow` directly, gated only on `isContentWindow` | Nothing appears on screen at the time, but the window-server order changes unseen; `ba55be19`'s own accepted-loss note — that macOS restores the app's own window order on activation — is the argument this becomes visible later, when returning by Cmd+Tab finds a different window on top. |
| `WINDOW_HIDDEN` successor raise | `evolve`'s `case 'WindowHidden'` mints the op token and stamps the successor's `lastOpSeq`; `react`'s mirrored loop emits `RaiseWindow` for the same successor, gated on `next.appActive === true` and a non-null `topmost(next, isContentWindow)` | Built — see the RESOLVED marker above. |
| `DEVTOOLS_OPENED` / `DEVTOOLS_CLOSED` re-drive of `front` (devtools opens with `activate: false`) | `FocusAssertRequested` → `lastFocusAssert` diff → `[RaiseWindow, FocusContent]`, now gated on the target's `visible` (`react`'s focus-assert rule; the matching stamp condition lives in `evolve`'s `case 'FocusAssertRequested'` / `case 'AppActivated'`) | Built — see the RESOLVED marker above. |
| `SWITCHER_SELECTED`, Escape closing the switcher | the switcher is homed outside the kernel | No divergence: the overlay held key, so the app is active by construction. |
| `APP_ACTIVATED` cold-start latch | `lastFocusAssert` is written in the `AppActivated` arm | No divergence: `appActive` is true in that same transition. |

**Recommended resolution — not adopted here.** `planRaise` gains a suppressing outcome for
`!appActive` that performs nothing, not even the show, and the raise is latched for replay on
`AppActivated`. The kernel already owns the machinery for that: generalize
`pendingColdStartFocus` / `lastFocusAssert` into a one-slot pending raise rather than introducing a
queue.

Two parts of this are inference rather than observation, and worth a live check before the
resolution is frozen: that macOS renders a backgrounded app's `orderFront:`ed window above the
frontmost app's windows (global ordering within a level, not just within-app); and which two call
sites `applyRaiseRequest`'s "sites 2 and 3" names — commit `05c1abd4` numbers them inconsistently
between its docblock and its message, though devtools and the close-handoff are the two that fire
while inactive under either reading.

**The two sibling reads.** `window-state.ts applyOsFocusRealized` defends the `FOCUS_CONTENT`
mirror; `electron-window-backend.ts focusContent` (`armSelfCausedFocus` plus `wc.focus()`) taking
first responder for a window the OS made key while the app is backgrounded is a focus grab the old
machine refused. `planRaise`'s own docblock already states the rule that a backgrounded app gets no
first-responder handoff either, so carrying an `if (!this.state.appActive) return;` beside the
headless gate in the executor's `FocusContent` case is consistency with that rule, not new policy —
today that gate is unmasked, and it is exactly the half the focus-assert rule above emits with no
guard at all.

`window-state.ts applyOverlayFollow` defends a second rule stated in place: "Never reveal the
chrome or float it over the foreground app" (peek `71cfde09` item 7, R6), corroborated by
`hybrid-overlay.ts wireAppActiveGate` and by `apps/desktop/CLAUDE.md`'s "Overlay must `hide()` on
`did-resign-active` or the chrome lingers on screen when Peek isn't the active app." `react`'s
overlay-follow rule emits only `SetBounds` off a host-bounds diff, so it is accidentally the
inactive-safe subset — but the kernel has no resign-hide and no activate-reveal for that role at
all: `isAppResignSweepEligible` excludes role `overlay`, so §0.1.11's sweep never selects it, and
nothing pairs an `AppActivated` re-show with it either, so the chrome never leaves the screen when
the app backgrounds. The pair has to be ported together — `AppResigned` hides attached overlays,
`AppActivated` re-pins and emits `ShowWindow({ activate: false })` — and the `!appActive` gate then
belongs on that reveal.

**Built, on a narrower gate than `!appActive`, and without the re-pin the pairing above named.**
`evolve`'s `case 'AppResigned'` hides every record with `overlayFor !== undefined && visible`,
marking it `hiddenByAppBlur: true`; `case 'AppActivated'` re-shows exactly the records
`appBlurRevealAdmits(state, w)` admits — the same query gates both the reshow-detection check and
the actual re-show map — clearing the mark on each record it re-shows. Three decisions are folded
into that pairing, each recorded on the symbols above:

- **The hide lands on the raw resign edge, not the settle** (`WindowRecord.hiddenByAppBlur`'s doc
  comment). What waits for the 500ms settle is DISMISSAL (`lastAttention`), because dismissal is
  destructive — a dismissed palette does not come back, so the macOS activation dance (a resign an
  `AppActivated` moments later cancels) must never be allowed to trigger it. A hide that
  `AppActivated` reverses carries no such risk, and an overlay sits above the regular stack — which
  means above other applications' windows too — so the settle delay would be that long with Peek's
  chrome floating over the app the user just switched to.
- **Attachment selects the victims, never role** — the same relation `selectTransientAutoclose`
  reads, and the reason that query skips overlays outright: an attached overlay's visibility
  belongs to its attachment, so it is driven by this rule and never dismissed.
- **The reveal can refuse.** `appBlurRevealAdmits` lets the attachment refuse the re-show when the
  host entered fullscreen or went off screen while Peek was backgrounded. A refusal leaves the mark
  set rather than clearing it — the record is still off screen for the reason the mark names — and
  any genuine `WindowShown` clears the mark regardless, so a stale mark self-heals the moment
  something legitimately shows the window.

**The re-pin named above did not land, deliberately.** No always-on-top re-assert accompanies the
reveal. A window's level is a persistent property of the native window — ordering it off screen
does not clear it — so re-asserting it on every show would be a platform workaround with no observed
defect behind it, and the kernel carries no always-on-top effect of its own by design: pinning is
folded entirely into `layer`, realized only through `SetStacking`'s re-assert loop (§0.1.6), which
this reveal does not trigger (`AppActivated` changes visibility, not `order`'s membership or
positions, so `react`'s `orderChanged` test reads false and no `SetStacking` follows). If the
overlay is ever observed returning behind its host on macOS, that ordering belongs behind the window
port in the backend's show path, never in a rule above it. UNVERIFIED on macOS — no live check has
been run against this reveal.

#### Registration facts the kernel needs but no site supplies

`layer`, `canBecomeKey`, and `acceptsInput` are fields on `WindowRegistered` that no production
registration site passes; `MachineWindowSpec`, `WindowSpec`, and `RegisterWindowSpec` have none of
them. `izui-roles.ts deriveWindowSurface()` derives all three from open params. A survey of real
construction sites falsifies three derivations that would otherwise look correct:

- **`canBecomeKey` keys on neither role nor `alwaysOnTop`.** `hybrid-overlay.ts ensureOverlay` is an
  always-on-top `role: 'overlay'` window that is deliberately `focusable: true` so Cmd+L can type in
  the navbar, and `test-fixture-glue.ts` registers `focusable: false` without being always-on-top.
  It is exactly `focusable !== false`.
- **`acceptsInput` keys on neither role nor `alwaysOnTop`.** The two production `role: 'overlay'`
  windows disagree: `features/windows/background.js openWindowsView` takes clicks, while
  `features/spaces/background.js`'s border passes them through.
- **Peeks and slides (`role: 'quick-view'`) sit at `BASE_LAYER`, not above it.** They declare no
  `alwaysOnTop`, and their above-ness is `type: 'panel'` AppKit behaviour. Placing them above base
  would put them in `isAppResignSweepEligible`'s `layer > BASE_LAYER` half, which its role clause
  exists to keep them out of.
- **`layer` keys on the registered `alwaysOnTop` — the resolved, headless-gated value (§0.1.10) —
  not on class.** `classifyWindowRegistration` assigns class `overlay` / `palette` on role alone,
  so a class-based derivation would call a role-overlay
  window pinned even when nothing pinned it. The sets coincide today only because all three
  role-overlay/palette sites also declare `alwaysOnTop`.
- **Two bands suffice.** `'floating'` and `'torn-off-menu'` are the same macOS window level, so a
  third band would realize identically at the OS boundary.

`acceptsInput` is stored and merged but read by nothing in the kernel today — no query, predicate,
or effect consults it.

#### Measured: a live shadow run against session restore, opens, close, and quit

`window-kernel-shadow.ts` runs a `WindowKernelExecutor` over a no-op backend (`NoopKernelBackend`
— records effects, performs none) fed every input the old machine receives: registration,
OS focus and the blur settle, teardown commands, the OS close report, session restore's
stack-order import, window show/hide with the activate flag, `AppActivated`'s re-show, and
explicit raise requests. `compareShadowKernelState` diffs the two views after each feed, logged
under `PEEK_SHADOW_KERNEL_COMPARE=1`. Production behavior is unchanged by any of this — the
executor's effects have nowhere to land, and the kernel is authoritative over nothing yet.
Headless runs driving session restore, fresh opens, re-opens of already-open URLs, a close, and a
graceful quit-and-relaunch measured the following.

**A registration-only feed leaves `topmost(state, isContentWindow)` permanently `null`.**
`isContentWindow` (`window-kernel.ts`) short-circuits on `!record.visible`; `RegisterWindow`
creates records with `visible: false`; only `WindowShown` and `AppActivated`'s re-show ever set it
true. Before visibility was fed, the kernel returned `null` on all 126 comparisons across two
runs while the old machine's `front` tracked the app correctly. This is why the visibility feed
(`shadowKernelWindowShown`/`shadowKernelWindowHidden`/`shadowKernelAppActivated`) exists. No unit
test caught it — the suites construct records directly rather than driving them through
registration.

**An activating show is a focus gain in kernel terms.** The collapse-onto-existing-window path
(`ipc.ts windowOpenHandler`'s reuse branches, `windows.ts showWindowHeadlessSafe`) dispatches
`WINDOW_SHOW_REQUESTED`, never `RAISE_WINDOW_REQUESTED`; the old reducer's `WINDOW_SHOWN` arm
moves `front` via `applyFocusGained` when `focused` is true. The kernel's `WindowShown` arm never
reorders `order`, by design, so the shadow needed the activate flag threaded through and
translated into a companion `OsFocusGained` (`shadowKernelWindowShown`'s `focused` parameter). On
a real display a native `'focus'` echo follows an activating `show()` anyway; the synthetic feed
is idempotent with it, because the echo names the window `key` already holds, so its diff is
empty. Headless masks OS activation, which is why this was only visible headless.

**Headless, `front` agrees and `stackOrder` diverges — the two traded places.** Every re-open now
shows the kernel already on the reused window, with the old machine arriving one line later (its
own `WINDOW_SHOWN` echo drains after the current effect batch), so the next comparison is silent on
`front`. But the companion focus gain promotes the re-shown window to the top of the kernel's
`order`, while the old machine's `stackOrder` does not reorder on `WINDOW_SHOWN` at all — only its
`front` moves. Headless, that disagreement persisted — still present 31 seconds later, across a
close. Two instances per run were measured, no third shape.

**Resolved against a real display: the divergence is a headless artifact, not a real
disagreement.** A native `'focus'` echo follows an activating `show()` on a real display, so
`OS_FOCUS_GAINED` fires on the collapse-onto-existing re-open and drives the old machine's own
stack raise — the same reorder the kernel's companion focus gain performs. Once the ids the old
machine keeps out of `stackOrder` (satellite windows) are stripped, the two views agree. The live
run recorded 1611 `OS_FOCUS_GAINED` events; the two headless runs above recorded zero — headless
masks OS activation (the same fact that motivated the activate-flag feed above), and this is its
second-order effect on stacking. Consequence: `session-projection.ts`'s `stackIndex` derivation,
which reads `stackOrder`, is unaffected at cutover, and the synthetic focus feed
(`shadowKernelWindowShown`'s `focused` parameter) is idempotent with the real OS echo exactly as
predicted. The headless numbers above stay on record as the evidence trail that motivated checking
a real display in the first place.

**What agreed.** Membership showed no persistent divergence — one transient line per run at the
re-entrant overlay registration, cleared by the next comparison. Before the show-feed change
above, stacking order agreed exactly (106/106 and 116/116 lines) once the ids the old machine
keeps out of `stackOrder` were stripped — so the `stackOrder` disagreement above is new and
attributable to the show/focus change, not pre-existing noise.

**A comparator caveat.** The comparison runs at the tail of each feed, and the old machine's
snapshot can predate its own reaction where its adapter queues an echo rather than draining it
immediately — re-entrant registration, teardown, and the show path all do this. Divergence
resolved by the very next comparison is this artifact, not a real disagreement; divergence that
persists across comparisons, like the `stackOrder` case above, is not.

**A further live run recorded a persistent, real `front` divergence — not the headless artifact
above.** A command-palette window (`wm-29`, `peek://cmd/chain-editor.html`, `role: 'utility'`)
opened and was later closed during the run. `window-state.ts`'s `WINDOW_SHOWN` arm moves `front`
to whatever window was shown, with no role test; the kernel's `topmost(state, isContentWindow)`
did not select it, because `isContentWindow`'s `CONTENT_ROLES` allow-list (`content` /
`child-content` / `workspace`) does not admit `utility`. The two disagreed (old `wm-29`, kernel
`wm-2`) for the entire ~6.4 seconds the window stayed open — 9 consecutive comparisons, none of
them clearing on the next tick the way the caveat above describes — and the divergence ended only
when the window closed. This is a live instance of the defect §0's "Why `front` must stop being
stored state" already names: a window excluded from a fact to make a policy easy. The kernel is
correct here; the old machine is the one in error.

The same run recorded no other unexplained divergence: 94 comparisons total — 79 `stackOrder`
(all reducing to the exclusion already documented above, agreeing exactly once those ids are
stripped), 6 `membership` (the same transient dispatch lag described above, self-clearing), and
these 9 `front`.

### 0.1.6 Layers and realizing the order against Electron

**Layers are a fixed ordered set established by construction, not per-window integers sorted at
realize time.** sway hardcodes 13 `wlr_scene_tree*` struct fields in z-order and never recomputes;
its ordering ops are *sibling-local*, and changing layer is a **reparent**, not a restack. So
`layer` is an index into a fixed, application-controlled ordered array — not a raw AppKit level.
Use 3–4 layers; treat a layer change as rare and expensive.

The backend has two ordering primitives: `win.moveTop()`, which reorders within the window's own
level and does not activate, and `win.setAlwaysOnTop(flag, level)`, which moves between levels.
**There is no "place this window below that one."** So a total order is realized by replaying
`moveTop()` over `order`, bottom → top, within each layer — a sort by re-insertion. `session.ts
reassertStackingOrder` was already doing this by hand.

This is exactly what dwm does (`restack()` chains each window `Below` the previous one), and **no
surveyed WM computes a minimal diff** — dwm re-emits the entire stack on every focus change and no
one has complained about the cost. Consequences:

- The executor replays via `moveTop()` bottom → top within each layer, but `window-kernel.ts
  react` no longer hands it the whole band on every mutation: it computes the smallest trailing
  run of each band's order that still reproduces the band, so a mutation that moved nothing
  emits nothing to replay. A window that is not in this minimal set is not re-asserted.
- **Never read z-order back from Electron.** The OS stack is a *write-only projection*; the OS
  reorders it independently on user clicks and `app.activate`. This is EWMH's model —
  `_NET_CLIENT_LIST_STACKING` is published by the WM, never consulted by it.
- **A reconciliation path is required, not just a write path.** dwm's `focusin()` exists solely
  because "there are some broken focus acquiring clients"; when X reports a focus dwm didn't
  order, dwm re-asserts its own model. That still holds for a focus report itself (it is a
  genuine `order` change, so it reaches `SetStacking`), but a minimal diff assumes `prev` already
  matches the OS — an external perturbation the model never observed is not self-corrected the
  way a full re-emission would have corrected it for free.

**Consequence for any `topmost` predicate: `order` is not layer-sorted, so a cross-band predicate
is unsafe.** `order` is insertion- and movement-ordered only — nothing in `window-kernel.ts
evolve` sorts a position in `order` by `layer` — so it can legitimately hold a base-layer window
above a floating-layer one. The bottom-to-top `moveTop()` replay above realizes every band
correctly regardless of that interleaving, because cross-band relative position in the array is
unobservable to the OS. `topmost(state, pred)` has no such cover: it scans `order` end-to-start
and returns the first match, so a predicate whose admitted set spans layer bands can return a
window that is not visually topmost, with no error path to catch it. A `topmost` predicate is
therefore safe only when the set it admits lies within one layer band; a predicate spanning bands
must either add a `layer` clause or be replaced by a query that respects bands. See 0.1.5 for the
one predicate this already threatens.

**The `layer` → realized-band mapping is now written and exercised.**
`window-kernel-executor.ts` `stackingLevelForLayer()` realizes it: `layer > BASE_LAYER` maps to
`'pinned'` (Electron's always-on-top band, realized via `setAlwaysOnTop(true, 'floating')`);
everything at or below `BASE_LAYER` maps to `'stacked'` (the regular band, via the `moveTop()`
replay). `'excluded'` is unreachable — non-membership is unrepresentable under RULE 1, so a
window the OS is left to manage on its own is simply never emitted a `SetStacking` at all
(`react`'s `visible && orderable` filter), rather than being emitted one that says "exclude me".
`WindowKernelExecutor` is the executor R2 describes for this kernel: it owns one `State`, exposes
`getState`/`subscribe`/`dispatch`/`execute`, performs effects against `WindowBackend`, and replays
`SetStacking` last, grouped by layer lowest-first with array order preserved within a band — never
a read-back from Electron. It is constructed by nothing in production: `window-state.ts` and its
adapter still drive the running app, and `window-kernel.ts` is now imported by
`window-kernel-executor.ts`, `window-escape.ts`, and the kernel's own test files.

Two items the executor leaves open rather than done. The quick-view and headless activation masks
for a raise are applied in the executor's `planRaise()`, not in `electron-window-backend.ts
raiseWindow()` — that function is live on the old machine's `RAISE_WINDOW` effect, and changing it
would alter production behavior for the running app's peeks and slides; the mask belongs on the
backend eventually and needs its own commit and gate run. And no `subscribeFrontChange` equivalent
has been built on the new executor: its one live subscriber (the shared chrome overlay's
retarget) wants an effect rather than a subscription, and the query it would dedup on spans more
than one `layer` band and needs a layer-aware replacement first — `WindowKernelExecutor.subscribe`
is deliberately the base surface only, not that consumer's shape.

**Electron hazards worth recording:** `'floating'` and `'torn-off-menu'` are the *same*
`NSWindowLevel` (3); toggling `setAlwaysOnTop(false)` → `(true)` on one window can knock *other*
windows out of always-on-top (electron#31536); `setAlwaysOnTop(false)` is "not respected until
window clicked" (#45024); `moveTop()` has crashed (#14392). Electron also cannot express AppKit's
`addChildWindow(_:ordered:)` — a *persistent* "keep B just above A" constraint. For dialogs and
popovers, do what EWMH does with `WM_TRANSIENT_FOR`: store the parent edge and **topologically
sort by it when deriving the order**, rather than storing a z.

### 0.1.7 Invariants: deleted, or made unstateable

| Old | New |
|---|---|
| `frontInvariantHolds` | **deleted.** `key` has no eligibility rule; the OS decides. |
| `stackOrderInvariantHolds` | **half unstateable, half surviving.** Its membership half — every id in `stackOrder` is a `stacked` visible record, and every such record is in `stackOrder` — cannot be stated once membership and order are one structure. Its no-duplicates half is unaffected by the collapse (a list can still repeat an id) and is carried forward as a property-based invariant over `order`, 0.1.8. |
| `isStackMember` / `reconcileStackMembership` / `stackRemove` | **deleted.** Nothing reconciles membership because nothing can leave. `isStackMember` had two clauses and both are placed: `stackingLevel === 'stacked'` is absorbed by RULE 1, which makes membership universal; `visible` moves into the queries that scan `order` (0.1.5), where it filters a result rather than gating membership. |
| `isEligibleFront` | **deleted.** Three clauses, of which §0 names one as the exclusion that must go — `!satellite`. The other two do not go with it: the record-resolves clause becomes the accessor that resolves `key` against `order` and answers `null` on a miss (0.1.4), and `visible` becomes a predicate the replacement queries pass in (`topmost(state, restorable)`, 0.1.5). |
| `deriveStackingLevel` / `StackingLevel` / `PINNED_CLASSES` | **deleted.** Three arms: `pinned` (`hud` / `overlay` / `palette`) → `layer`, declared at creation rather than derived from a class name; `excluded` (any other satellite) → nothing, because RULE 1 makes non-membership unrepresentable; `stacked` → the default every window now has. The `excluded` arm reads the `satellite` flag, so it inherits every arm of `isSatelliteRegistration` below — retiring the class-name half alone does not retire this predicate. |
| `isSatelliteRegistration` / `SATELLITE_CLASSES` / `WindowRecord.satellite` | **deleted.** §0: "`satellite` was an invention". Four arms, needing four destinations. (1) `windowClass` in `SATELLITE_CLASSES` (`hud`, `background`, `bridge`, `offscreen`, `test-fixture`, `devtools`) — **no single axis**; see below. (2) role `overlay` or `palette` — `overlay` → the `overlayFor` relation; `palette` → **no home**. (3) `modal === true` — **no axis**: a close-on-blur dialog holds key while it is open, so this is lifecycle, owned by the transient-autoclose selector (`selectTransientAutoclose`). (4) `focusable === false` → `canBecomeKey: false`. |
| `enforceFrontInvariant` | **deleted.** Self-repair is the defect, not the safety net — but it did two things and only one is the defect. The dev/test throw goes with the invariant it guarded. The production arm's MRU-successor pick (`successorFront`) survives as an explicit fallback query, `topmost(state, restorable)` (0.1.5), run by a caller that wants a fallback rather than applied to `key` behind one. |
| `WindowRecord.focusSeq` / `focusSeqCounter` / `bumpFocusSeq` / `getWindowFocusSeq` | **deleted.** Use-order is position in the one order; see 0.1.10. |
| `windows.ts APP_HIDE_EXCLUDED_CLASSES` | narrower than feared — its **only** reader is `getVisibleWindowCount()`, feeding `maybeHideApp`. Not a z-order concept at all: it asks "does this window count as a reason to keep the app on screen". Becomes one named predicate at that one call site. Its five entries are a policy list rather than a property — `quick-view` is non-satellite yet excluded, while a detached devtools window and an extension popup are satellites yet still count — so this is the one surviving decision that branches on `class`, which the 0.1.4 rule forbids. The replacement predicate has to name the thing it means at that call site, not the class set. |

**Every arm of a deleted predicate needs a destination.** A predicate deleted here is replaced by
one axis only if it had one clause. A mapping that names fewer axes than the predicate had arms is
incomplete, and stays incomplete until each missing arm is placed on an axis, placed on a relation,
or written down as having no home. Declaring an arm homeless is a valid outcome and the honest one;
inventing an axis so the mapping comes out clean is not. The cost of getting this wrong is
concrete: `class === 'hud'` was recorded as meaning non-focusability, and a rule rebuilt from that
reading — `!canBecomeKey && visible` — sweeps the spaces screen border and the test fixture along
with the HUD, because `hud` is three clauses and `!canBecomeKey` is one of them (0.1.4).

**The arms of `isSatelliteRegistration` with no kernel home.** The four arms are a disjunction —
the first to match returns, so their source order changes nothing about the result and no
precedence has to be preserved. (Contrast `classifyWindowRegistration`, whose arms return
*different* classes, where role precedence is load-bearing and is what keeps the spaces screen
border classified `overlay` instead of `hud`.) Two arms have nowhere to land:

- **The class arm** covers six classes that are front-ineligible for three unrelated reasons.
  `hud` decomposes as 0.1.4 records it. `background`, `bridge` and `offscreen` are never-visible
  infrastructure; nothing about the three axes excludes them, and under RULE 1 they sit in `order`
  like every other window, so whatever must skip them is a query over `visible` / `kind`, not an
  axis. `devtools` and `test-fixture` are both visible and focusable, so `canBecomeKey` does not
  describe them either. That `extension-ui` is deliberately absent from the set — an extension
  popup is a real window the user works in — is itself the evidence that the set encodes a policy
  judgement per class rather than a shared property.
- **The `palette` half of the role arm.** A palette window can hold key and takes typed input (the
  Escape routing in `window-state.ts` handles exactly the case where a palette holds key), so
  `canBecomeKey: false` is wrong for it, and it is not chrome attached to a host window, so
  `overlayFor` does not describe it either.

Both are open items. Whatever replaces front-ineligibility has to answer them before these classes
and roles can be modelled, and until it does, no rule may be written as though `canBecomeKey: false`
covers what `satellite` covered.

### 0.1.8 Hardening the kernel

In priority order. Everything here is cheap *because* of 0.1.1 — a total, guard-free `evolve` is
an ideal test target.

1. **Property-based model testing** (`fast-check` `modelRun`): generate random command/event
   sequences, assert the invariant list after **every** step; failures shrink to a minimal
   reproducer. Invariants: no duplicate ids in `order`; `key` resolves or is `null`; `layer` is
   non-decreasing after a realize pass; every emitted effect names a live window. **Highest return
   on this list — do it first.**
2. **Replay determinism — a standing requirement, enforced by a test that fails when it breaks.**
   `fold(evolve, init, events)` is a pure function of the event log: **the same log yields an
   identical state AND an identical effect list, always.** This is not a property checked once
   during the rewrite; it is a rule the suite defends forever.

   Concretely, three tests, all in the main-process unit runner so they cost nothing:
   - **Determinism.** For a generated event log, fold it twice from `init` and assert deep
     equality of both the final state and the concatenated effect list. Catches any hidden
     ambient input — a clock read, a `Math.random()`, iteration over a non-deterministically
     ordered structure, a captured module-level variable.
   - **Prefix stability.** Folding `events[0..n]` then applying `events[n+1..]` equals folding the
     whole log in one pass, for every split point. This is what makes a recorded log a valid test
     case and a crash dump replayable.
   - **No command may enter `evolve`.** A type-level guarantee (commands and events are separate
     unions) plus a runtime assertion in dev, because the moment a rejectable request is folded,
     replay stops being deterministic — replaying it re-evaluates guards against a state rebuilt
     from other replayed commands. This is the failure mode the split in 0.1.1 exists to prevent,
     and this test is what keeps it from creeping back.

   The rule this encodes for anyone editing the kernel: **`evolve` may read nothing but its two
   arguments.** That is the mechanical test, in the same spirit as `window-state.ts`'s existing
   zero-value-imports rule — and like that rule, it is worth a check that runs every loop rather
   than a sentence in a document.
3. **Idempotence of settling events.** `WINDOW_CLOSED` twice = once, and the second must not
   throw. Catches real duplicate-IPC bugs — `ipc.ts`'s real-tile-launch path already registers
   each window twice.
4. **Curated commutativity.** Events touching disjoint windows commute. Assert over a *curated*
   independent set, not all pairs — many pairs are order-dependent by design, and an allowlist of
   exceptions is documentation with extra steps.
5. **Exhaustive `switch` with a `never` default** in `evolve` — compiler-enforced total transition
   coverage.
6. **Single-writer enforcement, mechanically.** Deep-`readonly` exported state; one `dispatch`
   chokepoint; a lint rule barring imports of kernel internals from outside the kernel;
   `Object.freeze` on returned state in dev builds. The enforceable version of the existing
   zero-value-imports discipline.
7. **`replay(log)` entry point** plus dumping the log on crash, so a live bug report becomes a
   deterministic test case.

**Deliberately skipped as over-engineering here:** a maintained TLA+ or Alloy specification (a
single-process pure reducer has none of the interleaving formal methods exist to find, and the
structural invariants become unstateable under 0.1.4 anyway); deterministic-simulation apparatus —
simulator, fault injection, seed farm; an XState runtime dependency (take the taxonomy, not the
interpreter); branded types beyond ids and the raw/parsed intent boundary.

**Guard and state discipline**, from the statechart literature: *different behavior = different
state; same behavior = same state* — promote a boolean to a state only when it changes the
machine's response to an event. Per-window booleans are **never** machine states (that is N-fold
explosion); they are record fields. **Name every guard** — an anonymous conjunction of five
context fields re-hides the machine just made explicit; if there end up being more named guards
than states, the guards *are* the real state space and the model is too flat.

### 0.1.9 The test debt, classified

Every test mentioning `front` was read and sorted by what it actually claims. **118 distinct
tests** (109 in `window-state.test.ts`, 9 in `session-projection.test.ts`) — larger than the ~69
previously estimated:

| Bucket | Count | Disposition |
|---|---|---|
| **A — means "who holds key"** | 49 | Mechanical: `front` → `key`. |
| **B — means "topmost matching"** | 17 | Rewrite as `topmost(state, P)`. |
| **C — means a relation** | 6 | Parent hand-back on close, fullscreen-owner pin. |
| **D — pins the exclusion behavior** | 24 | **Must be overturned.** |
| **E — incidental** | 22 | Mostly the `front→back` z-order homonym. No claim. |

- **Bucket A is the largest, and most of its tests assert that `front` is untouched by non-focus
  events and mirrors OS focus reports.** The suite already believes key is a *reported* fact — the
  rewrite is closer to what the tests want than to what the code does.
- **Bucket D is the cost of the change** — 24 tests asserting the exclusion §0 names as the
  defect. Overturning them *is* the work, not collateral damage.

#### The per-test migration map

The bucket table says how many tests fall into each disposition; this section names them, so the
classification is a record rather than something the rewrite has to re-derive from the source.

**The load-bearing free variable: `isContentWindow` does not exist yet.**
`topmost(state, isContentWindow)` is what several of the rewrites below resolve to, and whether
that predicate admits `role: 'workspace'` and `role: 'quick-view'` decides their outcome. The old
model kept quick-views front-eligible only so `front` could double as the Escape target
(`window-state.test.ts` `isSatelliteRegistration — single owner of front-ineligibility` › `role
quick-view is not a satellite (peeks/slides stay front-eligible)`); the key/main split dissolves
that coupling, because Escape targets key, not main.

Two gaps in the kernel as written, neither yet implemented:

- The `WindowRegistered` arm does `order: [...state.order, record]`, placing a fresh registration
  on top. The rule decided above places a background open BELOW the last-focused window — nothing
  implements it yet.
- `react` emits `RaiseWindow` whenever `OsFocusGained` moves the target, while three tests in
  `front — a projection of OS focus; raises come from named targets only` assert no raise is ever
  emitted from `OS_FOCUS_GAINED`: › `an OS-driven front switch mirrors the order WITHOUT echoing a
  raise (the OS already did it)`, › `INVARIANT: no RAISE_WINDOW is emitted from WINDOW_SHOWN or
  OS_FOCUS_GAINED (the pump's convergence obligation)`, and › `a raise echo (WINDOW_SHOWN
  {focused:true}) does not re-raise — the RAISE_WINDOW → WINDOW_SHOWN cycle is cut structurally`.
  Resolved above, in "Decided: devtools re-assert, cold-start focus, and stack-order import enter
  the kernel" — the kernel is correct and the three tests are deleted, not honored.

Three open policy questions the migration cannot answer by translation alone:

- Whether a raise requested on a `canBecomeKey: false` window is refused outright or reorders
  without granting key — `RAISE_WINDOW_REQUESTED — an explicit, user-requested raise` › `a
  satellite id -> no effects`.
- Whether a palette holding key arms the Escape grab — `deriveEscGrabRegistered — truth table over
  (appActive, front, contentFocused) — §5 step 11 re-key` › `matches the table across (appActive,
  front, contentFocused)`, whose `contentFocused: false` case stood in for "someone else holds
  key."
- Whether closing a child whose parent is hidden raises anything at all — `parent refocus on
  WINDOW_CLOSED (replaces the main.ts parentWin.focus() block)` › `an ineligible parent (hidden)
  falls back to the MRU successor`.

#### The overturn set (bucket D)

24 tests share one shape: a satellite takes OS focus, the old model pins `front` on the content
window, and the new model instead records `key` on the satellite while answering the original
question with `topmost(state, isContentWindow)`. Each becomes two assertions where it had one. All
in `window-state.test.ts`.

Panel-takes-key cases, each rewritten to a `keyWindow(state)` assertion naming the satellite plus a
`topmost(state, isContentWindow)` assertion naming the content window:

- `historical-bug replays (§5.2)` › `(e) palette-issuer exclusion: a satellite palette focus never
  clobbers the front page`
- `ported: active-hybrid-window tracking -> front` › `focus landing on the overlay (satellite)
  keeps the content window as front`
- `overlay attachment / follow / retarget (§4.3 dim 3b, §5 step 9)` › `` the overlay is never
  `front`, attached or not (it is a satellite) ``
- `` ported: resolveCloseTargetId / resolveFocusedVisibleWindowId -> `front` `` › `overlay
  (satellite) focus leaves the close/command target on the host (cmd+W redirect)`
- `front — a projection of OS focus; raises come from named targets only` › `a satellite gaining
  OS focus leaves front alone, and closing that parentless palette raises NOTHING` and › `a LIVE
  satellite palette is not evicted by the next transition (command-palette flash-and-vanish)`
- `deriveEscGrabRegistered — truth table over (appActive, front, contentFocused) — §5 step 11
  re-key` › `a dangling front (no matching WindowRecord) is NOT a representable StateSnapshot —
  pins the defined-but-irrelevant fallback`

The overlay case is the showcase for the key/main split: one window genuinely holds key, a
different window is main, and only two stored facts can say both without pretense. In the
Escape-grab case, a dangling key is legal by construction (`keyWindow` returns null rather than
repairing), so the grab arms and nothing can hear `before-input-event`.

Exclusion machinery overturned by deletion, not by rewrite:

- `front-invariant guard (dev/test throws, prod self-corrects)` › `THROWS in dev/test when reduce
  yields an illegal front (naming the event + front id)` and › `self-corrects (no throw) in
  production` — the state each test crafts as "illegal" is an ordinary kernel state, and the
  production self-correct these tests pin is the forbidden repair (0.1.5).
- The `frontInvariantHolds(...)` and `stackOrderInvariantHolds(...)` assertions the file's
  `drive()` helper runs after every scripted event.

Order assertions correct only because satellites were filtered out of the stack, and correct for a
different reason once they are not:

- `front — a projection of OS focus; raises come from named targets only` › `OS_FOCUS_GAINED on a
  satellite drives no FOCUS_CONTENT and does not touch the ordered stack` — main is unmoved because
  the palette is not a content window, not because it was filtered from the order; the order does
  change, since the palette now tops the single order.
- `SET_STACKING — a machine-driven raise drives order with it` › `a raise the machine declines
  (switcher open / satellite holds key / app inactive) emits NO SET_STACKING`.
- `devtools transitions (§4.6 dim 8a)` › `OS focus landing on a registered devtools window yanks
  nothing back (Esc grab stays off)` — devtools genuinely holds key, which is the reason Escape
  must not be grabbed; the assertion was already the right answer, reached from a wrong premise.

Two that look alike and are not:

- `` ported: resolveCloseTargetId / resolveFocusedVisibleWindowId -> `front` `` › `a modal palette
  (satellite) is excluded as a target` dispatches only `WindowShown`, never `OsFocusGained` — `key`
  is unwritten for a different reason (`WindowShown` does not write key at all), not because the
  palette was excluded.
- `ported: focused-window tracking -> front arbitration` › `a background / non-focusable / overlay
  surface (satellite) does NOT become front` is the most dangerous test in the file: its literal
  `null` survives a mechanical rename to `keyWindow(state) === null` and would be wrong — a window
  that genuinely took OS focus genuinely holds key. The correct pair is `keyWindow(state)` naming
  it and `topmost(state, isContentWindow) === null` (no content window exists in that state). It
  should also split along the axis it conflates: `canBecomeKey: false` means the adapter never
  emits `OsFocusGained` at all, while an overlay with `canBecomeKey: true` does take key.

Pins whose mechanism no longer exists:

- `historical-bug replays (§5.2)` › `(b) S2-null focus lag: OS_FOCUS_SETTLED_NULL keeps front (the
  target survives an app switch)`
- `ported: active-hybrid-window tracking -> front` › `DELIBERATE DIVERGENCE: focus leaving the
  whole group keeps front (old decideAfterBlur nulled it)`

`OsFocusLost` writes `key = null` honestly in the new model; what these two protect — the command
target surviving an app switch — is preserved by `topmost(state, isContentWindow)` (main), so the
"deliberate divergence" framing they carry no longer applies.

#### Straight deletions

- `isSatelliteRegistration — single owner of front-ineligibility` (10 tests) and
  `isSatelliteRegistration — class extension (§5 step 4)` (4) — the satellite concept is replaced
  by the orthogonal `layer` / `canBecomeKey` / `acceptsInput` properties, and `class` becomes
  lookup-only with nothing branching on it. Some may be worth re-homing as `canBecomeKey`
  defaulting tests.
- `deriveStackingLevel — single owner of stack participation (§4.3 dim 3)` (4) — replaced by the
  numeric `layer` band plus the single unfiltered order.
- `reduce purity` › `isEligibleFront rejects satellites, hidden, and absent records`.
- The `front` invariant half of `totality matrix — every (state-class x event) returns a defined
  transition` › `reduce is total: defined result + front invariant holds for all combinations`,
  plus the satellite axis of that describe's `buildStateClass` helper.

#### The one-order consequence

`STACK_ORDER_IMPORTED — the session-restore order import (§5 step 5 part B)` › `a background open
sits ABOVE the last-focused window while ranking BELOW it by focus recency` is rewritten, not
translated: order becomes bottom-to-top `[background-open, focused]`, key is unwritten by a
non-activating show, and the assertion that the two orders genuinely disagree is deleted — deleting
it is the point (0.1.10).

Everything else resting on `focusSeq` / `focusSeqCounter` or the two-list split, deleted along with
those fields: the four successor-repair tests exercising `successorFront()` — `ported:
focused-window tracking -> front arbitration` › `closing the front window clears the stale id and
picks the MRU successor`; `front — a projection of OS focus; raises come from named targets only`
› `WINDOW_HIDDEN of the front invalidates and asserts the successor` and › `WINDOW_CLOSED of the
front raises the successor; WINDOW_CLOSED of a non-front satellite raises nothing`; and `ordered
stacking list — membership across the class enum (§5 step 5)` › `closing the front removes it AND
the succession raise tops the successor (list stays consistent)`. Also deleted for the same reason:
the whole of `ordered stacking list — membership across the class enum (§5 step 5)`, `SET_STACKING
— a machine-driven raise drives order with it`, `WINDOW_CONTENT_ORDERABLE — the page-host
orderability caveat (§5 step 5)`, `restore-shaped import — back→front yields that order, focused on
top (§5 step 5)`, and the remainder of `STACK_ORDER_IMPORTED — the session-restore order import (§5
step 5 part B)` apart from the background-open test above — each treats `stackOrder` as a filtered
second list; and `stacking purity — reduce never mutates the input stackOrder`.

The same split was written into the on-disk format in `session-projection.test.ts` as `zOrder`
versus `stackIndex`, and the rewrite is landed:

- `session-projection — machine-derived descriptor fields` › `zOrder is the record focusSeq and
  focused is the machine front` is now just `focused is the machine front` — the `zOrder`-source
  assertion is dropped as redundant, since every `focusSeq`-bearing world in the on-disk-shape
  describe already pins it byte-for-byte.
- The same describe's › `stackIndex is the position in the machine stack, and disagrees with
  zOrder on a background open` is deleted outright — its whole thesis was the disagreement one
  order removes.
- `session-projection — readStackIndex + orderRestoredWindowsBottomToTop` › `a PRE-FIELD snapshot
  falls back to the focus-recency ordering restore used before` is now `a PRE-FIELD snapshot (every
  position unrecorded) falls back to reversing dispatch order` — the fallback no longer names that
  order "focus recency," since the one-order decision retires focus recency as a distinct concept
  from stack position.
- The same describe's › `SAVE → RESTORE round trip: a background open comes back ON TOP of the
  last-focused window` is now `... comes back BELOW the last-focused window`; the fixture's
  `stackOrder` puts the background open below the last-focused window directly, so save and
  restore agree instead of ranking the pair two opposite ways.
- `serializeSpaceWorkspaces — hybrid page-hosts + machine-derived fields (§5 step 11 task 9)` ›
  `zOrder is TRUE STACK POSITION (StateSnapshot.stackOrder index), not WindowRecord.focusSeq` was
  already the right answer and survives unchanged — the strongest existing evidence that the
  single-order decision is correct.

`session-projection.ts` itself needed no change for this; the fix was confined to the test
fixtures.

#### The relation set (bucket C)

`parentId`, replaced by a direct lookup with no eligibility filter and no MRU fallback:

- `parent refocus on WINDOW_CLOSED (replaces the main.ts parentWin.focus() block)` › `closing the
  focused child hands front back to the parent and re-drives it`
- the same describe's › `re-drives the parent even when it already was front (old focus()
  parity)`
- the same describe's › `an ineligible parent (hidden) falls back to the MRU successor` — a
  half-overturn: both the eligibility gate and the recency fallback are gone.
- `devtools transitions (§4.6 dim 8a)` › `closing a registered detached devtools window refocuses
  its parent via the parent-refocus transition`

`overlayFor`, replaced by `overlayForHost(state, hostId)`: the cmd+W redirect and the
overlay-is-never-front tests named in the overturn set above belong here too, because the relation
is what the exclusion was faking. `overlay attachment / follow / retarget (§4.3 dim 3b, §5 step 9)`
› `the owner surface exposes both directions of the relation` already uses the relation directly
and is the shape the others move toward.

#### Mechanical (buckets A, B, E)

The rule, not every test name: `front` on a plain window that genuinely last received OS focus
becomes `keyWindow(state)?.id`; "front is untouched by this transition" becomes "key and order are
untouched" (the safest bucket); "the window the user means to act on" becomes `topmost(state,
isContentWindow)?.id`.

`` ported: resolveHybridEscapeTarget -> ESC target is always `front` `` › `ESC targets the front
quick-view, not the landed content host` becomes "ESC targets the key window, never main" —
asserting `keyWindow` names the quick-view and, in the same state, `topmost(state,
isContentWindow)` names the content host.

A mechanical rename is unsafe for anything turning on `successorFront()` (see the one-order
consequence above), and for `front — a projection of OS focus; raises come from named targets
only` › `a front change on WINDOW_SHOWN moves front and emits NO raise (the echo cycle is cut)`,
whose premise disappears because `WindowShown` never writes key in the kernel.

### 0.1.10 Decisions and remaining questions

**Settled, not open: ESC does NOT close a `child-content` window in an active session.** The
absence of that arm from the current tables is the standing decision, not a porting loss. History,
in order:

- `900b0268` (2026-05-08) added `child-content -> 'close'` in every session, off a reported repro —
  open a page from a group, press ESC, expect the page to close and the group to come back.
- `a9c4ec88` (2026-06-04) reversed it four weeks later, merging `content` and `child-content` under
  one rule: ESC closes a real content window ONLY in a `transient` session; while the app is
  OS-focused, `escUnhandledPolicy` opens the switcher instead. The reversal is stated in the
  commit subject and in the replacement comment.
- `c2fa0a16` (relocation into `izui-state.ts`) and `c2a4cc2e` (the `window-state.ts` reducer) both
  carried the post-reversal table byte-for-byte. `window-state.ts escPolicy`'s "ported VERBATIM"
  claim is accurate; its source already lacked the arm.

Coverage exists and agrees: `apps/desktop/tests/desktop/izui-escape.spec.ts` "active mode: ESC on
child-content window does NOT close it (regression)" was added by `616b3b69` (2026-02-27), predates
both policy commits, and passes at this tip. `window-escape.ts escapeClosePolicy` agrees with
`escPolicy`, and `window-escape.ts ESC_FALLBACK_ROLES` carries `child-content` for the switcher
fallback. Nothing else can close the window on ESC: `window-state.ts decideEscape` is the sole
decider, `tile-preload.cts api.escape.onEscape` only relays handled/unhandled, and the DOM
`Escape` listeners in `renderer/page/overlay.js` and the `peek-*` components dismiss in-page
widgets only.

Reopening this means re-reversing `a9c4ec88` with a new repro, and flipping that spec — not
restoring a lost line.

**Decided: a peek always opens its own window.** A peek is a standalone feature with its own
behavior, not a generic page host, so it never reuses an already-open window and never lands in an
existing page host. The one reuse it does allow is itself: reopening the same peek refocuses that
peek's own prior window rather than spawning a duplicate.

The mechanism, traced 2026-08-20. `features/peeks/background.js executeItem()` opens with
`role: 'quick-view'`, `pageHost: true`, `modal: true` and `key: peek:<keyNum>` — the slot number,
not the address, so two slots sharing an address still get a window each. In `ipc.ts`'s
`windowOpenHandler` the generic URL dedupe — `findWindowByUrl` (its only call site) and
`findHybridWindowByUrl` — sits behind a guard requiring `!options.key`, so a peek never reaches it.
The key branch runs instead: `hybrid-page-host-registry.ts findHybridWindowByKey` and `main.ts
findWindowByKey` match only a window opened under that identical key. `pageHost: true` then forces
a fresh top-level `BaseWindow` + `WebContentsView`, not a view inside an existing base-layer window.

**This rule rests entirely on the `!options.key` guard**, which reads as a dedupe detail rather
than as the thing keeping peeks in their own windows. Widening that guard, or dropping `key` from
`executeItem()`, would silently put a peek into whatever window already held the same URL.

**Decided: one order, and nothing else orders windows.** A background open is placed **below**
the last-focused window. `focusSeq` and `focusSeqCounter` are deleted.

The question was whether one order can carry both z-order and use-order. Every surveyed WM keeps
two lists — dwm `next` (creation) + `snext` (MRU); i3 `nodes_head` + `focus_head`; sway scene graph
+ per-seat `focus_stack` — and this app already needed both: `window-state.test.ts`'s
`STACK_ORDER_IMPORTED` suite pinned exactly that divergence — a background open placed ABOVE the
last-focused window in z while ranking BELOW it by focus recency — until commit `8524b31b` retired
it once this decision landed, i.e. a background open deliberately placed high in z while staying
low in MRU. The resolution is to remove the divergence at its source rather than model it: **a
window that was not focused does not go on top.** One order is then honest, and `topmost(state, P)`
answers both questions; `session-projection.test.ts`'s *"a background open is saved BELOW the
last-focused window"* and *"SAVE → RESTORE round trip: a background open comes back BELOW the
last-focused window"* pin the resolved order.

What this costs, stated plainly so it is not discovered later:

- The behavior changes. A background-opened window no longer appears above the window currently
  being worked in. That is arguably the better behavior — it is what Metacity's focus-stealing work
  concluded ("a new window that doesn't get focus should be stacked below the focused window but
  still mapped") — but it *is* a change, and the `window-state.test.ts` test above must be
  rewritten, not translated.
- Restore ordering must be re-derived: session restore currently replays saved `stackIndex` and
  separately marks one descriptor focused. Under one order those stop being independent, so the
  saved order must already put the focused window on top.
- `session-projection.test.ts`'s on-disk-shape world `every skip rule at once` sets `front: 'w7'`
  with five windows above `w7` in the default stack. That is correct under the current model,
  where `focused` is `machineId === snapshot.front` — an independently settable fact. Once
  `focused` becomes `topmost(state, isContentWindow)` at cutover, that scene is self-contradictory
  (a focused window cannot sit five positions below the top of its own stack) and must be
  revisited in the same commit that performs the cutover.

**Decided: registration carries the resolved creation intent, not the raw request.** Both
`ipc.ts` registration sites (`assembleHybridPageHost` and the window-open IPC handler) and
`tile-launcher.ts createTileBrowserWindow` register the headless-gated `alwaysOnTop` the window was
actually constructed with. Registering the raw request made the same declared intent yield
`FLOATING_LAYER` on the `ipc.ts` path and `BASE_LAYER` on the `tile-launcher.ts` one under
headless, and told the machine a window was pinned that the constructor had been explicitly told
not to pin. The record describes the window that exists; an option the constructor declined is not
a fact about it.

**Both questions below are now answered.** The evidence bearing on each is assembled under it and
kept, because it is what each answer was decided on.

#### Answered: `order` includes never-shown and offscreen windows

**Decided: yes — every window, always, taken literally.** No registration-time membership test is
added, and no window the machine knows about is absent from `order`. This is the reading the rest
of this section was already written against, and it is the one that requires no exception.

What it rests on, in one line each: excluding these windows would mean *adding* a filter that does
not exist today, since all five reach the reducer through the single `registerWindowWithMachine`
path; the only property the excluded set shares is a `class` string, and §0.1.4 forbids branching
on `class`; and the three costs of including them are bounded and already paid — `role: 'utility'`
keeps them out of every content predicate, never being visible keeps them out of every `visible`
clause, and `react` emits `SetStacking` only for `w.visible && w.orderable`.

**What this commits to, stated so it is not rediscovered.** Every query keeps carrying its own
exclusions rather than relying on `order` membership to pre-filter — which is what they already do.
The `SetStacking` exclusion is incidental (it is by visibility, not by class), so it stops applying
to any of these windows that is ever shown; a devtools or test-fixture window that becomes visible
is an ordinary orderable window and is meant to be.

**The consequence for the retirement of the old machine.** Every boot emits
`divergence kind=stackOrder old=["wm-4"] kernel=["wm-1",…,"wm-4"]`. Under this decision that
divergence is the kernel being right and the old machine being narrow, not a defect to reconcile —
the comparator is contrasting two membership rules, and only one of them survives.

Rule 1 says every window, always, and the reading taken here is the literal one — `background`,
`bridge`, `offscreen`, `devtools` and test fixtures all sit in the one order at their own layer.
Taking it literally is the reading that requires no exception.

**They already register, through the one shared path.** `background` (`core-glue.ts`), `bridge`
(`chrome-extensions.ts`), `offscreen` (`chrome-api-polyfills/offscreen.js`), `test-fixture`
(`test-fixture-glue.ts`) and `devtools` (`main.ts`) each call `window-state-singleton.ts`
`registerWindowWithMachine`, which reaches the reducer through `window-os-adapter.ts`
`WindowOsAdapter.registerWindow`. There is no second registration path and no bypass, so excluding
these windows means *adding* a filter that does not exist today rather than declining to add one.
The kernel itself has no production producer yet — `window-kernel.ts` is imported only by
`window-escape.ts`, `window-kernel-executor.ts` and their test files, and `WindowKernelExecutor` is
constructed nowhere in production — so this is a fact about the registration path the kernel's
producers will be ported from, not about the kernel as wired.

**All five register `role: 'utility'`**, which is exactly what lets `isContentWindow` exclude them
with no `class` test. That predicate is `visible && canBecomeKey && roleIn(CONTENT_ROLES, role)`,
and `CONTENT_ROLES` is the allow-list `content` / `child-content` / `workspace`. Membership in
`order` therefore costs these windows no eligibility anywhere a content predicate is used.

**What including them costs — three things, all bounded.** They occupy positions in `order`; every
`topmost` scan walks past them; and `react` considers them for `SetStacking`. The third is already
settled: `react` emits `SetStacking` only for records where `w.visible && w.orderable`, so a
never-shown infrastructure window emits nothing. That exclusion is incidental rather than
deliberate — it is by visibility, and it would stop applying to any of these windows that was ever
shown.

**What excluding them costs.** A second membership rule beside the one order: a set of windows the
machine knows about that `order` does not contain. That is the divergence RULE 1 exists to
delete — membership and order become two structures again, and "every window, always" stops being
a checkable property.

**The layer constraint bears on it.** §0.1.5 and §0.1.6 record that `order` is not layer-sorted and
that a `topmost` predicate is safe only when the set it admits lies within one layer band.
Infrastructure windows do not widen any band a predicate already spans: `role: 'utility'` keeps
them out of every content predicate, and never being visible keeps them out of every `visible`
clause. They enlarge the array that is scanned without enlarging any set that is admitted.

**What each answer commits to.** Including them keeps one membership rule and one structure, and
leaves every query carrying its own exclusions — which they already do. Excluding them introduces
a registration-time membership test, which must then name the excluded set by some property. The
only property these five share today is a `class` string, and §0.1.4 forbids branching on `class`.
The same set already has no home in §0.1.7's mapping of `isSatelliteRegistration`'s arms:
`background` / `bridge` / `offscreen` are never-visible infrastructure while `devtools` and
`test-fixture` are visible and focusable, so no single axis describes what an exclusion would have
to name.

#### Open question 2: does `key` survive app deactivation?

**ANSWERED — `key` is nulled at the focus settle.** The decision, its two port constraints, and the
old arm and pins it retires are recorded in §0.1.5, "Decided: the three calls the map revision was
blocked on". The evidence below is what it was decided on, and is kept for that reason.

The requirement the answer had to satisfy: coming back to Peek shows it exactly as it was left,
and only an explicit action changes that (an external link opening a new frontmost window being
the ordinary case). Nulling `key` satisfies it because that requirement is a statement about
`order` and about the topmost content window, neither of which app deactivation touches. The one
field the old machine had was serving both this fact and the OS-level one, and could not report
"no Peek window holds key" without discarding the user-facing fact along with it; the key/main
split is what lets both be true at once.

When Peek resigns active, no Peek window holds key in the OS sense. The drafted answer is that
`key` goes `null` on resign and is re-reported on activate — honest, but it means "who was last
key" becomes a `topmost` query.

**No production reader wants `key` for the survives-a-switch question.** §0.1.5's wiring map
records that `keyWindow(state)` is the correct replacement for **none** of the existing production
readers of `front`; every one of them wants the topmost content window. The reason is precisely the
matter at issue: old `front` was sticky across an app switch, while `key` is nulled by
`OsFocusLost`. `isContentWindow`'s own doc states the same thing — `topmost(state, isContentWindow)`
is AppKit's *main window*, and main is the thing that survives.

**Where a null `key` at save time would be silently wrong.** `session-projection.ts`
`serializeSession` and `serializeSpaceWorkspaces` record `focused` per descriptor.
`saveSpaceWorkspaces` runs inside `saveSessionSnapshot`, so both projections share its save
reasons: `before-quit`, `window-lifecycle` (a debounced window close or open), `autosave`
(periodic, and therefore able to land while the app is inactive) and `manual`. If `key` is null at
any of those moments, a reader that mapped `focused` to `key` writes `focused: false` for every
window and restore loses its head-start window. That constrains which query the session reader
uses, not what `key` holds: the mapping §0.1.5 already assigns it is `topmost(state, <content
predicate>)`, which is total and unaffected by deactivation.

**The old reducer deliberately refuses to null on blur.** `window-state.ts` handles
`OS_FOCUS_SETTLED_NULL` as an explicit no-op, whose comment states that the target must survive an
app switch and that `appActive` — not `front` — carries "is Peek front". `window-state.test.ts`
pins this twice: *(b) S2-null focus lag: OS_FOCUS_SETTLED_NULL keeps front (the target survives an
app switch)*, and *DELIBERATE DIVERGENCE: focus leaving the whole group keeps front (old
decideAfterBlur nulled it)* — the second recording that the reducer already reversed an earlier
design which did null.

**The counter-consideration.** Under the key/main split, both pins constrain *main*, not *key*.
Surviving an app switch is main's job, answered by `topmost(state, isContentWindow)`, and nulling
`key` honestly is what makes RULE 2 — report, never repair — true. A `key` kept populated while no
Peek window holds key in the OS sense is a repaired value under another name, and repairing `front`
is the defect §0.1.5 identifies as the source of the Escape bug.

**What the kernel does today.** `key` is written only by the `OsFocusGained` and `OsFocusLost` arms
of `evolve`. `AppResigned` sets `appActive: false` and arms `pendingAppResignSweep`; `AppActivated`
sets `appActive: true`, disarms it, and re-shows the records carrying `hiddenByAppBlur`;
`AppResignSettled` hides the sweep-eligible records when still armed. **None of the three touches
`key` or `order`** — `State`'s doc says so and each arm's return confirms it. So the answer is
decided entirely by whether a producer emits `OsFocusLost` on deactivation; the app-activation arms
themselves neither null nor preserve `key`. No such producer exists yet.

**The provenance machinery does not settle it either.** `isStaleSelfEcho` compares an incoming
`OsFocusGained`'s `cause.opSeq` against the target record's `lastOpSeq`, and the macOS resign-dance
guard is `pendingAppResignSweep` (armed by `AppResigned`, disarmed by `AppActivated`, acted on only
by `AppResignSettled`). Both exist to keep the dance — macOS's spurious resign/activate cycle —
from being read as a real app switch. Neither writes `key`, so neither stops a dance from nulling
and re-reporting `key` twice. Nulling on deactivation therefore has to be driven from the settle,
not from the resign edge, for the same reason the sweep is.

**What each answer commits to.** Nulling commits every "which window was last worked in" reader to
`topmost(state, isContentWindow)` — the mapping §0.1.5 already assigns all of them — and commits
the null to the settle point rather than the resign edge. Preserving commits `key` to naming a
window that does not hold OS key, which needs either a second stored field or a stated exception to
RULE 2, and re-opens the drift `enforceFrontInvariant` produced.

**Where the evidence points.** Every reader that a null `key` would hurt is already mapped to a
content query rather than to `key`, and the two reducer tests that read as counter-evidence pin the
behavior of `front`, whose role is now split — so they constrain main. That leaves no identified
reader that needs `key` to survive deactivation. The decision stays open; what the evidence removes
is the claim that nulling breaks a caller.

---

### 0.1.11 Transient dismissal — implemented against the kernel, the ownership relation proven at runtime

§0's rule is built and, since the cutover, wired: `window-kernel-executor.ts` performs the
dismissals `react` emits over the production `WindowBackend`, the same backend
`window-state.ts`/`window-os-adapter.ts` used to drive alone (see §0.1's "Built, and now wired for
queries" and `window-kernel-shadow.ts`'s header for how production reaches this executor). This
records what the implementation froze so the rule can be checked against the running app, rather
than re-derived. The ownership relation itself — `overlayFor` and `parentId` — is now proven at
runtime (see "The gap" below); what the rewrite below settles separately is a narrower question —
that the app-resign half of the rule, previously not exercised at all, now is.

**The rule is implemented on one fact, not a pair.** `window-kernel.ts react()` could not read
`ev.cause`, or where the triggering event says attention went, directly — `react` is a pure
structural projection of `(prev, ev, next)` (§0.1.1), so branching on the event's payload would make
it something other than a diff. Where attention sits therefore had to become a diffable state fact:
`State.lastAttention`, an `{ holder, cause, seq }` record (`window-kernel.ts Attention`, formerly
`FocusProvenance`) written by every event that moves it — `evolve`'s `OsFocusGained` arm (`holder:
ev.id`) and its `AppResignSettled` arm, on the branch where the resign is real and the app has not
already come back active (`holder: null`) — mirroring `lastTeardown` and `lastFocusAssert`. `react`
diffs `lastAttention.seq` against the previous state and, on an advance, calls
`selectTransientAutoclose(next, attention.holder, attention.cause)` and emits one `DismissWindow` per
victim — placed after the `RaiseWindow` rule and before the `SetStacking` re-assert, matching the old
reducer's fixed effect order. `selectTransientAutoclose` itself is unchanged in kind — a pure
selector, not a transition — now taking a `WindowId | null` holder rather than always naming a
window. ONE condition, one loop, one emission site: the earlier draft of this section diffed
`OsFocusGained` alone, gated on a non-null `key` present in `order`, which left the app-losing-focus
case unhandled by this rule entirely; that split is gone, and every cause that moves attention now
runs through the same query.

**The app-resign half is fed, not skipped.** `AppResigned` and `AppResignSettled` reach the shadow
kernel from `electron-window-backend.ts attachAppListeners`'s `did-resign-active` handler and its
`APP_RESIGN_SETTLE_MS` timer (`window-kernel-shadow.ts shadowKernelAppResigned` /
`shadowKernelAppResignSettled`) — the same production dispatch sites that already feed the old
machine, not only a unit-test construction. `holder` could not be read off `key` in place of a
stored field: an app-resign event never touches `key` (RULE 2), so at the settle `key` may still name
whichever window held it before the app resigned, and a selector reading `key` would spare exactly
that window — typically the palette that should close.

**The sweep itself fires at the settle, observed in a live process.** A run with
`PEEK_SHADOW_KERNEL_COMPARE=1` and `E2E_TEST=true` caught the dismissal itself, not only the feed.
With `E2E_TEST=true`, `ipc.ts`'s per-window blur self-close handler is not installed
(`windowSelfClosesOnBlur(options) && process.env.E2E_TEST !== 'true'`), so the command palette
survived to the app-resign settle instead of being hidden roughly 470ms earlier by that handler. At
the settle the kernel state read `appActive: false`, `pendingAppResignSweep: true`, the palette's
record `role: 'palette', visible: true`, and `lastAttention` moving from `{ holder: 'wm-28' }` at
seq 13 to `{ holder: null }` at seq 14. In the same transition the kernel emitted `closeOrHide
wm-28` for the palette — the rule stated in §0 firing on the degenerate, null-holder value of the
one-hop exemption relation, the same value §0 describes as admitting nothing and dismissing every
visible, unattached transient. A run that shows only the feed reaching the kernel, with no
dismissal to show for it, is starvation by a second owner of the same policy — `ipc.ts`'s own blur
handler winning the race under ordinary, non-`E2E_TEST` conditions — not a defect in the rule; this
is the confirming instance of the recorded bug shape, a rule can be starved rather than wrong.
`E2E_TEST=true` also installs a hidden, non-focusable test-fixture window (`main.ts loadFeatures()`
→ `test-fixture-glue.ts initTestFixture()`) and the hybrid overlay test bridge (`hybrid-overlay.ts
initHybridOverlay()`); neither can take focus, so neither confounds an activation observation made
under it.

One caveat from the same effort: a first attempt produced no evidence at all, because the app had
already gone inactive during launch focus churn before the gesture ran — `open -a Finder` produced
no resign edge to observe. A live dismissal check must activate the app before the gesture that
resigns it.

**At the time of this run, not proof of the hide/re-show half.** The shadow feed alone could not show
that a real app switch hides and later re-shows the right windows: the old machine hid, on the raw
resign and well before the 500ms settle, the windows `isAppResignSweepEligible` selects; its native
`'hide'` report reached the kernel first (`shadowKernelWindowHidden`), so by the time the settle
arrived those records already read `visible: false` and the arm marked nothing.
`compareShadowKernelState` does not compare `visible` at all, so a clean shadow run was evidence the
compared facts — membership, `front`, `stackOrder` — held, not evidence the hide/re-show behavior was
equivalent. That resolved at cutover: `window-os-adapter.ts`'s `HIDE_WINDOW` arm is a no-op
post-cutover, and the kernel's own `AppResigned` arm now performs the attached-overlay and
sweep-eligible hide directly — on the raw edge, over the real backend — so this is production
behavior now, not a question a later cutover still owes (see `window-kernel-shadow.ts
shadowKernelAppResigned`'s doc, and §0.1.11 above).

**`window-state.ts selectAppResignTransients` becomes dead at cutover, and its restriction is not
carried forward.** The old arm scopes dismissal to `rec.kind === 'page-host'`, on the assumption that
a transient `BrowserWindow` already closes itself on blur through its own listener — which is why a
`kind: 'browser'` command palette was never a dismissal candidate on a real app switch, the defect
this rule exists to fix. `window-kernel.ts selectTransientAutoclose` reads no `kind` at all, so
nothing analogous to the old restriction is ported forward.

**Live-observed.** In the same run, switching to another application with the command palette open
left it visible on screen — not dismissed, reproducing exactly the defect the paragraph above
names: `ipc.ts` registers the command panel with `kind: 'browser'`, so `selectAppResignTransients`'s
`rec.kind === 'page-host'` clause never named it a candidate on the app-resign path.

**Dismissal is its own effect.** The sweep emits `Effect.DismissWindow`, not `Effect.CloseWindow`.
`WindowKernelExecutor` routes `DismissWindow` through `backend.closeOrHide`, deliberately distinct
from the hard `backend.closeWindow` that realizes `CloseWindow`. `CloseWindow` has no keepLive
branch and no exit-native-fullscreen preamble; routing a dismissal through it would destroy a
keepLive slide that should only be hidden, and would skip the preamble a fullscreen victim needs
before it disappears, stranding a black macOS Space. `closeOrHide` was already exposed on the
backend port, so no new port method was needed.

**A raise command now sweeps.** `decide` translates a `RaiseWindow` command into an `OsFocusGained`
event carrying no `cause` (absent means world). A raise that genuinely takes key therefore reaches
`react`'s sweep the same way a real user focus does — the old reducer's `RAISE_WINDOW_REQUESTED`
never ran the sweep at all. This is intended, not a gap: what keeps a machine-driven raise from
sweeping a sibling opened after it is the machine-cause ordering floor `selectTransientAutoclose`
already holds (a transient strictly newer than the focuser survives a machine-caused focus).

**The exemption is now a relation, directional and one-hop.** A focuser exempts only the victim it
points at: `focuser.parentId === victim.id || focuser.overlayFor === victim.id`. Not symmetric, not
transitive — which is what keeps a window a transient merely *creates* from being exempt (a command
palette that opens a page host is still dismissed when that page host takes key). On the victim
side, `overlayFor !== undefined` replaces the old role check: an attached overlay manages its own
show/hide through the attachment relation and leaves by detach, never by dismissal.
`AUTOCLOSE_FOCUSER_EXEMPT_ROLES` and `AUTOCLOSE_EXEMPT_ROLES` are deleted from `window-kernel.ts`
(`window-state.ts` keeps its own copies — see §0 above).

**Two facts had to be supplied first, because the relation matched nothing without them.**
`AttachOverlay` had no production dispatcher at all, so `overlayFor` was permanently `undefined` in
every real run regardless of whether an overlay was genuinely attached. It is now fed from both
production dispatch sites in `hybrid-overlay.ts` — `retarget()` (attach or retarget onto a real
host) and `detachOverlayFromMachine()` (`hostId: null`) — alongside their existing dispatch to the
old machine, never in place of it.

Separately, the chain popup opened by `renderer/cmd/panel.js openChainPopup()` registered with
`parentId: null`, because `ipc.ts`'s `NON_PARENT_ROLES` excludes the palette that opens it from
`isRealParent`. It now declares its parent explicitly through a new `declareParent` open option,
threaded through `ipc.ts` independently of `isRealParent` and consumed only at the legacy
`BrowserWindow` registration site. `NON_PARENT_ROLES` was not widened to cover this instead: it was
introduced by a separate fix for a named regression — pressing Escape closed any web page just
opened from the command palette, because such a page was promoted to `role: 'child-content'` and
`escPolicy()` closes that role on Escape. Widening `NON_PARENT_ROLES` to also cover the palette
would have reopened exactly that regression; `declareParent` sets the machine-level `parentId` this
rule reads without touching `isRealParent` or the role derivation Escape depends on. It does not set
Electron's native `BrowserWindow.parent`, which `options.parentId` already governs and which no
caller of this new option wants changed.

**The behavior this froze**, stated as the production windows it changes. Newly sweeping as
focusers, because none has any `parentId`/`overlayFor` relation and each genuinely is another window
taking key: the datastore viewer and diagnostic tool (`renderer/index.js` command handlers) and the
two OAuth windows (`features/wonderwall/services/base.js`, `features/lex/atproto.js`). The windows
switcher (`features/windows/background.js openWindowsView`) both starts sweeping as a focuser and
becomes sweepable as a victim — it is `role: 'overlay'` but parented to nothing and attached to
nothing, so the relation gives it no exemption in either direction. Remaining exempt through the
relation rather than through a role: the chain popup toward the palette named by its `parentId`, the
shared chrome overlay toward the host it frames through `overlayFor` (the "address bar dismisses the
slide" regression this rule exists to keep fixed), and a detached devtools window toward its host,
also through `parentId`.

**Closed: both relation facts arrive at runtime.** Both supplied facts — the overlay-attach feed and
the chain popup's `declareParent` — were previously proven only by unit tests that construct kernel
records directly, plus a source-drift test pinning that `openChainPopup()` still passes
`declareParent: true` and that `ipc.ts` still resolves it; a predicate that is correct in form but
matches nothing in practice is this codebase's documented recurring bug shape, and the same shape
that made `AttachOverlay` a dead command in the first place. A live run with
`PEEK_SHADOW_KERNEL_COMPARE=1` and temporary `[relation-diag]` logging in `window-kernel-shadow.ts`
(`shadowKernelRegisterWindow` / `shadowKernelAttachOverlay`) closed it: opening a chain popup from
the command palette logged `register {"id":"wm-29","role":"utility","parentId":"wm-27"}` — a real
`parentId` naming the palette, not `null` — and the shared chrome overlay logged `attach-overlay
{"overlayId":"wm-3","hostId":"wm-2"}` against a real page-host id. The directional one-hop exemption
relation over `overlayFor`/`parentId` therefore rests on facts observed in a live process, not only
on hand-constructed unit records.

**One caveat left open.** The same run logged an earlier `attach-overlay
{"overlayId":"wm-3","hostId":null}`, roughly seven seconds before the real attach above. Whether
that line is a detach expressed as a null-host attach was not determined; it means `overlayFor`
spends real time as `null`, which is worth recording but was not chased down.

Also measured: registration on the real-tile-launch path logged duplicate `register` lines for the
same id (`wm-21` and `wm-22`, each logged twice) — corroborating the double-registration §7 already
documents ("Duplicate registration re-pumps `WINDOW_REGISTERED` on purpose") and the reason the
re-registration merge must be correct rather than merely defensive.

---

## 1. The mandate

**The mandate: one single deterministic system that is the Window Manager.** Nothing outside it
makes actual Electron/OS window operations happen. Electron is abstracted inside it so the
system can port to Tauri, ElectroBun, Swift, or any successor toolkit.

Three rules follow from that mandate. They are numbered because the rest of this document, and
every future change to window behavior, refers back to them.

### R1 — ONE owner decides all window state

A single pure reducer decides everything: which window is front, whether that intent has
been asserted onto the OS, what Escape does, what is fullscreen, what is visible, what is
stacked where, what gets restored at cold start. It is a pure function — dependency-free,
no imports, no I/O, no clock, no platform. It takes an event and a state and returns a
state plus a list of effects. It is exhaustively unit-testable without launching anything.

There is no second decider. Not a "small local decision," not a "just this one case,"
not a helper that "only handles the overlay." If code needs a window decision made, the
reducer makes it.

### R2 — ONE executor performs OS window operations

Exactly one module turns effects into real window operations. Nothing outside it calls a
window API. Not `focus`, `show`, `showInactive`, `hide`, `close`, `destroy`, `setBounds`,
`moveTop`, `setAlwaysOnTop`, `setFullScreen`, `setVisibleOnAllWorkspaces`, `maximize`,
`unmaximize`, `minimize`, `restore`, `blur`, `setSkipTaskbar`, `webContents.focus()`, or
any successor API in any successor toolkit.

Code that wants a window to change **dispatches an event**. It does not perform the
change and then inform anybody. It does not perform the change instead of informing
anybody. It dispatches, and the reducer decides whether and how the OS moves.

**R2 is enforced by a mechanical grep check in CI. A violation is a build failure, not a
review comment.** This is the rule every previous attempt lacked, and its absence is why
every previous attempt failed. An architecture that depends on contributors remembering a
document is an architecture that decays at the rate people forget. The check must run in
the same gate that runs the tests, must list the forbidden call names explicitly, and must
allow exactly one exempt file — the executor — plus a small, individually-justified,
comment-annotated carve-out list that only shrinks.

### R3 — The executor talks to a BACKEND PORT, not to Electron

The executor does not import Electron. It calls a `WindowBackend` interface. Electron is
one implementation of that interface (`ElectronWindowBackend`), and it is the only place
in the entire window manager where the word `electron` appears.

No Electron type crosses into the owner. The owner must compile, and its unit tests must
run, with **zero platform imports** — that is the mechanical test of R3, and it is
checkable the same way R2 is: if `window-state.ts` ever grows an import, R3 is broken.

---

## 2. Why this keeps failing

This has been attempted repeatedly, over months and years, and it keeps collapsing back
into poorly-architected disjoint chaos. IZUI was supposed to be this system. It did not
become it.

The reason is specific and it is not a matter of running out of time.

**Every prior attempt introduced a NEW authority ALONGSIDE the existing ones instead of
DELETING them.** Each refactor was additive. Each one shipped a cleaner model, wired it up
next to the old paths, and left the old paths running — because deleting them was risky,
or out of scope, or "a follow-up." The follow-up never came, and the new clean model became
the Nth rival authority rather than the one authority.

The evidence is countable, from a full survey of `apps/desktop/main/`:

- **Three separate copies of "is the app active"** — the reducer's `appActive` in
  `window-state.ts`, `izui-state.ts`'s `appFocused`, and `hybrid-overlay.ts`'s own module
  `appActive` let. Three beliefs, three update paths, no reconciliation.
- **14 per-window registries**, spread across **3 mutually-incompatible id spaces**
  (Electron window ids, Electron webContents ids, and synthetic ids). *(The synthetic
  space has since been deleted — §5 step 1.)*
- **32 module-level mutable window-state variables** (42 counting the timing latches),
  each one a piece of window state that no owner owns.
- **11 decision sites that query Electron live** instead of holding state — asking the OS
  a question at decision time, which is precisely how belief and reality diverge.

Fragmentation on this scale is not an accident of rushed work. It is the *predictable
output* of additive refactoring. One authority is not reached by adding a better one.

Therefore the mandate is enforced as a **deletion rule with a mechanical check**, not as an
architecture diagram and not as a convention anyone has to remember:

> **Every step of this migration DELETES the authority it replaces, in the same commit
> that introduces the replacement.** A step that leaves the old path running has not been
> completed; it has been *skipped while appearing done*. Grep for the old symbol name
> before calling any step finished. Source control is the backstop that makes deletion
> safe — deleting committed code is not lossy.

---

## 3. The backend port (R3)

### Shape

`WindowBackend` is a narrow **command + event** interface. Two halves:

**Outbound — commands the executor issues.** Roughly:

| Command | Meaning |
|---|---|
| `create(spec) -> WindowId` | Realize a window from a platform-neutral spec |
| `destroy(id)` | Tear it down |
| `show(id, { activate })` | Make visible, optionally taking key |
| `hide(id)` | Remove from screen, keep alive |
| `focus(id)` | Make key / make first responder |
| `focusContent(id)` | Make the content surface first responder (the hybrid-host case) |
| `setBounds(id, rect)` | Position and size |
| `setStacking(id, level)` | Raise/lower relative to siblings; the `moveTop` replacement |
| `setAlwaysOnTop(id, on, level?)` | The HUD / chrome-overlay class |
| `setFullScreen(id, on)` | Native fullscreen |
| `setVisibleOnAllWorkspaces(id, on)` | macOS Spaces |
| `loadContent(id, source)` | Attach or navigate content |

**Inbound — events the backend emits.** The backend pushes; the owner never pulls:

`focusGained` · `focusLost` · `shown` · `hidden` · `closed` · `fullscreenEntered` ·
`fullscreenLeft` · `boundsChanged` · `displayChanged` · `appActivated` · `appResigned` ·
`spaceChanged`.

### Constraints — these are the point, not decoration

**The port is COMMAND + EVENT, never QUERY.** There is no `isVisible()`, no
`getBounds()`, no `isMaximized()`, no `isAlwaysOnTop()`, no `getFocusedWindow()`. The
owner must never ask the OS a question at decision time. Live queries are exactly how
belief and reality diverge, and the survey found 11 sites already doing it. Any OS fact the
system needs **arrives as an event and is stored in the reducer.** If a fact the system
needs has no event today, adding that event is the work — not adding a getter.

The existing code already admits this failure in its own comments: `closeOrHideWindow` and
`tile:window:hide` hand-dispatch `WINDOW_HIDDEN` because the OS event lags, and
`tile-ipc.ts tile:window:maximize` explicitly distrusts Electron's `isMaximized()` on
frameless macOS windows. Those are not quirks to work around; they are the reason the
query half of the boundary must not exist.

**No Electron types in the signature.** `BrowserWindow`, `BaseWindow`, `WebContents`,
`WebContentsView`, and Electron's `Rectangle` must not appear anywhere in the port. Use
plain structural types: `WindowId`, `Rect { x, y, width, height }`, `WindowSpec`,
`DisplayInfo`. The port is the seam that makes Tauri, ElectroBun, or a native Swift shell
a reimplementation rather than a rewrite.

**Window identity is an opaque WM-assigned id — LANDED** (commits 90becfc5, 5d760baf,
04d2eb94; minting moved with the port, 84ce45b4). `WindowId` is an opaque branded string
(`"wm-N"`), minted in exactly one place — `electron-window-backend.ts registerWindow()` —
idempotent per native window, returning the existing id on re-registration. The backend is
the **sole** `WindowId` ↔ Electron mapper — a private `idByOsWindowId` reverse map; no
other module translates. The reducer (`window-state.ts`), the executor
(`window-os-adapter.ts`), and the singleton (`window-state-singleton.ts`) are re-keyed to
`WindowId`, and `webview-guest-registry.ts guestToHost` now holds `WindowId` values.

When this document was written there were **three colliding id spaces**: Electron window
ids (`windowRegistry`, `WindowRecord`, most of `main.ts`), Electron webContents ids
(numerically indistinguishable from window ids, so a mix-up is silent), and synthetic ids
from `window-registry.ts nextSyntheticId`, counting **down** from
`Number.MAX_SAFE_INTEGER` specifically to avoid colliding with the other two. The
synthetic space is now **deleted, grep-zero** — `nextSyntheticId`, `refs`,
`registerPendingWindow`, `realize`, `getWindowRef`, and the `WindowRef` type are all gone
(they had no production producers). The other two numeric spaces survive only outside the
WM core:

**Deliberate scope decision — the renderer-facing id economy stays NUMERIC for now.** The
`tile-api.d.ts` window/context APIs, pubsub `windowId` payloads, the persisted
`datastore.ts windowContextState`, and the overlay focus protocol still speak numeric
Electron window ids. Conversion happens at the seams via `window-state-singleton.ts
getWindowIdFor()` / `getNativeWindowFor()`. Flipping that economy to `WindowId` is
**deferred to the session/context-store step**, not skipped.

A single WM-owned id space was a **precondition** for the port, not a later cleanup; it is
now in place. The backend maps `WindowId -> platform handle` internally and never leaks
the handle.

**First implementation — LANDED** (commit 84ce45b4): `electron-window-backend.ts
ElectronWindowBackend`. Portability targets that justify the shape: Tauri, ElectroBun,
native Swift.

---

## 4. The state model — all dimensions, one owner

Everything below is window management and belongs to the WM unless marked otherwise.
`OWNED TODAY` = already inside the reducer. `TO ABSORB` = must move in, deleting its
current authority. `OUT OF SCOPE` = genuinely not window management.

### 4.1 Identity and creation

**1a. Window identity / params** — ABSORBED (§5 step 4).
The `main.ts` module-level `windowRegistry` Map is deleted. The reducer's window table
(keyed by WM id, written only by reducer transitions) carries the `{source, params}`
payload, declared on the registration spec at the ipc.ts open sites (or merged later
via `WINDOW_PARAMS_SET` — the surviving `main.ts registerWindow` export). The old
accessors (`getWindowInfo` / `findWindowByKey` / `findWindowByUrl` / `getAllWindows` /
…) survive as a numeric-Electron-id seam over machine state with identical
membership: records without a payload (tiles, bridge/background/test-fixture/devtools)
stay invisible to them, exactly as they were absent from the Map. `params` is stored
BY REFERENCE and legacy consumers still mutate it in place (`params.currentUrl`,
`tile:window` bounds writes) — the reducer never reads inside it; collapsing those
in-place writes is later-step work (geometry §5 step 7, session §5 step 11).

**1b. New-window-vs-reuse dedup** — TO ABSORB.
Today: not held anywhere; recomputed on every open from **two parallel dedup ladders**
(the hybrid registry and `windowRegistry`) plus `ipc.ts pendingWindowKeys`. Every reuse
branch calls show/focus directly — a straight R2 violation, repeated four times.
Becomes: a dedup key index in reducer state; open requests dispatch an intent event and the
reducer answers reuse-or-create.

**12. Pending / unrealized windows** — DONE, by deletion rather than absorption.
The synthetic-id machinery (`window-registry.ts refs`, `nextSyntheticId`,
`registerPendingWindow`, `realize`, `getWindowRef`, the `WindowRef` type) is deleted,
grep-zero — it had no production producers. If pending windows return, they get an
ordinary `WindowId` and a `pending` lifecycle phase on the reducer window record — same id
space, never a separate synthetic range.

### 4.2 Geometry

**2. Geometry / bounds / maximize** — TO ABSORB. *(Top divergence risk #1.)*
*(Machinery landed inert — §5 step 7A. The hybrid store is DELETED — §5 step 7B:
`hybrid-page-host-registry.ts` `maximized`/`preMaxBounds` are machine-record
fields now, hybrid maximize is fully machine-owned. The generic BrowserWindow
maximize IPC is machine-owned and the `params` `preMaxX/Y/W/H`/`maximized`
bags as in-memory authority are DELETED — §5 step 7C: `tile-ipc.ts`'s
maximize/unmaximize/update-canvas-state dispatch machine events and the
`isMaximized()` distrust block is gone. `preMaxX/Y/W/H` keys survived only as
persisted-snapshot/open-options FORMAT (session save wrote them from the
presenter; reopen/restore read them to seed `MAXIMIZE_RESTORED`) until the
session read-model step, which landed at §5 step 11 task 5: the four flat keys
collapsed into one nested `preMaxBounds` field, read tolerantly
(`session-projection.ts readPreMaxBounds`) so a pre-collapse snapshot still
restores. The geometry READ model is machine-owned — §5 step
7D: presenter/close-capture/session-save read the reducer through the ONE
restorable-geometry rule (`window-presenter.ts getRestorableBounds`:
fullscreen → `fsMode.preBounds`, else the `bounds` mirror), live reads
surviving only as machine-unseen-window fallbacks. Still running: the
non-maximize `setBounds` IPC + drag/resize streams, until the remaining
step 7 cutovers.)*
Today: split three ways — live Electron `getBounds()`, `windowRegistry.params`
`preMaxX/Y/W/H`, and (deleted, step 7B) `hybrid-page-host-registry.ts
InternalEntry.maximized` / `preMaxBounds`. `tile-ipc.ts tile:window:maximize`
explicitly distrusts Electron's `isMaximized()` on frameless macOS windows.
Becomes: `bounds` + `maximized` + `preMaxBounds` fields per window record, updated solely
by the `boundsChanged` event (plus a one-shot registration-time seed of `bounds`,
step 7B); maximize is a reducer transition, never an OS question.

**2b. Placement intent** — OWNED, KEEP AS IS.
`window-placement.ts computePlacement` is already pure and genuinely well-owned. Do not
rewrite it. *(Resolution, §5 step 7A: it does NOT become "a helper the reducer calls" —
the reducer's zero-value-imports invariant wins. Placement rects are computed at the
dispatch site and carried on the event payload; `computePlacement` stays where it is.)*

**7. Multi-display** — ABSORBED (§5 step 10, Part A).
`display-watcher.ts` no longer calls `setBounds()` directly. It reads the OS (display
snapshot, both window registries, `getWindowInfo`), decides via the pure seam
`display-projection.ts collectDisplayProjection()`, and dispatches ONE `DISPLAY_CHANGED`
per pass; the reducer computes bounds and emits the `SET_BOUNDS` effects, which the port
performs. See §5 step 10 for the full mechanism (parent-centered resolution against the
projected rect, the `pendingProjectedBounds` fullscreen/hidden retry).

**7b. macOS Spaces** — TO ABSORB.
Today: `setVisibleOnAllWorkspaces` is write-only, never read back.
Becomes: a `visibleOnAllSpaces` field per window.

**7c. Space-change events** — ABSORBED (§5 step 10, Part B).
`electron-window-backend.ts attachSpaceChangeListener` (called from `attachAppListeners`,
darwin-only) subscribes to `NSWorkspaceActiveSpaceDidChangeNotification` through
`systemPreferences.subscribeWorkspaceNotification` and emits `SPACE_CHANGED`. The
notification's `userInfo` is EMPTY — verified live on a real machine — so the event carries
no Space identity and the machine holds no per-Space state. The reducer's clause is inert:
it writes nothing and emits nothing. The all-Spaces flag is sticky collection behavior, so a
Space switch is not a moment the OS forgets it, and re-asserting would fire a native
`setVisibleOnAllWorkspaces` per pinned window mid-transition and in the background — the call
this app has flash regressions on. The listener stays so the signal exists when something
needs it; the clause in `window-state.ts` carries the full argument.

### 4.3 Stacking and visibility

**3. Z-order / stacking / always-on-top** — ABSORBED (§5 step 5).
The reducer owns `stackOrder` (bottom→top) plus a per-record stacking level
(`deriveStackingLevel`); `SET_STACKING` is the sole ordering effect, and the executor's
`setStacking` — routed to the backend's `setStacking()` — is the only path to the OS.
`WINDOW_CONTENT_ORDERABLE`, produced from the `hybrid:first-frame` boundary signal, marks a
record orderable and re-drives `SET_STACKING` for it and everything above it. This is the
precondition for `SET_STACKING` to actually land where `applyRaiseRequest` and
`applyOsFocusRealized` (§6) already point `front` — a page-host that can't yet take a raise
must not be left stacked behind reality once it can.

**Measured: `SET_STACKING`'s per-window focus suppression over-claims and causes a
session-restore regression.** `session-restore-hybrid-focus.spec.ts` "two hybrid pages: the
page focused at save is the one restore raises (not the other)" fails on the SAVE side, before
restore runs at all — the snapshot marks the wrong window focused. Trace: opening the second
page reorders `order`, so `react` re-emits the full `SetStacking` replay; off darwin every such
native call can steal focus (`electron-window-backend.ts STACKING_TAKES_FOCUS`), so the backend
arms focus-suppression (`pendingStackingFocus`) for every window in the batch. The platform
provoked no focus for that batch, so all the armings survived, and the user's genuine focus on
the first page was then swallowed by a stale arming. Neither the focus event nor its kernel feed
fired, `order` never moved that page to the top, and `session.ts readKernelOrderFacts`'s
`topmost(state, isContentWindow)` read — what the session snapshot records as `focused` — stayed
on the other page. The rule-level statement: the suppression over-claims because `SetStacking`
carries no operation token, unlike the focus-family effects (`electron-window-backend.ts
pendingSelfCausedFocus`, above) — with only a bare boolean-per-window Set the backend cannot
tell its own echo from a genuine focus. Timing was tested as a discriminator and refuted —
across 617 stacking-provoked focuses, a microtask and a `setTimeout(0)` scheduled at arming time
had both already run before the focus arrived, so any dispatch-, microtask- or
macrotask-scoped arming would disable the suppression entirely. **Narrowing the suppression is a
dead end; shrinking the emission is the route.**

**Measured: the show/hide loop this shrink was meant to fix reproduces at 8.1%, not
deterministically.** `hybrid-overlay.spec.ts` "active handoff paints navbar for A, swaps to B,
clears on null" reproduces it with the minimal-stacking commit restored as an uncommitted probe
(`git revert --no-commit 7df51e2c`): 8 failures in 99 runs (8.1%), pooled from three batches
(1/9, 3/30, 4/60) against uninstrumented builds. Passing runs take ~6s; failing runs ~80s.
Earlier notes describing the loop as failing deterministically in ~11s, or roughly one run in
three, are superseded — those came from samples of three runs or fewer. The rate is
timing-fragile: a build with a file trace compiled in dropped it to 1 in 22, so measuring this
loop against an instrumented build measures the instrumentation, not the loop.

**The loop's shape, from a 412,894-line trace of one looping run set against nine healthy
ones.** It is a focus ping-pong between two content page-hosts, running at ~20ms per lap for
about 150ms before collapsing into a faster show/hide storm. Each lap: `OsFocusGained` on the
second host reorders `order`; `window-kernel.ts react()`'s rule that a focus report raises the
new key window emits `RaiseWindow`; `electron-window-backend.ts raiseWindow()` performs a
non-activating show; 2-3ms later the window manager hands focus to a different window — the
always-on-top chrome overlay, or the host that held focus a moment earlier — which arrives as a
world-caused focus, moves `key` again, and emits the next raise. The attach-target query flips
with it, so the overlay shows and hides every lap, and its always-on-top re-pin re-enters the
churn.

**The finding that matters, as a rule problem: `react()`'s raise-on-focus-report rule assumes a
platform that does not re-pick focus underneath a raise.** The rule rests on the fixed-point
argument in its own docblock ("WHY A FOCUS REPORT DRIVES AN OS RAISE AT ALL", point 2): the
raise makes its target the window in use, so the focus the OS echoes back names the window
`key` already holds, and the diff is empty — one correcting write, then silence. On a window
manager whose raise primitive re-picks the focus owner for the whole stack, that premise is
false: the focus a raise provokes routinely lands on some other window, and the rule becomes a
two-step cycle with the platform instead of a fixed point. Full stacking re-emission hid this —
all the focus stealing happens inside one synchronous `reassertStacking()` burst, leaving no gap
in which a re-pick can be observed as a separate `key` move. Minimal emission spreads the same
stealing across separate transitions and exposes it.

**Two more approaches measured against the loop, both closed out.**
- *Symmetric blur arming* — skip `electron-window-backend.ts armBlurSettle()` while a stacking
  batch is still awaiting its focus, testing `pendingStackingFocus` as a whole rather than per
  window (a batch provokes at most one blur, and it lands on whichever window held focus, which
  need not be a window in the batch): 4 failures in 90 runs against the 8-in-99 baseline —
  directionally better, never worse, but Fisher exact p ≈ 0.37, so unproven rather than refuted.
  It is the one candidate that did not make things worse, and the loop still happens under it.
- *Arming the show rather than the stacking* — a platform fact plus a one-shot arming set in
  `electron-window-backend.ts performOsShow()` on both branches, consumed by the first native
  focus on any window: 7 failures in 30 runs, clearly worse than baseline. Refuted.

**Also true, and not to be read as the loop's cause: the blur-arming asymmetry is a real
mechanism, but healthy runs absorb it too.** The chain — a native blur while a stacking arm is
live, the deferred settle check finding nothing focused, a focus loss reported for the key
window, a spurious focus regain, an extra raise — fires 4 times in the looping run and in 8 of
the 9 healthy runs, 1-6 times each; several healthy runs have more of these than the looping
one does. It is an event the healthy path absorbs without looping, not what triggers the loop.

**3b. Chrome overlay follow / retarget** — ABSORBED (§5 step 9, commit `1bdd1c11`).
The overlay-attachment relation lives in reducer state (`WindowRecord.overlayFor`);
`window-state.ts applyOverlayFollow` drives follow/retarget off `BOUNDS_CHANGED` and
`OS_FULLSCREEN_ENTERED`/`LEFT` for every registered window, reached through
`OVERLAY_ATTACH_REQUESTED`. `hybrid-overlay.ts` no longer drives the OS itself for this;
its own module-level `appActive` copy — the third copy of app-active — is also gone: the
module now reads `AppWindowState.appActive` through `getAppActive()`/`subscribeAppActive()`
(see the "FOLLOW is not wired here any more" comment at the old follow site in
`hybrid-overlay.ts`). **Former residue, now closed:** `hybrid-overlay.ts` `showInactive`
×1 (test bridge only) and `destroy` ×2 (singleton teardown) were allowlisted under §5 step
9; both are gone from `scripts/check-r2-window-ops.mjs` and from live code, commit
`a3f658cf`. A further `hybrid-overlay.ts` `focus` ×1 (address-bar-typing activation) was
allowlisted separately under §5 step 8, not this dimension; it is likewise closed, commit
`66c7958f`. **Not re-verified:** the original "40 live-query call sites" figure — the
mechanism it counted is gone, so the number is stale, and no replacement count has been
taken.

**Measured and CLOSED: the defect that gated the six window-operation patterns was never a
publish that failed to land.** It was a correct retarget undone one beat later. The measured
chain, end to end: hiding the front page-host lets the platform hand focus to another window
— on Linux the primary workspace window — and `electron-window-backend.ts` reported that
focus as fresh OS evidence, so `OsFocusGained` moved that window to the top of `order`.
`topmostBaseLayerPageHost` reads the topmost front-eligible record and requires it to BE a
page-host, so it answered null, `react`'s diff emitted `AttachOverlayTo(overlay, null)`, and
the chrome detached. The renderer had already received the new window's handoff and painted
it; the clear arrived ~10ms later, so the navbar read empty for the rest of the test.

Closed by arming the hide the same way `setStacking` is already armed
(`electron-window-backend.ts pendingHideProvokedFocus`): a focus the platform provokes as a
side effect of a native call the machine made is not evidence about what the user chose. The
six-pattern batch went 16-17 failed / 45-46 passed to 3 failed / 59 passed, and the 45-test
overlay file to 45 passed. The three that remain are unrelated and fail with the suppression
disabled too.

Two beliefs recorded here before the diagnosis were wrong and are corrected by it: the
publish does reach the renderer (verified by logging receipt inside the renderer's own
`page-overlay:active` subscriber), and the failure is not confined to a SUBSEQUENT publish —
a repeat of the same topic (`repeat Cmd+L (press 2)`) failed the same way, because what
breaks is the detach that follows, not the publish.

**The historical first-load subscription race** — `sendActiveHandoff`
publishing `page-overlay:active` before the renderer's module finishes loading and
subscribing — was real and is now closed (commit `c7e9f4a5`, `hybrid-overlay.ts
wireOverlayReady()` answering the renderer's own post-subscribe `page-overlay:ready`
declaration instead of the old `did-finish-load` re-send). Closing it was not the
bottleneck: the six-pattern batch (~62 tests) holds at 16 failed / 46 passed, same failing
names, across four full runs — including runs against profile names never used before,
which rules out profile and code-cache contamination as the explanation.

**The minimal-stacking commit is restored** on the strength of that reading (`93f46d9b`
reapplies what `7df51e2c` reverted). Against the bar set for keeping it: the show/hide loop
repro `hybrid-overlay.spec.ts` "active handoff paints navbar for A, swaps to B, clears on
null" passed 20 of 20 consecutive runs, and two consecutive six-pattern runs gave 2 failed /
60 passed and 3 failed / 59 passed against the 3 the head carried before it.

Its intended payoff landed: `session-restore-hybrid-focus.spec.ts` "two hybrid pages: the
page focused at save is the one restore raises (not the other)" — which failed 8 of 8 across
a prior A/B — passes in both runs. The over-large stacking replay was indeed what starved the
genuine focus, as predicted.

One name to watch, NOT confirmed: `hybrid-overlay.spec.ts` "back/forward unblocked: nav
drives the active content WC held through an overlay interaction" failed in the second batch
run and passed in the first, in every pre-restore run, and 6 of 6 in isolation. One failure in
two batch runs is an intermittent, not a regression — and by the trap stated below, the
isolated greens are not evidence either way. Measure it under the batch.

**The measurement trap, revised.** The first-load race's single-test repros did not
reproduce in isolation — 3 of 3 and 6 of 6 passed pre-fix — which is what made the full
batch the only trusted measurement. That is no longer true of this cluster: the retarget
failure reproduces in the 45-test `Hybrid Chrome Overlay` file on its own, and even as a
single test on its own, which is what made it tractable. Check the narrower run first; it
costs 1 minute against the batch's 5-8.

**4. Visibility lifecycle** — TO ABSORB. *(Top divergence risk #2.)*
Today: `WindowRecord.visible` (a mirror only) plus live `isVisible()` plus
`params.keepLive`. `closeOrHideWindow` and `tile:window:hide` hand-dispatch
`WINDOW_HIDDEN` because the OS event lags — a written admission that belief and reality
drift. `maybeHideApp` live-polls `isVisible()`.
Becomes: `visible` becomes authoritative, updated only by `shown` / `hidden` events;
app-hide is derived from reducer state, never polled.

**8b. Special window classes** — ABSORBED (§5 step 4). *(Was top divergence risk #5.)*
The window record carries a `class` field with a closed enum
(`primary | quick-view | overlay | palette | hud | background | bridge | extension-ui |
test-fixture | devtools`), declared at registration — `window-state.ts
classifyWindowRegistration` owns the ordinary-window rule; the infrastructure classes
are declared by their glue modules. `main.ts mainWindow`/`backgroundWindow`,
`core-glue.ts coreBackgroundWindow` and `test-fixture-glue.ts testFixtureWindow` are
deleted — their accessors are lookups by class (`window-state-singleton.ts
getNativeWindowByClass`). The HUD-sniffing predicate (`isAlwaysOnTop() &&
!isFocusable()`) and the `__hudHidden` expando are deleted: the reducer's
APP_RESIGNED/APP_ACTIVATED clauses sweep class-`hud` records (a `hiddenByAppBlur`
record flag) via HIDE_WINDOW/SHOW_WINDOW effects. The chrome-extension
`extensionUiWindows`/`_bridgeWindows` Maps REMAIN as extension-identity indexes
(keyed by runtimeId/page — content-side identity, like the hybrid registry), but
every window in them is a registered class-tagged machine record and all their
window OPS route through the machine. **Survey corrections:** `tile-lifecycle.ts
bgWindow` was wrongly listed here — it is a `{tileId, entryId}` identity latch, not
a window handle; `tray.ts tray` is a Tray, not a window. Neither is WM state.

### 4.4 Focus and routing

**9. Menu / shortcut target resolution** — TO ABSORB.
Today: **three coexisting answers** to "which window" —
`BrowserWindow.getFocusedWindow()` (still live in `entry.ts` and `tile-ipc.ts`),
`getIzuiCoordinator().getFocusedWindowId()`, and `getFrontWindowId()`.
Becomes: `getFrontWindowId()` only, backed by the reducer. Delete the other two paths.

**5b. Restore focus guard** — ABSORBED (§5 step 8b, deleted outright).
Was: `izui-state.ts restoreFocusGuard` with `setFocusedWindow` / `getFocusedWindowId` —
a **rival focus authority**. *(Top divergence risk #4.)*
Now: nothing. The guard, `beginRestoreFocusGuard`/`clearRestoreFocusGuard`, and
`session.ts`'s restore-time arm are gone; restore focus determinism lives in the
machine's `front` (driven by restore's machine-routed show dispatches).
`setFocusedWindow` / `getFocusedWindowId` remain as a plain tracker until step 8c
deletes them.

**4b. Transient-sibling autoclose** — ABSORBED (§5 step 9 cutover).
Was: `ipc.ts closeTransientSiblingsOnFocus` (+ `gatherTransientSiblingCandidates`,
`izui-roles.ts selectTransientSiblingsToClose`) plus a `pendingAppResignClose` timer with a
`did-become-active` cancel; it fired on focus change and closed windows behind the reducer's
back. All deleted.
Now: `selectTransientAutoclose` on `OS_FOCUS_GAINED` and `selectAppResignTransients` on
`APP_RESIGN_SETTLED`, both dismissing through the shared keepLive decision
(`HIDE_WINDOW`/`CLOSE_WINDOW`, never `DESTROY_WINDOW` — a keepLive slide must survive, peek
2c94c125). The timer was deleted, not ported: its CANCEL is now reducer state
(`pendingAppResignSweep`, armed by `APP_RESIGNED`, disarmed by `APP_ACTIVATED`). What
remains irreducible is the settle DELAY — macOS offers no "the resign→become dance is over"
signal — so it sits at the OS boundary as `electron-window-backend.ts
APP_RESIGN_SETTLE_MS`, which only says "500ms elapsed" and never decides the sweep. The one
piece still unmodelled is the izui overlay entry/exit cooldown, read at that producer to
suppress the settle EDGE; re-home it when the cooldown becomes machine state.

**6. Roles + session tri-state** — TO ABSORB (partial).
Today: `izui-state.ts IzuiStateCoordinator`. The role string is duplicated into
`windowRegistry.params.role`, `tile-launcher.ts tileWindowInfo`, and `WindowRecord.role`.
`appFocused` is the third copy of app-active.
Becomes: `role` lives once on the window record; app-active lives once as the reducer's
`appActive`. The session tri-state (`idle`/`transient`/`active`) is the **only** thing
`izui-state.ts` keeps, mirrored one-way into the reducer via `SESSION_CHANGED`.

**6b. Role-derived policy** — OWNED, KEEP AS IS.
`izui-roles.ts` pure predicates. Well-owned. The reducer calls them.

### 4.5 Persistence

**5. Session save / restore** — TO ABSORB, LAST.
Today: an on-disk `SessionSnapshot` / `WindowDescriptor` plus **12 module-level lets** in
`session.ts`. It drives the OS directly without telling the reducer.
Becomes: serialization of reducer state, and restore becomes a sequence of dispatched
events. `session.ts` computes no window decisions.

**5c. Closed-window undo stack** — KEEP.
`main.ts closedWindowStack`. Single owner, no rival. Fine as is; it may move into the
reducer for tidiness but nothing is broken.

### 4.6 Deferred / adjacent

**4c. Deferred / lazy content load** — TO ABSORB (partial).
Today: `hybrid-page-host-registry.ts` deferredLoad plus **four parallel side Maps**.
Becomes: a `contentPhase` field on the window record (`deferred | loading | loaded`); the
side Maps collapse into it. Content *policy* (what to load, when it's worth loading) may
stay outside; window lifecycle does not.

**8a. Devtools windows** — ABSORBED (§5 step 4).
A global `web-contents-created` listener (main.ts) registers the detached devtools
window (when one exists — attached mode has none) with class `devtools`, satellite,
parented to its host — so closing it hands `front` back via the parent-refocus
transition — and dispatches `DEVTOOLS_OPENED`/`DEVTOOLS_CLOSED` for the host on both
edges. Both events invalidate AND re-drive the front assertion in the same transition
(the machine form of the old scattered "re-focus the content window around devtools"
handlers). Deliberate carve-out: OS focus landing ON a devtools-class window does NOT
clear the assertion — otherwise the derived Esc grab would switch on and eat every
Esc typed inside devtools (parity with the pre-registration behavior).

**11. WebContents ↔ window mapping** — DONE (the id-space part).
`webview-guest-registry.ts guestToHost` now maps guest webContents id → host `WindowId`,
so a host reference can no longer be confused with a numeric webContents id.
`hybrid-editable-focus.ts editableByWcId` and `tile-ipc-gate.ts perWcOriginalSend` remain
keyed by webContents ids, which is correct: their keys are genuinely content-side and
their values hold no window ids, so no window-id collision exists in them. Their
*content* concerns are not the WM's business.

**10. Per-window context / mode** — OUT OF SCOPE (but re-key — deliberately deferred).
`datastore.ts windowContextState`, keyed by window id plus a `null` key for global. This is
application content state, not window management. It stays where it is; it still speaks
numeric Electron window ids today (converted at the seams via `window-state-singleton.ts
getWindowIdFor()` / `getNativeWindowFor()`), and adopting the WM id space is deferred to
the session/context-store step (§3 scope decision). It must be told when a window dies.

**Window identity (`options.key`) — IN SCOPE, NOT MODELLED. The one piece of window policy
with no state machine behind it.** A feature declares a window's identity by passing a `key`;
that key decides whether an open creates a window or returns an existing one. Deciding whether
a window exists is squarely the WM's mandate (see the paragraph below), but the kernel has no
notion of a key at all — `window-kernel.ts` never reads one, and `key` inside the kernel means
the key window, an unrelated concept. The decision lives instead in `ipc.ts windowOpenHandler`
as a guard chain over three lookups, reached only by the caller; the kernel first hears about it
as a `WINDOW_SHOW_REQUESTED` on a window it already knows.

The two key spaces disagreed until 2026-08-20, which was the symptom of having no owner:

- `main.ts findWindowByKey(source, key)` matches on `source` AND `key`, and
  `windowOpenHandler`'s own race guard `pendingWindowKeys` is qualified the same way
  (`${msg.source}:${options.key}`).
- `hybrid-page-host-registry.ts findHybridWindowByKey(key)` matched the bare key, and
  `registerHybridWindow` stored it unqualified — one global space in which two features
  passing the same key string collided, the second open refocusing the first feature's window.
  Now fixed: the registry records the opening `source` beside the key and the lookup compares
  both, with three cross-source cases added to `hybrid-page-host-registry.test.ts`, which had
  exercised a single source only.

A related defect fell out of the same reading: `session.ts restoreSessionSnapshot` opened every
restored window under a hardcoded `WEB_CORE_ADDRESS`, discarding the `descriptor.source` it
persists, so a restored keyed window landed in a namespace its owning feature never looks in and
that feature's next open produced a duplicate. It now passes the persisted source back.

A third rule sits beside them: the generic URL dedupe (`findWindowByUrl` /
`findHybridWindowByUrl`) is gated on `!options.key`, which is the only thing keeping a
key-declaring feature out of an unrelated window that happens to hold the same URL — a guard
that reads as a dedupe detail rather than as the rule it enforces.

Absorbing this means the machine owns identity: a key is qualified by its declaring feature,
resolution is one transition rather than a guard chain, and reuse-versus-create is a state the
kernel can be asked about. Engine work, deliberately deferred — the two defects above were fixed
in place first, so what remains is ownership, not correctness.

**Decided: a key-reuse shows the existing window and does not navigate it.** The hybrid key-reuse
branch shows and focuses the existing window WITHOUT navigating it, so a feature that changes the
address behind a key does not move that key's open window — editing a peek slot's address in
settings leaves that slot's open window where it is. This is the standing behavior and it stays.

The reason it is not a defect to patch: peeks want exactly this for `keepLive` / `persistState`,
and a user may browse inside a peek, so "reopen shows the configured address" would silently undo
their navigation. Telling a settings-side address change apart from ordinary in-window browsing
needs feature-side memory of the previous address, which no feature carries today. Revisiting this
means adding that memory first — the fix is in the feature, not in the reuse branch, and changing
the reuse branch alone would trade a surprising non-update for a worse surprising update.

**Peek / slide content features** — EXPLICITLY OUT OF SCOPE. What a peek *shows*, how a
slide *animates its content*, what the switcher *lists* — none of that is window
management. The WM owns whether those windows exist, where they are, what is front, and
what Escape does. It owns nothing about what is inside them.

---


### 4.3.1 The overlay Playwright file is a race, and single runs of it are not evidence

`apps/desktop/tests/desktop/hybrid-overlay.spec.ts` (45 tests, the `Hybrid Chrome Overlay`
patterns) does not settle to a stable failing set. Measured on Linux under
`scripts/playwright-with-display.sh`, six consecutive runs at the head that carries
`window-kernel.ts react`'s minimal stacking replay produced **one clean run**; five runs of the
same file with that stacking commit reverted produced **two**. Both trees lose roughly one test
per run, and the tests they lose are disjoint:

| test | with minimal stacking replay (6 runs) | with it reverted (5 runs) |
|---|---|---|
| `back/forward unblocked: nav drives the active content WC` | 3 | 0 |
| `Cmd+F forward (page:find) opens the overlay find bar` | 2 | 0 |
| `clicking the chrome (overlay focus on content blur) does NOT deactivate` | 1 | 0 |
| `trigger-zone → navbar move keeps the chrome open` | 1 | 0 |
| `follows the active host window move/resize (focus-free)` | 1 | 0 |
| `retarget is focus-free: overlay frames A, then B, then hides on null` | 0 | 1 |
| `maximize snaps to work area; restore returns to prior bounds` | 0 | 2 |

**Two consequences.** Narrowing the stacking replay does not cleanly cause any single failure —
it changes which test loses a race both trees lose. And a single run of this file, green or red,
is worthless in either direction: a green run has been observed on a tree whose next run failed
twice. Measure it in batches of at least four and compare failing SETS, never counts.

`back/forward unblocked: nav drives the active content WC held through an overlay interaction`
is the strongest single lead — 3 of 6 with the narrowed replay, 0 of 5 without — and it is in
neither list in `apps/desktop/tests/gate-baseline.md`.

The mechanism to check first, stated so it can be refuted: the narrowed replay stops emitting
`SetStacking` for the shared chrome overlay (alone in the pinned band) and for any window below
the mover. On Linux each `SetStacking` also armed a `pendingStackingFocus` entry in
`electron-window-backend.ts setStacking`, which suppressed a platform-provoked focus; with those
armings gone, and `electron-window-backend.ts pendingHideProvokedFocus` being a single one-shot
boolean, a focus handed to a non-page-host can survive as `OsFocusGained`, after which
`window-kernel.ts topmostBaseLayerPageHost` answers null and `react` emits
`AttachOverlayTo(overlay, null)`, detaching the chrome. Against it: the failing runs show the
renderer demonstrably ready (`tests/helpers/hybrid-page.ts waitOverlayReady` succeeds and the
"overlay renderer never became usable" diagnostic never appears), and the detach has never been
observed. Reading the whole `overlayChromeState()` at the poll inside a full-file run settles it
— `noActive: true` confirms the chain, a correct `url` refutes it.

#### The stated mechanism is REFUTED, and the macOS failure is a missing detach

Measured 2026-08-18 on macOS, packaged, three batches (4 + 4 + 6 runs) at the tip carrying the
`SeedMaximized` fix. Failure counts per run: 1,1,0,0 · 0,0,0,1 · 3,3,1,0,2,2. Every failure in
every batch, across four different tests, is **one signature**: a test that ends with
`b.setActive(null)` and polls for the chrome to clear finds `noActive: false` and holds it for the
full 10s timeout. It never recovers, so it is a stuck state and not a slow one.

Instrumenting those polls settles the mechanism. The bridge grew `attachDiagnostic()`
(`hybrid-overlay.ts installTestBridge`), which reports the kernel records the attach query reads;
the polls now carry it, and assert `attached: null` alongside `noActive: true`. At the failing
poll:

- `attachedTo` is **non-null** — the kernel still has the overlay attached to a host.
- The most recently activated page host is still `visible: true, orderable: true, layer: 0,
  role: 'content'` — fully `isBaseLayerPageHost`, so `topmostBaseLayerPageHost` correctly answers
  it and `react` correctly emits no detach.
- The host activated BEFORE it is `visible: false`, correctly drained.

**That refutes the mechanism proposed above.** The proposal was a spurious *detach*:
`topmostBaseLayerPageHost` answering null, `AttachOverlayTo(overlay, null)`, chrome detached,
`noActive: true` where a url was expected. The measured failure is the exact opposite — a *missing*
detach, with `noActive` stuck at `false`. The renderer, the handoff delivery and the
`SetStacking`/`pendingStackingFocus` chain are all exonerated for this failure: no message was
dropped, because no message was ever due. The kernel's view is self-consistent throughout.

So the defect is upstream of the overlay entirely: after `setActive(null)`, a base-layer page host
is still visible in the kernel that the bridge's drain was supposed to hide. Note also that the
four affected tests span different `describe` blocks and therefore different app instances, so
this is one defect and not a per-test staging bug.

#### Resolved: an unguarded native `'show'` echo re-showed a window the drain had cleared

Measured 2026-08-18 on macOS, packaged. The state snapshots had said all they could — they agreed
run to run — so the probe that settled it was an **event and effect timeline at the drain**:
`window-kernel-executor.ts recordTimeline` logs one line per APPLY, in applied order, carrying the
event, the `key` delta, the effects `react` emitted, and every base-layer page host's visibility.
`hybrid-overlay.ts installTestBridge` marks each drain (`markTimeline`) and exposes the log
(`kernelTimeline()`), which the deactivation polls now carry alongside `attachDiagnostic()`. A
failing poll reads:

```
#41 --- setActive(null) drain=[wm-7]
#42 WindowHidden(wm-7) key=wm-7 eff=[AttachOverlayTo,HideWindow(wm-7),RaiseWindow(wm-4)]
#44 WindowHidden(wm-7) key=wm-7 eff=[-]
#47 --- setActive(null) done
#48 WindowShown(wm-7)  key=wm-7 eff=[AttachOverlayTo,ShowWindow(wm-7),SetStacking(wm-7)]
#49 OverlayAttached    key=wm-7 eff=[ShowWindow(wm-1),SetStacking(wm-1)]
```

The drain completes correctly and leaves the kernel consistent at `#47`. `#48` is a **stray
`WindowShown` arriving after it** — AppKit delivering the `'show'` notification provoked by the
EARLIER activation's `ShowWindow(wm-7)`, lagged past the hide. `react` reads it as a genuine
`visible: false -> true` flip, re-emits the whole show-shaped effect set, and `AttachOverlayTo`
puts the chrome back on a host the drain had just cleared. Nothing detaches it afterwards, because
by the kernel's own reading nothing is wrong — which is why the failure is stuck rather than slow.
Whether the lagged notification lands before or after the drain is what the roughly one-in-two
rate was.

**The drain itself is exonerated**, and so is the successor-raise mechanism proposed above it: the
raise `#42` emits names `wm-4`, not a record later in the drain, and `isContentWindow` requires
`visible`, so a drain cannot re-show its own members. That proposal is refuted too.

The fix is the exact mirror of a guard the same file already carries.
`electron-window-backend.ts`'s `win.on('hide')` validates against native ground truth before
echoing (`if (!win.isDestroyed() && win.isVisible()) return;`) — added for the peek `71cfde09`
lagged-notification class on the hide side. `win.on('show')` directly above it had none, so the
show half of the same lag class went straight into the machine. It now reads
`if (win.isDestroyed() || !win.isVisible()) return;`: a destroyed window is never shown, which is
why the `isDestroyed` arm points the opposite way from the hide side's.

Measured A/B, packaged macOS, `hybrid-overlay.spec.ts` (45 tests), failing SETS not counts:

| | Runs | Failing sets (spec line) |
|---|---|---|
| Before | 4 | `{1054}` · `{1054}` · `{784, 1054, 1829}` · `{784, 1054, 2253}` |
| After | 6 | all clean |

`1054` ("notes pane … clears on null") failed 4/4 before and 0/6 after, so the proof is
failing-first on a deterministic case rather than on a rate. `784` (2/4 before), `1829` and `2253`
(1/4 each) also cleared.

The timeline is E2E-only (`process.env.E2E_TEST === 'true'`), bounded at 400 entries, and reads
only already-computed snapshots — the same contract as `logTransition` beside it. It stays in the
tree: it is the tool that answers "which transition put the kernel here", which no state snapshot
can.

#### Resolved: an unowned hide-provoked-focus arming swallowed a genuine focus

Measured 2026-08-18 on macOS, packaged, with the same timeline. This is the
`session-restore-hybrid-focus` intermittent, and it is neither intermittent nor restore-side. At
the current tip it fails **5 of 6 runs** (the "roughly one in four" recorded earlier predates
`pendingHideProvokedFocus`), and it fails at SAVE: after the spec focuses page A, the session
snapshot names page B focused. `key` is simply on the wrong window before restore is ever reached.

`electron-window-backend.ts`'s `win.on('focus')` declines to report a focus while
`pendingHideProvokedFocus` is armed, on the reasoning that the platform reassigned focus as a side
effect of a hide the machine asked for. The timeline's last line at the failure is the whole
finding — a **recorded absence**, which is why no state snapshot could have produced it:

```
#27 OverlayAttached    key=wm-7 eff=[HideWindow(wm-1)]
…
#35 --- focus suppressed hide-provoked wm-6 cause=world
```

`wm-1` is the chrome overlay, hidden by an ordinary overlay retarget; `wm-6` is page A. The
arming was set by **every** hide, with no owner and no expiry — so a hide of a window nothing was
focused on, which reassigns nothing and therefore provokes no focus, left it armed indefinitely.
The next focus to arrive was the user's genuine one (`cause=world`), and it was dropped.

The fix gates the arming on the hidden window actually holding focus
(`this.pendingHideProvokedFocus = this.isFocused(win)`), which is the mechanism the rule's own
comment describes. Note what this means headless: nothing holds real OS focus there, so the arming
never sets — correct, because nothing is reassigned there either.

Measured A/B, packaged macOS, `session-restore-hybrid-focus.spec.ts`:

| | Runs | Result |
|---|---|---|
| Before | 6 | 5 failing (and 5/6 failing again with the `'show'` guard reverted, so that fix is neither cause nor cure) |
| After | 6 | all clean |

**Half of this rule remains unproven and only a live macOS gesture can settle it.** When the
FOCUSED window is hidden, does macOS reassign focus at all? The rule was derived on Linux, where
the window manager does. If macOS does not, the arming still outlives its provocation and still
swallows the next genuine focus — far more rarely now, but by the same mechanism. That is check 12
of `docs/design/window-manager-macos-signoff.md`, which predicted this failure in writing before it
was measured, and which is now narrowed to that remaining half. There is **no automated coverage of
the rule at all** — `pendingHideProvokedFocus` appears in no spec.

#### Resolved: an untokened visibility echo let `AttachOverlayTo` and `HideWindow` alternate forever

Measured 2026-08-19 on macOS, packaged, found by check-driven live use during the macOS sign-off
run (`docs/design/window-manager-macos-signoff.md`) rather than by any spec, and invisible to both
the full ~3200-test suite and to every Linux run. `sample` on the hung main process showed the
entire thread (6678/6678 samples) inside one synchronous JS call from `node::Environment::RunTimers`,
repeatedly in `-[NSWindow _doOrderWindow:]` -> `_reallyDoOrderWindowOutRelativeTo:` ->
`_doWindowWillBecomeHidden`, entered via `windows.ts` `askWebContentsToHandleEscape`'s 500ms
renderer-answer timeout.

**Reproduction.** Two hybrid page hosts open on real `http://` URLs, plus a peek opened through the
peeks feature (`features/peeks/background.js` `executeItem`, `role: 'quick-view'`, `modal: true`,
`pageHost: true`), then ESC to close the peek. It terminates only when no base-layer page host
survives (`topmostBaseLayerPageHost` returns null), which is why two hosts are required.

**Mechanism.** Closing the page host the shared chrome overlay was attached to, while a sibling
base-layer page host survives, made `react` (`window-kernel.ts`) emit both `AttachOverlayTo`
(retargeting the overlay to the survivor) and `HideWindow` (detaching from the closing host) in one
transition. Each performed a real native call and queued its own confirming echo
(`WindowShown`/`WindowHidden`). Neither Electron backend echo carried a token identifying which op
it belonged to, so the hide's echo could be applied after the attach's echo had already re-shown the
overlay — read as fresh evidence, so `react` re-emitted `HideWindow`. The two alternated forever:
`window-kernel-executor.ts` `pump`'s FIFO has a re-entrancy latch but no depth limit, so it ran as
one unbroken synchronous call inside a timer callback.

**The fix** (commit `0bd49c7d`): visibility ops carry an `opSeq` token; `WindowKernelExecutor.apply`
drops a `WindowShown`/`WindowHidden` whose `opSeq` is older than the record's `lastOpSeq`. An event
with no `opSeq` is never treated as stale — the same "absent means don't judge" reading
`OsFocusGained`'s missing `cause` already gets. The token had to reach the native
`win.on('show')`/`win.on('hide')` listeners too, not only the synthetic echoes: on this backend a
`BaseWindow`'s native show/hide can fire before the provoking call returns, so tagging only the
synthetic echo left the loop fed.

This is the fourth instance of this document's recurring shape, a fact reaching one machine or
owner and not the other: the restore-time maximize seed reaching the old machine and not the kernel
("The restore-time maximize seed never reached the kernel" above), the unguarded native `'show'`
echo reaching `win.on('hide')`'s ground-truth check and not its sibling `win.on('show')`
("Resolved: an unguarded native `'show'` echo re-showed a window the drain had cleared" above), the
hide-provoked-focus arming reaching every hide and not only the one it was armed for ("Resolved: an
unowned hide-provoked-focus arming swallowed a genuine focus" above), and now a visibility token
reaching the synthetic echo and not the native listener that could arrive first.

**Regression:** `apps/desktop/tests/desktop/hybrid-close-two-hosts-hang.spec.ts` (commit
`0230c9e8`) bounds transitions after the close: 53 before the fix, 2 after.

#### Three producers of a machine focus reported it as the world's — real, but NOT defect A's cause

**This section previously claimed to resolve defect A. It does not.** The fix below is a genuine
missing-provenance defect and is unit-proven failing-first, but the live repro on 2026-08-21
showed the every-other-press symptom **surviving it unchanged**, so it was never the cause. The
title and framing were written from unit evidence before any live reproduction — the exact failure
mode `apps/desktop/CLAUDE.md` records for this bug class, where a green headless suite gave false
confidence twice on a focus bug and only a live trace found the cause.

What the live run established about A's real mechanism is recorded under "Defect A: the peek is
destroyed inside its own `loadURL`" below. Notably, it is not yet established that the KERNEL
decides that dismissal at all: `window-state.ts` is still live alongside it, and every close path
in the build is DEBUG-gated, so no log names the deciding arm.

**Mechanism.** `window-kernel.ts` `selectTransientAutoclose` spares a transient whose `openSeq` is
newer than the focuser's, so a raise cannot dismiss a window opened after the op that provoked it.
That carve-out is deliberately armed only by a `machine` cause: a genuine world focus — the user
clicking another window — should sweep everything eligible. But no production path was delivering a
machine cause, so the floor was `null` for every focus report the kernel ever saw.

Pressing the peek hotkey with a live predecessor: the new peek takes key and sweeps the older one
(correct — it is a transient and the focuser is newer). The older peek's `WindowClosed` makes
`react` emit a successor `RaiseWindow` for the surviving content window. That raise's
`OsFocusGained` carried no cause, so the floor stayed disarmed and the sweep it triggered admitted
the just-created peek, still inside its own `loadURL`. Net effect: the press appeared to do nothing,
and the next press — with no predecessor to sweep — worked.

**Three producers, one missing fact.** This is the document's recurring shape again — a fact
reaching one machine or owner and not the other — but with three sites rather than one:

- `window-kernel.ts` `decide`'s `RaiseWindow` arm manufactured `OsFocusGained` from a COMMAND, the
  most unambiguously machine-caused focus there is, and stamped no cause. It now carries
  `{ kind: 'machine', opSeq: state.opSeqCounter }`.
- `window-kernel-shadow.ts` `shadowKernelOsFocusGained` dropped the cause on the floor.
  `electron-window-backend.ts`'s `win.on('focus')` listener already computes it (`takeFocusCause`,
  consuming the `pendingSelfCausedFocus` arming a focus-family native call left) and hands it to the
  OLD machine's `OS_FOCUS_GAINED` — the kernel simply was not told. Both focus listeners now pass
  the same value; `takeFocusCause` is one-shot, so the already-consumed local is reused rather than
  read twice.
- `window-kernel-shadow.ts` `shadowKernelWindowShown`'s companion focus for an activating show
  stamped nothing either. It now carries the show's own `opSeq`, and stays `world` when the caller
  reported no token.

**A second, silent consequence.** `WindowKernelExecutor.apply`'s stale-self-echo guard
(`isStaleSelfEcho`) drops a late `machine` echo that would otherwise steal focus back from a window
the user has since moved to. It only judges events that carry a cause — so with no production
producer stamping one, that guard was matching nothing live, exactly the "correct in form, matching
nothing in practice, green tests passing vacuously" shape §4 warns about. It is now reachable.

**Regression:** in the main-process unit suite; it drives `decide`'s `RaiseWindow` command rather
than calling `selectTransientAutoclose` directly, because the pure selector's machine-cause
behavior was already covered and passing — the gap was that nothing proved a raise DELIVERS a
machine cause.

#### Defect A: the peek is destroyed inside its own `loadURL`

Live repro, 2026-08-21, macOS, `PROFILE=signoff-a` with two hybrid page hosts (ALPHA, BRAVO) open
on `http://` URLs and Peek frontmost. The peek hotkey was pressed repeatedly; each press published
`cli:peek-open keyNum=0` and ran `features/peeks/background.js` `executeItem` exactly once.

**Every peek opened in the run was dismissed.** The presses that "work" and the presses that "fail"
differ only in WHEN:

- working press — the peek is shown, then vanishes ~0.9-1.3s later;
- failing press — the peek is destroyed ~90ms after construction, *while `ipc.ts`
  `windowOpenHandler` is still awaiting `view.webContents.loadURL(url)`*. The `publish(...,
  'window:opened', { id: baseWin.id, ... })` immediately after that await then throws `Object has
  been destroyed`, and the renderer receives `{success:false}`. The window never reaches
  `Opened BaseWindow`.

So the alternation is not a rule firing every other time — it is a constant dismissal racing a
variable page-load latency. The visible "flash", and the sibling page host appearing to reload, are
the same event: on a failing press the legacy stack thrashes ~45 times in 90ms between the surviving
page host and the doomed peek, against 9 divergence lines across a working press's entire life.

**Ruled out by the same trace:** key reuse and the `pendingWindowKeys` race guard in
`windowOpenHandler` — every open minted a fresh id, none returned `reused:true` or `id:null`.

**Not yet established: which machine decides the dismissal.** `window-state.ts` runs alongside the
kernel, and both have a transient-dismissal path — the reducer's `pushCloseOrHide` (fed by
`selectTransientAutoclose` or by the `APP_RESIGN_SETTLED` arm's `selectAppResignTransients`) and
`window-kernel.ts` `react`'s `DismissWindow`. Every close-path log in the build is DEBUG-gated and
`DEBUG` is off, so no log names the arm, and `DEBUG=1` cannot be used here because it fans detached
devtools across internal windows and poisons focus observation. Settling it needs unconditional
logging at `pushCloseOrHide`, the executor's `DismissWindow`, the app-activation dispatches in
`electron-window-backend.ts attachAppListeners`, `windows.ts closeOrHideWindow`, and either side of
the `loadURL` await.

**A separate defect the same trace surfaced:** opening one peek minted TWO kernel windows, and the
extra one never leaves the kernel's membership for the rest of the process. The same shape appears
when a page host opens. `ipc.ts`'s tile-launch path registering each window twice is the suspected
seam.

### 4.3.2 Two Linux-only spec failures, explained

Both are listed in `apps/desktop/tests/gate-baseline.md` as deterministic Linux failures, and
neither is a defect in the window kernel.

`hybrid-close-shortcut.spec.ts` "getFocusedWindow() is null while a hybrid host is the active
window" — at the moment the spec probes, Peek's settings window is already visible AND focused,
so `BrowserWindow.getFocusedWindow()` answers it rather than null; the window the spec creates is
not involved. `scripts/playwright-with-display.sh` unsets `HEADLESS` on Linux, so windows take
real OS focus here, and the spec's premise — that a headless run grants none — is a macOS fact
this platform cannot reproduce. The close path itself reads kernel state only:
`windows.ts resolveFocusedWindowIdForClose` calls no Electron focus API.

`hybrid-transient-on-blur.spec.ts` "opening (focusing) a second hybrid quick-view closes the
first" — the spec fails on its precondition, before it fires any focus. Measured: after opening
the first quick-view it is alive; after opening the second, **the first is already gone**. That is
the current rule working — opening the second moves attention to it, `lastAttention` changes, and
`window-kernel.ts selectTransientAutoclose` dismisses the first. The spec's staging assumes the
retired machine, in which opening granted no attention. On macOS
`electron-window-backend.ts STACKING_TAKES_FOCUS` is false, no stacking-provoked focus arrives,
and the first quick-view survives to the synthetic focus — which is why this fails only on Linux.

**"Only on Linux" is no longer true at this tip.** Measured 2026-08-18, packaged macOS: this test
fails 4/4 runs here, with the identical precondition signature (`hybridAlive(a)` is already false
at the line after opening the second quick-view, before the spec fires any focus). A/B'd against
the `pendingHideProvokedFocus` gate landed the same day — 3/3 failing with that gate reverted — so
the platform difference this paragraph records closed for some other reason, and the failure is
now cross-platform rather than a Linux artefact. `apps/desktop/tests/gate-baseline.md` still lists
it as a Linux failure and needs the same correction. The explanation above of WHY it fails (the
current attention rule working; the spec's staging assuming the retired machine) is unaffected —
only the claim that macOS is exempt is wrong.


## 5. Migration sequence

Ordered so the highest-regression-risk area lands last. **Each step deletes its old
authority in the same commit. Nothing runs in parallel with its replacement — that is the
failure mode this document exists to prevent (§2).**

1. **Id space — DONE** (commits 90becfc5, 5d760baf, 04d2eb94). Branded-string `WindowId`
   (`"wm-N"`), minted only by `window-os-adapter.ts registerWindow()`; the reducer, the
   adapter, and `window-state-singleton.ts` are re-keyed to it; the synthetic ids are
   deleted grep-zero; `guestToHost` holds `WindowId` values. The renderer-facing id
   economy deliberately stays numeric until the session/context-store step (§3 scope
   decision).
2. **The port — DONE** (commit 84ce45b4). `window-backend.ts` defines the command+event
   `WindowBackend` port — surface limited to what the executor issues today (raise,
   focus-content, fullscreen drive + reconcile, close-or-hide, the renderer Escape ask,
   the Escape grab and per-window interceptor, app-activation listeners); the rest of the
   §3 table arrives with the steps that need it, never speculatively.
   `electron-window-backend.ts ElectronWindowBackend` implements it and is the only
   window-manager module importing Electron: it holds every native handle, mints
   `WindowId`, translates native events into the machine's event vocabulary through the
   one injected `BackendEventSink`, and owns the two boundary settles (deferred-blur §4.4,
   bounded fullscreen §2.3). `window-os-adapter.ts` lost its Electron imports in the same
   commit — its `runEffect` now issues port commands only. Handle-carrying registration
   and the numeric-id seam survive as comment-annotated shims
   (`electron-window-backend.ts BackendMigrationShims`) — the registration shim until
   window CREATION moves behind the port (`create(spec)`, still future work after step
   4), the id seam until step 11. The R2 check's exempt file swapped to the backend in
   the same commit.
3. **R2 enforcement check — DONE** (commit b3853bee). `scripts/check-r2-window-ops.mjs`
   runs in the `test:desktop:electron` chain (`apps/desktop/package.json`), with a
   51-entry comment-annotated allowlist covering 129 legacy window-op call sites, each
   entry tagged with the migration step that deletes it; the sole exempt file is the
   executor — swapped to `apps/desktop/main/electron-window-backend.ts` when the port
   landed (step 2), since that is where the native calls now live. The allowlist only
   ever gets shorter; a PR that lengthens it fails.
4. **Special window classes + registry unification — DONE** (commit fa004fbe). The
   window record carries the closed `class` enum (§4.3 dim 8b); every window registers
   (bridge, extension-UI, core background, test fixture, detached devtools);
   `windowRegistry` is deleted with the machine table as the one registry (§4.1 dim
   1a); `__hudHidden` + the always-on-top sniffing predicate are deleted (reducer
   APP_RESIGNED/APP_ACTIVATED sweeps); the `browser-window-created → 'closed' →
   parentWin.focus()` block became the reducer's parent-refocus transition
   (registration-declared `parentId`); the port grew the close/destroy/show/hide/pin
   command family (`closeWindow` guest-safe close, `destroyWindow`, `closeContent`,
   `showWindow`, `hideWindow`, `pinAlwaysOnTop`, `destroyAllContentGuests`); the R2
   allowlist shrank 51→40 entries / 129→104 calls. NOT absorbed here (deliberate):
   handle-carrying registration itself — `create(spec)` is still future work, so the
   `registerWindow` migration shim stays until window CREATION moves behind the port.
5. **Z-order / stacking — DONE** (commits 693816ab, 9302478d, c18e361b). This is what lets
   `SET_STACKING` land wherever the reducer's own raise/focus decisions already point
   `front` (§6); it precedes session restore as planned.
   **Part A — machinery** (commit 693816ab). The reducer carries a per-record
   stacking level (`window-state.ts deriveStackingLevel`: `stacked` participates,
   `pinned` = hud/overlay/palette above the stack via the existing `SET_ALWAYS_ON_TOP`,
   `excluded` = the other satellites) and the ordered list
   (`AppWindowState.stackOrder`, bottom→top; membership = stacked ∧ visible;
   `stackOrderInvariantHolds` checks it). `SET_STACKING` is the new SOLE ordering
   effect (relative order only — activation stays `RAISE_WINDOW`), emitted by
   `applyRaiseRequest` alongside the raise it drives, so the machine's own
   front-driving now also drives order and places `front` at the top of the list. The
   page-host orderability caveat (an NSWindow no-ops raises until first composited
   frame) is the `WINDOW_CONTENT_ORDERABLE` event: it marks the record orderable and
   re-drives `SET_STACKING` for the window and everything above it — no timer, no
   poll. Port command `window-backend.ts setStacking(id)`, implemented in
   `electron-window-backend.ts` as the native relative raise (`moveTop`).
   **Part B — caller cutover** (commit 9302478d). `session.ts`
   (`reassertColdStartFocusOnce`, `reassertStackingOrder`, the willActivate restack
   loop) and `hybrid-overlay.ts` are routed through the machine; both legacy
   `moveTop` R2 allowlist entries are deleted (allowlist now 38 entries / 95 calls).
   **Live-run fix** (commit c18e361b): an `OS_FOCUS_GAINED` that landed on `front` must
   mirror what the OS already did (`applyOsFocusRealized`, §6), not echo an activating
   raise back at it — echoing it caused a perpetual multi-tile focus ping-pong at
   frontmost restore.
6. **Visibility.** Make `visible` authoritative; delete the hand-dispatch of
   `WINDOW_HIDDEN` and the `isVisible()` polling in `maybeHideApp`.
   **Part A — per-window show/hide through the machine: DONE, gate green** (commits
   0996ba38, 765a6215, baa51bda, d66a6d51; full gate green after the hide-event-lag
   fix bb9d7226 and test-wait fix 11d53bc6).
   - **6A-1** (0996ba38): the reducer owns the keepLive close-request decision —
     `WINDOW_CLOSE_OR_HIDE_REQUESTED` branches on the record's first-class
     `keepLive` (hide vs the resolved close); no caller decides anymore.
   - **6A-2** (765a6215): the show path behind the port — `showWindow` in the
     backend owns the whole policy (headless opacity-0-before-show, activate vs
     `showInactive`, the quick-view NSPanel non-activation mask) and echoes
     `WINDOW_SHOWN` with the unmasked intent; the `windows.ts` show seams
     (`showWindowHeadlessSafe`, `showHybridHost`) are thin dispatchers.
     **Known asymmetry:** `raiseWindow` (the front assertion's own show/raise/
     activate path — §5 step 5) has no matching quick-view mask; it activates
     a page-host under plain `!isHeadless()` regardless of window class.
     Currently unreachable (`session.ts` never restores a quick-view host, and
     `raiseWindow` is already the front assertion's path), but it is a real gap
     between the two show paths, worth recording rather than leaving to memory.
   - **6A-3** (baa51bda): keepLive producers — `closeOrHideWindow` (both window
     kinds) and the tile-launcher `close` intercept dispatch the intent; the
     `windows.ts` hand-dispatched `WINDOW_HIDDEN` died.
   - **6A-4** (d66a6d51): the last per-window sites — `tile-ipc.ts`
     `tile:window:show/hide` + `show-self`/`hide-self`, `ipc.ts` hybrid and
     BrowserWindow key/url-reuse shows, and `windows.ts modWindow` 'hide' all
     dispatch `WINDOW_SHOW_REQUESTED` / the new `WINDOW_HIDE_REQUESTED` (the
     plain-hide twin of the show intent). The reuse paths' hand-dispatched
     `WINDOW_SHOWN` mirrors died with them — the backend's echo is the source.
     Remaining hand-dispatches of `WINDOW_SHOWN`/`WINDOW_HIDDEN` outside the
     backend + the executor's registration pump: the `hybrid-overlay.ts` test
     bridge's synthetic events for fake hosts (step 9) and `ipc.ts`'s fresh-open
     visible-intent seed (headless opens force ctor `show:false`, so no native
     or backend event ever fires there; dies when open lands behind the port).
   **Part B — app-level derivation: DONE.** `windows.ts getVisibleWindowCount`
   counts machine records (`listMachineWindowRecords`, the record's `visible`
   flag) instead of polling `isVisible()` across the BrowserWindow + hybrid
   registries — one table, both window kinds. The exclusion is by window CLASS
   (`APP_HIDE_EXCLUDED_CLASSES`: background / quick-view / palette / overlay /
   hud — the exact class image of the old address + TRANSIENT_ROLES +
   HUD-predicate checks), deliberately NOT by the `satellite` flag: quick-view
   is satellite:false yet excluded, while devtools (satellite:true) and
   extension-ui windows count. The in-flight window is still excluded, by
   machine id via `getWindowIdFor` (its native hide event may not have echoed
   yet). **Design decision:** `app.hide()` and
   `app.dock.hide/show` get NO port command — they are app-level operations,
   not window operations, so they are outside the port's scope (the port
   governs window ops; this is not an exception to it). The machine's job ends
   at supplying the visibility state the decision reads; the app-surface calls
   stay in `windows.ts maybeHideApp` / `applyDockPreference` (the latter
   collapsed to one preference-derived show/hide decision). The `windows.ts`
   hide-family R2 entry shrank 3→2 calls accordingly.
7. **Geometry / maximize.** Collapse the three stores into one; delete the `isMaximized()`
   distrust workaround along with the need for it.
   **Part A — machinery: DONE (inert — no caller cutover, R2 allowlist unchanged).**
   The reducer record carries `bounds` + `maximized` + `preMaxBounds`
   (`window-state.ts WindowRecord`). Inbound `BOUNDS_CHANGED` is the SOLE
   writer of `bounds` (an honest mirror of native reality — the restorable
   pre-fullscreen rect stays structurally in `fsMode.preBounds`, the aa34cb50
   trap). Maximize/unmaximize are reducer transitions (`MAXIMIZE_REQUESTED` /
   `UNMAXIMIZE_REQUESTED`), never an OS `isMaximized()` question: maximize
   stashes `preMaxBounds` from the machine's own bounds mirror and emits the
   new `SET_BOUNDS` effect with the display work area; a re-maximize re-snaps
   WITHOUT overwriting the stash (the stale-snapshot trap tile-ipc.ts's X11
   heuristic guards); maximize is a no-op while `fsMode` is non-normal
   (fullscreen owns the display); unmaximize restores the stash and clears it.
   **§4.2 dim 2b resolution:** the dim-2b phrasing "computePlacement becomes a
   pure helper the reducer calls" is resolved in favor of the reducer's
   ZERO-value-imports invariant (the unit gate compiles `window-state.ts`
   standalone): `window-placement.ts computePlacement` stays where it is,
   unrewritten, and any rect the reducer needs (the maximize work area, future
   display reprojection) is computed at the DISPATCH SITE and carried on the
   event payload — the reducer never imports it. Port command
   `window-backend.ts setWindowBounds(id, rect)` (deliberately NOT the
   platform name `setBounds` — the R2 check greps platform call names
   verbatim, same convention as `setFullscreen`/`pinAlwaysOnTop`), executed in
   `electron-window-backend.ts`, whose native `resize`/`move`/`moved`
   listeners emit `BOUNDS_CHANGED` for every registered window; executor case
   `SET_BOUNDS` in `window-os-adapter.ts` (no headless gate — a bounds write
   neither activates nor shows, same reasoning as `SET_STACKING`).
   **Part B — hybrid maximize cutover: DONE.** The
   `hybrid-page-host-registry.ts` store (`InternalEntry.maximized` /
   `preMaxBounds` / `setHybridMaximizeState`) is DELETED grep-zero; the
   machine record is the one holder. `ipc.ts page:maximize`/`page:unmaximize`
   dispatch `MAXIMIZE_REQUESTED` (work area resolved at the dispatch site,
   carried on the event) / `UNMAXIMIZE_REQUESTED`; readers
   (`window-presenter.ts getHybridPresentation`, the `hybrid-overlay.ts`
   active-handoff + test bridge) read the machine record. Reducer semantics
   added in this step (all pinned in `window-state.test.ts`, suite 206→222):
   - `MAXIMIZE_RESTORED {id, preMaxBounds}` — the construction-time restore
     seed (reopen/session-restore build the window AT the maximized rect, so
     it sets flag+stash and drives NO `SET_BOUNDS`); dispatched by the
     `ipc.ts` hybrid open path right after machine registration.
   - `MAXIMIZE_EXITED_BY_RESIZE {id}` — the pinned "resize gesture exits
     maximize at press" invariant as a transition: clears flag+stash, drives
     nothing (the gesture owns the bounds). Producers: the band-drag press
     (`exitMaximizeForResize`) and the native-resize reconciler
     (`reconcileMaximizeAfterResize`) — both now read the machine flag; the
     reconciler's work-area comparison stays a live-read because it RACES the
     backend's own `resize` listener on the same native event (geometry is
     evidence there, never authority).
   - `WINDOW_REGISTERED` gained an optional `bounds` seed for the mirror:
     the backend reads `getBounds()` ONCE at registration (same boundary-read
     pattern as `nativeVisible`) and the executor carries it on the pump —
     without it a ctor-placed window that was never natively resized/moved
     has an empty mirror and its first `MAXIMIZE_REQUESTED` would stash
     null. A re-registration never overwrites a lived mirror.
   Divergences from the legacy handlers, deliberate: `page:unmaximize` with a
   null stash now clears the flag (legacy no-oped), and the maximize stash
   comes from the machine's mirror rather than a live `getBounds()` at
   toggle time. R2: `ipc.ts` `setBounds` 7→5 (the maximize snap + restore
   calls died); the `hybrid-overlay.ts` `setBounds` ×6 are all
   overlay-follow geometry (step 9's share) and were untouched.
   **Part C — generic BrowserWindow maximize cutover: DONE.** The
   `tile-ipc.ts` maximize path is machine-owned and the `params` bag as
   in-memory maximize authority is deleted grep-zero (no live
   `info.params.preMaxX/Y/Width/Height` or `params.maximized`
   reads/writes remain):
   - `tile:window:maximize` dispatches `MAXIMIZE_REQUESTED` (work area
     resolved at the dispatch site, riding the event — same shape as
     `ipc.ts page:maximize`). The manual `setBounds(workArea)` + params
     stash died; the X11 at-work-area slack heuristic (geometry guarding
     the re-maximize stash-overwrite trap) is subsumed by the reducer's
     flag-idempotent `MAXIMIZE_REQUESTED` clause — geometry no longer
     votes. The `tile:window:maximize-request` renderer notification
     survives, its `prevWindowBounds` now the machine's pre-dispatch
     bounds mirror (null on re-maximize, matching the unoverwritten
     stash).
   - `tile:window:unmaximize` dispatches `UNMAXIMIZE_REQUESTED`; the
     `isMaximized()` distrust block (stash-else-native fallback, both
     native `unmaximize()` calls) is deleted entirely — maximize is a
     reducer fact, never an OS question (§3).
   - `tile:window:update-canvas-state` (a canvas-era surface with no
     in-tree callers left, kept as the declared-layout sync channel)
     routes maximize facts to the machine: `maximized:true` →
     `MAXIMIZE_RESTORED` (declared stash, no `SET_BOUNDS` — the renderer
     owns the bounds), `maximized:false` → `MAXIMIZE_EXITED_BY_RESIZE`.
     Position x/y/width/height still land in `info.params`
     (session-format passthrough, step 11's read-model).
   Deliberate semantics changes vs legacy: unmaximize of a
   never-machine-maximized window is now a reducer no-op (the native
   `unmaximize()` fallback for "maximized via OS frame dbl-click" died —
   no in-app path produces that state); a maximized-then-natively-resized
   BrowserWindow keeps its original stash (generic windows have no
   resize-exits-maximize reconciler — that producer exists only on the
   hybrid path). Persisted-snapshot FORMAT untouched at this step:
   `session.ts` still wrote `preMaxX/Y/Width/Height`+`maximized` keys (from the
   presenter) and reopen/restore still threaded them as open options into the
   `ipc.ts` `MAXIMIZE_RESTORED` seed — the four flat keys later collapsed into
   one nested `preMaxBounds` field at §5 step 11 task 5; `maximized` stayed a
   flat boolean throughout, matching `WindowRecord.maximized`. `ipc.ts
   windowParams` still carries the open-time `maximized` passthrough
   (write-only — no in-memory reader remains; dies with the session
   read-model cutover). R2:
   `tile-ipc.ts` `setBounds` 5→3, `unmaximize` entry (×2) deleted —
   allowlist 32→31 entries.
   **Part D — geometry READ-model cutover: DONE.** Presenter, close-capture
   and (through the presenter) session-save read reducer state, never live
   Electron queries, and "restorable geometry" is ONE concept with ONE home:
   `window-presenter.ts getRestorableBounds(machineId)` — fullscreen episode
   → `fsMode.preBounds` (the aa34cb50 lookalike trap, previously a presenter
   special case); else the machine's `bounds` mirror, which while maximized
   IS the maximized rect, persisted at this step alongside `maximized` +
   `preMaxX/Y/Width/Height` exactly as the session format then expected
   (restore re-seeds via `MAXIMIZE_RESTORED`, 7C) — the four flat keys later
   collapsed into one nested `preMaxBounds` field at §5 step 11 task 5.
   Cutovers, each keeping the live
   read only as the fallback for a machine-unseen window (tripwire-hunted):
   - `window-presenter.ts getLivePresentation` — machine bounds via the rule;
     the hardcoded `maximized:false`/`preMaxBounds:null` for generic
     BrowserWindows (7C known gap) now reads the machine record, so
     `tile:window:list` and session-save finally surface generic-window
     maximize state. `getHybridPresentation`'s two-step (7B mirror + 7A
     fullscreen override) collapsed into the same rule.
   - `main.ts` `'close'` capture (`lastBounds`) and `ipc.ts`
     `captureHybridClose` (`hybridLastBounds`) — the undo-close raw-bounds
     fallbacks read the machine via the rule.
   Persisted-snapshot FORMAT untouched at this step (session.ts still wrote
   the same keys from the presenter; collapsed later at §5 step 11 task 5).
   R2 allowlist unchanged (31 entries / 72 calls — the check tracks op calls,
   not reads).
   **Part E — remaining geometry-write cutover: DONE. Step 7 is DONE.**
   One new inbound event closes the write side:
   `SET_BOUNDS_REQUESTED {id, bounds}` (`window-state.ts`) — the plain
   geometry-write intent behind every legacy direct `setBounds` — emitting
   the existing `SET_BOUNDS` effect. Same shape as the maximize pair: the
   rect is computed AT THE DISPATCH SITE (`computePlacement`, gesture math)
   and rides the event (ZERO-value-imports invariant); the `bounds` mirror
   still updates ONLY via the `BOUNDS_CHANGED` echo; dropped while `fsMode`
   is non-normal (fullscreen owns the display, the aa34cb50 family — a
   deliberate divergence from the legacy calls, which would have written
   blindly mid-episode); deliberately does NOT touch `maximized`/
   `preMaxBounds` (matching the legacy calls — invalidation stays
   `MAXIMIZE_EXITED_BY_RESIZE`, whose producers fire at the gesture press).
   Cutovers: `tile-ipc.ts` `tile:window:center` / `center-all` /
   `set-bounds` (×3, all dead — entry deleted), `ipc.ts`
   `applyPlacementOnReuse` + the open-time `options.maximize` work-area fill
   + BOTH drag/resize streams (`page:set-bounds` and the band-drag
   `applyResize`). The streams go through the reducer PER EVENT, not through
   a sanctioned port-command side door: the pump's dispatch is synchronous
   (read-after-dispatch contract) and already carries `BOUNDS_CHANGED` at
   native resize-event frequency, so a gesture stream costs what its own
   echo stream already costs — and one path stays one path. The 7B gesture
   reconciler is untouched (its live read stays evidence, never authority).
   The fifth `ipc.ts` hit is the `assembleHybridPageHost` fillView
   `view.setBounds` — a CHILD-VIEW op on the host's content
   `WebContentsView`, not a window op: reclassified into the R2 check's
   not-window-ops section (entry kept at ×1, the mechanical greps can't see
   receivers). R2: `tile-ipc.ts` `setBounds` entry deleted, `ipc.ts`
   `setBounds` 5→1 — allowlist 31→30 entries / 72→65 calls. Reducer suite
   222→228. Geometry writers still on the R2 list are OTHER steps' shares,
   not step-7 remainder: `hybrid-overlay.ts` overlay-follow geometry (×6,
   step 9). `display-watcher.ts` is no longer on this list at all — step 10
   deleted its `setBounds` call outright; the module is now a pure producer.
8. **Focus rivals — DONE.** Delete `izui-state.ts`'s focus surface and `restoreFocusGuard`; delete
   `BrowserWindow.getFocusedWindow()` from `entry.ts` and `tile-ipc.ts`. Reduce
   `izui-state.ts` to the session tri-state only.
   **8a — switcher focus-restore seed: DONE** (commit eff3bcd6). `enterOverlay`
   seeds `preOverlayFocusTarget` from the machine's `front`, not the
   coordinator tracker.
   **8b — restore focus guard deleted: DONE.** `restoreFocusGuard` +
   `beginRestoreFocusGuard`/`clearRestoreFocusGuard` (`izui-state.ts`) and
   `session.ts`'s restore-time arm are gone; `setFocusedWindow` is a plain
   setter (§4.4 dim 5b). Known, deliberate consequence: the arm was also the
   only deterministic restore-time seed of `session.focusedWindowId`, so that
   tracker is now fed only by async OS focus events — acceptable because its
   last load-bearing reader left in 8a and step 8c deletes it. The
   session-restore-hybrid-focus spec asserts the machine's `front` instead
   (test bridge `getFrontWindowId`/`getMachineWindowIdFor` in `entry.ts`).
   **8b follow-up — session-restore front-steal fixed (two layers).** (1) The
   restore loop in `session.ts restoreSessionSnapshot` never activates: every
   in-loop show is inactive, and the window-reuse path honors `show:false`, so
   the post-loop `willActivate` block is the single activation authority
   (commit aee38a6d). (2) AppKit can deliver a stale/lagged native `hide`
   event for a just-activated hybrid host that is still visible — no JS hide
   call exists (proven via a prototype-level `.hide()` trap). The native
   `win.on('hide')` listener in `electron-window-backend.ts` therefore echoes
   `WINDOW_HIDDEN` only when `win.isVisible()` is false — a commented
   OS-boundary workaround (peek `71cfde09` lag class); do not remove.
   **8c — izui coordinator focus tracker deleted: DONE.** `setFocusedWindow` /
   `clearFocusedWindow` / `getFocusedWindowId` and `IzuiSession.focusedWindowId`
   are gone (`izui-state.ts`), along with the `ipc.ts` focus-handler tracker
   update, the `main.ts` closed-handler clear, and the
   `entry.ts` `getIzuiFocusedWindowId` test bridge.
   `session-restore-page-host.spec.ts` now asserts the machine front
   (`getMachineWindowIdFor` → `getFrontWindowId`). The izui tri-state,
   app-active tracking, overlay executor, and `enterOverlay()`'s
   machine-front seed via the injected provider remain.
   **8d — current-window queries via machine front: DONE.** The remaining
   `BrowserWindow.getFocusedWindow()` calls in `entry.ts` (Cmd+W devtools
   guard) and `tile-ipc.ts` (`tile:dialogs:save`/`tile:dialogs:open`
   parenting, `tile:theme:setWindowColorScheme` resolution chain) now resolve
   through `getFrontWindowId()` → native window. Dialog sheets parent
   directly over hybrid BaseWindow hosts (Electron dialog APIs accept
   `BaseWindow`). Deliberate hold-over: the devtools guard still skips a
   hybrid front (matches the old null behavior) — extending it to hybrid
   content devtools is a possible follow-up, not done.
   **8e — clean focus calls routed through the machine: DONE.** The
   `tile:window` focus IPC (both BrowserWindow and hybrid branches,
   `tile-ipc.ts`) and all four `ipc.ts` open-dedupe reuse paths now ride
   `WINDOW_SHOW_REQUESTED {activate:true}` (the headless-gated reuse sites
   already did via `showWindowHeadlessSafe`); the hand-dispatched
   `OS_FOCUS_GAINED` mirror in `tile-ipc.ts` is gone. R2 allowlist
   29 entries / 57 calls. Punted to step 9 (entangled, entries retained):
   the `ipc.ts` `devtools-opened` first-responder restore and the modal
   blur-settle re-focus.
   **8 live verification — DONE (visible macOS run, temporary front-diag
   instrumentation, reverted after).** Both mandatory focus gestures pass:
   - **Gesture A (switcher ESC-ESC restore):** `enterOverlay` seeds
     `preOverlayFocusTarget` to the real machine front; the switcher is a
     satellite so `front` never moves while it is focused; on ESC dismiss the
     machine (not the close handler) owns restore via `RAISE_WINDOW`, and the OS
     focus event lands back on the pre-overlay front. Verified across five
     open/dismiss cycles.
   - **Gesture B (restore-then-front):** every restore-loop show is
     `inactive=true` (the loop never activates); the post-loop decision is the
     single authority (`willActivate=true`, `focusedId` = the focused
     descriptor) and activates it via `showHybridHost`; the stale-macOS-hide
     guard correctly suppresses lagged `'hide'` events for still-visible
     windows. The only front shift observed afterward was a `DEVTOOLS_OPENED`
     first-responder grab in the `DEBUG=1` build — the already-known step-9
     `ipc.ts devtools-opened` punt, not a restore regression.
   **Step 8 residual R2 debt: closed.** The four entries (`hybrid-overlay.ts` `focus`,
   `izui-state.ts` `showInactive`, `main.ts` `focus`, `windows.ts` `focus`) are gone from
   both the allowlist and live code, commit `66c7958f`.
9. **Overlay attach/retarget + transient autoclose — PARTIAL.** Transient-sibling
   autoclose is absorbed (§4.4 dim 4b: `selectTransientAutoclose` /
   `selectAppResignTransients`). Overlay follow/retarget and the module's own `appActive`
   copy are absorbed (commit `1bdd1c11`, §4.3 dim 3b): `hybrid-overlay.ts` no longer
   drives the OS itself for geometry; the reducer owns the follow via
   `applyOverlayFollow` / `WindowRecord.overlayFor`.
   **Write debt: closed.** The residual call sites (`hybrid-overlay.ts` `showInactive`,
   `destroy`; `ipc.ts` `focus`; `main.ts` `close`) are gone from both the allowlist and
   live code, commits `a3f658cf` (write debt) and `a731cf66` (`ipc.ts focus`).
   **Unverified here:** whether further step-9 work beyond the overlay-follow cutover has
   landed under other commit messages — the commit log carries at least two more
   `wm step 9`-tagged commits (`ed0f80ce`, `c5c9bcd7`) that this pass did not audit
   task-by-task. A future pass should reconcile them into this section rather than assume
   step 9's remaining scope is only write debt.
10. **Displays and Spaces.** Route `display-watcher.ts` through events; add the
    space-change listener that does not exist yet.
    **Part A — Displays: DONE** (commits af540e74, 81175dfe, b8e44377, 10c79748).
    `display-watcher.ts`'s `projectWindow()` — the direct `win.setBounds()` call
    it ran per window — is deleted; the module is reduced to a pure producer: it
    reads the OS (the display snapshot, the two window registries,
    `getWindowInfo`), decides via the new pure seam `display-projection.ts
    collectDisplayProjection()`, and dispatches ONE `DISPLAY_CHANGED` per pass
    carrying the whole batch instead of writing bounds inline window-by-window.
    The reducer emits the `SET_BOUNDS` effects; the port performs them (R2, the
    single geometry funnel) (`81175dfe`). Two reducer-side fixes landed inside
    the same cutover: `parent-centered` now resolves against the PARENT's
    projected rect for this pass, not its pre-pass snapshot, via on-demand
    memoized recursion (`projectOne`/`resolveParentProjectedBounds` in
    `display-projection.ts`) — a `81175dfe` regression closed by `b8e44377`. And
    `WindowRecord.pendingProjectedBounds` (`window-state.ts`) — a projected rect
    the reducer now HOLDS instead of discarding when `DISPLAY_CHANGED` lands on
    a window that is fullscreen or hidden, flushed by `flushPendingProjection`
    from every transition that lifts one blocking axis (the `→ normal` fsMode
    transitions, `WINDOW_SHOWN`), emitted only once BOTH axes clear (`10c79748`)
    — closes a stranding gap the old inline `projectWindow()` walk had no retry
    mechanism for at all. R2: the `display-watcher.ts setBounds` allowlist entry
    is gone outright (28 entries / 56 calls, unchanged since). Tests:
    `display-projection.test.ts` (ordering, parent resolution, drops, purity) +
    `window-state.test.ts`'s `DISPLAY_CHANGED` describe (deferred/flush cases);
    270 pass, 0 fail across both files. `tsc --noEmit` clean.
    **Part B — Spaces: DONE.** `WindowRecord.visibleOnAllSpaces` and
    `SET_VISIBLE_ON_ALL_SPACES_REQUESTED` landed first as inert machinery
    (`af540e74`); the write paths then cut over — the port's
    `setVisibleOnAllSpaces` with its Electron implementation, the role-derived
    `SPACES_POLICY_REQUESTED` (which owns the follow/anchor decision and the
    anchor's ordered true-then-false pair), and the renderer-driven tile IPC on
    the raw event — so every `setVisibleOnAllWorkspaces` call now runs through
    the reducer. The listener this item called for closes it: the backend
    subscribes to the macOS active-Space notification and emits `SPACE_CHANGED`
    (§4.2 dim 7c). The notification says only THAT the Space changed —
    `userInfo` is empty, verified live — so the reducer stores nothing, and it
    emits nothing either: the all-Spaces flag is sticky, so there is nothing for
    a Space switch to undo, and a per-window re-assert mid-transition would be a
    speculative fix paid for with the native call this app has flash regressions
    on. The event lands wired but inert, as `visibleOnAllSpaces` itself first did
    (`af540e74`); the clause is where a re-assert would go if a dropped flag is
    ever actually observed.
11. **Session save / restore. Last.** Worst regression history in the app, and the one
    place doing bulk z-order plus focus as a single sweep.
    **Task 5 — the descriptor's pre-maximize rect collapses to one nested field: DONE.**
    A saved descriptor's `params` bag carried the pre-maximize rect as four flat numbers
    (`preMaxX`/`preMaxY`/`preMaxWidth`/`preMaxHeight`); it now rides as one nested
    `params.preMaxBounds` field, named exactly as the machine record names it
    (`WindowRecord.preMaxBounds`). `params.maximized` stays a flat boolean, mirroring
    `WindowRecord.maximized`. Migration: tolerant read, new shape on write — no one-shot
    rewrite pass over stored snapshots, because `session.ts saveSessionSnapshot()`
    already overwrites the whole snapshot row (`INSERT OR REPLACE INTO feature_settings
    ... VALUES ('session-snapshot', ...)`), so every stored row converts after one
    autosave cycle. `session-projection.ts readPreMaxBounds()` owns the tolerant read;
    its flat-bag branch exists only to absorb pre-collapse snapshots and can be deleted
    once those have aged out. **Known gap:** the tolerant-read seam is pinned only at
    the function level — no test drives a genuine pre-collapse ON-DISK snapshot through
    restore; the `readPreMaxBounds` suite in `session-projection.test.ts` exercises the
    function directly. Risk is low because `session.ts stripKeys` is an explicit
    deny-list that does not name these keys, so they are not at risk of being silently
    dropped on the way through.
    **Task 7 — restore replays the saved stack instead of rebuilding it from focus
    recency: DONE.** A saved descriptor recorded only `zOrder` (the record's `focusSeq`),
    and restore rebuilt the stack from it — so the restored order was a focus-recency
    ranking, not the order that was on screen. The two genuinely disagree: `WINDOW_SHOWN`
    raises a window in `stackOrder` on ANY show but bumps `focusSeq` only when the show
    focused it, so a window opened in the background sits visually above the last-focused
    window and ranks below it by recency — and the old restore put it back underneath. A
    descriptor now also carries `stackIndex`, its position in the machine's bottom→top
    `AppWindowState.stackOrder` at save time, and the post-loop `STACK_ORDER_IMPORTED`
    orders by it. Session restore restores the session as it was left.
    `zOrder` stays exactly what it was and keeps its OTHER job — the eager/deferred
    restore-loading split (`SESSION_EAGER_RESTORE_COUNT`): "load what was last in use
    first" is right even when the visual stack differs, so the two ranks are separate
    persisted facts rather than one collapsed one. The post-loop reconstruction step does
    not go away either — the restore loop's own non-activating shows scramble `stackOrder`
    mid-restore whatever feeds the final import.
    Migration: same strategy as task 5 — new shape on write, tolerant read, no one-shot
    pass, for the same reason (save rewrites the whole snapshot row every autosave).
    `session-projection.ts readStackIndex()` reads the field and
    `orderRestoredWindowsBottomToTop()` orders with it; its all-unrecorded branch is the
    old focus-recency ordering, commented as existing only to absorb pre-field snapshots
    and deletable once those age out. A window with no recorded position sorts below the
    recorded ones, so the import still names every restored window and the
    `stackDrives === restored count` invariant the focus specs assert is untouched.

    **The six tasks below landed on `main` after Task 5 and Task 7 above but had no
    write-up here until this pass. They are ordered chronologically by commit timestamp,
    which is NOT the same as their task numbers — see the collision note at the end.**

    **Task 11.1 (2026-07-26) — session SAVE reads `WindowRecord.visible`, not the OS:
    DONE.** `saveSessionSnapshot`'s early-skip block and `saveSpaceWorkspaces` no longer
    call `isVisible()` on the native handle; both route through one helper,
    `isWindowVisiblePerMachine(electronWindowId)`, joining the Electron id onto the
    machine's `WindowRecord.visible` mirror (owned since §5 step 6). No-record fallback is
    `true` (treat as visible, save the window) — deliberately asymmetric: a false negative
    would silently drop a user window from the restored session, a false positive at worst
    leaves one stale entry. `isVisible` is a read, not in the R2 `FORBIDDEN` set, so this
    commit does not move the allowlist. Commit `43d0d4e4`.

    **Task 3 (2026-07-26) — restore focus routed through the machine: DONE.** The last two
    raw window ops in `session.ts` — the restore post-loop's `focusWin.focus()` and the
    one-shot cold-start `reassertColdStartFocusOnce()` — now dispatch
    `WINDOW_SHOW_REQUESTED {activate:true}` via `showWindowHeadlessSafe`. No new event was
    needed: in both sites the target window is already visible (shown inactive by the
    restore loop), so an activating show IS the activation. Bonus: `SHOW_WINDOW` echoes
    `WINDOW_SHOWN {focused:true}`, so `front` updates synchronously instead of waiting on
    the async OS focus event. Deleted the `session.ts` `focus` ×2 R2 entry — the only
    step-11-tagged one at the time (allowlist 26→25 entries / 46→44 calls). Commit
    `9e08523a`. **Collides in task number with Task 3 (2026-07-28) below.**

    **Task 4 (2026-07-26) — session SAVE becomes a pure projection of machine state:
    DONE.** `saveSessionSnapshot` mixed three jobs: reading OS/registry facts, deciding
    what the session is, and writing SQLite. The deciding job moves out whole into a new
    pure module, `session-projection.ts serializeSession(input)` (mirrors the
    `display-projection.ts` / `overlay-frame.ts` seam pattern); `session.ts` is now read →
    project → write and computes no window decisions. Every window-management fact in a
    descriptor is read off a machine `StateSnapshot`: `visible` from
    `WindowRecord.visible`, bounds from the restorable-geometry rule, `maximized`/the flat
    preMax bag from the record, `zOrder` from `focusSeq`, `focused` from
    `StateSnapshot.front`. On-disk shape proven unchanged two ways: a legacy-oracle
    text-diff across 15 fixture worlds, and a real headless A/B run (byte-identical
    snapshot/metadata rows modulo `createdAt`). One deliberate divergence: `focused` is
    now `machineId === snapshot.front` rather than joining front through
    `getNativeWindowFor(front).id` — the two disagree only if `front` is set while its
    native handle is already gone. Commit `52cb2235`. **Collides in task number with
    Task 4 (2026-07-28) below.**

    **Task 8 (2026-07-26) — the cold-start re-raise latch becomes reducer state: DONE.** A
    sweep of `session.ts`'s module-level mutable bindings, classifying each as window
    state (fold into the machine) or module state (keep, say why). Only one was genuine
    window state: the cold-start trailing-dance latch (`_coldStartReassertArmed` /
    `_coldStartReassertId`), which held "which window is meant to be in front" outside the
    machine and drove the OS itself from `reassertColdStartFocusOnce()`. It is now
    `AppWindowState.pendingColdStartFocus`, armed by `COLD_START_FOCUS_ARMED` (dispatched
    by the restore's focus block under the old gate: cold start + non-headless + window
    present) and consumed by `APP_ACTIVATED`, which re-fronts the window and drives
    `RAISE_WINDOW` + `FOCUS_CONTENT` + `SET_STACKING`. `reassertColdStartFocusOnce()` is
    deleted, along with `main.ts`'s `did-become-active` call and its test bridge. The
    survivors (`_restoreComplete`, `_firstFrameProducerInstalled`, the autosave timer +
    interval, the `_restore*Count` test-observability block) each get a one-line
    "why this stays module state" note in source. Commit `52cf2612`.

    **Task 3 (2026-07-28) — `CONTENT_FIRST_RESPONDER_CHANGED`, `WindowRecord.contentFocused`:
    DONE.** Adds the inbound event and record field that Task 4 (2026-07-28, below) reads:
    the backend's mirror of the renderer `WebContents` `focus`/`blur` pair. Commit
    `c43843cc` (a one-line commit message; no further detail is available from the log).
    **Collides in task number with Task 3 (2026-07-26) above.**

    **Task 4 (2026-07-28) — re-key the Escape grab off `contentFocused`, not
    `frontAsserted`: DONE.** `deriveEscGrabRegistered`'s front-not-first-responder half now
    reads the front window's `WindowRecord.contentFocused` (fed by
    `CONTENT_FIRST_RESPONDER_CHANGED`) instead of the (now-deleted) machine's own
    `AppWindowState.frontAsserted`, which `frontAsserted` was only ever approximating. Old
    predicate: `appActive && (front === null || !frontAsserted)`. New:
    `appActive && (front === null || front's record.contentFocused === false)`. Absent
    (`contentFocused === undefined`, "nothing reported yet") does NOT arm the grab — only
    an explicit `false` does; two cases land on absent and must not permanently arm it (a
    browser-kind front, which never gets this event at all, and a page-host between a
    just-driven `FOCUS_CONTENT` and the async native `focus` event it produces).
    Live-verified against the original 7fffa286/7c61e917 regression pair that
    `frontAsserted` originally existed to guard: a real app resign fires the content blur
    before `APP_RESIGNED` itself, so `contentFocused` is already `false` by the time the
    app goes inactive. Commit `555ff5fb`. **Collides in task number with Task 4
    (2026-07-26) above.**

    **Task-numbering collision, noted rather than fixed:** the 2026-07-26 and 2026-07-28
    sessions each independently shipped a "Task 3" and a "Task 4" for step 11. Commit
    history is immutable, so this document does not renumber them — dates disambiguate:
    "Task 3 (2026-07-26)" (`9e08523a`, restore focus routed through the machine) is
    unrelated to "Task 3 (2026-07-28)" (`c43843cc`, `CONTENT_FIRST_RESPONDER_CHANGED`);
    "Task 4 (2026-07-26)" (`52cb2235`, session SAVE as a pure projection) is unrelated to
    "Task 4 (2026-07-28)" (`555ff5fb`, the Escape-grab re-key). Any future step-11 task
    number should be checked against this list to avoid a third collision; past ones stay
    as committed.

    **Step 11 remaining work:** as of this pass, no commit or doc evidence was found of
    any step-11 task beyond the eight above (11.1, two Task 3s, two Task 4s, Task 5,
    Task 7, Task 8) — the R2 allowlist carries zero entries tagged step 11
    (`scripts/check-r2-window-ops.mjs`). Whether step 11 has further tasks left is
    therefore genuinely open; this document gives no basis to enumerate them, and none
    should be invented. A future agent auditing step 11 should start from the "Accepted
    behavior loss" and "Restored z-order" notes in §6.

**Live verification is mandatory at every seam cutover that touches focus.** macOS
first-responder behavior is **unobservable in headless tests** and a green headless suite
has produced false confidence on this exact family of bugs twice already. The protocol:
instrument in a clone, commit the instrumentation, launch, and confine manual involvement to
**performing the reproduction gesture** — everything else, including reading the log and
cleaning up, is automated.

---

## 6. Current state

**Superseded by "Where we are" at the top of this document — read that first.** What
follows is a recount taken directly against §4 for this pass, not a copy of the figure
this section previously carried (which was stale). §4 has ~24 dimension entries; 2 of
them (dim 10, and the explicitly out-of-scope "Peek / slide content features" line) are
OUT OF SCOPE and don't count either way. Of the remaining 22 in-scope dimensions,
**18 are owned or fine-as-is** (ABSORBED / DONE / OWNED-KEEP-AS-IS: 1a, 12, 2, 2b, 3, 3b,
4, 5b, 4b, 6b, 7, 7b, 7c, 8a, 8b, 9, 11, 5c) and **4 are still genuinely open** (1b —
new-window-vs-reuse dedup; 6 — roles + session tri-state, partial; 4c — deferred/lazy
content load, partial; 5 — session save/restore, PARTIAL per §5 step 11). Four of the 18
"owned" dimensions (2, 4, 7b, 9) had stale "TO ABSORB" markers in §4 at the start of this
pass — their bodies (or the linked §5 steps' bodies) already documented the landing, but
the opening status word on the dimension itself hadn't been updated to match. Verified
directly: `window-state.ts` carries `visibleOnAllSpaces` (dim 7b) and `WindowRecord`'s
`visible` field is fed only by `shown`/`hidden` events (dim 4, confirmed by the §5 step
11.1 commit `43d0d4e4`'s own description); no `getFocusedWindowId` symbol remains
anywhere in `apps/desktop/main/`, and `entry.ts` / `tile-ipc.ts` no longer call
`BrowserWindow.getFocusedWindow()` live, only in comments (dim 9). Dim 2's "Step 7 is
DONE" sentence is already in its own body (§4.2). **The stale marker words themselves are
NOT rewritten in this pass** — out of scope for this truthing pass, which was scoped to
§6 and dim 3b specifically; a follow-up should fix the four inline markers to match.

Migration steps landed since this document was written: the id space (§5 step 1), the
port (§5 step 2), the R2 enforcement check (§5 step 3), special window classes + registry
unification (§5 step 4), z-order/stacking (§5 step 5), visibility (§5 step 6),
geometry/maximize (§5 step 7), displays and Spaces (§5 step 10), and focus rivals (§5
step 8) are all DONE; overlay attach/retarget + transient autoclose (§5 step 9) is
PARTIAL — its write debt is closed but two commits' non-write-op scope remains unaudited;
session save/restore (§5 step 11) is PARTIAL with 8 tasks landed. See "Where we are" for
the live per-step table. The
machine is live behind the seams already cut over (`window-state-singleton.ts` lists the
authorities it replaced).

**`apps/desktop/main/window-state.ts`** — the owner, as R1 describes it, for the dimensions
it covers. Pure, zero imports, 187 unit tests in `window-state.test.ts`, keyed by
`WindowId`. It owns: `front` (a pure projection of OS focus — the most recently
OS-focused front-eligible window, written only by `applyFocusGained`), the switcher
state, the Escape decision (`applyEscape`), fullscreen mode,
satellite classification (`isSatelliteRegistration`), window classes
(`classifyWindowRegistration` + the record's closed `class` enum), the stacking level +
ordered z-order list (`deriveStackingLevel`, `AppWindowState.stackOrder` — §5 step 5),
the window-manager
registry payload (`source`/`params` — the deleted `main.ts windowRegistry`), parent
linkage (parent-refocus on WINDOW_CLOSED), the HUD app-blur hide/show sweep, and MRU
focus order. This is the nucleus; everything in §4 grows into it rather than beside it.

**`apps/desktop/main/window-os-adapter.ts`** — the executor, as R2 describes it, and since
the port landed (§5 step 2) **Electron-free**: it imports no platform module and holds no
native handle. Its `runEffect` is the single funnel, and every effect it executes is a
`WindowBackend` port command; native reality re-enters only through the backend's
injected event sink into its dispatch pump.

**`apps/desktop/main/window-backend.ts`** — the port, as R3 describes it: command + event,
never query, zero platform imports. Its surface is exactly what the executor issues
today; the steps that need more of the §3 table widen it when they land.

**`apps/desktop/main/electron-window-backend.ts`** — the Electron implementation, and the
only window-manager module that imports Electron. It retains every native handle, mints
every `WindowId` (`registerWindow()`, idempotent per native window; its private
`idByOsWindowId` map is the only `WindowId` ↔ Electron translation in the tree), owns the
two OS-boundary settles (deferred-blur §4.4, bounded fullscreen §2.3), performs the
step-4 command family (guest-safe `closeWindow` — the absorbed d1cf0b9a UAF guard —
`destroyWindow`, `closeContent`, `showWindow`, `hideWindow`, `pinAlwaysOnTop`,
`destroyAllContentGuests`) plus step 5's `setStacking` (the native relative raise,
`moveTop` — legal only here, the R2-exempt file), and carries the comment-annotated migration shims
(`BackendMigrationShims`) — deleted when creation moves behind the port and at step 11.

**`apps/desktop/main/window-state-singleton.ts`** — the composition point: holds the one
machine + adapter pair and exposes the numeric-id seam (`getWindowIdFor()` /
`getNativeWindowFor()`) that the still-numeric renderer-facing id economy converts
through (§3 scope decision).

**The §0.1 rewrite is wired and performs every window operation.** `apps/desktop/main/window-kernel.ts`
(the kernel), `window-escape.ts` (the Escape interpreter) and `window-kernel-executor.ts`
(`WindowKernelExecutor`, the impure edge) drive the running app; the executor provider is installed
by `window-state-singleton.ts initWindowStateMachine`, and the arms of `window-os-adapter.ts runEffect`
they replaced are labelled no-ops. Four responsibilities still sit on the old machine: the Escape
renderer round trip, opening and closing the switcher, `reconcileEscGrab`, and two Escape-decided
arms that carry kernel feeds and perform nothing. `window-state.ts` and `window-os-adapter.ts` are
deleted once those have homes.

**The R2 check is live** — `scripts/check-r2-window-ops.mjs`, in the
`test:desktop:electron` chain: **15 allowlisted entries / 23 calls**
(`node scripts/check-r2-window-ops.mjs`, 2026-08-17 — see "Where we are" at the top of
this document for the canonical live count), each tagged with the §5 step that deletes
it. The sole exempt file is `apps/desktop/main/electron-window-backend.ts` (swapped from
the executor when the port landed). The entry count is the migration's progress bar; it
only goes down.

**The machine's separate belief about front is deleted; `front` is a pure projection of
OS focus** (commit ef200b7c) — the claim field, its invalidation clause, and the
closing-assertion step that used to run at the tail of `reduce` are gone. `front` itself
survives: the most recently OS-focused front-eligible window, written only by
`applyFocusGained`, reached from BOTH `OS_FOCUS_GAINED` and `WINDOW_SHOWN {focused:true}`.
The machine no longer holds a value that can disagree with what macOS reports and then
re-drive the OS to match it.

- **`applyRaiseRequest` is the sole `RAISE_WINDOW` emitter**, reached from
  `RAISE_WINDOW_REQUESTED` and four user-act sites: switcher selection
  (`SWITCHER_SELECTED`), the `WINDOW_CLOSED` parent/successor handoff, devtools
  open/close (`DEVTOOLS_OPENED`/`DEVTOOLS_CLOSED`), and `applyEscape`'s close-switcher
  branch.
- **Two focus-bearing events, deliberately different.** `OS_FOCUS_GAINED` moves `front`
  AND runs `selectTransientAutoclose`; `WINDOW_SHOWN {focused:true}` moves `front` but does
  NOT sweep, because it is a registration-time visibility import
  (`decideWindowRegistration.pumpShownEvent`) rather than evidence the OS moved focus.
  Conflating them is what caused the command-palette flash-and-vanish.
- **`applyOsFocusRealized`** carries what the deleted assertion's record-not-echo branch
  did: on an `OS_FOCUS_GAINED` for the current front, it pushes `FOCUS_CONTENT` for a
  page-host and calls `stackRaise` on the window — mirroring an order the OS already
  performed, never re-driving a raise back at it.
- **The Escape grab is derived from `WindowRecord.contentFocused`** — the backend's mirror
  of the renderer WebContents `focus`/`blur` pair — not from a machine-side claim. Absent
  means "nothing reported yet" and does NOT arm the net.
- **Termination of the `pump` drain is now structural**, not an ordering coincidence: no
  arm reachable from `RAISE_WINDOW`'s `WINDOW_SHOWN` echo may call `applyRaiseRequest` —
  concretely, the `WINDOW_SHOWN` and `OS_FOCUS_GAINED` arms never call it. A unit test pins
  this: `INVARIANT: no RAISE_WINDOW is emitted from WINDOW_SHOWN or OS_FOCUS_GAINED (the
  pump's convergence obligation)`.

**The machine's own raise echo no longer sweeps the palette it just handed focus back for**
(commit `83db8186c03c`, "OS_FOCUS_GAINED carries provenance"). `OS_FOCUS_GAINED` gained an
optional `cause: FocusCause` (`{ kind: 'machine'; opSeq } | { kind: 'world' }`, absent means
world), stamped from `electron-window-backend.ts`'s `armSelfCausedFocus` immediately before any
native call that can move focus; `selectTransientAutoclose` applies its `openSeq` ordering test
only when the focus is machine-caused. Without it, a palette that legitimately sweeps an open
slide could be swept in turn by the OS's own echo of the raise the machine issues to hand focus
back to the palette after the slide hides. Headless cannot exercise this at all — no activating
show ever arms `pendingSelfCausedFocus`, so every focus stays `world` by construction — which is
why the fix went unverified on a real display until a live run: opening a slide, then opening the
command palette (closing the slide and handing focus back with a raise), left the palette open.
The flash-and-vanish failure this guards against did not reproduce.

**Accepted behavior loss:** `APP_ACTIVATED` no longer drives stack order for an unchanged
`front` — macOS restores the app's own window order on activation, and `stackOrder`
(intent) never moved while the app was away, so there is nothing to re-drive. Unverified
on a real display.

**Restored z-order is a literal replay of the pre-quit visual stack** (§5 step 11 task 7).
Each saved descriptor records its position in the machine's `stackOrder`
(`WindowDescriptor.stackIndex`), and restore imports that order via
`session-projection.ts orderRestoredWindowsBottomToTop()`. It used to be rebuilt from focus
recency, which inverted any window that had been shown without being focused. Live-verified
on macOS before the front-projection rewrite (visible run, quit→relaunch): the window
focused at quit restores focused and on top, with a clean 6/6 save set (no
background/overlay/bridge leakage).

---

## 7. Decisions locked — do not re-litigate

- **Satellite rule** is owned solely by `window-state.ts isSatelliteRegistration`: role
  `overlay`/`palette`, OR modal, OR `focusable === false`. Peeks/slides
  (`role:'quick-view'`) stay front-eligible.
- **Every window registers** with the machine. Some registrations no-op. There is no class
  of window that is exempt from the WM.
- **The switcher's "first Escape closes" is intended.** It replaced "first Escape clears
  search, second closes". Accepted behavior change; do not restore.
- **Peeks/slides never native-fullscreen** — enforced at the OS boundary (now: the backend),
  not by a reducer gate.
- **Duplicate registration re-pumps `WINDOW_REGISTERED` on purpose** — it is an idempotent
  merge, and the later spec is the richer one.
- **REJECTED: widening the Escape-grab predicate to live OS reads.** That reintroduces the
  rival-authority pattern this document exists to delete, and papers over a wrong `front`
  instead of surfacing it. It also violates the command+event-not-query constraint in §3.
- **REJECTED: the staged switcher seam** where `izui-state.ts` executes the overlay
  lifecycle and the machine merely decides. Split execution is the defect, not the fix.
