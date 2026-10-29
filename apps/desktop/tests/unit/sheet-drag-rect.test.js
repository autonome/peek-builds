/**
 * Unit tests for features/sheets/drag-rect.js (pure leaf module).
 *
 * Run via: node --test tests/unit/sheet-drag-rect.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  DRAG_THRESHOLD, MIN_CARD_W, MIN_CARD_H, isDrag, rectFromPoints, dragRectToGrid
} from '../../features/sheets/drag-rect.js';

describe('isDrag', () => {
  it('treats small travel as a click', () => {
    assert.equal(isDrag({ x: 10, y: 10 }, { x: 14, y: 13 }), false);
    assert.equal(isDrag({ x: 10, y: 10 }, { x: 10, y: 10 }), false);
  });
  it('treats travel at the threshold on either axis as a drag', () => {
    assert.equal(isDrag({ x: 0, y: 0 }, { x: DRAG_THRESHOLD, y: 0 }), true);
    assert.equal(isDrag({ x: 0, y: 0 }, { x: 0, y: -DRAG_THRESHOLD }), true);
  });
});

describe('rectFromPoints', () => {
  it('normalizes any drag direction', () => {
    const expected = { x: 10, y: 20, w: 30, h: 40 };
    assert.deepEqual(rectFromPoints({ x: 10, y: 20 }, { x: 40, y: 60 }), expected);
    assert.deepEqual(rectFromPoints({ x: 40, y: 60 }, { x: 10, y: 20 }), expected);
    assert.deepEqual(rectFromPoints({ x: 40, y: 20 }, { x: 10, y: 60 }), expected);
  });
});

describe('dragRectToGrid', () => {
  it('translates by the grid origin and snaps', () => {
    const r = dragRectToGrid({ x: 134, y: 156 }, { x: 354, y: 296 }, { x: 24, y: 50 }, { snap: 20 });
    assert.deepEqual(r, { x: 120, y: 100, w: 220, h: 140 });
  });
  it('raises a small rectangle to the minimum size', () => {
    const r = dragRectToGrid({ x: 100, y: 100 }, { x: 120, y: 115 }, { x: 0, y: 0 }, { snap: 20 });
    assert.equal(r.w, MIN_CARD_W);
    assert.equal(r.h, MIN_CARD_H);
    assert.equal(r.x, 100);
    assert.equal(r.y, 100);
  });
  it('keeps the rectangle inside the bounds', () => {
    const bounds = { left: 0, top: 0, right: 400, bottom: 300 };
    const r = dragRectToGrid({ x: 380, y: 280 }, { x: 600, y: 500 }, { x: 0, y: 0 }, { snap: 20, bounds });
    assert.ok(r.x + r.w <= 400);
    assert.ok(r.y + r.h <= 300);
    assert.ok(r.x >= 0 && r.y >= 0);
  });
  it('does not snap when snapping is off', () => {
    const r = dragRectToGrid({ x: 11, y: 13 }, { x: 211, y: 193 }, { x: 0, y: 0 });
    assert.deepEqual(r, { x: 11, y: 13, w: 200, h: 180 });
  });
});
