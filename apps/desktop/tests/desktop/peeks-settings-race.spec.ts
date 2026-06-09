/**
 * Peeks cold-wake settings race — sibling of slides-settings-race.spec.ts.
 *
 * Same bug class: `features/peeks/background.js` registers its `cli:peek-open`
 * wake handler synchronously, but the handler BODY read `currentSettings` while
 * it was still the bundled DEFAULTS (only keyNum 0 enabled) — the wake publish
 * that spawns the lazy tile arrives at FSM 'ready', which beats the datastore
 * loadSettings(). So a user peek on any other key did nothing on the FIRST press
 * after startup, then worked on the second. Fixed by guarding the handler body
 * on a `settingsLoaded` promise.
 *
 * Seeds a NON-default-enabled key (3) and asserts the cold first press opens it.
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

const windowUrlExists = (needle: string): Promise<boolean> =>
  app.evaluateMain!(((electron: typeof import('electron'), n: string) => {
    const { BrowserWindow } = electron;
    return BrowserWindow.getAllWindows().some((w) => {
      try { return w.webContents.getURL().includes(n); } catch { return false; }
    });
  }) as any, needle) as Promise<boolean>;

/** Publish `cli:peek-open` with `{ args: [keyNum] }` — the registrar's wake output. */
const firePeekOpen = (keyNum: string): Promise<void> =>
  app.evaluateMain!(((_e: unknown, k: string) => {
    (globalThis as any).__peek_test.publishSystemTopic('cli:peek-open', { args: [k] });
  }) as any, keyNum);

const waitPeeksReady = (): Promise<unknown> =>
  app.evaluateMain!(((_e: unknown) => {
    return (globalThis as any).__peek_test.waitForTileState('peeks', 'ready', 15000);
  }) as any);

test.describe('Peeks cold-wake settings race @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('peeks-settings-race'));

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

    // Seed a peek on key 3 ENABLED — a key that is `enabled: false` in defaults
    // (only key 0 is). Written straight to the datastore while peeks is cold.
    const peekAddr = `http://127.0.0.1:${serverPort}/peek-three`;
    const seed = await bgWindow.evaluate(async (addr: string) => {
      const api = (window as any).app;
      return await api.datastore.setRow('feature_settings', 'peeks:items', {
        featureId: 'peeks',
        key: 'items',
        value: JSON.stringify([
          {
            keyNum: 3,
            title: 'Peek three',
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
    }, peekAddr);
    expect(seed.success).toBe(true);
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  test('first cold wake for a saved-but-non-default-enabled key opens the peek', async () => {
    expect(await windowUrlExists('peek://peeks/')).toBe(false);

    const readyPromise = waitPeeksReady();
    await firePeekOpen('3');

    const transition = (await readyPromise) as { tileId: string; to: string };
    expect(transition.tileId).toBe('peeks');
    expect(transition.to).toBe('ready');

    const peekWindow = await app.getWindow('peek-three', 15000);
    expect(peekWindow).toBeTruthy();
  });
});
