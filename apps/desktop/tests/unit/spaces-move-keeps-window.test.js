/**
 * `move to space` into an inactive space closes the window only when the
 * target space's saved row now holds it. A window the row did not take stays
 * open, back in its own space, and the command reports an error.
 *
 * Run via: node --test tests/unit/spaces-move-keeps-window.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const tags = [
  { id: 't-default', name: 'space:default', color: '#123456' },
  { id: 't-work', name: 'space:work', color: '#abcdef' },
];
let addResult = { success: true, added: true };
let closed = [];
let modes = [];

globalThis.window = {
  app: {
    pubsub: { publish: () => {}, subscribe: () => {} },
    datastore: {
      getOrCreateTag: async (name) => ({ success: true, data: { tag: tags.find((t) => t.name === name) || tags[0] } }),
      getTagsByFrecency: async () => ({ success: true, data: tags }),
    },
    context: {
      setDefault: async () => ({ success: true }),
      getWindowsInSpace: async () => ({ success: true, data: [] }),
      get: async () => ({ data: { value: null } }),
      setMode: async (mode, args) => { modes.push(args.metadata.spaceId); return { success: true }; },
    },
    session: {
      getWorkspaceSnapshotWindowCount: async () => ({ success: true, count: 0 }),
      getHeldWindowCount: async () => ({ success: true, count: 0 }),
      addWindowToWorkspaceSnapshot: async () => addResult,
    },
    window: {
      list: async () => ({ success: true, windows: [] }),
      getFocusedVisibleWindowId: async () => 42,
      close: async (id) => { closed.push(id); },
    },
    theme: { onChange: () => {}, getInfo: async () => ({ themeId: 'peek' }) },
  },
};

const { default: feature, __test } = await import(join(__dirname, '..', '..', 'features', 'spaces', 'background.js'));

describe('move to an inactive space', () => {
  it('closes the window once the target space saved it', async () => {
    await feature.init();
    __test.setActiveSpaceId('t-default');
    closed = [];
    addResult = { success: true, added: true };
    const result = await __test.moveToSpace('work');
    assert.equal(result.success, true);
    assert.deepEqual(closed, [42]);
  });

  it('keeps the window open and reports an error when the target did not add it', async () => {
    closed = [];
    modes = [];
    addResult = { success: true, added: false };
    const result = await __test.moveToSpace('work');
    assert.equal(result.success, false);
    assert.match(result.error, /already holds/);
    assert.deepEqual(closed, []);
    assert.equal(modes.at(-1), 't-default');
  });
});
