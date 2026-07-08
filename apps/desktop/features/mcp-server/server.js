#!/usr/bin/env node

/**
 * Peek MCP Server — exposes Peek's datastore via Model Context Protocol.
 *
 * Transport: stdio (JSON-RPC 2.0, newline-delimited JSON)
 * Spawned by Claude Code as a subprocess.
 *
 * Environment:
 *   PEEK_DB_PATH — path to Peek's datastore.sqlite
 *     If unset, defaults to the platform default-profile location
 *     (macOS: ~/Library/Application Support/Peek/default/datastore.sqlite).
 *   PEEK_MCP_READONLY=1 — hides mutating tools (create/update/delete/tag/etc.)
 *   PEEK_MCP_SCOPE_TAG — confines this session to items tagged <scope> or
 *     matching <scope>:*. Reads filter to in-scope only; writes are force-
 *     tagged and reject foreign namespaces. Untagged items are invisible.
 */

import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, queryItems, searchItems, getItem, createItem, updateItem, deleteItem,
         listTags, tagItem, untagItem, recordEvent, listTasks, completeTask,
         getTaskContext, getItemTags, resolveItemId } from './db.js';

const SERVER_NAME = 'peek-mcp';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2024-11-05';

// Read-only mode hides the mutating tools and refuses tools/call for them.
// Toggled via the Settings UI by writing PEEK_MCP_READONLY=1 into the
// MCP client config's env.
const READONLY = process.env.PEEK_MCP_READONLY === '1';
const MUTATING_TOOLS = new Set([
  'create_item',
  'update_item',
  'delete_item',
  'tag_item',
  'untag_item',
  'complete_task',
  'record_event',
]);

// Scope tag — when set, every read filters to items tagged <SCOPE> or
// <SCOPE>:*, every write force-adds <SCOPE>, and any tag of the form
// <other>:* (where other != SCOPE) is rejected so an in-scope agent can't
// poison items into a sibling namespace. Empty string = no scope.
const SCOPE = (process.env.PEEK_MCP_SCOPE_TAG || '').trim();

function inScope(tags) {
  if (!SCOPE) return true;
  if (!tags || tags.length === 0) return false;
  const prefix = SCOPE + ':';
  return tags.some((t) => t === SCOPE || t.startsWith(prefix));
}

function tagIsScopeOwned(tag) {
  if (!SCOPE) return false;
  return tag === SCOPE || tag.startsWith(SCOPE + ':');
}

function tagIsForeignNamespace(tag) {
  if (!SCOPE) return false;
  if (tagIsScopeOwned(tag)) return false;
  // Foreign iff it has a colon — bare tags like "todo", "done", "note" are
  // shared vocabulary and allowed.
  return tag.includes(':');
}

function assertItemInScope(id) {
  if (!SCOPE) return;
  const tags = getItemTags(id);
  if (!inScope(tags)) {
    throw new Error(`Item ${id} is not in scope "${SCOPE}".`);
  }
}

function requireItemId(args) {
  const id = args.itemId;
  if (typeof id !== 'string' || id === '') {
    throw new Error('Missing required "itemId": a non-empty item id string.');
  }
  return id;
}

// --- Item-id prefix resolution (git-short-hash style) ---
//
// Callers may pass a full item id OR a leading PREFIX of one. A unique prefix
// resolves to its full id; an exact full-id match always wins (short-circuits
// before prefix logic). Ambiguity is NEVER silently resolved — it always hard-
// errors with the candidate ids + titles so the caller can disambiguate. This
// matters most for mutating tools: we must never mutate a guessed item.
//
// `resolveItemIdFromArgs` returns the resolved id, or null when the prefix
// matches nothing (read tools turn that into their existing null/not-found
// response). Ambiguity throws regardless of read-vs-write.
function formatAmbiguous(prefix, candidates, truncated) {
  const lines = candidates.map((c) => `  ${c.id}  ${c.title || '(untitled)'}`);
  let msg =
    `Ambiguous item id prefix "${prefix}" matches ${candidates.length}${truncated ? '+' : ''} items:\n` +
    lines.join('\n') +
    `\nPass more of the id (or the full id) to disambiguate.`;
  return msg;
}

