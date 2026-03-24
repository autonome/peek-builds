/**
 * Session Snapshot — Save/Restore window state
 *
 * Phase 1: Save session snapshot on quit.
 * Phase 2: Restore session snapshot on startup.
 * Phase 3: Periodic autosave timer + manual save/restore commands.
 * Phase 4: Crash recovery dialog, snapshot validation, error handling.
 *
 * Captures all visible user windows and writes to feature_settings
 * using synchronous better-sqlite3 APIs (safe for before-quit handler).
 * On startup, reads the snapshot and recreates windows.
 *
 * NOTE: Pure logic shared copy lives in app/lib/session.js for frontend/Tauri use.
 */

import { BrowserWindow, dialog, screen } from 'electron';
import { getDb, getContextEntry, addContextEntry } from './datastore.js';
import { getAllWindows, getBackgroundWindow, pushClosedWindow, suppressClosedWindowPush } from './main.js';
import type { ClosedWindowEntry } from './main.js';
import { getRegisteredExtensionIds } from './protocol.js';

import { publish, scopes as PubSubScopes, getSystemAddress } from './pubsub.js';
import { DEBUG, isTestProfile } from './config.js';

export interface WindowContext {
  mode: string | null;
  modeMetadata: Record<string, unknown> | null;
}

export interface WindowDescriptor {
  url: string;
  key: string | undefined;
  title: string;
  bounds: Electron.Rectangle;
  source: string;
  params: Record<string, unknown>;
  zOrder: number;
  focused: boolean;
  context?: WindowContext;
}

export interface SessionMetadata {
  lastSaveReason: string;
  lastSaveAt: number;
  windowCount: number;
  cleanShutdown: boolean;
  crashCount: number;
  lastRestoreAt?: number;
  restoreCount?: number;
}

export interface SessionSnapshot {
  version: 1;
  createdAt: number;
  reason: 'before-quit' | 'autosave' | 'manual';
  windows: WindowDescriptor[];
}

/**
 * Extract the real URL from a page container URL.
 * Page containers use peek://app/page/index.html?url=<actual-url>
 * Returns the actual URL, or the original URL if not a container.
 */
function extractRealUrl(url: string): string {
  if (url.startsWith('peek://app/page')) {
    try {
      const parsed = new URL(url);
      const actualUrl = parsed.searchParams.get('url');
      if (actualUrl) {
        return actualUrl;
      }
    } catch {
      // If URL parsing fails, keep the original
    }
  }
  return url;
}

/**
 * Extract webview bounds from a canvas page container URL.
 * Canvas pages encode the visible webview position/size in URL params.
 * Returns null if the URL is not a canvas page or params are missing.
 */
function extractCanvasBounds(url: string): Electron.Rectangle | null {
  if (!url.startsWith('peek://app/page')) return null;
  try {
    const parsed = new URL(url);
    const x = parsed.searchParams.get('x');
    const y = parsed.searchParams.get('y');
    const width = parsed.searchParams.get('width');
    const height = parsed.searchParams.get('height');
    if (x && y && width && height) {
      return {
        x: parseInt(x, 10),
        y: parseInt(y, 10),
        width: parseInt(width, 10),
        height: parseInt(height, 10),
      };
    }
  } catch {
    // If URL parsing fails, skip
  }
  return null;
}

/**
 * Sanitize params to only include serializable values.
 * Mirrors the logic in ipc.ts window-list handler.
 */
function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean' || value === null) {
      safe[key] = value;
    } else if (Array.isArray(value)) {
      if (value.every(v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null)) {
        safe[key] = value;
      }
    }
    // Skip functions, objects, etc. that may not serialize safely
  }
  return safe;
}

/**
 * Save a snapshot of all visible user windows to the datastore.
 *
 * MUST be synchronous — runs in the before-quit handler before closeDatabase().
 * Uses better-sqlite3 synchronous APIs via getDb().
 */
