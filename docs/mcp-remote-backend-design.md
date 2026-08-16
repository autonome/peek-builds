# MCP remote backend

How the Peek MCP server gains a remote data backend, so an agent or client with no local
Peek install — a scheduled agent, a cloud session, a phone — reads and writes the same
item/tag/event store a local MCP session sees.

Two things already exist and this design fits them rather than replacing them:

- The stdio MCP server: `apps/desktop/features/mcp-server/server.js` (tool registry `TOOLS`,
  dispatch `handleToolCall()`, scope helpers `inScope()` / `validateWriteTags()` /
  `withScopeTag()` / `assertItemInScope()`, response shaping `shapeItemForResponse()`,
  drift self-exit `checkConfigDrift()`) over the direct-SQLite layer
  `apps/desktop/features/mcp-server/db.js`.
- The Hono sync server `apps/server/index.js` with its per-device bearer auth
  (`apps/server/auth.js createAuthMiddleware()`, `apps/server/users.js resolveDevice()`),
  its SQLite adapter seam (`apps/server/sql/types.js`), and the desktop sync engine
  `apps/desktop/main/sync.ts` (`pullFromServer()`, `pushToServer()`, `mergeServerItem()`,
  `pushSingleItem()`).

---

## 1. Architecture: which of the two shapes, and in what order

Two candidate shapes were considered.

**A. Keep the stdio child, swap its data layer.** `server.js` keeps owning the MCP protocol,
the tool schemas, and response shaping. `db.js` stops being the only store and becomes one of
two implementations behind an interface; the other implementation is an HTTP client against
`apps/server`.

**B. Serve MCP itself over HTTP from `apps/server`.** The sync server grows an MCP endpoint,
and clients connect to a URL with no local process at all.

**Decision: build A first; B is a transport wrapper over the same work, added second.**

They are complementary, not exclusive, and A is the prerequisite. Almost all of the effort in
either shape is the same effort: `apps/server` has no item/tag/event API that can answer the
tools (§3), no schema fields for `title`/`domain`/`frecencyScore` (§3.1), no scope confinement,
and no readonly gate. A forces every one of those to exist and be testable against the existing
node test runner, with the MCP protocol layer unchanged and already covered by
`apps/desktop/features/mcp-server/server.test.js`. Once that API exists, B is a route that
speaks JSON-RPC over HTTP into the same dispatch function — a few hundred lines, not a
re-architecture.

A also already satisfies the stated goal for two of the three named clients. A scheduled agent
and a cloud session can run a Node process; what they cannot do is have a Peek install and a
`datastore.sqlite`. A removes that requirement — the child spawns anywhere Node runs and holds
no local state. Only the phone case genuinely needs B, because a mobile client cannot spawn a
child process at all.

The tie-breaker is where enforcement ends up. In A the store boundary moves to HTTP, which
forces scope and readonly to become *server-side, credential-bound* facts (§4) rather than
process-local env vars. That is the load-bearing change. B inherits it for free; B built first
would have to invent it anyway, plus an MCP transport, plus session management, before anything
worked at all.

Sequencing:

1. **Phase 1 (this design).** Store interface in `db.js`'s place (§2); `/mcp/*` API on
   `apps/server` (§3); grant-bound scope and readonly (§4); remote-mode `peek-mcp-init` (§8).
2. **Phase 2 (named, not specified here).** `POST /mcp/rpc` on `apps/server` that imports the
   tool table and dispatch out of `server.js` and answers JSON-RPC over streamable HTTP, with
   the grant token as the bearer credential. No new data-layer work; the tool layer is already
   transport-agnostic once step 1 splits it from stdio. Claude Code consumes this shape natively
   — a `.mcp.json` entry of `{"type": "http", "url": …, "headers": {"Authorization": …}}`, with
   no local process — so Phase 2 is what reaches the phone case, and it is a route plus a
   credential, not a second architecture.

---

## 2. Where the seam belongs

### 2.1 The interface

`db.js` currently exports fifteen functions that `server.js` imports directly. Those exports
*are* the interface — they were already a coherent store API, they just had one implementation
compiled into them. The seam is drawn there, described the way `apps/server/sql/types.js`
describes `SqlAdapter`: a JSDoc typedef file with no runtime code, plus a factory that picks an
implementation from the environment (the shape of `apps/server/sql/index.js`).

New files under `apps/desktop/features/mcp-server/store/`:

| File | Contents |
|---|---|
| `types.js` | `PeekStore` typedef, `ItemView` typedef, `ResolveResult` typedef. No runtime code, same as `sql/types.js`. |
| `sqlite-store.js` | The existing `db.js` body, wrapped so every method is `async`. |
| `remote-store.js` | HTTP client against `/mcp/*`. |
| `index.js` | `openStore(config)` — selects by env, mirroring the `SQL_ADAPTER` switch in `apps/server/sql/index.js`. |

