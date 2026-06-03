/**
 * Focus LAUNCH-CHURN probe — opt-in, isolates pure process launch/teardown.
 *
 * The single-instance focus-probe stepped through every in-app focus operation
 * (policy transitions, dock, app.focus, window showInactive) and produced ZERO
 * blips. The blips only appeared in the 4-worker `Window` run (many cold
 * launch/teardown cycles + window-manipulation tests). This probe isolates the
 * remaining variable: PURE launch/teardown churn with NO window operations.
 *
 * It spins up N independent per-describe app instances (each: launch → trivial
 * assert → close), nothing else. Run at the default 4 workers so multiple cold
 * launches overlap (the suspected race condition). If your input blips during
 * this run the way it did in the `Window` run, the LAUNCH/TEARDOWN itself is
 * the cause — not the window-manipulation tests. If this run is silent, the
 * blip is something specific those window tests do.
 *
 * SKIPS unless PEEK_FOCUS_CHURN=1. Run (default workers=4 = overlapping launches):
 *
 *   PEEK_FOCUS_CHURN=1 HEADLESS=1 BACKEND=electron \
 *     npx playwright test apps/desktop/tests/desktop/focus-launch-churn.spec.ts \
 *     --config apps/desktop/playwright.config.ts --project=desktop
 *
 * Type continuously in another app throughout and note any input blips.
 */

import { test, expect, DesktopApp } from '../../apps/desktop/tests/fixtures/desktop-app';
import { createPerDescribeApp } from '../../apps/desktop/tests/helpers/test-app';

test.skip(
  process.env.PEEK_FOCUS_CHURN !== '1',
  'opt-in launch-churn probe — set PEEK_FOCUS_CHURN=1',
);

// Each describe = one independent cold launch (createPerDescribeApp) + teardown,
// with NO window operations. 8 of them across 4 workers = overlapping churn.
const LAUNCHES = 8;

for (let i = 0; i < LAUNCHES; i++) {
  test.describe(`Launch churn ${i} @desktop`, () => {
    let app: DesktopApp;

    test.beforeAll(async () => {
      ({ app } = await createPerDescribeApp(`focus-churn-${i}`));
    });

    test.afterAll(async () => {
      if (app) await app.close();
    });

    test(`cold launch ${i} then idle, no window ops`, async () => {
      // Hold the instance briefly so launches overlap across workers and there
      // is a window to type against. No show/focus/policy calls.
      await new Promise((r) => setTimeout(r, 2500));
      expect(true).toBe(true);
    });
  });
}
