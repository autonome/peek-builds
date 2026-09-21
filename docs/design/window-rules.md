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
- **Transient** — a window that closes itself when another window takes focus (`selfClosesOnBlur`, or today one of the roles in `TRANSIENT_ROLES`).
- **Application window** — a window the user works in (today one of the roles in `CONTENT_ROLES`). A window may be neither transient nor an application window.
- **Panel** — a window declared to never activate the app: it shows, and takes keystrokes, while the app stays in the background (`type: 'panel'` at open, `WindowRecord.nonActivating`).
- **Pinned** — kept above the normal stack of windows (`layer` above `BASE_LAYER`, from `alwaysOnTop`).
- **Held above other apps** — an unpinned window kept, for now, above other apps' windows without the app activating and without the window taking key; its declared layer is unchanged and it is the same window throughout (`heldAboveOtherApps`, `admitsHoldAboveOtherApps`).
- **Survives deactivation** — a declared property of a pinned window: the app deactivating does not take it off screen. Unlike Held above other apps, this is not temporary and does not end when the app activates — the window was never hidden (name TBD at implementation; see "Persistent windows" below).
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

- **G1 panel-from-anywhere.** A panel focused with user intent while another app is frontmost appears and takes typing while the app stays in the background; the app comes forward only when an application window is focused with user intent or the user focuses one. A page asked for from a panel that holds key over another app is a side task: it is built non-activating, takes key and content focus at once, and the app stays in the background. An unpinned page-hosting application window focused without user intent while the app is inactive — a page opened from the command line — does not bring the app forward either, and the other app keeps key. Both are held above other apps until the app activates, which returns every held window to ordinary stacking and puts the most recently held or set-aside one in front. A window shown without a focus (a restored window, a window opened not to show) is never held. With the app already active the same focus is an ordinary focus.
- **G2 escape-is-one-change.** Escape does exactly one thing per press: content that consumes it changes only that content; otherwise the one key window hides or closes; with nothing to hide, the Escape fallback window opens.
- **G3 hide-returns.** When a transient hides, key returns to its prior window: a window of the app if the app was active when it opened, the other app if not. No window that was not in use comes forward.
- **G4 transient-opens-every-time.** A transient opened over an application window shows above that window and key, on every open, and stays until dismissed or the app deactivates.
- **G5 transient-blur.** A visible transient loses to a world-caused focus elsewhere: it is dismissed, whatever content it loaded.
- **G6 close-lands-behind.** Closing a key transient, by Escape or by a close request, closes it and not the window behind; that window is key and accepts typing at once, with no click, and an overlay attached to it stays on it.
- **G7 fallback-window.** Escape with an application window key and nothing to close opens the Escape fallback window; Escape in it closes it; the app deactivating closes it and the other app keeps focus.
- **G8 app-deactivate.** The app deactivating takes off screen, with the app, every visible pinned window that accepts input, is neither transient nor an application window, and does not survive deactivation; a window that survives deactivation is left exactly as it was and stays above the other app; nothing else lingers over the other app; nothing is dismissed before the app has actually deactivated.
- **G9 app-activate.** The app activating shows again what deactivation hid, an attached overlay in front of its host, and never a window that was dismissed.
- **G10 fullscreen-escape.** Escape on a fullscreen window exits fullscreen first; the Escape fallback window never opens over a fullscreen window.
- **G11 focus-background.** A world-caused focus on a background window brings it forward without flicker; a transient in front does not reassert itself; key lands on that window.
- **G12 restore.** A restored window comes back at its saved bounds and maximized state.

### Opening a page from another app: which app holds OS focus at each step

The purpose of G1 is that a page can be opened as a side task without leaving
the task in the other app. The page has everything a frontmost window has —
key, content focus, the close shortcut, Escape — except that the app never
becomes the active app. Ending the side task leaves the user exactly where
they were before pressing the panel hotkey. The other app stays the active app
at every step.

| Step | The user | Active app | Typing goes to | On screen |
|---|---|---|---|---|
| 1 | works in the other app | other app | other app | — |
| 2 | presses the panel hotkey | other app | the panel (user intent, F6) | panel above the other app |
| 3 | enters a URL | other app | the page, at once and without a click | panel gone; page above the other app, key and content-focused |
| 4 | reads, types, scrolls in the page | other app | the page | unchanged |
| 5a | presses Escape | other app | other app | page is set aside: it leaves the screen, stays open, and comes back on screen when the app next becomes active (`window-escape.ts SIDE_TASK_ESCAPE`, `'hide'`; `'close'` ends it instead) |
| 5b | presses the close shortcut | other app | other app | page closes |
| 5c | clicks the other app | other app | other app | page stays on screen, no longer key |

