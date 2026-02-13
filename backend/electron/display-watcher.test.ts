/**
 * Unit tests for display-watcher proportional repositioning logic
 *
 * These test the pure math functions extracted from display-watcher.ts:
 * - findDisplayForPoint: determine which display contains a point
 * - isWindowAccessible: check if a window's title bar is reachable
 * - findBestNewDisplay: find the closest display to place a displaced window
 * - calculateRepositionedBounds: proportional coordinate math for new display
 *
 * All functions are pure (no Electron dependencies) so they can run
 * under ELECTRON_RUN_AS_NODE=1 without a real display server.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

// ============================================================================
// Types (mirrored from display-watcher.ts)
// ============================================================================

interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DisplaySnapshot {
  id: number;
  bounds: Rectangle;
  workArea: Rectangle;
}

// ============================================================================
// Pure logic functions (extracted from display-watcher.ts — identical implementations)
// ============================================================================

function findDisplayForPoint(displays: DisplaySnapshot[], x: number, y: number): DisplaySnapshot | null {
  for (const d of displays) {
    const wa = d.workArea;
    if (x >= wa.x && x < wa.x + wa.width && y >= wa.y && y < wa.y + wa.height) {
      return d;
    }
  }
  for (const d of displays) {
    const b = d.bounds;
    if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) {
      return d;
    }
  }
  return null;
}

function isWindowAccessible(displays: DisplaySnapshot[], bounds: Rectangle): boolean {
  const centerX = bounds.x + Math.round(bounds.width / 2);
  const topY = bounds.y + 15;
  return findDisplayForPoint(displays, centerX, topY) !== null;
}

function findBestNewDisplay(
  oldDisplay: DisplaySnapshot | null,
  newDisplays: DisplaySnapshot[],
  primaryDisplayId: number
): DisplaySnapshot {
  if (newDisplays.length === 0) {
    throw new Error('No displays available');
  }

  if (oldDisplay) {
    const sameId = newDisplays.find(d => d.id === oldDisplay.id);
    if (sameId) return sameId;

    const oldCenterX = oldDisplay.workArea.x + oldDisplay.workArea.width / 2;
    const oldCenterY = oldDisplay.workArea.y + oldDisplay.workArea.height / 2;

    let best = newDisplays[0];
    let bestDist = Infinity;
    for (const d of newDisplays) {
      const cx = d.workArea.x + d.workArea.width / 2;
      const cy = d.workArea.y + d.workArea.height / 2;
      const dist = Math.hypot(cx - oldCenterX, cy - oldCenterY);
      if (dist < bestDist) {
        bestDist = dist;
        best = d;
      }
    }
    return best;
  }

  const primary = newDisplays.find(d => d.id === primaryDisplayId);
  return primary || newDisplays[0];
}

function calculateRepositionedBounds(
  winBounds: Rectangle,
  oldDisplay: DisplaySnapshot,
  newDisplay: DisplaySnapshot
): Rectangle {
  const oldWA = oldDisplay.workArea;
  const newWA = newDisplay.workArea;

  const relX = oldWA.width > 0 ? (winBounds.x - oldWA.x) / oldWA.width : 0;
  const relY = oldWA.height > 0 ? (winBounds.y - oldWA.y) / oldWA.height : 0;
  const relW = oldWA.width > 0 ? winBounds.width / oldWA.width : 0.5;
  const relH = oldWA.height > 0 ? winBounds.height / oldWA.height : 0.5;

  let newW = Math.round(relW * newWA.width);
  let newH = Math.round(relH * newWA.height);

  newW = Math.max(newW, 200);
  newH = Math.max(newH, 150);

  newW = Math.min(newW, newWA.width);
  newH = Math.min(newH, newWA.height);

  let newX = Math.round(newWA.x + relX * newWA.width);
  let newY = Math.round(newWA.y + relY * newWA.height);

  newX = Math.max(newWA.x, Math.min(newX, newWA.x + newWA.width - newW));
  newY = Math.max(newWA.y, Math.min(newY, newWA.y + newWA.height - newH));

  return { x: newX, y: newY, width: newW, height: newH };
}

// ============================================================================
// Test fixtures
// ============================================================================

const display1440: DisplaySnapshot = {
  id: 1,
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 25, width: 2560, height: 1415 },
};

const display1080: DisplaySnapshot = {
  id: 2,
  bounds: { x: 2560, y: 0, width: 1920, height: 1080 },
  workArea: { x: 2560, y: 25, width: 1920, height: 1055 },
};

const displayLaptop: DisplaySnapshot = {
  id: 3,
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 25, width: 1440, height: 875 },
};

// ============================================================================
// Tests
// ============================================================================

describe('Display Watcher — Pure Logic', () => {

  describe('findDisplayForPoint', () => {
    const displays = [display1440, display1080];

    it('finds point on primary display', () => {
      const result = findDisplayForPoint(displays, 500, 500);
      assert.strictEqual(result?.id, 1);
    });

    it('finds point on secondary display', () => {
      const result = findDisplayForPoint(displays, 3000, 500);
      assert.strictEqual(result?.id, 2);
    });

    it('returns null for point off all displays', () => {
      const result = findDisplayForPoint(displays, -100, -100);
      assert.strictEqual(result, null);
    });

    it('finds point at display boundary (top-left of workArea)', () => {
      const result = findDisplayForPoint(displays, 0, 25);
      assert.strictEqual(result?.id, 1);
    });

    it('point in menu bar area found via bounds fallback', () => {
      const result = findDisplayForPoint(displays, 500, 5);
      assert.strictEqual(result?.id, 1);
    });

    it('returns null for empty display list', () => {
      const result = findDisplayForPoint([], 500, 500);
      assert.strictEqual(result, null);
    });

    it('finds correct display at boundary between two displays', () => {
      const left = findDisplayForPoint(displays, 2559, 500);
      assert.strictEqual(left?.id, 1);
      const right = findDisplayForPoint(displays, 2560, 500);
      assert.strictEqual(right?.id, 2);
    });
  });

  describe('isWindowAccessible', () => {
    const displays = [display1440, display1080];

    it('window fully on primary display is accessible', () => {
      assert.strictEqual(isWindowAccessible(displays, { x: 100, y: 100, width: 800, height: 600 }), true);
    });

    it('window fully on secondary display is accessible', () => {
      assert.strictEqual(isWindowAccessible(displays, { x: 3000, y: 100, width: 800, height: 600 }), true);
    });

    it('window completely off-screen is not accessible', () => {
      assert.strictEqual(isWindowAccessible(displays, { x: -2000, y: -2000, width: 800, height: 600 }), false);
    });

    it('window below all displays is not accessible', () => {
      assert.strictEqual(isWindowAccessible(displays, { x: 500, y: 5000, width: 800, height: 600 }), false);
    });

    it('window partially off-screen but title bar reachable is accessible', () => {
      assert.strictEqual(isWindowAccessible(displays, { x: 100, y: 1200, width: 800, height: 600 }), true);
    });

    it('window above screen with title bar off-screen is not accessible', () => {
      assert.strictEqual(isWindowAccessible(displays, { x: 100, y: -500, width: 800, height: 600 }), false);
    });

    it('uses center X for accessibility check', () => {
      assert.strictEqual(isWindowAccessible(displays, { x: 2400, y: 100, width: 1120, height: 600 }), true);
    });
  });

  describe('findBestNewDisplay', () => {
    it('returns same display if ID matches', () => {
      const result = findBestNewDisplay(display1440, [display1440, display1080], 1);
      assert.strictEqual(result.id, 1);
    });

    it('returns closest display when old display is removed', () => {
      const result = findBestNewDisplay(display1080, [display1440], 1);
      assert.strictEqual(result.id, 1);
    });

    it('returns primary display when no old display info', () => {
      const result = findBestNewDisplay(null, [display1080, display1440], 1);
      assert.strictEqual(result.id, 1);
    });

    it('returns first display when no old display and no primary match', () => {
      const result = findBestNewDisplay(null, [display1080, displayLaptop], 999);
      assert.strictEqual(result.id, 2);
    });

    it('picks closest by center distance when multiple candidates', () => {
      const farRight: DisplaySnapshot = {
        id: 99,
        bounds: { x: 5000, y: 0, width: 1920, height: 1080 },
        workArea: { x: 5000, y: 25, width: 1920, height: 1055 },
      };
      const result = findBestNewDisplay(farRight, [display1440, display1080], 1);
      assert.strictEqual(result.id, 2);
    });

    it('throws when no displays available', () => {
      assert.throws(() => findBestNewDisplay(display1440, [], 1), /No displays available/);
    });
  });

  describe('calculateRepositionedBounds (proportional repositioning)', () => {
    it('centers a centered window on the new display', () => {
      const winBounds = { x: 880, y: 420, width: 800, height: 600 };
      const result = calculateRepositionedBounds(winBounds, display1440, displayLaptop);
      assert.ok(result.x > 200 && result.x < 600, `x=${result.x} should be roughly centered`);
      assert.ok(result.y > 100 && result.y < 400, `y=${result.y} should be roughly centered`);
      assert.ok(result.width > 300 && result.width < 600, `width=${result.width} should scale`);
      assert.ok(result.height > 250 && result.height < 500, `height=${result.height} should scale`);
    });

    it('preserves top-left position proportionally', () => {
      const result = calculateRepositionedBounds(
        { x: 0, y: 25, width: 800, height: 600 }, display1440, displayLaptop
      );
      assert.strictEqual(result.x, 0);
      assert.strictEqual(result.y, 25);
    });

    it('clamps bottom-right window within new workArea', () => {
      const result = calculateRepositionedBounds(
        { x: 1760, y: 840, width: 800, height: 600 }, display1440, displayLaptop
      );
      const rightEdge = displayLaptop.workArea.x + displayLaptop.workArea.width;
      const bottomEdge = displayLaptop.workArea.y + displayLaptop.workArea.height;
      assert.ok(result.x + result.width <= rightEdge,
        `right edge ${result.x + result.width} should not exceed ${rightEdge}`);
      assert.ok(result.y + result.height <= bottomEdge,
        `bottom edge ${result.y + result.height} should not exceed ${bottomEdge}`);
    });

    it('enforces minimum window size of 200x150', () => {
      const tinyDisplay: DisplaySnapshot = {
        id: 10,
        bounds: { x: 0, y: 0, width: 400, height: 300 },
        workArea: { x: 0, y: 25, width: 400, height: 275 },
      };
      const result = calculateRepositionedBounds(
        { x: 0, y: 25, width: 100, height: 80 }, display1440, tinyDisplay
      );
      assert.ok(result.width >= 200, `width ${result.width} should be >= 200`);
      assert.ok(result.height >= 150, `height ${result.height} should be >= 150`);
    });

    it('caps window size to new workArea dimensions', () => {
      const result = calculateRepositionedBounds(
        { x: 0, y: 25, width: 2560, height: 1415 }, display1440, displayLaptop
      );
      assert.ok(result.width <= displayLaptop.workArea.width);
      assert.ok(result.height <= displayLaptop.workArea.height);
    });

    it('same display dimensions produces same bounds', () => {
      const winBounds = { x: 500, y: 300, width: 800, height: 600 };
      const result = calculateRepositionedBounds(winBounds, display1440, display1440);
      assert.strictEqual(result.x, winBounds.x);
      assert.strictEqual(result.y, winBounds.y);
      assert.strictEqual(result.width, winBounds.width);
      assert.strictEqual(result.height, winBounds.height);
    });

    it('handles secondary display offset correctly', () => {
      const result = calculateRepositionedBounds(
        { x: 2660, y: 100, width: 800, height: 600 }, display1080, display1440
      );
      assert.ok(result.x >= 0 && result.x < 200, `x=${result.x} should be near left on primary`);
    });

    it('proportionally scales window going from large to small display', () => {
      const result = calculateRepositionedBounds(
        { x: 640, y: 25, width: 1280, height: 700 }, display1440, displayLaptop
      );
      const widthRatio = result.width / displayLaptop.workArea.width;
      assert.ok(widthRatio > 0.4 && widthRatio < 0.6,
        `width ratio ${widthRatio.toFixed(2)} should be ~0.5`);
    });

    it('handles zero-size old workArea gracefully', () => {
      const zeroDisplay: DisplaySnapshot = {
        id: 99,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        workArea: { x: 0, y: 0, width: 0, height: 0 },
      };
      const result = calculateRepositionedBounds(
        { x: 0, y: 0, width: 800, height: 600 }, zeroDisplay, displayLaptop
      );
      assert.ok(result.width > 0 && result.height > 0, 'should produce valid dimensions');
    });
  });
});
