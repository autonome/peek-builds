import appConfig from './config.js';
import { createDatastoreStore } from "./utils.js";
import windowManager from "./windows.js";
import api from './api.js';
import fc from './features.js';
import migrations from './migrations/index.js';
import { log } from './log.js';
import { initCmd } from './cmd/background.js';
import { initPage } from './page/background.js';
// HUD disabled 2026-04-23 — unused feature, failing tests post pubsub FSM.
// Re-enable by restoring the import + initHud() call below and un-skipping
// hud.spec.ts + the HUD test in groups-context.spec.ts.
// import { initHud } from './hud/background.js';

const { id, labels, schemas, storageKeys, defaults } = appConfig;

log('core', id, labels.name);

// Store is created asynchronously in init()
let store = null;

// Datastore is now initialized in main process and accessible via api.datastore
log('core', 'datastore available via api.datastore');

// Import and expose history tracking helpers
import historyTracking from './datastore/history.js';
window.datastoreHistory = historyTracking;

// maps app id to BrowserWindow id (background)
const windows = new Map();

const settingsAddress = 'peek://app/settings/settings.html';
const topicCorePrefs = 'topic:core:prefs';
const topicFeatureToggle = 'core:feature:toggle';

// Builtin feature tiles loaded by the main-process tile launcher.
// cmd is first so it's ready to receive command registrations from other tiles.
const builtinFeatureTiles = ['cmd', 'editor', 'groups', 'peeks', 'slides'];

let _settingsWin = null;

const openSettingsWindow = async (prefs, section) => {
  log('core', 'openSettingsWindow()', section ? `section=${section}` : '');

  // Fixed size for settings window - content doesn't need to scale with screen
  const width = 900;
  const height = 650;

  // Include hash for section navigation (persisted across session restore)
  const url = section ? `${settingsAddress}#${section}` : settingsAddress;

  const params = {
    debug: log.debug,
    key: settingsAddress,
    transparent: true,
    height,
    width
  };

  log('core', 'Opening settings window with params:', params);

  try {
    // Use the window creation API from windows.js
    const windowController = await windowManager.createWindow(url, params);

    log('core', 'Settings window opened successfully with controller:', windowController);
    _settingsWin = windowController;

    // Focus the window to bring it to front
    await windowController.focus();

    // If navigating to a specific section on an already-open window,
    // publish navigate event (createWindow may have just focused existing window)
    if (section) {
      setTimeout(() => {
        api.publish('settings:navigate', { section });
      }, 100);
    }
  } catch (error) {
    log.error('core', 'Failed to open settings window:', error);
  }
};

let _registeredSettingsShortcut = null;
const initSettingsShortcut = (prefs) => {
  const newKey = prefs.shortcutKey;
  // Unregister old shortcut if it changed
  if (_registeredSettingsShortcut && _registeredSettingsShortcut !== newKey) {
    log('core', 'unregistering old settings shortcut:', _registeredSettingsShortcut);
    api.shortcuts.unregister(_registeredSettingsShortcut);
  }
  log('core', 'registering settings shortcut:', newKey);
  api.shortcuts.register(newKey, () => {
    log('core', 'settings shortcut executed');
    openSettingsWindow(prefs);
  });
  _registeredSettingsShortcut = newKey;
};

const initFeature = f => {
  if (!f.enabled) {
    return;
  }

  // Skip tile-backed features (they're loaded by the main-process tile launcher).
  const tileId = f.name.toLowerCase();
  if (builtinFeatureTiles.includes(tileId)) {
    log('core', 'skipping tile-backed feature (loaded by main process):', f.name);
    return;
  }

  // Check if feature exists in the features collection
  if (!fc[f.id]) {
    log('core', 'feature not found in collection:', f.name, f.id);
    return;
  }

  log('core', 'initializing feature ', f);

  fc[f.id].init();
};