```js
/**
 * @typedef {Object} PeekStore
 * @property {(q: ItemQuery) => Promise<ItemView[]>} queryItems
 * @property {(q: SearchQuery) => Promise<ItemView[]>} searchItems
 * @property {(id: string, opts?: {events?: number}) => Promise<ItemView|null>} getItem
 * @property {(id: string) => Promise<string[]>} getItemTags
 * @property {(prefix: string) => Promise<ResolveResult>} resolveItemId
 * @property {(input: CreateItemInput) => Promise<ItemView>} createItem
 * @property {(id: string, patch: UpdateItemInput) => Promise<ItemView>} updateItem
 * @property {(id: string) => Promise<{success: boolean, id: string}>} deleteItem
 * @property {(q: TagQuery) => Promise<TagView[]>} listTags
 * @property {(id: string, tagName: string) => Promise<TagMutationResult>} tagItem
 * @property {(id: string, tagName: string) => Promise<TagMutationResult>} untagItem
 * @property {(id: string, type: string, value?: string) => Promise<EventResult>} recordEvent
 * @property {(q: TaskQuery) => Promise<ItemView[]>} listTasks
 * @property {(id: string, notes?: string) => Promise<ItemView>} completeTask
 * @property {(id: string) => Promise<ItemView|null>} getTaskContext
 * @property {() => Promise<SessionInfo>} describe
 * @property {() => Promise<void>} close
 */
```

Two deliberate differences from today's `db.js` signature set:

- **`resolveItemId(prefix)` drops its `{scopeTag}` option.** Today `server.js`
  `resolveItemIdFromArgs()` passes `SCOPE` down and `db.js resolveItemId()` splices it into the
  SQL. Under a remote store the client must not be the one asserting its scope (§4), so scope
  becomes a property of the store, fixed at `openStore()` time. The SQLite implementation
  captures it from `PEEK_MCP_SCOPE_TAG`; the remote implementation never sends it and the
  server derives it from the credential. Callers in `server.js` stop passing it.
- **`describe()` is new.** Returns `{scopeTag, readonly, profileId, datastoreVersion, backend}` —
  what the store believes about itself. `main()` calls it at startup, logs it, and refuses to
  serve if the on-disk config claims a scope the store disagrees with (§4.3).

### 2.2 The one invasive change: everything becomes async

`db.js` is synchronous by construction (`DatabaseSync` from `node:sqlite`), and so are
`handleToolCall()`, `handleResourceRead()`, and `handleMessage()` in `server.js`. HTTP is not.

**Decision: the store interface is async, and `server.js`'s dispatch chain becomes async.**
`sqlite-store.js` marks its methods `async` around unchanged synchronous bodies — no behavior
change, no measurable cost. `handleToolCall()`, `handleResourceRead()`, and `handleMessage()`
gain `await`. The `rl.on('line')` handler in `main()` cannot simply `await`, because the
callback is sync and concurrent lines would interleave.

**Decision: serialize incoming messages through a tail promise.**

```js
let queue = Promise.resolve();
rl.on('line', (line) => {
  queue = queue.then(() => handleLine(line)).catch((err) => {
    process.stderr.write(`Fatal in message handler: ${err.stack}\n`);
  });
});
```

Requests are handled strictly in arrival order, exactly as today. JSON-RPC permits out-of-order
responses, but ordering is free here and pipelining buys nothing for a single-user tool session,
while unordered concurrency would let two mutating tools interleave against the same item.
`checkConfigDrift()` stays where it is, at the head of `handleLine`.

Rejected: keeping the sync signature by driving HTTP through a worker thread with
`Atomics.wait`, or shelling out to `curl` per call. Both preserve one function signature at the
cost of a blocked event loop and a much worse failure surface.

---

## 3. Tool-by-tool gap analysis

`SYNCABLE_ITEM_TYPES` and the routes in `apps/server/index.js` today expose a *sync* surface:
whole-collection reads (`GET /items`), incremental pull (`GET /items/since/:timestamp`),
upsert-by-`syncId` push (`POST /items` → `db.js saveItem()`), whole-tag-set replacement
(`PATCH /items/:id/tags` → `db.js updateItemTags()`), soft delete (`DELETE /items/:id` →
`db.js deleteItem()`), single item fetch (`GET /items/:id` → `db.js getItemById()`), and a flat
tag list (`GET /tags` → `db.js getTagsByFrecency()`). There is no tag filter, no text search, no
per-tag add/remove, no prefix resolution, no item-count-per-tag, no events surface, and no
concept of scope.

### 3.1 Prerequisite: columns the server does not have

`apps/server/db.js initializeSchema()` creates `items` with
`id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt, createdByDevice`.
The MCP `ItemView` needs `title`, `domain`, and `frecencyScore` — `search_items` ranks on
`SEARCH_WEIGHTS.title` (10) and `.domain` (4) and tiebreaks on `frecencyScore`, `list_items`
accepts `sort: 'frecency'`, and `update_item` writes `title`. Without them a remote-backed
session sees every item untitled and search degrades to content-substring matching.

**This is two separate problems, and only the first one belongs to this design.**

