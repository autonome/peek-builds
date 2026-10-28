/**
 * Desktop App Fixture
 *
 * Provides a unified interface for launching and interacting with
 * desktop backends (Electron, Tauri) in Playwright tests.
 *
 * Usage:
 *   import { test, expect } from '../fixtures/desktop-app';
 *
 *   test('feature works', async ({ desktopApp }) => {
 *     const bg = await desktopApp.getBackgroundWindow();
 *     const result = await bg.evaluate(() => window.app.datastore.getStats());
 *     expect(result.success).toBe(true);
 *   });
 *
 * Environment:
 *   BACKEND=electron|tauri  - Select backend (default: electron)
 *   PROFILE=string          - Data isolation profile
 *   HEADLESS=1              - Run without visible windows
 *   DEBUG=1                 - Enable debug logging
 */

import { test as base, _electron as electron, ElectronApplication, Page, chromium, Browser, BrowserContext } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import { fileURLToPath } from 'url';
import { waitForWindow as waitForWindowHelper, sleep, getTestProfile, waitForAppReady, waitForStartupWindowOpened } from '../helpers/window-utils';
import { accessoryElectronBinaryPath } from '../helpers/accessory-electron';
import { consentRecordPath, createAcceptanceRecord } from '../../main/startup-consent';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// REPO_ROOT: 4 levels up from apps/desktop/tests/fixtures/ → monorepo root.
// Used for baseArgs (electron source launch) and packaged executable path —
// both are relative to the repo root, not to apps/desktop/.
const REPO_ROOT = path.join(__dirname, '../../../..');
// ROOT: apps/desktop/ subtree — renderer, features, and other desktop assets live here.
const ROOT = path.join(__dirname, '../..');

export type Backend = 'electron' | 'tauri';

export interface DesktopApp {
  /** Which backend is running */
  backend: Backend;

  /** Get all windows/pages */
  windows(): Page[];

  /** Wait for a window matching URL pattern */
  getWindow(urlPattern: string | RegExp, timeout?: number): Promise<Page>;

  /** Get the main background window */
  getBackgroundWindow(): Promise<Page>;

  /** Get extension background windows */
  getExtensionWindows(): Page[];

  /**
   * Evaluate code in the main (Node) process (Electron only).
   * First arg of `fn` is the electron module itself — destructure to grab
   * `BrowserWindow`, `screen`, `app`, etc.
   */
  evaluateMain?<R, A = void>(
    fn: (electron: typeof import('electron'), arg: A) => R,
    arg?: A,
  ): Promise<R>;

  /** Close the app */
  close(): Promise<void>;
}

// Internal state for Electron
interface ElectronState {
  app: ElectronApplication;
  tempDir: string | null;  // Temp directory for test data (cleaned up on close)
  profile: string;         // Profile name for cleanup tracking
}

/**
 * Global map of profile → tempDir
 * Allows reusing the same temp directory when relaunching with the same profile
 * (needed for persistence tests that restart the app)
 */
const profileTempDirs = new Map<string, string>();

/**
 * Get or create a temp directory for a profile
 * Reuses existing temp dir if same profile is launched again (for restart tests)
 */
function getOrCreateTempDir(profile: string): string {
  // Reuse existing temp dir for same profile (enables persistence tests)
  if (profileTempDirs.has(profile)) {
    return profileTempDirs.get(profile)!;
  }

  const tempBase = os.tmpdir();
  // `test-harness-*` profiles are intended for repeat manual runs (e.g. the
  // Proton auth harness in tests/manual/). Use a stable path so cookies,
  // localStorage, and 2FA-trusted-device state persist across `yarn harness`
  // invocations — otherwise the user re-logs every run.
  const stable = profile.startsWith('test-harness-');
  const tempDir = stable
    ? path.join(tempBase, `peek-test-${profile}`)
    : path.join(tempBase, `peek-test-${profile}-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  profileTempDirs.set(profile, tempDir);
  return tempDir;
}

/**
 * Recursively delete a directory
 */
function removeTempDir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[test] Failed to clean up temp directory: ${dirPath}`, err);
  }
}

/**
 * Clean up a profile's temp directory
 * Removes from the tracking map and deletes the directory
 */
function cleanupProfile(profile: string): void {
  const tempDir = profileTempDirs.get(profile);
  if (tempDir) {
    profileTempDirs.delete(profile);
    removeTempDir(tempDir);
  }
}

/**
 * Clean up all remaining temp directories
 * Called on process exit to ensure no leftovers
 *
 * Skips `test-harness-*` profiles — those are intentionally persistent so
 * the user doesn't have to re-log in / re-trust the device on every run.
 */
