/**
 * Peeks Extension Background Script
 *
 * Quick access modal windows for web pages via keyboard shortcuts (Option+0-9)
 *
 * Runs in isolated extension process (peek://peeks/background.html)
 * Uses api.settings for datastore-backed settings storage
 */

import { id, labels, schemas, storageKeys, defaults } from './config.js';

const api = window.app;

console.log('[ext:peeks] background', labels.name);

// Track registered shortcuts for cleanup
let registeredShortcuts = [];

// In-memory settings cache (loaded from datastore on init)
let currentSettings = {
  prefs: defaults.prefs,
  items: defaults.items
};

/**
 * Load settings from datastore
 *
 * Storage uses two separate keys per the settings-schema.json:
 *   - 'prefs' → { shortcutKeyPrefix }
 *   - 'items' → array of peek configs
 *
 * @returns {Promise<{prefs: object, items: array}>}
 */
const loadSettings = async () => {
  const prefsResult = await api.settings.get('prefs');
  const itemsResult = await api.settings.get('items');

  const prefs = (prefsResult.success && prefsResult.data)
    ? prefsResult.data
    : defaults.prefs;
  const items = (itemsResult.success && itemsResult.data)
    ? itemsResult.data
    : defaults.items;

  return { prefs, items };
};

/**
 * Save settings to datastore
 * @param {object} settings - Settings object with prefs and items
 */
const saveSettings = async (settings) => {
  const prefsResult = await api.settings.set('prefs', settings.prefs);
  if (!prefsResult.success) {
    console.error('[ext:peeks] Failed to save prefs:', prefsResult.error);
  }
  const itemsResult = await api.settings.set('items', settings.items);
  if (!itemsResult.success) {
    console.error('[ext:peeks] Failed to save items:', itemsResult.error);
  }
};

/**
 * Open a peek window for the given item
 */
const executeItem = (item) => {
  console.log('[ext:peeks] executeItem', item);
  const height = item.height || 600;
  const width = item.width || 800;

  const params = {
    // IZUI role
    role: 'quick-view',

    // browserwindow
    height,
    width,

    // modal behavior
    modal: true,
    // canvas: true → page-host shell with address bar (task ff3b18ba)
    canvas: true,
    type: 'panel',

    // placement: peeks center on the cursor display regardless of size
    center: true,

    // peek
    keepLive: item.keepLive || false,
    persistState: item.persistState || false,

    // Create a unique key for this peek using its address
    key: `peek:${item.address}`,

    // tracking
    trackingSource: 'peek',
    trackingSourceId: item.keyNum ? `peek_${item.keyNum}` : 'peek',
    title: item.title || ''
  };

  api.window.open(item.address, params)
    .then(result => {
      console.log('[ext:peeks] Peek window opened:', result);
    })
    .catch(error => {
      console.error('[ext:peeks] Failed to open peek window:', error);
    });
};

/**
 * Initialize shortcuts for enabled items
 */
const initItems = (prefs, items) => {
  const cmdPrefix = prefs.shortcutKeyPrefix;

  items.forEach(item => {
    if (item.enabled == true && item.address && item.address.length > 0) {
      const shortcut = `${cmdPrefix}${item.keyNum}`;

      api.shortcuts.register(shortcut, () => {
        executeItem(item);
      }, { global: true });

      // Local fallback so the shortcut still fires when a Peek window is
      // focused on platforms (Linux/Wayland) where global registration
      // silently fails — the global call returns false but a local handler
      // is always available.
      api.shortcuts.register(shortcut, () => {
        executeItem(item);
      });

      registeredShortcuts.push(shortcut);
    }
  });
};

/**
 * Unregister all shortcuts and clean up
 */
const uninit = () => {
  console.log('[ext:peeks] uninit - unregistering', registeredShortcuts.length, 'shortcuts');

  registeredShortcuts.forEach(shortcut => {
    api.shortcuts.unregister(shortcut, { global: true });
    api.shortcuts.unregister(shortcut);
  });

  registeredShortcuts = [];
};

/**
 * Reinitialize peeks (called when settings change)
 */
const reinit = async () => {
  console.log('[ext:peeks] reinit');
  uninit();

  currentSettings = await loadSettings();

  if (currentSettings.items && currentSettings.items.length > 0) {
    initItems(currentSettings.prefs, currentSettings.items);
  }
};

/**
 * Initialize the extension
 */
const init = async () => {
  console.log('[ext:peeks] init');

  // Load settings from datastore
  currentSettings = await loadSettings();

  // Initialize peeks if we have items
  if (currentSettings.items && currentSettings.items.length > 0) {
    initItems(currentSettings.prefs, currentSettings.items);
  }

  // Listen for settings changes to hot-reload (GLOBAL scope for cross-process)
  api.pubsub.subscribe('peeks:settings-changed', () => {
    console.log('[ext:peeks] settings changed, reinitializing');
    reinit();
  });

  // CLI verb: open peek N. Args: [keyNum]. Lets users bind a system
  // shortcut (peek-cli peek-open 3) instead of relying on Electron's
  // globalShortcut, which doesn't grab on Wayland. See cli-router.ts.
  api.pubsub.subscribe('cli:peek-open', (msg) => {
    const keyNum = String(msg?.args?.[0] ?? '');
    const item = (currentSettings.items || []).find(i => String(i.keyNum) === keyNum && i.enabled);
    if (!item) {
      console.warn('[ext:peeks] cli:peek-open — no enabled item with keyNum=' + keyNum);
      return;
    }
    console.log('[ext:peeks] cli:peek-open keyNum=' + keyNum);
    executeItem(item);
  });

  // Listen for settings updates from Settings UI
  // Settings UI sends proposed changes, we validate and save
  api.pubsub.subscribe('peeks:settings-update', async (msg) => {
    console.log('[ext:peeks] settings-update received:', msg);

    try {
      // Apply the update based on what was sent
      if (msg.data) {
        // Full data object sent
        currentSettings = {
          prefs: msg.data.prefs || currentSettings.prefs,
          items: msg.data.items || currentSettings.items
        };
      } else if (msg.key === 'prefs' && msg.path) {
        // Single pref field update
        const field = msg.path.split('.')[1];
        if (field) {
          currentSettings.prefs = { ...currentSettings.prefs, [field]: msg.value };
        }
      } else if (msg.key === 'items' && msg.index !== undefined) {
        // Item field update
        const items = [...currentSettings.items];
        if (items[msg.index]) {
          items[msg.index] = { ...items[msg.index], [msg.field]: msg.value };
          currentSettings.items = items;
        }
      }

      // Save to datastore
      await saveSettings(currentSettings);

      // Reinitialize with new settings
      await reinit();

      // Confirm change back to Settings UI
      api.pubsub.publish('peeks:settings-changed', currentSettings);
    } catch (err) {
      console.error('[ext:peeks] settings-update error:', err);
    }
  });
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
