/**
 * Runner config for the focus-probe diagnostic instruments.
 *
 * These are NOT part of any test gate — they're manual, opt-in probes built
 * for the macOS headless focus investigation (peek task 2b55f3af). Each probe
 * is gated behind its own PEEK_FOCUS_* env var and SKIPS unless opted in, and
 * they live here (outside apps/desktop/tests/) precisely so the desktop gate
 * never picks them up. They reuse the desktop app fixture
 * (apps/desktop/tests/fixtures/desktop-app) via relative imports.
 *
 * Run from the repo ROOT. Build the desktop app first (`yarn build`) so the
 * source launch has dist/, or pass PACKAGED=1 to reuse out/mac-arm64/Peek.app.
 * See README.md in this directory for each probe's env var + purpose.
 *
 * Example:
 *   PEEK_FOCUS_PROBE=1 PEEK_TEST_WORKERS=1 HEADLESS=1 BACKEND=electron \
 *     npx playwright test --config tools/focus-probes/playwright.config.ts \
 *     focus-probe.spec.ts --workers=1
 */
import { defineConfig } from '@playwright/test';

const backend = process.env.BACKEND || 'electron';

export default defineConfig({
  testDir: '.',
  projects: [{ name: 'focus-probes', testMatch: /.*\.spec\.ts$/ }],
  timeout: 180_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: parseInt(process.env.PEEK_TEST_WORKERS || '1', 10),
  reporter: [['list']],
  use: { trace: 'off', screenshot: 'off' },
  metadata: { backend },
});
