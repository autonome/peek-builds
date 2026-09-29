/**
 * Does editing a slide's address while that slide's window is ALREADY OPEN
 * cause the still-open window to be reused (and keep showing the OLD
 * address) instead of a fresh window opening with the NEW one?
 *
 * Raised as an alternate reproduction path for the "editing a slide's URL
 * never takes effect" report: `features/slides/background.js` `executeItem()`
 * dedups on `slideWindows` (an in-renderer Map keyed by `${address}:${edge}`),
 * but that Map is NOT the identity authority — main's window registry is
 * (`findWindowsByKey`, `main.ts`, referenced in `executeItem`'s own comments).
 * The concern: if main's dedup matched on something address-INDEPENDENT (its
 * `trackingSource`/`trackingSourceId`, used for history/frecency tracking —
 * see `ipc.ts` `trackWindowLoad` call), an address edit wouldn't change the
 * dedup identity, and the still-open OLD window would be reused/refocused
 * instead of a new one opening with the edited address.
 *
 * Read before writing this spec, rather than assumed: `ipc.ts`'s window-open
 * handler consults TWO dedup lookups before creating a window — the hybrid
 * registry's `findHybridWindowsByKey(options.key, msg.source)`
 * (`hybrid-page-host-registry.ts`) and the legacy `findWindowsByKey(msg.source,
 * options.key)` (`main.ts`) for non-hybrid windows. Both match on
 * `e.key === key && e.source === source` — the exact `options.key` string,
 * which `executeItem`'s `openNewSlide()` sets to `${item.address}:${edge}`.
 * Neither consults `trackingSource`/`trackingSourceId` at all; those two
 * fields flow ONLY into `trackWindowLoad` (history/frecency), never into
 * window-identity dedup. So an address edit changes the dedup key on both
 * paths, and a still-open window for the OLD key cannot be matched by a
 * lookup for the NEW key — the code doesn't reproduce the raised concern.
 * This spec pins that with real window-identity assertions (not just "a
 * window with the new address exists somewhere") for both orderings, to
 * isolate whether leaving the old window open is the variable that matters.
 *
 * Each ordering gets its OWN app instance/profile (not a shared describe) —
 * a first draft shared one app across both tests and ordering B failed for a
 * reason that had nothing to do with the mechanism under test: the slides
 * tile, once awake from ordering A, only re-reads `feature_settings` on a
 * `slides:settings-changed` publish; a second test's raw `setRow` seed (no
 * publish) left the already-awake tile's in-memory `currentSettings` on
 * ordering A's last value, so `cli:slide-open` matched ordering A's still-open
 * window instead of anything from ordering B's seed. That is a fact about
 * seeding-while-warm, not about this spec's question — real edits always go
 * through `manage.js` `save()`, which always publishes. Giving each ordering
 * a cold app sidesteps it entirely and keeps the two orderings genuinely
 * isolated.
 *
 * Real macOS z-order / which-window-is-frontmost is unobservable in
 * macOS-headless (see `apps/desktop/CLAUDE.md`'s LESSON on the hybrid focus
 * cluster) — this spec asserts window IDENTITY (same id vs. a distinct new
 * id, and each window's registered address) via the hybrid test bridge,
 * not visual stacking order.
 *
 * Run with:
 *   yarn test:grep "old window left open"
 *   yarn test:grep "old window closed first"
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

const EDGE = 'Up';

function startServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        `<!DOCTYPE html><html><head><title>${req.url}</title></head>` +
          `<body><h1>${req.url}</h1></body></html>`,
      );
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

async function openManager(app: DesktopApp, bgWindow: Page): Promise<Page> {
  await bgWindow.evaluate(async () => {
    return await (window as any).app.window.open('peek://features-manager/manage.html', {
      key: 'features-manage', width: 900, height: 650,
    });
  });
  const manager = await app.getWindow('features-manager/manage.html', 15000);
  await manager.waitForLoadState('domcontentloaded');
  await manager.waitForFunction(() => {
    const cards = Array.from(document.querySelectorAll('.feature-card'));
    return cards.some(c => (c as HTMLElement).dataset.featureId === 'slides');
  }, { timeout: 15000 });
  return manager;
}

const bridgePresent = (app: DesktopApp): Promise<boolean> =>
  app.evaluateMain!(
    () =>
      Boolean((globalThis as any).__peekHybridOverlayTest) &&
      Boolean((globalThis as any).__peek_test),
  ) as Promise<boolean>;

/** Publish `cli:slide-open` with `{ args: [edge] }` — the hotkey's wake output. */
const fireSlideOpen = (app: DesktopApp, edge: string): Promise<void> =>
  app.evaluateMain!(((_e: unknown, e: string) => {
    (globalThis as any).__peek_test.publishSystemTopic('cli:slide-open', { args: [e] });
  }) as any, edge);

