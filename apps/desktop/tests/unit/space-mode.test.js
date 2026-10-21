/**
 * Unit tests for the space machine-tag helpers in features/spaces/config.js.
 *
 * Run via: node --test tests/unit/space-mode.test.js
 *
 * A space is stored as a tag named `space:<name>`, so these three helpers are
 * the whole boundary between a space's display name and its tag name.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { isSpaceTag, getSpaceDisplayName, toSpaceTagName } from '../../features/spaces/config.js';

describe('isSpaceTag', () => {
  it('returns true for "space:research"', () => {
    assert.equal(isSpaceTag('space:research'), true);
  });

  it('returns true for "space:work"', () => {
    assert.equal(isSpaceTag('space:work'), true);
  });

  it('returns true for "space:" (empty name edge case)', () => {
    assert.equal(isSpaceTag('space:'), true);
  });

  it('returns false for "research" (no prefix)', () => {
    assert.equal(isSpaceTag('research'), false);
  });

  it('returns false for "spaceship" (not a prefix match)', () => {
    assert.equal(isSpaceTag('spaceship'), false);
  });

  it('returns false for "myspace:foo" (wrong prefix)', () => {
    assert.equal(isSpaceTag('myspace:foo'), false);
  });

  it('returns false for empty string', () => {
    assert.equal(isSpaceTag(''), false);
  });

  it('returns false for null', () => {
    assert.equal(isSpaceTag(null), false);
  });

  it('returns false for undefined', () => {
    assert.equal(isSpaceTag(undefined), false);
  });
});

describe('getSpaceDisplayName', () => {
  it('uses displayName from metadata object', () => {
    assert.equal(getSpaceDisplayName({ name: 'space:work', metadata: { displayName: 'Work' } }), 'Work');
  });

  it('strips prefix when no displayName, name is "space:research"', () => {
    assert.equal(getSpaceDisplayName({ name: 'space:research' }), 'research');
  });

  it('strips prefix when displayName is empty string', () => {
    assert.equal(getSpaceDisplayName({ name: 'space:projects', metadata: { displayName: '' } }), 'projects');
  });

  it('parses metadata from JSON string', () => {
    assert.equal(getSpaceDisplayName({ name: 'space:dev', metadata: '{"displayName":"Development"}' }), 'Development');
  });

  it('handles invalid JSON metadata gracefully', () => {
    assert.equal(getSpaceDisplayName({ name: 'space:broken', metadata: '{invalid' }), 'broken');
  });

  it('returns tag name as-is for non-space tags with no displayName', () => {
    assert.equal(getSpaceDisplayName({ name: 'regular-tag', metadata: {} }), 'regular-tag');
  });

  it('returns tag name when metadata is null', () => {
    assert.equal(getSpaceDisplayName({ name: 'space:test', metadata: null }), 'test');
  });
});

describe('toSpaceTagName', () => {
  it('adds prefix to plain name', () => {
    assert.equal(toSpaceTagName('research'), 'space:research');
  });

  it('is idempotent — does not double-prefix', () => {
    assert.equal(toSpaceTagName('space:research'), 'space:research');
  });

  it('handles names with spaces', () => {
    assert.equal(toSpaceTagName('Work Projects'), 'space:Work Projects');
  });
});
