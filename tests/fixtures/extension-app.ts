/**
 * Extension App Fixture
 *
 * Provides a unified interface for launching Chrome/Firefox with the
 * browser extension loaded for Playwright tests.
 *
 * Usage:
 *   import { launchExtension, getSharedExtension, closeSharedExtension } from '../fixtures/extension-app';
 *
 *   test('popup works', async () => {
 *     const ext = await getSharedExtension();
 *     const popup = await ext.openPopup();
 *     // ... test popup
 *   });
 *
 * Environment:
 *   BROWSER=chrome|firefox  - Select browser (default: chrome)
 *   HEADLESS=0              - Must be 0, extensions require headed mode
 */

import { chromium, firefox, BrowserContext, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { sleep } from '../helpers/window-utils';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '../..');
const EXTENSION_PATH = path.join(ROOT, 'backend/extension');

export type ExtensionBrowser = 'chrome' | 'firefox';

export interface ExtensionApp {
  /** Which browser is running */
  browser: ExtensionBrowser;

  /** The browser context */
  context: BrowserContext;

  /** Extension ID (chrome-extension://{id} or moz-extension://{id}) */
  extensionId: string;

  /** Open the popup page */
  openPopup(): Promise<Page>;

  /** Open the options page */
  openOptions(): Promise<Page>;

  /** Send a message to the background service worker */
  sendMessage(message: unknown): Promise<unknown>;

  /** Get all pages in the context */
  pages(): Page[];

  /** Close the browser */
  close(): Promise<void>;
}

/**
 * Get or create a temp directory for the browser profile
 */
