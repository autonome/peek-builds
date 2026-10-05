# Returning the user to a space's virtual desktop — plan

Goal: opening a space brings the user to the virtual desktop its windows were
on, with **no private window-server write** — the mac desktop provider is
reads-only (`desktop-provider-mac.ts`: `canPlaceWindows = false`,
`canShowDesktops = false`), and stays that way. The only switching mechanism
allowed is macOS itself switching when an existing window on another desktop is
raised. Whether macOS actually does that, and on which raise path, is the open
question this plan's experiments decide.

Vocabulary: "desktop" is the kernel's word for a macOS Space;
`DesktopId` values are the kernel ids the helper reports (e.g. `1`, `3`).
"Signal window" is the spike's 2x2 transparent window
(`features/spaces/background.js openSignalWindow()`, role `signal`).

## 1. What reading the code settles before any live run

### 1.1 The spike's raise was dropped inside the kernel — every live run so far tested nothing

`raiseSignalWindow()` calls `api.window.focus(id)`, which lands at
`tile-ipc.ts` handler `tile:window:focus` → `window-kernel-dispatch.ts
kernelShowRequested(machineId, true)` → commands `ShowWindow` + `RaiseWindow`
**without** `intent: 'user'`. `window-kernel.ts decide()` turns `RaiseWindow`
into `FocusRaiseRequested` (machine intent), and `react()`'s raise-request diff
only emits a native `RaiseWindow` effect when `admitsFocus()` passes.
`admitsFocus` requires `withinReach()`, and `withinReach` for a non-named
request requires `onCurrentDesktop()` — which is exactly false for a window on
another desktop (and also false for every window while a desktop switch is
unread, `desktopUnread()`). So:

- **A raise of a window the kernel places on another desktop never reaches the
  backend at all.** No `raise-realized` line, no native call, no chance for
  macOS to switch. The spike's one mechanism was structurally inert in the one
  case it was built for. This fully explains runs 1–3 showing "no desktop
  change" without diagnosing anything about macOS.
- A second drop condition: `admitsFocus` also requires
  `state.appActive || requester.user`. A machine raise while Peek is not the
  active app is dropped too.
- The hold-above-other-apps substitute (`FocusRaiseRequested` arm in
  `evolve()`) also asks `withinReach`, so an off-desktop window is not even
  held: the request is a complete no-op.

### 1.2 The kernel already has the intended mechanism: a *named* raise

`window-kernel.ts FocusRequester` distinguishes `user` from `named`
(`SWITCHER_PICK = { user: true, named: true }`). `withinReach` admits a named
request to an off-desktop window, and `pushRaise()` then emits `ShowDesktop`
**before** the `RaiseWindow`. The executor
(`window-kernel-executor.ts`, `ShowDesktop` case) documents the design: a
backend that cannot switch desktops "makes no port call, and **the raise takes
the user to the window's desktop**" — it logs `effect-show-desktop` and lets
the native raise do the switching. Experiment E2 confirmed macOS honours
that while the app is active, and drops the switch when the raise fires
during the app's own activation — see E2's result.

Today exactly one user-reachable path issues a named raise: the window
switcher. `tile-ipc.ts` handler `tile:window:set-overlay-focus-target` arms the
selection latch (`kernelArmSelectionFocus`), and the switcher window's
`WindowClosed` spends it (`window-kernel.ts evolve()`, `WindowClosed` arm →
`lastFocusAssert` with `switcherPick: true` → `SWITCHER_PICK` in `react()`).
Nothing in the spaces feature can issue a named raise yet.

**Decided: space entry is a second legitimate named-raise initiator.**
Opening a space is explicit user intent to go where that space's windows are
— the same "the user named this very window" quality `FocusRequester.named`
encodes for a switcher pick — so the switch-desktops privilege extends to the
space-entry path rather than staying specific to the switcher. Experiment E3
builds that path.

### 1.3 Where "which desktop a space lives on" is actually recorded

