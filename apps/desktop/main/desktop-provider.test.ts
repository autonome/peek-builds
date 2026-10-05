/**
 * Desktop provider tests — specs/kernel-desktops.md, section 7.1 "Provider tests".
 *
 * Pure: no Electron, runs under ELECTRON_RUN_AS_NODE. The fallback provider is fed a stubbed
 * screen list; the fail-safe wrapper runs against a fake platform provider whose answers each
 * case scripts. Every failure case ends on the fallback provider with exactly one
 * `desktop-provider fallback` line.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  FailSafeDesktopProvider,
  isPlacementList,
  isProviderLayout,
  type DesktopChange,
  type DesktopProvider,
  type Placement,
  type PlatformWindowId,
  type ProviderLayout,
} from './desktop-provider.js';
import { FallbackDesktopProvider, type FallbackScreenSource } from './desktop-provider-fallback.js';
import { MacDesktopProvider, macHelperPath, windowNumberFromSourceId } from './desktop-provider-mac.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function stubScreens(
  screens: string[],
  windowScreens: Record<number, string | null> = {},
  everyDesktop: number[] = [],
): FallbackScreenSource {
  return {
    screens: () => screens,
    windowScreen: (win) => windowScreens[win] ?? null,
    onEveryDesktop: (win) => everyDesktop.includes(win),
  };
}

const PLATFORM_LAYOUT: ProviderLayout = {
  screens: [{ display: '69733378', current: '3' }],
  desktops: [
    { id: '3', display: '69733378' },
    { id: '7', display: '69733378' },
  ],
};

const never = <T>(): Promise<T> => new Promise<T>(() => {});

/** A platform provider whose every answer the test scripts. */
class FakeProvider implements DesktopProvider {
  readonly name = 'fake';
  canPlaceWindows = false;
  canShowDesktops = false;
  started = false;
  stopped = false;
  emit: ((change: DesktopChange) => void) | null = null;
  startImpl: () => Promise<void> = async () => {};
  layoutImpl: () => Promise<unknown> = async () => PLATFORM_LAYOUT;
  placementsImpl: (w: PlatformWindowId[]) => Promise<unknown> = async (w) =>
    w.map((window) => ({ window, display: '69733378', desktop: '7', onEveryDesktop: false }));

  async start(onChange: (change: DesktopChange) => void): Promise<void> {
    this.emit = onChange;
    await this.startImpl();
    this.started = true;
  }
  layout(): Promise<ProviderLayout> {
    return this.layoutImpl() as Promise<ProviderLayout>;
  }
  placements(windows: PlatformWindowId[]): Promise<Placement[]> {
    return this.placementsImpl(windows) as Promise<Placement[]>;
  }
  async placeWindow(): Promise<boolean> {
    return false;
  }
  async showDesktop(): Promise<boolean> {
    return false;
  }
  stop(): void {
    this.stopped = true;
  }
}

