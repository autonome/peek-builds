/**
 * E2E sync tests for browser extension
 *
 * Tests the complete sync flow:
 * - Browser imports (history, bookmarks, tabs) stay local (syncSource prevents push)
 * - User-added items (notes, URLs via popup) sync bidirectionally
 * - Original timestamps (dateAdded, earliest visit) preserved as createdAt
 */

import { describe, it, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetMocks, setMockHistoryItems, setMockVisitsByUrl, setBookmarkTree, getStorageData } from './helpers/mocks.js';
import { initialize, close, data, sync, setConfig } from '../engine.js';
import { ensureDefaultProfile, getCurrentProfile, enableSync } from '../profiles.js';
import { importAllHistory } from '../history.js';
import { importAllBookmarks } from '../bookmarks.js';

// Helper to build a mock Response
function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Peek-Datastore-Version': '1',
      'X-Peek-Protocol-Version': '1',
      ...headers,
    },
  });
}

describe('e2e sync', () => {
  let mockFetchHandler;
  let pushedItems;

  before(async () => {
    await resetMocks();
  });

  beforeEach(async () => {
    pushedItems = [];
    await resetMocks();
    await initialize();
    await ensureDefaultProfile();

    // Configure sync for default profile
    const profile = (await getCurrentProfile()).data;
    await enableSync(profile.id, 'test-api-key', 'default');
    await setConfig({ serverUrl: 'https://test-server.example.com', autoSync: false });

    // Install custom fetch that tracks push requests
    mockFetchHandler = null;
    sync._fetch = async (url, opts) => {
      if (opts && opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        pushedItems.push(body);
        return jsonResponse({ id: `server-${Date.now()}`, created: true });
      }
      if (mockFetchHandler) return mockFetchHandler(url, opts);
      return jsonResponse({ items: [] });
    };
  });

  afterEach(async () => {
    await close();
    setMockHistoryItems([]);
    setMockVisitsByUrl({});
    setBookmarkTree([]);
  });

  // ==================== Browser Imports Stay Local ====================

  describe('browser imports stay local (not pushed)', () => {
    it('history items with syncSource=history should not be pushed', async () => {
      setMockHistoryItems([
        { url: 'https://history.example.com', title: 'History Page', lastVisitTime: 1000, visitCount: 5, typedCount: 2 },
      ]);
      setMockVisitsByUrl({
        'https://history.example.com': [
          { visitId: '1', visitTime: 1000, referringVisitId: '0', transition: 'typed' },
        ],
      });

      const importResult = await importAllHistory();
      assert.equal(importResult.imported, 1);

      // Verify item has syncSource = 'history'
      const items = await data.queryItems({ type: 'url' });
      assert.equal(items.length, 1);
      assert.equal(items[0].syncSource, 'history');

      // Push should not include this item
      const pushResult = await sync.pushToServer();
      assert.equal(pushResult.pushed, 0);
      assert.equal(pushedItems.length, 0);
    });

    it('bookmark items with syncSource=bookmark should not be pushed', async () => {
      setBookmarkTree([
        {
          id: '1',
          title: 'Bookmarks Bar',
          children: [
            { id: '2', url: 'https://bookmark.example.com', title: 'Bookmarked Site', dateAdded: 1609459200000 },
          ],
        },
      ]);

      const importResult = await importAllBookmarks();
      assert.equal(importResult.imported, 1);

      // Verify item has syncSource = 'bookmark'
      const items = await data.queryItems({ type: 'url' });
      assert.equal(items.length, 1);
      assert.equal(items[0].syncSource, 'bookmark');

      // Push should not include this item
      const pushResult = await sync.pushToServer();
      assert.equal(pushResult.pushed, 0);
      assert.equal(pushedItems.length, 0);
    });

    it('mixed browser imports and user items should only push user items', async () => {
      // Import history
      setMockHistoryItems([
        { url: 'https://history.example.com', title: 'History', lastVisitTime: 1000, visitCount: 1, typedCount: 0 },
      ]);
      setMockVisitsByUrl({
        'https://history.example.com': [{ visitId: '1', visitTime: 1000, referringVisitId: '0', transition: 'link' }],
      });
      await importAllHistory();

      // Import bookmarks
      setBookmarkTree([
        { id: '1', children: [{ id: '2', url: 'https://bookmark.example.com', title: 'Bookmark', dateAdded: 1000 }] },
      ]);
      await importAllBookmarks();

      // Add user item (no syncSource)
      await data.addItem('text', { content: 'User note from popup' });
      await data.addItem('url', { content: 'https://user-added.example.com' });

      const items = await data.queryItems();
      assert.equal(items.length, 4);

      // Push should only include user items (2 items without syncSource)
      const pushResult = await sync.pushToServer();
      assert.equal(pushResult.pushed, 2);
      assert.equal(pushedItems.length, 2);

      const pushedContents = pushedItems.map(i => i.content);
      assert.ok(pushedContents.includes('User note from popup'));
      assert.ok(pushedContents.includes('https://user-added.example.com'));
      assert.ok(!pushedContents.includes('https://history.example.com'));
      assert.ok(!pushedContents.includes('https://bookmark.example.com'));
    });
  });

  // ==================== Timestamp Preservation ====================

  describe('timestamp preservation', () => {
    it('history items should use earliest visit time as createdAt', async () => {
      const earliestVisit = 1609459200000; // 2021-01-01
      const laterVisit = 1640995200000;    // 2022-01-01

      setMockHistoryItems([
        { url: 'https://visited.example.com', title: 'Visited Page', lastVisitTime: laterVisit, visitCount: 2, typedCount: 1 },
      ]);
      setMockVisitsByUrl({
        'https://visited.example.com': [
          { visitId: '1', visitTime: earliestVisit, referringVisitId: '0', transition: 'typed' },
          { visitId: '2', visitTime: laterVisit, referringVisitId: '0', transition: 'link' },
        ],
      });

      await importAllHistory();

      const items = await data.queryItems({ type: 'url' });
      assert.equal(items.length, 1);
      assert.equal(items[0].createdAt, earliestVisit);
    });

    it('bookmark items should use dateAdded as createdAt', async () => {
      const bookmarkDate = 1577836800000; // 2020-01-01

      setBookmarkTree([
        {
          id: '1',
          children: [
            { id: '2', url: 'https://bookmarked.example.com', title: 'Old Bookmark', dateAdded: bookmarkDate },
          ],
        },
      ]);

      await importAllBookmarks();

      const items = await data.queryItems({ type: 'url' });
      assert.equal(items.length, 1);
      assert.equal(items[0].createdAt, bookmarkDate);
    });

    it('user-added items should use current time as createdAt', async () => {
      const beforeAdd = Date.now();
      await data.addItem('text', { content: 'Fresh note' });
      const afterAdd = Date.now();

      const items = await data.queryItems({ type: 'text' });
      assert.equal(items.length, 1);
      assert.ok(items[0].createdAt >= beforeAdd);
      assert.ok(items[0].createdAt <= afterAdd);
    });
  });

  // ==================== User Items Sync Bidirectionally ====================

  describe('user items sync bidirectionally', () => {
    it('user-added text notes should push to server', async () => {
      await data.addItem('text', { content: 'My quick note' });

      const pushResult = await sync.pushToServer();
      assert.equal(pushResult.pushed, 1);
      assert.equal(pushedItems.length, 1);
      assert.equal(pushedItems[0].content, 'My quick note');
      assert.equal(pushedItems[0].type, 'text');
    });

    it('user-added URLs should push to server', async () => {
      await data.addItem('url', { content: 'https://saved-url.example.com' });

      const pushResult = await sync.pushToServer();
      assert.equal(pushResult.pushed, 1);
      assert.equal(pushedItems[0].content, 'https://saved-url.example.com');
      assert.equal(pushedItems[0].type, 'url');
    });

    it('server items should pull to local', async () => {
      const serverItem = {
        id: 'server-item-1',
        type: 'text',
        content: 'Note from server',
        tags: [],
        metadata: null,
        createdAt: Date.now() - 10000,
        updatedAt: Date.now(),
      };

      mockFetchHandler = async () => jsonResponse({ items: [serverItem] });

      const pullResult = await sync.pullFromServer();
      assert.equal(pullResult.pulled, 1);

      const items = await data.queryItems({ type: 'text' });
      assert.equal(items.length, 1);
      assert.equal(items[0].content, 'Note from server');
      assert.equal(items[0].syncId, 'server-item-1');
      assert.equal(items[0].syncSource, 'server');
    });

    it('full sync should pull then push', async () => {
      // Add local item
      await data.addItem('text', { content: 'Local item to push' });

      // Mock server with an item to pull
      const serverItem = {
        id: 'server-sync-item',
        type: 'url',
        content: 'https://from-server.example.com',
        tags: [],
        metadata: null,
        createdAt: Date.now() - 10000,
        updatedAt: Date.now(),
      };

      mockFetchHandler = async () => jsonResponse({ items: [serverItem] });

      const syncResult = await sync.syncAll();
      assert.equal(syncResult.pulled, 1);
      assert.equal(syncResult.pushed, 1);

      const items = await data.queryItems();
      assert.equal(items.length, 2);
    });
  });

  // ==================== Deduplication ====================

  describe('deduplication', () => {
    it('history import should update existing URL items instead of duplicating', async () => {
      // First, add a URL item manually
      await data.addItem('url', { content: 'https://existing.example.com' });

      // Now import history with same URL
      setMockHistoryItems([
        { url: 'https://existing.example.com', title: 'Existing Page', lastVisitTime: 5000, visitCount: 10, typedCount: 3 },
      ]);
      setMockVisitsByUrl({
        'https://existing.example.com': [{ visitId: '1', visitTime: 5000, referringVisitId: '0', transition: 'typed' }],
      });

      const result = await importAllHistory();
      assert.equal(result.updated, 1);
      assert.equal(result.imported, 0);

      // Should still be only one item
      const items = await data.queryItems({ type: 'url' });
      const matching = items.filter(i => i.content === 'https://existing.example.com');
      assert.equal(matching.length, 1);
    });

    it('bookmark import should tag existing URL items instead of duplicating', async () => {
      // First, add a URL item manually
      await data.addItem('url', { content: 'https://existing.example.com' });

      // Now import bookmark with same URL
      setBookmarkTree([
        { id: '1', children: [{ id: '2', url: 'https://existing.example.com', title: 'Existing', dateAdded: 1000 }] },
      ]);

      const result = await importAllBookmarks();
      assert.equal(result.skipped, 1);
      assert.equal(result.imported, 0);

      // Should still be only one item
      const items = await data.queryItems({ type: 'url' });
      const matching = items.filter(i => i.content === 'https://existing.example.com');
      assert.equal(matching.length, 1);
    });

    it('re-importing history should update metadata, not create duplicates', async () => {
      setMockHistoryItems([
        { url: 'https://reimport.example.com', title: 'First Import', lastVisitTime: 1000, visitCount: 1, typedCount: 0 },
      ]);
      setMockVisitsByUrl({
        'https://reimport.example.com': [{ visitId: '1', visitTime: 1000, referringVisitId: '0', transition: 'link' }],
      });

      const first = await importAllHistory();
      assert.equal(first.imported, 1);

      // Update mock data and reimport
      setMockHistoryItems([
        { url: 'https://reimport.example.com', title: 'Updated Title', lastVisitTime: 5000, visitCount: 5, typedCount: 2 },
      ]);
      setMockVisitsByUrl({
        'https://reimport.example.com': [
          { visitId: '1', visitTime: 1000, referringVisitId: '0', transition: 'link' },
          { visitId: '2', visitTime: 5000, referringVisitId: '0', transition: 'typed' },
        ],
      });

      const second = await importAllHistory();
      assert.equal(second.imported, 0);
      assert.equal(second.updated, 1);

      // Verify only one item exists with updated metadata
      const items = await data.queryItems({ type: 'url' });
      const matching = items.filter(i => i.content === 'https://reimport.example.com');
      assert.equal(matching.length, 1);

      const meta = JSON.parse(matching[0].metadata);
      assert.equal(meta.title, 'Updated Title');
      assert.equal(meta.visitCount, 5);
    });
  });

  // ==================== Tags ====================

  describe('tags and metadata', () => {
    it('user items with tags should push tags to server', async () => {
      const { tag } = await data.getOrCreateTag('important');
      const { id } = await data.addItem('text', { content: 'Tagged note' });
      await data.tagItem(id, tag.id);

      await sync.pushToServer();

      assert.equal(pushedItems.length, 1);
      assert.ok(pushedItems[0].tags.includes('important'));
    });

    it('server items with tags should create local tags', async () => {
      const serverItem = {
        id: 'server-tagged',
        type: 'text',
        content: 'Server tagged item',
        tags: ['work', 'urgent'],
        metadata: null,
        createdAt: Date.now() - 10000,
        updatedAt: Date.now(),
      };

      mockFetchHandler = async () => jsonResponse({ items: [serverItem] });

      await sync.pullFromServer();

      const items = await data.queryItems({ type: 'text' });
      assert.equal(items.length, 1);

      const tags = await data.getItemTags(items[0].id);
      const tagNames = tags.map(t => t.name);
      assert.ok(tagNames.includes('work'));
      assert.ok(tagNames.includes('urgent'));
    });
  });
});
