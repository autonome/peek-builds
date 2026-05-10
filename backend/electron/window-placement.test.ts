/**
 * Unit tests for backend/electron/window-placement.ts — the pure
 * placement engine. All display data is fabricated via the
 * `fakeDisplays(...)` helper; no real Electron `screen` API is touched.
 *
 * Spec: docs/window-placement.md (canonical). The "Test scenarios"
 * section there enumerates the regression coverage this file must
 * provide; each test name calls out which scenario it covers.
 *
 * Runs under ELECTRON_RUN_AS_NODE=1 via `yarn test:unit`.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  computePlacement,
  computeInitialBounds,
  toProportional,
  ownDisplay,
  type Placement,
  type PlacementInput,
  type PlacementResult,
} from './window-placement.js';

// ---------------------------------------------------------------------------
// fakeDisplays — synthetic display layouts for unit testing
// ---------------------------------------------------------------------------

interface DisplaySpec {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Optional: smaller workArea (excluding menu bar / dock). Defaults to bounds. */
  workArea?: { x: number; y: number; width: number; height: number };
  /** Optional: marks this as primary. Used only as documentation in tests —
   *  callers pass the id explicitly via `primaryDisplayId` in the input. */
  primary?: boolean;
}

function fakeDisplays(specs: DisplaySpec[]): Electron.Display[] {
  return specs.map(s => {
    if (s.primary && (s.x !== 0 || s.y !== 0)) {
      throw new Error(`fakeDisplays: spec marked primary but bounds origin is (${s.x},${s.y})`);
    }
    const bounds = { x: s.x, y: s.y, width: s.width, height: s.height };
    const workArea = s.workArea ?? { ...bounds };
    return {
      id: s.id,
      bounds,
      workArea,
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

function rect(x: number, y: number, width: number, height: number): Electron.Rectangle {
  return { x, y, width, height };
}

function input(
  partial: Partial<PlacementInput> & Pick<PlacementInput, 'placement'>,
): PlacementInput {
  return {
    currentBounds: rect(0, 0, 800, 600),
    windowSize: { width: 800, height: 600 },
    displays: fakeDisplays([{ id: 1, x: 0, y: 0, width: 1920, height: 1080, primary: true }]),
    primaryDisplayId: 1,
    ...partial,
  };
}

function expectReposition(result: PlacementResult): Electron.Rectangle {
  assert.strictEqual(result.kind, 'reposition', `expected reposition, got ${result.kind}`);
  return (result as Extract<PlacementResult, { kind: 'reposition' }>).bounds;
}

function expectNoChange(result: PlacementResult): void {
  assert.strictEqual(result.kind, 'no-change', `expected no-change, got ${result.kind}`);
}

// Common fixtures
const displayA = { id: 1, x: 0, y: 0, width: 1920, height: 1080, primary: true } as DisplaySpec;
const displayB = { id: 2, x: 1920, y: 0, width: 1920, height: 1080 } as DisplaySpec;
const laptopOnly = { id: 1, x: 0, y: 0, width: 1440, height: 900, primary: true } as DisplaySpec;

// ---------------------------------------------------------------------------
// centered mode
// ---------------------------------------------------------------------------

describe('computePlacement: centered mode', () => {
  it('window already centered on its own display → no-change', () => {
    const displays = fakeDisplays([displayA, displayB]);
    const result = computePlacement(input({
      placement: { mode: 'centered' },
      currentBounds: rect(560, 240, 800, 600), // centered on A
      displays,
    }));
    expectNoChange(result);
  });

  it('window centered on A, primary stays A → no-change (cursor irrelevant)', () => {
    // The previous design re-centered on the cursor display every consume.
    // The new spec uses "own current display" — cursor never consulted —
    // so a window already correctly centered on its own display stays put,
    // regardless of where any cursor would be.
    const displays = fakeDisplays([displayA, displayB]);
    const result = computePlacement(input({
      placement: { mode: 'centered' },
      currentBounds: rect(560, 240, 800, 600), // centered on A
      displays,
      primaryDisplayId: 1, // A is primary
    }));
    expectNoChange(result);
  });

  it('centered window stays on its own display (B), even though primary is A', () => {
    const displays = fakeDisplays([displayA, displayB]);
    const result = computePlacement(input({
      placement: { mode: 'centered' },
      currentBounds: rect(2480, 240, 800, 600), // centered on B
      displays,
      primaryDisplayId: 1, // primary is A; window is on B
    }));
    expectNoChange(result);
  });

  it("window's display removed → reposition centered on primary", () => {
    // Window was centered on the external (B); B is unplugged.
    // Center of currentBounds is on no display → fall back to primary (A).
    const displays = fakeDisplays([displayA]);
    const result = computePlacement(input({
      placement: { mode: 'centered' },
      currentBounds: rect(2480, 240, 800, 600), // off A
      displays,
      primaryDisplayId: 1,
    }));
    const bounds = expectReposition(result);
    assert.strictEqual(bounds.x, Math.round((1920 - 800) / 2));
    assert.strictEqual(bounds.y, Math.round((1080 - 600) / 2));
  });

  it('centered, window-off-by-1 → reposition to exact center', () => {
    const displays = fakeDisplays([displayA]);
    const result = computePlacement(input({
      placement: { mode: 'centered' },
      currentBounds: rect(559, 240, 800, 600),
      displays,
    }));
    const bounds = expectReposition(result);
    assert.strictEqual(bounds.x, 560);
  });

  it('cursor-display-fallback is rejected by the type system but tolerable at runtime', () => {
    // The mode no longer exists in the union. A test that *passed* a
    // string-literal "cursor-display-fallback" would fail to typecheck —
    // intentional. This test exists only as a doc-comment for future
    // readers spelunking through grep history.
  });
});

// ---------------------------------------------------------------------------
// edge mode
// ---------------------------------------------------------------------------

describe('computePlacement: edge mode', () => {
  it('edge: top → bounds anchored to top of own display, X-centered', () => {
    const displays = fakeDisplays([displayA]);
    const result = computePlacement(input({
      placement: { mode: 'edge', edge: 'top' },
      currentBounds: rect(0, 500, 600, 200), // somewhere on A but not at top
      windowSize: { width: 600, height: 200 },
      displays,
    }));
    const bounds = expectReposition(result);
    assert.strictEqual(bounds.x, 660);
    assert.strictEqual(bounds.y, 0);
    assert.strictEqual(bounds.width, 600);
    assert.strictEqual(bounds.height, 200);
  });

  it('edge: top, slide on B → re-anchor to B top edge (own display)', () => {
    const displays = fakeDisplays([displayA, displayB]);
    const result = computePlacement(input({
      placement: { mode: 'edge', edge: 'top' },
      currentBounds: rect(2580, 0, 600, 200), // top of B already
      windowSize: { width: 600, height: 200 },
      displays,
      primaryDisplayId: 1,
    }));
    expectNoChange(result);
  });

  it('edge: top, slide center off all displays → re-anchor on primary', () => {
    const displays = fakeDisplays([displayA]); // B unplugged
    const result = computePlacement(input({
      placement: { mode: 'edge', edge: 'top' },
      currentBounds: rect(2580, 0, 600, 200), // was on B, now no-display
      windowSize: { width: 600, height: 200 },
      displays,
      primaryDisplayId: 1,
    }));
    const bounds = expectReposition(result);
    // anchor to top of A (primary), X-centered: x = (1920 - 600)/2 = 660
    assert.strictEqual(bounds.x, 660);
    assert.strictEqual(bounds.y, 0);
  });

  it('edge: bottom anchors to bottom edge', () => {
    const displays = fakeDisplays([displayA]);
    const result = computePlacement(input({
      placement: { mode: 'edge', edge: 'bottom' },
      currentBounds: rect(0, 0, 600, 200),
      windowSize: { width: 600, height: 200 },
      displays,
    }));
    const bounds = expectReposition(result);
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
    }));
    const bounds = expectReposition(result);
    assert.strictEqual(bounds.x, 0);
    assert.strictEqual(bounds.y, 240);
  });

  it('edge: right anchors to right edge', () => {
    const displays = fakeDisplays([displayA]);
    const result = computePlacement(input({
      placement: { mode: 'edge', edge: 'right' },
      currentBounds: rect(0, 0, 300, 600),
      windowSize: { width: 300, height: 600 },
      displays,
    }));
    const bounds = expectReposition(result);
    assert.strictEqual(bounds.x, 1620);
    assert.strictEqual(bounds.y, 240);
  });
});

// ---------------------------------------------------------------------------
// proportional mode
// ---------------------------------------------------------------------------

describe('computePlacement: proportional mode', () => {
  it('center: relX=0.5, relY=0.5 → centered on display', () => {
    const displays = fakeDisplays([displayA]);
    const result = computePlacement(input({
      placement: { mode: 'proportional', relX: 0.5, relY: 0.5 },
      currentBounds: rect(0, 0, 800, 600), // not at the projection
      windowSize: { width: 800, height: 600 },
      displays,
    }));
    const bounds = expectReposition(result);
    // freeX = 1920 - 800 = 1120; relX*freeX = 560. freeY = 1080 - 600 = 480; relY*freeY = 240
    assert.strictEqual(bounds.x, 560);
    assert.strictEqual(bounds.y, 240);
  });

  it('top-left corner: relX=0, relY=0 → flush at workArea origin', () => {
    const displays = fakeDisplays([displayA]);
    const result = computePlacement(input({
      placement: { mode: 'proportional', relX: 0, relY: 0 },
      currentBounds: rect(100, 100, 800, 600),
      windowSize: { width: 800, height: 600 },
      displays,
    }));
    const bounds = expectReposition(result);
    assert.strictEqual(bounds.x, 0);
    assert.strictEqual(bounds.y, 0);
  });

  it('top-right corner: relX=1, relY=0 → flush right, flush top', () => {
    const displays = fakeDisplays([displayA]);
    const result = computePlacement(input({
      placement: { mode: 'proportional', relX: 1, relY: 0 },
      currentBounds: rect(100, 100, 800, 600),
      windowSize: { width: 800, height: 600 },
      displays,
    }));
    const bounds = expectReposition(result);
    // freeX = 1920 - 800 = 1120 → x = 1120
    assert.strictEqual(bounds.x, 1120);
    assert.strictEqual(bounds.y, 0);
  });

  it('bottom-right corner: relX=1, relY=1 → flush bottom-right', () => {
    const displays = fakeDisplays([displayA]);
    const result = computePlacement(input({
      placement: { mode: 'proportional', relX: 1, relY: 1 },
      currentBounds: rect(0, 0, 800, 600),
      windowSize: { width: 800, height: 600 },
      displays,
    }));
    const bounds = expectReposition(result);
    assert.strictEqual(bounds.x, 1120);
    assert.strictEqual(bounds.y, 480);
  });

  it('proportional projection scales across displays — top-right stays top-right', () => {
    // Window is at top-right of A (relX=1, relY=0). Switch to laptopOnly.
    // Should land at top-right of laptopOnly.
    const result = computePlacement(input({
      placement: { mode: 'proportional', relX: 1, relY: 0 },
      currentBounds: rect(2680, 0, 800, 600), // off any present display
      windowSize: { width: 800, height: 600 },
      displays: fakeDisplays([laptopOnly]),
      primaryDisplayId: 1,
    }));
    const bounds = expectReposition(result);
    // laptopOnly: 1440x900; freeX = 640, freeY = 300
    assert.strictEqual(bounds.x, 640);
    assert.strictEqual(bounds.y, 0);
    assert.strictEqual(bounds.width, 800);
    assert.strictEqual(bounds.height, 600);
  });

  it('window the same size as display → freeSpace=0, lands at origin', () => {
    const displays = fakeDisplays([displayA]);
    const result = computePlacement(input({
      placement: { mode: 'proportional', relX: 0.7, relY: 0.3 },
      currentBounds: rect(0, 0, 1920, 1080), // full-display already
      windowSize: { width: 1920, height: 1080 },
      displays,
    }));
    expectNoChange(result);
  });

  it('window larger than display → clamps size, lands at origin', () => {
    const displays = fakeDisplays([laptopOnly]);
    const result = computePlacement(input({
      placement: { mode: 'proportional', relX: 0.95, relY: 0.05 },
      currentBounds: rect(100, 100, 800, 600),
      windowSize: { width: 4000, height: 3000 },
      displays,
    }));
    const bounds = expectReposition(result);
    assert.strictEqual(bounds.width, 1440);
    assert.strictEqual(bounds.height, 900);
    // freeX = 0 → x = 0
    assert.strictEqual(bounds.x, 0);
    assert.strictEqual(bounds.y, 0);
  });

  it('out-of-range relX/relY are clamped to [0,1]', () => {
    const displays = fakeDisplays([displayA]);
    const result = computePlacement(input({
      placement: { mode: 'proportional', relX: 2, relY: -0.5 },
      currentBounds: rect(0, 0, 800, 600),
      windowSize: { width: 800, height: 600 },
      displays,
    }));
    const bounds = expectReposition(result);
    // relX=2 clamps to 1 → x = freeX = 1120; relY=-0.5 clamps to 0 → y = 0
    assert.strictEqual(bounds.x, 1120);
    assert.strictEqual(bounds.y, 0);
  });

  it("window's display removed → reposition on primary at same relative position", () => {
    // Window at top-right of B; B is gone, primary is A. Lands at top-right of A.
    const displays = fakeDisplays([displayA]);
    const result = computePlacement(input({
      placement: { mode: 'proportional', relX: 1, relY: 0 },
      currentBounds: rect(2680, 0, 800, 600), // was top-right of B
      windowSize: { width: 800, height: 600 },
      displays,
      primaryDisplayId: 1,
    }));
    const bounds = expectReposition(result);
    assert.strictEqual(bounds.x, 1120);
    assert.strictEqual(bounds.y, 0);
  });
});

// ---------------------------------------------------------------------------
// parent-centered mode
// ---------------------------------------------------------------------------

describe('computePlacement: parent-centered mode', () => {
  it('parent on A → centered on parent bounds', () => {
    const displays = fakeDisplays([displayA, displayB]);
    const parentBounds = rect(200, 200, 1000, 700);
    const result = computePlacement(input({
      placement: { mode: 'parent-centered', parentId: 42 },
      currentBounds: rect(0, 0, 400, 300),
      windowSize: { width: 400, height: 300 },
      displays,
      primaryDisplayId: 1,
      parentBounds,
    }));
    const bounds = expectReposition(result);
    assert.strictEqual(bounds.x, 500);
    assert.strictEqual(bounds.y, 400);
  });

  it('parent destroyed → fall back to centering on primary', () => {
    const displays = fakeDisplays([displayA]);
    const result = computePlacement(input({
      placement: { mode: 'parent-centered', parentId: 42 },
      currentBounds: rect(0, 0, 400, 300),
      windowSize: { width: 400, height: 300 },
      displays,
      primaryDisplayId: 1,
      parentBounds: undefined,
    }));
    const bounds = expectReposition(result);
    // Centered on A: x = (1920-400)/2 = 760, y = (1080-300)/2 = 390
    assert.strictEqual(bounds.x, 760);
    assert.strictEqual(bounds.y, 390);
  });

  it('parent on B → centered on parent (uses parent display for size clamp)', () => {
    const displays = fakeDisplays([displayA, displayB]);
    const parentBounds = rect(2200, 100, 800, 600);
    const result = computePlacement(input({
      placement: { mode: 'parent-centered', parentId: 42 },
      currentBounds: rect(100, 100, 400, 300),
      windowSize: { width: 400, height: 300 },
      displays,
      primaryDisplayId: 1,
      parentBounds,
    }));
    const bounds = expectReposition(result);
    assert.strictEqual(bounds.x, 2400);
    assert.strictEqual(bounds.y, 250);
  });
});

// ---------------------------------------------------------------------------
// edge cases
// ---------------------------------------------------------------------------

describe('computePlacement: edge cases', () => {
  it('empty displays → no-change for every mode', () => {
    const modes: Placement[] = [
      { mode: 'centered' },
      { mode: 'edge', edge: 'top' },
      { mode: 'proportional', relX: 0.5, relY: 0.5 },
      { mode: 'parent-centered', parentId: 1 },
    ];
    for (const placement of modes) {
      const result = computePlacement(input({
        placement,
        displays: [],
        primaryDisplayId: 0,
      }));
      expectNoChange(result);
    }
  });

  it('primaryDisplayId not in displays → falls back to displays[0]', () => {
    const displays = fakeDisplays([displayA]);
    const result = computePlacement(input({
      placement: { mode: 'centered' },
      currentBounds: rect(99000, 99000, 800, 600), // off all displays
      displays,
      primaryDisplayId: 9999, // not in the list
    }));
    const bounds = expectReposition(result);
    // Falls back to displays[0] = A
    assert.strictEqual(bounds.x, 560);
    assert.strictEqual(bounds.y, 240);
  });

  it('workArea smaller than bounds (menu bar excluded)', () => {
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
    }));
    const bounds = expectReposition(result);
    assert.strictEqual(bounds.x, 560);
    assert.strictEqual(bounds.y, 253); // 25 + round(455/2)
  });
});

