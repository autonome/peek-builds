import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePeekTileUrl,
  entryDeclaresSeeThrough,
  urlSupportsSeeThrough,
  type SeeThroughManifestLike,
} from './see-through-support.js';

const tagsManifest: SeeThroughManifestLike = {
  tiles: [
    { url: 'background.html' },
    { url: 'home.html', seeThrough: true },
  ],
};

describe('see-through-support — parsePeekTileUrl', () => {
  it('splits a peek:// tile url into tile id and entry path', () => {
    assert.deepStrictEqual(parsePeekTileUrl('peek://tags/home.html'), {
      tileId: 'tags',
      path: 'home.html',
    });
  });

  it('splits the legacy peek://ext/<tile>/<path> spelling', () => {
    assert.deepStrictEqual(parsePeekTileUrl('peek://ext/tags/home.html'), {
      tileId: 'tags',
      path: 'home.html',
    });
  });

  it('keeps a nested entry path intact', () => {
    assert.deepStrictEqual(parsePeekTileUrl('peek://sheets/views/grid.html'), {
      tileId: 'sheets',
      path: 'views/grid.html',
    });
  });

  it('returns null for a web page, which is the unsupported-view case', () => {
    assert.strictEqual(parsePeekTileUrl('https://example.com/'), null);
    assert.strictEqual(parsePeekTileUrl('about:blank'), null);
    assert.strictEqual(parsePeekTileUrl(''), null);
    assert.strictEqual(parsePeekTileUrl('not a url'), null);
  });

  it('returns null for peek://ext with no entry path', () => {
    assert.strictEqual(parsePeekTileUrl('peek://ext/tags'), null);
  });
});

describe('see-through-support — entryDeclaresSeeThrough', () => {
  it('is true only for the entry that declares it', () => {
    assert.strictEqual(entryDeclaresSeeThrough(tagsManifest, 'home.html'), true);
    assert.strictEqual(entryDeclaresSeeThrough(tagsManifest, 'background.html'), false);
  });

  it('does not match an entry the manifest does not have', () => {
    assert.strictEqual(entryDeclaresSeeThrough(tagsManifest, 'other.html'), false);
  });

  it('treats a missing or empty manifest as no support', () => {
    assert.strictEqual(entryDeclaresSeeThrough(null, 'home.html'), false);
    assert.strictEqual(entryDeclaresSeeThrough(undefined, 'home.html'), false);
    assert.strictEqual(entryDeclaresSeeThrough({}, 'home.html'), false);
    assert.strictEqual(entryDeclaresSeeThrough({ tiles: [] }, 'home.html'), false);
  });

  it('requires the literal true, not a truthy value', () => {
    const odd = { tiles: [{ url: 'home.html', seeThrough: 1 as unknown as boolean }] };
    assert.strictEqual(entryDeclaresSeeThrough(odd, 'home.html'), false);
  });
});

describe('see-through-support — urlSupportsSeeThrough', () => {
  const lookup = (tileId: string) => (tileId === 'tags' ? tagsManifest : null);

  it('is true for a declared card view', () => {
    assert.strictEqual(urlSupportsSeeThrough('peek://tags/home.html', lookup), true);
  });

  it('is false for another window of the same feature', () => {
    assert.strictEqual(urlSupportsSeeThrough('peek://tags/background.html', lookup), false);
  });

  it('is false for a feature with no manifest loaded', () => {
    assert.strictEqual(urlSupportsSeeThrough('peek://groups/home.html', lookup), false);
  });

  it('is false for a page, which is what the command reports as a failure', () => {
    assert.strictEqual(urlSupportsSeeThrough('https://example.com/', lookup), false);
  });
});
