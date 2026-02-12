/**
 * HUD Extension Background Script
 *
 * Always-on-top overlay showing current mode, IZUI state, and window context.
 * Runs in isolated extension process (peek://ext/hud/background.html)
 */

const api = window.app;
const debug = api.debug;

console.log('[ext:hud] background init');

const HUD_ADDRESS = 'peek://ext/hud/hud.html';
const STORAGE_KEY = 'hud_enabled';

// Track HUD state
let hudEnabled = false;
let hudWindowId = null;
let appFocused = true; // assume focused at startup

/**
 * Load HUD enabled state from extension settings API, fallback to localStorage cache
 */
const loadState = async () => {
  if (api?.settings?.getKey) {
    try {
      const result = await api.settings.getKey('overlay_visible');
      if (result.success && result.data !== undefined && result.data !== null) {
        hudEnabled = !!result.data;
        console.log('[ext:hud] Loaded state from datastore - enabled:', hudEnabled);
        return hudEnabled;
      }
    } catch (err) {
      console.log('[ext:hud] Failed to load from datastore, falling back to localStorage:', err);
    }
  }
  // Fallback to localStorage cache
  const stored = localStorage.getItem(STORAGE_KEY);
  hudEnabled = stored === 'true';
  console.log('[ext:hud] Loaded state from localStorage fallback - enabled:', hudEnabled);
  return hudEnabled;
};

/**
 * Save HUD enabled state to extension settings API and localStorage cache
 */
const saveState = (enabled) => {
  hudEnabled = enabled;

  // Write to localStorage as fast cache
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch (err) {
    debug && console.log('[ext:hud] Failed to cache state to localStorage:', err);
  }

  // Write to extension settings API (datastore) as source of truth
  if (api?.settings?.setKey) {
    api.settings.setKey('overlay_visible', enabled).then(result => {
      if (result.success) {
        console.log('[ext:hud] Saved state to datastore - overlay_visible:', enabled);
      } else {
        console.error('[ext:hud] Failed to save state to datastore:', result.error);
      }
    }).catch(err => {
      console.error('[ext:hud] Failed to save state to datastore:', err);
    });
  } else {
    console.log('[ext:hud] Saved state to localStorage only - enabled:', enabled);
  }
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
    height: 400,
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
