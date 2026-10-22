---
enabled: true
touches: [apps/desktop/features/websearch/home.js, apps/desktop/features/websearch/manifest.json, apps/desktop/features/websearch/search-rounds.js, apps/desktop/tests/unit/websearch-search-rounds.test.js, apps/desktop/tests/desktop/websearch-search-rounds.spec.ts, apps/desktop/main/tile-ipc.ts, apps/desktop/main/tile-preload.cts]
depends-on: []
---

# Search rounds: record each web search, and tie it to the space it ran in

Peek item `df3ffc86`, slice "Rounds" of `docs/design/search-rounds.md` ("Candidate first
slices"). Every web search Peek runs is recorded, so a research keeps the list of what was
searched, in order. When the search runs from a window in a space, the search and the result
page it opens belong to that space. No UI reads the record in this slice; the research view and
the seen-before line come later.

Decisions:

- **Every search is recorded**, in a space or not, matching "Capture runs on every page"
  (`docs/design/search-rounds.md` "Decided").
- **One item per distinct query text, one event per run.** The search is a `text` item whose
  content is the trimmed query, tagged `search-round`. Each run adds an item event of kind
  `search-run` carrying the engine id and the result URL, so running the same query again is a
  second run on the same item, not a new item. Query text match is exact after trimming.
- **The space** is the space mode of the window the search was started from: the window that
  was key when the command ran or the search box was used. If that window is in space mode
  (`api.context.get('mode', windowId)` returns `value: 'space'`), the search item gets that
  space's tag, and the result window opens with that `spaceMode`, so the existing
  `features/spaces/background.js handleItemCreated()` tags the result page into the space as it
  does for any page opened in one. With no such window, or a window not in a space, nothing is
  tagged with a space and results open as today.
- **Both search paths record.** `features/websearch/home.js executeSearch()` (the `web search`
  command and the per-engine commands) and `executeSearchFromUi()` (the websearch window's box,
  suggestions and Enter) go through one shared function. Engines discovered through OpenSearch
  run through these same paths and need nothing extra.
- **Linking each result page to its round** (carrying the round on `item:created`) stays
  deferred, as the design doc says. The `search-run` event's result URL is enough to join them
  later.
- A search with an empty query opens the search UI as today and records nothing.

## What the code does now

- `features/websearch/home.js executeSearch(engine, query)` builds the URL with
  `buildSearchUrl()` and calls `api.window.open(url, {role: 'content', width: 1024, height: 768,
  trackingSource: 'websearch', trackingSourceId: engine.id})`, with no opener or space.
  `executeSearchFromUi(query)` repeats that call with `key: url` and does not go through
  `executeSearch()`.
- `features/websearch/manifest.json` has no `datastore` capability.
- `main/tile-ipc.ts` `tile:datastore:add-item` publishes `item:created` without a `windowId`,
  so a tile-created item is never tagged into a space automatically; the caller tags it.
- `main/tile-preload.cts api.datastore` has `addItem`, `getOrCreateTag`, `tagItem`,
  `queryItems` and `addItemEvent`.
- New windows take a space from `options.spaceMode {spaceId, spaceName, color}` or from their
  opener (`main/ipc.ts inheritedModeForNewWindow()`).
- Whether the command palette's `ctx` carries the window the command was run from is not known;
  find out before adding anything. If neither `ctx` nor an existing tile API gives the key
  window, add the smallest read-only API that returns it, in `main/tile-ipc.ts` and
  `main/tile-preload.cts`, reading the window kernel's key window, and gate it on an existing
  capability.

## What changes

- New `features/websearch/search-rounds.js`: the decisions above as functions with the tile API
  passed in, so the unit test can drive them with a fake: find or create the query's item, tag
  it `search-round` and the space tag when there is one, add the `search-run` event, and return
  the `spaceMode` (or null) for the window open.
- `features/websearch/home.js`: both search paths call it and pass the returned `spaceMode` to
  `api.window.open`. A failure to record is logged and never stops the search from opening.
- `features/websearch/manifest.json`: a `datastore` capability covering the tables used.

## Tests to change

New `tests/unit/websearch-search-rounds.test.js` against a fake API: a first search creates one
item tagged `search-round` with one `search-run` event; the same query again adds a second event
to the same item; a different query creates a second item; a search from a space-mode window
tags the item with the space and returns its `spaceMode`; from a window outside a space, no
space tag and null; an empty query records nothing; a datastore error still returns so the
search opens.

New `tests/desktop/websearch-search-rounds.spec.ts` on a test profile, with a local `http`
server standing in for the engine (the way `tests/desktop/websearch.spec.ts` builds search URLs):
run a search with no space and check one `search-round` item with one run; put a window in
space mode, run a search from it, and check the search item and the opened result page both
carry the space tag.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "websearch|spaces"
```

`websearch-cmd.spec.ts` lives in `tests/desktop-serial/`, which `test:grep` does not collect;
run it through the display wrapper with `--project=desktop-serial --workers=1 --grep websearch`
(`apps/desktop/CLAUDE.md` "Testing"). Done when the unit tallies report `fail 0`, the new tests
pass, the collected specs show no new failure against `apps/desktop/tests/gate-baseline.md`,
and the pass/fail counts are recorded under `**Result**` in the handoff.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app; read it before editing, especially the lazy
tile init-ordering rule (websearch is lazy: register handlers before any `await`) and
"Electron is ONE backend". Run one command per Bash call.
