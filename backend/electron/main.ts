/**
 * Electron Main Process Entry Point
 *
 * This module orchestrates the main process startup and provides
 * a unified API for managing the Electron application.
 */

import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { initDatabase, closeDatabase, getDb, trackWindowLoad, updateItemTitle, updateItemFavicon, updateModeForNavigation, getContextEntry } from './datastore.js';
import { registerScheme, initProtocol, registerExtensionPath, getExtensionPath, getRegisteredExtensionIds, registerThemePath, getRegisteredThemeIds } from './protocol.js';
import { initCmd } from './cmd-glue.js';
import { initHud } from './hud-glue.js';
import { discoverExtensions, loadExtensionManifest, isBuiltinExtensionEnabled, getExternalExtensions, type ExtensionManifest, type ManifestCommand, type ManifestShortcut } from './extensions.js';
import { initializeFeatures, type FeatureStartupResult } from './feature-startup.js';
import { getLoadedTileIds, getTileManifest, getAllTileWindows, unloadAllTiles } from './tile-launcher.js';
import { initTray } from './tray.js';
import { registerLocalShortcut, unregisterLocalShortcut, handleLocalShortcut, registerGlobalShortcut, unregisterGlobalShortcut, unregisterShortcutsForAddress } from './shortcuts.js';
import { scopes, publish, subscribe, unsubscribe, hasSubscriber, setExtensionBroadcaster, getSystemAddress } from './pubsub.js';
import { APP_DEF_WIDTH, APP_DEF_HEIGHT, WEB_CORE_ADDRESS, getPreloadPath, isTestProfile, isDevProfile, isHeadless, getProfile, DEBUG } from './config.js';
import { trackWindow } from './display-watcher.js';
import { addEscHandler, winDevtoolsConfig, closeOrHideWindow, getSystemThemeBackgroundColor, getPrefs } from './windows.js';
import { getProfileSession, getPartitionString, getCurrentProfileId } from './session-partition.js';
import { getIzuiCoordinator } from './izui-state.js';
import { clearLastFocusedVisibleWindowId } from './ipc.js';

// Configuration
export interface AppConfig {
  rootDir: string;
  preloadPath: string;
  userDataPath: string;
  profile: string;
  isDev: boolean;
  isTest: boolean;
  darkMode?: string; // 'off' | 'system' | 'force'
}

// App state
let config: AppConfig;
let mainWindow: BrowserWindow | null = null;

// Diagnostic logger for external URL handling.
// Writes to /tmp/ so it's always accessible regardless of userData path.
// This can be removed once external URL handling is confirmed working.
function urlLog(msg: string): void {
  try {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    fs.appendFileSync('/tmp/peek-url-debug.log', line);
  } catch {
    // Ignore write errors
  }
}

// External URL handling state
let _appReady = false;
let _pendingUrls: Array<{ url: string; sourceId: string }> = [];
// Frontend readiness: resolved when background window's app/index.js signals ready
let _frontendReadyResolve: (() => void) | null = null;
const _frontendReadyPromise = new Promise<void>(resolve => { _frontendReadyResolve = resolve; });
let _frontendReady = false;
// Session restore completion: resolved after session restore finishes (or is skipped)
let _sessionRestoreDoneResolve: (() => void) | null = null;
const _sessionRestoreDonePromise = new Promise<void>(resolve => { _sessionRestoreDoneResolve = resolve; });
let _sessionRestoreDone = false;

// Extension windows: extId -> { win, manifest, status }
const extensionWindows = new Map<string, {
  win: BrowserWindow;
  manifest: unknown;
  status: 'loading' | 'running' | 'crashed';
}>();

// Extension host window for built-in extensions (consolidated mode)
let extensionHostWindow: BrowserWindow | null = null;

// Built-in extensions that load in consolidated mode (iframes)
// External extensions (including 'example') load in separate windows
//
// NOTE: 'cmd' and 'hud' were removed from this list when they were extracted
// from features/ into core app code (app/cmd/ and app/hud/). They're now
// loaded via initCmd() / initHud() from cmd-glue.ts / hud-glue.ts, which run
// before feature loading so the command registry is ready for feature command
// registrations.
const CONSOLIDATED_EXTENSION_IDS = ['editor', 'groups', 'lex', 'lists', 'peeks', 'search', 'slides', 'spaces', 'websearch', 'windows', 'page', 'files', 'pagestream', 'sheets', 'tags', 'feeds', 'helpdocs', 'entities', 'scripts', 'timers', 'wonderwall'];

// Extensions that must load eagerly (not lazy) — needed at startup
const EAGER_EXTENSION_IDS = new Set(['entities']);

// Track which lazy extensions have been loaded
const lazyExtensionLoaded = new Set<string>();
// Track which consolidated extensions have actually loaded (eager or lazy)
const loadedConsolidatedExtensions = new Set<string>();
// Pending lazy load callbacks (extId -> resolve[])
const lazyLoadCallbacks = new Map<string, Array<() => void>>();

// Dev extensions loaded via --load-extension CLI flag
// These are transient (not persisted) and always have devtools open
const devExtensions = new Map<string, { path: string }>();

// Window manager: windowId -> { source, params }
const windowRegistry = new Map<number, {
  source: string;
  params: Record<string, unknown>;
}>();

// Recently closed windows stack (in-memory, most recent last)
const MAX_CLOSED_WINDOWS = 50;

export interface ClosedWindowEntry {
  url: string;           // Current URL at time of close (where user actually was)
  originalUrl?: string;  // Original URL the window was opened with
  source: string;
  bounds: { x: number; y: number; width: number; height: number } | null;
  spaceMode: { spaceId: string; spaceName: string; color?: string } | null;
  role?: string;         // Window role (workspace, content, etc.) — needed to restore peek:// windows correctly
  scrollX?: number;      // Scroll position at time of close
  scrollY?: number;
  timestamp: number;
}

const closedWindowStack: ClosedWindowEntry[] = [];

// Flag to suppress closed-window-stack pushes during quit.
// session.ts already pushes all open windows during before-quit,
// so the per-window 'closed' event handler must skip its push to avoid duplicates.
let _suppressClosedWindowPush = false;

export function suppressClosedWindowPush(): void {
  _suppressClosedWindowPush = true;
}

/**
 * Initialize the application configuration
 * Must be called before app.ready
 */
/**
 * Global error handlers — installed once, idempotent.
 *
 * Without these, rejected promises and thrown exceptions that escape
 * the feature/tile loading paths crash the process with no breadcrumb.
 * We install early in configure() so startup-time errors surface.
 */
let _globalErrorHandlersInstalled = false;
function installGlobalErrorHandlers(): void {
  if (_globalErrorHandlersInstalled) return;
  _globalErrorHandlersInstalled = true;

  process.on('unhandledRejection', (reason) => {
    console.error('[main] Unhandled promise rejection:', reason);
  });

  process.on('uncaughtException', (error) => {
    console.error('[main] Uncaught exception:', error);
  });
}

export function configure(cfg: AppConfig): void {
  // Install global error handlers FIRST, before anything else can throw,
  // so startup errors (protocol registration, config parsing, etc.) surface.
  installGlobalErrorHandlers();

  config = cfg;

  // Tier 1 dark mode: 'force' = always dark, 'off'/'system' = respect OS preference
  const darkMode = cfg.darkMode || 'system';
  nativeTheme.themeSource = (darkMode === 'force') ? 'dark' : 'system';

  // Register custom protocol scheme (must be before app.ready)
  registerScheme();
}

/**
 * Initialize the application
 * Called after app.ready
 */