function resolveItemIdFromArgs(args) {
  const raw = requireItemId(args);
  // Pass SCOPE down so resolution is confined to in-scope items: an exact id
  // or prefix matching only out-of-scope items reads as not-found, ambiguity
  // is computed over in-scope candidates only, and the candidate list never
  // leaks out-of-scope id/title. SCOPE='' (unscoped) = whole-table behavior.
  const res = resolveItemId(raw, { scopeTag: SCOPE });
  if (res.ambiguous) {
    throw new Error(formatAmbiguous(raw, res.candidates, res.truncated));
  }
  return res.id; // full id, or null when nothing matched
}

// For mutating tools: resolution must yield exactly one item. Not-found and
// ambiguity both hard-error (never mutate a guessed/missing item).
function resolveItemIdForMutation(args) {
  const raw = args.itemId;
  const id = resolveItemIdFromArgs(args);
  if (id === null) {
    throw new Error(`No item found with id (or id prefix) "${raw}".`);
  }
  return id;
}

function validateWriteTags(tags) {
  if (!SCOPE || !tags) return;
  for (const t of tags) {
    if (tagIsForeignNamespace(t)) {
      throw new Error(`Tag "${t}" is outside scope "${SCOPE}".`);
    }
  }
}

function withScopeTag(tags) {
  if (!SCOPE) return tags || [];
  const list = Array.isArray(tags) ? [...tags] : [];
  if (!list.includes(SCOPE)) list.push(SCOPE);
  return list;
}

// --- Item response shaping: content windowing + favicon strip ---
//
// `content` is one opaque nullable string and can be huge (page captures,
// long notes). get_item / get_task_context window it so a default call can't
// blow out the caller's context: the response carries the slice
// [contentOffset, contentOffset + maxContentLength), plus `contentLength`
// (full original length, whenever content is a string) and
// `contentTruncated: true` whenever any of it was cut. `favicon` (possibly a
// base64 data: URI) is stripped here at the MCP layer — db.js keeps selecting
// it for its other callers.

const DEFAULT_MAX_CONTENT_LENGTH = 4000;

function normalizeContentWindow(args) {
  let max = DEFAULT_MAX_CONTENT_LENGTH;
  const rawMax = args?.maxContentLength;
  if (typeof rawMax === 'number' && Number.isFinite(rawMax)) {
    if (rawMax === -1) max = Infinity; // -1 = unlimited
    else if (rawMax >= 0) max = Math.floor(rawMax);
    // other negatives fall back to the default
  }
  let offset = 0;
  const rawOffset = args?.contentOffset;
  if (typeof rawOffset === 'number' && Number.isFinite(rawOffset) && rawOffset > 0) {
    offset = Math.floor(rawOffset);
  }
  return { max, offset };
}

