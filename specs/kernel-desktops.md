---
enabled: false
touches: [apps/desktop/main/window-kernel.ts, apps/desktop/main/window-kernel.test.ts, apps/desktop/main/window-kernel-properties.test.ts, apps/desktop/main/window-kernel-executor.ts, apps/desktop/main/window-kernel-executor.test.ts, apps/desktop/main/window-kernel-dispatch.ts, apps/desktop/main/window-backend.ts, apps/desktop/main/electron-window-backend.ts, apps/desktop/main/ipc.ts, apps/desktop/main/main.ts, apps/desktop/tests/desktop/cmd-url-unfocused.spec.ts, docs/design/window-rules.md]
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
   switching desktop, or by asking for one specific window (picking it in the switcher, clicking
   it in the Dock menu). Transients (palette, switcher, quick-views, the page chrome) are the
   exception by design: they appear on whatever desktop the user is on.
2. **Leaving a page opened from the palette leaves it where you used it.** A page opened from the
   palette over another app (a side task, G1/G13) is replaced by an ordinary window when the user
   stops using it. The replacement is on the desktop where the page was opened and used, whichever
   way the user left: clicking the other app (5c), switching desktop (5d), or bringing the app
   forward (5e, where it is also the front window with key). It never appears on the desktop the
   user switched to.
3. **Switching desktop ends a side task**, the same as clicking away does, whether or not the OS
   reports the loss of key before or after the switch.
4. **Closing or hiding a window never takes you to another desktop.** Key goes back to the window
   you came from if it is on this desktop, else to the frontmost page on this desktop, else to
   nothing (F7 as rewritten below).
5. **Opening a URL that is already open on another desktop opens it here**, as a new window,
   instead of reusing the one over there. Opening a URL from the palette over another app always
   opens a new side task; it never reuses an ordinary window.
6. **On a system without desktops (Linux today) nothing changes.** Every window counts as on the
   desktop the user is on, so every rule above reduces to what the app does now.

## What the code does today

- `electron-window-backend.ts attachSpaceChangeListener` subscribes to macOS's active-desktop
  notification and only logs `space-changed`. No event reaches the kernel.
- `window-kernel.ts State` has no desktop. `WindowRecord.desktopMembership` records only the
  intention asked for (`'follow'` every desktop, `'anchor'` one desktop), not where a window is.
  It is set for canvas windows by role (`ipc.ts` window-open handler,
  `kernelSetDesktopMembership(…, desktopMembershipForRole(role))`) and on key-reuse; page-host
  windows built by `ipc.ts assembleHybridPageHost` never get it, so macOS places them on the
  desktop that is current when they are first shown.
- `ElectronWindowBackend.setDesktopMembership` realizes `'anchor'` as the all-desktops-on-then-off
  pair, which moves the window to whatever desktop is current at that moment.
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
- The hybrid URL dedup in the `ipc.ts` window-open handler (`findHybridWindowByUrl` →
  `kernelShowRequested(reusedId, true)`) runs before the side-task check and reuses a window
  wherever it is.

Live timeline (fix-build run of 2026-09-26, not kept in the repo): side task opened on desktop 2 →
`space-changed` → `OsFocusLost` → `effect-reopen-as-ordinary takesKey=false` → replacement shown
on desktop 1, unfocused, behind the other app → panel closed → a later open of the same URL reused
the desktop-1 window and its raise was suppressed until `AppActivated`.

## What Electron and macOS let us know

Checked against `node_modules/electron/electron.d.ts` (Electron 43.0.0):

| Fact | Available | Source |
|---|---|---|
| The user switched desktop | yes, macOS only | `systemPreferences.subscribeWorkspaceNotification('NSWorkspaceActiveSpaceDidChangeNotification')` |
| Which desktop is current | **no** | the notification's `userInfo` is empty (`attachSpaceChangeListener` comment); no Electron API names a desktop |
| Which desktop a window is on | **no** | only `isVisibleOnAllWorkspaces()` (every desktop or not) exists |
| Whether a window is on every desktop | yes, macOS and Linux | `isVisibleOnAllWorkspaces()`; for a panel the backend already knows it is |
| Which window has focus right now | yes | `isFocused()` per window |