export async function initialize(): Promise<void> {
  if (!config) {
    throw new Error('App not configured. Call configure() first.');
  }

  // Initialize protocol handler
  initProtocol(config.rootDir);

  // Initialize database
  const dbPath = path.join(config.userDataPath, config.profile, 'datastore.sqlite');
  initDatabase(dbPath);

  // Set up extension broadcaster for pubsub
  // Hybrid mode: broadcast to BOTH consolidated (iframes) AND separate windows
  // All send() calls are wrapped in try-catch to prevent errors during shutdown
  // when windows are being destroyed concurrently (race between isDestroyed check and send).
  setExtensionBroadcaster((topic, msg, source) => {
    const sourceOrigin = source.startsWith('peek://') ? new URL(source).origin : source;

    // Broadcast to consolidated extension iframes (built-in extensions)
    if (extensionHostWindow && !extensionHostWindow.isDestroyed()) {
      try {
        const mainFrame = extensionHostWindow.webContents.mainFrame;
        for (const frame of mainFrame.framesInSubtree) {
          if (frame !== mainFrame && frame.url) {
            const frameOrigin = new URL(frame.url).origin;
            // Don't echo back to sender
            if (frameOrigin !== sourceOrigin) {
              frame.send(`pubsub:${topic}`, {
                ...(msg as object),
                source
              });
            }
          }
        }
      } catch {
        // Window may have been destroyed between check and send (during shutdown)
      }
    }

    // Broadcast to separate extension windows (external extensions)
    for (const [extId, entry] of extensionWindows) {
      if (entry.win && !entry.win.isDestroyed() && entry.status === 'running') {
        try {
          entry.win.webContents.send(`pubsub:${topic}`, {
            ...(msg as object),
            source
          });
        } catch {
          // Window may have been destroyed between check and send (during shutdown)
        }
      }
    }

    // Broadcast to v2 tile BrowserWindows (launched by tile-launcher).
    // Without this, v2 tiles that subscribe to global pubsub events (editor:open,
    // item:created, etc.) never receive them, because they're not in
    // extensionWindows or the consolidated extension host.
    for (const tileWin of getAllTileWindows()) {
      try {
        const winOrigin = tileWin.webContents.getURL();
        const winOriginPrefix = winOrigin.startsWith('peek://')
          ? new URL(winOrigin).origin
          : winOrigin;
        // Don't echo back to sender
        if (winOriginPrefix !== sourceOrigin) {
          tileWin.webContents.send(`pubsub:${topic}`, {
            ...(msg as object),
            source
          });
        }
      } catch {
        // Window may have been destroyed between check and send
      }
    }
  });

  // Track OS-level app focus for IZUI transient detection.
  // When Peek is the active app, windows opened are "active."
  // When Peek is in the background, windows opened are "transient."
  if (process.platform === 'darwin') {
    // macOS: use did-become-active / did-resign-active for reliable OS-level focus.
    // browser-window-blur/focus are per-window and unreliable with utility windows
    // (e.g. HUD with alwaysOnTop+focusable:false confuses getFocusedWindow()).
    (app as any).on('did-become-active', () => {
      getIzuiCoordinator().setAppFocused(true);
      publish(getSystemAddress(), scopes.GLOBAL, 'app:focus-changed', { focused: true });
      // Showing alwaysOnTop overlay windows (e.g. HUD) when the app regains
      // focus is handled by hud-glue.ts.
    });
    (app as any).on('did-resign-active', () => {
      const coordBefore = getIzuiCoordinator();
      DEBUG && console.log('[izui] did-resign-active fired. state:', coordBefore.getState(), 'isOverlay:', coordBefore.isOverlay(), 'exitCooldown:', coordBefore.isWithinOverlayExitCooldown(), 'entryCooldown:', coordBefore.isWithinOverlayEntryCooldown());
      coordBefore.setAppFocused(false);
      publish(getSystemAddress(), scopes.GLOBAL, 'app:focus-changed', { focused: false });

      // Close overlay window (e.g. windows switcher) when app loses OS focus.
      // The overlay is a transient full-screen picker that should dismiss when the user
      // Cmd+Tabs away.
      //
      // COOLDOWN GUARDS:
      // 1. EXIT cooldown: After an overlay closes, window restoration can trigger a brief
      //    did-resign-active → did-become-active cycle (macOS focus dance). Skip overlay
      //    close if we just exited an overlay — prevents closing a newly opened overlay.
      // 2. ENTRY cooldown: When an overlay opens, hiding all regular windows can trigger
      //    did-resign-active because only a panel-type window remains (macOS panels don't
      //    count as main windows for app activation). Skip overlay close if one just opened.
      const coordinator = getIzuiCoordinator();
      if (!coordinator.isWithinOverlayExitCooldown() && !coordinator.isWithinOverlayEntryCooldown()) {
        for (const [id, data] of windowRegistry) {
          if (data.params.role === 'overlay') {
            const overlayWin = BrowserWindow.fromId(id);
            if (overlayWin && !overlayWin.isDestroyed()) {
              DEBUG && console.log('[izui] App lost focus while overlay open, closing overlay window:', id);
              // Use app-blur exit path: restores hidden windows but does NOT focus any,
              // so we don't steal focus from the app the user is switching to.
              coordinator.exitOverlayForAppBlur();
              // Mark this window so the 'closed' handler knows not to do overlay restoration
              (overlayWin as any).__closedDueToAppBlur = true;
              overlayWin.close();
            }
            break;
          }
        }
      } else {
        DEBUG && console.log('[izui] Skipping overlay close in did-resign-active (within cooldown: exit=', coordinator.isWithinOverlayExitCooldown(), 'entry=', coordinator.isWithinOverlayEntryCooldown(), ')');
      }

      // Hiding non-focusable alwaysOnTop overlay windows (e.g. HUD) when the
      // app loses focus is handled by hud-glue.ts.
    });
  } else {
    // Non-macOS fallback: use browser-window-focus/blur with focused-window check
    app.on('browser-window-focus', () => {
      getIzuiCoordinator().setAppFocused(true);
      publish(getSystemAddress(), scopes.GLOBAL, 'app:focus-changed', { focused: true });
    });
    app.on('browser-window-blur', () => {
      // Only mark unfocused if NO window has focus (user switched to another app).
      // During window switches within Peek, one window blurs before another focuses.
      if (!BrowserWindow.getFocusedWindow()) {
        getIzuiCoordinator().setAppFocused(false);
        publish(getSystemAddress(), scopes.GLOBAL, 'app:focus-changed', { focused: false });
      }
    });
  }

  // Track window events globally
  app.on('browser-window-created', (_, window) => {
    const windowId = window.id;

    // Capture window bounds before the window is destroyed (for reopen-last-closed)
    let lastBounds: { x: number; y: number; width: number; height: number } | null = null;
    window.on('close', () => {
      try {
        if (!window.isDestroyed()) {
          lastBounds = window.getBounds();
        }
      } catch {
        // Ignore errors during shutdown
      }
    });

    // Handle window close
    // Wrapped in try-catch to prevent errors during shutdown from stalling the quit sequence.
    // During app.quit(), windows close concurrently and some may already be destroyed.
    window.on('closed', () => {
      try {
        const windowData = windowRegistry.get(windowId);

        // Clean up IZUI coordinator state
        const coordinator = getIzuiCoordinator();
        coordinator.clearFocusedWindow(windowId);

        // Clear stale lastFocusedVisibleWindowId so getFocusedVisibleWindowId()
        // doesn't return a closed window's ID (causes wrong window targeting)
        clearLastFocusedVisibleWindowId(windowId);

        // Focus parent window if this was a child
        if (windowData && windowData.params.parentWindowId) {
          const parentId = windowData.params.parentWindowId as number;
          const parentWin = BrowserWindow.fromId(parentId);
          if (parentWin && !parentWin.isDestroyed()) {
            DEBUG && console.log('[izui] Child window closed, focusing parent:', parentId);
            parentWin.focus();
          }
        }

        if (windowData) {
          // Check if this overlay was already handled by the app-blur path.
          // When the user Cmd+Tabs away, did-resign-active calls exitOverlayForAppBlur()
          // (which restores windows without focusing) before closing the overlay window.
          // In that case, skip all overlay restoration logic here.
          const closedDueToAppBlur = (window as any).__closedDueToAppBlur === true;

          // Overlay restoration: use coordinator as single source of truth
          const isOverlayWindow = coordinator.isOverlay() && coordinator.getSession()?.overlayWindowId === windowId;
          if (isOverlayWindow) {
            const session = coordinator.getSession()!;
            const isTransient = coordinator.isTransient();

            if (!isTransient) {
              // Get focus target BEFORE exitOverlay clears it
              const focusTargetId = session.overlayFocusTarget || coordinator.getPreOverlayFocusTarget();

              // exitOverlay restores hidden windows and resets overlay state
              coordinator.exitOverlay();

              // Focus the target window after restoration
              if (focusTargetId) {
                const targetWin = BrowserWindow.fromId(focusTargetId);
                if (targetWin && !targetWin.isDestroyed()) {
                  DEBUG && console.log('[izui] Overlay focus target:', focusTargetId, session.overlayFocusTarget ? '(explicit selection)' : '(pre-overlay fallback)');
                  targetWin.focus();
                }
              }
            } else {
              DEBUG && console.log('[izui] Overlay closed in transient mode - not restoring windows');
            }

            // Pop AFTER exitOverlay — order matters to avoid premature session end
            coordinator.popWindow(windowId);
          } else if (closedDueToAppBlur) {
            // App-blur path already handled restoration via exitOverlayForAppBlur().
            // Just pop the window from the stack — no focus, no restoration needed.
            DEBUG && console.log('[izui] Overlay closed due to app blur — skipping restoration (already handled)');
            coordinator.popWindow(windowId);
          } else {
            // Fallback: ad-hoc overlay restoration for non-coordinator path (backward compat)
            const hiddenWindowIds = windowData.params.overlayHiddenWindows as number[] | undefined;
            const isTransient = windowData.params.transient === true;
            if (hiddenWindowIds && hiddenWindowIds.length > 0 && !isTransient) {
              DEBUG && console.log('[izui] Overlay closed (fallback path), restoring', hiddenWindowIds.length, 'windows');
              for (const hiddenId of hiddenWindowIds) {
                const hiddenWin = BrowserWindow.fromId(hiddenId);
                if (hiddenWin && !hiddenWin.isDestroyed()) {
                  hiddenWin.show();
                }
              }
              const focusTargetId = windowData.params.overlayFocusTarget as number | undefined;
              const preOverlayTarget = coordinator.getPreOverlayFocusTarget();
              const restoreFocusId = focusTargetId || preOverlayTarget;
              if (restoreFocusId) {
                const targetWin = BrowserWindow.fromId(restoreFocusId);
                if (targetWin && !targetWin.isDestroyed()) {
                  targetWin.focus();
                }
              }
            } else if (isTransient && hiddenWindowIds && hiddenWindowIds.length > 0) {
              DEBUG && console.log('[izui] Overlay closed in transient mode (fallback) - not restoring windows');
            }

            // Pop window for non-overlay path
            coordinator.popWindow(windowId);
          }

          publish(windowData.source, scopes.GLOBAL, 'window:closed', {
            id: windowId,
            source: windowData.source
          });

          // Save to closed window stack for reopen-last-closed
          // Only save user-facing content windows with web URLs (not background, modals, palettes, etc.)
          // Skip during quit — session.ts already pushes all open windows during before-quit,
          // so pushing here too would create duplicates that shadow session-restored windows.
          if (!_suppressClosedWindowPush) {
            const address = windowData.params.address as string | undefined;
            const role = windowData.params.role as string | undefined;
            const isKeepLive = windowData.params.keepLive === true;
            const isModal = windowData.params.modal === true;
            const isWebUrl = address && (address.startsWith('http://') || address.startsWith('https://'));
            const isPeekUrl = address && (address.startsWith('peek://ext/') || address.startsWith('peek://app/'));
            const isBackgroundPage = address && (address.includes('background.html') || address.includes('extension-host.html'));
            const isReopenable = (isWebUrl || (isPeekUrl && !isBackgroundPage)) && !!address;
            const isContentRole = !role || role === 'content' || role === 'child-content' || role === 'workspace';

            if (isReopenable && isContentRole && !isKeepLive && !isModal) {
              // Check for space mode context
              let spaceMode: ClosedWindowEntry['spaceMode'] = null;
              try {
                const modeEntry = getContextEntry('mode', windowId);
                if (modeEntry && modeEntry.value === 'space' && modeEntry.metadata) {
                  spaceMode = {
                    spaceId: modeEntry.metadata.spaceId as string,
                    spaceName: modeEntry.metadata.spaceName as string,
                    color: modeEntry.metadata.color as string | undefined,
                  };
                }
              } catch {
                // Context may be cleaned up already during shutdown
              }

              // For canvas pages, convert window bounds back to webview bounds
              // (window-open will re-add canvas margins when reopening)
              let saveBounds = lastBounds;
              if (lastBounds && isWebUrl) {
                const CANVAS_MARGIN = 8;
                const CANVAS_TRIGGER_ZONE = 8;
                const CANVAS_NAVBAR_HEIGHT = 36;
                saveBounds = {
                  x: lastBounds.x + CANVAS_MARGIN,
                  y: lastBounds.y + CANVAS_TRIGGER_ZONE + CANVAS_NAVBAR_HEIGHT,
                  width: lastBounds.width - CANVAS_MARGIN * 2,
                  height: lastBounds.height - CANVAS_TRIGGER_ZONE - CANVAS_MARGIN - CANVAS_NAVBAR_HEIGHT,
                };
              }

              // Use the current navigated URL if available (tracks where user actually was)
              const currentUrl = windowData.params.currentUrl as string | undefined;
              const scrollX = windowData.params.scrollX as number | undefined;
              const scrollY = windowData.params.scrollY as number | undefined;

              pushClosedWindow({
                url: currentUrl || address,
                originalUrl: currentUrl ? address : undefined,
                source: windowData.source,
                bounds: saveBounds,
                spaceMode,
                role: role || undefined,
                scrollX: scrollX || undefined,
                scrollY: scrollY || undefined,
                timestamp: Date.now(),
              });
            }
          }
        }

        windowRegistry.delete(windowId);
      } catch (err) {
        // During shutdown, errors here must not prevent the quit sequence
        DEBUG && console.error('[lifecycle] Error in window closed handler:', err);
        windowRegistry.delete(windowId);
      }
    });

    // Handle local shortcuts (with window ID for mode-conditional shortcuts)
    window.webContents.on('before-input-event', (event, input) => {
      // Page host windows (canvas) have their own Cmd+L handler for the floating navbar
      // (registered in openWindow). Skip local shortcut handling for Cmd+L on those windows
      // so the page host's before-input-event handler can handle it instead.
      if (input.type === 'keyDown' && input.key === 'l') {
        const mod = process.platform === 'darwin' ? input.meta : input.control;
        if (mod && !input.alt && !input.shift) {
          const winInfo = getWindowInfo(windowId);
          const addr = winInfo?.params?.address as string | undefined;
          if (addr && (addr.startsWith('http://') || addr.startsWith('https://') || addr.startsWith('file:///'))) {
            return; // Let the page host's own handler deal with Cmd+L
          }
        }
      }

      if (handleLocalShortcut(input, windowId)) {
        event.preventDefault();
      }
    });
  });
}

/**
 * Discover and register built-in extensions
 */
export function discoverBuiltinExtensions(extensionsDir: string): void {
  const discovered = discoverExtensions(extensionsDir);
  for (const ext of discovered) {
    registerExtensionPath(ext.id, ext.path);
  }
}

// Track extensions with declarative-only commands (no background page needed)
const declarativeExtensions = new Set<string>();

/**
 * Check if an extension has background: false in its manifest,
 * meaning it only uses declarative commands/shortcuts and doesn't need
 * a background page.
 */
export function isDeclarativeOnly(extId: string): boolean {
  return declarativeExtensions.has(extId);
}

