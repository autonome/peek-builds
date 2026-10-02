---
enabled: true
touches: [apps/desktop/features/todo/background.js, apps/desktop/features/todo/manifest.json.disabled, apps/desktop/features/todo/todo-items.js, apps/desktop/tests/unit/todo-items.test.js]
depends-on: [todo-list-and-done-picker]
---

# Make the todo verbs match their actions: `complete` marks, `done` lists

Part of Peek item `b0ebd143`. The `todo-list-and-done-picker` slice made `done <match>` mark an
outstanding todo done. A verb that names a finished state should show finished things, so this slice
swaps the roles before the feature is switched on.

## Target behaviour

| Command | Shows | Enter on a row |
|---|---|---|
| `todo <text> [#tag ...]` | nothing (creates a todo) | unchanged |
| `todos` | the outstanding `todo`-tagged items, newest first | unchanged (opens the item for editing) |
| `done` | the items tagged `done`, newest first | opens the item for editing or review |
| `complete <match>` | the outstanding `todo`-tagged items, filtered by the typed text | marks that item done |

`complete` is exactly today's `done`: same picker, same match rules, same tag swap from `todo` to
`done`, same `completed` item event, same `todo:done` pubsub publish. `done` becomes the read-only
counterpart of `todos` over the other tag.

## What goes

In `apps/desktop/features/todo/background.js`:

- The `cmd:execute:done` subscriber and `handleDone` as they are today. The marking logic moves to a
  handler for `cmd:execute:complete`; keep its behaviour and change only the name in its user-facing
  strings (`Usage: complete <text-substring-of-todo>`, and so on).
- The header comment block's description of `done {match}`, rewritten for the table above.

In `apps/desktop/features/todo/manifest.json.disabled`:

- The `done` command's `match` param (`type: "item"`, `tag: "todo"`) moves to a new `complete`
  command with the same description wording ("Mark a todo done ...").
- The top-level `description` names `todo`, `todos`, `done` and `complete`.

In `apps/desktop/features/todo/todo-items.js`:

- `pickDoneTarget` keeps its behaviour but is renamed `pickCompleteTarget`, with its callers and tests.

## What gets added

- A `done` handler in `background.js` that queries items tagged `done` and returns the same list result
  shape `todos` returns today, so Enter on a row opens the editor the same way. Reuse
  `todosListResult` (give it the heading text as an argument if it hardcodes "outstanding"). An empty
  result says there are no done todos yet.
- A `done` command in the manifest with no params, and `cmd:execute:complete` added to the pubsub
  topics list beside the existing `cmd:execute:done`.

## What stays

- The `todo` and `todos` commands and `matchTodos`, `sortNewestFirst`.
- The `DONE_TAG` constant, and the stored tag name `done`: existing data is unchanged.
- The manifest stays `manifest.json.disabled`; switching it on is `todo-feature-enable`.

## Tests to change

`apps/desktop/tests/unit/todo-items.test.js`:

- Rename the `pickDoneTarget` cases to `pickCompleteTarget`; no assertion changes.
- Add cases for the list helper over the `done` tag: newest first, the heading names done todos, and the
  empty case.

## Verify

```
yarn workspace @peek/desktop build && NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js && NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
```

Done when both runners report `fail 0`; record the counts under **Result**. Typing the commands into a
live panel is not covered by any automated test; say so under **Result**.

## Working rules

Run one command per Bash call.
