/**
 * Unit tests for backend/electron/window-placement.ts — the pure
 * `computePlacement` function. All display data is fabricated via the
 * `fakeDisplays(...)` helper; no real Electron `screen` API is touched.
 *
 * Runs under ELECTRON_RUN_AS_NODE=1 via `yarn test:unit`.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  computePlacement,
  type Placement,
  type PlacementInput,
  type PlacementResult,
} from './window-placement.js';

// ---------------------------------------------------------------------------
// fakeDisplays — the lever the whole sprint depends on
// ---------------------------------------------------------------------------

interface DisplaySpec {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Optional: smaller workArea (excluding menu bar / dock). Defaults to bounds. */
  workArea?: { x: number; y: number; width: number; height: number };
  /** Optional: marks this as "primary" — for our purposes, primary just means
   *  the display whose top-left is at (0, 0). The helper enforces that for
   *  the spec marked `primary: true` (handy ergonomics, no semantic effect
   *  beyond bounds.x/y values). */
  primary?: boolean;
}

/**
 * Build an array shaped like `Electron.Display[]` from compact specs.
 * Only fields used by `window-placement.ts` are populated; the rest are
 * filled with sensible defaults so TypeScript stops complaining when we
 * cast to `Electron.Display`.
 */
function fakeDisplays(specs: DisplaySpec[]): Electron.Display[] {
  return specs.map(s => {
    if (s.primary && (s.x !== 0 || s.y !== 0)) {
      throw new Error(`fakeDisplays: spec marked primary but bounds origin is (${s.x},${s.y})`);
    }
    const bounds = { x: s.x, y: s.y, width: s.width, height: s.height };
    const workArea = s.workArea ?? { ...bounds };
    // Fields below aren't referenced by computePlacement, but Electron.Display
    // is a structural type — we cast `as unknown as Electron.Display` to skip
    // the noise.
    return {
      id: s.id,
      bounds,
      workArea,
      // Filler fields for type compatibility — never read.
      workAreaSize: { width: workArea.width, height: workArea.height },
      size: { width: bounds.width, height: bounds.height },
      scaleFactor: 1,
      rotation: 0,
      internal: false,
      monochrome: false,
      accelerometerSupport: 'unknown',
      colorDepth: 24,
      colorSpace: 'srgb',
      depthPerComponent: 8,
      displayFrequency: 60,
      touchSupport: 'unknown',
      label: `display-${s.id}`,
    } as unknown as Electron.Display;
  });
}

// ---------------------------------------------------------------------------
// Convenience builders
// ---------------------------------------------------------------------------

function pt(x: number, y: number): Electron.Point {
  return { x, y };
}

function rect(x: number, y: number, width: number, height: number): Electron.Rectangle {
  return { x, y, width, height };
}

/** Compute a display's workArea center. */
function centerOf(d: Electron.Display): Electron.Point {
  const wa = d.workArea;
  return { x: wa.x + Math.floor(wa.width / 2), y: wa.y + Math.floor(wa.height / 2) };
}

/**
 * Construct a `PlacementInput` with sensible defaults you can override.
 * Keeps test code readable.
 */
function input(partial: Partial<PlacementInput> & Pick<PlacementInput, 'placement'>): PlacementInput {
  return {
    currentBounds: rect(0, 0, 800, 600),
    windowSize: { width: 800, height: 600 },
    displays: fakeDisplays([{ id: 1, x: 0, y: 0, width: 1920, height: 1080, primary: true }]),
    cursorPoint: pt(960, 540),
    ...partial,
  };
}

/** Pull bounds out of a result, asserting kind === reposition. */
function expectReposition(result: PlacementResult): Electron.Rectangle {
  assert.strictEqual(result.kind, 'reposition', `expected reposition, got ${result.kind}`);
  return (result as Extract<PlacementResult, { kind: 'reposition' }>).bounds;
}

function expectNoChange(result: PlacementResult): void {
  assert.strictEqual(result.kind, 'no-change', `expected no-change, got ${result.kind}`);
}

