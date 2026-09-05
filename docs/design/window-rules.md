# Window rules

The rules the window manager is checked against. One rule per line, each named so a test or a
log record can cite it, each checkable by hand on the packaged macOS build. Nothing else decides
window lifecycle, focus, visibility, stacking or dismissal. Where the kernel disagrees with a rule
here, the kernel is wrong.

**Vocabulary.** *Key* is the one window receiving keystrokes. A focus change is *world-caused*
when the user or the OS moved it and *machine-caused* when Peek did. A *transient* is a palette,
quick-view (peek or slide), switcher or overlay. A *content window* is a page host or a workspace
window (settings, `peek://` surfaces). A *keepLive* window hides instead of closing. *Dismissal*
is final; a *reversible hide* (app resign) is not.

## Gestures — what the user does and must see

- **G1 palette-from-anywhere.** Opt+Space with any app frontmost puts the palette on screen, makes Peek active and makes the palette key; typing lands in it with no click.
- **G2 palette-escape.** Escape in a palette with text clears the text; Escape in an empty palette hides it. One press changes exactly one window.
- **G3 palette-return.** When the palette hides, key returns to whatever was key before it opened: the previous Peek window if Peek was active, the other app if not. No Peek window that was not in use comes forward.
- **G4 palette-reopen.** Reopening the palette at any interval after it hid behaves as G1; it never flashes, loops or reopens closed.
- **G5 peek-opens-every-time.** Opening a peek from a page host shows it above that host and key, on every press, and it stays until the user dismisses it or Peek resigns.
- **G6 peek-blur.** A visible peek loses to a world-caused focus elsewhere: it is dismissed, whatever URL scheme it loaded.
- **G7 peek-escape.** Escape or Cmd+W with a peek key closes the peek, not the host behind; the host is key and accepts typing at once, with no wake-up click, and the shared address bar stays on it.
- **G8 switcher.** Escape with a content window key and nothing to close opens the switcher; Escape in the switcher closes it; switching to another app closes it and that app keeps focus.
- **G9 app-resign.** Switching away from Peek takes every transient and the HUD off screen with the app; nothing lingers over the other app; nothing is dismissed before Peek has actually resigned.
- **G10 app-activate.** Returning to Peek restores what the resign hid, the overlay in front of its page, and never restores a window that was dismissed.
- **G11 fullscreen-escape.** Escape on a fullscreen window exits fullscreen first; a switcher never opens over a fullscreen window.
- **G12 raise-background.** Clicking the chrome of a background window, or Cmd+Tab to it, brings it forward without flicker; a peek in front does not reassert itself; key lands on that window.
- **G13 restore.** A window restored from a saved session comes back at its saved bounds and maximized state.

## Focus

- **F1 one-key.** At most one window is key, and `key` is written only by an OS focus report, never by a raise, import or arming.
- **F2 machine-labelled.** Every focus change Peek causes is reported machine-caused; a machine-caused focus never counts as the user looking away.
- **F3 confirmation-drives-nothing.** The focus report that confirms a raise causes no further raise and no dismissal.
- **F4 raise-means-key.** A window brought to the front ends up key and accepting input; only a window that is already key is merely reordered.
- **F5 raise-needs-a-surface.** A raise lands only on a window that is visible and not pending hidden; on any other record it drives nothing.
- **F6 hotkey-is-intent.** A global hotkey activates Peek and gives its target key regardless of the frontmost app; the app-inactive mask applies only to machine-initiated raises.
- **F7 hide-returns-key.** When the key window hides or closes, key goes to the window that was key before it (if visible), else the topmost visible content window, else the other app; hiding a non-key window moves nothing.
- **F8 land-somewhere.** After any dismissal something visible is key and accepts typing without a click.

## Visibility and lifecycle

- **V1 paint-before-dismiss.** No close or dismissal lands on a window that has not painted, and a window's own opening echoes never dismiss it.
- **V2 show-is-explicit.** A hidden window returns to the screen only by an explicit show; a late OS notification or a stale focus report never re-shows it.
- **V3 keeplive-hides.** A keepLive window hides on close and is never destroyed; its reuse is show then raise.
- **V4 reversible-is-not-final.** An app-resign hide claims no dismissal victim and is undone by activation; a dismissal is never undone.
- **V5 late-ready-still-obeys.** A transient that paints after key has already left it is dismissed then, not stranded.
- **V6 one-close-per-gesture.** One gesture produces at most one close of one window, and never lands on a successor that opened after the gesture.

## Stacking

- **S1 order-is-total.** The order holds every registered window bottom to top; membership shrinks only on close.
- **S2 fixed-point.** Every stack change settles in a bounded number of steps; two windows never raise each other in turn.
- **S3 one-raise-per-cause.** A single focus change raises at most one window, once.
- **S4 transient-above-origin.** A transient sits above the window it was opened over; an overlay sits in front of its host and follows it across app switches.
- **S5 key-raise-reorders.** A raise of a visible key window is a z-order change, never a show.

## Dismissal and Escape

- **D1 one-escape-rule.** Escape closes the topmost visible window whose role Escape closes (palette, quick-view, utility); there is no per-window-kind arm.
- **D2 escape-hits-its-window.** Escape acts on the window that was key when pressed; if key moved before handling, the press is dropped, never redirected to a newer window.
- **D3 escape-never-waits.** A window with no Escape responder answers immediately; no press stalls on it.
- **D4 close-before-open.** The switcher opens on Escape only when no visible closable transient exists and the key window has nothing to close.
- **D5 escape-order.** Close the switcher, then pass through (`escapeMode: ignore`), then exit fullscreen, then defer to a renderer that consumed it, then close or hide the target, then open the switcher.
- **D6 blur-dismissal.** A painted transient (or a self-closing modal) that is not key is dismissed when a world-caused focus lands elsewhere, unless the focuser belongs to it, it is newer than the machine op that caused the focus, it is click-through, or it is an attached overlay.
- **D7 no-self-dismissal.** A window that just took key is never dismissed by the window it took key from reclaiming focus by machine cause.
- **D8 resign-sweep-after-resign.** No visible surface is dismissed while Peek is front; the resign sweep runs only after Peek has resigned and settled.
- **D9 content-ignores-escape.** Workspace, content and child-content windows do not close on Escape.

## Recorded failures and the rule that forbids each

| Failure (`window-manager.md` → "Open kernel defects", `window-manager-macos-signoff.md`) | Rule |
|---|---|
| Palette from another app is on screen but dead; typing and Escape go to the other app | G1, F6 |
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

Open against these rules at `dc3febab`: G1/F6 (raise masked while Peek inactive, `window-kernel-executor.ts planRaise`), G3/F7 (successor raise on hide is unconditional, `window-kernel.ts react`), D7 (post-paint sweep, open), the doubled `DismissWindow` per sweep (S3). Everything else in the table is fixed or not reproducing; G8, G11, G12 and F8 have not been checked by hand since 2026-08-21.
