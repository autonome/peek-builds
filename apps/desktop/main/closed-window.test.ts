/**
 * Unit tests for closed window stack and reopen-last-closed logic
 *
 * Tests the real `main/closed-window-stack.ts`, which `main.ts` calls:
 * - pushClosedWindow / popClosedWindow: LIFO stack with max capacity
 * - createClosedWindowEntry: determines whether a closed window should be saved
 *   and builds the entry with correct spaceMode capture
 *
 * That module is pure (no Electron dependencies) so these can run
 * under ELECTRON_RUN_AS_NODE=1 without a real display server.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import {
  createClosedWindowEntry,
  reopenKeyOpen,
  getClosedWindowCount,
  popClosedWindow,
  pushClosedWindow,
  replaceClosedWindowStack,
  type CapturedCloseBounds,
  type ClosedWindowEntry,
  type ClosedWindowModeEntry,
} from './closed-window-stack.js';

interface Rect { x: number; y: number; width: number; height: number }

// ============================================================================
// Fixtures
// ============================================================================

/** Build a `CapturedCloseBounds` with only raw bounds (no presentation) — the common test shape. */
function capturedBounds(bounds: Rect | null): CapturedCloseBounds {
  return { bounds, presentation: null };
}

/** Build a `CapturedCloseBounds` with a presentation (bounds/maximized/preMaxBounds). */
function capturedPresentation(
  bounds: Rect,
  maximized = false,
  preMaxBounds: Rect | null = null,
): CapturedCloseBounds {
  return { bounds, presentation: { bounds, maximized, preMaxBounds } };
}

function makeEntry(overrides?: Partial<ClosedWindowEntry>): ClosedWindowEntry {
  return {
    url: 'https://example.com',
    source: 'test-ext',
    bounds: { x: 100, y: 100, width: 800, height: 600 },
    spaceMode: null,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Closed window stack operations', () => {
  beforeEach(() => {
    replaceClosedWindowStack([]);
  });

  it('push and pop returns the same entry', () => {
    const entry = makeEntry({ url: 'https://example.com/page1' });
    pushClosedWindow(entry);
    const popped = popClosedWindow();
    assert.deepStrictEqual(popped, entry);
  });

  it('stack is LIFO (most recent first)', () => {
    const entry1 = makeEntry({ url: 'https://example.com/first' });
    const entry2 = makeEntry({ url: 'https://example.com/second' });
    const entry3 = makeEntry({ url: 'https://example.com/third' });
    pushClosedWindow(entry1);
    pushClosedWindow(entry2);
    pushClosedWindow(entry3);

    assert.deepStrictEqual(popClosedWindow(), entry3);
    assert.deepStrictEqual(popClosedWindow(), entry2);
    assert.deepStrictEqual(popClosedWindow(), entry1);
  });

  it('stack caps at MAX_CLOSED_WINDOWS (50) — pushing 51st drops the oldest', () => {
    for (let i = 0; i < 51; i++) {
      pushClosedWindow(makeEntry({ url: `https://example.com/page${i}` }));
    }
    assert.strictEqual(getClosedWindowCount(), 50);
    // The oldest (page0) should have been dropped; most recent pop is page50
    const newest = popClosedWindow();
    assert.strictEqual(newest?.url, 'https://example.com/page50');
    // After popping all 48 remaining, the oldest should be page1 (page0 was evicted)
    for (let i = 0; i < 48; i++) {
      popClosedWindow();
    }
    const oldest = popClosedWindow();
    assert.strictEqual(oldest?.url, 'https://example.com/page1');
  });

  it('pop on empty stack returns undefined', () => {
    assert.strictEqual(popClosedWindow(), undefined);
  });

  it('multiple pushes and pops maintain order', () => {
    pushClosedWindow(makeEntry({ url: 'https://a.com' }));
    pushClosedWindow(makeEntry({ url: 'https://b.com' }));
    assert.strictEqual(popClosedWindow()?.url, 'https://b.com');
    pushClosedWindow(makeEntry({ url: 'https://c.com' }));
    assert.strictEqual(popClosedWindow()?.url, 'https://c.com');
    assert.strictEqual(popClosedWindow()?.url, 'https://a.com');
    assert.strictEqual(popClosedWindow(), undefined);
  });
});

