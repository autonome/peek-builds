/**
 * Collision push for freeform grid layouts, ported from Firefox Panorama's
 * Items.pushAway / Items.unsquish.
 *
 * Pure geometry: given the rectangles cards had when a drag/resize began and
 * the active card's current rectangle, compute every card's rectangle so
 * nothing overlaps and everything stays inside the bounds.
 *
 *  1. Push: a generation-ordered queue starts at the active card. A card that
 *     overlaps its pusher (both inflated by half the gap) moves along x or y,
 *     whichever axis its centre is further from the pusher's, by the distance
 *     that clears the pusher. It records its pusher and generation and in turn
 *     pushes others. A card whose generation is lower than or equal to the
 *     pusher's is never moved by it.
 *  2. Squish: a pushed card that ends outside the bounds shrinks, together
 *     with the chain of pushers back to the active card, so the chain fits.
 *     The active card is never squished and no card goes below the minimum size.
 *  3. Unsquish: a squished card grows back toward its chosen size (userW/userH
 *     on the start rect, defaulting to w/h), centred and kept inside the
 *     bounds, when that overlaps nothing.
 */

const intersects = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const inflate = (r, by) => ({ x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by });

/**
 * Shift a rectangle (shrinking it first if it is larger than the bounds) so it
 * lies inside the bounds.
 * @param {{x:number,y:number,w:number,h:number}} rect
 * @param {{left:number,top:number,right:number,bottom:number}} bounds
 */
export function clampRect(rect, bounds) {
  const w = Math.min(rect.w, Math.max(0, bounds.right - bounds.left));
  const h = Math.min(rect.h, Math.max(0, bounds.bottom - bounds.top));
  return {
    x: Math.min(Math.max(rect.x, bounds.left), bounds.right - w),
    y: Math.min(Math.max(rect.y, bounds.top), bounds.bottom - h),
    w,
    h
  };
}

/**
 * @param {Array<{x:number,y:number,w:number,h:number,userW?:number,userH?:number,ghost?:boolean}>} startRects
 *   Every card's rectangle at gesture start (the active card included).
 * @param {number} activeIndex - Index in startRects of the dragged/resized card.
 * @param {{x:number,y:number,w:number,h:number}} activeRect - Active card's current rectangle.
 * @param {{bounds?:{left:number,top:number,right:number,bottom:number},gap?:number,minW?:number,minH?:number}} [opts]
 *   Without bounds nothing is squished or unsquished.
 * @returns {Array<{x:number,y:number,w:number,h:number}>} Resulting rectangle per
 *   index; the active card gets activeRect.
 */
export function pushLayout(startRects, activeIndex, activeRect, opts = {}) {
  const { bounds = null, gap = 20, minW = 100, minH = 60 } = opts;
  const buffer = Math.floor(gap / 2);
  const rects = startRects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
  rects[activeIndex] = { x: activeRect.x, y: activeRect.y, w: activeRect.w, h: activeRect.h };

  // ── Push ──
  const generation = rects.map(() => Infinity);
  const pusher = rects.map(() => -1);
  generation[activeIndex] = 0;
  const queue = [activeIndex];
  while (queue.length) {
    const p = queue.shift();
    // A ghost card is pushed like any other but never pushes.
    if (startRects[p].ghost) continue;
    const bb = inflate(rects[p], buffer);
    const bbcx = bb.x + bb.w / 2;
    const bbcy = bb.y + bb.h / 2;
    for (let i = 0; i < rects.length; i++) {
      if (i === p || generation[i] <= generation[p]) continue;
      const box = inflate(rects[i], buffer);
      if (!intersects(box, bb)) continue;
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      if (Math.abs(cx - bbcx) < Math.abs(cy - bbcy)) {
        rects[i].y += cy > bbcy ? bb.y + bb.h - box.y : bb.y - (box.y + box.h);
      } else {
        rects[i].x += cx > bbcx ? bb.x + bb.w - box.x : bb.x - (box.x + box.w);
      }
      generation[i] = generation[p] + 1;
      pusher[i] = p;
      queue.push(i);
    }
  }

  if (!bounds) return rects;

  // ── Squish ──
  const apply = (i, posX, posY, step2X, step2Y, sizeX, sizeY) => {
    if (generation[i] === 0) return;
    const r = rects[i];
    r.w = Math.max(minW, r.w - sizeX);
    r.h = Math.max(minH, r.h - sizeY);
    r.x += posX;
    r.y += posY;
    if (pusher[i] >= 0) {
      apply(pusher[i], posX + step2X, posY + step2Y, step2X, step2Y, sizeX, sizeY);
    }
  };
  for (let i = 0; i < rects.length; i++) {
    const g = generation[i];
    if (g === 0 || g === Infinity) continue;
    const r = rects[i];
    let posX = 0, posY = 0, step2X = 0, step2Y = 0, sizeX = 0, sizeY = 0;
    if (r.x < bounds.left) {
      posX = bounds.left - r.x;
      sizeX = posX / g;
      step2X = -sizeX;
    } else if (r.x + r.w > bounds.right) {
      posX = bounds.right - (r.x + r.w);
      sizeX = -posX / g;
      posX += sizeX;
      step2X = sizeX;
    }
    if (r.y < bounds.top) {
      posY = bounds.top - r.y;
      sizeY = posY / g;
      step2Y = -sizeY;
    } else if (r.y + r.h > bounds.bottom) {
      posY = bounds.bottom - (r.y + r.h);
      sizeY = -posY / g;
      posY += sizeY;
      step2Y = sizeY;
    }
    if (posX || posY || sizeX || sizeY) apply(i, posX, posY, step2X, step2Y, sizeX, sizeY);
  }
  // A chain that cannot shrink further (minimum size) is moved inside instead.
  for (let i = 0; i < rects.length; i++) {
    if (generation[i] === 0 || generation[i] === Infinity) continue;
    rects[i] = clampRect(rects[i], bounds);
  }

  // ── Unsquish ──
  for (let i = 0; i < rects.length; i++) {
    if (i === activeIndex) continue;
    const r = rects[i];
    const s = startRects[i];
    const wantW = Math.min(s.userW ?? s.w, bounds.right - bounds.left);
    const wantH = Math.min(s.userH ?? s.h, bounds.bottom - bounds.top);
    const grown = { x: r.x, y: r.y, w: Math.max(r.w, wantW), h: Math.max(r.h, wantH) };
    grown.x -= (grown.w - r.w) / 2;
    grown.y -= (grown.h - r.h) / 2;
    const fit = clampRect(grown, bounds);
    if (fit.x === r.x && fit.y === r.y && fit.w === r.w && fit.h === r.h) continue;
    const box = inflate(fit, buffer);
    let blocked = false;
    for (let j = 0; j < rects.length; j++) {
      if (j !== i && intersects(box, inflate(rects[j], buffer))) {
        blocked = true;
        break;
      }
    }
    if (!blocked) rects[i] = fit;
  }
  return rects;
}
