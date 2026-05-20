import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Cross-Origin Fetch @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('cors'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('peek:// pages can fetch from https:// origins', async () => {
    // peek:// scheme has corsEnabled: false, so fetch() to external origins should work.
    // If corsEnabled were true, this would throw "Failed to fetch" due to CORS.
    const result = await bgWindow.evaluate(async () => {
      try {
        const res = await fetch('https://public.api.bsky.app/xrpc/_health');
        return { ok: res.ok, status: res.status, error: null };
      } catch (err: any) {
        return { ok: false, status: 0, error: err.message };
      }
    });

    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });
});
