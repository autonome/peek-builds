import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';

/**
 * P1.5 — hybrid page-host popup routing (design risk R7).
 *
 * The hybrid content webContents is a `WebContentsView` (getType() ===
 * 'browserView'), which the entry.ts default-deny SECURITY chokepoint (gated on
 * 'window'/'webview') does NOT cover. `wireHybridContentEvents` therefore
 * installs an explicit `setWindowOpenHandler` on it: every `window.open` /
 * `target=_blank` popup — http(s) AND non-http(s) (about:blank, data:, …) — is
 * ADOPTED via allow+createWindow into a NEW opaque BaseWindow +
 * WebContentsView page-host registered with the window-state machine; only
 * `javascript:` targets are denied outright.
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

  test('non-http(s) window.open (about:blank) is ADOPTED into a machine-registered hybrid host', async () => {
    test.skip(!(await bridgePresent()), 'no hybrid bridge in this configuration');

    const opener = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.makeWiredHybrid('data:text/html,<title>Opener3</title>opener3');
    });
    expect(opener).not.toBeNull();

    const existing = await app.evaluateMain!(() =>
      (globalThis as any).__peekHybridOverlayTest.hybridIds(),
    );

    // A non-http(s) window.open (about:blank + document.write is the canonical
    // legitimate case) used to be `{action:'allow'}` with NO createWindow —
    // Electron minted a default BrowserWindow the window-state machine never
    // saw. Now it takes the SAME allow+createWindow adoption as http(s): a NEW
    // hybrid host appears, and it is registered with the machine (the
    // "every window registers" invariant, design doc §7).
    const ran = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.triggerWindowOpen((arg as any).id, 'about:blank');
    }, { id: opener });
    expect(ran).toBe(true);

    const blankHybrid = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.waitHybridForUrl('about:blank', (arg as any).existing);
    }, { existing });
    expect(blankHybrid).not.toBeNull();
    expect(existing).not.toContain(blankHybrid);

    // The adopted popup is registered with the window-state machine.
    const machineId = await app.evaluateMain!((_e, arg) =>
      (globalThis as any).__peekHybridOverlayTest.machineWindowIdFor((arg as any).id),
    { id: blankHybrid });
    expect(machineId).not.toBeNull();
  });

  test('javascript: window.open never yields a javascript:-hosted or unregistered window', async () => {
    test.skip(!(await bridgePresent()), 'no hybrid bridge in this configuration');

    const opener = await app.evaluateMain!(async () => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.makeWiredHybrid('data:text/html,<title>Opener4</title>opener4');
    });
    expect(opener).not.toBeNull();

    const existing = await app.evaluateMain!(() =>
      (globalThis as any).__peekHybridOverlayTest.hybridIds(),
    );

    // javascript: has no legitimate popup use; the handler denies a literal
    // javascript: target outright (defense-in-depth). In practice Chromium
    // SANITIZES window.open('javascript:…') to an about:blank popup before the
    // handler ever sees it (observed live: details.url === 'about:blank', the
    // script does not run in the popup) — so the observable contract asserted
    // here is: no Peek window ever hosts a javascript: address, and whatever
    // sanitized popup does appear is adopted + machine-registered like any
    // other popup, never a raw unregistered window.
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.triggerWindowOpen((arg as any).id, 'javascript:void(0)');
    }, { id: opener });

    const jsHybrid = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.waitHybridForUrl('javascript:', (arg as any).existing, 1500);
    }, { existing });
    expect(jsHybrid).toBeNull();

    // Registration invariant: every NEW hybrid host the open produced (i.e.
    // any sanitized popup) is machine-registered. (Pre-existing test-bridge
    // openers are excluded — makeWiredHybrid hosts are registry-only by
    // design and predate this open.)
    const unregistered = await app.evaluateMain!((_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const prior = new Set((arg as any).existing as number[]);
      return b.hybridIds()
        .filter((id: number) => !prior.has(id))
        .filter((id: number) => b.machineWindowIdFor(id) == null);
    }, { existing });
    expect(unregistered).toEqual([]);
  });
});

/**
 * Peek item 619befb8: a page's own `window.open(url, undefined, 'noopener')`
 * (what a Bluesky web client does for an external link) must open a page host
 * the chrome overlay can frame, like any page opened by URL.
 *
 * The opener here is opened through the real open path (`app.window.open`),
 * so its content view carries the runtime-external preload, as a live page
 * does. The popup is adopted by the `createWindow` callback in `ipc.ts
 * wireHybridContentEvents()`. A page host only becomes eligible for the
 * overlay once its content reports its first composited frame (the preload's
 * `hybrid:first-frame` IPC → `session.ts installFirstFrameOrderableProducer`
 * → the kernel's `orderable`); `window-kernel.ts topmostBaseLayerPageHost`
 * ignores a host that never does, so the overlay never attaches to it and the
 * window shows as a bare page with no Peek chrome.
 */
test.describe('Hybrid page-host popups from a real page @desktop', () => {
  let app: DesktopApp;
  let bgWindow: import('@playwright/test').Page;
  let server: import('http').Server;
  let origin = '';

  test.beforeAll(async () => {
    const http = await import('http');
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>${req.url}</title><body>${req.url}</body>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as import('net').AddressInfo;
    origin = `http://127.0.0.1:${addr.port}`;
    ({ app, bgWindow } = await createPerDescribeApp('hybrid-popups-real-opener'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const orderableFor = (osId: number) =>
    app.evaluateMain!((_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const d = b.attachDiagnostic() as { pageHosts: Array<{ osId: number | null; orderable: boolean }> };
      return d.pageHosts.find((h) => h.osId === (arg as any).osId)?.orderable ?? null;
    }, { osId });

  test('a noopener window.open popup becomes a page host the overlay can frame', async () => {
    const openerUrl = `${origin}/opener`;
    const opened = await bgWindow.evaluate(
      async (u: string) => (window as any).app.window.open(u, { x: 120, y: 120, width: 700, height: 500 }),
      openerUrl,
    );
    expect(opened.success).toBe(true);
    const openerId = opened.id as number;

    // Control: the opener, opened by URL, reports its first frame.
    await expect.poll(() => orderableFor(openerId), { timeout: 10000 }).toBe(true);

    const existing = await app.evaluateMain!(() =>
      (globalThis as any).__peekHybridOverlayTest.hybridIds(),
    );
    const targetUrl = `${origin}/target`;
    await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.evalInHybridContent(
        (arg as any).id,
        `window.open(${JSON.stringify((arg as any).url)}, undefined, 'noopener'); true`,
      );
    }, { id: openerId, url: targetUrl });

    const popupId = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.waitHybridForUrl((arg as any).url, (arg as any).existing);
    }, { url: targetUrl, existing });
    expect(popupId, 'the popup is adopted into a hybrid page host').not.toBeNull();

    await expect
      .poll(() => orderableFor(popupId as number), {
        timeout: 10000,
        message:
          'the popup host never reported its first composited frame, so the chrome overlay can never attach to it',
      })
      .toBe(true);
  });
});
