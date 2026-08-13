---
name: peek
description: "Peek is the user's personal task/knowledge system, accessed via mcp__peek__* tools — the DEFAULT place for this project's tasks, todos, and notes (an external service like an issue tracker, NOT part of the codebase). Whenever the user mentions a task, todo, backlog, says 'add task' / 'remind me' / 'track this', or asks what to work on, reach for the Peek MCP (list_items / create_item / tag_item in the peek:* namespace) by DEFAULT — do not fall back to an ad-hoc or built-in todo list."
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

## Tag model

- **`peek` is the membership tag.** Every item in this scope carries the bare `peek` tag, always. It is what makes the item part of this project. All `peek:*` tags are additive refinements layered on top of it — status, area, topic.
- **`peek` and nothing else means untriaged.** An item tagged only `peek` (no `peek:*` tag) is in the triage inbox. The scope-tag-only set is your intake queue — process it regularly. Adding a `peek:*` status tag (e.g. `peek:todo`) moves the item out of intake and into the worked queue.

```js
// The triage inbox: items that carry only the membership tag.
mcp__peek__list_items({ tags: ['peek'] })
```

## Status lives in the `peek:*` namespace

Status is one of these namespaced tags:

| Tag | Meaning |
|---|---|
| `peek:todo` | In the queue, not started |
| `peek:wip` | Actively being worked |
| `peek:needs-review` | Agent done; user approval pending |
| `peek:done` | Shipped and accepted |
| `peek:future` | Parking lot — not now, not no |
| `peek:wontfix` | Closed without shipping |

Don't invent new statuses. Never use bare `todo` / `done` — those are unnamespaced and shared across every project. Two MCP defaults trip on this, so do status changes by hand in the `peek:*` namespace:

- `mcp__peek__list_tasks()` defaults to `tags: ['todo']` (BARE) — surfaces every project's todos. Use `list_items({ tags: ['peek:todo'] })` instead.
- `mcp__peek__complete_task({ itemId })` writes bare `done` / `todo` — does NOT touch `peek:todo` / `peek:done`. Do status changes manually (below).

## Add a task

```js
mcp__peek__create_item({
  type: 'text',
  title: 'Short imperative title',
  content: '# Short imperative title\n\n## Problem\n\n...\n\n## Plan\n\n...',
  tags: ['peek:todo'],  // plus any project-specific tags from the section below
})
```

**`create_item` auto-adds the bare `peek` membership tag** so the item can't land outside your namespace; the `tags` you pass are kept alongside it. Pass a `peek:*` status tag to land the item in the worked queue; omit one and it waits in the triage inbox.

**Hashtags in content do NOT auto-tag by default.** `#123` issue refs and `#3)` enumerations stay as plain text. Pass `extractHashtags: true` only when you genuinely want `#word` patterns from text-type content auto-tagged.

**"Add task: ..." mid-session is intake, not redirect.** Capture it, keep working on the current task. Don't pivot unless the user explicitly tells you to switch.

## List tasks

```js
// Actionable queue
mcp__peek__list_items({ tags: ['peek:todo'] })

// Parking lot
mcp__peek__list_items({ tags: ['peek:future'] })
```

## Find an item

**Search by content with `search_items` — don't dump `list_items` and eyeball it.**

```js
mcp__peek__search_items({ query: 'sync retry' })                     // all terms must match
mcp__peek__search_items({ query: 'retry', tags: ['peek:todo'] })  // text + tag filter
```

The query is tokenized on whitespace with AND semantics — every term must appear, each matchable in the title, content, or tags. Results are relevance-ranked (title > tag > content) and each carries a `snippet` around the first match, so you can pick the right item without opening each one.

**Look up by id prefix.** `get_item` — and every lookup-by-id tool — accepts a unique leading PREFIX of an id, git-short-hash style. Paste the short id you saw in a listing or reference:

```js
mcp__peek__get_item({ itemId: '14efdd97' })   // resolves when the prefix is unique
```

An ambiguous prefix errors and lists the candidates — pass more of the id to disambiguate.

## Status changes — manual untag + tag + event

Tag the new status, untag the old, and record an event:

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

Everything above is the generic Peek model, shared by every project that runs
peek-mcp-init. Below is this repo's own convention layer. This is the only file
that teaches Peek task handling for mpeek — if you're about to write a second
one, don't.

### One more status: `peek:blocked`

Extends the status table above. Can't proceed — waiting on something external.
Blocked is not a parking lot; use `peek:future` for "not now, not no".

### Quality markers — additive to `peek:todo`

Every item in the active queue carries exactly one:

| Tag | Meaning |
|---|---|
| `peek:ready` | Scoped and pick-up-able. A concrete bug with a repro or symptom, or a small feature with known target behavior. |
| `peek:triage` | Needs a scoping conversation before work can start. Vague ideas, big features without scope, exploratory questions. |

