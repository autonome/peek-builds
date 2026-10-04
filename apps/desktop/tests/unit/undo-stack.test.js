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

describe('delete key and delete undo entry', () => {
  const surface = {
    selectedIndex: () => 1,
    blockCount: () => 3,
    isFolded: () => false,
    select() {},
    revealSelected() {},
    fold() {},
    unfold() {},
  };
  const attach = (actions, s = surface) => {
    let handler;
    const doc = { addEventListener: (_, fn) => { handler = fn; }, removeEventListener() {} };
    attachQueryKeys(s, doc, { isOpen: () => false, open() {} }, actions);
    return (key, extra = {}) => handler({ key, target: { tagName: 'DIV' }, preventDefault() {}, ...extra });
  };

  it('d removes the selected block; a tag action declaring d wins', () => {
    const removed = [];
    attach({ remove: (i) => removed.push(i) })('d');
    assert.deepEqual(removed, [1]);

    const removed2 = [];
    attach({ remove: (i) => removed2.push(i), tagKey: (k) => k === 'd' })('d');
    assert.deepEqual(removed2, []);
  });

  it('d does nothing with no selection, after z, or with a modifier', () => {
    const removed = [];
    attach({ remove: (i) => removed.push(i) }, { ...surface, selectedIndex: () => -1 })('d');
    const press = attach({ remove: (i) => removed.push(i) });
    press('z');
    press('d');
    press('d', { metaKey: true });
    assert.deepEqual(removed, []);
  });

  it('a delete entry keeps the item id and the previous order for undo', () => {
    const s = createUndoStack();
    s.push({ kind: 'delete', itemId: 'i1', previousOrder: ['a', 'i1', 'b'] });
    const entry = s.pop();
    assert.equal(entry.kind, 'delete');
    assert.equal(entry.itemId, 'i1');
    assert.deepEqual(entry.previousOrder, ['a', 'i1', 'b']);
  });
});
