/**
 * Peeks Extension Background Script
 *
 * Quick access modal windows for web pages via keyboard shortcuts (Option+0-9)
 *
 * Runs in isolated extension process (peek://peeks/background.html)
 * Uses api.settings for datastore-backed settings storage
 */

import { id, labels, schemas, storageKeys, defaults, relativeSize } from './config.js';

const api = window.app;

console.log('[ext:peeks] background', labels.name);

// Track registered shortcuts for cleanup
let registeredShortcuts = [];

// In-memory settings cache (loaded from datastore on init)
let currentSettings = {
  prefs: defaults.prefs,
  items: defaults.items
};

// Resolves once init() has loaded the user's real settings from the datastore
// into `currentSettings`. The lazy `cli:peek-open` wake handler awaits this
// before resolving a key to a peek, so the FIRST press that spawns this tile
// uses the user's saved peeks — NOT the bundled defaults (where only item 0 is
// enabled). Without it, a peek on any other key silently no-op'd on the first
// press after startup, then worked on the second. Sibling of the slides
// cold-wake settings race; see slides-settings-race.spec.ts.
let resolveSettingsLoaded;
const settingsLoaded = new Promise((resolve) => { resolveSettingsLoaded = resolve; });

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
// The size each peek was last resized to, by its window key (`peek:<keyNum>`):
// `{ [key]: { width, height, optionsWidth, optionsHeight } }`. Kept in its own
// `sizes` setting rather than on the `items` rows, so a resize never rewrites
// the rows the Features Manager Options panel edits. Filled from the datastore
// in init(), updated on every settled resize main reports as `window:resized`.
//
// `optionsWidth`/`optionsHeight` record the item's Options width/height at the
// time of the resize. The latest size edit wins: once the Options values differ
// from them, the Options panel was edited after the resize and its size is used
// instead. The comparison happens at open time rather than in the
// settings-changed subscriber because this tile is lazy — an Options edit made
// while it is asleep wakes it with the new rows already saved, so there are no
// old values left to diff against.
let savedSizes = {};

const loadSizes = async () => {
  const result = await api.settings.get('sizes');
  const value = result && result.success && result.data;
  return value && typeof value === 'object' ? value : {};
};

const windowKeyFor = (item) => `peek:${item.keyNum}`;

const optionsDim = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

// A saved resize still applies unless the item's Options width or height has
// changed since it was taken. Entries saved before the Options values were
// recorded carry no `optionsWidth` key and keep applying.
const resizeStillApplies = (saved, item) => {
  if (!saved) return false;
  if (!('optionsWidth' in saved)) return true;
  return optionsDim(saved.optionsWidth) === optionsDim(item.width)
    && optionsDim(saved.optionsHeight) === optionsDim(item.height);
};

// The width and height every item carried before peeks opened at a size relative
// to the display. Nearly every saved profile still holds it on every row, so a row
// at exactly that size has no size of its own and opens like a fresh one. The rows
// are left as they are; only this reading of them changed.
const SHIPPED_SIZE = { width: 1024, height: 768 };

// The size set in the Options panel, or null when the row carries none — an empty
// field, or the size peeks used to ship with.
const optionsSize = (item) => {
  const width = optionsDim(item.width);
  const height = optionsDim(item.height);
  if (!(width > 0) || !(height > 0)) return null;
  if (width === SHIPPED_SIZE.width && height === SHIPPED_SIZE.height) return null;
  return { width, height };
};

// Highest first: a remembered resize that still applies, the Options size, then a
// size relative to the display the peek opens on. The last is a pair of fractions
// rather than pixels because only main knows which display that is.
const sizeFor = (item) => {
  const saved = savedSizes[windowKeyFor(item)];
  const resized = resizeStillApplies(saved, item) ? saved : null;
  if (resized && resized.width > 0 && resized.height > 0) {
    return { width: resized.width, height: resized.height };
  }
  return optionsSize(item) || { relativeSize };
};