const prefs = () => store ? store.get(storageKeys.PREFS) : defaults.prefs;
const features = () => store ? store.get(storageKeys.ITEMS) : defaults.items;

// ==================== Theme Commands ====================

/**
 * Set color scheme (light/dark/system)
 */
async function setColorScheme(scheme) {
  const result = await api.theme.setColorScheme(scheme);
  if (result.success) {
    log('core', `Color scheme set to: ${scheme}`);
  } else {
    log.error('core', 'Failed to set color scheme:', result.error);
  }
}

/**
 * Cycle to the next available theme
 */
async function cycleTheme() {
  const [currentState, themeList] = await Promise.all([
    api.theme.get(),
    api.theme.list()
  ]);

  if (!themeList.success || !themeList.data || themeList.data.length === 0) {
    log.error('core', 'No themes available');
    return;
  }

  const themes = themeList.data;
  const currentId = currentState.data?.themeId || themes[0].id;

  // Find current theme index and get next one
  const currentIndex = themes.findIndex(t => t.id === currentId);
  const nextIndex = (currentIndex + 1) % themes.length;
  const nextTheme = themes[nextIndex];

  const result = await api.theme.setTheme(nextTheme.id);
  if (result.success) {
    log('core', `Theme changed to: ${nextTheme.name} (${nextTheme.id})`);
  } else {
    log.error('core', 'Failed to set theme:', result.error);
  }
}

