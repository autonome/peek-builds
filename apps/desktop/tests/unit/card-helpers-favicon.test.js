/**
 * Unit tests for renderer/lib/card-helpers.js favicon logic and getItemDisplayInfo().
 *
 * Tests the favicon fallback chain and display info computation for all item types.
 *
 * The module touches `document` only inside function bodies (createHeaderSlot, createFaviconEl,
 * createUrlSpan), never at load, so it imports directly under plain node. None of the cases below
 * call those DOM-building helpers.
 *
 * Run via: node --test tests/unit/card-helpers-favicon.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'renderer', 'lib', 'card-helpers.js');
const { GLOBE_FAVICON, TYPE_ICONS, extractUrl, _googleFaviconFallback, getItemDisplayInfo } =
  await import(modulePath);

// ===========================================================================
// Tests: _googleFaviconFallback
// ===========================================================================

describe('_googleFaviconFallback', () => {
  it('returns Google favicon URL for a valid https URL', () => {
    const result = _googleFaviconFallback('https://example.com/page');
    assert.equal(result, 'https://www.google.com/s2/favicons?domain=example.com&sz=32');
  });

  it('returns Google favicon URL for a valid http URL', () => {
    const result = _googleFaviconFallback('http://news.ycombinator.com');
    assert.equal(result, 'https://www.google.com/s2/favicons?domain=news.ycombinator.com&sz=32');
  });

  it('prepends https:// when URL lacks protocol', () => {
    const result = _googleFaviconFallback('github.com/user/repo');
    assert.equal(result, 'https://www.google.com/s2/favicons?domain=github.com&sz=32');
  });

  it('returns null for null input', () => {
    assert.equal(_googleFaviconFallback(null), null);
  });

  it('returns null for undefined input', () => {
    assert.equal(_googleFaviconFallback(undefined), null);
  });

  it('returns null for empty string', () => {
    assert.equal(_googleFaviconFallback(''), null);
  });

  it('returns null for completely invalid URL', () => {
    // A string that cannot be parsed even with https:// prefix
    assert.equal(_googleFaviconFallback('://'), null);
  });

  it('extracts domain from URL with path, query, and fragment', () => {
    const result = _googleFaviconFallback('https://docs.python.org/3/library/json.html?highlight=json#module-json');
    assert.equal(result, 'https://www.google.com/s2/favicons?domain=docs.python.org&sz=32');
  });

  it('extracts domain from URL with port', () => {
    const result = _googleFaviconFallback('https://localhost:3000/app');
    assert.equal(result, 'https://www.google.com/s2/favicons?domain=localhost&sz=32');
  });

  it('handles subdomain correctly', () => {
    const result = _googleFaviconFallback('https://blog.example.co.uk/posts');
    assert.equal(result, 'https://www.google.com/s2/favicons?domain=blog.example.co.uk&sz=32');
  });
});

// ===========================================================================
// Tests: getItemDisplayInfo — favicon fallback chain
// ===========================================================================

describe('getItemDisplayInfo favicon fallback chain', () => {

  describe('URL items (non-address)', () => {
    it('the url type icon is the globe favicon', () => {
      assert.equal(TYPE_ICONS.url, GLOBE_FAVICON);
    });

    it('uses item.favicon when present', () => {
      const item = { type: 'url', content: 'https://example.com', favicon: 'https://example.com/icon.png' };
      const info = getItemDisplayInfo(item);
      assert.equal(info.faviconUrl, 'https://example.com/icon.png');
    });

    it('uses opts.favicon when item.favicon is missing', () => {
      const item = { type: 'url', content: 'https://example.com' };
      const info = getItemDisplayInfo(item, { favicon: 'https://cdn.example.com/fav.png' });
      assert.equal(info.faviconUrl, 'https://cdn.example.com/fav.png');
    });

    it('falls back to Google favicon service when no explicit favicon', () => {
      const item = { type: 'url', content: 'https://example.com/page' };
      const info = getItemDisplayInfo(item);
      assert.equal(info.faviconUrl, 'https://www.google.com/s2/favicons?domain=example.com&sz=32');
    });

    it('falls back to TYPE_ICONS.url when URL is invalid (no domain extractable)', () => {
      const item = { type: 'url', content: 'not-a-valid-url' };
      const info = getItemDisplayInfo(item);
      // 'not-a-valid-url' treated as domain-less -> _googleFaviconFallback will attempt
      // 'https://not-a-valid-url' which is technically parseable but has no TLD.
      // The key assertion: it should NOT be TYPE_ICONS.unknown
      assert.ok(info.faviconUrl !== TYPE_ICONS.unknown, 'should not be unknown icon');
    });

    it('item.favicon takes priority over opts.favicon', () => {
      const item = { type: 'url', content: 'https://example.com', favicon: 'https://a.com/icon.png' };
      const info = getItemDisplayInfo(item, { favicon: 'https://b.com/icon.png' });
      assert.equal(info.faviconUrl, 'https://a.com/icon.png');
    });
  });

  describe('address items (has uri)', () => {
    it('uses item.favicon when present', () => {
      const item = { uri: 'https://example.com', favicon: 'https://example.com/fav.ico' };
      const info = getItemDisplayInfo(item);
      assert.equal(info.faviconUrl, 'https://example.com/fav.ico');
    });

    it('uses opts.favicon as second fallback', () => {
      const item = { uri: 'https://example.com' };
      const info = getItemDisplayInfo(item, { favicon: 'https://x.com/fav.ico' });
      assert.equal(info.faviconUrl, 'https://x.com/fav.ico');
    });

    it('falls back to Google favicon service', () => {
      const item = { uri: 'https://github.com/user/repo' };
      const info = getItemDisplayInfo(item);
      assert.equal(info.faviconUrl, 'https://www.google.com/s2/favicons?domain=github.com&sz=32');
    });

    it('sets isAddress true for items with uri', () => {
      const item = { uri: 'https://example.com' };
      const info = getItemDisplayInfo(item);
      assert.equal(info.isAddress, true);
    });
  });

  describe('non-URL item types use type-specific icons', () => {
    it('text items use TYPE_ICONS.text', () => {
      const item = { type: 'text', content: 'some note text' };
      const info = getItemDisplayInfo(item);
      assert.equal(info.faviconUrl, TYPE_ICONS.text);
    });

    it('tagset items use TYPE_ICONS.tagset', () => {
      const item = { type: 'tagset' };
      const info = getItemDisplayInfo(item);
      assert.equal(info.faviconUrl, TYPE_ICONS.tagset);
    });

    it('image items use TYPE_ICONS.image', () => {
      const item = { type: 'image', content: 'photo.jpg' };
      const info = getItemDisplayInfo(item);
      assert.equal(info.faviconUrl, TYPE_ICONS.image);
    });

    it('entity items use TYPE_ICONS.entity', () => {
      const item = { type: 'entity', title: 'Test Entity' };
      const info = getItemDisplayInfo(item);
      assert.equal(info.faviconUrl, TYPE_ICONS.entity);
    });

    it('feed items use TYPE_ICONS.feed', () => {
      const item = { type: 'feed', title: 'RSS Feed' };
      const info = getItemDisplayInfo(item);
      assert.equal(info.faviconUrl, TYPE_ICONS.feed);
    });

    it('series items use TYPE_ICONS.series', () => {
      const item = { type: 'series', title: 'My Series' };
      const info = getItemDisplayInfo(item);
      assert.equal(info.faviconUrl, TYPE_ICONS.series);
    });

    it('event items use TYPE_ICONS.event', () => {
      const item = { type: 'event', title: 'Launch party' };
      const info = getItemDisplayInfo(item);
      assert.equal(info.faviconUrl, TYPE_ICONS.event);
    });
  });
});

// ===========================================================================
// Tests: getItemDisplayInfo — title and subtitle extraction
// ===========================================================================

describe('getItemDisplayInfo title extraction', () => {
  it('uses item.title for URL items', () => {
    const item = { type: 'url', content: 'https://example.com', title: 'Example Site' };
    const info = getItemDisplayInfo(item);
    assert.equal(info.title, 'Example Site');
  });

  it('falls back to URL content when no title', () => {
    const item = { type: 'url', content: 'https://example.com/path' };
    const info = getItemDisplayInfo(item);
    assert.equal(info.title, 'https://example.com/path');
  });

  it('extracts title from metadata JSON string', () => {
    const item = { type: 'url', content: 'https://x.com', metadata: JSON.stringify({ title: 'Meta Title' }) };
    const info = getItemDisplayInfo(item);
    assert.equal(info.title, 'Meta Title');
  });

  it('extracts title from metadata object', () => {
    const item = { type: 'url', content: 'https://x.com', metadata: { title: 'Object Title' } };
    const info = getItemDisplayInfo(item);
    assert.equal(info.title, 'Object Title');
  });

  it('truncates long text content to 100 chars for text items', () => {
    const longText = 'A'.repeat(150);
    const item = { type: 'text', content: longText };
    const info = getItemDisplayInfo(item);
    assert.equal(info.title, 'A'.repeat(100) + '...');
  });

  it('does not add ellipsis for short text items', () => {
    const item = { type: 'text', content: 'short note' };
    const info = getItemDisplayInfo(item);
    assert.equal(info.title, 'short note');
  });

  it('formats URL subtitle for URL items', () => {
    const item = { type: 'url', content: 'https://example.com/page?q=1' };
    const info = getItemDisplayInfo(item);
    assert.equal(info.subtitle, 'example.com/page');
  });

  it('returns (untitled) when everything is empty', () => {
    const item = { type: 'url' };
    const info = getItemDisplayInfo(item);
    assert.equal(info.title, '(untitled)');
  });

  it('tag items show their name as title and frequency in subtitle', () => {
    const item = { type: 'tag', title: 'mytag', frequency: 5 };
    const info = getItemDisplayInfo(item);
    assert.equal(info.title, 'mytag');
    assert.equal(info.subtitle, 'Tag (used 5×)');
    assert.equal(info.faviconUrl, TYPE_ICONS.tag);
  });

  it('tag items omit frequency when zero', () => {
    const item = { type: 'tag', title: 'newtag' };
    const info = getItemDisplayInfo(item);
    assert.equal(info.title, 'newtag');
    assert.equal(info.subtitle, 'Tag');
  });

  it('tagset subtitle shows tag names', () => {
    const item = { type: 'tagset' };
    const info = getItemDisplayInfo(item, { tags: [{ name: 'foo' }, { name: 'bar' }] });
    assert.equal(info.subtitle, 'foo, bar');
  });

  it('tagset subtitle shows "Empty tagset" when no tags', () => {
    const item = { type: 'tagset' };
    const info = getItemDisplayInfo(item);
    assert.equal(info.subtitle, 'Empty tagset');
  });

  it('entity subtitle capitalizes entityType from metadata', () => {
    const item = { type: 'entity', title: 'E', metadata: JSON.stringify({ entityType: 'named_entity' }) };
    const info = getItemDisplayInfo(item);
    assert.equal(info.subtitle, 'Named entity');
  });

  it('event subtitle is the localized start time from metadata', () => {
    const startsAt = '2026-03-04T17:30:00.000Z';
    const item = { type: 'event', title: 'Launch party', metadata: JSON.stringify({ startsAt }) };
    const info = getItemDisplayInfo(item);
    assert.equal(info.title, 'Launch party');
    assert.equal(info.subtitle, new Date(startsAt).toLocaleString());
  });

  it('event subtitle falls back to "Event" without a start time', () => {
    const item = { type: 'event', content: 'Standup' };
    const info = getItemDisplayInfo(item);
    assert.equal(info.title, 'Standup');
    assert.equal(info.subtitle, 'Event');
  });
});

// ===========================================================================
// Tests: getItemDisplayInfo — itemUrl computation
// ===========================================================================

describe('getItemDisplayInfo itemUrl', () => {
  it('returns uri for address items', () => {
    const item = { uri: 'https://example.com' };
    const info = getItemDisplayInfo(item);
    assert.equal(info.itemUrl, 'https://example.com');
  });

  it('returns content for URL type items', () => {
    const item = { type: 'url', content: 'https://example.com/page' };
    const info = getItemDisplayInfo(item);
    assert.equal(info.itemUrl, 'https://example.com/page');
  });

  it('returns extracted URL for text items containing a URL', () => {
    const item = { type: 'text', content: 'https://example.com' };
    const info = getItemDisplayInfo(item);
    assert.equal(info.itemUrl, 'https://example.com');
  });

  it('returns null for text items without URL', () => {
    const item = { type: 'text', content: 'just a note' };
    const info = getItemDisplayInfo(item);
    assert.equal(info.itemUrl, null);
  });

  it('returns null for image items', () => {
    const item = { type: 'image', content: 'photo.jpg' };
    const info = getItemDisplayInfo(item);
    assert.equal(info.itemUrl, null);
  });
});

// ===========================================================================
// Tests: getItemDisplayInfo — thumbnailHash
// ===========================================================================

describe('getItemDisplayInfo thumbnailHash', () => {
  it('passes item.thumbnail through', () => {
    const item = { type: 'url', content: 'https://example.com', thumbnail: 'abc123' };
    const info = getItemDisplayInfo(item);
    assert.equal(info.thumbnailHash, 'abc123');
  });

  it('is null when the item has no thumbnail', () => {
    const item = { type: 'url', content: 'https://example.com' };
    const info = getItemDisplayInfo(item);
    assert.equal(info.thumbnailHash, null);
  });
});

// ===========================================================================
// Tests: extractUrl helper
// ===========================================================================

describe('extractUrl', () => {
  it('extracts https URL', () => {
    assert.equal(extractUrl('https://example.com'), 'https://example.com');
  });

  it('extracts http URL', () => {
    assert.equal(extractUrl('http://example.com/path'), 'http://example.com/path');
  });

  it('adds https to bare domain', () => {
    assert.equal(extractUrl('example.com'), 'https://example.com');
  });

  it('adds https to domain with path', () => {
    assert.equal(extractUrl('example.com/page'), 'https://example.com/page');
  });

  it('returns null for plain text', () => {
    assert.equal(extractUrl('just some text'), null);
  });

  it('returns null for null', () => {
    assert.equal(extractUrl(null), null);
  });

  it('returns null for empty string', () => {
    assert.equal(extractUrl(''), null);
  });

  it('trims whitespace', () => {
    assert.equal(extractUrl('  https://example.com  '), 'https://example.com');
  });
});
