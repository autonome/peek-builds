---
enabled: true
touches: [apps/desktop/features/bake-off-labeling/, apps/desktop/tests/desktop/see-through-bake-off-labeling.spec.ts]
depends-on: [card-view-see-through]
---

# See-through switch for the Bake-off labeling view

Follows `specs/card-view-see-through.md`, which built the per-window see-through switch for Tags.
This slice brings the Bake-off labeling card view (`features/bake-off-labeling/home.html`) onto the same switch and changes
nothing else: no other view, no main-process change, no change to the shared stylesheet.

Decisions:

- **Opt in the way Tags did**: declare `seeThrough: true` on the `home.html` window entry in
  `features/bake-off-labeling/manifest.json`; `main/see-through-support.ts` reads the declaration, so main
  needs no edit.
- **Created transparent, normal look in CSS**: the code that opens the window passes
  `transparent: true`, and the view draws its opaque background in its own CSS so the normal look
  is unchanged.
- **Uses `renderer/lib/see-through.css`** and listens on the switch's pubsub topic, listed in this
  feature's own manifest `pubsub.topics`, exactly as `features/tags/` does.
- **Legible over the frosted background**: the view's own background, card and text colours are
  checked in the see-through look; adjust them in this feature's CSS only.
- Keyboard navigation in the view keeps working in both looks.

## Tests to change

New `tests/desktop/see-through-bake-off-labeling.spec.ts` on a test profile: open the Bake-off labeling view at known
bounds; run `see-through view`; the window is maximized and the body carries the see-through
class; run it again; the class is gone and the window is back at its exact bounds. The view's
existing specs still pass.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "see-through|bake-off-labeling"
```

Done when the unit tallies report `fail 0`, the new test passes, and the other collected specs
show no new failure compared with `apps/desktop/tests/gate-baseline.md`. Record the `test:grep`
pass/fail count under `**Result**` in the handoff. Unverified by this run: legibility over real
windows, which needs a look on the laptop before landing.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app; read it before editing, especially the
`<peek-*>` component rules and that a consumer tile lists each pubsub topic it subscribes to in
its own manifest. Run one command per Bash call.
