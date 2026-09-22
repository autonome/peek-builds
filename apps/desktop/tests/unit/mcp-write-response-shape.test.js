/**
 * create_item / update_item / complete_task must return through the same
 * shapeItemForResponse() shaping get_item already uses (server.js): no
 * favicon, content windowed with contentLength/contentTruncated, and the
 * window params (maxContentLength/contentOffset) must never reach the
 * store write itself.
 *
 * Self-contained — does NOT import server.test.js (its describe blocks
 * would register in this file's run). Replicates that file's McpClient
 * harness: spawn `node server.js` with PEEK_DB_PATH at a temp sqlite file,
 * HOME + cwd set to a fresh temp dir (so checkConfigDrift() can't see a
 * real .mcp.json / ~/.claude.json), wait for "started" on stderr, speak
 * newline-delimited JSON-RPC over stdio.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_PATH = join(__dirname, '..', '..', 'features', 'mcp-server', 'server.js');

const FAVICON = 'data:image/png;base64,iVBORw0KGgo=';

// 9000 position-distinct chars: 'a'*4000 + 'b'*4000 + 'c'*1000.
function longContent() {
  return 'a'.repeat(4000) + 'b'.repeat(4000) + 'c'.repeat(1000);
}

function execSql(dbPath, sql) {
  const conn = new DatabaseSync(dbPath);
  try {
    conn.exec(sql);
  } finally {
    conn.close();
  }
}

function selectContent(dbPath, id) {
  const conn = new DatabaseSync(dbPath);
  try {
    const row = conn.prepare('SELECT content FROM items WHERE id = ?').get(id);
    return row ? row.content : undefined;
  } finally {
    conn.close();
  }
}

function selectTagNames(dbPath, id) {
  const conn = new DatabaseSync(dbPath);
  try {
    return conn.prepare(`
      SELECT t.name FROM tags t
      JOIN item_tags it ON it.tagId = t.id
      WHERE it.itemId = ?
    `).all(id).map((r) => r.name);
  } finally {
    conn.close();
  }
}

function createTestDb() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'peek-mcp-write-shape-'));
  const dbPath = join(tmpDir, 'test.sqlite');

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

  const now = Date.now();
  const long = longContent();
  const seed = `
    INSERT INTO items (id, type, content, title, domain, metadata, favicon, createdAt, updatedAt, deletedAt)
    VALUES
      ('item-long', 'text', '${long}', 'Long item', '', '{}', '${FAVICON}', ${now - 3000}, ${now - 3000}, 0),
      ('item-task', 'text', '${long}', 'Task item', '', '{}', '${FAVICON}', ${now - 2000}, ${now - 2000}, 0),
      ('item-null', 'text', NULL, 'Null-content item', '', '{}', '${FAVICON}', ${now - 1000}, ${now - 1000}, 0);

    INSERT INTO tags (id, name, frequency, lastUsed, frecencyScore, createdAt, updatedAt)
    VALUES
      ('tag-todo', 'todo', 1, ${now}, 10.0, ${now}, ${now}),
      ('tag-done', 'done', 1, ${now}, 5.0, ${now}, ${now});

    INSERT INTO item_tags (id, itemId, tagId, createdAt)
    VALUES
      ('it-1', 'item-long', 'tag-todo', ${now}),
      ('it-2', 'item-task', 'tag-todo', ${now});
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
      // user's .mcp.json / ~/.claude.json.
      this.tmpCwd = mkdtempSync(join(tmpdir(), 'peek-mcp-write-shape-cwd-'));
      // Start from the invoking shell's env, but strip anything that could
      // flip the server into scoped, read-only, or remote mode out from
      // under this test.
      const env = { ...process.env };
      delete env.PEEK_MCP_SCOPE_TAG;
      delete env.PEEK_MCP_READONLY;
      delete env.PEEK_MCP_REMOTE_URL;
      delete env.PEEK_MCP_CREDENTIAL;

      this.proc = spawn('node', [SERVER_PATH], {
        env: { ...env, HOME: this.tmpCwd, PEEK_DB_PATH: this.dbPath, ...this.extraEnv },
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

describe('MCP write-tool response shape (create_item / update_item / complete_task)', () => {
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

  describe('create_item', () => {
    it('windows a long content by default and stores the full string', async () => {
      const item = await client.callTool('create_item', { type: 'text', content: longContent() });
      assert.ok(!('favicon' in item));
      assert.equal(item.content, 'a'.repeat(4000));
      assert.equal(item.contentLength, 9000);
      assert.equal(item.contentTruncated, true);
      assert.equal(selectContent(dbPath, item.id), longContent());
    });

    it('does not window or truncate short content', async () => {
      const item = await client.callTool('create_item', { type: 'text', content: 'hello' });
      assert.ok(!('favicon' in item));
      assert.equal(item.content, 'hello');
      assert.equal(item.contentLength, 5);
      assert.ok(!('contentTruncated' in item));
    });

    it('maxContentLength: -1 returns the whole content, stored full either way', async () => {
      const item = await client.callTool('create_item', {
        type: 'text', content: longContent(), maxContentLength: -1,
      });
      assert.equal(item.content, longContent());
      assert.ok(!('contentTruncated' in item));
      assert.equal(selectContent(dbPath, item.id), longContent());
    });

    it('contentOffset + maxContentLength page into the content, store keeps the full string', async () => {
      const item = await client.callTool('create_item', {
        type: 'text', content: longContent(), contentOffset: 3998, maxContentLength: 4,
      });
      assert.equal(item.content, 'aabb');
      assert.equal(item.contentTruncated, true);
      assert.equal(selectContent(dbPath, item.id), longContent());
    });
  });

  describe('update_item', () => {
    it('title-only patch still shapes the (unchanged) content window', async () => {
      const item = await client.callTool('update_item', { itemId: 'item-long', title: 'New title' });
      assert.ok(!('favicon' in item));
      assert.equal(item.content, 'a'.repeat(4000));
      assert.equal(item.contentLength, 9000);
      assert.equal(item.contentTruncated, true);
    });

    it('maxContentLength: -1 returns the whole content', async () => {
      const item = await client.callTool('update_item', { itemId: 'item-long', maxContentLength: -1 });
      assert.equal(item.content, longContent());
      assert.ok(!('contentTruncated' in item));
    });

    it('a content patch together with maxContentLength windows the response but stores the full new string', async () => {
      const newContent = 'x'.repeat(4000) + 'y'.repeat(4000) + 'z'.repeat(1000);
      const item = await client.callTool('update_item', {
        itemId: 'item-long', content: newContent, maxContentLength: 10,
      });
      assert.equal(item.content, newContent.slice(0, 10));
      assert.equal(selectContent(dbPath, 'item-long'), newContent);
    });

    it('NULL content stays null, with no length/truncation/favicon fields', async () => {
      const item = await client.callTool('update_item', { itemId: 'item-null', title: 'Renamed' });
      assert.equal(item.content, null);
      assert.ok(!('favicon' in item));
      assert.ok(!('contentLength' in item));
      assert.ok(!('contentTruncated' in item));
    });
  });

  describe('complete_task', () => {
    it('shapes the response like get_item and swaps todo -> done', async () => {
      const item = await client.callTool('complete_task', { itemId: 'item-task', notes: 'done' });
      assert.ok(item.tags.includes('done'));
      assert.ok(!item.tags.includes('todo'));
      assert.ok(!('favicon' in item));
      assert.equal(item.content, 'a'.repeat(4000));
      assert.equal(item.contentLength, 9000);
      assert.equal(item.contentTruncated, true);
    });

    it('maxContentLength: -1 returns the whole content', async () => {
      const item = await client.callTool('complete_task', { itemId: 'item-task', maxContentLength: -1 });
      assert.equal(item.content, longContent());
      assert.ok(!('contentTruncated' in item));
    });
  });
});