/** A timer the test fires by hand: records each scheduled call and its delay. */
function manualTimer() {
  const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  return {
    scheduled,
    schedule: (fn: () => void, ms: number) => {
      const entry = { fn, ms, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    /** Runs the oldest pending call, if any; true when one ran. */
    fire: async (): Promise<boolean> => {
      const entry = scheduled.find((e) => !e.cancelled);
      if (!entry) return false;
      entry.cancelled = true;
      entry.fn();
      await flush();
      await flush();
      return true;
    },
    pendingMs: () => scheduled.filter((e) => !e.cancelled).map((e) => e.ms),
  };
}

function harness(primary: FakeProvider | null, extra: { reprobeBackoffMs?: number[] } = {}) {
  const lines: string[] = [];
  const changes: DesktopChange[] = [];
  const timer = manualTimer();
  const fallback = new FallbackDesktopProvider(stubScreens(['1', '2'], { 10: '2' }, [11]));
  const provider = new FailSafeDesktopProvider({
    primary,
    fallback,
    log: (line) => lines.push(line),
    handshakeTimeoutMs: 20,
    requestTimeoutMs: 20,
    retryTimeoutMs: 20,
    schedule: timer.schedule,
    ...extra,
  });
  const fallbackLines = () => lines.filter((l) => l.startsWith('desktop-provider fallback '));
  return {
    provider,
    lines,
    changes,
    timer,
    fallbackLines,
    onChange: (c: DesktopChange) => changes.push(c),
  };
}

const FALLBACK_LAYOUT: ProviderLayout = {
  screens: [
    { display: '1', current: '1/only' },
    { display: '2', current: '2/only' },
  ],
  desktops: [
    { id: '1/only', display: '1' },
    { id: '2/only', display: '2' },
  ],
};

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('desktop-provider: fallback provider', () => {
  it('reports one desktop per screen, each current, id <screen>/only', async () => {
    const p = new FallbackDesktopProvider(stubScreens(['1', '2']));
    assert.deepStrictEqual(await p.layout(), FALLBACK_LAYOUT);
  });

  it('follows the backend screen list on every request', async () => {
    const screens = ['1'];
    const p = new FallbackDesktopProvider({ ...stubScreens([]), screens: () => screens });
    assert.strictEqual((await p.layout()).screens.length, 1);
    screens.push('5');
    assert.deepStrictEqual((await p.layout()).desktops.map((d) => d.id), ['1/only', '5/only']);
  });

  it('places a window on its screen\'s only desktop, with the backend\'s declaration', async () => {
    const p = new FallbackDesktopProvider(stubScreens(['1', '2'], { 10: '2', 11: '1' }, [11]));
    assert.deepStrictEqual(await p.placements([10, 11]), [
      { window: 10, display: '2', desktop: '2/only', onEveryDesktop: false },
      { window: 11, display: '1', desktop: '1/only', onEveryDesktop: true },
    ]);
  });

  it('puts a window of unknown or vanished screen on the first screen', async () => {
    const p = new FallbackDesktopProvider(stubScreens(['1', '2'], { 12: '9' }));
    assert.deepStrictEqual(await p.placements([12, 13]), [
      { window: 12, display: '1', desktop: '1/only', onEveryDesktop: false },
      { window: 13, display: '1', desktop: '1/only', onEveryDesktop: false },
    ]);
  });

  it('with no screens, reports an empty layout and no desktop', async () => {
    const p = new FallbackDesktopProvider(stubScreens([]));
    assert.deepStrictEqual(await p.layout(), { screens: [], desktops: [] });
    assert.deepStrictEqual(await p.placements([1]), [
      { window: 1, display: null, desktop: null, onEveryDesktop: false },
    ]);
  });

  it('cannot place windows or switch desktops, and never reports a change', async () => {
    const p = new FallbackDesktopProvider(stubScreens(['1']));
    const changes: DesktopChange[] = [];
    await p.start((c) => changes.push(c));
    assert.strictEqual(p.canPlaceWindows, false);
    assert.strictEqual(p.canShowDesktops, false);
    assert.strictEqual(await p.placeWindow(1, '1/only'), false);
    assert.strictEqual(await p.showDesktop('1/only'), false);
    assert.deepStrictEqual(changes, []);
  });

  it('its answers pass the fail-safe validation', async () => {
    const p = new FallbackDesktopProvider(stubScreens(['1', '2'], { 10: '2' }));
    assert.ok(isProviderLayout(await p.layout()));
    assert.ok(isPlacementList(await p.placements([10, 11]), [10, 11]));
  });
});

describe('desktop-provider: validation', () => {
  it('accepts a shared-desktops layout (display null)', () => {
    assert.ok(
      isProviderLayout({
        screens: [{ display: null, current: '4' }],
        desktops: [
          { id: '4', display: null },
          { id: '5', display: null },
        ],
      }),
    );
  });

  it('rejects a layout whose current desktop is not listed, and wrong shapes', () => {
    assert.ok(!isProviderLayout({ screens: [{ display: '1', current: '9' }], desktops: [] }));
    assert.ok(!isProviderLayout({ screens: [], desktops: [{ id: 4, display: null }] }));
    assert.ok(!isProviderLayout({ screens: 'x', desktops: [] }));
    assert.ok(!isProviderLayout(null));
  });

  it('rejects placements that do not answer exactly the windows asked', () => {
    const ok = { window: 1, display: '1', desktop: '1/only', onEveryDesktop: false };
    assert.ok(isPlacementList([ok], [1]));
    assert.ok(!isPlacementList([ok], [1, 2]));
    assert.ok(!isPlacementList([ok, ok], [1, 2]));
    assert.ok(!isPlacementList([{ ...ok, window: 2 }], [1]));
    assert.ok(!isPlacementList([{ ...ok, onEveryDesktop: 'no' }], [1]));
    assert.ok(!isPlacementList([{ ...ok, desktop: 7 }], [1]));
  });
});

describe('desktop-provider: fail-safe', () => {
  it('a healthy platform provider answers, logs started, and never falls back', async () => {
    const fake = new FakeProvider();
    const h = harness(fake);
    await h.provider.start(h.onChange);
    assert.strictEqual(h.provider.name, 'fake');
    assert.deepStrictEqual(await h.provider.layout(), PLATFORM_LAYOUT);
    assert.deepStrictEqual(await h.provider.placements([10]), [
      { window: 10, display: '69733378', desktop: '7', onEveryDesktop: false },
    ]);
    fake.emit?.({ kind: 'current-desktop-changed', display: '69733378' });
    assert.deepStrictEqual(h.changes, [{ kind: 'current-desktop-changed', display: '69733378' }]);
    assert.deepStrictEqual(h.lines, ['desktop-provider started name=fake']);
    assert.strictEqual(h.provider.onFallback, false);
  });

  it('no platform provider: fallback from the start, one line', async () => {
    const h = harness(null);
    await h.provider.start(h.onChange);
    assert.strictEqual(h.provider.name, 'fallback');
    assert.deepStrictEqual(h.fallbackLines(), ['desktop-provider fallback reason=no-provider']);
    assert.deepStrictEqual(await h.provider.layout(), FALLBACK_LAYOUT);
  });

  it('start rejected (binary missing, symbols unavailable): fallback, reason carried', async () => {
    const fake = new FakeProvider();
    fake.startImpl = async () => {
      throw new Error('private calls unavailable');
    };
    const h = harness(fake);
    await h.provider.start(h.onChange);
    assert.strictEqual(h.provider.name, 'fallback');
    assert.deepStrictEqual(h.fallbackLines(), [
      'desktop-provider fallback reason=start-failed:private_calls_unavailable',
    ]);
    assert.strictEqual(fake.stopped, true);
  });

  it('handshake unanswered: fallback after the handshake timeout', async () => {
    const fake = new FakeProvider();
    fake.startImpl = never;
    const h = harness(fake);
    await h.provider.start(h.onChange);
    assert.strictEqual(h.provider.name, 'fallback');
    assert.deepStrictEqual(h.fallbackLines(), ['desktop-provider fallback reason=handshake-timeout']);
    assert.strictEqual(fake.stopped, true);
    assert.deepStrictEqual(await h.provider.layout(), FALLBACK_LAYOUT);
  });

  it('request timeout: the request is answered by the fallback, backend told to re-read', async () => {
    const fake = new FakeProvider();
    fake.layoutImpl = never;
    const h = harness(fake);
    await h.provider.start(h.onChange);
    assert.deepStrictEqual(await h.provider.layout(), FALLBACK_LAYOUT);
    await flush();
    assert.deepStrictEqual(h.fallbackLines(), ['desktop-provider fallback reason=request-timeout:layout']);
    assert.deepStrictEqual(h.changes, [{ kind: 'layout-changed' }]);
    assert.strictEqual(fake.stopped, true);
    assert.strictEqual(h.provider.onFallback, true);
  });

  it('malformed data: fallback placements answer the request', async () => {
    const fake = new FakeProvider();
    fake.placementsImpl = async () => [{ window: 10, desktop: 7 }];
    const h = harness(fake);
    await h.provider.start(h.onChange);
    assert.deepStrictEqual(await h.provider.placements([10, 11]), [
      { window: 10, display: '2', desktop: '2/only', onEveryDesktop: false },
      { window: 11, display: '1', desktop: '1/only', onEveryDesktop: true },
    ]);
    assert.deepStrictEqual(h.fallbackLines(), ['desktop-provider fallback reason=malformed:placements']);
  });

  it('provider exit: fallback, backend told to re-read, later changes from it ignored', async () => {
    const fake = new FakeProvider();
    const h = harness(fake);
    await h.provider.start(h.onChange);
    const emit = fake.emit!;
    emit({ kind: 'failed', reason: 'helper-exit code=1' });
    await flush();
    assert.deepStrictEqual(h.fallbackLines(), ['desktop-provider fallback reason=helper-exit_code=1']);
    assert.deepStrictEqual(h.changes, [{ kind: 'layout-changed' }]);
    emit({ kind: 'current-desktop-changed', display: '69733378' });
    assert.deepStrictEqual(h.changes, [{ kind: 'layout-changed' }]);
    assert.strictEqual(h.provider.name, 'fallback');
  });

  it('several failures log one line and never return to the platform provider', async () => {
    const fake = new FakeProvider();
    fake.layoutImpl = never;
    fake.placementsImpl = async () => 'garbage';
    const h = harness(fake);
    await h.provider.start(h.onChange);
    const [layout, placements] = await Promise.all([h.provider.layout(), h.provider.placements([10])]);
    assert.deepStrictEqual(layout, FALLBACK_LAYOUT);
    assert.deepStrictEqual(placements, [
      { window: 10, display: '2', desktop: '2/only', onEveryDesktop: false },
    ]);
    fake.emit?.({ kind: 'failed', reason: 'exit' });
    await h.provider.layout();
    await flush();
    assert.strictEqual(h.fallbackLines().length, 1);
    assert.strictEqual(h.provider.name, 'fallback');
  });

  it('a platform provider failing while it starts ends on the fallback without a started line', async () => {
    const fake = new FakeProvider();
    fake.startImpl = async () => {
      fake.emit?.({ kind: 'failed', reason: 'exit' });
    };
    const h = harness(fake);
    await h.provider.start(h.onChange);
    await flush();
    assert.deepStrictEqual(h.lines, ['desktop-provider fallback reason=exit']);
    assert.strictEqual(h.provider.name, 'fallback');
  });

  it('write calls return false without a capability, never reaching the provider', async () => {
    const fake = new FakeProvider();
    let reached = false;
    fake.placeWindow = async () => {
      reached = true;
      return true;
    };
    const h = harness(fake);
    await h.provider.start(h.onChange);
    assert.strictEqual(await h.provider.placeWindow(10, '7'), false);
    assert.strictEqual(await h.provider.showDesktop('7'), false);
    assert.strictEqual(reached, false);
    assert.strictEqual(h.fallbackLines().length, 0);
  });

  it('a one-off slow reply is retried with a longer timeout and does not cause fallback', async () => {
    const fake = new FakeProvider();
    let calls = 0;
    fake.layoutImpl = async () => {
      calls += 1;
      if (calls === 1) return new Promise<unknown>(() => {});
      return PLATFORM_LAYOUT;
    };
    const h = harness(fake);
    await h.provider.start(h.onChange);
    assert.deepStrictEqual(await h.provider.layout(), PLATFORM_LAYOUT);
    await flush();
    assert.strictEqual(calls, 2);
    assert.strictEqual(h.fallbackLines().length, 0);
    assert.deepStrictEqual(h.lines, [
      'desktop-provider started name=fake',
      'desktop-provider retry op=layout',
    ]);
    assert.strictEqual(h.provider.name, 'fake');
    assert.strictEqual(h.provider.onFallback, false);
    assert.deepStrictEqual(h.changes, []);
    assert.strictEqual(fake.stopped, false);
  });

  it('the retry waits longer than the first attempt', async () => {
    const fake = new FakeProvider();
    let calls = 0;
    fake.layoutImpl = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 60));
      return PLATFORM_LAYOUT;
    };
    const lines: string[] = [];
    const provider = new FailSafeDesktopProvider({
      primary: fake,
      fallback: new FallbackDesktopProvider(stubScreens(['1'])),
      log: (line) => lines.push(line),
      requestTimeoutMs: 20,
      retryTimeoutMs: 500,
      schedule: manualTimer().schedule,
    });
    await provider.start(() => {});
    assert.deepStrictEqual(await provider.layout(), PLATFORM_LAYOUT);
    assert.strictEqual(calls, 2);
    assert.ok(lines.every((l) => !l.startsWith('desktop-provider fallback ')));
  });

  it('a request slow twice falls back, naming the request timeout', async () => {
    const fake = new FakeProvider();
    fake.layoutImpl = never;
    const h = harness(fake);
    await h.provider.start(h.onChange);
    assert.deepStrictEqual(await h.provider.layout(), FALLBACK_LAYOUT);
    assert.deepStrictEqual(h.lines.slice(1), [
      'desktop-provider retry op=layout',
      'desktop-provider fallback reason=request-timeout:layout',
    ]);
  });

  it('a dead helper falls back at once, without a retry', async () => {
    const fake = new FakeProvider();
    const h = harness(fake);
    await h.provider.start(h.onChange);
    fake.emit?.({ kind: 'failed', reason: 'helper-exit code=1' });
    await flush();
    assert.strictEqual(h.provider.name, 'fallback');
    assert.ok(h.lines.every((l) => !l.startsWith('desktop-provider retry')));
  });

  it('a request rejected by a dead helper falls back at once, without a retry', async () => {
    const fake = new FakeProvider();
    fake.layoutImpl = async () => {
      throw new Error('helper-exit code=1');
    };
    const h = harness(fake);
    await h.provider.start(h.onChange);
    assert.deepStrictEqual(await h.provider.layout(), FALLBACK_LAYOUT);
    assert.deepStrictEqual(h.lines.slice(1), [
      'desktop-provider fallback reason=request-failed:layout:helper-exit_code=1',
    ]);
  });

  it('after a failure the platform provider is probed again after the backoff and recovers', async () => {
    const fake = new FakeProvider();
    let healthy = false;
    fake.layoutImpl = async () => (healthy ? PLATFORM_LAYOUT : new Promise<unknown>(() => {}));
    const h = harness(fake);
    await h.provider.start(h.onChange);
    assert.deepStrictEqual(await h.provider.layout(), FALLBACK_LAYOUT);
    await flush();
    assert.deepStrictEqual(h.timer.pendingMs(), [5_000]);
    assert.strictEqual(h.provider.name, 'fallback');
    assert.deepStrictEqual(h.changes, [{ kind: 'layout-changed' }]);

    healthy = true;
    assert.strictEqual(await h.timer.fire(), true);
    assert.strictEqual(h.provider.name, 'fake');
    assert.strictEqual(h.provider.onFallback, false);
    assert.deepStrictEqual(await h.provider.layout(), PLATFORM_LAYOUT);
    assert.deepStrictEqual(h.changes, [{ kind: 'layout-changed' }, { kind: 'layout-changed' }]);
    assert.ok(h.lines.includes('desktop-provider recovered name=fake'));
    assert.deepStrictEqual(h.timer.pendingMs(), []);
    // Changes reported by the recovered provider reach the backend again.
    fake.emit?.({ kind: 'current-desktop-changed', display: '69733378' });
    assert.deepStrictEqual(h.changes[h.changes.length - 1], {
      kind: 'current-desktop-changed',
      display: '69733378',
    });
  });

  it('a failed probe backs off 5s, then 30s, and stays at 30s', async () => {
    const fake = new FakeProvider();
    fake.layoutImpl = never;
    const h = harness(fake);
    await h.provider.start(h.onChange);
    await h.provider.layout();
    assert.deepStrictEqual(h.timer.pendingMs(), [5_000]);
    fake.startImpl = async () => {
      throw new Error('still-down');
    };
    await h.timer.fire();
    assert.deepStrictEqual(h.timer.pendingMs(), [30_000]);
    await h.timer.fire();
    assert.deepStrictEqual(h.timer.pendingMs(), [30_000]);
    await h.timer.fire();
    assert.deepStrictEqual(h.timer.pendingMs(), [30_000]);
    assert.strictEqual(h.provider.name, 'fallback');
    assert.strictEqual(h.fallbackLines().length, 1);
    // It comes back once the helper answers.
    fake.startImpl = async () => {};
    fake.layoutImpl = async () => PLATFORM_LAYOUT;
    await h.timer.fire();
    assert.strictEqual(h.provider.name, 'fake');
  });

  it('a helper that dies later is probed again too', async () => {
    const fake = new FakeProvider();
    const h = harness(fake);
    await h.provider.start(h.onChange);
    fake.emit?.({ kind: 'failed', reason: 'helper-exit code=1' });
    await flush();
    assert.deepStrictEqual(h.timer.pendingMs(), [5_000]);
    await h.timer.fire();
    assert.strictEqual(h.provider.name, 'fake');
  });

  it('a platform provider that cannot start at all is not probed again', async () => {
    const fake = new FakeProvider();
    fake.startImpl = async () => {
      throw new Error('helper-missing');
    };
    const h = harness(fake);
    await h.provider.start(h.onChange);
    assert.deepStrictEqual(h.timer.pendingMs(), []);
    const none = harness(null);
    await none.provider.start(none.onChange);
    assert.deepStrictEqual(none.timer.pendingMs(), []);
  });

  it('stopping the provider cancels a pending probe', async () => {
    const fake = new FakeProvider();
    fake.layoutImpl = never;
    const h = harness(fake);
    await h.provider.start(h.onChange);
    await h.provider.layout();
    h.provider.stop();
    assert.deepStrictEqual(h.timer.pendingMs(), []);
  });
});