function cleanupAllTempDirs(): void {
  for (const [profile, tempDir] of profileTempDirs.entries()) {
    if (profile.startsWith('test-harness-')) continue;
    removeTempDir(tempDir);
  }
  profileTempDirs.clear();
}

// Register cleanup on process exit
process.on('exit', cleanupAllTempDirs);
process.on('SIGINT', () => { cleanupAllTempDirs(); process.exit(0); });
process.on('SIGTERM', () => { cleanupAllTempDirs(); process.exit(0); });

/**
 * Check if running in headless mode
 * Uses HEADLESS env var (unified across backends)
 */
function isHeadless(): boolean {
  const val = process.env.HEADLESS;
  return val === '1' || val === 'true';
}

/**
 * Options for launching desktop app
 */
export interface LaunchOptions {
  /** Legacy: force all extensions to separate windows (for testing) */
  legacyMode?: boolean;
  /**
   * Launch with PEEK_HEADLESS=1 regardless of the HEADLESS env var. For specs
   * that assert the headless path itself: `scripts/playwright-with-display.sh`
   * unsets HEADLESS on Linux, so without this they would assert a mode the app
   * is not in there.
   */
  headless?: boolean;
  /**
   * Extra environment for the launched app only, applied over the runner's own
   * environment. Main passes its environment on to the processes it starts (the
   * page-translation engine reads `PEEK_TRANSLATE_ENGINE` there), so this reaches
   * them too. Set here rather than on `process.env` so one spec's settings never
   * leak into the next app launched by the same worker.
   */
  env?: Record<string, string>;
  /**
   * Seed a valid startup risk acknowledgment in this launch's isolated
   * user-data root (default true). Only the startup notice spec opts out.
   */
  seedAcknowledgment?: boolean;
}

/**
 * Check if running packaged build
 * Uses PACKAGED env var
 */
function isPackaged(): boolean {
  const val = process.env.PACKAGED;
  return val === '1' || val === 'true';
}

/**
 * Candidate `--dir` output paths for the packaged executable, most likely first.
 *
 * electron-builder names its unpacked output directory after the platform and
 * appends the arch ONLY when the arch is not x64 — an x64 Linux build lands at
 * `out/linux-unpacked`, an arm64 one at `out/linux-arm64-unpacked`. Both spellings
 * are offered because the rule is electron-builder's, not ours, and a wrong guess
 * here surfaces as "executable does not exist" long after the build succeeded.
 */
function packagedExecutableRelPaths(): string[] {
  const arch = process.arch;
  const suffixes = arch === 'x64' ? ['', `-${arch}`] : [`-${arch}`, ''];
  switch (process.platform) {
    case 'darwin':
      return suffixes.map((s) => `out/mac${s}/Peek.app/Contents/MacOS/Peek`);
    case 'linux':
      return suffixes.map((s) => `out/linux${s}-unpacked/peek`);
    case 'win32':
      return suffixes.map((s) => `out/win${s}-unpacked/Peek.exe`);
    default:
      throw new Error(`Unsupported platform for packaged Electron: ${process.platform}`);
  }
}

function packagedExecutablePath(): string {
  const candidates = packagedExecutableRelPaths();
  for (const rel of candidates) {
    const abs = path.join(REPO_ROOT, rel);
    if (fs.existsSync(abs)) return abs;
  }
  throw new Error(
    `PACKAGED=1 but no packaged executable found. Looked for:\n` +
      candidates.map((rel) => `  ${path.join(REPO_ROOT, rel)}`).join('\n') +
      `\nRun \`electron-builder --dir\` from the repo root first.`
  );
}

/**
 * Launch Electron backend
 *
 * Default is hybrid mode:
 * - Built-in extensions (cmd, groups, peeks, slides) → consolidated (iframes)
 * - External extensions (example, user-installed) → separate windows
 *
 * Supports packaged builds via PACKAGED=1 env var.
 *
 * Test data is stored in OS temp directory and cleaned up when test closes.
 */
/**
 * Write a valid startup risk acknowledgment record into an isolated user-data
 * root so specs that are not testing the notice start the normal runtime.
 * Refuses any directory outside the OS temp directory, so a developer's real
 * record can never be written from here.
 */
export function seedStartupAcknowledgment(userDataRoot: string): void {
  const resolved = path.resolve(userDataRoot);
  const tmpRoot = path.resolve(os.tmpdir()) + path.sep;
  if (!resolved.startsWith(tmpRoot)) {
    throw new Error(`Refusing to seed a startup acknowledgment outside the temp directory: ${resolved}`);
  }
  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(
    consentRecordPath(resolved),
    `${JSON.stringify(createAcceptanceRecord('test-fixture'))}\n`,
    { mode: 0o600 },
  );
}