export function saveSessionSnapshot(reason: SessionSnapshot['reason'], opts?: { cleanShutdown?: boolean }): void {
  // Skip save in test environments
  if (isTestProfile()) return;

  DEBUG && console.log(`[session] Saving session snapshot (reason: ${reason})`);

  let db;
  try {
    db = getDb();
  } catch {
    // Database not initialized or already closed
    DEBUG && console.log('[session] Database not available, skipping session save');
    return;
  }

  const registeredWindows = getAllWindows();
  const windowDescriptors: WindowDescriptor[] = [];

  // Use BrowserWindow.getAllWindows() order for z-order approximation
  const allBrowserWindows = BrowserWindow.getAllWindows();
  const zOrderMap = new Map<number, number>();
  allBrowserWindows.forEach((win, index) => {
    zOrderMap.set(win.id, index);
  });

  for (const [id, winData] of registeredWindows) {
    const win = BrowserWindow.fromId(id);

    // Skip destroyed windows
    if (!win || win.isDestroyed()) {
      continue;
    }

    // Skip invisible windows
    if (!win.isVisible()) {
      continue;
    }

    const url = win.webContents.getURL();

    // Skip the background window
    if (url.includes('peek://app/background.html')) {
      continue;
    }

    // Skip the extension host
    if (url.includes('peek://app/extension-host.html')) {
      continue;
    }

    // Skip modal windows
    if (winData.params.modal) {
      continue;
    }

    // Skip non-focusable utility windows (e.g. HUD overlays).
    // These are extension-managed and shouldn't be restored by session.
    // User-facing utility windows (settings, diagnostic, etc.) ARE saved.
    if (winData.params.role === 'utility' && winData.params.focusable === false) {
      continue;
    }

    // Extract real URL from page containers
    const realUrl = extractRealUrl(url);

    // Skip windows for unknown extensions (stale from renames/removals)
    const extMatch = realUrl.match(/^peek:\/\/ext\/([^/]+)/);
    if (extMatch) {
      const extId = extMatch[1];
      const knownIds = getRegisteredExtensionIds();
      if (!knownIds.includes(extId)) {
        DEBUG && console.log(`[session:save] Skipping stale extension window ${id}: ${extId}`);
        continue;
      }
    }

    // For canvas pages (web URLs in peek://app/page container), use the webview
    // bounds from URL params, not the fullscreen transparent BrowserWindow bounds.
    const canvasBounds = extractCanvasBounds(url);
    const windowBounds = canvasBounds || win.getBounds();

    console.log(`[session:save] Window ${id} "${win.getTitle()}" bounds: (${windowBounds.x},${windowBounds.y}) ${windowBounds.width}x${windowBounds.height}${canvasBounds ? " [canvas]" : ""} url=${realUrl.substring(0, 80)}`);

    // Capture context state for this window
    let windowContext: WindowContext | undefined;
    try {
      const modeEntry = getContextEntry('mode', id);
      if (modeEntry) {
        windowContext = {
          mode: modeEntry.value as string,
          modeMetadata: (modeEntry.metadata as Record<string, unknown>) || null,
        };
      }
    } catch {
      // Context not available, skip
    }

    windowDescriptors.push({
      url: realUrl,
      key: (winData.params.key as string) || undefined,
      title: win.getTitle(),
      bounds: windowBounds,
      source: winData.source,
      params: sanitizeParams(winData.params),
      zOrder: zOrderMap.get(id) ?? 0,
      focused: win.isFocused(),
      context: windowContext,
    });
  }

  const snapshot: SessionSnapshot = {
    version: 1,
    createdAt: Date.now(),
    reason,
    windows: windowDescriptors,
  };

  DEBUG && console.log(`[session] Captured ${windowDescriptors.length} window(s)`);

  try {
    // Write snapshot to feature_settings table
    db.prepare(`
      INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
      VALUES (?, 'session', 'snapshot', ?, ?)
    `).run('session-snapshot', JSON.stringify(snapshot), Date.now());

    // Read existing metadata to preserve crashCount and restoreCount
    let existingMetadata: Partial<SessionMetadata> = {};
    try {
      const metaRow = db.prepare(
        `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'metadata'`
      ).get() as { value: string } | undefined;
      if (metaRow?.value) {
        existingMetadata = JSON.parse(metaRow.value);
      }
    } catch {
      // No existing metadata
    }

    // Write metadata with cleanShutdown flag
    // Default to true (normal quit), but SIGINT/SIGTERM pass false
    // so the user gets the crash recovery prompt on next startup.
    const metadata: SessionMetadata = {
      lastSaveReason: reason,
      lastSaveAt: Date.now(),
      windowCount: windowDescriptors.length,
      cleanShutdown: opts?.cleanShutdown !== false,
      crashCount: existingMetadata.crashCount ?? 0,
      lastRestoreAt: existingMetadata.lastRestoreAt,
      restoreCount: existingMetadata.restoreCount,
    };
    db.prepare(`
      INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
      VALUES (?, 'session', 'metadata', ?, ?)
    `).run('session-metadata', JSON.stringify(metadata), Date.now());

    DEBUG && console.log(`[session] Session snapshot saved successfully`);

    // Push all currently open content windows onto the closed window stack
    // so they can be recovered via undo-close-window if session restore fails.
    // Push web URLs (http/https) and peek:// URLs (ext/app pages, not background).
    // Same filtering as the closed handler in main.ts.
    // Also suppress the per-window 'closed' event push to prevent double entries.
    if (reason === 'before-quit') {
      suppressClosedWindowPush();
      for (const descriptor of windowDescriptors) {
        const isWebUrl = descriptor.url.startsWith('http://') || descriptor.url.startsWith('https://');
        const isPeekUrl = descriptor.url.startsWith('peek://ext/') || descriptor.url.startsWith('peek://app/');
        const isBackgroundPage = descriptor.url.includes('background.html') || descriptor.url.includes('extension-host.html');
        const isReopenable = isWebUrl || (isPeekUrl && !isBackgroundPage);
        if (!isReopenable) continue;

        // Check for space mode in context
        let spaceMode: ClosedWindowEntry['spaceMode'] = null;
        if (descriptor.context?.mode === 'space' && descriptor.context.modeMetadata) {
          spaceMode = {
            spaceId: descriptor.context.modeMetadata.spaceId as string,
            spaceName: descriptor.context.modeMetadata.spaceName as string,
            color: descriptor.context.modeMetadata.color as string | undefined,
          };
        }

        pushClosedWindow({
          url: descriptor.url,
          source: descriptor.source,
          bounds: descriptor.bounds,
          spaceMode,
          role: (descriptor.params.role as string) || undefined,
          timestamp: Date.now(),
        });
      }
      DEBUG && console.log(`[session] Pushed ${windowDescriptors.filter(d => {
        const isWeb = d.url.startsWith('http://') || d.url.startsWith('https://');
        const isPeek = d.url.startsWith('peek://ext/') || d.url.startsWith('peek://app/');
        const isBg = d.url.includes('background.html') || d.url.includes('extension-host.html');
        return isWeb || (isPeek && !isBg);
      }).length} open window(s) to closed window stack`);
    }

    // Also save per-space workspace snapshots (for space layout restore)
    saveSpaceWorkspaces();
  } catch (error) {
    console.error('[session] Failed to save session snapshot:', error);
  }
}

