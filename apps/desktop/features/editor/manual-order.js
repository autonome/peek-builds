/**
 * Manual block order for the tag-query view. The order is a list of item ids,
 * stored per query under a key derived from the query's sorted tag set, so it
 * survives closing the window and switching to another sort option and back.
 *
 * Items that are not in the stored list (new ones, including items added from
 * the view) come first, in the order they are given; items listed in the stored
 * list follow in stored order. Stored ids that match no current item are ignored
 * when ordering and dropped when the list is next written.
 *
 * Pure functions plus two thin storage helpers that take the Storage to use.
 */

/** localStorage key prefix; the layout and highlight state use the same mechanism. */
export const ORDER_KEY_PREFIX = 'editor:query-order:';

/**
 * @param {string} key the query's key from tag-query.js queryKey (sorted tag set)
 * @returns {string}
 */
export function orderStorageKey(key) {
  return ORDER_KEY_PREFIX + key;
}

/**
 * Items in manual order.
 * @param {Array<{id: string}>} items
 * @param {string[]} orderedIds stored order (may hold stale or duplicate ids)
 * @param {(items: Array<object>) => Array<object>} [sortFresh] orders the items
 *   that are not in `orderedIds`; defaults to keeping their input order
 */
export function applyManualOrder(items, orderedIds, sortFresh = (list) => list) {
  const byId = new Map(items.map(item => [item.id, item]));
  const placed = new Set();
  const listed = [];
  for (const id of orderedIds || []) {
    const item = byId.get(id);
    if (!item || placed.has(id)) continue;
    placed.add(id);
    listed.push(item);
  }
  const fresh = sortFresh(items.filter(item => !placed.has(item.id)));
  return [...fresh, ...listed];
}

/**
 * The stored list reconciled with the current items: ids that no longer exist
 * are dropped, and ids not yet stored go first in `currentIds` order. An
 * unchanged list comes back with the same contents.
 * @param {string[]} currentIds ids now displayed, in display order
 * @param {string[]} orderedIds
 * @returns {string[]}
 */
export function ensureOrder(currentIds, orderedIds) {
  const current = new Set(currentIds);
  const kept = [];
  const seen = new Set();
  for (const id of orderedIds || []) {
    if (!current.has(id) || seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
  }
  return [...currentIds.filter(id => !seen.has(id)), ...kept];
}

/**
 * The id list a reorder starts from. In manual order it is the stored list
 * reconciled with the current items. In any other sort option the stored list
 * is not what is on screen, so the list is seeded from the displayed order and
 * the stored one is replaced.
 * @param {string[]} displayedIds ids now displayed, in display order
 * @param {string[]} orderedIds stored order
 * @param {boolean} isManual whether the view is in manual order
 * @returns {string[]}
 */
export function reorderBase(displayedIds, orderedIds, isManual) {
  return isManual ? ensureOrder(displayedIds, orderedIds) : displayedIds.slice();
}

/**
 * New id list with `id` moved by `delta` places (negative is up), stopping at
 * either end. An id that is not in the list leaves it unchanged.
 * @param {string[]} orderedIds
 * @param {string} id
 * @param {number} delta
 * @returns {string[]}
 */
export function moveBlock(orderedIds, id, delta) {
  const from = orderedIds.indexOf(id);
  if (from < 0) return orderedIds.slice();
  const to = Math.max(0, Math.min(orderedIds.length - 1, from + delta));
  const out = orderedIds.slice();
  out.splice(from, 1);
  out.splice(to, 0, id);
  return out;
}

/**
 * New id list with `id` taken out and put just before (or, with `after`, just
 * after) `targetId`. Either id missing from the list, or `id` being `targetId`,
 * leaves the list unchanged.
 * @param {string[]} orderedIds
 * @param {string} id the dragged block
 * @param {string} targetId the block dropped on
 * @param {boolean} after place after the target instead of before it
 * @returns {string[]}
 */
export function moveBlockTo(orderedIds, id, targetId, after) {
  if (id === targetId || !orderedIds.includes(id) || !orderedIds.includes(targetId)) {
    return orderedIds.slice();
  }
  const out = orderedIds.filter(other => other !== id);
  out.splice(out.indexOf(targetId) + (after ? 1 : 0), 0, id);
  return out;
}

/**
 * Stored order for a query; an empty list when nothing is stored or it is unreadable.
 * @param {string} key query key
 * @param {Pick<Storage, 'getItem'>} storage
 * @returns {string[]}
 */
export function loadOrder(key, storage) {
  try {
    const parsed = JSON.parse(storage.getItem(orderStorageKey(key)) || '[]');
    return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * @param {string} key query key
 * @param {string[]} orderedIds
 * @param {Pick<Storage, 'setItem'>} storage
 */
export function saveOrder(key, orderedIds, storage) {
  try {
    storage.setItem(orderStorageKey(key), JSON.stringify(orderedIds));
  } catch { /* storage unavailable: the order lasts for this window only */ }
}
