/**
 * Regression spec for Proton Pass permissions in popup.
 *
 * Original bug: Proton Pass popup showed "Permission denied for site access"
 * after the user clicked the in-extension grant button, because Electron's
 * native chrome.permissions has no working request() and downstream Proxy
 * wraps in webextension-polyfill hid our shim from chrome.permissions /
 * browser.permissions.
 *
 * Fix: scripts/patch-chrome-extensions.js writes peek-permissions.js into the
 * extension dir and references it as the FIRST script tag in each HTML entry
 * (before polyfills.js). The shim patches chrome.permissions, then locks
 * globalThis.chrome with writable:false so downstream code can't replace
 * the binding with a Proxy that filters out 'permissions'.
 *
 * This spec asserts:
 * 1. No page errors occur during popup load.
 * 2. chrome.permissions and browser.permissions are both our shim.
 * 3. request() and contains() return true for proton.me origins.
 */

import { test, expect } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Proton Pass popup permissions @desktop', () => {
  let app: any;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('proton-pass-perms'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('chrome.permissions and browser.permissions in popup', async () => {
    // Resolve the Proton Pass popup URL via the canonical UI-entries IPC.
    const entries = await bgWindow.evaluate(async () => {
      const r = await (window as any).app.chromeExtensions.getUiEntries();
      return r.data as Array<{ extensionId: string; extensionName: string; type: string; url: string }>;
    });
    const popupEntry = entries.find(
      (e) => e.type === 'popup' && e.extensionName.toLowerCase().includes('proton'),
    );
    expect(popupEntry, 'Proton Pass popup entry must exist').toBeTruthy();

    const openResult = await bgWindow.evaluate(async (url: string) => {
      return await (window as any).app.window.open(url, {
        width: 400, height: 500, key: 'proton-popup-perms',
      });
    }, popupEntry!.url);
    expect(openResult.success).toBe(true);

    const popup = await app.getWindow('popup.html', 15000);
    expect(popup).toBeTruthy();

    const pageErrors: string[] = [];
    popup.on('pageerror', (err) => pageErrors.push(err.message));

    await popup.waitForLoadState('domcontentloaded');
    // browser.permissions is exposed by webextension-polyfill (in popup.js
    // defer) wrapping our chrome.permissions. Wait for it as the readiness signal.
    await popup.waitForFunction(
      () => typeof (globalThis as any).browser?.permissions?.request === 'function',
      { timeout: 5000 },
    );

    const result = await popup.evaluate(async () => {
      const c = (globalThis as any).chrome;
      const b = (globalThis as any).browser;
      const peek = (globalThis as any).__peekPermissions;
      return {
        chromePermsIsShim: c.permissions === peek,
        browserPermsIsShim: b.permissions === peek,
        chromeRequest: await c.permissions.request({ origins: ['https://account.proton.me/*', 'https://pass.proton.me/*'] }),
        chromeContains: await c.permissions.contains({ origins: ['https://account.proton.me/*'] }),
        browserRequest: await b.permissions.request({ origins: ['https://account.proton.me/*', 'https://pass.proton.me/*'] }),
        browserContains: await b.permissions.contains({ origins: ['https://account.proton.me/*'] }),
      };
    });

    expect(pageErrors, 'no page errors during popup load').toEqual([]);
    expect(result.chromePermsIsShim, 'chrome.permissions === __peekPermissions').toBe(true);
    expect(result.browserPermsIsShim, 'browser.permissions === __peekPermissions').toBe(true);
    expect(result.chromeRequest).toBe(true);
    expect(result.chromeContains).toBe(true);
    expect(result.browserRequest).toBe(true);
    expect(result.browserContains).toBe(true);
  });
});