/** Temp user-data root of a profile's launches (created on first use). */
export function tempUserDataRoot(profile: string): string {
  return getOrCreateTempDir(profile);
}

/**
 * Launch the app WITHOUT seeding an acknowledgment and WITHOUT waiting for the
 * runtime. For specs that test the startup notice itself. Returns the raw
 * application so the spec can inspect windows and processes.
 */
export async function launchStartupGate(
  profile: string,
  options: { env?: Record<string, string>; extraArgs?: string[]; userDataRoot?: string } = {},
): Promise<{ app: ElectronApplication; userDataRoot: string }> {
  const userDataRoot = options.userDataRoot ?? getOrCreateTempDir(profile);
  const packaged = isPackaged();
  const linuxArgs = process.platform === 'linux' ? ['--ozone-platform=x11', '--no-sandbox'] : [];
  const args = [
    ...(packaged ? [] : [REPO_ROOT]),
    ...linuxArgs,
    `--user-data-dir=${userDataRoot}`,
    ...(options.extraArgs ?? []),
  ];
  const app = await electron.launch({
    ...(packaged ? { executablePath: packagedExecutablePath() } : {}),
    args,
    env: {
      ...process.env,
      PROFILE: profile,
      DEBUG: process.env.DEBUG || '1',
      E2E_TEST: 'true',
      // A headless run keeps the notice window hidden instead of on screen.
      ...(isHeadless() ? { PEEK_HEADLESS: '1' } : {}),
      ...(options.env ?? {}),
    } as Record<string, string>,
  });
  return { app, userDataRoot };
}

