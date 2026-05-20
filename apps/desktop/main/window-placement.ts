/**
 * Window Placement — Pure Engine
 *
 * Single source of truth for "where should this window go?" decisions.
 * Pure function from inputs to output: no `screen.*` calls, no
 * `BrowserWindow.*` references, no Electron runtime imports. The caller
 * is responsible for collecting the current display layout, primary
 * display id, window bounds, and parent bounds, and for applying the
 * result via `setBounds()` (only when `kind === 'reposition'`).
 *
 * Spec: docs/window-placement.md (canonical). This file is the Electron
 * binding implementation; a Tauri equivalent will share the same contract.
 *
 * Principles:
 * - Intent is the source of truth. Bounds are a derived projection.
 * - Every consumer goes through one pure function (this module).
 * - Cursor position is never consulted. Display selection is by own
 *   current display, with primary as fallback.
 *
 * Type-only Electron imports below are erased at compile time and don't
 * pull the runtime into this module. Tests fabricate display objects
 * without touching the real `screen` API.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Discriminated union describing where a window wants to live. Recorded
 * at window-open time on `windowRegistry.params.placement` and consulted
 * on every reuse / display-change pass thereafter.
 *
 * Modes:
 * - `centered`         — peeks, cmd panel, modal palettes
 * - `edge`             — slides, anchored to one edge of their display
 * - `proportional`     — user-positioned; preserves relative position
 *                        across display changes via free-space normalization
 * - `parent-centered`  — child popups
 *
 * `manual` and `cursor-display-fallback` from the previous design are
 * eliminated. `manual` is replaced by `proportional`. `cursor-display-
 * fallback` is decomposed: at open time we project initial position into
 * proportional and persist that.
 */
export type Placement =
  | { mode: 'centered' }
  | { mode: 'edge'; edge: 'top' | 'bottom' | 'left' | 'right' }
  | { mode: 'proportional'; relX: number; relY: number }
  | { mode: 'parent-centered'; parentId: number };

export interface PlacementInput {
  /** The placement intent recorded at open time. */
  placement: Placement;
  /** Window's bounds right now. Used for "own current display" lookup
   *  and for the no-change short-circuit. */
  currentBounds: Electron.Rectangle;
  /** Desired/intrinsic window size (clamped to workArea by the projection). */
  windowSize: { width: number; height: number };
  /** Snapshot of all displays (caller obtains via `screen.getAllDisplays()`). */
  displays: Electron.Display[];
  /** OS-supplied primary display id (caller obtains via
   *  `screen.getPrimaryDisplay().id`). On macOS this is the menu-bar screen. */
  primaryDisplayId: number;
  /** Required for `parent-centered`. Undefined if parent has been destroyed. */
  parentBounds?: Electron.Rectangle;
}

export type PlacementResult =
  | { kind: 'no-change' }
  | { kind: 'reposition'; bounds: Electron.Rectangle };

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

/** Find the display whose workArea (then bounds) contains `point`. */
function findDisplayForPoint(
  displays: Electron.Display[],
  point: Electron.Point,
): Electron.Display | null {
  for (const d of displays) {
    const wa = d.workArea;
    if (
      point.x >= wa.x && point.x < wa.x + wa.width &&
      point.y >= wa.y && point.y < wa.y + wa.height
    ) return d;
  }
  for (const d of displays) {
    const b = d.bounds;
    if (
      point.x >= b.x && point.x < b.x + b.width &&
      point.y >= b.y && point.y < b.y + b.height
    ) return d;
  }
  return null;
}

/**
 * Pick the target display for a placement.
 *
 * - `centered` / `edge` / `proportional`: own current display (the one
 *   containing the window's center). If no `currentBounds` is provided
 *   (fresh open) or the center is on no display, fall back to primary.
 * - `parent-centered`: parent's display (containing parent's center).
 *   Falls back to primary if parent bounds missing or off all displays.
 *
 * Always returns a real display when `displays` is non-empty. Cursor
 * position is never consulted.
 */
