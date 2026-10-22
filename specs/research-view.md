---
enabled: true
touches: [apps/desktop/features/research/, apps/desktop/tests/desktop/research-view.spec.ts, apps/desktop/tests/unit/research-view-rank.test.js]
depends-on: [card-view-see-through]
---

# The research view, first slice: the space's pages, ranked, view only

Peek item `df3ffc86`, slice "The research view" of `docs/design/search-rounds.md` ("The open set",
"Surfaces" item 2). A research is a space (`space:<name>` tag). This slice opens one maximized,
see-through window listing the space's pages ranked by time on page. Searches and notes
(`specs/research-view-searches-notes.md`) and the Enter and click actions
(`specs/research-view-actions.md`) are later slices.

Decisions:

- **It looks like the Lists view, not like an editor.** Compact rows, one per page, in the style
  of the `lists` feature (`features/lists/home.js`, rows from
  `renderer/lib/search-result-card.js createSearchResultCard()`), moved through with the arrow
  keys and hjkl (`renderer/lib/grid-nav.js`). No document surface, no text cursor, nothing
  editable in this slice.
- **Data comes from the tag-query document's live query, not its rendering.** The view resolves
  and follows `space:<name>` with `features/editor/query-live.js resolveTagQuery()` /
  `startQueryLive()`, so a page joining the space appears without reopening the view.
- **Pages only**: URL items in the space, ranked by total time on page (sum of
  `item_visits.duration` over the item's visits, via `api.datastore.queryItemVisits()`), then by
  visit count. Each row shows title, host, time spent and visit count. A page open in a window is
  marked as open. Ranking is a pure function, unit-tested.
- **Which research**: the space of the front content window
  (`api.window.getFocusedVisibleWindowId()` and its space mode, as
  `features/websearch/search-rounds.js` finds it). With no space, the command reports
  "not in a research space" and opens nothing.
- **Opening**: a command `research view` in `features/research/`. Its window entry declares
  `seeThrough: true` and it opens with the see-through switch on (`params.seeThrough`), so it is
  maximized and frosted; `see-through view` turns it to the normal look. One research view per
  space (window `key` `research-view:<space>`), reused if already open. Escape closes it.
- Time on page is the only ranking signal; scroll, copy and input signals are set aside
  (`docs/design/search-rounds.md` "Set aside"), and the keep/drop judgement in
  `features/research/background.js` is not extended or shown.

## Tests to change

- New `tests/unit/research-view-rank.test.js`: ranking by summed duration, ties broken by visit
  count.
- New `tests/desktop/research-view.spec.ts` on a test profile: create a space with three pages
  (one left open, visit durations written directly so the order is known); open a page window in
  that space and run `research view`. The window is maximized and see-through; pages appear in
  duration order with the open one marked; a fourth page tagged into the space appears without
  reopening; hjkl moves the selection; running the command from a window with no space opens
  nothing.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "research|see-through|spaces"
```

Done when the unit tallies report `fail 0`, the new tests pass, and the other collected specs show
no new failure compared with `apps/desktop/tests/gate-baseline.md`. Record the `test:grep`
pass/fail count under `**Result**` in the handoff. Unverified by this run: whether it feels like
a list rather than an editor, which needs a look on the laptop before landing.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app; read it before editing, especially the
`<peek-*>` component rules, the lazy-tile init-ordering rule, and that a consumer tile lists each
pubsub topic it subscribes to in its own manifest. Run one command per Bash call.