async function launchElectron(profile: string, options: LaunchOptions = {}): Promise<DesktopApp> {
  // Translate unified HEADLESS to Electron's PEEK_HEADLESS
  const headless = options.headless ?? isHeadless();
  const packaged = isPackaged();

  // Get or create temp directory for test data
  // Reuses same dir if same profile is relaunched (for persistence tests)
  const tempDir = getOrCreateTempDir(profile);
  // Specs that are not testing the notice start with a valid record in their
  // isolated root only. Existing records (a spec that wrote its own) are kept.
  if (options.seedAcknowledgment !== false && !fs.existsSync(consentRecordPath(tempDir))) {
    seedStartupAcknowledgment(tempDir);
  }

  // For packaged builds, use the executable path
  // For source builds, pass the project root as the first arg
  // Also add --user-data-dir to redirect data to temp directory
  const baseArgs = packaged
    ? []
    : [REPO_ROOT];

  // Force XWayland on Linux. Electron 38+ picks Wayland whenever
  // WAYLAND_DISPLAY is set (Ozone auto-detect) and the window escapes
  // xvfb-run's DISPLAY redirect onto the real compositor.
  //
  // --no-sandbox is TEST-ONLY and Linux-only. electron-builder ships
  // `chrome-sandbox` without the setuid bit, so Chromium's SUID sandbox helper
  // aborts the process before any JS runs — Playwright reports only
  // "Process failed to launch!". Fixing it in place needs root AND has to be
  // redone after every `electron-builder --dir`, since that wipes the output
  // directory. Nothing in this suite measures sandbox behavior, and the
  // sign-off gate runs on macOS where the sandbox stays on.
  const linuxOzoneArgs =
    process.platform === 'linux' ? ['--ozone-platform=x11', '--no-sandbox'] : [];

  // TEST-ONLY macOS launch-flash fix (unpackaged path): when the globalSetup
  // (tests/global-setup-electron-accessory.ts) has built a patched
  // LSUIElement=true copy of Electron, launch THAT so the process never grabs
  // focus at launch. Same guard as the globalSetup — darwin && headless &&
  // !packaged — plus fs.existsSync so a missing/skipped copy falls back to
  // today's behavior. args are unchanged (app dir still comes from args[0]).
  const useAccessoryElectron =
    process.platform === 'darwin' &&
    headless &&
    !packaged &&
    fs.existsSync(accessoryElectronBinaryPath());

  const launchConfig = packaged
    ? {
        executablePath: packagedExecutablePath(),
        args: [...linuxOzoneArgs, `--user-data-dir=${tempDir}`]
      }
    : {
        ...(useAccessoryElectron ? { executablePath: accessoryElectronBinaryPath() } : {}),
        args: [...baseArgs, ...linuxOzoneArgs, `--user-data-dir=${tempDir}`]
      };

  const electronApp = await electron.launch({
    ...launchConfig,
    env: {
      ...process.env,
      PROFILE: profile,
      DEBUG: process.env.DEBUG || '1',
      // E2E_TEST triggers the privileged test-fixture renderer in
      // `apps/desktop/main/test-fixture-glue.ts`. Always set it for
      // Playwright-driven Electron launches — the fixture is cheap when
      // unused and required for the v2 bgWindow path.
      E2E_TEST: 'true',
      // Electron uses PEEK_HEADLESS for headless mode
      ...(headless ? { PEEK_HEADLESS: '1' } : {}),
      ...(options.env ?? {})
    }
  });

  // Forward main-process `[wm]` window-diagnostics lines to the test
  // runner's own stdout, tagged with the launching test's worker index +
  // title, so parallel workers' output can be attributed to the test that
  // produced it. `_electron.launch` pipes the child's stdio rather than
  // inheriting it, so window-diag.ts's console.log lines otherwise never
  // reach the terminal or the gate log. Only `[wm]`-prefixed lines are
  // forwarded — wmLog is deliberately always-on (not env-gated) and the
  // desktop project alone runs 380+ specs, so mirroring all child stdout
  // would bloat the gate log without adding signal.
  //
  // Read via `base.info()` rather than threaded through `options` — most
  // specs launch through `createPerDescribeApp`/`getSharedApp` (a `beforeAll`
  // or module-level call, not the `desktopApp` fixture), so a tag has to
  // work from any call site. Taken once at attach time: a shared app spans
  // multiple tests, so the tag names whichever test/hook triggered THIS
  // launch, not necessarily every test later using the same app instance.
  let wmTag: string | null = null;
  try {
    const info = base.info();
    wmTag = `w${info.workerIndex} ${info.title}`;
  } catch {
    // Not inside a running test (e.g. a script launching Electron directly)
    // — nothing to tag lines with, so skip forwarding.
  }
  if (wmTag) {
    const tag = wmTag;
    // Chunk boundaries can split a line mid-way; buffer partial lines until
    // a newline completes them rather than emitting fragments.
    const forwardWmLines = (state: { partial: string }) => (chunk: Buffer | string) => {
      state.partial += chunk.toString();
      const lines = state.partial.split('\n');
      state.partial = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.includes('[wm]')) continue;
        try {
          process.stdout.write(`[${tag}] ${line}\n`);
        } catch { /* runner stdout gone mid-teardown — drop the line */ }
      }
    };
    try {
      const child = electronApp.process();
      // Tolerate the stream dying mid-teardown (close() has a SIGTERM/
      // SIGKILL path) rather than throwing on an unhandled stream error.
      child.stdout?.on('data', forwardWmLines({ partial: '' }));
      child.stdout?.on('error', () => {});
      child.stderr?.on('data', forwardWmLines({ partial: '' }));
      child.stderr?.on('error', () => {});
    } catch { /* process/stdio unavailable — nothing to forward */ }
  }

  // Wait for background window to be ready (API loaded).
  //
  // The privileged test-fixture renderer (peek://test/index.html) is the
  // v2 replacement for the v1 bgWindow iframe. It uses tile-preload.cjs
  // with a `createTrustedBuiltinGrant('test')` token and exposes the same
  // `window.app.*` surface tests expect (api.publish/subscribe,
  // api.datastore, api.window, api.invoke, api.features, etc.).
  //
  // Use 30s timeout to handle slow launches after previous test cleanup.
  const bgWindow = await waitForWindowHelper(() => electronApp.windows(), 'peek://test/', 30000);
  await waitForAppReady(bgWindow, 15000);

  // Wait for features to be ready via the unified registry.
  // Gates on v2 tile readiness via api.features.list — no host window dependency.
  const waitForFeaturesReady = async (timeout: number): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const ready = await bgWindow.evaluate(async () => {
          const api = (window as any).app;
          if (!api || !api.features) return false;
          // Builtins are filtered out of the default list; explicitly request them.
          const result = await api.features.list('builtin');
          const entries = result?.entries;
          if (!Array.isArray(entries)) return false;
          // Feature system is up once the registry has discovered a few
          // builtins. (cmd is a core renderer in app/cmd/, not a feature
          // tile, so it never appears in this list.)
          return entries.length >= 3;
        });
        if (ready) {
          return;
        }
      } catch {
        // API not ready yet
      }

      await sleep(100);
    }

    // Timeout reached - throw error with diagnostic info
    const windows = electronApp.windows();
    const urls = windows.map(w => w.url());
    throw new Error(`Features failed to load within ${timeout}ms. Windows: ${JSON.stringify(urls)}`);
  };
  await waitForFeaturesReady(15000);

  const state: ElectronState = { app: electronApp, tempDir, profile };

  return {
    backend: 'electron',

    windows: () => electronApp.windows(),

    getWindow: async (pattern, timeout = 10000) => {
      return waitForWindowHelper(() => electronApp.windows(), pattern, timeout);
    },

    getBackgroundWindow: async () => {
      // Privileged test fixture renderer (single v2 path).
      // Backed by app/_test/index.html, launched by test-fixture-glue.ts
      // when E2E_TEST=true. Uses tile-preload + trustedBuiltin grant.
      return waitForWindowHelper(() => electronApp.windows(), 'peek://test/');
    },

    evaluateMain: async (fn: any, arg?: any) => {
      // `electronApp.evaluate` runs the function in the Electron main
      // process via Playwright's CDP-shaped channel. The channel is
      // attached to a "helper" main-process context that Playwright
      // tracks alongside every BrowserWindow. When ANY BrowserWindow is
      // mid-attach (just created, CDP session still wiring up) or
      // mid-detach (closing, context being torn down), the helper
      // context can rotate underneath an in-flight evaluate, throwing
      // "Execution context was destroyed, most likely because of a
      // navigation". This is the dominant flake-shaped failure across
      // the desktop suite — same fingerprint in slides, reopen-closed,
      // page-layout, page-redirect, permission-prompt, transient-on-blur.
      //
      // The retry is bounded and specific: catches ONLY the named
      // navigation transient (provably resolved once the new/closing
      // window's CDP session settles) and lets every other error
      // propagate immediately. NOT a generic "retry until passes" — the
      // rotation IS a one-shot event with bounded duration.
      //
      // Budget, not a fixed count: the settle time scales with machine
      // load. A fixed 3×~100ms budget under-provisioned under full-suite
      // load (4 parallel workers + many windows attaching/detaching),
      // exhausting the retries while the helper context was still rotating
      // — the slides.spec.ts:150/160 flake (peek f8985201) and its
      // siblings. Retry the named transient on a bounded time budget with
      // capped exponential backoff instead, so a busier machine just waits
      // a little longer. A real crash surfaces as a DIFFERENT message
      // ("Target page/context/browser has been closed"), so it is not
      // caught here and fails fast; only the rotation transient is retried,
      // and only until the deadline.
      const NAVIGATION_RACE = 'Execution context was destroyed';
      const DEADLINE_MS = 5000;
      const startedAt = Date.now();
      let delay = 50;
      for (;;) {
        try {
          return await electronApp.evaluate(fn as any, arg);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes(NAVIGATION_RACE) || Date.now() - startedAt >= DEADLINE_MS) throw err;
          await new Promise(r => setTimeout(r, delay));
          delay = Math.min(delay * 2, 500);
        }
      }
    },

    getExtensionWindows: () => {
      return electronApp.windows().filter(w =>
        w.url().startsWith('peek://') && !w.url().startsWith('peek://app/') && w.url().includes('background.html')
      );
    },

    close: async () => {
      // Capture PID before any close attempts
      let pid: number | undefined;
      try {
        pid = electronApp.process().pid;
      } catch { /* process may already be gone */ }

      // Helper to check if process is still running
      const isRunning = (p: number): boolean => {
        try {
          process.kill(p, 0); // Signal 0 just checks if process exists
          return true;
        } catch {
          return false;
        }
      };

      // Helper to wait for process exit with polling
      const waitForExit = async (p: number, timeoutMs: number): Promise<boolean> => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (!isRunning(p)) return true;
          await sleep(100);
        }
        return !isRunning(p);
      };

      // Step 1: Call app.quit() in the main Electron process via evaluate.
      // The app's before-quit handler ensures cleanup (hot reload watchers,
      // database, extensions). We also set a safety timeout that calls
      // process.exit(0) in case the quit sequence stalls (e.g., a window
      // close handler blocks indefinitely).
      try {
        await Promise.race([
          electronApp.evaluate(({ app }) => {
            // Safety net: if quit stalls, force-exit after 5 seconds.
            // This handles edge cases where window close handlers prevent
            // the normal quit sequence from completing.
            setTimeout(() => {
              console.error('[lifecycle] quit safety timeout - forcing process.exit(0)');
              process.exit(0);
            }, 5000).unref();
            app.quit();
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate timeout')), 3000))
        ]);
      } catch {
        // evaluate may fail/timeout if app is already closing - this is expected
      }

      // Wait for process to exit after app.quit() was called.
      // The before-quit handler ensures cleanup, and the safety timeout
      // guarantees exit within 5 seconds even if quit stalls.
      if (pid && await waitForExit(pid, 8000)) {
        await sleep(200); // Let OS release resources
        return;
      }

      // Step 2: Try Playwright's electronApp.close() as backup
      try {
        await Promise.race([
          electronApp.close(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('close timeout')), 5000))
        ]);
        if (!pid || await waitForExit(pid, 2000)) {
          await sleep(200);
          return;
        }
      } catch { /* continue */ }

      // Step 3: Force exit via app.exit(0) - bypasses all close handlers
      try {
        await Promise.race([
          electronApp.evaluate(({ app }) => {
            app.exit(0);
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('exit timeout')), 2000))
        ]);
        if (pid && await waitForExit(pid, 3000)) {
          await sleep(200);
          return;
        }
      } catch { /* fall through to SIGTERM */ }

      if (!pid) return;

      // Step 4: SIGTERM/SIGKILL - this should NEVER happen in normal operation.
      // If we reach here, the app is stuck. Force-kill and throw an error so the
      // test is marked as failed (unless we're explicitly testing crash recovery).
      let forceKilled = false;

      if (isRunning(pid)) {
        console.error(`[test] FAILURE: Graceful shutdown failed for PID ${pid}, sending SIGTERM`);
        forceKilled = true;
        try {
          process.kill(pid, 'SIGTERM');
        } catch { /* ignore */ }
        if (await waitForExit(pid, 3000)) {
          // SIGTERM worked but graceful didn't - still a failure
          await sleep(200);
          throw new Error(
            `Electron app (PID ${pid}) did not shut down gracefully and required SIGTERM. ` +
            `This indicates a shutdown hang - investigate app lifecycle.`
          );
        }
      }

      if (isRunning(pid)) {
        console.error(`[test] FAILURE: SIGTERM failed for PID ${pid}, sending SIGKILL`);
        try {
          process.kill(pid, 'SIGKILL');
        } catch { /* ignore */ }
        await sleep(500);
      }

      // Allow extra time for OS to fully release resources (ports, files, etc.)
      await sleep(500);

      if (forceKilled) {
        throw new Error(
          `Electron app (PID ${pid}) did not shut down gracefully and required force-kill. ` +
          `This indicates a shutdown hang - investigate app lifecycle.`
        );
      }
    }
  };
}

