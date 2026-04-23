/**
 * Cmd — command registry and shortcut wiring.
 *
 * Command palette for quick command access via keyboard shortcut.
 *
 * Implements the PROVIDER pattern for extension-to-extension APIs:
 * - Owns the command registry
 * - Subscribes to cmd:register, cmd:unregister for command management
 *
 * Runs INSIDE the core background renderer (app/background.html →
 * app/index.js imports this module and awaits initCmd()). Previously
 * this ran in a separate `peek://cmd/index.html` resident BrowserWindow
 * created by cmd-glue.ts; that window is gone — see consolidation plan
 * where cmd/hud/page resident logic moved into the core renderer.
 *
 * The core renderer has a trustedBuiltin capability grant, so every
 * `tile:*` IPC call bypasses capability enforcement same as before.
 *
 * The visible command palette UI (`app/cmd/panel.html`) is still a
 * separate BrowserWindow opened on-demand via api.window.open(...) when
 * the shortcut fires — unchanged.
 */

import { id, labels, schemas, storageKeys, defaults } from './config.js';
import { log } from 'peek://app/log.js';
import { generateCommandsFromNoun, validateNounDef } from './noun-registry.js';

const api = window.app;

log('ext:cmd', 'background', labels.name);

// ===== Command Registry (PROVIDER PATTERN) =====
// This extension owns the command registry. Other extensions register
// commands by publishing to cmd:register, and we store them here.
const commandRegistry = new Map();

// Noun registry — stores noun metadata for regenerating commands
const nounRegistry = new Map();

// Track commands that were freshly registered by live extensions (not from cache)
const liveRegisteredCommands = new Set();

// Track registered shortcut for cleanup
let registeredShortcut = null;

// Panel window address
const panelAddress = 'peek://cmd/panel.html';

// In-memory settings cache
let currentSettings = {
  prefs: defaults.prefs
};

// cmd's prefs row lives in the `feature_settings` table keyed `cmd_prefs`
// (legacy `${tileId}_${key}` format that `api.settings.set` uses). The
// cmd panel window reads via `api.settings.get('prefs')` from its own
// tile namespace (tileId='cmd') — so we must keep writing to the `cmd`
// namespace even though this code now runs inside the core renderer
// (tileId='core'). `api.settings.set` would route to `core_prefs`;
// persist directly to the known row instead.
const CMD_PREFS_ROW_ID = 'cmd_prefs';

const loadSettings = async () => {
  try {
    const result = await api.datastore.getRow('feature_settings', CMD_PREFS_ROW_ID);
    if (result?.success && result.data?.value) {
      const parsed = JSON.parse(result.data.value);
      return { prefs: parsed || defaults.prefs };
    }
  } catch (err) {
    log.error('ext:cmd', 'Failed to load settings:', err);
  }
  return { prefs: defaults.prefs };
};

const saveSettings = async (settings) => {
  try {
    await api.datastore.setRow('feature_settings', CMD_PREFS_ROW_ID, {
      featureId: 'cmd',
      key: 'prefs',
      value: JSON.stringify(settings.prefs),
      updatedAt: Date.now(),
    });
  } catch (err) {
    log.error('ext:cmd', 'Failed to save settings:', err);
  }
};

// ===== Command Registry Cache =====
// Cache command metadata to avoid re-registration overhead when versions match

/**
 * Load command cache from datastore
 * @returns {Promise<{appVersion: string, extensionVersions: Object, commands: Array} | null>}
 */
const loadCommandCache = async () => {
  try {
    const result = await api.datastore.getRow('feature_settings', `cmd:command_cache`);
    if (result.success && result.data && result.data.value) {
      const cache = JSON.parse(result.data.value);
      log('ext:cmd', 'Loaded command cache:', cache.commands?.length, 'commands');
      return cache;
    }
  } catch (err) {
    log.error('ext:cmd', 'Failed to load command cache:', err);
  }
  return null;
};

/**
 * Save command cache to datastore
 * @param {string} appVersion - Current app version
 * @param {Object} extensionVersions - Map of extension ID to version
 */
