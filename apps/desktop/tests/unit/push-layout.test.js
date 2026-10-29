import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushLayout } from '../../renderer/lib/push-layout.js';

const r = (x, y, w, h, extra = {}) => ({ x, y, w, h, ...extra });

test('no overlap moves nothing', () => {
  const start = [r(0, 0, 100, 100), r(200, 0, 100, 100)];
  const out = pushLayout(start, 0, r(0, 50, 100, 100));
  assert.deepEqual(out, [r(0, 50, 100, 100), r(200, 0, 100, 100)]);
});

test('touching edges is not an overlap', () => {
  const start = [r(0, 0, 100, 100), r(0, 100, 100, 100)];
  const out = pushLayout(start, 0, r(0, 0, 100, 100));
  assert.equal(out[1].y, 100);
});

test('an overlapped card is pushed straight down below the active card', () => {
  const start = [r(0, 0, 100, 100), r(0, 300, 100, 100)];
  const out = pushLayout(start, 0, r(0, 250, 100, 100));
  assert.deepEqual(out[1], r(0, 350, 100, 100));
});

test('pushes cascade through cards the pushed card then overlaps', () => {
  const start = [r(0, 0, 100, 100), r(0, 100, 100, 100), r(0, 200, 100, 100)];
  const out = pushLayout(start, 0, r(0, 50, 100, 100));
  assert.equal(out[1].y, 150);
  assert.equal(out[2].y, 250);
});

test('a ghost card is pushed but never pushes', () => {
  const start = [r(0, 0, 100, 100), r(0, 100, 100, 100, { ghost: true }), r(0, 150, 100, 100)];
  const out = pushLayout(start, 0, r(0, 50, 100, 100));
  assert.equal(out[1].y, 150);
  assert.equal(out[2].y, 150);
});

test('pushes are computed from gesture-start positions', () => {
  const start = [r(0, 0, 100, 100), r(0, 100, 100, 100)];
  const pushed = pushLayout(start, 0, r(0, 50, 100, 100));
  assert.equal(pushed[1].y, 150);
  const back = pushLayout(start, 0, r(300, 50, 100, 100));
  assert.equal(back[1].y, 100);
});
