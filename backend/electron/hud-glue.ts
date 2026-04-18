/**
 * Electron-specific plumbing for the HUD (always-on-top heads-up display).
 *
 * HUD is NOT a feature — it's core app infrastructure. The cross-platform
 * HUD code (window UI, widgets, resident renderer) lives in `app/hud/`.
 * This file contains the Electron-specific glue:
 *
 *   - Creates the hidden resident HUD BrowserWindow with `tile-preload.cjs`
 *     and a `trustedBuiltin` capability grant. The resident renderer is
 *     `peek://hud/index.html`; it registers the `hud` command and the
 *     CmdOrCtrl+H shortcut via the standard `api.commands.register` /
 *     `api.shortcuts.register` surfaces.
 *   - Registers macOS app-focus handlers that hide/show alwaysOnTop
 *     overlays (e.g. the HUD window) when the user Cmd+Tabs away from
 *     and back to Peek. This direct main-process hide/show avoids the
 *     pubsub round-trip through the renderer.
 *
 * The HUD overlay window itself is created on-demand from the resident
 * renderer via `api.window.open('peek://ext/hud/hud.html', ...)`; that
 * path resolves to `app/hud/hud.html` via `protocol.ts`.
 *
 * An eventual Tauri port would add backend/tauri/src-tauri/src/hud_glue.rs
 * that performs the equivalent window creation + focus-handling through
 * Tauri's window manager.
 */

import { app, BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import { DEBUG } from './config.js';
import { createTrustedBuiltinGrant } from './tile-manifest.js';
import { generateToken } from './tile-tokens.js';

const requireElectron = createRequire(import.meta.url);

/**
 * The tile id used to key the HUD resident renderer in the token store
 * and source-address namespace. Must match the `peek://hud/...` origin
 * the protocol handler recognises.
 */
export const HUD_ID = 'hud';

/**
 * Entry id for the resident HUD renderer. Matches the shape used by
 * other tiles (tileId:entryId keying), even though HUD has only one
 * entry.
 */
export const HUD_ENTRY_ID = 'resident';

/** URL of the HUD resident renderer (served from app/hud/ via protocol.ts). */
export const HUD_RESIDENT_URL = 'peek://hud/index.html';

let focusHandlersRegistered = false;
let hudResidentWindow: BrowserWindow | null = null;

/**
 * Register macOS app-focus handlers that hide/show non-focusable alwaysOnTop
 * overlay windows (HUD) when Peek gains/loses OS focus.
 *
 * Idempotent — safe to call more than once.
 */
function registerFocusHandlers(): void {
  if (focusHandlersRegistered) return;
  if (process.platform !== 'darwin') return;
  focusHandlersRegistered = true;

  // macOS: when the app regains focus, show any alwaysOnTop overlay windows
  // that were hidden by the did-resign-active handler.
  app.on('did-become-active', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.isAlwaysOnTop() && (win as any).__hudHidden) {
        win.showInactive();
        (win as any).__hudHidden = false;
      }
    }
  });

  // macOS: when the app loses focus, hide non-focusable alwaysOnTop overlay
  // windows (e.g. HUD). Skip focusable alwaysOnTop windows (e.g. cmd panel)
  // — they have their own blur handler and would blink if hidden here.
  app.on('did-resign-active', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.isAlwaysOnTop() && win.isVisible() && !win.isFocusable()) {
        win.hide();
        (win as any).__hudHidden = true;
      }
    }
  });

  DEBUG && console.log('[hud-glue] Registered macOS did-become-active / did-resign-active handlers');
}

/**
 * Options for initializing HUD.
 */
export interface InitHudOptions {
  /** Absolute path to `dist/backend/electron/tile-preload.cjs`. */
  tilePreloadPath: string;
}

/**
 * Launch the HUD resident renderer as a hidden BrowserWindow that uses
 * `tile-preload.cjs` with a trustedBuiltin capability grant.
 *
 * The resident renderer registers the `hud` command + CmdOrCtrl+H
 * shortcut via the portable `api.commands.register` /
 * `api.shortcuts.register` surfaces. Capability enforcement is bypassed
 * at every `tile:*` IPC because the token's grant carries
 * `trustedBuiltin: true`.
 */
export async function initHud(opts: InitHudOptions): Promise<void> {
  DEBUG && console.log('[hud-glue] Launching HUD resident renderer');

  registerFocusHandlers();

  const electron = requireElectron('electron') as typeof import('electron');
  const BrowserWindowCtor = electron.BrowserWindow;

  // Mint a token backed by a trustedBuiltin grant — every tile:* IPC the
  // resident renderer invokes will bypass capability enforcement.
  const grant = createTrustedBuiltinGrant(HUD_ID);
  const token = generateToken(HUD_ID, HUD_ENTRY_ID, grant);

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
        `--tile-id=${HUD_ID}`,
        `--tile-entry=${HUD_ENTRY_ID}`,
        `--tile-token=${token}`,
      ],
    },
  });

  hudResidentWindow = win;

  win.webContents.on('console-message', (event) => {
    try {
      const level = parseInt(String((event as { level?: unknown }).level), 10);
      const message = String((event as { message?: unknown }).message ?? '');
      const levelLabels = ['verbose', 'info', 'warning', 'error'];
      const levelLabel = levelLabels[level] || 'info';
      if (level >= 2) {
        console.error(`[hud:resident] [${levelLabel}] ${message}`);
      } else if (DEBUG) {
        console.log(`[hud:resident] [${levelLabel}] ${message}`);
      }
    } catch {
      /* logging must never throw */
    }
  });

  win.on('closed', () => {
    hudResidentWindow = null;
  });

  win.loadURL(HUD_RESIDENT_URL);

  DEBUG && console.log('[hud-glue] HUD resident renderer loaded');
}

/**
 * Accessor for the resident HUD renderer window. Returns null if HUD has
 * not yet been initialized or the window was closed.
 */
export function getHudResidentWindow(): BrowserWindow | null {
  return hudResidentWindow;
}
