---
enabled: true
touches: [apps/desktop/features/windows/background.js, apps/desktop/features/windows/manifest.json, apps/desktop/main/tile-ipc.ts, apps/desktop/main/tile-preload.cts, apps/desktop/main/tile-api.d.ts, apps/desktop/main/ipc.ts, apps/desktop/main/see-through-support.ts, apps/desktop/main/see-through-support.test.ts, packages/capabilities/index.d.ts, apps/desktop/tests/desktop/card-view-see-through-everywhere.spec.ts, docs/tile-api.md, docs/design/window-rules.md]
depends-on: [card-view-see-through]
---

# See-through everywhere: one app-wide switch

Follows `specs/card-view-see-through.md`, which built the per-window see-through switch for Tags.
This slice adds one app-wide switch that turns the see-through look on or off for every view
whose manifest declares `seeThrough: true`. Bringing each other card view onto the switch is its
own spec (`specs/see-through-<feature>.md`); this one works with whichever views declare it, and
is tested with Tags alone.

Decisions:

- **The app-wide switch** is a command `see-through views everywhere` in the Windows feature that
  toggles one stored app setting. Turning it on flips every open declaring window to see-through
  and makes every declaring window opened afterwards open see-through; turning it off flips them
  all back. Each window follows the per-window rules of `specs/card-view-see-through.md`
  (maximized on, exact restore off, a window already maximized stays maximized).
- **Per-window switch still works under it**: `see-through view` on one window overrides the
  app-wide setting for that window only, until the app-wide switch is next flipped, which resets
  every declaring window to the app-wide state.
- **Remembered across a restart**: the app-wide setting is stored with the app's other settings
  (not `localStorage`); each window's own state is still restored from session params.
- No hard-coded list of views: "which windows" is the manifest declaration, read through
  `main/see-through-support.ts`.

## Rule to add

Extend the see-through rule in `docs/design/window-rules.md` with the app-wide switch and how it
combines with the per-window one.

## Tests to change

New `tests/desktop/card-view-see-through-everywhere.spec.ts` on a test profile: open two Tags
windows; run `see-through views everywhere`; both are see-through and maximized; run
`see-through view` on one, which goes back to normal while the other stays; run the app-wide
command again; both are normal and back at their earlier bounds. A second case relaunches with
the app-wide switch on and checks a newly opened Tags window opens see-through.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "see-through|tags"
```

Done when the unit tallies report `fail 0`, the new tests pass, and the other collected specs show
no new failure compared with `apps/desktop/tests/gate-baseline.md`. Record the `test:grep`
pass/fail count under `**Result**` in the handoff. Unverified by this run: the drawing cost of
several frosted windows at once, which needs a look on the laptop before landing.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app; read it before editing, especially the
`<peek-*>` component rules and "Electron is ONE backend". Run one command per Bash call.
