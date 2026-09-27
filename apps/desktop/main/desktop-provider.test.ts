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

function harness(primary: FakeProvider | null) {
  const lines: string[] = [];
  const changes: DesktopChange[] = [];
  const fallback = new FallbackDesktopProvider(stubScreens(['1', '2'], { 10: '2' }, [11]));
  const provider = new FailSafeDesktopProvider({
    primary,
    fallback,
    log: (line) => lines.push(line),
    handshakeTimeoutMs: 20,
    requestTimeoutMs: 20,
  });
  const fallbackLines = () => lines.filter((l) => l.startsWith('desktop-provider fallback '));
  return { provider, lines, changes, fallbackLines, onChange: (c: DesktopChange) => changes.push(c) };
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
});
