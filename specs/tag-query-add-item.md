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
- Autosave behavior of the inline editor. An item added here and closed with no text is deleted again
  (the item is persisted at once so it reaches the view through live updates, so a blank item would
  otherwise be left behind); any other item left empty stays a normal item.

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

## Result

Built. The key is plain `o` (free in `query-keys.js`: the outer surface has no vim instance, and
Cmd/Ctrl+O is excluded by the modifier check; the window's Esc goes through the preload, not a key
handler). The item is created and tagged straight away, the view waits for its block from the live
update (5 s limit, after which the item is removed and the status line says so), then selects it and
opens the inline editor. Closing it with no text soft-deletes the item; closing the window with an
empty new editor open deletes it too. An unknown tag disables the toolbar button (tooltip gives the
reason) and `o` shows the same reason in the status line; no tag is created.

Checked live on a headless Electron profile: button and `o` create a tagged item that appears and
opens, typed text autosaves, an empty close leaves nothing, an unknown-tag query disables the control.
Not checked live: Esc closing the empty editor (the preload consumes Esc, synthetic keys do not reach
it, so the check closed it by selecting another block), and the window-close discard.
