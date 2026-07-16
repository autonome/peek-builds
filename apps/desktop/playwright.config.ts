/**
 * Playwright Configuration for Peek Tests
 *
 * Supports multiple backends via BACKEND environment variable:
 *   BACKEND=electron yarn test:desktop:electron
 *   BACKEND=tauri yarn test:desktop:tauri
 *
 * Test organization:
 *   tests/desktop/     - Cross-backend desktop tests
 *   tests/extension/   - Browser extension e2e tests (Chrome only)
 *   apps/{name}/tests/ - Backend-specific tests
 *
 * Extension tests:
 *   yarn test:extension:chrome  - Run in Chrome (automated)
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
      // Anchor to /tests/desktop/. A bare /desktop\// also matches the shared
      // apps/desktop/ path prefix, so it greedily pulls in EVERY sibling
      // project's specs (desktop-serial, components, editor, extension) —
      // double-running them and, worse, running the serial specs in parallel.
      // Keep the /tests/ anchor + trailing $.
      testMatch: /\/tests\/desktop\/.*\.spec\.ts$/,
    },
    {
      // Tests that exercise OS-integration behavior (modal panel focus/blur,
      // keyboard flows driving the cmd panel) are fragile under fullyParallel +
      // workers>1. yarn test:desktop:electron runs this project as a SEPARATE
      // playwright invocation with --workers=1, after the parallel project
      // finishes, so no other Electron instances are competing.
      name: 'desktop-serial',
      testMatch: /\/tests\/desktop-serial\/.*\.spec\.ts$/,
      fullyParallel: false,
    },
    {
      // Specs that drive REAL native macOS fullscreen (setFullScreen()),
      // which allocates its own Space and animates the display — the
      // headless mechanism (setOpacity(0)) cannot suppress that, so these
      // specs visibly disrupt whoever is at the machine even "headless".
      // Deliberately NOT included in `yarn test:desktop:electron`, and not
      // reachable from `yarn test:grep` (whose path filter is
      // apps/desktop/tests/desktop/). Run it by hand before a push:
      // `yarn test:desktop:disruptive`. Same serial shape as desktop-serial.
      name: 'desktop-disruptive',
      // Anchor to /tests/desktop-disruptive/ with a trailing $ — a bare
      // /desktop-disruptive\// would still be fine here, but a bare
      // /desktop\// (as used by the `desktop` project) would greedily
      // prefix-match this directory too, so keep both testMatch patterns
      // anchored the same way.
      testMatch: /\/tests\/desktop-disruptive\/.*\.spec\.ts$/,
      fullyParallel: false,
    },
    {
      name: 'components',
      testMatch: /\/tests\/components\/.*\.spec\.ts$/,
      use: {
        // Component tests run in browser, not Electron
        browserName: 'chromium',
      },
    },
    {
      name: 'editor',
      testMatch: /\/tests\/editor\/.*\.spec\.ts$/,
      use: {
        // Editor tests run in browser
        browserName: 'chromium',
      },
    },
    {
      name: 'extension-chrome',
      testMatch: /\/tests\/extension\/.*\.spec\.ts$/,
      // Extension tests use custom fixture that launches Chrome with extension
      // Firefox not supported - use yarn extension:firefox for manual testing
    },
    {
      // Manual debugging harness — see tests/manual/README.md.
      // Not included in `yarn test:desktop:electron`; run via `yarn harness`.
      // Long timeout because runs are interactive (humans drive the UI
      // while the tracer records). Workers must be 1 (set via CLI in the
      // yarn script) so the human only has to deal with one window stack.
      name: 'manual',
      testMatch: /\/tests\/manual\/.*\.harness\.ts$/,
      fullyParallel: false,
      timeout: 600_000,
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
  // `isTestProfile()` in apps/desktop/main/config.ts), so parallel workers
  // don't collide on the lock.
  //
  // Default is 4 on macOS/Windows (real parallelism across ~44 spec files),
  // 1 on Linux. Asahi/Fedora/Wayland chokes on 4 simultaneous Electron
  // instances even with PEEK_HEADLESS=1: tests cluster-fail across page-host
  // / permission-prompt / page-load / page-navbar specs and the OS marks
  // some Electron processes hung (see 2026-05-08 incident — required force-
  // close). Untested whether other Linux desktops (X11, KDE) hit the same;
  // gate broadly until we have data. Override with `PEEK_TEST_WORKERS=N`.
  //
  // fullyParallel: false — tests within a file run serially in one worker,
  // different files distribute across workers. fullyParallel: true exposed
  // OS-level cross-Electron focus/timing races; also conflicts with the
  // intra-test ordering some describes rely on (e.g. Extension Lifecycle:
  // add → update → remove). File-level parallelism is enough.
  //
  // Cmd-panel-keyboard-flow tests live in tests/desktop-serial/ (separate
  // project) because they hit OS-level modal focus/blur that misbehaves
  // when N Electron instances are competing. `yarn test:desktop:electron` runs
  // the desktop project at PEEK_TEST_WORKERS, then runs desktop-serial
  // afterward at --workers=1.
  fullyParallel: false,
  workers: parseInt(
    process.env.PEEK_TEST_WORKERS || (process.platform === 'linux' ? '1' : '4')
  ),

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
