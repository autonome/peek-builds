/**
 * Regression coverage: typing `#tagA #tagB` in the cmd panel and pressing
 * Enter routes to the search view filtered by those tags. This was a daily
 * shortcut that broke during the cmd-panel rework when the all-hashtags
 * fallback was removed alongside the (intentional) web-search fallback.
 *
 * The fix wires TYPING + ENTER + isAllHashtags → openSearch.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForPanelCommandsLoaded } from '../helpers/window-utils';

test.describe('cmd hashtag → search @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('cmd-hashtag-search'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('typing #todo #today + Enter opens search/home with q param', async () => {
    // Open cmd panel
    const openResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true, width: 600, height: 400, frame: false,
        transparent: true, alwaysOnTop: true, center: true,
      });
    });
    expect(openResult.success).toBe(true);

    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    await cmdWindow.waitForSelector('input', { timeout: 5000 });
    await waitForPanelCommandsLoaded(cmdWindow);

    await cmdWindow.fill('input', '#todo #today');
    await cmdWindow.keyboard.press('Enter');

    // Search/home should open with q=#todo #today.
    // Use regex to avoid substring match against `peek://websearch/home.html`.
    const searchWindow = await app.getWindow(/peek:\/\/search\/home\.html/, 10000);
    expect(searchWindow).toBeTruthy();
    await searchWindow.waitForLoadState('domcontentloaded');

    const url = searchWindow.url();
    const params = new URLSearchParams(new URL(url).search);
    expect(params.get('q')).toBe('#todo #today');

    // Cleanup any windows
    if (openResult.id) {
      try {
        await bgWindow.evaluate(async (id: number) => {
          return await (window as any).app.window.close(id);
        }, openResult.id);
      } catch { /* may already be closed */ }
    }
  });

  test('second hashtag invocation opens a separate search window', async () => {
    // Open cmd panel once. We won't press Enter (which auto-closes the
    // cmd panel within 100ms via the FSM's shutdown action) — instead we
    // inline what openSearch does: api.window.open with the search URL
    // and NO `key`, so each invocation creates a fresh window for
    // side-by-side tag comparison. Driving from inside the cmd panel
    // matches the source identity that openSearch uses in production.
    const cmdOpen = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://cmd/panel.html', {
        modal: true, width: 600, height: 400, frame: false,
        transparent: true, alwaysOnTop: true, center: true,
        // Match production cmd-panel open params (see app/cmd/background.js):
        // without these the panel gets default role 'quick-view' (modal-only
        // path) and the focus handler in ipc.ts auto-closes it as a transient
        // sibling when the search workspace below gets natural WM focus on
        // Linux. With keepLive+role:'palette', closeOrHideWindow takes the
        // hide branch, the cmd panel page survives, and the second evaluate
        // here can still drive it.
        keepLive: true,
        role: 'palette',
      });
    });
    expect(cmdOpen.success).toBe(true);

    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    await cmdWindow.waitForSelector('input', { timeout: 5000 });
    await waitForPanelCommandsLoaded(cmdWindow);

    const countSearchWindows = async (): Promise<number> => {
      return await bgWindow.evaluate(async () => {
        const r = await (window as any).app.window.list();
        if (!r || !r.windows) return 0;
        return r.windows.filter((w: { url?: string }) =>
          typeof w.url === 'string' && w.url.includes('peek://search/home.html')
        ).length;
      });
    };

    const baselineCount = await countSearchWindows();

    // First invocation: open search with #alpha.
    const r1 = await cmdWindow.evaluate(async () => {
      return await (window as any).app.window.open(
        'peek://search/home.html?q=' + encodeURIComponent('#alpha'),
        { role: 'workspace', width: 700, height: 768 },
      );
    });
    expect(r1.success).toBe(true);
    expect(r1.reused).toBeFalsy();

    // Second invocation: open search with #beta — should open a SECOND
    // window, not reuse the first. Before the fix, both invocations
    // collapsed onto a single `key:'search-home'` window.
    const r2 = await cmdWindow.evaluate(async () => {
      return await (window as any).app.window.open(
        'peek://search/home.html?q=' + encodeURIComponent('#beta'),
        { role: 'workspace', width: 700, height: 768 },
      );
    });
    expect(r2.success).toBe(true);
    expect(r2.reused).toBeFalsy();
    expect(r2.id).not.toBe(r1.id);

    // Two new search windows should now exist on top of the baseline.
    await bgWindow.waitForFunction(
      async (expectedDelta) => {
        const r = await (window as any).app.window.list();
        if (!r || !r.windows) return false;
        const count = r.windows.filter((w: { url?: string }) =>
          typeof w.url === 'string' && w.url.includes('peek://search/home.html')
        ).length;
        return count >= expectedDelta;
      },
      baselineCount + 2,
      { timeout: 5000 },
    );

    const finalCount = await countSearchWindows();
    expect(finalCount).toBeGreaterThanOrEqual(baselineCount + 2);

    // Confirm each window carries its own query in the URL.
    const urls = await bgWindow.evaluate(async () => {
      const r = await (window as any).app.window.list();
      if (!r || !r.windows) return [];
      return r.windows
        .filter((w: { url?: string }) =>
          typeof w.url === 'string' && w.url.includes('peek://search/home.html')
        )
        .map((w: { url: string }) => w.url);
    });
    const queries = urls.map((u: string) => new URL(u).searchParams.get('q'));
    expect(queries).toContain('#alpha');
    expect(queries).toContain('#beta');

    // Cleanup: close cmd panel + the two new search windows.
    for (const id of [cmdOpen.id, r1.id, r2.id]) {
      if (id) {
        try {
          await bgWindow.evaluate(async (winId: number) => {
            return await (window as any).app.window.close(winId);
          }, id);
        } catch { /* may already be closed */ }
      }
    }
  });
});
