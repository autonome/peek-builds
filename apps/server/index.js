const { Hono } = require("hono");
const { serve } = require("@hono/node-server");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const users = require("./users");
const grants = require("./grants");
const mcpItems = require("./mcp-items");
const backup = require("./backup");
const { loadConfig, isSingleUserMode } = require("./config");
const { createAuthMiddleware, createMcpAuthMiddleware } = require("./auth");
const { DATASTORE_VERSION, PROTOCOL_VERSION } = require("./version");

// Every item type the server will accept and store. The client decides WHICH of
// these it actually syncs (e.g. mobile syncs only url/text/tagset/image), but the
// server stores whatever any client chooses to push so all data can live remotely.
// Must stay a subset of the `items.type` CHECK constraint in db.js.
const SYNCABLE_ITEM_TYPES = ["url", "text", "tagset", "image", "series", "feed", "entity"];

// Types whose payload lives in `content` and so require it on push. entity/series/feed
// carry their data in `metadata` and are allowed to have null content.
const CONTENT_REQUIRED_TYPES = ["url", "text"];

// Resolve a pull/read type filter from the query string. `types` (comma-separated)
// takes precedence over the legacy single `type`. Returns either an array of types,
// a single type string, or null (no filter). Returns {error} if any type is unknown
// so a client can't silently get an unfiltered response from a typo. This is what lets
// a client fetch only the types it syncs (mobile: url/text/tagset/image) instead of
// downloading the whole store and discarding the rest.
function resolveTypeFilter(c) {
  const typesParam = c.req.query("types");
  if (typesParam) {
    const types = typesParam.split(",").map((t) => t.trim()).filter(Boolean);
    const bad = types.find((t) => !SYNCABLE_ITEM_TYPES.includes(t));
    if (bad) return { error: bad };
    return { filter: types.length > 0 ? types : null };
  }
  const type = c.req.query("type");
  if (type && !SYNCABLE_ITEM_TYPES.includes(type)) return { error: type };
  return { filter: type || null };
}

// Load configuration
const config = loadConfig();

const app = new Hono();

// Version headers middleware - add version info to all responses
app.use("*", async (c, next) => {
  await next();
  c.header("X-Peek-Datastore-Version", String(DATASTORE_VERSION));
  c.header("X-Peek-Protocol-Version", String(PROTOCOL_VERSION));
});

// Auth middleware - uses factory based on config
app.use("*", createAuthMiddleware(config));

// /mcp/* authenticates with a grant credential, never a device/user one — see
// createMcpAuthMiddleware() and the /mcp path skip inside createAuthMiddleware().
app.use("/mcp/*", createMcpAuthMiddleware());

// GET /mcp/whoami — trivial authenticated probe confirming what the grant
// middleware resolved.
app.get("/mcp/whoami", (c) => {
  return c.json({
    userId: c.get("userId"),
    scopeTag: c.get("scopeTag"),
    readonly: c.get("readonly"),
    profileId: c.get("profileId"),
  });
});

// === MCP item read routes (design doc §3.3) ===
//
// scopeTag/readonly/userId/profileId come ONLY from the grant context the
// /mcp/* auth middleware set (createMcpAuthMiddleware in auth.js) — never
// from a query parameter or header. See design doc §4.2 for why: the scope
// is minted into the credential precisely so a caller sending raw requests
// (bypassing whatever a client would have filtered) can't widen it.
//
// Business logic lives in mcp-items.js; these handlers only parse the
// request and translate the result into a status code.

