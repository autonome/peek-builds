/**
 * The API object a headless `feeds` gets, backed by `openRemoteStore()`.
 *
 * Two contracts meet here and they are not the same contract:
 *
 *  - Feature code calls the tile API described by `apps/desktop/main/tile-api.d.ts`
 *    (`TileDatastore`): `addItem(type, options)`, `queryItemEvents(filter)`,
 *    `deleteItemEvents(itemId)` and friends, every one of them resolving to a
 *    `{ success, data }` envelope and never throwing.
 *  - `PeekStore` in `apps/desktop/features/mcp-server/store/types.js` returns
 *    raw values and throws on failure, and its method set is a different set.
 *
 * Everything between them is recorded in the gap ledger rather than smoothed
 * over, because the gaps are the finding. `recordGap()` classifies each distinct
 * feature-facing call once:
 *
 *   exact        — the store has the same operation with the same fidelity
 *   approximated — it round-trips, but something is lost or costs more requests
 *   impossible   — no route exists; the call throws
 *
 * Namespaces a worker does not get (`window`, `shortcuts`) are absent rather
 * than stubbed, per the decision in `docs/workers-design.md` §5: a `TypeError`
 * naming the missing namespace is the point, and a `{ success: false }` stub
 * would let the feature carry on past its own mistake.
 */

/** @type {Map<string, {verdict: string, note: string, calls: number}>} */
const gaps = new Map();

function recordGap(call, verdict, note) {
  const existing = gaps.get(call);
  if (existing) {
    existing.calls += 1;
    return;
  }
  gaps.set(call, { verdict, note, calls: 1 });
}

export function gapLedger() {
  return [...gaps.entries()].map(([call, rest]) => ({ call, ...rest }));
}

/** How many times one feature-facing call has been made so far. */
export function callCount(call) {
  return gaps.get(call)?.calls ?? 0;
}

/** Every network request the feature made, and whether the manifest allowed it. */
export const networkLog = [];

function ok(data) {
  return { success: true, data };
}

function fail(error) {
  return { success: false, error: error?.message || String(error) };
}

/**
 * The type label every feed entry is written under.
 *
 * `POST /mcp/items/:id/events` requires a `type`, and the tile API's
 * `addItemEvent(itemId, options)` has no field that corresponds to one — its
 * options are content/value/occurredAt/metadata (`addItemEvent()` in
 * `apps/desktop/main/datastore.ts`). The constant fills the required field. It
 * is not stored: `item_events` has one column for a row's content and a row's
 * type, and `recordEvent()` in `apps/server/mcp-items.js` resolves it as
 * `content ?? type`, so a write that supplies content — every write here does —
 * keeps the content and drops the label. Nothing reads it back, which is why
 * nothing below filters on it.
 */
const ENTRY_EVENT_TYPE = 'feed-entry';

/**
 * One row from `GET /mcp/items/:id/events` in the shape the tile API's
 * `queryItemEvents()` returns — `content`, `occurredAt` and `metadata` are the
 * columns of those names on both sides, so this is a rename of `itemId` onto
 * the row and nothing more.
 *
 * `metadata` stays a raw JSON string, matching the local path
 * (`queryItemEvents()` in `apps/desktop/main/datastore.ts` selects the column
 * unparsed) as well as the route.
 */
function toEntryEvent(event, itemId) {
  return {
    id: event.id,
    itemId,
    content: event.content ?? '',
    occurredAt: event.occurredAt,
    metadata: event.metadata ?? '{}',
    value: event.value,
  };
}

