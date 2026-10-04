/**
 * Unit tests for the tag-query undo stack (features/editor/undo-stack.js) and
 * the undo keys in query-keys.js attachQueryKeys.
 * Run via: NODE_ENV=test node --test tests/unit/undo-stack.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createUndoStack, inverseAffordance, UNDO_LIMIT } from '../../features/editor/undo-stack.js';
import { attachQueryKeys } from '../../features/editor/query-keys.js';

describe('createUndoStack', () => {
  it('pops entries last in, first out, and null when empty', () => {
    const s = createUndoStack();
    s.push({ kind: 'move', previousOrder: ['a'] });
    s.push({ kind: 'move', previousOrder: ['b'] });
    assert.deepEqual(s.pop().previousOrder, ['b']);
    assert.deepEqual(s.pop().previousOrder, ['a']);
    assert.equal(s.pop(), null);
  });

  it('keeps at most 50 entries, dropping the oldest', () => {
    assert.equal(UNDO_LIMIT, 50);
    const s = createUndoStack();
    for (let i = 0; i < 60; i++) s.push({ kind: 'move', previousOrder: [String(i)] });
    assert.equal(s.size(), 50);
    assert.deepEqual(s.peek().previousOrder, ['59']);
    let last;
    for (let e; (e = s.pop()); ) last = e;
    assert.deepEqual(last.previousOrder, ['10']);
  });

  it('clear empties it', () => {
    const s = createUndoStack();
    s.push({ kind: 'move', previousOrder: [] });
    s.clear();
    assert.equal(s.size(), 0);
  });
});

describe('inverseAffordance', () => {
  it('carries the state the action moved to, so triggering it flips back', () => {
    const aff = { ruleId: 'r', activeTag: 'todo', completedTag: 'done', checked: false };
    const inv = inverseAffordance({ affordance: aff, checked: true });
    assert.equal(inv.checked, true);
    assert.equal(inv.activeTag, 'todo');
    assert.equal(aff.checked, false);
  });
});

describe('attachQueryKeys: undo keys', () => {
  const surface = {
    selectedIndex: () => 0,
    blockCount: () => 3,
    isFolded: () => false,
    select() {},
    revealSelected() {},
    fold() {},
    unfold() {},
  };
  const run = (events, undo = () => {}) => {
    let handler;
    const doc = { addEventListener: (_, fn) => { handler = fn; }, removeEventListener() {} };
    attachQueryKeys(surface, doc, { isOpen: () => false, open() {} }, { undo });
    for (const e of events) handler({ target: { tagName: 'DIV' }, preventDefault() {}, ...e });
  };

  it('u and Cmd+Z / Ctrl+Z undo', () => {
    let n = 0;
    run([{ key: 'u' }, { key: 'z', metaKey: true }, { key: 'z', ctrlKey: true }], () => n++);
    assert.equal(n, 3);
  });

  it('Shift+Cmd+Z and a typing target do not', () => {
    let n = 0;
    run([
      { key: 'z', metaKey: true, shiftKey: true },
      { key: 'z', metaKey: true, target: { tagName: 'INPUT' } },
      { key: 'u', target: { tagName: 'TEXTAREA' } },
    ], () => n++);
    assert.equal(n, 0);
  });

  it('bare z stays the fold prefix, and u after z is not undo', () => {
    let n = 0;
    const folded = [];
    const s = { ...surface, fold: (i) => folded.push(i) };
    let handler;
    const doc = { addEventListener: (_, fn) => { handler = fn; }, removeEventListener() {} };
    attachQueryKeys(s, doc, { isOpen: () => false, open() {} }, { undo: () => n++ });
    const press = (key) => handler({ key, target: { tagName: 'DIV' }, preventDefault() {} });
    press('z');
    press('c');
    assert.deepEqual(folded, [0]);
    assert.equal(n, 0);
    press('z');
    press('u');
    assert.equal(n, 0);
  });
});
