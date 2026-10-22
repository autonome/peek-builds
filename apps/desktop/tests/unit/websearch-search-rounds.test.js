/**
 * Search-round recording, driven by a fake tile API.
 *
 * `features/websearch/search-rounds.js` takes the API as an argument and keeps
 * no module state, so the fake below is the whole environment: an in-memory
 * items/tags/events store plus a front window that may or may not be in a
 * space.
 */

import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  recordSearchRound,
  spaceOfFrontWindow,
  tagResultPageInSpace,
  SEARCH_ROUND_TAG,
  SEARCH_RUN_KIND,
} from '../../features/websearch/search-rounds.js';

const makeApi = ({ frontWindowId = 7, mode = null, failOn = null } = {}) => {
  const store = {
    items: [],
    tags: [],
    itemTags: [],
    events: [],
  };
  let nextId = 1;

  const fail = (op) => {
    if (failOn === op) throw new Error(`fake datastore refused ${op}`);
  };

  const api = {
    store,
    window: {
      getFocusedVisibleWindowId: async () => frontWindowId,
    },
    context: {
      get: async (key, windowId) => {
        if (key !== 'mode') return { success: true, data: null };
        if (windowId !== frontWindowId) return { success: true, data: null };
        return { success: true, data: mode };
      },
    },
    datastore: {
      queryItems: async (filter = {}) => {
        fail('queryItems');
        const needle = (filter.search || '').toLowerCase();
        return {
          success: true,
          data: store.items.filter((item) => {
            if (filter.type && item.type !== filter.type) return false;
            return item.content.toLowerCase().includes(needle);
          }),
        };
      },
      getItemTags: async (itemId) => {
        fail('getItemTags');
        const tagIds = store.itemTags.filter((l) => l.itemId === itemId).map((l) => l.tagId);
        return { success: true, data: store.tags.filter((t) => tagIds.includes(t.id)) };
      },
      findUrlItem: async (url) => {
        fail('findUrlItem');
        const item = store.items.find((i) => i.type === 'url' && i.content === url) || null;
        return { success: true, data: item };
      },
      addItem: async (type, options = {}) => {
        fail('addItem');
        const item = { id: `item-${nextId++}`, type, content: options.content || '' };
        store.items.push(item);
        return { success: true, data: { id: item.id } };
      },
      getOrCreateTag: async (name) => {
        fail('getOrCreateTag');
        let tag = store.tags.find((t) => t.name === name);
        if (!tag) {
          tag = { id: `tag-${nextId++}`, name };
          store.tags.push(tag);
        }
        return { success: true, data: { tag, created: false } };
      },
      tagItem: async (itemId, tagId) => {
        fail('tagItem');
        const existing = store.itemTags.some((l) => l.itemId === itemId && l.tagId === tagId);
        if (!existing) store.itemTags.push({ itemId, tagId });
        return { success: true, data: { alreadyExists: existing } };
      },
      addItemEvent: async (itemId, options = {}) => {
        fail('addItemEvent');
        const event = { id: `event-${nextId++}`, itemId, ...options };
        store.events.push(event);
        return { success: true, data: { id: event.id } };
      },
    },
  };

  // A space tag the fake store already knows about, so `tagItem` with the
  // space's tag id resolves to a named tag the assertions can read back.
  if (mode && mode.metadata && mode.metadata.spaceId) {
    store.tags.push({ id: mode.metadata.spaceId, name: `space:${mode.metadata.spaceName}` });
  }

  return api;
};

const spaceMode = (spaceId = 'tag-space-1', spaceName = 'research') => ({
  value: 'space',
  metadata: { spaceId, spaceName, color: '#3366ff' },
});

const tagNamesOf = (api, itemId) => {
  const tagIds = api.store.itemTags.filter((l) => l.itemId === itemId).map((l) => l.tagId);
  return api.store.tags.filter((t) => tagIds.includes(t.id)).map((t) => t.name).sort();
};