**Storage — phase 1 work.** The columns must exist on the server so `/mcp/*` routes can read and
write them. That is a schema addition and nothing more: an item created or retitled through
`POST /mcp/items` or `PATCH /mcp/items/:id` sets the column directly, with no involvement from
the sync engine.

- Add `title TEXT DEFAULT ''`, `domain TEXT DEFAULT ''`, `frecencyScore REAL DEFAULT 0`,
  `starred INTEGER DEFAULT 0`, `archived INTEGER DEFAULT 0` to the `items` table in
  `apps/server/db.js initializeSchema()`, using the additive `ALTER TABLE … ADD COLUMN` guard
  pattern already there for `syncId`/`createdByDevice`. (`starred` and `archived` are already
  `"sync": true` in `packages/schema/v1.json` and missing from the server anyway.)
- Carry them in `saveItem()`, `getItems()`, `getItemsSince()`, and `getItemById()`.
- Mirror the addition into `apps/server/schema.json`, which is a **second, already-divergent copy**
  of `packages/schema/v1.json` — changing one and not the other is how the two drifted apart in
  the first place.

**Sync — deliberately out of scope.** Whether `sync.ts` carries these fields between devices is a
standing schema decision, not an oversight: `packages/schema/v1.json` marks `title` and `domain`
`"sync": false` with the rationale "cached locally", and `frecencyScore` `"sync": false` as a
"local calculation". `pushSingleItem()` and `mergeServerItem()` implement that decision faithfully,
and `validation.required_sync_columns.items` agrees with it.

Reversing it is a `datastore.ts`-owned policy call with its own consequences — `frecencyScore` is
computed per device, so syncing it means deciding whether the value stays per-device or becomes
shared — and it belongs to a broader question about what a server restore returns. That question,
and the rest of the local-only inventory, is recorded in `docs/sync-coverage-gaps.md`. It is
tracked as open question 3 in §10 and does not block phase 1: an item written through the MCP API
carries its title regardless of what the sync engine does with the local copy.

Deliberately still absent from the server: `favicon` (already stripped at the MCP layer by
`shapeItemForResponse()`), `visitCount` and `lastVisitAt` (local-only with no MCP consumer),
`mimeType` beyond what sync already carries.

### 3.2 Shapes

`ItemView` — the single item shape every read endpoint returns:

```json
{
  "id": "<server item id>",
  "localId": "<items.syncId, the desktop-side id; '' if never synced>",
  "type": "text",
  "title": "…",
  "content": "…",
  "domain": "",
  "metadata": {},
  "tags": ["peek", "peek:todo"],
  "createdAt": 1780000000000,
  "updatedAt": 1780000000000,
  "deletedAt": 0,
  "starred": 0,
  "archived": 0,
  "visitCount": 0,
  "frecencyScore": 0,
  "contentLength": 41233,
  "contentTruncated": true
}
```

`contentLength`/`contentTruncated` appear only when the request passed content-window params
(§3.3). `search_items` results add `"score": 26` and `"snippet": "…"`. `get_task_context` adds
`"events": [{ "id", "type", "value", "occurredAt", "metadata" }]`.

`TagView`: `{ "id", "name", "color", "description", "itemCount" }` — matching what
`db.js listTags()` selects today, which `GET /tags` does not provide (it returns
`name, frequency, lastUsed, frecencyScore` with no per-tag item count).

`ResolveResult`: `{ "id": "…" }` | `{ "id": null }` |
`{ "id": null, "ambiguous": true, "candidates": [{"id","title"}], "truncated": false }` —
byte-identical to what `db.js resolveItemId()` returns today, so `server.js formatAmbiguous()`
is unchanged.

### 3.3 The table

All new routes live under `/mcp/*`, namespaced away from the sync surface so the existing
`app.use("/items/*")` version middleware and the sync client's expectations are untouched. The
same `checkVersionHeaders()` middleware is applied to `/mcp/*` so a stale `peek-mcp` binary
fails fast with 409 rather than silently misreading shapes.

