/**
 * Unit tests for renderer/cmd/note-notice.js — the saved-note notification text.
 *
 * Run via: node --test tests/unit/note-notice.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { noteSavedNotice } = await import(
  join(__dirname, '../../renderer/cmd/note-notice.js')
);

describe('noteSavedNotice', () => {
  it('labels by item type', () => {
    assert.equal(noteSavedNotice('text', 'x').title, 'Note saved');
    assert.equal(noteSavedNotice('url', 'https://a.b').title, 'URL saved');
    assert.equal(noteSavedNotice('tagset', 'a, b').title, 'Tagset saved');
  });

  it('collapses whitespace and truncates long bodies', () => {
    assert.equal(noteSavedNotice('text', 'a\n\n b').body, 'a b');
    const long = noteSavedNotice('text', 'x'.repeat(300)).body;
    assert.equal(long.length, 103);
    assert.ok(long.endsWith('...'));
  });

  it('tolerates empty content', () => {
    assert.equal(noteSavedNotice('text', undefined).body, '');
  });
});
