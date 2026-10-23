// Tile suspension policy core: transitions, idle clock, holds, and the wake gate while an unload
// is under way. Pure; no electron.

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  decideSuspension,
  effectiveIdleMs,
  initialSuspensionState,
  isInUse,
  nextCheckAt,
  suspensionConfigFromPrefs,
  type SuspensionConfig,
  type SuspensionEffect,
  type SuspensionEvent,
  type SuspensionState,
} from './tile-suspension.js';

const MIN = 60 * 1000;

interface Step {
  event: SuspensionEvent;
  at: number;
}

function run(
  start: SuspensionState,
  steps: Step[],
): { state: SuspensionState; effects: SuspensionEffect[][] } {
  let state = start;
  const effects: SuspensionEffect[][] = [];
  for (const { event, at } of steps) {
    const d = decideSuspension(state, event, at);
    state = d.state;
    effects.push(d.effects);
  }
  return { state, effects };
}

function flat(effects: SuspensionEffect[][]): SuspensionEffect[] {
  return effects.flat();
}

function kinds(effects: SuspensionEffect[][]): string[] {
  return flat(effects).map((e) => e.type);
}

/** A tile that has been woken and is ready with nothing open, at time 0. */
function readyIdle(config: Partial<SuspensionConfig> = {}): SuspensionState {
  const s0 = initialSuspensionState(config, 0);
  return run(s0, [
    { event: { type: 'wake-requested' }, at: 0 },
    { event: { type: 'wake-ready' }, at: 0 },
  ]).state;
}

