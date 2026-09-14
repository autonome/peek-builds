/**
 * Does a restart bring the slide's OLD address back, when the slide window
 * was left open (loaded) at the time the address was edited and the app was
 * later closed with that window still live?
 *
 * Raised as the primary reproduction path for "editing a slide's URL never
 * takes effect... even after a full app restart" — session restore captures
 * each surviving window's LIVE url at quit time (`session.ts`
 * `buildSessionSaveWindows`: `url = win.webContents.getURL()` /
 * `hybridEntry.url()`) and reopens exactly that url on the next launch,
 * independent of `feature_settings`. If the slide window was still open
 * (never re-triggered after the edit) when the app quit, its captured url is
 * the OLD address; if session restore recreates that window on next launch,
 * the user sees the old address again with NO hotkey press at all — matching
 * "even after a restart" better than a cold-boot scenario where no window is
 * open to restore in the first place (see `slides-address-survives-restart.spec.ts`,
 * which only covers the cold case).
 *
 * Read before writing this spec: `session-projection.ts` `serializeSession()`
 * — the save projection every window passes through before it can land in
 * the snapshot — skips modal windows unconditionally:
 *
 *   // Skip modal windows
 *   if (w.params.modal) { continue; }
 *
 * `features/slides/background.js` `executeItem()`'s `openNewSlide()` always
 * passes `modal: true` in its window-open params. So a slide window can
 * never appear in a saved session snapshot in the first place — the
 * "restore reopens the stale window" mechanism doesn't have a window to act
 * on. This spec verifies that directly (inspecting the actual persisted
 * snapshot content, not just behavior) using the deterministic
 * `__peek_test.forceSaveSession()` / `forceRestoreSession()` bridge — the
 * same one `session-restore-page-host.spec.ts` uses — which round-trips a
 * save+restore cycle within one app instance instead of a real process
 * relaunch.
 *
 * Run with:
 *   yarn test:grep "restart with the slide window live"
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

const EDGE = 'Up';

test.describe('Slides address edit survives a restart with the window left open @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('slides-session-restore-address'));

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

  const bridgePresent = async (): Promise<boolean> =>
    app.evaluateMain!(
      () =>
        Boolean((globalThis as any).__peekHybridOverlayTest) &&
        Boolean((globalThis as any).__peek_test),
    ) as Promise<boolean>;

  const fireSlideOpen = (edge: string): Promise<void> =>
    app.evaluateMain!(((_e: unknown, e: string) => {
      (globalThis as any).__peek_test.publishSystemTopic('cli:slide-open', { args: [e] });
    }) as any, edge);

  const waitHybridForUrl = (url: string, excludeIds: number[], timeoutMs = 15000): Promise<number | null> =>
    app.evaluateMain!(((_e: unknown, args: { u: string; ex: number[]; t: number }) =>
      (globalThis as any).__peekHybridOverlayTest.waitHybridForUrl(args.u, args.ex, args.t)) as any,
      { u: url, ex: excludeIds, t: timeoutMs },
    ) as Promise<number | null>;

  const closeWindowId = (id: number): Promise<void> =>
    bgWindow.evaluate(async (wid: number) => {
      await (window as any).app.window.close(wid);
    }, id);

  const seedSlide = (address: string): Promise<void> =>
    bgWindow.evaluate(async (addr) => {
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
    }, address);

  const editAddressViaOptionsUi = async (newAddress: string): Promise<void> => {
    const wasExpanded = await manager.evaluate(() => {
      const card = Array.from(document.querySelectorAll('.feature-card'))
        .find(c => (c as HTMLElement).dataset.featureId === 'slides');
      const panel = card?.querySelector('.feature-options-panel') as HTMLElement | null;
      return !!panel && panel.style.display !== 'none';
    });
    if (!wasExpanded) {
      await manager.evaluate(() => {
        const card = Array.from(document.querySelectorAll('.feature-card'))
          .find(c => (c as HTMLElement).dataset.featureId === 'slides');
        (card?.querySelector('.feature-options-toggle') as HTMLElement | null)?.click();
      });
    }

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
  };

  /** Parsed `feature_settings` (featureId='session', key='snapshot') windows array. */
  const readSavedSnapshotWindows = (): Promise<Array<{ url: string }>> =>
    bgWindow.evaluate(async () => {
      const api = (window as any).app;
      const table = await api.datastore.getTable('feature_settings');
      const row = table.data?.['session-snapshot'];
      if (!row) return [];
      const snapshot = JSON.parse(row.value);
      return snapshot.windows || [];
    });

  test('editing the address with the slide window left open, then a restart with that window live: old address does not come back', async () => {
    test.skip(!(await bridgePresent()), 'no hybrid overlay / test bridge in this configuration');

    const oldAddress = `http://127.0.0.1:${serverPort}/restore-old-address`;
    const newAddress = `http://127.0.0.1:${serverPort}/restore-new-address`;

    await seedSlide(oldAddress);

    // Load the slide (matches the real-world report: the slide had already
    // been loaded before the address was edited).
    await fireSlideOpen(EDGE);
    const oldWindowId = await waitHybridForUrl(oldAddress, []);
    expect(oldWindowId, 'the old-address slide must open').not.toBeNull();

    // Edit the address WITHOUT re-triggering the hotkey — the still-open
    // window keeps showing the old address (reinit() never touches it; see
    // slides-settings-changed-keeps-host.spec.ts). This is the live state at
    // the moment the app quits in the real report.
    await editAddressViaOptionsUi(newAddress);

    // Quit-time save. If a slide window could land in the snapshot, this is
    // the point its LIVE (old) url would be captured.
    await app.evaluateMain!((() => (globalThis as any).__peek_test.forceSaveSession()) as any);

    const savedWindows = await readSavedSnapshotWindows();
    const savedSlideEntries = savedWindows.filter(
      (w) => w.url === oldAddress || w.url === newAddress || w.url.includes('restore-'),
    );
    expect(
      savedSlideEntries,
      'the slide window (opened with modal:true) must be excluded from the ' +
        'session snapshot by the "Skip modal windows" rule in session-projection.ts ' +
        '— so there is no captured old-address entry for restore to bring back',
    ).toEqual([]);

    // Simulate the process ending: the old window is gone (a real quit kills
    // every window; forceRestoreSession needs the same starting condition).
    await closeWindowId(oldWindowId!);

    const restoreResult = await app.evaluateMain!((() =>
      (globalThis as any).__peek_test.forceRestoreSession()) as any) as
      { restored: number; failed: number; total: number };

    // No slide window should have auto-reappeared at all — old OR new
    // address — since none was ever in the snapshot to restore.
    const reappearedOld = await waitHybridForUrl(oldAddress, [], 3000);
    expect(reappearedOld, 'the OLD address must not auto-reappear from session restore').toBeNull();
    const reappearedNew = await waitHybridForUrl(newAddress, [], 1000);
    expect(reappearedNew, 'the NEW address must not auto-reappear either — nothing should restore').toBeNull();

    // Now the equivalent of "the user presses the hotkey after the restart":
    // this must read feature_settings fresh and open the EDITED address, not
    // the one that was live when the app quit.
    await fireSlideOpen(EDGE);
    const postRestoreWindowId = await waitHybridForUrl(newAddress, []);
    expect(
      postRestoreWindowId,
      'after the restart, the hotkey must open the edited address — feature_settings, ' +
        'not stale session/window state, is what a fresh hotkey press reads',
    ).not.toBeNull();
  });
});