/**
 * Mark session as dirty (not cleanly shut down).
 * Called on app startup before restore, so if the app crashes
 * before the next save, we know it wasn't clean.
 */
export function markSessionDirty(): void {
  if (isTestProfile()) return;

  let db;
  try {
    db = getDb();
  } catch {
    return;
  }

  try {
    const metaRow = db.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'metadata'`
    ).get() as { value: string } | undefined;

    let metadata: Partial<SessionMetadata> = {};
    if (metaRow?.value) {
      metadata = JSON.parse(metaRow.value);
    }

    // If previous session was not clean, increment crash count
    if (metadata.cleanShutdown === false) {
      metadata.crashCount = (metadata.crashCount ?? 0) + 1;
      DEBUG && console.log(`[session] Detected unclean shutdown, crash count: ${metadata.crashCount}`);
    }

    // Mark current session as dirty
    metadata.cleanShutdown = false;

    db.prepare(`
      INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
      VALUES (?, 'session', 'metadata', ?, ?)
    `).run('session-metadata', JSON.stringify(metadata), Date.now());

    DEBUG && console.log('[session] Marked session as dirty');
  } catch (error) {
    console.error('[session] Failed to mark session dirty:', error);
  }
}

/**
 * Validate that a window descriptor has the required fields for restore.
 * Returns false if the descriptor is invalid and should be skipped.
 */
function isValidDescriptor(descriptor: WindowDescriptor): boolean {
  // Must have a URL
  if (!descriptor.url || typeof descriptor.url !== 'string' || descriptor.url.trim() === '') {
    return false;
  }

  // Filter out ephemeral loopback/localhost callback URLs (e.g. OAuth callbacks
  // to http://127.0.0.1:{port}/callback). These are short-lived servers that won't
  // exist on restart, so restoring them would show a connection-refused error.
  try {
    const parsed = new URL(descriptor.url);
    if ((parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
        parsed.pathname.includes('/callback')) {
      DEBUG && console.log(`[session] Filtering ephemeral callback URL: ${descriptor.url}`);
      return false;
    }
  } catch {
    // URL parsing failed, continue with other checks
  }

  // Validate extension URLs reference a known extension
  // (e.g. peek://ext/me:core/... from a renamed extension would be stale)
  const extMatch = descriptor.url.match(/^peek:\/\/ext\/([^/]+)/);
  if (extMatch) {
    const extId = extMatch[1];
    const knownIds = getRegisteredExtensionIds();
    if (!knownIds.includes(extId)) {
      DEBUG && console.log(`[session] Filtering stale extension window: ${extId}`);
      return false;
    }
  }

  return true;
}

/**
 * Show crash recovery dialog and return whether the user wants to restore.
 * Returns true if restore should proceed, false to start fresh.
 */
async function showCrashRecoveryDialog(crashCount: number): Promise<boolean> {
  // Too many crashes — skip restore automatically
  if (crashCount > 3) {
    console.warn(`[session] ${crashCount} consecutive crashes detected. Starting fresh to avoid further issues.`);
    return false;
  }

  // Show dialog asking user what to do
  const result = await dialog.showMessageBox({
    type: 'question',
    title: 'Restore Previous Session?',
    message: "Peek didn't shut down cleanly last time. Would you like to restore your previous session?",
    buttons: ['Restore Session', 'Start Fresh'],
    defaultId: 0,
    cancelId: 1,
  });

  // Button index 0 = "Restore Session", 1 = "Start Fresh"
  return result.response === 0;
}

/**
 * Check if a point falls within any active display.
 */
function isPointOnScreen(x: number, y: number): boolean {
  const displays = screen.getAllDisplays();
  for (const display of displays) {
    const { x: dx, y: dy, width, height } = display.bounds;
    if (x >= dx && x < dx + width && y >= dy && y < dy + height) {
      return true;
    }
  }
  return false;
}

/**
 * Restore session snapshot on startup.
 *
 * Reads the saved snapshot from feature_settings, validates it,
 * and recreates windows using the background window's IPC bridge.
 *
 * Returns counts of restored/failed/total windows.
 */
/**
 * Read session metadata to determine crash state BEFORE markSessionDirty() is called.
 * This captures the true previous shutdown state before it gets overwritten.
 * Returns { cleanShutdown, crashCount } for use by restoreSessionSnapshot.
 */
export function readSessionCrashState(): { cleanShutdown: boolean; crashCount: number } {
  try {
    const db = getDb();
    const metaRow = db.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'metadata'`
    ).get() as { value: string } | undefined;

    if (metaRow?.value) {
      const metadata = JSON.parse(metaRow.value);
      return {
        cleanShutdown: metadata.cleanShutdown !== false, // default to true if missing
        crashCount: metadata.crashCount ?? 0,
      };
    }
  } catch {
    // No metadata available
  }
  return { cleanShutdown: true, crashCount: 0 };
}