const saveCommandCache = async (appVersion, extensionVersions) => {
  try {
    const commands = Array.from(commandRegistry.values()).map(cmd => {
      const entry = {
        name: cmd.name,
        description: cmd.description,
        source: cmd.source,
        scope: cmd.scope || 'global',
        modes: cmd.modes || [],
        hasCanExecute: cmd.hasCanExecute || false,
        accepts: cmd.accepts,
        produces: cmd.produces,
        params: cmd.params || []
      };
      // Preserve noun routing metadata in cache
      if (cmd._nounName) entry._nounName = cmd._nounName;
      if (cmd._nounCapability) entry._nounCapability = cmd._nounCapability;
      return entry;
    });

    const cache = {
      appVersion,
      extensionVersions,
      commands,
      nouns: Array.from(nounRegistry.values()),
      cachedAt: Date.now()
    };

    await api.datastore.setRow('feature_settings', 'cmd:command_cache', {
      featureId: 'cmd',
      key: 'command_cache',
      value: JSON.stringify(cache),
      updatedAt: Date.now()
    });

    log('ext:cmd', 'Saved command cache:', commands.length, 'commands');
  } catch (err) {
    log.error('ext:cmd', 'Failed to save command cache:', err);
  }
};

/**
 * Get current app and extension versions.
 *
 * Under the v2 resident-renderer flow, `api.app` / `api.extensions`
 * (v1 preload) are no longer present. Use `api.features.list()` — its
 * `{ entries }` response carries per-feature manifest versions. The app
 * version is resolved via the injected build-number constant so we
 * don't need a separate app-info IPC.
 *
 * @returns {Promise<{appVersion: string, extensionVersions: Object}>}
 */
const getCurrentVersions = async () => {
  // Prefer a compile-time app version if present; fall back to 0.0.0.
  // Neither tile-preload nor the app exposes an un-gated `getInfo` yet;
  // the cache validation still bites on extension version drift which
  // is the common case.
  const appVersion = (typeof window !== 'undefined' && window.__APP_VERSION__) || '0.0.0';

  const extensionVersions = {};
  try {
    const listResult = await api.features.list();
    const entries = listResult?.entries || listResult?.data || [];
    for (const ext of entries) {
      if (ext.manifest?.version) {
        extensionVersions[ext.id] = ext.manifest.version;
      }
    }
  } catch (err) {
    log.error('ext:cmd', 'features.list failed:', err);
  }

  return { appVersion, extensionVersions };
};

/**
 * Check if cache is valid by comparing versions
 * @param {Object} cache - Cached data with versions
 * @param {string} appVersion - Current app version
 * @param {Object} extensionVersions - Current extension versions
 * @returns {boolean}
 */
const isCacheValid = (cache, appVersion, extensionVersions) => {
  if (!cache) return false;
  if (cache.appVersion !== appVersion) {
    log('ext:cmd', 'Cache invalid: app version mismatch', cache.appVersion, '!=', appVersion);
    return false;
  }

  // Check if all cached extension versions match
  const cachedExtIds = Object.keys(cache.extensionVersions || {});
  const currentExtIds = Object.keys(extensionVersions);

  // Different set of extensions
  if (cachedExtIds.length !== currentExtIds.length) {
    log('ext:cmd', 'Cache invalid: extension count mismatch');
    return false;
  }

  for (const extId of currentExtIds) {
    if (cache.extensionVersions[extId] !== extensionVersions[extId]) {
      log('ext:cmd', 'Cache invalid: extension version mismatch for', extId);
      return false;
    }
  }

  return true;
};

/**
 * Initialize the command registry subscriptions (PROVIDER PATTERN)
 *
 * This sets up the cmd extension as the owner of the command API.
 * Other extensions (consumers) communicate via pubsub:
 * - cmd:register - Consumer registers a command
 * - cmd:unregister - Consumer unregisters a command
 * - cmd:query-commands - Panel queries for all registered commands
 */
