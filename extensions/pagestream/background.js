/**
 * Pagestream Extension Background Script
 *
 * Vertical, chat-like navigational interface for web history.
 *
 * Runs in isolated extension process (peek://ext/pagestream/background.html)
 * Uses api.settings for datastore-backed settings storage
 */

import { id, labels, schemas, storageKeys, defaults } from './config.js';
import { registerNoun, unregisterNoun } from 'peek://ext/cmd/nouns.js';

const api = window.app;
const debug = api.debug;

console.log('[ext:pagestream] background', labels.name);

// Extension content is served from peek://ext/pagestream/
const address = 'peek://ext/pagestream/home.html';

// In-memory settings cache (loaded from datastore on init)
let currentSettings = {
  prefs: defaults.prefs
};

// Track the pagestream window ID
let pagestreamWindowId = null;

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
    console.error('[ext:pagestream] Failed to save settings:', result.error);
  }
};

let isOpeningPagestream = false;
const openPagestreamWindow = async () => {
  if (isOpeningPagestream) return;
  isOpeningPagestream = true;
  try {
    let screenW = 1440, screenH = 900;
    try {
      screenW = window.screen.availWidth || window.screen.width || 1440;
      screenH = window.screen.availHeight || window.screen.height || 900;
    } catch {}
    const width = screenW;
    const height = screenH;

    const params = {
      // IZUI role
      role: 'workspace',

      key: address,
      height,
      width,
      transparent: true,
      trackingSource: 'cmd',
      trackingSourceId: 'pagestream'
    };

    const win = await api.window.open(address, params);
    debug && console.log('[ext:pagestream] Pagestream window opened:', win);
    pagestreamWindowId = win?.id || null;
  } catch (error) {
    console.error('[ext:pagestream] Failed to open pagestream window:', error);
  } finally {
    isOpeningPagestream = false;
  }
};

// ===== Registration =====

let registeredShortcut = null;

const initShortcut = (shortcut) => {
  api.shortcuts.register(shortcut, () => {
    openPagestreamWindow();
  }, { global: true });
  registeredShortcut = shortcut;
};

const initCommands = () => {
  registerNoun({
    name: 'pagestream',
    singular: 'pagestream',
    description: 'Browsing history stream',
    skipBare: false,
    browse: async () => { openPagestreamWindow(); },
  });
  console.log('[ext:pagestream] Noun registered: pagestream');
};

const uninitCommands = () => {
  unregisterNoun('pagestream');
  console.log('[ext:pagestream] Noun unregistered: pagestream');
};

const init = async () => {
  console.log('[ext:pagestream] init');

  // Load settings from datastore
  currentSettings = await loadSettings();

  initShortcut(currentSettings.prefs.shortcutKey);

  // Register commands (cmd loads first with its subscribers ready via 100ms head start)
  initCommands();

  // Listen for window close events
  api.subscribe('window:closed', async (msg) => {
    const closedWindowId = msg?.id;
    if (closedWindowId === pagestreamWindowId) {
      debug && console.log('[ext:pagestream] Pagestream window closed');
      pagestreamWindowId = null;
    }
  }, api.scopes.GLOBAL);

  // Listen for settings changes to hot-reload
  api.subscribe('pagestream:settings-changed', async () => {
    console.log('[ext:pagestream] settings changed, reinitializing');
    uninit();
    currentSettings = await loadSettings();
    initShortcut(currentSettings.prefs.shortcutKey);
    initCommands();
  }, api.scopes.GLOBAL);

  // Listen for settings updates from Settings UI
  api.subscribe('pagestream:settings-update', async (msg) => {
    console.log('[ext:pagestream] settings-update received:', msg);

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

      api.publish('pagestream:settings-changed', currentSettings, api.scopes.GLOBAL);
    } catch (err) {
      console.error('[ext:pagestream] settings-update error:', err);
    }
  }, api.scopes.GLOBAL);
};

const uninit = () => {
  console.log('[ext:pagestream] uninit');
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
