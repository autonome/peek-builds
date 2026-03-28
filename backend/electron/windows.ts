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

import { publish, scopes } from './pubsub.js';

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
    DEBUG && console.log(`[esc] Asking renderer to handle escape, channel: ${responseChannel}`);

    const timeout = setTimeout(() => {
      DEBUG && console.log(`[esc] Renderer timeout (500ms) - no response on ${responseChannel}`);
      ipcMain.removeAllListeners(responseChannel);
      resolve({ handled: false, timeout: true });
    }, 500);

    ipcMain.once(responseChannel, (_event, response) => {
      DEBUG && console.log(`[esc] Renderer responded on ${responseChannel}:`, response);
      clearTimeout(timeout);
      resolve(response || { handled: false });
    });

    bw.webContents.send('escape-pressed', { responseChannel });
  });
}

/**
 * ESC policy: given session state and window role, determine what to do.
 * Pure function — no side effects.
 */
export function escPolicy(sessionState: string, role: string): 'close' | 'close-and-restore' | 'nothing' {
  // These roles always close regardless of session state
  if (['quick-view', 'palette', 'utility'].includes(role)) return 'close';
  if (role === 'overlay') return 'close-and-restore';
  // Workspace windows are root/persistent extension windows (groups, search, etc.).
  // They must NEVER close on ESC regardless of session state — the renderer handles
  // internal navigation and the window persists.
  if (role === 'workspace') return 'nothing';
  // child-content and content: only close in transient sessions.
  // In active sessions, ESC navigates internally (renderer handles it) but
  // never closes the window — even child-content windows are user-opened
  // content that should persist. Root-level content windows must not close
  // on ESC in an active session.
  if (sessionState === 'transient') return 'close';
  return 'nothing';
}

/**
 * ESC unhandled policy: second-phase policy consulted ONLY after the renderer
 * returns { handled: false } AND escPolicy() returns 'nothing'.
 *
 * Determines what to do when ESC has nowhere left to navigate.
 * Pure function — no side effects.
 */
export function escUnhandledPolicy(sessionState: string, role: string): 'open-switcher' | 'nothing' {
  // Transient sessions should NOT trigger switcher — user expects ESC to
  // return to previous app, not open more UI.
  // Overlay sessions handle their own ESC (close-and-restore).
  if (sessionState === 'transient' || sessionState === 'overlay') return 'nothing';
  // In active or idle sessions, workspace, content, and child-content windows
  // open the switcher when ESC has nowhere left to navigate.
  // Note: content/child-content only reach here when the renderer's onEscape
  // returned { handled: false } AND escPolicy returned 'nothing', so page-level
  // ESC handling (spaces navigation, panel closing, etc.) takes priority.
  if (['workspace', 'content', 'child-content'].includes(role)) return 'open-switcher';
  return 'nothing';
}

/**
 * Core ESC handling logic for a BrowserWindow.
 * Called when ESC keyDown is detected on the window's own webContents
 * or on a webview guest webContents within the window.
 *
 * Uses IZUI window roles to determine behavior via escPolicy().
 *
 * @param bw - The BrowserWindow to handle ESC for
 * @param source - 'host' if from the window's own webContents, 'webview' if from a guest
 */
