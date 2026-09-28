# Desktops are kernel state: implementation notes

Requirements, rules, model and acceptance checks: `specs/kernel-desktops.md`. This file holds what
is specific to building it in this repo: motivation, the baseline, the decisions to pull into the
kernel, the order of work and probe findings.

## Motivation

Peek item `a0ea0c2d`; parked track `close-raises-other-desktop`. Defect on `main`: with another app
in front and two macOS desktops, a page opened from the palette on desktop 2 can follow the user to
desktop 1, drop behind the other app, and vanish from desktop 2, because the window kernel knows
nothing about desktops and every desktop rule in `docs/design/window-rules.md` is decided by
native-call timing.

## Baseline on `main`

- `electron-window-backend.ts attachSpaceChangeListener` only logs `space-changed` (macOS only);
  no event reaches the kernel.
- `window-kernel.ts State` has no desktop. `WindowRecord.desktopMembership` records intent only
  (`'follow'` / `'anchor'`), set for canvas windows by role (`ipc.ts` window-open handler,
  `kernelSetDesktopMembership(…, desktopMembershipForRole(role))`) and on key-reuse; page hosts
  from `ipc.ts assembleHybridPageHost` never get it and land on the desktop current at first show.
- `ElectronWindowBackend.setDesktopMembership` realizes `'anchor'` as the all-desktops-on-then-off
  pair, moving the window to the current desktop; no-op off macOS.
- A transient page-host window is built with `type: 'panel'` (`ipc.ts`, `pageOpensTransient()`
  branch, `options.type = 'panel'`); Electron keeps such windows on every desktop
  (`electron_ns_panel.mm setCollectionBehavior:`).
- `isTransientPageHost` reads only `appActive`, `key` and the record; a desktop switch replaces a
  transient page-host window only via the `OsFocusLost` from
  `ElectronWindowBackend.armBlurSettle` → `kernelOsFocusSettled`, so 5c and 5d are
  indistinguishable.
- `react` emits `ReopenAsOrdinaryWindow { id }`; `ipc.ts reopenWindowAsOrdinary()` opens the
  reopened window then closes the transient page-host window via a promise chain; the reopened
  window lands on the desktop switched to.
- `successorOnHide()` (`WindowHidden` / `WindowClosed` arms of `evolve`) picks the prior key window,
  else `topmost(state, isContentWindow)`, ignoring desktops. Raising a window on another desktop
  switches desktop (`raise-realized id=wm-3` then `space-changed`).
- Switcher selection (`tile-ipc.ts` → `kernelArmSelectionFocus`) is spent in the `WindowClosed` arm
  as a `lastFocusAssert`, which carries no user intent.
- Hybrid URL dedup in the `ipc.ts` window-open handler (`findHybridWindowByUrl` →
  `kernelShowRequested(reusedId, true)`) runs before the `pageOpensTransient()` check and reuses a
  window on any desktop.

Known gap: modal browser windows are also built with `type: 'panel'` on macOS (`ipc.ts`,
`options.modal === true` branch) but are not `nonActivating`, so the backend does not declare them
on every desktop. The macOS helper's placement read reports them; revisit before the F9 gate.

## Out-of-kernel decisions to move

One commit each, order per "Order of work":

1. **`ipc.ts reopenWindowAsOrdinary()`** (open → close → focus by promise chain) → the `replaces` /
   `replacedBy` state in the spec; the function keeps only building the reopened window. Also
   replaces the parked track's `takesKey` payload.
2. **`ipc.ts` hybrid URL dedup** → kernel predicate `admitsReuse(state, record)`; the
   `pageOpensTransient()` check moves ahead of the dedup. The rule check watches for a hidden
   window re-shown on a desktop that is not current.
3. **`window-kernel-executor.ts` `RaiseWindow` / `planRaise`** → `react` stops emitting what the
   `'suppressed'` plan (app inactive, no user intent) drops, together with F9; `planRaise` keeps
   headless and non-activating realization choices.
