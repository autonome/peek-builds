/**
 * HUD Display Script
 *
 * Renders HUD widget pages in a peek-grid freeform layout.
 * Each widget is a webview pointing to an individual widget page
 * (e.g., peek://ext/hud/widgets/mode.html).
 *
 * The layout config is loaded from feature_settings (created by background.js).
 */

const api = window.app;
const debug = api.debug;

const HUD_SHEET_KEY = 'hud_sheet';

let sheetConfig = null;

/**
 * Load HUD sheet config from feature_settings
 */
const loadSheetConfig = async () => {
  const result = await api.settings.getKey(HUD_SHEET_KEY);
  if (result.success && result.data) {
    return result.data;
  }
  return null;
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
    debug && console.log('[hud] Auto-resized window to:', width, height);
  }, 50);
};

/**
 * Initialize HUD
 */
const init = async () => {
  console.log('[hud] Initializing widget sheet display');

  sheetConfig = await loadSheetConfig();

  if (!sheetConfig) {
    console.warn('[hud] No HUD sheet config found — waiting for background.js to create it');
    // Retry after a short delay (background.js may still be initializing)
    setTimeout(async () => {
      sheetConfig = await loadSheetConfig();
      if (sheetConfig) {
        renderWidgets();
      } else {
        console.error('[hud] HUD sheet config still not found');
      }
    }, 1000);
    return;
  }

  renderWidgets();
  console.log('[hud] Widget sheet display initialized with', sheetConfig.items.length, 'widgets');
};

// Start initialization
init().catch(error => {
  console.error('[hud] Initialization error:', error);
});
