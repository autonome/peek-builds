import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Settings @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('settings'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('open and close settings', async () => {
    // Settings opens on start in debug mode
    const settingsWindow = await app.getWindow('settings/settings.html');
    expect(settingsWindow).toBeTruthy();

    // Verify content loaded
    await settingsWindow.waitForSelector('.settings-layout', { timeout: 5000 });
    expect(await settingsWindow.$('.sidebar')).toBeTruthy();
    expect(await settingsWindow.$('#sidebarNav')).toBeTruthy();

    // Close via window.close()
    await settingsWindow.evaluate(() => window.close());
  });
});
