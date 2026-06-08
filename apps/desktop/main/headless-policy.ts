/**
 * Headless activation policy — imported FIRST by entry.ts.
 *
 * On macOS test runs (PEEK_HEADLESS=1) a freshly launched Electron instance
 * briefly activates / grabs OS focus before any of our code can set the
 * activation policy. ES modules run ALL imports before the importing module's
 * body, so a setActivationPolicy() call in entry.ts's body is delayed behind
 * ~120 heavy imports (better-sqlite3, feature loaders, …). Putting it in its own
 * module and importing it as the very first statement runs it as early as JS
 * allows — before those side-effectful imports — to shrink the launch-time
 * focus flash as much as possible.
 *
 * Reads process.env directly (not config.ts's isHeadless()) to avoid pulling in
 * any other module before this one runs.
 */
import { app } from 'electron';

/**
 * The macOS activation policy to apply for a given headless-ness, or `null` to
 * leave the app at its default (`'regular'`) policy.
 *
 * INVARIANT (peek tasks 2b55f3af, 8f7010a8): the REAL (non-headless) app must
 * stay a `'regular'`, activatable app — never `'accessory'` (which strands it
 * frontmost-but-not-key, no menubar) and never `'prohibited'` (which can't own
 * the key window at all). So we return `null` (leave default) when not headless.
 * Under headless we suppress the dock + menubar churn with `'accessory'` —
 * NEVER `'prohibited'` (it caused the stuck-focus regression, commit c9e892fa,
 * reverted by 94121bc1).
 *
 * Pure + side-effect-free so the invariant is unit/E2E testable without driving
 * real OS activation (unobservable in a macOS-headless test).
 */
export function headlessActivationPolicy(
  headless: boolean,
): 'regular' | 'accessory' | 'prohibited' | null {
  return headless ? 'accessory' : null;
}

if (process.env.PEEK_HEADLESS && process.platform === 'darwin') {
  try {
    if (app.dock) app.dock.hide();
    const policy = headlessActivationPolicy(true);
    if (policy && app.setActivationPolicy) app.setActivationPolicy(policy);
  } catch {
    /* best effort — never block startup on this */
  }
}
