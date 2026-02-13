/**
 * Unit tests for display-watcher logic
 *
 * These test the pure math functions extracted from display-watcher.ts:
 * - findDisplayForPoint: determine which display contains a point
 * - isWindowAccessible: check if a window title bar is reachable
 * - findBestNewDisplay: find the closest display to place a displaced window
 * - calculateGroupRepositionedBounds: group-based distance scaling for new display
 * - computeHomeDisplay: compute home display info for a displaced window
 * - findMatchingNewDisplay: match a displaced window's home to a new display
 * - computeRestoredBounds: compute restored bounds for a displaced window
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

interface WindowHomeDisplay {
  displayId: number;
  resolution: { width: number; height: number };
  relativePosition: {
    centerX: number;
    centerY: number;
    width: number;
    height: number;
  };
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

/**
 * Compute home display info for a window being displaced from a display.
 * Pure version of saveWindowHomeDisplay (no BrowserWindow dependency).
 */
function computeHomeDisplay(
  bounds: Rectangle,
  display: DisplaySnapshot
): WindowHomeDisplay {
  const wa = display.workArea;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;

  return {
    displayId: display.id,
    resolution: { width: wa.width, height: wa.height },
    relativePosition: {
      centerX: wa.width > 0 ? (centerX - wa.x) / wa.width : 0.5,
      centerY: wa.height > 0 ? (centerY - wa.y) / wa.height : 0.5,
      width: wa.width > 0 ? bounds.width / wa.width : 0.5,
      height: wa.height > 0 ? bounds.height / wa.height : 0.5,
    },
  };
}

/**
 * Find a matching new display for a displaced window's home display.
 * Pure version identical to display-watcher.ts implementation.
 */
function findMatchingNewDisplay(
  home: WindowHomeDisplay,
  addedDisplays: DisplaySnapshot[]
): DisplaySnapshot | null {
  const byId = addedDisplays.find(d => d.id === home.displayId);
  if (byId) return byId;

  const tolerance = 0.05;
  for (const d of addedDisplays) {
    const wa = d.workArea;
    const widthRatio = home.resolution.width > 0
      ? Math.abs(wa.width - home.resolution.width) / home.resolution.width
      : (wa.width === 0 ? 0 : 1);
    const heightRatio = home.resolution.height > 0
      ? Math.abs(wa.height - home.resolution.height) / home.resolution.height
      : (wa.height === 0 ? 0 : 1);

    if (widthRatio <= tolerance && heightRatio <= tolerance) {
      return d;
    }
  }

  return null;
}

/**
 * Compute restored bounds for a window returning to its home display.
 * Pure version of restoreWindowToHomeDisplay (returns bounds instead of calling setBounds).
 */
