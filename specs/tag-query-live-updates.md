---
enabled: true
touches: [apps/desktop/features/editor/query-live.js, apps/desktop/features/editor/home.js, apps/desktop/features/editor/home.css, apps/desktop/tests/unit/query-live.test.js]
depends-on: [tag-query-inline-editor]
---

# Tag-query editor, slice 9: the document updates live, with freeze-and-fade for leavers

Part of Peek item `item_1790655511612_0mmmdmy59`; design in `tag-query-editor-view.md`
(Decisions: "Liveness", "Live updates while editing").

## What goes

New `features/editor/query-live.js`: subscribes through `renderer/lib/live-query.js` `liveQuery` to
item and tag changes, re-resolves the query with the slice 1 helpers, and diffs the result against the
blocks on screen with a pure function `diffBlocks(currentIds, nextItems)` returning `added`,
`removed` and `kept`.

- Added items appear in the current sort order. Kept blocks update in place when their item changed,
  except a block with an open inline editor (below).
- A block whose item left the query (retagged out, or deleted) is frozen visually, with its content as
  last shown and affordances disabled, then fades out and is removed. This also covers toggling a
  binding such as `todo` to `done` from the block's own left column.
- An open block whose item left the query or was deleted gets the same freeze and fade; the inline
  editor flushes its pending autosave first, unless the item was deleted, in which case the write is
  dropped.
- Edits made elsewhere to an item whose inline editor is open are not merged: the editor keeps its
  text until closed, then the block shows the stored version.

## What stays

- Sort order from the toolbar; the manual-order slice defines where new items land in manual order.

## Tests to change

New `apps/desktop/tests/unit/query-live.test.js` for `diffBlocks`: added, removed, kept, reorder only,
empty to non-empty, and the open-block rule if it is a pure decision (`liveAction(block, change)`).

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test node --test apps/desktop/tests/unit/query-live.test.js apps/desktop/tests/unit/*.test.js
```

Done when the run reports `fail 0`. The fade animation and cross-window updates need the Electron app
and are not exercised here; say so under **Result**.

## Working rules

Run one command per Bash call. Never run the Electron gate without an explicit OK.
