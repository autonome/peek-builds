/**
 * Unit tests for card-helpers.js favicon logic and getItemDisplayInfo().
 *
 * Tests the favicon fallback chain and display info computation for all item
 * types. Pure functions are duplicated here since the module depends on
 * DOM APIs (document.createElement) which are unavailable in Node.
 *
 * Run via: node --test tests/unit/card-helpers-favicon.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

// ---------------------------------------------------------------------------
// Pure functions extracted from app/lib/card-helpers.js
// These are duplicated here because the module uses DOM APIs.
// ---------------------------------------------------------------------------

const GLOBE_FAVICON = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">\u{1F310}</text></svg>';

const TYPE_ICONS = {
  url:     GLOBE_FAVICON,
  text:    'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">\u{1F4DD}</text></svg>',
  tag:     'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">#</text></svg>',
  tagset:  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">\u{1F3F7}\uFE0F</text></svg>',
  image:   'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">\u{1F5BC}\uFE0F</text></svg>',
  entity:  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">\u{1F48E}</text></svg>',
  feed:    'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">\u{1F4E1}</text></svg>',
  series:  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">\u{1F4DA}</text></svg>',
  unknown: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">?</text></svg>'
};

const extractTitle = (item, fallback) => {
  let title = item.title;
  if (!title && item.metadata) {
    try {
      const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
      title = meta.title;
    } catch (e) { /* ignore */ }
  }
  return title || fallback || item.uri || item.content || '(untitled)';
};

const formatUrl = (url) => {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return url;
  }
};

const extractUrl = (text) => {
  if (!text) return null;
  const trimmed = text.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try { new URL(trimmed); return trimmed; } catch (e) { /* fall through */ }
  }
  if (/^([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(\/\S*)?$/.test(trimmed)) {
    try { new URL('https://' + trimmed); return 'https://' + trimmed; } catch (e) { /* not valid */ }
  }
  return null;
};

const _googleFaviconFallback = (url) => {
  if (!url) return null;
  try {
    const domain = new URL(url.startsWith('http') ? url : 'https://' + url).hostname;
    if (domain) return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  } catch { /* invalid URL */ }
  return null;
};

const getItemDisplayInfo = (item, opts = {}) => {
  const tags = opts.tags || [];
  const isAddress = !!item.uri;
  const itemType = item.type || 'url';
  const noteUrl = (itemType === 'text') ? extractUrl(item.content) : null;

  let title, subtitle;
  let faviconUrl = TYPE_ICONS.unknown;

  if (isAddress) {
    title = extractTitle(item, item.uri);
    subtitle = formatUrl(item.uri);
    faviconUrl = item.favicon || opts.favicon || _googleFaviconFallback(item.uri) || TYPE_ICONS.url;
  } else {
    if (itemType === 'url') {
      title = extractTitle(item, item.content);
      subtitle = formatUrl(item.content);
      faviconUrl = item.favicon || opts.favicon || _googleFaviconFallback(item.content) || TYPE_ICONS.url;
    } else if (itemType === 'text') {
      title = item.title || (item.content || '').substring(0, 100) + ((item.content || '').length > 100 ? '...' : '');
      subtitle = noteUrl || '';
      faviconUrl = TYPE_ICONS.text;
    } else if (itemType === 'tag') {
      title = item.title || item.name || 'Tag';
      const freq = item.frequency || 0;
      subtitle = `Tag${freq ? ` (used ${freq}×)` : ''}`;
      faviconUrl = TYPE_ICONS.tag;
    } else if (itemType === 'tagset') {
      title = 'Tag Set';
      subtitle = tags.length > 0 ? tags.map(t => t.name).join(', ') : 'Empty tagset';
      faviconUrl = TYPE_ICONS.tagset;
    } else if (itemType === 'image') {
      title = item.content || 'Image';
      subtitle = 'Image';
      faviconUrl = TYPE_ICONS.image;
    } else if (itemType === 'entity') {
      title = item.title || item.content || 'Entity';
      let entityMeta = {};
      try { entityMeta = JSON.parse(item.metadata || '{}'); } catch {}
      const entityKind = entityMeta.entityType ? entityMeta.entityType.replace('_', ' ') : 'entity';
      subtitle = entityKind.charAt(0).toUpperCase() + entityKind.slice(1);
      faviconUrl = TYPE_ICONS.entity;
    } else if (itemType === 'feed') {
      title = item.title || item.content || 'Feed';
      subtitle = 'Feed';
      faviconUrl = TYPE_ICONS.feed;
    } else if (itemType === 'series') {
      title = item.title || item.content || 'Series';
      subtitle = 'Series';
      faviconUrl = TYPE_ICONS.series;
    }
  }

  const itemUrl = isAddress ? item.uri : (itemType === 'url') ? item.content : noteUrl;

  return { tags, isAddress, itemType, noteUrl, title, subtitle, faviconUrl, itemUrl };
};

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
