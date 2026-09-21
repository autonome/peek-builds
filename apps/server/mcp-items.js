/**
 * Business logic for the `/mcp/*` item routes wired in `index.js`
 * (docs/mcp-remote-backend-design.md §3.3). Server-side ports of the same
 * queries `apps/desktop/features/mcp-server/store/sqlite-store.js` runs
 * against the local datastore — `queryItemsSync()`, `searchItemsSync()`,
 * `resolveItemIdSync()`, `getItemSync()`/`getTaskContextSync()`,
 * `createItemSync()`, `updateItemSync()`, `deleteItemSync()`, `tagItemInTx()`,
 * `untagItemSync()`, `recordEventSync()`, `completeTaskSync()` — and the scope
 * rules in `server.js` (`inScope()` / `tagIsScopeOwned()` /
 * `tagIsForeignNamespace()` / `withScopeTag()` / `validateWriteTags()`) —
 * duplicated here rather than shared because they now run against a
 * different SqlAdapter and a credential-bound scope rather than a
 * captured-at-open-time one. Column-set and formula parity is a known drift
 * hazard, same note as sqlite-store.js.
 *
 * The one behavioral difference from the desktop queries: `scopeTag` is a
 * parameter threaded in from the caller (the grant's `c.get('scopeTag')` in
 * index.js), never read from anything the client sends, and it is applied as
 * a `WHERE`-clause `EXISTS` subquery on every query — never a post-filter —
 * so `LIMIT`/`OFFSET` count in-scope rows only and an id/prefix matching only
 * out-of-scope items reads as not-found (design doc §4.1, §5). The readonly
 * bit follows the same rule (index.js reads it from `c.get('readonly')`
 * only) but is checked in the route handler, before any of these functions
 * run, since it never touches a query.
 */

const crypto = require("crypto");
const { getConnection } = require("./db");

// --- Shared helpers ---

function toTimestamp(val) {
  if (typeof val === "number") return Math.trunc(val);
  if (typeof val === "string") {
    if (val.includes("T")) return new Date(val).getTime() || 0;
    return Math.trunc(Number(val)) || 0;
  }
  return 0;
}

// Escapes literal `%`/`_`/`\` in a LIKE operand so it matches only itself.
// Mirrors escapeLikePrefix in sqlite-store.js.
function escapeLikePrefix(prefix) {
  return prefix.replace(/[\\%_]/g, (ch) => "\\" + ch);
}

// Scope confinement clause: an EXISTS subquery over item_tags/tags matching
// the scope tag exactly or a `<scope>:`-namespaced child, mirroring
// inScope()/tagIsScopeOwned() in server.js and the scope clause in
// resolveItemIdSync(). Empty scopeTag = unscoped = no restriction (returns
// an empty clause and no params). `alias` is the outer query's items alias.
function scopeClause(scopeTag, alias) {
  if (!scopeTag) return { sql: "", params: [] };
  return {
    sql: ` AND EXISTS (
      SELECT 1 FROM item_tags sit
      JOIN tags st ON st.id = sit.tagId
      WHERE sit.itemId = ${alias}.id
        AND (st.name = ? OR st.name LIKE ? ESCAPE '\\')
    )`,
    params: [scopeTag, escapeLikePrefix(scopeTag) + ":%"],
  };
}

// --- Write-side scope rules ---
//
// Reproduces the rule `apps/desktop/features/mcp-server/server.js` enforces
// client-side (`tagIsScopeOwned()` / `tagIsForeignNamespace()` /
// `inScope()` / `withScopeTag()` / `validateWriteTags()`) — not a shared
// import, since the desktop version closes over a process-local `SCOPE`
// constant and this one takes the grant's scope as an argument. A tag is
// scope-owned when it equals the scope tag exactly or is a `<scope>:`-
// namespaced child; any OTHER tag containing `:` names a foreign namespace
// and a write carrying it is refused. A bare tag with no colon (`todo`,
// `done`, `note`) is shared vocabulary and always allowed. Empty scopeTag =
// unscoped = no restriction anywhere in this section.

function tagIsScopeOwned(tag, scopeTag) {
  if (!scopeTag) return false;
  return tag === scopeTag || tag.startsWith(scopeTag + ":");
}

function tagIsForeignNamespace(tag, scopeTag) {
  if (!scopeTag) return false;
  if (tagIsScopeOwned(tag, scopeTag)) return false;
  return tag.includes(":");
}

function inScope(tags, scopeTag) {
  if (!scopeTag) return true;
  if (!tags || tags.length === 0) return false;
  return tags.some((t) => tagIsScopeOwned(t, scopeTag));
}

// Returns the first foreign-namespace tag found, or null when every tag is
// acceptable. A route handler turns a non-null result into a 400.
function findForeignNamespaceTag(tags, scopeTag) {
  if (!scopeTag || !tags) return null;
  for (const t of tags) {
    if (tagIsForeignNamespace(t, scopeTag)) return t;
  }
  return null;
}

// Force-adds the scope tag to a write's tag list so an item created (or
// tagged) through a scoped grant is always itself in that grant's scope.
function withScopeTag(tags, scopeTag) {
  if (!scopeTag) return tags || [];
  const list = Array.isArray(tags) ? [...tags] : [];
  if (!list.includes(scopeTag)) list.push(scopeTag);
  return list;
}

function fetchTagsForIds(conn, ids) {
  const byId = new Map();
  if (ids.length === 0) return byId;
  const placeholders = ids.map(() => "?").join(",");
  const rows = conn.all(
    `SELECT it.itemId, t.name FROM item_tags it JOIN tags t ON t.id = it.tagId WHERE it.itemId IN (${placeholders})`,
    ids
  );
  for (const r of rows) {
    if (!byId.has(r.itemId)) byId.set(r.itemId, []);
    byId.get(r.itemId).push(r.name);
  }
  return byId;
}

