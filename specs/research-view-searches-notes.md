---
enabled: true
touches: [apps/desktop/features/research/, apps/desktop/tests/desktop/research-view-searches-notes.spec.ts, apps/desktop/tests/unit/research-view-groups.test.js, docs/design/search-rounds.md]
depends-on: [research-view]
---

# The research view: searches and notes groups

Follows `specs/research-view.md`, which built the research view with its ranked pages. This slice
adds the two other groups under the pages, in this order, and the one place the view takes typed
text.

Decisions:

- **Searches**: `search-round` items in the space, in the order they were first run
  (`features/websearch/search-rounds.js`), each row showing the query and how many times it ran.
  View only in this slice; running a search again is `specs/research-view-actions.md`.
- **Notes**: the space's other text items, newest first, with an add-a-note row at the top of the
  group. Typing in that row and pressing Enter saves a `text` item tagged with the space tag;
  Escape leaves the row. The row is the only editable text in the view, styled as a list row,
  not a document. Existing notes are view only in this slice.
- Both groups follow the same live query as the pages, so items joining the space appear without
  reopening the view, and arrow keys and hjkl move across all three groups.

## Docs to change

`docs/design/search-rounds.md`: record the view under "Built", and update "The open set" to
point at it.

## Tests to change

New `tests/desktop/research-view-searches-notes.spec.ts` on a test profile: a space with one
page, two `search-round` items and one note; run `research view`; the groups appear in order,
searches in run order; adding a note through the add-a-note row creates a text item tagged with
the space and it appears in Notes without reopening the view.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "research|search-rounds"
```

Done when the unit tallies report `fail 0`, the new tests pass, and the other collected specs show
no new failure compared with `apps/desktop/tests/gate-baseline.md`. Record the `test:grep`
pass/fail count under `**Result**` in the handoff. Unverified by this run: whether the note row
still feels like a list rather than an editor, which needs a look on the laptop before landing.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app; read it before editing, especially the
`<peek-*>` component rules. Run one command per Bash call.
