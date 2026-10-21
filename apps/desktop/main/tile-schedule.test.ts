/**
 * Manifest-declared schedules: the timer that makes a sleeping feature run
 * unattended.
 *
 * The clock, the timers and the last-run store are all injected, so a 15-minute
 * interval is exercised in microseconds and "simulate a restart" is just
 * re-arming against the same store. Only the pubsub is real — the last test
 * asserts that a schedule topic travels the SAME wake path a `lazyEvents` topic
 * does, through the load-on-dispatch hook into the tile's own handler, and a
 * fake pubsub would prove nothing about that.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';

import {
  subscribe, unsubscribe,
  __clearPrePublishHooksForTest,
} from './pubsub.js';
import {
  registerLazyTile,
  installLoadOnDispatchHook,
  __setTileLazyLauncherForTest,
  __resetTileLazyStateForTest,
} from './tile-lazy.js';
import {
  registerTileSchedule,
  unregisterTileSchedule,
  startTileSchedules,
  collectScheduleEntries,
  hasScheduleEntries,
  getScheduledTopics,
  __setTileScheduleDepsForTest,
  __resetTileScheduleStateForTest,
  type ScheduleTimerHandle,
} from './tile-schedule.js';
import type { TileManifest } from './tile-manifest.js';
import type { TileLaunchOptions, TileLaunchResult } from './tile-launcher.js';

const MINUTE = 60 * 1000;

// ─── Fake clock + timers ────────────────────────────────────────────

interface FakeTimer {
  id: number;
  fireAt: number;
  fn: () => void;
}

class FakeTime {
  now = 1_000_000_000_000;
  private nextId = 1;
  private pending = new Map<number, FakeTimer>();

  clock = { now: () => this.now };

  timers = {
    setTimeout: (fn: () => void, ms: number): ScheduleTimerHandle => {
      const id = this.nextId++;
      this.pending.set(id, { id, fireAt: this.now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout: (handle: ScheduleTimerHandle): void => {
      this.pending.delete(handle as number);
    },
  };

  /** Advance time, running every timer that comes due, in due order. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = Array.from(this.pending.values())
        .filter(t => t.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt || a.id - b.id)[0];
      if (!due) break;
      this.pending.delete(due.id);
      this.now = due.fireAt;
      due.fn();
    }
    this.now = target;
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

// ─── Fake last-run store ────────────────────────────────────────────

class FakeRunStore {
  rows = new Map<string, number>();

  private key(tileId: string, topic: string): string {
    return `${tileId}\u0000${topic}`;
  }

  getScheduleLastRun = (tileId: string, topic: string): number | null => {
    const v = this.rows.get(this.key(tileId, topic));
    return v === undefined ? null : v;
  };

  setScheduleLastRun = (tileId: string, topic: string, lastRunAt: number): void => {
    this.rows.set(this.key(tileId, topic), lastRunAt);
  };
}

// ─── Fake launcher (same shape as tile-lazy-events.test.ts) ─────────

interface FakeLauncherState {
  launchCalls: TileLaunchOptions[];
  loaded: Set<string>;
  ready: Set<string>;
  readyCallbacks: Map<string, Array<() => void>>;
  onLaunch?: (options: TileLaunchOptions) => void;
}

function makeFakeLauncher(state: FakeLauncherState) {
  return {
    launchTile: (options: TileLaunchOptions): TileLaunchResult | void => {
      state.launchCalls.push(options);
      const entryId = options.entryId || options.manifest.tiles[0]?.id || 'background';
      queueMicrotask(() => {
        state.loaded.add(`${options.manifest.id}:${entryId}`);
        if (state.onLaunch) state.onLaunch(options);
      });
    },
    waitForTileReady: (tileId: string, entryId: string): Promise<void> => {
      const key = `${tileId}:${entryId}`;
      if (state.ready.has(key)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        if (!state.readyCallbacks.has(key)) state.readyCallbacks.set(key, []);
        state.readyCallbacks.get(key)!.push(resolve);
      });
    },
    isTileLoaded: (tileId: string, entryId: string): boolean => {
      return state.loaded.has(`${tileId}:${entryId}`);
    },
  };
}

function signalReady(state: FakeLauncherState, tileId: string, entryId: string): void {
  const key = `${tileId}:${entryId}`;
  state.ready.add(key);
  const cbs = state.readyCallbacks.get(key) || [];
  state.readyCallbacks.delete(key);
  for (const cb of cbs) cb();
}

/** Wait one macrotask so async hook/subscriber callbacks run */
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

