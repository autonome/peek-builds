---
enabled: false
touches: [apps/desktop/main/window-kernel.ts, apps/desktop/main/window-kernel.test.ts, apps/desktop/main/window-kernel-properties.test.ts, apps/desktop/main/window-kernel-executor.ts, apps/desktop/main/window-kernel-executor.test.ts, apps/desktop/main/window-kernel-dispatch.ts, apps/desktop/main/window-backend.ts, apps/desktop/main/electron-window-backend.ts, apps/desktop/main/desktop-provider.ts, apps/desktop/main/desktop-provider-fallback.ts, apps/desktop/main/desktop-provider-mac.ts, apps/desktop/main/desktop-provider.test.ts, apps/desktop/native/desktop-helper/main.swift, apps/desktop/scripts/build-desktop-helper.mjs, apps/desktop/electron-builder.yml, apps/desktop/package.json, apps/desktop/main/ipc.ts, apps/desktop/main/main.ts, apps/desktop/main/tile-ipc.ts, apps/desktop/tests/desktop/cmd-url-unfocused.spec.ts, apps/desktop/main/izui-roles.ts, apps/desktop/main/izui-roles.test.ts, apps/desktop/main/window-escape.ts, apps/desktop/main/window-escape.test.ts, docs/design/window-rules.md, docs/design/kernel-desktops-implementation.md, specs/transient-page-ends-on-blur.md, specs/cmd-url-linux-failures.md, scripts/check-platform-leak.mjs]
depends-on: []
---

# Desktops are kernel state

The window kernel holds a model of screens and virtual desktops with real, stable ids, and decides
every desktop rule in `docs/design/window-rules.md` from that model rather than from the timing of
native calls. The model names no OS, no window backend and no Electron concept. Each window backend
fills it through a per-platform desktop provider; a fallback provider, available everywhere, makes
the app behave as if desktops did not exist. Everything platform-specific is a backend's
realization, never kernel reasoning.

Implementation notes and history: `docs/design/kernel-desktops-implementation.md`.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Scope and terms

In scope: which desktop each app window is on, which desktop the user is on, and every window
rule that depends on either, on every platform the desktop app runs on.

- **Screen**: a hardware display.
- **Desktop**: a virtual desktop (macOS Space, X11 workspace), belonging to one screen or shared
  across all screens. Each screen shows exactly one current desktop; with shared desktops all
  screens show the same one.
- **The desktop the user is on**: with several screens, the desktop currently shown on the screen
  in question.
- **Current desktop**: the desktop a screen currently shows (`ScreenState.current`). A window is
  **on a current desktop** when `onCurrentDesktop(state, record)` holds: its desktop is current on
  some screen, or it is on every desktop.
- **Open a URL**: the action of the window-open handler (`ipc.ts registerWindowHandlers`
  `windowOpenHandler`, reached from tiles through `tile:window:open`). For a web URL its result is
  a **page-host window**: a window the kernel records with `kind: 'page-host'`
  (`window-kernel.ts WindowKind`), which the handler builds when `usePageHost` holds. **The page**
  is the web content in that window.
- **Transient window**: a window that is closed or hidden when it loses focus. There are two
  kinds, defined next: `TRANSIENT_ROLES` windows and transient page-host windows; nothing replaces
  either kind. `TRANSIENT_ROLES` names only the first kind; where a rule means only that kind it
  says "`TRANSIENT_ROLES` window", never "transient window".
- **`TRANSIENT_ROLES` window**: a window whose `role` is in `window-kernel.ts TRANSIENT_ROLES`:
  `palette` (the command palette), `quick-view`, `overlay` (page chrome) and `switcher` (the window
  switcher). It is transient by role: losing focus closes or hides it.
- **Transient page-host window**: a page-host window with a content role
  (`window-kernel.ts CONTENT_ROLES`) opened over another app with the window-open options
  `type: 'panel'` and `activation: 'user'`. The window-open handler sets both when
  `izui-roles.ts pageOpensTransient()` holds: the URL is opened (in practice from the palette)
  while another app is in front and a Peek window holds key
  (`window-machine.ts isKeyHeldWhileAppInactive()`), the caller passed no `type`, and `show` is not
  `false` (`window-rules.md` G1, G13). The kernel records `type: 'panel'` as
  `WindowRecord.nonActivating`. A transient page-host window floats over the other app and holds
  key without bringing Peek forward; while it does, `window-kernel.ts isTransientPageHost()` holds
  for it. Every way it stops holding key while still on screen closes it (`DismissWindow`): the
  user clicking another app, switching desktop, or bringing Peek forward — the page was asked for
  while Peek was not focused, so the task ends when that moment ends, and the page stays reachable
  from history. Closing it directly (Escape, a close request) emits nothing more.