// Parse an optional numeric query param, returning undefined (so the
// callee's own default applies) rather than NaN for missing/invalid input.
function parseOptionalNumber(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function parseTagsParam(raw) {
  if (!raw) return undefined;
  const list = raw.split(",").map((t) => t.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

// GET /mcp/items — server-side port of db.js queryItems() (list_items).
app.get("/mcp/items", (c) => {
  const items = mcpItems.queryItems(c.get("userId"), c.get("profileId"), c.get("scopeTag"), {
    tags: parseTagsParam(c.req.query("tags")),
    type: c.req.query("type") || undefined,
    limit: parseOptionalNumber(c.req.query("limit")),
    offset: parseOptionalNumber(c.req.query("offset")),
    sort: c.req.query("sort") || undefined,
  });
  return c.json({ items });
});

// GET /mcp/items/search — server-side port of db.js searchItems()
// (search_items). Registered ahead of /mcp/items/:idOrPrefix so the literal
// path always wins over the param route.
app.get("/mcp/items/search", (c) => {
  const items = mcpItems.searchItems(c.get("userId"), c.get("profileId"), c.get("scopeTag"), {
    query: c.req.query("q") || "",
    tags: parseTagsParam(c.req.query("tags")),
    type: c.req.query("type") || undefined,
    limit: parseOptionalNumber(c.req.query("limit")),
    offset: parseOptionalNumber(c.req.query("offset")),
  });
  return c.json({ items });
});

// GET /mcp/items/resolve — standalone prefix resolver (design doc §5),
// returning the ResolveResult shape byte-identically to resolveItemId() in
// sqlite-store.js. Registered ahead of /mcp/items/:idOrPrefix, same reason
// as /mcp/items/search above.
app.get("/mcp/items/resolve", (c) => {
  const result = mcpItems.resolveItemId(
    c.get("userId"),
    c.get("profileId"),
    c.get("scopeTag"),
    c.req.query("prefix") || ""
  );
  return c.json(result);
});

// GET /mcp/items/:idOrPrefix — resolves a prefix inline (design doc §5) and
// returns the item (200), a miss (404), or the ambiguity payload (409).
// Supports the maxContentLength/contentOffset content window and the
// events param backing get_task_context.
app.get("/mcp/items/:idOrPrefix", (c) => {
  const result = mcpItems.getItemForRoute(
    c.get("userId"),
    c.get("profileId"),
    c.get("scopeTag"),
    c.req.param("idOrPrefix"),
    {
      maxContentLength: parseOptionalNumber(c.req.query("maxContentLength")),
      contentOffset: parseOptionalNumber(c.req.query("contentOffset")),
      events: parseOptionalNumber(c.req.query("events")),
    }
  );

  if (result.status === "ambiguous") {
    return c.json({ id: null, ambiguous: true, candidates: result.candidates, truncated: result.truncated }, 409);
  }
  if (result.status === "not_found") {
    return c.json({ error: "item not found" }, 404);
  }
  return c.json({ item: result.item });
});

// GET /mcp/session — what the SERVER understands about this grant. Backs
// PeekStore.describe() and the startup consistency check (design doc §4.3).
app.get("/mcp/session", (c) => {
  return c.json({
    scopeTag: c.get("scopeTag"),
    readonly: c.get("readonly"),
    profileId: c.get("profileId"),
    datastoreVersion: DATASTORE_VERSION,
    userId: c.get("userId"),
  });
});

// GET /mcp/tags — server-side port of db.js listTags() (list_tags).
app.get("/mcp/tags", (c) => {
  const tags = mcpItems.listTags(c.get("userId"), c.get("profileId"), c.get("scopeTag"), {
    search: c.req.query("search") || undefined,
    limit: parseOptionalNumber(c.req.query("limit")),
  });
  return c.json({ tags });
});

// === MCP item/task write routes (design doc §3.3, the remaining eight) ===
//
// Every one of these is a mutating route: refused with 403 for a readonly
// grant, checked FIRST (before parsing the body) and read only from
// `c.get('readonly')` — the grant, never anything the client sends (design
// doc §4.1/§4.2). Scope confinement and the foreign-namespace tag rule live
// in mcp-items.js; these handlers stay thin translation over its {status,…}
// results.
function readonlyRefused(c) {
  return c.get("readonly") ? c.json({ error: "This grant is read-only; mutating routes are refused." }, 403) : null;
}

// POST /mcp/items — server-side port of db.js createItem() (create_item).
// No prefix resolution and no syncId matching (design doc §3.3): an
// explicit create is always a create.
app.post("/mcp/items", async (c) => {
  const refused = readonlyRefused(c);
  if (refused) return refused;
  const body = await c.req.json().catch(() => ({}));
  const result = mcpItems.createItem(c.get("userId"), c.get("profileId"), c.get("scopeTag"), body);
  if (result.status === "invalid") return c.json({ error: result.error }, 400);
  return c.json({ item: result.item });
});

// PATCH /mcp/items/:id — server-side port of db.js updateItem() (update_item).
// Operates on a full id the client already resolved (design doc §5).
app.patch("/mcp/items/:id", async (c) => {
  const refused = readonlyRefused(c);
  if (refused) return refused;
  const body = await c.req.json().catch(() => ({}));
  const result = mcpItems.updateItem(c.get("userId"), c.get("profileId"), c.get("scopeTag"), c.req.param("id"), body);
  if (result.status === "not_found") return c.json({ error: "item not found" }, 404);
  return c.json({ item: result.item });
});

// DELETE /mcp/items/:id — server-side port of db.js deleteItem() (delete_item).
app.delete("/mcp/items/:id", (c) => {
  const refused = readonlyRefused(c);
  if (refused) return refused;
  const result = mcpItems.deleteItem(c.get("userId"), c.get("profileId"), c.get("scopeTag"), c.req.param("id"));
  if (result.status === "not_found") return c.json({ error: "item not found" }, 404);
  return c.json(result.result);
});

// POST /mcp/items/:id/tags — server-side port of db.js tagItemInTx() (tag_item).
app.post("/mcp/items/:id/tags", async (c) => {
  const refused = readonlyRefused(c);
  if (refused) return refused;
  const body = await c.req.json().catch(() => ({}));
  const result = mcpItems.tagItem(c.get("userId"), c.get("profileId"), c.get("scopeTag"), c.req.param("id"), body.name);
  if (result.status === "not_found") return c.json({ error: "item not found" }, 404);
  if (result.status === "invalid") return c.json({ error: result.error }, 400);
  return c.json(result.result);
});

// DELETE /mcp/items/:id/tags/:name — server-side port of db.js untagItem()
// (untag_item), including the orphan refusal (design doc §4.1's last bullet).
app.delete("/mcp/items/:id/tags/:name", (c) => {
  const refused = readonlyRefused(c);
  if (refused) return refused;
  const result = mcpItems.untagItem(c.get("userId"), c.get("profileId"), c.get("scopeTag"), c.req.param("id"), c.req.param("name"));
  if (result.status === "not_found") return c.json({ error: "item not found" }, 404);
  if (result.status === "orphan") return c.json({ error: result.error }, 400);
  return c.json(result.result);
});

// POST /mcp/items/:id/events — server-side port of db.js recordEvent()
// (record_event).
app.post("/mcp/items/:id/events", async (c) => {
  const refused = readonlyRefused(c);
  if (refused) return refused;
  const body = await c.req.json().catch(() => ({}));
  const result = mcpItems.recordEvent(
    c.get("userId"), c.get("profileId"), c.get("scopeTag"), c.req.param("id"), body.type, body.value
  );
  if (result.status === "not_found") return c.json({ error: "item not found" }, 404);
  if (result.status === "invalid") return c.json({ error: result.error }, 400);
  return c.json(result.result);
});

// POST /mcp/tasks/:id/complete — server-side port of db.js completeTask()
// (complete_task). One transaction: adds `done`, removes `todo`, records the
// completion event, or none of the three (design doc §3.3/§4.1).
app.post("/mcp/tasks/:id/complete", async (c) => {
  const refused = readonlyRefused(c);
  if (refused) return refused;
  const body = await c.req.json().catch(() => ({}));
  const result = mcpItems.completeTask(c.get("userId"), c.get("profileId"), c.get("scopeTag"), c.req.param("id"), body.notes);
  if (result.status === "not_found") return c.json({ error: "item not found" }, 404);
  return c.json({ item: result.item });
});

// Version check middleware for sync endpoints
// Rejects requests with mismatched version headers (HTTP 409)
// Allows requests with no version headers (backward compat during rollout)
app.use("/items/*", async (c, next) => {
  return checkVersionHeaders(c, next);
});
app.use("/items", async (c, next) => {
  return checkVersionHeaders(c, next);
});

function checkVersionHeaders(c, next) {
  const clientDS = c.req.header("X-Peek-Datastore-Version");
  const clientProto = c.req.header("X-Peek-Protocol-Version");

  // If client sends no version headers, allow (backward compat)
  if (!clientDS && !clientProto) {
    return next();
  }

  const clientDSNum = parseInt(clientDS, 10) || 0;
  const clientProtoNum = parseInt(clientProto, 10) || 0;

  // Check datastore version mismatch
  if (clientDSNum > 0 && clientDSNum !== DATASTORE_VERSION) {
    return c.json({
      error: "Version mismatch",
      message: `Datastore version mismatch: client=${clientDSNum}, server=${DATASTORE_VERSION}. Please update your app.`,
      type: "datastore_version_mismatch",
      client_version: clientDSNum,
      server_version: DATASTORE_VERSION,
    }, 409);
  }

  // Check protocol version mismatch
  if (clientProtoNum > 0 && clientProtoNum !== PROTOCOL_VERSION) {
    return c.json({
      error: "Version mismatch",
      message: `Protocol version mismatch: client=${clientProtoNum}, server=${PROTOCOL_VERSION}. Please update your app.`,
      type: "protocol_version_mismatch",
      client_version: clientProtoNum,
      server_version: PROTOCOL_VERSION,
    }, 409);
  }

  return next();
}

app.get("/", (c) => {
  return c.json({
    status: "ok",
    message: "Webhook server running",
    datastore_version: DATASTORE_VERSION,
    protocol_version: PROTOCOL_VERSION,
  });
});

// Receive items from iOS app
app.post("/webhook", async (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const body = await c.req.json();

  console.log("=== Webhook Received ===");
  console.log("User:", userId);
  console.log("Profile:", profileId);
  console.log("Timestamp:", new Date().toISOString());
  console.log("URLs:", body.urls?.length || 0);
  console.log("Texts:", body.texts?.length || 0);
  console.log("Tagsets:", body.tagsets?.length || 0);

  const saved = [];

  // Save URLs
  if (body.urls && Array.isArray(body.urls)) {
    for (const item of body.urls) {
      if (item.url) {
        const id = db.saveUrl(userId, item.url, item.tags || [], item.metadata || null, profileId);
        saved.push({ id, type: "url", url: item.url });
        console.log(`Saved URL: ${item.url}`);
      }
    }
  }

  // Save texts
  if (body.texts && Array.isArray(body.texts)) {
    for (const item of body.texts) {
      if (item.content) {
        const id = db.saveText(userId, item.content, item.tags || [], item.metadata || null, profileId);
        saved.push({ id, type: "text" });
        console.log(`Saved text: ${item.content.substring(0, 50)}...`);
      }
    }
  }

  // Save tagsets
  if (body.tagsets && Array.isArray(body.tagsets)) {
    for (const item of body.tagsets) {
      if (item.tags && item.tags.length > 0) {
        const id = db.saveTagset(userId, item.tags, item.metadata || null, profileId);
        saved.push({ id, type: "tagset" });
        console.log(`Saved tagset: ${item.tags.join(", ")}`);
      }
    }
  }

  console.log("========================");

  return c.json({ received: true, saved_count: saved.length });
});

// Get all saved URLs
app.get("/urls", (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const urls = db.getSavedUrls(userId, profileId);
  return c.json({ urls });
});

// Get tags sorted by frecency
app.get("/tags", (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const tags = db.getTagsByFrecency(userId, profileId);
  return c.json({ tags });
});

// Delete a URL
app.delete("/urls/:id", (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const id = c.req.param("id");
  db.deleteUrl(userId, id, profileId);
  return c.json({ deleted: true });
});

// Update tags for a URL
app.patch("/urls/:id/tags", async (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const id = c.req.param("id");
  const body = await c.req.json();
  db.updateUrlTags(userId, id, body.tags || [], profileId);
  return c.json({ updated: true });
});

// === Texts endpoints ===

app.post("/texts", async (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const body = await c.req.json();
  if (!body.content) {
    return c.json({ error: "content is required" }, 400);
  }
  const id = db.saveText(userId, body.content, body.tags || [], body.metadata || null, profileId);
  return c.json({ id, created: true });
});

app.get("/texts", (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const texts = db.getTexts(userId, profileId);
  return c.json({ texts });
});

app.delete("/texts/:id", (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const id = c.req.param("id");
  db.deleteItem(userId, id, profileId);
  return c.json({ deleted: true });
});

app.patch("/texts/:id/tags", async (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const id = c.req.param("id");
  const body = await c.req.json();
  db.updateItemTags(userId, id, body.tags || [], profileId);
  return c.json({ updated: true });
});

// === Tagsets endpoints ===

app.post("/tagsets", async (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const body = await c.req.json();
  if (!body.tags || !Array.isArray(body.tags) || body.tags.length === 0) {
    return c.json({ error: "tags array is required and must not be empty" }, 400);
  }
  const id = db.saveTagset(userId, body.tags, body.metadata || null, profileId);
  return c.json({ id, created: true });
});

app.get("/tagsets", (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const tagsets = db.getTagsets(userId, profileId);
  return c.json({ tagsets });
});

app.delete("/tagsets/:id", (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const id = c.req.param("id");
  db.deleteItem(userId, id, profileId);
  return c.json({ deleted: true });
});

app.patch("/tagsets/:id/tags", async (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const id = c.req.param("id");
  const body = await c.req.json();
  db.updateItemTags(userId, id, body.tags || [], profileId);
  return c.json({ updated: true });
});

// === Images endpoints ===

app.post("/images", async (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const contentType = c.req.header("Content-Type") || "";

  let filename, buffer, mimeType, tags = [];

  if (contentType.includes("multipart/form-data")) {
    // Handle multipart upload
    const formData = await c.req.formData();
    const file = formData.get("file");
    const tagsField = formData.get("tags");

    if (!file || !(file instanceof File)) {
      return c.json({ error: "file is required" }, 400);
    }

    filename = file.name;
    mimeType = file.type;
    buffer = Buffer.from(await file.arrayBuffer());

    if (tagsField) {
      try {
        tags = JSON.parse(tagsField);
      } catch {
        tags = [];
      }
    }
  } else {
    // Handle JSON with base64 content
    const body = await c.req.json();
    if (!body.content) {
      return c.json({ error: "content (base64 image data) is required" }, 400);
    }
    if (!body.filename) {
      return c.json({ error: "filename is required" }, 400);
    }
    if (!body.mime) {
      return c.json({ error: "mime type is required" }, 400);
    }

    filename = body.filename;
    mimeType = body.mime;
    buffer = Buffer.from(body.content, "base64");
    tags = body.tags || [];
  }

  if (!mimeType.startsWith("image/")) {
    return c.json({ error: "file must be an image" }, 400);
  }

  if (buffer.length > db.MAX_IMAGE_SIZE) {
    return c.json({ error: `image exceeds maximum size of ${db.MAX_IMAGE_SIZE / 1024 / 1024} MB` }, 400);
  }

  try {
    const id = db.saveImage(userId, filename, buffer, mimeType, tags, profileId);
    return c.json({ id, type: "image", created: true });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

app.get("/images", (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const images = db.getImages(userId, profileId);
  return c.json({ images });
});

app.get("/images/:id", (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const id = c.req.param("id");

  const imageData = db.getImageData(userId, id, profileId);
  if (!imageData) {
    return c.json({ error: "image not found" }, 404);
  }

  return new Response(imageData.buffer, {
    headers: {
      "Content-Type": imageData.metadata.mime,
      "Content-Length": imageData.buffer.length.toString(),
      "Content-Disposition": `inline; filename="${imageData.filename}"`,
    },
  });
});

app.delete("/images/:id", (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const id = c.req.param("id");
  db.deleteImage(userId, id, profileId);
  return c.json({ deleted: true });
});

app.patch("/images/:id/tags", async (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const id = c.req.param("id");
  const body = await c.req.json();
  db.updateItemTags(userId, id, body.tags || [], profileId);
  return c.json({ updated: true });
});

// === Unified items endpoints ===

app.post("/items", async (c) => {
  const userId = c.get("userId");
  const deviceId = c.get("deviceId") || "";
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const body = await c.req.json();
  const {
    type, content, tags = [], metadata = null, sync_id = null, syncId = null,
    deletedAt = null, deleted_at = null, starred = null, archived = null,
  } = body;
  const effectiveSyncId = syncId || sync_id; // Support both camelCase and snake_case during transition
  const effectiveDeletedAt = deletedAt || deleted_at; // Support both camelCase and snake_case during transition

  if (effectiveDeletedAt) console.log(`[sync] Received tombstone push: syncId=${effectiveSyncId} deletedAt=${effectiveDeletedAt}`);

  // Sync logging for e2e test verification
  console.log("=== Sync Item Received ===");
  console.log("User:", userId);
  console.log("Profile:", profileId);
  console.log("Timestamp:", new Date().toISOString());
  console.log("Type:", type);
  console.log("syncId:", effectiveSyncId || "(none)");
  console.log("Content preview:", content?.substring(0, 100) || "(null)");
  console.log("Tags:", tags.join(", ") || "(none)");
  console.log("==========================");

  if (!type || !SYNCABLE_ITEM_TYPES.includes(type)) {
    return c.json({ error: `type must be one of: ${SYNCABLE_ITEM_TYPES.join(", ")}` }, 400);
  }

  if (CONTENT_REQUIRED_TYPES.includes(type) && !content) {
    return c.json({ error: `content is required for type '${type}'` }, 400);
  }

  if (type === "tagset" && (!tags || tags.length === 0)) {
    return c.json({ error: "tags are required for type 'tagset'" }, 400);
  }

  if (type === "image") {
    // For images via unified endpoint, require base64 content
    if (!content) {
      return c.json({ error: "content (base64 image data) is required for type 'image'" }, 400);
    }
    if (!body.filename) {
      return c.json({ error: "filename is required for type 'image'" }, 400);
    }
    if (!body.mime) {
      return c.json({ error: "mime type is required for type 'image'" }, 400);
    }

    const buffer = Buffer.from(content, "base64");
    if (buffer.length > db.MAX_IMAGE_SIZE) {
      return c.json({ error: `image exceeds maximum size of ${db.MAX_IMAGE_SIZE / 1024 / 1024} MB` }, 400);
    }

    try {
      const id = db.saveImage(userId, body.filename, buffer, body.mime, tags, profileId, deviceId);
      return c.json({ id, type, created: true });
    } catch (e) {
      return c.json({ error: e.message }, 400);
    }
  }

  const id = db.saveItem(
    userId, type, content || null, tags, metadata, effectiveSyncId, profileId, effectiveDeletedAt, deviceId,
    null, null, null, starred, archived
  );
  return c.json({ id, type, created: true });
});

app.get("/items", (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const includeDeleted = c.req.query("includeDeleted") === "true";
  const typeFilter = resolveTypeFilter(c);
  if (typeFilter.error) {
    return c.json({ error: `type must be one of: ${SYNCABLE_ITEM_TYPES.join(", ")}` }, 400);
  }
  const items = db.getItems(userId, typeFilter.filter, profileId, includeDeleted);
  return c.json({ items });
});

app.delete("/items/:id", (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const id = c.req.param("id");
  db.deleteItem(userId, id, profileId);
  return c.json({ deleted: true });
});

app.patch("/items/:id/tags", async (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const id = c.req.param("id");
  const body = await c.req.json();
  db.updateItemTags(userId, id, body.tags || [], profileId);
  return c.json({ updated: true });
});

// === Sync endpoints ===

// Get items modified since a timestamp (for incremental sync)
app.get("/items/since/:timestamp", (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const rawTimestamp = c.req.param("timestamp");

  // Accept ISO 8601 string or Unix ms integer, convert to Unix ms for DB query
  let unixMs;
  if (/^\d+$/.test(rawTimestamp)) {
    unixMs = parseInt(rawTimestamp, 10);
  } else {
    const date = new Date(rawTimestamp);
    if (isNaN(date.getTime())) {
      return c.json({ error: "Invalid timestamp format. Use ISO 8601 or Unix ms." }, 400);
    }
    unixMs = date.getTime();
  }

  const typeFilter = resolveTypeFilter(c);
  if (typeFilter.error) {
    return c.json({ error: `type must be one of: ${SYNCABLE_ITEM_TYPES.join(", ")}` }, 400);
  }

  const items = db.getItemsSince(userId, unixMs, typeFilter.filter, profileId);
  return c.json({ items, since: rawTimestamp });
});

// Get a single item by ID
app.get("/items/:id", (c) => {
  const userId = c.get("userId");
  const profileId = users.resolveProfileId(userId, c.req.query("profile") || "default");
  const id = c.req.param("id");

  const item = db.getItemById(userId, id, profileId);
  if (!item) {
    return c.json({ error: "item not found" }, 404);
  }

  return c.json({ item });
});

// === Backup endpoints ===

// GET /backups - List backups for authenticated user
app.get("/backups", (c) => {
  const userId = c.get("userId");
  const backups = backup.listBackups(userId);
  return c.json({ backups });
});

// POST /backups - Trigger manual backup for authenticated user
app.post("/backups", async (c) => {
  const userId = c.get("userId");
  const result = await backup.createBackup(userId);
  return c.json(result);
});

// === Profile endpoints ===

// GET /profiles - List profiles for authenticated user
app.get("/profiles", (c) => {
  const userId = c.get("userId");
  const profiles = users.listProfiles(userId);
  return c.json({ profiles });
});

// POST /profiles - Create a new profile for authenticated user
app.post("/profiles", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();

  if (!body.name) {
    return c.json({ error: "name is required" }, 400);
  }

  try {
    const profile = users.createProfile(userId, body.name);
    return c.json({ profile, created: true });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

// GET /profiles/:id - Get a specific profile by UUID
app.get("/profiles/:id", (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const profile = users.getProfileById(userId, id);
  if (!profile) {
    return c.json({ error: "profile not found" }, 404);
  }

  return c.json({ profile });
});

// DELETE /profiles/:profileId - Delete a profile
app.delete("/profiles/:profileId", (c) => {
  const userId = c.get("userId");
  const profileId = c.req.param("profileId");

  try {
    users.deleteProfile(userId, profileId);
    return c.json({ deleted: true });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

// === Admin endpoints (per-device credential management) ===
//
// Gated by the ADMIN_TOKEN env var, independent of user/device api keys. When
// ADMIN_TOKEN is unset the entire /admin surface is disabled (503) so a default
// deploy never exposes an open admin API. Auth is a constant-time compare.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

function adminTokenMatches(provided) {
  if (!ADMIN_TOKEN || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

app.use("/admin/*", async (c, next) => {
  if (!ADMIN_TOKEN) {
    return c.json({ error: "Admin API disabled (ADMIN_TOKEN not set)" }, 503);
  }
  const auth = c.req.header("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!adminTokenMatches(token)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
});

// POST /admin/devices  { userId, label }  -> mint a new device key.
// The raw apiKey is returned ONCE in this response and is never recoverable.
app.post("/admin/devices", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { userId, label } = body;
  if (!userId || !label) {
    return c.json({ error: "userId and label are required" }, 400);
  }
  try {
    const device = users.createDevice(userId, label);
    return c.json({ device });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

// GET /admin/devices?userId=...  -> list a user's devices (no key material).
app.get("/admin/devices", (c) => {
  const userId = c.req.query("userId");
  if (!userId) {
    return c.json({ error: "userId query param is required" }, 400);
  }
  return c.json({ devices: users.listDevices(userId) });
});

// DELETE /admin/devices/:deviceId?userId=...  -> revoke a device individually.
app.delete("/admin/devices/:deviceId", (c) => {
  const userId = c.req.query("userId");
  const deviceId = c.req.param("deviceId");
  if (!userId) {
    return c.json({ error: "userId query param is required" }, 400);
  }
  try {
    const revoked = users.revokeDevice(userId, deviceId);
    return c.json({ revoked });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

// === Admin endpoints (MCP grant management) ===
//
// Same ADMIN_TOKEN gate as /admin/devices above. A grant is a distinct
// credential namespace from a device (see grants.js) — minting one here is
// the only way to hand out a scoped/readonly /mcp/* key.

// POST /admin/mcp-grants  { userId, label, scopeTag, readonly, profileId }
// -> mint a new grant key. The raw apiKey is returned ONCE and is never
// recoverable. scopeTag may be '' for an unscoped (whole-store) grant — see
// design doc §4.4; that is a deliberate, hand-minted escape hatch, not what
// the scaffolder writes by default.
app.post("/admin/mcp-grants", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { userId, label, scopeTag, readonly, profileId } = body;
  if (!userId || !label || typeof scopeTag !== "string" || !profileId) {
    return c.json({ error: "userId, label, scopeTag, and profileId are required" }, 400);
  }
  try {
    const grant = grants.createGrant(userId, label, scopeTag, !!readonly, profileId);
    return c.json({ grant });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

// GET /admin/mcp-grants?userId=...  -> list a user's grants (no key material).
app.get("/admin/mcp-grants", (c) => {
  const userId = c.req.query("userId");
  if (!userId) {
    return c.json({ error: "userId query param is required" }, 400);
  }
  return c.json({ grants: grants.listGrants(userId) });
});

// DELETE /admin/mcp-grants/:grantId?userId=...  -> revoke a grant individually.
app.delete("/admin/mcp-grants/:grantId", (c) => {
  const userId = c.req.query("userId");
  const grantId = c.req.param("grantId");
  if (!userId) {
    return c.json({ error: "userId query param is required" }, 400);
  }
  try {
    const revoked = grants.revokeGrant(userId, grantId);
    return c.json({ revoked });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

const port = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || "./data";

// Migrate legacy API_KEY env var to multi-user system
function migrateFromLegacyApiKey() {
  const legacyKey = process.env.API_KEY;
  if (!legacyKey) return;

  const existingUsers = users.listUsers();
  if (existingUsers.length > 0) return;

  try {
    users.createUserWithKey("default", legacyKey);
    console.log("Migrated legacy API_KEY to user 'default'");
  } catch (e) {
    console.log("Legacy migration skipped:", e.message);
  }
}

// Migrate existing user data to profiles structure
function migrateUserDataToProfiles() {
  // DRY RUN MODE: Set MIGRATION_DRY_RUN=true to test without moving data
  const DRY_RUN = process.env.MIGRATION_DRY_RUN === 'true';

  if (DRY_RUN) {
    console.log('[migration] ========================================');
    console.log('[migration] DRY RUN MODE - No data will be moved');
    console.log('[migration] ========================================');
  }

  if (!fs.existsSync(DATA_DIR)) {
    return; // No data directory, nothing to migrate
  }

  const userDirs = fs.readdirSync(DATA_DIR, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory() && dirent.name !== 'system.db')
    .map(dirent => dirent.name);

  let migratedCount = 0;
  let skippedCount = 0;
  let dryRunCount = 0;

  for (const userId of userDirs) {
    const oldDbPath = path.join(DATA_DIR, userId, "peek.db");
    const newDbPath = path.join(DATA_DIR, userId, "profiles", "default", "datastore.sqlite");
    const backupPath = `${oldDbPath}.pre-migration-backup`;

    // Skip if old DB doesn't exist or new DB already exists
    if (!fs.existsSync(oldDbPath)) {
      continue;
    }

    if (fs.existsSync(newDbPath)) {
      skippedCount++;
      continue;
    }

    // DRY RUN: Just report what would be migrated
    if (DRY_RUN) {
      console.log(`[migration] [DRY RUN] Would migrate ${userId}:`);
      console.log(`[migration]   From: ${oldDbPath}`);
      console.log(`[migration]   To:   ${newDbPath}`);

      const oldImagesDir = path.join(DATA_DIR, userId, "images");
      if (fs.existsSync(oldImagesDir)) {
        const newImagesDir = path.join(DATA_DIR, userId, "profiles", "default", "images");
        console.log(`[migration]   Images: ${oldImagesDir} -> ${newImagesDir}`);
      }

      dryRunCount++;
      continue;
    }

    try {
      // SAFETY: Create pre-migration backup
      if (!fs.existsSync(backupPath)) {
        console.log(`[migration] Creating pre-migration backup for ${userId}`);
        fs.copyFileSync(oldDbPath, backupPath);
        console.log(`[migration] Backup created: ${backupPath}`);
      }

      // Create profile directory
      const profileDir = path.dirname(newDbPath);
      if (!fs.existsSync(profileDir)) {
        fs.mkdirSync(profileDir, { recursive: true });
      }

      // Move database file
      fs.renameSync(oldDbPath, newDbPath);
      console.log(`[migration] Migrated ${userId} data to profiles/default/datastore.sqlite`);

      // Verify the move succeeded
      if (!fs.existsSync(newDbPath)) {
        throw new Error('Migration verification failed: new DB not found after move');
      }

      // Create profile record
      const existingProfile = users.getProfile(userId, "default");
      if (!existingProfile) {
        users.createProfile(userId, "Default");
        console.log(`[migration] Created default profile for user ${userId}`);
      }

      // Move images directory if it exists
      const oldImagesDir = path.join(DATA_DIR, userId, "images");
      const newImagesDir = path.join(DATA_DIR, userId, "profiles", "default", "images");
      if (fs.existsSync(oldImagesDir) && !fs.existsSync(newImagesDir)) {
        // Backup images directory too
        const imagesBackupDir = `${oldImagesDir}.pre-migration-backup`;
        if (!fs.existsSync(imagesBackupDir)) {
          console.log(`[migration] Backing up images directory for ${userId}`);
          // Copy entire directory recursively
          fs.cpSync(oldImagesDir, imagesBackupDir, { recursive: true });
        }

        fs.renameSync(oldImagesDir, newImagesDir);
        console.log(`[migration] Migrated ${userId} images to profiles/default/images`);
      }

      console.log(`[migration] ✓ Migration successful for ${userId}`);
      console.log(`[migration] Backup available at: ${backupPath}`);
      console.log(`[migration] (Backup can be manually deleted after verifying data integrity)`);

      migratedCount++;
    } catch (error) {
      console.error(`[migration] ✗ Failed to migrate ${userId}:`, error.message);

      // SAFETY: Attempt rollback if backup exists
      if (fs.existsSync(backupPath) && !fs.existsSync(oldDbPath)) {
        console.error(`[migration] Attempting rollback for ${userId}...`);
        try {
          fs.copyFileSync(backupPath, oldDbPath);
          console.log(`[migration] ✓ Rollback successful for ${userId}`);
        } catch (rollbackError) {
          console.error(`[migration] ✗ CRITICAL: Rollback failed for ${userId}:`, rollbackError.message);
          console.error(`[migration] Manual recovery required. Backup at: ${backupPath}`);
        }
      }
    }
  }

  if (DRY_RUN) {
    console.log('[migration] ========================================');
    console.log(`[migration] DRY RUN COMPLETE: ${dryRunCount} user(s) would be migrated`);
    console.log(`[migration] ${skippedCount} user(s) already migrated`);
    console.log('[migration] ========================================');
  } else if (migratedCount > 0) {
    console.log(`[migration] Migration complete: ${migratedCount} user(s) migrated, ${skippedCount} already migrated`);
  } else if (skippedCount > 0) {
    console.log(`[migration] All users already migrated (${skippedCount} found)`);
  }
}

// One-time deduplication of all users' items
function deduplicateAllUsers() {
  const allUsers = users.listUsers();
  for (const user of allUsers) {
    const profiles = users.listProfiles(user.id);
    for (const profile of profiles) {
      const flag = db.getSetting(user.id, "dedup_cleanup_v1", profile.id);
      if (flag) continue;

      console.log(`[dedup] Running dedup for user=${user.id} profile=${profile.id}`);
      try {
        db.deduplicateItems(user.id, profile.id);
        db.setSetting(user.id, "dedup_cleanup_v1", "1", profile.id);
        console.log(`[dedup] Completed for user=${user.id} profile=${profile.id}`);
      } catch (err) {
        console.error(`[dedup] Failed for user=${user.id} profile=${profile.id}:`, err.message);
      }
    }
  }
}

// Startup side effects (migrations, backups, and listening) only run when this file
// is executed directly (`node index.js` / `npm start`) — never on `require("./index")`,
// which lets tests import the real `app` (and hit the real routes) without binding a
// port or replaying migrations against whatever DATA_DIR the test happens to have set.
if (require.main === module) {
  // Multi-user mode: run migrations and user-based operations
  if (!isSingleUserMode(config)) {
    migrateFromLegacyApiKey();
    migrateUserDataToProfiles();
    users.migrateProfileFoldersToUuid();
    users.migrateLegacyKeysToDevices();
    deduplicateAllUsers();

    // Force backup of all users on every deploy/restart (before serving requests)
    backup.createAllBackups().then(() => {
      console.log("Pre-deploy backup complete");
    }).catch((err) => {
      console.error("Pre-deploy backup failed:", err);
    });

    // Set up hourly backup check (runs if >24h since last backup)
    setInterval(() => backup.checkAndRunDailyBackups(), 60 * 60 * 1000);
  } else {
    console.log("[config] Running in single-user mode");
    console.log(`[config] User ID: ${config.singleUser.userId}`);
    console.log(`[config] Token auth: ${config.singleUser.token ? "enabled" : "disabled"}`);

    // Ensure single-user mode user exists in the database
    try {
      const existingUsers = users.listUsers();
      const userExists = existingUsers.some(u => u.id === config.singleUser.userId);
      if (!userExists) {
        console.log(`[config] Creating user '${config.singleUser.userId}' for single-user mode`);
        users.createUser(config.singleUser.userId);
      }
    } catch (e) {
      console.error("[config] Error ensuring single-user mode user exists:", e.message);
    }
  }

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`Server running on http://localhost:${info.port}`);
  });
}

module.exports = { app };