| Tool (`server.js TOOLS`) | Backed by today | New endpoint | Notes |
|---|---|---|---|
| `list_items` | ✗ — `GET /items` has no tag filter, no sort, no paging | `GET /mcp/items?tags=a,b&type=&limit=&offset=&sort=recent\|frecency` | Server-side port of `db.js queryItems()`, including the `GROUP BY … HAVING COUNT(DISTINCT t.id) = ?` all-tags-match semantics. Returns `{items: ItemView[]}`. |
| `search_items` | ✗ — nothing | `GET /mcp/items/search?q=&tags=&type=&limit=&offset=` | Port of `db.js searchItems()`: same SQL pre-filter (per-term `LIKE` over title/content/domain/tag-blob with `ESCAPE '\'`), same JS ranking (`SEARCH_WEIGHTS`, `SNIPPET_RADIUS`, `buildSnippet()`). Ranking must live server-side or the whole candidate set crosses the wire. Returns `{items: (ItemView & {score, snippet})[]}`. |
| `get_item` | partial — `GET /items/:id` (`getItemById()`) returns no title/tags-with-counts, no prefix support, no windowing | `GET /mcp/items/:idOrPrefix?maxContentLength=&contentOffset=` | Resolves a prefix inline (§5); returns `200 {item}`, `404` for not-found, `409 {ambiguous, candidates, truncated}` for ambiguity. Content windowing happens **server-side** so a multi-megabyte page capture never crosses the wire; the response carries `contentLength`/`contentTruncated` exactly as `shapeItemForResponse()` computes them today. |
| `create_item` | partial — `POST /items` upserts by `syncId` and has no title/url/hashtag handling | `POST /mcp/items` | Body `{type, url, title, content, metadata, tags, extractHashtags}`. Server-side port of `db.js createItem()` including the `type === 'url'` domain derivation and the opt-in `extractHashtagsFromContent()`. Returns the created `ItemView`. Distinct from `POST /items`: no `syncId` matching, no content-dedup — an explicit create is always a create. |
| `update_item` | ✗ — `POST /items` is upsert-by-syncId, not a field patch | `PATCH /mcp/items/:id` | Body `{title?, content?, metadata?}`, absent keys untouched, `updatedAt` stamped. Returns the updated `ItemView`. |
| `delete_item` | ✓ — `DELETE /items/:id` | `DELETE /mcp/items/:id` | New route rather than reusing the old one, because it must apply the scope check and return `{success, id}` with the resolved id echoed. |
| `list_tags` | partial — `GET /tags` has no item counts, no search filter, no limit | `GET /mcp/tags?search=&limit=` | Port of `db.js listTags()` including the `LEFT JOIN … deletedAt = 0` count. Returns `{tags: TagView[]}`. |
| `tag_item` | ✗ — `PATCH /items/:id/tags` replaces the whole set | `POST /mcp/items/:id/tags` | Body `{name}`. Adds one tag, creating it if needed. Must reproduce `db.js tagItemInTx()`: slug via `slugifyTagName()`, `ON CONFLICT(name)` upsert, and the frecency recompute — `apps/server/db.js getOrCreateTagWithConn()` is close but has no slug column and a `float` frecency, so the two policies must be reconciled (§10). |
| `untag_item` | ✗ — same reason | `DELETE /mcp/items/:id/tags/:name` | Removes one tag. Returns `{success, itemId, tagName}` or `{success:false, error:'Tag not found'}`. |
| `record_event` | ✗ — server has an `item_events` table (created in `initializeSchema()`) but no route, and `sync.ts` never syncs events | `POST /mcp/items/:id/events` | Body `{type, value}` → row in `item_events` with `content = type`, `value = 0`, `metadata = {notes}` — the exact shape `db.js recordEvent()` writes. |
| `list_tasks` | ✗ | *(none)* | Composes to `GET /mcp/items?tags=todo,<project>&sort=recent`, mirroring `db.js listTasks()` delegating to `queryItems()`. No endpoint. |
| `complete_task` | ✗ | `POST /mcp/tasks/:id/complete` | Body `{notes}`. Must be one endpoint, not three calls: `db.js completeTask()` wraps add-`done` / remove-`todo` / record-event in a transaction precisely so an item cannot end up carrying both tags. Three round trips reintroduce the state it was written to prevent. Returns the updated `ItemView`. |
| `get_task_context` | ✗ | *(none — `?events=` on the item GET)* | `GET /mcp/items/:idOrPrefix?events=20` returns `ItemView & {events: [...]}`, matching `db.js getTaskContext()`'s 20-row `ORDER BY occurredAt DESC` window. Folding it into the item GET saves a round trip on the tool that already fetches the item. |
| *(all tools — prefix resolution)* | ✗ | `GET /mcp/items/resolve?prefix=` | §5. Returns `ResolveResult`. |
| *(session bootstrap)* | ✗ | `GET /mcp/session` | Returns `{scopeTag, readonly, profileId, datastoreVersion, userId}` as the *server* understands them. Backs `PeekStore.describe()` and the startup consistency check (§4.3). |

Resources (`peek://tasks`, `peek://tasks/{tag}`, `peek://tags`) need no endpoints of their own —
`handleResourceRead()` already composes them out of `listTasks()` and `listTags()`.

**Count: 13 new endpoints.**

---

## 4. Scope confinement and the readonly gate

Today both are process-local. `SCOPE` and `READONLY` are read from `process.env` at the top of
`server.js`; `READONLY` filters `TOOLS` in the `tools/list` branch and short-circuits
`tools/call`; `SCOPE` drives `inScope()` post-filtering on reads, `withScopeTag()` /
`validateWriteTags()` on writes, `assertItemInScope()` before mutations, and the `scopeTag`
argument threaded into `db.js resolveItemId()`.

### 4.1 Decision: both are properties of the credential, enforced by `apps/server`

A new `mcp_grants` table in `system.db`, alongside `devices` (`apps/server/users.js`
`createDevice()` / `resolveDevice()` are the model to copy — key generation via
`generateApiKey()`, storage via `hashApiKey()`, the raw key returned exactly once):

