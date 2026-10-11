/**
 * Unit tests for urlsFromDrop in features/spaces/config.js.
 *
 * Run via: node --test tests/unit/spaces-drop-urls.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'features', 'spaces', 'config.js');
const { urlsFromDrop } = await import(modulePath);

describe('urlsFromDrop', () => {
  it('reads every line of a uri-list, skipping comments and blanks', () => {
    const uriList = '# dragged from a browser\r\nhttps://a.example/one\r\n\r\nhttps://b.example/two\r\n';
    assert.deepEqual(urlsFromDrop({ uriList }), ['https://a.example/one', 'https://b.example/two']);
  });

  it('reads the url lines of a moz-url (url, title pairs)', () => {
    const mozUrl = 'https://a.example/one\nFirst page\nhttps://b.example/two\nSecond page';
    assert.deepEqual(urlsFromDrop({ mozUrl }), ['https://a.example/one', 'https://b.example/two']);
  });

  it('falls back to a single url in plain text when nothing else carries one', () => {
    assert.deepEqual(urlsFromDrop({ plain: '  https://a.example/one \n' }), ['https://a.example/one']);
  });

  it('ignores plain text that is not exactly one url', () => {
    assert.deepEqual(urlsFromDrop({ plain: 'see https://a.example/one for details' }), []);
    assert.deepEqual(urlsFromDrop({ plain: 'https://a.example/one\nhttps://b.example/two' }), []);
    assert.deepEqual(urlsFromDrop({ plain: 'just some words' }), []);
  });

  it('does not read plain text when the uri-list already gave urls', () => {
    const result = urlsFromDrop({ uriList: 'https://a.example/one', plain: 'https://b.example/two' });
    assert.deepEqual(result, ['https://a.example/one']);
  });

  it('keeps only http and https', () => {
    const uriList = 'file:///etc/passwd\njavascript:alert(1)\nhttp://a.example/\nftp://a.example/x\npeek://app/x\nnot a url';
    assert.deepEqual(urlsFromDrop({ uriList }), ['http://a.example/']);
  });

  it('removes duplicates across sources and keeps first-seen order', () => {
    const uriList = 'https://b.example/\nhttps://a.example/\nhttps://b.example/';
    const mozUrl = 'https://a.example/\nA\nhttps://c.example/\nC';
    assert.deepEqual(urlsFromDrop({ uriList, mozUrl }), ['https://b.example/', 'https://a.example/', 'https://c.example/']);
  });

  it('returns nothing for an empty or missing drop', () => {
    assert.deepEqual(urlsFromDrop({}), []);
    assert.deepEqual(urlsFromDrop(), []);
    assert.deepEqual(urlsFromDrop({ uriList: '', plain: '', mozUrl: '' }), []);
  });
});
