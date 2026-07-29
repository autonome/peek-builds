/**
 * Groups - Tag-based grouping of addresses
 *
 * Groups are implemented using tags:
 * - Each "group" is a tag
 * - Addresses in a group are addresses tagged with that tag
 * - Creating a new group creates a new tag
 * - Viewing a group shows all addresses with that tag
 */

import {
  updateSelection as _updateSelection, activateSelected as _activateSelected,
  createKeydownHandler,
  setupToolbar as _setupToolbar,
  createViewPrefs
} from 'peek://app/lib/grid-nav.js';
import {
  createAffordanceElements, createActionRulesCache
} from 'peek://app/lib/tag-action-affordances.js';
import { createSearchResultCard } from 'peek://app/lib/search-result-card.js';
import { liveQuery } from 'peek://app/lib/live-query.js';
import { labels } from './config.js';
import { registerNoun, unregisterNoun } from 'peek://cmd/nouns.js';

const api = window.app;

// Tag action rules cache for rendering affordances on address cards
let actionRulesCache = null;

/**
 * Check if a URL is a navigable web URL (http/https only)
 * Excludes peek:// and other internal URLs
 */
const isWebUrl = (url) => {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
};

// View states
const VIEW_GROUPS = 'groups';
const VIEW_ADDRESSES = 'addresses';

// Special pseudo-tag for untagged addresses
const UNTAGGED_GROUP = {
  id: '__untagged__',
  name: 'Untagged',
  color: '#666666',
  frequency: 0,
  isSpecial: true
};

// View preferences (persisted)
const { prefs: viewPrefs, load: loadViewPrefs, save: saveViewPrefs } = createViewPrefs('viewPrefs', {
  viewMode: 'columns',
  sortBy: 'name',
  sortDirection: 'asc'
});

const SORT_OPTIONS_GROUPS = [
  { value: 'name', label: 'Name' },
  { value: 'count', label: 'Count' },
  { value: 'recent', label: 'Recent' }
];

const SORT_OPTIONS_ADDRESSES = [
  { value: 'name', label: 'Name' },
  { value: 'count', label: 'Visits' },
  { value: 'recent', label: 'Recent' }
];

let state = {
  view: VIEW_GROUPS,
  tags: [],
  currentTag: null,
  addresses: [],
  untaggedCount: 0,
  selectedIndex: 0,
  searchQuery: '',
  lastViewedTagId: null
};

// Expose state for debugging in tests
window._groupsState = state;

/**
 * Parse tag metadata JSON safely
 */
const parseTagMetadata = (tag) => {
  if (!tag.metadata) return {};
  if (typeof tag.metadata === 'object') return tag.metadata;
  try {
    return JSON.parse(tag.metadata);
  } catch {
    return {};
  }
};

/**
 * Check if a tag is promoted to a group (has isGroup: true in metadata)
 */
const isGroupTag = (tag) => {
  const meta = parseTagMetadata(tag);
  return meta.isGroup === true;
};

/**
 * Promote a tag to a group by setting isGroup: true in its metadata
 */
const promoteTagToGroup = async (tag) => {
  const meta = parseTagMetadata(tag);
  meta.isGroup = true;
  const metadataStr = JSON.stringify(meta);
  try {
    // Only include valid tag table columns — exclude runtime properties like
    // addressCount which would cause the SQL INSERT to fail
    const tagRow = {
      id: tag.id,
      name: tag.name,
      slug: tag.slug,
      color: tag.color,
      parentId: tag.parentId,
      description: tag.description,
      metadata: metadataStr,
      createdAt: tag.createdAt,
      updatedAt: tag.updatedAt,
      frequency: tag.frequency,
      lastUsed: tag.lastUsed,
      frecencyScore: tag.frecencyScore
    };
    await api.datastore.setRow('tags', tag.id, tagRow);
    tag.metadata = metadataStr;
    return true;
  } catch (err) {
    console.error('[groups] Failed to promote tag to group:', err);
    return false;
  }
};

/**
 * Internal ESC handler for groups navigation
 * Returns { handled: true } if we navigated internally (search clear, back to groups list)
 * Returns { handled: false } at root — backend escPolicy decides (workspace role = never close)
 */
const handleEscape = () => {
  // If search has content, clear it first
  const searchInput = document.querySelector('peek-input.search-input');
  if (state.searchQuery) {
    state.searchQuery = '';
    searchInput.value = '';
    renderCurrentView();
    return { handled: true };
  }

  if (state.view === VIEW_ADDRESSES) {
    // Navigate back to groups list
    // Use setTimeout to ensure handler returns before async work starts
    setTimeout(() => {
      showGroups().catch(err => {
        console.error('[groups] Error navigating back to groups:', err);
      });
    }, 0);
    return { handled: true };
  }
  // At root (groups list) — defer to backend escPolicy.
  // Groups window has role:'workspace', so escPolicy returns 'nothing' (never close).
  return { handled: false };
};

/**
 * Wrappers around shared grid-nav functions, bound to local state
 */
const updateSelection = () => _updateSelection(state);
const activateSelected = () => _activateSelected(state);

/**
 * Handle keyboard navigation (vim-style hjkl for grid movement)
 * Uses shared grid-nav with groups-specific hooks for search focus and new-group input bypass
 */
const handleKeydown = createKeydownHandler(state, {
  shouldIgnore: (e) => {
    // Check if the create-group input is focused — if so, let all keys through
    const newGroupInput = document.querySelector('peek-input.new-group-input');
    const isNewGroupFocused = document.activeElement === newGroupInput ||
      (newGroupInput && newGroupInput.shadowRoot?.activeElement);
    if (isNewGroupFocused) return true;

    const searchInput = document.querySelector('peek-input.search-input');
    const isSearchFocused = document.activeElement === searchInput ||
      (searchInput && searchInput.shadowRoot?.activeElement);

    // Focus search with / or Cmd+F
    if ((e.key === '/' || (e.key === 'f' && (e.metaKey || e.ctrlKey))) && !isSearchFocused) {
      e.preventDefault();
      searchInput.focus();
      return true;
    }

    return false;
  },
  isInputFocused: () => {
    const searchInput = document.querySelector('peek-input.search-input');
    return document.activeElement === searchInput ||
      !!(searchInput && searchInput.shadowRoot?.activeElement);
  }
});


/**
 * Set up grid toolbar events and state
 */
const setupToolbar = () => {
  _setupToolbar({
    viewPrefs,
    sortOptions: SORT_OPTIONS_GROUPS,
    onSave: saveViewPrefs,
    onRender: renderCurrentView
  });
};

/**
 * Update toolbar sort options based on current view
 */
const updateToolbarSortOptions = () => {
  const toolbar = document.querySelector('.grid-toolbar');
  if (!toolbar) return;
  toolbar.sortOptions = state.view === VIEW_GROUPS ? SORT_OPTIONS_GROUPS : SORT_OPTIONS_ADDRESSES;
};

/**
 * Sort groups by current view preferences
 */
