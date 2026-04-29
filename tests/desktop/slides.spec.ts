import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

// Slides feature contract — tests for the surface area that's not covered
// by the generic transient-on-blur autoclose:
//
//   1. screenEdge: 'Up'|'Down'|'Left'|'Right' anchors the window to the
//      corresponding work-area edge, perpendicular-axis centered. Main
//      process owns placement (renderer no longer computes x/y); test
//      drives the window-open pipeline directly with the same params
//      slides emit.
//
//   2. The slides identity contract is `key = ${address}:${screenEdge}`.
//      Re-invoking with the same key reuses the existing window (same
//      BrowserWindow id); changing the edge produces a different window.
//
// Close-on-blur is covered generically by transient-on-blur.spec.ts —
// slides have role: 'quick-view', which is in TRANSIENT_ROLES, so the
// general autoclose loop fires when any non-utility window focuses next.

test.describe('Slides @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('slides'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('add slides and test they work', async () => {
    // Add multiple addresses to use as slides
    const urls = [
      'https://slide1.example.com',
      'https://slide2.example.com',
      'https://slide3.example.com'
    ];

    for (const url of urls) {
      const result = await bgWindow.evaluate(async (uri: string) => {
        return await (window as any).app.datastore.addAddress(uri, {
          title: `Slide: ${uri}`,
          starred: 1
        });
      }, url);
      expect(result.success).toBe(true);
    }

    // Verify slides feature is registered (v3 strict registry)
    const runningExts = await bgWindow.evaluate(async () => {
      return await (window as any).app.features.list('builtin');
    });
    const slidesRunning = runningExts.entries?.some((ext: any) => ext.id === 'slides');
    expect(slidesRunning).toBe(true);

    // Query addresses to verify they were added
    const queryResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.queryAddresses({ starred: 1, limit: 10 });
    });
    expect(queryResult.success).toBe(true);
    expect(queryResult.data.length).toBeGreaterThanOrEqual(3);
  });

  // ── Edge-anchor placement ──────────────────────────────────────────────

  /**
   * Open a slide-style window mimicking what features/slides/background.js
   * passes to api.window.open: role 'quick-view', modal panel, key-identity,
   * with the given screenEdge.
   */
  async function openSlide(screenEdge: string, address: string): Promise<number> {
    const result = await bgWindow.evaluate(async (args: { edge: string; addr: string }) => {
      return await (window as any).app.window.open('about:blank', {
        role: 'quick-view',
        address: args.addr,
        modal: true,
        type: 'panel',
        width: 600,
        height: 400,
        key: `${args.addr}:${args.edge}`,
        screenEdge: args.edge,
      });
    }, { edge: screenEdge, addr: address });
    if (!result.success) {
      throw new Error(`slide open failed for edge=${screenEdge}: ${JSON.stringify(result)}`);
    }
    return result.id as number;
  }

  /** Read a window's current bounds via the main process. */
  async function getBounds(windowId: number): Promise<{ x: number; y: number; width: number; height: number } | null> {
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    return await app.evaluateMain<{ x: number; y: number; width: number; height: number } | null, number>(
      ({ BrowserWindow }, wid) => {
        const w = BrowserWindow.fromId(wid);
        return w && !w.isDestroyed() ? w.getBounds() : null;
      },
      windowId,
    );
  }

  /** Read the work area of the display the cursor is on (matches main's pickCursorOrPrimaryDisplay). */
  async function getCursorWorkArea(): Promise<{ x: number; y: number; width: number; height: number }> {
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    return await app.evaluateMain<{ x: number; y: number; width: number; height: number }>(
      ({ screen }) => {
        const cursor = screen.getCursorScreenPoint();
        const display = screen.getDisplayNearestPoint(cursor);
        return display.workArea;
      },
    );
  }

  async function closeWindow(windowId: number): Promise<void> {
    try {
      await bgWindow.evaluate(async (wid: number) => {
        await (window as any).app.window.close(wid);
      }, windowId);
    } catch { /* ignore */ }
  }

  test('Up screenEdge anchors to top, X-centered on cursor display', async () => {
    const id = await openSlide('Up', 'https://slide-up.example.com');
    const bounds = await getBounds(id);
    const work = await getCursorWorkArea();
    expect(bounds).not.toBeNull();
    expect(bounds!.y).toBe(work.y);
    expect(bounds!.x).toBe(work.x + Math.round((work.width - bounds!.width) / 2));
    await closeWindow(id);
  });

  test('Down screenEdge anchors to bottom, X-centered on cursor display', async () => {
    const id = await openSlide('Down', 'https://slide-down.example.com');
    const bounds = await getBounds(id);
    const work = await getCursorWorkArea();
    expect(bounds).not.toBeNull();
    expect(bounds!.y).toBe(work.y + work.height - bounds!.height);
    expect(bounds!.x).toBe(work.x + Math.round((work.width - bounds!.width) / 2));
    await closeWindow(id);
  });

  test('Left screenEdge anchors to left, Y-centered on cursor display', async () => {
    const id = await openSlide('Left', 'https://slide-left.example.com');
    const bounds = await getBounds(id);
    const work = await getCursorWorkArea();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBe(work.x);
    expect(bounds!.y).toBe(work.y + Math.round((work.height - bounds!.height) / 2));
    await closeWindow(id);
  });

  test('Right screenEdge anchors to right, Y-centered on cursor display', async () => {
    const id = await openSlide('Right', 'https://slide-right.example.com');
    const bounds = await getBounds(id);
    const work = await getCursorWorkArea();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBe(work.x + work.width - bounds!.width);
    expect(bounds!.y).toBe(work.y + Math.round((work.height - bounds!.height) / 2));
    await closeWindow(id);
  });

  // ── key=address:edge identity contract ────────────────────────────────

  test('reopening with the same address+edge reuses the same window', async () => {
    const addr = 'https://slide-identity.example.com';
    const first = await openSlide('Up', addr);
    const second = await openSlide('Up', addr);
    expect(second).toBe(first);
    await closeWindow(first);
  });

  test('opening the same address with a different edge produces a distinct window', async () => {
    const addr = 'https://slide-distinct.example.com';
    const up = await openSlide('Up', addr);
    const down = await openSlide('Down', addr);
    expect(down).not.toBe(up);
    await closeWindow(up);
    await closeWindow(down);
  });
});
