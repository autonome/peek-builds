/**
 * Playwright Configuration for Peek Tests
 *
 * Supports multiple backends via BACKEND environment variable:
 *   BACKEND=electron yarn test:desktop
 *   BACKEND=tauri yarn test:desktop
 *
 * Test organization:
 *   tests/desktop/     - Cross-backend desktop tests
 *   tests/extension/   - Browser extension e2e tests (Chrome only)
 *   backend/{name}/tests/ - Backend-specific tests
 *
 * Extension tests:
 *   yarn test:extension:browser   - Run in Chrome (Playwright)
 *   yarn extension:firefox        - Run in Firefox (web-ext, manual)
 *
 * Note: Firefox extension testing via Playwright is not supported.
 * Playwright's Firefox doesn't load extensions from profiles.
 */

import { defineConfig } from '@playwright/test';

const backend = process.env.BACKEND || 'electron';

export default defineConfig({
  testDir: './tests',

  // Projects for different test categories
  projects: [
    {
      name: 'desktop',
      testMatch: /desktop\/.*\.spec\.ts/,
    },
    {
      name: 'components',
      testMatch: /components\/.*\.spec\.ts/,
      use: {
        // Component tests run in browser, not Electron
        browserName: 'chromium',
      },
    },
    {
      name: 'editor',
      testMatch: /editor\/.*\.spec\.ts/,
      use: {
        // Editor tests run in browser
        browserName: 'chromium',
      },
    },
    {
      name: 'extension-chrome',
      testMatch: /extension\/.*\.spec\.ts/,
      // Extension tests use custom fixture that launches Chrome with extension
      // No browser setting here - fixture handles browser launch
    },
    // Note: extension-firefox project removed - Playwright Firefox doesn't support extensions
    // Use `yarn extension:firefox` (web-ext) for Firefox testing
  ],

  // Test execution settings
  timeout: 60000,
  expect: {
    timeout: 10000
  },

  // Desktop app tests must run serially
  fullyParallel: false,
  workers: 1,

  // CI settings
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  // Reporters
  reporter: [
    ['list'],
    ['html', { open: 'never' }]
  ],

  // Global settings
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  // Metadata
  metadata: {
    backend,
  },
});
