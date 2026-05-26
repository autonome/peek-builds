/**
 * IPC Handler Registration
 *
 * Centralizes all IPC handlers for the main process.
 * Handlers are thin wrappers that delegate to backend functions.
 */

import { ipcMain, nativeTheme, dialog, BrowserWindow, app, screen, webContents, net, Menu, clipboard } from 'electron';
import { getAllLiveWindows, getLiveWindow, windowFromWebContents } from './window-registry.js';
import fs from 'node:fs';
import path from 'node:path';

import {
  getDb,
  // Item operations
  getItem,
  updateItem,
  updateItemTitle,
  updateItemFavicon,
  updateItemThumbnail,
  hardDeleteItem,
  trackWindowLoad,
  // Context operations
  addContextEntry,
  getContextEntry,
  queryContextHistory,
  getContextSnapshot,
  cleanupWindowContext,
  getWindowsWithContextValue,
  getWindowsMatchingContext,
} from './datastore.js';

import type { Item } from '../types/index.js';

import {
  getRegisteredThemeIds,
  getThemePath,
  getActiveThemeId,
  setActiveThemeId,
} from './protocol.js';

import {
  registerWindow,
  getWindowInfo,
  removeWindow,
  findWindowByKey,
  findWindowByUrl,
  getAllWindows,
  validateThemeCSS,
  popClosedWindow,
  getClosedWindowCount,
  getBackgroundWindow,
  scheduleSnapshotOnLifecycleChange,
} from './main.js';

import {
  APP_DEF_WIDTH,
  APP_DEF_HEIGHT,
  WEB_CORE_ADDRESS,
  getTilePreloadPath,
  isHeadless,
  isTestProfile,
  DEBUG,
} from './config.js';

import { getTileWebPreferencesForUrl, registerTrustedBuiltinWindow, createTileBrowserWindow } from './tile-launcher.js';
import { lookupPseudoTile } from './pseudo-tiles.js';
import { getLazyTileManifest } from './tile-lazy.js';
import { createTrustedBuiltinGrant } from './tile-manifest.js';
import { generateToken } from './tile-tokens.js';

import {
  captureThumbnail,
} from './thumbnails.js';

import {
  addEscHandler,
  winDevtoolsConfig,
  closeOrHideWindow,
  getSystemThemeBackgroundColor,
  getPrefs,
  showWindowHeadlessSafe,
} from './windows.js';
import {
  TRANSIENT_ROLES,
  inferIzuiRole,
  spacesPolicyForRole,
} from './izui-roles.js';


import { trackWindow } from './display-watcher.js';
import {
  computePlacement,
  computeInitialBounds,
  toProportional,
  ownDisplay,
  type Placement,
} from './window-placement.js';

import {
  publish,
  subscribe,
  getSystemAddress,
} from './pubsub.js';

import { handleLocalShortcut } from './shortcuts.js';

import {
  getSyncConfig,
  syncAll,
} from './sync.js';

import {
  detectModeFromUrl,
} from './datastore.js';

import {
  getProfileSession,
  registerDownloadHandler,
} from './session-partition.js';

import {
  getIzuiCoordinator,
} from './izui-state.js';

// ============================================================================
// Window Focus Tracking for Window-Targeted Commands
// ============================================================================
//
// Commands like "theme dark here" or "devtools" need to operate on a specific
// window - the one the user was looking at before opening the cmd palette.
//
// The challenge: commands execute in background.html (not the visible window),
// and the cmd palette is a modal window that gains focus when opened.
//
// Solution: Track the last focused "visible" window, but EXCLUDE modal windows
// from updating this tracker. This way, when the cmd palette opens, it doesn't
// override the target window.
//
// Flow:
//   1. User focuses groups window  →  lastFocusedVisibleWindowId = groups
//   2. User opens cmd palette      →  modal window gets focus
//                                  →  lastFocusedVisibleWindowId unchanged!
//   3. User runs "theme dark here" →  targets groups window correctly
//
// Two trackers are maintained:
//   - lastContentWindowId: Last focused http/https page (for devtools)
//   - lastFocusedVisibleWindowId: Last focused visible window (for per-window cmds)
//
// IPC handlers:
//   - get-focused-visible-window-id: Returns lastFocusedVisibleWindowId
// ============================================================================

// Track the last focused content window (for devtools command)
// Content windows are those with http/https URLs (not peek:// internal pages)
let lastContentWindowId: number | null = null;

// Track the last focused visible window (for per-window commands)
// This includes extension windows (peek://{extId}/...) and web pages,
// but excludes internal background windows and modal windows
let lastFocusedVisibleWindowId: number | null = null;

/** Returns the last focused visible window ID, for use by tile-ipc.ts nav shims. */
export function getLastFocusedVisibleWindowId(): number | null {
  return lastFocusedVisibleWindowId;
}

/** Returns the last focused content (http/https) window ID. Used by tile:window:devtools. */
export function getLastContentWindowId(): number | null {
  return lastContentWindowId;
}

/** Clears the last-focused content window tracker. Called when the target is destroyed. */
export function clearLastContentWindowId(): void {
  lastContentWindowId = null;
}

/**
 * Update tracking when a content window (http/https) gains focus.
 * Used by devtools command to know which web page to target.
 */
function trackContentWindowFocus(win: BrowserWindow): void {
  const url = win.webContents.getURL();
  // Only track content windows (http/https), not internal peek:// pages
  if (url.startsWith('http://') || url.startsWith('https://')) {
    lastContentWindowId = win.id;
    DEBUG && console.log('Updated lastContentWindowId:', lastContentWindowId, url);
  }
}

/**
 * Update tracking when a visible (non-background) window gains focus.
 * Used by per-window commands like "theme dark here".
 *
 * IMPORTANT: Modal windows should NOT call this function, otherwise
 * opening the cmd palette would override the target window.
 *
 * `knownRole` is an optional override for the role check, supplied by
 * callers that have the role in hand without going through the registry
 * (e.g. tile-launcher, which creates BrowserWindows that aren't yet in
 * `windowRegistry`).
 */
export function trackVisibleWindowFocus(win: BrowserWindow, knownRole?: string): void {
  const url = win.webContents.getURL();
  // Exclude internal background windows
  if (url === 'peek://app/background.html') {
    return;
  }
  // Exclude non-focusable windows (e.g., HUD overlay)
  if (!win.isFocusable()) {
    return;
  }
  // Exclude overlay windows (e.g., windows switcher) — they should not
  // be tracked as the last focused visible window
  const winInfo = getWindowInfo(win.id);
  const role = knownRole ?? (winInfo?.params?.role as string | undefined);
  if (role === 'overlay') {
    return;
  }
  // Track extension windows (peek://{id}/...) and web pages
  lastFocusedVisibleWindowId = win.id;
  // Unconditional — wrong-window targeting bugs (e.g. maximize hitting
  // the window behind a focused tile) are reported by symptom; seeing
  // the tracker transitions in stderr makes them diagnosable without
  // re-instrumenting the user.
  console.log(`[focus-tracker] updated lastFocusedVisibleWindowId=${lastFocusedVisibleWindowId} url=${url.slice(0, 80)}`);
}

/** Exported wrapper for tile-launcher: also runs content-window tracking. */
export function trackOnWindowFocus(win: BrowserWindow, knownRole: string | undefined): void {
  trackContentWindowFocus(win);
  trackVisibleWindowFocus(win, knownRole);
}

/**
 * Clear lastFocusedVisibleWindowId if it matches the given window ID.
 * Must be called when a window closes to prevent stale ID from being returned
 * by getFocusedVisibleWindowId(), which would cause commands (e.g., tag) to
 * target a closed window and fall back to the wrong window.
 */
export function clearLastFocusedVisibleWindowId(windowId: number): void {
  if (lastFocusedVisibleWindowId === windowId) {
    DEBUG && console.log('Cleared lastFocusedVisibleWindowId (window closed):', windowId);
    lastFocusedVisibleWindowId = null;
  }
}

// ============================================================================
// Popup-to-Opener Bridge (OAuth / window.opener shim)
// ============================================================================
// Maps popup window IDs to their opener window IDs. Used to route
// window.opener.postMessage() calls from popup webviews back to the opener.
// Populated in setWindowOpenHandler, cleaned up on popup window close.

export const popupToOpener = new Map<number, number>();

/**
 * Convert an Item to an Address-like shape for backward compatibility.
 * Callers that expect Address objects (with uri, protocol, etc.) will
 * get a compatible structure from the items table.
 */
function itemToAddress(item: Item): Record<string, unknown> {
  let protocol = '';
  let path = '';
  try {
    const url = new URL(String(item.content || ''));
    protocol = url.protocol.replace(':', '');
    path = url.pathname;
  } catch { /* not a valid URL */ }

  return {
    id: item.id,
    uri: item.content || '',
    protocol,
    domain: item.domain || '',
    path,
    title: item.title || '',
    mimeType: item.mimeType || 'text/html',
    favicon: item.favicon || '',
    description: '',
    tags: '',
    metadata: item.metadata || '{}',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    lastVisitAt: item.lastVisitAt || 0,
    visitCount: item.visitCount || 0,
    starred: item.starred || 0,
    archived: item.archived || 0,
  };
}



/**
 * Theme settings storage keys
 */
const THEME_SETTINGS_KEY = 'core';
const THEME_ID_KEY = 'theme.id';
const THEME_COLOR_SCHEME_KEY = 'theme.colorScheme';

/**
 * Get theme setting from datastore
 * Note: value is JSON.parse'd to match how utils.js datastoreStore stores values
 */
function getThemeSetting(key: string): string | null {
  try {
    const db = getDb();
    const row = db.prepare(
      'SELECT value FROM feature_settings WHERE featureId = ? AND key = ?'
    ).get(THEME_SETTINGS_KEY, key) as { value: string } | undefined;
    if (!row?.value) return null;
    // Parse JSON-encoded value, fall back to raw value for backwards compatibility
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  } catch {
    return null;
  }
}

/**
 * Set theme setting in datastore
 * Note: value is JSON.stringify'd to match how utils.js datastoreStore expects values
 */
function setThemeSetting(key: string, value: string): void {
  const db = getDb();
  const timestamp = Date.now();
  db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(`${THEME_SETTINGS_KEY}_${key}`, THEME_SETTINGS_KEY, key, JSON.stringify(value), timestamp);
}

/**
 * Broadcast theme change to all windows
 */
function broadcastThemeChange(colorScheme: string): void {
  const windows = getAllLiveWindows();
  for (const win of windows) {
    // Channel is `tile:theme:changed` so tile-preload's live-reload
    // listener (and api.theme.onChange consumers) fire. The old
    // `theme:changed` name predated the tile: namespace and had no
    // subscribers left — see task queue "Theme live-reload" entry.
    win.webContents.send('tile:theme:changed', { kind: 'colorScheme', colorScheme });
  }
}

/**
 * Restore the saved theme preference
 * Call this AFTER themes have been discovered/registered
 */
export function restoreSavedTheme(): void {
  const savedThemeId = getThemeSetting(THEME_ID_KEY);
  if (savedThemeId) {
    const success = setActiveThemeId(savedThemeId);
    if (!success) {
      console.warn('[theme] Failed to restore theme:', savedThemeId, '- theme may not be registered yet');
    }
  }
}

/**
 * Register theme-related IPC handlers
 */
export function registerThemeHandlers(): void {
  // Listen for system theme changes
  nativeTheme.on('updated', () => {
    const colorScheme = getThemeSetting(THEME_COLOR_SCHEME_KEY) || 'system';
    if (colorScheme === 'system') {
      broadcastThemeChange('system');
    }
  });

  // ===== Theme management (add/remove/reload) =====
  //
  // The `tile:theme:pickFolder` / `tile:theme:validateFolder` /
  // `tile:theme:add` / `tile:theme:remove` / `tile:theme:reload` handlers
  // live in tile-ipc.ts. Settings UI consumes them via api.theme.{pickFolder,
  // validateFolder, add, remove, reload}.
}

// Keep old function name for compatibility but call new one
export function registerDarkModeHandlers(): void {
  registerThemeHandlers();
}

/**
 * Dark mode setting storage key
 */
const DARK_MODE_KEY = 'darkMode';

/**
 * Get the dark mode setting from datastore
 * Returns 'off' | 'system' | 'force', defaults to 'system'
 */
export function getDarkModeSetting(): string {
  return getThemeSetting(DARK_MODE_KEY) || 'system';
}

/**
 * Set the dark mode setting in datastore
 */
export function setDarkModeSetting(value: string): void {
  setThemeSetting(DARK_MODE_KEY, value);
}

/**
 * Apply dark mode setting to nativeTheme
 * Tier 1: 'force' = always report dark to webviews
 * 'off' or 'system' = respect OS color scheme preference
 */
export function applyDarkModeSetting(mode: string): void {
  nativeTheme.themeSource = (mode === 'force') ? 'dark' : 'system';
}


