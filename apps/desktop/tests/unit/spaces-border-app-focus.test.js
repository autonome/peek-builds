/**
 * The space border and its name chip (both drawn by the border window) are
 * visible only while Peek is the focused app. When the app resigns active the
 * border window is hidden in the same tick — no hide delay — even though
 * windows of the space are still visible behind the other app; when the app
 * becomes active again the same window is shown in the same tick, never
 * closed and re-created (opening a window is what made the return slow).
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
const hidden = [];
const shown = [];
let focusedMode = 'space';
globalThis.window = {
  app: {
    window: {
      close: (id) => { closed.push(id); },
      hide: (id) => { hidden.push(id); return Promise.resolve({ success: true }); },
      show: (id) => { shown.push(id); return Promise.resolve({ success: true }); },
      exists: async () => ({ exists: true }),
      open: async (url) => { opened.push(url); return { id: 42 }; },
      setIgnoreMouseEvents: async () => ({ success: true }),
      setVisibleOnAllWorkspaces: async () => ({ success: true }),
      getFocusedVisibleWindowId: async () => 5,
    },
    context: {
      get: async () => ({
        success: true,
        data: focusedMode === 'space'
          ? { value: 'space', metadata: { spaceId: 'space-1', spaceName: 'Work', color: '#ff0000' } }
          : { value: 'page', metadata: {} },
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

describe('space border follows app focus with no delay', () => {
  beforeEach(async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    // Leave the previous test's app state behind: active, border open.
    __test.handleAppFocusChanged({ focused: true });
    await settle();
    __test.cancelHideTimer();
    __test.border.hiddenWhileInactive = false;
    closed.length = 0;
    opened.length = 0;
    hidden.length = 0;
    shown.length = 0;
    focusedMode = 'space';
    __test.setActiveSpaceId('space-1');
    __test.border.state = 'open';
    __test.border.windowId = 7;
  });
  afterEach(() => mock.timers.reset());

  it('hides the border in the same tick the app resigns active', () => {
    __test.handleAppFocusChanged({ focused: false });
    assert.deepEqual(hidden, [7]);
    assert.deepEqual(closed, []);
  });

  it('shows the same border window in the same tick the app becomes active', async () => {
    __test.handleAppFocusChanged({ focused: false });
    await settle();
    __test.handleAppFocusChanged({ focused: true });
    assert.deepEqual(shown, [7]);
    await settle();
    assert.deepEqual(opened, []);
    assert.deepEqual(closed, []);
    assert.equal(__test.border.state, 'open');
    assert.equal(__test.border.windowId, 7);
  });

  it('keeps the border window alive while the app is inactive', async () => {
    __test.handleAppFocusChanged({ focused: false });
    mock.timers.tick(5000);
    await settle();
    assert.deepEqual(closed, []);
    assert.equal(__test.border.state, 'open');
  });

  it('does not show a border that was not showing when the app resigned', async () => {
    __test.border.state = 'closed';
    __test.border.windowId = null;
    focusedMode = 'page';
    __test.handleAppFocusChanged({ focused: false });
    __test.handleAppFocusChanged({ focused: true });
    await settle();
    assert.deepEqual(shown, []);
    assert.deepEqual(opened, []);
  });
});
