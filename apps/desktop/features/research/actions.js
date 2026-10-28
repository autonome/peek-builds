/**
 * What a research view row does when it is activated, as decisions rather than
 * effects: which window a page row raises or whether it opens one, what query a
 * search row runs again, and what an edited note is worth writing.
 *
 * Pure — no datastore, no DOM, no tile API — so every one of these is decided
 * in `tests/unit/research-view-actions.test.js`. `home.js` holds the one call
 * each decision turns into.
 */

/**
 * A URL in the form two URLs for the same page share. The datastore stores the
 * normalized URL while a window reports the one it loaded, so an exact match
 * misses a page that only differs by its trailing slash, its fragment or the
 * case of its host.
 *
 * @param {unknown} url
 * @returns {string} the comparison form, or `''` when there is no URL
 */
export const urlKey = (url) => {
  if (typeof url !== 'string' || url === '') return '';
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    if (parsed.search) {
      // Re-serialize the query the way the datastore's `normalizeUrl` and
      // `renderer/page/url-compare.js` do: `+` and `%20` both mean a space, and
      // parameter order is not part of the page. (A tile cannot import those
      // files under node, where this module is tested.)
      const params = new URLSearchParams(parsed.search);
      parsed.search = new URLSearchParams([...params.entries()].sort()).toString();
    }
    const text = parsed.toString();
    return text.endsWith('/') ? text.slice(0, -1).toLowerCase() : text.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
};

/** A window id from a `Map` or a plain object keyed by the URL's comparison form. */
const windowIdFor = (openWindows, key) => {
  if (!openWindows || key === '') return null;
  const found = typeof openWindows.get === 'function' ? openWindows.get(key) : openWindows[key];
  return typeof found === 'number' ? found : null;
};

/**
 * What activating a page row should do: raise the window the page is already
 * open in, or open it.
 *
 * @param {unknown} url the page's URL, as the item carries it
 * @param {Map<string, number>|Record<string, number>} [openWindows] window ids
 *   keyed by `urlKey`, as the view read them off the open windows
 * @returns {{kind: 'raise', windowId: number, url: string}
 *   | {kind: 'open', url: string}
 *   | {kind: 'none'}} `none` for a row carrying no URL, which is nothing to do
 *   rather than a page to open at the empty string
 */
export const planPageActivation = (url, openWindows) => {
  const key = urlKey(url);
  if (key === '') return { kind: 'none' };

  const windowId = windowIdFor(openWindows, key);
  if (windowId !== null) return { kind: 'raise', windowId, url };
  return { kind: 'open', url };
};

/**
 * The query a search row runs again. A `search-round` item's content is the
 * trimmed query (`features/websearch/search-rounds.js`), and a round with no
 * query left is nothing to run.
 *
 * @param {unknown} item
 * @returns {string|null}
 */
export const searchQueryOf = (item) => {
  const content = item && typeof item.content === 'string' ? item.content.trim() : '';
  return content === '' ? null : content;
};

/**
 * The results URLs each search round has been run to, from its run events. A
 * run event carries the URL the engine's template built (`url` in its metadata,
 * and as its content), so the URLs are known without asking the engine again.
 *
 * @param {Array<{itemId: string, content?: string, metadata?: string|object}>} events
 * @returns {Map<string, string[]>} round item id to the distinct URLs it was run to
 */
export const searchRunUrls = (events) => {
  const urls = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || !event.itemId) continue;
    let metadata = event.metadata;
    if (typeof metadata === 'string' && metadata !== '') {
      try { metadata = JSON.parse(metadata); } catch { metadata = null; }
    }
    if (!metadata || typeof metadata !== 'object' || metadata.kind !== 'search-run') continue;
    const url = typeof metadata.url === 'string' && metadata.url !== ''
      ? metadata.url
      : (typeof event.content === 'string' ? event.content : '');
    if (url === '') continue;
    const known = urls.get(event.itemId) || [];
    if (!known.includes(url)) known.push(url);
    urls.set(event.itemId, known);
  }
  return urls;
};

/**
 * What activating a search row should do: raise a window already showing one
 * of the search's results pages, or run the search again (which adds a run).
 * A raise is not a run.
 *
 * @param {unknown} item the `search-round` item
 * @param {Map<string, string[]>} [runUrls] from `searchRunUrls`
 * @param {Map<string, number>|Record<string, number>} [openWindows] window ids
 *   keyed by `urlKey`
 * @returns {{kind: 'raise', windowId: number}
 *   | {kind: 'run', query: string}
 *   | {kind: 'none'}}
 */
export const planSearchActivation = (item, runUrls, openWindows) => {
  const query = searchQueryOf(item);
  if (query === null) return { kind: 'none' };

  const urls = (runUrls && typeof runUrls.get === 'function' ? runUrls.get(item.id) : null) || [];
  for (const url of urls) {
    const windowId = windowIdFor(openWindows, urlKey(url));
    if (windowId !== null) return { kind: 'raise', windowId };
  }
  return { kind: 'run', query };
};

/**
 * The title a note's text reads as: its first line, with the leading `#`s of a
 * heading dropped. The same shape `features/editor` saves a text item with, so
 * a note edited here and one edited there end up titled the same way.
 *
 * @param {unknown} text
 * @returns {string}
 */
export const noteTitleOf = (text) => {
  if (typeof text !== 'string') return '';
  const firstLine = text.split('\n')[0] || '';
  return firstLine.replace(/^#+\s*/, '').trim();
};

/**
 * What to write when a note's editor closes, or `null` when there is nothing
 * to write.
 *
 * Two closings write nothing. Text that did not change would publish an update
 * the whole view redraws for and nothing came of. Text emptied altogether
 * leaves the note as it was, because a note is removed by deleting it and that
 * is not something this view offers — an empty row would otherwise be the only
 * way to lose a note, by accident.
 *
 * @param {unknown} item the note being edited
 * @param {unknown} typed what the field holds
 * @returns {{itemId: string, fields: {content: string, title: string}}|null}
 */
export const planNoteSave = (item, typed) => {
  if (!item || !item.id) return null;

  const text = typeof typed === 'string' ? typed.trim() : '';
  if (text === '') return null;

  const before = typeof item.content === 'string' ? item.content.trim() : '';
  if (text === before) return null;

  return { itemId: item.id, fields: { content: text, title: noteTitleOf(text) } };
};