const sortGroups = (groups) => {
  const dir = viewPrefs.sortDirection === 'asc' ? 1 : -1;
  return groups.sort((a, b) => {
    switch (viewPrefs.sortBy) {
      case 'name':
        return dir * (a.name || '').localeCompare(b.name || '');
      case 'count': {
        const ca = a.isSpecial ? (a.frequency || 0) : (a.addressCount || 0);
        const cb = b.isSpecial ? (b.frequency || 0) : (b.addressCount || 0);
        return dir * (ca - cb);
      }
      case 'recent': {
        const ra = a.updatedAt || a.createdAt || 0;
        const rb = b.updatedAt || b.createdAt || 0;
        return dir * (ra - rb);
      }
      default:
        return 0;
    }
  });
};

/**
 * Sort addresses by current view preferences
 */
const sortAddresses = (addresses) => {
  const dir = viewPrefs.sortDirection === 'asc' ? 1 : -1;
  return addresses.sort((a, b) => {
    switch (viewPrefs.sortBy) {
      case 'name': {
        const na = (a.title || a.uri || a.content || '').toLowerCase();
        const nb = (b.title || b.uri || b.content || '').toLowerCase();
        return dir * na.localeCompare(nb);
      }
      case 'count': {
        const ca = a.visitCount || 0;
        const cb = b.visitCount || 0;
        return dir * (ca - cb);
      }
      case 'recent': {
        const ra = a.updatedAt || a.createdAt || 0;
        const rb = b.updatedAt || b.createdAt || 0;
        return dir * (ra - rb);
      }
      default:
        return 0;
    }
  });
};

/**
 * Set up create group UI (button, form, submit/cancel)
 */
const setupCreateGroup = () => {
  const createBtn = document.querySelector('.create-group-btn');
  const form = document.querySelector('.create-group-form');
  const newGroupInput = document.querySelector('.new-group-input');
  const cancelBtn = document.querySelector('.create-group-cancel');
  const submitBtn = document.querySelector('.create-group-submit');

  if (!createBtn || !form) return;

  const showForm = () => {
    form.style.display = '';
    newGroupInput.value = '';
    setTimeout(() => newGroupInput.focus(), 50);
  };

  const hideForm = () => {
    form.style.display = 'none';
    newGroupInput.value = '';
  };

  const submitGroup = async () => {
    const name = (newGroupInput.value || '').trim();
    if (!name) return;

    try {
      const result = await api.datastore.getOrCreateTag(name);
      if (result.success) {
        // Mark the tag as a group
        const tag = result.data.tag;
        await promoteTagToGroup(tag);
        hideForm();
        // Refresh groups list
        await loadTags();
        renderGroups();
      } else {
        console.error('[groups] Failed to create group:', result.error);
      }
    } catch (err) {
      console.error('[groups] Error creating group:', err);
    }
  };

  createBtn.addEventListener('click', showForm);
  cancelBtn.addEventListener('click', hideForm);
  submitBtn.addEventListener('click', submitGroup);
  newGroupInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitGroup();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideForm();
    }
  });
};

// ============================================================================
// Background logic (inlined from background.js)
// ============================================================================
// Commands, bulk-open (openGroup), pins, close/switch/restore, and
// shutdown-related pubsub subscriptions.
// Runs once at module load (see bootstrap IIFE at bottom), NOT inside the
// DOMContentLoaded init() — keeps UI init path clean.

console.log('[ext:groups] background', labels.name);

// Extension content is served from peek://groups/
const bgAddress = 'peek://groups/home.html';

// Track the groups window ID for mode cleanup (from bg-initiated opens)
let groupsWindowId = null;

// Track the current active group context (bulk-open path)
let activeGroupId = null;
let activeGroupName = null;

// Track suspended (hidden) group windows: groupId -> [windowId, ...]
const suspendedGroups = new Map();

let isOpeningGroups = false;
const openGroupsWindow = async () => {
  if (isOpeningGroups) return;
  isOpeningGroups = true;
  try {
    const params = {
      role: 'workspace',
      key: bgAddress,
      height: 600,
      width: 800,
      trackingSource: 'cmd',
      trackingSourceId: 'groups'
    };
    const window = await api.window.open(bgAddress, params);
    groupsWindowId = window?.id || null;
  } catch (error) {
    console.error('[ext:groups] Failed to open groups window:', error);
  } finally {
    isOpeningGroups = false;
  }
};

/** Set group mode for a window via context API */
const setGroupMode = async (windowId, groupId, groupName, color = null) => {
  if (!api.context) return;
  try {
    await api.context.setMode('group', {
      windowId,
      metadata: { groupId, groupName, color }
    });
  } catch (err) {
    console.error('[ext:groups] Failed to set group mode:', err);
  }
};

/** Exit group mode for all windows in a group */
const exitGroupMode = async (groupId) => {
  if (!api.context) return;
  try {
    const result = await api.context.getWindowsInSpace(groupId);
    if (!result.success || !result.data) return;
    const windowIds = result.data;
    for (const windowId of windowIds) {
      await api.context.setMode('page', { windowId });
    }
  } catch (err) {
    console.error('[ext:groups] Failed to exit group mode:', err);
  }
};

/** Resolve current group from active context or last focused window */
const resolveCurrentGroup = async () => {
  if (activeGroupId) {
    return { groupId: activeGroupId, groupName: activeGroupName };
  }
  try {
    const targetWindowId = await api.window.getFocusedVisibleWindowId();
    if (targetWindowId) {
      const modeResult = await api.context.get('mode', targetWindowId);
      if (modeResult.success && modeResult.data?.value === 'group' && modeResult.data.metadata?.groupId) {
        return {
          groupId: modeResult.data.metadata.groupId,
          groupName: modeResult.data.metadata.groupName || ''
        };
      }
    }
  } catch {
  }
  return null;
};

/** Close (suspend) a group — hide all windows in the group context */
const closeGroup = async (groupId = null, groupName = null) => {
  if (!groupId) {
    const current = await resolveCurrentGroup();
    if (current) { groupId = current.groupId; groupName = current.groupName; }
  }
  if (!groupId) return { success: false, error: 'No active group to close' };

  try {
    if (api.session?.saveSpaceWorkspaces) await api.session.saveSpaceWorkspaces();
  } catch {
  }

  const result = await api.context.getWindowsInSpace(groupId);
  if (!result.success || !result.data || result.data.length === 0) {
    return { success: false, error: 'No windows found in group' };
  }

  const windowIds = result.data;
  const hiddenIds = [];
  for (const windowId of windowIds) {
    try {
      await api.window.hide(windowId);
      hiddenIds.push(windowId);
    } catch {
    }
  }
  suspendedGroups.set(groupId, hiddenIds);

  if (activeGroupId === groupId) {
    activeGroupId = null;
    activeGroupName = null;
  }

  console.log(`[ext:groups] Closed group "${groupName || groupId}": hid ${hiddenIds.length} window(s)`);
  return { success: true, count: hiddenIds.length, groupId, groupName };
};

