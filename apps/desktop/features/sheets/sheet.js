/**
 * Sheet - Widget sheet with freeform card layout
 *
 * Each card hosts a webview pointing to a URL (peek:// or https://).
 * Uses peek-grid in freeform mode with drag/resize in edit mode.
 */

import { loadSheet, saveSheet, loadSheetsMap, deleteSheet } from './sheet-store.js';
import { withSheetName } from './sheet-commands.js';
import { startNameEdit, isNameEditing } from './inline-name-edit.js';
import { createGhostCard } from 'peek://app/lib/ghost-card.js';
import { DEFAULT_CARD_WIDTH, DEFAULT_CARD_HEIGHT } from 'peek://app/lib/card-size.js';
import {
  acceleratorFromKeyEvent, resolveSheetHotkey, withSheetHotkey, findHotkeyConflict,
  SHEETS_CHANGED_TOPIC, SHEET_DELETED_TOPIC
} from './sheet-hotkeys.js';
import {
  sheetBackgroundStyle, resolveSheetOptions, withSheetOptions, backgroundNeedsReopen,
  fitWithin, dataUrlToBlob, isStoredImageDataUrl, IMAGE_ENCODINGS, IMAGE_QUALITY
} from './sheet-options.js';

const api = window.app;

let sheetId = null;
let sheetConfig = null;

/**
 * Parse sheetId from URL query params
 */
const getSheetIdFromUrl = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get('sheetId');
};

/**
 * Load sheet config from feature_settings
 */
const loadSheetConfig = () => loadSheet(api, sheetId);

/**
 * Save sheet config to feature_settings
 */
const saveSheetConfig = async () => {
  if (!sheetConfig) return;
  const result = await saveSheet(api, sheetId, sheetConfig);
  if (result && result.error) {
    console.error('[sheets] Failed to save config:', result.error);
    return;
  }
};

/**
 * Create a card element with a webview for a sheet item
 */
const createCard = (item) => {
  const card = document.createElement('peek-card');
  card.id = item.id;
  card.dataset.id = item.id;

  // Header with URL title and remove button
  const header = document.createElement('div');
  header.className = 'card-header';
  header.slot = 'header';

  const title = document.createElement('span');
  title.className = 'card-header-title';
  try {
    title.textContent = new URL(item.url).hostname || item.url;
  } catch {
    title.textContent = item.url;
  }
  header.appendChild(title);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'card-remove-btn';
  removeBtn.textContent = '\u00d7';
  removeBtn.title = 'Remove card';
  // Keep the press away from the grid's drag handling, which would capture the pointer.
  removeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeCard(item.id);
  });
  header.appendChild(removeBtn);

  card.appendChild(header);

  // Webview
  const webview = document.createElement('webview');
  webview.className = 'card-webview';
  webview.src = item.url;
  card.appendChild(webview);

  return card;
};

const GHOST_ID = 'ghost-add';
const SLOT_COLS = 3;
const SLOT_W = DEFAULT_CARD_WIDTH;
const SLOT_H = DEFAULT_CARD_HEIGHT;
const SLOT_GAP = 12;

/** Bounds of the nth auto-placed slot (3 columns, row by row). */
const slotFor = (index) => ({
  x: (index % SLOT_COLS) * (SLOT_W + SLOT_GAP),
  y: Math.floor(index / SLOT_COLS) * (SLOT_H + SLOT_GAP),
  w: SLOT_W,
  h: SLOT_H
});

/**
 * Render all cards from config
 */
const renderCards = () => {
  const grid = document.querySelector('peek-grid.cards');
  grid.innerHTML = '';

  const items = sheetConfig ? sheetConfig.items : [];

  // Build freeform layout map from config
  const layout = {};
  for (const item of items) {
    layout[item.id] = {
      x: item.x,
      y: item.y,
      w: item.width,
      h: item.height
    };
  }

  // Create card elements
  for (const item of items) {
    const card = createCard(item);
    grid.appendChild(card);
  }

  // The "+" card sits in the next free slot, after the last card. It needs an
  // id for the freeform layout to place it; the grid never drags it.
  const ghost = createGhostCard({ title: 'Add card', onClick: showAddDialog });
  ghost.id = GHOST_ID;
  grid.appendChild(ghost);
  layout[GHOST_ID] = slotFor(items.length);

  // Set freeform layout on grid
  grid.freeformLayout = layout;
};

/**
 * Add a new card with a URL
 */
