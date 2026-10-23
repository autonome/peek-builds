/**
 * Sheet - Widget sheet with freeform card layout
 *
 * Each card hosts a webview pointing to a URL (peek:// or https://).
 * Uses peek-grid in freeform mode with drag/resize in edit mode.
 */

import { loadSheet, saveSheet } from './sheet-store.js';
import {
  sheetBackgroundStyle, resolveSheetOptions, withSheetOptions, backgroundNeedsReopen,
  fitWithin, isStoredImageDataUrl, IMAGE_ENCODINGS, IMAGE_QUALITY
} from './sheet-options.js';

const api = window.app;

let sheetId = null;
let sheetConfig = null;
let editing = false;

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

/**
 * Render all cards from config
 */
const renderCards = () => {
  const grid = document.querySelector('peek-grid.cards');
  grid.innerHTML = '';

  if (!sheetConfig || sheetConfig.items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = editing
      ? 'No cards yet. Click "+ Add Card" to add one.'
      : 'This sheet is empty. Click "Edit" to add cards.';
    grid.appendChild(empty);
    return;
  }

  // Build freeform layout map from config
  const layout = {};
  for (const item of sheetConfig.items) {
    layout[item.id] = {
      x: item.x,
      y: item.y,
      w: item.width,
      h: item.height
    };
  }

  // Create card elements
  for (const item of sheetConfig.items) {
    const card = createCard(item);
    grid.appendChild(card);
  }

  // Set freeform layout on grid
  grid.freeformLayout = layout;
};

/**
 * Add a new card with a URL
 */
const addCard = async (url) => {
  if (!url) return;

  const id = crypto.randomUUID().slice(0, 8);

  // Auto-place: find a position that doesn't overlap
  const existingItems = sheetConfig.items;
  const cols = 3;
  const defaultW = 300;
  const defaultH = 200;
  const gap = 12;
  const col = existingItems.length % cols;
  const row = Math.floor(existingItems.length / cols);

  const newItem = {
    id,
    url,
    x: col * (defaultW + gap),
    y: row * (defaultH + gap),
    width: defaultW,
    height: defaultH
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
 * Toggle edit mode
 */
const toggleEdit = () => {
  editing = !editing;
  updateEditState();
};

/**
 * Apply edit mode state to UI
 */
const updateEditState = () => {
  const grid = document.querySelector('peek-grid.cards');
  const editBtn = document.querySelector('.btn-edit');
  const addBtn = document.querySelector('.btn-add');

  grid.freeformEditing = editing;

  if (editing) {
    document.body.classList.add('editing');
    editBtn.textContent = 'Done';
    editBtn.classList.add('active');
    addBtn.style.display = '';
  } else {
    document.body.classList.remove('editing');
    editBtn.textContent = 'Edit';
    editBtn.classList.remove('active');
    addBtn.style.display = 'none';
  }
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
  // Edit toggle
  document.querySelector('.btn-edit').addEventListener('click', toggleEdit);

  // Add card button
  document.querySelector('.btn-add').addEventListener('click', showAddDialog);

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

/**
 * Wire the options panel: open maximized, background kind, background image.
 */
const setupOptionsPanel = () => {
  const panel = document.querySelector('.options-panel');
  const maximized = panel.querySelector('.opt-maximized');
  const group = panel.querySelector('.opt-background');
  const imageRow = panel.querySelector('.opt-image-row');
  const fileInput = panel.querySelector('.opt-image-file');
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

  panel.querySelector('.opt-pick-image').addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      status.textContent = 'Processing...';
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

  setupEvents();
  renderCards();
  updateEditState();
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
