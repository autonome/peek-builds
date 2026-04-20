/**
 * Help Docs Extension Background Script
 *
 * Spawns a fullscreen transparent overlay window with animated
 * documentation hints that appear from screen edges.
 *
 * Runs in isolated extension process (peek://helpdocs/background.html)
 */

const api = window.app;
const debug = api.debug;

console.log('[ext:helpdocs] background init');

const OVERLAY_ADDRESS = 'peek://helpdocs/overlay.html';
const STORAGE_KEY = 'helpdocs_enabled';

let enabled = false;
let overlayWindowId = null;
let appFocused = true;

/**
 * Load enabled state
 */
const loadState = async () => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    enabled = stored === 'true'; // Default disabled
    console.log('[ext:helpdocs] Loaded state from localStorage - enabled:', enabled);
  } catch (err) {
    console.log('[ext:helpdocs] Failed to load state from localStorage:', err);
  }
  return enabled;
};

/**
 * Save enabled state
 */
const saveState = (value) => {
  enabled = value;
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
    console.log('[ext:helpdocs] Saved state to localStorage - enabled:', value);
  } catch (err) {
    console.error('[ext:helpdocs] Failed to save state to localStorage:', err);
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
    title: 'Help Docs',
    centerOnParent: false,
    show: true
  };

  try {
    const result = await api.window.open(OVERLAY_ADDRESS, params);
    if (result.success) {
      overlayWindowId = result.id;
      console.log('[ext:helpdocs] Overlay opened:', overlayWindowId);

      // Make the window click-through but still receive mouse move events
      // forward: true means mouse moves are still forwarded to the renderer
      setTimeout(async () => {
        try {
          await api.window.setIgnoreMouseEvents(overlayWindowId, true, true);
          console.log('[ext:helpdocs] Set click-through with forward');
        } catch (err) {
          console.error('[ext:helpdocs] Failed to set click-through:', err);
        }
      }, 500);
    } else {
      console.error('[ext:helpdocs] Failed to open overlay:', result.error);
    }
  } catch (error) {
    console.error('[ext:helpdocs] Error opening overlay:', error);
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
    console.log('[ext:helpdocs] Overlay closed');
  }
};

const toggle = async () => {
  const newState = !enabled;
  saveState(newState);
  if (newState) {
    await openOverlay();
    return { output: 'Help docs enabled', mimeType: 'text/plain' };
  } else {
    await closeOverlay();
    return { output: 'Help docs disabled', mimeType: 'text/plain' };
  }
};

// Commands
const commandDefinitions = [
  {
    name: 'help docs',
    description: 'Toggle help documentation overlay',
    execute: async () => {
      console.log('[ext:helpdocs] Toggle command executed');
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
  console.log('[ext:helpdocs] Registered commands:', registeredCommands);
};

const uninitCommands = () => {
  registeredCommands.forEach(name => {
    api.commands.unregister(name);
  });
  registeredCommands = [];
};

const init = async () => {
  console.log('[ext:helpdocs] init');

  await loadState();
  initCommands();

  // Track app focus to show/hide overlay
  api.pubsub.subscribe('app:focus-changed', async (msg) => {
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

  console.log('[ext:helpdocs] Initialized, enabled:', enabled);
};

const uninit = () => {
  console.log('[ext:helpdocs] uninit');
  uninitCommands();
  closeOverlay();
};

export default {
  id: 'helpdocs',
  labels: {
    name: 'Help docs'
  },
  init,
  uninit
};
