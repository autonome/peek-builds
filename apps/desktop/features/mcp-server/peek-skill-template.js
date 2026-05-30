// Template for the per-project Peek skill scaffolded by `peek-mcp-init`.
// peek-mcp-init writes/refreshes <cwd>/.claude/skills/peek.md, substituting
// {SCOPE} with PEEK_MCP_SCOPE_TAG. Content between BODY_BEGIN and BODY_END is
// auto-managed (refreshed on every peek-mcp-init run). Anything after BODY_END
// is preserved across re-runs, so each project can append its own conventions.

export const BODY_BEGIN = '<!-- PEEK_SKILL_BODY_BEGIN -->';
export const BODY_END = '<!-- PEEK_SKILL_BODY_END -->';

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

## Avoid the bare-tag defaults

- \`mcp__peek__list_tasks()\` defaults to \`tags: ['todo']\` (BARE) — surfaces every project's todos. Use \`list_items({ tags: ['{SCOPE}:todo'] })\` instead.
- \`mcp__peek__complete_task({ itemId })\` adds bare \`done\`, removes bare \`todo\` — does NOT touch \`{SCOPE}:todo\` / \`{SCOPE}:done\`. Do status changes manually (below).

## Status vocabulary

| Tag | Meaning |
|---|---|
| \`{SCOPE}:todo\` | In the queue, not started |
| \`{SCOPE}:wip\` | Actively being worked |
| \`{SCOPE}:needs-review\` | Agent done; user approval pending |
| \`{SCOPE}:done\` | Shipped and accepted |
| \`{SCOPE}:future\` | Parking lot — not now, not no |
| \`{SCOPE}:wontfix\` | Closed without shipping |

Don't invent new statuses. Don't use bare \`todo\` / \`done\` — those are cross-project.

## Add a task

\`\`\`js
mcp__peek__create_item({
  type: 'text',
  title: 'Short imperative title',
  content: '# Short imperative title\\n\\n## Problem\\n\\n...\\n\\n## Plan\\n\\n...',
  tags: ['{SCOPE}:todo'],  // plus any project-specific tags from the section below
})
\`\`\`

**\`create_item\` force-adds the bare \`{SCOPE}\` tag.** The scope guard appends bare \`{SCOPE}\` to every item you create so it can't land outside your namespace. The \`tags\` array you pass IS honored — it is not ignored or collapsed. Because you already pass a \`{SCOPE}:*\` status tag, the bare \`{SCOPE}\` is redundant and pollutes the reserved bare-tag intake; drop it with one \`untag_item\` call right after create:

\`\`\`js
const item = mcp__peek__create_item({ type: 'text', title: '…', content: '…', tags: ['{SCOPE}:todo'] })
mcp__peek__untag_item({ itemId: item.id, tagName: '{SCOPE}' })  // remove the auto-added bare tag
\`\`\`

This is safe: the \`{SCOPE}:todo\` tag keeps the item in scope, so the orphan guard allows the untag.

**Hashtags in content do NOT auto-tag by default.** \`#123\` issue refs and \`#3)\` enumerations stay as plain text. Pass \`extractHashtags: true\` only when you genuinely want \`#word\` patterns from text-type content auto-tagged.

**"Add task: ..." mid-session is intake, not redirect.** Capture it, keep working on the current task. Don't pivot unless the user explicitly tells you to switch.

## List tasks

\`\`\`js
// Actionable queue
mcp__peek__list_items({ tags: ['{SCOPE}:todo'] })

// Parking lot
mcp__peek__list_items({ tags: ['{SCOPE}:future'] })
\`\`\`

## Status changes — manual untag + tag + event

\`mcp__peek__complete_task\` won't work (bare tags). Do it by hand:

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
