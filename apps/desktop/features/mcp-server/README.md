# Peek MCP Server

The Peek MCP server lets Claude Code (and any other MCP client) read and
write Peek items — tasks, tags, events — over the standard Model
Context Protocol. It runs as a stdio child process spawned by the MCP
client, reading and writing the same SQLite datastore the Peek app
uses.

Source of truth for design intent lives in [`PLAN.md`](./PLAN.md). This
README covers what the server *currently does* and how to use it.

---

## Install in a project

```sh
/Applications/Peek.app/Contents/Resources/peek-mcp-init <scope>            # read-only
/Applications/Peek.app/Contents/Resources/peek-mcp-init <scope> --writes   # mutating tools enabled
```

Run from the project root. `<scope>` is a Peek tag — the session will
only see items tagged `<scope>` or `<scope>:*`. Pick something
project-specific (e.g. `peek` for the mpeek repo, `wonderwall` for the
Wonderwall project, etc.).

The scaffolder writes three sibling files, each with one job:

| File | Purpose | Committed? |
|---|---|---|
| `.mcp.json` | MCP server entry, scoped to `<scope>`/`<scope>:*` | usually gitignored (absolute paths) |
| `.claude/settings.local.json` | auto-allow for `mcp__peek__*` tools | gitignored (per-user) |
| `.claude/skills/peek.md` | per-project Peek skill (conventions) | up to you |

**Always fully quit and reopen Claude Code** after running. The MCP
child caches env vars at spawn — re-approving the `/mcp` prompt is
not enough.

### Flags

| Flag | Default | Effect |
|---|---|---|
| `--writes` | off | Enable the 7 mutating tools (`create_item`, `update_item`, `delete_item`, `tag_item`, `untag_item`, `record_event`, `complete_task`) |
| `--profile <name>` | `default` | Which Peek profile's datastore to expose |
| `--force` | off | Overwrite an existing differing `mcpServers.peek` entry |
| `--no-allow` | off | Skip the `permissions.allow` write |
| `--no-skill` | off | Skip the skill scaffold/refresh |

### Re-running

Re-running `peek-mcp-init` in an already-scaffolded project is safe and
idempotent:

- `.mcp.json` — updates if the entry differs, otherwise no-op.
- `.claude/settings.local.json` — appends only missing allow entries, no duplicates, no clobber of other entries.
- `.claude/skills/peek.md` — refreshes the auto-managed section
  (between `<!-- PEEK_SKILL_BODY_BEGIN -->` and `<!-- PEEK_SKILL_BODY_END -->`).
  Everything below `BODY_END` is preserved verbatim, so per-project
  conventions you add survive the next Peek upgrade.

---

## What the server exposes

### Tools

Read-only (always available):

- `list_items`, `search_items`, `get_item`, `list_tags`, `list_tasks`, `get_task_context`

Mutating (only when `PEEK_MCP_READONLY=0`, set by `--writes`):

- `create_item`, `update_item`, `delete_item`, `tag_item`, `untag_item`, `record_event`, `complete_task`

#### `search_items` — tokenized, ranked text search

`search_items({ query })` is the tool to reach for when you don't already know
an item's id or exact tag. It is **not** a single-substring match:

- **Tokenized, AND semantics.** The `query` is split on whitespace into terms.
  EVERY term must appear, but each term may match in ANY field. So
  `query: "mcp fix"` matches an item whose title has "mcp" and whose content
  has "fix" — the old whole-string `%mcp fix%` match returned nothing for that.
- **Fields searched:** `title`, `content`, `domain`, and `tags` (a term can
  match a tag name).
- **Ranked by relevance.** Per term, the strongest field it hit drives the
  score (`title` 10 > `tag` 6 > `domain` 4 > `content` 2), plus a small bonus
  for each additional field the same term also hit; matching more distinct
  terms always outranks fewer. `frecencyScore` then `updatedAt` are tiebreaks
  only. The numeric `score` is returned on each result.
- **Snippets.** Each result carries a `snippet` — a short window of text around
  the first matched term — so you can judge relevance without opening each item.