// ─── macOS provider against a fake helper ────────────────────────────────────
// A Node script speaking the helper protocol (native/desktop-helper/main.swift header). Its
// first argument picks the behaviour each case needs.

const FAKE_HELPER = String.raw`
const mode = process.argv[2];
const symbols = {
  CGSMainConnectionID: true,
  CGSCopyManagedDisplaySpaces: mode !== 'no-symbols',
  CGSCopySpacesForWindows: true,
  CGSMoveWindowsToManagedSpace: false,
};
const layouts = {
  separate: {
    screens: [{ display: '1', current: '3' }, { display: '4', current: '9' }],
    desktops: [{ id: '3', display: '1' }, { id: '7', display: '1' }, { id: '9', display: '4' }],
  },
  shared: {
    screens: [{ display: null, current: '5' }],
    desktops: [{ id: '5', display: null }, { id: '6', display: null }],
  },
};
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const req = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (req.op === 'hello') {
      if (mode === 'silent') continue;
      if (mode === 'exit-at-hello') process.exit(2);
      say({ id: req.id, ok: true, result: { version: 1, symbols } });
    } else if (req.op === 'layout') {
      if (mode === 'slow') continue;
      if (mode === 'malformed') { process.stdout.write('{not json\n'); continue; }
      if (mode === 'exit') process.exit(3);
      say({ id: req.id, ok: true, result: mode === 'shared' ? layouts.shared : layouts.separate });
    } else if (req.op === 'placements') {
      say({ id: req.id, ok: true, result: req.windows.map((w) => (
        w === 100 ? { window: w, display: null, desktop: null, onEveryDesktop: true }
                  : { window: w, display: '1', desktop: '7', onEveryDesktop: false }
      )) });
    } else if (req.op === 'place') {
      say({ id: req.id, ok: true, result: { attempted: false, desktops: ['7'] } });
    } else {
      say({ id: req.id, ok: false, error: 'unknown-op' });
    }
  }
});
`;

