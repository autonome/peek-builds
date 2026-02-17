/**
 * Tentacles Extension Background Script
 *
 * Spawns a fullscreen transparent overlay window where animated tentacles
 * creep in from screen edges and flee from the cursor.
 *
 * Runs in isolated extension process (peek://ext/tentacles/background.html)
 */

const api = window.app;
const debug = api.debug;

console.log('[ext:tentacles] background init');

const OVERLAY_ADDRESS = 'peek://ext/tentacles/tentacles.html';
const STORAGE_KEY = 'tentacles_enabled';

let enabled = false;
let overlayWindowId = null;
let appFocused = true;

/**
 * Load enabled state
 */
const loadState = async () => {
  if (api?.settings?.getKey) {
    try {
      const result = await api.settings.getKey('overlay_visible');
      if (result.success && result.data !== undefined && result.data !== null) {
        enabled = !!result.data;
        console.log('[ext:tentacles] Loaded state from datastore - enabled:', enabled);
        return enabled;
      }
    } catch (err) {
      console.log('[ext:tentacles] Failed to load from datastore:', err);
    }
  }
  const stored = localStorage.getItem(STORAGE_KEY);
  enabled = stored === null ? true : stored === 'true'; // Default enabled
  console.log('[ext:tentacles] Loaded state - enabled:', enabled);
  return enabled;
};

/**
 * Save enabled state
 */
const saveState = (value) => {
  enabled = value;
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch (err) {
    debug && console.log('[ext:tentacles] Failed to cache state:', err);
  }
  if (api?.settings?.setKey) {
    api.settings.setKey('overlay_visible', value).catch(err => {
      console.error('[ext:tentacles] Failed to save state:', err);
    });
  }
};

/**
 * Open the overlay window (fullscreen, transparent, click-through)
 */
const openOverlay = async () => {
  if (overlayWindowId) {
    const exists = await api.window.exists(overlayWindowId);
    if (exists.success && exists.data) {
      await api.window.show(overlayWindowId);
      return;
    }
    overlayWindowId = null;
  }

  const screenW = window.screen.width;
  const screenH = window.screen.height;

  const params = {
    key: OVERLAY_ADDRESS,
    width: screenW,
    height: screenH,
    x: 0,
    y: 0,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    frame: false,
    hasShadow: false,
    escapeMode: 'ignore',
    title: 'Tentacles',
    centerOnParent: false,
    show: true
  };

  try {
    const result = await api.window.open(OVERLAY_ADDRESS, params);
    if (result.success) {
      overlayWindowId = result.id;
      console.log('[ext:tentacles] Overlay opened:', overlayWindowId);

      // Make the window click-through but still receive mouse move events
      // forward: true means mouse moves are still forwarded to the renderer
      setTimeout(async () => {
        try {
          await api.window.setIgnoreMouseEvents(overlayWindowId, true, true);
          console.log('[ext:tentacles] Set click-through with forward');
        } catch (err) {
          console.error('[ext:tentacles] Failed to set click-through:', err);
        }
      }, 500);
    } else {
      console.error('[ext:tentacles] Failed to open overlay:', result.error);
    }
  } catch (error) {
    console.error('[ext:tentacles] Error opening overlay:', error);
  }
};

const showOverlay = async () => {
  if (overlayWindowId) {
    const exists = await api.window.exists(overlayWindowId);
    if (exists.success && exists.data) {
      await api.window.show(overlayWindowId);
    }
  }
};

const hideOverlay = async () => {
  if (overlayWindowId) {
    const exists = await api.window.exists(overlayWindowId);
    if (exists.success && exists.data) {
      await api.window.hide(overlayWindowId);
    }
  }
};

const closeOverlay = async () => {
  if (overlayWindowId) {
    await api.window.close(overlayWindowId);
    overlayWindowId = null;
    console.log('[ext:tentacles] Overlay closed');
  }
};

const toggle = async () => {
  const newState = !enabled;
  saveState(newState);
  if (newState) {
    await openOverlay();
    return { output: 'Tentacles enabled', mimeType: 'text/plain' };
  } else {
    await closeOverlay();
    return { output: 'Tentacles disabled', mimeType: 'text/plain' };
  }
};

// Commands
const commandDefinitions = [
  {
    name: 'tentacles',
    description: 'Toggle tentacles easter egg on/off',
    execute: async () => {
      console.log('[ext:tentacles] Toggle command executed');
      return await toggle();
    }
  }
];

let registeredCommands = [];

const initCommands = () => {
  commandDefinitions.forEach(cmd => {
    api.commands.register(cmd);
    registeredCommands.push(cmd.name);
  });
  console.log('[ext:tentacles] Registered commands:', registeredCommands);
};

const uninitCommands = () => {
  registeredCommands.forEach(name => {
    api.commands.unregister(name);
  });
  registeredCommands = [];
};

const init = async () => {
  console.log('[ext:tentacles] init');

  await loadState();
  initCommands();

  // Track app focus to show/hide overlay
  api.subscribe('app:focus-changed', async (msg) => {
    appFocused = !!msg.focused;
    if (enabled && overlayWindowId) {
      if (appFocused) {
        await showOverlay();
      } else {
        await hideOverlay();
      }
    }
  }, api.scopes.GLOBAL);

  if (enabled) {
    await openOverlay();
  }

  console.log('[ext:tentacles] Initialized, enabled:', enabled);
};

const uninit = () => {
  console.log('[ext:tentacles] uninit');
  uninitCommands();
  closeOverlay();
};

export default {
  id: 'tentacles',
  labels: {
    name: 'Tentacles'
  },
  init,
  uninit
};
