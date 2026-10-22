/**
 * The research view: one research's pages, the ones that held attention longest
 * first.
 *
 * A research is a space (`space:<name>`), and the space name arrives in this
 * window's URL. The view resolves that tag query itself and follows it live
 * (`features/editor/query-live.js`), so a page tagged into the research
 * afterwards appears without reopening the view — the data comes from the query,
 * not from any other view's rendering of it.
 *
 * It is a list, not an editor: compact rows from
 * `renderer/lib/search-result-card.js`, moved through with the arrow keys and
 * hjkl (`renderer/lib/grid-nav.js`). Nothing here is editable, and a row does
 * nothing when it is activated — Enter and click are a later slice
 * (`specs/research-view-actions.md`).
 *
 * The order is `rank.js`, which is pure and unit-tested; this file only feeds it
 * the space's pages and their visits.
 */

import { createSearchResultCard } from 'peek://app/lib/search-result-card.js';
import { createKeydownHandler, updateSelection } from 'peek://app/lib/grid-nav.js';
import { resolveTagQuery, startQueryLive } from 'peek://editor/query-live.js';
import { rankPagesByTimeOnPage, formatTimeOnPage } from './rank.js';

const api = window.app;
const debug = false;

/** The research this window shows, from `?space=<name>`. */
const spaceName = new URLSearchParams(window.location.search).get('space') || '';
const spaceTag = `space:${spaceName}`;

const state = { selectedIndex: 0 };

/** Bumped per render so a slow render cannot overwrite a newer one. */
let renderGeneration = 0;

let rowsContainer;
let titleEl;
let countEl;
let emptyStateEl;

// ── The see-through look ──────────────────────────────────────────────
//
// The state itself lives in main as a window param, which is why it survives a
// restart and why it is already on when the `research view` command opens this
// window. Reading it rather than assuming it is what applies a switch someone
// turned off with `see-through view`.

const applySeeThrough = async () => {
  try {
    const result = await api?.window?.getSeeThrough?.();
    const on = result?.success === true && result.data?.seeThrough === true;
    document.body.classList.toggle('see-through', on);
  } catch (err) {
    debug && console.log('[research] see-through state unavailable:', err);
  }
};

/**
 * Follow the see-through switch. `window:see-through` is a broadcast, so rather
 * than matching the window id in the message the view re-reads its own state —
 * one answer, and no second idea of which window this is.
 */
const setupSeeThrough = () => {
  api?.pubsub?.subscribe('window:see-through', () => { applySeeThrough(); });
  applySeeThrough();
};

// ── Reading the research ──────────────────────────────────────────────

/**
 * A URL in the form two URLs for the same page share. The datastore stores the
 * normalized URL while a window reports the one it loaded, so an exact match
 * misses a page that only differs by its trailing slash or the case of its host.
 */
const forComparison = (url) => {
  if (typeof url !== 'string' || url === '') return '';
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    const text = parsed.toString();
    return text.endsWith('/') ? text.slice(0, -1).toLowerCase() : text.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
};

/** The URLs of the pages open in a window right now. */
const openPageUrls = async () => {
  const open = new Set();
  try {
    const result = await api.window.list({ includeInternal: false });
    if (!result?.success || !Array.isArray(result.windows)) return open;
    for (const win of result.windows) {
      const key = forComparison(win?.url);
      if (key) open.add(key);
    }
  } catch (err) {
    console.error('[research] Failed to list the open windows:', err);
  }
  return open;
};

/**
 * Every visit row for `items`, asked for one page at a time.
 *
 * `queryItemVisits` has no "these items" filter, and asking for every visit in
 * the profile to keep a research's worth of them would grow with the whole
 * history. The cost is one call per page in the research.
 */
