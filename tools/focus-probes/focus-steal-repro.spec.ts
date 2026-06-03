/**
 * Focus-steal repro — LOUD, manual, opt-in, and an A/B test of the suspect.
 *
 * The reported bug is INVISIBLE in normal runs: headless test windows are
 * opacity:0, so when a launch/activation disrupts macOS focus you can't SEE
 * it — you only notice your other app's input went dead until a cmd-tab cycle.
 *
 * This instrument runs NON-headless (real, visible windows) and, each round,
 * sets the macOS activation policy itself, then OPAQUE-shows + MAXIMIZES +
 * focuses a fresh window and steals app focus — so the grab is unmistakable.
 * It ALTERNATES the activation policy across rounds:
 *     odd rounds → 'prohibited'   (the suspect — what Peek's headless path uses)
 *     even rounds → 'regular'     (a normal app)
 * so you can A/B whether the 'prohibited' rounds are the ones that strand your
 * other app's input while the 'regular' rounds return focus cleanly. That
 * directly tests the "the 'prohibited' policy is the recent regression"
 * hypothesis.
 *
 * Why non-headless: under PEEK_HEADLESS=1 Peek installs a BrowserWindow.show /
 * focus neutralization layer (entry.ts) plus opacity:0, which would suppress
 * the window and hide the very thing we want to see. Running non-headless turns
 * that off; the test sets 'prohibited' explicitly to reproduce the bug
 * condition WITHOUT the visibility suppression.
 *
 * This is an OBSERVATION instrument, not an automated assertion: macOS
 * active-app / key-window state is not observable from Playwright (which is why
 * headless-no-focus-theft.spec.ts passes while the bug exists). The test always
 * "passes"; YOU are the oracle.
 *
 * SKIPS unless you opt in with PEEK_FOCUS_STEAL_REPRO=1.
 *
 * RUN IT (visible — it WILL grab your screen focus; keep workers=1):
 *
 *   PEEK_FOCUS_STEAL_REPRO=1 HEADLESS=0 BACKEND=electron \
 *     npx playwright test apps/desktop/tests/desktop/focus-steal-repro.spec.ts \
 *     --config apps/desktop/playwright.config.ts --project=desktop --workers=1 --headed
 *
 * WHILE IT RUNS: switch to another app (an editor), click into a text field,
 * keep typing. Each round a bright window maximizes and grabs focus and the log
 * prints the policy in effect. After each round, WITHOUT cmd-tabbing, try to
 * type in your editor and note per policy:
 *   - 'regular' rounds: does input return fine?
 *   - 'prohibited' rounds: does input go DEAD until you cmd-tab away+back?
 * If only the 'prohibited' rounds strand you, the activation policy is the cause.
 */

import { test, expect, DesktopApp } from '../../apps/desktop/tests/fixtures/desktop-app';
import { createPerDescribeApp } from '../../apps/desktop/tests/helpers/test-app';

test.skip(
  process.env.PEEK_FOCUS_STEAL_REPRO !== '1',
  'opt-in manual repro — set PEEK_FOCUS_STEAL_REPRO=1 and run non-headless with --workers=1 (it grabs your screen focus)',
);

test.describe('Focus Steal Repro @desktop', () => {
  let app: DesktopApp;

  test.beforeAll(async () => {
    ({ app } = await createPerDescribeApp('focus-steal-repro'));
  });

  test.afterAll(async () => {
    // Restore a normal policy before teardown so the app closes cleanly.
    try {
      await app.evaluateMain!(((electron: typeof import('electron')) => {
        try { (electron.app as any).setActivationPolicy?.('regular'); } catch { /* non-darwin */ }
      }) as any);
    } catch { /* app may already be closing */ }
    if (app) await app.close();
  });

  test('A/B the activation policy while maximizing + stealing focus, so the bug is obvious', async () => {
    const ROUNDS = 6;
    const HOLD_MS = 4500;
    test.setTimeout((ROUNDS + 2) * (HOLD_MS + 4000));

    console.log('\n[focus-steal] ============================================================');
    console.log('[focus-steal] Switch to ANOTHER app NOW (an editor), click a text field,');
    console.log('[focus-steal] and keep typing. Each round maximizes a window + steals focus');
    console.log('[focus-steal] under a stated policy. Note which policy strands your input.');
    console.log('[focus-steal] ============================================================\n');

    for (let i = 1; i <= ROUNDS; i++) {
      const policy = i % 2 === 1 ? 'prohibited' : 'regular';
      const res = await app.evaluateMain!(((electron: typeof import('electron'), arg: { round: number; policy: string }) => {
        const { BrowserWindow, app: elApp } = electron;
        const elAppAny = elApp as unknown as {
          setActivationPolicy?: (p: string) => void;
          focus?: (o?: { steal?: boolean }) => void;
          isActive?: () => boolean;
        };
        // Reproduce the suspect condition for this round.
        try { elAppAny.setActivationPolicy?.(arg.policy); } catch { /* non-darwin */ }

        const w = new BrowserWindow({ width: 900, height: 600, show: false });
        const bg = arg.policy === 'prohibited' ? '%23c0392b' : '%232c3e50';
        const html =
          '<body style="margin:0;background:' + bg + ';color:white;' +
          'font:bold 44px sans-serif;display:flex;align-items:center;' +
          'justify-content:center">ROUND ' + arg.round + ' &mdash; policy=' + arg.policy + '</body>';
        w.loadURL('data:text/html,' + html);
        // Do everything the headless path is built to AVOID:
        try { w.setOpacity(1); } catch { /* opacity unsupported on some platforms */ }
        w.setAlwaysOnTop(true);
        w.show();
        w.maximize();
        w.focus();
        try { elAppAny.focus?.({ steal: true }); } catch { /* best-effort */ }
        // Auto-close after the observation hold. Main-process setTimeout must
        // guard isDestroyed() before touching the window.
        setTimeout(() => { try { if (!w.isDestroyed()) w.close(); } catch { /* gone */ } }, 3500);
        return {
          round: arg.round,
          policy: arg.policy,
          id: w.id,
          winFocused: w.isFocused(),
          appActive: typeof elAppAny.isActive === 'function' ? elAppAny.isActive() : 'n/a',
        };
      }) as any, { round: i, policy });

      console.log(`[focus-steal] round ${i}/${ROUNDS} [policy=${policy}]:`, JSON.stringify(res),
        '  <-- try typing in your other app NOW');
      await new Promise((r) => setTimeout(r, HOLD_MS));
    }

    console.log('\n[focus-steal] DONE. If your input died on the "prohibited" rounds but not');
    console.log('[focus-steal] the "regular" rounds, the activation policy is the cause.\n');

    // You are the oracle — OS active-app state is not observable here.
    expect(true).toBe(true);
  });
});
