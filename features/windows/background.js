/**
 * Windows Extension Background Script
 *
 * Full-screen window switcher with transparent overlay
 *
 * Runs in isolated extension process (peek://windows/background.html)
 */

import { id, labels, schemas, storageKeys, defaults } from './config.js';

const api = window.app;
const debug = api.debug;

console.log('[ext:windows] background', labels.name);

// Extension content is served from peek://windows/ (hybrid mode)
const address = 'peek://windows/windows.html';

// In-memory settings cache
let currentSettings = {
  prefs: defaults.prefs
};

// Track the windows overlay window ID for show/hide reuse
let windowsViewId = null;

/**
 * Load settings from datastore
 */
const loadSettings = async () => {
  const result = await api.settings.get('prefs');
  if (result && !result.error && result.value) {
    return { prefs: result.value };
  }
  return { prefs: defaults.prefs };
};

/**
 * Open or show the Windows view (maximized, transparent overlay).
 * On first call, creates the window. On subsequent calls, shows it
 * if it still exists (faster perceived perf — no cold-start).
 */
const openWindowsView = async () => {
  // Try to show existing window first
  if (windowsViewId) {
    const exists = await api.window.exists(windowsViewId);
    if (exists.success && exists.data) {
      await api.window.show(windowsViewId);
      debug && console.log('[ext:windows] Windows view shown (reused):', windowsViewId);
      return;
    }
    windowsViewId = null;
  }

  const params = {
    // IZUI role
    role: 'overlay',

    key: address,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximize: true,
    type: 'panel',
    // Overlay mode: backend hides other windows when this opens,
    // and restores them when this closes
    overlay: true,
    trackingSource: 'windows',
    trackingSourceId: 'main'
  };

  try {
    const result = await api.window.open(address, params);
    if (result.success) {
      windowsViewId = result.id;
      debug && console.log('[ext:windows] Windows view created:', windowsViewId);
    }
  } catch (error) {
    console.error('[ext:windows] Failed to open windows view:', error);
  }
};

// ===== Command definitions =====

const commandDefinitions = [
  {
    name: 'windows',
    description: 'Show all windows in full-screen overlay',
    execute: async (ctx) => {
      console.log('[ext:windows] Opening windows view');
      openWindowsView();
    }
  },
  {
    name: 'center window',
    description: 'Center the active window on its display',
    execute: async (ctx) => {
      const windowId = await api.window.getFocusedVisibleWindowId();
      if (!windowId) return { success: false, error: 'No active window' };
      return api.window.center(windowId);
    }
  },
  {
    name: 'center all windows',
    description: 'Center all windows on their respective displays',
    execute: async (ctx) => {
      return api.window.centerAll();
    }
  },
  {
    name: 'maximize window',
    description: 'Maximize the active window',
    execute: async (ctx) => {
      const windowId = await api.window.getFocusedVisibleWindowId();
      if (!windowId) return { success: false, error: 'No active window' };
      return api.window.maximize(windowId);
    }
  },
  {
    name: 'fullscreen',
    description: 'Toggle fullscreen for the active window',
    execute: async (ctx) => {
      const windowId = await api.window.getFocusedVisibleWindowId();
      if (!windowId) return { success: false, error: 'No active window' };
      return api.window.fullscreen(windowId);
    }
  }
];

// ===== Registration =====

let registeredShortcut = null;
let registeredCommands = [];

const initShortcut = (shortcut) => {
  api.shortcuts.register(shortcut, () => {
    openWindowsView();
  }, { global: true });
  registeredShortcut = shortcut;
};

const initCommands = async () => {
  commandDefinitions.forEach(cmd => {
    api.commands.register(cmd);
    registeredCommands.push(cmd.name);
  });
  console.log('[ext:windows] Registered commands:', registeredCommands);
};

const uninitCommands = () => {
  registeredCommands.forEach(name => {
    api.commands.unregister(name);
  });
  registeredCommands = [];
  console.log('[ext:windows] Unregistered commands');
};

const init = async () => {
  console.log('[ext:windows] init');

  // Load settings from datastore
  currentSettings = await loadSettings();

  initShortcut(currentSettings.prefs.shortcutKey);

  // Register commands (cmd loads first with its subscribers ready via 100ms head start)
  initCommands();

  // Track when the windows view is closed so we know to recreate it
  api.pubsub.subscribe('window:closed', async (msg) => {
    if (msg?.id === windowsViewId) {
      debug && console.log('[ext:windows] Windows view closed');
      windowsViewId = null;
    }
  });
};

const uninit = () => {
  console.log('[ext:windows] uninit');
  if (registeredShortcut) {
    api.shortcuts.unregister(registeredShortcut, { global: true });
    registeredShortcut = null;
  }
  uninitCommands();
};

export default {
  defaults,
  id,
  init,
  uninit,
  labels,
  schemas,
  storageKeys
};
