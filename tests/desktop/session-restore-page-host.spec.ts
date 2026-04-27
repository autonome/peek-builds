/**
 * Session restore — page-host state coherence
 *
 * User-reported regression: page hosts restored after a session are broken
 * — can't execute shortcuts, can't resize, "looks like a maximize call is
 * being made". Working hypothesis: the page-host's JS state (`isMaximized`,
 * body class, resize-handle visibility, screenBounds) and its OS-level
 * BrowserWindow bounds drift apart on restore because session restore
 * reconstitutes only the bounds — never the maximized flag — and the
 * page-host never re-derives "I was maximized" from its inputs.
 *
 * These tests pin the failure with a deterministic save+restore cycle
 * driven via `__peek_test.forceSaveSession` / `forceRestoreSession`
 * (which bypass the test-profile guard in `session.ts`). The expected
 * post-FSM behavior is encoded as assertions; today the maximized-restore
 * test will fail.
 *
 * Run with:
 *   yarn test:grep "Session Restore Page Host"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

test.describe('Session Restore Page Host @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('session-restore-page-host'));

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          `<!DOCTYPE html><html><head><title>${req.url}</title></head>` +
            `<body><h1>${req.url}</h1></body></html>`,
        );
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  // Helpers --------------------------------------------------------------

  async function openPageHost(url: string): Promise<{ pageWindow: Page; windowId: number }> {
    const result = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 800, height: 600 });
    }, url);
    expect(result.success).toBe(true);
    // Match by the URL slug so we don't pick up a leftover page-host
    // from an earlier test that has a different inner http URL. Slug
    // chosen unique per test (e.g. 'normal-roundtrip', 'max-roundtrip')
    // and survives URL-encoding of the page-host's `?url=` query value.
    const slug = new URL(url).pathname.slice(1);
    const pageWindow = await app.getWindow(slug, 15000);
    return { pageWindow, windowId: result.id };
  }

  /** Close every page-host window and clear the saved session snapshot. */
  async function resetState() {
    await bgWindow.evaluate(async () => {
      const list = await (window as any).app.window.list({ includeInternal: false });
      if (!list?.success) return;
      for (const w of list.windows || []) {
        if (typeof w.url === 'string' && w.url.startsWith('peek://app/page/')) {
          await (window as any).app.window.close(w.id);
        }
      }
    });
    // Wait for close to complete (window:removed for the last close).
    // Lightweight: poll the list until empty of page-host windows.
    await bgWindow.waitForFunction(async () => {
      const list = await (window as any).app.window.list({ includeInternal: false });
      if (!list?.success) return false;
      return !(list.windows || []).some((w: any) =>
        typeof w.url === 'string' && w.url.startsWith('peek://app/page/'));
    });
  }

  async function getHostState(pageWindow: Page) {
    return await pageWindow.evaluate(() => {
      return {
        bodyMaximized: document.body.classList.contains('maximized'),
        urlParams: Object.fromEntries(new URL(window.location.href).searchParams.entries()),
        // Resize handles set display:none in updatePositionsMaximized.
        // After the FSM lands, we want one source of truth — body class.
        // Today we read both to surface drift.
        seHandleHidden: (() => {
          const el = document.getElementById('resize-se');
          return el ? el.style.display === 'none' : null;
        })(),
      };
    });
  }

  /**
   * Trigger the page-host's `toggleMaximize` by dispatching a dblclick on
   * the navbar element — same path the user takes. Waits for
   * `window.__pageModuleReady` (set at the end of page.js module eval) so
   * the dblclick listener at the bottom of page.js is guaranteed installed
   * before we dispatch.
   */
  async function maximizePageHost(pageWindow: Page) {
    await pageWindow.waitForFunction(() => (window as any).__pageModuleReady === true);
    await pageWindow.evaluate(() => {
      const nav = document.getElementById('navbar')!;
      nav.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    });
  }

  async function waitForBodyMaximized(pageWindow: Page, expected: boolean, timeoutMs = 5000) {
    await pageWindow.waitForFunction(
      (want: boolean) => document.body.classList.contains('maximized') === want,
      expected,
      { timeout: timeoutMs },
    );
  }

  test.beforeEach(async () => {
    await resetState();
  });

  // Tests ----------------------------------------------------------------

  test('non-maximized page host: bounds round-trip through save+restore', async () => {
    const url = `http://127.0.0.1:${serverPort}/normal-roundtrip`;
    const { pageWindow } = await openPageHost(url);

    // Wait for page-host to fully initialize (URL params populated).
    await pageWindow.waitForFunction(() => {
      const p = new URL(window.location.href).searchParams;
      return p.get('width') && p.get('height');
    });

    const beforeState = await getHostState(pageWindow);
    expect(beforeState.bodyMaximized).toBe(false);

    // Save the snapshot before closing.
    await app.evaluateMain!((() => {
      return (globalThis as any).__peek_test.forceSaveSession();
    }) as any);

    // Close the window and wait for window:removed for determinism.
    const initialWindowId = await pageWindow.evaluate(async () => {
      const r = await (window as any).app.window.getInfo();
      return r?.id ?? null;
    });
    await bgWindow.evaluate((id: number) => {
      (window as any).__sessionRemoved = new Promise<void>((resolve) => {
        const handler = (msg: { id?: number }) => {
          if (msg?.id === id) {
            try { (window as any).app.pubsub.unsubscribe('window:removed', handler); } catch {}
            resolve();
          }
        };
        (window as any).app.pubsub.subscribe('window:removed', handler);
      });
      (window as any).app.window.close(id);
    }, initialWindowId);
    await bgWindow.evaluate(() => (window as any).__sessionRemoved);

    // Now restore.
    const restoreResult = await app.evaluateMain!((() => {
      return (globalThis as any).__peek_test.forceRestoreSession();
    }) as any) as { restored: number; failed: number; total: number };
    expect(restoreResult.restored).toBeGreaterThan(0);

    // Wait for the restored window to appear.
    const restoredPageWindow = await app.getWindow('normal-roundtrip', 15000);
    await restoredPageWindow.waitForFunction(() => {
      const p = new URL(window.location.href).searchParams;
      return p.get('width') && p.get('height');
    });

    const afterState = await getHostState(restoredPageWindow);
    expect(afterState.bodyMaximized).toBe(false);
    expect(afterState.urlParams.width).toBe(beforeState.urlParams.width);
    expect(afterState.urlParams.height).toBe(beforeState.urlParams.height);
  });

  test('maximized page host: maximize state survives save+restore (regression: restored windows lose maximized state)', async () => {
    const url = `http://127.0.0.1:${serverPort}/maximized-roundtrip`;
    const { pageWindow, windowId } = await openPageHost(url);

    // Wait for init.
    await pageWindow.waitForFunction(() => {
      const p = new URL(window.location.href).searchParams;
      return p.get('width') && p.get('height');
    });

    // Maximize via navbar dblclick (same path the user takes).
    await maximizePageHost(pageWindow);
    await waitForBodyMaximized(pageWindow, true);

    const beforeState = await getHostState(pageWindow);
    expect(beforeState.bodyMaximized).toBe(true);
    expect(beforeState.urlParams.maximized).toBe('1');
    expect(beforeState.seHandleHidden).toBe(true);

    // Save snapshot.
    await app.evaluateMain!((() => {
      return (globalThis as any).__peek_test.forceSaveSession();
    }) as any);

    // Close and wait deterministically.
    await bgWindow.evaluate((id: number) => {
      (window as any).__maxRemoved = new Promise<void>((resolve) => {
        const handler = (msg: { id?: number }) => {
          if (msg?.id === id) {
            try { (window as any).app.pubsub.unsubscribe('window:removed', handler); } catch {}
            resolve();
          }
        };
        (window as any).app.pubsub.subscribe('window:removed', handler);
      });
      (window as any).app.window.close(id);
    }, windowId);
    await bgWindow.evaluate(() => (window as any).__maxRemoved);

    // Restore.
    const restoreResult = await app.evaluateMain!((() => {
      return (globalThis as any).__peek_test.forceRestoreSession();
    }) as any) as { restored: number; failed: number; total: number };
    expect(restoreResult.restored).toBeGreaterThan(0);

    const restoredPageWindow = await app.getWindow('maximized-roundtrip', 15000);
    await restoredPageWindow.waitForFunction(() => {
      const p = new URL(window.location.href).searchParams;
      return p.get('width') && p.get('height');
    });

    const afterState = await getHostState(restoredPageWindow);

    // ── Expectations the FSM must meet ─────────────────────────────
    // 1) The body class must reflect maximized state.
    expect(afterState.bodyMaximized,
      `restored page host lost body.maximized class — JS state thinks it's not maximized even though the saved URL had maximized=1`).toBe(true);
    // 2) URL params should still carry the maximized flag.
    expect(afterState.urlParams.maximized,
      `restored page host lost maximized=1 URL param — page-host URL is regenerated by window-open without propagating the maximize state`).toBe('1');
    // 3) Resize handles must be hidden when maximized — drift between
    //    body class and handle visibility surfaces state-incoherence.
    expect(afterState.seHandleHidden,
      `restored page host shows resize handles even though body class says maximized — state drift`).toBe(true);
  });
});