- **`onEveryDesktop` window**: a window for which `isOnEveryDesktop(record)` holds: the platform
  keeps it on every desktop regardless of placement (for example a macOS panel). The app counts it
  as belonging to the desktop it was first shown on.
- **Key window**: the window `State.key` names, the one with keyboard focus; "has key" means has
  keyboard focus.
- **User intent**: a focus or raise carrying `intent: 'user'` (`FocusRaiseRequested`,
  `RaiseWindow`; on open, `activation: 'user'`): the user asked for it by naming one specific
  window, for example by picking it in the switcher. Anything else is machine-caused.

## 2. User stories

- As a user on desktop 2 with another app in front, when I open a URL from the palette and then
  click that app, then the page-host window stays on desktop 2 behind it.
- As a user, when I open a URL from the palette over another app on desktop 2 and then switch to
  desktop 1, then desktop 1 shows what it showed before, and the page-host window is on desktop 2
  when I return.
- As a user, when I open a URL from the palette over another app and then bring Peek forward,
  then that page-host window closes, the same as if I had clicked another app or switched desktop;
  the page stays reachable from history.
- As a user on desktop 1, when I open a URL that is already open on desktop 2, then a new
  page-host window opens on desktop 1 and I stay on desktop 1.
- As a user, when I pick a window from another desktop in the switcher, then I am taken to that
  desktop and the window has keyboard focus.
- As a user, when I close or hide a window, then I stay on the desktop I am on.
- As a user on a platform where desktops cannot be read, when I use Peek, then it works as it does
  on a single desktop.

## 3. Rules

1. **A window stays on the desktop it was put on.** Nothing the app does on its own MUST move a
   window to another desktop or switch the user's desktop; only the user does, by switching desktop
   or asking for one specific window. Exception: `TRANSIENT_ROLES` windows MUST appear on the
   desktop the user is on.

   **The switcher** MUST list the app's windows from every desktop. Picking one MUST take the user
   to that window's desktop. This is the one way to go to another desktop's window: a pick names
   a window the user already knows is open there, whereas every other request asks for something
   to happen, and new things happen where the user is (rule 5).
2. **A transient page-host window ends where it was opened.** Clicking the other app
   (`window-rules.md` 5c), switching desktop (5d), or bringing Peek forward while it holds key (5e)
   MUST close it; nothing replaces it, and the page stays reachable from history.
3. **Opening from the palette over another app is a transient task.** The user asked for the page
   while Peek was not focused, so the task ends the moment that focus state ends — whether by
   leaving it (another app, another desktop) or by bringing Peek forward while the page still holds
   key. Reason for closing rather than keeping it: on macOS the transient page-host window is an
   Electron panel, which is on every desktop whatever is asked, and a window created after a switch
   lands on the desktop the user switched to, so the panel could not stay on the desktop the page
   was opened on (implementation doc, "Research: Electron panels and desktops"). While the switch
   gesture is in progress the panel is visible on both desktops; this is accepted. A switch on a
   different screen from the transient page-host window's changes nothing.
4. **Closing or hiding a window never switches desktop.** Key goes to the prior window if it is on
   a current desktop, else the frontmost page-host window on a current desktop, else nothing
   (rule 9).
5. **New things happen where the user is.** A request that would reuse an open window — a URL
   already open, a window opened by key (settings, groups, tags and other one-per-app windows), an
   extension page — reuses it only if it is hidden or on a current desktop. Otherwise:
   - a page-host window for a URL: a new page-host window opens on the desktop the user is on, and
     the one on the other desktop stays;
   - a window opened by key, of which only one may exist: the one on the other desktop closes and
     a new one opens on the desktop the user is on.

   Opening a URL from the palette over another app MUST always open a new transient page-host
   window; it MUST NOT reuse an existing page-host window. A request aimed at "the window the user
   is looking at" (a command, Cmd+W, devtools, a dialog's parent) MUST resolve to a window on a
   current desktop, or to none. Reason: switching desktop is deliberate, so actions happen there.
   A later palette affordance may offer "switch to" beside "open here"; until then only the
   switcher goes elsewhere (rule 1).
6. **The rules hold on every platform with desktops.** With a provider that reads real desktops,
   rules 1–5 hold as written. With only the fallback provider the app sees one desktop per screen
   and behaves as a desktop-unaware app; the OS may then take the user to another desktop (see
   section 6).
7. **Relation to `window-rules.md`.** Rules 2 and 3 are realized there as G13 and rows 5c–5e, and
   supersede `transient-page-ends-on-blur.md`, which replaced the page on a click-away. The
   implementation MUST NOT satisfy rule 2 by letting the page-host window follow the user to
   another desktop.
