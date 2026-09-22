# Peek Server

Webhook server for the Peek mobile app. Receives URLs, texts, tagsets, and images from the mobile app and stores them in SQLite. Built with Hono running on Node.js, designed for deployment on Railway.

## Commands

```bash
# Dependencies: run yarn install at the repo root. apps/server is a yarn workspace, and npm install inside it rewrites the root yarn.lock.

# From this directory (apps/server/)
npm start            # Run the production server
npm run dev          # Run with file watching (auto-restart on changes)
npm test             # Run the test suite

# From project root
yarn server:start    # Run the production server
yarn server:dev      # Run with file watching
yarn server:test     # Run the test suite
```

**Important:** Run tests after making changes to verify nothing is broken.

## Architecture

- **index.js** - Hono HTTP server with API endpoints
- **db.js** - SQLite database module (node:sqlite)
- **users.js** - Multi-user authentication with API keys

### API Endpoints

- `GET /` - Health check
- `POST /webhook` - Receive items from mobile app (`{ urls: [...], texts: [...], tagsets: [...] }`)

**URLs**
- `GET /urls` - List all saved URLs with tags
- `DELETE /urls/:id` - Delete a URL
- `PATCH /urls/:id/tags` - Update tags for a URL

**Texts**
- `POST /texts` - Create a text item
- `GET /texts` - List all texts
- `DELETE /texts/:id` - Delete a text
- `PATCH /texts/:id/tags` - Update tags

**Tagsets**
- `POST /tagsets` - Create a tagset
- `GET /tagsets` - List all tagsets
- `DELETE /tagsets/:id` - Delete a tagset
- `PATCH /tagsets/:id/tags` - Update tags

**Images**
- `POST /images` - Upload an image (multipart or base64)
- `GET /images` - List all images
- `GET /images/:id` - Get image file
- `DELETE /images/:id` - Delete an image
- `PATCH /images/:id/tags` - Update tags

**Unified Items**
- `POST /items` - Create any item type
- `POST /items/batch` - Create/update up to 500 items in one transaction, with a per-row result
- `GET /items` - List items (optional `?type=` filter)
- `DELETE /items/:id` - Delete an item
- `PATCH /items/:id/tags` - Update tags

**Sync pulls**
- `GET /items/since/:timestamp`, `GET /events/since/:timestamp`, `GET /tags/since/:timestamp`
- Each returns the whole matching set unless the client sends `limit` (1..1000), in which case
  the response carries a `nextCursor` to pass back as `cursor` for the following page. A client
  that sends neither gets the unpaged response, so paging costs nothing in compatibility either
  direction. See `docs/sync.md` for the full contract.

**Tags**
- `GET /tags` - List tags sorted by frecency

### Database Schema

Multi-user SQLite databases (one per user):
- `items` - Unified table for URLs, texts, tagsets, images
- `tags` - Tag names with frecency scoring
- `item_tags` - Many-to-many junction table
- `settings` - Key-value configuration

System database:
- `users` - User IDs and hashed API keys

Database stored in `./data/{userId}/peek.db`. Override with `DATA_DIR` env var.

### Authentication

All endpoints except `/` require Bearer token authentication:
```
Authorization: Bearer <api_key>
```

API keys are hashed with SHA-256 and stored in the system database.

## MCP Item-Event Routes

Four routes under `/mcp/*` record and read the event history attached to one item (the
`item_events` table backing `series`/`feed` items — see `docs/feeds-api.md`). They authenticate
with a grant credential, not the API key above: `Authorization: Bearer <grant token>` (minted by
`peek-mcp-init`, see `docs/mcp-remote-backend-design.md` §6). A grant confines every `/mcp/*`
route to one scope tag and can be marked read-only; a read-only grant gets `403` from all three
writes below (`POST .../events`, `DELETE .../events/:eventId`, `DELETE .../events`). Business
logic lives in `apps/server/mcp-items.js` (`recordEvent()`, `listEvents()`, `deleteEvent()`,
`deleteEvents()`); routes are registered in `apps/server/index.js`.

### `POST /mcp/items/:id/events` — record an event

```bash
curl -X POST "$PEEK_URL/mcp/items/$ITEM_ID/events" \
  -H "Authorization: Bearer $PEEK_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type": "started", "value": "kicked off"}'
# 200 {"success":true,"id":"<eventId>","itemId":"<id>","type":"started"}
```

`type` is required on every call, even when `content` is also supplied — a call with only
`content`/`occurredAt`/`metadata` and no `type` gets `400`.

There is no `type` column on `item_events`. The row has one column, `content`, storing
`content ?? type` — a call that supplies `content` keeps it and the `type` value is not stored
anywhere; it exists only to satisfy the required field and to echo back in this response's
`type`. A caller that needs its events distinguishable by kind later must carry that label
inside `metadata` instead (`mcp-items.js recordEvent()`).

**Legacy shape — `{type, value}` only.** Supplying nothing else writes exactly the old row:
`content = type`, `value = 0`, `metadata = {"notes": value}` (or `{}` when `value` is empty).
`apps/server/test.js` pins this byte-for-byte.

**New shape — add `content`, `occurredAt`, and/or `metadata`.** Each stores directly into the
column of the same name, unwrapped:

