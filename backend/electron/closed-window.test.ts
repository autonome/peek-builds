/**
 * Unit tests for closed window stack and reopen-last-closed logic
 *
 * Tests the pure logic extracted from main.ts:
 * - pushClosedWindow / popClosedWindow: LIFO stack with max capacity
 * - createClosedWindowEntry: determines whether a closed window should be saved
 *   and builds the entry with correct spaceMode capture
 *
 * All functions are pure (no Electron dependencies) so they can run
 * under ELECTRON_RUN_AS_NODE=1 without a real display server.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';

// ============================================================================
// Types (mirrored from main.ts)
// ============================================================================

interface ClosedWindowEntry {
  url: string;
  source: string;
  bounds: { x: number; y: number; width: number; height: number } | null;
  spaceMode: { spaceId: string; spaceName: string; color?: string } | null;
  timestamp: number;
}

interface WindowParams {
  address?: string;
  role?: string;
  keepLive?: boolean;
  modal?: boolean;
}

interface ContextEntry {
  value: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Pure logic functions (extracted from main.ts - identical implementations)
// ============================================================================

const MAX_CLOSED_WINDOWS = 20;

let closedWindowStack: ClosedWindowEntry[] = [];

function pushClosedWindow(entry: ClosedWindowEntry): void {
  closedWindowStack.push(entry);
  if (closedWindowStack.length > MAX_CLOSED_WINDOWS) {
    closedWindowStack.shift();
  }
}

function popClosedWindow(): ClosedWindowEntry | undefined {
  return closedWindowStack.pop();
}

function getClosedWindowCount(): number {
  return closedWindowStack.length;
}

/**
 * Determine whether a closed window should be saved to the stack,
 * and if so, build the ClosedWindowEntry.
 *
 * Extracted from the window 'closed' handler in main.ts (~line 294-341).
 */
function createClosedWindowEntry(
  params: WindowParams,
  modeEntry: ContextEntry | null,
  lastBounds: { x: number; y: number; width: number; height: number } | null,
  source: string,
): ClosedWindowEntry | null {
  const address = params.address;
  const role = params.role;
  const isKeepLive = params.keepLive === true;
  const isModal = params.modal === true;
  const isWebUrl = address && (address.startsWith('http://') || address.startsWith('https://'));
  const isContentRole = !role || role === 'content' || role === 'child-content' || role === 'workspace';

  if (!isWebUrl || !isContentRole || isKeepLive || isModal) {
    return null;
  }

  // Check for space mode context
  let spaceMode: ClosedWindowEntry['spaceMode'] = null;
  if (modeEntry && modeEntry.value === 'space' && modeEntry.metadata) {
    spaceMode = {
      spaceId: modeEntry.metadata.spaceId as string,
      spaceName: modeEntry.metadata.spaceName as string,
      color: modeEntry.metadata.color as string | undefined,
    };
  }

  // For canvas pages, convert window bounds back to webview bounds
  let saveBounds = lastBounds;
  if (lastBounds && isWebUrl) {
    const CANVAS_MARGIN = 8;
    const CANVAS_TRIGGER_ZONE = 8;
    const CANVAS_NAVBAR_HEIGHT = 36;
    saveBounds = {
      x: lastBounds.x + CANVAS_MARGIN,
      y: lastBounds.y + CANVAS_TRIGGER_ZONE + CANVAS_NAVBAR_HEIGHT,
      width: lastBounds.width - CANVAS_MARGIN * 2,
      height: lastBounds.height - CANVAS_TRIGGER_ZONE - CANVAS_MARGIN - CANVAS_NAVBAR_HEIGHT,
    };
  }

  return {
    url: address!,
    source,
    bounds: saveBounds,
    spaceMode,
    timestamp: Date.now(),
  };
}

