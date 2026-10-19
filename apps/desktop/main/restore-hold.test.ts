// The lazy-restore partition rule (which snapshot windows open at startup and
// which wait for the user to arrive on their recorded desktop), against the
// real implementation — the module is electron-free, so no mirroring.
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { partitionRestoreByDesktop, planLazyRestore, mergeHeldIntoSave, planReleaseFocus, noteDesktopSwitch, shouldReadDesktopBeforeRestore } from './restore-hold.js';

describe('shouldReadDesktopBeforeRestore', () => {
  it('reads when the current desktop is unknown and reads are possible', () => {
    assert.strictEqual(shouldReadDesktopBeforeRestore(null, true), true);
  });
  it('does not read when the current desktop is already known', () => {
    assert.strictEqual(shouldReadDesktopBeforeRestore('2', true), false);
  });
  it('does not read when reads are not possible (headless, tests, no provider)', () => {
    assert.strictEqual(shouldReadDesktopBeforeRestore(null, false), false);
  });
});

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

const f = (id: number, desktop: string | undefined, zOrder: number, focused: boolean) => ({
  id,
  ...(desktop === undefined ? {} : { desktop }),
  zOrder,
  focused,
});

describe('planLazyRestore (partition + held-focus promotion)', () => {
  it('focused descriptor held → top-of-stack openNow window takes focus, as a copy', () => {
    const low = f(1, '1', 1, false);
    const top = f(2, undefined, 9, false);
    const heldFocused = f(3, '3', 5, true);
    const { openNow, held } = planLazyRestore([low, top, heldFocused], '1', ['1', '3']);
    assert.deepStrictEqual(ids(openNow), [1, 2]);
    const promoted = openNow.find((w) => w.id === 2)!;
    assert.strictEqual(promoted.focused, true);
    assert.notStrictEqual(promoted, top); // copy — the snapshot object is untouched
    assert.strictEqual(top.focused, false);
    assert.strictEqual(openNow.find((w) => w.id === 1)!.focused, false);
    // the held descriptor keeps its own focus for when its group opens
    assert.strictEqual(held.get('3')![0].focused, true);
  });

  it('focused descriptor opens now → nothing is promoted', () => {
    const openFocused = f(1, '1', 1, true);
    const heldOne = f(2, '3', 9, false);
    const { openNow } = planLazyRestore([openFocused, heldOne], '1', ['1', '3']);
    assert.strictEqual(openNow[0], openFocused);
  });

  it('no focused descriptor anywhere → nothing is promoted', () => {
    const { openNow } = planLazyRestore([f(1, '1', 1, false), f(2, '3', 9, false)], '1', ['1', '3']);
    assert.strictEqual(openNow.every((w) => w.focused === false), true);
  });

  it('everything held → openNow stays empty (no window to promote)', () => {
    const { openNow, held } = planLazyRestore([f(1, '3', 1, true)], '1', ['1', '3']);
    assert.deepStrictEqual(openNow, []);
    assert.strictEqual(held.get('3')![0].focused, true);
  });

  it('no current desktop → everything opens now with flags untouched', () => {
    const a = f(1, '3', 1, true);
    const { openNow, held } = planLazyRestore([a], null, ['1', '3']);
    assert.strictEqual(openNow[0], a);
    assert.strictEqual(held.size, 0);
  });
});

describe('planReleaseFocus (which released window takes focus)', () => {
  it('the snapshot-focused window wins', () => {
    assert.deepStrictEqual(planReleaseFocus([5, 6, 7], 6, true), { id: 6, reason: 'snapshot-focused' });
  });

  it('no focused marker → the frontmost released window (first opened)', () => {
    assert.deepStrictEqual(planReleaseFocus([5, 6, 7], null, true), { id: 5, reason: 'frontmost' });
  });

  it('app inactive or headless → no focus, even with a focused marker', () => {
    assert.deepStrictEqual(planReleaseFocus([5, 6], 6, false), { id: null, reason: 'not-active' });
  });

  it('nothing opened → no focus', () => {
    assert.deepStrictEqual(planReleaseFocus([], null, true), { id: null, reason: 'none-opened' });
  });
});

describe('noteDesktopSwitch (was the app active as the switch began)', () => {
  it('a new switch notice records appActive from that notification', () => {
    const next = noteDesktopSwitch({ switchesSeen: 0, activeAtSwitch: false }, { desktopSwitchCount: 1, appActive: true });
    assert.deepStrictEqual(next, { switchesSeen: 1, activeAtSwitch: true });
  });

  it('the resign that follows the notice does not overwrite the recorded value', () => {
    const next = noteDesktopSwitch({ switchesSeen: 1, activeAtSwitch: true }, { desktopSwitchCount: 1, appActive: false });
    assert.deepStrictEqual(next, { switchesSeen: 1, activeAtSwitch: true });
  });

  it('a switch noticed while the app was inactive records false', () => {
    const next = noteDesktopSwitch({ switchesSeen: 1, activeAtSwitch: true }, { desktopSwitchCount: 2, appActive: false });
    assert.deepStrictEqual(next, { switchesSeen: 2, activeAtSwitch: false });
  });
});

describe('mergeHeldIntoSave (held descriptors fold back into a save)', () => {
  it('appends held descriptors after the live set', () => {
    const live = [f(1, undefined, 1, false)];
    const held = [f(2, '3', 2, false), f(3, '5', 3, false)];
    assert.deepStrictEqual(ids(mergeHeldIntoSave(live, held)), [1, 2, 3]);
  });

  it('live focus wins: a held focused flag is demoted when the live set has one', () => {
    const live = [f(1, undefined, 1, true)];
    const held = [f(2, '3', 2, true)];
    const merged = mergeHeldIntoSave(live, held);
    assert.strictEqual(merged.filter((w) => w.focused === true).length, 1);
    assert.strictEqual(merged.find((w) => w.id === 2)!.focused, false);
    assert.strictEqual(held[0].focused, true); // demotion is on a copy
  });

  it('held focus survives when the live set has none', () => {
    const live = [f(1, undefined, 1, false)];
    const held = [f(2, '3', 2, true)];
    const merged = mergeHeldIntoSave(live, held);
    assert.strictEqual(merged.find((w) => w.id === 2)!.focused, true);
    assert.strictEqual(merged.find((w) => w.id === 2)!, held[0]); // untouched → same object
  });

  it('nothing held → the live set unchanged (fresh array)', () => {
    const live = [f(1, undefined, 1, true)];
    const merged = mergeHeldIntoSave(live, []);
    assert.deepStrictEqual(ids(merged), [1]);
    assert.notStrictEqual(merged, live);
  });
});
