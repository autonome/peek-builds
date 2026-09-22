---
enabled: true
touches: [apps/desktop/features/mcp-server/server.js, apps/desktop/tests/unit/mcp-write-response-shape.test.js]
depends-on: []
---

# Shape create_item / update_item / complete_task responses like get_item

Peek item `90ee2508`. The read side is done: `apps/desktop/features/mcp-server/server.js`
`shapeItemForResponse(item, args)` strips `favicon`, windows `content` (default 4000 chars,
`maxContentLength: -1` = unlimited, `contentOffset` pages) and sets `contentLength` /
`contentTruncated`; the `get_item` and `get_task_context` cases of `handleToolCall()` return
through it. The three write tools do not.

## What the code does now

In `handleToolCall()`:

- `create_item` returns `store.createItem({ ...args, tags: withScopeTag(args.tags) })` raw.
- `update_item` returns `store.updateItem(itemId, rest)` raw, where `rest` is `args` minus `itemId`.
- `complete_task` returns `store.completeTask(itemId, args.notes, args.accepted === true)` raw.

Both stores hand back the full item. `store/sqlite-store.js` `createItemSync()`,
`updateItemSync()` and `completeTaskSync()` each end with `return getItemSync(id)`, whose SELECT
includes `favicon` (so even a freshly created item carries `favicon: ''`) and the whole `content`.
`store/remote-store.js` `createItem()` / `updateItem()` / `completeTask()` return `body.item` from
the remote server, which windows only on its GET route (`apps/server/mcp-items.js`
`getItemForRoute()`), so write responses arrive unwindowed there too. The item names `db.js`; that
file was refactored into `store/`. The store layer is still not what changes.

## Change (server.js only)

1. In `handleToolCall()`, return the three results through `shapeItemForResponse(result, args)`,
   the same call `get_item` makes.
2. In `TOOLS`, add `maxContentLength` and `contentOffset` to `inputSchema.properties` of
   `create_item`, `update_item` and `complete_task`, copying the two property definitions from
   `get_item` verbatim, and append one sentence to each `description`: the returned item is shaped
   like `get_item` (no `favicon`; `content` windowed with `contentLength` / `contentTruncated`),
   and the two window params affect the response only, never what is written.
3. Keep the window params out of the store call: in `create_item` drop `maxContentLength` and
   `contentOffset` from the object passed to `store.createItem`; in `update_item` drop them from
   `rest` alongside `itemId`. `complete_task` already passes explicit arguments.
   (`updateItemSync()` destructures only `title` / `content` / `metadata`, and the remote `PATCH`
   body is destructured the same way in `apps/server/mcp-items.js` `updateItem()`, so today they
   would be ignored; strip them anyway so a window param can never become a write.)

Decision: nothing under `store/` changes and `shapeItemForResponse()` itself is unchanged.

## Tests

Nothing under `apps/desktop/tests/unit/` drives `server.js`; the three mcp tests there
(`mcp-db-tags-unique-index.test.js`, `mcp-sqlite-store-events.test.js`,
`mcp-sqlite-store-create-item-type.test.js`) import `store/sqlite-store.js` directly.
`features/mcp-server/server.test.js` does drive it: its `McpClient` class spawns `node server.js`
with `PEEK_DB_PATH` at a temp sqlite file and `HOME` + `cwd` set to a fresh temp dir (so
`checkConfigDrift()` cannot see a real `.mcp.json` / `~/.claude.json`), waits for `started` on
stderr, and speaks newline-delimited JSON-RPC over stdio; `callTool()` parses
`result.content[0].text`. That file is in no package.json script and must not be imported by
another test (its `describe` blocks would register in the importer's run).

Add `apps/desktop/tests/unit/mcp-write-response-shape.test.js`, self-contained, replicating that
harness: the `createTestDb()` DDL for `items` / `tags` / `item_tags` / `item_events` and a minimal
`McpClient`. Resolve `server.js` from `import.meta.url`
(`join(__dirname, '..', '..', 'features', 'mcp-server', 'server.js')`) the way the sibling mcp
tests resolve `sqlite-store.js`, so the test does not depend on cwd. Build the spawn env from
`process.env` with `PEEK_MCP_SCOPE_TAG`, `PEEK_MCP_READONLY`, `PEEK_MCP_REMOTE_URL` and
`PEEK_MCP_CREDENTIAL` deleted, so the invoking shell cannot flip the server into scoped,
read-only or remote mode.

Seed two rows carrying a `data:image/png;base64,...` favicon: a `text` item tagged `todo` whose
`content` is 9000 position-distinct chars (`'a'.repeat(4000) + 'b'.repeat(4000) + 'c'.repeat(1000)`),
and one with `content` NULL. Cover:

- `create_item` with the 9000-char content: no `favicon` key, `content === 'a'.repeat(4000)`,
  `contentLength === 9000`, `contentTruncated === true`; a direct
  `SELECT content FROM items WHERE id = ?` on the temp DB returns all 9000 chars.
- `create_item` with short content: `contentLength` equals its length, no `contentTruncated`,
  no `favicon`.
- `create_item` with `maxContentLength: -1`: whole content, no `contentTruncated`; with
  `contentOffset: 3998, maxContentLength: 4`: `content === 'aabb'`, `contentTruncated === true`;
  the stored row is the full string in both cases.
- `update_item` on the long seeded item with a title-only patch: no `favicon`, first 4000 chars,
  `contentLength: 9000`, `contentTruncated: true`; with `maxContentLength: -1` the full string.
  Then patch `content` to a different 9000-char string together with `maxContentLength: 10`:
  response is its first 10 chars and the row holds the full new string.
- `update_item` on the NULL-content item: `content === null`, no `contentLength`, no
  `contentTruncated`, no `favicon`.
- `complete_task` on the long seeded item: `tags` include `done` and not `todo`, no `favicon`,
  first 4000 chars with `contentLength: 9000` and `contentTruncated: true`; with
  `maxContentLength: -1` the full string.

Do not edit `server.test.js`: its `create_item` / `update_item` / `complete_task` cases read only
`id`, `type`, `title`, `domain` and `tags`, all of which survive shaping.

## Verify

The repo gate covers the new file (`NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js`).
Also run the existing suite directly, before and after the change, and record both counts under
`**Result**` in the handoff:

```
node --test apps/desktop/features/mcp-server/server.test.js
```

Done when the gate passes with the new test in the run and `server.test.js` passes with the same
count as before the change.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing. Run one command per
Bash call.