```
mcp_grants(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scope_tag TEXT NOT NULL,        -- '' means unscoped; see §4.4
  readonly INTEGER NOT NULL,      -- 1 = mutating routes refused
  profile_id TEXT NOT NULL,
  created_at TEXT, last_seen_at TEXT, revoked_at TEXT
)
```

Minted through the existing `ADMIN_TOKEN`-gated admin surface:
`POST /admin/mcp-grants {userId, label, scopeTag, readonly, profileId}` →
`{grant: {id, label, scopeTag, readonly, apiKey}}`, plus `GET /admin/mcp-grants?userId=` and
`DELETE /admin/mcp-grants/:id`, mirroring the three `/admin/devices` routes.

An `/mcp/*` middleware resolves the bearer token through `resolveMcpGrant()` and sets
`c.set('scopeTag', …)`, `c.set('readonly', …)`, `c.set('userId', …)`, `c.set('profileId', …)`.
A device key is **not** accepted on `/mcp/*` and a grant key is **not** accepted on the sync
routes: a sync device is unscoped by nature, and letting one credential serve both would make
every phone install a whole-store MCP key.

Enforcement, all server-side:

- **Reads** carry the same `EXISTS (SELECT 1 FROM item_tags it JOIN tags t … WHERE t.name = ? OR
  t.name LIKE ? ESCAPE '\')` clause that `db.js resolveItemId()` already uses for its scoped
  path, appended to every `/mcp` item query. Not a post-filter — a `WHERE` clause, so `LIMIT`
  and `OFFSET` are computed over in-scope rows only.
- **Writes** force-add the scope tag (the `withScopeTag()` rule) and reject any tag containing
  `:` that is not scope-owned (the `tagIsForeignNamespace()` rule) with `400`.
- **Mutating routes** return `403` when the grant is readonly.
- **Untag** applies the orphan rule from `handleToolCall()`'s `untag_item` branch — refuse when
  removing the tag would leave no in-scope tag on the item — server-side, because it is the
  thing that keeps an item from vanishing out of the session's view.

### 4.2 Why a client-side check is not sufficient

`PEEK_MCP_SCOPE_TAG` and `PEEK_MCP_READONLY` are entries in a JSON file the caller owns
(`<cwd>/.mcp.json`, `~/.claude.json`). Locally that is fine, and deliberately so: a caller who
edits those values already has read/write access to `datastore.sqlite` on the same disk, so the
env var is a guardrail against an agent wandering, not a security boundary — nothing is being
defended that the caller does not already hold.

Remote inverts that. The bearer token travels to a cloud runner, a CI job, a phone, a scheduled
agent — places where the holder has *no* other access to the store. The token becomes the only
thing between its holder and every item the account owns, and a scope that lives in the client's
env is one `curl` away from being ignored: the same token, sent by hand without the client's
filtering, reads the whole store. A readonly flag enforced by hiding tools from `tools/list` is
weaker still, since the HTTP API is reachable regardless of which tools a client advertises.

So the scope and the readonly bit are minted *into* the credential, and the server is the only
thing that enforces them. The client-side checks in `server.js` stay exactly as they are: they
fail fast without a round trip and produce the good error messages (`Tag "x" is outside scope
"y"`), but they are a convenience layer over an enforced boundary rather than the boundary.

### 4.3 Startup consistency

`main()` calls `store.describe()` before serving. If the on-disk `.mcp.json` entry names a scope
that disagrees with the grant's, the child writes both values to stderr and `process.exit(0)`
— the same recovery path `checkConfigDrift()` already uses, so the client respawns rather than
serving a session whose advertised scope is a lie. `checkConfigDrift()` itself gains the remote
keys in `entryEnvMatchesCurrent()` (`PEEK_MCP_REMOTE_URL`, `PEEK_MCP_CREDENTIAL`) and, in remote
mode, stops comparing `PEEK_DB_PATH`.

### 4.4 Unscoped grants

`scope_tag = ''` is permitted and means whole-store, matching today's `SCOPE = ''` behavior. It
is not what `peek-mcp-init` writes — the scaffolder requires a scope in remote mode as it does
today (`setup.js main()` exits 2 without one) — but a hand-minted unscoped grant is the escape
hatch for a personal-automation agent, and the admin surface makes it a deliberate act.

---

## 5. Item-id prefix resolution over the wire

Today this is one query. `db.js resolveItemId()` short-circuits on an exact `id =` match, then
runs one index-anchored `id LIKE 'prefix%' ESCAPE '\'` against the `items.id` primary key with
`LIMIT PREFIX_AMBIGUITY_LIMIT + 1`, with `escapeLikePrefix()` protecting the literal underscores
in timestamp-style ids and the scope restriction spliced in as an `EXISTS` subquery so the limit
can never truncate an in-scope match that sorts behind out-of-scope ones.

**Decision: one endpoint, `GET /mcp/items/resolve?prefix=`, running that same query on the
server and returning the same `ResolveResult` shape.** One round trip, never one per candidate.
The client never enumerates ids and never sees an out-of-scope id or title, because the scope
`EXISTS` clause is part of the SQL and is derived from the grant, not from anything the client
sends (§4.1). A prefix matching only out-of-scope items returns `{id: null}` — indistinguishable
from a miss, preserving the existing property that a scoped session cannot probe for the
*existence* of items outside its scope.

