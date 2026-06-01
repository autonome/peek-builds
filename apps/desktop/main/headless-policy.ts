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

if (process.env.PEEK_HEADLESS && process.platform === 'darwin') {
  try {
    if (app.dock) app.dock.hide();
    // 'prohibited': the app can never become the active application — strongest
    // mitigation for the launch-time focus grab (accessory still allowed it).
    if (app.setActivationPolicy) app.setActivationPolicy('prohibited');
  } catch {
    /* best effort — never block startup on this */
  }
}
