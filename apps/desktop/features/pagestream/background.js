/**
 * Pagestream Extension Background Script
 *
 * Vertical, chat-like navigational interface for web history.
 *
 * Runs in isolated extension process (peek://pagestream/background.html)
 * Uses api.settings for datastore-backed settings storage
 */

import { id, labels, schemas, storageKeys, defaults } from './config.js';
import { registerNoun, unregisterNoun } from 'peek://cmd/nouns.js';

const api = window.app;

// Extension content is served from peek://pagestream/
const address = 'peek://pagestream/home.html';

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
  const result = await api.settings.get('prefs');
  if (result && !result.error && result.value) {
    return { prefs: result.value };
  }
  return { prefs: defaults.prefs };
};

/**
 * Save settings to datastore
 * @param {object} settings - Settings object with prefs
 */
const saveSettings = async (settings) => {
  const result = await api.settings.set('prefs', settings.prefs);
  if (result && result.error) {
    console.error('[ext:pagestream] Failed to save settings:', result.error);
  }
};

let isOpeningPagestream = false;
const openPagestreamWindow = async () => {
  if (isOpeningPagestream) return;
  isOpeningPagestream = true;
  try {
    // Try to show existing window first (faster perceived perf)
    if (pagestreamWindowId) {
      const exists = await api.window.exists(pagestreamWindowId);
      if (exists.success && exists.data) {
        await api.window.show(pagestreamWindowId);
        return;
      }
      pagestreamWindowId = null;
    }

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
  // Register command handler so lazy-loading stub's re-publish of
  // cmd:execute:pagestream is caught (not just noun:browse:pagestream)
  api.commands.register({
    name: 'pagestream',
    description: 'Browsing history stream',
    execute: () => openPagestreamWindow()
  });

  registerNoun({
    name: 'pagestream',
    singular: 'pagestream',
    description: 'Browsing history stream',
    skipBare: true,
    browse: async () => { openPagestreamWindow(); },
  });
};

const uninitCommands = () => {
  unregisterNoun('pagestream');
};

const init = async () => {
  // Load settings from datastore
  currentSettings = await loadSettings();

  initShortcut(currentSettings.prefs.shortcutKey);

  // Register commands (cmd loads first with its subscribers ready via 100ms head start)
  initCommands();

  // Listen for window close events
  api.pubsub.subscribe('window:closed', async (msg) => {
    const closedWindowId = msg?.id;
    if (closedWindowId === pagestreamWindowId) {
      pagestreamWindowId = null;
    }
  });

  // Listen for settings changes to hot-reload
  api.pubsub.subscribe('pagestream:settings-changed', async () => {
    uninit();
    currentSettings = await loadSettings();
    initShortcut(currentSettings.prefs.shortcutKey);
    initCommands();
  });

  // Listen for settings updates from Settings UI
  api.pubsub.subscribe('pagestream:settings-update', async (msg) => {

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

      api.pubsub.publish('pagestream:settings-changed', currentSettings);
    } catch (err) {
      console.error('[ext:pagestream] settings-update error:', err);
    }
  });
};

const uninit = () => {
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