function shapeItemForResponse(item, args) {
  const out = { ...item };
  delete out.favicon;
  if (typeof out.content !== 'string') return out; // null content: nothing to window
  const { max, offset } = normalizeContentWindow(args);
  const fullLength = out.content.length;
  out.contentLength = fullLength;
  const end = max === Infinity ? fullLength : Math.min(fullLength, offset + max);
  if (offset > 0 || end < fullLength) {
    // Offset past the end yields '' (slice clamps), still flagged truncated.
    out.content = out.content.slice(offset, Math.max(offset, end));
    out.contentTruncated = true;
  }
  return out;
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: 'list_items',
    description: 'Query Peek items by tags, type, or other filters. Returns items with metadata and tags.',
    inputSchema: {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter items that have ALL listed tags' },
        type: { type: 'string', description: 'Filter by item type (url, text, tagset, image, series, feed, entity)' },
        limit: { type: 'number', description: 'Max results (default 50)' },
        offset: { type: 'number', description: 'Pagination offset' },
        sort: { type: 'string', enum: ['recent', 'frecency'], description: 'Sort order (default recent)' },
      },
    },
  },
  {
    name: 'search_items',
    description: 'Tokenized, ranked text search across Peek items. The query is split on whitespace into terms; ALL terms must appear (AND), but each term may match in ANY field — title, content, domain, or tags. So "mcp fix" matches an item whose title has "mcp" and whose content has "fix". Results are ranked by relevance (title > tag > domain > content; more distinct terms matched ranks higher; frecency as tiebreak) and each carries a `score` and a `snippet` (a short window of text around the first match). Optionally combine with a `tags` filter (text match restricted to items also carrying ALL listed tags) and/or a `type` filter. Wildcard characters (% _) in the query are matched literally.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search string. Split on whitespace into terms; every term must appear (AND), each matchable in title, content, domain, or a tag name.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Restrict text matches to items that ALSO have ALL listed tags' },
        type: { type: 'string', description: 'Filter by item type (url, text, tagset, image, series, feed, entity)' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        offset: { type: 'number', description: 'Pagination offset' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_item',
    description: 'Get a single Peek item by ID, with all metadata, tags, and details. Accepts a unique ID PREFIX (git-short-hash style): a leading segment that uniquely identifies one item resolves to it. An ambiguous prefix errors with the candidate ids. Long content is windowed: by default only the first 4000 characters of `content` are returned — the response carries `contentLength` (full length) and, when anything was cut, `contentTruncated: true`. Page through the rest with contentOffset, or pass maxContentLength: -1 for the whole thing.',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Item ID, or a unique leading prefix of one (e.g. "14efdd97").' },
        maxContentLength: { type: 'number', description: 'Max characters of content to return (default 4000). -1 for unlimited.' },
        contentOffset: { type: 'number', description: 'Character offset into content (default 0). Combine with maxContentLength to page through long items.' },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'create_item',
    description: 'Create a new item in Peek. For URLs, set type="url" and provide url. For text notes, set type="text" and provide content. Hashtags inside content (e.g. "#foo") are NOT auto-extracted as tags unless extractHashtags is true — pass tags explicitly in the tags array.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Item type: url, text, tagset, image, series, feed, entity' },
        url: { type: 'string', description: 'URL (for url-type items)' },
        title: { type: 'string', description: 'Item title' },
        content: { type: 'string', description: 'Item content/body' },
        metadata: { type: 'object', description: 'Additional metadata as JSON object' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to apply' },
        extractHashtags: { type: 'boolean', description: 'When true, parse "#word" patterns out of text-item content and add them as tags. Default false — content is treated as opaque text so issue refs like "#123" or numbered lists like "#3)" do not become tags.' },
      },
      required: ['type'],
    },
  },
  {
    name: 'update_item',
    description: 'Update an existing Peek item (title, content, or metadata).',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Item ID' },
        title: { type: 'string', description: 'New title' },
        content: { type: 'string', description: 'New content' },
        metadata: { type: 'object', description: 'New metadata (replaces existing)' },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'delete_item',
    description: 'Soft-delete a Peek item (sets deletedAt timestamp, recoverable).',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Item ID' },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'list_tags',
    description: 'List all tags in Peek with item counts. Optionally filter by search term.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search term to filter tag names' },
        limit: { type: 'number', description: 'Max results (default 100)' },
      },
    },
  },
  {
    name: 'tag_item',
    description: 'Add a tag to a Peek item. Creates the tag if it does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Item ID' },
        tagName: { type: 'string', description: 'Tag name' },
      },
      required: ['itemId', 'tagName'],
    },
  },
  {
    name: 'untag_item',
    description: 'Remove a tag from a Peek item.',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Item ID' },
        tagName: { type: 'string', description: 'Tag name' },
      },
      required: ['itemId', 'tagName'],
    },
  },
  {
    name: 'record_event',
    description: 'Record a timestamped event for a Peek item (e.g., "started working", "completed", "blocked").',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Item ID' },
        type: { type: 'string', description: 'Event type (e.g., started, completed, blocked, note)' },
        value: { type: 'string', description: 'Event value/details' },
      },
      required: ['itemId', 'type'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List task items (tagged #todo by default). Optionally filter by project tag.',
    inputSchema: {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' }, description: 'Task tags (default: ["todo"])' },
        project: { type: 'string', description: 'Project tag filter (e.g., "peek", "mobile")' },
      },
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task as done: adds "done" tag, removes "todo" tag, records completion event.',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Item ID' },
        notes: { type: 'string', description: 'Completion notes' },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'get_task_context',
    description: 'Get a task item with full context: metadata, tags, and recent events/history. Long content is windowed like get_item: by default only the first 4000 characters of `content` are returned, with `contentLength` (full length) and `contentTruncated: true` when anything was cut. Page with contentOffset, or pass maxContentLength: -1 for the whole thing.',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Item ID' },
        maxContentLength: { type: 'number', description: 'Max characters of content to return (default 4000). -1 for unlimited.' },
        contentOffset: { type: 'number', description: 'Character offset into content (default 0). Combine with maxContentLength to page through long items.' },
      },
      required: ['itemId'],
    },
  },
];

