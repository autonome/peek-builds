/**
 * Unit tests for `nav-history.ts` — the back/forward-history data model, its
 * size rules, the per-window last-known cache, and the replay call.
 *
 * These drive the real module (no mirrored copy): it imports nothing from
 * `electron`, and the two webContents-shaped parameters are structural, so a
 * plain object stands in for a live one and every case runs under
 * `ELECTRON_RUN_AS_NODE=1` with no display server.
 *
 * The cache is module state shared by the whole file, so each cache test uses
 * its own window id rather than relying on ordering.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  MAX_NAV_HISTORY_ENTRIES,
  MAX_NAV_TITLE_LENGTH,
  captureNavHistory,
  clearWindowNavHistory,
  getWindowNavHistory,
  readNavHistory,
  refreshWindowNavHistory,
  restoreNavHistory,
  seedWindowNavHistory,
} from './nav-history.js';
import type {
  NavHistoryCarrier,
  NavHistoryEntry,
  NavHistoryReadTarget,
  NavHistoryRestoreTarget,
  NavHistorySnapshot,
  RawNavHistoryEntry,
} from './nav-history.js';

// ============================================================================
// Fixtures
// ============================================================================

/** A raw entry as Electron hands it over, complete with the blob we drop. */
function rawEntry(n: number, extra: Partial<RawNavHistoryEntry> = {}): RawNavHistoryEntry {
  return {
    url: `https://example.test/${n}`,
    title: `Page ${n}`,
    pageState: `AAAAOAAAAAAAAAAAsomeopaquechromiumblob-${n}`,
    ...extra,
  };
}

/** `count` raw entries, urls `/0` … `/count-1`. */
function rawTrail(count: number): RawNavHistoryEntry[] {
  return Array.from({ length: count }, (_unused, n) => rawEntry(n));
}

/** A kept entry, as the module produces them. */
function keptEntry(n: number): NavHistoryEntry {
  return { url: `https://example.test/${n}`, title: `Page ${n}` };
}

/** The urls of a snapshot's kept trail, for compact window assertions. */
function urlsOf(snapshot: NavHistorySnapshot): string[] {
  return snapshot.navHistory.map((e) => e.url);
}

/** A stand-in webContents for the cache-refresh reads. */
function fakeReadTarget(options: {
  entries?: RawNavHistoryEntry[];
  activeIndex?: number;
  destroyed?: boolean;
  throwOn?: 'isDestroyed' | 'getAllEntries' | 'getActiveIndex';
}): NavHistoryReadTarget {
  const { entries = [], activeIndex = 0, destroyed = false, throwOn } = options;
  return {
    isDestroyed() {
      if (throwOn === 'isDestroyed') throw new Error('isDestroyed exploded');
      return destroyed;
    },
    navigationHistory: {
      getAllEntries() {
        if (throwOn === 'getAllEntries') throw new Error('getAllEntries exploded');
        return entries;
      },
      getActiveIndex() {
        if (throwOn === 'getActiveIndex') throw new Error('getActiveIndex exploded');
        return activeIndex;
      },
    },
  };
}

// ============================================================================
// captureNavHistory
// ============================================================================

