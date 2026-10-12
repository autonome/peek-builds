# Window rules

The rules the window manager is checked against. One rule per line, each named so a test or a
log record can cite it, each checkable by hand on a packaged build of any platform. Nothing else
decides window lifecycle, focus, visibility, stacking or dismissal. Where the kernel disagrees
with a rule here, the kernel is wrong.

Every rule speaks only of windows and their declared attributes (`window-kernel.ts
WindowRecord`), of inputs through the window API (`window-kernel.ts Command`, and the Escape press
as `window-escape.ts interpretEscape` receives it) and of the ambient environment (`Event`: the app
activated or deactivated, OS focus gained or lost, first frame painted, display changed). No rule
names a feature, a key chord or an OS gesture; those appear only in the failure table at the end,
as the concrete instance that exposed a rule. Every word a rule leans on is defined below.

## Vocabulary

Each term is followed by the name the code uses for it.

- **Key** — the one window the OS reports as receiving keystrokes (`State.key`).
- **Show** — put a hidden window on screen. Says nothing about key (`ShowWindow`).
- **Focus** — bring a window to the front and make it key. Focusing the window that already has focus only brings it to the front (`RaiseWindow`).
- **World-caused** — a focus change the user or the OS made (`FocusCause` kind `world`).
- **Machine-caused** — a focus change the manager made by following a rule (`FocusCause` kind `machine`).
- **User intent** — a machine-caused focus that answers a direct user request rather than a rule's own follow-through (`intent: 'user'`).
- **Asked-for focus** — the focus the manager itself requested, as opposed to the OS report that later confirms it (`opSeq` on the command and on the report's cause).
- **Late report** — an OS report about a show or focus the manager already handled, arriving after something newer happened (`isStaleSelfEcho`, `isStaleWindowEcho`).
- **Painted** — the window's first frame has composited, so the native window can be stacked (`orderable`).
- **Transient** — a window that ends when the user leaves it: it loses key, the app resigns, or the user switches desktop (`WindowRecord.transient`). Decided once at open from the window-open options and the app's focus, never from role or feature: a window opened with `modal: true`, or with `overlay: true` and accepting input, is transient; while another app is focused, a window a Peek window opens to show is transient too (`specs/kernel-desktops.md`, "Transient window"). A transient window never follows the user to another desktop.
- **Application window** — a window the user works in (today one of the roles in `CONTENT_ROLES`). A window may be neither transient nor an application window.
- **Panel** — a window declared to never activate the app: it shows, and takes keystrokes, while the app stays in the background (`WindowRecord.nonActivating`). On macOS it is an ordinary window flagged non-activating (`nonactivating-window.ts`), which stays on the desktop it was shown on; a `type: 'panel'` window, which Electron puts on every desktop, only where the flag is unavailable.
- **Pinned** — kept above the normal stack of windows (`layer` above `BASE_LAYER`, from `alwaysOnTop`).
- **Held above other apps** — an unpinned window kept, for now, above other apps' windows without the app activating and without the window taking key; its declared layer is unchanged and it is the same window throughout (`heldAboveOtherApps`, `admitsHoldAboveOtherApps`).
- **Prior window** — the window that had focus when this one took it (`priorKey`).
- **Opener** — the window that opened this one (`parentId`).
- **Attached overlay** — a window bound to a host and shown, hidden and moved with it (`overlayFor`). Its **host** is the application window it is bound to.
- **Click-through** — accepts no input (`acceptsInput: false`).
- **Escape pass-through** — Escape is declared to reach the window's own content instead of the manager (`escapeMode: 'ignore'`).
- **Escape-closable** — Escape is declared to close the window (today one of the roles in `ESC_CLOSE_ROLES`).
- **Escape fallback window** — the one window Escape opens when it has nothing to close (today `SWITCHER_ROLES`).
- **keepLive** — the window hides instead of closing (`keepLive`).
- **Close request** — the user closing a window through its own close control, menu item or shortcut (`CloseOrHideWindow`).
- **Dismissal** — a rule or an Escape press takes a window off screen for good: it is closed, or hidden if it is keepLive. A dismissed window never comes back on its own (`DismissWindow`).
- **App activates / app deactivates** — the app becomes, or stops being, the frontmost app (`AppActivated`, `AppResigned`).
- **Hidden with the app** — hidden because the app deactivated, so nothing floats over the other app; shown again when the app activates. Not a dismissal (`hiddenByAppBlur`).
- **Pending hidden** — chosen for dismissal, and the OS has not yet confirmed the hide (`pendingHidden`).
- **Default session** — the first window opened while the app was inactive and none has opened while active since (`openedInBackground`).
- **Restored** — reopened at launch from the layout saved on disk.

## Gestures — what the user does and must see

- **G1 panel-from-anywhere.** A panel focused with user intent while another app is frontmost appears and takes typing while the app stays in the background; the app comes forward only when an application window is focused with user intent or the user focuses one. A page asked for from a panel that holds key over another app is a transient page-host window: it is built non-activating, takes key and content focus at once, and the app stays in the background; it lasts exactly as long as it holds key with the app inactive (G13). An unpinned page-hosting application window focused without user intent while the app is inactive — a page opened from the command line — does not bring the app forward either, and the other app keeps key. Both are held above other apps until the app activates, which returns every held window to ordinary stacking and puts the most recently held one in front; a transient window closing changes no other window. A window shown without a focus (a restored window, a window opened not to show) is never held. With the app already active the same focus is an ordinary focus.
- **G2 escape-is-one-change.** Escape does exactly one thing per press: content that consumes it changes only that content; otherwise the one key window hides or closes; with nothing to hide, the Escape fallback window opens.
- **G3 hide-returns.** When a transient hides, key returns as F7 states: to its prior window if it took key from a Peek window while the app was active, and to nobody — the user stays in the other app — if it took key from another app, directly or through a chain of transient windows. No window that was not in use comes forward.
- **G4 transient-opens-every-time.** A transient opened over an application window shows above that window and key, on every open, and stays until dismissed or the app deactivates.
- **G5 transient-blur.** A visible transient loses to a world-caused focus elsewhere: it is dismissed, whatever content it loaded.
- **G6 close-lands-behind.** Closing a key transient, by Escape or by a close request, closes it and not the window behind; key returns as F7 states, and a window that gets it accepts typing at once, with no click, and an overlay attached to it stays on it.
- **G7 fallback-window.** Escape with an application window key and nothing to close opens the Escape fallback window; Escape in it closes it; the app deactivating closes it and the other app keeps focus.
- **G8 app-deactivate.** The app deactivating takes off screen, with the app, every visible pinned window that accepts input and is not transient, regardless of role; nothing lingers over the other app; nothing is dismissed before the app has actually deactivated.
- **G9 app-activate.** The app activating shows again what deactivation hid, an attached overlay in front of its host, and never a window that was dismissed.
- **G10 fullscreen-escape.** Escape on a fullscreen window exits fullscreen first; the Escape fallback window never opens over a fullscreen window.
- **G11 focus-background.** A world-caused focus on a background window brings it forward without flicker; a transient in front does not reassert itself; key lands on that window.
- **G12 restore.** A restored or reopened window comes back unmaximized at its saved bounds; a window that was maximized when saved or closed comes back at its pre-maximize bounds. Maximize is not restored: a window manager may refit a window mapped at full work-area size, and restoring at the normal size avoids a stale maximized flag. Saved data from older builds that records a maximized window is converted the same way on restore.
- **G13 transient-page-ends.** A transient page-host window ends the moment it stops being key while the app is still inactive, the user switches desktop, or the app becomes active while it is key. The same holds for every transient window that took key from another app, directly or through a chain of transient windows; nothing about it depends on which feature opened the window. Every one of those closes it outright; nothing replaces it, and the page stays in history. Losing key with the app inactive is the user clicking another app or switching desktop; the app becoming active while the page is key ends it the same way, rather than bringing the page forward as an ordinary window. Escape on a transient page-host window closes it too. Reason for closing: the page was asked for while Peek was not focused, so the task ends the moment that focus state ends, whichever way it ends — including the user bringing Peek itself forward.
- **G14 switcher-reach.** The switcher lists the app's windows from every desktop, and picking one takes the user to that window's desktop. It is the one way to reach another desktop's window: a pick names a window the user knows is open there, while every other request makes something happen, and new things happen where the user is (`specs/kernel-desktops.md` rule 5).

### Opening a page from another app: which app holds OS focus at each step

The purpose of G1 is that a page can be opened as a transient page-host window without leaving
the task in the other app. The page has everything a frontmost window has —
key, content focus, the close shortcut, Escape — except that the app never
becomes the active app. Ending the transient page-host window leaves the user exactly where
they were before pressing the panel hotkey. The other app stays the active app
at every step except 5e, where the user brings the app forward.

| Step | The user | Active app | Typing goes to | On screen |
|---|---|---|---|---|
| 1 | works in the other app | other app | other app | — |
| 2 | presses the panel hotkey | other app | the panel (user intent, F6) | panel above the other app |
| 3 | enters a URL | other app | the page, at once and without a click | panel gone; page above the other app, key and content-focused |
| 4 | reads, types, scrolls in the page | other app | the page | unchanged |
| 5a | presses Escape | other app | other app | page closes |
| 5b | presses the close shortcut | other app | other app | page closes |
| 5c | clicks the other app | other app | other app | the transient page-host window closes (G13); nothing replaces it |
| 5d | switches desktop | other app | other app | same as 5c: the transient page-host window closes; it stays on its own desktop and is never drawn on the one switched to |
| 5e | brings the app forward | this app | wherever the platform puts key on activation; the manager raises nothing | the transient page-host window closes (G13), the same as 5c/5d; nothing replaces it |

A page is a transient page-host window when it is opened to show while one of the app's windows
holds key over another app — the user is already typing into the app, so handing key to the page
takes nothing from the other app. This is the general rule for transience, not a page rule: while
another app is focused, anything a Peek window opens to show is transient
(`WindowRecord.transient`). Only a non-activating window can hold key in an inactive app, and that
is fixed when a window is built, so a transient window is built non-activating: on macOS an
ordinary window flagged through `nonactivating-window.ts`, which stays on the desktop it was shown
on. (A `type: 'panel'` window, the fallback without the flag, is pinned to every desktop for good:
Electron adds the all-desktops flag to a panel on every set and no call clears it,
`electron_ns_panel.mm setCollectionBehavior:`.) A transient window does not outlive the moment
that made it: when it stops being key, the app resigns, the user switches desktop, or the app
becomes active while it holds key taken from another app, the kernel ends it outright (effect
`DismissWindow`) — the page was asked for while Peek was not focused, so the task ends the moment
that focus state ends, and the page stays reachable from history rather than reappearing as an
ordinary window. Nothing reopens it: a second window, plus the close-and-focus ordering keeping one
on screen would need, would add machinery for little gain over history.

A page opened while the app is inactive with nobody typing into the app — a
command-line open — is not a transient page-host window. It takes no key; it is held above other
apps unfocused (G1), and the first click on it brings the app forward. That
click must reach the kernel as a world-caused focus: a hide made while the app
is inactive provokes no platform-chosen focus, so none is expected after it
(`window-kernel.ts hideProvokesFocusReassignment()`, recorded by
`expectPlatformFocus` and matched by `platformChoseFocus`); an expectation
left standing swallows the click, leaves no key window, and sends the next
Escape to the Escape fallback window.

Limits and checking notes for a transient page-host window:

- It cannot go fullscreen. `ipc.ts createHybridHostBaseWindow()` sets
  `fullscreenable: false` for every panel-type host, and a fullscreen
  non-activating panel is untested on macOS.
- A content page that came up in the background as the app's only window still
  closes on Escape (`window-escape.ts escapeClosePolicy()`,
  `openedInBackground`); `TRANSIENT_PAGE_ESCAPE` does not reach that case.
- macOS restacks an ordinary-level window of a non-active app behind the active
  app's frontmost window about 20ms after it is shown, and Electron reports that
  as `hide` while `isVisible()` stays true. The floating level is exempt, which
  is why a hold uses it (`electron-window-backend.ts pinAlwaysOnTop()`).
- Electron's `app.isActive()` answers true while an inactive app's palette holds
  key, so app activity is read from the kernel (`getAppActive()`).
- Live checks run without `DEBUG`. Under `DEBUG` the palette's detached DevTools
  window is an ordinary activating window; showing it activates the app before
  anything else runs, so the first palette press looks broken.
  `main/window-diag.ts wmLog()` is always on and is enough to follow focus,
  raise and Escape decisions from the launch output.

## Focus

- **F1 one-key.** At most one window is key, and `key` is written only by an OS focus report, never by anything the manager does on its own: not a focus command, not restoring a saved stack order, not preparing a focus for later.
- **F2 machine-labelled.** Every focus change the manager causes is reported machine-caused; a machine-caused focus may dismiss only transients that opened before that focus was asked for, never anything newer.
- **F3 confirmation-drives-nothing.** The OS report confirming an asked-for focus causes no further focus change and no dismissal.
- **F4 raise-means-key.** A window the manager focuses ends up key and accepting input; if it was already key it is only brought to the front.
- **F5 raise-needs-a-surface.** A focus command lands only on a window that is visible and not pending hidden; on any other record it does nothing.
- **F6 intent-beats-inactive.** A focus carrying user intent reaches its target regardless of the frontmost app: a panel takes key without activating the app, any other window brings the app forward. The app-inactive mask applies only to focus commands without user intent: such a focus never activates the app, never moves key, and never takes content focus — a content focus that accompanies a raise follows the raise's own fate, so it never reaches the window on its own once the raise is masked — and on an unpinned page-hosting application window it holds that window above other apps instead (G1) until the app activates or the window leaves the screen. A user-intent focus on a non-activating page-hosting window leaves the app inactive as well, so it holds that window the same way, until the transient page-host window closes (G13).
- **F7 hide-returns-key.** When the key window hides or closes while the app is active, the user goes back to where they were before it took key. If it took key from another app, directly or through a chain of transient windows (no prior Peek window), the manager focuses nothing and the user is back in that app: a transient window opened over another app never brings Peek forward when it ends. If it took key from a Peek window, key returns to that window if it is visible and on a current desktop; if that window is gone or elsewhere, to the topmost visible application window on a current desktop; otherwise nothing. Whatever the OS focuses next arrives world-caused.
- **F8 dismissal-keeps-the-app.** A dismissal never deactivates the app: if the app was frontmost it stays frontmost, with no key window when nothing visible remains. Focus is never handed to another app by a dismissal. The one exception is the last window that keeps the app on screen closing (`window-kernel.ts holdsAppOnScreen`), which hides the app (`HideApp`).
- **F9 stay-on-this-desktop.** A focus the manager makes without user intent lands only on a window on a current desktop (its desktop is currently shown on some screen, or it is on every desktop). A focus with user intent may take the user to another desktop, because the user named that window; picking a window in the switcher is such a focus.

## Visibility and lifecycle

- **V1 paint-before-dismiss.** No close or dismissal lands on a window that has not painted, and the OS reports that follow a window's own opening never dismiss it.
- **V2 show-is-explicit.** A hidden window returns to the screen only by an explicit show; a late report never re-shows it.
- **V3 keeplive-hides.** A keepLive window hides on close and is never destroyed; its reuse is show then focus.
- **V4 reversible-is-not-final.** Hiding with the app claims no dismissal victim and is undone by the app activating; a dismissal is never undone.
- **V5 late-paint-still-obeys.** A transient that paints after key has already left it is dismissed then, not stranded.
- **V6 one-close-per-input.** One Escape press or one focus change produces at most one close of one window, and never lands on a window that opened after the input.

## Stacking

- **S1 order-is-total.** The order holds every window the manager knows, bottom to top; membership shrinks only on close.
- **S2 fixed-point.** Every stack change settles in a bounded number of steps; two windows never focus each other in turn.
- **S3 one-raise-per-cause.** A single OS focus report causes at most one focus command, once, and selects a window for dismissal at most once until the OS confirms its hide.
- **S4 transient-above-origin.** A transient sits above its prior window; an attached overlay sits in front of its host and follows it across app switches.
- **S5 key-raise-reorders.** Focusing a visible key window changes z-order only, never shows anything.

## Persistent windows: workspace-pinned and global HUD

The general pinned persistent-overlay window class (Peek item `0807b46c`) has two kinds
(`57b89e6e`, note event 2026-09-21): **workspace-pinned** windows, visible while one workspace is
active and gone when it isn't, and **global HUD** windows, visible whichever workspace is active.
Both are ordinary Pinned windows and both are **app-level**: neither floats above another app's
windows, and both hide when Peek deactivates and reshow when it reactivates, the same as every
other Pinned window; the only difference between the two kinds is workspace scope, not how they
relate to the rest of the OS. Pin is a **per-window attribute the user can set on any window** —
workspace scope or global scope — not a role only a feature can declare; a feature-created window (the
workspace panel) can still be born pinned, but pinning is not confined to windows a feature builds
for the purpose.

### What each kind is, in the vocabulary already defined above

- **Both kinds = Pinned.** `layer` above `BASE_LAYER` (`window-kernel.ts` `WindowRecord.layer`,
  from `alwaysOnTop`) — the same axis, the same G8/G9 behaviour, for both. G8 ("app-deactivate")
  and G9 ("app-activate") are unchanged: a pinned window, of either scope, hides when Peek
  deactivates and reshows when Peek reactivates, exactly like it does today. No `nonActivating`
  (Panel), no `desktopMembership: 'follow'`, and no exemption from G8 — those would make a pinned
  window float above another app or survive Peek losing focus. Neither kind is a new `WindowClass`
  value.
- **The one axis that is new: workspace scope.** Not a window-kernel fact — the window-kernel
  still never learns about workspaces, the same way it never learns which feature opened an
  ordinary content window. A workspace-pinned window is associated with the one workspace it was
  pinned in; a global HUD window is associated with none, or equivalently with all of them. This
  association lives in the workspace/session layer (`features/spaces/background.js`,
  `main/session.ts`), not in `WindowRecord` — see "Workspace interaction" and "Lifecycle" below for
  where it is read and written.

### Pinning and unpinning

- **The user action.** A command-palette command, `cmd:execute:<command>` through the existing
  command registry — "Pin to this workspace" and "Pin across workspaces" as two distinct commands
  (or one command with a follow-up choice; either reads the same from the palette), plus "Unpin."
  Once a window carries the badge (below), a control on the badge itself also unpins it — clicking
  the badge is a shorter path than reopening the palette for a window that is already visibly
  pinned. Reason: the palette is the action surface the rest of the app already uses for anything
  that is not tied to one specific piece of chrome (windows, cmd, peeks, slides all register
  commands this way), so pin/unpin follows the established pattern rather than inventing a
  right-click menu or window-chrome control the app does not otherwise use — Peek's windows are
  largely chromeless tile content, not native-decorated windows, so a native context menu has
  nothing to attach to. The badge control exists only for unpinning, because only a pinned window
  has a badge to put it on; pinning a not-yet-pinned window always goes through the palette.
- **The workspace panel is not user-pinned.** It is a global HUD window (see "The workspace panel"
  below) that the workspace feature opens already pinned across workspaces — the user does not
  pin or unpin the panel itself, only content windows they choose to pin. Both paths set the same
  underlying attribute; they differ only in who sets it and when.
- **The badge.** Settled by the note event for workspace-pinned windows: a small badge in the
  top-left corner, rendered by the window's own content (its tile draws it in CSS), not a
  window-kernel property — the reducer already keeps decoration out of `WindowRecord`, and one
  visual is not a reason to add it there. Global HUD windows get a **distinct** badge, not no
  badge: the workspace-pinned badge's meaning ("this goes away if you switch workspaces") does not
  apply to a global HUD window, but a visual indicator still has to be there for two reasons — the
  unpin control above lives on the badge, so a global HUD window needs a badge to carry it, and a
  window pinned across every workspace is exactly as worth signalling as one pinned to a single
  workspace, just with the opposite meaning ("this window follows you everywhere," not "this
  window is local to here").

### The workspace panel — removed

The workspace panel (`2a07c0ac`) — a corner window shown while a workspace is active, naming the
current workspace, with close and switch controls — was removed in `59bbe921`, along with
`features/spaces/panel.html`, `panel.js` and `panel.css`. Nothing renders it and nothing can
reopen it; `tests/desktop/spaces-window-locking.spec.ts` asserts that no `spaces/panel.html`
window appears. The reasoning below is kept because the *global HUD window* classification it
established still governs any such window, and because the rest of this section refers to it as
the worked example of one: it was pinned across workspaces, so it stayed visible whichever
workspace the user was in. A workspace-pinned reading (visible only in one workspace, gone on
switch) would have made it disappear exactly when it was supposed to orient the user during a
switch; naming the *current* workspace, rather than being scoped to one, is itself evidence for
the global-HUD reading.

What replaced its controls: the active workspace is named by the right-edge accent and its label
(`features/spaces/border.html`), by the command palette's mode indicator
(`renderer/cmd/panel.js updateModeIndicator`) and by the page chrome's space widget
(`renderer/page/overlay.js buildSpaceModeContent`) — all read-only. Leaving a workspace goes
through the `close space` and `switch space` commands, and entering one also through
a card click in the browse-all Spaces list (`features/spaces/home.js activateSpace`).

### Settling `57b89e6e`'s open questions

- **Selection UX.** Answered above under "Pinning and unpinning": a palette command to pin (to
  this workspace or across workspaces) and to unpin, plus an unpin control on the badge.
- **Visual indicator.** Answered above: the badge, distinct per scope.
- **Workspace interaction.** A pinned window keeps whatever role it already had — pinning a page
  the user is reading does not turn it into chrome, and `layer` is orthogonal to role by
  construction (`window-manager.md` §0.1.4: "orthogonal properties, no pre-combined class"). So a
  pinned application window (`CONTENT_ROLES`) appears in the Windows switcher and counts as an
  ordinary window of its workspace exactly as an unpinned one would; only the workspace panel
  itself, being dedicated chrome rather than user content, is excluded from the switcher, by role,
  the same way other chrome already is. Pin state is recorded as part of the window's own saved
  state, not tracked separately or specially recreated: a workspace is a named session snapshot
  (`main/session.ts saveSessionSnapshot` / `restoreSessionSnapshot`, keyed by workspace id — the
  same functions the app's own boot/quit snapshot uses), and pin scope is a field of the window's
  own context row (`context.pinScope`), carried on its descriptor in whichever snapshot it is
  saved into (`main/session-projection.ts serializeSession`). A workspace-scoped pin is therefore
  part of that workspace's own saved snapshot, restored with the rest of that workspace's windows
  when it is re-entered. A cross-workspace pin is excluded from every NAMED workspace's snapshot —
  `serializeSession` derives that from the key alone, so no caller has to ask for it — and is never
  scoped to any one workspace's saved state; its home is the default workspace's snapshot, the row
  boot restores. A save of the default workspace records it there like any other window; a save
  under a named key (a workspace switch, or the app's own autosave/quit save while a named workspace
  is active — ambient saves write the ACTIVE workspace's row, which the spaces feature reports
  through `api.session.setActiveWorkspace`) refreshes the default row's record of every
  cross-workspace pin without touching the rest of that row, so a pin made in a named workspace
  survives a relaunch too. At boot the pins come back even when the session itself does not (the
  restore-session preference off, or the crash-recovery dialog declined). A live restore into any
  workspace skips a cross-workspace-pinned descriptor outright (it is assumed still open, since
  leaving a workspace never closes one). `features/spaces/background.js closeSpace()`/`closeCurrentWorkspaceWindows()`
  closes every live content-role window (`WORKSPACE_CONTENT_ROLES`) rather than asking
  `api.context.getWindowsInSpace` which ones carry the outgoing workspace's mode tag: only one
  workspace's content windows are ever on screen at a time, and a live tag can lag or be
  overwritten by an unrelated feature, so a window that failed the tag check was a window that
  silently outlived every later switch. A window pinned across every workspace is skipped by an
  explicit check on its 'pin' context entry. A
  workspace-pinned window that has no cross-workspace claim is closed by that same sweep like any
  other window in the workspace, and comes back from the workspace's saved snapshot — with its pin
  and badge intact — the next time that workspace is entered.
- **Multi-display.** Anchored to the display it opened on; it does not follow the cursor. Nothing
  pins to a display over time in this design, and nothing in the kernel today relocates a window's
  bounds without a user action (`bounds` changes only through an
  explicit command) — inventing live cross-display tracking for a case nothing asks for is the
  "invent an axis so the mapping comes out clean" mistake `window-manager.md` §0.1.7 warns against.
- **Lifecycle — session restore and force-quit.** Covered under "Workspace interaction" above: pin
  state is part of the window's own saved state, workspace-scoped or applying to every workspace,
  restored the same way the window's other saved properties (bounds, URL) are. There is no separate
  "is this window pinned" store to keep in sync with the window itself.
- **Conflict resolution — overlapping pins.** No new layout rule. Windows in the Pinned layer band
  resolve their relative order the way any layer band does — `order` position within the band,
  realized bottom-to-top (`window-manager.md` §0.1.6) — so the most recently raised or opened one
  sits on top. The workspace panel and a bottom-of-screen HUD instance, if one is built, do not
  occupy the same screen region, so real overlap between two pinned windows is not a case in scope
  today; an instance that does overlap another gets a placement rule when it is built, not
  speculatively now.
- **Focus semantics.** A pinned window, workspace-scoped or global, is only ever visible while Peek
  is the active app (G8 hides it otherwise), so "does clicking it bring Peek forward while another
  app is frontmost" cannot arise for either kind — it is never on screen to click in that state.
  While Peek is active, a pinned window behaves like any other focusable Peek window of its role;
  nothing non-activating is needed.
- **Cmd panel / modal interaction.** No special exemption for being pinned. Whatever the
  palette's or switcher's existing hidden-window candidate logic
  (`izui-state.ts IzuiCoordinator.enterOverlay`'s `hiddenIds`) already does for a window's role
  continues to apply unchanged — the workspace panel is excluded the way other chrome already is,
  by role; a pinned ordinary tab is treated exactly like an unpinned one.

### What is genuinely new

One axis, and it is not on `WindowRecord`: workspace scope — which single workspace a
workspace-pinned window belongs to, or that a global HUD window belongs to none/all of them — kept
by the workspace/session layer, read at workspace-entry/exit time and at session save/restore
time. Everything else is the existing `layer` axis (Pinned) plus a palette command to set and
clear it, a badge the pinned window's own content renders, and an unpin control on that badge.
No `WindowRecord` field, no `class` value, and no change to G8 or G9.

A pinned window is swept by G8 regardless of role: pin is app-level, not an OS-level float, so a
pinned window — a workspace-pinned or global-HUD window, application-role content window included
(`CONTENT_ROLES`) — hides along with everything else when Peek deactivates and reshows when it
reactivates. There is no picture-in-picture case where a pinned window stays visible while another
app is frontmost.

### Workspace membership

**Every content window on screen belongs to exactly one workspace** (`CONTENT_ROLES`: content,
child-content, workspace), whatever route opened it — the command palette, a click inside a
space's own item list, a page's own popup, a declarative `window` command such as `open spaces`,
a restored snapshot row. The default workspace is a workspace like any other for this purpose:
when no named workspace is active, new windows belong to the default. A window belongs to the
workspace that was active when it opened and keeps that membership until it closes (or is
re-pinned to another workspace — "Pinning and unpinning" above); it is closed by the per-workspace
sweep when its workspace is left and comes back from that workspace's saved row when the
workspace is re-entered. A global HUD window is the one exception, as above: it belongs to none.

Membership is still not a window-kernel fact. It is the `mode=space` context row on the window
(`spaceId` = the workspace's tag id), written **at open time by the main process** — before the
page loads, so the page reads its own membership at load and the session projection files the
window under its workspace from its first autosave. The write happens in one place every
construction path calls, `ipc.ts inheritedModeForNewWindow`: an explicit `spaceMode` option wins,
else the opener's own space/group membership, else the declared default for new windows
(`datastore.ts setContextDefault('mode', …)`, `api.context.setDefault`), which the Spaces feature
declares as the active workspace at bootstrap and at the top of every workspace entry — before
that workspace's snapshot is restored, so a restored row without a saved mode lands in the
workspace being entered, never the one being left.

Two kinds of window take no default, on purpose:

- **Not content** — satellites (palette, switcher, overlay), quick-views (peeks, slides), and
  feature chrome (the screen border). They belong to no workspace and are never swept by one;
  the border is closed by the feature itself.
- **Not on screen** — a window born unshown (`show: false`): the pre-warmed settings singleton, a
  helper page, a snapshot row mid-restore. It is not something the user has open in this
  workspace; sweeping it, or saving it as workspace content, would be wrong. A restored row
  carries its own saved membership instead.

Failure this forbids: a window that survives every switch and belongs nowhere. Before this rule a
palette-opened page, or the browse-all Spaces page, carried no membership, stayed visible in every
workspace, hid the border whenever it was focused (the border follows the focused window's
membership), and — for the browse-all page — was duplicated on every return to the default, which
restored the saved copy beside the one that never left (`specs/spaces-window-locking-regressions.md`).

## Dismissal and Escape

- **D1 one-escape-rule.** Escape closes the topmost visible Escape-closable window; no window kind gets an Escape rule of its own.
- **D2 escape-hits-its-window.** Escape acts on the window that was key when pressed; if key moved before handling, the press is dropped, never redirected to a newer window.
- **D3 escape-never-waits.** A window whose content does not handle Escape answers at once; no press waits on it.
- **D4 close-before-open.** The Escape fallback window opens only when no visible Escape-closable transient exists and the key window has nothing to close.
- **D5 escape-order.** Close the Escape fallback window, then Escape pass-through, then exit fullscreen, then defer to content that consumed the press, then close or hide the target, then open the fallback window.
- **D6 blur-dismissal.** A painted transient that is not key is dismissed when key lands elsewhere, unless the window that took key was opened by it or is its attached overlay, the focus was machine-caused and the transient opened after that focus was asked for, it is click-through, or it is itself an attached overlay.
- **D8 resign-sweep-after-resign.** No visible window is dismissed while the app is active; the deactivation sweep runs only after the app has deactivated and settled.
- **D9 escape-closes-a-background-page.** Escape on an application window with nothing to close closes it in a default session, since the user came to it from another app and is going back there; otherwise it opens the Escape fallback window.

## Recorded failures and the rule that forbids each

| Failure (`window-manager.md` → "Open kernel defects", `window-manager-macos-signoff.md`) | Rule |
|---|---|
| Palette from another app (Opt+Space) is on screen but dead; typing and Escape go to the other app | G1, F6 |
| Page opened from the palette over another app shows on every desktop and stays above every app after the user leaves it | G13 |
| Closing that palette raises the settings window | G3, F7 |
| Reopened palette flashes open/closed for hundreds of cycles | V2, F5 |
| One Escape issues two closes; the late one kills the reopened palette | G2, V6 |
| Settings raised twice, 1ms apart, on every palette hide | F3, S3 |
| Escape with no key holder opens the switcher instead of closing the palette | D1, D4 |
| Escape in the palette opens the switcher (defect B) | G2, D1 |
| Palette swept ~250ms after opening with Peek not frontmost | V1, F2 |
| Peek opens only every other press; new window destroyed during load (defect A) | G4, V1 |
| Fresh peek vanishes 106–147ms after painting when its host reclaims focus | F2, D6 |
| Peek vanishes 0.9–1.3s later on its own | G4, D8 |
| Quick-view on `data:`/`about:blank`/`peek://` never dismisses on blur | G5, D6 |
| Late-painting quick-view stranded on screen after focus left | V5 |
| Reopened palette reordered but not key; typing goes elsewhere | F4, S5 |
| Stale Escape (up to 1s late) closes a peek that opened meanwhile | D2, V6 |
| Every Escape over a peek stalls 500ms on an unanswerable ask | D3 |
| Two page hosts trade the stack top forever; app hangs (defect C, overlay-close hang) | S2 |
| Machine focus reported as world; ordering floor disarmed | F2 |
| Raise's confirmation counted as a new raise; several tokens churn | F3, S3 |
| Hidden window re-appears on a late `show` echo with chrome re-attached | V2 |
| Session restore leaves focus nowhere or on the wrong window | F7 |
| Restored or reopened window comes back maximized, or at the maximized rect instead of its pre-maximize bounds | G12 |
| Switcher's focus sweeps the palette twice for one window | S3, D6 |

Open against these rules: nothing. G1/F6 closed at `7e2eab6c` and G3/F7 at `a86b030c`, both
verified by hand on the packaged build on 2026-09-12: with another app frontmost, the global
hotkey put the command window up with `plan=take-key intent=user`, typing landed in it, the
menubar stayed on the other app, and the second Escape hid it with no other window focused and
focus back in the other app. S3's dismissal half closed at `b7e685e6`. The "fresh peek vanishes"
row did not reproduce on 2026-09-13; the rule that used to cover it (a window that just took key
survives its prior window reclaiming focus) was deleted the same day, since a transient that
loses focus is dismissed by D6 with no exemption for being new. Everything else in the table is
fixed or not reproducing. G7, G10 and G11 were checked by hand on the packaged build on
2026-09-13: G7 first failed (after Escape closed the switcher, key went to the chrome overlay and
Escape was dead, because a closed key window asked for no successor) and passed after `8458ac93`,
with every switcher close followed by a raise of the page host; G10 exits fullscreen on Escape and
never opened the switcher; G11 brought a background page forward by Cmd+Tab and by its chrome
with no flicker. The kernel read against every rule, with a verdict and sites per rule, is
`window-rules-audit.md`.
