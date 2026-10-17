/**
 * Unit tests for the window-count and initial-selection helpers in
 * features/spaces/config.js.
 *
 * Run via: node --test tests/unit/spaces-window-count.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'features', 'spaces', 'config.js');
const { countSpaceWindows, liveSpaceWindowIds, formatWindowCount, initialSelectedIndex } = await import(modulePath);

describe('countSpaceWindows', () => {
  it('uses the live window ids when any are open', () => {
    assert.equal(countSpaceWindows([1, 2, 3], 2), 3);
  });

  it('falls back to the saved snapshot count when none are live', () => {
    assert.equal(countSpaceWindows([], 2), 2);
    assert.equal(countSpaceWindows(null, 1), 1);
  });

  it('returns 0 for nothing open and an empty snapshot', () => {
    assert.equal(countSpaceWindows([], 0), 0);
  });

  it('returns null for the default space when nothing is live and no snapshot count is readable', () => {
    assert.equal(countSpaceWindows([], null, true), null);
    assert.equal(countSpaceWindows(undefined, undefined, true), null);
  });

  it('returns 0 for another space that has nothing live and no saved snapshot', () => {
    assert.equal(countSpaceWindows([], null), 0);
    assert.equal(countSpaceWindows(undefined, undefined), 0);
  });
});

describe('countSpaceWindows with held windows', () => {
  it('adds windows still held for another desktop to the live ones', () => {
    assert.equal(countSpaceWindows([1, 2, 3], 6, false, 3), 6);
  });

  it('counts held windows when none are live on this desktop', () => {
    assert.equal(countSpaceWindows([], 6, false, 6), 6);
    assert.equal(countSpaceWindows([], null, true, 4), 4);
  });

  it('ignores a missing held count', () => {
    assert.equal(countSpaceWindows([1, 2], 5, false, undefined), 2);
    assert.equal(countSpaceWindows([], 5, false, 0), 5);
  });
});

describe('liveSpaceWindowIds', () => {
  const win = (id, url, extra = {}) => ({ id, url, visible: true, params: { role: 'content' }, ...extra });

  it('keeps visible windows tagged with the space', () => {
    const list = [win(1, 'https://a.test/'), win(2, 'https://b.test/'), win(3, 'https://c.test/')];
    assert.deepEqual(liveSpaceWindowIds([1, 3], list), [1, 3]);
  });

  it('leaves out the spaces home window, the desktop marker and the border', () => {
    const list = [
      win(1, 'https://a.test/'),
      win(2, 'peek://spaces/home.html?spaceId=x'),
      win(3, 'peek://spaces/signal.html'),
      win(4, 'peek://spaces/border.html?color=red'),
    ];
    assert.deepEqual(liveSpaceWindowIds([1, 2, 3, 4], list), [1]);
  });

  it('leaves out hidden windows and ids that are not listed', () => {
    const list = [win(1, 'https://a.test/'), win(2, 'https://b.test/', { visible: false })];
    assert.deepEqual(liveSpaceWindowIds([1, 2, 9], list), [1]);
  });

  it('is empty for missing input', () => {
    assert.deepEqual(liveSpaceWindowIds(null, null), []);
  });
});

describe('formatWindowCount', () => {
  it('pluralises', () => {
    assert.equal(formatWindowCount(0), '0 windows');
    assert.equal(formatWindowCount(1), '1 window');
    assert.equal(formatWindowCount(40), '40 windows');
  });

  it('is empty when the count is unknown', () => {
    assert.equal(formatWindowCount(null), '');
  });
});

describe('initialSelectedIndex', () => {
  it('selects the active space card', () => {
    assert.equal(initialSelectedIndex(['a', 'b', 'c'], 'c'), 2);
  });

  it('falls back to the first card when the active space is unknown or absent', () => {
    assert.equal(initialSelectedIndex(['a', 'b'], null), 0);
    assert.equal(initialSelectedIndex(['a', 'b'], 'zzz'), 0);
    assert.equal(initialSelectedIndex([], 'a'), 0);
  });
});