export async function restoreSessionSnapshot(
  prefs: Record<string, unknown>,
  crashState?: { cleanShutdown: boolean; crashCount: number }
): Promise<{ restored: number; failed: number; total: number }> {
  const result = { restored: 0, failed: 0, total: 0 };

  // Skip restore in test environments
  if (isTestProfile()) {
    DEBUG && console.log('[session] Skipping session restore in test profile');
    return result;
  }

  // Check restoreSession pref
  if (prefs.restoreSession === false) {
    DEBUG && console.log('[session] Session restore disabled by pref');
    return result;
  }

  let db;
  try {
    db = getDb();
  } catch {
    DEBUG && console.log('[session] Database not available, skipping restore');
    return result;
  }

  // Check crash detection — show dialog or skip restore.
  // Use the pre-read crashState (captured before markSessionDirty) if provided,
  // otherwise fall back to reading current metadata (for manual restore calls).
  try {
    let wasCleanShutdown = true;
    let crashCount = 0;

    if (crashState) {
      // Use pre-read state (startup path — read before markSessionDirty contaminated it)
      wasCleanShutdown = crashState.cleanShutdown;
      crashCount = crashState.crashCount;
    } else {
      // Fallback: read current metadata (manual restore path)
      const metaRow = db.prepare(
        `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'metadata'`
      ).get() as { value: string } | undefined;
      if (metaRow?.value) {
        const metadata: Partial<SessionMetadata> = JSON.parse(metaRow.value);
        wasCleanShutdown = metadata.cleanShutdown !== false;
        crashCount = metadata.crashCount ?? 0;
      }
    }

    DEBUG && console.log(`[session] Crash state: wasCleanShutdown=${wasCleanShutdown}, crashCount=${crashCount}`);
    if (!wasCleanShutdown && crashCount > 0) {
      // Only show crash dialog after repeated crashes (crashCount > 0).
      // A single unclean shutdown (e.g. Ctrl+C via yarn, power loss) just
      // silently restores — the crash dialog is for crash loops.
      const shouldRestore = await showCrashRecoveryDialog(crashCount);
      if (!shouldRestore) {
        DEBUG && console.log('[session] User chose to start fresh (or too many crashes)');
        return result;
      }
    }
  } catch {
    // Continue with restore if metadata check fails
  }

  // Read the snapshot
  let snapshot: SessionSnapshot;
  try {
    const row = db.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'snapshot'`
    ).get() as { value: string } | undefined;

    if (!row?.value) {
      DEBUG && console.log('[session] No snapshot found');
      return result;
    }

    snapshot = JSON.parse(row.value);
  } catch (error) {
    console.error('[session] Failed to read snapshot:', error);
    return result;
  }

  // Validate version
  if (snapshot.version !== 1) {
    console.warn(`[session] Unknown snapshot version: ${snapshot.version}`);
    return result;
  }

  // Check if there are windows to restore
  if (!snapshot.windows || snapshot.windows.length === 0) {
    DEBUG && console.log('[session] Snapshot has no windows');
    return result;
  }

  // Validate individual window descriptors — filter out invalid/stale entries
  const validWindows = snapshot.windows.filter((descriptor) => {
    if (!isValidDescriptor(descriptor)) {
      DEBUG && console.log(`[session] Skipping invalid/stale window: ${descriptor.url || '(empty)'}`);
      return false;
    }
    return true;
  });

  if (validWindows.length === 0) {
    DEBUG && console.log('[session] No valid windows to restore after validation');
    return result;
  }

  if (validWindows.length < snapshot.windows.length) {
    DEBUG && console.log(`[session] Filtered ${snapshot.windows.length - validWindows.length} invalid window(s)`);
  }

  result.total = validWindows.length;
  DEBUG && console.log(`[session] Restoring ${result.total} window(s) from snapshot`);

  // Wait for background window to be ready (needed for IPC)
  const bgWin = getBackgroundWindow();
  if (!bgWin || bgWin.isDestroyed()) {
    console.error('[session] Background window not available for restore');
    return result;
  }

  // Sort windows by zOrder (higher zOrder = later in stack = opened later)
  const sortedWindows = [...validWindows].sort((a, b) => b.zOrder - a.zOrder);

  // Track which window was focused for later focus restoration
  let focusedWindowId: number | null = null;

  for (const descriptor of sortedWindows) {
    try {
      // Validate bounds: check if saved center point falls within any active display
      const centerX = descriptor.bounds.x + Math.round(descriptor.bounds.width / 2);
      const centerY = descriptor.bounds.y + Math.round(descriptor.bounds.height / 2);

      const boundsOptions: Record<string, unknown> = {
        width: descriptor.bounds.width,
        height: descriptor.bounds.height,
      };

      if (isPointOnScreen(centerX, centerY)) {
        // Center point is on a valid display, use saved position
        boundsOptions.x = descriptor.bounds.x;
        boundsOptions.y = descriptor.bounds.y;
      }
      // If not on screen, omit x/y and let window-open center it


      console.log(`[session:restore] Window "${descriptor.url.substring(0, 80)}" saved bounds: (${descriptor.bounds.x},${descriptor.bounds.y}) ${descriptor.bounds.width}x${descriptor.bounds.height}, center=(${centerX},${centerY}), onScreen=${isPointOnScreen(centerX, centerY)}, boundsOptions: x=${boundsOptions.x} y=${boundsOptions.y}`);

      // Strip params that would interfere with the window-open handler's own logic.
      // These are internal bookkeeping or context-dependent values that should be
      // re-derived from the URL and current environment during restore:
      // - x/y/width/height: stale positions from original creation (bounds are authoritative)
      // - address: internal bookkeeping param, overwritten by window-open anyway
      // - transient/parentWindowId: session state, not applicable to restored windows
      // Note: role and escapeMode are preserved — they're semantic properties that
      // describe how the window should behave (e.g., ESC handling for extension windows).
      const cleanParams: Record<string, unknown> = {};
      const stripKeys = new Set(['x', 'y', 'width', 'height', 'address', 'transient', 'parentWindowId', 'skipTracking']);
      for (const [key, value] of Object.entries(descriptor.params)) {
        if (!stripKeys.has(key)) {
          cleanParams[key] = value;
        }
      }

      // Build options from cleaned params, overlaying bounds
      const options: Record<string, unknown> = {
        ...cleanParams,
        ...boundsOptions,
        // Skip visit tracking — restoring a session is not a new navigation
        skipTracking: true,
      };

      // Ensure the window key is set for deduplication
      if (descriptor.key) {
        options.key = descriptor.key;
      }

      // Open window via IPC through the background window's preload API.
      // The preload exposes window.app.window.open() which calls
      // ipcRenderer.invoke('window-open', ...) under the hood.
      // Note: source will be the background window's address, which is fine
      // for newly restored windows on startup.
      DEBUG && console.log(`[session] Opening restored window: ${descriptor.url}`);
      const openResult = await bgWin.webContents.executeJavaScript(
        `window.app.window.open(${JSON.stringify(descriptor.url)}, ${JSON.stringify(options)})`
      );
      DEBUG && console.log(`[session] Window open result:`, JSON.stringify(openResult));

      if (openResult && openResult.success && openResult.id) {
        result.restored++;

        // Restore context (mode, spaceId, spaceName) after window creation
        if (descriptor.context?.mode) {
          try {
            addContextEntry('mode', descriptor.context.mode, {
              windowId: openResult.id,
              source: 'session-restore',
              metadata: descriptor.context.modeMetadata || { url: descriptor.url },
            });
            DEBUG && console.log(`[session] Restored context mode=${descriptor.context.mode} for window ${openResult.id}`);
          } catch (ctxError) {
            DEBUG && console.log('[session] Failed to restore context:', ctxError);
          }
        }

        // Track focused window
        if (descriptor.focused) {
          focusedWindowId = openResult.id;
        }
      } else {
        result.failed++;
        DEBUG && console.log(`[session] Failed to restore window: ${descriptor.url}`, openResult?.error);
      }
    } catch (error) {
      result.failed++;
      console.error(`[session] Error restoring window ${descriptor.url}:`, error);
    }
  }

  // Focus the window that was focused at save time
  if (focusedWindowId) {
    try {
      const focusWin = BrowserWindow.fromId(focusedWindowId);
      if (focusWin && !focusWin.isDestroyed()) {
        focusWin.focus();
        DEBUG && console.log(`[session] Focused restored window: ${focusedWindowId}`);
      }
    } catch {
      // Best-effort focus
    }
  }

  // Check for partial restore — warn if majority of windows failed
  if (result.failed > 0 && result.total > 2 && result.failed > result.total / 2) {
    console.warn(`[session] Partial restore: ${result.failed}/${result.total} windows failed`);
    try {
      publish(getSystemAddress(), PubSubScopes.GLOBAL, 'session:restore-partial', {
        restored: result.restored,
        failed: result.failed,
        total: result.total,
      });
    } catch {
      // Non-critical
    }
  }

  // Publish session:restored event
  try {
    publish(getSystemAddress(), PubSubScopes.GLOBAL, 'session:restored', {
      restored: result.restored,
      failed: result.failed,
      total: result.total,
    });
  } catch {
    // Non-critical
  }

  // Update session metadata with restore info and reset crashCount
  try {
    const metaRow = db.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'metadata'`
    ).get() as { value: string } | undefined;

    let metadata: Partial<SessionMetadata> = {};
    if (metaRow?.value) {
      metadata = JSON.parse(metaRow.value);
    }

    metadata.lastRestoreAt = Date.now();
    metadata.restoreCount = (metadata.restoreCount ?? 0) + 1;
    // Reset crash count after successful restore
    metadata.crashCount = 0;

    db.prepare(`
      INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
      VALUES (?, 'session', 'metadata', ?, ?)
    `).run('session-metadata', JSON.stringify(metadata), Date.now());
  } catch {
    // Non-critical
  }

  DEBUG && console.log(`[session] Restore complete: ${result.restored}/${result.total} windows restored, ${result.failed} failed`);
  return result;
}

