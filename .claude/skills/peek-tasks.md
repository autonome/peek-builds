---
name: peek-tasks
description: Manage the Peek-codebase todo queue via the Peek MCP server (mcp__peek__*). All tasks live under the peek:* tag namespace — add, list, status changes, complete, and "open in Peek" handoff for collaborative editing.
user_invocable: true
---

# Peek Task Queue (peek:* namespace only)

This skill is **project-scoped**. The Peek MCP server is generic — it
serves every project in the user's datastore (Amsterdam logistics,
taxes, atproto notes, etc.). When you're working in this codebase,
you must keep all task operations inside the `peek:*` tag namespace,
or you'll surface and mutate cross-project items.

The active queue lives in Peek as items, **not** in `docs/tasks.md`.
That file is a one-line pointer; do not edit it.

## CRITICAL: never use bare-tag queries here

- ❌ `mcp__peek__list_tasks()` — defaults to `tags: ['todo']` (bare),
  surfaces every cross-project todo. **Do not use** in this codebase.
- ❌ `mcp__peek__list_tasks({ project: 'peek' })` — queries bare
  `#peek` + `#todo`, also wrong namespace.
- ❌ `mcp__peek__complete_task({ id })` — hardcoded to add bare `done`
  and remove bare `todo`. Won't touch `peek:todo`. **Do not use.**
- ✅ `mcp__peek__list_items({ tags: ['peek:todo'] })` — correct.
- ✅ Manual untag + tag + event for status changes (see below).

## Tag vocabulary (controlled)

Every task is a Peek item with the `peek:todo` status tag plus at
least one domain or type tag from this controlled list:

- **Status**: `peek:todo`, `peek:wip`, `peek:blocked`, `peek:deferred`, `peek:done`
- **Domain**: `peek:desktop`, `peek:mobile`, `peek:tauri`, `peek:atproto`, `peek:extensions`
- **Type**: `peek:bug`, `peek:feature`, `peek:test-coverage`, `peek:docs`, `peek:design`, `peek:security`, `peek:tile-arch`, `peek:meta`, `peek:tooling`, `peek:daily-use`

The bare `#peek` tag is the legacy project membership marker — leave
it alone on existing items, but **don't add `#peek` to new items**.
The `peek:*` namespace is implicit project membership.

## Add a task

```js
mcp__peek__create_item({
  type: 'text',
  title: 'Short imperative title',
  content: '# Short imperative title\n\n## Problem\n\n...\n\n## Plan\n\n...',
  tags: ['peek:todo', 'peek:desktop', 'peek:bug'],
})
```

- Title is what shows in lists — keep it scannable.
- Content is markdown; first line `# {title}` matches the title.
- Tags: always include `peek:todo` + at least one domain (`peek:desktop`/`peek:mobile`/etc.) + ideally one type (`peek:bug`/`peek:feature`/etc.).
- Don't write to `docs/tasks.md`. Don't echo the new task back unless asked.

## List tasks

```js
// All open work in this project
mcp__peek__list_items({ tags: ['peek:todo'] })

// Scoped views
mcp__peek__list_items({ tags: ['peek:todo', 'peek:desktop'] })
mcp__peek__list_items({ tags: ['peek:todo', 'peek:mobile'] })
mcp__peek__list_items({ tags: ['peek:todo', 'peek:bug'] })

// In progress / blocked
mcp__peek__list_items({ tags: ['peek:wip'] })
mcp__peek__list_items({ tags: ['peek:blocked'] })

// Pagination
mcp__peek__list_items({ tags: ['peek:todo'], limit: 50, offset: 0 })
```

`list_items` returns ALL items matching the tag intersection. The
queue is large (267+ `peek:todo` items as of 2026-04-29) — paginate
or narrow by domain/type tag rather than dumping everything.

## Status transitions

`complete_task` is generic and operates on bare `#todo` — never use
it here. Do transitions manually with `tag_item` + `untag_item` +
`record_event`:

| State change         | Tools                                                                                          |
|----------------------|------------------------------------------------------------------------------------------------|
| **todo → wip**       | `untag_item(peek:todo)` + `tag_item(peek:wip)` + `record_event('started')`                     |
| **wip → blocked**    | `untag_item(peek:wip)` + `tag_item(peek:blocked)` + `record_event('blocked', why)`             |
| **blocked → wip**    | `untag_item(peek:blocked)` + `tag_item(peek:wip)` + `record_event('unblocked')`                |
| **wip → done**       | `untag_item(peek:wip)` + `tag_item(peek:done)` + `record_event('completed', notes)`            |
| **todo → done**      | `untag_item(peek:todo)` + `tag_item(peek:done)` + `record_event('completed', notes)`           |
| **done → todo (revive)** | `untag_item(peek:done)` + `tag_item(peek:todo)` + `record_event('reopened', why)`          |
| **defer**            | `untag_item(peek:todo)` + `tag_item(peek:deferred)` + `record_event('deferred', why)`          |

