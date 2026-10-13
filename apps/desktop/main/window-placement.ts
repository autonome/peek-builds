// Pure engine for "where should this window go?": no screen.*/BrowserWindow.* calls, no
// Electron runtime imports. The caller collects the display layout, bounds and parent bounds,
// and applies the result via setBounds() only when kind === 'reposition'.
// Spec: docs/window-placement.md (canonical). A Tauri equivalent will share the same contract.

export type Placement =
  | { mode: 'centered' }
  | { mode: 'edge'; edge: 'top' | 'bottom' | 'left' | 'right' }
  | { mode: 'proportional'; relX: number; relY: number }
  | { mode: 'parent-centered'; parentId: number };

// A size expressed as fractions of the target display's work area, resolved once the
// display is known. `minWidth` is a floor applied before the work-area clamp, so a
// narrow display yields the work-area width rather than the floor.
export interface RelativeSize {
  widthFraction: number;
  heightFraction: number;
  minWidth?: number;
}

// Either a pixel size or a display-relative one. A window open that carries no explicit
// width/height passes the relative form; an explicit size passes pixels and never
// consults the fractions.
export type SizeRequest = { width: number; height: number } | RelativeSize;

export function isRelativeSize(size: SizeRequest): size is RelativeSize {
  return typeof (size as RelativeSize).widthFraction === 'number';
}

// The work area assumed when no display is attached and a relative size has to resolve
// to something. Matches the pixel default that preceded relative sizing, so a
// display-less run keeps its old scale.
const NO_DISPLAY_WORK_AREA = { width: 1024, height: 768 };

// Reads a relative size off an untrusted open request. Anything missing a usable pair of
// fractions is `undefined`, which leaves the caller on its pixel size.
export function parseRelativeSize(value: unknown): RelativeSize | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const widthFraction = Number(raw.widthFraction);
  const heightFraction = Number(raw.heightFraction);
  if (!(widthFraction > 0) || !(heightFraction > 0)) return undefined;
  const minWidth = Number(raw.minWidth);
  return {
    widthFraction,
    heightFraction,
    ...(minWidth > 0 ? { minWidth } : {}),
  };
}

export function resolveRelativeSize(
  relative: RelativeSize,
  workArea: { width: number; height: number },
): { width: number; height: number } {
  const width = Math.round(clamp01(relative.widthFraction) * workArea.width);
  const height = Math.round(clamp01(relative.heightFraction) * workArea.height);
  return {
    width: relative.minWidth === undefined ? width : Math.max(width, relative.minWidth),
    height,
  };
}

function resolveSize(
  size: SizeRequest,
  workArea: { width: number; height: number },
): { width: number; height: number } {
  return isRelativeSize(size) ? resolveRelativeSize(size, workArea) : size;
}

export interface PlacementInput {
  placement: Placement;
  currentBounds: Electron.Rectangle;
  windowSize: { width: number; height: number };
  displays: Electron.Display[];
  primaryDisplayId: number;
  // Required for parent-centered; undefined once the parent has been destroyed.
  parentBounds?: Electron.Rectangle;
}

export type PlacementResult =
  | { kind: 'no-change' }
  | { kind: 'reposition'; bounds: Electron.Rectangle };

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

function rectsEqual(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

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
      // Position is relative to the parent rectangle, not the target display's workArea
      // (that workArea is only used for the size clamp above).
      if (parentBounds) {
        return {
          x: parentBounds.x + Math.round((parentBounds.width - w) / 2),
          y: parentBounds.y + Math.round((parentBounds.height - h) / 2),
          width: w, height: h,
        };
      }
      // Parent destroyed: fall back to centering on the target display.
      return {
        x: wa.x + Math.round((wa.width - w) / 2),
        y: wa.y + Math.round((wa.height - h) / 2),
        width: w, height: h,
      };
    }
  }
}

// Empty `displays` (no monitors attached) returns no-change rather than projecting nowhere;
// callers should treat that as "wait until displays come back."
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

// Empty `displays` returns a rect at (0, 0) with the requested size — caller is presumably
// headless; a relative size resolves against `NO_DISPLAY_WORK_AREA` there.
export function computeInitialBounds(
  placement: Placement,
  size: SizeRequest,
  displays: Electron.Display[],
  primaryDisplayId: number,
  parentBounds?: Electron.Rectangle,
): Electron.Rectangle {
  if (displays.length === 0) {
    const resolved = resolveSize(size, NO_DISPLAY_WORK_AREA);
    return { x: 0, y: 0, width: resolved.width, height: resolved.height };
  }
  const target = pickTargetDisplay(
    placement, undefined, displays, primaryDisplayId, parentBounds,
  );
  return projectBounds(placement, resolveSize(size, target.workArea), target, parentBounds);
}

// Clamped to [0, 1]; an axis with zero free space (window same size as the display) returns 0.
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