/** Wait for a NEW hybrid window whose requested address equals `url`, excluding `excludeIds`. */
const waitHybridForUrl = (app: DesktopApp, url: string, excludeIds: number[], timeoutMs = 15000): Promise<number | null> =>
  app.evaluateMain!(((_e: unknown, args: { u: string; ex: number[]; t: number }) =>
    (globalThis as any).__peekHybridOverlayTest.waitHybridForUrl(args.u, args.ex, args.t)) as any,
    { u: url, ex: excludeIds, t: timeoutMs },
  ) as Promise<number | null>;

const hybridWindowExists = (app: DesktopApp, id: number): Promise<boolean> =>
  app.evaluateMain!(((_e: unknown, wid: number) =>
    (globalThis as any).__peekHybridOverlayTest.hybridWindowExists(wid)) as any, id) as Promise<boolean>;

/** The requested addresses of every currently-registered hybrid window. */
const hybridAddresses = (app: DesktopApp): Promise<string[]> =>
  app.evaluateMain!(() =>
    (globalThis as any).__peekHybridOverlayTest.hybridAddresses()) as Promise<string[]>;

const closeWindowId = (bgWindow: Page, id: number): Promise<void> =>
  bgWindow.evaluate(async (wid: number) => {
    await (window as any).app.window.close(wid);
  }, id);

/** Seed the slides `items` row exactly as manage.js save() writes it, pre-tile-wake. */
const seedSlide = (bgWindow: Page, address: string): Promise<void> =>
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

/** Edit the FIRST rendered item-card's `address` field through the real Options UI. */
async function editAddressViaOptionsUi(bgWindow: Page, manager: Page, newAddress: string): Promise<void> {
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
}

test.describe('Slides address edit while the slide window is open — ordering A @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let manager: Page;
  let server: http.Server;
  let serverPort: number;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('slides-address-edit-while-open-a'));
    ({ server, port: serverPort } = await startServer());
    manager = await openManager(app, bgWindow);
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  test('old window left open: editing the address opens a DISTINCT new window with the new address, does not reuse the open one', async () => {
    test.skip(!(await bridgePresent(app)), 'no hybrid overlay / test bridge in this configuration');

    const oldAddress = `http://127.0.0.1:${serverPort}/while-open-old`;
    const newAddress = `http://127.0.0.1:${serverPort}/while-open-new`;

    await seedSlide(bgWindow, oldAddress);

    await fireSlideOpen(app, EDGE);
    const oldWindowId = await waitHybridForUrl(app, oldAddress, []);
    expect(oldWindowId, 'the old-address slide must open').not.toBeNull();

    // Edit the address without closing the still-open old window first.
    await editAddressViaOptionsUi(bgWindow, manager, newAddress);

    // Fire the hotkey again — same edge, no restart, old window still open.
    await fireSlideOpen(app, EDGE);
    const newWindowId = await waitHybridForUrl(app, newAddress, [oldWindowId!]);
    expect(
      newWindowId,
      'a distinct window with the new address must open — the old window being ' +
        'open must not make main reuse it (which would keep showing the old address)',
    ).not.toBeNull();
    expect(
      newWindowId,
      'the new-address window must be a DIFFERENT window id from the old one — ' +
        'proof this is not an in-place reuse of the still-open window',
    ).not.toBe(oldWindowId);

    // The old window does not survive: slides are transient quick-view windows,
    // and opening the second slide closes the first (window-kernel.ts
    // transientAutocloseExemption() exempts no older slide). The close is
    // asynchronous, so poll rather than read once.
    await expect.poll(() => hybridWindowExists(app, oldWindowId!), {
      timeout: 10000, message: 'the old window never closed',
    }).toBe(false);
    const addresses = await hybridAddresses(app);
    expect(addresses).not.toContain(oldAddress);
    expect(addresses).toContain(newAddress);
  });
});

