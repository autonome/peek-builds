/**
 * Sheets card grid: every saved sheet as a card. Clicking a card opens it, the
 * corner control deletes it, and the trailing "+" card makes a new one.
 *
 * Page chrome, cards and the ghost card come from the shared card-view shell.
 * Opening goes through the same SHEET_OPEN_TOPIC publish the per-sheet keys
 * use, so the feature's background has one way to open a sheet.
 */

import { mountCardView, createCard } from 'peek://app/lib/card-view.js';
import { loadSheet, saveSheet, loadSheetsMap, createSheet, deleteSheet } from './sheet-store.js';
import { startNameEdit, isNameEditing } from './inline-name-edit.js';
import { SHEET_OPEN_TOPIC, SHEETS_CHANGED_TOPIC, SHEET_DELETED_TOPIC } from './sheet-hotkeys.js';
import { sheetIdOfKey, normalizeSheetName, withSheetName } from './sheet-commands.js';

const api = window.app;

let sheets = [];

const cardCountText = (sheet) => {
  const count = Array.isArray(sheet.items) ? sheet.items.length : 0;
  return count === 1 ? '1 card' : `${count} cards`;
};

const confirmDeleteSheet = async (sheet) => {
  if (!confirm(`Delete sheet "${sheet.name}"? This cannot be undone.`)) return;
  const result = await deleteSheet(api, sheet.id);
  if (result && result.error) {
    console.error('[ext:sheets] Failed to delete sheet:', result.error);
    return;
  }
  // Closes an open window of the sheet, then refreshes lists and name options.
  api.pubsub.publish(SHEET_DELETED_TOPIC, { sheetId: sheet.id });
  api.pubsub.publish(SHEETS_CHANGED_TOPIC, { sheetId: sheet.id });
};

/** Create an untitled sheet and open it. */
const addSheet = async () => {
  const { sheetId, result } = await createSheet(api, normalizeSheetName(''));
  if (result && result.error) {
    console.error('[ext:sheets] Failed to save sheet:', result.error);
    return;
  }
  api.pubsub.publish(SHEETS_CHANGED_TOPIC, { sheetId });
  api.pubsub.publish(SHEET_OPEN_TOPIC, { args: [sheetId] });
};

/** Save a new name for a sheet, then refresh lists and name options. */
const renameSheet = async (sheet, name) => {
  const config = await loadSheet(api, sheet.id);
  const next = withSheetName(config, name);
  if (!config || next === config) return;
  const result = await saveSheet(api, sheet.id, next);
  if (result && result.error) {
    console.error('[ext:sheets] Failed to rename sheet:', result.error);
    return;
  }
  api.pubsub.publish(SHEETS_CHANGED_TOPIC, { sheetId: sheet.id });
};

/**
 * Double-click a card's name to edit it. A click on the name waits briefly
 * before opening the sheet, so the first click of a double-click does not.
 */
const OPEN_DELAY_MS = 250;
let pendingOpen = null;

const attachNameEdit = (card, sheet) => {
  const title = card.querySelector('.card-title');
  card.addEventListener('card-click', (e) => {
    if (e.detail?.originalEvent?.target !== title) {
      api.pubsub.publish(SHEET_OPEN_TOPIC, { args: [sheet.id] });
      return;
    }
    clearTimeout(pendingOpen);
    pendingOpen = setTimeout(
      () => api.pubsub.publish(SHEET_OPEN_TOPIC, { args: [sheet.id] }),
      OPEN_DELAY_MS
    );
  });
  title.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    clearTimeout(pendingOpen);
    startNameEdit(title, { name: sheet.name, save: (name) => renameSheet(sheet, name) });
  });
};

const view = mountCardView({
  api,
  searchPlaceholder: 'Search sheets...',
  logTag: 'ext:sheets'
});

const render = () => {
  view.render({
    items: sheets,
    matches: (sheet, q) => sheet.name.toLowerCase().includes(q),
    toCard: (sheet) => {
      const card = createCard({
        id: sheet.id,
        title: sheet.name,
        meta: cardCountText(sheet),
        deleteTitle: `Delete sheet ${sheet.name}`,
        onDelete: () => confirmDeleteSheet(sheet)
      });
      attachNameEdit(card, sheet);
      return card;
    },
    ghost: { title: 'New sheet', onClick: addSheet }
  });
};

const loadSheets = async () => {
  const map = await loadSheetsMap(api);
  sheets = Object.entries(map)
    .filter(([, config]) => config && typeof config.name === 'string')
    .map(([key, config]) => ({ id: sheetIdOfKey(key), name: config.name, items: config.items }))
    .sort((a, b) => a.name.localeCompare(b.name));
  render();
};

const init = async () => {
  // Esc ends only a name edit; otherwise it closes the window as before.
  api.escape?.onEscape?.(() => ({ handled: isNameEditing() }));
  api.pubsub.subscribe(SHEETS_CHANGED_TOPIC, () => { loadSheets(); });
  await loadSheets();
  view.markReady();
};

init();
