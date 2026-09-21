/**
 * Tests for Peek MCP Server.
 *
 * Creates a temp SQLite database with test data, spawns the MCP server,
 * and verifies JSON-RPC responses.
 *
 * Run with: node --test features/mcp-server/server.test.js
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  remoteStoreConfig, credentialFilePath, resolveCredentialFromFile,
  entryEnvMatchesCurrent, scopeConsistencyError,
} from './server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_PATH = join(__dirname, 'server.js');

// --- Test helpers ---

// Runs one or more ';'-separated statements against a fresh (or existing)
// database file, then closes the connection. Used to build fixtures the same
// way piping a schema file into the CLI used to.
function execSql(dbPath, sql) {
  const conn = new DatabaseSync(dbPath);
  try {
    conn.exec(sql);
  } finally {
    conn.close();
  }
}

// Runs a single SELECT and returns the rows as plain objects, the same shape
// the CLI's JSON output mode used to hand back after a JSON.parse.
function querySql(dbPath, sql) {
  const conn = new DatabaseSync(dbPath);
  try {
    return conn.prepare(sql).all();
  } finally {
    conn.close();
  }
}

function createTestDb() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'peek-mcp-test-'));
  const dbPath = join(tmpDir, 'test.sqlite');

  // Create schema
  const schema = `
    CREATE TABLE items (
      id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL,
      content TEXT,
      mimeType TEXT DEFAULT '',
      metadata TEXT DEFAULT '{}',
      syncId TEXT DEFAULT '',
      syncedAt INTEGER DEFAULT 0,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      deletedAt INTEGER DEFAULT 0,
      starred INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      visitCount INTEGER DEFAULT 0,
      lastVisitAt INTEGER DEFAULT 0,
      frecencyScore INTEGER DEFAULT 0,
      title TEXT DEFAULT '',
      domain TEXT DEFAULT '',
      favicon TEXT DEFAULT ''
    );

    CREATE TABLE tags (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      frequency INTEGER DEFAULT 1,
      lastUsed INTEGER NOT NULL,
      frecencyScore REAL DEFAULT 0.0,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      slug TEXT,
      color TEXT DEFAULT '#999999',
      parentId TEXT DEFAULT '',
      description TEXT DEFAULT '',
      metadata TEXT DEFAULT '{}'
    );

    CREATE TABLE item_tags (
      id TEXT PRIMARY KEY NOT NULL,
      itemId TEXT NOT NULL,
      tagId TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_item_tags_unique ON item_tags(itemId, tagId);

    CREATE TABLE item_events (
      id TEXT PRIMARY KEY NOT NULL,
      itemId TEXT NOT NULL,
      content TEXT,
      value REAL,
      occurredAt INTEGER NOT NULL,
      metadata TEXT DEFAULT '{}',
      createdAt INTEGER NOT NULL
    );
  `;

  execSql(dbPath, schema);

  // Seed test data
  const now = Date.now();
  const seed = `
    INSERT INTO items (id, type, content, title, domain, metadata, createdAt, updatedAt, deletedAt)
    VALUES
      ('item-1', 'url', 'https://example.com', 'Example', 'example.com', '{}', ${now - 3000}, ${now - 3000}, 0),
      ('item-2', 'text', 'Buy groceries', 'Shopping list', '', '{}', ${now - 2000}, ${now - 2000}, 0),
      ('item-3', 'url', 'https://test.com', 'Test Page', 'test.com', '{}', ${now - 1000}, ${now - 1000}, 0),
      ('item-deleted', 'text', 'Deleted note', 'Gone', '', '{}', ${now - 500}, ${now - 500}, ${now}),
      ('14efdd97-5f8b-4a6b-9dc3-a3745c276fa8', 'text', 'uuid item', 'UUID Item', '', '{}', ${now - 4000}, ${now - 4000}, 0),
      ('item_1780235197219_0biqk0wf9', 'text', 'ts item', 'Timestamp Item', '', '{}', ${now - 4500}, ${now - 4500}, 0),
      ('item_1780235197219_zzzzzzzz9', 'text', 'ts twin', 'Timestamp Twin', '', '{}', ${now - 4600}, ${now - 4600}, 0);

    -- Windowing fixtures: NULL content (createItem defaults content to '',
    -- so this must be seeded), carrying a data: URI favicon for strip tests.
    INSERT INTO items (id, type, content, title, domain, metadata, favicon, createdAt, updatedAt, deletedAt)
    VALUES ('item-null-content', 'text', NULL, 'Fixture With Null Body', '', '{}', 'data:image/png;base64,iVBORw0KGgo=', ${now - 4700}, ${now - 4700}, 0);

    INSERT INTO tags (id, name, frequency, lastUsed, frecencyScore, createdAt, updatedAt)
    VALUES
      ('tag-1', 'todo', 1, ${now}, 10.0, ${now}, ${now}),
      ('tag-2', 'peek', 1, ${now}, 5.0, ${now}, ${now}),
      ('tag-3', 'reading', 1, ${now}, 3.0, ${now}, ${now});

    INSERT INTO item_tags (id, itemId, tagId, createdAt)
    VALUES
      ('it-1', 'item-1', 'tag-3', ${now}),
      ('it-2', 'item-2', 'tag-1', ${now}),
      ('it-3', 'item-2', 'tag-2', ${now});
  `;

  execSql(dbPath, seed);

  return dbPath;
}

class McpClient {
  constructor(dbPath, extraEnv = {}) {
    this.dbPath = dbPath;
    this.extraEnv = extraEnv;
    this.proc = null;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
  }

  start() {
    return new Promise((resolve, reject) => {
      // Isolate HOME + cwd so the server's drift check can't see the real
      // user's .mcp.json or ~/.claude.json.
      this.tmpCwd = mkdtempSync(join(tmpdir(), 'peek-mcp-test-cwd-'));
      this.proc = spawn('node', [SERVER_PATH], {
        env: { ...process.env, HOME: this.tmpCwd, PEEK_DB_PATH: this.dbPath, ...this.extraEnv },
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.tmpCwd,
      });

      this.proc.stdout.on('data', (chunk) => {
        this.buffer += chunk.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop(); // Keep incomplete line
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            const resolver = this.pending.get(msg.id);
            if (resolver) {
              this.pending.delete(msg.id);
              resolver(msg);
            }
          } catch {
            // ignore parse errors
          }
        }
      });

      // Wait for startup message on stderr
      this.proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        if (text.includes('started')) {
          resolve();
        }
      });

      this.proc.on('error', reject);

      // Timeout fallback
      setTimeout(() => resolve(), 2000);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout waiting for response to ${method}`));
        }
      }, 5000);
    });
  }

  async callTool(name, args = {}) {
    const resp = await this.send('tools/call', { name, arguments: args });
    if (resp.error) throw new Error(resp.error.message);
    const text = resp.result.content[0].text;
    return JSON.parse(text);
  }

  // Returns the full result envelope so callers can inspect isError + raw
  // text (which may be a plain "Error: ..." string, not JSON).
  async callToolRaw(name, args = {}) {
    const resp = await this.send('tools/call', { name, arguments: args });
    if (resp.error) throw new Error(resp.error.message);
    return resp.result;
  }

  stop() {
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill();
      this.proc = null;
    }
  }
}

// --- Tests ---

describe('MCP Server', () => {
  let dbPath;
  let client;

  before(async () => {
    dbPath = createTestDb();
    client = new McpClient(dbPath);
    await client.start();
  });

  after(() => {
    client.stop();
    if (dbPath && existsSync(dbPath)) {
      try { unlinkSync(dbPath); } catch { /* ignore */ }
    }
  });

  describe('initialize', () => {
    it('should return server info and capabilities', async () => {
      const resp = await client.send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      });
      assert.equal(resp.result.serverInfo.name, 'peek-mcp');
      assert.ok(resp.result.capabilities.tools);
      assert.ok(resp.result.capabilities.resources);
    });
  });

  describe('tools/list', () => {
    it('should return all registered tools', async () => {
      const resp = await client.send('tools/list');
      const tools = resp.result.tools;
      assert.ok(Array.isArray(tools));
      const names = tools.map(t => t.name);
      assert.ok(names.includes('list_items'));
      assert.ok(names.includes('get_item'));
      assert.ok(names.includes('create_item'));
      assert.ok(names.includes('update_item'));
      assert.ok(names.includes('delete_item'));
      assert.ok(names.includes('list_tags'));
      assert.ok(names.includes('tag_item'));
      assert.ok(names.includes('untag_item'));
      assert.ok(names.includes('record_event'));
      assert.ok(names.includes('list_tasks'));
      assert.ok(names.includes('complete_task'));
      assert.ok(names.includes('get_task_context'));
    });
  });

  describe('list_items', () => {
    it('should return non-deleted items', async () => {
      const items = await client.callTool('list_items', { limit: 100 });
      assert.ok(Array.isArray(items));
      // 3 original (item-1/2/3) + 3 prefix-resolution fixtures (uuid, ts,
      // ts-twin) + 1 null-content windowing fixture.
      assert.equal(items.length, 7);
      // Should not include deleted item
      const ids = items.map(i => i.id);
      assert.ok(!ids.includes('item-deleted'));
    });

    it('should filter by type', async () => {
      const items = await client.callTool('list_items', { type: 'url' });
      assert.equal(items.length, 2);
      for (const item of items) {
        assert.equal(item.type, 'url');
      }
    });

    it('should filter by tags', async () => {
      const items = await client.callTool('list_items', { tags: ['todo'] });
      assert.equal(items.length, 1);
      assert.equal(items[0].id, 'item-2');
    });

    it('should filter by multiple tags (AND)', async () => {
      const items = await client.callTool('list_items', { tags: ['todo', 'peek'] });
      assert.equal(items.length, 1);
      assert.equal(items[0].id, 'item-2');
    });

    it('should respect limit', async () => {
      const items = await client.callTool('list_items', { limit: 1 });
      assert.equal(items.length, 1);
    });
  });

  describe('search_items', () => {
    // Regression headline: items engineered so the two query terms live in
    // DIFFERENT fields (and one only in a tag). The old whole-string LIKE
    // returned [] for "mcp fix"; the tokenized AND must find them.
    let mcpTitleItem;   // title="mcp server", content has "fix"
    let mcpTagItem;     // tag "mcp", content has "fix"
    let titleMatch;     // title="searchterm in title"
    let contentMatch;   // content has "searchterm"
    let wildcardItem;   // content has literal "100% done_now"

    before(async () => {
      mcpTitleItem = await client.callTool('create_item', {
        type: 'text', title: 'mcp server notes',
        content: 'need to fix the search handler later',
      });
      mcpTagItem = await client.callTool('create_item', {
        type: 'text', title: 'unrelated heading',
        content: 'remember to fix this thing', tags: ['mcp'],
      });
      titleMatch = await client.callTool('create_item', {
        type: 'text', title: 'searchterm lives in the title',
        content: 'body without the word',
      });
      contentMatch = await client.callTool('create_item', {
        type: 'text', title: 'plain heading',
        content: 'the searchterm lives only in the content here',
      });
      wildcardItem = await client.callTool('create_item', {
        type: 'text', title: 'progress',
        content: 'we are 100% done_now with the rollout',
      });
    });

    it('REGRESSION: multi-term query finds an item with terms in different fields', async () => {
      // "mcp fix": "mcp" in title, "fix" in content. Old search returned [].
      const results = await client.callTool('search_items', { query: 'mcp fix' });
      const ids = results.map((r) => r.id);
      assert.ok(ids.includes(mcpTitleItem.id),
        `expected "mcp fix" to find the item with mcp-in-title + fix-in-content, got ids: ${ids.join(', ')}`);
    });

    it('multi-term query matches a term that only appears in a tag', async () => {
      // mcpTagItem: "mcp" is ONLY a tag, "fix" is in content.
      const results = await client.callTool('search_items', { query: 'mcp fix' });
      const ids = results.map((r) => r.id);
      assert.ok(ids.includes(mcpTagItem.id),
        `expected tag-only "mcp" + content "fix" item to be found, got: ${ids.join(', ')}`);
    });

    it('AND semantics: an item missing one term is excluded', async () => {
      // titleMatch has neither "mcp" nor "fix" → excluded from "mcp fix".
      const results = await client.callTool('search_items', { query: 'mcp fix' });
      const ids = results.map((r) => r.id);
      assert.ok(!ids.includes(titleMatch.id));
    });

    it('a query matching only via a tag returns the item (tags are searchable)', async () => {
      const results = await client.callTool('search_items', { query: 'reading' });
      const ids = results.map((r) => r.id);
      // item-1 carries the seeded 'reading' tag, with no "reading" text.
      assert.ok(ids.includes('item-1'),
        `expected tag-only match to surface item-1, got: ${ids.join(', ')}`);
    });

    it('ranks a title match above a content-only match for the same term', async () => {
      const results = await client.callTool('search_items', { query: 'searchterm' });
      const titleIdx = results.findIndex((r) => r.id === titleMatch.id);
      const contentIdx = results.findIndex((r) => r.id === contentMatch.id);
      assert.ok(titleIdx !== -1 && contentIdx !== -1, 'both should be found');
      assert.ok(titleIdx < contentIdx,
        `title match (idx ${titleIdx}) should rank above content match (idx ${contentIdx})`);
      // And the title-hit score should exceed the content-hit score.
      assert.ok(results[titleIdx].score > results[contentIdx].score);
    });

    it('returns a snippet containing the matched term', async () => {
      const results = await client.callTool('search_items', { query: 'searchterm' });
      const hit = results.find((r) => r.id === contentMatch.id);
      assert.ok(hit, 'content match should be present');
      assert.ok(typeof hit.snippet === 'string' && hit.snippet.length > 0, 'snippet should be present');
      assert.ok(hit.snippet.toLowerCase().includes('searchterm'),
        `snippet should contain the term, got: "${hit.snippet}"`);
    });

    it('field-aware: query + tags filter returns only items satisfying BOTH', async () => {
      // "fix" matches both mcpTitleItem and mcpTagItem; only mcpTagItem has tag 'mcp'.
      const results = await client.callTool('search_items', { query: 'fix', tags: ['mcp'] });
      const ids = results.map((r) => r.id);
      assert.ok(ids.includes(mcpTagItem.id));
      assert.ok(!ids.includes(mcpTitleItem.id),
        `tag filter should exclude the untagged text match, got: ${ids.join(', ')}`);
    });

    it('treats wildcard chars (% _) in the query as literal', async () => {
      // "100%" must NOT match via LIKE wildcard semantics; it must match the
      // literal "100%" in wildcardItem and not, say, every item.
      const results = await client.callTool('search_items', { query: '100% done_now' });
      const ids = results.map((r) => r.id);
      assert.ok(ids.includes(wildcardItem.id), `literal "100% done_now" should match, got: ${ids.join(', ')}`);
      // Sanity: a bare "%" would match everything if treated as a wildcard.
      // Here "100%" is anchored to a literal that only one item has.
      assert.equal(ids.filter((id) => id === wildcardItem.id).length, 1);
    });

    it('empty/whitespace query returns no results (text search needs terms)', async () => {
      const results = await client.callTool('search_items', { query: '   ' });
      assert.deepEqual(results, []);
    });

    it('does not return deleted items', async () => {
      const results = await client.callTool('search_items', { query: 'Deleted' });
      const ids = results.map((r) => r.id);
      assert.ok(!ids.includes('item-deleted'));
    });
  });

  describe('get_item', () => {
    it('should return item with tags', async () => {
      const item = await client.callTool('get_item', { itemId: 'item-2' });
      assert.equal(item.id, 'item-2');
      assert.equal(item.title, 'Shopping list');
      assert.ok(Array.isArray(item.tags));
      assert.ok(item.tags.includes('todo'));
      assert.ok(item.tags.includes('peek'));
    });

    it('should return null for nonexistent item', async () => {
      const item = await client.callTool('get_item', { itemId: 'nonexistent' });
      assert.equal(item, null);
    });

    it('round-trips an id created via create_item, via the itemId param', async () => {
      const created = await client.callTool('create_item', { type: 'text', title: 'Roundtrip', content: 'roundtrip body' });
      const fetched = await client.callTool('get_item', { itemId: created.id });
      assert.equal(fetched.id, created.id);
      assert.equal(fetched.title, 'Roundtrip');
    });

    it('returns a clean error mentioning itemId when itemId is missing', async () => {
      const r = await client.callToolRaw('get_item', {});
      assert.equal(r.isError, true);
      assert.ok(r.content[0].text.includes('itemId'), `expected error to mention itemId, got: ${r.content[0].text}`);
    });
  });

  describe('get_item id-prefix resolution', () => {
    it('resolves a UUID-style id by unique prefix', async () => {
      const item = await client.callTool('get_item', { itemId: '14efdd97' });
      assert.ok(item, 'expected the uuid item to resolve from its prefix');
      assert.equal(item.id, '14efdd97-5f8b-4a6b-9dc3-a3745c276fa8');
      assert.equal(item.title, 'UUID Item');
    });

    it('resolves a timestamp-style id by unique prefix', async () => {
      // `item_1780235197219_0` is unique (the twin diverges at the suffix).
      const item = await client.callTool('get_item', { itemId: 'item_1780235197219_0' });
      assert.ok(item, 'expected the timestamp item to resolve from its prefix');
      assert.equal(item.id, 'item_1780235197219_0biqk0wf9');
      assert.equal(item.title, 'Timestamp Item');
    });

    it('treats literal underscores in a prefix as literal, not LIKE wildcards', async () => {
      // If `_` were a LIKE wildcard, the prefix `item_1` would also match
      // `item-1` (dash). It must NOT — underscores are escaped.
      const item = await client.callTool('get_item', { itemId: 'item_1780235197219_0biqk0wf9' });
      assert.equal(item.id, 'item_1780235197219_0biqk0wf9');
    });

    it('exact full id wins (and is returned even when it is a prefix of others)', async () => {
      // `item_1780235197219_0biqk0wf9` is a full id; it is NOT a prefix of the
      // twin, but the broader point: an exact match short-circuits. Verify the
      // shared prefix `item_1780235197219_` (ambiguous across both twins) errors,
      // while either full id resolves cleanly.
      const a = await client.callTool('get_item', { itemId: 'item_1780235197219_0biqk0wf9' });
      assert.equal(a.id, 'item_1780235197219_0biqk0wf9');
      const b = await client.callTool('get_item', { itemId: 'item_1780235197219_zzzzzzzz9' });
      assert.equal(b.id, 'item_1780235197219_zzzzzzzz9');
    });

    it('errors on an ambiguous prefix and names the candidates', async () => {
      // `item_1780235197219_` is a prefix of BOTH timestamp twins.
      const r = await client.callToolRaw('get_item', { itemId: 'item_1780235197219_' });
      assert.equal(r.isError, true);
      const text = r.content[0].text;
      assert.match(text, /[Aa]mbiguous/);
      assert.match(text, /item_1780235197219_0biqk0wf9/);
      assert.match(text, /item_1780235197219_zzzzzzzz9/);
    });

    it('returns null for an unknown prefix (not-found, same as exact miss)', async () => {
      const r = await client.callTool('get_item', { itemId: 'zzzzznope' });
      assert.equal(r, null);
    });

    it('get_task_context also resolves a unique prefix', async () => {
      const ctx = await client.callTool('get_task_context', { itemId: '14efdd97' });
      assert.ok(ctx);
      assert.equal(ctx.id, '14efdd97-5f8b-4a6b-9dc3-a3745c276fa8');
      assert.ok(Array.isArray(ctx.events));
    });
  });

  describe('mutating tools + id-prefix resolution', () => {
    it('update_item resolves a unique prefix', async () => {
      const item = await client.callTool('update_item', {
        itemId: '14efdd97', title: 'UUID Item (renamed)',
      });
      assert.equal(item.id, '14efdd97-5f8b-4a6b-9dc3-a3745c276fa8');
      assert.equal(item.title, 'UUID Item (renamed)');
    });

    it('update_item refuses an ambiguous prefix (never mutates a guess)', async () => {
      const r = await client.callToolRaw('update_item', {
        itemId: 'item_1780235197219_', title: 'should not apply',
      });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /[Aa]mbiguous/);
      // Neither twin should have been touched.
      const a = await client.callTool('get_item', { itemId: 'item_1780235197219_0biqk0wf9' });
      const b = await client.callTool('get_item', { itemId: 'item_1780235197219_zzzzzzzz9' });
      assert.notEqual(a.title, 'should not apply');
      assert.notEqual(b.title, 'should not apply');
    });

    it('mutating tool errors (not null) on an unknown prefix', async () => {
      const r = await client.callToolRaw('update_item', {
        itemId: 'zzzzznope', title: 'x',
      });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /No item found/);
    });

    it('delete_item resolves a unique prefix and surfaces the resolved id', async () => {
      const created = await client.callTool('create_item', {
        type: 'text', title: 'prefix-delete-me', content: 'x',
      });
      const prefix = created.id.slice(0, 8);
      const result = await client.callTool('delete_item', { itemId: prefix });
      assert.equal(result.success, true);
      // The full resolved id is surfaced so the caller sees what got deleted.
      assert.equal(result.id, created.id);
    });
  });

  describe('create_item', () => {
    it('should create a text item with tags', async () => {
      const item = await client.callTool('create_item', {
        type: 'text',
        title: 'New task',
        content: 'Do the thing',
        tags: ['todo'],
      });
      assert.ok(item.id);
      assert.equal(item.type, 'text');
      assert.equal(item.title, 'New task');
      assert.ok(item.tags.includes('todo'));
    });

    it('should create a URL item', async () => {
      const item = await client.callTool('create_item', {
        type: 'url',
        url: 'https://github.com',
        title: 'GitHub',
      });
      assert.ok(item.id);
      assert.equal(item.type, 'url');
      assert.equal(item.domain, 'github.com');
    });
  });

  describe('update_item', () => {
    it('should update item title', async () => {
      const item = await client.callTool('update_item', {
        itemId: 'item-1',
        title: 'Updated Example',
      });
      assert.equal(item.title, 'Updated Example');
    });
  });

  describe('delete_item', () => {
    it('should soft-delete an item', async () => {
      // Create then delete
      const created = await client.callTool('create_item', {
        type: 'text',
        title: 'To delete',
      });
      const result = await client.callTool('delete_item', { itemId: created.id });
      assert.equal(result.success, true);

      // Should no longer appear in list
      const items = await client.callTool('list_items');
      const ids = items.map(i => i.id);
      assert.ok(!ids.includes(created.id));
    });
  });

  describe('list_tags', () => {
    it('should return tags with item counts', async () => {
      const tags = await client.callTool('list_tags');
      assert.ok(Array.isArray(tags));
      assert.ok(tags.length >= 3);
      const todo = tags.find(t => t.name === 'todo');
      assert.ok(todo);
      assert.ok(todo.itemCount >= 1);
    });

    it('should filter by search', async () => {
      const tags = await client.callTool('list_tags', { search: 'tod' });
      assert.equal(tags.length, 1);
      assert.equal(tags[0].name, 'todo');
    });
  });

  describe('tag_item / untag_item', () => {
    it('should add and remove tags', async () => {
      // Tag item-1 with 'important'
      await client.callTool('tag_item', { itemId: 'item-1', tagName: 'important' });
      let item = await client.callTool('get_item', { itemId: 'item-1' });
      assert.ok(item.tags.includes('important'));

      // Untag
      await client.callTool('untag_item', { itemId: 'item-1', tagName: 'important' });
      item = await client.callTool('get_item', { itemId: 'item-1' });
      assert.ok(!item.tags.includes('important'));
    });

    it('should apply an existing tag to a second item without ON CONFLICT error', async () => {
      // 'todo' already exists in the tags table (seeded). Applying it to item-3
      // exercises the ON CONFLICT(name) DO UPDATE path in tagItemInTx.
      // Regression guard for: "ON CONFLICT clause does not match any PRIMARY KEY
      // or UNIQUE constraint" (requires CREATE UNIQUE INDEX on tags.name).
      const result = await client.callTool('tag_item', { itemId: 'item-3', tagName: 'todo' });
      assert.equal(result.success, true);
      const item = await client.callTool('get_item', { itemId: 'item-3' });
      assert.ok(item.tags.includes('todo'));
    });

    it('should be idempotent when tagging an item that already has the tag', async () => {
      // item-2 already has 'todo'. Re-tagging must not throw.
      const result = await client.callTool('tag_item', { itemId: 'item-2', tagName: 'todo' });
      assert.equal(result.success, true);
    });
  });

  describe('record_event', () => {
    it('should record an event', async () => {
      const result = await client.callTool('record_event', {
        itemId: 'item-1',
        type: 'started',
        value: 'Working on it',
      });
      assert.equal(result.success, true);
      assert.ok(result.id);
    });
  });

  describe('list_tasks', () => {
    it('should return items tagged todo', async () => {
      const tasks = await client.callTool('list_tasks');
      assert.ok(Array.isArray(tasks));
      // item-2 is tagged todo
      const ids = tasks.map(t => t.id);
      assert.ok(ids.includes('item-2'));
    });

    it('should filter by project', async () => {
      const tasks = await client.callTool('list_tasks', { project: 'peek' });
      assert.ok(tasks.length >= 1);
      // item-2 has both todo and peek tags
      assert.ok(tasks.some(t => t.id === 'item-2'));
    });
  });

  describe('complete_task', () => {
    it('should add done tag and remove todo tag', async () => {
      // Create a task
      const task = await client.callTool('create_item', {
        type: 'text',
        title: 'Task to complete',
        tags: ['todo'],
      });

      const result = await client.callTool('complete_task', {
        itemId: task.id,
        notes: 'All done',
      });

      assert.ok(result.tags.includes('done'));
      assert.ok(!result.tags.includes('todo'));
    });
  });

  describe('get_task_context', () => {
    it('should return item with events', async () => {
      // Record some events for item-2
      await client.callTool('record_event', {
        itemId: 'item-2',
        type: 'note',
        value: 'Making progress',
      });

      const ctx = await client.callTool('get_task_context', { itemId: 'item-2' });
      assert.equal(ctx.id, 'item-2');
      assert.ok(Array.isArray(ctx.events));
      assert.ok(ctx.events.length >= 1);
    });
  });

  describe('content windowing + favicon stripping', () => {
    // 9000 chars with position-distinct segments so offset slices are verifiable.
    const LONG_CONTENT = 'a'.repeat(4000) + 'b'.repeat(4000) + 'c'.repeat(1000);
    let longId;

    before(async () => {
      const created = await client.callTool('create_item', {
        type: 'text', title: 'Long Body Fixture', content: LONG_CONTENT,
      });
      longId = created.id;
    });

    it('truncates content to 4000 chars by default, with contentLength + contentTruncated', async () => {
      const item = await client.callTool('get_item', { itemId: longId });
      assert.equal(item.content, 'a'.repeat(4000));
      assert.equal(item.contentLength, 9000);
      assert.equal(item.contentTruncated, true);
    });

    it('maxContentLength: -1 returns the whole content with no truncated flag', async () => {
      const item = await client.callTool('get_item', { itemId: longId, maxContentLength: -1 });
      assert.equal(item.content, LONG_CONTENT);
      assert.equal(item.contentLength, 9000);
      assert.ok(!('contentTruncated' in item));
    });

    it('pages through long content with contentOffset', async () => {
      const page2 = await client.callTool('get_item', { itemId: longId, contentOffset: 4000 });
      assert.equal(page2.content, 'b'.repeat(4000));
      assert.equal(page2.contentTruncated, true);
      assert.equal(page2.contentLength, 9000);
      // Final page: shorter than the window, but still flagged truncated
      // (offset > 0 means the caller did not receive the whole string).
      const page3 = await client.callTool('get_item', { itemId: longId, contentOffset: 8000 });
      assert.equal(page3.content, 'c'.repeat(1000));
      assert.equal(page3.contentTruncated, true);
      assert.equal(page3.contentLength, 9000);
    });

    it('honors an explicit maxContentLength window at an offset', async () => {
      const item = await client.callTool('get_item', {
        itemId: longId, contentOffset: 3998, maxContentLength: 4,
      });
      assert.equal(item.content, 'aabb');
      assert.equal(item.contentTruncated, true);
    });

    it('offset past the end returns empty content, flagged truncated', async () => {
      const item = await client.callTool('get_item', { itemId: longId, contentOffset: 20000 });
      assert.equal(item.content, '');
      assert.equal(item.contentTruncated, true);
      assert.equal(item.contentLength, 9000);
    });

    it('negative (non--1) or non-numeric params fall back to defaults', async () => {
      const item = await client.callTool('get_item', {
        itemId: longId, maxContentLength: -5, contentOffset: -10,
      });
      assert.equal(item.content, 'a'.repeat(4000));
      assert.equal(item.contentTruncated, true);
      const item2 = await client.callTool('get_item', {
        itemId: longId, maxContentLength: 'nope', contentOffset: 'nah',
      });
      assert.equal(item2.content, 'a'.repeat(4000));
      assert.equal(item2.contentTruncated, true);
    });

    it('short content comes back whole: contentLength set, no truncated flag', async () => {
      const item = await client.callTool('get_item', { itemId: 'item-2' });
      assert.equal(item.content, 'Buy groceries');
      assert.equal(item.contentLength, 'Buy groceries'.length);
      assert.ok(!('contentTruncated' in item));
    });

    it('content exactly at the 4000 boundary is not flagged truncated', async () => {
      const created = await client.callTool('create_item', {
        type: 'text', title: 'Exactly At Boundary', content: 'x'.repeat(4000),
      });
      const item = await client.callTool('get_item', { itemId: created.id });
      assert.equal(item.content.length, 4000);
      assert.equal(item.contentLength, 4000);
      assert.ok(!('contentTruncated' in item));
    });

    it('null content passes through untouched (no contentLength, no flag)', async () => {
      const item = await client.callTool('get_item', { itemId: 'item-null-content' });
      assert.equal(item.content, null);
      assert.ok(!('contentLength' in item));
      assert.ok(!('contentTruncated' in item));
    });

    it('favicon is stripped from get_item responses', async () => {
      // item-null-content is seeded WITH a data: URI favicon; item-2 carries
      // the '' column default — both must come back without the property.
      const withFavicon = await client.callTool('get_item', { itemId: 'item-null-content' });
      assert.ok(!('favicon' in withFavicon));
      const plain = await client.callTool('get_item', { itemId: 'item-2' });
      assert.ok(!('favicon' in plain));
    });

    it('get_task_context windows content and strips favicon the same way', async () => {
      const dflt = await client.callTool('get_task_context', { itemId: longId });
      assert.equal(dflt.content, 'a'.repeat(4000));
      assert.equal(dflt.contentLength, 9000);
      assert.equal(dflt.contentTruncated, true);
      assert.ok(!('favicon' in dflt));
      assert.ok(Array.isArray(dflt.events));

      const page = await client.callTool('get_task_context', {
        itemId: longId, contentOffset: 4000, maxContentLength: 1000,
      });
      assert.equal(page.content, 'b'.repeat(1000));
      assert.equal(page.contentTruncated, true);

      const full = await client.callTool('get_task_context', { itemId: longId, maxContentLength: -1 });
      assert.equal(full.content, LONG_CONTENT);
      assert.ok(!('contentTruncated' in full));
    });
  });

  describe('tool result serialization', () => {
    it('is compact JSON (no pretty-print indentation)', async () => {
      const r = await client.callToolRaw('get_item', { itemId: 'item-2' });
      const text = r.content[0].text;
      assert.ok(!text.includes('\n'), 'expected compact single-line JSON');
      assert.equal(text, JSON.stringify(JSON.parse(text)));
    });
  });

  describe('resources', () => {
    it('should list resources', async () => {
      const resp = await client.send('resources/list');
      const resources = resp.result.resources;
      assert.ok(Array.isArray(resources));
      assert.ok(resources.some(r => r.uri === 'peek://tasks'));
      assert.ok(resources.some(r => r.uri === 'peek://tags'));
    });

    it('should read peek://tasks', async () => {
      const resp = await client.send('resources/read', { uri: 'peek://tasks' });
      const text = resp.result.contents[0].text;
      const tasks = JSON.parse(text);
      assert.ok(Array.isArray(tasks));
    });

    it('should read peek://tags', async () => {
      const resp = await client.send('resources/read', { uri: 'peek://tags' });
      const text = resp.result.contents[0].text;
      const tags = JSON.parse(text);
      assert.ok(Array.isArray(tags));
    });
  });

  describe('error handling', () => {
    it('should return error for unknown tool', async () => {
      const resp = await client.send('tools/call', {
        name: 'nonexistent_tool',
        arguments: {},
      });
      assert.ok(resp.result.isError);
      assert.ok(resp.result.content[0].text.includes('Unknown tool'));
    });

    it('should return error for unknown method', async () => {
      const resp = await client.send('nonexistent/method');
      assert.ok(resp.error);
      assert.equal(resp.error.code, -32601);
    });
  });

  // Parity tests: lock in MCP-side behavior that matches policy in
  // apps/desktop/main/datastore.ts. If datastore.ts changes the formulas
  // or rules, these tests will keep passing while the app diverges —
  // they're a lower bar than true integration. The schema-drift test
  // (schema-drift.test.js) covers the structural side.
  describe('policy parity with datastore.ts', () => {
    it('sets slug on new tags (lowercase, hyphens for whitespace)', async () => {
      await client.callTool('tag_item', { itemId: 'item-1', tagName: 'Big Project' });
      // Inspect the raw row — list_tags doesn't expose slug.
      const rows = querySql(client.dbPath, `SELECT name, slug FROM tags WHERE name = 'Big Project';`);
      assert.equal(rows[0].slug, 'big-project');
    });

    it('writes non-zero frecencyScore when tagging', async () => {
      await client.callTool('tag_item', { itemId: 'item-1', tagName: 'fresh-tag' });
      const rows = querySql(client.dbPath, `SELECT frequency, frecencyScore FROM tags WHERE name = 'fresh-tag';`);
      // calculateTagFrecency(1, now) with daysSinceUse≈0 ≈ 10 * 1 = 10
      assert.equal(rows[0].frequency, 1);
      assert.equal(rows[0].frecencyScore, 10);
    });

    it('bumps frecencyScore on subsequent tag uses', async () => {
      await client.callTool('tag_item', { itemId: 'item-1', tagName: 'reuse-tag' });
      await client.callTool('tag_item', { itemId: 'item-3', tagName: 'reuse-tag' });
      const rows = querySql(client.dbPath, `SELECT frequency, frecencyScore FROM tags WHERE name = 'reuse-tag';`);
      assert.equal(rows[0].frequency, 2);
      assert.equal(rows[0].frecencyScore, 20);
    });

    it('does NOT extract #hashtags from content by default (opt-in only)', async () => {
      // The MCP layer differs from the in-app datastore policy: LLM callers
      // write "#123" issue refs and "#3)" enumerations in prose constantly,
      // so default behavior is to treat content as opaque. Callers that
      // genuinely want UI-style auto-tagging pass extractHashtags:true.
      const item = await client.callTool('create_item', {
        type: 'text',
        title: 'Note',
        content: 'fixes #123 and adds #feature',
      });
      assert.ok(!item.tags.includes('123'));
      assert.ok(!item.tags.includes('feature'));
    });

    it('auto-extracts #hashtags from text item content when extractHashtags is true', async () => {
      const item = await client.callTool('create_item', {
        type: 'text',
        title: 'Note',
        content: 'meeting with #alice about the #project',
        extractHashtags: true,
      });
      assert.ok(item.tags.includes('alice'));
      assert.ok(item.tags.includes('project'));
    });

    it('does not extract hashtags from url-type items even when extractHashtags is true', async () => {
      const item = await client.callTool('create_item', {
        type: 'url',
        url: 'https://example.com/#fragment',
        title: 'Page',
        extractHashtags: true,
      });
      // The URL fragment is `fragment` — would be picked up by the
      // hashtag regex on text. For url-type, content is the URL and
      // we deliberately skip extraction (matches datastore.ts which
      // only calls syncContentHashtags on text items).
      assert.ok(!item.tags.includes('fragment'));
    });
  });
});