function buildDatastore(store) {
  return {
    async queryItems(filter = {}) {
      recordGap(
        'datastore.queryItems',
        'exact',
        'PeekStore.queryItems takes the same type filter; the grant scope tag narrows the result server-side.'
      );
      try {
        return ok(await store.queryItems(filter));
      } catch (err) {
        return fail(err);
      }
    },

    async addItem(type, options = {}) {
      recordGap(
        'datastore.addItem',
        'approximated',
        'Maps to PeekStore.createItem({type, ...options}); the signature differs (type is positional here, a body field there) and the grant scope tag is force-added by mcp-items.js createItem().'
      );
      try {
        return ok(await store.createItem({ type, ...options }));
      } catch (err) {
        return fail(err);
      }
    },

    async getItem(id) {
      recordGap('datastore.getItem', 'exact', 'PeekStore.getItem returns the same item shape, or null for a miss.');
      try {
        return ok(await store.getItem(id));
      } catch (err) {
        return fail(err);
      }
    },

    async updateItem(id, patch = {}) {
      recordGap(
        'datastore.updateItem',
        'exact',
        'PATCH /mcp/items/:id reads title, content and metadata; feeds patches only metadata.'
      );
      try {
        return ok(await store.updateItem(id, patch));
      } catch (err) {
        return fail(err);
      }
    },

    async deleteItem(id) {
      recordGap('datastore.deleteItem', 'exact', 'PeekStore.deleteItem is the same operation.');
      try {
        return ok(await store.deleteItem(id));
      } catch (err) {
        return fail(err);
      }
    },

    async addItemEvent(itemId, options = {}) {
      recordGap(
        'datastore.addItemEvent',
        'exact',
        'PeekStore.recordEvent(id, type, value, {content, occurredAt, metadata}) stores content, occurredAt and metadata in the columns of those names, the same three the local addItemEvent() writes. The route\'s required `type` has no counterpart in the tile API and is not stored; `value` must be a number or empty when metadata is supplied, which is what feeds sends.'
      );
      try {
        return ok(
          await store.recordEvent(itemId, ENTRY_EVENT_TYPE, options.value ?? '', {
            content: options.content,
            occurredAt: options.occurredAt,
            metadata: options.metadata,
          })
        );
      } catch (err) {
        return fail(err);
      }
    },

    async queryItemEvents(filter = {}) {
      recordGap(
        'datastore.queryItemEvents',
        'approximated',
        'PeekStore.listEvents(id, {limit}) reads an item\'s events on their own, up to 200 — the local query has no cap but nothing here asks for more. It still costs one request per item, and since/until/order have no query parameters on the route, so they are applied to the rows after the read rather than in SQL.'
      );
      const ids = filter.itemIds ?? (filter.itemId ? [filter.itemId] : []);
      if (ids.length === 0) return ok([]);

      try {
        const events = [];
        for (const id of ids) {
          for (const event of await store.listEvents(id, { limit: filter.limit })) {
            if (filter.since !== undefined && event.occurredAt < filter.since) continue;
            if (filter.until !== undefined && event.occurredAt > filter.until) continue;
            events.push(toEntryEvent(event, id));
          }
        }
        events.sort((a, b) => (filter.order === 'asc' ? a.occurredAt - b.occurredAt : b.occurredAt - a.occurredAt));
        return ok(filter.limit ? events.slice(0, filter.limit) : events);
      } catch (err) {
        return fail(err);
      }
    },

    async deleteItemEvents(itemId) {
      recordGap(
        'datastore.deleteItemEvents',
        'exact',
        'DELETE /mcp/items/:id/events removes every event under one item and reports the count, the same operation as the local deleteItemEvents().'
      );
      try {
        return ok(await store.deleteEvents(itemId));
      } catch (err) {
        return fail(err);
      }
    },
  };
}

/**
 * A pubsub bus confined to this process.
 *
 * Nothing outside delivers to it: the design's duplex channel
 * (`docs/workers-design.md` §9.4) does not exist yet, so a topic another feature
 * would have published — `item:created`, which is how `feeds` learns about a
 * subscription made elsewhere — simply never arrives. Subscriptions are recorded
 * so the report can say which ones went unfed.
 */
function buildPubsub() {
  const subscribers = new Map();
  const published = [];
  const subscribed = [];

  function subscribe(topic, handler) {
    subscribed.push(topic);
    if (!subscribers.has(topic)) subscribers.set(topic, []);
    subscribers.get(topic).push(handler);
    return () => {};
  }

  function publish(topic, message) {
    published.push(topic);
    for (const handler of subscribers.get(topic) ?? []) {
      try { handler(message); } catch { /* a subscriber's failure is its own */ }
    }
  }

  return { subscribe, publish, published, subscribed };
}

/**
 * Wrap the global `fetch` so the manifest's `network.domains` means something.
 *
 * `feeds/background.js` calls bare `fetch()`, not `api.network.fetch()`. Under
 * Electron the declared capability is enforced by CSP rather than by the
 * manifest, so in a plain Node process the declaration is decorative unless the
 * host intercepts the global — the requirement stated in
 * `docs/workers-design.md` §9.2.
 */
export function installNetworkGuard(domains) {
  const original = globalThis.fetch;
  const allowAll = domains.includes('*');

  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    let host = '';
    try { host = new URL(url).hostname; } catch { /* leave blank */ }

    const allowed = allowAll || domains.some((d) => host === d || host.endsWith(`.${d}`));
    networkLog.push({ url, host, allowed });
    if (!allowed) {
      throw new Error(`network capability does not cover ${host} (manifest allows: ${domains.join(', ')})`);
    }
    return original(input, init);
  };
}

/**
 * Build the object the feature sees as `window.app`.
 *
 * Shaped as the desktop object with namespaces missing rather than as a
 * separate, smaller object — the assumption `docs/workers-design.md` §5 makes
 * and open question 5 asks about.
 */
export function buildWorkerApi({ store, log = console.log }) {
  const pubsub = buildPubsub();
  const commands = [];

  return {
    datastore: buildDatastore(store),

    pubsub: { subscribe: pubsub.subscribe, publish: pubsub.publish },
    subscribe: pubsub.subscribe,
    publish: pubsub.publish,

    commands: {
      register(command) {
        commands.push(command.name);
        return { success: true };
      },
      unregister(name) {
        const at = commands.indexOf(name);
        if (at !== -1) commands.splice(at, 1);
        return { success: true };
      },
    },

    settings: {
      async get() { return ok(null); },
      async set() { return ok(null); },
    },

    log: (...args) => log('[feature]', ...args),

    // Deliberately absent, not stubbed: window, shortcuts, izui, nav, theme,
    // filesystem, shell — see the file comment.

    _inspect: { pubsub, commands },
  };
}