let fakeHelperFile: string | null = null;
function fakeHelper(): string {
  if (fakeHelperFile === null) {
    fakeHelperFile = join(mkdtempSync(join(tmpdir(), 'peek-fake-desktop-helper-')), 'helper.cjs');
    writeFileSync(fakeHelperFile, FAKE_HELPER);
  }
  return fakeHelperFile;
}

function macHarness(mode: string, timeouts: { handshake?: number; request?: number } = {}) {
  const mac = new MacDesktopProvider({
    command: process.execPath,
    args: [fakeHelper(), mode],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const lines: string[] = [];
  const changes: DesktopChange[] = [];
  const provider = new FailSafeDesktopProvider({
    primary: mac,
    fallback: new FallbackDesktopProvider(stubScreens(['1', '2'], { 10: '2' })),
    log: (line) => lines.push(line),
    handshakeTimeoutMs: timeouts.handshake ?? 10_000,
    requestTimeoutMs: timeouts.request ?? 5_000,
    retryTimeoutMs: timeouts.request ?? 5_000,
    schedule: () => () => {},
  });
  const fallbackLines = () => lines.filter((l) => l.startsWith('desktop-provider fallback '));
  return { mac, provider, lines, changes, fallbackLines, onChange: (c: DesktopChange) => changes.push(c) };
}

/** Waits until `cond` holds, polling; fails the test after `ms`. */
async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const FALLBACK_TWO_SCREENS: ProviderLayout = {
  screens: [
    { display: '1', current: '1/only' },
    { display: '2', current: '2/only' },
  ],
  desktops: [
    { id: '1/only', display: '1' },
    { id: '2/only', display: '2' },
  ],
};

describe('desktop-provider: macOS provider (fake helper)', () => {
  it('locates the helper in Resources when packaged and in dist/native from source', () => {
    assert.strictEqual(macHelperPath(true, '/R'), join('/R', 'peek-desktop-helper'));
    assert.match(macHelperPath(false, '/R'), /dist[/\\]native[/\\]peek-desktop-helper$/);
  });

  it('reads the window server number out of a capture source id', () => {
    assert.strictEqual(windowNumberFromSourceId('window:4242:0'), 4242);
    assert.strictEqual(windowNumberFromSourceId('window:0:0'), null);
    assert.strictEqual(windowNumberFromSourceId('screen:1:0'), null);
    assert.strictEqual(windowNumberFromSourceId('window:12'), null);
    assert.strictEqual(windowNumberFromSourceId(''), null);
  });

  it('starts, parses layout and placements, and keeps the resolved symbols', async () => {
    const h = macHarness('ok');
    await h.provider.start(h.onChange);
    assert.deepStrictEqual(h.lines, ['desktop-provider started name=mac']);
    assert.strictEqual(h.mac.hello?.symbols.CGSCopySpacesForWindows, true);
    assert.deepStrictEqual(await h.provider.layout(), {
      screens: [
        { display: '1', current: '3' },
        { display: '4', current: '9' },
      ],
      desktops: [
        { id: '3', display: '1' },
        { id: '7', display: '1' },
        { id: '9', display: '4' },
      ],
    });
    assert.deepStrictEqual(await h.provider.placements([10, 100]), [
      { window: 10, display: '1', desktop: '7', onEveryDesktop: false },
      { window: 100, display: null, desktop: null, onEveryDesktop: true },
    ]);
    assert.deepStrictEqual(await h.mac.probePlace(10, '3'), { attempted: false, desktops: ['7'] });
    assert.strictEqual(await h.provider.placeWindow(10, '3'), false);
    assert.strictEqual(h.provider.onFallback, false);
    h.provider.stop();
  });

  it('reports a shared-desktops layout with display null', async () => {
    const h = macHarness('shared');
    await h.provider.start(h.onChange);
    const layout = await h.provider.layout();
    assert.deepStrictEqual(layout.screens, [{ display: null, current: '5' }]);
    assert.ok(layout.desktops.every((d) => d.display === null));
    assert.strictEqual(h.fallbackLines().length, 0);
    h.provider.stop();
  });

  it('binary missing: fallback, one line', async () => {
    const mac = new MacDesktopProvider({ command: join(tmpdir(), 'no-such-peek-desktop-helper') });
    const lines: string[] = [];
    const provider = new FailSafeDesktopProvider({
      primary: mac,
      fallback: new FallbackDesktopProvider(stubScreens(['1'])),
      log: (line) => lines.push(line),
    schedule: () => () => {},
    });
    await provider.start(() => {});
    assert.deepStrictEqual(lines, ['desktop-provider fallback reason=start-failed:helper-missing']);
    assert.strictEqual(provider.name, 'fallback');
  });

  it('handshake unanswered: fallback after the timeout', async () => {
    const h = macHarness('silent', { handshake: 1_500 });
    await h.provider.start(h.onChange);
    assert.deepStrictEqual(h.fallbackLines(), ['desktop-provider fallback reason=handshake-timeout']);
    assert.strictEqual(h.provider.name, 'fallback');
  });

  it('helper exits during the handshake: fallback with the exit reason', async () => {
    const h = macHarness('exit-at-hello');
    await h.provider.start(h.onChange);
    assert.deepStrictEqual(h.fallbackLines(), [
      'desktop-provider fallback reason=start-failed:helper-exit_code=2',
    ]);
  });

  it('private symbols unavailable: fallback naming them', async () => {
    const h = macHarness('no-symbols');
    await h.provider.start(h.onChange);
    assert.deepStrictEqual(h.fallbackLines(), [
      'desktop-provider fallback reason=start-failed:symbols-unavailable:CGSCopyManagedDisplaySpaces',
    ]);
    assert.strictEqual(h.provider.name, 'fallback');
  });

  it('malformed line: fallback answers the request, one line', async () => {
    const h = macHarness('malformed');
    await h.provider.start(h.onChange);
    assert.deepStrictEqual(await h.provider.layout(), FALLBACK_TWO_SCREENS);
    await flush();
    assert.deepStrictEqual(h.fallbackLines(), ['desktop-provider fallback reason=malformed-line']);
    assert.deepStrictEqual(h.changes, [{ kind: 'layout-changed' }]);
  });

  it('request timeout: fallback answers the request', async () => {
    const h = macHarness('slow', { request: 200 });
    await h.provider.start(h.onChange);
    assert.deepStrictEqual(await h.provider.layout(), FALLBACK_TWO_SCREENS);
    assert.deepStrictEqual(h.fallbackLines(), ['desktop-provider fallback reason=request-timeout:layout']);
  });

  it('starts again after a stop with a fresh helper, and the stopped one cannot fail the new session', async () => {
    const changes: DesktopChange[] = [];
    const mac = new MacDesktopProvider({
      command: process.execPath,
      args: [fakeHelper(), 'ok'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    await mac.start((c) => changes.push(c));
    mac.stop();
    await mac.start((c) => changes.push(c));
    // Give the first helper time to report its exit.
    await new Promise((r) => setTimeout(r, 300));
    assert.deepStrictEqual(await mac.layout(), {
      screens: [
        { display: '1', current: '3' },
        { display: '4', current: '9' },
      ],
      desktops: [
        { id: '3', display: '1' },
        { id: '7', display: '1' },
        { id: '9', display: '4' },
      ],
    });
    assert.deepStrictEqual(changes, []);
    mac.stop();
  });

  it('helper exit after start: fallback, backend told to re-read', async () => {
    const h = macHarness('exit');
    await h.provider.start(h.onChange);
    assert.deepStrictEqual(await h.provider.layout(), FALLBACK_TWO_SCREENS);
    await until(() => h.changes.length > 0);
    assert.deepStrictEqual(h.fallbackLines(), ['desktop-provider fallback reason=helper-exit_code=3']);
    assert.deepStrictEqual(h.changes, [{ kind: 'layout-changed' }]);
    assert.strictEqual(h.provider.name, 'fallback');
  });
});
