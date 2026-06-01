import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('Hybrid Extension Mode @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('hybrid-mode'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('v2 builtin tiles are registered but have no resident bg window at boot', async () => {
    // After the lazy-feature workstream (peek epic d8e7efa5 / task 921b54b3)
    // there are NO resident feature background tiles left: mcp-server,
    // windows, websearch, peeks AND slides are all lazy. So we no longer
    // assert that any `peek://{id}/background.html` exists at boot. Instead we
    // assert the LAZY reality:
    //   (1) these v2 builtin features are still REGISTERED in the strict
    //       v3 registry (features.list('builtin')); and
    //   (2) none of them has a background window at boot.
    const builtin = await bgWindow.evaluate(async () => {
      return await (window as any).app.features.list('builtin');
    });
    const ids = (builtin.entries || []).map((e: any) => e.id);
    for (const id of ['slides', 'peeks', 'websearch', 'windows', 'mcp-server']) {
      expect(ids).toContain(id);
    }

    // No lazy feature has a bg window at boot.
    const urls = app.windows().map((w) => w.url());
    for (const id of ['slides', 'peeks', 'websearch', 'windows', 'mcp-server']) {
      expect(urls.some((u) => u.includes(`peek://${id}/`))).toBe(false);
    }
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

  test('commands work from both consolidated and external extensions', async () => {
    // Synchronize on command registration deterministically: re-query on each
    // cmd:register(-batch) event and resolve the instant the response carries
    // both example:gallery (external) and settings (consolidated). No
    // fixed-duration sleep (per feedback_no_sleep_in_tests_or_code); a single
    // Playwright timeout bounds the whole thing.
    const result = await bgWindow.evaluate(async () => {
      const api = (window as any).app;

      return new Promise((resolve) => {
        let done = false;
        api.subscribe('cmd:query-commands-response', (msg: any) => {
          if (done) return;
          const cmds = msg.commands || [];
          const hasGallery = cmds.some((c: any) => c.name === 'example:gallery');
          const hasSettings = cmds.some((c: any) => c.name === 'settings');
          if (hasGallery && hasSettings) {
            done = true;
            resolve({
              success: true,
              commandCount: cmds.length,
              hasGalleryCommand: hasGallery,
              hasSettingsCommand: hasSettings,
            });
          }
        });
        // Re-query when the registry grows.
        api.subscribe('cmd:register', () => api.publish('cmd:query-commands', {}));
        api.subscribe('cmd:register-batch', () => api.publish('cmd:query-commands', {}));
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
    // After the lazy-feature workstream there are NO resident feature
    // background tiles left. The boot window shape is:
    // - exactly 1 core background window (peek://app/background.html)
    // - ZERO resident v2 feature bg tiles (peeks, slides, websearch, windows,
    //   mcp-server are all lazy — they launch at peek://{id}/background.html
    //   only on first wake/command-invoke).
    // - Plus any UI windows (settings, etc.)
    const windows = app.windows();

    const coreBgWindows = windows.filter(w => w.url().includes('peek://app/background.html'));
    expect(coreBgWindows.length).toBe(1);

    // The core background.html is the ONLY peek://app/ background renderer.
    // (Distinct from the settings host peek://app/settings/… which is a UI
    // window, not a *background.html.)
    const appBgWindows = windows.filter(w => /peek:\/\/app\/background\.html/.test(w.url()));
    expect(appBgWindows.length).toBe(1);

    // No lazy feature has a bg window at boot — there are zero resident v2
    // feature background tiles now.
    const featureBgWindows = windows.filter(w =>
      /peek:\/\/(peeks|slides|websearch|windows|mcp-server)\/background\.html/.test(w.url()));
    expect(featureBgWindows.length).toBe(0);

    // Lazy 'example' tile shouldn't have a window unless it was already
    // invoked in a previous test. Don't assert presence or absence — this
    // test is about the core/lazy shape, not example specifically.
  });
});
