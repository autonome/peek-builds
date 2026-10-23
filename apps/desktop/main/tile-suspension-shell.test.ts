// Tile suspension shell: event feeding, timer, observe-only decisions, and the wake gate. Fake
// clock and timers; no electron.

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  createSuspensionShell,
  type SuspensionChange,
  type SuspensionShellDeps,
} from './tile-suspension-shell.js';

const MIN = 60 * 1000;

function harness(over: Partial<SuspensionShellDeps> = {}) {
  let now = 1_000_000;
  const timers: Array<{ at: number; fn: () => void; cleared: boolean }> = [];
  const changes: SuspensionChange[] = [];
  const logs: string[] = [];
  const unloads: string[] = [];
  const loaded = new Set<string>();
  const deps: SuspensionShellDeps = {
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
    publishChange: (c) => changes.push(c),
    log: (m) => logs.push(m),
    isTracked: (id) => id === 'notes',
    isLoaded: (id) => loaded.has(id),
    isBackgroundEntry: (_t, entry) => entry === 'background',
    configFor: () => ({}),
    unload: async (id) => { unloads.push(id); },
    onceOnTopic: (topic, fn) => {
      const entry = { topic, fn };
      listeners.push(entry);
      return () => { const i = listeners.indexOf(entry); if (i >= 0) listeners.splice(i, 1); };
    },
    ...over,
  };
  const listeners: Array<{ topic: string; fn: () => void }> = [];
  const publishTopic = (topic: string) => {
    for (const l of listeners.filter(x => x.topic === topic)) l.fn();
  };
  const shell = createSuspensionShell(deps);
  // Advance the clock, firing due timers in order.
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter(t => !t.cleared && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.cleared = true;
      now = Math.max(now, due.at);
      due.fn();
    }
    now = end;
  };
  return { shell, advance, changes, logs, unloads, loaded, timers, listeners, publishTopic };
}

async function wake(h: ReturnType<typeof harness>, id = 'notes'): Promise<void> {
  await h.shell.beginWake(id);
  h.shell.wakeReady(id);
}

