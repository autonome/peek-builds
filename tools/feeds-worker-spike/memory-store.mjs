/**
 * A `PeekStore` held in memory, standing in for the remote one when no
 * credential is present.
 *
 * It exists so the host can be exercised without a live server, and it is only
 * useful if it is faithful about the things under test. So it reproduces the
 * server's semantics rather than an idealised store's, taken from
 * `apps/server/mcp-items.js`:
 *
 *  - `recordEvent()` writes the event type name into the row's `content`
 *    column, hardcodes `value` to 0, stamps `occurredAt` with its own clock, and
 *    puts the caller's `value` string in `metadata.notes`. Nothing else the
 *    caller sends is read.
 *  - `fetchEvents()` caps at 20 events however many are requested, orders by
 *    `occurredAt` descending, and returns `metadata` as a raw JSON string while
 *    the item's own metadata comes back parsed.
 *  - `createItem()` force-adds the grant's scope tag and accepts only
 *    `type`, `url`, `title`, `content`, `metadata`, `tags`.
 *  - `updateItem()` reads only `title`, `content` and `metadata` from a patch.
 *  - There is no route to delete an item event or to query events apart from
 *    their parent item, so this store has no such method either.
 *
 * A run against it is not evidence that the real server behaves this way; it is
 * a prediction of what the real run will show, and the real run is what settles
 * it.
 */
import { randomUUID } from 'node:crypto';

const EVENT_READ_CAP = 20;
const CREATABLE_ITEM_TYPES = ['url', 'text', 'tagset', 'series', 'feed', 'entity'];

export async function openMemoryStore({ scopeTag = 'socket-proof' } = {}) {
  const items = new Map();
  const events = new Map(); // itemId -> rows

  function shape(row) {
    let metadata = {};
    try { metadata = JSON.parse(row.metadata || '{}'); } catch { /* leave empty */ }
    return { ...row, metadata, tags: [...row.tags] };
  }

  return {
    async queryItems({ type, limit, offset = 0 } = {}) {
      let rows = [...items.values()].filter((r) => !type || r.type === type);
      rows = rows.slice(offset, limit ? offset + limit : undefined);
      return rows.map(shape);
    },

    async searchItems() { return []; },

    async getItem(id, opts = {}) {
      const row = items.get(id);
      if (!row) return null;
      const item = shape(row);
      if (opts.events) {
        const all = (events.get(id) ?? []).slice().sort((a, b) => b.occurredAt - a.occurredAt);
        item.events = all.slice(0, Math.min(EVENT_READ_CAP, opts.events)).map((e) => ({
          id: e.id,
          type: e.content,
          value: e.value,
          occurredAt: e.occurredAt,
          metadata: e.metadata,
        }));
      }
      return item;
    },

    async getItemTags(id) { return items.get(id)?.tags ?? []; },
    async resolveItemId(prefix) { return { id: items.has(prefix) ? prefix : null }; },
    async listTags() { return [{ name: scopeTag }]; },
    async listTasks() { return []; },
    async getTaskContext() { return null; },

    async describe() {
      return { scopeTag, readonly: false, profileId: 'memory', datastoreVersion: 0, backend: 'memory' };
    },

    async createItem({ type, url = '', title = '', content = '', metadata = {}, tags = [] }) {
      if (!CREATABLE_ITEM_TYPES.includes(type)) {
        throw new Error(`Peek remote store: create_item failed (HTTP 400): type "${type}" is not creatable`);
      }
      const now = Date.now();
      const row = {
        id: randomUUID(),
        localId: null,
        type,
        title,
        content: content || url,
        domain: null,
        metadata: typeof metadata === 'string' ? metadata : JSON.stringify(metadata),
        tags: [...new Set([...tags, scopeTag])],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        starred: 0,
        archived: 0,
        visitCount: 0,
        frecencyScore: 0,
      };
      items.set(row.id, row);
      return shape(row);
    },

    async updateItem(id, patch = {}) {
      const row = items.get(id);
      if (!row) throw new Error(`No item found with id "${id}".`);
      if (patch.title !== undefined) row.title = patch.title;
      if (patch.content !== undefined) row.content = patch.content;
      if (patch.metadata !== undefined) {
        row.metadata = typeof patch.metadata === 'string' ? patch.metadata : JSON.stringify(patch.metadata);
      }
      row.updatedAt = Date.now();
      return shape(row);
    },

    async deleteItem(id) {
      if (!items.has(id)) throw new Error(`No item found with id "${id}".`);
      items.delete(id);
      events.delete(id);
      return { success: true, id };
    },

    async tagItem(id, name) {
      const row = items.get(id);
      if (!row) throw new Error(`No item found with id "${id}".`);
      if (!row.tags.includes(name)) row.tags.push(name);
      return { success: true };
    },

    async untagItem(id, name) {
      const row = items.get(id);
      if (!row) throw new Error(`No item found with id "${id}".`);
      row.tags = row.tags.filter((t) => t !== name);
      return { success: true };
    },

    async recordEvent(id, type, value) {
      if (!items.has(id)) throw new Error(`No item found with id "${id}".`);
      const row = {
        id: randomUUID(),
        itemId: id,
        content: type,
        value: 0,
        occurredAt: Date.now(),
        metadata: value ? JSON.stringify({ notes: value }) : '{}',
        createdAt: Date.now(),
      };
      if (!events.has(id)) events.set(id, []);
      events.get(id).push(row);
      return { success: true, id: row.id, itemId: id, type };
    },

    async completeTask() { throw new Error('not implemented in the memory store'); },
    async close() {},
  };
}
