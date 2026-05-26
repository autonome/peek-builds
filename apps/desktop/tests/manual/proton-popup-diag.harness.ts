/**
 * Manual harness: diagnose Proton Pass popup black-screen.
 *
 * Launches Peek, opens the Proton Pass popup, captures ALL console output +
 * page errors + failed network requests, then dumps a summary to stdout.
 *
 * Run via:  yarn harness apps/desktop/tests/manual/proton-popup-diag.harness.ts
 */

import { test } from '../fixtures/desktop-app';
import { discoverPopup } from './harness/popup';

test.describe('proton-popup-diag @manual', () => {
  test.setTimeout(60_000);

  test('open popup and capture diagnostics', async ({ desktopApp }) => {
    const bg = await desktopApp.getBackgroundWindow();

    // Locate main.log in the test profile's userData dir; tail it after the
    // popup boots so [chrome-ext], [ext:...], [peek:...] lines surface here.
    const userDataPath = await desktopApp.evaluateMain!(async (electronMod) => {
      return electronMod.app.getPath('userData');
    });
    console.log(`[diag] userDataPath=${userDataPath}`);

    // Attach listeners BEFORE opening so we don't miss boot-time errors.
    const events: Array<{ kind: string; text: string }> = [];

    const { popup, entry } = await discoverPopup(desktopApp, bg, 'proton', {
      width: 600,
      height: 430,
      timeout: 20_000,
    });
    console.log(`[diag] popup opened url=${entry.url}`);

    popup.on('console', (msg) => {
      events.push({ kind: `console:${msg.type()}`, text: msg.text() });
    });
    popup.on('pageerror', (err) => {
      events.push({ kind: 'pageerror', text: `${err.name}: ${err.message}\n${err.stack || ''}` });
    });
    popup.on('requestfailed', (req) => {
      events.push({ kind: 'requestfailed', text: `${req.method()} ${req.url()} :: ${req.failure()?.errorText || 'unknown'}` });
    });

    // Give the popup time to attempt loading scripts + render.
    await popup.waitForTimeout(8000);

    // Dump the DOM state too — black screen often means root mount never happened.
    const domState = await popup.evaluate(() => {
      const root = document.querySelector('.app-root');
      return {
        readyState: document.readyState,
        bodyChildCount: document.body ? document.body.childElementCount : 0,
        appRootExists: !!root,
        appRootChildCount: root ? root.childElementCount : -1,
        appRootHTML: root ? (root as HTMLElement).innerHTML.slice(0, 500) : '(missing)',
        scriptsLoaded: Array.from(document.querySelectorAll('script')).map((s) => ({
          src: (s as HTMLScriptElement).src || '(inline)',
        })),
      };
    });

    console.log('[diag] DOM snapshot:', JSON.stringify(domState, null, 2));
    console.log(`[diag] captured ${events.length} events:`);
    for (const ev of events) {
      console.log(`  [${ev.kind}] ${ev.text}`);
    }

    // Read main.log from the profile dir and surface ext-related lines.
    try {
      const logPath = `${userDataPath}/logs/main.log`;
      const raw = (await import('fs')).readFileSync(logPath, 'utf8');
      const lines = raw.split('\n').filter((l) =>
        l.includes('[chrome-ext]') ||
        l.includes('[ext:') ||
        l.includes('[ext-popup') ||
        l.includes('[bridge:') ||
        l.includes('[peek:popup') ||
        l.includes('[peek:permissions') ||
        l.includes('[peek:runtime-external')
      );
      console.log(`[diag] main.log relevant lines (${lines.length}):`);
      for (const line of lines) console.log(`  ${line}`);
    } catch (err) {
      console.log(`[diag] main.log read failed: ${(err as Error).message}`);
    }
  });
});
