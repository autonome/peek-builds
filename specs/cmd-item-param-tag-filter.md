---
enabled: true
touches: [apps/desktop/renderer/cmd/completers.js, apps/desktop/renderer/cmd/item-suggestions.js, apps/desktop/tests/unit/item-suggestions.test.js]
depends-on: []
---

# Let an `item` command parameter suggest only items carrying a given tag

Part of Peek item `b0ebd143`. This slice is the cmd-panel plumbing the todo feature's `done <partial>`
suggestions need: an `item` parameter that can be scoped to one tag. The todo feature itself is
wired up in a later slice.

## Problem

`apps/desktop/renderer/cmd/completers.js` `completeItem()` serves every command whose first param is
`{ type: 'item' }` (today only the built-in `edit` command in `renderer/cmd/commands/edit.js`). It
always runs `api.datastore.queryItems({ type: paramDef.itemType || 'text', limit: 20, sortBy:
'updated', search })`, so there is no way to say "suggest only items tagged `todo`". A command from a
feature manifest cannot narrow the list at all: manifest `params` are passed through untouched to the
panel (`main/manifest-cache.ts`, `renderer/cmd/commands.js createProxyCommand()`), so a new key on the
param definition is all a feature needs to declare.

Everything downstream of the suggestion list already handles `type: 'item'` params and needs no
change: `renderer/cmd/panel.js` `doUpdateParamSuggestions()` joins the typed tokens into one search
string for item params, `fillParamText()` (Tab, Shift+Tab) writes `suggestion.title` into the input,
and `acceptParamItem()` (Enter or click) calls `doExecute()` with `{ selectedItem: suggestion._item }`,
which `createProxyCommand()` forwards to the feature as `selectedItem` in the `cmd:execute:<name>`
message. Arrow Up/Down only move the highlight (`navigateParamDown`/`navigateParamUp`); leave that.

`completers.js` reads `window.app` at import time, so node tests cannot import it. The existing
`main/completers.test.ts` re-implements the completer logic inline instead of importing it, so it
would not catch a regression here. The new logic therefore goes into a leaf module with no
`window`/DOM access, like `renderer/cmd/url-completion.js`, and is tested by importing it directly.

## What goes

New `apps/desktop/renderer/cmd/item-suggestions.js`, pure functions only:

- `findTagByName(tags, name)`: case-insensitive match on `tag.name`, `undefined` when absent.
- `filterTaggedItems(items, { search, itemType, limit })`: from the rows `getItemsByTag()` returns,
  keep rows whose `title` or `content` contains `search` (case-insensitive substring; blank search
  keeps all), keep only rows whose `type` equals `itemType` when `itemType` is given (no type
  restriction otherwise), sort by `updatedAt` descending, cap at `limit` (default 20).
- `toItemSuggestion(item)`: the row-to-suggestion mapping now inline in `completeItem()`, moved
  unchanged (title is the first content line with a leading `#`-heading marker stripped, `'Untitled'`
  when empty, truncated to 60 characters plus `'...'`; subtitle is the locale date of `updatedAt` or
  `''`; `value` is the item id; `_item` is the item itself).

`completers.js` `completeItem()`:

- When `paramDef.tag` (a tag name string) is set: resolve the tag through the existing `fetchTags()`
  cache and `findTagByName()`, return `[]` when the tag does not exist (do not create it), otherwise
  `api.datastore.getItemsByTag(tag.id)`, then `filterTaggedItems()` with `paramDef.itemType` passed
  through only when the definition sets it, then map with `toItemSuggestion()`.
- When `paramDef.tag` is not set: behaviour unchanged (same `queryItems` call and defaults), except
  that the row mapping now calls `toItemSuggestion()`.
- Update the `@param` JSDoc on `completeItem()` and the `paramDef` doc on `getSuggestions()` to list
  `tag`.

## What stays

- `renderer/cmd/panel.js`, `renderer/cmd/state-machine.js`: no change (see Problem).
- `renderer/cmd/commands/edit.js` and its `{ type: 'item', itemType: 'text' }` param: unchanged, and
  must produce the same suggestions as before.
- `completeTag`, `completeEnum`, `getSuggestions()`'s switch, `invalidateCache()`.
- `main/completers.test.ts`: leave as is.

## Tests to change

New `apps/desktop/tests/unit/item-suggestions.test.js`, importing the module by path the way
`tests/unit/url-completion.test.js` does. Cover:

- `findTagByName`: exact, differently-cased, and missing names.
- `filterTaggedItems`: search matches on title and on content case-insensitively; blank search keeps
  all; newest `updatedAt` first; `limit` caps the result; a type filter applies only when `itemType`
  is passed (an item of another type is kept when it is not).
- `toItemSuggestion`: heading marker stripped, long first line truncated with `'...'`, empty content
  gives `'Untitled'`, `value` is the id and `_item` is the same object, subtitle is `''` without
  `updatedAt`.

## Verify

```
yarn workspace @peek/desktop build && NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js && NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
```

Done when both runners report `fail 0` and the new file's tests are included in the node runner's
count. Record both counts under **Result**. The `getItemsByTag` call in `completeItem()` and the panel
glue are not covered by any unit test (they need the live datastore); say so under **Result** rather
than claiming coverage.

## Working rules

Run one command per Bash call.