// ─── Fixtures ───────────────────────────────────────────────────────

function makeManifest(
  id: string,
  schedule: Array<{ topic: string; everyMinutes: number }>,
): TileManifest {
  return {
    manifestVersion: 3,
    id,
    name: id,
    builtin: true,
    tiles: [
      {
        id: 'background',
        url: 'background.html',
        lazy: true,
        schedule,
      },
    ],
    capabilities: {
      pubsub: { scopes: ['self', 'global'] },
    },
  } as TileManifest;
}

describe('tile-schedule', () => {
  let time: FakeTime;
  let store: FakeRunStore;
  /** Every schedule publish seen on the bus, in order. */
  let fires: Array<{ topic: string; msg: unknown }>;
  const WATCHER = 'peek://test-schedule-watcher';

  function watch(topic: string): void {
    subscribe(WATCHER + topic, topic, (msg) => {
      fires.push({ topic, msg });
    });
  }

  function unwatch(topic: string): void {
    unsubscribe(WATCHER + topic, topic);
  }

  beforeEach(() => {
    __resetTileScheduleStateForTest();
    __resetTileLazyStateForTest();
    __clearPrePublishHooksForTest();
    time = new FakeTime();
    store = new FakeRunStore();
    fires = [];
    __setTileScheduleDepsForTest({ clock: time.clock, timers: time.timers, store });
  });

  afterEach(() => {
    __resetTileScheduleStateForTest();
    __setTileScheduleDepsForTest(null);
    __setTileLazyLauncherForTest(null);
    __clearPrePublishHooksForTest();
  });

  // ── Manifest reading ──

  it('reads only usable schedule entries off the manifest', () => {
    const manifest = makeManifest('sched-read', [
      { topic: 'a:poll', everyMinutes: 15 },
      { topic: '', everyMinutes: 5 },
      { topic: 'b:poll', everyMinutes: 0 },
      { topic: 'c:poll', everyMinutes: 1.5 },
      { topic: 'a:poll', everyMinutes: 30 },
    ]);
    assert.deepStrictEqual(collectScheduleEntries(manifest), [
      { topic: 'a:poll', everyMinutes: 15 },
    ]);
    assert.strictEqual(hasScheduleEntries(manifest), true);
    assert.strictEqual(hasScheduleEntries(makeManifest('no-sched', [])), false);
  });

  // ── Case 1: never fired ──

  it('an entry that has never fired publishes once after arming, then once per interval', () => {
    watch('never:poll');
    registerTileSchedule(makeManifest('never', [{ topic: 'never:poll', everyMinutes: 15 }]));

    // Registration alone arms nothing — boot is still registering tiles.
    assert.strictEqual(fires.length, 0, 'must not fire before startTileSchedules()');

    startTileSchedules();
    time.advance(0);
    assert.strictEqual(fires.length, 1, 'a never-fired entry is due at arming');
    assert.strictEqual(fires[0].topic, 'never:poll');

    time.advance(15 * MINUTE);
    assert.strictEqual(fires.length, 2, 'then once per interval');
    time.advance(15 * MINUTE);
    assert.strictEqual(fires.length, 3);

    // Mid-interval does not fire.
    time.advance(14 * MINUTE);
    assert.strictEqual(fires.length, 3);
    time.advance(1 * MINUTE);
    assert.strictEqual(fires.length, 4);

    unwatch('never:poll');
  });

  it('a start hold keeps due entries from firing until it has passed', () => {
    watch('held:never');
    watch('held:missed');
    watch('held:recent');
    store.setScheduleLastRun('held', 'held:missed', time.now - 7 * 60 * MINUTE);
    // Due in 40 s, after the hold ends: the hold does not delay it further.
    store.setScheduleLastRun('held', 'held:recent', time.now - 15 * MINUTE + 40 * 1000);
    registerTileSchedule(makeManifest('held', [
      { topic: 'held:never', everyMinutes: 15 },
      { topic: 'held:missed', everyMinutes: 15 },
      { topic: 'held:recent', everyMinutes: 15 },
    ]));

    startTileSchedules(30 * 1000);
    time.advance(29 * 1000);
    assert.strictEqual(fires.length, 0, 'nothing fires during the hold');

    time.advance(1000);
    assert.deepStrictEqual(fires.map(f => f.topic).sort(), ['held:missed', 'held:never']);

    time.advance(10 * 1000);
    assert.strictEqual(fires.length, 3, 'an entry due after the hold fires on its own time');

    unwatch('held:never');
    unwatch('held:missed');
    unwatch('held:recent');
  });

  it('the publish carries scheduledAt and the previous lastRunAt from the system address', () => {
    watch('payload:poll');
    const armedAt = time.now;
    registerTileSchedule(makeManifest('payload', [{ topic: 'payload:poll', everyMinutes: 10 }]));
    startTileSchedules();
    time.advance(0);

    assert.deepStrictEqual(fires[0].msg, { scheduledAt: armedAt, lastRunAt: null });

    time.advance(10 * MINUTE);
    assert.deepStrictEqual(fires[1].msg, {
      scheduledAt: armedAt + 10 * MINUTE,
      lastRunAt: armedAt,
    });

    unwatch('payload:poll');
  });

  // ── Case 2: missed runs collapse to one; a recent run waits out the remainder ──

  it('an entry more than one interval overdue fires exactly once, however many intervals were missed', () => {
    watch('missed:poll');
    // Last run was 7 hours ago with a 15-minute interval: 28 intervals missed.
    store.setScheduleLastRun('missed', 'missed:poll', time.now - 7 * 60 * MINUTE);
    registerTileSchedule(makeManifest('missed', [{ topic: 'missed:poll', everyMinutes: 15 }]));
    startTileSchedules();
    time.advance(0);

    assert.strictEqual(fires.length, 1, 'one catch-up run, not one per missed interval');

    // And it then resumes a normal cadence from the catch-up run.
    time.advance(15 * MINUTE);
    assert.strictEqual(fires.length, 2);

    unwatch('missed:poll');
  });

  it('an entry whose last run is recent first fires when the remainder of the interval has passed', () => {
    watch('recent:poll');
    const armedAt = time.now;
    // Ran 4 minutes ago on a 15-minute interval: 11 minutes left.
    store.setScheduleLastRun('recent', 'recent:poll', armedAt - 4 * MINUTE);
    registerTileSchedule(makeManifest('recent', [{ topic: 'recent:poll', everyMinutes: 15 }]));
    startTileSchedules();

    time.advance(10 * MINUTE);
    assert.strictEqual(fires.length, 0, 'not due until the interval remainder has passed');

    time.advance(1 * MINUTE);
    assert.strictEqual(fires.length, 1, 'due 11 minutes after arming');
    assert.strictEqual((fires[0].msg as { scheduledAt: number }).scheduledAt, armedAt + 11 * MINUTE);

    // Then a full interval, not another remainder.
    time.advance(15 * MINUTE);
    assert.strictEqual(fires.length, 2);

    unwatch('recent:poll');
  });

  // ── Case 3: persistence across a re-arm ──

  it('each fire records lastRunAt, and a re-arm after a restart reads it back', () => {
    watch('restart:poll');
    const manifest = makeManifest('restart', [{ topic: 'restart:poll', everyMinutes: 15 }]);

    registerTileSchedule(manifest);
    startTileSchedules();
    time.advance(0);
    const firstRunAt = time.now;
    assert.strictEqual(fires.length, 1);
    assert.strictEqual(store.getScheduleLastRun('restart', 'restart:poll'), firstRunAt);

    time.advance(15 * MINUTE);
    assert.strictEqual(fires.length, 2);
    assert.strictEqual(store.getScheduleLastRun('restart', 'restart:poll'), firstRunAt + 15 * MINUTE);

    // Simulated restart: drop all in-memory state, keep the store, re-arm 5
    // minutes later. 10 minutes of the interval remain, so it must NOT fire
    // straight away — the restart did not reset the clock.
    const lastRunBeforeRestart = store.getScheduleLastRun('restart', 'restart:poll')!;
    __resetTileScheduleStateForTest();
    __setTileScheduleDepsForTest({ clock: time.clock, timers: time.timers, store });
    time.advance(5 * MINUTE);

    registerTileSchedule(manifest);
    startTileSchedules();
    time.advance(0);
    assert.strictEqual(fires.length, 2, 'a restart mid-interval does not re-fire');

    time.advance(10 * MINUTE);
    assert.strictEqual(fires.length, 3, 'it fires out the remainder of the persisted interval');
    assert.strictEqual(
      (fires[2].msg as { lastRunAt: number | null }).lastRunAt,
      lastRunBeforeRestart,
      'the publish reports the run persisted before the restart',
    );

    unwatch('restart:poll');
  });

  // ── Case 4: unregister clears the timers ──

  it('unregistering the tile clears its timers: no further publishes', () => {
    watch('gone:poll');
    registerTileSchedule(makeManifest('gone', [{ topic: 'gone:poll', everyMinutes: 15 }]));
    startTileSchedules();
    time.advance(0);
    assert.strictEqual(fires.length, 1);
    assert.deepStrictEqual(getScheduledTopics('gone'), ['gone:poll']);

    unregisterTileSchedule('gone');
    assert.deepStrictEqual(getScheduledTopics('gone'), []);
    assert.strictEqual(time.pendingCount, 0, 'no timer left armed');

    time.advance(60 * MINUTE);
    assert.strictEqual(fires.length, 1, 'a disabled feature stops running');

    unwatch('gone:poll');
  });

  it('a re-register after unregistering arms once, not twice', () => {
    watch('rearm:poll');
    const manifest = makeManifest('rearm', [{ topic: 'rearm:poll', everyMinutes: 15 }]);
    registerTileSchedule(manifest);
    startTileSchedules();
    time.advance(0);
    assert.strictEqual(fires.length, 1);

    unregisterTileSchedule('rearm');
    // Re-enabled mid-session: boot already finished, so it arms on arrival.
    registerTileSchedule(manifest);
    time.advance(0);
    assert.strictEqual(fires.length, 1, 'the entry ran 0 minutes ago, so it is not due');

    time.advance(15 * MINUTE);
    assert.strictEqual(fires.length, 2, 'exactly one timer, not two');

    unwatch('rearm:poll');
  });

  // ── Case 5: the publish wakes the sleeping owner through the dispatch hook ──

  it('publishing a schedule topic wakes the sleeping owning tile and reaches its handler', async () => {
    installLoadOnDispatchHook();
    const launcherState: FakeLauncherState = {
      launchCalls: [],
      loaded: new Set(),
      ready: new Set(),
      readyCallbacks: new Map(),
    };
    __setTileLazyLauncherForTest(makeFakeLauncher(launcherState));

    const manifest = makeManifest('waker', [{ topic: 'waker:poll', everyMinutes: 15 }]);
    registerLazyTile(manifest, '/fake/path', '/fake/tile-preload.cjs');
    registerTileSchedule(manifest);

    // The tile registers its real handler only once it is launched — i.e. the
    // handler does not exist at the moment the schedule publishes.
    const received: unknown[] = [];
    launcherState.onLaunch = () => {
      subscribe('peek://waker/bg', 'waker:poll', (msg) => {
        received.push(msg);
      });
      signalReady(launcherState, 'waker', 'background');
    };

    assert.strictEqual(launcherState.launchCalls.length, 0, 'asleep before its schedule is due');

    startTileSchedules();
    time.advance(0);
    for (let i = 0; i < 10; i++) await flushMicrotasks();

    assert.strictEqual(launcherState.launchCalls.length, 1, 'the due schedule woke the tile');
    assert.strictEqual(received.length, 1, 'the woken handler received the deferred publish');
    assert.deepStrictEqual(received[0], { scheduledAt: time.now, lastRunAt: null });

    // Already awake: the next interval just reaches the live handler.
    time.advance(15 * MINUTE);
    for (let i = 0; i < 10; i++) await flushMicrotasks();
    assert.strictEqual(launcherState.launchCalls.length, 1, 'no relaunch of a live tile');
    assert.strictEqual(received.length, 2);

    unsubscribe('peek://waker/bg', 'waker:poll');
  });
});
