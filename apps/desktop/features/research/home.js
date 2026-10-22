/**
 * The research view: one research's pages, searches and notes, in that order.
 *
 * A research is a space (`space:<name>`), and the space name arrives in this
 * window's URL. The view resolves that tag query itself and follows it live
 * (`features/editor/query-live.js`), so anything tagged into the research
 * afterwards appears without reopening the view — the data comes from the query,
 * not from any other view's rendering of it. All three groups read that one
 * result, so they cannot disagree about what is in the research.
 *
 * It is a list, not an editor: compact rows from
 * `renderer/lib/search-result-card.js`, moved through with the arrow keys and
 * hjkl (`renderer/lib/grid-nav.js`), which spans the three groups as one list
 * because every group's rows sit in a `.cards` container. A row does nothing
 * when it is activated — Enter and click on a row, and running a search again,
 * are a later slice (`specs/research-view-actions.md`).
 *
 * The one place the view takes typed text is the add-a-note row at the top of
 * the Notes group: Enter writes a `text` item tagged into the research and the
 * live query brings it into the group, Escape leaves the row for the list.
 *
 * Both orders are pure and unit-tested — pages in `rank.js`, searches and notes
 * in `groups.js`; this file only feeds them the research and its visits and
 * search runs.
 */

import { createSearchResultCard } from 'peek://app/lib/search-result-card.js';
import { createKeydownHandler, updateSelection } from 'peek://app/lib/grid-nav.js';
import { resolveTagQuery, startQueryLive } from 'peek://editor/query-live.js';
import { rankPagesByTimeOnPage, formatTimeOnPage } from './rank.js';
import {
  groupSpaceItems, orderSearchRounds, orderNotesNewestFirst, formatRunCount,
} from './groups.js';

const api = window.app;
const debug = false;

/** The research this window shows, from `?space=<name>`. */
const spaceName = new URLSearchParams(window.location.search).get('space') || '';
const spaceTag = `space:${spaceName}`;

const state = { selectedIndex: 0 };

/** Bumped per render so a slow render cannot overwrite a newer one. */
let renderGeneration = 0;

/** True while a note is being written, so one Enter writes one note. */
let savingNote = false;

let rowsContainer;
let searchRowsContainer;
let noteRowsContainer;
let searchesGroupEl;
let noteInputEl;
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

/**
 * Every item event on the research's searches, in one call. Unlike the visits
 * this reads, `queryItemEvents` takes a list of items, so the whole group costs
 * one round trip.
 */
