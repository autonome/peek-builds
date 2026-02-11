/**
 * Groups Extension Background Script
 *
 * Tag-based grouping of URLs
 *
 * Runs in isolated extension process (peek://ext/groups/background.html)
 * Uses api.settings for datastore-backed settings storage
 */

import { id, labels, schemas, storageKeys, defaults } from './config.js';

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
    await api.context.setMode('group', {
      windowId,
      metadata: {
        groupId,
        groupName,
        color
      }
    });
    debug && console.log(`[ext:groups] Set group mode for window ${windowId}: ${groupName}`);
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
    const result = await api.context.getWindowsInGroup(groupId);
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
  const result = await api.datastore.queryItems({ type: 'url' });
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

  const tagId = tagResult.data.tag.id;

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

  // Track active group for mode inheritance
  activeGroupId = tag.id;
  activeGroupName = tag.name;

  // Open windows and set group mode
  const openedWindows = [];
  for (const item of urlItems) {
    const result = await api.window.open(item._openUrl, {
      role: 'content',
      trackingSource: 'cmd',
      trackingSourceId: `group:${groupName}`,
      // Pass group context for mode inheritance
      groupMode: {
        groupId: tag.id,
        groupName: tag.name,
        color: tag.color
      }
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

// ===== Command definitions =====

const commandDefinitions = [
  {
    name: 'open groups',
    description: 'Open the groups manager',
    execute: async (ctx) => {
      console.log('[ext:groups] Opening groups manager');
      openGroupsWindow();
    }
  },
  {
    name: 'list groups',
    description: 'List all groups (chainable)',
    accepts: [],
    produces: ['application/json'],
    execute: async (ctx) => {
      const groups = await getAllGroups();
      if (groups.length === 0) {
        return { output: 'No groups yet. Tag some pages to create groups.', mimeType: 'text/plain' };
      }

      // Get URL item counts for each group
      const groupsWithCounts = await Promise.all(groups.map(async (g) => {
        const result = await api.datastore.getItemsByTag(g.id);
        const urlCount = result.success ? result.data.filter(item => item.type === 'url').length : 0;
        return { id: g.id, name: g.name, color: g.color, count: urlCount };
      }));

      // Filter to non-empty groups
      const nonEmpty = groupsWithCounts.filter(g => g.count > 0);
      if (nonEmpty.length === 0) {
        return { output: 'No groups with pages yet.', mimeType: 'text/plain' };
      }

      // Return chainable JSON output
      return {
        success: true,
        output: {
          data: nonEmpty,
          mimeType: 'application/json',
          title: `Groups (${nonEmpty.length} items)`
        }
      };
    }
  },
  {
    name: 'save group',
    description: 'Save open windows to a group',
    execute: async (ctx) => {
      if (ctx.search) {
        const groupName = ctx.search.trim();
        const result = await saveToGroup(groupName);
        if (result.success) {
          console.log(`[ext:groups] Saved ${result.count} of ${result.total} windows to "${groupName}"`);
        }
      } else {
        console.log('[ext:groups] Usage: save group <name>');
      }
    }
  },
  {
    name: 'open group',
    description: 'Open all URLs in a group',
    execute: async (ctx) => {
      if (ctx.search) {
        const groupName = ctx.search.trim();
        await openGroup(groupName);
      } else {
        const groups = await getAllGroups();
        if (groups.length === 0) {
          console.log('[ext:groups] No groups saved yet. Use "save group <name>" to create one.');
        } else {
          console.log('[ext:groups] Available groups:');
          groups.forEach(g => console.log('  -', g.name));
        }
      }
    }
  }
];

// Track dynamic group commands separately
let dynamicGroupCommands = [];

// ===== Registration =====

let registeredShortcut = null;
let registeredCommands = [];
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

/**
 * Register dynamic commands for each existing group
 * Creates "group GroupName" commands that are searchable
 */
const registerDynamicGroupCommands = async () => {
  // Unregister old dynamic commands first
  for (const name of dynamicGroupCommands) {
    api.commands.unregister(name);
  }
  dynamicGroupCommands = [];

  // Get all groups with URL items
  const groups = await getAllGroups();
  const groupsWithCounts = await Promise.all(groups.map(async (g) => {
    const result = await api.datastore.getItemsByTag(g.id);
    const urlCount = result.success ? result.data.filter(item => item.type === 'url').length : 0;
    return { ...g, count: urlCount };
  }));

  // Register a command for each non-empty group
  const nonEmpty = groupsWithCounts.filter(g => g.count > 0);
  for (const group of nonEmpty) {
    const cmdName = `group ${group.name}`;
    const cmd = {
      name: cmdName,
      description: `Open ${group.count} pages in "${group.name}"`,
      execute: async () => {
        await openGroup(group.name);
      }
    };
    api.commands.register(cmd);
    dynamicGroupCommands.push(cmdName);
  }

  if (nonEmpty.length > 0) {
    debug && console.log('[ext:groups] Registered dynamic group commands:', dynamicGroupCommands);
  }
};

const initCommands = async () => {
  // Register static commands
  commandDefinitions.forEach(cmd => {
    api.commands.register(cmd);
    registeredCommands.push(cmd.name);
  });
  console.log('[ext:groups] Registered commands:', registeredCommands);

  // Register dynamic group commands
  await registerDynamicGroupCommands();
};

const uninitCommands = () => {
  // Unregister static commands
  registeredCommands.forEach(name => {
    api.commands.unregister(name);
  });
  registeredCommands = [];

  // Unregister dynamic commands
  for (const name of dynamicGroupCommands) {
    api.commands.unregister(name);
  }
  dynamicGroupCommands = [];

  console.log('[ext:groups] Unregistered commands');
};

const init = async () => {
  console.log('[ext:groups] init');

  // Load settings from datastore
  currentSettings = await loadSettings();

  initShortcut(currentSettings.prefs.shortcutKey);

  // Register commands directly (cmd loads first with its subscribers ready)
  initCommands();

  // Listen for window close events to cleanup group mode
  api.subscribe('window:closed', async (msg) => {
    const closedWindowId = msg?.id;

    // If the groups window closed, exit group mode for all windows in the active group
    if (closedWindowId === groupsWindowId && activeGroupId) {
      debug && console.log('[ext:groups] Groups window closed, exiting group mode for active group');
      await exitGroupMode(activeGroupId);
      activeGroupId = null;
      activeGroupName = null;
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