/** Restore a suspended group — show all hidden windows */
const restoreGroup = async (groupId, groupName = null) => {
  const hiddenIds = suspendedGroups.get(groupId);
  if (!hiddenIds || hiddenIds.length === 0) {
    if (groupName) return openGroup(groupName);
    return { success: false, error: 'Group not suspended and no name to open' };
  }

  let restoredCount = 0;
  const failedIds = [];
  for (const windowId of hiddenIds) {
    try {
      const exists = await api.window.exists(windowId);
      if (exists?.exists) {
        await api.window.show(windowId);
        restoredCount++;
      } else {
        failedIds.push(windowId);
      }
    } catch {
      failedIds.push(windowId);
    }
  }
  suspendedGroups.delete(groupId);

  if (failedIds.length > 0 && groupName) {
    console.log(`[ext:groups] ${failedIds.length} windows destroyed while suspended, re-opening group`);
    return openGroup(groupName);
  }

  activeGroupId = groupId;
  activeGroupName = groupName;
  console.log(`[ext:groups] Restored group "${groupName || groupId}": showed ${restoredCount} window(s)`);
  return { success: true, count: restoredCount };
};

/** Switch from current group to target group */
const switchGroup = async (targetGroupName) => {
  if (!targetGroupName) return { success: false, error: 'Usage: switch group <name>' };
  const tagsResult = await api.datastore.getTagsByFrecency();
  if (!tagsResult.success) return { success: false, error: 'Failed to get tags' };
  const targetTag = tagsResult.data.find(t => t.name.toLowerCase() === targetGroupName.toLowerCase());
  if (!targetTag) return { success: false, error: `Group "${targetGroupName}" not found` };
  const current = await resolveCurrentGroup();
  if (current && current.groupId !== targetTag.id) {
    await closeGroup(current.groupId, current.groupName);
  }
  const result = await restoreGroup(targetTag.id, targetTag.name);
  console.log(`[ext:groups] Switched to group "${targetGroupName}"`);
  return result;
};

// ===== Pins =====

const getPinnedItems = async (groupId) => {
  try {
    const result = await api.settings.get(`pins:${groupId}`);
    if (!result.error && result.value) {
      return Array.isArray(result.value) ? result.value : [];
    }
  } catch {
  }
  return [];
};

const savePinnedItems = async (groupId, pinnedItemIds) => {
  try {
    await api.settings.set(`pins:${groupId}`, pinnedItemIds);
  } catch (err) {
    console.error('[ext:groups] Failed to save pins:', err);
  }
};

// Note: normalizeUrlForCompare already defined in home.js (line ~519) — reused below.