/**
 * Register declarative commands and shortcuts from extension manifests.
 *
 * Called after cmd extension is loaded (so the command registry is ready).
 * Extensions with `"background": false` in their manifest declare commands
 * and shortcuts in the manifest itself. The main process registers them
 * directly without creating a background page.
 *
 * Supported action types:
 * - "window": Open a window with the specified URL
 * - "publish": Publish a pubsub message
 */
export function registerDeclarativeCommands(): void {
  const registeredExtIds = getRegisteredExtensionIds();

  for (const extId of registeredExtIds) {
    if (!isBuiltinExtensionEnabled(extId)) continue;

    const extPath = getExtensionPath(extId);
    if (!extPath) continue;

    const manifest = loadExtensionManifest(extPath);
    if (!manifest) continue;

    // Only process extensions that explicitly opt out of background pages
    if (manifest.background !== false) continue;

    const commands = manifest.commands || [];
    const shortcuts = manifest.shortcuts || [];

    if (commands.length === 0 && shortcuts.length === 0) continue;

    DEBUG && console.log(`[ext:declarative] Registering declarative commands for ${extId}: ${commands.length} commands, ${shortcuts.length} shortcuts`);

    // Mark this extension as declarative-only
    declarativeExtensions.add(extId);

    // Register each command
    for (const cmd of commands) {
      registerDeclarativeCommand(extId, cmd);
    }

    // Register each shortcut
    for (const shortcut of shortcuts) {
      registerDeclarativeShortcut(extId, shortcut, commands);
    }
  }
}

/**
 * Register a single declarative command.
 * Sets up a pubsub subscription for cmd:execute:{name} and publishes
 * the command metadata to the cmd registry.
 */
function registerDeclarativeCommand(extId: string, cmd: ManifestCommand): void {
  const source = `peek://ext/${extId}/`;

  // Subscribe to execution requests from the cmd panel
  subscribe(source, scopes.GLOBAL, `cmd:execute:${cmd.name}`, (msg: unknown) => {
    DEBUG && console.log(`[ext:declarative] Executing command: ${cmd.name}`);
    executeDeclarativeAction(cmd, msg as Record<string, unknown>);
    // Signal completion so the cmd panel proxy resolves immediately
    // (publish-type actions are fire-and-forget — don't block the UI)
    publish(source, scopes.GLOBAL, `cmd:execute:${cmd.name}:result`, { success: true });
  });

  // Register the command with the cmd extension's registry
  publish(source, scopes.GLOBAL, 'cmd:register', {
    name: cmd.name,
    description: cmd.description || '',
    source,
    scope: cmd.scope || 'global',
    modes: cmd.modes || [],
  });

  DEBUG && console.log(`[ext:declarative] Registered command: ${cmd.name} (${cmd.action.type})`);
}

/**
 * Register a single declarative shortcut.
 * Maps the shortcut keys to execute the associated command's action.
 */
function registerDeclarativeShortcut(extId: string, shortcut: ManifestShortcut, commands: ManifestCommand[]): void {
  const source = `peek://ext/${extId}/`;

  // Find the associated command
  const cmd = commands.find(c => c.name === shortcut.command);
  if (!cmd) {
    console.error(`[ext:declarative] Shortcut references unknown command: ${shortcut.command} in ${extId}`);
    return;
  }

  const callback = () => {
    DEBUG && console.log(`[ext:declarative] Shortcut triggered: ${shortcut.keys} -> ${shortcut.command}`);
    if (cmd.action.type === 'execute') {
      // For execute-type commands, publish to cmd:execute so lazy stubs can intercept
      publish(`peek://ext/${extId}/`, scopes.GLOBAL, `cmd:execute:${cmd.name}`, {});
    } else {
      executeDeclarativeAction(cmd, {});
    }
  };

  if (shortcut.global) {
    registerGlobalShortcut(shortcut.keys, source, callback);
  } else {
    const modeConditions = shortcut.mode ? { majorMode: shortcut.mode as any } : undefined;
    registerLocalShortcut(shortcut.keys, source, callback, modeConditions);
  }

  DEBUG && console.log(`[ext:declarative] Registered ${shortcut.global ? 'global' : 'local'} shortcut: ${shortcut.keys} -> ${shortcut.command}`);
}

/**
 * Execute a declarative command action.
 */
function executeDeclarativeAction(cmd: ManifestCommand, ctx: Record<string, unknown>): void {
  const action = cmd.action;

  switch (action.type) {
    case 'window': {
      // Open a window with the specified URL
      const url = action.url;
      const options = action.options || {};
      DEBUG && console.log(`[ext:declarative] Opening window: ${url}`);

      // Use window:reopen-request which app/index.js already handles
      // (creates a window via windowManager.createWindow)
      publish(getSystemAddress(), scopes.GLOBAL, 'window:reopen-request', {
        url,
        options: {
          ...options,
          trackingSource: 'declarative',
          trackingSourceId: cmd.name,
        },
      });
      break;
    }

    case 'publish': {
      // Publish a pubsub message
      const topic = action.topic;
      const data = { ...(action.data || {}), ...ctx };
      DEBUG && console.log(`[ext:declarative] Publishing: ${topic}`);
      publish(getSystemAddress(), scopes.GLOBAL, topic, data);
      break;
    }

    default: {
      console.error(`[ext:declarative] Unknown action type: ${(action as any).type}`);
    }
  }
}

/**
 * Load a lazy extension on demand.
 * Sends ext:lazy-load to the extension host and waits for ext:lazy-ready.
 * Returns a promise that resolves when the extension is loaded and ready.
 */
const LAZY_LOAD_TIMEOUT_MS = 10000;

function loadLazyExtension(extId: string): Promise<void> {
  if (lazyExtensionLoaded.has(extId)) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    // Queue the callback
    if (!lazyLoadCallbacks.has(extId)) {
      lazyLoadCallbacks.set(extId, []);
    }
    lazyLoadCallbacks.get(extId)!.push(resolve);

    // Only send load request once (first callback triggers it)
    if (lazyLoadCallbacks.get(extId)!.length === 1) {
      // Safety timeout: if ext:ready never arrives, resolve all callbacks
      setTimeout(() => {
        if (lazyExtensionLoaded.has(extId)) return; // Already resolved normally
        console.error(`[ext:lazy] Timeout waiting for ext:ready from ${extId} (${LAZY_LOAD_TIMEOUT_MS}ms)`);
        lazyExtensionLoaded.add(extId);
        loadedConsolidatedExtensions.add(extId);
        const callbacks = lazyLoadCallbacks.get(extId) || [];
        lazyLoadCallbacks.delete(extId);
        for (const cb of callbacks) {
          cb();
        }
      }, LAZY_LOAD_TIMEOUT_MS);

      if (extensionHostWindow && !extensionHostWindow.isDestroyed()) {
        DEBUG && console.log(`[ext:lazy] Loading lazy extension: ${extId}`);
        // Create iframe directly via executeJavaScript (bypasses IPC/contextBridge)
        extensionHostWindow.webContents.executeJavaScript(`
          (function() {
            if (document.getElementById('ext-${extId}')) return;
            var iframe = document.createElement('iframe');
            iframe.src = 'peek://${extId}/background.html';
            iframe.id = 'ext-${extId}';
            document.getElementById('extensions').appendChild(iframe);
          })();
        `).catch((err) => {
          console.error(`[ext:lazy] Failed to create iframe for ${extId}:`, err);
        });
      } else {
        console.error(`[ext:lazy] Extension host not available for lazy loading: ${extId}`);
        resolve(); // Resolve anyway to avoid hanging
      }
    }
  });
}

/**
 * Get the expected pubsub topics for an extension's execute-type commands.
 */
function getExpectedCommandTopics(extId: string): string[] {
  const extPath = getExtensionPath(extId);
  if (!extPath) return [];
  const manifest = loadExtensionManifest(extPath);
  if (!manifest) return [];
  return (manifest.commands || [])
    .filter((cmd: ManifestCommand) => cmd.action.type === 'execute')
    .map((cmd: ManifestCommand) => `cmd:execute:${cmd.name}`);
}

function handleLazyExtensionReady(extId: string, registeredTopics?: string[]): void {
  lazyExtensionLoaded.add(extId);
  loadedConsolidatedExtensions.add(extId);

  const callbacks = lazyLoadCallbacks.get(extId) || [];
  lazyLoadCallbacks.delete(extId);

  // Assert-and-trust: verify subscribers are registered, log errors but resolve immediately
  const expectedTopics = getExpectedCommandTopics(extId);
  if (expectedTopics.length > 0) {
    const missing = expectedTopics.filter(t => !hasSubscriber(t, undefined, 'lazy-stub/'));
    if (missing.length > 0) {
      // Cross-check with registeredTopics from the extension if provided
      if (registeredTopics && registeredTopics.length > 0) {
        const extMissing = expectedTopics.filter(t => !registeredTopics.includes(t));
        if (extMissing.length > 0) {
          console.error(`[ext:lazy] Extension ${extId} did not register expected topics: ${extMissing.join(', ')}`);
        }
      }
      console.error(`[ext:lazy] Extension ${extId} ready but missing subscribers: ${missing.join(', ')}`);
    }
  }

  DEBUG && console.log(`[ext:lazy] Extension ${extId} ready, resolving ${callbacks.length} callbacks`);

  // Resolve immediately — the extension said it's ready, trust it
  for (const cb of callbacks) {
    cb();
  }
}

/**
 * Register a lazy command stub.
 * When the command is invoked, the extension is loaded first, then the
 * command is re-published for the extension's own handler to pick up.
 */
// Track pending messages for lazy command stubs (cmd name -> buffered msg)
const lazyCommandPending = new Map<string, unknown>();

function registerLazyCommand(extId: string, cmd: ManifestCommand): void {
  const stubSource = `lazy-stub/${cmd.name}`;
  const topic = `cmd:execute:${cmd.name}`;

  subscribe(stubSource, scopes.GLOBAL, topic, async (msg: unknown) => {
    // Extension already loaded — forward directly and clean up
    if (lazyExtensionLoaded.has(extId)) {
      unsubscribe(stubSource, topic);
      publish(stubSource, scopes.GLOBAL, topic, msg);
      return;
    }

    // Buffer the message (latest wins for concurrent invocations)
    const alreadyLoading = lazyCommandPending.has(cmd.name);
    lazyCommandPending.set(cmd.name, msg);

    if (alreadyLoading) {
      return;
    }

    DEBUG && console.log(`[ext:lazy] Lazy command invoked: ${cmd.name}, loading extension: ${extId}`);
    await loadLazyExtension(extId);

    // Unsubscribe stub and replay buffered message exactly once
    unsubscribe(stubSource, topic);
    const bufferedMsg = lazyCommandPending.get(cmd.name);
    lazyCommandPending.delete(cmd.name);
    DEBUG && console.log(`[ext:lazy] Extension ${extId} loaded, re-publishing command: ${cmd.name}`);
    publish(stubSource, scopes.GLOBAL, topic, bufferedMsg);
  });

  // Register the command metadata with the cmd registry
  const extSource = `peek://ext/${extId}/`;
  publish(extSource, scopes.GLOBAL, 'cmd:register', {
    name: cmd.name,
    description: cmd.description || '',
    source: extSource,
    scope: cmd.scope || 'global',
    modes: cmd.modes || [],
    accepts: cmd.accepts || [],
    produces: cmd.produces || [],
    params: cmd.params || [],
  });

  DEBUG && console.log(`[ext:lazy] Registered lazy command: ${cmd.name} (extension: ${extId})`);
}

/**
 * Register declarative commands and shortcuts from lazy extension manifests.
 * For extensions marked as lazy, registers command stubs that load the extension
 * on first use. For declarative actions (window/publish), registers them directly.
 */
