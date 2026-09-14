/**
 * Editing a slide's URL in the Features Manager Options panel must take
 * effect on the next hotkey trigger, in the SAME session (no restart).
 *
 * Reported: editing a slide's `address` in Features Manager → Options never
 * takes effect — the slide keeps opening the old address, even after a full
 * app restart. Two candidate causes were on the table (a `grant.tileId` /
 * `feature_settings.featureId` namespace mismatch between the write path —
 * `features-manager/manage.js` `createFeatureSettingsStore()` — and the read
 * path — `features/slides/background.js` `loadSettings()` via
 * `tile:settings:get` in `main/tile-ipc.ts`; and a row-`id` convention skew
 * between the two writers). Both were checked directly against
 * `main/tile-launcher.ts` (`grant.tileId` is unconditionally `manifest.id`,
 * i.e. `'slides'`, matching the UI's namespace) and against the unique index
 * on `feature_settings(featureId, key)` (which makes the row-`id` skew
 * harmless — `INSERT OR REPLACE` always resolves to one row per
 * (featureId, key) regardless of which `id` string wrote it last).
 *
 * This test drives the REAL Options UI end to end — not a synthetic
 * datastore write — so it also catches a break anywhere else on the path: the
 * `<peek-input>` 'change' wiring, `renderFeatureOptions()`'s `save()`, the
 * `slides:settings-changed` publish/subscribe round trip, or the background
 * tile's re-read in `reinit()`.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let manager: Page;
let server: http.Server;
let serverPort: number;

// The 'Up' edge is enabled in the bundled defaults (features/slides/config.js
// + settings-schema.json), so no checkbox interaction is needed — only the
// address field itself is under test.
const EDGE = 'Up';

test.describe('Slides Options address edit takes effect live @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('slides-options-address-live-update'));

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

    await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://features-manager/manage.html', {
        key: 'features-manage', width: 900, height: 650,
      });
    });
    manager = await app.getWindow('features-manager/manage.html', 15000);
    await manager.waitForLoadState('domcontentloaded');

    await manager.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll('.feature-card'));
      return cards.some(c => (c as HTMLElement).dataset.featureId === 'slides');
    }, { timeout: 15000 });
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  /** Publish `cli:slide-open` with `{ args: [edge] }` — the hotkey's wake output. */
  const fireSlideOpen = (edge: string): Promise<void> =>
    app.evaluateMain!(((_e: unknown, e: string) => {
      (globalThis as any).__peek_test.publishSystemTopic('cli:slide-open', { args: [e] });
    }) as any, edge);

  test('editing address via Options, then pressing the hotkey, opens the new URL with no restart', async () => {
    const oldAddress = `http://127.0.0.1:${serverPort}/old-address`;
    const newAddress = `http://127.0.0.1:${serverPort}/new-address`;

    // 1. Seed the Up slide with a known starting address, through the same
    //    datastore shape manage.js's createFeatureSettingsStore() writes
    //    (featureId='slides', key='items', row id 'slides:items').
    await bgWindow.evaluate(async (addr) => {
      const api = (window as any).app;
      const items = [{
        screenEdge: 'Up', title: 'Slide from top', address: addr,
        persistState: false, keepLive: false, allowSound: false,
        height: 768, width: 1024, enabled: true,
      }];
      await api.datastore.setRow('feature_settings', 'slides:items', {
        featureId: 'slides', key: 'items', value: JSON.stringify(items), updatedAt: Date.now(),
      });
      await api.datastore.setRow('feature_settings', 'slides:prefs', {
        featureId: 'slides', key: 'prefs',
        value: JSON.stringify({ shortcutKeyPrefix: 'Option+' }), updatedAt: Date.now(),
      });
    }, oldAddress);

    // 2. Trigger the hotkey once to prove the seed took, and to wake the lazy
    //    tile before editing through the UI. Slides open as hybrid page-hosts
    //    (BaseWindow), so match via the Playwright Page registry (app.getWindow)
    //    rather than BrowserWindow.getAllWindows(), which only sees legacy
    //    BrowserWindows.
    await fireSlideOpen(EDGE);
    const oldSlideWindow = await app.getWindow('old-address', 15000);
    expect(oldSlideWindow, 'the seeded old-address slide must open').toBeTruthy();

    // 3. Expand the slides Options panel — the exact UI surface the report
    //    names — and edit the Up slide's address field.
    await manager.evaluate(() => {
      const card = Array.from(document.querySelectorAll('.feature-card'))
        .find(c => (c as HTMLElement).dataset.featureId === 'slides');
      (card?.querySelector('.feature-options-toggle') as HTMLElement | null)?.click();
    });

    await manager.waitForFunction(() => {
      const card = Array.from(document.querySelectorAll('.feature-card'))
        .find(c => (c as HTMLElement).dataset.featureId === 'slides');
      const panel = card?.querySelector('.feature-options-panel') as HTMLElement | null;
      return !!panel && panel.style.display !== 'none' && !!panel.querySelector('.item-card');
    }, { timeout: 10000 });

    await manager.evaluate((addr) => {
      const card = Array.from(document.querySelectorAll('.feature-card'))
        .find(c => (c as HTMLElement).dataset.featureId === 'slides');
      const panel = card?.querySelector('.feature-options-panel') as HTMLElement;
      const firstItemCard = panel.querySelector('.item-card') as HTMLElement;
      const group = Array.from(firstItemCard.querySelectorAll('.form-group'))
        .find(g => g.querySelector('label')?.textContent === 'address') as HTMLElement;
      const input = group.querySelector('peek-input') as any;
      input.value = addr;
      const native = input.shadowRoot?.querySelector('input') as HTMLInputElement | null;
      (native ?? input).dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }, newAddress);

    // 4. Confirm the edit actually landed in feature_settings (proves save()
    //    ran) before asserting on the live-reload side.
    await expect.poll(async () => {
      return await bgWindow.evaluate(async () => {
        const api = (window as any).app;
        const table = await api.datastore.getTable('feature_settings');
        const row = table.data?.['slides:items'];
        if (!row) return null;
        const items = JSON.parse(row.value);
        return items[0]?.address ?? null;
      });
    }, { timeout: 10000, message: 'the Options edit never persisted to feature_settings' }).toBe(newAddress);

    // 5. Trigger the hotkey again, same session, no restart — must open the
    //    NEW address, not the old one.
    await fireSlideOpen(EDGE);
    const newSlideWindow = await app.getWindow('new-address', 15000);
    expect(
      newSlideWindow,
      'the slide must open the new address after the Options edit, with no restart',
    ).toBeTruthy();
  });
});
