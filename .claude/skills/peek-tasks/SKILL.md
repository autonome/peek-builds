---
name: peek-tasks
description: Manage the Peek codebase todo queue via mcp__peek__* tools (the peek:* tag namespace) — controlled tag vocabulary, scope/quality tags, add/list/edit, manual status transitions, needs-review handoff. Use when adding, completing, or triaging a peek:* task, changing a task's status, asking "what's next", or opening a task in Peek.
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
- ❌ `mcp__peek__complete_task({ itemId })` — hardcoded to add bare `done`
  and remove bare `todo`. Won't touch `peek:todo`. **Do not use.**
- ✅ `mcp__peek__list_items({ tags: ['peek:todo'] })` — correct.
- ✅ Manual untag + tag + event for status changes (see below).

## Tag vocabulary (controlled)

Every task is a Peek item with the `peek:todo` status tag plus at
least one domain or type tag from this controlled list:

- **Status**: `peek:todo`, `peek:wip`, `peek:needs-review`, `peek:blocked`, `peek:done`, `peek:wontfix`
- **Quality** (additive to `peek:todo`): `peek:ready`, `peek:triage`
- **Domain**: `peek:desktop`, `peek:mobile`, `peek:tauri`, `peek:atproto`, `peek:extensions`
- **Type**: `peek:bug`, `peek:feature`, `peek:test-coverage`, `peek:docs`, `peek:design`, `peek:security`, `peek:tile-arch`, `peek:meta`, `peek:tooling`, `peek:daily-use`

### Quality markers

Items in the active queue (`peek:todo`) carry one of two quality markers:

- **`peek:ready`** — scoped, queue-ready, can be picked up. Concrete bugs (clear repro or symptom) and small features with known target behavior.
- **`peek:triage`** — needs scoping conversation before work can start. Vague ideas, vocab musings, big features without scope, exploratory questions.

Use the intersection to find actionable work:
`list_items({ tags: ['peek:todo', 'peek:ready'] })`.

### `peek:needs-review` — agent done, user approval pending

Agent has shipped work (commits landed on `main` via the chokepoint scripts, full
test suite green), but the task is NOT yet `peek:done`. The user is the final
gate: tests + LLM review are necessary, not sufficient. Move the item to
`peek:needs-review` and surface the diff + test result; user approval flips it
to `peek:done`. See [[feedback_user_approves_done]] and the `/agent-review`
skill.

### `peek:wontfix` — terminal state

Closed without shipping. Use when the analysis concludes "don't do
this" (security gap is theoretical, lazy lifecycle is doing what we
want, etc.) or when a fix is blocked indefinitely on something we
won't pursue. **Don't use `peek:deferred`** — it's been retired. If
you'd reach for "deferred," the right move is either:
- Close as `peek:wontfix` if the analysis says we're not going to do it.
- Tag `peek:triage` if the path forward needs to be decided.

The bare `#peek` tag is the legacy project membership marker — leave
it alone on existing items, but **don't add `#peek` to new items**.
The `peek:*` namespace is implicit project membership.

## Starred tracking items

A `META:`-prefixed, `peek:starred` item aggregates high-signal findings —
a reference for deciding what to work on next. When you create such an
aggregation, title it `META: …` and tag it `peek:starred`.

When the user asks open-endedly what to work on (triage, "what's next?"),
scan them:

```js
mcp__peek__list_items({ tags: ['peek:starred'] })
```

When the user names a specific task, just do it — don't fetch these,
don't redirect to them. If a finding bears on their task, mention it in
one line; otherwise leave the backlog out of it.

## Scope tags (which app does the task belong to?)

Tasks scoped to a single app carry a `peek:scope:*` tag. This makes
triage queries easy — e.g. find all desktop-only bugs:
`list_items({ tags: ['peek:todo', 'peek:scope:desktop'] })`.

| Tag | When to use |
|-----|-------------|
| `peek:scope:desktop` | Only affects `apps/desktop` (Electron main process, renderer, features) |
| `peek:scope:mobile` | Only affects `apps/mobile` (Tauri mobile / iOS / Android) |
| `peek:scope:server` | Only affects `apps/server` (webhook API backend) |
| `peek:scope:extension` | Only affects `apps/extension` (browser extension) |
| `peek:scope:cross` | Explicitly cross-cutting (touches multiple apps or `packages/`) |