// ============================================================================
// Helper
// ============================================================================

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
    closedWindowStack = [];
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

  it('stack caps at MAX_CLOSED_WINDOWS (20) — pushing 21st drops the oldest', () => {
    for (let i = 0; i < 21; i++) {
      pushClosedWindow(makeEntry({ url: `https://example.com/page${i}` }));
    }
    assert.strictEqual(getClosedWindowCount(), 20);
    // The oldest (page0) should have been dropped; most recent pop is page20
    const newest = popClosedWindow();
    assert.strictEqual(newest?.url, 'https://example.com/page20');
    // After popping all 19 remaining, the oldest should be page1 (page0 was evicted)
    for (let i = 0; i < 18; i++) {
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
  it('captures spaceMode when context.mode is space with spaceId/spaceName', () => {
    const modeEntry: ContextEntry = {
      value: 'space',
      metadata: { spaceId: 'sp-123', spaceName: 'Work' },
    };
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      modeEntry,
      null,
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
    const modeEntry: ContextEntry = {
      value: 'space',
      metadata: { spaceId: 'sp-456', spaceName: 'Personal', color: '#ff0000' },
    };
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      modeEntry,
      null,
      'test-ext',
    );
    assert.deepStrictEqual(entry!.spaceMode, {
      spaceId: 'sp-456',
      spaceName: 'Personal',
      color: '#ff0000',
    });
  });

  it('spaceMode is null when context.mode is page', () => {
    const modeEntry: ContextEntry = { value: 'page', metadata: {} };
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      modeEntry,
      null,
      'test-ext',
    );
    assert.strictEqual(entry!.spaceMode, null);
  });

  it('spaceMode is null when context is null', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      null,
      null,
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
      null,
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
    assert.strictEqual(entry!.url, 'http://example.com');
  });

  it('saves entries with https URLs', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      null,
      null,
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
  });

  it('does NOT save non-web URLs (peek://)', () => {
    const entry = createClosedWindowEntry(
      { address: 'peek://app/page/index.html' },
      null,
      null,
      'test-ext',
    );
    assert.strictEqual(entry, null);
  });

  it('does NOT save file:// URLs', () => {
    const entry = createClosedWindowEntry(
      { address: 'file:///tmp/test.html' },
      null,
      null,
      'test-ext',
    );
    assert.strictEqual(entry, null);
  });

  it('does NOT save when address is undefined', () => {
    const entry = createClosedWindowEntry(
      {},
      null,
      null,
      'test-ext',
    );
    assert.strictEqual(entry, null);
  });

  it('saves content role windows (role=content)', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com', role: 'content' },
      null,
      null,
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
  });

  it('saves child-content role windows', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com', role: 'child-content' },
      null,
      null,
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
  });

  it('saves workspace role windows', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com', role: 'workspace' },
      null,
      null,
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
  });

  it('saves windows with no role (default content)', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      null,
      null,
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
  });

  it('does NOT save modal windows', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com', modal: true },
      null,
      null,
      'test-ext',
    );
    assert.strictEqual(entry, null);
  });

  it('does NOT save keepLive windows', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com', keepLive: true },
      null,
      null,
      'test-ext',
    );
    assert.strictEqual(entry, null);
  });

  it('does NOT save non-content roles (e.g. palette)', () => {
    const entry = createClosedWindowEntry(
      { address: 'https://example.com', role: 'palette' },
      null,
      null,
      'test-ext',
    );
    assert.strictEqual(entry, null);
  });

  it('captures bounds from the window', () => {
    const bounds = { x: 100, y: 200, width: 800, height: 600 };
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      null,
      bounds,
      'test-ext',
    );
    assert.notStrictEqual(entry, null);
    // Bounds are adjusted for canvas margins
    assert.notStrictEqual(entry!.bounds, null);
    assert.strictEqual(entry!.bounds!.x, 108); // 100 + CANVAS_MARGIN(8)
    assert.strictEqual(entry!.bounds!.y, 244); // 200 + TRIGGER_ZONE(8) + NAVBAR(36)
    assert.strictEqual(entry!.bounds!.width, 784); // 800 - MARGIN*2(16)
    assert.strictEqual(entry!.bounds!.height, 548); // 600 - TRIGGER(8) - MARGIN(8) - NAVBAR(36)
  });

  it('entry uses spaceMode field (not groupMode)', () => {
    const modeEntry: ContextEntry = {
      value: 'space',
      metadata: { spaceId: 'sp-1', spaceName: 'TestSpace' },
    };
    const entry = createClosedWindowEntry(
      { address: 'https://example.com' },
      modeEntry,
      null,
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
      null,
      'test-ext',
    );
    assert.strictEqual(entry!.bounds, null);
  });
});
