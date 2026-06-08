import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { createPerDescribeApp } from '../helpers/test-app';

/**
 * Regression guard R7 (hybrid cutover), 2026-06-08 — activation policy.
 *
 * peek tasks 2b55f3af / 8f7010a8: 'prohibited' (and 'accessory' on the REAL app)
 * leave Peek frontmost-but-not-key — windows show but the app doesn't own the
 * macOS menubar, input dead until a cmd-tab cycle. 'accessory' is ONLY ever
 * legitimate for a HEADLESS/test run (to suppress the dock + menubar churn and
 * focus theft); the REAL (non-headless) app must stay a 'regular', activatable
 * app so cmd+tab makes it frontmost + key.
 *
 * Electron 40 has no `getActivationPolicy` getter, so the live OS policy isn't
 * readable. We pin the invariant at its source instead: the pure
 * `headlessActivationPolicy(headless)` decision both call sites
 * (headless-policy.ts + entry.ts) now use. It must return:
 *   - non-headless → null  (leave the app 'regular'/activatable — R7)
 *   - headless     → 'accessory'  (never 'prohibited')
 */
test.describe('Activation policy guard (R7) @desktop', () => {
  let app: DesktopApp;

  test.beforeAll(async () => {
    ({ app } = await createPerDescribeApp('hybrid-activation-policy'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  const bridgePresent = async () =>
    app.evaluateMain!(() => Boolean((globalThis as any).__peekHybridOverlayTest));

  test('non-headless leaves default (regular); never accessory/prohibited', async () => {
    test.skip(!(await bridgePresent()), 'hybrid flag off — no overlay bridge');

    const { real, headless } = await app.evaluateMain!(() => {
      const b = (globalThis as any).__peekHybridOverlayTest;
      return {
        real: b.headlessActivationPolicy(false), // the REAL (non-headless) app
        headless: b.headlessActivationPolicy(true), // an agent/CI run
      };
    });

    // The REAL app: leave the default 'regular' policy — never accessory/prohibited.
    expect(real).toBeNull();

    // Headless: 'accessory' (dock-less, no menubar churn) — but NEVER 'prohibited'
    // (it can't own the key window → strands the user's foreground app).
    expect(headless).toBe('accessory');
    expect(headless).not.toBe('prohibited');
  });
});