export function registerLazyExtensionCommands(): void {
  const registeredExtIds = getRegisteredExtensionIds();

  for (const extId of registeredExtIds) {
    if (!isBuiltinExtensionEnabled(extId)) continue;
    if (declarativeExtensions.has(extId)) continue; // Already declarative (background: false)

    const extPath = getExtensionPath(extId);
    if (!extPath) continue;

    const manifest = loadExtensionManifest(extPath);
    if (!manifest) continue;

    // Only process consolidated extensions that have declared commands
    if (!CONSOLIDATED_EXTENSION_IDS.includes(extId)) continue;
    const commands = manifest.commands || [];
    const shortcuts = manifest.shortcuts || [];
    if (commands.length === 0 && shortcuts.length === 0) continue;

    // Eager extensions: register manifest shortcuts only (they handle their own commands)
    if (EAGER_EXTENSION_IDS.has(extId)) {
      DEBUG && console.log(`[ext:eager] Registering manifest shortcuts for ${extId}: ${shortcuts.length} shortcuts`);
      for (const shortcut of shortcuts) {
        registerDeclarativeShortcut(extId, shortcut, commands);
      }
      continue;
    }

    DEBUG && console.log(`[ext:lazy] Registering lazy commands for ${extId}: ${commands.length} commands, ${shortcuts.length} shortcuts`);

    for (const cmd of commands) {
      if (cmd.action.type === 'execute') {
        // Execute type: register a lazy stub that loads the extension on first use
        registerLazyCommand(extId, cmd);
      } else {
        // Window/publish type: register declaratively (no extension loading needed)
        registerDeclarativeCommand(extId, cmd);
      }
    }

    for (const shortcut of shortcuts) {
      registerDeclarativeShortcut(extId, shortcut, commands);
    }
  }
}

/**
 * Register pubsub interceptors for lazy extension events.
 * Some events (like editor:open) are published by the cmd panel before
 * the target extension is loaded. These interceptors ensure the extension
 * is loaded first, then re-publish the event so the extension receives it.
 */
// Track pending messages for lazy event interceptors (topic -> buffered msg)
const lazyInterceptorPending = new Map<string, unknown>();

export function registerLazyEventInterceptors(options?: { skipExtensions?: Set<string> }): void {
  const skip = options?.skipExtensions;

  // Legacy v1 editor interceptors. Under v2, editor is handled by the
  // tile-lazy event interceptor system (see registerEventInterceptor in
  // tile-lazy.ts), so we skip registering v1 stubs for it here.
  if (!skip || !skip.has('editor')) {
    const editorEvents = ['editor:open', 'editor:add'];

    for (const topic of editorEvents) {
      const interceptorSource = `lazy-interceptor/${topic}`;

      subscribe(interceptorSource, scopes.GLOBAL, topic, async (msg: unknown) => {
        // If editor is already loaded, nothing to do — the extension's own handler
        // will fire from the same publish (pubsub iterates all subscribers).
        if (lazyExtensionLoaded.has('editor')) return;

        // Buffer the message (latest wins for concurrent events)
        const alreadyLoading = lazyInterceptorPending.has(topic);
        lazyInterceptorPending.set(topic, msg);

        if (alreadyLoading) {
          DEBUG && console.log(`[ext:lazy-interceptor] ${topic} fired again during load, buffering`);
          return;
        }

        DEBUG && console.log(`[ext:lazy-interceptor] ${topic} fired but editor not loaded, loading...`);
        await loadLazyExtension('editor');

        // Unsubscribe and replay buffered message exactly once
        unsubscribe(interceptorSource, topic);
        const bufferedMsg = lazyInterceptorPending.get(topic);
        lazyInterceptorPending.delete(topic);
        DEBUG && console.log(`[ext:lazy-interceptor] Editor loaded, re-publishing ${topic}`);
        publish(interceptorSource, scopes.GLOBAL, topic, bufferedMsg);
      });
    }

    DEBUG && console.log('[ext:lazy-interceptor] Registered editor event interceptors');
  } else {
    DEBUG && console.log('[ext:lazy-interceptor] Editor is v2 — skipping legacy interceptor');
  }
}

/**
 * Required CSS variables that every theme must define.
 * Used by validateThemeCSS() to verify theme completeness.
 */
const REQUIRED_THEME_VARIABLES = [
  // Base16 colors
  '--base00', '--base01', '--base02', '--base03',
  '--base04', '--base05', '--base06', '--base07',
  '--base08', '--base09', '--base0A', '--base0B',
  '--base0C', '--base0D', '--base0E', '--base0F',
  // Semantic aliases
  '--theme-bg', '--theme-bg-secondary', '--theme-bg-tertiary',
  '--theme-text', '--theme-text-secondary', '--theme-text-muted',
  '--theme-border', '--theme-accent',
  '--theme-success', '--theme-warning', '--theme-danger',
  // Surface tokens
  '--theme-surface-border', '--theme-surface-ring',
  // Typography
  '--theme-font-sans', '--theme-font-mono',
];

/**
 * Validate that a theme CSS file defines all required variables.
 * Returns { valid: true } or { valid: false, missing: string[] }
 */
export function validateThemeCSS(cssPath: string): { valid: boolean; missing?: string[] } {
  if (!fs.existsSync(cssPath)) {
    return { valid: false, missing: REQUIRED_THEME_VARIABLES };
  }

  const css = fs.readFileSync(cssPath, 'utf-8');
  const missing = REQUIRED_THEME_VARIABLES.filter(v => !css.includes(v));

  if (missing.length > 0) {
    return { valid: false, missing };
  }
  return { valid: true };
}

/**
 * Discover and register built-in themes.
 * Scans the extensions directory for manifests with "type": "theme".
 * Also scans a legacy themes directory for backward compatibility.
 */
export function discoverBuiltinThemes(extensionsDir: string, legacyThemesDir?: string): void {
  // Scan extensions directory for theme-type extensions
  if (fs.existsSync(extensionsDir)) {
    const entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const themePath = path.join(extensionsDir, entry.name);
      const manifestPath = path.join(themePath, 'manifest.json');

      if (!fs.existsSync(manifestPath)) continue;

      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

        // Only register extensions with type: "theme"
        if (manifest.type !== 'theme') continue;

        const themeId = manifest.id || entry.name;

        // Validate theme CSS on discovery
        const variablesFile = manifest.variables || './variables.css';
        const cssPath = path.join(themePath, variablesFile.replace(/^\.\//, ''));
        const validation = validateThemeCSS(cssPath);
        if (!validation.valid) {
          console.warn(`[theme] Theme ${themeId} missing required variables:`, validation.missing);
          // Still register it — warn but don't block built-in themes
        }

        registerThemePath(themeId, themePath);
        DEBUG && console.log('Discovered theme extension:', themeId);
      } catch (err) {
        console.error('Failed to load theme manifest:', entry.name, err);
      }
    }
  }

  // Legacy fallback: scan old themes/ directory for themes not yet migrated
  if (legacyThemesDir && fs.existsSync(legacyThemesDir)) {
    const entries = fs.readdirSync(legacyThemesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const themePath = path.join(legacyThemesDir, entry.name);
      const manifestPath = path.join(themePath, 'manifest.json');

      if (!fs.existsSync(manifestPath)) continue;

      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const themeId = manifest.id || entry.name;

        // Skip if already registered from extensions directory
        if (getRegisteredThemeIds().includes(themeId)) {
          DEBUG && console.log('Theme already registered from extensions, skipping legacy:', themeId);
          continue;
        }

        registerThemePath(themeId, themePath);
        DEBUG && console.log('Discovered legacy theme:', themeId);
      } catch (err) {
        console.error('Failed to load legacy theme manifest:', entry.name, err);
      }
    }
  }
}

/**
 * Create an extension window
 */
export async function createExtensionWindow(extId: string): Promise<BrowserWindow | null> {
  if (extensionWindows.has(extId)) {
    DEBUG && console.log(`[ext:win] Extension ${extId} already has a window`);
    return extensionWindows.get(extId)!.win;
  }

  const extPath = getExtensionPath(extId);
  if (!extPath) {
    console.error(`[ext:win] Extension path not found: ${extId}`);
    return null;
  }

  const manifest = loadExtensionManifest(extPath);

  DEBUG && console.log(`[ext:win] Creating window for extension: ${extId}`);

  // Use profile-specific session for isolation
  const profileSession = getProfileSession();

  const win = new BrowserWindow({
    show: false,
    backgroundColor: getSystemThemeBackgroundColor(),
    webPreferences: {
      preload: config.preloadPath,
      session: profileSession,
      // Disable same-origin policy so extensions can fetch() cross-origin.
      // These windows only load trusted extension code (peek://ext/{id}/...) —
      // never user-provided URLs. corsEnabled:false on the scheme isn't sufficient
      // for peek://ext origins (only peek://app gets implicit cross-origin access).
      webSecurity: false,
    }
  });

  // Forward console logs
  win.webContents.on('console-message', (event) => {
    DEBUG && console.log(`[ext:${extId}] ${event.message}`);
  });

  // Track crashes
  win.webContents.on('render-process-gone', (event, details) => {
    console.error(`[ext:win] Extension ${extId} crashed (reason: ${details.reason})`);
    const entry = extensionWindows.get(extId);
    if (entry) {
      entry.status = 'crashed';
    }
  });

  // Track close
  win.on('closed', () => {
    DEBUG && console.log(`[ext:win] Extension ${extId} window closed`);
    extensionWindows.delete(extId);
  });

  extensionWindows.set(extId, { win, manifest, status: 'loading' });

  try {
    await win.loadURL(`peek://ext/${extId}/background.html`);
    DEBUG && console.log(`[ext:win] Extension ${extId} loaded successfully`);
    const entry = extensionWindows.get(extId);
    if (entry) {
      entry.status = 'running';
    }

    // Open devtools for extension in debug mode (not in tests or headless)
    if (config.isDev && !isTestProfile() && !isHeadless()) {
      win.webContents.openDevTools({ mode: 'detach', activate: false });
    }

    return win;
  } catch (error) {
    console.error(`[ext:win] Failed to load extension ${extId}:`, error);
    extensionWindows.delete(extId);
    win.destroy();
    return null;
  }
}

/**
 * Load all enabled extensions with startup phases for optimization
 *
 * Startup phases allow extensions to defer work:
 * - 'early': cmd loads first (it's the command registry)
 * - 'commands': other extensions load, should register commands
 * - 'ui': extensions can initialize UI elements
 * - 'complete': all extensions loaded
 */
export async function loadEnabledExtensions(): Promise<number> {
  const extStart = Date.now();
  const builtinExtIds = getRegisteredExtensionIds();

  // Phase 1: Early
  // Note: cmd (command registry) is no longer loaded here — it's core app code
  // loaded via initCmd() from cmd-glue.ts in the main loadExtensions() path.
  // This alternate loader (loadEnabledExtensions) creates a standalone window
  // per extension, which is NOT how cmd runs — so no cmd handling here.
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'early' });

  // Phase 2: Commands - other extensions should register commands
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'commands' });

  // Register declarative commands/shortcuts from manifests (after cmd is ready)
  registerDeclarativeCommands();

  // Load built-in extensions in parallel (skip declarative-only)
  const enabledBuiltinIds = builtinExtIds.filter(id => isBuiltinExtensionEnabled(id) && !isDeclarativeOnly(id));

  const parallelStart = Date.now();
  await Promise.allSettled(enabledBuiltinIds.map(id => createExtensionWindow(id)));
  DEBUG && console.log(`[ext:timing] parallel (${enabledBuiltinIds.join(',')}): ${Date.now() - parallelStart}ms`);

  // Load external extensions in parallel
  const externalExts = getExternalExtensions();
  const enabledExternalExts = externalExts.filter(ext => {
    if (extensionWindows.has(ext.id)) return false;
    if (!ext.enabled || !ext.path) return false;
    return true;
  });

  if (enabledExternalExts.length > 0) {
    const extExtStart = Date.now();
    await Promise.allSettled(enabledExternalExts.map(ext => createExtensionWindow(ext.id)));
    DEBUG && console.log(`[ext:timing] external: ${Date.now() - extExtStart}ms`);
  }

  DEBUG && console.log(`[ext:timing] total: ${Date.now() - extStart}ms`);

  // Phase 3: UI - extensions can now initialize UI elements
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'ui' });

  // Phase 4: Complete - all extensions loaded
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'complete' });
  publish('system', scopes.GLOBAL, 'ext:all-loaded', {
    count: extensionWindows.size
  });

  return extensionWindows.size;
}