describe('captureNavHistory', () => {
  it('keeps url and title only — pageState never reaches the payload', () => {
    const captured = captureNavHistory(rawTrail(3), 2);
    assert.ok(captured);
    assert.deepStrictEqual(captured.navHistory, [keptEntry(0), keptEntry(1), keptEntry(2)]);
    assert.strictEqual(captured.navHistoryIndex, 2);
    // Not just "deep-equal to a pageState-free literal" — assert the key is
    // gone, since an extra own property would ride along into the session row.
    for (const entry of captured.navHistory) {
      assert.deepStrictEqual(Object.keys(entry).sort(), ['title', 'url']);
      assert.strictEqual('pageState' in entry, false);
    }
  });

  it('truncates a title at MAX_NAV_TITLE_LENGTH and leaves a shorter one alone', () => {
    const longTitle = 'x'.repeat(MAX_NAV_TITLE_LENGTH + 250);
    const atLimit = 'y'.repeat(MAX_NAV_TITLE_LENGTH);
    const captured = captureNavHistory(
      [rawEntry(0, { title: longTitle }), rawEntry(1, { title: atLimit }), rawEntry(2, { title: 'short' })],
      0,
    );
    assert.ok(captured);
    assert.strictEqual(captured.navHistory[0].title.length, MAX_NAV_TITLE_LENGTH);
    assert.strictEqual(captured.navHistory[0].title, 'x'.repeat(MAX_NAV_TITLE_LENGTH));
    assert.strictEqual(captured.navHistory[1].title, atLimit);
    assert.strictEqual(captured.navHistory[2].title, 'short');
  });

  it('substitutes an empty title when the entry has none', () => {
    const captured = captureNavHistory([rawEntry(0, { title: undefined }), rawEntry(1)], 1);
    assert.ok(captured);
    assert.strictEqual(captured.navHistory[0].title, '');
    assert.strictEqual(captured.navHistory[1].title, 'Page 1');
  });

  it('returns null for an empty trail', () => {
    assert.strictEqual(captureNavHistory([], 0), null);
  });

  it('returns null for a single-entry trail — the URL alone restores it', () => {
    assert.strictEqual(captureNavHistory(rawTrail(1), 0), null);
  });

  it('returns null for a non-finite index', () => {
    assert.strictEqual(captureNavHistory(rawTrail(3), NaN), null);
    assert.strictEqual(captureNavHistory(rawTrail(3), Infinity), null);
  });

  it('returns null when handed no trail at all', () => {
    assert.strictEqual(captureNavHistory(null, 0), null);
    assert.strictEqual(captureNavHistory(undefined, 0), null);
  });

  it('keeps a trail at the cap untouched', () => {
    const captured = captureNavHistory(rawTrail(MAX_NAV_HISTORY_ENTRIES), 7);
    assert.ok(captured);
    assert.strictEqual(captured.navHistory.length, MAX_NAV_HISTORY_ENTRIES);
    assert.strictEqual(captured.navHistoryIndex, 7);
    assert.strictEqual(captured.navHistory[0].url, 'https://example.test/0');
  });

  describe('the 50-entry window over a 60-entry trail', () => {
    it('keeps the newest 50 when the active entry is at the front', () => {
      const captured = captureNavHistory(rawTrail(60), 59);
      assert.ok(captured);
      assert.strictEqual(captured.navHistory.length, 50);
      assert.deepStrictEqual(
        urlsOf(captured),
        Array.from({ length: 50 }, (_u, i) => `https://example.test/${i + 10}`),
      );
      assert.strictEqual(captured.navHistoryIndex, 49);
      assert.strictEqual(captured.navHistory[captured.navHistoryIndex].url, 'https://example.test/59');
    });

    it('keeps the newest 50 when the active entry is in the middle but inside that window', () => {
      const captured = captureNavHistory(rawTrail(60), 30);
      assert.ok(captured);
      assert.strictEqual(captured.navHistory[0].url, 'https://example.test/10');
      assert.strictEqual(captured.navHistoryIndex, 20);
      assert.strictEqual(captured.navHistory[captured.navHistoryIndex].url, 'https://example.test/30');
    });

    it('slides the window back to the active entry when the user had gone back past the tail', () => {
      const captured = captureNavHistory(rawTrail(60), 0);
      assert.ok(captured);
      assert.strictEqual(captured.navHistory.length, 50);
      assert.strictEqual(captured.navHistory[0].url, 'https://example.test/0');
      assert.strictEqual(captured.navHistory[49].url, 'https://example.test/49');
      assert.strictEqual(captured.navHistoryIndex, 0);
      assert.strictEqual(captured.navHistory[captured.navHistoryIndex].url, 'https://example.test/0');
    });

    it('slides the window only as far back as it must — active index 5', () => {
      const captured = captureNavHistory(rawTrail(60), 5);
      assert.ok(captured);
      assert.strictEqual(captured.navHistory[0].url, 'https://example.test/5');
      assert.strictEqual(captured.navHistoryIndex, 0);
      assert.strictEqual(captured.navHistory[49].url, 'https://example.test/54');
    });

    it('never points the kept index outside the kept trail, for any active index', () => {
      for (let active = 0; active < 60; active++) {
        const captured = captureNavHistory(rawTrail(60), active);
        assert.ok(captured, `no snapshot for active index ${active}`);
        assert.strictEqual(captured.navHistory.length, 50);
        assert.ok(
          captured.navHistoryIndex >= 0 && captured.navHistoryIndex < captured.navHistory.length,
          `index ${captured.navHistoryIndex} out of range for active ${active}`,
        );
        // The kept index must still name the page the user was on.
        assert.strictEqual(
          captured.navHistory[captured.navHistoryIndex].url,
          `https://example.test/${active}`,
        );
      }
    });
  });

  it('clamps an out-of-range live index into the trail', () => {
    const past = captureNavHistory(rawTrail(3), 9);
    assert.ok(past);
    assert.strictEqual(past.navHistoryIndex, 2);
    const negative = captureNavHistory(rawTrail(3), -4);
    assert.ok(negative);
    assert.strictEqual(negative.navHistoryIndex, 0);
  });
});

