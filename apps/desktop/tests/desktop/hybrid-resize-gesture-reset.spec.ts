/**
 * A resize gesture must not survive its own release.
 *
 * `wireHybridContentEvents`' input-event handler (ipc.ts) tracks the pointer as
 * ONE `gesture` value (idle | resizing | dragging). It used to be two variables,
 * and the resize half was only ever cleared on `mouseUp` — which is a release the
 * content WC is NOT guaranteed to see. `applyResize` clamps at MIN_RESIZE_W /
 * MIN_RESIZE_H, so a drag that bottoms out stops following the cursor: the frame
 * stays put, the pointer keeps going, and the user's release lands OUTSIDE the
 * host. That `mouseUp` goes to whatever is under the cursor; the resize stays
 * armed forever. The next plain press in the page interior hit-tests to no
 * direction (correctly — it's nowhere near an edge), but the first move still
 * matched the armed resize branch and re-applied the PREVIOUS gesture's anchor.
 * Symptom: the window jumps at the start of an unrelated drag.
 *
 * So this spec deliberately emits a MALFORMED stream — down, move, and NO up —
 * which is why the hole survived: every other resize test drives a well-formed
 * down → move → move → up (`dragSouthEastCorner` in
 * hybrid-resize-exits-maximize.spec.ts) and can never observe it.
 *
 * Same focus-free technique as that spec: a WIRED fake host (the real production
 * handler is what runs) plus raw screen-coord mouse `input-event`s emitted on the
 * content WC. No real OS focus, no timers.
 *
 *   yarn test:grep "resize gesture state"
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitOverlayReady, type Rect } from '../helpers/hybrid-page';

test.describe('Hybrid resize gesture state @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('hybrid-resize-gesture-reset'));
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

  const mouse = (id: number, type: string, globalX: number, globalY: number) =>
    app.evaluateMain!((_e, a) => {
      const br = (globalThis as any).__peekHybridOverlayTest;
      const arg = a as { wid: number; type: string; gx: number; gy: number };
      return br.emitContentMouse(arg.wid, arg.type, arg.gx, arg.gy) as boolean;
    }, { wid: id, type, gx: globalX, gy: globalY }) as Promise<boolean>;

  /**
   * The real sequence. An SE-corner resize is armed and dragged, then the release
   * NEVER ARRIVES (it landed outside the host). A press in the page INTERIOR —
   * far from every band (RESIZE_EDGE_PX 8 / RESIZE_CORNER_PX 16) — plus a move
   * must leave the frame exactly where the resize left it.
   */
  test('a resize whose mouseUp never arrives does not hijack the next interior drag', async () => {
    test.skip(!(await bridgePresent()), 'no overlay bridge in this configuration');

    const id = await makeWiredHost({ x: 120, y: 140, width: 720, height: 520 });
    await setActive(id);
    await waitOverlayReady(app);

    const start = await hostBounds(id);
    expect(start).not.toBeNull();

    // 1. Arm a resize on the SE corner and drag it: press 2px inside the corner.
    const sx = start!.x + start!.width - 2;
    const sy = start!.y + start!.height - 2;
    expect(await mouse(id, 'mouseDown', sx, sy)).toBe(true);
    await mouse(id, 'mouseMove', sx - 100, sy - 80);

    // 2. NO mouseUp — the release landed off-host (the clamped-drag case).
    await expect.poll(async () => (await hostBounds(id))?.width).toBe(start!.width - 100);
    const afterResize = await hostBounds(id);
    expect(afterResize!.height).toBe(start!.height - 80);

    // 3. A plain press in the page INTERIOR (dead centre — no band anywhere near),
    //    then a small move: a hold-to-drag, nothing to do with the last resize.
    const ix = afterResize!.x + Math.round(afterResize!.width / 2);
    const iy = afterResize!.y + Math.round(afterResize!.height / 2);
    expect(await mouse(id, 'mouseDown', ix, iy)).toBe(true);
    await mouse(id, 'mouseMove', ix + 24, iy + 18);

    // 4. The frame did not move. Pre-fix the stale anchor re-entered applyResize
    //    here and the window JUMPED (grew by the interior move's delta against the
    //    corner press point).
    expect(await hostBounds(id)).toEqual(afterResize);

    // And it stays put for the rest of the drag.
    await mouse(id, 'mouseMove', ix + 60, iy + 40);
    await mouse(id, 'mouseUp', ix + 60, iy + 40);
    expect(await hostBounds(id)).toEqual(afterResize);
  });
});
