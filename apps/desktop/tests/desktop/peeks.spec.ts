import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Peeks @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('peeks'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('add a peek and test it opens', async () => {
    // Add a peek address to the datastore
    const addResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.datastore.addAddress('https://example.com', {
        title: 'Example Peek',
        description: 'Test peek for smoke tests'
      });
    });
    expect(addResult.success).toBe(true);

    // Verify peeks feature is registered (v3 strict registry)
    const runningExts = await bgWindow.evaluate(async () => {
      return await (window as any).app.features.list('builtin');
    });
    const peeksRunning = runningExts.entries?.some((ext: any) => ext.id === 'peeks');
    expect(peeksRunning).toBe(true);

    // Open a peek window for the address we created
    const peekResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('https://example.com', {
        width: 800,
        height: 600,
        key: 'test-peek'
      });
    });
    expect(peekResult.success).toBe(true);

    // Wait for window to open (getWindow polls)
    const peekWindow = await app.getWindow('example.com', 5000);
    expect(peekWindow).toBeTruthy();

    // Close the peek
    if (peekResult.id) {
      await bgWindow.evaluate(async (id: number) => {
        return await (window as any).app.window.close(id);
      }, peekResult.id);
    }
  });

  // ── Peek placement ─────────────────────────────────────────────────────
  //
  // Peeks must center on the cursor display regardless of size. This locks
  // in the contract that `features/peeks/background.js` passes
  // `center: true`, which the window-open handler maps to
  // `Placement { mode: 'centered' }`. Without that flag, peeks fell through
  // to parent-centered (against the off-screen background tile) or
  // cursor-display-fallback, landing in clearly-not-centered positions.

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

  /** Read the work area of the display the cursor is on. */
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

  test('peek opens centered on the cursor display', async () => {
    // Open a peek with the same params features/peeks/background.js sends:
    // role 'quick-view', modal panel, center: true.
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('about:blank', {
        role: 'quick-view',
        modal: true,
        type: 'panel',
        width: 800,
        height: 600,
        center: true,
        key: 'peek:centered',
      });
    });
    if (!result.success) {
      throw new Error(`peek open failed: ${JSON.stringify(result)}`);
    }

    const bounds = await getBounds(result.id as number);
    const work = await getCursorWorkArea();
    expect(bounds).not.toBeNull();

    // Centered means: window's center matches the work area's center, on
    // both axes, within a 2px tolerance for rounding.
    const expectedX = work.x + Math.round((work.width - bounds!.width) / 2);
    const expectedY = work.y + Math.round((work.height - bounds!.height) / 2);
    expect(Math.abs(bounds!.x - expectedX)).toBeLessThanOrEqual(2);
    expect(Math.abs(bounds!.y - expectedY)).toBeLessThanOrEqual(2);

    // Cleanup
    await bgWindow.evaluate(async (id: number) => {
      await (window as any).app.window.close(id);
    }, result.id as number);
  });
});
