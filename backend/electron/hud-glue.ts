/**
 * Electron-specific plumbing for the HUD (always-on-top heads-up display).
 *
 * HUD is NOT a feature — it's core app infrastructure. The cross-platform
 * HUD code (window UI, widgets, background script) lives in ./app/hud/.
 * This file contains the Electron-specific glue:
 *
 *   - Loads the HUD background iframe into the extension host so its
 *     command handler and window-lifecycle code run with access to the
 *     `api.*` surface.
 *   - Registers macOS app-focus handlers that hide/show alwaysOnTop
 *     overlays (e.g. the HUD window) when the user Cmd+Tabs away from
 *     and back to Peek. This direct main-process hide/show avoids the
 *     pubsub round-trip through the renderer.
 *
 * The HUD shortcut (CommandOrControl+H) and the `hud` command are
 * registered imperatively inside the HUD background script via the
 * portable `api.shortcuts.register()` and `api.commands.register()`
 * surfaces — no Electron-specific shortcut code lives here.
 *
 * The HUD window itself is created on-demand from the background script
 * via `api.window.open('peek://ext/hud/hud.html', ...)`; that path
 * already resolves to app/hud/hud.html via protocol.ts.
 *
 * An eventual Tauri port would add backend/tauri/src-tauri/src/hud_glue.rs
 * that performs the equivalent load and focus-handling through Tauri's
 * window manager.
 */

import { app, BrowserWindow } from 'electron';
import type { BrowserWindow as ElectronBrowserWindow } from 'electron';
import { DEBUG } from './config.js';

/**
 * Options for initializing HUD.
 */
export interface InitHudOptions {
  /** The consolidated extension host BrowserWindow. */
  host: ElectronBrowserWindow;
  /** Loads an iframe into the extension host with the given id/url. */
  loadExtInHost: (host: ElectronBrowserWindow, id: string, url: string) => void;
  /** Resolves once the iframe at peek://hud/background.html has finished loading. */
  waitForExtLoaded: (id: string, timeoutMs: number) => Promise<void>;
}

/**
 * The pseudo-extension id used to key the HUD iframe inside the host window's
 * frame-tracking data structures. Must match the host / iframe URL origin.
 */
export const HUD_ID = 'hud';

/** The URL of the HUD background iframe (served from app/hud/ via protocol.ts). */
export const HUD_BACKGROUND_URL = 'peek://hud/background.html';

let focusHandlersRegistered = false;

/**
 * Register macOS app-focus handlers that hide/show non-focusable alwaysOnTop
 * overlay windows (HUD) when Peek gains/loses OS focus.
 *
 * These previously lived inline in main.ts's app-event wiring; they've been
 * moved here to keep HUD-specific main-process code with the HUD glue.
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
 * Initialize the HUD infrastructure.
 *
 * Loads the HUD background iframe in the consolidated extension host and
 * registers the macOS focus handlers. Called at the same phase as initCmd
 * during application startup.
 *
 * This is a thin wrapper over the existing host's iframe-loading mechanism;
 * the iframe uses the standard preload/IPC bridge, so HUD has full access
 * to the `api.*` surface (pubsub, shortcuts, window, settings, commands).
 */
export async function initHud(opts: InitHudOptions): Promise<void> {
  DEBUG && console.log('[hud-glue] Loading HUD background iframe');

  registerFocusHandlers();

  opts.loadExtInHost(opts.host, HUD_ID, HUD_BACKGROUND_URL);

  // Wait for the iframe to load via did-frame-finish-load tracking.
  await opts.waitForExtLoaded(HUD_ID, 5000);

  DEBUG && console.log('[hud-glue] HUD ready');
}
