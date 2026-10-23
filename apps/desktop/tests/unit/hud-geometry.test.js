import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HUD_DEFAULT_BOUNDS, parseSavedBounds, chooseHudBounds, isCenterOnDisplay,
  visibleHudBounds, boundsChanged,
} from '../../renderer/lib/hud-geometry.js';

const display = { x: 0, y: 0, width: 1440, height: 900 };

test('fresh profile opens with the default bounds', () => {
  assert.deepEqual(chooseHudBounds(null), { width: 240, height: 420, x: 16, y: 48 });
  assert.deepEqual(chooseHudBounds(undefined), HUD_DEFAULT_BOUNDS);
});

test('saved bounds (object or JSON string) win over the defaults', () => {
  const saved = { x: 300, y: 120, width: 320, height: 400 };
  assert.deepEqual(chooseHudBounds(saved), saved);
  assert.deepEqual(chooseHudBounds(JSON.stringify(saved)), saved);
});

test('unusable saved values fall back to the defaults', () => {
  for (const bad of ['not json', '{}', { x: 1, y: 2 }, { x: 1, y: 2, width: 'a', height: 5 },
    { x: NaN, y: 0, width: 200, height: 200 }, { x: 0, y: 0, width: 10, height: 10 }]) {
    assert.deepEqual(chooseHudBounds(bad), HUD_DEFAULT_BOUNDS);
  }
});

test('fractional saved values are rounded', () => {
  assert.deepEqual(parseSavedBounds({ x: 1.4, y: 2.6, width: 200.2, height: 300.7 }),
    { x: 1, y: 3, width: 200, height: 301 });
});

test('isCenterOnDisplay', () => {
  assert.equal(isCenterOnDisplay({ x: 10, y: 10, width: 200, height: 200 }, display), true);
  assert.equal(isCenterOnDisplay({ x: 5000, y: 10, width: 200, height: 200 }, display), false);
  assert.equal(isCenterOnDisplay({ x: -300, y: 10, width: 200, height: 200 }, display), false);
});

test('an on-screen HUD is left alone; an off-screen one returns to the default spot, keeping its size', () => {
  const on = { x: 400, y: 300, width: 300, height: 350 };
  assert.equal(visibleHudBounds(on, display), on);
  assert.deepEqual(visibleHudBounds({ x: 9000, y: 9000, width: 300, height: 350 }, display),
    { x: 16, y: 48, width: 300, height: 350 });
});

test('boundsChanged', () => {
  const a = { x: 1, y: 2, width: 3, height: 4 };
  assert.equal(boundsChanged(a, { ...a }), false);
  assert.equal(boundsChanged(a, { ...a, x: 2 }), true);
  assert.equal(boundsChanged(a, null), true);
});
