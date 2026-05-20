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
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_PATH = join(__dirname, 'server.js');

// --- Test helpers ---

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

  execSync(`sqlite3 "${dbPath}"`, { input: schema, encoding: 'utf-8' });

  // Seed test data
  const now = Date.now();
  const seed = `
    INSERT INTO items (id, type, content, title, domain, metadata, createdAt, updatedAt, deletedAt)
    VALUES
      ('item-1', 'url', 'https://example.com', 'Example', 'example.com', '{}', ${now - 3000}, ${now - 3000}, 0),
      ('item-2', 'text', 'Buy groceries', 'Shopping list', '', '{}', ${now - 2000}, ${now - 2000}, 0),
      ('item-3', 'url', 'https://test.com', 'Test Page', 'test.com', '{}', ${now - 1000}, ${now - 1000}, 0),
      ('item-deleted', 'text', 'Deleted note', 'Gone', '', '{}', ${now - 500}, ${now - 500}, ${now});

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

  execSync(`sqlite3 "${dbPath}"`, { input: seed, encoding: 'utf-8' });

  return dbPath;
}

class McpClient {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.proc = null;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.proc = spawn('node', [SERVER_PATH], {
        env: { ...process.env, PEEK_DB_PATH: this.dbPath },
        stdio: ['pipe', 'pipe', 'pipe'],
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
      const items = await client.callTool('list_items');
      assert.ok(Array.isArray(items));
      assert.equal(items.length, 3);
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

  describe('get_item', () => {
    it('should return item with tags', async () => {
      const item = await client.callTool('get_item', { id: 'item-2' });
      assert.equal(item.id, 'item-2');
      assert.equal(item.title, 'Shopping list');
      assert.ok(Array.isArray(item.tags));
      assert.ok(item.tags.includes('todo'));
      assert.ok(item.tags.includes('peek'));
    });

    it('should return null for nonexistent item', async () => {
      const item = await client.callTool('get_item', { id: 'nonexistent' });
      assert.equal(item, null);
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
        id: 'item-1',
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
      const result = await client.callTool('delete_item', { id: created.id });
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
      let item = await client.callTool('get_item', { id: 'item-1' });
      assert.ok(item.tags.includes('important'));

      // Untag
      await client.callTool('untag_item', { itemId: 'item-1', tagName: 'important' });
      item = await client.callTool('get_item', { id: 'item-1' });
      assert.ok(!item.tags.includes('important'));
    });

    it('should apply an existing tag to a second item without ON CONFLICT error', async () => {
      // 'todo' already exists in the tags table (seeded). Applying it to item-3
      // exercises the ON CONFLICT(name) DO UPDATE path in tagItemInTx.
      // Regression guard for: "ON CONFLICT clause does not match any PRIMARY KEY
      // or UNIQUE constraint" (requires CREATE UNIQUE INDEX on tags.name).
      const result = await client.callTool('tag_item', { itemId: 'item-3', tagName: 'todo' });
      assert.equal(result.success, true);
      const item = await client.callTool('get_item', { id: 'item-3' });
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
        id: task.id,
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

      const ctx = await client.callTool('get_task_context', { id: 'item-2' });
      assert.equal(ctx.id, 'item-2');
      assert.ok(Array.isArray(ctx.events));
      assert.ok(ctx.events.length >= 1);
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
  // backend/electron/datastore.ts. If datastore.ts changes the formulas
  // or rules, these tests will keep passing while the app diverges —
  // they're a lower bar than true integration. The schema-drift test
  // (schema-drift.test.js) covers the structural side.
  describe('policy parity with datastore.ts', () => {
    it('sets slug on new tags (lowercase, hyphens for whitespace)', async () => {
      await client.callTool('tag_item', { itemId: 'item-1', tagName: 'Big Project' });
      // Inspect the raw row — list_tags doesn't expose slug.
      const dbInspect = execSync(`sqlite3 -json "${client.dbPath}"`, {
        input: `SELECT name, slug FROM tags WHERE name = 'Big Project';`,
        encoding: 'utf-8',
      });
      const rows = JSON.parse(dbInspect.trim());
      assert.equal(rows[0].slug, 'big-project');
    });

    it('writes non-zero frecencyScore when tagging', async () => {
      await client.callTool('tag_item', { itemId: 'item-1', tagName: 'fresh-tag' });
      const dbInspect = execSync(`sqlite3 -json "${client.dbPath}"`, {
        input: `SELECT frequency, frecencyScore FROM tags WHERE name = 'fresh-tag';`,
        encoding: 'utf-8',
      });
      const rows = JSON.parse(dbInspect.trim());
      // calculateTagFrecency(1, now) with daysSinceUse≈0 ≈ 10 * 1 = 10
      assert.equal(rows[0].frequency, 1);
      assert.equal(rows[0].frecencyScore, 10);
    });

    it('bumps frecencyScore on subsequent tag uses', async () => {
      await client.callTool('tag_item', { itemId: 'item-1', tagName: 'reuse-tag' });
      await client.callTool('tag_item', { itemId: 'item-3', tagName: 'reuse-tag' });
      const dbInspect = execSync(`sqlite3 -json "${client.dbPath}"`, {
        input: `SELECT frequency, frecencyScore FROM tags WHERE name = 'reuse-tag';`,
        encoding: 'utf-8',
      });
      const rows = JSON.parse(dbInspect.trim());
      assert.equal(rows[0].frequency, 2);
      assert.equal(rows[0].frecencyScore, 20);
    });

    it('auto-extracts #hashtags from text item content', async () => {
      const item = await client.callTool('create_item', {
        type: 'text',
        title: 'Note',
        content: 'meeting with #alice about the #project',
      });
      assert.ok(item.tags.includes('alice'));
      assert.ok(item.tags.includes('project'));
    });

    it('does not extract hashtags from url-type items', async () => {
      const item = await client.callTool('create_item', {
        type: 'url',
        url: 'https://example.com/#fragment',
        title: 'Page',
      });
      // The URL fragment is `fragment` — would be picked up by the
      // hashtag regex on text. For url-type, content is the URL and
      // we deliberately skip extraction (matches datastore.ts which
      // only calls syncContentHashtags on text items).
      assert.ok(!item.tags.includes('fragment'));
    });
  });
});
