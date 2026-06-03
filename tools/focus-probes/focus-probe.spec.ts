/**
 * Focus PROBE — decompose the focus blip, opt-in, single instance.
 *
 * We confirmed the *stuck* focus came from setActivationPolicy('prohibited').
 * Under 'accessory' a residual *blip* remains (focus briefly taken, then
 * returned). This probe isolates WHICH operation causes that blip by stepping
 * through the distinct focus-affecting things a test run does — ONE per step,
 * with a labeled pause and a timestamp — in a single headless instance.
 *
 * Each step prints `[probe] STEP k  t=<ms-since-start>  <label>` to stdout
 * BEFORE acting, then holds STEP_HOLD_MS so you can watch your other app.
 * Map the blips you feel to the step that just printed (steps are evenly
 * spaced; I'll correlate your "blip at ~Ns" with the logged timestamps).
 *
 * Note: in headless, win.show()/win.focus() are no-op'd by Peek's neutralization
 * layer and a strict guard fails the process if a window becomes visible — so
 * the realistic suspects are LAUNCH itself, the setActivationPolicy calls, dock
 * ops, app-level focus, and QUIT. Window-show steps are included only to confirm
 * they are inert (and to catch the "one crash" you saw — a visible window in
 * headless would trip the guard).
 *
 * SKIPS unless PEEK_FOCUS_PROBE=1. Run cool (single instance), headless:
 *
 *   PEEK_FOCUS_PROBE=1 PEEK_TEST_WORKERS=1 HEADLESS=1 BACKEND=electron \
 *     npx playwright test apps/desktop/tests/desktop/focus-probe.spec.ts \
 *     --config apps/desktop/playwright.config.ts --project=desktop --workers=1
 *
 * STEP 0 (baseline idle) tells us if the LAUNCH itself blipped (it happened
 * just before the test body ran). If you feel a blip during step 0's hold with
 * no operation having run, that's the cold-launch/boot activation.
 */

import { test, expect, DesktopApp } from '../../apps/desktop/tests/fixtures/desktop-app';
import { createPerDescribeApp } from '../../apps/desktop/tests/helpers/test-app';

test.skip(
  process.env.PEEK_FOCUS_PROBE !== '1',
  'opt-in focus decomposition probe — set PEEK_FOCUS_PROBE=1 and run with --workers=1',
);

type Step = { label: string; op: number };

const STEPS: Step[] = [
  { label: 'baseline idle (no op) — did the LAUNCH itself blip?', op: 0 },
  { label: "setActivationPolicy('regular')", op: 1 },
  { label: "setActivationPolicy('accessory')", op: 2 },
  { label: "setActivationPolicy('prohibited')", op: 3 },
  { label: "setActivationPolicy('accessory') restore", op: 4 },
  { label: 'dock.show() then dock.hide()', op: 5 },
  { label: 'app.focus({steal:true})', op: 6 },
  { label: 'create BrowserWindow show:false + setOpacity(0) + showInactive()', op: 7 },
];

test.describe('Focus Probe @desktop', () => {
  let app: DesktopApp;

  test.beforeAll(async () => {
    ({ app } = await createPerDescribeApp('focus-probe'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('step through focus-affecting operations, one per pause', async () => {
    const STEP_HOLD_MS = 7000;
    test.setTimeout((STEPS.length + 3) * (STEP_HOLD_MS + 3000));
    const t0 = Date.now();

    console.log('\n[probe] ============================================================');
    console.log('[probe] Watch your OTHER app. Each step holds 7s. Note when input blips.');
    console.log(`[probe] ${STEPS.length} steps; step k starts ~${'k'}*7s after the first.`);
    console.log('[probe] ============================================================\n');

    for (const step of STEPS) {
      const t = Date.now() - t0;
      console.log(`[probe] STEP ${step.op}  t=${t}ms  ${step.label}  <-- watch now`);

      const res = await app.evaluateMain!(((electron: typeof import('electron'), op: number) => {
        const { BrowserWindow, app: elApp } = electron;
        const a = elApp as unknown as {
          setActivationPolicy?: (p: string) => void;
          focus?: (o?: { steal?: boolean }) => void;
          dock?: { show?: () => Promise<void> | void; hide?: () => void };
        };
        try {
          switch (op) {
            case 0: return { did: 'idle' };
            case 1: a.setActivationPolicy?.('regular'); return { did: 'policy=regular' };
            case 2: a.setActivationPolicy?.('accessory'); return { did: 'policy=accessory' };
            case 3: a.setActivationPolicy?.('prohibited'); return { did: 'policy=prohibited' };
            case 4: a.setActivationPolicy?.('accessory'); return { did: 'policy=accessory' };
            case 5: { try { a.dock?.show?.(); } catch { /* */ } a.dock?.hide?.(); return { did: 'dock cycle' }; }
            case 6: a.focus?.({ steal: true }); return { did: 'app.focus steal' };
            case 7: {
              const w = new BrowserWindow({ show: false });
              try { w.setOpacity(0); } catch { /* */ }
              w.loadURL('about:blank');
              w.showInactive();
              const out = { did: 'win showInactive', id: w.id, visible: w.isVisible() };
              setTimeout(() => { try { if (!w.isDestroyed()) w.close(); } catch { /* */ } }, 4000);
              return out;
            }
            default: return { did: 'noop' };
          }
        } catch (e) {
          return { did: 'ERROR', error: String(e) };
        }
      }) as any, step.op);

      console.log(`[probe]   -> ${JSON.stringify(res)}`);
      await new Promise((r) => setTimeout(r, STEP_HOLD_MS));
    }

    console.log('\n[probe] DONE. Tell me roughly when your input blipped; I have the per-step timestamps.\n');
    expect(true).toBe(true);
  });
});
