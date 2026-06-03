/**
 * Focus WINDOW probe — opt-in, isolates the window-OPEN path by REPETITION.
 *
 * Prior probes exonerated launch/teardown churn and in-app ops. The blip only
 * appeared with the real `Window*` tests, which open windows via the app's
 * window.open path. This probe opens ONE kind of window repeatedly so the
 * effect is cumulative — you don't need to know exact timing, just whether your
 * typing catches repeatedly (choppy) or stays smooth across the whole run.
 *
 *   KIND=content (default) → about:blank via app.window.open → page-host CANVAS
 *   KIND=peek             → peek://app/settings/settings.html → workspace window
 *
 * Run it once per kind and compare:
 *   PEEK_FOCUS_WINPROBE=1 PEEK_WINPROBE_KIND=content PEEK_TEST_WORKERS=1 \
 *     HEADLESS=1 BACKEND=electron npx playwright test \
 *     apps/desktop/tests/desktop/focus-probe-window.spec.ts \
 *     --config apps/desktop/playwright.config.ts --project=desktop --workers=1
 *
 * If CONTENT is choppy and PEEK is smooth, the page-host canvas window-open is
 * the cause. SKIPS unless PEEK_FOCUS_WINPROBE=1.
 */

import { test, expect, DesktopApp } from '../../apps/desktop/tests/fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../../apps/desktop/tests/helpers/test-app';

test.skip(
  process.env.PEEK_FOCUS_WINPROBE !== '1',
  'opt-in window-open probe — set PEEK_FOCUS_WINPROBE=1 and run with --workers=1',
);

const KIND = process.env.PEEK_WINPROBE_KIND === 'peek' ? 'peek' : 'content';
const URL = KIND === 'peek' ? 'peek://app/settings/settings.html' : 'about:blank';
const OPENS = 8;

test.describe('Focus Window Probe @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('focus-win-probe'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test(`repeatedly open+close ${KIND} windows`, async () => {
    const HOLD_MS = 1800;
    const GAP_MS = 900;
    test.setTimeout(OPENS * (HOLD_MS + GAP_MS + 4000) + 30000);

    console.log(`\n[winprobe] ============================================================`);
    console.log(`[winprobe] KIND=${KIND}  url=${URL}`);
    console.log(`[winprobe] Settling 6s — then ${OPENS} open+close cycles. TYPE CONTINUOUSLY`);
    console.log(`[winprobe] in your other app the WHOLE time. Report: choppy or smooth?`);
    console.log(`[winprobe] ============================================================\n`);

    // Settle so the launch is well behind us before the opens begin.
    await new Promise((r) => setTimeout(r, 6000));

    for (let i = 0; i < OPENS; i++) {
      const opened = await bgWindow.evaluate(async (url: string) => {
        try {
          return await (window as any).app.window.open(url, { width: 700, height: 500 });
        } catch (e) {
          return { success: false, error: String(e) };
        }
      }, URL);
      console.log(`[winprobe] open ${i + 1}/${OPENS} ${KIND} -> ${JSON.stringify(opened)}`);
      await new Promise((r) => setTimeout(r, HOLD_MS));

      const id = (opened as any)?.id;
      if (id != null) {
        await bgWindow.evaluate(async (wid: number) => {
          try { await (window as any).app.window.close(wid); } catch { /* gone */ }
        }, id);
      }
      await new Promise((r) => setTimeout(r, GAP_MS));
    }

    console.log(`\n[winprobe] DONE (${KIND}). Was your typing choppy or smooth across the run?\n`);
    expect(true).toBe(true);
  });
});
