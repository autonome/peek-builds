/**
 * The space border is an overlay window that gets hidden when the app
 * resigns active mid-switch. showBorder() on an already-open border must show
 * it again (without activating the app), not only publish a color/name update.
 *
 * Run via: node --test tests/unit/spaces-border-reshow.test.js
 */
import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const calls = [];
let windowExists = true;
globalThis.window = {
  app: {
    window: {
      exists: async () => ({ exists: windowExists }),
      show: async (...args) => { calls.push(['show', ...args]); return { success: true }; },
      open: async () => ({ id: 99 }),
      setIgnoreMouseEvents: async () => ({ success: true }),
      setVisibleOnAllWorkspaces: async () => ({ success: true }),
    },
    screen: { getPrimaryDisplay: async () => ({ success: true, data: { bounds: { x: 0, y: 0, width: 100, height: 100 } } }) },
    pubsub: { publish: (topic) => { calls.push(['publish', topic]); }, subscribe: () => {} },
  },
};

const { __test } = await import(join(__dirname, '..', '..', 'features', 'spaces', 'background.js'));

describe('showBorder on an open border', () => {
  beforeEach(() => {
    calls.length = 0;
    windowExists = true;
    __test.border.state = 'open';
    __test.border.windowId = 7;
  });

  it('shows the window without activating the app, then publishes the update', async () => {
    await __test.showBorder('#ff0000', 'Work');
    const show = calls.find((c) => c[0] === 'show');
    assert.ok(show, 'window.show was called');
    assert.equal(show[1], 7);
    assert.deepEqual(show[2], { inactive: true });
    assert.ok(calls.some((c) => c[0] === 'publish' && c[1] === 'spaces:border-update'));
  });
});