// --- Scope tests ---
//
// Verify PEEK_MCP_SCOPE_TAG hard-fence. An agent running with scope="peek"
// must only see/touch items tagged `peek` or `peek:*`. Untagged items and
// foreign namespaces (`untense`, `untense:*`) are invisible and unwritable.

function createScopedTestDb() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'peek-mcp-scope-test-'));
  const dbPath = join(tmpDir, 'test.sqlite');
  const schema = `
    CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL, type TEXT NOT NULL,
      content TEXT, mimeType TEXT DEFAULT '', metadata TEXT DEFAULT '{}',
      syncId TEXT DEFAULT '', syncedAt INTEGER DEFAULT 0,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      deletedAt INTEGER DEFAULT 0, starred INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0, visitCount INTEGER DEFAULT 0,
      lastVisitAt INTEGER DEFAULT 0, frecencyScore INTEGER DEFAULT 0,
      title TEXT DEFAULT '', domain TEXT DEFAULT '', favicon TEXT DEFAULT '');
    CREATE TABLE tags (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE,
      frequency INTEGER DEFAULT 1, lastUsed INTEGER NOT NULL,
      frecencyScore REAL DEFAULT 0.0, createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL, slug TEXT, color TEXT DEFAULT '#999999',
      parentId TEXT DEFAULT '', description TEXT DEFAULT '', metadata TEXT DEFAULT '{}');
    CREATE TABLE item_tags (id TEXT PRIMARY KEY NOT NULL, itemId TEXT NOT NULL,
      tagId TEXT NOT NULL, createdAt INTEGER NOT NULL);
    CREATE UNIQUE INDEX idx_item_tags_unique ON item_tags(itemId, tagId);
    CREATE TABLE item_events (id TEXT PRIMARY KEY NOT NULL, itemId TEXT NOT NULL,
      content TEXT, value REAL, occurredAt INTEGER NOT NULL,
      metadata TEXT DEFAULT '{}', createdAt INTEGER NOT NULL);
  `;
  execSql(dbPath, schema);

  const now = Date.now();
  // Prefix-collision fixtures (ids sharing the `shared-` / `amb-` prefix
  // across the scope boundary) exercise scope-confined resolveItemId:
  //   shared-in  (peek)     + shared-out (untense)   → prefix `shared-` is
  //     ambiguous table-wide but unique IN scope.
  //   amb-a / amb-b (both peek) + amb-c (untense)    → prefix `amb-` is
  //     ambiguous IN scope (a,b); candidate list must NOT name amb-c.
  //   oos-1 (untense only)                            → prefix `oos-` / full
  //     id matches only an out-of-scope item → not-found from scoped view.
  const seed = `
    INSERT INTO items (id, type, content, title, createdAt, updatedAt) VALUES
      ('p-only', 'text', 'peek thing', 'P', ${now - 6000}, ${now - 6000}),
      ('p-sub',  'text', 'peek sub',   'PS', ${now - 5000}, ${now - 5000}),
      ('u-only', 'text', 'untense thing', 'U', ${now - 4000}, ${now - 4000}),
      ('u-sub',  'text', 'untense sub', 'US', ${now - 3000}, ${now - 3000}),
      ('cross',  'text', 'both',        'C', ${now - 2000}, ${now - 2000}),
      ('bare',   'text', 'no tags',     'B', ${now - 1000}, ${now - 1000}),
      ('shared-in',  'text', 'in scope',  'SharedIn',  ${now - 900}, ${now - 900}),
      ('shared-out', 'text', 'out scope', 'SharedOut', ${now - 800}, ${now - 800}),
      ('amb-a', 'text', 'amb in a', 'AmbA', ${now - 700}, ${now - 700}),
      ('amb-b', 'text', 'amb in b', 'AmbB', ${now - 600}, ${now - 600}),
      ('amb-c', 'text', 'amb out c', 'AmbOutTitle', ${now - 500}, ${now - 500}),
      ('oos-1', 'text', 'only out', 'OosOnly', ${now - 400}, ${now - 400});
    INSERT INTO tags (id, name, lastUsed, createdAt, updatedAt) VALUES
      ('t-p',  'peek',              ${now}, ${now}, ${now}),
      ('t-ps', 'peek:scope:desktop',${now}, ${now}, ${now}),
      ('t-u',  'untense',           ${now}, ${now}, ${now}),
      ('t-us', 'untense:todo',      ${now}, ${now}, ${now});
    INSERT INTO item_tags (id, itemId, tagId, createdAt) VALUES
      ('it-1', 'p-only', 't-p',  ${now}),
      ('it-2', 'p-sub',  't-ps', ${now}),
      ('it-3', 'u-only', 't-u',  ${now}),
      ('it-4', 'u-sub',  't-us', ${now}),
      ('it-5', 'cross',  't-p',  ${now}),
      ('it-6', 'cross',  't-u',  ${now}),
      ('it-7',  'shared-in',  't-p', ${now}),
      ('it-8',  'shared-out', 't-u', ${now}),
      ('it-9',  'amb-a', 't-p', ${now}),
      ('it-10', 'amb-b', 't-p', ${now}),
      ('it-11', 'amb-c', 't-u', ${now}),
      ('it-12', 'oos-1', 't-u', ${now});
  `;
  execSql(dbPath, seed);
  return dbPath;
}

