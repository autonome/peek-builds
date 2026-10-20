/**
 * Unit tests for the groups feature's decisions.
 *
 * Everything under test is imported from `features/groups/group-logic.js`, the
 * DOM-free half of the groups feature. `features/groups/home.js` holds the
 * other half (rendering, and the module state these functions are handed) and
 * reads `window.app` at import time, so it cannot be loaded here.
 *
 * Run via: NODE_ENV=test node --test tests/unit/groups-quick-wins.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  normalizeUrlForCompare,
  isWebUrl,
  parseTagMetadata,
  isGroupTag,
  deduplicateByUrl,
  filterGroups,
  filterAddresses,
  sortGroups,
  sortAddresses,
  annotatePinnedFirst,
  addPinnedId,
  removePinnedId,
  resolveCurrentGroup,
  closeGroup,
  restoreGroup,
  switchGroup,
  highlightActiveGroup,
  formatGroupsTitle,
} from '../../features/groups/group-logic.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * A tile API with the surface group-logic.js touches. Every call is recorded
 * under `calls` so ordering can be asserted; individual methods are replaced
 * in place by the tests that need a different answer.
 */
const createMockApi = () => {
  const calls = {};
  const record = (name, ...args) => {
    if (!calls[name]) calls[name] = [];
    calls[name].push(args);
    return undefined;
  };

  return {
    calls,
    context: {
      get: async (key, windowId) => {
        record('context.get', key, windowId);
        return { success: false };
      },
      getWindowsInSpace: async (spaceId) => {
        record('context.getWindowsInSpace', spaceId);
        return { success: true, data: [] };
      },
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
    },
    datastore: {
      getTagsByFrecency: async () => {
        record('datastore.getTagsByFrecency');
        return { success: true, data: [] };
      },
    },
    session: {
      saveWorkspaceSnapshot: async (key) => record('session.saveWorkspaceSnapshot', key),
    },
  };
};

/**
 * The bundle `closeGroup`/`restoreGroup`/`switchGroup` take in place of the
 * module state they close over in home.js. `openGroup` is a stub whose
 * arguments are recorded, because the real one opens windows.
 */
const createDeps = (api, { activeGroupId = null, activeGroupName = null } = {}) => {
  const openGroupCalls = [];
  return {
    api,
    groupState: { activeGroupId, activeGroupName },
    suspendedGroups: new Map(),
    openGroupCalls,
    openGroup: async (groupName) => {
      openGroupCalls.push(groupName);
      return { success: true, count: 7, openedBy: 'openGroup' };
    },
  };
};

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------

describe('normalizeUrlForCompare', () => {
  it('lowercases the hostname', () => {
    assert.equal(
      normalizeUrlForCompare('https://Example.COM/path'),
      'https://example.com/path'
    );
  });

  it('removes a trailing slash from a non-root path', () => {
    assert.equal(
      normalizeUrlForCompare('https://example.com/path/'),
      'https://example.com/path'
    );
  });

  it('keeps the trailing slash for the root path', () => {
    assert.equal(normalizeUrlForCompare('https://example.com/'), 'https://example.com/');
  });

  it('removes the default port 80', () => {
    assert.equal(normalizeUrlForCompare('http://example.com:80/x'), 'http://example.com/x');
  });

  it('removes the default port 443', () => {
    assert.equal(normalizeUrlForCompare('https://example.com:443/x'), 'https://example.com/x');
  });

  it('preserves a non-default port', () => {
    assert.equal(
      normalizeUrlForCompare('https://example.com:8080/x'),
      'https://example.com:8080/x'
    );
  });

  it('preserves the query string', () => {
    assert.equal(
      normalizeUrlForCompare('https://example.com/s?q=1&r=2'),
      'https://example.com/s?q=1&r=2'
    );
  });

  it('preserves the hash fragment', () => {
    assert.equal(
      normalizeUrlForCompare('https://example.com/doc#section'),
      'https://example.com/doc#section'
    );
  });

  it('returns the original string for an unparseable URL', () => {
    assert.equal(normalizeUrlForCompare('not a url'), 'not a url');
  });

  it('maps two URLs differing only in casing to the same value', () => {
    assert.equal(
      normalizeUrlForCompare('https://EXAMPLE.com/a'),
      normalizeUrlForCompare('https://example.com/a')
    );
  });
});

