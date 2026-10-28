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
 * because every group's rows sit in a `.cards` container.
 *
 * Every row does something when it is activated, by Enter or by a click — one
 * handler for both, because `grid-nav.js activateSelected()` turns Enter into a
 * `.click()` on the selected card the way `features/spaces/home.js` relies on:
 *
 * - A page raises the window it is already open in, or opens in the research.
 * - A search whose results page is already open raises that window and adds no
 *   run; otherwise it runs again through `web search`, adding a run to the
 *   round it already is and opening its results in the research.
 * - A note opens for editing where it is read; Enter or leaving the row saves,
 *   Escape closes the editor and a second Escape closes the view.
 *
 * The decisions behind those are pure and unit-tested in `actions.js`; what is
 * left here is the one call each turns into.
 *
 * The other place the view takes typed text is the add-a-note row at the top of
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
import {
  urlKey, planPageActivation, searchQueryOf, planNoteSave,
  planSearchActivation, searchRunUrls,
} from './actions.js';

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

/**
 * The window each page in the research is open in, keyed by `urlKey`, as the
 * last draw read them. A page row raises the window it names.
 */
let openWindows = new Map();
/** The note being edited in place, or `null`. */
let noteEditor = null;

/** A query result that arrived while a note was being edited. */
let deferredResult = null;

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
 * The window each page open right now is open in, keyed by the URL's comparison
 * form. Which pages are open is what a row marks; which window each is open in
 * is what activating the row raises, and both come off one listing so they
 * cannot disagree.
 */
