---
enabled: false
touches: [apps/desktop/main/window-kernel.ts, apps/desktop/main/window-kernel.test.ts, apps/desktop/main/window-kernel-properties.test.ts, apps/desktop/main/window-kernel-executor.ts, apps/desktop/main/window-kernel-executor.test.ts, apps/desktop/main/window-kernel-dispatch.ts, apps/desktop/main/window-backend.ts, apps/desktop/main/electron-window-backend.ts, apps/desktop/main/ipc.ts, apps/desktop/main/main.ts, apps/desktop/main/tile-ipc.ts, apps/desktop/tests/desktop/cmd-url-unfocused.spec.ts, docs/design/window-rules.md]
depends-on: []
---

# Desktops are kernel state

Peek item `a0ea0c2d` and the parked track `close-raises-other-desktop`. With another app in front
and two macOS desktops, a page opened from the palette on desktop 2 can follow the user to desktop
1, drop behind the other app there, and vanish from desktop 2. The cause is on `main`: the window
kernel knows nothing about desktops, so every rule in `docs/design/window-rules.md` that mentions
one is decided by when native calls happen to run.

This spec is design only. Each numbered commit under "Order of work" is its own later change.

## The rules, as the user sees them

1. **A window stays on the desktop it was put on.** Nothing the app does on its own moves a
   window to another desktop or takes the user to another desktop. Only the user does that: by
   switching desktop, or by asking for one specific window. Transients (palette, switcher,
   quick-views, the page chrome) are the exception by design: they appear on whatever desktop the
   user is on.

   **The window switcher** lists the app's windows from every desktop, not only the current one.
   Picking a window there is asking for that window, so it takes the user to that window's
   desktop. This sits in tension with rule 5, which keeps actions on the desktop the user is on;
   the tension is accepted for now, because in the switcher the user sees the list and picks one
   window on purpose.
2. **A page opened from the palette stays on the desktop where it was opened.** A page opened
   from the palette over another app (a side task, G1/G13) is replaced by an ordinary window when
   it stops being in use. The replacement is on the desktop where the page was opened, whichever
   way the user left it: clicking the other app (5c), switching desktop (5d), or bringing the app
   forward (5e, where it is also the front window with key). It never appears on another desktop.
3. **Switching desktop ends a side task because it takes focus away.** Switching away from a
   desktop takes focus from the window you were using there; that is how every app's windows
   behave, not a Peek rule. A side task ends when it loses focus, so switching away ends it
   exactly as clicking another app does. Peek only has to see that loss of focus reliably (see
   "Side tasks" for why the switch report itself is used).
4. **Closing or hiding a window never takes you to another desktop.** Key goes back to the window
   you came from if it is on this desktop, else to the frontmost page on this desktop, else to
   nothing (F7 as rewritten below).
5. **Opening a URL that is already open on another desktop opens it here**, as a new window,
   instead of reusing the one over there. Opening a URL from the palette over another app always
   opens a new side task; it never reuses an ordinary window.

   Why: switching to a desktop is deliberate, so what the user does there happens there. A later
   visual cue that offers "go to the open window" or "open a new one here" could revisit this,
   because the user would then choose explicitly.
6. **These rules hold on every platform with desktops.** macOS has them, and so does Linux in
   essentially every window manager (EWMH workspaces on X11; Wayland compositors each have their
   own). Where a backend can report desktop switches, the rules apply as written. Where it cannot,
   the app sees a single desktop and behaves as it does today, which can take the user to another
   desktop; "Platforms" states for each platform which applies.

## What the code does today

- `electron-window-backend.ts attachSpaceChangeListener` subscribes to macOS's active-desktop
  notification and only logs `space-changed`. It returns early on every other platform. No event
  reaches the kernel.
- `window-kernel.ts State` has no desktop. `WindowRecord.desktopMembership` records only the
  intention asked for (`'follow'` every desktop, `'anchor'` one desktop), not where a window is.
  It is set for canvas windows by role (`ipc.ts` window-open handler,
  `kernelSetDesktopMembership(…, desktopMembershipForRole(role))`) and on key-reuse; page-host
  windows built by `ipc.ts assembleHybridPageHost` never get it, so the OS places them on the
  desktop that is current when they are first shown.
