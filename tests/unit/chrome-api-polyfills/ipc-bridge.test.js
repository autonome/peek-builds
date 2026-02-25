import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', '..', 'lib', 'chrome-api-polyfills', '_ipc-bridge.js');

const { IPC_PREFIX, channel, registerHandler, removeHandler, invokeSnippet } = await import(modulePath);

describe('IPC Bridge', () => {
  describe('channel()', () => {
    it('builds a namespaced channel name', () => {
      assert.equal(channel('alarms', 'create'), 'chrome-polyfill:alarms:create');
    });

    it('works with dotted API names', () => {
      assert.equal(channel('storage.session', 'get'), 'chrome-polyfill:storage.session:get');
    });

    it('uses the correct prefix', () => {
      const ch = channel('test', 'method');
      assert.ok(ch.startsWith(IPC_PREFIX + ':'));
    });
  });

  describe('registerHandler()', () => {
    it('calls ipcMain.handle with the correct channel', () => {
      const handled = {};
      const mockIpcMain = {
        handle(ch, handler) { handled[ch] = handler; },
      };
      const handler = () => {};

      registerHandler(mockIpcMain, 'alarms', 'create', handler);
      assert.equal(handled['chrome-polyfill:alarms:create'], handler);
    });
  });

  describe('removeHandler()', () => {
    it('calls ipcMain.removeHandler with the correct channel', () => {
      const removed = [];
      const mockIpcMain = {
        removeHandler(ch) { removed.push(ch); },
      };

      removeHandler(mockIpcMain, 'alarms', 'create');
      assert.deepEqual(removed, ['chrome-polyfill:alarms:create']);
    });
  });

  describe('invokeSnippet()', () => {
    it('returns a JS string with the correct channel', () => {
      const snippet = invokeSnippet('alarms', 'create');
      assert.ok(snippet.includes('chrome-polyfill:alarms:create'));
      assert.ok(snippet.includes('electron.ipcRenderer.invoke'));
    });
  });
});
