/**
 * Unit tests for renderer/cmd/note-notice.js — the saved-note notification text
 * and the output-to-editor-topic mapping.
 *
 * Run via: node --test tests/unit/note-notice.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { noteSavedNotice, editorMessageForOutput } = await import(
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

describe('editorMessageForOutput', () => {
  it('opens the editor with starting content for a new-item with content', () => {
    assert.deepEqual(
      editorMessageForOutput({ mimeType: 'new-item', data: { type: 'text', content: 'hello' } }),
      { topic: 'editor:open', payload: { content: 'hello' } }
    );
  });

  it('opens an empty editor for a new-item without content', () => {
    assert.deepEqual(
      editorMessageForOutput({ mimeType: 'new-item', data: { type: 'text' } }),
      { topic: 'editor:add', payload: { type: 'text' } }
    );
  });

  it('opens the tag query view for a tag-query', () => {
    assert.deepEqual(
      editorMessageForOutput({ mimeType: 'tag-query', data: { tags: ['a'] } }),
      { topic: 'editor:open', payload: { tags: ['a'] } }
    );
  });

  it('opens an existing item by id, announcing new ones', () => {
    assert.deepEqual(
      editorMessageForOutput({ mimeType: 'item', data: { id: 'i1' } }),
      { topic: 'editor:open', payload: { itemId: 'i1' } }
    );
    const created = editorMessageForOutput({ mimeType: 'item', isNew: true, data: { id: 'i1' } });
    assert.deepEqual(created.alsoChanged, { topic: 'editor:changed', payload: { action: 'add', itemId: 'i1' } });
  });

  it('returns null when there is nothing to open', () => {
    assert.equal(editorMessageForOutput(null), null);
    assert.equal(editorMessageForOutput({ mimeType: 'item', data: {} }), null);
  });
});
