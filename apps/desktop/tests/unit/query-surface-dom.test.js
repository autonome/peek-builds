/**
 * Unit tests for the DOM block surface's selection and fold state.
 *
 * Run via: node --test tests/unit/query-surface-dom.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'features', 'editor', 'query-surface-dom.js');
const { createBlockState, blockTitle } = await import(modulePath);

describe('createBlockState selection', () => {
  it('starts on the first block', () => {
    assert.equal(createBlockState(3).selectedIndex(), 0);
  });
  it('clamps at both ends', () => {
    const s = createBlockState(3);
    s.select(99);
    assert.equal(s.selectedIndex(), 2);
    s.select(-5);
    assert.equal(s.selectedIndex(), 0);
  });
  it('reports each change once with the previous index', () => {
    const calls = [];
    const s = createBlockState(3, { onSelect: (n, p) => calls.push([n, p]) });
    s.select(1);
    s.select(1);
    s.select(2);
    assert.deepEqual(calls, [[1, 0], [2, 1]]);
  });
  it('ignores non-numeric input', () => {
    const s = createBlockState(3);
    s.select(NaN);
    assert.equal(s.selectedIndex(), 0);
  });
  it('has no selection when empty', () => {
    const s = createBlockState(0);
    assert.equal(s.selectedIndex(), -1);
    s.select(0);
    s.fold(0);
    s.foldAll();
    assert.equal(s.selectedIndex(), -1);
    assert.equal(s.blockCount(), 0);
  });
});

describe('createBlockState folding', () => {
  it('folds and unfolds one block', () => {
    const s = createBlockState(3);
    s.fold(1);
    assert.equal(s.isFolded(1), true);
    assert.equal(s.isFolded(0), false);
    s.unfold(1);
    assert.equal(s.isFolded(1), false);
  });
  it('folds the selected block', () => {
    const s = createBlockState(3);
    s.select(2);
    s.fold(s.selectedIndex());
    assert.equal(s.isFolded(2), true);
    assert.equal(s.isFolded(0), false);
  });
  it('foldAll then unfoldAll', () => {
    const s = createBlockState(4);
    s.foldAll();
    assert.deepEqual([0, 1, 2, 3].map(i => s.isFolded(i)), [true, true, true, true]);
    s.unfoldAll();
    assert.deepEqual([0, 1, 2, 3].map(i => s.isFolded(i)), [false, false, false, false]);
  });
  it('reports only blocks whose state changed', () => {
    const calls = [];
    const s = createBlockState(3, { onFold: (i, f) => calls.push([i, f]) });
    s.fold(1);
    s.foldAll();
    assert.deepEqual(calls, [[1, true], [0, true], [2, true]]);
  });
  it('clamps an out-of-range fold index', () => {
    const s = createBlockState(2);
    s.fold(10);
    assert.equal(s.isFolded(1), true);
  });
});

describe('blockTitle', () => {
  it('prefers the title, then the first content line without heading marker, then url', () => {
    assert.equal(blockTitle({ title: 'T', content: '# C' }), 'T');
    assert.equal(blockTitle({ content: '\n## Heading\nbody' }), 'Heading');
    assert.equal(blockTitle({ url: 'https://x.test' }), 'https://x.test');
    assert.equal(blockTitle({}), 'Untitled');
  });
});