8. **F9 stay-on-this-desktop** (new rule under Focus in `window-rules.md`):

   > A focus the manager makes without user intent lands only on a window on a current desktop
   > (its desktop is currently shown on some screen, or it is on every desktop). A focus with user
   > intent may take the user to another desktop, because the user named that window; picking a
   > window in the switcher is such a focus.
9. **F7 hide-returns-key** (replaces F7 in `window-rules.md`):

   > When the key window hides or closes while the app is active, key goes to its prior window if
   > that window is visible and on a current desktop; otherwise to the topmost visible application
   > window on a current desktop; otherwise the manager focuses nothing, and whatever the OS focuses
   > next arrives world-caused.

   The kernel MUST choose a successor for closes of application windows as well as of
   `TRANSIENT_ROLES` windows.

## 4. Model

### Ids

`ScreenId` and `DesktopId` are opaque strings chosen below the backend port and compared only; the
kernel gives them no meaning (not a display id, not an OS number). They MUST be stable for the
session while the thing exists; returning to a desktop MUST yield its previous id. Stability across
app restarts is not required.

### Kernel state

- `State.screens: readonly ScreenState[]`, `ScreenState = { id: ScreenId; current: DesktopId }`.
- `State.desktops: readonly DesktopState[]`, `DesktopState = { id: DesktopId; screen: ScreenId |
  null }` (`null` = shared).
- `WindowRecord.screen?: ScreenId` — last reported screen.
- `WindowRecord.desktop?: DesktopId` — last reported desktop. For an `onEveryDesktop` window, the
  desktop it was first shown on (for a transient page-host window, the desktop it was opened on). Absent until
  first shown or reported.
- `WindowRecord.onEveryDesktop?: boolean` — the backend's declaration at registration, or set by a
  placement report. The kernel MUST read it only as that declaration and MUST NOT derive it from
  role or platform. `desktopMembership: 'follow'` is not copied into it; `isOnEveryDesktop(record)`
  reads both.

Initial state: no screens, no desktops.

### Predicates

- `isCurrentDesktop(state, desktop): boolean` — some screen shows it; true when `state.screens` is
  empty.
- `onCurrentDesktop(state, record): boolean` — `isOnEveryDesktop(record)`, or `record.desktop` is
  current. False both for a window on a desktop no screen shows and for a window never shown,
  except that it is true for every window before the first layout report.
- `admitsReuse(state, record): boolean` — the record may serve a request that would reuse it:
  visible and on a current desktop, or hidden. A hidden window is re-shown on the current desktop
  of its screen; if the OS shows it elsewhere, the following placement report corrects the kernel.
- `admitsFocus(state, record, { user, named }): boolean` — the one admission rule for bringing a
  window forward. Always: visible (or being shown in the same transition) and not being hidden or
  dismissed. Then two independent conditions:
  - the app is active, or the request carries user intent (`user`: the user acted, for example
    the palette opening over another app);
  - the window is on a current desktop, or the user named this window (`named`: a switcher pick,
    which implies `user`).

  Every raise, focus assert, content focus,
  successor, parent refocus and latch spend in `react`, and every op-token stamp in `evolve`,
  MUST ask this predicate and no other; a key move reported by the OS (`OsFocusGained`) is not a
  request and is not gated.

### Queries (the only way code outside the kernel chooses a window)

Code outside the kernel MUST NOT choose among windows itself. A caller supplies candidates it
found by its own criterion (URL, key, extension page), and the kernel answers:

- `reusableHere(state, candidates): WindowId | null` — the first candidate for which
  `admitsReuse` holds. `null` means open a new window here; for a one-per-app window, the caller
  also closes the candidates.
- `frontWindowHere(state, filter?): WindowId | null` — the key window if it passes `filter` and is
  on a current desktop, else the topmost visible window passing `filter` on a current desktop.
  Replaces every "topmost content window" and "focused window" fallback outside the kernel.

A request from a tile to show or focus a window by id carries `named`; it is false unless the
request is a switcher pick.

### Events (facts, never rejected)

- `DesktopLayoutReported { screens: ScreenState[]; desktops: DesktopState[] }` — the full layout;
  sent at start, on screen add/remove/rearrange, and when the provider sees desktops added or
  removed. Replaces `State.screens` and `State.desktops`. A window whose `desktop` no longer exists
  keeps the stale id (not on a current desktop) until its next placement report.
- `CurrentDesktopChanged { screen: ScreenId; desktop: DesktopId }` — sets that screen's `current`;
  adds an unknown screen. With shared desktops, one per screen. MUST NOT write `key` (F1: only
  `OsFocusGained` / `OsFocusLost` do).
