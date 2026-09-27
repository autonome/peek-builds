---
enabled: false
touches: [apps/desktop/main/window-kernel.ts, apps/desktop/main/window-kernel.test.ts, apps/desktop/main/window-kernel-properties.test.ts, apps/desktop/main/window-kernel-executor.ts, apps/desktop/main/window-kernel-executor.test.ts, apps/desktop/main/window-kernel-dispatch.ts, apps/desktop/main/window-backend.ts, apps/desktop/main/electron-window-backend.ts, apps/desktop/main/desktop-provider.ts, apps/desktop/main/desktop-provider-fallback.ts, apps/desktop/main/desktop-provider-mac.ts, apps/desktop/main/desktop-provider.test.ts, apps/desktop/native/desktop-helper/main.swift, apps/desktop/scripts/build-desktop-helper.mjs, apps/desktop/electron-builder.yml, apps/desktop/package.json, apps/desktop/main/ipc.ts, apps/desktop/main/main.ts, apps/desktop/main/tile-ipc.ts, apps/desktop/tests/desktop/cmd-url-unfocused.spec.ts, docs/design/window-rules.md]
depends-on: []
---

# Desktops are kernel state

Peek item `a0ea0c2d`; parked track `close-raises-other-desktop`. Defect on `main`: with another
app in front and two macOS desktops, a page opened from the palette on desktop 2 can follow the
user to desktop 1, drop behind the other app, and vanish from desktop 2, because the window kernel
knows nothing about desktops and every desktop rule in `docs/design/window-rules.md` is decided by
native-call timing.

Design only; each numbered commit under "Order of work" is a separate change. The kernel holds a
platform-neutral model of screens and desktops with real, stable ids; the Electron backend fills it
through a per-platform desktop provider, with a fallback provider that reproduces today's
behaviour.

## Rules

Terms: with several screens, "the desktop the user is on" is the desktop currently shown on the
screen in question. A window is **here** when its desktop is currently shown on its screen, or it
is on every desktop.

1. **A window stays on the desktop it was put on.** Nothing the app does on its own moves a window
   to another desktop or switches the user's desktop; only the user does, by switching desktop or
   asking for one specific window. Exception: transients (palette, switcher, quick-views, page
   chrome) appear on the desktop the user is on.

   **The switcher** lists the app's windows from every desktop. Picking one takes the user to that
   window's desktop. This conflicts with rule 5; accepted, because the pick is explicit.
2. **A side task's replacement is on the desktop where the page was opened.** A page opened from
   the palette over another app (a side task, G1/G13) is replaced by an ordinary window when it
   stops being in use. The replacement is on the side task's opening desktop however the user left
   it: clicking the other app (5c), switching desktop (5d), or bringing the app forward (5e, where
   it is also the front window with key). Never on another desktop.
3. **Switching desktop ends a side task because it takes focus away** (ordinary OS behaviour). A
   side task ends on loss of focus, so switching away ends it as clicking another app does. A
   switch on a different screen from the page's does not end it.
4. **Closing or hiding a window never switches desktop.** Key goes to the prior window if here,
   else the frontmost page that is here, else nothing (F7 below).
5. **Opening a URL already open on another desktop opens a new window here**, not the one there.
   Opening a URL from the palette over another app always opens a new side task; it never reuses
   an ordinary window. Reason: switching desktop is deliberate, so actions happen there. A future
   "go to the open window / open one here" cue could revisit this.
6. **The rules hold on every platform with desktops.** With a provider that reads real desktops,
   as written. With only the fallback provider, the app sees one desktop per screen and behaves as
   on `main` (including taking the user to another desktop); see "Platform summary".

## Baseline on `main`

- `electron-window-backend.ts attachSpaceChangeListener` only logs `space-changed` (macOS only);
  no event reaches the kernel.
- `window-kernel.ts State` has no desktop. `WindowRecord.desktopMembership` records intent only
  (`'follow'` / `'anchor'`), set for canvas windows by role (`ipc.ts` window-open handler,
  `kernelSetDesktopMembership(…, desktopMembershipForRole(role))`) and on key-reuse; page hosts
  from `ipc.ts assembleHybridPageHost` never get it and land on the desktop current at first show.
- `ElectronWindowBackend.setDesktopMembership` realizes `'anchor'` as the all-desktops-on-then-off
  pair, moving the window to the current desktop; no-op off macOS.
