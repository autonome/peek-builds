---
enabled: false
touches: [apps/desktop/main/window-kernel.ts, apps/desktop/main/window-kernel.test.ts, apps/desktop/main/window-kernel-properties.test.ts, apps/desktop/main/window-kernel-executor.ts, apps/desktop/main/window-kernel-executor.test.ts, apps/desktop/main/window-kernel-dispatch.ts, apps/desktop/main/window-backend.ts, apps/desktop/main/electron-window-backend.ts, apps/desktop/main/desktop-provider.ts, apps/desktop/main/desktop-provider-fallback.ts, apps/desktop/main/desktop-provider-mac.ts, apps/desktop/main/desktop-provider.test.ts, apps/desktop/native/desktop-helper/main.swift, apps/desktop/scripts/build-desktop-helper.mjs, apps/desktop/electron-builder.yml, apps/desktop/package.json, apps/desktop/main/ipc.ts, apps/desktop/main/main.ts, apps/desktop/main/tile-ipc.ts, apps/desktop/tests/desktop/cmd-url-unfocused.spec.ts, docs/design/window-rules.md]
depends-on: []
---

# Desktops are kernel state

Peek item `a0ea0c2d` and the parked track `close-raises-other-desktop`. With another app in front
and two macOS desktops, a page opened from the palette on desktop 2 can follow the user to desktop
1, drop behind the other app there, and vanish from desktop 2. The cause is on `main`: the window
kernel knows nothing about desktops, so every rule in `docs/design/window-rules.md` that mentions
one is decided by when native calls happen to run.

This spec is design only. Each numbered commit under "Order of work" is its own later change.

**Revision after the first probe run.** The first design inferred desktop identity from the
switch notification and the key window, minting a new id on every switch. The probe (see
**Result**) showed that cannot work: two real desktops produced fourteen ids, returning to a
desktop was never recognised, and `onCurrentDesktop` could not be answered. Peek now learns real
desktop identities. The kernel holds a platform-neutral model of screens and desktops; the
Electron backend fills it through a desktop provider, with one implementation per platform and a
fallback that reports what the app assumes today.

## The rules, as the user sees them

Meaning unchanged from the signed-off design. "The desktop the user is on" means, with several
screens, the desktop currently shown on the screen in question; a window is "here" when its
desktop is currently shown on its screen.

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
   "Side tasks" for why the switch report itself is used). Switching desktop on a different
   screen from the page's does not take focus from it and does not end it.
4. **Closing or hiding a window never takes you to another desktop.** Key goes back to the window
   you came from if it is here, else to the frontmost page that is here, else to nothing (F7 as
   rewritten below).
5. **Opening a URL that is already open on another desktop opens it here**, as a new window,
   instead of reusing the one over there. Opening a URL from the palette over another app always
   opens a new side task; it never reuses an ordinary window.

   Why: switching to a desktop is deliberate, so what the user does there happens there. A later
   visual cue that offers "go to the open window" or "open a new one here" could revisit this,
   because the user would then choose explicitly.
6. **These rules hold on every platform with desktops.** macOS has them, and so does Linux in
   essentially every window manager (EWMH workspaces on X11; Wayland compositors each have their
   own). Where the backend has a provider that reads real desktops, the rules apply as written.
   Where it has only the fallback provider, the app sees one desktop per screen and behaves as it
   does today, which can take the user to another desktop; "Platforms" states which applies where.

## What the code does today

On `main` (before this track):

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

On this branch, commit 1 (`250051ad`) added minted desktop ids; "Order of work" says what of it
survives.

Live timeline (fix-build run of 2026-09-26, not kept in the repo): side task opened on desktop 2 →
`space-changed` → `OsFocusLost` → `effect-reopen-as-ordinary takesKey=false` → replacement shown
on desktop 1, unfocused, behind the other app → panel closed → a later open of the same URL reused
the desktop-1 window and its raise was suppressed until `AppActivated`.

## The model: screens and desktops

The kernel knows two platform-neutral things and nothing about any OS or window manager:

- **A screen** is a hardware display.
- **A desktop** is a virtual desktop. Each desktop belongs to one screen, or is shared across all
  screens when the platform works that way (one set of desktops spanning every display). Each
  screen shows exactly one desktop at a time, its current desktop; when desktops are shared, every
  screen has the same current desktop.

