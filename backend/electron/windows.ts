/**
 * Window Management Helpers
 *
 * Helper functions for managing BrowserWindow instances.
 */

import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import {
  WEB_CORE_ADDRESS,
  SETTINGS_ADDRESS,
  isTestProfile,
  isHeadless,
  DEBUG,
} from './config.js';

// Default background colors for light and dark system themes
// These are used to prevent the white flash when opening new windows
const DARK_BACKGROUND = '#1e1e1e';
const LIGHT_BACKGROUND = '#ffffff';

import {
  getWindowInfo,
  getChildWindows,
} from './main.js';

import {
  getIzuiCoordinator,
} from './izui-state.js';

/**
 * Get the appropriate background color based on system theme
 * This helps prevent the "white flash" when opening windows in dark mode
 */
export function getSystemThemeBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? DARK_BACKGROUND : LIGHT_BACKGROUND;
}

// Preferences getter - set by index.js during initialization
let _getPrefs: () => Record<string, unknown> = () => ({});

/**
 * Set the preferences getter function
 */
export function setPrefsGetter(getter: () => Record<string, unknown>): void {
  _getPrefs = getter;
}

/**
 * Get current preferences
 */
export function getPrefs(): Record<string, unknown> {
  return _getPrefs();
}

/**
 * Modify window state (close, hide, show)
 */
export function modWindow(bw: BrowserWindow, params: { action: string }): void {
  if (params.action === 'close') {
    bw.close();
  }
  if (params.action === 'hide') {
    bw.hide();
  }
  if (params.action === 'show') {
    bw.show();
  }
}

/**
 * Ask renderer to handle escape key.
 *
 * Protocol:
 *   { handled: true }                - Renderer navigated internally, no action needed
 *   { handled: false, close: true }  - Renderer at root, explicitly requesting close
 *   { handled: false }               - Renderer didn't handle (or timeout/error)
 *
 * For 'navigate' mode, backend only closes on explicit { close: true }.
 * For 'auto' mode, { handled: false } is sufficient (active mode won't close anyway).
 */
export function askRendererToHandleEscape(bw: BrowserWindow): Promise<{ handled: boolean; close?: boolean; timeout?: boolean }> {
  return new Promise((resolve) => {
    const responseChannel = `escape-response-${bw.id}-${Date.now()}`;
    console.log(`[esc] Asking renderer to handle escape, channel: ${responseChannel}`);

    const timeout = setTimeout(() => {
      console.log(`[esc] Renderer timeout (500ms) - no response on ${responseChannel}`);
      ipcMain.removeAllListeners(responseChannel);
      resolve({ handled: false, timeout: true });
    }, 500);

    ipcMain.once(responseChannel, (_event, response) => {
      console.log(`[esc] Renderer responded on ${responseChannel}:`, response);
      clearTimeout(timeout);
      resolve(response || { handled: false });
    });

    bw.webContents.send('escape-pressed', { responseChannel });
  });
}

/**
 * Add escape key handler to a window
 * Supports escapeMode: 'auto' (default), 'close', 'navigate', 'ignore'
 *
 * - 'auto' (default): Transient windows (opened without app focus) close on ESC;
 *   active windows (opened while app focused) behave like 'navigate'
 * - 'close': ESC always closes the window
 * - 'navigate': ESC only triggers internal navigation, never closes
 *   (renderer handles ESC via IZUI - parent focus, internal nav, etc.)
 * - 'ignore': ESC is completely ignored (for overlays that shouldn't respond)
 */