A page is a side task (`izui-roles.ts pageOpensAsSideTask()`) when it is opened
to show while one of the app's panels holds key over another app — the user is
already typing into the app, so handing key to the page takes nothing from the
other app. Only a non-activating window can hold key in an inactive app, and
that is fixed when a window is built, so a side task is built as a panel and
stays one: clicking it never brings the app forward; the app comes forward
only through the app switcher or the dock.

A page opened while the app is inactive with nobody typing into the app — a
command-line open — is not a side task. It takes no key; it is held above other
apps unfocused (G1), and the first click on it brings the app forward. That
click must reach the kernel as a world-caused focus: a hide made while the app
is inactive provokes no platform-chosen focus, so none is expected after it
(`window-kernel-executor.ts hideProvokesFocusReassignment()`); an expectation
left standing swallows the click, leaves no key window, and sends the next
Escape to the Escape fallback window.

Limits and checking notes for a side task:

- It cannot go fullscreen. `ipc.ts createHybridHostBaseWindow()` sets
  `fullscreenable: false` for every panel-type host, and a fullscreen
  non-activating panel is untested on macOS.
- A content page that came up in the background as the app's only window still
  closes on Escape (`window-escape.ts escapeClosePolicy()`,
  `openedInBackground`); `SIDE_TASK_ESCAPE` does not reach that case.
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
- **F6 intent-beats-inactive.** A focus carrying user intent reaches its target regardless of the frontmost app: a panel takes key without activating the app, any other window brings the app forward. The app-inactive mask applies only to focus commands without user intent: such a focus never activates the app, never moves key, and never takes content focus — a content focus that accompanies a raise follows the raise's own fate, so it never reaches the window on its own once the raise is masked — and on an unpinned page-hosting application window it holds that window above other apps instead (G1) until the app activates or the window leaves the screen. A user-intent focus on a non-activating page-hosting window leaves the app inactive as well, so it holds that window the same way.
- **F7 hide-returns-key.** When the key window hides or closes, key goes to its prior window if that window is still visible; if that window is gone, to the topmost visible application window; if nothing in the app was key before it, nothing is focused.
- **F8 dismissal-keeps-the-app.** A dismissal never deactivates the app: if the app was frontmost it stays frontmost, with no key window when nothing visible remains. Focus is never handed to another app by a dismissal.

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
active and gone when it isn't, and **global HUD** windows, visible regardless of which workspace
is active or which app is frontmost. Neither is a new `WindowClass` value, and neither is a
generic "pin any window" user action — `57b89e6e`'s original OS-pin / app-pin framing assumed any
window could be toggled into either; the settled two-kind model names two window roles a feature
declares when it opens a window instead, and the two roles are what answers the framing's own
question below.

### What each kind is, in the vocabulary already defined above

- **Workspace-pinned = Pinned + owned by one workspace.** `layer` above `BASE_LAYER`
  (`window-kernel.ts` `WindowRecord.layer`), same as any other Pinned window — no new axis. "Owned
  by one workspace" is not a window-kernel fact at all: the workspace feature
  (`features/spaces/background.js` `openSpace`, `closeSpace`, `switchSpace`) opens the window when
  its workspace becomes active and closes it — not hides, closes — when that workspace is exited.
  The window-kernel never learns which workspace a window belongs to, the same way it never learns
  which feature opened an ordinary content window. G8 and G9 govern it unchanged: it hides when
  Peek deactivates and reshows when Peek reactivates, exactly like every other Pinned window today.
  This is the **app-pin** half of `57b89e6e`'s original split (visible only while Peek is the
  focused app) — it needs nothing new, because ordinary Pinned already behaves that way.
- **Global HUD = Pinned + Panel + follows Spaces + survives deactivation.** `layer` above
  `BASE_LAYER`, `nonActivating: true` (the Panel term above — takes key, if it takes key at all,
  without activating the app, per G1), `desktopMembership: 'follow'` (visible on whichever macOS
  Space is active, satisfying `57b89e6e`'s "visible across all desktop spaces / Mission Control").
  None of those three properties has been combined for this purpose before, but all three already
  exist. The one genuinely new fact is Survives deactivation (Vocabulary, above) — G8 amended.
  This is the **OS-pin** half of `57b89e6e`'s split (floats above every app's windows, seen whether
  or not Peek is frontmost), and it is the one piece of new kernel behaviour this design commits
  to. Everything else below is composition of what already exists.

**The mapping `57b89e6e`'s note event asked for:** workspace-pinned windows are app-pin — they
hide with Peek and are never seen floating over another app. Global HUD windows are OS-pin — they
float above every app, seen whether or not Peek is frontmost. A global HUD window is meant to be
glanced at without switching back to Peek, which only means something if it survives Peek losing
focus — why "non-activating" is named in the goal ("persistent, non-activating and toggleable")
even though non-activating matters only for a window that can still be seen while Peek isn't
frontmost.

### Settling `57b89e6e`'s open questions

