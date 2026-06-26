/**
 * IPC Handler Registration
 *
 * Centralizes all IPC handlers for the main process.
 * Handlers are thin wrappers that delegate to backend functions.
 */

import { ipcMain, nativeTheme, dialog, BrowserWindow, BaseWindow, WebContentsView, app, screen, webContents, net, Menu, clipboard } from 'electron';
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
  finalizeWindowClose,
} from './main.js';
import { getWindowPresentation } from './window-presenter.js';

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
  showHybridHost,
  handleHybridEscape,
} from './windows.js';
import {
  TRANSIENT_ROLES,
  inferIzuiRole,
  spacesPolicyForRole,
  selectTransientSiblingsToClose,
  shouldFocusHybridContentOnHostFocus,
  windowSelfClosesOnBlur,
  type TransientSiblingCandidate,
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

import { isHybridPageHost } from './debug-flag.js';
import { markPageHostContent, registerGuest } from './webview-guest-registry.js';
import {
  registerHybridWindow,
  unregisterHybridWindow,
  findHybridWindowByUrl,
  findHybridWindowByKey,
  getHybridContentWC,
  getHybridWindow,
  getAllHybridWindows,
} from './hybrid-page-host-registry.js';

/**
 * Gather every live window — BrowserWindow AND hybrid page-host (BaseWindow) —
 * as transient-autoclose candidates, tagged with its registry role and current
 * visibility. Hybrid windows are NOT BrowserWindows, so `getAllLiveWindows()`
 * (BrowserWindow.getAllWindows-backed) can't see them; we union the hybrid
 * registry in. Empty hybrid contribution when the flag is off (registry empty).
 */
function gatherTransientSiblingCandidates(): TransientSiblingCandidate[] {
  const out: TransientSiblingCandidate[] = [];
  for (const w of getAllLiveWindows()) {
    let visible = false;
    try {
      visible = !w.isDestroyed() && w.isVisible();
    } catch {
      /* a window torn down mid-iteration — treat as not visible */
    }
    out.push({
      id: w.id,
      role: getWindowInfo(w.id)?.params?.role as string | undefined,
      visible,
    });
  }
  for (const h of getAllHybridWindows()) {
    let visible = false;
    try {
      visible = !h.baseWin.isDestroyed() && h.baseWin.isVisible();
    } catch {
      /* BaseWindow gone — treat as not visible */
    }
    out.push({
      id: h.windowId,
      role: getWindowInfo(h.windowId)?.params?.role as string | undefined,
      visible,
    });
  }
  return out;
}

/**
 * Auto-dismiss the transient (palette / quick-view) siblings of a window that
 * just gained focus. IZUI policy: transient surfaces dismiss as soon as focus
 * moves to ANY other window. The focuser-driven model (vs per-window blur) is
 * used because macOS panel-type windows don't fire reliable per-window `blur`
 * on intra-app focus shifts.
 *
 * Called from BOTH the BrowserWindow `win.on('focus')` handler AND the hybrid
 * page-host `onHybridHostFocus` path, so a hybrid peek/slide either closing OR
 * being closed both work (the regression — peek 8e5c3174 — was that this lived
 * only on the BrowserWindow side, over BrowserWindow candidates only). The pure
 * decision is `selectTransientSiblingsToClose`; here we just gather candidates
 * and fire the close.
 */
function closeTransientSiblingsOnFocus(focusedId: number): void {
  const focusedRole = getWindowInfo(focusedId)?.params?.role as string | undefined;
  const candidates = gatherTransientSiblingCandidates();
  for (const id of selectTransientSiblingsToClose(focusedId, focusedRole, candidates)) {
    DEBUG && console.log(
      '[izui] window-focused autoclose transient sibling:', id,
      'focused:', focusedId, 'role:', focusedRole,
    );
    try {
      closeOrHideWindow(id);
    } catch (err) {
      DEBUG && console.log('[izui] autoclose transient failed:', err);
    }
  }
}

/**
 * Close every visible transient (palette / quick-view, non-overlay) HYBRID
 * peek/slide window. Scoped to HYBRID windows so we don't race the BrowserWindow
 * modal blur path. The actual close-body for the app-resign dismissal below.
 */
function doCloseTransientHybridWindows(): void {
  const coordinator = getIzuiCoordinator();
  if (
    coordinator.isWithinOverlayExitCooldown() ||
    coordinator.isWithinOverlayEntryCooldown()
  ) {
    DEBUG && console.log('[izui] app-resign: skip hybrid transient close (overlay cooldown)');
    return;
  }
  const candidates: TransientSiblingCandidate[] = [];
  for (const h of getAllHybridWindows()) {
    let visible = false;
    try {
      visible = !h.baseWin.isDestroyed() && h.baseWin.isVisible();
    } catch {
      /* BaseWindow gone — treat as not visible */
    }
    candidates.push({
      id: h.windowId,
      role: getWindowInfo(h.windowId)?.params?.role as string | undefined,
      visible,
    });
  }
  // No focuser — focus left the app entirely. id -1 matches nothing and an
  // undefined focuser-role is not 'utility', so the selector returns every
  // visible transient (non-overlay) hybrid window.
  for (const id of selectTransientSiblingsToClose(-1, undefined, candidates)) {
    DEBUG && console.log('[izui] app-resign autoclose transient hybrid:', id);
    try {
      closeOrHideWindow(id);
    } catch (err) {
      DEBUG && console.log('[izui] app-resign hybrid close failed:', err);
    }
  }
}

// macOS fires a brief `did-resign-active` → `did-become-active` DANCE (no real
// app-switch) during window restoration at startup and around overlay/activation
// transitions — see the cooldown comments in izui-state.ts (300/500 ms windows).
// A slide/peek opened via global hotkey right at boot would otherwise be
// opened-then-instantly-closed by the resign edge of that dance (user-visible
// as "the slide hotkey did nothing the first time after startup"). So we DEFER
// the close and let a following `did-become-active` CANCEL it — the same
// deferred-decision shape the hybrid registry uses for content/overlay blur.
// Only a resign with NO become within the settle window is a real app-switch.
const HYBRID_APP_RESIGN_SETTLE_MS = 500;
let pendingAppResignClose: ReturnType<typeof setTimeout> | null = null;

/**
 * Dismiss transient HYBRID peek/slide surfaces when Peek stops being the
 * frontmost app (Cmd+Tab away). The focuser-driven autoclose only fires when
 * ANOTHER Peek window gains focus — it can't fire when focus leaves Peek
 * entirely. Transient BrowserWindow modals already self-close via their
 * per-window `blur` handler on app blur; hybrid peek/slide windows are
 * BaseWindows with NO blur handler, so without this they linger after an
 * app-switch (regression peek 8e5c3174, second half).
 *
 * Deferred (not immediate) to ride out the macOS resign→become activation dance
 * — see HYBRID_APP_RESIGN_SETTLE_MS. `onAppDidBecomeActive` cancels a pending
 * close, so the dance (which re-activates Peek) never dismisses a freshly opened
 * surface.
 */
function onAppDidResignActive(): void {
  if (pendingAppResignClose) clearTimeout(pendingAppResignClose);
  pendingAppResignClose = setTimeout(() => {
    pendingAppResignClose = null;
    doCloseTransientHybridWindows();
  }, HYBRID_APP_RESIGN_SETTLE_MS);
}

/** Peek became frontmost again — cancel any pending app-resign dismissal. */
function onAppDidBecomeActive(): void {
  if (pendingAppResignClose) {
    clearTimeout(pendingAppResignClose);
    pendingAppResignClose = null;
  }
}

// One-time guard so repeated `registerWindowHandlers()` calls don't stack
// duplicate app-level listeners.
let appResignHybridWired = false;
import {
  getRuntimeExternalWebPrefsForUrl,
  installMainWorldContentScriptInjection,
  installRuntimeExternalCdpPolyfill,
} from './page-host-compat.js';

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

/**
 * Update the focus trackers for a hybrid page-host window.
 *
 * Hybrid page-hosts are `BaseWindow`s, not `BrowserWindow`s, so they never
 * flow through `trackOnWindowFocus`/`trackVisibleWindowFocus` (which read
 * `win.webContents.getURL()` — a BaseWindow has no root `.webContents`). The
 * hybrid branch in `setWindowOpenHandler` calls this from the host
 * BaseWindow's `'focus'` event so a focused web page becomes
 * `lastFocusedVisibleWindowId` (and, for an http(s) page, `lastContentWindowId`)
 * exactly like a canvas web window does. Without this, session-save records the
 * WRONG window (the last-focused BrowserWindow, e.g. Settings) as the focused
 * descriptor, and restore brings that window — not the web page — to the front.
 */
export function trackHybridWindowFocus(windowId: number, url: string): void {
  // Mirror trackContentWindowFocus: only http(s) pages are "content" windows.
  if (url.startsWith('http://') || url.startsWith('https://')) {
    lastContentWindowId = windowId;
  }
  // Mirror trackVisibleWindowFocus: a hybrid page-host is always a focusable,
  // non-background, non-overlay visible content window, so it is unconditionally
  // the last-focused visible window when it gains focus.
  lastFocusedVisibleWindowId = windowId;
  console.log(`[focus-tracker] updated lastFocusedVisibleWindowId=${lastFocusedVisibleWindowId} (hybrid) url=${url.slice(0, 80)}`);
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

/**
 * P1.3 — MAIN-mediated content→chrome event forwarding for the hybrid
 * page-host. On the OLD canvas path, page.js (running in the per-page chrome
 * renderer) listens to the `<webview>`'s events directly and emits the
 * `page:*` pubsub topics. The hybrid path has NO page.js — the content is a
 * main-owned `WebContentsView` webContents. So MAIN must reproduce those
 * emissions + datastore side-effects off the content webContents's own
 * Electron lifecycle events.
 *
 * The two paths are MUTUALLY EXCLUSIVE per window (a given window is either a
 * canvas BrowserWindow+webview OR a hybrid BaseWindow+WebContentsView), so
 * there is no double-emit: page.js never runs for a hybrid window.
 *
 * Gating: only ever called from the hybrid branch, which already gates on
 * `isHybridPageHost() && useCanvas`. The content wc is the only main-owned
 * content webContents, so attaching here is the hybrid-only path.
 *
 * Topics (see docs/perf/page-host-hybrid-design.md §4):
 *   REUSED (existing subscribers — payloads identical to page.js / canvas main):
 *     - page:loaded                  {url,title,opensearchUrl}   (websearch home.js)
 *     - page:search-engine-discovered{pageUrl,opensearchUrl}     (websearch LAZY-WAKE)
 *     - page:content-ready           {url,title,windowId}        (entities)
 *     - page:navigated               {url,title}                 (pagewidgets-sample)
 *   INVENTED for the P1.4 overlay (no existing consumer; names per design §4):
 *     - page:title-updated           {windowId,url,title}
 *     - page:favicon                 {windowId,url,favicon}
 *     - page:loading                 {windowId,loading}
 *     - page:nav-state               {windowId,url,canGoBack,canGoForward}
 */
// Top-border reveal band geometry — mirrors the canvas trigger zone + navbar
// reserve (CANVAS_TRIGGER_ZONE / CANVAS_NAVBAR_HEIGHT) and hybrid-overlay.ts's
// GUTTER_TOP (= TRIGGER_ZONE + NAVBAR_HEIGHT). An idle move within this many px
// below the content window's top edge reveals the overlay chrome.
const TRIGGER_ZONE_PX = 8;
const NAVBAR_HEIGHT_PX = 36;
export function wireHybridContentEvents(
  contentWC: Electron.WebContents,
  hostWindowId: number,
  initialUrl: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: any,
): void {
  const isHttp = (u: string | null | undefined): u is string =>
    !!u && (u.startsWith('http://') || u.startsWith('https://'));

  // Mutable copy of the skipTracking flag — consumed once by the first
  // redirect-driven did-navigate, mirroring the canvas path (ipc.ts ~2465).
  let skipTracking = options?.skipTracking === true;

  // ── Stranded-blank INITIAL-load cleanup state ────────────────────────────
  // The host is now shown at load-START (ipc.ts hybrid branch), before the
  // content load completes — so a failed INITIAL load happens on an
  // already-visible window. We must clean up the genuinely-stranded case
  // WITHOUT destroying a useful native error page.
  //
  // Empirical classification (2026-06-25 probe of a real WebContentsView):
  //   - Hard network errors — ERR_NAME_NOT_RESOLVED (-105), ERR_UNSAFE_PORT
  //     (-312), ERR_EMPTY_RESPONSE (-324), ERR_CONNECTION_REFUSED — all COMMIT
  //     Chromium's native error page: `did-finish-load` fires and `getURL()`
  //     returns the failed URL (document is `chrome-error://chromewebdata/`).
  //     "This site can't be reached" is a useful display — KEEP it.
  //   - A navigation that aborts with NOTHING committed — HTTP 204 No Content,
  //     an ERR_ABORTED main-frame nav — fires `did-stop-loading` but NEVER
  //     `did-finish-load`, and `getURL()` stays empty: a blank window on the
  //     loading fill. THAT is the stranded case → close the just-opened host.
  //   - A download (the initial nav resolves to a file) is already closed by
  //     the `will-download` cleanup (session-partition.ts), so it never reaches
  //     a stranded state here.
  //
  // So the discriminator is "did ANY document (page OR error page) ever
  // commit?" — NOT the `did-fail-load` errorCode (which both over-targets the
  // committed error pages and misses the no-error-event 204 abort).
  //
  // `did-finish-load` and `did-stop-loading` are main-frame/top-level WC events
  // (subframes use the *-frame-* variants), so requirement "main-frame only" is
  // intrinsic — no isMainFrame gate needed. `everCommittedDocument` is the
  // one-shot "has the main frame ever committed" flag: once true it never
  // closes, so later in-page navigation/redirect/abort in an
  // already-loaded window is never touched.
  let everCommittedDocument = false;
  let sawLoadStart = false;
  let strandedCleanupDone = false;
  // Session-restore (fire-and-forget) opens keep today's behavior: the restore
  // loop owns their lifecycle/focus, and a restored-but-stranded host should
  // not self-close out from under it. Only user-initiated opens auto-clean.
  const wasSkipTrackingOpen = options?.skipTracking === true;

  const publishNavState = () => {
    if (contentWC.isDestroyed()) return;
    const url = contentWC.getURL() || initialUrl;
    publish(getSystemAddress(), 'page:nav-state', {
      windowId: hostWindowId,
      url,
      canGoBack: contentWC.navigationHistory.canGoBack(),
      canGoForward: contentWC.navigationHistory.canGoForward(),
    });
  };

  // ── Loading lifecycle → overlay (P1.4 consumes) ──────────────────────────
  contentWC.on('did-start-loading', () => {
    sawLoadStart = true;
    if (contentWC.isDestroyed()) return;
    publish(getSystemAddress(), 'page:loading', { windowId: hostWindowId, loading: true });
  });
  contentWC.on('did-stop-loading', () => {
    if (contentWC.isDestroyed()) return;
    publish(getSystemAddress(), 'page:loading', { windowId: hostWindowId, loading: false });

    // Stranded-blank initial-load cleanup (see the state declarations above for
    // the full empirical rationale). Close the just-opened host ONLY when its
    // very first load settled with NO committed document — neither a real page
    // nor a native error page — so it would otherwise sit blank on the loading
    // fill. Once any document has committed (success or chrome-error page) the
    // flag latches and later navigations are never touched.
    if (
      !strandedCleanupDone &&
      !wasSkipTrackingOpen &&
      sawLoadStart &&
      !everCommittedDocument
    ) {
      const committedUrl = contentWC.getURL();
      // Defensive backstop against any did-finish-load/did-stop-loading ordering
      // race: if something is actually committed, getURL() is the failed/loaded
      // URL (non-empty), so we KEEP it; only an empty/blank URL is stranded.
      if (!committedUrl || committedUrl === 'about:blank') {
        strandedCleanupDone = true;
        const entry = getHybridWindow(hostWindowId);
        if (entry && !entry.baseWin.isDestroyed()) {
          DEBUG && console.log(
            `[hybrid-page-host:${hostWindowId}] initial load stranded blank (no committed document) — closing host`,
          );
          try { entry.baseWin.close(); } catch { /* already torn down */ }
        }
        return;
      }
    }

    // Thumbnail capture, matching the canvas guest's did-stop-loading (ipc.ts ~2102).
    const pageUrl = contentWC.getURL() || initialUrl;
    if (isHttp(pageUrl)) {
      setTimeout(() => {
        if (contentWC.isDestroyed()) return;
        captureThumbnail(contentWC, pageUrl).then((hash) => {
          if (hash) {
            try { updateItemThumbnail(pageUrl, hash); } catch (e) {
              DEBUG && console.log('[hybrid-page-host] thumbnail update failed:', e);
            }
          }
        });
      }, 1500);
    }
  });

  // ── Title → datastore + chrome state ─────────────────────────────────────
  contentWC.on('page-title-updated', (_event: Electron.Event, title: string) => {
    if (title && title !== 'Loading...') {
      const pageUrl = contentWC.getURL() || initialUrl;
      if (isHttp(pageUrl)) {
        try { updateItemTitle(pageUrl, title); } catch (e) {
          DEBUG && console.log('[hybrid-page-host] title update failed:', e);
        }
        // Existing consumer (entities) — identical payload to the canvas path.
        publish('system', 'page:content-ready', { url: pageUrl, title, windowId: hostWindowId });
      }
      // Overlay chrome state (P1.4).
      publish(getSystemAddress(), 'page:title-updated', {
        windowId: hostWindowId,
        url: pageUrl,
        title,
      });
    }
  });

  // ── Favicon → datastore + chrome state ───────────────────────────────────
  contentWC.on('page-favicon-updated', (_event: Electron.Event, favicons: string[]) => {
    const pageUrl = contentWC.getURL() || initialUrl;
    if (isHttp(pageUrl) && favicons.length > 0) {
      const best = favicons.find(f => f.endsWith('.svg')) ||
                   favicons.find(f => f.endsWith('.png')) ||
                   favicons[favicons.length - 1];
      try { updateItemFavicon(pageUrl, best); } catch (e) {
        DEBUG && console.log('[hybrid-page-host] favicon update failed:', e);
      }
      // Overlay chrome state (P1.4).
      publish(getSystemAddress(), 'page:favicon', {
        windowId: hostWindowId,
        url: pageUrl,
        favicon: best,
      });
    }
  });

  // ── Find-in-page (P1.4b-4) → overlay find bar ────────────────────────────
  // The content WC's find results are forwarded to the shared overlay so its
  // find bar can show the match count (e.g. "2 of 7"). Payload mirrors the
  // canvas path's `found-in-page` result fields. windowId-tagged so the overlay
  // applies it only for the active window (matches page:title-updated etc.).
  contentWC.on('found-in-page', (_event: Electron.Event, result: Electron.Result) => {
    if (contentWC.isDestroyed()) return;
    publish(getSystemAddress(), 'page:found-in-page', {
      windowId: hostWindowId,
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
    });
  });

  // Page accelerators land on the content WC (it owns keyboard focus when the
  // user is reading the page; the overlay is click-through). Forward them as the
  // SAME topics the canvas guest's before-input-event publishes (ipc.ts ~2734),
  // tagged with this window's id so the shared overlay (which gates on the active
  // windowId) reacts:
  //   - Cmd+L → page:show-navbar  → overlay reveals the navbar + focuses the URL
  //   - Cmd+R → page:reload       → installHybridNavbarActionRouting reloads the WC
  //   - Cmd+F / Cmd+G / Cmd+Shift+G → page:find / page:find-next / page:find-prev
  //     → overlay opens/advances its find bar (execution routed back via
  //     page:find-exec etc. in installHybridNavbarActionRouting).
  //   - Cmd+[ / Cmd+ArrowLeft  → page:go-back
  //   - Cmd+] / Cmd+ArrowRight → page:go-forward (both routed to the WC's
  //     navigationHistory in installHybridNavbarActionRouting).
  // This mirrors the canvas guest set exactly so the hybrid path reproduces the
  // canvas keyboard behavior; a given window is EITHER canvas OR hybrid, and both
  // the overlay and page.js gate strictly on windowId, so coexistence is safe.
  // Debounce ESC the same 200ms the canvas BrowserWindow path does
  // (windows.ts addEscHandler) so a single press never double-fires from key
  // propagation / OS focus churn.
  let lastHybridEscTime = 0;
  contentWC.on('before-input-event', (event, input) => {
    // ── ESC → close (no modifier) ────────────────────────────────────────────
    // A focused hybrid page-host makes its content WebContentsView the macOS
    // first responder, so ESC arrives HERE, not at the per-BrowserWindow
    // before-input-event (windows.ts addEscHandler) that owns the canvas ESC→
    // close path. Peeks/slides open `role:'quick-view' + modal + canvas` → under
    // the hybrid default they are BaseWindows, and their ESC→close regressed
    // (peek e8081cce companion). Route through the SAME policy decision the
    // canvas path uses (handleHybridEscape → escPolicy/escUnhandledPolicy, one
    // source of truth). The early `!modifier` return below would otherwise drop
    // ESC entirely, so this MUST sit above it.
    if (input.type === 'keyDown' && input.key === 'Escape') {
      const now = Date.now();
      if (now - lastHybridEscTime < 200) return;
      lastHybridEscTime = now;
      // Block ESC from reaching the page DOM (matches the canvas path's
      // preventDefault) so the policy decision — not a page handler — owns it.
      event.preventDefault();
      void handleHybridEscape(hostWindowId, contentWC);
      return;
    }

    const modifier = process.platform === 'darwin' ? input.meta : input.control;
    if (input.type !== 'keyDown' || !modifier) return;
    if (input.key === 'l') {
      publish(getSystemAddress(), 'page:show-navbar', { windowId: hostWindowId });
      event.preventDefault();
    } else if (input.key === 'r') {
      publish(getSystemAddress(), 'page:reload', { windowId: hostWindowId });
      event.preventDefault();
    } else if (input.key === 'f') {
      publish(getSystemAddress(), 'page:find', { windowId: hostWindowId });
      event.preventDefault();
    } else if (input.key === 'g' && input.shift) {
      publish(getSystemAddress(), 'page:find-prev', { windowId: hostWindowId });
      event.preventDefault();
    } else if (input.key === 'g') {
      publish(getSystemAddress(), 'page:find-next', { windowId: hostWindowId });
      event.preventDefault();
    } else if (input.key === '[' || (input.key === 'ArrowLeft' && !input.shift)) {
      publish(getSystemAddress(), 'page:go-back', { windowId: hostWindowId });
      event.preventDefault();
    } else if (input.key === ']' || (input.key === 'ArrowRight' && !input.shift)) {
      publish(getSystemAddress(), 'page:go-forward', { windowId: hostWindowId });
      event.preventDefault();
    } else if (handleLocalShortcut(input, hostWindowId)) {
      // R2/R3 (peek items b1dd4e7c / bd00bf01): when a hybrid page-host is
      // frontmost, its content WebContentsView is the macOS first responder
      // (A's R4 fix), so keystrokes flow to THIS handler — NOT to the per-
      // BrowserWindow before-input-event in main.ts that routes to
      // handleLocalShortcut. The page-specific accelerators above are handled
      // inline; everything else (cmd+N → new empty page-host, and any other
      // registered LOCAL shortcut) was silently dropped, so those features
      // stopped firing with a hybrid host focused. Route the leftover modifier
      // keystrokes through the SAME local-shortcut dispatcher the canvas/core
      // windows use, tagged with this host's id for mode-conditional matching.
      // (Global wake hotkeys — peeks Option+0 / slides Option+Up — are OS-level
      // grabs that pre-empt before-input-event and are unaffected; this closes
      // the LOCAL-shortcut gap that the hybrid first-responder opened.)
      event.preventDefault();
    }
  });

  // ── Hold-to-drag over web CONTENT: forward content pointer signals to overlay ─
  // The web page is a MAIN-owned WebContentsView; the shared overlay sits above it
  // CLICK-THROUGH (R1), so the overlay never natively sees button-down/up over the
  // page — only forwarded moves. To support the Peek-wide HOLD-to-drag gesture
  // (press → hold still for dragHoldDelay → move → window moves) UNIFORMLY over the
  // page too, main observes the content WC's raw `input-event` mouse stream
  // (SPIKE-confirmed to emit mouseDown/mouseMove/mouseUp with screen coords
  // globalX/globalY on a WebContentsView in Electron 40) and forwards each as
  // `page-overlay:content-pointer {windowId, phase, screenX, screenY}`. The overlay
  // runs the SINGLE hold-to-drag state machine for BOTH chrome and content: it
  // starts the hold timer on `down`, CANCELS on any `move` beyond tolerance before
  // the threshold (so link/image drag + text selection + clicks proceed untouched),
  // and on threshold-fire begins the window drag — flipping the overlay to capture
  // so post-hold moves land on it and stop the page from selecting. windowId-tagged
  // so the overlay (which gates on the active windowId) only acts for the active
  // page. Button-held moves (down→up) are forwarded for the drag FSM.
  //
  // ── Top-border reveal (peek 363e7cff — the last hybrid dead-focus cluster item) ─
  // Separately, IDLE (no-button) moves near the content's TOP EDGE are forwarded as
  // `phase:'reveal'` so the overlay can reveal its navbar/widgets there. This is the
  // gesture-reveal the trigger zone provides. On the canvas path the trigger strip
  // lived in the chrome window's gutter, so the (non-click-through) chrome saw the
  // hover natively. On the hybrid path the content `WebContentsView` is the macOS
  // first responder and — in the MAXIMIZED / no-gutter case, where the overlay frame
  // == the content rect so the trigger strip sits directly over the content WC —
  // CAPTURES the idle `mousemove` the click-through overlay's reveal loop needs (the
  // overlay's `setIgnoreMouseEvents(true,{forward:true})` move stream is starved).
  // Result: hovering the top border did NOT reveal the overlay (worst in the
  // maximized state). We already observe the content WC's raw pointer stream here, so
  // forward idle top-band moves too — main owns the geometry (host top edge), so this
  // works edge-to-edge including maximized; the overlay's own forwarded-move loop
  // still owns the gutter case. We only emit on band ENTER and band EXIT (not every
  // move) to avoid flooding pubsub.
  const REVEAL_BAND = TRIGGER_ZONE_PX + NAVBAR_HEIGHT_PX; // 8 + 36 = 44 (mirrors GUTTER_TOP)
  let leftButtonDown = false;
  let inRevealBand = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contentWC.on('input-event', (_event: unknown, input: any) => {
    const t = input && input.type;
    if (t === 'mouseDown' && input.button === 'left') {
      leftButtonDown = true;
      publish(getSystemAddress(), 'page-overlay:content-pointer', {
        windowId: hostWindowId, phase: 'down', screenX: input.globalX, screenY: input.globalY,
      });
    } else if (t === 'mouseMove' && leftButtonDown) {
      publish(getSystemAddress(), 'page-overlay:content-pointer', {
        windowId: hostWindowId, phase: 'move', screenX: input.globalX, screenY: input.globalY,
      });
    } else if (t === 'mouseMove') {
      // Idle (no-button) move → top-border reveal. Compute the pointer's offset
      // below the host window's top edge (screen coords) and reveal/hide on the
      // band-cross transitions only. Guarded: a torn-down host or missing geometry
      // simply skips the reveal (never throws inside the input stream).
      let topY: number | null = null;
      try {
        const hw = getHybridWindow(hostWindowId);
        if (hw && !hw.baseWin.isDestroyed()) topY = hw.baseWin.getBounds().y;
      } catch {
        /* baseWin gone — skip reveal */
      }
      if (topY != null) {
        const dy = input.globalY - topY;
        const nowInBand = dy >= 0 && dy <= REVEAL_BAND;
        if (nowInBand && !inRevealBand) {
          inRevealBand = true;
          publish(getSystemAddress(), 'page-overlay:content-pointer', {
            windowId: hostWindowId, phase: 'reveal', screenX: input.globalX, screenY: input.globalY,
          });
        } else if (!nowInBand && inRevealBand) {
          inRevealBand = false;
          publish(getSystemAddress(), 'page-overlay:content-pointer', {
            windowId: hostWindowId, phase: 'reveal-out', screenX: input.globalX, screenY: input.globalY,
          });
        }
      }
    } else if (t === 'mouseUp' && input.button === 'left') {
      if (!leftButtonDown) return;
      leftButtonDown = false;
      publish(getSystemAddress(), 'page-overlay:content-pointer', {
        windowId: hostWindowId, phase: 'up', screenX: input.globalX, screenY: input.globalY,
      });
    }
  });

  // ── Popups / window.open / target=_blank → new hybrid page-host (P1.5) ────
  // Risk R7: the hybrid content webContents is a `WebContentsView`, whose
  // `getType()` is 'browserView' — NOT 'window'/'webview'. The default-deny
  // SECURITY chokepoint in entry.ts (~495) gates ONLY on 'window'/'webview',
  // so it does NOT install on this WC. Without an explicit handler here, a
  // `window.open()` / `target=_blank` from hybrid content would fall through
  // to Electron's default and spawn a raw, un-gated Chromium popup window.
  // This handler IS the gate for the hybrid path.
  //
  // Policy mirrors the canvas <webview> guest's setWindowOpenHandler
  // (ipc.ts ~2702): http(s) popups are DENIED the default BrowserWindow and
  // re-routed through the SAME window-open IPC pipeline (`invokeWindowOpen`,
  // the exported reference to windowOpenHandler — the identical mechanism the
  // chrome-extensions popup handler uses, ipc.ts/chrome-extensions.ts ~1090).
  // Because the hybrid flag is on, that re-entry takes the HYBRID EARLY BRANCH
  // above and produces ANOTHER opaque BaseWindow + WebContentsView page-host
  // rather than a canvas page or a raw popup. Non-http(s) URLs (about:blank,
  // data:, etc.) are ALLOWED to open normally — byte-identical to the canvas
  // guest policy; we do NOT invent new policy here.
  contentWC.setWindowOpenHandler(({ url: popupUrl }) => {
    if (popupUrl.startsWith('http://') || popupUrl.startsWith('https://')) {
      console.log(`[hybrid-page-host] Intercepted popup from window ${hostWindowId}: ${popupUrl}`);

      // Resolve the opener source the same way the canvas guest does
      // (getWindowInfo(win.id).source), falling back to 'system'.
      const parentInfo = getWindowInfo(hostWindowId);
      const source = parentInfo ? parentInfo.source : 'system';

      // Route asynchronously through the canonical window-open handler. We pass
      // the content WC as ev.sender so placement/parent-tracking resolves the
      // same as any other open (windowFromWebContents returns null for this
      // BaseWindow-hosted WC, which the handler tolerates → default placement).
      // The hybrid flag steers it into the hybrid branch → a new hybrid host.
      if (invokeWindowOpen) {
        invokeWindowOpen(
          { sender: contentWC },
          { source, url: popupUrl, options: {} },
        ).catch((e) => {
          console.error('[hybrid-page-host] window-open re-route failed:', e);
        });
      } else {
        console.error('[hybrid-page-host] invokeWindowOpen not initialized — dropping popup', popupUrl);
      }

      // Deny the default BrowserWindow creation (canvas-guest parity).
      return { action: 'deny' };
    }

    // Non-http(s) (about:blank, data:, etc.) — allow normally, like canvas.
    return { action: 'allow' };
  });

  // ── Navigation → history tracking + chrome state ─────────────────────────
  // Full main-frame navigation (link click / scripted nav). Mirrors the
  // canvas root-webContents did-navigate history tracking (ipc.ts ~2446) AND
  // the canvas guest's currentUrl bookkeeping (ipc.ts ~2150).
  contentWC.on('did-navigate', (_event: Electron.Event, navUrl: string) => {
    // Keep undo-close's restore URL current.
    if (isHttp(navUrl)) {
      const winInfo = getWindowInfo(hostWindowId);
      if (winInfo) winInfo.params.currentUrl = navUrl;
    }
    publishNavState();
    publish(getSystemAddress(), 'page:navigated', { windowId: hostWindowId, url: navUrl, title: contentWC.getTitle() || '' });

    // History tracking — same skip rules as the canvas path (ipc.ts ~2446).
    if (navUrl === initialUrl) return;
    if (navUrl.startsWith('peek://')) return;
    try {
      const navParsed = new URL(navUrl);
      if ((navParsed.hostname === '127.0.0.1' || navParsed.hostname === 'localhost') &&
          navParsed.pathname.includes('/callback')) {
        return;
      }
    } catch {}
    // Session-restored windows: skip the first redirect-driven did-navigate,
    // then track normally (matches canvas ipc.ts ~2465).
    if (skipTracking) {
      skipTracking = false;
      return;
    }
    if (!isHttp(navUrl)) return;
    try {
      const navTrack = trackWindowLoad(navUrl, {
        source: 'navigation',
        sourceId: '',
        windowType: options?.modal ? 'modal' : 'main',
        title: (contentWC.getTitle() !== 'Loading...' ? contentWC.getTitle() : '') || '',
      });
      if (navTrack.created) {
        publish('system', 'item:created', {
          itemId: navTrack.itemId,
          itemType: 'url',
          content: navUrl,
          windowId: hostWindowId,
        });
      }
    } catch (e) {
      DEBUG && console.log('[hybrid-page-host] did-navigate track failed:', e);
    }
  });

  // In-page (hash/pushState) navigation: update currentUrl + chrome state,
  // publish page:navigated (pagewidgets consumer), but do NOT add a history
  // row (canvas path doesn't either).
  contentWC.on('did-navigate-in-page', (_event: Electron.Event, navUrl: string, isMainFrame: boolean) => {
    if (!isMainFrame) return;
    if (isHttp(navUrl)) {
      const winInfo = getWindowInfo(hostWindowId);
      if (winInfo) winInfo.params.currentUrl = navUrl;
    }
    publishNavState();
    publish(getSystemAddress(), 'page:navigated', { windowId: hostWindowId, url: navUrl, title: contentWC.getTitle() || '' });
  });

  // ── did-finish-load → page:loaded + OpenSearch lazy-wake ─────────────────
  // CRITICAL: this replicates page.js's did-finish-load (page.js ~2567) so the
  // websearch lazy tile still wakes on the hybrid path. The executeJavaScript
  // OpenSearch query, the topic names, and the payload shapes are IDENTICAL to
  // page.js. The pre-publish lazy hook (tile-lazy.ts) matches on TOPIC only, so
  // a main-side publish of page:search-engine-discovered wakes websearch the
  // same as a renderer-side one.
  contentWC.on('did-finish-load', async () => {
    // Latch "a main-frame document committed" for the stranded-blank cleanup —
    // BEFORE the isHttp early-return below, because Chromium's native error page
    // (chrome-error://chromewebdata/) also fires did-finish-load and IS a
    // document worth keeping. Only a load that never reaches did-finish-load
    // (HTTP 204 / ERR_ABORTED) leaves this false and is treated as stranded.
    everCommittedDocument = true;
    if (contentWC.isDestroyed()) return;
    const pageUrl = contentWC.getURL();
    if (!isHttp(pageUrl)) return;

    let opensearchUrl: string | null = null;
    try {
      const detectedUrl = await contentWC.executeJavaScript(`
        (function() {
          const link = document.querySelector('link[rel="search"][type="application/opensearchdescription+xml"]');
          return link ? link.href : null;
        })();
      `);
      if (detectedUrl) {
        try {
          opensearchUrl = new URL(detectedUrl, pageUrl).href;
        } catch {
          // Invalid URL, skip.
        }
      }
    } catch (err) {
      DEBUG && console.log('[hybrid-page-host] OpenSearch detection failed:', err instanceof Error ? err.message : err);
    }

    if (contentWC.isDestroyed()) return;
    const pageTitle = contentWC.getTitle() || '';
    // windowId is added (vs the canvas page.js payload) so the shared overlay can
    // attribute the event to the ACTIVE hybrid window (P1.4b-6 widgets gate on it).
    // Resident consumers (pagewidgets-sample, websearch) ignore the extra field.
    publish(getSystemAddress(), 'page:loaded', {
      windowId: hostWindowId,
      url: pageUrl,
      title: pageTitle,
      opensearchUrl,
    });
    DEBUG && console.log(`[hybrid-page-host] page:loaded published: ${pageUrl}${opensearchUrl ? ` (OpenSearch: ${opensearchUrl})` : ''}`);

    // Lazy-wake trigger — fired ONLY when the page advertises an OpenSearch
    // descriptor (identical condition + payload to page.js ~2612, plus windowId
    // so the overlay's OpenSearch widget renders only for the active window).
    if (opensearchUrl) {
      publish(getSystemAddress(), 'page:search-engine-discovered', {
        windowId: hostWindowId,
        pageUrl,
        opensearchUrl,
      });
      console.log(`[hybrid-page-host] page:search-engine-discovered published: ${pageUrl} ${opensearchUrl}`);
    }

    publishNavState();
  });
}

/**
 * P1.4b-2 — MAIN-mediated chrome→content navbar action routing for the hybrid
 * page-host. On the canvas path, page.js (in the per-page chrome renderer)
 * subscribes to `page:navigate` / `page:reload` / `page:go-back` /
 * `page:go-forward` and drives its own `<webview>`. The hybrid path has no
 * page.js: the SHARED overlay renderer (renderer/page/overlay.js) publishes the
 * SAME topics tagged with the active hybrid `windowId`, and MAIN resolves the
 * content webContents via `getHybridContentWC(windowId)` and drives it.
 *
 * Coexistence with the canvas page.js subscribers is safe: every handler — both
 * here and in page.js — filters strictly on `windowId`, and a given window is
 * EITHER a canvas BrowserWindow+webview (page.js subscribes for it) OR a hybrid
 * BaseWindow (this routes for it), never both. `getHybridContentWC` returns null
 * for any non-hybrid windowId, so this handler is a no-op for canvas windows and
 * page.js is a no-op (windowId mismatch) for hybrid windows.
 *
 * Idempotent + gated: only installed once, only when `isHybridPageHost()`.
 */
let hybridNavbarRoutingInstalled = false;
export function installHybridNavbarActionRouting(): void {
  if (!isHybridPageHost()) return;
  if (hybridNavbarRoutingInstalled) return;
  hybridNavbarRoutingInstalled = true;

  const wcFor = (raw: unknown): { wc: Electron.WebContents; windowId: number } | null => {
    const msg = raw as { windowId?: number } | null;
    if (!msg || typeof msg.windowId !== 'number') return null;
    const wc = getHybridContentWC(msg.windowId);
    if (!wc) return null;
    return { wc, windowId: msg.windowId };
  };

  subscribe(getSystemAddress(), 'page:navigate', (raw) => {
    const r = wcFor(raw);
    if (!r) return;
    const url = (raw as { url?: string }).url;
    if (!url) return;
    r.wc.loadURL(url).catch((err) => {
      DEBUG && console.log(`[hybrid-page-host:${r.windowId}] navbar navigate failed:`, err);
    });
  });

  subscribe(getSystemAddress(), 'page:reload', (raw) => {
    const r = wcFor(raw);
    if (!r) return;
    try { r.wc.reload(); } catch { /* wc gone */ }
  });

  subscribe(getSystemAddress(), 'page:go-back', (raw) => {
    const r = wcFor(raw);
    if (!r) return;
    try {
      if (r.wc.navigationHistory.canGoBack()) r.wc.navigationHistory.goBack();
    } catch { /* wc gone */ }
  });

  subscribe(getSystemAddress(), 'page:go-forward', (raw) => {
    const r = wcFor(raw);
    if (!r) return;
    try {
      if (r.wc.navigationHistory.canGoForward()) r.wc.navigationHistory.goForward();
    } catch { /* wc gone */ }
  });

  // ── P1.4b-3: window-interaction routing (resize / move / maximize) ──────────
  // The shared overlay frames the active hybrid window's FULL outer bounds, so
  // the overlay's chrome (resize handles, navbar drag) computes new OUTER bounds
  // for the content window and publishes them tagged with the active windowId.
  // Main resolves the host `BaseWindow` and applies them. Non-hybrid windowIds
  // resolve to null → no-op (canvas windows drive their own BrowserWindow via the
  // `api.window.setBounds` IPC, never these topics).

  // Resolve the host BaseWindow for a geometry intent (null for non-hybrid /
  // torn-down windows).
  const baseWinFor = (raw: unknown): { baseWin: Electron.BaseWindow; windowId: number } | null => {
    const msg = raw as { windowId?: number } | null;
    if (!msg || typeof msg.windowId !== 'number') return null;
    const entry = getHybridWindow(msg.windowId);
    if (!entry || entry.baseWin.isDestroyed()) return null;
    return { baseWin: entry.baseWin, windowId: msg.windowId };
  };

  // Restore-bounds map: the outer bounds a window had before it was maximized,
  // keyed by windowId, so an unmaximize restores the exact pre-maximize size/pos.
  // (Mirrors page.js's renderer-side `preMaximizeBounds`, kept main-side here
  // because the content window's geometry is main-owned in the hybrid path.)
  const preMaximizeBounds = new Map<number, Electron.Rectangle>();

  // page:set-bounds — used for BOTH resize (overlay resize-handle drag) and move
  // (overlay navbar drag). The renderer computes the new outer bounds; main just
  // applies them. The content WebContentsView already refills on the host's
  // 'resize' (P1.1 fillView) and the overlay already follows the host's
  // 'move'/'resize' (P1.4b-1), so no extra plumbing is needed here.
  subscribe(getSystemAddress(), 'page:set-bounds', (raw) => {
    const r = baseWinFor(raw);
    if (!r) return;
    const b = (raw as { bounds?: Electron.Rectangle }).bounds;
    if (
      !b ||
      typeof b.x !== 'number' ||
      typeof b.y !== 'number' ||
      typeof b.width !== 'number' ||
      typeof b.height !== 'number'
    ) {
      return;
    }
    try {
      r.baseWin.setBounds({
        x: Math.round(b.x),
        y: Math.round(b.y),
        width: Math.round(b.width),
        height: Math.round(b.height),
      });
    } catch { /* window gone mid-set */ }
  });

  // page:maximize — snap the host to its display's work area, after stashing the
  // current bounds for restore. We use explicit work-area bounds rather than
  // baseWin.maximize() because frameless/panel-style windows on macOS don't
  // respond to native maximize() reliably (same rationale as page.js's
  // doMaximize, which sets workArea bounds directly).
  subscribe(getSystemAddress(), 'page:maximize', (raw) => {
    const r = baseWinFor(raw);
    if (!r) return;
    try {
      const cur = r.baseWin.getBounds();
      preMaximizeBounds.set(r.windowId, cur);
      const display = screen.getDisplayNearestPoint({
        x: cur.x + Math.floor(cur.width / 2),
        y: cur.y + Math.floor(cur.height / 2),
      });
      const wa = display.workArea;
      r.baseWin.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
    } catch { /* window gone */ }
  });

  // page:unmaximize — restore the pre-maximize bounds captured by page:maximize.
  // No-op if we have no stashed bounds (was never maximized via this path).
  subscribe(getSystemAddress(), 'page:unmaximize', (raw) => {
    const r = baseWinFor(raw);
    if (!r) return;
    const prev = preMaximizeBounds.get(r.windowId);
    if (!prev) return;
    preMaximizeBounds.delete(r.windowId);
    try {
      r.baseWin.setBounds(prev);
    } catch { /* window gone */ }
  });

  // ── P1.4b-4: find-in-page routing (overlay find bar → content WC) ───────────
  // The shared overlay owns the find-bar UI (renderer/page/overlay.{html,js}).
  // On the canvas path, page.js drives its own `<webview>.findInPage` directly
  // in-renderer; the hybrid content webContents is MAIN-owned, so the overlay
  // publishes its find intents tagged with the active windowId and main resolves
  // `getHybridContentWC(windowId)` to drive the real `findInPage`/`stopFindInPage`.
  //
  // Topic split (avoids colliding with the existing `page:find` /
  // `page:find-next` / `page:find-prev` accelerator topics, which mean "open /
  // advance the find UI" and are consumed by the renderer — page.js on canvas,
  // overlay.js on hybrid):
  //   - page:find-exec {windowId, text, options}  → findInPage(text, options)
  //   - page:find-next {windowId}                 → findInPage(last, {forward:true,  findNext:true})
  //   - page:find-prev {windowId}                 → findInPage(last, {forward:false, findNext:true})
  //   - page:find-stop {windowId}                 → stopFindInPage('clearSelection')
  // Per-window last-search text so a bare next/prev (incl. the Cmd+G accelerator)
  // repeats the active term. Cleaned lazily — a stale entry is harmless (the WC
  // for that windowId is gone, so wcFor returns null first).
  const lastFindText = new Map<number, string>();

  subscribe(getSystemAddress(), 'page:find-exec', (raw) => {
    const r = wcFor(raw);
    if (!r) return;
    const text = (raw as { text?: string }).text;
    if (text == null) return;
    if (!text) {
      // Empty query clears the active highlight (matches page.js findInPage('')).
      lastFindText.delete(r.windowId);
      try { r.wc.stopFindInPage('clearSelection'); } catch { /* wc gone */ }
      return;
    }
    lastFindText.set(r.windowId, text);
    const opts = (raw as { options?: Electron.FindInPageOptions }).options || {};
    try { r.wc.findInPage(text, opts); } catch { /* wc gone */ }
  });

  subscribe(getSystemAddress(), 'page:find-next', (raw) => {
    const r = wcFor(raw);
    if (!r) return;
    const text = lastFindText.get(r.windowId);
    if (!text) return;
    try { r.wc.findInPage(text, { forward: true, findNext: true }); } catch { /* wc gone */ }
  });

  subscribe(getSystemAddress(), 'page:find-prev', (raw) => {
    const r = wcFor(raw);
    if (!r) return;
    const text = lastFindText.get(r.windowId);
    if (!text) return;
    try { r.wc.findInPage(text, { forward: false, findNext: true }); } catch { /* wc gone */ }
  });

  subscribe(getSystemAddress(), 'page:find-stop', (raw) => {
    const r = wcFor(raw);
    if (!r) return;
    lastFindText.delete(r.windowId);
    try { r.wc.stopFindInPage('clearSelection'); } catch { /* wc gone */ }
  });

  // ── P1.4b-5: page-info extraction routing (overlay panel → content WC) ──────
  // The shared overlay's Page-Info side panel needs the active page's <meta>
  // metadata (title/description/og:*/author/etc.). On the canvas path page.js
  // reads it with `webview.executeJavaScript(...)` directly in-renderer. The
  // hybrid content webContents is MAIN-owned, so the overlay publishes
  // `page:extract-info {windowId}` and main resolves `getHybridContentWC` and
  // runs the IDENTICAL extraction script page.js uses (renderer/page/page.js
  // extractPageInfo), then publishes the result back as
  // `page:page-info {windowId, url, info}`. The overlay applies it only for the
  // active window (windowId match), exactly like every other content→chrome
  // topic. Non-hybrid/torn-down windowIds resolve to null → no-op.
  subscribe(getSystemAddress(), 'page:extract-info', (raw) => {
    const r = wcFor(raw);
    if (!r) return;
    let url = '';
    try { url = r.wc.getURL() || ''; } catch { /* wc gone */ }
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return;
    r.wc
      .executeJavaScript(`
        (function() {
          function getMeta(name) {
            var el = document.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]');
            return el ? (el.getAttribute('content') || '').trim() : '';
          }
          return {
            title: document.title || '',
            hostname: window.location.hostname || '',
            url: window.location.href || '',
            description: getMeta('description') || getMeta('og:description') || '',
            keywords: getMeta('keywords') || '',
            ogTitle: getMeta('og:title') || '',
            ogDescription: getMeta('og:description') || '',
            ogImage: getMeta('og:image') || '',
            ogSiteName: getMeta('og:site_name') || '',
            ogType: getMeta('og:type') || '',
            author: getMeta('author') || '',
            generator: getMeta('generator') || '',
            canonical: (function() {
              var link = document.querySelector('link[rel="canonical"]');
              return link ? link.href : '';
            })(),
            favicon: (function() {
              var link = document.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
              return link ? link.href : '';
            })()
          };
        })();
      `)
      .then((info: unknown) => {
        publish(getSystemAddress(), 'page:page-info', { windowId: r.windowId, url, info });
      })
      .catch((err: unknown) => {
        DEBUG && console.log(`[hybrid-page-host:${r.windowId}] page-info extract failed:`, err);
      });
  });

  DEBUG && console.log('[hybrid-page-host] navbar action routing installed');
}

// Exported reference to the window-open handler so other IPC surfaces (like tile
// IPC) can delegate to it without duplicating ~1300 lines of window creation logic.
// Populated by registerWindowHandlers() at startup.
// Use `any` for parameters to match the original implicit-any ergonomics of the
// IPC handler body (options is heavily dynamic).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export let invokeWindowOpen: ((ev: any, msg: any) => Promise<unknown>) | null = null;

export function registerWindowHandlers(): void {
  // Dismiss transient hybrid peek/slide surfaces when Peek loses app focus
  // (Cmd+Tab away). Registered once here (app is ready by the time IPC handlers
  // are wired). Unconditional: macOS is the only platform that emits
  // `did-resign-active`, so on other platforms these listeners simply never
  // fire. The become-active listener cancels the deferred close so the startup
  // resign→become activation dance can't dismiss a freshly opened slide.
  if (!appResignHybridWired) {
    appResignHybridWired = true;
    app.on('did-resign-active', onAppDidResignActive);
    app.on('did-become-active', onAppDidBecomeActive);
  }

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

      // P1.4a hybrid dedup (by key): hybrid page-hosts are BaseWindows, which
      // findWindowByKey (via getLiveWindow == BrowserWindow.fromId) cannot
      // resolve. When the flag is on, consult the hybrid registry first so a
      // repeat open of the same key REUSES the existing hybrid window (focus
      // its baseWin, return its id) instead of spawning a duplicate — matching
      // the canvas key-reuse semantics below. Gated on isHybridPageHost() so
      // non-hybrid opens are byte-identical (registry is empty when off).
      if (isHybridPageHost()) {
        const existingHybrid = findHybridWindowByKey(options.key);
        if (existingHybrid) {
          DEBUG && console.log('[hybrid-page-host] Reusing existing hybrid window with key:', options.key);
          // Parity with the canvas key-reuse below: refresh the per-window
          // transient flag from real-time OS focus (the session's isTransient()
          // has a one-way active→never-transient ratchet, so reuse from another
          // app must read appFocused directly) and let the stored Placement
          // intent rescue/re-center the window on a display change. A hybrid
          // window is a BaseWindow, but applyPlacementOnReuse only touches
          // getBounds/setBounds/id — BaseWindow-safe, same cast trackWindow uses.
          const hybridInfo = getWindowInfo(existingHybrid.windowId);
          if (hybridInfo) {
            hybridInfo.params.transient = !coordinator.isAppFocused();
          }
          if (!isHeadless()) {
            try {
              applyPlacementOnReuse(
                existingHybrid.baseWin as unknown as BrowserWindow,
                hybridInfo?.params.placement as Placement | undefined,
                'hybrid-keepLive-reuse',
              );
              existingHybrid.baseWin.show();
              existingHybrid.baseWin.focus();
              // Make the content view the first responder too (R4 — so cmd+L and
              // other key equivalents route to a responder, no NSBeep), matching
              // the fresh-open show path (showHybridHost).
              if (!existingHybrid.contentWC.isDestroyed()) existingHybrid.contentWC.focus();
            } catch (e) {
              DEBUG && console.log('[hybrid-page-host] focus-on-key-reuse failed:', e);
            }
          }
          return { success: true, id: existingHybrid.windowId, reused: true };
        }
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
      // P1.4a hybrid dedup (by url): same rationale as the key path above —
      // BaseWindow page-hosts are invisible to findWindowByUrl. When the flag
      // is on, reuse an existing hybrid window loading the same url (focus its
      // baseWin, reload it fresh like the canvas path, return its id) instead
      // of spawning a duplicate. Gated on isHybridPageHost(); registry empty
      // when off so non-hybrid opens are byte-identical.
      if (isHybridPageHost()) {
        const existingHybridByUrl = findHybridWindowByUrl(url);
        if (existingHybridByUrl) {
          DEBUG && console.log('[hybrid-page-host] Reusing existing hybrid window with same URL:', url);
          if (!isHeadless()) {
            try {
              // Parity with the canvas url-reuse below: honor the stored
              // Placement intent so a reused window stranded on a now-disconnected
              // display (or a 'centered' window) is rescued/re-centered.
              const hybridInfo = getWindowInfo(existingHybridByUrl.windowId);
              applyPlacementOnReuse(
                existingHybridByUrl.baseWin as unknown as BrowserWindow,
                hybridInfo?.params.placement as Placement | undefined,
                'hybrid-url-reuse',
              );
              existingHybridByUrl.baseWin.show();
              existingHybridByUrl.baseWin.focus();
              // First-responder parity with the fresh-open show path (R4): focus
              // the content view so key equivalents route to a responder.
              if (!existingHybridByUrl.contentWC.isDestroyed()) existingHybridByUrl.contentWC.focus();
            } catch (e) {
              DEBUG && console.log('[hybrid-page-host] focus-on-url-reuse failed:', e);
            }
          }
          // Reload so content is fresh (mirrors the canvas path's reload).
          try {
            existingHybridByUrl.contentWC.reload();
          } catch (e) {
            DEBUG && console.log('[hybrid-page-host] reload-on-url-reuse failed:', e);
          }
          return { success: true, id: existingHybridByUrl.windowId, reused: true };
        }
      }

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
      // Headless test runs: canvas windows are opacity:0 (invisible) anyway, so make
      // them OPAQUE instead of transparent. This keeps the full-screen geometry (bounds
      // round-trip tests still pass) but eliminates the per-pixel ALPHA COMPOSITING that
      // otherwise saturates macOS WindowServer when many full-screen page-host canvas
      // windows exist at once (e.g. session restore across parallel test workers).
      transparent: (useCanvas && !isHeadless()) ? true : (options.transparent || false),
      backgroundColor: ((useCanvas && !isHeadless()) || options.transparent) ? undefined : getSystemThemeBackgroundColor(),
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

    // ────────────────────────────────────────────────────────────────────
    // HYBRID PAGE-HOST EARLY BRANCH (P1.1, behind PEEK_PAGEHOST_HYBRID=1)
    //
    // When the hybrid flag is on AND this is a canvas web page, build the
    // page as an *opaque, content-sized* `BaseWindow` hosting a single
    // `WebContentsView` whose webContents loads the target URL directly —
    // NO `<webview>`, NO page.js chrome, NO per-page chrome renderer (R6:
    // a BaseWindow + WebContentsView is a true zero-extra-renderer host).
    //
    // This branch CONSTRUCTS + REGISTERS + RETURNS on its own and does NOT
    // fall through to the downstream `BrowserWindow` code, which assumes a
    // root `win.webContents`, `win.loadURL`, the tile-broadcaster keyed on
    // the root webContents, a `<webview>` guest, etc. A `BaseWindow` has no
    // root webContents, so none of that applies here.
    //
    // SCOPE: P1.1 built this branch (content on screen as one window, one
    // renderer, no crash); P1.2–P1.5 then layered on compat-preload
    // re-attachment, content→chrome event mediation, the shared overlay, and
    // popup routing.
    //
    // Window-reuse/dedup IS handled — just not here. The canvas dedup checks
    // earlier in this handler (findWindowByUrl / findWindowByKey) resolve via
    // getLiveWindow == BrowserWindow.fromId, which cannot find a BaseWindow. So
    // P1.4a added a PARALLEL dedup against the hybrid registry at the top of
    // this handler (findHybridWindowByKey / findHybridWindowByUrl), gated on
    // isHybridPageHost(), which reuses+focuses the existing hybrid window
    // (with placement-on-reuse + transient-refresh parity) before we ever reach
    // this construction branch. We only get here on a genuine first open.
    if (isHybridPageHost() && useCanvas) {
      try {
        // winOptions.x/y/width/height were filled in above by
        // `computeInitialBounds` (or the caller's explicit x/y) and hold the
        // CONTENT-RECT bounds — we deliberately skip the canvas margin
        // expansion (the chrome-less hybrid window has no surrounding chrome).
        const contentX = winOptions.x as number;
        const contentY = winOptions.y as number;
        const contentW = winOptions.width as number;
        const contentH = winOptions.height as number;

        const baseWin = new BaseWindow({
          x: contentX,
          y: contentY,
          width: contentW,
          height: contentH,
          frame: false,
          // Opaque, native floating look (R1). Headless: keep it invisible
          // via opacity:0 + show:false, mirroring the canvas path's headless
          // guard at the top of this handler so an agent/CI run never paints
          // a real surface on the physical desktop.
          transparent: false,
          roundedCorners: true,
          hasShadow: !isHeadless(),
          show: false,
          opacity: isHeadless() ? 0 : undefined,
          // Loading-background fill: we show this window at load-START (below),
          // before its content WebContentsView has painted anything, so the
          // user gets the soonest possible confirmation of their click — the
          // bordered/rounded native frame + shadow. Without an explicit
          // backgroundColor that early frame would flash as an empty white box.
          // Painting the theme background (light #ffffff / dark #1e1e1e — the
          // same fill the canvas path's `webview.loading` rgba(255,255,255,0.95)
          // / rgba(30,30,30,0.95) produces) makes the early frame read as a
          // loading surface; the content view then paints over it as it loads,
          // fading naturally to the real page.
          backgroundColor: getSystemThemeBackgroundColor(),
        });

        // Content view: main owns this webContents handle. Session MUST match
        // today's `<webview>`, which uses partition `persist:${profileId}`
        // (page.js sets `webview.partition` from `api.profiles.getPartition()`).
        // `getProfileSession()` returns exactly `session.fromPartition` of that
        // same string, so the content lands in the IDENTICAL profile session
        // (cookies/storage/cache) as the old path.
        //
        // P1.2 — runtime-external compat preload. `preload` is construction-
        // fixed for a WebContentsView (it cannot be added after creation), so
        // we select it HERE using the same URL-keyed helper that drives the
        // `<webview>` will-attach-webview path. For an http(s) URL matching a
        // loaded extension's externally_connectable or its ISOLATED content
        // scripts this installs runtime-external-preload.cjs +
        // `--peek-runtime-external-ext-id` (+ `--peek-cs-relay-enabled`) and
        // disables sandbox (Electron 40 sandbox-bundle bug on Proton's auth
        // SPA). Otherwise webPrefs stays minimal. contextIsolation stays true
        // either way.
        const rtPrefs = getRuntimeExternalWebPrefsForUrl(url, 'hybrid');
        const view = new WebContentsView({
          webPreferences: {
            session: profileSession,
            contextIsolation: true,
            devTools: true,
            ...(rtPrefs
              ? {
                  preload: rtPrefs.preload,
                  additionalArguments: rtPrefs.additionalArguments,
                  sandbox: rtPrefs.sandbox,
                }
              : {}),
          },
        });

        baseWin.contentView.addChildView(view);

        // Fill the window; keep it filled on resize.
        const fillView = () => {
          const [w, h] = baseWin.getContentSize();
          view.setBounds({ x: 0, y: 0, width: w, height: h });
        };
        fillView();
        baseWin.on('resize', fillView);

        // P0 seam: mark the content webContents so the permission lookup
        // (registerGuest → findHostWindowId) treats it as page-host content.
        markPageHostContent(view.webContents);
        registerGuest(view.webContents, baseWin.id);

        // P1.4a — register this hybrid window so it is enumerable, dedup-able
        // by url/key, focus-trackable, and targetable. A BaseWindow is not a
        // BrowserWindow, so window-registry's BrowserWindow-backed lookups
        // cannot hold it; this separate registry is the indirection layer.
        // Self-cleans on baseWin 'closed' / content wc 'destroyed' and
        // maintains getActiveHybridWindowId() off baseWin focus/blur.
        registerHybridWindow(baseWin.id, {
          baseWin,
          contentWC: view.webContents,
          key: options.key,
          url,
        });

        // Feed the per-app focus trackers (lastFocusedVisibleWindowId /
        // lastContentWindowId) from the host BaseWindow's focus event. The
        // hybrid registry tracks its OWN active-window id off this same event,
        // but those ipc.ts trackers are what session-save reads to mark the
        // focused descriptor (and what per-window commands target). A BaseWindow
        // never flows through trackOnWindowFocus (it has no root webContents),
        // so without this a focused web page is never recorded as focused —
        // session restore then raises the last-focused BrowserWindow (e.g.
        // Settings) instead of the web page the user left in front.
        const onHybridHostFocus = () => {
          // Restore first responder to the content WebContentsView when this host
          // gains focus. showHybridHost applies `contentWC.focus()` only on a FRESH
          // show; a host restored via showInactive (session restore) and later
          // RAISED by chrome / Cmd+Tab / Mission Control fires baseWin 'focus' (so
          // the active-hybrid id — and thus the suppressed global ESC fallback —
          // is correct) but never made its content WC first responder, so ESC (and
          // every other before-input key) was dead until the user clicked the page.
          // The predicate skips headless (focus-free) and the already-focused case
          // (host focus triggered BY a click into the page → no redundant re-focus
          // / focus-event loop). Traced 2026-06-10.
          try {
            if (
              shouldFocusHybridContentOnHostFocus(
                isHeadless(),
                view.webContents.isDestroyed(),
                view.webContents.isFocused(),
              )
            ) {
              view.webContents.focus();
            }
          } catch {
            /* focus/isFocused can throw on a torn-down wc — ignore */
          }
          try {
            if (view.webContents.isDestroyed()) return;
            trackHybridWindowFocus(baseWin.id, view.webContents.getURL());
          } catch {
            /* getURL can throw on a torn-down wc — ignore */
          }
          // A hybrid host gaining focus must run the SAME transient-sibling
          // autoclose the BrowserWindow focus handler does — otherwise focusing
          // a web page (or opening peek/slide B) never dismisses an open
          // peek/slide A (both are now BaseWindows). The wrapper resolves this
          // host's own role; a transient focuser still closes OTHER transients.
          // Regression: peek 8e5c3174. Guarded so a focus-bookkeeping throw can
          // never wedge the close (and vice-versa).
          try {
            closeTransientSiblingsOnFocus(baseWin.id);
          } catch (err) {
            DEBUG && console.log('[izui] hybrid-focus autoclose failed:', err);
          }
        };
        baseWin.on('focus', onHybridHostFocus);
        // Belt-and-suspenders: clicking directly into the page focuses the
        // content webContents even when the host-window focus event is missed.
        view.webContents.on('focus', onHybridHostFocus);

        // P1.2 — re-attach the chrome-ext compat hooks to THIS content
        // webContents EXPLICITLY. We cannot rely on entry.ts's
        // `web-contents-created` handler: that event fires SYNCHRONOUSLY inside
        // `new WebContentsView(...)` above, which is BEFORE `markPageHostContent`
        // ran — so `isPageHostContent` was still false when entry.ts evaluated
        // its gate, and entry.ts skipped the dom-ready/did-navigate installs for
        // this wc. Calling the same shared installers here makes attachment
        // timing-independent for the hybrid path. (preload was already applied
        // at construction above — it is construction-fixed.)
        installMainWorldContentScriptInjection(view.webContents);
        installRuntimeExternalCdpPolyfill(view.webContents);
        console.log(`[hybrid-page-host] compat hooks attached to content wc ${view.webContents.id} (rtPreload=${rtPrefs ? 'yes' : 'no'})`);

        // P1.3 — forward the content webContents's lifecycle events as the
        // `page:*` pubsub topics + datastore side-effects the canvas path's
        // page.js / guest-webContents handlers produce today. Attach BEFORE
        // loadURL so did-start-loading / did-navigate / did-finish-load are
        // not missed. (Action mediation — navbar→content — is DEFERRED to
        // P1.4, where the shared overlay is the consumer.)
        wireHybridContentEvents(view.webContents, baseWin.id, url, options);

        // P1.3 — initial history insert, matching the canvas path's
        // trackWindowLoad (ipc.ts ~2422). Skip internal peek:// URLs and
        // session restores (skipTracking), exactly like the canvas path.
        if (!url.startsWith('peek://') && !options.skipTracking) {
          try {
            const trackResult = trackWindowLoad(url, {
              source: options.trackingSource || options.feature || 'window',
              sourceId: options.trackingSourceId || '',
              windowType: options.modal ? 'modal' : 'main',
              title: options.title || '',
            });
            if (trackResult.created) {
              publish('system', 'item:created', {
                itemId: trackResult.itemId,
                itemType: 'url',
                content: url,
                windowId: baseWin.id,
              });
            }
          } catch (e) {
            DEBUG && console.log('[hybrid-page-host] initial trackWindowLoad failed:', e);
          }
        }

        // Minimal window registration: enough for the window to be placed,
        // tracked for the display-watcher, and known to the window manager /
        // izui coordinator. We SKIP the tile-broadcaster + page-host token
        // registration (there is no chrome tile in P1.1) and the root-webContents
        // event wiring (there is no root webContents).
        const role = inferIzuiRole(options as Parameters<typeof inferIzuiRole>[0], {
          isWebPage,
          parentWindowId: isRealParent ? openerWindow!.id : null,
        });
        const windowParams: Record<string, unknown> = {
          ...options,
          address: url,
          transient: isTransient,
          parentWindowId: isRealParent ? openerWindow!.id : null,
          role,
          placement,
          // Seed canvas state from the content rect so session save / reuse
          // logic that reads these has sane values (matches the canvas path's
          // intent; x/y/w/h are the content rect, which IS the window here).
          x: contentX,
          y: contentY,
          width: contentW,
          height: contentH,
          maximized: options.maximized === true,
          // Mark this as a hybrid page-host so later phases (and any
          // downstream code) can distinguish it from a BrowserWindow page-host.
          hybridPageHost: true,
        };
        registerWindow(baseWin.id, msg.source, windowParams);
        trackWindow(baseWin as unknown as BrowserWindow);
        getIzuiCoordinator().pushWindow(baseWin.id);

        // Close-finalize tail. A hybrid page-host is a BaseWindow, so it never
        // flows through main.ts's `app.on('browser-window-created') → win 'closed'`
        // handler — meaning without this wiring a closed hybrid would never push
        // onto the reopen stack (Cmd+Shift+T), never publish `window:removed`
        // (close-awaits would hang), and never schedule the close-snapshot (an
        // explicitly-closed window could reappear after a force-kill). Run the
        // SAME shared `finalizeWindowClose` the BrowserWindow path runs.
        //
        // Capture the content-rect bounds/presentation in the pre-destroy
        // 'close' event (BaseWindow emits 'close' before destruction); the hybrid
        // registry entry — and the BaseWindow itself — are still alive then, so
        // `getWindowPresentation` resolves the hybrid content rect. Reading
        // bounds after destruction would be too late (the native handle is gone).
        let hybridLastBounds: { x: number; y: number; width: number; height: number } | null = null;
        let hybridLastPresentation: import('./window-presenter.js').WindowPresentation | null = null;

        // Run the finalize tail exactly once, driven by the FIRST signal to fire.
        //
        // Electron 40 reality for a `BaseWindow` whose only child is a
        // `WebContentsView`, closed via `baseWin.close()` (verified by runtime
        // instrumentation): the host emits `'close'` and then tears down
        // SYNCHRONOUSLY (`isDestroyed()` is already true when `close()` returns),
        // but it never emits `'closed'`, AND the main-owned content
        // `WebContents` is left ALIVE (orphaned) — so its `'destroyed'` never
        // fires either. Gating the tail on `'closed'`/`'destroyed'` therefore
        // left it dead: a closed hybrid never pushed to the reopen stack
        // (Cmd+Shift+T did nothing) and never published `window:removed`
        // (`closeWindowById` / window:removed awaits hung ~60s).
        //
        // The only reliable terminal signal is `'close'`, which fires
        // pre-destruction while the registry entry and bounds are still readable
        // — so we finalize from the `'close'` handler below (right after
        // capturing bounds). The host `'close'` is never `preventDefault()`-ed
        // for a hybrid (no beforeunload veto on the BaseWindow host), so it
        // always means the window is really going away. The `'closed'` /
        // content-wc `'destroyed'` bindings stay as once-guarded fallbacks for
        // any teardown path that DOES emit them (e.g. app-quit, or the content
        // wc being destroyed directly).
        let hybridFinalized = false;
        const runHybridFinalize = () => {
          if (hybridFinalized) return;
          hybridFinalized = true;
          finalizeWindowClose(baseWin.id, {
            bounds: hybridLastBounds,
            // Hybrid windows never use the `peek://app/page/` shell URL, so the
            // canvas-margin fallback inside finalizeWindowClose (gated on that
            // prefix) can't fire; null is correct here.
            hostUrl: null,
            presentation: hybridLastPresentation,
          });

          // P0 LEAK FIX (A1d). In Electron 40 a hybrid page-host closed via
          // `baseWin.close()` tears the BaseWindow down SYNCHRONOUSLY but never
          // emits `'closed'`, AND leaves the main-owned content `WebContents`
          // (this WebContentsView's wc — a live renderer process) ORPHANED:
          // `view.webContents.isDestroyed()` stays false and its `'destroyed'`
          // never fires. A1c finalized only the lifecycle SIGNALS (reopen-stack
          // / window:removed / snapshot) off the `'close'` event; it did NOT
          // free those resources. Without this, every hybrid page close leaks a
          // renderer process AND the registry entry (whose self-clean is wired
          // to the `'closed'`/`'destroyed'` events that never fire) — a long
          // session accumulates orphaned renderers, undercutting the cutover's
          // perf justification.
          //
          // This runs ONLY on a REAL close: it's inside the once-guarded
          // `runHybridFinalize`, which is driven by the host BaseWindow's
          // `'close'` event. A keepLive HIDE never reaches here — hybrids have
          // no keepLive path (tile-ipc.ts routes BrowserWindows through
          // closeOrHideWindow, and only takes the `hybrid.baseWin.close()`
          // branch for a BaseWindow, which `getLiveWindow` cannot resolve), and
          // `baseWin.hide()` does not emit `'close'`. So hide keeps the wc alive
          // for reuse, exactly as required; only a genuine close frees it.
          try {
            // `webContents.close()` is the documented teardown: with
            // `waitForBeforeUnload` unspecified it does NOT honor a beforeunload
            // veto and destroys the wc (firing `'destroyed'`). The host window
            // is already gone, so a beforeunload prompt would be meaningless.
            if (!view.webContents.isDestroyed()) {
              view.webContents.close();
            }
          } catch (e) {
            DEBUG && console.log(`[hybrid-page-host:${baseWin.id}] content wc close on finalize failed:`, e);
          }
          // Drop the registry entry deterministically. Its self-clean hooks
          // (`baseWin 'closed'` / content-wc `'destroyed'`) are unreliable on
          // this path — `'closed'` never fires, and `'destroyed'` (if the
          // `close()` above triggers it) would race the close handler. This is
          // idempotent, so a later `'destroyed'` self-clean is a harmless no-op.
          unregisterHybridWindow(baseWin.id);
        };

        baseWin.on('close', () => {
          try {
            if (!baseWin.isDestroyed()) {
              hybridLastBounds = baseWin.getBounds();
              hybridLastPresentation = getWindowPresentation(baseWin.id);
            }
          } catch {
            // Ignore errors during shutdown
          }
          runHybridFinalize();
        });
        baseWin.once('closed', runHybridFinalize);
        view.webContents.once('destroyed', runHybridFinalize);

        // Show it AT LOAD-START — before awaiting the content — so the window's
        // bordered/rounded native frame + shadow + loading-background fill (set
        // on the BaseWindow ctor above) appears the INSTANT the load begins, as
        // the soonest possible confirmation of the click. Previously the show
        // happened only AFTER `await loadURL`, so clicking to open a page showed
        // NOTHING (no window, no border) until the page finished loading. The
        // content WebContentsView paints over the loading fill as it loads,
        // fading naturally to the real page — mirroring the canvas path, where
        // `loadingLifecycle.startLoading()` adds the bordered `.loading` frame at
        // load-start (page.js) instead of waiting for the content.
        //
        // The same single `showHybridHost` seam runs here as before — only its
        // POSITION moved earlier. Non-headless ACTIVATES (app frontmost + key
        // window) and makes the content WebContentsView the macOS first responder,
        // so cmd+L and other key equivalents have a target (no NSBeep) and the
        // host's focus drives the active-hybrid id that reveals the overlay
        // (regressions 1b6eaf0b / 363e7cff / 8f7010a8). Focusing a not-yet-loaded
        // (blank) content view is fine — the first-responder + active-hybrid-id
        // wiring is what matters, not what the view currently paints. Headless
        // stays inactive + opacity-0, so an agent/CI run never steals the user's
        // focus (peek task 2b55f3af).
        //
        // EXCEPTION — `show:false` opens (session restore): the caller wants the
        // host visible but NOT activated. Each restored hybrid window activating
        // itself is the wrong-focus-on-restart regression — the last to show (or
        // the race winner) ends up frontmost instead of the page the user left
        // focused at quit. The restore loop re-activates ONLY the focused
        // descriptor afterwards. Mirrors the canvas ctor `show: options.show !==
        // false` above.
        showHybridHost(baseWin, view.webContents, { inactive: options.show === false });

        // Load the content. Session-restore opens (skipTracking) fire-and-forget
        // like the canvas path; everything else awaits for "ready" semantics
        // (the window is already on screen with its loading frame either way).
        if (options.skipTracking) {
          view.webContents.loadURL(url).catch((err) => {
            DEBUG && console.log(`[hybrid-page-host:${baseWin.id}] background loadURL failed:`, err);
          });
        } else {
          await view.webContents.loadURL(url);
        }

        publish(getSystemAddress(), 'window:opened', {
          id: baseWin.id,
          url,
          source: msg.source,
        });

        if (options.key) {
          pendingWindowKeys.delete(`${msg.source}:${options.key}`);
        }

        console.log(`[hybrid-page-host] Opened BaseWindow ${baseWin.id} with WebContentsView for ${url.substring(0, 80)}`);
        return { success: true, id: baseWin.id };
      } catch (error) {
        if (options?.key) {
          pendingWindowKeys.delete(`${msg.source}:${options.key}`);
        }
        console.error('[hybrid-page-host] Failed to open hybrid page window:', error);
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    }
    // ────────────────────────────────────────────────────────────────────

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
    // Headless never floats a window above the user's real desktop (mirrors the
    // gated setAlwaysOnTop reinforcement below).
    if (options.alwaysOnTop !== undefined) winOptions.alwaysOnTop = !isHeadless() && !!options.alwaysOnTop;
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
        // Deferred session-restore gate. Windows restored beyond the eager set
        // (see SESSION_EAGER_RESTORE_COUNT in session.ts) pass `restoreBlank:
        // true`. The page-host renderer reads `blank=1` and DOES NOT navigate
        // the <webview> — it shows a cheap static placeholder (title + URL +
        // favicon) instead, so a restored-but-unfocused window does no content
        // compositing (the dominant sustained restore GPU cost). The real URL
        // stays in `url` (already set above) so navigate-on-focus can load it;
        // `title` rides along so the placeholder can render the saved title
        // without waiting for the page. See docs/page-host-state-machine.md
        // and session.ts restoreSessionSnapshot.
        if (options.restoreBlank === true) {
          pageParams.set('blank', '1');
          if (typeof options.title === 'string' && options.title) {
            pageParams.set('title', options.title);
          }
        }
        // Panel gate: peek/slide panels (modal/quick-view/overlay roles) route
        // through the canvas page-host with chrome ENABLED, but the page-host
        // navbar doubles as a loading indicator and fades in on every canvas
        // open — for a focused panel that reads as a flash of the address bar
        // before the page settles. Mark these opens as `panel=1` so the
        // renderer suppresses the LOADING-time chrome summon (hover / Cmd+L /
        // activate still summon chrome on user intent). Content windows carry
        // no `panel` param and are unaffected.
        if (isModalOrQuickView || options.role === 'quick-view' || options.role === 'overlay') pageParams.set('panel', '1');
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

      // Navigate-on-focus for deferred session-restore windows. A window
      // restored with `restoreBlank: true` came up showing the static
      // placeholder with its <webview> un-navigated (zero content compositing
      // while it sits unfocused). The first time the user focuses it, tell the
      // page-host renderer to load the real URL — after which it is an ordinary
      // live window. One-shot: the flag flips on the first focus so re-focusing
      // never re-triggers navigation (idempotent; the renderer also guards).
      // The renderer's pointerdown/keydown engagement path (chrome-init) is the
      // other trigger, so a click-to-focus also loads; this focus IPC covers
      // focus-without-click (Cmd+Tab, programmatic raise during restore).
      let deferredRestoreNavSent = options.restoreBlank !== true;
      win.on('focus', () => {
        console.log(`[focus-tracker] win.on(focus) fired id=${win.id}`);
        if (!deferredRestoreNavSent) {
          deferredRestoreNavSent = true;
          try {
            if (!win.isDestroyed()) {
              win.webContents.send('page:navigate-deferred');
              DEBUG && console.log(`[session] navigate-on-focus: signaled deferred window ${win.id} to load real URL`);
            }
          } catch (err) {
            console.error('[session] navigate-on-focus send threw:', err);
          }
        }
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
        // focus. IZUI policy: palette / quick-view windows are transient —
        // they should dismiss as soon as focus moves to any other window. The
        // per-window `blur` handler attached to modals covers Cmd+Tab and
        // clicks into other apps, but macOS NSPanels (type:'panel' +
        // alwaysOnTop) don't fire reliable `blur` when focus shifts to another
        // panel-type window in the same app — so opening slide B from edge X
        // never closes slide A on edge Y. The cmd panel restored this on the
        // renderer side via a `window:focused` subscription (commit 6361cf19);
        // generalize it here for all transient roles in the main process so we
        // don't need a per-feature renderer hook for every panel-style tile.
        //
        // The candidate set spans BOTH BrowserWindows and hybrid page-host
        // BaseWindows (peeks/slides are the latter under the hybrid default),
        // and the same close runs from the hybrid focus path — see
        // `closeTransientSiblingsOnFocus`.
        closeTransientSiblingsOnFocus(win.id);
      });
      // Also track immediately if this is a content/visible window (non-modal only)
      trackContentWindowFocus(win);
      if (!options.modal) {
        trackVisibleWindowFocus(win);
      }

      // Set up DevTools if requested
      winDevtoolsConfig(win);

      // Auto-open devtools for peek:// URLs in CLI dev mode (DEBUG=1
       // env, set by `yarn dev`). Previously keyed on the live mutable
       // DEBUG export, which the Settings → Diagnostics → "Verbose
       // logging" toggle could flip on — that conflated logging with
       // auto-opening, fanning out devtools on every session-restored
       // peek:// window. Env-only check keeps Verbose Logging purely a
       // logging toggle.
      if (process.env.DEBUG && url.startsWith('peek://') && !isTestProfile() && !isHeadless()) {
        // Opening detached DevTools on create steals the macOS first responder
        // from the freshly-shown host window — even with activate:false — so the
        // window comes up visible/frontmost but with NO responder. Keyboard nav
        // (tags j/k, page hotkeys) is then dead until the user clicks, which sets
        // the responder. Restore first responder to the host content on the
        // deterministic `devtools-opened` signal (NOT a timer — the event fires
        // once the detached window has taken/released focus). Dev-only path; prod
        // never auto-opens devtools so this is inert there.
        win.webContents.once('devtools-opened', () => {
          if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.focus();
          }
        });
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
      if (windowSelfClosesOnBlur(options) && process.env.E2E_TEST !== 'true') {
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