// Shape a raw `items` row (+ its tags) into the ItemView the design doc
// specifies (§3.2). `localId` is the desktop-side id (`items.syncId`, ''
// if the item was never synced) carried alongside the server `id` per §5's
// id-namespace note.
function shapeItemRow(row, tags) {
  return {
    id: row.id,
    localId: row.syncId || "",
    type: row.type,
    title: row.title || "",
    content: row.content,
    domain: row.domain || "",
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
    tags: tags || [],
    createdAt: toTimestamp(row.createdAt),
    updatedAt: toTimestamp(row.updatedAt),
    deletedAt: toTimestamp(row.deletedAt || 0),
    starred: row.starred || 0,
    archived: row.archived || 0,
    // Local-only on the desktop, never carried by the server — see design
    // doc §3.1's "deliberately still absent" list. Present for shape parity.
    visitCount: 0,
    frecencyScore: row.frecencyScore || 0,
  };
}

// --- list_items: GET /mcp/items ---
//
// Server-side port of queryItemsSync(), including its all-tags-match
// `GROUP BY … HAVING COUNT(DISTINCT t.id) = ?` semantics. The scope clause
// is inside the WHERE that GROUP BY/LIMIT/OFFSET run over, so paging can
// never cross into out-of-scope rows.
function queryItems(userId, profileId, scopeTag, { tags, type, limit = 50, offset = 0, sort = "recent" } = {}) {
  const conn = getConnection(userId, profileId);
  const orderCol = sort === "frecency" ? "frecencyScore" : "createdAt";

  let rows;
  if (tags && tags.length > 0) {
    const scope = scopeClause(scopeTag, "i");
    const placeholders = tags.map(() => "?").join(",");
    const sql = `
      SELECT i.id, i.type, i.content, i.title, i.domain, i.metadata, i.syncId,
             i.createdAt, i.updatedAt, i.deletedAt, i.starred, i.archived, i.frecencyScore
      FROM items i
      JOIN item_tags it ON i.id = it.itemId
      JOIN tags t ON it.tagId = t.id
      WHERE t.name IN (${placeholders}) AND CAST(i.deletedAt AS INTEGER) = 0${scope.sql}
      GROUP BY i.id
      HAVING COUNT(DISTINCT t.id) = ?
      ORDER BY i.${orderCol} DESC
      LIMIT ? OFFSET ?
    `;
    rows = conn.all(sql, [...tags, ...scope.params, tags.length, limit, offset]);
  } else {
    const scope = scopeClause(scopeTag, "items");
    let sql = `
      SELECT id, type, content, title, domain, metadata, syncId,
             createdAt, updatedAt, deletedAt, starred, archived, frecencyScore
      FROM items
      WHERE CAST(deletedAt AS INTEGER) = 0${scope.sql}
    `;
    const params = [...scope.params];
    if (type) {
      sql += " AND type = ?";
      params.push(type);
    }
    sql += ` ORDER BY ${orderCol} DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    rows = conn.all(sql, params);
  }

  if (rows.length === 0) return [];
  const tagsById = fetchTagsForIds(conn, rows.map((r) => r.id));
  return rows.map((r) => shapeItemRow(r, tagsById.get(r.id)));
}

// --- search_items: GET /mcp/items/search ---
//
// Port of searchItemsSync(): same per-term LIKE pre-filter over
// title/content/domain/tag-blob with ESCAPE '\', same JS ranking
// (SEARCH_WEIGHTS, SNIPPET_RADIUS, buildSnippet). The scope clause is part
// of the SQL candidate filter, so ranking/paging run over an
// already-scope-confined candidate set — never a superset that gets
// filtered afterward.

const SEARCH_WEIGHTS = { title: 10, tag: 6, domain: 4, content: 2 };
const SNIPPET_RADIUS = 40;

function tokenizeQuery(query) {
  if (typeof query !== "string") return [];
  return query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function buildSnippet(text, term) {
  if (!text) return "";
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return "";
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + term.length + SNIPPET_RADIUS);
  let snip = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snip = "…" + snip;
  if (end < text.length) snip = snip + "…";
  return snip;
}

function searchItems(userId, profileId, scopeTag, { query, tags, type, limit = 20, offset = 0 } = {}) {
  const conn = getConnection(userId, profileId);
  const terms = tokenizeQuery(query);
  if (terms.length === 0) return [];

  const tagBlobExpr = `(
    SELECT COALESCE(GROUP_CONCAT(t2.name, ' '), '')
    FROM item_tags it2 JOIN tags t2 ON t2.id = it2.tagId
    WHERE it2.itemId = i.id
  )`;

  const conditions = ["CAST(i.deletedAt AS INTEGER) = 0"];
  const params = [];
  for (const term of terms) {
    const like = "%" + escapeLikePrefix(term) + "%";
    conditions.push(
      `(i.title LIKE ? ESCAPE '\\' OR i.content LIKE ? ESCAPE '\\' ` +
        `OR i.domain LIKE ? ESCAPE '\\' OR ${tagBlobExpr} LIKE ? ESCAPE '\\')`
    );
    params.push(like, like, like, like);
  }
  if (type) {
    conditions.push("i.type = ?");
    params.push(type);
  }

  const scope = scopeClause(scopeTag, "i");

  let sql;
  let allParams;
  if (tags && tags.length > 0) {
    const placeholders = tags.map(() => "?").join(",");
    sql = `
      SELECT i.id, i.type, i.content, i.title, i.domain, i.metadata, i.syncId,
             i.createdAt, i.updatedAt, i.deletedAt, i.starred, i.archived, i.frecencyScore,
             ${tagBlobExpr} AS tagBlob
      FROM items i
      JOIN item_tags it ON i.id = it.itemId
      JOIN tags t ON it.tagId = t.id
      WHERE t.name IN (${placeholders}) AND ${conditions.join(" AND ")}${scope.sql}
      GROUP BY i.id
      HAVING COUNT(DISTINCT t.id) = ?
    `;
    allParams = [...tags, ...params, ...scope.params, tags.length];
  } else {
    sql = `
      SELECT i.id, i.type, i.content, i.title, i.domain, i.metadata, i.syncId,
             i.createdAt, i.updatedAt, i.deletedAt, i.starred, i.archived, i.frecencyScore,
             ${tagBlobExpr} AS tagBlob
      FROM items i
      WHERE ${conditions.join(" AND ")}${scope.sql}
    `;
    allParams = [...params, ...scope.params];
  }

  const candidates = conn.all(sql, allParams);
  if (candidates.length === 0) return [];

  const lowerTerms = terms.map((t) => t.toLowerCase());
  const scored = candidates.map((r) => {
    const title = (r.title || "").toLowerCase();
    const content = (r.content || "").toLowerCase();
    const domain = (r.domain || "").toLowerCase();
    const tagBlob = (r.tagBlob || "").toLowerCase();

    let score = 0;
    let firstSnippetTerm = null;
    let firstSnippetInContent = false;

    for (const term of lowerTerms) {
      const inTitle = title.includes(term);
      const inTag = tagBlob.includes(term);
      const inDomain = domain.includes(term);
      const inContent = content.includes(term);
      if (!inTitle && !inTag && !inDomain && !inContent) continue;

      const hitWeights = [];
      if (inTitle) hitWeights.push(SEARCH_WEIGHTS.title);
      if (inTag) hitWeights.push(SEARCH_WEIGHTS.tag);
      if (inDomain) hitWeights.push(SEARCH_WEIGHTS.domain);
      if (inContent) hitWeights.push(SEARCH_WEIGHTS.content);
      const best = Math.max(...hitWeights);
      score += best + (hitWeights.length - 1);

      if (firstSnippetTerm === null) {
        firstSnippetTerm = term;
        firstSnippetInContent = inContent;
      }
    }

    let snippet = "";
    if (firstSnippetTerm !== null) {
      snippet = firstSnippetInContent
        ? buildSnippet(r.content, firstSnippetTerm)
        : buildSnippet(r.title, firstSnippetTerm) || buildSnippet(r.content, firstSnippetTerm);
    }

    return { row: r, score, snippet };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const fa = a.row.frecencyScore || 0;
    const fb = b.row.frecencyScore || 0;
    if (fb !== fa) return fb - fa;
    return (b.row.updatedAt || 0) - (a.row.updatedAt || 0);
  });

  const page = scored.slice(offset, offset + limit);
  if (page.length === 0) return [];

  const tagsById = fetchTagsForIds(conn, page.map((s) => s.row.id));
  return page.map((s) => {
    const view = shapeItemRow(s.row, tagsById.get(s.row.id));
    view.score = s.score;
    view.snippet = s.snippet;
    return view;
  });
}

// --- Prefix resolution: GET /mcp/items/resolve, and inline for GET
//     /mcp/items/:idOrPrefix ---
//
// Port of resolveItemIdSync(), extended per design doc §5's id-namespace
// note: server ids and desktop ids differ (a pushed item is stored under a
// server-minted `id` with the desktop's id in `syncId`), so resolution
// matches EITHER `items.id` or `items.syncId`, exact-match-first across
// both. A row matching on both columns is de-duplicated by `id` (a single
// WHERE clause over one table returns each physical row once, regardless of
// how many of its predicates matched).
//
// Scope-confined on every branch: an exact match on an out-of-scope row is
// not returned, so a prefix matching only out-of-scope items reads as
// { id: null } — indistinguishable from a genuine miss — and the ambiguity
// candidate list is built solely from scope-confined rows, so it can never
// name an out-of-scope id or title.
const PREFIX_AMBIGUITY_LIMIT = 10;

function resolveItemId(userId, profileId, scopeTag, prefix) {
  if (typeof prefix !== "string" || prefix === "") return { id: null };
  const conn = getConnection(userId, profileId);
  const scope = scopeClause(scopeTag, "items");

  // 1. Exact match on either column always wins and short-circuits, scope-
  //    confined — even when it's also a prefix of other items. `items.id` is
  //    a primary key so at most one row can match it exactly; `syncId` is
  //    not unique, so a value could in principle exact-match more than one
  //    row across the two columns. That case is reported as ambiguous rather
  //    than resolved arbitrarily.
  const exactRows = conn.all(
    `SELECT id, title FROM items WHERE (id = ? OR syncId = ?)${scope.sql}`,
    [prefix, prefix, ...scope.params]
  );
  if (exactRows.length === 1) return { id: exactRows[0].id };
  if (exactRows.length > 1) {
    return {
      id: null,
      ambiguous: true,
      candidates: exactRows.slice(0, PREFIX_AMBIGUITY_LIMIT).map((r) => ({ id: r.id, title: r.title })),
      truncated: exactRows.length > PREFIX_AMBIGUITY_LIMIT,
    };
  }

  // 2. Prefix-anchored scan over both columns, scope-confined.
  const pattern = escapeLikePrefix(prefix) + "%";
  const rows = conn.all(
    `SELECT id, title FROM items
     WHERE (id LIKE ? ESCAPE '\\' OR syncId LIKE ? ESCAPE '\\')${scope.sql}
     ORDER BY id
     LIMIT ?`,
    [pattern, pattern, ...scope.params, PREFIX_AMBIGUITY_LIMIT + 1]
  );

  if (rows.length === 0) return { id: null };
  if (rows.length === 1) return { id: rows[0].id };

  return {
    id: null,
    ambiguous: true,
    candidates: rows.slice(0, PREFIX_AMBIGUITY_LIMIT).map((r) => ({ id: r.id, title: r.title })),
    truncated: rows.length > PREFIX_AMBIGUITY_LIMIT,
  };
}

// --- get_item / get_task_context: GET /mcp/items/:idOrPrefix ---
//
// Content windowing, byte-identical to normalizeContentWindow() +
// shapeItemForResponse() in server.js (minus the favicon strip — the server
// has no favicon column).
const DEFAULT_MAX_CONTENT_LENGTH = 4000;

function windowContent(item, { maxContentLength, contentOffset } = {}) {
  if (typeof item.content !== "string") return; // null content: nothing to window

  let max = DEFAULT_MAX_CONTENT_LENGTH;
  if (typeof maxContentLength === "number" && Number.isFinite(maxContentLength)) {
    if (maxContentLength === -1) max = Infinity;
    else if (maxContentLength >= 0) max = Math.floor(maxContentLength);
  }
  let offset = 0;
  if (typeof contentOffset === "number" && Number.isFinite(contentOffset) && contentOffset > 0) {
    offset = Math.floor(contentOffset);
  }

  const fullLength = item.content.length;
  item.contentLength = fullLength;
  const end = max === Infinity ? fullLength : Math.min(fullLength, offset + max);
  if (offset > 0 || end < fullLength) {
    item.content = item.content.slice(offset, Math.max(offset, end));
    item.contentTruncated = true;
  }
}

// item_events window backing get_task_context. db.js getTaskContextSync()
// (desktop) always uses a fixed LIMIT 20 with no per-call option; the
// `events=<n>` query param is honored as a limit up to that same ceiling, so
// a caller can ask for fewer events but never more than the local behavior
// returns.
function fetchEvents(conn, itemId, requestedLimit) {
  const parsed = Number(requestedLimit);
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(20, Math.floor(parsed)) : 20;
  return conn.all(
    `SELECT id, content as type, value, occurredAt, metadata
     FROM item_events WHERE itemId = ? ORDER BY occurredAt DESC LIMIT ?`,
    [itemId, limit]
  );
}

function fetchItemRowById(conn, id, scopeTag) {
  // Pure lookup by resolved id: does NOT filter deletedAt, matching
  // getItemSync()'s parity (a soft-deleted item is still reachable by its
  // exact id/resolved prefix; list_items/search_items are the surfaces that
  // filter deletedAt). Scope is re-checked here as defense in depth even
  // though resolveItemId() already confined the id it returned.
  const scope = scopeClause(scopeTag, "items");
  return conn.get(
    `SELECT id, type, content, title, domain, metadata, syncId, createdAt, updatedAt, deletedAt, starred, archived, frecencyScore
     FROM items WHERE id = ?${scope.sql}`,
    [id, ...scope.params]
  );
}

/**
 * Resolve `idOrPrefix` and return the shaped item, or the ambiguity/not-found
 * outcome for the route handler to translate into 200/404/409.
 *
 * @returns {{status:'ok', item:object} | {status:'not_found'} | {status:'ambiguous', candidates:object[], truncated:boolean}}
 */
function getItemForRoute(userId, profileId, scopeTag, idOrPrefix, { maxContentLength, contentOffset, events } = {}) {
  const conn = getConnection(userId, profileId);
  const resolved = resolveItemId(userId, profileId, scopeTag, idOrPrefix);
  if (resolved.ambiguous) {
    return { status: "ambiguous", candidates: resolved.candidates, truncated: resolved.truncated };
  }
  if (resolved.id === null) return { status: "not_found" };

  const row = fetchItemRowById(conn, resolved.id, scopeTag);
  if (!row) return { status: "not_found" }; // defense in depth; scope already applied by resolveItemId

  const tagsById = fetchTagsForIds(conn, [row.id]);
  const item = shapeItemRow(row, tagsById.get(row.id));
  windowContent(item, { maxContentLength, contentOffset });

  if (events !== undefined) {
    item.events = fetchEvents(conn, row.id, events);
  }

  return { status: "ok", item };
}

// --- list_tags: GET /mcp/tags ---
//
// Port of listTagsSync(), scope-filtered the same way list_tags/peek://tags
// are on the desktop (`tagIsScopeOwned()` post-filter in server.js) — when
// scoped, only tags that ARE the scope tag or a `<scope>:` child are
// returned, so a bare shared-vocabulary tag like `todo` never appears in a
// scoped session's tag list even though items carrying it (alongside an
// in-scope tag) are still visible through the item routes.
//
// `color`/`description` are `"sync": false` ("desktop only") in
// packages/schema/v1.json — the server has no columns for them and phase 1
// deliberately does not add any (open question 1, design doc §10). They are
// included here at their schema-default values purely for TagView shape
// parity, the same treatment ItemView gives `visitCount`.
function listTags(userId, profileId, scopeTag, { search, limit = 100 } = {}) {
  const conn = getConnection(userId, profileId);
  const conditions = [];
  const params = [];
  if (search) {
    conditions.push("t.name LIKE ?");
    params.push(`%${search}%`);
  }
  if (scopeTag) {
    conditions.push(`(t.name = ? OR t.name LIKE ? ESCAPE '\\')`);
    params.push(scopeTag, escapeLikePrefix(scopeTag) + ":%");
  }

  let sql = `
    SELECT t.id, t.name, t.frecencyScore, COUNT(it.itemId) as itemCount
    FROM tags t
    LEFT JOIN item_tags it ON t.id = it.tagId
    LEFT JOIN items i ON it.itemId = i.id AND CAST(i.deletedAt AS INTEGER) = 0
  `;
  if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`;
  sql += ` GROUP BY t.id ORDER BY t.frecencyScore DESC LIMIT ?`;
  params.push(limit);

  return conn.all(sql, params).map((r) => ({
    id: r.id,
    name: r.name,
    color: "#999999",
    description: "",
    itemCount: r.itemCount || 0,
  }));
}

// --- Tag write policy ---
//
// Reproduces `tagItemInTx()` from
// apps/desktop/features/mcp-server/store/sqlite-store.js: same
// ON CONFLICT(name) upsert (closes the read-then-insert race two grants
// writing the same new tag at once would otherwise hit), same two-step
// frecency write (initial value in the upsert, then a recompute from the
// post-increment frequency — the upsert can't reference the row's own
// pre-update frequency in one statement).
//
// Two deliberate divergences from that function, both schema-driven
// (packages/schema/v1.json, design doc §10 open question 1):
//   - No `slug` column is written. `tags.slug` is marked `"sync": false`,
//     "desktop only" — the server's `tags` table has no such column, and
//     phase 1 does not add one.
//   - Frecency is computed with THIS file's `calculateTagFrecency()`, which
//     matches `sqlite-store.js`'s formula (integer, `Math.round`), NOT this
//     file's neighbor `db.js calculateFrecency()` (float, no rounding).
//     `tags.frecencyScore` is `"sync": true` — a tag written through
//     `/mcp/*` and one written on the desktop must compute the identical
//     value, or every sync merges two different numbers for the same tag.
function calculateTagFrecency(frequency, lastUsed) {
  const daysSinceUse = (Date.now() - lastUsed) / (1000 * 60 * 60 * 24);
  const decayFactor = 1 / (1 + daysSinceUse / 7);
  return Math.round(frequency * 10 * decayFactor);
}

// Internal: assumes a transaction is already open (or the caller doesn't
// need one — a single tag_item call is one statement group either way).
function tagItemInTx(conn, itemId, tagName, now) {
  const initialFrecency = calculateTagFrecency(1, now);
  conn.run(
    `INSERT INTO tags (id, name, frequency, lastUsed, frecencyScore, createdAt, updatedAt)
     VALUES (?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       frequency = frequency + 1,
       lastUsed = excluded.lastUsed,
       frecencyScore = ?,
       updatedAt = excluded.updatedAt`,
    [crypto.randomUUID(), tagName, now, initialFrecency, now, now, initialFrecency]
  );

  const tag = conn.get("SELECT id, frequency FROM tags WHERE name = ?", [tagName]);
  conn.run("UPDATE tags SET frecencyScore = ? WHERE id = ?", [calculateTagFrecency(tag.frequency, now), tag.id]);

  conn.run(
    "INSERT OR IGNORE INTO item_tags (itemId, tagId, createdAt) VALUES (?, ?, ?)",
    [itemId, tag.id, now]
  );
  return tag.id;
}

// Internal: removes a tag from an item if both the tag and the association
// exist; a no-op otherwise (matching untagItem()'s "Tag not found" ok-path,
// just without the status wrapper since callers here don't need it).
// Assumes a transaction is already open.
function untagItemInTx(conn, itemId, tagName) {
  const tag = conn.get("SELECT id FROM tags WHERE name = ?", [tagName]);
  if (!tag) return;
  conn.run("DELETE FROM item_tags WHERE itemId = ? AND tagId = ?", [itemId, tag.id]);
}

// --- create_item: POST /mcp/items ---
//
// Images are explicitly out of scope for the remote MCP backend (design doc
// §9): the MCP layer has never created images, and wiring multipart upload
// through this store interface is unrelated work. CREATABLE_ITEM_TYPES
// mirrors SYNCABLE_ITEM_TYPES in index.js minus 'image'.
const CREATABLE_ITEM_TYPES = ["url", "text", "tagset", "series", "feed", "entity"];

/**
 * @returns {{status:'invalid', error:string} | {status:'ok', item:object}}
 */
function createItem(userId, profileId, scopeTag, body = {}) {
  const { type, url, title = "", content = "", metadata = {}, tags = [], extractHashtags = false } = body;

  if (!type) return { status: "invalid", error: "type is required" };
  if (type === "image") {
    return { status: "invalid", error: "type 'image' is not supported by the remote MCP backend (design doc §9)." };
  }
  if (!CREATABLE_ITEM_TYPES.includes(type)) {
    return { status: "invalid", error: `type must be one of: ${CREATABLE_ITEM_TYPES.join(", ")}` };
  }

  const badTag = findForeignNamespaceTag(tags, scopeTag);
  if (badTag) return { status: "invalid", error: `Tag "${badTag}" is outside scope "${scopeTag}".` };

  const conn = getConnection(userId, profileId);
  const id = crypto.randomUUID();
  const now = Date.now();

  let domain = "";
  let itemContent = content;
  if (type === "url" && url) {
    itemContent = url;
    try { domain = new URL(url).hostname; } catch { /* ignore */ }
  }
  const metaStr = typeof metadata === "string" ? metadata : JSON.stringify(metadata);

  conn.transaction(() => {
    conn.run(
      `INSERT INTO items (id, type, content, title, domain, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt, createdByDevice, starred, archived, frecencyScore)
       VALUES (?, ?, ?, ?, ?, ?, '', 0, ?, ?, 0, '', 0, 0, 0)`,
      [id, type, itemContent, title, domain, metaStr, now, now]
    );

    // Hashtag auto-extraction is opt-in (same reasoning as createItemSync):
    // an LLM caller routinely writes "#123" issue refs or "#3)" enumeration
    // prose, neither of which should silently become tags.
    const autoTags = extractHashtags && type === "text" ? extractHashtagsFromContent(itemContent) : [];
    const allTags = [...new Set([...withScopeTag(tags, scopeTag), ...autoTags])];
    for (const tagName of allTags) tagItemInTx(conn, id, tagName, now);
  });

  const row = fetchItemRowById(conn, id, scopeTag);
  const tagsById = fetchTagsForIds(conn, [id]);
  return { status: "ok", item: shapeItemRow(row, tagsById.get(id)) };
}

// Hashtag extraction: matches sqlite-store.js's extractHashtagsFromContent(),
// which itself matches datastore.ts `syncContentHashtags`.
function extractHashtagsFromContent(content) {
  if (!content) return [];
  const matches = content.match(/(?:^|\s)#([^\s#]+)/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.trim().slice(1)))];
}

// --- update_item: PATCH /mcp/items/:id ---
//
// No prefix resolution here — mutating routes are always called against a
// full id the client already resolved via GET /mcp/items/resolve (design
// doc §5's "mutating tools resolve explicitly" decision).
function updateItem(userId, profileId, scopeTag, id, patch = {}) {
  const conn = getConnection(userId, profileId);
  const existing = fetchItemRowById(conn, id, scopeTag);
  if (!existing) return { status: "not_found" };

  const { title, content, metadata } = patch;
  const sets = [];
  const params = [];
  if (title !== undefined) { sets.push("title = ?"); params.push(title); }
  if (content !== undefined) { sets.push("content = ?"); params.push(content); }
  if (metadata !== undefined) {
    sets.push("metadata = ?");
    params.push(typeof metadata === "string" ? metadata : JSON.stringify(metadata));
  }
  if (sets.length > 0) {
    sets.push("updatedAt = ?");
    params.push(Date.now());
    params.push(id);
    conn.run(`UPDATE items SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  const row = fetchItemRowById(conn, id, scopeTag);
  const tagsById = fetchTagsForIds(conn, [id]);
  return { status: "ok", item: shapeItemRow(row, tagsById.get(id)) };
}

// --- delete_item: DELETE /mcp/items/:id ---
//
// Soft delete only — deliberately does NOT cascade into item_events. Making
// this the one hard delete in the path (item_events has no deletedAt column
// to tombstone instead) would mean a routine, reversible action silently
// destroys data a caller has no way to recover, and nothing about existing
// delete semantics needs to change to fix the item-events gap this file's
// header comment tracks. A caller that wants an item's events gone uses
// deleteEvents() (DELETE /mcp/items/:id/events) explicitly, before or after
// deleting the item itself — either order leaves an orphaned-but-inert
// event row at worst, never a silent loss tied to an unrelated call.
function deleteItem(userId, profileId, scopeTag, id) {
  const conn = getConnection(userId, profileId);
  const existing = fetchItemRowById(conn, id, scopeTag);
  if (!existing) return { status: "not_found" };

  const now = Date.now();
  conn.run("UPDATE items SET deletedAt = ?, updatedAt = ? WHERE id = ?", [now, now, id]);
  return { status: "ok", result: { success: true, id } };
}

// --- tag_item: POST /mcp/items/:id/tags ---
//
// Unlike create_item, a single tag_item call does NOT force-add the scope
// tag — it adds exactly the one tag named, validated against the foreign-
// namespace rule (matches server.js's tag_item branch, which calls
// validateWriteTags([args.tagName]) with no withScopeTag()). Stamps
// items.updatedAt so the item is picked up by the next incremental pull
// (design doc §7.2's tag-race mitigation).
function tagItem(userId, profileId, scopeTag, id, tagName) {
  if (typeof tagName !== "string" || tagName === "") {
    return { status: "invalid", error: "name is required" };
  }
  const conn = getConnection(userId, profileId);
  const existing = fetchItemRowById(conn, id, scopeTag);
  if (!existing) return { status: "not_found" };

  if (tagIsForeignNamespace(tagName, scopeTag)) {
    return { status: "invalid", error: `Tag "${tagName}" is outside scope "${scopeTag}".` };
  }

  const now = Date.now();
  conn.transaction(() => {
    tagItemInTx(conn, id, tagName, now);
    conn.run("UPDATE items SET updatedAt = ? WHERE id = ?", [now, id]);
  });
  return { status: "ok", result: { success: true, itemId: id, tagName } };
}

// --- untag_item: DELETE /mcp/items/:id/tags/:name ---
//
// The orphan rule (design doc §4.1's last bullet): removing a scope-owned
// tag that would leave the item with no remaining in-scope tag is refused
// server-side, because that item would otherwise silently vanish from every
// query this grant's scope confines. Mirrors the `untag_item` branch of
// `handleToolCall()` in server.js exactly — the check runs against the
// item's CURRENT tags (not just whether the named tag is scope-owned), so
// dropping one of two in-scope tags is fine as long as the other survives.
function untagItem(userId, profileId, scopeTag, id, tagName) {
  const conn = getConnection(userId, profileId);
  const existing = fetchItemRowById(conn, id, scopeTag);
  if (!existing) return { status: "not_found" };

  if (tagIsScopeOwned(tagName, scopeTag)) {
    const currentTags = fetchTagsForIds(conn, [id]).get(id) || [];
    const remaining = currentTags.filter((t) => t !== tagName);
    if (!inScope(remaining, scopeTag)) {
      return {
        status: "orphan",
        error: `Cannot untag "${tagName}" — it is the only tag keeping this item in scope "${scopeTag}". ` +
          `Add another ${scopeTag} or ${scopeTag}:* tag first, then retry.`,
      };
    }
  }

  const tag = conn.get("SELECT id FROM tags WHERE name = ?", [tagName]);
  if (!tag) return { status: "ok", result: { success: false, error: "Tag not found" } };

  const now = Date.now();
  conn.run("DELETE FROM item_tags WHERE itemId = ? AND tagId = ?", [id, tag.id]);
  conn.run("UPDATE items SET updatedAt = ? WHERE id = ?", [now, id]);
  return { status: "ok", result: { success: true, itemId: id, tagName } };
}

// --- record_event: POST /mcp/items/:id/events ---
//
// Backward compatibility is required, not optional (apps/server/test.js pins
// it): a caller sending only {type, value} — every caller before this
// comment existed — must get exactly the row recordEventSync() writes for
// that shape: content = type, value hardcoded to 0, metadata =
// {notes: value} (or '{}' with no value), occurredAt = the server clock.
// That branch runs whenever content/occurredAt/metadata are all absent from
// the body, regardless of what's added below.
//
// `content`, `occurredAt` and `metadata` are new, optional body fields that
// store into the columns of those names directly, unwrapped — the fix for
// "a feed entry's link and publication date have nowhere to go" (this file's
// header comment). `type` stays required in every case (it still falls back
// into the content column when `content` itself is omitted) — a caller with
// a real content string, a backdated occurredAt or a structured metadata
// object passes one or more of the three alongside a `type` label of its own
// choosing, e.g. "feed_entry". That label is not itself stored when `content`
// is supplied — item_events has one column for the two of them — so a caller
// that needs its events distinguishable by kind later carries the label in
// `metadata`; listEvents() below returns the content column unaliased so the
// two are never confused. Supplying `metadata` explicitly also switches
// `value` from notes-wrapped text to a real number stored in the value
// column, since an explicit metadata object means the caller isn't relying
// on the old notes-wrapping behavior for it — which means `value` has to
// actually BE a number in that case. Coercing a non-numeric string (e.g.
// `Number("some text") || 0`) would silently turn a caller's real text into
// a bare 0 with no error, right on the shape someone migrating off the old
// {type, value} API would plausibly send (real value text, newly-added
// metadata). parseNumericEventValue() below refuses instead of coercing.
function parseNumericEventValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function recordEvent(userId, profileId, scopeTag, id, body = {}) {
  const { type, value = "", content, occurredAt, metadata } = body;
  if (typeof type !== "string" || type === "") {
    return { status: "invalid", error: "type is required" };
  }

  // metaStr/valueVal need metadata's presence resolved before touching the
  // DB, same as the type check above — an invalid body is invalid
  // regardless of whether the item exists.
  let metaStr;
  let valueVal;
  if (metadata !== undefined) {
    metaStr = typeof metadata === "string" ? metadata : JSON.stringify(metadata);
    if (!value) {
      valueVal = 0;
    } else {
      const parsed = parseNumericEventValue(value);
      if (parsed === null) {
        return {
          status: "invalid",
          error:
            "value must be a number when metadata is supplied — put free-form text in metadata itself, not value.",
        };
      }
      valueVal = parsed;
    }
  } else {
    metaStr = value ? JSON.stringify({ notes: value }) : "{}";
    valueVal = 0;
  }

  const conn = getConnection(userId, profileId);
  const existing = fetchItemRowById(conn, id, scopeTag);
  if (!existing) return { status: "not_found" };

  const eventId = crypto.randomUUID();
  const now = Date.now();

  const contentVal = content !== undefined ? content : type;
  const occurredAtVal = occurredAt !== undefined ? toTimestamp(occurredAt) : now;

  conn.run(
    `INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [eventId, id, contentVal, valueVal, occurredAtVal, metaStr, now]
  );
  return { status: "ok", result: { success: true, id: eventId, itemId: id, type } };
}

// --- list_events: GET /mcp/items/:id/events ---
//
// A dedicated paged read, distinct from the `events=N` convenience embedded
// in GET /mcp/items/:idOrPrefix (fetchEvents(), capped at 20 to match
// getTaskContextSync()'s fixed window — that path is a convenience and stays
// as it is; changing its cap is a separate argument). This route exists
// because a caller like a feed poller needs to dedupe against however many
// events an item actually has, not a fixed 20 — see this file's header
// comment on fetchEvents() capping the result regardless of what's asked
// for. EVENTS_PAGE_LIMIT (200) is the ceiling, well above 20.
//
// Returns the `content` column under its own name, NOT aliased to `type` the
// way fetchEvents() and getTaskContextSync()'s embedded window still do. There
// is no `type` column on item_events (db.js's DDL, packages/schema/v1.json):
// the content column holds whatever recordEvent() resolved out of
// `content ?? type`, so the alias only told the truth while `content` was not
// a field a caller could supply. It is one now, and under the alias a caller
// that supplies content reads its own string back from a field named `type`
// while the type label it sent is absent from the row entirely — events become
// impossible to tell apart by kind on the one route built for a caller that
// has to. Naming the column honestly is the fix available without adding a
// column to a synced table; a caller that needs a kind label puts it in
// `metadata`, which is caller-owned and round-trips verbatim.
//
// The embedded `?events=N` path keeps the alias: it is a compatibility surface
// with a fixed 20-row window and its own callers, and changing its shape is a
// separate argument from this one.
//
// `metadata` stays a raw (unparsed) JSON string, matching fetchEvents() — that
// asymmetry with shapeItemRow() (which parses an item's own metadata) is
// preserved deliberately rather than fixed by accident.
const EVENTS_PAGE_LIMIT = 200;

function listEvents(userId, profileId, scopeTag, id, { limit = 50, offset = 0 } = {}) {
  const conn = getConnection(userId, profileId);
  const existing = fetchItemRowById(conn, id, scopeTag);
  if (!existing) return { status: "not_found" };

  const parsedLimit = Number(limit);
  const boundedLimit =
    Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(EVENTS_PAGE_LIMIT, Math.floor(parsedLimit)) : 50;
  const parsedOffset = Number(offset);
  const boundedOffset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? Math.floor(parsedOffset) : 0;

  const events = conn.all(
    `SELECT id, content, value, occurredAt, metadata
     FROM item_events WHERE itemId = ? ORDER BY occurredAt DESC LIMIT ? OFFSET ?`,
    [id, boundedLimit, boundedOffset]
  );
  return { status: "ok", events };
}

// --- delete_event: DELETE /mcp/items/:id/events/:eventId ---
//
// A hard delete, unlike deleteItem()'s soft one — item_events has no
// deletedAt column, being an append-only sync-pushed log (saveEvents() /
// getEventsSince() in db.js) that was never designed with a tombstone.
// Scoped to the item via fetchItemRowById() (an out-of-scope item id reads
// as not-found, same as every other write route) AND to itemId in the
// DELETE itself, so a caller can't reach another item's event by id alone.
// An eventId that doesn't exist under this item is reported the same way
// untagItem() reports a missing tag: 200 with {success:false}, not a 404 —
// the ITEM was found, the requested removal just had nothing to do.
function deleteEvent(userId, profileId, scopeTag, id, eventId) {
  const conn = getConnection(userId, profileId);
  const existing = fetchItemRowById(conn, id, scopeTag);
  if (!existing) return { status: "not_found" };

  const result = conn.run("DELETE FROM item_events WHERE id = ? AND itemId = ?", [eventId, id]);
  if (result.changes === 0) {
    return { status: "ok", result: { success: false, error: "Event not found" } };
  }
  return { status: "ok", result: { success: true, id: eventId, itemId: id } };
}

// --- delete_events: DELETE /mcp/items/:id/events ---
//
// Removes every event under one item — the explicit, hard-delete
// alternative deleteItem()'s comment points to, for a caller that wants an
// item's event history cleared (e.g. before re-polling a feed from scratch)
// without deleting the item itself.
function deleteEvents(userId, profileId, scopeTag, id) {
  const conn = getConnection(userId, profileId);
  const existing = fetchItemRowById(conn, id, scopeTag);
  if (!existing) return { status: "not_found" };

  const result = conn.run("DELETE FROM item_events WHERE itemId = ?", [id]);
  return { status: "ok", result: { success: true, itemId: id, deleted: result.changes } };
}

// --- complete_task: POST /mcp/tasks/:id/complete ---
//
// One transaction, records the completion event and swaps status tags.
// Wrapped so a mid-way failure (e.g. the event insert) leaves the tag state
// exactly as it was.
//
// Unscoped session (empty scopeTag): unchanged from before namespaced status
// tags existed — add `done`, remove `todo`. `accepted` is ignored.
//
// Scoped session: bare `todo`/`done` are never touched, only the `<scope>:*`
// namespace. `accepted` false or absent (the default — someone other than
// the task's owner is reporting the work as done) adds `<scope>:needs-review`
// and removes `<scope>:todo`/`wip`/`ready`/`triage`, leaving the item in the
// work queue for review. `accepted: true` (the owner has approved the work)
// adds `<scope>:done` and also removes `<scope>:needs-review`, taking the
// item out of the queue for good.
function completeTask(userId, profileId, scopeTag, id, notes = "", accepted = false) {
  const conn = getConnection(userId, profileId);
  const existing = fetchItemRowById(conn, id, scopeTag);
  if (!existing) return { status: "not_found" };

  conn.transaction(() => {
    const now = Date.now();

    if (scopeTag) {
      const addTag = accepted ? `${scopeTag}:done` : `${scopeTag}:needs-review`;
      const removeTags = [`${scopeTag}:todo`, `${scopeTag}:wip`, `${scopeTag}:ready`, `${scopeTag}:triage`];
      if (accepted) removeTags.push(`${scopeTag}:needs-review`);
      tagItemInTx(conn, id, addTag, now);
      for (const tagName of removeTags) untagItemInTx(conn, id, tagName);
    } else {
      tagItemInTx(conn, id, "done", now);
      untagItemInTx(conn, id, "todo");
    }

    const eventMeta = { ...(notes ? { notes } : {}), ...(accepted ? { accepted: true } : {}) };
    conn.run(
      `INSERT INTO item_events (id, itemId, content, value, occurredAt, metadata, createdAt)
       VALUES (?, ?, 'completed', 0, ?, ?, ?)`,
      [crypto.randomUUID(), id, now, JSON.stringify(eventMeta), now]
    );

    conn.run("UPDATE items SET updatedAt = ? WHERE id = ?", [now, id]);
  });

  const row = fetchItemRowById(conn, id, scopeTag);
  const tagsById = fetchTagsForIds(conn, [id]);
  return { status: "ok", item: shapeItemRow(row, tagsById.get(id)) };
}

module.exports = {
  queryItems,
  searchItems,
  resolveItemId,
  getItemForRoute,
  listTags,
  createItem,
  updateItem,
  deleteItem,
  tagItem,
  untagItem,
  recordEvent,
  listEvents,
  deleteEvent,
  deleteEvents,
  completeTask,
};
