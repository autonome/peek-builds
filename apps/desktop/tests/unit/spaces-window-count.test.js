/**
 * Unit tests for the window-count helpers in features/spaces/config.js.
 *
 * Run via: node --test tests/unit/spaces-window-count.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'features', 'spaces', 'config.js');
const { countSpaceWindows, formatWindowCount } = await import(modulePath);

describe('countSpaceWindows', () => {
  it('uses the live window ids when any are open', () => {
    assert.equal(countSpaceWindows([1, 2, 3], [{}, {}]), 3);
  });

  it('falls back to the saved snapshot windows when none are live', () => {
    assert.equal(countSpaceWindows([], [{}, {}]), 2);
    assert.equal(countSpaceWindows(null, [{}]), 1);
  });

  it('returns 0 for a live space with nothing open and a readable empty snapshot', () => {
    assert.equal(countSpaceWindows([], []), 0);
  });

  it('returns null when nothing is live and no snapshot is readable', () => {
    assert.equal(countSpaceWindows([], null), null);
    assert.equal(countSpaceWindows(undefined, undefined), null);
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
