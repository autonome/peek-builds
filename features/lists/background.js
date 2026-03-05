/**
 * Lists Extension Background Script
 *
 * Search across local items, tags, and history.
 *
 * Commands and shortcuts are declared in manifest.json.
 * This extension loads lazily on first command invocation.
 * The shortcut key is configurable — manifest provides the default (Option+F),
 * and if the user customizes it, the extension registers the custom key on load.
 *
 * Runs in isolated extension process (peek://ext/lists/background.html)
 * Uses api.settings for datastore-backed settings storage
 */

import { id, labels, schemas, storageKeys, defaults } from './config.js';

const api = window.app;
const debug = api.debug;

// Extension content is served from peek://ext/lists/
const address = 'peek://ext/lists/home.html';

// In-memory settings cache (loaded from datastore on init)
let currentSettings = {
  prefs: defaults.prefs
};

// Track registered shortcut for cleanup (only used for custom shortcut keys)
let registeredShortcut = null;

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
    console.error('[ext:lists] Failed to save settings:', result.error);
  }
};

let isOpeningSearch = false;
const openSearchWindow = async () => {
  if (isOpeningSearch) return;
  isOpeningSearch = true;
  try {
    const params = {
      role: 'workspace',
      key: address,
      height: 768,
      width: 700,
      trackingSource: 'cmd',
      trackingSourceId: 'search'
    };

    await api.window.open(address, params);
  } catch (error) {
    console.error('[ext:lists] Failed to open search window:', error);
  } finally {
    isOpeningSearch = false;
  }
};

// ===== Registration =====

/**
 * Register a custom shortcut key (only if different from manifest default)
 */
const initShortcut = (shortcut) => {
  // Manifest declares Option+f as default — only register imperatively
  // if the user has customized the shortcut key
  if (shortcut && shortcut !== 'Option+f') {
    api.shortcuts.register(shortcut, () => {
      openSearchWindow();
    }, { global: true });
    registeredShortcut = shortcut;
  }
};

const init = async () => {
  // Load settings from datastore
  currentSettings = await loadSettings();

  // Register command handler — manifest declares the command,
  // lazy stub registers metadata, this sets up the execute handler
  api.commands.register({
    name: 'lists',
    description: 'Search local items, tags, and history',
    execute: async () => { openSearchWindow(); }
  });

  // Register custom shortcut if user has configured one
  initShortcut(currentSettings.prefs.shortcutKey);

  // Listen for settings changes to hot-reload (GLOBAL scope for cross-process)
  api.subscribe('lists:settings-changed', async () => {
    debug && console.log('[ext:lists] settings changed, reinitializing');
    uninitShortcut();
    currentSettings = await loadSettings();
    initShortcut(currentSettings.prefs.shortcutKey);
  }, api.scopes.GLOBAL);

  // Listen for settings updates from Settings UI
  api.subscribe('lists:settings-update', async (msg) => {
    debug && console.log('[ext:lists] settings-update received:', msg);

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

      uninitShortcut();
      initShortcut(currentSettings.prefs.shortcutKey);

      api.publish('lists:settings-changed', currentSettings, api.scopes.GLOBAL);
    } catch (err) {
      console.error('[ext:lists] settings-update error:', err);
    }
  }, api.scopes.GLOBAL);
};

const uninitShortcut = () => {
  if (registeredShortcut) {
    api.shortcuts.unregister(registeredShortcut, { global: true });
    registeredShortcut = null;
  }
};

const uninit = () => {
  uninitShortcut();
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
