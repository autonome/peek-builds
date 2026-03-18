/**
 * Groups Extension Background Script
 *
 * Tag-based grouping of URLs
 *
 * Runs in isolated extension process (peek://ext/groups/background.html)
 * Uses api.settings for datastore-backed settings storage
 */

import { id, labels, schemas, storageKeys, defaults } from './config.js';
import { registerNoun, unregisterNoun } from 'peek://ext/cmd/nouns.js';

const api = window.app;
const debug = api.debug;

console.log('[ext:groups] background', labels.name);

// Extension content is served from peek://ext/groups/
const address = 'peek://ext/groups/home.html';

// In-memory settings cache (loaded from datastore on init)
let currentSettings = {
  prefs: defaults.prefs
};

// Track the groups window ID for mode cleanup
let groupsWindowId = null;

// Track the current active group context
let activeGroupId = null;
let activeGroupName = null;

// Track suspended (hidden) group windows: groupId -> [windowId, ...]
const suspendedGroups = new Map();

/**
 * Load settings from datastore
 * @returns {Promise<{prefs: object}>}
 */
const loadSettings = async () => {
  const result = await api.settings.get();
  if (result.success && result.data) {
    return {
      prefs: result.data.prefs || defaults.prefs
    };
  }
  return { prefs: defaults.prefs };
};

/**
 * Save settings to datastore
 * @param {object} settings - Settings object with prefs
 */
const saveSettings = async (settings) => {
  const result = await api.settings.set(settings);
  if (!result.success) {
    console.error('[ext:groups] Failed to save settings:', result.error);
  }
};

let isOpeningGroups = false;
const openGroupsWindow = async () => {
  if (isOpeningGroups) return;
  isOpeningGroups = true;
  try {
    const height = 600;
    const width = 800;

    const params = {
      // IZUI role
      role: 'workspace',

      key: address,
      height,
      width,
      trackingSource: 'cmd',
      trackingSourceId: 'groups'
    };

    const window = await api.window.open(address, params);
    debug && console.log('[ext:groups] Groups window opened:', window);
    groupsWindowId = window?.id || null;
  } catch (error) {
    console.error('[ext:groups] Failed to open groups window:', error);
  } finally {
    isOpeningGroups = false;
  }
};

/**
 * Set group mode for a window via context API
 */
const setGroupMode = async (windowId, groupId, groupName, color = null) => {
  if (!api.context) {
    debug && console.log('[ext:groups] Context API not available');
    return;
  }

  try {
    await api.context.setMode('space', {
      windowId,
      metadata: {
        spaceId: groupId,
        spaceName: groupName,
        color
      }
    });
    debug && console.log(`[ext:groups] Set space mode for window ${windowId}: ${groupName}`);
  } catch (err) {
    console.error('[ext:groups] Failed to set group mode:', err);
  }
};

/**
 * Exit group mode for all windows in a group
 * Resets them back to their content-based mode (page/default)
 */
const exitGroupMode = async (groupId) => {
  if (!api.context) {
    debug && console.log('[ext:groups] Context API not available');
    return;
  }

  try {
    // Get all windows in this group
    const result = await api.context.getWindowsInSpace(groupId);
    if (!result.success || !result.data) return;

    const windowIds = result.data;
    debug && console.log(`[ext:groups] Exiting group mode for ${windowIds.length} windows`);

    // Reset each window to page mode (content-based)
    for (const windowId of windowIds) {
      await api.context.setMode('page', { windowId });
    }
  } catch (err) {
    console.error('[ext:groups] Failed to exit group mode:', err);
  }
};

/**
 * Resolve the current group from the active context or last focused window.
 * Returns { groupId, groupName } or null.
 */
