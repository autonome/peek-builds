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
as the concrete instance that exposed a rule.

## Vocabulary

Each term is followed by the name the code uses for it.

- **Key** — the one window the OS reports as receiving keystrokes (`State.key`).
- **Show** — put a hidden window on screen. Says nothing about key (`ShowWindow`).
- **Focus** — bring a window to the front and make it key. Focusing the window that already has focus only brings it to the front (`RaiseWindow`).
- **World-caused** — a focus change the user or the OS made (`FocusCause` kind `world`).
- **Machine-caused** — a focus change the manager made by following a rule (`FocusCause` kind `machine`).
- **User intent** — a machine-caused focus that answers a direct user request rather than a rule's own follow-through (`intent: 'user'`).
- **Painted** — the window's first frame has composited, so the native window can be stacked (`orderable`).
- **Transient** — a window that closes itself when another window takes focus (`selfClosesOnBlur`, or today one of the roles in `TRANSIENT_ROLES`).
- **Application window** — a window the user works in (today one of the roles in `CONTENT_ROLES`). A window may be neither transient nor an application window.
- **Prior window** — the window that had focus when this one took it (`priorKey`).
- **Opener** — the window that opened this one (`parentId`).
- **Attached overlay** — a window bound to a host and shown, hidden and moved with it (`overlayFor`).
- **Click-through** — accepts no input (`acceptsInput: false`).
- **Escape pass-through** — Escape is declared to reach the window's own content instead of the manager (`escapeMode: 'ignore'`).
- **Escape-closable** — Escape is declared to close the window (today one of the roles in `ESC_CLOSE_ROLES`).
- **Escape fallback window** — the one window Escape opens when it has nothing to close (today `SWITCHER_ROLES`).
- **keepLive** — the window hides instead of closing (`keepLive`).
- **Dismissal** — a rule or an Escape press takes a window off screen for good: it is closed, or hidden if it is keepLive. A dismissed window never comes back on its own (`DismissWindow`).
- **App activates / app deactivates** — the app becomes, or stops being, the frontmost app (`AppActivated`, `AppResigned`).
- **Hidden with the app** — hidden because the app deactivated, so nothing floats over the other app; shown again when the app activates. Not a dismissal (`hiddenByAppBlur`).
- **Pending hidden** — chosen for dismissal, and the OS has not yet confirmed the hide (`pendingHidden`).
- **Default session** — the first window opened while the app was inactive and none has opened while active since (`openedInBackground`).

## Gestures — what the user does and must see

- **G1 raise-from-anywhere.** Focusing a window with user intent, with any app frontmost, puts it on screen, makes the app active and makes it key; typing lands in it with no click.
- **G2 escape-is-one-change.** Escape delivered to a key window whose content consumes it changes only that content; Escape its content does not consume hides or closes exactly that window. One press changes exactly one window.
- **G3 hide-returns.** When a transient hides, key returns to its prior window: a window of the app if the app was active when it opened, the other app if not. No window that was not in use comes forward.
- **G4 reopen-is-open.** A second show of a keepLive window at any interval after it hid behaves as G1; it never flashes, loops or reappears after its hide.
- **G5 transient-opens-every-time.** A transient opened over an application window shows above that window and key, on every open, and stays until dismissed or the app deactivates.
- **G6 transient-blur.** A visible transient loses to a world-caused focus elsewhere: it is dismissed, whatever content it loaded.
- **G7 close-lands-behind.** Closing a key transient (by Escape or by a close request) closes it and not the window behind; that window is key and accepts typing at once, with no click, and an overlay attached to it stays on it.
- **G8 fallback-window.** Escape with an application window key and nothing to close opens the Escape fallback window; Escape in it closes it; the app deactivating closes it and the other app keeps focus.
- **G9 app-resign.** The app deactivating takes off screen, with the app, every visible window above the base layer that accepts input and is neither transient nor an application window; nothing lingers over the other app; nothing is dismissed before the app has actually deactivated.
- **G10 app-activate.** The app activating shows again what deactivation hid, an attached overlay in front of its host, and never a window that was dismissed.
- **G11 fullscreen-escape.** Escape on a fullscreen window exits fullscreen first; the Escape fallback window never opens over a fullscreen window.
- **G12 raise-background.** A world-caused focus on a background window brings it forward without flicker; a transient in front does not reassert itself; key lands on that window.
- **G13 restore.** A window restored from a saved session comes back at its saved bounds and maximized state.

## Focus

- **F1 one-key.** At most one window is key, and `key` is written only by an OS focus report, never by a focus command, an import or an arming.
- **F2 machine-labelled.** Every focus change the manager causes is reported machine-caused; a machine-caused focus may dismiss only transients opened before the op that caused it, never anything newer.
- **F3 confirmation-drives-nothing.** The OS report confirming a focus the manager asked for causes no further focus change and no dismissal.
- **F4 raise-means-key.** A window the manager focuses ends up key and accepting input; if it was already key it is only brought to the front.
- **F5 raise-needs-a-surface.** A focus command lands only on a window that is visible and not pending hidden; on any other record it does nothing.
- **F6 intent-beats-inactive.** A focus carrying user intent activates the app and gives its target key regardless of the frontmost app; the app-inactive mask applies only to focus commands without it.
- **F7 hide-returns-key.** When the key window hides or closes, key goes to its prior window if that window is still visible; if that window is gone, to the topmost visible application window; if nothing in the app was key before it, nothing is focused.
- **F8 land-somewhere.** After any dismissal something visible is key and accepts typing without a click.

