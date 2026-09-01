/**
 * Tests for the HTTP PeekStore implementation (`./remote-store.js`) and the
 * factory selection in `./index.js`. Stubs `global.fetch` throughout — no
 * real network, no real `apps/server` — so these run in the same fast node
 * test process as everything else in this directory.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openRemoteStore } from './remote-store.js';
import { openStore } from './index.js';

const FAKE_URL = 'https://sync.example.test';
const FAKE_TOKEN = 'fake-grant-token-do-not-use';

let originalFetch;
let calls;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Queues one handler per expected fetch() call; the last handler repeats for
// any call beyond the queue's length. Each handler returns either a fake
// Response ({status, json}) or throws (simulating a transport failure).
function stubFetch(handlers) {
  let i = 0;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const handler = handlers[Math.min(i, handlers.length - 1)];
    i++;
    return handler(url, opts);
  };
}

function fakeResponse(status, json) {
  return {
    status,
    text: async () => (json === undefined ? '' : JSON.stringify(json)),
  };
}

function networkFailure(message = 'fetch failed') {
  return () => { throw new TypeError(message); };
}

describe('openRemoteStore()', () => {
  describe('the unexpanded-${VAR} guard (design doc §6)', () => {
    it('fails at open time when the token was not expanded, before any request', async () => {
      stubFetch([() => { throw new Error('fetch must not be called'); }]);
      await assert.rejects(
        () => openRemoteStore({ remoteUrl: FAKE_URL, credential: '${PEEK_MCP_TOKEN}' }),
        /PEEK_MCP_TOKEN was not expanded/,
      );
      assert.strictEqual(calls.length, 0, 'no request should go out with an unresolved token');
    });

    it('fails at open time when the remote url was not expanded', async () => {
      stubFetch([() => { throw new Error('fetch must not be called'); }]);
      await assert.rejects(
        () => openRemoteStore({ remoteUrl: '${PEEK_SYNC_URL}', credential: FAKE_TOKEN }),
        /PEEK_MCP_REMOTE_URL was not expanded/,
      );
      assert.strictEqual(calls.length, 0);
    });

    it('opens normally once both are resolved', async () => {
      stubFetch([() => fakeResponse(200, { items: [] })]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      await assert.doesNotReject(() => store.queryItems({}));
    });
  });

  describe('network failure is a tool error, never a degraded read (design doc §7.1)', () => {
    it('rejects — does not resolve with an empty/degraded list — when the server is unreachable', async () => {
      stubFetch([networkFailure(), networkFailure(), networkFailure()]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      await assert.rejects(
        () => store.queryItems({}),
        (err) => {
          assert.match(err.message, /Peek remote store unreachable at https:\/\/sync\.example\.test/);
          assert.match(err.message, /fetch failed/);
          return true;
        },
      );
    });

    it('retries a transient blip and succeeds without surfacing an error', async () => {
      stubFetch([networkFailure(), () => fakeResponse(200, { items: [{ id: 'a' }] })]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      const items = await store.queryItems({});
      assert.deepStrictEqual(items, [{ id: 'a' }]);
      assert.strictEqual(calls.length, 2, 'one failed attempt, one recovering attempt');
    });

    it('gives up after three attempts, not fewer and not more', async () => {
      stubFetch([networkFailure(), networkFailure(), networkFailure(), networkFailure()]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      await assert.rejects(() => store.listTags({}));
      assert.strictEqual(calls.length, 3);
    });

    it('never includes the credential in the thrown error', async () => {
      stubFetch([networkFailure('ECONNREFUSED'), networkFailure('ECONNREFUSED'), networkFailure('ECONNREFUSED')]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      await assert.rejects(
        () => store.getItem('abc'),
        (err) => {
          assert.ok(!err.message.includes(FAKE_TOKEN));
          assert.ok(!(err.stack || '').includes(FAKE_TOKEN));
          return true;
        },
      );
    });

    it('does not retry a response that actually arrived (e.g. a 500) — that is not a network failure', async () => {
      stubFetch([() => fakeResponse(500, { error: 'boom' })]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      await assert.rejects(() => store.listTags({}), /HTTP 500/);
      assert.strictEqual(calls.length, 1, 'a real response short-circuits the retry loop');
    });

    it('a 401 (bad/revoked credential) is a tool error, never included in the message', async () => {
      stubFetch([() => fakeResponse(401, { error: 'Unauthorized' })]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      await assert.rejects(
        () => store.queryItems({}),
        (err) => {
          assert.match(err.message, /HTTP 401/);
          assert.ok(!err.message.includes(FAKE_TOKEN));
          return true;
        },
      );
    });
  });

  describe('prefix resolution costs one round trip, never one per candidate (design doc §5)', () => {
    it('resolveItemId() issues exactly one request regardless of candidate count', async () => {
      const candidates = Array.from({ length: 8 }, (_, i) => ({ id: `item_${i}`, title: `t${i}` }));
      stubFetch([() => fakeResponse(200, { id: null, ambiguous: true, candidates, truncated: false })]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      const result = await store.resolveItemId('item_');
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(result, { id: null, ambiguous: true, candidates, truncated: false });
    });

    it('forwards the 409 ambiguity payload in the exact shape formatAmbiguous() expects', async () => {
      // server.js formatAmbiguous(prefix, candidates, truncated) reads
      // candidates as {id, title} objects and truncated as a boolean —
      // pinning that mapping here since it crosses the HTTP boundary.
      stubFetch([() => fakeResponse(200, {
        id: null, ambiguous: true,
        candidates: [{ id: 'item_1', title: 'One' }, { id: 'item_2', title: 'Two' }],
        truncated: true,
      })]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      const result = await store.resolveItemId('item_');
      assert.strictEqual(result.ambiguous, true);
      assert.strictEqual(result.id, null);
      assert.strictEqual(result.truncated, true);
      assert.deepStrictEqual(result.candidates, [{ id: 'item_1', title: 'One' }, { id: 'item_2', title: 'Two' }]);
    });

    it('a unique prefix resolves to {id} in one request', async () => {
      stubFetch([() => fakeResponse(200, { id: 'item_full_id' })]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      const result = await store.resolveItemId('item_f');
      assert.deepStrictEqual(result, { id: 'item_full_id' });
      assert.strictEqual(calls.length, 1);
      assert.ok(calls[0].url.includes('/mcp/items/resolve'));
      assert.ok(calls[0].url.includes('prefix=item_f'));
    });

    it('a miss resolves to {id: null} in one request', async () => {
      stubFetch([() => fakeResponse(200, { id: null })]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      const result = await store.resolveItemId('nope');
      assert.deepStrictEqual(result, { id: null });
      assert.strictEqual(calls.length, 1);
    });
  });

  describe('shape parity with sqlite-store.js — a caller cannot tell the two apart', () => {
    it('getItem: 200 returns the item, 404 returns null, 409 throws an ambiguity error', async () => {
      stubFetch([() => fakeResponse(200, { item: { id: 'x', title: 'X', tags: [] } })]);
      let store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      assert.deepStrictEqual(await store.getItem('x'), { id: 'x', title: 'X', tags: [] });

      stubFetch([() => fakeResponse(404, { error: 'item not found' })]);
      store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      assert.strictEqual(await store.getItem('missing'), null);

      stubFetch([() => fakeResponse(409, {
        id: null, ambiguous: true, candidates: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], truncated: false,
      })]);
      store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      await assert.rejects(() => store.getItem('a'), /Ambiguous item id prefix/);
    });

    it('getItemTags: reads tags off the fetched item, [] when the item is missing', async () => {
      stubFetch([() => fakeResponse(200, { item: { id: 'x', tags: ['peek', 'peek:todo'] } })]);
      let store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      assert.deepStrictEqual(await store.getItemTags('x'), ['peek', 'peek:todo']);

      stubFetch([() => fakeResponse(404, { error: 'item not found' })]);
      store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      assert.deepStrictEqual(await store.getItemTags('missing'), []);
    });

    it('createItem: posts the input and returns the created ItemView', async () => {
      let sentBody;
      stubFetch([(url, opts) => { sentBody = JSON.parse(opts.body); return fakeResponse(200, { item: { id: 'new1', ...sentBody } }); }]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      const input = { type: 'text', title: 'hi', content: 'body', tags: ['peek'] };
      const created = await store.createItem(input);
      assert.strictEqual(created.id, 'new1');
      assert.deepStrictEqual(sentBody, input);
    });

    it('createItem: a 400 (e.g. foreign-namespace tag) throws with the server\'s message', async () => {
      stubFetch([() => fakeResponse(400, { error: 'Tag "other:x" is outside scope "peek".' })]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      await assert.rejects(() => store.createItem({ type: 'text' }), /outside scope "peek"/);
    });

    it('updateItem: 200 returns the patched item, 404 throws', async () => {
      stubFetch([() => fakeResponse(200, { item: { id: 'x', title: 'new title' } })]);
      let store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      assert.deepStrictEqual(await store.updateItem('x', { title: 'new title' }), { id: 'x', title: 'new title' });

      stubFetch([() => fakeResponse(404, { error: 'item not found' })]);
      store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      await assert.rejects(() => store.updateItem('missing', {}), /No item found/);
    });

    it('deleteItem: forwards {success, id}', async () => {
      stubFetch([() => fakeResponse(200, { success: true, id: 'x' })]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      assert.deepStrictEqual(await store.deleteItem('x'), { success: true, id: 'x' });
    });

    it('tagItem: forwards {success, itemId, tagName}', async () => {
      let sentBody;
      stubFetch([(url, opts) => { sentBody = JSON.parse(opts.body); return fakeResponse(200, { success: true, itemId: 'x', tagName: sentBody.name }); }]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      const result = await store.tagItem('x', 'peek:todo');
      assert.deepStrictEqual(result, { success: true, itemId: 'x', tagName: 'peek:todo' });
      assert.deepStrictEqual(sentBody, { name: 'peek:todo' });
    });

    it('untagItem: URL-encodes a namespaced tag name and forwards the result, including the "Tag not found" shape', async () => {
      stubFetch([() => fakeResponse(200, { success: true, itemId: 'x', tagName: 'peek:todo' })]);
      let store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      await store.untagItem('x', 'peek:todo');
      assert.ok(calls[0].url.includes('/tags/peek%3Atodo'));

      stubFetch([() => fakeResponse(200, { success: false, error: 'Tag not found' })]);
      store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      const result = await store.untagItem('x', 'nope');
      assert.deepStrictEqual(result, { success: false, error: 'Tag not found' });
    });

    it('untagItem: the orphan refusal (400) throws with the server\'s message', async () => {
      stubFetch([() => fakeResponse(400, { error: 'Cannot untag "peek" — it is the only tag keeping this item in scope "peek".' })]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      await assert.rejects(() => store.untagItem('x', 'peek'), /only tag keeping this item in scope/);
    });

    it('recordEvent: forwards {success, id, itemId, type}', async () => {
      stubFetch([() => fakeResponse(200, { success: true, id: 'ev1', itemId: 'x', type: 'started' })]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      const result = await store.recordEvent('x', 'started', 'note');
      assert.deepStrictEqual(result, { success: true, id: 'ev1', itemId: 'x', type: 'started' });
    });

    it('recordEvent: opts.content/occurredAt/metadata are sent alongside type/value, undefined fields dropped', async () => {
      let sentBody;
      stubFetch([(url, opts) => { sentBody = JSON.parse(opts.body); return fakeResponse(200, { success: true, id: 'ev1', itemId: 'x', type: 'feed_entry' }); }]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      await store.recordEvent('x', 'feed_entry', undefined, {
        content: 'https://example.com/a', occurredAt: 1700000000000, metadata: { guid: 'g1' },
      });
      assert.deepStrictEqual(sentBody, {
        type: 'feed_entry', content: 'https://example.com/a', occurredAt: 1700000000000, metadata: { guid: 'g1' },
      });
    });

    it('listEvents: GET /mcp/items/:id/events with limit/offset, returns the events array', async () => {
      stubFetch([() => fakeResponse(200, { events: [{ id: 'ev1', type: 'started' }] })]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      const events = await store.listEvents('x', { limit: 5, offset: 10 });
      assert.deepStrictEqual(events, [{ id: 'ev1', type: 'started' }]);
      assert.ok(calls[0].url.includes('/mcp/items/x/events'));
      assert.ok(calls[0].url.includes('limit=5'));
      assert.ok(calls[0].url.includes('offset=10'));

      stubFetch([() => fakeResponse(404, { error: 'item not found' })]);
      const store2 = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      await assert.rejects(() => store2.listEvents('missing'), /No item found/);
    });

    it('deleteEvent: forwards {success,...}, including the sqlite-parity {success:false} shape', async () => {
      stubFetch([() => fakeResponse(200, { success: true, id: 'ev1', itemId: 'x' })]);
      let store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      assert.deepStrictEqual(await store.deleteEvent('x', 'ev1'), { success: true, id: 'ev1', itemId: 'x' });
      assert.ok(calls[0].url.includes('/mcp/items/x/events/ev1'));

      stubFetch([() => fakeResponse(200, { success: false, error: 'Event not found' })]);
      store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      assert.deepStrictEqual(await store.deleteEvent('x', 'nope'), { success: false, error: 'Event not found' });

      stubFetch([() => fakeResponse(404, { error: 'item not found' })]);
      store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      await assert.rejects(() => store.deleteEvent('missing', 'ev1'), /No item found/);
    });

    it('deleteEvents: forwards {success, itemId, deleted}', async () => {
      stubFetch([() => fakeResponse(200, { success: true, itemId: 'x', deleted: 3 })]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      assert.deepStrictEqual(await store.deleteEvents('x'), { success: true, itemId: 'x', deleted: 3 });
      assert.ok(calls[0].url.includes('/mcp/items/x/events'));
    });

    it('listTasks: composes into a list_items call with the project tag appended', async () => {
      stubFetch([() => fakeResponse(200, { items: [] })]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      await store.listTasks({ tags: ['todo'], project: 'peek' });
      assert.strictEqual(calls.length, 1);
      assert.ok(calls[0].url.includes('/mcp/items?'));
      assert.ok(calls[0].url.includes('tags=todo%2Cpeek') || calls[0].url.includes('tags=todo,peek'));
      assert.ok(calls[0].url.includes('sort=recent'));
    });

    it('completeTask: 200 returns the updated item, 404 throws', async () => {
      stubFetch([() => fakeResponse(200, { item: { id: 'x', tags: ['done'] } })]);
      let store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      assert.deepStrictEqual(await store.completeTask('x', 'notes'), { id: 'x', tags: ['done'] });

      stubFetch([() => fakeResponse(404, { error: 'item not found' })]);
      store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      await assert.rejects(() => store.completeTask('missing'), /No item found/);
    });

    it('getTaskContext: 200 returns the item with events, 404 returns null', async () => {
      stubFetch([() => fakeResponse(200, { item: { id: 'x', events: [{ id: 'ev1', type: 'started' }] } })]);
      let store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      const ctx = await store.getTaskContext('x');
      assert.deepStrictEqual(ctx.events, [{ id: 'ev1', type: 'started' }]);
      assert.ok(calls[0].url.includes('events=20'));

      stubFetch([() => fakeResponse(404, { error: 'item not found' })]);
      store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      assert.strictEqual(await store.getTaskContext('missing'), null);
    });

    it('describe(): maps GET /mcp/session into SessionInfo with backend "remote"', async () => {
      stubFetch([() => fakeResponse(200, {
        scopeTag: 'peek', readonly: false, profileId: 'default', datastoreVersion: 7, userId: 'u1',
      })]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      const info = await store.describe();
      assert.deepStrictEqual(info, {
        scopeTag: 'peek', readonly: false, profileId: 'default', datastoreVersion: 7, backend: 'remote',
      });
    });

    it('close(): resolves without making a request', async () => {
      stubFetch([() => { throw new Error('fetch must not be called'); }]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      await assert.doesNotReject(() => store.close());
      assert.strictEqual(calls.length, 0);
    });

    it('every request carries the bearer token, and only in the Authorization header', async () => {
      stubFetch([() => fakeResponse(200, { items: [] })]);
      const store = await openRemoteStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
      await store.queryItems({ tags: ['peek'], limit: 5 });
      assert.strictEqual(calls[0].opts.headers.Authorization, `Bearer ${FAKE_TOKEN}`);
      assert.ok(!calls[0].url.includes(FAKE_TOKEN), 'token must never be a query param');
    });
  });
});

describe('openStore() selects the remote implementation when PEEK_MCP_REMOTE_URL is set', () => {
  it('routes to remote-store.js instead of throwing', async () => {
    stubFetch([() => fakeResponse(200, { items: [{ id: 'from-remote' }] })]);
    const store = await openStore({ remoteUrl: FAKE_URL, credential: FAKE_TOKEN });
    const items = await store.queryItems({});
    assert.deepStrictEqual(items, [{ id: 'from-remote' }]);
    assert.ok(calls[0].url.startsWith(FAKE_URL));
  });
});