// ============================================================================
// Phase 3: Autosave Timer
// ============================================================================

let _autosaveTimer: ReturnType<typeof setInterval> | null = null;
let _autosaveIntervalMinutes = 0;

/**
 * Start or restart the periodic autosave timer.
 *
 * @param intervalMinutes - Interval in minutes (0 = disabled)
 */
export function startAutosaveTimer(intervalMinutes: number): void {
  if (isTestProfile()) return;

  // Stop existing timer first
  stopAutosaveTimer();

  _autosaveIntervalMinutes = intervalMinutes;

  if (intervalMinutes <= 0) {
    DEBUG && console.log('[session] Autosave disabled (interval=0)');
    return;
  }

  const intervalMs = intervalMinutes * 60 * 1000;
  _autosaveTimer = setInterval(() => {
    DEBUG && console.log('[session] Autosave timer fired');
    saveSessionSnapshot('autosave');
  }, intervalMs);

  DEBUG && console.log(`[session] Autosave timer started: every ${intervalMinutes} minute(s)`);
}

/**
 * Stop the periodic autosave timer.
 * Called during quit cleanup, before the final save.
 */
export function stopAutosaveTimer(): void {
  if (_autosaveTimer !== null) {
    clearInterval(_autosaveTimer);
    _autosaveTimer = null;
    DEBUG && console.log('[session] Autosave timer stopped');
  }
}