Omit the scope tag if the task is inherently cross-cutting and you
don't want to pick one (equivalent to `peek:scope:cross`). Do **not**
add `peek:scope:*` when you don't know — leave it unscoped, then the
triage pass can assign it.

## Add a task

```js
mcp__peek__create_item({
  type: 'text',
  title: 'Short imperative title',
  content: '# Short imperative title\n\n## Problem\n\n...\n\n## Plan\n\n...',
  tags: ['peek:todo', 'peek:desktop', 'peek:bug'],
})
```

**The MCP force-adds the bare `peek` tag on create.** The scope guard
appends bare `peek` to every item `create_item` makes (so it can't escape
the namespace). Your `tags` array IS applied on top — it is not ignored or
collapsed. Since you always pass `peek:todo`, the bare `peek` is redundant
and lands in the user-reserved bare-`#peek` intake; remove it right after
create:

```js
const item = mcp__peek__create_item({ type: 'text', title: '…', content: '…', tags: ['peek:todo', 'peek:triage'] })
mcp__peek__untag_item({ itemId: item.id, tagName: 'peek' })  // drop the auto-added bare tag
```

Safe because the `peek:todo` tag keeps the item in scope, so the orphan
guard allows the untag.

- Title is what shows in lists — keep it scannable.
- Content is markdown; first line `# {title}` matches the title.
- Tags: always include `peek:todo` + a quality marker (`peek:ready` or `peek:triage`) + at least one domain (`peek:desktop`/`peek:mobile`/etc.) + ideally one type (`peek:bug`/`peek:feature`/etc.).
- Quality marker: if you can write a clear "done looks like..." in the content, tag `peek:ready`. If the content is "explore X" or "build Y as example" or a one-phrase musing, tag `peek:triage`.
- Don't write to `docs/tasks.md`. Don't echo the new task back unless asked.

### When the user fires task adds mid-session

If the user says "add task: ..." or rapid-fires several adds while you're in the middle of other work: capture them verbatim and **keep working on the current task**. Don't pivot, don't editorialize, don't triage right then. The add is intake, not a redirect. Only pivot if the user explicitly tells you to switch.

## List tasks

```js
// Actionable queue (default — what you usually want)
mcp__peek__list_items({ tags: ['peek:todo', 'peek:ready'] })

// Items needing scoping conversation
mcp__peek__list_items({ tags: ['peek:todo', 'peek:triage'] })

// Everything still open (ready + triage)
mcp__peek__list_items({ tags: ['peek:todo'] })

// Scoped to a domain
mcp__peek__list_items({ tags: ['peek:todo', 'peek:ready', 'peek:desktop'] })
mcp__peek__list_items({ tags: ['peek:todo', 'peek:ready', 'peek:bug'] })

// In progress / blocked
mcp__peek__list_items({ tags: ['peek:wip'] })
mcp__peek__list_items({ tags: ['peek:blocked'] })

// Closed without shipping (audit trail)
mcp__peek__list_items({ tags: ['peek:wontfix'] })

// Pagination
mcp__peek__list_items({ tags: ['peek:todo'], limit: 50, offset: 0 })
```

`list_items` returns ALL items matching the tag intersection. The
queue is large (~258 `peek:todo` items as of 2026-04-29, of which
~53 are `peek:ready` and ~203 are `peek:triage`) — default to the
`peek:ready` view, paginate, or narrow by domain when broader.

## Status transitions

`complete_task` is generic and operates on bare `#todo` — never use
it here. Do transitions manually with `tag_item` + `untag_item` +
`record_event`:

| State change         | Tools                                                                                          |
|----------------------|------------------------------------------------------------------------------------------------|
| **triage → ready**   | `untag_item(peek:triage)` + `tag_item(peek:ready)` + `record_event('triaged', scope)`          |
| **todo → wip**       | `untag_item(peek:todo)` + `untag_item(peek:ready)` + `tag_item(peek:wip)` + `record_event('started')` |
| **wip → blocked**    | `untag_item(peek:wip)` + `tag_item(peek:blocked)` + `record_event('blocked', why)`             |
| **blocked → wip**    | `untag_item(peek:blocked)` + `tag_item(peek:wip)` + `record_event('unblocked')`                |
| **wip → done**       | `untag_item(peek:wip)` + `tag_item(peek:done)` + `record_event('completed', notes)`            |
| **todo → done**      | `untag_item(peek:todo)` + `untag_item(peek:ready/triage)` + `tag_item(peek:done)` + `record_event('completed', notes)` |
| **done → todo (revive)** | `untag_item(peek:done)` + `tag_item(peek:todo)` + `tag_item(peek:triage)` + `record_event('reopened', why)` |
| **close as wontfix** | `untag_item(peek:todo)` + `untag_item(peek:ready/triage)` + `tag_item(peek:wontfix)` + `record_event('wontfix', why)` |

