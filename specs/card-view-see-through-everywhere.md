---
enabled: true
touches: [apps/desktop/features/groups/, apps/desktop/features/spaces/, apps/desktop/features/search/, apps/desktop/features/entities/, apps/desktop/features/sheets/, apps/desktop/features/bake-off-labeling/, apps/desktop/features/windows/background.js, apps/desktop/features/windows/manifest.json, apps/desktop/renderer/lib/see-through.css, apps/desktop/main/tile-ipc.ts, apps/desktop/main/tile-preload.cts, apps/desktop/main/ipc.ts, apps/desktop/tests/desktop/card-view-see-through-everywhere.spec.ts, docs/tile-api.md, docs/design/window-rules.md]
depends-on: [card-view-see-through]
---

# See-through card views everywhere: every card-grid view, plus an app-wide switch

Follows `specs/card-view-see-through.md`, which built the per-window switch for Tags. This slice
brings every other card-grid view onto that switch and adds one app-wide switch that turns the
see-through look on or off for all of them at once.

Decisions:

- **Every view built on the card grid** (`<peek-grid-toolbar>` / `<peek-grid>`) supports the
  per-window switch: Groups, Spaces, Search, Entities, Sheets and bake-off labeling, in addition
  to Tags. Each is created transparent and draws its normal opaque look in CSS, uses
  `renderer/lib/see-through.css`, and lists the switch's pubsub topic in its own manifest. Each
  view's background, card and text colours are checked for legibility over the frosted
  background. The Windows switcher is unchanged.
- **The app-wide switch** is a command `see-through views everywhere` that toggles one stored
  app setting. Turning it on flips every open card-grid window to see-through and makes every
  card-grid window opened afterwards open see-through; turning it off flips them all back. Each
  window follows the per-window rules of `specs/card-view-see-through.md` (maximized on, exact
  restore off, a window already maximized stays maximized).
- **Per-window switch still works under it**: `see-through view` on one window overrides the
  app-wide setting for that window only, until the app-wide switch is next flipped, which
  resets every card-grid window to the app-wide state.
- **Remembered across a restart**: the app-wide setting is stored with the app's other settings
  (not `localStorage`), and each window's own state is still restored from session params.
- One source of truth for "is this a card-grid view": a declaration in each feature's manifest
  (for example `seeThrough: true` on its window entry), read by main; no hard-coded list of URLs.

## Rule to add

Extend the see-through rule in `docs/design/window-rules.md` with the app-wide switch and how it
combines with the per-window one.

## Tests to change

New `tests/desktop/card-view-see-through-everywhere.spec.ts` on a test profile: open Groups and
Search; run `see-through views everywhere`; both are see-through and maximized; open Tags, which
opens see-through; run `see-through view` on Search, which goes back to normal while the others
stay; run the app-wide command again; all three are normal and back at their earlier bounds. A
second case relaunches with the app-wide switch on and checks a newly opened card view opens
see-through. Each newly converted view's existing specs still pass.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "see-through|groups|spaces|search|entities|sheets|tags"
```

Done when the unit tallies report `fail 0`, the new tests pass, and the other collected specs show
no new failure compared with `apps/desktop/tests/gate-baseline.md`. Record the `test:grep`
pass/fail count under `**Result**` in the handoff. Unverified by this run: legibility of each view
over real windows and the drawing cost of several frosted windows at once, which need a look on
the laptop before landing.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app; read it before editing, especially the
`<peek-*>` component rules and "Electron is ONE backend". Run one command per Bash call.