async function handleEscapeForWindow(bw: BrowserWindow, source: 'host' | 'webview'): Promise<void> {
  const entry = getWindowInfo(bw.id);
  if (!entry || bw.isDestroyed()) return;

  const params = entry.params;
  const role = (params.role as string) || 'utility';
  DEBUG && console.log(`[esc] ESC keyDown - window ${bw.id}, source: ${source}, role: ${role}, url: ${params.address}`);

  // escapeMode: 'ignore' is a hard override — let ESC pass through entirely
  if (params.escapeMode === 'ignore') {
    DEBUG && console.log('[esc] Ignore mode - not handling ESC');
    return;
  }

  // Ask renderer first (dialog close, internal navigation, etc.)
  const response = await askRendererToHandleEscape(bw);
  if (response.handled) return;

  // Look up session state and apply role-based policy
  const coordinator = getIzuiCoordinator();
  const sessionState = coordinator.getState();
  const action = escPolicy(sessionState, role);
  DEBUG && console.log(`[esc] escPolicy(${sessionState}, ${role}) -> ${action}`);

  if (action === 'close' || action === 'close-and-restore') {
    closeOrHideWindow(bw.id);
  } else {
    // escPolicy returned 'nothing' — renderer is at root and window won't close.
    // Consult second-phase policy for unhandled ESC.
    const unhandledAction = escUnhandledPolicy(sessionState, role);
    DEBUG && console.log(`[esc] escUnhandledPolicy(${sessionState}, ${role}) -> ${unhandledAction}`);
    if (unhandledAction === 'open-switcher') {
      publish('peek://system/', scopes.GLOBAL, 'cmd:execute:windows', {});
    }
  }
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
 *
 * Also handles ESC pressed inside <webview> guests. The BrowserWindow's
 * before-input-event does NOT fire for keystrokes in a webview — those go to the
 * guest's own WebContents. We listen for did-attach-webview to add ESC
 * interception on guest WebContents, delegating back to the host window's
 * escape handling (which sends escape-pressed IPC to the host renderer
 * where the preload's onEscape callback lives).
 */
export function addEscHandler(bw: BrowserWindow): void {
  DEBUG && console.log('adding esc handler to window:', bw.id);
  let lastEscTime = 0;

  // Helper: attach ESC interception to a WebContents (host or guest)
  const attachEscListener = (wc: Electron.WebContents, source: 'host' | 'webview') => {
    wc.on('before-input-event', async (e, i) => {
      if (i.key === 'Escape' && i.type === 'keyDown') {
        // Intercept ESC on keyDown (not keyUp) so the IPC fires BEFORE DOM keydown handlers.
        // This prevents a race condition where peek-dialog closes on DOM keydown,
        // then the IPC callback (on keyUp) sees no open dialog and returns { handled: false },
        // causing the backend to close the entire window.
        // With keyDown interception + e.preventDefault(), the DOM keydown never reaches
        // peek-dialog, and the preload's escape handler sees the dialog still open.

        // Debounce: ignore ESC events within 200ms of each other
        // Prevents double-fires from key propagation or OS focus changes
        const now = Date.now();
        if (now - lastEscTime < 200) {
          DEBUG && console.log(`[esc] Debounced ESC keyDown on window ${bw.id} source:${source} (${now - lastEscTime}ms since last)`);
          return;
        }
        lastEscTime = now;

        // Prevent ESC from propagating to the page (blocks DOM keydown dispatch)
        e.preventDefault();

        await handleEscapeForWindow(bw, source);
      }
    });
  };

  // Listen for ESC on the window's own WebContents (host page)
  attachEscListener(bw.webContents, 'host');

  // Listen for webview guests attaching to this window.
  // When a <webview> tag creates its guest WebContents, keystrokes inside the
  // webview go to the guest — not the host BrowserWindow's webContents.
  // We add an ESC listener on each guest so that ESC in web content (e.g. slides
  // showing youtube.com) is intercepted and routed through the host window's
  // escape handling (which talks to the host renderer's preload onEscape callback).
  bw.webContents.on('did-attach-webview', (_event, guestWebContents) => {
    DEBUG && console.log(`[esc] Webview guest attached to window ${bw.id}, adding ESC listener`);
    attachEscListener(guestWebContents, 'webview');
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
 * Transient window roles that should NOT affect dock visibility.
 * These are modal/overlay windows (cmd palette, quick-view, windows switcher)
 * that open and close frequently. Counting them causes dock show/hide cycling
 * which triggers activation policy changes and spurious blur events.
 */
const TRANSIENT_ROLES = new Set(['palette', 'quick-view', 'overlay']);

/**
 * Get count of visible persistent windows (excluding background, modals, overlays, HUD).
 * Used by maybeHideApp to decide whether to hide the app when a window closes.
 */
export function getVisibleWindowCount(excludeId: number | null = null): number {
  return BrowserWindow.getAllWindows().filter(win => {
    if (excludeId && win.id === excludeId) return false;
    if (win.isDestroyed()) return false;
    if (!win.isVisible()) return false;

    const entry = getWindowInfo(win.id);

    // Exclude the background window
    if (entry && entry.params.address === WEB_CORE_ADDRESS) return false;

    // Exclude transient modals and overlays (cmd palette, quick-view, windows switcher)
    if (entry && TRANSIENT_ROLES.has(entry.params.role as string)) return false;

    // Exclude non-focusable utility windows (HUD)
    if (entry && entry.params.role === 'utility' && entry.params.focusable === false) return false;

    return true;
  }).length;
}

/**
 * Apply dock visibility based on user preference.
 * Call at startup and when the showInDockAndSwitcher preference changes.
 * In test profiles, always hides the dock.
 */
export function applyDockPreference(): void {
  if (process.platform !== 'darwin' || !app.dock) return;

  if (isTestProfile()) {
    app.dock.hide();
    return;
  }

  const prefs = _getPrefs();
  const prefShowDock = prefs?.showInDockAndSwitcher === true;

  DEBUG && console.log('applyDockPreference:', { prefShowDock });

  if (prefShowDock) {
    app.dock.show();
  } else {
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
    }
    // Check if window should be hidden rather than closed.
    // Only keepLive windows are preserved in the background — modal windows
    // without keepLive (peeks, quick-views) should be closed so they can be
    // cleanly recreated on next invocation.
    else if (params.keepLive === true) {
      win.hide();
    } else {
      // close any open windows this window opened
      closeChildWindows(params.address as string);
      DEBUG && console.log(`CLOSING window ${id} (${params.address})`);
      win.close();
    }

    // Hide app to return focus to previous app (only if no other visible windows).
    // Skip for overlay windows — they manage their own restoration flow via the
    // IZUI coordinator and should not trigger app hiding.
    const isOverlay = params.role === 'overlay';
    if (!isOverlay) {
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