4. **`electron-window-backend.ts` focus filters** (`win.on('focus')` drops reports on
   `pendingStackingFocus`, `pendingHideProvokedFocus`, `activationFocusTarget`) → the kernel records
   each expectation when it emits the causing effect (stacking replay, hide of the key window,
   activation with `pendingColdStartFocus`) and classifies the report; the backend reports every
   focus with its raw cause. `hideProvokesFocusReassignment()` becomes a kernel fact likewise.
5. **`electron-window-backend.ts appResignSettleTimer`** (reads izui overlay cooldowns, drops the
   settle) → the timer stays; the overlay transition becomes a kernel fact that makes
   `AppResignSettled` inert in `evolve`.
6. **`main.ts` devtools-opened / devtools-closed** (`kernelAssertFocus()` on the topmost content
   window, possibly on another desktop) → retargeted to the host whose devtools opened or closed by
   commit `5f888241` of track `close-raises-other-desktop`, cherry-picked here; F9 also refuses a
   machine focus elsewhere.

Stays outside: `armBlurSettle` (translates Electron's event order into "focus left every window";
decides no rule).

## Relationship to `close-raises-other-desktop`

- One commit of the parked track carries over: `5f888241` (the devtools-opened / devtools-closed
  handlers in `main.ts` assert focus on the devtools host, not the topmost content window). It is
  cherry-picked into this track at commit 12 below (decision 6). Its lines in
  `docs/design/window-rules.md` and `docs/design/window-rules-audit.md` that describe the parked
  track's F7 are dropped in favour of the spec's F7 when resolving the pick.
