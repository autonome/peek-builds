---
enabled: true
touches: [apps/desktop/features/todo/todo-items.js, apps/desktop/features/todo/background.js, apps/desktop/features/todo/manifest.json.disabled, apps/desktop/tests/unit/todo-items.test.js]
depends-on: [cmd-item-param-tag-filter]
---

# Todo feature: a `todos` list command and a `done` picker fed by tagged suggestions

Part of Peek item `b0ebd143`. This slice is the todo feature's own code: the `todos` list command and
the `done` command reading the item chosen from the cmd-panel suggestion list. The manifest stays
disabled here; turning the feature on is the following slice.

## Problem

`apps/desktop/features/todo/background.js` registers two handlers, `todo` and `done`, and its manifest
is still named `manifest.json.disabled`.

- There is no `todos` command, so outstanding `#todo` items cannot be listed without opening the tags
  grid and filtering by hand.
- The `done` manifest param is `{ "name": "match", "type": "string" }`, which gives no suggestions.
  `handleDone()` looks up `getItemsByTag(todo)` and marks the first title/content substring match done,
  which can hit the wrong item when several match.
- Neither the list nor the picker needs a new window. The cmd panel already has both pieces:
  a command that returns an array with `output.mimeType: 'item'` makes the panel enter its output
  selection list, and Enter on a row publishes `editor:open` for that item id (`renderer/cmd/panel.js`
  `doSelectOutputItem()`; `renderer/cmd/commands/edit.js` is the precedent). An `item` param with a
  `tag` (added by the earlier slice `cmd-item-param-tag-filter`) gives Tab-fill and Enter-to-run with
  `selectedItem` in the `cmd:execute:done` message.

The handlers in `background.js` depend on `window.app`, so they cannot be imported by node tests. The
decisions go into a leaf module with no `window` access, tested directly.

## What goes

New `apps/desktop/features/todo/todo-items.js`, pure functions only:

- `matchTodos(items, needle)`: keeps items whose `title` or `content` contains `needle`
  (case-insensitive substring; blank needle keeps all), preserving input order. This is the filter now
  inline in `handleDone()`.
- `sortNewestFirst(items)`: copy sorted by `updatedAt` descending.
- `todosListResult(items)`: for one or more items, `{ success: true, output: { data: <items newest
  first>, mimeType: 'item', title: '<n> todos' } }` (`'1 todo'` for one); for none,
  `{ success: false, message: 'No outstanding todos' }`. An empty array must not be returned as
  output data, because the panel's chain-mode guard treats an empty array as chainable output.
- `pickDoneTarget(items, { selectedItem, match })`: `selectedItem` when it is an object with an `id`;
  otherwise the first `matchTodos(items, match)` hit; otherwise `null`.

`apps/desktop/features/todo/background.js`:

- New `handleTodos()`: resolve the `todo` tag with the existing `ensureTag()`, read
  `api.datastore.getItemsByTag(tag.id)`, return `todosListResult(items)`. On a datastore failure return
  the same `{ output: 'Failed to query todos', mimeType: 'text/plain' }` shape `handleDone()` uses.
- `handleDone(rawArgs, selectedItem)`: take the optional second argument, choose the target with
  `pickDoneTarget()` (the `todo` items are still loaded so a text-only invocation keeps working), and
  keep the rest as it is: swap the `todo` tag for `done`, `recordItemEvent`, publish `todo:done`,
  overflow note only in the text-match case. When a `selectedItem` is given, an empty `rawArgs` is
  valid (skip the usage message).
- `init()`: subscribe `cmd:execute:todos` next to the existing two, synchronously before any `await`,
  replying on `msg.resultTopic` the same way; pass `msg.selectedItem` to `handleDone()`.
- Update the file's header comment to list `todos` and the selection behaviour of `done`.

`apps/desktop/features/todo/manifest.json.disabled`:

- Add a `todos` command: `"action": { "type": "execute" }`, a one-line description, no params.
- Add `"cmd:execute:todos"` to `capabilities.pubsub.topics` (a consumer tile must list every topic it
  subscribes to).
- Change the `done` param to `{ "name": "match", "type": "item", "tag": "todo", "required": true,
  "description": ... }` and reword the command description to say the list shows outstanding todos.

## What stays

- The file name `manifest.json.disabled` and the feature staying off. Renaming is the next slice.
- `handleTodo()`, `parseTodoArgs()`, the tag helpers, `config.js`, `background.html`.
- The `todo` command's manifest entry.
- `renderer/cmd/*`: nothing in the panel changes in this slice.

## Tests to change

New `apps/desktop/tests/unit/todo-items.test.js`, importing `features/todo/todo-items.js` by path (see
`tests/unit/url-completion.test.js` for the pattern). Cover: `matchTodos` on title, on content, case
folding, blank needle, and order preserved; `sortNewestFirst` does not mutate its input;
`todosListResult` for zero, one and several items (title text, order, `success` flag);
`pickDoneTarget` with a `selectedItem`, with only a match, with a `selectedItem` that lacks an `id`
falling back to the match, and with no hit returning `null`.

## Verify

```
yarn workspace @peek/desktop build && NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js && NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
node -e 'JSON.parse(require("fs").readFileSync("apps/desktop/features/todo/manifest.json.disabled","utf8"))'
```

Done when both runners report `fail 0`, the new test file is in the node runner's count, and the
second command prints nothing (the edited manifest is still valid JSON). Record the counts under
**Result**. The panel round trip (typing `done x`, Tab, Enter; `todos` then Enter opening the editor)
runs only with the feature enabled and is not exercised here; say so under **Result**.

## Working rules

Run one command per Bash call.
