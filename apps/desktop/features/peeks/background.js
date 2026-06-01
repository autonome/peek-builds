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
 * Initialize shortcuts for enabled items.
 *
 * Peeks is a LAZY tile: its renderer isn't running at boot, so it cannot
 * call `api.shortcuts.register({global:true})` to own its global hotkeys
 * (that's the chicken-and-egg the wake-shortcut registry solves). Instead
 * we DECLARE the full enabled set to the main process via
 * `declareWakeShortcuts` — main persists it and registers each accelerator
 * as a global wake hotkey that, when pressed, publishes `cli:peek-open`
 * with `{args:[keyNum]}`, waking this tile (lazyEvents) and routing to the
 * `cli:peek-open` subscriber below, which opens the matching peek. The
 * dynamic accelerator computation (prefix + keyNum) STAYS here in the
 * renderer; main holds only feature-agnostic infra.
 *
 * The LOCAL (non-global) fallback registrations remain — they only matter
 * while this tile is already awake/focused (e.g. Linux/Wayland where the
 * global grab silently fails), so they don't need the lazy path.
 */
const initItems = (prefs, items) => {
  const cmdPrefix = prefs.shortcutKeyPrefix;

  const enabledItems = items.filter(
    item => item.enabled == true && item.address && item.address.length > 0
  );

  // Declare the full set of global wake hotkeys to main (snapshot /
  // replace-all). One entry per enabled item. The accelerator format and
  // the cli:peek-open arg shape MUST match the `cli:peek-open` subscriber:
  // it reads `String(msg.args[0])` and matches it against `String(keyNum)`.
  api.shortcuts.declareWakeShortcuts(
    enabledItems.map(item => ({
      accelerator: `${cmdPrefix}${item.keyNum}`,
      wakeTopic: 'cli:peek-open',
      wakeArgs: [String(item.keyNum)],
    }))
  );

  enabledItems.forEach(item => {
    const shortcut = `${cmdPrefix}${item.keyNum}`;

    // Local fallback so the shortcut still fires when a Peek window is
    // focused on platforms (Linux/Wayland) where global registration
    // silently fails. Local-only (no {global:true}) — relevant only while
    // this tile is already awake; the global path is owned by main's
    // wake-shortcut registry via declareWakeShortcuts above.
    api.shortcuts.register(shortcut, () => {
      executeItem(item);
    });

    registeredShortcuts.push(shortcut);
  });
};

/**
 * Unregister all shortcuts and clean up
 */
const uninit = () => {
  console.log('[ext:peeks] uninit - unregistering', registeredShortcuts.length, 'local shortcuts');

  // Only LOCAL fallbacks are registered from this renderer now; the global
  // wake hotkeys are owned by main's wake-shortcut registry (re-declared on
  // the next declareWakeShortcuts in initItems), so we don't unregister
  // them here.
  registeredShortcuts.forEach(shortcut => {
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

  // Subscribe to wake topics FIRST — before the async loadSettings() await.
  // peeks is a LAZY tile woken by a `cli:peek-open` lazyEvent: the
  // load-on-dispatch hook re-delivers that publish once this tile reaches
  // the READY FSM state, which the tile-preload signals (deferred a tick)
  // inside api.initialize() — i.e. BEFORE this init()'s awaits resolve. If
  // we subscribed AFTER `await loadSettings()`, the woken publish would land
  // with no subscriber and be dropped (the cold-boot subscribe-race). The
  // handler reads `currentSettings` lazily, so subscribing pre-load is safe;
  // currentSettings is seeded with defaults (item 0 enabled) until the
  // datastore read completes.

  // Listen for settings changes to hot-reload (GLOBAL scope for cross-process)
  api.pubsub.subscribe('peeks:settings-changed', () => {
    console.log('[ext:peeks] settings changed, reinitializing');
    reinit();
  });

  // CLI verb: open peek N. Args: [keyNum]. Lets users bind a system
  // shortcut (peek-cli peek-open 3) instead of relying on Electron's
  // globalShortcut, which doesn't grab on Wayland. Also the wake target for
  // the static-default / persisted global hotkeys (see initItems +
  // feature-shortcut-registrar.ts). See cli-router.ts.
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

  // Load settings from datastore
  currentSettings = await loadSettings();

  // Initialize peeks if we have items
  if (currentSettings.items && currentSettings.items.length > 0) {
    initItems(currentSettings.prefs, currentSettings.items);
  }

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
