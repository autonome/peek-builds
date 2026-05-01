/**
 * Unit tests for display-watcher logic
 *
 * These test the pure math functions extracted from display-watcher.ts:
 * - findDisplayForPoint: determine which display contains a point
 * - isWindowAccessible: check if a window has >=50% area overlap with any display
 *   (matches `STRANDED_THRESHOLD` in window-placement.ts; production now
 *   delegates to the shared isStranded helper)
 * - findBestNewDisplay: find the nearest display by center-point proximity
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

// Mirrors the new shared logic: a window is accessible iff its overlap
// with the best display's workArea is >= STRANDED_THRESHOLD (0.5).
const STRANDED_THRESHOLD = 0.5;

function isWindowAccessible(displays: DisplaySnapshot[], bounds: Rectangle): boolean {
  const windowArea = bounds.width * bounds.height;

  // Zero-size windows are always accessible
  if (windowArea <= 0) return true;

  for (const d of displays) {
    const wa = d.workArea;

    const overlapX = Math.max(bounds.x, wa.x);
    const overlapY = Math.max(bounds.y, wa.y);
    const overlapRight = Math.min(bounds.x + bounds.width, wa.x + wa.width);
    const overlapBottom = Math.min(bounds.y + bounds.height, wa.y + wa.height);

    if (overlapRight > overlapX && overlapBottom > overlapY) {
      const overlapArea = (overlapRight - overlapX) * (overlapBottom - overlapY);
      if (overlapArea / windowArea >= STRANDED_THRESHOLD) {
        return true;
      }
    }
  }

  return false;
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

  describe("isWindowAccessible (area overlap)", () => {
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

    it("zero-size window is always accessible", () => {
      assert.strictEqual(isWindowAccessible(displays, { x: -5000, y: -5000, width: 0, height: 0 }), true);
    });

    it("window with zero width is accessible", () => {
      assert.strictEqual(isWindowAccessible(displays, { x: 100, y: 100, width: 0, height: 600 }), true);
    });

    it("window with exactly 50% overlap is accessible (boundary inclusive)", () => {
      // Window 1000x1000 = 1,000,000 area, threshold 500,000 (50%)
      // Window at x=-500, width=1000 -> overlaps from x=0 to x=500 (500px wide)
      // y=100, height=1000 -> overlaps 1000px tall (within workArea 25-1440)
      // Overlap = 500 * 1000 = 500,000 = exactly 50%; passes >= threshold.
      assert.strictEqual(isWindowAccessible(displays, { x: -500, y: 100, width: 1000, height: 1000 }), true);
    });

    it("window with less than 50% overlap is not accessible", () => {
      // x=-501, width=1000 -> overlaps from x=0 to x=499 (499px wide)
      // Overlap = 499 * 1000 = 499,000 < 50% threshold
      assert.strictEqual(isWindowAccessible(displays, { x: -501, y: 100, width: 1000, height: 1000 }), false);
    });

    it("window spanning two displays counts overlap per display", () => {
      // 320x600 window straddling the 2560 boundary: 160px on display1440,
      // 160px on display1080. Each display gets 96,000 / 192,000 = 50%
      // overlap; the per-display max is 50%, accessible.
      assert.strictEqual(isWindowAccessible(displays, { x: 2400, y: 100, width: 320, height: 600 }), true);
    });

    it("large window half off-screen with exactly 50% overlap is accessible", () => {
      // 800x600 at (-400, 100): overlaps display1440 from 0..400 (400px) by
      // 600px tall = 240,000 / 480,000 = exactly 50% — boundary inclusive.
      assert.strictEqual(isWindowAccessible(displays, { x: -400, y: 100, width: 800, height: 600 }), true);
    });

    it("window with only 30% overlap is no longer accessible (was true before threshold change)", () => {
      // x=-700, 1000x1000 window: only 300/1000px overlap = 30%, below the
      // 50% threshold. Previously isWindowAccessible used 0.3, which let
      // these windows skip Pass 1 yet trip Pass 2's stranded rescue. Now
      // both passes agree.
      assert.strictEqual(isWindowAccessible(displays, { x: -700, y: 100, width: 1000, height: 1000 }), false);
    });

    it("window far off-screen with no overlap is not accessible", () => {
      assert.strictEqual(isWindowAccessible(displays, { x: 10000, y: 10000, width: 800, height: 600 }), false);
    });
  });

  describe("findBestNewDisplay", () => {
    it("returns closest display by center distance when old display is known", () => {
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

    it("picks nearest by center distance — no ID preference", () => {
      // Even though display1440 has the same ID relationship, proximity wins
      const farRight: DisplaySnapshot = {
        id: 99,
        bounds: { x: 5000, y: 0, width: 1920, height: 1080 },
        workArea: { x: 5000, y: 25, width: 1920, height: 1055 },
      };
      const result = findBestNewDisplay(farRight, [display1440, display1080], 1);
      // display1080 center (~3520, 552) is closer to farRight center (~5960, 552)
      // than display1440 center (~1280, 732)
      assert.strictEqual(result.id, 2);
    });

    it("picks display directly adjacent over distant one", () => {
      // Old display was at x=2560 (like display1080), two candidates: adjacent and far
      const adjacent: DisplaySnapshot = {
        id: 10,
        bounds: { x: 2560, y: 0, width: 1920, height: 1080 },
        workArea: { x: 2560, y: 25, width: 1920, height: 1055 },
      };
      const far: DisplaySnapshot = {
        id: 20,
        bounds: { x: 8000, y: 0, width: 1920, height: 1080 },
        workArea: { x: 8000, y: 25, width: 1920, height: 1055 },
      };
      const result = findBestNewDisplay(display1080, [far, adjacent], 10);
      assert.strictEqual(result.id, 10);
    });

    it("throws when no displays available", () => {
      assert.throws(() => findBestNewDisplay(display1440, [], 1), /No displays available/);
    });
  });

  describe("safety net: no-op when all windows accessible", () => {
    // Simulates the handleDisplayChange logic as a pure function
    interface MockWindowEntry {
      id: number;
      bounds: Rectangle;
      isBackground: boolean;
    }

    function simulateHandleDisplayChange(
      windows: MockWindowEntry[],
      oldDisplays: DisplaySnapshot[],
      newDisplays: DisplaySnapshot[],
      primaryDisplayId: number
    ): { rescued: number; windowBounds: Map<number, Rectangle> } {
      let rescued = 0;
      const windowBounds = new Map<number, Rectangle>();

      for (const win of windows) {
        if (win.isBackground) continue;

        if (isWindowAccessible(newDisplays, win.bounds)) {
          windowBounds.set(win.id, win.bounds);
          continue;
        }

        // Rescue: find old display, then nearest new display, center window
        const centerX = win.bounds.x + Math.round(win.bounds.width / 2);
        const centerY = win.bounds.y + Math.round(win.bounds.height / 2);
        const oldDisplay = findDisplayForPoint(oldDisplays, centerX, centerY);
        const newDisplay = findBestNewDisplay(oldDisplay, newDisplays, primaryDisplayId);
        const wa = newDisplay.workArea;

        // Preserve original size, only reposition
        const x = wa.x + Math.round((wa.width - win.bounds.width) / 2);
        const y = wa.y + Math.round((wa.height - win.bounds.height) / 2);

        windowBounds.set(win.id, { x, y, width: win.bounds.width, height: win.bounds.height });
        rescued++;
      }

      return { rescued, windowBounds };
    }

    it("does nothing when all windows are on valid displays", () => {
      const windows: MockWindowEntry[] = [
        { id: 1, bounds: { x: 100, y: 100, width: 800, height: 600 }, isBackground: false },
        { id: 2, bounds: { x: 3000, y: 100, width: 800, height: 600 }, isBackground: false },
      ];
      const result = simulateHandleDisplayChange(
        windows,
        [display1440, display1080],
        [display1440, display1080],
        1
      );
      assert.strictEqual(result.rescued, 0);
      // Windows should keep their original bounds
      assert.deepStrictEqual(result.windowBounds.get(1), { x: 100, y: 100, width: 800, height: 600 });
      assert.deepStrictEqual(result.windowBounds.get(2), { x: 3000, y: 100, width: 800, height: 600 });
    });

    it("skips background windows", () => {
      const windows: MockWindowEntry[] = [
        { id: 1, bounds: { x: -5000, y: -5000, width: 800, height: 600 }, isBackground: true },
      ];
      const result = simulateHandleDisplayChange(
        windows,
        [display1440],
        [display1440],
        1
      );
      assert.strictEqual(result.rescued, 0);
      assert.strictEqual(result.windowBounds.size, 0);
    });
  });

  describe("safety net: rescue orphaned windows", () => {
    interface MockWindowEntry {
      id: number;
      bounds: Rectangle;
      isBackground: boolean;
    }

    function simulateHandleDisplayChange(
      windows: MockWindowEntry[],
      oldDisplays: DisplaySnapshot[],
      newDisplays: DisplaySnapshot[],
      primaryDisplayId: number
    ): { rescued: number; windowBounds: Map<number, Rectangle> } {
      let rescued = 0;
      const windowBounds = new Map<number, Rectangle>();

      for (const win of windows) {
        if (win.isBackground) continue;

        if (isWindowAccessible(newDisplays, win.bounds)) {
          windowBounds.set(win.id, win.bounds);
          continue;
        }

        const centerX = win.bounds.x + Math.round(win.bounds.width / 2);
        const centerY = win.bounds.y + Math.round(win.bounds.height / 2);
        const oldDisplay = findDisplayForPoint(oldDisplays, centerX, centerY);
        const newDisplay = findBestNewDisplay(oldDisplay, newDisplays, primaryDisplayId);
        const wa = newDisplay.workArea;

        // Preserve original size, only reposition
        const x = wa.x + Math.round((wa.width - win.bounds.width) / 2);
        const y = wa.y + Math.round((wa.height - win.bounds.height) / 2);

        windowBounds.set(win.id, { x, y, width: win.bounds.width, height: win.bounds.height });
        rescued++;
      }

      return { rescued, windowBounds };
    }

    it("rescues window that was on removed display", () => {
      // Window was on display1080 (secondary), which is now gone
      // macOS may have moved it to some off-screen position
      const windows: MockWindowEntry[] = [
        { id: 1, bounds: { x: 5000, y: 5000, width: 800, height: 600 }, isBackground: false },
      ];
      const result = simulateHandleDisplayChange(
        windows,
        [display1440, display1080],
        [display1440],  // display1080 removed
        1
      );
      assert.strictEqual(result.rescued, 1);
      const newBounds = result.windowBounds.get(1)!;
      // Should be centered on display1440's workArea
      const wa = display1440.workArea;
      assert.ok(newBounds.x >= wa.x && newBounds.x + newBounds.width <= wa.x + wa.width,
        "window should be within display1440 workArea horizontally");
      assert.ok(newBounds.y >= wa.y && newBounds.y + newBounds.height <= wa.y + wa.height,
        "window should be within display1440 workArea vertically");
    });

    it("preserves window size when rescuing (if it fits)", () => {
      const windows: MockWindowEntry[] = [
        { id: 1, bounds: { x: -5000, y: -5000, width: 800, height: 600 }, isBackground: false },
      ];
      const result = simulateHandleDisplayChange(
        windows,
        [display1440],
        [display1440],
        1
      );
      assert.strictEqual(result.rescued, 1);
      const newBounds = result.windowBounds.get(1)!;
      assert.strictEqual(newBounds.width, 800);
      assert.strictEqual(newBounds.height, 600);
    });

    it("preserves window size when rescuing oversized window to smaller display", () => {
      const windows: MockWindowEntry[] = [
        { id: 1, bounds: { x: -5000, y: -5000, width: 5000, height: 3000 }, isBackground: false },
      ];
      const result = simulateHandleDisplayChange(
        windows,
        [display1440],
        [displayLaptop],  // smaller display
        3
      );
      assert.strictEqual(result.rescued, 1);
      const newBounds = result.windowBounds.get(1)!;
      // Size preserved — never resize, only reposition
      assert.strictEqual(newBounds.width, 5000);
      assert.strictEqual(newBounds.height, 3000);
    });

    it("centers rescued window on the target display", () => {
      const windows: MockWindowEntry[] = [
        { id: 1, bounds: { x: -5000, y: -5000, width: 800, height: 600 }, isBackground: false },
      ];
      const result = simulateHandleDisplayChange(
        windows,
        [display1440],
        [display1440],
        1
      );
      const newBounds = result.windowBounds.get(1)!;
      const wa = display1440.workArea;
      const expectedX = wa.x + Math.round((wa.width - 800) / 2);
      const expectedY = wa.y + Math.round((wa.height - 600) / 2);
      assert.strictEqual(newBounds.x, expectedX);
      assert.strictEqual(newBounds.y, expectedY);
    });

    it("rescues to nearest display based on old display proximity", () => {
      // Window was on a display far to the right (old position known)
      const farRightOld: DisplaySnapshot = {
        id: 99,
        bounds: { x: 5000, y: 0, width: 1920, height: 1080 },
        workArea: { x: 5000, y: 25, width: 1920, height: 1055 },
      };
      const windows: MockWindowEntry[] = [
        { id: 1, bounds: { x: 5500, y: 200, width: 800, height: 600 }, isBackground: false },
      ];
      // Old layout had farRightOld, new layout has display1440 and display1080
      const result = simulateHandleDisplayChange(
        windows,
        [display1440, display1080, farRightOld],
        [display1440, display1080],  // farRightOld removed
        1
      );
      assert.strictEqual(result.rescued, 1);
      // Should end up on display1080 (closer to where farRightOld was)
      const newBounds = result.windowBounds.get(1)!;
      const wa1080 = display1080.workArea;
      assert.ok(newBounds.x >= wa1080.x && newBounds.x + newBounds.width <= wa1080.x + wa1080.width,
        `window at x=${newBounds.x} should be on display1080 (workArea starts at ${wa1080.x})`);
    });

    it("handles multiple orphaned windows", () => {
      const windows: MockWindowEntry[] = [
        { id: 1, bounds: { x: -5000, y: -5000, width: 800, height: 600 }, isBackground: false },
        { id: 2, bounds: { x: 10000, y: 10000, width: 600, height: 400 }, isBackground: false },
        { id: 3, bounds: { x: 500, y: 200, width: 800, height: 600 }, isBackground: false }, // accessible
      ];
      const result = simulateHandleDisplayChange(
        windows,
        [display1440],
        [display1440],
        1
      );
      assert.strictEqual(result.rescued, 2);
      // Window 3 should keep its original bounds
      assert.deepStrictEqual(result.windowBounds.get(3), { x: 500, y: 200, width: 800, height: 600 });
    });
  });

  describe("findBestNewDisplay proximity (no ID preference)", () => {
    it("does not prefer matching display ID over closer display", () => {
      // Old display had id=1 and was on the right side
      const oldRight: DisplaySnapshot = {
        id: 1,
        bounds: { x: 3000, y: 0, width: 1920, height: 1080 },
        workArea: { x: 3000, y: 25, width: 1920, height: 1055 },
      };
      // New layout: display with id=1 is now on the LEFT, display id=2 is on the RIGHT
      const newLeft: DisplaySnapshot = {
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 25, width: 1920, height: 1055 },
      };
      const newRight: DisplaySnapshot = {
        id: 2,
        bounds: { x: 2000, y: 0, width: 1920, height: 1080 },
        workArea: { x: 2000, y: 25, width: 1920, height: 1055 },
      };
      // findBestNewDisplay uses proximity only — should pick newRight (closer to oldRight center)
      const result = findBestNewDisplay(oldRight, [newLeft, newRight], 1);
      assert.strictEqual(result.id, 2, "should pick closer display, not matching ID");
    });

    it("picks single available display regardless of old display position", () => {
      const farAway: DisplaySnapshot = {
        id: 99,
        bounds: { x: 10000, y: 10000, width: 1920, height: 1080 },
        workArea: { x: 10000, y: 10025, width: 1920, height: 1055 },
      };
      const result = findBestNewDisplay(farAway, [display1440], 1);
      assert.strictEqual(result.id, 1);
    });
  });
});