/**
 * Update the autosave interval if it has changed.
 * Called when prefs change to restart the timer with the new interval.
 */
export function updateAutosaveInterval(intervalMinutes: number): void {
  if (intervalMinutes !== _autosaveIntervalMinutes) {
    DEBUG && console.log(`[session] Autosave interval changed: ${_autosaveIntervalMinutes} -> ${intervalMinutes}`);
    startAutosaveTimer(intervalMinutes);
  }
}

/**
 * Save per-space workspace snapshots to feature_settings.
 *
 * Groups windows by their space mode context and writes a layout snapshot
 * for each space. Used by openGroup() to restore window positions.
 * Synchronous (safe for before-quit handler).
 */
export function saveSpaceWorkspaces(): void {
  let db;
  try {
    db = getDb();
  } catch {
    return;
  }

  const registeredWindows = getAllWindows();

  // Use BrowserWindow.getAllWindows() order for z-order approximation
  const allBrowserWindows = BrowserWindow.getAllWindows();
  const zOrderMap = new Map<number, number>();
  allBrowserWindows.forEach((win, index) => {
    zOrderMap.set(win.id, index);
  });

  // Collect windows grouped by spaceId
  const spaceWindows = new Map<string, { spaceName: string; windows: Array<{ url: string; bounds: Electron.Rectangle; zOrder: number; focused: boolean }> }>();

  for (const [id] of registeredWindows) {
    const win = BrowserWindow.fromId(id);
    if (!win || win.isDestroyed() || !win.isVisible()) continue;

    const rawUrl = win.webContents.getURL();
    if (rawUrl.includes('peek://app/background.html') || rawUrl.includes('peek://app/extension-host.html')) continue;

    // Check if this window is in space mode
    let modeEntry;
    try {
      modeEntry = getContextEntry('mode', id);
    } catch {
      continue;
    }
    if (!modeEntry || modeEntry.value !== 'space') continue;

    const metadata = modeEntry.metadata as Record<string, unknown> | null;
    const spaceId = metadata?.spaceId as string | undefined;
    const spaceName = metadata?.spaceName as string | undefined;
    if (!spaceId) continue;

    const realUrl = extractRealUrl(rawUrl);
    const canvasBounds = extractCanvasBounds(rawUrl);
    const bounds = canvasBounds || win.getBounds();

    if (!spaceWindows.has(spaceId)) {
      spaceWindows.set(spaceId, { spaceName: spaceName || '', windows: [] });
    }
    spaceWindows.get(spaceId)!.windows.push({
      url: realUrl,
      bounds,
      zOrder: zOrderMap.get(id) ?? 0,
      focused: win.isFocused(),
    });
  }

  // Write each space's workspace snapshot
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, 'space-workspaces', ?, ?, ?)
  `);

  for (const [spaceId, space] of spaceWindows) {
    const snapshot = {
      version: 1,
      spaceId,
      spaceName: space.spaceName,
      createdAt: Date.now(),
      windows: space.windows,
    };
    const key = `workspace:${spaceId}`;
    upsert.run(`space-workspaces:${key}`, key, JSON.stringify(snapshot), Date.now());
  }

  DEBUG && console.log(`[session] Saved workspace snapshots for ${spaceWindows.size} space(s)`);
}

/**
 * Get info about the saved session snapshot without restoring it.
 * Returns null if no valid snapshot exists.
 */
export function getSessionSnapshotInfo(): { windowCount: number; savedAt: number; reason: string } | null {
  try {
    const db = getDb();
    const row = db.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'snapshot'`
    ).get() as { value: string } | undefined;

    if (!row?.value) return null;

    const snapshot: SessionSnapshot = JSON.parse(row.value);
    if (snapshot.version !== 1 || !snapshot.windows?.length) return null;

    const validCount = snapshot.windows.filter(d => isValidDescriptor(d)).length;
    if (validCount === 0) return null;

    return {
      windowCount: validCount,
      savedAt: snapshot.createdAt,
      reason: snapshot.reason,
    };
  } catch {
    return null;
  }
}
