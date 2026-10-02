# Todo Commands

Four cmd-panel commands, loaded from `manifest.json` (lazy: the tile boots on
the first `cmd:execute:todo`, `cmd:execute:todos`, `cmd:execute:done` or
`cmd:execute:complete`).

- `todo {text} [#tag ...]` — creates a text item tagged `todo`. Trailing
  `#tags` are removed from the text and added as extra tags; tags earlier in
  the text stay in it. Input made only of tags creates nothing.
- `todos` — lists the outstanding `todo` items, newest first, as a selection
  list. Enter opens the selected item in the editor.
- `done` — lists the finished `done` items the same way. Read-only: Enter
  opens the item, nothing is marked.
- `complete {match}` — swaps `todo` for `done` on one item: the row picked in
  the list (Tab or Enter), else the first `todo` item whose title or content
  contains `match` (case-insensitive).

## Files

- `manifest.json` — declares the four commands and the pubsub topics the
  background tile subscribes to.
- `background.html` / `background.js` — command handlers, using
  `getOrCreateTag` → `tagItem`/`untagItem` and `getItemsByTag`.
- `todo-items.js` — the pure decisions (matching, ordering, list result,
  which item `complete` acts on); unit-tested in `tests/unit/todo-items.test.js`.
- `config.js` — id/labels stub.
