/**
 * Sheets card grid: every saved sheet as a card. Clicking a card opens it.
 *
 * Opening goes through the same SHEET_OPEN_TOPIC publish the per-sheet keys
 * use, so the feature's background has one way to open a sheet.
 */

import { loadSheetsMap } from './sheet-store.js';
import { SHEET_OPEN_TOPIC, SHEETS_CHANGED_TOPIC } from './sheet-hotkeys.js';
import { sheetIdOfKey } from './sheet-commands.js';

const api = window.app;

let sheets = [];
let searchQuery = '';

const cardCountText = (sheet) => {
  const count = Array.isArray(sheet.items) ? sheet.items.length : 0;
  return count === 1 ? '1 card' : `${count} cards`;
};

const createSheetCard = (sheet) => {
  const card = document.createElement('peek-card');
  card.className = 'sheet-card';
  card.interactive = true;
  card.dataset.sheetId = sheet.id;

  const title = document.createElement('h2');
  title.className = 'card-title';
  title.slot = 'header';
  title.textContent = sheet.name;
  card.appendChild(title);

  const footer = document.createElement('div');
  footer.slot = 'footer';
  footer.className = 'card-meta';
  footer.textContent = cardCountText(sheet);
  card.appendChild(footer);

  card.addEventListener('card-click', () => {
    api.pubsub.publish(SHEET_OPEN_TOPIC, { args: [sheet.id] });
  });

  return card;
};

const render = () => {
  const grid = document.querySelector('peek-grid.cards');
  const empty = document.querySelector('.empty-state');
  const query = searchQuery.trim().toLowerCase();
  const shown = sheets.filter((s) => !query || s.name.toLowerCase().includes(query));

  grid.innerHTML = '';
  for (const sheet of shown) grid.appendChild(createSheetCard(sheet));
  empty.style.display = sheets.length === 0 ? '' : 'none';
};

const loadSheets = async () => {
  const map = await loadSheetsMap(api);
  sheets = Object.entries(map)
    .filter(([, config]) => config && typeof config.name === 'string')
    .map(([key, config]) => ({ id: sheetIdOfKey(key), name: config.name, items: config.items }))
    .sort((a, b) => a.name.localeCompare(b.name));
  render();
};

/** Read this window's see-through state from main and draw it. */
const applySeeThrough = async () => {
  try {
    const result = await api?.window?.getSeeThrough?.();
    const on = result?.success === true && result.data?.seeThrough === true;
    document.body.classList.toggle('see-through', on);
  } catch (error) {
    console.log('[ext:sheets] see-through state unavailable:', error);
  }
};

const setupSeeThrough = () => {
  api?.pubsub?.subscribe('window:see-through', () => { applySeeThrough(); });
  applySeeThrough();
};

const init = async () => {
  document.querySelector('peek-input.search-input').addEventListener('input', (e) => {
    searchQuery = e.target.value || '';
    render();
  });
  api.pubsub.subscribe(SHEETS_CHANGED_TOPIC, () => { loadSheets(); });
  setupSeeThrough();
  await loadSheets();
  document.body.dataset.ready = 'true';
};

init();
