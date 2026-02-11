/**
 * Windows Extension Background Script
 *
 * Full-screen window switcher with transparent overlay
 *
 * Runs in isolated extension process (peek://ext/windows/background.html)
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

/**
 * Load settings from datastore
 */
const loadSettings = async () => {
  const result = await api.settings.get();
  if (result.success && result.data) {
    return {
      prefs: result.data.prefs || defaults.prefs
    };
  }
  return { prefs: defaults.prefs };
};

/**
 * Open the Windows view (maximized, transparent overlay)
 */
const openWindowsView = async () => {
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

  api.window.open(address, params)
    .then(window => {
      debug && console.log('[ext:windows] Windows view opened:', window);
    })
    .catch(error => {
      console.error('[ext:windows] Failed to open windows view:', error);
    });
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

  // Register commands directly (cmd loads first with its subscribers ready)
  initCommands();
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
