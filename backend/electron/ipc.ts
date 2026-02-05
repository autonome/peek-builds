/**
 * IPC Handler Registration
 *
 * Centralizes all IPC handlers for the main process.
 * Handlers are thin wrappers that delegate to backend functions.
 */

import { ipcMain, nativeTheme, dialog, BrowserWindow, app, screen, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import {
  // Datastore operations
  addAddress,
  getAddress,
  updateAddress,
  queryAddresses,
  addVisit,
  queryVisits,
  addContent,
  queryContent,
  getOrCreateTag,
  tagAddress,
  untagAddress,
  getTagsByFrecency,
  getAddressTags,
  getAddressesByTag,
  getUntaggedAddresses,
  getTable,
  setRow,
  getRow,
  getStats,
  isValidTable,
  getDb,
  // Item operations
  addItem,
  getItem,
  updateItem,
  deleteItem,
  hardDeleteItem,
  queryItems,
  tagItem,
  untagItem,
  getItemTags,
  getItemsByTag,
  // Item visit operations (URL history unification)
  recordItemVisit,
  getItemVisits,
  queryItemVisits,
  trackNavigation,
  queryItemsByFrecency,
  // Item event operations (series & feeds)
  addItemEvent,
  getItemEvent,
  queryItemEvents,
  deleteItemEvent,
  deleteItemEvents,
  getLatestItemEvent,
  countItemEvents,
  // History operations
  trackWindowLoad,
  getHistory,
  // Context operations
  addContextEntry,
  getContextEntry,
  queryContextHistory,
  getContextSnapshot,
  cleanupWindowContext,
  getWindowsWithContextValue,
  getWindowsMatchingContext,
} from './datastore.js';

import {
  loadExtensionManifest,
} from './extensions.js';

import type { Profile } from './profiles.js';
import {
  listProfiles,
  createProfile,
  getProfileByFolder,
  deleteProfile,
  getActiveProfile,
  setActiveProfile,
  enableSync,
  disableSync,
  getSyncConfig as getProfileSyncConfig,
  updateLastSyncTime,
} from './profiles.js';

import {
  getExtensionPath,
  getRegisteredThemeIds,
  getThemePath,
  getActiveThemeId,
  setActiveThemeId,
} from './protocol.js';

import {
  createExtensionWindow,
  destroyExtensionWindow,
  getExtensionWindow,
  getExtensionHostWindow,
  isConsolidatedExtension,
  getRunningExtensions,
  reloadExtension,
  registerWindow,
  getWindowInfo,
  removeWindow,
  findWindowByKey,
  getAllWindows,
} from './main.js';

import {
  APP_DEF_WIDTH,
  APP_DEF_HEIGHT,
  getPreloadPath,
  IPC_CHANNELS,
  isHeadless,
  isTestProfile,
  DEBUG,
} from './config.js';

import {
  addEscHandler,
  winDevtoolsConfig,
  closeOrHideWindow,
  updateDockVisibility,
  closeWindow,
  modWindow,
  getSystemThemeBackgroundColor,
  getPrefs,
} from './windows.js';

import {
  registerGlobalShortcut,
  unregisterGlobalShortcut,
  registerLocalShortcut,
  unregisterLocalShortcut,
} from './shortcuts.js';

import {
  publish,
  subscribe,
  scopes as PubSubScopes,
  getSystemAddress,
} from './pubsub.js';

import {
  getSyncConfig,
  setSyncConfig,
  pullFromServer,
  pushToServer,
  syncAll,
  getSyncStatus,
} from './sync.js';

import {
  getBackupConfig,
  setBackupConfig,
  createBackup,
  listBackups,
} from './backup.js';

import {
  detectModeFromUrl,
  type MajorModeId,
} from './datastore.js';

import {
  getProfileSession,
} from './session-partition.js';

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
//   - get-window-id: Returns the calling window's ID
//   - get-focused-visible-window-id: Returns lastFocusedVisibleWindowId
// ============================================================================

// Track the last focused content window (for devtools command)
// Content windows are those with http/https URLs (not peek:// internal pages)
let lastContentWindowId: number | null = null;

// Track the last focused visible window (for per-window commands)
// This includes extension windows (peek://{extId}/...) and web pages,
// but excludes internal background windows and modal windows
let lastFocusedVisibleWindowId: number | null = null;

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
 */
function trackVisibleWindowFocus(win: BrowserWindow): void {
  const url = win.webContents.getURL();
  // Exclude internal background windows
  if (url === 'peek://app/background.html' || url === 'peek://app/extension-host.html') {
    return;
  }
  // Track extension windows (peek://{id}/...) and web pages
  lastFocusedVisibleWindowId = win.id;
  DEBUG && console.log('Updated lastFocusedVisibleWindowId:', lastFocusedVisibleWindowId, url);
}

/**
 * Register datastore IPC handlers
 */
export function registerDatastoreHandlers(): void {
  ipcMain.handle('datastore-add-address', async (ev, data) => {
    try {
      const result = addAddress(data.uri, data.options);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-get-address', async (ev, data) => {
    try {
      const result = getAddress(data.id);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-update-address', async (ev, data) => {
    try {
      const result = updateAddress(data.id, data.updates);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-query-addresses', async (ev, data) => {
    try {
      const result = queryAddresses(data.filter);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-add-visit', async (ev, data) => {
    try {
      const result = addVisit(data.addressId, data.options);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-query-visits', async (ev, data) => {
    try {
      const result = queryVisits(data.filter);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-add-content', async (ev, data) => {
    try {
      const result = addContent(data.options);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-query-content', async (ev, data) => {
    try {
      const result = queryContent(data.filter);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-get-table', async (ev, data) => {
    try {
      const tableName = data.tableName || data.table;
      if (!isValidTable(tableName)) {
        return { success: false, error: `Invalid table: ${tableName}` };
      }
      const result = getTable(tableName);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-set-row', async (ev, data) => {
    try {
      const tableName = data.tableName || data.table;
      const rowId = data.rowId || data.id;
      const rowData = data.rowData || data.row;
      if (!isValidTable(tableName)) {
        return { success: false, error: `Invalid table: ${tableName}` };
      }
      const result = setRow(tableName, rowId, rowData);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-get-row', async (ev, data) => {
    try {
      const tableName = data.tableName || data.table;
      const rowId = data.rowId || data.id;
      if (!isValidTable(tableName)) {
        return { success: false, error: `Invalid table: ${tableName}` };
      }
      const result = getRow(tableName, rowId);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-get-stats', async () => {
    try {
      const result = getStats();
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Tag operations
  ipcMain.handle('datastore-get-or-create-tag', async (ev, data) => {
    try {
      const result = getOrCreateTag(data.name);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-tag-address', async (ev, data) => {
    try {
      const result = tagAddress(data.addressId, data.tagId);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-untag-address', async (ev, data) => {
    try {
      const result = untagAddress(data.addressId, data.tagId);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-get-tags-by-frecency', async (ev, data = {}) => {
    try {
      const result = getTagsByFrecency(data.limit);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-get-address-tags', async (ev, data) => {
    try {
      const result = getAddressTags(data.addressId);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-get-addresses-by-tag', async (ev, data) => {
    try {
      const result = getAddressesByTag(data.tagId);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-get-untagged-addresses', async (ev, data) => {
    try {
      const result = getUntaggedAddresses();
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Item operations (mobile-style lightweight content)
  ipcMain.handle('datastore-add-item', async (ev, data) => {
    try {
      const result = addItem(data.type, data.options);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-get-item', async (ev, data) => {
    try {
      const result = getItem(data.id);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-update-item', async (ev, data) => {
    try {
      const result = updateItem(data.id, data.options);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-delete-item', async (ev, data) => {
    try {
      const result = deleteItem(data.id);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-hard-delete-item', async (ev, data) => {
    try {
      const result = hardDeleteItem(data.id);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-query-items', async (ev, data = {}) => {
    try {
      const result = queryItems(data.filter);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-tag-item', async (ev, data) => {
    try {
      const result = tagItem(data.itemId, data.tagId);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-untag-item', async (ev, data) => {
    try {
      const result = untagItem(data.itemId, data.tagId);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-get-item-tags', async (ev, data) => {
    try {
      const result = getItemTags(data.itemId);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-get-items-by-tag', async (ev, data) => {
    try {
      const result = getItemsByTag(data.tagId);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // History operations (visits joined with addresses)
  ipcMain.handle('datastore-get-history', async (ev, data = {}) => {
    try {
      const result = getHistory(data.filter);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Item visit operations (URL history unification)
  ipcMain.handle('datastore-record-item-visit', async (ev, data) => {
    try {
      const result = recordItemVisit(data.itemId, data.options);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-get-item-visits', async (ev, data) => {
    try {
      const result = getItemVisits(data.itemId, data.filter);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-query-item-visits', async (ev, data = {}) => {
    try {
      const result = queryItemVisits(data.filter);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-track-navigation', async (ev, data) => {
    try {
      const result = trackNavigation(data.uri, data.options);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-query-items-by-frecency', async (ev, data = {}) => {
    try {
      const result = queryItemsByFrecency(data.filter);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Item event operations (series & feeds)
  ipcMain.handle('datastore-add-item-event', async (ev, data) => {
    try {
      const result = addItemEvent(data.itemId, data.options);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-get-item-event', async (ev, data) => {
    try {
      const result = getItemEvent(data.eventId);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-query-item-events', async (ev, data = {}) => {
    try {
      const result = queryItemEvents(data.filter);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-delete-item-event', async (ev, data) => {
    try {
      const result = deleteItemEvent(data.eventId);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-delete-item-events', async (ev, data) => {
    try {
      const result = deleteItemEvents(data.itemId);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-get-latest-item-event', async (ev, data) => {
    try {
      const result = getLatestItemEvent(data.itemId);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-count-item-events', async (ev, data) => {
    try {
      const result = countItemEvents(data.itemId, data.filter);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });
}

/**
 * Register extension IPC handlers
 */
export function registerExtensionHandlers(): void {
  ipcMain.handle('extension-pick-folder', async (ev) => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory']
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: 'No folder selected' };
      }
      return { success: true, data: { path: result.filePaths[0] } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('extension-validate-folder', async (ev, data) => {
    try {
      const extPath = data.folderPath || data.path;
      const manifestPath = path.join(extPath, 'manifest.json');

      if (!fs.existsSync(manifestPath)) {
        return { success: false, error: 'No manifest.json found in folder' };
      }

      const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent);

      if (!manifest.id && !manifest.shortname && !manifest.name) {
        return { success: false, error: 'Manifest must have id, shortname, or name' };
      }

      // Check for background.html
      const backgroundPath = path.join(extPath, 'background.html');
      if (!fs.existsSync(backgroundPath)) {
        return { success: false, error: 'No background.html found in folder' };
      }

      return {
        success: true,
        data: {
          manifest,
          path: extPath
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('extension-add', async (ev, data) => {
    try {
      const db = getDb();
      const extPath = data.folderPath || data.path;
      const manifestPath = path.join(extPath, 'manifest.json');

      if (!fs.existsSync(manifestPath)) {
        return { success: false, error: 'No manifest.json found' };
      }

      const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent);
      const id = manifest.id || manifest.shortname || manifest.name || `ext_${Date.now()}`;

      // Check if already exists
      const existing = db.prepare('SELECT * FROM extensions WHERE id = ?').get(id);
      if (existing) {
        return { success: false, error: `Extension ${id} already installed` };
      }

      // Get lastError if provided
      const lastError = data.lastError || '';
      const lastErrorAt = lastError ? Date.now() : 0;

      // Insert into database
      db.prepare(`
        INSERT INTO extensions (id, name, description, version, path, enabled, builtin, status, installedAt, updatedAt, metadata, lastError, lastErrorAt)
        VALUES (?, ?, ?, ?, ?, 1, 0, 'installed', ?, ?, ?, ?, ?)
      `).run(
        id,
        manifest.name || id,
        manifest.description || '',
        manifest.version || '0.0.0',
        extPath,
        Date.now(),
        Date.now(),
        JSON.stringify(manifest),
        lastError,
        lastErrorAt
      );

      return { success: true, data: { id, manifest, path: extPath, lastError: lastError || null } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('extension-remove', async (ev, data) => {
    try {
      const db = getDb();
      const extId = data.id;

      // Check if exists
      const existing = db.prepare('SELECT * FROM extensions WHERE id = ?').get(extId);
      if (!existing) {
        return { success: false, error: `Extension ${extId} not found` };
      }

      // Unload if running
      destroyExtensionWindow(extId);

      // Remove from database
      db.prepare('DELETE FROM extensions WHERE id = ?').run(extId);
      db.prepare('DELETE FROM extension_settings WHERE extensionId = ?').run(extId);

      return { success: true, data: { id: extId } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('extension-update', async (ev, data) => {
    try {
      const db = getDb();
      const extId = data.id;
      const updates = data.updates || {};

      const existing = db.prepare('SELECT * FROM extensions WHERE id = ?').get(extId);
      if (!existing) {
        return { success: false, error: `Extension ${extId} not found` };
      }

      const fields: string[] = [];
      const values: unknown[] = [];

      if (updates.enabled !== undefined) {
        fields.push('enabled = ?');
        values.push(updates.enabled ? 1 : 0);
      }
      if (updates.status !== undefined) {
        fields.push('status = ?');
        values.push(updates.status);
      }
      if (updates.lastError !== undefined) {
        fields.push('lastError = ?');
        values.push(updates.lastError);
      }
      if (updates.lastErrorAt !== undefined) {
        fields.push('lastErrorAt = ?');
        values.push(updates.lastErrorAt);
      }

      if (fields.length > 0) {
        fields.push('updatedAt = ?');
        values.push(Date.now());
        values.push(extId);
        db.prepare(`UPDATE extensions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      }

      const updated = db.prepare('SELECT * FROM extensions WHERE id = ?').get(extId);
      return { success: true, data: updated };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('extension-get-all', async () => {
    try {
      const db = getDb();
      const extensions = db.prepare('SELECT * FROM extensions').all();
      return { success: true, data: extensions };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('extension-get', async (ev, data) => {
    try {
      const db = getDb();
      const ext = db.prepare('SELECT * FROM extensions WHERE id = ?').get(data.id);
      if (!ext) {
        return { success: false, error: `Extension ${data.id} not found` };
      }
      return { success: true, data: ext };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('extension-window-load', async (ev, data) => {
    try {
      const extId = data.id;
      const win = await createExtensionWindow(extId);
      if (!win) {
        return { success: false, error: `Failed to load extension ${extId}` };
      }
      return { success: true, data: { id: extId, windowId: win.id } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('extension-window-unload', async (ev, data) => {
    try {
      const extId = data.id;
      const result = destroyExtensionWindow(extId);
      return { success: result, data: { id: extId } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('extension-window-reload', async (ev, data) => {
    try {
      const extId = data.id;
      destroyExtensionWindow(extId);
      // Small delay before reload
      await new Promise(resolve => setTimeout(resolve, 100));
      const win = await createExtensionWindow(extId);
      if (!win) {
        return { success: false, error: `Failed to reload extension ${extId}` };
      }
      return { success: true, data: { id: extId, windowId: win.id } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('extension-window-list', async () => {
    try {
      const running = getRunningExtensions();
      return { success: true, data: running };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('extension-window-devtools', async (ev, data) => {
    try {
      const extId = data.id;

      // Consolidated extensions run in the extension host window
      if (isConsolidatedExtension(extId)) {
        const hostWin = getExtensionHostWindow();
        if (!hostWin || hostWin.isDestroyed()) {
          return { success: false, error: 'Extension host is not running' };
        }
        hostWin.webContents.openDevTools({ mode: 'detach' });
        return { success: true, data: { id: extId, isConsolidated: true } };
      }

      // External extensions have their own windows
      const win = getExtensionWindow(extId);
      if (!win) {
        return { success: false, error: `Extension ${extId} is not running` };
      }
      win.webContents.openDevTools({ mode: 'detach' });
      return { success: true, data: { id: extId } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Reload an extension (destroy window and recreate)
  ipcMain.handle('extension-reload', async (ev, data) => {
    try {
      const extId = data.id;
      if (!extId) {
        return { success: false, error: 'Missing extension id' };
      }

      const win = await reloadExtension(extId);
      if (!win) {
        return { success: false, error: `Failed to reload extension: ${extId}` };
      }

      return { success: true, data: { id: extId } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Extension settings handlers
  // Note: preload sends { extId } but we accept both extId and id for compatibility
  ipcMain.handle('extension-settings-get', async (ev, data) => {
    try {
      const db = getDb();
      const extId = data.extId || data.id;
      const settings = db.prepare(
        'SELECT * FROM extension_settings WHERE extensionId = ?'
      ).all(extId) as Array<{ key: string; value: string }>;

      const result: Record<string, unknown> = {};
      for (const s of settings) {
        try {
          result[s.key] = JSON.parse(s.value);
        } catch {
          result[s.key] = s.value;
        }
      }
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('extension-settings-set', async (ev, data) => {
    try {
      const db = getDb();
      const extId = data.extId || data.id;
      const settings = data.settings || {};

      for (const [key, value] of Object.entries(settings)) {
        const jsonValue = JSON.stringify(value);
        db.prepare(`
          INSERT OR REPLACE INTO extension_settings (id, extensionId, key, value, updatedAt)
          VALUES (?, ?, ?, ?, ?)
        `).run(`${extId}_${key}`, extId, key, jsonValue, Date.now());
      }

      return { success: true, data: settings };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('extension-settings-get-key', async (ev, data) => {
    try {
      const db = getDb();
      const extId = data.extId || data.id;
      const setting = db.prepare(
        'SELECT * FROM extension_settings WHERE extensionId = ? AND key = ?'
      ).get(extId, data.key) as { value: string } | undefined;

      if (!setting) {
        return { success: true, data: null };
      }

      try {
        return { success: true, data: JSON.parse(setting.value) };
      } catch {
        return { success: true, data: setting.value };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('extension-settings-set-key', async (ev, data) => {
    try {
      const db = getDb();
      const extId = data.extId || data.id;
      const jsonValue = JSON.stringify(data.value);
      db.prepare(`
        INSERT OR REPLACE INTO extension_settings (id, extensionId, key, value, updatedAt)
        VALUES (?, ?, ?, ?, ?)
      `).run(`${extId}_${data.key}`, extId, data.key, jsonValue, Date.now());

      return { success: true, data: { key: data.key, value: data.value } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('extension-manifest-get', async (ev, data) => {
    try {
      const extPath = getExtensionPath(data.id);
      if (!extPath) {
        // Check database for external extensions
        const db = getDb();
        const ext = db.prepare('SELECT * FROM extensions WHERE id = ?').get(data.id) as { path?: string } | undefined;
        if (!ext || !ext.path) {
          return { success: false, error: `Extension ${data.id} not found` };
        }
        const manifest = loadExtensionManifest(ext.path);
        return { success: true, data: manifest };
      }
      const manifest = loadExtensionManifest(extPath);
      return { success: true, data: manifest };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('extension-settings-schema', async (ev, data) => {
    try {
      const extPath = getExtensionPath(data.id);
      if (!extPath) {
        return { success: false, error: `Extension ${data.id} not found` };
      }

      const manifest = loadExtensionManifest(extPath);
      if (!manifest || !manifest.settingsSchema) {
        return { success: true, data: null };
      }

      const schemaPath = path.join(extPath, manifest.settingsSchema);
      if (!fs.existsSync(schemaPath)) {
        return { success: true, data: null };
      }

      const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
      const schema = JSON.parse(schemaContent);
      return { success: true, data: schema };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });
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
      'SELECT value FROM extension_settings WHERE extensionId = ? AND key = ?'
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
    INSERT OR REPLACE INTO extension_settings (id, extensionId, key, value, updatedAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(`${THEME_SETTINGS_KEY}_${key}`, THEME_SETTINGS_KEY, key, JSON.stringify(value), timestamp);
}

/**
 * Broadcast theme change to all windows
 */
function broadcastThemeChange(colorScheme: string): void {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send('theme:changed', { colorScheme });
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
  // Get current theme settings
  ipcMain.handle('theme:get', () => {
    const themeId = getThemeSetting(THEME_ID_KEY) || getActiveThemeId();
    const colorScheme = getThemeSetting(THEME_COLOR_SCHEME_KEY) || 'system';
    const isDark = nativeTheme.shouldUseDarkColors;

    return {
      themeId,
      colorScheme,
      isDark,
      effectiveScheme: colorScheme === 'system' ? (isDark ? 'dark' : 'light') : colorScheme
    };
  });

  // Set color scheme preference (system/light/dark)
  ipcMain.handle('theme:setColorScheme', (_ev, colorScheme: string) => {
    if (!['system', 'light', 'dark'].includes(colorScheme)) {
      return { success: false, error: 'Invalid color scheme' };
    }

    setThemeSetting(THEME_COLOR_SCHEME_KEY, colorScheme);

    // Update nativeTheme to match (affects new windows)
    nativeTheme.themeSource = colorScheme as 'system' | 'light' | 'dark';

    // Broadcast to all windows
    broadcastThemeChange(colorScheme);

    return {
      success: true,
      colorScheme,
      effectiveScheme: colorScheme === 'system'
        ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
        : colorScheme
    };
  });

  // Set color scheme for a specific window only (doesn't affect global setting)
  ipcMain.handle('theme:setWindowColorScheme', (_ev, { windowId, colorScheme }: { windowId: number; colorScheme: string }) => {
    if (!['system', 'light', 'dark', 'global'].includes(colorScheme)) {
      return { success: false, error: 'Invalid color scheme' };
    }

    const win = BrowserWindow.fromId(windowId);
    if (!win || win.isDestroyed()) {
      return { success: false, error: 'Window not found' };
    }

    // Send to specific window only
    win.webContents.send('theme:windowChanged', { colorScheme });

    return { success: true, windowId, colorScheme };
  });

  // Set active theme
  ipcMain.handle('theme:setTheme', (_ev, themeId: string) => {
    if (!setActiveThemeId(themeId)) {
      return { success: false, error: 'Theme not found' };
    }
    setThemeSetting(THEME_ID_KEY, themeId);

    // Broadcast to all windows to reload their CSS
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.webContents.send('theme:themeChanged', { themeId });
    }

    return { success: true, themeId };
  });

  // List available themes
  ipcMain.handle('theme:list', () => {
    const themeIds = getRegisteredThemeIds();
    const themes = themeIds.map(id => {
      const themePath = getThemePath(id);
      if (!themePath) return null;

      try {
        const manifestPath = path.join(themePath, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        return {
          id: manifest.id || id,
          name: manifest.name || id,
          version: manifest.version || '1.0.0',
          description: manifest.description || '',
          colorSchemes: manifest.colorSchemes || ['light', 'dark'],
        };
      } catch {
        return { id, name: id, version: '1.0.0', description: '', colorSchemes: ['light', 'dark'] };
      }
    }).filter(Boolean);

    return { themes };
  });

  // Listen for system theme changes
  nativeTheme.on('updated', () => {
    const colorScheme = getThemeSetting(THEME_COLOR_SCHEME_KEY) || 'system';
    if (colorScheme === 'system') {
      broadcastThemeChange('system');
    }
  });

  // ===== Theme management (add/remove/reload) =====

  // Open folder picker for themes
  ipcMain.handle('theme:pickFolder', async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory']
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }
      return { success: true, data: { path: result.filePaths[0] } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Validate a theme folder
  ipcMain.handle('theme:validateFolder', async (_ev, data) => {
    try {
      const themePath = data.folderPath || data.path;
      const manifestPath = path.join(themePath, 'manifest.json');

      if (!fs.existsSync(manifestPath)) {
        return { success: false, error: 'No manifest.json found in folder' };
      }

      const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent);

      if (!manifest.id && !manifest.name) {
        return { success: false, error: 'Manifest must have id or name' };
      }

      // Check for variables.css (or whatever the manifest points to)
      const variablesFile = manifest.variables || 'variables.css';
      const variablesPath = path.join(themePath, variablesFile);
      if (!fs.existsSync(variablesPath)) {
        return { success: false, error: `Theme CSS file not found: ${variablesFile}` };
      }

      return {
        success: true,
        data: {
          manifest,
          path: themePath
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Add a theme
  ipcMain.handle('theme:add', async (_ev, data) => {
    try {
      const db = getDb();
      const themePath = data.folderPath || data.path;
      const manifestPath = path.join(themePath, 'manifest.json');

      if (!fs.existsSync(manifestPath)) {
        return { success: false, error: 'No manifest.json found' };
      }

      const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent);
      const id = manifest.id || manifest.name || `theme_${Date.now()}`;

      // Check if already exists
      const existing = db.prepare('SELECT * FROM themes WHERE id = ?').get(id);
      if (existing) {
        return { success: false, error: `Theme ${id} already installed` };
      }

      const lastError = data.lastError || '';
      const lastErrorAt = lastError ? Date.now() : 0;

      // Insert into database
      db.prepare(`
        INSERT INTO themes (id, name, description, version, author, path, builtin, enabled, installedAt, updatedAt, lastError, lastErrorAt, metadata)
        VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?)
      `).run(
        id,
        manifest.name || id,
        manifest.description || '',
        manifest.version || '1.0.0',
        manifest.author || '',
        themePath,
        Date.now(),
        Date.now(),
        lastError,
        lastErrorAt,
        JSON.stringify(manifest)
      );

      // Register the theme path so it's available via peek://theme/
      const { registerThemePath } = await import('./protocol.js');
      registerThemePath(id, themePath);

      return { success: true, data: { id, manifest, path: themePath, lastError: lastError || null } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Remove a theme
  ipcMain.handle('theme:remove', async (_ev, data) => {
    try {
      const db = getDb();
      const themeId = data.id;

      // Check if exists
      const existing = db.prepare('SELECT * FROM themes WHERE id = ?').get(themeId) as { builtin?: number } | undefined;
      if (!existing) {
        return { success: false, error: `Theme ${themeId} not found` };
      }

      // Don't allow removing builtin themes
      if (existing.builtin === 1) {
        return { success: false, error: 'Cannot remove built-in theme' };
      }

      // Remove from database
      db.prepare('DELETE FROM themes WHERE id = ?').run(themeId);

      return { success: true, data: { id: themeId } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Get all themes (builtin + external)
  ipcMain.handle('theme:getAll', async () => {
    try {
      const db = getDb();

      // Get builtin themes from registry
      const builtinIds = getRegisteredThemeIds();
      const themes: Array<{
        id: string;
        name: string;
        description: string;
        version: string;
        author: string;
        path: string;
        builtin: boolean;
        colorSchemes: string[];
      }> = [];

      // Add builtin themes
      for (const id of builtinIds) {
        const themePath = getThemePath(id);
        if (!themePath) continue;

        try {
          const manifestPath = path.join(themePath, 'manifest.json');
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          themes.push({
            id: manifest.id || id,
            name: manifest.name || id,
            description: manifest.description || '',
            version: manifest.version || '1.0.0',
            author: manifest.author || '',
            path: themePath,
            builtin: true,
            colorSchemes: manifest.colorSchemes || ['light', 'dark'],
          });
        } catch {
          themes.push({
            id,
            name: id,
            description: '',
            version: '1.0.0',
            author: '',
            path: themePath,
            builtin: true,
            colorSchemes: ['light', 'dark'],
          });
        }
      }

      // Add external themes from database
      const externalThemes = db.prepare('SELECT * FROM themes WHERE builtin = 0').all() as Array<{
        id: string;
        name: string;
        description: string;
        version: string;
        author: string;
        path: string;
        metadata?: string;
      }>;

      for (const ext of externalThemes) {
        let colorSchemes = ['light', 'dark'];
        try {
          const metadata = JSON.parse(ext.metadata || '{}');
          colorSchemes = metadata.colorSchemes || colorSchemes;
        } catch { /* ignore */ }

        themes.push({
          id: ext.id,
          name: ext.name,
          description: ext.description,
          version: ext.version,
          author: ext.author,
          path: ext.path,
          builtin: false,
          colorSchemes,
        });
      }

      return { success: true, data: themes };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Reload a theme (re-read manifest, notify windows)
  ipcMain.handle('theme:reload', async (_ev, data) => {
    try {
      const themeId = data.id;
      const themePath = getThemePath(themeId);
      if (!themePath) {
        return { success: false, error: 'Theme not found' };
      }

      // Broadcast to all windows to reload their CSS
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        win.webContents.send('theme:reload', { themeId });
      }

      return { success: true, data: { id: themeId } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });
}

// Keep old function name for compatibility but call new one
export function registerDarkModeHandlers(): void {
  registerThemeHandlers();
}

/**
 * Register window management IPC handlers
 */
export function registerWindowHandlers(): void {
  ipcMain.handle('window-open', async (ev, msg) => {
    DEBUG && console.log('window-open', msg);

    const { url, options } = msg;

    // IMPORTANT: Determine transient state BEFORE creating the window
    // A window is transient if opened when no Peek window was focused (e.g., via global hotkey)
    // This must be checked before window creation because the new window will become focused
    const focusedWindowBeforeCreate = BrowserWindow.getFocusedWindow();
    const isTransient = !focusedWindowBeforeCreate || focusedWindowBeforeCreate.isDestroyed();
    DEBUG && console.log('Transient detection:', { isTransient, focusedWindowId: focusedWindowBeforeCreate?.id });

    // Check if window with this key already exists
    if (options.key) {
      const existingWindow = findWindowByKey(msg.source, options.key);
      if (existingWindow) {
        DEBUG && console.log('Reusing existing window with key:', options.key);
        if (!isHeadless()) {
          existingWindow.window.show();
        }
        return { success: true, id: existingWindow.id, reused: true };
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
    const isWebPage = url.startsWith('http://') || url.startsWith('https://');

    // Use profile-specific session for isolation
    const profileSession = getProfileSession();

    // Prepare browser window options
    const winOptions: Electron.BrowserWindowConstructorOptions = {
      frame: isWebPage ? false : frameDefault, // Web pages use transparent canvas, no frame
      ...options,
      width: parseInt(options.width) || APP_DEF_WIDTH,
      height: parseInt(options.height) || APP_DEF_HEIGHT,
      show: isHeadless() ? false : options.show !== false,
      // Web pages use transparent fullscreen canvas
      transparent: isWebPage ? true : (options.transparent || false),
      backgroundColor: (isWebPage || options.transparent) ? undefined : getSystemThemeBackgroundColor(),
      webPreferences: {
        ...options.webPreferences,
        preload: getPreloadPath(),
        session: profileSession,
        webviewTag: true // Enable webview for peek://page container
      }
    };

    // Load saved window state if persistState is enabled and window has a key
    let savedState: { x?: number; y?: number; width?: number; height?: number } | null = null;
    if (options.key && (options.persistState === true || getPrefs().persistWindowState)) {
      try {
        const rowId = `window_state:${options.key}`;
        const row = getRow('extension_settings', rowId);
        if (row && row.value) {
          savedState = JSON.parse(row.value as string);
          DEBUG && console.log('Loaded saved window state for key:', options.key, savedState);
        }
      } catch (e) {
        DEBUG && console.log('Failed to load window state:', e);
      }
    }

    // Apply saved state or explicit position parameters
    if (savedState) {
      if (savedState.x !== undefined) winOptions.x = savedState.x;
      if (savedState.y !== undefined) winOptions.y = savedState.y;
      if (savedState.width !== undefined) winOptions.width = savedState.width;
      if (savedState.height !== undefined) winOptions.height = savedState.height;
    }
    // Explicit options override saved state
    if (options.x !== undefined) {
      winOptions.x = parseInt(options.x);
    }
    if (options.y !== undefined) {
      winOptions.y = parseInt(options.y);
    }

    if (options.modal === true) {
      // Use panel type on macOS to improve focus restoration when closed
      if (process.platform === 'darwin') {
        winOptions.type = 'panel';
      }
    }

    // Set parent window if parentId is provided
    if (options.parentId) {
      const parentWin = BrowserWindow.fromId(options.parentId);
      if (parentWin && !parentWin.isDestroyed()) {
        winOptions.parent = parentWin;
      }
    }

    DEBUG && console.log('Creating window with options:', winOptions);

    // Create new window
    const win = new BrowserWindow(winOptions);

    // Forward console logs from window to main process stdout (for debugging)
    win.webContents.on('console-message', (event) => {
      // Only forward for peek:// URLs to avoid noise
      if (url.startsWith('peek://')) {
        DEBUG && console.log(`[${url.replace('peek://', '')}] ${event.message}`);
      }
    });

    try {
      // Route http/https URLs through peek://page container
      // This allows IZUI to manage web pages uniformly
      let loadUrl = url;
      if (isWebPage) {
        // Pass position/size to the page container so it can position the webview
        const pageParams = new URLSearchParams({
          url: url,
          x: String(winOptions.x ?? 100),
          y: String(winOptions.y ?? 100),
          width: String(winOptions.width ?? APP_DEF_WIDTH),
          height: String(winOptions.height ?? APP_DEF_HEIGHT),
        });
        loadUrl = `peek://app/page/index.html?${pageParams.toString()}`;
        DEBUG && console.log('Routing web page through peek://app/page:', url, '->', loadUrl);

        // Make the container window fullscreen and transparent
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
        win.setSize(screenWidth, screenHeight);
        win.setPosition(0, 0);
        win.setBackgroundColor('#00000000'); // Fully transparent
      }

      await win.loadURL(loadUrl);

      // Add to window manager with modal parameter
      // Note: isTransient was determined BEFORE window creation (at top of handler)
      // to avoid the race condition where the new window becomes focused before we check
      const windowParams = {
        ...options,
        address: url,
        transient: isTransient
      };
      DEBUG && console.log('Adding window to manager:', win.id, 'modal:', windowParams.modal, 'keepLive:', windowParams.keepLive, 'transient:', isTransient);
      registerWindow(win.id, msg.source, windowParams);

      // Set window mode based on URL
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

      // Check for group mode inheritance from options
      // If opener passed groupMode, inherit it instead of URL-based detection
      if (options.groupMode) {
        const { groupId, groupName, color } = options.groupMode;
        // Set group mode via context API
        addContextEntry('mode', 'group', {
          windowId: win.id,
          source: msg.source,
          metadata: { groupId, groupName, color, url: modeUrl }
        });
        DEBUG && console.log('Inherited group mode for window:', win.id, 'group:', groupName);
      } else {
        // Check if opener is in group mode - inherit if so
        let openerGroupMode = null;
        const callingWin = BrowserWindow.fromWebContents(ev.sender);
        if (callingWin && !callingWin.isDestroyed()) {
          const openerContext = getContextEntry('mode', callingWin.id);
          if (openerContext && openerContext.value === 'group' && openerContext.metadata) {
            openerGroupMode = openerContext;
          }
        }

        if (openerGroupMode) {
          // Inherit group mode from opener
          addContextEntry('mode', 'group', {
            windowId: win.id,
            source: msg.source,
            metadata: {
              ...openerGroupMode.metadata,
              url: modeUrl,
              inheritedFrom: openerGroupMode.windowId
            }
          });
          DEBUG && console.log('Inherited group mode from opener:', openerGroupMode.metadata?.groupName);
        } else {
          // Set mode based on URL detection (original behavior)
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

      // Track this load in history (skip internal peek:// URLs)
      if (!url.startsWith('peek://')) {
        try {
          trackWindowLoad(url, {
            source: options.trackingSource || options.feature || 'window',
            sourceId: options.trackingSourceId || '',
            windowType: options.modal ? 'modal' : 'main',
            title: options.title || win.getTitle() || '',
          });
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
        try {
          trackWindowLoad(navUrl, {
            source: 'navigation',
            sourceId: '',
            windowType: options.modal ? 'modal' : 'main',
            title: win.getTitle() || '',
          });
        } catch (e) {
          DEBUG && console.log('Failed to track did-navigate:', e);
        }
      });

      // Track JS window.open() from web content windows
      if (url.startsWith('http://') || url.startsWith('https://')) {
        win.webContents.setWindowOpenHandler((details: Electron.HandlerDetails) => {
          // Track the URL that JS is trying to open
          try {
            trackWindowLoad(details.url, {
              source: 'window-open',
              sourceId: url,
              windowType: 'main',
            });
          } catch (e) {
            DEBUG && console.log('Failed to track setWindowOpenHandler:', e);
          }
          return { action: 'allow' };
        });
      }

      // Add escape key handler to all windows
      addEscHandler(win);

      // Add Cmd+L shortcut for web pages to show nav bar
      // Web pages are now loaded inside peek://page container which handles nav
      if (url.startsWith('http://') || url.startsWith('https://')) {
        win.webContents.on('before-input-event', (event, input) => {
          if (input.type !== 'keyDown' || !input.meta) return;
          if (input.key === 'l') {
            // Show the page container's nav bar
            publish('peek://system/', PubSubScopes.GLOBAL, 'page:show-navbar', { windowId: win.id });
            event.preventDefault();
          }
        });
      }

      // Track content window focus for devtools command
      win.on('focus', () => {
        trackContentWindowFocus(win);
        // Only track non-modal windows for visible window targeting
        // Modal windows (like cmd palette) shouldn't override the target window
        const winInfo = getWindowInfo(win.id);
        if (!winInfo?.params?.modal) {
          trackVisibleWindowFocus(win);
        }
      });
      // Also track immediately if this is a content/visible window (non-modal only)
      trackContentWindowFocus(win);
      if (!options.modal) {
        trackVisibleWindowFocus(win);
      }

      // Set up window state persistence if enabled
      const shouldPersist = options.key && (options.persistState === true || getPrefs().persistWindowState);
      if (shouldPersist) {
        // Debounce timer for saving state
        let saveTimer: NodeJS.Timeout | null = null;
        const saveState = () => {
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = setTimeout(() => {
            if (win.isDestroyed()) return;
            const bounds = win.getBounds();
            const rowId = `window_state:${options.key}`;
            const data = {
              extensionId: 'window_state',
              key: options.key,
              value: JSON.stringify({
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height
              }),
              updatedAt: Date.now()
            };
            setRow('extension_settings', rowId, data);
            DEBUG && console.log('Saved window state for key:', options.key, bounds);
          }, 500); // Debounce 500ms
        };

        win.on('move', saveState);
        win.on('resize', saveState);
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
      // are still settling after window creation (can cause immediate close)
      if (options.modal === true) {
        setTimeout(() => {
          if (!win.isDestroyed()) {
            win.on('blur', () => {
              DEBUG && console.log('window-open: blur for modal window', url);
              closeOrHideWindow(win.id);
            });
          }
        }, 100);
      }

      // Maximize window if requested (fills screen without OS fullscreen)
      // Use explicit bounds instead of win.maximize() because panel-type windows
      // on macOS don't respond to maximize() properly
      if (options.maximize === true && !isHeadless()) {
        const display = screen.getPrimaryDisplay();
        const { width, height } = display.workAreaSize;
        win.setBounds({ x: 0, y: 0, width, height });
      }

      // Handle overlay mode: hide other windows after this one is ready
      // When overlay window closes, the hidden windows will be restored (see main.ts)
      if (options.overlay === true) {
        const hiddenWindowIds: number[] = [];
        const allWindows = BrowserWindow.getAllWindows();
        for (const otherWin of allWindows) {
          if (otherWin.id === win.id) continue;
          if (otherWin.isDestroyed()) continue;
          if (!otherWin.isVisible()) continue;
          // Don't hide background windows (check by URL or params)
          const otherInfo = getWindowInfo(otherWin.id);
          const otherAddress = otherInfo?.params?.address as string | undefined;
          if (otherAddress?.includes('background.html')) continue;
          if (otherAddress?.includes('extension-host.html')) continue;
          // Hide and track
          otherWin.hide();
          hiddenWindowIds.push(otherWin.id);
        }
        DEBUG && console.log('Overlay mode: hidden', hiddenWindowIds.length, 'windows');
        // Store hidden window IDs in the window's params for restore on close
        const winInfo = getWindowInfo(win.id);
        if (winInfo) {
          winInfo.params.overlayHiddenWindows = hiddenWindowIds;
        }
      }

      // Show dock when window opens
      updateDockVisibility();

      return { success: true, id: win.id };
    } catch (error) {
      console.error('Failed to open window:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Toggle click-through on transparent windows
  ipcMain.handle('window-set-ignore-mouse-events', (ev, msg) => {
    const win = msg?.id ? BrowserWindow.fromId(msg.id) : BrowserWindow.fromWebContents(ev.sender);
    if (!win || win.isDestroyed()) return { success: false };
    win.setIgnoreMouseEvents(msg.ignore, msg.forward ? { forward: true } : undefined);
    return { success: true };
  });

  // Return full bounds (position + size) for any window
  ipcMain.handle('window-get-bounds', (ev, msg) => {
    const win = msg?.id ? BrowserWindow.fromId(msg.id) : BrowserWindow.fromWebContents(ev.sender);
    if (!win || win.isDestroyed()) return { success: false };
    const bounds = win.getBounds();
    return { success: true, ...bounds };
  });

  ipcMain.handle('window-close', async (_ev, msg) => {
    // Always log for ESC debugging
    console.log('[ipc:window-close] called with:', msg);

    try {
      if (!msg.id) {
        console.log('[ipc:window-close] no id provided');
        return { success: false, error: 'Window ID is required' };
      }

      const win = BrowserWindow.fromId(msg.id);
      if (!win) {
        console.log('[ipc:window-close] window not found:', msg.id);
        return { success: false, error: 'Window not found' };
      }

      console.log('[ipc:window-close] calling win.close() for window:', msg.id);
      win.close();
      console.log('[ipc:window-close] win.close() completed for window:', msg.id);
      return { success: true };
    } catch (error) {
      console.error('[ipc:window-close] Failed to close window:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('window-hide', async (_ev, msg) => {
    DEBUG && console.log('window-hide', msg);

    try {
      if (!msg.id) {
        return { success: false, error: 'Window ID is required' };
      }

      const winData = getWindowInfo(msg.id);
      if (!winData) {
        return { success: false, error: 'Window not found in window manager' };
      }

      const win = BrowserWindow.fromId(msg.id);
      if (!win) {
        removeWindow(msg.id);
        return { success: false, error: 'Window not found' };
      }

      win.hide();
      return { success: true };
    } catch (error) {
      console.error('Failed to hide window:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('window-show', async (_ev, msg) => {
    DEBUG && console.log('window-show', msg);

    try {
      if (!msg.id) {
        return { success: false, error: 'Window ID is required' };
      }

      const winData = getWindowInfo(msg.id);
      if (!winData) {
        return { success: false, error: 'Window not found in window manager' };
      }

      const win = BrowserWindow.fromId(msg.id);
      if (!win) {
        removeWindow(msg.id);
        return { success: false, error: 'Window not found' };
      }

      win.show();
      updateDockVisibility();
      return { success: true };
    } catch (error) {
      console.error('Failed to show window:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('window-move', async (_ev, msg) => {
    DEBUG && console.log('window-move', msg);

    try {
      if (!msg.id) {
        return { success: false, error: 'Window ID is required' };
      }

      const winData = getWindowInfo(msg.id);
      if (!winData) {
        return { success: false, error: 'Window not found in window manager' };
      }

      const win = BrowserWindow.fromId(msg.id);
      if (!win) {
        removeWindow(msg.id);
        return { success: false, error: 'Window not found' };
      }

      if (typeof msg.x !== 'number' || typeof msg.y !== 'number') {
        return { success: false, error: 'Valid x and y coordinates are required' };
      }

      win.setPosition(msg.x, msg.y);
      return { success: true };
    } catch (error) {
      console.error('Failed to move window:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('window-resize', async (ev, msg) => {
    DEBUG && console.log('window-resize', msg);

    try {
      // If no ID provided, resize the sender's window
      let win: BrowserWindow | null = null;
      if (msg.id) {
        const winData = getWindowInfo(msg.id);
        if (!winData) {
          return { success: false, error: 'Window not found in window manager' };
        }
        win = BrowserWindow.fromId(msg.id);
        if (!win) {
          removeWindow(msg.id);
          return { success: false, error: 'Window not found' };
        }
      } else {
        // Get window from sender
        win = BrowserWindow.fromWebContents(ev.sender);
        if (!win) {
          return { success: false, error: 'Could not determine sender window' };
        }
      }

      if (typeof msg.width !== 'number' || typeof msg.height !== 'number') {
        return { success: false, error: 'Valid width and height are required' };
      }

      win.setSize(msg.width, msg.height);
      return { success: true };
    } catch (error) {
      console.error('Failed to resize window:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('window-focus', async (_ev, msg) => {
    DEBUG && console.log('window-focus', msg);

    try {
      if (!msg.id) {
        return { success: false, error: 'Window ID is required' };
      }

      const winData = getWindowInfo(msg.id);
      if (!winData) {
        return { success: false, error: 'Window not found in window manager' };
      }

      const win = BrowserWindow.fromId(msg.id);
      if (!win) {
        removeWindow(msg.id);
        return { success: false, error: 'Window not found' };
      }

      if (!isHeadless()) {
        win.focus();
      }
      return { success: true };
    } catch (error) {
      console.error('Failed to focus window:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('window-devtools', async (_ev, msg) => {
    DEBUG && console.log('window-devtools', msg, 'lastContentWindowId:', lastContentWindowId);

    try {
      // If no ID provided, use the last content window
      const targetId = msg?.id || lastContentWindowId;

      if (!targetId) {
        return { success: false, error: 'No content window available' };
      }

      const win = BrowserWindow.fromId(targetId);
      if (!win || win.isDestroyed()) {
        // Clear tracking if the window is gone
        if (targetId === lastContentWindowId) {
          lastContentWindowId = null;
        }
        return { success: false, error: 'Window not found or destroyed' };
      }

      // Open devtools for the target window
      win.webContents.openDevTools({ mode: 'detach' });
      return { success: true, id: targetId, url: win.webContents.getURL() };
    } catch (error) {
      console.error('Failed to open devtools:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('window-blur', async (_ev, msg) => {
    DEBUG && console.log('window-blur', msg);

    try {
      if (!msg.id) {
        return { success: false, error: 'Window ID is required' };
      }

      const winData = getWindowInfo(msg.id);
      if (!winData) {
        return { success: false, error: 'Window not found in window manager' };
      }

      const win = BrowserWindow.fromId(msg.id);
      if (!win) {
        removeWindow(msg.id);
        return { success: false, error: 'Window not found' };
      }

      win.blur();
      return { success: true };
    } catch (error) {
      console.error('Failed to blur window:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Animate window bounds (position and/or size)
  // Animates from current bounds (or specified 'from') to target bounds over duration
  ipcMain.handle('window-animate', async (ev, msg) => {
    DEBUG && console.log('window-animate', msg);

    try {
      let win: BrowserWindow | null = null;
      if (msg?.id) {
        win = BrowserWindow.fromId(msg.id);
      } else {
        win = BrowserWindow.fromWebContents(ev.sender);
      }

      if (!win) {
        return { success: false, error: 'Window not found' };
      }

      const currentBounds = win.getBounds();
      const from = msg.from || currentBounds;
      const to = msg.to;
      const duration = msg.duration || 150; // ms

      if (!to) {
        return { success: false, error: 'Target bounds (to) are required' };
      }

      // Calculate animation parameters
      const startX = from.x ?? currentBounds.x;
      const startY = from.y ?? currentBounds.y;
      const startW = from.width ?? currentBounds.width;
      const startH = from.height ?? currentBounds.height;

      const endX = to.x ?? startX;
      const endY = to.y ?? startY;
      const endW = to.width ?? startW;
      const endH = to.height ?? startH;

      // Animation timing
      const timerInterval = 10; // ms
      const numTicks = Math.max(1, Math.floor(duration / timerInterval));
      let tick = 0;

      return new Promise((resolve) => {
        const timer = setInterval(() => {
          tick++;

          if (tick >= numTicks || win!.isDestroyed()) {
            clearInterval(timer);
            // Set final bounds
            if (!win!.isDestroyed()) {
              win!.setBounds({ x: endX, y: endY, width: endW, height: endH });
            }
            resolve({ success: true });
            return;
          }

          // Calculate progress (0 to 1)
          const progress = tick / numTicks;
          // Use easeOutQuad for smooth deceleration
          const eased = 1 - (1 - progress) * (1 - progress);

          const x = Math.round(startX + (endX - startX) * eased);
          const y = Math.round(startY + (endY - startY) * eased);
          const w = Math.round(startW + (endW - startW) * eased);
          const h = Math.round(startH + (endH - startH) * eased);

          win!.setBounds({ x, y, width: w, height: h });
        }, timerInterval);
      });
    } catch (error) {
      console.error('Failed to animate window:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('window-exists', async (_ev, msg) => {
    DEBUG && console.log('window-exists', msg);

    try {
      if (!msg.id) {
        return { exists: false, error: 'Window ID is required' };
      }

      const winData = getWindowInfo(msg.id);
      if (!winData) {
        return { exists: false };
      }

      const win = BrowserWindow.fromId(msg.id);
      if (!win || win.isDestroyed()) {
        removeWindow(msg.id);
        return { exists: false };
      }

      return { exists: true };
    } catch (error) {
      console.error('Failed to check if window exists:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { exists: false, error: message };
    }
  });

  ipcMain.handle('window-list', async (_ev, msg) => {
    DEBUG && console.log('window-list', msg);

    try {
      const windows: Array<{
        id: number;
        url: string;
        title: string;
        source: string;
        params: Record<string, unknown>;
      }> = [];

      for (const [id, winData] of getAllWindows()) {
        const win = BrowserWindow.fromId(id);
        if (win && !win.isDestroyed()) {
          let url = win.webContents.getURL();

          // Check if this is a web page container (peek://app/page)
          // These wrap actual web pages - extract the real URL
          if (url.startsWith('peek://app/page')) {
            try {
              const parsed = new URL(url);
              const actualUrl = parsed.searchParams.get('url');
              if (actualUrl) {
                url = actualUrl;
              }
            } catch {
              // If URL parsing fails, keep the original
            }
          }

          // Skip internal peek:// URLs unless requested
          // (Page containers have had their actual URL extracted above, so web pages pass through)
          if (!msg?.includeInternal && url.startsWith('peek://')) {
            continue;
          }

          // Sanitize params to only include serializable values
          // (avoid functions, native objects, circular refs that crash IPC)
          const safeParams: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(winData.params)) {
            const type = typeof value;
            if (type === 'string' || type === 'number' || type === 'boolean' || value === null) {
              safeParams[key] = value;
            } else if (Array.isArray(value)) {
              // Only include arrays of primitives
              if (value.every(v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null)) {
                safeParams[key] = value;
              }
            }
            // Skip functions, objects, etc. that may not serialize safely
          }

          windows.push({
            id,
            url,
            title: win.getTitle(),
            source: winData.source,
            params: safeParams
          });
        }
      }

      return { success: true, windows };
    } catch (error) {
      console.error('Failed to list windows:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message, windows: [] };
    }
  });
}

/**
 * Register miscellaneous IPC handlers (shortcuts, pubsub, commands, etc.)
 */
export function registerMiscHandlers(onQuit: () => void): void {
  // Renderer log forwarding - prints renderer console.log to terminal
  ipcMain.on(IPC_CHANNELS.RENDERER_LOG, (_ev, msg) => {
    const shortSource = msg.source?.replace('peek://app/', '') || 'unknown';
    DEBUG && console.log(`[${shortSource}]`, ...(msg.args || []));
  });

  // Get current window ID (the window that sent the IPC message)
  ipcMain.handle('get-window-id', (ev) => {
    const win = BrowserWindow.fromWebContents(ev.sender);
    return win ? win.id : null;
  });

  // Get window position
  ipcMain.handle('window-get-position', (ev, msg) => {
    try {
      let win: BrowserWindow | null = null;
      if (msg?.id) {
        win = BrowserWindow.fromId(msg.id);
      } else {
        win = BrowserWindow.fromWebContents(ev.sender);
      }
      if (!win) {
        return { success: false, error: 'Window not found' };
      }
      const [x, y] = win.getPosition();
      return { success: true, x, y };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Check if window is draggable (default: true)
  ipcMain.handle('window-is-draggable', (ev) => {
    try {
      const win = BrowserWindow.fromWebContents(ev.sender);
      if (!win) {
        return { success: false, error: 'Window not found' };
      }
      const winInfo = getWindowInfo(win.id);
      // Default to draggable if not specified
      const draggable = winInfo?.params?.draggable !== false;
      return { success: true, draggable };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Web navigation handlers - operate on the target http/https window
  const resolveWebWindow = (windowId?: number): BrowserWindow | null => {
    const id = windowId || lastFocusedVisibleWindowId;
    if (!id) return null;
    const win = BrowserWindow.fromId(id);
    if (!win || win.isDestroyed()) return null;
    const winUrl = win.webContents.getURL();
    if (!winUrl.startsWith('http://') && !winUrl.startsWith('https://')) return null;
    return win;
  };

  ipcMain.handle('web-nav-back', async (_ev, data?: { windowId?: number }) => {
    const win = resolveWebWindow(data?.windowId);
    if (!win) return { success: false, error: 'No web page window' };
    const nav = win.webContents.navigationHistory;
    if (nav.canGoBack()) {
      nav.goBack();
      return { success: true };
    }
    return { success: false, error: 'Cannot go back' };
  });

  ipcMain.handle('web-nav-forward', async (_ev, data?: { windowId?: number }) => {
    const win = resolveWebWindow(data?.windowId);
    if (!win) return { success: false, error: 'No web page window' };
    const nav = win.webContents.navigationHistory;
    if (nav.canGoForward()) {
      nav.goForward();
      return { success: true };
    }
    return { success: false, error: 'Cannot go forward' };
  });

  ipcMain.handle('web-nav-reload', async (_ev, data?: { windowId?: number }) => {
    const win = resolveWebWindow(data?.windowId);
    if (!win) return { success: false, error: 'No web page window' };
    win.webContents.reload();
    return { success: true };
  });

  ipcMain.handle('web-nav-state', async (_ev, data?: { windowId?: number }) => {
    const win = resolveWebWindow(data?.windowId);
    if (!win) return { success: false, error: 'No web page window' };
    const nav = win.webContents.navigationHistory;
    return {
      success: true,
      data: {
        url: win.webContents.getURL(),
        canGoBack: nav.canGoBack(),
        canGoForward: nav.canGoForward(),
        title: win.getTitle() || '',
      }
    };
  });

  // Get last focused visible window ID (for per-window commands)
  // Returns the most recently focused window that isn't a background/internal window
  ipcMain.handle('get-focused-visible-window-id', () => {
    return lastFocusedVisibleWindowId;
  });

  // Register shortcut
  ipcMain.on(IPC_CHANNELS.REGISTER_SHORTCUT, (ev, msg) => {
    const isGlobal = msg.global === true;
    const modeStr = msg.mode ? ` mode:${msg.mode}` : '';
    DEBUG && console.log('ipc register shortcut', msg.shortcut, isGlobal ? '(global)' : '(local)', modeStr);

    const callback = () => {
      DEBUG && console.log('on(registershortcut): shortcut executed', msg.shortcut, msg.replyTopic);
      ev.reply(msg.replyTopic, { foo: 'bar' });
    };

    if (isGlobal) {
      registerGlobalShortcut(msg.shortcut, msg.source, callback);
    } else {
      // Build mode conditions if provided
      const modeConditions = msg.mode ? { majorMode: msg.mode } : undefined;
      registerLocalShortcut(msg.shortcut, msg.source, callback, modeConditions);
    }
  });

  // Unregister shortcut
  ipcMain.on(IPC_CHANNELS.UNREGISTER_SHORTCUT, (_ev, msg) => {
    const isGlobal = msg.global === true;
    DEBUG && console.log('ipc unregister shortcut', msg.shortcut, isGlobal ? '(global)' : '(local)');

    if (isGlobal) {
      const err = unregisterGlobalShortcut(msg.shortcut);
      if (err) {
        DEBUG && console.log('ipc unregister global shortcut error:', err.message);
      }
    } else {
      // Build mode conditions if provided
      const modeConditions = msg.mode ? { majorMode: msg.mode } : undefined;
      unregisterLocalShortcut(msg.shortcut, msg.source, modeConditions);
    }
  });

  // Close window
  ipcMain.on(IPC_CHANNELS.CLOSE_WINDOW, (ev, msg) => {
    closeWindow(msg.params, (output) => {
      DEBUG && console.log('main.closeWindow api callback, output:', output);
      if (msg && msg.replyTopic) {
        ev.reply(msg.replyTopic, output);
      }
    });
  });

  // PubSub publish
  ipcMain.on(IPC_CHANNELS.PUBLISH, (_ev, msg) => {
    DEBUG && console.log('ipc:publish', msg);
    publish(msg.source, msg.scope, msg.topic, msg.data);
  });

  // PubSub subscribe
  ipcMain.on(IPC_CHANNELS.SUBSCRIBE, (ev, msg) => {
    DEBUG && console.log('ipc:subscribe', msg);

    subscribe(msg.source, msg.scope, msg.topic, (data: unknown) => {
      DEBUG && console.log('ipc:subscribe:notification', msg);
      ev.reply(msg.replyTopic, data);
    });
  });

  // Console log from renderer
  ipcMain.on(IPC_CHANNELS.CONSOLE, (_ev, msg) => {
    DEBUG && console.log('r:', msg.source, msg.text);
  });

  // App quit request
  ipcMain.on(IPC_CHANNELS.APP_QUIT, (_ev, msg) => {
    DEBUG && console.log('app-quit requested from:', msg?.source);
    onQuit();
  });

  // App restart request
  ipcMain.on(IPC_CHANNELS.APP_RESTART, (_ev, msg) => {
    DEBUG && console.log('app-restart requested from:', msg?.source);
    app.relaunch();
    onQuit();
  });

  // Modify window
  ipcMain.on(IPC_CHANNELS.MODIFY_WINDOW, (ev, msg) => {
    DEBUG && console.log('modifywindow', msg);

    const key = Object.prototype.hasOwnProperty.call(msg, 'name') ? msg.name : null;

    if (key != null) {
      const existingWindow = findWindowByKey(msg.source, key);
      if (existingWindow) {
        DEBUG && console.log('FOUND WINDOW FOR KEY', key);
        const bw = existingWindow.window;
        let r = false;
        try {
          modWindow(bw, msg.params);
          r = true;
        } catch (ex) {
          console.error(ex);
        }
        ev.reply(msg.replyTopic, { output: r });
      }
    }
  });

  // File save dialog - shows native save dialog and writes file
  ipcMain.handle('file-save-dialog', async (ev, data: {
    content: string;
    filename?: string;
    mimeType?: string;
  }) => {
    try {
      // Determine file filters based on MIME type
      const filters: Electron.FileFilter[] = [];
      if (data.mimeType) {
        const extMap: Record<string, { name: string; extensions: string[] }> = {
          'application/json': { name: 'JSON', extensions: ['json'] },
          'text/csv': { name: 'CSV', extensions: ['csv'] },
          'text/plain': { name: 'Text', extensions: ['txt'] },
          'text/html': { name: 'HTML', extensions: ['html', 'htm'] },
        };
        const filter = extMap[data.mimeType];
        if (filter) {
          filters.push(filter);
        }
      }
      filters.push({ name: 'All Files', extensions: ['*'] });

      // Get the sender's window to parent the dialog
      // This prevents the modal panel from blurring when dialog opens
      const senderWindow = BrowserWindow.fromWebContents(ev.sender);

      const result = await dialog.showSaveDialog(senderWindow!, {
        defaultPath: data.filename,
        filters,
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      // Write the file
      fs.writeFileSync(result.filePath, data.content, 'utf-8');

      return { success: true, path: result.filePath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // App info handler - returns app version and other metadata
  ipcMain.handle('app-info', async () => {
    return {
      success: true,
      data: {
        version: app.getVersion(),
        name: app.getName(),
        isPackaged: app.isPackaged
      }
    };
  });

  // Open a path in the system file manager (Finder on macOS)
  ipcMain.handle('shell-open-path', async (_ev, data) => {
    try {
      const pathToOpen = data.path || data;
      // Ensure directory exists before opening
      if (!fs.existsSync(pathToOpen)) {
        fs.mkdirSync(pathToOpen, { recursive: true });
      }
      await shell.openPath(pathToOpen);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });
}

/**
 * Register sync-related IPC handlers
 */
export function registerSyncHandlers(): void {
  // Get sync configuration
  ipcMain.handle('sync-get-config', async () => {
    try {
      const config = getSyncConfig();
      return { success: true, data: config };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Set sync configuration
  ipcMain.handle('sync-set-config', async (_ev, data) => {
    try {
      setSyncConfig(data);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Pull items from server
  ipcMain.handle('sync-pull', async (_ev, data = {}) => {
    try {
      const config = getSyncConfig();
      if (!config.serverUrl || !config.apiKey) {
        return { success: false, error: 'Sync not configured. Set serverUrl and apiKey first.' };
      }

      const since = data.since !== undefined ? data.since : config.lastSyncTime;
      const syncTime = Date.now();
      const result = await pullFromServer(config.serverUrl, config.apiKey, since);

      // Update lastSyncTime after successful pull
      const activeProfile = getActiveProfile();
      updateLastSyncTime(activeProfile.id, syncTime);

      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Push items to server
  ipcMain.handle('sync-push', async (_ev, data = {}) => {
    try {
      const config = getSyncConfig();
      if (!config.serverUrl || !config.apiKey) {
        return { success: false, error: 'Sync not configured. Set serverUrl and apiKey first.' };
      }

      const since = data.since !== undefined ? data.since : config.lastSyncTime;
      const syncTime = Date.now();
      const result = await pushToServer(config.serverUrl, config.apiKey, since);

      // Update lastSyncTime after successful push
      const activeProfile = getActiveProfile();
      updateLastSyncTime(activeProfile.id, syncTime);

      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Full bidirectional sync
  ipcMain.handle('sync-full', async () => {
    try {
      const config = getSyncConfig();
      if (!config.serverUrl || !config.apiKey) {
        return { success: false, error: 'Sync not configured. Set serverUrl and apiKey first.' };
      }

      const result = await syncAll(config.serverUrl, config.apiKey);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Get sync status
  ipcMain.handle('sync-status', async () => {
    try {
      const status = getSyncStatus();
      return { success: true, data: status };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });
}

/**
 * Register backup-related IPC handlers
 */
export function registerBackupHandlers(): void {
  // Get backup configuration
  ipcMain.handle('backup-get-config', async () => {
    try {
      const config = getBackupConfig();
      return { success: true, data: config };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Set backup configuration
  ipcMain.handle('backup-set-config', async (_ev, data) => {
    try {
      setBackupConfig(data);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Create a backup manually
  ipcMain.handle('backup-create', async () => {
    try {
      const result = await createBackup();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // List existing backups
  ipcMain.handle('backup-list', async () => {
    try {
      const backups = listBackups();
      const config = getBackupConfig();
      return {
        success: true,
        data: {
          backups,
          backupDir: config.backupDir,
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });
}

/**
 * Register profile-related IPC handlers
 */
export function registerProfileHandlers(): void {
  // List all profiles
  ipcMain.handle('profiles:list', async () => {
    try {
      const profiles = listProfiles();
      return { success: true, data: profiles };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Create a new profile
  ipcMain.handle('profiles:create', async (_ev, data: { name: string }) => {
    try {
      const profile = createProfile(data.name);
      return { success: true, data: profile };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Get a specific profile by slug
  ipcMain.handle('profiles:get', async (_ev, data: { slug: string }) => {
    try {
      const profile = getProfileByFolder(data.slug);
      if (!profile) {
        return { success: false, error: 'Profile not found' };
      }
      return { success: true, data: profile };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Delete a profile
  ipcMain.handle('profiles:delete', async (_ev, data: { id: string }) => {
    try {
      deleteProfile(data.id);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Get the currently active profile
  ipcMain.handle('profiles:getCurrent', async () => {
    try {
      const profile = getActiveProfile();
      return { success: true, data: profile };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Switch to a different profile (causes app restart)
  ipcMain.handle('profiles:switch', async (_ev, data: { slug: string }) => {
    try {
      DEBUG && console.log(`[ipc:profiles] Switch requested to profile: ${data.slug}`);

      const currentProfile = getActiveProfile();
      DEBUG && console.log(`[ipc:profiles] Current profile: ${currentProfile.folder}`);

      // Check if already on this profile
      if (currentProfile.folder === data.slug) {
        DEBUG && console.log('[ipc:profiles] Already on requested profile, no-op');
        return { success: true, message: 'Already on this profile' };
      }

      const profile = getProfileByFolder(data.slug);
      if (!profile) {
        return { success: false, error: 'Profile not found' };
      }

      // Set as active profile
      DEBUG && console.log(`[ipc:profiles] Setting active profile to: ${data.slug}`);
      setActiveProfile(data.slug);

      DEBUG && console.log('[ipc:profiles] Relaunching app...');
      // Relaunch the app with the new profile
      // The app will pick up the new active profile from profiles.db on restart
      app.relaunch();
      app.quit();

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Enable sync for a profile
  ipcMain.handle('profiles:enableSync', async (_ev, data: {
    profileId: string;
    apiKey: string;
    serverProfileSlug: string;
  }) => {
    try {
      enableSync(data.profileId, data.apiKey, data.serverProfileSlug);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Disable sync for a profile
  ipcMain.handle('profiles:disableSync', async (_ev, data: { profileId: string }) => {
    try {
      disableSync(data.profileId);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Get sync configuration for a profile
  ipcMain.handle('profiles:getSyncConfig', async (_ev, data: { profileId: string }) => {
    try {
      const syncConfig = getProfileSyncConfig(data.profileId);
      return { success: true, data: syncConfig };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Get the partition string for the current profile's session
  // Used by renderers to set webview partition attribute
  ipcMain.handle('profiles:getPartition', async () => {
    try {
      const { getPartitionString, getCurrentProfileId } = await import('./session-partition.js');
      const profileId = getCurrentProfileId();
      if (!profileId) {
        return { success: false, error: 'No profile session initialized' };
      }
      const partition = getPartitionString(profileId);
      return { success: true, data: { profileId, partition } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });
}

/**
 * Register modes-related IPC handlers
 *
 * These handlers provide backwards compatibility with the old modes API.
 * New code should use the context API (api.context) instead.
 */
export function registerModesHandlers(): void {
  // Mode definitions
  const MODES = [
    { id: 'default', name: 'Default', description: 'Standard browsing mode' },
    { id: 'page', name: 'Page', description: 'Viewing a web page' },
    { id: 'group', name: 'Group', description: 'Managing tab groups' },
  ];

  // Get mode state for a window (uses context API)
  ipcMain.handle('modes:getWindowMode', async (ev, data: { windowId?: number | null }) => {
    try {
      let windowId = data.windowId;

      if (windowId === undefined || windowId === null) {
        const callingWin = BrowserWindow.fromWebContents(ev.sender);
        windowId = callingWin?.id ?? lastFocusedVisibleWindowId;
      }

      if (windowId === null || windowId === undefined) {
        return { success: false, error: 'No target window' };
      }

      const entry = getContextEntry('mode', windowId);
      const state = {
        major: (entry?.value as MajorModeId) || 'default'
      };
      return { success: true, data: state };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Set major mode for a window (uses context API)
  ipcMain.handle('modes:setMajorMode', async (ev, data: { mode: MajorModeId; windowId?: number | null }) => {
    try {
      let windowId = data.windowId;
      let source = '';

      if (windowId === undefined || windowId === null) {
        const callingWin = BrowserWindow.fromWebContents(ev.sender);
        windowId = callingWin?.id ?? lastFocusedVisibleWindowId;
        source = callingWin?.webContents.getURL() ?? '';
      }

      if (windowId === null || windowId === undefined) {
        return { success: false, error: 'No target window' };
      }

      addContextEntry('mode', data.mode, { windowId, source });

      // Publish mode change for backwards compatibility
      publish(getSystemAddress(), PubSubScopes.GLOBAL, 'modes:changed', {
        windowId,
        major: data.mode,
      });

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // List all available modes
  ipcMain.handle('modes:listModes', async () => {
    return { success: true, data: MODES };
  });

  // Get command context for current state
  ipcMain.handle('modes:getCommandContext', async () => {
    try {
      const windowId = lastFocusedVisibleWindowId;
      const entry = getContextEntry('mode', windowId);

      let url: string | null = null;
      let title: string | null = null;

      if (windowId !== null) {
        const win = BrowserWindow.fromId(windowId);
        if (win && !win.isDestroyed()) {
          url = win.webContents.getURL();
          title = win.getTitle();
        }
      }

      const context = {
        windowId,
        mode: {
          major: (entry?.value as MajorModeId) || 'default'
        },
        url,
        title,
        hasSelection: false
      };
      return { success: true, data: context };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });
}

/**
 * Register context-related IPC handlers
 *
 * The context API provides a general-purpose key-value store for application context.
 * "mode" is just one key in this system - extensions can define their own context keys.
 */
export function registerContextHandlers(): void {
  // Get current context entry for a key
  ipcMain.handle('context-get', async (ev, data: { key: string; windowId?: number | null }) => {
    try {
      let windowId = data.windowId;

      // If no windowId provided, try to get from calling window
      if (windowId === undefined) {
        const callingWin = BrowserWindow.fromWebContents(ev.sender);
        windowId = callingWin?.id ?? null;
      }

      const entry = getContextEntry(data.key, windowId);
      return { success: true, data: entry };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Set context value (persists to history)
  ipcMain.handle('context-set', async (ev, data: {
    key: string;
    value: unknown;
    metadata?: Record<string, unknown>;
    windowId?: number | null;
    source?: string;
  }) => {
    try {
      let windowId = data.windowId;
      let source = data.source;

      // If no windowId provided, try to get from calling window
      if (windowId === undefined) {
        const callingWin = BrowserWindow.fromWebContents(ev.sender);
        windowId = callingWin?.id ?? null;
      }

      // If no source provided, try to get from calling window's URL
      if (!source) {
        const callingWin = BrowserWindow.fromWebContents(ev.sender);
        source = callingWin?.webContents.getURL() ?? '';
      }

      const result = addContextEntry(data.key, data.value, {
        metadata: data.metadata,
        windowId,
        source
      });

      // Publish context change event for watchers
      if (publish && PubSubScopes && getSystemAddress) {
        publish(getSystemAddress(), PubSubScopes.GLOBAL, 'context:changed', {
          key: data.key,
          value: data.value,
          metadata: data.metadata || {},
          windowId,
          source,
          entryId: result.id
        });
      }

      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Query context history
  ipcMain.handle('context-history', async (ev, data: {
    key?: string;
    windowId?: number | null;
    since?: number;
    until?: number;
    limit?: number;
    order?: 'asc' | 'desc';
  }) => {
    try {
      const entries = queryContextHistory(data);
      return { success: true, data: entries };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Get context snapshot at a point in time
  ipcMain.handle('context-snapshot', async (ev, data: {
    timestamp: number;
    keys?: string[];
  }) => {
    try {
      const snapshot = getContextSnapshot(data.timestamp, data.keys || []);
      return { success: true, data: snapshot };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Get all windows with a specific context value
  ipcMain.handle('context-windows-with-value', async (ev, data: {
    key: string;
    value: unknown;
  }) => {
    try {
      const windowIds = getWindowsWithContextValue(data.key, data.value);
      return { success: true, data: windowIds };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Get windows in a specific group (convenience method for mode='group' with groupId)
  ipcMain.handle('context-windows-in-group', async (ev, data: { groupId: string }) => {
    try {
      const windowIds = getWindowsMatchingContext('mode', (entry) => {
        return entry.value === 'group' && entry.metadata?.groupId === data.groupId;
      });
      return { success: true, data: windowIds };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  DEBUG && console.log('[ipc] Context handlers registered');
}

/**
 * Register IPC handlers for bundled web extensions (adblocker + chrome extensions)
 */
export function registerWebExtensionHandlers(): void {
  const DEBUG = !!process.env.DEBUG;

  // ========== Adblocker Handlers ==========

  // Get adblocker status
  ipcMain.handle('adblocker:getStatus', async () => {
    try {
      const { getAdblockerStatus } = await import('./adblocker.js');
      const status = getAdblockerStatus();
      return { success: true, data: status };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Enable adblocker
  ipcMain.handle('adblocker:enable', async () => {
    try {
      const { applyAdblockerConfig } = await import('./adblocker.js');
      await applyAdblockerConfig({ enabled: true });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Disable adblocker
  ipcMain.handle('adblocker:disable', async () => {
    try {
      const { disableBlocking } = await import('./adblocker.js');
      disableBlocking();
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Get blocked count
  ipcMain.handle('adblocker:getBlockedCount', async () => {
    try {
      const { getBlockedCount } = await import('./adblocker.js');
      const count = getBlockedCount();
      return { success: true, data: count };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // ========== Chrome Extension Handlers ==========

  // Get all chrome extensions
  ipcMain.handle('chrome-ext:list', async () => {
    try {
      const { getChromeExtensions } = await import('./chrome-extensions.js');
      const extensions = getChromeExtensions();
      return { success: true, data: extensions };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Enable a chrome extension
  ipcMain.handle('chrome-ext:enable', async (_ev, data: { id: string }) => {
    try {
      const { enableChromeExtension } = await import('./chrome-extensions.js');
      const result = await enableChromeExtension(data.id);
      return { success: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Disable a chrome extension
  ipcMain.handle('chrome-ext:disable', async (_ev, data: { id: string }) => {
    try {
      const { disableChromeExtension } = await import('./chrome-extensions.js');
      const result = await disableChromeExtension(data.id);
      return { success: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Get chrome extension manager status
  ipcMain.handle('chrome-ext:getStatus', async () => {
    try {
      const { getChromeExtensionStatus } = await import('./chrome-extensions.js');
      const status = getChromeExtensionStatus();
      return { success: true, data: status };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  DEBUG && console.log('[ipc] Web extension handlers registered');
}

/**
 * Register all IPC handlers
 */
export function registerAllHandlers(onQuit: () => void): void {
  registerDarkModeHandlers();
  registerDatastoreHandlers();
  registerExtensionHandlers();
  registerWindowHandlers();
  registerSyncHandlers();
  registerBackupHandlers();
  registerProfileHandlers();
  registerModesHandlers();
  registerContextHandlers();
  registerWebExtensionHandlers();
  registerMiscHandlers(onQuit);
}