- `ElectronWindowBackend.setDesktopMembership` realizes `'anchor'` as the all-desktops-on-then-off
  pair, which moves the window to whatever desktop is current at that moment. It returns early off
  macOS.
- A side task is built as a panel (`ipc.ts`, `pageOpensAsSideTask()` branch, `options.type =
  'panel'`), and Electron keeps every panel on all desktops
  (`electron_ns_panel.mm setCollectionBehavior:`).
- `window-kernel.ts isSideTask` depends only on `appActive`, `key` and the record, so a desktop
  switch ends a side task only through the `OsFocusLost` that the blur settle
  (`ElectronWindowBackend.armBlurSettle` → `kernelOsFocusSettled`) happens to produce, and the
  kernel cannot tell 5c from 5d.
- `react` emits `ReopenAsOrdinaryWindow { id }`; `ipc.ts reopenWindowAsOrdinary()` opens the
  replacement, then closes the panel, ordered by a promise chain. The replacement is a fresh
  window shown after the switch, so macOS puts it on the desktop the user switched to.
- `successorOnHide()` (called from the `WindowHidden` and `WindowClosed` arms of `evolve`) picks
  the prior key window, else `topmost(state, isContentWindow)`, with no idea of desktops. Raising a
  window on another desktop switches desktops (parked spec evidence: `raise-realized id=wm-3` then
  `space-changed`).
- The switcher's selection (`tile-ipc.ts` → `kernelArmSelectionFocus`) is spent in the
  `WindowClosed` arm of `evolve` as a `lastFocusAssert`, and a focus assert carries no user intent
  (`react`, focus-assert rule). Under F9 below it must carry user intent, or picking a window on
  another desktop would be refused.
- The hybrid URL dedup in the `ipc.ts` window-open handler (`findHybridWindowByUrl` →
  `kernelShowRequested(reusedId, true)`) runs before the side-task check and reuses a window
  wherever it is.

Live timeline (fix-build run of 2026-09-26, not kept in the repo): side task opened on desktop 2 →
`space-changed` → `OsFocusLost` → `effect-reopen-as-ordinary takesKey=false` → replacement shown
on desktop 1, unfocused, behind the other app → panel closed → a later open of the same URL reused
the desktop-1 window and its raise was suppressed until `AppActivated`.

## Platforms: what each one lets the backend know

Checked against `node_modules/electron/electron.d.ts` (Electron 43.0.0). "Electron" below means
what Electron's API exposes; a platform may know more than Electron passes on.

| Fact | macOS (Electron) | Linux (Electron) |
|---|---|---|
| The user switched desktop | yes: `systemPreferences.subscribeWorkspaceNotification('NSWorkspaceActiveSpaceDidChangeNotification')` | **no** Electron event. `systemPreferences` workspace notifications are macOS-only |
| Which desktop is current | **no**: the notification's `userInfo` is empty (`attachSpaceChangeListener` comment) | **no** Electron API |
| Which desktop a window is on | **no** | **no** Electron API |
| Put a window on every desktop, or read that | yes: `setVisibleOnAllWorkspaces` / `isVisibleOnAllWorkspaces` | same calls, typed `@platform darwin,linux`; whether they work under Wayland is **unverified** |
| Which window has focus now | yes: `isFocused()` | yes: `isFocused()` |

**macOS.** Desktop identity is inferred, never read, from one fact true on every platform with
desktops: *the key window is on the desktop the user is on*, unless it is on every desktop.
Everything in "Kernel state" follows from that fact plus the switch report. A native module could
read private window-server desktop ids; that is out of scope.

**Linux on X11.** The window manager publishes the facts Electron does not pass on, as EWMH root
and window properties: `_NET_CURRENT_DESKTOP` (current desktop, a number) and `_NET_WM_DESKTOP`
(each window's desktop; `0xFFFFFFFF` means every desktop). A Linux backend could feed the same
kernel events from them: watch the root window's property changes for `DesktopChanged`, and read a
window's desktop when it is shown. That needs a native X11 binding or a helper process (for
example `xprop -spy -root _NET_CURRENT_DESKTOP`); neither exists in the app today. With real numbers
the kernel's knowledge is exact instead of inferred (the event carries an optional name, below).
**Unverified:** that Electron on X11 realizes `setVisibleOnAllWorkspaces` through
`_NET_WM_DESKTOP`, and which window managers honour it.

