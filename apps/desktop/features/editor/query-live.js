/**
 * Live updates for the tag-query view: re-resolve the query when items, tags or
 * rules change and work out what the document has to do about it.
 *
 * diffBlocks(), liveAction() and blockSignature() are pure so the decisions are
 * unit tested; resolveTagQuery() and startQueryLive() need the datastore and the
 * pubsub, and load their peek:// imports on first use so the pure part stays
 * importable in node.
 */

/** Pubsub topics whose events can change what the query shows. */
export const LIVE_TOPICS = [
  'tag:item-added',
  'tag:item-removed',
  'tag:created',
  'tag:deleted',
  'tag:renamed',
  'item:created',
  'item:updated',
  'item:deleted',
  'sync:pull-completed',
  'rules:changed',
];

/** How long a block that left the query stays on screen, frozen and fading. */
export const LEAVE_MS = 1200;

/**
 * Compare the blocks on screen with a fresh query result.
 * @param {string[]} currentIds ids of the blocks on screen
 * @param {Array<{id: string}>} nextItems the query result, in display order
 * @returns {{added: object[], removed: string[], kept: object[]}} `added`: items
 *   with no block yet; `removed`: ids of blocks whose item is no longer in the
 *   result (retagged out, or deleted); `kept`: items that still have a block, in
 *   result order
 */
export function diffBlocks(currentIds, nextItems) {
  const current = new Set(currentIds);
  const next = new Set(nextItems.map(item => item.id));
  return {
    added: nextItems.filter(item => !current.has(item.id)),
    removed: currentIds.filter(id => !next.has(id)),
    kept: nextItems.filter(item => current.has(item.id)),
  };
}

/**
 * What to do with one block when its item changes.
 * @param {{open: boolean}} block `open`: its inline editor is open
 * @param {'changed'|'left'|'deleted'} change `changed`: the item is still in the
 *   query with new data; `left`: retagged out of the query; `deleted`: gone
 * @returns {'update'|'keep-editor'|'freeze-fade'|'freeze-fade-on-close'|'none'}
 *   `keep-editor`: the open editor keeps its text, the stored version shows once
 *   it is closed; `freeze-fade-on-close`: the open editor stays until closed, then
 *   the block fades (the pending text is written first, unless deleted)
 */
export function liveAction(block, change) {
  if (change === 'changed') return block.open ? 'keep-editor' : 'update';
  if (change === 'left' || change === 'deleted') {
    return block.open ? 'freeze-fade-on-close' : 'freeze-fade';
  }
  return 'none';
}

/** A string that differs when a block would render differently. */
export function blockSignature(item, tagNames) {
  return JSON.stringify([item, tagNames || []]);
}

/**
 * Resolve a tag query against the datastore: items carrying every tag, limited
 * to the types the document shows, and each item's tag names.
 * @param {object} api window.app
 * @param {string[]} tagNames
 * @returns {Promise<{items: object[], unknownTags: string[], itemTags: Map<string, string[]>}>}
 */
export async function resolveTagQuery(api, tagNames) {
  const { findTagByName } = await import('peek://cmd/item-suggestions.js');
  const { intersectItems } = await import('peek://cmd/tag-query.js');
  const { isBlockItem } = await import('./query-blocks.js');

  const unknownTags = [];
  const itemLists = [];
  try {
    const tagsResult = await api.datastore.getTagsByFrecency();
    const allTags = tagsResult?.success ? (tagsResult.data || []) : [];
    for (const name of tagNames) {
      const tag = findTagByName(allTags, name);
      if (!tag) {
        unknownTags.push(name);
        continue;
      }
      const itemsResult = await api.datastore.getItemsByTag(tag.id);
      itemLists.push(itemsResult?.success ? (itemsResult.data || []) : []);
    }
  } catch (err) {
    console.error('[editor] Failed to resolve tag query:', err);
  }
  const items = unknownTags.length > 0 ? [] : intersectItems(itemLists).filter(isBlockItem);

  const itemTags = new Map();
  if (items.length > 0) {
    try {
      const allTagsResult = await api.datastore.getAllItemTags();
      const allTagsMap = allTagsResult?.success ? (allTagsResult.data || {}) : {};
      for (const item of items) {
        itemTags.set(item.id, (allTagsMap[item.id] || []).map(t => t.name));
      }
    } catch (err) {
      console.error('[editor] Failed to load item tags:', err);
    }
  }
  return { items, unknownTags, itemTags };
}

/**
 * Re-resolve the query whenever an item, tag or rule changes (debounced, and not
 * while the window is hidden) and hand the result to `onResult`.
 * @param {object} deps
 * @param {object} deps.api window.app
 * @param {string[]} deps.tagNames
 * @param {(result: {items: object[], unknownTags: string[], itemTags: Map}) => void} deps.onResult
 * @returns {Promise<{destroy: () => void}>}
 */
export async function startQueryLive({ api, tagNames, onResult }) {
  const { liveQuery } = await import('peek://app/lib/live-query.js');
  return liveQuery({
    api,
    topics: LIVE_TOPICS,
    runImmediately: false,
    query: () => resolveTagQuery(api, tagNames),
    onUpdate: onResult,
  });
}