- Every snapshot row records each window's kernel desktop:
  `session.ts saveSessionSnapshot` (after
  `refreshDesktopsBeforeSave()` on the deliberate paths) projects
  `WindowRecord.desktop` into the descriptor, and the save log line carries
  `desktop=` per window. This is the durable record.
- The signal window records something else: the desktop the **user was on at
  the moment of leaving** (`desktopOnShow()` stamps the current desktop at
  show; the placements read then reports the truth). When the user wanders to
  another desktop before switching spaces, the signal window is on the wrong
  desktop by construction — the handoff's recorded design flaw.
- With a reads-only provider nothing can move a window between desktops, so a
  signal window can never be *placed* on the space's recorded desktop; it can
  only ever be *created* where the user happens to be. Consequence, worth
  stating plainly: **under the reads-only constraint, the reachable goal is
  "return the user to the desktop where the space's windows actually sit",
  and the only windows that can sit anywhere other than the current desktop
  are windows that survived there from an earlier visit.** Restored windows
  always open on the desktop the user is on (nothing places them), so after a
  restore the space lives wherever the user ran the command. The saved
  `desktop=` values are recorded but nothing acts on them
  (`applyDesktopRestore` returns at its `canPlaceWindows()` guard, logging
  `desktop-restore-skipped`).

### 1.4 The desktop-choice rule, and what it means for the signal window

**Decided: which desktop opening a space goes to.** The target desktop is
derived from the snapshot's recorded per-window desktops (the `desktop=`
values `saveSessionSnapshot` writes), never from where the signal window
happens to sit:

- If any of the target space's recorded windows are on the current desktop,
  no switch — the space is (at least partly) already here, and a switch
  would move the user away from windows they are about to get back.
- Otherwise, switch to the desktop holding the most of the space's recorded
  windows; ties break to the nearest desktop in swipe order (the helper's
  `layout()` desktop order). Most-windows wins because it minimises the
  number of the space's windows ending up off the user's desktop after the
  restore opens the rest where the user lands.
- Noted alternative, not taken: nearest-in-swipe-order as the primary rule
  (cheapest gesture to undo). Kept here in case most-windows proves
  disorienting in use.

The signal window remains the only *mechanism* — the one window of a space
that survives on another desktop between visits, hence the only thing a
native raise can target — but it is not the *record*. Its desktop is "where
the user left", which matches the rule's target only when the user left the
space from the desktop its windows were on. So the raise is gated: compute
the target from the snapshot, and raise the signal window only when the
kernel places it on that target desktop (`pushRaise()` can only ever emit
`ShowDesktop` for the raised window's own recorded desktop, so raising it
anywhere else could not reach the target anyway). When the gate fails — the
signal window sits elsewhere, or there is no signal window — no switch
happens and the space opens on the current desktop, the safe behaviour.

Experiment E2 passed for the active-app case (see its result), so the
raise-based mechanism exists and the fallback (remove the spike, keep the
safe behaviour) applies only if E3's wiring cannot be made to work. The
E2-found constraint carries into E3: the raise must not fire during the
app's own activation, or macOS drops the switch.

## 2. Code paths end to end

Each entry names the path and what it does with a window on another desktop.

- `features/spaces/background.js openSpaceNow()` — brackets the switch
  (`api.session.beginWorkspaceSwitch` → `tile-ipc.ts
  tile:session:begin-workspace-switch` → `session.ts beginWorkspaceSwitch`),
  then `closeCurrentWorkspaceWindows()`, then `enterWorkspace()`, then
  `setActiveWorkspace`. Desktop-blind itself; everything desktop-related
  happens in the callees.
- `features/spaces/background.js closeCurrentWorkspaceWindows()` — saves the
  outgoing space (`tile:session:save-workspace-snapshot`, which awaits
  `refreshDesktopsBeforeSave()` so the saved `desktop=` values are current),
  opens the signal window (spike), then closes every visible content-role
  window regardless of desktop (`api.window.close` does not ask where the
  window is — a content window parked on another desktop is closed too).
