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
 *   yarn test:extension:browser  - Run in Chrome (automated)
 *   yarn extension:firefox       - Run in Firefox (manual, web-ext)
 *
 * Note: Firefox Playwright extension testing is not supported due to
 * limitations in how Playwright's Firefox handles extension installation.
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
      // Tests that exercise OS-integration behavior (modal panel focus/blur,
      // keyboard flows driving the cmd panel) are fragile under fullyParallel +
      // workers>1. yarn test:electron runs this project as a SEPARATE
      // playwright invocation with --workers=1, after the parallel project
      // finishes, so no other Electron instances are competing.
      name: 'desktop-serial',
      testMatch: /desktop-serial\/.*\.spec\.ts/,
      fullyParallel: false,
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
      // Firefox not supported - use yarn extension:firefox for manual testing
    },
  ],

  // Test execution settings
  timeout: 60000,
  expect: {
    timeout: 10000
  },

  // Playwright workers — each runs in its own Electron with its own
  // --user-data-dir (see tests/fixtures/desktop-app.ts). The single-instance
  // lock is bypassed when the profile starts with "test" (see
  // `isTestProfile()` in backend/electron/config.ts), so parallel workers
  // don't collide on the lock. Default is 1 (both local and CI) for
  // reliability: the parallelism payoff is minor while smoke.spec.ts is a
  // single-file bottleneck, and concurrent Electron launches surface
  // occasional OS-level races. Set `PEEK_TEST_WORKERS=N` to opt in to
  // parallelism once smoke.spec.ts has been split into smaller files.
  //
  // fullyParallel: false — tests within a file run serially in one worker,
  // different files distribute across workers. We tried fullyParallel: true
  // but OS-level cross-Electron focus/timing races under 4 parallel workers
  // surfaced in too many scattered tests. Current choice trades raw
  // parallelism for stability; smoke.spec.ts (the big file, ~218 tests)
  // bottlenecks on one worker but the rest of the suite distributes freely.
  // To recover more parallelism, the right move is to split smoke.spec.ts
  // into smaller files rather than re-enable fullyParallel.
  fullyParallel: false,
  workers: parseInt(process.env.PEEK_TEST_WORKERS || '1'),

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
