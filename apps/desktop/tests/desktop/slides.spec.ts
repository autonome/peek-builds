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
// slides open with `modal: true`, which makes them transient, so the
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
        // `show: false` keeps natural WM focus events from firing during
        // open. On Linux/Xvfb a visible new modal panel triggers
        // win.on('focus') which closeOrHideWindow's any other transient
        // sibling, including in-flight loads — about:blank loadURL then
        // rejects with ERR_FAILED. macOS NSPanels never fired natural
        // focus events for show:false windows so this never surfaced
        // there. Tests that need the windows visibly tracked drive that
        // through __peek_test.showWindow.
        show: false,
      });
    }, { edge: screenEdge, addr: address });
    if (!result.success) {
      throw new Error(`slide open failed for edge=${screenEdge}: ${JSON.stringify(result)}`);
    }
    return result.id as number;
  }

  /**
   * Atomically read both the slide window's bounds AND the work area of the
   * display it's actually on. Single main-process evaluate.
   *
   * Why one call: previously this was two `evaluateMain` calls (bounds, then
   * cursor work-area). Display-metrics events firing between the two —
   * common during macOS sleep/wake, brightness changes, multi-display
   * setups — would reposition the window via display-watcher before the
   * second call landed, leaving bounds and work-area off-by-one and
   * occasionally throwing "execution context destroyed". The two-call
   * shape made the test environment-sensitive instead of deterministic.
   *
   * Why display-from-bounds (not from cursor): the slide feature places
   * the window on the cursor's display at create time — after creation,
   * cursor moves are irrelevant; the window's display is fixed. Re-reading
   * the cursor in a separate call could disagree with where the window
   * actually landed (cursor moved between open and read). Using
   * `getDisplayMatching(bounds)` derives the display from the only thing
   * that matters for the assertion: where the window IS.
   */
  async function getSlideAlignment(windowId: number): Promise<{
    bounds: { x: number; y: number; width: number; height: number };
    work: { x: number; y: number; width: number; height: number };
  } | null> {
    if (!app.evaluateMain) throw new Error('evaluateMain not available');
    return await app.evaluateMain<{
      bounds: { x: number; y: number; width: number; height: number };
      work: { x: number; y: number; width: number; height: number };
    } | null, number>(
      ({ BrowserWindow, screen }, wid) => {
        const w = BrowserWindow.fromId(wid);
        if (!w || w.isDestroyed()) return null;
        const bounds = w.getBounds();
        const display = screen.getDisplayMatching(bounds);
        return { bounds, work: display.workArea };
      },
      windowId,
    );
  }

  async function closeWindow(windowId: number): Promise<void> {
    try {
      await bgWindow.evaluate(async (wid: number) => {
        await (window as any).app.window.close(wid);
      }, windowId);
    } catch { /* ignore */ }
  }

  // ── Display-relative default size ──────────────────────────────────────
  //
  // A slide whose item carries neither a remembered resize nor an Options
  // size sends no pixel pair at all. It asks for a share of the work area of
  // whichever display it opens on, and main resolves it there. These are the
  // fractions `features/slides/config.js` sends.
  const SLIDE_RELATIVE = { widthFraction: 0.35, heightFraction: 0.90, minWidth: 800 };

  test('a slide with no size set opens at a share of its display work area', async () => {
    const address = 'https://relative-size.example/';
    const result = await bgWindow.evaluate(async (args: { addr: string; rel: object }) => {
      return await (window as any).app.window.open('about:blank', {
        role: 'quick-view',
        address: args.addr,
        modal: true,
        type: 'panel',
        relativeSize: args.rel,
        key: `${args.addr}:Up`,
        screenEdge: 'Up',
        show: false,
      });
    }, { addr: address, rel: SLIDE_RELATIVE });
    if (!result.success) {
      throw new Error(`slide open failed: ${JSON.stringify(result)}`);
    }

    const alignment = await getSlideAlignment(result.id as number);
    expect(alignment).not.toBeNull();
    const { bounds, work } = alignment!;

    const expectedWidth = Math.min(
      work.width,
      Math.max(Math.round(0.35 * work.width), 800),
    );
    const expectedHeight = Math.min(work.height, Math.round(0.90 * work.height));
    expect(Math.abs(bounds.width - expectedWidth)).toBeLessThanOrEqual(2);
    expect(Math.abs(bounds.height - expectedHeight)).toBeLessThanOrEqual(2);

    // The floor only matters where the work area has room for it.
    expect(bounds.width).toBeGreaterThanOrEqual(Math.min(800, work.width) - 2);

    // Still anchored to the top edge, X-centered, like any Up slide.
    expect(bounds.y).toBe(work.y);
    expect(Math.abs(bounds.x - (work.x + Math.round((work.width - bounds.width) / 2))))
      .toBeLessThanOrEqual(2);

    await closeWindow(result.id as number);
  });

  test('an explicit size still wins over the display-relative one', async () => {
    const address = 'https://explicit-size.example/';
    const result = await bgWindow.evaluate(async (args: { addr: string; rel: object }) => {
      return await (window as any).app.window.open('about:blank', {
        role: 'quick-view',
        address: args.addr,
        modal: true,
        type: 'panel',
        width: 640,
        height: 480,
        relativeSize: args.rel,
        key: `${args.addr}:Up`,
        screenEdge: 'Up',
        show: false,
      });
    }, { addr: address, rel: SLIDE_RELATIVE });
    if (!result.success) {
      throw new Error(`slide open failed: ${JSON.stringify(result)}`);
    }

    const alignment = await getSlideAlignment(result.id as number);
    expect(alignment).not.toBeNull();
    expect(alignment!.bounds.width).toBe(640);
    expect(alignment!.bounds.height).toBe(480);

    await closeWindow(result.id as number);
  });

  test('Up screenEdge anchors to top, X-centered on its display', async () => {
    const id = await openSlide('Up', 'https://slide-up.example.com');
    const got = await getSlideAlignment(id);
    expect(got).not.toBeNull();
    const { bounds, work } = got!;
    expect(bounds.y).toBe(work.y);
    expect(bounds.x).toBe(work.x + Math.round((work.width - bounds.width) / 2));
    await closeWindow(id);
  });

  test('Down screenEdge anchors to bottom, X-centered on its display', async () => {
    const id = await openSlide('Down', 'https://slide-down.example.com');
    const got = await getSlideAlignment(id);
    expect(got).not.toBeNull();
    const { bounds, work } = got!;
    expect(bounds.y).toBe(work.y + work.height - bounds.height);
    expect(bounds.x).toBe(work.x + Math.round((work.width - bounds.width) / 2));
    await closeWindow(id);
  });

  test('Left screenEdge anchors to left, Y-centered on its display', async () => {
    const id = await openSlide('Left', 'https://slide-left.example.com');
    const got = await getSlideAlignment(id);
    expect(got).not.toBeNull();
    const { bounds, work } = got!;
    expect(bounds.x).toBe(work.x);
    expect(bounds.y).toBe(work.y + Math.round((work.height - bounds.height) / 2));
    await closeWindow(id);
  });

  test('Right screenEdge anchors to right, Y-centered on its display', async () => {
    const id = await openSlide('Right', 'https://slide-right.example.com');
    const got = await getSlideAlignment(id);
    expect(got).not.toBeNull();
    const { bounds, work } = got!;
    expect(bounds.x).toBe(work.x + work.width - bounds.width);
    expect(bounds.y).toBe(work.y + Math.round((work.height - bounds.height) / 2));
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