```bash
curl -X POST "$PEEK_URL/mcp/items/$ITEM_ID/events" \
  -H "Authorization: Bearer $PEEK_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "feed_entry",
    "content": "https://example.com/article",
    "occurredAt": 1700000000000,
    "metadata": {"guid": "abc123", "title": "An article"}
  }'
```

Supplying `metadata` also switches what `value` means: instead of being wrapped into
`metadata.notes` as free text, it is stored as a real number in the `value` column. A numeric
string (`"42"`) is coerced; an empty or absent `value` defaults to `0`; anything else non-numeric
(e.g. `"kicked off"`) is refused with `400` and no row is written — it is not silently coerced to
`0`, since that failure mode would otherwise hide real text on exactly the request shape a caller
migrating off `{type, value}` would plausibly send.

Status codes: `200` on success, `404` if the item doesn't exist (or is out of the grant's scope),
`400` for a missing `type` or a non-numeric `value` alongside `metadata`, `403` for a read-only
grant.

### `GET /mcp/items/:id/events?limit=&offset=` — paged read of an item's history

```bash
curl "$PEEK_URL/mcp/items/$ITEM_ID/events?limit=50&offset=0" \
  -H "Authorization: Bearer $PEEK_MCP_TOKEN"
# 200 {"events":[{"id":"...","content":"...","value":0,"occurredAt":1700000000000,"metadata":"{\"guid\":\"abc123\"}"}, ...]}
```

Rows come back ordered `occurredAt DESC`. `limit` defaults to `50`, capped at `200`; `offset`
pages through the rest. There is no `since`/`until`/`order` parameter — apply those to the rows
you read back client-side.

`metadata` comes back as a raw JSON string, not parsed — `JSON.parse()` it yourself. (An item's
own `metadata` field, by contrast, comes back already parsed; events do not.)

**The shape trap.** This is the one route that returns the `content` column under its own name.
The *other* read of an item's events — `GET /mcp/items/:idOrPrefix?events=N` (the `events` window
embedded in a `get_item` response) — still returns the same column aliased to `type`, a holdover
from before `content` was a field callers could set, and it is hard-capped at 20 rows no matter
what `N` asks for (`mcp-items.js fetchEvents()`). Two different reads of the same column under
two different names: use this route, not the embedded one, when you need more than 20 rows or
need the real `content` value rather than whatever ends up under `type`.

Status codes: `200` always, unless the item doesn't exist or is out of scope (`404`).

### `DELETE /mcp/items/:id/events/:eventId` — remove one event

```bash
curl -X DELETE "$PEEK_URL/mcp/items/$ITEM_ID/events/$EVENT_ID" \
  -H "Authorization: Bearer $PEEK_MCP_TOKEN"
# 200 {"success":true,"id":"<eventId>","itemId":"<id>"}
```

A hard delete — `item_events` has no `deletedAt` column to soft-delete into. An `eventId` that
doesn't exist under this item is **not** a `404`: it comes back `200 {"success":false,"error":"Event
not found"}`, the same way a missing tag does on `untag_item`. Only a missing/out-of-scope *item*
gets `404`.

### `DELETE /mcp/items/:id/events` — remove every event under an item

```bash
curl -X DELETE "$PEEK_URL/mcp/items/$ITEM_ID/events" \
  -H "Authorization: Bearer $PEEK_MCP_TOKEN"
# 200 {"success":true,"itemId":"<id>","deleted":3}
```

Also a hard delete, reporting the count removed.

**Deleting an item does not delete its events.** `DELETE /mcp/items/:id` is a *soft* delete and
deliberately does not touch `item_events` (`mcp-items.js deleteItem()`). A soft-deleted item is
still reachable by its exact id — `fetchItemRowById()` does not filter `deletedAt` — so these
routes still reach its events afterwards. What it stops appearing in is `list_items` and
`search_items`, which do filter it, so an id not captured beforehand cannot be recovered and the
events become unreachable. Clear the events first, or keep the id.

## Deployment

Configured for Railway (`railway.json`) using Nixpacks builder with npm. **Do not add `yarn.lock`** to this directory — Nixpacks will switch to yarn and fail.

Deploys are manual, uploaded straight to Railway. See `docs/server-backup-and-deploy.md` at the
repository root for the procedure and its constraints.

**Quick setup:**
1. Attach a volume and set `DATA_DIR` to the mount path for persistent storage
2. Create users and their API keys (see AGENTS.md for commands)

## Testing

```bash
npm test                    # Run unit tests
npm run test:api:local      # Test against local server (needs PEEK_LOCAL_KEY env var)
npm run test:api:prod       # Test against production (needs PEEK_PROD_KEY, PEEK_PROD_URL)
```

## Environment Variables

- `PORT` - Server port (default: 3000)
- `DATA_DIR` - Data directory for SQLite databases (default: `./data`)
- `API_KEY` - Legacy single-user API key (auto-migrates to multi-user system)
- `TRUSTED_PROXY_HOPS` - Reverse-proxy hops in front of the server that append to `X-Forwarded-For` (default: `1`, matching a Railway deployment). Set to `0` when self-hosting with no reverse proxy; otherwise a client can forge the header and choose its own `/enrol` rate-limit bucket
