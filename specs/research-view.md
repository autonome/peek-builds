---
enabled: false
touches: [apps/desktop/features/research/, apps/desktop/tests/desktop/research-view.spec.ts, docs/design/search-rounds.md]
depends-on: [card-view-see-through]
---

Started by hand on top of the built `track/spec-card-view-see-through` branch, before that branch
lands, so `enabled: false` keeps the scheduler from starting it from `main`.

# The research view: one research's pages, searches and notes as a ranked list

Peek item `df3ffc86`, slice "The research view" of `docs/design/search-rounds.md` ("The open set",
"Surfaces" item 2). A research is a space (`space:<name>` tag). The view shows everything in the
current research in one maximized, see-through window, built on the app-wide see-through switch
(`specs/card-view-see-through.md`, `specs/card-view-see-through-everywhere.md`), not as a window
mode of its own.

Decisions:

- **It looks and behaves like the Lists view, not like an editor.** Compact rows, one per item,
  in the style of the `lists` feature (`features/lists/home.js`, rows from
  `renderer/lib/search-result-card.js createSearchResultCard()`), moved through with the arrow
  keys and hjkl (`renderer/lib/grid-nav.js`). No document surface, no always-on text cursor, no
  block chrome. Text is editable only where the person asks for it: the add-a-note row, and a
  note row opened with Enter.
- **Data comes from the tag-query document's live query, not its rendering.** The view resolves
  and follows `space:<name>` with `features/editor/query-live.js resolveTagQuery()` /
  `startQueryLive()`, so it updates as pages, searches and notes join the space. The note row's
  inline editing may reuse `features/editor/query-inline-editor.js` if it can be styled as a
  plain list row; otherwise a plain input.
- **Three groups, in this order**:
  - **Pages** — URL items in the space, ranked by total time on page (sum of
    `item_visits.duration` over the item's visits, via `api.datastore.queryItemVisits()`), then
    by visit count. Each row shows title, host, time spent and visit count. A page open in a
    window is marked as open.
  - **Searches** — `search-round` items in the space, in the order they were first run
    (`features/websearch/search-rounds.js`), showing the query and how many times it ran.
  - **Notes** — the space's other text items, newest first, with an add-a-note row at the top
    of the group; Enter on it saves a `text` item tagged with the space tag.
- **Actions**: Enter or click on a page brings its open window forward, or opens it in the
  space the way `features/spaces` opens a space's page. Enter on a search runs it again through
  web search in the space. Enter on a note opens it for editing in place; Escape closes the
  editor, then the view.
- **Which research**: the space of the front content window
  (`api.window.getFocusedVisibleWindowId()` and its space mode, as
  `features/websearch/search-rounds.js` finds it). With no space, the command reports
  "not in a research space" and opens nothing.
- **Opening**: a command `research view` in `features/research/`. The window opens with the
  see-through switch on (declared through the card-view manifest declaration from
  `specs/card-view-see-through-everywhere.md`), so it is maximized and frosted; the per-window
  switch can turn it to the normal look. One research view per space (window `key`
  `research-view:<space>`), reused if already open.
- The ranking is time-on-page only for now. Scroll, copy and input signals are set aside
  (`docs/design/search-rounds.md` "Set aside" and "Candidate first slices"); the keep/drop
  judgement in `features/research/background.js` is not extended or shown.

## Docs to change

`docs/design/search-rounds.md`: record the view under "Built" once it works, and update "The open
set" to point at it.

## Tests to change

New `tests/desktop/research-view.spec.ts` on a test profile: create a space with three pages (one
left open, with visit durations written directly so the order is known), two `search-round`
items and one note; open a page window in that space and run `research view`. The window is
maximized and see-through; the groups appear in order; pages are ranked by duration with the open
one marked; Enter on the open page brings its window forward; adding a note through the
add-a-note row creates a text item tagged with the space and it appears in Notes without
reopening the view; running the command from a window with no space opens nothing. Pure parts
(ranking, grouping) get a unit test under `tests/unit/`.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "research|search-rounds|see-through|spaces"
```

Done when the unit tallies report `fail 0`, the new tests pass, and the other collected specs show
no new failure compared with `apps/desktop/tests/gate-baseline.md`. Record the `test:grep`
pass/fail count under `**Result**` in the handoff. Unverified by this run: whether it feels like
a list rather than an editor, which needs a look on the laptop before landing.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app; read it before editing, especially the
`<peek-*>` component rules, the lazy-tile init-ordering rule, and that a consumer tile lists each
pubsub topic it subscribes to in its own manifest. Run one command per Bash call.
