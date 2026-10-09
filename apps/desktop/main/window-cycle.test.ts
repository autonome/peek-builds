// Window cycling (cmd+` / cmd+shift+`): the pure target selector and the content-window list it
// walks. The list is in open order, not stack order, so repeated presses visit every window.

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { initialState, evolve, type Event, type State, type WindowId } from './window-kernel.js';
import { cycleTarget, cyclableWindowIds } from './window-cycle.js';

const wid = (n: number): WindowId => `wc-${n}` as WindowId;

function register(n: number, role: string, opts: { canBecomeKey?: boolean; show?: boolean } = {}): Event[] {
  const events: Event[] = [
    {
      type: 'WindowRegistered',
      id: wid(n),
      kind: 'page-host',
      layer: 0,
      canBecomeKey: opts.canBecomeKey ?? true,
      acceptsInput: true,
      class: 'primary',
      role,
    },
  ];
  if (opts.show ?? true) events.push({ type: 'WindowShown', id: wid(n) });
  return events;
}

function fold(events: Event[]): State {
  return events.reduce(evolve, initialState());
}

describe('cycleTarget', () => {
  const ids = [wid(1), wid(2), wid(3)];

  it('forward goes to the next window in the list', () => {
    assert.strictEqual(cycleTarget(ids, wid(1), 'forward'), wid(2));
    assert.strictEqual(cycleTarget(ids, wid(2), 'forward'), wid(3));
  });

  it('forward wraps from the last window to the first', () => {
    assert.strictEqual(cycleTarget(ids, wid(3), 'forward'), wid(1));
  });

  it('reverse goes to the previous window and wraps from the first to the last', () => {
    assert.strictEqual(cycleTarget(ids, wid(3), 'reverse'), wid(2));
    assert.strictEqual(cycleTarget(ids, wid(1), 'reverse'), wid(3));
  });

  it('reverse undoes forward from every position', () => {
    for (const id of ids) {
      const there = cycleTarget(ids, id, 'forward');
      assert.ok(there !== null);
      assert.strictEqual(cycleTarget(ids, there, 'reverse'), id);
    }
  });

  it('repeated forward presses visit every window once before returning', () => {
    const four = [wid(1), wid(2), wid(3), wid(4)];
    const seen: WindowId[] = [];
    let current: WindowId | null = wid(1);
    for (let i = 0; i < four.length; i++) {
      current = cycleTarget(four, current as WindowId, 'forward');
      assert.ok(current !== null);
      seen.push(current);
    }
    assert.deepStrictEqual(seen, [wid(2), wid(3), wid(4), wid(1)]);
  });

  it('with no current window, forward picks the first and reverse the last', () => {
    assert.strictEqual(cycleTarget(ids, null, 'forward'), wid(1));
    assert.strictEqual(cycleTarget(ids, null, 'reverse'), wid(3));
    assert.strictEqual(cycleTarget(ids, wid(9), 'forward'), wid(1));
  });

  it('answers null when there is nothing to move to', () => {
    assert.strictEqual(cycleTarget([], wid(1), 'forward'), null);
    assert.strictEqual(cycleTarget([wid(1)], wid(1), 'forward'), null);
    assert.strictEqual(cycleTarget([wid(1)], wid(1), 'reverse'), null);
  });
});

describe('cyclableWindowIds', () => {
  it('lists visible content windows in open order', () => {
    const state = fold([...register(1, 'content'), ...register(2, 'child-content'), ...register(3, 'workspace')]);
    assert.deepStrictEqual(cyclableWindowIds(state), [wid(1), wid(2), wid(3)]);
  });

  it('excludes the overlay, background, hidden and non-key windows', () => {
    const state = fold([
      ...register(1, 'content'),
      ...register(2, 'overlay'),
      ...register(3, 'background'),
      ...register(4, 'content', { show: false }),
      ...register(5, 'content', { canBecomeKey: false }),
      ...register(6, 'content'),
    ]);
    assert.deepStrictEqual(cyclableWindowIds(state), [wid(1), wid(6)]);
  });

  it('keeps open order when raising reorders the stack', () => {
    const base = [...register(1, 'content'), ...register(2, 'content'), ...register(3, 'content')];
    const raised = fold([...base, { type: 'FocusRaiseRequested', id: wid(1) }]);
    assert.deepStrictEqual(cyclableWindowIds(raised), [wid(1), wid(2), wid(3)]);
  });

  it('forward presses over a raising stack still visit all three windows', () => {
    let state = fold([...register(1, 'content'), ...register(2, 'content'), ...register(3, 'content')]);
    let current: WindowId | null = wid(1);
    const visited = new Set<WindowId>([wid(1)]);
    for (let i = 0; i < 2; i++) {
      current = cycleTarget(cyclableWindowIds(state), current, 'forward');
      assert.ok(current !== null);
      visited.add(current);
      state = evolve(state, { type: 'FocusRaiseRequested', id: current });
    }
    assert.strictEqual(visited.size, 3);
  });
});
