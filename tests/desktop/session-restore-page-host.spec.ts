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

  test('maximize → unmaximize → resize smaller → restart: bounds restore at resized size, not maximized', async () => {
    const url = `http://127.0.0.1:${serverPort}/unmax-resize-roundtrip`;
    const { pageWindow, windowId } = await openPageHost(url);

    await pageWindow.waitForFunction(() => {
      const p = new URL(window.location.href).searchParams;
      return p.get('width') && p.get('height');
    });

    // Capture pre-maximize URL bounds for comparison.
    const preMaximizeUrl = await getHostState(pageWindow);
    const preMaximizeWidth = parseInt(preMaximizeUrl.urlParams.width as string, 10);
    const preMaximizeHeight = parseInt(preMaximizeUrl.urlParams.height as string, 10);

    // Maximize.
    await maximizePageHost(pageWindow);
    await waitForBodyMaximized(pageWindow, true);

    // Unmaximize via the same navbar dblclick path.
    await maximizePageHost(pageWindow);
    await waitForBodyMaximized(pageWindow, false);

    // Resize smaller through the SE corner handle — pointer events drive
    // the same FSM path the user does. Drag the SE handle 200px up-left
    // to shrink the window.
    await pageWindow.evaluate(() => {
      const handle = document.getElementById('resize-se')!;
      handle.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, button: 0, pointerId: 1, screenX: 600, screenY: 500,
      }));
      handle.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, button: 0, buttons: 1, pointerId: 1, screenX: 400, screenY: 300,
      }));
      handle.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, button: 0, pointerId: 1,
      }));
    });

    // Wait for the resize to settle in URL params.
    await pageWindow.waitForFunction(({ w, h }) => {
      const p = new URL(window.location.href).searchParams;
      const cw = parseInt(p.get('width') || '0', 10);
      const ch = parseInt(p.get('height') || '0', 10);
      return cw < w && ch < h && !p.has('maximized');
    }, { w: preMaximizeWidth, h: preMaximizeHeight });

    const beforeState = await getHostState(pageWindow);
    expect(beforeState.bodyMaximized,
      `pre-save: body.maximized must be false after unmaximize+resize`).toBe(false);
    expect(beforeState.urlParams.maximized,
      `pre-save: URL must NOT carry maximized=1 after unmaximize+resize`).toBeUndefined();
    const resizedWidth = parseInt(beforeState.urlParams.width as string, 10);
    const resizedHeight = parseInt(beforeState.urlParams.height as string, 10);

    // Save.
    await app.evaluateMain!((() => {
      return (globalThis as any).__peek_test.forceSaveSession();
    }) as any);

    // Close.
    await bgWindow.evaluate((id: number) => {
      (window as any).__unmaxRemoved = new Promise<void>((resolve) => {
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
    await bgWindow.evaluate(() => (window as any).__unmaxRemoved);

    // Restore.
    const restoreResult = await app.evaluateMain!((() => {
      return (globalThis as any).__peek_test.forceRestoreSession();
    }) as any) as { restored: number; failed: number; total: number };
    expect(restoreResult.restored).toBeGreaterThan(0);

    const restoredPageWindow = await app.getWindow('unmax-resize-roundtrip', 15000);
    await restoredPageWindow.waitForFunction(() => {
      const p = new URL(window.location.href).searchParams;
      return p.get('width') && p.get('height');
    });

    const afterState = await getHostState(restoredPageWindow);

    expect(afterState.bodyMaximized,
      `restored page host should NOT be maximized — user unmaximized + resized before restart`).toBe(false);
    expect(afterState.urlParams.maximized,
      `restored URL should NOT carry maximized=1`).toBeUndefined();
    expect(parseInt(afterState.urlParams.width as string, 10),
      `restored width should match resized width`).toBe(resizedWidth);
    expect(parseInt(afterState.urlParams.height as string, 10),
      `restored height should match resized height`).toBe(resizedHeight);
  });

  test('maximize → save+restore → unmaximize: restores to pre-maximize bounds (not workArea minus chrome)', async () => {
    const url = `http://127.0.0.1:${serverPort}/premax-roundtrip`;
    const { pageWindow, windowId } = await openPageHost(url);

    await pageWindow.waitForFunction(() => {
      const p = new URL(window.location.href).searchParams;
      return p.get('width') && p.get('height');
    });

    // Capture pre-maximize bounds — the size the window has BEFORE we
    // maximize. After the save/restore cycle and a subsequent unmaximize,
    // the window must come back to this size.
    const preState = await getHostState(pageWindow);
    const preMaxWidth = parseInt(preState.urlParams.width as string, 10);
    const preMaxHeight = parseInt(preState.urlParams.height as string, 10);
    expect(preState.bodyMaximized).toBe(false);

    // Maximize via dblclick — captures preMaximizeBounds in renderer state
    // and writes preX/preY/preWidth/preHeight to the URL.
    await maximizePageHost(pageWindow);
    await waitForBodyMaximized(pageWindow, true);

    // Verify the URL carries the pre-maximize bounds.
    const maxState = await getHostState(pageWindow);
    expect(maxState.urlParams.maximized).toBe('1');
    expect(parseInt(maxState.urlParams.preWidth as string, 10),
      `URL should carry preWidth so save+restore can preserve pre-maximize size`)
      .toBe(preMaxWidth);
    expect(parseInt(maxState.urlParams.preHeight as string, 10)).toBe(preMaxHeight);

    // Save.
    await app.evaluateMain!((() => {
      return (globalThis as any).__peek_test.forceSaveSession();
    }) as any);

    // Close.
    await bgWindow.evaluate((id: number) => {
      (window as any).__premaxRemoved = new Promise<void>((resolve) => {
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
    await bgWindow.evaluate(() => (window as any).__premaxRemoved);

    // Restore.
    const restoreResult = await app.evaluateMain!((() => {
      return (globalThis as any).__peek_test.forceRestoreSession();
    }) as any) as { restored: number; failed: number; total: number };
    expect(restoreResult.restored).toBeGreaterThan(0);

    const restoredPageWindow = await app.getWindow('premax-roundtrip', 15000);
    await restoredPageWindow.waitForFunction(() => {
      const p = new URL(window.location.href).searchParams;
      return p.get('maximized') === '1';
    });

    const restoredMaxState = await getHostState(restoredPageWindow);
    expect(restoredMaxState.bodyMaximized,
      `after restore: body should be maximized`).toBe(true);
    expect(restoredMaxState.urlParams.preWidth,
      `after restore: URL should still carry preWidth so unmaximize knows where to go`)
      .toBe(String(preMaxWidth));
    expect(restoredMaxState.urlParams.preHeight)
      .toBe(String(preMaxHeight));

    // Now unmaximize on the restored window — must land at the original
    // pre-maximize size, not at workArea-minus-chrome.
    await maximizePageHost(restoredPageWindow);
    await waitForBodyMaximized(restoredPageWindow, false);

    // Wait for URL to reflect the unmaximize bounds.
    await restoredPageWindow.waitForFunction(({ w, h }) => {
      const p = new URL(window.location.href).searchParams;
      return parseInt(p.get('width') || '0', 10) === w
        && parseInt(p.get('height') || '0', 10) === h
        && !p.has('maximized');
    }, { w: preMaxWidth, h: preMaxHeight });

    const finalState = await getHostState(restoredPageWindow);
    expect(parseInt(finalState.urlParams.width as string, 10),
      `unmaximize after save+restore should restore to original pre-maximize width, not workArea`)
      .toBe(preMaxWidth);
    expect(parseInt(finalState.urlParams.height as string, 10),
      `unmaximize after save+restore should restore to original pre-maximize height, not workArea`)
      .toBe(preMaxHeight);
  });
});