- **Field-aware (`tags` filter).** Combine text + tags in one call:
  `search_items({ query: "fix", tags: ["mcp"] })` restricts text matches to
  items that ALSO carry all listed tags (same shape as `list_items`' filter).
  Add a `type` filter the same way.
- **Wildcards are literal.** `%` and `_` in the query are escaped, so
  `"100% done"` matches that literal text rather than acting as LIKE wildcards.
- Scope-confined like every other read: a scoped session never sees
  out-of-scope or untagged items in search results.

### Resources

- `peek://tasks` — all items tagged `todo` (within scope)
- `peek://tasks/<tag>` — tasks intersected with `<tag>` (within scope)
- `peek://tags` — all tags with item counts (within scope)

---

## Conventions you should know

These are encoded in the scaffolded `.claude/skills/peek.md` and
enforced server-side where relevant. Summarized here for humans.

### Status vocabulary

| Tag | Meaning |
|---|---|
| `<scope>:todo` | In the queue, not started |
| `<scope>:wip` | Actively being worked |
| `<scope>:needs-review` | Agent done; user approval pending |
| `<scope>:done` | Shipped and accepted |
| `<scope>:future` | Parking lot |
| `<scope>:wontfix` | Closed without shipping |

Use the namespaced tags. **Do not** use bare `todo`/`done` — those are
cross-project and will pollute every other Peek consumer.

### The bare-tag trap

`mcp__peek__list_tasks()` defaults to `tags: ['todo']` (bare) and
`mcp__peek__complete_task()` is hardcoded to add bare `done` and remove
bare `todo`. Neither respects the scope tag's namespace.

- ✅ `list_items({ tags: ['<scope>:todo'] })` — correct
- ✅ Manual `tag_item` (new status) + `untag_item` (old status) +
  `record_event` for status changes

### Item-id prefix resolution (git-short-hash style)

Every tool that takes an `itemId` accepts a **unique leading prefix** of
an id, not just the full id — exactly like a git short hash. Both id
shapes work: UUID (`14efdd97-…`) and timestamp (`item_1780…_0biqk…`).

- **Exact full-id match always wins** and short-circuits before any
  prefix logic (so a full id is never treated as ambiguous even if it is
  also a prefix of other ids).
- **Unique prefix** → resolves to that one item.
- **Ambiguous prefix** → hard error listing the candidate ids + titles,
  so you can disambiguate. Mutating tools never act on a guess.
- **Unknown prefix** → not-found (read tools return `null`, the same as a
  full-id miss; mutating tools error).

This applies to the read paths (`get_item`, `get_task_context`) and the
lookup-by-id mutating tools (`update_item`, `delete_item`, `tag_item`,
`untag_item`, `record_event`, `complete_task`). For `delete_item` the
**resolved full id** is echoed back in the result so you see exactly what
was deleted.

Resolution is a single index-anchored SQL query (`id LIKE 'prefix%'`
against the `items.id` primary key, with `_`/`%` escaped so literal
underscores in timestamp ids aren't treated as wildcards) — no JS table
scan.

**Scope-confined.** In a scoped session (`PEEK_MCP_SCOPE_TAG` set),
resolution considers ONLY in-scope items (tagged `<scope>` or `<scope>:*`)
for both the exact-match and prefix paths — the scope restriction is part
of the same SQL query (an `EXISTS` over the item↔tag join), so the
candidate limit can't cut off an in-scope match that sorts behind an
out-of-scope one. Consequences from the scoped session's view:

- A prefix that uniquely identifies one in-scope item resolves cleanly,
  even if out-of-scope items share that prefix.
- Ambiguity is computed over in-scope candidates only, and the candidate
  list in the error never names out-of-scope ids/titles (no leak).
- A prefix — or even an exact full id — matching only out-of-scope items
  reads as **not-found**, indistinguishable from a missing id (it does not
  report "exists but out of scope", which would itself leak existence).

Unscoped sessions are unaffected — resolution spans the whole table.

```js
// Agents already refer to items by the leading id segment — now it just works.
mcp__peek__get_item({ itemId: '14efdd97' })       // → the 14efdd97-… item
mcp__peek__update_item({ itemId: '14efdd97', title: '…' })
```

### Hashtag extraction is opt-in

By default `create_item` treats `#word` patterns in `content` as
literal text. LLM callers routinely write `#123` issue refs or `#3)`
enumeration prose — those would silently become tags if extracted by
default.

```js
// Default: hashtags stay as text
mcp__peek__create_item({
  type: 'text',
  title: 'Fix issue',
  content: 'fixes #123 in the auth flow',
  tags: ['<scope>:todo'],
})
// → item.tags === ['<scope>:todo']

// Opt-in: UI-style auto-tagging
mcp__peek__create_item({
  type: 'text',
  title: 'Meeting notes',
  content: 'discussed #alice and #project',
  extractHashtags: true,
})
// → item.tags === ['<scope>:todo', 'alice', 'project'] (text items only)
```

### Untag refuses to orphan

`untag_item` refuses to remove a `<scope>` or `<scope>:*` tag if doing
so would leave the item with **no** in-scope tags — that would
silently push the item out of the session's visible scope.

Safe pattern: **add the new status tag before removing the old one.**
Once both tags are on the item, dropping either is allowed.

### Restart-required UX

The MCP server is a long-lived child process. Env vars are frozen at
spawn. Whenever you change any of these:

- Peek's Settings → Integrations → MCP toggle / scope / profile / Allow writes
- The `peek-mcp` binary itself (Peek rebuild + install)
- The on-disk `mcpServers.peek` entry env

…the running child won't pick up the change. Fully quit and reopen
Claude Code in the directory. Re-approving `/mcp` is not enough.

The server self-exits on **env mismatch** between its spawn env and
the on-disk settings (drift self-exit, see PLAN.md), so settings
changes can recover without intervention. But binary changes (a Peek
rebuild) do **not** trigger this — that one is fully user-action.

---

## Architecture

```
Claude Code  ⇄  stdio  ⇄  peek-mcp launcher  ⇄  server.js  ⇄  SQLite (Peek datastore)
```

- `peek-mcp` (launcher at `Contents/Resources/peek-mcp`) — Electron-as-Node wrapper so external clients don't need system Node. Dev mode falls through to `node --experimental-sqlite server.js`.
- `server.js` — stdio JSON-RPC server. Registers tools, dispatches requests, enforces scope, runs drift self-exit pre-message.
- `db.js` — SQLite helpers (open, query, write). Mirrors policy in `apps/desktop/main/datastore.ts` — see [`project_datastore_policy_owner`](../../../../CLAUDE.md) memory for details.
- `setup.js` — the scaffolder, invoked via `peek-mcp --install …` or its `peek-mcp-init` wrapper.
- `peek-skill-template.js` — generic skill body bundled in the app, copied into each project by `setup.js`.
- `background.html` + `manifest.json` — the Peek-side tile that owns Settings → Integrations → MCP UI.

### Claude Code config locations (2.1.204)

- **User scope** = `~/.claude.json`, top-level `mcpServers`. This is what
  Peek's global toggle writes.
- **Project scope** = `<project>/.mcp.json`, top-level `mcpServers`.
- `settings.json` `mcpServers` is **NOT read** by Claude Code — neither
  `~/.claude/settings.json` nor `<cwd>/.claude/settings.json`. Writing there
  is a dead location; Peek used to and no longer does.

### Dev/prod settings isolation

`mcp-config.ts` (the Settings UI toggle) writes to `~/.claude.json`
**only** when the running Peek is *packaged* AND on the `default`
profile. Dev builds and non-default profiles write to
`<userData>/mcp-sandbox/claude.json` instead, so iterating on Peek can't
trample your real Claude Code config. `migrateMcpConfigLocation()` runs
once at boot to move any legacy `~/.claude/settings.json` `mcpServers.peek`
entry to `~/.claude.json`.

---

## Running tests

```sh
node --test apps/desktop/features/mcp-server/server.test.js
node --test apps/desktop/features/mcp-server/schema-drift.test.js
```

Tests spawn the server in a `mkdtempSync` isolated HOME so the drift
self-exit can't see your real `~/.claude.json`. The `McpClient` helper
in `server.test.js` bakes that in — copy it for any new test files.

Manual server smoke test:

```sh
./apps/desktop/features/mcp-server/run.sh
# (then pipe MCP JSON-RPC at stdin)
```

---

## Related

- [`PLAN.md`](./PLAN.md) — original spec + cumulative "current state" notes.
- `apps/desktop/main/datastore.ts` — canonical policy owner for frecency, slug, hashtag, cascade, pubsub. Any new behavior here must be mirrored or the MCP server diverges.
- `~/.claude/CLAUDE.md` (user-private) — short global hint that tells Claude how to scaffold Peek into a new project.