// Register the core cmd-palette commands the app ships with.
const registerCoreCommands = () => {
  // Settings command
  api.commands.register({
    name: 'settings',
    description: 'Open settings',
    execute: async () => {
      const p = prefs();
      await openSettingsWindow(p);
    }
  });

  // Reload feature command (uses main process IPC)
  api.commands.register({
    name: 'feature reload',
    description: 'Reload a feature by id',
    execute: async (ctx) => {
      const featureId = ctx.search?.trim();
      if (!featureId) {
        log('core', 'feature reload: no feature id provided');
        return;
      }

      log('core', `Reloading feature: ${featureId}`);
      const result = await api.features.devReload(featureId.toLowerCase());
      if (result && !result.error) {
        log('core', `Feature reloaded: ${featureId}`);
      } else {
        log.error('core', `Failed to reload feature: ${result?.error || 'unknown error'}`);
      }
    }
  });

  // List features command (uses main process IPC)
  api.commands.register({
    name: 'features',
    description: 'List installed features',
    execute: async () => {
      const listResult = await api.features.list();
      const entries = listResult?.entries || [];
      if (entries.length > 0) {
        log('core', 'Installed features:');
        entries.forEach(entry => {
          const version = entry.source?.version || '?';
          log('core', `  - ${entry.name || entry.id} (${entry.id}) v${version}`);
        });
      } else {
        log('core', 'No features installed');
      }

      // Open settings to Features section
      const p = prefs();
      await openSettingsWindow(p);
    }
  });

  // ---- Settings Command (parameterized with pane selection) ----

  const SETTINGS_PANES = [
    { value: 'core', title: 'Core', subtitle: 'General application settings' },
    { value: 'features', title: 'Features', subtitle: 'Manage Peek features' },
    { value: 'privacy', title: 'Extensions', subtitle: 'Browser extensions (ad blocker, etc.)' },
    { value: 'dark-mode', title: 'Dark Mode', subtitle: 'Dark mode settings' },
    { value: 'sync', title: 'Sync', subtitle: 'Sync configuration and status' },
    { value: 'profiles', title: 'Profiles', subtitle: 'Manage user profiles' },
    { value: 'themes', title: 'Themes', subtitle: 'Manage color themes' },
    { value: 'datastore', title: 'Datastore', subtitle: 'Browse and manage stored data' },
    { value: 'diagnostics', title: 'Diagnostics', subtitle: 'System diagnostics and debug info' },
    { value: 'peeks', title: 'Peeks', subtitle: 'Peeks feature settings' },
    { value: 'slides', title: 'Slides', subtitle: 'Slides feature settings' },
    { value: 'groups', title: 'Groups', subtitle: 'Groups feature settings' },
  ];

  api.commands.register({
    name: 'settings',
    description: 'Open settings',
    params: [{ type: 'enum', options: SETTINGS_PANES }],
    execute: async (ctx) => {
      const section = (ctx.params && ctx.params[0]) || (ctx.search || '').trim().toLowerCase();
      const p = prefs();
      if (section && SETTINGS_PANES.some(pane => pane.value === section)) {
        await openSettingsWindow(p, section);
      } else {
        await openSettingsWindow(p);
      }
    }
  });

  api.commands.register({
    name: 'datastore',
    description: 'Open Datastore viewer',
    execute: async () => {
      await api.window.open('peek://app/datastore/viewer.html', {
        role: 'utility',
        width: 900,
        height: 600,
        key: 'datastore-viewer'
      });
    }
  });

  api.commands.register({
    name: 'diagnostic',
    description: 'Open Diagnostic tool',
    execute: async () => {
      await api.window.open('peek://app/diagnostic.html', {
        role: 'utility',
        width: 900,
        height: 700,
        key: 'diagnostic-tool'
      });
    }
  });

  // ---- Theme Commands ----

  api.commands.register({
    name: 'theme light',
    description: 'Switch to light mode',
    execute: () => setColorScheme('light')
  });

  api.commands.register({
    name: 'theme dark',
    description: 'Switch to dark mode',
    execute: () => setColorScheme('dark')
  });

  api.commands.register({
    name: 'theme system',
    description: 'Follow system color scheme',
    execute: () => setColorScheme('system')
  });

  api.commands.register({
    name: 'theme next',
    description: 'Switch to next theme',
    execute: cycleTheme
  });

  // Theme switcher — list all installed themes, or switch directly by name
  api.commands.register({
    name: 'theme',
    description: 'Switch theme — type a theme name or pick from list',
    execute: async (ctx) => {
      const search = (ctx.search || '').trim().toLowerCase();

      // Get all available themes
      const listResult = await api.theme.list();
      if (!listResult.themes || listResult.themes.length === 0) {
        return { output: 'No themes available', mimeType: 'text/plain' };
      }

      const themes = listResult.themes;
      const currentState = await api.theme.get();
      const currentId = currentState.themeId;

      // If the user typed a search term, try to match a theme name directly
      if (search) {
        const exactMatch = themes.find(t =>
          t.id.toLowerCase() === search || t.name.toLowerCase() === search
        );
        if (exactMatch) {
          const result = await api.theme.setTheme(exactMatch.id);
          if (result.success) {
            return { output: `Theme: ${exactMatch.name}`, mimeType: 'text/plain' };
          } else {
            return { output: `Failed: ${result.error}`, mimeType: 'text/plain' };
          }
        }

        // Partial match — filter and list
        const matches = themes.filter(t =>
          t.id.toLowerCase().includes(search) || t.name.toLowerCase().includes(search)
        );
        if (matches.length === 1) {
          const result = await api.theme.setTheme(matches[0].id);
          if (result.success) {
            return { output: `Theme: ${matches[0].name}`, mimeType: 'text/plain' };
          }
        }
        if (matches.length === 0) {
          return { output: `No theme matching "${search}"`, mimeType: 'text/plain' };
        }
      }

      // No search or ambiguous — list all themes with current indicator
      const lines = themes.map(t => {
        const marker = t.id === currentId ? ' (active)' : '';
        return `${t.name}${marker} — ${t.description || t.id}`;
      });

      return {
        output: 'Installed themes:\n' + lines.join('\n'),
        mimeType: 'text/plain'
      };
    }
  });

  // ---- Per-Window Theme Commands ----

  api.commands.register({
    name: 'theme light here',
    description: 'Light mode for this window only',
    execute: async () => {
      const result = await api.theme.setWindowColorScheme('light');
      if (!result.success) {
        return { output: `Failed: ${result.error}`, mimeType: 'text/plain' };
      }
    }
  });

  api.commands.register({
    name: 'theme dark here',
    description: 'Dark mode for this window only',
    execute: async () => {
      const result = await api.theme.setWindowColorScheme('dark');
      if (!result.success) {
        return { output: `Failed: ${result.error}`, mimeType: 'text/plain' };
      }
    }
  });

  api.commands.register({
    name: 'theme reset here',
    description: 'Reset to global theme for this window',
    execute: async () => {
      const result = await api.theme.setWindowColorScheme('global');
      if (!result.success) {
        return { output: `Failed: ${result.error}`, mimeType: 'text/plain' };
      }
    }
  });

  api.commands.register({
    name: 'theme light here persist',
    description: 'Light mode for this URL (saved)',
    execute: async () => {
      const result = await api.theme.setWindowColorScheme('light');
      if (!result.success) {
        return { output: `Failed: ${result.error}`, mimeType: 'text/plain' };
      }
      // Save to item metadata
      const url = window.location.href;
      if (url && !url.startsWith('peek://')) {
        const items = await api.datastore.queryItems({ type: 'url', search: url, limit: 5 });
        const item = items.data?.find(a => a.content === url);
        if (item) {
          const metadata = JSON.parse(item.metadata || '{}');
          metadata.colorScheme = 'light';
          await api.datastore.updateItem(item.id, { metadata: JSON.stringify(metadata) });
          return { output: 'Light mode saved for this URL', mimeType: 'text/plain' };
        }
      }
      return { output: 'Light mode set (URL not tracked)', mimeType: 'text/plain' };
    }
  });

  api.commands.register({
    name: 'theme dark here persist',
    description: 'Dark mode for this URL (saved)',
    execute: async () => {
      const result = await api.theme.setWindowColorScheme('dark');
      if (!result.success) {
        return { output: `Failed: ${result.error}`, mimeType: 'text/plain' };
      }
      // Save to item metadata
      const url = window.location.href;
      if (url && !url.startsWith('peek://')) {
        const items = await api.datastore.queryItems({ type: 'url', search: url, limit: 5 });
        const item = items.data?.find(a => a.content === url);
        if (item) {
          const metadata = JSON.parse(item.metadata || '{}');
          metadata.colorScheme = 'dark';
          await api.datastore.updateItem(item.id, { metadata: JSON.stringify(metadata) });
          return { output: 'Dark mode saved for this URL', mimeType: 'text/plain' };
        }
      }
      return { output: 'Dark mode set (URL not tracked)', mimeType: 'text/plain' };
    }
  });

  // ---- Feature Commands ----

  api.commands.register({
    name: 'reload feature',
    description: 'Reload an installed feature by ID',
    execute: async (ctx) => {
      // Get features list to show which can be reloaded
      const result = await api.features.list();
      const entries = result?.entries || [];
      // Filter out builtins — only externally-installed features can usefully be reloaded.
      const external = entries.filter(e => e.source?.type !== 'builtin');
      if (external.length === 0) {
        return { output: 'No external features installed to reload', mimeType: 'text/plain' };
      }

      // If input provided, try to reload that feature
      const input = ctx?.input?.trim();
      if (input) {
        const feature = external.find(e => e.id === input || e.id.includes(input));
        if (feature) {
          const reloadResult = await api.features.devReload(feature.id);
          if (reloadResult && !reloadResult.error) {
            return { output: `Reloaded feature: ${feature.id}`, mimeType: 'text/plain' };
          }
          return { output: `Failed to reload: ${reloadResult?.error || 'unknown error'}`, mimeType: 'text/plain' };
        }
        return { output: `Feature not found: ${input}`, mimeType: 'text/plain' };
      }

      // No input - show available features
      const list = external.map(e => e.id).join('\n');
      return { output: `External features (type ID to reload):\n${list}`, mimeType: 'text/plain' };
    }
  });

  // ---- Session Commands ----

  api.commands.register({
    name: 'save session',
    description: 'Save current session snapshot',
    execute: async () => {
      const result = await api.session.save();
      if (result && result.success) {
        return { output: result.message, mimeType: 'text/plain' };
      }
      return { output: `Failed to save session: ${result?.error || 'unknown error'}`, mimeType: 'text/plain' };
    }
  });

  api.commands.register({
    name: 'restore previous session',
    description: 'Restore windows from the last saved session',
    execute: async () => {
      const result = await api.session.restoreInteractive();
      if (result && result.success) {
        return { output: result.message, mimeType: 'text/plain' };
      }
      return { output: `Failed to restore session: ${result?.error || 'unknown error'}`, mimeType: 'text/plain' };
    }
  });

  // ---- App Control Commands ----

  api.commands.register({
    name: 'quit',
    description: 'Quit the application',
    execute: () => api.quit()
  });

  api.commands.register({
    name: 'restart',
    description: 'Restart the application',
    execute: () => api.restart()
  });

  // ---- Web Navigation Commands ----

  api.commands.register({
    name: 'back',
    description: 'Go back in web page history',
    execute: () => api.nav.back()
  });

  api.commands.register({
    name: 'forward',
    description: 'Go forward in web page history',
    execute: () => api.nav.forward()
  });

  api.commands.register({
    name: 'reload',
    description: 'Reload the current web page',
    execute: () => api.nav.reload()
  });

  api.commands.register({
    name: 'copy url',
    description: 'Copy the current web page URL to clipboard',
    execute: async () => {
      const result = await api.nav.state();
      if (result && result.success && result.data && result.data.url) {
        await navigator.clipboard.writeText(result.data.url);
      }
    }
  });


  // ---- Chrome Extension Entry Point Commands ----
  // Register commands for each openable entry point of loaded chrome extensions
  // (async, fire-and-forget since registerCoreCommands is not async)
  api.chromeExtensions.getUiEntries().then(uiResult => {
    if (!uiResult.success || !uiResult.data) return;
    const entryTypeLabels = {
      popup: 'Popup', options: 'Options', background: 'Background',
      newtab: 'New Tab', history: 'History', bookmarks: 'Bookmarks',
      devtools: 'DevTools', sidepanel: 'Side Panel',
    };
    for (const entry of uiResult.data) {
      if (!entry.openable) continue;
      const label = entryTypeLabels[entry.type] || entry.type;
      const cmdName = `${entry.extensionName}: ${label}`;
      api.commands.register({
        name: cmdName,
        description: `Open ${label} for ${entry.extensionName}`,
        execute: async () => {
          await api.chromeExtensions.openPage(entry.extensionId, entry.type);
        }
      });
    }
    log('core', `Registered ${uiResult.data.filter(e => e.openable).length} chrome extension entry point commands`);
  }).catch(err => {
    log.error('core', 'Failed to register chrome extension entry point commands:', err);
  });

  log('core', 'Core commands registered');
};