## Visibility and lifecycle

- **V1 paint-before-dismiss.** No close or dismissal lands on a window that has not painted, and a window's own opening echoes never dismiss it.
- **V2 show-is-explicit.** A hidden window returns to the screen only by an explicit show; a late OS notification or a stale focus report never re-shows it.
- **V3 keeplive-hides.** A keepLive window hides on close and is never destroyed; its reuse is show then focus.
- **V4 reversible-is-not-final.** Hiding with the app claims no dismissal victim and is undone by the app activating; a dismissal is never undone.
- **V5 late-paint-still-obeys.** A transient that paints after key has already left it is dismissed then, not stranded.
- **V6 one-close-per-input.** One Escape press or one focus change produces at most one close of one window, and never lands on a successor that opened after the input.

## Stacking

- **S1 order-is-total.** The order holds every registered window bottom to top; membership shrinks only on close.
- **S2 fixed-point.** Every stack change settles in a bounded number of steps; two windows never focus each other in turn.
- **S3 one-raise-per-cause.** A single OS focus report causes at most one focus command, once, and selects a window for dismissal at most once until the OS confirms its hide.
- **S4 transient-above-origin.** A transient sits above its prior window; an attached overlay sits in front of its host and follows it across app switches.
- **S5 key-raise-reorders.** Focusing a visible key window changes z-order only, never shows anything.

## Dismissal and Escape

- **D1 one-escape-rule.** Escape closes the topmost visible Escape-closable window; there is no per-window-kind arm.
- **D2 escape-hits-its-window.** Escape acts on the window that was key when pressed; if key moved before handling, the press is dropped, never redirected to a newer window.
- **D3 escape-never-waits.** A window with no Escape responder answers immediately; no press stalls on it.
- **D4 close-before-open.** The Escape fallback window opens only when no visible Escape-closable transient exists and the key window has nothing to close.
- **D5 escape-order.** Close the Escape fallback window, then Escape pass-through, then exit fullscreen, then defer to content that consumed the press, then close or hide the target, then open the fallback window.
- **D6 blur-dismissal.** A painted transient that is not key is dismissed when key lands elsewhere, unless the focuser was opened by it or is its attached overlay, the focus was machine-caused and the transient is newer than the op that caused it, it is click-through, or it is itself an attached overlay.
- **D7 no-self-dismissal.** A window that just took key is never dismissed by its prior window reclaiming focus by machine cause.
- **D8 resign-sweep-after-resign.** No visible surface is dismissed while the app is active; the deactivation sweep runs only after the app has deactivated and settled.
- **D9 content-ignores-escape.** An application window does not close on Escape, default session or not.

## Recorded failures and the rule that forbids each

| Failure (`window-manager.md` → "Open kernel defects", `window-manager-macos-signoff.md`) | Rule |
|---|---|
| Palette from another app (Opt+Space) is on screen but dead; typing and Escape go to the other app | G1, F6 |
| Closing that palette raises the settings window | G3, F7 |
| Reopened palette flashes open/closed for hundreds of cycles | G4, V2, F5 |
| One Escape issues two closes; the late one kills the reopened palette | G2, V6 |
| Settings raised twice, 1ms apart, on every palette hide | F3, S3 |
| Escape with no key holder opens the switcher instead of closing the palette | D1, D4 |
| Escape in the palette opens the switcher (defect B) | G2, D1 |
| Palette swept ~250ms after opening with Peek not frontmost | V1, F2 |
| Peek opens only every other press; new window destroyed during load (defect A) | G5, V1 |
| Fresh peek vanishes 106–147ms after painting when its host reclaims focus | D7, F2 |
| Peek vanishes 0.9–1.3s later on its own | G5, D8 |
| Quick-view on `data:`/`about:blank`/`peek://` never dismisses on blur | G6, D6 |
| Late-painting quick-view stranded on screen after focus left | V5 |
| Reopened palette reordered but not key; typing goes elsewhere | F4, S5 |
| Stale Escape (up to 1s late) closes a peek that opened meanwhile | D2, V6 |
| Every Escape over a peek stalls 500ms on an unanswerable ask | D3 |
| Two page hosts trade the stack top forever; app hangs (defect C, overlay-close hang) | S2 |
| Machine focus reported as world; ordering floor disarmed | F2 |
| Raise's confirmation counted as a new raise; several tokens churn | F3, S3 |
| Hidden window re-appears on a late `show` echo with chrome re-attached | V2 |
| Session restore leaves focus nowhere or on the wrong window | F7, F8 |
| Restored window comes back un-maximized | G13 |
| Switcher's focus sweeps the palette twice for one window | S3, D6 |

Open against these rules at `a86b030c`: D7 (post-paint sweep) and the doubled `DismissWindow` per
sweep (S3). G1/F6 (focus masked while the app is inactive, `window-kernel-executor.ts planRaise`)
closed at `88da1749`; G3/F7 (successor focus on hide was unconditional, `window-kernel.ts react`)
closed at `a86b030c`; neither is yet verified by hand. Everything else in the table is fixed or not
reproducing; G8, G11, G12 and F8 have not been checked by hand since 2026-08-21. The kernel read
against every rule, with a verdict and sites per rule, is `window-rules-audit.md`.