describe('tile-suspension transitions', () => {
  it('wake-requested while suspended starts a load', () => {
    const d = decideSuspension(initialSuspensionState(), { type: 'wake-requested' }, 5);
    assert.strictEqual(d.state.policy, 'waking');
    assert.deepStrictEqual(d.effects, [{ type: 'load' }]);
  });

  it('wake-ready with nothing open settles to idle and arms the idle timer', () => {
    const s = readyIdle();
    assert.strictEqual(s.policy, 'idle');
    assert.strictEqual(nextCheckAt(s), 10 * MIN);
  });

  it('wake-ready with a pending dispatch is active', () => {
    const { state } = run(initialSuspensionState({}, 0), [
      { event: { type: 'wake-requested' }, at: 0 },
      { event: { type: 'dispatch-pending' }, at: 0 },
      { event: { type: 'wake-ready' }, at: 1 },
    ]);
    assert.strictEqual(state.policy, 'active');
  });

  it('wake-failed returns to suspended and drops everything', () => {
    const { state } = run(initialSuspensionState({}, 0), [
      { event: { type: 'wake-requested' }, at: 0 },
      { event: { type: 'dispatch-pending' }, at: 0 },
      { event: { type: 'wake-failed' }, at: 1 },
    ]);
    assert.strictEqual(state.policy, 'suspended');
    assert.strictEqual(isInUse(state), false);
  });

  it('a window opening makes an idle tile active; closing it makes it idle again at that time', () => {
    const { state } = run(readyIdle(), [
      { event: { type: 'window-opened', id: 'w1' }, at: 1000 },
      { event: { type: 'window-closed', id: 'w1' }, at: 2000 },
    ]);
    assert.strictEqual(state.policy, 'idle');
    assert.strictEqual(state.lastActivityAt, 2000);
    assert.strictEqual(nextCheckAt(state), 2000 + 10 * MIN);
  });

  it('idle tick before the idle time elapsed does not suspend', () => {
    const d = decideSuspension(readyIdle(), { type: 'tick' }, 9 * MIN);
    assert.strictEqual(d.state.policy, 'idle');
    assert.deepStrictEqual(d.effects, []);
  });

  it('idle tick after the idle time unloads and enters suspending', () => {
    const d = decideSuspension(readyIdle(), { type: 'tick' }, 10 * MIN);
    assert.strictEqual(d.state.policy, 'suspending');
    assert.deepStrictEqual(kinds([d.effects]), ['unload', 'arm-timer']);
  });

  it('activity pushes the idle deadline out', () => {
    const { state, effects } = run(readyIdle(), [
      { event: { type: 'activity' }, at: 6 * MIN },
      { event: { type: 'tick' }, at: 10 * MIN },
    ]);
    assert.strictEqual(state.policy, 'idle');
    assert.ok(!kinds(effects).includes('unload'));
    assert.strictEqual(nextCheckAt(state), 16 * MIN);
  });

  it('a tick never suspends an active tile', () => {
    const { state, effects } = run(readyIdle(), [
      { event: { type: 'window-opened', id: 'w1' }, at: 0 },
      { event: { type: 'tick' }, at: 60 * MIN },
    ]);
    assert.strictEqual(state.policy, 'active');
    assert.ok(!kinds(effects).includes('unload'));
  });

  it('disabled switch: idle tile is tracked but never suspended', () => {
    const s = readyIdle({ enabled: false });
    assert.strictEqual(nextCheckAt(s), null);
    const d = decideSuspension(s, { type: 'tick' }, 99 * MIN);
    assert.strictEqual(d.state.policy, 'idle');
    assert.deepStrictEqual(d.effects, []);
  });

  it('setting-changed applies to the next decision', () => {
    const { state, effects } = run(readyIdle(), [
      { event: { type: 'setting-changed', config: { idleMs: 1 * MIN } }, at: 0 },
      { event: { type: 'tick' }, at: 1 * MIN },
    ]);
    assert.strictEqual(state.policy, 'suspending');
    assert.ok(kinds(effects).includes('unload'));
  });

  it('idle time is never below twice the shortest schedule interval', () => {
    const cfg = { idleMs: 1 * MIN, scheduleIntervalMs: 5 * MIN };
    assert.strictEqual(effectiveIdleMs({ ...initialSuspensionState().config, ...cfg }), 10 * MIN);
    const s = readyIdle(cfg);
    assert.strictEqual(decideSuspension(s, { type: 'tick' }, 9 * MIN).state.policy, 'idle');
    assert.strictEqual(decideSuspension(s, { type: 'tick' }, 10 * MIN).state.policy, 'suspending');
  });

  it('unload-finished returns to suspended and clears state', () => {
    const { state } = run(readyIdle(), [
      { event: { type: 'tick' }, at: 10 * MIN },
      { event: { type: 'unload-finished' }, at: 10 * MIN + 500 },
    ]);
    assert.strictEqual(state.policy, 'suspended');
    assert.strictEqual(state.queuedWake, false);
  });

  it('disabled and crashed go to suspended from any state', () => {
    const states: SuspensionState[] = [
      initialSuspensionState(),
      run(initialSuspensionState({}, 0), [{ event: { type: 'wake-requested' }, at: 0 }]).state,
      readyIdle(),
      run(readyIdle(), [{ event: { type: 'hold-acquired', id: 'h' }, at: 1 }]).state,
      run(readyIdle(), [{ event: { type: 'tick' }, at: 10 * MIN }]).state,
    ];
    for (const s of states) {
      for (const type of ['disabled', 'crashed'] as const) {
        const d = decideSuspension(s, { type }, 11 * MIN);
        assert.strictEqual(d.state.policy, 'suspended', `${s.policy} --${type}-->`);
        assert.strictEqual(isInUse(d.state), false);
      }
    }
  });
});

describe('tile-suspension ignored events', () => {
  const ignoredWhileSuspended: SuspensionEvent[] = [
    { type: 'activity' },
    { type: 'hold-acquired', id: 'h' },
    { type: 'window-opened', id: 'w' },
    { type: 'dispatch-pending' },
    { type: 'tick' },
    { type: 'wake-ready' },
    { type: 'unload-finished' },
  ];
  for (const event of ignoredWhileSuspended) {
    it(`suspended ignores ${event.type}`, () => {
      const s = initialSuspensionState();
      const d = decideSuspension(s, event, 5);
      assert.strictEqual(d.state, s);
      assert.deepStrictEqual(d.effects, []);
    });
  }

  const ignoredWhileSuspending: SuspensionEvent[] = [
    { type: 'activity' },
    { type: 'hold-acquired', id: 'h' },
    { type: 'window-opened', id: 'w' },
    { type: 'dispatch-pending' },
    { type: 'tick' },
    { type: 'wake-ready' },
  ];
  for (const event of ignoredWhileSuspending) {
    it(`suspending ignores ${event.type}`, () => {
      const s = run(readyIdle(), [{ event: { type: 'tick' }, at: 10 * MIN }]).state;
      assert.strictEqual(s.policy, 'suspending');
      const d = decideSuspension(s, event, 10 * MIN + 1);
      assert.strictEqual(d.state, s);
      assert.deepStrictEqual(d.effects, []);
    });
  }

  it('releasing or closing something unknown changes nothing', () => {
    const s = readyIdle();
    for (const event of [
      { type: 'hold-released', id: 'nope' },
      { type: 'window-closed', id: 'nope' },
      { type: 'dispatch-settled' },
    ] as SuspensionEvent[]) {
      assert.strictEqual(decideSuspension(s, event, 5).state, s, event.type);
    }
  });

  it('a wake-requested on a loaded tile counts as activity and does not load', () => {
    const d = decideSuspension(readyIdle(), { type: 'wake-requested' }, 7 * MIN);
    assert.strictEqual(d.state.lastActivityAt, 7 * MIN);
    assert.ok(!kinds([d.effects]).includes('load'));
  });
});

