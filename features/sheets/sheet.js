/**
 * Sheet - Widget sheet with freeform card layout
 *
 * Each card hosts a webview pointing to a URL (peek:// or https://).
 * Uses peek-grid in freeform mode with drag/resize in edit mode.
 */

const api = window.app;
const debug = api.debug;

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
const loadSheetConfig = async () => {
  const key = `sheet:${sheetId}`;
  const result = await api.settings.get(key);
  if (result && !result.error && result.value) {
    return result.value;
  }
  return null;
};

/**
 * Save sheet config to feature_settings
 */
const saveSheetConfig = async () => {
  if (!sheetConfig) return;
  const key = `sheet:${sheetId}`;
  const result = await api.settings.set(key, sheetConfig);
  if (result && result.error) {
    console.error('[sheets] Failed to save config:', result.error);
    return;
  }
  debug && console.log('[sheets] Config saved:', key);
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
    debug && console.log('[sheets] Layout changed:', layout);

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
 * Initialize sheet
 */
const init = async () => {
  sheetId = getSheetIdFromUrl();
  if (!sheetId) {
    console.error('[sheets] No sheetId in URL');
    return;
  }

  debug && console.log('[sheets] Loading sheet:', sheetId);

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

  // Set page title
  const titleEl = document.querySelector('.sheet-title');
  titleEl.textContent = sheetConfig.name;
  document.title = sheetConfig.name;

  setupEvents();
  renderCards();
  updateEditState();
};

document.addEventListener('DOMContentLoaded', init);
