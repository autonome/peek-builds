/**
 * Electron-specific plumbing for the Playwright test fixture renderer.
 *
 * Launched ONLY when `E2E_TEST=true`; a no-op in normal application startup.
 *
 * The test renderer lives at `app/_test/index.html` and uses the same
 * tile mechanics as cmd/hud/page core renderers:
 *   - `tile-preload.cjs` as preload, reading `--tile-id`, `--tile-entry`,
 *     and `--tile-token` from `additionalArguments`.
 *   - A `createTrustedBuiltinGrant('test')` token so every `tile:*` IPC
 *     bypasses capability enforcement.
 *   - Registered via `registerTrustedBuiltinWindow()` so the pubsub
 *     broadcaster forwards messages to this window (tests rely on
 *     receiving publications via `api.subscribe`).
 *
 * After the window finishes loading, the renderer sets `window.__testReady`
 * to true. `initTestFixture()` blocks on that flag so test code never
 * observes a partially-constructed `window.app` surface.
 */

import { BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import { DEBUG } from './config.js';
import { createTrustedBuiltinGrant } from './tile-manifest.js';
import { generateToken } from './tile-tokens.js';
import { registerTrustedBuiltinWindow } from './tile-launcher.js';
import { ensureTileIpcHandlers } from './tile-compat.js';

const requireElectron = createRequire(import.meta.url);

/** Tile id for the test fixture renderer. Matches the `peek://test/...` host. */
export const TEST_FIXTURE_ID = 'test';

/** Entry id — single resident renderer, shape-consistent with cmd/hud/page. */
export const TEST_FIXTURE_ENTRY_ID = 'resident';

/** URL of the test fixture renderer (served from app/_test/ via protocol.ts). */
export const TEST_FIXTURE_URL = 'peek://test/index.html';

let testFixtureWindow: BrowserWindow | null = null;

/**
 * Options for initializing the test fixture renderer.
 */
export interface InitTestFixtureOptions {
  /** Absolute path to `dist/backend/electron/tile-preload.cjs`. */
  tilePreloadPath: string;
}

/**
 * Launch the privileged test fixture renderer as a hidden BrowserWindow.
 *
 * Must be called BEFORE feature loading so that the fixture is reachable
 * as soon as the test suite starts issuing `bgWindow.evaluate(...)` calls.
 *
 * Blocks on `window.__testReady` so callers can rely on the trustedBuiltin
 * token having been validated and the tile-preload capability surface
 * being in place.
 */
export async function initTestFixture(opts: InitTestFixtureOptions): Promise<void> {
  DEBUG && console.log('[test-fixture-glue] Launching test fixture renderer');

  // Belt-and-suspenders: main.ts::initialize() already calls this centrally,
  // but the helper is idempotent. Keeping it here documents the dependency
  // and lets the glue stand alone if ever reused from another entry point.
  ensureTileIpcHandlers();

  const electron = requireElectron('electron') as typeof import('electron');
  const BrowserWindowCtor = electron.BrowserWindow;

  // Mint a token backed by a trustedBuiltin grant — every tile:* IPC the
  // fixture renderer invokes will bypass capability enforcement. Tests
  // commonly poke main-process handlers directly via api.invoke, so the
  // bypass is essential for the fixture to be a full v1-equivalent.
  const grant = createTrustedBuiltinGrant(TEST_FIXTURE_ID);
  const token = generateToken(TEST_FIXTURE_ID, TEST_FIXTURE_ENTRY_ID, grant);

  const win = new BrowserWindowCtor({
    width: 1,
    height: 1,
    show: false,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: opts.tilePreloadPath,
      additionalArguments: [
        `--tile-id=${TEST_FIXTURE_ID}`,
        `--tile-entry=${TEST_FIXTURE_ENTRY_ID}`,
        `--tile-token=${token}`,
      ],
    },
  });

  testFixtureWindow = win;

  // Register with the tile launcher so the main-process pubsubBroadcaster
  // forwards pubsub messages to this window. Tests subscribe to topics
  // (e.g. `editor:open`) and assert on the data received — without this
  // registration, the broadcaster would skip the fixture and tests hang.
  registerTrustedBuiltinWindow(TEST_FIXTURE_ID, TEST_FIXTURE_ENTRY_ID, win, token);

  win.webContents.on('console-message', (event) => {
    try {
      // Electron 40: `level` is a string literal, not an integer.
      // See core-glue.ts / ipc.ts / tile-launcher.ts for the same fix.
      const asAny = event as unknown as { level?: unknown; message?: unknown };
      const level = String(asAny.level ?? '');
      const message = String(asAny.message ?? '');
      if (level === 'warning' || level === 'error') {
        console.error(`[test-fixture:resident] [${level}] ${message}`);
      } else if (DEBUG) {
        console.log(`[test-fixture:resident] [${level}] ${message}`);
      }
    } catch {
      /* logging must never throw */
    }
  });

  win.on('closed', () => {
    testFixtureWindow = null;
  });

  // Load the renderer and wait until its module script has finished
  // executing — signaled by `window.__testReady = true`. Using
  // `webContents.executeJavaScript` polling avoids a race with
  // `did-finish-load` (which fires before the module body runs).
  await win.loadURL(TEST_FIXTURE_URL);

  const waitForReady = async (timeoutMs: number): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const ready = await win.webContents.executeJavaScript(
          'window.__testReady === true'
        );
        if (ready) return;
      } catch {
        /* may error during navigation — retry */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `[test-fixture-glue] Test fixture renderer did not become ready within ${timeoutMs}ms`
    );
  };

  await waitForReady(10000);

  DEBUG && console.log('[test-fixture-glue] test fixture ready');
}

/**
 * Accessor for the test fixture window. Returns null when `E2E_TEST` was
 * unset (fixture not launched) or the window was closed.
 */
export function getTestFixtureWindow(): BrowserWindow | null {
  return testFixtureWindow;
}
