---
name: peek
description: "Peek is the user's personal task/knowledge system, accessed via mcp__peek__* tools. NOT part of this project's codebase — it's an external service like a todo list or issue tracker. Use it to read/write tasks and notes in the peek:* namespace."
---

# Peek — task & knowledge tools (peek scope)

<!-- PEEK_SKILL_BODY_BEGIN -->

**Peek is an external task and knowledge management system** — like a
personal issue tracker. It is NOT part of this project's codebase. You
interact with it through `mcp__peek__*` tool calls to read and manage
the user's tasks, notes, and reference items.

This session is scoped to items tagged `peek` or `peek:*`
(enforced server-side via `PEEK_MCP_SCOPE_TAG=peek`). Keep all work
inside that namespace so tag conventions stay clean.

## Avoid the bare-tag defaults

- `mcp__peek__list_tasks()` defaults to `tags: ['todo']` (BARE) — surfaces every project's todos. Use `list_items({ tags: ['peek:todo'] })` instead.
- `mcp__peek__complete_task({ itemId })` adds bare `done`, removes bare `todo` — does NOT touch `peek:todo` / `peek:done`. Do status changes manually (below).

## Status vocabulary

| Tag | Meaning |
|---|---|
| `peek:todo` | In the queue, not started |
| `peek:wip` | Actively being worked |
| `peek:needs-review` | Agent done; user approval pending |
| `peek:done` | Shipped and accepted |
| `peek:future` | Parking lot — not now, not no |
| `peek:wontfix` | Closed without shipping |

Don't invent new statuses. Don't use bare `todo` / `done` — those are cross-project.

## Add a task

```js
mcp__peek__create_item({
  type: 'text',
  title: 'Short imperative title',
  content: '# Short imperative title\n\n## Problem\n\n...\n\n## Plan\n\n...',
  tags: ['peek:todo'],  // plus any project-specific tags from the section below
})
```

**Hashtags in content do NOT auto-tag by default.** `#123` issue refs and `#3)` enumerations stay as plain text. Pass `extractHashtags: true` only when you genuinely want `#word` patterns from text-type content auto-tagged.

**"Add task: ..." mid-session is intake, not redirect.** Capture it, keep working on the current task. Don't pivot unless the user explicitly tells you to switch.

## List tasks

```js
// Actionable queue
mcp__peek__list_items({ tags: ['peek:todo'] })

// Parking lot
mcp__peek__list_items({ tags: ['peek:future'] })
```

## Status changes — manual untag + tag + event

`mcp__peek__complete_task` won't work (bare tags). Do it by hand:

```js
mcp__peek__tag_item({ itemId, tagName: 'peek:done' })
mcp__peek__untag_item({ itemId, tagName: 'peek:todo' })
mcp__peek__record_event({
  itemId, type: 'completed', value: 'shipped in <ref>',
})
```

Always **tag the new status before untagging the old** — `untag_item` refuses if removing the tag would orphan the item from the scope (i.e. no other `peek` or `peek:*` tag remains). Adding the new status first satisfies the orphan check.

## After settings or binary changes — fully restart Claude Code

The MCP server is a child process spawned by Claude Code; env vars are frozen at spawn. Changes to Peek's settings (scope tag, readonly toggle, profile) OR a rebuild of Peek itself leave the running child on the OLD code/env. Fully quit and reopen Claude Code in this directory to refresh. Re-approving the `/mcp` prompt is NOT enough.

<!-- PEEK_SKILL_BODY_END -->

## Project-specific

<!-- Edit below this line freely. Everything above the BODY_END marker is
     auto-managed by peek-mcp-init and refreshed on every re-run.
     Anything below this line survives. Add tag vocabulary, scope-narrowing
     patterns, or any other project-only conventions here. -->
