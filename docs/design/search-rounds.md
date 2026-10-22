# Search rounds: research as repeated search, open, process, close

Status: design. Peek `df3ffc86`. Reworked 2026-10-21 around observation; the earlier judgement
model (kept, dropped, done) is under "Set aside". Its first slice, `specs/research-keep-drop.md`,
is built and is not extended.

## The pattern

Research that runs in rounds: search (a search engine, or one site's own search), open many
results, read them, close most, refine the search, go again, until it is done. Recipes, hotels,
flights, rental listings, product comparisons all have this shape.

The pattern needs nothing beyond opening web pages, and it already works that way. Rounds happen
on their own. What is missing is any trace of them: nothing records which pages mattered, what
was decided, or how it ended, so a page seen in round one looks new in round three and the
research leaves nothing behind.

## Direction

Peek does not ask for more structured work. It adds two things around the pattern:

- **A container.** A general place a research lives while it runs and after it ends: its pages,
  its searches, its open windows. Spaces are the container (`features/spaces`).
- **Ambient helpers on an observing substrate.** Peek records what happens (visits, searches,
  time on a page, scrolling, copying, closing, returning) and derives from it which pages were of
  value. Helpers surface that back without being asked: "seen in this research", "you spent four
  minutes here and copied the address", the pages that mattered at the top of the research's
  view. Nothing in the flow depends on the person tagging or judging anything.

## What already exists

| Need | Existing piece | What it gives today |
|---|---|---|
| A container for one research | Spaces (`features/spaces`) | A space is the tag `space:<name>`. `background.js handleItemCreated()` tags every page opened from a window in space mode with the space tag, so "pages opened during this research" is already recorded. Session snapshots (`main/session.ts saveSessionSnapshot`) save and restore its windows. |
| Seen before, when, how often | Visits (`main/datastore.ts`) | `trackNavigation()` records every main-frame http(s) navigation in `item_visits` and bumps `items.visitCount` / `lastVisitAt`. `findUrlItem(url)` answers "opened before" in one lookup. Visits carry no research or round id. |
| Engagement per visit | `item_visits` columns `duration`, `scrollDepth`, `interacted` | The columns exist but page navigation never fills them: a web page's visit is written with all three at 0. Only the tile API (`main/tile-ipc.ts`) passes `interacted`. There is no capture of time on page, scrolling, copying or form input for web pages. |
| Where a search came from | Web search (`features/websearch/home.js executeSearch()`) | Opens result pages with `trackingSource: 'websearch'`; knows built-in engines and OpenSearch templates sites advertise (`page:search-engine-discovered`). |
| The open set | Windows view (`features/windows/windows.js`) | Screen-sized, transparent, floating card grid of open windows with thumbnail, host, close, filter and keyboard navigation. |
| A list or document over items | Tag-query view (`features/editor/home.js`, `query-live.js startQueryLive()`) | `edit #tag` joins items into one live, editable block document. |
| Per-page facts | Entities (`features/entities`) | Places, people, events, phone numbers, and OpenGraph title/description/image on the URL item. No price, recipe or listing fields. |

## The observing substrate

Value is inferred, never asked for. Candidate signals per visit, each cheap to record:

- **Time on page**: time the page was the focused, visible window, not time it was open. Main
  already knows focus and visibility per window.
- **Scroll volume**: how far and how much the page was scrolled.
- **Clipboard**: text copied from the page (an address, a price, a code) is a strong sign of
  value. Recording that a copy happened, and its length, needs no copy of the text itself.
- **Input**: typing into the page's forms (dates, filters, a booking form).
- **Returns**: opening the same page again in the same research, or across researches.
- **Closing**: closed within seconds of loading reads as rejected; left open to the end reads as
  still relevant.
- **Outbound**: following links from the page, saving it, sharing it.

A heuristic score per page per research combines these, with hand-set weights first, the way
`docs/design/background-grouping.md` scores pairs. The score orders and highlights; it never
hides a page.

Capture is the first real gap. Time on page can come from main-process focus and visibility
events. Scrolling, copying and input happen inside third-party pages, so they need either a
page-side script injected into hybrid content views or observation through the debugger
protocol. Either one touches every page loaded, which has privacy and performance weight and
must be decided before it is built.

## The open set: the research's own view

A dozen result windows are a dozen loose windows today. The direction is a maximized,
transparent surface over the research, in the manner of the windows switcher, holding a panel
that is a hybrid of a list and the block editor: the research's pages (open ones marked),
searches tried, and any notes written into it, in one place. It starts as that panel and may
move into the surface itself.

It is the research-specific case of app-wide work already filed:

- Peek `bb73035e`: a Peek-wide fullscreen mode versus fullscreen per window.
- Peek `35c2d773`: a maximize-all mode that maximizes every visible window and restores sizes
  on leaving.
- Peek `a6dfd7fb`, `d5db359b`, `d424e67c`: every card grid behaving like the switcher
  (maximized, transparent background), as a per-window treatment or a first-class window mode.

The research view should be built on whichever of those lands, not as its own window mode.

## Surfaces

1. **On the page (overlay).** A quiet line when a page has history in this research or another:
   "seen in this research, 3 visits, 4 min; copied from it". Read-only, from the substrate.
2. **The research view.** The maximized panel described above, ordered by the substrate's
   score, with open windows marked.
3. **On the results page.** Marking result links already opened in this research, the way a
   browser colours visited links but per research. Needs a script in third-party pages; later,
   and it shares the injection decision with the substrate.

## Starting, rounds and finishing

- **Starting.** A research is a space. A `research` command that creates a space and runs the
  first search in it is the only new step; the person may also just work in an existing space.
- **Rounds.** Each search run from a window in the space is recorded as an item tagged with the
  space tag and `search-round`, so the searches tried are listed in order. Linking each result
  page to its round needs the opener's round carried on `item:created`; deferred.
- **Finishing.** Leaving a research puts its windows away through the session snapshot and keeps
  everything recorded. Whether "finished" is ever marked, or inferred (no activity for a while,
  windows closed), is open.

## Decided

- **Capture runs on every page** (2026-10-22), not only inside a research space, so history
  outside research is just as rich and a research can start from pages already visited. Its cost
  is watched rather than avoided: each capture slice measures page load and input latency with
  and without it, and records the numbers in its handoff.

## Open questions

- **Capture mechanism.** A page-side script in hybrid content views versus observation through
  the debugger protocol, for scroll, copy and input. Chosen by the slice that builds it, on
  measured cost.
- **URL identity.** `findUrlItem()` matches the URL after `normalizeUrl()`, which keeps tracking
  parameters and fragments. Listing sites put session and tracking parameters in result links, so
  the same listing can arrive as several URL items and read as unseen. Needs per-site or common
  tracking-parameter stripping before "seen" is trustworthy.
- **Listing fields.** Comparing hotels wants price, dates, rating side by side. Entities extracts
  none of these; JSON-LD `Product`/`Offer`/`Recipe`/`LodgingBusiness` would be the source.
- **Search on one site.** Rounds on a site's own search only count as rounds if the query is
  seen. Sites that advertise OpenSearch are covered by web search; the rest would need query
  parameter detection on navigation, which does not exist.

## Link to background grouping

`docs/design/background-grouping.md` proposes groups of pages from visit signals and learns from
corrections. Its first offline run over 14 days of real history found exactly two useful
multi-site groups, a property search and a house-swap search: research of this shape, held
together almost only by session co-occurrence, and it named dwell time and interaction
(`item_visits.duration`, `interacted`) as the next weights to add. The engagement capture above
feeds both designs.

- **Grouping as a research starter.** A proposal that spans several sites across sessions is a
  research in progress; accepting it can create the space with those pages as its first members.
- **Mozilla's small models.** `Mozilla/smart-tab-embedding` (a 384-dimension MiniLM) supplies
  title meaning across sites; here it would answer "does this open window belong to the current
  research?". `Mozilla/smart-tab-topic` (57 MB T5) names a cluster from its keywords. Both stay
  behind the measured bake-off in `docs/historical/local-ai-needle-research.md`.

## Candidate first slices

1. **Time on page.** Fill `item_visits.duration` for web pages from focused, visible time,
   in main, with no page-side code. Useful everywhere and feeds background grouping at once.
2. **Seen-before line in the overlay**, from visits and duration.
3. **Scroll, copy and input** on every page, on the mechanism the slice measures cheapest.
4. **The research view** on the app-wide maximized treatment once one of the filed issues
   lands.
5. **Rounds**: `search-round` items for searches run from a space.

## Set aside

Page judgement (2026-10-21): explicit kept, dropped and done states with notes. Built as slice 1
(`renderer/lib/page-state.js`, `features/research/`) and not extended. Decided before it was set
aside, in case it returns: closing an unjudged page leaves it unjudged; judgement belongs to one
research and stays visible to others as context, never setting their state.