const eventsOf = (api, itemId) => api.store.events.filter((e) => e.itemId === itemId);

describe('websearch search rounds', () => {
  let api;

  beforeEach(() => {
    api = makeApi();
  });

  it('a first search creates one item tagged search-round with one search-run event', async () => {
    const result = await recordSearchRound(api, {
      query: 'otter diet',
      engineId: 'duckduckgo',
      url: 'https://duckduckgo.com/?q=otter%20diet',
    });

    assert.equal(result, null, 'no space, so no space mode');
    assert.equal(api.store.items.length, 1);

    const item = api.store.items[0];
    assert.equal(item.type, 'text');
    assert.equal(item.content, 'otter diet');
    assert.deepEqual(tagNamesOf(api, item.id), [SEARCH_ROUND_TAG]);

    const events = eventsOf(api, item.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].content, 'https://duckduckgo.com/?q=otter%20diet');

    const metadata = JSON.parse(events[0].metadata);
    assert.equal(metadata.kind, SEARCH_RUN_KIND);
    assert.equal(metadata.engineId, 'duckduckgo');
    assert.equal(metadata.url, 'https://duckduckgo.com/?q=otter%20diet');
    assert.equal(typeof events[0].occurredAt, 'number');
  });

  it('the query is trimmed, and the same query again adds a second event to the same item', async () => {
    await recordSearchRound(api, { query: 'otter diet', engineId: 'ddg', url: 'https://x/1' });
    await recordSearchRound(api, { query: '  otter diet  ', engineId: 'google', url: 'https://x/2' });

    assert.equal(api.store.items.length, 1, 'one item per distinct query text');

    const item = api.store.items[0];
    assert.equal(item.content, 'otter diet');

    const events = eventsOf(api, item.id);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.content), ['https://x/1', 'https://x/2']);
    assert.deepEqual(
      events.map((e) => JSON.parse(e.metadata).engineId),
      ['ddg', 'google'],
    );
  });

  it('a different query creates a second item', async () => {
    await recordSearchRound(api, { query: 'otter diet', engineId: 'ddg', url: 'https://x/1' });
    await recordSearchRound(api, { query: 'otter range', engineId: 'ddg', url: 'https://x/2' });

    assert.equal(api.store.items.length, 2);
    assert.deepEqual(api.store.items.map((i) => i.content).sort(), ['otter diet', 'otter range']);
    for (const item of api.store.items) {
      assert.deepEqual(tagNamesOf(api, item.id), [SEARCH_ROUND_TAG]);
      assert.equal(eventsOf(api, item.id).length, 1);
    }
  });

  it('a query whose text is a substring of another does not adopt that item', async () => {
    await recordSearchRound(api, { query: 'otter diet', engineId: 'ddg', url: 'https://x/1' });
    await recordSearchRound(api, { query: 'otter', engineId: 'ddg', url: 'https://x/2' });

    assert.equal(api.store.items.length, 2);
  });

  it('a text item with the same content but no search-round tag is never adopted', async () => {
    api.store.items.push({ id: 'note-1', type: 'text', content: 'otter diet' });

    await recordSearchRound(api, { query: 'otter diet', engineId: 'ddg', url: 'https://x/1' });

    assert.equal(api.store.items.length, 2);
    assert.equal(eventsOf(api, 'note-1').length, 0);
  });

  it('a search from a space-mode window tags the item with the space and returns its space mode', async () => {
    api = makeApi({ mode: spaceMode('tag-space-1', 'research') });

    const result = await recordSearchRound(api, {
      query: 'otter diet',
      engineId: 'ddg',
      url: 'https://x/1',
    });

    assert.deepEqual(result, { spaceId: 'tag-space-1', spaceName: 'research', color: '#3366ff' });

    const item = api.store.items[0];
    assert.deepEqual(tagNamesOf(api, item.id), ['search-round', 'space:research']);
  });

  it('from a window outside a space there is no space tag and the answer is null', async () => {
    api = makeApi({ mode: { value: 'group', metadata: { groupId: 'tag-group-1' } } });

    const result = await recordSearchRound(api, {
      query: 'otter diet',
      engineId: 'ddg',
      url: 'https://x/1',
    });

    assert.equal(result, null);
    assert.deepEqual(tagNamesOf(api, api.store.items[0].id), [SEARCH_ROUND_TAG]);
  });

  it('with no front window at all the answer is null and the search is still recorded', async () => {
    api = makeApi({ frontWindowId: null });

    const result = await recordSearchRound(api, {
      query: 'otter diet',
      engineId: 'ddg',
      url: 'https://x/1',
    });

    assert.equal(result, null);
    assert.equal(api.store.items.length, 1);
  });

  it('an empty query records nothing', async () => {
    for (const query of ['', '   ', undefined, null]) {
      const result = await recordSearchRound(api, { query, engineId: 'ddg', url: 'https://x/1' });
      assert.equal(result, null);
    }

    assert.equal(api.store.items.length, 0);
    assert.equal(api.store.events.length, 0);
  });

  it('a datastore error still returns the space mode so the search opens', async () => {
    api = makeApi({ mode: spaceMode('tag-space-1', 'research'), failOn: 'addItem' });

    const result = await recordSearchRound(api, {
      query: 'otter diet',
      engineId: 'ddg',
      url: 'https://x/1',
    });

    assert.deepEqual(result, { spaceId: 'tag-space-1', spaceName: 'research', color: '#3366ff' });
    assert.equal(api.store.items.length, 0);
  });

  it('an event-write error still returns so the search opens', async () => {
    api = makeApi({ failOn: 'addItemEvent' });

    const result = await recordSearchRound(api, {
      query: 'otter diet',
      engineId: 'ddg',
      url: 'https://x/1',
    });

    assert.equal(result, null);
    assert.equal(api.store.items.length, 1, 'the item was still created');
    assert.equal(api.store.events.length, 0);
  });

  it('spaceOfFrontWindow answers null when the mode lookup fails', async () => {
    api = makeApi();
    api.context.get = async () => ({ success: false, error: 'no context capability' });

    assert.equal(await spaceOfFrontWindow(api), null);
  });
});

