/**
 * Window Placement — Pure Module
 *
 * Single source of truth for "where should this window go?" decisions.
 * Pure function from inputs to output: no `screen.*` calls, no
 * `BrowserWindow.*` references, no Electron runtime imports. The caller
 * is responsible for collecting the current display layout, cursor point,
 * window bounds, and parent bounds, and for applying the result via
 * `setBounds()` (only when `kind === 'reposition'`).
 *
 * This makes display-change behavior unit-testable without real
 * multi-monitor hardware — see window-placement.test.ts.
 *
 * See docs/window-placement-refactor.md for the sprint plan and the
 * full mapping of legacy flags (`center: true`, explicit `x`/`y`,
 * `screenEdge`, parent windows) to `Placement` modes.
 */
//
// NOTE: Type-only imports of `Electron.Display`, `Electron.Rectangle`,
// `Electron.Point` are fine — they're erased at compile time and don't
// pull the Electron runtime into this module. Tests fabricate display
// objects without touching the real `screen` API.

/**
 * Discriminated union describing where a window wants to live.
 *
 * Recorded **once at window-open time** on `windowRegistry.params.placement`
 * and consulted on every reuse / display-change pass thereafter.
 */
export type Placement =
  | { mode: 'centered' }
      // Always centered on the cursor's display, every time the window
      // is shown. cmd panel, modal palettes, "center: true" callers.
  | { mode: 'cursor-display-fallback' }
      // Centered on the cursor display ONLY if no explicit position has
      // been observed yet. Once positioned, stays put across reuse —
      // unless stranded (see below). Page-host default.
  | { mode: 'edge'; edge: 'top' | 'bottom' | 'left' | 'right' }
      // Anchored to one edge of the cursor's display, every show. Slides.
  | { mode: 'parent-centered'; parentId: number }
      // Centered on the parent window's bounds. Quick-views, child dialogs.
  | { mode: 'manual' };
      // User-positioned (drag, manual setBounds). Never auto-moved
      // EXCEPT when stranded.

export interface PlacementInput {
  /** The placement intent recorded at open time. */
  placement: Placement;
  /** Window's bounds right now (used for "is this still placed correctly?" check). */
  currentBounds: Electron.Rectangle;
  /** Desired/intrinsic size — used when computing new bounds. */
  windowSize: { width: number; height: number };
  /** Snapshot of all displays (caller obtains via `screen.getAllDisplays()`). */
  displays: Electron.Display[];
  /** Cursor screen point (caller obtains via `screen.getCursorScreenPoint()`). */
  cursorPoint: Electron.Point;
  /** Required for `parent-centered`. Undefined if parent window has been destroyed. */
  parentBounds?: Electron.Rectangle;
}

export type PlacementResult =
  | { kind: 'no-change' }
  | { kind: 'reposition'; bounds: Electron.Rectangle };

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

/**
 * If a window has less than this fraction of its area on any display, it's
 * considered "stranded" and gets force-rescued to the cursor display
 * regardless of placement mode. Replaces the historical 30% threshold from
 * `display-watcher.ts` and `isWindowAccessibleNow` in `ipc.ts`. Bumped to
 * 50% so we rescue more aggressively — half the window off-screen is
 * effectively unusable.
 */
const STRANDED_THRESHOLD = 0.5;

/**
 * Find the display containing a point. Tries `workArea` first (avoids
 * counting menu-bar / dock zones as "on display"); falls back to `bounds`
 * so that a point in the OS chrome zone still resolves correctly.
 *
 * Returns `null` if the point is not on any display.
 */
function findDisplayForPoint(
  displays: Electron.Display[],
  point: Electron.Point,
): Electron.Display | null {
  for (const d of displays) {
    const wa = d.workArea;
    if (
      point.x >= wa.x && point.x < wa.x + wa.width &&
      point.y >= wa.y && point.y < wa.y + wa.height
    ) {
      return d;
    }
  }
  for (const d of displays) {
    const b = d.bounds;
    if (
      point.x >= b.x && point.x < b.x + b.width &&
      point.y >= b.y && point.y < b.y + b.height
    ) {
      return d;
    }
  }
  return null;
}