**Linux on Wayland.** No standard protocol tells an ordinary app which workspace is current or
which one its windows are on; `ext-workspace-v1` exists for shells and task bars, and support
differs by compositor. **Unverified** for every compositor, including whether Electron runs
natively on Wayland or under XWayland on a given system (under XWayland the X11 properties may or
may not be populated).

**Where the backend reports nothing** (Linux today, and any backend without switch reports): the
kernel sees one desktop for the whole session, so `onCurrentDesktop` is true for every window.
The rules then behave as today, including their failures: a focus the manager makes on its own can
land on a window on another desktop, and what follows is the window manager's choice (switch the
user there, pull the window here, or flag it as wanting attention; **unverified** per window
manager). A side task has a further gap: Electron's window-type documentation lists `'panel'`
for macOS only (the type definitions omit the list, so this rests on the published docs, not on
anything checked in this repo), so whether a side task is non-activating on Linux at all is
**unverified**. The
remote Linux dev box runs a virtual X server, so X11 behaviour can be checked there (whether its
window manager implements EWMH desktops is **unverified**); Wayland cannot be checked on any
machine the project has. `apps/desktop/CLAUDE.md` lists desktops among what Linux runs do not
verify today.

Unverified on macOS, each checked by the probe in commit 1 before any rule depends on it:

- **U1** the order in which the switch notification, a window's `blur`, and the next `focus`
  arrive, for a switch by gesture, by the Dock, and by focusing a window on another desktop. One
  run showed the notification before `OsFocusLost`; the design does not depend on the order.
- **U2** a hidden ordinary window, shown again, lands on the current desktop rather than the one
  it was last shown on.
- **U3** an ordinary window shown at zero opacity and click-through is assigned to the desktop it
  was shown on, stays there, and does not show as a blank tile in Mission Control.
- **U4** showing without activation an ordinary window that lives on another desktop does not
  switch desktops (raising one does: parked spec evidence).

## Kernel state

- `State.desktop: DesktopId` — the desktop the user is on. An opaque string: the backend's own
  name when it has one (an EWMH desktop number), otherwise an id the kernel mints meaning "the
  desktop that has been current since the last switch". Starts as the first minted id.
- `State.desktopCounter: number` — mints the ids.
- `WindowRecord.desktop?: DesktopId` — the desktop the window was last known to be on. Absent
  until first shown.
- `WindowRecord.onEveryDesktop?: boolean` — declared at registration by the backend when its
  platform will keep this window on every desktop whatever is asked (the Electron backend says so
  for panels on macOS). The kernel never infers it from `nonActivating`; that link is Electron's,
  and stays below the port. The other source, a role that asks to follow the user
  (`desktopMembership: 'follow'`), is read from `desktopMembership` rather than copied into the
  field, because membership is set after registration and can change on key-reuse; the predicate
  `isOnEveryDesktop(record)` reads both.

One predicate, `onCurrentDesktop(state, record): boolean` — true when `onEveryDesktop`, or when
`record.desktop === state.desktop`. False means "not known to be here", which covers both "known
to be elsewhere" and "unknown": the rules treat them alike, because a wrong guess either way
switches the user's desktop.

How `desktop` is written:

- **Shown**: a `WindowShown` that flips `visible` to true stamps `desktop = state.desktop` (U2), or
  the backend's reported desktop for that window when it has one.
- **Key**: `OsFocusGained` stamps the focused window `desktop = state.desktop`, unless it is on
  every desktop.
- **Replacement**: a window registered with `replaces: X` takes X's `desktop` and is not
  re-stamped by its own first show (below).
- **Every-desktop windows** keep the desktop they were first shown on and are never re-stamped by
  focus. For a side task that is the desktop it was opened on.

Limit of minted ids: after going desktop 1 → 2 → 1 the kernel cannot tell the second visit to
desktop 1 from the first. Windows there count as not known to be here until one is shown or
focused, and the rules leave the choice to the OS meanwhile. With backend names (X11) the limit
does not apply.

## The desktop-switch event

`DesktopChanged { focused: WindowId | null; name?: DesktopId }`, an event (a fact, never
rejected). The backend emits it once per switch, carrying its own read, at that moment, of which
registered window has focus (`isFocused()`), and the new desktop's name if the platform gives one.

