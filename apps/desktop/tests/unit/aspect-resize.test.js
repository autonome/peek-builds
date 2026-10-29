/**
 * Unit tests for renderer/lib/aspect-resize.js (pure leaf module).
 *
 * Run via: node --test tests/unit/aspect-resize.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { lockAspectResize, heightForRatio, clearOfRects } from '../../renderer/lib/aspect-resize.js';

describe('clearOfRects', () => {
  const card = { x: 0, y: 0, w: 100, h: 100 };
  it('is clear with no other cards', () => {
    assert.equal(clearOfRects(card, []), true);
  });
  it('is clear when cards only touch', () => {
    assert.equal(clearOfRects(card, [{ x: 100, y: 0, w: 50, h: 50 }, { x: 0, y: 100, w: 50, h: 50 }]), true);
  });
  it('is not clear when a card overlaps', () => {
    assert.equal(clearOfRects(card, [{ x: 50, y: 99, w: 50, h: 50 }]), false);
  });
  it('a taller snap collides with the card below', () => {
    const below = { x: 0, y: 110, w: 100, h: 100 };
    assert.equal(clearOfRects({ ...card, h: 100 }, [below]), true);
    assert.equal(clearOfRects({ ...card, h: 150 }, [below]), false);
  });
});

const orig = { x: 100, y: 50, w: 200, h: 100 }; // ratio 2

describe('lockAspectResize', () => {
  it('east handle sets height from the new width', () => {
    const r = lockAspectResize({ edge: 'e', orig, w: 300, h: 100, ratio: 2 });
    assert.deepEqual(r, { x: 100, y: 50, w: 300, h: 150 });
  });

  it('west handle keeps the right edge fixed', () => {
    const r = lockAspectResize({ edge: 'w', orig, w: 300, h: 100, ratio: 2 });
    assert.deepEqual(r, { x: 0, y: 50, w: 300, h: 150 });
  });

  it('south handle sets width from the new height', () => {
    const r = lockAspectResize({ edge: 's', orig, w: 200, h: 150, ratio: 2 });
    assert.deepEqual(r, { x: 100, y: 50, w: 300, h: 150 });
  });

  it('north handle keeps the bottom edge fixed', () => {
    const r = lockAspectResize({ edge: 'n', orig, w: 200, h: 150, ratio: 2 });
    assert.deepEqual(r, { x: 100, y: 0, w: 300, h: 150 });
  });

  it('corner follows the axis that changed more', () => {
    const wide = lockAspectResize({ edge: 'se', orig, w: 400, h: 110, ratio: 2 });
    assert.deepEqual(wide, { x: 100, y: 50, w: 400, h: 200 });
    const tall = lockAspectResize({ edge: 'se', orig, w: 210, h: 200, ratio: 2 });
    assert.deepEqual(tall, { x: 100, y: 50, w: 400, h: 200 });
  });

  it('north-west corner anchors the south-east corner', () => {
    const r = lockAspectResize({ edge: 'nw', orig, w: 100, h: 90, ratio: 2 });
    assert.deepEqual(r, { x: 200, y: 100, w: 100, h: 50 });
  });

  it('respects minimums along the ratio', () => {
    const r = lockAspectResize({ edge: 'e', orig, w: 10, h: 100, ratio: 2, minW: 40, minH: 60 });
    assert.deepEqual(r, { x: 100, y: 50, w: 120, h: 60 });
  });

  it('shrinks along the ratio to stay inside bounds', () => {
    const bounds = { left: 0, top: 0, right: 500, bottom: 120 };
    const r = lockAspectResize({ edge: 'se', orig, w: 450, h: 100, ratio: 2, bounds });
    assert.deepEqual(r, { x: 100, y: 50, w: 140, h: 70 });
  });

  it('a result already at the ratio is unchanged', () => {
    const r = lockAspectResize({ edge: 'e', orig, w: 200, h: 100, ratio: 2 });
    assert.deepEqual(r, orig);
  });
});

describe('heightForRatio', () => {
  it('rounds to a whole pixel', () => {
    assert.equal(heightForRatio(300, 4 / 3), 225);
    assert.equal(heightForRatio(100, 3), 33);
  });
});
