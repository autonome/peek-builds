/**
 * The space border must stay open when the app resigns active while a window
 * of the active space is still visible, and close only when none is.
 *
 * Run via: node --test tests/unit/spaces-border-keep.test.js
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const closed = [];
let spaceWindowIds = [];
let windows = [];
globalThis.window = {
  app: {
    window: {
      close: (id) => { closed.push(id); },
      list: async () => ({ success: true, windows }),
    },
    context: {
      getWindowsInSpace: async () => ({ success: true, data: spaceWindowIds }),
    },
    pubsub: { publish: () => {}, subscribe: () => {} },
  },
};

const { __test } = await import(join(__dirname, '..', '..', 'features', 'spaces', 'background.js'));

describe('border on app focus loss', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
    closed.length = 0;
    spaceWindowIds = [5];
    windows = [{ id: 5, visible: true }];
    __test.setActiveSpaceId('space-1');
    __test.border.state = 'open';
    __test.border.windowId = 7;
  });
  afterEach(() => mock.timers.reset());

  it('stays open while a window of the space is visible', async () => {
    __test.handleAppFocusChanged({ focused: false });
    mock.timers.tick(700);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(closed, []);
    assert.equal(__test.border.state, 'open');
  });

  it('closes when no window of the space is visible', async () => {
    windows = [{ id: 5, visible: false }];
    __test.handleAppFocusChanged({ focused: false });
    mock.timers.tick(700);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(closed, [7]);
    assert.equal(__test.border.state, 'closed');
  });
});
