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

- `applyManualOrder(items, orderedIds, sortFresh)`: items not listed in `orderedIds` first (ordered by
  `sortFresh`, `updated-desc` from `sortItems`), then the listed items in that order; ids that no longer
  exist are ignored.
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

## Result

Built.

- **Storage:** `localStorage` on the editor's origin under `editor:query-order:<queryKey>` (JSON array of
  item ids). It is the same mechanism `editor-layout.js` uses for `editor:layout-prefs` and the per-document
  highlights; no table and no settings schema entry. `manual-order.js` `loadOrder` / `saveOrder` take the
  Storage, so they are unit-tested with an in-memory one.
- **Keys:** `Shift+j` moves the selected block down, `Shift+k` up (`query-keys.js` `MOVE_DOWN_KEY` /
  `MOVE_UP_KEY`, handled in `attachQueryKeys` through `actions.move`). The capitals collide with nothing in
  the view: plain `j`/`k` select, `o` adds, `z` prefixes folds, Enter opens the editor, and `Alt` is ignored
  by `attachQueryKeys`. `home.js` `moveSelected` ignores them unless the sort option is `manual`, while an
  inline editor is open, or for a block that is leaving.
- **Where new items go:** first. Items missing from the stored list (new ones, including from add-item)
  come first, newest edited first, above the stored order. They are not written to storage until the next
  move, which first reconciles the stored list with the current items (`ensureOrder`) and so also drops
  stored ids that match nothing.
- **Sort option is window state:** a reopened window starts on the default sort; choosing `manual` shows the
  stored order again. Switching to another option and back leaves the stored list untouched.
- Live updates, folds, selection and the held inline editor go through the existing `mountSorted` path;
  `signatureOf` and `displayList` use the stored order so a result that only reorders is detected.

Verified: build, all `tests/unit/*.test.js` (946 pass, 0 fail), `editor-layout.spec.ts` and
`editor-folding.spec.ts` (91 pass, `--project=editor`), and a live headless run on profile `agent-tqds`:
real `Shift+J` / `Shift+K` keys, no effect outside manual, selection and fold follow the moved block, order
survives closing and reopening the window and a full app relaunch, a new item added with `o` lands first,
a deleted item is pruned from storage on the next move, switching sort away and back keeps the order, and a
second query has its own order. Not verified: sorting while an inline editor is open with a result held back
(covered only by reading the code path), and a real-OS keyboard layout where `Shift+j` differs.
