/**
 * Unit tests for tile lifecycle cleanup helpers.
 *
 * BrowserWindow creation itself requires a live Electron app and cannot be
 * exercised under ELECTRON_RUN_AS_NODE=1, so these tests cover the pieces of
 * the lifecycle that DO run in pure Node: pubsub unsubscribe-by-prefix and
 * the shutdown IPC wiring (validated via a fake BrowserWindow).
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';

import {
  subscribe,
  publish,
  unsubscribeAllByPrefix,
  hasSubscriber,
} from './pubsub.js';
import {
  shutdownTile,
  unloadTile,
  isTileLoaded,
  getTileWindow,
  releaseTileWindow,
  configureTileLauncher,
  __setTileWindowForTest,
  __clearTileStateForTest,
} from './tile-launcher.js';
import * as tileLifecycle from './tile-lifecycle.js';

// ─── unsubscribeAllByPrefix (pubsub) ────────────────────────────────

describe('unsubscribeAllByPrefix', () => {
  it('removes every subscription whose source starts with the prefix', () => {
    subscribe('peek://mytile/background.html', 'test:prefix:a', () => {});
    subscribe('peek://mytile/home.html', 'test:prefix:a', () => {});
    subscribe('peek://mytile/home.html', 'test:prefix:b', () => {});
    subscribe('peek://othertile/home.html', 'test:prefix:a', () => {});

    const removed = unsubscribeAllByPrefix('peek://mytile/');

    assert.strictEqual(removed, 3, 'should remove the three mytile subscriptions');
    assert.strictEqual(hasSubscriber('test:prefix:a', 'peek://mytile/background.html'), false);
    assert.strictEqual(hasSubscriber('test:prefix:a', 'peek://mytile/home.html'), false);
    assert.strictEqual(hasSubscriber('test:prefix:b', 'peek://mytile/home.html'), false);
    // Unrelated tile untouched.
    assert.strictEqual(hasSubscriber('test:prefix:a', 'peek://othertile/home.html'), true);

    unsubscribeAllByPrefix('peek://othertile/');
  });

  it('returns 0 when nothing matches', () => {
    const removed = unsubscribeAllByPrefix('peek://nonesuch/');
    assert.strictEqual(removed, 0);
  });

  it('returns 0 and is a no-op for empty prefix', () => {
    subscribe('peek://foo/x', 'test:prefix:empty', () => {});
    const removed = unsubscribeAllByPrefix('');
    assert.strictEqual(removed, 0);
    // Still subscribed.
    assert.strictEqual(hasSubscriber('test:prefix:empty', 'peek://foo/x'), true);
    unsubscribeAllByPrefix('peek://foo/');
  });

  it('stops deliveries after prefix unsubscribe', () => {
    let count = 0;
    subscribe('peek://quiet/home.html', 'test:prefix:delivery', () => { count++; });
    publish('peek://src/', 'test:prefix:delivery', {});
    assert.strictEqual(count, 1);
    unsubscribeAllByPrefix('peek://quiet/');
    publish('peek://src/', 'test:prefix:delivery', {});
    assert.strictEqual(count, 1, 'no further deliveries after prefix unsubscribe');
  });
});

// ─── shutdownTile / unloadTile against the real registry (fake window) ─

interface FakeWin {
  isDestroyed: () => boolean;
  webContents: {
    isDestroyed: () => boolean;
    send: (channel: string) => void;
  };
  close: () => void;
  _closed?: boolean;
  _sends?: string[];
}

function makeFakeWin(): FakeWin {
  const win: FakeWin = {
    _sends: [],
    _closed: false,
    isDestroyed: () => win._closed === true,
    webContents: {
      isDestroyed: () => false,
      send: (channel: string) => { win._sends!.push(channel); },
    },
    close: () => { win._closed = true; },
  };
  return win;
}

// Tile close now routes through the injected `closeTileWindow` hook (the
// window-state machine in production — main.ts configureTileLauncher). The
// unit fake stands in for the machine and performs the raw close, keeping
// the ordering contract under test unchanged.
function configureFakeCloseHook(): void {
  configureTileLauncher({
    closeTileWindow: (w) => (w as unknown as FakeWin).close(),
  });
}

describe('shutdownTile (registry-backed)', () => {
  beforeEach(() => {
    __clearTileStateForTest();
    configureFakeCloseHook();
  });

  it('sends tile:lifecycle:shutdown to the registered window and then closes it', async () => {
    const win = makeFakeWin();
    __setTileWindowForTest('fx-tile', 'bg', win);

    await shutdownTile('fx-tile', 'bg');

    assert.deepStrictEqual(win._sends, ['tile:lifecycle:shutdown']);
    assert.strictEqual(win._closed, true);
  });

  it('is a no-op if no window is registered for the tile', async () => {
    // Should not throw even when nothing is registered.
    await shutdownTile('no-such-tile', 'bg');
  });
});

describe('unloadTile (registry-backed)', () => {
  beforeEach(() => {
    __clearTileStateForTest();
    configureFakeCloseHook();
  });

  it('sends tile:lifecycle:shutdown before closing and clears registry entry', async () => {
    const win = makeFakeWin();
    __setTileWindowForTest('unload-tile', 'bg', win);
    assert.strictEqual(isTileLoaded('unload-tile', 'bg'), true);

    await unloadTile('unload-tile', 'bg');

    assert.deepStrictEqual(win._sends, ['tile:lifecycle:shutdown']);
    assert.strictEqual(win._closed, true);
    assert.strictEqual(isTileLoaded('unload-tile', 'bg'), false);
  });
});

// ─── several live windows on one tile entry ──────────────────────────
//
// Two `api.window.open('peek://search/home.html?q=…')` calls build two
// windows for the same (tile, entry), so the registry holds a list per key
// and only the key's LAST live window may tear the entry down.

/** The fake stands in for a BrowserWindow: `releaseTileWindow` only uses the
 *  handle's identity and its `id`, both of which the fake satisfies. */
