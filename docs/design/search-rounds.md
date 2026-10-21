# Search rounds: research as repeated search, open, sort, refine

Status: slice 1 (keep and drop a page) built, `specs/research-keep-drop.md`; the rest is design.
Peek `df3ffc86`. Decisions so far are under "Decided".

## The flow

Research that runs in rounds: search (a search engine, or one site's own search), open many
results, read them, close some, keep some, refine the search, go again. Recipes, hotels, flights,
rental listings, product comparisons all have this shape.

What goes wrong today:

- **Nothing remembers a round.** A page seen in round one looks new in round three.
- **Kept and dropped are invisible.** There is nowhere to see the keepers side by side, or why a
  page was dropped ("too long", "no parking", "maybe").
- **Nothing is ever finished.** Neither a page ("dealt with") nor the research ("booked it").
- **The open set has no tracker.** Peek has no tabs; twelve result windows are twelve windows.

## What already exists

| Need | Existing piece | What it gives today |
|---|---|---|
| A container for one research | Spaces (`features/spaces`) | A space is the tag `space:<name>`. `background.js handleItemCreated()` tags every page opened from a window in space mode with the space tag, so "pages opened during this research" is already recorded. Session snapshots (`main/session.ts saveSessionSnapshot`) save and restore its windows. |
| Seen before, when, how often | Visits (`main/datastore.ts`) | `trackNavigation()` records every main-frame http(s) navigation in `item_visits` and bumps `items.visitCount` / `lastVisitAt`. `findUrlItem(url)` answers "opened before" in one lookup. Visits carry no research or round id. |
| Kept / dropped with a judgement | Tags plus the `notes` metadata field | `features/editor` tag-query views (`query-live.js resolveTagQuery()`) list URL items with their tags and `notes`, update live, and render tag-swap checkboxes (`features/tag-actions runTagSwap`). |
| Finished | Todos (`features/todo`) | Done is a tag swap, `todo` → `done`. The pattern carries over; the code is text-item specific. |
| Revisit later | Reminders (`features/reminders`) | `remind:3d` turns into `remind:due`. |
| The open set | Windows view (`features/windows/windows.js`) | Cards for open windows with thumbnail, host, close, filter and keyboard navigation. No tags or state. |
| Where a search came from | Web search (`features/websearch/home.js executeSearch()`) | Opens result pages with `trackingSource: 'websearch'`; knows built-in engines and OpenSearch templates sites advertise (`page:search-engine-discovered`). |
| Per-page facts | Entities (`features/entities`) | Places, people, events, phone numbers, and OpenGraph title/description/image on the URL item. No price, recipe or listing fields. |

## Proposed model

- **A research is a space.** Starting one is `create space` (or a new `research` command that
  creates a space and runs the first search in it). Nothing new is stored for the container.
- **A page's state is one of four tags,** scoped by the page also carrying the space tag:
  - no state tag: *new* (opened, not yet judged);
  - `kept`;
  - `dropped`;
  - `done`, for a kept page that has been acted on (booked, cooked, bought).

  The one-line judgement goes in the URL item's `notes` metadata, which tag-query views already
  show. Slice 1's tags are global to the URL item; state moves to per research, with other
  researches' judgements shown as context, per "Decided" below.
- **Seen in this research** = the URL item already carries the space tag when it is opened again.
  Visit history adds "seen anywhere, n times, last on <date>" for free.
- **A round** is one search run from a window in the space. Recording each query as a text item
  tagged with the space tag and `search-round` gives a list of the searches tried, in order, with
  no schema change. Linking each result page to the round it came from needs the opener's round
  carried on `item:created`; deferred.
- **The research is finished** when the space tag's metadata says so (`finished: true`, set by a
  `finish research` command). A finished space drops out of the active list but keeps its kept
  and done pages viewable.

## Direction: one view of the research

The research needs a single representation that shows the whole forest: what was searched, what
is open, what was kept and why, what was dropped, what is done. It serves both as live visibility
while the research runs and as the artifact afterwards. It is built on the existing item, tag,
note and history data, not a new store: the research *is* the items carrying its space tag, and
the view is a query over them.

The shape is the tag-query view (`edit #tagA #tagB`, `features/editor/home.js`, kept live by
`features/editor/query-live.js startQueryLive()`), which already joins separate notes into one
document. The difference is that it renders compact cards rather than editable blocks, using the
card that search, lists and groups already share (`renderer/lib/search-result-card.js
createSearchResultCard()`: title, favicon, URL, thumbnail, visit count, age, tag chips,
tag-action affordances). `renderer/lib/live-query.js liveQuery()` re-runs any query on pubsub
topics, so a card grid over `getItemsByTag(spaceTag)` stays live without new plumbing. Today
neither surface does this: `#tag` queries open the editable-block view, and the `lists` window
groups cards by type from a search string.

In that view:

- pages are grouped by state (new, kept, dropped, done), each card showing its note;
- the round items (the searches tried) and any notes written into the research sit alongside
  as cards, so the reasoning is in the same view as the results;
- windows currently open are badged on their cards, which makes the view the open-set tracker
  too, instead of a separate filtered windows view;
- the same view, read after the research is finished, is its record.

