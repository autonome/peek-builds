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
 * The type name every feed entry is recorded under.
 *
 * `POST /mcp/items/:id/events` (`apps/server/index.js`, reaching
 * `apps/server/mcp-items.js recordEvent()`) writes the event's type name into
 * the row's `content` column, hardcodes `value` to 0 and stamps `occurredAt`
 * with the server's clock. The only field that survives from the caller is the
 * `value` string, which lands in `metadata.notes`. A feed entry therefore has to
 * travel as one JSON string inside that field.
 */
const ENTRY_EVENT_TYPE = 'feed-entry';

function encodeEntryEvent(options) {
  return JSON.stringify({
    content: options.content ?? '',
    occurredAt: options.occurredAt ?? Date.now(),
    metadata: options.metadata ?? '{}',
  });
}

function decodeEntryEvent(event, itemId) {
  // `fetchEvents()` in `apps/server/mcp-items.js` returns `metadata` as a raw
  // JSON string while the item's own metadata comes back parsed — the asymmetry
  // is the server's, not this adapter's.
  let notes = null;
  try {
    notes = JSON.parse(event.metadata || '{}').notes;
  } catch { /* leave null */ }

  let payload = null;
  if (typeof notes === 'string') {
    try { payload = JSON.parse(notes); } catch { /* leave null */ }
  }

  return {
    id: event.id,
    itemId,
    content: payload?.content ?? '',
    occurredAt: payload?.occurredAt ?? event.occurredAt,
    metadata: payload?.metadata ?? '{}',
    // What the row actually holds, kept alongside so a caller can see the loss.
    serverOccurredAt: event.occurredAt,
    serverValue: event.value,
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
        'approximated',
        'PeekStore.recordEvent(id, type, value) is the only write path. The row\'s content column receives the type name, value is hardcoded to 0 and occurredAt is the server clock, so the entry\'s link, publication time and metadata all have to travel as one JSON string in metadata.notes.'
      );
      try {
        return ok(await store.recordEvent(itemId, ENTRY_EVENT_TYPE, encodeEntryEvent(options)));
      } catch (err) {
        return fail(err);
      }
    },

    async queryItemEvents(filter = {}) {
      recordGap(
        'datastore.queryItemEvents',
        'approximated',
        'No route queries item events on their own. The only read path is GET /mcp/items/:id?events=N, which costs one request per item and is capped at 20 events by fetchEvents() regardless of the requested limit.'
      );
      const ids = filter.itemIds ?? (filter.itemId ? [filter.itemId] : []);
      if (ids.length === 0) return ok([]);

      try {
        const events = [];
        for (const id of ids) {
          const item = await store.getItem(id, { events: filter.limit ?? 20 });
          for (const event of item?.events ?? []) {
            if (event.type !== ENTRY_EVENT_TYPE) continue;
            events.push(decodeEntryEvent(event, id));
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
        'impossible',
        'The /mcp/* API has no route that deletes an item event, individually or in bulk. Unsubscribing from a feed cannot clean up its entries.'
      );
      throw new Error(
        `datastore.deleteItemEvents(${itemId}) has no remote route — the /mcp/* API cannot delete item events.`
      );
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
