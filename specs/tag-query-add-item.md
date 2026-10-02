---
enabled: true
touches: [apps/desktop/features/editor/query-add-item.js, apps/desktop/features/editor/home.js, apps/desktop/features/editor/query-keys.js, apps/desktop/tests/unit/query-add-item.test.js]
depends-on: [tag-query-live-updates]
---

# Tag-query editor, slice 10: add a new item, pre-tagged with the query's tags

Part of Peek item `item_1790655511612_0mmmdmy59`; design in `tag-query-editor-view.md`
(Decisions: "Add item"). A control in the query view creates a new text item carrying every tag in the
query and opens it in the inline editor, so a group can be extended without leaving the document.

## What goes

New `features/editor/query-add-item.js`:

- A pure function `newItemPlan(tagNames, tagsByName)` returning the item to create (type `text`, empty
  content) and the tag ids to bind. Query tags that no longer resolve to a tag are reported rather than
  created, so the new item may not silently miss a tag.
- The create call: `api.datastore` item creation followed by tag binding for each query tag, with
  failure of either step surfaced as a message in the status line and no half-created item left shown.
- Placement: the new block appears per the live-updates slice (current sort order); in the manual-order
  slice's `manual` sort it lands first. After creation the block is selected and its inline editor opens
  through `query-inline-editor.js`.

`home.js`: an add control (a button in the top toolbar from `editor-top-toolbar`, and a key such as `o`
on the outer surface, whichever does not collide in `query-keys.js`). Disabled when the query has an
unresolved tag.

## What stays

- The existing `editor:add` flow for the single-document editor.
- Autosave behavior of the inline editor: an item left empty stays a normal item; deleting empty items
  is not part of this slice.

## Tests to change

New `apps/desktop/tests/unit/query-add-item.test.js` for `newItemPlan`: all tags resolved, one
unresolved, empty query, duplicate names.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test node --test apps/desktop/tests/unit/query-add-item.test.js
```

Done when the run reports `fail 0`. Creating the item, the tag bindings and the inline editor opening
need the Electron app and are not exercised here; say so under **Result**.

## Working rules

Run one command per Bash call. Never run the Electron gate without an explicit OK.