const getOrCreateUrlItem = async (url, title = '') => {
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

const pinItem = async (url, groupId = null) => {
  if (!groupId) {
    const current = await resolveCurrentGroup();
    if (current) groupId = current.groupId;
  }
  if (!groupId) return { success: false, error: 'No active group context — open a group first' };
  if (!url) return { success: false, error: 'Usage: pin <url>' };

  const item = await getOrCreateUrlItem(url);
  if (!item) return { success: false, error: 'Failed to find or create item for URL' };

  const pins = await getPinnedItems(groupId);
  if (!pins.includes(item.id)) {
    pins.push(item.id);
    await savePinnedItems(groupId, pins);
  }

  api.pubsub.publish('group:pin-changed', { groupId, itemId: item.id, pinned: true });
  console.log(`[ext:groups] Pinned item "${url}" in group ${groupId}`);
  return { success: true, itemId: item.id, groupId };
};

const unpinItem = async (url, groupId = null) => {
  if (!groupId) {
    const current = await resolveCurrentGroup();
    if (current) groupId = current.groupId;
  }
  if (!groupId) return { success: false, error: 'No active group context' };
  if (!url) return { success: false, error: 'Usage: unpin <url>' };

  const item = await getOrCreateUrlItem(url);
  if (!item) return { success: false, error: 'Item not found' };

  const pins = await getPinnedItems(groupId);
  const idx = pins.indexOf(item.id);
  if (idx !== -1) {
    pins.splice(idx, 1);
    await savePinnedItems(groupId, pins);
  }

  api.pubsub.publish('group:pin-changed', { groupId, itemId: item.id, pinned: false });
  console.log(`[ext:groups] Unpinned item "${url}" from group ${groupId}`);
  return { success: true, itemId: item.id, groupId };
};

// ===== Group query/save/open helpers =====

const getAllGroups = async () => {
  const result = await api.datastore.getTagsByFrecency();
  if (!result.success) return [];
  return result.data;
};

const saveToGroup = async (groupName) => {
  console.log('[ext:groups] Saving to group:', groupName);
  const tagResult = await api.datastore.getOrCreateTag(groupName);
  if (!tagResult.success) {
    console.error('[ext:groups] Failed to get/create tag:', tagResult.error);
    return { success: false, error: tagResult.error };
  }

  const tag = tagResult.data.tag;
  const tagId = tag.id;

  try {
    let meta = {};
    if (tag.metadata) {
      meta = typeof tag.metadata === 'object' ? tag.metadata : JSON.parse(tag.metadata);
    }
    if (!meta.isGroup) {
      meta.isGroup = true;
      await api.datastore.setRow('tags', tagId, { ...tag, metadata: JSON.stringify(meta) });
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
      if (linkResult.success && !linkResult.alreadyExists) savedCount++;
    }
  }
  console.log(`[ext:groups] Saved ${savedCount} URLs to group "${groupName}"`);

  try {
    if (api.session?.saveSpaceWorkspaces) {
      await api.session.saveSpaceWorkspaces();
    }
  } catch {
  }

  return { success: true, count: savedCount, total: listResult.windows.length };
};

/** Open all URLs in a group (bulk-open path — NOT the home.js showAddresses path) */
const openGroup = async (groupName) => {
  console.log('[ext:groups] Opening group:', groupName);
  const tagsResult = await api.datastore.getTagsByFrecency();
  if (!tagsResult.success) return { success: false, error: 'Failed to get tags' };

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

  const allUrlItems = itemsResult.data
    .map(item => {
      if (item.type === 'url') return { ...item, _openUrl: item.content };
      if (item.type === 'text' && item.content) {
        const urlMatch = item.content.trim().match(/^https?:\/\/\S+/) || item.content.match(/https?:\/\/[^\s<>"')\]]+/i);
        if (urlMatch) {
          try { new URL(urlMatch[0]); return { ...item, _openUrl: urlMatch[0] }; } catch (e) {}
        }
      }
      return null;
    })
    .filter(Boolean);

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

  const pinnedItemIds = await getPinnedItems(tag.id);
  const pinnedSet = new Set(pinnedItemIds);

  activeGroupId = tag.id;
  activeGroupName = tag.name;

  let savedBoundsMap = null;
  let sortedUrlItems = urlItems;
  try {
    // `workspace:<id>` rows are written by `session.ts saveSpaceWorkspaces()`
    // under featureId `space-workspaces` — never under the `spaces` tile's own
    // namespace, which this used to read and which nothing writes.
    const wsResult = api.settings.getExtKey
      ? await api.settings.getExtKey('space-workspaces', 'workspace:' + tag.id)
      : { success: false };
    if (wsResult.success && wsResult.data) {
      const snapshot = typeof wsResult.data === 'string' ? JSON.parse(wsResult.data) : wsResult.data;
      if (snapshot.version === 1 && Array.isArray(snapshot.windows)) {
        savedBoundsMap = new Map();
        for (const w of snapshot.windows) {
          if (w.url && w.bounds) {
            savedBoundsMap.set(normalizeUrlForCompare(w.url), { bounds: w.bounds, zOrder: w.zOrder ?? 0 });
          }
        }
        sortedUrlItems = [...urlItems].sort((a, b) => {
          const aPinned = pinnedSet.has(a.id) ? 1 : 0;
          const bPinned = pinnedSet.has(b.id) ? 1 : 0;
          if (aPinned !== bPinned) return bPinned - aPinned;
          const aZ = savedBoundsMap.get(normalizeUrlForCompare(a._openUrl))?.zOrder ?? 0;
          const bZ = savedBoundsMap.get(normalizeUrlForCompare(b._openUrl))?.zOrder ?? 0;
          return bZ - aZ;
        });
      }
    }
  } catch {
  }

  const openedWindows = [];
  for (const item of sortedUrlItems) {
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
      groupMode: { groupId: tag.id, groupName: tag.name, color: tag.color },
      ...boundsOpts
    });
    if (result?.id) {
      openedWindows.push(result.id);
      await setGroupMode(result.id, tag.id, tag.name, tag.color);
    }
  }

  console.log(`[ext:groups] Opened ${urlItems.length} windows from group "${groupName}"`);
  return { success: true, count: urlItems.length, windowIds: openedWindows };
};

// ===== Registration =====

const initCommands = () => {
  registerNoun({
    name: 'groups',
    singular: 'group',
    description: 'Saved tab groups',

    query: async ({ search }) => {
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

      if (current) {
        const activeIdx = filtered.findIndex(g => g.id === current.groupId);
        if (activeIdx > 0) {
          const [active] = filtered.splice(activeIdx, 1);
          active.name = `${active.name} (active)`;
          filtered.unshift(active);
        }
      }

      if (filtered.length === 0) return { output: 'No groups found.', mimeType: 'text/plain' };

      const title = current
        ? `Groups (${filtered.length}) [scope: ${current.groupName}]`
        : `Groups (${filtered.length})`;

      return {
        success: true,
        output: { data: filtered, mimeType: 'application/json', title }
      };
    },

    browse: async () => { openGroupsWindow(); },
    open: async (ctx) => { if (ctx.search) await openGroup(ctx.search.trim()); },
    create: async ({ search }) => {
      if (!search) return { success: false, error: 'Usage: new group <name>' };
      return await saveToGroup(search.trim());
    },

    produces: 'application/json'
  });
  console.log('[ext:groups] Noun registered: groups');

  // pin <url>
  api.pubsub.subscribe('cmd:execute:pin', async (msg) => {
    const result = await pinItem(msg.search?.trim());
    if (msg.expectResult && msg.resultTopic) {
      api.pubsub.publish(msg.resultTopic, result || { success: true });
    }
  });
  api.pubsub.publish('cmd:register', {
    name: 'pin',
    description: 'Pin a URL in the current group (always opens with group)',
    source: 'groups',
    scope: 'global',
    accepts: [],
    produces: [],
    params: [{ name: 'url', type: 'string', required: true, description: 'URL to pin' }]
  });

  // unpin <url>
  api.pubsub.subscribe('cmd:execute:unpin', async (msg) => {
    const result = await unpinItem(msg.search?.trim());
    if (msg.expectResult && msg.resultTopic) {
      api.pubsub.publish(msg.resultTopic, result || { success: true });
    }
  });
  api.pubsub.publish('cmd:register', {
    name: 'unpin',
    description: 'Unpin a URL from the current group',
    source: 'groups',
    scope: 'global',
    accepts: [],
    produces: [],
    params: [{ name: 'url', type: 'string', required: true, description: 'URL to unpin' }]
  });

  console.log('[ext:groups] Standalone commands registered: pin, unpin');
};

const uninitCommands = () => {
  unregisterNoun('groups');
  for (const name of ['pin', 'unpin']) {
    api.pubsub.publish('cmd:unregister', { name });
  }
  console.log('[ext:groups] Noun and commands unregistered: groups');
};

const initBackground = async () => {
  console.log('[ext:groups] init');
  initCommands();

  api.pubsub.subscribe('window:closed', async (msg) => {
    const closedWindowId = msg?.id;
    if (closedWindowId === groupsWindowId) {
      groupsWindowId = null;
    }
  });
};

const uninitBackground = () => {
  console.log('[ext:groups] uninit');
  uninitCommands();
};

// ============================================================================
// Bootstrap (module top-level)
// ============================================================================
// Runs bg init once at module load. Does NOT block DOMContentLoaded — uses
// fire-and-forget IIFE so the module keeps parsing (registering the
// DOMContentLoaded listener for `init` at the bottom of this file).
// Errors here are logged but do not prevent UI init from running.

(async () => {
  try {
    await api.initialize();
    await initBackground();
    api.onShutdown(() => {
      console.log('[ext:groups] received shutdown');
      uninitBackground();
    });
  } catch (err) {
    console.error('[ext:groups] bootstrap failed:', err);
  }
})();

const init = async () => {

  // Validate capability token with main process — required before any
  // token-gated api.* call (window.open, etc.) can succeed.
  await api.initialize();

  // Initialize tag action rules cache for card affordances
  actionRulesCache = createActionRulesCache(api);

  // Register escape handler for internal navigation
  // Backend handles parent centering, child tracking, and focus restoration
  if (api.escape) {
    api.escape.onEscape(handleEscape);
  }

  // Load view preferences and set up toolbar
  loadViewPrefs();
  setupToolbar();

  // Load tags from datastore
  await loadTags();

  // Set up search input
  const searchInput = document.querySelector('peek-input.search-input');
  searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderCurrentView();
  });

  // Keyboard navigation
  document.addEventListener('keydown', handleKeydown);

  // NOTE: groups should NOT set mode context (spaces migration).

  liveQuery({
    api,
    topics: [
      'tag:item-added',
      'tag:item-removed',
      'tag:created',
      'tag:deleted',
      'tag:renamed',
      'tag:color-changed',
      'item:created',
      'item:updated',
      'item:deleted',
      'sync:pull-completed',
      'group:pin-changed',
    ],
    runImmediately: false,
    onUpdate: async () => {
      await loadTags();
      if (state.view === VIEW_GROUPS) {
        renderGroups();
      } else if (state.view === VIEW_ADDRESSES && state.currentTag) {
        // loadTags only refreshes tag metadata, not the items list shown
        // in the addresses view — reload addresses for the current tag.
        await loadAddressesForTag(state.currentTag.id);
        renderAddresses();
      }
    },
  });

  // Set up create group UI
  setupCreateGroup();

  // Show groups view
  showGroups();
};

/**
 * Render the current view (used after search filtering)
 */
const renderCurrentView = () => {
  if (state.view === VIEW_GROUPS) {
    renderGroups();
  } else {
    renderAddresses();
  }
};

/**
 * Load all tags sorted by frecency, and count untagged addresses
 */
