import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'main', 'chrome-api-polyfills', 'storage-session.js');

const { setupMainProcess, getPreloadScript } = await import(modulePath);

function createMockIpc() {
  const handlers = new Map();
  return {
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    handlers,
    async invoke(channel, extensionId, ...args) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler for ${channel}`);
      const fakeEvent = {
        sender: { getURL: () => `chrome-extension://${extensionId}/background.js` },
      };
      return handler(fakeEvent, ...args);
    },
  };
}

describe('chrome.storage.session polyfill', () => {
  let mockIpc;
  let handle;

  beforeEach(() => {
    mockIpc = createMockIpc();
    handle = setupMainProcess(
      { getAllExtensions: () => [] },
      { ipcMain: mockIpc.ipcMain }
    );
  });

  afterEach(() => { handle.cleanup(); });

  describe('set and get', () => {
    it('stores and retrieves a simple value', async () => {
      await mockIpc.invoke('chrome-polyfill:storage.session:set', 'ext1', { key1: 'value1' });
      const result = await mockIpc.invoke('chrome-polyfill:storage.session:get', 'ext1', 'key1');
      assert.deepEqual(result, { key1: 'value1' });
    });

    it('stores and retrieves multiple values', async () => {
      await mockIpc.invoke('chrome-polyfill:storage.session:set', 'ext1', { a: 1, b: 'two', c: [3] });
      const result = await mockIpc.invoke('chrome-polyfill:storage.session:get', 'ext1', ['a', 'b', 'c']);
      assert.deepEqual(result, { a: 1, b: 'two', c: [3] });
    });

    it('returns empty object for missing keys', async () => {
      const result = await mockIpc.invoke('chrome-polyfill:storage.session:get', 'ext1', 'nonexistent');
      assert.deepEqual(result, {});
    });

    it('returns default values for missing keys (object form)', async () => {
      await mockIpc.invoke('chrome-polyfill:storage.session:set', 'ext1', { exists: 42 });
      const result = await mockIpc.invoke('chrome-polyfill:storage.session:get', 'ext1', { exists: 0, missing: 'default' });
      assert.deepEqual(result, { exists: 42, missing: 'default' });
    });

    it('returns all items when keys is null', async () => {
      await mockIpc.invoke('chrome-polyfill:storage.session:set', 'ext1', { x: 1, y: 2 });
      const result = await mockIpc.invoke('chrome-polyfill:storage.session:get', 'ext1', null);
      assert.deepEqual(result, { x: 1, y: 2 });
    });

    it('values are deep-cloned (not references)', async () => {
      const obj = { nested: { value: 1 } };
      await mockIpc.invoke('chrome-polyfill:storage.session:set', 'ext1', { obj });
      const result = await mockIpc.invoke('chrome-polyfill:storage.session:get', 'ext1', 'obj');
      result.obj.nested.value = 999;
      const result2 = await mockIpc.invoke('chrome-polyfill:storage.session:get', 'ext1', 'obj');
      assert.equal(result2.obj.nested.value, 1);
    });
  });

  describe('remove', () => {
    it('removes a single key', async () => {
      await mockIpc.invoke('chrome-polyfill:storage.session:set', 'ext1', { a: 1, b: 2 });
      await mockIpc.invoke('chrome-polyfill:storage.session:remove', 'ext1', 'a');
      const result = await mockIpc.invoke('chrome-polyfill:storage.session:get', 'ext1', null);
      assert.deepEqual(result, { b: 2 });
    });

    it('removes multiple keys', async () => {
      await mockIpc.invoke('chrome-polyfill:storage.session:set', 'ext1', { a: 1, b: 2, c: 3 });
      await mockIpc.invoke('chrome-polyfill:storage.session:remove', 'ext1', ['a', 'c']);
      const result = await mockIpc.invoke('chrome-polyfill:storage.session:get', 'ext1', null);
      assert.deepEqual(result, { b: 2 });
    });

    it('is a no-op for non-existent keys', async () => {
      await mockIpc.invoke('chrome-polyfill:storage.session:remove', 'ext1', 'nope');
    });
  });

  describe('clear', () => {
    it('removes all data for an extension', async () => {
      await mockIpc.invoke('chrome-polyfill:storage.session:set', 'ext1', { a: 1, b: 2 });
      await mockIpc.invoke('chrome-polyfill:storage.session:clear', 'ext1');
      const result = await mockIpc.invoke('chrome-polyfill:storage.session:get', 'ext1', null);
      assert.deepEqual(result, {});
    });

    it('does not affect other extensions', async () => {
      await mockIpc.invoke('chrome-polyfill:storage.session:set', 'ext1', { a: 1 });
      await mockIpc.invoke('chrome-polyfill:storage.session:set', 'ext2', { b: 2 });
      await mockIpc.invoke('chrome-polyfill:storage.session:clear', 'ext1');
      const ext2 = await mockIpc.invoke('chrome-polyfill:storage.session:get', 'ext2', null);
      assert.deepEqual(ext2, { b: 2 });
    });
  });

  describe('getBytesInUse', () => {
    it('returns 0 for empty storage', async () => {
      const bytes = await mockIpc.invoke('chrome-polyfill:storage.session:getBytesInUse', 'ext1', null);
      assert.equal(bytes, 0);
    });

    it('returns non-zero for stored data', async () => {
      await mockIpc.invoke('chrome-polyfill:storage.session:set', 'ext1', { key: 'value' });
      const bytes = await mockIpc.invoke('chrome-polyfill:storage.session:getBytesInUse', 'ext1', null);
      assert.ok(bytes > 0);
    });

    it('calculates bytes for specific keys', async () => {
      await mockIpc.invoke('chrome-polyfill:storage.session:set', 'ext1', { a: 1, b: 'looong' });
      const bytesA = await mockIpc.invoke('chrome-polyfill:storage.session:getBytesInUse', 'ext1', 'a');
      const bytesAll = await mockIpc.invoke('chrome-polyfill:storage.session:getBytesInUse', 'ext1', null);
      assert.ok(bytesA > 0);
      assert.ok(bytesAll > bytesA);
    });
  });

  describe('onChanged events', () => {
    it('fires onChanged when setting values', async () => {
      const changes = [];
      handle.onChanged.addListener((ch, area) => { changes.push({ changes: ch, area }); });
      await mockIpc.invoke('chrome-polyfill:storage.session:set', 'ext1', { key: 'value' });
      assert.equal(changes.length, 1);
      assert.equal(changes[0].area, 'session');
      assert.equal(changes[0].changes.key.newValue, 'value');
    });

    it('includes oldValue when overwriting', async () => {
      await mockIpc.invoke('chrome-polyfill:storage.session:set', 'ext1', { key: 'old' });
      const changes = [];
      handle.onChanged.addListener((ch) => changes.push(ch));
      await mockIpc.invoke('chrome-polyfill:storage.session:set', 'ext1', { key: 'new' });
      assert.equal(changes[0].key.oldValue, 'old');
      assert.equal(changes[0].key.newValue, 'new');
    });

    it('fires onChanged when removing values', async () => {
      await mockIpc.invoke('chrome-polyfill:storage.session:set', 'ext1', { key: 'value' });
      const changes = [];
      handle.onChanged.addListener((ch) => changes.push(ch));
      await mockIpc.invoke('chrome-polyfill:storage.session:remove', 'ext1', 'key');
      assert.equal(changes[0].key.oldValue, 'value');
    });

    it('fires onChanged when clearing', async () => {
      await mockIpc.invoke('chrome-polyfill:storage.session:set', 'ext1', { a: 1, b: 2 });
      const changes = [];
      handle.onChanged.addListener((ch) => changes.push(ch));
      await mockIpc.invoke('chrome-polyfill:storage.session:clear', 'ext1');
      assert.equal(changes[0].a.oldValue, 1);
      assert.equal(changes[0].b.oldValue, 2);
    });
  });

  describe('extension isolation', () => {
    it('extensions cannot see each other\'s data', async () => {
      await mockIpc.invoke('chrome-polyfill:storage.session:set', 'ext1', { secret: 'abc' });
      await mockIpc.invoke('chrome-polyfill:storage.session:set', 'ext2', { other: 'xyz' });
      const ext1 = await mockIpc.invoke('chrome-polyfill:storage.session:get', 'ext1', null);
      const ext2 = await mockIpc.invoke('chrome-polyfill:storage.session:get', 'ext2', null);
      assert.deepEqual(ext1, { secret: 'abc' });
      assert.deepEqual(ext2, { other: 'xyz' });
    });
  });

  describe('cleanup', () => {
    it('clears all stores and removes handlers', async () => {
      await mockIpc.invoke('chrome-polyfill:storage.session:set', 'ext1', { a: 1 });
      handle.cleanup();
      assert.equal(handle._stores.size, 0);
      assert.equal(mockIpc.handlers.size, 0);
    });
  });

  describe('getPreloadScript', () => {
    it('returns a non-empty string', () => {
      const script = getPreloadScript();
      assert.ok(script.length > 100);
    });

    it('contains storage.session API methods', () => {
      const script = getPreloadScript();
      assert.ok(script.includes('chrome.storage'));
      assert.ok(script.includes('getBytesInUse'));
      assert.ok(script.includes('setAccessLevel'));
    });
  });
});
