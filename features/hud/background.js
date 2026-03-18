/**
 * HUD Extension Background Script
 *
 * Always-on-top overlay showing current mode, IZUI state, and window context.
 * Uses the widget sheet system — each piece of HUD info is an individual
 * widget page rendered via webview in a peek-grid freeform layout.
 *
 * Commands and shortcuts are declared in manifest.json.
 * This extension loads eagerly (needs startup state restoration).
 *
 * Runs in isolated extension process (peek://ext/hud/background.html)
 */

const api = window.app;
const debug = api.debug;

const HUD_ADDRESS = 'peek://ext/hud/hud.html';
const STORAGE_KEY = 'hud_enabled';
const HUD_SHEET_KEY = 'hud_sheet';

// Default HUD sheet layout — arranges widget pages vertically
const WIDGET_WIDTH = 220;
const WIDGET_HEIGHT = 40;
const WIDGET_GAP = 2;

const STATS_WIDGET_HEIGHT = 120; // taller for 6 metric rows

const DEFAULT_HUD_WIDGETS = [
  { id: 'mode',   url: 'peek://ext/hud/widgets/mode.html' },
  { id: 'izui',   url: 'peek://ext/hud/widgets/izui.html' },
  { id: 'window', url: 'peek://ext/hud/widgets/window.html' },
  { id: 'stats',  url: 'peek://ext/hud/widgets/stats.html', height: STATS_WIDGET_HEIGHT }
];

/**
 * Build the default HUD sheet config
 * Arranges widgets in a vertical stack
 */
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
      height: h
    };
    y += h + WIDGET_GAP;
    return item;
  });

  return {
    version: 2,
    name: 'HUD',
    createdAt: Date.now(),
    items
  };
};

/**
 * Ensure the HUD sheet config exists in feature_settings.
 * Creates a default config if none exists.
 */
const CURRENT_CONFIG_VERSION = 2;

const ensureSheetConfig = async () => {
  const result = await api.settings.getKey(HUD_SHEET_KEY);
  if (result.success && result.data) {
    if (result.data.version && result.data.version >= CURRENT_CONFIG_VERSION) {
      return result.data;
    }
  }

  // Create default config (or upgrade)
  const config = buildDefaultSheetConfig();
  await api.settings.setKey(HUD_SHEET_KEY, config);
  return config;
};

// Track HUD state
let hudEnabled = false;
let hudWindowId = null;
let appFocused = true; // assume focused at startup

/**
 * Load HUD enabled state from localStorage
 */
const loadState = async () => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    hudEnabled = stored === 'true';
  } catch (err) {
    // localStorage unavailable
  }
  return hudEnabled;
};

/**
 * Save HUD enabled state to localStorage
 */
const saveState = (enabled) => {
  hudEnabled = enabled;
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch (err) {
    console.error('[ext:hud] Failed to save state:', err);
  }
};

/**
 * Calculate HUD window size from sheet config
 */
const getHudWindowSize = (config) => {
  let maxRight = 0;
  let maxBottom = 0;
  for (const item of config.items) {
    maxRight = Math.max(maxRight, item.x + item.width);
    maxBottom = Math.max(maxBottom, item.y + item.height);
  }
  // Add container padding (10px each side) + border
  return {
    width: maxRight + 22,
    height: maxBottom + 22
  };
};

/**
 * Open the HUD window
 */
const openHud = async () => {
  if (hudWindowId) {
    const exists = await api.window.exists(hudWindowId);
    if (exists.success && exists.data) {
      await api.window.show(hudWindowId);
      return;
    }
    hudWindowId = null;
  }

  const config = await ensureSheetConfig();
  const size = getHudWindowSize(config);

  const params = {
    key: HUD_ADDRESS,
    width: size.width,
    height: size.height,
    x: 20,
    y: 20,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    visibleOnAllWorkspaces: true,
    resizable: false,
    frame: false,
    escapeMode: 'ignore',
    title: 'HUD',
    webPreferences: {
      webviewTag: true
    }
  };

  try {
    const result = await api.window.open(HUD_ADDRESS, params);
    if (result.success) {
      hudWindowId = result.id;
    } else {
      console.error('[ext:hud] Failed to open HUD:', result.error);
    }
  } catch (error) {
    console.error('[ext:hud] Error opening HUD:', error);
  }
};

/**
 * Show the HUD window (make visible without creating)
 */
const showHud = async () => {
  if (hudWindowId) {
    const exists = await api.window.exists(hudWindowId);
    if (exists.success && exists.data) {
      await api.window.show(hudWindowId);
    }
  }
};

/**
 * Hide the HUD window (make invisible without destroying)
 */
const hideHud = async () => {
  if (hudWindowId) {
    const exists = await api.window.exists(hudWindowId);
    if (exists.success && exists.data) {
      await api.window.hide(hudWindowId);
    }
  }
};

/**
 * Close the HUD window
 */
const closeHud = async () => {
  if (hudWindowId) {
    await api.window.close(hudWindowId);
    hudWindowId = null;
  }
};

/**
 * Toggle HUD on/off
 */
const toggleHud = async () => {
  const newState = !hudEnabled;
  saveState(newState);

  if (newState) {
    await openHud();
    return { output: 'HUD enabled', mimeType: 'text/plain' };
  } else {
    await closeHud();
    return { output: 'HUD disabled', mimeType: 'text/plain' };
  }
};

// ===== Lifecycle =====

const init = async () => {
  // Load persisted state
  await loadState();

  // Ensure HUD sheet config exists (create default if needed)
  await ensureSheetConfig();

  // Register command handler — manifest declares the command,
  // shortcuts are registered from manifest by main.ts for eager extensions
  api.commands.register({
    name: 'hud',
    description: 'Toggle HUD overlay on/off',
    execute: async () => await toggleHud()
  });

  // Shortcuts declared in manifest.json — no imperative registration needed

  // App focus hide/show is handled in the main process (did-resign-active / did-become-active)
  // for reliability — alwaysOnTop windows are hidden/shown directly without pubsub round-trip.
  api.subscribe('app:focus-changed', (msg) => {
    appFocused = !!msg.focused;
  }, api.scopes.GLOBAL);

  // Open HUD if it was enabled in a previous session
  if (hudEnabled) {
    await openHud();
  }
};

const uninit = () => {
  // Shortcuts are managed by manifest — no imperative unregister needed
  closeHud();
};

export default {
  id: 'hud',
  labels: {
    name: 'HUD'
  },
  init,
  uninit
};
