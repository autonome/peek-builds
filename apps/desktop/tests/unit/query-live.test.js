import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffBlocks, liveAction, blockSignature, LIVE_TOPICS } from '../../features/editor/query-live.js';

const item = (id, extra = {}) => ({ id, ...extra });

test('diffBlocks: an item with no block is added', () => {
  const d = diffBlocks(['a'], [item('a'), item('b')]);
  assert.deepEqual(d.added.map(i => i.id), ['b']);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.kept.map(i => i.id), ['a']);
});

test('diffBlocks: a block whose item is gone is removed', () => {
  const d = diffBlocks(['a', 'b'], [item('b')]);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, ['a']);
  assert.deepEqual(d.kept.map(i => i.id), ['b']);
});

test('diffBlocks: kept items carry the new data', () => {
  const d = diffBlocks(['a'], [item('a', { title: 'new' })]);
  assert.equal(d.kept[0].title, 'new');
});

test('diffBlocks: a reorder only changes the order of kept', () => {
  const d = diffBlocks(['a', 'b', 'c'], [item('c'), item('a'), item('b')]);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.kept.map(i => i.id), ['c', 'a', 'b']);
});

test('diffBlocks: empty to non-empty adds everything in order', () => {
  const d = diffBlocks([], [item('b'), item('a')]);
  assert.deepEqual(d.added.map(i => i.id), ['b', 'a']);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.kept, []);
});

test('diffBlocks: non-empty to empty removes everything', () => {
  const d = diffBlocks(['a', 'b'], []);
  assert.deepEqual(d.removed, ['a', 'b']);
  assert.deepEqual(d.added, []);
});

test('liveAction: a changed item updates its block, unless the editor is open', () => {
  assert.equal(liveAction({ open: false }, 'changed'), 'update');
  assert.equal(liveAction({ open: true }, 'changed'), 'keep-editor');
});

test('liveAction: an item that left or was deleted fades, after the editor closes if open', () => {
  assert.equal(liveAction({ open: false }, 'left'), 'freeze-fade');
  assert.equal(liveAction({ open: false }, 'deleted'), 'freeze-fade');
  assert.equal(liveAction({ open: true }, 'left'), 'freeze-fade-on-close');
});

test('liveAction: a deleted item with its editor open closes the editor without saving and fades at once', () => {
  assert.equal(liveAction({ open: true }, 'deleted'), 'drop-edit-freeze-fade');
});

test('liveAction: an unknown change does nothing', () => {
  assert.equal(liveAction({ open: false }, 'other'), 'none');
});

test('blockSignature: differs with the item or its tags', () => {
  const a = blockSignature(item('a', { title: 'x' }), ['todo']);
  assert.equal(a, blockSignature(item('a', { title: 'x' }), ['todo']));
  assert.notEqual(a, blockSignature(item('a', { title: 'y' }), ['todo']));
  assert.notEqual(a, blockSignature(item('a', { title: 'x' }), ['done']));
});

test('LIVE_TOPICS: covers item, tag and rule changes', () => {
  for (const topic of ['item:updated', 'item:deleted', 'item:restored', 'tag:item-added', 'tag:item-removed', 'rules:changed']) {
    assert.ok(LIVE_TOPICS.includes(topic), topic);
  }
});
