/**
 * Unit tests for the pure `copy url` address choice.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickCopyableUrl } from './front-window-url.js';

describe('pickCopyableUrl', () => {
  it('returns a web page address', () => {
    assert.equal(pickCopyableUrl(['https://example.com/a']), 'https://example.com/a');
  });

  it('returns a built-in peek:// address', () => {
    assert.equal(
      pickCopyableUrl(['peek://editor/home.html?tags=todo']),
      'peek://editor/home.html?tags=todo',
    );
  });

  it('skips blank, about:blank, and missing candidates', () => {
    assert.equal(pickCopyableUrl([undefined, null, '', '  ', 'about:blank', 'peek://x/y']), 'peek://x/y');
  });

  it('prefers the earlier candidate', () => {
    assert.equal(pickCopyableUrl(['peek://a/', 'https://b/']), 'peek://a/');
  });

  it('returns null when nothing is copyable', () => {
    assert.equal(pickCopyableUrl(['about:blank', undefined]), null);
    assert.equal(pickCopyableUrl([]), null);
  });
});
