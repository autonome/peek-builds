/**
 * Unit tests for visible window focus tracking and stale ID cleanup.
 *
 * Tests the pure logic extracted from ipc.ts:
 * - trackVisibleWindowFocus: updates lastFocusedVisibleWindowId
 * - clearLastFocusedVisibleWindowId: clears stale ID on window close
 * - getFocusedVisibleWindowId: returns the tracked ID
 *
 * Bug: When a window closes, main.ts clears the IZUI coordinator's focus
 * but does NOT clear lastFocusedVisibleWindowId. This causes
 * getFocusedVisibleWindowId() to return a stale (closed) window ID.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';

// ============================================================================
// Pure logic (mirrored from ipc.ts — identical implementations)
// ============================================================================

let lastFocusedVisibleWindowId: number | null = null;

interface MockWindow {
  id: number;
  url: string;
  focusable: boolean;
  role?: string;
}

/**
 * Mirrors trackVisibleWindowFocus from ipc.ts.
 * Excludes background, non-focusable, and overlay windows.
 */
function trackVisibleWindowFocus(win: MockWindow): void {
  if (win.url === 'peek://app/background.html') {
    return;
  }
  if (!win.focusable) {
    return;
  }
  if (win.role === 'overlay') {
    return;
  }
  lastFocusedVisibleWindowId = win.id;
}

/**
 * Mirrors `getLastFocusedVisibleWindowId()` exported from ipc.ts and used by
 * the strict tile:window:get-focused-visible-id handler in tile-ipc.ts.
 */
function getFocusedVisibleWindowId(): number | null {
  return lastFocusedVisibleWindowId;
}

/**
 * Clears lastFocusedVisibleWindowId if it matches the given window ID.
 * Should be called when a window closes, alongside IZUI coordinator cleanup.
 *
 * THIS IS THE FIX: this function does not exist in ipc.ts yet.
 */
function clearLastFocusedVisibleWindowId(windowId: number): void {
  if (lastFocusedVisibleWindowId === windowId) {
    lastFocusedVisibleWindowId = null;
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('Visible window focus tracking', () => {
  beforeEach(() => {
    lastFocusedVisibleWindowId = null;
  });

  it('tracks a normal visible window', () => {
    trackVisibleWindowFocus({ id: 1, url: 'https://example.com', focusable: true });
    assert.strictEqual(getFocusedVisibleWindowId(), 1);
  });

  it('does not track background windows', () => {
    trackVisibleWindowFocus({ id: 1, url: 'peek://app/background.html', focusable: true });
    assert.strictEqual(getFocusedVisibleWindowId(), null);
  });

  it('does not track non-focusable windows', () => {
    trackVisibleWindowFocus({ id: 1, url: 'https://example.com', focusable: false });
    assert.strictEqual(getFocusedVisibleWindowId(), null);
  });

  it('does not track overlay windows', () => {
    trackVisibleWindowFocus({ id: 1, url: 'peek://ext/switcher/index.html', focusable: true, role: 'overlay' });
    assert.strictEqual(getFocusedVisibleWindowId(), null);
  });

  it('updates to most recently focused window', () => {
    trackVisibleWindowFocus({ id: 1, url: 'https://a.com', focusable: true });
    trackVisibleWindowFocus({ id: 2, url: 'https://b.com', focusable: true });
    assert.strictEqual(getFocusedVisibleWindowId(), 2);
  });
});

describe('Stale focused window ID cleanup on close', () => {
  beforeEach(() => {
    lastFocusedVisibleWindowId = null;
  });

  it('BUG: closing the focused window leaves stale ID without the fix', () => {
    // This test documents the bug behavior:
    // Track window A as focused, then simulate close WITHOUT clearing
    trackVisibleWindowFocus({ id: 42, url: 'https://example.com', focusable: true });
    assert.strictEqual(getFocusedVisibleWindowId(), 42);

    // Simulate what main.ts does on close: clears IZUI coordinator but NOT lastFocusedVisibleWindowId
    // (coordinator.clearFocusedWindow is separate — not modeled here)

    // With the fix applied, clearLastFocusedVisibleWindowId should clear it
    clearLastFocusedVisibleWindowId(42);
    assert.strictEqual(getFocusedVisibleWindowId(), null,
      'After closing window 42, getFocusedVisibleWindowId should return null, not stale ID 42');
  });

  it('does not clear when a different window closes', () => {
    trackVisibleWindowFocus({ id: 1, url: 'https://a.com', focusable: true });
    trackVisibleWindowFocus({ id: 2, url: 'https://b.com', focusable: true });
    assert.strictEqual(getFocusedVisibleWindowId(), 2);

    // Close window 1 (not the currently focused one)
    clearLastFocusedVisibleWindowId(1);
    assert.strictEqual(getFocusedVisibleWindowId(), 2,
      'Closing a non-focused window should not clear the focused window ID');
  });

  it('clearing when already null is a no-op', () => {
    assert.strictEqual(getFocusedVisibleWindowId(), null);
    clearLastFocusedVisibleWindowId(99);
    assert.strictEqual(getFocusedVisibleWindowId(), null);
  });

  it('full lifecycle: focus → close → no stale ID returned', () => {
    // Focus window A
    trackVisibleWindowFocus({ id: 10, url: 'https://example.com', focusable: true });
    assert.strictEqual(getFocusedVisibleWindowId(), 10);

    // Focus window B
    trackVisibleWindowFocus({ id: 20, url: 'https://other.com', focusable: true });
    assert.strictEqual(getFocusedVisibleWindowId(), 20);

    // Close window B (the focused one)
    clearLastFocusedVisibleWindowId(20);
    assert.strictEqual(getFocusedVisibleWindowId(), null,
      'After closing the focused window, ID should be null');

    // Close window A (already not focused, should be no-op)
    clearLastFocusedVisibleWindowId(10);
    assert.strictEqual(getFocusedVisibleWindowId(), null);
  });
});
