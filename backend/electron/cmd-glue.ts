/**
 * Electron-specific plumbing for the cmd (command palette) subsystem.
 *
 * cmd is NOT a feature — it's core app infrastructure. The cross-platform
 * cmd code (UI, state machine, noun system, command registry) lives in
 * `app/cmd/`. This file contains the Electron-specific glue:
 *
 *   - Creates the hidden resident cmd BrowserWindow with `tile-preload.cjs`
 *     and a `trustedBuiltin` capability grant. The resident renderer is
 *     `peek://cmd/index.html`; it owns the command registry and subscribes
 *     to `cmd:register`, `cmd:register-batch`, `noun:register-batch`, etc.
 *   - Waits for the resident renderer's `ext:ready` publish so other
 *     features can safely register commands against a subscribed registry.
 *
 * Global shortcut registration (Cmd+K, Option+Space, Cmd+L) happens inside
 * the cmd resident renderer via the portable `api.shortcuts.register()`
 * surface — no Electron-specific shortcut code lives here.
 *
 * The cmd panel window itself (the visible palette UI) is created
 * on-demand from the resident renderer via
 * `api.window.open('peek://cmd/panel.html', ...)`. That path resolves
 * to `app/cmd/panel.html` via protocol.ts.
 *
 * An eventual Tauri port would add backend/tauri/src-tauri/src/cmd_glue.rs
 * that performs the equivalent window creation + shortcut plumbing through
 * Tauri's globalShortcut manager.
 */

import { BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import { DEBUG } from './config.js';
import { createTrustedBuiltinGrant } from './tile-manifest.js';
import { generateToken } from './tile-tokens.js';
import { registerTrustedBuiltinWindow } from './tile-launcher.js';
import { subscribe, unsubscribe, scopes } from './pubsub.js';

const requireElectron = createRequire(import.meta.url);

/**
 * The tile id used to key the cmd resident renderer in the token store
 * and source-address namespace. Must match the `peek://cmd/...` origin
 * the protocol handler recognises.
 */
export const CMD_ID = 'cmd';

/**
 * Entry id for the resident cmd renderer. Matches the shape used by
 * other tiles (tileId:entryId keying), even though cmd has only one
 * entry.
 */
export const CMD_ENTRY_ID = 'resident';

/** URL of the cmd resident renderer (served from app/cmd/ via protocol.ts). */
export const CMD_RESIDENT_URL = 'peek://cmd/index.html';

let cmdResidentWindow: BrowserWindow | null = null;

/**
 * Options for initializing cmd.
 */
export interface InitCmdOptions {
  /** Absolute path to `dist/backend/electron/tile-preload.cjs`. */
  tilePreloadPath: string;
}

/**
 * Launch the cmd resident renderer as a hidden BrowserWindow that uses
 * `tile-preload.cjs` with a trustedBuiltin capability grant.
 *
 * The resident renderer owns the command registry (PROVIDER pattern —
 * subscribes to `cmd:register`, `cmd:register-batch`, `noun:register-batch`,
 * etc.) and registers the global/local shortcuts that open the cmd panel.
 * Capability enforcement is bypassed at every `tile:*` IPC because the
 * token's grant carries `trustedBuiltin: true`.
 *
 * Blocks on the renderer publishing `ext:ready` — this is critical because
 * any feature that publishes `cmd:register-batch` before cmd's subscribers
 * are in place would have its registrations dropped silently.
 */
export async function initCmd(opts: InitCmdOptions): Promise<void> {
  DEBUG && console.log('[cmd-glue] Launching cmd resident renderer');

  const electron = requireElectron('electron') as typeof import('electron');
  const BrowserWindowCtor = electron.BrowserWindow;

  // Mint a token backed by a trustedBuiltin grant — every tile:* IPC the
  // resident renderer invokes will bypass capability enforcement.
  const grant = createTrustedBuiltinGrant(CMD_ID);
  const token = generateToken(CMD_ID, CMD_ENTRY_ID, grant);

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
        `--tile-id=${CMD_ID}`,
        `--tile-entry=${CMD_ENTRY_ID}`,
        `--tile-token=${token}`,
      ],
    },
  });

  cmdResidentWindow = win;

  // Register with the tile launcher so the main-process extensionBroadcaster
  // forwards pubsub messages to this window (same path as feature tiles).
  // The registration also wires the close/revoke cleanup.
  registerTrustedBuiltinWindow(CMD_ID, CMD_ENTRY_ID, win, token);

  win.webContents.on('console-message', (event) => {
    try {
      const level = parseInt(String((event as { level?: unknown }).level), 10);
      const message = String((event as { message?: unknown }).message ?? '');
      const levelLabels = ['verbose', 'info', 'warning', 'error'];
      const levelLabel = levelLabels[level] || 'info';
      if (level >= 2) {
        console.error(`[cmd:resident] [${levelLabel}] ${message}`);
      } else if (DEBUG) {
        console.log(`[cmd:resident] [${levelLabel}] ${message}`);
      }
    } catch {
      /* logging must never throw */
    }
  });

  win.on('closed', () => {
    cmdResidentWindow = null;
  });

  // Block until cmd's `ext:ready` fires — critical because features that
  // publish cmd:register-batch before cmd's subscribers are in place would
  // have their registrations dropped silently.
  //
  // Use a unique source address so we don't clash with other system
  // subscribers on `ext:ready` (main.ts subscribes via `getSystemAddress()`
  // for the lazy-loading tracker). Unique source = independent subscription.
  const waitSource = `cmd-glue:ready-wait:${Date.now()}`;
  const waitForReady = new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      unsubscribe(waitSource, 'ext:ready');
      resolve();
    };
    subscribe(waitSource, scopes.SYSTEM, 'ext:ready', (data) => {
      const extId = (data as { id?: string })?.id;
      if (extId === CMD_ID) settle();
    });
    // Safety timeout — if ext:ready never arrives, fall through so startup
    // doesn't hang indefinitely. 5s matches the old waitForExtLoaded budget.
    setTimeout(() => {
      if (!settled) {
        console.warn('[cmd-glue] Timeout waiting for cmd ext:ready (5s); continuing');
      }
      settle();
    }, 5000);
  });

  win.loadURL(CMD_RESIDENT_URL);

  await waitForReady;

  // Small additional delay to ensure cmd's pubsub subscribers are fully
  // registered. Without this, early cmd:register calls from other
  // extensions can be dropped because ext:ready publish happens inside the
  // module top-level but before all `api.pubsub.subscribe(...)` calls
  // serialize through the main-process bookkeeping. Matches the legacy
  // iframe path's 100ms buffer.
  await new Promise(resolve => setTimeout(resolve, 100));

  DEBUG && console.log('[cmd-glue] cmd ready');
}

/**
 * Accessor for the resident cmd renderer window. Returns null if cmd has
 * not yet been initialized or the window was closed.
 */
export function getCmdResidentWindow(): BrowserWindow | null {
  return cmdResidentWindow;
}