`evolve`: set `State.desktop` to `name`, or mint a new id when there is none; if `focused` names a
record that is not on every desktop, stamp it with the new desktop. `key` is **not** written: key
changes only by `OsFocusGained` / `OsFocusLost` (F1). The `focused` read exists only so the one
window the user is looking at is known to be here after the switch.

Ordering against focus and blur: none is required. A focus report that arrives before the switch
event stamps the old desktop and is corrected by `focused`; one that arrives after stamps the new
one. The side-task end is a structural diff (below) that gives the same answer whichever of
`DesktopChanged` and `OsFocusLost` comes first. This is why U1 is a probe, not a precondition.

Platform neutrality: the names added above the port are "desktop", `DesktopId`, `DesktopChanged`
and `onEveryDesktop`; none is in `scripts/check-platform-leak.mjs FORBIDDEN`. The macOS
notification name and any EWMH property names stay in the backend.

## Side tasks: 5c, 5d, 5e and G13

**The chosen rule.** G13 said the replacement belongs to "the desktop the user is on"; row 5d
said it "stays on the desktop it was on when it lost key". Both are replaced by: *the replacement
belongs to the desktop the side task was opened on*. A page lives where the user opened it
(rule 1); the reported failure is the page leaving desktop 2; and the earlier spec
`side-task-ends-on-blur.md` already expected "the page stays on desktop 2" in its live check.

**Why the switch report ends the side task.** Rule 3 is ordinary OS behaviour: leaving a desktop
takes focus from the window in use there. A side task's window is the one exception to that on
macOS, because Electron keeps panels on every desktop, so the OS may keep it focused across the
switch or report the loss late. The kernel therefore reads the switch as the loss of focus it
normally is: `isSideTask` gains one clause, `record.desktop === state.desktop`. A `DesktopChanged`
changes `State.desktop`, so the side task stops being one in that transition and `react`'s
existing diff emits the reopen. If `OsFocusLost` came first, the diff already fired and the later
switch diffs to nothing. Exactly one reopen either way.

`ReopenAsOrdinaryWindow { id }` keeps its payload. Its promise, stated in the port doc
(`window-backend.ts reopenAsOrdinaryWindow`), changes from "belonging to the desktop the user is
on" to "belonging to the desktop the side task was opened on".

**Realization on macOS.** The replacement must appear on a desktop the user may no longer be on,
and nothing in Electron places a window on a desktop other than the current one. So the Electron
backend prepares for it when the side task opens: next to the panel it shows a stand-in, an
ordinary window at the panel's bounds, zero opacity and click-through, on the desktop the side
task opens on (U3). It is backend-private, never registered with the kernel, and follows the
panel's bounds. At the reopen the stand-in becomes the replacement host (opacity restored, input
on, the page loaded into it) and registers with the kernel as `replaces: X`. If the side task
closes instead (Escape, close request), the stand-in is destroyed with it. Whether the page's
view moves into the stand-in instead of reloading is a later choice, as in
`side-task-ends-on-blur.md`; nothing in the rule depends on it.

**If U3 fails, the plan stops.** If the probe shows the stand-in does not keep its desktop, no
known way remains to put the replacement where the page was opened. The track then stops and
reports back with the probe's evidence. It does not fall back to letting the page follow the user
to another desktop.

**Close and focus ordering, pulled into the kernel.** Registration with `replaces: X` marks X
`replacedBy: <new id>`; `react` diffs that into `CloseWindow X`. When X's `WindowClosed` arrives
and the app is active (5e: the app became active with the page in hand), the kernel raises the
replacement, machine-caused; with the app inactive (5c, 5d) it raises nothing. This replaces the
promise chain in `ipc.ts reopenWindowAsOrdinary()` and the parked track's `takesKey` payload: the
answer is `appActive` at the moment the old window is gone, read from state.

## F7, F9 and the raise gate

New rule, added under Focus:

> **F9 stay-on-this-desktop.** A focus the manager makes without user intent lands only on a
> window on the desktop the user is on. A focus with user intent may take the user to another
> desktop, because the user named that window; picking a window in the switcher is such a focus.