- `DesktopSwitchObserved {}` — the platform reported a desktop switch, sent the moment it does and
  before the provider is read. Carries no ids; it only ends a transient page-host window (section 4
  "Kernel behaviour"). A backend with no switch notification never sends it.
- `WindowPlacementReported { id: WindowId; screen: ScreenId | null; desktop: DesktopId | null;
  onEveryDesktop: boolean }` — a registered window's placement. `null` leaves the field unchanged.
  For an `onEveryDesktop` window that already has a desktop, `desktop` is ignored.

Writing `WindowRecord.desktop`:

| Source | Effect |
|---|---|
| Placement report | Authoritative, as above. |
| `WindowShown` flipping `visible` to true | Provisional stamp: current desktop of the window's screen (first screen if unknown). Skipped if the record has a desktop and is on every desktop. |
| Registration with `replaces: X` | Takes X's `desktop` and `screen`; its first show does not re-stamp. |
| `OsFocusGained` | Never stamps. |

With the fallback provider the show stamp is the only source and is correct by construction.

### Effects

- `ShowDesktop { desktop: DesktopId }` — make `desktop` current on its screen. Emitted only
  immediately before a user-intent `RaiseWindow` of a window not on a current desktop. A backend
  that cannot switch desktops ignores it.

### Kernel behaviour

- **Ending a transient page-host window.** `react` diffs `isTransientPageHost` per visible record.
  Whenever it stops holding — the app inactive (5c, 5d: focus lost to another app or to a desktop
  switch) or the app coming forward while it holds key (5e) — `react` emits one `DismissWindow`. A
  `DesktopSwitchObserved` marks a transient page-host window for dismissal at once, because on
  macOS a switch can be followed by an app activation while the page still holds key, and marking
  here keeps the close on the switch rather than racing an activation that ends the window the same
  way. It needs no desktop ids, so it cannot wait for the provider's read.
- **Successor on hide or close.** `successorOnHide()` applies `onCurrentDesktop` to both its
  branches (prior window; topmost application window).
- **Raise gate.** `react` MUST NOT emit a `RaiseWindow` without user intent for a record that is
  not on a current desktop, and MUST NOT emit what the executor would suppress (app inactive, no
  user intent). The gate lives in `react`, not the executor; `planRaise` keeps only environment concerns (headless,
  non-activating realization).
- **Switcher selection.** The raise spent from `pendingSelectionFocus` in the `WindowClosed` arm
  carries user intent.
- **Taking the user to a window's desktop.** For a user-intent raise of a window not on a current
  desktop, `react` emits `ShowDesktop { desktop: record.desktop }` immediately before
  `RaiseWindow`. The resulting switch arrives as an ordinary `CurrentDesktopChanged`.
- **Reuse.** Every reuse path (URL, key, extension page, workspace restore) goes through
  `reusableHere`. The `pageOpensTransient()` check runs before reuse: an open that makes a
  transient page-host window never reuses.
- **One place records a desktop on show.** Every write that flips `visible` to true (`WindowShown`,
  the re-show on app activation, the overlay reveal) stamps the desktop through one helper.
- **Page chrome.** The overlay attaches only to a page-host window on a current desktop.

### Enforcement

- A static check next to `scripts/check-r2-window-ops.mjs` fails on any window lookup outside the
  kernel that does not end in `reusableHere` or `frontWindowHere` (the registry finders and
  `topmost` are the listed names).
- A kernel property test folds random event sequences over several desktops and asserts: no
  `RaiseWindow`, `FocusContent` or reuse targets a window off every current desktop unless the
  request was `named`; every op-token stamp in `evolve` has a matching effect in `react`.

### Platform neutrality

`scripts/check-platform-leak.mjs` enforces the kernel's neutrality. The kernel names ("screen",
"desktop", `ScreenId`, `DesktopId`, the four events, the two effects, `onEveryDesktop`) are not in
`FORBIDDEN`. `SCANNED` includes `desktop-provider.ts` and `desktop-provider-fallback.ts`;
`FORBIDDEN` includes `getMediaSourceId`, `getNativeWindowHandle`, `getAllDisplays`,
`getDisplayMatching`. Exempt, as the places platform detail belongs: `electron-window-backend.ts`,
`desktop-provider-mac.ts`, an X11 provider, and the helper (Swift, not scanned).

## 5. Backend contract

### What a backend supplies

For desktops to work under any window backend, the backend MUST supply:

- **Screens**: the screen list and its changes, an opaque `ScreenId` per screen, each window's
  screen, and the mapping from the provider's display ids to `ScreenId`.