// ---------------------------------------------------------------------------
// computeInitialBounds (fresh-window helper, no currentBounds)
// ---------------------------------------------------------------------------

describe('computeInitialBounds: fresh-window helper', () => {
  it('centered on primary regardless of cursor (cursor not consulted)', () => {
    const displays = fakeDisplays([displayA, displayB]);
    const bounds = computeInitialBounds(
      { mode: 'centered' },
      { width: 800, height: 600 },
      displays,
      1, // primary is A
    );
    assert.strictEqual(bounds.x, 560);
    assert.strictEqual(bounds.y, 240);
  });

  it('primaryDisplayId=2 → centered on B', () => {
    const displays = fakeDisplays([displayA, displayB]);
    const bounds = computeInitialBounds(
      { mode: 'centered' },
      { width: 800, height: 600 },
      displays,
      2,
    );
    assert.strictEqual(bounds.x, 1920 + 560);
    assert.strictEqual(bounds.y, 240);
  });

  it('proportional (0.5, 0.5) on primary equivalent to centered', () => {
    const displays = fakeDisplays([displayA]);
    const bounds = computeInitialBounds(
      { mode: 'proportional', relX: 0.5, relY: 0.5 },
      { width: 800, height: 600 },
      displays,
      1,
    );
    assert.strictEqual(bounds.x, 560);
    assert.strictEqual(bounds.y, 240);
  });

  it('proportional (1, 0) on primary → top-right', () => {
    const displays = fakeDisplays([displayA]);
    const bounds = computeInitialBounds(
      { mode: 'proportional', relX: 1, relY: 0 },
      { width: 800, height: 600 },
      displays,
      1,
    );
    assert.strictEqual(bounds.x, 1120);
    assert.strictEqual(bounds.y, 0);
  });

  it('edge: top on primary, X-centered', () => {
    const displays = fakeDisplays([displayA, displayB]);
    const bounds = computeInitialBounds(
      { mode: 'edge', edge: 'top' },
      { width: 600, height: 200 },
      displays,
      2, // primary is B
    );
    assert.strictEqual(bounds.x, 1920 + Math.round((1920 - 600) / 2));
    assert.strictEqual(bounds.y, 0);
  });

  it('parent-centered with parentBounds → on parent display', () => {
    const displays = fakeDisplays([displayA]);
    const parent = rect(100, 100, 1000, 800);
    const bounds = computeInitialBounds(
      { mode: 'parent-centered', parentId: 42 },
      { width: 400, height: 300 },
      displays,
      1,
      parent,
    );
    assert.strictEqual(bounds.x, 100 + Math.round((1000 - 400) / 2));
    assert.strictEqual(bounds.y, 100 + Math.round((800 - 300) / 2));
  });

  it('parent-centered without parentBounds → centered on primary', () => {
    const displays = fakeDisplays([displayA]);
    const bounds = computeInitialBounds(
      { mode: 'parent-centered', parentId: 42 },
      { width: 400, height: 300 },
      displays,
      1,
      undefined,
    );
    assert.strictEqual(bounds.x, Math.round((1920 - 400) / 2));
    assert.strictEqual(bounds.y, Math.round((1080 - 300) / 2));
  });

  it('clamps oversize windows to workArea', () => {
    const displays = fakeDisplays([laptopOnly]);
    const bounds = computeInitialBounds(
      { mode: 'centered' },
      { width: 9999, height: 9999 },
      displays,
      1,
    );
    assert.strictEqual(bounds.width, 1440);
    assert.strictEqual(bounds.height, 900);
  });

  it('empty displays → returns origin rect (headless safe fallback)', () => {
    const bounds = computeInitialBounds(
      { mode: 'centered' },
      { width: 800, height: 600 },
      [],
      0,
    );
    assert.deepStrictEqual(bounds, { x: 0, y: 0, width: 800, height: 600 });
  });
});