const addCard = async (url) => {
  if (!url) return;

  const id = crypto.randomUUID().slice(0, 8);

  // Auto-place in the next free slot
  const slot = slotFor(sheetConfig.items.length);
  const newItem = {
    id,
    url,
    x: slot.x,
    y: slot.y,
    width: slot.w,
    height: slot.h
  };

  sheetConfig.items.push(newItem);
  await saveSheetConfig();
  renderCards();
  updateEditState();
};

/**
 * Remove a card by id
 */
const removeCard = async (cardId) => {
  sheetConfig.items = sheetConfig.items.filter(item => item.id !== cardId);
  await saveSheetConfig();
  renderCards();
  updateEditState();
};

/**
 * Cards can always be dragged and resized (there is no separate edit mode);
 * the remove control shows while the pointer is over a card (sheet.css).
 */
const updateEditState = () => {
  document.querySelector('peek-grid.cards').freeformEditing = true;
};

/**
 * Show URL input dialog
 */
const showAddDialog = () => {
  const dialog = document.querySelector('.add-dialog');
  const input = dialog.querySelector('.add-dialog-input');
  dialog.style.display = '';
  input.value = '';
  input.focus();
};

/**
 * Hide URL input dialog
 */
const hideAddDialog = () => {
  const dialog = document.querySelector('.add-dialog');
  dialog.style.display = 'none';
};

/**
 * Handle dialog confirm
 */
const confirmAddDialog = () => {
  const input = document.querySelector('.add-dialog-input');
  const url = input.value.trim();
  if (url) {
    addCard(url);
  }
  hideAddDialog();
};

/**
 * Set up event listeners
 */
const setupEvents = () => {
  // Add dialog
  document.querySelector('.add-dialog-backdrop').addEventListener('click', hideAddDialog);
  document.querySelector('.btn-cancel').addEventListener('click', hideAddDialog);
  document.querySelector('.btn-confirm').addEventListener('click', confirmAddDialog);

  // Enter key in dialog input
  document.querySelector('.add-dialog-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmAddDialog();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hideAddDialog();
    }
  });

  // Listen for freeform layout changes from peek-grid (drag/resize)
  const grid = document.querySelector('peek-grid.cards');
  grid.addEventListener('freeform-layout-change', (e) => {
    const { layout } = e.detail;

    // Update config items with new positions
    for (const item of sheetConfig.items) {
      const bounds = layout[item.id];
      if (bounds) {
        item.x = bounds.x;
        item.y = bounds.y;
        item.width = bounds.w;
        item.height = bounds.h;
      }
    }

    saveSheetConfig();
  });
};

/**
 * Paint the configured background. Opaque leaves the stylesheet's theme
 * background; transparent clears it (the window itself is created transparent
 * by the opener); image fills the sheet behind the cards.
 */
const applyBackground = () => {
  const bgStyle = sheetBackgroundStyle(sheetConfig.background);
  const value = bgStyle.background || '';
  document.documentElement.style.background = value;
  document.body.style.background = value;
};

/** Background kind the window was opened with; transparency cannot change after that. */
let openedBackgroundKind = 'opaque';

/**
 * Downscale a picked image to at most the screen size and encode it as WebP
 * (JPEG where WebP is not produced), returning a data URL.
 */
const encodeBackgroundImage = async (file) => {
  const bitmap = await createImageBitmap(file);
  const ratio = window.devicePixelRatio || 1;
  const { width, height } = fitWithin(
    bitmap.width, bitmap.height,
    Math.round(window.screen.width * ratio), Math.round(window.screen.height * ratio)
  );
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  for (const type of IMAGE_ENCODINGS) {
    const url = canvas.toDataURL(type, IMAGE_QUALITY);
    if (isStoredImageDataUrl(url)) return url;
  }
  throw new Error('image could not be encoded');
};

/** The options panel's name box, kept in step with renames made elsewhere. */
let optionsNameInput = null;

/**
 * Save a new name from the options panel or the header, and update the header,
 * window title and name box. A blank or unchanged name only restores the display.
 */
const commitName = async (input) => {
  const next = withSheetName(sheetConfig, input);
  if (next !== sheetConfig && next.name !== sheetConfig.name) {
    sheetConfig = next;
    await saveSheetConfig();
    // Name lists (command options, the sheets grid) follow the new name.
    api.pubsub.publish(SHEETS_CHANGED_TOPIC, { sheetId });
  }
  const titleEl = document.querySelector('.sheet-title');
  if (!titleEl.querySelector('input')) titleEl.textContent = sheetConfig.name;
  document.title = sheetConfig.name;
  if (optionsNameInput) optionsNameInput.value = sheetConfig.name || '';
};