describe('tagging the result page into the space', () => {
  const pageUrl = 'https://x/search?q=otter';
  const mode = { spaceId: 'tag-space-1', spaceName: 'research', color: '#3366ff' };

  const withPage = () => {
    const api = makeApi({ mode: spaceMode('tag-space-1', 'research') });
    api.store.items.push({ id: 'page-1', type: 'url', content: pageUrl });
    return api;
  };

  it('tags the tracked page item with the space tag', async () => {
    const api = withPage();

    assert.equal(await tagResultPageInSpace(api, { url: pageUrl, spaceMode: mode }), true);
    assert.deepEqual(tagNamesOf(api, 'page-1'), ['space:research']);
  });

  it('does nothing outside a space', async () => {
    const api = withPage();

    assert.equal(await tagResultPageInSpace(api, { url: pageUrl, spaceMode: null }), false);
    assert.deepEqual(tagNamesOf(api, 'page-1'), []);
  });

  it('does nothing when no page item was tracked for the URL', async () => {
    const api = makeApi({ mode: spaceMode('tag-space-1', 'research') });

    assert.equal(await tagResultPageInSpace(api, { url: pageUrl, spaceMode: mode }), false);
    assert.equal(api.store.itemTags.length, 0);
  });

  it('answers false rather than throwing when the lookup fails', async () => {
    const api = makeApi({ mode: spaceMode('tag-space-1', 'research'), failOn: 'findUrlItem' });
    api.store.items.push({ id: 'page-1', type: 'url', content: pageUrl });

    assert.equal(await tagResultPageInSpace(api, { url: pageUrl, spaceMode: mode }), false);
    assert.deepEqual(tagNamesOf(api, 'page-1'), []);
  });
});