describe('Space mode capture', () => {
  it('carries the window key and title onto the entry, and back out for reopen', () => {
    const entry = createClosedWindowEntry(
      { address: 'peek://research/home.html?space=cat%20stuff', key: 'research-view:cat stuff', title: 'Research: cat stuff' },
      null,
      capturedBounds(null),
      'peek://research/home.html',
    );
    assert.strictEqual(entry!.key, 'research-view:cat stuff');
    assert.strictEqual(entry!.title, 'Research: cat stuff');
    assert.deepStrictEqual(reopenKeyOpen(entry!, 'peek://app/background.html'), {
      source: 'peek://research/home.html',
      options: { key: 'research-view:cat stuff', title: 'Research: cat stuff' },
    });
  });

  it('an unkeyed entry reopens under the default source with no key', () => {
    const entry = createClosedWindowEntry({ address: 'https://example.com' }, null, capturedBounds(null), 'test-ext');
    assert.strictEqual('key' in entry!, false);
    assert.deepStrictEqual(reopenKeyOpen(entry!, 'default-src'), { source: 'default-src', options: {} });
  });

  it('captures spaceMode when context.mode is space with spaceId/spaceName', () => {
    const modeEntry: ClosedWindowModeEntry = {
      value: 'space',
      metadata: { spaceId: 'sp-123', spaceName: 'Work' },
    };
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      modeEntry,
      capturedBounds(null),
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
    assert.deepStrictEqual(entry!.spaceMode, {
      spaceId: 'sp-123',
      spaceName: 'Work',
      color: undefined,
    });
  });

  it('captures space mode color when present', () => {
    const modeEntry: ClosedWindowModeEntry = {
      value: 'space',
      metadata: { spaceId: 'sp-456', spaceName: 'Personal', color: '#ff0000' },
    };
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      modeEntry,
      capturedBounds(null),
      'test-ext',
    );
    assert.deepStrictEqual(entry!.spaceMode, {
      spaceId: 'sp-456',
      spaceName: 'Personal',
      color: '#ff0000',
    });
  });

  it('spaceMode is null when context.mode is page', () => {
    const modeEntry: ClosedWindowModeEntry = { value: 'page', metadata: {} };
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      modeEntry,
      capturedBounds(null),
      'test-ext',
    );
    assert.strictEqual(entry!.spaceMode, null);
  });

  it('spaceMode is null when context is null', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      null,
      capturedBounds(null),
      'test-ext',
    );
    assert.strictEqual(entry!.spaceMode, null);
  });
});

