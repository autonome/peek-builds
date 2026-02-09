/**
 * HUD Extension Background Script
 *
 * Always-on-top overlay showing current mode, IZUI state, and window context.
 * Runs in isolated extension process (peek://ext/hud/background.html)
 */

const api = window.app;
const debug = api.debug;

console.log('[ext:hud] background init');

const HUD_ADDRESS = 'peek://hud/hud.html';
const STORAGE_KEY = 'hud_enabled';

// Track HUD state
let hudEnabled = false;
let hudWindowId = null;

/**
 * Load HUD enabled state from localStorage
 */
const loadState = () => {
  const stored = localStorage.getItem(STORAGE_KEY);
  hudEnabled = stored === 'true';
  console.log('[ext:hud] Loaded state - enabled:', hudEnabled);
  return hudEnabled;
};

/**
 * Save HUD enabled state to localStorage
 */
const saveState = (enabled) => {
  hudEnabled = enabled;
  localStorage.setItem(STORAGE_KEY, String(enabled));
  console.log('[ext:hud] Saved state - enabled:', enabled);
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

  const params = {
    key: HUD_ADDRESS,
    width: 300,
    height: 200,
    x: 20,
    y: 20,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    frame: false,
    focusable: false,
    escapeMode: 'ignore',
    title: 'HUD'
  };

  try {
    const result = await api.window.open(HUD_ADDRESS, params);
    if (result.success) {
      hudWindowId = result.id;
      console.log('[ext:hud] HUD opened:', hudWindowId);

      // Make sure it's always on top with floating level
      await api.invoke('window-set-always-on-top', {
        id: hudWindowId,
        value: true,
        level: 'floating'
      });
    } else {
      console.error('[ext:hud] Failed to open HUD:', result.error);
    }
  } catch (error) {
    console.error('[ext:hud] Error opening HUD:', error);
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

const initShortcut = () => {
  const shortcut = 'Command+Shift+H';
  api.shortcuts.register(shortcut, async () => {
    await toggleHud();
  }, { global: true });
  registeredShortcut = shortcut;
  console.log('[ext:hud] Registered shortcut:', shortcut);
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
  loadState();

  // Register shortcut
  initShortcut();

  // Wait for cmd:ready before registering commands
  api.subscribe('cmd:ready', () => {
    initCommands();
  }, api.scopes.GLOBAL);

  // Query in case cmd is already ready
  api.publish('cmd:query', {}, api.scopes.GLOBAL);

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