const resolveCurrentGroup = async () => {
  if (activeGroupId) {
    return { groupId: activeGroupId, groupName: activeGroupName };
  }

  try {
    const targetWindowId = await api.window.getFocusedVisibleWindowId();
    if (targetWindowId) {
      const modeResult = await api.context.get('mode', targetWindowId);
      if (modeResult.success && modeResult.data?.value === 'space' && modeResult.data.metadata?.spaceId) {
        return {
          groupId: modeResult.data.metadata.spaceId,
          groupName: modeResult.data.metadata.spaceName || ''
        };
      }
    }
  } catch (err) {
    debug && console.log('[ext:groups] Failed to resolve current group:', err);
  }

  return null;
};

// ===== Close/Suspend Group =====

/**
 * Close (suspend) a group — hide all windows in the group context.
 * Saves window IDs so they can be restored later.
 * If no groupId given, uses the active group from the last focused window.
 */
const closeGroup = async (groupId = null, groupName = null) => {
  // Resolve group from active context if not specified
  if (!groupId) {
    const current = await resolveCurrentGroup();
    if (current) {
      groupId = current.groupId;
      groupName = current.groupName;
    }
  }

  if (!groupId) {
    return { success: false, error: 'No active group to close' };
  }

  // Save workspace layouts before hiding
  try {
    if (api.session?.saveSpaceWorkspaces) {
      await api.session.saveSpaceWorkspaces();
    }
  } catch (err) {
    debug && console.log('[ext:groups] Failed to save workspace before close:', err);
  }

  // Get all windows in this group
  const result = await api.context.getWindowsInSpace(groupId);
  if (!result.success || !result.data || result.data.length === 0) {
    return { success: false, error: 'No windows found in group' };
  }

  const windowIds = result.data;
  const hiddenIds = [];

  // Hide each window
  for (const windowId of windowIds) {
    try {
      await api.window.hide(windowId);
      hiddenIds.push(windowId);
    } catch (err) {
      debug && console.log(`[ext:groups] Failed to hide window ${windowId}:`, err);
    }
  }

  // Track suspended windows for restore
  suspendedGroups.set(groupId, hiddenIds);

  // Clear active group tracking if this was the active group
  if (activeGroupId === groupId) {
    activeGroupId = null;
    activeGroupName = null;
  }

  console.log(`[ext:groups] Closed group "${groupName || groupId}": hid ${hiddenIds.length} window(s)`);
  return { success: true, count: hiddenIds.length, groupId, groupName };
};

/**
 * Restore a suspended group — show all hidden windows.
 * Falls back to opening the group fresh if windows were destroyed.
 */
const restoreGroup = async (groupId, groupName = null) => {
  const hiddenIds = suspendedGroups.get(groupId);

  if (!hiddenIds || hiddenIds.length === 0) {
    // No suspended windows — open the group fresh
    if (groupName) {
      return openGroup(groupName);
    }
    return { success: false, error: 'Group not suspended and no name to open' };
  }

  let restoredCount = 0;
  const failedIds = [];

  for (const windowId of hiddenIds) {
    try {
      // Check if window still exists
      const exists = await api.window.exists(windowId);
      if (exists?.exists) {
        await api.window.show(windowId);
        restoredCount++;
      } else {
        failedIds.push(windowId);
      }
    } catch (err) {
      debug && console.log(`[ext:groups] Failed to show window ${windowId}:`, err);
      failedIds.push(windowId);
    }
  }

  // Clean up tracking
  suspendedGroups.delete(groupId);

  // If some windows were destroyed, re-open the group to fill in gaps
  if (failedIds.length > 0 && groupName) {
    console.log(`[ext:groups] ${failedIds.length} windows destroyed while suspended, re-opening group`);
    return openGroup(groupName);
  }

  // Update active group
  activeGroupId = groupId;
  activeGroupName = groupName;

  console.log(`[ext:groups] Restored group "${groupName || groupId}": showed ${restoredCount} window(s)`);
  return { success: true, count: restoredCount };
};

// ===== Switch Group =====

/**
 * Switch from the current group to a target group.
 * Closes (suspends) the current group, then opens (or restores) the target.
 */
