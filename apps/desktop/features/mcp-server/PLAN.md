# MCP Server — Implementation Plan

A Peek feature (tile) that exposes Peek's data and capabilities via Model Context Protocol, enabling Claude Code and other MCP clients to query items, manage tasks, and interact with Peek programmatically.

> ## Current state (as of 2026-05-27)
>
> The original plan below has shipped (Phases 1–3) and been extended. This summary captures behavior the design doc doesn't cover.
>
> ### Packaging + install
> - Bundled launcher: `/Applications/Peek.app/Contents/Resources/peek-mcp` (Electron-as-Node, no system Node required). Dev mode falls through to `node --experimental-sqlite server.js`.
> - CLI scaffolder: `peek-mcp --install [--scope <tag>] [--mcp-json] [--writes] [--profile <name>]`. Thin wrapper `peek-mcp-init <tag>` shipped at `Contents/Resources/peek-mcp-init` writes `<cwd>/.mcp.json`.
> - In-app: Settings → Integrations → MCP server. Global toggle + scope tag + profile dropdown + Allow writes. (Per-project "Project scopes" subsection landed in `mcp-followups` bookmark; unverified — see peek item `2caccd6e`.)
>
> ### Scope tag (`PEEK_MCP_SCOPE_TAG`)
> Hard-fences a session to items tagged `<scope>` or `<scope>:*`. Server-side enforcement in every tool dispatcher; bare shared tags (`todo`, `done`) are permitted, foreign namespaces (`other:*`) rejected on writes.
>
> ### Read-only mode (`PEEK_MCP_READONLY=1`)
> Hides mutating tools from `tools/list` and rejects them on `tools/call`. Off by default — users must opt in via Settings → Allow writes.
>
> ### Dev/prod settings isolation
> `mcp-config.ts` writes to `~/.claude/settings.json` **only** when packaged AND running the `default` profile. Dev builds and non-default profiles write to `<userData>/mcp-sandbox/claude-settings.json` instead, so a dev session can't trample the real Claude Code config. The Settings UI status line shows the active path.
>
> ### Drift self-exit
> `server.js` runs `checkConfigDrift()` before each incoming JSON-RPC message. It walks `<cwd>/.mcp.json` → `<cwd>/.claude/settings.json` → `~/.claude/settings.json`, finds the first file with an `mcpServers.peek` entry, and compares its `env` to `process.env` for `PEEK_MCP_SCOPE_TAG`, `PEEK_MCP_READONLY`, `PEEK_DB_PATH`. On mismatch — or if the peek entry was removed from all known config paths — it logs to stderr and `process.exit(0)` so the client respawns with fresh env.
>
> Why: env is frozen at spawn. Without this check, settings changes mid-session silently went wrong. The check also masks the gap that Claude Code (the harness) doesn't restart MCP children on config-file change.
>
> **Tests using `McpClient` must isolate `HOME` and `cwd`** (`mkdtempSync` is the pattern in `server.test.js`) — otherwise the drift check finds the real user's `~/.claude/settings.json` and exits the process. The `McpClient` helper bakes this in.
>
> ### Restart-required UX
> Two surfaces communicate that a settings change does NOT propagate to a running MCP client:
> - **Settings UI banner.** After any save that changes the effective MCP snippet (enabled/profile/scope/readonly), a yellow info banner appears: *"Restart Claude Code to apply. The change is saved, but any MCP client already running won't pick it up until you fully quit and reopen it. Re-approving in /mcp is not enough."* Persists until dismissed; idempotent saves don't re-trigger.
> - **`peek-mcp-init` post-write warning.** TTY bold/yellow text on stderr after the snippet is written, explicit that `/mcp` re-approval is insufficient and that the reinstall case has the same hazard (running child has the old binary).
>
> ### Item-id prefix resolution (shipped)
> Every tool that accepts an `itemId` resolves a unique leading PREFIX of an
> id (git-short-hash style), not just the full id. One shared resolver
> (`resolveItemId` in `db.js`) does exact-match-first (short-circuits), then a
> single index-anchored `id LIKE 'prefix%'` query (escaped `_`/`%`) against the
> `items.id` primary key. Exact match always wins; ambiguous prefixes hard-error
> with the candidate id+title list (never silently pick / never mutate a guess);
> unknown prefixes are not-found (read tools → `null`, mutating tools → error).
> `delete_item` echoes the resolved full id. Motivation: agents already cite the
> leading id segment (`14efdd97`); this makes that shorthand resolve instead of
> forcing a `list_items` + content-triangulation fallback.
>
> ### Minted short canonical IDs — DEFERRED (intentionally not done)
> A more invasive alternative to prefix resolution is to mint a *short canonical
> id* (e.g. a 7–8 char base32 handle) and make it the primary item handle.
> What it would take:
> - **Schema:** add a `shortId` column on `items` in `packages/schema/v1.json`
>   with a UNIQUE index; collision-retry on mint.
> - **Backfill migration:** generate a `shortId` for every existing row
>   (one-time, owned by the datastore — and the schema-drift test would need the
>   new column).
> - **Mint path:** new ids get a `shortId` at creation; `apps/desktop/main/datastore.ts`
>   is the policy owner for id minting, so it would have to lead — the MCP `db.js`
>   only mirrors datastore policy, it must not unilaterally introduce an id scheme.
> - **Surfacing:** every MCP response (and ideally the app UI) would expose the
>   short id as the primary handle so callers learn/use it.
> This was deferred because prefix resolution is **zero-migration**, touches only
> the MCP server, and immediately makes the shorthand agents already use work.
> Minted ids are a future call if/when a stable, human-quotable short handle (not
> just "a unique prefix of the moment") is wanted — revisit with datastore.ts as
> the owner.
>
> Original Phase-3 plan below stays for historical reference. The MCP feature is shipped — keep this doc updated as the surface evolves.

