/**
 * Electron-specific plumbing for the core background renderer.
 *
 * The core background renderer (loaded from `app/background.html` →
 * `app/index.js`) is NOT a feature — it's core app infrastructure that
 * owns:
 *   - Session startup: opening the configured startup feature window,
 *     handling session restore completion.
 *   - External URL handling: subscribing to `external:open-url` to
 *     create windows for OS-delivered URLs (when Peek is default
 *     browser).
 *   - System-level commands: settings, extensions, themes, session
 *     save/restore, app quit/restart, etc.
 *   - Feature toggle side effects: enabling/disabling non-extension
 *     features via `core:feature:toggle` pubsub.
 *   - Settings shortcut registration (Cmd+,).
 *
 * Pre-Phase-2.5, this window was created by `createBackgroundWindow()`
 * with the v1 `preload.js` and node integration. This module replaces
 * that path with the same mechanics used by cmd/hud/page/test fixture:
 *
 *   - `tile-preload.cjs` as preload, reading `--tile-id=core`,
 *     `--tile-entry=background`, and `--tile-token=<...>` from
 *     `additionalArguments`.
 *   - A `createTrustedBuiltinGrant('core')` token so every `tile:*`
 *     IPC bypasses capability enforcement (the core renderer is
 *     trusted code; it must be able to touch every surface).
 *   - Registered via `registerTrustedBuiltinWindow()` so the pubsub
 *     broadcaster forwards messages to this window (same path as
 *     feature tiles).
 *
 * The URL loaded stays `peek://app/background.html` — the protocol
 * handler already resolves that to `rootDir/app/background.html`, and
 * `WEB_CORE_ADDRESS` in `backend/config.ts` is used elsewhere (e.g.
 * `closeOrHideWindow` refuses to close the core window by address
 * match, `countVisibleWindows` excludes it, session restore skips it).
 *
 * After the window finishes loading, the renderer sets
 * `window.__coreReady = true` (matches `__testReady` / similar
 * pattern). `initCore()` blocks on that flag so startup code that
 * depends on the renderer being initialized (e.g. the
 * `core:ready` subscriber that kicks off extension loading) can trust
 * the renderer's subscribers are in place.
 *
 * See docs/v1-removal-plan.md — Phase 2.5 #1.
 */

import { BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import { DEBUG, WEB_CORE_ADDRESS } from './config.js';
import { createTrustedBuiltinGrant } from './tile-manifest.js';
import { generateToken } from './tile-tokens.js';
import { registerTrustedBuiltinWindow } from './tile-launcher.js';
import { ensureTileIpcHandlers } from './tile-compat.js';
import { getSystemThemeBackgroundColor } from './windows.js';
import { getProfileSession } from './session-partition.js';

const requireElectron = createRequire(import.meta.url);

/** Tile id for the core background renderer. */
export const CORE_ID = 'core';

/** Entry id — single resident renderer. */
export const CORE_ENTRY_ID = 'background';

let coreBackgroundWindow: BrowserWindow | null = null;

/**
 * Options for initializing the core background renderer.
 */
export interface InitCoreOptions {
  /** Absolute path to `dist/backend/electron/tile-preload.cjs`. */
  tilePreloadPath: string;
}

/**
 * Launch the core background renderer as a hidden BrowserWindow that
 * uses `tile-preload.cjs` with a trustedBuiltin capability grant.
 *
 * Must be called BEFORE feature loading so that the background
 * renderer's subscribers (external URL, window:new-page-request,
 * session:open-startup, etc.) are in place before any publisher
 * fires.
 *
 * Blocks on `window.__coreReady = true` published by the renderer
 * after `api.initialize()` completes. Without this wait, early
 * pubsub calls from other startup code could arrive before the
 * renderer's subscribers are registered.
 */
export async function initCore(opts: InitCoreOptions): Promise<BrowserWindow> {
  DEBUG && console.log('[core-glue] Launching core background renderer');

  // Belt-and-suspenders: main.ts::initialize() already calls this
  // centrally, but the helper is idempotent. Documents the dependency.
  ensureTileIpcHandlers();

  const electron = requireElectron('electron') as typeof import('electron');
  const BrowserWindowCtor = electron.BrowserWindow;

  // Use profile-specific session for isolation (matches the v1
  // createBackgroundWindow behaviour — tests depend on separate DBs
  // across Playwright workers).
  const profileSession = getProfileSession();

  // Mint a token backed by a trustedBuiltin grant — every tile:* IPC
  // this renderer invokes bypasses capability enforcement.
  const grant = createTrustedBuiltinGrant(CORE_ID);
  const token = generateToken(CORE_ID, CORE_ENTRY_ID, grant);

  const winPrefs: Electron.BrowserWindowConstructorOptions = {
    show: false,
    backgroundColor: getSystemThemeBackgroundColor(),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: opts.tilePreloadPath,
      session: profileSession,
      additionalArguments: [
        `--tile-id=${CORE_ID}`,
        `--tile-entry=${CORE_ENTRY_ID}`,
        `--tile-token=${token}`,
      ],
    },
  };

  const win = new BrowserWindowCtor(winPrefs);
  coreBackgroundWindow = win;

  // Register with the tile launcher so the pubsub broadcaster forwards
  // messages to this window. Without this, `api.subscribe` calls inside
  // `app/index.js` would never fire.
  registerTrustedBuiltinWindow(CORE_ID, CORE_ENTRY_ID, win, token);

  win.webContents.on('console-message', (event) => {
    try {
      // Electron 40 changed console-message event shape: `level` is a string
      // literal ('info'|'warning'|'error'|...), not an integer. Forward
      // everything via console.error for visibility; renderers gate their
      // own verbosity.
      const asAny = event as unknown as { level?: unknown; message?: unknown };
      const message = String(asAny.message ?? '');
      console.error(`[core:background] level=${String(asAny.level)} ${message}`);
    } catch {
      /* logging must never throw */
    }
  });

  win.on('closed', () => {
    coreBackgroundWindow = null;
  });

  await win.loadURL(WEB_CORE_ADDRESS);

  // Block until the renderer's `api.initialize()` resolves and
  // `window.__coreReady = true` is set. Startup code that publishes
  // topics the renderer subscribes to (external URLs arriving during
  // app ready, CLI URLs, session-restore hooks) depends on this wait —
  // without it, the pubsub messages would be broadcast before the
  // renderer's subscribers are registered and silently dropped.
  const waitForReady = async (timeoutMs: number): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const ready = await win.webContents.executeJavaScript(
          'window.__coreReady === true'
        );
        if (ready) return;
      } catch {
        /* may error during navigation — retry */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `[core-glue] Core background renderer did not become ready within ${timeoutMs}ms`
    );
  };

  await waitForReady(10000);

  DEBUG && console.log('[core-glue] core background renderer ready');

  return win;
}

/**
 * Accessor for the core background window. Returns null if core has
 * not yet been initialized or the window was closed.
 */
export function getCoreBackgroundWindow(): BrowserWindow | null {
  return coreBackgroundWindow;
}