const visitsForItems = async (items) => {
  const perItem = await Promise.all(items.map(async (item) => {
    try {
      const result = await api.datastore.queryItemVisits({ itemId: item.id });
      return result?.success && Array.isArray(result.data) ? result.data : [];
    } catch (err) {
      console.error('[research] Failed to read the visits of', item.id, err);
      return [];
    }
  }));
  return perItem.flat();
};

// ── Drawing the rows ──────────────────────────────────────────────────

/**
 * One row: the card's own title, host and visit count, plus the two facts this
 * view adds — time on page, and whether the page is open in a window now.
 */
const createRow = (ranked, isOpen) => {
  const card = createSearchResultCard(ranked.item, {
    className: 'research-row',
    visitCount: ranked.visitCount,
  });

  const meta = document.createElement('div');
  meta.className = 'card-research-meta';

  const time = document.createElement('span');
  time.className = 'card-time-on-page';
  time.textContent = formatTimeOnPage(ranked.totalMs);
  time.title = 'Time this page was in front';
  meta.appendChild(time);

  if (isOpen) {
    const marker = document.createElement('span');
    marker.className = 'card-open-marker';
    marker.textContent = 'open';
    marker.title = 'Open in a window right now';
    meta.appendChild(marker);
  }

  card.appendChild(meta);
  card.dataset.timeOnPageMs = String(ranked.totalMs);
  if (isOpen) card.dataset.open = 'true';
  return card;
};

const draw = (rows, openUrls) => {
  rowsContainer.replaceChildren();
  for (const ranked of rows) {
    rowsContainer.appendChild(createRow(ranked, openUrls.has(forComparison(ranked.item.content))));
  }

  countEl.textContent = rows.length === 1 ? '1 page' : `${rows.length} pages`;
  emptyStateEl.classList.toggle('visible', rows.length === 0);

  // A page joining or leaving the research should not move the selection off
  // the end of the list.
  if (state.selectedIndex > rows.length - 1) state.selectedIndex = Math.max(rows.length - 1, 0);
  if (rows.length > 0) updateSelection(state);
};

/**
 * Draw a query result. Pages only: the space holds notes and images too, and
 * this slice ranks pages by time on page.
 */
const applyResult = async (result) => {
  const generation = ++renderGeneration;
  const pages = (result?.items || []).filter((item) => item && item.type === 'url');

  const [visits, openUrls] = await Promise.all([visitsForItems(pages), openPageUrls()]);
  if (generation !== renderGeneration) return;

  draw(rankPagesByTimeOnPage(pages, visits), openUrls);
};

// ── Keyboard ──────────────────────────────────────────────────────────

/**
 * Escape closes the view.
 *
 * A `workspace` window is never closed by Escape on its own
 * (`main/window-escape.ts escapeClosePolicy`), so the view closes itself and
 * reports the press handled.
 */
const setupEscape = () => {
  api?.escape?.onEscape?.(() => {
    api.window.close();
    return { handled: true };
  });
};

const setupKeyboard = () => {
  document.addEventListener('keydown', createKeydownHandler(state, {}));
};

// ── Init ──────────────────────────────────────────────────────────────

const init = async () => {
  rowsContainer = document.getElementById('rows');
  titleEl = document.getElementById('research-title');
  countEl = document.getElementById('research-count');
  emptyStateEl = document.getElementById('empty-state');

  // Before the first await, so a switch flipped or an Escape pressed while the
  // view is still loading is not missed.
  setupSeeThrough();
  setupEscape();
  setupKeyboard();

  titleEl.textContent = spaceName || 'Research';
  document.title = spaceName ? `Research: ${spaceName}` : 'Research';

  if (!spaceName) {
    emptyStateEl.textContent = 'No research named in this window.';
    emptyStateEl.classList.add('visible');
    return;
  }

  // `startQueryLive` does not run its query on start, so the first result is
  // resolved here.
  await applyResult(await resolveTagQuery(api, [spaceTag]));
  await startQueryLive({ api, tagNames: [spaceTag], onResult: applyResult });
};

init();