- `features/spaces/background.js enterWorkspace()` — declares the incoming
  space for new windows, `raiseSignalWindow()` (spike; dropped per 1.1 when
  the signal window is off-desktop), restores the snapshot
  (`tile:session:restore-workspace-snapshot`), `closeSignalWindow()` (spike),
  empty-space fallback window if nothing restored.
- `main/tile-ipc.ts` session handlers — thin gates:
  `tile:session:save-workspace-snapshot` (refresh desktops + keyed save),
  `tile:session:restore-workspace-snapshot` (keyed
  `restoreSessionSnapshot(..., isWorkspaceSwitch: true)`),
  `begin-workspace-switch` / `set-active-workspace` (ambient-save bracket).
  No desktop logic of their own.
- `main/session.ts saveSessionSnapshot()` — projects kernel state; each
  descriptor carries the kernel's last known desktop for the window, wherever
  it is. A window on another desktop is saved like any other (visibility, not
  desktop, decides membership).
- `main/session.ts restoreSessionSnapshot()` — opens every descriptor's window
  on the current desktop (no placement writes exist), collects
  `restoredDesktops`, calls `applyDesktopRestore()` before the focus block.
  The focused-descriptor raise at the end goes through machine-routed show
  dispatches; a freshly opened window is on the current desktop, so the
  off-desktop drop rule does not bite here.
- `main/session.ts applyDesktopRestore()` — returns immediately
  (`desktop-restore-skipped`) because `canPlaceWindows()` is false. The
  placement loop and `ShowDesktop`-wait logic (`awaitDesktopSwitchRead`) are
  inert until a backend with writes exists.
- `main/session.ts refreshDesktopsBeforeSave()` — one provider read via
  `getKernelExecutor().refreshDesktops('before-save')`; read-only.
- `main/window-kernel.ts` raise rules — `admitsFocus` / `withinReach` /
  `onCurrentDesktop` drop machine and plain-user raises of off-desktop
  windows (1.1). A named request passes, and `pushRaise()` prefixes
  `ShowDesktop` (1.2). `frontWindowHere()` keeps every "focused/topmost"
  answer on the current desktop, so commands never act on a window parked
  elsewhere.
- `main/window-kernel-executor.ts` — `ShowDesktop` effect: port call only when
  `canShowDesktops()` (never, today); otherwise logs `effect-show-desktop`
  and relies on the following raise. `canPlaceWindows()` /
  `canShowDesktops()` are also false under headless.
- `main/electron-window-backend.ts` — `raiseWindow()` (plan: reorder /
  take-key / show-and-take-key, `app.focus({steal: true})` only for a
  user-intent raise of a non-panel, with 250/600 ms re-asserts) and
  `showWindow()` → `performOsShow()` (logs `os-show`, then `show-outcome`
  with `desktopBefore`/`desktopAfter`/`onCurrentDesktop`, then triggers a
  desktop read). What AppKit does when these native calls land on a window
  assigned to another Space was settled by experiment E2: it switches to
  that Space when the app is already active, and drops the switch when the
  raise fires during the app's own activation.
- `main/desktop-provider-mac.ts` — spawns the helper, reads `layout` and
  `placements`. Reads only; `placeWindow`/`showDesktop` return false without
  calling the helper. `probePlace` exists for a write test and must stay
  unused.
- `main/desktop-sync.ts syncDesktops()` — the one read loop: layout →
  `CurrentDesktopChanged` per screen → placements → `desktopsRead`. The log
  pair `sync-desktops-start` / `sync-desktops-end placements=wm-N:<desktop>`
  is the ground truth every experiment reads.

Commits `a48050ca` (desktop re-reads on move/focus/app-active/resign/save)
and `28722df7` (slow helper reply) sit entirely on this read path —
`desktop-sync.ts` calls only `provider.layout()` and `provider.placements()`,
and the mac provider's write methods return false without touching the
helper, so both commits are read-only (closing a "Not verified" item in the
handoff).

## 3. Core actions and the desktops involved

