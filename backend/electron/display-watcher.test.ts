/**
 * Unit tests for display-watcher group-based distance scaling logic
 *
 * These test the pure math functions extracted from display-watcher.ts:
 * - findDisplayForPoint: determine which display contains a point
 * - isWindowAccessible: check if a window title bar is reachable
 * - findBestNewDisplay: find the closest display to place a displaced window
 * - calculateGroupRepositionedBounds: group-based distance scaling for new display
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
// Pure logic functions (extracted from display-watcher.ts - identical implementations)
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
    throw new Error("No displays available");
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

function calculateGroupRepositionedBounds(
  windowBounds: Rectangle[],
  oldDisplay: DisplaySnapshot,
  newDisplay: DisplaySnapshot
): Rectangle[] {
  const oldWA = oldDisplay.workArea;
  const newWA = newDisplay.workArea;

  const scaleX = oldWA.width > 0 ? newWA.width / oldWA.width : 1;
  const scaleY = oldWA.height > 0 ? newWA.height / oldWA.height : 1;

  const centers = windowBounds.map(wb => ({
    x: wb.x + wb.width / 2,
    y: wb.y + wb.height / 2,
  }));

  let minCX = Infinity, maxCX = -Infinity;
  let minCY = Infinity, maxCY = -Infinity;
  for (const c of centers) {
    minCX = Math.min(minCX, c.x);
    maxCX = Math.max(maxCX, c.x);
    minCY = Math.min(minCY, c.y);
    maxCY = Math.max(maxCY, c.y);
  }

  const groupCenterX = (minCX + maxCX) / 2;
  const groupCenterY = (minCY + maxCY) / 2;

  const groupRelX = oldWA.width > 0 ? (groupCenterX - oldWA.x) / oldWA.width : 0.5;
  const groupRelY = oldWA.height > 0 ? (groupCenterY - oldWA.y) / oldWA.height : 0.5;
  const newGroupCenterX = newWA.x + groupRelX * newWA.width;
  const newGroupCenterY = newWA.y + groupRelY * newWA.height;

  const results: Rectangle[] = [];

  for (let i = 0; i < windowBounds.length; i++) {
    const wb = windowBounds[i];
    const center = centers[i];

    const offsetX = center.x - groupCenterX;
    const offsetY = center.y - groupCenterY;

    const scaledOffsetX = offsetX * scaleX;
    const scaledOffsetY = offsetY * scaleY;

    let newW = Math.round(wb.width * scaleX);
    let newH = Math.round(wb.height * scaleY);

    newW = Math.max(newW, 200);
    newH = Math.max(newH, 150);

    newW = Math.min(newW, newWA.width);
    newH = Math.min(newH, newWA.height);

    const newCenterX = newGroupCenterX + scaledOffsetX;
    const newCenterY = newGroupCenterY + scaledOffsetY;

    let newX = Math.round(newCenterX - newW / 2);
    let newY = Math.round(newCenterY - newH / 2);

    newX = Math.max(newWA.x, Math.min(newX, newWA.x + newWA.width - newW));
    newY = Math.max(newWA.y, Math.min(newY, newWA.y + newWA.height - newH));

    results.push({ x: newX, y: newY, width: newW, height: newH });
  }

  return results;
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

describe("Display Watcher - Pure Logic", () => {

  describe("findDisplayForPoint", () => {
    const displays = [display1440, display1080];

    it("finds point on primary display", () => {
      const result = findDisplayForPoint(displays, 500, 500);
      assert.strictEqual(result?.id, 1);
    });

    it("finds point on secondary display", () => {
      const result = findDisplayForPoint(displays, 3000, 500);
      assert.strictEqual(result?.id, 2);
    });

    it("returns null for point off all displays", () => {
      const result = findDisplayForPoint(displays, -100, -100);
      assert.strictEqual(result, null);
    });

    it("finds point at display boundary (top-left of workArea)", () => {
      const result = findDisplayForPoint(displays, 0, 25);
      assert.strictEqual(result?.id, 1);
    });

    it("point in menu bar area found via bounds fallback", () => {
      const result = findDisplayForPoint(displays, 500, 5);
      assert.strictEqual(result?.id, 1);
    });

    it("returns null for empty display list", () => {
      const result = findDisplayForPoint([], 500, 500);
      assert.strictEqual(result, null);
    });

    it("finds correct display at boundary between two displays", () => {
      const left = findDisplayForPoint(displays, 2559, 500);
      assert.strictEqual(left?.id, 1);
      const right = findDisplayForPoint(displays, 2560, 500);
      assert.strictEqual(right?.id, 2);
    });
  });

  describe("isWindowAccessible", () => {
    const displays = [display1440, display1080];

    it("window fully on primary display is accessible", () => {
      assert.strictEqual(isWindowAccessible(displays, { x: 100, y: 100, width: 800, height: 600 }), true);
    });

    it("window fully on secondary display is accessible", () => {
      assert.strictEqual(isWindowAccessible(displays, { x: 3000, y: 100, width: 800, height: 600 }), true);
    });

    it("window completely off-screen is not accessible", () => {
      assert.strictEqual(isWindowAccessible(displays, { x: -2000, y: -2000, width: 800, height: 600 }), false);
    });

    it("window below all displays is not accessible", () => {
      assert.strictEqual(isWindowAccessible(displays, { x: 500, y: 5000, width: 800, height: 600 }), false);
    });

    it("window partially off-screen but title bar reachable is accessible", () => {
      assert.strictEqual(isWindowAccessible(displays, { x: 100, y: 1200, width: 800, height: 600 }), true);
    });

    it("window above screen with title bar off-screen is not accessible", () => {
      assert.strictEqual(isWindowAccessible(displays, { x: 100, y: -500, width: 800, height: 600 }), false);
    });

    it("uses center X for accessibility check", () => {
      assert.strictEqual(isWindowAccessible(displays, { x: 2400, y: 100, width: 1120, height: 600 }), true);
    });
  });

  describe("findBestNewDisplay", () => {
    it("returns same display if ID matches", () => {
      const result = findBestNewDisplay(display1440, [display1440, display1080], 1);
      assert.strictEqual(result.id, 1);
    });

    it("returns closest display when old display is removed", () => {
      const result = findBestNewDisplay(display1080, [display1440], 1);
      assert.strictEqual(result.id, 1);
    });

    it("returns primary display when no old display info", () => {
      const result = findBestNewDisplay(null, [display1080, display1440], 1);
      assert.strictEqual(result.id, 1);
    });

    it("returns first display when no old display and no primary match", () => {
      const result = findBestNewDisplay(null, [display1080, displayLaptop], 999);
      assert.strictEqual(result.id, 2);
    });

    it("picks closest by center distance when multiple candidates", () => {
      const farRight: DisplaySnapshot = {
        id: 99,
        bounds: { x: 5000, y: 0, width: 1920, height: 1080 },
        workArea: { x: 5000, y: 25, width: 1920, height: 1055 },
      };
      const result = findBestNewDisplay(farRight, [display1440, display1080], 1);
      assert.strictEqual(result.id, 2);
    });

    it("throws when no displays available", () => {
      assert.throws(() => findBestNewDisplay(display1440, [], 1), /No displays available/);
    });
  });

  describe("calculateGroupRepositionedBounds (single window)", () => {
    it("centers a centered window on the new display with scaled dimensions", () => {
      const winBounds = [{ x: 880, y: 420, width: 800, height: 600 }];
      const [result] = calculateGroupRepositionedBounds(winBounds, display1440, displayLaptop);
      // Width scales by 1440/2560 = 0.5625, so 800 * 0.5625 = 450
      assert.ok(result.width >= 400 && result.width <= 500, `width=${result.width} should scale ~450`);
      assert.ok(result.height >= 300 && result.height <= 420, `height=${result.height} should scale`);
    });

    it("preserves relative position for a single window", () => {
      // Window at top-left of old display
      const [result] = calculateGroupRepositionedBounds(
        [{ x: 0, y: 25, width: 800, height: 600 }], display1440, displayLaptop
      );
      // Single window: center maps to same relative position
      // Old center: (400, 325), rel: (400/2560, 300/1415) = (0.156, 0.212)
      // New center: (0.156*1440, 25+0.212*875) = (225, 210)
      // Scaled size: ~450x371, so top-left: ~(0, 25)
      assert.ok(result.x >= 0 && result.x <= 10, `x=${result.x} should be near left`);
      assert.ok(result.y >= 25 && result.y <= 35, `y=${result.y} should be near top`);
    });

    it("clamps bottom-right window within new workArea", () => {
      const [result] = calculateGroupRepositionedBounds(
        [{ x: 1760, y: 840, width: 800, height: 600 }], display1440, displayLaptop
      );
      const rightEdge = displayLaptop.workArea.x + displayLaptop.workArea.width;
      const bottomEdge = displayLaptop.workArea.y + displayLaptop.workArea.height;
      assert.ok(result.x + result.width <= rightEdge,
        `right edge ${result.x + result.width} should not exceed ${rightEdge}`);
      assert.ok(result.y + result.height <= bottomEdge,
        `bottom edge ${result.y + result.height} should not exceed ${bottomEdge}`);
    });

    it("enforces minimum window size of 200x150", () => {
      const tinyDisplay: DisplaySnapshot = {
        id: 10,
        bounds: { x: 0, y: 0, width: 400, height: 300 },
        workArea: { x: 0, y: 25, width: 400, height: 275 },
      };
      const [result] = calculateGroupRepositionedBounds(
        [{ x: 0, y: 25, width: 100, height: 80 }], display1440, tinyDisplay
      );
      assert.ok(result.width >= 200, `width ${result.width} should be >= 200`);
      assert.ok(result.height >= 150, `height ${result.height} should be >= 150`);
    });

    it("caps window size to new workArea dimensions", () => {
      const [result] = calculateGroupRepositionedBounds(
        [{ x: 0, y: 25, width: 2560, height: 1415 }], display1440, displayLaptop
      );
      assert.ok(result.width <= displayLaptop.workArea.width);
      assert.ok(result.height <= displayLaptop.workArea.height);
    });

    it("same display dimensions produces same bounds for centered window", () => {
      const winBounds = { x: 500, y: 300, width: 800, height: 600 };
      const [result] = calculateGroupRepositionedBounds([winBounds], display1440, display1440);
      assert.strictEqual(result.x, winBounds.x);
      assert.strictEqual(result.y, winBounds.y);
      assert.strictEqual(result.width, winBounds.width);
      assert.strictEqual(result.height, winBounds.height);
    });

    it("handles secondary display offset correctly", () => {
      const [result] = calculateGroupRepositionedBounds(
        [{ x: 2660, y: 100, width: 800, height: 600 }], display1080, display1440
      );
      assert.ok(result.x >= 0 && result.x < 200, `x=${result.x} should be near left on primary`);
    });

    it("proportionally scales window going from large to small display", () => {
      const [result] = calculateGroupRepositionedBounds(
        [{ x: 640, y: 25, width: 1280, height: 700 }], display1440, displayLaptop
      );
      const widthRatio = result.width / displayLaptop.workArea.width;
      assert.ok(widthRatio > 0.4 && widthRatio < 0.6,
        `width ratio ${widthRatio.toFixed(2)} should be ~0.5`);
    });

    it("handles zero-size old workArea gracefully", () => {
      const zeroDisplay: DisplaySnapshot = {
        id: 99,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        workArea: { x: 0, y: 0, width: 0, height: 0 },
      };
      const [result] = calculateGroupRepositionedBounds(
        [{ x: 0, y: 0, width: 800, height: 600 }], zeroDisplay, displayLaptop
      );
      assert.ok(result.width > 0 && result.height > 0, "should produce valid dimensions");
    });
  });

  describe("calculateGroupRepositionedBounds (multi-window distance scaling)", () => {
    it("scales distance between two windows proportionally (small to large)", () => {
      // Two windows 500px apart horizontally on laptop (1440x875)
      const wins = [
        { x: 200, y: 200, width: 400, height: 300 },
        { x: 700, y: 200, width: 400, height: 300 },
      ];
      // Old centers: (400, 350) and (900, 350), distance = 500px
      const results = calculateGroupRepositionedBounds(wins, displayLaptop, display1440);
      // Scale factor X: 2560/1440 = 1.778
      // Expected distance: 500 * 1.778 = ~889px
      const dist = Math.abs((results[1].x + results[1].width/2) - (results[0].x + results[0].width/2));
      assert.ok(dist > 800 && dist < 1000,
        `distance ${dist} should be ~889 (500 * 2560/1440)`);
    });

    it("scales distance between two windows proportionally (large to small)", () => {
      // Two windows 1000px apart on big display (2560x1415)
      const wins = [
        { x: 400, y: 400, width: 600, height: 400 },
        { x: 1400, y: 400, width: 600, height: 400 },
      ];
      // Old centers: (700, 600) and (1700, 600), distance = 1000px
      const results = calculateGroupRepositionedBounds(wins, display1440, displayLaptop);
      // Scale factor X: 1440/2560 = 0.5625
      // Expected distance: 1000 * 0.5625 = ~563px
      const dist = Math.abs((results[1].x + results[1].width/2) - (results[0].x + results[0].width/2));
      assert.ok(dist > 480 && dist < 640,
        `distance ${dist} should be ~563 (1000 * 1440/2560)`);
    });

    it("preserves relative arrangement of windows in a grid", () => {
      // 2x2 grid of windows on laptop
      const wins = [
        { x: 100, y: 50,  width: 400, height: 300 },  // top-left
        { x: 700, y: 50,  width: 400, height: 300 },  // top-right
        { x: 100, y: 450, width: 400, height: 300 },  // bottom-left
        { x: 700, y: 450, width: 400, height: 300 },  // bottom-right
      ];
      const results = calculateGroupRepositionedBounds(wins, displayLaptop, display1440);
      // top-left should still be left of top-right
      assert.ok(results[0].x < results[1].x, "top-left should be left of top-right");
      // top-left should still be above bottom-left
      assert.ok(results[0].y < results[2].y, "top-left should be above bottom-left");
      // top-right should still be above bottom-right
      assert.ok(results[1].y < results[3].y, "top-right should be above bottom-right");
      // bottom-left should still be left of bottom-right
      assert.ok(results[2].x < results[3].x, "bottom-left should be left of bottom-right");
    });

    it("windows spread out more on larger display", () => {
      // Three windows in a row on laptop
      const wins = [
        { x: 100, y: 200, width: 300, height: 300 },
        { x: 500, y: 200, width: 300, height: 300 },
        { x: 900, y: 200, width: 300, height: 300 },
      ];
      const resultsLarge = calculateGroupRepositionedBounds(wins, displayLaptop, display1440);
      // Bounding width of results should be larger than original
      const origSpan = (900 + 300) - 100; // 1100px
      const newSpan = (resultsLarge[2].x + resultsLarge[2].width) - resultsLarge[0].x;
      assert.ok(newSpan > origSpan,
        `new span ${newSpan} should be larger than original ${origSpan}`);
    });

    it("windows cluster closer on smaller display", () => {
      // Three windows in a row on big display
      const wins = [
        { x: 200, y: 400, width: 500, height: 400 },
        { x: 900, y: 400, width: 500, height: 400 },
        { x: 1600, y: 400, width: 500, height: 400 },
      ];
      const resultsSmall = calculateGroupRepositionedBounds(wins, display1440, displayLaptop);
      // Bounding width should be smaller
      const origSpan = (1600 + 500) - 200; // 1900px
      const newSpan = (resultsSmall[2].x + resultsSmall[2].width) - resultsSmall[0].x;
      assert.ok(newSpan < origSpan,
        `new span ${newSpan} should be smaller than original ${origSpan}`);
    });

    it("all windows clamped to stay within new workArea", () => {
      // Windows spread across the full width of big display
      const wins = [
        { x: 0,    y: 25,  width: 600, height: 400 },
        { x: 1960, y: 25,  width: 600, height: 400 },
      ];
      const results = calculateGroupRepositionedBounds(wins, display1440, displayLaptop);
      const wa = displayLaptop.workArea;
      for (const r of results) {
        assert.ok(r.x >= wa.x, `x=${r.x} should be >= ${wa.x}`);
        assert.ok(r.y >= wa.y, `y=${r.y} should be >= ${wa.y}`);
        assert.ok(r.x + r.width <= wa.x + wa.width,
          `right edge ${r.x + r.width} should be <= ${wa.x + wa.width}`);
        assert.ok(r.y + r.height <= wa.y + wa.height,
          `bottom edge ${r.y + r.height} should be <= ${wa.y + wa.height}`);
      }
    });

    it("single window in group behaves same as single-element array", () => {
      const win = { x: 500, y: 300, width: 800, height: 600 };
      const [result] = calculateGroupRepositionedBounds([win], display1440, displayLaptop);
      // Should be deterministic
      const [result2] = calculateGroupRepositionedBounds([win], display1440, displayLaptop);
      assert.strictEqual(result.x, result2.x);
      assert.strictEqual(result.y, result2.y);
      assert.strictEqual(result.width, result2.width);
      assert.strictEqual(result.height, result2.height);
    });
  });
});
