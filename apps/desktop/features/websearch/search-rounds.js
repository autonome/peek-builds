/**
 * Search rounds: the record of every web search this tile runs.
 *
 * A search is a `text` item whose content is the trimmed query, tagged
 * `search-round`. Each run of that query adds an item event carrying the
 * engine id and the result URL, so running the same query again is a second
 * run on the same item rather than a new item.
 *
 * When the window the search was started from is in a space, the search item
 * is tagged with that space's tag and the caller is handed the space mode to
 * pass to the window open, so the result page lands in the same space.
 *
 * Every function here takes the tile API as its first argument and touches no
 * module state, so a fake API drives them in `tests/unit/websearch-search-rounds.test.js`.
 */

export const SEARCH_ROUND_TAG = 'search-round';

/** The `kind` an item event carries in its metadata to mark one search run. */
export const SEARCH_RUN_KIND = 'search-run';

/**
 * The space of the window the search was started from, as the
 * `{spaceId, spaceName, color}` shape `api.window.open` accepts for
 * `spaceMode` — or null when there is no such window, or it is not in a space.
 *
 * `spaceId` is the space's tag id, which is also what the search item is
 * tagged with.
 */
export const spaceOfFrontWindow = async (api) => {
  const windowId = await api.window.getFocusedVisibleWindowId();
  if (windowId == null) return null;

  const result = await api.context.get('mode', windowId);
  const mode = result && result.success ? result.data : null;
  if (!mode || mode.value !== 'space') return null;

  const metadata = mode.metadata;
  if (!metadata || !metadata.spaceId) return null;

  return {
    spaceId: metadata.spaceId,
    spaceName: metadata.spaceName,
    color: metadata.color,
  };
};

/**
 * The existing `search-round` item for this exact query text, or null.
 *
 * `queryItems` matches `search` with SQL LIKE, which over-matches rather than
 * under-matches, so the exact comparison happens here. A candidate also has to
 * carry the `search-round` tag, so an unrelated note with the same text is
 * never adopted as a search round.
 */
const findRoundItem = async (api, query) => {
  const result = await api.datastore.queryItems({ type: 'text', search: query });
  if (!result || !result.success || !Array.isArray(result.data)) return null;

  for (const item of result.data) {
    if (typeof item.content !== 'string' || item.content.trim() !== query) continue;
    const tags = await api.datastore.getItemTags(item.id);
    if (!tags || !tags.success || !Array.isArray(tags.data)) continue;
    if (tags.data.some((tag) => tag && tag.name === SEARCH_ROUND_TAG)) return item;
  }

  return null;
};

/**
 * Find or create the `search-round` item for this query, and tag it into the
 * space when there is one. Returns the item id, or null if it could not be
 * created.
 */
const findOrCreateRoundItem = async (api, query, spaceMode) => {
  const existing = await findRoundItem(api, query);
  let itemId = existing ? existing.id : null;

  if (!itemId) {
    const created = await api.datastore.addItem('text', { content: query });
    if (!created || !created.success || !created.data || !created.data.id) return null;
    itemId = created.data.id;

    const tag = await api.datastore.getOrCreateTag(SEARCH_ROUND_TAG);
    const tagId = tag && tag.success && tag.data && tag.data.tag ? tag.data.tag.id : null;
    if (!tagId) return null;
    await api.datastore.tagItem(itemId, tagId);
  }

  if (spaceMode && spaceMode.spaceId) {
    await api.datastore.tagItem(itemId, spaceMode.spaceId);
  }

  return itemId;
};

/**
 * Record one run of a search and answer the space mode its result window
 * should open with (null outside a space).
 *
 * An empty query records nothing and answers null. A failure anywhere in the
 * recording is logged and swallowed: the space mode is resolved first, so a
 * datastore that cannot be written still lands the result page in the right
 * space, and the search always opens.
 */
export const recordSearchRound = async (api, { query, engineId, url } = {}) => {
  const text = typeof query === 'string' ? query.trim() : '';
  if (!text) return null;

  let spaceMode = null;
  try {
    spaceMode = await spaceOfFrontWindow(api);
  } catch (err) {
    console.error('[ext:websearch] Failed to read the space of the front window:', err);
  }

  try {
    const itemId = await findOrCreateRoundItem(api, text, spaceMode);
    if (itemId) {
      await api.datastore.addItemEvent(itemId, {
        content: url || '',
        occurredAt: Date.now(),
        metadata: JSON.stringify({
          kind: SEARCH_RUN_KIND,
          engineId: engineId || null,
          url: url || null,
        }),
      });
    }
  } catch (err) {
    console.error('[ext:websearch] Failed to record the search round:', err);
  }

  return spaceMode;
};

/**
 * Tag the result page of a search into the space the search belongs to.
 *
 * `features/spaces/background.js handleItemCreated()` is what normally tags a
 * page into the space of the window it was opened in, but it cannot do it for
 * the window a search opens: page tracking creates the page item while that
 * window is being built, and the window's space reaches its context only after
 * that, so the handler reads no space and returns. The search knows the space,
 * so it tags the page itself.
 *
 * Call this after the window open has resolved — tracking has run by then, so
 * the page item exists. `findUrlItem` normalizes the URL the same way tracking
 * does, so the result URL as the engine template produced it is the right thing
 * to look up. Answers whether the tag was applied.
 */
export const tagResultPageInSpace = async (api, { url, spaceMode } = {}) => {
  if (!url || !spaceMode || !spaceMode.spaceId) return false;

  try {
    const found = await api.datastore.findUrlItem(url);
    const item = found && found.success ? found.data : null;
    if (!item || !item.id) return false;
    await api.datastore.tagItem(item.id, spaceMode.spaceId);
    return true;
  } catch (err) {
    console.error('[ext:websearch] Failed to tag the result page into its space:', err);
    return false;
  }
};
