/**
 * Slides Extension Background Script
 *
 * Edge-anchored slide-in panels triggered by keyboard shortcuts (Option+Arrow)
 *
 * Runs in isolated extension process (peek://slides/background.html)
 * Uses api.settings for datastore-backed settings storage
 */

import { id, labels, schemas, storageKeys, defaults } from './config.js';

const api = window.app;

console.log('[ext:slides] background', labels.name);

// Map to track opened slides - key is slide key, value is window ID
const slideWindows = new Map();

// Track registered shortcuts for cleanup
let registeredShortcuts = [];

// In-memory settings cache (loaded from datastore on init)
let currentSettings = {
  prefs: defaults.prefs,
  items: defaults.items
};

/**
 * Load settings from datastore
 * @returns {Promise<{prefs: object, items: array}>}
 */
const loadSettings = async () => {
  const prefsResult = await api.settings.get('prefs');
  const itemsResult = await api.settings.get('items');
  return {
    prefs: (prefsResult && !prefsResult.error && prefsResult.value) || defaults.prefs,
    items: (itemsResult && !itemsResult.error && itemsResult.value) || defaults.items
  };
};

/**
 * Save settings to datastore
 * @param {object} settings - Settings object with prefs and items
 */
const saveSettings = async (settings) => {
  const prefsResult = await api.settings.set('prefs', settings.prefs);
  if (prefsResult && prefsResult.error) {
    console.error('[ext:slides] Failed to save prefs:', prefsResult.error);
  }
  const itemsResult = await api.settings.set('items', settings.items);
  if (itemsResult && itemsResult.error) {
    console.error('[ext:slides] Failed to save items:', itemsResult.error);
  }
};

const executeItem = (item) => {
  const height = item.height || 600;
  const width = item.width || 800;

  console.log('[ext:slides] execute slide', item.screenEdge);

  const key = `${item.address}:${item.screenEdge}`;

  // Check if this slide is already open
  if (slideWindows.has(key)) {
    const windowId = slideWindows.get(key);
    console.log('[ext:slides] Slide already open, verifying window exists with ID:', windowId);

    api.window.exists(windowId).then(existsResult => {
      if (existsResult.exists) {
        api.window.show(windowId).then(result => {
          if (result.success) {
            console.log('[ext:slides] Successfully showed existing slide:', key);
          } else {
            console.error('[ext:slides] Failed to show existing slide:', result.error);
            slideWindows.delete(key);
            openNewSlide();
          }
        }).catch(err => {
          console.error('[ext:slides] Error showing window:', err);
          slideWindows.delete(key);
          openNewSlide();
        });
      } else {
        console.log('[ext:slides] Window no longer exists, creating new one');
        slideWindows.delete(key);
        openNewSlide();
      }
    }).catch(err => {
      console.error('[ext:slides] Error checking if window exists:', err);
      slideWindows.delete(key);
      openNewSlide();
    });
  } else {
    openNewSlide();
  }

  function openNewSlide() {
    const params = {
      // IZUI role
      role: 'quick-view',

      address: item.address,
      height,
      width,
      key,

      // modal behavior
      modal: true,
      // canvas: true → page-host shell with address bar (task ff3b18ba)
      canvas: true,
      type: 'panel',

      keepLive: item.keepLive || false,
      persistState: item.persistState || false,

      // Slides emit `screenEdge` ('Up'|'Down'|'Left'|'Right'); the
      // window-open path in main maps it to `placement: { mode: 'edge', edge }`
      // and computes bounds via `computeInitialBounds` against the cursor's
      // display every time the slide opens (and re-anchors via
      // `computePlacement` on reuse + display-change). The renderer no
      // longer computes x/y — main owns placement. See apps/desktop/main/
      // window-placement.ts and ipc.ts edgeMap.
      screenEdge: item.screenEdge,

      // tracking
      trackingSource: 'slide',
      trackingSourceId: item.screenEdge ? `slide_${item.screenEdge}` : 'slide',
      title: item.title || ''
    };

    api.window.open(item.address, params).then(result => {
      if (result.success) {
        console.log('[ext:slides] Successfully opened slide with ID:', result.id);
        slideWindows.set(key, result.id);
      } else {
        console.error('[ext:slides] Failed to open slide:', result.error);
      }
    });
  }
};