function computeRestoredBounds(
  home: WindowHomeDisplay,
  display: DisplaySnapshot
): Rectangle {
  const wa = display.workArea;
  const rel = home.relativePosition;

  let newW = Math.round(rel.width * wa.width);
  let newH = Math.round(rel.height * wa.height);

  newW = Math.max(newW, 200);
  newH = Math.max(newH, 150);

  newW = Math.min(newW, wa.width);
  newH = Math.min(newH, wa.height);

  const centerX = wa.x + rel.centerX * wa.width;
  const centerY = wa.y + rel.centerY * wa.height;

  let newX = Math.round(centerX - newW / 2);
  let newY = Math.round(centerY - newH / 2);

  newX = Math.max(wa.x, Math.min(newX, wa.x + wa.width - newW));
  newY = Math.max(wa.y, Math.min(newY, wa.y + wa.height - newH));

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

  describe("computeHomeDisplay", () => {
    it("computes relative position for centered window", () => {
      // Window centered on 2560x1415 workArea (with 25px menu bar)
      const bounds = { x: 880, y: 420, width: 800, height: 600 };
      const home = computeHomeDisplay(bounds, display1440);

      assert.strictEqual(home.displayId, 1);
      assert.strictEqual(home.resolution.width, 2560);
      assert.strictEqual(home.resolution.height, 1415);

      // Center of window: (1280, 720), relative to workArea (0, 25, 2560, 1415)
      // relX = 1280 / 2560 = 0.5, relY = (720 - 25) / 1415 ~ 0.491
      assert.ok(Math.abs(home.relativePosition.centerX - 0.5) < 0.01,
        `centerX ${home.relativePosition.centerX} should be ~0.5`);
      assert.ok(Math.abs(home.relativePosition.centerY - 0.491) < 0.01,
        `centerY ${home.relativePosition.centerY} should be ~0.491`);

      // Width ratio: 800 / 2560 = 0.3125
      assert.ok(Math.abs(home.relativePosition.width - 0.3125) < 0.001,
        `width ratio ${home.relativePosition.width} should be ~0.3125`);
    });

    it("computes relative position for window on secondary display", () => {
      // Window at (2660, 100) on display starting at x=2560
      const bounds = { x: 2660, y: 100, width: 800, height: 600 };
      const home = computeHomeDisplay(bounds, display1080);

      assert.strictEqual(home.displayId, 2);
      // Center: (3060, 400), relative to workArea (2560, 25, 1920, 1055)
      // relX = (3060 - 2560) / 1920 = 500/1920 ~ 0.260
      assert.ok(Math.abs(home.relativePosition.centerX - 0.260) < 0.01,
        `centerX ${home.relativePosition.centerX} should be ~0.260`);
    });

    it("handles zero-size workArea gracefully", () => {
      const zeroDisplay: DisplaySnapshot = {
        id: 99,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        workArea: { x: 0, y: 0, width: 0, height: 0 },
      };
      const home = computeHomeDisplay({ x: 0, y: 0, width: 800, height: 600 }, zeroDisplay);
      assert.strictEqual(home.relativePosition.centerX, 0.5);
      assert.strictEqual(home.relativePosition.centerY, 0.5);
    });
  });

  describe("findMatchingNewDisplay", () => {
    it("matches by display ID first", () => {
      const home: WindowHomeDisplay = {
        displayId: 2,
        resolution: { width: 1920, height: 1055 },
        relativePosition: { centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.5 },
      };
      const result = findMatchingNewDisplay(home, [display1440, display1080]);
      assert.strictEqual(result?.id, 2);
    });

    it("falls back to resolution match within 5% tolerance", () => {
      // Home display was 1920x1055, new display is slightly different but within 5%
      const home: WindowHomeDisplay = {
        displayId: 99, // Different ID
        resolution: { width: 1920, height: 1055 },
        relativePosition: { centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.5 },
      };
      // display1080 has workArea 1920x1055 - exact match
      const result = findMatchingNewDisplay(home, [display1440, display1080]);
      assert.strictEqual(result?.id, 2);
    });

    it("matches display with resolution within 5% tolerance", () => {
      const home: WindowHomeDisplay = {
        displayId: 99,
        resolution: { width: 1920, height: 1055 },
        relativePosition: { centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.5 },
      };
      // Create a display with ~4% different resolution
      const similar: DisplaySnapshot = {
        id: 50,
        bounds: { x: 0, y: 0, width: 2000, height: 1100 },
        workArea: { x: 0, y: 25, width: 1996, height: 1095 }, // ~4% wider, ~3.8% taller
      };
      const result = findMatchingNewDisplay(home, [similar]);
      assert.strictEqual(result?.id, 50);
    });

    it("rejects display with resolution beyond 5% tolerance", () => {
      const home: WindowHomeDisplay = {
        displayId: 99,
        resolution: { width: 1920, height: 1055 },
        relativePosition: { centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.5 },
      };
      // display1440 has workArea 2560x1415 - way too different
      const result = findMatchingNewDisplay(home, [display1440]);
      assert.strictEqual(result, null);
    });

    it("returns null when no displays match", () => {
      const home: WindowHomeDisplay = {
        displayId: 99,
        resolution: { width: 3840, height: 2135 },
        relativePosition: { centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.5 },
      };
      const result = findMatchingNewDisplay(home, [display1440, display1080, displayLaptop]);
      assert.strictEqual(result, null);
    });

    it("returns null for empty added displays list", () => {
      const home: WindowHomeDisplay = {
        displayId: 2,
        resolution: { width: 1920, height: 1055 },
        relativePosition: { centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.5 },
      };
      const result = findMatchingNewDisplay(home, []);
      assert.strictEqual(result, null);
    });

    it("prefers ID match over resolution match", () => {
      const home: WindowHomeDisplay = {
        displayId: 2,
        resolution: { width: 1920, height: 1055 },
        relativePosition: { centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.5 },
      };
      // Both display1080 (id=2, exact resolution) and a similar-resolution display
      const similar: DisplaySnapshot = {
        id: 50,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 25, width: 1920, height: 1055 },
      };
      const result = findMatchingNewDisplay(home, [similar, display1080]);
      assert.strictEqual(result?.id, 2); // ID match wins
    });
  });

  describe("computeRestoredBounds", () => {
    it("restores window to same position on same-sized display", () => {
      const bounds = { x: 880, y: 420, width: 800, height: 600 };
      const home = computeHomeDisplay(bounds, display1440);
      const restored = computeRestoredBounds(home, display1440);

      assert.strictEqual(restored.x, bounds.x);
      assert.strictEqual(restored.y, bounds.y);
      assert.strictEqual(restored.width, bounds.width);
      assert.strictEqual(restored.height, bounds.height);
    });

    it("restores to correct relative position on different display location", () => {
      // Window centered on external display at (2560, 25, 1920, 1055)
      const bounds = { x: 3120, y: 252, width: 800, height: 600 };
      const home = computeHomeDisplay(bounds, display1080);

      // Reconnect at same resolution but different position
      const reconnected: DisplaySnapshot = {
        id: 2,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 25, width: 1920, height: 1055 },
      };
      const restored = computeRestoredBounds(home, reconnected);

      // Should be at the same relative position but shifted by workArea offset
      // Original center relative: ((3520-2560)/1920, (552-25)/1055) = (0.5, 0.5)
      // On reconnected: center = (960, 552.5), so x = 960-400=560, y = 553-300=253
      assert.ok(Math.abs(restored.x - 560) <= 1,
        `x=${restored.x} should be ~560`);
      assert.ok(Math.abs(restored.y - 252) <= 1,
        `y=${restored.y} should be ~252`);
      assert.strictEqual(restored.width, 800);
      assert.strictEqual(restored.height, 600);
    });

    it("scales window size proportionally for different resolution", () => {
      // Window on big display
      const bounds = { x: 880, y: 420, width: 800, height: 600 };
      const home = computeHomeDisplay(bounds, display1440);

      // Restore to smaller display
      const restored = computeRestoredBounds(home, displayLaptop);

      // Width ratio was 800/2560 = 0.3125, on laptop: 0.3125 * 1440 = 450
      assert.strictEqual(restored.width, 450);
      // Height ratio was 600/1415 ~ 0.424, on laptop: 0.424 * 875 = 371
      assert.ok(Math.abs(restored.height - 371) <= 1,
        `height=${restored.height} should be ~371`);
    });

    it("clamps restored window within new workArea", () => {
      // Window at far bottom-right corner
      const bounds = { x: 2200, y: 1200, width: 400, height: 300 };
      const home = computeHomeDisplay(bounds, display1440);

      const restored = computeRestoredBounds(home, displayLaptop);
      const wa = displayLaptop.workArea;

      assert.ok(restored.x >= wa.x, `x=${restored.x} should be >= ${wa.x}`);
      assert.ok(restored.y >= wa.y, `y=${restored.y} should be >= ${wa.y}`);
      assert.ok(restored.x + restored.width <= wa.x + wa.width,
        `right edge ${restored.x + restored.width} should be <= ${wa.x + wa.width}`);
      assert.ok(restored.y + restored.height <= wa.y + wa.height,
        `bottom edge ${restored.y + restored.height} should be <= ${wa.y + wa.height}`);
    });

    it("enforces minimum size of 200x150", () => {
      // Very small relative window
      const home: WindowHomeDisplay = {
        displayId: 1,
        resolution: { width: 2560, height: 1415 },
        relativePosition: { centerX: 0.5, centerY: 0.5, width: 0.01, height: 0.01 },
      };
      const restored = computeRestoredBounds(home, displayLaptop);
      assert.ok(restored.width >= 200, `width=${restored.width} should be >= 200`);
      assert.ok(restored.height >= 150, `height=${restored.height} should be >= 150`);
    });

    it("round-trips through save and restore on same display", () => {
      // Test various window positions
      const positions = [
        { x: 0, y: 25, width: 800, height: 600 },       // top-left
        { x: 1760, y: 840, width: 800, height: 600 },    // bottom-right
        { x: 880, y: 420, width: 800, height: 600 },     // centered
        { x: 200, y: 25, width: 1200, height: 1000 },    // large
      ];

      for (const bounds of positions) {
        const home = computeHomeDisplay(bounds, display1440);
        const restored = computeRestoredBounds(home, display1440);

        assert.ok(Math.abs(restored.x - bounds.x) <= 1,
          `x: ${restored.x} should be ~${bounds.x}`);
        assert.ok(Math.abs(restored.y - bounds.y) <= 1,
          `y: ${restored.y} should be ~${bounds.y}`);
        assert.strictEqual(restored.width, bounds.width);
        assert.strictEqual(restored.height, bounds.height);
      }
    });
  });

  describe("home display tracking (integration)", () => {
    it("simulates full unplug/replug cycle: save, displace, restore", () => {
      // Step 1: Window on external display (display1080)
      const originalBounds = { x: 3120, y: 252, width: 800, height: 600 };

      // Step 2: External display removed - save home display info
      const home = computeHomeDisplay(originalBounds, display1080);
      assert.strictEqual(home.displayId, 2);

      // Step 3: External display re-added (same ID)
      const matchingDisplay = findMatchingNewDisplay(home, [display1080]);
      assert.notStrictEqual(matchingDisplay, null);
      assert.strictEqual(matchingDisplay!.id, 2);

      // Step 4: Restore window
      const restored = computeRestoredBounds(home, matchingDisplay!);
      assert.strictEqual(restored.x, originalBounds.x);
      assert.strictEqual(restored.y, originalBounds.y);
      assert.strictEqual(restored.width, originalBounds.width);
      assert.strictEqual(restored.height, originalBounds.height);
    });

    it("restores to different-ID display with matching resolution", () => {
      // Window on external display
      const originalBounds = { x: 3120, y: 252, width: 800, height: 600 };
      const home = computeHomeDisplay(originalBounds, display1080);

      // Display comes back with different ID but same resolution
      const newExternal: DisplaySnapshot = {
        id: 42,
        bounds: { x: 2560, y: 0, width: 1920, height: 1080 },
        workArea: { x: 2560, y: 25, width: 1920, height: 1055 },
      };

      const match = findMatchingNewDisplay(home, [newExternal]);
      assert.notStrictEqual(match, null);
      assert.strictEqual(match!.id, 42);

      const restored = computeRestoredBounds(home, match!);
      // Same relative position, same resolution = same absolute position
      assert.strictEqual(restored.x, originalBounds.x);
      assert.strictEqual(restored.y, originalBounds.y);
    });

    it("does not restore when no matching display is found", () => {
      const originalBounds = { x: 3120, y: 252, width: 800, height: 600 };
      const home = computeHomeDisplay(originalBounds, display1080);

      // Only a very different display is added
      const different: DisplaySnapshot = {
        id: 50,
        bounds: { x: 0, y: 0, width: 3840, height: 2160 },
        workArea: { x: 0, y: 25, width: 3840, height: 2135 },
      };

      const match = findMatchingNewDisplay(home, [different]);
      assert.strictEqual(match, null);
    });

    it("handles multiple windows on different removed displays", () => {
      // Window 1 on display1440, Window 2 on display1080
      const bounds1 = { x: 500, y: 300, width: 800, height: 600 };
      const bounds2 = { x: 3000, y: 200, width: 600, height: 400 };

      const home1 = computeHomeDisplay(bounds1, display1440);
      const home2 = computeHomeDisplay(bounds2, display1080);

      assert.strictEqual(home1.displayId, 1);
      assert.strictEqual(home2.displayId, 2);

      // Both displays come back
      const match1 = findMatchingNewDisplay(home1, [display1440, display1080]);
      const match2 = findMatchingNewDisplay(home2, [display1440, display1080]);

      assert.strictEqual(match1!.id, 1);
      assert.strictEqual(match2!.id, 2);

      const restored1 = computeRestoredBounds(home1, match1!);
      const restored2 = computeRestoredBounds(home2, match2!);

      assert.strictEqual(restored1.x, bounds1.x);
      assert.strictEqual(restored1.y, bounds1.y);
      assert.strictEqual(restored2.x, bounds2.x);
      assert.strictEqual(restored2.y, bounds2.y);
    });
  });

  // ==========================================================================
  // New tests for pre-debounce capture, suppress timer cancellation, isRemoval
  // ==========================================================================

  describe("captureWindowBounds", () => {
    // Pure version of captureWindowBounds that accepts mock windows
    interface MockWindow {
      id: number;
      destroyed: boolean;
      visible: boolean;
      bounds: Rectangle;
    }

    function captureWindowBounds(windows: MockWindow[]): Map<number, Rectangle> {
      const result = new Map<number, Rectangle>();
      for (const win of windows) {
        if (win.destroyed || !win.visible) continue;
        result.set(win.id, win.bounds);
      }
      return result;
    }

    it("captures bounds of all visible, non-destroyed windows", () => {
      const windows: MockWindow[] = [
        { id: 1, destroyed: false, visible: true, bounds: { x: 100, y: 200, width: 800, height: 600 } },
        { id: 2, destroyed: false, visible: true, bounds: { x: 300, y: 400, width: 600, height: 400 } },
      ];
      const result = captureWindowBounds(windows);
      assert.strictEqual(result.size, 2);
      assert.deepStrictEqual(result.get(1), { x: 100, y: 200, width: 800, height: 600 });
      assert.deepStrictEqual(result.get(2), { x: 300, y: 400, width: 600, height: 400 });
    });

    it("skips destroyed windows", () => {
      const windows: MockWindow[] = [
        { id: 1, destroyed: true, visible: true, bounds: { x: 100, y: 200, width: 800, height: 600 } },
        { id: 2, destroyed: false, visible: true, bounds: { x: 300, y: 400, width: 600, height: 400 } },
      ];
      const result = captureWindowBounds(windows);
      assert.strictEqual(result.size, 1);
      assert.strictEqual(result.has(1), false);
      assert.strictEqual(result.has(2), true);
    });

    it("skips non-visible windows", () => {
      const windows: MockWindow[] = [
        { id: 1, destroyed: false, visible: false, bounds: { x: 100, y: 200, width: 800, height: 600 } },
        { id: 2, destroyed: false, visible: true, bounds: { x: 300, y: 400, width: 600, height: 400 } },
      ];
      const result = captureWindowBounds(windows);
      assert.strictEqual(result.size, 1);
      assert.strictEqual(result.has(1), false);
      assert.strictEqual(result.has(2), true);
    });

    it("skips windows that are both destroyed and non-visible", () => {
      const windows: MockWindow[] = [
        { id: 1, destroyed: true, visible: false, bounds: { x: 100, y: 200, width: 800, height: 600 } },
      ];
      const result = captureWindowBounds(windows);
      assert.strictEqual(result.size, 0);
    });

    it("returns empty map when no windows exist", () => {
      const result = captureWindowBounds([]);
      assert.strictEqual(result.size, 0);
    });

    it("returns empty map when all windows are destroyed or hidden", () => {
      const windows: MockWindow[] = [
        { id: 1, destroyed: true, visible: true, bounds: { x: 0, y: 0, width: 800, height: 600 } },
        { id: 2, destroyed: false, visible: false, bounds: { x: 0, y: 0, width: 800, height: 600 } },
        { id: 3, destroyed: true, visible: false, bounds: { x: 0, y: 0, width: 800, height: 600 } },
      ];
      const result = captureWindowBounds(windows);
      assert.strictEqual(result.size, 0);
    });
  });

  describe("suppressDisplayRepositioning timer cancellation", () => {
    // Model the state machine of suppress toggling and timer/bounds management.
    // This mirrors the logic in suppressDisplayRepositioning() from display-watcher.ts.
    interface WatcherState {
      suppressRepositioning: boolean;
      debounceTimer: ReturnType<typeof setTimeout> | null;
      preDebounceWindowBounds: Map<number, Rectangle> | null;
    }

    function suppressDisplayRepositioning(state: WatcherState, suppress: boolean): void {
      state.suppressRepositioning = suppress;
      if (suppress) {
        if (state.debounceTimer) {
          clearTimeout(state.debounceTimer);
          state.debounceTimer = null;
        }
        state.preDebounceWindowBounds = null;
      } else {
        if (state.debounceTimer) {
          clearTimeout(state.debounceTimer);
          state.debounceTimer = null;
        }
        state.preDebounceWindowBounds = null;
      }
    }

    it("cancels pending debounce timer when suppression is enabled", () => {
      const state: WatcherState = {
        suppressRepositioning: false,
        debounceTimer: setTimeout(() => {}, 100000),
        preDebounceWindowBounds: new Map([[1, { x: 0, y: 0, width: 800, height: 600 }]]),
      };
      suppressDisplayRepositioning(state, true);
      assert.strictEqual(state.debounceTimer, null);
      assert.strictEqual(state.preDebounceWindowBounds, null);
      assert.strictEqual(state.suppressRepositioning, true);
    });

    it("cancels pending debounce timer when suppression is disabled", () => {
      const state: WatcherState = {
        suppressRepositioning: true,
        debounceTimer: setTimeout(() => {}, 100000),
        preDebounceWindowBounds: new Map([[2, { x: 100, y: 100, width: 400, height: 300 }]]),
      };
      suppressDisplayRepositioning(state, false);
      assert.strictEqual(state.debounceTimer, null);
      assert.strictEqual(state.preDebounceWindowBounds, null);
      assert.strictEqual(state.suppressRepositioning, false);
    });

    it("clears pre-debounce bounds when enabling suppression even without timer", () => {
      const state: WatcherState = {
        suppressRepositioning: false,
        debounceTimer: null,
        preDebounceWindowBounds: new Map([[1, { x: 0, y: 0, width: 800, height: 600 }]]),
      };
      suppressDisplayRepositioning(state, true);
      assert.strictEqual(state.preDebounceWindowBounds, null);
      assert.strictEqual(state.debounceTimer, null);
    });

    it("clears pre-debounce bounds when disabling suppression even without timer", () => {
      const state: WatcherState = {
        suppressRepositioning: true,
        debounceTimer: null,
        preDebounceWindowBounds: new Map([[3, { x: 200, y: 200, width: 600, height: 400 }]]),
      };
      suppressDisplayRepositioning(state, false);
      assert.strictEqual(state.preDebounceWindowBounds, null);
      assert.strictEqual(state.debounceTimer, null);
    });

    it("is safe to call with no timer and no bounds", () => {
      const state: WatcherState = {
        suppressRepositioning: false,
        debounceTimer: null,
        preDebounceWindowBounds: null,
      };
      suppressDisplayRepositioning(state, true);
      assert.strictEqual(state.suppressRepositioning, true);
      assert.strictEqual(state.debounceTimer, null);
      assert.strictEqual(state.preDebounceWindowBounds, null);
    });

    it("prevents stale debounced handler from firing after suppress toggle", () => {
      // Simulate: display event fires, starts debounce timer, then suppress(true)
      // is called before timer fires. The timer should be cancelled.
      let handlerFired = false;
      const state: WatcherState = {
        suppressRepositioning: false,
        debounceTimer: setTimeout(() => { handlerFired = true; }, 50),
        preDebounceWindowBounds: new Map([[1, { x: 0, y: 0, width: 800, height: 600 }]]),
      };

      suppressDisplayRepositioning(state, true);

      // Verify timer was cleared (handler should not fire)
      assert.strictEqual(state.debounceTimer, null);
      // Wait longer than the timer would have fired to confirm it was cancelled
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          assert.strictEqual(handlerFired, false, "debounced handler should NOT have fired after suppression");
          resolve();
        }, 100);
      });
    });
  });

  describe("onDisplayChange isRemoval flag and pre-debounce capture", () => {
    // Model the onDisplayChange logic as a pure state machine.
    // This mirrors the debounce + pre-debounce capture logic from display-watcher.ts.
    interface MockWindow {
      id: number;
      destroyed: boolean;
      visible: boolean;
      bounds: Rectangle;
    }

    interface DebounceState {
      debounceTimer: ReturnType<typeof setTimeout> | null;
      preDebounceWindowBounds: Map<number, Rectangle> | null;
      handleDisplayChangeCalled: boolean;
    }

    function captureWindowBounds(windows: MockWindow[]): Map<number, Rectangle> {
      const result = new Map<number, Rectangle>();
      for (const win of windows) {
        if (win.destroyed || !win.visible) continue;
        result.set(win.id, win.bounds);
      }
      return result;
    }

    function onDisplayChange(
      state: DebounceState,
      windows: MockWindow[],
      isRemoval: boolean,
      debounceMs: number
    ): void {
      // On the FIRST event in a debounce window, capture bounds eagerly if removal
      if (!state.debounceTimer && isRemoval) {
        state.preDebounceWindowBounds = captureWindowBounds(windows);
      }

      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
      }
      state.debounceTimer = setTimeout(() => {
        state.debounceTimer = null;
        state.handleDisplayChangeCalled = true;
        state.preDebounceWindowBounds = null;
      }, debounceMs);
    }

    it("captures window bounds on first display-removed event (no existing timer)", () => {
      const windows: MockWindow[] = [
        { id: 1, destroyed: false, visible: true, bounds: { x: 100, y: 200, width: 800, height: 600 } },
        { id: 2, destroyed: false, visible: true, bounds: { x: 2700, y: 100, width: 600, height: 400 } },
      ];
      const state: DebounceState = {
        debounceTimer: null,
        preDebounceWindowBounds: null,
        handleDisplayChangeCalled: false,
      };

      onDisplayChange(state, windows, true, 500);

      assert.notStrictEqual(state.preDebounceWindowBounds, null);
      assert.strictEqual(state.preDebounceWindowBounds!.size, 2);
      assert.deepStrictEqual(state.preDebounceWindowBounds!.get(1), { x: 100, y: 200, width: 800, height: 600 });
      assert.deepStrictEqual(state.preDebounceWindowBounds!.get(2), { x: 2700, y: 100, width: 600, height: 400 });

      // Cleanup
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
    });

    it("does NOT re-capture bounds on subsequent events during debounce window", () => {
      const originalWindows: MockWindow[] = [
        { id: 1, destroyed: false, visible: true, bounds: { x: 100, y: 200, width: 800, height: 600 } },
      ];
      const state: DebounceState = {
        debounceTimer: null,
        preDebounceWindowBounds: null,
        handleDisplayChangeCalled: false,
      };

      // First event captures bounds
      onDisplayChange(state, originalWindows, true, 500);
      const capturedBounds = state.preDebounceWindowBounds;
      assert.notStrictEqual(capturedBounds, null);

      // macOS relocates window (simulated by different bounds)
      const relocatedWindows: MockWindow[] = [
        { id: 1, destroyed: false, visible: true, bounds: { x: 500, y: 300, width: 800, height: 600 } },
      ];

      // Second event during debounce - should NOT overwrite pre-debounce bounds
      onDisplayChange(state, relocatedWindows, true, 500);
      assert.strictEqual(state.preDebounceWindowBounds, capturedBounds,
        "pre-debounce bounds should NOT be overwritten by subsequent events");
      assert.deepStrictEqual(state.preDebounceWindowBounds!.get(1), { x: 100, y: 200, width: 800, height: 600 },
        "bounds should still reflect the ORIGINAL positions");

      // Cleanup
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
    });

    it("does NOT capture bounds for non-removal events (isRemoval=false)", () => {
      const windows: MockWindow[] = [
        { id: 1, destroyed: false, visible: true, bounds: { x: 100, y: 200, width: 800, height: 600 } },
      ];
      const state: DebounceState = {
        debounceTimer: null,
        preDebounceWindowBounds: null,
        handleDisplayChangeCalled: false,
      };

      onDisplayChange(state, windows, false, 500);

      assert.strictEqual(state.preDebounceWindowBounds, null,
        "should NOT capture bounds for non-removal events");

      // Cleanup
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
    });

    it("clears pre-debounce bounds after debounced handler fires", async () => {
      const windows: MockWindow[] = [
        { id: 1, destroyed: false, visible: true, bounds: { x: 100, y: 200, width: 800, height: 600 } },
      ];
      const state: DebounceState = {
        debounceTimer: null,
        preDebounceWindowBounds: null,
        handleDisplayChangeCalled: false,
      };

      onDisplayChange(state, windows, true, 30);
      assert.notStrictEqual(state.preDebounceWindowBounds, null);

      await new Promise<void>((resolve) => {
        setTimeout(() => {
          assert.strictEqual(state.preDebounceWindowBounds, null,
            "pre-debounce bounds should be cleared after handler fires");
          assert.strictEqual(state.handleDisplayChangeCalled, true,
            "handleDisplayChange should have been called");
          assert.strictEqual(state.debounceTimer, null,
            "debounce timer should be null after handler fires");
          resolve();
        }, 80);
      });
    });

    it("resets debounce timer on each subsequent event", () => {
      const windows: MockWindow[] = [
        { id: 1, destroyed: false, visible: true, bounds: { x: 0, y: 0, width: 800, height: 600 } },
      ];
      const state: DebounceState = {
        debounceTimer: null,
        preDebounceWindowBounds: null,
        handleDisplayChangeCalled: false,
      };

      onDisplayChange(state, windows, true, 500);
      const firstTimer = state.debounceTimer;
      assert.notStrictEqual(firstTimer, null);

      // Second event should create a new timer
      onDisplayChange(state, windows, false, 500);
      assert.notStrictEqual(state.debounceTimer, null);
      // Timer reference changes because old was cleared and new was created
      // (Node may reuse timer refs but the clearTimeout+setTimeout cycle happens)
      assert.notStrictEqual(state.debounceTimer, firstTimer,
        "debounce timer should be reset on subsequent event");

      // Cleanup
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
    });
  });

  describe("Phase 1 pre-debounce bounds fallback", () => {
    // Tests the pattern: _preDebounceWindowBounds?.get(win.id) ?? win.getBounds()
    // This is used in handleDisplayChange Phase 1 to correctly identify which display
    // a window was on BEFORE macOS auto-relocated it.

    interface MockWindow {
      id: number;
      currentBounds: Rectangle; // what getBounds() returns NOW (post-relocation)
    }

    function getEffectiveBounds(
      preDebounceWindowBounds: Map<number, Rectangle> | null,
      win: MockWindow
    ): Rectangle {
      return preDebounceWindowBounds?.get(win.id) ?? win.currentBounds;
    }

    it("uses pre-debounce bounds when available", () => {
      const preDebounce = new Map<number, Rectangle>([
        [1, { x: 2700, y: 100, width: 800, height: 600 }],  // was on external display
      ]);
      const win: MockWindow = {
        id: 1,
        currentBounds: { x: 100, y: 100, width: 800, height: 600 },  // macOS moved it to laptop
      };

      const bounds = getEffectiveBounds(preDebounce, win);
      assert.deepStrictEqual(bounds, { x: 2700, y: 100, width: 800, height: 600 },
        "should use pre-debounce bounds (original position on external display)");
    });

    it("falls back to current bounds when pre-debounce map is null", () => {
      const win: MockWindow = {
        id: 1,
        currentBounds: { x: 100, y: 100, width: 800, height: 600 },
      };

      const bounds = getEffectiveBounds(null, win);
      assert.deepStrictEqual(bounds, { x: 100, y: 100, width: 800, height: 600 },
        "should fall back to current bounds when no pre-debounce map");
    });

    it("falls back to current bounds when window not in pre-debounce map", () => {
      const preDebounce = new Map<number, Rectangle>([
        [2, { x: 2700, y: 100, width: 800, height: 600 }],  // different window
      ]);
      const win: MockWindow = {
        id: 1,
        currentBounds: { x: 100, y: 100, width: 800, height: 600 },
      };

      const bounds = getEffectiveBounds(preDebounce, win);
      assert.deepStrictEqual(bounds, { x: 100, y: 100, width: 800, height: 600 },
        "should fall back to current bounds when window not in pre-debounce map");
    });

    it("correctly identifies window's home display using pre-debounce bounds", () => {
      // Scenario: external display (display1080) removed. macOS moved window to laptop.
      // Pre-debounce bounds show the window was at (2700, 100) - on display1080.
      // Current bounds show (100, 100) - on the laptop display.
      const preDebounce = new Map<number, Rectangle>([
        [1, { x: 2700, y: 100, width: 800, height: 600 }],
      ]);
      const win: MockWindow = {
        id: 1,
        currentBounds: { x: 100, y: 100, width: 800, height: 600 },
      };

      const bounds = getEffectiveBounds(preDebounce, win);
      const centerX = bounds.x + Math.round(bounds.width / 2);
      const centerY = bounds.y + Math.round(bounds.height / 2);

      // With pre-debounce bounds, center is at (3100, 400) -> on display1080
      const oldDisplays = [display1440, display1080];
      const found = findDisplayForPoint(oldDisplays, centerX, centerY);
      assert.strictEqual(found?.id, 2,
        "should find the window was on display1080 using pre-debounce bounds");
    });

    it("without pre-debounce bounds, mis-identifies display after macOS relocation", () => {
      // Same scenario but WITHOUT pre-debounce bounds - demonstrates the problem
      const win: MockWindow = {
        id: 1,
        currentBounds: { x: 100, y: 100, width: 800, height: 600 },
      };

      const bounds = getEffectiveBounds(null, win);
      const centerX = bounds.x + Math.round(bounds.width / 2);
      const centerY = bounds.y + Math.round(bounds.height / 2);

      // Without pre-debounce, center is at (500, 400) -> on display1440 (laptop),
      // even though the window WAS on display1080 before macOS moved it
      const oldDisplays = [display1440, display1080];
      const found = findDisplayForPoint(oldDisplays, centerX, centerY);
      assert.strictEqual(found?.id, 1,
        "without pre-debounce, window appears to be on display1440 (wrong - macOS already moved it)");
    });

    it("handles multiple windows with mixed pre-debounce availability", () => {
      // Window 1: was on external, captured in pre-debounce
      // Window 2: was on laptop, NOT in pre-debounce (was visible but different ID)
      // Window 3: new window created after capture, NOT in pre-debounce
      const preDebounce = new Map<number, Rectangle>([
        [1, { x: 2700, y: 100, width: 800, height: 600 }],
        [2, { x: 200, y: 200, width: 600, height: 400 }],
      ]);

      const win1: MockWindow = { id: 1, currentBounds: { x: 50, y: 50, width: 800, height: 600 } };
      const win2: MockWindow = { id: 2, currentBounds: { x: 200, y: 200, width: 600, height: 400 } };
      const win3: MockWindow = { id: 3, currentBounds: { x: 300, y: 300, width: 500, height: 350 } };

      assert.deepStrictEqual(getEffectiveBounds(preDebounce, win1),
        { x: 2700, y: 100, width: 800, height: 600 },
        "win1 should use pre-debounce bounds");
      assert.deepStrictEqual(getEffectiveBounds(preDebounce, win2),
        { x: 200, y: 200, width: 600, height: 400 },
        "win2 should use pre-debounce bounds");
      assert.deepStrictEqual(getEffectiveBounds(preDebounce, win3),
        { x: 300, y: 300, width: 500, height: 350 },
        "win3 should fall back to current bounds (not in pre-debounce)");
    });

    it("end-to-end: pre-debounce bounds enable correct home display save on removal", () => {
      // Full scenario: external display removed, pre-debounce captured, Phase 1 saves home
      const preDebounce = new Map<number, Rectangle>([
        [1, { x: 2700, y: 100, width: 800, height: 600 }],  // was on display1080
        [2, { x: 500, y: 300, width: 600, height: 400 }],    // was on display1440
      ]);

      // After macOS relocates windows, both are on display1440
      const windows = [
        { id: 1, currentBounds: { x: 100, y: 100, width: 800, height: 600 } },
        { id: 2, currentBounds: { x: 500, y: 300, width: 600, height: 400 } },
      ];

      const removedDisplayIds = new Set([display1080.id]);
      const oldDisplays = [display1440, display1080];
      const savedHomes = new Map<number, WindowHomeDisplay>();

      for (const win of windows) {
        const bounds = getEffectiveBounds(preDebounce, win);
        const centerX = bounds.x + Math.round(bounds.width / 2);
        const centerY = bounds.y + Math.round(bounds.height / 2);

        const oldDisplay = findDisplayForPoint(oldDisplays, centerX, centerY);
        if (oldDisplay && removedDisplayIds.has(oldDisplay.id)) {
          savedHomes.set(win.id, computeHomeDisplay(bounds, oldDisplay));
        }
      }

      // Only window 1 should be saved as displaced (it was on the removed display)
      assert.strictEqual(savedHomes.size, 1, "only window on removed display should be saved");
      assert.strictEqual(savedHomes.has(1), true);
      assert.strictEqual(savedHomes.has(2), false);
      assert.strictEqual(savedHomes.get(1)!.displayId, display1080.id);
    });
  });
});