/**
 * Create the consolidated extension host window
 * All extensions load as iframes within this single window
 */
async function createExtensionHostWindow(): Promise<BrowserWindow> {
  DEBUG && console.log('[ext:host] Creating consolidated extension host window');

  // Use profile-specific session for isolation
  const profileSession = getProfileSession();

  const win = new BrowserWindow({
    show: false,
    backgroundColor: getSystemThemeBackgroundColor(),
    webPreferences: {
      preload: config.preloadPath,
      session: profileSession,
      nodeIntegrationInSubFrames: true,  // Preload runs in iframes too
      // Disable same-origin policy so extension iframes can fetch() cross-origin.
      // Required by entities extension which fetches page content for extraction.
      // All iframes only load trusted extension code (peek://ext/{id}/...).
      webSecurity: false,
    }
  });

  // Forward console logs from extension host
  win.webContents.on('console-message', (event) => {
    DEBUG && console.log(`[ext:host] ${event.message}`);
  });

  // Log load errors
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`[ext:host] Failed to load: ${errorCode} ${errorDescription}`);
  });

  // Track iframe loading via did-frame-finish-load events
  // This fires for each sub-frame (iframe) when it finishes loading
  win.webContents.on('did-frame-finish-load', (_event, isMainFrame) => {
    if (isMainFrame) return; // Skip the extension host page itself
    // Check all frames to see which extensions have loaded
    try {
      const frames = win.webContents.mainFrame.frames;
      for (const frame of frames) {
        const url = frame.url;
        // Extract extension ID from peek://{extId}/background.html
        const match = url.match(/^peek:\/\/([^/]+)\/background\.html/);
        if (match) {
          const extId = match[1];
          if (!loadedConsolidatedExtensions.has(extId)) {
            loadedConsolidatedExtensions.add(extId);
            DEBUG && console.log(`[ext:host] Frame loaded: ${extId} (${loadedConsolidatedExtensions.size} total)`);

            // Note: lazy extension ready callbacks are resolved via ext:ready pubsub
            // (see subscribe('ext:ready', ...) below), not here — did-frame-finish-load
            // fires before the extension's JS modules have executed and registered handlers.
          }
        }
      }
    } catch (err) {
      // Frame enumeration can fail if window is being destroyed
      DEBUG && console.log('[ext:host] Frame enumeration error:', err);
    }
  });

  await win.loadURL('peek://app/extension-host.html');

  extensionHostWindow = win;

  // Open devtools for extension host in debug mode (not in tests or headless)
  if (config.isDev && !isTestProfile() && !isHeadless()) {
    win.webContents.openDevTools({ mode: 'detach', activate: false });
  }

  return win;
}

/**
 * Load extensions in consolidated mode (single window with iframes)
 */
async function loadExtensionsConsolidated(): Promise<number> {
  const extStart = Date.now();

  // Create the extension host window
  const host = await createExtensionHostWindow();

  // Get all extension IDs to load
  const builtinExtIds = getRegisteredExtensionIds();
  const enabledBuiltinIds = builtinExtIds.filter(id => isBuiltinExtensionEnabled(id));

  // Get external extensions
  const externalExts = getExternalExtensions();
  const enabledExternalIds = externalExts
    .filter(ext => ext.enabled && ext.path)
    .map(ext => ext.id);

  const allExtIds = [...enabledBuiltinIds, ...enabledExternalIds];

  DEBUG && console.log(`[ext:host] Loading ${allExtIds.length} extensions as iframes`);

  // Phase 1: Early
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'early' });

  // Send load commands to extension host
  // Note: cmd (command registry) is no longer loaded here — it's loaded via
  // initCmd() from cmd-glue.ts in the main loadExtensions() path. This
  // alternate loader is kept for compatibility but should NOT be used alongside
  // the main loader without coordinating the cmd init phase.

  // Phase 2: Commands
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'commands' });

  // Register declarative commands/shortcuts from manifests (after cmd is ready)
  registerDeclarativeCommands();

  // Load extensions (skip declarative-only)
  const otherIds = allExtIds.filter(id => !isDeclarativeOnly(id));
  for (const extId of otherIds) {
    host.webContents.send('ext:load', { id: extId, url: `peek://${extId}/background.html` });
  }

  // Wait for iframes to load
  await new Promise(resolve => setTimeout(resolve, 200));

  DEBUG && console.log(`[ext:timing] consolidated total: ${Date.now() - extStart}ms`);

  // Phase 3: UI
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'ui' });

  // Phase 4: Complete
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'complete' });
  publish('system', scopes.GLOBAL, 'ext:all-loaded', { count: allExtIds.length });

  return allExtIds.length;
}

/**
 * Load all enabled extensions (hybrid mode)
 * - Built-in extensions (cmd, groups, peeks, slides) → consolidated (iframes)
 * - External extensions (including example) → separate windows
 */
export async function loadExtensions(): Promise<number> {
  const extStart = Date.now();

  const featuresDir = path.join(config.rootDir, 'features');
  // tsc emits to dist/, not source tree. For dev (`yarn start`) and packaged
  // builds alike, rootDir is the project root, so the compiled preload lives at
  // dist/backend/electron/tile-preload.js.
  const tilePreloadPath = path.join(config.rootDir, 'dist', 'backend', 'electron', 'tile-preload.js');
  const v1FeatureIds = new Set<string>();
  const v2FeatureIds = new Set<string>();

  // Helper: wait for an extension to appear in loadedConsolidatedExtensions.
  const waitForExtLoaded = (extId: string, timeoutMs: number): Promise<void> => {
    return new Promise<void>((resolve) => {
      if (loadedConsolidatedExtensions.has(extId)) { resolve(); return; }
      const interval = setInterval(() => {
        if (loadedConsolidatedExtensions.has(extId)) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve();
        }
      }, 10);
      const timeout = setTimeout(() => {
        clearInterval(interval);
        loadedConsolidatedExtensions.add(extId); // Fallback
        DEBUG && console.log(`[ext] Timeout waiting for ${extId}, marking as loaded (fallback)`);
        resolve();
      }, timeoutMs);
    });
  };

  // Helper: create iframe in extension host via executeJavaScript.
  const loadExtInHost = (host: BrowserWindow, id: string, url: string): void => {
    host.webContents.executeJavaScript(`
      (function() {
        if (document.getElementById('ext-${id}')) return;
        var iframe = document.createElement('iframe');
        iframe.src = '${url}';
        iframe.id = 'ext-${id}';
        document.getElementById('extensions').appendChild(iframe);
      })();
    `).catch((err: Error) => {
      console.error('[ext:host] Failed to create iframe for', id, err);
    });
  };

  // Subscribe to ext:ready — extensions publish this after registering their handlers.
  subscribe(getSystemAddress(), scopes.SYSTEM, 'ext:ready', (data: unknown) => {
    const extId = (data as { id?: string })?.id;
    const registeredTopics = (data as { registeredTopics?: string[] })?.registeredTopics;
    if (extId) {
      handleLazyExtensionReady(extId, registeredTopics);
    }
  });

  // Load the extension host and cmd FIRST — cmd owns the command registry.
  // Any feature that publishes cmd:register or cmd:register-batch must find
  // cmd already subscribed, otherwise registration is lost.
  const host = await createExtensionHostWindow();
  await initCmd({ host, loadExtInHost, waitForExtLoaded });

  // Load HUD right after cmd — it's core app infrastructure like cmd, and
  // registers the `hud` command + CmdOrCtrl+H shortcut via the portable api.
  // loadExtInHost/waitForExtLoaded populates loadedConsolidatedExtensions so
  // getRunningExtensions() still reports hud.
  await initHud({ host, loadExtInHost, waitForExtLoaded });

  // ── V2 Feature Startup ──
  // Run the feature-startup pipeline: discover, sync registry, and load v2 tile manifests.
  // V2 manifests are handled by the tile launcher; v1 manifests fall through to legacy loading below.
  // This runs AFTER initCmd so tile-lazy's cmd:register-batch publishes reach cmd.
  try {
    const featureResult: FeatureStartupResult = initializeFeatures({
      appDataDir: config.userDataPath,
      builtinFeaturesDir: featuresDir,
      tilePreloadPath,
      eagerIds: EAGER_EXTENSION_IDS,
      onV1Feature: (id: string, _featurePath: string, _manifest: unknown) => {
        // Collect v1 feature IDs — they'll be loaded via the legacy path below
        v1FeatureIds.add(id);
      },
    });
    // Track which features the v2 tile system handled — skip these in legacy loading
    for (const r of featureResult.loadResults) {
      if (r.loaded) v2FeatureIds.add(r.id);
    }
    DEBUG && console.log(
      `[ext] Feature startup: ${v2FeatureIds.size} v2 loaded, ` +
      `${v1FeatureIds.size} v1 deferred to legacy loader`
    );
  } catch (err) {
    console.error('[ext] Feature startup failed, falling back to legacy-only loading:', err);
  }

  // Get all registered extension IDs
  const registeredExtIds = getRegisteredExtensionIds();

  // Split into consolidated (built-in) and external — exclude v2 features already loaded by tile system
  const consolidatedIds = registeredExtIds.filter(id =>
    CONSOLIDATED_EXTENSION_IDS.includes(id) && isBuiltinExtensionEnabled(id) && !v2FeatureIds.has(id)
  );
  const externalBuiltinIds = registeredExtIds.filter(id =>
    !CONSOLIDATED_EXTENSION_IDS.includes(id) && isBuiltinExtensionEnabled(id) && !v2FeatureIds.has(id)
  );

  // Get external extensions from datastore
  const externalExts = getExternalExtensions();
  const enabledExternalExts = externalExts.filter(ext => ext.enabled && ext.path);

  DEBUG && console.log(`[ext] Hybrid mode: ${consolidatedIds.length} consolidated, ${externalBuiltinIds.length + enabledExternalExts.length} external`);

  // Phase 1: Early
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'early' });

  // Phase 2: Commands
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'commands' });

  // Register declarative commands/shortcuts from manifests (after cmd is ready)
  registerDeclarativeCommands();

  // Register lazy extension commands from manifests (after cmd is ready)
  registerLazyExtensionCommands();

  // Register event interceptors for lazy extensions (e.g. editor:open).
  // V2 features get their event interceptors from tile-lazy (via manifest
  // `lazyEvents`), so skip them here to avoid duplicate registration that
  // would try to load the v2 tile through the v1 iframe path.
  registerLazyEventInterceptors({ skipExtensions: v2FeatureIds });

  if (consolidatedIds.length > 0) {
    // Load remaining consolidated extensions — skip declarative-only and lazy ones
    const otherConsolidatedIds = consolidatedIds.filter(id =>
      !isDeclarativeOnly(id) && EAGER_EXTENSION_IDS.has(id)
    );
    for (const extId of otherConsolidatedIds) {
      loadExtInHost(host, extId, `peek://${extId}/background.html`);
    }

    // Also load non-eager consolidated extensions that don't have manifest commands
    // (they need their background page to register commands at runtime)
    const nonEagerWithoutManifestCmds = consolidatedIds.filter(id => {
      if (isDeclarativeOnly(id) || EAGER_EXTENSION_IDS.has(id)) return false;
      const extPath = getExtensionPath(id);
      if (!extPath) return false;
      const manifest = loadExtensionManifest(extPath);
      if (!manifest) return false;
      // If no commands declared in manifest, must load eagerly to register its own commands
      return !manifest.commands || manifest.commands.length === 0;
    });
    for (const extId of nonEagerWithoutManifestCmds) {
      loadExtInHost(host, extId, `peek://${extId}/background.html`);
    }

    // Wait for all eager consolidated extensions to load via did-frame-finish-load
    const allEagerIds = [...otherConsolidatedIds, ...nonEagerWithoutManifestCmds];
    if (allEagerIds.length > 0) {
      await Promise.all(allEagerIds.map(id => waitForExtLoaded(id, 10000)));
    }
  }

  // Load external built-in extensions (like 'example') as separate windows
  // Skip declarative-only extensions — they don't need background pages
  for (const extId of externalBuiltinIds) {
    if (isDeclarativeOnly(extId)) continue;
    try { await createExtensionWindow(extId); } catch (e) {
      console.error(`[ext] Failed to load external built-in extension ${extId}:`, e);
    }
  }

  // Load external extensions from datastore as separate windows
  for (const ext of enabledExternalExts) {
    if (!extensionWindows.has(ext.id)) {
      registerExtensionPath(ext.id, ext.path!);
      try { await createExtensionWindow(ext.id); } catch (e) {
        console.error(`[ext] Failed to load external extension ${ext.id}:`, e);
      }
    }
  }

  const totalCount = consolidatedIds.length + externalBuiltinIds.length + enabledExternalExts.length;
  DEBUG && console.log(`[ext:timing] hybrid total: ${Date.now() - extStart}ms`);

  // Phase 3: UI
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'ui' });

  // Phase 4: Complete
  publish('system', scopes.GLOBAL, 'ext:startup:phase', { phase: 'complete' });
  publish('system', scopes.GLOBAL, 'ext:all-loaded', { count: totalCount });

  return totalCount;
}