export const init = async () => {
  const initStart = Date.now();

  // Run migrations first (moves localStorage -> datastore)
  await migrations.runMigrations();

  // Create datastore-backed store
  store = await createDatastoreStore('core', defaults);

  // Initialize cmd registry + subscribers FIRST so that any feature tile
  // that publishes `cmd:register` / `cmd:register-batch` during its own
  // init reaches a live registry. Pre-consolidation this ran in a separate
  // cmd-resident BrowserWindow created by cmd-glue.ts; now it runs inside
  // this core background renderer.
  await initCmd();
  await initPage();
  // await initHud(); // disabled — see import comment above

  // Register feature:all-loaded subscriber BEFORE publishing topicCorePrefs.
  // Main subscribes to topicCorePrefs and kicks off loadFeatures() which
  // publishes feature:all-loaded. Because loadFeatures runs in parallel with
  // the rest of this init(), subscribing later in init() would race and
  // miss the publish — the renderer's subscriber would be registered
  // after the IPC message had already been sent and dropped.
  api.subscribe('feature:all-loaded', () => {
    try {
      registerCoreCommands();
    } catch (err) {
      log.error('core', 'registerCoreCommands threw:', err);
    }
  });

  const p = prefs();

  // main process uses these for initialization
  api.publish(topicCorePrefs, {
    id: id,
    prefs: p
  });

  log('timing', `core init: ${Date.now() - initStart}ms`);

  // Listen for system- or feature-level requests to open windows.
  api.subscribe('open', msg => {
    // eg from the tray icon.
    if (msg.address && msg.address == settingsAddress) {
      openSettingsWindow(p).catch(err => {
        log.error('core', 'Error opening settings window from open event:', err);
      });
    }
  });

  // Handle URLs opened from external apps (e.g., when Peek is default browser)
  api.subscribe('external:open-url', async (msg) => {
    log('core', 'external:open-url', msg);
    const { url, trackingSource, trackingSourceId } = msg;

    try {
      // Use URL as key to reuse existing windows
      await windowManager.createWindow(url, {
        key: url,
        trackingSource,
        trackingSourceId
      });
    } catch (error) {
      log.error('core', 'Error opening external URL (attempt 1):', error);
      // Retry once after a short delay
      try {
        await new Promise(resolve => setTimeout(resolve, 500));
        log('core', 'Retrying external URL:', url);
        await windowManager.createWindow(url, {
          key: url,
          trackingSource,
          trackingSourceId
        });
      } catch (retryError) {
        log.error('core', 'Error opening external URL (retry failed):', retryError);
      }
    }
  });

  // Handle new-page-window requests from main process (Cmd+N shortcut)
  api.subscribe('window:new-page-request', async (msg) => {
    log('core', 'window:new-page-request', msg);
    const { url, options } = msg;

    try {
      const win = await windowManager.createWindow(url, {
        ...options,
        trackingSource: options?.trackingSource || 'new-window',
        trackingSourceId: options?.trackingSourceId || 'shortcut',
      });
      // Show navbar with URL bar focused so user can immediately type a URL
      if (win && win.id) {
        // Small delay to ensure the page host has loaded and subscribed
        setTimeout(() => {
          api.publish('page:show-navbar', { windowId: win.id, focusUrl: true });
        }, 200);
      }
    } catch (error) {
      log.error('core', 'Error opening new page window:', error);
    }
  });

  // Handle reopen-last-closed-window requests from main process
  api.subscribe('window:reopen-request', async (msg) => {
    log('core', 'window:reopen-request', msg);
    const { url, options } = msg;

    try {
      await windowManager.createWindow(url, {
        ...options,
        trackingSource: options?.trackingSource || 'reopen',
        trackingSourceId: options?.trackingSourceId || 'last-closed',
      });
    } catch (error) {
      log.error('core', 'Error reopening window:', error);
    }
  });

  // Register "reopen closed window" command for the command palette
  api.subscribe('cmd:execute:reopen closed window', async (msg) => {
    const result = await api.session.reopenLastClosed();
    if (msg.expectResult && msg.resultTopic) {
      api.publish(msg.resultTopic, result || { success: true });
    }
  });
  api.publish('cmd:register', {
    name: 'reopen closed window',
    description: 'Reopen the last closed window (Cmd+Shift+T)',
    source: 'system',
    scope: 'global',
    accepts: [],
    produces: [],
    params: []
  });

  // Signal to main process that frontend subscribers are ready.
  // This unblocks pending external URLs that arrived during startup.
  api.invoke('frontend-ready').catch(err => {
    log.error('core', 'Failed to signal frontend-ready:', err);
  });

  // Check if session restore is pending — if so, skip the startup feature
  // since restored windows will replace the default startup window
  let sessionRestorePending = false;
  try {
    if (p.restoreSession !== false) {
      sessionRestorePending = await api.invoke('session-restore-pending');
      if (sessionRestorePending) {
        log('core', 'Session restore pending, skipping startup feature');
      }
    }
  } catch (err) {
    log('core', 'Failed to check session restore status:', err);
  }

  // Open startup feature (settings by default, or user-configured feature)
  // Skip if session restore is pending (restored windows replace the startup window)
  const openStartupFeature = async () => {
    try {
      const startupUrl = p.startupFeature || settingsAddress;
      log('core', 'Opening startup feature:', startupUrl);

      if (startupUrl === settingsAddress) {
        await openSettingsWindow(p);
      } else {
        await windowManager.createWindow(startupUrl, {
          key: startupUrl,
          role: 'workspace',
          transparent: true,
          height: p.height || 600,
          width: p.width || 800
        });
      }
    } catch (error) {
      log.error('core', 'Error opening startup feature:', error);
    }
  };

  if (!sessionRestorePending) {
    await openStartupFeature();
  }

  // If session restore was pending but nothing was restored (user declined,
  // snapshot was empty, or restore failed), open the startup feature.
  api.subscribe('session:open-startup', () => {
    log('core', 'Session restore declined/failed, opening startup feature');
    openStartupFeature();
  });

  // Feature enable/disable handler
  // Features are managed by main process via the strict tile:features:* IPC.
  api.subscribe(topicFeatureToggle, async msg => {
    log('core', 'feature toggle', msg)

    // Find feature by ID (UUID) or by name (feature ID like "groups")
    const f = features().find(f =>
      f.id == msg.featureId ||
      f.name.toLowerCase() === msg.featureId?.toLowerCase()
    );
    if (f) {
      log('core', 'feature toggle', f);

      // Check if this feature is backed by a builtin tile.
      const featureId = f.name.toLowerCase();
      const isFeatureTile = builtinFeatureTiles.includes(featureId);

      if (msg.enabled == false) {
        log('core', 'disabling', f.name);
        if (isFeatureTile) {
          await api.features.disable(featureId);
        } else {
          log('core', 'uninit non-feature toggle not implemented:', f.name);
        }
      }
      else if (msg.enabled == true) {
        log('core', 'enabling', f.name);
        if (isFeatureTile) {
          await api.features.enable(featureId);
        } else {
          initFeature(f);
        }
      }
    }
    else {
      log('core', 'feature toggle - no feature found for', msg.featureId);
    }
  });

  initSettingsShortcut(p);

  // Re-register settings shortcut when prefs change (e.g., user edits shortcut in settings UI)
  api.subscribe(topicCorePrefs, (msg) => {
    if (msg && msg.prefs && msg.prefs.shortcutKey) {
      log('core', 'prefs changed, updating settings shortcut');
      initSettingsShortcut(msg.prefs);
    }
  });

  // Initialize core features (non-tile-backed only — tile-backed features
  // are loaded by the main-process tile launcher).
  features().forEach(initFeature);

  // Features (tiles) are loaded by the main process feature pipeline.
  // The main-process startup (entry.ts -> loadFeatures()) runs the v2
  // tile pipeline (tile-compat / tile-loader); core background just
  // initializes in-process features and waits for `feature:all-loaded`.
  log('core', 'Core features initialized. Tiles loaded by main process.');

};


// Note: init() is now called explicitly by app/background.html AFTER
// `await api.initialize()` resolves, so the v2 tile-preload capability
// token is validated before any subscribers / datastore / window calls
// fire. Previously this ran on `window.load`, which raced the async
// `tile:validate-token` IPC round-trip under tile-preload.cjs.
//
// Keeping the export so Electron / Tauri / mobile backends can await
// init() completion before signalling their own startup readiness.
export default { init };