describe('MCP Server scope enforcement (PEEK_MCP_SCOPE_TAG=peek)', () => {
  let dbPath;
  let client;

  before(async () => {
    dbPath = createScopedTestDb();
    client = new McpClient(dbPath, { PEEK_MCP_SCOPE_TAG: 'peek' });
    await client.start();
  });

  after(() => {
    client.stop();
    if (dbPath && existsSync(dbPath)) {
      try { unlinkSync(dbPath); } catch { /* ignore */ }
    }
  });

  describe('reads', () => {
    it('list_items hides foreign and untagged items', async () => {
      const items = await client.callTool('list_items', { limit: 100 });
      const ids = items.map((i) => i.id).sort();
      assert.deepEqual(ids, ['amb-a', 'amb-b', 'cross', 'p-only', 'p-sub', 'shared-in']);
    });

    it('list_items honors client tag filters within scope', async () => {
      const items = await client.callTool('list_items', { tags: ['peek:scope:desktop'] });
      assert.equal(items.length, 1);
      assert.equal(items[0].id, 'p-sub');
    });

    it('get_item returns null for out-of-scope id', async () => {
      const r = await client.callTool('get_item', { itemId: 'u-only' });
      assert.equal(r, null);
    });

    it('get_item returns null for untagged id', async () => {
      const r = await client.callTool('get_item', { itemId: 'bare' });
      assert.equal(r, null);
    });

    it('get_item returns in-scope item with all tags visible', async () => {
      const r = await client.callTool('get_item', { itemId: 'cross' });
      assert.ok(r);
      // The cross-cut item shows ALL its tags, including untense — agents
      // can see what a human chose to share, they just can't write it.
      assert.ok(r.tags.includes('peek'));
      assert.ok(r.tags.includes('untense'));
    });

    it('list_tags hides foreign namespaces', async () => {
      const tags = await client.callTool('list_tags', {});
      const names = tags.map((t) => t.name).sort();
      assert.deepEqual(names, ['peek', 'peek:scope:desktop']);
    });

    it('search_items never returns out-of-scope items', async () => {
      // "thing" appears in p-only ("peek thing"), u-only ("untense thing"),
      // and the bare/untagged items' content. Scoped search must surface only
      // the in-scope match (p-only) and hide the foreign + untagged ones.
      const results = await client.callTool('search_items', { query: 'thing' });
      const ids = results.map((r) => r.id).sort();
      assert.ok(ids.includes('p-only'), `expected in-scope match, got: ${ids.join(', ')}`);
      assert.ok(!ids.includes('u-only'), `out-of-scope item leaked: ${ids.join(', ')}`);
      assert.ok(!ids.includes('bare'), `untagged item leaked: ${ids.join(', ')}`);
    });
  });

  describe('scope-confined id-prefix resolution', () => {
    it('resolves a prefix that collides across the scope boundary to the in-scope item', async () => {
      // `shared-` matches shared-in (peek) AND shared-out (untense) table-wide,
      // but uniquely identifies shared-in from the scoped session's view.
      const item = await client.callTool('get_item', { itemId: 'shared-' });
      assert.ok(item, 'expected scoped resolution to pick the single in-scope match');
      assert.equal(item.id, 'shared-in');
    });

    it('ambiguous IN-scope prefix errors with only in-scope candidates (no out-of-scope leak)', async () => {
      // `amb-` matches amb-a + amb-b (both peek) and amb-c (untense). The error
      // must name the two in-scope items and NOT the out-of-scope one's id/title.
      const r = await client.callToolRaw('get_item', { itemId: 'amb-' });
      assert.equal(r.isError, true);
      const text = r.content[0].text;
      assert.match(text, /[Aa]mbiguous/);
      assert.match(text, /amb-a/);
      assert.match(text, /amb-b/);
      assert.ok(!text.includes('amb-c'), `out-of-scope id leaked: ${text}`);
      assert.ok(!text.includes('AmbOutTitle'), `out-of-scope title leaked: ${text}`);
    });

    it('a prefix matching only an out-of-scope item resolves to not-found (get_item → null)', async () => {
      const r = await client.callTool('get_item', { itemId: 'oos-' });
      assert.equal(r, null);
    });

    it('an exact full id matching only an out-of-scope item resolves to not-found', async () => {
      const r = await client.callTool('get_item', { itemId: 'oos-1' });
      assert.equal(r, null);
    });

    it('mutating tool on an out-of-scope-only prefix errors as not-found (no leak)', async () => {
      const r = await client.callToolRaw('update_item', { itemId: 'oos-', title: 'x' });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /No item found/);
      assert.ok(!r.content[0].text.includes('OosOnly'), `out-of-scope title leaked: ${r.content[0].text}`);
    });

    it('mutating tool resolves a cross-boundary-colliding prefix to the in-scope item', async () => {
      // `shared-` is unique in scope → update applies to shared-in only.
      const item = await client.callTool('update_item', { itemId: 'shared-', title: 'SharedIn renamed' });
      assert.equal(item.id, 'shared-in');
      assert.equal(item.title, 'SharedIn renamed');
    });
  });

  describe('writes', () => {
    it('create_item force-adds scope tag', async () => {
      const item = await client.callTool('create_item', {
        type: 'text', title: 'new', content: 'hi',
      });
      assert.ok(item.tags.includes('peek'));
    });

    it('create_item preserves bare shared tags', async () => {
      const item = await client.callTool('create_item', {
        type: 'text', title: 'todo', content: 'x', tags: ['todo'],
      });
      assert.ok(item.tags.includes('peek'));
      assert.ok(item.tags.includes('todo'));
    });

    it('create_item rejects foreign-namespace tags', async () => {
      const r = await client.callToolRaw('create_item', {
        type: 'text', title: 'leak', content: 'x', tags: ['untense:foo'],
      });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /outside scope/);
    });

    it('update_item refuses out-of-scope id (as not-found — no exists-but-out-of-scope leak)', async () => {
      // Scope-confined resolution makes an out-of-scope full id read as
      // not-found, indistinguishable from a truly missing id. The earlier
      // "not in scope" message confirmed the item existed, which was itself a
      // leak; "No item found" preserves indistinguishability.
      const r = await client.callToolRaw('update_item', {
        itemId: 'u-only', title: 'hijacked',
      });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /No item found/);
    });

    it('delete_item refuses out-of-scope id', async () => {
      const r = await client.callToolRaw('delete_item', { itemId: 'u-only' });
      assert.equal(r.isError, true);
    });

    it('untag_item refuses to remove the only scope tag (would orphan item)', async () => {
      // p-only carries just bare `peek`. Removing it would push the item
      // out of scope entirely.
      const r = await client.callToolRaw('untag_item', {
        itemId: 'p-only', tagName: 'peek',
      });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /only tag keeping this item in scope/);
    });

    it('untag_item allows removing a scope tag when other scope tags remain', async () => {
      // Build an item with TWO scope-owned tags (peek + peek:scope:desktop),
      // then untag one. Should succeed — the other keeps it in scope.
      // Regression for: parallel tag/untag swap, and bare-peek-plus-namespaced
      // case both refused even though removal was safe.
      const item = await client.callTool('create_item', {
        type: 'text', title: 'multi-scope', content: 'x',
        tags: ['peek:scope:desktop'],
      });
      assert.ok(item.tags.includes('peek'));
      assert.ok(item.tags.includes('peek:scope:desktop'));

      const r = await client.callToolRaw('untag_item', {
        itemId: item.id, tagName: 'peek:scope:desktop',
      });
      assert.notEqual(r.isError, true);

      const refetched = await client.callTool('get_item', { itemId: item.id });
      assert.ok(refetched.tags.includes('peek'));
      assert.ok(!refetched.tags.includes('peek:scope:desktop'));
    });

    it('untag_item refuses on out-of-scope id', async () => {
      const r = await client.callToolRaw('untag_item', {
        itemId: 'u-only', tagName: 'untense',
      });
      assert.equal(r.isError, true);
    });

    it('tag_item rejects foreign-namespace tag', async () => {
      const r = await client.callToolRaw('tag_item', {
        itemId: 'p-only', tagName: 'untense:foo',
      });
      assert.equal(r.isError, true);
    });

    it('record_event refuses on out-of-scope id', async () => {
      const r = await client.callToolRaw('record_event', {
        itemId: 'u-only', type: 'note', value: 'leak',
      });
      assert.equal(r.isError, true);
    });
  });

  describe('tasks', () => {
    it('list_tasks with no tags argument defaults to <scope>:todo, not bare todo', async () => {
      const task = await client.callTool('create_item', {
        type: 'text', title: 'scoped task', content: 'x', tags: ['peek:todo'],
      });
      const tasks = await client.callTool('list_tasks');
      const ids = tasks.map((t) => t.id);
      assert.ok(ids.includes(task.id));
      // p-only carries bare `peek` only, no status tag — must not appear.
      assert.ok(!ids.includes('p-only'));
    });

    it('complete_task with accepted omitted moves peek:todo to peek:needs-review, leaves it in the queue', async () => {
      const task = await client.callTool('create_item', {
        type: 'text', title: 'scoped review', content: 'x', tags: ['peek:todo'],
      });
      const result = await client.callTool('complete_task', { itemId: task.id, notes: 'ready for review' });
      assert.ok(result.tags.includes('peek:needs-review'));
      assert.ok(!result.tags.includes('peek:todo'));
      assert.ok(result.tags.includes('peek'));
      assert.ok(!result.tags.includes('done'));
      assert.ok(!result.tags.includes('peek:done'));
    });

    it('complete_task with accepted: true moves peek:todo straight to peek:done', async () => {
      const task = await client.callTool('create_item', {
        type: 'text', title: 'scoped approved', content: 'x', tags: ['peek:todo'],
      });
      const result = await client.callTool('complete_task', {
        itemId: task.id, notes: 'shipped', accepted: true,
      });
      assert.ok(result.tags.includes('peek:done'));
      assert.ok(!result.tags.includes('peek:todo'));
      assert.ok(!result.tags.includes('peek:needs-review'));
      assert.ok(!result.tags.includes('done'));
    });
  });
});

