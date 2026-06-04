/**
 * Regression repro: ESC on a REAL http web page (canvas page-host) should open
 * the Windows switcher, NOT close the page window.
 *
 * User report: "ESC is closing web pages again, instead of opening the windows
 * switcher." On a real http/https page shown in the page-host, ESC closes the
 * window. Expected: ESC opens peek://windows/windows.html and the page survives.
 *
 * This drives the REAL backend path on a real http page:
 *   - serve a local http page (127.0.0.1:PORT) like boot-window-inventory does.
 *   - open it as a TOP-LEVEL content window via the bg window
 *     (window.app.window.open) — bg is INTERNAL so it's NOT a real parent,
 *     giving role 'content' (not 'child-content').
 *   - wait for the page-host window (peek://app/page/index.html) and its
 *     <webview> guest loading the http URL.
 *   - inject Escape at the WEBVIEW GUEST webContents level (mirrors how the
 *     ESC handler's webview before-input-event fires).
 *   - assert the switcher appears AND the page-host window survives.
 *
 * Run with:
 *   DEBUG=1 yarn test:grep "Page-host ESC opens switcher"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

test.describe('Page-host ESC opens switcher @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('page-host-esc'));
    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>${req.url}</title></head><body><h1>page ${req.url}</h1></body></html>`);
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

  test('pressing Escape on a top-level http page opens the switcher and keeps the page', async () => {
    const httpUrl = `http://127.0.0.1:${serverPort}/esc-repro-page`;

    // Sanity: switcher not open yet.
    const switcherBefore = await app.getWindow('windows/windows.html', 1000).catch(() => null);
    expect(switcherBefore).toBeFalsy();

    // Open the http page as a top-level content window (bg is the opener =
    // internal = not a real parent => role 'content').
    const openResult = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 800, height: 600 });
    }, httpUrl);
    expect(openResult.success).toBe(true);
    const pageHostId = openResult.id as number;

    // Wait for the page-host window to exist AND its <webview> guest to be
    // loading/loaded the http URL.
    await app.evaluateMain!(((electron: typeof import('electron'), targetUrl: string) => {
      const { BrowserWindow, webContents } = electron;
      return new Promise<void>((resolve) => {
        const check = () => {
          const hostPresent = BrowserWindow.getAllWindows().some((w) => {
            try { return w.webContents.getURL().includes('peek://app/page/'); } catch { return false; }
          });
          const guestLoaded = webContents.getAllWebContents().some((wc) => {
            try { return wc.getType() === 'webview' && wc.getURL().includes('127.0.0.1'); } catch { return false; }
          });
          if (hostPresent && guestLoaded) { resolve(); return; }
          setImmediate(check);
        };
        check();
      });
    }) as any, httpUrl);

    // Capture the resolved role/params on the page-host for the record.
    const diag = await app.evaluateMain!(((electron: typeof import('electron'), id: number) => {
      // window-registry is in main; reach it via the same module the handler uses.
      // Fall back to scanning if not directly importable here.
      const { BrowserWindow, webContents } = electron;
      const host = BrowserWindow.getAllWindows().find((w) => w.id === id);
      const guestIds = webContents.getAllWebContents()
        .filter((wc) => {
          try { return wc.getType() === 'webview'; } catch { return false; }
        })
        .map((wc) => ({ id: wc.id, url: (() => { try { return wc.getURL(); } catch { return ''; } })() }));
      return {
        hostExists: !!host,
        hostUrl: host ? (() => { try { return host.webContents.getURL(); } catch { return ''; } })() : '',
        guests: guestIds,
      };
    }) as any, pageHostId);
    console.log('[page-host-esc] pre-ESC diag:', JSON.stringify(diag));

    // Inject Escape at the WEBVIEW GUEST webContents — this is what fires the
    // guest before-input-event the ESC handler listens on for in-page keys.
    const sendResult = await app.evaluateMain!(((electron: typeof import('electron')) => {
      const { webContents } = electron;
      const guest = webContents.getAllWebContents().find((wc) => {
        try { return wc.getType() === 'webview' && wc.getURL().includes('127.0.0.1'); } catch { return false; }
      });
      if (!guest) return { error: 'no http webview guest found' };
      guest.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' } as any);
      guest.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' } as any);
      return { ok: true, guestId: guest.id };
    }) as any);
    expect(sendResult.error, JSON.stringify(sendResult)).toBeUndefined();

    // SECOND ESC (navbar-hidden path): the first ESC was consumed by the
    // renderer hiding its navbar (handled:true). Force the navbar hidden, wait
    // out the 200ms ESC debounce, then press ESC again so the renderer falls
    // through to the backend escPolicy/escUnhandledPolicy chain — THIS is the
    // path that should open the switcher for an active-session content window.
    await app.evaluateMain!(((electron: typeof import('electron'), id: number) => {
      const { BrowserWindow } = electron;
      const host = BrowserWindow.getAllWindows().find((w) => w.id === id);
      if (!host) return null;
      return host.webContents.executeJavaScript(
        "(function(){ try { var nb=document.querySelector('.navbar'); if(nb) nb.classList.remove('visible'); } catch(e){} return true; })()"
      ).catch(() => null);
    }) as any, pageHostId);

    await app.evaluateMain!(((_e: unknown) => new Promise<void>((resolve) => {
      const start = Date.now();
      const tick = () => { if (Date.now() - start >= 250) resolve(); else setTimeout(tick, 25); };
      tick();
    })) as any);

    const send2 = await app.evaluateMain!(((electron: typeof import('electron')) => {
      const { webContents } = electron;
      const guest = webContents.getAllWebContents().find((wc) => {
        try { return wc.getType() === 'webview' && wc.getURL().includes('127.0.0.1'); } catch { return false; }
      });
      if (!guest) return { error: 'no guest for 2nd esc' };
      guest.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' } as any);
      guest.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' } as any);
      return { ok: true };
    }) as any);
    console.log('[page-host-esc] second-esc:', JSON.stringify(send2));

    // EXPECTED: switcher appears. If the bug is present this throws (window
    // closed, no switcher).
    let switcherAppeared = true;
    const switcher = await app.getWindow('windows/windows.html', 8000).catch(() => null);
    if (!switcher) switcherAppeared = false;

    // Did the page-host survive?
    const pageHostSurvived = await app.evaluateMain!(((electron: typeof import('electron'), id: number) => {
      const { BrowserWindow } = electron;
      const w = BrowserWindow.getAllWindows().find((x) => x.id === id);
      return !!w && !w.isDestroyed();
    }) as any, pageHostId);

    console.log(`[page-host-esc] RESULT switcherAppeared=${switcherAppeared} pageHostSurvived=${pageHostSurvived}`);

    expect(switcherAppeared, 'switcher (peek://windows/windows.html) should appear on ESC').toBe(true);
    expect(pageHostSurvived, 'page-host window should survive ESC').toBe(true);
  });

  test('pressing Escape on a CHILD-CONTENT http page opens the switcher and keeps the page', async () => {
    // The actual regression: a page opened FROM A REAL CONTENT PARENT gets
    // role 'child-content'. The prior policy closed child-content on ESC even
    // while the app was OS-focused; the fix makes it open the switcher instead
    // (same as plain content). This test drives the full backend path with a
    // genuine child-content window.
    const parentUrl = `http://127.0.0.1:${serverPort}/esc-parent-page`;
    const childUrl = `http://127.0.0.1:${serverPort}/esc-child-page`;

    // 1. Open the PARENT http page as a top-level content window (opener is bg
    //    = internal = not a real parent => role 'content'). Its page-host
    //    renderer (peek://app/page/...) is a REAL content window.
    const parentOpen = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 800, height: 600 });
    }, parentUrl);
    expect(parentOpen.success).toBe(true);
    const parentHostId = parentOpen.id as number;

    // Wait for the parent page-host renderer to be ready (it exposes
    // window.app.window.open via tile-preload).
    await app.evaluateMain!(((electron: typeof import('electron'), id: number) => {
      const { BrowserWindow } = electron;
      return new Promise<void>((resolve) => {
        const check = () => {
          const w = BrowserWindow.getAllWindows().find((x) => x.id === id);
          const ready = !!w && (() => { try { return w.webContents.getURL().includes('peek://app/page/'); } catch { return false; } })();
          if (ready) { resolve(); return; }
          setImmediate(check);
        };
        check();
      });
    }) as any, parentHostId);

    // 2. From the PARENT page-host renderer, open the CHILD http page. The
    //    opener is now a real content window => the child gets role
    //    'child-content' (parentWindowId set, isWebPage true).
    const childOpen = await app.evaluateMain!(((electron: typeof import('electron'), args: { id: number; u: string }) => {
      const { BrowserWindow } = electron;
      const host = BrowserWindow.getAllWindows().find((x) => x.id === args.id);
      if (!host) return Promise.resolve({ error: 'no parent host' });
      return host.webContents.executeJavaScript(
        `(async function(){ try { return await window.app.window.open(${JSON.stringify(args.u)}, { width: 700, height: 500 }); } catch(e){ return { error: String(e) }; } })()`
      );
    }) as any, { id: parentHostId, u: childUrl });
    expect(childOpen.error, JSON.stringify(childOpen)).toBeUndefined();
    expect(childOpen.success).toBe(true);
    const childHostId = childOpen.id as number;

    // 3. Confirm the child window's registry role is actually 'child-content'.
    const childRole = await app.evaluateMain!(((electron: typeof import('electron'), id: number) => {
      // Reach window-registry via the running main module map. getWindowInfo
      // isn't importable from here, so scan via the global registry the handler
      // uses: webContents params aren't exposed, so assert behaviorally below
      // AND surface the registry role if accessible.
      const reg = (globalThis as any).__peekWindowRegistry;
      if (reg && typeof reg.get === 'function') {
        const info = reg.get(id);
        return (info && info.params && info.params.role) || null;
      }
      return undefined; // registry not exposed — fall back to behavioral assert
    }) as any, childHostId);
    console.log('[page-host-esc] child role (null/undefined = not exposed):', JSON.stringify(childRole));
    // If the registry role IS exposed, hard-assert it; otherwise rely on the
    // behavioral assertions below (window survives + switcher opens).
    if (childRole) {
      expect(childRole, 'child opened from a real content parent must be child-content').toBe('child-content');
    }

    // Wait for the child page-host + its http <webview> guest.
    await app.evaluateMain!(((electron: typeof import('electron'), targetUrl: string) => {
      const { webContents } = electron;
      return new Promise<void>((resolve) => {
        const check = () => {
          const guestLoaded = webContents.getAllWebContents().some((wc) => {
            try { return wc.getType() === 'webview' && wc.getURL().includes('esc-child-page'); } catch { return false; }
          });
          if (guestLoaded) { resolve(); return; }
          setImmediate(check);
        };
        check();
      });
    }) as any, childUrl);

    // 4. First ESC — consumed by the renderer hiding the navbar (handled:true).
    const send1 = await app.evaluateMain!(((electron: typeof import('electron')) => {
      const { webContents } = electron;
      const guest = webContents.getAllWebContents().find((wc) => {
        try { return wc.getType() === 'webview' && wc.getURL().includes('esc-child-page'); } catch { return false; }
      });
      if (!guest) return { error: 'no child guest for 1st esc' };
      guest.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' } as any);
      guest.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' } as any);
      return { ok: true };
    }) as any);
    expect(send1.error, JSON.stringify(send1)).toBeUndefined();

    // Force navbar hidden + wait out the 200ms ESC debounce.
    await app.evaluateMain!(((electron: typeof import('electron'), id: number) => {
      const { BrowserWindow } = electron;
      const host = BrowserWindow.getAllWindows().find((w) => w.id === id);
      if (!host) return null;
      return host.webContents.executeJavaScript(
        "(function(){ try { var nb=document.querySelector('.navbar'); if(nb) nb.classList.remove('visible'); } catch(e){} return true; })()"
      ).catch(() => null);
    }) as any, childHostId);

    await app.evaluateMain!(((_e: unknown) => new Promise<void>((resolve) => {
      const start = Date.now();
      const tick = () => { if (Date.now() - start >= 250) resolve(); else setTimeout(tick, 25); };
      tick();
    })) as any);

    // 5. Second ESC — renderer at root returns handled:false, backend consults
    //    escPolicy('active','child-content') === 'nothing' (the fix), then
    //    escUnhandledPolicy('active','child-content') === 'open-switcher'.
    const send2 = await app.evaluateMain!(((electron: typeof import('electron')) => {
      const { webContents } = electron;
      const guest = webContents.getAllWebContents().find((wc) => {
        try { return wc.getType() === 'webview' && wc.getURL().includes('esc-child-page'); } catch { return false; }
      });
      if (!guest) return { error: 'no child guest for 2nd esc' };
      guest.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' } as any);
      guest.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' } as any);
      return { ok: true };
    }) as any);
    console.log('[page-host-esc] child second-esc:', JSON.stringify(send2));

    // EXPECTED: switcher appears AND the child-content window survives.
    let switcherAppeared = true;
    const switcher = await app.getWindow('windows/windows.html', 8000).catch(() => null);
    if (!switcher) switcherAppeared = false;

    const childSurvived = await app.evaluateMain!(((electron: typeof import('electron'), id: number) => {
      const { BrowserWindow } = electron;
      const w = BrowserWindow.getAllWindows().find((x) => x.id === id);
      return !!w && !w.isDestroyed();
    }) as any, childHostId);

    console.log(`[page-host-esc] CHILD RESULT switcherAppeared=${switcherAppeared} childSurvived=${childSurvived}`);

    expect(switcherAppeared, 'switcher should appear on ESC for a child-content window').toBe(true);
    expect(childSurvived, 'child-content window should survive ESC while app is OS-focused').toBe(true);
  });
});
