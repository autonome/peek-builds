import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeAction,
  needsFlush,
  editableText,
  savePayload,
  AUTOSAVE_DELAY_MS,
  SAVE_KEY,
  inlineKeymap,
  isAtEdge,
} from '../../features/editor/query-inline-editor.js';
import { queryKey } from '../../features/editor/query-keys.js';

describe('inlineKeymap', () => {
  test('Mod-Enter saves and reports the key handled, so no newline is inserted', () => {
    let saved = 0;
    const [binding, ...rest] = inlineKeymap(() => { saved++; });
    assert.equal(rest.length, 0);
    assert.equal(binding.key, SAVE_KEY);
    assert.equal(SAVE_KEY, 'Mod-Enter');
    assert.equal(binding.run(), true);
    assert.equal(saved, 1);
  });

  test('without an edge handler only the save key is bound', () => {
    assert.equal(inlineKeymap(() => {}).length, 1);
  });

  test('arrow keys call the edge handler only at the edge and pass otherwise', () => {
    const calls = [];
    const keys = inlineKeymap(() => {}, (dir) => { calls.push(dir); return true; });
    const up = keys.find(k => k.key === 'ArrowUp');
    const down = keys.find(k => k.key === 'ArrowDown');
    const view = (from, to, length) => ({ state: { selection: { main: { from, to } }, doc: { length } } });
    assert.equal(up.run(view(3, 3, 10)), false);
    assert.equal(down.run(view(3, 3, 10)), false);
    assert.equal(up.run(view(0, 0, 10)), true);
    assert.equal(down.run(view(10, 10, 10)), true);
    assert.deepEqual(calls, ['up', 'down']);
  });

  test('an edge handler that does not move leaves the key to the editor', () => {
    const [, up] = inlineKeymap(() => {}, () => false);
    assert.equal(up.run({ state: { selection: { main: { from: 0, to: 0 } }, doc: { length: 5 } } }), false);
  });
});

describe('isAtEdge', () => {
  test('up needs the caret at the start, down at the end', () => {
    assert.equal(isAtEdge('up', { from: 0, to: 0 }, 5), true);
    assert.equal(isAtEdge('up', { from: 2, to: 2 }, 5), false);
    assert.equal(isAtEdge('down', { from: 5, to: 5 }, 5), true);
    assert.equal(isAtEdge('down', { from: 2, to: 2 }, 5), false);
  });

  test('a selection is never an edge', () => {
    assert.equal(isAtEdge('up', { from: 0, to: 3 }, 5), false);
    assert.equal(isAtEdge('down', { from: 2, to: 5 }, 5), false);
  });

  test('an empty document is both edges', () => {
    assert.equal(isAtEdge('up', { from: 0, to: 0 }, 0), true);
    assert.equal(isAtEdge('down', { from: 0, to: 0 }, 0), true);
  });
});

describe('escapeAction', () => {
  test('closed editor leaves <Esc> to the window', () => {
    assert.equal(escapeAction({ open: false, vimEnabled: true, vimInsertOrVisual: true }), 'default');
    assert.equal(escapeAction({ open: false, vimEnabled: false, vimInsertOrVisual: false }), 'default');
  });

  test('vim insert or visual mode goes to normal first', () => {
    assert.equal(escapeAction({ open: true, vimEnabled: true, vimInsertOrVisual: true }), 'vim-normal');
  });

  test('vim normal mode closes the editor', () => {
    assert.equal(escapeAction({ open: true, vimEnabled: true, vimInsertOrVisual: false }), 'close');
  });

  test('without vim, <Esc> closes the editor', () => {
    assert.equal(escapeAction({ open: true, vimEnabled: false, vimInsertOrVisual: true }), 'close');
  });

  test('missing state is the window default', () => {
    assert.equal(escapeAction(undefined), 'default');
  });
});

describe('needsFlush', () => {
  test('unsaved text needs a write on close', () => {
    assert.equal(needsFlush('a', 'ab'), true);
  });
  test('saved text does not', () => {
    assert.equal(needsFlush('ab', 'ab'), false);
  });
  test('a failed write (saved text unknown) is retried', () => {
    assert.equal(needsFlush(null, 'ab'), true);
  });
});

describe('what is edited and saved', () => {
  test('text items edit their content and save content plus title', () => {
    const item = { type: 'text', content: '# Old\nbody' };
    assert.equal(editableText(item), '# Old\nbody');
    assert.deepEqual(savePayload(item, '## New title\nmore'), { content: '## New title\nmore', title: 'New title' });
  });

  test('url and image items edit only their notes', () => {
    const url = { type: 'url', content: 'https://example.com', metadata: JSON.stringify({ notes: 'read later' }) };
    assert.equal(editableText(url), 'read later');
    assert.deepEqual(savePayload(url, 'done'), { metadata: { notes: 'done' } });

    const image = { type: 'image', content: 'data:image/png;base64,AA', metadata: { notes: 'cat' } };
    assert.equal(editableText(image), 'cat');
    assert.deepEqual(savePayload(image, ''), { metadata: { notes: '' } });
  });

  test('a url item without notes starts empty', () => {
    assert.equal(editableText({ type: 'url', content: 'https://example.com' }), '');
  });
});

describe('block keys while an inline editor is open', () => {
  const base = { selectedIndex: 0, blockCount: 3, folded: new Set(), pendingZ: false };
  test('j, k and z belong to the editor', () => {
    for (const key of ['j', 'k', 'z', 'ArrowDown']) {
      assert.equal(queryKey(key, { ...base, inlineOpen: true }), null);
    }
  });
  test('with no editor open they are handled', () => {
    assert.notEqual(queryKey('j', { ...base, inlineOpen: false }), null);
  });
});

test('autosave delay matches the single-document editor', () => {
  assert.equal(AUTOSAVE_DELAY_MS, 1500);
});