// --- Remote store content windowing (peek dc710276) ---
//
// Drives server.js as a real subprocess (like McpClient above) but against a
// fake HTTP `/mcp/*` server instead of a sqlite fixture, so this exercises
// the actual remote-store.js request path rather than a stub. The fake
// server's own windowing is a faithful copy of apps/server/mcp-items.js's
// windowContent() (default 4000, -1 = unlimited) — the point of these tests
// is that shapeItemForResponse() in server.js is the ONLY windowing that
// counts for the MCP tools now: remote-store.js always asks the fake server
// for the whole body (maxContentLength=-1), so the fake server's own default
// window is irrelevant to what the client sees.

function windowContentReplica(item, query) {
  if (typeof item.content !== 'string') return;
  let max = 4000;
  const rawMax = query.get('maxContentLength');
  if (rawMax !== null && rawMax !== '') {
    const n = Number(rawMax);
    if (Number.isFinite(n)) {
      if (n === -1) max = Infinity;
      else if (n >= 0) max = Math.floor(n);
    }
  }
  let offset = 0;
  const rawOffset = query.get('contentOffset');
  if (rawOffset !== null && rawOffset !== '') {
    const n = Number(rawOffset);
    if (Number.isFinite(n) && n > 0) offset = Math.floor(n);
  }
  const fullLength = item.content.length;
  item.contentLength = fullLength;
  const end = max === Infinity ? fullLength : Math.min(fullLength, offset + max);
  if (offset > 0 || end < fullLength) {
    item.content = item.content.slice(offset, Math.max(offset, end));
    item.contentTruncated = true;
  }
}

