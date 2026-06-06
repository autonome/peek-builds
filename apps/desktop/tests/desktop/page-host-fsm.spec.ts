/**
 * Page-host FSM Phase 2 — drag/resize state tracking integration test.
 *
 * The unit tests in `tests/unit/page-fsm.test.js` cover the pure FSM in
 * isolation. This Playwright spec verifies the runtime adapter in
 * `app/page/page.js` actually dispatches DRAG_START/DRAG_END +
 * RESIZE_START/RESIZE_END at the right places, by reading
 * `window.__pageFsmState` after simulated input.
 *
 * If any of these break, page.js has lost a dispatch site and the FSM
 * is no longer the source of truth for the lifecycle. See
 * docs/page-host-state-machine.md.
 *
 * Run with: yarn test:grep "Page Host FSM"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { hybridFlagOn } from '../helpers/hybrid-page';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

test.describe('Page Host FSM @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('page-host-fsm'));

    await new Promise<void>((resolve) => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><body><h1>fsm</h1></body></html>');
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

  async function openPageHost(slug: string): Promise<Page> {
    const url = `http://127.0.0.1:${serverPort}/${slug}`;
    const result = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 800, height: 600 });
    }, url);
    expect(result.success).toBe(true);
    const pageWindow = await app.getWindow(slug, 15000);
    await pageWindow.waitForFunction(() => (window as any).__pageModuleReady === true);
    return pageWindow;
  }

  async function fsmState(pageWindow: Page): Promise<string> {
    return await pageWindow.evaluate(() => (window as any).__pageFsmState);
  }

  test('initial state is NORMAL after init.complete (non-maximized url params)', async () => {
    test.skip(await hybridFlagOn(app), 'deferred to Stage B: page-host FSM drag/resize/maximize re-home is Stage B');
    const pageWindow = await openPageHost('fsm-initial');
    expect(await fsmState(pageWindow)).toBe('NORMAL');
  });

  test('drag round-trip: NORMAL → DRAGGING → NORMAL', async () => {
    test.skip(await hybridFlagOn(app), 'deferred to Stage B: page-host FSM drag/resize/maximize re-home is Stage B');
    const pageWindow = await openPageHost('fsm-drag');
    expect(await fsmState(pageWindow)).toBe('NORMAL');

    // Simulate navbar mousedown → mousemove → mouseup. Use real DOM
    // events so the page.js handlers run end-to-end.
    await pageWindow.evaluate(() => {
      const nav = document.getElementById('navbar')!;
      nav.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, button: 0, screenX: 100, screenY: 100,
      }));
    });
    expect(await fsmState(pageWindow)).toBe('DRAGGING');

    await pageWindow.evaluate(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    });
    expect(await fsmState(pageWindow)).toBe('NORMAL');
  });

  test('resize round-trip: NORMAL → RESIZING → NORMAL', async () => {
    test.skip(await hybridFlagOn(app), 'deferred to Stage B: page-host FSM drag/resize/maximize re-home is Stage B');
    const pageWindow = await openPageHost('fsm-resize');
    expect(await fsmState(pageWindow)).toBe('NORMAL');

    // pointerdown on the SE resize handle → pointerup.
    await pageWindow.evaluate(() => {
      const handle = document.getElementById('resize-se')!;
      handle.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, button: 0, pointerId: 1, screenX: 100, screenY: 100,
      }));
    });
    expect(await fsmState(pageWindow)).toBe('RESIZING');

    await pageWindow.evaluate(() => {
      const handle = document.getElementById('resize-se')!;
      handle.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, button: 0, pointerId: 1,
      }));
    });
    expect(await fsmState(pageWindow)).toBe('NORMAL');
  });

  test('maximize via dblclick transitions NORMAL → MAXIMIZED', async () => {
    test.skip(await hybridFlagOn(app), 'deferred to Stage B: page-host FSM drag/resize/maximize re-home is Stage B');
    const pageWindow = await openPageHost('fsm-max');
    expect(await fsmState(pageWindow)).toBe('NORMAL');

    await pageWindow.evaluate(() => {
      const nav = document.getElementById('navbar')!;
      nav.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await pageWindow.waitForFunction(() => (window as any).__pageFsmState === 'MAXIMIZED');
  });

  test('drag-out-of-maximize: MAXIMIZED → DRAGGING_OUT_OF_MAXIMIZED → NORMAL (never re-enters MAXIMIZED)', async () => {
    test.skip(await hybridFlagOn(app), 'deferred to Stage B: page-host FSM drag/resize/maximize re-home is Stage B');
    const pageWindow = await openPageHost('fsm-dragout');

    // First maximize.
    await pageWindow.evaluate(() => {
      const nav = document.getElementById('navbar')!;
      nav.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await pageWindow.waitForFunction(() => (window as any).__pageFsmState === 'MAXIMIZED');

    // Now mousedown on navbar → drag-out path.
    await pageWindow.evaluate(() => {
      const nav = document.getElementById('navbar')!;
      nav.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, button: 0, screenX: 200, screenY: 200,
      }));
    });
    expect(await fsmState(pageWindow)).toBe('DRAGGING_OUT_OF_MAXIMIZED');

    await pageWindow.evaluate(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    });
    // Drag-out always lands in NORMAL — must NOT re-enter MAXIMIZED.
    expect(await fsmState(pageWindow)).toBe('NORMAL');
  });
});