// ---------------------------------------------------------------------------
// toProportional helper
// ---------------------------------------------------------------------------

describe('toProportional', () => {
  const display = fakeDisplays([displayA])[0];

  it('top-left of display → (0, 0)', () => {
    const r = toProportional(rect(0, 0, 800, 600), display);
    assert.strictEqual(r.relX, 0);
    assert.strictEqual(r.relY, 0);
  });

  it('top-right of display → (1, 0)', () => {
    const r = toProportional(rect(1120, 0, 800, 600), display);
    assert.strictEqual(r.relX, 1);
    assert.strictEqual(r.relY, 0);
  });

  it('bottom-right of display → (1, 1)', () => {
    const r = toProportional(rect(1120, 480, 800, 600), display);
    assert.strictEqual(r.relX, 1);
    assert.strictEqual(r.relY, 1);
  });

  it('center of display → (0.5, 0.5)', () => {
    const r = toProportional(rect(560, 240, 800, 600), display);
    assert.strictEqual(r.relX, 0.5);
    assert.strictEqual(r.relY, 0.5);
  });

  it('window same size as display → both axes report 0', () => {
    const r = toProportional(rect(0, 0, 1920, 1080), display);
    assert.strictEqual(r.relX, 0);
    assert.strictEqual(r.relY, 0);
  });

  it('out-of-bounds coordinates clamp to [0, 1]', () => {
    const r = toProportional(rect(-500, 9999, 800, 600), display);
    assert.strictEqual(r.relX, 0);
    assert.strictEqual(r.relY, 1);
  });

  it('round-trip with computePlacement is idempotent at corners', () => {
    // Take a bounds at a corner, derive proportional, project back, expect equality.
    const original = rect(1120, 480, 800, 600); // bottom-right
    const { relX, relY } = toProportional(original, display);
    const result = computePlacement({
      placement: { mode: 'proportional', relX, relY },
      currentBounds: rect(0, 0, 800, 600), // anywhere not the original
      windowSize: { width: 800, height: 600 },
      displays: [display],
      primaryDisplayId: 1,
    });
    const projected = expectReposition(result);
    assert.deepStrictEqual(projected, original);
  });
});

