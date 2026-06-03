/**
 * Browser Extension Options Page Tests
 *
 * Tests for the options/settings page (options.html/options.js).
 * Run with: BROWSER=chrome yarn test:extension:chrome
 *
 * These tests require a headed Chrome instance to load the extension
 * (Playwright's headless shell does not support extensions). On Linux,
 * playwright-with-display.sh unsets HEADLESS and provides an Xvfb
 * virtual display. On macOS with HEADLESS=1, tests are skipped.
 */

import { test, expect } from '@playwright/test';
import { getSharedExtension, ExtensionApp } from '../fixtures/extension-app';

// Chrome extensions cannot run in Playwright's headless mode (chromium-headless-shell).
// On Linux, playwright-with-display.sh runs tests under Xvfb (headless unset, virtual display).
// On macOS, skip when HEADLESS=1 to avoid surfacing a Chrome window on the user's desktop.
test.skip(process.env.HEADLESS === '1' && process.platform !== 'linux',
  'Extension tests require a display. Run yarn test:extension:chrome (no HEADLESS) or on Linux where Xvfb is available.');
import {
  waitForOptionsInit,
  fillSyncConfig,
  saveSyncConfig,
  getConfigStatus,
  getDiagnostics,
  refreshDiagnostics,
  getDiagStatus,
  isBookmarkSyncEnabled,
  isTabSyncEnabled,
  isHistorySyncEnabled,
  toggleBookmarkSync,
  toggleTabSync,
  toggleHistorySync,
} from '../helpers/extension-utils';
import { Page } from '@playwright/test';

let ext: ExtensionApp;
let options: Page;

test.beforeAll(async () => {
  ext = await getSharedExtension();
});

// Don't close shared extension - let Playwright handle cleanup
// This allows multiple test files to share the same browser instance

test.beforeEach(async () => {
  // Open a fresh options page for each test
  options = await ext.openOptions();
  await waitForOptionsInit(options);
});

test.afterEach(async () => {
  // Close the options page
  if (options && !options.isClosed()) {
    await options.close();
  }
});

test.describe('Options Page Structure', () => {
  test('has page title', async () => {
    const title = await options.title();
    expect(title).toBe('Peek - Options');
  });

  test('has sync configuration section', async () => {
    const syncSection = options.locator('#sync-config');
    await expect(syncSection).toBeVisible();

    const heading = syncSection.locator('h2');
    await expect(heading).toHaveText('Sync Configuration');
  });

  test('has server URL input', async () => {
    const input = options.locator('#server-url');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('type', 'url');
  });

  test('has API key input', async () => {
    const input = options.locator('#api-key');
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('type', 'password');
  });

  test('has server profile ID input', async () => {
    const input = options.locator('#server-profile-id');
    await expect(input).toBeVisible();
  });

  test('has auto-sync checkbox', async () => {
    const checkbox = options.locator('#auto-sync');
    await expect(checkbox).toBeVisible();
    await expect(checkbox).toHaveAttribute('type', 'checkbox');
  });

  test('has save button', async () => {
    const button = options.locator('#save-config');
    await expect(button).toBeVisible();
    await expect(button).toHaveText('Save');
  });

  test('has diagnostics section', async () => {
    const diagSection = options.locator('#diagnostics');
    await expect(diagSection).toBeVisible();

    const heading = diagSection.locator('h2');
    await expect(heading).toHaveText('Diagnostics');
  });

  test('has test features section', async () => {
    const featuresSection = options.locator('#test-features');
    await expect(featuresSection).toBeVisible();

    const heading = featuresSection.locator('h2');
    await expect(heading).toHaveText('Test Features');
  });
});

