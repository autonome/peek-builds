/**
 * Unit tests for tile-lifecycle.ts — Phase 4.
 *
 * Covers:
 *  - `tile:state-changed` System-topic emission on every transition.
 *  - bgWindow-ready gate: `requestLoad()` for non-bgWindow tiles is
 *    held until bgWindow signals `tile:lifecycle:ready`.
 *  - Subscribe-before-publish invariant: a subscriber registered
 *    synchronously against pubsub before the publisher fires (simulating
 *    `cmd:register` at t=0 boot) receives the publish.
 *
 * Runs under Electron's Node host (via `yarn test:unit`). The tile-
 * lifecycle module imports `ipcMain` from electron for the lifecycle
 * IPC handler; we avoid exercising that code path here and use
 * `__simulateLifecycleReadyForTest()` instead — same side effects
 * (latch release + ready callback) without needing ipcMain in the
 * test host.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';

import {
  STATES,
  TRIGGERS,
  transition,
  requestLoad,
  registerBgWindow,
  isBgWindowReady,
  waitForBgWindowReady,
  setReadyCallback,
  __simulateLifecycleReadyForTest,
  resetForTests,
} from './tile-lifecycle.js';
import {
  subscribe,
  unsubscribe,
  publish,
  getSystemAddress,
  __clearPrePublishHooksForTest,
} from './pubsub.js';

// Ensure NODE_ENV is 'test' — resetForTests / __simulateLifecycleReadyForTest
// throw otherwise, and we need them to guard against cross-test leakage.
if (process.env.NODE_ENV !== 'test') {
  process.env.NODE_ENV = 'test';
}

// ─── Helpers ─────────────────────────────────────────────────────────

interface StateChangedPayload {
  tileId: string;
  entryId: string;
  from: string;
  to: string;
  trigger: string;
  ts: number;
}

/**
 * Subscribe to `tile:state-changed` and accumulate every payload. Returns
 * the events array and an unsubscribe function.
 */
function captureStateChanged(): {
  events: StateChangedPayload[];
  stop: () => void;
} {
  const events: StateChangedPayload[] = [];
  const source = `test-state-listener-${Math.random().toString(36).slice(2, 8)}`;
  subscribe(source, 'tile:state-changed', (msg) => {
    events.push(msg as StateChangedPayload);
  });
  return {
    events,
    stop: () => {
      unsubscribe(source, 'tile:state-changed');
    },
  };
}

