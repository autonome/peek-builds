/**
 * Resize a rectangle while keeping its width:height ratio.
 *
 * Pure math for peek-grid's freeform resize of cards that carry a ratio (image
 * cards). Side handles drive the size from the dragged axis, corner handles from
 * whichever axis changed more; the opposite edge or corner stays anchored.
 */

/**
 * @param {object} p
 * @param {string} p.edge - handle: n s e w ne nw se sw
 * @param {{x:number,y:number,w:number,h:number}} p.orig - rectangle at gesture start
 * @param {number} p.w - requested width (unlocked)
 * @param {number} p.h - requested height (unlocked)
 * @param {number} p.ratio - width / height to keep
 * @param {number} [p.minW]
 * @param {number} [p.minH]
 * @param {{left:number,top:number,right:number,bottom:number}} [p.bounds] - area the card must stay inside
 * @returns {{x:number,y:number,w:number,h:number}} whole-pixel rectangle at exactly the ratio (to rounding)
 */
export function lockAspectResize({ edge, orig, w, h, ratio, minW = 0, minH = 0, bounds = null }) {
  const hasE = edge.includes('e');
  const hasW = edge.includes('w');
  const hasN = edge.includes('n');
  const hasS = edge.includes('s');
  const horizontal = hasE || hasW;
  const vertical = hasN || hasS;

  // Width the ratio asks for, from the axis that drives.
  let nextW;
  if (horizontal && vertical) {
    const dw = Math.abs(w - orig.w) / orig.w;
    const dh = Math.abs(h - orig.h) / orig.h;
    nextW = dw >= dh ? w : h * ratio;
  } else if (vertical) {
    nextW = h * ratio;
  } else {
    nextW = w;
  }
  let nextH = nextW / ratio;

  if (bounds) {
    const right = orig.x + orig.w;
    const bottom = orig.y + orig.h;
    const maxW = hasW ? right - bounds.left : bounds.right - orig.x;
    const maxH = hasN ? bottom - bounds.top : bounds.bottom - orig.y;
    if (nextW > maxW) { nextW = maxW; nextH = nextW / ratio; }
    if (nextH > maxH) { nextH = maxH; nextW = nextH * ratio; }
  }

  // Minimums win over bounds: grow along the ratio until both are met.
  if (nextW < minW) { nextW = minW; nextH = nextW / ratio; }
  if (nextH < minH) { nextH = minH; nextW = nextH * ratio; }

  const outW = Math.round(nextW);
  const outH = Math.round(nextH);
  return {
    x: hasW ? orig.x + orig.w - outW : orig.x,
    y: hasN ? orig.y + orig.h - outH : orig.y,
    w: outW,
    h: outH
  };
}

/**
 * Whether `rect` overlaps none of `others` (touching edges do not overlap).
 * Used to apply a ratio snap only when it would not put cards on top of each other.
 * @param {{x:number,y:number,w:number,h:number}} rect
 * @param {Array<{x:number,y:number,w:number,h:number}>} others
 */
export function clearOfRects(rect, others) {
  return !others.some((o) =>
    rect.x < o.x + o.w && o.x < rect.x + rect.w &&
    rect.y < o.y + o.h && o.y < rect.y + rect.h);
}

/** Height that gives width `w` the ratio (width / height). */
export function heightForRatio(w, ratio) {
  return Math.round(w / ratio);
}
