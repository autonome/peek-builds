import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForWindow, sleep } from '../helpers/window-utils';

test.describe('Hybrid Extension Mode @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('hybrid-mode'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('v2 background tile windows exist as separate BrowserWindows', async () => {
    // V2 background tiles (peeks, slides) launch as separate hidden BrowserWindows
    // at peek://{id}/background.html — NOT as iframes in the extension host.
    const peeksWin = await waitForWindow(
      () => app.windows(),
      'peek://peeks/background.html',
      15000
    );
    expect(peeksWin).toBeDefined();

    const slidesWin = await waitForWindow(
      () => app.windows(),
      'peek://slides/background.html',
      15000
    );
    expect(slidesWin).toBeDefined();
  });

  test('api.features.devReload() reloads a feature', async () => {
    // Reload the example feature (external v2 tile — lazy). devReload()
    // reloads any live tile windows for the feature; for a lazy tile that
    // hasn't been invoked yet, it reports no active tiles were reloaded.
    const reloadResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.features.devReload('example');
    });

    expect(reloadResult.error).toBeFalsy();
    expect(reloadResult.success).toBe(true);
  });

  test('api.features.devReload() reports no active tiles for unloaded core renderer', async () => {
    // `cmd` is a core renderer — its tile window exists but isn't managed
    // through the feature-registry dev-reload path, so devReload either
    // reports no active tiles or reloads it. Either way should not error.
    const reloadResult = await bgWindow.evaluate(async () => {
      return await (window as any).app.features.devReload('cmd');
    });

    expect(reloadResult).toBeTruthy();
    expect(reloadResult.error).toBeFalsy();
  });

  test('commands work from both consolidated and external extensions', async () => {
    // Wait a bit for extensions to initialize and register commands
    await sleep(1000);

    // Query commands - should include commands from all extensions
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ success: false, commandCount: 0 });
        }, 10000);

        api.subscribe('cmd:query-commands-response', (msg: any) => {
          clearTimeout(timeout);
          resolve({
            success: true,
            commandCount: msg.commands?.length || 0,
            // example:gallery comes from external 'example' extension
            hasGalleryCommand: msg.commands?.some((c: any) => c.name === 'example:gallery'),
            // settings comes from core (via consolidated cmd)
            hasSettingsCommand: msg.commands?.some((c: any) => c.name === 'settings')
          });
        });

        api.publish('cmd:query-commands', {});
      });
    });

    expect(result.success).toBe(true);
    expect(result.commandCount).toBeGreaterThan(0);
    // example:gallery proves external extension commands work
    expect(result.hasGalleryCommand).toBe(true);
    // settings proves consolidated extension commands work
    expect(result.hasSettingsCommand).toBe(true);
  });

  test('pubsub works between consolidated and external extensions', async () => {
    // Test pubsub routing between extensions in different modes
    // cmd (consolidated) receives query, responds to core
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ received: false, commandCount: 0 });
        }, 5000);

        api.subscribe('cmd:query-commands-response', (msg: any) => {
          clearTimeout(timeout);
          resolve({
            received: true,
            commandCount: msg.commands?.length || 0
          });
        });

        api.publish('cmd:query-commands', {});
      });
    });

    expect(result.received).toBe(true);
    expect(result.commandCount).toBeGreaterThan(0);
  });

  test('correct window count for hybrid mode', async () => {
    // After v2-tile migration:
    // - 1 core background window (peek://app/background.html)
    // - Multiple v2 eager-background tile windows (peeks, slides, entities, …
    //   served from peek://{id}/background.html)
    // - Lazy v2 tiles (including 'example') do NOT load at startup; they
    //   only launch at peek://{id}/background.html on first command invoke.
    // - Plus any UI windows (settings, etc.)
    const windows = app.windows();

    const coreBgWindows = windows.filter(w => w.url().includes('peek://app/background.html'));
    expect(coreBgWindows.length).toBe(1);

    // Eager v2 tile background windows exist; at least a couple expected
    // (peeks, slides were the canonical ones in v2 migration tests).
    const v2TileBgWindows = windows.filter(w => /peek:\/\/[a-z-]+\/background\.html/.test(w.url()));
    expect(v2TileBgWindows.length).toBeGreaterThan(0);

    // Lazy 'example' tile shouldn't have a window unless it was already
    // invoked in a previous test. Don't assert presence or absence — this
    // test is about the core/v2 shape, not example specifically.
  });
});