describe('tile-suspension use conditions', () => {
  const blockers: Array<[string, SuspensionEvent]> = [
    ['a tile window', { type: 'window-opened', id: 'w' }],
    ['an owned keepLive window', { type: 'window-opened', id: 'k', owned: true }],
    ['a hold', { type: 'hold-acquired', id: 'h' }],
    ['a pending dispatch', { type: 'dispatch-pending' }],
  ];
  for (const [name, event] of blockers) {
    it(`${name} blocks suspension however long it runs`, () => {
      const { state, effects } = run(readyIdle(), [
        { event, at: 1000 },
        { event: { type: 'tick' }, at: 20 * MIN },
      ]);
      assert.strictEqual(state.policy, 'active');
      assert.ok(!kinds(effects).includes('unload'));
    });
  }

  it('two holds need two releases', () => {
    const { state } = run(readyIdle(), [
      { event: { type: 'hold-acquired', id: 'a' }, at: 1 },
      { event: { type: 'hold-acquired', id: 'b' }, at: 2 },
      { event: { type: 'hold-released', id: 'a' }, at: 3 },
    ]);
    assert.strictEqual(state.policy, 'active');
    const after = decideSuspension(state, { type: 'hold-released', id: 'b' }, 4).state;
    assert.strictEqual(after.policy, 'idle');
  });

  it('a stale hold is released at the cap and reported', () => {
    const base = run(readyIdle({ holdCapMs: 30 * MIN }), [
      { event: { type: 'hold-acquired', id: 'leak' }, at: 0 },
    ]);
    assert.strictEqual(nextCheckAt(base.state), 30 * MIN);
    const d = decideSuspension(base.state, { type: 'tick' }, 30 * MIN);
    assert.strictEqual(d.state.policy, 'idle');
    assert.deepStrictEqual(
      d.effects.filter((e) => e.type === 'release-stale-hold'),
      [{ type: 'release-stale-hold', id: 'leak', heldMs: 30 * MIN }],
    );
    assert.strictEqual(nextCheckAt(d.state), 40 * MIN);
  });
});

describe('tile-suspension wake during suspending', () => {
  function suspending(): SuspensionState {
    return run(readyIdle(), [{ event: { type: 'tick' }, at: 10 * MIN }]).state;
  }

  it('is queued without a load', () => {
    const d = decideSuspension(suspending(), { type: 'wake-requested' }, 10 * MIN + 1);
    assert.strictEqual(d.state.policy, 'suspending');
    assert.strictEqual(d.state.queuedWake, true);
    assert.deepStrictEqual(d.effects, []);
  });

  it('is replayed exactly once, however many wakes arrived', () => {
    const { state, effects } = run(suspending(), [
      { event: { type: 'wake-requested' }, at: 10 * MIN + 1 },
      { event: { type: 'wake-requested' }, at: 10 * MIN + 2 },
      { event: { type: 'wake-requested' }, at: 10 * MIN + 3 },
      { event: { type: 'unload-finished' }, at: 10 * MIN + 500 },
    ]);
    assert.strictEqual(state.policy, 'waking');
    assert.strictEqual(state.queuedWake, false);
    assert.strictEqual(flat(effects).filter((e) => e.type === 'load').length, 1);
    // A later unload-finished must not replay it again.
    const again = decideSuspension(state, { type: 'unload-finished' }, 10 * MIN + 600);
    assert.deepStrictEqual(again.effects, []);
  });

  it('a failed replayed wake ends suspended with nothing queued', () => {
    const { state } = run(suspending(), [
      { event: { type: 'wake-requested' }, at: 10 * MIN + 1 },
      { event: { type: 'unload-finished' }, at: 10 * MIN + 2 },
      { event: { type: 'wake-failed' }, at: 10 * MIN + 3 },
    ]);
    assert.strictEqual(state.policy, 'suspended');
    assert.strictEqual(state.queuedWake, false);
  });

  it('disabled drops the queued wake', () => {
    const { state, effects } = run(suspending(), [
      { event: { type: 'wake-requested' }, at: 10 * MIN + 1 },
      { event: { type: 'disabled' }, at: 10 * MIN + 2 },
      { event: { type: 'unload-finished' }, at: 10 * MIN + 3 },
    ]);
    assert.strictEqual(state.policy, 'suspended');
    assert.ok(!kinds(effects).includes('load'));
  });
});

