/**
 * IPC Handler Registration
 *
 * Centralizes all IPC handlers for the main process.
 * Handlers are thin wrappers that delegate to backend functions.
 */

import { ipcMain, nativeTheme, dialog, BrowserWindow, BaseWindow, WebContentsView, app, screen, webContents, net } from 'electron';
import { getAllLiveWindows, getLiveWindow, windowFromWebContents } from './window-registry.js';
import { hybridResizeDirAt, RESIZE_EDGE_PX, RESIZE_CORNER_PX } from './izui-roles.js';
import type { ResizeDir } from './izui-roles.js';
import path from 'node:path';

import {
  getDb,
  // Item operations
  getItem,
  updateItem,
  updateItemTitle,
  updateItemFavicon,
  getFaviconForUrl,
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

import {
  captureThumbnail,
} from './thumbnails.js';

import {
  winDevtoolsConfig,
  closeOrHideWindow,
  getSystemThemeBackgroundColor,
  getPrefs,
  showWindowHeadlessSafe,
  showHybridHost,
} from './windows.js';
import {
  registerWindowWithMachine,
  dispatchWindowEvent,
  getFrontWindowId,
  getFrontPageHostId,
  getWindowModeName,
  getWindowIdFor,
  getNativeWindowFor,
  type MachineWindowSpec,
} from './window-state-singleton.js';
import { isSatelliteRegistration, classifyWindowRegistration } from './window-state.js';
import {
  TRANSIENT_ROLES,
  inferIzuiRole,
  spacesPolicyForRole,
  selectTransientSiblingsToClose,
  shouldCloseContentWCOnFinalize,
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

import { markPageHostContent, registerGuest } from './webview-guest-registry.js';
import {
  registerHybridWindow,
  unregisterHybridWindow,
  findHybridWindowByUrl,
  findHybridWindowByKey,
  getHybridContentWC,
  getHybridWindow,
  getAllHybridWindows,
  setHybridMaximizeState,
  claimHybridDeferredLoad,
  // Stage B: per-host load-error state + timeout (lives in registry to avoid circular dep)
  setHybridLoadError,
  getHybridLoadError,
  getHybridLoadingTimeoutMs,
  setHybridPendingNavUrl,
  takeHybridPendingNavUrl,
  // Loading-card first-paint tracking
  markHybridPainted,
  hasHybridPainted,
  // Same-URL Retry cap
  HYBRID_SAME_URL_RETRY_CAP,
  noteHybridLoadFailure,
  hasHybridOutstandingFailure,
  noteHybridRetryAttempt,
  getHybridRetryAttempts,
  clearHybridRetry,
} from './hybrid-page-host-registry.js';

/**
 * Gather every live window — BrowserWindow AND hybrid page-host (BaseWindow) —
 * as transient-autoclose candidates, tagged with its registry role and current
 * visibility. Hybrid windows are NOT BrowserWindows, so `getAllLiveWindows()`
 * (BrowserWindow.getAllWindows-backed) can't see them; we union the hybrid
 * registry in. Empty hybrid contribution only if no hybrid windows exist
 * (hybrid is the only page-host path now, not a flag-gated one).
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
      // Fire-and-forget: closeOrHideWindow is async (awaits a fullscreen exit on
      // its hybrid branch) but never rejects (internal try/catch). Transient
      // autoclose doesn't need to block on the dismissal.
      void closeOrHideWindow(id);
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
      // Fire-and-forget (async, never rejects) — see closeTransientSiblingsOnFocus.
      void closeOrHideWindow(id);
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
  initHybridEditableFocusTracking,
  isEditableFocusedForWc,
  clearEditableFocusForWc,
} from './hybrid-editable-focus.js';
import { initHybridWindowGestureHandling } from './hybrid-window-gesture.js';

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

// Focused-window tracking (S1 `lastFocusedVisibleWindowId` / S4 `lastContentWindowId`
// / `focus-order.ts`) is GONE — the window-state machine's `front` + per-record
// `focusSeq`/`lastHttpUrl` are the single authority now. Consumers read
// `getFrontWindowId()` / `getDevtoolsTargetId()` / `getFocusOrder()` from
// `window-state-singleton.ts`; every window's focus is fed to the machine by the
// OS adapter's native `focus` listeners (attached at `registerWindowWithMachine`),
// so there are no `track*` feeds to maintain here.

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

  // Inherit space mode from the front (last focused visible) window. The
  // machine speaks WM WindowId; the context store is still keyed by Electron
  // window ids, so join through the front's native handle.
  const front = getFrontWindowId();
  const frontWin = front != null ? getNativeWindowFor(front) : null;
  const frontId = frontWin ? frontWin.id : null;
  if (frontId != null) {
    try {
      const modeEntry = getContextEntry('mode', frontId);
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
 * `usePageHost`. The content wc is the only main-owned content webContents,
 * so attaching here is the hybrid-only path.
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

// Per-host content-cursor setters, keyed by host windowId. Each hybrid content WC
// registers its `setContentCursor` (which feeds the SAME single-in-flight cursor
// reconciler its resize hover cursor uses — see wireHybridContentEvents) here, so
// the ONE global `page:drag-cursor` subscription (installHybridNavbarActionRouting)
// can paint the hold-to-drag grab/grabbing cursor over the RIGHT host's web
// content. Reusing the per-host reconciler (rather than a second, independent one)
// guarantees resize + grab can never leave two cursors painted on one WC. Cleaned
// on content-WC teardown so a closed host leaves no stale setter.
const hybridContentCursorSetters = new Map<number, (cursor: string | null) => void>();

/**
 * Construct the opaque, content-sized BaseWindow host shell for a hybrid
 * page-host. Extracted from the windowOpenHandler hybrid branch so the
 * fresh-open path and the window.open popup (createWindow) path build an
 * IDENTICAL host shell. x/y omitted → Electron centers the window on screen
 * (used for popups whose window.open features string carried no position).
 */
function createHybridHostBaseWindow(
  rect: { x?: number; y?: number; width: number; height: number },
  opts?: { type?: Electron.BaseWindowConstructorOptions['type'] },
): Electron.BaseWindow {
  return new BaseWindow({
    ...(typeof rect.x === 'number' ? { x: rect.x } : {}),
    ...(typeof rect.y === 'number' ? { y: rect.y } : {}),
    width: rect.width,
    height: rect.height,
    frame: false,
    transparent: false,
    roundedCorners: true,
    hasShadow: !isHeadless(),
    show: false,
    opacity: isHeadless() ? 0 : undefined,
    backgroundColor: getSystemThemeBackgroundColor(),
    // Quick-view surfaces (peeks/slides) request `type:'panel'` → a macOS
    // NSNonactivatingPanel: it can be key (take input) WITHOUT activating the
    // app, so a hotkey-opened peek/slide doesn't steal the frontmost app's OS
    // focus (regression 524f7aba). Regular web tabs pass no `type` and stay
    // ordinary activating windows (the dead-focus invariant — CLAUDE.md).
    ...(opts?.type ? { type: opts.type } : {}),
    // Quick-view panels (peeks/slides) are transient by design and must never
    // enter native fullscreen — there is no per-peek fullscreen affordance, but
    // the generic `fullscreen` command would otherwise drive a focused peek/slide
    // into fullscreen (nothing else refused it). `fullscreenable:false` makes the
    // OS itself no-op `setFullScreen(true)`, so the illegal state is unrepresentable
    // at the boundary rather than a rule the window-state reducer has to remember.
    // Keyed on the panel type so real web page-hosts stay fullscreen-capable; does
    // not affect maximize (that path uses explicit work-area setBounds, not setFullScreen).
    ...(opts?.type === 'panel' ? { fullscreenable: false } : {}),
  });
}

/**
 * Derive the content rect for a window.open popup host from the ctor options
 * Chromium parsed out of the window.open(url, name, features) features string.
 * Falls back to the app default size; omits x/y when Chromium supplied none so
 * createHybridHostBaseWindow lets Electron center it.
 */
function resolvePopupContentRect(ctorOptions: Electron.BrowserWindowConstructorOptions): { x?: number; y?: number; width: number; height: number } {
  const width = typeof ctorOptions.width === 'number' && ctorOptions.width > 0 ? ctorOptions.width : APP_DEF_WIDTH;
  const height = typeof ctorOptions.height === 'number' && ctorOptions.height > 0 ? ctorOptions.height : APP_DEF_HEIGHT;
  const x = typeof ctorOptions.x === 'number' ? ctorOptions.x : undefined;
  const y = typeof ctorOptions.y === 'number' ? ctorOptions.y : undefined;
  return { x, y, width, height };
}

interface HybridHostAssembleCtx {
  url: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: any;
  source: string;
  placement: Parameters<typeof computeInitialBounds>[0];
  contentX: number;
  contentY: number;
  contentW: number;
  contentH: number;
  isWebPage: boolean;
  isTransient: boolean;
  openerWindow: Electron.BrowserWindow | null;
  isRealParent: boolean;
  deferContentLoad: boolean;
  rtPreloadApplied: boolean;
}

/**
 * Wire up a hybrid page-host given an already-constructed BaseWindow + content
 * WebContentsView (freshly minted for a normal open, or adopted from Chromium's
 * opener-wired guest WC for a window.open popup). Does everything from
 * addChildView through showHybridHost. Does NOT loadURL (caller owns: the fresh
 * path awaits loadURL; the popup path lets Chromium navigate an ADOPTED guest WC,
 * but loads a FRESH-MINTED WC itself — see the createWindow branch).
 */
function assembleHybridPageHost(
  baseWin: Electron.BaseWindow,
  view: Electron.WebContentsView,
  ctx: HybridHostAssembleCtx,
): void {
  const {
    url, options, source, placement,
    contentX, contentY, contentW, contentH,
    isWebPage, isTransient, openerWindow, isRealParent,
    deferContentLoad, rtPreloadApplied,
  } = ctx;

  baseWin.contentView.addChildView(view);

  // Give the content WebContentsView the same theme fill as the host BaseWindow
  // (ipc.ts window-open BaseWindow ctor). Without this, the GPU-backed content
  // view paints opaque macOS black over the host's theme background until its
  // first frame commits — the "black screen while restoring" the user saw. The
  // BaseWindow backgroundColor is the outer belt; this is the inner one for the
  // view that actually overlaps the content rect.
  try {
    view.setBackgroundColor(getSystemThemeBackgroundColor());
  } catch {
    /* setBackgroundColor unsupported in some envs */
  }

  // Fill the window; keep it filled on resize.
  const fillView = () => {
    const [w, h] = baseWin.getContentSize();
    view.setBounds({ x: 0, y: 0, width: w, height: h });
  };
  fillView();
  baseWin.on('resize', fillView);

  // P0 seam: mark the content webContents so the permission lookup
  // (registerGuest → findHostWindowId) treats it as page-host content.
  // (registerGuest itself happens after registerWindowWithMachine below —
  // the guest registry carries WM WindowIds, which the machine mints.)
  markPageHostContent(view.webContents);

  // P1.4a — register this hybrid window so it is enumerable, dedup-able
  // by url/key, focus-trackable, and targetable. A BaseWindow is not a
  // BrowserWindow, so window-registry's BrowserWindow-backed lookups
  // cannot hold it; this separate registry is the indirection layer.
  // Self-cleans on baseWin 'closed' / content wc 'destroyed' and
  // maintains getActiveHybridWindowId() off baseWin focus/blur.
  // Deferred session restore (perf): windows beyond the eager count
  // restore with `restoreBlank` (set per-window by the restore loop in
  // session.ts). The BaseWindow + WebContentsView + registration +
  // frame state (bounds/maximize) are all built as normal, but the
  // content loadURL is DEFERRED to the window's first genuine
  // activation — the host BaseWindow's 'focus' event (see
  // onHybridHostFocus below). Mirrors the deleted canvas path's
  // blank-placeholder + navigate-on-focus restore, which measured a
  // ~10-20x sustained-GPU win on large sessions.

  registerHybridWindow(baseWin.id, {
    baseWin,
    contentWC: view.webContents,
    key: options.key,
    url,
    deferredLoad: deferContentLoad
      ? { url, title: typeof options.title === 'string' ? options.title : '' }
      : undefined,
  });

  // Reopen-last-closed (main.ts reopenLastClosedWindow) and session
  // restore (session.ts restoreSessionSnapshot) both thread a
  // maximized window's saved state through as open-time options:
  // `maximized: true` plus `preMaxX/Y/Width/Height` (the pre-maximize
  // rect to unmaximize back to). Mirrors the canvas path's contract —
  // the FSM used to boot straight into MAXIMIZED via a `maximized=1`
  // URL param without calling doMaximize(), because the window's
  // bounds are ALREADY the maximized rect (computeInitialBounds above
  // used `winOptions.x/y/width/height`, which reopen/restore set from
  // the saved presentation.bounds — the live maximized size). So there
  // is nothing to resize here: just record the state so a later
  // page:unmaximize (and getHybridPresentation / session save) see it.
  if (options.maximized === true) {
    const pmx = options.preMaxX, pmy = options.preMaxY;
    const pmw = options.preMaxWidth, pmh = options.preMaxHeight;
    const preMax = (typeof pmx === 'number' && typeof pmy === 'number'
      && typeof pmw === 'number' && typeof pmh === 'number')
      ? { x: pmx, y: pmy, width: pmw, height: pmh }
      : null;
    setHybridMaximizeState(baseWin.id, true, preMax);
  }

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
    // Deferred session restore: the first genuine activation of a
    // restoreBlank window releases its deferred content load.
    // `claimHybridDeferredLoad` is the once-guard (returns the URL
    // exactly once, null forever after and for non-deferred windows),
    // so repeat focus events can never double-load. Driven by the
    // deterministic BaseWindow 'focus' event only — no timers, no
    // polling. The pending-nav record mirrors the navbar-navigate
    // path so did-start-loading can resolve the target URL for the
    // loading-timeout overlay.
    try {
      const deferredUrl = claimHybridDeferredLoad(baseWin.id);
      if (deferredUrl && !view.webContents.isDestroyed()) {
        setHybridPendingNavUrl(baseWin.id, deferredUrl);
        view.webContents.loadURL(deferredUrl).catch((err) => {
          DEBUG && console.log(`[hybrid-page-host:${baseWin.id}] deferred loadURL failed:`, err);
        });
      }
    } catch {
      /* a torn-down wc mid-focus must not wedge the focus handler */
    }
    // First-responder restore on host focus (the old
    // `shouldFocusHybridContentOnHostFocus` invariant) is now the machine's
    // standard `FOCUS_CONTENT` effect on any transition that makes a page-host
    // front — the OS adapter's `focus` listener (attached at
    // `registerWindowWithMachine` below) drives it. And focused-window tracking
    // moved to the machine's `front`/`focusSeq`, so there is no `track*` feed
    // here either.
    //
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
  // Native fullscreen state (SETTLED enter/leave) is now owned by the window-
  // state machine: the OS adapter attaches `enter-full-screen`/`leave-full-screen`
  // (→ OS_FULLSCREEN_ENTERED/LEFT) at `registerWindowWithMachine` below. No
  // registry `setHybridNativeFullScreen` wiring here anymore.
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
  console.log(`[hybrid-page-host] compat hooks attached to content wc ${view.webContents.id} (rtPreload=${rtPreloadApplied ? 'yes' : 'no'})`);

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
  // restoreBlank is a per-restore open-time directive (re-derived from
  // the eager/deferred split on every restore), not persistent window
  // state — the `...options` spread above would otherwise bake it into
  // the registry params and from there into the NEXT session snapshot,
  // making the window restore deferred forever regardless of its eager
  // slot. (Belt-and-suspenders with the restore-side stripKeys entry in
  // session.ts, which drops it from old snapshots.)
  delete windowParams.restoreBlank;
  // Register the page-host with the window-state machine (both window kinds
  // register — judgment call 2). The OS adapter attaches focus/blur/show/hide/
  // closed/enter-leave-fullscreen listeners + drives front/fullscreen/Esc.
  // Satellite = the overlay/palette focus-group surfaces; peeks/slides
  // (quick-view) stay front-eligible.
  //
  // The registry payload (`source` + `params`, the old main.ts
  // `registerWindow` write) rides the SAME registration now — the machine's
  // window record is the one registry (§4.1 dim 1a / §5 step 4); `parentId`
  // carries the parent linkage that drives the reducer's parent-refocus
  // transition on WINDOW_CLOSED.
  const hostMachineId = registerWindowWithMachine({
    kind: 'page-host',
    role,
    class: classifyWindowRegistration(role, { alwaysOnTop: options.alwaysOnTop === true }),
    satellite: role === 'overlay' || role === 'palette',
    escapeMode: options.escapeMode as MachineWindowSpec['escapeMode'],
    lastHttpUrl: url.startsWith('http://') || url.startsWith('https://') ? url : undefined,
    win: baseWin,
    contentWC: view.webContents,
    source,
    params: windowParams,
    parentId: isRealParent ? getWindowIdFor(openerWindow!.id) : null,
    // keepLive rides the registration so the reducer record carries the flag
    // FIRST-CLASS — the machine's WINDOW_CLOSE_OR_HIDE_REQUESTED clause (not
    // the closeOrHideWindow caller) is what branches hide-vs-close on it.
    keepLive: options.keepLive === true,
  });
  // Track the content-WC→host relationship for the permission lookup
  // (findHostWindowId). The guest registry carries WM WindowIds, so this
  // registration uses the machine-minted id from just above.
  registerGuest(view.webContents, hostMachineId);
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
  // Capture bounds/presentation from whichever live state is still
  // available. Called from all three terminal signals below — safe to
  // call more than once (it just overwrites hybridLastBounds/
  // hybridLastPresentation), unlike runHybridFinalize which is
  // idempotent-guarded.
  const captureHybridClose = () => {
    try {
      if (!baseWin.isDestroyed()) {
        hybridLastBounds = baseWin.getBounds();
        hybridLastPresentation = getWindowPresentation(baseWin.id);
      }
    } catch {
      // Ignore errors during shutdown
    }
  };

  let hybridFinalized = false;
  const runHybridFinalize = () => {
    if (hybridFinalized) return;
    hybridFinalized = true;
    // Black-window fix, quit path (best-effort). The interactive close/hide paths
    // (windows.ts closeOrHideWindow, tile:window:hide) AWAIT setHybridHostFullScreen(id,
    // false) before the terminal op, so by the time they reach here the host has
    // already left fullscreen. App-quit can't block on the ~600ms AppKit exit
    // animation, so here we only DROP fullscreen synchronously if the host is still
    // in it — enough to keep macOS from stranding a black Space — and never await.
    try {
      const mode = getWindowModeName(hostMachineId);
      if (mode != null && mode !== 'normal' && !baseWin.isDestroyed()) {
        // Drop fullscreen synchronously through the machine's single
        // setFullScreen owner (the adapter's SET_FULLSCREEN effect runs
        // synchronously; we don't await the ~600ms settle — quit can't block).
        dispatchWindowEvent({ type: 'FULLSCREEN_REQUESTED', id: hostMachineId, desired: false });
      }
    } catch { /* host gone mid-quit — nothing to exit */ }
    finalizeWindowClose(baseWin.id, {
      bounds: hybridLastBounds,
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
    // On app-quit teardown the WebContentsView's own content wc can already
    // be gone natively — its `.webContents` getter then returns `undefined`
    // (NOT a live-but-destroyed wc). Reading `.isDestroyed()` straight off
    // that undefined threw a TypeError mid-finalize; the catch below only
    // logged it, so `runHybridFinalize` bailed out of its teardown tail with
    // native state half-torn → SIGSEGV on quit (peek 9a591551). Resolve the
    // wc ONCE and gate on both its existence AND its destroyed signal (the
    // existing lifecycle signal — fsm-pilled: gate, don't rely on the
    // swallow), so an already-torn-down content wc is a clean no-op.
    try {
      // The content-surface teardown is a machine effect now
      // (WINDOW_CONTENT_CLOSE_REQUESTED → CLOSE_CONTENT →
      // backend.closeContent, which applies the same
      // `shouldCloseContentWCOnFinalize` guard — peek 9a591551 — and issues
      // the documented `webContents.close()`: no beforeunload wait; the host
      // is already gone). The backend retains the content WC per WindowId,
      // so this works after the machine record was retired above.
      dispatchWindowEvent({ type: 'WINDOW_CONTENT_CLOSE_REQUESTED', id: hostMachineId });
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
    captureHybridClose();
    runHybridFinalize();
  });
  baseWin.once('closed', () => {
    captureHybridClose();
    runHybridFinalize();
  });
  // IMPORTANT: prepend, not append. The page-host close-UAF guard
  // (windows.ts closeHostWindow → destroyGuestsThenClose) destroys this
  // content webContents (registered as baseWin's "guest") BEFORE calling
  // baseWin.close() — so on the NORMAL close path this 'destroyed' event
  // fires FIRST, before baseWin's own 'close' event ever does. The hybrid
  // registry's own self-clean (registerHybridWindow's `contentWC.once
  // ('destroyed', cleanup)`) is ALSO bound to this same event, registered
  // earlier (at registerHybridWindow(...) above) — cleanup deletes the
  // registry entry, which getWindowPresentation depends on. Left as a
  // plain `.once`, our capture would run AFTER cleanup and always see a
  // vanished entry (bounds/maximized permanently lost on every close —
  // confirmed by instrumentation: captured came back {bounds:null,
  // presentation:null} on every reopen). `prependOnceListener` runs our
  // capture BEFORE cleanup regardless of registration order, so the
  // registry entry (and baseWin, not yet destroyed at this point) are
  // still readable. (entry.url()/title() will read empty — the content
  // wc IS gone by 'destroyed' — but finalizeWindowClose never reads
  // presentation.address, only bounds/maximized/preMaxBounds, so that's
  // harmless here.)
  view.webContents.prependOnceListener('destroyed', () => {
    captureHybridClose();
    runHybridFinalize();
    // Opener-initiated close: when the opener page calls the popup's
    // window.opener-proxy .close() (or the popup calls window.close()),
    // Chromium destroys the content WebContents directly, leaving this
    // host BaseWindow alive but empty. Close it so the host doesn't
    // linger. Deterministic on the WC 'destroyed' signal — no timer. On
    // the normal close path the guard makes this a no-op (the host is
    // already closing / destroyGuestsThenClose's own baseWin.close() ran
    // or is about to); runHybridFinalize already consumed the captured
    // bounds, so any re-entrant 'close' is harmless. Routed through the
    // machine (WINDOW_CLOSE_REQUESTED → backend guest-safe close; the guest
    // is already gone here, so it takes the synchronous fast path).
    try {
      if (!baseWin.isDestroyed()) dispatchWindowEvent({ type: 'WINDOW_CLOSE_REQUESTED', id: hostMachineId });
    } catch { /* closing a torn-down host is a no-op */ }
  });

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
  //
  // EXCEPTION — quick-view surfaces (peeks/slides, `role:'quick-view'`): show
  // WITHOUT activating the app but still make the content the first responder.
  // The host is a `type:'panel'` NSPanel (threaded into the ctor above), so it
  // takes key input while the frontmost app keeps OS focus — the non-activating
  // overlay the user expects (regression 524f7aba). Popups (createWindow path)
  // pass `options:{}` → no role → they activate like a normal web window.
  showHybridHost(baseWin, view.webContents, {
    inactive: options.show === false,
    nonActivating: options.role === 'quick-view',
  });
}

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

  // Editable-focus tracking (peek 51798bae): register the `page:editable-focus`
  // receiver once (idempotent), and drop this content WC's cached focus state on
  // teardown so a recycled webContents id never inherits a stale editable flag.
  initHybridEditableFocusTracking();
  contentWC.once('destroyed', () => clearEditableFocusForWc(contentWC.id));

  // Content-area double/triple-click window gesture (peek d8ce0ddf): register the
  // `page:content-window-gesture` receiver once (idempotent). detent 2 → toggle
  // maximize (via the overlay), detent 3 → toggle fullscreen. See hybrid-window-gesture.ts.
  initHybridWindowGestureHandling();

  // ── Loading-timeout safety net (Stage B) ────────────────────────────────
  // Armed on `did-start-loading`, cleared on `did-finish-load` / `did-stop-loading`.
  // Fires for hung loads (server accepts connection but never responds — the
  // "blank-white-page-forever / endless glow border" class of bug, e.g.
  // metikmusic.com) that never produce a `did-fail-load` event. Mirrors the
  // canvas path's DEFAULT_LOADING_TIMEOUT_MS = 30 000 and the same
  // `window.__loadingTimeoutMs` override mechanism for tests.
  //
  // This is the ONE legitimate timer: it sits at the Chromium-boundary where no
  // deterministic event exists to signal a truly hung load. Guarded with
  // `contentWC.isDestroyed()` in its body. fsm-pilled rule: do NOT stack any
  // other timer on this path.
  let loadingTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

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
    if (contentWC.isDestroyed()) return;
    // Stage B: new navigation clears any prior error (matches canvas
    // clearLoadErrorOverlay() call inside loadingLifecycle.startLoading()).
    setHybridLoadError(hostWindowId, null);
    // Stage B: arm the loading-timeout safety net. Duration is read live so
    // the test bridge can lower it without restarting the process.
    if (loadingTimeoutHandle) clearTimeout(loadingTimeoutHandle);
    const timeoutMs = getHybridLoadingTimeoutMs();
    // Capture the navigation target URL. The page:navigate subscriber records
    // it in the registry BEFORE calling loadURL so it's always available here.
    // contentWC.getURL() at did-start-loading time returns the last COMMITTED
    // URL (not the pending target), so a hung load would report the wrong URL
    // if we relied on getURL() alone. takeHybridPendingNavUrl consumes and
    // clears the entry so stale values can't bleed into the next navigation.
    const capturedUrl = takeHybridPendingNavUrl(hostWindowId) || contentWC.getURL() || initialUrl;
    loadingTimeoutHandle = setTimeout(() => {
      // Genuine Chromium-boundary timer — the only case where a timer is
      // correct (hung HTTP connection, no `did-fail-load` ever fires). Guard
      // isDestroyed() because the WC may be torn down while we wait.
      if (contentWC.isDestroyed()) return;
      loadingTimeoutHandle = null;
      setHybridLoadError(hostWindowId, {
        failedUrl: capturedUrl,
        errorCode: 'TIMEOUT',
        errorDescription: 'The page took too long to load.',
      });
      noteHybridLoadFailure(hostWindowId, capturedUrl);
      try { contentWC.stop(); } catch { /* already stopped */ }
    }, timeoutMs);
    // Include the last-known favicon so a window that starts loading while
    // ALREADY active (no re-handoff) still paints its icon on the loading card.
    // '' when unknown → spinner-only. Rides the existing page:loading path — no
    // extra timer or IPC.
    let favicon = '';
    try { if (isHttp(capturedUrl)) favicon = getFaviconForUrl(capturedUrl); } catch { /* ds unavailable */ }
    publish(getSystemAddress(), 'page:loading', {
      windowId: hostWindowId,
      loading: true,
      favicon,
      // Card shows only for a never-painted window (fresh/restore/deferred).
      firstLoad: !hasHybridPainted(hostWindowId),
    });
  });
  contentWC.on('did-stop-loading', () => {
    if (contentWC.isDestroyed()) return;
    // Stage B: stop fired — load settled (success, error page, or abort).
    // Cancel the loading-timeout safety net so it can't fire after the WC
    // has already stopped (prevents a stale error overlay on a clean load).
    if (loadingTimeoutHandle) { clearTimeout(loadingTimeoutHandle); loadingTimeoutHandle = null; }
    // The view has now painted a frame (page, error page, or abort) — so any
    // FUTURE load is an in-page navigation that must NOT get the opaque loading
    // card. Marks this window painted for the firstLoad gate.
    markHybridPainted(hostWindowId);
    publish(getSystemAddress(), 'page:loading', { windowId: hostWindowId, loading: false });

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

  // ── did-fail-load → branded error overlay (Stage B) ─────────────────────
  // Record the failure in per-host state so the overlay can show the branded
  // error card. Mirrors the canvas `did-fail-load` handler in page.js (~2555):
  //   - Skip non-main-frame failures (subframe errors don't affect the page).
  //   - Skip ERR_ABORTED (-3): a redirect-chain abort or user-nav-away that
  //     produces a spurious did-fail-load; canvas suppresses it too.
  //   - For real failures: cancel the loading-timeout (it won the race), record
  //     the error, and stop the WC to prevent further blank-page loading.
  //
  // The branded overlay COVERS Chromium's native error page (chrome-error://):
  // the content WC still commits the "This site can't be reached" page beneath
  // the overlay window, but our card is visible on top — matching canvas.
  contentWC.on(
    'did-fail-load',
    (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame) return;
      if (errorCode === -3) return; // ERR_ABORTED — redirect/user-nav-away, canvas suppresses
      if (contentWC.isDestroyed()) return;
      if (loadingTimeoutHandle) { clearTimeout(loadingTimeoutHandle); loadingTimeoutHandle = null; }
      const failedUrl = validatedURL || contentWC.getURL() || initialUrl;
      setHybridLoadError(hostWindowId, {
        failedUrl,
        errorCode: String(errorCode),
        errorDescription: errorDescription || 'Load failed',
      });
      noteHybridLoadFailure(hostWindowId, failedUrl);
      try { contentWC.stop(); } catch { /* already stopped */ }
    },
  );

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
      // Editable-target guard (peek 51798bae): while a text field / textarea /
      // contenteditable inside the page is focused, ESC belongs to the editing
      // context (blur/dismiss the field), NOT the global switcher. The universal
      // content preload reports focus transitions via page:editable-focus. When
      // editable is focused, let ESC fall through to the page UNSTOLEN — do NOT
      // preventDefault and do NOT route to policy — so the page blurs the field
      // natively. A second ESC (nothing focused now) reaches the switcher route.
      // Deterministic: a cached focus boolean read synchronously, no timer.
      if (isEditableFocusedForWc(contentWC.id)) {
        DEBUG && console.log(`[esc] hybrid ESC deferred to page — editable focused in content wc ${contentWC.id}`);
        return;
      }
      const now = Date.now();
      if (now - lastHybridEscTime < 200) return;
      lastHybridEscTime = now;
      // Block ESC from reaching the page DOM (matches the canvas path's
      // preventDefault) so the machine's decision — not a page handler — owns it.
      // Only the DECISION moved: this before-input attach + editable guard +
      // debounce stay here (input hygiene); the landed id is first-responder
      // noise — `decideEscape` targets `front`.
      event.preventDefault();
      // Resolve the host's WM WindowId at keypress time (registration happened
      // at window creation); an unregistered host degrades to 'global' — the
      // landed id is first-responder noise either way.
      dispatchWindowEvent({ type: 'ESC_PRESSED', landedId: getWindowIdFor(hostWindowId) ?? 'global' });
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
  //
  // Asymmetric hysteresis — enter vs. exit use different thresholds:
  //   ENTER (reveal): cursor must be within the 8px top-border strip (dy <= TRIGGER_ZONE_PX).
  //     The old single-band check used TRIGGER_ZONE_PX + NAVBAR_HEIGHT_PX = 44px, which popped
  //     the chrome when the cursor merely drifted near the top of a maximized page over real content.
  //   EXIT (reveal-out): stays revealed until the cursor leaves the full 44px band (past the
  //     revealed navbar). This prevents a hide-flicker while the cursor hovers the visible navbar.
  const REVEAL_ENTER_PX = TRIGGER_ZONE_PX;                    // 8 — must hit the border strip
  const REVEAL_EXIT_PX  = TRIGGER_ZONE_PX + NAVBAR_HEIGHT_PX; // 44 — hysteresis over revealed navbar
  // ── Round-2 main-driven edge/corner RESIZE (cursor + drag) ──────────────────
  // The shared overlay can CAPTURE a press but never PAINTS a cursor — it is never
  // the macOS first responder, and cursor rendering belongs to the topmost
  // first-responder window under the pointer. So BOTH the resize cursor and the
  // drag live HERE, on the content/main side: the content WebContents IS first
  // responder (it renders cursors) and main owns the BaseWindow geometry.
  //   - CURSOR: on each idle move compute the band direction (hybridResizeDirAt)
  //     and, when it CHANGES, inject / swap / remove a whole-document
  //     `cursor:<dir>-resize !important` rule into the content WC (insertCSS /
  //     removeInsertedCSS). The overlay is click-through at the edge so the content
  //     is topmost and that injected cursor shows. No persistent script (SPA
  //     re-render / CSP can't strip it) and no preload dependency.
  //   - DRAG: on a press inside the band START a resize FSM and drive
  //     `baseWin.setBounds(.., false)` from the observed move stream until release.
  //     State-change-driven, no timers.
  // The `input-event` stream is OBSERVE-ONLY (cannot preventDefault), so the page
  // ALSO receives the band mousedown. Accepted tradeoff: the outer ~12px is almost
  // always page margin/scrollbar, so the duplicate down is usually harmless; we do
  // NOT globally disable page input to suppress it.
  const MIN_RESIZE_W = 200;
  const MIN_RESIZE_H = 150;
  const RESIZE_ENTER_SLACK = 0;  // engage exactly at the band
  const RESIZE_EXIT_SLACK = 6;   // sticky once in-band (spatial hysteresis)
  // Slop for "does the host still fill the work area" (native-resize reconciler
  // below). Tolerance, never exact equality: on fractional-scale displays the
  // work area and the window's own bounds round independently, so an `===`
  // compare reports a mismatch for a window that is visually flush.
  const WORK_AREA_MATCH_PX = 2;
  let inRevealBand = false;

  // Content-cursor reconciler. `wantCursor` is the intended FULL css cursor value
  // (e.g. 'nw-resize' for edge/corner hover, 'grab'/'grabbing' for the hold-drag
  // gesture); `appliedCursor`/`appliedKey` track the CSS actually inserted. A
  // single in-flight applier (`applyingCursor`) serializes the async insert/remove
  // and re-checks after, so rapid changes can't leave a stale cursor (race-free,
  // no key churn).
  //
  // TWO producers feed this SAME state: the idle-move RESIZE hover cursor
  // (setHoverDir) and the hold-to-drag GRAB cursor over content (setContentCursor,
  // driven by the global page:drag-cursor subscription). They are TEMPORALLY
  // EXCLUSIVE — a resize press `return`s before any content-pointer 'down', and no
  // idle resize-move runs during a button-down hold — so routing both through one
  // reconciler guarantees the WC can never end up with two cursors painted.
  let wantCursor: string | null = null;
  let appliedCursor: string | null = null;
  let appliedKey: string | null = null;
  let applyingCursor = false;
  const reconcileCursor = (): void => {
    if (applyingCursor) return;
    if (wantCursor === appliedCursor) return;
    applyingCursor = true;
    void (async () => {
      try {
        if (appliedKey != null && !contentWC.isDestroyed()) {
          try { await contentWC.removeInsertedCSS(appliedKey); } catch { /* gone */ }
        }
        appliedKey = null; appliedCursor = null;
        const want = wantCursor;
        if (want != null && !contentWC.isDestroyed()) {
          try {
            appliedKey = await contentWC.insertCSS(`*{cursor:${want} !important}`);
            appliedCursor = want;
          } catch { /* gone */ }
        }
      } finally {
        applyingCursor = false;
        if (wantCursor !== appliedCursor) reconcileCursor();
      }
    })();
  };
  const setCursor = (cursor: string | null): void => {
    if (cursor === wantCursor) return;
    wantCursor = cursor;
    reconcileCursor();
  };
  // Resize hover cursor: maps a resize dir → `${dir}-resize` (null → no cursor).
  const setHoverDir = (dir: ResizeDir | null): void => {
    setCursor(dir != null ? `${dir}-resize` : null);
  };
  // Hold-to-drag grab/grabbing cursor over web content (driven by the global
  // page:drag-cursor handler). Feeds the SAME reconciler as resize.
  const setContentCursor = (cursor: string | null): void => {
    setCursor(cursor);
  };
  // Register this host's content-cursor setter so the global page:drag-cursor
  // subscription can resolve it by windowId. Cleaned on content-WC teardown so a
  // closed host leaves no stale setter (the reconciler already guards
  // isDestroyed(), so a late call is harmless even before this fires).
  hybridContentCursorSetters.set(hostWindowId, setContentCursor);
  contentWC.once('destroyed', () => { hybridContentCursorSetters.delete(hostWindowId); });

  // ── Pointer-gesture state for this host's content WC ─────────────────────
  // ONE value, three named states — a left press over content is EITHER a resize
  // OR a hold-to-drag OR nothing, never two at once.
  //
  // This used to be two independent variables (`activeResize` object +
  // `leftButtonDown` boolean), which made illegal combinations representable —
  // and one of them shipped. `activeResize` was only ever cleared on `mouseUp`,
  // but a resize that CLAMPS at MIN_RESIZE_W/MIN_RESIZE_H stops following the
  // cursor, so the terminating release lands OUTSIDE the host and the content WC
  // never sees that `mouseUp`. The resize stayed armed forever. The next plain
  // press in the page interior correctly hit-tested to no direction and set
  // `leftButtonDown`, but the first move matched the still-armed resize branch
  // (tested first) and applied the PREVIOUS gesture's anchor — the window jumped
  // at the start of an unrelated drag. With one state value that's unrepresentable:
  // a press ends whatever came before (endGesture) before it decides what it is.
  //   `resizing` carries the anchor: dir + press point + bounds AT PRESS, so each
  // move recomputes from a fixed origin.
  type PointerGesture =
    | { kind: 'idle' }
    | {
        kind: 'resizing';
        dir: ResizeDir; sx: number; sy: number;
        sb: { x: number; y: number; width: number; height: number };
      }
    | { kind: 'dragging' };
  let gesture: PointerGesture = { kind: 'idle' };

  // The ONE transition back to idle, from any state, with the exit action that
  // state owes the overlay. Leaving `resizing` ALWAYS clears the overlay's
  // resize-active latch — otherwise an abandoned resize pins the overlay
  // click-through for the rest of the host's life.
  const endGesture = (): void => {
    if (gesture.kind === 'resizing') {
      try {
        publish(getSystemAddress(), 'page-overlay:resize-active', { windowId: hostWindowId, active: false });
      } catch { /* gone */ }
    }
    gesture = { kind: 'idle' };
  };

  const hostBounds = (): { x: number; y: number; width: number; height: number } | null => {
    try {
      const hw = getHybridWindow(hostWindowId);
      if (hw && !hw.baseWin.isDestroyed()) return hw.baseWin.getBounds();
    } catch { /* gone */ }
    return null;
  };
  // A resize gesture ENDS maximize: the host is about to stop filling the work
  // area, so the registry flag and its stashed preMaxBounds must go now, at the
  // press. Leaving them set IS the stale-preMaxBounds de-sync — a later maximize
  // toggle would "restore" to a rect the user has since resized away from.
  // Clearing at press rather than release means an abandoned drag still leaves
  // coherent state. Mirrors the cleared state into the overlay, which keeps a
  // local copy for its chrome reflow + navbar-drag math and would otherwise still
  // believe the host is maximized.
  const exitMaximizeForResize = (): void => {
    const hw = getHybridWindow(hostWindowId);
    if (!hw || !hw.maximized) return;
    setHybridMaximizeState(hostWindowId, false, null);
    try {
      publish(getSystemAddress(), 'page-overlay:maximize-state', {
        windowId: hostWindowId, maximized: false, preMaxBounds: null,
      });
    } catch { /* gone */ }
  };

  // ── Native OS resize reconciler (peek 1a47dc23) ────────────────────────────
  // The host is `frame:false` but still `resizable`, so macOS performs a
  // border/corner resize NATIVELY. That gesture never reaches this WC's
  // `input-event` stream, so the press-time `exitMaximizeForResize()` above never
  // runs: the registry keeps `maximized:true` plus a `preMaxBounds` rect the
  // window has since been resized away from (for a never-manually-resized host,
  // the 1024x768 APP_DEF_* creation default). The next navbar double-click reads
  // that stale flag, publishes `page:unmaximize`, and the window JUMPS to the
  // default rect instead of filling the work area. `baseWin.on('resize')` was the
  // only native hook and it only refilled the content view — nothing invalidated
  // the maximize bookkeeping.
  //   This CLEARS state on a resize we observe; it is emphatically NOT the
  // deleted `hostMaximized(b)` geometry check returning. That was an AUTHORITY
  // (geometry deciding whether the host counts as maximized) and a GUARD (it
  // REFUSED a resize at the work area). This refuses nothing — a maximized host
  // stays resizable — and decides nothing: `entry.maximized`, written only by
  // `setHybridMaximizeState`, remains the single source of truth. Geometry here
  // is only evidence that a flag set by intent has since been invalidated by the
  // OS, and the reconciler retires it.
  //   The app's own paths cannot trip it: `page:maximize` sets the flag true
  // BEFORE its `setBounds(workArea)`, so the resulting resize sees bounds ==
  // workArea → no clear; `page:unmaximize` clears the flag before its
  // `setBounds(prev)` → early-return; and the band drag (`applyResize`) already
  // ran `exitMaximizeForResize()` at press → early-return.
  const fillsWorkArea = (b: { x: number; y: number; width: number; height: number }): boolean => {
    const wa = screen.getDisplayNearestPoint({
      x: b.x + Math.floor(b.width / 2),
      y: b.y + Math.floor(b.height / 2),
    }).workArea;
    return Math.abs(b.x - wa.x) <= WORK_AREA_MATCH_PX
      && Math.abs(b.y - wa.y) <= WORK_AREA_MATCH_PX
      && Math.abs(b.width - wa.width) <= WORK_AREA_MATCH_PX
      && Math.abs(b.height - wa.height) <= WORK_AREA_MATCH_PX;
  };
  const reconcileMaximizeAfterResize = (): void => {
    try {
      const hw = getHybridWindow(hostWindowId);
      if (!hw || !hw.maximized) return;
      const b = hostBounds();
      if (!b || fillsWorkArea(b)) return;
      exitMaximizeForResize();
    } catch { /* gone */ }
  };
  try {
    // The host is already registered by the time this runs — both the ipc.ts
    // host-assembly call site and makeWiredHybridHost register before wiring.
    getHybridWindow(hostWindowId)?.baseWin.on('resize', reconcileMaximizeAfterResize);
  } catch { /* gone */ }

  // Resize direction at a screen point, honoring the top reveal strip: reveal
  // keeps priority over the plain top 'n' band so the navbar gesture wins there
  // (corners are unaffected). `engaged` selects exit vs enter slack.
  //
  // Maximize does NOT gate this. A maximized host is resizable, and grabbing an
  // edge exits maximize in the same gesture (see the mouseDown resize-start
  // below) — OS parity, and the user no longer has to drag the window out of
  // maximize before they can shrink it. This used to short-circuit on a
  // `hostMaximized(b)` geometry check (bounds === workArea, exact equality),
  // which was a SECOND definition of "maximized" competing with the registry's
  // `entry.maximized` flag: the two silently disagreed whenever the work area
  // moved under a maximized window (display swap, dock/menubar toggle, scale
  // change), and it also stole resize from any window a user had merely sized to
  // exactly fill the work area. The registry flag is the single source of truth
  // (see setHybridMaximizeState); geometry no longer votes.
  const resizeDirAt = (
    b: { x: number; y: number; width: number; height: number }, gx: number, gy: number, engaged: boolean,
  ): ResizeDir | null => {
    const dir = hybridResizeDirAt(
      gx, gy, b, RESIZE_EDGE_PX, RESIZE_CORNER_PX, engaged ? RESIZE_EXIT_SLACK : RESIZE_ENTER_SLACK,
    );
    if (dir === 'n' && gy - b.y <= REVEAL_ENTER_PX) return null;
    return dir;
  };
  const applyResize = (gx: number, gy: number): void => {
    const g = gesture;
    if (g.kind !== 'resizing') return;
    const hw = getHybridWindow(hostWindowId);
    if (!hw || hw.baseWin.isDestroyed()) { endGesture(); return; }
    const { dir, sx, sy, sb } = g;
    const dx = gx - sx;
    const dy = gy - sy;
    let { x, y, width, height } = sb;
    if (dir.includes('e')) width = Math.max(MIN_RESIZE_W, sb.width + dx);
    if (dir.includes('s')) height = Math.max(MIN_RESIZE_H, sb.height + dy);
    if (dir.includes('w')) { const nw = Math.max(MIN_RESIZE_W, sb.width - dx); x = sb.x + (sb.width - nw); width = nw; }
    if (dir.includes('n')) { const nh = Math.max(MIN_RESIZE_H, sb.height - dy); y = sb.y + (sb.height - nh); height = nh; }
    try {
      hw.baseWin.setBounds(
        { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }, false,
      );
    } catch { /* gone */ }
    // Keep the overlay renderer's locally-tracked bounds in sync — it owns the
    // navbar-drag MOVE math + maximize stash, and main (not the renderer) drives
    // resize now, so without this its activeBounds would go stale.
    try {
      publish(getSystemAddress(), 'page-overlay:bounds', { windowId: hostWindowId, bounds: hw.baseWin.getBounds() });
    } catch { /* gone */ }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contentWC.on('input-event', (_event: unknown, input: any) => {
    const t = input && input.type;
    if (t === 'mouseDown' && input.button === 'left') {
      // A left press is unambiguously the START of a gesture, so nothing we
      // believe is live can still be live — end it here rather than trusting a
      // `mouseUp` the OS is free to deliver somewhere else (see the
      // PointerGesture note: a clamped resize's release lands off-host).
      endGesture();
      const b = hostBounds();
      const dir = b ? resizeDirAt(b, input.globalX, input.globalY, false) : null;
      if (b && dir) {
        // Press inside the band → START a main-driven resize. Tell the overlay to
        // stay click-through for the whole drag (so the content WC keeps receiving
        // the move stream that drives the resize AND stays topmost so the cursor
        // keeps showing). Do NOT forward this press as a hold-to-drag 'down'.
        // `sb` is the bounds AT PRESS — for a maximized host that's the work-area
        // rect, so the drag shrinks from what the user sees, in one gesture.
        exitMaximizeForResize();
        gesture = { kind: 'resizing', dir, sx: input.globalX, sy: input.globalY, sb: b };
        setHoverDir(dir);
        publish(getSystemAddress(), 'page-overlay:resize-active', { windowId: hostWindowId, active: true });
        return;
      }
      gesture = { kind: 'dragging' };
      publish(getSystemAddress(), 'page-overlay:content-pointer', {
        windowId: hostWindowId, phase: 'down', screenX: input.globalX, screenY: input.globalY,
      });
    } else if (t === 'mouseMove' && gesture.kind === 'resizing') {
      applyResize(input.globalX, input.globalY);
    } else if (t === 'mouseMove' && gesture.kind === 'dragging') {
      publish(getSystemAddress(), 'page-overlay:content-pointer', {
        windowId: hostWindowId, phase: 'move', screenX: input.globalX, screenY: input.globalY,
      });
    } else if (t === 'mouseMove') {
      // Idle (no-button) move → top-border reveal AND edge/corner resize cursor.
      // Both read the host's screen-space bounds; reveal emits only on band-cross,
      // the cursor swaps only on direction-change. Guarded: a torn-down host or
      // missing geometry simply skips (never throws inside the input stream).
      const bounds = hostBounds();
      if (bounds != null) {
        // Top-border reveal (peek 363e7cff) — offset below the host top edge.
        const dy = input.globalY - bounds.y;
        if (!inRevealBand) {
          if (dy >= 0 && dy <= REVEAL_ENTER_PX) {
            inRevealBand = true;
            publish(getSystemAddress(), 'page-overlay:content-pointer', {
              windowId: hostWindowId, phase: 'reveal', screenX: input.globalX, screenY: input.globalY,
            });
          }
        } else {
          if (dy < 0 || dy > REVEAL_EXIT_PX) {
            inRevealBand = false;
            publish(getSystemAddress(), 'page-overlay:content-pointer', {
              windowId: hostWindowId, phase: 'reveal-out', screenX: input.globalX, screenY: input.globalY,
            });
          }
        }
        // Edge/corner resize cursor — engage exactly at the band, hold with exit
        // slack once shown (spatial hysteresis on the cursor itself). Gate on the
        // content WC being the macOS FIRST RESPONDER: only the first-responder
        // window reliably PAINTS the injected cursor, so injecting into a
        // background/transitional host churns insertCSS/removeInsertedCSS and
        // flashes the whole page (the original dodgy-cursor symptom — observed in a
        // focused=false trace). Deterministic gate on existing focus state (no
        // timer): when unfocused, clear the hover dir so the host shows no resize
        // cursor until it's focused, rather than flickering. The drag path is
        // unaffected — a press focuses the host and sets its cursor directly.
        let contentFocused = false;
        try { contentFocused = contentWC.isFocused(); } catch { contentFocused = false; }
        setHoverDir(contentFocused ? resizeDirAt(bounds, input.globalX, input.globalY, wantCursor !== null) : null);
      }
    } else if (t === 'mouseUp' && input.button === 'left') {
      const g = gesture;
      if (g.kind === 'resizing') {
        endGesture();
        // Recompute the hover cursor at the release point (persist if still in band).
        const b = hostBounds();
        setHoverDir(b ? resizeDirAt(b, input.globalX, input.globalY, false) : null);
        return;
      }
      if (g.kind !== 'dragging') return;
      endGesture();
      publish(getSystemAddress(), 'page-overlay:content-pointer', {
        windowId: hostWindowId, phase: 'up', screenX: input.globalX, screenY: input.globalY,
      });
    }
  });

  // Focus leaving the content WC ends a live RESIZE. The resize is main-driven off
  // this WC's move stream, so once focus is elsewhere no `mouseUp` can arrive here
  // to end it — that is exactly the abandoned-resize leak the press-time
  // `endGesture()` catches late. This closes it at the moment it happens, off an
  // existing lifecycle event (no timer, no poll).
  //   `dragging` deliberately does NOT end on blur: that gesture is owned by the
  // overlay's own pointer stream, which moves the window under the cursor and can
  // legitimately take focus mid-drag.
  contentWC.on('blur', () => {
    if (gesture.kind === 'resizing') endGesture();
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
  // http(s) popups take Option A — NATIVE ADOPTION: return
  // {action:'allow', createWindow} and adopt Chromium's opener-wired guest
  // WebContents into a Peek hybrid BaseWindow host (see the createWindow body).
  // This preserves a REAL window.opener / postMessage / close / focus
  // relationship for the popup — the OAuth popup→opener handshake — with no
  // window.opener shim and no postMessage relay. This RETIRED the old
  // deny + `invokeWindowOpen` re-route, which recreated the popup as an
  // opener-less BaseWindow (window.open() returned null, window.opener was
  // null). NOTE: the chrome-extensions popup handler
  // (chrome-extensions.ts ~1090) still uses the deny + `invokeWindowOpen`
  // re-route — that's a separate path, out of scope here. Non-http(s) URLs
  // (about:blank, data:, etc.) are ALLOWED to open normally.
  contentWC.setWindowOpenHandler((details) => {
    const popupUrl = details.url;
    if (popupUrl.startsWith('http://') || popupUrl.startsWith('https://')) {
      console.log(`[hybrid-page-host] Popup (allow+createWindow) from window ${hostWindowId}: ${popupUrl}`);
      // Option A — native adoption. Return allow+createWindow so Chromium wires a
      // REAL opener relationship: it creates the guest WebContents (window.opener/
      // postMessage/close/focus already wired) and hands it to us as
      // options.webContents. We adopt THAT WC into a Peek hybrid BaseWindow host
      // and return it — no window.opener shim, no postMessage relay. (Retired the
      // old deny + invokeWindowOpen re-route, which produced an opener-less popup.)
      return {
        action: 'allow',
        createWindow: (ctorOptions) => {
          try {
            // options.webContents is present for window.open / foreground popups
            // (the OAuth case) and UNDEFINED for background-tab (cmd/ctrl-click,
            // creation deferred) — mint a fresh no-opener host in that case.
            const adoptWC = (ctorOptions as { webContents?: Electron.WebContents }).webContents;
            const rect = resolvePopupContentRect(ctorOptions);
            const baseWin = createHybridHostBaseWindow(rect);
            let view: Electron.WebContentsView;
            let rtApplied = false;
            if (adoptWC) {
              // Adopt Chromium's opener-wired guest WC. preload/webPreferences are
              // construction-fixed on the WC Chromium already created (inherited
              // from the opener) — we cannot re-select them here, which is fine for
              // the OAuth popup case (contextIsolation stays as the opener's).
              view = new WebContentsView({ webContents: adoptWC });
            } else {
              const rtPrefs = getRuntimeExternalWebPrefsForUrl(popupUrl, 'hybrid');
              rtApplied = !!rtPrefs;
              view = new WebContentsView({
                webPreferences: {
                  session: getProfileSession(),
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
            }
            const placedBounds = baseWin.getBounds();
            const parentInfo = getWindowInfo(hostWindowId);
            const source = parentInfo ? parentInfo.source : 'system';
            assembleHybridPageHost(baseWin, view, {
              url: popupUrl,
              options: {},
              source,
              placement: { mode: 'proportional', relX: 0.5, relY: 0.5 },
              contentX: placedBounds.x,
              contentY: placedBounds.y,
              contentW: placedBounds.width,
              contentH: placedBounds.height,
              isWebPage: true,
              isTransient: false,
              openerWindow: null,
              isRealParent: false,
              deferContentLoad: false,
              rtPreloadApplied: rtApplied,
            });
            // Navigation ownership splits by case:
            //  - ADOPTED guest WC (window.open / target=_blank / OAuth popup):
            //    Chromium created the guest and already wired its navigation to
            //    details.url, so we must NOT loadURL (that would double-navigate the
            //    opener-wired WC).
            //  - FRESH-MINTED WC (background-tab — cmd/ctrl+click — where Chromium
            //    defers guest creation and hands us NO webContents to adopt):
            //    Chromium does NOT navigate a WC it did not create, so WE own the
            //    load. Without this the popup opened but its content stayed
            //    un-navigated — the blank/black window on cmd+click (peek bebfd212).
            //    Mirrors the fresh-open branch below; a rejected load is swallowed
            //    (the window is already on screen and wireHybridContentEvents'
            //    did-fail-load drives the load-error overlay).
            if (!adoptWC) {
              view.webContents.loadURL(popupUrl).catch((err) => {
                DEBUG && console.log(`[hybrid-page-host:${baseWin.id}] background-tab loadURL failed:`, err);
              });
            }
            publish(getSystemAddress(), 'window:opened', { id: baseWin.id, url: popupUrl, source });
            return view.webContents;
          } catch (e) {
            console.error('[hybrid-page-host] popup createWindow host build failed:', e);
            // Best effort: still hand Chromium the guest WC (if any) so the opener
            // isn't left with a broken/null handle; it just won't be Peek-hosted.
            return (ctorOptions as { webContents?: Electron.WebContents }).webContents as Electron.WebContents;
          }
        },
      };
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
    // Stage B: clear the loading-timeout timer — load settled successfully.
    if (loadingTimeoutHandle) { clearTimeout(loadingTimeoutHandle); loadingTimeoutHandle = null; }
    if (contentWC.isDestroyed()) return;
    const pageUrl = contentWC.getURL();
    if (!isHttp(pageUrl)) return;

    // Genuine load success — reset the same-URL Retry budget so a URL that later
    // fails starts fresh (and a recovered URL isn't stuck at the cap). Gate on
    // there being NO active load-error: a FAILED main-frame load also fires
    // did-finish-load for the committed error page, and getURL() still returns
    // the (http) failed URL, so an unguarded clear would wipe the record
    // did-fail-load just set (which fires first, so the error is already stored).
    if (!getHybridLoadError(hostWindowId)) clearHybridRetry(hostWindowId);

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
 * Idempotent: only installed once.
 */
let hybridNavbarRoutingInstalled = false;
export function installHybridNavbarActionRouting(): void {
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
    // Stage B: record the target URL in the registry BEFORE calling loadURL so
    // did-start-loading (which fires after) can capture it. contentWC.getURL()
    // at did-start-loading time returns the COMMITTED URL, not the pending one.
    setHybridPendingNavUrl(r.windowId, url);
    r.wc.loadURL(url).catch((err) => {
      DEBUG && console.log(`[hybrid-page-host:${r.windowId}] navbar navigate failed:`, err);
      takeHybridPendingNavUrl(r.windowId); // clear on failure too
    });
  });

  subscribe(getSystemAddress(), 'page:reload', (raw) => {
    const r = wcFor(raw);
    if (!r) return;
    // page:reload is multi-purpose — Cmd+R, the error card's Retry button, and
    // the same-URL-window-reuse auto-reload all publish it. Only Retry-of-a-
    // failed-URL is capped: gate on there being an OUTSTANDING load failure for
    // this window (survives the reload's own error-flicker, unlike the load-
    // error state). A normal reload (no outstanding failure) is never throttled.
    if (hasHybridOutstandingFailure(r.windowId)) {
      if (getHybridRetryAttempts(r.windowId) >= HYBRID_SAME_URL_RETRY_CAP) {
        // Cap reached — refuse to hammer the failing URL. Tell the overlay so it
        // can disable Retry instead of silently swallowing the click. The error
        // card stays up (no reload → no did-start-loading to clear it).
        publish(getSystemAddress(), 'page:retry-capped', { windowId: r.windowId });
        return;
      }
      noteHybridRetryAttempt(r.windowId);
    }
    try { r.wc.reload(); } catch { /* wc gone */ }
  });

  // Stage B: close-window action from the error overlay's "Close" button.
  // Mirrors the canvas path's `window.close()` call in the close button
  // handler — routed through the machine (guest-safe close).
  subscribe(getSystemAddress(), 'page:close-window', (raw) => {
    const r = baseWinFor(raw);
    if (!r) return;
    try {
      const wmId = getWindowIdFor(r.windowId);
      if (wmId != null) dispatchWindowEvent({ type: 'WINDOW_CLOSE_REQUESTED', id: wmId });
    } catch { /* already gone */ }
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

  // page:drag-cursor — paint the hold-to-drag grab/grabbing cursor over the
  // host's WEB CONTENT. The overlay is never the macOS first responder, so it can
  // only paint its own `document.body.style.cursor` over the CHROME region, not
  // over the content WebContentsView; main owns the content WC and paints there.
  // Resolved per-window via the SAME windowId keying page:set-bounds uses (here
  // via the host's registered setContentCursor), routed into that host's single
  // cursor reconciler. `state`: 'grab' (hold fired) / 'grabbing' (dragging) /
  // anything else incl. null (released → clear). NOT gated on contentWC.isFocused()
  // (unlike the resize hover cursor): a drag press has already focused the host.
  subscribe(getSystemAddress(), 'page:drag-cursor', (raw) => {
    const msg = raw as { windowId?: number; state?: string } | null;
    if (!msg || typeof msg.windowId !== 'number') return;
    const setContentCursor = hybridContentCursorSetters.get(msg.windowId);
    if (!setContentCursor) return;
    setContentCursor(msg.state === 'grab' || msg.state === 'grabbing' ? msg.state : null);
  });

  // page:maximize — snap the host to its display's work area, after stashing the
  // current bounds for restore. We use explicit work-area bounds rather than
  // baseWin.maximize() because frameless/panel-style windows on macOS don't
  // respond to native maximize() reliably (same rationale as page.js's
  // doMaximize, which sets workArea bounds directly).
  //
  // The pre-maximize bounds + maximized flag are stashed on the hybrid
  // registry entry (setHybridMaximizeState), not a local map — that makes
  // them visible to getHybridPresentation (window-presenter.ts), which is
  // what session save / reopen-last-closed / tile:window:list read. This IS
  // the single deterministic signal a hybrid window's maximize state ever
  // changes on; see setHybridMaximizeState's doc comment for why the
  // BaseWindow's native 'maximize' event is not used instead.
  subscribe(getSystemAddress(), 'page:maximize', (raw) => {
    const r = baseWinFor(raw);
    if (!r) return;
    try {
      const cur = r.baseWin.getBounds();
      const display = screen.getDisplayNearestPoint({
        x: cur.x + Math.floor(cur.width / 2),
        y: cur.y + Math.floor(cur.height / 2),
      });
      const wa = display.workArea;
      // Idempotent re-maximize: when the registry already says MAXIMIZED, a
      // second page:maximize must NOT restash preMaxBounds — `cur` is the
      // work-area rect by then, and overwriting the stash strands the next
      // unmaximize (and close→reopen's saved pre-max rect) at maximized size.
      // Two intents CAN reach an already-maximized host: the overlay/content
      // dead-space dblclick gesture racing a direct page:maximize intent —
      // both live under headless too now that registration/show-seam dispatch
      // makes `front` (and so the overlay's activeWindowId) work focus-free.
      // The registry flag is the single source of truth here (geometry never
      // votes — see reconcileMaximizeAfterResize): flag==true means the
      // current bounds are not a user rect, because any resize away from the
      // work area clears the flag (exitMaximizeForResize / the native-resize
      // reconciler). Still re-snap bounds: the work area may have moved.
      // Same trap, same guard rationale as tile-ipc.ts's `atWorkArea` check
      // for BrowserWindows.
      const alreadyMaximized = getHybridWindow(r.windowId)?.maximized === true;
      if (!alreadyMaximized) setHybridMaximizeState(r.windowId, true, cur);
      r.baseWin.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
    } catch { /* window gone */ }
  });

  // page:unmaximize — restore the pre-maximize bounds captured by page:maximize.
  // No-op if we have no stashed bounds (was never maximized via this path).
  subscribe(getSystemAddress(), 'page:unmaximize', (raw) => {
    const r = baseWinFor(raw);
    if (!r) return;
    const prev = getHybridWindow(r.windowId)?.preMaxBounds;
    if (!prev) return;
    setHybridMaximizeState(r.windowId, false, null);
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
      // resolve. Consult the hybrid registry first so a repeat open of the
      // same key REUSES the existing hybrid window (focus
      // its baseWin, return its id) instead of spawning a duplicate — matching
      // the canvas key-reuse semantics below.
      {
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
          // Feed the machine the REUSE intent: a key-reuse targets the window
          // exactly like a fresh open. The show/focus block above is skipped
          // under headless (and its OS focus events never fire there), so this
          // dispatch is the only signal the machine gets in a test run — same
          // seam-rationale as the fresh-open dispatch below (WindowId-cutover
          // gate fallout).
          {
            const reusedId = getWindowIdFor(existingHybrid.baseWin);
            if (reusedId != null) dispatchWindowEvent({ type: 'WINDOW_SHOWN', id: reusedId, focused: true });
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
        // Machine reuse-intent dispatch — see the hybrid key-reuse block above
        // for the rationale (headless skips the show/focus block entirely).
        {
          const reusedId = getWindowIdFor(existingWindow.window);
          if (reusedId != null) dispatchWindowEvent({ type: 'WINDOW_SHOWN', id: reusedId, focused: true });
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
      // BaseWindow page-hosts are invisible to findWindowByUrl. Reuse an
      // existing hybrid window loading the same url (focus its baseWin,
      // reload it fresh like the canvas path, return its id) instead of
      // spawning a duplicate.
      {
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
          // Machine reuse-intent dispatch — see the hybrid key-reuse block
          // above for the rationale.
          {
            const reusedId = getWindowIdFor(existingHybridByUrl.baseWin);
            if (reusedId != null) dispatchWindowEvent({ type: 'WINDOW_SHOWN', id: reusedId, focused: true });
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
        // Machine reuse-intent dispatch — see the hybrid key-reuse block
        // above for the rationale.
        {
          const reusedId = getWindowIdFor(existingByUrl.window);
          if (reusedId != null) dispatchWindowEvent({ type: 'WINDOW_SHOWN', id: reusedId, focused: true });
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

    // Check if this is a real web page (vs a peek:// tile / modal / quick-view).
    const isNewTab = url === 'peek://app/new-tab/index.html';
    const isWebPage = url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file:///') || isNewTab;

    // Determine whether this window uses the page-host architecture (a hybrid
    // BaseWindow + WebContentsView content + the shared chrome overlay). Real
    // web pages do by default; a caller can force it with `pageHost: true`
    // (peeks/slides open that way to get the page-host shell + address bar).
    // Modals/quick-views/overlays load their URL directly instead.
    const isModalOrQuickView = options.modal === true || options.overlay === true;
    const usePageHost = options.pageHost === true || (isWebPage && !isModalOrQuickView);

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
      transparent: options.transparent || false,
      backgroundColor: options.transparent ? undefined : getSystemThemeBackgroundColor(),
      webPreferences: {
        ...options.webPreferences,
        preload: tileWebPrefs ? tileWebPrefs.preload : undefined,
        additionalArguments: tileWebPrefs ? tileWebPrefs.additionalArguments : options.webPreferences?.additionalArguments,
        session: profileSession,
        webviewTag: options.webPreferences?.webviewTag || false,
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
    // HYBRID PAGE-HOST EARLY BRANCH (P1.1)
    //
    // When this is a web page open (`usePageHost`), build the
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
    // this handler (findHybridWindowByKey / findHybridWindowByUrl), which
    // reuses+focuses the existing hybrid window (with placement-on-reuse +
    // transient-refresh parity) before we ever reach this construction
    // branch. We only get here on a genuine first open.
    if (usePageHost) {
      try {
        // winOptions.x/y/width/height were filled in above by
        // `computeInitialBounds` (or the caller's explicit x/y) and hold the
        // CONTENT-RECT bounds — we deliberately skip the canvas margin
        // expansion (the chrome-less hybrid window has no surrounding chrome).
        const contentX = winOptions.x as number;
        const contentY = winOptions.y as number;
        const contentW = winOptions.width as number;
        const contentH = winOptions.height as number;

        // Thread the caller's window `type` (peeks/slides pass `type:'panel'`
        // for the non-activating quick-view host — regression 524f7aba). Regular
        // web tabs pass no `type` → ordinary activating window.
        const baseWin = createHybridHostBaseWindow(
          { x: contentX, y: contentY, width: contentW, height: contentH },
          { type: options.type },
        );

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

        const deferContentLoad = options.restoreBlank === true;
        assembleHybridPageHost(baseWin, view, {
          url,
          options,
          source: msg.source,
          placement,
          contentX,
          contentY,
          contentW,
          contentH,
          isWebPage,
          isTransient,
          openerWindow,
          isRealParent: !!isRealParent,
          deferContentLoad,
          rtPreloadApplied: !!rtPrefs,
        });

        // Load the content. Session-restore opens (skipTracking) fire-and-forget
        // like the canvas path; everything else awaits for "ready" semantics
        // (the window is already on screen with its loading frame either way).
        // Deferred-restore windows (restoreBlank) skip the load entirely: the
        // content webContents stays un-navigated (the window shows its theme
        // background fill) until the first activation releases the load via
        // claimHybridDeferredLoad in onHybridHostFocus above.
        if (deferContentLoad) {
          // no-op — deferred to first activation
        } else if (options.skipTracking) {
          view.webContents.loadURL(url).catch((err) => {
            DEBUG && console.log(`[hybrid-page-host:${baseWin.id}] background loadURL failed:`, err);
          });
        } else {
          // A rejected loadURL (DNS failure, connection refused, etc.) must
          // NOT fail the open() call — the window is already constructed and
          // on screen, and wireHybridContentEvents (wired above) already
          // turns the resulting did-fail-load into the load-error overlay.
          // Letting the rejection propagate to the outer catch below would
          // report success:false and drop the caller's only handle on an
          // otherwise-live window (regression: window.app.window.open() on
          // an unreachable URL — the exact case the load-error overlay
          // exists to handle gracefully).
          await view.webContents.loadURL(url).catch((err) => {
            DEBUG && console.log(`[hybrid-page-host:${baseWin.id}] initial loadURL failed (window still opens; load-error overlay handles it):`, err);
          });
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

    DEBUG && console.log('Creating window with options:', winOptions);
    console.log(`[window-open:bounds] url=${url.substring(0, 80)} final position: (${winOptions.x},${winOptions.y}) ${winOptions.width}x${winOptions.height}${usePageHost ? " [page-host]" : ""}`);

    // Pass through optional BrowserWindow properties from caller
    // Headless never floats a window above the user's real desktop (mirrors the
    // gated setAlwaysOnTop reinforcement below).
    if (options.alwaysOnTop !== undefined) winOptions.alwaysOnTop = !isHeadless() && !!options.alwaysOnTop;
    if (options.focusable !== undefined) winOptions.focusable = !!options.focusable;
    if (options.skipTaskbar !== undefined) winOptions.skipTaskbar = !!options.skipTaskbar;
    if (options.hasShadow !== undefined && !usePageHost) winOptions.hasShadow = !!options.hasShadow;

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
      !usePageHost &&
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

    // (alwaysOnTop reinforcement moved into the machine: the registration
    // below declares `alwaysOnTop`, and the reducer's WINDOW_REGISTERED
    // clause emits SET_ALWAYS_ON_TOP('floating' in the backend) — the
    // executor skips it under headless, same compositor-flash guard as the
    // old inline call.)

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
      const consoleLabel = usePageHost ? `page-host:${url.substring(0, 60)}` : url.replace('peek://', '');
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
      // Non-hybrid windows (modals, quick-views, tile launches) load their
      // URL directly — no page-host container.
      const loadUrl = url;

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
      console.log('Adding window to manager:', win.id, 'escapeMode:', windowParams.escapeMode, 'modal:', windowParams.modal, 'keepLive:', windowParams.keepLive, 'transient:', isTransient, 'placement:', placement);
      // Register the BrowserWindow with the window-state machine. Front-
      // ineligibility (satellite) is decided by the shared
      // `isSatelliteRegistration` predicate — see its doc for why a modal /
      // non-focusable window must never become `front`.
      //
      // The registry payload (`source` + `params`, the old main.ts
      // `registerWindow` write) rides the SAME registration now — the
      // machine's window record is the one registry (§4.1 dim 1a / §5 step
      // 4). `class` replaces the HUD-sniffing predicate (alwaysOnTop +
      // focusable:false ⇒ 'hud'); `parentId` drives parent-refocus on close;
      // `alwaysOnTop` makes registration emit the pin effect.
      const machineWindowId = registerWindowWithMachine({
        kind: 'browser',
        role,
        class: classifyWindowRegistration(role, {
          alwaysOnTop: options.alwaysOnTop === true,
          focusable: options.focusable === undefined ? undefined : !!options.focusable,
        }),
        satellite: isSatelliteRegistration(role, {
          modal: options.modal === true,
          focusable: options.focusable === undefined ? undefined : !!options.focusable,
        }),
        escapeMode: options.escapeMode as MachineWindowSpec['escapeMode'],
        lastHttpUrl: url.startsWith('http://') || url.startsWith('https://') ? url : undefined,
        win,
        contentWC: win.webContents,
        source: msg.source,
        params: windowParams,
        parentId: parentWindowId != null ? getWindowIdFor(parentWindowId) : null,
        alwaysOnTop: options.alwaysOnTop === true,
        // keepLive rides the registration (first-class on the reducer record)
        // — the machine's WINDOW_CLOSE_OR_HIDE_REQUESTED clause branches on it.
        keepLive: options.keepLive === true,
      });
      // Feed the machine the OPEN intent (gate fallout of the WindowId
      // cutover) — but ONLY for an open the caller wants VISIBLE. Under
      // HEADLESS the winOptions above force `show: false` and nothing ever
      // shows or focuses the window at the OS level, so no native
      // `'show'`/`'focus'` event will EVER reach the adapter — without this
      // dispatch the machine never learns the window exists on screen and
      // `front` stays null for the whole run (getFocusedVisibleWindowId null,
      // session-save loses the focused descriptor, …). Non-headless the OS
      // events fire too and the reducer re-merges idempotently. `focused:
      // true` ports the deleted "track immediately at open" behavior
      // (`trackVisibleWindowFocus` at this exact site): an open the caller
      // wants visible targets the window. Satellite/modal arbitration is
      // structural in the reducer.
      //
      // A `show:false` open (session-restore pre-warm) gets NO dispatch: the
      // window is natively HIDDEN here, so recording it as shown is a lie the
      // machine ACTS on — the reducer's seed branch (`front == null` +
      // non-satellite) would make the hidden window `front`, and the closing
      // assertion step then emits RAISE_WINDOW, whose executor shows +
      // focuses it. During a visible session restore that machine-initiated
      // activation races (and can precede) session.ts's single-activation
      // authority — the 4f1a974a design: restore activates the focused
      // descriptor exactly once — and the headless gate structurally cannot
      // catch the flash. The window enters the machine when it genuinely
      // becomes visible: the show seams (`showWindowHeadlessSafe` /
      // `showHybridHost` in windows.ts) route through the machine — the
      // backend's `showWindow` echoes WINDOW_SHOWN for the show it performs —
      // and non-headless the native `'show'`/`'focus'` listeners cover any
      // other path.
      if (options.show !== false) {
        dispatchWindowEvent({ type: 'WINDOW_SHOWN', id: machineWindowId, focused: true });
      }
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

      // The ESC `before-input-event` interceptor is attached by
      // `registerWindowWithMachine` above — registration is the single owner of
      // the attach. Calling `addEscHandler(win)` here as well gave this window
      // TWO interceptors (a tile window already got one inside
      // `createTileBrowserWindow`), so one physical Escape produced two
      // `ESC_PRESSED` dispatches and the switcher reopened itself in a loop.

      win.on('focus', () => {
        // Focused-window tracking (front/focusSeq/lastHttpUrl) is owned by the
        // window-state machine now — the OS adapter's `focus` listener
        // (attached at `registerWindowWithMachine` below) feeds it. This handler
        // keeps only the izui-coordinator focus seed (preOverlayFocusTarget),
        // the `window:focused` HUD notify, and the transient-sibling autoclose.
        const winInfo = getWindowInfo(win.id);
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
              // Name the focus thief in the log: which window (or hybrid host)
              // took key and is dismissing this modal. Diagnostic for the
              // palette-dies-over-fullscreen trace (peek 7fffa286 follow-up).
              DEBUG && console.log(
                'window-open: blur for modal window', url,
                '— focus went to:', focused && !focused.isDestroyed() ? `bw ${focused.id} (${getWindowInfo(focused.id)?.params?.address ?? '?'})` : 'no BrowserWindow',
                'frontPageHost:', getFrontPageHostId(),
              );
              // Fire-and-forget (async, never rejects) — blur dismissal.
              void closeOrHideWindow(win.id);
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
        // Mirror the switcher-overlay open into the window-state machine so
        // `decideEscape` step 1 (`switcher.open → close-switcher`) fires. The
        // overlay WINDOW lifecycle (teardown/focus-restore/cooldowns) stays
        // owned by izui + main.ts (staged cutover); this is state-mirror only.
        dispatchWindowEvent({ type: 'SWITCHER_OPENED', windowId: machineWindowId });
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