// ============================================================================
// readNavHistory
// ============================================================================

describe('readNavHistory', () => {
  it('reads a well-formed persisted trail back', () => {
    const read = readNavHistory({
      navHistory: [keptEntry(0), keptEntry(1), keptEntry(2)],
      navHistoryIndex: 1,
    });
    assert.ok(read);
    assert.deepStrictEqual(read.navHistory, [keptEntry(0), keptEntry(1), keptEntry(2)]);
    assert.strictEqual(read.navHistoryIndex, 1);
  });

  it('reads a row that declares the two fields with the carrier type', () => {
    // The shape a persisted row type opts into (`NavHistoryCarrier`), as a
    // later slice's `ClosedWindowEntry` / `WindowDescriptor` will.
    const row: { url: string } & NavHistoryCarrier = {
      url: 'https://example.test/1',
      navHistory: [keptEntry(0), keptEntry(1)],
      navHistoryIndex: 0,
    };
    const read = readNavHistory(row);
    assert.ok(read);
    assert.strictEqual(read.navHistoryIndex, 0);
    assert.strictEqual(read.navHistory[0].url, 'https://example.test/0');
  });

  it('drops anything but url and title off a persisted entry', () => {
    const read = readNavHistory({
      navHistory: [
        { url: 'https://example.test/0', title: 'Page 0', pageState: 'blob', extra: 1 },
        keptEntry(1),
      ],
      navHistoryIndex: 0,
    });
    assert.ok(read);
    assert.deepStrictEqual(Object.keys(read.navHistory[0]).sort(), ['title', 'url']);
  });

  it('truncates an over-long persisted title', () => {
    const read = readNavHistory({
      navHistory: [
        { url: 'https://example.test/0', title: 'z'.repeat(MAX_NAV_TITLE_LENGTH + 1) },
        keptEntry(1),
      ],
      navHistoryIndex: 1,
    });
    assert.ok(read);
    assert.strictEqual(read.navHistory[0].title.length, MAX_NAV_TITLE_LENGTH);
  });

  it('returns null for a legacy closed-window entry that carries no history fields', () => {
    // The shape `main.ts ClosedWindowEntry` has today — every field it really
    // has, and no trail. Reopen must fall back to the URL, not throw.
    const legacy = {
      url: 'https://example.test/final',
      originalUrl: 'https://example.test/opened',
      source: 'cmd',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      spaceMode: null,
      role: 'content',
      scrollX: 0,
      scrollY: 120,
      maximized: false,
      timestamp: 1_700_000_000_000,
    };
    assert.strictEqual(readNavHistory(legacy), null);
  });

  it('returns null for an absent trail', () => {
    assert.strictEqual(readNavHistory({}), null);
    assert.strictEqual(readNavHistory({ navHistory: undefined, navHistoryIndex: 3 }), null);
    assert.strictEqual(readNavHistory(null), null);
    assert.strictEqual(readNavHistory(undefined), null);
  });

  it('returns null when the trail is not an array', () => {
    assert.strictEqual(readNavHistory({ navHistory: 'https://example.test/0' }), null);
    assert.strictEqual(readNavHistory({ navHistory: 42 }), null);
    assert.strictEqual(readNavHistory({ navHistory: { 0: keptEntry(0), length: 2 } }), null);
    assert.strictEqual(readNavHistory({ navHistory: null }), null);
  });

  it('returns null for a trail shorter than two entries', () => {
    assert.strictEqual(readNavHistory({ navHistory: [] }), null);
    assert.strictEqual(readNavHistory({ navHistory: [keptEntry(0)], navHistoryIndex: 0 }), null);
  });

  it('returns null when any entry has no usable url', () => {
    assert.strictEqual(readNavHistory({ navHistory: [keptEntry(0), { title: 'no url' }] }), null);
    assert.strictEqual(readNavHistory({ navHistory: [keptEntry(0), { url: '', title: 'empty' }] }), null);
    assert.strictEqual(readNavHistory({ navHistory: [keptEntry(0), { url: 42, title: 'number' }] }), null);
    assert.strictEqual(readNavHistory({ navHistory: [keptEntry(0), null] }), null);
    assert.strictEqual(readNavHistory({ navHistory: [keptEntry(0), 'https://example.test/1'] }), null);
  });

  it('defaults a missing index to the last entry', () => {
    const read = readNavHistory({ navHistory: [keptEntry(0), keptEntry(1), keptEntry(2)] });
    assert.ok(read);
    assert.strictEqual(read.navHistoryIndex, 2);
  });

  it('defaults an out-of-range or non-integer index to the last entry', () => {
    for (const navHistoryIndex of [-1, 3, 7, 1.5, NaN, Infinity, '1', null]) {
      const read = readNavHistory({
        navHistory: [keptEntry(0), keptEntry(1), keptEntry(2)],
        navHistoryIndex,
      });
      assert.ok(read, `no snapshot for index ${String(navHistoryIndex)}`);
      assert.strictEqual(read.navHistoryIndex, 2, `index ${String(navHistoryIndex)} was not defaulted`);
    }
  });

  it('re-caps an over-long persisted trail with the same window rule', () => {
    const overLong = Array.from({ length: 60 }, (_u, n) => keptEntry(n));

    const atFront = readNavHistory({ navHistory: overLong, navHistoryIndex: 59 });
    assert.ok(atFront);
    assert.strictEqual(atFront.navHistory.length, MAX_NAV_HISTORY_ENTRIES);
    assert.strictEqual(atFront.navHistory[0].url, 'https://example.test/10');
    assert.strictEqual(atFront.navHistoryIndex, 49);

    const backPastTail = readNavHistory({ navHistory: overLong, navHistoryIndex: 0 });
    assert.ok(backPastTail);
    assert.strictEqual(backPastTail.navHistory[0].url, 'https://example.test/0');
    assert.strictEqual(backPastTail.navHistoryIndex, 0);

    // Index defaulted to the last entry first, then windowed.
    const noIndex = readNavHistory({ navHistory: overLong });
    assert.ok(noIndex);
    assert.strictEqual(noIndex.navHistory.length, MAX_NAV_HISTORY_ENTRIES);
    assert.strictEqual(noIndex.navHistoryIndex, 49);
    assert.strictEqual(noIndex.navHistory[49].url, 'https://example.test/59');
  });
});

