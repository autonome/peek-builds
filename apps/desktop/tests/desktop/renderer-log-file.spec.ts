/**
 * Renderer log file — integration smoke test
 *
 * Verifies that console.{log,warn,error} calls from any renderer window
 * land in <userData>/logs/renderer.log, as implemented by:
 *   - The console wrapper in apps/desktop/main/tile-preload.cts
 *   - The IPC handler and file writer in apps/desktop/main/renderer-log.ts
 *
 * Two scenarios are tested:
 *
 *   1. Normal run (DevTools closed) — baseline, the preload wrapper should
 *      forward every console call regardless of DevTools state.
 *
 *   2. DevTools open — the critical regression case. When DevTools is
 *      attached to a window, Chromium suppresses the `webContents.on(
 *      'console-message')` event. The preload wrapper routes via
 *      ipcRenderer.send which is unaffected by DevTools attachment, so
 *      messages must still appear in the file.
 *
 * Determinism: file appearance is detected via fs.watch on the log
 * directory, and DevTools attach via the `devtools-opened` webContents event.
 * No setTimeout-as-wait anywhere (per feedback_no_sleep_in_tests_or_code.md).
 *
 * Run with:
 *   yarn test:grep "renderer log file"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import fs from 'fs';
import path from 'path';

test.describe('renderer log file @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let logFilePath: string;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('renderer-log-smoke'));

    // Resolve the log file path from the Electron main process.
    // `app.getPath('userData')` returns the per-profile directory after
    // entry.ts calls `app.setPath('userData', profileDataPath)`.
    //
    // The evaluateMain callback receives the electron module as its first
    // argument. We name it `_el` and access `_el.app` to avoid any runtime
    // name-shadow with the test-level `app` variable.
    const userData = await app.evaluateMain!(((_el: any) => _el.app.getPath('userData')) as any);
    logFilePath = path.join(userData, 'logs', 'renderer.log');
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Wait for `marker` to appear in the log file. Uses fs.watch on the parent
   * directory so the check runs only when the file actually changes — no
   * wall-clock setTimeout polling. The watcher is attached BEFORE the initial
   * read to close the race where the write lands between read and watch.
   * Throws if the timeout is exceeded.
   */
  function waitForMarkerInLog(marker: string, timeoutMs = 10000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let watcher: fs.FSWatcher | undefined;
      let settled = false;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        watcher?.close();
        clearTimeout(timer);
      };

      const check = (): void => {
        if (settled) return;
        try {
          const content = fs.readFileSync(logFilePath, 'utf8');
          if (content.includes(marker)) {
            cleanup();
            resolve();
          }
        } catch {
          // File may not exist yet — wait for the next watcher event.
        }
      };

      // Watch the directory (file itself may not exist yet).
      try {
        const dir = path.dirname(logFilePath);
        const fileName = path.basename(logFilePath);
        watcher = fs.watch(dir, (_eventType, name) => {
          if (name === fileName) check();
        });
      } catch {
        // If watch attach fails the timeout still fires below.
      }

      const timer = setTimeout(() => {
        if (settled) return;
        cleanup();
        let snippet = '';
        try { snippet = fs.readFileSync(logFilePath, 'utf8').slice(-500); } catch { /* ok */ }
        reject(new Error(
          `Timed out waiting for marker "${marker}" in renderer.log after ${timeoutMs}ms.\n` +
          `Last 500 bytes of log:\n${snippet}`
        ));
      }, timeoutMs);

      // Check once after the watcher is in place (in case marker is already present).
      check();
    });
  }

  // ── Tests ─────────────────────────────────────────────────────────────────

  test('console.log from bgWindow reaches renderer.log', async () => {
    const marker = `test-marker-${Date.now()}`;

    // Emit a console.log inside the test fixture renderer (which is loaded
    // with tile-preload so the console wrapper is in effect).
    await bgWindow.evaluate((m: string) => {
      console.log(m);
    }, marker);

    // Wait until the marker appears in the file.
    await waitForMarkerInLog(marker);

    // Read the file and assert structure beyond just the marker.
    const content = fs.readFileSync(logFilePath, 'utf8');
    const line = content.split('\n').find(l => l.includes(marker));
    expect(line).toBeDefined();

    // Line format: <ISO> [log] <source> <message>
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z \[log\]/);
    expect(line).toContain('[log]');
    expect(line).toContain(marker);
  });

  test('console.warn and console.error reach renderer.log with correct level', async () => {
    const warnMarker = `test-warn-${Date.now()}`;
    const errorMarker = `test-error-${Date.now()}`;

    await bgWindow.evaluate((markers: { warn: string; error: string }) => {
      console.warn(markers.warn);
      console.error(markers.error);
    }, { warn: warnMarker, error: errorMarker });

    await waitForMarkerInLog(warnMarker);
    await waitForMarkerInLog(errorMarker);

    const content = fs.readFileSync(logFilePath, 'utf8');

    const warnLine = content.split('\n').find(l => l.includes(warnMarker));
    const errorLine = content.split('\n').find(l => l.includes(errorMarker));

    expect(warnLine).toBeDefined();
    expect(warnLine).toContain('[warn]');

    expect(errorLine).toBeDefined();
    expect(errorLine).toContain('[error]');
  });

  test('renderer.log is present and non-empty after app start', async () => {
    // By the time we get here the test fixture renderer itself emits
    // console output during init. The file must already exist and have content.
    //
    // Note: The file may not exist yet if no console output has been emitted
    // from any renderer before the first explicit console.log test runs.
    // The previous two tests inject console calls that should have populated
    // the file. We verify here that the path resolves correctly.
    const logsDir = path.dirname(logFilePath);
    const logsDirExists = fs.existsSync(logsDir);

    // The logs directory must exist — initRendererLog creates it synchronously.
    expect(logsDirExists).toBe(true);

    // The file itself should exist by now (previous tests wrote to it).
    expect(fs.existsSync(logFilePath)).toBe(true);

    const stat = fs.statSync(logFilePath);
    expect(stat.size).toBeGreaterThan(0);
  });

  test('DevTools open — console.log still reaches renderer.log', async () => {
    // This test opens a REAL (detached) DevTools window. macOS has no virtual
    // display, so that window surfaces on the user's physical desktop — and the
    // central headless neutralization in entry.ts deliberately no-ops
    // openDevTools, which makes the isDevToolsOpened() assertion below
    // impossible under headless. Skip on macOS-headless; Linux/Xvfb runs it
    // against an invisible display where opening DevTools is harmless.
    test.skip(
      process.env.HEADLESS === '1' && process.platform === 'darwin',
      'DevTools opens a real window that surfaces on the macOS desktop; covered on Linux/Xvfb',
    );
    // Open DevTools on the test fixture renderer to replicate the
    // DEBUG=1 scenario where Chromium suppresses console-message events.
    // The preload wrapper routes via ipcRenderer.send which is independent
    // of DevTools attach state, so the log file must still receive messages.
    //
    // Note: entry.ts guards openDevTools behind !isTestProfile(), but we can
    // call it directly from main-process evaluate without that guard.
    //
    // Wait for the `devtools-opened` webContents event so the attach is
    // confirmed event-driven rather than via setTimeout polling.
    const devtoolsAttached = await app.evaluateMain!(((_el: any) =>
      new Promise<boolean>((resolve, reject) => {
        const { BrowserWindow } = _el;
        const wins = BrowserWindow.getAllWindows();
        for (const w of wins) {
          const url = w.webContents.getURL();
          if (!url.includes('peek://test/')) continue;
          if (w.webContents.isDevToolsOpened()) {
            resolve(true);
            return;
          }
          const timer = setTimeout(
            () => reject(new Error('devtools-opened did not fire within 5000ms')),
            5000,
          );
          w.webContents.once('devtools-opened', () => {
            clearTimeout(timer);
            resolve(true);
          });
          w.webContents.openDevTools({ mode: 'detach', activate: false });
          return;
        }
        resolve(false);
      })) as any);
    expect(devtoolsAttached).toBe(true);

    const marker = `test-devtools-${Date.now()}`;

    await bgWindow.evaluate((m: string) => {
      console.log(m);
    }, marker);

    // If the preload wrapper is the load-bearing layer, this succeeds even
    // with DevTools attached. If we were relying on console-message events,
    // this would time out.
    await waitForMarkerInLog(marker);

    const content = fs.readFileSync(logFilePath, 'utf8');
    const line = content.split('\n').find(l => l.includes(marker));
    expect(line).toBeDefined();
    expect(line).toContain('[log]');
  });
});
