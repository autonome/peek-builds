/**
 * A slide's edited `address` must survive a full app restart: the slide must
 * open the NEW address on the first hotkey press of the new session, not the
 * bundled default or a stale value.
 *
 * Companion to slides-options-address-live-update.spec.ts, which pins the
 * SAME-SESSION path (edit → settings-changed → reinit() → re-read). This
 * spec covers the other half of the original report ("the slide keeps
 * opening the old address, even after a full app restart") — the boot-time
 * path: `features/slides/background.js` `init()` → `loadSettings()` via
 * `tile:settings:get` in `main/tile-ipc.ts`, scoped by `grant.tileId`
 * (confirmed to be the literal `'slides'`, matching the write path's
 * `featureId`). `data-persistence.spec.ts` already proves the DB row itself
 * survives a restart; this spec proves the LIVE feature actually reads and
 * acts on that row after a cold boot, not just that the row exists.
 */
import { test, expect, launchDesktopApp } from '../fixtures/desktop-app';
import { sleep } from '../helpers/window-utils';
import http from 'http';

test.describe('Slides address edit survives a full app restart @desktop', () => {
  test('slide opens the edited address on the first hotkey press after restart', async () => {
    const PROFILE = 'test-slides-restart-address-' + Date.now();

    let server: http.Server;
    let serverPort: number;
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

    const editedAddress = `http://127.0.0.1:${serverPort}/edited-address`;

    // ── PHASE 1: write the edit exactly as manage.js save() does, then close ──
    let app = await launchDesktopApp(PROFILE);
    let bgWindow = await app.getBackgroundWindow();

    const write = await bgWindow.evaluate(async (addr) => {
      const api = (window as any).app;
      const items = [{
        screenEdge: 'Up', title: 'Slide from top', address: addr,
        persistState: false, keepLive: false, allowSound: false,
        height: 768, width: 1024, enabled: true,
      }];
      const r1 = await api.datastore.setRow('feature_settings', 'slides:items', {
        featureId: 'slides', key: 'items', value: JSON.stringify(items), updatedAt: Date.now(),
      });
      const r2 = await api.datastore.setRow('feature_settings', 'slides:prefs', {
        featureId: 'slides', key: 'prefs',
        value: JSON.stringify({ shortcutKeyPrefix: 'Option+' }), updatedAt: Date.now(),
      });
      return { r1, r2 };
    }, editedAddress);
    expect(write.r1.success).toBe(true);
    expect(write.r2.success).toBe(true);

    await sleep(500);
    await app.close();
    await sleep(1000);

    // ── PHASE 2: cold restart, same profile — first hotkey press must open
    //    the edited address, not the bundled default ('http://localhost/'). ──
    app = await launchDesktopApp(PROFILE);
    bgWindow = await app.getBackgroundWindow();

    await app.evaluateMain!(((_e: unknown, e: string) => {
      (globalThis as any).__peek_test.publishSystemTopic('cli:slide-open', { args: [e] });
    }) as any, 'Up');

    const slideWindow = await app.getWindow('edited-address', 15000);
    expect(
      slideWindow,
      'the slide must open the edited address on the first press after a restart',
    ).toBeTruthy();

    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