describe('isWebUrl', () => {
  it('accepts https', () => {
    assert.equal(isWebUrl('https://example.com'), true);
  });

  it('accepts http', () => {
    assert.equal(isWebUrl('http://example.com'), true);
  });

  it('rejects peek:// internal URLs', () => {
    assert.equal(isWebUrl('peek://app/background.html'), false);
  });

  it('rejects the empty string', () => {
    assert.equal(isWebUrl(''), false);
  });

  it('rejects null', () => {
    assert.equal(isWebUrl(null), false);
  });

  it('rejects undefined', () => {
    assert.equal(isWebUrl(undefined), false);
  });

  it('rejects file://', () => {
    assert.equal(isWebUrl('file:///etc/hosts'), false);
  });
});

describe('deduplicateByUrl', () => {
  it('drops a duplicate URL, keeping the most recently updated item', () => {
    const items = [
      { id: '1', content: 'https://example.com/a', updatedAt: 100 },
      { id: '2', content: 'https://example.com/a/', updatedAt: 200 },
    ];
    const result = deduplicateByUrl(items);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, '2');
  });

  it('keeps items with distinct URLs', () => {
    const items = [
      { id: '1', content: 'https://example.com/a' },
      { id: '2', content: 'https://example.com/b' },
    ];
    assert.equal(deduplicateByUrl(items).length, 2);
  });

  it('treats hostnames case-insensitively', () => {
    const items = [
      { id: '1', content: 'https://Example.com/a', updatedAt: 1 },
      { id: '2', content: 'https://example.com/a', updatedAt: 2 },
    ];
    assert.equal(deduplicateByUrl(items).length, 1);
  });

  it('returns an empty list for an empty input', () => {
    assert.deepEqual(deduplicateByUrl([]), []);
  });

  it('keeps the first item when updatedAt ties', () => {
    const items = [
      { id: '1', content: 'https://example.com/a', updatedAt: 500 },
      { id: '2', content: 'https://example.com/a', updatedAt: 500 },
    ];
    const result = deduplicateByUrl(items);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, '1');
  });
});

// ---------------------------------------------------------------------------
// Tag metadata
// ---------------------------------------------------------------------------

describe('parseTagMetadata', () => {
  it('returns an empty object when there is no metadata', () => {
    assert.deepEqual(parseTagMetadata({ id: 't1' }), {});
  });

  it('returns an empty object for null metadata', () => {
    assert.deepEqual(parseTagMetadata({ id: 't1', metadata: null }), {});
  });

  it('parses a JSON string', () => {
    assert.deepEqual(
      parseTagMetadata({ metadata: '{"isGroup":true,"color":"red"}' }),
      { isGroup: true, color: 'red' }
    );
  });

  it('returns an object as-is', () => {
    const metadata = { isGroup: true };
    assert.equal(parseTagMetadata({ metadata }), metadata);
  });

  it('returns an empty object for invalid JSON', () => {
    assert.deepEqual(parseTagMetadata({ metadata: '{not json' }), {});
  });
});

