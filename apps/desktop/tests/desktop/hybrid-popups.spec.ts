import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';

/**
 * P1.5 — hybrid page-host popup routing (design risk R7).
 *
 * The hybrid content webContents is a `WebContentsView` (getType() ===
 * 'browserView'), which the entry.ts default-deny SECURITY chokepoint (gated on
 * 'window'/'webview') does NOT cover. `wireHybridContentEvents` therefore
 * installs an explicit `setWindowOpenHandler` on it that mirrors the canvas
 * <webview> guest policy: http(s) `window.open` / `target=_blank` are DENIED
 * the default raw popup and re-routed through the canonical window-open IPC
 * handler (`invokeWindowOpen`). That re-entry takes the hybrid EARLY BRANCH →
 * a NEW opaque BaseWindow + WebContentsView page-host.
 *
 * The test bridge's `makeWiredHybrid(dataUrl)` builds a hybrid window and calls
 * the SAME `wireHybridContentEvents` the real branch calls, so the handler under
 * test is installed on its content WC. The popup TARGET is asserted against the
 * window-registry `address` of any NEW hybrid host (network-free).
 *
 * Everything is focus-free: hybrid windows are headless (opacity 0, never
 * shown). Skips itself if the hybrid bridge isn't present.
 */
test.describe('Hybrid page-host popups (P1.5) @desktop', () => {
  let app: DesktopApp;

  test.beforeAll(async () => {
    ({ app } = await createPerDescribeApp('hybrid-popups'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  const bridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  test('window.open(https) routes to a NEW hybrid page-host (not a raw popup)', async () => {
    test.skip(!(await bridgePresent()), 'no hybrid bridge in this configuration');

    // A hybrid page-host whose content WC has the real popup handler installed.
    const opener = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.makeWiredHybrid('data:text/html,<title>Opener</title>opener');
    });
    expect(opener).not.toBeNull();

    const existing = await app.evaluateMain!(() =>
      (globalThis as any).__peekHybridOverlayTest.hybridIds(),
    );

    // Scripted window.open of an http(s) URL from the content WC.
    const ran = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.triggerWindowOpen((arg as any).id, 'https://example.org/');
    }, { id: opener });
    expect(ran).toBe(true);

    // A NEW hybrid page-host (id not among the existing ones) appears whose
    // requested address is the popup URL — the popup became another
    // BaseWindow+WebContentsView page, not a raw Chromium popup.
    const popupId = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.waitHybridForUrl('https://example.org/', (arg as any).existing);
    }, { existing });
    expect(popupId).not.toBeNull();
    expect(existing).not.toContain(popupId);

    // The popup URL shows up in the requested-address set of hybrid hosts.
    const addrs = await app.evaluateMain!(() =>
      (globalThis as any).__peekHybridOverlayTest.hybridAddresses(),
    );
    expect(addrs.some((u: string) => u.startsWith('https://example.org/'))).toBe(true);
  });

  test('target=_blank click (https) also routes to a NEW hybrid page-host', async () => {
    test.skip(!(await bridgePresent()), 'no hybrid bridge in this configuration');

    const opener = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.makeWiredHybrid('data:text/html,<title>Opener2</title>opener2');
    });
    expect(opener).not.toBeNull();

    const existing = await app.evaluateMain!(() =>
      (globalThis as any).__peekHybridOverlayTest.hybridIds(),
    );

    const ran = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.triggerBlankLinkClick((arg as any).id, 'https://example.net/');
    }, { id: opener });
    expect(ran).toBe(true);

    const popupId = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.waitHybridForUrl('https://example.net/', (arg as any).existing);
    }, { existing });
    expect(popupId).not.toBeNull();
    expect(existing).not.toContain(popupId);
  });

  test('non-http(s) window.open (about:blank) is NOT routed to a hybrid host (canvas policy)', async () => {
    test.skip(!(await bridgePresent()), 'no hybrid bridge in this configuration');

    const opener = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.makeWiredHybrid('data:text/html,<title>Opener3</title>opener3');
    });
    expect(opener).not.toBeNull();

    const before = await app.evaluateMain!(() =>
      (globalThis as any).__peekHybridOverlayTest.hybridCount(),
    );
    const existing = await app.evaluateMain!(() =>
      (globalThis as any).__peekHybridOverlayTest.hybridIds(),
    );

    // A non-http(s) window.open (about:blank — the canonical case the canvas
    // guest handler cites) is handled per canvas policy ('allow', NOT
    // re-routed). It must NOT create a NEW hybrid host (the http(s)-only
    // re-route branch never fires) — and crucially it is NOT silently dropped:
    // the handler returned an explicit verdict instead of falling through to a
    // raw, un-gated popup.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.triggerWindowOpen((arg as any).id, 'about:blank');
    }, { id: opener });

    const blankHybrid = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.waitHybridForUrl('about:blank', (arg as any).existing, 1500);
    }, { existing });
    expect(blankHybrid).toBeNull();

    // No NEW hybrid host was created for the non-http(s) open.
    const after = await app.evaluateMain!(() =>
      (globalThis as any).__peekHybridOverlayTest.hybridCount(),
    );
    expect(after).toBe(before);
  });
});
