/**
 * The space border and its name chip (both drawn by the border window) are
 * visible only while Peek is the focused app. When the app resigns active the
 * border closes after the hide debounce, even though windows of the space are
 * still visible behind the other app; when the app becomes active again with
 * a space window focused, the border opens again.
 *
 * Drives the `app:focus-changed` handler directly: OS app activation cannot be
 * simulated from Playwright, and this handler is the only place the feature
 * learns about it (main publishes it from did-become-active /
 * did-resign-active, `main/main.ts`).
 *
 * Run via: node --test tests/unit/spaces-border-app-focus.test.js
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const closed = [];
const opened = [];
let spaceWindowIds = [];
let windows = [];
globalThis.window = {
  app: {
    window: {
      close: (id) => { closed.push(id); },
      list: async () => ({ success: true, windows }),
      exists: async () => ({ exists: false }),
      show: async () => ({ success: true }),
      open: async (url) => { opened.push(url); return { id: 42 }; },
      setIgnoreMouseEvents: async () => ({ success: true }),
      setVisibleOnAllWorkspaces: async () => ({ success: true }),
      getFocusedVisibleWindowId: async () => 5,
    },
    context: {
      getWindowsInSpace: async () => ({ success: true, data: spaceWindowIds }),
      get: async () => ({
        success: true,
        data: { value: 'space', metadata: { spaceId: 'space-1', spaceName: 'Work', color: '#ff0000' } },
      }),
    },
    screen: {
      getPrimaryDisplay: async () => ({ success: true, data: { bounds: { x: 0, y: 0, width: 100, height: 100 } } }),
    },
    pubsub: { publish: () => {}, subscribe: () => {} },
  },
};

const { __test } = await import(join(__dirname, '..', '..', 'features', 'spaces', 'background.js'));

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

describe('space border follows app focus', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
    closed.length = 0;
    opened.length = 0;
    spaceWindowIds = [5];
    windows = [{ id: 5, visible: true }];
    __test.setActiveSpaceId('space-1');
    __test.border.state = 'open';
    __test.border.windowId = 7;
  });
  afterEach(() => mock.timers.reset());

  it('closes when the app resigns active, even with a space window visible', async () => {
    await __test.handleAppFocusChanged({ focused: false });
    mock.timers.tick(700);
    await settle();
    assert.deepEqual(closed, [7]);
    assert.equal(__test.border.state, 'closed');
  });

  it('opens again when the app becomes active with a space window focused', async () => {
    await __test.handleAppFocusChanged({ focused: false });
    mock.timers.tick(700);
    await settle();
    assert.equal(__test.border.state, 'closed');

    await __test.handleAppFocusChanged({ focused: true });
    await settle();
    assert.equal(opened.length, 1);
    assert.match(opened[0], /border\.html/);
    assert.equal(__test.border.state, 'open');
    assert.equal(__test.border.windowId, 42);
  });

  it('keeps the border when the app becomes active again within the hide delay', async () => {
    await __test.handleAppFocusChanged({ focused: false });
    mock.timers.tick(300);
    await __test.handleAppFocusChanged({ focused: true });
    await settle();
    mock.timers.tick(700);
    await settle();
    assert.deepEqual(closed, []);
  });
});