The intersection is the actionable queue — this is the query you usually want:

```js
mcp__peek__list_items({ tags: ['peek:todo', 'peek:ready'] })
```

Rule of thumb: if you can write a clear "done looks like…" in the content, it's
`peek:ready`. If the body is "explore X" or a one-phrase musing, it's
`peek:triage`.

#### `peek:ready` is a contract, not an impression

An item is `peek:ready` only when its body carries both of these sections:

```markdown
## Done looks like
<observable end state — what is true afterward that is not true now>

## Verify
<a command that exists in package.json, plus what passing output looks like>
```

Without them the item is `peek:triage`, whatever else is true about it. The
reason is mechanical: a background agent that finds no acceptance criteria
invents its own, and a reviewer with none to check against falls back to
"looks fine". The intersection `peek:todo` + `peek:ready` is what the
`dispatch` skill claims from unattended, so the two sections are the difference
between queued work and work an agent can be trusted to finish alone.

Writing them is the `triage-pass` skill's job. Anything it cannot write with
confidence stays `peek:triage` and surfaces as a question rather than a guess.

When a task leaves `peek:todo`, clear its quality marker in the same breath —
don't strand `peek:ready` on a done item.

### Scope tags — which app does this touch?

| Tag | When |
|---|---|
| `peek:scope:desktop` | Only `apps/desktop` |
| `peek:scope:mobile` | Only `apps/mobile` |
| `peek:scope:server` | Only `apps/server` |
| `peek:scope:extension` | Only `apps/extension` |
| `peek:scope:cross` | Explicitly touches multiple apps or `packages/` |

Omit when you don't know — an unscoped item is a triage-pass job. Don't guess.

### Topic tags are OPEN — statuses are not

Statuses and quality markers are a closed set: queries depend on the exact
intersection, so inventing one silently drops items out of the queue everyone
reads.

Topic tags are the opposite. **The server enforces no allowlist** — it checks
namespace only (`apps/desktop/features/mcp-server/server.js` `validateWriteTags`
rejects foreign prefixes like `other:thing`; any `peek:*` string passes). Pick
the tag that fits. But:

**Check `list_tags` before inventing one.**

```js
mcp__peek__list_tags({ search: 'peek:' })
```

Reuse beats coining. This repo already carries `peek:test`, `peek:test-coverage`,
and `peek:test-failure` — three tags for one idea, each created by an agent who
didn't look first.

In use today, as a starting point rather than a fence: `peek:bug`,
`peek:regression`, `peek:feature`, `peek:perf`, `peek:security`, `peek:design`,
`peek:docs`, `peek:meta`, `peek:tooling`, `peek:daily-use`, `peek:foundation`,
`peek:test-coverage`, `peek:tile-arch`, `peek:cmd`, `peek:editor`,
`peek:chrome-extensions`, `peek:extensions`, `peek:atproto`, `peek:desktop`,
`peek:mobile`, `peek:tauri`.

`peek:deferred` is retired. If you'd reach for it, the honest move is
`peek:wontfix` (we're not doing this) or `peek:triage` (the path needs deciding).

### `peek:needs-review` — agent done, user approval pending

Work shipped (commits landed on `main` via the chokepoint scripts, suite green)
but NOT yet `peek:done`. Tests and LLM review are necessary, not sufficient — the
user is the final gate. Move the item to `peek:needs-review`, surface the diff and
the test result, and let their approval flip it to `peek:done`. See the
`/agent-review` skill.

### Starred tracking items

A `META:`-prefixed, `peek:starred` item aggregates high-signal findings — a
reference for deciding what to work on next.

```js
mcp__peek__list_items({ tags: ['peek:starred'] })
```

Scan these when the user asks open-endedly what to work on. When they name a
specific task, just do it — don't fetch these, don't redirect. If a finding bears
on their task, one line, then move on.

### Open a task in Peek for collaborative editing

The MCP server is a standalone Node subprocess talking to `datastore.sqlite`
directly — it cannot publish pubsub events to a running Peek desktop app, so it
can't open anything. Hand off through the cmd panel instead:

1. Resolve the item and get its id.
2. Tell the user to hit cmd (default `Option+Space`) and type
   `edit <title-fragment>` — that routes through `edit` in
   `app/cmd/commands/edit.js`, which publishes `editor:open { itemId }`.
3. They type in Peek; you read with `get_item` and write with `update_item`. The
   editor reloads on `editor:changed`.

### Don'ts

- **Don't read or write `docs/tasks.md`** — it's a one-line legacy pointer at this
  queue. Treat it as read-only.
- **Don't create duplicates.** Search before `create_item`:
  `search_items({ query: '<keywords>', tags: ['peek:todo'] })`.
- **Don't echo created or updated content** back in chat unless asked. Acknowledge
  with the title.