const loadTags = async () => {
  const result = await api.datastore.getTagsByFrecency();
  if (result.success) {
    state.tags = result.data;

    // Fetch URL item count for each tag (only http/https URLs)
    for (const tag of state.tags) {
      const itemsResult = await api.datastore.getItemsByTag(tag.id);
      if (itemsResult.success) {
        tag.addressCount = itemsResult.data.filter(item =>
          item.type === 'url' && isWebUrl(item.content)
        ).length;
      } else {
        tag.addressCount = 0;
      }
    }
  } else {
    console.error('Failed to load tags:', result.error);
    state.tags = [];
  }

  // Get count of untagged URL items (only http/https URLs)
  // Query all items and filter out those with tags
  const allItemsResult = await api.datastore.queryItems({});
  if (allItemsResult.success) {
    const untaggedItems = [];
    for (const item of allItemsResult.data) {
      // Only include http/https URL items
      if (item.type !== 'url' || !isWebUrl(item.content)) continue;
      const tagsResult = await api.datastore.getItemTags(item.id);
      if (tagsResult.success && tagsResult.data.length === 0) {
        untaggedItems.push(item);
      }
    }
    state.untaggedCount = untaggedItems.length;
  } else {
    state.untaggedCount = 0;
  }
};

/**
 * Normalize a URL for deduplication comparison
 */
