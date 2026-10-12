/**
 * Shared per-describe app factory for Playwright smoke tests.
 *
 * Each describe block calls createPerDescribeApp(label) in its beforeAll to
 * launch a fresh Electron instance with an isolated profile. The profile name
 * MUST start with "test" so that isTestProfile() in apps/desktop/main/config.ts
 * skips the single-instance lock — without that prefix, parallel Playwright
 * workers would all contend for the same machine-wide lock and only one
 * Electron launch would succeed.
 */

import { DesktopApp, launchDesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { waitForExtensionsReady, waitForStartupWindowOpened } from './window-utils';

export async function createPerDescribeApp(label: string): Promise<{ app: DesktopApp; bgWindow: Page }> {
  // Profile MUST start with "test" — `isTestProfile()` in apps/desktop/main/config.ts
  // keys on that prefix to skip the single-instance lock. Without it, parallel
  // Playwright workers would all contend for the same machine-wide lock and
  // only one Electron launch would succeed.
  const profile = `test-smoke-${label.replace(/[^a-z0-9]/gi, '-')}-${Date.now()}`;
  const app = await launchDesktopApp(profile);
  const bgWindow = await app.getBackgroundWindow();
  await waitForExtensionsReady(bgWindow);
  await waitForStartupWindowOpened(app);
  return { app, bgWindow };
}
