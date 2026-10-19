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
let lookupFails = false;
let liveWindows = {};
let heldWindows = {};

globalThis.window = {
  app: {
    pubsub: {
      publish: (topic, msg) => { if (topic === 'cmd:register') registrations.push(msg); },
      subscribe: (topic, fn) => { handlers.set(topic, fn); },
    },
    datastore: {
      getOrCreateTag: async () => ({ success: true, data: { tag: tags[0] } }),
      getTagsByFrecency: async () => (lookupFails
        ? { success: false, error: 'datastore unavailable' }
        : { success: true, data: tags }),
    },
    context: {
      setDefault: async () => ({ success: true }),
      getWindowsInSpace: async (tagId) => ({ success: true, data: liveWindows[tagId] || [] }),
    },
    session: {
      getWorkspaceSnapshotWindowCount: async () => ({ success: true, count: 0 }),
      getHeldWindowCount: async (key) => ({ success: true, count: heldWindows[key] || 0 }),
    },
    window: {
      list: async () => ({
        success: true,
        windows: Object.values(liveWindows).flat().map((id) => ({ id, url: 'https://x.test/', visible: true })),
      }),
    },
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
    assert.deepEqual(lastOptions('switch space'), ['default', 'gamma']);
  });

  it('keeps the known spaces when a lookup fails, and catches up on the next tag event', async () => {
    const before = lastOptions('switch space');
    assert.ok(before.length > 0);

    lookupFails = true;
    tags = [...tags, { id: 't-delta', name: 'space:delta', color: '#abcdef' }];
    await handlers.get('tag:created')({ tagId: 't-delta' });
    await settle();
    assert.deepEqual(lastOptions('switch space'), before);
    assert.deepEqual(lastOptions('move to space'), before);

    lookupFails = false;
    await handlers.get('tag:renamed')({ tagId: 't-delta' });
    await settle();
    assert.deepEqual(lastOptions('switch space'), ['default', 'delta', 'gamma']);
  });
});

describe('space-name commands show window counts', () => {
  const subtitleOf = (commandName, value) => [...registrations].reverse()
    .find((r) => r.name === commandName)?.params?.[0]?.options.find((o) => o.value === value)?.subtitle;

  it('subtitles a space with its live window count and refreshes on membership changes', async () => {
    tags = [{ id: 't-default', name: 'space:default' }, { id: 't-work', name: 'space:work' }];
    liveWindows = { 't-work': ['w1', 'w2'] };
    await handlers.get('tag:renamed')({ tagId: 't-work' });
    await settle();
    assert.equal(subtitleOf('switch space', 'work'), '2 windows');

    liveWindows = { 't-work': ['w1'] };
    await handlers.get('spaces:membership-changed')({ windowId: 'w2', spaceId: 't-work' });
    await settle();
    assert.equal(subtitleOf('switch space', 'work'), '1 window');

    liveWindows = {};
    await handlers.get('window:closed')({ windowId: 'w1' });
    await settle();
    assert.equal(subtitleOf('move to space', 'work'), 'no windows');
  });

  it('refreshes when a window opens', async () => {
    liveWindows = { 't-work': ['w1'] };
    await handlers.get('window:opened')({ id: 'w1' });
    await settle();
    assert.equal(subtitleOf('switch space', 'work'), '1 window');

    liveWindows = { 't-work': ['w1', 'w2'] };
    await handlers.get('window:opened')({ id: 'w2' });
    await settle();
    assert.equal(subtitleOf('switch space', 'work'), '2 windows');
    liveWindows = {};
  });

  it('adds windows still held for another desktop to the live ones', async () => {
    liveWindows = { 't-work': ['w1', 'w2', 'w3'] };
    heldWindows = { 't-work': 3 };
    await handlers.get('spaces:membership-changed')({ windowId: 'w3', spaceId: 't-work' });
    await settle();
    assert.equal(subtitleOf('switch space', 'work'), '6 windows');
    heldWindows = {};
    liveWindows = {};
  });
});

describe('space-name commands name a create path', () => {
  it('only switch space offers to create a space that does not exist', () => {
    const createCommandOf = (name) => [...registrations].reverse().find((r) => r.name === name)?.params?.[0]?.createCommand;
    assert.equal(createCommandOf('switch space'), 'create space');
    assert.equal(createCommandOf('open space'), undefined);
    assert.equal(createCommandOf('move to space'), undefined);
  });
});
