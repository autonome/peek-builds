import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', '..', 'lib', 'chrome-api-polyfills', 'alarms.js');

const { setupMainProcess, getPreloadScript } = await import(modulePath);

/**
 * Create a mock IPC infrastructure that simulates Electron's ipcMain.
 * Handlers are stored in a map and can be invoked directly.
 */
function createMockIpc() {
  const handlers = new Map();
  return {
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
      removeHandler(channel) {
        handlers.delete(channel);
      },
    },
    handlers,
    /** Invoke a handler as if an extension called ipcRenderer.invoke */
    async invoke(channel, extensionId, ...args) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler for ${channel}`);
      const fakeEvent = {
        sender: {
          getURL: () => `chrome-extension://${extensionId}/background.js`,
        },
      };
      return handler(fakeEvent, ...args);
    },
  };
}

describe('chrome.alarms polyfill', () => {
  let mockIpc;
  let handle;

  beforeEach(() => {
    mockIpc = createMockIpc();
    handle = setupMainProcess(
      { /* mock session */ getAllExtensions: () => [] },
      { ipcMain: mockIpc.ipcMain }
    );
  });

  afterEach(() => {
    handle.cleanup();
  });

  describe('create and get', () => {
    it('creates an alarm and retrieves it', async () => {
      await mockIpc.invoke('chrome-polyfill:alarms:create', 'ext1', 'test-alarm', {
        delayInMinutes: 5,
      });

      const alarm = await mockIpc.invoke('chrome-polyfill:alarms:get', 'ext1', 'test-alarm');
      assert.equal(alarm.name, 'test-alarm');
      assert.ok(alarm.scheduledTime > Date.now() - 1000);
      assert.equal(alarm.periodInMinutes, undefined);
    });

    it('creates a recurring alarm with periodInMinutes', async () => {
      await mockIpc.invoke('chrome-polyfill:alarms:create', 'ext1', 'recurring', {
        periodInMinutes: 1,
      });

      const alarm = await mockIpc.invoke('chrome-polyfill:alarms:get', 'ext1', 'recurring');
      assert.equal(alarm.name, 'recurring');
      assert.equal(alarm.periodInMinutes, 1);
    });

    it('creates alarm with "when" (absolute time)', async () => {
      const futureTime = Date.now() + 60000;
      await mockIpc.invoke('chrome-polyfill:alarms:create', 'ext1', 'when-alarm', {
        when: futureTime,
      });

      const alarm = await mockIpc.invoke('chrome-polyfill:alarms:get', 'ext1', 'when-alarm');
      assert.equal(alarm.name, 'when-alarm');
      // scheduledTime should be close to our future time
      assert.ok(Math.abs(alarm.scheduledTime - futureTime) < 100);
    });

    it('returns undefined for non-existent alarm', async () => {
      const alarm = await mockIpc.invoke('chrome-polyfill:alarms:get', 'ext1', 'nope');
      assert.equal(alarm, undefined);
    });

    it('replacing an alarm clears the old one', async () => {
      await mockIpc.invoke('chrome-polyfill:alarms:create', 'ext1', 'replace-me', {
        delayInMinutes: 10,
      });

      await mockIpc.invoke('chrome-polyfill:alarms:create', 'ext1', 'replace-me', {
        delayInMinutes: 20,
      });

      // Should only have one alarm
      const all = await mockIpc.invoke('chrome-polyfill:alarms:getAll', 'ext1');
      assert.equal(all.length, 1);
      assert.equal(all[0].name, 'replace-me');
    });
  });

  describe('getAll', () => {
    it('returns all alarms for an extension', async () => {
      await mockIpc.invoke('chrome-polyfill:alarms:create', 'ext1', 'a1', { delayInMinutes: 1 });
      await mockIpc.invoke('chrome-polyfill:alarms:create', 'ext1', 'a2', { delayInMinutes: 2 });
      await mockIpc.invoke('chrome-polyfill:alarms:create', 'ext2', 'other', { delayInMinutes: 3 });

      const ext1Alarms = await mockIpc.invoke('chrome-polyfill:alarms:getAll', 'ext1');
      assert.equal(ext1Alarms.length, 2);

      const names = ext1Alarms.map(a => a.name).sort();
      assert.deepEqual(names, ['a1', 'a2']);
    });

    it('returns empty array when no alarms', async () => {
      const alarms = await mockIpc.invoke('chrome-polyfill:alarms:getAll', 'ext-none');
      assert.deepEqual(alarms, []);
    });

    it('extensions are isolated from each other', async () => {
      await mockIpc.invoke('chrome-polyfill:alarms:create', 'ext1', 'mine', { delayInMinutes: 1 });
      await mockIpc.invoke('chrome-polyfill:alarms:create', 'ext2', 'theirs', { delayInMinutes: 1 });

      const ext1 = await mockIpc.invoke('chrome-polyfill:alarms:getAll', 'ext1');
      const ext2 = await mockIpc.invoke('chrome-polyfill:alarms:getAll', 'ext2');

      assert.equal(ext1.length, 1);
      assert.equal(ext1[0].name, 'mine');
      assert.equal(ext2.length, 1);
      assert.equal(ext2[0].name, 'theirs');
    });
  });

  describe('clear', () => {
    it('clears a specific alarm', async () => {
      await mockIpc.invoke('chrome-polyfill:alarms:create', 'ext1', 'clear-me', { delayInMinutes: 1 });

      const result = await mockIpc.invoke('chrome-polyfill:alarms:clear', 'ext1', 'clear-me');
      assert.equal(result, true);

      const alarm = await mockIpc.invoke('chrome-polyfill:alarms:get', 'ext1', 'clear-me');
      assert.equal(alarm, undefined);
    });

    it('returns false for non-existent alarm', async () => {
      const result = await mockIpc.invoke('chrome-polyfill:alarms:clear', 'ext1', 'nope');
      assert.equal(result, false);
    });
  });

  describe('clearAll', () => {
    it('clears all alarms for an extension', async () => {
      await mockIpc.invoke('chrome-polyfill:alarms:create', 'ext1', 'a1', { delayInMinutes: 1 });
      await mockIpc.invoke('chrome-polyfill:alarms:create', 'ext1', 'a2', { delayInMinutes: 2 });
      await mockIpc.invoke('chrome-polyfill:alarms:create', 'ext2', 'other', { delayInMinutes: 3 });

      const result = await mockIpc.invoke('chrome-polyfill:alarms:clearAll', 'ext1');
      assert.equal(result, true);

      const ext1Alarms = await mockIpc.invoke('chrome-polyfill:alarms:getAll', 'ext1');
      assert.equal(ext1Alarms.length, 0);

      // ext2 should not be affected
      const ext2Alarms = await mockIpc.invoke('chrome-polyfill:alarms:getAll', 'ext2');
      assert.equal(ext2Alarms.length, 1);
    });

    it('returns false when no alarms to clear', async () => {
      const result = await mockIpc.invoke('chrome-polyfill:alarms:clearAll', 'ext-none');
      assert.equal(result, false);
    });
  });

  describe('alarm firing', () => {
    it('fires the onAlarm event when an alarm triggers', async () => {
      const fired = [];
      handle.onAlarm.addListener((alarm) => {
        fired.push(alarm);
      });

      // Create alarm with 0 delay (fires immediately)
      await mockIpc.invoke('chrome-polyfill:alarms:create', 'ext1', 'immediate', {
        delayInMinutes: 0,
      });

      // Wait for the timer to fire (setTimeout with 0ms delay)
      await new Promise(resolve => setTimeout(resolve, 50));

      assert.equal(fired.length, 1);
      assert.equal(fired[0].name, 'immediate');
    });

    it('removes non-recurring alarm after firing', async () => {
      await mockIpc.invoke('chrome-polyfill:alarms:create', 'ext1', 'once', {
        delayInMinutes: 0,
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      const alarm = await mockIpc.invoke('chrome-polyfill:alarms:get', 'ext1', 'once');
      assert.equal(alarm, undefined);
    });

    it('keeps recurring alarm after firing', async () => {
      await mockIpc.invoke('chrome-polyfill:alarms:create', 'ext1', 'repeat', {
        delayInMinutes: 0,
        periodInMinutes: 60,
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      const alarm = await mockIpc.invoke('chrome-polyfill:alarms:get', 'ext1', 'repeat');
      assert.ok(alarm, 'Recurring alarm should still exist after firing');
      assert.equal(alarm.name, 'repeat');
      assert.equal(alarm.periodInMinutes, 60);
    });
  });

  describe('cleanup', () => {
    it('clears all alarms and removes handlers', async () => {
      await mockIpc.invoke('chrome-polyfill:alarms:create', 'ext1', 'test', { delayInMinutes: 1 });
      assert.equal(handle._store.size, 1);

      handle.cleanup();

      assert.equal(handle._store.size, 0);
      // Handlers should be removed
      assert.equal(mockIpc.handlers.size, 0);
    });
  });

  describe('getPreloadScript', () => {
    it('returns a non-empty string', () => {
      const script = getPreloadScript();
      assert.equal(typeof script, 'string');
      assert.ok(script.length > 100);
    });

    it('contains chrome.alarms API methods', () => {
      const script = getPreloadScript();
      assert.ok(script.includes('chrome.alarms'));
      assert.ok(script.includes('create'));
      assert.ok(script.includes('getAll'));
      assert.ok(script.includes('clear'));
      assert.ok(script.includes('clearAll'));
      assert.ok(script.includes('onAlarm'));
    });

    it('references the correct IPC channels', () => {
      const script = getPreloadScript();
      assert.ok(script.includes('chrome-polyfill:alarms:create'));
      assert.ok(script.includes('chrome-polyfill:alarms:get'));
      assert.ok(script.includes('chrome-polyfill:alarms:onAlarm'));
    });
  });
});
