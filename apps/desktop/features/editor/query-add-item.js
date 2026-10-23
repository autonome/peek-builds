/**
 * Add a new text item to a tag-query view, tagged with every tag in the query.
 *
 * - The item is written to the datastore straight away, so it reaches the view
 *   through the live-updates path (query-live.js) like any other item, and the
 *   caller waits for its block instead of inserting one.
 * - An item left empty when its inline editor closes is deleted again
 *   (closeEmptyAction): the new item exists only so the live path can show it, so a
 *   close without typing must not leave a blank item in the datastore. An existing
 *   item emptied and closed is deleted too, through the view's undoable delete.
 * - Tags are never created here. A query naming a tag that does not exist has no
 *   valid tag set to apply, so the add is refused (newItemPlan reports it).
 *
 * newItemPlan(), buildTagIndex(), shouldDiscard() and closeEmptyAction() are pure; createTaggedItem()
 * and discardItem() call the datastore.
 */

/** Index tag rows (as getTagsByFrecency returns them) by lower-cased name. */
export function buildTagIndex(tagRows) {
  const index = new Map();
  for (const tag of Array.isArray(tagRows) ? tagRows : []) {
    if (tag && typeof tag.name === 'string' && tag.id) index.set(tag.name.toLowerCase(), tag);
  }
  return index;
}

/**
 * What to create for a query.
 * @param {string[]} tagNames the query's tag names (case-insensitive, may repeat)
 * @param {Map<string, {id: string, name: string}>|Record<string, {id: string}>} tagsByName
 *   existing tags keyed by lower-cased name
 * @returns {{ok: boolean, item: {type: 'text', options: {content: string, title: string}}|null,
 *   tagIds: string[], unresolved: string[], reason: string}} `ok` is false when
 *   the query is empty or a tag is unresolved; `reason` then says why, in words
 *   fit for the status line
 */
export function newItemPlan(tagNames, tagsByName) {
  const lookup = (name) => (tagsByName instanceof Map ? tagsByName.get(name) : tagsByName?.[name]);
  const seen = new Set();
  const names = [];
  for (const raw of Array.isArray(tagNames) ? tagNames : []) {
    if (typeof raw !== 'string' || !raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(raw);
  }
  if (names.length === 0) {
    return { ok: false, item: null, tagIds: [], unresolved: [], reason: 'The query has no tags to apply' };
  }
  const tagIds = [];
  const unresolved = [];
  for (const name of names) {
    const tag = lookup(name.toLowerCase());
    if (tag && tag.id) tagIds.push(tag.id);
    else unresolved.push(name);
  }
  if (unresolved.length > 0) {
    const list = unresolved.map(n => '#' + n).join(' ');
    return {
      ok: false,
      item: null,
      tagIds: [],
      unresolved,
      reason: `Cannot add an item: ${list} ${unresolved.length > 1 ? 'are not existing tags' : 'is not an existing tag'}`,
    };
  }
  return { ok: true, item: { type: 'text', options: { content: '', title: '' } }, tagIds, unresolved: [], reason: '' };
}

/** True when a closed new item holds no text and should be deleted again. */
export function shouldDiscard(item) {
  if (!item || item.type !== 'text') return false;
  return typeof item.content !== 'string' || item.content.trim() === '';
}

/**
 * What to do with an item whose inline editor closed: 'discard' an empty item
 * added in this view, 'delete' (undoable) an empty existing one, else null.
 */
export function closeEmptyAction(item, wasAdded) {
  if (!shouldDiscard(item)) return null;
  return wasAdded ? 'discard' : 'delete';
}

/**
 * Create a text item and bind every query tag to it. A failure at any step
 * removes the item again, so nothing half-created stays in the datastore.
 * @param {object} api window.app
 * @param {string[]} tagNames
 * @returns {Promise<{ok: true, id: string}|{ok: false, message: string}>}
 */
export async function createTaggedItem(api, tagNames) {
  let plan;
  try {
    const tagsResult = await api.datastore.getTagsByFrecency();
    const rows = tagsResult?.success ? (tagsResult.data || []) : [];
    plan = newItemPlan(tagNames, buildTagIndex(rows));
  } catch (err) {
    return { ok: false, message: `Cannot add an item: ${err?.message || err}` };
  }
  if (!plan.ok) return { ok: false, message: plan.reason };

  let id;
  try {
    const created = await api.datastore.addItem(plan.item.type, plan.item.options);
    if (!created?.success || !created.data?.id) {
      return { ok: false, message: `Could not create the item${created?.error ? ': ' + created.error : ''}` };
    }
    id = created.data.id;
    for (const tagId of plan.tagIds) {
      const bound = await api.datastore.tagItem(id, tagId);
      if (bound?.success === false || bound?.error) {
        throw new Error(bound.error || 'tagging failed');
      }
    }
  } catch (err) {
    if (id) await discardItem(api, id);
    return { ok: false, message: `Could not create the item: ${err?.message || err}` };
  }
  try {
    api.pubsub?.publish?.('editor:changed', { action: 'add', itemId: id });
  } catch { /* notification only */ }
  return { ok: true, id };
}

/** Delete an item that was added here and never used. */
export async function discardItem(api, id) {
  try {
    await api.datastore.deleteItem(id);
  } catch (err) {
    console.error('[editor] Failed to remove an empty new item:', err);
  }
}