const executeItem = (item) => {
  console.log('[ext:peeks] executeItem', item);

  const params = {
    // IZUI role
    role: 'quick-view',

    // browserwindow
    ...sizeFor(item),

    // modal behavior
    modal: true,
    // pageHost: true → page-host shell with address bar (task ff3b18ba)
    pageHost: true,
    type: 'panel',

    // placement: peeks center on the cursor display regardless of size
    center: true,

    // peek
    keepLive: item.keepLive || false,
    persistState: item.persistState || false,

    // The window's identity is the SLOT, not the address. Reopening peek N
    // returns to peek N's own window, and two slots pointing at the same
    // address still get a window each. Keying on the address instead made two
    // slots sharing an address share one window, and left an edited slot's old
    // window stranded under a key nothing would reuse.
    // Known gap: `ipc.ts windowOpenHandler`'s hybrid key-reuse branch shows the
    // existing window without navigating it, so editing a slot's address does
    // not move that slot's open window to the new address.
    key: windowKeyFor(item),

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

  // Always (re)declare the wake set — even with zero items. An empty
  // declaration still sets the `lazy_wake_declared` marker, which the main-
  // process boot-time backfill relies on to know this tile has declared and
  // STOP re-waking it every startup. initItems handles an empty list.
  initItems(currentSettings.prefs, currentSettings.items || []);
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
  // with no subscriber and be dropped (the cold-boot subscribe-race).
  //
  // Registration must be synchronous (above), but the `cli:peek-open` handler
  // BODY must NOT run against the bundled defaults: the wake publish arrives at
  // READY, which beats the datastore-backed loadSettings() below, so a user
  // peek on a non-default key would be missed on the first press. The handler
  // therefore awaits `settingsLoaded` before reading `currentSettings`.

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
  api.pubsub.subscribe('cli:peek-open', async (msg) => {
    // Wait for the user's real settings before resolving the key, so the
    // tile-spawning FIRST press doesn't run against the bundled defaults (where
    // only item 0 is enabled). See settingsLoaded.
    await settingsLoaded;
    // Resolve the key against the SAVED settings, not `currentSettings`. An
    // address edit writes the row and then publishes peeks:settings-changed,
    // whose reinit() reloads asynchronously; a press landing before that reload
    // finished opened the old address. See peeks-address-edit-while-open.spec.ts
    // "hotkey pressed before settings-changed arrives".
    const saved = await loadSettings();
    const keyNum = String(msg?.args?.[0] ?? '');
    const item = (saved.items || []).find(i => String(i.keyNum) === keyNum && i.enabled);
    if (!item) {
      console.warn('[ext:peeks] cli:peek-open — no enabled item with keyNum=' + keyNum);
      return;
    }
    console.log('[ext:peeks] cli:peek-open keyNum=' + keyNum);
    executeItem(item);
  });

  // A peek window was resized and the resize settled (main reports it ~300 ms
  // after the last resize, only to the tile that opened the window). Save the
  // new size under the window's key so the next open of that peek — even after
  // a restart — uses it.
  api.pubsub.subscribe('window:resized', async (msg) => {
    await settingsLoaded;
    const key = msg?.key;
    const width = Number(msg?.width);
    const height = Number(msg?.height);
    if (typeof key !== 'string' || !key.startsWith('peek:')) return;
    if (!(width > 0) || !(height > 0)) return;
    const item = (currentSettings.items || []).find(i => windowKeyFor(i) === key);
    savedSizes = {
      ...savedSizes,
      [key]: item
        ? { width, height, optionsWidth: optionsDim(item.width), optionsHeight: optionsDim(item.height) }
        : { width, height },
    };
    await api.settings.set('sizes', savedSizes);
  });

  // Load settings from datastore
  try {
    savedSizes = await loadSizes();
    currentSettings = await loadSettings();

    // Always declare the wake set on boot — even with zero items — so an empty
    // declaration sets the `lazy_wake_declared` marker and the main-process
    // boot-time backfill won't re-wake this tile every startup. initItems
    // filters to enabled items internally and is safe on an empty list.
    initItems(currentSettings.prefs, currentSettings.items || []);
  } finally {
    // Unblock the wake handlers — even on a load failure they fall back to the
    // in-memory defaults rather than hanging forever.
    resolveSettingsLoaded();
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
