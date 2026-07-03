import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';

/**
 * P1.4a — hybrid page-host popup (window.open) semantics.
 *
 * As of the OAuth popup→opener bridge (peek ef30747b), a `window.open()` from
 * hybrid page content takes the NATIVE-ADOPTION path: the content WC's
 * `setWindowOpenHandler` (in `ipc.ts`) returns `{action:'allow', createWindow}`
 * and adopts Chromium's opener-wired guest WebContents into a fresh Peek hybrid
 * host. That gives the popup a REAL `window.opener`, which is fundamentally
 * incompatible with URL-based dedup — you cannot reuse an existing (non-opener)
 * host AND hand the caller back a live opener. So each `window.open` of the
 * same URL opens a NEW hybrid host, matching real-browser behavior (reuse is
 * name-based re-targeting, Chromium's job — and this path opens `_blank`, which
 * never reuses) and matching what OAuth needs: re-opening the same auth URL
 * must be a fresh popup, not a silently reused window.
 *
 * URL dedup is NOT gone: the APP-initiated open path (the canonical window-open
 * IPC handler, `findHybridWindowByUrl` at `ipc.ts` ~2571) still reuses a
 * same-URL hybrid host. This spec covers ONLY the page-content `window.open`
 * popup path, which intentionally does not dedup. (Before ef30747b the popup
 * path deny+re-routed through that same IPC handler and so DID URL-dedup — the
 * canvas-parity behavior this spec used to assert.)
 *
 * Network-free: `waitHybridForUrl` matches the REQUESTED address the registry
 * stores at open time, independent of whether the content load resolves.
 * Focus-free: hybrid windows are headless (opacity 0, never shown). Skips
 * itself if the hybrid bridge isn't present.
 */
test.describe('Hybrid page-host popup window.open semantics (P1.4a) @desktop', () => {
  let app: DesktopApp;

  test.beforeAll(async () => {
    ({ app } = await createPerDescribeApp('hybrid-reuse'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  const bridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  test('a repeat window.open of the same URL opens a NEW hybrid host (real-browser popup semantics)', async () => {
    test.skip(!(await bridgePresent()), 'no hybrid bridge in this configuration');
    const url = 'https://reuse.example/';

    const opener = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.makeWiredHybrid('data:text/html,<title>ReuseOpener</title>opener');
    });
    expect(opener).not.toBeNull();

    const before = await app.evaluateMain!(() =>
      (globalThis as any).__peekHybridOverlayTest.hybridIds(),
    );

    // First window.open → a NEW hybrid page-host for the URL.
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

    // Second window.open of the SAME url → real-browser semantics: a SECOND,
    // DISTINCT hybrid host appears — a new id NOT among those already open
    // (firstId included). The popup path does NOT URL-dedup; doing so would
    // sever the live window.opener the createWindow adoption exists to provide.
    const ran2 = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.triggerWindowOpen((arg as any).id, (arg as any).url);
    }, { id: opener, url });
    expect(ran2).toBe(true);

    const newId = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.waitHybridForUrl((arg as any).url, (arg as any).excl, 15000);
    }, { url, excl: idsInclFirst });
    expect(newId).not.toBeNull();
    expect(idsInclFirst).not.toContain(newId);

    // ...and the total hybrid-window count increased by exactly one.
    const countAfterSecond = await app.evaluateMain!(() =>
      (globalThis as any).__peekHybridOverlayTest.hybridCount(),
    );
    expect(countAfterSecond).toBe(countAfterFirst + 1);
  });
});
