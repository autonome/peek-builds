/**
 * Collision push for freeform grid layouts.
 *
 * Pure geometry: given the rectangles cards had when a drag/resize began and
 * the active card's final rectangle, compute the y each other card must take
 * so nothing overlaps. Cards only ever move down; a pushed card pushes the
 * cards it then overlaps.
 */

const overlaps = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * @param {Array<{x:number,y:number,w:number,h:number,ghost?:boolean}>} startRects
 *   Every card's rectangle at gesture start (the active card included).
 * @param {number} activeIndex - Index in startRects of the dragged/resized card.
 * @param {{x:number,y:number,w:number,h:number}} activeRect - Active card's current rectangle.
 * @returns {Array<{x:number,y:number,w:number,h:number}>} Resulting rectangle per
 *   index; the active card gets activeRect and unmoved cards keep their start rect.
 */
export function pushLayout(startRects, activeIndex, activeRect) {
  const rects = startRects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
  rects[activeIndex] = { ...activeRect };

  const queue = [activeIndex];
  while (queue.length) {
    const p = queue.shift();
    // A ghost card is pushed like any other but never pushes.
    if (startRects[p].ghost) continue;
    for (let i = 0; i < rects.length; i++) {
      if (i === p || i === activeIndex) continue;
      if (!overlaps(rects[p], rects[i])) continue;
      const y = rects[p].y + rects[p].h;
      if (y > rects[i].y) {
        rects[i].y = y;
        queue.push(i);
      }
    }
  }
  return rects;
}
