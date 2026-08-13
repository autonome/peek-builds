// Template for the per-project Peek skill scaffolded by `peek-mcp-init`.
// peek-mcp-init writes/refreshes <cwd>/.claude/skills/peek.md, substituting
// {SCOPE} with PEEK_MCP_SCOPE_TAG. Content between BODY_BEGIN and BODY_END is
// auto-managed (refreshed on every peek-mcp-init run). Anything after BODY_END
// is preserved across re-runs, so each project can append its own conventions.

export const BODY_BEGIN = '<!-- PEEK_SKILL_BODY_BEGIN -->';
export const BODY_END = '<!-- PEEK_SKILL_BODY_END -->';

// Spliced into the managed body, ahead of "## Tag model", only when
// peek-mcp-init scaffolds a remote-mode entry (--remote). Stays inside
// BODY_BEGIN/END so it's refreshed on every re-run like the rest of the body.
export const REMOTE_PARAGRAPH = `
**This session talks to a remote Peek server, not a local datastore.** Item
ids are server ids; each item also carries \`localId\`, the id shown in the
desktop UI (empty if the item hasn't synced there yet). There is no offline
mode — a tool call fails loudly, naming the unreachable server, rather than
degrading to a stale or empty result.
`;

// Frontmatter + auto-managed body. {SCOPE} gets substituted at scaffold time.
export const TEMPLATE_BODY = `---
name: peek
description: "Peek is the user's personal task/knowledge system, accessed via mcp__peek__* tools — the DEFAULT place for this project's tasks, todos, and notes (an external service like an issue tracker, NOT part of the codebase). Whenever the user mentions a task, todo, backlog, says 'add task' / 'remind me' / 'track this', or asks what to work on, reach for the Peek MCP (list_items / create_item / tag_item in the {SCOPE}:* namespace) by DEFAULT — do not fall back to an ad-hoc or built-in todo list."
---

# Peek — task & knowledge tools ({SCOPE} scope)

${BODY_BEGIN}

**Peek is an external task and knowledge management system** — like a
personal issue tracker. It is NOT part of this project's codebase. You
interact with it through \`mcp__peek__*\` tool calls to read and manage
the user's tasks, notes, and reference items.

This session is scoped to items tagged \`{SCOPE}\` or \`{SCOPE}:*\`
(enforced server-side via \`PEEK_MCP_SCOPE_TAG={SCOPE}\`). Keep all work
inside that namespace so tag conventions stay clean.

## Tag model

- **\`{SCOPE}\` is the membership tag.** Every item in this scope carries the bare \`{SCOPE}\` tag, always. It is what makes the item part of this project. All \`{SCOPE}:*\` tags are additive refinements layered on top of it — status, area, topic.
- **\`{SCOPE}\` and nothing else means untriaged.** An item tagged only \`{SCOPE}\` (no \`{SCOPE}:*\` tag) is in the triage inbox. The scope-tag-only set is your intake queue — process it regularly. Adding a \`{SCOPE}:*\` status tag (e.g. \`{SCOPE}:todo\`) moves the item out of intake and into the worked queue.

\`\`\`js
// The triage inbox: items that carry only the membership tag.
mcp__peek__list_items({ tags: ['{SCOPE}'] })
\`\`\`

## Status lives in the \`{SCOPE}:*\` namespace

Status is one of these namespaced tags:

| Tag | Meaning |
|---|---|
| \`{SCOPE}:todo\` | In the queue, not started |
| \`{SCOPE}:wip\` | Actively being worked |
| \`{SCOPE}:needs-review\` | Agent done; user approval pending |
| \`{SCOPE}:done\` | Shipped and accepted |
| \`{SCOPE}:future\` | Parking lot — not now, not no |
| \`{SCOPE}:wontfix\` | Closed without shipping |

Don't invent new statuses. Never use bare \`todo\` / \`done\` — those are unnamespaced and shared across every project. Two MCP defaults trip on this, so do status changes by hand in the \`{SCOPE}:*\` namespace:

- \`mcp__peek__list_tasks()\` defaults to \`tags: ['todo']\` (BARE) — surfaces every project's todos. Use \`list_items({ tags: ['{SCOPE}:todo'] })\` instead.
- \`mcp__peek__complete_task({ itemId })\` writes bare \`done\` / \`todo\` — does NOT touch \`{SCOPE}:todo\` / \`{SCOPE}:done\`. Do status changes manually (below).

## Add a task

\`\`\`js
mcp__peek__create_item({
  type: 'text',
  title: 'Short imperative title',
  content: '# Short imperative title\\n\\n## Problem\\n\\n...\\n\\n## Plan\\n\\n...',
  tags: ['{SCOPE}:todo'],  // plus any project-specific tags from the section below
})
\`\`\`

**\`create_item\` auto-adds the bare \`{SCOPE}\` membership tag** so the item can't land outside your namespace; the \`tags\` you pass are kept alongside it. Pass a \`{SCOPE}:*\` status tag to land the item in the worked queue; omit one and it waits in the triage inbox.

**Hashtags in content do NOT auto-tag by default.** \`#123\` issue refs and \`#3)\` enumerations stay as plain text. Pass \`extractHashtags: true\` only when you genuinely want \`#word\` patterns from text-type content auto-tagged.

**"Add task: ..." mid-session is intake, not redirect.** Capture it, keep working on the current task. Don't pivot unless the user explicitly tells you to switch.

## List tasks

\`\`\`js
// Actionable queue
mcp__peek__list_items({ tags: ['{SCOPE}:todo'] })

// Parking lot
mcp__peek__list_items({ tags: ['{SCOPE}:future'] })
\`\`\`

## Find an item

**Search by content with \`search_items\` — don't dump \`list_items\` and eyeball it.**

\`\`\`js
mcp__peek__search_items({ query: 'sync retry' })                     // all terms must match
mcp__peek__search_items({ query: 'retry', tags: ['{SCOPE}:todo'] })  // text + tag filter
\`\`\`

The query is tokenized on whitespace with AND semantics — every term must appear, each matchable in the title, content, or tags. Results are relevance-ranked (title > tag > content) and each carries a \`snippet\` around the first match, so you can pick the right item without opening each one.

**Look up by id prefix.** \`get_item\` — and every lookup-by-id tool — accepts a unique leading PREFIX of an id, git-short-hash style. Paste the short id you saw in a listing or reference:

\`\`\`js
mcp__peek__get_item({ itemId: '14efdd97' })   // resolves when the prefix is unique
\`\`\`

An ambiguous prefix errors and lists the candidates — pass more of the id to disambiguate.

## Status changes — manual untag + tag + event

Tag the new status, untag the old, and record an event:

\`\`\`js
mcp__peek__tag_item({ itemId, tagName: '{SCOPE}:done' })
mcp__peek__untag_item({ itemId, tagName: '{SCOPE}:todo' })
mcp__peek__record_event({
  itemId, type: 'completed', value: 'shipped in <ref>',
})
\`\`\`

Always **tag the new status before untagging the old** — \`untag_item\` refuses if removing the tag would orphan the item from the scope (i.e. no other \`{SCOPE}\` or \`{SCOPE}:*\` tag remains). Adding the new status first satisfies the orphan check.

## After settings or binary changes — fully restart Claude Code

The MCP server is a child process spawned by Claude Code; env vars are frozen at spawn. Changes to Peek's settings (scope tag, readonly toggle, profile) OR a rebuild of Peek itself leave the running child on the OLD code/env. Fully quit and reopen Claude Code in this directory to refresh. Re-approving the \`/mcp\` prompt is NOT enough.

${BODY_END}

## Project-specific

<!-- Edit below this line freely. Everything above the BODY_END marker is
     auto-managed by peek-mcp-init and refreshed on every re-run.
     Anything below this line survives. Add tag vocabulary, scope-narrowing
     patterns, or any other project-only conventions here. -->
`;