// ---------------------------------------------------------------------------
// Common display fixtures
// ---------------------------------------------------------------------------

const displayA = { id: 1, x: 0, y: 0, width: 1920, height: 1080, primary: true } as DisplaySpec;
const displayB = { id: 2, x: 1920, y: 0, width: 1920, height: 1080 } as DisplaySpec;
const laptopOnly = { id: 1, x: 0, y: 0, width: 1440, height: 900, primary: true } as DisplaySpec;
const externalUnplugged = { id: 99, x: 1920, y: 0, width: 1920, height: 1080 } as DisplaySpec;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computePlacement: centered mode', () => {
  it('1. centered on cursor display A, displays unchanged, cursor on A → no-change', () => {
    const displays = fakeDisplays([displayA, displayB]);
    // Window already centered on A: A.workArea is 0,0 1920x1080, window 800x600
    // centered → x=560, y=240
    const result = computePlacement(input({
      placement: { mode: 'centered' },
      currentBounds: rect(560, 240, 800, 600),
      displays,
      cursorPoint: pt(960, 540), // on A
    }));
    expectNoChange(result);
  });

  it('2. centered on A, cursor moves to B → reposition to B center', () => {
    const displays = fakeDisplays([displayA, displayB]);
    const result = computePlacement(input({
      placement: { mode: 'centered' },
      currentBounds: rect(560, 240, 800, 600), // currently centered on A
      displays,
      cursorPoint: pt(2880, 540), // on B
    }));
    const bounds = expectReposition(result);
    // B.workArea is 1920,0 1920x1080; centered window: x=1920+560=2480, y=240
    assert.strictEqual(bounds.x, 2480);
    assert.strictEqual(bounds.y, 240);
    assert.strictEqual(bounds.width, 800);
    assert.strictEqual(bounds.height, 600);
  });

  it('3. centered, A removed entirely → reposition to (now-only) display', () => {
    // Window was on A at (560, 240), but A is gone — only laptop display remains.
    // The window's old bounds at x=560 ARE inside the laptop display (0..1440),
    // so it's NOT stranded. But because mode is `centered`, we must always
    // re-center on cursor display every call.
    const displays = fakeDisplays([laptopOnly]);
    const result = computePlacement(input({
      placement: { mode: 'centered' },
      currentBounds: rect(560, 240, 800, 600),
      displays,
      cursorPoint: pt(720, 450),
      windowSize: { width: 800, height: 600 },
    }));
    const bounds = expectReposition(result);
    // laptopOnly: 1440x900 → centered 800x600: x=320, y=150
    assert.strictEqual(bounds.x, 320);
    assert.strictEqual(bounds.y, 150);
  });

  it('centered: cursor off all displays → falls back to primary (origin display)', () => {
    const displays = fakeDisplays([displayA, displayB]);
    const result = computePlacement(input({
      placement: { mode: 'centered' },
      currentBounds: rect(0, 0, 800, 600),
      displays,
      cursorPoint: pt(-9999, -9999), // nowhere
    }));
    const bounds = expectReposition(result);
    // Falls back to A (primary at 0,0): centered → x=560, y=240
    assert.strictEqual(bounds.x, 560);
    assert.strictEqual(bounds.y, 240);
  });
});

describe('computePlacement: cursor-display-fallback mode', () => {
  it('4. window currently fits, cursor moves to other display → no-change', () => {
    const displays = fakeDisplays([displayA, displayB]);
    const result = computePlacement(input({
      placement: { mode: 'cursor-display-fallback' },
      currentBounds: rect(100, 100, 800, 600), // on A, fits
      displays,
      cursorPoint: pt(2880, 540), // moved to B
    }));
    expectNoChange(result);
  });

  it('5. window stranded (display unplugged) → reposition to cursor display center', () => {
    // Window was on the external monitor, which is now gone.
    const displays = fakeDisplays([laptopOnly]);
    const result = computePlacement(input({
      placement: { mode: 'cursor-display-fallback' },
      currentBounds: rect(2400, 200, 800, 600), // off-screen for laptop
      displays,
      cursorPoint: pt(720, 450), // on laptop
    }));
    const bounds = expectReposition(result);
    assert.strictEqual(bounds.x, 320);
    assert.strictEqual(bounds.y, 150);
  });
});