- A side task is a panel (`ipc.ts`, `pageOpensAsSideTask()` branch, `options.type = 'panel'`);
  Electron keeps panels on all desktops (`electron_ns_panel.mm setCollectionBehavior:`).
- `isSideTask` reads only `appActive`, `key` and the record; a switch ends a side task only via
  the `OsFocusLost` from `ElectronWindowBackend.armBlurSettle` → `kernelOsFocusSettled`, so 5c
  and 5d are indistinguishable.
- `react` emits `ReopenAsOrdinaryWindow { id }`; `ipc.ts reopenWindowAsOrdinary()` opens the
  replacement then closes the panel via a promise chain; the replacement lands on the desktop
  switched to.
- `successorOnHide()` (`WindowHidden` / `WindowClosed` arms of `evolve`) picks the prior key
  window, else `topmost(state, isContentWindow)`, ignoring desktops. Raising a window on another
  desktop switches desktop (`raise-realized id=wm-3` then `space-changed`).
- Switcher selection (`tile-ipc.ts` → `kernelArmSelectionFocus`) is spent in the `WindowClosed`
  arm as a `lastFocusAssert`, which carries no user intent.
- Hybrid URL dedup in the `ipc.ts` window-open handler (`findHybridWindowByUrl` →
  `kernelShowRequested(reusedId, true)`) runs before the side-task check and reuses a window on
  any desktop.

## Model: screens and desktops

- **Screen**: a hardware display.
- **Desktop**: a virtual desktop, belonging to one screen or shared across all screens. Each
  screen shows exactly one current desktop; with shared desktops all screens have the same one.

Ids (`ScreenId`, `DesktopId`) are opaque provider-chosen strings, compared only. Required: stable
for the session while the thing exists; returning to a desktop yields its previous id.

### Kernel state

- `State.screens: readonly ScreenState[]`, `ScreenState = { id: ScreenId; current: DesktopId }`.
- `State.desktops: readonly DesktopState[]`, `DesktopState = { id: DesktopId; screen: ScreenId |
  null }` (`null` = shared).
- `WindowRecord.screen?: ScreenId` — last reported screen.
- `WindowRecord.desktop?: DesktopId` — last reported desktop. For an every-desktop window, its home:
  the desktop it was first shown on (for a side task, the one it was opened on). Absent until first
  shown or reported.
- `WindowRecord.onEveryDesktop?: boolean` — declared at registration by the backend when the
  platform keeps the window on every desktop regardless (Electron backend: panels on macOS), or set
  by a placement report. `desktopMembership: 'follow'` is not copied here;
  `isOnEveryDesktop(record)` reads both.

Initial state: no screens, no desktops.

Predicates:

- `isCurrentDesktop(state, desktop): boolean` — some screen shows it; true when `state.screens` is
  empty.
- `onCurrentDesktop(state, record): boolean` — `isOnEveryDesktop(record)`, or `record.desktop` is
  current. False for both "elsewhere" and "never shown". Exception: true for every window before
  the first layout report.
- `homeIsCurrent(state, record): boolean` — `record.desktop` is current, ignoring every-desktop. Used by the
  side-task rule.

### Events (facts, never rejected)

- `DesktopLayoutReported { screens: ScreenState[]; desktops: DesktopState[] }` — full layout; sent
  at start, on screen add/remove/rearrange, and when the provider sees desktops added or removed.
  Replaces `State.screens` and `State.desktops`. A window whose `desktop` no longer exists keeps
  the stale id (not here) until its next placement report.
- `CurrentDesktopChanged { screen: ScreenId; desktop: DesktopId }` — sets that screen's `current`;
  adds an unknown screen. With shared desktops, one per screen. Never writes `key` (F1: only
  `OsFocusGained` / `OsFocusLost` do).
- `WindowPlacementReported { id: WindowId; screen: ScreenId | null; desktop: DesktopId | null;
  onEveryDesktop: boolean }` — a registered window's placement. `null` leaves the field unchanged.
  For an every-desktop window with a home, `desktop` is ignored.

Writing `WindowRecord.desktop`:

| Source | Effect |
|---|---|
| Placement report | Authoritative, as above. |
| `WindowShown` flipping `visible` to true | Provisional stamp: current desktop of the window's screen (first screen if unknown). Skipped if the record has a desktop and is on every desktop. |
| Registration with `replaces: X` | Takes X's `desktop` and `screen`; its first show does not re-stamp. |
| `OsFocusGained` | Never stamps. |