Ids are opaque strings the provider chooses (`ScreenId`, `DesktopId`). The kernel only compares
them. They must be stable for as long as the thing they name exists in the session: returning to
a desktop yields the id it had before. That is the property the first design lacked.

### Kernel state

- `State.screens: readonly ScreenState[]`, where `ScreenState = { id: ScreenId; current:
  DesktopId }`.
- `State.desktops: readonly DesktopState[]`, where `DesktopState = { id: DesktopId; screen:
  ScreenId | null }` (`null` means shared across screens).
- `WindowRecord.screen?: ScreenId` — the screen the window is on, as last reported.
- `WindowRecord.desktop?: DesktopId` — the desktop the window is on, as last reported. For a
  window on every desktop it is the desktop the window was first shown on, its home: for a side
  task, the desktop it was opened on. Absent until first shown or first reported.
- `WindowRecord.onEveryDesktop?: boolean` — the window is on every desktop. Declared at
  registration by the backend when its platform will keep the window there whatever is asked (the
  Electron backend says so for panels on macOS), and also set by a placement report that says so.
  The role that asks to follow the user (`desktopMembership: 'follow'`) is read from
  `desktopMembership`, not copied here; `isOnEveryDesktop(record)` reads both.

Initial state: no screens, no desktops. Until the first report the kernel treats every window as
here (below), which is today's behaviour.

Predicates:

- `isCurrentDesktop(state, desktop): boolean` — some screen shows it. True when `state.screens`
  is empty (no report yet: one implicit desktop).
- `onCurrentDesktop(state, record): boolean` — true when `isOnEveryDesktop(record)`, or when
  `record.desktop` is a current desktop. False covers both "known to be elsewhere" and "never
  shown"; the rules treat them alike, because a wrong guess either way switches the user's
  desktop. One exception to that: before the first layout report every window counts as here.
- `homeIsCurrent(state, record): boolean` — `record.desktop` is a current desktop, ignoring
  `onEveryDesktop`. Used by the side-task rule, where the page is on every desktop but belongs to
  one.

### Events (facts, never rejected)

- `DesktopLayoutReported { screens: ScreenState[]; desktops: DesktopState[] }` — the whole layout,
  sent at start, when screens are added, removed or rearranged, and whenever the provider notices
  desktops added or removed. Replaces `State.screens` and `State.desktops`. A window whose
  `desktop` no longer exists keeps the stale id (it counts as not here) until its next placement
  report.
- `CurrentDesktopChanged { screen: ScreenId; desktop: DesktopId }` — one screen now shows another
  desktop. With shared desktops the provider sends one per screen. Writes `current` of that
  screen; an unknown screen is added. Never writes `key`: key changes only by `OsFocusGained` /
  `OsFocusLost` (F1).
- `WindowPlacementReported { id: WindowId; screen: ScreenId | null; desktop: DesktopId | null;
  onEveryDesktop: boolean }` — where one registered window is. `null` means the provider could
  not tell; the field is then left as it was. For a window on every desktop, `desktop` is ignored
  once the record has a home.

How `desktop` is written:

- **Placement report**: authoritative, as above.
- **Shown, provisionally**: a `WindowShown` that flips `visible` to true stamps `desktop` with the
  current desktop of the window's screen (the first screen if the screen is unknown), unless the
  record already has one and is on every desktop. A placement report follows and corrects it where
  the provider can read windows. With the fallback provider the stamp is the only source, and it
  is right by construction (one desktop per screen).
- **Replacement**: a window registered with `replaces: X` takes X's `desktop` and `screen`, and
  its own first show does not re-stamp them (the backend has placed it there; its placement report
  confirms or corrects).
- **Focus does not stamp.** Commit 1 stamped on `OsFocusGained`; with real reads that is a race
  (a raise that switches desktops reports focus before the switch) and adds nothing.

### Effects