/**
 * Get running extensions info
 * Includes both consolidated (iframe) and separate window extensions
 */
export function getRunningExtensions(): Array<{ id: string; manifest: unknown; status: string }> {
  const running: Array<{ id: string; manifest: unknown; status: string }> = [];

  // Add consolidated extensions that have actually loaded (in extension host iframes).
  // Iterates loadedConsolidatedExtensions (populated by did-frame-finish-load), which
  // includes both CONSOLIDATED_EXTENSION_IDS features AND core pseudo-extensions like
  // cmd and hud that are loaded by core glue (cmd-glue.ts, hud-glue.ts) rather than
  // by the feature system.
  if (extensionHostWindow && !extensionHostWindow.isDestroyed()) {
    for (const extId of loadedConsolidatedExtensions) {
      if (!isBuiltinExtensionEnabled(extId)) continue;
      const extPath = getExtensionPath(extId);
      const manifest = extPath ? loadExtensionManifest(extPath) : null;
      running.push({
        id: extId,
        manifest: manifest || { id: extId },
        status: 'running'
      });
    }
  }

  // Add separate window extensions
  for (const [extId, entry] of extensionWindows) {
    if (entry.status === 'running') {
      running.push({
        id: extId,
        manifest: entry.manifest,
        status: entry.status
      });
    }
  }

  // Add declarative-only extensions (no background page, but still active)
  for (const extId of declarativeExtensions) {
    // Skip if already included (shouldn't happen, but be safe)
    if (running.some(r => r.id === extId)) continue;

    const extPath = getExtensionPath(extId);
    const manifest = extPath ? loadExtensionManifest(extPath) : null;
    running.push({
      id: extId,
      manifest: manifest || { id: extId },
      status: 'running'
    });
  }

  // Add v2 tiles launched by the tile-launcher as separate BrowserWindows.
  // These aren't in loadedConsolidatedExtensions (that's for iframes in the host)
  // or extensionWindows (that's for legacy external extensions).
  for (const tileId of getLoadedTileIds()) {
    if (running.some(r => r.id === tileId)) continue;
    if (!isBuiltinExtensionEnabled(tileId)) continue;
    const tileManifest = getTileManifest(tileId);
    running.push({
      id: tileId,
      manifest: tileManifest || { id: tileId },
      status: 'running'
    });
  }

  return running;
}

/**
 * Get all registered (discovered) builtin extensions, whether running or not.
 * Used by the Settings Features pane to show ALL extensions from the extensions/ directory.
 */
export function getAllRegisteredExtensions(): Array<{ id: string; manifest: unknown; status: string }> {
  const registeredIds = getRegisteredExtensionIds();
  const result: Array<{ id: string; manifest: unknown; status: string }> = [];

  // Build a set of running extension IDs for status info
  const runningSet = new Set<string>();
  if (extensionHostWindow && !extensionHostWindow.isDestroyed()) {
    for (const extId of CONSOLIDATED_EXTENSION_IDS) {
      if (loadedConsolidatedExtensions.has(extId)) {
        runningSet.add(extId);
      }
    }
  }
  for (const [extId, entry] of extensionWindows) {
    if (entry.status === 'running') {
      runningSet.add(extId);
    }
  }
  for (const extId of declarativeExtensions) {
    runningSet.add(extId);
  }

  for (const extId of registeredIds) {
    const extPath = getExtensionPath(extId);
    const manifest = extPath ? loadExtensionManifest(extPath) : null;
    result.push({
      id: extId,
      manifest: manifest || { id: extId },
      status: runningSet.has(extId) ? 'running' : 'registered'
    });
  }

  return result;
}

/**
 * Destroy an extension window
 */
export function destroyExtensionWindow(extId: string): boolean {
  const entry = extensionWindows.get(extId);
  if (!entry) {
    DEBUG && console.log(`[ext:win] No window to destroy for: ${extId}`);
    return false;
  }

  DEBUG && console.log(`[ext:win] Destroying window for: ${extId}`);

  if (entry.win && !entry.win.isDestroyed()) {
    try {
      entry.win.webContents.send('pubsub:app:shutdown', {});
    } catch {
      // Window may have been destroyed between check and send
    }
    setTimeout(() => {
      if (!entry.win.isDestroyed()) {
        entry.win.destroy();
      }
    }, 100);
  }

  extensionWindows.delete(extId);
  return true;
}

/**
 * Get an extension window
 */
export function getExtensionWindow(extId: string): BrowserWindow | null {
  const entry = extensionWindows.get(extId);
  return entry ? entry.win : null;
}

/**
 * Get the extension host window (for consolidated/builtin extensions)
 */
export function getExtensionHostWindow(): BrowserWindow | null {
  return extensionHostWindow;
}

/**
 * Check if an extension runs in consolidated mode (iframe in host)
 */
export function isConsolidatedExtension(extId: string): boolean {
  return CONSOLIDATED_EXTENSION_IDS.includes(extId);
}

/**
 * Check if an extension is a dev extension (loaded via CLI)
 */
export function isDevExtension(extId: string): boolean {
  return devExtensions.has(extId);
}

/**
 * Register a dev extension path for CLI --load-extension
 * These are transient and not persisted to datastore
 */
export function registerDevExtension(extId: string, extPath: string): void {
  devExtensions.set(extId, { path: extPath });
  // Also register the path so protocol handler can find it
  registerExtensionPath(extId, extPath);
  DEBUG && console.log(`[ext:dev] Registered dev extension: ${extId} from ${extPath}`);
}

/**
 * Load a dev extension with devtools always open
 */
export async function loadDevExtension(extId: string): Promise<BrowserWindow | null> {
  const devExt = devExtensions.get(extId);
  if (!devExt) {
    console.error(`[ext:dev] Dev extension not registered: ${extId}`);
    return null;
  }

  // Create the extension window
  const win = await createExtensionWindow(extId);
  if (!win) {
    return null;
  }

  // Always open devtools for dev extensions (regardless of debug mode)
  if (!isHeadless()) {
    win.webContents.openDevTools({ mode: 'detach', activate: false });
  }

  DEBUG && console.log(`[ext:dev] Loaded dev extension: ${extId}`);
  return win;
}

/**
 * Load all registered dev extensions
 */
export async function loadDevExtensions(): Promise<number> {
  let count = 0;
  for (const [extId] of devExtensions) {
    const win = await loadDevExtension(extId);
    if (win) count++;
  }
  return count;
}

/**
 * Unload and clean up all dev extensions
 */
export function cleanupDevExtensions(): void {
  for (const [extId] of devExtensions) {
    destroyExtensionWindow(extId);
    DEBUG && console.log(`[ext:dev] Cleaned up dev extension: ${extId}`);
  }
  devExtensions.clear();
}

/**
 * Get list of dev extension IDs
 */
export function getDevExtensionIds(): string[] {
  return Array.from(devExtensions.keys());
}

/**
 * Reload an extension by destroying and recreating its window
 * Returns the new window on success, null on failure
 */
export async function reloadExtension(extId: string): Promise<BrowserWindow | null> {
  DEBUG && console.log(`[ext:reload] Reloading extension: ${extId}`);

  // Check if it's a consolidated extension (not supported for reload)
  if (isConsolidatedExtension(extId)) {
    console.error(`[ext:reload] Cannot reload consolidated extension: ${extId} (reload the app instead)`);
    return null;
  }

  // Destroy existing window if any
  const existingEntry = extensionWindows.get(extId);
  if (existingEntry) {
    if (existingEntry.win && !existingEntry.win.isDestroyed()) {
      existingEntry.win.destroy();
    }
    extensionWindows.delete(extId);
  }

  // Small delay to ensure cleanup
  await new Promise(resolve => setTimeout(resolve, 100));

  // For dev extensions, use loadDevExtension to ensure devtools opens
  if (isDevExtension(extId)) {
    return loadDevExtension(extId);
  }

  // For normal extensions, use createExtensionWindow
  return createExtensionWindow(extId);
}

/**
 * Register a window in the registry
 */
export function registerWindow(windowId: number, source: string, params: Record<string, unknown>): void {
  windowRegistry.set(windowId, { source, params });
}

/**
 * Get window info from registry
 */
export function getWindowInfo(windowId: number): { source: string; params: Record<string, unknown> } | undefined {
  return windowRegistry.get(windowId);
}

/**
 * Find a window by source and key
 */
export function findWindowByKey(source: string, key: string): { id: number; window: BrowserWindow; data: unknown } | null {
  if (!key) return null;

  for (const [id, win] of windowRegistry) {
    if (win.source === source && win.params && win.params.key === key) {
      const browserWindow = BrowserWindow.fromId(id);
      if (browserWindow && !browserWindow.isDestroyed()) {
        return { id, window: browserWindow, data: win };
      }
      // Clean up stale registry entry for destroyed/missing window.
      // This happens when Cmd+W or OS close destroys a window but the
      // registry entry wasn't removed (e.g., panel windows on macOS).
      DEBUG && console.log('findWindowByKey: cleaning up stale entry for key:', key, 'windowId:', id);
      windowRegistry.delete(id);
    }
  }
  return null;
}

/**
 * Find an existing page-host window that has the given URL loaded (by address param).
 * Only searches for http/https URLs. Only matches page-host windows (canvas pages
 * with role 'content' or 'child-content'), NOT peeks, slides, modals, or other
 * non-page-host window types.
 */
export function findWindowByUrl(url: string): { id: number; window: BrowserWindow; data: unknown } | null {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return null;

  for (const [id, win] of windowRegistry) {
    if (win.params && win.params.address === url) {
      // Only match page-host windows (canvas pages), not peeks, slides, modals, etc.
      const role = win.params.role;
      if (role !== 'content' && role !== 'child-content') continue;

      const browserWindow = BrowserWindow.fromId(id);
      if (browserWindow && !browserWindow.isDestroyed()) {
        return { id, window: browserWindow, data: win };
      }
    }
  }
  return null;
}