Always do the untag and the tag in a pair — don't leave an item with
`peek:todo` AND `peek:done` set, or `peek:wip` AND `peek:blocked`.

## Edit / update a task

```js
mcp__peek__update_item({
  id: '<itemId>',
  title: 'New title',     // optional
  content: 'New body…',   // optional
})
```

To change tags (swap domain, add a type tag, etc.):

```js
mcp__peek__tag_item({ itemId, tagName: 'peek:test-coverage' })
mcp__peek__untag_item({ itemId, tagName: 'peek:design' })
```

## Open a task in Peek for collaborative editing

When the user says "open task X" / "let's edit task X together" /
"pull up the X note":

1. Resolve the item via `list_items({ tags: ['peek:todo', ...] })` by
   matching title — get the item ID.
2. Tell the user to invoke Peek's cmd panel (default `Option+Space`)
   and type **`edit <title-fragment>`** — that routes through the
   `edit` command in `app/cmd/commands/edit.js`, which publishes
   `editor:open { itemId }` and opens the editor tile loaded with
   that item.
3. After they confirm it's open, collaborate by:
   - You read state via `mcp__peek__get_item` / `get_task_context`.
   - User types in Peek; you read updated content via `get_item`.
   - You write proposed edits via `update_item`.
   - User can re-read in Peek (the editor reloads on `editor:changed`).

**Why not auto-open?** The MCP server is a standalone Node subprocess
talking to `datastore.sqlite` directly — it cannot publish pubsub
events to the running Peek desktop app. Auto-open would require either
(a) registering `peek://` as a macOS protocol handler so
`open "peek://editor/home.html?itemId=…"` from shell routes to the
running Peek, or (b) an MCP-to-Peek IPC bridge. Until then the
cmd-panel handoff is the canonical flow.

## Don'ts

- **Don't read or write `docs/tasks.md`** for task ops. Read the queue
  via MCP. (The file is a pointer; treat it as read-only legacy.)
- **Don't use `list_tasks` or `complete_task`** — they're generic
  bare-tag tools that ignore the `peek:*` namespace. Use `list_items`
  + manual tag/event transitions.
- **Don't add `#todo` or `#peek`** to new items — `peek:todo` already
  encodes both project membership and queue status.
- **Don't create duplicate tasks.** Before `create_item`, list with
  the relevant domain tag and check by title (substring match).
- **Don't leave inconsistent tag state** (`peek:wip` + `peek:done`,
  `peek:todo` + `peek:done`, etc.) — always pair the untag + tag.
- **Don't echo created/updated content** back in chat unless asked.
  Acknowledge tersely with the title.

## Quick recipes

**"Add a task: rename X to Y, peek desktop bug"**
→ `create_item({ type: 'text', title: 'Rename X to Y', content: '# Rename X to Y\n\n…', tags: ['peek:todo', 'peek:desktop', 'peek:bug'] })`

**"What's on my plate for desktop?"**
→ `list_items({ tags: ['peek:todo', 'peek:desktop'] })` → render as a numbered list of titles only.

**"What's in flight?"**
→ `list_items({ tags: ['peek:wip'] })`.

**"Mark #3 done"**
→ resolve #3 from the prior list output → `untag_item(id, 'peek:todo')` + `tag_item(id, 'peek:done')` + `record_event(id, 'completed', notes)`.

**"Block the auth refactor — backend isn't ready"**
→ resolve item → `untag_item(id, 'peek:todo')` (or `peek:wip`) + `tag_item(id, 'peek:blocked')` + `record_event(id, 'blocked', 'backend not ready')`.

**"Open the page-host display-switch note"**
→ resolve via `list_items({ tags: ['peek:todo'] })` → reply: "It's item `<short-title>`. Pop Peek's cmd (Option+Space) and type `edit page-host display`."

**"Defer this until after the conversion"**
→ `untag_item(id, 'peek:todo')` + `tag_item(id, 'peek:deferred')` + `record_event(id, 'deferred', why)`.