// items: Map<id, item>. Serves just enough of the `/mcp/*` surface for
// get_item/get_task_context: GET /mcp/session (startup scope check) and
// GET /mcp/items/:id (windowed the same way apps/server does).
function startFakeRemoteServer(items) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/mcp/session') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ scopeTag: '', readonly: false, profileId: 'default', datastoreVersion: 1 }));
      return;
    }
    const match = url.pathname.match(/^\/mcp\/items\/([^/]+)$/);
    if (req.method === 'GET' && match) {
      const id = decodeURIComponent(match[1]);
      const item = items.get(id);
      if (!item) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'item not found' }));
        return;
      }
      const out = { ...item };
      windowContentReplica(out, url.searchParams);
      if (url.searchParams.has('events')) out.events = item.events || [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ item: out }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

describe('MCP Server — remote store content windowing', () => {
  // 5000 chars, position-distinct so an offset slice is verifiable.
  const LONG_CONTENT = 'a'.repeat(4000) + 'b'.repeat(1000);
  let fakeServer;
  let client;

  before(async () => {
    fakeServer = await startFakeRemoteServer(new Map([
      ['remote-long', { id: 'remote-long', type: 'text', title: 'Remote Long', content: LONG_CONTENT, tags: [], events: [] }],
    ]));
    const { port } = fakeServer.address();
    // dbPath is unused in remote mode (main() never reads PEEK_DB_PATH once
    // PEEK_MCP_REMOTE_URL is set) — pass '' rather than leave it undefined,
    // which spawn() would reject as a non-string env value.
    client = new McpClient('', {
      PEEK_MCP_REMOTE_URL: `http://127.0.0.1:${port}`,
      PEEK_MCP_TOKEN: 'fake-remote-token',
    });
    await client.start();
  });

  after(async () => {
    client.stop();
    await new Promise((resolve) => fakeServer.close(resolve));
  });

  it('get_item: maxContentLength -1 returns the whole body with the true length, untruncated', async () => {
    const item = await client.callTool('get_item', { itemId: 'remote-long', maxContentLength: -1 });
    assert.equal(item.content, LONG_CONTENT);
    assert.equal(item.contentLength, LONG_CONTENT.length);
    assert.ok(!('contentTruncated' in item));
  });

  it('get_item: default call windows to 4000 chars but still reports the true 5000-char length', async () => {
    const item = await client.callTool('get_item', { itemId: 'remote-long' });
    assert.equal(item.content, LONG_CONTENT.slice(0, 4000));
    assert.equal(item.contentLength, LONG_CONTENT.length);
    assert.equal(item.contentTruncated, true);
  });

  it('get_item: contentOffset pages through the remote body past the default window', async () => {
    const item = await client.callTool('get_item', { itemId: 'remote-long', contentOffset: 4000 });
    assert.equal(item.content, LONG_CONTENT.slice(4000));
    assert.equal(item.content.length, 1000);
    assert.equal(item.contentLength, LONG_CONTENT.length);
    assert.equal(item.contentTruncated, true);
  });

  it('get_task_context: same windowing behavior as get_item over the remote store', async () => {
    const full = await client.callTool('get_task_context', { itemId: 'remote-long', maxContentLength: -1 });
    assert.equal(full.content, LONG_CONTENT);
    assert.equal(full.contentLength, LONG_CONTENT.length);
    assert.ok(!('contentTruncated' in full));

    const dflt = await client.callTool('get_task_context', { itemId: 'remote-long' });
    assert.equal(dflt.content, LONG_CONTENT.slice(0, 4000));
    assert.equal(dflt.contentLength, LONG_CONTENT.length);
    assert.equal(dflt.contentTruncated, true);

    const page = await client.callTool('get_task_context', { itemId: 'remote-long', contentOffset: 4000 });
    assert.equal(page.content, LONG_CONTENT.slice(4000));
    assert.equal(page.contentLength, LONG_CONTENT.length);
    assert.equal(page.contentTruncated, true);
  });
});