// ============================================================================
// The per-window last-known cache
// ============================================================================

describe('the per-window nav-history cache', () => {
  it('returns null for a window nothing was ever recorded for', () => {
    assert.strictEqual(getWindowNavHistory(90_001), null);
  });

  it('holds a seeded trail', () => {
    const seeded: NavHistorySnapshot = { navHistory: [keptEntry(0), keptEntry(1)], navHistoryIndex: 1 };
    seedWindowNavHistory(90_002, seeded);
    assert.deepStrictEqual(getWindowNavHistory(90_002), seeded);
  });

  it('clears the window entry when seeded with nothing', () => {
    seedWindowNavHistory(90_003, { navHistory: [keptEntry(0), keptEntry(1)], navHistoryIndex: 1 });
    seedWindowNavHistory(90_003, null);
    assert.strictEqual(getWindowNavHistory(90_003), null);
  });

  it('replaces the cached trail on refresh from a live webContents', () => {
    seedWindowNavHistory(90_004, { navHistory: [keptEntry(0), keptEntry(1)], navHistoryIndex: 1 });
    refreshWindowNavHistory(90_004, fakeReadTarget({ entries: rawTrail(4), activeIndex: 2 }));
    const cached = getWindowNavHistory(90_004);
    assert.ok(cached);
    assert.deepStrictEqual(urlsOf(cached), [
      'https://example.test/0',
      'https://example.test/1',
      'https://example.test/2',
      'https://example.test/3',
    ]);
    assert.strictEqual(cached.navHistoryIndex, 2);
  });

  it('records a trail for a window that had none cached', () => {
    refreshWindowNavHistory(90_005, fakeReadTarget({ entries: rawTrail(3), activeIndex: 0 }));
    const cached = getWindowNavHistory(90_005);
    assert.ok(cached);
    assert.strictEqual(cached.navHistory.length, 3);
    assert.strictEqual(cached.navHistoryIndex, 0);
  });

  it('leaves a seeded trail alone when the webContents reports zero entries', () => {
    const seeded: NavHistorySnapshot = { navHistory: [keptEntry(0), keptEntry(1)], navHistoryIndex: 1 };
    seedWindowNavHistory(90_006, seeded);
    refreshWindowNavHistory(90_006, fakeReadTarget({ entries: [], activeIndex: -1 }));
    assert.deepStrictEqual(getWindowNavHistory(90_006), seeded);
  });

  it('clears the cached trail when the webContents reports a single entry', () => {
    seedWindowNavHistory(90_007, { navHistory: [keptEntry(0), keptEntry(1)], navHistoryIndex: 1 });
    refreshWindowNavHistory(90_007, fakeReadTarget({ entries: rawTrail(1), activeIndex: 0 }));
    assert.strictEqual(getWindowNavHistory(90_007), null);
  });

  it('ignores a destroyed webContents without reading it', () => {
    const seeded: NavHistorySnapshot = { navHistory: [keptEntry(0), keptEntry(1)], navHistoryIndex: 1 };
    seedWindowNavHistory(90_008, seeded);
    let read = 0;
    const destroyed: NavHistoryReadTarget = {
      isDestroyed: () => true,
      navigationHistory: {
        getAllEntries() { read++; return rawTrail(5); },
        getActiveIndex() { read++; return 4; },
      },
    };
    refreshWindowNavHistory(90_008, destroyed);
    assert.strictEqual(read, 0, 'a destroyed webContents must not be read');
    assert.deepStrictEqual(getWindowNavHistory(90_008), seeded);
  });

  it('swallows a throwing webContents and keeps what was cached', () => {
    const seeded: NavHistorySnapshot = { navHistory: [keptEntry(0), keptEntry(1)], navHistoryIndex: 1 };
    for (const throwOn of ['isDestroyed', 'getAllEntries', 'getActiveIndex'] as const) {
      const windowId = 90_100 + throwOn.length;
      seedWindowNavHistory(windowId, seeded);
      refreshWindowNavHistory(windowId, fakeReadTarget({ entries: rawTrail(5), activeIndex: 4, throwOn }));
      assert.deepStrictEqual(getWindowNavHistory(windowId), seeded, `throwing ${throwOn} disturbed the cache`);
    }
  });

  it('ignores a missing webContents', () => {
    const seeded: NavHistorySnapshot = { navHistory: [keptEntry(0), keptEntry(1)], navHistoryIndex: 1 };
    seedWindowNavHistory(90_009, seeded);
    refreshWindowNavHistory(90_009, null);
    refreshWindowNavHistory(90_009, undefined);
    assert.deepStrictEqual(getWindowNavHistory(90_009), seeded);
  });

  it('applies the size rule to a live read of an over-long trail', () => {
    refreshWindowNavHistory(90_010, fakeReadTarget({ entries: rawTrail(60), activeIndex: 3 }));
    const cached = getWindowNavHistory(90_010);
    assert.ok(cached);
    assert.strictEqual(cached.navHistory.length, MAX_NAV_HISTORY_ENTRIES);
    assert.strictEqual(cached.navHistory[cached.navHistoryIndex].url, 'https://example.test/3');
  });

  it('forgets a window on clear', () => {
    seedWindowNavHistory(90_011, { navHistory: [keptEntry(0), keptEntry(1)], navHistoryIndex: 1 });
    clearWindowNavHistory(90_011);
    assert.strictEqual(getWindowNavHistory(90_011), null);
    // Clearing an unknown window is a no-op, not a throw.
    clearWindowNavHistory(90_012);
    assert.strictEqual(getWindowNavHistory(90_012), null);
  });

  it('keeps windows apart', () => {
    seedWindowNavHistory(90_013, { navHistory: [keptEntry(0), keptEntry(1)], navHistoryIndex: 0 });
    seedWindowNavHistory(90_014, { navHistory: [keptEntry(7), keptEntry(8)], navHistoryIndex: 1 });
    clearWindowNavHistory(90_013);
    assert.strictEqual(getWindowNavHistory(90_013), null);
    const other = getWindowNavHistory(90_014);
    assert.ok(other);
    assert.strictEqual(other.navHistory[0].url, 'https://example.test/7');
  });
});

