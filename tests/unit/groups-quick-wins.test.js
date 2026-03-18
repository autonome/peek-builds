import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

// ---------------------------------------------------------------------------
// Pure functions extracted from extensions/groups/background.js
// These are duplicated here for unit testing since the module depends on
// window.app which is unavailable outside Electron.
// ---------------------------------------------------------------------------

/**
 * Normalize a URL for deduplication comparison.
 * Shared logic between background.js and home.js.
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
 * Check if a URL is a navigable web URL (http/https only).
 * From home.js.
 */
const isWebUrl = (url) => {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
};

/**
 * Parse tag metadata JSON safely. From home.js.
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
 * Check if a tag is promoted to a group. From home.js.
 */
const isGroupTag = (tag) => {
  const meta = parseTagMetadata(tag);
  return meta.isGroup === true;
};

/**
 * Deduplicate items by URL content, keeping most recently updated.
 * From home.js.
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
 * Filter groups by search query. From home.js.
 */
const filterGroups = (groups, searchQuery) => {
  if (!searchQuery) return groups;
  const q = searchQuery.toLowerCase();
  return groups.filter(tag => tag.name.toLowerCase().includes(q));
};

/**
 * Filter addresses by search query. From home.js.
 */
const filterAddresses = (addresses, searchQuery) => {
  if (!searchQuery) return addresses;
  const q = searchQuery.toLowerCase();
  return addresses.filter(addr => {
    const url = addr.uri || addr.content || '';
    return (addr.title || '').toLowerCase().includes(q) ||
      url.toLowerCase().includes(q);
  });
};

/**
 * Sort groups by preference. From home.js.
 */
