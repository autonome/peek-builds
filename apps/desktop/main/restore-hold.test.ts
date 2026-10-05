// The lazy-restore partition rule (which snapshot windows open at startup and
// which wait for the user to arrive on their recorded desktop), against the
// real implementation — the module is electron-free, so no mirroring.
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { partitionRestoreByDesktop } from './restore-hold.js';

const d = (id: number, desktop?: string) =>
  desktop === undefined ? { id } : { id, desktop };

const ids = (list: ReadonlyArray<{ id: number }>) => list.map((w) => w.id);

describe('partitionRestoreByDesktop (lazy-restore open-now vs held split)', () => {
  it('a window recorded on the current desktop opens now', () => {
    const { openNow, held } = partitionRestoreByDesktop([d(1, '2')], '2', ['1', '2']);
    assert.deepStrictEqual(ids(openNow), [1]);
    assert.strictEqual(held.size, 0);
  });

  it('a window recorded on another desktop is held under that desktop', () => {
    const { openNow, held } = partitionRestoreByDesktop([d(1, '3')], '1', ['1', '3']);
    assert.deepStrictEqual(ids(openNow), []);
    assert.deepStrictEqual([...held.keys()], ['3']);
    assert.deepStrictEqual(ids(held.get('3')!), [1]);
  });

  it('a window with no recorded desktop opens now', () => {
    const { openNow, held } = partitionRestoreByDesktop([d(1)], '1', ['1', '3']);
    assert.deepStrictEqual(ids(openNow), [1]);
    assert.strictEqual(held.size, 0);
  });

  it('a recorded desktop no longer in the layout opens now', () => {
    const { openNow, held } = partitionRestoreByDesktop([d(1, '9')], '1', ['1', '3']);
    assert.deepStrictEqual(ids(openNow), [1]);
    assert.strictEqual(held.size, 0);
  });

  it('no current desktop known opens everything now', () => {
    const { openNow, held } = partitionRestoreByDesktop(
      [d(1, '3'), d(2), d(3, '1')],
      null,
      ['1', '3'],
    );
    assert.deepStrictEqual(ids(openNow), [1, 2, 3]);
    assert.strictEqual(held.size, 0);
  });

  it('held windows group by desktop, preserving snapshot order in each group', () => {
    const { openNow, held } = partitionRestoreByDesktop(
      [d(1, '3'), d(2, '5'), d(3, '3'), d(4, '5'), d(5, '3')],
      '1',
      ['1', '3', '5'],
    );
    assert.deepStrictEqual(ids(openNow), []);
    assert.deepStrictEqual([...held.keys()], ['3', '5']);
    assert.deepStrictEqual(ids(held.get('3')!), [1, 3, 5]);
    assert.deepStrictEqual(ids(held.get('5')!), [2, 4]);
  });

  it('a mixed snapshot splits per rule and openNow keeps snapshot order', () => {
    const { openNow, held } = partitionRestoreByDesktop(
      [d(1, '3'), d(2, '1'), d(3), d(4, '9'), d(5, '3')],
      '1',
      ['1', '3'],
    );
    assert.deepStrictEqual(ids(openNow), [2, 3, 4]);
    assert.deepStrictEqual([...held.keys()], ['3']);
    assert.deepStrictEqual(ids(held.get('3')!), [1, 5]);
  });

  it('an empty snapshot yields nothing to open and nothing held', () => {
    const { openNow, held } = partitionRestoreByDesktop([], '1', ['1']);
    assert.deepStrictEqual(ids(openNow), []);
    assert.strictEqual(held.size, 0);
  });

  it('descriptors pass through unchanged, extra fields intact', () => {
    const descriptor = { id: 7, desktop: '3', url: 'https://example.com', focused: true };
    const { held } = partitionRestoreByDesktop([descriptor], '1', ['1', '3']);
    assert.strictEqual(held.get('3')![0], descriptor);
  });
});
