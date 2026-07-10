/**
 * Unit tests for the focus-recency ledger in focus-order.ts.
 *
 * Tests the real, Electron-free exports: noteWindowFocus, getFocusOrder,
 * clearFocusOrder.
 *
 * The counter is module-global and monotonic across this whole file, so
 * every test case uses fresh, unique window ids and asserts only RELATIVE
 * ordering — never an absolute focus-order value.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { noteWindowFocus, getFocusOrder, clearFocusOrder } from './focus-order.js';

describe('Focus-recency ledger', () => {
  it('a never-focused id returns 0', () => {
    assert.strictEqual(getFocusOrder(100001), 0);
  });

  it('focusing three distinct ids yields strictly increasing, distinct, positive orders', () => {
    noteWindowFocus(100010);
    noteWindowFocus(100011);
    noteWindowFocus(100012);

    const a = getFocusOrder(100010);
    const b = getFocusOrder(100011);
    const c = getFocusOrder(100012);

    assert.ok(a > 0);
    assert.ok(b > 0);
    assert.ok(c > 0);
    assert.ok(a < b);
    assert.ok(b < c);
  });

  it('re-focusing an earlier id makes it the most recent of the set', () => {
    noteWindowFocus(100020);
    noteWindowFocus(100021);
    noteWindowFocus(100022);

    // Re-focus the first id — it should now outrank the other two.
    noteWindowFocus(100020);

    const a = getFocusOrder(100020);
    const b = getFocusOrder(100021);
    const c = getFocusOrder(100022);

    assert.ok(a > b);
    assert.ok(a > c);
  });

  it('focused web pages outrank never-focused editor tiles (the bug this fixes)', () => {
    const webPageA = 100030;
    const webPageB = 100031;
    const editorTile1 = 100032;
    const editorTile2 = 100033;
    const editorTile3 = 100034;

    // Only the two web pages were ever focused; the editor tiles never were.
    noteWindowFocus(webPageA);
    noteWindowFocus(webPageB);

    const ids = [webPageA, webPageB, editorTile1, editorTile2, editorTile3];
    const sorted = [...ids].sort((x, y) => getFocusOrder(y) - getFocusOrder(x));

    // The two focused web pages sort first (in either relative order between
    // themselves), and the three never-focused editor tiles — tied at 0 —
    // sort last.
    assert.deepStrictEqual(new Set(sorted.slice(0, 2)), new Set([webPageA, webPageB]));
    assert.deepStrictEqual(
      new Set(sorted.slice(2)),
      new Set([editorTile1, editorTile2, editorTile3])
    );
    for (const tileId of [editorTile1, editorTile2, editorTile3]) {
      assert.strictEqual(getFocusOrder(tileId), 0);
    }
  });

  it('clearFocusOrder drops a previously-focused id back to 0', () => {
    const id = 100040;
    noteWindowFocus(id);
    assert.ok(getFocusOrder(id) > 0);

    clearFocusOrder(id);
    assert.strictEqual(getFocusOrder(id), 0);
  });
});
