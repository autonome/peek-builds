# macOS sign-off: the window-kernel branch

Branch `wip/window-kernel-executor`, on the `tangled` remote.

**Nothing on this branch has ever run on macOS.** It was written and measured entirely on Linux,
which structurally cannot observe focus, native fullscreen, Spaces, key-window behaviour or app
activation. A Linux-green result on any of those is not evidence, so this run is the only gate that
can settle them.

**The branch's history was rewritten and force-pushed on 2026-08-17.** A checkout made before that
date must be re-cloned, not pulled — every commit hash changed. Cite commits by subject, never by
hash.

## Setup

1. Clone fresh, or `git pull --ff-only` in an existing checkout of this branch. **A refusal means
   the branch forked — that is the intended alarm, not a problem to force past.** Code moves
   between machines only through `tangled`; work done on macOS must be committed and pushed
   immediately, or the next pull refuses.
2. `yarn workspace @peek/desktop build` — the full build, not the fast `tsc -p`. The fast path does
   not emit what a run needs.
3. If `yarn` is missing, `corepack enable`. A build step piped into `tail` swallows the exit code,
   so a build that never ran looks like a build that succeeded.

## The run

    PROFILE=<a profile of your own> PEEK_SHADOW_KERNEL_COMPARE=1 E2E_TEST=true yarn start

Once it's up, stage a known starting state instead of hand-arranging one:

    PEEK_PROFILE=<the same profile> node scripts/signoff-stage.mjs

It closes the startup settings window, opens two visually distinct pages (ALPHA/BRAVO, served
locally over `http://127.0.0.1:8777`) as page windows, and prints an inventory of what's open.
Leave it running — it keeps serving the two pages for the duration of the run.

Then drive the checks below by hand and, at the end, grep that profile's `logs/main.log` for
`[window-kernel-shadow] divergence`.

**A divergence is not automatically a bug.** Several rules on this branch changed behaviour
deliberately, and the comparator never compares window visibility at all. Report divergences as
observations with the gesture that produced them; do not treat them as a pass/fail gate.

## Traps that invalidate the run

- **Never add `DEBUG=1`.** It fans detached devtools across every internal window on restore and
  poisons any focus observation.
- **Never click the page first** to "make sure it's focused". That gesture is what fakes the thing
  under test — a click restores first-responder status by hand, which is exactly the defect class
  being checked. Bring a window forward with Cmd+Tab, the window switcher, or Mission Control, or
  let it be frontmost from launch. If a check seems to need a preparatory click, the check is
  being done wrong.
- **Activate the app before each gesture**, or no resign edge is produced at all:

      osascript -e 'tell application "System Events" to set frontmost of (first process whose unix id is <pid>) to true'

  Deactivate with `open -a Finder`, and allow the app-resign settle delay (500ms) before judging
  the result.
- `E2E_TEST=true` also suppresses the blur self-close for **every** modal window, and installs a
  hidden non-focusable fixture window that shows up as an extra row in any window inventory.
  Expect it; it is not a leak.
- **Live test pages must be visually distinct.** A restored profile can come back with a dozen
  identical pages. Use inline `data:` URLs with large unique labels.
- **The shared address bar is pointer-driven, not focus-driven.** `overlay.js` shows it on a
  `mousemove` hit-test against the top trigger zone and arms a 400ms hide timer once the pointer
  leaves it; keyboard focus inside the URL field is the only focus that matters otherwise. Any
  check about the address bar's visibility requires holding the pointer in the trigger zone across
  the gesture — parked anywhere else, it is always hidden regardless of what has keyboard focus.
- **A settings window opens on every boot** from `defaults.prefs.startupFeature`
  (`apps/desktop/renderer/config.js`), skipped only when a session snapshot exists. It must be
  closed before staging, or it sits in every inventory as an extra row. `scripts/signoff-stage.mjs`
  closes it explicitly rather than relying on an env lever: `PEEK_AUTOOPEN_EXT` (any value)
  suppresses both session restore and the startup-feature fallback in the same branch
  (`apps/desktop/main/entry.ts`), and a `PROFILE` starting with `test` makes `isTestProfile()` true
  and skips session restore (`main/config.ts`, `main/session.ts`) — but that one does NOT suppress
  the startup window, since `entry.ts` still publishes `session:open-startup` when nothing was
  restored. Both exist and are worth knowing about, but a deliberately malformed/repurposed env
  value is a side effect that could change out from under this doc; an explicit close is honest.

## What needs a human eye

No automated check can reach any of these. For each, record what happened, not whether it "passed".

