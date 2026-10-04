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
const { countSpaceWindows, formatWindowCount, initialSelectedIndex } = await import(modulePath);

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
