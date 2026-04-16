/**
 * Tag event helpers
 *
 * Centralizes the "tag an item and publish the corresponding pubsub event"
 * flow. Lives in its own module (rather than inside ipc.ts) so non-IPC
 * main-process callers — like sync.ts — can use it without pulling ipc.ts
 * back into their import graph (which would create a cycle: ipc.ts already
 * imports from sync.ts).
 *
 * UIs listening for `tag:item-added` / `tag:item-removed` (groups widget,
 * page tags widget, etc.) rely on these events. Callers that mutate
 * item_tags directly but skip publishing will silently break reactive
 * updates — so prefer these helpers over bare `tagItem()` / `untagItem()`
 * whenever the mutation should be reflected in the UI.
 */

import { getDb, tagItem, untagItem } from './datastore.js';
import { publish, scopes as PubSubScopes } from './pubsub.js';

/**
 * Tag an item and publish `tag:item-added` on the GLOBAL scope so UIs
 * update reactively. Returns the underlying tagItem result so callers
 * can inspect `alreadyExists` without a second lookup.
 *
 * The event is only published when the link is newly created — re-tagging
 * an already-tagged item is a no-op from the UI's perspective.
 */
export function tagItemAndPublish(
  itemId: string,
  tagId: string,
): { link: unknown; alreadyExists: boolean } {
  const result = tagItem(itemId, tagId);
  if (!result.alreadyExists) {
    const db = getDb();
    const tag = db.prepare('SELECT name FROM tags WHERE id = ?').get(tagId) as { name: string } | undefined;
    const item = db.prepare('SELECT type FROM items WHERE id = ?').get(itemId) as { type: string } | undefined;
    publish('system', PubSubScopes.GLOBAL, 'tag:item-added', {
      tagId,
      tagName: tag?.name,
      itemId,
      itemType: item?.type,
    });
  }
  return result;
}

/**
 * Untag an item and publish `tag:item-removed` on the GLOBAL scope so UIs
 * update reactively. Returns the underlying untagItem result (true if a
 * row was actually removed).
 */
export function untagItemAndPublish(itemId: string, tagId: string): boolean {
  const db = getDb();
  const tag = db.prepare('SELECT name FROM tags WHERE id = ?').get(tagId) as { name: string } | undefined;
  const removed = untagItem(itemId, tagId);
  if (removed) {
    publish('system', PubSubScopes.GLOBAL, 'tag:item-removed', {
      tagId,
      tagName: tag?.name,
      itemId,
    });
  }
  return removed;
}
