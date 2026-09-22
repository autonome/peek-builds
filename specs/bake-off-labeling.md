---
enabled: true
touches: [apps/desktop/features/bake-off-labeling/**, apps/desktop/tests/desktop/bake-off-labeling.spec.ts]
depends-on: []
---

# Bake-off labelling tile

`docs/local-ai-needle-research.md`'s "Bake-off plan" and "How to run the bake-off" sections
(~line 449-541) need three kinds of hand-labelling done against the account holder's own real
Peek data before any candidate model can be evaluated: grouping recent browsing/notes into
tasks, marking entity spans in pages and notes, and writing command-bar utterances mapped to
the Peek MCP call each should produce. The doc assumes this is done by hand against exported
files; this spec is a built-in Peek tile that does the same three jobs inside the running app,
against live data, so the labelling is fast instead of a multi-day file-wrangling exercise.

This spec covers **only the labelling UI and exporting labelled data to a file**. Running the
candidate models against the exported files (the "three days running candidates" half of the
bake-off) is separate, future work and out of scope here.

## Data model and APIs to build on (confirmed against this codebase; do not re-derive)

- Notes are `items` rows with `type: 'text'`, body in `content`
  (`apps/desktop/main/datastore.ts` `items` table, line ~191). Page visits are a separate
  `item_visits` table (line ~234: `id, itemId, timestamp, duration, source, ...`) joined back to
  `items` via `itemId` — no title/URL/text lives on the visit row itself.
- Date-range query for visits: `window.app.datastore.queryItemVisits({ since, until })` (ms
  epoch) — `ItemVisitFilter` in `apps/desktop/types/index.ts` supports `since`/`until` directly.
  **`window.app.datastore.queryItems(...)` has no `since`/`until` parameter** — for notes
  "written in the last week," fetch a generous page with `sortBy: 'created'` and filter
  client-side on the returned `createdAt`. Do not add a new datastore filter for this; it is
  out of scope and would widen `touches` unnecessarily.
- Page text for the entity-labelling job: `window.app.datastore.extractPageContent(url)` returns
  `{ html, text, title }` — from the live `webContents` if that URL is currently open, otherwise
  a `fetch` + tag-strip fallback (`apps/desktop/features/entities/background.js`
  `getPageContent()`), capped at 50,000 characters. Nothing is cached; call it per page shown.
- Exporting a labelled set to a file outside the repo: `window.app.dialogs.save(content,
  filename, mimeType)` (IPC `tile:dialogs:save`, capability `dialogs: ['save']`) opens a native
  save dialog and writes the file — the account holder picks the destination, which is what
  keeps personal browsing data out of the repo per the research doc's requirement. Use this for
  every export in this spec; do not write to a fixed path.
- Reference UI to build from: `apps/desktop/features/entities/` (`manifest.json` + `home.html`)
  is the closest existing tile in shape (browse a list, inspect one item in a detail pane,
  record a judgement about it) and already uses the required `<peek-*>` components
  (`peek-card`, `peek-grid`, `peek-grid-toolbar`, `peek-input`) and the `lit` importmap block —
  copy its conventions per `apps/desktop/CLAUDE.md`'s UI section rather than hand-rolling chrome.
- The MCP tool list for the command-routing job lives in
  `apps/desktop/features/mcp-server/server.js` `const TOOLS = [...]` (line ~218): `list_items,
  search_items, get_item, create_item, update_item, delete_item, list_tags, tag_item,
  untag_item, record_event, list_tasks, complete_task, get_task_context`, each with a JSON
  Schema `inputSchema`. `server.js` is a standalone process and does not export `TOOLS` for a
  renderer to import — hardcode a duplicate of the 13 tool names + short descriptions in this
  tile's own source, with a comment citing `features/mcp-server/server.js`'s `TOOLS` as the
  source of truth to keep the two in sync by hand. Do not attempt to read `server.js` at
  runtime to derive the list.

## Requirements

1. **New lazy tile** `apps/desktop/features/bake-off-labeling/` (`manifest.json` modeled on
   `features/entities/manifest.json`: `builtin: true`, `home` tile `lazy: true`, `role:
   "workspace"`, a `key` that collapses repeat opens to one window, capabilities
   `datastore.tables: ["items", "item_visits"]` and `dialogs: ["save"]`). One window, one
   `home.html`, with a top-level tab or segmented control switching between the three workflows
   below — not three separate windows.
2. **Shared "add items to label" control**, used by both the task-clustering and
   entity-labelling workflows: a search input backed by `queryItems({ search, ... })` to pick
   existing items, plus a way to paste a newline-separated list of URLs to pull in as new
   candidates. Build this once and reuse it rather than duplicating item-picking UI per
   workflow.
3. **Task-clustering workflow.** A date-range control (default: the last 7 days) drives
   `queryItemVisits({ since, until })`, resolves the distinct `itemId`s hit, and separately
   pulls notes (`queryItems({ type: 'text', sortBy: 'created' })`, filtered client-side to the
   same range by `createdAt`) — combined into one list, shown via `peek-grid`. The account
   holder can create named task groups and assign one or more selected items to a group;
   unassigned is a valid, expected end state for items that belong to no task (the research doc
   requires a rejection class, not forced grouping).
4. **Entity-labelling workflow.** For each item added via the shared picker (a `url` item or a
   `text`/note item), show its text — `extractPageContent(url).text` for URL items, `content`
   directly for notes — in a read-only text view. The account holder selects a span of text with
   the mouse and tags it as `person`, `organization`, `place`, or `event`; record the tagged
   spans per item. A span must be the verbatim selected text (record it directly from the
   selection, not retyped) with its character offsets into the shown text, so a later
   correctness check can verify it's a real substring.
5. **Command-routing workflow.** A free-text "utterance" field, a picklist of the 13 MCP tools
   (per "Data model and APIs" above) with a free-text JSON field for that call's arguments, and
   a "no matching tool (refusal)" toggle that clears the tool/argument fields when set. The
   account holder adds one case at a time; cases accumulate in a list on screen with the
   utterance and a summary of its expected call (or "refusal").
6. **Export**, one per workflow, each via `window.app.dialogs.save(...)` with `mimeType:
   'application/json'`:
   - Task clustering: `{ generatedAt, range: { since, until }, tasks: [{ id, label, itemIds
     }], unassignedItemIds, items: [{ id, type, title, url, content, createdAt, lastVisitAt
     }] }` — `items` carries enough of each labelled item's own data that the exported file is
     self-contained and doesn't require the repo/database to interpret later.
   - Entities: `{ generatedAt, items: [{ itemId, type, url, text, entities: [{ type, span,
     start, end }] }] }`.
   - Command routing: `{ generatedAt, cases: [{ utterance, expectedCalls: [{ tool, args }],
     refusal }] }` — `expectedCalls` is an array (not a single call) to allow a case that maps
     to more than one MCP call; `refusal: true` implies an empty `expectedCalls`.
7. **Not in scope:** no automatic task clustering, entity extraction, or utterance-routing
   suggestions — this is a manual-labelling speed tool, not a model. No execution of any
   candidate model from the bake-off table. No change to `queryItems`/the datastore schema.

## Verify

A new Playwright spec, `apps/desktop/tests/desktop/bake-off-labeling.spec.ts`
(`yarn test:grep 'bake-off labeling'`), covering: the tile opens; a task can be created and an
item assigned to it, leaving another item unassigned; a page or note's text can be shown and a
selected span tagged with an entity type; a command-routing case can be added both with a tool
selected and with the refusal toggle set. For each export, call the tile's own export-payload
builder function directly (not through the native save dialog, which Playwright cannot drive)
and assert its JSON shape matches Requirement 6 — export the builder function for the test to
import, or expose it on a test-only hook the same way other tiles do, whichever matches this
codebase's existing pattern for testing tile-internal logic without a real file write.

`yarn workspace @peek/desktop build` must stay clean, and the new spec must pass under
`yarn test:grep`.

## Working rules

- `apps/desktop/CLAUDE.md` governs the desktop app — read its "Tile Architecture" and "UI: the
  `<peek-*>` component system" sections before writing `home.html`; the `lit` importmap block is
  required or every component silently fails to upgrade with no thrown error.
- Run one command per Bash call; use the `yarn` scripts, never `npx playwright` directly.
- This tile is for the account holder's own use, not a general end-user feature — but it is
  still real, shipped code, so it follows the same manifest/capability/component conventions as
  any other built-in tile rather than being a special-cased dev-only surface.