// ---------------------------------------------------------------------------
// ownDisplay helper
// ---------------------------------------------------------------------------

describe('ownDisplay', () => {
  it('returns the display containing the bounds center', () => {
    const displays = fakeDisplays([displayA, displayB]);
    const d = ownDisplay(rect(2400, 200, 800, 600), displays, 1);
    assert.strictEqual(d.id, 2);
  });

  it('center off all displays → returns primary', () => {
    const displays = fakeDisplays([displayA, displayB]);
    const d = ownDisplay(rect(99000, 99000, 800, 600), displays, 1);
    assert.strictEqual(d.id, 1);
  });

  it('primary id missing from displays → returns first display', () => {
    const displays = fakeDisplays([displayA]);
    const d = ownDisplay(rect(99000, 99000, 800, 600), displays, 99);
    assert.strictEqual(d.id, 1);
  });
});

// ---------------------------------------------------------------------------
// Spec-mandated regression scenarios (docs/window-placement.md "Test scenarios")
// ---------------------------------------------------------------------------

describe('spec regression: cross-display projection round-trip', () => {
  it('1. proportional on A, project to B, recompute relative — same (relX, relY)', () => {
    const displays = fakeDisplays([displayA, displayB]);
    const placement: Placement = { mode: 'proportional', relX: 0.7, relY: 0.3 };
    const ws = { width: 800, height: 600 };
    // Project onto B by passing currentBounds whose center is on B
    const onB = computePlacement({
      placement,
      currentBounds: rect(2200, 100, 800, 600),
      windowSize: ws,
      displays,
      primaryDisplayId: 1,
    });
    const bounds = expectReposition(onB);
    // Now derive (relX, relY) from those bounds against B
    const back = toProportional(bounds, displays[1]);
    assert.strictEqual(Math.round(back.relX * 1000), 700);
    assert.strictEqual(Math.round(back.relY * 1000), 300);
  });
});

