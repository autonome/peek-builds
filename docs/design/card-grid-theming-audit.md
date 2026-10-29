# Card-grid windows and the shared theme system: audit (2026-10-27)

Read-only audit of `apps/desktop`, as input to a sprint that moves every card-grid window onto
shared pieces so that theme and window-mode changes reach it with no per-feature code.
"(inferred)" marks conclusions not proven by reading code or by a test. Paths are relative to
`apps/desktop`.

## How it works today

- **Theme.** Each stylesheet has to `@import url('peek://theme/variables.css')` itself
  (`main/protocol.ts` serves the active theme layered over peek). Two layers: the Base16 ramp
  `--base00..0F`, and `--theme-*` aliases declared on `:root` as `var(--baseNN)`. Live switching is
  the one fully shared piece: `main/tile-preload.cts` "Theme Live-Reload" re-injects a cache-busted
  link into every tile on `tile:theme:changed`. `renderer/components/theme.js` is a separate token
  registry that no tile uses.
- **See-through.** A manifest tile entry declares `seeThrough: true`; `main/see-through-support.ts`
  decides support; `main/tile-ipc.ts applySeeThroughToWindow` records `params.seeThrough` and
  publishes `window:see-through`. Each page subscribes to that topic itself (listed in its own
  manifest `pubsub.topics`), calls `getSeeThrough`, and toggles `body.see-through`.
  `renderer/lib/see-through.css` frosts the body and makes `--base00..03` translucent.
- **Card-view shell.** `renderer/lib/card-view.js mountCardView` (search box, `peek-grid`, ghost
  card, `setupSeeThrough`), `card-view.css`, `card-view-params.js cardViewWindowParams`,
  `ghost-card.js`. Only the Sheets list uses it.

## Per window

| Window | Grid | Theme | See-through |
|---|---|---|---|
| Sheets list (`features/sheets/home.js`) | card-view shell | via `card-view.css`; follows live | declared; cards stay opaque (A) |
| Sheet window (`features/sheets/sheet.js`) | `peek-grid` freeform | own `sheet.css`; 8 literal colors | own `applySeeThrough` copy and ink block |
| Spaces, Groups (`features/{spaces,groups}/home.js`) | `peek-grid` | own css; 8 / 5 literal colors | own copy and ink block; cards opaque (A) |
| Search (`features/search/home.js`) | `peek-grid` + `lib/search-result-card.js` | 5 literal colors | own copy and ink block |
| Entities (`features/entities/home.js`) | `peek-grid` | 5 literal colors | own copy and ink block |
| Tags (`features/tags/home.js`) | `peek-grid` virtual | no literals | toggles, but no ink block: dark text on frost (inferred) |
| Research (`features/research/home.js`) | hand-rolled + `peek-card` | no literals | no ink block; cards opaque |
| Bake-off labeling (`features/bake-off-labeling/home.js`) | `peek-grid` | **no theme import**; 24 literal colors | overrides `--theme-*` on body: the only view where cards really frost |
| Windows switcher (`features/windows/windows.js`) | `peek-grid` | own permanent frost, duplicating `see-through.css` | n/a |
| Settings (`renderer/settings/settings.js`) | `peek-card` and the shared `peek-*` controls; no inline styles | `settings.css` classes over theme tokens, with its own `--bg-*`/`--text-*` aliases; follows live | cannot be declared: pseudo-tile `peek://app/...` has no manifest entry (C); opaque body; not opened transparent |
| Timers, Lists, Pagestream, Features manager | mixed, hand-rolled | own css, own `.card-*` copies | not declared; Pagestream is always transparent in its own way |

Not examined: hud, gallery, widget-demo, cmd panel, new-tab, page-error, `renderer/page` chrome,
and wonderwall, lex, dropzone, hello-world, translate/models, tag-actions, composer, scripts,
editor beyond a skim.

## Findings

- **A. Components ignore see-through (inferred, the main blocker).** `peek-card`, `peek-input`,
  `peek-button`, `peek-grid-toolbar` read `--theme-*`. Those resolve on `:root` from the opaque
  `--base*`, so redefining `--base01` on `body.see-through` never reaches them. Only surfaces
  painted from `--base*` directly frost. `peek-card`'s `glass` property exists but nothing sets it.
- **B. The see-through client is copied** into eight features (`applySeeThrough`) plus the shell
  (`setupSeeThrough`), each needing its own manifest topic entry; forgetting either fails silently.
- **C. Pseudo-tile pages** (settings, cmd, diagnostics) are outside the manifest declaration.
- **D. Ink overrides are copy-pasted** per feature because `see-through.css` flips the surface
  ramp but not the text ramp.
- **E. Card CSS** (`.card-title`, `.card-meta`, `.card-delete-btn`, ...) is defined in eight
  feature stylesheets plus `card-view.css`.
- **F. Literal colors** in feature CSS (counts above).
- **G. Theme import is not guaranteed** at load; the preload only injects after a change.
- **H. The frost exists twice** (`windows.css`, `see-through.css`).
- **I. Window open params are hand-written** per feature; only the shell has a shared helper.
- **J. Keyboard grid navigation** (`renderer/lib/grid-nav.js`) and the toolbar are opt-in per
  feature; the shell offers neither.
- **K. Empty state** is built per page; `peek-grid` renders one only in virtual mode.
- **L. Themes exist twice**: `themes/<id>` and `features/theme-*`.

## What "built on the system" means

1. The theme reaches every tile document at load, not by per-stylesheet import.
2. One window-mode client, applied by the preload for any window (as the theme live-reload is),
   setting a document-level mode class; no per-feature subscribe and no manifest topic entry.
3. Modes override the `--theme-*` aliases (or components read the ramp directly), so shadow-DOM
   components follow with no per-page CSS; the shared mode sheet carries the ink overrides.
4. Pages own no literal colors and no card CSS: surfaces and controls are components, page
   layout comes from the shared card-view sheet.
5. The shell grows to cover what features hand-assemble today: toolbar, keyboard navigation,
   empty state, ghost card, freeform and virtual grids, detail views; features then mount it.
6. Pseudo-tile pages get real manifest entries or are covered by the same lookup.