- **A platform window id per registered window**, derived by the backend for its own windows.
- **The `onEveryDesktop` declaration** at registration for windows the platform keeps on every
  desktop regardless.
- **A provider**: the platform's (a Node client such as `desktop-provider-mac.ts`, or the helper
  spawned directly), else the fallback; plus any switch trigger the backend has.
- **Realizations** of `ShowDesktop` for its provider's capabilities (section 6).

### Desktop provider interface

`apps/desktop/main/desktop-provider.ts`: backend-neutral, naming no Electron type. Each backend
owns one provider; the kernel never sees it.

```ts
type PlatformWindowId = number;  // macOS window server number; X11 window id
interface DesktopProvider {
  readonly name: string;                       // for logs
  readonly canPlaceWindows: boolean;
  readonly canShowDesktops: boolean;
  start(onChange: (change: DesktopChange) => void): Promise<void>;
  layout(): Promise<ProviderLayout>;
  placements(windows: PlatformWindowId[]): Promise<Placement[]>;
  placeWindow(win: PlatformWindowId, desktop: DesktopId): Promise<boolean>;
  showDesktop(desktop: DesktopId): Promise<boolean>;
  stop(): void;
}
```

`ProviderLayout` is `ScreenState[]` / `DesktopState[]` with screens named by the platform's display
id, `ProviderDisplayId`, a non-empty string (macOS `CGDirectDisplayID` in decimal); the backend
maps those to its `ScreenId`s. `display: null` on a screen or desktop means shared across every
screen (X11 always). `DesktopChange` is `layout-changed`, `current-desktop-changed { display }`, or
`failed { reason }`. `failed` is how a platform provider reports it can no longer answer (for a
helper, it exited); only the fail-safe wrapper sees it, and it MUST NOT reach the backend. A
provider lacking a capability sets the flag false and returns `false` from the call.

### Backend algorithm

- At start, on every `DesktopChange` and on each of the backend's own triggers (screen changes, an
  OS switch notification): `layout()` → `DesktopLayoutReported` if changed; one
  `CurrentDesktopChanged` per screen whose current desktop differs; `placements()` for all
  registered windows → one `WindowPlacementReported` per changed placement.
- After each genuine show and each registration: `placements()` for that window.
- `ShowDesktop`: section 6.

### Fail-safe

The backend starts the platform provider and MUST switch to the fallback provider, logging
`desktop-provider fallback reason=<…>` once, when any of these holds: no provider for the platform;
helper binary absent or fails to start; start handshake unanswered within 1s; private calls
reported unavailable; any later request times out (250ms), returns malformed data, or the helper
exits. After switching, the backend sends a fresh `DesktopLayoutReported` and placements from the
fallback provider, and the app behaves as with the fallback provider for the rest of the session.
No retry.

Malformed data is any of:

- a layout that is not `{ screens, desktops }` arrays of the documented shapes (ids non-empty
  strings, `display` a non-empty string or `null`), or whose screen shows a desktop the layout
  does not list;
- placements that do not answer exactly the windows asked, each once, or whose entry has a
  non-number `window`, a `desktop` other than a non-empty string or `null`, or a non-boolean
  `onEveryDesktop`;
- a non-boolean answer to a write;
- from a helper, a line that is not JSON or answers no pending request.

The wrapper validates every answer; providers pass them through. The failing request is answered
from the fallback provider, then the backend is told `layout-changed` so it re-reads everything.

Log lines, each `[wm] t=<ms since epoch> <line>`: a good start logs `desktop-provider started
name=<provider name>`; the switch logs `desktop-provider fallback reason=<reason>` once per session,
whitespace in `<reason>` replaced by `_`. Reasons: `no-provider`, `handshake-timeout`,
`start-failed:<cause>` (for example `helper-missing`, `symbols-unavailable:<names>`,
`helper-exit_code=<n>`), `request-timeout:<op>`, `request-failed:<op>:<cause>`, `malformed:<op>`,
and a `failed` change's own reason (`helper-exit_code=<n>`, `malformed-line`).

### Fallback provider (all platforms)

`desktop-provider-fallback.ts`. The backend feeds it a screen source, read on every request:
`screens()` (its `ScreenId`s, so the fallback's display ids are the backend's screen ids),
`windowScreen(win)` and `onEveryDesktop(win)`, because a placement request names windows only by
platform window id. One desktop per screen, id `<screenId>/only`, always current. A window's
placement is its screen's only desktop; a window of unknown or vanished screen counts as on the
first screen; with no screens, `display` and `desktop` are `null`. `onEveryDesktop` is the
backend's declaration. Both capability flags false. Never sends
`CurrentDesktopChanged`, so every window is always on a current desktop and every rule acts as if
desktops did not exist.