describe('isGroupTag', () => {
  it('is true when metadata says isGroup', () => {
    assert.equal(isGroupTag({ metadata: '{"isGroup":true}' }), true);
  });

  it('is false when metadata omits isGroup', () => {
    assert.equal(isGroupTag({ metadata: '{"color":"red"}' }), false);
  });

  it('is false when isGroup is false', () => {
    assert.equal(isGroupTag({ metadata: '{"isGroup":false}' }), false);
  });

  it('is false when there is no metadata', () => {
    assert.equal(isGroupTag({ id: 't1' }), false);
  });

  it('is true for object metadata saying isGroup', () => {
    assert.equal(isGroupTag({ metadata: { isGroup: true } }), true);
  });
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe('filterGroups', () => {
  const groups = [
    { id: '1', name: 'Work' },
    { id: '2', name: 'Personal' },
    { id: '3', name: 'Workshop' },
  ];

  it('returns every group when the search is empty', () => {
    assert.equal(filterGroups(groups, '').length, 3);
  });

  it('returns every group when the search is absent', () => {
    assert.equal(filterGroups(groups, null).length, 3);
  });

  it('matches on a partial name', () => {
    assert.deepEqual(filterGroups(groups, 'work').map(g => g.id), ['1', '3']);
  });

  it('matches case-insensitively', () => {
    assert.deepEqual(filterGroups(groups, 'PERSONAL').map(g => g.id), ['2']);
  });

  it('returns nothing when nothing matches', () => {
    assert.deepEqual(filterGroups(groups, 'zzz'), []);
  });
});

describe('filterAddresses', () => {
  const addresses = [
    { id: '1', title: 'GitHub', content: 'https://github.com' },
    { id: '2', title: 'Docs', uri: 'https://developer.mozilla.org' },
    { id: '3', title: null, content: 'https://example.com/github-mirror' },
  ];

  it('returns every address when the search is empty', () => {
    assert.equal(filterAddresses(addresses, '').length, 3);
  });

  it('matches on the title', () => {
    assert.deepEqual(filterAddresses(addresses, 'docs').map(a => a.id), ['2']);
  });

  it('matches on the content URL', () => {
    assert.deepEqual(filterAddresses(addresses, 'github').map(a => a.id), ['1', '3']);
  });

  it('matches on the uri field', () => {
    assert.deepEqual(filterAddresses(addresses, 'mozilla').map(a => a.id), ['2']);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe('sortGroups', () => {
  it('sorts by name ascending', () => {
    const groups = [{ name: 'Charlie' }, { name: 'alpha' }, { name: 'Bravo' }];
    assert.deepEqual(
      sortGroups(groups, 'name', 'asc').map(g => g.name),
      ['alpha', 'Bravo', 'Charlie']
    );
  });

  it('sorts by name descending', () => {
    const groups = [{ name: 'alpha' }, { name: 'Charlie' }, { name: 'Bravo' }];
    assert.deepEqual(
      sortGroups(groups, 'name', 'desc').map(g => g.name),
      ['Charlie', 'Bravo', 'alpha']
    );
  });

  it('sorts by address count ascending', () => {
    const groups = [
      { name: 'a', addressCount: 5 },
      { name: 'b', addressCount: 1 },
      { name: 'c', addressCount: 3 },
    ];
    assert.deepEqual(
      sortGroups(groups, 'count', 'asc').map(g => g.name),
      ['b', 'c', 'a']
    );
  });

  it('sorts by recency ascending, falling back to createdAt', () => {
    const groups = [
      { name: 'a', updatedAt: 300 },
      { name: 'b', createdAt: 100 },
      { name: 'c', updatedAt: 200 },
    ];
    assert.deepEqual(
      sortGroups(groups, 'recent', 'asc').map(g => g.name),
      ['b', 'c', 'a']
    );
  });

  it('counts a special group by its frequency rather than its address count', () => {
    const groups = [
      { name: 'untagged', isSpecial: true, frequency: 9, addressCount: 0 },
      { name: 'normal', addressCount: 4 },
    ];
    assert.deepEqual(
      sortGroups(groups, 'count', 'asc').map(g => g.name),
      ['normal', 'untagged']
    );
  });

  it('leaves the default order alone for an unknown sort key', () => {
    const groups = [{ name: 'b' }, { name: 'a' }];
    assert.deepEqual(sortGroups(groups, 'nonsense', 'asc').map(g => g.name), ['b', 'a']);
  });

  it('sorts the given array in place and returns it', () => {
    const groups = [{ name: 'b' }, { name: 'a' }];
    const result = sortGroups(groups, 'name', 'asc');
    assert.equal(result, groups);
    assert.deepEqual(groups.map(g => g.name), ['a', 'b']);
  });
});

describe('sortAddresses', () => {
  it('sorts by name ascending, falling back from title to uri to content', () => {
    const addresses = [
      { title: 'Zebra' },
      { title: null, uri: 'https://apple.com' },
      { title: null, content: 'https://middle.com' },
    ];
    assert.deepEqual(
      sortAddresses(addresses, 'name', 'asc').map(a => a.title || a.uri || a.content),
      ['https://apple.com', 'https://middle.com', 'Zebra']
    );
  });

  it('sorts by visit count ascending', () => {
    const addresses = [
      { title: 'a', visitCount: 10 },
      { title: 'b', visitCount: 2 },
      { title: 'c' },
    ];
    assert.deepEqual(
      sortAddresses(addresses, 'count', 'asc').map(a => a.title),
      ['c', 'b', 'a']
    );
  });

  it('sorts by recency ascending, falling back to createdAt', () => {
    const addresses = [
      { title: 'a', updatedAt: 300 },
      { title: 'b', createdAt: 50 },
      { title: 'c', updatedAt: 150 },
    ];
    assert.deepEqual(
      sortAddresses(addresses, 'recent', 'asc').map(a => a.title),
      ['b', 'c', 'a']
    );
  });

  it('sorts the given array in place and returns it', () => {
    const addresses = [{ title: 'b' }, { title: 'a' }];
    const result = sortAddresses(addresses, 'name', 'asc');
    assert.equal(result, addresses);
    assert.deepEqual(addresses.map(a => a.title), ['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

describe('addPinnedId', () => {
  it('appends a new id and reports the change', () => {
    const pins = ['a'];
    assert.equal(addPinnedId(pins, 'b'), true);
    assert.deepEqual(pins, ['a', 'b']);
  });

  it('leaves an already-pinned id alone and reports no change', () => {
    const pins = ['a', 'b'];
    assert.equal(addPinnedId(pins, 'a'), false);
    assert.deepEqual(pins, ['a', 'b']);
  });

  it('appends to an empty list', () => {
    const pins = [];
    assert.equal(addPinnedId(pins, 'a'), true);
    assert.deepEqual(pins, ['a']);
  });
});

describe('removePinnedId', () => {
  it('removes an existing id and reports the change', () => {
    const pins = ['a', 'b', 'c'];
    assert.equal(removePinnedId(pins, 'b'), true);
    assert.deepEqual(pins, ['a', 'c']);
  });

  it('leaves the list alone for an id that is not pinned', () => {
    const pins = ['a', 'b'];
    assert.equal(removePinnedId(pins, 'z'), false);
    assert.deepEqual(pins, ['a', 'b']);
  });

  it('empties the list when the last id goes', () => {
    const pins = ['a'];
    assert.equal(removePinnedId(pins, 'a'), true);
    assert.deepEqual(pins, []);
  });
});

describe('annotatePinnedFirst', () => {
  it('marks each address with whether it is pinned', () => {
    const addresses = [{ id: '1' }, { id: '2' }, { id: '3' }];
    const result = annotatePinnedFirst(addresses, ['2']);
    assert.deepEqual(
      result.map(a => [a.id, a._pinned]),
      [['2', true], ['1', false], ['3', false]]
    );
  });

  it('moves pinned addresses to the front', () => {
    const addresses = [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }];
    const result = annotatePinnedFirst(addresses, ['3', '4']);
    assert.deepEqual(result.map(a => a.id), ['3', '4', '1', '2']);
  });

  it('preserves the original order when nothing is pinned', () => {
    const addresses = [{ id: '1' }, { id: '2' }, { id: '3' }];
    const result = annotatePinnedFirst(addresses, []);
    assert.deepEqual(result.map(a => a.id), ['1', '2', '3']);
    assert.deepEqual(result.map(a => a._pinned), [false, false, false]);
  });

  it('preserves the original order when everything is pinned', () => {
    const addresses = [{ id: '1' }, { id: '2' }, { id: '3' }];
    const result = annotatePinnedFirst(addresses, ['1', '2', '3']);
    assert.deepEqual(result.map(a => a.id), ['1', '2', '3']);
    assert.deepEqual(result.map(a => a._pinned), [true, true, true]);
  });

  it('leaves the given addresses untouched', () => {
    const addresses = [{ id: '1' }, { id: '2' }];
    const result = annotatePinnedFirst(addresses, ['2']);
    assert.deepEqual(addresses.map(a => a.id), ['1', '2']);
    assert.equal('_pinned' in addresses[0], false);
    assert.notEqual(result[0], addresses[0]);
  });
});

// ---------------------------------------------------------------------------
// Active group
// ---------------------------------------------------------------------------

describe('resolveCurrentGroup', () => {
  it('returns the active group when one is set, without asking the window layer', async () => {
    const api = createMockApi();
    const current = await resolveCurrentGroup(api, 'g1', 'Work');
    assert.deepEqual(current, { groupId: 'g1', groupName: 'Work' });
    assert.equal(api.calls['window.getFocusedVisibleWindowId'], undefined);
  });

  it('returns null with no active group and no focused window', async () => {
    const api = createMockApi();
    assert.equal(await resolveCurrentGroup(api, null, null), null);
  });

  it('falls back to the focused window when it is in group mode', async () => {
    const api = createMockApi();
    api.window.getFocusedVisibleWindowId = async () => 42;
    api.context.get = async () => ({
      success: true,
      data: { value: 'group', metadata: { groupId: 'g7', groupName: 'Research' } },
    });
    assert.deepEqual(await resolveCurrentGroup(api, null, null), {
      groupId: 'g7',
      groupName: 'Research',
    });
  });

  it('reports an empty name when the focused window records none', async () => {
    const api = createMockApi();
    api.window.getFocusedVisibleWindowId = async () => 42;
    api.context.get = async () => ({
      success: true,
      data: { value: 'group', metadata: { groupId: 'g7' } },
    });
    assert.deepEqual(await resolveCurrentGroup(api, null, null), {
      groupId: 'g7',
      groupName: '',
    });
  });

  it('returns null when the focused window is not in group mode', async () => {
    const api = createMockApi();
    api.window.getFocusedVisibleWindowId = async () => 42;
    api.context.get = async () => ({
      success: true,
      data: { value: 'page', metadata: {} },
    });
    assert.equal(await resolveCurrentGroup(api, null, null), null);
  });

  it('returns null when the window layer throws', async () => {
    const api = createMockApi();
    api.window.getFocusedVisibleWindowId = async () => { throw new Error('no window layer'); };
    assert.equal(await resolveCurrentGroup(api, null, null), null);
  });
});

describe('closeGroup', () => {
  it('fails when there is no active group and no group was named', async () => {
    const api = createMockApi();
    const result = await closeGroup(createDeps(api));
    assert.equal(result.success, false);
    assert.equal(result.error, 'No active group to close');
  });

  it('fails when the group holds no windows', async () => {
    const api = createMockApi();
    const result = await closeGroup(createDeps(api), 'g1', 'Work');
    assert.equal(result.success, false);
    assert.equal(result.error, 'No windows found in group');
  });

  it('hides every window and records them as suspended', async () => {
    const api = createMockApi();
    api.context.getWindowsInSpace = async () => ({ success: true, data: [1, 2, 3] });
    const deps = createDeps(api);
    const result = await closeGroup(deps, 'g1', 'Work');
    assert.deepEqual(result, { success: true, count: 3, groupId: 'g1', groupName: 'Work' });
    assert.deepEqual(api.calls['window.hide'], [[1], [2], [3]]);
    assert.deepEqual(deps.suspendedGroups.get('g1'), [1, 2, 3]);
  });

  it('saves the workspace snapshot before hiding anything', async () => {
    const api = createMockApi();
    api.context.getWindowsInSpace = async () => ({ success: true, data: [1] });
    const order = [];
    api.session.saveWorkspaceSnapshot = async () => { order.push('snapshot'); };
    api.window.hide = async () => { order.push('hide'); };
    await closeGroup(createDeps(api), 'g1', 'Work');
    assert.deepEqual(order, ['snapshot', 'hide']);
  });

  it('closes anyway when saving the snapshot fails', async () => {
    const api = createMockApi();
    api.context.getWindowsInSpace = async () => ({ success: true, data: [1] });
    api.session.saveWorkspaceSnapshot = async () => { throw new Error('no snapshot store'); };
    const result = await closeGroup(createDeps(api), 'g1', 'Work');
    assert.equal(result.success, true);
    assert.equal(result.count, 1);
  });

  it('skips a window that refuses to hide and keeps going', async () => {
    const api = createMockApi();
    api.context.getWindowsInSpace = async () => ({ success: true, data: [1, 2, 3] });
    api.window.hide = async (id) => { if (id === 2) throw new Error('gone'); };
    const deps = createDeps(api);
    const result = await closeGroup(deps, 'g1', 'Work');
    assert.equal(result.count, 2);
    assert.deepEqual(deps.suspendedGroups.get('g1'), [1, 3]);
  });

  it('forgets the active group when that is the one being closed', async () => {
    const api = createMockApi();
    api.context.getWindowsInSpace = async () => ({ success: true, data: [1] });
    const deps = createDeps(api, { activeGroupId: 'g1', activeGroupName: 'Work' });
    await closeGroup(deps, 'g1', 'Work');
    assert.equal(deps.groupState.activeGroupId, null);
    assert.equal(deps.groupState.activeGroupName, null);
  });

  it('keeps the active group when a different one is closed', async () => {
    const api = createMockApi();
    api.context.getWindowsInSpace = async () => ({ success: true, data: [1] });
    const deps = createDeps(api, { activeGroupId: 'g1', activeGroupName: 'Work' });
    await closeGroup(deps, 'g2', 'Other');
    assert.equal(deps.groupState.activeGroupId, 'g1');
    assert.equal(deps.groupState.activeGroupName, 'Work');
  });

  it('closes the active group when none is named', async () => {
    const api = createMockApi();
    api.context.getWindowsInSpace = async () => ({ success: true, data: [1, 2] });
    const deps = createDeps(api, { activeGroupId: 'g1', activeGroupName: 'Work' });
    const result = await closeGroup(deps);
    assert.deepEqual(result, { success: true, count: 2, groupId: 'g1', groupName: 'Work' });
  });
});

describe('restoreGroup', () => {
  it('fails when the group is not suspended and no name was given', async () => {
    const api = createMockApi();
    const result = await restoreGroup(createDeps(api), 'g1');
    assert.equal(result.success, false);
    assert.equal(result.error, 'Group not suspended and no name to open');
  });

  it('opens the group afresh when it is not suspended but was named', async () => {
    const api = createMockApi();
    const deps = createDeps(api);
    const result = await restoreGroup(deps, 'g1', 'Work');
    assert.deepEqual(deps.openGroupCalls, ['Work']);
    assert.equal(result.openedBy, 'openGroup');
  });

  it('shows every suspended window, clears the tracking and marks the group active', async () => {
    const api = createMockApi();
    const deps = createDeps(api);
    deps.suspendedGroups.set('g1', [1, 2]);
    const result = await restoreGroup(deps, 'g1', 'Work');
    assert.deepEqual(result, { success: true, count: 2 });
    assert.deepEqual(api.calls['window.show'], [[1], [2]]);
    assert.equal(deps.suspendedGroups.has('g1'), false);
    assert.equal(deps.groupState.activeGroupId, 'g1');
    assert.equal(deps.groupState.activeGroupName, 'Work');
  });

  it('opens the group afresh when a suspended window was destroyed', async () => {
    const api = createMockApi();
    api.window.exists = async (id) => ({ exists: id !== 2 });
    const deps = createDeps(api);
    deps.suspendedGroups.set('g1', [1, 2]);
    const result = await restoreGroup(deps, 'g1', 'Work');
    assert.deepEqual(deps.openGroupCalls, ['Work']);
    assert.equal(result.openedBy, 'openGroup');
    assert.equal(deps.suspendedGroups.has('g1'), false);
  });

  it('treats a window that throws on show as destroyed', async () => {
    const api = createMockApi();
    api.window.show = async (id) => { if (id === 2) throw new Error('gone'); };
    const deps = createDeps(api);
    deps.suspendedGroups.set('g1', [1, 2]);
    const result = await restoreGroup(deps, 'g1', 'Work');
    assert.deepEqual(deps.openGroupCalls, ['Work']);
    assert.equal(result.openedBy, 'openGroup');
  });

  it('succeeds on a partial restore when there is no name to re-open with', async () => {
    const api = createMockApi();
    api.window.exists = async (id) => ({ exists: id !== 2 });
    const deps = createDeps(api);
    deps.suspendedGroups.set('g1', [1, 2]);
    const result = await restoreGroup(deps, 'g1');
    assert.deepEqual(result, { success: true, count: 1 });
    assert.deepEqual(deps.openGroupCalls, []);
    assert.equal(deps.groupState.activeGroupId, 'g1');
  });
});

describe('switchGroup', () => {
  const tagApi = (tags) => {
    const api = createMockApi();
    api.datastore.getTagsByFrecency = async () => ({ success: true, data: tags });
    return api;
  };

  it('fails when no target name was given', async () => {
    const result = await switchGroup(createDeps(createMockApi()), '');
    assert.equal(result.success, false);
    assert.equal(result.error, 'Usage: switch group <name>');
  });

  it('fails when the tag list cannot be read', async () => {
    const api = createMockApi();
    api.datastore.getTagsByFrecency = async () => ({ success: false });
    const result = await switchGroup(createDeps(api), 'Work');
    assert.equal(result.success, false);
    assert.equal(result.error, 'Failed to get tags');
  });

  it('matches the target group name case-insensitively', async () => {
    const api = tagApi([{ id: 'g2', name: 'Research' }]);
    const deps = createDeps(api);
    await switchGroup(deps, 'rESEARCH');
    assert.deepEqual(deps.openGroupCalls, ['Research']);
  });

  it('fails when the target group does not exist', async () => {
    const api = tagApi([{ id: 'g1', name: 'Work' }]);
    const result = await switchGroup(createDeps(api), 'Missing');
    assert.equal(result.success, false);
    assert.equal(result.error, 'Group "Missing" not found');
  });

  it('closes the current group before restoring a different one', async () => {
    const api = tagApi([{ id: 'g2', name: 'Research' }]);
    const suspendedSpaceIds = [];
    api.context.getWindowsInSpace = async (spaceId) => {
      suspendedSpaceIds.push(spaceId);
      return { success: true, data: [1] };
    };
    const deps = createDeps(api, { activeGroupId: 'g1', activeGroupName: 'Work' });
    await switchGroup(deps, 'Research');
    assert.deepEqual(api.calls['window.hide'], [[1]]);
    assert.deepEqual(suspendedSpaceIds, ['g1']);
  });

  it('does not close anything when switching to the group already active', async () => {
    const api = tagApi([{ id: 'g1', name: 'Work' }]);
    const deps = createDeps(api, { activeGroupId: 'g1', activeGroupName: 'Work' });
    await switchGroup(deps, 'Work');
    assert.equal(api.calls['window.hide'], undefined);
  });

  it('restores the target group it switched to', async () => {
    const api = tagApi([{ id: 'g2', name: 'Research' }]);
    const deps = createDeps(api);
    deps.suspendedGroups.set('g2', [5, 6]);
    const result = await switchGroup(deps, 'Research');
    assert.deepEqual(result, { success: true, count: 2 });
    assert.deepEqual(api.calls['window.show'], [[5], [6]]);
    assert.equal(deps.groupState.activeGroupId, 'g2');
  });
});

// ---------------------------------------------------------------------------
// Command-palette listing
// ---------------------------------------------------------------------------

describe('highlightActiveGroup', () => {
  it('moves the active group to the top and marks it', () => {
    const groups = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Bravo' }];
    const result = highlightActiveGroup(groups, { groupId: 'b', groupName: 'Bravo' });
    assert.deepEqual(result.map(g => g.name), ['Bravo (active)', 'Alpha']);
    assert.equal(result, groups);
  });

  it('leaves an already-first active group unmarked', () => {
    const groups = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Bravo' }];
    highlightActiveGroup(groups, { groupId: 'a', groupName: 'Alpha' });
    assert.deepEqual(groups.map(g => g.name), ['Alpha', 'Bravo']);
  });

  it('leaves the list alone when the active group is not in it', () => {
    const groups = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Bravo' }];
    highlightActiveGroup(groups, { groupId: 'zz', groupName: 'Gone' });
    assert.deepEqual(groups.map(g => g.name), ['Alpha', 'Bravo']);
  });

  it('leaves the list alone when there is no active group', () => {
    const groups = [{ id: 'a', name: 'Alpha' }];
    highlightActiveGroup(groups, null);
    assert.deepEqual(groups.map(g => g.name), ['Alpha']);
  });
});

describe('formatGroupsTitle', () => {
  it('names the current group as the scope', () => {
    assert.equal(
      formatGroupsTitle(3, { groupId: 'g1', groupName: 'Work' }),
      'Groups (3) [scope: Work]'
    );
  });

  it('omits the scope when no group is current', () => {
    assert.equal(formatGroupsTitle(5, null), 'Groups (5)');
  });

  it('reports the count it was given', () => {
    assert.equal(formatGroupsTitle(0, null), 'Groups (0)');
    assert.equal(formatGroupsTitle(12, null), 'Groups (12)');
  });
});