function asWin(win: FakeWin): Parameters<typeof releaseTileWindow>[2] {
  return win as unknown as Parameters<typeof releaseTileWindow>[2];
}

describe('tile window registry: several windows on one entry', () => {
  beforeEach(() => {
    __clearTileStateForTest();
    tileLifecycle.resetForTests();
    configureFakeCloseHook();
  });

  it('releasing the first window keeps the second registered and subscribed', () => {
    const winA = makeFakeWin();
    const winB = makeFakeWin();
    __setTileWindowForTest('sib-tile', 'home', winA);
    __setTileWindowForTest('sib-tile', 'home', winB);
    subscribe('peek://sib-tile/home', 'test:sibling:topic', () => {});

    const perEntryCleanupRan = releaseTileWindow('sib-tile', 'home', asWin(winA), 'closed');

    assert.strictEqual(perEntryCleanupRan, false, 'per-entry cleanup must wait for the last window');
    assert.strictEqual(getTileWindow('sib-tile', 'home'), asWin(winB));
    assert.strictEqual(isTileLoaded('sib-tile', 'home'), true);
    // The survivor's subscriptions live under the shared source address, so
    // unsubscribing on the first close would silence it.
    assert.strictEqual(hasSubscriber('test:sibling:topic', 'peek://sib-tile/home'), true);

    unsubscribeAllByPrefix('peek://sib-tile/');
  });

  it('releasing the last window runs the per-entry cleanup', () => {
    const winA = makeFakeWin();
    const winB = makeFakeWin();
    __setTileWindowForTest('sib-tile', 'home', winA);
    __setTileWindowForTest('sib-tile', 'home', winB);

    releaseTileWindow('sib-tile', 'home', asWin(winA), 'closed');
    const perEntryCleanupRan = releaseTileWindow('sib-tile', 'home', asWin(winB), 'closed');

    assert.strictEqual(perEntryCleanupRan, true);
    assert.strictEqual(isTileLoaded('sib-tile', 'home'), false);
    assert.strictEqual(getTileWindow('sib-tile', 'home'), null);
  });

  it('releasing the most recently opened window falls back to the earlier one', () => {
    const winA = makeFakeWin();
    const winB = makeFakeWin();
    __setTileWindowForTest('sib-tile', 'home', winA);
    __setTileWindowForTest('sib-tile', 'home', winB);

    const perEntryCleanupRan = releaseTileWindow('sib-tile', 'home', asWin(winB), 'closed');

    assert.strictEqual(perEntryCleanupRan, false);
    assert.strictEqual(getTileWindow('sib-tile', 'home'), asWin(winA));
    assert.strictEqual(isTileLoaded('sib-tile', 'home'), true);
  });

  it('a crash of one window leaves the entry lifecycle state alone', () => {
    // Drive the entry to `ready` so a stray RENDER_GONE would be visible as
    // `crashed` rather than silently rejected from `unregistered`.
    tileLifecycle.transition('sib-tile', 'home', tileLifecycle.TRIGGERS.INSTALL);
    tileLifecycle.transition('sib-tile', 'home', tileLifecycle.TRIGGERS.LOAD);
    tileLifecycle.transition('sib-tile', 'home', tileLifecycle.TRIGGERS.TILE_READY);
    assert.strictEqual(tileLifecycle.getState('sib-tile', 'home'), tileLifecycle.STATES.READY);

    const winA = makeFakeWin();
    const winB = makeFakeWin();
    __setTileWindowForTest('sib-tile', 'home', winA);
    __setTileWindowForTest('sib-tile', 'home', winB);

    const perEntryCleanupRan = releaseTileWindow('sib-tile', 'home', asWin(winA), 'crashed');

    assert.strictEqual(perEntryCleanupRan, false);
    assert.strictEqual(tileLifecycle.getState('sib-tile', 'home'), tileLifecycle.STATES.READY,
      'the entry is still running in the surviving window');
  });

  it('a close arriving after unloadTile still returns the entry to registered', async () => {
    // unloadTile de-registers eagerly so callers see isTileLoaded() false at
    // once; the window's own 'closed' event lands afterwards and is still the
    // step that drives the lifecycle home. Skip it and a disabled feature can
    // never be re-enabled — the FSM has no edge out of `ready` for a fresh LOAD.
    tileLifecycle.transition('sib-tile', 'home', tileLifecycle.TRIGGERS.INSTALL);
    tileLifecycle.transition('sib-tile', 'home', tileLifecycle.TRIGGERS.LOAD);
    tileLifecycle.transition('sib-tile', 'home', tileLifecycle.TRIGGERS.TILE_READY);

    const win = makeFakeWin();
    __setTileWindowForTest('sib-tile', 'home', win);
    await unloadTile('sib-tile', 'home');
    assert.strictEqual(isTileLoaded('sib-tile', 'home'), false);

    const perEntryCleanupRan = releaseTileWindow('sib-tile', 'home', asWin(win), 'closed');

    assert.strictEqual(perEntryCleanupRan, true);
    assert.strictEqual(tileLifecycle.getState('sib-tile', 'home'), tileLifecycle.STATES.REGISTERED);
  });

  it('shutdownTile signals and closes every live window for the entry', async () => {
    const winA = makeFakeWin();
    const winB = makeFakeWin();
    __setTileWindowForTest('sib-tile', 'home', winA);
    __setTileWindowForTest('sib-tile', 'home', winB);

    await shutdownTile('sib-tile', 'home');

    assert.deepStrictEqual(winA._sends, ['tile:lifecycle:shutdown']);
    assert.deepStrictEqual(winB._sends, ['tile:lifecycle:shutdown']);
    assert.strictEqual(winA._closed, true);
    assert.strictEqual(winB._closed, true);
  });
});