describe('Entry creation logic', () => {
  it('saves entries with http URLs', () => {
    const entry = createClosedWindowEntry(
      { address: 'http://example.com' },
      null,
      capturedBounds(null),
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
    assert.strictEqual(entry!.url, 'http://example.com');
  });

  it('saves entries with https URLs', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      null,
      capturedBounds(null),
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
  });

  it('saves peek://<id>/ URLs (feature windows)', () => {
    const entry = createClosedWindowEntry(
      { address: 'peek://groups/home.html' },
      null,
      capturedBounds(null),
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
    assert.strictEqual(entry!.url, 'peek://groups/home.html');
  });

  it('saves peek://app/ URLs (app pages)', () => {
    const entry = createClosedWindowEntry(
      { address: 'peek://app/settings/settings.html' },
      null,
      capturedBounds(null),
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
    assert.strictEqual(entry!.url, 'peek://app/settings/settings.html');
  });

  it('saves peek://app/page URLs', () => {
    const entry = createClosedWindowEntry(
      { address: 'peek://app/page/index.html' },
      null,
      capturedBounds(null),
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
  });

  it('does NOT save peek://app/background.html', () => {
    const entry = createClosedWindowEntry(
      { address: 'peek://app/background.html' },
      null,
      capturedBounds(null),
      'test-ext',
    );
    assert.strictEqual(entry, null);
  });

  it('does NOT save file:// URLs', () => {
    const entry = createClosedWindowEntry(
      { address: 'file:///tmp/test.html' },
      null,
      capturedBounds(null),
      'test-ext',
    );
    assert.strictEqual(entry, null);
  });

  it('does NOT save when address is undefined', () => {
    const entry = createClosedWindowEntry(
      {},
      null,
      capturedBounds(null),
      'test-ext',
    );
    assert.strictEqual(entry, null);
  });

  it('saves content role windows (role=content)', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com', role: 'content' },
      null,
      capturedBounds(null),
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
  });

  it('saves child-content role windows', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com', role: 'child-content' },
      null,
      capturedBounds(null),
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
  });

  it('saves workspace role windows', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com', role: 'workspace' },
      null,
      capturedBounds(null),
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
  });

  it('saves windows with no role (default content)', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      null,
      capturedBounds(null),
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
  });

  it('does NOT save modal windows', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com', modal: true },
      null,
      capturedBounds(null),
      'test-ext',
    );
    assert.strictEqual(entry, null);
  });

  it('does NOT save keepLive windows', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com', keepLive: true },
      null,
      capturedBounds(null),
      'test-ext',
    );
    assert.strictEqual(entry, null);
  });

  it('does NOT save non-content roles (e.g. palette)', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com', role: 'palette' },
      null,
      capturedBounds(null),
      'test-ext',
    );
    assert.strictEqual(entry, null);
  });

  it('captures bounds from the presentation unchanged (no canvas-margin adjustment)', () => {
    const bounds = { x: 100, y: 200, width: 800, height: 600 };
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      null,
      capturedPresentation(bounds),
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
    // The canvas-margin fallback (subtracting a fixed chrome margin from
    // window bounds) was deleted with the canvas page-host; bounds now pass
    // through exactly as the presenter reported them.
    assert.deepStrictEqual(entry!.bounds, bounds);
  });

  it('falls back to raw captured bounds when no presentation resolved', () => {
    const bounds = { x: 50, y: 60, width: 700, height: 500 };
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      null,
      capturedBounds(bounds),
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
    assert.deepStrictEqual(entry!.bounds, bounds);
  });

  it('entry uses spaceMode field (not groupMode)', () => {
    const modeEntry: ClosedWindowModeEntry = {
      value: 'space',
      metadata: { spaceId: 'sp-1', spaceName: 'TestSpace' },
    };
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      modeEntry,
      capturedBounds(null),
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
    // Verify spaceMode is present (not groupMode)
    assert.ok('spaceMode' in entry!);
    assert.strictEqual((entry as any).groupMode, undefined);
    // Verify spaceId/spaceName (not groupId/groupName)
    assert.strictEqual(entry!.spaceMode!.spaceId, 'sp-1');
    assert.strictEqual(entry!.spaceMode!.spaceName, 'TestSpace');
    assert.strictEqual((entry!.spaceMode as any).groupId, undefined);
    assert.strictEqual((entry!.spaceMode as any).groupName, undefined);
  });

  it('null bounds are preserved as null', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      null,
      capturedBounds(null),
      'test-ext',
    );
    assert.strictEqual(entry!.bounds, null);
  });

  it('peek:// URLs get the same unadjusted bounds passthrough as web URLs', () => {
    const bounds = { x: 100, y: 200, width: 800, height: 600 };
    const entry = createClosedWindowEntry(
      { address: 'peek://groups/home.html' },
      null,
      capturedPresentation(bounds),
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
    assert.deepStrictEqual(entry!.bounds, bounds);
  });

  it('uses currentUrl when available instead of original address', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com', currentUrl: 'https://example.com/deep/page' },
      null,
      capturedBounds({ x: 100, y: 200, width: 800, height: 600 }),
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
    assert.strictEqual(entry!.url, 'https://example.com/deep/page');
    assert.strictEqual(entry!.originalUrl, 'https://example.com');
  });

  it('falls back to address when currentUrl is not set', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      null,
      capturedBounds({ x: 100, y: 200, width: 800, height: 600 }),
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
    assert.strictEqual(entry!.url, 'https://example.com');
    assert.strictEqual(entry!.originalUrl, undefined);
  });

  it('includes scroll position when set', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com', scrollX: 0, scrollY: 1500 },
      null,
      capturedBounds({ x: 100, y: 200, width: 800, height: 600 }),
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
    assert.strictEqual(entry!.scrollY, 1500);
  });

  it('omits scroll position when not set', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      null,
      capturedBounds({ x: 100, y: 200, width: 800, height: 600 }),
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
    assert.strictEqual(entry!.scrollX, undefined);
    assert.strictEqual(entry!.scrollY, undefined);
  });
});