const switchGroup = async (targetGroupName) => {
  if (!targetGroupName) {
    return { success: false, error: 'Usage: switch group <name>' };
  }

  // Resolve target group
  const tagsResult = await api.datastore.getTagsByFrecency();
  if (!tagsResult.success) {
    return { success: false, error: 'Failed to get tags' };
  }

  const targetTag = tagsResult.data.find(t => t.name.toLowerCase() === targetGroupName.toLowerCase());
  if (!targetTag) {
    return { success: false, error: `Group "${targetGroupName}" not found` };
  }

  // Close current group (if any)
  const current = await resolveCurrentGroup();
  if (current && current.groupId !== targetTag.id) {
    await closeGroup(current.groupId, current.groupName);
  }

  // Restore or open target group
  const result = await restoreGroup(targetTag.id, targetTag.name);
  console.log(`[ext:groups] Switched to group "${targetGroupName}"`);
  return result;
};

// ===== Pin Items =====

/**
 * Get pinned item IDs for a group.
 * Stored in feature_settings as 'pins:<groupId>'.
 */
const getPinnedItems = async (groupId) => {
  try {
    const result = await api.settings.getExtKey('groups', `pins:${groupId}`);
    if (result.success && result.data) {
      return Array.isArray(result.data) ? result.data : [];
    }
  } catch (err) {
    debug && console.log('[ext:groups] Failed to load pins:', err);
  }
  return [];
};

/**
 * Save pinned item IDs for a group.
 */
const savePinnedItems = async (groupId, pinnedItemIds) => {
  try {
    await api.settings.setKey(`pins:${groupId}`, pinnedItemIds);
  } catch (err) {
    console.error('[ext:groups] Failed to save pins:', err);
  }
};

/**
 * Pin an item (URL) in a group. The item must already be tagged with the group.
 * If no groupId is specified, uses the active group context.
 */
const pinItem = async (url, groupId = null) => {
  // Resolve group from context
  if (!groupId) {
    const current = await resolveCurrentGroup();
    if (current) {
      groupId = current.groupId;
    }
  }

  if (!groupId) {
    return { success: false, error: 'No active group context — open a group first' };
  }

  if (!url) {
    return { success: false, error: 'Usage: pin <url>' };
  }

  // Find the item for this URL
  const item = await getOrCreateUrlItem(url);
  if (!item) {
    return { success: false, error: 'Failed to find or create item for URL' };
  }

  // Load current pins and add
  const pins = await getPinnedItems(groupId);
  if (!pins.includes(item.id)) {
    pins.push(item.id);
    await savePinnedItems(groupId, pins);
  }

  // Publish event for UI reactivity
  api.publish('group:pin-changed', { groupId, itemId: item.id, pinned: true }, api.scopes.GLOBAL);

  console.log(`[ext:groups] Pinned item "${url}" in group ${groupId}`);
  return { success: true, itemId: item.id, groupId };
};

/**
 * Unpin an item from a group.
 */
const unpinItem = async (url, groupId = null) => {
  if (!groupId) {
    const current = await resolveCurrentGroup();
    if (current) {
      groupId = current.groupId;
    }
  }

  if (!groupId) {
    return { success: false, error: 'No active group context' };
  }

  if (!url) {
    return { success: false, error: 'Usage: unpin <url>' };
  }

  // Find the item
  const item = await getOrCreateUrlItem(url);
  if (!item) {
    return { success: false, error: 'Item not found' };
  }

  // Remove from pins
  const pins = await getPinnedItems(groupId);
  const idx = pins.indexOf(item.id);
  if (idx !== -1) {
    pins.splice(idx, 1);
    await savePinnedItems(groupId, pins);
  }

  // Publish event for UI reactivity
  api.publish('group:pin-changed', { groupId, itemId: item.id, pinned: false }, api.scopes.GLOBAL);

  console.log(`[ext:groups] Unpinned item "${url}" from group ${groupId}`);
  return { success: true, itemId: item.id, groupId };
};

