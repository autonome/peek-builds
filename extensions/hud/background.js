/**
 * HUD Extension Background Script
 *
 * Always-on-top overlay showing current mode, IZUI state, and window context.
 * Uses the widget sheet system — each piece of HUD info is an individual
 * widget page rendered via webview in a peek-grid freeform layout.
 *
 * Runs in isolated extension process (peek://ext/hud/background.html)
 */

const api = window.app;
const debug = api.debug;

console.log('[ext:hud] background init');

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
 * Ensure the HUD sheet config exists in extension_settings.
 * Creates a default config if none exists.
 */
const CURRENT_CONFIG_VERSION = 2;

const ensureSheetConfig = async () => {
  const result = await api.settings.getKey(HUD_SHEET_KEY);
  if (result.success && result.data) {
    // Upgrade config if version is outdated
    if (result.data.version && result.data.version >= CURRENT_CONFIG_VERSION) {
      debug && console.log('[ext:hud] HUD sheet config already exists (v' + result.data.version + ')');
      return result.data;
    }
    console.log('[ext:hud] Upgrading HUD sheet config from v' + (result.data.version || 1) + ' to v' + CURRENT_CONFIG_VERSION);
  }

  // Create default config (or upgrade)
  const config = buildDefaultSheetConfig();
  await api.settings.setKey(HUD_SHEET_KEY, config);
  console.log('[ext:hud] Created default HUD sheet config v' + CURRENT_CONFIG_VERSION + ' with', config.items.length, 'widgets');
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
    console.log('[ext:hud] Loaded state from localStorage - enabled:', hudEnabled);
  } catch (err) {
    console.log('[ext:hud] Failed to load state from localStorage:', err);
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
    console.log('[ext:hud] Saved state to localStorage - enabled:', enabled);
  } catch (err) {
    console.error('[ext:hud] Failed to save state to localStorage:', err);
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
    // Already open, just show it
    const exists = await api.window.exists(hudWindowId);
    if (exists.success && exists.data) {
      await api.window.show(hudWindowId);
      console.log('[ext:hud] HUD already open, showing');
      return;
    }
    hudWindowId = null;
  }

  // Ensure sheet config exists before opening
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
    resizable: false,
    frame: false,
    escapeMode: 'ignore',
    title: 'HUD'
  };

  try {
    const result = await api.window.open(HUD_ADDRESS, params);
    if (result.success) {
      hudWindowId = result.id;
      console.log('[ext:hud] HUD opened:', hudWindowId);
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
      console.log('[ext:hud] HUD shown (app focused)');
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
      console.log('[ext:hud] HUD hidden (app blurred)');
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
    console.log('[ext:hud] HUD closed');
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

// ===== Command definitions =====

const commandDefinitions = [
  {
    name: 'hud',
    description: 'Toggle HUD overlay on/off',
    execute: async (ctx) => {
      console.log('[ext:hud] Toggle command executed');
      return await toggleHud();
    }
  }
];

// ===== Registration =====

let registeredShortcut = null;
let registeredCommands = [];

const LOCAL_HUD_SHORTCUT = 'CommandOrControl+H';

const initShortcut = () => {
  const shortcut = 'Option+H';
  api.shortcuts.register(shortcut, async () => {
    await toggleHud();
  }, { global: true });
  registeredShortcut = shortcut;

  // Local shortcut (Cmd+H) — works when a Peek window is focused
  api.shortcuts.register(LOCAL_HUD_SHORTCUT, async () => {
    await toggleHud();
  });

  console.log('[ext:hud] Registered shortcuts:', shortcut, '(global),', LOCAL_HUD_SHORTCUT, '(local)');
};

const initCommands = async () => {
  commandDefinitions.forEach(cmd => {
    api.commands.register(cmd);
    registeredCommands.push(cmd.name);
  });
  console.log('[ext:hud] Registered commands:', registeredCommands);
};

const uninitCommands = () => {
  registeredCommands.forEach(name => {
    api.commands.unregister(name);
  });
  registeredCommands = [];
  console.log('[ext:hud] Unregistered commands');
};

const init = async () => {
  console.log('[ext:hud] init');

  // Load persisted state
  await loadState();

  // Ensure HUD sheet config exists (create default if needed)
  await ensureSheetConfig();

  // Register shortcut
  initShortcut();

  // Register commands (cmd loads first with its subscribers ready via 100ms head start)
  initCommands();

  // Subscribe to app focus changes — hide HUD when app loses focus, show when regained
  api.subscribe('app:focus-changed', async (msg) => {
    appFocused = !!msg.focused;
    console.log('[ext:hud] App focus changed:', appFocused);
    if (hudEnabled && hudWindowId) {
      if (appFocused) {
        await showHud();
      } else {
        await hideHud();
      }
    }
  }, api.scopes.GLOBAL);

  // Open HUD if it was enabled
  if (hudEnabled) {
    await openHud();
  }

  console.log('[ext:hud] Initialized, enabled:', hudEnabled);
};

const uninit = () => {
  console.log('[ext:hud] uninit');
  if (registeredShortcut) {
    api.shortcuts.unregister(registeredShortcut, { global: true });
    registeredShortcut = null;
  }
  api.shortcuts.unregister(LOCAL_HUD_SHORTCUT);
  uninitCommands();
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