## Overview

This is a background tile that starts an MCP server (stdio or HTTP/SSE transport). Claude Code connects to it as an MCP server in its config. The server exposes Peek's datastore, tags, and item operations as MCP tools and resources.

## MCP Basics

MCP servers expose:
- **Tools** — callable functions (e.g., `list_items`, `create_item`, `tag_item`)
- **Resources** — readable data (e.g., `peek://items/tagged/todo+peek`)
- **Prompts** — reusable prompt templates (optional)

Transport options:
- **stdio** — server is a subprocess, communicates via stdin/stdout. Simplest for local CLI tools.
- **HTTP+SSE** — server listens on a port, communicates via HTTP POST (client→server) and SSE (server→client). Better for persistent connections.

For Claude Code integration, **stdio** is the standard approach — Claude Code spawns the server as a child process.

## Architecture

The MCP server runs as a standalone Node.js process (not inside Electron). It reads Peek's SQLite database directly (read-only + WAL mode for safety while Peek is running). For write operations, it writes to the database and Peek picks up changes on next query.

```
Claude Code ←→ MCP Server (Node.js subprocess) ←→ Peek SQLite DB
                                                 ←→ Peek (picks up changes)
```

Why not inside Electron:
- MCP stdio transport needs a clean stdin/stdout — Electron's main process has its own stdio
- Claude Code spawns MCP servers as subprocesses — can't spawn Electron for this
- Direct SQLite access is simpler and faster than routing through Electron IPC
- The server can run whether or not Peek is open

The Peek tile's role: provides UI for configuring the MCP server, shows connection status, and manages the server lifecycle. The actual MCP server is a separate script the tile registers with Claude Code's config.

## MCP Tools

### Task/Item Management

**`list_items`** — Query items by tags, type, date range
- Params: `tags?: string[]` (items must have ALL listed tags), `type?: string`, `limit?: number`, `offset?: number`, `sort?: 'recent' | 'frecency'`
- Returns: array of `{id, type, url, title, content, metadata, tags[], createdAt, updatedAt}`

**`get_item`** — Get a single item by ID
- Params: `itemId: string`
- Returns: full item with all metadata, tags, content, visits

**`create_item`** — Create a new item
- Params: `type: string, url?: string, title?: string, content?: string, metadata?: object, tags?: string[]`
- Returns: created item

**`update_item`** — Update item metadata/content
- Params: `itemId: string, title?: string, content?: string, metadata?: object`
- Returns: updated item

**`delete_item`** — Soft-delete an item
- Params: `itemId: string`

**`record_event`** — Add a timestamped event to an item (non-destructive)
- Params: `itemId: string, type: string, value?: string`
- Use case: Claude Code records "started working on task", "completed task", "blocked on X"

### Tag Operations

**`list_tags`** — List all tags, optionally filtered
- Params: `search?: string, limit?: number`
- Returns: array of `{id, name, itemCount}`

**`tag_item`** — Add a tag to an item
- Params: `itemId: string, tagName: string`

**`untag_item`** — Remove a tag from an item
- Params: `itemId: string, tagName: string`

### Peek-Specific

**`list_tasks`** — Convenience wrapper: items tagged with specified task tags
- Params: `tags?: string[]` (default: `['todo']`), `project?: string` (additional tag filter like 'peek', 'mobile')
- Returns: items sorted by creation date, with all tags included

**`complete_task`** — Mark a task item as done
- Params: `itemId: string, notes?: string`
- Action: adds `done` tag, removes `todo` tag, records completion event with notes

**`get_task_context`** — Get a task with surrounding context
- Params: `itemId: string`
- Returns: item + its tags + recent events + any linked/related items