/**
 * Remove a window from the registry
 */
export function removeWindow(windowId: number): boolean {
  return windowRegistry.delete(windowId);
}

/**
 * Get all child windows for a source
 */
export function getChildWindows(source: string): Array<{ id: number; data: { source: string; params: Record<string, unknown> } }> {
  const children = [];
  for (const [id, win] of windowRegistry) {
    if (win.source === source) {
      children.push({ id, data: win });
    }
  }
  return children;
}

/**
 * Get all registered windows
 */
export function getAllWindows(): Array<[number, { source: string; params: Record<string, unknown> }]> {
  return Array.from(windowRegistry.entries());
}

/**
 * Push a closed window entry onto the stack.
 * Persists to DB so the stack survives restarts.
 */
export function pushClosedWindow(entry: ClosedWindowEntry): void {
  closedWindowStack.push(entry);
  if (closedWindowStack.length > MAX_CLOSED_WINDOWS) {
    closedWindowStack.shift();
  }
  DEBUG && console.log('[reopen] Pushed closed window:', entry.url, 'stack size:', closedWindowStack.length);
  saveClosedWindowStack();
}

/**
 * Pop the most recently closed window from the stack.
 * Persists to DB so the stack survives restarts.
 */
export function popClosedWindow(): ClosedWindowEntry | undefined {
  const entry = closedWindowStack.pop();
  DEBUG && console.log('[reopen] Popped closed window:', entry?.url, 'stack size:', closedWindowStack.length);
  saveClosedWindowStack();
  return entry;
}

/**
 * Get the number of closed windows in the stack
 */
export function getClosedWindowCount(): number {
  return closedWindowStack.length;
}

/**
 * Get a copy of the current closed window stack.
 * Used by session save to persist the stack.
 */
export function getClosedWindowStack(): ClosedWindowEntry[] {
  return [...closedWindowStack];
}

/**
 * Save the closed window stack to the datastore (feature_settings table).
 * Synchronous — safe for before-quit handler.
 */
export function saveClosedWindowStack(): void {
  let db;
  try {
    db = getDb();
  } catch {
    return;
  }

  try {
    const data = JSON.stringify(closedWindowStack);
    db.prepare(`
      INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
      VALUES (?, 'session', 'closed-window-stack', ?, ?)
    `).run('session-closed-window-stack', data, Date.now());
    DEBUG && console.log(`[reopen] Saved closed window stack (${closedWindowStack.length} entries)`);
  } catch (error) {
    console.error('[reopen] Failed to save closed window stack:', error);
  }
}

/**
 * Load the closed window stack from the datastore on startup.
 * Replaces the in-memory stack with persisted entries.
 */
