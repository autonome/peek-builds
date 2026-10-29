import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushLayout, clampRect } from '../../renderer/lib/push-layout.js';

const r = (x, y, w, h, extra = {}) => ({ x, y, w, h, ...extra });
const GAP = 20;
const big = { left: -10000, top: -10000, right: 10000, bottom: 10000 };
const opts = { gap: GAP, minW: 100, minH: 60 };
const overlap = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('no overlap moves nothing', () => {
  const start = [r(0, 0, 100, 100), r(200, 0, 100, 100)];
  const out = pushLayout(start, 0, r(0, 50, 100, 100), { ...opts, bounds: big });
  assert.deepEqual(out, [r(0, 50, 100, 100), r(200, 0, 100, 100)]);
});

test('the active card keeps the rectangle it is given', () => {
  const start = [r(0, 0, 100, 100), r(0, 100, 100, 100)];
  const out = pushLayout(start, 0, r(0, 50, 150, 120), { ...opts, bounds: big });
  assert.deepEqual(out[0], r(0, 50, 150, 120));
});

test('a card more stacked than side by side is pushed vertically', () => {
  const start = [r(0, 0, 100, 100), r(10, 150, 100, 100)];
  const out = pushLayout(start, 0, r(0, 100, 100, 100), { ...opts, bounds: big });
  assert.equal(out[1].x, 10);
  assert.equal(out[1].y, 100 + 100 + GAP);
});

test('a card more side by side than stacked is pushed horizontally', () => {
  const start = [r(0, 0, 100, 100), r(150, 10, 100, 100)];
  const out = pushLayout(start, 0, r(100, 0, 100, 100), { ...opts, bounds: big });
  assert.equal(out[1].y, 10);
  assert.equal(out[1].x, 100 + 100 + GAP);
});

test('a card above or left of the pusher is pushed up or left', () => {
  const up = pushLayout([r(0, 200, 100, 100), r(0, 100, 100, 100)], 0, r(0, 150, 100, 100), {
    ...opts,
    bounds: big
  });
  assert.equal(up[1].y, 150 - GAP - 100);
  const left = pushLayout([r(200, 0, 100, 100), r(100, 0, 100, 100)], 0, r(150, 0, 100, 100), {
    ...opts,
    bounds: big
  });
  assert.equal(left[1].x, 150 - GAP - 100);
});

test('the push is the minimum that leaves a gap', () => {
  const start = [r(0, 0, 100, 100), r(0, 300, 100, 100)];
  const out = pushLayout(start, 0, r(0, 250, 100, 100), { ...opts, bounds: big });
  assert.equal(out[1].y, 350 + GAP);
  // already a full gap away: untouched
  const far = pushLayout(start, 0, r(0, 180, 100, 100), { ...opts, bounds: big });
  assert.equal(far[1].y, 300);
});

test('pushes cascade through cards the pushed card then overlaps', () => {
  const start = [r(0, 0, 100, 100), r(0, 120, 100, 100), r(0, 240, 100, 100)];
  const out = pushLayout(start, 0, r(0, 50, 100, 100), { ...opts, bounds: big });
  assert.equal(out[1].y, 170);
  assert.equal(out[2].y, 290);
});

test('a card of lower or equal generation is not moved by a later one', () => {
  // 1 is pushed right by the active card; 2 sits where 1 lands but is also
  // overlapped by the active card, so it is generation 1 and stays put
  // relative to 1 pushing it.
  const start = [r(0, 0, 100, 100), r(120, 0, 100, 100), r(120, 150, 100, 100)];
  const out = pushLayout(start, 0, r(0, 60, 150, 100), { ...opts, bounds: big });
  assert.ok(!overlap(out[0], out[1]));
  assert.ok(!overlap(out[0], out[2]));
  assert.equal(out[0].x, 0);
  assert.equal(out[0].y, 60);
});

