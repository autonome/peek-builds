import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseWindowModeManifest, planWindowModeChange, type WindowModePackage } from './window-mode-plan.js';

const immersive: WindowModePackage = {
  id: 'immersive',
  name: 'Immersive',
  command: 'immersive windows',
  asks: { maximize: true, chrome: 'none', transparency: false },
  dir: '/x',
};

describe('window mode manifests', () => {
  it('reads a window-mode manifest', () => {
    const pkg = parseWindowModeManifest(
      { id: 'immersive', type: 'window-mode', name: 'Immersive', command: 'immersive windows', asks: { maximize: true, chrome: 'none', transparency: false } },
      '/x',
      'mode-immersive',
    );
    assert.deepStrictEqual(pkg?.asks, { maximize: true, chrome: 'none', transparency: false });
    assert.strictEqual(pkg?.id, 'immersive');
  });

  it('ignores themes and incomplete manifests', () => {
    assert.strictEqual(parseWindowModeManifest({ type: 'theme', name: 'x' }, '/x', 'x'), null);
    assert.strictEqual(parseWindowModeManifest({ type: 'window-mode', name: 'x' }, '/x', 'x'), null);
  });
});

describe('planWindowModeChange', () => {
  const base = { from: null, to: immersive, maximizeAllOn: false, fromEnteredMaximizeAll: false, seeThroughEverywhereOn: false };

  it('entering turns maximize-all on and drops the frame', () => {
    const plan = planWindowModeChange(base);
    assert.strictEqual(plan.enterMaximizeAll, true);
    assert.strictEqual(plan.enteredMaximizeAll, true);
    assert.strictEqual(plan.chrome, 'none');
  });

  it('entering turns see-through off, and leaves it alone when it is off', () => {
    assert.strictEqual(planWindowModeChange({ ...base, seeThroughEverywhereOn: true }).seeThroughOff, true);
    assert.strictEqual(planWindowModeChange(base).seeThroughOff, false);
  });

  it('maximize-all that was already on stays on, and stays on when the mode ends', () => {
    const on = planWindowModeChange({ ...base, maximizeAllOn: true });
    assert.strictEqual(on.enterMaximizeAll, false);
    assert.strictEqual(on.enteredMaximizeAll, false);
    const off = planWindowModeChange({ from: immersive, to: null, maximizeAllOn: true, fromEnteredMaximizeAll: false, seeThroughEverywhereOn: false });
    assert.strictEqual(off.leaveMaximizeAll, false);
    assert.strictEqual(off.chrome, 'normal');
  });

  it('leaving leaves maximize-all only when the mode entered it', () => {
    const plan = planWindowModeChange({ from: immersive, to: null, maximizeAllOn: true, fromEnteredMaximizeAll: true, seeThroughEverywhereOn: false });
    assert.strictEqual(plan.leaveMaximizeAll, true);
  });

  it('does not leave maximize-all the user already turned off', () => {
    const plan = planWindowModeChange({ from: immersive, to: null, maximizeAllOn: false, fromEnteredMaximizeAll: true, seeThroughEverywhereOn: false });
    assert.strictEqual(plan.leaveMaximizeAll, false);
  });
});