A native module could read private window-server calls for desktop ids; that is out of scope.
So desktop identity is **inferred**, never read. The inference rests on one fact that holds on
every platform with desktops: **the key window is on the desktop the user is on**, unless it is on
every desktop. Everything else below follows from that plus the switch notification.

Unverified, each checked by the probe in commit 1 before any rule depends on it:

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

- `State.desktop: DesktopId` — the desktop the user is on. An opaque id the kernel mints; it is a
  name for "the desktop that has been current since the last switch", not a platform id. Starts
  as the first minted id.
- `State.desktopCounter: number` — mints the ids.
- `WindowRecord.desktop?: DesktopId` — the desktop the window was last known to be on. Absent
  until first shown.
- `WindowRecord.onEveryDesktop?: boolean` — declared at registration, from two sources: the role
  asks to follow the user (`desktopMembership: 'follow'`), or the backend reports that its
  platform will keep this window on every desktop whatever is asked (the Electron backend says so
  for panels). The kernel never infers it from `nonActivating`; that link is Electron's, and stays
  below the port.

One predicate, `onCurrentDesktop(state, record): boolean` — true when `onEveryDesktop`, or when
`record.desktop === state.desktop`. False means "not known to be here", which covers both "known
to be elsewhere" and "unknown": the rules treat them alike, because a wrong guess either way
switches the user's desktop.

How `desktop` is written:

- **Shown**: a `WindowShown` that flips `visible` to true stamps `desktop = state.desktop` (U2).
- **Key**: `OsFocusGained` stamps the focused window `desktop = state.desktop`, unless it is on
  every desktop.
- **Replacement**: a window registered with `replaces: X` takes X's `desktop` and is not
  re-stamped by its own first show (below).
- **Every-desktop windows** keep the desktop they were first shown on and are never re-stamped by
  focus. For a side task that is the desktop it was opened and used on.

Honest limit: ids are minted, so after going desktop 1 → 2 → 1 the kernel cannot tell the
second visit to desktop 1 from the first. Windows there count as not known to be here until one
is shown or focused. The rules then do nothing on their own and leave the choice to the OS, which
is today's behaviour minus the desktop switches. A backend that can name desktops could later
pass real ids; no rule changes for that.

## The desktop-switch event

`DesktopChanged { focused: WindowId | null }`, an event (a fact, never rejected). The backend
emits it once per switch, carrying its own read, at that moment, of which registered window has
focus (`isFocused()`), or null.

`evolve`: mint a new `State.desktop`; if `focused` names a record that is not on every desktop,
stamp it with the new id. `key` is **not** written: key changes only by `OsFocusGained` /
`OsFocusLost` (F1). The `focused` read exists only so the one window the user is looking at is
known to be here after the switch.

Ordering against focus and blur: none is required. A focus report that arrives before the switch
event stamps the old id and is corrected by `focused`; one that arrives after stamps the new id.
The side-task end is a structural diff (below) that gives the same answer whichever of
`DesktopChanged` and `OsFocusLost` comes first. This is why U1 is a probe, not a precondition.

Linux: the Electron backend emits nothing (`attachSpaceChangeListener` already returns early off
macOS), `State.desktop` never changes, every shown window is stamped with it, and
`onCurrentDesktop` is true for every window. The names added above the port are "desktop",
`DesktopId`, `DesktopChanged` and `onEveryDesktop`; none is in `scripts/check-platform-leak.mjs
FORBIDDEN`, and the notification name stays in the backend.

## Side tasks: 5c, 5d, 5e and G13

**The chosen rule.** G13 said the replacement belongs to "the desktop the user is on"; row 5d
said it "stays on the desktop it was on when it lost key". Row 5d wins, restated: *the
replacement belongs to the desktop the side task was opened on*. Reasons: a page lives where the
user put it (rule 1 above); the reported failure is the page leaving desktop 2; both earlier specs
(`side-task-ends-on-blur.md` live check, "the page stays on desktop 2") already expected it; and
for 5c and 5e the two wordings agree, because no switch happened.