describe('computePlacement: edge mode', () => {
  it('6. edge: top, cursor on A → bounds anchored to A top edge, X-centered', () => {
    const displays = fakeDisplays([displayA, displayB]);
    const result = computePlacement(input({
      placement: { mode: 'edge', edge: 'top' },
      currentBounds: rect(0, 500, 600, 200),
      windowSize: { width: 600, height: 200 },
      displays,
      cursorPoint: pt(960, 540), // on A
    }));
    const bounds = expectReposition(result);
    // A.workArea 0,0 1920x1080; window 600x200 anchored top, X-centered:
    // x = (1920 - 600) / 2 = 660, y = 0
    assert.strictEqual(bounds.x, 660);
    assert.strictEqual(bounds.y, 0);
    assert.strictEqual(bounds.width, 600);
    assert.strictEqual(bounds.height, 200);
  });

  it('7. edge: top, cursor moves to B → re-anchor to B top edge', () => {
    const displays = fakeDisplays([displayA, displayB]);
    const result = computePlacement(input({
      placement: { mode: 'edge', edge: 'top' },
      currentBounds: rect(660, 0, 600, 200), // top of A
      windowSize: { width: 600, height: 200 },
      displays,
      cursorPoint: pt(2880, 540), // on B
    }));
    const bounds = expectReposition(result);
    // B.workArea 1920,0 1920x1080; window 600x200 top, X-centered:
    // x = 1920 + (1920-600)/2 = 2580, y = 0
    assert.strictEqual(bounds.x, 2580);
    assert.strictEqual(bounds.y, 0);
  });

  it('edge: bottom anchors to bottom edge', () => {
    const displays = fakeDisplays([displayA]);
    const result = computePlacement(input({
      placement: { mode: 'edge', edge: 'bottom' },
      currentBounds: rect(0, 0, 600, 200),
      windowSize: { width: 600, height: 200 },
      displays,
      cursorPoint: pt(960, 540),
    }));
    const bounds = expectReposition(result);
    // y = 0 + 1080 - 200 = 880, X-centered → x = 660
    assert.strictEqual(bounds.x, 660);
    assert.strictEqual(bounds.y, 880);
  });

  it('edge: left anchors to left edge, Y-centered', () => {
    const displays = fakeDisplays([displayA]);
    const result = computePlacement(input({
      placement: { mode: 'edge', edge: 'left' },
      currentBounds: rect(500, 0, 300, 600),
      windowSize: { width: 300, height: 600 },
      displays,
      cursorPoint: pt(960, 540),
    }));
    const bounds = expectReposition(result);
    // x = 0, y = (1080-600)/2 = 240
    assert.strictEqual(bounds.x, 0);
    assert.strictEqual(bounds.y, 240);
  });

  it('edge: right anchors to right edge, Y-centered', () => {
    const displays = fakeDisplays([displayA]);
    const result = computePlacement(input({
      placement: { mode: 'edge', edge: 'right' },
      currentBounds: rect(0, 0, 300, 600),
      windowSize: { width: 300, height: 600 },
      displays,
      cursorPoint: pt(960, 540),
    }));
    const bounds = expectReposition(result);
    // x = 1920 - 300 = 1620, y = 240
    assert.strictEqual(bounds.x, 1620);
    assert.strictEqual(bounds.y, 240);
  });

  it('edge: top, currently already at correct edge position → no-change', () => {
    const displays = fakeDisplays([displayA]);
    const result = computePlacement(input({
      placement: { mode: 'edge', edge: 'top' },
      currentBounds: rect(660, 0, 600, 200),
      windowSize: { width: 600, height: 200 },
      displays,
      cursorPoint: pt(960, 540),
    }));
    expectNoChange(result);
  });
});