- `ReopenAsOrdinaryWindow { id; desktop: DesktopId | null }` — the replacement must be on
  `desktop` (the side task's home; `null` when unknown, meaning "wherever the backend shows it").
- `ShowDesktop { desktop: DesktopId }` — make that desktop current on its screen. Emitted only
  immediately before a user-intent `RaiseWindow` of a window that is not here (the switcher). A
  backend that cannot switch desktops ignores it; see "Taking the user to a window's desktop".

Platform neutrality: the names added above the port are "screen", "desktop", `ScreenId`,
`DesktopId`, the three events and two effects above, and `onEveryDesktop`. None is in
`scripts/check-platform-leak.mjs FORBIDDEN`. Every macOS or X11 name, including the private calls
below, stays in the provider files, which the check does not scan.

## The desktop provider (backend side)

`apps/desktop/main/desktop-provider.ts` defines an interface owned by the Electron backend. The
kernel never sees it; the backend turns what it reports into the events above.

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

`NativeWindowRef` carries what a provider needs to name a window to its platform (below);
`DesktopChange` is "layout changed" or "current desktop changed on screen S". A provider that
lacks a capability says so through the two flags and answers `false` from the call.

The backend's use:

- At start, and on every `DesktopChange`: read `layout()` → `DesktopLayoutReported` (if changed),
  then one `CurrentDesktopChanged` per screen whose current desktop differs, then `placements()`
  for every registered window → one `WindowPlacementReported` per window whose placement differs.
- After each genuine show and each registration: `placements()` for that window.
- For `ReopenAsOrdinaryWindow` and `ShowDesktop`: as described in "Side tasks" and "Taking the
  user to a window's desktop".

**Where Electron already has the fact, it is used; the provider reaches around Electron only for
what Electron lacks.** Screens come from Electron's `screen` module (`getAllDisplays`, and its
`display-added` / `display-removed` / `display-metrics-changed` events are a `DesktopChange`). A
window's screen comes from `screen.getDisplayMatching(bounds)`. On every-desktop, the backend
already knows what it declared (`setVisibleOnAllWorkspaces`, panels on macOS); the provider only
reports it where the platform says otherwise. The switch trigger on macOS stays Electron's
`systemPreferences.subscribeWorkspaceNotification('NSWorkspaceActiveSpaceDidChangeNotification')`;
the provider supplies what that notification lacks, which desktop is now current. `ScreenId` is
Electron's display id as a string, on every provider, so screens agree across providers.

**Fail-safe.** The backend starts the platform provider and falls back to the fallback provider,
logging `desktop-provider fallback reason=<…>` once, when: the provider is missing on this
platform, its helper binary is absent or will not start, its start handshake does not answer
within one second, it reports the private calls unavailable, or any later request times out
(250ms), returns malformed data, or its helper exits. After a fall-back the backend sends a fresh
`DesktopLayoutReported` and placements from the fallback provider, so the kernel state is
consistent again; the app then behaves as today for the rest of the session. No retry.

### Fallback provider (every platform; today's behaviour)

`desktop-provider-fallback.ts`. One desktop per screen, id `<screenId>/only`, always current. A
window's placement is its screen's only desktop, and every-desktop is what the backend declared.
`canPlaceWindows` and `canShowDesktops` are false. No `CurrentDesktopChanged` is ever sent, so
every window is always here and every rule acts as on `main`.

### macOS provider: a native helper process

`desktop-provider-mac.ts` with a small Swift command-line helper,
`apps/desktop/native/desktop-helper/main.swift`.

**Why a helper process and not a Node addon.** The calls are private and undocumented; a bad call
can crash the calling process. In a helper, a crash is a closed pipe, which the fail-safe turns
into the fallback provider; in an addon it takes down the app's main process. A helper also needs
no rebuild against Electron's Node ABI, and the repo has no native addon build today, while it
already has Swift helpers (`apps/desktop/tests/helpers/cg-windows.swift`,
`tools/focus-probes/frontmost-stream.swift`). The cost: requests are asynchronous (a few
milliseconds per round trip, *unverified*) and window writes, if ever wanted, would be issued
from another process's connection (see below).

**Build and packaging.** `apps/desktop/scripts/build-desktop-helper.mjs`, run by the desktop
`build` script on darwin only (a no-op elsewhere), compiles with `swiftc -O` for arm64 (the only
packaged mac arch in `electron-builder.yml`) into `apps/desktop/dist/native/peek-desktop-helper`.
`electron-builder.yml extraResources` copies it to `Contents/Resources/peek-desktop-helper`; the
provider finds it at `process.resourcesPath` when packaged and in `dist/native` from source.
Building needs the Xcode command-line tools; without them the script prints a warning, builds
nothing, and the app runs on the fallback provider. The app is unsigned today (`identity: null`);
if signing is turned on, the helper must be signed with it (*unverified* whether electron-builder
signs `extraResources` executables on its own).

**Protocol.** One JSON object per line on stdin and stdout. Requests: `hello` (answers the helper
version and which private symbols resolved), `layout`, `placements { windows: number[] }`,
`place { window, desktop }` (probe only, see writes). The helper resolves every private symbol
with `dlsym` at start, so a symbol removed in a future macOS gives a clean "unavailable" in
`hello` rather than a launch failure.