F7 rewritten (supersedes the parked track's split between transient and application closes):

> **F7 hide-returns-key.** When the key window hides or closes while the app is active, key goes
> to its prior window if that window is visible and on the desktop the user is on; otherwise to
> the topmost visible application window on that desktop; otherwise the manager focuses nothing,
> and whatever the OS focuses next arrives world-caused.

`successorOnHide()` applies `onCurrentDesktop` to both branches. The parked track removed the
successor from application-window closes because the kernel could not tell desktops apart; with
this design it can, so the kernel keeps choosing on this desktop, which also avoids the parked
spec's own caveat (the OS handing key to the page chrome). The parked track's other two changes
stay: focusing the replacement on activation (now covered above) and the devtools handlers.

Where the gate lives: `react`, not the executor. A `RaiseWindow` effect without user intent is not
emitted for a record that is not on the current desktop. The switcher's selection raise, spent
from `pendingSelectionFocus` in the `WindowClosed` arm, carries user intent so it passes the gate.
The executor keeps only what is about the environment (headless).

## Out-of-kernel decisions, and where each goes

Each is one later commit, in this order (see "Order of work"):

1. **`ipc.ts reopenWindowAsOrdinary()`** — open → close → focus by promise chain. Moves to the
   `replaces` / `replacedBy` state above; `reopenWindowAsOrdinary()` keeps only building the
   replacement.
2. **`ipc.ts` hybrid URL dedup** — reuses by URL before the side-task check, wherever the window
   is. Becomes a kernel predicate `admitsReuse(state, record)`: visible and on the current desktop,
   or hidden (a re-show lands here, U2). The side-task check moves ahead of the dedup: an open that
   is a side task never reuses.
3. **`window-kernel-executor.ts` `RaiseWindow` / `planRaise`** — the `'suppressed'` plan (app
   inactive, no user intent) drops a raise the kernel already asked for. `react` stops emitting
   it, together with the F9 gate; `planRaise` keeps the headless and non-activating realization
   choices, which are about how, not whether.
4. **`electron-window-backend.ts` focus filters** — the `win.on('focus')` handler drops OS reports
   on backend flags (`pendingStackingFocus`, `pendingHideProvokedFocus`, `activationFocusTarget`).
   Each flag is an expectation created by an effect the kernel emitted (a stacking replay, a hide
   of the key window, an activation with `pendingColdStartFocus`). The kernel records the
   expectation when it emits the effect and classifies the report; the backend reports every focus
   with its raw cause. `hideProvokesFocusReassignment()` becomes a kernel fact of the same kind.
5. **`electron-window-backend.ts appResignSettleTimer`** — reads the izui coordinator's overlay
   cooldowns and drops the settle. The timer stays (it is timing at the platform boundary); the
   overlay transition becomes a kernel fact that makes `AppResignSettled` inert, so the decision
   is in `evolve`.
6. **`main.ts` devtools-opened / devtools-closed** — call `kernelAssertFocus()` on the topmost
   content window, which may be on another desktop. The parked track already retargets them to the
   host; with F9 the kernel would also refuse a machine focus on another desktop. Lands with the
   parked track.

Stays outside, on purpose: `armBlurSettle`. It turns "a blur, then no focus one tick later" into
"focus left every window of the app"; that is translation of how Electron orders its events, and
no rule is decided there.

## Order of work

1. **Feed the switch; record desktops; nothing reads them.** The macOS backend emits
   `DesktopChanged`; the kernel adds the state, stamping and `onCurrentDesktop`; the backend
   declares `onEveryDesktop` for panels; the role's `'follow'` sets it too. `wmLog` records each
   switch with the desktop id and `focused`. Then the U1–U4 probe on macOS with a person (below).
   If U3 fails, stop here and report.
2. **Side task ends on a switch** (`isSideTask` clause) and the `replaces` / `replacedBy` close
   and focus ordering in the kernel (decision 1). G13 and row 5d reworded in
   `docs/design/window-rules.md`, and the switcher's reach across desktops written under rule 1.
3. **The stand-in window** in the Electron backend, so the replacement lands on the side task's
   desktop.
4. **F9 gate and F7 rewrite** in `react` / `successorOnHide()`, the switcher selection carrying
   user intent, and decision 3. The parked track rebases onto this and drops its F7 change.
5. Decision 2 (URL dedup).
6. Decision 4 (focus filters).
7. Decision 5 (resign settle).
8. Decision 6 lands with the parked track.
9. **Linux on X11**, a separate track, not scheduled: a backend feed of `DesktopChanged` with
   EWMH desktop numbers and per-window desktops. Verifiable on the remote Linux dev box's virtual
   X server, if its window manager implements EWMH desktops.

## Tests

Kernel unit tests (`window-kernel.test.ts`), one group per rule:

- **Desktop state.** `DesktopChanged` sets or mints the desktop and leaves `key` alone; `focused`
  stamps that window; a named desktop is used as given; a first show stamps; an every-desktop
  window is never re-stamped by focus; `onCurrentDesktop` over the table {every desktop, same id,
  older id, never shown}.
- **5c.** Side task, `OsFocusLost` with the app inactive: one `ReopenAsOrdinaryWindow`; the
  replacement registered with `replaces` has the side task's desktop, which is current;
  `CloseWindow` for the old id; no `RaiseWindow`; not key; not held; `appActive` still false.
- **5d, both orders.** Side task, `DesktopChanged` then `OsFocusLost`, and the reverse: exactly one
  reopen; the replacement's desktop is the side task's opening desktop, not `State.desktop`; no
  `RaiseWindow`.
- **5e.** Side task key, `AppActivated`: one reopen; after the old `WindowClosed`, one machine
  `RaiseWindow` of the replacement.
- **G13.** Escape or a close request on a side task: no reopen (existing tests stay).
- **F7 / F9.** Prior window on this desktop: raised. Prior on another desktop: topmost application
  window on this desktop raised instead. None on this desktop: no raise and no token. A user-intent
  raise of a window on another desktop is emitted; so is a switcher selection of one.
- **Dedup.** `admitsReuse` table; a side-task open never reuses.

Property test (`window-kernel-properties.test.ts`): over random event sequences with no
`DesktopChanged`, every effect list equals the one produced with desktops ignored. This pins the
behaviour of any backend that reports no desktops.

Executor tests (`window-kernel-executor.test.ts`): `sideTaskSetup()` cases for 5c/5d/5e assert the
backend calls in order (reopen, close, and for 5e one raise).

`cmd-url-unfocused.spec.ts` (darwin-only) keeps its current assertions and gains a
`DesktopChanged` injection through the executor's test surface for 5d. It cannot see real desktops.

Static: `node scripts/check-platform-leak.mjs`.

## Live checks on macOS (a person does only the gestures)

Run from this worktree with `PROFILE=kernel-desktops PEEK_PROFILE=kernel-desktops
TMPDIR=<worktree>/.tmp`, two desktops, another app frontmost on each. The agent reads `main.log`.

After commit 1, the probe:

1. On desktop 2 open a page from the palette; switch to desktop 1 by gesture; switch back.
   Log: order of `space-changed`, blur, `OsFocusLost`, the next focus (U1).
2. Open a page on desktop 1 and switch to desktop 2; the agent then hides and re-shows that page
   through a debug-only hook added for the probe and reverted after it (U2).
3. With a debug-only stand-in shown on desktop 2, switch to desktop 1; open Mission Control (U3).
4. From desktop 1, show without activation a window that lives on desktop 2 (U4).

After commit 3, the rule check:

1. Desktop 2, other app in front: palette → URL → type in the page → click the other app. The
   page stays on desktop 2 behind the other app; one `side-task-reopen`.
2. Same, but switch to desktop 1 instead of clicking. Desktop 1 shows no page; desktop 2 has it.
3. Same, but cmd+tab to Peek. The page is the front window with key.
4. After 2, on desktop 1, open the same URL from the palette: a new side task on desktop 1; the
   desktop-2 window is untouched and no desktop switch happens.
5. After commit 4: open the switcher on desktop 1 and pick the desktop-2 page. The user is taken
   to desktop 2 and the page has key.

## Done when

The kernel, property and executor tests pass, the `tracks.json` verify and the platform-leak
check are green, the probe answers U1–U4 (recorded in **Result**), the rule check behaves as
listed, and the full gate (`yarn test:desktop:electron`, only with an explicit OK) shows no failure
outside `apps/desktop/tests/gate-baseline.md`.

## Result

(filled by the implementing track)
