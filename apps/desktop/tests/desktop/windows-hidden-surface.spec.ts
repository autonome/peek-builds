/**
 * Hidden windows stay out of window lists.
 *
 * `api.window.list` (`main/tile-ipc.ts`, the `tile:window:list` handler)
 * lists only windows on screen unless the caller passes `includeHidden: true`.
 * Every user-facing list built on it takes the default, so a hidden window
 * (here one hidden with `api.window.hide`; a dismissed peek or slide kept
 * alive is hidden the same way) is absent from:
 *   - the default listing itself, while `includeHidden: true` still finds it;
 *   - the Windows switcher (`features/windows/windows.js loadWindows`);
 *   - "save windows to group" (`features/groups/home.js saveToGroup`, the
 *     groups noun's create, i.e. `new group <name>`).
 * The switcher's hidden-windows toggle (off on every opening) lists hidden
 * windows dimmed with a Hidden badge; clicking one shows it.
 * App chrome (the page-host chrome overlay, a desktop marker) is listed only
 * with `includeHidden: true`, and gets a switcher card only with the toggle
 * pressed, which cards every window, on screen or not, whatever its role.
 *
 *   yarn test:grep "Hidden windows stay out of window lists"
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';
import http from 'http';

test.describe('Hidden windows stay out of window lists @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let server: http.Server;
  let base: string;
  let shownId: number;
  let hiddenId: number;

  const listIds = async (opts: Record<string, unknown>): Promise<number[]> => {
    const r = await bgWindow.evaluate(
      async (o: Record<string, unknown>) => await (window as any).app.window.list(o),
      opts,
    );
    expect(r.success).toBe(true);
    return (r.windows || []).map((w: { id: number }) => w.id);
  };

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('windows-hidden'));
    await waitForExtensionsReady(bgWindow, 15000);

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>${req.url}</title></head><body>page</body></html>`);
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
        resolve();
      });
    });

    const open = async (url: string): Promise<number> => {
      const r = await bgWindow.evaluate(
        async (u: string) => await (window as any).app.window.open(u, { width: 500, height: 400 }),
        url,
      );
      expect(r.success).toBe(true);
      return r.id;
    };
    shownId = await open(`${base}/shown`);
    hiddenId = await open(`${base}/hidden`);

    // Both are listed while on screen, so an absence later is the hide's doing.
    await expect.poll(() => listIds({}), { timeout: 10000 }).toEqual(expect.arrayContaining([shownId, hiddenId]));

    const hideRes = await bgWindow.evaluate(
      async (id: number) => await (window as any).app.window.hide(id),
      hiddenId,
    );
    expect(hideRes.success !== false).toBe(true);
  });

  test.afterAll(async () => {
    for (const id of [shownId, hiddenId]) {
      if (id == null) continue;
      try {
        await bgWindow.evaluate(async (wid: number) => await (window as any).app.window.close(wid), id);
      } catch { /* app may be gone */ }
    }
    if (server) server.close();
    if (app) await app.close();
  });

  test('the default listing leaves a hidden window out; includeHidden finds it', async () => {
    await expect.poll(() => listIds({ includeInternal: true }), { timeout: 10000 }).not.toContain(hiddenId);
    expect(await listIds({})).toContain(shownId);

    const all = await bgWindow.evaluate(
      async () => await (window as any).app.window.list({ includeInternal: true, includeHidden: true }),
    );
    const found = (all.windows || []).find((w: { id: number }) => w.id === hiddenId);
    expect(found, 'includeHidden: true lists the hidden window').toBeTruthy();
    expect(found.visible).toBe(false);
  });

  test('the Windows switcher shows no card for a hidden window', async () => {
    await app.evaluateMain!((_e: unknown) => {
      (globalThis as any).__peek_test.publishCmdExecute('windows');
    });
    const switcher = await app.getWindow('windows/windows.html', 15000);
    expect(switcher).toBeTruthy();
    await switcher.waitForLoadState('domcontentloaded');
    await switcher.waitForSelector(`peek-card[data-window-id="${shownId}"]`, { timeout: 10000 });
    expect(await switcher.locator(`peek-card[data-window-id="${hiddenId}"]`).count()).toBe(0);

    await switcher.evaluate(() => window.close());
    await expect.poll(() => switcher.isClosed(), { timeout: 5000 }).toBe(true);
  });

  test('saving windows to a group leaves a hidden window out', async () => {
    const groupName = `hidden-skip-${Date.now()}`;
    const result = await bgWindow.evaluate(async (name: string) => {
      const api = (window as any).app;
      const request = (topic: string, msg: Record<string, unknown>, ms: number): Promise<any> =>
        new Promise((resolve) => {
          const resultTopic = `${topic}:result:${Date.now()}:${Math.random()}`;
          api.subscribe(resultTopic, (r: unknown) => resolve(r));
          api.publish(topic, { ...msg, expectResult: true, resultTopic });
          setTimeout(() => resolve(null), ms);
        });
      // The groups tile is lazy: a declared command wakes it. `pin` with no
      // group open answers with an error and changes nothing.
      await request('cmd:execute:pin', { search: '', params: [] }, 20000);
      // The noun registers once the tile's init runs; retry until it answers.
      for (let i = 0; i < 20; i++) {
        const r = await request('noun:create:groups', { search: name, params: [] }, 1000);
        if (r) return r;
      }
      return { error: 'groups noun never answered' };
    }, groupName);
    expect(result?.success, JSON.stringify(result)).toBe(true);

    const urls = await bgWindow.evaluate(async (name: string) => {
      const api = (window as any).app;
      const tags = await api.datastore.getTagsByFrecency();
      const tag = (tags.data || []).find((t: { name: string }) => t.name === name);
      if (!tag) return null;
      const items = await api.datastore.getItemsByTag(tag.id);
      return (items.data || []).map((i: { content?: string }) => i.content || '');
    }, groupName);
    expect(urls, 'the group tag was created').not.toBeNull();
    expect(urls).toContain(`${base}/shown`);
    expect(urls).not.toContain(`${base}/hidden`);
  });

  // App chrome is not a user window: the shared page-host chrome
  // (`hybrid-overlay.ts`) and a per-desktop marker window are left out of the
  // default listing and get no switcher card. With `includeHidden: true` and
  // the switcher's toggle pressed, every window is listed, chrome included,
  // on screen or not. Headless runs mint no markers
  // (`desktop-marker-manager.ts`), so the marker here is opened with the
  // manager's own options (`desktop-markers.ts markerOpenOptions`) and shown
  // the way a mint shows it.
  test('app chrome (page chrome overlay, desktop marker) is listed only with includeHidden', async () => {
    const overlayId = await app.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      const s = b ? b.overlayState() : null;
      return s ? s.id : null;
    });
    expect(overlayId, 'the shared page-host chrome exists while pages are open').not.toBeNull();

    const markerId = await bgWindow.evaluate(async () => {
      const api = (window as any).app;
      const r = await api.window.open('peek://spaces/signal.html', {
        role: 'signal', width: 2, height: 2, x: 0, y: 0,
        transparent: true, focusable: false, skipTaskbar: true, show: false,
      });
      if (!r?.success) return null;
      await api.window.show(r.id, { inactive: true });
      return r.id;
    });
    expect(markerId, 'marker window opened').not.toBeNull();

    try {
      // The marker is live and on screen, so its absence below is the chrome filter's doing.
      await expect.poll(async () => await bgWindow.evaluate(
        async (id: number) => (await (window as any).app.window.exists(id))?.exists ?? false,
        markerId,
      ), { timeout: 5000 }).toBe(true);

      // Without includeHidden, chrome is not listed.
      for (const opts of [{}, { includeInternal: true }]) {
        const ids = await listIds(opts);
        expect(ids, `overlay listed with ${JSON.stringify(opts)}`).not.toContain(overlayId);
        expect(ids, `marker listed with ${JSON.stringify(opts)}`).not.toContain(markerId);
      }
      // With it, on-screen chrome is listed too.
      const withHidden = await listIds({ includeInternal: true, includeHidden: true });
      expect(withHidden).toContain(overlayId);
      expect(withHidden).toContain(markerId);

      await app.evaluateMain!((_e: unknown) => {
        (globalThis as any).__peek_test.publishCmdExecute('windows');
      });
      const switcher = await app.getWindow('windows/windows.html', 15000);
      expect(switcher).toBeTruthy();
      await switcher.waitForLoadState('domcontentloaded');
      await switcher.waitForSelector(`peek-card[data-window-id="${shownId}"]`, { timeout: 10000 });
      for (const id of [overlayId, markerId]) {
        expect(await switcher.locator(`peek-card[data-window-id="${id}"]`).count()).toBe(0);
      }
      const toggleButton = switcher.locator('peek-button.hidden-toggle button');
      await toggleButton.click();
      await expect(toggleButton).toHaveAttribute('aria-pressed', 'true');
      // The hidden window's card appearing means the toggled listing has rendered.
      await expect(switcher.locator(`peek-card[data-window-id="${hiddenId}"]`)).toHaveCount(1, { timeout: 10000 });
      // Toggle on: on-screen chrome gets a card, undimmed, and the switcher's own window does not.
      for (const id of [overlayId, markerId]) {
        const card = switcher.locator(`peek-card[data-window-id="${id}"]`);
        await expect(card).toHaveCount(1);
        await expect(card.locator('.card-hidden-badge')).toHaveCount(0);
      }
      await switcher.evaluate(() => window.close());
      await expect.poll(() => switcher.isClosed(), { timeout: 5000 }).toBe(true);

      // Hidden, the marker is still left out of the default listing.
      const hideRes = await bgWindow.evaluate(
        async (id: number) => await (window as any).app.window.hide(id),
        markerId,
      );
      expect(hideRes.success !== false).toBe(true);
      await expect.poll(() => listIds({ includeInternal: true, includeHidden: true }), { timeout: 10000 })
        .toContain(markerId);
      for (const opts of [{}, { includeInternal: true }]) {
        expect(await listIds(opts), `hidden marker listed with ${JSON.stringify(opts)}`).not.toContain(markerId);
      }
    } finally {
      await bgWindow.evaluate(async (id: number) => await (window as any).app.window.close(id), markerId).catch(() => {});
    }
  });

  // A dismissed peek or slide (role 'quick-view', keepLive) is a user window
  // kept alive off screen: the chrome filter skips hidden windows, so the
  // toggle lists it.
  test('the switcher hidden-windows toggle lists a hidden quick-view window (a dismissed slide)', async () => {
    const slideId = await bgWindow.evaluate(async (url: string) => {
      const r = await (window as any).app.window.open(url, {
        role: 'quick-view', keepLive: true, modal: true, pageHost: true,
        key: `hidden-slide-${Date.now()}`, width: 500, height: 400,
      });
      return r?.success ? r.id : null;
    }, `${base}/slide`);
    expect(slideId, 'slide-style window opened').not.toBeNull();

    try {
      const hideRes = await bgWindow.evaluate(
        async (id: number) => await (window as any).app.window.hide(id),
        slideId,
      );
      expect(hideRes.success !== false).toBe(true);
      await expect.poll(async () => {
        const all = await bgWindow.evaluate(
          async () => await (window as any).app.window.list({ includeInternal: true, includeHidden: true }),
        );
        const w = (all.windows || []).find((x: { id: number }) => x.id === slideId);
        return w ? w.visible : null;
      }, { timeout: 10000 }).toBe(false);

      await app.evaluateMain!((_e: unknown) => {
        (globalThis as any).__peek_test.publishCmdExecute('windows');
      });
      const switcher = await app.getWindow('windows/windows.html', 15000);
      expect(switcher).toBeTruthy();
      await switcher.waitForLoadState('domcontentloaded');
      await switcher.waitForSelector(`peek-card[data-window-id="${shownId}"]`, { timeout: 10000 });
      expect(await switcher.locator(`peek-card[data-window-id="${slideId}"]`).count()).toBe(0);

      const toggleButton = switcher.locator('peek-button.hidden-toggle button');
      await toggleButton.click();
      await expect(toggleButton).toHaveAttribute('aria-pressed', 'true');

      const slideCard = switcher.locator(`peek-card[data-window-id="${slideId}"]`);
      await expect(slideCard).toHaveCount(1, { timeout: 10000 });
      await expect(slideCard).toHaveAttribute('data-hidden', 'true');
      await expect(slideCard.locator('.card-hidden-badge')).toHaveText('Hidden');

      await switcher.evaluate(() => window.close());
      await expect.poll(() => switcher.isClosed(), { timeout: 5000 }).toBe(true);
    } finally {
      await bgWindow.evaluate(async (id: number) => await (window as any).app.window.close(id), slideId).catch(() => {});
    }
  });

  // A hidden window of a chrome role ('panel') is not filtered by role: the
  // toggle lists it dimmed, and with the toggle off it gets no card.
  test('the switcher hidden-windows toggle lists a hidden chrome-role window (a hidden panel)', async () => {
    const panelId = await bgWindow.evaluate(async (url: string) => {
      const r = await (window as any).app.window.open(url, {
        role: 'panel', key: `hidden-panel-${Date.now()}`, width: 400, height: 300,
      });
      return r?.success ? r.id : null;
    }, `${base}/panel`);
    expect(panelId, 'panel-role window opened').not.toBeNull();

    try {
      const hideRes = await bgWindow.evaluate(
        async (id: number) => await (window as any).app.window.hide(id),
        panelId,
      );
      expect(hideRes.success !== false).toBe(true);
      await expect.poll(async () => {
        const all = await bgWindow.evaluate(
          async () => await (window as any).app.window.list({ includeInternal: true, includeHidden: true }),
        );
        const w = (all.windows || []).find((x: { id: number }) => x.id === panelId);
        return w ? w.visible : null;
      }, { timeout: 10000 }).toBe(false);

      await app.evaluateMain!((_e: unknown) => {
        (globalThis as any).__peek_test.publishCmdExecute('windows');
      });
      const switcher = await app.getWindow('windows/windows.html', 15000);
      expect(switcher).toBeTruthy();
      await switcher.waitForLoadState('domcontentloaded');
      await switcher.waitForSelector(`peek-card[data-window-id="${shownId}"]`, { timeout: 10000 });
      expect(await switcher.locator(`peek-card[data-window-id="${panelId}"]`).count()).toBe(0);

      const toggleButton = switcher.locator('peek-button.hidden-toggle button');
      await toggleButton.click();
      await expect(toggleButton).toHaveAttribute('aria-pressed', 'true');

      const panelCard = switcher.locator(`peek-card[data-window-id="${panelId}"]`);
      await expect(panelCard).toHaveCount(1, { timeout: 10000 });
      await expect(panelCard).toHaveAttribute('data-hidden', 'true');

      await switcher.evaluate(() => window.close());
      await expect.poll(() => switcher.isClosed(), { timeout: 5000 }).toBe(true);
    } finally {
      await bgWindow.evaluate(async (id: number) => await (window as any).app.window.close(id), panelId).catch(() => {});
    }
  });

  // Runs last: clicking the hidden card shows the window, which would change
  // what the tests above see.
  test('the switcher hidden-windows toggle lists a hidden window, and clicking it shows the window', async () => {
    await app.evaluateMain!((_e: unknown) => {
      (globalThis as any).__peek_test.publishCmdExecute('windows');
    });
    const switcher = await app.getWindow('windows/windows.html', 15000);
    expect(switcher).toBeTruthy();
    await switcher.waitForLoadState('domcontentloaded');
    await switcher.waitForSelector(`peek-card[data-window-id="${shownId}"]`, { timeout: 10000 });
    expect(await switcher.locator(`peek-card[data-window-id="${hiddenId}"]`).count()).toBe(0);

    const toggleButton = switcher.locator('peek-button.hidden-toggle button');
    await expect(toggleButton).toHaveAttribute('aria-pressed', 'false');
    await expect(toggleButton).toHaveAttribute('aria-label', 'Show hidden windows');
    await toggleButton.click();
    await expect(toggleButton).toHaveAttribute('aria-pressed', 'true');

    const hiddenCard = switcher.locator(`peek-card[data-window-id="${hiddenId}"]`);
    await expect(hiddenCard).toHaveCount(1, { timeout: 10000 });
    await expect(hiddenCard).toHaveAttribute('data-hidden', 'true');
    await expect(hiddenCard.locator('.card-hidden-badge')).toHaveText('Hidden');
    // The on-screen window is still listed, without the badge.
    await expect(switcher.locator(`peek-card[data-window-id="${shownId}"]`)).toHaveCount(1);
    await expect(switcher.locator(`peek-card[data-window-id="${shownId}"] .card-hidden-badge`)).toHaveCount(0);

    await hiddenCard.click();

    await expect.poll(async () => {
      const all = await bgWindow.evaluate(
        async () => await (window as any).app.window.list({ includeInternal: true, includeHidden: true }),
      );
      const w = (all.windows || []).find((x: { id: number }) => x.id === hiddenId);
      return w ? w.visible : null;
    }, { timeout: 10000 }).toBe(true);
    await expect.poll(() => switcher.isClosed(), { timeout: 5000 }).toBe(true);
  });
});
