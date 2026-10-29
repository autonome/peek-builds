import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findNearestInDirection, isEditableTarget } from '../../renderer/lib/grid-nav.js';

const r = (left, top, width = 100, height = 100) => ({ left, top, width, height });

test('picks the nearest card in each direction', () => {
  const rects = [r(200, 200), r(400, 200), r(0, 200), r(200, 0), r(200, 400)];
  assert.equal(findNearestInDirection(rects, 0, 'right'), 1);
  assert.equal(findNearestInDirection(rects, 0, 'left'), 2);
  assert.equal(findNearestInDirection(rects, 0, 'up'), 3);
  assert.equal(findNearestInDirection(rects, 0, 'down'), 4);
});

test('returns -1 when nothing lies that way', () => {
  const rects = [r(0, 0), r(200, 0)];
  assert.equal(findNearestInDirection(rects, 0, 'left'), -1);
  assert.equal(findNearestInDirection(rects, 0, 'up'), -1);
  assert.equal(findNearestInDirection(rects, 1, 'right'), -1);
});

test('prefers a card straight ahead over a nearer one off to the side', () => {
  const rects = [r(0, 0), r(150, 120), r(300, 0)];
  assert.equal(findNearestInDirection(rects, 0, 'right'), 2);
});

test('works for staggered free-placed cards', () => {
  const rects = [r(0, 0), r(130, 300), r(40, 180)];
  assert.equal(findNearestInDirection(rects, 0, 'down'), 2);
  assert.equal(findNearestInDirection(rects, 2, 'down'), 1);
});

test('bad from index returns -1', () => {
  assert.equal(findNearestInDirection([r(0, 0)], 3, 'down'), -1);
});

test('isEditableTarget recognises text-entry elements only', () => {
  assert.equal(isEditableTarget({ tagName: 'INPUT' }), true);
  assert.equal(isEditableTarget({ tagName: 'textarea' }), true);
  assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isEditableTarget({ tagName: 'PEEK-CARD' }), false);
  assert.equal(isEditableTarget(null), false);
});
