/**
 * Extension Test Utilities
 *
 * Helper functions for testing the browser extension popup and options pages.
 */

import { Page } from '@playwright/test';

// ==================== Popup Helpers ====================

/**
 * Wait for the command input to be ready and focused
 */
export async function waitForCommandInput(page: Page, timeout = 5000): Promise<void> {
  await page.waitForSelector('#command-input', { state: 'visible', timeout });
  // Wait for input to be focused (popup.js calls focus on init)
  await page.waitForFunction(
    () => document.activeElement?.id === 'command-input',
    { timeout }
  );
}

/**
 * Type a command in the popup command bar
 */
export async function typeCommand(page: Page, command: string): Promise<void> {
  const input = page.locator('#command-input');
  await input.fill(command);
}

/**
 * Press Tab to autocomplete in the popup
 */
export async function tabComplete(page: Page): Promise<void> {
  await page.keyboard.press('Tab');
}

/**
 * Press Enter to execute the current command
 */
export async function executeCommand(page: Page): Promise<void> {
  await page.keyboard.press('Enter');
}

/**
 * Press Escape to close the popup
 */
export async function escapePopup(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
}

/**
 * Get the current typed text from the input
 */
export async function getTypedText(page: Page): Promise<string> {
  return page.locator('#command-input').inputValue();
}

/**
 * Get the display text (including autocomplete suggestion)
 */
export async function getDisplayText(page: Page): Promise<string> {
  return page.locator('#command-text').textContent() || '';
}

/**
 * Check if the placeholder is shown
 */
export async function isPlaceholderShown(page: Page): Promise<boolean> {
  const hasClass = await page.locator('#command-text').evaluate(
    el => el.classList.contains('placeholder')
  );
  return hasClass;
}

/**
 * Get the typed portion text (the white highlighted part)
 */
export async function getTypedPortion(page: Page): Promise<string> {
  const typedSpan = page.locator('#command-text .typed');
  const count = await typedSpan.count();
  if (count === 0) return '';
  return await typedSpan.textContent() || '';
}

// ==================== Options Page Helpers ====================

/**
 * Wait for the options page to initialize
 */
export async function waitForOptionsInit(page: Page, timeout = 10000): Promise<void> {
  // Wait for the page to load
  await page.waitForLoadState('domcontentloaded');

  // Wait for diagnostics to populate (indicates init completed)
  await page.waitForFunction(
    () => {
      const profileEl = document.getElementById('diag-profile');
      return profileEl && profileEl.textContent !== '--';
    },
    { timeout }
  );
}

/**
 * Fill the sync configuration form
 */
export async function fillSyncConfig(
  page: Page,
  config: {
    serverUrl?: string;
    apiKey?: string;
    serverProfileId?: string;
    autoSync?: boolean;
  }
): Promise<void> {
  if (config.serverUrl !== undefined) {
    await page.fill('#server-url', config.serverUrl);
  }
  if (config.apiKey !== undefined) {
    await page.fill('#api-key', config.apiKey);
  }
  if (config.serverProfileId !== undefined) {
    await page.fill('#server-profile-id', config.serverProfileId);
  }
  if (config.autoSync !== undefined) {
    const checkbox = page.locator('#auto-sync');
    const isChecked = await checkbox.isChecked();
    if (isChecked !== config.autoSync) {
      await checkbox.click();
    }
  }
}

/**
 * Click the save config button
 */
export async function saveSyncConfig(page: Page): Promise<void> {
  await page.click('#save-config');
}

/**
 * Get the config status message
 */
export async function getConfigStatus(page: Page): Promise<string> {
  return await page.locator('#config-status').textContent() || '';
}

/**
 * Get diagnostic values from the options page
 */
export async function getDiagnostics(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const getValue = (id: string) => document.getElementById(id)?.textContent || '';
    return {
      items: getValue('diag-items'),
      tags: getValue('diag-tags'),
      pending: getValue('diag-pending'),
      lastSync: getValue('diag-last-sync'),
      configured: getValue('diag-configured'),
      profile: getValue('diag-profile'),
      dsVersion: getValue('diag-ds-version'),
      protoVersion: getValue('diag-proto-version'),
      deviceId: getValue('diag-device-id'),
      browser: getValue('diag-browser'),
      buildId: getValue('diag-build-id'),
      osArch: getValue('diag-os-arch'),
      extVersion: getValue('diag-ext-version'),
    };
  });
}

/**
 * Click the refresh diagnostics button
 */
export async function refreshDiagnostics(page: Page): Promise<void> {
  await page.click('#btn-refresh');
  // Wait for refresh to complete
  await page.waitForTimeout(500);
}

/**
 * Get the diagnostics status message
 */
export async function getDiagStatus(page: Page): Promise<string> {
  return await page.locator('#diag-status').textContent() || '';
}

/**
 * Click the Pull button
 */
export async function clickPull(page: Page): Promise<void> {
  await page.click('#btn-pull');
}

/**
 * Click the Push button
 */
export async function clickPush(page: Page): Promise<void> {
  await page.click('#btn-push');
}

/**
 * Click the Sync All button
 */
export async function clickSyncAll(page: Page): Promise<void> {
  await page.click('#btn-sync-all');
}

/**
 * Toggle bookmark sync checkbox
 */
export async function toggleBookmarkSync(page: Page, enabled: boolean): Promise<void> {
  const checkbox = page.locator('#bookmark-sync');
  const isChecked = await checkbox.isChecked();
  if (isChecked !== enabled) {
    await checkbox.click();
  }
}

/**
 * Toggle tab sync checkbox
 */
export async function toggleTabSync(page: Page, enabled: boolean): Promise<void> {
  const checkbox = page.locator('#tab-sync');
  const isChecked = await checkbox.isChecked();
  if (isChecked !== enabled) {
    await checkbox.click();
  }
}

/**
 * Toggle history sync checkbox
 */
export async function toggleHistorySync(page: Page, enabled: boolean): Promise<void> {
  const checkbox = page.locator('#history-sync');
  const isChecked = await checkbox.isChecked();
  if (isChecked !== enabled) {
    await checkbox.click();
  }
}

/**
 * Check if bookmark sync is enabled
 */
export async function isBookmarkSyncEnabled(page: Page): Promise<boolean> {
  return page.locator('#bookmark-sync').isChecked();
}

/**
 * Check if tab sync is enabled
 */
export async function isTabSyncEnabled(page: Page): Promise<boolean> {
  return page.locator('#tab-sync').isChecked();
}

/**
 * Check if history sync is enabled
 */
export async function isHistorySyncEnabled(page: Page): Promise<boolean> {
  return page.locator('#history-sync').isChecked();
}

/**
 * Wait for status message to appear and contain text
 */
export async function waitForStatusMessage(
  page: Page,
  statusSelector: string,
  expectedText: string | RegExp,
  timeout = 5000
): Promise<void> {
  await page.waitForFunction(
    ({ sel, text }) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const content = el.textContent || '';
      if (typeof text === 'string') {
        return content.includes(text);
      }
      return new RegExp(text).test(content);
    },
    { sel: statusSelector, text: expectedText instanceof RegExp ? expectedText.source : expectedText },
    { timeout }
  );
}
