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

// Resolves once init() has loaded the user's real settings from the datastore
// into `currentSettings`. The lazy `cli:slide-open` wake handler awaits this
// before resolving an edge to a slide, so the FIRST press that spawns this tile
// uses the user's saved slides — NOT the bundled defaults (where only 'Up' is
// enabled). Without it, a slide on any other edge (e.g. a 'Down' hotkey)
// silently no-op'd on the first press after startup, then worked on the second
// (settings had loaded by then). See slides-settings-race.spec.ts.
let resolveSettingsLoaded;
const settingsLoaded = new Promise((resolve) => { resolveSettingsLoaded = resolve; });

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

/**
 * Initialize shortcuts for enabled slides.
 *
 * Slides is a LAZY tile: its renderer isn't running at boot, so it cannot
 * call `api.shortcuts.register({global:true})` to own its global hotkeys
 * (that's the chicken-and-egg the wake-shortcut registry solves). Instead
 * we DECLARE the full enabled set to the main process via
 * `declareWakeShortcuts` — main persists it and registers each per-edge
 * accelerator (`<prefix><screenEdge>`, e.g. `Option+Up`) as a global wake
 * hotkey that, when pressed, publishes `cli:slide-open` with
 * `{args:[screenEdge]}`, waking this tile (lazyEvents) and routing to the
 * `cli:slide-open` subscriber below, which opens the matching slide. The
 * dynamic accelerator computation (prefix + edge) STAYS here in the
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
  // replace-all). One entry per enabled slide. The accelerator format and
  // the cli:slide-open arg shape MUST match the `cli:slide-open` subscriber:
  // it normalizes `String(msg.args[0])` (case-insensitive) and matches it
  // against the item's `screenEdge`.
  api.shortcuts.declareWakeShortcuts(
    enabledItems.map(item => ({
      accelerator: `${cmdPrefix}${item.screenEdge}`,
      wakeTopic: 'cli:slide-open',
      wakeArgs: [item.screenEdge],
    }))
  );

  enabledItems.forEach(item => {
    const shortcut = `${cmdPrefix}${item.screenEdge}`;

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
 * Unregister local fallback shortcuts.
 *
 * Only LOCAL fallbacks are registered from this renderer now; the global
 * wake hotkeys are owned by main's wake-shortcut registry (re-declared on
 * the next declareWakeShortcuts in initItems), so we don't unregister them
 * here. We also do NOT tear down open slide windows: window identity is
 * owned by main's `(source, key)` dedup (findWindowByKey, main.ts) and the
 * window registry survives a renderer unload. The in-renderer
 * `slideWindows` Map is only a local cache used while this tile is awake;
 * it is NOT load-bearing for identity across a wake/unload cycle, so
 * dropping it here (and re-seeding it lazily on the next executeItem) is
 * safe — main treats a reopened key as the same window if it's still live,
 * or a fresh window if it was closed.
 */
const uninit = () => {
  console.log('[ext:slides] uninit - unregistering', registeredShortcuts.length, 'local shortcuts');

  registeredShortcuts.forEach(shortcut => {
    api.shortcuts.unregister(shortcut);
  });
  registeredShortcuts = [];

  // Drop the local window cache. Open windows are left alone — main owns
  // their lifecycle and identity; the cache is rebuilt on next executeItem.
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

  // Subscribe to wake topics FIRST — before the async loadSettings() await.
  // slides is a LAZY tile woken by a `cli:slide-open` / `slides:settings-
  // changed` lazyEvent: the load-on-dispatch hook re-delivers that publish
  // once this tile reaches the READY FSM state, which the tile-preload
  // signals (deferred a tick) inside api.initialize() — i.e. BEFORE this
  // init()'s awaits resolve. If we subscribed AFTER `await loadSettings()`,
  // the woken publish would land with no subscriber and be dropped (the
  // cold-boot subscribe-race).
  //
  // Registration must be synchronous (above), but the `cli:slide-open` handler
  // BODY must NOT run against the bundled defaults: the wake publish arrives at
  // READY, which beats the datastore-backed loadSettings() below, so a user
  // slide on a non-default edge would be missed on the first press. The handler
  // therefore awaits `settingsLoaded` before reading `currentSettings`.

  // Listen for settings changes to hot-reload (GLOBAL scope for cross-process)
  api.pubsub.subscribe('slides:settings-changed', () => {
    console.log('[ext:slides] settings changed, reinitializing');
    reinit();
  });

  // CLI verb: open slide on edge. Args: [edge in {Up,Down,Left,Right}].
  // Case-insensitive on input. Also the wake target for the static-default /
  // persisted global hotkeys (see initItems + feature-shortcut-registrar.ts).
  // See cli-router.ts and docs/global-hotkeys-on-wayland.md.
  api.pubsub.subscribe('cli:slide-open', async (msg) => {
    // Wait for the user's real settings before resolving the edge, so the
    // tile-spawning FIRST press doesn't run against the bundled defaults (where
    // only 'Up' is enabled). See settingsLoaded.
    await settingsLoaded;
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

  // Add global window closed handler — prunes the local cache when a slide
  // window is closed externally. Subscribing pre-load is harmless (the Map
  // is empty until executeItem populates it).
  api.pubsub.subscribe('window:closed', (data) => {
    for (const [key, windowId] of slideWindows.entries()) {
      if (data.id === windowId) {
        console.log('[ext:slides] Slide window was closed externally:', key);
        slideWindows.delete(key);
      }
    }
  });

  // Load settings from datastore
  try {
    currentSettings = await loadSettings();

    // Initialize slides
    if (currentSettings.items && currentSettings.items.length > 0) {
      initItems(currentSettings.prefs, currentSettings.items);
    }
  } finally {
    // Unblock the wake handlers — even on a load failure they fall back to the
    // in-memory defaults rather than hanging forever.
    resolveSettingsLoaded();
  }

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
