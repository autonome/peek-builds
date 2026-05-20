/**
 * HUD — always-on-top overlay for mode, IZUI state, and window context.
 * Uses the widget sheet system — each piece of HUD info is an individual
 * widget page rendered via webview in a peek-grid freeform layout.
 *
 * HUD is NOT a feature — it's core app infrastructure that ships with
 * every copy of Peek. Its command + shortcut registration now runs INSIDE
 * the core background renderer (app/index.js awaits initHud() from this
 * module). Previously this ran in a separate `peek://hud/index.html`
 * resident BrowserWindow created by hud-glue.ts; that window is gone.
 *
 * Commands and shortcuts are registered imperatively here (unlike
 * features that declare them in manifest.json) — there is no manifest
 * for HUD. The overlay window itself is still a separate window at
 * `peek://hud/hud.html`, opened on-demand via api.window.open(...).
 *
 * macOS app-focus hide/show of the alwaysOnTop HUD window is handled
 * directly in the main process (see backend/electron/main.ts) —
 * registering that handler does not require a renderer.
 */

const api = window.app;
const debug = api.debug;

const HUD_ADDRESS = 'peek://hud/hud.html';
const STORAGE_KEY = 'hud_enabled';
const TOGGLE_SHORTCUT = 'CommandOrControl+H';

// Approximate default window size for the initial HUD overlay open. The
// overlay auto-resizes to fit its widget layout on load (see hud.js
// `autoResizeWindow`), so this just needs to be close enough to avoid a
// visible reflow. Default layout: 4 widgets stacked, ~40–120px tall, +
// 22px container padding.
const DEFAULT_HUD_WIDTH = 242;
const DEFAULT_HUD_HEIGHT = 268;

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
    console.error('[hud] Failed to save state:', err);
  }
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

  // The overlay (hud.js) loads / creates its sheet config on its own
  // tile, then calls api.window.resize() to match. See
  // autoResizeWindow() in hud.js.
  const params = {
    key: HUD_ADDRESS,
    width: DEFAULT_HUD_WIDTH,
    height: DEFAULT_HUD_HEIGHT,
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
      console.error('[hud] Failed to open HUD:', result.error);
    }
  } catch (error) {
    console.error('[hud] Error opening HUD:', error);
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

  // Register command and shortcut imperatively — HUD has no manifest.
  api.commands.register({
    name: 'hud',
    description: 'Toggle HUD overlay on/off',
    execute: async () => await toggleHud()
  });

  api.shortcuts.register(TOGGLE_SHORTCUT, () => {
    toggleHud();
  });

  // App focus hide/show is handled in backend/electron/hud-glue.ts
  // (did-resign-active / did-become-active) for reliability — alwaysOnTop
  // windows are hidden/shown directly without pubsub round-trip.
  api.pubsub.subscribe('app:focus-changed', (msg) => {
    appFocused = !!msg.focused;
  });

  // Open HUD if it was enabled in a previous session
  if (hudEnabled) {
    await openHud();
  }
};

const uninit = () => {
  try {
    api.shortcuts.unregister(TOGGLE_SHORTCUT);
  } catch (err) {
    // Ignore — may already be unregistered during shutdown
  }
  closeHud();
};

export { init as initHud, uninit as uninitHud };
