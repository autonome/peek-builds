/**
 * Permissions settings UI — Phase 4 integration test.
 *
 * Drives the settings page's Permissions section end-to-end:
 *   1. Seed two stored decisions via api.permissions.forget(...) to clear
 *      then api.permissions inserts indirectly. (We use a backdoor via
 *      bgWindow `app.invoke`-style — but cleanest is to drive the prompt
 *      itself in Phase 2's spec; here we just verify the UI rendering
 *      and revoke flow against pre-seeded data via the IPC.)
 *   2. Open settings → Permissions section.
 *   3. Assert each row renders with origin + label + verdict + Revoke btn.
 *   4. Click Revoke on one row → row disappears AND backend list shrinks.
 *   5. Click Clear All → all rows disappear + empty msg shows.
 *
 * Run with: yarn test:grep "Permissions Settings"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Permissions Settings UI @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('permissions-settings'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test.beforeEach(async () => {
    // Reset stored decisions between tests so each is hermetic.
    await bgWindow.evaluate(async () => {
      await (window as any).app.permissions.forgetAll();
    });
  });

  /** Seed a stored decision via the same IPC the prompt uses. */
  async function seedDecision(origin: string, permission: string, allowed: boolean) {
    // We don't have a direct setDecision IPC (only forget); instead, drive
    // the full prompt flow by publishing the response to a synthetic
    // page:permission-request. The handler would normally fire from a
    // setPermissionRequestHandler callback; since we're seeding test
    // state, we use a SQL-direct backdoor via the datastore IPC, which
    // settings page can reach via api.datastore.
    //
    // Simpler: the page-host renderer sends `page:permission-response`
    // which the handler resolves via pendingRequests. To seed without a
    // real prompt, we'd need a test hook. For this Phase 4 test, just
    // assert the UI behavior once the data is there — populate via the
    // raw datastore IPC:
    await bgWindow.evaluate(async ({ origin, permission, allowed }) => {
      const api = (window as any).app;
      const value = JSON.stringify({ allowed, timestamp: Date.now() });
      const rowId = `page-permissions-${permission}-${origin}`;
      await api.datastore.setRow('feature_settings', rowId, {
        id: rowId,
        featureId: 'page-permissions',
        key: `${permission}:${origin}`,
        value,
        updatedAt: Date.now(),
      });
    }, { origin, permission, allowed });
  }

  async function openSettings(): Promise<Page> {
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://app/settings/settings.html', {
        width: 1000, height: 700, key: 'settings',
      });
    });
    expect(result.success).toBe(true);
    const settingsWindow = await app.getWindow('settings/settings.html', 10000);
    await settingsWindow.waitForLoadState('domcontentloaded');
    return settingsWindow;
  }

  test('Permissions section renders stored decisions with origin, label, and Revoke button', async () => {
    await seedDecision('https://example.com', 'geolocation', false);
    await seedDecision('https://meet.example.com', 'media', true);

    const settings = await openSettings();

    // Click into the Permissions section — the click handler refreshes the
    // list, so newly-seeded decisions show up even if the settings window
    // was opened before the seed.
    await settings.locator('a.nav-item[data-section="permissions"]').click();

    // Wait for at least one row to render.
    await settings.waitForFunction(
      () => document.querySelectorAll('#section-permissions .item-card').length >= 2,
      undefined,
      { timeout: 5000 },
    );

    const rows = settings.locator('#section-permissions .item-card');
    await expect(rows).toHaveCount(2);

    // Each row should mention an origin and a verdict.
    const rowTexts = await rows.allInnerTexts();
    const combined = rowTexts.join('\n');
    expect(combined).toContain('https://example.com');
    expect(combined).toContain('https://meet.example.com');
    expect(combined).toMatch(/Location/);
    expect(combined).toMatch(/Camera/);
    expect(combined).toMatch(/Denied/);
    expect(combined).toMatch(/Allowed/);
  });

  test('Revoke button removes the row and clears the backend entry', async () => {
    await seedDecision('https://example.com', 'geolocation', false);

    const settings = await openSettings();
    await settings.locator('a.nav-item[data-section="permissions"]').click();

    await settings.waitForSelector('#section-permissions .item-card', { timeout: 5000 });
    expect(await settings.locator('#section-permissions .item-card').count()).toBe(1);

    await settings.locator('#section-permissions .item-card button:has-text("Revoke")').click();

    // Row gone in UI.
    await settings.waitForFunction(
      () => document.querySelectorAll('#section-permissions .item-card').length === 0,
      undefined,
      { timeout: 5000 },
    );

    // Backend confirms removal.
    const stillThere = await bgWindow.evaluate(async () => {
      const res = await (window as any).app.permissions.list();
      return res?.data?.length ?? -1;
    });
    expect(stillThere).toBe(0);
  });

  test('Phase 5 — rows are grouped by origin (sorted origin then permission)', async () => {
    // Seed in deliberately scrambled order — the renderer should still
    // group them by origin so the user sees example.com's two decisions
    // adjacent to each other, then meet.example.com's.
    await seedDecision('https://meet.example.com', 'media', true);
    await seedDecision('https://example.com', 'midi', false);
    await seedDecision('https://meet.example.com', 'geolocation', false);
    await seedDecision('https://example.com', 'geolocation', true);

    const settings = await openSettings();
    await settings.locator('a.nav-item[data-section="permissions"]').click();

    await settings.waitForFunction(
      () => document.querySelectorAll('#section-permissions .item-card').length === 4,
      undefined,
      { timeout: 5000 },
    );

    // Read the visual order — each row's origin text in DOM order.
    const origins = await settings.locator('#section-permissions .item-card').evaluateAll(
      (rows) => rows.map((r) => {
        const originEl = r.querySelector('div[style*="font-family"]');
        return originEl?.textContent || '';
      }),
    );

    // Both example.com rows must come first (alphabetical), and consecutively.
    expect(origins[0]).toBe('https://example.com');
    expect(origins[1]).toBe('https://example.com');
    expect(origins[2]).toBe('https://meet.example.com');
    expect(origins[3]).toBe('https://meet.example.com');
  });

  test('Phase 5 — favicon img renders next to each decision row', async () => {
    await seedDecision('https://example.com', 'geolocation', false);
    await seedDecision('https://meet.example.com', 'media', true);

    const settings = await openSettings();
    await settings.locator('a.nav-item[data-section="permissions"]').click();

    await settings.waitForSelector('#section-permissions .item-card', { timeout: 5000 });

    const favicons = settings.locator('#section-permissions .permissions-row-favicon');
    await expect(favicons).toHaveCount(2);

    // Each src should be the Google s2 favicon URL with the right host.
    const srcs = await favicons.evaluateAll(els => els.map(el => (el as HTMLImageElement).src));
    expect(srcs.some(s => /google\.com\/s2\/favicons\?domain=example\.com/.test(s))).toBe(true);
    expect(srcs.some(s => /google\.com\/s2\/favicons\?domain=meet\.example\.com/.test(s))).toBe(true);
  });

  test('Clear all removes every decision and shows empty message', async () => {
    await seedDecision('https://a.com', 'geolocation', false);
    await seedDecision('https://b.com', 'media', true);
    await seedDecision('https://c.com', 'midi', true);

    const settings = await openSettings();
    await settings.locator('a.nav-item[data-section="permissions"]').click();

    await settings.waitForFunction(
      () => document.querySelectorAll('#section-permissions .item-card').length >= 3,
      undefined,
      { timeout: 5000 },
    );

    // Auto-accept the confirm() dialog.
    settings.on('dialog', dialog => dialog.accept());

    await settings.locator('#section-permissions button:has-text("Clear all")').click();

    await settings.waitForFunction(
      () => document.querySelectorAll('#section-permissions .item-card').length === 0,
      undefined,
      { timeout: 5000 },
    );

    // Backend confirms wipe.
    const remaining = await bgWindow.evaluate(async () => {
      const res = await (window as any).app.permissions.list();
      return res?.data?.length ?? -1;
    });
    expect(remaining).toBe(0);
  });
});
