/**
 * Focus OVERLAY probe — opt-in, tests the alwaysOnTop switcher overlay.
 *
 * Narrowing so far EXONERATED: launch/teardown churn, in-app ops
 * (policy/dock/app.focus/raw showInactive), and content (page-host canvas) +
 * peek (workspace) window-open via the app path — all smooth, single instance.
 *
 * The only choppy run was the 4-worker `Window` grep, which matched
 * `windows-lazy-wake.spec.ts` ("Windows Lazy Wake") — and that opens the
 * windows SWITCHER OVERLAY (role:'overlay', alwaysOnTop, fullscreen) ~2 times,
 * matching the "two distinct blips" observed. Also: the only earlier probe that
 * DID blip used setAlwaysOnTop(true); every smooth probe since did not.
 *
 * Hypothesis: opening an alwaysOnTop overlay (the switcher) grabs OS focus.
 * This probe opens + closes the switcher overlay repeatedly, single instance,
 * via the real lazy-wake path (publish cmd:execute:windows). Type continuously;
 * if THIS is choppy while the content/peek probes were smooth, the alwaysOnTop
 * overlay open is the exact cause.
 *
 * SKIPS unless PEEK_FOCUS_OVERLAY=1. Run cool (single instance), headless:
 *
 *   PEEK_FOCUS_OVERLAY=1 PEEK_TEST_WORKERS=1 HEADLESS=1 BACKEND=electron \
 *     npx playwright test apps/desktop/tests/desktop/focus-probe-overlay.spec.ts \
 *     --config apps/desktop/playwright.config.ts --project=desktop --workers=1
 */

import { test, expect, DesktopApp } from '../../apps/desktop/tests/fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../../apps/desktop/tests/helpers/test-app';
import { waitForExtensionsReady } from '../../apps/desktop/tests/helpers/window-utils';

const OPENS = 6;

test.skip(
  process.env.PEEK_FOCUS_OVERLAY !== '1',
  'opt-in overlay probe — set PEEK_FOCUS_OVERLAY=1 and run with --workers=1',
);

test.describe('Focus Overlay Probe @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('focus-overlay-probe'));
    await waitForExtensionsReady(bgWindow, 15000);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('repeatedly open + close the alwaysOnTop windows switcher overlay', async () => {
    test.setTimeout(OPENS * 12000 + 40000);

    console.log('\n[ovprobe] ============================================================');
    console.log('[ovprobe] Settling 6s — then open+close the windows SWITCHER OVERLAY');
    console.log(`[ovprobe] ${OPENS} times (alwaysOnTop, fullscreen). TYPE CONTINUOUSLY in`);
    console.log('[ovprobe] your other app the whole time. Report: choppy or smooth?');
    console.log('[ovprobe] ============================================================\n');

    await new Promise((r) => setTimeout(r, 6000));

    for (let i = 0; i < OPENS; i++) {
      // Open the switcher via the real lazy-wake path (what the hotkey does).
      await app.evaluateMain!(((_e: unknown) => {
        (globalThis as any).__peek_test.publishCmdExecute('windows');
      }) as any);

      const overlay = await app.getWindow('windows/windows.html', 10000).catch(() => null);
      console.log(`[ovprobe] open ${i + 1}/${OPENS} switcher overlay present=${!!overlay}  <-- watch now`);
      await new Promise((r) => setTimeout(r, 2500));

      // Close the overlay so the next iteration re-opens it fresh.
      await app.evaluateMain!(((electron: typeof import('electron')) => {
        const { BrowserWindow } = electron;
        for (const w of BrowserWindow.getAllWindows()) {
          try {
            if (!w.isDestroyed() && w.webContents.getURL().includes('windows/windows.html')) w.close();
          } catch { /* gone */ }
        }
      }) as any);
      await new Promise((r) => setTimeout(r, 2000));
    }

    console.log('\n[ovprobe] DONE. Was your typing choppy or smooth during the overlay opens?\n');
    expect(true).toBe(true);
  });
});
