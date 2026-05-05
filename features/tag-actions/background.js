/**
 * Tag Actions — background script handler.
 *
 * Owns the `tag-swap` script. The rule engine publishes
 * `scripts:execute:tag-swap` when an `affordance:click` event matches
 * a tag-swap rule; this tile wakes via `lazyEvents` (manifest), runs
 * the swap against the datastore, and goes back to sleep.
 *
 * The pair-management UI lives in home.js / home.html and writes
 * rules via api.rules. There's no derived state here — rules ARE the
 * pair definitions.
 */

const api = window.app;
const debug = api.debug;

/**
 * Execute the tag swap.
 *
 * Inputs (via the rule engine's `scripts:execute:<id>` payload):
 *   - context.event.itemId   — the item the affordance was clicked on
 *   - context.event.checked  — the affordance's NEW state (post-click)
 *   - context.config.activeTag    — tag name to use when unchecked
 *   - context.config.completedTag — tag name to use when checked
 *
 * Going from unchecked → checked: remove activeTag, add completedTag.
 * Going from checked → unchecked: remove completedTag, add activeTag.
 */
const runTagSwap = async (context) => {
  const { event, config } = context || {};
  if (!event || !config) {
    debug && console.warn('[tag-actions] tag-swap: missing event or config', context);
    return;
  }
  const { itemId, checked } = event;
  const { activeTag, completedTag } = config;
  if (!itemId || !activeTag || !completedTag) {
    debug && console.warn('[tag-actions] tag-swap: missing itemId/activeTag/completedTag', { itemId, activeTag, completedTag });
    return;
  }

  const removeName = checked ? activeTag : completedTag;
  const addName = checked ? completedTag : activeTag;

  try {
    const addTagRes = await api.datastore.getOrCreateTag(addName);
    if (!addTagRes.success) {
      console.error('[tag-actions] failed to get/create tag', addName, addTagRes.error);
      return;
    }
    const removeTagRes = await api.datastore.getOrCreateTag(removeName);
    if (!removeTagRes.success) {
      console.error('[tag-actions] failed to get tag for removal', removeName, removeTagRes.error);
      return;
    }
    await api.datastore.untagItem(itemId, removeTagRes.data.tag.id);
    await api.datastore.tagItem(itemId, addTagRes.data.tag.id);
    debug && console.log('[tag-actions] tag-swap done', { itemId, removed: removeName, added: addName });
  } catch (err) {
    console.error('[tag-actions] tag-swap threw:', err);
  }
};

const init = async () => {
  debug && console.log('[tag-actions] background init (tag-swap handler)');

  api.pubsub.subscribe('scripts:execute:tag-swap', async (msg) => {
    await runTagSwap(msg && msg.context);
  });
};

const uninit = () => {};

export default {
  id: 'tag-actions',
  labels: { name: 'Tag Actions' },
  init,
  uninit,
};