/** Click the header title to rename in place. */
const setupTitleEdit = () => {
  const titleEl = document.querySelector('.sheet-title');
  titleEl.addEventListener('click', () => {
    startNameEdit(titleEl, {
      name: sheetConfig.name || '',
      save: (name) => commitName(name)
    });
  });
  // Esc ends only the edit; otherwise it closes the transient sheet window.
  api.escape?.onEscape?.(() => ({ handled: isNameEditing() }));
};

/**
 * Wire the options panel: open maximized, background kind, background image.
 */
const setupOptionsPanel = () => {
  const panel = document.querySelector('.options-panel');
  const maximized = panel.querySelector('.opt-maximized');
  const group = panel.querySelector('.opt-background');
  const imageRow = panel.querySelector('.opt-image-row');
  const status = panel.querySelector('.opt-image-status');
  const note = panel.querySelector('.opt-note');

  const openedMaximized = resolveSheetOptions(sheetConfig).maximized;
  // "Image" picked but no file chosen yet: nothing to save, only the picker to show.
  let choosingImage = false;

  const refresh = () => {
    const opts = resolveSheetOptions(sheetConfig);
    maximized.checked = opts.maximized;
    group.value = choosingImage ? 'image' : opts.background.kind;
    imageRow.style.display = group.value === 'image' ? '' : 'none';
    status.textContent = opts.background.image ? 'Image set' : 'No image chosen';
    const notes = [];
    if (backgroundNeedsReopen(openedBackgroundKind, opts.background.kind)) {
      notes.push('Transparency is set when the window is created: applies next time the sheet opens.');
    }
    if (opts.maximized !== openedMaximized) notes.push('Open maximized applies next time the sheet opens.');
    note.textContent = notes.join(' ');
  };

  const update = async (patch) => {
    sheetConfig = withSheetOptions(sheetConfig, patch);
    await saveSheetConfig();
    applyBackground();
    refresh();
  };

  // ----- Name -----
  const nameInput = panel.querySelector('.opt-name');
  nameInput.value = sheetConfig.name || '';
  optionsNameInput = nameInput;
  nameInput.addEventListener('change', () => commitName(nameInput.value));
  nameInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      nameInput.blur();
    }
  });

  // ----- Key to open this sheet -----
  const keyInput = panel.querySelector('.opt-key');
  const keyClear = panel.querySelector('.opt-key-clear');
  const keyScope = panel.querySelector('.opt-key-scope');
  const keyNote = panel.querySelector('.opt-key-note');

  const refreshKey = (message) => {
    const hk = resolveSheetHotkey(sheetConfig);
    keyInput.value = hk ? hk.keys : '';
    keyScope.value = hk ? hk.scope : 'global';
    keyNote.textContent = message || (hk && hk.scope === 'app'
      ? 'In-app keys work only while a Peek window has focus and the Sheets feature is running.'
      : 'Global keys work from any app and start the Sheets feature when pressed.');
  };

  // Save the key, then tell the feature to redeclare its keys.
  const updateKey = async (hotkey) => {
    sheetConfig = withSheetHotkey(sheetConfig, hotkey);
    await saveSheetConfig();
    api.pubsub.publish(SHEETS_CHANGED_TOPIC, { sheetId });
    refreshKey();
  };

  keyInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Tab') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      keyInput.blur();
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      await updateKey(null);
      return;
    }
    const keys = acceleratorFromKeyEvent(e);
    if (!keys) return;
    const sheetsMap = await loadSheetsMap(api);
    const conflict = findHotkeyConflict(sheetsMap, sheetId, keys);
    if (conflict) {
      refreshKey(`${keys} is already the key for "${conflict.name}".`);
      return;
    }
    const scope = resolveSheetHotkey(sheetConfig)?.scope || keyScope.value || 'global';
    await updateKey({ keys, scope });
  });

  keyClear.addEventListener('click', () => updateKey(null));

  keyScope.addEventListener('change', (e) => {
    const hk = resolveSheetHotkey(sheetConfig);
    const scope = e.detail?.value === 'app' ? 'app' : 'global';
    if (hk) updateKey({ keys: hk.keys, scope });
    else refreshKey();
  });

  refreshKey();

  // ----- Delete this sheet -----
  // A deleted sheet's window closes (here and in any other window of it) so a
  // later edit cannot save the sheet back.
  api.pubsub.subscribe(SHEET_DELETED_TOPIC, (msg) => {
    if (msg?.sheetId === sheetId) api.window.close(undefined, { force: true });
  });
  panel.querySelector('.opt-delete').addEventListener('click', async () => {
    if (!confirm(`Delete sheet "${sheetConfig.name || 'Untitled'}"? This cannot be undone.`)) return;
    const result = await deleteSheet(api, sheetId);
    if (result && result.error) {
      console.error('[ext:sheets] Failed to delete sheet:', result.error);
      return;
    }
    api.pubsub.publish(SHEET_DELETED_TOPIC, { sheetId });
    api.pubsub.publish(SHEETS_CHANGED_TOPIC, { sheetId });
  });

  document.querySelector('.btn-options').addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
  });

  maximized.addEventListener('change', (e) => {
    update({ maximized: e.detail?.checked === true });
  });

  group.addEventListener('change', (e) => {
    const kind = e.detail?.value;
    choosingImage = kind === 'image';
    if (kind === 'image' && !resolveSheetOptions(sheetConfig).background.image) {
      refresh();
      return;
    }
    update({ background: { kind } });
  });

  // Main opens the native chooser (api.dialogs.open); a hidden
  // <input type=file>.click() surfaces no chooser in this window.
  panel.querySelector('.opt-pick-image').addEventListener('click', async () => {
    try {
      const picked = await api.dialogs.open({ kind: 'image' });
      if (!picked?.success) {
        if (!picked?.canceled) status.textContent = 'Could not open the file chooser';
        return;
      }
      const dataUrl = picked.data?.dataUrl;
      if (!dataUrl) {
        status.textContent = 'That file could not be used as an image';
        return;
      }
      status.textContent = 'Processing...';
      const file = dataUrlToBlob(dataUrl);
      if (!file) {
        status.textContent = 'That file could not be used as an image';
        return;
      }
      const image = await encodeBackgroundImage(file);
      choosingImage = false;
      await update({ background: { kind: 'image', image } });
    } catch (err) {
      console.error('[sheets] Failed to set background image:', err);
      status.textContent = 'That file could not be used as an image';
    }
  });

  refresh();
};

