/**
 * Undo stack for the tag-query view: the last tag actions and block moves, most
 * recent last. Pure; the view owns one per query and drops it with the view.
 *
 * Entries:
 *   { kind: 'tag', itemId, affordance, checked }
 *     a tag action ran on an item; `affordance` is the resolved descriptor used
 *     (ruleId, activeTag, completedTag) and `checked` the state it moved the item to.
 *   { kind: 'move', previousOrder }
 *     a block was moved; `previousOrder` is the id list before the move.
 */

/** Most entries kept; the oldest is dropped past it. */
export const UNDO_LIMIT = 50;

/**
 * @param {number} [limit]
 * @returns {{push: (entry: object) => void, pop: () => (object|null),
 *   peek: () => (object|null), clear: () => void, size: () => number}}
 */
export function createUndoStack(limit = UNDO_LIMIT) {
  /** @type {object[]} */
  let entries = [];
  return {
    push(entry) {
      entries.push(entry);
      if (entries.length > limit) entries = entries.slice(entries.length - limit);
    },
    pop: () => entries.pop() || null,
    peek: () => entries[entries.length - 1] || null,
    clear() { entries = []; },
    size: () => entries.length,
  };
}

/**
 * The affordance descriptor that undoes a tag entry: triggering it (which flips
 * `checked`) publishes the inverse swap.
 * @param {{affordance: object, checked: boolean}} entry
 */
export function inverseAffordance(entry) {
  return { ...entry.affordance, checked: entry.checked };
}
