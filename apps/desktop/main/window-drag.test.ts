import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';

import { stepWindowDrag, initialDragState, HOLD_TOLERANCE_PX, MOVE_THRESHOLD_PX } from './window-drag.js';
import type { DragEffect, DragEvent, DragState } from './window-drag.js';
import {
  initWindowDrag,
  _resetWindowDragForTests,
  _windowDragStateForTests,
  windowDragPointer,
  windowDragVeto,
  claimWindowPress,
  windowDragWindowClosed,
} from './window-drag-runtime.js';
import type { WindowId } from './window-kernel.js';

type Id = string;
const RECT = { x: 100, y: 200, width: 640, height: 480 };

function run(events: DragEvent<Id>[], from: DragState<Id> = initialDragState()): { state: DragState<Id>; effects: DragEffect<Id>[] } {
  let state = from;
  const effects: DragEffect<Id>[] = [];
  for (const e of events) {
    const step = stepWindowDrag(state, e);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

const press = (source: Id = 'a', target: Id | null = source): DragEvent<Id> =>
  ({ type: 'press', source, target, x: 10, y: 10, holdMs: 1000 });
const held: DragEvent<Id> = { type: 'holdElapsed', bounds: RECT };
const move = (x: number, y: number, buttonHeld: boolean | null = true): DragEvent<Id> => ({ type: 'move', x, y, buttonHeld });

describe('stepWindowDrag', () => {
  it('a press starts the hold timer', () => {
    const r = run([press()]);
    assert.strictEqual(r.state.phase, 'pending');
    assert.deepStrictEqual(r.effects, [{ type: 'startHoldTimer', ms: 1000 }]);
  });

  it('a press with no movable target stays idle', () => {
    const r = run([press('a', null)]);
    assert.strictEqual(r.state.phase, 'idle');
    assert.deepStrictEqual(r.effects, []);
  });

  it('the hold elapsing shows the open hand on the pressed and moved windows', () => {
    const r = run([press('chrome', 'page'), held]);
    assert.strictEqual(r.state.phase, 'ready');
    assert.deepStrictEqual(r.effects.at(-1), { type: 'indicator', ids: ['chrome', 'page'], cursor: 'grab' });
  });

  it('the hold elapsing on a window that can no longer move ends the gesture', () => {
    const r = run([press(), { type: 'holdElapsed', bounds: null }]);
    assert.strictEqual(r.state.phase, 'idle');
  });

  it('moving past the tolerance before the hold elapses cancels', () => {
    const r = run([press(), move(10 + HOLD_TOLERANCE_PX + 1, 10), held]);
    assert.strictEqual(r.state.phase, 'idle');
    assert.ok(r.effects.some((e) => e.type === 'stopHoldTimer'));
    assert.ok(!r.effects.some((e) => e.type === 'indicator'));
  });

  it('movement within the tolerance keeps the hold running', () => {
    const r = run([press(), move(10 + HOLD_TOLERANCE_PX, 10 - HOLD_TOLERANCE_PX)]);
    assert.strictEqual(r.state.phase, 'pending');
  });

  it('a buttonless move while the hold runs is ignored', () => {
    const r = run([press(), move(400, 400, false)]);
    assert.strictEqual(r.state.phase, 'pending');
  });

  it('after the hold, moving past the threshold drags the target from the press point', () => {
    const r = run([press('a'), held, move(10 + MOVE_THRESHOLD_PX + 1, 10)]);
    assert.strictEqual(r.state.phase, 'dragging');
    assert.deepStrictEqual(r.effects.slice(-3), [
      { type: 'indicator', ids: ['a'], cursor: 'grabbing' },
      { type: 'dragActive', active: true },
      { type: 'setBounds', id: 'a', bounds: { ...RECT, x: RECT.x + MOVE_THRESHOLD_PX + 1 } },
    ]);
  });

  it('a small move after the hold does not start the drag', () => {
    const r = run([press(), held, move(10 + MOVE_THRESHOLD_PX, 10)]);
    assert.strictEqual(r.state.phase, 'ready');
  });

  it('the window follows the pointer and keeps its size', () => {
    const r = run([press('chrome', 'page'), held, move(50, 60), move(-20, 300)]);
    assert.deepStrictEqual(r.effects.at(-1), {
      type: 'setBounds', id: 'page', bounds: { x: RECT.x - 30, y: RECT.y + 290, width: RECT.width, height: RECT.height },
    });
  });

  it('release ends a drag and clears the indicator', () => {
    const r = run([press(), held, move(50, 50), { type: 'release' }]);
    assert.strictEqual(r.state.phase, 'idle');
    assert.deepStrictEqual(r.effects.slice(-2), [
      { type: 'indicator', ids: ['a'], cursor: null },
      { type: 'dragActive', active: false },
    ]);
  });

  it('release before the hold stops the timer only', () => {
    const r = run([press(), { type: 'release' }]);
    assert.deepStrictEqual(r.effects.at(-1), { type: 'stopHoldTimer' });
    assert.strictEqual(r.state.phase, 'idle');
  });

  it('a buttonless move once dragging is a lost release', () => {
    const r = run([press(), held, move(50, 50), move(60, 60, false)]);
    assert.strictEqual(r.state.phase, 'idle');
    assert.ok(!r.effects.slice(-2).some((e) => e.type === 'setBounds'));
  });

  it('a move with an unknown button state keeps the drag', () => {
    const r = run([press(), held, move(50, 50), move(60, 60, null)]);
    assert.strictEqual(r.state.phase, 'dragging');
  });

  it('a veto for the pressed window cancels while pending or ready', () => {
    assert.strictEqual(run([press('a'), { type: 'veto', source: 'a' }]).state.phase, 'idle');
    assert.strictEqual(run([press('a'), held, { type: 'veto', source: 'a' }]).state.phase, 'idle');
  });

  it('a veto for another window, or once dragging, changes nothing', () => {
    assert.strictEqual(run([press('a'), { type: 'veto', source: 'b' }]).state.phase, 'pending');
    assert.strictEqual(run([press('a'), held, move(50, 50), { type: 'veto', source: 'a' }]).state.phase, 'dragging');
  });

  it('the source or target closing ends the gesture', () => {
    assert.strictEqual(run([press('chrome', 'page'), held, move(50, 50), { type: 'windowGone', id: 'page' }]).state.phase, 'idle');
    assert.strictEqual(run([press('chrome', 'page'), { type: 'windowGone', id: 'chrome' }]).state.phase, 'idle');
    assert.strictEqual(run([press('a'), { type: 'windowGone', id: 'b' }]).state.phase, 'pending');
  });

  it('a new press ends a drag whose release was never seen', () => {
    const r = run([press('a'), held, move(50, 50), press('b')]);
    assert.strictEqual(r.state.phase, 'pending');
    if (r.state.phase === 'pending') assert.strictEqual(r.state.source, 'b');
    assert.ok(r.effects.some((e) => e.type === 'dragActive' && e.active === false));
  });

  it('a hold elapsing after the gesture ended does nothing', () => {
    const r = run([press(), { type: 'release' }, held]);
    assert.strictEqual(r.state.phase, 'idle');
  });
});

describe('window drag runtime', () => {
  type Timer = { fn: () => void; ms: number; cleared: boolean };
  let timers: Timer[];
  let calls: string[];
  let target: WindowId | null;
  let bounds: typeof RECT | null;

  const A = 'wm-1' as WindowId;
  const B = 'wm-2' as WindowId;

  beforeEach(() => {
    _resetWindowDragForTests();
    timers = [];
    calls = [];
    target = A;
    bounds = RECT;
    initWindowDrag({
      resolveTarget: () => target,
      movableBounds: () => bounds,
      holdMs: () => 250,
      setBounds: (id, b) => calls.push(`bounds ${id} ${b.x},${b.y}`),
      paintIndicator: (id, c) => calls.push(`cursor ${id} ${c}`),
      announceActive: (a) => calls.push(`active ${a}`),
      setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
      clearTimer: (t) => { (t as Timer).cleared = true; },
    });
  });

  const fire = (): void => {
    const t = timers.at(-1);
    assert.ok(t && !t.cleared);
    t.fn();
  };

  it('press, hold, move, release drags the resolved target', () => {
    windowDragPointer(A, { type: 'press', x: 0, y: 0 });
    assert.strictEqual(timers.at(-1)?.ms, 250);
    fire();
    windowDragPointer(A, { type: 'move', x: 20, y: 30, buttonHeld: true });
    windowDragPointer(A, { type: 'release' });
    assert.deepStrictEqual(calls, [
      `cursor ${A} grab`,
      `cursor ${A} grabbing`,
      'active true',
      `bounds ${A} ${RECT.x + 20},${RECT.y + 30}`,
      `cursor ${A} null`,
      'active false',
    ]);
    assert.strictEqual(_windowDragStateForTests().phase, 'idle');
  });

  it('reads the target bounds when the hold elapses, not at the press', () => {
    windowDragPointer(A, { type: 'press', x: 0, y: 0 });
    bounds = { x: 5, y: 6, width: 300, height: 200 };
    fire();
    windowDragPointer(A, { type: 'move', x: 10, y: 10, buttonHeld: true });
    assert.ok(calls.includes(`bounds ${A} 15,16`));
  });

  it('a target that stopped being movable during the hold never arms', () => {
    windowDragPointer(A, { type: 'press', x: 0, y: 0 });
    bounds = null;
    fire();
    assert.strictEqual(_windowDragStateForTests().phase, 'idle');
    assert.deepStrictEqual(calls, []);
  });

  it('moves from another window are not part of the gesture', () => {
    windowDragPointer(A, { type: 'press', x: 0, y: 0 });
    windowDragPointer(B, { type: 'move', x: 500, y: 500, buttonHeld: true });
    assert.strictEqual(_windowDragStateForTests().phase, 'pending');
  });

  it('a renderer veto cancels the pending press', () => {
    windowDragPointer(A, { type: 'press', x: 0, y: 0 });
    windowDragVeto(A);
    assert.strictEqual(_windowDragStateForTests().phase, 'idle');
    assert.ok(timers.at(-1)?.cleared);
  });

  it('a claim made after the press cancels it', () => {
    windowDragPointer(A, { type: 'press', x: 0, y: 0 });
    claimWindowPress(A);
    assert.strictEqual(_windowDragStateForTests().phase, 'idle');
  });

  it('a claim made before the press, in the same task, keeps it from arming', async () => {
    claimWindowPress(A);
    windowDragPointer(A, { type: 'press', x: 0, y: 0 });
    assert.strictEqual(_windowDragStateForTests().phase, 'idle');
    await Promise.resolve();
    windowDragPointer(A, { type: 'press', x: 0, y: 0 });
    assert.strictEqual(_windowDragStateForTests().phase, 'pending');
  });

  it('a press with no movable target does not arm', () => {
    target = null;
    windowDragPointer(A, { type: 'press', x: 0, y: 0 });
    assert.strictEqual(_windowDragStateForTests().phase, 'idle');
    assert.strictEqual(timers.length, 0);
  });

  it('the dragged window closing ends the drag', () => {
    windowDragPointer(A, { type: 'press', x: 0, y: 0 });
    fire();
    windowDragPointer(A, { type: 'move', x: 20, y: 30, buttonHeld: true });
    windowDragWindowClosed(A);
    assert.strictEqual(_windowDragStateForTests().phase, 'idle');
    assert.strictEqual(calls.at(-1), 'active false');
  });
});