export function addEscHandler(bw: BrowserWindow): void {
  DEBUG && console.log('adding esc handler to window:', bw.id);
  let lastEscTime = 0;
  bw.webContents.on('before-input-event', async (e, i) => {
    if (i.key === 'Escape' && i.type === 'keyUp') {
      // Debounce: ignore ESC events within 200ms of each other
      // Prevents double-fires from key propagation or OS focus changes
      const now = Date.now();
      if (now - lastEscTime < 200) {
        console.log(`[esc] Debounced ESC keyUp on window ${bw.id} (${now - lastEscTime}ms since last)`);
        return;
      }
      lastEscTime = now;

      // Prevent ESC from propagating to the page
      e.preventDefault();

      // Get window info
      const entry = getWindowInfo(bw.id);
      const params = entry?.params || {};
      const escapeMode = (params.escapeMode as string) || 'auto';

      // Always log ESC handling for debugging
      console.log(`[esc] ESC keyUp - window ${bw.id}, escapeMode: ${escapeMode}, transient: ${params.transient}, url: ${params.address}`);

      // For 'ignore' mode, do nothing - let ESC pass through
      if (escapeMode === 'ignore') {
        DEBUG && console.log('Ignore mode - not handling ESC');
        return;
      }

      // For 'navigate' mode, renderer owns the window lifecycle completely.
      // Backend NEVER closes navigate mode windows from ESC handler.
      // Renderer handles internal navigation and calls izui-close-self IPC when done.
      if (escapeMode === 'navigate') {
        console.log(`[esc] navigate mode - forwarding to renderer (backend will NOT close)`);
        const response = await askRendererToHandleEscape(bw);
        console.log(`[esc] navigate mode response (informational only):`, response);
        // Navigate mode: renderer is fully responsible for lifecycle.
        // If renderer wants to close, it calls izui-close-self IPC directly.
        // Backend never closes here - prevents races and phantom ESC issues.
        return;
      }

      // For 'auto' mode, check if transient (no focused window when opened)
      if (escapeMode === 'auto') {
        // Use IZUI coordinator for consistent state management
        const coordinator = getIzuiCoordinator();
        const isCoordinatorOverlay = coordinator.isOverlay();

        // Overlay windows always close on ESC (they're full-screen temporary views)
        const isOverlay = isCoordinatorOverlay || params.overlay === true || params.overlayHiddenWindows;

        // Check transient from coordinator (re-evaluated) or window params (fallback)
        const isTransient = coordinator.isTransient() || params.transient === true;

        if (isTransient || isOverlay) {
          // Transient mode or overlay - close immediately
          console.log('[esc] Auto mode (transient or overlay) - closing directly, coordinator.isTransient:', coordinator.isTransient());
        } else {
          // Active mode (Peek was focused when window opened)
          // IZUI Policy: ESC only navigates internal state, does NOT close
          // Unless renderer explicitly requests close via { close: true }
          console.log(`[esc] auto mode (non-transient/active) - asking renderer to handle`);
          const response = await askRendererToHandleEscape(bw);
          console.log(`[esc] Renderer escape response (auto/active):`, response);
          if (response.handled) {
            return;
          }
          if (response.close) {
            console.log('[esc] Active mode - renderer explicitly requested close');
            closeOrHideWindow(bw.id);
            return;
          }
          console.log('[esc] Active mode - renderer did not handle, NOT closing (IZUI policy)');
          return;
        }
      }

      // Only 'close' mode and transient 'auto' mode reach here
      console.log('[esc] Closing/hiding window via closeOrHideWindow');
      closeOrHideWindow(bw.id);
    }
  });
}

/**
 * Configure devtools for a window based on its parameters
 */
export function winDevtoolsConfig(bw: BrowserWindow): void {
  const windowData = getWindowInfo(bw.id);
  const params = windowData ? windowData.params : {};

  DEBUG && console.log('winDevtoolsConfig:', bw.id, 'openDevTools:', params.openDevTools, 'address:', params.address);

  // Check if devTools should be opened (never in test profiles or headless mode)
  if (params.openDevTools === true && !isTestProfile() && !isHeadless()) {
    const isDetached = params.detachedDevTools === true;
    // Determine if detached mode should be used
    // activate: false prevents devtools from stealing focus (only works with detach/undocked)
    const devToolsOptions: Electron.OpenDevToolsOptions = {
      mode: isDetached ? 'detach' : 'right',
      activate: false
    };

    DEBUG && console.log(`Opening DevTools for window ${bw.id} with options:`, devToolsOptions);

    // Open DevTools after a slight delay to let the main window settle
    setTimeout(() => {
      bw.webContents.openDevTools(devToolsOptions);

      // when devtools completely open, ensure content window has focus
      bw.webContents.once('devtools-opened', () => {
        // Re-focus the content window after devtools opens
        setTimeout(() => {
          if (bw.isVisible() && !bw.isDestroyed()) {
            bw.focus();
            bw.webContents.focus();
          }
        }, 100);
      });
    }, 50);
  }
}

/**
 * Close a window and its children
 * This will actually close the window regardless of "keep alive" opener params
 */
export function closeWindow(params: { id?: number }, callback?: (success: boolean) => void): void {
  DEBUG && console.log('closeWindow', params, callback != null);

  let retval = false;

  if (params.id !== undefined && getWindowInfo(params.id)) {
    DEBUG && console.log('closeWindow(): closing', params.id);

    const entry = getWindowInfo(params.id);
    if (!entry) {
      // wtf
      if (callback) callback(false);
      return;
    }

    closeChildWindows(entry.params.address as string);

    const win = BrowserWindow.fromId(params.id);
    if (win) {
      win.close();
    }

    retval = true;
  }

  if (callback) {
    callback(retval);
  }
}

/**
 * Get count of visible user windows (excluding background window)
 */