describe('Back/forward trail capture', () => {
  it('carries the trail onto the entry when one was cached for the window', () => {
    const trail = {
      navHistory: [
        { url: 'https://example.com/a', title: 'A' },
        { url: 'https://example.com/b', title: 'B' },
      ],
      navHistoryIndex: 1,
    };
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      null,
      capturedBounds(null),
      'test-ext',
      trail,
    );
    assert.notStrictEqual(entry, null);
    assert.deepStrictEqual(entry!.navHistory, trail.navHistory);
    assert.strictEqual(entry!.navHistoryIndex, 1);
  });

  it('writes no trail keys at all when the window had none', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      null,
      capturedBounds(null),
      'test-ext',
      null,
    );
    assert.notStrictEqual(entry, null);
    // Absent rather than explicitly undefined, so the persisted JSON stays clean.
    assert.strictEqual('navHistory' in entry!, false);
    assert.strictEqual('navHistoryIndex' in entry!, false);
  });
});

describe('Maximize state capture', () => {
  it('keeps the presentation bounds and writes no maximize fields when not maximized', () => {
    const bounds = { x: 0, y: 0, width: 1280, height: 800 };
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      null,
      capturedPresentation(bounds, false, null),
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
    assert.deepStrictEqual(entry!.bounds, bounds);
    assert.strictEqual('maximized' in entry!, false);
    assert.strictEqual('preMaximizeBounds' in entry!, false);
  });

  it('saves the pre-maximize bounds and records maximized when the presentation is maximized', () => {
    const workAreaBounds = { x: 0, y: 0, width: 1920, height: 1080 };
    const preMax = { x: 100, y: 100, width: 800, height: 600 };
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      null,
      capturedPresentation(workAreaBounds, true, preMax),
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
    assert.deepStrictEqual(entry!.bounds, preMax);
    assert.strictEqual(entry!.maximized, true);
    assert.strictEqual('preMaximizeBounds' in entry!, false);
  });

  it('maximized with no pre-maximize bounds saves the presentation bounds as-is', () => {
    const workAreaBounds = { x: 0, y: 0, width: 1920, height: 1080 };
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      null,
      capturedPresentation(workAreaBounds, true, null),
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
    assert.deepStrictEqual(entry!.bounds, workAreaBounds);
    assert.strictEqual(entry!.maximized, true);
  });

  it('falls back to the raw captured bounds when captured has no presentation at all', () => {
    const bounds = { x: 10, y: 10, width: 400, height: 300 };
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      null,
      capturedBounds(bounds),
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
    assert.deepStrictEqual(entry!.bounds, bounds);
    assert.strictEqual('maximized' in entry!, false);
  });
});