// ===== Command helpers =====

/**
 * Helper to get or create a URL item
 */
const normalizeUrlForCompare = (url) => {
  try {
    const u = new URL(url);
    // Lowercase hostname, remove default ports, remove trailing slash for non-root paths
    let normalized = u.protocol + '//' + u.hostname.toLowerCase();
    if (u.port && u.port !== '80' && u.port !== '443') normalized += ':' + u.port;
    let path = u.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    normalized += path + u.search + u.hash;
    return normalized;
  } catch {
    return url;
  }
};

const getOrCreateUrlItem = async (url, title = '') => {
  // Search narrows to matching URLs, then normalize-compare for exact match
  const result = await api.datastore.queryItems({ type: 'url', search: url, limit: 10 });
  if (!result.success) return null;

  const normalizedUrl = normalizeUrlForCompare(url);
  const existing = result.data.find(item => normalizeUrlForCompare(item.content) === normalizedUrl);
  if (existing) return existing;

  const addResult = await api.datastore.addItem('url', {
    content: url,
    metadata: JSON.stringify({ title })
  });
  if (!addResult.success) return null;

  return { id: addResult.data.id, content: url };
};

/**
 * Get all tags (groups) sorted by frecency
 */
const getAllGroups = async () => {
  const result = await api.datastore.getTagsByFrecency();
  if (!result.success) return [];
  return result.data;
};

/**
 * Save current windows to a group (tag)
 */
const saveToGroup = async (groupName) => {
  console.log('[ext:groups] Saving to group:', groupName);

  const tagResult = await api.datastore.getOrCreateTag(groupName);
  if (!tagResult.success) {
    console.error('[ext:groups] Failed to get/create tag:', tagResult.error);
    return { success: false, error: tagResult.error };
  }

  const tag = tagResult.data.tag;
  const tagId = tag.id;

  // Auto-promote: ensure the tag has isGroup: true in metadata
  try {
    let meta = {};
    if (tag.metadata) {
      meta = typeof tag.metadata === 'object' ? tag.metadata : JSON.parse(tag.metadata);
    }
    if (!meta.isGroup) {
      meta.isGroup = true;
      await api.datastore.setRow('tags', tagId, { ...tag, metadata: JSON.stringify(meta) });
      debug && console.log('[ext:groups] Auto-promoted tag to group:', groupName);
    }
  } catch (err) {
    console.error('[ext:groups] Failed to auto-promote tag:', err);
  }

  const listResult = await api.window.list({ includeInternal: false });
  if (!listResult.success || listResult.windows.length === 0) {
    console.log('[ext:groups] No windows to save');
    return { success: false, error: 'No windows to save' };
  }

  let savedCount = 0;

  for (const win of listResult.windows) {
    const item = await getOrCreateUrlItem(win.url, win.title);
    if (item) {
      const linkResult = await api.datastore.tagItem(item.id, tagId);
      if (linkResult.success && !linkResult.alreadyExists) {
        savedCount++;
      }
    }
  }

  console.log(`[ext:groups] Saved ${savedCount} URLs to group "${groupName}"`);

  // Persist current window layouts for this group
  try {
    if (api.session?.saveSpaceWorkspaces) {
      await api.session.saveSpaceWorkspaces();
      debug && console.log('[ext:groups] Group workspace layouts saved');
    }
  } catch (err) {
    debug && console.log('[ext:groups] Failed to save workspace layouts:', err);
  }

  return { success: true, count: savedCount, total: listResult.windows.length };
};

/**
 * Open all URLs in a group (tag)
 */
