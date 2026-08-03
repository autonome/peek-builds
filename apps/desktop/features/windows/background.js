/**
 * Windows Extension Background Script
 *
 * Full-screen window switcher with transparent overlay
 *
 * Runs in isolated extension process (peek://windows/background.html)
 */

import { id, labels, schemas, storageKeys, defaults } from './config.js';

const api = window.app;

console.log('[ext:windows] background', labels.name);

// Extension content is served from peek://windows/ (hybrid mode)
const address = 'peek://windows/windows.html';

// In-memory settings cache
let currentSettings = {
  prefs: defaults.prefs
};

/**
 * Load settings from datastore
 */
const loadSettings = async () => {
  const result = await api.settings.get('prefs');
  if (result && !result.error && result.value) {
    return { prefs: result.value };
  }
  return { prefs: defaults.prefs };
};

/**
 * Open the Windows view (maximized, transparent overlay).
 *
 * Every invocation routes through `api.window.open`, mirroring cmd /
 * slides / peeks. The dismiss path destroys the window (window.close()
 * inside the overlay renderer), and overlay-mode hide-others restoration
 * runs on the BrowserWindow's `closed` event in main.ts. Next
 * invocation creates a fresh BrowserWindow via window-open.
 *
 * Window-open's fresh-create path (`apps/desktop/main/ipc.ts`, search:
 * `spacesPolicy = spacesPolicyForRole(role, ...)`) calls
 * `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`
 * synchronously for transient roles like `overlay`, so the new window
 * lands on the user's active macOS Space — even if the user switched
 * Spaces since the last invocation. This is the same code path cmd /
 * slides / peeks rely on.
 *
 * Previously this function short-circuited via a cached `windowsViewId`
 * + `api.window.show(...)`, which bypassed window-open entirely and
 * therefore bypassed the Spaces handling — the overlay would re-show
 * on its original Space and the user (now on a different Space) would
 * see nothing.
 */
const openWindowsView = async () => {
  const params = {
    // IZUI role
    role: 'switcher',

    key: address,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximize: true,
    type: 'panel',
    // Overlay mode: backend hides other windows when this opens,
    // and restores them when this closes
    overlay: true,
    trackingSource: 'windows',
    trackingSourceId: 'main'
  };

  try {
    await api.window.open(address, params);
  } catch (error) {
    console.error('[ext:windows] Failed to open windows view:', error);
  }
};

// ===== Command definitions =====

const commandDefinitions = [
  {
    name: 'windows',
    description: 'Show all windows in full-screen overlay',
    execute: async (ctx) => {
      console.log('[ext:windows] Opening windows view');
      openWindowsView();
    }
  },
  {
    name: 'center window',
    description: 'Center the active window on its display',
    execute: async (ctx) => {
      const windowId = await api.window.getFocusedVisibleWindowId();
      if (!windowId) return { success: false, error: 'No active window' };
      return api.window.center(windowId);
    }
  },
  {
    name: 'center all windows',
    description: 'Center all windows on their respective displays',
    execute: async (ctx) => {
      return api.window.centerAll();
    }
  },
  {
    name: 'maximize window',
    description: 'Maximize the active window',
    execute: async (ctx) => {
      const windowId = await api.window.getFocusedVisibleWindowId();
      if (!windowId) return { success: false, error: 'No active window' };
      return api.window.maximize(windowId);
    }
  },
  {
    name: 'unmaximize window',
    description: 'Restore the active window from maximize',
    execute: async (ctx) => {
      const windowId = await api.window.getFocusedVisibleWindowId();
      if (!windowId) return { success: false, error: 'No active window' };
      return api.window.unmaximize(windowId);
    }
  },
  {
    name: 'fullscreen',
    description: 'Toggle fullscreen for the active window',
    execute: async (ctx) => {
      const windowId = await api.window.getFocusedVisibleWindowId();
      if (!windowId) return { success: false, error: 'No active window' };
      // Initiate the toggle but do NOT await it. `tile:window:fullscreen`
      // used to resolve only when the ~600ms macOS fullscreen transition had
      // SETTLED (main's single fullscreen owner awaited enter/leave-full-screen),
      // and holding the command result for that long held the cmd palette OPEN
      // across the Space switch: the palette is a follow-Spaces
      // (visibleOnFullScreen) panel, so it rode onto the new fullscreen Space
      // still showing its "Running fullscreen..." spinner, then self-closed —
      // the reported "palette reopens by itself with a spinner, then closes"
      // (peek 7fffa286 follow-up). Today the transition is owned end-to-end by
      // the window-state machine: this command dispatches `FULLSCREEN_REQUESTED`
      // (window-os-adapter.ts is the single `setFullScreen` owner) and the IPC
      // handler returns immediately, without waiting for the transition to
      // settle — so the palette's own FSM closes it immediately either way.
      api.window.fullscreen(windowId).catch(() => {});
      return { success: true };
    }
  }
];

// ===== Registration =====

let registeredCommands = [];

// NOTE: the global shortcut (CommandOrControl+Shift+W → windows) is no
// longer registered here. Now that this is a LAZY tile, the renderer
// isn't running at boot, so it can't own the OS hotkey. The generic
// main-side registrar (apps/desktop/main/feature-shortcut-registrar.ts)
// reads the manifest `shortcuts[]` and registers the global accelerator
// with a callback that publishes `cmd:execute:windows` — which wakes
// THIS tile via the load-on-dispatch hook and lands on the
// `cmd:execute:windows` subscription below. Registering it here too
// would double-register the same accelerator.

const initCommands = async () => {
  commandDefinitions.forEach(cmd => {
    api.commands.register(cmd);
    registeredCommands.push(cmd.name);
  });
  console.log('[ext:windows] Registered commands:', registeredCommands);
};

const uninitCommands = () => {
  registeredCommands.forEach(name => {
    api.commands.unregister(name);
  });
  registeredCommands = [];
  console.log('[ext:windows] Unregistered commands');
};

const init = async () => {
  console.log('[ext:windows] init');

  // Load settings from datastore
  currentSettings = await loadSettings();

  // Register commands (cmd loads first with its subscribers ready via 100ms head start)
  initCommands();

  // Subscribe to cmd:execute:windows so non-cmd-panel callers (notably the
  // ESC handler in apps/desktop/main/windows.ts → escUnhandledPolicy →
  // open-switcher path) can open the switcher by publishing the topic.
  // Without this, only cmd-panel selections and the manifest shortcut work;
  // the ESC fallback silently no-ops once this lazy tile is loaded.
  api.pubsub.subscribe('cmd:execute:windows', () => {
    console.log('[ext:windows] cmd:execute:windows fired');
    openWindowsView();
  });
};

const uninit = () => {
  console.log('[ext:windows] uninit');
  // The global shortcut is owned by the main-side registrar now (see the
  // note in the Registration section); nothing renderer-side to unregister.
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
