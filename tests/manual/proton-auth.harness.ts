/**
 * Manual harness scenario: Proton Pass auth flow.
 *
 * Run via:
 *   yarn harness tests/manual/proton-auth.harness.ts
 *
 * Modes (selected via HARNESS_MODE env var):
 *   HARNESS_MODE=interactive (default)
 *     - Opens the Proton Pass popup, attaches the tracer, then sleeps for
 *       HARNESS_DURATION_MS (default 180000 = 3min). You drive the UI by
 *       hand; the tracer captures network + console + chrome.runtime + nav
 *       events across ALL webContents (popup, auth window host, embedded
 *       webview, BG SW). On exit, the trace is dumped to tmp/harness/.
 *
 *   HARNESS_MODE=autodrive
 *     - Reads .env.proton.local, attempts to fill username/password/TOTP.
 *       Selectors are not yet pinned (the Proton DOM is opaque until we
 *       see it via interactive mode); this branch records what it finds
 *       and bails gracefully. Treat it as a placeholder for a future
 *       iteration once the interactive trace has shown the right selectors.
 *
 * Either way, the goal is the JSON trace at tmp/harness/proton-auth-*.json.
 *
 * The harness does NOT assert success on its own. The spec passes if the
 * trace was produced; the actual diagnosis is a human reading the trace.
 */

import { test, expect } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { startTracer } from './harness/tracer';
import { discoverPopup } from './harness/popup';
import { loadEnv, assertRequiredEnv } from './harness/env';
import { getInstrumentationSource } from './harness/instrument';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.join(__dirname, '..', '..');
const MODE = (process.env.HARNESS_MODE || 'interactive').toLowerCase();
const DURATION_MS = parseInt(process.env.HARNESS_DURATION_MS || '180000', 10);