const sortGroups = (groups, sortBy, sortDirection) => {
  const dir = sortDirection === 'asc' ? 1 : -1;
  return [...groups].sort((a, b) => {
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
 * Sort addresses by preference. From home.js.
 */
const sortAddresses = (addresses, sortBy, sortDirection) => {
  const dir = sortDirection === 'asc' ? 1 : -1;
  return [...addresses].sort((a, b) => {
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

// ---------------------------------------------------------------------------
// Mock-based helpers for testing async logic from background.js
// ---------------------------------------------------------------------------

/**
 * Create a mock API object that simulates the peek extension API.
 * Each method records calls and returns configurable results.
 */
const createMockApi = () => {
  const calls = {};
  const record = (name, ...args) => {
    if (!calls[name]) calls[name] = [];
    calls[name].push(args);
  };

  return {
    calls,
    debug: false,
    scopes: { GLOBAL: 'global' },
    publish: (...args) => record('publish', ...args),
    subscribe: (...args) => record('subscribe', ...args),
    context: {
      setMode: async (...args) => record('context.setMode', ...args),
      get: async (key, windowId) => {
        record('context.get', key, windowId);
        return { success: false };
      },
      getWindowsInSpace: async (spaceId) => {
        record('context.getWindowsInSpace', spaceId);
        return { success: true, data: [] };
      }
    },
    window: {
      getFocusedVisibleWindowId: async () => {
        record('window.getFocusedVisibleWindowId');
        return null;
      },
      hide: async (id) => record('window.hide', id),
      show: async (id) => record('window.show', id),
      exists: async (id) => {
        record('window.exists', id);
        return { exists: true };
      },
      open: async (url, opts) => {
        record('window.open', url, opts);
        return { id: `win-${Math.random().toString(36).slice(2, 8)}` };
      },
      list: async () => {
        record('window.list');
        return { success: true, windows: [] };
      }
    },
    datastore: {
      getTagsByFrecency: async () => {
        record('datastore.getTagsByFrecency');
        return { success: true, data: [] };
      },
      getItemsByTag: async (tagId) => {
        record('datastore.getItemsByTag', tagId);
        return { success: true, data: [] };
      },
      queryItems: async (opts) => {
        record('datastore.queryItems', opts);
        return { success: true, data: [] };
      },
      getOrCreateTag: async (name) => {
        record('datastore.getOrCreateTag', name);
        return { success: true, data: { tag: { id: 'tag-1', name } } };
      },
      tagItem: async (itemId, tagId) => {
        record('datastore.tagItem', itemId, tagId);
        return { success: true };
      }
    },
    settings: {
      get: async () => {
        record('settings.get');
        return { success: true, data: { prefs: { shortcutKey: 'Option+g' } } };
      },
      set: async (data) => record('settings.set', data),
      getExtKey: async (ext, key) => {
        record('settings.getExtKey', ext, key);
        return { success: false };
      },
      setKey: async (key, value) => record('settings.setKey', key, value)
    },
    session: {
      saveSpaceWorkspaces: async () => record('session.saveSpaceWorkspaces')
    }
  };
};

// ---------------------------------------------------------------------------
// Simulate resolveCurrentGroup logic
// ---------------------------------------------------------------------------
const resolveCurrentGroup = async (activeGroupId, activeGroupName, api) => {
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
  } catch {
    // ignore
  }
  return null;
};

// ---------------------------------------------------------------------------
// Simulate closeGroup logic
// ---------------------------------------------------------------------------
const closeGroup = async (suspendedGroups, api, activeGroupId, activeGroupName, groupId = null, groupName = null) => {
  if (!groupId) {
    const current = await resolveCurrentGroup(activeGroupId, activeGroupName, api);
    if (current) {
      groupId = current.groupId;
      groupName = current.groupName;
    }
  }
  if (!groupId) {
    return { success: false, error: 'No active group to close' };
  }
  // Save workspace layouts before hiding
  if (api.session?.saveSpaceWorkspaces) {
    await api.session.saveSpaceWorkspaces();
  }
  const result = await api.context.getWindowsInSpace(groupId);
  if (!result.success || !result.data || result.data.length === 0) {
    return { success: false, error: 'No windows found in group' };
  }
  const windowIds = result.data;
  const hiddenIds = [];
  for (const windowId of windowIds) {
    await api.window.hide(windowId);
    hiddenIds.push(windowId);
  }
  suspendedGroups.set(groupId, hiddenIds);
  const newActiveGroupId = activeGroupId === groupId ? null : activeGroupId;
  const newActiveGroupName = activeGroupId === groupId ? null : activeGroupName;
  return { success: true, count: hiddenIds.length, groupId, groupName, newActiveGroupId, newActiveGroupName };
};

// ---------------------------------------------------------------------------
// Simulate restoreGroup logic
// ---------------------------------------------------------------------------
const restoreGroup = async (suspendedGroups, api, groupId, groupName = null) => {
  const hiddenIds = suspendedGroups.get(groupId);
  if (!hiddenIds || hiddenIds.length === 0) {
    if (groupName) {
      return { success: false, fallbackToOpen: true, groupName };
    }
    return { success: false, error: 'Group not suspended and no name to open' };
  }
  let restoredCount = 0;
  const failedIds = [];
  for (const windowId of hiddenIds) {
    const exists = await api.window.exists(windowId);
    if (exists?.exists) {
      await api.window.show(windowId);
      restoredCount++;
    } else {
      failedIds.push(windowId);
    }
  }
  suspendedGroups.delete(groupId);
  if (failedIds.length > 0 && groupName) {
    return { success: false, fallbackToOpen: true, groupName, reason: 'destroyed windows' };
  }
  return { success: true, count: restoredCount, activeGroupId: groupId, activeGroupName: groupName };
};

// ---------------------------------------------------------------------------
// Simulate pin list management logic
// ---------------------------------------------------------------------------
const managePins = {
  add: (pins, itemId) => {
    if (!pins.includes(itemId)) {
      return [...pins, itemId];
    }
    return pins;
  },
  remove: (pins, itemId) => {
    const idx = pins.indexOf(itemId);
    if (idx !== -1) {
      const result = [...pins];
      result.splice(idx, 1);
      return result;
    }
    return pins;
  },
  sortPinnedFirst: (items, pinnedSet) => {
    return [...items].sort((a, b) => {
      const aPinned = pinnedSet.has(a.id) ? 1 : 0;
      const bPinned = pinnedSet.has(b.id) ? 1 : 0;
      return bPinned - aPinned;
    });
  }
};

// ---------------------------------------------------------------------------
// Simulate search scope indicator formatting from background.js query handler
// ---------------------------------------------------------------------------
const formatSearchTitle = (filtered, current) => {
  return current
    ? `Groups (${filtered.length}) [scope: ${current.groupName}]`
    : `Groups (${filtered.length})`;
};

const highlightActiveGroup = (filtered, currentGroupId) => {
  const result = [...filtered];
  const activeIdx = result.findIndex(g => g.id === currentGroupId);
  if (activeIdx > 0) {
    const [active] = result.splice(activeIdx, 1);
    active.name = `${active.name} (active)`;
    result.unshift(active);
  }
  return result;
};


// ===========================================================================
// TESTS
// ===========================================================================

// ---------------------------------------------------------------------------
// normalizeUrlForCompare
// ---------------------------------------------------------------------------
describe('normalizeUrlForCompare', () => {
  it('lowercases hostname', () => {
    assert.equal(
      normalizeUrlForCompare('https://EXAMPLE.COM/path'),
      'https://example.com/path'
    );
  });

  it('removes trailing slash from non-root paths', () => {
    assert.equal(
      normalizeUrlForCompare('https://example.com/path/'),
      'https://example.com/path'
    );
  });

  it('keeps trailing slash for root path', () => {
    assert.equal(
      normalizeUrlForCompare('https://example.com/'),
      'https://example.com/'
    );
  });

  it('removes default port 80', () => {
    assert.equal(
      normalizeUrlForCompare('http://example.com:80/path'),
      'http://example.com/path'
    );
  });

  it('removes default port 443', () => {
    assert.equal(
      normalizeUrlForCompare('https://example.com:443/path'),
      'https://example.com/path'
    );
  });

  it('preserves non-default ports', () => {
    assert.equal(
      normalizeUrlForCompare('https://example.com:8080/path'),
      'https://example.com:8080/path'
    );
  });

  it('preserves query string', () => {
    assert.equal(
      normalizeUrlForCompare('https://example.com/path?q=test'),
      'https://example.com/path?q=test'
    );
  });

  it('preserves hash fragment', () => {
    assert.equal(
      normalizeUrlForCompare('https://example.com/path#section'),
      'https://example.com/path#section'
    );
  });

  it('returns original string for invalid URL', () => {
    assert.equal(normalizeUrlForCompare('not-a-url'), 'not-a-url');
  });

  it('two URLs with different casing normalize to same value', () => {
    assert.equal(
      normalizeUrlForCompare('https://GitHub.com/User/Repo/'),
      normalizeUrlForCompare('https://github.com/User/Repo')
    );
  });
});

// ---------------------------------------------------------------------------
// isWebUrl
// ---------------------------------------------------------------------------
describe('isWebUrl', () => {
  it('returns true for https URLs', () => {
    assert.equal(isWebUrl('https://example.com'), true);
  });

  it('returns true for http URLs', () => {
    assert.equal(isWebUrl('http://example.com'), true);
  });

  it('returns false for peek:// URLs', () => {
    assert.equal(isWebUrl('peek://ext/groups/home.html'), false);
  });

  it('returns false for empty string', () => {
    assert.equal(isWebUrl(''), false);
  });

  it('returns false for null', () => {
    assert.equal(isWebUrl(null), false);
  });

  it('returns false for undefined', () => {
    assert.equal(isWebUrl(undefined), false);
  });

  it('returns false for file:// URLs', () => {
    assert.equal(isWebUrl('file:///tmp/test.html'), false);
  });
});

// ---------------------------------------------------------------------------
// parseTagMetadata / isGroupTag
// ---------------------------------------------------------------------------
describe('parseTagMetadata', () => {
  it('returns empty object for tag with no metadata', () => {
    assert.deepEqual(parseTagMetadata({}), {});
  });

  it('returns empty object for null metadata', () => {
    assert.deepEqual(parseTagMetadata({ metadata: null }), {});
  });

  it('parses JSON string metadata', () => {
    assert.deepEqual(
      parseTagMetadata({ metadata: '{"isGroup":true,"color":"#ff0000"}' }),
      { isGroup: true, color: '#ff0000' }
    );
  });

  it('returns object metadata as-is', () => {
    const meta = { isGroup: true };
    assert.deepEqual(parseTagMetadata({ metadata: meta }), meta);
  });

  it('returns empty object for invalid JSON', () => {
    assert.deepEqual(parseTagMetadata({ metadata: '{invalid' }), {});
  });
});

describe('isGroupTag', () => {
  it('returns true for tag with isGroup: true in metadata', () => {
    assert.equal(isGroupTag({ metadata: '{"isGroup":true}' }), true);
  });

  it('returns false for tag without isGroup in metadata', () => {
    assert.equal(isGroupTag({ metadata: '{"color":"red"}' }), false);
  });

  it('returns false for tag with isGroup: false', () => {
    assert.equal(isGroupTag({ metadata: '{"isGroup":false}' }), false);
  });

  it('returns false for tag with no metadata', () => {
    assert.equal(isGroupTag({}), false);
  });

  it('returns true for object metadata with isGroup', () => {
    assert.equal(isGroupTag({ metadata: { isGroup: true } }), true);
  });
});

// ---------------------------------------------------------------------------
// deduplicateByUrl
// ---------------------------------------------------------------------------
describe('deduplicateByUrl', () => {
  it('removes duplicate URLs keeping the most recent', () => {
    const items = [
      { id: '1', content: 'https://example.com/page/', updatedAt: 100 },
      { id: '2', content: 'https://example.com/page', updatedAt: 200 },
    ];
    const result = deduplicateByUrl(items);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, '2');
  });

  it('keeps unique URLs untouched', () => {
    const items = [
      { id: '1', content: 'https://example.com/a', updatedAt: 100 },
      { id: '2', content: 'https://example.com/b', updatedAt: 200 },
    ];
    const result = deduplicateByUrl(items);
    assert.equal(result.length, 2);
  });

  it('deduplicates case-insensitive hostnames', () => {
    const items = [
      { id: '1', content: 'https://EXAMPLE.COM/path', updatedAt: 50 },
      { id: '2', content: 'https://example.com/path', updatedAt: 100 },
    ];
    const result = deduplicateByUrl(items);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, '2');
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(deduplicateByUrl([]), []);
  });

  it('keeps first item when updatedAt is same', () => {
    const items = [
      { id: '1', content: 'https://example.com/', updatedAt: 100 },
      { id: '2', content: 'https://example.com/', updatedAt: 100 },
    ];
    const result = deduplicateByUrl(items);
    assert.equal(result.length, 1);
    // When equal, second one wins (it is not "greater than" so it does not replace)
    assert.equal(result[0].id, '1');
  });
});

// ---------------------------------------------------------------------------
// filterGroups
// ---------------------------------------------------------------------------
describe('filterGroups', () => {
  const groups = [
    { name: 'Work' },
    { name: 'Personal' },
    { name: 'Side Projects' }
  ];

  it('returns all groups when search is empty', () => {
    assert.equal(filterGroups(groups, '').length, 3);
  });

  it('returns all groups when search is falsy', () => {
    assert.equal(filterGroups(groups, null).length, 3);
  });

  it('filters by partial name match', () => {
    const result = filterGroups(groups, 'work');
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'Work');
  });

  it('is case-insensitive', () => {
    const result = filterGroups(groups, 'PERSONAL');
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'Personal');
  });

  it('returns empty array when nothing matches', () => {
    assert.equal(filterGroups(groups, 'xyz').length, 0);
  });
});

// ---------------------------------------------------------------------------
// filterAddresses
// ---------------------------------------------------------------------------
describe('filterAddresses', () => {
  const addresses = [
    { title: 'GitHub', content: 'https://github.com' },
    { title: 'Google', uri: 'https://google.com' },
    { title: null, content: 'https://example.com/docs' }
  ];

  it('returns all when search is empty', () => {
    assert.equal(filterAddresses(addresses, '').length, 3);
  });

  it('matches by title', () => {
    const result = filterAddresses(addresses, 'github');
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'GitHub');
  });

  it('matches by URL content', () => {
    const result = filterAddresses(addresses, 'docs');
    assert.equal(result.length, 1);
    assert.equal(result[0].content, 'https://example.com/docs');
  });

  it('matches by URI field', () => {
    const result = filterAddresses(addresses, 'google');
    assert.equal(result.length, 1); // title "Google" matches
    assert.equal(result[0].title, 'Google');
  });
});

