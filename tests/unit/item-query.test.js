/**
 * Unit tests for extractTitle from the item-query module.
 *
 * extractTitle is a pure function with no external dependencies,
 * extracted into extract-title.js so it can be tested outside Electron.
 *
 * Run via: ELECTRON_RUN_AS_NODE=1 node --test tests/unit/item-query.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'features', 'cmd', 'commands', 'extract-title.js');

const { extractTitle } = await import(modulePath);

describe('extractTitle', () => {
  it('returns metadata.title when present (metadata is JSON string)', () => {
    const item = {
      metadata: JSON.stringify({ title: 'My Page Title', name: 'fallback' }),
      content: 'https://example.com'
    };
    assert.equal(extractTitle(item), 'My Page Title');
  });

  it('returns metadata.name as fallback when no title', () => {
    const item = {
      metadata: JSON.stringify({ name: 'Author Name' }),
      content: 'some content'
    };
    assert.equal(extractTitle(item), 'Author Name');
  });

  it('prefers title over name when both present', () => {
    const item = {
      metadata: JSON.stringify({ title: 'The Title', name: 'The Name' }),
      content: 'content'
    };
    assert.equal(extractTitle(item), 'The Title');
  });

  it('returns item.content when no metadata title or name', () => {
    const item = {
      metadata: JSON.stringify({ description: 'just a description' }),
      content: 'https://example.com/page'
    };
    assert.equal(extractTitle(item), 'https://example.com/page');
  });

  it('returns item.content when metadata is empty object', () => {
    const item = {
      metadata: JSON.stringify({}),
      content: 'raw content here'
    };
    assert.equal(extractTitle(item), 'raw content here');
  });

  it('returns "Untitled" when no content or metadata', () => {
    const item = {};
    assert.equal(extractTitle(item), 'Untitled');
  });

  it('returns "Untitled" when content is empty string and no metadata', () => {
    const item = { content: '', metadata: null };
    assert.equal(extractTitle(item), 'Untitled');
  });

  it('handles malformed metadata JSON gracefully', () => {
    const item = {
      metadata: '{not valid json!!!',
      content: 'fallback content'
    };
    assert.equal(extractTitle(item), 'fallback content');
  });

  it('returns "Untitled" with malformed JSON and no content', () => {
    const item = {
      metadata: 'broken json'
    };
    assert.equal(extractTitle(item), 'Untitled');
  });

  it('handles metadata as object (not string)', () => {
    const item = {
      metadata: { title: 'Object Title' },
      content: 'content'
    };
    assert.equal(extractTitle(item), 'Object Title');
  });

  it('handles metadata as object with name only', () => {
    const item = {
      metadata: { name: 'Object Name' },
      content: 'content'
    };
    assert.equal(extractTitle(item), 'Object Name');
  });

  it('handles null metadata', () => {
    const item = { metadata: null, content: 'some content' };
    assert.equal(extractTitle(item), 'some content');
  });

  it('handles undefined metadata', () => {
    const item = { metadata: undefined, content: 'some content' };
    assert.equal(extractTitle(item), 'some content');
  });

  it('handles metadata with empty title string', () => {
    const item = {
      metadata: JSON.stringify({ title: '' }),
      content: 'fallback'
    };
    // Empty string is falsy, so should fall through to content
    assert.equal(extractTitle(item), 'fallback');
  });

  it('handles metadata with empty name string and no title', () => {
    const item = {
      metadata: JSON.stringify({ name: '' }),
      content: 'fallback'
    };
    assert.equal(extractTitle(item), 'fallback');
  });
});