// --- Resource definitions ---

const RESOURCES = [
  {
    uri: 'peek://tasks',
    name: 'Peek Tasks',
    description: 'All items tagged #todo',
    mimeType: 'application/json',
  },
  {
    uri: 'peek://tags',
    name: 'Peek Tags',
    description: 'All tags with item counts',
    mimeType: 'application/json',
  },
];

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'peek://tasks/{tag}',
    name: 'Peek Tasks by Tag',
    description: 'Tasks filtered by additional tag',
    mimeType: 'application/json',
  },
];

// --- Tool handlers ---

function handleToolCall(name, args) {
  switch (name) {
    case 'list_items': {
      const rows = queryItems(args || {});
      return SCOPE ? rows.filter((r) => inScope(r.tags)) : rows;
    }
    case 'search_items': {
      const rows = searchItems(args || {});
      return SCOPE ? rows.filter((r) => inScope(r.tags)) : rows;
    }
    case 'get_item': {
      const itemId = resolveItemIdFromArgs(args);
      if (itemId === null) return null;
      const item = getItem(itemId);
      if (!item) return null;
      if (SCOPE && !inScope(item.tags)) return null;
      return shapeItemForResponse(item, args);
    }
    case 'create_item': {
      validateWriteTags(args.tags);
      return createItem({ ...args, tags: withScopeTag(args.tags) });
    }
    case 'update_item': {
      const itemId = resolveItemIdForMutation(args);
      const { itemId: _omit, ...rest } = args;
      assertItemInScope(itemId);
      return updateItem(itemId, rest);
    }
    case 'delete_item': {
      // Conservative: exact match OR unambiguous prefix only (mutation
      // resolver hard-errors on both not-found and ambiguity). The resolved
      // full id is surfaced in deleteItem's result so the caller sees exactly
      // what got deleted.
      const itemId = resolveItemIdForMutation(args);
      assertItemInScope(itemId);
      return deleteItem(itemId);
    }
    case 'list_tags': {
      const rows = listTags(args || {});
      return SCOPE ? rows.filter((t) => tagIsScopeOwned(t.name)) : rows;
    }
    case 'tag_item': {
      const itemId = resolveItemIdForMutation(args);
      assertItemInScope(itemId);
      validateWriteTags([args.tagName]);
      return tagItem(itemId, args.tagName);
    }
    case 'untag_item': {
      const itemId = resolveItemIdForMutation(args);
      assertItemInScope(itemId);
      // Only refuse a scope-owned untag if it would actually orphan the item.
      // If other in-scope tags remain (e.g. bare `peek` plus `peek:todo` →
      // dropping `peek:todo` leaves bare `peek`), the untag is safe.
      if (SCOPE && tagIsScopeOwned(args.tagName)) {
        const remaining = getItemTags(itemId).filter((t) => t !== args.tagName);
        if (!inScope(remaining)) {
          throw new Error(
            `Cannot untag "${args.tagName}" — it is the only tag keeping this item in scope "${SCOPE}". ` +
            `Add another ${SCOPE} or ${SCOPE}:* tag first, then retry.`,
          );
        }
      }
      return untagItem(itemId, args.tagName);
    }
    case 'record_event': {
      const itemId = resolveItemIdForMutation(args);
      assertItemInScope(itemId);
      return recordEvent(itemId, args.type, args.value);
    }
    case 'list_tasks': {
      const rows = listTasks(args || {});
      return SCOPE ? rows.filter((r) => inScope(r.tags)) : rows;
    }
    case 'complete_task': {
      const itemId = resolveItemIdForMutation(args);
      assertItemInScope(itemId);
      return completeTask(itemId, args.notes);
    }
    case 'get_task_context': {
      const itemId = resolveItemIdFromArgs(args);
      if (itemId === null) return null;
      const ctx = getTaskContext(itemId);
      if (!ctx) return null;
      if (SCOPE && !inScope(ctx.tags)) return null;
      return shapeItemForResponse(ctx, args);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- Resource handlers ---

function handleResourceRead(uri) {
  const scopeFilter = (rows) => SCOPE ? rows.filter((r) => inScope(r.tags)) : rows;
  const scopeTagFilter = (rows) => SCOPE ? rows.filter((t) => tagIsScopeOwned(t.name)) : rows;
  if (uri === 'peek://tasks') {
    return JSON.stringify(scopeFilter(listTasks()), null, 2);
  }
  if (uri === 'peek://tags') {
    return JSON.stringify(scopeTagFilter(listTags()), null, 2);
  }
  // peek://tasks/{tag}
  const taskMatch = uri.match(/^peek:\/\/tasks\/(.+)$/);
  if (taskMatch) {
    const tag = decodeURIComponent(taskMatch[1]);
    if (SCOPE && tagIsForeignNamespace(tag)) {
      throw new Error(`Tag "${tag}" is outside scope "${SCOPE}".`);
    }
    return JSON.stringify(scopeFilter(listTasks({ tags: ['todo'], project: tag })), null, 2);
  }
  throw new Error(`Unknown resource: ${uri}`);
}

// --- JSON-RPC message handling ---

function makeResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function makeError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return makeResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
          resources: { listChanged: false },
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
      });

    case 'notifications/initialized':
      // Client notification, no response needed
      return null;

    case 'ping':
      return makeResponse(id, {});

    case 'tools/list': {
      const visible = READONLY ? TOOLS.filter((t) => !MUTATING_TOOLS.has(t.name)) : TOOLS;
      return makeResponse(id, { tools: visible });
    }

    case 'tools/call': {
      const { name, arguments: args } = params;
      if (READONLY && MUTATING_TOOLS.has(name)) {
        return makeResponse(id, {
          content: [{ type: 'text', text: 'Error: Peek MCP is in read-only mode; mutating tools are disabled.' }],
          isError: true,
        });
      }
      try {
        const result = handleToolCall(name, args || {});
        return makeResponse(id, {
          content: [
            {
              type: 'text',
              // Compact on purpose — tool results are machine-read; pretty-
              // printing only inflates the caller's context.
              text: JSON.stringify(result),
            },
          ],
        });
      } catch (err) {
        return makeResponse(id, {
          content: [
            {
              type: 'text',
              text: `Error: ${err.message}`,
            },
          ],
          isError: true,
        });
      }
    }

    case 'resources/list':
      return makeResponse(id, { resources: RESOURCES, resourceTemplates: RESOURCE_TEMPLATES });

    case 'resources/read': {
      const { uri } = params;
      try {
        const text = handleResourceRead(uri);
        return makeResponse(id, {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text,
            },
          ],
        });
      } catch (err) {
        return makeError(id, -32602, err.message);
      }
    }

    case 'resources/templates/list':
      return makeResponse(id, { resourceTemplates: RESOURCE_TEMPLATES });

    default:
      if (method && method.startsWith('notifications/')) {
        // Notifications don't need responses
        return null;
      }
      return makeError(id, -32601, `Method not found: ${method}`);
  }
}