### Helper protocol

A platform helper is a separate process speaking one JSON object per line on stdin/stdout.
Requests: `hello` (helper version and which private symbols resolved), `layout`,
`placements { windows: number[] }`, `place { window, desktop }` (diagnostics only). Every private
symbol is resolved via `dlsym` at start; a missing symbol is reported "unavailable" in `hello`,
never a launch failure. Any backend can spawn the helper and speak the protocol (for example a
Tauri backend from Rust); `desktop-provider-mac.ts` is its Node client.

A helper process is used rather than a Node addon: a crash in a private call closes a pipe (→
fail-safe) instead of killing the main process; there is no rebuild against Electron's Node ABI;
the repo already builds Swift helpers (`apps/desktop/tests/helpers/cg-windows.swift`,
`tools/focus-probes/frontmost-stream.swift`) and no addon; and the protocol is backend-neutral.
Cost: requests are asynchronous, and any window write comes from another process's connection.

## 6. Platform realizations

### Electron backend

- Screens: `screen.getAllDisplays()`; `display-added` / `display-removed` /
  `display-metrics-changed` are triggers. `ScreenId` is Electron's display id as a string; on macOS
  the helper's `CGDirectDisplayID` maps to it.
- A window's screen: `screen.getDisplayMatching(bounds)`.
- Platform window id: macOS, from `getMediaSourceId()` (`window:<n>:0`, `<n>` taken as the window
  server number); X11, `getNativeWindowHandle()`.
- `onEveryDesktop` declaration: panels on macOS and `setVisibleOnAllWorkspaces` windows; the provider
  reports only where the platform disagrees. Exception: a transient page-host window.
