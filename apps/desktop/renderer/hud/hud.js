/**
 * HUD Display Script
 *
 * Renders HUD widget pages in a peek-grid freeform layout.
 * Each widget is a webview pointing to an individual widget page
 * (e.g., peek://hud/widgets/mode.html).
 *
 * The layout config is loaded from feature_settings (created by background.js).
 */

const api = window.app;

const HUD_SHEET_KEY = 'hud_sheet';
const CURRENT_CONFIG_VERSION = 3;

// Default HUD sheet layout — arranges widget pages vertically.
const WIDGET_WIDTH = 220;
const WIDGET_HEIGHT = 40;
const WIDGET_GAP = 2;
const STATS_WIDGET_HEIGHT = 120;

const DEFAULT_HUD_WIDGETS = [
  { id: 'mode',   url: 'peek://hud/widgets/mode.html' },
  { id: 'izui',   url: 'peek://hud/widgets/izui.html' },
  { id: 'window', url: 'peek://hud/widgets/window.html' },
  { id: 'timers', url: 'peek://hud/widgets/timers.html' },
  { id: 'stats',  url: 'peek://hud/widgets/stats.html', height: STATS_WIDGET_HEIGHT },
];

const buildDefaultSheetConfig = () => {
  let y = 0;
  const items = DEFAULT_HUD_WIDGETS.map((widget) => {
    const h = widget.height || WIDGET_HEIGHT;
    const item = {
      id: widget.id,
      url: widget.url,
      x: 0,
      y,
      width: WIDGET_WIDTH,
      height: h,
    };
    y += h + WIDGET_GAP;
    return item;
  });

  return {
    version: CURRENT_CONFIG_VERSION,
    name: 'HUD',
    createdAt: Date.now(),
    items,
  };
};

let sheetConfig = null;

/**
 * Load HUD sheet config from this tile's settings, seeding a default
 * layout on first run. Previously the config was written by
 * background.js running in a `peek://hud/` resident renderer; with HUD
 * command/shortcut registration consolidated into the core renderer
 * (which writes to the `core` namespace), the overlay now owns its own
 * layout storage here.
 */
const ensureSheetConfig = async () => {
  const existing = await api.settings.get(HUD_SHEET_KEY);
  if (existing.success && existing.data && existing.data.version >= CURRENT_CONFIG_VERSION) {
    return existing.data;
  }

  const fresh = buildDefaultSheetConfig();
  await api.settings.set(HUD_SHEET_KEY, fresh);
  return fresh;
};

/**
 * Create a peek-card with a webview for a widget item
 */
const createWidgetCard = (item) => {
  const card = document.createElement('peek-card');
  card.id = item.id;
  card.dataset.id = item.id;

  // Webview hosting the widget page
  // Preload is injected automatically by the main process (will-attach-webview handler)
  // for peek:// URLs, giving widgets access to window.app API.
  const webview = document.createElement('webview');
  webview.className = 'widget-webview';
  webview.src = item.url;
  card.appendChild(webview);

  return card;
};

/**
 * Render all widget cards from config
 */
const renderWidgets = () => {
  const grid = document.querySelector('peek-grid.hud-grid');
  if (!grid) return;

  grid.innerHTML = '';

  if (!sheetConfig || !sheetConfig.items || sheetConfig.items.length === 0) {
    console.warn('[hud] No widgets in sheet config');
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

  // Auto-resize window to fit all widgets
  autoResizeWindow();
};

/**
 * Auto-resize the HUD window to fit widget content
 */
let resizeTimer = null;
const autoResizeWindow = () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!sheetConfig || !sheetConfig.items || sheetConfig.items.length === 0) return;

    // Calculate bounding box of all widgets
    let maxRight = 0;
    let maxBottom = 0;
    for (const item of sheetConfig.items) {
      maxRight = Math.max(maxRight, item.x + item.width);
      maxBottom = Math.max(maxBottom, item.y + item.height);
    }

    // Add padding for the container
    const width = maxRight + 20; // 10px padding each side
    const height = maxBottom + 20;

    api.window.resize(width, height);
  }, 50);
};

/**
 * Initialize HUD
 */
const init = async () => {
  console.log('[hud] Initializing widget sheet display');

  // Initialize the tile-preload surface BEFORE any api.* call. Without this,
  // api.settings.getExtKey throws ('requires readForeign capability') because
  // grantedCapabilities is empty until initialize() resolves. Same pattern as
  // page.js — see feedback_top_level_await_silent_halt.md.
  if (api.initialize) {
    await api.initialize();
  }

  sheetConfig = await ensureSheetConfig();
  renderWidgets();
  console.log('[hud] Widget sheet display initialized with', sheetConfig.items.length, 'widgets');
};

// Start initialization
init().catch(error => {
  console.error('[hud] Initialization error:', error);
});