Always do the untag and the tag in a pair — don't leave an item with
`peek:todo` AND `peek:done` set, `peek:wip` AND `peek:blocked`, or
`peek:ready` AND `peek:triage`. When transitioning out of `peek:todo`,
also clear the `peek:ready`/`peek:triage` quality marker.

## Edit / update a task

```js
mcp__peek__update_item({
  itemId: '<itemId>',
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
- **Don't manually add `#todo` or `#peek`** to new items — `peek:todo`
  already encodes both project membership and queue status. Note the MCP
  server force-adds bare `peek` for you on `create_item`; untag it
  afterward (see "Add a task") — don't leave it on the item.
- **Don't use `peek:deferred`** — retired 2026-04-29. If you'd reach
  for it, the right move is `peek:wontfix` (close the item) or
  `peek:triage` (decision needed).
- **Don't omit the quality marker** when creating a new `peek:todo`
  item — every active task should be `peek:ready` (scoped) or
  `peek:triage` (needs scoping).
- **Don't create duplicate tasks.** Before `create_item`, list with
  the relevant domain tag and check by title (substring match).
- **Don't leave inconsistent tag state** (`peek:wip` + `peek:done`,
  `peek:todo` + `peek:done`, etc.) — always pair the untag + tag.
- **Don't echo created/updated content** back in chat unless asked.
  Acknowledge tersely with the title.

## Quick recipes

**"Add a task: rename X to Y, peek desktop bug"** (well-scoped)
→ `create_item({ type: 'text', title: 'Rename X to Y', content: '# Rename X to Y\n\n…', tags: ['peek:todo', 'peek:ready', 'peek:desktop', 'peek:bug'] })`

**"Add a half-baked idea: maybe a tag-cluster widget?"** (needs scoping)
→ `create_item({ type: 'text', title: 'Tag-cluster widget?', content: '…', tags: ['peek:todo', 'peek:triage', 'peek:desktop'] })`

**"What's on my plate for desktop?"** (default to actionable)
→ `list_items({ tags: ['peek:todo', 'peek:ready', 'peek:desktop'] })` → render as a numbered list of titles only.

**"What's in the triage queue?"**
→ `list_items({ tags: ['peek:todo', 'peek:triage'] })`.

**"What's in flight?"**
→ `list_items({ tags: ['peek:wip'] })`.

**"Mark #3 done"**
→ resolve #3 from the prior list output → `untag_item(id, 'peek:todo')` + `untag_item(id, 'peek:ready')` (or `peek:triage`) + `tag_item(id, 'peek:done')` + `record_event(id, 'completed', notes)`.

**"Triage this — it's actually ready"**
→ resolve item → `untag_item(id, 'peek:triage')` + `tag_item(id, 'peek:ready')` + `record_event(id, 'triaged', 'scoped: <one-line plan>')`.

**"Close as wontfix — the security gap is theoretical"**
→ resolve item → `untag_item(id, 'peek:todo')` + `untag_item(id, 'peek:ready')` (or `peek:triage`) + `tag_item(id, 'peek:wontfix')` + `record_event(id, 'wontfix', 'security gap theoretical, indirection cost not justified')`.

**"Block the auth refactor — backend isn't ready"**
→ resolve item → `untag_item(id, 'peek:todo')` (or `peek:wip`) + `tag_item(id, 'peek:blocked')` + `record_event(id, 'blocked', 'backend not ready')`.

**"Open the page-host display-switch note"**
→ resolve via `list_items({ tags: ['peek:todo'] })` → reply: "It's item `<short-title>`. Pop Peek's cmd (Option+Space) and type `edit page-host display`."
