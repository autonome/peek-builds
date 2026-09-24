/**
 * Unit tests for the pure todo item decisions.
 *
 * Run via: node --test tests/unit/todo-items.test.js
 * (leaf module — no DOM/electron deps, imported directly.)
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'features', 'todo', 'todo-items.js');
const { matchTodos, sortNewestFirst, todosListResult, pickDoneTarget } = await import(modulePath);

const item = (id, fields = {}) => ({ id, title: id, content: '', updatedAt: '2026-01-01T00:00:00Z', ...fields });

describe('matchTodos', () => {
  it('matches on the title, case-insensitively', () => {
    const items = [item('a', { title: 'Buy Milk' }), item('b', { title: 'Call bank' })];
    assert.deepEqual(matchTodos(items, 'milk').map(i => i.id), ['a']);
    assert.deepEqual(matchTodos(items, 'MILK').map(i => i.id), ['a']);
  });

  it('matches on the content when the title does not', () => {
    const items = [item('a', { title: 'Errand', content: 'pick up the Parcel' })];
    assert.deepEqual(matchTodos(items, 'parcel').map(i => i.id), ['a']);
  });

  it('keeps everything for a blank needle', () => {
    const items = [item('a'), item('b'), item('c')];
    assert.deepEqual(matchTodos(items, '').map(i => i.id), ['a', 'b', 'c']);
    assert.deepEqual(matchTodos(items, '   ').map(i => i.id), ['a', 'b', 'c']);
    assert.deepEqual(matchTodos(items, null).map(i => i.id), ['a', 'b', 'c']);
  });

  it('preserves input order among the matches', () => {
    const items = [
      item('a', { title: 'write spec' }),
      item('b', { title: 'nothing here' }),
      item('c', { title: 'write test' })
    ];
    assert.deepEqual(matchTodos(items, 'write').map(i => i.id), ['a', 'c']);
  });

  it('returns nothing when no item contains the needle', () => {
    assert.deepEqual(matchTodos([item('a', { title: 'x' })], 'zzz'), []);
  });
});

describe('sortNewestFirst', () => {
  it('orders by updatedAt descending', () => {
    const items = [
      item('old', { updatedAt: '2026-01-01T00:00:00Z' }),
      item('new', { updatedAt: '2026-03-01T00:00:00Z' }),
      item('mid', { updatedAt: '2026-02-01T00:00:00Z' })
    ];
    assert.deepEqual(sortNewestFirst(items).map(i => i.id), ['new', 'mid', 'old']);
  });

  it('does not mutate its input', () => {
    const items = [
      item('old', { updatedAt: '2026-01-01T00:00:00Z' }),
      item('new', { updatedAt: '2026-03-01T00:00:00Z' })
    ];
    const sorted = sortNewestFirst(items);
    assert.deepEqual(items.map(i => i.id), ['old', 'new']);
    assert.notEqual(sorted, items);
  });
});

describe('todosListResult', () => {
  it('reports failure with no items, and no output data', () => {
    const result = todosListResult([]);
    assert.equal(result.success, false);
    assert.equal(result.message, 'No outstanding todos');
    assert.equal(result.output, undefined);
  });

  it('titles a single item in the singular', () => {
    const result = todosListResult([item('a')]);
    assert.equal(result.success, true);
    assert.equal(result.output.title, '1 todo');
    assert.equal(result.output.mimeType, 'item');
    assert.deepEqual(result.output.data.map(i => i.id), ['a']);
  });

  it('titles several items with their count, newest first', () => {
    const items = [
      item('old', { updatedAt: '2026-01-01T00:00:00Z' }),
      item('new', { updatedAt: '2026-03-01T00:00:00Z' }),
      item('mid', { updatedAt: '2026-02-01T00:00:00Z' })
    ];
    const result = todosListResult(items);
    assert.equal(result.success, true);
    assert.equal(result.output.title, '3 todos');
    assert.deepEqual(result.output.data.map(i => i.id), ['new', 'mid', 'old']);
  });
});

describe('pickDoneTarget', () => {
  const items = [item('a', { title: 'write spec' }), item('b', { title: 'call bank' })];

  it('takes the selected item when it carries an id', () => {
    const selectedItem = item('b');
    assert.equal(pickDoneTarget(items, { selectedItem, match: 'write' }), selectedItem);
  });

  it('falls back to the first text match with no selection', () => {
    assert.equal(pickDoneTarget(items, { match: 'bank' }).id, 'b');
  });

  it('falls back to the text match when the selection lacks an id', () => {
    assert.equal(pickDoneTarget(items, { selectedItem: { title: 'call bank' }, match: 'write' }).id, 'a');
  });

  it('returns null when nothing matches', () => {
    assert.equal(pickDoneTarget(items, { match: 'zzz' }), null);
    assert.equal(pickDoneTarget([], {}), null);
  });
});
