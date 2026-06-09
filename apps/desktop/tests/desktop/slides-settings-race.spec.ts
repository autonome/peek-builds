/**
 * Slides cold-wake settings race (peek: slide hotkey does nothing the first
 * press after startup).
 *
 * Repro reported from `yarn start`: pressing a slide hotkey for an edge that is
 * enabled ONLY in the user's saved settings (not in the bundled defaults — where
 * only 'Up' is enabled) does nothing the FIRST time, then works the second.
 *
 * Root cause: `features/slides/background.js` registers its `cli:slide-open`
 * wake handler synchronously (good — it's in time for the wake publish), but the
 * handler BODY reads `currentSettings`, which is still the bundled DEFAULTS until
 * the separate `await loadSettings()` in init() resolves. The lazy load-on-
 * dispatch hook delivers the wake publish at the tile's FSM 'ready' (a
 * setTimeout(0) after api.initialize()), which beats the datastore-backed
 * loadSettings round-trips. So the first, tile-spawning press runs the handler
 * against defaults — where the user's edge is `enabled: false` — and silently
 * returns. The fix guards the handler body on a `settingsLoaded` promise.
 *
 * This test seeds a NON-default-enabled edge ('Down') in the datastore, leaves
 * slides COLD, then fires the wake for that edge ONCE and asserts the slide
 * opens — which it must on the FIRST press.
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

/** True iff any live BrowserWindow's URL contains the given substring. */
const windowUrlExists = (needle: string): Promise<boolean> =>
  app.evaluateMain!(((electron: typeof import('electron'), n: string) => {
    const { BrowserWindow } = electron;
    return BrowserWindow.getAllWindows().some((w) => {
      try { return w.webContents.getURL().includes(n); } catch { return false; }
    });
  }) as any, needle) as Promise<boolean>;

/** Publish `cli:slide-open` with `{ args: [edge] }` — the registrar's wake output. */
const fireSlideOpen = (edge: string): Promise<void> =>
  app.evaluateMain!(((_e: unknown, e: string) => {
    (globalThis as any).__peek_test.publishSystemTopic('cli:slide-open', { args: [e] });
  }) as any, edge);

/** Resolve when the `slides` tile transitions INTO `ready` (FSM-mirror topic). */
const waitSlidesReady = (): Promise<unknown> =>
  app.evaluateMain!(((_e: unknown) => {
    return (globalThis as any).__peek_test.waitForTileState('slides', 'ready', 15000);
  }) as any);

test.describe('Slides cold-wake settings race @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('slides-settings-race'));

    // Loadable, distinct slide address (an unresolvable host makes window.open
    // return success:false).
    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>${req.url}</title></head><body>${req.url}</body></html>`);
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });

    await waitForExtensionsReady(bgWindow, 15000);

    // Seed saved settings with a 'Down' slide ENABLED — an edge that is
    // `enabled: false` in the bundled defaults. Written straight to the
    // datastore (slides is cold; this does NOT wake it), so the cold wake's
    // loadSettings() picks it up.
    const downAddr = `http://127.0.0.1:${serverPort}/down-slide`;
    const seed = await bgWindow.evaluate(async (addr: string) => {
      const api = (window as any).app;
      return await api.datastore.setRow('feature_settings', 'slides:items', {
        featureId: 'slides',
        key: 'items',
        value: JSON.stringify([
          {
            screenEdge: 'Down',
            title: 'Down slide',
            address: addr,
            persistState: false,
            keepLive: false,
            allowSound: false,
            height: 400,
            width: 600,
            enabled: true,
          },
        ]),
        updatedAt: Date.now(),
      });
    }, downAddr);
    expect(seed.success).toBe(true);
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  test('first cold wake for a saved-but-non-default-enabled edge opens the slide', async () => {
    // Precondition: slides still cold (seeding the datastore must not wake it).
    expect(await windowUrlExists('peek://slides/')).toBe(false);

    // Arm the FSM observer before firing so the cold READY transition can't
    // race ahead.
    const readyPromise = waitSlidesReady();

    // The FIRST press for the user's 'Down' hotkey — the one that spawns the
    // lazy tile. With the cold-settings race, this used to silently no-op.
    await fireSlideOpen('Down');

    const transition = (await readyPromise) as { tileId: string; to: string };
    expect(transition.tileId).toBe('slides');
    expect(transition.to).toBe('ready');

    // The slide for edge 'Down' must open on this FIRST press. getWindow's
    // timeout is a failure-deadline, not a settle-wait.
    const slideWindow = await app.getWindow('down-slide', 15000);
    expect(slideWindow).toBeTruthy();
  });
});