- **Selection UX.** No user gesture pins or unpins an arbitrary window. A workspace-pinned window
  is created and destroyed by the workspace feature's own enter/exit logic, not toggled by the
  user directly. A global HUD window is shown and hidden by a toggle command
  (`cmd:execute:<command>`, the mechanism the deleted HUD used and the one peeks and slides
  already use for their own on/off state), bound to a shortcut through
  `main/feature-shortcut-registrar.ts registerWakeShortcuts`. Reason: the two known instances (the
  workspace panel, a bottom-of-screen activity-trail panel) are both features that own their own
  window, not arbitrary content a user elects to pin — nothing in scope needs a user to pin a
  window a feature didn't already build as one of the two kinds.
- **Visual indicator.** Settled by the note event for workspace-pinned windows: a small badge in
  the top-left corner, rendered by the window's own content (its tile draws it in CSS), not a
  window-kernel property — the reducer already keeps decoration out of `WindowRecord`, and one
  visual is not a reason to add it there. Global HUD windows carry no badge: the badge tells the
  user "this goes away if you switch workspaces," and a global HUD window never does, so the badge
  would be a warning that does not apply to it.
- **Workspace interaction.** A workspace-pinned window is not an "Application window" (the roles
  in `CONTENT_ROLES`) — G8 already describes pinned windows as "neither transient nor an
  application window," so this needs no new exclusion. It does not count toward the workspace's
  saved window list (`main/session.ts saveSpaceWorkspaces` / `serializeSpaceWorkspaces`): that
  projection serializes user content, and a workspace-pinned window is recreated by workspace
  entry, not restored from a snapshot, so it stays out of the projection the same way background,
  bridge and offscreen windows already do. Neither kind appears in the Windows switcher, for the
  same reason peripheral chrome already doesn't: the switcher lists application windows, and
  neither kind is one.
- **Multi-display.** Anchored to the display it opened on; it does not follow the cursor. Neither
  known instance (the workspace panel, the activity-trail panel) needs to chase the pointer across
  monitors, and nothing in the kernel today relocates a window's bounds without a user action
  (`bounds` changes only through an explicit command) — inventing live cross-display tracking for
  a case nothing asks for is the "invent an axis so the mapping comes out clean" mistake
  `window-manager.md` §0.1.7 warns against.
- **Lifecycle — session restore and force-quit.** There is no per-window pin state to restore for
  either kind, because pin-kind is declared at registration, not toggled by the user (see
  Selection UX above) — a feature that opens a global HUD window always opens it the same way.
  What does need to survive restart is whether a global HUD window was toggled visible when the
  app last quit: a boolean, persisted the way any other feature's on/off state already is (a
  `feature_settings` row, the pattern `lazy_wake_shortcuts` already uses), restored by reissuing
  the same toggle command at boot if it was last on. A workspace-pinned window needs nothing
  bespoke: which workspace was active already has to survive restart for `2a07c0ac`'s own
  workspace/session model, and re-entering that workspace recreates its pinned windows the same
  way entering it fresh does.
- **Conflict resolution — overlapping pins.** No new layout rule. Windows in the Pinned layer band
  already resolve their relative order the way any layer band does — `order` position within the
  band, realized bottom-to-top (`window-manager.md` §0.1.6) — so the most recently raised or
  opened one sits on top. Neither known instance occupies the same screen region as the other (a
  top-left badge corner, a bottom-edge trail), so real overlap is not a case in scope; an instance
  that does overlap another gets a placement rule when it is built, not speculatively now.
- **Focus semantics.** A global HUD window is a Panel: G1 already governs it — it can take key
  without activating Peek, and clicking it never brings Peek forward. A workspace-pinned window
  needs no special case: G8 already keeps it hidden whenever Peek is not the active app, so "does
  clicking it while another app is frontmost bring Peek forward" cannot arise — it is never on
  screen to click in that state. While Peek is active it behaves like any other focusable Peek
  window.
- **Cmd panel / modal interaction.** Neither kind is added to the hidden-window list a palette or
  the switcher passes to `izui-state.ts IzuiCoordinator.enterOverlay` — the same list that already
  leaves satellite and transient windows alone. The palette and a global HUD window are both
  Panels in the same Pinned band; they coexist by ordinary stacking order, with no dimming
  invented for this design.

### What is genuinely new

Everything above composes existing axes (`layer`, `nonActivating`, `desktopMembership`) and
existing rules (G1, G8, G9, S1, §0.1.6's band realization) except one: Survives deactivation, the
exemption from G8's app-deactivate sweep for a window declared to survive it, which is what lets a
global HUD window float above another app the way `57b89e6e` asked OS-pin to. Everything else
that read as open — the badge, the toggle, workspace ownership, session restore — already had a
home once the two kinds were named, and none of it needed a new `WindowRecord` field, a new
`class` value, or a user-facing pin/unpin action.

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
| Restored window comes back un-maximized | G12 |
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
