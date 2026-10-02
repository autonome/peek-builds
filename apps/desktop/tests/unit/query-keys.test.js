/**
 * Unit tests for the tag-query block keys (features/editor/query-keys.js).
 * Pure function, no DOM.
 * Run via: NODE_ENV=test node --test tests/unit/query-keys.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { queryKey, isEditClick, navCaret, attachQueryKeys } from '../../features/editor/query-keys.js';

describe('isEditClick', () => {
  // A target whose closest() matches when the selector lists `cls`.
  const target = (cls) => ({ closest: (sel) => (cls && sel.split(', ').includes(cls) ? {} : null) });

  it('a plain click on block content edits', () => {
    assert.equal(isEditClick({ button: 0, target: target(null) }), true);
  });

  it('clicks on the left column, links, folds and the open editor do not', () => {
    for (const cls of ['.qs-block-left', '.qs-link', '.qs-fold', 'a', 'button', '.cm-editor']) {
      assert.equal(isEditClick({ button: 0, target: target(cls) }), false, cls);
    }
  });

  it('other buttons, modifiers, a text selection or a prevented click do not', () => {
    assert.equal(isEditClick({ button: 2, target: target(null) }), false);
    assert.equal(isEditClick({ button: 0, metaKey: true, target: target(null) }), false);
    assert.equal(isEditClick({ button: 0, shiftKey: true, target: target(null) }), false);
    assert.equal(isEditClick({ button: 0, defaultPrevented: true, target: target(null) }), false);
    assert.equal(isEditClick({ button: 0, target: target(null) }, true), false);
  });
});

const state = (over = {}) => ({
  selectedIndex: 0,
  blockCount: 3,
  folded: new Set(),
  pendingZ: false,
  ...over,
});

/** Feed keys in order, carrying the state; returns the final state. */
function press(keys, start = state()) {
  let s = start;
  for (const key of keys) {
    const next = queryKey(key, s);
    s = next || { ...s, pendingZ: false };
  }
  return s;
}

describe('queryKey: selection', () => {
  it('j and ArrowDown move down, k and ArrowUp move up', () => {
    assert.equal(queryKey('j', state()).selectedIndex, 1);
    assert.equal(queryKey('ArrowDown', state()).selectedIndex, 1);
    assert.equal(queryKey('k', state({ selectedIndex: 2 })).selectedIndex, 1);
    assert.equal(queryKey('ArrowUp', state({ selectedIndex: 2 })).selectedIndex, 1);
  });

  it('clamps at the first and last block', () => {
    assert.equal(queryKey('k', state()).selectedIndex, 0);
    assert.equal(queryKey('j', state({ selectedIndex: 2 })).selectedIndex, 2);
  });

  it('handles an empty document without moving', () => {
    const empty = state({ selectedIndex: -1, blockCount: 0 });
    assert.equal(queryKey('j', empty).selectedIndex, -1);
    assert.equal(queryKey('k', empty).selectedIndex, -1);
    assert.equal(press(['z', 'M'], empty).folded.size, 0);
    assert.equal(press(['z', 'a'], empty).folded.size, 0);
  });

  it('does not change the input state', () => {
    const s = state();
    queryKey('j', s);
    assert.equal(s.selectedIndex, 0);
  });
});

describe('queryKey: folding', () => {
  it('zc folds and zo unfolds the selected block', () => {
    const s = press(['j', 'z', 'c']);
    assert.deepEqual([...s.folded], [1]);
    assert.equal(press(['z', 'o'], s).folded.size, 0);
  });

  it('za toggles, twice returning to the start', () => {
    const once = press(['z', 'a']);
    assert.deepEqual([...once.folded], [0]);
    assert.equal(press(['z', 'a'], once).folded.size, 0);
  });

  it('zM folds every block and zR unfolds them', () => {
    const all = press(['z', 'M']);
    assert.deepEqual([...all.folded].sort(), [0, 1, 2]);
    assert.equal(press(['z', 'R'], all).folded.size, 0);
  });

  it('keeps the selection while folding', () => {
    assert.equal(press(['j', 'j', 'z', 'M']).selectedIndex, 2);
  });

  it('needs the z first: c, o, a, M, R alone do nothing', () => {
    for (const key of ['c', 'o', 'a', 'M', 'R']) assert.equal(queryKey(key, state()), null);
  });

  it('a key after z that is not a fold key ends the prefix', () => {
    assert.equal(queryKey('x', state({ pendingZ: true })), null);
    assert.equal(queryKey('j', state({ pendingZ: true })), null);
  });

  it('zz keeps waiting for the second key', () => {
    assert.equal(queryKey('z', state({ pendingZ: true })).pendingZ, true);
  });

  it('z alone only arms the prefix', () => {
    const s = queryKey('z', state());
    assert.equal(s.pendingZ, true);
    assert.equal(s.folded.size, 0);
  });
});

describe('queryKey: other keys', () => {
  it('returns null for unknown keys', () => {
    for (const key of ['x', 'Enter', 'Escape', 'h', 'l', 'a']) {
      assert.equal(queryKey(key, state()), null);
    }
  });
});

describe('navCaret', () => {
  it('down keys put the caret at the start, up keys at the end', () => {
    assert.equal(navCaret('j'), 'start');
    assert.equal(navCaret('ArrowDown'), 'start');
    assert.equal(navCaret('k'), 'end');
    assert.equal(navCaret('ArrowUp'), 'end');
  });
  it('other keys do not open anything', () => {
    for (const key of ['J', 'K', 'z', 'o', 'Enter']) assert.equal(navCaret(key), null);
  });
});

describe('attachQueryKeys: selecting by key opens the editor', () => {
  const makeSurface = (count, start) => {
    let selected = start;
    return {
      selectedIndex: () => selected,
      blockCount: () => count,
      isFolded: () => false,
      select: (i) => { selected = i; },
      revealSelected: () => {},
      fold: () => {},
      unfold: () => {},
    };
  };
  const press = (key, surface) => {
    const opened = [];
    const inline = { isOpen: () => false, open: (i, opts) => opened.push([i, opts.caretAtEnd]) };
    let handler;
    const doc = { addEventListener: (_, fn) => { handler = fn; }, removeEventListener() {} };
    attachQueryKeys(surface, doc, inline);
    handler({ key, target: { tagName: 'DIV' }, preventDefault() {} });
    return opened;
  };
  it('j and ArrowDown open the next block with the caret at the start', () => {
    assert.deepEqual(press('j', makeSurface(3, 0)), [[1, false]]);
    assert.deepEqual(press('ArrowDown', makeSurface(3, 1)), [[2, false]]);
  });
  it('k and ArrowUp open the previous block with the caret at the end', () => {
    assert.deepEqual(press('k', makeSurface(3, 2)), [[1, true]]);
    assert.deepEqual(press('ArrowUp', makeSurface(3, 1)), [[0, true]]);
  });
  it('nothing opens without blocks', () => {
    assert.deepEqual(press('j', makeSurface(0, -1)), []);
  });
});