/**
 * Pick the cursor's display, with sensible fallbacks. Prefer the display
 * the cursor is on; otherwise the first display marked primary by id (we
 * use bounds.x === 0 && bounds.y === 0 as a heuristic — Electron's
 * `screen.getPrimaryDisplay()` returns the display whose top-left is at
 * (0,0) on macOS); otherwise the first display in the list. Returns
 * `null` only if `displays` is empty.
 */
function pickCursorOrPrimaryDisplay(
  displays: Electron.Display[],
  cursorPoint: Electron.Point,
): Electron.Display | null {
  if (displays.length === 0) return null;
  const onCursor = findDisplayForPoint(displays, cursorPoint);
  if (onCursor) return onCursor;
  const atOrigin = displays.find(d => d.bounds.x === 0 && d.bounds.y === 0);
  return atOrigin ?? displays[0];
}

/**
 * Return the fraction (0..1) of `bounds`' area that overlaps any display's
 * workArea. Zero-size windows are reported as 1 (fully accessible) — they
 * can't be stranded, they're hidden/minimized.
 */
function maxOverlapFraction(
  displays: Electron.Display[],
  bounds: Electron.Rectangle,
): number {
  const area = bounds.width * bounds.height;
  if (area <= 0) return 1;

  let best = 0;
  for (const d of displays) {
    const wa = d.workArea;
    const overlapX = Math.max(bounds.x, wa.x);
    const overlapY = Math.max(bounds.y, wa.y);
    const overlapRight = Math.min(bounds.x + bounds.width, wa.x + wa.width);
    const overlapBottom = Math.min(bounds.y + bounds.height, wa.y + wa.height);
    if (overlapRight > overlapX && overlapBottom > overlapY) {
      const overlap = (overlapRight - overlapX) * (overlapBottom - overlapY);
      const frac = overlap / area;
      if (frac > best) best = frac;
    }
  }
  return best;
}

/** Window has < STRANDED_THRESHOLD area on any display → needs rescue. */
function isStranded(displays: Electron.Display[], bounds: Electron.Rectangle): boolean {
  if (displays.length === 0) return false; // can't rescue if there are no displays
  return maxOverlapFraction(displays, bounds) < STRANDED_THRESHOLD;
}

/**
 * Clamp a desired size to never exceed the workArea. Output dimensions are
 * `min(desired, workArea)` — we never grow a window, only shrink to fit.
 */
function clampSize(
  size: { width: number; height: number },
  workArea: Electron.Rectangle,
): { width: number; height: number } {
  return {
    width: Math.min(size.width, workArea.width),
    height: Math.min(size.height, workArea.height),
  };
}

/** Center a (clamped) size on a workArea. */
function centerOn(
  workArea: Electron.Rectangle,
  size: { width: number; height: number },
): Electron.Rectangle {
  return {
    x: workArea.x + Math.round((workArea.width - size.width) / 2),
    y: workArea.y + Math.round((workArea.height - size.height) / 2),
    width: size.width,
    height: size.height,
  };
}

/** Center a (clamped) size on an arbitrary rectangle (e.g. parent bounds). */
function centerOnRect(
  rect: Electron.Rectangle,
  size: { width: number; height: number },
): Electron.Rectangle {
  return {
    x: rect.x + Math.round((rect.width - size.width) / 2),
    y: rect.y + Math.round((rect.height - size.height) / 2),
    width: size.width,
    height: size.height,
  };
}

/** Anchor a (clamped) size to one edge of a workArea. */
function anchorToEdge(
  workArea: Electron.Rectangle,
  size: { width: number; height: number },
  edge: 'top' | 'bottom' | 'left' | 'right',
): Electron.Rectangle {
  // Design decision (not specified explicitly in plan): for top/bottom we
  // X-center; for left/right we Y-center. The "other axis" defaults to
  // centered on the cursor display. This matches what the slides feature
  // was doing in renderer math before this refactor.
  switch (edge) {
    case 'top':
      return {
        x: workArea.x + Math.round((workArea.width - size.width) / 2),
        y: workArea.y,
        width: size.width,
        height: size.height,
      };
    case 'bottom':
      return {
        x: workArea.x + Math.round((workArea.width - size.width) / 2),
        y: workArea.y + workArea.height - size.height,
        width: size.width,
        height: size.height,
      };
    case 'left':
      return {
        x: workArea.x,
        y: workArea.y + Math.round((workArea.height - size.height) / 2),
        width: size.width,
        height: size.height,
      };
    case 'right':
      return {
        x: workArea.x + workArea.width - size.width,
        y: workArea.y + Math.round((workArea.height - size.height) / 2),
        width: size.width,
        height: size.height,
      };
  }
}

