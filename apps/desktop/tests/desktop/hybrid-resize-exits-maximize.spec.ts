/**
 * Main-driven resize vs. maximize (peek 1a47dc23 + dc649fc3).
 *
 * The page host used to have TWO definitions of "is this maximized":
 *   1. `entry.maximized` on the registry — the documented authority, set only by
 *      the app's own page:maximize/page:unmaximize intent.
 *   2. `hostMaximized(b)` in ipc.ts — a pure-geometry check (bounds exactly ===
 *      workArea) that gated the resize bands, deliberately reading no
 *      cross-module state.
 *
 * They disagreed in both directions, and (2) also meant a maximized host offered
 * no resize at all — you had to drag the window out of maximize FIRST, then
 * resize, two gestures for one intent. (2) is now deleted: geometry doesn't vote,
 * a maximized host IS resizable, and grabbing an edge exits maximize in the same
 * gesture (`exitMaximizeForResize` in ipc.ts).
 *
 * Driven the focus-free way: a WIRED fake host (real `wireHybridContentEvents`
 * installed, so the production input-event handler under test is what runs) plus
 * raw screen-coord mouse `input-event`s emitted on the content WC — the same
 * technique the top-border reveal spec uses. No real OS focus, no timers.
 *
 * Drags target the SOUTH-EAST corner: the top ('n') band deliberately yields to
 * the navbar reveal gesture, so a north drag would assert the wrong thing.
 *
 *   yarn test:grep "Main-driven resize vs maximize"
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitOverlayReady, type Rect } from '../helpers/hybrid-page';

test.describe('Main-driven resize vs maximize @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('hybrid-resize-exits-maximize'));
    void bgWindow;
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  const bridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  /** A host with the REAL wireHybridContentEvents installed — an unwired host has
   *  no input-event listener, so the emitted mouse stream would go nowhere. */
  const makeWiredHost = (bounds: Rect) =>
    app.evaluateMain!((_e, b) => {
      const br = (globalThis as any).__peekHybridOverlayTest;
      return br.makeWiredHybridHost(b) as number;
    }, bounds) as Promise<number>;

  const setActive = (id: number | null) =>
    app.evaluateMain!((_e, wid) => {
      const br = (globalThis as any).__peekHybridOverlayTest;
      return br.setActive(wid) as boolean;
    }, id);

  const hostBounds = (id: number) =>
    app.evaluateMain!((_e, wid) => {
      const br = (globalThis as any).__peekHybridOverlayTest;
      return br.hostBounds(wid) as Rect | null;
    }, id) as Promise<Rect | null>;

  const workArea = (id: number) =>
    app.evaluateMain!((_e, wid) => {
      const br = (globalThis as any).__peekHybridOverlayTest;
      return br.hostWorkArea(wid) as Rect | null;
    }, id) as Promise<Rect | null>;

  const toggleMaximize = (id: number) =>
    app.evaluateMain!((_e, wid) => {
      const br = (globalThis as any).__peekHybridOverlayTest;
      br.requestToggleMaximize(wid);
    }, id);

  /** The REGISTRY's maximize flag — the single definition, and what the resize
   *  start clears. */
  const registryMaximized = (id: number) =>
    app.evaluateMain!((_e, wid) => {
      const br = (globalThis as any).__peekHybridOverlayTest;
      const s = br.hostFullscreenState(wid);
      return s ? { maximized: s.maximized === true, preMaxBounds: s.preMaxBounds } : null;
    }, id) as Promise<{ maximized: boolean; preMaxBounds: Rect | null } | null>;

  /** The OVERLAY renderer's local mirror of that flag. */
  const overlayMaximized = () =>
    app.evaluateMain!(async () => {
      const br = (globalThis as any).__peekHybridOverlayTest;
      const s = await br.overlayMaximizeState();
      return s ? s.maximized === true : null;
    }) as Promise<boolean | null>;

  const mouse = (id: number, type: string, globalX: number, globalY: number) =>
    app.evaluateMain!((_e, a) => {
      const br = (globalThis as any).__peekHybridOverlayTest;
      const arg = a as { wid: number; type: string; gx: number; gy: number };
      return br.emitContentMouse(arg.wid, arg.type, arg.gx, arg.gy) as boolean;
    }, { wid: id, type, gx: globalX, gy: globalY }) as Promise<boolean>;

  /**
   * Drag the SE corner from a host's current bottom-right by (dx, dy). Presses
   * 2px inside the corner so the press lands in the resize band (RESIZE_EDGE_PX
   * 8 / RESIZE_CORNER_PX 16), then moves in two steps and releases — the same
   * down → move → up shape the native stream delivers.
   */
  const dragSouthEastCorner = async (id: number, dx: number, dy: number) => {
    const b = await hostBounds(id);
    if (!b) throw new Error('host has no bounds');
    const sx = b.x + b.width - 2;
    const sy = b.y + b.height - 2;
    expect(await mouse(id, 'mouseDown', sx, sy)).toBe(true);
    await mouse(id, 'mouseMove', sx + Math.round(dx / 2), sy + Math.round(dy / 2));
    await mouse(id, 'mouseMove', sx + dx, sy + dy);
    await mouse(id, 'mouseUp', sx + dx, sy + dy);
  };

  /**
   * THE headline case (dc649fc3): from maximized, one corner drag inward both
   * exits maximize and shrinks the window. Pre-fix the geometry guard made the
   * band inert at the work area, so the press did nothing and the host stayed
   * exactly at `wa`.
   */
  test('a corner drag from maximized exits maximize AND shrinks, in one gesture', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const id = await makeWiredHost({ x: 120, y: 140, width: 720, height: 520 });
    await setActive(id);
    await waitOverlayReady(app);

    const wa = await workArea(id);
    expect(wa).not.toBeNull();

    await toggleMaximize(id);
    await expect.poll(() => hostBounds(id)).toEqual(wa);
    expect((await registryMaximized(id))?.maximized).toBe(true);

    // One gesture: grab the SE corner of the MAXIMIZED host and pull inward.
    await dragSouthEastCorner(id, -200, -150);

    // It actually resized — pre-fix the drag was refused and this stays at `wa`.
    await expect.poll(async () => (await hostBounds(id))?.width).toBe(wa!.width - 200);
    expect((await hostBounds(id))?.height).toBe(wa!.height - 150);

    // ...and the state agrees: no longer maximized, no stashed restore rect.
    const reg = await registryMaximized(id);
    expect(reg?.maximized).toBe(false);
    expect(reg?.preMaxBounds).toBeNull();
  });

  /**
   * The de-sync guard (1a47dc23). The overlay keeps its own copy of the flag for
   * chrome reflow + navbar-drag math; main owns the resize press, so it must push
   * the cleared state over page-overlay:maximize-state. Without that mirror the
   * overlay still believes it's maximized and the NEXT toggle sends
   * page:unmaximize — snapping back to a stale preMaxBounds, which is the
   * "snaps back to a previous size" symptom.
   */
  test('resizing out of maximize leaves the overlay mirror in sync, so the next toggle maximizes', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const id = await makeWiredHost({ x: 130, y: 150, width: 700, height: 500 });
    await setActive(id);
    await waitOverlayReady(app);

    const wa = await workArea(id);
    await toggleMaximize(id);
    await expect.poll(() => hostBounds(id)).toEqual(wa);
    expect(await overlayMaximized()).toBe(true);

    await dragSouthEastCorner(id, -220, -160);
    await expect.poll(async () => (await hostBounds(id))?.width).toBe(wa!.width - 220);

    // The overlay's mirror followed main's clear.
    await expect.poll(() => overlayMaximized()).toBe(false);

    const resized = await hostBounds(id);

    // BEHAVIORAL proof: the next toggle MAXIMIZES (back to the work area). If the
    // mirror were stale it would un-maximize to the pre-max rect instead.
    await toggleMaximize(id);
    await expect.poll(() => hostBounds(id)).toEqual(wa);

    // And that maximize stashed the RESIZED rect — so unmaximize returns to where
    // the user actually left the window, not the rect from before the drag.
    await toggleMaximize(id);
    await expect.poll(() => hostBounds(id)).toEqual(resized);
  });

  /**
   * The inverse disagreement. A window merely SIZED to exactly fill the work area
   * was never maximized by intent (`entry.maximized` false), but the old geometry
   * check called it maximized and silently refused to resize it. Nothing about
   * matching the work area should cost you your resize handles.
   */
  test('a window sized to exactly fill the work area is still resizable', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const id = await makeWiredHost({ x: 140, y: 160, width: 640, height: 480 });
    await setActive(id);
    await waitOverlayReady(app);

    const wa = await workArea(id);
    expect(wa).not.toBeNull();

    // Fill the work area WITHOUT the maximize intent — geometry says "maximized",
    // the registry says it never was.
    await app.evaluateMain!((_e, a) => {
      const br = (globalThis as any).__peekHybridOverlayTest;
      const arg = a as { wid: number; b: Rect };
      br.setHostBounds(arg.wid, arg.b);
    }, { wid: id, b: wa! });
    await expect.poll(() => hostBounds(id)).toEqual(wa);
    expect((await registryMaximized(id))?.maximized).toBe(false);

    // Pre-fix: hostMaximized(b) is true here, the band is inert, nothing moves.
    await dragSouthEastCorner(id, -180, -120);
    await expect.poll(async () => (await hostBounds(id))?.width).toBe(wa!.width - 180);
    expect((await hostBounds(id))?.height).toBe(wa!.height - 120);
  });
});