With the fallback provider the show stamp is the only source and is correct by construction.

### Effects

- `ReopenAsOrdinaryWindow { id; desktop: DesktopId | null }` — replacement must be on `desktop` (the
  side task's home); `null` = wherever the backend shows it.
- `ShowDesktop { desktop: DesktopId }` — make `desktop` current on its screen. Emitted only
  immediately before a user-intent `RaiseWindow` of a window not here. Ignored by a backend that
  cannot switch desktops.

Platform neutrality: the new names above the port ("screen", "desktop", `ScreenId`, `DesktopId`,
the three events, two effects, `onEveryDesktop`) are not in `scripts/check-platform-leak.mjs
FORBIDDEN`. All macOS/X11 names, including private calls, stay in the provider files (not scanned).

## Desktop provider (backend side)

`apps/desktop/main/desktop-provider.ts`, owned by the Electron backend; the kernel never sees it.

```ts
interface DesktopProvider {
  readonly name: string;                       // for logs
  readonly canPlaceWindows: boolean;
  readonly canShowDesktops: boolean;
  start(onChange: (change: DesktopChange) => void): Promise<void>;
  layout(): Promise<{ screens: ScreenState[]; desktops: DesktopState[] }>;
  placements(windows: NativeWindowRef[]): Promise<Placement[]>;
  placeWindow(win: NativeWindowRef, desktop: DesktopId): Promise<boolean>;
  showDesktop(desktop: DesktopId): Promise<boolean>;
  stop(): void;
}
```

`NativeWindowRef` names a window to the platform. `DesktopChange` is "layout changed" or "current
desktop changed on screen S". A provider lacking a capability sets the flag false and returns
`false` from the call.

Backend algorithm:

- At start and on every `DesktopChange`: `layout()` → `DesktopLayoutReported` if changed; one
  `CurrentDesktopChanged` per screen whose current desktop differs; `placements()` for all
  registered windows → one `WindowPlacementReported` per changed placement.
- After each genuine show and each registration: `placements()` for that window.
- `ReopenAsOrdinaryWindow`, `ShowDesktop`: see "Side tasks" and "Taking the user to a window's
  desktop".

Electron facts are used where they exist; the provider supplies only the rest:

- Screens: `screen.getAllDisplays()`; `display-added` / `display-removed` /
  `display-metrics-changed` are a `DesktopChange`.
- A window's screen: `screen.getDisplayMatching(bounds)`.
- Every-desktop: the backend's own declaration (`setVisibleOnAllWorkspaces`, macOS panels); the
  provider reports only where the platform disagrees.
- macOS switch trigger: `systemPreferences.subscribeWorkspaceNotification('NSWorkspaceActiveSpaceDidChangeNotification')`;
  the provider supplies which desktop is now current.
- `ScreenId` is Electron's display id as a string on every provider.

**Fail-safe.** The backend starts the platform provider and switches to the fallback provider,
logging `desktop-provider fallback reason=<…>` once, when any of these holds: no provider for the
platform; helper binary absent or fails to start; start handshake unanswered within 1s; private
calls reported unavailable; any later request times out (250ms), returns malformed data, or the
helper exits. After switching, the backend sends a fresh `DesktopLayoutReported` and placements
from the fallback provider; the app behaves as on `main` for the rest of the session. No retry.

### Fallback provider (all platforms)

`desktop-provider-fallback.ts`. One desktop per screen, id `<screenId>/only`, always current. A
window's placement is its screen's only desktop; every-desktop is the backend's declaration. Both
capability flags false. Never sends `CurrentDesktopChanged`, so every window is always here and
every rule acts as on `main`.

### macOS provider: native helper process

`desktop-provider-mac.ts` plus a Swift CLI helper, `apps/desktop/native/desktop-helper/main.swift`.

**Helper process, not a Node addon**: a crash in a private call closes a pipe (→ fail-safe)
instead of killing the main process; no rebuild against Electron's Node ABI; the repo has Swift
helpers (`apps/desktop/tests/helpers/cg-windows.swift`, `tools/focus-probes/frontmost-stream.swift`)
and no addon build. Cost: async requests, and any window write comes from another process's
connection.

**Build and packaging.**

- `apps/desktop/scripts/build-desktop-helper.mjs`, run by the desktop `build` script on darwin
  (no-op elsewhere): `swiftc -O`, arm64 (the only packaged mac arch in `electron-builder.yml`), to
  `apps/desktop/dist/native/peek-desktop-helper`.
- `electron-builder.yml extraResources` → `Contents/Resources/peek-desktop-helper`. Located at
  `process.resourcesPath` when packaged, `dist/native` from source.
- Without Xcode command-line tools: the script warns, builds nothing; the app runs on the fallback
  provider.
- App is unsigned (`identity: null`); if signing is enabled, the helper must be signed too.

**Protocol.** One JSON object per line on stdin/stdout. Requests: `hello` (helper version and
which private symbols resolved), `layout`, `placements { windows: number[] }`, `place { window,
desktop }` (probe only). Every private symbol is resolved via `dlsym` at start; a missing symbol
is reported "unavailable" in `hello`, never a launch failure.

**Reads** (window server private calls, as used by yabai, Hammerspoon `hs.spaces`, AltTab):

- Connection: `CGSMainConnectionID()` (also `SLSMainConnectionID`).
- Layout: `CGSCopyManagedDisplaySpaces(cid)` → per display: `Display Identifier` (display UUID, or
  `Main` when displays share desktops), `Current Space`, `Spaces`; each desktop has numeric
  `ManagedSpaceID` / `id64`, `uuid`, `type` (0 ordinary, 4 fullscreen app). Display UUID →
  Electron display id via public `CGGetActiveDisplayList` + `CGDisplayCreateUUIDFromDisplayID`.
- Shared desktops: a single `Main` entry with several active displays ("Displays have separate
  Spaces" off) → desktops reported with `screen: null`.
- A window's desktops: `CGSCopySpacesForWindows(cid, 0x7, [windowNumber])`; more than one id =
  every desktop.
- `DesktopId` = the numeric id as a string.
- Fullscreen desktops are ordinary desktops (a native-fullscreen page lives on its own).

**Naming a window**: its window server number, taken from `getMediaSourceId()` (`window:<n>:0`,
`<n>` believed to be that number). Fallback: match the app's windows by owner pid and bounds via
public `CGWindowListCopyWindowInfo`, as `cg-windows.swift` does.

**No writes on macOS.** `CGSMoveWindowsToManagedSpace` (and older `CGSAddWindowsToSpaces` /
`CGSRemoveWindowsFromSpaces`) and `CGSManagedDisplaySetCurrentSpace` are reported (yabai,
Hammerspoon) to need the Dock scripting addition, hence SIP partly disabled, since macOS 14.5 —
not something Peek can ask of users. Both capability flags are false. The probe tries one move
from the helper on the app's own test window to record the answer; if it works, a later change
may set `canPlaceWindows` and drop the stand-in.

### Linux X11 provider (separate track, unscheduled)

- Reads (EWMH): root `_NET_NUMBER_OF_DESKTOPS`, `_NET_CURRENT_DESKTOP`, `_NET_DESKTOP_NAMES`;
  per-window `_NET_WM_DESKTOP` (`0xFFFFFFFF` = every desktop). Desktops span all monitors →
  reported shared (`screen: null`).
- Writes: `_NET_WM_DESKTOP` client message moves a window; `_NET_CURRENT_DESKTOP` client message
  switches desktop. Both capability flags true.
- Windows named by X window id from `getNativeWindowHandle()`.
- Packaging: helper process like macOS, built against libX11; root property changes are the
  `DesktopChange`.
- Checkable on the remote Linux dev box's virtual X server.

### Wayland

No standard protocol exposes current or per-window workspace to an ordinary app
(`ext-workspace-v1` is for shells/task bars; support varies). Wayland uses the fallback provider.
Under XWayland the X11 provider may start and must pass its handshake.

### Platform summary

| Fact | macOS | Linux X11 | Wayland / fallback |
|---|---|---|---|
| Screens | Electron `screen` | Electron `screen` | Electron `screen` |
| Desktops, and current per screen | helper, private reads | EWMH root properties (shared) | one per screen |
| A switch happened | Electron's workspace notification | root property change | never |
| A window's desktop | helper, private read | `_NET_WM_DESKTOP` | its screen's only desktop |
| Every-desktop | backend's own declaration, confirmed by the read | `_NET_WM_DESKTOP` | backend's declaration |
| Put a window on a desktop | no (needs SIP changes, reported) | yes, client message | no |
| Switch to a desktop | no; raising a window there makes the OS switch | yes, client message | no |

`apps/desktop/CLAUDE.md` lists desktops among what Linux runs do not verify.

### Unverified

- macOS private reads work on the macOS version in use.
- macOS reads need no Accessibility or Screen Recording permission and no SIP change.
- Helper round trip is a few milliseconds.
- electron-builder signs `extraResources` executables on its own.
- macOS `DesktopId` is stable for the login session (not needed across restarts).
- `getMediaSourceId()`'s middle number is the window server window number.
- macOS writes need SIP changes since 14.5 (reported by yabai / Hammerspoon).
- Raising a window on another desktop makes macOS switch, for every backend raise path and with
  "When switching to an application, switch to a Space with open windows" off.
- `getNativeWindowHandle()` gives the X window id under XWayland.
- Which X11 window managers honour EWMH client messages; whether the remote Linux dev box's does
  EWMH desktops.
- Wayland: every compositor; whether Electron runs natively or under XWayland; whether X11
  properties are populated under XWayland.
- Side tasks on Linux are non-activating (Electron documents `'panel'` for macOS only).

## Side tasks: 5c, 5d, 5e and G13

**Rule.** The replacement belongs to the desktop the side task was opened on. This replaces both
G13 ("the desktop the user is on") and row 5d ("the desktop it was on when it lost key"), and
matches `side-task-ends-on-blur.md`'s live check ("the page stays on desktop 2").

**Ending on a switch.** Electron keeps panels on every desktop, so macOS may keep a side task
focused across a switch or report the loss late. `isSideTask` gains the clause
`homeIsCurrent(state, record)`:

- A `CurrentDesktopChanged` that takes the home off its screen ends the side task in that
  transition; `react`'s existing diff emits the reopen.
- If `OsFocusLost` came first, the later switch diffs to nothing. Exactly one reopen either order.
- A switch on another screen leaves the home current and ends nothing.
- With the fallback provider the clause is always true.

`ReopenAsOrdinaryWindow { id, desktop }` carries the home. The port doc
(`window-backend.ts reopenAsOrdinaryWindow`) changes from "belonging to the desktop the user is on"
to "belonging to `desktop`".

**Realization** (the replacement may need to appear on a desktop the user has left):

- **`canPlaceWindows`** (X11; macOS only if the probe's write succeeds): build the replacement
  hidden, `placeWindow(replacement, desktop)`, show without activation. No stand-in.
- **Without `canPlaceWindows` (macOS):** when the side task opens, the backend also shows a
  stand-in: an ordinary window at the panel's bounds, zero opacity, click-through, on the opening
  desktop; backend-private, never registered with the kernel, tracking the panel's bounds. At
  reopen the stand-in becomes the replacement host (opacity restored, input on, page loaded) and
  registers as `replaces: X`. If the side task closes instead (Escape, close request), the stand-in
  is destroyed with it. Moving the page's view instead of reloading is a later choice.
- **Fallback provider:** `desktop` is the screen's only desktop; the replacement shows where the OS
  puts it.

At every reopen the backend reads the stand-in's placement; if not on `desktop`, it logs
`side-task-standin-misplaced` and proceeds (the page appears where the stand-in is).

**Stop condition.** If the probe shows the stand-in does not keep its desktop, the track stops and
reports back with the evidence. It never falls back to letting the page follow the user.

**Close and focus ordering in the kernel.** Registration with `replaces: X` marks X `replacedBy:
<new id>`; `react` diffs that into `CloseWindow X`. On X's `WindowClosed`: app active (5e) → the
kernel raises the replacement, machine-caused; app inactive (5c, 5d) → no raise. This replaces the
promise chain in `ipc.ts reopenWindowAsOrdinary()` and the parked track's `takesKey` payload.

## F7, F9 and the raise gate

New rule under Focus:

> **F9 stay-on-this-desktop.** A focus the manager makes without user intent lands only on a
> window that is here (on a desktop some screen currently shows, or on every desktop). A focus
> with user intent may take the user to another desktop, because the user named that window;
> picking a window in the switcher is such a focus.

F7 rewritten (supersedes the parked track's transient / application split):

> **F7 hide-returns-key.** When the key window hides or closes while the app is active, key goes
> to its prior window if that window is visible and here; otherwise to the topmost visible
> application window that is here; otherwise the manager focuses nothing, and whatever the OS
> focuses next arrives world-caused.

- `successorOnHide()` applies `onCurrentDesktop` to both branches. The kernel keeps choosing a
  successor for application-window closes (the parked track's removal of it is dropped). The
  parked track's other changes stay: focusing the replacement on activation (covered above) and
  the devtools handlers.
- Gate in `react`, not the executor: no `RaiseWindow` without user intent is emitted for a record
  not here. The switcher selection raise (from `pendingSelectionFocus` in the `WindowClosed` arm)
  carries user intent. The executor keeps only environment concerns (headless).

## Taking the user to a window's desktop

For a user-intent raise of a window not here, `react` emits `ShowDesktop { desktop:
record.desktop }` immediately before `RaiseWindow`.

- **`canShowDesktops`** (X11): backend switches desktop, then raises.
- **macOS:** `ShowDesktop` is a no-op; the raise makes the OS switch. The rule check covers the
  switcher case.
- **Fallback:** never emitted.

The resulting switch arrives as an ordinary `CurrentDesktopChanged`.

## Out-of-kernel decisions to move

One commit each, order per "Order of work":

1. **`ipc.ts reopenWindowAsOrdinary()`** (open → close → focus by promise chain) → the `replaces` /
   `replacedBy` state above; the function keeps only building the replacement.
2. **`ipc.ts` hybrid URL dedup** → kernel predicate `admitsReuse(state, record)`: visible and here,
   or hidden (a re-show is expected on the current desktop of its screen; the following placement
   report corrects the kernel if not, and the rule check watches for it). The side-task check moves
   ahead of the dedup: a side-task open never reuses.
3. **`window-kernel-executor.ts` `RaiseWindow` / `planRaise`** → `react` stops emitting what the
   `'suppressed'` plan (app inactive, no user intent) drops, together with F9; `planRaise` keeps
   headless and non-activating realization choices.
4. **`electron-window-backend.ts` focus filters** (`win.on('focus')` drops reports on
   `pendingStackingFocus`, `pendingHideProvokedFocus`, `activationFocusTarget`) → the kernel
   records each expectation when it emits the causing effect (stacking replay, hide of the key
   window, activation with `pendingColdStartFocus`) and classifies the report; the backend reports
   every focus with its raw cause. `hideProvokesFocusReassignment()` becomes a kernel fact likewise.
5. **`electron-window-backend.ts appResignSettleTimer`** (reads izui overlay cooldowns, drops the
   settle) → the timer stays; the overlay transition becomes a kernel fact that makes
   `AppResignSettled` inert in `evolve`.
6. **`main.ts` devtools-opened / devtools-closed** (`kernelAssertFocus()` on the topmost content
   window, possibly on another desktop) → retargeted to the host by the parked track; F9 also
   refuses a machine focus elsewhere. Lands with the parked track.

Stays outside: `armBlurSettle` (translates Electron's event order into "focus left every window";
decides no rule).

## Order of work

1. **Landed as `250051ad`** (minted ids, `DesktopChanged`); reshaped by commit 3.
   - Survives: `DesktopId`; `WindowRecord.desktop`; `WindowRecord.onEveryDesktop` with its
     registration plumbing (`WindowRegistered` event and `RegisterWindow` command fields,
     `window-machine.ts registerWindowWithMachine`, `ElectronWindowBackend.registerWindow`
     returning it for macOS panels); `isOnEveryDesktop`; the provisional stamp on a genuine
     `WindowShown` (`desktopOnShow`, changed to read the window's screen's current desktop instead
     of `State.desktop`); the `attachSpaceChangeListener` subscription as switch trigger; the
     `native-blur` and `os-focus-left-app` log lines; desktop-state tests not depending on minting.
   - Removed by commit 3: `State.desktop`, `State.desktopCounter`, `mintedDesktopId`,
     `DesktopChanged` and its `evolve` arm, `kernelDesktopChanged` in `window-kernel-dispatch.ts`,
     the `focused` read in `attachSpaceChangeListener`, the stamp in the `OsFocusGained` arm, and
     tests for minting, `name`, `focused` stamping and focus stamping.
   - Changed by commit 3: `onCurrentDesktop` keeps name and meaning over the new state; the
     `space-changed` log line prints each screen's current desktop and each window's
     `id:screen/desktop|*|?:v|h` from the new fields.
2. **Remove the first probe's hooks**: `installDesktopProbe` and its `probe*` members in
   `electron-window-backend.ts`, own commit.
3. **Model with the fallback provider only.** Kernel: `State.screens` / `State.desktops`,
   `WindowRecord.screen`, the three events, `isCurrentDesktop`, `homeIsCurrent`, reshaped
   `onCurrentDesktop`, `ReopenAsOrdinaryWindow.desktop` (filled, not acted on). Backend:
   `desktop-provider.ts`, `desktop-provider-fallback.ts`, the report → event loop. No rule reads the
   new state; behaviour unchanged on every platform (pinned by the property test).
4. **macOS helper and provider**: `main.swift`, `build-desktop-helper.mjs`, the `extraResources`
   entry, `desktop-provider-mac.ts`, the fail-safe, temporary probe hooks behind
   `PEEK_DESKTOP_PROBE=1`. Then the probe on a real Mac with a person. Stop and report if ids are
   not stable across returns or the stand-in does not keep its desktop.
5. **Side task ends on a switch** (`isSideTask` clause) and kernel `replaces` / `replacedBy` close
   and focus ordering (decision 1). Reword G13 and row 5d in `docs/design/window-rules.md`; add the
   switcher's cross-desktop reach under rule 1. Remove probe hooks if still present.
6. **Replacement on its home desktop**: the stand-in for providers without `canPlaceWindows`, the
   `placeWindow` path for those with it, the `side-task-standin-misplaced` check.
7. **F9 gate and F7 rewrite** in `react` / `successorOnHide()`, `ShowDesktop` before a user-intent
   raise of a window not here, switcher selection carrying user intent, and decision 3. The parked
   track rebases onto this and drops its F7 change.
8. Decision 2 (URL dedup).
9. Decision 4 (focus filters).
10. Decision 5 (resign settle).
11. Decision 6, with the parked track.
12. **Linux on X11**, separate unscheduled track: EWMH provider with reads and writes, verifiable
    on the remote Linux dev box's virtual X server if its window manager implements EWMH desktops.

## Tests

Kernel unit tests (`window-kernel.test.ts`), one group per rule:

- **Desktop state.** `DesktopLayoutReported` replaces screens and desktops; `CurrentDesktopChanged`
  writes one screen's current desktop, leaves `key` alone, adds an unknown screen;
  `WindowPlacementReported` writes screen and desktop, leaves a field alone on `null`, keeps an
  every-desktop window's home; a first show stamps provisionally from the window's screen; focus
  does not stamp; before any report every window is here; `onCurrentDesktop` over {every desktop,
  current on its screen, current on another screen, not current, never shown}; shared desktops
  (`screen: null`) current on every screen.
- **5c.** Side task, `OsFocusLost`, app inactive: one `ReopenAsOrdinaryWindow` with `desktop` = the
  home; the `replaces` registration takes that desktop; `CloseWindow` for the old id; no
  `RaiseWindow`; not key; not held; `appActive` still false.
- **5d, both orders.** `CurrentDesktopChanged` on its screen then `OsFocusLost`, and the reverse:
  exactly one reopen, carrying the home (not the new current desktop); no `RaiseWindow`. Switch on
  another screen: no reopen.
- **5e.** Side task key, `AppActivated`: one reopen; after the old `WindowClosed`, one machine
  `RaiseWindow` of the replacement.
- **G13.** Escape or close request on a side task: no reopen (existing tests stay).
- **F7 / F9.** Prior window here: raised. Prior not here: topmost application window here raised.
  None here: no raise, no token. User-intent raise of a window not here: emitted, preceded by
  `ShowDesktop` with its desktop; same for a switcher selection. Machine raise of a window not
  here: not emitted.
- **Dedup.** `admitsReuse` table; a side-task open never reuses.

Property test (`window-kernel-properties.test.ts`): over random event sequences whose desktop
events are only what the fallback provider sends (one layout, placements on each screen's only
desktop, no `CurrentDesktopChanged`), every effect list equals the one with desktops ignored.

Provider tests (`desktop-provider.test.ts`, every platform): fallback layout and placements from a
stubbed `screen`; macOS provider against a fake helper (node script speaking the protocol) for
parsing, a shared-desktops layout, and each fail-safe case (binary missing, handshake timeout,
symbols unavailable, malformed line, request timeout, helper exit), each ending on the fallback
provider with one `desktop-provider fallback` line. The real helper runs only in the probe.

Executor tests (`window-kernel-executor.test.ts`): `sideTaskSetup()` cases for 5c/5d/5e assert
backend calls in order (reopen with its desktop, close, for 5e one raise); `ShowDesktop` reaches
the backend before its raise.

`cmd-url-unfocused.spec.ts` (darwin-only): keeps its assertions; adds a `CurrentDesktopChanged`
injection through the executor's test surface for 5d. Cannot see real desktops.

Static: `node scripts/check-platform-leak.mjs`; `node scripts/check-r2-window-ops.mjs` (native
window calls stay in the backend; provider files are backend files, added to its allowed set if
flagged).

## Live checks on macOS (a person does only the gestures)

Run from this worktree with `PROFILE=kernel-desktops PEEK_PROFILE=kernel-desktops
TMPDIR=<worktree>/.tmp`. The agent builds, starts the app, reads `main.log`, and asks the person
only for the gestures below.

### The probe, after commit 4

Hooks (temporary, `PEEK_DESKTOP_PROBE=1`, no behaviour change): on every switch and screen change,
log `desktop-read` with the helper's full layout and every registered window's placement;
Control+Option+Command+1 runs the write test.

Precondition, checked by the agent in the log: `desktop-provider started name=mac` and a `hello`
with every private symbol resolved. If the fallback line appears instead, the probe stops and the
reason is the result.

Setup: two desktops on the main screen, another app in front on each, the app started on
desktop 1. With a second screen, two desktops there too.

| # | Gesture | Verifies |
|---|---|---|
| 1 | On desktop 2, open a page from the palette. | Page reported on every desktop with home = desktop 2's id; layout shows two desktops on the main screen, desktop 2 current. |
| 2 | Control+Left, wait two seconds, Control+Right. | Current-desktop reads go 2 → 1 → 2; desktop 2 has the same id both times. |
| 3 | Say which desktop the page is on now (switch to look, come back to desktop 2). | Helper's read for the page's window (the replacement, after reopen) matches: the Electron-derived window number is the window server's. |
| 4 | Control+Option+Command+1, switch to desktop 1, say whether a small red square is there. | Hook shows on desktop 2 a small opaque red test window and an invisible stand-in (as in "Side tasks"), logs both placements, asks the helper to move the red window to desktop 1, logs its placement. Red square on desktop 1 and read as desktop 1 = helper move works. Stand-in read on desktop 2 before and after the switch. |
| 5 | Still on desktop 1, open Mission Control, say whether desktop 2's thumbnail shows an empty window or frame, close it. | Stand-in leaves no visible trace; agent re-reads its placement. |
| 6 | Second screen only: click its desktop background, Control+Right, Control+Left. | Only that screen's current desktop changes, and its screen id is Electron's display id; with shared desktops, both screens change together. |

The agent then closes the test windows and the app. Results go into **Result**. The track stops if
gesture 2 shows ids changing on return, or gestures 4–5 show the stand-in off desktop 2 or visible
in Mission Control. A failed write at gesture 4 is expected and changes nothing.

### The rule check, after commit 7

1. Desktop 2, other app in front: palette → URL → type in the page → click the other app. Page
   stays on desktop 2 behind the other app; one `side-task-reopen`.
2. Same, but switch to desktop 1 instead of clicking. Desktop 1 shows no page; desktop 2 has it.
3. Same, but cmd+tab to Peek. The page is the front window with key.
4. After 2, on desktop 1, open the same URL from the palette: a new side task on desktop 1; the
   desktop-2 window untouched; no desktop switch.
5. Switcher on desktop 1, pick the desktop-2 page: user taken to desktop 2, page has key.
6. On desktop 2, close the key page whose prior window is on desktop 1: no desktop switch; key goes
   to a window on desktop 2 or to nothing.

## Done when

Kernel, property, provider and executor tests pass; the `tracks.json` verify and the platform-leak
check are green; probe answers are recorded in **Result**; the rule check behaves as listed; the
full gate (`yarn test:desktop:electron`, only with an explicit OK) shows no failure outside
`apps/desktop/tests/gate-baseline.md`.

## Result

**First probe (inferred ids), findings:**

- macOS order for a switch away from a side task: `space-changed`, then `native-blur` and
  `os-focus-left-app` ~20ms later, then `OsFocusLost` and the reopen. The switch always preceded
  the blur. The design does not depend on this order.
- Inferred ids fail: every switch minted a new id (two desktops → `desktop-2` … `desktop-15`), so
  returns were never recognised. Electron exposes no desktop identity on macOS.
- Behaviour matched `main` (page reopened on desktop 1).

**Second probe, native helper:** (filled by the implementing track)
