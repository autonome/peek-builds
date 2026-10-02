/**
 * Unit tests for the pure tag-query helpers.
 *
 * Run via: node --test tests/unit/tag-query.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'renderer', 'cmd', 'tag-query.js');
const { parseTagQuery, queryKey, queryWindowKey, intersectItems } = await import(modulePath);

describe('parseTagQuery', () => {
  it('returns names for all-tag input', () => {
    assert.deepEqual(parseTagQuery('#todo #today'), ['todo', 'today']);
  });
  it('accepts a single tag', () => {
    assert.deepEqual(parseTagQuery('#todo'), ['todo']);
  });
  it('returns null for mixed input', () => {
    assert.equal(parseTagQuery('#todo groceries'), null);
    assert.equal(parseTagQuery('groceries'), null);
  });
  it('returns null for a bare #', () => {
    assert.equal(parseTagQuery('#'), null);
    assert.equal(parseTagQuery('#todo #'), null);
  });
  it('returns null for empty input', () => {
    assert.equal(parseTagQuery(''), null);
    assert.equal(parseTagQuery('   '), null);
    assert.equal(parseTagQuery(undefined), null);
  });
  it('de-duplicates case-insensitively keeping the first spelling', () => {
    assert.deepEqual(parseTagQuery('#Todo #todo #TODO #a'), ['Todo', 'a']);
  });
  it('tolerates extra whitespace', () => {
    assert.deepEqual(parseTagQuery('  #a   #b '), ['a', 'b']);
  });
});

describe('queryKey', () => {
  it('is independent of order and case', () => {
    assert.equal(queryKey(['Today', 'todo']), queryKey(['TODO', 'today']));
    assert.equal(queryKey(['b', 'a']), 'a,b');
  });
  it('de-duplicates', () => {
    assert.equal(queryKey(['a', 'A', 'b']), 'a,b');
  });
});

describe('queryWindowKey', () => {
  it('prefixes the key', () => {
    assert.equal(queryWindowKey(['today', 'Todo']), 'editor-query-today,todo');
    assert.equal(queryWindowKey(['todo', 'today']), queryWindowKey(['Today', 'TODO']));
  });
});

describe('intersectItems', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  const c = { id: 'c' };
  it('returns empty for no lists or empty lists', () => {
    assert.deepEqual(intersectItems([]), []);
    assert.deepEqual(intersectItems([[]]), []);
    assert.deepEqual(intersectItems([[a], []]), []);
  });
  it('returns the list itself for one list', () => {
    assert.deepEqual(intersectItems([[a, b]]), [a, b]);
  });
  it('returns empty for disjoint lists', () => {
    assert.deepEqual(intersectItems([[a], [b]]), []);
  });
  it('keeps overlapping items in first-list order', () => {
    assert.deepEqual(intersectItems([[c, a, b], [b, c], [c, b, a]]), [c, b]);
  });
});