/**
 * Tauri Frontend Mock
 *
 * Tests the frontend in isolation using a mocked backend.
 * Serves the app/ directory via HTTP and injects a mock window.app API.
 *
 * This allows reusing the same Playwright tests for both backends,
 * though only the frontend behavior is tested (backend is mocked).
 */

// Track HTTP server and browser for cleanup
let httpServer: http.Server | null = null;
let tauriBrowser: Browser | null = null;

const MOCK_PORT = 5199;

/**
 * Simple HTTP server to serve app/ and extensions/ directories
 */
function startHttpServer(): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = req.url || '/';
      let filePath: string;

      // Route based on URL prefix
      if (url.startsWith('/ext/')) {
        // Serve from extensions directory
        filePath = path.join(ROOT, 'features', url.replace('/ext/', ''));
      } else {
        // Serve from app directory
        filePath = path.join(ROOT, 'renderer', url);
      }

      // Default to index.html for directories
      if (filePath.endsWith('/')) {
        filePath += 'index.html';
      }

      // Handle .html extension
      if (!path.extname(filePath) && !filePath.endsWith('.html')) {
        // Try adding .html
        if (fs.existsSync(filePath + '.html')) {
          filePath += '.html';
        }
      }

      // Read and serve the file
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found: ' + filePath);
          return;
        }

        // Set content type
        const ext = path.extname(filePath);
        const contentType = {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.svg': 'image/svg+xml'
        }[ext] || 'text/plain';

        res.writeHead(200, {
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*'
        });
        res.end(data);
      });
    });

    server.listen(MOCK_PORT, () => {
      console.log(`[tauri-mock] HTTP server running on port ${MOCK_PORT}`);
      resolve(server);
    });

    server.on('error', reject);
  });
}

