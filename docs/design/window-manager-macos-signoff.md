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

## What needs a human eye

No automated check can reach any of these. For each, record what happened, not whether it "passed".

1. **The address bar follows the app.** Switch away from Peek with a page open — the address-bar
   strip must leave the screen with it. Switch back — it must return, and the question is whether
   it returns *in front of* the page or behind it. Behind means the re-pin decision is wrong.
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

## What to report back

- Each numbered check, with what was observed.
- Any `[window-kernel-shadow] divergence` lines, with the gesture that produced them.
- macOS version and whether the machine has multiple displays or Spaces in use — several of the
  rules above are display- and Space-sensitive.

Commit and push anything changed on macOS immediately; a fork is only discovered on the next pull.