describe('tile-suspension property: no unload while the tile is in use', () => {
  // Small seeded generator so a failure is reproducible.
  function prng(seed: number): () => number {
    let x = seed >>> 0;
    return () => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      return x / 0x100000000;
    };
  }

  const ids = ['a', 'b'];
  function pick<T>(r: () => number, xs: T[]): T {
    return xs[Math.floor(r() * xs.length)];
  }
  function randomEvent(r: () => number): SuspensionEvent {
    const id = pick(r, ids);
    return pick<SuspensionEvent>(r, [
      { type: 'activity' },
      { type: 'hold-acquired', id },
      { type: 'hold-released', id },
      { type: 'window-opened', id },
      { type: 'window-closed', id },
      { type: 'window-opened', id, owned: true },
      { type: 'window-closed', id, owned: true },
      { type: 'dispatch-pending' },
      { type: 'dispatch-settled' },
      { type: 'tick' },
      { type: 'tick' },
      { type: 'wake-requested' },
      { type: 'wake-ready' },
      { type: 'wake-failed' },
      { type: 'unload-finished' },
      { type: 'crashed' },
      { type: 'disabled' },
    ]);
  }

  it('holds for 300 random sequences', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = prng(seed);
      let state = initialSuspensionState({ idleMs: 5 * MIN, holdCapMs: 20 * MIN }, 0);
      let now = 0;
      for (let i = 0; i < 200; i++) {
        now += Math.floor(r() * 4 * MIN);
        const event = randomEvent(r);
        const d = decideSuspension(state, event, now);
        if (d.effects.some((e) => e.type === 'unload')) {
          // The state the decision was made on, after stale holds were dropped.
          assert.strictEqual(d.state.policy, 'suspending', `seed ${seed} step ${i}`);
          assert.strictEqual(isInUse(d.state), false, `seed ${seed} step ${i}: ${JSON.stringify(event)}`);
          assert.strictEqual(d.state.windows.size, 0);
          assert.strictEqual(d.state.ownedWindows.size, 0);
          assert.strictEqual(Object.keys(d.state.holds).length, 0);
          assert.strictEqual(d.state.pendingDispatches, 0);
          assert.strictEqual(state.policy, 'idle');
        }
        // A load is only ever requested from suspended or from the replay of a queued wake.
        if (d.effects.some((e) => e.type === 'load')) {
          assert.ok(state.policy === 'suspended' || state.queuedWake, `seed ${seed} step ${i}`);
        }
        state = d.state;
      }
    }
  });
});

describe('suspensionConfigFromPrefs', () => {
  it('defaults to on with 10 minutes when prefs are missing', () => {
    assert.deepEqual(suspensionConfigFromPrefs(undefined), { enabled: true, idleMs: 10 * MIN });
    assert.deepEqual(suspensionConfigFromPrefs({}), { enabled: true, idleMs: 10 * MIN });
  });

  it('reads the on/off switch and the idle minutes', () => {
    assert.deepEqual(
      suspensionConfigFromPrefs({ tileSuspensionEnabled: false, tileSuspensionIdleMinutes: 3 }),
      { enabled: false, idleMs: 3 * MIN },
    );
  });

  it('falls back to the default for values that are not usable', () => {
    for (const bad of [0, -5, 0.4, NaN, '7', null]) {
      assert.equal(suspensionConfigFromPrefs({ tileSuspensionIdleMinutes: bad }).idleMs, 10 * MIN);
    }
    assert.equal(suspensionConfigFromPrefs({ tileSuspensionEnabled: 'no' }).enabled, true);
  });
});