- A transient page-host window is a `type: 'panel'` window, on every desktop whatever is asked
  (Electron's panel re-adds join-all-Spaces), declared `onEveryDesktop`. Rule 2 closes it when a
  switch takes its focus.
- `TRANSIENT_ROLES` windows appear on the desktop the user is on through `setVisibleOnAllWorkspaces`
  (desktop membership `follow`). This includes the shared page chrome window (role `overlay`), which
  is registered outside the generic window-open handler and so sets its membership itself
  (`hybrid-overlay.ts ensureOverlay()`); left on one desktop, showing it over a page-host window on
  another desktop makes macOS switch back to the overlay's desktop.
- macOS switch trigger:
  `systemPreferences.subscribeWorkspaceNotification('NSWorkspaceActiveSpaceDidChangeNotification')`;
  the provider supplies which desktop is now current.

### macOS: native helper, reads

`desktop-provider-mac.ts` plus a Swift CLI helper, `apps/desktop/native/desktop-helper/main.swift`.

Build and packaging:

- `apps/desktop/scripts/build-desktop-helper.mjs`, run by the desktop `build` script on darwin
  (no-op elsewhere): `swiftc -O`, arm64 (the only packaged mac arch in `electron-builder.yml`), to
  `apps/desktop/dist/native/peek-desktop-helper`.
- `electron-builder.yml extraResources` → `Contents/Resources/peek-desktop-helper`. Located at
  `process.resourcesPath` when packaged, `dist/native` from source.
- Without Xcode command-line tools the script warns and builds nothing; the app runs on the
  fallback provider.
- The app is unsigned (`identity: null`); if signing is enabled, the helper MUST be signed too.

Reads (window server private calls, as used by yabai, Hammerspoon `hs.spaces`, AltTab):

- Connection: `CGSMainConnectionID()` (also `SLSMainConnectionID`).
- Layout: `CGSCopyManagedDisplaySpaces(cid)` → per display: `Display Identifier` (display UUID, or
  `Main` when displays share desktops), `Current Space`, `Spaces`; each desktop has numeric
  `ManagedSpaceID` / `id64`, `uuid`, `type` (0 ordinary, 4 fullscreen app). Display UUID →
  `CGDirectDisplayID` via public `CGGetActiveDisplayList` + `CGDisplayCreateUUIDFromDisplayID`.
- Shared desktops: a single `Main` entry with several active displays ("Displays have separate
  Spaces" off) → desktops reported with `screen: null`.
- A window's desktops: `CGSCopySpacesForWindows(cid, 0x7, [windowNumber])`; more than one id =
  every desktop.
- `DesktopId` = the numeric id as a string.
- Fullscreen desktops are ordinary desktops (a native-fullscreen page lives on its own).

Naming a window: its window server number, supplied by the backend. For a backend that cannot
derive it, the helper matches the app's windows by owner pid and bounds via public
`CGWindowListCopyWindowInfo`, as `cg-windows.swift` does.

### macOS: no writes

`CGSMoveWindowsToManagedSpace` (and older `CGSAddWindowsToSpaces` / `CGSRemoveWindowsFromSpaces`)
and `CGSManagedDisplaySetCurrentSpace` are reported (yabai, Hammerspoon) to need the Dock scripting
addition, hence SIP partly disabled, since macOS 14.5 — not something the app can ask of users. The
macOS provider therefore sets both capability flags false. Rule 2 needs no write: a transient
page-host window only ever closes, never moves to another desktop.

Realizing `ShowDesktop` on macOS: a no-op; raising the window makes the OS switch.

### Linux X11

- Reads (EWMH): root `_NET_NUMBER_OF_DESKTOPS`, `_NET_CURRENT_DESKTOP`, `_NET_DESKTOP_NAMES`;
  per-window `_NET_WM_DESKTOP` (`0xFFFFFFFF` = every desktop). Desktops span all monitors →
  reported shared (`screen: null`).
- Writes: a `_NET_WM_DESKTOP` client message moves a window; a `_NET_CURRENT_DESKTOP` client
  message switches desktop. Both capability flags true.
- Windows named by X window id.
- Packaging: a helper process like macOS, built against libX11; root property changes are the
  `DesktopChange`.
- `ShowDesktop` (`canShowDesktops`): the backend switches desktop, then raises.
- Conformance can be checked under a virtual X server whose window manager implements EWMH
  desktops.

### Wayland and fallback

No standard protocol exposes current or per-window workspace to an ordinary app
(`ext-workspace-v1` is for shells and task bars; support varies). Wayland uses the fallback
provider. Under XWayland the X11 provider may start and MUST pass its handshake. With the fallback
provider `ShowDesktop` is never emitted.

### Platform table

| Fact | macOS | Linux X11 | Wayland / fallback |
|---|---|---|---|
| Screens | backend (Electron: `screen`) | backend | backend |
| Desktops, and current per screen | helper, private reads | EWMH root properties (shared) | one per screen |
| A switch happened | backend trigger (Electron: workspace notification) | root property change | never |
| A window's desktop | helper, private read | `_NET_WM_DESKTOP` | its screen's only desktop |
| `onEveryDesktop` | backend's own declaration, confirmed by the read | `_NET_WM_DESKTOP` | backend's declaration |
| Put a window on a desktop | no (needs SIP changes, reported) | yes, client message | no |
| Switch to a desktop | no; raising a window there makes the OS switch | yes, client message | no |

## 7. Conformance

### 7.1 Automated tests

Kernel unit tests (`window-kernel.test.ts`), one group per rule:

- **Desktop state.** `DesktopLayoutReported` replaces screens and desktops; `CurrentDesktopChanged`
  writes one screen's current desktop, leaves `key` alone, adds an unknown screen;
  `WindowPlacementReported` writes screen and desktop, leaves a field alone on `null`, keeps an
  `onEveryDesktop` window's first-shown desktop; a first show stamps provisionally from the
  window's screen; focus does not stamp; before any report every window is on a current desktop;
  `onCurrentDesktop` over {every desktop,
  current on its screen, current on another screen, not current, never shown}; shared desktops
  (`screen: null`) current on every screen.
- **5c / 5d.** Transient page-host window, `OsFocusLost` (or key moving to another Peek window),
  app inactive: one `DismissWindow`, no `RaiseWindow`; `appActive` still false. A second
  `OsFocusLost` emits nothing.
- **5e.** Transient page-host window is key, `AppActivated`: one `DismissWindow`, same as 5c/5d.
- **G13.** Escape or close request on a transient page-host window: no further `DismissWindow`.
- **F7 / F9.** Prior window on a current desktop: raised. Prior not on a current desktop: topmost
  application window on a current desktop raised. None on a current desktop: no raise, no token.
  User-intent raise of a window not on a current desktop: emitted, preceded by `ShowDesktop` with
  its desktop; same for a switcher selection. Machine raise of a window not on a current desktop:
  not emitted.
- **URL reuse.** `admitsReuse` table; an open that makes a transient page-host window never
  reuses.

Property test (`window-kernel-properties.test.ts`): over random event sequences whose desktop
events are only what the fallback provider sends (one layout, placements on each screen's only
desktop, no `CurrentDesktopChanged`), every effect list MUST equal the one with desktops ignored.

Provider tests (`desktop-provider.test.ts`, every platform): fallback layout and placements from a
stubbed backend screen list; the macOS provider against a fake helper (a Node script speaking the
protocol) for parsing, a shared-desktops layout, and each fail-safe case (binary missing, handshake
timeout, symbols unavailable, malformed line, request timeout, helper exit), each ending on the
fallback provider with one `desktop-provider fallback` line. The real helper runs only in the live
acceptance check (7.2).

Executor tests (`window-kernel-executor.test.ts`): a `DismissWindow` effect — the one `react`
emits for 5c/5d/5e alike — realizes as one `closeOrHide` call, no raise; `ShowDesktop` reaches the
backend before its raise.

`cmd-url-unfocused.spec.ts` (darwin-only): a blur of the transient page-host window closes it;
`AppActivated` while it holds key closes it the same way. It cannot see real desktops.

Static: `node scripts/check-platform-leak.mjs`; `node scripts/check-r2-window-ops.mjs` (native
window calls stay in the backend; provider files are backend files, added to its allowed set if
flagged).

### 7.2 Live acceptance: macOS provider

A person performs only the gestures; the app is built and started in an isolated profile, and
`main.log` is read to verify each step. A diagnostic mode (`PEEK_DESKTOP_PROBE=1`, no behaviour
change) logs `desktop-read` with the helper's full layout and every registered window's placement,
read from the provider directly, on every switch and screen change.

Precondition, checked in the log: `desktop-provider started name=mac` and a `hello` with every
private symbol resolved. If the fallback line appears instead, the check stops and the logged
reason is its outcome.

Setup: two desktops on the primary screen, another app in front on each, the app started on
desktop 1. With a second screen, two desktops there too.

| # | Gesture | Passes when |
|---|---|---|
| 1 | On desktop 2, open a URL from the palette. | The transient page-host window is read as on every desktop; the layout shows two desktops on the primary screen, desktop 2 current. |
| 2 | Control+Left, wait two seconds, Control+Right. | Current-desktop reads go 2 → 1 → 2; desktop 2 has the same id both times. |
| 3 | Say which desktop the page-host window is on now (switch to look, come back to desktop 2). | The helper's read for the page-host window matches: the backend-derived window number is the window server's. |
| 4 | Second screen only: click its desktop background, Control+Right, Control+Left. | Only that screen's current desktop changes, and the helper's display id maps to an Electron display; with shared desktops, both screens change together. |

Afterwards the app is closed. The macOS provider does not conform if step 2 shows ids changing
on return.

### 7.3 Live acceptance: rules on macOS

1. Desktop 2, other app in front: open a URL from the palette → type in the page → click the other
   app. The page closes; the other app keeps focus.
2. Same, but switch to desktop 1 instead of clicking. The page may show on both desktops during
   the switch gesture; once it ends, desktop 1 shows no page-host window, and back on desktop 2 the
   page is gone.
3. Same, but cmd+tab to Peek. The page closes the same way — Peek comes forward with no page-host
   window of its own to show.
4. After 2, on desktop 1, open the same URL from the palette: a new transient page-host window on
   desktop 1; the
   desktop-2 page-host window untouched; no desktop switch.
5. Switcher on desktop 1, pick the desktop-2 page-host window: the user is taken to desktop 2, the
   page-host window has key.
6. On desktop 2, close the key page-host window whose prior window is on desktop 1: no desktop
   switch; key goes to a window on desktop 2 or to nothing.

### 7.4 Conforming implementation

Kernel, property, provider and executor tests pass; the static checks are green; the macOS
provider passes 7.2; the rules behave as in 7.3; the full desktop test suite shows no failure
outside `apps/desktop/tests/gate-baseline.md`.

## 8. Assumptions (unverified)

- macOS private reads work on the macOS version in use.
- macOS reads need no Accessibility or Screen Recording permission and no SIP change.
- A helper round trip is a few milliseconds.
- electron-builder signs `extraResources` executables on its own.
- A macOS `DesktopId` is stable for the login session.
- `getMediaSourceId()`'s middle number is the window server window number.
- Electron's display id equals `CGDirectDisplayID` on macOS.
- macOS writes need SIP changes since 14.5 (reported by yabai / Hammerspoon).
- Raising a window on another desktop makes macOS switch, for every backend raise path and with
  "When switching to an application, switch to a Space with open windows" off.
- `getNativeWindowHandle()` gives the X window id under XWayland.
- Which X11 window managers honour EWMH client messages.
- Wayland: every compositor; whether Electron runs natively or under XWayland; whether X11
  properties are populated under XWayland.
- Windows opened with `type: 'panel'` on Linux are non-activating (Electron documents `'panel'`
  for macOS only).
- A desktop switch away from a transient page-host window on macOS always takes its focus, so
  rule 2's close follows every switch (seen on every switch in three probes).

## 9. Open questions

- A "go to the open window / open one on this desktop" cue could revisit rule 5.