- Everything else in the parked track is superseded by the spec's F7 and F9 design: its transient /
  application split, its removal of the successor choice for application-window closes, and its
  focusing of the reopened window on activation (covered by the spec's close and focus ordering).
- The parked track is retired once this track lands; it is not rebased.

## Order of work

The macOS helper and its probe come before the kernel reshape because everything rests on the
helper's reads; if they fail, nothing has yet been built on them.

1. **Landed as `250051ad`** (minted ids, `DesktopChanged`); reshaped by commit 5.
   - Survives: `DesktopId`; `WindowRecord.desktop`; `WindowRecord.onEveryDesktop` with its
     registration plumbing (`WindowRegistered` event and `RegisterWindow` command fields,
     `window-machine.ts registerWindowWithMachine`, `ElectronWindowBackend.registerWindow` returning
     it for windows built with `type: 'panel'` on macOS); `isOnEveryDesktop`; the provisional stamp
     on a genuine `WindowShown` (`desktopOnShow`, changed to read the window's screen's current
     desktop instead of `State.desktop`); the `attachSpaceChangeListener` subscription as switch
     trigger; the `native-blur` and `os-focus-left-app` log lines; desktop-state tests not
     depending on minting.
   - Removed by commit 5: `State.desktop`, `State.desktopCounter`, `mintedDesktopId`,
     `DesktopChanged` and its `evolve` arm, `kernelDesktopChanged` in `window-kernel-dispatch.ts`,
     the `focused` read in `attachSpaceChangeListener`, the stamp in the `OsFocusGained` arm, and
     tests for minting, `name`, `focused` stamping and focus stamping.
   - Changed by commit 5: `onCurrentDesktop` keeps name and meaning over the new state; the
     `space-changed` log line prints each screen's current desktop and each window's
     `id:screen/desktop|*|?:v|h` from the new fields.
2. **Rename the old identifiers, log lines and prose to the transient-window names**, no behaviour
   change, own commit. The code and docs carry an older, retired name for the transient page-host
   window. In the table, `⟨old⟩` stands for that retired two-word term in the case form of the
   name it sits in: camelCase or PascalCase in identifiers, upper snake case in constants,
   hyphenated in log lines, file names, profile names and rule labels.
   `grep -rn -i 'side.\?task' apps/desktop docs specs` lists every occurrence and returns nothing
   once the step is done.

   | Old | New | Kind |
   |---|---|---|
   | `is⟨old⟩` | `isTransientPageHost` | kernel predicate (`window-kernel.ts`) |
   | `pageOpensAs⟨old⟩` | `pageOpensTransient` | open-time predicate (`izui-roles.ts`) |
   | `⟨old⟩Setup` | `transientPageHostSetup` | executor test fixture |
   | `⟨old⟩InFlight` | `transientPageHostHoldingKey` | kernel test fixture |
   | `⟨old⟩_REOPEN_STRIP` | `TRANSIENT_PAGE_REOPEN_STRIP` | constant (`ipc.ts`) |
   | `⟨old⟩-reopen` | `transient-page-reopen` | log line, and the `[…]` prefix of two `console.error` lines |
   | `⟨old⟩-reopen-dropped` | `transient-page-reopen-dropped` | log line |
   | `page-opens-as-⟨old⟩` | `page-opens-transient` | log line |
   | `⟨old⟩-standin-misplaced` | `transient-placeholder-misplaced` | planned log line, since dropped with the placeholder window; only docs carried the old name |
   | `G13 ⟨old⟩-ends` | `G13 transient-page-ends` | rule label in `window-rules.md` |
   | `specs/⟨old⟩-ends-on-blur.md` | `specs/transient-page-ends-on-blur.md` | spec file, moved with `git mv` |
   | `⟨old⟩Escape` (type), `⟨old⟩_ESCAPE`, `⟨old⟩Escape` (parameter) | `TransientPageEscape`, `TRANSIENT_PAGE_ESCAPE`, `transientPageEscape` | already removed from code; named in the docs' history |
   | `agent-⟨old⟩-1` | `agent-transient-page-1` | profile name in a live-check recipe |
   | the retired term in prose | "transient page-host window" for the window; "replaced by the reopened window" for its end | comments, test titles, assertion messages, doc prose |

   Files, with what each carries:
   - `apps/desktop/main/window-kernel.ts`: `is⟨old⟩` (definition and its use in `react`), comments.
   - `apps/desktop/main/window-kernel.test.ts`: `is⟨old⟩` import and uses, `⟨old⟩InFlight`,
     describe and test titles.
   - `apps/desktop/main/window-kernel-executor.test.ts`: `⟨old⟩Setup` and its comment.
   - `apps/desktop/main/izui-roles.ts`: `pageOpensAs⟨old⟩` and its comment.
   - `apps/desktop/main/izui-roles.test.ts`: `pageOpensAs⟨old⟩` import and uses, describe and test
     titles.
   - `apps/desktop/main/ipc.ts`: `pageOpensAs⟨old⟩` import and call, `⟨old⟩_REOPEN_STRIP`, the log
     lines `⟨old⟩-reopen`, `⟨old⟩-reopen-dropped` and `page-opens-as-⟨old⟩`, the `console.error`
     prefixes, comments on `reopenWindowAsOrdinary()` and in `registerWindowHandlers`.
   - `apps/desktop/main/window-backend.ts`, `apps/desktop/main/electron-window-backend.ts`,
     `apps/desktop/main/window-escape.ts`: comments.
   - `apps/desktop/main/window-escape.test.ts`: one test title.
   - `apps/desktop/tests/desktop/cmd-url-unfocused.spec.ts`: header and inline comments, one test
     title, one assertion message.
   - `docs/design/window-rules.md`: prose, the G13 label, the removed `⟨old⟩_ESCAPE` constant.
   - `specs/⟨old⟩-ends-on-blur.md`: moved as above; prose, log lines, the three removed Escape
     names, the profile name.
   - `specs/cmd-url-linux-failures.md`: prose.

   Verify: the `tracks.json` verify, `node scripts/check-platform-leak.mjs`, and the grep above
   returning nothing.
3. **Remove the first probe's hooks**: `installDesktopProbe` and its `probe*` members in
   `electron-window-backend.ts`, own commit.
4. **Providers and the macOS helper, no kernel change**: `desktop-provider.ts`,
   `desktop-provider-fallback.ts`, `main.swift`, `build-desktop-helper.mjs`, the `extraResources`
   entry, `desktop-provider-mac.ts`, the fail-safe, the `check-platform-leak.mjs` additions, and
   temporary probe hooks behind `PEEK_DESKTOP_PROBE=1`. The kernel has no desktop events yet, so the
   probe hooks are the provider's only report sink: they log its reads directly. Then the probe (the
   spec's macOS provider acceptance check) on a real Mac with a person. Stop and report if ids are
   not stable across returns; never fall back to letting the page follow the user. Two backend
   fixes found by the probe follow here, one commit each: the shared page chrome window on every
   desktop (`hybrid-overlay.ts ensureOverlay()`), and the transient page-host window pinned to the
   desktop it is shown on, no longer declared `onEveryDesktop`.
5. **Kernel model reshape.** Kernel: `State.screens` / `State.desktops`, `WindowRecord.screen`, the
   three events, `isCurrentDesktop`, reshaped `onCurrentDesktop`.
   Backend: the report → event loop, fed by
   whichever provider started. No rule reads the new state; behaviour unchanged on every platform
   (pinned by the property test).
6. **Kernel `replaces` / `replacedBy` close and focus ordering for the 5e reopen** (decision 1).
   Add the switcher's cross-desktop reach under rule 1 of `docs/design/window-rules.md`. Remove
   probe hooks if still present.
7. Done ahead of the reshape, `84a123ee`: a transient page-host window that loses focus with the
   app inactive (click-away, desktop switch) closes instead of being reopened, because Electron
   panels are on every desktop (see "Research: Electron panels and desktops"). The earlier plan
   (defer the reopen until the user returns, `reopenPending`) is dropped.
8. **F9 gate and F7 rewrite** in `react` / `successorOnHide()`, `ShowDesktop` before a user-intent
   raise of a window not on a current desktop, switcher selection carrying user intent, and
   decision 3.
9. Decision 2 (URL dedup).
10. Decision 4 (focus filters).
11. Decision 5 (resign settle).
12. Decision 6: cherry-pick `5f888241` from track `close-raises-other-desktop` (see
    "Relationship to `close-raises-other-desktop`").
13. **Linux on X11**, separate unscheduled track: EWMH provider with reads and writes.

The macOS provider acceptance check runs after commit 4; the rule acceptance check after commit 8.

## Running the live checks

Run from the `kernel-desktops` worktree with `PROFILE=kernel-desktops PEEK_PROFILE=kernel-desktops
TMPDIR=<worktree>/.tmp` (create `.tmp` first). The agent builds, starts the app, reads `main.log`,
and asks the person only for the gestures. For the probe add `PEEK_DESKTOP_PROBE=1`, stdout to
`<worktree>/.tmp/probe.log`.

## Done when

Kernel, property, provider and executor tests pass; the `tracks.json` verify and the platform-leak
check are green; probe answers are recorded under "Probe findings"; the rule check behaves as
listed in the spec; the full gate (`yarn test:desktop:electron`, only with an explicit OK) shows no
failure outside `apps/desktop/tests/gate-baseline.md`.

## Linux verification

`apps/desktop/CLAUDE.md` lists desktops among what Linux runs do not verify. X11 behaviour is
checkable on the remote Linux dev box's virtual X server; whether its window manager implements EWMH
desktops is unverified. Wayland cannot be checked there.

## Research: Electron panels and desktops

Web and history research, 2026-09-28, Electron 43.0.0. Nothing here was run.

**Electron cannot keep a `type: 'panel'` window on one desktop.** `ElectronNSPanel`
(`shell/browser/ui/cocoa/electron_ns_panel.mm`, unchanged since PR #34388, Electron 20) overrides
the setter:

```objc
- (void)setCollectionBehavior:(NSWindowCollectionBehavior)collectionBehavior {
  NSWindowCollectionBehavior panelBehavior =
      (NSWindowCollectionBehaviorCanJoinAllSpaces |
       NSWindowCollectionBehaviorFullScreenAuxiliary);
  [super setCollectionBehavior:collectionBehavior | panelBehavior];
}
```

`NativeWindowMac::SetVisibleOnAllWorkspaces` only sets or clears join-all-Spaces and full-screen
auxiliary through that setter, so on a panel the clear has no effect; so do `setFullScreenable`
and `setHiddenInMissionControl`. Electron's docs (`base-window-options.md`, `type: 'panel'`) say
the panel "will appear on all spaces (desktops)". No API changes a window's type after creation.
`ElectronNSPanel` is an `ElectronNSWindow` subclass whose `styleMask` getter adds the
non-activating bit, not a real `NSPanel`. No Electron issue asks to pin a panel to one desktop.
Links: https://github.com/electron/electron/blob/v43.0.0/shell/browser/ui/cocoa/electron_ns_panel.mm,
https://github.com/electron/electron/pull/34388, https://github.com/electron/electron/pull/52914
(open, keeps the override), https://github.com/electron/electron/issues/53889 (macOS 27: clicking
a panel activates the app; workaround `_setPreventsActivation:`).

**Repo history.** Ordinary windows stayed on their desktop through the on-then-off
`setVisibleOnAllWorkspaces` pair right after construction and before any show (`6b3651b9`,
2026-05-15, the ancestor of desktop membership `anchor`); `TRANSIENT_ROLES` windows kept
join-all-Spaces. Pages opened from the palette became panels in `e77f6cdc` (2026-09-20); an
attempt to open them as ordinary windows outright (`41b76804`) was reverted minutes later
(`e5046f79`). The reopen path (`a2137355`, `ipc.ts reopenWindowAsOrdinary()`) creates a new
window through the generic open, so it lands on the desktop the user is on when it runs.
`docs/macos-spaces-analysis.md` records the earlier Spaces root causes.

**AppKit facts.** A managed window (default collection behaviour) belongs to the desktop active
when it is first ordered on screen and stays bound to it after `orderOut`; showing it again takes
the user back there (electron#8734). Only one of managed, join-all-Spaces and move-to-active-Space
may be set. Full-screen auxiliary does not mean every desktop; appearing over another app's
full-screen desktop needs join-all-Spaces or move-to-active-Space as well. A non-activating window
that is managed is legal AppKit. Toggling the non-activating style bit after creation leaves the
window server's prevents-activation tag stale; `_setPreventsActivation:` (private) re-syncs it
(https://philz.blog/nspanel-nonactivating-style-mask-flag/,
https://github.com/mitchchn/FunWithPanels). Moving a window to a given desktop needs private
SkyLight calls that broke in macOS 14.5, 15 and 27 (Hammerspoon `libspaces.m`, issue #3698,
PR #3889).

**Prior art.** No shipped app or library was found doing the whole flow (transient non-activating
page → persistent window pinned to its desktop). Pieces:

- `@akiflow/electron-panel-window` (maintained, shipped in Akiflow, Electron 43.1.0):
  `makePanel` swaps the window's class to a panel class with `object_setClass` and calls
  `_setPreventsActivation:YES`; `makeWindow` swaps it back and calls `NO`. Its panel class
  overrides the `collectionBehavior` getter (join-all-Spaces). Warnings: never call
  `setVisibleOnAllWorkspaces(true)` on it; call `makeWindow` before close. Its desktop behaviour
  after `makeWindow` is undocumented. https://github.com/akiflow/electron-panel-window
- `goabstract/electron-panel-window`: class swap with move-to-active-Space instead of
  join-all-Spaces. https://github.com/goabstract/electron-panel-window

**Candidate realizations for a transient page-host window that stays on its desktop**, none
verified:

1. An ordinary window (not `type: 'panel'`) plus a small native addon calling
   `_setPreventsActivation:YES` and making it key, `NO` to promote it to an ordinary window. Being
   managed, it stays on the desktop it opened on, and promotion replaces nothing. Unverified:
   keyboard focus without activating the app from a plain window on current macOS. Cost: cannot
   show over another app's full-screen desktop.
2. akiflow's class swap, with the desktop set while the user is still on the original desktop
   (managed behaviour, then swap back on loss of focus or activation, before any switch).
3. Stock Electron: keep the panel, and create the reopened window at open time on the same
   desktop, ordered on screen once (transparent or behind) and then out, so it stays bound there;
   show it at reopen time. Showing it later may take the user back to that desktop.
4. Record the desktop at open and move the reopened window back with private SkyLight calls. Most
   fragile.

The panel travelling with the user during the switch gesture is fixed only by 1 or 2; 3 and 4 fix
only where the reopened window lands.

**Chosen for now (`84a123ee`): none of the four.** The panel stays; losing focus with the app
inactive closes it, and nothing is reopened. Accepted cost: during a switch gesture the page shows
on both desktops until the switch ends. Candidate 1 remains the way to keep the page open across a
click-away if that is wanted later.

## Probe findings

**First probe (inferred ids):**

- macOS order for a switch away from a transient page-host window: `space-changed`, then `native-blur` and
  `os-focus-left-app` ~20ms later, then `OsFocusLost` and the reopen. The switch always preceded the
  blur. The design does not depend on this order.
- Inferred ids fail: every switch minted a new id (two desktops → `desktop-2` … `desktop-15`), so
  returns were never recognised. Electron exposes no desktop identity on macOS. Hence real desktop
  ids read through a provider.
- Behaviour matched `main` (page reopened on desktop 1).

**Second probe, native helper (2026-09-28, stopped after gesture 3):** one screen, two desktops,
build `c3647846`, log kept only locally.

- Precondition met: `desktop-provider started name=mac`; `desktop-probe-hello` with all four
  symbols resolved, including `CGSMoveWindowsToManagedSpace`.
- Gesture 1 passed: the transient page-host window read `*` (every desktop); layout `1@1,3@1`,
  desktop 2 (id `3`) current.
- Gesture 2 passed: current went `3` → `1` → `3`; ids are stable across returns (the old
  `space-changed` line kept minting `desktop-N` in the same run).
- Gesture 3 passed: the reopened window read `1/3` (desktop 2) on every read, matching what was on
  screen.
- Gestures 4–6 not run, blocked by a new defect: the page chrome window (role `overlay`, one
  shared window) sits on desktop 1. Arriving on desktop 2, where the reopened window is the
  front Peek window, activates Peek; the overlay is shown for that window from desktop 1 and
  macOS switches back to desktop 1 about 0.4s later, on every arrival. Clicking the page on
  desktop 2 does the same. The `space-changed` lines show each arrival on desktop 2 followed by a
  switch with `appActive=true key=wm-9` and `wm-1` (the overlay) turning visible.
- Consequence for the spec: rule 1's `TRANSIENT_ROLES` exception (they appear on the desktop the
  user is on) needs a realization for the overlay window, for example declaring it `onEveryDesktop`
  in the Electron backend, before any gesture that visits a desktop holding a page-host window.

**Third check, overlay on every desktop (2026-09-28, after `31c4ac84`):** one screen, two desktops.

- The overlay reads `*` from start. Switching onto desktop 2 while it holds a page-host window no
  longer pulls the user back to desktop 1: the person stayed on desktop 2.
- Remaining defect, seen by the person and in the log: after opening a URL from the palette on
  desktop 2 and switching to desktop 1, the page is visible on desktop 1. Log order: `space-changed`
  (the transient page-host window `wm-9` read `*`), `native-blur` and `os-focus-left-app` 7ms
  later, then `effect-reopen-as-ordinary` and `transient-page-reopen`; the reopened window `wm-10`
  then reads `1/1`, desktop 1. Two causes: the panel is on every desktop, so it travels with the
  switch, and the notification arrives only after the switch, too late to hide it; and the reopened
  window is created on the desktop the user is on.
- Decision taken from it: the transient page-host window is pinned to the desktop it is shown on,
  and a switch away defers the reopen until the user returns to that desktop (spec rules 2 and 3).
  The placeholder window and its probe gestures (the helper write test, the Mission Control check)
  are dropped.
