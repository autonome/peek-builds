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
import { openDb, queryItems, getItem, createItem, updateItem, deleteItem,
         listTags, tagItem, untagItem, recordEvent, listTasks, completeTask,
         getTaskContext, getItemTags } from './db.js';

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
    name: 'get_item',
    description: 'Get a single Peek item by ID, with all metadata, tags, and details.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Item ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'create_item',
    description: 'Create a new item in Peek. For URLs, set type="url" and provide url. For text notes, set type="text" and provide content.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Item type: url, text, tagset, image, series, feed, entity' },
        url: { type: 'string', description: 'URL (for url-type items)' },
        title: { type: 'string', description: 'Item title' },
        content: { type: 'string', description: 'Item content/body' },
        metadata: { type: 'object', description: 'Additional metadata as JSON object' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to apply' },
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
        id: { type: 'string', description: 'Item ID' },
        title: { type: 'string', description: 'New title' },
        content: { type: 'string', description: 'New content' },
        metadata: { type: 'object', description: 'New metadata (replaces existing)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_item',
    description: 'Soft-delete a Peek item (sets deletedAt timestamp, recoverable).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Item ID' },
      },
      required: ['id'],
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
        id: { type: 'string', description: 'Item ID' },
        notes: { type: 'string', description: 'Completion notes' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_task_context',
    description: 'Get a task item with full context: metadata, tags, and recent events/history.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Item ID' },
      },
      required: ['id'],
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
    case 'get_item': {
      const item = getItem(args.id);
      if (!item) return null;
      if (SCOPE && !inScope(item.tags)) return null;
      return item;
    }
    case 'create_item': {
      validateWriteTags(args.tags);
      return createItem({ ...args, tags: withScopeTag(args.tags) });
    }
    case 'update_item': {
      const { id, ...rest } = args;
      assertItemInScope(id);
      return updateItem(id, rest);
    }
    case 'delete_item':
      assertItemInScope(args.id);
      return deleteItem(args.id);
    case 'list_tags': {
      const rows = listTags(args || {});
      return SCOPE ? rows.filter((t) => tagIsScopeOwned(t.name)) : rows;
    }
    case 'tag_item':
      assertItemInScope(args.itemId);
      validateWriteTags([args.tagName]);
      return tagItem(args.itemId, args.tagName);
    case 'untag_item':
      assertItemInScope(args.itemId);
      if (tagIsScopeOwned(args.tagName)) {
        throw new Error(`Cannot untag "${args.tagName}" — would remove item from scope "${SCOPE}".`);
      }
      return untagItem(args.itemId, args.tagName);
    case 'record_event':
      assertItemInScope(args.itemId);
      return recordEvent(args.itemId, args.type, args.value);
    case 'list_tasks': {
      const rows = listTasks(args || {});
      return SCOPE ? rows.filter((r) => inScope(r.tags)) : rows;
    }
    case 'complete_task':
      assertItemInScope(args.id);
      return completeTask(args.id, args.notes);
    case 'get_task_context': {
      const ctx = getTaskContext(args.id);
      if (!ctx) return null;
      if (SCOPE && !inScope(ctx.tags)) return null;
      return ctx;
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
              text: JSON.stringify(result, null, 2),
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

function readPeekEntry(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return data?.mcpServers?.peek || null;
  } catch {
    return null;
  }
}

function resolveOnDiskPeekEntry() {
  const candidates = [
    path.join(process.cwd(), '.mcp.json'),
    path.join(process.cwd(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ];
  let sawAnyFile = false;
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    sawAnyFile = true;
    const entry = readPeekEntry(p);
    if (entry) return { path: p, entry, sawAnyFile };
  }
  return { path: null, entry: null, sawAnyFile };
}

let exiting = false;
function checkConfigDrift() {
  if (exiting) return;
  const found = resolveOnDiskPeekEntry();
  if (!found.entry) {
    // No config files at all → can't say; tolerate (might be transient).
    if (!found.sawAnyFile) return;
    // Files exist but peek entry was removed — toggled off.
    exiting = true;
    process.stderr.write('Peek MCP entry removed from settings; exiting so client can clean up.\n');
    process.exit(0);
  }
  const env = found.entry.env || {};
  const onScope = (env.PEEK_MCP_SCOPE_TAG || '').trim();
  const onReadonly = env.PEEK_MCP_READONLY === '1';
  const onDb = env.PEEK_DB_PATH || '';
  const curScope = (process.env.PEEK_MCP_SCOPE_TAG || '').trim();
  const curReadonly = process.env.PEEK_MCP_READONLY === '1';
  const curDb = process.env.PEEK_DB_PATH || '';
  if (onScope !== curScope || onReadonly !== curReadonly || onDb !== curDb) {
    exiting = true;
    process.stderr.write(
      `Peek MCP config drift detected at ${found.path}:\n` +
      `  PEEK_MCP_SCOPE_TAG:  current="${curScope}" on-disk="${onScope}"\n` +
      `  PEEK_MCP_READONLY:   current=${curReadonly ? '"1"' : '(unset)'} on-disk=${onReadonly ? '"1"' : '(unset)'}\n` +
      `  PEEK_DB_PATH:        current="${curDb}" on-disk="${onDb}"\n` +
      `Exiting so client respawns with fresh env.\n`,
    );
    process.exit(0);
  }
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
