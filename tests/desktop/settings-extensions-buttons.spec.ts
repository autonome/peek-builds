/**
 * Settings → Extensions (Privacy) — per-extension action buttons regression guard.
 *
 * This surface has regressed three times (different root causes each time).
 * The canonical failure mode: Settings is opened before chrome-extensions:loaded
 * fires, so getUiEntries() returns empty → no Popup/Options buttons render.
 * The current fix re-renders the section when the event fires.
 *
 * This test asserts the end-state regardless of timing: after Settings opens
 * and the user navigates to Extensions, at least one action button (Popup or
 * Options) is visible for a bundled extension (Proton Pass ships both).
 *
 * Run with: yarn test:grep "settings extensions buttons"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Settings Extensions buttons @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('settings-extensions-buttons'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  /**
   * Open the Settings window via the same api.window.open path used by
   * permissions-settings.spec.ts (the canonical pattern for this codebase).
   */
  async function openSettings(): Promise<Page> {
    const result = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://app/settings/settings.html', {
        width: 1000,
        height: 700,
        key: 'settings',
      });
    });
    expect(result.success).toBe(true);
    const settingsWindow = await app.getWindow('settings/settings.html', 10000);
    await settingsWindow.waitForLoadState('domcontentloaded');
    return settingsWindow;
  }

  test('settings extensions buttons render for bundled extensions', async () => {
    const settings = await openSettings();

    // Navigate to the Extensions (Privacy) section. The click handler triggers
    // showSection('privacy') which makes the section visible.
    await settings.locator('a.nav-item[data-section="privacy"]').click();

    // Wait for the section to be visible — the renderPrivacySettings() call is
    // async and chrome-extensions:loaded may re-render after initial open.
    // Poll for at least one action button (Popup / Options / etc.) appearing
    // inside #section-privacy. Proton Pass bundles both action.default_popup
    // and options_ui.page so it should always contribute ≥ 2 buttons.
    // Generous 8 s timeout to cover the loaded-before-settings-open race path.
    await settings.waitForFunction(
      () => {
        const section = document.querySelector('#section-privacy');
        if (!section) return false;
        // The buttons are plain <button> elements inside .item-card divs.
        // Their textContent matches entryTypeLabels: 'Popup', 'Options', etc.
        const buttons = Array.from(section.querySelectorAll('button'));
        return buttons.some(
          (b) =>
            b.textContent === 'Popup' ||
            b.textContent === 'Options' ||
            b.textContent === 'Background' ||
            b.textContent === 'Side Panel',
        );
      },
      undefined,
      { timeout: 8000 },
    );

    // Assert at least one button is present (the waitForFunction above already
    // guarantees it, but the explicit expect makes the failure message clear).
    const buttonCount = await settings.evaluate(() => {
      const section = document.querySelector('#section-privacy');
      if (!section) return 0;
      const buttons = Array.from(section.querySelectorAll('button'));
      return buttons.filter(
        (b) =>
          b.textContent === 'Popup' ||
          b.textContent === 'Options' ||
          b.textContent === 'Background' ||
          b.textContent === 'Side Panel',
      ).length;
    });

    expect(buttonCount).toBeGreaterThanOrEqual(1);
  });

  test('settings extensions buttons IPC layer returns openable entries', async () => {
    // Belt-and-suspenders: confirm the IPC layer itself reports ≥ 1 openable
    // entry so a future regression in getUiEntries() or the chrome-extensions
    // load pipeline is caught even before the UI layer.
    const openableCount = await bgWindow.evaluate(async () => {
      const result = await (window as any).app.chromeExtensions.getUiEntries();
      if (!result.success || !result.data) return 0;
      return result.data.filter((e: any) => e.openable === true).length;
    });

    expect(openableCount).toBeGreaterThanOrEqual(1);
  });
});