/**
 * Reopen the most recently closed window.
 * Called from both the IPC handler and the keyboard shortcut.
 *
 * Drives the window-open handler directly (rather than round-tripping
 * through bgWindow via pubsub) so `registerWindow()` lands in the
 * registry on the same tick as the user's keypress. The pubsub path
 * was async: a fast Cmd+Q after Cmd+Shift+T would fire `before-quit`
 * (and its synchronous `saveSessionSnapshot`) while the reopen was
 * still in flight, dropping the reopened window from the snapshot —
 * the very window the user last had in front. `invokeWindowOpen` is
 * `async`, but the body runs synchronously up to its first await, and
 * `registerWindow` is well before that — so calling it without await
 * is enough to seed the registry before this function returns.
 */
export function reopenLastClosedWindow(): { success: boolean; url?: string; error?: string } {
  const entry = popClosedWindow();
  if (!entry) {
    DEBUG && console.log('[reopen] No closed windows to reopen');
    return { success: false, error: 'No closed windows to reopen' };
  }

  DEBUG && console.log('[reopen] Reopening:', entry.url, 'bounds:', entry.bounds);

  // Build options to restore window state
  const options: Record<string, unknown> = {
    trackingSource: 'reopen',
    trackingSourceId: 'last-closed',
  };

  if (entry.bounds) {
    options.x = entry.bounds.x;
    options.y = entry.bounds.y;
    options.width = entry.bounds.width;
    options.height = entry.bounds.height;
  }

  if (entry.spaceMode) {
    options.spaceMode = entry.spaceMode;
  }

  // Restore the original window role so peek:// windows reopen correctly
  // (without this, peek:// URLs default to 'utility' role which breaks undo-close)
  if (entry.role) {
    options.role = entry.role;
  }

  // Restore scroll position so user returns to where they were reading
  if (entry.scrollX != null) options.scrollX = entry.scrollX;
  if (entry.scrollY != null) options.scrollY = entry.scrollY;

  // Restore maximize state so the page-host FSM boots into MAXIMIZED.
  if (entry.maximized) options.maximized = true;

  // Pre-maximize bounds: thread through so the reopened page-host can
  // populate its renderer-side preMaximizeBounds at INIT — letting the
  // user unmaximize back to the size they had before the original
  // maximize, even after a close+reopen cycle.
  if (entry.preMaximizeBounds) {
    options.preMaxX = entry.preMaximizeBounds.x;
    options.preMaxY = entry.preMaximizeBounds.y;
    options.preMaxWidth = entry.preMaximizeBounds.width;
    options.preMaxHeight = entry.preMaximizeBounds.height;
  }

  const bgWin = getBackgroundWindow();
  if (!invokeWindowOpen || !bgWin) {
    console.error('[reopen] invokeWindowOpen or bgWindow not ready');
    return { success: false, error: 'window-open subsystem not ready' };
  }

  // Fire-and-forget: the synchronous portion of windowOpenHandler runs
  // immediately on call (BrowserWindow ctor + registerWindow), so the
  // registry contains the new window before the next await. The async
  // tail (loadURL + post-load work) continues in the background and
  // does not need to be awaited by callers — saves can run in between
  // and will see the registered window.
  void invokeWindowOpen(
    { sender: bgWin.webContents },
    { source: WEB_CORE_ADDRESS, url: entry.url, options },
  ).catch((err) => {
    console.error('[reopen] invokeWindowOpen failed:', err);
  });

  return { success: true, url: entry.url };
}

/**
 * Open a new empty page host window.
 * Called from the Cmd+N / Ctrl+N keyboard shortcut.
 * Inherits space mode from the last focused visible window (if any).
 * Shows the navbar with URL bar focused so the user can immediately type a URL.
 */
export function openNewPageWindow(): void {
  const options: Record<string, unknown> = {
    trackingSource: 'new-window',
    trackingSourceId: 'shortcut',
  };

  // Inherit space mode from the last focused visible window
  if (lastFocusedVisibleWindowId != null) {
    try {
      const modeEntry = getContextEntry('mode', lastFocusedVisibleWindowId);
      if (modeEntry && modeEntry.value === 'space' && modeEntry.metadata) {
        options.spaceMode = {
          spaceId: modeEntry.metadata.spaceId as string,
          spaceName: modeEntry.metadata.spaceName as string,
          color: modeEntry.metadata.color as string | undefined,
        };
        DEBUG && console.log('[new-window] Inheriting space mode:', modeEntry.metadata.spaceName);
      }
    } catch (e) {
      DEBUG && console.log('[new-window] Failed to read space mode:', e);
    }
  }

  // Publish event for the background window to open the URL
  publish(getSystemAddress(), 'window:new-page-request', {
    url: 'peek://app/new-tab/index.html',
    options,
  });
}

/**
 * Register window management IPC handlers
 */
const pendingWindowKeys = new Set<string>();

/**
 * Apply a stored `Placement` to a reused window. Reads the placement
 * intent from the registry, snapshots displays + primary id + (optionally)
 * parent bounds, calls `computePlacement`, and applies the result.
 *
 * Single source of truth for "where should this reused window go?" is
 * the pure module — see docs/window-placement.md.
 */
function applyPlacementOnReuse(
  win: BrowserWindow,
  placement: Placement | undefined,
  reason: string,
): void {
  if (!placement) return;
  const currentBounds = win.getBounds();
  let parentBounds: Electron.Rectangle | undefined;
  if (placement.mode === 'parent-centered') {
    const parent = getLiveWindow(placement.parentId);
    if (parent) {
      parentBounds = parent.getBounds();
    }
  }
  const result = computePlacement({
    placement,
    currentBounds,
    windowSize: { width: currentBounds.width, height: currentBounds.height },
    displays: screen.getAllDisplays(),
    primaryDisplayId: screen.getPrimaryDisplay().id,
    parentBounds,
  });
  if (result.kind === 'reposition') {
    DEBUG && console.log(
      `[window-reuse] applyPlacementOnReuse (${reason}) ${win.id}: ` +
      `(${currentBounds.x},${currentBounds.y} ${currentBounds.width}x${currentBounds.height}) -> ` +
      `(${result.bounds.x},${result.bounds.y} ${result.bounds.width}x${result.bounds.height}) [mode:${placement.mode}]`
    );
    win.setBounds(result.bounds);
  }
}

// Exported reference to the window-open handler so other IPC surfaces (like tile
// IPC) can delegate to it without duplicating ~1300 lines of window creation logic.
// Populated by registerWindowHandlers() at startup.
// Use `any` for parameters to match the original implicit-any ergonomics of the
// IPC handler body (options is heavily dynamic).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export let invokeWindowOpen: ((ev: any, msg: any) => Promise<unknown>) | null = null;