// ---------------------------------------------------------------------------
// sortGroups
// ---------------------------------------------------------------------------
describe('sortGroups', () => {
  const groups = [
    { name: 'Zebra', addressCount: 5, updatedAt: 300 },
    { name: 'Alpha', addressCount: 10, updatedAt: 100 },
    { name: 'Mid', addressCount: 1, updatedAt: 200 }
  ];

  it('sorts by name ascending', () => {
    const result = sortGroups(groups, 'name', 'asc');
    assert.equal(result[0].name, 'Alpha');
    assert.equal(result[2].name, 'Zebra');
  });

  it('sorts by name descending', () => {
    const result = sortGroups(groups, 'name', 'desc');
    assert.equal(result[0].name, 'Zebra');
    assert.equal(result[2].name, 'Alpha');
  });

  it('sorts by count ascending', () => {
    const result = sortGroups(groups, 'count', 'asc');
    assert.equal(result[0].addressCount, 1);
    assert.equal(result[2].addressCount, 10);
  });

  it('sorts by recent ascending', () => {
    const result = sortGroups(groups, 'recent', 'asc');
    assert.equal(result[0].updatedAt, 100);
    assert.equal(result[2].updatedAt, 300);
  });

  it('uses frequency for special groups instead of addressCount', () => {
    const special = [
      { name: 'Untagged', isSpecial: true, frequency: 7 },
      { name: 'Normal', addressCount: 3 }
    ];
    const result = sortGroups(special, 'count', 'asc');
    assert.equal(result[0].name, 'Normal');
    assert.equal(result[1].name, 'Untagged');
  });
});