// ============================================================================
// restoreNavHistory
// ============================================================================

describe('restoreNavHistory', () => {
  const history: NavHistorySnapshot = {
    navHistory: [keptEntry(0), keptEntry(1), keptEntry(2)],
    navHistoryIndex: 1,
  };

  it('passes the entries and index through and resolves restored', async () => {
    const calls: Array<{ entries: NavHistoryEntry[]; index: number }> = [];
    const target: NavHistoryRestoreTarget = {
      isDestroyed: () => false,
      navigationHistory: {
        async restore(options) { calls.push(options); },
      },
    };
    assert.strictEqual(await restoreNavHistory(target, history), 'restored');
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].entries, history.navHistory);
    assert.strictEqual(calls[0].index, 1);
  });

  it('accepts a restore that returns nothing rather than a promise', async () => {
    let called = false;
    const target: NavHistoryRestoreTarget = {
      isDestroyed: () => false,
      navigationHistory: {
        restore() { called = true; },
      },
    };
    assert.strictEqual(await restoreNavHistory(target, history), 'restored');
    assert.strictEqual(called, true);
  });

  it('resolves refused for a destroyed target without calling restore', async () => {
    let called = false;
    const target: NavHistoryRestoreTarget = {
      isDestroyed: () => true,
      navigationHistory: {
        restore() { called = true; },
      },
    };
    assert.strictEqual(await restoreNavHistory(target, history), 'refused');
    assert.strictEqual(called, false);
  });

  it('resolves refused when restore rejects without a navigation error', async () => {
    const target: NavHistoryRestoreTarget = {
      isDestroyed: () => false,
      navigationHistory: {
        restore: () => Promise.reject(new Error('restore refused the entries')),
      },
    };
    assert.strictEqual(await restoreNavHistory(target, history), 'refused');
  });

  it('resolves refused when restore throws synchronously', async () => {
    const target: NavHistoryRestoreTarget = {
      isDestroyed: () => false,
      navigationHistory: {
        restore() { throw new Error('restore exploded'); },
      },
    };
    assert.strictEqual(await restoreNavHistory(target, history), 'refused');
  });

  it('resolves refused for a missing target', async () => {
    assert.strictEqual(await restoreNavHistory(null, history), 'refused');
    assert.strictEqual(await restoreNavHistory(undefined, history), 'refused');
  });

  // The shape Electron rejects with when the navigation restore started does
  // not finish: an Error carrying the Chromium net error number as `errno`.
  function navigationError(errno: number, code: string): Error {
    return Object.assign(new Error(`${code} (${errno})`), { errno, code, url: 'https://example.test/1' });
  }

  it('resolves load-failed, not refused, when the replayed navigation is superseded', async () => {
    // A later navigation (Back pressed before the page loaded) aborts the
    // replay with ERR_ABORTED. The trail is in place; falling back to a plain
    // load would cut across the user's navigation.
    const target: NavHistoryRestoreTarget = {
      isDestroyed: () => false,
      navigationHistory: {
        restore: () => Promise.reject(navigationError(-3, 'ERR_ABORTED')),
      },
    };
    assert.strictEqual(await restoreNavHistory(target, history), 'load-failed');
  });

  it('resolves load-failed when the replayed navigation fails', async () => {
    const target: NavHistoryRestoreTarget = {
      isDestroyed: () => false,
      navigationHistory: {
        restore: () => Promise.reject(navigationError(-102, 'ERR_CONNECTION_REFUSED')),
      },
    };
    assert.strictEqual(await restoreNavHistory(target, history), 'load-failed');
  });
});
