/**
 * Widget Demo Sheet Script
 *
 * Single-file tile: handles both tile initialization (api.initialize,
 * command registration) and sheet UI (widget layout, drag/resize).
 *
 * This tile starts hidden at boot (resident: true). Commands call
 * showSelf() to reveal it. Hiding (e.g. window close) calls hideSelf()
 * so re-opening is instant — no re-initialization needed.
 */

const api = window.app;

// ── Tile initialization ──
// Must run before any user interaction. api.initialize() validates the
// capability token and enables all api.* methods.
await api.initialize();

// Register commands that show this window
api.commands.register({
  name: 'widget demo',
  description: 'Open the widget demo sheet',
  execute: async () => {
    await api.window.showSelf();
    return { output: 'Opening widget demo sheet', mimeType: 'text/plain' };
  }
});

api.commands.register({
  name: 'demo widgets',
  description: 'Open the widget demo sheet (alias)',
  execute: async () => {
    await api.window.showSelf();
    return { output: 'Opening widget demo sheet', mimeType: 'text/plain' };
  }
});

api.onShutdown(() => {
  api.commands.unregister('widget demo');
  api.commands.unregister('demo widgets');
  console.log('[widget-demo] shutdown');
});

const DEMO_SHEET_KEY = 'demo_sheet';

// Widget definitions with default layout (same as was in background.js)
const DEMO_WIDGETS = [
  { id: 'clock',     url: 'peek://widget-demo/widgets/clock.html',     width: 200, height: 160 },
  { id: 'counter',   url: 'peek://widget-demo/widgets/counter.html',   width: 200, height: 160 },
  { id: 'note',      url: 'peek://widget-demo/widgets/note.html',      width: 280, height: 220 },
  { id: 'bookmarks', url: 'peek://widget-demo/widgets/bookmarks.html', width: 280, height: 220 },
  { id: 'theme',     url: 'peek://widget-demo/widgets/theme.html',     width: 280, height: 200 },
];

/**
 * Build the default demo sheet config.
 * Arranges widgets in a 2-column grid layout.
 */
const buildDefaultSheetConfig = () => {
  const COL_GAP = 16;
  const ROW_GAP = 16;
  const MARGIN = 16;

  const items = [
    { ...DEMO_WIDGETS[0], x: MARGIN, y: MARGIN },
    { ...DEMO_WIDGETS[1], x: MARGIN, y: MARGIN + 160 + ROW_GAP },
    { ...DEMO_WIDGETS[2], x: MARGIN + 200 + COL_GAP, y: MARGIN },
    { ...DEMO_WIDGETS[3], x: MARGIN + 200 + COL_GAP, y: MARGIN + 220 + ROW_GAP },
    { ...DEMO_WIDGETS[4], x: MARGIN, y: MARGIN + 220 + ROW_GAP + 220 + ROW_GAP },
  ];

  return {
    version: 1,
    name: 'Widget Demo',
    createdAt: Date.now(),
    items
  };
};

let sheetConfig = null;
let editing = false;

/**
 * Load demo sheet config from feature_settings.
 * Creates default config if none exists (lazy init, no background page needed).
 */
const loadSheetConfig = async () => {
  const result = await api.settings.get(DEMO_SHEET_KEY);
  if (!result.error && result.value) {
    return result.value;
  }

  // No config exists — create default (previously done in background.js)
  const config = buildDefaultSheetConfig();
  await api.settings.set(DEMO_SHEET_KEY, config);
  console.log('[widget-demo] Created default demo sheet config with', config.items.length, 'widgets');
  return config;
};

/**
 * Save sheet config to feature_settings
 */
const saveSheetConfig = async () => {
  if (!sheetConfig) return;
  await api.settings.set(DEMO_SHEET_KEY, sheetConfig);
};

/**
 * Create a peek-card with a webview for a widget item
 */
const createWidgetCard = (item) => {
  const card = document.createElement('peek-card');
  card.id = item.id;
  card.dataset.id = item.id;

  // Webview hosting the widget page
  const webview = document.createElement('webview');
  webview.className = 'widget-webview';
  webview.src = item.url;
  webview.setAttribute('nodeintegration', '');
  card.appendChild(webview);

  return card;
};

/**
 * Render all widget cards from config
 */
const renderWidgets = () => {
  const grid = document.querySelector('peek-grid.demo-grid');
  if (!grid) return;

  grid.innerHTML = '';

  if (!sheetConfig || !sheetConfig.items || sheetConfig.items.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color: #555; padding: 40px; text-align: center;';
    empty.textContent = 'No widgets configured.';
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

  // Create widget cards
  for (const item of sheetConfig.items) {
    const card = createWidgetCard(item);
    grid.appendChild(card);
  }

  // Set freeform layout on grid
  grid.freeformLayout = layout;
};

/**
 * Toggle edit mode (enables drag/resize on peek-grid)
 */
const toggleEdit = () => {
  editing = !editing;
  const grid = document.querySelector('peek-grid.demo-grid');
  const editBtn = document.querySelector('.btn-edit');

  grid.freeformEditing = editing;
  editBtn.textContent = editing ? 'Done' : 'Edit';
  editBtn.classList.toggle('active', editing);
};

/**
 * Set up event listeners
 */
const setupEvents = () => {
  document.querySelector('.btn-edit').addEventListener('click', toggleEdit);

  // Listen for freeform layout changes from peek-grid (drag/resize)
  const grid = document.querySelector('peek-grid.demo-grid');
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
 * Initialize demo sheet
 */
const init = async () => {
  console.log('[widget-demo] Initializing sheet display');

  sheetConfig = await loadSheetConfig();

  if (!sheetConfig) {
    console.error('[widget-demo] Sheet config not found after init');
    return;
  }

  setupEvents();
  renderWidgets();
  console.log('[widget-demo] Sheet display initialized with', sheetConfig.items.length, 'widgets');
};

init().catch(error => {
  console.error('[widget-demo] Initialization error:', error);
});
