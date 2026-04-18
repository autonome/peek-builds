/**
 * Electron-specific plumbing for the page subsystem.
 *
 * Page is NOT a feature — it's core app infrastructure. The cross-platform
 * page code (canvas UI in `app/page/index.html` + `page.js`, command
 * registration in `app/page/background.html`) lives in `app/page/`. This
 * file contains the Electron-specific glue:
 *
 *   - Creates the hidden resident page BrowserWindow with `tile-preload.cjs`
 *     and a `trustedBuiltin` capability grant. The resident renderer is
 *     `peek://page/background.html`; it registers the `open` and `modal`
 *     commands via the portable `api.commands.register()` surface.
 *
 * The canvas page architecture (fullscreen transparent BrowserWindow at
 * 0,0, peek://app/page/index.html?url=..., JS-positioned webview) is
 * implemented in `backend/electron/ipc.ts` and `app/page/page.js` — those
 * are NOT touched here. The canvas architecture is FROZEN (see
 * DEVELOPMENT.md).
 *
 * An eventual Tauri port would add backend/tauri/src-tauri/src/page_glue.rs
 * that performs the equivalent background-script load through Tauri's
 * WebView.
 */

import { BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import { DEBUG } from './config.js';
import { createTrustedBuiltinGrant } from './tile-manifest.js';
import { generateToken } from './tile-tokens.js';
import { registerTrustedBuiltinWindow } from './tile-launcher.js';

const requireElectron = createRequire(import.meta.url);

/**
 * The tile id used to key the page resident renderer in the token store
 * and source-address namespace. Must match the `peek://page/...` origin
 * the protocol handler recognises.
 */
export const PAGE_ID = 'page';

/**
 * Entry id for the resident page renderer. Matches the shape used by
 * other tiles (tileId:entryId keying), even though page has only one
 * entry.
 */
export const PAGE_ENTRY_ID = 'resident';

/**
 * URL of the page resident renderer (served from app/page/ via
 * protocol.ts). The resident renderer is single-file: the inline module
 * script is the former `background.js` content.
 */
export const PAGE_RESIDENT_URL = 'peek://page/background.html';

let pageResidentWindow: BrowserWindow | null = null;

/**
 * Options for initializing page.
 */
export interface InitPageOptions {
  /** Absolute path to `dist/backend/electron/tile-preload.cjs`. */
  tilePreloadPath: string;
}

/**
 * Launch the page resident renderer as a hidden BrowserWindow that uses
 * `tile-preload.cjs` with a trustedBuiltin capability grant.
 *
 * The resident renderer registers the `open` and `modal` commands via
 * the portable `api.commands.register` surface. Capability enforcement
 * is bypassed at every `tile:*` IPC because the token's grant carries
 * `trustedBuiltin: true`.
 *
 * The renderer window is created hidden and never shown — page has no
 * UI of its own. The per-URL canvas windows are created independently
 * via `api.window.open(...)` from the cmd-issued `open`/`modal` commands.
 */
export async function initPage(opts: InitPageOptions): Promise<void> {
  DEBUG && console.log('[page-glue] Launching page resident renderer');

  const electron = requireElectron('electron') as typeof import('electron');
  const BrowserWindowCtor = electron.BrowserWindow;

  // Mint a token backed by a trustedBuiltin grant — every tile:* IPC the
  // resident renderer invokes will bypass capability enforcement.
  const grant = createTrustedBuiltinGrant(PAGE_ID);
  const token = generateToken(PAGE_ID, PAGE_ENTRY_ID, grant);

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
        `--tile-id=${PAGE_ID}`,
        `--tile-entry=${PAGE_ENTRY_ID}`,
        `--tile-token=${token}`,
      ],
    },
  });

  pageResidentWindow = win;

  // Register with the tile launcher so the main-process extensionBroadcaster
  // forwards pubsub messages to this window (same path as feature tiles).
  // The registration also wires the close/revoke cleanup.
  registerTrustedBuiltinWindow(PAGE_ID, PAGE_ENTRY_ID, win, token);

  win.webContents.on('console-message', (event) => {
    try {
      const level = parseInt(String((event as { level?: unknown }).level), 10);
      const message = String((event as { message?: unknown }).message ?? '');
      const levelLabels = ['verbose', 'info', 'warning', 'error'];
      const levelLabel = levelLabels[level] || 'info';
      if (level >= 2) {
        console.error(`[page:resident] [${levelLabel}] ${message}`);
      } else if (DEBUG) {
        console.log(`[page:resident] [${levelLabel}] ${message}`);
      }
    } catch {
      /* logging must never throw */
    }
  });

  win.on('closed', () => {
    pageResidentWindow = null;
  });

  win.loadURL(PAGE_RESIDENT_URL);

  DEBUG && console.log('[page-glue] page resident renderer loaded');
}

/**
 * Accessor for the resident page renderer window. Returns null if page
 * has not yet been initialized or the window was closed.
 */
export function getPageResidentWindow(): BrowserWindow | null {
  return pageResidentWindow;
}