// --- Config drift detection ---
//
// Env (PEEK_MCP_SCOPE_TAG / PEEK_MCP_READONLY / PEEK_DB_PATH) is frozen
// at spawn. If the user changes settings (Settings UI toggle, scope edit,
// re-running peek-mcp-init), the on-disk config drifts from our process
// env and behaviour silently goes wrong. Detect drift before each
// incoming message and exit(0) so the client respawns with fresh env.
//
// We CANNOT know which registration Claude Code actually used to spawn us —
// a read-only user-scope entry (~/.claude/settings.json) and a scoped
// project entry (<cwd>/.mcp.json) legitimately coexist and differ. So we
// compare our env against EVERY candidate entry and only respawn when NONE
// of them matches — i.e. our env is genuinely stale. Matching against just
// the first-resolved file was a false-positive machine: whenever the nearest
// file happened to be the OTHER registration, a perfectly good server exited
// on connect and the client reported "can't connect".

function readPeekEntry(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return data?.mcpServers?.peek || null;
  } catch {
    return null;
  }
}

function collectOnDiskPeekEntries() {
  const candidates = [
    path.join(process.cwd(), '.mcp.json'),
    path.join(process.cwd(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ];
  const entries = [];
  let sawAnyFile = false;
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    sawAnyFile = true;
    const entry = readPeekEntry(p);
    if (entry) entries.push({ path: p, entry });
  }
  return { entries, sawAnyFile };
}

function entryEnvMatchesCurrent(entry) {
  const env = entry.env || {};
  const onScope = (env.PEEK_MCP_SCOPE_TAG || '').trim();
  const onReadonly = env.PEEK_MCP_READONLY === '1';
  const onDb = env.PEEK_DB_PATH || '';
  const curScope = (process.env.PEEK_MCP_SCOPE_TAG || '').trim();
  const curReadonly = process.env.PEEK_MCP_READONLY === '1';
  const curDb = process.env.PEEK_DB_PATH || '';
  return onScope === curScope && onReadonly === curReadonly && onDb === curDb;
}

let exiting = false;
function checkConfigDrift() {
  if (exiting) return;
  const { entries, sawAnyFile } = collectOnDiskPeekEntries();
  if (entries.length === 0) {
    // No config files at all → can't say; tolerate (might be transient).
    if (!sawAnyFile) return;
    // Files exist but the peek entry was removed everywhere — toggled off.
    exiting = true;
    process.stderr.write('Peek MCP entry removed from settings; exiting so client can clean up.\n');
    process.exit(0);
  }
  // Correctly configured as long as SOME on-disk entry agrees with how we
  // were spawned.
  if (entries.some(({ entry }) => entryEnvMatchesCurrent(entry))) return;
  // No entry matches our env → a real value change; respawn with fresh env.
  exiting = true;
  const curScope = (process.env.PEEK_MCP_SCOPE_TAG || '').trim();
  const curReadonly = process.env.PEEK_MCP_READONLY === '1';
  const curDb = process.env.PEEK_DB_PATH || '';
  let msg = 'Peek MCP config drift detected — no on-disk entry matches our spawn env:\n';
  msg += `  current: PEEK_MCP_SCOPE_TAG="${curScope}" ` +
    `PEEK_MCP_READONLY=${curReadonly ? '"1"' : '(unset)'} PEEK_DB_PATH="${curDb}"\n`;
  for (const { path: p, entry } of entries) {
    const env = entry.env || {};
    msg += `  on-disk ${p}: PEEK_MCP_SCOPE_TAG="${(env.PEEK_MCP_SCOPE_TAG || '').trim()}" ` +
      `PEEK_MCP_READONLY=${env.PEEK_MCP_READONLY === '1' ? '"1"' : '(unset)'} ` +
      `PEEK_DB_PATH="${env.PEEK_DB_PATH || ''}"\n`;
  }
  msg += 'Exiting so client respawns with fresh env.\n';
  process.stderr.write(msg);
  process.exit(0);
}

// --- Main ---

function defaultDbPath() {
  // macOS-only for now; mirrors PROFILES_BASE in main/mcp-config.ts.
  return path.join(
    os.homedir(), 'Library', 'Application Support', 'Peek',
    'default', 'datastore.sqlite',
  );
}

function main() {
  // Resolve DB path — falls back to platform default-profile location so
  // the settings.json snippet can omit env entirely for the common case.
  const dbPath = process.env.PEEK_DB_PATH || defaultDbPath();

  try {
    openDb(dbPath);
  } catch (err) {
    process.stderr.write(`Error opening database: ${err.message}\n`);
    process.exit(1);
  }

  process.stderr.write(`Peek MCP Server v${SERVER_VERSION} started\n`);
  process.stderr.write(`Database: ${dbPath}\n`);
  if (SCOPE) process.stderr.write(`Scope: ${SCOPE} (and ${SCOPE}:*)\n`);
  if (READONLY) process.stderr.write(`Read-only mode\n`);

  // Read JSON-RPC messages from stdin (newline-delimited)
  const rl = createInterface({ input: process.stdin });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    checkConfigDrift();

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stderr.write(`Invalid JSON: ${trimmed}\n`);
      return;
    }

    const response = handleMessage(msg);
    if (response) {
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  });

  rl.on('close', () => {
    process.stderr.write('Peek MCP Server shutting down\n');
    process.exit(0);
  });
}

main();