export function getVisibleWindowCount(excludeId: number | null = null): number {
  return BrowserWindow.getAllWindows().filter(win => {
    if (excludeId && win.id === excludeId) return false;
    if (win.isDestroyed()) return false;
    if (!win.isVisible()) return false;

    // Exclude the background window
    const entry = getWindowInfo(win.id);
    if (entry && entry.params.address === WEB_CORE_ADDRESS) return false;

    return true;
  }).length;
}

// Track if dock is already hidden for test profiles (avoid repeated hide calls causing animation)
let _testDockHidden = false;

/**
 * Update dock visibility based on visible windows and pref
 * Show dock if: visible windows exist OR pref is enabled
 * Hide dock if: no visible windows AND pref is disabled
 * Always hide dock in test profiles to prevent test interference
 */
export function updateDockVisibility(excludeId: number | null = null): void {
  if (process.platform !== 'darwin' || !app.dock) return;

  // Always hide dock in test profiles to prevent interference with tests
  // Only hide once to avoid dock animation glitches from repeated hide calls
  if (isTestProfile()) {
    if (!_testDockHidden) {
      app.dock.hide();
      _testDockHidden = true;
    }
    return;
  }

  const visibleCount = getVisibleWindowCount(excludeId);
  const prefs = _getPrefs();
  const prefShowDock = prefs?.showInDockAndSwitcher === true;

  DEBUG && console.log('updateDockVisibility:', { visibleCount, prefShowDock, excludeId });

  if (visibleCount > 0 || prefShowDock) {
    DEBUG && console.log('Showing dock');
    app.dock.show();
  } else {
    DEBUG && console.log('Hiding dock');
    app.dock.hide();
  }
}

/**
 * Hide the app if there are no other visible windows
 */
export function maybeHideApp(excludeId: number): void {
  if (process.platform !== 'darwin') return;

  const visibleCount = getVisibleWindowCount(excludeId);
  DEBUG && console.log('maybeHideApp: visible windows (excluding', excludeId + '):', visibleCount);

  if (visibleCount === 0) {
    DEBUG && console.log('No other visible windows, hiding app');
    app.hide();
  } else {
    DEBUG && console.log('Other windows visible, not hiding app');
  }

  // Also update dock visibility
  updateDockVisibility(excludeId);
}

/**
 * Close or hide a window based on its parameters
 */
export function closeOrHideWindow(id: number): void {
  DEBUG && console.log('closeOrHideWindow called for ID:', id);

  try {
    const win = BrowserWindow.fromId(id);
    if (!win || win.isDestroyed()) {
      DEBUG && console.log('Window already destroyed or invalid');
      return;
    }

    const entry = getWindowInfo(id);
    DEBUG && console.log('Window entry from manager:', entry);

    if (!entry) {
      DEBUG && console.log('Window not found in window manager, closing directly');
      win.close();
      return;
    }

    const params = entry.params;
    DEBUG && console.log('Window parameters - modal:', params.modal, 'keepLive:', params.keepLive);

    // Never close the background window
    if (params.address === WEB_CORE_ADDRESS) {
      DEBUG && console.log('Refusing to close background window');
      return;
    }

    // Special case for settings window - always close it on ESC
    if (params.address === SETTINGS_ADDRESS) {
      DEBUG && console.log(`CLOSING settings window ${id}`);
      closeChildWindows(params.address as string);
      win.close();
      // Hide app to return focus to previous app (only if no other visible windows)
      maybeHideApp(id);
    }
    // Check if window should be hidden rather than closed
    // Either keepLive or modal parameter can trigger hiding behavior
    else if (params.keepLive === true || params.modal === true) {
      win.hide();
      // Hide app to return focus to previous app (only if no other visible windows)
      maybeHideApp(id);
    } else {
      // close any open windows this window opened
      closeChildWindows(params.address as string);
      DEBUG && console.log(`CLOSING window ${id} (${params.address})`);
      win.close();
      // Hide app to return focus to previous app (only if no other visible windows)
      maybeHideApp(id);
    }

    DEBUG && console.log('closeOrHideWindow completed');
  } catch (error) {
    console.error('Error in closeOrHideWindow:', error);
  }
}

/**
 * Close all child windows of a given address
 */
export function closeChildWindows(aAddress: string): void {
  DEBUG && console.log('closeChildWindows()', aAddress);

  if (aAddress === WEB_CORE_ADDRESS) {
    return;
  }

  // Get all child windows from the window manager
  const childWindows = getChildWindows(aAddress);

  for (const child of childWindows) {
    const address = child.data.params.address as string;
    DEBUG && console.log('closing child window', address, 'for', aAddress);

    // recurseme
    closeChildWindows(address);

    // close window
    const win = BrowserWindow.fromId(child.id);
    if (win) {
      win.close();
    }
  }
}
