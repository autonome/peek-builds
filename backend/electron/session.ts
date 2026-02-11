/**
 * Session Snapshot — Save/Restore window state
 *
 * Phase 1: Save session snapshot on quit.
 * Phase 2: Restore session snapshot on startup.
 *
 * Captures all visible user windows and writes to extension_settings
 * using synchronous better-sqlite3 APIs (safe for before-quit handler).
 * On startup, reads the snapshot and recreates windows.
 */

import { BrowserWindow, screen } from 'electron';
import { getDb, getContextEntry, addContextEntry } from './datastore.js';
import { getAllWindows, getBackgroundWindow } from './main.js';
import { publish, scopes as PubSubScopes, getSystemAddress } from './pubsub.js';
import { DEBUG } from './config.js';

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
export function saveSessionSnapshot(reason: SessionSnapshot['reason']): void {
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

    // Extract real URL from page containers
    const realUrl = extractRealUrl(url);

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
      bounds: win.getBounds(),
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
    // Write snapshot to extension_settings table
    db.prepare(`
      INSERT OR REPLACE INTO extension_settings (id, extensionId, key, value, updatedAt)
      VALUES (?, 'session', 'snapshot', ?, ?)
    `).run('session-snapshot', JSON.stringify(snapshot), Date.now());

    // Read existing metadata to preserve crashCount and restoreCount
    let existingMetadata: Partial<SessionMetadata> = {};
    try {
      const metaRow = db.prepare(
        `SELECT value FROM extension_settings WHERE extensionId = 'session' AND key = 'metadata'`
      ).get() as { value: string } | undefined;
      if (metaRow?.value) {
        existingMetadata = JSON.parse(metaRow.value);
      }
    } catch {
      // No existing metadata
    }

    // Write metadata with cleanShutdown flag
    const metadata: SessionMetadata = {
      lastSaveReason: reason,
      lastSaveAt: Date.now(),
      windowCount: windowDescriptors.length,
      cleanShutdown: true,
      crashCount: existingMetadata.crashCount ?? 0,
      lastRestoreAt: existingMetadata.lastRestoreAt,
      restoreCount: existingMetadata.restoreCount,
    };
    db.prepare(`
      INSERT OR REPLACE INTO extension_settings (id, extensionId, key, value, updatedAt)
      VALUES (?, 'session', 'metadata', ?, ?)
    `).run('session-metadata', JSON.stringify(metadata), Date.now());

    DEBUG && console.log(`[session] Session snapshot saved successfully`);
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
  let db;
  try {
    db = getDb();
  } catch {
    return;
  }

  try {
    const metaRow = db.prepare(
      `SELECT value FROM extension_settings WHERE extensionId = 'session' AND key = 'metadata'`
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
      INSERT OR REPLACE INTO extension_settings (id, extensionId, key, value, updatedAt)
      VALUES (?, 'session', 'metadata', ?, ?)
    `).run('session-metadata', JSON.stringify(metadata), Date.now());

    DEBUG && console.log('[session] Marked session as dirty');
  } catch (error) {
    console.error('[session] Failed to mark session dirty:', error);
  }
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
 * Reads the saved snapshot from extension_settings, validates it,
 * and recreates windows using the background window's IPC bridge.
 *
 * Returns counts of restored/failed/total windows.
 */
export async function restoreSessionSnapshot(prefs: Record<string, unknown>): Promise<{ restored: number; failed: number; total: number }> {
  const result = { restored: 0, failed: 0, total: 0 };

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

  // Check crash detection — skip restore if too many consecutive crashes
  try {
    const metaRow = db.prepare(
      `SELECT value FROM extension_settings WHERE extensionId = 'session' AND key = 'metadata'`
    ).get() as { value: string } | undefined;

    if (metaRow?.value) {
      const metadata: Partial<SessionMetadata> = JSON.parse(metaRow.value);
      if (metadata.cleanShutdown === false && (metadata.crashCount ?? 0) > 3) {
        console.warn(`[session] Skipping restore: ${metadata.crashCount} consecutive crashes detected`);
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
      `SELECT value FROM extension_settings WHERE extensionId = 'session' AND key = 'snapshot'`
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

  result.total = snapshot.windows.length;
  DEBUG && console.log(`[session] Restoring ${result.total} window(s) from snapshot`);

  // Wait for background window to be ready (needed for IPC)
  const bgWin = getBackgroundWindow();
  if (!bgWin || bgWin.isDestroyed()) {
    console.error('[session] Background window not available for restore');
    return result;
  }

  // Sort windows by zOrder (higher zOrder = later in stack = opened later)
  const sortedWindows = [...snapshot.windows].sort((a, b) => b.zOrder - a.zOrder);

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

      // Build options from saved params, overlaying bounds
      const options: Record<string, unknown> = {
        ...descriptor.params,
        ...boundsOptions,
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
      const openResult = await bgWin.webContents.executeJavaScript(
        `window.app.window.open(${JSON.stringify(descriptor.url)}, ${JSON.stringify(options)})`
      );

      if (openResult && openResult.success && openResult.id) {
        result.restored++;

        // Restore context (mode, groupId, groupName) after window creation
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

  // Update session metadata with restore info
  try {
    const metaRow = db.prepare(
      `SELECT value FROM extension_settings WHERE extensionId = 'session' AND key = 'metadata'`
    ).get() as { value: string } | undefined;

    let metadata: Partial<SessionMetadata> = {};
    if (metaRow?.value) {
      metadata = JSON.parse(metaRow.value);
    }

    metadata.lastRestoreAt = Date.now();
    metadata.restoreCount = (metadata.restoreCount ?? 0) + 1;

    db.prepare(`
      INSERT OR REPLACE INTO extension_settings (id, extensionId, key, value, updatedAt)
      VALUES (?, 'session', 'metadata', ?, ?)
    `).run('session-metadata', JSON.stringify(metadata), Date.now());
  } catch {
    // Non-critical
  }

  DEBUG && console.log(`[session] Restore complete: ${result.restored}/${result.total} windows restored, ${result.failed} failed`);
  return result;
}