test.describe('Diagnostics', () => {
  test('displays diagnostic values', async () => {
    const diagnostics = await getDiagnostics(options);

    // These should be populated after init
    expect(diagnostics.profile).not.toBe('--');
    expect(diagnostics.dsVersion).not.toBe('--');
    expect(diagnostics.protoVersion).not.toBe('--');
  });

  test('displays item and tag counts', async () => {
    const diagnostics = await getDiagnostics(options);

    // Counts should be numeric (could be 0)
    expect(diagnostics.items).toMatch(/^\d+$/);
    expect(diagnostics.tags).toMatch(/^\d+$/);
  });

  test('displays pending sync count', async () => {
    const diagnostics = await getDiagnostics(options);

    expect(diagnostics.pending).toMatch(/^\d+$/);
  });

  test('displays sync configured status', async () => {
    const diagnostics = await getDiagnostics(options);

    expect(['Yes', 'No']).toContain(diagnostics.configured);
  });

  test('displays browser info', async () => {
    const diagnostics = await getDiagnostics(options);

    // Browser should show something
    expect(diagnostics.browser.length).toBeGreaterThan(0);
  });

  test('displays extension version', async () => {
    const diagnostics = await getDiagnostics(options);

    // Extension version should match manifest
    expect(diagnostics.extVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('refresh button updates diagnostics', async () => {
    // Get initial diagnostics
    const initialDiag = await getDiagnostics(options);

    // Click refresh
    await refreshDiagnostics(options);

    // Diagnostics should still be populated (values may or may not change)
    const refreshedDiag = await getDiagnostics(options);
    expect(refreshedDiag.profile).not.toBe('--');
  });

  test('has sync action buttons', async () => {
    const pullBtn = options.locator('#btn-pull');
    const pushBtn = options.locator('#btn-push');
    const syncAllBtn = options.locator('#btn-sync-all');
    const refreshBtn = options.locator('#btn-refresh');

    await expect(pullBtn).toBeVisible();
    await expect(pushBtn).toBeVisible();
    await expect(syncAllBtn).toBeVisible();
    await expect(refreshBtn).toBeVisible();
  });
});

test.describe('Sync Configuration', () => {
  test('can fill sync config form', async () => {
    await fillSyncConfig(options, {
      serverUrl: 'https://test.example.com',
      apiKey: 'test-api-key',
      serverProfileId: '12345678-1234-1234-1234-123456789012',
      autoSync: true,
    });

    // Verify values were set
    const serverUrl = await options.locator('#server-url').inputValue();
    expect(serverUrl).toBe('https://test.example.com');

    const autoSync = await options.locator('#auto-sync').isChecked();
    expect(autoSync).toBe(true);
  });

  test('save button shows status message', async () => {
    await fillSyncConfig(options, {
      serverUrl: 'https://test.example.com',
    });

    await saveSyncConfig(options);

    // Wait for status message
    await options.waitForFunction(
      () => {
        const status = document.getElementById('config-status');
        return status && status.textContent && status.textContent.length > 0;
      },
      { timeout: 5000 }
    );

    const status = await getConfigStatus(options);
    expect(status.length).toBeGreaterThan(0);
  });
});

test.describe('Test Features', () => {
  test('has bookmark sync toggle', async () => {
    const checkbox = options.locator('#bookmark-sync');
    await expect(checkbox).toBeVisible();
  });

  test('has tab sync toggle', async () => {
    const checkbox = options.locator('#tab-sync');
    await expect(checkbox).toBeVisible();
  });

  test('has history sync toggle', async () => {
    const checkbox = options.locator('#history-sync');
    await expect(checkbox).toBeVisible();
  });

  test('bookmark sync toggle can be changed', async () => {
    const initialState = await isBookmarkSyncEnabled(options);

    // Toggle
    await toggleBookmarkSync(options, !initialState);

    const newState = await isBookmarkSyncEnabled(options);
    expect(newState).toBe(!initialState);

    // Toggle back
    await toggleBookmarkSync(options, initialState);
  });

  test('tab sync toggle can be changed', async () => {
    const initialState = await isTabSyncEnabled(options);

    // Toggle
    await toggleTabSync(options, !initialState);

    const newState = await isTabSyncEnabled(options);
    expect(newState).toBe(!initialState);

    // Toggle back
    await toggleTabSync(options, initialState);
  });

  test('history sync toggle can be changed', async () => {
    const initialState = await isHistorySyncEnabled(options);

    // Toggle
    await toggleHistorySync(options, !initialState);

    const newState = await isHistorySyncEnabled(options);
    expect(newState).toBe(!initialState);

    // Toggle back
    await toggleHistorySync(options, initialState);
  });

  test('feature descriptions are present', async () => {
    const descriptions = options.locator('.feature-description');
    const count = await descriptions.count();
    expect(count).toBeGreaterThanOrEqual(3); // bookmark, tab, history
  });
});