describe('spec regression: edge slide stays edge-anchored across live display change', () => {
  it('4. slide on B-top, B is removed → re-anchors to A (primary) top', () => {
    // Live display change: window had bounds on B at top edge; B is gone.
    const result = computePlacement(input({
      placement: { mode: 'edge', edge: 'top' },
      currentBounds: rect(2580, 0, 600, 200), // was top of B
      windowSize: { width: 600, height: 200 },
      displays: fakeDisplays([displayA]),
      primaryDisplayId: 1,
    }));
    const bounds = expectReposition(result);
    assert.strictEqual(bounds.y, 0);
    assert.strictEqual(bounds.x, 660); // X-centered on A
  });
});

describe('spec regression: peek stays centered across live display change', () => {
  it('5. peek on B center, B is removed → centered on A (primary)', () => {
    const result = computePlacement(input({
      placement: { mode: 'centered' },
      currentBounds: rect(2480, 240, 800, 600), // was centered on B
      displays: fakeDisplays([displayA]),
      primaryDisplayId: 1,
    }));
    const bounds = expectReposition(result);
    assert.strictEqual(bounds.x, 560);
    assert.strictEqual(bounds.y, 240);
  });
});

describe('spec regression: resize then display-swap preserves visual position', () => {
  it('2. window resized on A, then swapped to laptopOnly — relative position preserved', () => {
    // Window starts at top-right of A (1920x1080) at 800x600 → x=1120, y=0.
    const a = fakeDisplays([displayA])[0];
    const original = rect(1120, 0, 800, 600);
    const before = toProportional(original, a);
    assert.strictEqual(before.relX, 1);
    assert.strictEqual(before.relY, 0);

    // User resizes wider to 1000x600 on A. Per spec, the set-bounds tick
    // recomputes (relX, relY) against the new size: freeX=920, the user
    // dragged the right edge so the window is still flush-right at x=920.
    const resized = rect(920, 0, 1000, 600);
    const after = toProportional(resized, a);
    assert.strictEqual(after.relX, 1);
    assert.strictEqual(after.relY, 0);

    // Now disconnect external — swap to laptopOnly (1440x900). Project
    // (relX=1, relY=0) at the new size (1000x600).
    const swap = computePlacement(input({
      placement: { mode: 'proportional', relX: 1, relY: 0 },
      currentBounds: resized,
      windowSize: { width: 1000, height: 600 },
      displays: fakeDisplays([laptopOnly]),
      primaryDisplayId: 1,
    }));
    const projected = expectReposition(swap);
    // freeX on laptop = 1440-1000 = 440 → x=440 (flush-right).
    assert.strictEqual(projected.x, 440);
    assert.strictEqual(projected.y, 0);
    assert.strictEqual(projected.width, 1000);
    assert.strictEqual(projected.height, 600);
  });
});