const openPageWindows = async () => {
  const open = new Map();
  try {
    const result = await api.window.list({ includeInternal: false });
    if (!result?.success || !Array.isArray(result.windows)) return open;
    for (const win of result.windows) {
      const key = urlKey(win?.url);
      if (key && typeof win?.id === 'number' && !open.has(key)) open.set(key, win.id);
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

// ── Activating a row ──────────────────────────────────────────────────

/**
 * The research as a space mode, which is what makes a page opened from this
 * view land in the research rather than beside it.
 *
 * Read once — a research's space does not change while its view is open. The
 * view's own window carries the space it was opened for, and that is where the
 * research's colour comes from; the space tag answers for a window that was
 * opened before this view asked for a space mode.
 */
let spaceModePromise = null;

const spaceModeForOpen = () => {
  if (spaceModePromise) return spaceModePromise;
  spaceModePromise = (async () => {
    try {
      const result = await api.context?.getMode?.();
      const mode = result?.success ? result.data : null;
      if (mode?.value === 'space' && mode.metadata?.spaceId) {
        const { spaceId, color } = mode.metadata;
        return {
          spaceId,
          spaceName: mode.metadata.spaceName || spaceName,
          ...(color ? { color } : {}),
        };
      }
    } catch (err) {
      debug && console.log('[research] this window reports no mode:', err);
    }

    try {
      const tag = await api.datastore.getOrCreateTag(spaceTag);
      const spaceId = tag?.success ? tag.data?.tag?.id : null;
      if (spaceId) return { spaceId, spaceName };
    } catch (err) {
      console.error('[research] Failed to resolve the research tag:', err);
    }
    return null;
  })();
  return spaceModePromise;
};

/**
 * Bring a page's window forward, or open the page in the research. The window
 * ids are as new as the last draw, so a window closed since then is checked
 * for rather than raised blind — a vanished id would otherwise swallow the
 * activation and the row would do nothing.
 */
const activatePage = async (item) => {
  const plan = planPageActivation(item?.content, openWindows);
  if (plan.kind === 'none') return;

  try {
    if (plan.kind === 'raise') {
      const there = await api.window.exists(plan.windowId);
      if (there?.exists === true) {
        await api.window.focus(plan.windowId);
        return;
      }
    }

    const mode = await spaceModeForOpen();
    await api.window.open(plan.url, {
      role: 'content',
      key: plan.url,
      width: 1024,
      height: 768,
      ...(mode ? { spaceMode: mode } : {}),
    });
  } catch (err) {
    console.error('[research] Failed to activate the page', plan.url, err);
  }
};

/**
 * Run a search again. `web search` is the command the palette runs, so this is
 * the same run as any other: the round this row already is gains another run
 * event and its results open, both in the research, because
 * `features/websearch/search-rounds.js` reads the space off the front window
 * and this view carries the research's space mode.
 *
 * The row's run count does not move until the query re-resolves for another
 * reason — run events publish on no live topic.
 */
const activateSearch = async (item) => {
  // Both are read again here: a run recorded or a window opened since the last
  // draw publishes on no live topic, so the drawn copies can be a run behind.
  const [windows, events] = await Promise.all([
    openPageWindows(),
    item?.id ? searchRunEvents([item]) : [],
  ]);
  const plan = planSearchActivation(item, searchRunUrls(events), windows);
  if (plan.kind === 'none') return;

  if (plan.kind === 'raise') {
    try {
      const there = await api.window.exists(plan.windowId);
      if (there?.exists === true) {
        await api.window.focus(plan.windowId);
        return;
      }
    } catch (err) {
      console.error('[research] Failed to raise the search results', err);
    }
  }

  const query = searchQueryOf(item);
  api.pubsub.publish('cmd:execute:web search', { search: query, params: [query] });
};

// ── Editing a note in place ───────────────────────────────────────────
//
// A note row becomes a text field the size of the row, so a note is edited
// where it is read. `features/editor/query-inline-editor.js` was the other
// candidate and does not fit this window: it measures a block surface
// (`blockElement()`, `rerender()`), drives the editor window's status line, and
// styles itself from the editor's own stylesheet, none of which exist here.

/**
 * Write the editor's text to the note, close the editor, and put the row back.
 *
 * Nothing is drawn here. `updateItem` publishes `item:updated`, which the live
 * query follows, so the row redraws the way it would for a note edited
 * anywhere else.
 */
const closeNoteEditor = ({ save }) => {
  const editor = noteEditor;
  if (!editor || editor.closing) return;
  editor.closing = true;

  const typed = editor.input.value;
  editor.input.remove();
  editor.card.classList.remove('editing');
  noteEditor = null;

  // The selection never left the row, so the focus goes back to it.
  if (document.querySelectorAll('.cards peek-card').length > 0) updateSelection(state);

  const plan = save ? planNoteSave(editor.item, typed) : null;
  if (plan) {
    api.datastore.updateItem(plan.itemId, plan.fields)
      .then((result) => {
        if (!result?.success) console.error('[research] Failed to save the note:', result?.error);
      })
      .catch((err) => { console.error('[research] Failed to save the note:', err); });
  }

  // A redraw held back while the editor was open.
  if (deferredResult) {
    const result = deferredResult;
    deferredResult = null;
    applyResult(result);
  }
};

const openNoteEditor = async (card, item) => {
  if (noteEditor || !card) return;

  const input = document.createElement('peek-input');
  input.className = 'note-editor';
  input.value = typeof item?.content === 'string' ? item.content : '';

  const editor = { item, card, input, closing: false };
  noteEditor = editor;

  card.classList.add('editing');
  card.insertAdjacentElement('afterend', input);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      // Marking the press handled is what keeps `grid-nav.js` from activating
      // the row again on the same Enter.
      e.preventDefault();
      e.stopPropagation();
      closeNoteEditor({ save: true });
    } else if (e.key === 'Escape') {
      // Main claims Escape first (`setupEscape`); this is the same decision
      // for a press it did not.
      e.preventDefault();
      e.stopPropagation();
      closeNoteEditor({ save: false });
    }
  });

  // Leaving the row saves, which is the other half of what Enter does.
  // `focusout` is the event that crosses the shadow boundary — a `blur` on the
  // field inside would never reach a listener out here.
  input.addEventListener('focusout', () => {
    if (!editor.closing) closeNoteEditor({ save: true });
  });

  // The field lives in a shadow root, so there is nothing to focus until the
  // component has drawn once. The text comes up selected, so typing replaces
  // the note rather than appending to it.
  if (input.updateComplete) await input.updateComplete;
  input.focus();
  input.select?.();
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
    onClick: () => activatePage(ranked.item),
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
 * many times it ran. Activating it runs the search again.
 */
const createSearchRow = (ordered) => {
  const card = createSearchResultCard(ordered.item, {
    className: 'research-row research-search-row',
    onClick: () => activateSearch(ordered.item),
  });

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

/** One note row. Activating it opens the note for editing where it is read. */
const createNoteRow = (item) => {
  const card = createSearchResultCard(item, {
    className: 'research-row research-note-row',
    onClick: () => openNoteEditor(card, item),
  });
  return card;
};

const draw = ({ pages, searches, notes }) => {
  rowsContainer.replaceChildren();
  for (const ranked of pages) {
    rowsContainer.appendChild(createRow(ranked, openWindows.has(urlKey(ranked.item.content))));
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
  // Redrawing replaces the note rows, and the open editor sits among them.
  // The result is held and drawn when the editor closes, so a note joining the
  // research cannot take the one being written out from under the caret.
  if (noteEditor) {
    deferredResult = result;
    return;
  }

  const generation = ++renderGeneration;
  const { pages, searches, notes } = groupSpaceItems(result?.items || [], result?.itemTags);

  const [visits, windows, runEvents] = await Promise.all([
    visitsForItems(pages),
    openPageWindows(),
    searchRunEvents(searches),
  ]);
  if (generation !== renderGeneration) return;

  openWindows = windows;
  draw({
    pages: rankPagesByTimeOnPage(pages, visits),
    searches: orderSearchRounds(searches, runEvents),
    notes: orderNotesNewestFirst(notes),
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
 * Escape closes the note being edited, or leaves the add-a-note row when the
 * caret is in it, and otherwise closes the view. A note open for editing is
 * the first thing a press closes; the second press finds no editor and closes
 * the view.
 *
 * A `workspace` window is never closed by Escape on its own
 * (`main/window-escape.ts escapeClosePolicy`), so the view closes itself and
 * reports the press handled. Main sees the key before the renderer does, so
 * this is the decision that counts — a row's own handler only runs when the
 * press was not claimed here.
 */
const setupEscape = () => {
  api?.escape?.onEscape?.(() => {
    if (noteEditor) {
      closeNoteEditor({ save: false });
      return { handled: true };
    }
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
    // While a note is being edited the keys belong to the field: its own
    // handler takes Enter and Escape, and everything else is typing. Moving
    // the selection would redraw the list out from under the editor.
    shouldIgnore: () => noteEditor !== null,
    isInputFocused: noteRowFocused,
  }));

  // `n` is how the add-a-note row is reached from the list without a mouse;
  // the row is not a card, so the arrow keys and hjkl never land on it.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (noteEditor || noteRowFocused()) return;
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
