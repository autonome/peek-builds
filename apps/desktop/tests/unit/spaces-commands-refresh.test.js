/**
 * The space-name commands (open / switch / move to space) list the existing
 * spaces as their suggestions. A space created, renamed or deleted from the
 * Spaces page goes straight to the datastore, so the background document must
 * rebuild those commands from the tag events, not only from its own commands.
 *
 * Run via: node --test tests/unit/spaces-commands-refresh.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const handlers = new Map();
const registrations = [];
let tags = [{ id: 't-default', name: 'space:default', color: '#123456' }];

globalThis.window = {
  app: {
    pubsub: {
      publish: (topic, msg) => { if (topic === 'cmd:register') registrations.push(msg); },
      subscribe: (topic, fn) => { handlers.set(topic, fn); },
    },
    datastore: {
      getOrCreateTag: async () => ({ success: true, data: { tag: tags[0] } }),
      getTagsByFrecency: async () => ({ success: true, data: tags }),
    },
    context: { setDefault: async () => ({ success: true }) },
    window: { list: async () => ({ success: true, windows: [] }) },
    theme: { onChange: () => {}, getInfo: async () => ({ themeId: 'peek' }) },
  },
};

const { default: feature } = await import(join(__dirname, '..', '..', 'features', 'spaces', 'background.js'));

const settle = () => new Promise((resolve) => setImmediate(resolve));

const lastOptions = (commandName) => {
  const reg = [...registrations].reverse().find((r) => r.name === commandName);
  return reg?.params?.[0]?.options.map((o) => o.value);
};

describe('space-name commands follow the space list', () => {
  it('offers a space added from the Spaces page, and drops one deleted there', async () => {
    await feature.init();
    await settle();
    assert.deepEqual(lastOptions('switch space'), ['default']);

    tags = [...tags, { id: 't-alpha', name: 'space:alpha', color: '#abcdef' }];
    await handlers.get('tag:created')({ tagId: 't-alpha', tagName: 'space:alpha' });
    await settle();
    assert.deepEqual(lastOptions('switch space'), ['alpha', 'default']);
    assert.deepEqual(lastOptions('open space'), ['alpha', 'default']);
    assert.deepEqual(lastOptions('move to space'), ['alpha', 'default']);

    tags = tags.filter((t) => t.id !== 't-alpha');
    await handlers.get('tag:deleted')({ tagId: 't-alpha' });
    await settle();
    assert.deepEqual(lastOptions('switch space'), ['default']);
  });

  it('follows a rename', async () => {
    tags = [...tags, { id: 't-beta', name: 'space:beta', color: '#abcdef' }];
    await handlers.get('tag:created')({ tagId: 't-beta' });
    await settle();
    tags = tags.map((t) => (t.id === 't-beta' ? { ...t, name: 'space:gamma' } : t));
    await handlers.get('tag:renamed')({ tagId: 't-beta' });
    await settle();
    assert.deepEqual(lastOptions('open space'), ['default', 'gamma']);
  });
});
