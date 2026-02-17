/**
 * IPC Handler Registration
 *
 * Centralizes all IPC handlers for the main process.
 * Handlers are thin wrappers that delegate to backend functions.
 */

import { ipcMain, nativeTheme, dialog, BrowserWindow, app, screen, shell, webContents, net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import {
  // Datastore operations
  addContent,
  queryContent,
  getOrCreateTag,
  renameTag,
  deleteTag,
  getTagsByFrecency,
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
  updateItemTitle,
  deleteItem,
  hardDeleteItem,
  queryItems,
  tagItem,
  untagItem,
  getItemTags,
  getItemsByTag,
  // Item visit operations
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
  normalizeUrl,
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
  WEB_CORE_ADDRESS,
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

import { trackWindow } from './display-watcher.js';

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

import {
  saveSessionSnapshot,
  restoreSessionSnapshot,
  getSessionSnapshotInfo,
} from './session.js';

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

// ============================================================================
// Popup-to-Opener Bridge (OAuth / window.opener shim)
// ============================================================================
// Maps popup window IDs to their opener window IDs. Used to route
// window.opener.postMessage() calls from popup webviews back to the opener.
// Populated in setWindowOpenHandler, cleaned up on popup window close.

const popupToOpener = new Map<number, number>();

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
 * Auto-tag an item with the group tag if the calling window (or the last
 * focused visible window) is in group mode. This handles the case where
 * items are created via cmd palette or other intermediary windows while
 * the user is working in a group context.
 * Returns true if the item was tagged.
 */
/**
 * Tag an item and publish the event so UIs (groups, tags) update reactively
 */
function tagItemAndPublish(itemId: string, tagId: string): void {
  const result = tagItem(itemId, tagId);
  if (!result.alreadyExists) {
    const tag = getDb().prepare('SELECT name FROM tags WHERE id = ?').get(tagId) as { name: string } | undefined;
    publish('system', PubSubScopes.GLOBAL, 'tag:item-added', {
      tagId,
      tagName: tag?.name,
      itemId
    });
  }
}

function autoTagIfGroupMode(ev: Electron.IpcMainInvokeEvent, itemId: string): boolean {
  try {
    const callingWin = BrowserWindow.fromWebContents(ev.sender);
    const callerWinId = callingWin && !callingWin.isDestroyed() ? callingWin.id : null;
    const callerMode = callerWinId ? getContextEntry('mode', callerWinId) : null;
    const lastVisibleMode = lastFocusedVisibleWindowId ? getContextEntry('mode', lastFocusedVisibleWindowId) : null;

    if (callerMode && callerMode.value === 'group' && callerMode.metadata?.groupId) {
      const groupId = callerMode.metadata.groupId as string;
      tagItemAndPublish(itemId, groupId);
      console.log('[ipc] Auto-tagged item', itemId, 'with group', groupId, '(from caller)');
      return true;
    }
    // Fallback: check last focused visible window (handles cmd palette, modal callers)
    if (lastVisibleMode && lastVisibleMode.value === 'group' && lastVisibleMode.metadata?.groupId) {
      const groupId = lastVisibleMode.metadata.groupId as string;
      tagItemAndPublish(itemId, groupId);
      console.log('[ipc] Auto-tagged item', itemId, 'with group', groupId, '(from last visible)');
      return true;
    }
  } catch (e) {
    console.log('[ipc] autoTagIfGroupMode error:', e);
  }
  return false;
}

/**
 * Register datastore IPC handlers
 */
export function registerDatastoreHandlers(): void {
  // Address IPC handlers — redirected to items system for backward compatibility
  ipcMain.handle('datastore-add-address', async (ev, data) => {
    try {
      const opts = data.options || {};
      const normalizedUri = normalizeUrl(data.uri);
      const metadata: Record<string, unknown> = {};
      if (opts.title) metadata.title = opts.title;
      if (opts.description) metadata.description = opts.description;
      if (opts.favicon) metadata.favicon = opts.favicon;

      const result = addItem('url', {
        content: normalizedUri,
        mimeType: opts.mimeType || 'text/html',
        metadata: JSON.stringify(metadata),
        starred: opts.starred || 0,
        archived: opts.archived || 0,
      });
      // Set title/favicon/domain columns directly (addItem only sets title from metadata.title and domain from URL)
      if (opts.favicon) {
        getDb().prepare('UPDATE items SET favicon = ? WHERE id = ?').run(opts.favicon, result.id);
      }

      // Emit item:created event for consistency
      publish('system', PubSubScopes.GLOBAL, 'item:created', {
        itemId: result.id,
        itemType: 'url',
        content: normalizedUri
      });

      // Auto-tag with group if calling window is in group mode
      autoTagIfGroupMode(ev, result.id);

      return { success: true, data: result, id: result.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-get-address', async (ev, data) => {
    try {
      const item = getItem(data.id);
      if (!item) return { success: true, data: undefined };
      // Transform item to address-like shape
      return { success: true, data: itemToAddress(item) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-update-address', async (ev, data) => {
    try {
      const updates = data.updates || {};
      const itemOpts: Record<string, unknown> = {};
      if (updates.metadata !== undefined) itemOpts.metadata = updates.metadata;
      if (updates.starred !== undefined) itemOpts.starred = updates.starred;
      if (updates.archived !== undefined) itemOpts.archived = updates.archived;
      if (updates.mimeType !== undefined) itemOpts.mimeType = updates.mimeType;
      if (updates.uri !== undefined) itemOpts.content = updates.uri;

      updateItem(data.id, itemOpts);
      // Update title/favicon directly if provided
      if (updates.title !== undefined) {
        getDb().prepare('UPDATE items SET title = ?, updatedAt = ? WHERE id = ?').run(updates.title, Date.now(), data.id);
      }
      if (updates.favicon !== undefined) {
        getDb().prepare('UPDATE items SET favicon = ?, updatedAt = ? WHERE id = ?').run(updates.favicon, Date.now(), data.id);
      }

      const updated = getItem(data.id);
      return { success: true, data: updated ? itemToAddress(updated) : undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-query-addresses', async (ev, data) => {
    try {
      const filter = data.filter || {};
      const itemFilter: Record<string, unknown> = { type: 'url' };
      if (filter.domain) itemFilter.domain = filter.domain;
      if (filter.starred !== undefined) itemFilter.starred = filter.starred;
      if (filter.sortBy) itemFilter.sortBy = filter.sortBy;
      if (filter.limit) itemFilter.limit = filter.limit;
      if (filter.search) itemFilter.search = filter.search;

      const items = queryItems(itemFilter);
      return { success: true, data: items.map(itemToAddress) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-add-visit', async (ev, data) => {
    try {
      const opts = data.options || {};
      const result = recordItemVisit(data.addressId, {
        source: opts.source || 'direct',
        sourceId: opts.sourceId || '',
        windowType: opts.windowType || 'main',
        interacted: opts.interacted || 0,
      });
      return { success: true, data: result, id: result.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-query-visits', async (ev, data) => {
    try {
      const filter = data.filter || {};
      const itemFilter: Record<string, unknown> = {};
      if (filter.addressId) itemFilter.itemId = filter.addressId;
      if (filter.source) itemFilter.source = filter.source;
      if (filter.since) itemFilter.since = filter.since;
      if (filter.until) itemFilter.until = filter.until;
      if (filter.limit) itemFilter.limit = filter.limit;

      const visits = queryItemVisits(itemFilter);
      // Map itemId to addressId for backward compat
      const mapped = visits.map(v => ({ ...v, addressId: v.itemId }));
      return { success: true, data: mapped };
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

      // Emit event if tag was newly created
      if (result.created) {
        publish('system', PubSubScopes.GLOBAL, 'tag:created', {
          tagId: result.tag.id,
          tagName: result.tag.name
        });
        if (DEBUG) console.log('[ipc] tag:created', result.tag.id, result.tag.name);
      }

      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Tag-address handlers — redirected to item tagging
  ipcMain.handle('datastore-tag-address', async (ev, data) => {
    try {
      const result = tagItem(data.addressId, data.tagId);

      // Emit events for backward compat
      if (!result.alreadyExists) {
        const tag = getDb().prepare('SELECT name FROM tags WHERE id = ?').get(data.tagId) as { name: string } | undefined;
        // Emit both old and new event names
        publish('system', PubSubScopes.GLOBAL, 'tag:address-added', {
          tagId: data.tagId,
          tagName: tag?.name,
          addressId: data.addressId
        });
        publish('system', PubSubScopes.GLOBAL, 'tag:item-added', {
          tagId: data.tagId,
          tagName: tag?.name,
          itemId: data.addressId
        });
        if (DEBUG) console.log('[ipc] tag:address-added (redirected to tagItem)', data.tagId, data.addressId);
      }

      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-untag-address', async (ev, data) => {
    try {
      const tag = getDb().prepare('SELECT name FROM tags WHERE id = ?').get(data.tagId) as { name: string } | undefined;

      const result = untagItem(data.addressId, data.tagId);

      if (result) {
        publish('system', PubSubScopes.GLOBAL, 'tag:address-removed', {
          tagId: data.tagId,
          tagName: tag?.name,
          addressId: data.addressId
        });
        publish('system', PubSubScopes.GLOBAL, 'tag:item-removed', {
          tagId: data.tagId,
          tagName: tag?.name,
          itemId: data.addressId
        });
        if (DEBUG) console.log('[ipc] tag:address-removed (redirected to untagItem)', data.tagId, data.addressId);
      }

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

  ipcMain.handle('datastore-rename-tag', async (ev, data) => {
    try {
      const result = renameTag(data.tagId, data.newName);
      if (result) {
        publish('system', PubSubScopes.GLOBAL, 'tag:renamed', {
          tagId: data.tagId,
          newName: data.newName
        });
        if (DEBUG) console.log('[ipc] tag:renamed', data.tagId, data.newName);
      }
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-delete-tag', async (ev, data) => {
    try {
      const result = deleteTag(data.tagId);
      if (result) {
        publish('system', PubSubScopes.GLOBAL, 'tag:deleted', {
          tagId: data.tagId
        });
        if (DEBUG) console.log('[ipc] tag:deleted', data.tagId);
      }
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Address-tag query handlers — redirected to item tagging
  ipcMain.handle('datastore-get-address-tags', async (ev, data) => {
    try {
      const result = getItemTags(data.addressId);
      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-get-addresses-by-tag', async (ev, data) => {
    try {
      const items = getItemsByTag(data.tagId);
      return { success: true, data: items.map(itemToAddress) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-get-untagged-addresses', async (ev, data) => {
    try {
      // Query URL items that have no tags
      const items = getDb().prepare(`
        SELECT i.* FROM items i
        LEFT JOIN item_tags it ON i.id = it.itemId
        WHERE i.type = 'url' AND i.deletedAt = 0 AND it.id IS NULL
        ORDER BY i.visitCount DESC
      `).all() as import('../types/index.js').Item[];
      return { success: true, data: items.map(itemToAddress) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Item operations (mobile-style lightweight content)
  ipcMain.handle('datastore-add-item', async (ev, data) => {
    try {
      const result = addItem(data.type, data.options);

      // Emit item:created event
      publish('system', PubSubScopes.GLOBAL, 'item:created', {
        itemId: result.id,
        itemType: data.type,
        content: data.options?.content
      });
      if (DEBUG) console.log('[ipc] item:created', result.id, data.type);

      // Auto-tag with group if calling window is in group mode
      autoTagIfGroupMode(ev, result.id);

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

      // Emit item:updated event if update was successful
      if (result) {
        const db = getDb();
        const item = db.prepare('SELECT type FROM items WHERE id = ?').get(data.id) as { type: string } | undefined;
        publish('system', PubSubScopes.GLOBAL, 'item:updated', {
          itemId: data.id,
          itemType: item?.type
        });
        if (DEBUG) console.log('[ipc] item:updated', data.id, item?.type);
      }

      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-delete-item', async (ev, data) => {
    try {
      // Fetch item type before deletion (need it for event payload)
      const db = getDb();
      const item = db.prepare('SELECT type FROM items WHERE id = ?').get(data.id) as { type: string } | undefined;

      const result = deleteItem(data.id);

      // Emit item:deleted event if deletion was successful
      if (result) {
        publish('system', PubSubScopes.GLOBAL, 'item:deleted', {
          itemId: data.id,
          itemType: item?.type
        });
        if (DEBUG) console.log('[ipc] item:deleted', data.id, item?.type);
      }

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

  ipcMain.handle('datastore-update-item-title', async (ev, data) => {
    try {
      const result = updateItemTitle(data.url, data.title);
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

      // Emit event if this is a new link (not already tagged)
      if (!result.alreadyExists) {
        // Fetch tag name and item type for event payload
        const db = getDb();
        const tag = db.prepare('SELECT name FROM tags WHERE id = ?').get(data.tagId) as { name: string } | undefined;
        const item = db.prepare('SELECT type FROM items WHERE id = ?').get(data.itemId) as { type: string } | undefined;
        publish('system', PubSubScopes.GLOBAL, 'tag:item-added', {
          tagId: data.tagId,
          tagName: tag?.name,
          itemId: data.itemId,
          itemType: item?.type
        });
        if (DEBUG) console.log('[ipc] tag:item-added', data.tagId, data.itemId);
      }

      return { success: true, data: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('datastore-untag-item', async (ev, data) => {
    try {
      // Fetch tag name before untagging (need it for event payload)
      const tag = getDb().prepare('SELECT name FROM tags WHERE id = ?').get(data.tagId) as { name: string } | undefined;

      const result = untagItem(data.itemId, data.tagId);

      // Emit event if the untag actually removed something
      if (result) {
        publish('system', PubSubScopes.GLOBAL, 'tag:item-removed', {
          tagId: data.tagId,
          tagName: tag?.name,
          itemId: data.itemId
        });
        if (DEBUG) console.log('[ipc] tag:item-removed', data.tagId, data.itemId);
      }

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

  // History operations — redirected to item_visits system
  ipcMain.handle('datastore-get-history', async (ev, data = {}) => {
    try {
      const filter = data.filter || {};
      const visits = queryItemVisits(filter);
      // Enrich with item data to match HistoryEntry shape
      const enriched = visits.map(v => {
        const item = getItem(v.itemId);
        return {
          ...v,
          addressId: v.itemId,
          uri: item?.content || '',
          title: item?.title || '',
          domain: item?.domain || '',
          protocol: '',
          favicon: item?.favicon || '',
        };
      });
      return { success: true, data: enriched };
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

      // Auto-tag with group if calling window is in group mode
      autoTagIfGroupMode(ev, result.itemId);

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

  // Extract page content from a live webContents by URL
  ipcMain.handle('extract-page-content', async (ev, data) => {
    try {
      const { url } = data;
      if (!url) return { success: false, error: 'URL required' };

      const normalizedTarget = normalizeUrl(url);
      const allContents = webContents.getAllWebContents();

      // Phase 1: Exact match (direct URL or normalized URL)
      let target = allContents.find(wc => {
        try {
          const wcUrl = wc.getURL();
          if (!wcUrl || wcUrl.startsWith('peek://') || wcUrl === 'about:blank') return false;
          return wcUrl === url || normalizeUrl(wcUrl) === normalizedTarget;
        } catch { return false; }
      });

      // Phase 2: If no exact match, try matching by origin+pathname (ignoring query/hash)
      // This handles cases where the page redirected or query params changed
      if (!target) {
        try {
          const targetParsed = new URL(url);
          const targetOriginPath = targetParsed.origin + targetParsed.pathname;
          target = allContents.find(wc => {
            try {
              const wcUrl = wc.getURL();
              if (!wcUrl || wcUrl.startsWith('peek://') || wcUrl === 'about:blank') return false;
              const wcParsed = new URL(wcUrl);
              return wcParsed.origin + wcParsed.pathname === targetOriginPath;
            } catch { return false; }
          });
        } catch { /* invalid URL, skip phase 2 */ }
      }

      // Phase 3: If still no match, try matching by domain (for redirects like http->https, www->non-www)
      if (!target) {
        try {
          const targetDomain = new URL(url).hostname.replace(/^www\./, '');
          // Find any http/https webContents with matching base domain
          const candidates = allContents.filter(wc => {
            try {
              const wcUrl = wc.getURL();
              if (!wcUrl || !wcUrl.startsWith('http')) return false;
              const wcDomain = new URL(wcUrl).hostname.replace(/^www\./, '');
              return wcDomain === targetDomain;
            } catch { return false; }
          });
          // Pick the most recently created one (likely the active page)
          if (candidates.length === 1) {
            target = candidates[0];
          }
        } catch { /* invalid URL, skip phase 3 */ }
      }

      if (!target) {
        return { success: false, error: 'No webContents found for URL' };
      }

      const result = await target.executeJavaScript(`
        (function() {
          return {
            html: document.documentElement.outerHTML,
            text: document.body ? document.body.innerText.slice(0, 50000) : '',
            title: document.title || ''
          };
        })();
      `);

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
  registerDarkModeSettingHandlers();
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
function setDarkModeSetting(value: string): void {
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
 * Register dark mode setting IPC handlers
 */
function registerDarkModeSettingHandlers(): void {
  // Get current dark mode setting
  ipcMain.handle('darkMode:get', () => {
    const mode = getDarkModeSetting();
    return {
      success: true,
      data: {
        mode,
        // Tier 2 (WebContentsForceDark) requires app restart to take effect
        tier2Active: app.commandLine.hasSwitch('enable-features') &&
          (app.commandLine.getSwitchValue('enable-features') || '').includes('WebContentsForceDark'),
      }
    };
  });

  // Set dark mode setting
  ipcMain.handle('darkMode:set', (_ev, mode: string) => {
    if (!['off', 'system', 'force'].includes(mode)) {
      return { success: false, error: 'Invalid dark mode value. Must be "off", "system", or "force".' };
    }

    const previousMode = getDarkModeSetting();
    setDarkModeSetting(mode);

    // Apply Tier 1 immediately (nativeTheme)
    applyDarkModeSetting(mode);

    // Check if Tier 2 change requires restart
    const tier2Changed = (previousMode === 'force') !== (mode === 'force');

    // Broadcast change to all windows
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.webContents.send('darkMode:changed', { mode });
    }

    return {
      success: true,
      data: {
        mode,
        restartRequired: tier2Changed,
      }
    };
  });
}

/**
 * Register window management IPC handlers
 */
const pendingWindowKeys = new Set<string>();

export function registerWindowHandlers(): void {
  ipcMain.handle('window-open', async (ev, msg) => {
    DEBUG && console.log('window-open', msg);

    const { url, options } = msg;

    // Always log escapeMode for debugging window lifecycle
    console.log(`[window-open] url: ${url}, source: ${msg.source}, escapeMode: ${options?.escapeMode}, key: ${options?.key}, options keys: ${options ? Object.keys(options).join(',') : 'none'}`);

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
          existingWindow.window.show();
          existingWindow.window.focus();
        }
        return { success: true, id: existingWindow.id, reused: true };
      }

      // Mark this key as pending creation
      pendingWindowKeys.add(fullKey);
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

    // Determine if this web page should use the fullscreen transparent canvas model.
    // Canvas pages get a fullscreen transparent BrowserWindow where all UI elements
    // (webview, navbar, resize handle) are positioned via JS on an invisible surface.
    // Non-canvas web pages (modals, quick-views, overlays) load their URL directly.
    const isModalOrQuickView = options.modal === true || options.overlay === true;
    const hasNonContentRole = options.role && !['content', 'child-content'].includes(options.role as string);
    const useCanvas = isWebPage && !isModalOrQuickView && !hasNonContentRole;

    // Use profile-specific session for isolation
    const profileSession = getProfileSession();

    // Prepare browser window options
    const winOptions: Electron.BrowserWindowConstructorOptions = {
      frame: isWebPage ? false : frameDefault, // Web pages are always frameless
      ...options,
      width: parseInt(options.width) || (getPrefs().pageWidth as number) || APP_DEF_WIDTH,
      height: parseInt(options.height) || (getPrefs().pageHeight as number) || APP_DEF_HEIGHT,
      show: isHeadless() ? false : options.show !== false,
      // Canvas pages: transparent minimal window, no shadow, no OS resize (we handle it via setBounds)
      transparent: useCanvas ? true : (options.transparent || false),
      backgroundColor: (useCanvas || options.transparent) ? undefined : getSystemThemeBackgroundColor(),
      ...(useCanvas ? { hasShadow: false, resizable: false } : {}),
      webPreferences: {
        ...options.webPreferences,
        preload: getPreloadPath(),
        session: profileSession,
        webviewTag: useCanvas ? true : (options.webPreferences?.webviewTag || false),
      }
    };

    // Apply explicit position parameters (used by session restore and direct callers)
    if (options.x !== undefined) {
      winOptions.x = parseInt(options.x);
    }
    if (options.y !== undefined) {
      winOptions.y = parseInt(options.y);
    }

    // Determine opener window and whether it's a real content parent
    // Background/infrastructure windows (background.html, extension-host.html) are
    // not real parents — they're just the IPC sender. Only content windows count
    // as parents for IZUI child-window semantics (ESC closes child, focuses parent).
    const openerWindow = BrowserWindow.fromWebContents(ev.sender);
    const INTERNAL_URLS = ['peek://app/background.html', 'peek://app/extension-host.html'];
    const openerUrl = openerWindow && !openerWindow.isDestroyed() ? openerWindow.webContents?.getURL() ?? '' : '';
    const isRealParent = openerWindow && !openerWindow.isDestroyed() && !INTERNAL_URLS.some(u => openerUrl === u);

    // Center window on parent if opener exists and no explicit position
    // Priority: explicit x/y > center on parent > center on screen
    if (options.centerOnParent !== false &&
        isRealParent &&
        winOptions.x === undefined && winOptions.y === undefined) {
      const bounds = openerWindow.getBounds();
      const winW = winOptions.width as number || APP_DEF_WIDTH;
      const winH = winOptions.height as number || APP_DEF_HEIGHT;
      winOptions.x = Math.round(bounds.x + (bounds.width - winW) / 2);
      winOptions.y = Math.round(bounds.y + (bounds.height - winH) / 2);
      DEBUG && console.log('[window-open] Centered on parent window:', openerWindow.id, 'at', winOptions.x, winOptions.y);
    }

    // Center window on screen if no position specified (fallback when no opener)
    if (winOptions.x === undefined && winOptions.y === undefined) {
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width: screenW, height: screenH } = primaryDisplay.workAreaSize;
      const winW = winOptions.width as number || APP_DEF_WIDTH;
      const winH = winOptions.height as number || APP_DEF_HEIGHT;
      winOptions.x = Math.round((screenW - winW) / 2);
      winOptions.y = Math.round((screenH - winH) / 2);
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

    // For canvas pages, adjust window bounds BEFORE creation to include margins
    // and trigger zone. This prevents a visual flash where the window appears at
    // the webview coordinates then jumps to the correct position.
    // Save the original webview screen coordinates for URL params.
    let canvasWebviewBounds: { x: number; y: number; width: number; height: number } | null = null;
    if (useCanvas && !isHeadless()) {
      const CANVAS_MARGIN = 8;
      const CANVAS_TRIGGER_ZONE = 8;
      const CANVAS_NAVBAR_HEIGHT = 36; // Always reserve space for navbar (avoids resize jumps)
      // winOptions.x/y/width/height are currently the webview screen coordinates
      canvasWebviewBounds = {
        x: winOptions.x as number,
        y: winOptions.y as number,
        width: winOptions.width as number,
        height: winOptions.height as number,
      };
      winOptions.x = canvasWebviewBounds.x - CANVAS_MARGIN;
      winOptions.y = canvasWebviewBounds.y - CANVAS_TRIGGER_ZONE - CANVAS_NAVBAR_HEIGHT;
      winOptions.width = canvasWebviewBounds.width + CANVAS_MARGIN * 2;
      winOptions.height = canvasWebviewBounds.height + CANVAS_TRIGGER_ZONE + CANVAS_MARGIN + CANVAS_NAVBAR_HEIGHT;
    }

    DEBUG && console.log('Creating window with options:', winOptions);
    console.log(`[window-open:bounds] url=${url.substring(0, 80)} final position: (${winOptions.x},${winOptions.y}) ${winOptions.width}x${winOptions.height}${useCanvas ? " [canvas]" : ""}`);

    // Pass through optional BrowserWindow properties from caller
    if (options.alwaysOnTop !== undefined) winOptions.alwaysOnTop = !!options.alwaysOnTop;
    if (options.focusable !== undefined) winOptions.focusable = !!options.focusable;
    if (options.skipTaskbar !== undefined) winOptions.skipTaskbar = !!options.skipTaskbar;
    if (options.hasShadow !== undefined && !useCanvas) winOptions.hasShadow = !!options.hasShadow;

    // Create new window
    const win = new BrowserWindow(winOptions);
    { const actualBounds = win.getBounds(); console.log(`[window-open:actual] Window ${win.id} actual bounds after creation: (${actualBounds.x},${actualBounds.y}) ${actualBounds.width}x${actualBounds.height}`); }

    // Reinforce alwaysOnTop after creation — on macOS the constructor flag alone
    // is unreliable; calling setAlwaysOnTop with 'floating' level ensures it stays
    // above regular windows.
    if (options.alwaysOnTop) {
      win.setAlwaysOnTop(true, 'floating');
      DEBUG && console.log('[window-open] Set alwaysOnTop floating for window', win.id);
    }

    // Track window position for display-watcher home display restoration
    trackWindow(win);

    // Forward console logs from window to main process stdout (for debugging)
    win.webContents.on('console-message', (event) => {
      // Only forward for peek:// URLs to avoid noise
      if (url.startsWith('peek://')) {
        DEBUG && console.log(`[${url.replace('peek://', '')}] ${event.message}`);
      }
    });

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
      const parentWindowId = isRealParent ? openerWindow!.id : null;

      // Phase 1: Compute IZUI role from existing params if not explicitly provided
      let role = options.role as string | undefined;
      if (!role) {
        if (options.overlay === true) {
          role = 'overlay';
        } else if (options.modal === true && options.keepLive === true) {
          role = 'palette';
        } else if (options.modal === true) {
          role = 'quick-view';
        } else if (options.escapeMode === 'navigate') {
          role = 'workspace';
        } else if (parentWindowId != null && isWebPage) {
          role = 'child-content';
        } else if (isWebPage) {
          role = 'content';
        } else {
          role = 'utility';
        }
      }

      // Phase 2: Promote 'content' to 'child-content' when opened from a real parent.
      // Extensions may explicitly pass role:'content' for web pages, but if the IPC
      // sender is a visible window (not background/extension-host), the opened page
      // is semantically a child — ESC should close it and return to the parent.
      if (role === 'content' && parentWindowId != null) {
        console.log(`[izui] Promoting content -> child-content (parent: ${parentWindowId})`);
        role = 'child-content';
      }

      console.log('[izui] Window role:', role, 'for:', url);

      const windowParams = {
        ...options,
        address: url,
        transient: isTransient,
        parentWindowId,
        role,
      };
      console.log('Adding window to manager:', win.id, 'escapeMode:', windowParams.escapeMode, 'modal:', windowParams.modal, 'keepLive:', windowParams.keepLive, 'transient:', isTransient);
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
        } else if (lastFocusedVisibleWindowId) {
          // Fallback: check lastFocusedVisibleWindowId for group mode
          // This handles the case where a non-group window (e.g. cmd palette)
          // opens a URL while the user was previously focused on a group window
          const lastVisibleContext = getContextEntry('mode', lastFocusedVisibleWindowId);
          if (lastVisibleContext && lastVisibleContext.value === 'group' && lastVisibleContext.metadata) {
            addContextEntry('mode', 'group', {
              windowId: win.id,
              source: msg.source,
              metadata: {
                ...lastVisibleContext.metadata,
                url: modeUrl,
                inheritedFrom: lastFocusedVisibleWindowId
              }
            });
            console.log('[openWindow] Inherited group mode from lastFocusedVisibleWindow:', lastFocusedVisibleWindowId, lastVisibleContext.metadata?.groupName);
          } else {
            const detectedMode = detectModeFromUrl(modeUrl);
            addContextEntry('mode', detectedMode, {
              windowId: win.id,
              source: msg.source,
              metadata: { url: modeUrl }
            });
          }
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

      // Load the URL AFTER mode/context is set, so page.js can read inherited mode
      await win.loadURL(loadUrl);

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

      // Update item titles when the page finishes loading (non-canvas web pages).
      // Canvas pages have a guest webContents handler below via did-attach-webview.
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
            publish('system', PubSubScopes.GLOBAL, 'page:content-ready', {
              url: pageUrl,
              title,
              windowId: win.id,
            });
          }
        });
      }

      // Track this load in history (skip internal peek:// URLs)
      if (!url.startsWith('peek://')) {
        try {
          const trackResult = trackWindowLoad(url, {
            source: options.trackingSource || options.feature || 'window',
            sourceId: options.trackingSourceId || '',
            windowType: options.modal ? 'modal' : 'main',
            title: options.title || (win.getTitle() !== 'Loading...' ? win.getTitle() : '') || '',
          });
          if (trackResult.created) {
            publish('system', PubSubScopes.GLOBAL, 'item:created', {
              itemId: trackResult.itemId,
              itemType: 'url',
              content: url
            });
          }
          // Auto-tag with group if this window is in group mode
          const loadModeEntry = getContextEntry('mode', win.id);
          console.log('[openWindow] trackWindowLoad auto-tag check:', { winId: win.id, mode: loadModeEntry?.value, groupId: loadModeEntry?.metadata?.groupId, itemId: trackResult.itemId });
          if (loadModeEntry && loadModeEntry.value === 'group' && loadModeEntry.metadata?.groupId) {
            tagItemAndPublish(trackResult.itemId, loadModeEntry.metadata.groupId as string);
            console.log('[openWindow] Auto-tagged item', trackResult.itemId, 'with group', loadModeEntry.metadata.groupId);
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
        try {
          const navTrack = trackWindowLoad(navUrl, {
            source: 'navigation',
            sourceId: '',
            windowType: options.modal ? 'modal' : 'main',
            title: (win.getTitle() !== 'Loading...' ? win.getTitle() : '') || '',
          });
          if (navTrack.created) {
            publish('system', PubSubScopes.GLOBAL, 'item:created', {
              itemId: navTrack.itemId,
              itemType: 'url',
              content: navUrl
            });
          }
          // Auto-tag with group if this window is in group mode
          const navModeEntry = getContextEntry('mode', win.id);
          if (navModeEntry && navModeEntry.value === 'group' && navModeEntry.metadata?.groupId) {
            tagItemAndPublish(navTrack.itemId, navModeEntry.metadata.groupId as string);
            DEBUG && console.log('[did-navigate] Auto-tagged item', navTrack.itemId, 'with group', navModeEntry.metadata.groupId);
          }
        } catch (e) {
          DEBUG && console.log('Failed to track did-navigate:', e);
        }
      });

      // Handle window.open() / target="_blank" from <webview> guest webContents.
      // The host BrowserWindow loads peek://app/page/index.html which contains a <webview>.
      // Keystrokes and window.open() calls from web content go to the guest's webContents,
      // NOT the host's. We use did-attach-webview to intercept when the guest attaches
      // and set up a setWindowOpenHandler that routes popups through Peek's window system
      // instead of letting Electron create raw default BrowserWindows.
      //
      // Also adds Cmd+L interception on guest webContents for the floating navbar.
      // (Keystrokes inside the webview never reach the host's before-input-event.)
      // Only canvas pages have a <webview> guest — set up popup/Cmd+L handlers
      if (useCanvas) {
        win.webContents.on('did-attach-webview', (_event, guestWebContents) => {
          console.log(`[webview-popup] Guest webContents attached to window ${win.id}, adding setWindowOpenHandler + Cmd+L`);

          // Keyboard shortcuts inside the webview guest for page navigation
          guestWebContents.on('before-input-event', (event, input) => {
            if (input.type !== 'keyDown' || !input.meta) return;
            if (input.key === 'l') {
              publish('peek://system/', PubSubScopes.GLOBAL, 'page:show-navbar', { windowId: win.id });
              event.preventDefault();
            } else if (input.key === 'r') {
              publish('peek://system/', PubSubScopes.GLOBAL, 'page:reload', { windowId: win.id });
              event.preventDefault();
            } else if (input.key === '[' || (input.key === 'ArrowLeft' && !input.shift)) {
              publish('peek://system/', PubSubScopes.GLOBAL, 'page:go-back', { windowId: win.id });
              event.preventDefault();
            } else if (input.key === ']' || (input.key === 'ArrowRight' && !input.shift)) {
              publish('peek://system/', PubSubScopes.GLOBAL, 'page:go-forward', { windowId: win.id });
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
                publish('system', PubSubScopes.GLOBAL, 'page:content-ready', {
                  url: guestUrl,
                  title,
                  windowId: win.id,
                });
              }
            }
          });

          guestWebContents.setWindowOpenHandler(({ url: popupUrl }) => {
            if (popupUrl.startsWith('http://') || popupUrl.startsWith('https://')) {
              console.log(`[webview-popup] Intercepted popup from window ${win.id}: ${popupUrl}`);

              // Open asynchronously — create a proper Peek page container window.
              // This runs outside the synchronous handler return.
              (async () => {
                try {
                  // Track the popup URL in history
                  let popupItemId: string | undefined;
                  try {
                    const popupTrack = trackWindowLoad(popupUrl, {
                      source: 'window-open',
                      sourceId: url,
                      windowType: 'main',
                    });
                    popupItemId = popupTrack.itemId;
                    if (popupTrack.created) {
                      publish('system', PubSubScopes.GLOBAL, 'item:created', {
                        itemId: popupTrack.itemId,
                        itemType: 'url',
                        content: popupUrl
                      });
                    }
                  } catch (e) {
                    DEBUG && console.log('Failed to track webview popup:', e);
                  }

                  // Inherit group mode from parent window if applicable
                  let groupMode: { groupId: string; groupName: string; color: string } | undefined = undefined;
                  const parentContext = getContextEntry('mode', win.id);
                  if (parentContext && parentContext.value === 'group' && parentContext.metadata) {
                    groupMode = {
                      groupId: parentContext.metadata.groupId as string,
                      groupName: parentContext.metadata.groupName as string,
                      color: parentContext.metadata.color as string,
                    };
                    // Auto-tag popup item with the group tag
                    if (popupItemId) {
                      try {
                        tagItemAndPublish(popupItemId, groupMode.groupId);
                        DEBUG && console.log('[webview-popup] Auto-tagged popup item', popupItemId, 'with group', groupMode.groupId);
                      } catch (e) {
                        DEBUG && console.log('[webview-popup] Failed to auto-tag popup:', e);
                      }
                    }
                  }

                  // Get the source address from the parent window's registration
                  const parentInfo = getWindowInfo(win.id);
                  const source = parentInfo ? parentInfo.source : 'system';

                  // Get the opener's current URL for the window.opener shim
                  let openerUrl = url; // fallback to the registered URL
                  try {
                    openerUrl = guestWebContents.getURL() || url;
                  } catch (e) {
                    DEBUG && console.log('[webview-popup] Failed to get opener URL:', e);
                  }

                  // Build page container URL (includes openerUrl for the bridge shim)
                  const parentBounds = win.getBounds();
                  const pageParams = new URLSearchParams({
                    url: popupUrl,
                    x: String(parentBounds.x + 30),
                    y: String(parentBounds.y + 30),
                    width: String(1024),
                    height: String(768),
                    openerUrl,
                  });
                  const loadUrl = `peek://app/page/index.html?${pageParams.toString()}`;

                  // Determine IZUI session state for transient detection
                  const coordinator = getIzuiCoordinator();
                  const isTransient = coordinator.isTransient();
                  coordinator.evaluateOnShow();

                  // Use profile-specific session for isolation
                  const profileSession = getProfileSession();

                  // Create the new BrowserWindow (page container) with fullscreen canvas
                  const popupWin = new BrowserWindow({
                    frame: false,
                    width: 1024,
                    height: 768,
                    x: parentBounds.x + 30,
                    y: parentBounds.y + 30,
                    show: isHeadless() ? false : true,
                    transparent: true,
                    webPreferences: {
                      preload: getPreloadPath(),
                      session: profileSession,
                      webviewTag: true,
                    },
                  });

                  // Set up fullscreen transparent canvas for the popup
                  if (!isHeadless()) {
                    const popupDisplay = screen.getDisplayNearestPoint({ x: parentBounds.x + 30, y: parentBounds.y + 30 });
                    const { width: psw, height: psh } = popupDisplay.workAreaSize;
                    const { x: pdx, y: pdy } = popupDisplay.workArea;
                    popupWin.setSize(psw, psh);
                    popupWin.setPosition(pdx, pdy);
                    popupWin.setBackgroundColor('#00000000');
                  }

                  // Register in window manager with proper IZUI role
                  const popupParams: Record<string, unknown> = {
                    address: popupUrl,
                    transient: isTransient,
                    parentWindowId: win.id,
                    role: 'child-content',
                  };
                  if (groupMode) {
                    popupParams.groupMode = groupMode;
                  }
                  registerWindow(popupWin.id, source, popupParams);
                  trackWindow(popupWin);
                  coordinator.pushWindow(popupWin.id);

                  // Set mode context (inherit group mode or detect from URL)
                  if (groupMode) {
                    addContextEntry('mode', 'group', {
                      windowId: popupWin.id,
                      source,
                      metadata: { ...groupMode, url: popupUrl, inheritedFrom: win.id },
                    });
                  } else {
                    const detectedMode = detectModeFromUrl(popupUrl);
                    addContextEntry('mode', detectedMode, {
                      windowId: popupWin.id,
                      source,
                      metadata: { url: popupUrl },
                    });
                  }

                  // Store popup-to-opener mapping for the postMessage bridge
                  popupToOpener.set(popupWin.id, win.id);
                  popupWin.on('closed', () => {
                    popupToOpener.delete(popupWin.id);
                    DEBUG && console.log(`[webview-popup] Cleaned up opener mapping for popup ${popupWin.id}`);
                  });

                  // Load the page container URL
                  await popupWin.loadURL(loadUrl);

                  // Add ESC handler (also sets up did-attach-webview for the new window)
                  addEscHandler(popupWin);

                  // Update dock visibility
                  updateDockVisibility();

                  console.log(`[webview-popup] Created Peek window ${popupWin.id} for popup: ${popupUrl}`);
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
        });
      }

      // Add escape key handler to all windows
      addEscHandler(win);

      // Add keyboard shortcuts on the HOST webContents as a fallback.
      // The primary handlers are on the webview guest (added via did-attach-webview above).
      // These host-level handlers fire when the page container's own DOM has focus (rare,
      // but possible before the webview loads or if the user clicks outside the webview).
      if (useCanvas) {
        win.webContents.on('before-input-event', (event, input) => {
          if (input.type !== 'keyDown' || !input.meta) return;
          if (input.key === 'l') {
            publish('peek://system/', PubSubScopes.GLOBAL, 'page:show-navbar', { windowId: win.id });
            event.preventDefault();
          } else if (input.key === 'r') {
            publish('peek://system/', PubSubScopes.GLOBAL, 'page:reload', { windowId: win.id });
            event.preventDefault();
          } else if (input.key === '[' || (input.key === 'ArrowLeft' && !input.shift)) {
            publish('peek://system/', PubSubScopes.GLOBAL, 'page:go-back', { windowId: win.id });
            event.preventDefault();
          } else if (input.key === ']' || (input.key === 'ArrowRight' && !input.shift)) {
            publish('peek://system/', PubSubScopes.GLOBAL, 'page:go-forward', { windowId: win.id });
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
        // Notify HUD and other listeners that a window gained focus
        publish(getSystemAddress(), PubSubScopes.GLOBAL, 'window:focused', {
          id: win.id
        });
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
      // are still settling after window creation (can cause immediate close)
      if (options.modal === true) {
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
              }
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

      // Notify HUD and other listeners that a window was opened
      publish(getSystemAddress(), PubSubScopes.GLOBAL, 'window:opened', {
        id: win.id,
        url,
        source: msg.source
      });

      // Clear pending key now that window is registered
      if (options.key) {
        pendingWindowKeys.delete(`${msg.source}:${options.key}`);
      }

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

  ipcMain.handle('window-center', async (ev, msg) => {
    DEBUG && console.log('window-center', msg);

    try {
      let win: BrowserWindow | null = null;
      if (msg?.id) {
        win = BrowserWindow.fromId(msg.id);
      } else {
        const wc = ev.sender;
        win = BrowserWindow.fromWebContents(wc);
      }

      if (!win || win.isDestroyed()) {
        return { success: false, error: 'Window not found' };
      }

      const bounds = win.getBounds();
      const display = screen.getDisplayNearestPoint({
        x: bounds.x + Math.round(bounds.width / 2),
        y: bounds.y + Math.round(bounds.height / 2)
      });
      const wa = display.workArea;
      const x = wa.x + Math.round((wa.width - bounds.width) / 2);
      const y = wa.y + Math.round((wa.height - bounds.height) / 2);
      win.setBounds({ x, y, width: bounds.width, height: bounds.height });

      return { success: true };
    } catch (error) {
      console.error('Failed to center window:', error);
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('window-center-all', async () => {
    DEBUG && console.log('window-center-all');

    try {
      const windows = BrowserWindow.getAllWindows();
      let centered = 0;

      for (const win of windows) {
        if (win.isDestroyed() || !win.isVisible()) continue;

        const info = getWindowInfo(win.id);
        if (info?.params?.address === WEB_CORE_ADDRESS) continue;

        const bounds = win.getBounds();
        const display = screen.getDisplayNearestPoint({
          x: bounds.x + Math.round(bounds.width / 2),
          y: bounds.y + Math.round(bounds.height / 2)
        });
        const wa = display.workArea;
        const x = wa.x + Math.round((wa.width - bounds.width) / 2);
        const y = wa.y + Math.round((wa.height - bounds.height) / 2);
        win.setBounds({ x, y, width: bounds.width, height: bounds.height });
        centered++;
      }

      return { success: true, centered };
    } catch (error) {
      console.error('Failed to center all windows:', error);
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

  ipcMain.handle('window-set-bounds', (ev, msg) => {
    const win = BrowserWindow.fromWebContents(ev.sender);
    if (!win || win.isDestroyed()) return { success: false, error: 'Window not found' };
    const bounds = win.getBounds();
    win.setBounds({
      x: msg.x ?? bounds.x,
      y: msg.y ?? bounds.y,
      width: msg.width ?? bounds.width,
      height: msg.height ?? bounds.height,
    });
    return { success: true };
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

  // ========================================================================
  // Popup-to-Opener Bridge (OAuth / window.opener shim) — IPC handlers
  // ========================================================================

  // Route postMessage from a popup's webview to the opener's webview.
  // Called by the popup's page.js when it picks up __PEEK_OPENER_POSTMESSAGE__
  // from the console-message bridge.
  ipcMain.handle('opener-postmessage', (ev, data) => {
    const senderWin = BrowserWindow.fromWebContents(ev.sender);
    if (!senderWin) return { success: false, error: 'No sender window' };

    const openerWindowId = popupToOpener.get(senderWin.id);
    if (!openerWindowId) {
      DEBUG && console.log('[opener-bridge] No opener mapping for window', senderWin.id);
      return { success: false, error: 'No opener window mapped' };
    }

    const openerWin = BrowserWindow.fromId(openerWindowId);
    if (!openerWin || openerWin.isDestroyed()) {
      DEBUG && console.log('[opener-bridge] Opener window', openerWindowId, 'not found or destroyed');
      popupToOpener.delete(senderWin.id);
      return { success: false, error: 'Opener window not found' };
    }

    // Forward the message to the opener's renderer (page.js)
    // page.js listens for 'opener-message-received' via api.ipc.on()
    openerWin.webContents.send('opener-message-received', {
      message: data.message,
      origin: data.origin || '*',
      popupWindowId: senderWin.id,
    });

    DEBUG && console.log(`[opener-bridge] Routed postMessage from popup ${senderWin.id} to opener ${openerWindowId}`);
    return { success: true };
  });

  // Route opener.close() from a popup to close the opener window.
  ipcMain.handle('opener-close', (ev) => {
    const senderWin = BrowserWindow.fromWebContents(ev.sender);
    if (!senderWin) return { success: false, error: 'No sender window' };

    const openerWindowId = popupToOpener.get(senderWin.id);
    if (!openerWindowId) return { success: false, error: 'No opener mapped' };

    const openerWin = BrowserWindow.fromId(openerWindowId);
    if (!openerWin || openerWin.isDestroyed()) {
      popupToOpener.delete(senderWin.id);
      return { success: false, error: 'Opener window not found' };
    }

    DEBUG && console.log(`[opener-bridge] Popup ${senderWin.id} requested opener.close() on ${openerWindowId}`);
    closeOrHideWindow(openerWin.id);
    return { success: true };
  });

  // Route opener.focus() from a popup to focus the opener window.
  ipcMain.handle('opener-focus', (ev) => {
    const senderWin = BrowserWindow.fromWebContents(ev.sender);
    if (!senderWin) return { success: false, error: 'No sender window' };

    const openerWindowId = popupToOpener.get(senderWin.id);
    if (!openerWindowId) return { success: false, error: 'No opener mapped' };

    const openerWin = BrowserWindow.fromId(openerWindowId);
    if (!openerWin || openerWin.isDestroyed()) {
      popupToOpener.delete(senderWin.id);
      return { success: false, error: 'Opener window not found' };
    }

    DEBUG && console.log(`[opener-bridge] Popup ${senderWin.id} requested opener.focus() on ${openerWindowId}`);
    openerWin.show();
    openerWin.focus();
    return { success: true };
  });
}

/**
 * Register miscellaneous IPC handlers (shortcuts, pubsub, commands, etc.)
 */
export function registerMiscHandlers(onQuit: () => void): void {
  // Renderer log forwarding - prints renderer console.log to terminal
  ipcMain.on(IPC_CHANNELS.RENDERER_LOG, (_ev, msg) => {
    const shortSource = msg.source?.replace('peek://app/', '').replace('peek://ext/', 'ext/') || 'unknown';
    console.log(`[${shortSource}]`, ...(msg.args || []));
  });

  // Get current window ID (the window that sent the IPC message)
  ipcMain.handle('get-window-id', (ev) => {
    const win = BrowserWindow.fromWebContents(ev.sender);
    return win ? win.id : null;
  });

  // Get app-level preferences
  ipcMain.handle('get-app-prefs', () => {
    return getPrefs();
  });

  // Check if current window is transient (opened when app wasn't focused)
  // Used for IZUI policy: transient windows have different escape/mode behavior
  ipcMain.handle('window-is-transient', (ev) => {
    const win = BrowserWindow.fromWebContents(ev.sender);
    if (!win) return false;
    const windowData = getWindowInfo(win.id);
    return windowData?.params?.transient === true;
  });

  // ============================================================================
  // IZUI State Coordinator IPC Handlers
  // ============================================================================
  // Centralized IZUI state management for consistent transient detection,
  // mode display, and ESC behavior across all windows.

  // Check if IZUI session is in transient mode (app wasn't focused when invoked)
  // Uses the session's entry mode which was set at window show time (before focus
  // was stolen). Don't re-evaluate here - by this point the requesting window
  // (e.g., cmd panel) has already stolen focus from other windows, making
  // isFocused() checks unreliable.
  ipcMain.handle('izui-is-transient', (ev) => {
    const coordinator = getIzuiCoordinator();
    const requestingWindow = BrowserWindow.fromWebContents(ev.sender);
    // Use session entry mode if available (set correctly at show time)
    const session = coordinator.getSession();
    if (session) {
      const result = coordinator.isTransient();
      DEBUG && console.log('[izui] izui-is-transient (session):', result, 'windowId:', requestingWindow?.id, 'entryMode:', session.entryMode);
      return result;
    }
    // No session yet - evaluate fresh (excluding requesting window)
    const entryMode = coordinator.evaluateOnShow(requestingWindow?.id);
    const result = entryMode === 'transient';
    DEBUG && console.log('[izui] izui-is-transient (fresh):', result, 'windowId:', requestingWindow?.id);
    return result;
  });

  // Get the effective mode for display
  // Returns 'default' for transient sessions, 'active' otherwise (caller resolves actual mode)
  ipcMain.handle('izui-get-effective-mode', () => {
    const coordinator = getIzuiCoordinator();
    return coordinator.getEffectiveMode();
  });

  // Get the current IZUI state (idle, transient, active, overlay)
  ipcMain.handle('izui-get-state', () => {
    const coordinator = getIzuiCoordinator();
    return coordinator.getState();
  });

  // IZUI: renderer requests its own window to close/hide (navigate mode)
  // Goes through closeOrHideWindow for proper keepLive/modal/child handling
  ipcMain.handle('izui-close-self', (ev) => {
    const win = BrowserWindow.fromWebContents(ev.sender);
    if (win && !win.isDestroyed()) {
      console.log('[izui] izui-close-self for window:', win.id);
      closeOrHideWindow(win.id);
      return { success: true };
    }
    return { success: false, error: 'Window not found' };
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
  //
  // The callback closure captures the IpcMainEvent so ev.reply() can route
  // the response back to the correct sender frame at callback time.
  //
  // ev.reply() internally uses sender.sendToFrame(frameId, ...) which correctly
  // handles both:
  //   - Normal BrowserWindow senders (main frame)
  //   - Iframe sub-frame senders (consolidated extensions in extension-host.html)
  //
  // We guard against destroyed senders (extension reload, iframe removed from DOM)
  // to prevent uncaught exceptions. The previous approaches that failed:
  //   - BrowserWindow.fromId(ev.sender.id): wrong ID space (WebContents vs Window)
  //   - BrowserWindow.fromWebContents(ev.sender): returns null for iframe senders
  //   - webContents.fromId(id): does not find sub-frame WebContents
  //   - sender.send(): sends to main frame only, not the specific iframe
  ipcMain.on(IPC_CHANNELS.REGISTER_SHORTCUT, (ev, msg) => {
    const isGlobal = msg.global === true;
    const modeStr = msg.mode ? ` mode:${msg.mode}` : '';
    DEBUG && console.log('ipc register shortcut', msg.shortcut, isGlobal ? '(global)' : '(local)', modeStr);

    const callback = () => {
      DEBUG && console.log('on(registershortcut): shortcut executed', msg.shortcut, msg.replyTopic);
      try {
        if (!ev.sender.isDestroyed()) {
          ev.reply(msg.replyTopic, { foo: 'bar' });
        } else {
          DEBUG && console.log('on(registershortcut): sender destroyed, skipping reply for', msg.shortcut);
        }
      } catch (err) {
        // Guard against edge cases where sender state changes between check and send
        DEBUG && console.log('on(registershortcut): reply failed for', msg.shortcut, err);
      }
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

      // Parent the dialog to a visible window to avoid showing hidden background pages.
      // Prefer the focused window; fall back to sender's window only if it's visible.
      const senderWindow = BrowserWindow.fromWebContents(ev.sender);
      const focusedWindow = BrowserWindow.getFocusedWindow();
      const parentWindow = focusedWindow && !focusedWindow.isDestroyed()
        ? focusedWindow
        : (senderWindow && !senderWindow.isDestroyed() && senderWindow.isVisible() ? senderWindow : null);

      const dialogOpts: Electron.SaveDialogOptions = {
        defaultPath: data.filename,
        filters,
      };
      const result = parentWindow
        ? await dialog.showSaveDialog(parentWindow, dialogOpts)
        : await dialog.showSaveDialog(dialogOpts);

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

  // File open dialog - shows native open dialog, reads file, returns content + metadata
  ipcMain.handle('file-open-dialog', async (ev) => {
    try {
      // Parent the dialog to a visible window to avoid showing hidden background pages.
      const senderWindow = BrowserWindow.fromWebContents(ev.sender);
      const focusedWindow = BrowserWindow.getFocusedWindow();
      const parentWindow = focusedWindow && !focusedWindow.isDestroyed()
        ? focusedWindow
        : (senderWindow && !senderWindow.isDestroyed() && senderWindow.isVisible() ? senderWindow : null);

      const openDialogOpts: Electron.OpenDialogOptions = {
        properties: ['openFile'],
        filters: [
          { name: 'All Files', extensions: ['*'] },
          { name: 'Text Files', extensions: ['txt', 'md', 'json', 'html', 'csv', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'log'] },
          { name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'rtf'] },
        ]
      };
      const result = parentWindow
        ? await dialog.showOpenDialog(parentWindow, openDialogOpts)
        : await dialog.showOpenDialog(openDialogOpts);

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      const filePath = result.filePaths[0];
      const stats = fs.statSync(filePath);
      const fileName = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase();

      // MIME type detection from extension
      const extToMime: Record<string, string> = {
        '.md': 'text/markdown',
        '.markdown': 'text/markdown',
        '.txt': 'text/plain',
        '.text': 'text/plain',
        '.json': 'application/json',
        '.html': 'text/html',
        '.htm': 'text/html',
        '.csv': 'text/csv',
        '.xml': 'application/xml',
        '.yaml': 'text/yaml',
        '.yml': 'text/yaml',
        '.toml': 'text/plain',
        '.ini': 'text/plain',
        '.cfg': 'text/plain',
        '.log': 'text/plain',
        '.js': 'text/javascript',
        '.ts': 'text/typescript',
        '.css': 'text/css',
        '.py': 'text/x-python',
        '.rb': 'text/x-ruby',
        '.sh': 'text/x-shellscript',
        '.bash': 'text/x-shellscript',
        '.zsh': 'text/x-shellscript',
        '.c': 'text/x-c',
        '.cpp': 'text/x-c++',
        '.h': 'text/x-c',
        '.java': 'text/x-java',
        '.go': 'text/x-go',
        '.rs': 'text/x-rust',
        '.swift': 'text/x-swift',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.pdf': 'application/pdf',
      };

      const mimeType = extToMime[ext] || 'application/octet-stream';

      // Only read text files (don't try to read binary files as UTF-8)
      const isText = mimeType.startsWith('text/') ||
                     mimeType === 'application/json' ||
                     mimeType === 'application/xml' ||
                     mimeType === 'image/svg+xml';

      let content: string | null = null;
      if (isText) {
        content = fs.readFileSync(filePath, 'utf-8');
      }

      return {
        success: true,
        data: {
          name: fileName,
          path: filePath,
          size: stats.size,
          mimeType,
          content,
          isText
        }
      };
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

  // Net fetch handler - proxies HTTP requests through main process to bypass CORS
  // Used by extensions that need to fetch from external APIs (e.g., search suggestions)
  ipcMain.handle('net-fetch', async (_ev, data: { url: string; options?: { method?: string; headers?: Record<string, string>; timeout?: number } }) => {
    try {
      const { url, options = {} } = data;

      // Only allow http/https URLs
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return { success: false, error: 'Only http/https URLs are allowed' };
      }

      const controller = new AbortController();
      const timeout = options.timeout || 5000;
      const timer = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await net.fetch(url, {
          method: options.method || 'GET',
          headers: options.headers || {},
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!response.ok) {
          return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
        }

        const text = await response.text();
        return { success: true, data: text, status: response.status };
      } catch (fetchErr) {
        clearTimeout(timer);
        const fetchMessage = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        return { success: false, error: fetchMessage };
      }
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

      // Notify all windows that sync pulled new data so they can refresh
      if (result.pulled > 0) {
        publish('system', PubSubScopes.GLOBAL, 'sync:pull-completed', {
          pulled: result.pulled,
          conflicts: result.conflicts
        });
      }

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

      // Notify all windows that sync pulled new data so they can refresh
      if (result.pulled > 0) {
        publish('system', PubSubScopes.GLOBAL, 'sync:pull-completed', {
          pulled: result.pulled,
          pushed: result.pushed,
          conflicts: result.conflicts
        });
      }

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

      // If no windowId provided (or null from preload default), use calling window
      if (windowId == null) {
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

      // If no windowId provided (or null from preload default), use calling window
      if (windowId == null) {
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

  // Get UI entry points for all loaded chrome extensions
  ipcMain.handle('chrome-ext:getUiEntries', async () => {
    try {
      const { getChromeExtensionUiEntries } = await import('./chrome-extensions.js');
      const entries = getChromeExtensionUiEntries();
      return { success: true, data: entries };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Open a chrome extension's options page or popup in a window
  ipcMain.handle('chrome-ext:openPage', async (_ev, data: { id: string; type: 'options' | 'popup' }) => {
    try {
      const { openChromeExtensionPage } = await import('./chrome-extensions.js');
      const win = openChromeExtensionPage(data.id, data.type);
      if (win) {
        return { success: true, data: { windowId: win.id } };
      }
      return { success: false, error: `No ${data.type} page available for extension: ${data.id}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  DEBUG && console.log('[ipc] Web extension handlers registered');
}

// ============================================================================
// Session Handlers (manual save/restore from renderer)
// ============================================================================

function registerSessionHandlers(): void {
  // Manual session save
  ipcMain.handle('session-save', async () => {
    try {
      saveSessionSnapshot('manual');
      return { success: true, message: 'Session saved' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Get snapshot info (window count) without restoring
  ipcMain.handle('session-get-snapshot-info', () => {
    try {
      const info = getSessionSnapshotInfo();
      if (!info) return { success: true, data: null };
      return { success: true, data: info };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Manual session restore (restores on top of existing windows)
  // Skip crash dialog — user explicitly requested restore
  ipcMain.handle('session-restore', async () => {
    try {
      const prefs = getPrefs();
      const result = await restoreSessionSnapshot(prefs, { cleanShutdown: true, crashCount: 0 });
      return {
        success: true,
        message: `Restored ${result.restored} of ${result.total} window(s)`,
        ...result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  // Interactive session restore — shows confirmation dialog before restoring
  // Skip crash dialog — this handler shows its own confirmation dialog
  ipcMain.handle('session-restore-interactive', async () => {
    try {
      const info = getSessionSnapshotInfo();
      if (!info) {
        return { success: true, message: 'No saved session to restore', cancelled: false, restored: 0 };
      }

      const { response } = await dialog.showMessageBox({
        type: 'question',
        title: 'Restore Previous Session',
        message: `Restore ${info.windowCount} window${info.windowCount === 1 ? '' : 's'} from your previous session?\n\nThese will open alongside your current windows.`,
        buttons: ['Restore', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      });

      if (response !== 0) {
        return { success: true, message: 'Restore cancelled', cancelled: true, restored: 0 };
      }

      const prefs = getPrefs();
      const result = await restoreSessionSnapshot(prefs, { cleanShutdown: true, crashCount: 0 });
      return {
        success: true,
        message: `Restored ${result.restored} of ${result.total} window(s)`,
        cancelled: false,
        ...result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  DEBUG && console.log('[ipc] Session handlers registered');
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
  registerSessionHandlers();
  registerMiscHandlers(onQuit);
}
