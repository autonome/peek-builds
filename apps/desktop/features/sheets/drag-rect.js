/**
 * Pure math for drawing a new card's rectangle by dragging on empty sheet space.
 *
 * Pointer positions are viewport coordinates; the result is in grid
 * coordinates (relative to the grid's content origin), snapped like a moved card.
 */

/** Pointer travel (px) below which a press-and-release is a plain click. */
export const DRAG_THRESHOLD = 8;

/** Smallest card size; matches the minimum in renderer/components/peek-grid.js. */
export const MIN_CARD_W = 100;
export const MIN_CARD_H = 60;

/** True when the pointer moved far enough from `start` to count as a drag. */
export function isDrag(start, end, threshold = DRAG_THRESHOLD) {
  return Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y)) >= threshold;
}

/** Normalized rectangle spanning two pointer positions, whichever corner is first. */
export function rectFromPoints(start, end) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    w: Math.abs(end.x - start.x),
    h: Math.abs(end.y - start.y)
  };
}

const snapTo = (value, snap) => (snap ? Math.round(value / snap) * snap : value);

/**
 * Pointer start/end (viewport px) to the new card's rectangle in grid
 * coordinates: translated by `origin`, snapped, raised to the minimum size and
 * kept inside `bounds` when given.
 * @param {{x:number,y:number}} start
 * @param {{x:number,y:number}} end
 * @param {{x:number,y:number}} origin - Viewport position of the grid's origin.
 * @param {{snap?:number,minW?:number,minH?:number,bounds?:{left:number,top:number,right:number,bottom:number}}} [opts]
 */
export function dragRectToGrid(start, end, origin, opts = {}) {
  const { snap = 0, minW = MIN_CARD_W, minH = MIN_CARD_H, bounds } = opts;
  const r = rectFromPoints(start, end);
  let x = snapTo(r.x - origin.x, snap);
  let y = snapTo(r.y - origin.y, snap);
  let w = Math.max(minW, snapTo(r.w, snap));
  let h = Math.max(minH, snapTo(r.h, snap));
  if (bounds) {
    w = Math.min(w, Math.max(minW, bounds.right - bounds.left));
    h = Math.min(h, Math.max(minH, bounds.bottom - bounds.top));
    x = Math.min(Math.max(x, bounds.left), Math.max(bounds.left, bounds.right - w));
    y = Math.min(Math.max(y, bounds.top), Math.max(bounds.top, bounds.bottom - h));
  }
  return { x, y, w, h };
}