Two refinements:

- **Read tools resolve inline.** `GET /mcp/items/:idOrPrefix` performs resolution itself and
  returns the item (`200`), a miss (`404`), or the ambiguity payload (`409`). `get_item` and
  `get_task_context` therefore stay at one round trip each, the same as today. `server.js` maps
  `409` back through `formatAmbiguous()` so the caller sees the identical error text.
- **Mutating tools resolve explicitly.** `resolveItemIdForMutation()` calls
  `/mcp/items/resolve` first and only then issues the mutation against a full id. Two round
  trips is the correct price for the invariant `resolveItemIdForMutation()` exists to hold —
  never mutate a guessed or missing item — and folding resolution into `PATCH`/`DELETE` would
  mean a mutating route that silently accepts a prefix, which is a worse shape to expose over
  HTTP than an extra GET.

**The id-namespace gotcha.** Server ids are not local ids. `apps/server/db.js saveItem()` mints
its own `generateUUID()` for a pushed item and stores the desktop's id in `items.syncId`;
`sync.ts pushSingleItem()` then writes the server's id back into the local row's `syncId`. So an
id a user reads off the desktop UI is a *server-side `syncId`*, and an id a remote session
reports is a server `id`. Resolution must match either, or the id shorthand breaks precisely
when a human quotes it.

