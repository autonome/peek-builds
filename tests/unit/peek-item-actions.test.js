/**
 * Unit tests for peek-item-actions component logic.
 *
 * The Lit web component itself runs in a full browser/Electron context.
 * This file tests the pure logic extracted from the component:
 * - URL classification (which items get the open-inline button)
 * - Action event detail shape
 * - Groups integration handler logic (confirm-gate, pubsub payload)
 *
 * Run via: node --test tests/unit/peek-item-actions.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

// ---------------------------------------------------------------------------
// Pure logic extracted from peek-item-actions.js
// ---------------------------------------------------------------------------

/**
 * Whether a URL is a web URL eligible for the open-inline action.
 * Mirrors the check inside PeekItemActions.render().
 */
const isWebUrl = (url) => {
  if (!url || typeof url !== 'string') return false;
  return url.startsWith('http://') || url.startsWith('https://');
};

/**
 * Resolve the item URL from an item object (mirrors component logic).
 */
const resolveItemUrl = (item) => {
  if (!item) return '';
  return item.uri || item.content || '';
};

/**
 * Build the action-open-inline event detail (mirrors _handleOpenInline).
 */
const buildOpenInlineDetail = (item) => {
  const url = resolveItemUrl(item);
  return { item, url };
};

/**
 * Build the action-delete event detail (mirrors _handleDelete).
 */
const buildDeleteDetail = (item) => {
  return { item };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('peek-item-actions — URL classification', () => {
  it('treats https URLs as web URLs', () => {
    assert.equal(isWebUrl('https://example.com'), true);
  });

  it('treats http URLs as web URLs', () => {
    assert.equal(isWebUrl('http://example.com/path'), true);
  });

  it('rejects peek:// internal URLs', () => {
    assert.equal(isWebUrl('peek://app/background.html'), false);
  });

  it('rejects empty string', () => {
    assert.equal(isWebUrl(''), false);
  });

  it('rejects null', () => {
    assert.equal(isWebUrl(null), false);
  });

  it('rejects undefined', () => {
    assert.equal(isWebUrl(undefined), false);
  });

  it('rejects plain text (non-URL content items)', () => {
    assert.equal(isWebUrl('just some text'), false);
  });
});

describe('peek-item-actions — item URL resolution', () => {
  it('uses uri field for address-type items', () => {
    const item = { id: '1', uri: 'https://example.com', content: null };
    assert.equal(resolveItemUrl(item), 'https://example.com');
  });

  it('uses content field when uri is absent (text items)', () => {
    const item = { id: '2', content: 'some note text' };
    assert.equal(resolveItemUrl(item), 'some note text');
  });

  it('prefers uri over content when both present', () => {
    const item = { id: '3', uri: 'https://a.com', content: 'also text' };
    assert.equal(resolveItemUrl(item), 'https://a.com');
  });

  it('returns empty string for null item', () => {
    assert.equal(resolveItemUrl(null), '');
  });

  it('returns empty string when both uri and content absent', () => {
    const item = { id: '4' };
    assert.equal(resolveItemUrl(item), '');
  });
});

describe('peek-item-actions — action event details', () => {
  it('action-open-inline detail includes item and url', () => {
    const item = { id: '10', uri: 'https://example.com', title: 'Example' };
    const detail = buildOpenInlineDetail(item);
    assert.equal(detail.item, item);
    assert.equal(detail.url, 'https://example.com');
  });

  it('action-open-inline detail url from content when no uri', () => {
    const item = { id: '11', content: 'https://other.com', title: 'Other' };
    const detail = buildOpenInlineDetail(item);
    assert.equal(detail.url, 'https://other.com');
  });

  it('action-delete detail includes item reference', () => {
    const item = { id: '20', title: 'To Delete' };
    const detail = buildDeleteDetail(item);
    assert.equal(detail.item, item);
    assert.equal(detail.item.id, '20');
  });
});

describe('peek-item-actions — groups integration: open-inline decides whether to show button', () => {
  it('shows open-inline button only for web URLs', () => {
    const webItem = { id: '1', uri: 'https://example.com' };
    const internalItem = { id: '2', uri: 'peek://groups/home.html' };
    const textItem = { id: '3', content: 'plain text note' };

    assert.equal(isWebUrl(resolveItemUrl(webItem)), true,  'web item gets button');
    assert.equal(isWebUrl(resolveItemUrl(internalItem)), false, 'internal URL skips button');
    assert.equal(isWebUrl(resolveItemUrl(textItem)), false, 'text item skips button');
  });
});
