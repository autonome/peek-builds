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
const { urlMatchable, urlCompletionAtGranularity, URL_GRANULARITY_ORDER, inlineCompletionFor, isLoopbackAddress, withDefaultScheme } = await import(modulePath);

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

describe('isLoopbackAddress', () => {
  it('is true for bare localhost', () => {
    assert.equal(isLoopbackAddress('localhost'), true);
  });
  it('is true for localhost with a port and a path', () => {
    assert.equal(isLoopbackAddress('localhost:3000/x'), true);
  });
  it('is true for a multi-label *.localhost subdomain', () => {
    assert.equal(isLoopbackAddress('a.b.localhost'), true);
  });
  it('is true for 127.0.0.1', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
  });
  it('is true for a bracketed IPv6 loopback', () => {
    assert.equal(isLoopbackAddress('[::1]'), true);
  });
  it('is false for empty text', () => {
    assert.equal(isLoopbackAddress(''), false);
  });
  it('is false for a host that merely starts with localhost', () => {
    assert.equal(isLoopbackAddress('localhostx'), false);
  });
  it('is false for a host that merely contains localhost', () => {
    assert.equal(isLoopbackAddress('mylocalhost.com'), false);
  });
  it('is false when 127.0.0.1 is not the whole host', () => {
    assert.equal(isLoopbackAddress('127.0.0.1.example.com'), false);
  });
  it('is false for an unbracketed ::1', () => {
    assert.equal(isLoopbackAddress('::1'), false);
  });
  it('is false when the text contains whitespace', () => {
    assert.equal(isLoopbackAddress('localhost 3000'), false);
  });
});

describe('withDefaultScheme', () => {
  it('gives bare localhost http', () => {
    assert.equal(withDefaultScheme('localhost'), 'http://localhost');
  });
  it('gives localhost with a port http', () => {
    assert.equal(withDefaultScheme('localhost:3000'), 'http://localhost:3000');
  });
  it('keeps the path and query when adding http', () => {
    assert.equal(withDefaultScheme('localhost:3000/api?x=1'), 'http://localhost:3000/api?x=1');
  });
  it('gives 127.0.0.1 http', () => {
    assert.equal(withDefaultScheme('127.0.0.1:8080'), 'http://127.0.0.1:8080');
  });
  it('gives a bracketed IPv6 loopback http', () => {
    assert.equal(withDefaultScheme('[::1]:8080'), 'http://[::1]:8080');
  });
  it('gives a *.localhost subdomain http', () => {
    assert.equal(withDefaultScheme('foo.localhost'), 'http://foo.localhost');
  });
  it('recognises loopback case-insensitively', () => {
    assert.equal(withDefaultScheme('LOCALHOST:3000'), 'http://LOCALHOST:3000');
  });
  it('gives a public host https', () => {
    assert.equal(withDefaultScheme('example.com'), 'https://example.com');
  });
  it('gives https when localhost is not the last label', () => {
    assert.equal(withDefaultScheme('localhost.example.com'), 'https://localhost.example.com');
  });
  it('gives another 127.x address https', () => {
    assert.equal(withDefaultScheme('127.0.0.2'), 'https://127.0.0.2');
  });
  it('gives a LAN address https', () => {
    assert.equal(withDefaultScheme('192.168.1.10:3000'), 'https://192.168.1.10:3000');
  });
  it('leaves an explicit https:// untouched, even on localhost', () => {
    assert.equal(withDefaultScheme('https://localhost'), 'https://localhost');
  });
  it('leaves an explicit http:// untouched', () => {
    assert.equal(withDefaultScheme('http://example.com'), 'http://example.com');
  });
});