test('a ghost card is pushed but never pushes', () => {
  const start = [r(0, 0, 100, 100), r(0, 120, 100, 100, { ghost: true }), r(0, 250, 100, 100)];
  const out = pushLayout(start, 0, r(0, 50, 100, 100), { ...opts, bounds: big });
  assert.equal(out[1].y, 170);
  assert.equal(out[2].y, 250);
});

test('pushes are computed from gesture-start positions', () => {
  const start = [r(0, 0, 100, 100), r(0, 120, 100, 100)];
  const pushed = pushLayout(start, 0, r(0, 50, 100, 100), { ...opts, bounds: big });
  assert.equal(pushed[1].y, 170);
  const back = pushLayout(start, 0, r(300, 50, 100, 100), { ...opts, bounds: big });
  assert.equal(back[1].y, 120);
});

test('squish keeps pushed cards inside the bounds at an edge', () => {
  const bounds = { left: 0, top: 0, right: 400, bottom: 400 };
  const start = [r(0, 0, 100, 100), r(0, 130, 100, 100), r(0, 260, 100, 120)];
  const out = pushLayout(start, 0, r(0, 100, 100, 100), { ...opts, bounds });
  for (const c of out) {
    assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= 400 && c.y + c.h <= 400, JSON.stringify(c));
    assert.ok(c.w >= 100 && c.h >= 60, JSON.stringify(c));
  }
  assert.deepEqual(out[0], r(0, 100, 100, 100));
  assert.ok(out[2].h < 120);
});

test('squish never goes below the minimum size', () => {
  const bounds = { left: 0, top: 0, right: 400, bottom: 300 };
  const start = [r(0, 0, 100, 100), r(0, 120, 100, 80), r(0, 220, 100, 70)];
  const out = pushLayout(start, 0, r(0, 150, 100, 100), { ...opts, bounds });
  for (const c of out) {
    assert.ok(c.w >= 100 && c.h >= 60, JSON.stringify(c));
    assert.ok(c.y >= 0 && c.y + c.h <= 300, JSON.stringify(c));
  }
});

test('unsquish restores the chosen size when there is room', () => {
  const bounds = { left: 0, top: 0, right: 600, bottom: 600 };
  // squished to 100x60 but its own size is 200x150, nothing nearby
  const start = [r(0, 0, 100, 100), r(300, 300, 100, 60, { userW: 200, userH: 150 })];
  const out = pushLayout(start, 0, r(0, 0, 100, 100), { ...opts, bounds });
  assert.equal(out[1].w, 200);
  assert.equal(out[1].h, 150);
  // grows around its centre
  assert.equal(out[1].x, 250);
  assert.equal(out[1].y, 255);
});

test('unsquish does not grow into a neighbour', () => {
  const bounds = { left: 0, top: 0, right: 600, bottom: 600 };
  const start = [
    r(0, 0, 100, 100),
    r(300, 300, 100, 60, { userW: 200, userH: 150 }),
    r(410, 300, 100, 100)
  ];
  const out = pushLayout(start, 0, r(0, 0, 100, 100), { ...opts, bounds });
  assert.equal(out[1].w, 100);
  assert.equal(out[1].h, 60);
});

test('layout entries without a chosen size keep their size', () => {
  const bounds = { left: 0, top: 0, right: 600, bottom: 600 };
  const start = [r(0, 0, 100, 100), r(300, 300, 150, 90)];
  const out = pushLayout(start, 0, r(0, 0, 100, 100), { ...opts, bounds });
  assert.deepEqual(out[1], r(300, 300, 150, 90));
});

test('clampRect shifts a rectangle inside and shrinks one that is too large', () => {
  const bounds = { left: 0, top: 0, right: 300, bottom: 200 };
  assert.deepEqual(clampRect(r(250, -20, 100, 100), bounds), r(200, 0, 100, 100));
  assert.deepEqual(clampRect(r(0, 0, 500, 100), bounds), r(0, 0, 300, 100));
});