describe('computePlacement: parent-centered mode', () => {
  it('8. parent on A → centered on parent bounds', () => {
    const displays = fakeDisplays([displayA, displayB]);
    const parentBounds = rect(200, 200, 1000, 700); // on A
    const result = computePlacement(input({
      placement: { mode: 'parent-centered', parentId: 42 },
      currentBounds: rect(0, 0, 400, 300),
      windowSize: { width: 400, height: 300 },
      displays,
      cursorPoint: pt(960, 540),
      parentBounds,
    }));
    const bounds = expectReposition(result);
    // Parent center: 700, 550. Child 400x300 centered on parent rect:
    // x = 200 + (1000-400)/2 = 500, y = 200 + (700-300)/2 = 400
    assert.strictEqual(bounds.x, 500);
    assert.strictEqual(bounds.y, 400);
  });

  it('9. parent destroyed (parentBounds undefined) → no-change (cursor-display-fallback semantics)', () => {
    const displays = fakeDisplays([displayA]);
    const result = computePlacement(input({
      placement: { mode: 'parent-centered', parentId: 42 },
      currentBounds: rect(100, 100, 400, 300), // not stranded
      windowSize: { width: 400, height: 300 },
      displays,
      cursorPoint: pt(960, 540),
      parentBounds: undefined,
    }));
    expectNoChange(result);
  });

  it('parent destroyed AND stranded → rescue (stranded path takes priority)', () => {
    const displays = fakeDisplays([laptopOnly]);
    const result = computePlacement(input({
      placement: { mode: 'parent-centered', parentId: 42 },
      currentBounds: rect(2400, 200, 400, 300), // stranded
      windowSize: { width: 400, height: 300 },
      displays,
      cursorPoint: pt(720, 450),
      parentBounds: undefined,
    }));
    const bounds = expectReposition(result);
    // Centered on laptopOnly: x=520, y=300
    assert.strictEqual(bounds.x, 520);
    assert.strictEqual(bounds.y, 300);
  });

  it('parent on B, child currently on A → reposition to parent center on B', () => {
    const displays = fakeDisplays([displayA, displayB]);
    const parentBounds = rect(2200, 100, 800, 600); // on B
    const result = computePlacement(input({
      placement: { mode: 'parent-centered', parentId: 42 },
      currentBounds: rect(100, 100, 400, 300), // on A
      windowSize: { width: 400, height: 300 },
      displays,
      cursorPoint: pt(960, 540),
      parentBounds,
    }));
    const bounds = expectReposition(result);
    // Parent center: 2600, 400. Child centered: x=2400, y=250
    assert.strictEqual(bounds.x, 2400);
    assert.strictEqual(bounds.y, 250);
  });
});

describe('computePlacement: manual mode', () => {
  it('10. manual, window fits on some display → no-change', () => {
    const displays = fakeDisplays([displayA, displayB]);
    const result = computePlacement(input({
      placement: { mode: 'manual' },
      currentBounds: rect(700, 300, 600, 400), // on A, comfortable
      displays,
      cursorPoint: pt(2880, 540), // cursor on B; manual ignores
    }));
    expectNoChange(result);
  });

  it('11. manual, window stranded → rescue to cursor display center', () => {
    // Stranded rescue applies to ALL modes including manual.
    const displays = fakeDisplays([laptopOnly]);
    const result = computePlacement(input({
      placement: { mode: 'manual' },
      currentBounds: rect(externalUnplugged.x + 100, 100, 800, 600), // off-screen
      windowSize: { width: 800, height: 600 },
      displays,
      cursorPoint: pt(720, 450),
    }));
    const bounds = expectReposition(result);
    assert.strictEqual(bounds.x, 320);
    assert.strictEqual(bounds.y, 150);
  });
});

