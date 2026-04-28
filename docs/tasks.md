# Peek Task Queue

The active task queue lives in **Peek itself**, not in this file.

Query: items tagged `peek:todo` (intersect with `peek:desktop` / `peek:bug` / `peek:feature` / `peek:test-coverage` / etc. to narrow).

- MCP: `mcp__peek__list_items({tags: ["peek:todo"]})`
- Cmd panel: `#peek:todo` (or `#peek:todo #peek:desktop` etc.)

Migrated 2026-04-28: 16 active engineering todos (`[ ]`) moved into Peek as items with markdown bodies and `peek:*` machine tags. Plus ~245 existing `#peek` items had their bare `#todo` / `#desktop` / `#mobile` / `#daily-use` tags replaced with `peek:*` equivalents. The bare `#peek` project tag stays as the namespace marker, in advance of project workspaces.
