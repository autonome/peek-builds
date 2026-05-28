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

- `list_items`, `get_item`, `list_tags`, `list_tasks`, `get_task_context`

Mutating (only when `PEEK_MCP_READONLY=0`, set by `--writes`):

- `create_item`, `update_item`, `delete_item`, `tag_item`, `untag_item`, `record_event`, `complete_task`

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

### Dev/prod settings isolation

`setup.js` writes to `~/.claude/settings.json` **only** when the
running Peek is *packaged* AND on the `default` profile. Dev builds
and non-default profiles write to `<userData>/mcp-sandbox/claude-settings.json`
instead, so iterating on Peek can't trample your real Claude Code
config.

---

## Running tests

```sh
node --test apps/desktop/features/mcp-server/server.test.js
node --test apps/desktop/features/mcp-server/schema-drift.test.js
```

Tests spawn the server in a `mkdtempSync` isolated HOME so the drift
self-exit can't see your real `~/.claude/settings.json`. The
`McpClient` helper in `server.test.js` bakes that in — copy it for any
new test files.

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
