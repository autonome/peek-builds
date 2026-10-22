/**
 * The research view's three groups: which of a research's items belong to each,
 * and the order a group's rows are drawn in.
 *
 * A research is a space, and the space tag carries everything in it — pages,
 * the searches that were run while reading it, and the notes written into it.
 * One query answers for all three (`features/editor/query-live.js`), so the
 * split happens here rather than in three queries that could disagree.
 *
 * Searches are the space's `search-round` items
 * (`features/websearch/search-rounds.js`): a `text` item whose content is the
 * trimmed query, carrying one item event per run whose metadata `kind` is
 * `search-run`. Their order is the order they were first run, which is a fact
 * about those events rather than about when the item row was written.
 *
 * Notes are the space's remaining text items, newest first.
 *
 * Pure — no datastore, no DOM, no tile API — so the grouping and both orders
 * are decided in `tests/unit/research-view-groups.test.js`.
 */

/** The tag that marks a text item as a search rather than a note. */
export const SEARCH_ROUND_TAG = 'search-round';

/** The item-event metadata `kind` written once per run of a search. */
export const SEARCH_RUN_KIND = 'search-run';

/**
 * A round whose runs left no usable timestamp sorts after every round that did,
 * rather than claiming to be the first thing the research tried.
 */
const UNKNOWN_TIME = Number.MAX_SAFE_INTEGER;

/** An item's tag names, from a `Map` or a plain object keyed by item id. */
const tagNamesOf = (itemTags, itemId) => {
  if (!itemTags) return [];
  const names = typeof itemTags.get === 'function' ? itemTags.get(itemId) : itemTags[itemId];
  return Array.isArray(names) ? names : [];
};

/** A timestamp that can be compared, or `null` when there is none. */
const asTime = (value) => (typeof value === 'number' && isFinite(value) ? value : null);

/**
 * The `kind` an item event was written with. The datastore stores metadata as a
 * JSON string, but a caller holding a parsed row should not have to re-encode
 * it to be understood here.
 */
const kindOf = (event) => {
  const metadata = event?.metadata;
  if (metadata && typeof metadata === 'object') return metadata.kind || null;
  if (typeof metadata !== 'string' || metadata === '') return null;
  try {
    return JSON.parse(metadata)?.kind ?? null;
  } catch {
    return null;
  }
};

/**
 * Split a research's items into the view's three groups.
 *
 * Anything that is neither a page nor a text item (an image, say) belongs to no
 * group in this view and is left out rather than shown somewhere it does not
 * mean anything.
 *
 * @param {Array<{id: string, type: string}>} items the space's items, any order
 * @param {Map<string, string[]>|Record<string, string[]>} [itemTags] each item's
 *   tag names, as `resolveTagQuery` answers with
 * @returns {{pages: object[], searches: object[], notes: object[]}} each group in
 *   the order the items arrived in; ordering within a group is the caller's next
 *   step
 */
export const groupSpaceItems = (items, itemTags) => {
  const pages = [];
  const searches = [];
  const notes = [];

  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !item.id) continue;
    if (item.type === 'url') {
      pages.push(item);
    } else if (item.type === 'text') {
      if (tagNamesOf(itemTags, item.id).includes(SEARCH_ROUND_TAG)) searches.push(item);
      else notes.push(item);
    }
  }

  return { pages, searches, notes };
};

/**
 * A research's searches in the order they were first run, each with how many
 * times it ran.
 *
 * @param {Array<{id: string, createdAt?: number}>} rounds the space's
 *   `search-round` items, any order
 * @param {Array<{itemId: string, occurredAt: number, metadata: string|object}>} events
 *   item events for those rounds; events of any other kind, and events for other
 *   items, are ignored
 * @returns {Array<{item: object, runCount: number, firstRunAt: number}>} earliest
 *   first run first. A round with no run event falls back to when its item was
 *   created, and one with neither sorts last; rounds that tie keep the order they
 *   arrived in.
 */
export const orderSearchRounds = (rounds, events) => {
  const safeRounds = Array.isArray(rounds) ? rounds.filter((item) => item && item.id) : [];

  const firstRun = new Map();
  const runCount = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || !event.itemId) continue;
    if (kindOf(event) !== SEARCH_RUN_KIND) continue;
    runCount.set(event.itemId, (runCount.get(event.itemId) || 0) + 1);
    const at = asTime(event.occurredAt);
    if (at === null) continue;
    const known = firstRun.get(event.itemId);
    if (known === undefined || at < known) firstRun.set(event.itemId, at);
  }

  return safeRounds
    .map((item, arrival) => ({
      item,
      arrival,
      runCount: runCount.get(item.id) || 0,
      firstRunAt: firstRun.has(item.id)
        ? firstRun.get(item.id)
        : (asTime(item.createdAt) ?? UNKNOWN_TIME),
    }))
    .sort((a, b) => (a.firstRunAt - b.firstRunAt) || (a.arrival - b.arrival))
    .map(({ item, runCount: count, firstRunAt }) => ({ item, runCount: count, firstRunAt }));
};

/**
 * A research's notes, newest first. A note with no creation time sorts last,
 * and notes that tie keep the order they arrived in.
 *
 * @param {Array<{id: string, createdAt?: number}>} notes
 * @returns {object[]}
 */
export const orderNotesNewestFirst = (notes) => {
  const safeNotes = Array.isArray(notes) ? notes.filter((item) => item && item.id) : [];
  return safeNotes
    .map((item, arrival) => ({ item, arrival, at: asTime(item.createdAt) ?? 0 }))
    .sort((a, b) => (b.at - a.at) || (a.arrival - b.arrival))
    .map(({ item }) => item);
};

/**
 * How many times a search ran, as a row reads it. A round with no recorded run
 * says so rather than showing `0 runs`, because no run event means the runs were
 * never written, not that the search was never made.
 *
 * @param {number} count
 * @returns {string}
 */
export const formatRunCount = (count) => {
  if (typeof count !== 'number' || !isFinite(count) || count < 1) return 'no runs recorded';
  return count === 1 ? '1 run' : `${count} runs`;
};