const initCommandRegistry = () => {
  // Handle batch command registrations (from preload batching)
  //
  // Merge-preserve pattern: a later publish with partial metadata (e.g. the
  // minimal {name, source} publish from tile-ipc.ts's tile:command:register)
  // must NOT erase rich fields that an earlier publish carried (accepts,
  // produces, description, params). Previously we overwrote unconditionally,
  // which caused metadata from the preload's cmd:register publish to be
  // erased when a tile also sent the minimal tile:command:register path.
  api.pubsub.subscribe('cmd:register-batch', (msg) => {
    if (!msg.commands || !Array.isArray(msg.commands)) return;

    log('ext:cmd', 'cmd:register-batch received:', msg.commands.length, 'commands');

    for (const cmd of msg.commands) {
      const existing = commandRegistry.get(cmd.name) || {};
      const entry = {
        name: cmd.name,
        description: cmd.description || existing.description || '',
        source: cmd.source || existing.source,
        scope: cmd.scope || existing.scope || 'global',
        modes: cmd.modes || existing.modes || [],
        hasCanExecute: cmd.hasCanExecute || existing.hasCanExecute || false,
        // Connector metadata for chaining — preserve richer existing entry
        // when the incoming publish lacks it (minimal publishes carry empty
        // arrays; we want the previously-registered full metadata to win).
        accepts: (cmd.accepts && cmd.accepts.length > 0) ? cmd.accepts : (existing.accepts || []),
        produces: (cmd.produces && cmd.produces.length > 0) ? cmd.produces : (existing.produces || []),
        params: (cmd.params && cmd.params.length > 0) ? cmd.params : (existing.params || []),
      };
      if (cmd._nounName || existing._nounName) entry._nounName = cmd._nounName || existing._nounName;
      if (cmd._nounCapability || existing._nounCapability) entry._nounCapability = cmd._nounCapability || existing._nounCapability;
      commandRegistry.set(cmd.name, entry);
      liveRegisteredCommands.add(cmd.name);
    }
  }, api.scopes.GLOBAL);

  // Handle individual command registrations from extensions
  // Merge-preserve pattern: see cmd:register-batch above for rationale.
  api.pubsub.subscribe('cmd:register', (msg) => {
    if (!window.__cmdRegisterLog) window.__cmdRegisterLog = [];
    window.__cmdRegisterLog.push({ name: msg.name, source: msg.source });
    log('ext:cmd', 'cmd:register received:', msg.name);
    const existing = commandRegistry.get(msg.name) || {};
    const entry = {
      name: msg.name,
      description: msg.description || existing.description || '',
      source: msg.source || existing.source,
      scope: msg.scope || existing.scope || 'global',
      modes: msg.modes || existing.modes || [],
      hasCanExecute: msg.hasCanExecute || existing.hasCanExecute || false,
      accepts: (msg.accepts && msg.accepts.length > 0) ? msg.accepts : (existing.accepts || []),
      produces: (msg.produces && msg.produces.length > 0) ? msg.produces : (existing.produces || []),
      params: (msg.params && msg.params.length > 0) ? msg.params : (existing.params || []),
    };
    if (msg._nounName || existing._nounName) entry._nounName = msg._nounName || existing._nounName;
    if (msg._nounCapability || existing._nounCapability) entry._nounCapability = msg._nounCapability || existing._nounCapability;
    commandRegistry.set(msg.name, entry);
    liveRegisteredCommands.add(msg.name);
  }, api.scopes.GLOBAL);

  // Handle command unregistrations
  api.pubsub.subscribe('cmd:unregister', (msg) => {
    log('ext:cmd', 'cmd:unregister received:', msg.name);
    commandRegistry.delete(msg.name);
  }, api.scopes.GLOBAL);

  // ===== Noun Registration Handlers =====

  // Handle batch noun registrations from extensions
  api.pubsub.subscribe('noun:register-batch', (msg) => {
    if (!msg.nouns || !Array.isArray(msg.nouns)) return;

    log('ext:cmd', 'noun:register-batch received:', msg.nouns.length, 'nouns');

    const generatedCommands = [];

    for (const nounDef of msg.nouns) {
      const validation = validateNounDef(nounDef);
      if (!validation.valid) {
        log.error('ext:cmd', 'Invalid noun definition:', nounDef.name, validation.error);
        continue;
      }

      // Store noun metadata
      nounRegistry.set(nounDef.name, nounDef);

      // Generate commands from noun definition
      const commands = generateCommandsFromNoun(nounDef);
      for (const cmd of commands) {
        commandRegistry.set(cmd.name, cmd);
        liveRegisteredCommands.add(cmd.name);
        generatedCommands.push(cmd);
      }

      log('ext:cmd', 'Noun registered:', nounDef.name, '→', commands.map(c => c.name).join(', '));
    }

    // Broadcast generated commands to panel via existing cmd:register-batch flow
    if (generatedCommands.length > 0) {
      api.pubsub.publish('cmd:register-batch', { commands: generatedCommands }, api.scopes.GLOBAL);
    }
  }, api.scopes.GLOBAL);

  // Handle noun unregistrations
  api.pubsub.subscribe('noun:unregister', (msg) => {
    if (!msg.name) return;

    const nounDef = nounRegistry.get(msg.name);
    if (!nounDef) return;

    log('ext:cmd', 'Noun unregistering:', msg.name);

    // Regenerate command names from noun metadata to know what to remove
    const commands = generateCommandsFromNoun(nounDef);
    for (const cmd of commands) {
      commandRegistry.delete(cmd.name);
      liveRegisteredCommands.delete(cmd.name);
      api.pubsub.publish('cmd:unregister', { name: cmd.name }, api.scopes.GLOBAL);
    }

    nounRegistry.delete(msg.name);
  }, api.scopes.GLOBAL);

  // Handle command list queries from the panel
  api.pubsub.subscribe('cmd:query-commands', () => {
    const commands = Array.from(commandRegistry.values());
    log('ext:cmd', 'cmd:query-commands received');
    api.pubsub.publish('cmd:query-commands-response', { commands }, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  log('ext:cmd', 'Command registry initialized');
};

/**
 * Open the command panel window
 */
const openPanelWindow = (prefs) => {
  // Initial height just for the command bar (~50px visible)
  // Window will resize when results appear
  const initialHeight = 60;
  const maxHeight = prefs.height || 400;
  const width = prefs.width || 600;

  const params = {
    // IZUI role
    role: 'palette',

    debug: log.debug,
    key: panelAddress,
    height: initialHeight,
    maxHeight,
    width,

    // Keep resident in the background
    keepLive: true,

    // Completely remove window frame and decorations
    frame: false,
    transparent: true,

    // Make sure the window stays on top
    alwaysOnTop: true,

    // Center the window (works correctly with small initial height)
    center: true,

    // Set a reasonable minimum size
    minWidth: 400,
    minHeight: 50,

    // Make sure shadows are shown for visual appearance
    hasShadow: true,

    // Additional window behavior options
    skipTaskbar: true,
    resizable: false,
    fullscreenable: false,

    // Modal behavior
    modal: true,
    type: 'panel',

    openDevTools: log.debug,
    detachedDevTools: true,
  };

  api.window.open(panelAddress, params)
    .then(result => {
      log('ext:cmd', 'Command window opened:', result);
    })
    .catch(error => {
      log.error('ext:cmd', 'Failed to open command window:', error);
    });
};

/**
 * Register shortcuts: global (Option+Space) and local (Cmd+K)
 */
const LOCAL_SHORTCUT = 'CommandOrControl+K';
const URL_MODE_SHORTCUT = 'CommandOrControl+L';

const initShortcut = (prefs) => {
  if (registeredShortcut) {
    api.shortcuts.unregister(registeredShortcut, { global: true });
    api.shortcuts.unregister(registeredShortcut);
  }
  api.shortcuts.unregister(LOCAL_SHORTCUT);
  api.shortcuts.unregister(URL_MODE_SHORTCUT);

  registeredShortcut = prefs.shortcutKey;
  api.shortcuts.register(prefs.shortcutKey, () => {
    openPanelWindow(prefs);
  }, { global: true });

  // Also register as local so it works on Linux Wayland where global shortcuts may fail
  api.shortcuts.register(prefs.shortcutKey, () => {
    openPanelWindow(prefs);
  });

  // Local shortcut (Cmd+K) — works when a Peek window is focused
  api.shortcuts.register(LOCAL_SHORTCUT, () => {
    openPanelWindow(prefs);
  });

  // URL mode shortcut (Cmd+L) — opens panel in URL-only navigation mode
  // Page host windows have their own Cmd+L handler for the floating navbar.
  // main.ts skips local shortcut dispatch for Cmd+L on page host windows,
  // so this only fires from non-page windows.
  api.shortcuts.register(URL_MODE_SHORTCUT, () => {
    api.pubsub.publish('cmd:url-mode', {}, api.scopes.GLOBAL);
    openPanelWindow(prefs);
  });

  log('ext:cmd', 'Registered shortcuts:', prefs.shortcutKey, '(global),', LOCAL_SHORTCUT, '(local),', URL_MODE_SHORTCUT, '(url-mode)');
};

/**
 * Unregister shortcut and clean up
 */
const uninit = () => {
  log('ext:cmd', 'uninit');

  if (registeredShortcut) {
    api.shortcuts.unregister(registeredShortcut, { global: true });
    api.shortcuts.unregister(registeredShortcut);
    registeredShortcut = null;
  }
  api.shortcuts.unregister(LOCAL_SHORTCUT);
  api.shortcuts.unregister(URL_MODE_SHORTCUT);

  // Note: We don't clear the command registry here because other extensions
  // may still be running. The registry will be rebuilt on next init.
};

/**
 * Reinitialize (called when settings change)
 */
const reinit = async () => {
  log('ext:cmd', 'reinit');

  // Unregister old shortcuts
  if (registeredShortcut) {
    api.shortcuts.unregister(registeredShortcut, { global: true });
    registeredShortcut = null;
  }
  api.shortcuts.unregister(LOCAL_SHORTCUT);
  api.shortcuts.unregister(URL_MODE_SHORTCUT);

  // Load new settings and re-register
  currentSettings = await loadSettings();
  initShortcut(currentSettings.prefs);
};

/**
 * Initialize the extension
 */
const init = async () => {
  log('ext:cmd', 'init');

  // 1. Initialize command registry subscriptions FIRST
  // This ensures we're ready to receive registrations from other extensions
  initCommandRegistry();

  // 1b. Load cached commands if versions match
  // This pre-populates the registry so panel can open immediately
  // Note: full version validation (isCacheValid) runs at ext:all-loaded when all
  // extension versions are available. Here we do a quick app-version check to
  // reject clearly stale caches without blocking startup.
  const cache = await loadCommandCache();
  const currentAppVersion = (typeof window !== 'undefined' && window.__APP_VERSION__) || '0.0.0';
  const cacheAppVersionMatch = cache && cache.appVersion === currentAppVersion;
  if (cache && cache.commands && cacheAppVersionMatch) {
    // Pre-populate from cache (will be updated by fresh registrations)
    for (const cmd of cache.commands) {
      const entry = {
        name: cmd.name,
        description: cmd.description || '',
        source: cmd.source,
        scope: cmd.scope || 'global',
        modes: cmd.modes || [],
        hasCanExecute: cmd.hasCanExecute || false,
        accepts: cmd.accepts || [],
        produces: cmd.produces || [],
        params: cmd.params || []
      };
      // Restore noun routing metadata from cache
      if (cmd._nounName) entry._nounName = cmd._nounName;
      if (cmd._nounCapability) entry._nounCapability = cmd._nounCapability;
      commandRegistry.set(cmd.name, entry);
    }

    // Restore cached nouns and regenerate their commands
    if (cache.nouns) {
      for (const nounDef of cache.nouns) {
        nounRegistry.set(nounDef.name, nounDef);
        const nounCmds = generateCommandsFromNoun(nounDef);
        for (const cmd of nounCmds) {
          commandRegistry.set(cmd.name, cmd);
        }
      }
      log('ext:cmd', 'Restored', cache.nouns.length, 'nouns from cache');
    }

    log('ext:cmd', 'Pre-populated registry from cache:', commandRegistry.size, 'commands');
  } else if (cache) {
    log('ext:cmd', 'Cache invalid, discarding stale commands');
  }

  // 2. Load settings from datastore
  currentSettings = await loadSettings();

  // 3. Register the global shortcut
  initShortcut(currentSettings.prefs);

  // 3b. Register built-in commands
  api.commands.register({
    name: 'devtools',
    description: 'Open devtools for last active content window',
    execute: async () => {
      const result = await api.window.devtools();
      if (result.success) {
        log('ext:cmd', 'Opened devtools for:', result.url);
      } else {
        log.error('ext:cmd', 'Failed to open devtools:', result.error);
      }
    }
  });

  // 4. Listen for settings changes to hot-reload
  api.pubsub.subscribe('cmd:settings-changed', () => {
    log('ext:cmd', 'settings changed, reinitializing');
    reinit();
  }, api.scopes.GLOBAL);

  // 4b. Save command cache after all extensions have loaded
  api.pubsub.subscribe('ext:all-loaded', async () => {
    log('ext:cmd', 'ext:all-loaded - saving command cache');
    // Small delay to ensure all commands are registered
    setTimeout(async () => {
      // Purge stale cached commands that were NOT re-registered by live extensions
      const stale = [];
      for (const name of commandRegistry.keys()) {
        if (!liveRegisteredCommands.has(name)) {
          stale.push(name);
        }
      }
      for (const name of stale) {
        log('ext:cmd', 'Purging stale cached command:', name);
        commandRegistry.delete(name);
        // Notify panel so it removes the command from its local registry
        api.pubsub.publish('cmd:unregister', { name }, api.scopes.GLOBAL);
      }

      const { appVersion, extensionVersions } = await getCurrentVersions();
      await saveCommandCache(appVersion, extensionVersions);
    }, 100);
  }, api.scopes.GLOBAL);

  // Listen for settings updates from Settings UI
  api.pubsub.subscribe('cmd:settings-update', async (msg) => {
    log('ext:cmd', 'settings-update received:', msg);

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
      await reinit();

      api.pubsub.publish('cmd:settings-changed', currentSettings, api.scopes.GLOBAL);
    } catch (err) {
      log.error('ext:cmd', 'settings-update error:', err);
    }
  }, api.scopes.GLOBAL);

};

export { init as initCmd, uninit as uninitCmd };
