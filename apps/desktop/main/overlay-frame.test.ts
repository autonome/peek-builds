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
 *
 * Also covers `revealDelayMs`: how long the top-border hover gesture waits
 * before the navbar covers a page with no room above it (peek `bf879b8c`).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  expandToOverlayFrame,
  OVERLAY_GUTTERS,
  REVEAL_DELAY_MS,
  revealDelayMs,
} from './overlay-frame.js';
import type { Rectangle } from './window-kernel.js';

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

describe('revealDelayMs — top-border reveal dwell (peek bf879b8c)', () => {
  it('delays for a maximized host (bounds equal the work area)', () => {
    const workArea: Rectangle = { x: 0, y: 0, width: 1920, height: 1080 };
    const host: Rectangle = { ...workArea };
    assert.strictEqual(revealDelayMs(host, workArea), REVEAL_DELAY_MS);
  });

  it('delays for a floating host a few px below the work-area top', () => {
    const workArea: Rectangle = { x: 0, y: 0, width: 1920, height: 1080 };
    const host: Rectangle = { x: 300, y: 6, width: 800, height: 600 };
    assert.strictEqual(revealDelayMs(host, workArea), REVEAL_DELAY_MS);
  });

  it('delays right up to a full top gutter of room above the host', () => {
    const workArea: Rectangle = { x: 0, y: 0, width: 1920, height: 1080 };
    const host: Rectangle = { x: 300, y: OVERLAY_GUTTERS.top, width: 800, height: 600 };
    assert.strictEqual(revealDelayMs(host, workArea), REVEAL_DELAY_MS);
  });

  it('reveals at once for a host with more than a top gutter of room above it', () => {
    const workArea: Rectangle = { x: 0, y: 0, width: 1920, height: 1080 };
    const host: Rectangle = { x: 300, y: OVERLAY_GUTTERS.top + 1, width: 800, height: 600 };
    assert.strictEqual(revealDelayMs(host, workArea), 0);
  });

  it('measures room against the work area, not the screen (non-zero work-area y)', () => {
    // A menu bar or top panel pushes the work area down: a host flush with the
    // work-area top has a screen-space y of 25 and still has no room above it.
    const workArea: Rectangle = { x: 0, y: 25, width: 1920, height: 1055 };
    assert.strictEqual(revealDelayMs({ x: 300, y: 25, width: 800, height: 600 }, workArea), REVEAL_DELAY_MS);
    assert.strictEqual(revealDelayMs({ x: 300, y: 60, width: 800, height: 600 }, workArea), REVEAL_DELAY_MS);
    // 25 + 44 = 69 is the last delaying y; one px further down has room.
    assert.strictEqual(revealDelayMs({ x: 300, y: 70, width: 800, height: 600 }, workArea), 0);
  });

  it('delays for a host whose top edge sits above the work area (it has no room either)', () => {
    const workArea: Rectangle = { x: 0, y: 25, width: 1920, height: 1055 };
    const host: Rectangle = { x: 0, y: 0, width: 1920, height: 1080 };
    assert.strictEqual(revealDelayMs(host, workArea), REVEAL_DELAY_MS);
  });

  it('reveals at once when the work area is unavailable (nothing to measure against)', () => {
    assert.strictEqual(revealDelayMs({ x: 0, y: 0, width: 800, height: 600 }, null), 0);
  });

  it('the dwell is the documented 2 seconds', () => {
    assert.strictEqual(REVEAL_DELAY_MS, 2000);
  });
});