1. **The overlay window follows the app.** This check is about the shared chrome overlay WINDOW
   (`hybrid-overlay.ts` `overlayWin`) and its re-pin/z-order decision, not about whether the navbar
   strip inside it happens to be visible — that part is pointer-driven (see the trap above) and is
   usually hidden regardless. Switch away from Peek with a page open — the overlay window must
   leave the screen with it. Switch back — it must return, and the question is whether it returns
   *in front of* the page or behind it. Behind means the re-pin decision is wrong. To actually see
   the navbar strip during this check, hold the pointer in the top trigger zone across the switch.
2. **The address bar survives losing its page.** Open a page so the bar appears, get to a state
   with no page frontmost, then open a page again. The bar must come back. It was previously
   destroyed on this path and returned only as a different window.
3. **Peeks and slides carry the shared address bar.** They are built with no navbar of their own
   specifically to use it.
4. **Cmd+W with a peek focused closes the peek**, not the page behind it.
5. **Escape on a fullscreen window leaves fullscreen**, and the window then closes normally.
6. **Maximize actually resizes**, and unmaximize returns to the previous bounds. This one was just
   fixed for windows that had never been moved or resized since being created — worth exercising on
   a freshly opened window specifically, before touching its geometry.
7. **Dismissing a slide or peek hands focus to something.** Something must take focus rather than
   nothing.
8. **Devtools on a page host does not drag an off-screen window on screen.** Open and close them.
9. **The HUD leaves with the app.** Switch away with it visible — it must go immediately rather
   than lingering over whatever was switched to.
10. **The window switcher on app-blur.** Open the switcher, then switch to another application.
    The switcher should go away, and the application switched to must keep focus. This path has no
    home in the new machine yet and nothing reproduces it, so its observed behaviour here is the
    reference.
11. **Raising a background window is clean, both ways.** With two page-hosts open and a peek in
    front of one of them: (a) click the chrome of the background page-host (its title area, not the
    page content) — it should come forward with no flicker of its own navbar or the peek's chrome,
    and no other window should end up taking focus instead. (b) Cmd+Tab back to the window sitting
    behind the peek — same expectation: it comes forward cleanly, the peek does not flash or
    reassert itself on top, and focus lands on the window you switched to, not back on the peek.
    This exercises the raise-is-a-reorder-not-a-show change (`electron-window-backend.ts
    raiseWindow`) — the failure mode it targets is a background window's chrome or an
    always-on-top overlay flickering show/hide while the two fight over which one the OS just
    focused.

12. **Focus after a peek or slide closes lands where it should, every time.** Close a peek or a
    slide (Escape, or Cmd+W) with at least one page-host open behind it, and repeat it several
    times in a row rather than once — the rule under test arms and disarms per close, so a single
    clean close proves little. Each time: the window that receives focus must highlight and accept
    keystrokes **immediately**, with no click needed to wake it, and the shared address bar must
    stay attached to the page host underneath rather than vanishing or reattaching to something
    else. Then do the same while a second application is frontmost — close the peek by clicking
    Peek's window first, so the close and the app-activation arrive close together.

    This is the single most macOS-sensitive rule on the branch
    (`electron-window-backend.ts pendingHideProvokedFocus`). It declines to report the first focus
    that arrives after a hide, on the reasoning that the platform reassigned focus as a side effect
    of the hide rather than the user choosing a window. That reasoning was derived on Linux, where
    the window manager does reassign focus on hide. **If macOS does not, the arming is instead
    consumed by a genuine user focus and that focus is silently dropped** — which surfaces exactly
    as a window that looks focused but ignores typing until clicked, or as the address bar
    detaching from a page that is plainly frontmost. Either observation is a real finding; report
    it with the gesture, not as flakiness.

    **Half of that prediction is already confirmed in-suite and fixed, so this check is now
    narrower than it was.** The arming was unconditional on every hide, including hides of windows
    nothing was focused on — which reassign nothing, so no provoked focus ever arrived to consume
    the arming and it sat armed until a genuine focus came along. Measured on macOS via the kernel
    transition timeline: hiding the unfocused chrome overlay during an overlay retarget armed it,
    and the next genuine focus on a page host was dropped with `cause=world`, leaving `key` on the
    wrong window and the session snapshot naming the wrong focused page. The arming is now gated on
    the hidden window actually holding focus. What this check still has to answer is the other
    half, which no headless suite can reach: when the FOCUSED window is hidden, does macOS reassign
    focus at all? If it does not, the arming still outlives its provocation and the next genuine
    focus is still swallowed — just far more rarely than before.

## What to report back

- Each numbered check, with what was observed.
- Any `[window-kernel-shadow] divergence` lines, with the gesture that produced them.
- macOS version and whether the machine has multiple displays or Spaces in use — several of the
  rules above are display- and Space-sensitive.

Commit and push anything changed on macOS immediately; a fork is only discovered on the next pull.