// --- Config drift detection ---

function spawnServerWithCwd(env, cwd) {
  // Isolate HOME to cwd so the drift check can't see the real user's
  // ~/.claude.json — keeps the test deterministic per machine.
  const proc = spawn('node', [SERVER_PATH], {
    env: { ...process.env, HOME: cwd, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
  });
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const started = new Promise((resolve) => {
    const onData = (chunk) => {
      if (chunk.toString().includes('started')) {
        proc.stderr.off('data', onData);
        resolve();
      }
    };
    proc.stderr.on('data', onData);
    setTimeout(resolve, 2000);
  });
  const exited = new Promise((resolve) => {
    proc.on('exit', (code) => resolve(code));
  });
  return { proc, started, exited, getStderr: () => stderr };
}

function expectExit(exited, ms) {
  return Promise.race([
    exited,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`did not exit within ${ms}ms`)), ms)),
  ]);
}

describe('MCP Server config drift detection', () => {
  it('exits when on-disk PEEK_MCP_SCOPE_TAG diverges from spawn env', async () => {
    const dbPath = createTestDb();
    const tmpProject = mkdtempSync(join(tmpdir(), 'peek-mcp-drift-'));
    const mcpJsonPath = join(tmpProject, '.mcp.json');
    writeFileSync(mcpJsonPath, JSON.stringify({
      mcpServers: { peek: { command: 'node', args: [SERVER_PATH],
        env: { PEEK_DB_PATH: dbPath, PEEK_MCP_SCOPE_TAG: 'foo' } } },
    }));

    const { proc, started, exited, getStderr } = spawnServerWithCwd(
      { PEEK_DB_PATH: dbPath, PEEK_MCP_SCOPE_TAG: 'foo' }, tmpProject,
    );
    await started;

    // Mutate .mcp.json to a different scope tag.
    writeFileSync(mcpJsonPath, JSON.stringify({
      mcpServers: { peek: { command: 'node', args: [SERVER_PATH],
        env: { PEEK_DB_PATH: dbPath, PEEK_MCP_SCOPE_TAG: 'bar' } } },
    }));

    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    }) + '\n');

    const code = await expectExit(exited, 3000);
    const stderr = getStderr();
    assert.equal(code, 0);
    assert.ok(stderr.includes('drift'), `stderr should mention drift, got: ${stderr}`);
    assert.ok(stderr.includes('SCOPE_TAG'), `stderr should mention SCOPE_TAG, got: ${stderr}`);
  });

  it('exits when peek entry is removed from settings', async () => {
    const dbPath = createTestDb();
    const tmpProject = mkdtempSync(join(tmpdir(), 'peek-mcp-drift-'));
    const mcpJsonPath = join(tmpProject, '.mcp.json');
    writeFileSync(mcpJsonPath, JSON.stringify({
      mcpServers: { peek: { command: 'node', args: [SERVER_PATH],
        env: { PEEK_DB_PATH: dbPath } } },
    }));

    const { proc, started, exited, getStderr } = spawnServerWithCwd(
      { PEEK_DB_PATH: dbPath }, tmpProject,
    );
    await started;

    // Remove the peek entry — simulates toggling MCP off in Settings.
    writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: {} }));

    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    }) + '\n');

    const code = await expectExit(exited, 3000);
    const stderr = getStderr();
    assert.equal(code, 0);
    assert.ok(stderr.includes('removed'), `stderr should mention removed, got: ${stderr}`);
  });

  it('does not exit when on-disk env matches spawn env', async () => {
    const dbPath = createTestDb();
    const tmpProject = mkdtempSync(join(tmpdir(), 'peek-mcp-drift-'));
    writeFileSync(join(tmpProject, '.mcp.json'), JSON.stringify({
      mcpServers: { peek: { command: 'node', args: [SERVER_PATH],
        env: { PEEK_DB_PATH: dbPath, PEEK_MCP_READONLY: '1' } } },
    }));

    const { proc, started, exited } = spawnServerWithCwd(
      { PEEK_DB_PATH: dbPath, PEEK_MCP_READONLY: '1' }, tmpProject,
    );
    await started;

    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    }) + '\n');

    // Should NOT exit within 500ms. Race exit against a timeout — timeout wins.
    const outcome = await Promise.race([
      exited.then(() => 'exited'),
      new Promise((resolve) => setTimeout(() => resolve('still-running'), 500)),
    ]);
    assert.equal(outcome, 'still-running');
    proc.kill();
  });

  it('does not exit when a mismatching entry resolves first but another entry matches', async () => {
    // Regression: two legitimate registrations coexist — a scoped project
    // .mcp.json (resolved FIRST) and a read-only user-scope ~/.claude.json.
    // We were spawned from the read-only one. The old "compare against the
    // first-resolved file" logic saw the scoped .mcp.json, declared drift,
    // and exit(0)'d on connect → client "can't connect". Match-any must keep
    // us alive because SOME on-disk entry agrees with our spawn env.
    const dbPath = createTestDb();
    const tmpProject = mkdtempSync(join(tmpdir(), 'peek-mcp-drift-'));
    // Resolved first: scoped, writable — does NOT match our spawn env.
    writeFileSync(join(tmpProject, '.mcp.json'), JSON.stringify({
      mcpServers: { peek: { command: 'node', args: [SERVER_PATH],
        env: { PEEK_DB_PATH: dbPath, PEEK_MCP_SCOPE_TAG: 'peek' } } },
    }));
    // HOME is isolated to tmpProject, so ~/.claude.json IS the user-scope
    // candidate (top-level mcpServers, exactly how Claude Code stores it).
    writeFileSync(join(tmpProject, '.claude.json'), JSON.stringify({
      mcpServers: { peek: { command: 'node', args: [SERVER_PATH],
        env: { PEEK_DB_PATH: dbPath, PEEK_MCP_READONLY: '1' } } },
    }));

    // Spawned from the read-only registration.
    const { proc, started, exited } = spawnServerWithCwd(
      { PEEK_DB_PATH: dbPath, PEEK_MCP_READONLY: '1' }, tmpProject,
    );
    await started;

    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    }) + '\n');

    const outcome = await Promise.race([
      exited.then(() => 'exited'),
      new Promise((resolve) => setTimeout(() => resolve('still-running'), 500)),
    ]);
    assert.equal(outcome, 'still-running');
    proc.kill();
  });

  it('does not exit for a user-scope entry matched only in ~/.claude.json', async () => {
    // The exact bug this change fixes: a global/user-scope registration
    // (default DB, no readonly, no scope) lives in ~/.claude.json — the
    // location Claude Code actually reads. The drift check must walk
    // ~/.claude.json (top-level mcpServers) and see the match, NOT exit.
    // Before the fix it walked ~/.claude/settings.json (which Peek never
    // wrote and Claude Code never read), found no matching entry, and killed
    // a perfectly good server → agents in other projects "can't connect".
    const dbPath = createTestDb();
    const tmpProject = mkdtempSync(join(tmpdir(), 'peek-mcp-drift-'));
    // HOME is isolated to tmpProject → this is ~/.claude.json.
    writeFileSync(join(tmpProject, '.claude.json'), JSON.stringify({
      mcpServers: { peek: { command: 'node', args: [SERVER_PATH],
        env: { PEEK_DB_PATH: dbPath } } },
    }));

    const { proc, started, exited } = spawnServerWithCwd(
      { PEEK_DB_PATH: dbPath }, tmpProject,
    );
    await started;

    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    }) + '\n');

    const outcome = await Promise.race([
      exited.then(() => 'exited'),
      new Promise((resolve) => setTimeout(() => resolve('still-running'), 500)),
    ]);
    assert.equal(outcome, 'still-running');
    proc.kill();
  });
});

