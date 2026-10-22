---
enabled: true
touches: [apps/desktop/features/tags/, apps/desktop/renderer/lib/see-through.css, apps/desktop/features/windows/background.js, apps/desktop/features/windows/manifest.json, apps/desktop/main/tile-ipc.ts, apps/desktop/main/tile-preload.cts, apps/desktop/main/tile-api.d.ts, apps/desktop/main/tile-window-enforcement.ts, apps/desktop/main/see-through-support.ts, apps/desktop/main/see-through-support.test.ts, apps/desktop/main/ipc.ts, apps/desktop/main/session-projection.ts, apps/desktop/main/session-projection.test.ts, packages/capabilities/index.d.ts, apps/desktop/tests/desktop/card-view-see-through.spec.ts, docs/tile-api.md, docs/design/window-rules.md]
depends-on: []
---

**Scope: Tags only.** This track builds this spec and nothing else; every other card-grid view
and the app-wide switch are separate later specs. The worktree may hold uncommitted Tags work
from an earlier, stopped build: review it, keep what fits this spec, and commit.
`specs/maximize-all.md` builds in parallel and touches some of the same files
(`main/tile-ipc.ts`, `main/tile-preload.cts`, `features/windows/`, `docs/design/window-rules.md`);
keep additions there self-contained so the two branches merge cleanly.

# See-through card views: a per-window switch, Tags first

Peek items `d5db359b` (its "Implementation plan (draft 2026-05-25)" is the starting point),
`a6dfd7fb`, `d424e67c`. Second of two app-wide window-mode features, after `specs/maximize-all.md`.
A card-grid view gets the windows switcher's look on demand: the window fills the screen and its
background turns frosted and see-through, so the windows behind show through. The research view
(`docs/design/search-rounds.md` "Surfaces") later opens with this switch on; it is not part of
this slice, nor is Peek-wide fullscreen (`bb73035e`).

Decisions:

- **A switch per window, not a property of the view.** Any card-grid view can be flipped
  between its normal look and see-through. A view that should open see-through later defaults
  the switch on; `d424e67c`'s manifest-declared "immersive grid" is not built.
- **First slice: Tags only** (`features/tags/home.*`). Groups, search, spaces and entities follow
  in later slices after the same audit.
- **On** maximizes the window through the kernel's `Maximize` and applies the see-through
  styling; **off** removes the styling and unmaximizes, returning the window to its exact earlier
  bounds — but only when the switch did the maximizing. A window already maximized when the
  switch went on (by hand or by maximize-all) stays maximized when it goes off.
- **Styling only, one shared stylesheet**: a class on `<body>` gated by a new
  `renderer/lib/see-through.css`, with the frosted background the windows switcher uses today
  (`features/windows/windows.css` `body`). The Windows feature itself is not changed.
- **The window is always created transparent**, because transparency can only be set when a
  window is created; the normal look is the opaque body background drawn in CSS. Tags'
  `openTags()` (`features/tags/background.js`) passes `transparent: true`.
- **Not on top, not an overlay**: the switch does not set `alwaysOnTop`, `role: 'overlay'` or
  hide other windows; that remains the windows switcher's own behaviour.
- **Remembered across a restart**: the switch state is a window param (`params.seeThrough`), kept
  current in main when it changes and written by session save, so a restored Tags window comes
  back see-through (and maximized, per `docs/design/window-rules.md` G12). Not stored in
  `localStorage`.
- **Trigger**: a command `see-through view` in the Windows feature that toggles the focused
  window (declared in `features/windows/manifest.json`), reaching main through a new tile API
  `api.window.setSeeThrough(id, on)` (capability `manage`, `main/tile-ipc.ts`), documented in
  `docs/tile-api.md`. Main tells the window's renderer through a pubsub topic the Tags manifest
  lists in its own `pubsub.topics`. A window whose view does not support the switch answers
  `{ success: false, error }` and nothing changes. No chrome button and no shortcut in this slice.
- hjkl navigation in the Tags grid keeps working in both looks (`renderer/lib/grid-nav.js`); the
  switch does not change the grid's view mode.

## Rule to add

Add a rule to `docs/design/window-rules.md` beside the maximize-all rule stating the switch's
maximize and restore behaviour and that it never puts a window on top, with a failure-table row.

## Tests to change

- `main/session-projection.test.ts`: `params.seeThrough` survives save and restore.
- New `tests/desktop/card-view-see-through.spec.ts` on a test profile: open Tags at known bounds;
  run `see-through view`; the window is maximized and the body carries the see-through class with
  a non-opaque background; hjkl moves the card selection; run it again; the class is gone and the
  window is back at its exact bounds. Second case: maximize Tags by hand first, toggle on and off,
  and it is still maximized. Third: the command on a non-card window (a page) reports failure and
  changes nothing.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "card-view-see-through|maximize-all|tags"
```

Done when the unit tallies report `fail 0`, the new tests pass, and the other collected specs show
no new failure compared with `apps/desktop/tests/gate-baseline.md`. Record the `test:grep`
pass/fail count under `**Result**` in the handoff. Unverified by this run: how the frosted
background looks over real windows and its drawing cost, which need a look on the laptop before
landing.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app; read it before editing, especially the
`<peek-*>` component rules and "Electron is ONE backend". Run one command per Bash call.