// Walk the FSM into REGISTERED for a given tile so we have somewhere
// for LOAD to transition from.
function installRegistered(tileId: string, entryId: string): void {
  transition(tileId, entryId, TRIGGERS.INSTALL);
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('tile-lifecycle: tile:state-changed observer topic', () => {
  beforeEach(() => {
    resetForTests();
    __clearPrePublishHooksForTest();
  });

  it('publishes a tile:state-changed event on every successful transition', () => {
    const capture = captureStateChanged();
    try {
      installRegistered('fx', 'bg');
      transition('fx', 'bg', TRIGGERS.LOAD);
      transition('fx', 'bg', TRIGGERS.TILE_READY);

      assert.strictEqual(capture.events.length, 3);

      const [t0, t1, t2] = capture.events;
      assert.deepStrictEqual(
        { tileId: t0.tileId, entryId: t0.entryId, from: t0.from, to: t0.to, trigger: t0.trigger },
        { tileId: 'fx', entryId: 'bg', from: STATES.UNREGISTERED, to: STATES.REGISTERED, trigger: TRIGGERS.INSTALL },
      );
      assert.deepStrictEqual(
        { tileId: t1.tileId, entryId: t1.entryId, from: t1.from, to: t1.to, trigger: t1.trigger },
        { tileId: 'fx', entryId: 'bg', from: STATES.REGISTERED, to: STATES.LOADING, trigger: TRIGGERS.LOAD },
      );
      assert.deepStrictEqual(
        { tileId: t2.tileId, entryId: t2.entryId, from: t2.from, to: t2.to, trigger: t2.trigger },
        { tileId: 'fx', entryId: 'bg', from: STATES.LOADING, to: STATES.READY, trigger: TRIGGERS.TILE_READY },
      );
      // ts present on every event
      for (const ev of capture.events) {
        assert.strictEqual(typeof ev.ts, 'number');
      }
    } finally {
      capture.stop();
    }
  });

  it('does NOT publish on rejected transitions (disallowed trigger)', () => {
    const capture = captureStateChanged();
    try {
      // UNREGISTERED tile can't receive LOAD — transition is rejected.
      const result = transition('never', 'bg', TRIGGERS.LOAD);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(capture.events.length, 0);
    } finally {
      capture.stop();
    }
  });
});

describe('tile-lifecycle: bgWindow-ready gate', () => {
  beforeEach(() => {
    resetForTests();
    __clearPrePublishHooksForTest();
  });

  it('holds non-bgWindow requestLoad() until bgWindow signals ready', async () => {
    // Wire up the injected ready callback so simulate() can drive it.
    const readyCalls: Array<{ tileId: string; entryId: string }> = [];
    setReadyCallback((tileId, entryId) => {
      readyCalls.push({ tileId, entryId });
      // Advance bgWindow's FSM to READY so a realistic "bgWindow ready"
      // state actually exists. Not strictly required for the gate
      // semantics under test, but mirrors production.
      transition(tileId, entryId, TRIGGERS.TILE_READY);
    });

    // Register the core bgWindow + the feature tile.
    registerBgWindow('core', 'background');
    installRegistered('core', 'background');
    installRegistered('feature-a', 'bg');

    // bgWindow itself can load before signalling ready — otherwise the
    // FSM would deadlock against its own gate.
    transition('core', 'background', TRIGGERS.LOAD);

    // Start the feature-a load request. It must NOT resolve before
    // bgWindow signals ready.
    let featureSettled = false;
    const featurePromise = requestLoad('feature-a', 'bg').then((r) => {
      featureSettled = true;
      return r;
    });

    // Give the microtask queue a few turns — featurePromise should
    // remain pending because the latch is not released.
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(featureSettled, false, 'feature load should be held until bgWindow ready');
    assert.strictEqual(isBgWindowReady(), false);

    // Signal bgWindow ready — this unlatches feature-a's transition.
    __simulateLifecycleReadyForTest('core', 'background');
    assert.strictEqual(isBgWindowReady(), true);
    assert.deepStrictEqual(readyCalls, [{ tileId: 'core', entryId: 'background' }]);

    const result = await featurePromise;
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.to, STATES.LOADING);
  });

  it('resolves immediately for the bgWindow itself (no self-deadlock)', async () => {
    registerBgWindow('core', 'background');
    installRegistered('core', 'background');
    // bgWindow's own requestLoad should complete without waiting for
    // anything — the latch is not yet released.
    assert.strictEqual(isBgWindowReady(), false);
    const result = await requestLoad('core', 'background');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.to, STATES.LOADING);
  });

  it('resolves immediately once the latch is released', async () => {
    setReadyCallback(() => {});
    registerBgWindow('core', 'background');
    installRegistered('core', 'background');
    installRegistered('feature-b', 'bg');

    transition('core', 'background', TRIGGERS.LOAD);
    __simulateLifecycleReadyForTest('core', 'background');
    // bgWindow is now marked ready — subsequent feature loads should
    // resolve on the first tick.
    assert.strictEqual(isBgWindowReady(), true);
    const result = await requestLoad('feature-b', 'bg');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.to, STATES.LOADING);
  });

  it('waitForBgWindowReady() resolves exactly once bgWindow signals ready', async () => {
    registerBgWindow('core', 'background');
    setReadyCallback(() => {});

    let resolved = false;
    const p = waitForBgWindowReady().then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(resolved, false);

    __simulateLifecycleReadyForTest('core', 'background');
    await p;
    assert.strictEqual(resolved, true);
  });

  it('does not block when no bgWindow has been registered (fallback)', async () => {
    // Unit-test scenarios that never call registerBgWindow() must still
    // work — requestLoad falls through to an immediate transition.
    installRegistered('standalone', 'bg');
    const result = await requestLoad('standalone', 'bg');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.to, STATES.LOADING);
  });
});

describe('tile-lifecycle: subscribe-before-publish invariant', () => {
  beforeEach(() => {
    resetForTests();
    __clearPrePublishHooksForTest();
  });

  it('a subscriber registered at t=0 boot receives a cmd:register published immediately after', () => {
    // This simulates the core subscriber (inside app/index.js → cmd
    // background) landing synchronously during core init, BEFORE any
    // tile fires its first `cmd:register`. With the Phase 4 gate in
    // place, tiles can't transition REGISTERED→LOADING until bgWindow
    // signals ready — by that time these subscribers exist, so the
    // first publishes are never dropped.
    const received: unknown[] = [];
    const source = 'test-core-cmd-registry';
    subscribe(source, 'cmd:register', (msg) => {
      received.push(msg);
    });
    try {
      // Simulate a tile publishing its cmd:register. In the real
      // system the publish goes through `publish()` in pubsub.ts.
      // We call the same function directly here — the invariant under
      // test is about ordering, not about which process code path fires.
      publish(getSystemAddress(), 'cmd:register', {
        name: 'hello',
        source: 'fx',
      });

      assert.strictEqual(received.length, 1);
      assert.deepStrictEqual(received[0], { name: 'hello', source: 'fx' });
    } finally {
      unsubscribe(source, 'cmd:register');
    }
  });
});