const normalizeUrlForCompare = (url) => {
  try {
    const u = new URL(url);
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

/**
 * Deduplicate items by URL content, keeping the most recently updated one
 */
const deduplicateByUrl = (items) => {
  const seen = new Map();
  for (const item of items) {
    const normalized = normalizeUrlForCompare(item.content);
    const existing = seen.get(normalized);
    if (!existing || (item.updatedAt || 0) > (existing.updatedAt || 0)) {
      seen.set(normalized, item);
    }
  }
  return Array.from(seen.values());
};

/**
 * Load URL items for a specific tag (only http/https URLs)
 */
const loadAddressesForTag = async (tagId) => {
  const result = await api.datastore.getItemsByTag(tagId);
  if (result.success) {
    // Only include http/https URL items, deduplicated by URL
    const urlItems = result.data.filter(item =>
      item.type === 'url' && isWebUrl(item.content)
    );
    let addresses = deduplicateByUrl(urlItems);

    // Load pinned items for this group and annotate
    try {
      const pinsResult = await api.settings.get(`pins:${tagId}`);
      if (!pinsResult.error && Array.isArray(pinsResult.value)) {
        const pinnedSet = new Set(pinsResult.value);
        addresses = addresses.map(addr => ({
          ...addr,
          _pinned: pinnedSet.has(addr.id)
        }));
        // Sort pinned items first
        addresses.sort((a, b) => (b._pinned ? 1 : 0) - (a._pinned ? 1 : 0));
      }
    } catch {
    }

    state.addresses = addresses;
  } else {
    console.error('Failed to load addresses:', result.error);
    state.addresses = [];
  }
};

/**
 * Filter groups by search query
 */
const filterGroups = (groups) => {
  if (!state.searchQuery) return groups;
  const q = state.searchQuery.toLowerCase();
  return groups.filter(tag => tag.name.toLowerCase().includes(q));
};

/**
 * Filter addresses by search query (title or URL)
 * Handles both Address (uri) and Item (content) objects
 */
const filterAddresses = (addresses) => {
  if (!state.searchQuery) return addresses;
  const q = state.searchQuery.toLowerCase();
  return addresses.filter(addr => {
    const url = addr.uri || addr.content || '';
    return (addr.title || '').toLowerCase().includes(q) ||
      url.toLowerCase().includes(q);
  });
};

/**
 * Create inline sort controls (dropdown + direction toggle) and append to a container.
 * Removes any existing inline sort controls first.
 */
const addInlineSortControls = (container) => {
  if (!container) return;

  // Remove existing inline sort controls
  const existing = container.querySelector('.inline-sort-controls');
  if (existing) existing.remove();

  const controls = document.createElement('div');
  controls.className = 'inline-sort-controls';

  // Sort dropdown wrapper
  const sortWrapper = document.createElement('div');
  sortWrapper.className = 'inline-sort-wrapper';

  const select = document.createElement('select');
  select.className = 'inline-sort-select';
  SORT_OPTIONS_ADDRESSES.forEach(opt => {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    if (opt.value === viewPrefs.sortBy) option.selected = true;
    select.appendChild(option);
  });
  select.addEventListener('change', () => {
    viewPrefs.sortBy = select.value;
    saveViewPrefs();
    renderCurrentView();
  });
  sortWrapper.appendChild(select);

  // Dropdown arrow
  const arrow = document.createElement('svg');
  arrow.className = 'inline-sort-arrow';
  arrow.setAttribute('width', '10');
  arrow.setAttribute('height', '10');
  arrow.setAttribute('viewBox', '0 0 10 10');
  arrow.setAttribute('fill', 'none');
  arrow.innerHTML = '<path d="M2.5 3.75L5 6.25L7.5 3.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
  sortWrapper.appendChild(arrow);

  controls.appendChild(sortWrapper);

  // Direction toggle button
  const dirBtn = document.createElement('button');
  dirBtn.className = 'inline-sort-dir-btn';
  dirBtn.title = viewPrefs.sortDirection === 'asc' ? 'Ascending' : 'Descending';
  const updateDirIcon = () => {
    dirBtn.title = viewPrefs.sortDirection === 'asc' ? 'Ascending' : 'Descending';
    dirBtn.innerHTML = viewPrefs.sortDirection === 'asc'
      ? '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 11V3M7 3L4 6M7 3L10 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 3V11M7 11L4 8M7 11L10 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  };
  updateDirIcon();
  dirBtn.addEventListener('click', () => {
    viewPrefs.sortDirection = viewPrefs.sortDirection === 'asc' ? 'desc' : 'asc';
    saveViewPrefs();
    updateDirIcon();
    renderCurrentView();
  });
  controls.appendChild(dirBtn);

  container.appendChild(controls);
};

/**
 * Show the groups (tags) view
 */
const showGroups = async () => {
  // Remember which group was being viewed so we can focus it in the list
  if (state.currentTag) {
    state.lastViewedTagId = state.currentTag.id;
  }
  state.view = VIEW_GROUPS;
  state.currentTag = null;
  state.searchQuery = '';

  // Reset mode context to 'default' when returning to groups list
  if (api.context) {
    try {
      await api.context.setMode('default', {});
    } catch (err) {
      console.error('[groups] Failed to reset mode:', err);
    }
  }

  // Refresh tags
  await loadTags();

  // Update search placeholder
  const searchInput = document.querySelector('peek-input.search-input');
  searchInput.value = '';
  searchInput.placeholder = 'Search groups...';

  // Show create group button again
  const createBtn = document.querySelector('.create-group-btn');
  if (createBtn) createBtn.style.display = '';

  // Show peek-grid-toolbar again
  const toolbar = document.querySelector('peek-grid-toolbar.grid-toolbar');
  if (toolbar) toolbar.style.display = '';

  // Remove inline sort controls from search row
  const inlineSort = document.querySelector('.inline-sort-controls');
  if (inlineSort) inlineSort.remove();

  renderGroups();
};

// Expose for testing (Playwright escape doesn't trigger Electron before-input-event)
window.showGroups = showGroups;

/**
 * Render groups cards (separate from showGroups for filtering)
 */
const renderGroups = () => {
  const container = document.querySelector('.cards');
  container.innerHTML = '';
  updateToolbarSortOptions();

  // Hide the group detail header when showing the groups list
  renderGroupHeader();

  // Separate promoted groups from regular tags
  const promotedGroups = state.tags.filter(tag => isGroupTag(tag));
  const unpromotedTags = state.tags.filter(tag => !isGroupTag(tag));

  // Build list of groups to show
  let groupsToShow = [];
  if (state.untaggedCount > 0) {
    groupsToShow.push({ ...UNTAGGED_GROUP, frequency: state.untaggedCount });
  }
  groupsToShow = groupsToShow.concat(promotedGroups);

  // Apply search filter
  let filteredGroups = filterGroups(groupsToShow);

  // Apply sorting
  filteredGroups = sortGroups(filteredGroups);

  if (filteredGroups.length === 0) {
    const message = state.searchQuery
      ? 'No groups match your search.'
      : 'No groups yet. Create a group or promote tags below.';
    container.innerHTML = `<div class="empty-state">${message}</div>`;
  } else {
    filteredGroups.forEach(tag => {
      const card = createGroupCard(tag);
      container.appendChild(card);
    });
  }

  // Tags section — always show unpromoted tags below a separator
  const hasUnpromotedTags = unpromotedTags.length > 0;
  if (hasUnpromotedTags) {
    const separator = document.createElement('div');
    separator.className = 'all-tags-toggle';

    const label = document.createElement('span');
    label.className = 'all-tags-label';
    label.textContent = `Tags (${unpromotedTags.length})`;
    separator.appendChild(label);
    container.appendChild(separator);

    let filteredTags = filterGroups(unpromotedTags);
    filteredTags = sortGroups(filteredTags);
    filteredTags.forEach(tag => {
      const card = createGroupCard(tag, { showPromote: true });
      container.appendChild(card);
    });
  }

  // Select the last-viewed group if returning from addresses view, otherwise reset to 0
  if (state.lastViewedTagId) {
    const cards = Array.from(container.querySelectorAll('peek-card'));
    const targetIndex = cards.findIndex(card => card.dataset.tagId === String(state.lastViewedTagId));
    state.selectedIndex = targetIndex >= 0 ? targetIndex : 0;
    state.lastViewedTagId = null;
  } else {
    state.selectedIndex = 0;
  }
  updateSelection();
};

/**
 * Show addresses in a group (tag)
 */
const showAddresses = async (tag) => {
  state.view = VIEW_ADDRESSES;
  state.currentTag = tag;
  state.searchQuery = '';

  // Set group mode context for this window when viewing a real group
  // (not the special untagged pseudo-group). Mode persists per-window and
  // is used by HUD, child page inheritance, and other consumers.
  if (api.context && tag && !tag.isSpecial) {
    try {
      await api.context.setMode('group', {
        metadata: {
          groupId: tag.id,
          groupName: tag.name,
          color: tag.color
        }
      });
    } catch (err) {
      console.error('[groups] Failed to set group mode:', err);
    }
  }

  // Load URL items - handle special untagged group (only http/https URLs)
  if (tag.isSpecial && tag.id === '__untagged__') {
    const allItemsResult = await api.datastore.queryItems({});
    if (allItemsResult.success) {
      const untaggedItems = [];
      for (const item of allItemsResult.data) {
        // Only include http/https URL items
        if (item.type !== 'url' || !isWebUrl(item.content)) continue;
        const tagsResult = await api.datastore.getItemTags(item.id);
        if (tagsResult.success && tagsResult.data.length === 0) {
          untaggedItems.push(item);
        }
      }
      state.addresses = untaggedItems;
    } else {
      state.addresses = [];
    }
  } else {
    await loadAddressesForTag(tag.id);
  }

  // Update search placeholder with group name
  const searchInput = document.querySelector('peek-input.search-input');
  searchInput.value = '';
  searchInput.placeholder = `Search in ${tag.name}...`;

  // Hide create group button and form in detail view
  const createBtn = document.querySelector('.create-group-btn');
  const createForm = document.querySelector('.create-group-form');
  if (createBtn) createBtn.style.display = 'none';
  if (createForm) createForm.style.display = 'none';

  // Hide peek-grid-toolbar in detail view
  const toolbar = document.querySelector('peek-grid-toolbar.grid-toolbar');
  if (toolbar) toolbar.style.display = 'none';

  // Add inline sort controls to search row
  const searchRow = document.querySelector('.search-row');
  addInlineSortControls(searchRow);

  renderAddresses();
};

/**
 * Render the group detail header with group name and rename support.
 * Double-click the name to rename.
 */
const renderGroupHeader = () => {
  const header = document.querySelector('body > .group-detail-header');
  if (!header) return;

  const tag = state.currentTag;
  if (!tag) {
    // Hide header when not viewing a specific group
    header.style.display = 'none';
    header.innerHTML = '';
    return;
  }

  // Show and populate header
  header.style.display = '';
  header.innerHTML = '';

  const nameEl = document.createElement('span');
  nameEl.className = 'group-header-name';
  nameEl.textContent = tag.name;
  // Double-click to rename (not for special groups like Untagged)
  if (!tag.isSpecial) {
    nameEl.title = 'Double-click to rename';
    nameEl.addEventListener('dblclick', () => startRenameGroup(header, tag));
  }
  header.appendChild(nameEl);

  // Rename button + color dot (not for special groups)
  if (!tag.isSpecial) {
    const renameBtn = document.createElement('button');
    renameBtn.className = 'group-rename-btn';
    renameBtn.title = 'Rename group';
    renameBtn.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>' +
      '<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>' +
      '</svg>';
    renameBtn.addEventListener('click', () => startRenameGroup(header, tag));
    header.appendChild(renameBtn);

    // Color dot with hidden color picker
    const colorDot = document.createElement('div');
    colorDot.className = 'group-header-color-dot';
    colorDot.style.backgroundColor = tag.color || '#999';
    colorDot.title = 'Change group color';

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'group-header-color-input';
    colorInput.value = tag.color || '#999999';
    colorInput.addEventListener('input', (e) => {
      colorDot.style.backgroundColor = e.target.value;
    });
    colorInput.addEventListener('change', async (e) => {
      const newColor = e.target.value;
      tag.color = newColor;
      await api.datastore.updateTagColor(tag.id, newColor);
      // NOTE: groups should NOT set mode context (spaces migration).
    });

    colorDot.addEventListener('click', () => colorInput.click());
    colorDot.appendChild(colorInput);
    header.appendChild(colorDot);
  }

  // Spacer to push view mode buttons to the right
  const spacer = document.createElement('div');
  spacer.className = 'group-header-spacer';
  header.appendChild(spacer);

  // View mode buttons
  const viewModes = document.createElement('div');
  viewModes.className = 'group-header-view-modes';

  const modes = [
    { mode: 'columns', title: 'Grid view', svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="8" y="1" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="1" y="8" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="8" y="8" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>' },
    { mode: 'list', title: 'List view', svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><line x1="1" y1="3" x2="13" y2="3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="1" y1="11" x2="13" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' },
    { mode: 'masonry', title: 'Masonry view', svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="1" width="5" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="8" y="1" width="5" height="4" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="1" y="10" width="5" height="3" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="8" y="7" width="5" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>' },
    { mode: 'freeform', title: 'Freeform view', svg: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="1" width="4" height="3" rx="0.5" stroke="currentColor" stroke-width="1.5"/><rect x="7" y="2" width="6" height="4" rx="0.5" stroke="currentColor" stroke-width="1.5"/><rect x="2" y="6" width="5" height="4" rx="0.5" stroke="currentColor" stroke-width="1.5"/><rect x="9" y="8" width="4" height="5" rx="0.5" stroke="currentColor" stroke-width="1.5"/></svg>' }
  ];

  modes.forEach(({ mode, title, svg }) => {
    const btn = document.createElement('button');
    btn.className = 'ghvm-btn' + (viewPrefs.viewMode === mode ? ' active' : '');
    btn.title = title;
    btn.innerHTML = svg;
    btn.addEventListener('click', () => {
      viewPrefs.viewMode = mode;
      saveViewPrefs();
      // Update peek-grid view-mode attribute
      const grid = document.querySelector('peek-grid.cards');
      if (grid) grid.setAttribute('view-mode', mode);
      // Re-render header to update active state and freeform edit toggle
      renderGroupHeader();
      renderCurrentView();
    });
    viewModes.appendChild(btn);
  });

  // Freeform edit toggle (only visible when freeform mode is active)
  if (viewPrefs.viewMode === 'freeform') {
    const editBtn = document.createElement('button');
    const grid = document.querySelector('peek-grid.cards');
    const isEditing = grid && grid.getAttribute('freeform-editing') === 'true';
    editBtn.className = 'ghvm-btn' + (isEditing ? ' active' : '');
    editBtn.title = isEditing ? 'Exit edit mode' : 'Edit layout';
    editBtn.style.marginLeft = '4px';
    editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M10.5 1.5L12.5 3.5L4.5 11.5L1.5 12.5L2.5 9.5L10.5 1.5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    editBtn.addEventListener('click', () => {
      const g = document.querySelector('peek-grid.cards');
      const toolbar = document.querySelector('.grid-toolbar');
      const newVal = !(g && g.getAttribute('freeform-editing') === 'true');
      if (g) g.setAttribute('freeform-editing', String(newVal));
      if (toolbar) {
        toolbar.freeformEditing = newVal;
        toolbar.dispatchEvent(new CustomEvent('freeform-editing-change', { detail: { editing: newVal }, bubbles: true }));
      }
      renderGroupHeader();
    });
    viewModes.appendChild(editBtn);
  }

  header.appendChild(viewModes);
};

/**
 * Start inline rename of a group
 */
const startRenameGroup = (headerEl, tag) => {
  // Replace name element with input
  const nameEl = headerEl.querySelector('.group-header-name');
  const renameBtn = headerEl.querySelector('.group-rename-btn');
  if (!nameEl) return;

  const input = document.createElement('input');
  input.className = 'group-rename-input';
  input.type = 'text';
  input.value = tag.name;

  const finishRename = async (commit) => {
    const newName = input.value.trim();
    if (commit && newName && newName !== tag.name) {
      try {
        const result = await api.datastore.renameTag(tag.id, newName);
        if (result.success) {
          tag.name = newName;
          // Update search placeholder
          const searchInput = document.querySelector('peek-input.search-input');
          searchInput.placeholder = `Search in ${newName}...`;
          // NOTE: groups should NOT set mode context (spaces migration).
        } else {
          console.error('[groups] Failed to rename group:', result.error);
        }
      } catch (err) {
        console.error('[groups] Error renaming group:', err);
      }
    }
    // Restore display
    nameEl.textContent = tag.name;
    nameEl.style.display = '';
    input.remove();
    if (renameBtn) renameBtn.style.display = '';
  };

  nameEl.style.display = 'none';
  if (renameBtn) renameBtn.style.display = 'none';
  headerEl.insertBefore(input, nameEl.nextSibling);
  input.focus();
  input.select();

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finishRename(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finishRename(false);
    }
  });
  input.addEventListener('blur', () => finishRename(true));
};

/**
 * Render address cards (separate from showAddresses for filtering)
 */
const renderAddresses = () => {
  const container = document.querySelector('.cards');
  container.innerHTML = '';
  updateToolbarSortOptions();

  // Render group detail header
  renderGroupHeader();

  // Apply search filter
  let filteredAddresses = filterAddresses(state.addresses);

  if (filteredAddresses.length === 0) {
    const message = state.searchQuery
      ? 'No pages match your search.'
      : 'No pages in this group yet.';
    const emptyEl = document.createElement('div');
    emptyEl.className = 'empty-state';
    emptyEl.textContent = message;
    container.appendChild(emptyEl);
    return;
  }

  // Apply sorting
  filteredAddresses = sortAddresses(filteredAddresses);

  filteredAddresses.forEach(address => {
    const card = createAddressCard(address);
    container.appendChild(card);
  });

  // Reset selection
  state.selectedIndex = 0;
  updateSelection();
};

/**
 * Create a card element for a group (tag)
 * @param {object} tag - Tag object
 * @param {object} [options] - Options
 * @param {boolean} [options.showPromote] - Show "Add to Groups" button for unpromoted tags
 */
const createGroupCard = (tag, options = {}) => {
  const card = document.createElement('peek-card');
  card.className = 'group-card';
  card.interactive = true;
  if (tag.isSpecial) {
    card.classList.add('special-group');
  }
  if (options.showPromote) {
    card.classList.add('unpromoted-tag');
  }
  card.dataset.tagId = tag.id;

  // Header slot: color dot + name
  const header = document.createElement('div');
  header.slot = 'header';
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.gap = '8px';

  const colorDot = document.createElement('div');
  colorDot.className = 'color-dot';
  colorDot.style.backgroundColor = tag.color || '#999';

  const title = document.createElement('h2');
  title.className = 'card-title';
  title.textContent = tag.name;
  title.style.margin = '0';
  title.style.flex = '1';
  title.style.minWidth = '0';

  header.appendChild(colorDot);
  header.appendChild(title);

  // Add "promote to group" button for unpromoted tags
  if (options.showPromote) {
    const promoteBtn = document.createElement('button');
    promoteBtn.className = 'promote-btn';
    promoteBtn.title = 'Add to Groups';
    promoteBtn.textContent = '+';
    promoteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await promoteTagToGroup(tag);
      await loadTags();
      renderGroups();
    });
    header.appendChild(promoteBtn);
  }

  card.appendChild(header);

  // Footer slot: count
  const footer = document.createElement('div');
  footer.slot = 'footer';
  footer.className = 'card-meta';
  const count = tag.isSpecial ? (tag.frequency || 0) : (tag.addressCount || 0);
  footer.textContent = `${count} ${count === 1 ? 'page' : 'pages'}`;
  card.appendChild(footer);

  // Click to view addresses in this group
  card.addEventListener('card-click', () => showAddresses(tag));

  return card;
};

/**
 * Create a card element for an address using the shared search-result-card builder.
 * Handles both Address (uri) and Item (content) objects.
 *
 * Action buttons (open-inline, delete) are rendered via <peek-item-actions>
 * rather than the imperative onOpen/onDelete callbacks so the same component
 * can be reused across all feature browsers.
 */
const createAddressCard = (address) => {
  const addressUrl = address.uri || address.content;
  const rules = actionRulesCache ? actionRulesCache.getRules() : [];

  const card = createSearchResultCard(address, {
    className: 'address-card',
    visitCount: address.visitCount,
    // showOpenButton / onOpen / onDelete intentionally omitted here —
    // action buttons are provided by <peek-item-actions> below.
    onTagRemove: async (item, tag) => {
      try {
        await api.datastore.untagItem(item.id, tag.id);
        api.pubsub.publish('tag:item-removed', { itemId: item.id, tagId: tag.id });
        if (state.currentTag) { await loadAddressesForTag(state.currentTag.id); renderAddresses(); }
      } catch (err) {
        console.error('[groups] Failed to remove tag:', err);
      }
    },
    onTagClick: (tag) => {
      // Navigate to addresses view for the clicked tag
      const matchingTag = state.tags.find(t => t.name === tag.name || t.id === tag.id);
      if (matchingTag) {
        showAddresses(matchingTag);
      }
    },
    onClick: async () => {
      const openOptions = {
        role: 'content',
        key: addressUrl,
        width: 1024,
        height: 768
      };
      if (state.currentTag && state.currentTag.id !== '__untagged__') {
        openOptions.groupMode = {
          groupId: state.currentTag.id,
          groupName: state.currentTag.name,
          color: state.currentTag.color
        };
      }
      await api.window.open(addressUrl, openOptions);
    }
  });

  card.dataset.addressId = address.id;

  // ── peek-item-actions: open-inline + delete ────────────────────────
  // Inject <peek-item-actions> into the card header. The component
  // emits composed events; we handle them here with the full api context.
  const header = card.querySelector('[slot="header"]');
  if (header) {
    // Shared container for all header-right buttons (actions + remove-from-group)
    const btnGroup = document.createElement('span');
    btnGroup.className = 'card-btn-group';

    const actions = document.createElement('peek-item-actions');
    actions.item = address;
    if (isWebUrl(addressUrl)) {
      actions.setAttribute('show-open-inline', '');
    }
    actions.setAttribute('show-delete', '');

    actions.addEventListener('action-open-inline', (e) => {
      e.stopPropagation();
      const url = e.detail.url;
      const openOptions = {
        role: 'content',
        key: url,
        width: 1024,
        height: 768
      };
      if (state.currentTag && state.currentTag.id !== '__untagged__') {
        openOptions.groupMode = {
          groupId: state.currentTag.id,
          groupName: state.currentTag.name,
          color: state.currentTag.color
        };
      }
      api.window.open(url, openOptions);
    });

    actions.addEventListener('action-delete', async (e) => {
      e.stopPropagation();
      const item = e.detail.item;
      if (!confirm(`Delete "${item.title || item.content || 'this item'}"?`)) return;
      try {
        await api.datastore.deleteItem(item.id);
        api.pubsub.publish('item:deleted', { id: item.id });
        if (state.currentTag) { await loadAddressesForTag(state.currentTag.id); renderAddresses(); }
      } catch (err) {
        console.error('[groups] Failed to delete item:', err);
      }
    });

    btnGroup.appendChild(actions);

    // "Remove from group" button — only when viewing a real tag group
    if (state.currentTag && !state.currentTag.isSpecial) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'card-remove-group-btn';
      removeBtn.title = `Remove from ${state.currentTag.name}`;
      removeBtn.innerHTML =
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<line x1="18" y1="6" x2="6" y2="18"></line>' +
        '<line x1="6" y1="6" x2="18" y2="18"></line>' +
        '</svg>';
      removeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await api.datastore.untagItem(address.id, state.currentTag.id);
          api.pubsub.publish('tag:item-removed', { itemId: address.id, tagId: state.currentTag.id });
          if (state.currentTag) { await loadAddressesForTag(state.currentTag.id); renderAddresses(); }
        } catch (err) {
          console.error('[groups] Failed to remove item from group:', err);
        }
      });
      btnGroup.appendChild(removeBtn);
    }

    header.appendChild(btnGroup);
  }

  // Show pin indicator if item is pinned in this group
  if (address._pinned) {
    const header = card.querySelector('[slot="header"]');
    if (header) {
      const pinBadge = document.createElement('span');
      pinBadge.className = 'pin-badge';
      pinBadge.textContent = 'pinned';
      pinBadge.style.cssText = 'font-size:10px;padding:2px 6px;border-radius:8px;background:rgba(255,180,60,0.3);color:rgba(255,200,100,0.9);flex-shrink:0;';
      header.appendChild(pinBadge);
    }
  }

  // Async: load item tags and render tag chips + affordances
  api.datastore.getItemTags(address.id).then(tagsResult => {
    if (!tagsResult.success || !tagsResult.data.length) return;
    const tags = tagsResult.data;
    const footer = card.querySelector('[slot="footer"]');
    if (!footer) return;

    // Build right-side container for tags and affordances
    let footerRight = footer.querySelector('span:last-child');
    if (!footerRight || footerRight.className === 'card-url') {
      footerRight = document.createElement('span');
      footerRight.style.cssText = 'display:flex;align-items:center;gap:6px;flex-shrink:0;';
      footer.appendChild(footerRight);
    }

    // Tag action affordances
    if (rules.length > 0) {
      const tagNames = tags.map(t => t.name);
      const el = createAffordanceElements(address.id, tagNames, rules, api, {
        onToggle: () => {
          if (state.currentTag) loadAddressesForTag(state.currentTag.id).then(() => renderAddresses());
        }
      });
      if (el) footerRight.appendChild(el);
    }

    // Tag chips with remove buttons
    const tagsContainer = document.createElement('span');
    tagsContainer.className = 'card-tags';
    tagsContainer.style.cssText = 'display:flex;gap:3px;flex-wrap:wrap;flex-shrink:0;';
    tags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className = 'card-tag';
      chip.dataset.tagId = tag.id;
      chip.textContent = tag.name;
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        const matchingTag = state.tags.find(t => t.name === tag.name || t.id === tag.id);
        if (matchingTag) showAddresses(matchingTag);
      });

      const removeBtn = document.createElement('span');
      removeBtn.className = 'card-tag-remove';
      removeBtn.textContent = '\u00D7';
      removeBtn.title = `Remove ${tag.name}`;
      removeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        // Optimistic removal: hide chip immediately for instant visual feedback
        chip.remove();
        try {
          await api.datastore.untagItem(address.id, tag.id);
          api.pubsub.publish('tag:item-removed', { itemId: address.id, tagId: tag.id });
        } catch (err) {
          console.error('[groups] Failed to remove tag:', err);
        }
      });
      chip.appendChild(removeBtn);

      tagsContainer.appendChild(chip);
    });
    footerRight.appendChild(tagsContainer);
  });

  return card;
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