export function registerWindowHandlers(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const windowOpenHandler = async (ev: any, msg: any) => {
    DEBUG && console.log('window-open', msg);

    const { url, options } = msg;

    // Always log escapeMode for debugging window lifecycle
    console.log(`[window-open] url: ${url}, source: ${msg.source}, escapeMode: ${options?.escapeMode}, key: ${options?.key}, options keys: ${options ? Object.keys(options).join(',') : 'none'}`);

    // Phase timing — only emit when this open is part of a session
    // restore (skipTracking is set by session.ts:restoreSessionSnapshot).
    // See peek task 1d1331e0.
    const perfT0 = Date.now();
    const perfTrace = options?.skipTracking === true;
    const perfMark = (phase: string) => {
      if (!perfTrace) return;
      console.log(`[window-open:perf] phase=${phase} ms=${Date.now() - perfT0} url=${(url || '').substring(0, 80)}`);
    };
    perfMark('entry');

    // IMPORTANT: Determine transient state BEFORE creating the window
    // A window is transient if:
    // 1. The current IZUI session is transient (user invoked from background), OR
    // 2. No Peek window was focused when evaluated
    // Check session state FIRST before evaluateOnShow() might change it
    const coordinator = getIzuiCoordinator();
    const sessionWasTransient = coordinator.isTransient();

    // Now evaluate (this might update session state based on current focus)
    const entryMode = coordinator.evaluateOnShow();

    // Use session state if available, otherwise use evaluated state
    const isTransient = sessionWasTransient || entryMode === 'transient';
    DEBUG && console.log('[izui] Transient detection:', { sessionWasTransient, entryMode, isTransient });

    // Check if window with this key already exists or is being created
    if (options.key) {
      const fullKey = `${msg.source}:${options.key}`;

      // Race guard: if another call is already creating this window, skip
      if (pendingWindowKeys.has(fullKey)) {
        DEBUG && console.log('Window with key already being created, skipping:', options.key);
        return { success: true, id: null, reused: true };
      }

      const existingWindow = findWindowByKey(msg.source, options.key);
      if (existingWindow) {
        DEBUG && console.log('Reusing existing window with key:', options.key);

        // For keepLive reuse, update the per-window transient flag from OS-level app focus.
        // Use isAppFocused() (real-time OS focus) instead of session's isTransient()
        // because the session has a one-way ratchet (active never downgrades to transient).
        // When a user switches to another app and then invokes cmd via global hotkey,
        // the session may still be 'active' from earlier use, but appFocused correctly
        // reflects that Peek was NOT the foreground app at invocation time.
        const coordinator = getIzuiCoordinator();
        const existingData = existingWindow.data as { params: Record<string, unknown> };
        existingData.params.transient = !coordinator.isAppFocused();
        DEBUG && console.log('Reused window transient from appFocused:', existingData.params.transient, 'appFocused:', coordinator.isAppFocused());

        if (!isHeadless()) {
          // Display-change safety for keepLive reuse: read the stored
          // `Placement` intent and let `computePlacement` decide whether
          // to reposition. Replaces the historical `center: true` /
          // `isWindowAccessibleNow` branch logic — the pure module
          // already encodes both semantics:
          //   - `centered` mode → always re-center on cursor display
          //   - other modes → only reposition if stranded
          // See apps/desktop/main/window-placement.ts.
          applyPlacementOnReuse(
            existingWindow.window,
            existingData.params.placement as Placement | undefined,
            'keepLive-reuse',
          );

          // Stamp show-time so the modal blur handler can suppress the
          // spurious blur that NSPanel + `alwaysOnTop:'floating'` emits
          // during the first ~200ms after show(). Without this, hitting
          // the global hotkey from another app produces: show → immediate
          // blur → hide(), and the NSPanel's floating-level order race
          // leaves the panel rendered even though Electron reports
          // isVisible=false. See commit 1b568d40 for original fix; this
          // was lost in the tile system refactor.
          (existingWindow.window as { __lastShowTime?: number }).__lastShowTime = Date.now();
          // Re-apply Spaces visibility for transient roles so the hidden
          // window follows the user to the active Space rather than dragging
          // them back to its home Space. Non-transient (anchored) windows
          // intentionally stay where they were opened — macOS pulls the user
          // to them on show(), which is the desired behavior.
          // skipTransformProcessType:true prevents the activation-policy
          // toggle that hides every other Peek window during the call.
          const reuseRole = existingData.params.role as string | undefined;
          if (reuseRole && spacesPolicyForRole(reuseRole, process.platform) === 'follow') {
            existingWindow.window.setVisibleOnAllWorkspaces(true, {
              visibleOnFullScreen: true,
              skipTransformProcessType: true,
            });
          }
          showWindowHeadlessSafe(existingWindow.window, { active: true });
          existingWindow.window.focus();
        }
        // Signal keepLive-reuse to the renderer BEFORE returning so the
        // renderer's `api.onVisible` handler dispatches its FSM reset
        // ahead of any user input that might arrive on the next turn.
        // IPC is queued in order — this message is processed before any
        // subsequent input event on the renderer's event loop.
        try {
          if (!existingWindow.window.isDestroyed()) {
            existingWindow.window.webContents.send('tile:lifecycle:visible');
          }
        } catch (err) {
          console.error('[window-open] tile:lifecycle:visible send threw:', err);
        }
        return { success: true, id: existingWindow.id, reused: true };
      }

      // Mark this key as pending creation
      pendingWindowKeys.add(fullKey);
    }

    // Check if any existing window already has this URL loaded (for http/https URLs).
    // This catches duplicate windows even when no key was provided.
    // Skip this check for reopen-last-closed (trackingSource: 'reopen') — the user
    // explicitly wants a new window for the URL they previously closed.
    // Skip when the caller passed an explicit `key` — a key signals "I manage
    // window identity by key, not by URL." Otherwise a slide (key=address:edge)
    // whose window was just transient-closed will fall through here and get
    // attached to whatever unrelated http window happens to share its URL.
    if ((url.startsWith('http://') || url.startsWith('https://')) && options.trackingSource !== 'reopen' && !options.key) {
      const existingByUrl = findWindowByUrl(url);
      if (existingByUrl) {
        DEBUG && console.log('Reusing existing window with same URL:', url);
        if (!isHeadless()) {
          // Display-change safety: read the stored `Placement` intent and
          // let `computePlacement` decide whether to reposition. The
          // stranded-rescue path inside the pure module replaces the
          // historical `isWindowAccessibleNow` check.
          const existingData = existingByUrl.data as { params: { placement?: Placement } };
          applyPlacementOnReuse(
            existingByUrl.window,
            existingData.params.placement,
            'url-reuse',
          );
          showWindowHeadlessSafe(existingByUrl.window, { active: true });
          existingByUrl.window.focus();
        }
        // Reload the page so content is fresh (the webview may have navigated
        // away or the content may be stale from session restore).
        try {
          publish('system', 'page:reload', { windowId: existingByUrl.id });
        } catch (e) {
          DEBUG && console.log('Failed to send reload to reused window:', e);
        }
        return { success: true, id: existingByUrl.id, reused: true };
      }
    }

    // Determine frame setting based on explicit option or preference
    // If frame is explicitly set in options, use that; otherwise use hideTitleBar pref
    let frameDefault = false; // Default to frameless if pref not available
    if (options.frame === undefined) {
      const prefs = getPrefs();
      // hideTitleBar: true means frame: false (no titlebar)
      // hideTitleBar: false means frame: true (show titlebar)
      frameDefault = prefs.hideTitleBar === false;
    }

    // Check if this is a web page that will use the transparent canvas
    const isNewTab = url === 'peek://app/new-tab/index.html';
    const isWebPage = url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file:///') || isNewTab;

    // Determine if this web page should use the fullscreen transparent canvas model.
    // Canvas pages get a fullscreen transparent BrowserWindow where all UI elements
    // (webview, navbar, resize handle) are positioned via JS on an invisible surface.
    // Non-canvas web pages (modals, quick-views, overlays) load their URL directly.
    const isModalOrQuickView = options.modal === true || options.overlay === true;
    const useCanvas = options.canvas === true || (isWebPage && !isModalOrQuickView);

    // Use profile-specific session for isolation
    const profileSession = getProfileSession();

    // If this URL points to a registered tile, use tile-preload.cjs with
    // a capability token so the feature's home.html gets `api.initialize()`,
    // `api.pubsub.subscribe/publish`, strict `api.datastore.*` routing, and
    // every other api.* surface.
    //
    // Non-tile URLs (web pages, new-tab, etc.) get no preload.
    let tileWebPrefs = getTileWebPreferencesForUrl(
      url,
      getTilePreloadPath(),
      getLazyTileManifest,
    );

    // When a pseudo-tile URL mints an ad-hoc trustedBuiltin token below, we
    // must also register the resulting BrowserWindow with the tile broadcaster
    // after creation so pubsub events (cmd:register, tag:item-added, …) are
    // forwarded to it. Capture the token here; register after new BrowserWindow.
    let specialCaseToken: string | null = null;

    // Pseudo-tile lookup: settings / diagnostic / hud-overlay / cmd panel /
    // chain editor / about:blank — URLs that need tile-preload but don't
    // ship a tile manifest. Registry is in pseudo-tiles.ts; see comments
    // there for extension. Match handles hash/query fragments so URLs
    // restored from session snapshots still resolve.
    if (!tileWebPrefs) {
      const pseudoTile = lookupPseudoTile(url);
      if (pseudoTile) {
        tileWebPrefs = pseudoTile.webPrefs;
        specialCaseToken = pseudoTile.token;
        DEBUG && console.log(`[window-open] pseudo-tile ${pseudoTile.webPrefs.tileId}:${pseudoTile.webPrefs.entryId} assigned trustedBuiltin tile-preload token for ${url}`);
      }
    }

    // Canvas page host windows use tile-preload with a trustedBuiltin grant so
    // page.js can use api.window.*, api.datastore.*, api.context.*, api.profiles.*,
    // api.chromeExtensions.*, api.app.*, api.subscribe/publish, etc. The token is
    // minted here (before BrowserWindow creation) so it can be injected into
    // additionalArguments. A unique entry-id prevents Map collisions when multiple
    // canvas windows are open simultaneously.
    const PAGE_HOST_TILE_ID = 'page-host';
    let pageHostToken: string | null = null;
    let pageHostEntryId: string | null = null;
    if (useCanvas) {
      pageHostEntryId = `canvas-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const pageHostGrant = createTrustedBuiltinGrant(PAGE_HOST_TILE_ID);
      pageHostToken = generateToken(PAGE_HOST_TILE_ID, pageHostEntryId, pageHostGrant);
    }

    // Prepare browser window options
    const winOptions: Electron.BrowserWindowConstructorOptions = {
      frame: isWebPage ? false : frameDefault, // Web pages are always frameless
      ...options,
      width: parseInt(options.width) || APP_DEF_WIDTH,
      height: parseInt(options.height) || APP_DEF_HEIGHT,
      show: isHeadless() ? false : options.show !== false,
      // In headless: create the window already at opacity 0 so its compositor
      // surface, even if it leaks during macOS window-management or dock
      // animation events, cannot paint anything visible to the user.
      //
      // We previously tried paintWhenInitiallyHidden: false here, but that
      // also deactivates the renderer's JS event loop (per Electron docs),
      // breaking the page-host's stored-permission-decision listener.
      // opacity: 0 keeps the renderer fully active while making the surface
      // visually empty regardless of compositor behavior.
      //
      // The existing show/showInactive guard in entry.ts blocks .show() unless
      // opacity is already 0, so showWindowHeadlessSafe's setOpacity(0) is
      // still the runtime path. This ctor-level opacity:0 closes the brief
      // window between BrowserWindow construction and the first explicit
      // setOpacity call.
      opacity: isHeadless() ? 0 : undefined,
      // Canvas pages: transparent minimal window, no shadow, no OS resize (we handle it via setBounds)
      transparent: useCanvas ? true : (options.transparent || false),
      backgroundColor: (useCanvas || options.transparent) ? undefined : getSystemThemeBackgroundColor(),
      ...(useCanvas ? { hasShadow: false, resizable: false } : {}),
      webPreferences: {
        ...options.webPreferences,
        // Canvas page host windows get tile-preload with a trustedBuiltin grant;
        // other tile URLs get their manifest-derived preload; everything else
        // gets no preload.
        preload: useCanvas
          ? getTilePreloadPath()
          : tileWebPrefs ? tileWebPrefs.preload : undefined,
        additionalArguments: useCanvas
          ? [
              `--tile-id=${PAGE_HOST_TILE_ID}`,
              `--tile-entry=${pageHostEntryId!}`,
              `--tile-token=${pageHostToken!}`,
            ]
          : tileWebPrefs ? tileWebPrefs.additionalArguments : options.webPreferences?.additionalArguments,
        session: profileSession,
        webviewTag: useCanvas ? true : (options.webPreferences?.webviewTag || false),
        // Always grant the devTools capability — see tile-launcher.ts for
        // the full reasoning. Opening is gated by the runtime debug toggle
        // at the keyboard-shortcut handler in entry.ts.
        devTools: true,
      }
    };

    // Apply explicit position parameters (used by session restore and direct callers)
    if (options.x !== undefined) {
      winOptions.x = parseInt(options.x);
    }
    if (options.y !== undefined) {
      winOptions.y = parseInt(options.y);
    }

    // Off-screen bounds validation: if explicit x/y were provided, verify the
    // center point falls on an active display. If not (e.g. monitor disconnected),
    // drop x/y so the window centers on the current display instead.
    if (winOptions.x !== undefined && winOptions.y !== undefined) {
      const centerX = winOptions.x + Math.round(((winOptions.width as number) || 800) / 2);
      const centerY = winOptions.y + Math.round(((winOptions.height as number) || 600) / 2);
      const displays = screen.getAllDisplays();
      const onScreen = displays.some(d => {
        const { x: dx, y: dy, width: dw, height: dh } = d.bounds;
        return centerX >= dx && centerX < dx + dw && centerY >= dy && centerY < dy + dh;
      });
      if (!onScreen) {
        DEBUG && console.log(`[window-open] Dropping off-screen position (${winOptions.x},${winOptions.y}) center=(${centerX},${centerY})`);
        delete winOptions.x;
        delete winOptions.y;
      }
    }

    // Determine opener window and whether it's a real content parent.
    // Background/infrastructure windows (background.html) are not real
    // parents — they're just the IPC sender. Launcher / overlay windows
    // (cmd palette, Windows switcher, spaces overlay) are also not real
    // parents: a URL opened FROM the cmd panel is a top-level content
    // window in its own right, not a "child" of the palette. If these
    // were treated as real parents, the opened page inherits
    // `role: 'child-content'` and `escPolicy()` would close it on ESC —
    // exactly the regression this guard prevents.
    //
    // NOTE: `utility` is excluded from the non-parent set on purpose —
    // peek:// content tiles (groups/home, search/home, etc.) currently
    // get role 'utility' from the cascade in window-open even though
    // they're content from the user's perspective. Treating utility as
    // a non-parent breaks the `parentWindowId is set when opened from a
    // content window` test in izui-behavior.spec.ts. Long-term fix is
    // to stop overloading 'utility'; short-term, only the clearly-
    // ephemeral roles get excluded here.
    const openerWindow = windowFromWebContents(ev.sender);
    const INTERNAL_URLS = ['peek://app/background.html'];
    const INTERNAL_URL_PREFIXES = ['peek://test/'];
    // Launcher / overlay roles that should never act as a real parent.
    const NON_PARENT_ROLES = new Set(['palette', 'overlay']);
    const openerUrl = openerWindow ? openerWindow.webContents?.getURL() ?? '' : '';
    const openerInfo = openerWindow ? getWindowInfo(openerWindow.id) : null;
    const openerRole = (openerInfo?.params?.role as string | undefined) ?? undefined;
    const isRealParent = openerWindow &&
      !INTERNAL_URLS.some(u => openerUrl === u) &&
      !INTERNAL_URL_PREFIXES.some(p => openerUrl.startsWith(p)) &&
      (openerRole === undefined || !NON_PARENT_ROLES.has(openerRole));

    // Derive `Placement` intent from open-time options. The derivation
    // mirrors what's recorded on the registry below — keep these two
    // call sites in sync (they consult the same option flags).
    //
    // Order of precedence:
    //   screenEdge > center > parent (no explicit x/y) > explicit x/y > none
    //
    // Slides emits `screenEdge` as 'Up'|'Down'|'Left'|'Right'; map both
    // spellings to 'top'|'bottom'|'left'|'right'.
    const screenEdgeRaw = (options as { screenEdge?: unknown }).screenEdge;
    const edgeMap: Record<string, 'top' | 'bottom' | 'left' | 'right'> = {
      Up: 'top', Down: 'bottom', Left: 'left', Right: 'right',
      top: 'top', bottom: 'bottom', left: 'left', right: 'right',
    };
    const mappedEdge = typeof screenEdgeRaw === 'string' ? edgeMap[screenEdgeRaw] : undefined;
    const callerProvidedX = options.x !== undefined && !Number.isNaN(parseInt(options.x));
    const callerProvidedY = options.y !== undefined && !Number.isNaN(parseInt(options.y));
    const callerProvidedXY = callerProvidedX && callerProvidedY;

    // Snapshot displays + primary id once for both placement derivation
    // and `computeInitialBounds`. Reading them fresh here is cheap and
    // matches the spec: every consumer reads live OS state.
    const liveDisplays = screen.getAllDisplays();
    const livePrimaryId = screen.getPrimaryDisplay().id;

    let placement: Placement;
    if (mappedEdge) {
      placement = { mode: 'edge', edge: mappedEdge };
    } else if (options.center === true) {
      placement = { mode: 'centered' };
    } else if (isRealParent && !callerProvidedXY && options.centerOnParent !== false) {
      placement = { mode: 'parent-centered', parentId: openerWindow!.id };
    } else if (callerProvidedXY) {
      // Convert explicit x/y into proportional intent against the display
      // containing the proposed bounds' center. This survives display
      // changes — top-right of one screen stays top-right on the next.
      const x = parseInt(options.x);
      const y = parseInt(options.y);
      const w = (winOptions.width as number) || APP_DEF_WIDTH;
      const h = (winOptions.height as number) || APP_DEF_HEIGHT;
      const target = ownDisplay({ x, y, width: w, height: h }, liveDisplays, livePrimaryId);
      const { relX, relY } = toProportional({ x, y, width: w, height: h }, target);
      placement = { mode: 'proportional', relX, relY };
    } else {
      // No flags, no coords: visually centered on primary by default,
      // and since it's proportional any later drag becomes sticky.
      placement = { mode: 'proportional', relX: 0.5, relY: 0.5 };
    }

    // Fill in winOptions.x/y when not already explicitly supplied.
    // For `edge` mode the caller may have passed stale x/y (slides used
    // to compute them in the renderer from window.screen) — placement
    // intent wins, so we override with `computeInitialBounds` output.
    // Off-screen explicit x/y were already dropped earlier in the
    // off-screen-bounds-validation block above.
    const needsCompute =
      mappedEdge !== undefined ||
      winOptions.x === undefined || winOptions.y === undefined;
    if (needsCompute) {
      const winW = winOptions.width as number || APP_DEF_WIDTH;
      const winH = winOptions.height as number || APP_DEF_HEIGHT;
      let parentBounds: Electron.Rectangle | undefined;
      if (placement.mode === 'parent-centered' && openerWindow && !openerWindow.isDestroyed()) {
        parentBounds = openerWindow.getBounds();
      }
      const initial = computeInitialBounds(
        placement,
        { width: winW, height: winH },
        liveDisplays,
        livePrimaryId,
        parentBounds,
      );
      winOptions.x = initial.x;
      winOptions.y = initial.y;
      // Note: width/height clamped to workArea by computeInitialBounds —
      // honor the clamp so `new BrowserWindow` doesn't get oversize hints.
      winOptions.width = initial.width;
      winOptions.height = initial.height;
      DEBUG && console.log(
        `[window-open] computeInitialBounds (${placement.mode}) -> ` +
        `(${initial.x},${initial.y} ${initial.width}x${initial.height})`
      );
    }

    if (options.modal === true) {
      // Use panel type on macOS to improve focus restoration when closed
      if (process.platform === 'darwin') {
        winOptions.type = 'panel';
      }
    }

    // Set parent window if parentId is provided
    if (options.parentId) {
      const parentWin = getLiveWindow(options.parentId);
      if (parentWin) {
        winOptions.parent = parentWin;
      }
    }

    // For canvas pages, adjust window bounds BEFORE creation to include margins
    // and trigger zone. This prevents a visual flash where the window appears at
    // the webview coordinates then jumps to the correct position.
    // Save the original webview screen coordinates for URL params.
    let canvasWebviewBounds: { x: number; y: number; width: number; height: number } | null = null;
    if (useCanvas) {
      const CANVAS_MARGIN = 8;
      const CANVAS_TRIGGER_ZONE = 8;
      const CANVAS_NAVBAR_HEIGHT = 36; // Always reserve space for navbar (avoids resize jumps)

      // winOptions.x/y/width/height were filled in above by
      // `computeInitialBounds` (or by the caller's explicit x/y). The
      // historical "compute centered fallback when undefined" block has
      // moved into `window-placement.ts`.

      // Maximize hint: the saved bounds for a maximized window are the OS
      // window bounds (= work area), NOT the webview bounds — re-adding
      // canvas margins would push the window past the work area edge.
      // Snap directly to the active display's work area instead. The
      // page-host FSM will boot into MAXIMIZED via INIT_COMPLETE
      // (maximized=1 also propagates to pageParams below).
      // See docs/page-host-state-machine.md.
      if (options.maximized === true) {
        const display = screen.getDisplayNearestPoint({ x: winOptions.x as number, y: winOptions.y as number });
        const wa = display.workArea;
        canvasWebviewBounds = { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
        if (!isHeadless()) {
          winOptions.x = wa.x;
          winOptions.y = wa.y;
          winOptions.width = wa.width;
          winOptions.height = wa.height;
        }
      } else {
        // winOptions.x/y/width/height are currently the webview screen coordinates
        canvasWebviewBounds = {
          x: winOptions.x as number,
          y: winOptions.y as number,
          width: winOptions.width as number,
          height: winOptions.height as number,
        };
        if (!isHeadless()) {
          winOptions.x = canvasWebviewBounds.x - CANVAS_MARGIN;
          winOptions.y = canvasWebviewBounds.y - CANVAS_TRIGGER_ZONE - CANVAS_NAVBAR_HEIGHT;
          winOptions.width = canvasWebviewBounds.width + CANVAS_MARGIN * 2;
          winOptions.height = canvasWebviewBounds.height + CANVAS_TRIGGER_ZONE + CANVAS_MARGIN + CANVAS_NAVBAR_HEIGHT;
        }
      }
    }

    DEBUG && console.log('Creating window with options:', winOptions);
    console.log(`[window-open:bounds] url=${url.substring(0, 80)} final position: (${winOptions.x},${winOptions.y}) ${winOptions.width}x${winOptions.height}${useCanvas ? " [canvas]" : ""}`);

    // Pass through optional BrowserWindow properties from caller
    if (options.alwaysOnTop !== undefined) winOptions.alwaysOnTop = !!options.alwaysOnTop;
    if (options.focusable !== undefined) winOptions.focusable = !!options.focusable;
    if (options.skipTaskbar !== undefined) winOptions.skipTaskbar = !!options.skipTaskbar;
    if (options.hasShadow !== undefined && !useCanvas) winOptions.hasShadow = !!options.hasShadow;

    // Create new window.
    //
    // For real feature tile URLs (tileWebPrefs resolved from the
    // manifest, NOT a special-case trustedBuiltin synthesis and NOT a
    // canvas page host), route through `createTileBrowserWindow` — the
    // same helper `launchTile` uses. This is Phase D of the tile-
    // lifecycle rewrite: one constructor, one set of baseline chrome
    // defaults (autoHideMenuBar, session, backgroundColor), one
    // registration path. The divergence that surfaced the entities-
    // tile-has-a-menubar bug can't recur because there's no second
    // place where tile BrowserWindows get built.
    //
    // Canvas page hosts, trustedBuiltin special cases (settings,
    // diagnostic, hud-overlay, cmd-ui, about:blank, datastore-viewer),
    // and plain web pages still go through the direct `new
    // BrowserWindow(winOptions)` path — they're not feature tiles
    // and unifying them is a separate cleanup.
    const isRealTileLaunch =
      tileWebPrefs !== null &&
      !specialCaseToken &&
      !useCanvas &&
      tileWebPrefs.token !== undefined;
    perfMark('before-create');
    let win: BrowserWindow;
    if (isRealTileLaunch && tileWebPrefs) {
      // Pull webPreferences overrides out so the helper's baseline tile
      // webPreferences (preload, additionalArguments, session, sandbox)
      // remain in control. Anything else the caller asked for (webviewTag,
      // etc.) is passed through as an override.
      const { preload: _p, additionalArguments: _a, session: _s, sandbox: _sb,
              contextIsolation: _ci, nodeIntegration: _ni,
              ...extraWebPrefs } = (winOptions.webPreferences ?? {}) as Record<string, unknown>;
      const { webPreferences: _wp, ...browserWindowOverrides } = winOptions;
      win = createTileBrowserWindow({
        tileId: tileWebPrefs.tileId,
        entryId: tileWebPrefs.entryId,
        token: tileWebPrefs.token!,
        preloadPath: tileWebPrefs.preload,
        browserWindowOverrides: browserWindowOverrides as Partial<Electron.BrowserWindowConstructorOptions>,
        webPreferencesOverrides: extraWebPrefs as Partial<Electron.WebPreferences>,
      });
    } else {
      win = new BrowserWindow(winOptions);
    }
    { const actualBounds = win.getBounds(); console.log(`[window-open:actual] Window ${win.id} actual bounds after creation: (${actualBounds.x},${actualBounds.y}) ${actualBounds.width}x${actualBounds.height}`); }
    perfMark('after-create');

    // Reinforce alwaysOnTop after creation — on macOS the constructor flag alone
    // is unreliable; calling setAlwaysOnTop with 'floating' level ensures it stays
    // above regular windows. Skip in headless: even at opacity=0, setAlwaysOnTop
    // triggers a macOS compositor repaint that can flash a thin window frame.
    if (options.alwaysOnTop && !isHeadless()) {
      win.setAlwaysOnTop(true, 'floating');
      DEBUG && console.log('[window-open] Set alwaysOnTop floating for window', win.id);
    }

    // Derive IZUI role now (before the Spaces dispatch below) using the same
    // rules the registration block applies later. Hoisted out of the original
    // inline cascade so the role-derived Spaces policy can run at creation
    // time. See apps/desktop/main/izui-roles.ts for the cascade.
    const parentWindowIdForRole = isRealParent ? openerWindow!.id : null;
    const role = inferIzuiRole(options as Parameters<typeof inferIzuiRole>[0], {
      isWebPage,
      parentWindowId: parentWindowIdForRole,
    });

    // macOS Spaces dispatch by role:
    //   'follow' — palette/quick-view/overlay (cmd, slides, peeks). Window
    //     appears on every Space, riding along with the user.
    //   'anchor' — everything else on darwin. Flip true → false so macOS
    //     lands the window on the user's active Space and pins it there.
    //   'none' — non-darwin platforms; macOS Spaces don't exist.
    // skipTransformProcessType:true is required on both calls — without it,
    // macOS toggles the app's activation policy (Accessory ↔ Foreground)
    // and every other Peek window flashes out for a frame.
    if (!isHeadless()) {
      const spacesPolicy = spacesPolicyForRole(role, process.platform);
      if (spacesPolicy === 'follow') {
        win.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        });
      } else if (spacesPolicy === 'anchor') {
        win.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        });
        win.setVisibleOnAllWorkspaces(false, {
          skipTransformProcessType: true,
        });
      }
    }

    // Register canvas page host windows with the tile broadcaster so pubsub
    // messages (tag:item-added, sync:pull-completed, etc.) are forwarded to
    // page.js via the same pubsubBroadcaster path used by feature tiles.
    // Token cleanup (revokeToken) happens automatically on 'closed'.
    if (useCanvas && pageHostToken && pageHostEntryId) {
      registerTrustedBuiltinWindow(PAGE_HOST_TILE_ID, pageHostEntryId, win, pageHostToken);
      DEBUG && console.log(`[page-host] Registered canvas window ${win.id} as tile ${PAGE_HOST_TILE_ID}:${pageHostEntryId}`);
    }

    // Register any special-case trustedBuiltin window (diagnostic, settings,
    // hud-overlay, datastore-viewer, cmd-ui, about:blank) with the broadcaster
    // so pubsub messages (cmd:register, theme:changed, etc.) reach it. Without
    // this, the window gets tile-preload + a valid token but `state.commands`,
    // theme subscriptions, and every other pubsub-driven surface silently miss
    // updates. The close handler revokes the token and removes the entry.
    if (specialCaseToken && tileWebPrefs?.tileId && tileWebPrefs?.entryId) {
      registerTrustedBuiltinWindow(tileWebPrefs.tileId, tileWebPrefs.entryId, win, specialCaseToken);
      DEBUG && console.log(`[window-open] registered ${tileWebPrefs.tileId}:${tileWebPrefs.entryId} with tile broadcaster`);
    } else if (!isRealTileLaunch && tileWebPrefs?.tileId && tileWebPrefs?.entryId && tileWebPrefs?.token) {
      // Feature tile window-entry opened via api.window.open(): register the
      // BrowserWindow with the tile broadcaster so GLOBAL-scope pubsub messages
      // reach it. Without this, the window gets tile-preload + a valid token
      // (so publish works) but inbound pubsub messages are silently dropped
      // because getAllTileWindows() only knows about windows launched directly
      // by launchTile() (i.e. background entries). Symptom: feature's background
      // tile subscribes to a topic the window publishes (or vice versa), and
      // the subscribe-side handler never fires. See pubsub-repro.spec.ts for
      // a minimal repro.
      //
      // Gate on !isRealTileLaunch — when the helper above created the
      // window it already called tileWindows.set + wired the close
      // handler, so this branch would double-register. Only reached now
      // for legacy/edge paths that still go through `new BrowserWindow`.
      registerTrustedBuiltinWindow(tileWebPrefs.tileId, tileWebPrefs.entryId, win, tileWebPrefs.token);
      DEBUG && console.log(`[window-open] registered tile window ${tileWebPrefs.tileId}:${tileWebPrefs.entryId} with tile broadcaster`);
    }

    // Track window position for display-watcher home display restoration
    trackWindow(win);

    // Forward console logs from window to main process stderr only when
    // DEBUG is set. In normal runs the preload-level console wrapper
    // (tile-preload.cts) sends all output to peek:renderer-log →
    // <userData>/logs/renderer.log via renderer-log.ts, independent of
    // DevTools attach state. console-message does NOT fire when DevTools
    // is attached, so the IPC path is the source of truth.
    if (DEBUG) {
      const consoleLabel = useCanvas ? `page-host:${url.substring(0, 60)}` : url.replace('peek://', '');
      win.webContents.on('console-message', (event) => {
        // Electron 40: `level` is a string literal, not an integer.
        try {
          const asAny = event as unknown as { level?: unknown; message?: unknown };
          const level = String(asAny.level ?? '');
          const message = String(asAny.message ?? '');
          console.log(`[${consoleLabel}] ${level}: ${message}`);
        } catch {
          /* logging must never throw */
        }
      });
    }

    try {
      // Route canvas web pages through peek://page container.
      // Minimal page host: a tight-fitting transparent BrowserWindow that wraps
      // the webview content plus small margins for resize handles and a trigger zone.
      // The window moves/resizes via setBounds() IPC calls from the renderer.
      let loadUrl = url;
      if (useCanvas) {
        // Use saved webview coordinates (before window bounds were adjusted for margins)
        const webviewX = canvasWebviewBounds?.x ?? parseInt(String(options.x ?? 100));
        const webviewY = canvasWebviewBounds?.y ?? parseInt(String(options.y ?? 100));
        const webviewW = canvasWebviewBounds?.width ?? (parseInt(options.width) || APP_DEF_WIDTH);
        const webviewH = canvasWebviewBounds?.height ?? (parseInt(options.height) || APP_DEF_HEIGHT);

        // Pass screen coordinates of the webview in URL params (for session save/restore)
        const pageParams = new URLSearchParams({
          url: url,
          x: String(webviewX),
          y: String(webviewY),
          width: String(webviewW),
          height: String(webviewH),
        });
        // Pass scroll position for undo-close-window restoration
        if (options.scrollX != null) pageParams.set('scrollX', String(options.scrollX));
        if (options.scrollY != null) pageParams.set('scrollY', String(options.scrollY));
        // Propagate the maximize hint so the page-host FSM can boot directly
        // into MAXIMIZED — without this, session restore (and undo-close)
        // would lose the body class / handles / URL param sync.
        // See docs/page-host-state-machine.md.
        if (options.maximized === true) pageParams.set('maximized', '1');
        // Pre-maximize bounds: thread through so the page-host can populate
        // its renderer-side preMaximizeBounds at INIT, allowing unmaximize
        // (any time after restore) to restore to the size before the
        // original maximize. Without this, doMaximize never ran and the
        // renderer has no bounds to unmaximize to.
        if (options.maximized === true) {
          const px = options.preMaxX, py = options.preMaxY,
                pw = options.preMaxWidth, ph = options.preMaxHeight;
          if (typeof px === 'number' && typeof py === 'number'
            && typeof pw === 'number' && typeof ph === 'number') {
            pageParams.set('preX', String(px));
            pageParams.set('preY', String(py));
            pageParams.set('preWidth', String(pw));
            pageParams.set('preHeight', String(ph));
          }
        }
        // Chrome gate: callers that want to skip page-host chrome init at boot
        // (page-widget host, notes/tags/entities subscriptions, per-navigation
        // chrome work) pass `chrome: false`. The page-host renderer reads
        // `chrome=0` and queues chrome work until first focus. Default is
        // chrome on, so direct opens (cmd panel, popups) are unaffected.
        if (options.chrome === false) pageParams.set('chrome', '0');
        loadUrl = `peek://app/page/index.html?${pageParams.toString()}`;
        DEBUG && console.log('Routing web page through peek://app/page:', url, '->', loadUrl);

        // Window bounds were already set correctly before creation (to avoid flash).
        // Just set the transparent background.
        if (!isHeadless()) {
          win.setBackgroundColor('#00000000');
          DEBUG && console.log('Minimal page host: webview bounds', { x: webviewX, y: webviewY, width: webviewW, height: webviewH });
        }
      }

      // Add to window manager with modal parameter
      // Note: isTransient was determined BEFORE window creation (at top of handler)
      // to avoid the race condition where the new window becomes focused before we check
      // Role + parentWindowId were derived earlier (just before the Spaces
      // dispatch) using ./izui-roles.ts. Re-bound here for the registration
      // payload below.
      const parentWindowId = parentWindowIdForRole;

      console.log('[izui] Window role:', role, 'for:', url);

      // `placement` was derived earlier (in Group B fresh-open
      // positioning) and the same value is recorded on the registry
      // here so reuse paths + display-watcher can consume it.
      const windowParams: Record<string, unknown> = {
        ...options,
        address: url,
        transient: isTransient,
        parentWindowId,
        role,
        placement,
      };
      // Seed canvas state (x/y/width/height + maximized) on the registry
      // entry from the resolved canvas webview bounds. This is the source
      // of truth for session save and the close-undo handler — the page-host
      // renderer keeps it current via tile:window:update-canvas-state IPC.
      // Seeding here ensures the values are correct from the moment the
      // window registers, even before the renderer fires its first state
      // update (which only happens on a transition: resize end, drag end,
      // maximize, unmaximize).
      if (useCanvas && canvasWebviewBounds) {
        windowParams.x = canvasWebviewBounds.x;
        windowParams.y = canvasWebviewBounds.y;
        windowParams.width = canvasWebviewBounds.width;
        windowParams.height = canvasWebviewBounds.height;
        windowParams.maximized = options.maximized === true;
      }
      console.log('Adding window to manager:', win.id, 'escapeMode:', windowParams.escapeMode, 'modal:', windowParams.modal, 'keepLive:', windowParams.keepLive, 'transient:', isTransient, 'placement:', placement);
      registerWindow(win.id, msg.source, windowParams);
      const coordinator = getIzuiCoordinator();
      coordinator.pushWindow(win.id);

      // Set window mode based on URL — BEFORE loadURL so page.js can read it
      // For page containers (peek://app/page), extract the actual URL
      let modeUrl = url;
      if (url.startsWith('peek://app/page')) {
        try {
          const parsed = new URL(url);
          const actualUrl = parsed.searchParams.get('url');
          if (actualUrl) {
            modeUrl = actualUrl;
          }
        } catch {
          // Keep original URL
        }
      }

      // Check for explicit mode inheritance from options: spaceMode or groupMode.
      // If opener passed spaceMode/groupMode, set that mode explicitly.
      if (options.spaceMode) {
        const { spaceId, spaceName, color } = options.spaceMode;
        addContextEntry('mode', 'space', {
          windowId: win.id,
          source: msg.source,
          metadata: { spaceId, spaceName, color, url: modeUrl }
        });
        DEBUG && console.log('Inherited space mode for window:', win.id, 'space:', spaceName);
      } else if (options.groupMode) {
        const { groupId, groupName, color } = options.groupMode;
        addContextEntry('mode', 'group', {
          windowId: win.id,
          source: msg.source,
          metadata: { groupId, groupName, color, url: modeUrl }
        });
        DEBUG && console.log('Inherited group mode for window:', win.id, 'group:', groupName);
      } else {
        // No explicit mode option — check if opener is in space or group mode and inherit.
        let openerModeValue: string | null = null;
        let openerMetadata: Record<string, unknown> | null = null;
        let openerWindowId: number | null = null;
        const callingWin = windowFromWebContents(ev.sender);
        if (callingWin) {
          const openerContext = getContextEntry('mode', callingWin.id);
          if (
            openerContext &&
            (openerContext.value === 'space' || openerContext.value === 'group') &&
            openerContext.metadata
          ) {
            openerModeValue = openerContext.value as string;
            openerMetadata = openerContext.metadata as Record<string, unknown>;
            openerWindowId = openerContext.windowId as number;
          }
        }

        if (openerModeValue && openerMetadata) {
          // Inherit mode from opener (window lineage)
          addContextEntry('mode', openerModeValue, {
            windowId: win.id,
            source: msg.source,
            metadata: {
              ...openerMetadata,
              url: modeUrl,
              inheritedFrom: openerWindowId
            }
          });
          DEBUG && console.log(`Inherited ${openerModeValue} mode from opener`);
        } else {
          // No mode inheritance — only explicit spaceMode/groupMode option or direct
          // opener lineage propagates mode. Do NOT fall back to
          // lastFocusedVisibleWindowId, as that causes mode leakage to unrelated
          // windows (external app opens, peeks, slides, etc.)
          const detectedMode = detectModeFromUrl(modeUrl);
          addContextEntry('mode', detectedMode, {
            windowId: win.id,
            source: msg.source,
            metadata: { url: modeUrl }
          });
        }
      }

      // Log the detected mode
      const detectedMode = detectModeFromUrl(modeUrl);
      DEBUG && console.log('Set window mode:', win.id, 'url:', modeUrl, 'mode:', detectedMode);

      // Register did-attach-webview BEFORE loadURL so we don't miss the event.
      // The webview attaches during loadURL, so if we register after, the event is missed
      // and Cmd+L / window.open handlers never get wired up on the guest webContents.
      //
      // Handle window.open() / target="_blank" from <webview> guest webContents.
      // The host BrowserWindow loads peek://app/page/index.html which contains a <webview>.
      // Keystrokes and window.open() calls from web content go to the guest's webContents,
      // NOT the host's. We use did-attach-webview to intercept when the guest attaches
      // and set up a setWindowOpenHandler that routes popups through Peek's window system
      // instead of letting Electron create raw default BrowserWindows.
      //
      // Shared helper: open a popup URL in a proper Peek page host canvas window.
      // Used by both canvas webview popups and non-canvas page popups.
      async function openPopupInPageHost(popupUrl: string, openerWinId: number, openerSource: string, openerUrl?: string): Promise<void> {
        // Track the popup URL in history
        let popupItemId: string | undefined;
        try {
          const popupTrack = trackWindowLoad(popupUrl, {
            source: 'window-open',
            sourceId: openerUrl || popupUrl,
            windowType: 'main',
          });
          popupItemId = popupTrack.itemId;
          if (popupTrack.created) {
            publish('system', 'item:created', {
              itemId: popupTrack.itemId,
              itemType: 'url',
              content: popupUrl,
              windowId: openerWinId
            });
          }
        } catch (e) {
          DEBUG && console.log('Failed to track webview popup:', e);
        }

        // Inherit space mode from parent window if applicable
        let spaceMode: { spaceId: string; spaceName: string; color: string } | undefined = undefined;
        const parentContext = getContextEntry('mode', openerWinId);
        if (parentContext && parentContext.value === 'space' && parentContext.metadata) {
          spaceMode = {
            spaceId: parentContext.metadata.spaceId as string,
            spaceName: parentContext.metadata.spaceName as string,
            color: parentContext.metadata.color as string,
          };
        }

        // Build page container URL (includes openerUrl for the bridge shim)
        const openerWin = getLiveWindow(openerWinId);
        const parentBounds = openerWin ? openerWin.getBounds() : { x: 100, y: 100, width: 1024, height: 768 };
        const pageParams = new URLSearchParams({
          url: popupUrl,
          x: String(parentBounds.x + 30),
          y: String(parentBounds.y + 30),
          width: String(1024),
          height: String(768),
          ...(openerUrl ? { openerUrl } : {}),
        });
        const loadUrl = `peek://app/page/index.html?${pageParams.toString()}`;

        // Determine IZUI session state for transient detection
        const coordinator = getIzuiCoordinator();
        const isTransient = coordinator.isTransient();
        coordinator.evaluateOnShow();

        // Use profile-specific session for isolation
        const profileSession = getProfileSession();

        // Mint a trustedBuiltin token for this popup canvas page host window.
        const popupEntryId = `canvas-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const popupGrant = createTrustedBuiltinGrant(PAGE_HOST_TILE_ID);
        const popupToken = generateToken(PAGE_HOST_TILE_ID, popupEntryId, popupGrant);

        // Create the new BrowserWindow (page container) with fullscreen canvas.
        // webPreferences explicitly enforce isolation policy: sandbox + context-
        // isolation must be set so the entry.ts SECURITY chokepoint passes and
        // so this popup is no weaker than the canonical createTileBrowserWindow
        // path. (Previously these were unset and inherited Electron defaults,
        // which left the popup unsandboxed.)
        const popupWin = new BrowserWindow({
          frame: false,
          width: 1024,
          height: 768,
          x: parentBounds.x + 30,
          y: parentBounds.y + 30,
          show: isHeadless() ? false : true,
          transparent: true,
          webPreferences: {
            preload: getTilePreloadPath(),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            additionalArguments: [
              `--tile-id=${PAGE_HOST_TILE_ID}`,
              `--tile-entry=${popupEntryId}`,
              `--tile-token=${popupToken}`,
            ],
            session: profileSession,
            webviewTag: true,
            devTools: true,
          },
        });

        // Register popup with the tile broadcaster for pubsub forwarding.
        registerTrustedBuiltinWindow(PAGE_HOST_TILE_ID, popupEntryId, popupWin, popupToken);

        // Set up fullscreen transparent canvas for the popup
        if (!isHeadless()) {
          const popupDisplay = screen.getDisplayNearestPoint({ x: parentBounds.x + 30, y: parentBounds.y + 30 });
          const { width: psw, height: psh } = popupDisplay.workAreaSize;
          const { x: pdx, y: pdy } = popupDisplay.workArea;
          popupWin.setSize(psw, psh);
          popupWin.setPosition(pdx, pdy);
          popupWin.setBackgroundColor('#00000000');
        }

        // Register in window manager with proper IZUI role.
        //
        // Phase 2: webview popups are spawned from a real parent (the opener
        // is a content window) and lack any caller-supplied positioning,
        // so they map to `parent-centered`. The fullscreen-canvas resize
        // happens immediately above, but the placement intent is still
        // "this window belongs with its parent." Phase 3 / 5 may revisit
        // — for now, just record the intent so consumers don't see undefined.
        const popupPlacement: Placement = { mode: 'parent-centered', parentId: openerWinId };
        const popupParams: Record<string, unknown> = {
          address: popupUrl,
          transient: isTransient,
          parentWindowId: openerWinId,
          role: 'child-content',
          placement: popupPlacement,
        };
        if (spaceMode) {
          popupParams.spaceMode = spaceMode;
        }
        registerWindow(popupWin.id, openerSource, popupParams);
        trackWindow(popupWin);
        coordinator.pushWindow(popupWin.id);

        // Set mode context (inherit group mode or detect from URL)
        if (spaceMode) {
          addContextEntry('mode', 'space', {
            windowId: popupWin.id,
            source: openerSource,
            metadata: { ...spaceMode, url: popupUrl, inheritedFrom: openerWinId },
          });
        } else {
          const detectedMode = detectModeFromUrl(popupUrl);
          addContextEntry('mode', detectedMode, {
            windowId: popupWin.id,
            source: openerSource,
            metadata: { url: popupUrl },
          });
        }

        // Store popup-to-opener mapping for the postMessage bridge
        popupToOpener.set(popupWin.id, openerWinId);
        popupWin.on('closed', () => {
          popupToOpener.delete(popupWin.id);
          DEBUG && console.log(`[webview-popup] Cleaned up opener mapping for popup ${popupWin.id}`);
        });

        // Register did-attach-webview BEFORE loadURL so we don't miss the event.
        // Same pattern as the main window — the webview guest attaches during loadURL,
        // so handlers registered after loadURL may miss the did-attach-webview event.
        // Without this, Cmd+L and other keyboard shortcuts don't work in popup windows
        // because keystrokes inside the webview go to the guest webContents, not the host.
        popupWin.webContents.on('did-attach-webview', (_event, guestWebContents) => {
          console.log(`[webview-popup] Guest webContents attached to popup ${popupWin.id}, adding keyboard shortcuts`);

          // Register download handler on the guest's own session. Electron's
          // `will-download` fires on the session that owns the webContents,
          // not the parent BrowserWindow's session. A <webview> gets its
          // session from its `partition` attribute (set async by page.js),
          // which may be a different Session instance than the host window's
          // `profileSession`. Without registering here, downloads that abort
          // navigation leave the popup stuck with no page and no cleanup.
          // `registerDownloadHandler` is idempotent via WeakSet tracking.
          try {
            registerDownloadHandler(guestWebContents.session);
          } catch (e) {
            console.log('[webview-popup] Failed to register download handler on guest session:', e);
          }

          // Keyboard shortcuts inside the webview guest for page navigation.
          // Page-specific shortcuts (cmd+L, cmd+R, etc.) are handled inline.
          // Anything else falls through to handleLocalShortcut so global
          // shortcuts (cmd+shift+T undo-close, cmd+N new window) work even
          // when the user's focus is inside the webpage they're reading.
          guestWebContents.on('before-input-event', (event, input) => {
            const modifier = process.platform === 'darwin' ? input.meta : input.control;
            if (input.type !== 'keyDown' || !modifier) return;
            if (input.key === 'l') {
              publish('peek://system/', 'page:show-navbar', { windowId: popupWin.id });
              event.preventDefault();
            } else if (input.key === 'r') {
              publish('peek://system/', 'page:reload', { windowId: popupWin.id });
              event.preventDefault();
            } else if (input.key === 'f') {
              publish('peek://system/', 'page:find', { windowId: popupWin.id });
              event.preventDefault();
            } else if (input.key === 'g' && input.shift) {
              publish('peek://system/', 'page:find-prev', { windowId: popupWin.id });
              event.preventDefault();
            } else if (input.key === 'g') {
              publish('peek://system/', 'page:find-next', { windowId: popupWin.id });
              event.preventDefault();
            } else if (input.key === '[' || (input.key === 'ArrowLeft' && !input.shift)) {
              publish('peek://system/', 'page:go-back', { windowId: popupWin.id });
              event.preventDefault();
            } else if (input.key === ']' || (input.key === 'ArrowRight' && !input.shift)) {
              publish('peek://system/', 'page:go-forward', { windowId: popupWin.id });
              event.preventDefault();
            } else if (handleLocalShortcut(input, popupWin.id)) {
              event.preventDefault();
            }
          });

          // Update item title when webview guest page title changes
          guestWebContents.on('page-title-updated', (_event: Electron.Event, title: string) => {
            if (title && title !== 'Loading...') {
              const guestUrl = guestWebContents.getURL();
              if (guestUrl && guestUrl.startsWith('http')) {
                try {
                  updateItemTitle(guestUrl, title);
                } catch (e) {
                  DEBUG && console.log('Failed to update title from popup guest page-title-updated:', e);
                }
                publish('system', 'page:content-ready', {
                  url: guestUrl,
                  title,
                  windowId: popupWin.id,
                });
              }
            }
          });

          // Capture favicon when webview guest page provides one
          guestWebContents.on('page-favicon-updated', (_event: Electron.Event, favicons: string[]) => {
            const guestUrl = guestWebContents.getURL();
            if (guestUrl && guestUrl.startsWith('http') && favicons.length > 0) {
              const best = favicons.find(f => f.endsWith('.svg')) ||
                           favicons.find(f => f.endsWith('.png')) ||
                           favicons[favicons.length - 1];
              try {
                updateItemFavicon(guestUrl, best);
              } catch (e) {
                DEBUG && console.log('Failed to update favicon from popup guest page-favicon-updated:', e);
              }
            }
          });

          // Capture thumbnail after page finishes loading (popup webview guest)
          guestWebContents.on('did-stop-loading', () => {
            const guestUrl = guestWebContents.getURL();
            if (guestUrl && (guestUrl.startsWith('http://') || guestUrl.startsWith('https://'))) {
              setTimeout(() => {
                if (guestWebContents.isDestroyed()) return;
                captureThumbnail(guestWebContents, guestUrl).then((hash) => {
                  if (hash) {
                    try { updateItemThumbnail(guestUrl, hash); } catch (e) {
                      DEBUG && console.log('Failed to update thumbnail from popup guest:', e);
                    }
                  }
                });
              }, 1500);
            }
          });

          // Handle window.open() from popup's webview guest
          guestWebContents.setWindowOpenHandler(({ url: nestedPopupUrl }) => {
            if (nestedPopupUrl.startsWith('http://') || nestedPopupUrl.startsWith('https://')) {
              console.log(`[webview-popup] Intercepted nested popup from popup ${popupWin.id}: ${nestedPopupUrl}`);
              const parentInfo = getWindowInfo(popupWin.id);
              const source = parentInfo ? parentInfo.source : 'system';
              let currentUrl = popupUrl;
              try {
                currentUrl = guestWebContents.getURL() || popupUrl;
              } catch (e) {
                DEBUG && console.log('[webview-popup] Failed to get popup guest URL:', e);
              }
              (async () => {
                try {
                  await openPopupInPageHost(nestedPopupUrl, popupWin.id, source, currentUrl);
                } catch (e) {
                  console.error('[webview-popup] Failed to create nested popup window:', e);
                }
              })();
              return { action: 'deny' };
            }
            return { action: 'allow' };
          });

          // Context menu for links and selected text in the popup webview guest
          guestWebContents.on('context-menu', (_event, params) => {
            const menuItems: Electron.MenuItemConstructorOptions[] = [];

            if (params.linkURL) {
              menuItems.push({
                label: 'Copy Link',
                click: () => clipboard.writeText(params.linkURL),
              });
              menuItems.push({
                label: 'Open Link in New Window',
                click: () => {
                  const parentInfo = getWindowInfo(popupWin.id);
                  const source = parentInfo ? parentInfo.source : 'system';
                  let currentUrl = popupUrl;
                  try {
                    currentUrl = guestWebContents.getURL() || popupUrl;
                  } catch (e) {
                    DEBUG && console.log('[context-menu] Failed to get popup guest URL:', e);
                  }
                  openPopupInPageHost(params.linkURL, popupWin.id, source, currentUrl).catch(e => {
                    console.error('[context-menu] Failed to open link in new window:', e);
                  });
                },
              });
            }

            if (params.selectionText) {
              menuItems.push({
                label: 'Copy',
                click: () => clipboard.writeText(params.selectionText),
              });
            }

            if (menuItems.length > 0) {
              const menu = Menu.buildFromTemplate(menuItems);
              menu.popup();
            }
          });
        });

        // Host-level keyboard shortcut fallback (fires when page container DOM has focus,
        // e.g., before webview loads or if user clicks outside the webview)
        popupWin.webContents.on('before-input-event', (event, input) => {
          const modifier = process.platform === 'darwin' ? input.meta : input.control;
          if (input.type !== 'keyDown' || !modifier) return;
          if (input.key === 'l') {
            publish('peek://system/', 'page:show-navbar', { windowId: popupWin.id });
            event.preventDefault();
          } else if (input.key === 'r') {
            publish('peek://system/', 'page:reload', { windowId: popupWin.id });
            event.preventDefault();
          } else if (input.key === 'f') {
            publish('peek://system/', 'page:find', { windowId: popupWin.id });
            event.preventDefault();
          } else if (input.key === 'g' && input.shift) {
            publish('peek://system/', 'page:find-prev', { windowId: popupWin.id });
            event.preventDefault();
          } else if (input.key === 'g') {
            publish('peek://system/', 'page:find-next', { windowId: popupWin.id });
            event.preventDefault();
          } else if (input.key === '[' || (input.key === 'ArrowLeft' && !input.shift)) {
            publish('peek://system/', 'page:go-back', { windowId: popupWin.id });
            event.preventDefault();
          } else if (input.key === ']' || (input.key === 'ArrowRight' && !input.shift)) {
            publish('peek://system/', 'page:go-forward', { windowId: popupWin.id });
            event.preventDefault();
          }
        });

        // Add ESC handler BEFORE loadURL to avoid missing did-attach-webview
        addEscHandler(popupWin);

        // Load the page container URL
        await popupWin.loadURL(loadUrl);

        console.log(`[webview-popup] Created Peek window ${popupWin.id} for popup: ${popupUrl}`);
      }

      // Also adds Cmd+L interception on guest webContents for the floating navbar.
      // (Keystrokes inside the webview never reach the host's before-input-event.)
      // Only canvas pages have a <webview> guest — set up popup/Cmd+L handlers
      if (useCanvas) {
        win.webContents.on('did-attach-webview', (_event, guestWebContents) => {
          console.log(`[webview-popup] Guest webContents attached to window ${win.id}, adding setWindowOpenHandler + Cmd+L`);

          // Register download handler on the guest's own session. See the
          // equivalent comment in the popup's did-attach-webview handler
          // above — downloads from a <webview> guest fire `will-download`
          // on the guest's session, which may differ from profileSession
          // depending on how the webview's partition attribute was set.
          try {
            registerDownloadHandler(guestWebContents.session);
          } catch (e) {
            console.log('[webview-popup] Failed to register download handler on guest session:', e);
          }

          // Keyboard shortcuts inside the webview guest for page navigation.
          // Page-specific shortcuts (cmd+L, cmd+R, etc.) are handled inline.
          // Anything else falls through to handleLocalShortcut so global
          // shortcuts (cmd+shift+T undo-close, cmd+N new window) work even
          // when the user's focus is inside the webpage they're reading.
          guestWebContents.on('before-input-event', (event, input) => {
            const modifier = process.platform === 'darwin' ? input.meta : input.control;
            if (input.type !== 'keyDown' || !modifier) return;
            if (input.key === 'l') {
              publish('peek://system/', 'page:show-navbar', { windowId: win.id });
              event.preventDefault();
            } else if (input.key === 'r') {
              publish('peek://system/', 'page:reload', { windowId: win.id });
              event.preventDefault();
            } else if (input.key === 'f') {
              publish('peek://system/', 'page:find', { windowId: win.id });
              event.preventDefault();
            } else if (input.key === 'g' && input.shift) {
              publish('peek://system/', 'page:find-prev', { windowId: win.id });
              event.preventDefault();
            } else if (input.key === 'g') {
              publish('peek://system/', 'page:find-next', { windowId: win.id });
              event.preventDefault();
            } else if (input.key === '[' || (input.key === 'ArrowLeft' && !input.shift)) {
              publish('peek://system/', 'page:go-back', { windowId: win.id });
              event.preventDefault();
            } else if (input.key === ']' || (input.key === 'ArrowRight' && !input.shift)) {
              publish('peek://system/', 'page:go-forward', { windowId: win.id });
              event.preventDefault();
            } else if (handleLocalShortcut(input, win.id)) {
              event.preventDefault();
            }
          });

          // Update item title when webview guest page title changes.
          // This is the main-process counterpart to page.js's page-title-updated handler.
          // Runs in main process for reliability — handles title updates even if page.js
          // has timing issues with the IPC call.
          guestWebContents.on('page-title-updated', (_event: Electron.Event, title: string) => {
            if (title && title !== 'Loading...') {
              const guestUrl = guestWebContents.getURL();
              if (guestUrl && guestUrl.startsWith('http')) {
                try {
                  updateItemTitle(guestUrl, title);
                } catch (e) {
                  DEBUG && console.log('Failed to update title from guest page-title-updated:', e);
                }
                // Notify extensions that page content is available for extraction
                publish('system', 'page:content-ready', {
                  url: guestUrl,
                  title,
                  windowId: win.id,
                });
              }
            }
          });

          // Capture favicon when webview guest page provides one
          guestWebContents.on('page-favicon-updated', (_event: Electron.Event, favicons: string[]) => {
            const guestUrl = guestWebContents.getURL();
            if (guestUrl && guestUrl.startsWith('http') && favicons.length > 0) {
              // Prefer PNG/SVG over ICO, pick last (usually highest resolution)
              const best = favicons.find(f => f.endsWith('.svg')) ||
                           favicons.find(f => f.endsWith('.png')) ||
                           favicons[favicons.length - 1];
              try {
                updateItemFavicon(guestUrl, best);
              } catch (e) {
                DEBUG && console.log('Failed to update favicon from guest page-favicon-updated:', e);
              }
            }
          });

          // Capture thumbnail after page finishes loading (canvas webview guest)
          guestWebContents.on('did-stop-loading', () => {
            const guestUrl = guestWebContents.getURL();
            if (guestUrl && (guestUrl.startsWith('http://') || guestUrl.startsWith('https://'))) {
              setTimeout(() => {
                if (guestWebContents.isDestroyed()) return;
                captureThumbnail(guestWebContents, guestUrl).then((hash) => {
                  if (hash) {
                    try { updateItemThumbnail(guestUrl, hash); } catch (e) {
                      DEBUG && console.log('Failed to update thumbnail from canvas guest:', e);
                    }
                  }
                });
              }, 1500);
            }
          });

          guestWebContents.setWindowOpenHandler(({ url: popupUrl }) => {
            if (popupUrl.startsWith('http://') || popupUrl.startsWith('https://')) {
              console.log(`[webview-popup] Intercepted popup from window ${win.id}: ${popupUrl}`);

              // Get the source and opener URL for the shared handler
              const parentInfo = getWindowInfo(win.id);
              const source = parentInfo ? parentInfo.source : 'system';
              let openerUrl = url; // fallback to the registered URL
              try {
                openerUrl = guestWebContents.getURL() || url;
              } catch (e) {
                DEBUG && console.log('[webview-popup] Failed to get opener URL:', e);
              }

              // Open asynchronously — create a proper Peek page container window.
              (async () => {
                try {
                  await openPopupInPageHost(popupUrl, win.id, source, openerUrl);
                } catch (e) {
                  console.error('[webview-popup] Failed to create popup window:', e);
                }
              })();

              // Deny the default BrowserWindow creation
              return { action: 'deny' };
            }

            // Allow non-http(s) URLs (e.g. about:blank) to open normally
            return { action: 'allow' };
          });

          // Track guest navigation so undo-close restores the actual URL the user was viewing
          guestWebContents.on('did-navigate', (_event: Electron.Event, navUrl: string) => {
            if (navUrl && (navUrl.startsWith('http://') || navUrl.startsWith('https://'))) {
              const winInfo = getWindowInfo(win.id);
              if (winInfo) {
                winInfo.params.currentUrl = navUrl;
              }
            }
          });
          guestWebContents.on('did-navigate-in-page', (_event: Electron.Event, navUrl: string, isMainFrame: boolean) => {
            if (isMainFrame && navUrl && (navUrl.startsWith('http://') || navUrl.startsWith('https://'))) {
              const winInfo = getWindowInfo(win.id);
              if (winInfo) {
                winInfo.params.currentUrl = navUrl;
              }
            }
          });

          // Context menu for links and selected text in the webview guest
          guestWebContents.on('context-menu', (_event, params) => {
            const menuItems: Electron.MenuItemConstructorOptions[] = [];

            if (params.linkURL) {
              menuItems.push({
                label: 'Copy Link',
                click: () => clipboard.writeText(params.linkURL),
              });
              menuItems.push({
                label: 'Open Link in New Window',
                click: () => {
                  const parentInfo = getWindowInfo(win.id);
                  const source = parentInfo ? parentInfo.source : 'system';
                  let openerUrl = url;
                  try {
                    openerUrl = guestWebContents.getURL() || url;
                  } catch (e) {
                    DEBUG && console.log('[context-menu] Failed to get opener URL:', e);
                  }
                  openPopupInPageHost(params.linkURL, win.id, source, openerUrl).catch(e => {
                    console.error('[context-menu] Failed to open link in new window:', e);
                  });
                },
              });
            }

            if (params.selectionText) {
              menuItems.push({
                label: 'Copy',
                click: () => clipboard.writeText(params.selectionText),
              });
            }

            if (menuItems.length > 0) {
              const menu = Menu.buildFromTemplate(menuItems);
              menu.popup();
            }
          });
        });
      }

      // Add keyboard shortcuts on the HOST webContents as a fallback.
      // The primary handlers are on the webview guest (added via did-attach-webview above).
      // These host-level handlers fire when the page container's own DOM has focus (rare,
      // but possible before the webview loads or if the user clicks outside the webview).
      if (useCanvas) {
        win.webContents.on('before-input-event', (event, input) => {
          const modifier = process.platform === 'darwin' ? input.meta : input.control;
          if (input.type !== 'keyDown' || !modifier) return;
          if (input.key === 'l') {
            publish('peek://system/', 'page:show-navbar', { windowId: win.id });
            event.preventDefault();
          } else if (input.key === 'r') {
            publish('peek://system/', 'page:reload', { windowId: win.id });
            event.preventDefault();
          } else if (input.key === 'f') {
            publish('peek://system/', 'page:find', { windowId: win.id });
            event.preventDefault();
          } else if (input.key === 'g' && input.shift) {
            publish('peek://system/', 'page:find-prev', { windowId: win.id });
            event.preventDefault();
          } else if (input.key === 'g') {
            publish('peek://system/', 'page:find-next', { windowId: win.id });
            event.preventDefault();
          } else if (input.key === '[' || (input.key === 'ArrowLeft' && !input.shift)) {
            publish('peek://system/', 'page:go-back', { windowId: win.id });
            event.preventDefault();
          } else if (input.key === ']' || (input.key === 'ArrowRight' && !input.shift)) {
            publish('peek://system/', 'page:go-forward', { windowId: win.id });
            event.preventDefault();
          }
        });
      }

      // Load the URL AFTER mode/context is set, so page.js can read inherited mode
      console.log(`[page-host:${win.id}] Loading: ${loadUrl.substring(0, 120)}`);
      perfMark('before-loadURL');
      // Session-restore opens (skipTracking=true) don't await the load —
      // they fire-and-forget so the restore loop can move on to the next
      // window immediately. Pages load in parallel in the background; the
      // restore wall-clock drops from N × per-window-load-time to N × the
      // ~15-25ms BrowserWindow construction overhead. Errors are logged
      // but not propagated since there's no consumer to report to. Other
      // callers (cmd panel opens, popups, slides) keep the await so they
      // get error-propagation and "ready" semantics they may depend on.
      if (options.skipTracking) {
        win.loadURL(loadUrl).catch((err) => {
          DEBUG && console.log(`[page-host:${win.id}] background loadURL failed:`, err);
        });
      } else {
        await win.loadURL(loadUrl);
      }
      perfMark('after-loadURL');
      console.log(`[page-host:${win.id}] loadURL ${options.skipTracking ? 'dispatched' : 'resolved'}`);

      // Background detection for non-canvas web pages (slides, modals, quick-views).
      // Canvas pages get this via the webview dom-ready handler in page.js.
      // Non-canvas pages load directly in the BrowserWindow, so we detect here.
      // Without this, pages that don't set a background show dark text on a dark
      // BrowserWindow backgroundColor — unreadable in dark mode.
      if (isWebPage && !useCanvas) {
        win.webContents.on('dom-ready', async () => {
          try {
            const needsBackground = await win.webContents.executeJavaScript(`
              (function() {
                function isTransparentColor(color) {
                  if (!color) return true;
                  if (color === 'transparent') return true;
                  if (color === 'rgba(0, 0, 0, 0)') return true;
                  var rgbaMatch = color.match(/rgba\\s*\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*([\\d.]+)\\s*\\)/);
                  if (rgbaMatch && parseFloat(rgbaMatch[1]) === 0) return true;
                  return false;
                }
                function hasBackground(el) {
                  if (!el) return false;
                  var style = window.getComputedStyle(el);
                  var bgColor = style.backgroundColor;
                  var hasColor = !isTransparentColor(bgColor);
                  var bgImage = style.backgroundImage;
                  var hasImage = bgImage && bgImage !== 'none';
                  return hasColor || hasImage;
                }
                var html = document.documentElement;
                var body = document.body;
                return !(hasBackground(html) || hasBackground(body));
              })();
            `);
            if (needsBackground) {
              await win.webContents.executeJavaScript(`
                document.documentElement.style.backgroundColor = '#ffffff';
              `);
              DEBUG && console.log('[non-canvas-bg] No background detected, set default white for window:', win.id);
            } else {
              DEBUG && console.log('[non-canvas-bg] Page has background, skipping default for window:', win.id);
            }
          } catch (err) {
            console.error('[non-canvas-bg] Failed to check/set background:', err);
          }
        });
      }

      // Popup handler for non-canvas web pages (modals, overlays, slides, quick-views).
      // Canvas pages get this via the webview guest's setWindowOpenHandler above.
      // Non-canvas pages load directly in the BrowserWindow, so we intercept popups here.
      if (isWebPage && !useCanvas) {
        win.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
          if (popupUrl.startsWith('http://') || popupUrl.startsWith('https://')) {
            console.log(`[non-canvas-popup] Intercepted popup from window ${win.id}: ${popupUrl}`);

            const parentInfo = getWindowInfo(win.id);
            const source = parentInfo ? parentInfo.source : 'system';

            (async () => {
              try {
                await openPopupInPageHost(popupUrl, win.id, source, url);
              } catch (e) {
                DEBUG && console.log('[non-canvas-popup] Failed to open popup in page host:', e);
              }
            })();

            return { action: 'deny' };
          }

          // Allow non-http(s) URLs (about:blank, data:, etc.) to open normally
          return { action: 'allow' };
        });
      }

      // Update item titles when the page finishes loading (non-canvas web pages).
      // Canvas pages have a guest webContents handler via did-attach-webview (registered above, before loadURL).
      // Non-canvas pages (modals, slides, quick-views) load directly in the BrowserWindow.
      if (isWebPage && !useCanvas && !url.startsWith('peek://')) {
        win.webContents.on('page-title-updated', (_event: Electron.Event, title: string) => {
          if (title && title !== 'Loading...') {
            const pageUrl = win.webContents.getURL() || url;
            try {
              updateItemTitle(pageUrl, title);
            } catch (e) {
              DEBUG && console.log('Failed to update title from page-title-updated:', e);
            }
            // Notify extensions that page content is available for extraction
            publish('system', 'page:content-ready', {
              url: pageUrl,
              title,
              windowId: win.id,
            });
          }
        });

        // Capture favicon for non-canvas web pages
        win.webContents.on('page-favicon-updated', (_event: Electron.Event, favicons: string[]) => {
          const pageUrl = win.webContents.getURL() || url;
          if (pageUrl && pageUrl.startsWith('http') && favicons.length > 0) {
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

        // Capture thumbnail for non-canvas web pages
        win.webContents.on('did-stop-loading', () => {
          const pageUrl = win.webContents.getURL() || url;
          if (pageUrl && (pageUrl.startsWith('http://') || pageUrl.startsWith('https://'))) {
            setTimeout(() => {
              // Window may have been closed during the 1.5s delay
              // (e.g. user closed a peek immediately after open).
              if (win.isDestroyed() || win.webContents.isDestroyed()) return;
              captureThumbnail(win.webContents, pageUrl).then((hash) => {
                if (hash) {
                  try { updateItemThumbnail(pageUrl, hash); } catch (e) {
                    DEBUG && console.log('Failed to update thumbnail from non-canvas page:', e);
                  }
                }
              });
            }, 1500);
          }
        });
      }

      // Capture thumbnail for peek:// windows (settings, features manager,
      // lists, etc.) so they appear with real screenshots in the Windows
      // feature card grid instead of plain placeholder squares. The
      // thumbnail file is stored under userData/thumbnails/<urlHash>.jpg;
      // the window-presenter computes the same hash on read and surfaces
      // it via `peek://thumbnail/<hash>.jpg`. There's no item record to
      // update — for peek:// URLs the hash is derived deterministically
      // from the URL itself.
      //
      // Transient roles (palette, quick-view, overlay) are skipped:
      //   - cmd panel UI changes every keystroke, so any captured frame
      //     is stale by the time it's seen
      //   - quick-view / overlay windows close before the user could
      //     navigate to them in the Windows feature anyway
      //   - it also avoids running webContents.capturePage on the cmd
      //     panel mid-test, which has historically been a flaky surface
      if (url.startsWith('peek://') && !TRANSIENT_ROLES.has(role)) {
        win.webContents.on('did-stop-loading', () => {
          const pageUrl = win.webContents.getURL() || url;
          if (!pageUrl.startsWith('peek://')) return;
          setTimeout(() => {
            if (win.isDestroyed() || win.webContents.isDestroyed()) return;
            captureThumbnail(win.webContents, pageUrl).catch((e) => {
              DEBUG && console.log('Failed to capture thumbnail for peek:// window:', e);
            });
          }, 1500);
        });
      }

      // Track this load in history (skip internal peek:// URLs and session restores)
      if (!url.startsWith('peek://') && !options.skipTracking) {
        try {
          const trackResult = trackWindowLoad(url, {
            source: options.trackingSource || options.feature || 'window',
            sourceId: options.trackingSourceId || '',
            windowType: options.modal ? 'modal' : 'main',
            title: options.title || (win.getTitle() !== 'Loading...' ? win.getTitle() : '') || '',
          });
          if (trackResult.created) {
            publish('system', 'item:created', {
              itemId: trackResult.itemId,
              itemType: 'url',
              content: url,
              windowId: win.id
            });
          }
        } catch (e) {
          DEBUG && console.log('Failed to track window load:', e);
        }
      }

      // Track in-page navigation (link clicks within the window)
      // Skip tracking for peek:// URLs - these are internal (container pages, etc.)
      // Web pages inside peek://app/page container handle their own tracking via webview events
      win.webContents.on('did-navigate', (_event: Electron.Event, navUrl: string) => {
        // Skip if it's the same URL we just loaded
        if (navUrl === url) return;
        // Skip internal peek:// URLs
        if (navUrl.startsWith('peek://')) return;
        // Skip ephemeral loopback callback URLs (e.g. OAuth callbacks to 127.0.0.1)
        try {
          const navParsed = new URL(navUrl);
          if ((navParsed.hostname === '127.0.0.1' || navParsed.hostname === 'localhost') &&
              navParsed.pathname.includes('/callback')) {
            return;
          }
        } catch {}

        // Session-restored windows carry options.skipTracking=true. We
        // skipped the initial load above; also skip the FIRST redirect-
        // driven did-navigate that fires before the user has interacted.
        // Clear the flag after consuming so subsequent user-initiated
        // navigations from the same window are tracked normally.
        if (options.skipTracking) {
          options.skipTracking = false;
          return;
        }

        try {
          const navTrack = trackWindowLoad(navUrl, {
            source: 'navigation',
            sourceId: '',
            windowType: options.modal ? 'modal' : 'main',
            title: (win.getTitle() !== 'Loading...' ? win.getTitle() : '') || '',
          });
          if (navTrack.created) {
            publish('system', 'item:created', {
              itemId: navTrack.itemId,
              itemType: 'url',
              content: navUrl,
              windowId: win.id
            });
          }
        } catch (e) {
          DEBUG && console.log('Failed to track did-navigate:', e);
        }
      });

      // Add escape key handler to all windows
      addEscHandler(win);

      // Track content window focus for devtools command
      win.on('focus', () => {
        console.log(`[focus-tracker] win.on(focus) fired id=${win.id}`);
        trackContentWindowFocus(win);
        // Only track non-modal windows for visible window targeting
        // Modal windows (like cmd palette) shouldn't override the target window
        const winInfo = getWindowInfo(win.id);
        if (!winInfo?.params?.modal) {
          trackVisibleWindowFocus(win);
        }
        // Update IZUI coordinator focus tracking (skip modal and overlay windows)
        if (!winInfo?.params?.modal && winInfo?.params?.role !== 'overlay') {
          const coordinator = getIzuiCoordinator();
          coordinator.setFocusedWindow(win.id);
        }
        // Notify HUD and other listeners that a window gained focus.
        // Include `role` so subscribers (e.g. cmd panel's auto-hide-on-
        // other-window-focus) can filter out utility children (chain
        // popup, etc.) without another round-trip.
        publish(getSystemAddress(), 'window:focused', {
          id: win.id,
          role: winInfo?.params?.role as string | undefined,
        });

        // Auto-hide sibling transient windows when another window gains
        // focus. IZUI policy: palette / quick-view / overlay windows are
        // transient — they should dismiss as soon as focus moves to any
        // other window. The per-window `blur` handler attached to modals
        // covers Cmd+Tab and clicks into other apps, but macOS NSPanels
        // (type:'panel' + alwaysOnTop) don't fire reliable `blur` when
        // focus shifts to another panel-type window in the same app — so
        // opening slide B from edge X never closes slide A on edge Y. The
        // cmd panel restored this on the renderer side via a
        // `window:focused` subscription (commit 6361cf19); generalize it
        // here for all transient roles in the main process so we don't
        // need a per-feature renderer hook for every panel-style tile.
        //
        // Skip when the focusing window is itself transient/utility:
        //   - utility (chain popup) is a child of a transient and must
        //     not dismiss its parent
        //   - palette/quick-view/overlay focusing each other would cause
        //     the just-opened transient to immediately close itself in
        //     the wrong order; let the new transient stand and dismiss
        //     the previous one(s).
        const focusedRole = winInfo?.params?.role as string | undefined;
        if (focusedRole !== 'utility') {
          for (const other of getAllLiveWindows()) {
            if (other.id === win.id) continue;
            if (!other.isVisible()) continue;
            const otherInfo = getWindowInfo(other.id);
            const otherRole = otherInfo?.params?.role as string | undefined;
            if (!otherRole || !TRANSIENT_ROLES.has(otherRole)) continue;
            // Overlays manage their own restoration flow via the IZUI
            // coordinator — don't drive them through closeOrHideWindow.
            if (otherRole === 'overlay') continue;
            DEBUG && console.log('[izui] window-focused autoclose transient sibling:', other.id, 'role:', otherRole, 'focused:', win.id, 'role:', focusedRole);
            try {
              closeOrHideWindow(other.id);
            } catch (err) {
              DEBUG && console.log('[izui] autoclose transient failed:', err);
            }
          }
        }
      });
      // Also track immediately if this is a content/visible window (non-modal only)
      trackContentWindowFocus(win);
      if (!options.modal) {
        trackVisibleWindowFocus(win);
      }

      // Set up DevTools if requested
      winDevtoolsConfig(win);

      // Auto-open devtools for peek:// URLs in debug mode (not tests/headless)
      // This helps debug extension windows
      if (DEBUG && url.startsWith('peek://') && !isTestProfile() && !isHeadless()) {
        win.webContents.openDevTools({ mode: 'detach', activate: false });
      }

      // Set up modal behavior if requested
      // Delay blur handler attachment to avoid race condition where focus events
      // are still settling after window creation (can cause immediate close).
      //
      // Under Playwright (E2E_TEST=true), skip the close-on-blur handler
      // entirely. Parallel workers cause focus events to flicker between
      // windows in ways they don't in real user sessions, closing modal
      // cmd panels mid-test with "Target page, context or browser has
      // been closed" errors on the next .press() / .evaluate(). Gating on
      // `E2E_TEST` rather than `isTestProfile()` lets a developer run the
      // packaged app with `PROFILE=test-sandbox` (required to bypass the
      // single-instance lock for a manual smoke) and still see real
      // close-on-blur behaviour.
      if (options.modal === true && process.env.E2E_TEST !== 'true') {
        setTimeout(() => {
          if (!win.isDestroyed()) {
            win.on('blur', () => {
              // Don't close if focus moved to a child utility window (e.g., chain popup)
              const focused = BrowserWindow.getFocusedWindow();
              if (focused && !focused.isDestroyed()) {
                const focusedInfo = getWindowInfo(focused.id);
                if (focusedInfo?.params?.role === 'utility') {
                  DEBUG && console.log('window-open: blur for modal window suppressed — focus went to utility child', url);
                  return;
                }
                // Warn when focus jumped to a workspace child. Before the
                // ipc.ts:1182 default flipped from 'utility' to 'workspace',
                // an unmarked child window was implicitly utility and would
                // have hit the suppression above. If a feature spawned a
                // small "child utility" popup without declaring its role,
                // the modal will now close on blur instead of staying open.
                // Fix: that child needs `role: 'utility'` explicit.
                if (focusedInfo?.params?.role === 'workspace') {
                  console.warn(
                    `[window-open] modal "${url}" closing on blur — focus went to workspace child "${focusedInfo?.params?.address}". ` +
                    `If this is unexpected, the child window should declare role:'utility' explicitly ` +
                    `(was implicitly utility before the workspace-default change).`
                  );
                }
              }
              // Suppress spurious blurs that fire shortly after show. When a
              // keepLive modal NSPanel is (re-)shown — especially triggered
              // from another app via global hotkey — the macOS activation
              // policy change plus the `alwaysOnTop: 'floating'` window level
              // produces a brief focus dance that fires blur before focus
              // actually settles. Hiding during this window leaves the
              // NSPanel layer rendered even though `isVisible()` flips to
              // false. Re-focus instead. Original fix: commit 1b568d40.
              const showTime = (win as { __lastShowTime?: number }).__lastShowTime;
              if (showTime && Date.now() - showTime < 200) {
                DEBUG && console.log('window-open: blur for modal window suppressed — within show settle window', url);
                if (!win.isDestroyed()) {
                  win.focus();
                }
                return;
              }
              DEBUG && console.log('window-open: blur for modal window', url);
              closeOrHideWindow(win.id);
            });
          }
        }, 100);
      }

      // Maximize window if requested (fills screen without OS fullscreen).
      // Use explicit bounds instead of win.maximize() because panel-type
      // windows on macOS don't respond to maximize() properly. Route through
      // `computePlacement` against the window's own current display + an
      // oversize hint so the workArea-clamp produces a fill-the-screen
      // rectangle on whichever display the just-opened window actually sits
      // on — keeps every position decision flowing through the pure module.
      if (options.maximize === true && !isHeadless()) {
        const result = computePlacement({
          placement: { mode: 'centered' },
          currentBounds: win.getBounds(),
          windowSize: { width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER },
          displays: screen.getAllDisplays(),
          primaryDisplayId: screen.getPrimaryDisplay().id,
        });
        if (result.kind === 'reposition') {
          win.setBounds(result.bounds);
        }
      }

      // Overlay mode: the overlay window opens on top of existing windows
      // without hiding them. Previously we hid every other visible window
      // so the switcher rendered against an empty desktop, but that
      // created a Space-teleport bug on dismiss: when the user opened the
      // switcher on a Space with no other Peek windows present, every
      // visible Peek window was on a different Space — and macOS's
      // auto-key-window pick during overlay destruction would land on
      // one of them, yanking the user across Spaces. Rendering the
      // switcher with a semi-transparent + blurred backdrop (see
      // features/windows/windows.css) gives the visual separation
      // without hiding the underlying windows; on dismiss macOS auto-
      // picks from windows actually visible on the user's current Space.
      //
      // We still register with the IZUI coordinator (with an empty
      // hiddenWindowIds list) so the rest of the overlay-state plumbing
      // (escape policy, focus tracking) continues to work.
      if (options.overlay === true) {
        const winInfo = getWindowInfo(win.id);
        if (winInfo) {
          winInfo.params.overlayHiddenWindows = [];
        }
        const coordinator = getIzuiCoordinator();
        coordinator.enterOverlay(win.id, []);
      }

      // Notify HUD and other listeners that a window was opened
      publish(getSystemAddress(), 'window:opened', {
        id: win.id,
        url,
        source: msg.source
      });

      // Persist the now-larger window list so a force-kill before the
      // next autosave tick doesn't lose the newly opened window.
      // Gated on !skipTracking so bulk session-restore doesn't fire a
      // save per restored window — the periodic autosave covers that.
      if (!options.skipTracking) {
        scheduleSnapshotOnLifecycleChange();
      }

      // Clear pending key now that window is registered
      if (options.key) {
        pendingWindowKeys.delete(`${msg.source}:${options.key}`);
      }

      perfMark('return');
      return { success: true, id: win.id };
    } catch (error) {
      // Clear pending key on failure too
      if (options?.key) {
        pendingWindowKeys.delete(`${msg.source}:${options.key}`);
      }
      console.error('Failed to open window:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  };
  // The strict `tile:window:open` handler in tile-ipc.ts delegates to
  // `windowOpenHandler` (this implementation) — it's the single source of
  // truth for window creation.
  invokeWindowOpen = windowOpenHandler;
}

/**
 * Register sync-related IPC handlers
 */
export function registerSyncHandlers(): void {
  // Handle declarative sync trigger (from manifest-declared commands)
  subscribe(getSystemAddress(), 'sync:manual-trigger', async () => {
    DEBUG && console.log('[sync] Manual sync triggered via declarative command');
    try {
      const config = getSyncConfig();
      if (!config.serverUrl || !config.apiKey) {
        DEBUG && console.log('[sync] Sync not configured, skipping manual trigger');
        return;
      }

      const result = await syncAll(config.serverUrl, config.apiKey);

      // Notify all windows that sync pulled new data so they can refresh
      if (result.pulled > 0) {
        publish(getSystemAddress(), 'sync:pull-completed', {
          pulled: result.pulled,
          pushed: result.pushed,
          conflicts: result.conflicts
        });
      }

      DEBUG && console.log('[sync] Manual sync completed:', result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[sync] Manual sync failed:', message);
    }
  });

  // The tile:sync:get-config / set-config / pull / push / status
  // handlers live in tile-ipc.ts.
}

/**
 * Persist adBlockerEnabled pref in the datastore.
 * Reads current core prefs, updates adBlockerEnabled, writes back.
 */
export function persistAdBlockerPref(enabled: boolean): void {
  try {
    const db = getDb();
    const CORE_EXT_ID = 'core';
    const PREFS_KEY = 'prefs';
    const row = db.prepare(
      'SELECT value FROM feature_settings WHERE featureId = ? AND key = ?'
    ).get(CORE_EXT_ID, PREFS_KEY) as { value: string } | undefined;
    let prefs: Record<string, unknown> = {};
    if (row?.value) {
      try { prefs = JSON.parse(row.value); } catch { /* use empty */ }
    }
    prefs.adBlockerEnabled = enabled;
    const timestamp = Date.now();
    db.prepare(`
      INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
      VALUES (?, ?, ?, ?, ?)
    `).run(`${CORE_EXT_ID}_${PREFS_KEY}`, CORE_EXT_ID, PREFS_KEY, JSON.stringify(prefs), timestamp);
  } catch (error) {
    console.error('[adblocker] Failed to persist pref:', error);
  }
}

/**
 * Register all IPC handlers
 */
export function registerAllHandlers(_onQuit: () => void): void {
  registerDarkModeHandlers();
  registerWindowHandlers();
  registerSyncHandlers();
}
