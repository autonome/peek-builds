/**
 * Unit tests for features/editor/sort-options.js
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '../../features/editor/sort-options.js');
const { SORT_OPTIONS, DEFAULT_SORT_OPTION, sortItems } = await import(modulePath);

const items = [
  { id: 'b', title: 'banana', createdAt: 200, updatedAt: 500 },
  { id: 'a', title: 'Apple', createdAt: 300, updatedAt: 100 },
  { id: 'c', title: 'cherry', createdAt: 100, updatedAt: 300 },
];
const ids = (list) => list.map(i => i.id);

describe('SORT_OPTIONS', () => {
  it('lists the five options with labels, default first', () => {
    assert.deepEqual(SORT_OPTIONS.map(o => o.id), ['updated-desc', 'updated-asc', 'created-desc', 'created-asc', 'title-asc']);
    assert.ok(SORT_OPTIONS.every(o => typeof o.label === 'string' && o.label));
    assert.equal(DEFAULT_SORT_OPTION, 'updated-desc');
  });
});

describe('sortItems', () => {
  it('updated-desc', () => assert.deepEqual(ids(sortItems(items, 'updated-desc')), ['b', 'c', 'a']));
  it('updated-asc', () => assert.deepEqual(ids(sortItems(items, 'updated-asc')), ['a', 'c', 'b']));
  it('created-desc', () => assert.deepEqual(ids(sortItems(items, 'created-desc')), ['a', 'b', 'c']));
  it('created-asc', () => assert.deepEqual(ids(sortItems(items, 'created-asc')), ['c', 'b', 'a']));
  it('title-asc ignores case', () => assert.deepEqual(ids(sortItems(items, 'title-asc')), ['a', 'b', 'c']));

  it('title sort strips the heading marker and falls back to content', () => {
    const list = [
      { id: 'x', content: '# zebra\nbody' },
      { id: 'y', content: '\n\n## ant' },
      { id: 'z', title: 'mid' },
    ];
    assert.deepEqual(ids(sortItems(list, 'title-asc')), ['y', 'z', 'x']);
  });

  it('ties keep input order', () => {
    const tied = [{ id: '1', updatedAt: 5 }, { id: '2', updatedAt: 5 }, { id: '3', updatedAt: 5 }];
    assert.deepEqual(ids(sortItems(tied, 'updated-desc')), ['1', '2', '3']);
    assert.deepEqual(ids(sortItems(tied, 'updated-asc')), ['1', '2', '3']);
  });

  it('missing timestamps sort as oldest', () => {
    const list = [{ id: 'n' }, { id: 'o', updatedAt: 10 }, { id: 'p', updatedAt: 20 }];
    assert.deepEqual(ids(sortItems(list, 'updated-desc')), ['p', 'o', 'n']);
    assert.deepEqual(ids(sortItems(list, 'updated-asc')), ['n', 'o', 'p']);
  });

  it('accepts date strings as timestamps', () => {
    const list = [{ id: 'old', updatedAt: '2020-01-01T00:00:00Z' }, { id: 'new', updatedAt: '2024-01-01T00:00:00Z' }];
    assert.deepEqual(ids(sortItems(list, 'updated-desc')), ['new', 'old']);
  });

  it('unknown id falls back to updated-desc', () => {
    assert.deepEqual(ids(sortItems(items, 'nope')), ids(sortItems(items, 'updated-desc')));
    assert.deepEqual(ids(sortItems(items, undefined)), ids(sortItems(items, 'updated-desc')));
  });

  it('returns a copy and does not mutate the input', () => {
    const input = items.slice();
    const out = sortItems(input, 'title-asc');
    assert.notEqual(out, input);
    assert.deepEqual(ids(input), ['b', 'a', 'c']);
  });
});