**Reads, and what they need.** From the window server's private calls, as used by open-source
window tools (yabai, Hammerspoon's `hs.spaces`, AltTab). Everything in this list is *unverified*
on the macOS version in use until the probe runs; that none of them needs Accessibility or Screen
Recording permission, or any change to System Integrity Protection, is the believed state from
those tools and is also *unverified*.

- Connection: `CGSMainConnectionID()` (also exported as `SLSMainConnectionID`).
- Desktops per display and the current one per display: `CGSCopyManagedDisplaySpaces(cid)`
  returns one entry per display with a `Display Identifier` (a display UUID string, or `Main`
  when displays share desktops), a `Current Space` and a `Spaces` list; each desktop carries a
  numeric `ManagedSpaceID` / `id64`, a `uuid` and a `type` (0 an ordinary desktop, 4 a fullscreen
  app's desktop). The helper maps each display UUID to the display id Electron uses through the
  public `CGGetActiveDisplayList` and `CGDisplayCreateUUIDFromDisplayID`.
- Shared across screens: a single entry named `Main` while several displays are active means
  the "Displays have separate Spaces" setting is off; its desktops are reported with
  `screen: null`.
- Desktops a window is on: `CGSCopySpacesForWindows(cid, 0x7, [windowNumber])`. Several ids back
  means the window is on every desktop.
- `DesktopId` is the numeric id as a string. Believed stable for the login session and not across
  restarts (*unverified*); the kernel needs only the session.
- Fullscreen desktops are desktops like any other: a page in native fullscreen lives on its own.

**Naming a window.** The window server's window number. Electron's `getMediaSourceId()` returns
`window:<number>:0` on macOS, where the middle number is believed to be that window number
(*unverified*; the probe checks it by reading a window whose desktop the person states). If it is
not, the helper matches the app's windows by owner process id and bounds through the public
`CGWindowListCopyWindowInfo`, as `cg-windows.swift` already does.

**Writes are not used on macOS.** Moving a window to another desktop
(`CGSMoveWindowsToManagedSpace`, or the older `CGSAddWindowsToSpaces` /
`CGSRemoveWindowsFromSpaces`) is reported by yabai and Hammerspoon to have stopped working for
ordinary processes in macOS 14.5, and to need the Dock scripting addition, which needs System
Integrity Protection partly disabled; switching the current desktop
(`CGSManagedDisplaySetCurrentSpace`) is reported to need the same. None of this is verified here,
and none of it is something Peek can ask a user to do. So the macOS provider sets
`canPlaceWindows` and `canShowDesktops` to false. The probe tries one move from the helper on a
test window of the app's own, only to record the answer; the design does not depend on it. If it
does work, a later change may flip `canPlaceWindows`, and the stand-in below becomes unnecessary.

### Linux X11 provider (separate track, unscheduled)

The window manager publishes the facts Electron does not pass on, as EWMH properties:
`_NET_NUMBER_OF_DESKTOPS`, `_NET_CURRENT_DESKTOP` and `_NET_DESKTOP_NAMES` on the root window,
`_NET_WM_DESKTOP` on each window (`0xFFFFFFFF` means every desktop). EWMH desktops span every
monitor, so they are reported shared (`screen: null`). Unlike macOS, EWMH also defines writes an
ordinary client may send: a `_NET_WM_DESKTOP` client message moves a window, a
`_NET_CURRENT_DESKTOP` client message switches desktop. So this provider would set both
capability flags. Windows are named by their X window id, which Electron's
`getNativeWindowHandle()` returns on Linux (*unverified* under XWayland). Packaging: a helper
process like the macOS one, built on Linux against libX11, watching root property changes for
`DesktopChange`. Which window managers honour the client messages, and whether the remote Linux
dev box's window manager implements EWMH desktops at all, is *unverified*; its virtual X server
makes it checkable there.

### Wayland

No standard protocol tells an ordinary app which workspace is current or which one its windows
are on; `ext-workspace-v1` exists for shells and task bars, and support differs by compositor.
Wayland gets the fallback provider. *Unverified* for every compositor, including whether Electron
runs natively on Wayland or under XWayland on a given system (under XWayland the X11 properties
may or may not be populated, so the X11 provider might start and must pass its handshake).

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

A side task on Linux has a further gap: Electron's window-type documentation lists `'panel'` for
macOS only, so whether a side task is non-activating on Linux at all is *unverified*.
`apps/desktop/CLAUDE.md` lists desktops among what Linux runs do not verify today.

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
normally is: `isSideTask` gains one clause, `homeIsCurrent(state, record)`. A
`CurrentDesktopChanged` that takes the page's home off its screen makes the side task stop being
one in that transition, and `react`'s existing diff emits the reopen. If `OsFocusLost` came first,
the diff already fired and the later switch diffs to nothing. Exactly one reopen either way. The
first probe run confirmed the order on macOS (switch report first, blur about 20ms later), but the
design does not depend on it. A switch on another screen leaves the home current and ends
nothing. With the fallback provider no switch is ever reported, and the clause is always true.

`ReopenAsOrdinaryWindow { id, desktop }` carries the home. Its promise, stated in the port doc
(`window-backend.ts reopenAsOrdinaryWindow`), changes from "belonging to the desktop the user is
on" to "belonging to `desktop`".

**Realization.** The replacement must appear on a desktop the user may no longer be on.

- **With `canPlaceWindows`** (X11, or macOS only if the probe's write test ever succeeds): build
  the replacement hidden, `placeWindow(replacement, desktop)`, then show it without activation.
  No stand-in.
- **Without it, the macOS case:** nothing, public or usable private, places a window on a desktop
  other than the current one, so the backend prepares when the side task opens. Next to the panel
  it shows a stand-in: an ordinary window at the panel's bounds, zero opacity and click-through,
  on the desktop the side task opens on. It is backend-private, never registered with the kernel,
  and follows the panel's bounds. At the reopen the stand-in becomes the replacement host
  (opacity restored, input on, the page loaded into it) and registers with the kernel as
  `replaces: X`. If the side task closes instead (Escape, close request), the stand-in is
  destroyed with it. Whether the page's view moves into the stand-in instead of reloading is a
  later choice, as in `side-task-ends-on-blur.md`.
- **Fallback provider:** `desktop` is the screen's only desktop, and the replacement is shown
  where the OS puts it, as today.

The stand-in is still needed on macOS, because real ids give reads, not writes. What changes is
that its behaviour is now checked by reading, not by eye: the helper reports the stand-in's
desktop, so "does it keep its desktop" is a logged fact rather than something a person must look
for. The backend also checks it
at every reopen: if the placement read says the stand-in is not on `desktop`, it logs
`side-task-standin-misplaced` and proceeds (the page appears where the stand-in is).

**If the stand-in does not keep its desktop, the plan stops.** No known way then remains on
macOS to put the replacement where the page was opened, without SIP changes. The track stops
and reports back with the probe's evidence. It does not fall back to letting the page follow the
user to another desktop.

**Close and focus ordering, pulled into the kernel.** Registration with `replaces: X` marks X
`replacedBy: <new id>`; `react` diffs that into `CloseWindow X`. When X's `WindowClosed` arrives
and the app is active (5e: the app became active with the page in hand), the kernel raises the
replacement, machine-caused; with the app inactive (5c, 5d) it raises nothing. This replaces the
promise chain in `ipc.ts reopenWindowAsOrdinary()` and the parked track's `takesKey` payload: the
answer is `appActive` at the moment the old window is gone, read from state.

## F7, F9 and the raise gate

New rule, added under Focus:

> **F9 stay-on-this-desktop.** A focus the manager makes without user intent lands only on a
> window that is here (on a desktop some screen currently shows, or on every desktop). A focus
> with user intent may take the user to another desktop, because the user named that window;
> picking a window in the switcher is such a focus.

F7 rewritten (supersedes the parked track's split between transient and application closes):

> **F7 hide-returns-key.** When the key window hides or closes while the app is active, key goes
> to its prior window if that window is visible and here; otherwise to the topmost visible
> application window that is here; otherwise the manager focuses nothing, and whatever the OS
> focuses next arrives world-caused.

`successorOnHide()` applies `onCurrentDesktop` to both branches. The parked track removed the
successor from application-window closes because the kernel could not tell desktops apart; with
this design it can, so the kernel keeps choosing among windows that are here, which also avoids
the parked spec's own caveat (the OS handing key to the page chrome). The parked track's other two
changes stay: focusing the replacement on activation (now covered above) and the devtools
handlers.

Where the gate lives: `react`, not the executor. A `RaiseWindow` effect without user intent is not
emitted for a record that is not here. The switcher's selection raise, spent from
`pendingSelectionFocus` in the `WindowClosed` arm, carries user intent so it passes the gate. The
executor keeps only what is about the environment (headless).

## Taking the user to a window's desktop

When a user-intent raise targets a window that is not here, `react` emits `ShowDesktop { desktop:
record.desktop }` immediately before the `RaiseWindow`.

- **`canShowDesktops`** (X11): the backend switches desktop, then raises.
- **macOS:** `ShowDesktop` is a no-op; raising a window on another desktop makes the OS switch to
  it (parked spec evidence: `raise-realized id=wm-3` then `space-changed`). *Unverified* whether
  that holds for every raise path the backend uses, and under the "When switching to an
  application, switch to a Space with open windows" setting turned off; the rule check covers the
  switcher case.
- **Fallback:** never emitted, because every window is here.

The resulting switch arrives as an ordinary `CurrentDesktopChanged`.

## Out-of-kernel decisions, and where each goes

Each is one later commit, in this order (see "Order of work"):

1. **`ipc.ts reopenWindowAsOrdinary()`** — open → close → focus by promise chain. Moves to the
   `replaces` / `replacedBy` state above; `reopenWindowAsOrdinary()` keeps only building the
   replacement.
2. **`ipc.ts` hybrid URL dedup** — reuses by URL before the side-task check, wherever the window
   is. Becomes a kernel predicate `admitsReuse(state, record)`: visible and here, or hidden (a
   re-show is expected to land on the current desktop of its screen; the placement report after
   the show corrects the kernel if not, and the rule check watches for it). The side-task check
   moves ahead of the dedup: an open that is a side task never reuses.
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

1. **Landed as `250051ad`: minted ids, `DesktopChanged`.** Reshaped by commit 3. What survives
   unchanged: `DesktopId`; `WindowRecord.desktop`; `WindowRecord.onEveryDesktop` with its
   registration plumbing (the `WindowRegistered` event and `RegisterWindow` command fields,
   `window-machine.ts registerWindowWithMachine`, `ElectronWindowBackend.registerWindow` returning
   it for macOS panels); `isOnEveryDesktop`; the provisional stamp on a genuine `WindowShown`
   (`desktopOnShow`, which will read the window's screen's current desktop instead of
   `State.desktop`); the `attachSpaceChangeListener` subscription as the switch trigger; the
   `native-blur` and `os-focus-left-app` log lines; the desktop-state tests that do not depend on
   minting. What commit 3 removes: `State.desktop`, `State.desktopCounter`, `mintedDesktopId`, the
   `DesktopChanged` event and its `evolve` arm, `kernelDesktopChanged` in
   `window-kernel-dispatch.ts`, the `focused` read in `attachSpaceChangeListener`, the stamp in the
   `OsFocusGained` arm, and the tests for minting, `name`, `focused` stamping and focus stamping.
   What it changes: `onCurrentDesktop` keeps its name and meaning over the new state, and the
   `space-changed` log line prints each screen's current desktop and each window's
   `id:screen/desktop|*|?:v|h` from the new fields.
2. **Remove the first probe's hooks**: `installDesktopProbe` and its `probe*` members in
   `electron-window-backend.ts`, in their own commit. They were built for the inferred-id design
   and are not reused.
3. **The model, with the fallback provider only.** Kernel: `State.screens` / `State.desktops`,
   `WindowRecord.screen`, the three events, `isCurrentDesktop`, `homeIsCurrent`, the reshaped
   `onCurrentDesktop`, the `ReopenAsOrdinaryWindow.desktop` field (filled, not yet acted on).
   Backend: `desktop-provider.ts` (interface), `desktop-provider-fallback.ts`, and the backend
   loop that turns provider reports into events. Nothing reads the new state in a rule yet, and
   behaviour is unchanged on every platform (the property test pins it).
4. **The macOS helper and provider.** `main.swift`, `build-desktop-helper.mjs`, the
   `extraResources` entry, `desktop-provider-mac.ts`, the fail-safe, and temporary probe hooks
   behind `PEEK_DESKTOP_PROBE=1` (below). Then the probe on a real Mac with a person. If ids are
   not stable across returns, or the stand-in does not keep its desktop, stop here and report.
5. **Side task ends on a switch** (`isSideTask` clause) and the `replaces` / `replacedBy` close
   and focus ordering in the kernel (decision 1). G13 and row 5d reworded in
   `docs/design/window-rules.md`, and the switcher's reach across desktops written under rule 1.
   Probe hooks removed in the same commit if not already.
6. **The replacement on its home desktop**: the stand-in in the Electron backend for providers
   without `canPlaceWindows`, the `placeWindow` path for those with it, and the
   `side-task-standin-misplaced` check.
7. **F9 gate and F7 rewrite** in `react` / `successorOnHide()`, `ShowDesktop` before a
   user-intent raise of a window that is not here, the switcher selection carrying user intent,
   and decision 3. The parked track rebases onto this and drops its F7 change.
8. Decision 2 (URL dedup).
9. Decision 4 (focus filters).
10. Decision 5 (resign settle).
11. Decision 6 lands with the parked track.
12. **Linux on X11**, a separate track, not scheduled: the EWMH provider with reads and writes.
    Verifiable on the remote Linux dev box's virtual X server, if its window manager implements
    EWMH desktops.

## Tests

Kernel unit tests (`window-kernel.test.ts`), one group per rule:

- **Desktop state.** `DesktopLayoutReported` replaces screens and desktops; `CurrentDesktopChanged`
  writes one screen's current desktop and leaves `key` alone, and adds an unknown screen;
  `WindowPlacementReported` writes screen and desktop, leaves a field alone on `null`, and keeps an
  every-desktop window's home; a first show stamps provisionally from the window's screen; focus
  does not stamp; before any report every window is here; `onCurrentDesktop` over the table
  {every desktop, current on its screen, current on another screen, not current, never shown};
  shared desktops (`screen: null`) current on every screen.
- **5c.** Side task, `OsFocusLost` with the app inactive: one `ReopenAsOrdinaryWindow` whose
  `desktop` is the side task's home; the replacement registered with `replaces` takes that
  desktop; `CloseWindow` for the old id; no `RaiseWindow`; not key; not held; `appActive` still
  false.
- **5d, both orders.** Side task, `CurrentDesktopChanged` on its screen then `OsFocusLost`, and the
  reverse: exactly one reopen, carrying the home, not the new current desktop; no `RaiseWindow`.
  A switch on another screen: no reopen.
- **5e.** Side task key, `AppActivated`: one reopen; after the old `WindowClosed`, one machine
  `RaiseWindow` of the replacement.
- **G13.** Escape or a close request on a side task: no reopen (existing tests stay).
- **F7 / F9.** Prior window here: raised. Prior not here: topmost application window that is here
  raised instead. None here: no raise and no token. A user-intent raise of a window that is not
  here is emitted, preceded by `ShowDesktop` with its desktop; so is a switcher selection of one.
  A machine raise of a window that is not here is not emitted.
- **Dedup.** `admitsReuse` table; a side-task open never reuses.

Property test (`window-kernel-properties.test.ts`): over random event sequences whose desktop
events are only what the fallback provider sends (one layout, placements on each screen's only
desktop, no `CurrentDesktopChanged`), every effect list equals the one produced with desktops
ignored. This pins the behaviour of every platform on the fallback provider.

Provider tests (`desktop-provider.test.ts`): the fallback provider's layout and placements from a
stubbed `screen`; the macOS provider against a fake helper (a small node script speaking the same
protocol) for parsing, a shared-desktops layout, and every fail-safe case (binary missing,
handshake timeout, symbols unavailable, malformed line, request timeout, helper exit), each ending
on the fallback provider with one `desktop-provider fallback` line. These run on every platform;
the real helper runs only in the probe.

Executor tests (`window-kernel-executor.test.ts`): `sideTaskSetup()` cases for 5c/5d/5e assert the
backend calls in order (reopen with its desktop, close, and for 5e one raise); a `ShowDesktop`
reaches the backend before its raise.

`cmd-url-unfocused.spec.ts` (darwin-only) keeps its current assertions and gains a
`CurrentDesktopChanged` injection through the executor's test surface for 5d. It cannot see real
desktops.

Static: `node scripts/check-platform-leak.mjs` and `node scripts/check-r2-window-ops.mjs` (native
window calls stay in the backend; the provider files are backend files and are added to that
check's allowed set if it flags them).

## Live checks on macOS (a person does only the gestures)

Run from this worktree with `PROFILE=kernel-desktops PEEK_PROFILE=kernel-desktops
TMPDIR=<worktree>/.tmp`. The agent builds, starts the app, reads `main.log`, and asks the person
only for the gestures below; each is tied to what it verifies.

### The probe, after commit 4

Hooks, temporary, behind `PEEK_DESKTOP_PROBE=1`: on every switch and every screen change, log
`desktop-read` with the helper's full layout and the placement of every registered window; bind
Control+Option+Command+1 to the write test (below). The hooks do not change any behaviour.

Before asking for anything, the agent confirms in the log `desktop-provider started name=mac` and
a `hello` naming every private symbol as resolved; if the fallback line appears instead, the probe
stops there and the reason is the result.

Setup for the person: two desktops on the main screen, another app in front on each, the app
started on desktop 1. If a second screen is available, give it two desktops as well.

1. **On desktop 2, open a page from the palette.** Verifies the reads of a window: the page is
   reported on every desktop, its home is desktop 2's id, and the layout shows two desktops on the
   main screen with desktop 2 current.
2. **Press Control+Left, wait two seconds, then Control+Right.** Verifies the current-desktop read
   and, the point the first run failed on, stable ids: the reads go desktop 2 → desktop 1 →
   desktop 2, and desktop 2 has the same id both times.
3. **Say which desktop the page is on now** (switch to look, then come back to desktop 2).
   Verifies window naming: the helper's read for the page's window (after this build's reopen,
   the replacement) matches what the person saw, so the window number taken from Electron is the
   one the window server uses.
4. **Press Control+Option+Command+1, then switch to desktop 1 and say whether a small red square
   is there.** The hook shows, on desktop 2, a small opaque red test window and an invisible
   stand-in (zero opacity, click-through, as in "Side tasks"), logs both placements, then asks the
   helper to move the red window to desktop 1 and logs its placement again. Verifies the write
   (red square on desktop 1 and read as desktop 1 means a move from the helper works) and that the
   stand-in is read on desktop 2 before and after the switch.
5. **Still on desktop 1, open Mission Control, say whether desktop 2's thumbnail shows an empty
   window or frame, then close Mission Control.** Verifies that the stand-in leaves no visible
   trace. The agent reads the stand-in's placement once more afterwards.
6. **Only with a second screen: click the second screen's desktop background, press
   Control+Right, then Control+Left.** Verifies per-screen reads: only that screen's current
   desktop changes and its screen id is Electron's display id; if the layout reported desktops
   shared across screens, both screens change together instead.

The agent then closes the test windows and the app itself. Results go into **Result**. The probe
stops the track if gesture 2 shows ids that change on return, or if gestures 4–5 show the stand-in
off desktop 2 or visible in Mission Control. A failed write at gesture 4 is expected and changes
nothing.

### The rule check, after commit 7

1. Desktop 2, other app in front: palette → URL → type in the page → click the other app. The
   page stays on desktop 2 behind the other app; one `side-task-reopen`.
2. Same, but switch to desktop 1 instead of clicking. Desktop 1 shows no page; desktop 2 has it.
3. Same, but cmd+tab to Peek. The page is the front window with key.
4. After 2, on desktop 1, open the same URL from the palette: a new side task on desktop 1; the
   desktop-2 window is untouched and no desktop switch happens.
5. Open the switcher on desktop 1 and pick the desktop-2 page. The user is taken to desktop 2 and
   the page has key.
6. On desktop 2, close the page that has key while a page on desktop 1 was the one before it: no
   desktop switch; key goes to a window on desktop 2 or to nothing.

## Done when

The kernel, property, provider and executor tests pass, the `tracks.json` verify and the
platform-leak check are green, the probe answers are recorded in **Result**, the rule check
behaves as listed, and the full gate (`yarn test:desktop:electron`, only with an explicit OK)
shows no failure outside `apps/desktop/tests/gate-baseline.md`.

## Result

**First probe run, 2026-09-26, inferred ids (stopped after gesture 3 of that plan).**

- Order on macOS, for a switch away from a side task: `space-changed` arrives first, then
  `native-blur` and `os-focus-left-app` about 20ms later, then `OsFocusLost` and the reopen. The
  switch always preceded the blur.
- Inferred ids do not work: every switch minted a new id (two real desktops produced `desktop-2`
  through `desktop-15`), so returning to a desktop was never recognised and `onCurrentDesktop`
  could not be answered. Electron exposes no desktop identity on macOS. This revision follows
  from that.
- Behaviour matched `main` (page reopened on desktop 1), as expected, since nothing read desktops.

**Second probe, native helper:** (filled by the implementing track)
