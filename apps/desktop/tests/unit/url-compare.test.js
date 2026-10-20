/**
 * Unit tests for renderer/page/url-compare.js normalizeUrlForCompare.
 *
 * Run via: node --test tests/unit/url-compare.test.js
 *
 * The page chrome compares the active URL against a stored item's content to
 * decide which item the current page is, so a trailing slash, a default port or
 * a reordered query string must not read as a different address.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { normalizeUrlForCompare } from '../../renderer/page/url-compare.js';

describe('normalizeUrlForCompare — trailing slash handling', () => {
  it('removes trailing slash from paths', () => {
    assert.equal(
      normalizeUrlForCompare('https://example.com/path/'),
      'https://example.com/path'
    );
  });

  it('preserves root slash', () => {
    assert.equal(
      normalizeUrlForCompare('https://example.com/'),
      'https://example.com/'
    );
  });

  it('does not add trailing slash to bare domain', () => {
    // URL constructor normalizes bare domain to have trailing slash
    assert.equal(normalizeUrlForCompare('https://example.com'), 'https://example.com/');
  });
});

describe('normalizeUrlForCompare — port normalization', () => {
  it('removes default port 443 for HTTPS', () => {
    assert.equal(
      normalizeUrlForCompare('https://example.com:443/path'),
      'https://example.com/path'
    );
  });

  it('removes default port 80 for HTTP', () => {
    assert.equal(
      normalizeUrlForCompare('http://example.com:80/path'),
      'http://example.com/path'
    );
  });

  it('preserves non-default port', () => {
    assert.equal(
      normalizeUrlForCompare('https://example.com:8080/path'),
      'https://example.com:8080/path'
    );
  });

  it('preserves port 80 on HTTPS (non-default)', () => {
    assert.equal(
      normalizeUrlForCompare('https://example.com:80/path'),
      'https://example.com:80/path'
    );
  });

  it('preserves port 443 on HTTP (non-default)', () => {
    assert.equal(
      normalizeUrlForCompare('http://example.com:443/path'),
      'http://example.com:443/path'
    );
  });
});

describe('normalizeUrlForCompare — query param sorting', () => {
  it('sorts query params alphabetically', () => {
    assert.equal(
      normalizeUrlForCompare('https://example.com/path?z=1&a=2&m=3'),
      'https://example.com/path?a=2&m=3&z=1'
    );
  });

  it('leaves already-sorted params unchanged', () => {
    assert.equal(
      normalizeUrlForCompare('https://example.com/path?a=1&b=2&c=3'),
      'https://example.com/path?a=1&b=2&c=3'
    );
  });

  it('handles single query param', () => {
    assert.equal(
      normalizeUrlForCompare('https://example.com/path?key=val'),
      'https://example.com/path?key=val'
    );
  });
});

describe('normalizeUrlForCompare — already normalized and invalid', () => {
  it('already normalized URL is unchanged', () => {
    const url = 'https://example.com/path?a=1&b=2';
    assert.equal(normalizeUrlForCompare(url), url);
  });

  it('invalid URL returns original string', () => {
    assert.equal(normalizeUrlForCompare('not-a-url'), 'not-a-url');
    assert.equal(normalizeUrlForCompare(''), '');
    assert.equal(normalizeUrlForCompare('://broken'), '://broken');
  });
});

describe('normalizeUrlForCompare — URL matching scenarios for resolveItemId', () => {
  it('trailing slash mismatch resolves to same normalized URL', () => {
    const a = normalizeUrlForCompare('https://example.com/docs/');
    const b = normalizeUrlForCompare('https://example.com/docs');
    assert.equal(a, b);
  });

  it('query param order mismatch resolves to same normalized URL', () => {
    const a = normalizeUrlForCompare('https://example.com/page?b=2&a=1');
    const b = normalizeUrlForCompare('https://example.com/page?a=1&b=2');
    assert.equal(a, b);
  });

  it('different URLs do NOT match after normalization', () => {
    const a = normalizeUrlForCompare('https://example.com/path-a');
    const b = normalizeUrlForCompare('https://example.com/path-b');
    assert.notEqual(a, b);
  });

  it('different domains do NOT match', () => {
    const a = normalizeUrlForCompare('https://example.com/path');
    const b = normalizeUrlForCompare('https://other.com/path');
    assert.notEqual(a, b);
  });

  it('combined normalization: trailing slash + param sort + default port', () => {
    const a = normalizeUrlForCompare('https://example.com:443/docs/?z=1&a=2');
    const b = normalizeUrlForCompare('https://example.com/docs?a=2&z=1');
    assert.equal(a, b);
  });
});