const openGroup = async (groupName) => {
  console.log('[ext:groups] Opening group:', groupName);

  const tagsResult = await api.datastore.getTagsByFrecency();
  if (!tagsResult.success) {
    return { success: false, error: 'Failed to get tags' };
  }

  const tag = tagsResult.data.find(t => t.name.toLowerCase() === groupName.toLowerCase());
  if (!tag) {
    console.log('[ext:groups] Group not found:', groupName);
    return { success: false, error: 'Group not found' };
  }

  const itemsResult = await api.datastore.getItemsByTag(tag.id);
  if (!itemsResult.success) {
    console.log('[ext:groups] Failed to get items for group:', groupName);
    return { success: false, error: 'Failed to get group items' };
  }

  // Filter to items with URLs (explicit URL items + text items containing URLs)
  const allUrlItems = itemsResult.data
    .map(item => {
      if (item.type === 'url') return { ...item, _openUrl: item.content };
      if (item.type === 'text' && item.content) {
        // Check if text note contains a URL
        const urlMatch = item.content.trim().match(/^https?:\/\/\S+/) || item.content.match(/https?:\/\/[^\s<>"')\]]+/i);
        if (urlMatch) {
          try { new URL(urlMatch[0]); return { ...item, _openUrl: urlMatch[0] }; } catch (e) {}
        }
      }
      return null;
    })
    .filter(Boolean);

  // Deduplicate by normalized URL to avoid opening the same page twice
  const seenUrls = new Set();
  const urlItems = allUrlItems.filter(item => {
    const normalized = normalizeUrlForCompare(item._openUrl);
    if (seenUrls.has(normalized)) return false;
    seenUrls.add(normalized);
    return true;
  });

  if (urlItems.length === 0) {
    console.log('[ext:groups] No URLs in group:', groupName);
    return { success: false, error: 'Group is empty' };
  }

  // Load pinned items — these always open even if not in workspace snapshot
  const pinnedItemIds = await getPinnedItems(tag.id);
  const pinnedSet = new Set(pinnedItemIds);

  // Track active group for mode inheritance
  activeGroupId = tag.id;
  activeGroupName = tag.name;

  // Load saved workspace snapshot for this group (if any)
  let savedBoundsMap = null;
  let sortedUrlItems = urlItems;
  try {
    const wsResult = await api.settings.getExtKey('spaces', 'workspace:' + tag.id);
    if (wsResult.success && wsResult.data) {
      const snapshot = typeof wsResult.data === 'string' ? JSON.parse(wsResult.data) : wsResult.data;
      if (snapshot.version === 1 && Array.isArray(snapshot.windows)) {
        // Build URL -> bounds map
        savedBoundsMap = new Map();
        for (const w of snapshot.windows) {
          if (w.url && w.bounds) {
            savedBoundsMap.set(normalizeUrlForCompare(w.url), { bounds: w.bounds, zOrder: w.zOrder ?? 0 });
          }
        }
        // Sort items: pinned first, then by saved z-order (highest zOrder = opened later = on top)
        sortedUrlItems = [...urlItems].sort((a, b) => {
          const aPinned = pinnedSet.has(a.id) ? 1 : 0;
          const bPinned = pinnedSet.has(b.id) ? 1 : 0;
          if (aPinned !== bPinned) return bPinned - aPinned; // pinned first
          const aZ = savedBoundsMap.get(normalizeUrlForCompare(a._openUrl))?.zOrder ?? 0;
          const bZ = savedBoundsMap.get(normalizeUrlForCompare(b._openUrl))?.zOrder ?? 0;
          return bZ - aZ;
        });
        debug && console.log(`[ext:groups] Loaded workspace snapshot with ${snapshot.windows.length} saved positions`);
      }
    }
  } catch (err) {
    debug && console.log('[ext:groups] No saved workspace layout, using defaults:', err);
  }

  // Open windows and set group mode
  const openedWindows = [];
  for (const item of sortedUrlItems) {
    // Look up saved bounds for this URL
    const savedEntry = savedBoundsMap?.get(normalizeUrlForCompare(item._openUrl));
    const boundsOpts = savedEntry?.bounds ? {
      x: savedEntry.bounds.x,
      y: savedEntry.bounds.y,
      width: savedEntry.bounds.width,
      height: savedEntry.bounds.height,
    } : {};

    const result = await api.window.open(item._openUrl, {
      role: 'content',
      trackingSource: 'cmd',
      trackingSourceId: `group:${groupName}`,
      // Pass space context for mode inheritance
      spaceMode: {
        spaceId: tag.id,
        spaceName: tag.name,
        color: tag.color
      },
      ...boundsOpts
    });
    if (result?.id) {
      openedWindows.push(result.id);
      // Set group mode for the opened window
      await setGroupMode(result.id, tag.id, tag.name, tag.color);
    }
  }

  console.log(`[ext:groups] Opened ${urlItems.length} windows from group "${groupName}"`);
  return { success: true, count: urlItems.length, windowIds: openedWindows };
};

// ===== Registration =====

let registeredShortcut = null;
const LOCAL_SHORTCUT = 'CommandOrControl+G';

const initShortcut = (shortcut) => {
  api.shortcuts.register(shortcut, () => {
    openGroupsWindow();
  }, { global: true });
  registeredShortcut = shortcut;

  // Local shortcut (Cmd+G) — works when a Peek window is focused
  api.shortcuts.register(LOCAL_SHORTCUT, () => {
    openGroupsWindow();
  });
};

const initCommands = () => {
  registerNoun({
    name: 'groups',
    singular: 'group',
    description: 'Saved tab groups',

    query: async ({ search }) => {
      // Group-scoped search: when in group mode, filter items by the active group tag
      const current = await resolveCurrentGroup();

      const groups = await getAllGroups();
      const withCounts = await Promise.all(groups.map(async g => {
        const result = await api.datastore.getItemsByTag(g.id);
        const count = result.success ? result.data.filter(i => i.type === 'url').length : 0;
        return { id: g.id, name: g.name, color: g.color, count };
      }));
      let filtered = withCounts.filter(g => g.count > 0);
      if (search) {
        const s = search.toLowerCase();
        filtered = filtered.filter(g => g.name.toLowerCase().includes(s));
      }

      // If in group mode, highlight the active group by moving it to the top
      if (current) {
        const activeIdx = filtered.findIndex(g => g.id === current.groupId);
        if (activeIdx > 0) {
          const [active] = filtered.splice(activeIdx, 1);
          active.name = `${active.name} (active)`;
          filtered.unshift(active);
        }
      }

      if (filtered.length === 0) {
        return { output: 'No groups found.', mimeType: 'text/plain' };
      }

      // Add search scope indicator when in group mode
      const title = current
        ? `Groups (${filtered.length}) [scope: ${current.groupName}]`
        : `Groups (${filtered.length})`;

      return {
        success: true,
        output: {
          data: filtered,
          mimeType: 'application/json',
          title
        }
      };
    },

    browse: async () => { openGroupsWindow(); },

    open: async (ctx) => {
      if (ctx.search) await openGroup(ctx.search.trim());
    },

    create: async ({ search }) => {
      if (!search) return { success: false, error: 'Usage: new group <name>' };
      return await saveToGroup(search.trim());
    },

    produces: 'application/json'
  });

  console.log('[ext:groups] Noun registered: groups');

  // ===== Standalone commands (pin, unpin) =====
  // Workspace commands (close, switch, restore) moved to spaces feature.

  // "pin <url>" — mark a URL as pinned in the current group
  api.subscribe('cmd:execute:pin', async (msg) => {
    const result = await pinItem(msg.search?.trim());
    if (msg.expectResult && msg.resultTopic) {
      api.publish(msg.resultTopic, result || { success: true }, api.scopes.GLOBAL);
    }
  }, api.scopes.GLOBAL);
  api.publish('cmd:register', {
    name: 'pin',
    description: 'Pin a URL in the current group (always opens with group)',
    source: 'groups',
    scope: 'global',
    accepts: [],
    produces: [],
    params: [{ name: 'url', type: 'string', required: true, description: 'URL to pin' }]
  }, api.scopes.GLOBAL);

  // "unpin <url>" — remove pin from a URL in the current group
  api.subscribe('cmd:execute:unpin', async (msg) => {
    const result = await unpinItem(msg.search?.trim());
    if (msg.expectResult && msg.resultTopic) {
      api.publish(msg.resultTopic, result || { success: true }, api.scopes.GLOBAL);
    }
  }, api.scopes.GLOBAL);
  api.publish('cmd:register', {
    name: 'unpin',
    description: 'Unpin a URL from the current group',
    source: 'groups',
    scope: 'global',
    accepts: [],
    produces: [],
    params: [{ name: 'url', type: 'string', required: true, description: 'URL to unpin' }]
  }, api.scopes.GLOBAL);

  console.log('[ext:groups] Standalone commands registered: pin, unpin');
};

const uninitCommands = () => {
  unregisterNoun('groups');
  // Unregister standalone commands
  for (const name of ['pin', 'unpin']) {
    api.publish('cmd:unregister', { name }, api.scopes.GLOBAL);
  }
  console.log('[ext:groups] Noun and commands unregistered: groups');
};

const init = async () => {
  console.log('[ext:groups] init');

  // Load settings from datastore
  currentSettings = await loadSettings();

  initShortcut(currentSettings.prefs.shortcutKey);

  // Register commands (cmd loads first with its subscribers ready via 100ms head start)
  initCommands();

  // Listen for window close events to clean up groups window tracking
  // NOTE: We do NOT exit group mode when the groups panel closes.
  // Group mode persists on member windows. It is only cleared when:
  // - The user navigates back to the groups list (handled in home.js showGroups)
  // - The user explicitly changes mode
  api.subscribe('window:closed', async (msg) => {
    const closedWindowId = msg?.id;

    if (closedWindowId === groupsWindowId) {
      debug && console.log('[ext:groups] Groups window closed, keeping group mode on member windows');
      groupsWindowId = null;
    }
  }, api.scopes.GLOBAL);

  // Listen for settings changes to hot-reload (GLOBAL scope for cross-process)
  api.subscribe('groups:settings-changed', async () => {
    console.log('[ext:groups] settings changed, reinitializing');
    uninit();
    currentSettings = await loadSettings();
    initShortcut(currentSettings.prefs.shortcutKey);
    initCommands();
  }, api.scopes.GLOBAL);

  // Listen for settings updates from Settings UI
  // Settings UI sends proposed changes, we validate and save
  api.subscribe('groups:settings-update', async (msg) => {
    console.log('[ext:groups] settings-update received:', msg);

    try {
      // Apply the update based on what was sent
      if (msg.data) {
        // Full data object sent
        currentSettings = {
          prefs: msg.data.prefs || currentSettings.prefs
        };
      } else if (msg.key === 'prefs' && msg.path) {
        // Single pref field update
        const field = msg.path.split('.')[1];
        if (field) {
          currentSettings.prefs = { ...currentSettings.prefs, [field]: msg.value };
        }
      }

      // Save to datastore
      await saveSettings(currentSettings);

      // Reinitialize with new settings
      uninit();
      initShortcut(currentSettings.prefs.shortcutKey);
      initCommands();

      // Confirm change back to Settings UI
      api.publish('groups:settings-changed', currentSettings, api.scopes.GLOBAL);
    } catch (err) {
      console.error('[ext:groups] settings-update error:', err);
    }
  }, api.scopes.GLOBAL);
};

const uninit = () => {
  console.log('[ext:groups] uninit');
  if (registeredShortcut) {
    api.shortcuts.unregister(registeredShortcut, { global: true });
    registeredShortcut = null;
  }
  api.shortcuts.unregister(LOCAL_SHORTCUT);
  uninitCommands();
};

export default {
  defaults,
  id,
  init,
  uninit,
  labels,
  schemas,
  storageKeys
};
