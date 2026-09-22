---
enabled: true
touches: [apps/desktop/features/spaces/**, apps/desktop/main/ipc.ts, apps/desktop/main/tile-ipc.ts, apps/desktop/main/session.ts, apps/desktop/tests/desktop/*.spec.ts, docs/design/window-rules.md, docs/design/window-manager.md]
depends-on: []
---

# Spaces: windows not locked to their space, panel Close no-op, inconsistent border color

Peek item `4e2cd795`. Read it with `mcp__peek__get_item` (`itemId: "4e2cd795"`, `maxContentLength: -1`) if
that tool is available; this file carries everything needed if it is not.

## Problem

Found by hand on `main` at `110e3c1f`, testing right after two prior tracks landed on the Spaces
feature: `spec-spaces-workspace-switch-regressions` (default-space visibility, click/Enter
activation, repeat `switch space`, corner-panel theming — `specs/spaces-workspace-switch-regressions.md`)
and a follow-up fix for the corner panel's "Switch to..." dropdown (duplicate entry + border accent,
commit `110e3c1f`).

1. **The corner workspace panel's "Close" button does nothing.**
   `apps/desktop/features/spaces/panel.html`'s `<peek-button class="panel-close">Close</peek-button>`
   is wired in `panel.js closeEl()`'s click listener to publish `cmd:execute:close space`, which
   `apps/desktop/features/spaces/background.js closeSpace()` subscribes to — its intent is to save
   and close the current space's windows and return to the default space. The wiring reads correct
   end to end, and `peek-button` renders a real `<button>` in shadow DOM whose click composes/bubbles
   normally. The one known no-op case is `closeSpace()` returning early when
   `activeSpaceId === defaultSpaceId` — but the repro was against a non-default active space, so that
   guard shouldn't be firing. **Not root-caused** — the static wiring gives no reason for the no-op;
   needs a live trace (`repro-first-then-fix` / `peek-fs-diag-bridge` skills), not more static reading.

2. **Windows aren't isolated per space.** Opening an editor or page in each of several spaces leaves
   windows from other spaces visible after switching — reported as "always two of three open."
   The per-space sweep itself is generic and correct: `background.js closeCurrentWorkspaceWindows()`
   and `apps/desktop/main/tile-ipc.ts`'s `tile:context:windows-in-space` handler match any window
   tagged `mode=space` with the active `spaceId`, not a hardcoded space. The gap is upstream, in how a
   window gets that tag in the first place: `apps/desktop/main/ipc.ts` (its mode-inheritance logic,
   roughly lines 3643-3704) only tags a newly-opened window `mode=space`+`spaceId` when an explicit
   `spaceMode` option is passed at open time, or when the opener has direct space-mode lineage via
   `windowFromWebContents`. A window opened any other way while a space is active — from the command
   palette, for instance — falls through to `detectModeFromUrl`, lands on `page`/`default`, gets no
   `spaceId`, and is therefore invisible to the sweep on every later switch: it neither closes nor
   hides. `apps/desktop/features/spaces/home.js` (`onOpen`/`onClick`, roughly lines 769-806) does set
   `spaceMode` correctly for a page opened by clicking it from inside that space's own item view — the
   gap is every other way a window can open while a space is active.

3. **Inconsistent accent/border color across non-default spaces.** One non-default space's windows and
   border show the resolved vivid accent color; another non-default space's don't, and neither is the
   default space. `apps/desktop/features/spaces/config.js resolveVividColor(color, spaceId)` computes a
   deterministic vivid fallback whenever a tag's stored color is missing, grey, or low-chroma.
   `background.js openSpace()` (roughly lines 565-570) resolves that color and *persists* it onto the
   space's tag — but only when the space is actually entered through `open`/`switch space`. `home.js`
   (roughly lines 779 and 803), when tagging a newly-opened window's `spaceMode`, independently reads
   `state.currentSpace.color || '#999'` — the tag's raw stored color, with no vivid resolution at all.
   A space tag that exists but has never been entered via `openSpace()` before a window is opened in it
   keeps its raw/default color, so neither that window nor (per the border-rendering path,
   `background.js showBorder()`/its color resolution) the border ever gets the resolved accent. Same
   upstream gap as symptom 2: color propagation and window tagging both depend on the same
   `openSpace()` entry path, which isn't the only way a space ends up with windows in it.

4. **Multiple copies of the Spaces browse-all page end up open, and one seems to never close** —
   reported as "all windows should be space-locked." One confirmed instance of this is already filed in
   `docs/design/window-manager.md`'s "Open kernel defects" ("Returning to the default space duplicates
   the browse-all Spaces window") — the browse-all window, opened via the manifest's `open spaces`
   command (`action.type: "window"`), carries no `spaceMode` and so is invisible to the same sweep as
   symptom 2, surviving every switch. But the request here is broader than that one entry: no general
   invariant exists anywhere in `docs/design/window-rules.md`, `apps/desktop/main/session.ts`, or
   `apps/desktop/main/window-open-registry.ts` stating that every window belongs to exactly one space
   and is hidden or closed when that space isn't active. Enforcement today is piecemeal, entirely
   dependent on whether `spaceMode`/mode-context happened to be set at open time — the same root cause
   as symptom 2.

**Symptoms 2, 3, and 4 share one upstream cause**: a window is locked to its opening space — tagged
`mode=space`+`spaceId`, and colored from the resolved vivid accent — only when it's opened through a
code path that explicitly passes `spaceMode` or has direct space-mode opener lineage. Any other way a
window opens while a space is active (command palette, the browse-all page's own commands, anything
else) produces an untagged, un-locked window that survives every switch and never resolves a color.
Fixing that one upstream gap — making every window opened while a space is active inherit that space's
lock, not just windows opened from inside the space's own item view — likely resolves 2, 3, and 4
together. Symptom 1 is unrelated and needs its own live trace.

## Requirements

1. The corner panel's Close button visibly does something — closes the current space's windows and
   returns to default, per `closeSpace()`'s existing intent — every time it's clicked while a
   non-default space is active. Root-cause the no-op via a live trace before fixing; don't guess at a
   fix without first confirming what's actually happening at runtime.
2. Every window opened while a space is active is locked to that space — tagged `mode=space` and the
   active `spaceId` at open time, regardless of how it was opened (command palette, a link click, any
   other route) — and is hidden or closed by the per-space sweep on every subsequent switch away from
   that space. State the mechanism chosen (tagging universally at open time vs. some other
   interception point) and why, given the invariant this establishes: every window belongs to exactly
   one space while a space is active.
3. Every non-default space's windows and border consistently show that space's resolved vivid accent
   color, whether or not the space was ever entered through `open`/`switch space` before a window was
   opened in it — color resolution must not depend on entry order.
4. No duplicate copies of the Spaces browse-all page accumulate across space switches. If requirement
   2's invariant is implemented generally, this should resolve as a direct consequence rather than
   needing its own special case — confirm by hand that it does before treating it as separately done.
5. `apps/desktop/tests/desktop/spaces-ui-activation.spec.ts` and `workspace-panel.spec.ts` (both
   extended by the two prior tracks) are extended, or joined by new specs, covering: the Close button's
   actual behavior, a window opened via the command palette while a space is active being swept on
   switch away, accent color on a space entered for the first time by opening a window in it (not by
   switching to it first), and no duplicate browse-all window across repeated switches.

## Verify

```
yarn workspace @peek/desktop test:grep "spaces"
yarn workspace @peek/desktop test:grep "workspace-panel"
```

Also confirm by hand against a dev profile (`yarn start`) — passing specs alone aren't sufficient
evidence in this repo (peek `941d8a8e` showed green specs alongside real UI breakage the same session).
Walk through, in one session: open three spaces and put a page in each via at least two different
routes (command palette, clicking from inside the space's own item view); switch between all three and
confirm no cross-space windows remain visible; check border/accent color on a space entered for the
first time by opening a window in it rather than switching to it first; click the panel's Close button
while a non-default space is active and confirm it closes that space's windows and returns to default;
return to default repeatedly and confirm only one browse-all window ever exists.

Done when all four symptoms are gone by hand and the extended/new specs in requirement 5 pass.

## Working rules

- `apps/desktop/CLAUDE.md` governs the desktop app, especially "Lazy feature activation" and the
  hybrid page-host focus/input invariants if window-open or tagging logic is touched.
- Run one command per Bash call; use the `yarn` scripts, never `npx playwright` directly.
- Symptom 1 needs a live trace before a fix — the static wiring reads correct, so guessing at a
  cause without runtime evidence risks fixing the wrong thing.
- Symptoms 2, 3, and 4 share a root cause but are still separate requirements — verify and commit
  each as it's satisfied rather than landing one large combined change, the same pattern the previous
  track used for its four symptoms.
- Nothing here deploys or touches a real profile. Tests run under the `PEEK_PROFILE` the namespace
  sets.
