/**
 * Unit tests for tag input comma-splitting logic.
 *
 * Mirrors the split-on-comma pattern used by addInputAddNewTag,
 * addEditingTextTag, addEditingTagsetTag, addEditingImageTag, etc. in App.tsx.
 * No browser/Playwright needed — pure function tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Mirrors the splitting logic used by every addTag handler in App.tsx:
 *   const parts = input.split(",");
 *   for (const part of parts) {
 *     const trimmed = part.trim().toLowerCase();
 *     if (trimmed) newTags.add(trimmed);
 *   }
 *
 * Returns sorted array for deterministic assertions.
 */
function splitTagInput(input) {
  const tags = new Set();
  const parts = input.split(",");
  for (const part of parts) {
    const trimmed = part.trim().toLowerCase();
    if (trimmed) {
      tags.add(trimmed);
    }
  }
  return Array.from(tags).sort();
}

describe('tag comma-split logic', () => {
  it('"foo," commits "foo" only, no empty tag', () => {
    assert.deepEqual(splitTagInput('foo,'), ['foo']);
  });

  it('"foo,bar" commits both tags', () => {
    assert.deepEqual(splitTagInput('foo,bar'), ['bar', 'foo']);
  });

  it('"foo,," commits "foo" only, no empties from double-comma', () => {
    assert.deepEqual(splitTagInput('foo,,'), ['foo']);
  });

  it('" ," (space + comma) commits nothing — no empty tags', () => {
    assert.deepEqual(splitTagInput(' ,'), []);
  });

  it('"foo bar," splits on comma only (space stays in tag)', () => {
    // Space is NOT a split delimiter in splitTagInput itself —
    // space-as-delimiter is handled at the onKeyDown level, not here.
    // So "foo bar," produces one tag "foo bar".
    assert.deepEqual(splitTagInput('foo bar,'), ['foo bar']);
  });

  it('trims surrounding whitespace from each part', () => {
    assert.deepEqual(splitTagInput('  foo  ,  bar  '), ['bar', 'foo']);
  });

  it('lowercases all tags', () => {
    assert.deepEqual(splitTagInput('Foo,BAR'), ['bar', 'foo']);
  });

  it('single value without comma works normally', () => {
    assert.deepEqual(splitTagInput('hello'), ['hello']);
  });

  it('empty string produces no tags', () => {
    assert.deepEqual(splitTagInput(''), []);
  });

  it('deduplicates identical tags', () => {
    assert.deepEqual(splitTagInput('foo,foo,bar'), ['bar', 'foo']);
  });
});
