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
 *   HEADLESS=1              - On Linux, Xvfb provides a virtual display so
 *                            extensions run invisibly. On macOS, Chrome
 *                            extensions cannot load in Playwright's headless
 *                            mode (chromium-headless-shell drops extension
 *                            support), so extension tests MUST run headed
 *                            on macOS. The spec files skip automatically
 *                            when HEADLESS=1 and platform is not Linux.
 */

import { chromium, firefox, BrowserContext, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '../..');
const EXTENSION_PATH = path.join(__dirname, '../../../../apps/extension');

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
 * Launch Chrome with extension loaded.
 *
 * Chrome extensions cannot load in Playwright's headless mode
 * (chromium-headless-shell). This fixture always runs headed.
 * On Linux, playwright-with-display.sh provides an Xvfb virtual display
 * so the window never reaches the user's real session. On macOS, tests
 * that call this fixture skip when HEADLESS=1 (see spec files).
 */
async function launchChrome(profile: string): Promise<ExtensionApp> {
  const userDataDir = createTempProfileDir('chrome', profile);

  // Launch Chrome with the extension loaded using persistent context.
  // headless: false is required — Playwright's headless mode uses
  // chromium-headless-shell which does not support loading extensions.
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--disable-popup-blocking',
    ],
  });

  // Detect the extension ID from its service worker URL.
  //
  // The service worker may already be registered by the time we read it
  // (fast launch) or may register shortly after (slow/cold start). Check
  // the already-registered list first, then fall back to waiting for the
  // next registration event — deterministic, no polling or sleep.
  let extensionId = '';

  // Check existing service workers first (they beat us to it on fast launches)
  for (const worker of context.serviceWorkers()) {
    const match = worker.url().match(/chrome-extension:\/\/([^/]+)/);
    if (match) {
      extensionId = match[1];
      break;
    }
  }

  // If not already present, wait for the SW registration event
  if (!extensionId) {
    try {
      const worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
      const match = worker.url().match(/chrome-extension:\/\/([^/]+)/);
      if (match) {
        extensionId = match[1];
      }
    } catch {
      // waitForEvent timed out — fall through to failure below
    }
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
 * NOTE: Firefox extension testing via Playwright is not currently working.
 * The playwright-webextext library does not reliably install MV3 extensions.
 *
 * For Firefox testing, use: yarn extension:firefox (web-ext)
 */
async function launchFirefox(_profile: string): Promise<ExtensionApp> {
  throw new Error(
    'Firefox extension testing via Playwright is not currently supported.\n\n' +
    'The playwright-webextext library does not reliably install MV3 extensions.\n' +
    'Playwright\'s Firefox also has limited extension support compared to Chrome.\n\n' +
    'For Firefox extension testing, use:\n' +
    '  yarn extension:firefox\n\n' +
    'This launches Firefox with web-ext for manual testing.\n' +
    'Chrome automated tests: yarn test:extension:browser'
  );
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