// --- Remote store selection, credential resolution, startup consistency ---
//
// Pure-function coverage for main()'s remote/local branch (design doc §6)
// and the startup scope check (§4.3) — no subprocess, no network. server.js
// only self-invokes main() when run directly (the import.meta.url guard at
// the bottom of the file), so importing its exports here is side-effect-free.

// Sets `process.env[key]` for each key in `vars` (deleting it when the value
// is `undefined`), runs `fn`, then restores every touched key to its prior
// value/absence — even if `fn` throws.
function withEnv(vars, fn) {
  const keys = Object.keys(vars);
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  for (const k of keys) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

const FAKE_REMOTE_URL = 'https://sync.example.test';

describe('remoteStoreConfig() — remote/local selection (design doc §6)', () => {
  it('returns null (local fallback) when PEEK_MCP_REMOTE_URL is unset', () => {
    withEnv({ PEEK_MCP_REMOTE_URL: undefined, PEEK_MCP_TOKEN: undefined, PEEK_MCP_CREDENTIAL: undefined }, () => {
      assert.equal(remoteStoreConfig(), null);
    });
  });

  it('carries PEEK_MCP_TOKEN through as the credential when PEEK_MCP_CREDENTIAL is unset', () => {
    withEnv({
      PEEK_MCP_REMOTE_URL: FAKE_REMOTE_URL,
      PEEK_MCP_TOKEN: 'fake-direct-token-do-not-use',
      PEEK_MCP_CREDENTIAL: undefined,
    }, () => {
      assert.deepEqual(remoteStoreConfig(), {
        remoteUrl: FAKE_REMOTE_URL,
        credential: 'fake-direct-token-do-not-use',
      });
    });
  });

  it('PEEK_MCP_CREDENTIAL resolves the token from the credential file, taking priority over PEEK_MCP_TOKEN', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'peek-mcp-cred-'));
    const credDir = join(tmpHome, '.config', 'peek');
    mkdirSync(credDir, { recursive: true });
    const key = `${FAKE_REMOTE_URL}#peek`;
    writeFileSync(join(credDir, 'mcp-credentials.json'), JSON.stringify({
      credentials: { [key]: { token: 'fake-file-token-do-not-use', label: 'test' } },
    }));

    withEnv({
      HOME: tmpHome,
      PEEK_MCP_REMOTE_URL: FAKE_REMOTE_URL,
      PEEK_MCP_TOKEN: 'fake-should-be-ignored',
      PEEK_MCP_CREDENTIAL: key,
    }, () => {
      assert.equal(credentialFilePath(), join(tmpHome, '.config', 'peek', 'mcp-credentials.json'));
      assert.deepEqual(remoteStoreConfig(), {
        remoteUrl: FAKE_REMOTE_URL,
        credential: 'fake-file-token-do-not-use',
      });
    });
  });

  it('errors clearly (naming the key, not any secret) when the key is not in the credential file', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'peek-mcp-cred-'));
    mkdirSync(join(tmpHome, '.config', 'peek'), { recursive: true });
    writeFileSync(join(tmpHome, '.config', 'peek', 'mcp-credentials.json'), JSON.stringify({ credentials: {} }));

    withEnv({ HOME: tmpHome }, () => {
      assert.throws(
        () => resolveCredentialFromFile(`${FAKE_REMOTE_URL}#missing`),
        /No credential found for key/,
      );
    });
  });

  it('errors clearly when the credential file does not exist', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'peek-mcp-cred-'));
    withEnv({ HOME: tmpHome }, () => {
      assert.throws(
        () => resolveCredentialFromFile(`${FAKE_REMOTE_URL}#peek`),
        /Could not read Peek MCP credential file/,
      );
    });
  });

  // Trailing-slash / whitespace drift between the install-time --remote url
  // and the later-exported PEEK_SYNC_URL is invisible on the HTTP side
  // (openRemoteStore() normalizes its base url the same way) but used to
  // throw here on a plain object-property lookup. credential-key.js's
  // normalization must agree with openRemoteStore()'s so all three sides —
  // write, HTTP, lookup — land on the same key.
  it('resolves a key whose url differs only by a trailing slash', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'peek-mcp-cred-'));
    const credDir = join(tmpHome, '.config', 'peek');
    mkdirSync(credDir, { recursive: true });
    const storedKey = `${FAKE_REMOTE_URL}#peek`; // normalized, as a fresh write produces
    writeFileSync(join(credDir, 'mcp-credentials.json'), JSON.stringify({
      credentials: { [storedKey]: { token: 'fake-slash-token', label: 'test' } },
    }));

    withEnv({ HOME: tmpHome }, () => {
      assert.equal(resolveCredentialFromFile(`${FAKE_REMOTE_URL}/#peek`), 'fake-slash-token');
    });
  });

  it('resolves a key whose url differs only by surrounding whitespace', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'peek-mcp-cred-'));
    const credDir = join(tmpHome, '.config', 'peek');
    mkdirSync(credDir, { recursive: true });
    const storedKey = `${FAKE_REMOTE_URL}#peek`;
    writeFileSync(join(credDir, 'mcp-credentials.json'), JSON.stringify({
      credentials: { [storedKey]: { token: 'fake-whitespace-token', label: 'test' } },
    }));

    withEnv({ HOME: tmpHome }, () => {
      assert.equal(resolveCredentialFromFile(`  ${FAKE_REMOTE_URL}  #peek`), 'fake-whitespace-token');
    });
  });

  it('still resolves a pre-existing raw (unnormalized) key, unchanged, for backward compatibility', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'peek-mcp-cred-'));
    const credDir = join(tmpHome, '.config', 'peek');
    mkdirSync(credDir, { recursive: true });
    // Simulates a file written before normalization existed: the raw url
    // (trailing slash and all) baked straight into the stored key.
    const rawKey = `${FAKE_REMOTE_URL}/#peek`;
    writeFileSync(join(credDir, 'mcp-credentials.json'), JSON.stringify({
      credentials: { [rawKey]: { token: 'fake-raw-token', label: 'test' } },
    }));

    withEnv({ HOME: tmpHome }, () => {
      // Lookup key matches the stored raw key exactly (no drift) — the
      // normalized lookup misses (it strips the slash), so this only
      // resolves via the raw fallback.
      assert.equal(resolveCredentialFromFile(rawKey), 'fake-raw-token');
    });
  });

  it('not-found error lists the keys the file DOES contain, and never a token value', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'peek-mcp-cred-'));
    const credDir = join(tmpHome, '.config', 'peek');
    mkdirSync(credDir, { recursive: true });
    const presentKey = `${FAKE_REMOTE_URL}#other-scope`;
    const secretToken = 'fake-secret-must-not-leak-into-error';
    writeFileSync(join(credDir, 'mcp-credentials.json'), JSON.stringify({
      credentials: { [presentKey]: { token: secretToken, label: 'test' } },
    }));

    withEnv({ HOME: tmpHome }, () => {
      try {
        resolveCredentialFromFile(`${FAKE_REMOTE_URL}#missing-scope`);
        assert.fail('expected resolveCredentialFromFile to throw');
      } catch (err) {
        assert.match(err.message, /No credential found for key/);
        assert.ok(err.message.includes(presentKey), `expected error to list ${presentKey}, got: ${err.message}`);
        assert.ok(!err.message.includes(secretToken), `token value leaked into error: ${err.message}`);
      }
    });
  });
});