export function loadClosedWindowStack(): void {
  let db;
  try {
    db = getDb();
  } catch {
    return;
  }

  try {
    const row = db.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'closed-window-stack'`
    ).get() as { value: string } | undefined;

    if (row?.value) {
      const entries: ClosedWindowEntry[] = JSON.parse(row.value);
      if (Array.isArray(entries)) {
        closedWindowStack.length = 0;
        for (const entry of entries) {
          closedWindowStack.push(entry);
        }
        DEBUG && console.log(`[reopen] Loaded closed window stack (${closedWindowStack.length} entries)`);
      }
    }
  } catch (error) {
    console.error('[reopen] Failed to load closed window stack:', error);
  }
}

/**
 * Shutdown the application
 *
 * Fires the `app:shutdown` pubsub event, then broadcasts `tile:shutdown` to
 * every live v2 tile and waits one grace period so tile `api.onShutdown()`
 * callbacks can run before the BrowserWindows are closed. Finally closes the
 * database.
 *
 * NOTE: entry.ts's `before-quit` handler invokes this without awaiting (that
 * handler is synchronous). We still perform the broadcast+wait synchronously
 * from JS's perspective — the whole sequence is short (TILE_SHUTDOWN_GRACE_MS)
 * and runs on the event loop. Signal paths (SIGINT/SIGTERM) also don't await
 * but call process.exit() immediately after, so tiles may not finish cleanup
 * on abrupt termination — that's expected (grace-period cleanup is
 * best-effort, never guaranteed).
 */
export async function shutdown(): Promise<void> {
  // Publish shutdown event
  publish(getSystemAddress(), scopes.GLOBAL, 'app:shutdown', {
    timestamp: Date.now()
  });

  // Signal every tile and wait for the shared grace period before closing.
  try {
    await unloadAllTiles();
  } catch (err) {
    console.error('[main] unloadAllTiles during shutdown failed:', err);
  }

  // Close database
  closeDatabase();
}

// ***** Background Window *****

let backgroundWindow: BrowserWindow | null = null;

/**
 * Create the core background window
 */
export function createBackgroundWindow(): BrowserWindow {
  const preloadPath = getPreloadPath();
  const systemAddress = getSystemAddress();

  // Use profile-specific session for isolation
  const profileSession = getProfileSession();

  const winPrefs = {
    show: false,
    backgroundColor: getSystemThemeBackgroundColor(),
    key: 'background-core',
    webPreferences: {
      preload: preloadPath,
      session: profileSession,
    }
  };

  // Create the background window
  const win = new BrowserWindow(winPrefs);
  win.loadURL(WEB_CORE_ADDRESS);

  // Forward console logs from background window
  win.webContents.on('console-message', (event) => {
    DEBUG && console.log(`[core] ${event.message}`);
  });

  // Setup devtools for the background window (debug mode, but not in tests or headless)
  if (config.isDev && !isTestProfile() && !isHeadless()) {
    win.webContents.openDevTools({ mode: 'detach', activate: false });
  }

  // Add to window manager
  registerWindow(win.id, systemAddress, { ...winPrefs, address: WEB_CORE_ADDRESS });

  // NOTE: No ESC handler for background window - it should never be closed

  // Set up handlers for windows opened from the background window
  win.webContents.setWindowOpenHandler((details) => {
    DEBUG && console.log('Background window opening child window:', details.url);

    // Parse window features into options
    const featuresMap: Record<string, unknown> = {};
    if (details.features) {
      details.features.split(',')
        .map(entry => entry.split('='))
        .forEach(([key, value]) => {
          let parsedValue: unknown = value;
          // Convert string booleans to actual booleans
          if (value === 'true') parsedValue = true;
          else if (value === 'false') parsedValue = false;
          // Convert numeric values to numbers
          else if (!isNaN(Number(value)) && value.trim() !== '') {
            parsedValue = parseInt(value, 10);
          }
          featuresMap[key] = parsedValue;
        });
    }

    DEBUG && console.log('Parsed features map:', featuresMap);

    // Check if window with this key already exists
    if (featuresMap.key) {
      const existingWindow = findWindowByKey(WEB_CORE_ADDRESS, featuresMap.key as string);
      if (existingWindow) {
        DEBUG && console.log('Reusing existing window with key:', featuresMap.key);
        if (!isHeadless()) {
          existingWindow.window.show();
        }
        return { action: 'deny' as const };
      }
    }

    // Determine frame setting based on explicit option or preference
    let frameDefault = false; // Default to frameless if pref not available
    if (featuresMap.frame === undefined) {
      const prefs = getPrefs();
      // hideTitleBar: true means frame: false (no titlebar)
      // hideTitleBar: false means frame: true (show titlebar)
      frameDefault = prefs.hideTitleBar === false;
    }

    // Prepare browser window options
    // Use profile-specific session for isolation
    const winOptions: Electron.BrowserWindowConstructorOptions = {
      frame: frameDefault, // Default based on hideTitleBar pref
      ...(featuresMap as Electron.BrowserWindowConstructorOptions),
      width: parseInt(String(featuresMap.width)) || APP_DEF_WIDTH,
      height: parseInt(String(featuresMap.height)) || APP_DEF_HEIGHT,
      show: isHeadless() ? false : featuresMap.show !== false,
      // Don't set backgroundColor for transparent windows - it would show through
      backgroundColor: featuresMap.transparent ? undefined : getSystemThemeBackgroundColor(),
      webPreferences: {
        preload: preloadPath,
        session: getProfileSession(),
      }
    };

    // Make sure position parameters are correctly handled
    if (featuresMap.x !== undefined) {
      winOptions.x = parseInt(String(featuresMap.x));
    }
    if (featuresMap.y !== undefined) {
      winOptions.y = parseInt(String(featuresMap.y));
    }

    DEBUG && console.log('Background window creating child with options:', winOptions);

    // Make sure we register browser window created handler to track the new window
    const onCreated = (_e: Electron.Event, newWin: BrowserWindow) => {
      // Check if this is the window we just created
      newWin.webContents.once('did-finish-load', () => {
        const loadedUrl = newWin.webContents.getURL();
        if (loadedUrl === details.url) {
          // Remove the listener
          app.removeListener('browser-window-created', onCreated);

          // Add the window to our manager with necessary parameters
          registerWindow(newWin.id, WEB_CORE_ADDRESS, {
            ...featuresMap,
            address: details.url,
            modal: featuresMap.modal
          });

          // Track this load in history
          try {
            trackWindowLoad(details.url, {
              source: (featuresMap.trackingSource as string) || 'background',
              sourceId: (featuresMap.trackingSourceId as string) || '',
              windowType: featuresMap.modal ? 'modal' : 'main',
              title: (newWin.getTitle() !== 'Loading...' ? newWin.getTitle() : '') || '',
            });
          } catch (e) {
            DEBUG && console.log('Failed to track background child window load:', e);
          }

          // Set initial mode based on URL
          updateModeForNavigation(newWin.id, details.url);

          // Update item title when page finishes loading (background child windows).
          // Without this, titles stay empty or "Loading..." in history.
          if (details.url.startsWith('http://') || details.url.startsWith('https://')) {
            newWin.webContents.on('page-title-updated', (_event: Electron.Event, title: string) => {
              if (title && title !== 'Loading...') {
                try {
                  updateItemTitle(newWin.webContents.getURL() || details.url, title);
                } catch (e) {
                  DEBUG && console.log('Failed to update title from page-title-updated:', e);
                }
              }
            });

            // Capture favicon for background child windows
            newWin.webContents.on('page-favicon-updated', (_event: Electron.Event, favicons: string[]) => {
              const pageUrl = newWin.webContents.getURL() || details.url;
              if (pageUrl && favicons.length > 0) {
                const best = favicons.find(f => f.endsWith('.svg')) ||
                             favicons.find(f => f.endsWith('.png')) ||
                             favicons[favicons.length - 1];
                try {
                  updateItemFavicon(pageUrl, best);
                } catch (e) {
                  DEBUG && console.log('Failed to update favicon from page-favicon-updated:', e);
                }
              }
            });
          }

          // Track in-page navigation within this window
          newWin.webContents.on('did-navigate', (_event: Electron.Event, navUrl: string) => {
            if (navUrl === details.url) return;
            // Update mode for the new URL
            updateModeForNavigation(newWin.id, navUrl);
            try {
              trackWindowLoad(navUrl, {
                source: 'navigation',
                sourceId: '',
                windowType: featuresMap.modal ? 'modal' : 'main',
                title: (newWin.getTitle() !== 'Loading...' ? newWin.getTitle() : '') || '',
              });
            } catch (e) {
              DEBUG && console.log('Failed to track did-navigate:', e);
            }
          });

          // Add escape key handler
          addEscHandler(newWin);

          // Track window for display change handling
          trackWindow(newWin);

          // Set up DevTools if requested
          winDevtoolsConfig(newWin);

          // Set up modal behavior with delay to avoid focus race condition
          if (featuresMap.modal === true) {
            setTimeout(() => {
              if (!newWin.isDestroyed()) {
                newWin.on('blur', () => {
                  DEBUG && console.log('Modal window lost focus:', details.url);
                  closeOrHideWindow(newWin.id);
                });
              }
            }, 100);
          }
        }
      });
    };

    // Start listening for the window creation
    app.on('browser-window-created', onCreated);

    // Return allow with overridden options
    return {
      action: 'allow' as const,
      overrideBrowserWindowOptions: winOptions
    };
  });

  backgroundWindow = win;
  return win;
}

/**
 * Get the background window
 */
export function getBackgroundWindow(): BrowserWindow | null {
  return backgroundWindow;
}

// ***** External URL Handling *****

/**
 * Handle URLs opened from external apps (e.g., when Peek is default browser)
 *
 * URLs are queued until both:
 * 1. The frontend subscriber in app/index.js is ready (frontend-ready IPC)
 * 2. Session restore has completed (so we don't race window creation)
 */
export function handleExternalUrl(url: string, sourceId = 'os'): void {
  urlLog(`handleExternalUrl: url=${url} sourceId=${sourceId} appReady=${_appReady} frontendReady=${_frontendReady} sessionRestoreDone=${_sessionRestoreDone}`);
  DEBUG && console.log('External URL received:', url, 'from:', sourceId);

  if (!_appReady) {
    _pendingUrls.push({ url, sourceId });
    urlLog(`handleExternalUrl: queued (app not ready), pendingUrls=${_pendingUrls.length}`);
    return;
  }

  // If frontend isn't ready yet, queue and wait
  if (!_frontendReady || !_sessionRestoreDone) {
    _pendingUrls.push({ url, sourceId });
    urlLog(`handleExternalUrl: queued (waiting for frontend/session), pendingUrls=${_pendingUrls.length}`);
    DEBUG && console.log('External URL queued (waiting for frontend/session):', url);
    return;
  }

  urlLog(`handleExternalUrl: publishing immediately`);
  publishExternalUrl(url, sourceId);
}

/**
 * Publish a single external URL to the frontend via pubsub
 */
function publishExternalUrl(url: string, sourceId: string): void {
  const processUrl = () => {
    // Note: Using trackingSource/trackingSourceId because preload.js overwrites msg.source
    publish(getSystemAddress(), scopes.GLOBAL, 'external:open-url', {
      url,
      trackingSource: 'external',
      trackingSourceId: sourceId,
      timestamp: Date.now()
    });
  };

  // On macOS, open-url fires during app activation, which can happen before
  // the app is fully focused. Wait a tick to ensure activation completes.
  if (process.platform === 'darwin' && sourceId === 'os') {
    setTimeout(processUrl, 100);
  } else {
    processUrl();
  }
}

/**
 * Process any URLs that arrived before app was fully ready.
 * Waits for both frontend readiness and session restore completion,
 * then processes URLs sequentially (one at a time) with a small
 * delay between each to avoid racing concurrent window creation.
 */
async function processPendingUrls(): Promise<void> {
  // Wait for frontend subscriber and session restore before processing
  await Promise.all([_frontendReadyPromise, _sessionRestoreDonePromise]);

  const urls = _pendingUrls.slice();
  _pendingUrls = [];

  if (urls.length === 0) {
    urlLog('processPendingUrls: no pending URLs');
    return;
  }

  urlLog(`processPendingUrls: processing ${urls.length} pending URL(s)`);
  DEBUG && console.log(`[url] Processing ${urls.length} pending URL(s)`);

  // Process sequentially with a small delay between each
  for (const { url, sourceId } of urls) {
    publishExternalUrl(url, sourceId);
    // Small delay between URLs to avoid concurrent window creation races
    if (urls.length > 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

/**
 * Mark app as ready to handle external URLs.
 * Pending URLs are NOT processed immediately — they wait for
 * frontendReady and sessionRestoreDone signals.
 */
export function setAppReady(): void {
  _appReady = true;
  urlLog(`setAppReady: pendingUrls=${_pendingUrls.length}`);
  // Kick off pending URL processing (will wait for frontend + session restore)
  processPendingUrls();
}

/**
 * Signal that the frontend (background window's app/index.js) has finished
 * initializing and has registered its pubsub subscribers.
 * Called via IPC 'frontend-ready' from the background window.
 */
export function notifyFrontendReady(): void {
  if (_frontendReady) return;
  _frontendReady = true;
  urlLog(`notifyFrontendReady: pendingUrls=${_pendingUrls.length}`);
  DEBUG && console.log('[url] Frontend ready — pubsub subscribers registered');
  if (_frontendReadyResolve) {
    _frontendReadyResolve();
    _frontendReadyResolve = null;
  }
}

/**
 * Signal that session restore has completed (or was skipped).
 * Called from entry.ts after restoreSessionSnapshot finishes.
 */
export function notifySessionRestoreDone(): void {
  if (_sessionRestoreDone) return;
  _sessionRestoreDone = true;
  urlLog(`notifySessionRestoreDone: pendingUrls=${_pendingUrls.length}`);
  DEBUG && console.log('[url] Session restore done');
  if (_sessionRestoreDoneResolve) {
    _sessionRestoreDoneResolve();
    _sessionRestoreDoneResolve = null;
  }
}

/**
 * Convert a local file path to a file:// URL.
 * Returns null if the path doesn't exist on disk.
 */
function filePathToUrl(filePath: string): string | null {
  try {
    // Resolve to absolute path (handles relative paths)
    const resolved = path.resolve(filePath);
    // Only accept files, not directories
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return pathToFileURL(resolved).href;
    }
  } catch {
    // Not a valid path
  }
  return null;
}

/**
 * Register external URL event handlers
 * Must be called before app.ready for open-url, and in onReady for second-instance
 */
export function registerExternalUrlHandlers(): void {
  urlLog('registerExternalUrlHandlers: registering open-url and open-file handlers');

  // macOS: handle open-url event
  app.on('open-url', (event, url) => {
    event.preventDefault();
    urlLog(`open-url event fired: url=${url}`);
    handleExternalUrl(url, 'os');
  });

  // macOS: handle open-file event (e.g., `open -a Peek /path/to/file`)
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    DEBUG && console.log('open-file event:', filePath);
    const fileUrl = filePathToUrl(filePath);
    if (fileUrl) {
      handleExternalUrl(fileUrl, 'os');
    } else {
      console.error('open-file: path does not exist:', filePath);
    }
  });
}

/**
 * Register second-instance handler (for Windows/Linux URL handling)
 * Call this inside onReady after acquiring single instance lock
 */
export function registerSecondInstanceHandler(): void {
  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    urlLog(`second-instance event: argv=${JSON.stringify(argv)} additionalData=${JSON.stringify(additionalData)}`);

    // Check additionalData first (set by the second instance via requestSingleInstanceLock)
    if (additionalData && typeof additionalData === 'object' && (additionalData as any).url) {
      const url = (additionalData as any).url as string;
      urlLog(`second-instance: found URL in additionalData: ${url}`);
      DEBUG && console.log('second-instance additionalData URL:', url);
      handleExternalUrl(url, 'os');
      return;
    }

    // Look for URLs in argv
    const url = argv.find(arg =>
      arg.startsWith('http://') || arg.startsWith('https://')
    );
    if (url) {
      urlLog(`second-instance: found URL in argv: ${url}`);
      DEBUG && console.log('second-instance URL:', url);
      handleExternalUrl(url, 'os');
      return;
    }

    // Look for file paths (skip flags and the executable path)
    for (const arg of argv.slice(1)) {
      if (arg.startsWith('-')) continue;
      const fileUrl = filePathToUrl(arg);
      if (fileUrl) {
        urlLog(`second-instance: found file URL in argv: ${arg} -> ${fileUrl}`);
        DEBUG && console.log('second-instance file path:', arg, '->', fileUrl);
        handleExternalUrl(fileUrl, 'os');
        return;
      }
    }

    urlLog('second-instance: no URL found in argv or additionalData');
  });
}

/**
 * Check for URL or file path in CLI arguments and handle it.
 * Uses handleExternalUrl which queues until frontend + session restore are ready.
 */
export function handleCliUrl(): void {
  urlLog(`handleCliUrl: argv=${JSON.stringify(process.argv)}`);

  // Look for URLs first
  const urlArg = process.argv.find(arg =>
    arg.startsWith('http://') || arg.startsWith('https://')
  );
  if (urlArg) {
    urlLog(`handleCliUrl: found URL in argv: ${urlArg}`);
    DEBUG && console.log('CLI URL argument:', urlArg);
    handleExternalUrl(urlArg, 'cli');
    return;
  }

  // Look for file paths (skip flags, electron path, and the app path)
  for (const arg of process.argv.slice(1)) {
    if (arg.startsWith('-')) continue;
    // Skip the app directory/entry point itself
    if (arg === app.getAppPath() || arg === '.' || arg.endsWith('.js')) continue;
    // Skip if arg resolves to the app path (handles relative paths, trailing slashes)
    try { if (path.resolve(arg) === path.resolve(app.getAppPath())) continue; } catch {}
    const fileUrl = filePathToUrl(arg);
    if (fileUrl) {
      DEBUG && console.log('CLI file path:', arg, '->', fileUrl);
      handleExternalUrl(fileUrl, 'cli');
      return;
    }
  }
}

// ***** App Lifecycle *****

/**
 * Register the window-all-closed handler
 */
export function registerWindowAllClosedHandler(onQuit: () => void): void {
  app.on('window-all-closed', () => {
    DEBUG && console.log('window-all-closed', process.platform);
    if (process.platform !== 'darwin') {
      onQuit();
    }
  });
}

/**
 * Register the activate handler (macOS dock click)
 */
export function registerActivateHandler(): void {
  app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      // Could recreate window here if needed
    }
  });
}

/**
 * Request single instance lock
 * Returns true if lock acquired, false if another instance is running
 * Skips lock in dev/test profiles to allow running alongside production
 */
export function requestSingleInstance(): boolean {
  // Skip single-instance lock in dev/test profiles to allow running alongside production
  if (isDevProfile() || isTestProfile()) {
    DEBUG && console.log('Skipping single-instance lock for profile:', getProfile());
    return true;
  }

  // Pass any URL from argv as additionalData so the primary instance receives it
  // via the second-instance event. On macOS, `open -a Peek URL` may pass the URL
  // as an Apple Event (handled via open-url) OR in argv, depending on the scenario.
  const urlArg = process.argv.find(arg =>
    arg.startsWith('http://') || arg.startsWith('https://')
  );
  const additionalData = urlArg ? { url: urlArg } : undefined;

  urlLog(`requestSingleInstance: attempting lock, additionalData=${JSON.stringify(additionalData)}`);

  const gotTheLock = app.requestSingleInstanceLock(additionalData);
  if (!gotTheLock) {
    urlLog('requestSingleInstance: lock NOT acquired, another instance running');
    console.error('APP INSTANCE ALREADY RUNNING, QUITTING');
    app.quit();
    return false;
  }

  urlLog('requestSingleInstance: lock acquired (primary instance)');
  return true;
}

/**
 * Quit the application gracefully
 */
export function quitApp(): void {
  DEBUG && console.log('quitApp');

  // Don't call shutdown() here — let the before-quit handler in entry.ts
  // handle the full cleanup sequence: saveSessionSnapshot() then shutdown().
  // Calling shutdown() here closes the database BEFORE before-quit fires,
  // which prevents the session snapshot from being saved with cleanShutdown=true,
  // causing a false crash recovery prompt on next startup.
  app.quit();
}

// Re-export commonly used functions
export {
  scopes,
  publish,
  subscribe,
  getSystemAddress,
  registerLocalShortcut,
  unregisterLocalShortcut,
  registerGlobalShortcut,
  unregisterGlobalShortcut,
  unregisterShortcutsForAddress,
  handleLocalShortcut,
  initTray,
  getDb,
  getExtensionPath,
  getRegisteredExtensionIds,
  loadExtensionManifest,
};