/**
 * Launch Tauri Frontend Mock
 */
async function launchTauriFrontend(profile: string): Promise<DesktopApp> {
  const headless = isHeadless();

  // Start HTTP server if not already running
  if (!httpServer) {
    httpServer = await startHttpServer();
  }

  // Launch browser
  tauriBrowser = await chromium.launch({
    headless,
    args: ['--disable-web-security'] // Allow cross-origin for local files
  });

  const context = await tauriBrowser.newContext();

  // Load mock backend script
  const mockScriptPath = path.join(__dirname, '../mocks/tauri-backend.js');
  const mockScript = fs.readFileSync(mockScriptPath, 'utf-8');

  // Track all pages (windows)
  const pages: Page[] = [];

  // Inject mock backend into all new pages
  await context.addInitScript(mockScript);

  // Create main background page
  const bgPage = await context.newPage();
  pages.push(bgPage);

  // Override window.app.window.open to actually open new pages
  await bgPage.exposeFunction('__mockWindowOpen', async (url: string, options: any) => {
    // Convert peek:// URLs to localhost
    let targetUrl = url;
    if (url.startsWith('peek://app/')) {
      targetUrl = `http://localhost:${MOCK_PORT}/${url.replace('peek://app/', '')}`;
    } else if (url.startsWith('peek://') && !url.startsWith('peek://app/')) {
      // peek://<id>/... (v2 canonical) — map to mock server
      const withoutScheme = url.replace('peek://', '');
      targetUrl = `http://localhost:${MOCK_PORT}/ext/${withoutScheme}`;
    } else if (url.startsWith('http://') || url.startsWith('https://')) {
      // External URLs - open as-is
      targetUrl = url;
    } else if (url.startsWith('about:')) {
      targetUrl = url;
    } else {
      // Relative URL - serve from app
      targetUrl = `http://localhost:${MOCK_PORT}/${url}`;
    }

    console.log(`[tauri-mock] Opening window: ${url} -> ${targetUrl}`);
    const newPage = await context.newPage();
    pages.push(newPage);
    await newPage.goto(targetUrl).catch((e) => {
      console.log(`[tauri-mock] Navigation failed: ${e.message}`);
    });
    return { success: true, id: pages.length - 1 };
  });

  // Navigate to background page and wait for API
  await bgPage.goto(`http://localhost:${MOCK_PORT}/background.html`);
  await waitForAppReady(bgPage, 10000);

  // Simulate extension windows by creating pages for each builtin extension
  const extensions = ['groups', 'peeks', 'slides'];
  for (const ext of extensions) {
    const extPage = await context.newPage();
    pages.push(extPage);
    const extUrl = `http://localhost:${MOCK_PORT}/ext/${ext}/background.html`;
    await extPage.goto(extUrl).catch(() => {
      console.log(`[tauri-mock] Failed to load extension: ${ext}`);
    });
  }

  return {
    backend: 'tauri',

    windows: () => pages.filter(p => !p.isClosed()),

    getWindow: async (pattern, timeout = 10000) => {
      // For Tauri mock, also check for localhost URLs
      const patternStr = typeof pattern === 'string' ? pattern : pattern.source;
      return waitForWindowHelper(() => pages.filter(p => !p.isClosed()), pattern, timeout);
    },

    getBackgroundWindow: async () => {
      return bgPage;
    },

    getExtensionWindows: () => {
      return pages.filter(p => {
        if (p.isClosed()) return false;
        const url = p.url();
        return url.includes('/ext/') && url.includes('background.html');
      });
    },

    close: async () => {
      // Close all pages
      for (const page of pages) {
        if (!page.isClosed()) {
          await page.close().catch(() => {});
        }
      }
      // Close browser
      if (tauriBrowser) {
        await tauriBrowser.close();
        tauriBrowser = null;
      }
      // Stop HTTP server
      if (httpServer) {
        httpServer.close();
        httpServer = null;
      }
    }
  };
}