function pickTargetDisplay(
  placement: Placement,
  currentBounds: Electron.Rectangle | undefined,
  displays: Electron.Display[],
  primaryDisplayId: number,
  parentBounds: Electron.Rectangle | undefined,
): Electron.Display {
  const primary =
    displays.find(d => d.id === primaryDisplayId) ?? displays[0];

  if (placement.mode === 'parent-centered') {
    if (!parentBounds) return primary;
    const center: Electron.Point = {
      x: parentBounds.x + Math.round(parentBounds.width / 2),
      y: parentBounds.y + Math.round(parentBounds.height / 2),
    };
    return findDisplayForPoint(displays, center) ?? primary;
  }

  if (!currentBounds) return primary;
  const center: Electron.Point = {
    x: currentBounds.x + Math.round(currentBounds.width / 2),
    y: currentBounds.y + Math.round(currentBounds.height / 2),
  };
  return findDisplayForPoint(displays, center) ?? primary;
}

/** Clamp a desired size to a workArea — never grow, only shrink to fit. */
function clampSize(
  size: { width: number; height: number },
  workArea: Electron.Rectangle,
): { width: number; height: number } {
  return {
    width: Math.min(size.width, workArea.width),
    height: Math.min(size.height, workArea.height),
  };
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Bounds-equality test — used to short-circuit `setBounds()` calls. */
function rectsEqual(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Project a placement into concrete bounds on a chosen display.
 *
 * Total: always returns a valid Rectangle clamped to the target's
 * workArea. Idempotent: same inputs → same output, no random component.
 *
 * Per-mode behavior matches the spec:
 * - `centered`: center on workArea
 * - `edge`: anchor to the named edge; cross-axis is centered
 * - `proportional`: top-left at (relX × freeSpaceX, relY × freeSpaceY)
 * - `parent-centered`: center on parentBounds; if missing, center on
 *   the chosen target's workArea (graceful fallback)
 */
function projectBounds(
  placement: Placement,
  windowSize: { width: number; height: number },
  target: Electron.Display,
  parentBounds: Electron.Rectangle | undefined,
): Electron.Rectangle {
  const wa = target.workArea;
  const { width: w, height: h } = clampSize(windowSize, wa);

  switch (placement.mode) {
    case 'centered':
      return {
        x: wa.x + Math.round((wa.width - w) / 2),
        y: wa.y + Math.round((wa.height - h) / 2),
        width: w, height: h,
      };

    case 'edge':
      switch (placement.edge) {
        case 'top':
          return {
            x: wa.x + Math.round((wa.width - w) / 2),
            y: wa.y,
            width: w, height: h,
          };
        case 'bottom':
          return {
            x: wa.x + Math.round((wa.width - w) / 2),
            y: wa.y + wa.height - h,
            width: w, height: h,
          };
        case 'left':
          return {
            x: wa.x,
            y: wa.y + Math.round((wa.height - h) / 2),
            width: w, height: h,
          };
        case 'right':
          return {
            x: wa.x + wa.width - w,
            y: wa.y + Math.round((wa.height - h) / 2),
            width: w, height: h,
          };
      }
      // Unreachable — exhaustive switch above
      // eslint-disable-next-line no-fallthrough
      return { x: wa.x, y: wa.y, width: w, height: h };

    case 'proportional': {
      const freeX = Math.max(0, wa.width - w);
      const freeY = Math.max(0, wa.height - h);
      return {
        x: wa.x + Math.round(clamp01(placement.relX) * freeX),
        y: wa.y + Math.round(clamp01(placement.relY) * freeY),
        width: w, height: h,
      };
    }

    case 'parent-centered': {
      // Center on parent's bounds when available. The chosen target
      // display's workArea is used for the size clamp above; placement
      // is relative to the parent rectangle, not the workArea.
      if (parentBounds) {
        return {
          x: parentBounds.x + Math.round((parentBounds.width - w) / 2),
          y: parentBounds.y + Math.round((parentBounds.height - h) / 2),
          width: w, height: h,
        };
      }
      // Parent destroyed → fall back to centering on target display.
      return {
        x: wa.x + Math.round((wa.width - w) / 2),
        y: wa.y + Math.round((wa.height - h) / 2),
        width: w, height: h,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decide where a window should go right now, given its placement intent
 * and the live display layout.
 *
 * Contract:
 * - Pure. No global state, no Electron runtime calls.
 * - Returns `{ kind: 'no-change' }` if the projected bounds match
 *   `currentBounds` exactly → caller skips `setBounds()`.
 * - Otherwise returns `{ kind: 'reposition', bounds }`.
 * - If `displays` is empty, returns `no-change` — there's nowhere to
 *   project to. Caller should treat this as "wait until displays
 *   come back."
 */
export function computePlacement(input: PlacementInput): PlacementResult {
  if (input.displays.length === 0) return { kind: 'no-change' };
  const target = pickTargetDisplay(
    input.placement,
    input.currentBounds,
    input.displays,
    input.primaryDisplayId,
    input.parentBounds,
  );
  const proposed = projectBounds(
    input.placement,
    input.windowSize,
    target,
    input.parentBounds,
  );
  if (rectsEqual(input.currentBounds, proposed)) return { kind: 'no-change' };
  return { kind: 'reposition', bounds: proposed };
}

/**
 * Compute initial bounds for a window that doesn't yet exist (no
 * `currentBounds` available). Used by the fresh-open path in `ipc.ts`
 * to derive `winOptions.x/y/width/height` BEFORE `new BrowserWindow()`.
 *
 * Always returns a concrete `Rectangle`. With no `currentBounds`, the
 * target is **primary** for centered/edge/proportional, and the parent's
 * display for parent-centered (falling back to primary).
 *
 * If `displays` is empty, returns a rect at (0, 0) with the requested
 * size — caller is presumably running headless.
 */
export function computeInitialBounds(
  placement: Placement,
  size: { width: number; height: number },
  displays: Electron.Display[],
  primaryDisplayId: number,
  parentBounds?: Electron.Rectangle,
): Electron.Rectangle {
  if (displays.length === 0) {
    return { x: 0, y: 0, width: size.width, height: size.height };
  }
  const target = pickTargetDisplay(
    placement, undefined, displays, primaryDisplayId, parentBounds,
  );
  return projectBounds(placement, size, target, parentBounds);
}

/**
 * Convert absolute bounds on a specific display into proportional
 * `(relX, relY)` for the proportional placement mode.
 *
 * Used by the `tile:window:set-bounds` per-tick handler to update
 * placement intent on every drag/resize: given the user's new bounds,
 * compute the (relX, relY) that would project back to those bounds on
 * the display the window's center is on now.
 *
 * Returns values clamped to `[0, 1]`. When the window is the same size
 * as the display (zero free space), returns `0` for that axis.
 */
export function toProportional(
  bounds: Electron.Rectangle,
  display: Electron.Display,
): { relX: number; relY: number } {
  const wa = display.workArea;
  const freeX = Math.max(0, wa.width - bounds.width);
  const freeY = Math.max(0, wa.height - bounds.height);
  return {
    relX: freeX === 0 ? 0 : clamp01((bounds.x - wa.x) / freeX),
    relY: freeY === 0 ? 0 : clamp01((bounds.y - wa.y) / freeY),
  };
}

/**
 * Find which display a window is currently on, by its center point.
 * Falls back to primary if center is on no display, or `displays[0]` if
 * primary id isn't in the list.
 *
 * Exported for callers that need to compute proportional intent against
 * the window's current display (e.g. set-bounds handler, window-open
 * with explicit x/y).
 */
export function ownDisplay(
  bounds: Electron.Rectangle,
  displays: Electron.Display[],
  primaryDisplayId: number,
): Electron.Display {
  const primary =
    displays.find(d => d.id === primaryDisplayId) ?? displays[0];
  if (!primary) {
    // displays is empty — caller should never reach here, but be safe.
    throw new Error('ownDisplay: empty displays array');
  }
  const center: Electron.Point = {
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2),
  };
  return findDisplayForPoint(displays, center) ?? primary;
}
