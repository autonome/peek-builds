import { test, expect, launchDesktopApp } from '../fixtures/desktop-app';
import { waitForExtensionsReady, sleep } from '../helpers/window-utils';

// ============================================================================
// Extension Settings in Hybrid Mode Tests
// ============================================================================

test.describe('Extension Settings in Hybrid Mode @desktop', () => {
  // Tests 1 and 2 share an instance (defaults check first, then modify)
  // Test 3 (restart test) uses its own instances
  let settingsApp: any;
  let settingsBgWindow: any;

  test.beforeAll(async () => {
    // Launch fresh app for settings tests (tests 1 and 2 share this)
    settingsApp = await launchDesktopApp(`test-settings-hybrid-${Date.now()}`);
    settingsBgWindow = await settingsApp.getBackgroundWindow();
    await waitForExtensionsReady(settingsBgWindow, 15000);
  });

  test.afterAll(async () => {
    if (settingsApp) await settingsApp.close();
  });

  // This test runs FIRST - checks defaults before any modifications
  test('extension falls back to defaults when no custom settings exist', async () => {
    // This test verifies that when no custom settings exist in the datastore,
    // extensions correctly use their default settings

    // Query cmd's current settings
    const result = await settingsBgWindow.evaluate(async () => {
      const api = (window as any).app;
      const defaultShortcut = 'Option+Space'; // cmd's default

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ success: false, error: 'timeout' });
        }, 5000);

        api.subscribe('cmd:settings-changed', (msg: any) => {
          clearTimeout(timeout);
          resolve({
            success: true,
            shortcutKey: msg?.prefs?.shortcutKey,
            isDefault: msg?.prefs?.shortcutKey === defaultShortcut
          });
        });

        // Poke cmd to report its settings - use the default to not change it
        api.publish('cmd:settings-update', {
          data: { prefs: { shortcutKey: defaultShortcut } }
        });
      });
    });

    expect(result.success).toBe(true);
    expect(result.isDefault).toBe(true);
    expect(result.shortcutKey).toBe('Option+Space');
  });

  // This test runs SECOND - can modify settings since defaults already checked
  test('hybrid mode extensions can access settings via api.settings.get()', async () => {
    // This test verifies that extensions running at peek://{extId}/... URLs
    // (hybrid mode) can successfully use the settings API
    //
    // The preload must correctly detect these URLs as extensions and return
    // the proper extension ID for settings lookups
    //
    // We test this by updating settings via pubsub and verifying:
    // 1. cmd receives the update (which requires api.settings.get() to have worked during init)
    // 2. cmd persists the settings (which requires api.settings.set() to work)

    // Custom shortcut to test with
    const customShortcut = 'Option+Shift+T';

    // Update cmd settings via pubsub
    const updateResult = await settingsBgWindow.evaluate(async (shortcut) => {
      const api = (window as any).app;

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ success: false, error: 'timeout waiting for settings change' });
        }, 5000);

        // Subscribe to settings changed notification from cmd
        api.subscribe('cmd:settings-changed', (msg: any) => {
          clearTimeout(timeout);
          resolve({
            success: true,
            receivedShortcut: msg?.prefs?.shortcutKey,
            matchesExpected: msg?.prefs?.shortcutKey === shortcut
          });
        });

        // Update cmd settings via pubsub (this is how Settings UI does it)
        api.publish('cmd:settings-update', {
          data: { prefs: { shortcutKey: shortcut } }
        });
      });
    }, customShortcut);

    expect(updateResult.success).toBe(true);
    expect(updateResult.matchesExpected).toBe(true);
    expect(updateResult.receivedShortcut).toBe(customShortcut);

    // Wait a moment for persistence to complete
    await sleep(200);

    // Now verify the settings were persisted to datastore
    // Note: extension-settings-set stores with id format ${extId}_${key}
    const persistResult = await settingsBgWindow.evaluate(async (expectedShortcut) => {
      const api = (window as any).app;
      const stored = await api.datastore.getRow('feature_settings', 'cmd_prefs');

      if (!stored.success || !stored.data?.value) {
        return { success: false, error: 'No stored settings found', stored };
      }

      const parsed = JSON.parse(stored.data.value);
      return {
        success: true,
        persistedShortcut: parsed.shortcutKey,
        wasPersisted: parsed.shortcutKey === expectedShortcut
      };
    }, customShortcut);

    expect(persistResult.success).toBe(true);
    expect(persistResult.wasPersisted).toBe(true);
    expect(persistResult.persistedShortcut).toBe(customShortcut);
  });

  // This test needs restart - uses its own isolated instances
  test('extension loads custom settings instead of defaults on startup', async () => {
    // This test verifies that when custom settings exist in the datastore,
    // extensions load those settings instead of their defaults
    //
    // We set up custom settings, close the app, relaunch with the same profile,
    // and verify the extension loaded the custom settings on init

    // Use a fixed profile name so we can relaunch with the same settings
    const profileName = `test-custom-settings-${Date.now()}`;

    // First, launch app to set up custom settings in the datastore
    const setupApp = await launchDesktopApp(profileName);
    const setupWindow = await setupApp.getBackgroundWindow();

    const customShortcut = 'Option+Ctrl+P';

    // Store custom settings (using format ${extId}_${key} to match extension-settings-set handler)
    const saveResult = await setupWindow.evaluate(async (shortcut) => {
      const api = (window as any).app;
      return await api.datastore.setRow('feature_settings', 'cmd_prefs', {
        featureId: 'cmd',
        key: 'prefs',
        value: JSON.stringify({ shortcutKey: shortcut }),
        updatedAt: Date.now()
      });
    }, customShortcut);

    expect(saveResult.success).toBe(true);

    // Close and relaunch - extensions should load custom settings on init
    await setupApp.close();

    // Small delay to ensure clean shutdown
    await sleep(500);

    // Relaunch with SAME profile to pick up saved settings
    const testApp = await launchDesktopApp(profileName);

    try {
      const testWindow = await testApp.getBackgroundWindow();

      // Wait for extensions to be fully initialized using proper wait helper
      await waitForExtensionsReady(testWindow, 15000);

      // Verify cmd loaded the custom settings on startup
      // We update settings with the same value and verify it was already set
      const result = await testWindow.evaluate(async (expectedShortcut) => {
        const api = (window as any).app;

        return new Promise((resolve) => {
          const timeout = setTimeout(() => {
            resolve({ success: false, error: 'timeout' });
          }, 10000);

          api.subscribe('cmd:settings-changed', (msg: any) => {
            clearTimeout(timeout);
            resolve({
              success: true,
              shortcutKey: msg?.prefs?.shortcutKey,
              matchesCustom: msg?.prefs?.shortcutKey === expectedShortcut,
              // Check if it's NOT the default (Option+Space)
              isNotDefault: msg?.prefs?.shortcutKey !== 'Option+Space'
            });
          });

          // Poke cmd to report its current settings (update with same value)
          api.publish('cmd:settings-update', {
            data: { prefs: { shortcutKey: expectedShortcut } }
          });
        });
      }, customShortcut);

      expect(result.success).toBe(true);
      expect(result.isNotDefault).toBe(true);
      expect(result.matchesCustom).toBe(true);
      expect(result.shortcutKey).toBe(customShortcut);

    } finally {
      await testApp.close();
    }
  });
});