describe('tile suspension shell', () => {
  it('ignores tiles that are not lazy', async () => {
    const h = harness();
    await h.shell.beginWake('other');
    assert.equal(h.shell.getPolicy('other'), null);
    assert.equal(h.changes.length, 0);
  });

  it('publishes each policy change of a woken tile', async () => {
    const h = harness();
    await wake(h);
    assert.deepEqual(h.changes.map(c => `${c.from}>${c.to}`), ['suspended>waking', 'waking>idle']);
    assert.ok(h.changes.every(c => c.observeOnly));
  });

  it('observe-only: reports a would-suspend decision after the idle time and unloads nothing', async () => {
    const h = harness();
    await wake(h);
    h.changes.length = 0;
    h.advance(10 * MIN + 1);
    assert.equal(h.changes.length, 1);
    assert.equal(h.changes[0].wouldSuspend, true);
    assert.equal(h.changes[0].to, 'suspending');
    assert.equal(h.changes[0].idleMs, 10 * MIN);
    assert.deepEqual(h.unloads, []);
    // The tile is still loaded, so the policy returns to idle with a fresh clock.
    assert.equal(h.shell.getPolicy('notes'), 'idle');
    h.advance(10 * MIN + 1);
    assert.equal(h.changes.filter(c => c.wouldSuspend).length, 2);
  });

  it('a setting change to a shorter idle time applies to an already-loaded tile', async () => {
    const h = harness();
    await wake(h);
    h.changes.length = 0;
    h.shell.settingChanged({ idleMs: 2 * MIN });
    h.advance(2 * MIN + 1);
    assert.equal(h.changes.filter(c => c.wouldSuspend).length, 1);
    assert.equal(h.changes[0].idleMs, 2 * MIN);
  });

  it('turning suspension off stops decisions and turning it on resumes them', async () => {
    const h = harness();
    await wake(h);
    h.changes.length = 0;
    h.shell.settingChanged({ enabled: false });
    h.advance(30 * MIN);
    assert.equal(h.changes.length, 0);
    // Already idle for 30 minutes, so it is due as soon as the switch is back on.
    h.shell.settingChanged({ enabled: true });
    h.advance(1);
    assert.equal(h.changes.filter(c => c.wouldSuspend).length, 1);
  });

  it('a setting changed before a tile is first seen applies to it', async () => {
    const h = harness();
    h.shell.settingChanged({ idleMs: 3 * MIN });
    await wake(h);
    h.changes.length = 0;
    h.advance(3 * MIN + 1);
    assert.equal(h.changes.filter(c => c.wouldSuspend).length, 1);
  });

  it('a tile hold blocks suspension until released', async () => {
    const h = harness();
    await wake(h);
    h.shell.acquireHold('notes', 'a');
    h.shell.acquireHold('notes', 'b');
    h.advance(12 * MIN);
    assert.equal(h.changes.filter(c => c.wouldSuspend).length, 0);
    h.shell.releaseHold('notes', 'a');
    h.advance(12 * MIN);
    assert.equal(h.changes.filter(c => c.wouldSuspend).length, 0);
    h.shell.releaseHold('notes', 'b');
    h.advance(10 * MIN + 1);
    assert.equal(h.changes.filter(c => c.wouldSuspend).length, 1);
  });

  it('a hold on a tile that is not lazy is ignored', () => {
    const h = harness();
    h.shell.acquireHold('other', 'a');
    assert.equal(h.shell.getPolicy('other'), null);
  });

  it('a tile override outranks the user setting when it changes', async () => {
    const h = harness({ configFor: () => ({ enabled: false }) });
    await wake(h);
    h.shell.settingChanged({ enabled: true, idleMs: 1 * MIN });
    h.advance(30 * MIN);
    assert.equal(h.changes.filter(c => c.wouldSuspend).length, 0);
    assert.equal(h.shell.getState('notes')?.config.idleMs, 1 * MIN);
  });

  it('activity pushes the deadline out', async () => {
    const h = harness();
    await wake(h);
    h.advance(9 * MIN);
    h.shell.activity('notes');
    h.advance(9 * MIN);
    assert.equal(h.changes.filter(c => c.wouldSuspend).length, 0);
    h.advance(2 * MIN);
    assert.equal(h.changes.filter(c => c.wouldSuspend).length, 1);
  });

  it('a tile window keeps the tile active; the background entry window does not count', async () => {
    const h = harness();
    await wake(h);
    h.shell.tileWindowOpened('notes', 'background', '1');
    assert.equal(h.shell.getPolicy('notes'), 'idle');
    h.shell.tileWindowOpened('notes', 'home', '2');
    assert.equal(h.shell.getPolicy('notes'), 'active');
    h.advance(30 * MIN);
    assert.equal(h.changes.filter(c => c.wouldSuspend).length, 0);
    h.shell.tileWindowClosed('notes', 'home', '2');
    assert.equal(h.shell.getPolicy('notes'), 'idle');
  });

  it('an owned keepLive window keeps the tile active', async () => {
    const h = harness();
    await wake(h);
    h.shell.ownedWindowOpened('notes', '7');
    assert.equal(h.shell.getPolicy('notes'), 'active');
    h.shell.ownedWindowClosed('notes', '7');
    assert.equal(h.shell.getPolicy('notes'), 'idle');
  });

  it('a pending dispatch blocks suspension until it settles', async () => {
    const h = harness();
    await h.shell.beginWake('notes');
    h.shell.dispatchPending('notes');
    h.shell.wakeReady('notes');
    assert.equal(h.shell.getPolicy('notes'), 'active');
    h.shell.dispatchSettled('notes');
    assert.equal(h.shell.getPolicy('notes'), 'idle');
  });

  it('a tile first seen already loaded starts idle', () => {
    const h = harness();
    h.loaded.add('notes');
    h.shell.activity('notes');
    assert.equal(h.shell.getPolicy('notes'), 'idle');
  });

  it('crash and disable return the tile to not-tracked / suspended', async () => {
    const h = harness();
    await wake(h);
    h.shell.crashed('notes');
    assert.equal(h.shell.getPolicy('notes'), 'suspended');
    await wake(h);
    h.shell.disabled('notes');
    assert.equal(h.shell.getPolicy('notes'), null);
  });

  it('live mode: unloads, and a wake during the unload waits for it then proceeds', async () => {
    let finishUnload: () => void = () => {};
    const h = harness({
      observeOnly: false,
      unload: (id) => new Promise<void>((resolve) => { finishUnload = () => { h2.unloads.push(id); resolve(); }; }),
    });
    const h2 = h;
    await wake(h);
    h.advance(10 * MIN + 1);
    assert.equal(h.shell.getPolicy('notes'), 'suspending');
    let released = false;
    const gate = h.shell.beginWake('notes').then(() => { released = true; });
    await Promise.resolve();
    assert.equal(released, false, 'wake is held while suspending');
    finishUnload();
    await gate;
    assert.equal(released, true);
    assert.equal(h.shell.getPolicy('notes'), 'waking');
    h.shell.wakeReady('notes');
    assert.equal(h.shell.getPolicy('notes'), 'idle');
  });

  it('a result-topic command holds the tile until the result is published', async () => {
    const h = harness();
    await wake(h);
    h.shell.holdForResult('notes', 'cmd:execute:go:result');
    assert.equal(h.shell.getPolicy('notes'), 'active');
    h.advance(20_000);
    assert.equal(h.shell.getPolicy('notes'), 'active');
    h.publishTopic('cmd:execute:go:result');
    assert.equal(h.shell.getPolicy('notes'), 'idle');
    assert.equal(h.listeners.length, 0);
    // The timeout timer is cancelled and idle time counts from the release.
    h.advance(9 * MIN);
    assert.equal(h.changes.filter(c => c.wouldSuspend).length, 0);
    h.advance(2 * MIN);
    assert.equal(h.changes.filter(c => c.wouldSuspend).length, 1);
  });

  it('a result hold ends after 30 s when no result is published', async () => {
    const h = harness();
    await wake(h);
    h.shell.holdForResult('notes', 'r');
    h.advance(29_000);
    assert.equal(h.shell.getPolicy('notes'), 'active');
    h.advance(1_500);
    assert.equal(h.shell.getPolicy('notes'), 'idle');
    assert.equal(h.listeners.length, 0, 'listener removed on timeout');
  });

  it('two commands hold independently, and a late result after the timeout changes nothing', async () => {
    const h = harness();
    await wake(h);
    h.shell.holdForResult('notes', 'a');
    h.advance(10_000);
    h.shell.holdForResult('notes', 'b');
    h.publishTopic('a');
    assert.equal(h.shell.getPolicy('notes'), 'active');
    h.publishTopic('b');
    assert.equal(h.shell.getPolicy('notes'), 'idle');
    h.publishTopic('b');
    assert.equal(h.shell.getPolicy('notes'), 'idle');
  });

  it('disabling a tile drops its result holds and listeners', async () => {
    const h = harness();
    await wake(h);
    h.shell.holdForResult('notes', 'r');
    h.shell.disabled('notes');
    assert.equal(h.listeners.length, 0);
    assert.equal(h.shell.getPolicy('notes'), null);
  });

  it('a result hold for a tile that is not lazy is ignored', () => {
    const h = harness();
    h.shell.holdForResult('other', 'r');
    assert.equal(h.listeners.length, 0);
  });

  it('a wake while not suspending does not wait', async () => {
    const h = harness();
    await wake(h);
    await h.shell.beginWake('notes');
  });
});
