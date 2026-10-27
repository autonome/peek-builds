/**
 * card-view.js — the shared shell for a feature's card-grid page.
 *
 *   <link rel="stylesheet" href="peek://app/lib/card-view.css">
 *   (plus the lit importmap, which a page must declare itself)
 *
 *   import { mountCardView } from 'peek://app/lib/card-view.js';
 *   const view = mountCardView({ api, searchPlaceholder: 'Search sheets...' });
 *   view.render({ items, matches, toCard, ghost: { title, onClick } });
 *
 * The shell builds the search box and the <peek-grid>, follows the window's
 * see-through state, and ends the grid with a ghost "+" card when asked. A
 * feature supplies only its items and how each becomes a card.
 */

import 'peek://app/components/peek-card.js';
import 'peek://app/components/peek-grid.js';
import 'peek://app/components/peek-input.js';
import { createGhostCard } from 'peek://app/lib/ghost-card.js';

const DELETE_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<line x1="18" y1="6" x2="6" y2="18"></line>' +
  '<line x1="6" y1="6" x2="18" y2="18"></line>' +
  '</svg>';

/**
 * A card with a title, a meta line, and an optional delete control.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.meta] footer text
 * @param {() => void} [opts.onClick] card click
 * @param {() => void} [opts.onDelete] shows a delete control when given; the
 *   control does not trigger onClick
 * @param {string} [opts.deleteTitle] tooltip of the delete control
 * @param {string} [opts.id] stored as data-card-id
 */
export const createCard = ({ title, meta, onClick, onDelete, deleteTitle, id }) => {
  const card = document.createElement('peek-card');
  card.interactive = true;
  if (id !== undefined) card.dataset.cardId = id;

  const header = document.createElement('div');
  header.slot = 'header';
  header.className = 'card-header-row';
  const h = document.createElement('h2');
  h.className = 'card-title';
  h.textContent = title;
  header.appendChild(h);

  if (onDelete) {
    const btn = document.createElement('button');
    btn.className = 'card-delete-btn';
    btn.title = deleteTitle || 'Delete';
    btn.innerHTML = DELETE_ICON;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onDelete();
    });
    header.appendChild(btn);
  }
  card.appendChild(header);

  if (meta !== undefined) {
    const footer = document.createElement('div');
    footer.slot = 'footer';
    footer.className = 'card-meta';
    footer.textContent = meta;
    card.appendChild(footer);
  }

  if (onClick) card.addEventListener('card-click', onClick);
  return card;
};

// The trailing "+" card lives in ghost-card.js, shared by every card grid.
export { createGhostCard };

/** Read this window's see-through state from main and draw it. */
const setupSeeThrough = (api, tag) => {
  const apply = async () => {
    try {
      const result = await api?.window?.getSeeThrough?.();
      const on = result?.success === true && result.data?.seeThrough === true;
      document.body.classList.toggle('see-through', on);
    } catch (error) {
      console.log(`[${tag}] see-through state unavailable:`, error);
    }
  };
  api?.pubsub?.subscribe('window:see-through', () => { apply(); });
  apply();
};

/**
 * Build the shell into document.body and return its controller.
 * @param {object} opts
 * @param {object} opts.api the tile's window.app
 * @param {string} [opts.searchPlaceholder]
 * @param {string} [opts.logTag]
 */
export const mountCardView = ({ api, searchPlaceholder = 'Search...', logTag = 'card-view' }) => {
  const searchBox = document.createElement('div');
  searchBox.className = 'search-container';
  const input = document.createElement('peek-input');
  input.className = 'search-input';
  input.setAttribute('placeholder', searchPlaceholder);
  input.setAttribute('type', 'search');
  searchBox.appendChild(input);

  const grid = document.createElement('peek-grid');
  grid.className = 'cards';
  grid.setAttribute('min-item-width', '250');
  grid.setAttribute('gap', '10');

  document.body.append(searchBox, grid);

  let query = '';
  let last = null;

  const render = (spec) => {
    if (spec) last = spec;
    if (!last) return;
    const { items, matches, toCard, ghost } = last;
    const q = query.trim().toLowerCase();
    const shown = q && matches ? items.filter((item) => matches(item, q)) : items;
    grid.innerHTML = '';
    for (const item of shown) grid.appendChild(toCard(item));
    if (ghost) grid.appendChild(createGhostCard(ghost));
  };

  input.addEventListener('input', (e) => {
    query = e.target.value || '';
    render();
  });

  setupSeeThrough(api, logTag);

  return { grid, input, render, markReady: () => { document.body.dataset.ready = 'true'; } };
};
