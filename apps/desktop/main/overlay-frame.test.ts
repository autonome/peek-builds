/**
 * Unit tests for apps/desktop/main/overlay-frame.ts — the pure chrome-overlay
 * frame geometry extracted from `hybrid-overlay.ts` (window-manager.md §5
 * step 9 Part B, task 2).
 *
 * Covers `expandToOverlayFrame`: the normal gutter-expansion case, the
 * maximized-parity branch (content exactly fills the work area — no gutter),
 * the work-area clamp (peek `06d363fc` — mirrors the OS's keep-on-screen
 * clamp so the computed frame matches the post-show `getBounds()`), and
 * `workArea === null` (screen unavailable — no parity check, no clamp).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { expandToOverlayFrame, OVERLAY_GUTTERS } from './overlay-frame.js';
import type { Rectangle } from './window-state.js';

describe('expandToOverlayFrame — chrome overlay frame geometry', () => {
  it('expands a content rect by the gutters on every side (normal case)', () => {
    // Comfortably clear of every work-area edge so the clamp never engages —
    // this test is about the plain expansion math, not the clamp (below).
    const content: Rectangle = { x: 400, y: 300, width: 800, height: 600 };
    const workArea: Rectangle = { x: 0, y: 0, width: 2000, height: 1200 };
    const frame = expandToOverlayFrame(content, workArea);
    assert.deepStrictEqual(frame, {
      x: content.x - OVERLAY_GUTTERS.left,
      y: content.y - OVERLAY_GUTTERS.top,
      width: content.width + OVERLAY_GUTTERS.left + OVERLAY_GUTTERS.right,
      height: content.height + OVERLAY_GUTTERS.top + OVERLAY_GUTTERS.bottom,
    });
  });

  it('maximized parity: content exactly filling the work area gets NO gutter', () => {
    const workArea: Rectangle = { x: 0, y: 0, width: 1920, height: 1080 };
    const content: Rectangle = { ...workArea };
    const frame = expandToOverlayFrame(content, workArea);
    assert.deepStrictEqual(frame, workArea);
  });

  it('does not take the maximized-parity branch when only some edges match the work area', () => {
    const workArea: Rectangle = { x: 0, y: 0, width: 1920, height: 1080 };
    // Same origin as the work area but not the same size, and far enough from
    // every edge that the clamp doesn't engage either — must still expand.
    const content: Rectangle = { x: 400, y: 300, width: 800, height: 600 };
    const frame = expandToOverlayFrame(content, workArea);
    assert.notDeepStrictEqual(frame, workArea);
    assert.deepStrictEqual(frame, {
      x: 400 - OVERLAY_GUTTERS.left,
      y: 300 - OVERLAY_GUTTERS.top,
      width: 800 + OVERLAY_GUTTERS.left + OVERLAY_GUTTERS.right,
      height: 600 + OVERLAY_GUTTERS.top + OVERLAY_GUTTERS.bottom,
    });
  });

  it('clamps the expanded frame inward at the work-area edges (peek 06d363fc)', () => {
    // Content flush against the top-left of the work area: expanding by the
    // gutters pushes x/y negative (off the work area) — the OS clamps a shown
    // window back on-screen, so the math must mirror that clamp.
    const workArea: Rectangle = { x: 0, y: 0, width: 2000, height: 1200 };
    const content: Rectangle = { x: 0, y: 0, width: 800, height: 600 };
    const frame = expandToOverlayFrame(content, workArea);
    assert.strictEqual(frame.x, workArea.x, 'x clamped to the work-area origin');
    assert.strictEqual(frame.y, workArea.y, 'y clamped to the work-area origin');
    // Width/height are unaffected by the clamp — only the origin moves.
    assert.strictEqual(frame.width, 800 + OVERLAY_GUTTERS.left + OVERLAY_GUTTERS.right);
    assert.strictEqual(frame.height, 600 + OVERLAY_GUTTERS.top + OVERLAY_GUTTERS.bottom);
  });

  it('clamps at the far edge too (frame would overshoot max x/y)', () => {
    const workArea: Rectangle = { x: 0, y: 0, width: 1000, height: 800 };
    // Content flush against the bottom-right corner of the work area.
    const content: Rectangle = { x: 900, y: 700, width: 100, height: 100 };
    const frame = expandToOverlayFrame(content, workArea);
    const maxX = workArea.x + workArea.width - frame.width;
    const maxY = workArea.y + workArea.height - frame.height;
    assert.strictEqual(frame.x, maxX, 'x clamped to the far work-area edge');
    assert.strictEqual(frame.y, maxY, 'y clamped to the far work-area edge');
  });

  it('workArea === null skips maximized parity + clamp, returning the raw gutter expansion', () => {
    const content: Rectangle = { x: 0, y: 0, width: 800, height: 600 };
    const frame = expandToOverlayFrame(content, null);
    assert.deepStrictEqual(frame, {
      x: 0 - OVERLAY_GUTTERS.left,
      y: 0 - OVERLAY_GUTTERS.top,
      width: 800 + OVERLAY_GUTTERS.left + OVERLAY_GUTTERS.right,
      height: 600 + OVERLAY_GUTTERS.top + OVERLAY_GUTTERS.bottom,
    });
  });

  it('OVERLAY_GUTTERS matches the documented canvas-era values', () => {
    assert.deepStrictEqual(OVERLAY_GUTTERS, { left: 218, right: 218, top: 44, bottom: 8 });
  });
});