test.describe('Slides address edit while the slide window is open — ordering B @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let manager: Page;
  let server: http.Server;
  let serverPort: number;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('slides-address-edit-while-open-b'));
    ({ server, port: serverPort } = await startServer());
    manager = await openManager(app, bgWindow);
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  test('old window closed first: editing the address opens a clean window with the new address', async () => {
    test.skip(!(await bridgePresent(app)), 'no hybrid overlay / test bridge in this configuration');

    const oldAddress = `http://127.0.0.1:${serverPort}/closed-first-old`;
    const newAddress = `http://127.0.0.1:${serverPort}/closed-first-new`;

    await seedSlide(bgWindow, oldAddress);

    await fireSlideOpen(app, EDGE);
    const oldWindowId = await waitHybridForUrl(app, oldAddress, []);
    expect(oldWindowId, 'the old-address slide must open').not.toBeNull();

    // Isolate the variable: close the old window BEFORE editing.
    await closeWindowId(bgWindow, oldWindowId!);
    await expect.poll(() => hybridWindowExists(app, oldWindowId!), {
      timeout: 10000, message: 'the old window never closed',
    }).toBe(false);

    await editAddressViaOptionsUi(bgWindow, manager, newAddress);

    await fireSlideOpen(app, EDGE);
    const newWindowId = await waitHybridForUrl(app, newAddress, [oldWindowId!]);
    expect(newWindowId, 'the new-address window must open once the old one is closed').not.toBeNull();
  });
});

// The hotkey can beat the change notification. manage.js save() writes the row and
// then publishes `slides:settings-changed`, and the awake tile's reinit() reloads
// settings asynchronously — so a press landing inside that window used to open the
// OLD address (seen under full-suite load: a second window keyed to the old address
// opened ~140ms after the edit). The saved row is the source of truth, so the press
// must read it rather than the tile's in-memory copy. Writing the row with no
// publish at all makes that ordering deterministic.
test.describe('Slides hotkey reads the saved address, not a stale in-memory copy @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let server: http.Server;
  let serverPort: number;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('slides-address-hotkey-beats-notify'));
    ({ server, port: serverPort } = await startServer());
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  test('hotkey pressed before settings-changed arrives opens the saved address', async () => {
    test.skip(!(await bridgePresent(app)), 'no hybrid overlay / test bridge in this configuration');

    const oldAddress = `http://127.0.0.1:${serverPort}/beats-notify-old`;
    const newAddress = `http://127.0.0.1:${serverPort}/beats-notify-new`;

    // Wake the tile with the old address so its in-memory settings hold it.
    await seedSlide(bgWindow, oldAddress);
    await fireSlideOpen(app, EDGE);
    const oldWindowId = await waitHybridForUrl(app, oldAddress, []);
    expect(oldWindowId, 'the old-address slide must open').not.toBeNull();

    await closeWindowId(bgWindow, oldWindowId!);
    await expect.poll(() => hybridWindowExists(app, oldWindowId!), {
      timeout: 10000, message: 'the old window never closed',
    }).toBe(false);

    // Save the new address WITHOUT publishing slides:settings-changed.
    await seedSlide(bgWindow, newAddress);

    await fireSlideOpen(app, EDGE);
    const newWindowId = await waitHybridForUrl(app, newAddress, [oldWindowId!], 8000);
    expect(
      newWindowId,
      'the hotkey must open the saved address even before the tile hears settings-changed',
    ).not.toBeNull();
    expect(await hybridAddresses(app)).not.toContain(oldAddress);
  });
});