/** Bounds-equality test — used to short-circuit `setBounds()` calls. */
function rectsEqual(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Helper that yields a `PlacementResult`: returns `no-change` when the
 * computed bounds match `currentBounds`, otherwise `reposition`.
 */
function reposeOrNoChange(
  currentBounds: Electron.Rectangle,
  proposed: Electron.Rectangle,
): PlacementResult {
  if (rectsEqual(currentBounds, proposed)) return { kind: 'no-change' };
  return { kind: 'reposition', bounds: proposed };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Decide where a window should go, given its placement intent + current
 * display layout + cursor.
 *
 * Contract:
 * - Pure. No global state, no Electron runtime calls.
 * - Returns `{ kind: 'no-change' }` if the window is already correctly
 *   placed for its mode → caller skips `setBounds()`.
 * - For every mode, "stranded" rescue takes priority: if `currentBounds`
 *   has less than 50% area overlap with any display, ALWAYS reposition
 *   to the cursor display center, regardless of mode. (Replaces the old
 *   `isWindowAccessibleNow` + `repositionOnCursorDisplay` helpers.)
 * - Output bounds are always clamped so width/height never exceed the
 *   chosen display's workArea.
 * - If `displays` is empty, returns `no-change` — there's nowhere to
 *   reposition to. Caller should treat this as "wait until displays
 *   come back."
 */
export function computePlacement(input: PlacementInput): PlacementResult {
  const { placement, currentBounds, windowSize, displays, cursorPoint, parentBounds } = input;

  // No displays at all → nothing we can do. Early out before anything else.
  if (displays.length === 0) return { kind: 'no-change' };

  // -------------------------------------------------------------------------
  // Stranded-rescue path (priority over every mode, including 'manual').
  // If the window is currently <50% on any display, force-reposition to the
  // cursor display center using the requested windowSize. This unifies what
  // the old `isWindowAccessibleNow` did for general windows with what the
  // `center: true` rescue did for cmd-style windows.
  // -------------------------------------------------------------------------
  if (isStranded(displays, currentBounds)) {
    const target = pickCursorOrPrimaryDisplay(displays, cursorPoint);
    if (!target) return { kind: 'no-change' }; // unreachable given displays.length>0
    const size = clampSize(windowSize, target.workArea);
    const proposed = centerOn(target.workArea, size);
    return reposeOrNoChange(currentBounds, proposed);
  }

  // -------------------------------------------------------------------------
  // Per-mode placement.
  // -------------------------------------------------------------------------
  switch (placement.mode) {

    case 'centered': {
      // Always re-center on the cursor display, every call. cmd panel
      // semantics — follow the user.
      const target = pickCursorOrPrimaryDisplay(displays, cursorPoint);
      if (!target) return { kind: 'no-change' };
      const size = clampSize(windowSize, target.workArea);
      const proposed = centerOn(target.workArea, size);
      return reposeOrNoChange(currentBounds, proposed);
    }

    case 'cursor-display-fallback': {
      // "Center on cursor display only if not yet placed." We approximate
      // "not yet placed" as "currentBounds happen to match what cursor-
      // -display-centering would produce" → no change. Otherwise: the
      // window is already positioned somewhere reasonable (we already
      // ruled out stranded above), so leave it.
      //
      // Design decision (not specified explicitly in plan): once a window
      // has any non-default position, we honor it. The stranded path
      // above handles the "display unplugged" case. This matches the
      // page-host behavior we want — open on cursor display, then stay
      // put across reuse.
      return { kind: 'no-change' };
    }

    case 'edge': {
      // Anchor to one edge of the cursor display, every show. Re-anchor
      // when the cursor moves to a different display.
      const target = pickCursorOrPrimaryDisplay(displays, cursorPoint);
      if (!target) return { kind: 'no-change' };
      const size = clampSize(windowSize, target.workArea);
      const proposed = anchorToEdge(target.workArea, size, placement.edge);
      return reposeOrNoChange(currentBounds, proposed);
    }

    case 'parent-centered': {
      // If parent bounds were not provided (parent destroyed), fall
      // through to cursor-display-fallback semantics: leave the window
      // alone unless stranded (which we already handled). Design decision
      // confirmed in the plan doc.
      if (!parentBounds) {
        return { kind: 'no-change' };
      }
      // Center on parent. Clamp to the display that contains the parent's
      // center; if no display contains it, fall back to cursor display.
      const parentCenter: Electron.Point = {
        x: parentBounds.x + Math.round(parentBounds.width / 2),
        y: parentBounds.y + Math.round(parentBounds.height / 2),
      };
      const targetDisplay =
        findDisplayForPoint(displays, parentCenter) ??
        pickCursorOrPrimaryDisplay(displays, cursorPoint);
      if (!targetDisplay) return { kind: 'no-change' };
      const size = clampSize(windowSize, targetDisplay.workArea);
      const proposed = centerOnRect(parentBounds, size);
      return reposeOrNoChange(currentBounds, proposed);
    }

    case 'manual': {
      // User-positioned. Never auto-move (stranded already handled).
      return { kind: 'no-change' };
    }
  }
}

// ---------------------------------------------------------------------------
// Fresh-window helper
// ---------------------------------------------------------------------------

/**
 * Compute initial bounds for a window that doesn't yet exist (no
 * `currentBounds` available). Used by the fresh-open path in `ipc.ts` to
 * derive `winOptions.x/y/width/height` BEFORE `new BrowserWindow()`.
 *
 * Unlike `computePlacement`, this never returns `no-change` — there's no
 * "current bounds" to compare against. It always produces a concrete
 * `Rectangle`, computed against the cursor / parent / edge per the
 * placement intent.
 *
 * Modes:
 * - `centered` and `cursor-display-fallback` both center on the cursor
 *   display (for fresh opens, "fallback" reduces to "cursor center" since
 *   no caller-supplied position exists at this stage).
 * - `edge` anchors to the requested edge of the cursor display.
 * - `parent-centered` centers on `parentBounds`. If no `parentBounds`
 *   provided (parent destroyed mid-flight), falls back to cursor center.
 * - `manual` should never reach here in practice — manual placement means
 *   the caller already supplied x/y. We treat it as cursor center as a
 *   safety fallback rather than throwing.
 *
 * Returns a workArea-clamped `Rectangle`. If `displays` is empty, returns
 * a rect at (0,0) with the requested size — caller is presumably running
 * headless and the bounds will be ignored.
 */
export function computeInitialBounds(
  placement: Placement,
  size: { width: number; height: number },
  displays: Electron.Display[],
  cursorPoint: Electron.Point,
  parentBounds?: Electron.Rectangle,
): Electron.Rectangle {
  if (displays.length === 0) {
    return { x: 0, y: 0, width: size.width, height: size.height };
  }

  switch (placement.mode) {
    case 'centered':
    case 'cursor-display-fallback':
    case 'manual': {
      const target = pickCursorOrPrimaryDisplay(displays, cursorPoint)!;
      const clamped = clampSize(size, target.workArea);
      return centerOn(target.workArea, clamped);
    }

    case 'edge': {
      const target = pickCursorOrPrimaryDisplay(displays, cursorPoint)!;
      const clamped = clampSize(size, target.workArea);
      return anchorToEdge(target.workArea, clamped, placement.edge);
    }

    case 'parent-centered': {
      if (!parentBounds) {
        const target = pickCursorOrPrimaryDisplay(displays, cursorPoint)!;
        const clamped = clampSize(size, target.workArea);
        return centerOn(target.workArea, clamped);
      }
      const parentCenter: Electron.Point = {
        x: parentBounds.x + Math.round(parentBounds.width / 2),
        y: parentBounds.y + Math.round(parentBounds.height / 2),
      };
      const targetDisplay =
        findDisplayForPoint(displays, parentCenter) ??
        pickCursorOrPrimaryDisplay(displays, cursorPoint)!;
      const clamped = clampSize(size, targetDisplay.workArea);
      return centerOnRect(parentBounds, clamped);
    }
  }
}