describe('scopeConsistencyError() — startup consistency check (design doc §4.3)', () => {
  it('returns null when the store scope agrees with the local configuration', () => {
    assert.equal(scopeConsistencyError({ scopeTag: 'peek' }, 'peek'), null);
  });

  it('returns null when both are unscoped', () => {
    assert.equal(scopeConsistencyError({ scopeTag: '' }, ''), null);
  });

  it('names both values when they disagree, without silently serving the mismatched session', () => {
    const msg = scopeConsistencyError({ scopeTag: 'remote-scope' }, 'local-scope');
    assert.match(msg, /remote-scope/);
    assert.match(msg, /local-scope/);
    assert.match(msg, /mismatch/i);
  });
});

describe('entryEnvMatchesCurrent() — remote keys (design doc §4.3)', () => {
  it('matches when scope/readonly/remoteUrl/credential all agree, ignoring PEEK_DB_PATH', () => {
    withEnv({
      PEEK_MCP_SCOPE_TAG: 'peek',
      PEEK_MCP_READONLY: undefined,
      PEEK_MCP_REMOTE_URL: FAKE_REMOTE_URL,
      PEEK_MCP_CREDENTIAL: `${FAKE_REMOTE_URL}#peek`,
      PEEK_DB_PATH: undefined,
    }, () => {
      const entry = {
        env: {
          PEEK_MCP_SCOPE_TAG: 'peek',
          PEEK_MCP_REMOTE_URL: FAKE_REMOTE_URL,
          PEEK_MCP_CREDENTIAL: `${FAKE_REMOTE_URL}#peek`,
        },
      };
      assert.equal(entryEnvMatchesCurrent(entry), true);
    });
  });

  it('does not match when the on-disk remote url/credential differ', () => {
    withEnv({
      PEEK_MCP_SCOPE_TAG: 'peek',
      PEEK_MCP_REMOTE_URL: FAKE_REMOTE_URL,
      PEEK_MCP_CREDENTIAL: `${FAKE_REMOTE_URL}#peek`,
    }, () => {
      const entry = {
        env: {
          PEEK_MCP_SCOPE_TAG: 'peek',
          PEEK_MCP_REMOTE_URL: 'https://sync.other.test',
          PEEK_MCP_CREDENTIAL: 'https://sync.other.test#peek',
        },
      };
      assert.equal(entryEnvMatchesCurrent(entry), false);
    });
  });

  it('treats a remote current session against a local-mode on-disk entry as a mismatch', () => {
    withEnv({
      PEEK_MCP_SCOPE_TAG: 'peek',
      PEEK_MCP_REMOTE_URL: FAKE_REMOTE_URL,
      PEEK_MCP_CREDENTIAL: `${FAKE_REMOTE_URL}#peek`,
    }, () => {
      const entry = { env: { PEEK_MCP_SCOPE_TAG: 'peek', PEEK_DB_PATH: '/some/path/datastore.sqlite' } };
      assert.equal(entryEnvMatchesCurrent(entry), false);
    });
  });

  it('local mode still compares PEEK_DB_PATH exactly as before', () => {
    withEnv({
      PEEK_MCP_SCOPE_TAG: undefined,
      PEEK_MCP_REMOTE_URL: undefined,
      PEEK_MCP_CREDENTIAL: undefined,
      PEEK_DB_PATH: '/a/datastore.sqlite',
    }, () => {
      assert.equal(entryEnvMatchesCurrent({ env: { PEEK_DB_PATH: '/a/datastore.sqlite' } }), true);
      assert.equal(entryEnvMatchesCurrent({ env: { PEEK_DB_PATH: '/b/datastore.sqlite' } }), false);
    });
  });

  // Every case above uses literal on-disk values, but setup.js writes a
  // ${PEEK_SYNC_URL} reference for every remote install and the client expands
  // it before spawning. Comparing the reference text against the expanded value
  // can never match, so a correctly scaffolded project used to fail the drift
  // check on every spawn and exit in a loop.
  it('matches a scaffolded entry whose remote url and credential are ${...} references', () => {
    withEnv({
      PEEK_MCP_SCOPE_TAG: 'peek',
      PEEK_MCP_READONLY: undefined,
      PEEK_MCP_REMOTE_URL: FAKE_REMOTE_URL,
      PEEK_MCP_CREDENTIAL: `${FAKE_REMOTE_URL}#peek`,
      PEEK_DB_PATH: undefined,
    }, () => {
      const entry = {
        env: {
          PEEK_MCP_SCOPE_TAG: 'peek',
          PEEK_MCP_REMOTE_URL: '${PEEK_SYNC_URL}',
          PEEK_MCP_CREDENTIAL: '${PEEK_SYNC_URL}#peek',
        },
      };
      assert.equal(entryEnvMatchesCurrent(entry), true);
    });
  });

  it('a reference in the url does not excuse a scope that really did drift', () => {
    withEnv({
      PEEK_MCP_SCOPE_TAG: 'peek',
      PEEK_MCP_REMOTE_URL: FAKE_REMOTE_URL,
      PEEK_MCP_CREDENTIAL: `${FAKE_REMOTE_URL}#peek`,
    }, () => {
      const entry = {
        env: {
          PEEK_MCP_SCOPE_TAG: 'other-scope',
          PEEK_MCP_REMOTE_URL: '${PEEK_SYNC_URL}',
          PEEK_MCP_CREDENTIAL: '${PEEK_SYNC_URL}#other-scope',
        },
      };
      assert.equal(entryEnvMatchesCurrent(entry), false);
    });
  });
});
