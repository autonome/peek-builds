import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';

/**
 * P1.4a — hybrid page-host window-reuse dedup.
 *
 * A hybrid page-host is an opaque `BaseWindow`, which the canvas dedup checks
 * (`findWindowByUrl` / `findWindowByKey`, backed by `BrowserWindow.fromId`)
 * cannot resolve. So the window-open handler runs a PARALLEL dedup against the
 * hybrid registry (`findHybridWindowByUrl`):
 * a repeat open of the same URL must REUSE the existing hybrid window, not
 * spawn a duplicate — matching the canvas reuse semantics.
 *
 * This drives the REAL window-open path: a wired hybrid opener fires
 * `window.open(url)`, whose `setWindowOpenHandler` re-routes through the
 * canonical window-open IPC handler → the hybrid EARLY BRANCH. The first open
 * creates a host; the second open of the SAME url hits the dedup branch.
 *
 * Network-free: dedup (and `waitHybridForUrl`) match the REQUESTED address the
 * registry stores at open time, independent of whether the content load
 * resolves. Focus-free: hybrid windows are headless (opacity 0, never shown).
 * Skips itself if the hybrid bridge isn't present (flag off).
 */
test.describe('Hybrid page-host window-reuse dedup (P1.4a) @desktop', () => {
  let app: DesktopApp;

  test.beforeAll(async () => {
    ({ app } = await createPerDescribeApp('hybrid-reuse'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  const bridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  test('a repeat open of the same URL reuses the existing hybrid window (no duplicate)', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no hybrid bridge');
    const url = 'https://reuse.example/';

    const opener = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.makeWiredHybrid('data:text/html,<title>ReuseOpener</title>opener');
    });
    expect(opener).not.toBeNull();

    const before = await app.evaluateMain!(() =>
      (globalThis as any).__peekHybridOverlayTest.hybridIds(),
    );

    // First open → a NEW hybrid page-host for the URL.
    const ran1 = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.triggerWindowOpen((arg as any).id, (arg as any).url);
    }, { id: opener, url });
    expect(ran1).toBe(true);

    const firstId = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.waitHybridForUrl((arg as any).url, (arg as any).before);
    }, { url, before });
    expect(firstId).not.toBeNull();
    expect(before).not.toContain(firstId);

    const countAfterFirst = await app.evaluateMain!(() =>
      (globalThis as any).__peekHybridOverlayTest.hybridCount(),
    );
    const idsInclFirst = await app.evaluateMain!(() =>
      (globalThis as any).__peekHybridOverlayTest.hybridIds(),
    );

    // Second open of the SAME url → dedup REUSES firstId. No NEW hybrid host
    // (excluding every id that already exists, including firstId) appears...
    const ran2 = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.triggerWindowOpen((arg as any).id, (arg as any).url);
    }, { id: opener, url });
    expect(ran2).toBe(true);

    const newId = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.waitHybridForUrl((arg as any).url, (arg as any).excl, 1500);
    }, { url, excl: idsInclFirst });
    expect(newId).toBeNull();

    // ...and the total hybrid-window count is unchanged.
    const countAfterSecond = await app.evaluateMain!(() =>
      (globalThis as any).__peekHybridOverlayTest.hybridCount(),
    );
    expect(countAfterSecond).toBe(countAfterFirst);
  });
});
