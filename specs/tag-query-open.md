---
enabled: true
touches: [apps/desktop/renderer/cmd/commands/edit.js, apps/desktop/renderer/cmd/panel.js, apps/desktop/renderer/cmd/tag-query.js, apps/desktop/features/editor/background.js, apps/desktop/features/editor/home.js, apps/desktop/tests/unit/tag-query.test.js]
depends-on: []
---

# Tag-query editor, slice 1: `edit #tags` opens an editor window keyed by the query

Part of Peek item `item_1790655511612_0mmmdmy59`; design in `tag-query-editor-view.md`
(Decisions: "Command surface", "Routing"). This slice gets a query from the command line to an editor
window that knows its tag set and its items. It renders nothing new: the window shows the resolved
items as a plain list of titles, enough to prove the plumbing. Block rendering is later slices.

## Problem

`renderer/cmd/commands/edit.js` `execute` always returns a single item or a selection list.
`renderer/cmd/panel.js` `publishEditorOpen` publishes `editor:open` with one `itemId`, and
`features/editor/background.js` `openEditor` keys the window `editor-<itemId>`. There is no way to
open an editor over a group of items.

## What goes

New leaf module `apps/desktop/renderer/cmd/tag-query.js`, no `window` access, pure functions:

- `parseTagQuery(rawArgs)`: when every whitespace-separated token starts with `#` and has a
  non-empty name, returns the tag names in order, de-duplicated case-insensitively; otherwise `null`.
- `queryKey(tags)`: the sorted, lower-cased, de-duplicated tag set joined with `,`.
- `queryWindowKey(tags)`: `editor-query-` plus `queryKey(tags)`.
- `intersectItems(itemLists)`: items present in every list, by `id`, order of the first list.

`edit.js` `execute`: when `parseTagQuery` returns tags (including one tag), resolve each tag by name
with the `findTagByName` helper from `renderer/cmd/item-suggestions.js`, read
`api.datastore.getItemsByTag(tag.id)` for each, intersect, and return an output carrying the tag
names, the item ids and any unknown tag names. An unknown tag is never created; the result lists it
so the view can show a notice. Other `edit` arguments keep today's behavior.

`panel.js` `publishEditorOpen` (and the output-selection guards in `renderer/cmd/state-machine.js` that
decide array versus single output): a query output publishes `editor:open` with a `tags` field (array of
names) instead of `itemId`. Re-read those guards before editing; the query output must not enter the
output-selection list.

`features/editor/background.js` `openEditor`: when the message has `tags`, use
`queryWindowKey(tags)` as the window key and pass `tags=<names joined by comma>` in the window URL, so
re-running the same query focuses the existing window.

`features/editor/home.js` `init()`: read the `tags` URL param; in query mode resolve the items again
through the same helpers (the window must not trust a stale id list) and show a list of item titles
with a notice naming unknown tags; show an empty-state line when nothing matches. Single-item and
file modes are untouched.

## What stays

- Everything about `edit` with non-`#` arguments, `editor:add`, `editor:open` with `itemId`.
- The editor's panes, toolbar and status line.

## Tests to change

New `apps/desktop/tests/unit/tag-query.test.js` (import by path, as `url-completion.test.js` does):
`parseTagQuery` on all-tag, mixed, bare `#`, duplicates and case; `queryKey` order independence;
`queryWindowKey`; `intersectItems` on empty, disjoint and overlapping lists and first-list order.
Extend `cmd-state-machine.test.js` only if the guards change.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test node --test apps/desktop/tests/unit/tag-query.test.js apps/desktop/tests/unit/cmd-state-machine.test.js
```

Done when both report `fail 0`. Record the counts under **Result**. The panel round trip (typing
`edit #todo #today` and seeing one window open, a second run focusing it) needs the Electron app and is
not exercised here; say so under **Result**.

## Working rules

Run one command per Bash call. Never run the Electron gate without an explicit OK.