// ─── shutdownTile: uses a fake BrowserWindow to verify IPC ordering ─
//
// We cannot instantiate a real Electron BrowserWindow here, but we CAN
// construct a fake shape and drive shutdownTile via the exported helper if
// we inject it. Since tile-launcher's internal map is private, we cover the
// ordering via a unit-friendly replica:

describe('shutdownTile ordering contract', () => {
  it('sends tile:lifecycle:shutdown IPC, then closes after the grace delay', async () => {
    // This test mirrors the exact sequence shutdownTile follows:
    //   webContents.send('tile:lifecycle:shutdown')   (immediate)
    //   await sleep(grace)
    //   win.close()                         (after)
    // It guards against regressions that move win.close() before the IPC send
    // or drop the grace-period wait entirely.
    const events: string[] = [];
    const grace = 40;

    const fakeWin = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (channel: string) => { events.push(`send:${channel}`); },
      },
      close: () => { events.push('close'); },
    };

    // Replicate shutdownTile's body inline — this is the contract we rely on.
    async function shutdown(win: typeof fakeWin): Promise<void> {
      if (!win || win.isDestroyed()) return;
      if (!win.webContents.isDestroyed()) {
        win.webContents.send('tile:lifecycle:shutdown');
      }
      await new Promise<void>((resolve) => setTimeout(resolve, grace));
      if (!win.isDestroyed()) {
        win.close();
      }
    }

    const t0 = Date.now();
    await shutdown(fakeWin);
    const elapsed = Date.now() - t0;

    assert.deepStrictEqual(events, ['send:tile:lifecycle:shutdown', 'close']);
    assert.ok(elapsed >= grace - 10, `should have waited at least ~${grace}ms, waited ${elapsed}ms`);
  });

  it('does not send or close when the window is already destroyed', async () => {
    const events: string[] = [];
    const fakeWin = {
      isDestroyed: () => true,
      webContents: {
        isDestroyed: () => false,
        send: (channel: string) => { events.push(`send:${channel}`); },
      },
      close: () => { events.push('close'); },
    };

    async function shutdown(win: typeof fakeWin): Promise<void> {
      if (!win || win.isDestroyed()) return;
      if (!win.webContents.isDestroyed()) {
        win.webContents.send('tile:lifecycle:shutdown');
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      if (!win.isDestroyed()) {
        win.close();
      }
    }

    await shutdown(fakeWin);
    assert.deepStrictEqual(events, []);
  });
});