/**
 * Read this window's see-through state from main and draw it.
 *
 * The look is entirely see-through.css plus the `body.see-through` block in
 * sheet.css, both gated on a class on `<body>`; the state itself lives in main
 * as a window param, which is why it survives a restart. Reading it here is
 * also what applies a switch that was already on when the session was saved,
 * before any announcement arrives.
 */
const applySeeThrough = async () => {
  try {
    const result = await api?.window?.getSeeThrough?.();
    const on = result?.success === true && result.data?.seeThrough === true;
    document.body.classList.toggle('see-through', on);
  } catch (error) {
    console.log('[sheets] see-through state unavailable:', error);
  }
};

/**
 * Follow the see-through switch. `window:see-through` is a broadcast, so
 * rather than matching the window id in the message the view simply re-reads
 * its own state — one answer, and no second idea of which window this is.
 */
const setupSeeThrough = () => {
  api?.pubsub?.subscribe('window:see-through', () => { applySeeThrough(); });
  applySeeThrough();
};

/**
 * Initialize sheet
 */
const init = async () => {
  sheetId = getSheetIdFromUrl();
  if (!sheetId) {
    console.error('[sheets] No sheetId in URL');
    return;
  }

  sheetConfig = await loadSheetConfig();
  if (!sheetConfig) {
    console.error('[sheets] Sheet config not found:', sheetId);
    sheetConfig = {
      version: 1,
      name: 'Untitled Sheet',
      createdAt: Date.now(),
      items: []
    };
  }

  applyBackground();
  openedBackgroundKind = resolveSheetOptions(sheetConfig).background.kind;
  setupOptionsPanel();

  // Set page title
  const titleEl = document.querySelector('.sheet-title');
  titleEl.textContent = sheetConfig.name;
  document.title = sheetConfig.name;

  setupTitleEdit();
  setupEvents();
  renderCards();
  updateEditState();

  // The view is drawn; a spec can wait for this rather than for a card count.
  document.body.dataset.ready = 'true';
};

// On module evaluation, ahead of `init()` and of its first await, so a switch
// flipped while the view is still loading is not missed. This is a deferred
// module script, so `<body>` already exists.
setupSeeThrough();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