For each action: D_user = desktop the user is on when the command runs (the
command palette runs where the user is, so this is also the desktop the
command executes on); D_out = desktop(s) of the outgoing space's windows;
D_saved = per-window `desktop=` in the target's snapshot; D_sig = desktop of
the target's signal window (spike only).

| Action | Path | Desktop behaviour today |
|---|---|---|
| open space (default → named, first entry) | `openSpaceNow` → `enterWorkspace` fallback window | Home window opens on D_user. No snapshot, no signal window for the target. |
| open space (re-entry) | `openSpaceNow` → restore | All windows open on D_user regardless of D_saved; `applyDesktopRestore` skipped. Signal raise dropped if D_sig ≠ D_user (1.1). |
| switch space (named → named) | `switchSpace` → `openSpace` | Same as open; outgoing windows on any desktop are closed (sweep is desktop-blind). |
| close space | `closeSpace` → `openSpace(default)` | Same path with the default as target; the default's snapshot restores on D_user. |
| create space | `createSpace` | Tag work only — no window or desktop interaction at all. |
| move to space (inactive target) | `moveToSpace` | Retag + `addWindowToWorkspaceSnapshot` + close. The snapshot row keeps the window's kernel desktop as of the last save of that window; the close removes the only live anchor. |
| move to space (active target) | `moveToSpace` | Retag only. |
| quit | `entry.ts` before-quit → `saveSessionSnapshot` | Ambient save writes the ACTIVE workspace's row (named space included), `desktop=` recorded per window. |
| relaunch / boot restore | `entry.ts` → `restoreSessionSnapshot(isColdStart, default key)` | Restores the DEFAULT row only, on the desktop the app launches on. A named space active at quit comes back only via its own row on next entry. |

## 4. Permutations that matter

The dimensions, and which experiments cover them:

1. **D_user vs D_out at leave time** — equal (signal window lands where the
   space lived) vs different (signal window records the wrong desktop). E4.
2. **D_user vs D_sig at entry time** — equal (raise is admitted but there is
   nothing to switch to; run 2's invalid case) vs different (raise dropped
   today per 1.1; the case E2/E3 must reach via a named raise). E2, E3.
3. **First entry vs re-entry** — first entry has no snapshot and no signal
   window; only re-entry can switch desktops under any design. Covered by
   setup of E3.
4. **Empty vs non-empty target snapshot** — empty restore (`restored == 0`)
   opens the fallback window (named) or nothing (default). Interacts with the
   run-3 symptom. E5.
5. **Signal window's app active vs inactive** — Peek inactive additionally
   drops machine raises (`admitsFocus` app-active clause); a named raise is
   `user: true` and passes. Palette-driven switches always run with Peek
   active, so this dimension matters only for CLI/debug-eval-driven runs. E2
   runs both.
6. **Desktop-switch read pending** — between a switch notice and the next
   placements read, `onCurrentDesktop` is false for every window
   (`desktopUnread`), so even a same-desktop machine raise can drop if issued
   immediately after a switch. The 1.5 s sleep in `raiseSignalWindow()`
   papered over this; experiments must read `sync-desktops-end` rather than
   sleep.

## 5. Experiments, in order

Ground rules: profile `signal-spike`; every pass/fail is a log line in
`$HOME/Library/Application Support/Peek/<profile>/logs/main.log` or a
`peek-cli debug-eval` read — never "what did you see". Main-process logging
for the raise path (handoff next-step 2, via `main/window-diag.ts wmLog()`)
must land before the live experiments, since `[ext:spaces]` console lines
never reach main.log.

