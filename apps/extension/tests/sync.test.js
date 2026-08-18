import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetMocks } from './helpers/mocks.js';
import { initialize, close, data, sync, getConfig, setConfig } from '../engine.js';
import { ensureDefaultProfile, getCurrentProfile, enableSync } from '../profiles.js';
import { DATASTORE_VERSION, PROTOCOL_VERSION } from '../sync/version.js';

// Helper to build a mock Response
function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Peek-Datastore-Version': String(DATASTORE_VERSION),
      'X-Peek-Protocol-Version': String(PROTOCOL_VERSION),
      ...headers,
    },
  });
}

describe('sync', () => {
  let mockFetchHandler;

  beforeEach(async () => {
    await resetMocks();
    await initialize();
    await ensureDefaultProfile();

    // Configure sync for default profile
    const profile = (await getCurrentProfile()).data;
    await enableSync(profile.id, 'test-api-key', 'default');
    await setConfig({ serverUrl: 'https://test-server.example.com', autoSync: false });

    // Install custom fetch on the SyncEngine instance
    mockFetchHandler = null;
    sync._fetch = async (...args) => {
      if (mockFetchHandler) return mockFetchHandler(...args);
      return jsonResponse({ items: [] });
    };
  });

  afterEach(async () => {
    await close();
  });

  // ==================== Config ====================

  describe('getConfig', () => {
    it('should return configured sync settings', async () => {
      const config = await getConfig();
      assert.equal(config.serverUrl, 'https://test-server.example.com');
      assert.equal(config.apiKey, 'test-api-key');
      assert.equal(config.autoSync, false);
    });
  });

  describe('setConfig', () => {
    it('should persist server URL', async () => {
      await setConfig({ serverUrl: 'https://new-server.com' });
      const config = await getConfig();
      assert.equal(config.serverUrl, 'https://new-server.com');
    });

    it('should persist autoSync setting', async () => {
      await setConfig({ autoSync: true });
      const config = await getConfig();
      assert.equal(config.autoSync, true);
    });
  });

  // ==================== Pull ====================

  describe('pullFromServer', () => {
    it('should insert new items from server', async () => {
      const serverItem = {
        id: 'server-1',
        type: 'text',
        content: 'From server',
        tags: [],
        metadata: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z').getTime(),
        updatedAt: new Date('2024-01-01T00:00:00.000Z').getTime(),
      };

      mockFetchHandler = async () => jsonResponse({ items: [serverItem] });

      const result = await sync.pullFromServer();
      assert.equal(result.pulled, 1);

      // Verify item was created locally
      const items = await data.queryItems();
      assert.equal(items.length, 1);
      assert.equal(items[0].content, 'From server');
      assert.equal(items[0].syncId, 'server-1');
      assert.ok(items[0].syncedAt > 0, 'Should have syncedAt timestamp');
    });

    it('should update local when server is newer', async () => {
      // Add local item synced from server
      const { id: localId } = await data.addItem('text', {
        content: 'Old content',
        syncId: 'server-2',
      });

      // Make server item newer
      const futureTime = Date.now() + 100000;
      const serverItem = {
        id: 'server-2',
        type: 'text',
        content: 'Updated content',
        tags: [],
        metadata: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z').getTime(),
        updatedAt: futureTime,
      };

      mockFetchHandler = async () => jsonResponse({ items: [serverItem] });

      const result = await sync.pullFromServer();
      assert.equal(result.pulled, 1);

      const item = await data.getItem(localId);
      assert.equal(item.content, 'Updated content');
    });

    it('should skip when local is newer (conflict)', async () => {
      // Add local item that's been modified recently
      const { id: localId } = await data.addItem('text', {
        content: 'Local content',
        syncId: 'server-3',
      });

      // Server item has old timestamp
      const serverItem = {
        id: 'server-3',
        type: 'text',
        content: 'Server old content',
        tags: [],
        metadata: null,
        createdAt: new Date('2020-01-01T00:00:00.000Z').getTime(),
        updatedAt: new Date('2020-01-01T00:00:00.000Z').getTime(),
      };

      mockFetchHandler = async () => jsonResponse({ items: [serverItem] });

      const result = await sync.pullFromServer();
      assert.equal(result.conflicts, 1);

      // Local content should be unchanged
      const item = await data.getItem(localId);
      assert.equal(item.content, 'Local content');
    });

    it('should handle empty response', async () => {
      mockFetchHandler = async () => jsonResponse({ items: [] });

      const result = await sync.pullFromServer();
      assert.equal(result.pulled, 0);
    });
  });

  // ==================== Push ====================

  describe('pushToServer', () => {
    it('should push unsynced items', async () => {
      await data.addItem('text', { content: 'To push' });

      const pushedItems = [];
      mockFetchHandler = async (url, opts) => {
        if (opts && opts.method === 'POST') {
          const body = JSON.parse(opts.body);
          pushedItems.push(body);
          return jsonResponse({ id: 'server-new-1', created: true });
        }
        return jsonResponse({ items: [] });
      };

      const result = await sync.pushToServer();
      assert.equal(result.pushed, 1);
      assert.equal(pushedItems[0].content, 'To push');
      assert.equal(pushedItems[0].type, 'text');
    });

    it('should not push server-synced items', async () => {
      // Item from server (syncedAt set to indicate already synced)
      const { id } = await data.addItem('text', {
        content: 'From server',
        syncId: 'server-x',
      });
      // Manually set syncedAt to simulate item pulled from server
      await data.updateItem(id, {});
      const item = await data.getItem(id);
      // Directly update DB to set syncedAt = updatedAt (simulating synced state)
      await data.adapter.db.transaction(['items'], 'readwrite')
        .objectStore('items').put({ ...item, syncedAt: item.updatedAt });

      let pushCount = 0;
      mockFetchHandler = async (url, opts) => {
        if (opts && opts.method === 'POST') {
          pushCount++;
          return jsonResponse({ id: 'server-x', created: false });
        }
        return jsonResponse({ items: [] });
      };

      await sync.pushToServer();
      assert.equal(pushCount, 0);
    });

    it('should send version headers', async () => {
      await data.addItem('text', { content: 'Header test' });

      let capturedHeaders = {};
      mockFetchHandler = async (url, opts) => {
        capturedHeaders = opts.headers;
        return jsonResponse({ id: 'server-h', created: true });
      };

      await sync.pushToServer();
      assert.equal(capturedHeaders['X-Peek-Client'], 'sync-engine');
      assert.equal(capturedHeaders['X-Peek-Datastore-Version'], String(DATASTORE_VERSION));
      assert.equal(capturedHeaders['X-Peek-Protocol-Version'], String(PROTOCOL_VERSION));
    });
  });

  // ==================== syncAll ====================

  describe('syncAll', () => {
    it('should pull then push and update lastSyncTime', async () => {
      await data.addItem('text', { content: 'Local item' });

      const serverItem = {
        id: 'server-sync-1',
        type: 'url',
        content: 'https://synced.com',
        tags: [],
        metadata: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z').getTime(),
        updatedAt: new Date('2024-01-01T00:00:00.000Z').getTime(),
      };

      let requestLog = [];
      mockFetchHandler = async (url, opts) => {
        requestLog.push({ url, method: opts?.method || 'GET' });
        if (opts && opts.method === 'POST') {
          return jsonResponse({ id: 'pushed-1', created: true });
        }
        return jsonResponse({ items: [serverItem] });
      };

      const result = await sync.syncAll();
      assert.equal(result.pulled, 1);
      assert.equal(result.pushed, 1);
      assert.ok(result.lastSyncTime > 0);

      // Verify pull happened before push (GET before POST)
      const getIdx = requestLog.findIndex(r => r.method === 'GET');
      const postIdx = requestLog.findIndex(r => r.method === 'POST');
      assert.ok(getIdx < postIdx);
    });

    it('should not echo back pushed items on next sync', async () => {
      // Simulate the scenario:
      // 1. Sync 1: push local items to server
      // 2. Sync 2: pull should NOT return those same items
      //
      // Bug: if lastSyncTime is captured BEFORE push, the server's updatedAt
      // on pushed items is AFTER lastSyncTime, so they echo back on next pull.

      // Create local items that need pushing
      await data.addItem('url', { content: 'https://echo-1.com' });
      await data.addItem('url', { content: 'https://echo-2.com' });
      await data.addItem('text', { content: 'Echo test note' });

      // Track server-side state: items pushed to server get updatedAt = now
      const serverItems = [];
      let syncCount = 0;

      mockFetchHandler = async (url, opts) => {
        const urlStr = url.toString();
        if (opts && opts.method === 'POST') {
          // Server saves item with updatedAt = now (like real server does)
          const body = JSON.parse(opts.body);
          const serverUpdatedAt = Date.now();
          serverItems.push({
            id: `server-${serverItems.length}`,
            type: body.type,
            content: body.content,
            tags: body.tags || [],
            metadata: body.metadata || null,
            createdAt: serverUpdatedAt,
            updatedAt: serverUpdatedAt,
          });
          return jsonResponse({ id: `server-${serverItems.length - 1}`, created: true });
        }

        // GET /items/since/:timestamp — return items with updatedAt > since
        // URL uses ISO timestamps like /items/since/2026-02-19T12:34:56.789Z
        const sinceMatch = urlStr.match(/\/items\/since\/([^?&]+)/);
        if (sinceMatch) {
          const sinceStr = decodeURIComponent(sinceMatch[1]);
          const since = /^\d+$/.test(sinceStr)
            ? parseInt(sinceStr, 10)
            : new Date(sinceStr).getTime();
          const matching = serverItems.filter(i => i.updatedAt > since);
          syncCount++;
          return jsonResponse({ items: matching });
        }

        return jsonResponse({ items: [] });
      };

      // Sync 1: pull (nothing), then push 3 items
      const result1 = await sync.syncAll();
      assert.equal(result1.pushed, 3, 'Sync 1 should push 3 items');

      // Sync 2: pull should NOT echo back items we just pushed
      // Reset mock to not accept more pushes (items already synced)
      const origHandler = mockFetchHandler;
      mockFetchHandler = async (url, opts) => {
        if (opts && opts.method === 'POST') {
          return jsonResponse({ id: 'no-push', created: false });
        }
        return origHandler(url, opts);
      };

      const result2 = await sync.syncAll();
      assert.equal(result2.pulled, 0,
        `Sync 2 pulled ${result2.pulled} items — expected 0. ` +
        `Pushed items are echoing back because lastSyncTime is set before push.`
      );
    });
  });

  // ==================== Status ====================

  describe('getSyncStatus', () => {
    it('should report configured status', async () => {
      const status = await sync.getSyncStatus();
      assert.equal(status.configured, true);
    });

    it('should count pending items', async () => {
      await data.addItem('text', { content: 'pending' });
      await data.addItem('text', { content: 'pending too' });

      const status = await sync.getSyncStatus();
      assert.equal(status.pendingCount, 2);
    });
  });

  // ==================== Server-Change Detection ====================

  describe('resetSyncStateIfServerChanged', () => {
    it('should reset sync markers when server URL changes', async () => {
      // Add an item synced from server
      const { id } = await data.addItem('text', {
        content: 'Synced item',
        syncId: 'server-sc-1',
      });
      // Simulate synced state
      const item = await data.getItem(id);
      await data.adapter.db.transaction(['items'], 'readwrite')
        .objectStore('items').put({ ...item, syncedAt: item.updatedAt });

      // Save current server config
      await sync.saveSyncServerConfig('https://test-server.example.com');

      // Verify the saved config
      const savedUrl = await data.getSetting('sync_lastSyncServerUrl');
      assert.equal(JSON.parse(savedUrl), 'https://test-server.example.com');

      // Change server URL and detect the change
      await setConfig({ serverUrl: 'https://new-server.example.com' });
      const changed = await sync.resetSyncStateIfServerChanged('https://new-server.example.com');
      assert.equal(changed, true);

      // Verify sync markers were reset
      const items = await data.queryItems();
      const syncedItem = items.find(i => i.content === 'Synced item');
      assert.equal(syncedItem.syncedAt, 0);
      assert.equal(syncedItem.syncId, '');
    });

    it('should not reset when server URL is unchanged', async () => {
      const { id } = await data.addItem('text', {
        content: 'Stable item',
        syncId: 'server-sc-2',
      });
      // Simulate synced state
      const item = await data.getItem(id);
      await data.adapter.db.transaction(['items'], 'readwrite')
        .objectStore('items').put({ ...item, syncedAt: item.updatedAt });

      // Save config with same URL
      await sync.saveSyncServerConfig('https://test-server.example.com');

      // Check with same URL
      const changed = await sync.resetSyncStateIfServerChanged('https://test-server.example.com');
      assert.equal(changed, false);

      // Verify sync markers are intact
      const items = await data.queryItems();
      const stableItem = items.find(i => i.content === 'Stable item');
      assert.equal(stableItem.syncId, 'server-sc-2');
      assert.ok(stableItem.syncedAt > 0, 'Should still have syncedAt timestamp');
    });

    it('should not reset on first run (no stored config)', async () => {
      // Add server-synced items without any stored config (simulates upgrade)
      const { id } = await data.addItem('text', {
        content: 'Legacy item',
        syncId: 'server-legacy-1',
      });
      // Simulate synced state
      const item = await data.getItem(id);
      await data.adapter.db.transaction(['items'], 'readwrite')
        .objectStore('items').put({ ...item, syncedAt: item.updatedAt });

      // No stored config yet — unified engine does NOT reset on first run
      const changed = await sync.resetSyncStateIfServerChanged('https://test-server.example.com');
      assert.equal(changed, false);

      // Sync markers should be intact
      const items = await data.queryItems();
      const legacyItem = items.find(i => i.content === 'Legacy item');
      assert.equal(legacyItem.syncId, 'server-legacy-1');
      assert.ok(legacyItem.syncedAt > 0, 'Should still have syncedAt timestamp');
    });
  });
});
