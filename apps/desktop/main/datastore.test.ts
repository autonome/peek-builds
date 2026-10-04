/**
 * Integration tests for Desktop (Electron) datastore
 * Tests the unified data model with url, text, tagset, image types
 * and sync columns (syncId, syncedAt)
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Test with a temporary database
const TEST_DB_PATH = path.join(__dirname, 'test-peek.db');

// Import will be done after build
let datastore: typeof import('./datastore.js');

describe('Desktop Datastore Tests', () => {
  before(async () => {
    // Clean up any existing test db
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    // Dynamic import of the compiled module
    datastore = await import('./datastore.js');
    datastore.initDatabase(TEST_DB_PATH);
  });

  after(() => {
    datastore.closeDatabase();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    // Clean up WAL files
    const walPath = TEST_DB_PATH + '-wal';
    const shmPath = TEST_DB_PATH + '-shm';
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
  });

  describe('Item Type Constants', () => {
    it('should support url, text, tagset, image types in schema', () => {
      const db = datastore.getDb();
      // Query the check constraint from the schema
      const result = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='items'"
      ).get() as { sql: string };

      assert.ok(result.sql.includes("'url'"), 'Schema should include url type');
      assert.ok(result.sql.includes("'text'"), 'Schema should include text type');
      assert.ok(result.sql.includes("'tagset'"), 'Schema should include tagset type');
      assert.ok(result.sql.includes("'image'"), 'Schema should include image type');
    });
  });

  describe('Sync Columns Schema', () => {
    it('should have syncId column', () => {
      const db = datastore.getDb();
      const columns = db.prepare("PRAGMA table_info(items)").all() as { name: string }[];
      const columnNames = columns.map((col) => col.name);

      assert.ok(columnNames.includes('syncId'), 'Should have syncId column');
    });

    it('should have syncedAt column', () => {
      const db = datastore.getDb();
      const columns = db.prepare("PRAGMA table_info(items)").all() as { name: string }[];
      const columnNames = columns.map((col) => col.name);

      assert.ok(columnNames.includes('syncedAt'), 'Should have syncedAt column');
    });

    it('should have syncId index', () => {
      const db = datastore.getDb();
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='items'"
      ).all() as { name: string }[];
      const indexNames = indexes.map((idx) => idx.name);

      assert.ok(indexNames.includes('idx_items_syncId'), 'Should have idx_items_syncId index');
    });
  });

  describe('addItem with url type', () => {
    it('should save a url item', () => {
      const result = datastore.addItem('url', { content: 'https://example.com' });
      assert.ok(result.id, 'Should return an id');
      assert.ok(result.id.startsWith('item_'), 'ID should have item_ prefix');
    });

    it('should retrieve url item with correct type', () => {
      const { id } = datastore.addItem('url', { content: 'https://test.com' });
      const item = datastore.getItem(id);

      assert.ok(item, 'Should find the item');
      assert.strictEqual(item!.type, 'url');
      assert.strictEqual(item!.content, 'https://test.com');
    });
  });

  describe('addItem with text type', () => {
    it('should save a text item', () => {
      const result = datastore.addItem('text', { content: 'My note content' });
      assert.ok(result.id, 'Should return an id');
    });

    it('should retrieve text item with correct type', () => {
      const { id } = datastore.addItem('text', { content: 'Another note' });
      const item = datastore.getItem(id);

      assert.ok(item, 'Should find the item');
      assert.strictEqual(item!.type, 'text');
      assert.strictEqual(item!.content, 'Another note');
    });
  });

  describe('addItem with tagset type', () => {
    it('should save a tagset item', () => {
      const result = datastore.addItem('tagset', {});
      assert.ok(result.id, 'Should return an id');
    });

    it('should retrieve tagset item with correct type', () => {
      const { id } = datastore.addItem('tagset', {});
      const item = datastore.getItem(id);

      assert.ok(item, 'Should find the item');
      assert.strictEqual(item!.type, 'tagset');
    });
  });

  describe('addItem with image type', () => {
    it('should save an image item', () => {
      const result = datastore.addItem('image', { mimeType: 'image/png' });
      assert.ok(result.id, 'Should return an id');
    });

    it('should retrieve image item with correct type', () => {
      const { id } = datastore.addItem('image', { mimeType: 'image/jpeg' });
      const item = datastore.getItem(id);

      assert.ok(item, 'Should find the item');
      assert.strictEqual(item!.type, 'image');
    });
  });

  describe('queryItems by type', () => {
    beforeEach(() => {
      // Clean items for each test
      const db = datastore.getDb();
      db.exec('DELETE FROM item_tags');
      db.exec('DELETE FROM items');
    });

    it('should filter items by url type', () => {
      datastore.addItem('url', { content: 'https://example1.com' });
      datastore.addItem('url', { content: 'https://example2.com' });
      datastore.addItem('text', { content: 'Some text' });

      const urls = datastore.queryItems({ type: 'url' });
      assert.strictEqual(urls.length, 2);
      assert.ok(urls.every((item) => item.type === 'url'));
    });

    it('should filter items by text type', () => {
      datastore.addItem('url', { content: 'https://example.com' });
      datastore.addItem('text', { content: 'Note 1' });
      datastore.addItem('text', { content: 'Note 2' });

      const texts = datastore.queryItems({ type: 'text' });
      assert.strictEqual(texts.length, 2);
      assert.ok(texts.every((item) => item.type === 'text'));
    });

    it('should return all item types when no filter', () => {
      datastore.addItem('url', { content: 'https://example.com' });
      datastore.addItem('text', { content: 'Note' });
      datastore.addItem('tagset', {});
      datastore.addItem('image', { mimeType: 'image/png' });

      const items = datastore.queryItems({});
      assert.strictEqual(items.length, 4);

      const types = items.map((item) => item.type).sort();
      assert.deepStrictEqual(types, ['image', 'tagset', 'text', 'url']);
    });
  });

  describe('queryItems contentMode', () => {
    const LONG_BODY = 'x'.repeat(400); // 400 chars > 300-char snippet threshold

    beforeEach(() => {
      const db = datastore.getDb();
      db.exec('DELETE FROM item_tags');
      db.exec('DELETE FROM items');
    });

    it('returns full text content by default (no contentMode)', () => {
      datastore.addItem('text', { content: LONG_BODY });
      const [item] = datastore.queryItems({ type: 'text' });
      assert.strictEqual(item.content, LONG_BODY, 'default should return full content');
    });

    it('returns full text content when contentMode is full', () => {
      datastore.addItem('text', { content: LONG_BODY });
      const [item] = datastore.queryItems({ type: 'text', contentMode: 'full' });
      assert.strictEqual(item.content, LONG_BODY, 'full mode should return complete body');
    });

    it('truncates text item content to 300 chars in snippet mode', () => {
      datastore.addItem('text', { content: LONG_BODY });
      const [item] = datastore.queryItems({ type: 'text', contentMode: 'snippet' });
      assert.ok(item.content !== null && item.content.length <= 300,
        'snippet mode should cap text content at 300 chars');
      assert.strictEqual(item.content, 'x'.repeat(300));
    });

    it('preserves short text content unchanged in snippet mode', () => {
      const SHORT = 'Short note';
      datastore.addItem('text', { content: SHORT });
      const [item] = datastore.queryItems({ type: 'text', contentMode: 'snippet' });
      assert.strictEqual(item.content, SHORT, 'short content should not be modified');
    });

    it('does not truncate url item content in snippet mode', () => {
      const URL = 'https://example.com/a-very-long-path-that-is-still-a-url';
      datastore.addItem('url', { content: URL });
      const [item] = datastore.queryItems({ type: 'url', contentMode: 'snippet' });
      assert.strictEqual(item.content, URL, 'url content should be untouched in snippet mode');
    });

    it('getItem always returns full content regardless of any prior snippet query', () => {
      const { id } = datastore.addItem('text', { content: LONG_BODY });
      // Confirm snippet query truncates
      const [snippet] = datastore.queryItems({ type: 'text', contentMode: 'snippet' });
      assert.ok((snippet.content || '').length <= 300, 'precondition: snippet is truncated');
      // getItem must return full body
      const full = datastore.getItem(id);
      assert.strictEqual(full!.content, LONG_BODY, 'getItem returns full content');
    });
  });

  describe('Sync options', () => {
    it('should save item with syncId', () => {
      const { id } = datastore.addItem('url', {
        content: 'https://synced.com',
        syncId: 'remote-123',
      });

      const item = datastore.getItem(id);
      assert.ok(item);
      assert.strictEqual(item!.syncId, 'remote-123');
    });

    it('should update item with sync options', () => {
      const { id } = datastore.addItem('text', { content: 'Original' });

      datastore.updateItem(id, {
        syncId: 'sync-456',
      });

      const item = datastore.getItem(id);
      assert.ok(item);
      assert.strictEqual(item!.syncId, 'sync-456');
    });
  });

  describe('Item tagging', () => {
    it('should tag an item', () => {
      const { id: itemId } = datastore.addItem('url', { content: 'https://tagged.com' });
      const { tag } = datastore.getOrCreateTag('test-tag');

      const { link, alreadyExists } = datastore.tagItem(itemId, tag.id);
      assert.ok(link.id);
      assert.strictEqual(alreadyExists, false);
    });

    it('should retrieve item tags', () => {
      const { id: itemId } = datastore.addItem('text', { content: 'Tagged note' });
      const { tag: tag1 } = datastore.getOrCreateTag('tag-one');
      const { tag: tag2 } = datastore.getOrCreateTag('tag-two');

      datastore.tagItem(itemId, tag1.id);
      datastore.tagItem(itemId, tag2.id);

      const tags = datastore.getItemTags(itemId);
      assert.strictEqual(tags.length, 2);

      const tagNames = tags.map((t) => t.name).sort();
      assert.deepStrictEqual(tagNames, ['tag-one', 'tag-two']);
    });
  });

  describe('findUrlItem (canonical URL lookup)', () => {
    it('returns null for null/empty/non-http inputs', () => {
      assert.strictEqual(datastore.findUrlItem(''), null);
      assert.strictEqual(datastore.findUrlItem(null as unknown as string), null);
      // Items table only stores url-typed rows for http(s) URLs in practice;
      // a non-URL input still returns null because no row will match.
      assert.strictEqual(datastore.findUrlItem('not a url'), null);
    });

    it('matches stored item via normalized URL — trailing slash', () => {
      const { id } = datastore.addItem('url', { content: 'https://example.com/page' });
      // Active window URL has a trailing slash; stored content does not.
      const found = datastore.findUrlItem('https://example.com/page/');
      assert.ok(found, 'should find item despite trailing-slash difference');
      assert.strictEqual(found!.id, id);
    });

    it('matches stored item via normalized URL — query param order', () => {
      const { id } = datastore.addItem('url', { content: 'https://example.com/q?a=1&b=2' });
      const found = datastore.findUrlItem('https://example.com/q?b=2&a=1');
      assert.ok(found, 'should find item despite param-order difference');
      assert.strictEqual(found!.id, id);
    });

    it('matches stored item via normalized URL — default port stripped', () => {
      const { id } = datastore.addItem('url', { content: 'https://example.com/x' });
      const found = datastore.findUrlItem('https://example.com:443/x');
      assert.ok(found, 'should find item despite default-port presence');
      assert.strictEqual(found!.id, id);
    });

    it('returns null when no item exists for the URL', () => {
      const found = datastore.findUrlItem('https://does-not-exist.example/');
      assert.strictEqual(found, null);
    });

    it('does not return soft-deleted items', () => {
      const { id } = datastore.addItem('url', { content: 'https://soft-deleted.example/page' });
      datastore.deleteItem(id);
      const found = datastore.findUrlItem('https://soft-deleted.example/page');
      assert.strictEqual(found, null);
    });
  });

  describe('getFaviconForUrl (loading-card icon lookup)', () => {
    it('returns the stored favicon for an exact URL', () => {
      datastore.addItem('url', { content: 'https://fav-exact.example/page' });
      datastore.updateItemFavicon('https://fav-exact.example/page', 'https://fav-exact.example/icon.png');
      assert.strictEqual(
        datastore.getFaviconForUrl('https://fav-exact.example/page'),
        'https://fav-exact.example/icon.png',
      );
    });

    it('finds the favicon via normalized match (trailing slash)', () => {
      datastore.addItem('url', { content: 'https://fav-norm.example/page' });
      datastore.updateItemFavicon('https://fav-norm.example/page', 'https://fav-norm.example/icon.png');
      // Active URL has a trailing slash; stored content does not.
      assert.strictEqual(
        datastore.getFaviconForUrl('https://fav-norm.example/page/'),
        'https://fav-norm.example/icon.png',
      );
    });

    it('falls back to a same-domain favicon when the exact URL has none', () => {
      datastore.addItem('url', { content: 'https://fav-domain.example/home' });
      datastore.updateItemFavicon('https://fav-domain.example/home', 'https://fav-domain.example/icon.png');
      // A different path on the same domain, never stored itself.
      assert.strictEqual(
        datastore.getFaviconForUrl('https://fav-domain.example/some/other/path'),
        'https://fav-domain.example/icon.png',
      );
    });

    it("returns '' (not null) when no favicon is known", () => {
      assert.strictEqual(datastore.getFaviconForUrl('https://no-fav-anywhere.example/'), '');
    });

    it("returns '' for an item that exists but has an empty favicon", () => {
      datastore.addItem('url', { content: 'https://fav-empty.example/page' });
      assert.strictEqual(datastore.getFaviconForUrl('https://fav-empty.example/page'), '');
    });
  });

  describe('Item deletion', () => {
    it('should soft delete an item', () => {
      const { id } = datastore.addItem('url', { content: 'https://delete-me.com' });
      assert.ok(datastore.getItem(id));

      const deleted = datastore.deleteItem(id);
      assert.strictEqual(deleted, true);

      // Soft deleted - should not be found by default
      assert.strictEqual(datastore.getItem(id), null);
    });

    it('should restore a soft-deleted item with its tags', () => {
      const { id } = datastore.addItem('text', { content: 'Restore me' });
      const { tag } = datastore.getOrCreateTag('restore-tag');
      datastore.tagItem(id, tag.id);

      assert.strictEqual(datastore.restoreItem(id), false, 'a live item is not restored');
      assert.strictEqual(datastore.deleteItem(id), true);
      assert.strictEqual(datastore.getItem(id), null);

      assert.strictEqual(datastore.restoreItem(id), true);
      assert.strictEqual(datastore.getItem(id)?.id, id);
      assert.ok(datastore.getItemsByTag(tag.id).some((item: { id: string }) => item.id === id));
      assert.strictEqual(datastore.restoreItem(id), false, 'a second restore changes nothing');
    });

    it('should hard delete an item', () => {
      const { id } = datastore.addItem('text', { content: 'Hard delete me' });
      const { tag } = datastore.getOrCreateTag('delete-tag');
      datastore.tagItem(id, tag.id);

      const deleted = datastore.hardDeleteItem(id);
      assert.strictEqual(deleted, true);

      // Check tags are also gone
      const db = datastore.getDb();
      const tagLinks = db.prepare('SELECT * FROM item_tags WHERE itemId = ?').all(id);
      assert.strictEqual(tagLinks.length, 0);
    });
  });

  describe('Tag lifecycle events', () => {
    // Pubsub is a sibling module; load it once for the whole suite.
    let pubsub: typeof import('./pubsub.js');

    before(async () => {
      pubsub = await import('./pubsub.js');
    });

    it('should publish tag:created when a new tag is inserted', () => {
      const events: Array<Record<string, unknown>> = [];
      const sub = 'peek://test/tag-created';
      pubsub.subscribe(sub, 'tag:created', (msg) => {
        events.push(msg as Record<string, unknown>);
      });

      const { tag, created } = datastore.getOrCreateTag('event-new-tag');
      assert.strictEqual(created, true);
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].tagId, tag.id);
      assert.strictEqual(events[0].name, tag.name);

      pubsub.unsubscribe(sub, 'tag:created');
    });

    it('should NOT publish tag:created when an existing tag is returned', () => {
      // Seed the tag first (consumes the expected event)
      datastore.getOrCreateTag('event-existing-tag');

      const events: Array<Record<string, unknown>> = [];
      const sub = 'peek://test/tag-created-noop';
      pubsub.subscribe(sub, 'tag:created', (msg) => {
        events.push(msg as Record<string, unknown>);
      });

      const { created } = datastore.getOrCreateTag('event-existing-tag');
      assert.strictEqual(created, false);
      assert.strictEqual(events.length, 0);

      pubsub.unsubscribe(sub, 'tag:created');
    });

    it('should publish tag:renamed with oldName and newName', () => {
      const { tag } = datastore.getOrCreateTag('event-rename-before');

      const events: Array<Record<string, unknown>> = [];
      const sub = 'peek://test/tag-renamed';
      pubsub.subscribe(sub, 'tag:renamed', (msg) => {
        events.push(msg as Record<string, unknown>);
      });

      const updated = datastore.renameTag(tag.id, 'event-rename-after');
      assert.ok(updated);
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].tagId, tag.id);
      assert.strictEqual(events[0].oldName, 'event-rename-before');
      assert.strictEqual(events[0].newName, 'event-rename-after');

      pubsub.unsubscribe(sub, 'tag:renamed');
    });

    it('should NOT publish tag:renamed when the tag id does not exist', () => {
      const events: Array<Record<string, unknown>> = [];
      const sub = 'peek://test/tag-renamed-miss';
      pubsub.subscribe(sub, 'tag:renamed', (msg) => {
        events.push(msg as Record<string, unknown>);
      });

      const result = datastore.renameTag('tag-does-not-exist', 'whatever');
      assert.strictEqual(result, null);
      assert.strictEqual(events.length, 0);

      pubsub.unsubscribe(sub, 'tag:renamed');
    });

    it('should publish tag:deleted with id and name', () => {
      const { tag } = datastore.getOrCreateTag('event-delete-me');

      const events: Array<Record<string, unknown>> = [];
      const sub = 'peek://test/tag-deleted';
      pubsub.subscribe(sub, 'tag:deleted', (msg) => {
        events.push(msg as Record<string, unknown>);
      });

      const deleted = datastore.deleteTag(tag.id);
      assert.strictEqual(deleted, true);
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].tagId, tag.id);
      assert.strictEqual(events[0].name, 'event-delete-me');

      pubsub.unsubscribe(sub, 'tag:deleted');
    });

    it('should NOT publish tag:deleted when no row was removed', () => {
      const events: Array<Record<string, unknown>> = [];
      const sub = 'peek://test/tag-deleted-miss';
      pubsub.subscribe(sub, 'tag:deleted', (msg) => {
        events.push(msg as Record<string, unknown>);
      });

      const deleted = datastore.deleteTag('tag-does-not-exist');
      assert.strictEqual(deleted, false);
      assert.strictEqual(events.length, 0);

      pubsub.unsubscribe(sub, 'tag:deleted');
    });

    it('should publish tag:color-changed when color updates', () => {
      const { tag } = datastore.getOrCreateTag('event-color');

      const events: Array<Record<string, unknown>> = [];
      const sub = 'peek://test/tag-color';
      pubsub.subscribe(sub, 'tag:color-changed', (msg) => {
        events.push(msg as Record<string, unknown>);
      });

      const updated = datastore.updateTagColor(tag.id, '#ff00ff');
      assert.ok(updated);
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].tagId, tag.id);
      assert.strictEqual(events[0].color, '#ff00ff');

      pubsub.unsubscribe(sub, 'tag:color-changed');
    });
  });
});
