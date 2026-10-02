---
enabled: true
touches: [apps/desktop/features/editor/manual-order.js, apps/desktop/features/editor/sort-options.js, apps/desktop/features/editor/home.js, apps/desktop/features/editor/query-keys.js, apps/desktop/tests/unit/manual-order.test.js]
depends-on: [tag-query-add-item]
---

# Tag-query editor, slice 11: manual order, stored per query

Part of Peek item `item_1790655511612_0mmmdmy59`; design in `tag-query-editor-view.md`
(Decisions: "Manual order"). The order is keyed by the query's sorted tag set (`queryKey` from slice
1); a saved-list model is a later change, so changing a query's tags starts a fresh order.

## What goes

New `features/editor/manual-order.js`, pure functions:

- `applyManualOrder(items, orderedIds)`: items listed in `orderedIds` first in that order, the rest
  after them in `updated-desc` order; ids that no longer exist are ignored.
- `moveBlock(orderedIds, id, delta)`: new id list with one block moved up or down by `delta`.
- `ensureOrder(currentIds, orderedIds)`: the stored list reconciled with the current items.

`sort-options.js`: add a `manual` option that uses `applyManualOrder`.

Persistence: store the ordered id list under a key derived from `queryKey(tags)`, using whatever
settings or datastore call the editor feature already uses for per-feature state. The choice of call is
made when implementing, by reading `features/editor/home.js` and `settings-schema.json`; record it under
**Result**. Do not add a new table.

`query-keys.js` and `home.js`: reorder gesture on the selected block (for example `<Alt-j>` /
`<Alt-k>`, or `J` / `K`, whichever does not collide with existing bindings in `codemirror.js`), enabled
only when the sort option is `manual`. A newly appearing item, including one created by the add-item flow, lands first in manual order.

## What stays

- Other sort options and their defaults; `updated-desc` stays the default.
- The live-update freeze-and-fade behavior.

## Tests to change

New `apps/desktop/tests/unit/manual-order.test.js`: apply with partial, stale and empty lists; `moveBlock`
at both ends; `ensureOrder` with added and removed items; stability when the list is unchanged.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test node --test apps/desktop/tests/unit/manual-order.test.js apps/desktop/tests/unit/sort-options.test.js
```

Done when both report `fail 0`. Persistence across window reopen and the reorder keys need the Electron
app and are not exercised here; say so under **Result**.

## Working rules

Run one command per Bash call. Never run the Electron gate without an explicit OK.
