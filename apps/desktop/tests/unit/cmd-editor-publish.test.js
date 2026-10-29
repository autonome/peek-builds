/**
 * Unit tests for renderer/cmd/commands/editor-publish.js — the messages a
 * command puts in `output.publish` to open the editor.
 *
 * Run via: node --test tests/unit/cmd-editor-publish.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { openItemMessages, openTagQueryMessages, openNewItemMessages } = await import(
  join(__dirname, '../../renderer/cmd/commands/editor-publish.js')
);

describe('editor-publish', () => {
  it('opens an existing item by id', () => {
    assert.deepEqual(openItemMessages('i1'), [
      { topic: 'editor:open', payload: { itemId: 'i1' } }
    ]);
  });

  it('announces a newly created item after opening it', () => {
    assert.deepEqual(openItemMessages('i1', { isNew: true }), [
      { topic: 'editor:open', payload: { itemId: 'i1' } },
      { topic: 'editor:changed', payload: { action: 'add', itemId: 'i1' } }
    ]);
  });

  it('opens the tag query view', () => {
    assert.deepEqual(openTagQueryMessages(['a']), [
      { topic: 'editor:open', payload: { tags: ['a'] } }
    ]);
  });

  it('opens the editor pre-filled for a new item with content', () => {
    assert.deepEqual(openNewItemMessages({ type: 'text', content: 'hello' }), [
      { topic: 'editor:open', payload: { content: 'hello' } }
    ]);
  });

  it('opens an empty editor for a new item without content', () => {
    assert.deepEqual(openNewItemMessages({ type: 'text' }), [
      { topic: 'editor:add', payload: { type: 'text' } }
    ]);
    assert.deepEqual(openNewItemMessages(), [
      { topic: 'editor:add', payload: { type: 'text' } }
    ]);
  });
});