describe('spec regression: primary display reassigned while window open', () => {
  it('6. centered window off-display, primary reassigned A→B → re-centers on new primary', () => {
    // Window center is on no display (e.g. just disconnected the display
    // it was on). With primary=A, centered falls back to A. With primary=B,
    // centered falls back to B. The placement engine re-projects against
    // whichever primary the OS reports per call — no stored display id.
    const displays = fakeDisplays([displayA, displayB]);
    const offBoth = rect(99000, 99000, 800, 600);

    const onA = computePlacement(input({
      placement: { mode: 'centered' },
      currentBounds: offBoth,
      displays,
      primaryDisplayId: 1,
    }));
    const a = expectReposition(onA);
    assert.strictEqual(a.x, 560);
    assert.strictEqual(a.y, 240);

    const onB = computePlacement(input({
      placement: { mode: 'centered' },
      currentBounds: offBoth,
      displays,
      primaryDisplayId: 2,
    }));
    const b = expectReposition(onB);
    assert.strictEqual(b.x, 1920 + 560);
    assert.strictEqual(b.y, 240);
  });

  it('6b. proportional window off-display, primary reassigned → re-projects relative to new primary', () => {
    const displays = fakeDisplays([displayA, displayB]);
    const offBoth = rect(99000, 99000, 800, 600);

    // Primary=A: top-right (relX=1) projects to A's top-right.
    const onA = computePlacement(input({
      placement: { mode: 'proportional', relX: 1, relY: 0 },
      currentBounds: offBoth,
      displays,
      primaryDisplayId: 1,
    }));
    const a = expectReposition(onA);
    assert.strictEqual(a.x, 1120); // freeX on A (1920-800)
    assert.strictEqual(a.y, 0);

    // Primary=B: top-right projects to B's top-right.
    const onB = computePlacement(input({
      placement: { mode: 'proportional', relX: 1, relY: 0 },
      currentBounds: offBoth,
      displays,
      primaryDisplayId: 2,
    }));
    const b = expectReposition(onB);
    assert.strictEqual(b.x, 1920 + 1120);
    assert.strictEqual(b.y, 0);
  });
});