**Decidable from state.** `isSideTask` gains one clause: `record.desktop === state.desktop`. A
`DesktopChanged` mints a new desktop, so the side task stops being one in that transition, and
`react`'s existing diff emits the reopen. If `OsFocusLost` came first, the diff already fired and
the later switch diffs to nothing. Exactly one reopen either way.

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

If U3 fails, no realization of the chosen rule is known, and the fallback is G13's wording (the
replacement follows the user to the current desktop). That is a decision for review, not a
silent downgrade.

**Close and focus ordering, pulled into the kernel.** Registration with `replaces: X` marks X
`replacedBy: <new id>`; `react` diffs that into `CloseWindow X`. When X's `WindowClosed` arrives
and the app is active (5e: the app became active with the page in hand), the kernel raises the
replacement, machine-caused; with the app inactive (5c, 5d) it raises nothing. This replaces the
promise chain in `ipc.ts reopenWindowAsOrdinary()` and the parked track's `takesKey` payload: the
answer is `appActive` at the moment the old window is gone, read from state.

## F7 and the raise gate

New rule, added under Focus:

> **F9 stay-on-this-desktop.** A focus the manager makes without user intent lands only on a
> window on the desktop the user is on. A focus with user intent may take the user to another
> desktop, because the user named that window.

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
emitted for a record that is not on the current desktop. The executor keeps only what is about the
environment (headless).

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

1. **Feed the switch; record desktops; nothing reads them.** Backend emits `DesktopChanged`
   (macOS only); kernel adds the state, stamping and `onCurrentDesktop`; backend declares
   `onEveryDesktop` for panels; the role's `'follow'` sets it too. `wmLog` records each switch with
   the minted id and `focused`. Then the U1–U4 probe on macOS with a person (below).
2. **Side task ends on a switch** (`isSideTask` clause) and the `replaces` / `replacedBy` close
   and focus ordering in the kernel (decision 1). G13 and row 5d reworded in
   `docs/design/window-rules.md`.
3. **The stand-in window** in the Electron backend, so the replacement lands on the side task's
   desktop.
4. **F9 gate and F7 rewrite** in `react` / `successorOnHide()`, with decision 3. The parked track
   rebases onto this and drops its F7 change.
5. Decision 2 (URL dedup).
6. Decision 4 (focus filters).
7. Decision 5 (resign settle).
8. Decision 6 lands with the parked track.

## Tests

Kernel unit tests (`window-kernel.test.ts`), one group per rule:

- **Desktop state.** `DesktopChanged` mints a new id and leaves `key` alone; `focused` stamps that
  window; a first show stamps; an every-desktop window is never re-stamped by focus;
  `onCurrentDesktop` over the table {every desktop, same id, older id, never shown}.
- **5c.** Side task, `OsFocusLost` with the app inactive: one `ReopenAsOrdinaryWindow`; the
  replacement registered with `replaces` has the side task's desktop, which is current; `CloseWindow`
  for the old id; no `RaiseWindow`; not key; not held; `appActive` still false.
- **5d, both orders.** Side task, `DesktopChanged` then `OsFocusLost`, and the reverse: exactly one
  reopen; the replacement's desktop is the pre-switch id, not `State.desktop`; no `RaiseWindow`.
- **5e.** Side task key, `AppActivated`: one reopen; after the old `WindowClosed`, one machine
  `RaiseWindow` of the replacement.
- **G13.** Escape or a close request on a side task: no reopen (existing tests stay).
- **F7 / F9.** Prior window on this desktop: raised. Prior on another desktop: topmost application
  window on this desktop raised instead. None on this desktop: no raise and no token. A user-intent
  raise of a window on another desktop is emitted.
- **Dedup.** `admitsReuse` table; a side-task open never reuses.

Property test (`window-kernel-properties.test.ts`): over random event sequences with no
`DesktopChanged`, every effect list equals the one produced with desktops ignored. This is the
Linux guarantee in executable form.

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

## Done when

The kernel, property and executor tests pass, the `tracks.json` verify and the platform-leak
check are green, the probe answers U1–U4 (recorded in **Result**), the rule check behaves as
listed, and the full gate (`yarn test:desktop:electron`, only with an explicit OK) shows no failure
outside `apps/desktop/tests/gate-baseline.md`.

## Result

(filled by the implementing track)
