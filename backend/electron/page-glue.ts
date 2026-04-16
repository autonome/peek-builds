/**
 * Electron-specific plumbing for the page subsystem.
 *
 * Page is NOT a feature — it's core app infrastructure. The cross-platform
 * page code (canvas UI in app/page/index.html + page.js, command registration
 * background in app/page/background.js) lives in ./app/page/. This file
 * contains the Electron-specific glue:
 *
 *   - Loads the page background iframe into the consolidated extension host so
 *     the `open` and `modal` commands are registered with access to the
 *     `api.*` surface (pubsub, window, commands).
 *
 * The `open` and `modal` command implementations use `api.window.open()` and
 * `api.window.openModal()` — no Electron-specific code lives here.
 *
 * The canvas page architecture (fullscreen transparent BrowserWindow at 0,0,
 * peek://app/page/index.html?url=..., JS-positioned webview) is implemented in
 * backend/electron/ipc.ts and app/page/page.js — those are NOT touched here.
 * The canvas architecture is FROZEN (see DEVELOPMENT.md).
 *
 * An eventual Tauri port would add backend/tauri/src-tauri/src/page_glue.rs
 * that performs the equivalent background-script load through Tauri's WebView.
 */

import type { BrowserWindow } from 'electron';
import { DEBUG } from './config.js';

/**
 * Options for initializing page.
 */
export interface InitPageOptions {
  /** The consolidated extension host BrowserWindow. */
  host: BrowserWindow;
  /** Loads an iframe into the extension host with the given id/url. */
  loadExtInHost: (host: BrowserWindow, id: string, url: string) => void;
  /** Resolves once the iframe at peek://page/background.html has finished loading. */
  waitForExtLoaded: (id: string, timeoutMs: number) => Promise<void>;
}

/**
 * The pseudo-extension id used to key the page iframe inside the host window's
 * frame-tracking data structures.
 */
export const PAGE_ID = 'page';

/** The URL of the page background iframe (served from app/page/ via protocol.ts). */
export const PAGE_BACKGROUND_URL = 'peek://page/background.html';

/**
 * Initialize the page subsystem.
 *
 * Loads the page command background as an iframe in the consolidated extension
 * host. This registers the `open` and `modal` commands against the cmd registry.
 * Called at startup after initCmd/initHud.
 *
 * This is a thin wrapper over the existing host's iframe-loading mechanism;
 * the iframe uses the standard preload/IPC bridge, so page has full access to
 * the `api.*` surface (pubsub, shortcuts, window, settings, commands).
 */
export async function initPage(opts: InitPageOptions): Promise<void> {
  DEBUG && console.log('[page-glue] Loading page background iframe');

  opts.loadExtInHost(opts.host, PAGE_ID, PAGE_BACKGROUND_URL);

  // Wait for the iframe to load via did-frame-finish-load tracking.
  await opts.waitForExtLoaded(PAGE_ID, 5000);

  DEBUG && console.log('[page-glue] page ready');
}
