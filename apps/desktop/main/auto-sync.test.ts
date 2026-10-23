import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  AUTO_SYNC_INTERVAL_MS,
  createAutoSyncScheduler,
  shouldRunAutoSync,
  type AutoSyncState,
} from './auto-sync.js';

const on: AutoSyncState = { enabled: true, configured: true, inFlight: false };

describe('shouldRunAutoSync', () => {
  it('runs when enabled, configured and idle', () => {
    assert.strictEqual(shouldRunAutoSync(on), true);
  });
  it('skips when disabled', () => {
    assert.strictEqual(shouldRunAutoSync({ ...on, enabled: false }), false);
  });
  it('skips when no server URL or API key is configured', () => {
    assert.strictEqual(shouldRunAutoSync({ ...on, configured: false }), false);
  });
  it('skips when a sync is already running', () => {
    assert.strictEqual(shouldRunAutoSync({ ...on, inFlight: true }), false);
  });
  it('uses a 30 minute interval', () => {
    assert.strictEqual(AUTO_SYNC_INTERVAL_MS, 30 * 60 * 1000);
  });
});

describe('createAutoSyncScheduler', () => {
  function setup(initial: Partial<AutoSyncState> = {}) {
    const state: AutoSyncState = { ...on, ...initial };
    let runs = 0;
    const errors: unknown[] = [];
    const scheduler = createAutoSyncScheduler({
      getState: () => state,
      runSync: async () => { runs++; },
      intervalMs: 20,
      onError: (e) => errors.push(e),
    });
    return { state, scheduler, runs: () => runs, errors };
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('syncs immediately when turned on, then on each interval', async () => {
    const t = setup();
    t.scheduler.refresh();
    assert.strictEqual(t.runs(), 1);
    await wait(70);
    assert.ok(t.runs() >= 3, `expected repeat ticks, got ${t.runs()}`);
    t.scheduler.stop();
  });

  it('does nothing and holds no timer when disabled', async () => {
    const t = setup({ enabled: false });
    t.scheduler.refresh();
    assert.strictEqual(t.scheduler.isRunning(), false);
    await wait(50);
    assert.strictEqual(t.runs(), 0);
  });

  it('turning off clears the timer', async () => {
    const t = setup();
    t.scheduler.refresh();
    t.state.enabled = false;
    t.scheduler.refresh();
    const after = t.runs();
    assert.strictEqual(t.scheduler.isRunning(), false);
    await wait(60);
    assert.strictEqual(t.runs(), after);
  });

  it('refresh while already on does not sync again', () => {
    const t = setup();
    t.scheduler.refresh();
    t.scheduler.refresh();
    assert.strictEqual(t.runs(), 1);
    t.scheduler.stop();
  });

  it('skips ticks when unconfigured or in flight', async () => {
    const t = setup({ configured: false });
    t.scheduler.refresh();
    await wait(50);
    assert.strictEqual(t.runs(), 0);
    t.state.configured = true;
    t.state.inFlight = true;
    await wait(50);
    assert.strictEqual(t.runs(), 0);
    t.state.inFlight = false;
    await wait(50);
    assert.ok(t.runs() >= 1);
    t.scheduler.stop();
  });

  it('reports a failed sync without stopping the timer', async () => {
    const state: AutoSyncState = { ...on };
    const errors: unknown[] = [];
    const s = createAutoSyncScheduler({
      getState: () => state,
      runSync: async () => { throw new Error('boom'); },
      intervalMs: 20,
      onError: (e) => errors.push(e),
    });
    s.refresh();
    await wait(50);
    assert.ok(errors.length >= 2);
    assert.strictEqual(s.isRunning(), true);
    s.stop();
  });
});