## Surfaces

1. **On the page (overlay).** For a page in a research space: a "seen in this research, kept:
   no parking" line when it has been judged before; keep and drop buttons, with an optional note,
   beside the existing tag input in `renderer/page/overlay.js`. Commands `keep [note]` and
   `drop [note]` do the same from the command panel.
2. **The research view**, as described under "Direction: one view of the research": a card
   mode of the tag-query view over the space's tag, grouped by state, with open windows badged
   and keep, drop and done on each card. It replaces both a separate research list and a
   filtered windows view. Reachable from the space's card in `features/spaces/home.js` and by
   typing the space's tag into the command panel.
3. **On the results page.** Marking result links that are already seen, kept or dropped, the way
   a browser colours visited links but per research. The most useful surface and the most
   expensive: it needs a script in third-party pages. Later.

## Decided

- **Judgement is set aside** (2026-10-21). Kept, dropped and done as page states, and the notes
  that go with them, are not the direction for now; the design centres on the larger flows
  (starting a research, the open set, rounds, memory across rounds, finishing). Slice 1's
  `keep`/`drop` commands and overlay buttons stay built but are not extended. The two judgement
  decisions below stand in case judgement returns.
- **Closing without judging** (2026-10-21). Closing a page that was never kept or dropped leaves
  it unjudged, and the research view shows it as unjudged. Closing may later come to mean
  dropped, once the flow has been used for real research; nothing is built for that yet.
  `window:closed` carries only the window id, so any close-time behaviour must read the URL
  before the window is torn down.
- **State belongs to one research, and stays visible to others** (2026-10-21). Keeping or
  dropping a page records the judgement for the research it was made in, so a hotel kept for one
  trip can be dropped for another. Every judgement persists after its research ends, and any other
  research that meets the same page can see it as context ("kept for Lisbon trip"). It informs a
  judgement and never sets one. Slice 1 stores a single global `kept`/`dropped` tag
  (`renderer/lib/page-state.js`), so the slice that adds the research view also moves state to a
  per-research form (per-space tags such as `kept:<space>`, or item metadata keyed by space) and
  says what happens to judgements made outside any space.

## Open questions

- **URL identity.** `findUrlItem()` matches the URL after `normalizeUrl()`, which keeps tracking
  parameters and fragments. Listing sites put session and tracking parameters in result links, so
  the same listing can arrive as several URL items and read as unseen. Needs per-site or common
  tracking-parameter stripping before "seen" is trustworthy.
- **Listing fields.** Comparing kept hotels wants price, dates, rating side by side. Entities
  extracts none of these; JSON-LD `Product`/`Offer`/`Recipe`/`LodgingBusiness` would be the
  source. Out of scope for the first slices.
- **Search on one site.** Rounds on a site's own search only count as rounds if the query is
  seen. Sites that advertise OpenSearch are covered by web search; the rest would need query
  parameter detection on navigation, which does not exist.

## Link to background grouping

`docs/design/background-grouping.md` proposes groups of pages from visit signals and learns from
corrections. Its first offline run over 14 days of real history found exactly two useful
multi-site groups, a property search and a house-swap search: research of this shape, held
together almost only by session co-occurrence. The two designs feed each other:

- **Research as a label source.** Keeping a page in a research space, dropping it, or adding it
  by hand is an explicit, unbiased must-link or cannot-link between that page and the space's
  members, the kind of label that design says is scarce (its `grouping:add` / `grouping:remove`
  corrections, and its note that a hand-made `space:` tag counts as an unbiased label).
- **Grouping as a research starter.** A proposal that spans several sites across sessions is a
  research in progress; accepting it can create the space with those pages as its first members.
- **Mozilla's small models.** `Mozilla/smart-tab-embedding` (a 384-dimension MiniLM) supplies
  title meaning across different sites, the signal background grouping found missing; here it
  would answer "does this open window belong to the current research?". `Mozilla/smart-tab-topic`
  (57 MB T5) names a cluster from its keywords, which here names a research started from a
  proposal. Both stay behind the measured bake-off in `docs/historical/local-ai-needle-research.md`;
  nothing in the first slices needs them.

## First slices, smallest first

1. **Keep and drop a page.** `keep [note]` and `drop [note]` commands plus overlay buttons: set
   the tag (removing the other), write `notes`. Works in or out of a space. Unit-testable state
   logic, one Playwright case.
2. **The research view.** A card-grid mode of the tag-query view over a space's tag, grouped by
   state, live through `liveQuery()`. The forest view; everything after builds on it.
3. **Seen-before line in the overlay.** On page load, if the URL item carries the current
   space's tag or a state tag, show state, note and last visit. Read-only.
4. **Open windows in the research view.** Badge cards whose page is open; keep and drop from
   the card.
5. **Rounds and finishing.** Record each web search run from a space as a `search-round` item,
   shown as cards in the research view; `finish research`.
6. Later: results-page link marking, tracking-parameter stripping, listing fields, grouping
   proposals that start a research, embedding-based "belongs to this research".

Slices 1 and 3 stand alone and are useful outside research spaces; 2 reads the state slice 1
writes, and 4 and 5 extend 2.