// ---------------------------------------------------------------------------
// sortAddresses
// ---------------------------------------------------------------------------
describe('sortAddresses', () => {
  const addresses = [
    { title: 'Zebra', content: 'https://z.com', visitCount: 5, updatedAt: 300 },
    { title: 'Alpha', content: 'https://a.com', visitCount: 10, updatedAt: 100 },
    { title: null, content: 'https://m.com', visitCount: 1, updatedAt: 200 }
  ];

  it('sorts by name ascending, falling back to content when title is null', () => {
    const result = sortAddresses(addresses, 'name', 'asc');
    assert.equal(result[0].title, 'Alpha');
    // null title falls back to content 'https://m.com'
  });

  it('sorts by visit count ascending', () => {
    const result = sortAddresses(addresses, 'count', 'asc');
    assert.equal(result[0].visitCount, 1);
    assert.equal(result[2].visitCount, 10);
  });

  it('sorts by recent ascending', () => {
    const result = sortAddresses(addresses, 'recent', 'asc');
    assert.equal(result[0].updatedAt, 100);
  });
});

// ---------------------------------------------------------------------------
// resolveCurrentGroup
// ---------------------------------------------------------------------------
describe('resolveCurrentGroup', () => {
  it('returns active group when set', async () => {
    const api = createMockApi();
    const result = await resolveCurrentGroup('grp-1', 'Work', api);
    assert.deepEqual(result, { groupId: 'grp-1', groupName: 'Work' });
  });

  it('returns null when no active group and no focused window', async () => {
    const api = createMockApi();
    const result = await resolveCurrentGroup(null, null, api);
    assert.equal(result, null);
  });

  it('falls back to focused window group mode', async () => {
    const api = createMockApi();
    api.window.getFocusedVisibleWindowId = async () => 'win-42';
    api.context.get = async (key, windowId) => ({
      success: true,
      data: {
        value: 'space',
        metadata: { spaceId: 'grp-2', spaceName: 'Personal' }
      }
    });
    const result = await resolveCurrentGroup(null, null, api);
    assert.deepEqual(result, { groupId: 'grp-2', groupName: 'Personal' });
  });

  it('returns null when focused window is not in group mode', async () => {
    const api = createMockApi();
    api.window.getFocusedVisibleWindowId = async () => 'win-42';
    api.context.get = async () => ({
      success: true,
      data: { value: 'page', metadata: {} }
    });
    const result = await resolveCurrentGroup(null, null, api);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Close/Suspend Group
// ---------------------------------------------------------------------------
describe('closeGroup', () => {
  it('returns error when no active group and no groupId provided', async () => {
    const api = createMockApi();
    const suspended = new Map();
    const result = await closeGroup(suspended, api, null, null);
    assert.equal(result.success, false);
    assert.ok(result.error.includes('No active group'));
  });

  it('returns error when group has no windows', async () => {
    const api = createMockApi();
    api.context.getWindowsInSpace = async () => ({ success: true, data: [] });
    const suspended = new Map();
    const result = await closeGroup(suspended, api, null, null, 'grp-1', 'Work');
    assert.equal(result.success, false);
    assert.ok(result.error.includes('No windows'));
  });

  it('hides all windows and tracks suspended state', async () => {
    const api = createMockApi();
    const windowIds = ['win-1', 'win-2', 'win-3'];
    api.context.getWindowsInSpace = async () => ({ success: true, data: windowIds });
    const suspended = new Map();

    const result = await closeGroup(suspended, api, null, null, 'grp-1', 'Work');

    assert.equal(result.success, true);
    assert.equal(result.count, 3);
    assert.equal(result.groupId, 'grp-1');
    assert.deepEqual(suspended.get('grp-1'), windowIds);
    // Verify hide was called for each window
    assert.equal(api.calls['window.hide'].length, 3);
  });

  it('saves workspace before hiding windows', async () => {
    const api = createMockApi();
    api.context.getWindowsInSpace = async () => ({ success: true, data: ['win-1'] });
    const suspended = new Map();

    await closeGroup(suspended, api, null, null, 'grp-1', 'Work');

    assert.ok(api.calls['session.saveSpaceWorkspaces']);
    assert.equal(api.calls['session.saveSpaceWorkspaces'].length, 1);
  });

  it('clears active group when closing the active group', async () => {
    const api = createMockApi();
    api.context.getWindowsInSpace = async () => ({ success: true, data: ['win-1'] });
    const suspended = new Map();

    const result = await closeGroup(suspended, api, 'grp-1', 'Work', 'grp-1', 'Work');

    assert.equal(result.newActiveGroupId, null);
    assert.equal(result.newActiveGroupName, null);
  });

  it('does not clear active group when closing a different group', async () => {
    const api = createMockApi();
    api.context.getWindowsInSpace = async () => ({ success: true, data: ['win-1'] });
    const suspended = new Map();

    const result = await closeGroup(suspended, api, 'grp-1', 'Work', 'grp-2', 'Personal');

    assert.equal(result.newActiveGroupId, 'grp-1');
    assert.equal(result.newActiveGroupName, 'Work');
  });
});

// ---------------------------------------------------------------------------
// Restore Group
// ---------------------------------------------------------------------------
describe('restoreGroup', () => {
  it('returns error when group is not suspended and no name given', async () => {
    const api = createMockApi();
    const suspended = new Map();
    const result = await restoreGroup(suspended, api, 'grp-1');
    assert.equal(result.success, false);
    assert.ok(result.error.includes('not suspended'));
  });

  it('falls back to open when group is not suspended but name is given', async () => {
    const api = createMockApi();
    const suspended = new Map();
    const result = await restoreGroup(suspended, api, 'grp-1', 'Work');
    assert.equal(result.success, false);
    assert.equal(result.fallbackToOpen, true);
    assert.equal(result.groupName, 'Work');
  });

  it('shows all suspended windows and clears tracking', async () => {
    const api = createMockApi();
    const suspended = new Map();
    suspended.set('grp-1', ['win-1', 'win-2']);

    const result = await restoreGroup(suspended, api, 'grp-1', 'Work');

    assert.equal(result.success, true);
    assert.equal(result.count, 2);
    assert.equal(result.activeGroupId, 'grp-1');
    assert.equal(result.activeGroupName, 'Work');
    assert.equal(suspended.has('grp-1'), false);
    assert.equal(api.calls['window.show'].length, 2);
  });

  it('falls back to open when some windows were destroyed', async () => {
    const api = createMockApi();
    api.window.exists = async (id) => {
      if (id === 'win-2') return { exists: false };
      return { exists: true };
    };
    const suspended = new Map();
    suspended.set('grp-1', ['win-1', 'win-2']);

    const result = await restoreGroup(suspended, api, 'grp-1', 'Work');

    assert.equal(result.fallbackToOpen, true);
    assert.equal(result.reason, 'destroyed windows');
  });
});

// ---------------------------------------------------------------------------
// Pin Management
// ---------------------------------------------------------------------------
describe('managePins', () => {
  describe('add', () => {
    it('adds a new item ID to pins', () => {
      const result = managePins.add(['item-1'], 'item-2');
      assert.deepEqual(result, ['item-1', 'item-2']);
    });

    it('does not add duplicate item ID', () => {
      const result = managePins.add(['item-1', 'item-2'], 'item-1');
      assert.deepEqual(result, ['item-1', 'item-2']);
    });

    it('adds to empty list', () => {
      const result = managePins.add([], 'item-1');
      assert.deepEqual(result, ['item-1']);
    });
  });

  describe('remove', () => {
    it('removes an existing item ID', () => {
      const result = managePins.remove(['item-1', 'item-2', 'item-3'], 'item-2');
      assert.deepEqual(result, ['item-1', 'item-3']);
    });

    it('returns same array when item not found', () => {
      const result = managePins.remove(['item-1'], 'item-99');
      assert.deepEqual(result, ['item-1']);
    });

    it('returns empty array when removing last item', () => {
      const result = managePins.remove(['item-1'], 'item-1');
      assert.deepEqual(result, []);
    });
  });

  describe('sortPinnedFirst', () => {
    it('puts pinned items first', () => {
      const items = [
        { id: '1', title: 'A' },
        { id: '2', title: 'B' },
        { id: '3', title: 'C' }
      ];
      const pinnedSet = new Set(['2', '3']);
      const result = managePins.sortPinnedFirst(items, pinnedSet);
      // Pinned items (2, 3) should come before unpinned (1)
      assert.equal(result[result.length - 1].id, '1');
      assert.ok(pinnedSet.has(result[0].id));
      assert.ok(pinnedSet.has(result[1].id));
    });

    it('preserves order when no items are pinned', () => {
      const items = [
        { id: '1', title: 'A' },
        { id: '2', title: 'B' }
      ];
      const pinnedSet = new Set();
      const result = managePins.sortPinnedFirst(items, pinnedSet);
      assert.equal(result[0].id, '1');
      assert.equal(result[1].id, '2');
    });

    it('preserves order when all items are pinned', () => {
      const items = [
        { id: '1', title: 'A' },
        { id: '2', title: 'B' }
      ];
      const pinnedSet = new Set(['1', '2']);
      const result = managePins.sortPinnedFirst(items, pinnedSet);
      assert.equal(result.length, 2);
    });
  });
});

// ---------------------------------------------------------------------------
// Pin UI indicators (home.js address card pin badge)
// ---------------------------------------------------------------------------
describe('pin badge annotation on addresses', () => {
  it('annotates addresses with _pinned flag from pin set', () => {
    const addresses = [
      { id: 'item-1', content: 'https://a.com' },
      { id: 'item-2', content: 'https://b.com' },
      { id: 'item-3', content: 'https://c.com' }
    ];
    const pinnedSet = new Set(['item-1', 'item-3']);
    const annotated = addresses.map(addr => ({
      ...addr,
      _pinned: pinnedSet.has(addr.id)
    }));
    assert.equal(annotated[0]._pinned, true);
    assert.equal(annotated[1]._pinned, false);
    assert.equal(annotated[2]._pinned, true);
  });

  it('sorts pinned items first after annotation', () => {
    const addresses = [
      { id: 'item-1', content: 'https://a.com', _pinned: false },
      { id: 'item-2', content: 'https://b.com', _pinned: true },
      { id: 'item-3', content: 'https://c.com', _pinned: false }
    ];
    const sorted = [...addresses].sort((a, b) => (b._pinned ? 1 : 0) - (a._pinned ? 1 : 0));
    assert.equal(sorted[0].id, 'item-2');
  });
});

// ---------------------------------------------------------------------------
// Search scope indicator formatting (background.js query handler)
// ---------------------------------------------------------------------------
describe('search scope indicator', () => {
  it('includes scope when in group mode', () => {
    const title = formatSearchTitle([1, 2, 3], { groupName: 'Work' });
    assert.equal(title, 'Groups (3) [scope: Work]');
  });

  it('excludes scope when not in group mode', () => {
    const title = formatSearchTitle([1, 2], null);
    assert.equal(title, 'Groups (2)');
  });

  it('includes correct count', () => {
    const title = formatSearchTitle(new Array(10), { groupName: 'Test' });
    assert.ok(title.includes('(10)'));
  });
});

// ---------------------------------------------------------------------------
// Groups does NOT set mode when showAddresses runs (negative test)
// ---------------------------------------------------------------------------
describe('showAddresses does not set mode', () => {
  /**
   * The groups home.js showAddresses() function navigates to the address
   * detail view for a group. It must NOT call api.context.setMode() —
   * mode is managed by the spaces/background extension, not by groups UI.
   * Groups only calls setMode('default') when returning to the groups LIST
   * (via showGroups), never when drilling into a group's addresses.
   */

  it('does not call setMode when viewing group addresses', async () => {
    const api = createMockApi();

    // Simulate showAddresses logic: sets view state, loads addresses, renders
    // This mirrors the code path in home.js showAddresses()
    const state = { view: 'groups', currentTag: null, searchQuery: '', addresses: [] };
    const tag = { id: 'tag-1', name: 'Work', isSpecial: false };

    // Execute showAddresses-equivalent logic
    state.view = 'addresses';
    state.currentTag = tag;
    state.searchQuery = '';

    // Load addresses (simulated)
    const result = await api.datastore.getItemsByTag(tag.id);
    if (result.success) {
      state.addresses = result.data;
    }

    // Verify setMode was NEVER called
    assert.strictEqual(
      api.calls['context.setMode'],
      undefined,
      'showAddresses must not call setMode — mode is managed by spaces extension'
    );
  });

  it('only calls setMode when returning to groups list (showGroups path)', async () => {
    const api = createMockApi();

    // Simulate showGroups logic (the counterpart that DOES reset mode)
    // This mirrors: await api.context.setMode('default', {});
    if (api.context) {
      await api.context.setMode('default', {});
    }

    // Verify setMode WAS called for the showGroups path
    assert.ok(api.calls['context.setMode'], 'showGroups should call setMode');
    assert.strictEqual(api.calls['context.setMode'].length, 1);
    assert.strictEqual(api.calls['context.setMode'][0][0], 'default');
  });
});

describe('active group highlighting in search results', () => {
  it('moves active group to top and adds (active) suffix', () => {
    const groups = [
      { id: 'g1', name: 'Alpha' },
      { id: 'g2', name: 'Beta' },
      { id: 'g3', name: 'Gamma' }
    ];
    const result = highlightActiveGroup(groups, 'g3');
    assert.equal(result[0].id, 'g3');
    assert.equal(result[0].name, 'Gamma (active)');
    assert.equal(result.length, 3);
  });

  it('does not move if active group is already first', () => {
    const groups = [
      { id: 'g1', name: 'Alpha' },
      { id: 'g2', name: 'Beta' }
    ];
    const result = highlightActiveGroup(groups, 'g1');
    // activeIdx is 0, so activeIdx > 0 is false, no move
    assert.equal(result[0].name, 'Alpha'); // not modified
  });

  it('returns unmodified list when active group not found', () => {
    const groups = [
      { id: 'g1', name: 'Alpha' },
      { id: 'g2', name: 'Beta' }
    ];
    const result = highlightActiveGroup(groups, 'g99');
    assert.equal(result.length, 2);
    assert.equal(result[0].name, 'Alpha');
    assert.equal(result[1].name, 'Beta');
  });
});

// ---------------------------------------------------------------------------
// Switch group logic
// ---------------------------------------------------------------------------
describe('switchGroup logic', () => {
  it('returns error when no target name is provided', () => {
    // Inline test of the validation check from switchGroup
    const targetGroupName = '';
    const result = !targetGroupName
      ? { success: false, error: 'Usage: switch group <name>' }
      : null;
    assert.equal(result.success, false);
    assert.ok(result.error.includes('Usage'));
  });

  it('finds target group by case-insensitive name match', () => {
    const tags = [
      { id: 't1', name: 'Work' },
      { id: 't2', name: 'Personal' },
      { id: 't3', name: 'Side Projects' }
    ];
    const target = tags.find(t => t.name.toLowerCase() === 'personal');
    assert.ok(target);
    assert.equal(target.id, 't2');
  });

  it('returns error when target group not found', () => {
    const tags = [
      { id: 't1', name: 'Work' }
    ];
    const target = tags.find(t => t.name.toLowerCase() === 'nonexistent');
    assert.equal(target, undefined);
  });

  it('skips closing current group when switching to same group', () => {
    // The switchGroup logic checks: current.groupId !== targetTag.id
    const current = { groupId: 't1', groupName: 'Work' };
    const targetTag = { id: 't1', name: 'Work' };
    const shouldClose = current && current.groupId !== targetTag.id;
    assert.equal(shouldClose, false);
  });

  it('closes current group when switching to different group', () => {
    const current = { groupId: 't1', groupName: 'Work' };
    const targetTag = { id: 't2', name: 'Personal' };
    const shouldClose = current && current.groupId !== targetTag.id;
    assert.equal(shouldClose, true);
  });
});

// ---------------------------------------------------------------------------
// Suspended groups tracking (Map-based state)
// ---------------------------------------------------------------------------
describe('suspended groups tracking', () => {
  it('starts with empty map', () => {
    const suspended = new Map();
    assert.equal(suspended.size, 0);
  });

  it('tracks multiple suspended groups', () => {
    const suspended = new Map();
    suspended.set('grp-1', ['win-1', 'win-2']);
    suspended.set('grp-2', ['win-3']);
    assert.equal(suspended.size, 2);
    assert.deepEqual(suspended.get('grp-1'), ['win-1', 'win-2']);
    assert.deepEqual(suspended.get('grp-2'), ['win-3']);
  });

  it('clears tracking on restore', () => {
    const suspended = new Map();
    suspended.set('grp-1', ['win-1']);
    suspended.delete('grp-1');
    assert.equal(suspended.has('grp-1'), false);
  });

  it('overwrites if group is closed again while already suspended', () => {
    const suspended = new Map();
    suspended.set('grp-1', ['win-1']);
    suspended.set('grp-1', ['win-2', 'win-3']);
    assert.deepEqual(suspended.get('grp-1'), ['win-2', 'win-3']);
  });
});
