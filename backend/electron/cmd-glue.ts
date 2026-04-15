/**
 * Electron-specific plumbing for the cmd (command palette) subsystem.
 *
 * cmd is NOT a feature — it's core app infrastructure. The cross-platform
 * cmd code (UI, state machine, noun system, command registry) lives in
 * ./app/cmd/. This file contains the Electron-specific glue:
 *
 *   - Loads the cmd background iframe into the extension host (the iframe
 *     owns the cross-platform command registry via window.app.subscribe).
 *   - Waits for the iframe to load so other features can register commands
 *     against a ready registry.
 *
 * Global shortcut registration (Cmd+K, Option+Space, Cmd+L) happens inside
 * the cmd background script via the portable `api.shortcuts.register()`
 * surface — no Electron-specific shortcut code lives here.
 *
 * The cmd panel window itself is created on-demand from the background
 * script via `api.window.open('peek://ext/cmd/panel.html', ...)`; that
 * path already resolves to app/cmd/panel.html via protocol.ts.
 *
 * An eventual Tauri port would add backend/tauri/src-tauri/src/cmd_glue.rs
 * that performs the equivalent load (via WebView creation) and shortcut
 * plumbing through Tauri's globalShortcut manager.
 */

import type { BrowserWindow } from 'electron';
import { DEBUG } from './config.js';

/**
 * Options for initializing cmd.
 */
export interface InitCmdOptions {
  /** The consolidated extension host BrowserWindow. */
  host: BrowserWindow;
  /** Loads an iframe into the extension host with the given id/url. */
  loadExtInHost: (host: BrowserWindow, id: string, url: string) => void;
  /** Resolves once the iframe at peek://cmd/background.html has finished loading. */
  waitForExtLoaded: (id: string, timeoutMs: number) => Promise<void>;
}

/**
 * The pseudo-extension id used to key the cmd iframe inside the host window's
 * frame-tracking data structures. Must match the host / iframe URL origin.
 */
export const CMD_ID = 'cmd';

/** The URL of the cmd background iframe (served from app/cmd/ via protocol.ts). */
export const CMD_BACKGROUND_URL = 'peek://cmd/background.html';

/**
 * Initialize the cmd palette infrastructure.
 *
 * Loads the command registry as an iframe in the consolidated extension host
 * and waits for it to be ready. Must be called BEFORE any feature tries to
 * register commands (otherwise the pubsub registrations are lost).
 *
 * This is a thin wrapper over the existing host's iframe-loading mechanism;
 * the iframe uses the standard preload/IPC bridge, so cmd has full access to
 * the `api.*` surface (pubsub, shortcuts, window, settings, datastore).
 */
export async function initCmd(opts: InitCmdOptions): Promise<void> {
  DEBUG && console.log('[cmd-glue] Loading cmd background iframe');

  opts.loadExtInHost(opts.host, CMD_ID, CMD_BACKGROUND_URL);

  // Wait for the iframe to load via did-frame-finish-load tracking.
  await opts.waitForExtLoaded(CMD_ID, 5000);

  // Small additional delay to ensure cmd's pubsub subscribers are registered.
  // Without this, early cmd:register calls from other extensions can be dropped
  // because did-frame-finish-load fires before the module's top-level code runs.
  await new Promise(resolve => setTimeout(resolve, 100));

  DEBUG && console.log('[cmd-glue] cmd ready');
}