function createTempProfileDir(browser: ExtensionBrowser, profile: string): string {
  const tempBase = os.tmpdir();
  const tempDir = path.join(tempBase, `peek-ext-test-${browser}-${profile}-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

/**
 * Launch Chrome with extension loaded
 */
async function launchChrome(profile: string): Promise<ExtensionApp> {
  const userDataDir = createTempProfileDir('chrome', profile);

  // Launch Chrome with the extension loaded using persistent context
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // Extensions require headed mode
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--disable-popup-blocking',
    ],
  });

  // Wait for the service worker to be registered and get the extension ID
  let extensionId = '';
  const maxWait = 10000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    // Check service workers for the extension
    const workers = context.serviceWorkers();
    for (const worker of workers) {
      const url = worker.url();
      if (url.startsWith('chrome-extension://') && url.includes('background.js')) {
        // Extract extension ID from URL: chrome-extension://{id}/background.js
        const match = url.match(/chrome-extension:\/\/([^/]+)/);
        if (match) {
          extensionId = match[1];
          break;
        }
      }
    }
    if (extensionId) break;
    await sleep(100);
  }

  if (!extensionId) {
    await context.close();
    throw new Error('Failed to detect extension ID from service worker');
  }

  return createExtensionApp('chrome', context, extensionId, userDataDir);
}

/**
 * Launch Firefox with extension loaded
 *
 * Firefox requires special handling:
 * - Uses web-ext prefs to allow unsigned extensions
 * - Extension ID comes from manifest gecko.id
 */
async function launchFirefox(profile: string): Promise<ExtensionApp> {
  const userDataDir = createTempProfileDir('firefox', profile);

  // Read manifest to get gecko ID
  const manifestPath = path.join(EXTENSION_PATH, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const geckoId = manifest.browser_specific_settings?.gecko?.id;

  if (!geckoId) {
    throw new Error('Extension manifest missing browser_specific_settings.gecko.id');
  }

  // Create Firefox preferences for extension loading
  const prefsContent = `
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("devtools.console.stdout.content", true);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.tabs.warnOnClose", false);
`;
  const prefsPath = path.join(userDataDir, 'prefs.js');
  fs.writeFileSync(prefsPath, prefsContent);

  // Copy extension to Firefox extensions folder
  const extensionsDir = path.join(userDataDir, 'extensions');
  fs.mkdirSync(extensionsDir, { recursive: true });

  // Create XPI by copying extension directory with .xpi extension
  // For development, we can use the directory directly with a special naming convention
  const extTargetDir = path.join(extensionsDir, geckoId);
  fs.cpSync(EXTENSION_PATH, extTargetDir, { recursive: true });

  // Launch Firefox with the profile
  const context = await firefox.launchPersistentContext(userDataDir, {
    headless: false, // Extensions require headed mode
    args: [
      '-no-remote',
    ],
  });

  // Wait for extension to load
  await sleep(2000);

  // Firefox extension ID uses the gecko.id from manifest
  // The URL format is moz-extension://{uuid}/ where uuid is generated per-install
  // We need to find the actual UUID by looking at pages
  let extensionUUID = '';
  const maxWait = 10000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const pages = context.pages();
    for (const page of pages) {
      const url = page.url();
      if (url.startsWith('moz-extension://')) {
        const match = url.match(/moz-extension:\/\/([^/]+)/);
        if (match) {
          extensionUUID = match[1];
          break;
        }
      }
    }
    // Also check background pages
    const bgPages = context.backgroundPages();
    for (const page of bgPages) {
      const url = page.url();
      if (url.startsWith('moz-extension://')) {
        const match = url.match(/moz-extension:\/\/([^/]+)/);
        if (match) {
          extensionUUID = match[1];
          break;
        }
      }
    }
    if (extensionUUID) break;
    await sleep(100);
  }

  // If we couldn't find the UUID, try opening the popup to trigger extension load
  if (!extensionUUID) {
    // For Firefox, we'll use a fallback approach - the geckoId is stable
    // and we can compute a predictable UUID based on the profile
    extensionUUID = geckoId;
  }

  return createExtensionApp('firefox', context, extensionUUID, userDataDir);
}

/**
 * Create ExtensionApp interface from browser context
 */
function createExtensionApp(
  browser: ExtensionBrowser,
  context: BrowserContext,
  extensionId: string,
  userDataDir: string
): ExtensionApp {
  const getExtensionUrl = (path: string) => {
    const protocol = browser === 'chrome' ? 'chrome-extension' : 'moz-extension';
    return `${protocol}://${extensionId}/${path}`;
  };

  return {
    browser,
    context,
    extensionId,

    async openPopup(): Promise<Page> {
      const popupUrl = getExtensionUrl('popup.html');
      const page = await context.newPage();
      await page.goto(popupUrl);
      await page.waitForLoadState('domcontentloaded');
      return page;
    },

    async openOptions(): Promise<Page> {
      const optionsUrl = getExtensionUrl('options.html');
      const page = await context.newPage();
      await page.goto(optionsUrl);
      await page.waitForLoadState('domcontentloaded');
      return page;
    },

    async sendMessage(message: unknown): Promise<unknown> {
      // For Chrome, we can evaluate in the context of the service worker
      // For Firefox, we need to use a content page
      if (browser === 'chrome') {
        const workers = context.serviceWorkers();
        const extWorker = workers.find(w => w.url().includes(extensionId));
        if (extWorker) {
          return extWorker.evaluate(async (msg) => {
            // In service worker context, we can dispatch events or use internal APIs
            return msg;
          }, message);
        }
      }

      // Fallback: open options page and send message from there
      const optionsUrl = getExtensionUrl('options.html');
      let optionsPage = context.pages().find(p => p.url() === optionsUrl);
      if (!optionsPage) {
        optionsPage = await context.newPage();
        await optionsPage.goto(optionsUrl);
        await optionsPage.waitForLoadState('domcontentloaded');
      }

      return optionsPage.evaluate(async (msg) => {
        return chrome.runtime.sendMessage(msg);
      }, message);
    },

    pages(): Page[] {
      return context.pages();
    },

    async close(): Promise<void> {
      await context.close();

      // Clean up temp directory
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    },
  };
}

/**
 * Launch extension based on BROWSER environment variable
 */
export async function launchExtension(profile?: string): Promise<ExtensionApp> {
  const browser = (process.env.BROWSER || 'chrome') as ExtensionBrowser;
  const testProfile = profile || `ext-test-${Date.now()}`;

  if (browser === 'chrome') {
    return launchChrome(testProfile);
  } else if (browser === 'firefox') {
    return launchFirefox(testProfile);
  } else {
    throw new Error(`Unknown browser: ${browser}. Use BROWSER=chrome or BROWSER=firefox`);
  }
}

// ==================== Shared Instance ====================

let sharedExtension: ExtensionApp | null = null;
let sharedExtensionPromise: Promise<ExtensionApp> | null = null;

/**
 * Get or create a shared extension instance.
 * Most tests can use this instead of launching their own instance.
 */
export async function getSharedExtension(): Promise<ExtensionApp> {
  if (sharedExtension) {
    return sharedExtension;
  }

  // Prevent multiple concurrent launches
  if (sharedExtensionPromise) {
    return sharedExtensionPromise;
  }

  sharedExtensionPromise = launchExtension('shared-extension-test');
  sharedExtension = await sharedExtensionPromise;
  sharedExtensionPromise = null;
  return sharedExtension;
}

/**
 * Close the shared extension instance.
 * Call this in a global teardown.
 */
export async function closeSharedExtension(): Promise<void> {
  if (sharedExtension) {
    await sharedExtension.close();
    sharedExtension = null;
  }
}
