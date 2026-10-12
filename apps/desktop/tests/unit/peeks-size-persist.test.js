/**
 * A peek keeps the size it was resized to. Main reports a settled resize to
 * the peeks tile as `window:resized` with the window's open key
 * (`peek:<keyNum>`); the size is saved under that key, in a `sizes` setting
 * separate from `items`, and the next open of that peek uses it.
 *
 * Run via: node --test tests/unit/peeks-size-persist.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const handlers = new Map();
const store = {
  items: [
    { keyNum: 1, address: 'https://a.example/', enabled: true, width: 800, height: 600 },
    { keyNum: 2, address: 'https://b.example/', enabled: true },
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
    },
  },
};

const { default: feature } = await import(join(__dirname, '..', '..', 'features', 'peeks', 'background.js'));

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('peeks keep their resized size', () => {
  it('saves a settled resize under the peek key and opens the peek at it next time', async () => {
    await feature.init();
    await settle();

    await handlers.get('window:resized')({ key: 'peek:1', width: 1100, height: 700 });
    await settle();

    assert.deepEqual(store.sizes, { 'peek:1': { width: 1100, height: 700, optionsWidth: 800, optionsHeight: 600 } });
    assert.ok(!writes.includes('items'), 'the items rows the Options panel edits are not rewritten');

    await handlers.get('cli:peek-open')({ args: ['1'] });
    await settle();
    const opened = opens.at(-1);
    assert.equal(opened.width, 1100);
    assert.equal(opened.height, 700);
  });

  it('keeps using the item size for a peek never resized', async () => {
    await handlers.get('cli:peek-open')({ args: ['2'] });
    await settle();
    const opened = opens.at(-1);
    assert.equal(opened.width, 800);
    assert.equal(opened.height, 600);
  });

  it('ignores a resize for a window it did not open', async () => {
    await handlers.get('window:resized')({ key: 'https://x.example/:Left', width: 300, height: 300 });
    await settle();
    assert.deepEqual(store.sizes, { 'peek:1': { width: 1100, height: 700, optionsWidth: 800, optionsHeight: 600 } });
  });

  it('loads saved sizes after a restart', async () => {
    feature.uninit();
    handlers.clear();
    store.sizes = { 'peek:2': { width: 640, height: 480 } };
    await feature.init();
    await settle();
    await handlers.get('cli:peek-open')({ args: ['2'] });
    await settle();
    const opened = opens.at(-1);
    assert.equal(opened.width, 640);
    assert.equal(opened.height, 480);
  });
});

const flush = async () => { for (let i = 0; i < 10; i++) await settle(); };

const editPeek1 = async (fields) => {
  store.items = store.items.map(i => (i.keyNum === 1 ? { ...i, ...fields } : i));
  handlers.get('peeks:settings-changed')();
  await flush();
};

const openPeek1 = async () => {
  await handlers.get('cli:peek-open')({ args: ['1'] });
  await flush();
  return opens.at(-1);
};

describe('the latest peek size edit wins', () => {
  it('an Options width edit after a resize opens at the Options size', async () => {
    await handlers.get('window:resized')({ key: 'peek:1', width: 1100, height: 700 });
    await flush();
    await editPeek1({ width: 900 });
    const opened = await openPeek1();
    assert.equal(opened.width, 900);
    assert.equal(opened.height, 600);
  });

  it('a resize after an Options edit opens at the resized size', async () => {
    await handlers.get('window:resized')({ key: 'peek:1', width: 1200, height: 750 });
    await flush();
    const opened = await openPeek1();
    assert.equal(opened.width, 1200);
    assert.equal(opened.height, 750);
  });

  it('an Options edit to another field keeps the resized size', async () => {
    await editPeek1({ title: 'A' });
    const opened = await openPeek1();
    assert.equal(opened.width, 1200);
    assert.equal(opened.height, 750);
  });

  it('an Options height edit made while the tile was not running wins at the next start', async () => {
    feature.uninit();
    handlers.clear();
    store.items = store.items.map(i => (i.keyNum === 1 ? { ...i, height: 500 } : i));
    await feature.init();
    await flush();
    const opened = await openPeek1();
    assert.equal(opened.width, 900);
    assert.equal(opened.height, 500);
  });
});