describe('spec regression: stranded-by-construction', () => {
  it('8. no mode produces bounds outside any display, even with oversize windowSize', () => {
    const displays = fakeDisplays([laptopOnly]);
    const placements: Placement[] = [
      { mode: 'centered' },
      { mode: 'edge', edge: 'top' },
      { mode: 'edge', edge: 'right' },
      { mode: 'proportional', relX: 0.7, relY: 0.3 },
      { mode: 'parent-centered', parentId: 1 },
    ];
    for (const placement of placements) {
      const result = computePlacement({
        placement,
        currentBounds: rect(10, 10, 1, 1),
        windowSize: { width: 99999, height: 99999 },
        displays,
        primaryDisplayId: 1,
      });
      const bounds = result.kind === 'reposition'
        ? result.bounds
        : rect(10, 10, 1, 1);
      // Bounds must be entirely within laptopOnly's workArea
      const wa = displays[0].workArea;
      assert.ok(bounds.x >= wa.x, `${placement.mode}: x ${bounds.x} < ${wa.x}`);
      assert.ok(bounds.y >= wa.y, `${placement.mode}: y ${bounds.y} < ${wa.y}`);
      assert.ok(bounds.x + bounds.width  <= wa.x + wa.width,
        `${placement.mode}: right exceeds workArea`);
      assert.ok(bounds.y + bounds.height <= wa.y + wa.height,
        `${placement.mode}: bottom exceeds workArea`);
    }
  });
});