/**
 * Launch desktop app based on BACKEND environment variable
 */
export async function launchDesktopApp(profile?: string, options: LaunchOptions = {}): Promise<DesktopApp> {
  const backend = (process.env.BACKEND || 'electron') as Backend;
  const testProfile = profile || getTestProfile();

  // Any other launch closes the worker's shared app first. Two Peek instances
  // on one display contend for OS-wide resources: a global hotkey is a single
  // grab (the second app's registration fails), and either app's windows can
  // take OS focus from the other's. The next getSharedApp() relaunches it.
  if (testProfile !== SHARED_APP_PROFILE) await closeSharedApp();

  if (backend === 'electron') {
    return launchElectron(testProfile, options);
  } else if (backend === 'tauri') {
    return launchTauriFrontend(testProfile);
  } else {
    throw new Error(`Unknown backend: ${backend}. Use BACKEND=electron or BACKEND=tauri`);
  }
}

// ==================== Shared Instance ====================

/**
 * Global shared app instance for tests that don't need isolation.
 * Use getSharedApp() to get or create, closeSharedApp() to cleanup.
 */
const SHARED_APP_PROFILE = 'test-shared-instance';
let sharedApp: DesktopApp | null = null;
let sharedAppPromise: Promise<DesktopApp> | null = null;

