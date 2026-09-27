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
   | `⟨old⟩-standin-misplaced` | `transient-placeholder-misplaced` | planned log line (commit 7); only docs carried the old name |
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
   not stable across returns or the placeholder window does not keep its desktop; never fall back
   to letting the page follow the user.
5. **Kernel model reshape.** Kernel: `State.screens` / `State.desktops`, `WindowRecord.screen`, the
   three events, `isCurrentDesktop`, `openedOnCurrentDesktop`, reshaped `onCurrentDesktop`,
   `ReopenAsOrdinaryWindow.desktop` (filled, not acted on). Backend: the report → event loop, fed by
   whichever provider started. No rule reads the new state; behaviour unchanged on every platform
   (pinned by the property test).
6. **A desktop switch replaces a transient page-host window** (the `openedOnCurrentDesktop` clause of
   `isTransientPageHost`) and kernel `replaces` / `replacedBy` close and focus ordering
   (decision 1). Reword G13 and row 5d in `docs/design/window-rules.md`; add the switcher's
   cross-desktop reach under rule 1. Remove probe hooks if still present.
7. **Reopened window on the desktop the transient page-host window was opened on**: the
   placeholder window for providers without `canPlaceWindows`, the `placeWindow` path for those
   with it, the `transient-placeholder-misplaced` check.
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

## Probe findings

**First probe (inferred ids):**

- macOS order for a switch away from a transient page-host window: `space-changed`, then `native-blur` and
  `os-focus-left-app` ~20ms later, then `OsFocusLost` and the reopen. The switch always preceded the
  blur. The design does not depend on this order.
- Inferred ids fail: every switch minted a new id (two desktops → `desktop-2` … `desktop-15`), so
  returns were never recognised. Electron exposes no desktop identity on macOS. Hence real desktop
  ids read through a provider.
- Behaviour matched `main` (page reopened on desktop 1).

**Second probe, native helper:** (filled by the implementing track)
