import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newItemPlan, buildTagIndex, shouldDiscard } from '../../features/editor/query-add-item.js';

const tags = buildTagIndex([
  { id: 't1', name: 'todo' },
  { id: 't2', name: 'Today' },
  { id: 't3', name: 'work' },
]);

test('newItemPlan: every tag resolved gives an empty text item and all tag ids', () => {
  const plan = newItemPlan(['todo', 'today'], tags);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.item, { type: 'text', options: { content: '', title: '' } });
  assert.deepEqual(plan.tagIds, ['t1', 't2']);
  assert.deepEqual(plan.unresolved, []);
});

test('newItemPlan: an unresolved tag is reported and nothing is planned', () => {
  const plan = newItemPlan(['todo', 'nope'], tags);
  assert.equal(plan.ok, false);
  assert.equal(plan.item, null);
  assert.deepEqual(plan.tagIds, []);
  assert.deepEqual(plan.unresolved, ['nope']);
  assert.match(plan.reason, /#nope is not an existing tag/);
});

test('newItemPlan: several unresolved tags are all named', () => {
  const plan = newItemPlan(['a', 'todo', 'b'], tags);
  assert.deepEqual(plan.unresolved, ['a', 'b']);
  assert.match(plan.reason, /#a #b are not existing tags/);
});

test('newItemPlan: an empty query plans nothing', () => {
  for (const names of [[], undefined, ['']]) {
    const plan = newItemPlan(names, tags);
    assert.equal(plan.ok, false);
    assert.equal(plan.item, null);
    assert.deepEqual(plan.unresolved, []);
  }
});

test('newItemPlan: repeated names, in any case, bind a tag once', () => {
  const plan = newItemPlan(['todo', 'TODO', 'Todo', 'work'], tags);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.tagIds, ['t1', 't3']);
});

test('newItemPlan: accepts a plain object keyed by lower-cased name', () => {
  const plan = newItemPlan(['todo'], { todo: { id: 'x' } });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.tagIds, ['x']);
});

test('buildTagIndex: ignores rows without a name or id', () => {
  const index = buildTagIndex([null, { id: 'a' }, { name: 'b' }, { id: 'c', name: 'C' }]);
  assert.deepEqual([...index.keys()], ['c']);
  assert.deepEqual([...buildTagIndex(undefined).keys()], []);
});

test('shouldDiscard: an empty or blank text item is discarded', () => {
  assert.equal(shouldDiscard({ type: 'text', content: '' }), true);
  assert.equal(shouldDiscard({ type: 'text', content: '  \n ' }), true);
  assert.equal(shouldDiscard({ type: 'text' }), true);
});

test('shouldDiscard: an item with text, or of another type, is kept', () => {
  assert.equal(shouldDiscard({ type: 'text', content: 'x' }), false);
  assert.equal(shouldDiscard({ type: 'url', content: '' }), false);
  assert.equal(shouldDiscard(null), false);
});
