---
enabled: true
touches: [apps/desktop/features/spaces/**, apps/desktop/main/session.ts, apps/desktop/tests/desktop/workspace-panel.spec.ts, apps/desktop/tests/desktop/space-workspace-page-host.spec.ts, apps/desktop/tests/desktop/workspace-round-trip-fidelity.spec.ts, docs/design/window-rules.md]
depends-on: []
---

# Spaces: default space, click/Enter activation, repeat switch, and panel theming

Peek item `9ed6263f` carries the original manual-testing report; peek item `941d8a8e` is the
unrelated `device-settings.spec.ts` gate failure found the same session — not part of this spec.
Read both with `mcp__peek__get_item` if that tool is available; this file carries everything
needed if it is not.

## Problem

`specs/workspace-session-snapshot.md` describes routing the Spaces feature's save/restore
through the app's session-snapshot pipeline instead of a hand-rolled per-space reopen loop.
That migration is **already substantially on `main`**
(`apps/desktop/features/spaces/background.js` calls `restoreSessionSnapshot()` /
`saveSessionSnapshot()`, not `saveSpaceWorkspaces()`/`serializeSpaceWorkspaces()`) even though
`spec-status.mjs` still reports that spec `unstarted` — the work landed through direct commits
(`1e5b795e`, `058216ab`, `11cfd7cd`) rather than the tracked spec-watch flow, so the tracker has
no record of it. A future spec-watch tick may try to start `workspace-session-snapshot` as new
work against code that already mostly satisfies it; whoever picks this spec up should check
`specs/workspace-session-snapshot.md`'s current state before assuming it still needs a track.

With that migration landed, manual testing (`yarn start`, dev profile) found four live defects,
each traced to a specific cause:

1. **Default space doesn't show until the user switches spaces once.**
   `background.js bootstrapDefaultSpace()` (creates the `space:default` tag via
   `getOrCreateTag()`) runs only inside the background tile's `init()`, which only fires when
   the tile — declared `"lazy": true` in `apps/desktop/features/spaces/manifest.json`, with no
   `lazyEvents` — is woken by an `action.type: "execute"` command. The manifest's `open spaces`
   command (browse-all) is `action.type: "window"`, opening `home.html` directly and bypassing
   `cmd:execute:*` entirely, so opening the Spaces UI never wakes the tile. `home.js
   loadSpaces()`'s `liveQuery` finds no default tag until some *other* command (`open space` /
   `switch space <name>`) wakes the tile and `bootstrapDefaultSpace()` runs.

2. **Click or Enter on a space in the UI doesn't activate it.**
   `home.js createSpaceCard()`'s click handler calls `showItems(space)` — it browses the space's
   items, the same thing `grid-nav.js activateSelected()`'s default Enter handling does by
   `.click()`-ing the same card. Neither publishes `cmd:execute:open space` or calls
   `openSpace()`/`switchSpace()`. The UI's click/Enter path and the command path that actually
   switches spaces share no code.

3. **The `switch space <name>` command only works the first time in a session.**
   Not yet root-caused. No single-shot guard was found in `openSpace()`/`switchSpace()`, the
   `beginWorkspaceSwitch`/`setActiveWorkspace` bracket, or `session.ts`'s restore-in-flight
   flag — all appear correctly paired with try/finally on static reading. This needs a live
   trace (`repro-first-then-fix` / `peek-fs-diag-bridge` skills), not more static reading.

4. **The workspace panel (the small bottom-right corner UI) only appeared once, and wasn't
   themed to the active space.** Its real name is "the workspace panel" —
   `background.js showPanel()`/`hidePanel()`, manifest tile id `panel`, role `panel`, also named
   in `docs/design/window-rules.md`. It's a 260×112 globally-pinned window meant to persist
   across a workspace switch and update in place rather than close/reopen — so "only appeared
   once" may partly be correct persist behavior misread as a bug; confirm intended semantics
   with a live check before assuming otherwise. The missing theming is a confirmed design gap,
   not a timing bug: `showPanel()` builds `panel.html?spaceName=…` with no color parameter, the
   `spaces:panel-update` message sends only `{spaceName}`, and neither `panel.js` nor
   `panel.css` reads a color anywhere — there is no theming hook to wire up, only one to add.
   `DESIGN.md` predates the panel and only describes an unrelated full-screen "screen border"
   (§6: shows on space focus, hides on a 600ms debounce, colored from the space tag) — don't
   confuse the two when reading it.

## Requirements

1. Opening the Spaces UI (`open spaces`) shows the default space immediately, with no prior
   switch required. Either `bootstrapDefaultSpace()` runs independent of the lazy tile's
   `execute`-command wake path, or `open spaces` wakes the tile too (e.g. by declaring it
   `lazyEvents` or switching its `action.type`) — pick whichever keeps the "no platform/backend
   leak above the port" and lazy-tile init-ordering rules in `apps/desktop/CLAUDE.md` intact, and
   record the choice.
2. Clicking, or pressing Enter on, a space card in the Spaces UI activates that space — the same
   effect as running `switch space <name>` for it — in addition to (not instead of) browsing its
   items if that's still wanted. `createSpaceCard()`'s click handler and `switchSpace()`/
   `openSpace()` converge on one call, not two parallel paths.
3. `switch space <name>` works on the second, third, and Nth invocation in a session, not just
   the first. Root-caused via a live trace before being fixed — see the Problem section.
4. The workspace panel reflects the active space's color/theme whenever it's shown, including on
   a later switch after the first. Confirm by hand whether the panel is meant to update in place
   or reopen per switch; whichever it is, the color updates every time the active space changes,
   themed correctly (not just present).
5. `apps/desktop/tests/desktop/workspace-panel.spec.ts` and
   `apps/desktop/tests/desktop/space-workspace-page-host.spec.ts` (already in the suite, both
   affected by this area) and `workspace-round-trip-fidelity.spec.ts` (already covers session
   round-trip fidelity, not spaces-specific activation) are extended or joined by new specs
   covering: default space visible on first `open spaces`, click/Enter activation, at least two
   consecutive `switch space` invocations, and panel color on a second switch.

## Verify

```
yarn workspace @peek/desktop test:grep "spaces"
yarn workspace @peek/desktop test:grep "workspace-panel"
```

Also confirm by hand against a dev profile (`yarn start`), the way these were found — the full
gate has already shown green specs alongside real UI breakage in this repo this same session
(peek `941d8a8e`, `device-settings.spec.ts`), so passing specs alone are not sufficient
evidence here. Walk through, in one session: open Spaces UI fresh (symptom 1), click a space
card and press Enter on another (symptom 2), run `switch space <name>` twice for two different
spaces (symptom 3), and check the workspace panel's color after each switch (symptom 4).

Done when all four symptoms are gone by hand and the extended/new specs in requirement 5 pass.

## Working rules

- `apps/desktop/CLAUDE.md` governs the desktop app, especially "Lazy feature activation" and the
  hybrid page-host focus/input invariants if the panel or space-switch work touches window
  focus. Read it before editing.
- Run one command per Bash call; use the `yarn` scripts, never `npx playwright` directly.
- Nothing here deploys or touches a real profile. Tests run under the `PEEK_PROFILE` the
  namespace sets.
