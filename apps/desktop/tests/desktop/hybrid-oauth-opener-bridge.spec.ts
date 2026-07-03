import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

/**
 * Hybrid OAuth popup→opener bridge — REAL browser opener semantics.
 *
 * When hybrid page content calls `window.open('https://…')`, the content WC's
 * `setWindowOpenHandler` returns `{ action: 'allow', createWindow }`, and
 * `createWindow` adopts Chromium's opener-wired guest WebContents into a Peek
 * BaseWindow host (instead of the old deny+recreate path, which severed the
 * opener link and made `window.open()` return null).
 *
 * This is an end-to-end proof, not a logic mirror: a real opener page opens a
 * real popup, the popup posts a message back, and the opener receives it as a
 * genuine `MessageEvent` with a correct `.origin` and non-null `.source`.
 *
 * Run with:
 *   yarn test:grep "hybrid OAuth popup"
 */

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let port: number;

test.describe('hybrid OAuth popup→opener bridge @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('oauth-bridge'));

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if ((req.url || '').startsWith('/popup')) {
          res.end(
            `<!DOCTYPE html><html><head><title>popup</title></head><body>
              <script>
                window.__hasOpener = !!window.opener;
                // Post the OAuth result straight back to the opener on load, as
                // a real provider-redirect popup would. The opener's listener
                // filters for this message and latches it, so the test's poll
                // converges regardless of delivery timing.
                if (window.opener) { try { window.opener.postMessage({ peekOauth: 'hello' }, '*'); } catch (e) {} }
              </script>
            </body></html>`,
          );
          return;
        }
        res.end(
          `<!DOCTYPE html><html><head><title>opener</title></head><body>
            <script>
              window.__peekOauth = { received: null };
              window.addEventListener('message', (e) => {
                // The test profile loads the Proton Pass extension, whose
                // content-script bridge floods this window with
                // __peekRuntimeExternal postMessages. Filter for OUR message so
                // that extension noise can't overwrite the captured result — a
                // real 'message' handler always checks the payload shape anyway.
                if (e.data && e.data.peekOauth) {
                  window.__peekOauth.received = { data: e.data, origin: e.origin, hasSource: !!e.source };
                }
              });
              window.__peekOauthHandle = null;
              window.__openOAuthPopup = function (name) {
                // Unique target name per test. Without it, a lingering popup from
                // a prior test (same fixed name, still open) gets RE-TARGETED
                // (navigated) by window.open instead of a new window being
                // created — createWindow never fires, no new host, and this
                // test's waitHybridForUrl times out.
                var h = window.open('/popup', name || 'oauthPopup', 'width=500,height=600');
                window.__peekOauthHandle = h;
                return !!h;
              };
            </script>
          </body></html>`,
        );
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  /** Run `code` inside hybrid window `id`'s content webContents via the test bridge. */
  const evalHybrid = (id: number, code: string) =>
    app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.evalInHybridContent((arg as any).id, (arg as any).code);
    }, { id, code });

  /** Open a fresh opener hybrid page-host, resolving once its script has loaded. */
  async function openOpener(caseTag: string): Promise<number> {
    // Unique opener URL per test. app.window.open dedups by normalized URL
    // (findHybridWindowByUrl → normalizeForDedup, which keeps query strings),
    // so a shared /opener would be REUSED + RELOADED across tests — same
    // openerId, wiped listener/handle state, colliding popup window names. A
    // per-test query param keeps each test's opener a distinct, isolated host.
    const openerUrl = `http://127.0.0.1:${port}/opener?case=${caseTag}`;
    const res = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 900, height: 700 });
    }, openerUrl);
    expect(res.success).toBe(true);
    const openerId = res.id as number;

    await expect
      .poll(async () => await evalHybrid(openerId, 'typeof window.__openOAuthPopup'), { timeout: 15000 })
      .toBe('function');

    return openerId;
  }

  /** Trigger the opener's popup and wait for its hybrid host to appear. */
  async function openPopup(openerId: number, caseTag: string): Promise<number> {
    // Snapshot ALL existing hybrid ids (this test's opener + any windows lingering
    // from a prior test, since both tests open a /popup) so waitHybridForUrl can
    // only resolve to the genuinely-new popup, never a stale same-URL host.
    const beforeIds = (await app.evaluateMain!(() =>
      (globalThis as any).__peekHybridOverlayTest.hybridIds(),
    )) as number[];

    // Core Option-A assertion: window.open returns a real, non-null
    // WindowProxy — under the old deny+recreate path this was null. The
    // per-test window name keeps a lingering prior-test popup from being
    // re-targeted instead of a fresh window being created (see __openOAuthPopup).
    const opened = await evalHybrid(openerId, `window.__openOAuthPopup('oauthPopup_${caseTag}')`);
    expect(opened).toBe(true);

    const popupUrl = `http://127.0.0.1:${port}/popup`;
    const popupId = await app.evaluateMain!(async (_e, arg) => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return b.waitHybridForUrl((arg as any).url, (arg as any).exclude, 15000);
    }, { url: popupUrl, exclude: beforeIds });
    expect(popupId).not.toBeNull();

    return popupId as number;
  }

  test('window.open returns a real opener-linked proxy; popup postMessages back to the opener', async () => {
    const openerId = await openOpener('proxy');
    const popupId = await openPopup(openerId, 'proxy');

    // Core Option-A proof: the popup has a REAL, non-null window.opener.
    await expect.poll(async () => await evalHybrid(popupId, 'window.__hasOpener'), { timeout: 15000 }).toBe(true);

    // The opener receives the popup's post as a genuine MessageEvent. Delivery
    // is async, but the opener's filtered listener LATCHES our message (ignoring
    // extension postMessage noise), so this poll converges deterministically.
    await expect
      .poll(
        async () =>
          await evalHybrid(
            openerId,
            'window.__peekOauth && window.__peekOauth.received ? window.__peekOauth.received.data && window.__peekOauth.received.data.peekOauth : null',
          ),
        { timeout: 15000 },
      )
      .toBe('hello');

    const receivedJson = (await evalHybrid(openerId, 'JSON.stringify(window.__peekOauth.received)')) as string;
    const received = JSON.parse(receivedJson);
    expect(received.origin).toBe(`http://127.0.0.1:${port}`);
    expect(received.hasSource).toBe(true);
  });

  test('opener-initiated close removes the popup host', async () => {
    const openerId = await openOpener('close');
    const popupId = await openPopup(openerId, 'close');

    await evalHybrid(openerId, 'window.__peekOauthHandle && window.__peekOauthHandle.close(); true');

    await expect
      .poll(
        async () => {
          const ids = (await app.evaluateMain!(() =>
            (globalThis as any).__peekHybridOverlayTest.hybridIds(),
          )) as number[];
          return ids.includes(popupId);
        },
        { timeout: 15000 },
      )
      .toBe(false);
  });

  // peek 06d363fc — KNOWN-FAILING repro (test.fixme; no fix landed yet).
  //
  // Many OAuth client libraries defensively call `popup.close()` after they
  // receive the result. Browser semantics: `.close()` on an already-closed
  // window is a silent no-op. Here it instead throws
  // `IPC method called after context was released` (native `WindowProxy.close()`,
  // synchronous in the opener), which can turn a SUCCESSFUL login into a
  // spurious failure in the OAuth library's cleanup.
  //
  // Reproduces ONLY when the popup self-closes BEFORE its opener link has
  // finished establishing (no settle below) AND there has been prior popup
  // activity in the app — e.g. run as the 3rd test in this file. Investigation
  // (2026-07-03) found `.closed` is `true` yet `close()` still throws; the
  // failure is at the Chromium boundary for a window.open-adopted
  // WebContentsView popup. Our-side fixes that were tried and RULED OUT:
  // deferring the host `baseWin.close()` (setImmediate) and detaching the dead
  // WebContentsView before close — both only mask it in a pristine isolated
  // run and fail with any prior popup activity, so neither is a real fix (and a
  // fixed-tick defer is the fsm-pilled timing-hack anti-pattern). A settle
  // (waiting for `window.opener` before self-close) always avoids the throw.
  // Next step: a live headed trace (headless can't observe the real
  // first-responder/close timing — see apps/desktop/CLAUDE.md LESSON), and/or
  // an upstream Electron report. Un-skip to work the fix.
  test.fixme('opener close() after the popup self-closed is a silent no-op', async () => {
    const openerId = await openOpener('doubleclose');
    const popupId = await openPopup(openerId, 'doubleclose');

    // DELIBERATELY do NOT wait for the popup to settle (no __hasOpener poll)
    // before closing it — that is the regression condition (a settle masks it).
    await evalHybrid(popupId, 'window.close(); true');

    // Wait until the popup host is genuinely gone from the registry.
    await expect
      .poll(
        async () => {
          const ids = (await app.evaluateMain!(() =>
            (globalThis as any).__peekHybridOverlayTest.hybridIds(),
          )) as number[];
          return ids.includes(popupId);
        },
        { timeout: 15000 },
      )
      .toBe(false);

    // The opener defensively calls close() on the now-dead handle (as OAuth
    // libraries do). Browser semantics: a silent no-op. Catch INSIDE the opener
    // JS so any synchronous throw surfaces as a marker string rather than being
    // swallowed by evalInHybridContent's `.catch(() => undefined)`. Pre-fix this
    // returned 'threw:IPC method called after context was released'.
    const closeResult = await evalHybrid(
      openerId,
      `(() => {
        try {
          if (window.__peekOauthHandle) window.__peekOauthHandle.close();
          return 'ok';
        } catch (e) {
          return 'threw:' + ((e && e.message) || String(e));
        }
      })()`,
    );
    expect(closeResult).toBe('ok');
  });
});