## MCP Resources

**`peek://tasks`** — All items tagged #todo, as a readable resource
**`peek://tasks/{tag}`** — Tasks filtered by additional tag (e.g., `peek://tasks/peek`, `peek://tasks/mobile`)
**`peek://tags`** — All tags with item counts
**`peek://item/{id}`** — Single item detail

## File Structure

```
features/mcp-server/
  PLAN.md              — this file
  manifest.json        — tile manifest (background only, no UI needed initially)
  background.html/js   — tile that manages MCP server config and status
  server.js            — the actual MCP server (standalone Node.js, spawned by Claude Code)
  db.js                — SQLite read/write helpers (shared by server.js)
  setup.js             — script to configure Claude Code's MCP settings
```

## Database Access

SQLite with read-only default, write when needed:

```javascript
import Database from 'better-sqlite3';

const DB_PATH = '~/Library/Application Support/Peek/default/datastore.sqlite';
const db = new Database(DB_PATH, { readonly: false });
db.pragma('journal_mode = WAL');  // Safe concurrent access with Peek
db.pragma('busy_timeout = 5000'); // Wait if Peek has a write lock
```

Key queries:
```sql
-- Items by tags (all tags must match)
SELECT i.* FROM items i
  JOIN item_tags it ON i.id = it.itemId
  JOIN tags t ON it.tagId = t.id
  WHERE t.name IN (?, ?) AND i.deleted_at IS NULL
  GROUP BY i.id
  HAVING COUNT(DISTINCT t.id) = ?
  ORDER BY i.createdAt DESC;

-- Item's tags
SELECT t.name FROM tags t
  JOIN item_tags it ON t.id = it.tagId
  WHERE it.itemId = ?;

-- Record event
INSERT INTO item_events (itemId, type, value, timestamp)
  VALUES (?, ?, ?, ?);
```

## Claude Code Configuration

The setup script adds the MCP server to Claude Code's config:

```json
// ~/.claude/settings.json (or project settings)
{
  "mcpServers": {
    "peek": {
      "command": "node",
      "args": ["/path/to/peek/features/mcp-server/server.js"],
      "env": {
        "PEEK_DB_PATH": "~/Library/Application Support/Peek/default/datastore.sqlite"
      }
    }
  }
}
```

After setup, Claude Code automatically has access to all Peek MCP tools.

## Workflow: Autonomous Task Pickup

Once configured, the workflow:

1. User tags items in Peek: `#todo #peek #desktop`
2. In Claude Code, user says "check my Peek tasks" or Claude Code proactively calls `list_tasks(tags: ['todo', 'peek'])`
3. Claude Code sees the task list, asks user which to work on (or picks based on priority)
4. Claude Code calls `record_event(id, 'started', 'Working on this now')`
5. Claude Code implements the task
6. Claude Code calls `complete_task(id, 'Implemented in commit abc123')` — adds `done` tag, removes `todo`, records event
7. User sees the updated status in Peek

## Implementation Phases

### Phase 1 — MCP Server Core
1. `db.js` — SQLite helpers (open db, query items, query tags, write events)
2. `server.js` — MCP server with stdio transport, registers tools: `list_items`, `get_item`, `create_item`, `update_item`, `tag_item`, `untag_item`, `list_tags`
3. `setup.js` — Adds server to Claude Code MCP config
4. Test: run server manually, verify tool calls work

### Phase 2 — Task-Specific Tools
5. `list_tasks`, `complete_task`, `get_task_context` convenience tools
6. `record_event` for progress tracking
7. MCP resources: `peek://tasks`, `peek://tasks/{tag}`

### Phase 3 — Peek Tile Integration
8. `manifest.json` — tile manifest (background tile)
9. `background.js` — shows MCP server status, provides setup button
10. Optional: manage UI page showing connected clients, recent tool calls

## Dependencies

- `@modelcontextprotocol/sdk` — MCP server SDK (or implement protocol directly, it's simple JSON-RPC over stdio)
- `better-sqlite3` — already used by Peek, but the MCP server needs its own instance (separate process)
- Node.js — MCP server runs as standalone Node process

## Risks

1. **better-sqlite3 native module** — the MCP server process needs better-sqlite3 compiled for system Node, not Electron's Node. May need separate install or use `sql.js` (pure JS SQLite) instead.
2. **DB schema changes** — if Peek's schema changes, the MCP server queries break. Mitigate: read schema version, validate on startup.
3. **Write conflicts** — both Peek and MCP server writing to same DB. WAL mode handles concurrent reads safely. Writes: use busy_timeout, keep transactions short.
4. **DB path varies** — different profiles, different OS paths. The setup script must detect the correct path.