/**
 * Get or create a shared app instance.
 * Most tests can use this instead of launching their own instance.
 * Only use launchDesktopApp() for tests that need:
 * - Fresh database state
 * - App restart/lifecycle testing
 * - Specific profile configuration
 */
export async function getSharedApp(): Promise<DesktopApp> {
  if (sharedApp) {
    return sharedApp;
  }

  // Prevent multiple concurrent launches
  if (sharedAppPromise) {
    return sharedAppPromise;
  }

  // Settled before any spec gets it: boot's startup window takes focus about
  // half a second in, and a window opened before then loses focus to it.
  sharedAppPromise = launchDesktopApp(SHARED_APP_PROFILE).then(async (app) => {
    if (app.evaluateMain) await waitForStartupWindowOpened(app);
    return app;
  });
  sharedApp = await sharedAppPromise;
  sharedAppPromise = null;
  return sharedApp;
}

/**
 * Close the shared app instance.
 * Call this in a global teardown or at the end of test file.
 */
export async function closeSharedApp(): Promise<void> {
  if (sharedApp) {
    await sharedApp.close();
    sharedApp = null;
  }
}

/**
 * Playwright test fixture that provides a desktop app instance
 *
 * The app is launched before each test and closed after.
 */
export const test = base.extend<{ desktopApp: DesktopApp; sharedAppQuiesce: void }>({
  desktopApp: async ({}, use, testInfo) => {
    // Manual harness specs (project=manual, e.g. tests/manual/*.harness.ts)
    // use a stable `test-harness-<spec>` profile so cookies, localStorage,
    // and 2FA-trusted-device state persist across runs — otherwise the user
    // re-logs every invocation. Regular Playwright tests get a fresh
    // Date.now()-suffixed profile per run for isolation.
    const isHarness = testInfo.project.name === 'manual';
    const profile = isHarness
      ? `test-harness-${path.basename(testInfo.file).replace(/\.harness\.ts$/, '').replace(/\s+/g, '-').toLowerCase()}`
      : `test-${testInfo.title.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}`;
    const app = await launchDesktopApp(profile);
    await use(app);
    await app.close();
  },

  // Auto-fixture: between every test, wait for the shared app's window set
  // to stop changing. Per-spec closeWindow() helpers return as soon as the
  // close IPC is acked, but BrowserWindow destruction (and the playwright
  // CDP helper context that piggybacks on it) takes longer to settle. If
  // the next test starts mid-teardown, its first evaluateMain call hits
  // "Execution context was destroyed" and the existing bounded retry
  // (500ms) sometimes isn't enough. Quiescing here removes the race at
  // its source instead of bandaging the symptom with bigger retry budgets.
  sharedAppQuiesce: [async ({}, use) => {
    await use();
    if (sharedApp) {
      await waitForSharedAppWindowsStable(sharedApp);
    }
  }, { auto: true }],
});

/**
 * Poll the shared Electron app's BrowserWindow count until it has been
 * stable (unchanged) for `stableForMs`, or `maxWaitMs` elapses. Tolerates
 * the navigation race that can occur mid-poll — if the helper context dies
 * during evaluate, treat that as a non-stable sample and keep polling.
 */
async function waitForSharedAppWindowsStable(
  app: DesktopApp,
  { maxWaitMs = 1500, stableForMs = 50, pollMs = 20 }: {
    maxWaitMs?: number; stableForMs?: number; pollMs?: number;
  } = {},
): Promise<void> {
  if (!app.evaluateMain) return;
  const deadline = Date.now() + maxWaitMs;
  let lastCount = -1;
  let stableSince = -1;
  while (Date.now() < deadline) {
    let count: number;
    try {
      count = await app.evaluateMain<number>(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    } catch {
      // navigation race during poll itself — reset stability tracking
      lastCount = -1;
      stableSince = -1;
      await new Promise(r => setTimeout(r, pollMs));
      continue;
    }
    if (count === lastCount) {
      if (stableSince < 0) stableSince = Date.now();
      if (Date.now() - stableSince >= stableForMs) return;
    } else {
      lastCount = count;
      stableSince = -1;
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  // Timed out waiting for quiescence — downstream evaluateMain retries
  // still backstop the case where the app genuinely won't settle.
}

export { expect } from '@playwright/test';