- **E1 — kernel drop rule, unit level (no user, no app).**
  Hypothesis: a machine or plain-user `RaiseWindow` of a window whose record
  names a non-current desktop produces no `RaiseWindow` effect; a
  switcher-pick focus assert produces `ShowDesktop` + `RaiseWindow`.
  Setup: main-process unit test against `window-kernel.ts` (`evolve`/`react`)
  with a two-desktop layout. Check `window-kernel.test.ts` for existing
  coverage first — the rules are commented as F9/rule 1/rule 5, so this may
  already be green.
  Pass: effects as hypothesized. Fail: the 1.1 analysis is wrong — stop and
  re-read before any live run.
  **Result: PASS, via existing coverage.** `window-kernel.test.ts` suite
  "a focus the manager makes stays on the current desktop" already holds the
  exact hypothesis: "a raise request without user intent for a window on
  another desktop is not emitted and mints no token", "a raise request with
  user intent for a window on another desktop is not emitted: user intent
  does not name the window (rule 5)", "a switcher pick of a window on
  another desktop asks for its desktop, then raises it with user intent and
  a token" (asserts the `ShowDesktop` + `RaiseWindow {intent: 'user'}` pair
  in order), and "a switcher pick of a window on the current desktop asks
  for no desktop". All green against the built `dist/main/
  window-kernel.test.js` (`--test-name-pattern 'another desktop'`: 10 pass,
  0 fail; `'switcher pick'`: 2 pass, 0 fail). The 1.1 analysis stands; no
  new test needed.

- **E2 — does a native named raise switch desktops? (needs a person on a
  second desktop; the decisive experiment).**
  Hypothesis: closing the window switcher on a pick whose target sits on
  another desktop makes macOS switch to that desktop (the executor's
  documented intent, 1.2).
  Setup: launch the app; open two content windows; the person drags one to
  desktop 2 by hand (Mission Control) and returns to desktop 1; wait for a
  `sync-desktops-end` whose `placements=` shows the two windows on different
  desktops (this read fires on move/focus/app-active triggers from
  `a48050ca`; `peek-cli debug-eval` can force a save to trigger one).
  Gesture (the only one): open the window switcher, pick the desktop-2
  window, confirm.
  Pass: main.log shows `effect-show-desktop desktop=<2's id>` followed by
  `raise-realized` for the target, then a `CurrentDesktopChanged`/
  `sync-desktops-end` whose screen-current is the target's desktop.
  Fail: same `effect-show-desktop` + `raise-realized` but the next
  `sync-desktops-end` still shows the old current desktop.
  Variant (same sitting): repeat with Peek NOT the active app (click another
  app first, trigger the switcher by global shortcut) to cover dimension 5.
  **Result: PASS when the app is active; the switch is dropped by macOS when
  the raise fires during activation.** Three picks of wm-11
  (`https://en.wikipedia.org`, dragged to kernel desktop 3), decided from
  `main.log`:
  - Active variant (Peek frontmost, pick at 08:31:21.731Z): PASS —
    `effect-show-desktop desktop=3` + `raise-realized id=wm-11 …
    intent=user`, then `sync-desktops-end trigger=space-changed` with
    `switchesSeen` 0→1 at 08:31:22.355Z. macOS switched to the target
    desktop (~0.6 s pick-to-switch).
  - Inactive variant, first pick (Peek not active, 08:33:48.750Z): FAIL —
    the same `effect-show-desktop` + `raise-realized` pair fired, with
    `activation-decision kernelActive=false appFocusCalled=true` and
    `app-did-become-active` following, but `switchesSeen` stayed at 4, no
    `space-changed`, nothing visible happened.
  - Inactive variant, immediate retry (08:33:54.480Z — Peek now active from
    the first attempt's app activation): PASS — same pair with
    `kernelActive=true`, `space-changed` with `switchesSeen` 4→5 at
    08:33:54.891Z, switch and focus both landed.
  Conclusion: **the native named raise is a working switch mechanism, but
  only while the app is already active.** A raise fired during the app's own
  activation succeeds as a raise (and the activation succeeds) yet macOS
  drops the desktop switch. Consequences for E3's design: palette-driven
  space entry always runs with Peek active, so the primary path needs no
  change; an entry driven from the CLI or any background path must defer
  the named raise until activation completes (candidate gate: dispatch the
  raise only once the app-active report has landed — the backend's
  `app-did-become-active` / the kernel's `appActive` — rather than
  alongside the activation). E3 proceeds.

- **E3 — named raise wired into space entry (only if E2 passes; code change,
  then one person-gesture).**
  Hypothesis: raising the target space's signal window through a named
  request before the restore switches desktops, and the restore then opens
  the space's windows on the switched-to desktop.
  Setup: expose a named raise to the spaces path (smallest honest shape: a
  kernel command variant carrying `named` intent, mirrored through a
  `tile:window:` handler gated like `focus`) — space entry is an approved
  named-raise initiator, see 1.2. `raiseSignalWindow()` uses it; replace the
  1.5 s sleep with a wait for the next `sync-desktops-end` covering the
  switch (`awaitDesktopSwitchRead` already exists on the executor).
  Gesture: person leaves space alpha while on desktop 2 (its windows also on
  desktop 2 — dimension 1 equal case), moves to desktop 1, runs `open space
  alpha`.
  Pass: log shows the named-raise line for the signal window, a current-
  desktop change to desktop 2's id, and the restored windows' `show-outcome`
  with `desktopAfter` = desktop 2's id.
  Fail: desktop unchanged, or restored windows land on desktop 1 (raise
  switched too late / restore raced the switch).
  **Result: PASS.** Code landed as the named-raise change (`window-kernel.ts`
  `named` intent → `SWITCHER_PICK`; `tile:window:focus {named:true}` with
  the bounded app-active wait and the `awaitDesktopSwitchRead` settle;
  `raiseSignalWindow()` uses it, no fixed sleep). Live run decided from
  `main.log` at 09:05:20.573Z: `raise-requested via=tile:window:focus id=22
  machineId=wm-22 named=true` → `effect-show-desktop desktop=3` →
  `raise-realized id=wm-22 … intent=user` → `space-changed` with
  `switchesSeen` 6→7 and `appActive=true` → `raise-named-settled
  appActiveAtDispatch=true outcome=read` → `restore-begin n=4` /
  `restore-end restored=4 failed=0`, all four restored windows'
  `show-outcome` with `desktopBefore=3 desktopAfter=3`. So the full chain
  holds: entering a space raises its tiny 2x2 signal window as a named
  request, macOS switches to its desktop (a 2x2 transparent window is
  enough — the E2 open question about window size is closed), the restore
  waits for the switch read and opens the space's windows on the
  switched-to desktop. The `close space` leg of the same run also switched
  (the earlier `space-changed` sequence in the log), so both directions of
  a round-trip work.

- **E4 — the raise gate holds when the signal window sits off-target (only
  if E3 passes; one gesture).**
  The desktop-choice rule of 1.4 derives the target desktop from the
  snapshot's recorded per-window desktops; the raise is gated on the signal
  window actually being on that target.
  Status: waiting on its code — the named-raise change deliberately did NOT
  include the 1.4 gate, so `raiseSignalWindow()` currently raises the
  signal window wherever it is. The gate (read the target space's snapshot
  `desktop=` values, compare with the signal window's kernel desktop, skip
  the raise and log the decision on mismatch) is its own commit-sized
  change and must land before this experiment's pass line can exist.
  Hypothesis: when the signal window's desktop disagrees with the
  snapshot-derived target (the user left the space from a different
  desktop), the gate skips the raise, no switch happens, and the space's
  windows open on the current desktop.
  Gesture: person has alpha's windows on desktop 2, moves to desktop 3,
  opens another space from there (alpha's signal window lands on 3), then
  re-opens alpha from desktop 1.
  Pass: log shows the gate's skip line (target=2, signal-window desktop=3),
  no `CurrentDesktopChanged`, and the restored windows' `show-outcome` with
  `desktopAfter` = desktop 1's id.
  Fail: a switch to desktop 3 (the gate did not hold) or to desktop 2 (a
  switch happened without a raisable window there — would mean a write
  leaked in somewhere).

- **E5 — run-3 symptom: no windows on screen after `close space` (no new
  gesture; first action of the next sitting).**
  Hypothesis: the default space's snapshot was empty on a fresh profile boot,
  so the restore had nothing to open (and no fallback exists for the
  default, by design — `enterWorkspace()` restores nothing and opens nothing
  when `isDefault`).
  Method: read the existing
  `$HOME/Library/Application Support/Peek/signal-spike/logs/main.log` around
  the third run: the `restore-begin n=` / `restore-end restored=` pair for
  the default key, the save line for the default row before the switch, and
  any `effect-close` sweep lines after. No app launch needed unless the log
  has rotated; then reproduce unattended via `peek-cli` on a fresh scratch
  profile (open space, close space, read the same lines).
  Pass (hypothesis confirmed): `restore-begin n=0` for the default row.
  Fail: n>0 with failures — different bug, diagnose before E3 builds on the
  close-space path.
  **Result: hypothesis REFUTED — the default row was not empty, and the
  restore succeeded.** The log (2026-10-05T06:50:45–06:58:42Z segment, no
  rotation) shows the full third run:
  - `close space` ran at 06:51:28 with the user on kernel desktop `1` (the
    signal window wm-18 opened there, the palette wm-7 placed there), while
    the outgoing space's windows wm-16/wm-17 sat on desktop `3`; the sweep
    closed them from the other desktop without issue (desktop-blind close,
    as section 2 states).
  - The default restore was `restore-begin n=3 … restored=3 failed=0`:
    `peek://spaces/home.html`, `peek://spaces/home.html?signal=1`,
    `peek://app/settings/settings.html`. All three opened on desktop `1`
    (`show-outcome … desktopBefore=1 desktopAfter=1`, then
    `sync-desktops-end … wm-19:1,wm-20:1,wm-21:1`), all three finished
    loading (`all-loaded n=3 finished=3`), and the focused one was raised
    (`raise-realized id=wm-19 … plan=take-key intent=user`).
  - `switchesSeen` stayed at 2 from 06:50:46.7 to the end, so no desktop
    switch happened after the restore: user and windows were on the same
    desktop, per every reading available.
  So "no windows of any kind on screen" is not explained by an empty
  snapshot, a failed restore, or a wrong desktop. What the log does show:
  Peek resigned active 2 s after the restore (`trigger=app-resign`
  06:51:32.7), so another app's windows may simply have buried the three
  restored ones; nothing further is decidable from this log. Two defects it
  DOES prove, both to fix in the real implementation:
  1. **The default snapshot had been polluted by the spike**: the default
     key saves everything on screen, so a stale signal window
     (`home.html?signal=1`) was captured by an ambient save and restored as
     an ordinary window. Session saves must exclude role `signal` windows
     (or the real implementation's equivalent) from every snapshot.
  2. A `raise-dropped` diagnostic already exists in
     `window-kernel-executor.ts` (fields: via, appActive,
     desktopSwitchCount/Read, onCurrentDesktop, recordDesktop,
     currentDesktop) — the run's one dropped raise (`id=wm-18 …
     alreadyKey=true`) was logged by it. The logging step before the live
     experiments only needs the request side (`tile-ipc.ts
     tile:window:focus`), not a new drop log.

Unattended vs person: E1 fully unattended (unit test). E5 unattended (log
reading / scratch-profile CLI drive). E2–E4 need a person once per
experiment: creating a second desktop, dragging a window there, and
performing the single gesture are user actions by the division-of-labor rule;
everything else (instrumentation, launch, log reading, revert) is not. No
experiment asks the user what they saw, and none may run before its
pass/fail line is named here.

## 6. Exit conditions

- E2 fails both variants → no raise-based mechanism exists under the
  reads-only constraint. Remove the spike commits' signal-window code, keep
  the safe behaviour (spaces open where the user is), land the useful
  commits (handoff next-step 5).
- E2 passes, E3 fails → the mechanism exists but the spaces wiring is wrong;
  E3's log decides whether the switch or the restore ordering is at fault
  before any redesign.
- E3 passes → confirm the gate with E4, then replace the spike with
  reviewed code implementing the decided desktop-choice rule of 1.4: signal
  window creation stays in `closeCurrentWorkspaceWindows()`, the raise
  becomes the named variant gated on the snapshot-derived target desktop,
  and the sleep becomes the switch-read wait.
