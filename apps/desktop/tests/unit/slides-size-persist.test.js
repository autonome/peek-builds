/**
 * A slide keeps the size it was resized to. Main reports a settled resize to
 * the slides tile as `window:resized` with the window's open key; the slide's
 * size is saved under its edge, in a `sizes` setting separate from `items`, and
 * the next open of that edge uses it.
 *
 * Run via: node --test tests/unit/slides-size-persist.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const handlers = new Map();
const store = {
  items: [
    { screenEdge: 'Left', address: 'https://music.example/', enabled: true, width: 800, height: 600 },
    { screenEdge: 'Up', address: 'https://news.example/', enabled: true },
  ],
};
const writes = [];
const opens = [];

globalThis.window = {
  app: {
    pubsub: {
      publish: () => {},
      subscribe: (topic, fn) => { handlers.set(topic, fn); },
    },
    settings: {
      get: async (key) => ({ success: true, value: store[key], data: store[key] }),
      set: async (key, value) => { writes.push(key); store[key] = JSON.parse(JSON.stringify(value)); return { success: true }; },
    },
    shortcuts: { declareWakeShortcuts: () => {}, register: () => {}, unregister: () => {} },
    window: {
      open: async (url, params) => { opens.push(params); return { success: true, id: opens.length }; },
      exists: async () => ({ exists: false }),
      show: async () => ({ success: true }),
    },
  },
};

const { default: feature } = await import(join(__dirname, '..', '..', 'features', 'slides', 'background.js'));

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('slides keep their resized size', () => {
  it('saves a settled resize under the edge and opens the slide at it next time', async () => {
    await feature.init();
    await settle();

    await handlers.get('window:resized')({ key: 'https://music.example/:Left', width: 1000, height: 720 });
    await settle();

    assert.deepEqual(store.sizes, { Left: { width: 1000, height: 720 } });
    assert.ok(!writes.includes('items'), 'the items rows the Options panel edits are not rewritten');

    await handlers.get('cli:slide-open')({ args: ['left'] });
    await settle();
    const opened = opens.at(-1);
    assert.equal(opened.width, 1000);
    assert.equal(opened.height, 720);
  });

  it('keeps using the item size for an edge never resized', async () => {
    await handlers.get('cli:slide-open')({ args: ['up'] });
    await settle();
    const opened = opens.at(-1);
    assert.equal(opened.width, 800);
    assert.equal(opened.height, 600);
  });

  it('ignores a resize for a window it did not open', async () => {
    await handlers.get('window:resized')({ key: 'peek:3', width: 300, height: 300 });
    await settle();
    assert.deepEqual(store.sizes, { Left: { width: 1000, height: 720 } });
  });

  it('loads saved sizes after a restart', async () => {
    feature.uninit();
    handlers.clear();
    store.sizes = { Up: { width: 640, height: 480 } };
    await feature.init();
    await settle();
    await handlers.get('cli:slide-open')({ args: ['up'] });
    await settle();
    const opened = opens.at(-1);
    assert.equal(opened.width, 640);
    assert.equal(opened.height, 480);
  });
});
