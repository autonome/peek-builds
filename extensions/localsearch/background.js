/**
 * Local Search Extension Background Script
 *
 * Search across local items, tags, and history.
 *
 * Runs in isolated extension process (peek://ext/localsearch/background.html)
 * Uses api.settings for datastore-backed settings storage
 */

import { id, labels, schemas, storageKeys, defaults } from './config.js';

const api = window.app;
const debug = api.debug;

console.log('[ext:localsearch] background', labels.name);

// Extension content is served from peek://ext/localsearch/
const address = 'peek://ext/localsearch/home.html';

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
    console.error('[ext:localsearch] Failed to save settings:', result.error);
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
    debug && console.log('[ext:localsearch] Search window opened:', window);
  } catch (error) {
    console.error('[ext:localsearch] Failed to open search window:', error);
  } finally {
    isOpeningSearch = false;
  }
};

// ===== Command definitions =====

const commandDefinitions = [
  {
    name: 'localsearch',
    description: 'Search local items, tags, and history',
    execute: async (ctx) => {
      console.log('[ext:localsearch] Opening search window');
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
  // Flush immediately to ensure batch reaches cmd extension
  if (api.commands.flush) {
    api.commands.flush();
  }
  console.log('[ext:localsearch] Registered commands:', registeredCommands);
};

const uninitCommands = () => {
  registeredCommands.forEach(name => {
    api.commands.unregister(name);
  });
  registeredCommands = [];
  console.log('[ext:localsearch] Unregistered commands');
};

const init = async () => {
  console.log('[ext:localsearch] init');

  // Load settings from datastore
  currentSettings = await loadSettings();

  initShortcut(currentSettings.prefs.shortcutKey);

  // Wait for cmd:ready before registering commands
  let commandsRegistered = false;
  api.subscribe('cmd:ready', () => {
    if (!commandsRegistered) {
      commandsRegistered = true;
      initCommands();
    }
  }, api.scopes.GLOBAL);

  // Query in case cmd is already ready, with retries.
  // The cmd:query -> cmd:ready roundtrip crosses multiple IPC boundaries
  // (iframe -> main -> cmd iframe -> main -> localsearch iframe) and can be lost.
  const retryCmdQuery = (attempt) => {
    if (commandsRegistered || attempt >= 5) return;
    api.publish('cmd:query', {}, api.scopes.GLOBAL);
    setTimeout(() => retryCmdQuery(attempt + 1), 500);
  };
  retryCmdQuery(0);

  // Listen for settings changes to hot-reload (GLOBAL scope for cross-process)
  api.subscribe('localsearch:settings-changed', async () => {
    console.log('[ext:localsearch] settings changed, reinitializing');
    uninit();
    currentSettings = await loadSettings();
    initShortcut(currentSettings.prefs.shortcutKey);
    initCommands();
  }, api.scopes.GLOBAL);

  // Listen for settings updates from Settings UI
  api.subscribe('localsearch:settings-update', async (msg) => {
    console.log('[ext:localsearch] settings-update received:', msg);

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

      api.publish('localsearch:settings-changed', currentSettings, api.scopes.GLOBAL);
    } catch (err) {
      console.error('[ext:localsearch] settings-update error:', err);
    }
  }, api.scopes.GLOBAL);
};

const uninit = () => {
  console.log('[ext:localsearch] uninit');
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