test.describe('proton-auth harness @manual', () => {
  test.setTimeout(DURATION_MS + 90_000);

  test('drive Proton Pass auth flow while tracer records', async ({ desktopApp }) => {
    const bgWindow = await desktopApp.getBackgroundWindow();

    const envResult = loadEnv('.env.proton.local', REPO_ROOT);
    if (MODE === 'autodrive') {
      assertRequiredEnv(envResult.env, ['PROTON_TEST_USER', 'PROTON_TEST_PASS'], 'proton-auth');
    }

    const tracer = await startTracer({
      app: desktopApp,
      scenarioName: 'proton-auth',
      tmpDir: path.join(REPO_ROOT, 'tmp', 'harness'),
      profile: 'test-harness-proton-auth',
      backend: desktopApp.backend,
      redactedEnvKeys: envResult.loadedKeys,
    });

    tracer.attachToPage(bgWindow, 'bg');
    tracer.record('note', 'harness', { msg: 'starting proton-auth scenario', mode: MODE, envSource: envResult.source });

    // Install page-side instrumentation on every http(s) webContents — wraps
    // chrome.runtime in a logging Proxy, captures window.error /
    // unhandledrejection, and shadows console.error/warn. All output flows
    // through console.log with the "[peek-instrument]" prefix and is captured
    // by the tracer's CDP Console domain. This surfaces signals that Proton
    // (Sentry, defensive try/catch around feature detection) would otherwise
    // swallow.
    // Inject instrumentation via `executeJavaScript` on every dom-ready of
    // any http(s) webContents. This runs AFTER the page's initial scripts,
    // so it can't beat synchronous chrome.runtime accesses at component
    // mount — but `chrome.runtime` accesses *after* install (which is most
    // of them, including the ongoing flow's API calls and re-mounts) are
    // captured. We deliberately do NOT use CDP `Page.addScriptToEvaluateOnNewDocument`
    // here: in this codebase, doing so on top of the tracer's already-attached
    // debugger session silently disrupted CDP message delivery, dropping the
    // entire CDP event stream. dom-ready exec is robust and gets us the
    // logs we need.
    await desktopApp.evaluateMain!(async ({ app }, args) => {
      app.on('web-contents-created', (_e: any, wc: any) => {
        wc.on('dom-ready', () => {
          if (wc.isDestroyed()) return;
          const url = wc.getURL();
          if (!url.startsWith('http://') && !url.startsWith('https://')) return;
          wc.executeJavaScript(args.source).then(
            () => console.log(`[harness:instrument] exec install ok wc=${wc.id} url=${url.slice(0, 80)}`),
            (e: any) => console.log(`[harness:instrument] exec install FAILED wc=${wc.id} err=${e?.message ?? e}`),
          );
        });
      });
    }, { source: getInstrumentationSource() });

    let result: { ok: boolean; reason?: string };
    try {
      const { popup, entry } = await discoverPopup(desktopApp, bgWindow, 'proton', {
        width: 400, height: 600, key: 'harness-proton-popup',
      });
      tracer.attachToPage(popup, 'popup');
      tracer.record('note', 'harness', { msg: 'popup discovered', extensionId: entry.extensionId, url: entry.url });

      await popup.waitForLoadState('domcontentloaded');
      await tracer.snapshotRuntime(popup, 'popup');

      // Watch for any new top-level window the popup opens (auth window).
      // The Proton flow opens a peek://app/page/... host window that contains
      // the proton.me webview.
      let authWindow: Page | null = null;
      const tryFindAuth = async () => {
        for (const w of desktopApp.windows()) {
          const u = w.url();
          if (u.includes('page/index.html') || u.includes('account.proton.me')) {
            return w;
          }
        }
        return null;
      };

      if (MODE === 'autodrive') {
        // Placeholder: future iteration fills in real selectors once the
        // interactive-mode trace has shown them. For now, just wait and watch.
        tracer.record('note', 'harness', { msg: 'autodrive mode not yet implemented; falling through to interactive wait' });
      }

      // Stop conditions (whichever fires first):
      //   1. tmp/harness-stop sentinel file appears (user signal, set via
      //      `yarn harness:stop` from another terminal)
      //   2. The auth window was opened, then closed by the user (natural
      //      "I'm done with this flow" signal)
      //   3. DURATION_MS elapses (hard ceiling)
      //
      // Cmd+Q on the Peek instance ALSO works: closing all top-level windows
      // satisfies (2) once auth-host has been seen and is now gone.
      const stopFile = path.join(REPO_ROOT, 'tmp', 'harness-stop');
      // Pre-clean the sentinel so a stale one from a prior run doesn't trigger.
      try { if (fs.existsSync(stopFile)) fs.unlinkSync(stopFile); } catch {}
      const deadline = Date.now() + DURATION_MS;
      let lastUrlSeen = '';
      let stopReason: string | null = null;
      while (Date.now() < deadline && !stopReason) {
        if (fs.existsSync(stopFile)) {
          try { fs.unlinkSync(stopFile); } catch {}
          stopReason = 'sentinel file';
          break;
        }
        if (!authWindow) {
          authWindow = await tryFindAuth();
          if (authWindow) {
            tracer.attachToPage(authWindow, 'auth-host');
            tracer.record('note', 'harness', { msg: 'auth window opened', url: authWindow.url() });
            // Snapshot runtime in the host page first.
            await tracer.snapshotRuntime(authWindow, 'auth-host').catch((e) => {
              tracer.record('note', 'harness', { msg: 'auth-host runtime snapshot failed', error: String(e) });
            });
            // And in the embedded webview if present.
            await tracer.snapshotRuntime(authWindow, 'auth-host:webview', { fromWebview: '#content' }).catch(() => {
              // fine — webview not yet attached or not present
            });
          }
        } else {
          if (authWindow.isClosed()) {
            stopReason = 'auth window closed';
            break;
          }
          const u = authWindow.url();
          if (u !== lastUrlSeen) {
            lastUrlSeen = u;
            tracer.record('note', 'harness', { msg: 'auth host url changed', url: u });
            // Re-snapshot runtime on each top-level nav of the host.
            await tracer.snapshotRuntime(authWindow, `auth-host@${shortPath(u)}`).catch(() => {});
            await tracer.snapshotRuntime(authWindow, `auth-host:webview@${shortPath(u)}`, { fromWebview: '#content' }).catch(() => {});
          }
        }
        await sleep(1000);
      }

      result = { ok: true, reason: stopReason ?? 'duration elapsed' };
      tracer.record('note', 'harness', { msg: 'scenario stop', reason: result.reason });
    } catch (e: any) {
      tracer.record('note', 'harness', { msg: 'scenario error', error: String(e?.message || e), stack: e?.stack });
      result = { ok: false, reason: String(e?.message || e) };
    }

    const { jsonPath, logPath } = await tracer.dump(result);
    console.log(`[harness] trace JSON: ${jsonPath}`);
    console.log(`[harness] trace log:  ${logPath}`);

    // The spec passes if the trace was produced. Diagnosis is human-driven.
    expect(jsonPath).toBeTruthy();
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function shortPath(url: string): string {
  try { return new URL(url).pathname || '/'; } catch { return url.slice(0, 40); }
}
