/**
 * Session Snapshot — Save/Restore window state
 *
 * Phase 1: Save session snapshot on quit.
 * Captures all visible user windows and writes to extension_settings
 * using synchronous better-sqlite3 APIs (safe for before-quit handler).
 */

import { BrowserWindow } from 'electron';
import { getDb } from './datastore.js';
import { getAllWindows } from './main.js';
import { DEBUG } from './config.js';

export interface WindowDescriptor {
  url: string;
  key: string | undefined;
  title: string;
  bounds: Electron.Rectangle;
  source: string;
  params: Record<string, unknown>;
  zOrder: number;
  focused: boolean;
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

    windowDescriptors.push({
      url: realUrl,
      key: (winData.params.key as string) || undefined,
      title: win.getTitle(),
      bounds: win.getBounds(),
      source: winData.source,
      params: sanitizeParams(winData.params),
      zOrder: zOrderMap.get(id) ?? 0,
      focused: win.isFocused(),
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

    // Write metadata
    const metadata = {
      lastSaveReason: reason,
      lastSaveAt: Date.now(),
      windowCount: windowDescriptors.length,
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
