/**
 * Groups — the decisions, with no DOM
 *
 * `home.js` is a tile renderer: it reads `window.app` at import time and
 * touches the document throughout, so none of it can be loaded outside a
 * browser. Everything here is the part of that feature that decides something
 * — URL normalisation, filtering, sorting, pins, and the suspend/restore of a
 * group's windows — with the pieces `home.js` keeps in module scope (the
 * active-group record, the suspended-window map, `window.app`) passed in
 * instead of closed over. `home.js` imports these back and supplies its own
 * state, so this file is the only definition of each rule.
 *
 * The window-touching functions take a `deps` object:
 *   api              — the tile API (`window.app` in the renderer)
 *   groupState       — `{ activeGroupId, activeGroupName }`, mutated in place
 *   suspendedGroups  — `Map<groupId, windowId[]>`, mutated in place
 *   openGroup        — the bulk-open path, used as the fallback when a group
 *                      is not suspended or its windows are gone
 */

/**
 * Check if a URL is a navigable web URL (http/https only)
 * Excludes peek:// and other internal URLs
 */
export const isWebUrl = (url) => {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
};

/**
 * Parse tag metadata JSON safely
 */
export const parseTagMetadata = (tag) => {
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
export const isGroupTag = (tag) => {
  const meta = parseTagMetadata(tag);
  return meta.isGroup === true;
};

/**
 * Normalize a URL for deduplication comparison
 */
export const normalizeUrlForCompare = (url) => {
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
export const deduplicateByUrl = (items) => {
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
 * Filter groups by search query
 */
export const filterGroups = (groups, searchQuery) => {
  if (!searchQuery) return groups;
  const q = searchQuery.toLowerCase();
  return groups.filter(tag => tag.name.toLowerCase().includes(q));
};

/**
 * Filter addresses by search query (title or URL)
 * Handles both Address (uri) and Item (content) objects
 */
export const filterAddresses = (addresses, searchQuery) => {
  if (!searchQuery) return addresses;
  const q = searchQuery.toLowerCase();
  return addresses.filter(addr => {
    const url = addr.uri || addr.content || '';
    return (addr.title || '').toLowerCase().includes(q) ||
      url.toLowerCase().includes(q);
  });
};

/**
 * Sort groups by the given view preferences. Sorts in place and returns the
 * same array, which is what the render path relies on.
 */
export const sortGroups = (groups, sortBy, sortDirection) => {
  const dir = sortDirection === 'asc' ? 1 : -1;
  return groups.sort((a, b) => {
    switch (sortBy) {
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
 * Sort addresses by the given view preferences. Sorts in place and returns the
 * same array.
 */
export const sortAddresses = (addresses, sortBy, sortDirection) => {
  const dir = sortDirection === 'asc' ? 1 : -1;
  return addresses.sort((a, b) => {
    switch (sortBy) {
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

// ===== Pins =====

/**
 * Mark each address with whether it is pinned in this group and move the
 * pinned ones to the front. Returns a new array of new objects; the input is
 * left alone.
 */
export const annotatePinnedFirst = (addresses, pinnedItemIds) => {
  const pinnedSet = new Set(pinnedItemIds);
  const annotated = addresses.map(addr => ({
    ...addr,
    _pinned: pinnedSet.has(addr.id)
  }));
  annotated.sort((a, b) => (b._pinned ? 1 : 0) - (a._pinned ? 1 : 0));
  return annotated;
};

/**
 * Add an item to a group's pin list, in place. Returns whether the list
 * changed, so the caller only persists when it did.
 */
export const addPinnedId = (pinnedItemIds, itemId) => {
  if (pinnedItemIds.includes(itemId)) return false;
  pinnedItemIds.push(itemId);
  return true;
};

/**
 * Remove an item from a group's pin list, in place. Returns whether the list
 * changed.
 */
export const removePinnedId = (pinnedItemIds, itemId) => {
  const idx = pinnedItemIds.indexOf(itemId);
  if (idx === -1) return false;
  pinnedItemIds.splice(idx, 1);
  return true;
};

// ===== Active group, suspend and restore =====

/** Resolve current group from active context or last focused window */
export const resolveCurrentGroup = async (api, activeGroupId, activeGroupName) => {
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
export const closeGroup = async (deps, groupId = null, groupName = null) => {
  const { api, groupState, suspendedGroups } = deps;
  if (!groupId) {
    const current = await resolveCurrentGroup(api, groupState.activeGroupId, groupState.activeGroupName);
    if (current) { groupId = current.groupId; groupName = current.groupName; }
  }
  if (!groupId) return { success: false, error: 'No active group to close' };

  try {
    await api.session.saveWorkspaceSnapshot(groupId);
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

  if (groupState.activeGroupId === groupId) {
    groupState.activeGroupId = null;
    groupState.activeGroupName = null;
  }

  console.log(`[ext:groups] Closed group "${groupName || groupId}": hid ${hiddenIds.length} window(s)`);
  return { success: true, count: hiddenIds.length, groupId, groupName };
};

/** Restore a suspended group — show all hidden windows */
export const restoreGroup = async (deps, groupId, groupName = null) => {
  const { api, groupState, suspendedGroups, openGroup } = deps;
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

  groupState.activeGroupId = groupId;
  groupState.activeGroupName = groupName;
  console.log(`[ext:groups] Restored group "${groupName || groupId}": showed ${restoredCount} window(s)`);
  return { success: true, count: restoredCount };
};

/** Switch from current group to target group */
export const switchGroup = async (deps, targetGroupName) => {
  const { api, groupState } = deps;
  if (!targetGroupName) return { success: false, error: 'Usage: switch group <name>' };
  const tagsResult = await api.datastore.getTagsByFrecency();
  if (!tagsResult.success) return { success: false, error: 'Failed to get tags' };
  const targetTag = tagsResult.data.find(t => t.name.toLowerCase() === targetGroupName.toLowerCase());
  if (!targetTag) return { success: false, error: `Group "${targetGroupName}" not found` };
  const current = await resolveCurrentGroup(api, groupState.activeGroupId, groupState.activeGroupName);
  if (current && current.groupId !== targetTag.id) {
    await closeGroup(deps, current.groupId, current.groupName);
  }
  const result = await restoreGroup(deps, targetTag.id, targetTag.name);
  console.log(`[ext:groups] Switched to group "${targetGroupName}"`);
  return result;
};

// ===== Command-palette listing =====

/**
 * Move the current group to the front of a listing and mark it. Reorders the
 * given array in place and returns it. A group already at the front keeps its
 * plain name.
 */
export const highlightActiveGroup = (groups, current) => {
  if (current) {
    const activeIdx = groups.findIndex(g => g.id === current.groupId);
    if (activeIdx > 0) {
      const [active] = groups.splice(activeIdx, 1);
      active.name = `${active.name} (active)`;
      groups.unshift(active);
    }
  }
  return groups;
};

/** Title for the groups listing, naming the current group when there is one */
export const formatGroupsTitle = (count, current) => current
  ? `Groups (${count}) [scope: ${current.groupName}]`
  : `Groups (${count})`;
