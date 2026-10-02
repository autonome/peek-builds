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
  caretLineEdges,
  stickyGoal,
  landingPos,
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
    // A two-line document "abcde\nfghij": positions 0-5 on line 1, 6-11 on line 2.
    const view = (from, to) => ({
      state: {
        selection: { main: { from, to, head: to } },
        doc: { length: 11, lines: 2, lineAt: (pos) => ({ number: pos <= 5 ? 1 : 2 }) },
      },
    });
    assert.equal(up.run(view(8, 8)), false); // second line: ArrowUp moves the caret
    assert.equal(down.run(view(3, 3)), false); // first line: ArrowDown moves the caret
    assert.equal(up.run(view(3, 3)), true); // first line, not at position 0
    assert.equal(down.run(view(8, 8)), true); // last line, not at the end
    assert.equal(up.run(view(1, 3)), false); // a selection stays in the editor
    assert.deepEqual(calls, ['up', 'down']);
  });

  test('an edge handler that does not move leaves the key to the editor', () => {
    const [, up] = inlineKeymap(() => {}, () => false);
    const state = { selection: { main: { from: 0, to: 0, head: 0 } }, doc: { length: 5, lines: 1, lineAt: () => ({ number: 1 }) } };
    assert.equal(up.run({ state }), false);
  });
});

describe('stickyGoal', () => {
  const view = {};
  test('a fresh crossing takes the caret x', () => {
    assert.equal(stickyGoal(null, view, 4, 120), 120);
  });
  test('right after a crossing the earlier goal stays, even if the caret was clamped', () => {
    assert.equal(stickyGoal({ x: 300, view, head: 2 }, view, 2, 40), 300);
  });
  test('any other caret position, or another editor, starts over from the caret x', () => {
    assert.equal(stickyGoal({ x: 300, view, head: 2 }, view, 3, 55), 55);
    assert.equal(stickyGoal({ x: 300, view, head: 2 }, {}, 2, 55), 55);
  });
  test('no measurement means no goal', () => {
    assert.equal(stickyGoal(null, view, 0, null), null);
    assert.equal(stickyGoal(null, view, 0, NaN), null);
  });
});

describe('landingPos', () => {
  const at = (x) => Math.round(x / 10); // 10px per character
  test('without a goal: down lands at the start, up at the end', () => {
    assert.equal(landingPos('down', 20, null, at), 0);
    assert.equal(landingPos('up', 20, null, at), 20);
  });
  test('with a goal: the position at that x on the first (down) or last (up) line', () => {
    const lines = [];
    const posAtX = (x, line) => { lines.push(line); return at(x); };
    assert.equal(landingPos('down', 20, 50, posAtX), 5);
    assert.equal(landingPos('up', 20, 0, posAtX), 0);
    assert.deepEqual(lines, ['first', 'last']);
  });
  test('the result stays inside the text', () => {
    assert.equal(landingPos('down', 3, 500, at), 3);
    assert.equal(landingPos('up', 3, 0, () => -4), 0);
  });
  test('an unmeasurable line falls back to the start or end', () => {
    assert.equal(landingPos('down', 9, 50, () => null), 0);
    assert.equal(landingPos('up', 9, 50, () => null), 9);
  });
});

describe('isAtEdge', () => {
  test('up needs the first visual line, down the last', () => {
    assert.equal(isAtEdge('up', { from: 2, to: 2 }, true, false), true);
    assert.equal(isAtEdge('up', { from: 2, to: 2 }, false, true), false);
    assert.equal(isAtEdge('down', { from: 2, to: 2 }, false, true), true);
    assert.equal(isAtEdge('down', { from: 2, to: 2 }, true, false), false);
  });

  test('a selection is never an edge', () => {
    assert.equal(isAtEdge('up', { from: 0, to: 3 }, true, true), false);
    assert.equal(isAtEdge('down', { from: 2, to: 5 }, true, true), false);
  });

  test('a single-line document is both edges', () => {
    assert.equal(isAtEdge('up', { from: 0, to: 0 }, true, true), true);
    assert.equal(isAtEdge('down', { from: 0, to: 0 }, true, true), true);
  });
});

describe('caretLineEdges', () => {
  const doc = { length: 11, lines: 2, lineAt: (pos) => ({ number: pos <= 5 ? 1 : 2 }) };
  const view = (head, coordsAtPos) => ({ state: { doc, selection: { main: { head } } }, coordsAtPos });

  test('without geometry the document lines decide', () => {
    assert.deepEqual(caretLineEdges(view(3, () => null)), { first: true, last: false });
    assert.deepEqual(caretLineEdges(view(8, () => null)), { first: false, last: true });
  });

  test('wrapped lines count as separate visual lines', () => {
    // One logical line wrapped onto three rows of height 20; the caret is on the middle row.
    const rows = (pos) => (pos === 0 ? { top: 0, bottom: 20 } : pos === 11 ? { top: 40, bottom: 60 } : { top: 20, bottom: 40 });
    assert.deepEqual(caretLineEdges(view(5, rows)), { first: false, last: false });
    assert.deepEqual(caretLineEdges(view(0, rows)), { first: true, last: false });
    assert.deepEqual(caretLineEdges(view(11, rows)), { first: false, last: true });
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