const searchRunEvents = async (rounds) => {
  if (rounds.length === 0) return [];
  try {
    const result = await api.datastore.queryItemEvents({
      itemIds: rounds.map((item) => item.id),
      order: 'asc',
    });
    return result?.success && Array.isArray(result.data) ? result.data : [];
  } catch (err) {
    console.error('[research] Failed to read the search runs:', err);
    return [];
  }
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

/**
 * One search row: the query the card reads off the item's content, plus how
 * many times it ran. View only in this slice — running it again is
 * `specs/research-view-actions.md`.
 */
const createSearchRow = (ordered) => {
  const card = createSearchResultCard(ordered.item, { className: 'research-row research-search-row' });

  const meta = document.createElement('div');
  meta.className = 'card-research-meta';

  const runs = document.createElement('span');
  runs.className = 'card-run-count';
  runs.textContent = formatRunCount(ordered.runCount);
  runs.title = 'How many times this search was run';
  meta.appendChild(runs);

  card.appendChild(meta);
  card.dataset.runCount = String(ordered.runCount);
  return card;
};

/** One note row. View only in this slice; the add-a-note row is the editable one. */
const createNoteRow = (item) =>
  createSearchResultCard(item, { className: 'research-row research-note-row' });

const draw = ({ pages, searches, notes, openUrls }) => {
  rowsContainer.replaceChildren();
  for (const ranked of pages) {
    rowsContainer.appendChild(createRow(ranked, openUrls.has(forComparison(ranked.item.content))));
  }

  searchRowsContainer.replaceChildren();
  for (const round of searches) searchRowsContainer.appendChild(createSearchRow(round));

  noteRowsContainer.replaceChildren();
  for (const item of notes) noteRowsContainer.appendChild(createNoteRow(item));

  countEl.textContent = pages.length === 1 ? '1 page' : `${pages.length} pages`;
  emptyStateEl.classList.toggle('visible', pages.length === 0);

  // A research with no searches shows no Searches group. Notes always shows,
  // because the add-a-note row is how the first note gets written.
  searchesGroupEl.classList.toggle('empty', searches.length === 0);

  // Something joining or leaving the research should not move the selection off
  // the end of the list.
  const total = pages.length + searches.length + notes.length;
  if (state.selectedIndex > total - 1) state.selectedIndex = Math.max(total - 1, 0);
  if (total === 0) return;

  // `updateSelection` focuses the selected row, which would pull the caret out
  // of the add-a-note row — and the redraw right after a note is written is
  // exactly when someone is still typing the next one. Mark the selection
  // without taking the focus in that case.
  if (noteRowFocused()) {
    const cards = document.querySelectorAll('.cards peek-card');
    cards.forEach((card, index) => { card.selected = (index === state.selectedIndex); });
  } else {
    updateSelection(state);
  }
};

/**
 * Draw a query result: the research split three ways, each group in its own
 * order. The space also holds images, which belong to no group here
 * (`groups.js`).
 */
const applyResult = async (result) => {
  const generation = ++renderGeneration;
  const { pages, searches, notes } = groupSpaceItems(result?.items || [], result?.itemTags);

  const [visits, openUrls, runEvents] = await Promise.all([
    visitsForItems(pages),
    openPageUrls(),
    searchRunEvents(searches),
  ]);
  if (generation !== renderGeneration) return;

  draw({
    pages: rankPagesByTimeOnPage(pages, visits),
    searches: orderSearchRounds(searches, runEvents),
    notes: orderNotesNewestFirst(notes),
    openUrls,
  });
};

// ── The add-a-note row ────────────────────────────────────────────────

/** True while the caret is in the add-a-note row. */
const noteRowFocused = () => {
  if (!noteInputEl) return false;
  return document.activeElement === noteInputEl || noteInputEl.shadowRoot?.activeElement != null;
};

const enterNoteRow = () => {
  noteInputEl?.focus?.();
};

/** Leave the row for the list, discarding whatever was half-typed. */
const leaveNoteRow = () => {
  if (!noteInputEl) return;
  noteInputEl.value = '';
  noteInputEl.blur?.();
  if (document.querySelectorAll('.cards peek-card').length > 0) updateSelection(state);
};

/**
 * Write the typed note into the research: a `text` item carrying the note,
 * tagged with the space tag. Nothing is drawn here — the live query is what
 * brings the note into the Notes group, the same way a page tagged in from
 * anywhere else arrives.
 */
const saveNote = async () => {
  const text = (noteInputEl?.value || '').trim();
  if (text === '' || savingNote) return;
  savingNote = true;
  try {
    const created = await api.datastore.addItem('text', { content: text });
    const itemId = created?.success ? created.data?.id : null;
    if (!itemId) throw new Error(String(created?.error || 'the note item was not created'));

    const tag = await api.datastore.getOrCreateTag(spaceTag);
    const tagId = tag?.success ? tag.data?.tag?.id : null;
    if (!tagId) throw new Error(String(tag?.error || `the tag ${spaceTag} could not be resolved`));

    const tagged = await api.datastore.tagItem(itemId, tagId);
    if (!tagged?.success) throw new Error(String(tagged?.error || 'the note was not added to the research'));

    noteInputEl.value = '';
  } catch (err) {
    console.error('[research] Failed to write the note:', err);
  } finally {
    savingNote = false;
  }
};

const setupNoteRow = () => {
  if (!noteInputEl) return;
  noteInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      // Marking the press handled here is what keeps `grid-nav.js` from also
      // activating the selected row on the same Enter.
      e.preventDefault();
      e.stopPropagation();
      saveNote();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      leaveNoteRow();
    }
  });
};

// ── Keyboard ──────────────────────────────────────────────────────────

/**
 * Escape leaves the add-a-note row when the caret is in it, and otherwise
 * closes the view.
 *
 * A `workspace` window is never closed by Escape on its own
 * (`main/window-escape.ts escapeClosePolicy`), so the view closes itself and
 * reports the press handled. Main sees the key before the renderer does, so
 * this is the decision that counts — the row's own handler only runs when the
 * press was not claimed here.
 */
const setupEscape = () => {
  api?.escape?.onEscape?.(() => {
    if (noteRowFocused()) {
      leaveNoteRow();
      return { handled: true };
    }
    api.window.close();
    return { handled: true };
  });
};

const setupKeyboard = () => {
  document.addEventListener('keydown', createKeydownHandler(state, {
    isInputFocused: noteRowFocused,
  }));

  // `n` is how the add-a-note row is reached from the list without a mouse;
  // the row is not a card, so the arrow keys and hjkl never land on it.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (noteRowFocused()) return;
    e.preventDefault();
    enterNoteRow();
  });
};

// ── Init ──────────────────────────────────────────────────────────────

const init = async () => {
  rowsContainer = document.getElementById('rows');
  searchRowsContainer = document.getElementById('search-rows');
  noteRowsContainer = document.getElementById('note-rows');
  searchesGroupEl = document.getElementById('group-searches');
  noteInputEl = document.getElementById('note-input');
  titleEl = document.getElementById('research-title');
  countEl = document.getElementById('research-count');
  emptyStateEl = document.getElementById('empty-state');

  // A research with no searches yet shows no Searches group; the first draw
  // decides again.
  searchesGroupEl.classList.add('empty');

  // Before the first await, so a switch flipped or an Escape pressed while the
  // view is still loading is not missed.
  setupSeeThrough();
  setupEscape();
  setupKeyboard();
  setupNoteRow();

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