**Decision: the resolver matches `items.id LIKE ?` OR `items.syncId LIKE ?`, exact-match-first
across both columns, and every `ItemView` carries `localId` (the row's `syncId`) alongside
`id`.** Ambiguity across the two columns is reported through the existing candidate list. A row
that matches on both columns is de-duplicated by `id`.

---

## 6. Auth: what credential, stored where, and its relationship to `.mcp.json`

**Credential: a static bearer token — the `mcp_grants` key from §4.1 — sent as
`Authorization: Bearer <token>`,** resolved by hash, revocable individually, with `last_seen_at`
bumped on use exactly as `resolveDevice()` does. Not OAuth: `apps/server` has no authorization
server, no browser redirect surface, and no session store, and adding one to unblock a stdio
child that runs on a developer's own machine is a large amount of new attack surface for no gain
over a revocable minted key. OAuth becomes worth revisiting for Phase 2 (§1), where a phone or
`claude.ai` connects to a URL directly and there is a browser in the loop — that is named as
future work, not designed here.

**Storage: never in the project.** `.mcp.json` is scaffolded into a project root, and
`setup.js writeGitignoreBlock()` gitignores it but cannot guarantee it stays gitignored. Two
mechanisms, in the order `remote-store.js` resolves them:

**1. Environment-variable reference (preferred).** Claude Code expands `${VAR}` and
`${VAR:-default}` inside `.mcp.json`, in `command`, `args`, `env`, `url`, and `headers`. So the
entry names the variable and the value lives in the shell, a secrets manager, or a CI secret:

```json
{
  "mcpServers": {
    "peek": {
      "command": "node",
      "args": ["<path to server.js>"],
      "env": {
        "PEEK_MCP_REMOTE_URL": "${PEEK_SYNC_URL}",
        "PEEK_MCP_TOKEN": "${PEEK_MCP_TOKEN}",
        "PEEK_MCP_SCOPE_TAG": "<scope>"
      }
    }
  }
}
```

This is the whole answer for a cloud runner, a CI job, or a scheduled agent — the environments
that motivate the remote backend in the first place.

**One guard is required.** When a referenced variable is unset, Claude Code warns and passes the
literal `${PEEK_MCP_TOKEN}` text through; the server still loads. Sent unexamined that becomes a
bearer token of the string `${PEEK_MCP_TOKEN}` and an opaque `401`. So `remote-store.js` checks
for a leading `${` on the resolved token and fails at startup with
`PEEK_MCP_TOKEN was not expanded — the variable is unset in the environment Claude Code was
launched from.`

**2. A per-user credential file, for interactive desktop use** where the shell environment a
GUI-launched client inherits is not reliable. `~/.config/peek/mcp-credentials.json`, mode `0600`,
written by `peek-mcp-init`:

```json
{
  "credentials": {
    "<server-url>#<scope>": { "token": "<minted token>", "label": "…" }
  }
}
```

`.mcp.json` then carries `PEEK_MCP_CREDENTIAL: "<PEEK_SYNC_URL>#<scope>"` — a lookup key, not a
secret.

Either way the repository rule holds without relying on `.gitignore`: no token, key, hostname,
account id, or user id is written into any file inside a project. This document and everything
`setup.js` prints use placeholders (`<PEEK_SYNC_URL>`, `<scope>`) rather than values.

**Server-side hygiene:** the `/mcp/*` middleware must not log the bearer value (`auth.js` does
not today and must not start), and the grant admin routes return the raw key exactly once at
mint time, never on list.

---

## 7. Offline and local-first behaviour

### 7.1 What a remote-backed session does with no network

**Decision: every tool call fails, loudly, with an error naming the unreachable server. No local
cache, no read-through, no write queue.**

The reasoning is about what an agent does with the answer. A tool that returns `[]` from a stale
cache when the network is down does not report a degraded read — it reports *no matching items*,
and the agent acts on that: it creates a duplicate task, or concludes work is unassigned, or
reports a queue as empty. A hard failure is recoverable in one turn; a plausible wrong answer is
not. So `remote-store.js` surfaces transport failures as tool errors —
`Peek remote store unreachable at <PEEK_MCP_REMOTE_URL>: <cause>` — with a short retry
(three attempts, exponential backoff, ~2s ceiling) covering only transient blips.

This is not a loss of local-first behaviour, because **the remote store is not what a machine
with Peek on it should be using.** A developer laptop keeps `sqlite-store.js` against
`datastore.sqlite`, which is offline by construction and reconciles through the existing sync
engine. `openStore()` selects remote *only* when `PEEK_MCP_REMOTE_URL` is set, and
`peek-mcp-init` sets it only when explicitly asked (§8). The remote store exists for hosts that
have no datastore to be local-first about.

### 7.2 Can a remote-backed session and the sync path both write?

**Yes, with one narrow known race.**

The mechanism already handles the common case. An item created by a remote MCP session lands in
`apps/server` with a server-minted `id` and an empty `syncId`. The desktop's next
`pullFromServer()` reaches `mergeServerItem()`, finds no local row with that `syncId`, and
inserts one with `syncId = serverItem.id` — so subsequent local edits push back under the same
identity and do not fork. Conflicts are last-write-wins on `updatedAt`, as documented at the top
of `sync.ts`; a remote MCP edit and a concurrent desktop edit to the same field resolve by
timestamp. Lost updates are possible and accepted for a personal store with a single human.

The genuine hazard is tags. `apps/server/db.js saveItem()`, on the `syncId`-matched push path,
runs `DELETE FROM item_tags WHERE itemId = ?` and then re-inserts the tag list from the pushed
body. So a desktop push carries an *authoritative whole tag set*: any tag added remotely and not
yet reflected in the desktop's local row is deleted by that push.

`syncAll()` mitigates this by ordering — it calls `pullFromServer()` before `pushToServer()`, so
a remotely-added tag is pulled into the local row (via `syncTagsToItem()`) before the push
recomputes the set. The exposure is the window between one sync's pull and its push: a
`tag_item` landing in that gap is dropped by the push and must be re-applied.

**Decision: accept the race for a first version, and narrow it rather than redesign the sync
protocol.** Two cheap measures: the `/mcp` tag routes stamp `items.updatedAt`, so the affected
item is included in the next incremental pull and self-heals on the following cycle; and the
push path's tag replacement is changed from unconditional delete-and-reinsert to a set
difference, so an unrelated tag the pusher never knew about is not collateral. A full fix — tag
membership as an additive log with tombstones — is out of scope (§9) and is the right thing to
do only if this proves to bite in practice.

---

## 8. What `peek-mcp-init` writes differently

`setup.js` currently: detects a bundled launcher (`detectBundledLauncher()`), locates a
datastore (`findDbPath()`), builds `env` via `buildEnv()` (`PEEK_DB_PATH`,
`PEEK_MCP_SCOPE_TAG`, optional `PEEK_MCP_READONLY`), writes `mcpServers.peek`, merges an
allowlist (`allowList()` / `mergeAllowEntries()`), scaffolds the skill
(`writeSkillFile()` over `peek-skill-template.js`), and manages a `.gitignore` block
(`writeGitignoreBlock()`).

Remote mode is a new flag, `--remote <url>`, plus these changes:

- **`buildEnv()` branches.** Remote entries carry `PEEK_MCP_REMOTE_URL` plus either
  `PEEK_MCP_TOKEN` (as a `${VAR}` reference) or `PEEK_MCP_CREDENTIAL`, and **omit `PEEK_DB_PATH`
  entirely**. `PEEK_MCP_SCOPE_TAG` is still
  written — not as the enforcement mechanism (§4.2), but so the child can fail fast and so
  `checkConfigDrift()` still has something to compare. `PEEK_MCP_READONLY` likewise.
- **`findDbPath()` is skipped, and its failure stops being fatal.** Today a missing datastore
  exits 1 with a three-path "Looked in:" message. In remote mode there is no datastore to look
  for; that whole branch is bypassed.
- **The launcher choice changes.** `detectBundledLauncher()` still wins where a Peek.app exists,
  but remote mode's whole point is hosts without one. The fallback `devSnippet()` currently
  emits `node --experimental-sqlite <server.js>`; in remote mode the `--experimental-sqlite`
  flag is dropped, since nothing loads `node:sqlite`.
- **Credential provisioning.** `--remote <url>` alone writes the environment-reference form
  (`"PEEK_MCP_TOKEN": "${PEEK_MCP_TOKEN}"`) and prints, on stderr, which variable the launching
  shell must carry. `--remote <url> --store-token` additionally reads the minted grant token from
  stdin, writes it to `~/.config/peek/mcp-credentials.json` at mode `0600` under the
  `<url>#<scope>` key, and emits `PEEK_MCP_CREDENTIAL` instead. The token is never echoed to
  stdout or stderr, never passed as an argv value, and never written into the project. `--print`
  emits the snippet containing the *reference only*, which makes it safe to paste into a cloud
  agent's configuration.
- **`detectExistingInstall()` learns remote entries.** It currently recovers `scope`, `writes`,
  and `profile` by regexing `PEEK_DB_PATH` for `/Peek/<profile>/datastore.sqlite`. It gains a
  branch that recognises `PEEK_MCP_REMOTE_URL`, recovers `remote`/`scope`/`writes`, and skips
  the profile regex, so a bare re-run refreshes a remote install the way it refreshes a local
  one.
- **The `.gitignore` block is unchanged** — the same three files are still per-developer wiring
  — but its comment gains the credential-file path as a note that the secret is deliberately
  *not* in the project.
- **The skill template gains a remote paragraph** (inside the `BODY_BEGIN`/`BODY_END` managed
  section of `peek-skill-template.js`, so the trailing project-specific section survives):
  item ids are server ids and `localId` is the id shown in the desktop UI; tool calls fail rather
  than degrade when the network is down; there is no offline mode.
- **The restart warning is unchanged and still correct** — env is still frozen at spawn.

---

## 9. Deliberately out of scope for a first version

- **MCP-over-HTTP from `apps/server`** — Phase 2 (§1). Phase 1 does not serve the protocol
  remotely, so a phone client is not yet reached.
- **OAuth.** Static minted bearer tokens only (§6).
- **Any offline cache or write queue** (§7.1). Deliberate, not deferred-by-omission.
- **Images and blobs.** `create_item` with `type: 'image'` against the remote store is refused
  with a clear error. `apps/server` has an image path (`saveImage()`, the `storage/` adapter)
  but the MCP layer has never created images, and wiring multipart upload through the store
  interface is unrelated work.
- **Field parity beyond §3.1.** `favicon`, `visitCount`, and `lastVisitAt` stay local-only.
  `starred` and `archived` are carried as columns for shape parity but nothing writes them
  remotely.
- **Changing any `"sync": false` decision.** §3.1 adds server columns; it does not alter what
  `sync.ts` carries. The local-only inventory and what each gap would cost is recorded in
  `docs/sync-coverage-gaps.md`.
- **FTS5.** The existing `PLAN.md` decision stands: search stays the `LIKE` pre-filter plus JS
  ranking, now executed server-side. If it becomes slow at server scale that is a
  `datastore.ts`-led change, unchanged from the reasoning already recorded there.
- **Tag-membership conflict resolution beyond §7.2's narrowing.**
- **Multi-profile switching mid-session.** The grant pins one `profile_id`; changing profiles
  means a new grant and a client restart, consistent with how `PEEK_DB_PATH` behaves today.
- **Per-tool grant permissions.** The credential carries one scope and one readonly bit, not a
  tool allowlist. `permissions.allow` in `settings.local.json` remains the client-side tool
  filter it is today.

---

## 10. Open questions

1. **Tag policy reconciliation between the two servers.** `db.js tagItemInTx()` writes a `slug`
   column and an integer `frecencyScore` from `calculateTagFrecency()`; `apps/server/db.js
   getOrCreateTagWithConn()` writes no slug and a float `frecencyScore` from its own
   `calculateFrecency()`. A tag created remotely and one created locally therefore differ in two
   stored fields, and `apps/desktop/main/datastore.ts` is the policy owner for both.
   **Settled by:** deciding whether the server adopts `datastore.ts`'s slug and rounding — which
   means a `tags.slug` column and a backfill on the server — or whether slug is declared
   local-only and the desktop recomputes it on pull. The existing schema-drift test
   (`apps/desktop/features/mcp-server/schema-drift.test.js`) is the natural place to pin
   whichever answer wins.

2. **Whether `title` and `domain` should sync between devices.** §3.1 gives phase 1 the columns
   it needs without touching this, but the two answers interact: while the fields stay
   `"sync": false`, a title set through the MCP API lives only on the server and a title set on
   the desktop lives only on the laptop, so the same item reads differently depending on which
   client is asked. Phase 1 is correct either way; the divergence is a user-visible oddity, not a
   correctness bug. **Settled by:** the `datastore.ts` policy call recorded in
   `docs/sync-coverage-gaps.md` §1.

3. **Whether `search_items` ranking stays honest at server scale.** The JS ranking in
   `searchItems()` is justified in `PLAN.md` by "the dataset is a personal store; the candidate
   set is small." That holds per-user on the server too, since every query is already
   user-and-profile-scoped by `getConnection(userId, profileId)`. It stops holding if a single
   account's store grows past the point where a per-term `LIKE` scan is acceptable *inside an
   HTTP request timeout* rather than inside a local process. **Settled by:** measuring the
   `LIKE` pre-filter against the largest real profile on the deployed server before Phase 2 adds
   more concurrent callers.
