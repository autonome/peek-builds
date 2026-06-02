import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

/**
 * P1.4b-1 — singleton hybrid chrome overlay retarget/follow verification.
 *
 * All active-window changes are driven SYNTHETICALLY through the E2E test
 * bridge (`globalThis.__peekHybridOverlayTest`, installed by hybrid-overlay.ts
 * under E2E_TEST + PEEK_PAGEHOST_HYBRID) — never via real OS focus, so this
 * suite cannot steal the user's window focus. We create real (but headless,
 * opacity-0, never-shown) BaseWindow hosts, register them as hybrid windows,
 * then drive the overlay's retarget/follow logic and read the overlay's bounds.
 *
 * Requires the launch env to carry PEEK_PAGEHOST_HYBRID=1; this describe block
 * skips itself if the bridge isn't present (flag off).
 */
test.describe('Hybrid Chrome Overlay (P1.4b-1) @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('hybrid-overlay'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  const bridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  test('retarget is focus-free: overlay frames A, then B, then hides on null', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const boundsA = { x: 100, y: 120, width: 640, height: 480 };
    const boundsB = { x: 800, y: 200, width: 500, height: 700 };

    const ids = await app.evaluateMain!((_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return {
        a: b.makeFakeHybridWindow((arg as any).boundsA),
        b: b.makeFakeHybridWindow((arg as any).boundsB),
      };
    }, { boundsA, boundsB });

    // Activate A → overlay exists, is shown, framed over A.
    const stateA = await app.evaluateMain!((_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.setActive((arg as any).id);
      return b.overlayState();
    }, { id: ids.a });

    expect(stateA).not.toBeNull();
    expect(stateA.visible).toBe(true);
    expect(stateA.bounds).toEqual(boundsA);

    // Activate B → overlay retargets to B's frame.
    const stateB = await app.evaluateMain!((_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.setActive((arg as any).id);
      return b.overlayState();
    }, { id: ids.b });

    expect(stateB).not.toBeNull();
    expect(stateB.bounds).toEqual(boundsB);
    expect(stateB.visible).toBe(true);
    // Same overlay window — singleton, not a new one per page.
    expect(stateB.id).toBe(stateA.id);

    // Activate null → overlay hides.
    const stateNull = await app.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      b.setActive(null);
      return b.overlayState();
    });

    expect(stateNull).not.toBeNull();
    expect(stateNull.visible).toBe(false);
  });

  test('follows the active host window move/resize (focus-free)', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const start = { x: 50, y: 60, width: 400, height: 300 };
    const moved = { x: 333, y: 222, width: 555, height: 666 };

    const state = await app.evaluateMain!((_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const id = b.makeFakeHybridWindow((arg as any).start);
      b.setActive(id);
      // Programmatic move+resize fires the host's 'move'/'resize' → overlay follows.
      b.setHostBounds(id, (arg as any).moved);
      return b.overlayState();
    }, { start, moved });

    expect(state).not.toBeNull();
    expect(state.bounds).toEqual(moved);
  });

  test('singleton: exactly one overlay window across many active-changes', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const result = await app.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const before = b.browserWindowCount();
      const id1 = b.makeFakeHybridWindow({ x: 10, y: 10, width: 200, height: 200 });
      const id2 = b.makeFakeHybridWindow({ x: 20, y: 20, width: 200, height: 200 });
      const id3 = b.makeFakeHybridWindow({ x: 30, y: 30, width: 200, height: 200 });
      // Flip active many times.
      b.setActive(id1);
      const overlayId1 = b.overlayState()?.id;
      b.setActive(id2);
      const overlayId2 = b.overlayState()?.id;
      b.setActive(id3);
      const overlayId3 = b.overlayState()?.id;
      b.setActive(id1);
      const overlayId4 = b.overlayState()?.id;
      const after = b.browserWindowCount();
      return { before, after, overlayId1, overlayId2, overlayId3, overlayId4 };
    });

    // The overlay id never changes across the flips → one window reused.
    expect(result.overlayId1).toBe(result.overlayId2);
    expect(result.overlayId2).toBe(result.overlayId3);
    expect(result.overlayId3).toBe(result.overlayId4);
    // BrowserWindow count grew by AT MOST one (the overlay) across the whole
    // sequence — the fake hosts are BaseWindows, not BrowserWindows, so they
    // do NOT count. (>= prior test may already have created the overlay, so we
    // assert the delta is 0 or 1, never 2+.)
    expect(result.after - result.before).toBeLessThanOrEqual(1);
  });
});
