/**
 * Unit tests for the pure URL inline-completion helpers.
 *
 * Run via: node --test tests/unit/url-completion.test.js
 * (leaf module — no DOM/electron deps, imported directly.)
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'renderer', 'cmd', 'url-completion.js');
const { urlMatchable, urlCompletionAtGranularity, URL_GRANULARITY_ORDER, inlineCompletionFor } = await import(modulePath);

describe('urlMatchable', () => {
  it('strips https:// and a leading www.', () => {
    assert.equal(urlMatchable('https://www.marktplaats.nl/foo'), 'marktplaats.nl/foo');
  });
  it('strips http://', () => {
    assert.equal(urlMatchable('http://example.com/x'), 'example.com/x');
  });
  it('keeps query and fragment', () => {
    assert.equal(urlMatchable('https://x.com/a?b=1#c'), 'x.com/a?b=1#c');
  });
  it('returns empty string for falsy input', () => {
    assert.equal(urlMatchable(''), '');
    assert.equal(urlMatchable(null), '');
  });
});

describe('urlCompletionAtGranularity', () => {
  const URL = 'https://app.fastmail.com/mail/Inbox?u=track#frag';

  it('host = full hostname, scheme stripped', () => {
    assert.equal(urlCompletionAtGranularity(URL, 'host'), 'app.fastmail.com');
  });
  it('path1 = host + first path segment', () => {
    assert.equal(urlCompletionAtGranularity(URL, 'path1'), 'app.fastmail.com/mail');
  });
  it('path = host + full path, query/fragment stripped', () => {
    assert.equal(urlCompletionAtGranularity(URL, 'path'), 'app.fastmail.com/mail/Inbox');
  });
  it('full = everything (matchable-form), query/fragment kept', () => {
    assert.equal(urlCompletionAtGranularity(URL, 'full'), 'app.fastmail.com/mail/Inbox?u=track#frag');
  });

  it('strips a leading www. from the host', () => {
    assert.equal(urlCompletionAtGranularity('https://www.ziggurat.example.com/visited/page', 'host'),
      'ziggurat.example.com');
  });

  it('does NOT strip subdomains — a co.uk host keeps all labels', () => {
    // Proves we do not attempt a registrable-domain (public-suffix) reduction.
    assert.equal(urlCompletionAtGranularity('https://shop.example.co.uk/cart', 'host'),
      'shop.example.co.uk');
  });
  it('does NOT strip a github.io project-page host', () => {
    assert.equal(urlCompletionAtGranularity('https://user.github.io/repo/page', 'host'),
      'user.github.io');
  });

  it('path1 with no path segments falls back to host', () => {
    assert.equal(urlCompletionAtGranularity('https://example.com', 'path1'), 'example.com');
  });
  it('path with only a root slash falls back to host', () => {
    assert.equal(urlCompletionAtGranularity('https://example.com/', 'path'), 'example.com');
  });

  it('unparseable input falls back to matchable form', () => {
    assert.equal(urlCompletionAtGranularity('not a url', 'host'), 'not a url');
  });
  it('empty input returns empty string', () => {
    assert.equal(urlCompletionAtGranularity('', 'host'), '');
  });

  it('granularities are strictly non-decreasing in length for a deep URL', () => {
    let prev = -1;
    for (const g of URL_GRANULARITY_ORDER) {
      const len = urlCompletionAtGranularity(URL, g).length;
      assert.ok(len >= prev, `granularity ${g} shorter than previous`);
      prev = len;
    }
  });
});

describe('inlineCompletionFor', () => {
  it('returns the completion for a plain prefix', () => {
    assert.equal(inlineCompletionFor('tangled.org', 'tangled'), 'tangled.org');
  });
  it('returns the completion for a case-insensitive prefix', () => {
    assert.equal(inlineCompletionFor('Tangled.org', 'tANGled'), 'Tangled.org');
  });
  it('returns null when the anchor has a trailing space', () => {
    assert.equal(inlineCompletionFor('tangled.org', 'tangled '), null);
  });
  it('returns null when the anchor has a leading space', () => {
    assert.equal(inlineCompletionFor('tangled.org', ' tangled'), null);
  });
  it('returns null for an empty anchor', () => {
    assert.equal(inlineCompletionFor('tangled.org', ''), null);
  });
  it('returns null when the anchor equals the completion', () => {
    assert.equal(inlineCompletionFor('tangled.org', 'tangled.org'), null);
  });
  it('returns null for a non-prefix substring match', () => {
    assert.equal(inlineCompletionFor('app.fastmail.com', 'fast'), null);
  });
});
