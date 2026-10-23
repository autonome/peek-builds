---
enabled: true
touches: [apps/desktop/features/editor/home.js, apps/desktop/features/editor/query-add-item.js, apps/desktop/tests/unit/query-add-item.test.js, specs/tag-query-add-item.md]
depends-on: []
---

# Tag-query editor: an item emptied and closed is deleted, with undo

Peek item `337b9dc8`. In the tag-query editor view (`edit #tag …`, `features/editor/home.js`),
only an item added in this view is deleted when its inline editor closes with no text: the
`onClosed` handler passed to the inline editor runs
`if (addedIds.delete(item.id) && shouldDiscard(item)) discardItem(api, item.id)`. An existing
item whose text is cleared stays behind as an empty item.

Decisions:

- **Any text item closed empty is deleted**, new or existing. "Empty" is what
  `query-add-item.js shouldDiscard(item)` already means: a `text` item whose content is not a
  string or is empty after `trim()`. Unchanged.
- **The decision is one pure function in `features/editor/query-add-item.js`**:
  `closeEmptyAction(item, wasAdded)` returns `'discard'` when `shouldDiscard(item)` and
  `wasAdded`, `'delete'` when `shouldDiscard(item)` and not `wasAdded`, else `null`.
- **`'discard'` keeps today's path**, `discardItem(api, id)`: a blank item that never held text
  has nothing worth undoing.
- **`'delete'` goes through `home.js deleteBlock(item)`**, the same function the view's delete
  action uses: it soft-deletes through `api.datastore.deleteItem` and pushes
  `{ kind: 'delete', itemId, previousOrder }` on the view's undo stack, so `undoLast()` restores
  the item (`api.datastore.restoreItem`) with its tags and its place in the order. The item
  leaves every tag list, including tags the view does not query; undo is the safety net.
- **`onClosed` becomes**: compute `wasAdded = addedIds.delete(item.id)`, then act on
  `closeEmptyAction(item, wasAdded)`. Any other place in `home.js` that discards an open added
  item on close (the check that `addedIds.has(openItem.id)` and the open text is blank) keeps
  its current behaviour; only `onClosed` changes.
- **`specs/tag-query-add-item.md`, "What stays"**: replace "any other item left empty stays a
  normal item" with "any other text item left empty is deleted too, and undo restores it
  (`specs/editor-empty-item-deletes.md`)".

## Tests to change

`tests/unit/query-add-item.test.js`, a `closeEmptyAction` suite, written first and failing:

- empty text item, `wasAdded` true → `'discard'`;
- empty text item, `wasAdded` false → `'delete'`;
- whitespace-only content (`'  \n '`) counts as empty;
- text item with content → `null` either way;
- a non-`text` item (`type: 'url'`) with no content → `null`.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
```

Done when both unit tallies report `fail 0` and the new suite is among the passing tests. Record
the node unit pass/fail count under `**Result**` in the handoff. Unverified by this run: the
close-then-undo round trip in a live view, which needs a look in the app.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app; read it before editing. Change only the files
in `touches`. Run one command per Bash call.
