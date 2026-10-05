// The per-desktop marker decisions (mint on arrival, sweep on layout change,
// which marker a space entry raises), against the real implementation — the
// module is electron-free, so no mirroring.
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { shouldMintMarker, markersToSweep, planSpaceMarkerRaise } from './desktop-markers.js';

const marked = (...desktops: string[]) => new Set(desktops);

const markers = (entries: Record<string, number>) => new Map(Object.entries(entries));

describe('shouldMintMarker (arrival on an unmarked desktop mints its marker)', () => {
  it('arriving on an unmarked desktop in the layout mints', () => {
    assert.strictEqual(shouldMintMarker('2', ['1', '2', '3'], marked('1')), true);
  });

  it('a desktop that already has a marker does not mint again', () => {
    assert.strictEqual(shouldMintMarker('2', ['1', '2', '3'], marked('1', '2')), false);
  });

  it('no current desktop known mints nothing', () => {
    assert.strictEqual(shouldMintMarker(null, ['1', '2'], marked()), false);
  });

  it('a current desktop outside the layout mints nothing (it would be swept straight back out)', () => {
    assert.strictEqual(shouldMintMarker('9', ['1', '2'], marked()), false);
  });

  it('startup on the launch desktop with no markers yet mints', () => {
    assert.strictEqual(shouldMintMarker('1', ['1', '2', '3'], marked()), true);
  });
});

describe('markersToSweep (a marker whose desktop left the layout closes)', () => {
  it('a marker on a desktop no longer in the layout is swept', () => {
    assert.deepStrictEqual(markersToSweep(markers({ '1': 11, '9': 99 }), ['1', '2']), [
      { desktop: '9', marker: 99 },
    ]);
  });

  it('markers whose desktops survive are kept', () => {
    assert.deepStrictEqual(markersToSweep(markers({ '1': 11, '2': 22 }), ['1', '2', '3']), []);
  });

  it('an empty layout is no layout read yet, not every desktop deleted — nothing sweeps', () => {
    assert.deepStrictEqual(markersToSweep(markers({ '1': 11, '2': 22 }), []), []);
  });

  it('no markers, nothing to sweep', () => {
    assert.deepStrictEqual(markersToSweep(markers({}), ['1', '2']), []);
  });
});

describe('planSpaceMarkerRaise (space entry raises the target desktop\'s marker)', () => {
  it('raises the marker of the recorded desktop holding the most windows', () => {
    const plan = planSpaceMarkerRaise(['3', '3', '2'], '1', ['1', '2', '3'], markers({ '2': 22, '3': 33 }));
    assert.deepStrictEqual(plan, { verdict: 'raise', target: '3', marker: 33 });
  });

  it('skip-no-target when a recorded window is already on the current desktop', () => {
    const plan = planSpaceMarkerRaise(['1', '3'], '1', ['1', '2', '3'], markers({ '3': 33 }));
    assert.deepStrictEqual(plan, { verdict: 'skip-no-target', target: null });
  });

  it('skip-no-target when nothing is recorded', () => {
    const plan = planSpaceMarkerRaise([], '1', ['1', '2'], markers({ '2': 22 }));
    assert.deepStrictEqual(plan, { verdict: 'skip-no-target', target: null });
  });

  it('skip-no-target when no current desktop is known', () => {
    const plan = planSpaceMarkerRaise(['2'], null, ['1', '2'], markers({ '2': 22 }));
    assert.deepStrictEqual(plan, { verdict: 'skip-no-target', target: null });
  });

  it('skip-no-target when no recorded desktop survives in the layout', () => {
    const plan = planSpaceMarkerRaise(['9'], '1', ['1', '2'], markers({ '2': 22 }));
    assert.deepStrictEqual(plan, { verdict: 'skip-no-target', target: null });
  });

  it('skip-no-marker when the target desktop has not been visited since launch', () => {
    const plan = planSpaceMarkerRaise(['3'], '1', ['1', '2', '3'], markers({ '1': 11 }));
    assert.deepStrictEqual(plan, { verdict: 'skip-no-marker', target: '3' });
  });

  it('ties break to the desktop nearest the current one, and its marker is the one raised', () => {
    const plan = planSpaceMarkerRaise(['2', '4'], '3', ['1', '2', '3', '4'], markers({ '2': 22, '4': 44 }));
    assert.strictEqual(plan.verdict, 'raise');
    assert.strictEqual(plan.target, '2');
  });

  it('a marker on a non-target desktop never substitutes for the missing target marker', () => {
    // The old per-space gate could find its named window on the wrong
    // desktop (skip-mismatch); here the lookup is BY target desktop, so the
    // only failure left is the marker not existing at all.
    const plan = planSpaceMarkerRaise(['3', '3'], '1', ['1', '2', '3'], markers({ '2': 22 }));
    assert.deepStrictEqual(plan, { verdict: 'skip-no-marker', target: '3' });
  });
});