describe('computePlacement: clamping & edge cases', () => {
  it('12. window size larger than target display → output clamped to workArea', () => {
    const displays = fakeDisplays([laptopOnly]); // 1440x900
    const result = computePlacement(input({
      placement: { mode: 'centered' },
      currentBounds: rect(0, 0, 1, 1),
      windowSize: { width: 4000, height: 3000 }, // huge
      displays,
      cursorPoint: pt(720, 450),
    }));
    const bounds = expectReposition(result);
    // Clamped to workArea (1440x900), then centered: x=0, y=0
    assert.strictEqual(bounds.width, 1440);
    assert.strictEqual(bounds.height, 900);
    assert.strictEqual(bounds.x, 0);
    assert.strictEqual(bounds.y, 0);
  });

  it('zero-size window is never stranded (treated as hidden/minimized)', () => {
    const displays = fakeDisplays([laptopOnly]);
    const result = computePlacement(input({
      placement: { mode: 'manual' },
      currentBounds: rect(99999, 99999, 0, 0), // way off, but zero size
      displays,
      cursorPoint: pt(720, 450),
    }));
    // Manual + not stranded (zero area is treated as "always accessible") → no-change
    expectNoChange(result);
  });

  it('empty displays array → no-change for every mode', () => {
    const modes: Placement[] = [
      { mode: 'centered' },
      { mode: 'cursor-display-fallback' },
      { mode: 'edge', edge: 'top' },
      { mode: 'parent-centered', parentId: 1 },
      { mode: 'manual' },
    ];
    for (const placement of modes) {
      const result = computePlacement(input({
        placement,
        displays: [],
        cursorPoint: pt(0, 0),
      }));
      expectNoChange(result);
    }
  });

  it('point not on any display: cursor falls back to primary (origin display)', () => {
    const displays = fakeDisplays([displayA, displayB]);
    const result = computePlacement(input({
      placement: { mode: 'centered' },
      currentBounds: rect(0, 0, 800, 600),
      displays,
      cursorPoint: pt(99999, 99999), // far away
    }));
    // Should still produce a valid centering on A (primary).
    const bounds = expectReposition(result);
    assert.ok(bounds.x >= 0 && bounds.x < 1920);
    assert.ok(bounds.y >= 0 && bounds.y < 1080);
  });

  it('workArea smaller than bounds (menu bar / dock zones excluded)', () => {
    // Display at (0,0) 1920x1080 with a 25px menu bar at top.
    const displays = fakeDisplays([
      {
        id: 1, x: 0, y: 0, width: 1920, height: 1080, primary: true,
        workArea: { x: 0, y: 25, width: 1920, height: 1055 },
      },
    ]);
    const result = computePlacement(input({
      placement: { mode: 'centered' },
      currentBounds: rect(0, 0, 800, 600),
      displays,
      cursorPoint: pt(960, 540),
    }));
    const bounds = expectReposition(result);
    // workArea 0,25 1920x1055; centered 800x600:
    // x = 560, y = 25 + (1055-600)/2 = 25 + 227 = 252 (rounded from 227.5)
    assert.strictEqual(bounds.x, 560);
    assert.strictEqual(bounds.y, 253);
  });

  it('stranded window with negative coordinates → rescue', () => {
    const displays = fakeDisplays([laptopOnly]);
    const result = computePlacement(input({
      placement: { mode: 'cursor-display-fallback' },
      currentBounds: rect(-5000, -5000, 800, 600),
      displays,
      cursorPoint: pt(720, 450),
    }));
    const bounds = expectReposition(result);
    assert.strictEqual(bounds.x, 320);
    assert.strictEqual(bounds.y, 150);
  });

  it('stranded threshold: 49% overlap → rescue', () => {
    // Display 1000x1000, window 1000x1000 with center at (500, 500)+offset.
    // Place window so 49% of its area is on the display.
    // Window 100x100, on display only at right strip 49 wide:
    // Window at x=951, y=0, width=100, height=100: overlap is 49x100 = 4900, area 10000 → 49%.
    const displays = fakeDisplays([
      { id: 1, x: 0, y: 0, width: 1000, height: 1000, primary: true },
    ]);
    const result = computePlacement(input({
      placement: { mode: 'manual' },
      currentBounds: rect(951, 0, 100, 100),
      windowSize: { width: 100, height: 100 },
      displays,
      cursorPoint: pt(500, 500),
    }));
    const bounds = expectReposition(result);
    // Centered: x=450, y=450
    assert.strictEqual(bounds.x, 450);
    assert.strictEqual(bounds.y, 450);
  });

  it('stranded threshold: 51% overlap → no rescue (manual stays put)', () => {
    // Window at x=949, width=100 → overlap is 51 wide on display (0..1000).
    // 51 * 100 = 5100 / 10000 = 51% → above threshold, manual leaves alone.
    const displays = fakeDisplays([
      { id: 1, x: 0, y: 0, width: 1000, height: 1000, primary: true },
    ]);
    const result = computePlacement(input({
      placement: { mode: 'manual' },
      currentBounds: rect(949, 0, 100, 100),
      windowSize: { width: 100, height: 100 },
      displays,
      cursorPoint: pt(500, 500),
    }));
    expectNoChange(result);
  });

  it('parent-centered: parent center off all displays falls back to cursor display', () => {
    const displays = fakeDisplays([displayA]);
    const parentBounds = rect(99000, 99000, 400, 300); // way off
    const result = computePlacement(input({
      placement: { mode: 'parent-centered', parentId: 42 },
      currentBounds: rect(100, 100, 200, 150),
      windowSize: { width: 200, height: 150 },
      displays,
      cursorPoint: pt(960, 540),
      parentBounds,
    }));
    // Still proposes bounds: child centered on parent rect (parent rect is the
    // recorded position even if off-screen). The point of the targetDisplay
    // fallback is just to choose a clamping workArea — clamping uses A.
    const bounds = expectReposition(result);
    assert.strictEqual(bounds.width, 200);
    assert.strictEqual(bounds.height, 150);
  });

  it('cursor-display-fallback when window already centered on cursor display → no-change', () => {
    const displays = fakeDisplays([displayA]);
    const result = computePlacement(input({
      placement: { mode: 'cursor-display-fallback' },
      currentBounds: rect(560, 240, 800, 600),
      displays,
      cursorPoint: pt(960, 540),
    }));
    expectNoChange(result);
  });

  it('centered: re-center is exact pixel match → no spurious reposition', () => {
    const displays = fakeDisplays([displayA]);
    // Compute what centered should yield, then feed it back.
    const expected = rect(560, 240, 800, 600);
    const result = computePlacement(input({
      placement: { mode: 'centered' },
      currentBounds: expected,
      displays,
      cursorPoint: pt(960, 540),
    }));
    expectNoChange(result);
  });
});

describe('computePlacement: regression coverage from plan doc', () => {
  it('"External monitor unplugged, cmd panel still on the laptop screen but at old external coordinates"', () => {
    const displays = fakeDisplays([laptopOnly]);
    const result = computePlacement(input({
      placement: { mode: 'centered' },
      currentBounds: rect(2200, 200, 800, 600), // on the (now-missing) external
      displays,
      cursorPoint: centerOf(fakeDisplays([laptopOnly])[0]),
    }));
    const bounds = expectReposition(result);
    assert.strictEqual(bounds.x, 320);
    assert.strictEqual(bounds.y, 150);
  });

  it('"Slide opened, user moves to second display, slide stays on first"', () => {
    const displays = fakeDisplays([displayA, displayB]);
    const result = computePlacement(input({
      placement: { mode: 'edge', edge: 'top' },
      currentBounds: rect(660, 0, 600, 200), // top of A
      windowSize: { width: 600, height: 200 },
      displays,
      cursorPoint: pt(2880, 540), // user has moved to B
    }));
    const bounds = expectReposition(result);
    assert.strictEqual(bounds.x, 2580); // top of B, X-centered
    assert.strictEqual(bounds.y, 0);
  });
});