const initItems = (prefs, items) => {
  const cmdPrefix = prefs.shortcutKeyPrefix;

  items.forEach(item => {
    if (item.enabled == true && item.address && item.address.length > 0) {
      const shortcut = `${cmdPrefix}${item.screenEdge}`;

      api.shortcuts.register(shortcut, () => {
        executeItem(item);
      }, { global: true });

      // Local fallback so the shortcut still fires when a Peek window is
      // focused on platforms (Linux/Wayland) where global registration
      // silently fails.
      api.shortcuts.register(shortcut, () => {
        executeItem(item);
      });

      registeredShortcuts.push(shortcut);
    }
  });
};

/**
 * Unregister all shortcuts and clean up windows
 */
const uninit = () => {
  console.log('[ext:slides] uninit - unregistering', registeredShortcuts.length, 'shortcuts');

  registeredShortcuts.forEach(shortcut => {
    api.shortcuts.unregister(shortcut, { global: true });
    api.shortcuts.unregister(shortcut);
  });
  registeredShortcuts = [];

  // Close or hide all slide windows
  for (const [key, windowId] of slideWindows.entries()) {
    console.log('[ext:slides] Closing slide window:', key);
    api.window.hide(windowId).then(result => {
      if (!result || !result.success) {
        console.error('[ext:slides] Failed to hide slide window:', result && result.error);
        // Strict close is fire-and-forget (no return value)
        try { api.window.close(windowId); } catch (err) {
          console.error('[ext:slides] Error closing slide window:', err);
        }
      }
    }).catch(err => {
      console.error('[ext:slides] Error hiding slide window:', err);
      try { api.window.close(windowId); } catch (closeErr) {
        console.error('[ext:slides] Error closing slide window:', closeErr);
      }
    });
  }
  slideWindows.clear();
};

/**
 * Reinitialize slides (called when settings change)
 */
const reinit = async () => {
  console.log('[ext:slides] reinit');
  uninit();

  currentSettings = await loadSettings();

  if (currentSettings.items && currentSettings.items.length > 0) {
    initItems(currentSettings.prefs, currentSettings.items);
  }
};

const init = async () => {
  console.log('[ext:slides] init');

  // Load settings from datastore
  currentSettings = await loadSettings();

  // Add global window closed handler
  api.pubsub.subscribe('window:closed', (data) => {
    for (const [key, windowId] of slideWindows.entries()) {
      if (data.id === windowId) {
        console.log('[ext:slides] Slide window was closed externally:', key);
        slideWindows.delete(key);
      }
    }
  });

  // Initialize slides
  if (currentSettings.items && currentSettings.items.length > 0) {
    initItems(currentSettings.prefs, currentSettings.items);
  }

  // Listen for settings changes to hot-reload (GLOBAL scope for cross-process)
  api.pubsub.subscribe('slides:settings-changed', () => {
    console.log('[ext:slides] settings changed, reinitializing');
    reinit();
  });

  // CLI verb: open slide on edge. Args: [edge in {Up,Down,Left,Right}].
  // Case-insensitive on input. See cli-router.ts and
  // docs/global-hotkeys-on-wayland.md.
  api.pubsub.subscribe('cli:slide-open', (msg) => {
    const raw = String(msg?.args?.[0] ?? '');
    const edge = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    const item = (currentSettings.items || []).find(i => i.screenEdge === edge && i.enabled);
    if (!item) {
      console.warn('[ext:slides] cli:slide-open — no enabled item with screenEdge=' + edge);
      return;
    }
    console.log('[ext:slides] cli:slide-open edge=' + edge);
    executeItem(item);
  });

  // Listen for settings updates from Settings UI
  // Settings UI sends proposed changes, we validate and save
  api.pubsub.subscribe('slides:settings-update', async (msg) => {
    console.log('[ext:slides] settings-update received:', msg);

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
      api.pubsub.publish('slides:settings-changed', currentSettings);
    } catch (err) {
      console.error('[ext:slides] settings-update error:', err);
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
