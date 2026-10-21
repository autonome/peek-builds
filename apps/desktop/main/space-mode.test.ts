/**
 * Unit tests for the mode a window gets from its URL.
 *
 * A window's `mode` context entry is written once, when the window opens: it is
 * inherited from the opener when the opener is in a space or a group, and
 * otherwise comes from `detectModeFromUrl` (see `ipc.ts`). Nothing rewrites it
 * afterwards, so a space window keeps its mode through every navigation.
 *
 * The space machine-tag helpers are covered by `tests/unit/space-mode.test.js`,
 * and border colour and visibility by `tests/unit/spaces-config.test.js`.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { detectModeFromUrl } from './datastore.js';

describe('detectModeFromUrl', () => {
  it('detects "page" for http URLs', () => {
    assert.strictEqual(detectModeFromUrl('http://example.com'), 'page');
  });

  it('detects "page" for https URLs', () => {
    assert.strictEqual(detectModeFromUrl('https://example.com'), 'page');
  });

  it('detects "default" for peek:// URLs', () => {
    assert.strictEqual(detectModeFromUrl('peek://spaces/home.html'), 'default');
  });

  it('detects "default" for empty string', () => {
    assert.strictEqual(detectModeFromUrl(''), 'default');
  });
});
