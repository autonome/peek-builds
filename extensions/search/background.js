/**
 * Search Extension Background Script
 *
 * Unified search across items, history, tags, and groups.
 *
 * Runs in isolated extension process (peek://ext/search/background.html)
 * Uses api.settings for datastore-backed settings storage
 */

import { id, labels, schemas, storageKeys, defaults } from './config.js';

const api = window.app;
const debug = api.debug;

console.log('[ext:search] background', labels.name);

// Extension content is served from peek://ext/search/
const address = 'peek://ext/search/home.html';

// In-memory settings cache (loaded from datastore on init)
let currentSettings = {
  prefs: defaults.prefs
};

// Track registered shortcut for cleanup
let registeredShortcut = null;
let registeredCommands = [];

/**
 * Load settings from datastore
 * @returns {Promise<{prefs: object}>}
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
 * Save settings to datastore
 * @param {object} settings - Settings object with prefs
 */
const saveSettings = async (settings) => {
  const result = await api.settings.set(settings);
  if (!result.success) {
    console.error('[ext:search] Failed to save settings:', result.error);
  }
};

let isOpeningSearch = false;
const openSearchWindow = async () => {
  if (isOpeningSearch) return;
  isOpeningSearch = true;
  try {
    const height = 600;
    const width = 700;

    const params = {
      // IZUI role
      role: 'workspace',

      key: address,
      height,
      width,
      trackingSource: 'cmd',
      trackingSourceId: 'search'
    };

    const window = await api.window.open(address, params);
    debug && console.log('[ext:search] Search window opened:', window);
  } catch (error) {
    console.error('[ext:search] Failed to open search window:', error);
  } finally {
    isOpeningSearch = false;
  }
};

// ===== Command definitions =====

const commandDefinitions = [
  {
    name: 'search',
    description: 'Open unified search',
    execute: async (ctx) => {
      console.log('[ext:search] Opening search window');
      openSearchWindow();
    }
  }
];

// ===== Registration =====

const initShortcut = (shortcut) => {
  api.shortcuts.register(shortcut, () => {
    openSearchWindow();
  }, { global: true });
  registeredShortcut = shortcut;
};

const initCommands = () => {
  commandDefinitions.forEach(cmd => {
    api.commands.register(cmd);
    registeredCommands.push(cmd.name);
  });
  console.log('[ext:search] Registered commands:', registeredCommands);
};

const uninitCommands = () => {
  registeredCommands.forEach(name => {
    api.commands.unregister(name);
  });
  registeredCommands = [];
  console.log('[ext:search] Unregistered commands');
};

const init = async () => {
  console.log('[ext:search] init');

  // Load settings from datastore
  currentSettings = await loadSettings();

  initShortcut(currentSettings.prefs.shortcutKey);

  // Wait for cmd:ready before registering commands
  api.subscribe('cmd:ready', () => {
    initCommands();
  }, api.scopes.GLOBAL);

  // Query in case cmd is already ready (it usually is since cmd loads first)
  api.publish('cmd:query', {}, api.scopes.GLOBAL);

  // Listen for settings changes to hot-reload (GLOBAL scope for cross-process)
  api.subscribe('search:settings-changed', async () => {
    console.log('[ext:search] settings changed, reinitializing');
    uninit();
    currentSettings = await loadSettings();
    initShortcut(currentSettings.prefs.shortcutKey);
    initCommands();
  }, api.scopes.GLOBAL);

  // Listen for settings updates from Settings UI
  api.subscribe('search:settings-update', async (msg) => {
    console.log('[ext:search] settings-update received:', msg);

    try {
      if (msg.data) {
        currentSettings = {
          prefs: msg.data.prefs || currentSettings.prefs
        };
      } else if (msg.key === 'prefs' && msg.path) {
        const field = msg.path.split('.')[1];
        if (field) {
          currentSettings.prefs = { ...currentSettings.prefs, [field]: msg.value };
        }
      }

      await saveSettings(currentSettings);

      uninit();
      initShortcut(currentSettings.prefs.shortcutKey);
      initCommands();

      api.publish('search:settings-changed', currentSettings, api.scopes.GLOBAL);
    } catch (err) {
      console.error('[ext:search] settings-update error:', err);
    }
  }, api.scopes.GLOBAL);
};

const uninit = () => {
  console.log('[ext:search] uninit');
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
