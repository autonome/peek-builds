/**
 * Memory HUD size and position: what to open it with, and what to keep.
 *
 * Pure helpers shared by the `hud` command (renderer/index.js) and the HUD
 * page (renderer/hud/hud.js). The page saves its bounds under
 * HUD_BOUNDS_KEY in localStorage; both run on the peek://app origin, so they
 * share one per-profile value. A session restore carries its own bounds for a
 * HUD that was open at quit; the page keeps saving the same value, so the two
 * agree.
 */

export const HUD_BOUNDS_KEY = 'hud:bounds';

export const HUD_DEFAULT_BOUNDS = Object.freeze({ width: 240, height: 420, x: 16, y: 48 });

const MIN_SIZE = 100;

const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * Parse a stored bounds value (JSON string or object). Returns whole-number
 * bounds, or null when missing or unusable.
 */
export function parseSavedBounds(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(isFiniteNumber)) return null;
  if (width < MIN_SIZE || height < MIN_SIZE) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/** Bounds to open the HUD with: the saved ones, else the defaults. */
export function chooseHudBounds(saved) {
  return parseSavedBounds(saved) || { ...HUD_DEFAULT_BOUNDS };
}

/** True when the centre of `bounds` lies inside `displayBounds`. */
export function isCenterOnDisplay(bounds, displayBounds) {
  if (!bounds || !displayBounds) return false;
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  return cx >= displayBounds.x && cx < displayBounds.x + displayBounds.width
    && cy >= displayBounds.y && cy < displayBounds.y + displayBounds.height;
}

/**
 * Bounds the HUD should have, given where it actually is and the display the
 * OS placed it on: unchanged when its centre is on that display, else the
 * default position (keeping the current size).
 */
export function visibleHudBounds(current, displayBounds) {
  if (isCenterOnDisplay(current, displayBounds)) return current;
  return {
    ...HUD_DEFAULT_BOUNDS,
    width: current?.width ?? HUD_DEFAULT_BOUNDS.width,
    height: current?.height ?? HUD_DEFAULT_BOUNDS.height,
  };
}

/** True when two bounds differ in any field. */
export function boundsChanged(a, b) {
  if (!a || !b) return true;
  return a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height;
}
