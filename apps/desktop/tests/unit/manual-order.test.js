/**
 * Unit tests for features/editor/manual-order.js
 * Run via: NODE_ENV=test node --test tests/unit/manual-order.test.js
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '../../features/editor/manual-order.js');
const { applyManualOrder, moveBlock, ensureOrder, loadOrder, saveOrder, orderStorageKey } = await import(modulePath);

const items = ['a', 'b', 'c', 'd'].map(id => ({ id }));
const ids = (list) => list.map(i => i.id);

/** Minimal in-memory Storage. */
const memory = () => {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) };
};

describe('applyManualOrder', () => {
  it('follows a full list', () => {
    assert.deepEqual(ids(applyManualOrder(items, ['d', 'b', 'a', 'c'])), ['d', 'b', 'a', 'c']);
  });

  it('puts items missing from a partial list first, in input order', () => {
    assert.deepEqual(ids(applyManualOrder(items, ['c', 'a'])), ['b', 'd', 'c', 'a']);
  });

  it('orders the unlisted items with sortFresh', () => {
    const reverse = (list) => list.slice().reverse();
    assert.deepEqual(ids(applyManualOrder(items, ['c'], reverse)), ['d', 'b', 'a', 'c']);
  });

  it('ignores stale and duplicate ids', () => {
    assert.deepEqual(ids(applyManualOrder(items, ['x', 'b', 'b', 'y', 'a'])), ['c', 'd', 'b', 'a']);
  });

  it('keeps input order for an empty or missing list', () => {
    assert.deepEqual(ids(applyManualOrder(items, [])), ['a', 'b', 'c', 'd']);
    assert.deepEqual(ids(applyManualOrder(items, undefined)), ['a', 'b', 'c', 'd']);
  });

  it('does not mutate its inputs', () => {
    const input = items.slice();
    const order = ['d', 'a'];
    applyManualOrder(input, order);
    assert.deepEqual(ids(input), ['a', 'b', 'c', 'd']);
    assert.deepEqual(order, ['d', 'a']);
  });
});

describe('moveBlock', () => {
  const order = ['a', 'b', 'c'];
  it('moves down and up by one', () => {
    assert.deepEqual(moveBlock(order, 'a', 1), ['b', 'a', 'c']);
    assert.deepEqual(moveBlock(order, 'c', -1), ['a', 'c', 'b']);
  });
  it('stops at both ends', () => {
    assert.deepEqual(moveBlock(order, 'a', -1), ['a', 'b', 'c']);
    assert.deepEqual(moveBlock(order, 'c', 1), ['a', 'b', 'c']);
    assert.deepEqual(moveBlock(order, 'a', 10), ['b', 'c', 'a']);
  });
  it('leaves the list alone for an unknown id and returns a copy', () => {
    const out = moveBlock(order, 'zz', 1);
    assert.deepEqual(out, order);
    assert.notEqual(out, order);
  });
});

describe('ensureOrder', () => {
  it('puts new ids first and drops removed ones', () => {
    assert.deepEqual(ensureOrder(['n', 'a', 'b'], ['b', 'gone', 'a']), ['n', 'b', 'a']);
  });
  it('is stable when nothing changed', () => {
    assert.deepEqual(ensureOrder(['a', 'b', 'c'], ['c', 'a', 'b']), ['c', 'a', 'b']);
  });
  it('builds the list from the current order when nothing is stored', () => {
    assert.deepEqual(ensureOrder(['a', 'b'], []), ['a', 'b']);
    assert.deepEqual(ensureOrder(['a', 'b'], undefined), ['a', 'b']);
  });
  it('drops duplicates in the stored list', () => {
    assert.deepEqual(ensureOrder(['a', 'b'], ['b', 'b', 'a']), ['b', 'a']);
  });
});

describe('loadOrder / saveOrder', () => {
  it('round-trips under a key per query', () => {
    const storage = memory();
    saveOrder('a,b', ['x', 'y'], storage);
    saveOrder('c', ['z'], storage);
    assert.deepEqual(loadOrder('a,b', storage), ['x', 'y']);
    assert.deepEqual(loadOrder('c', storage), ['z']);
    assert.deepEqual(loadOrder('other', storage), []);
    assert.notEqual(orderStorageKey('a,b'), orderStorageKey('c'));
  });
  it('treats unreadable stored data as no order', () => {
    const storage = memory();
    storage.setItem(orderStorageKey('q'), '{not json');
    assert.deepEqual(loadOrder('q', storage), []);
    storage.setItem(orderStorageKey('q'), '{"a":1}');
    assert.deepEqual(loadOrder('q', storage), []);
  });
  it('survives a storage that throws', () => {
    const broken = { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); } };
    assert.deepEqual(loadOrder('q', broken), []);
    saveOrder('q', ['a'], broken);
  });
});
